"use strict";
/* Счётчик операций Firestore Video Studio: сколько ЧТЕНИЙ делает каждый endpoint/фоновый процесс и каждая коллекция, и какие ошибки RESOURCE_EXHAUSTED случались (с разбором причины).
   Оборачивает объект db прозрачно (Admin SDK и тестовая подделка); данные в памяти, ограничены по размеру; секретов и содержимого документов не хранит. */
const { AsyncLocalStorage } = require("async_hooks"), als = new AsyncLocalStorage(), RAW = Symbol("raw"), raw = x => (x && x[RAW]) || x;
const S = { since: Date.now(), total: 0, by_label: {}, by_coll: {}, by_label_coll: {}, minutes: {}, exhausted: [], writes: 0 };
const CHAIN = new Set(["collection", "doc", "where", "orderBy", "limit", "offset", "select", "startAt", "startAfter", "endAt", "endBefore"]), WRITES = new Set(["set", "update", "create", "delete"]);
const label = () => (als.getStore() || {}).label || "other";
function record(coll, n) { const l = label(), c = coll || "?", m = Math.floor(Date.now() / 60000); S.total += n; S.by_label[l] = (S.by_label[l] || 0) + n; S.by_coll[c] = (S.by_coll[c] || 0) + n; const k = l + "|" + c; S.by_label_coll[k] = (S.by_label_coll[k] || 0) + n; S.minutes[m] = (S.minutes[m] || 0) + n; for (const key of Object.keys(S.minutes)) if (Number(key) < m - 180) delete S.minutes[key]; }
const reads = r => (r && Array.isArray(r.docs) ? Math.max(1, r.docs.length) : r && typeof r.exists === "boolean" ? 1 : 0);
function classify(e) {
  const m = String((e && e.message) || e || ""), code = e && e.code;
  if (!(code === 8 || /RESOURCE_EXHAUSTED/i.test(m))) return null;
  return /quota/i.test(m) ? { kind: "daily_quota", hint: "Исчерпана суточная квота Firestore (бесплатный план: 50 000 чтений / 20 000 записей в сутки). Сбрасывается раз в сутки; уменьшите чтения." } : /contention|too much/i.test(m) ? { kind: "contention", hint: "Слишком частые записи в один документ (лимит ≈1 запись/с на документ): это не квота, а конкуренция за документ." } : /rate|too many|throttl|limit/i.test(m) ? { kind: "rate_limit", hint: "Ограничение скорости запросов (всплеск), а не суточная квота." } : { kind: "unknown", hint: "RESOURCE_EXHAUSTED без пояснения: проверьте вкладку Usage в Firebase Console и текст ошибки." };
}
function noteError(e, coll) { const c = classify(e); if (!c) return; const rec = Object.assign({ at: Date.now(), label: label(), collection: coll || "?", message: String(e.message || e).slice(0, 220) }, c); S.exhausted.push(rec); if (S.exhausted.length > 30) S.exhausted.shift(); try { console.error("video-studio: Firestore RESOURCE_EXHAUSTED [" + c.kind + "] label=" + rec.label + " коллекция=" + rec.collection + " — " + c.hint); } catch (x) { /* журнал недоступен */ } }
function wrap(obj, coll) {
  if (!obj || typeof obj !== "object") return obj;
  return new Proxy(obj, { get(t, p) {
    if (p === RAW) return t; const v = t[p];
    if (p === "get" && typeof v === "function") return async (...a) => { try { const r = await v.apply(t, a); record(coll, reads(r)); return r; } catch (e) { noteError(e, coll); throw e; } };
    if (p === "count" && typeof v === "function") return (...a) => { const agg = v.apply(t, a); return { get: async () => { try { const r = await agg.get(); record(coll, 1); return r; } catch (e) { noteError(e, coll); throw e; } } }; };
    if (typeof v !== "function") return v;
    if (CHAIN.has(p)) return (...a) => wrap(v.apply(t, a.map(raw)), p === "collection" ? String(a[0]) : coll);
    if (p === "runTransaction") return (fn, ...rest) => v.call(t, tx => fn(wrapTx(tx)), ...rest).catch(e => { noteError(e, "transaction"); throw e; });
    if (p === "batch") return () => wrapBatch(v.call(t));
    if (p === "getAll") return async (...refs) => { const r = await v.apply(t, refs.map(raw)); record("getAll", Math.max(1, (r || []).length)); return r; };
    return v.bind(t);
  } });
}
function wrapTx(tx) { return new Proxy(tx, { get(t, p) { const v = t[p]; if (typeof v !== "function") return v; if (p === "get") return async (a) => { const r = await v.call(t, raw(a)); record("transaction", reads(r)); return r; }; if (WRITES.has(p)) return (a, ...rest) => { S.writes++; return v.call(t, raw(a), ...rest); }; return v.bind(t); } }); }
function wrapBatch(b) { return new Proxy(b, { get(t, p) { const v = t[p]; if (typeof v !== "function") return v; if (WRITES.has(p)) return (a, ...rest) => { S.writes++; return v.call(t, raw(a), ...rest); }; return v.bind(t); } }); }
const meter = {
  unwrap: raw, wrap: db => (db && !db[RAW] ? wrap(db, "") : db), run: (name, fn) => als.run({ label: name }, fn), label,
  snapshot() { const m = Math.floor(Date.now() / 60000), last60 = Object.entries(S.minutes).filter(([k]) => Number(k) > m - 60).reduce((s, [, v]) => s + v, 0), up = Math.max(1, (Date.now() - S.since) / 3600000);
    const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => ({ name: k, reads: v, share: S.total ? +(100 * v / S.total).toFixed(1) : 0 }));
    return { since: S.since, uptime_h: +up.toFixed(2), reads_total: S.total, reads_last_60_min: last60, avg_reads_per_hour: Math.round(S.total / up), projected_reads_per_day: Math.round(S.total / up * 24), writes_seen: S.writes, free_tier_daily_reads: 50000, top_consumers: top(S.by_label), top_collections: top(S.by_coll), top_label_collection: top(S.by_label_coll), resource_exhausted: S.exhausted.slice(-10) }; },
  reset() { S.since = Date.now(); S.total = 0; S.by_label = {}; S.by_coll = {}; S.by_label_coll = {}; S.minutes = {}; S.exhausted = []; S.writes = 0; },
  classify, noteError, startLog(log, everyMs = 600000) { const t = setInterval(() => { const s = meter.snapshot(); log.log && log.log("video-studio: чтений Firestore за час " + s.reads_last_60_min + " (≈" + s.projected_reads_per_day + "/сутки по среднему). Основные: " + s.top_consumers.slice(0, 3).map(x => x.name + " " + x.share + "%").join(", ")); }, everyMs); if (t.unref) t.unref(); return t; }
};
module.exports = meter;
