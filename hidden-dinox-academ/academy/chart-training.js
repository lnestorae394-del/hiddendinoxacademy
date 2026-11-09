"use strict";
/* Chart Training (без ИИ): анализ графика → гипотеза → раскрытие следующих свечей → разбор по критериям сценария.
   Сценарии: встроенные СИМУЛЯЦИИ (детерминированный генератор по seed — воспроизводимы, помечены «не реальные данные»)
   и ИСТОРИЧЕСКИЕ из CSV (импорт администратора с указанием инструмента, таймфрейма и источника).
   Скрытые свечи хранятся/строятся на сервере и отдаются только после фиксации ответа (одна попытка на сессию).
   Оценивается аргументация (направление относительно контекста, факторы, уровень отмены, риск), а не только исход. */
const crypto = require("crypto");
const FACTORS = ["structure", "liquidity_sweep", "bos_mss", "fvg", "premium_discount", "no_confirmation"];
const DIRS = ["up", "down", "no_trade"];
const T3 = (ru, en, ua) => ({ ru, en, ua });
/* ---------- Генератор симуляций (mulberry32: одинаковый seed → одинаковые свечи) ---------- */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// lessons — массив объектов: Firestore не хранит вложенные массивы
const PATTERNS = {
  // [смещения по фазам: тренд, откат, продолжение]; teach — что ожидается от разбора
  trend_up_pullback: { phases: [[30, 0.00030], [14, -0.00028], [20, 0.00034]], visible: 44, dir: "up", factors: ["structure", "premium_discount"], invalid: "below_low", lessons: [{ course_slug: "smart-money-concepts-binary", module_index: 0 }, { course_slug: "smart-money-concepts-binary", module_index: 7 }] },
  trend_down_pullback: { phases: [[30, -0.00030], [14, 0.00028], [20, -0.00034]], visible: 44, dir: "down", factors: ["structure", "premium_discount"], invalid: "above_high", lessons: [{ course_slug: "smart-money-concepts-binary", module_index: 0 }, { course_slug: "smart-money-concepts-binary", module_index: 7 }] },
  sweep_reversal_up: { phases: [[26, -0.00026], [4, -0.00055], [8, 0.00070], [6, -0.00022], [18, 0.00040]], visible: 44, dir: "up", factors: ["liquidity_sweep", "bos_mss", "fvg"], invalid: "below_low", lessons: [{ course_slug: "smart-money-concepts-binary", module_index: 4 }, { course_slug: "smart-money-concepts-binary", module_index: 1 }] },
  sweep_reversal_down: { phases: [[26, 0.00026], [4, 0.00055], [8, -0.00070], [6, 0.00022], [18, -0.00040]], visible: 44, dir: "down", factors: ["liquidity_sweep", "bos_mss", "fvg"], invalid: "above_high", lessons: [{ course_slug: "smart-money-concepts-binary", module_index: 4 }, { course_slug: "smart-money-concepts-binary", module_index: 1 }] },
  range_chop: { phases: [[16, 0.00012], [16, -0.00012], [16, 0.00012], [16, -0.00010]], visible: 44, dir: "no_trade", factors: ["no_confirmation"], invalid: null, lessons: [{ course_slug: "smart-money-concepts-binary", module_index: 12 }, { course_slug: "risk-management-binary", module_index: 3 }] }
};
function synth(pattern, seed, start = 1.0850) {
  const P = PATTERNS[pattern], r = rng(seed); let price = start; const out = []; let t = Date.UTC(2026, 0, 5, 7, 0) + (seed % 50) * 86400e3;
  for (const [n, drift] of P.phases) for (let i = 0; i < n; i++) {
    const vol = 0.00022 + r() * 0.00018, o = price, c = +(o + drift + (r() - 0.5) * vol * 1.6).toFixed(5);
    const h = +(Math.max(o, c) + r() * vol).toFixed(5), l = +(Math.min(o, c) - r() * vol).toFixed(5);
    out.push({ t, o: +o.toFixed(5), h, l, c }); price = c; t += 15 * 60e3;
  }
  return out;
}
const SYNTH = [];
[["trend_up_pullback", [11, 23, 37]], ["trend_down_pullback", [12, 29, 41]], ["sweep_reversal_up", [5, 17]], ["sweep_reversal_down", [8, 19]], ["range_chop", [3, 31]]]
  .forEach(([p, seeds]) => seeds.forEach((s, i) => SYNTH.push({ id: `sim_${p}_${i + 1}`, source: "synthetic", pattern: p, seed: s, timeframe: "M15", version: 1,
    title: T3(`Симуляция №${SYNTH.length + 1}`, `Simulation #${SYNTH.length + 1}`, `Симуляція №${SYNTH.length + 1}`) })));
/* ---------- CSV (Time,Open,High,Low,Close[,Volume]) ---------- */
function parseCsv(text) {
  const rows = String(text || "").replace(/\r/g, "").split("\n").map(s => s.trim()).filter(Boolean);
  if (rows.length < 2) throw bad("CSV пуст");
  const head = rows[0].toLowerCase().split(/[;,\t]/).map(s => s.trim()); const idx = k => head.findIndex(h => h === k || h.startsWith(k));
  const ix = { t: Math.max(idx("time"), idx("date"), idx("timestamp")), o: idx("open"), h: idx("high"), l: idx("low"), c: idx("close") };
  if (Object.values(ix).some(v => v < 0)) throw bad("Нужны столбцы Time (или Date), Open, High, Low, Close");
  const out = [];
  for (const [n, line] of rows.slice(1).entries()) {
    const f = line.split(/[;,\t]/).map(s => s.trim());
    const t = /^\d{10,13}$/.test(f[ix.t]) ? Number(f[ix.t]) * (f[ix.t].length === 10 ? 1000 : 1) : Date.parse(f[ix.t].replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(f[ix.t]) ? "" : "Z"));
    const [o, h, l, c] = [ix.o, ix.h, ix.l, ix.c].map(i => Number(String(f[i]).replace(",", ".")));
    if (!Number.isFinite(t) || [o, h, l, c].some(x => !Number.isFinite(x) || x <= 0)) throw bad(`Строка ${n + 2}: неверное время или цена`);
    if (h < Math.max(o, c) || l > Math.min(o, c) || h < l) throw bad(`Строка ${n + 2}: High/Low не охватывают Open/Close`);
    if (out.length && t <= out[out.length - 1].t) throw bad(`Строка ${n + 2}: время должно возрастать`);
    out.push({ t, o, h, l, c });
  }
  return out;
}
function bad(msg, code = "INVALID", status = 400) { return Object.assign(new Error(msg), { code, status }); }

function createChartTraining({ db, now = () => Date.now() }) {
  const col = n => db.collection(n);
  async function scenarios() {
    const saved = new Map((await col("chart_scenarios").get()).docs.map(d => [d.id, d.data()]));
    const out = SYNTH.map(s => ({ ...s, active: !(saved.get(s.id) || {}).disabled }));
    for (const [id, v] of saved) if (v.source === "csv") out.push({ ...v, id, active: !v.disabled });
    return out;
  }
  async function full(sc) {                                         // все свечи + критерии (только сервер)
    if (sc.source === "synthetic") { const P = PATTERNS[sc.pattern]; return { candles: synth(sc.pattern, sc.seed), visible: P.visible, dir: P.dir, factors: P.factors, invalid: P.invalid, lessons: P.lessons }; }
    return { candles: sc.candles, visible: sc.visible, dir: sc.expected_dir, factors: sc.expected_factors || [], invalid: sc.expected_dir === "up" ? "below_low" : sc.expected_dir === "down" ? "above_high" : null, lessons: sc.lessons || [] };
  }
  const label = sc => sc.source === "synthetic" ? { kind: "synthetic" } : { kind: "historical", instrument: sc.instrument, timeframe: sc.timeframe, data_source: sc.data_source };
  async function next(uid, lang, retry) {
    const list = (await scenarios()).filter(s => s.active);
    if (!list.length) throw bad("Нет доступных сценариев", "NO_SCENARIOS", 404);
    const mine = (await col("chart_sessions").where("uid", "==", uid).get()).docs.map(d => d.data());
    let sc;
    if (retry) {                                                     // «Пройти снова» — только для сценария, который ученик пропустил
      if (!mine.some(x => x.scenario_id === retry && x.status === "skipped")) throw bad("Повторить можно только пропущенный сценарий", "NOT_SKIPPED", 403);
      sc = list.find(x => x.id === retry); if (!sc) throw bad("Сценарий отключён", "NOT_FOUND", 404);
    } else {
      const seen = new Set(mine.map(x => x.scenario_id)), fresh = list.filter(s => !seen.has(s.id)), pool = fresh.length ? fresh : list;
      sc = pool[crypto.randomInt(pool.length)];
    }
    const f = await full(sc);
    const sid = crypto.randomBytes(9).toString("hex");
    await col("chart_sessions").doc(sid).set({ uid, scenario_id: sc.id, scenario_version: sc.version || 1, source: sc.source, status: "open", started_at: now() });
    return { session_id: sid, scenario: { id: sc.id, title: (sc.title || {})[lang] || (sc.title || {}).ru, timeframe: sc.timeframe, label: label(sc), candles: f.candles.slice(0, f.visible) } };
  }
  /* Разбор по критериям: 4 критерия по 25 баллов */
  function grade(ans, f) {
    const vis = f.candles.slice(0, f.visible), hid = f.candles.slice(f.visible), last = vis[vis.length - 1].c;
    const hi = Math.max(...vis.slice(-20).map(x => x.h)), lo = Math.min(...vis.slice(-20).map(x => x.l));
    const end = hid[hid.length - 1].c, move = end - last, rangeH = Math.max(...vis.map(x => x.h)) - Math.min(...vis.map(x => x.l));
    const outcome = Math.abs(move) < rangeH * 0.08 ? "flat" : move > 0 ? "up" : "down";
    const c = {};
    c.direction = ans.direction === f.dir ? 25 : (f.dir === "no_trade" || ans.direction === "no_trade") ? 8 : 0;
    const exp = new Set(f.factors), got = new Set(ans.factors), hits = [...exp].filter(x => got.has(x)).length, extra = [...got].filter(x => !exp.has(x)).length;
    c.factors = exp.size ? Math.max(0, Math.round(25 * hits / exp.size) - extra * 5) : 0;
    if (ans.direction === "no_trade") c.invalidation = f.dir === "no_trade" ? 25 : 10;
    else if (!Number.isFinite(ans.invalidation)) c.invalidation = 0;
    else c.invalidation = (ans.direction === "up" ? ans.invalidation < last : ans.invalidation > last) ? (Math.abs(ans.invalidation - last) <= rangeH * 0.8 ? 25 : 12) : 0;
    c.risk = ans.direction === "no_trade" ? 25 : (Number.isFinite(ans.risk_percent) && ans.risk_percent > 0 && ans.risk_percent <= 2 ? 25 : Number.isFinite(ans.risk_percent) && ans.risk_percent <= 5 ? 10 : 0);
    const score = c.direction + c.factors + c.invalidation + c.risk;
    const kind = c.direction === 25 && score >= 70 ? (f.dir !== "no_trade" && outcome !== f.dir ? "sound_not_realized" : "sound") : c.direction === 25 ? "incomplete" : f.dir === "no_trade" ? "forced_trade" : "rule_error";
    return { criteria: c, score, kind, outcome, expected: { direction: f.dir, factors: f.factors }, levels: { recent_high: hi, recent_low: lo, last_close: last }, missed: [...exp].filter(x => !got.has(x)), extra: [...got].filter(x => !exp.has(x)) };
  }
  async function answer(uid, sid, body) {
    const ref = col("chart_sessions").doc(String(sid || "")); const s = await ref.get();
    if (!s.exists || s.data().uid !== uid) throw bad("Сессия не найдена", "NOT_FOUND", 404);
    const sess = s.data(); const sc = (await scenarios()).find(x => x.id === sess.scenario_id); if (!sc) throw bad("Сценарий недоступен", "NOT_FOUND", 404);
    const f = await full(sc);
    if (sess.status === "done") return result(sess, f, label(sc));       // повтор — тот же разбор
    if (sess.status === "skipped") throw bad("Сценарий пропущен — откройте его снова из истории", "SKIPPED", 409);
    const b = body || {};
    if (!DIRS.includes(b.direction)) throw bad("Выберите гипотезу: вверх, вниз или нет сделки");
    const factors = Array.isArray(b.factors) ? [...new Set(b.factors.filter(x => FACTORS.includes(x)))] : [];
    const num = v => v === "" || v == null ? NaN : Number(String(v).replace(",", "."));
    const ans = { direction: b.direction, factors, invalidation: num(b.invalidation), entry: num(b.entry), risk_percent: num(b.risk_percent),
      explanation: String(b.explanation || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1000) };
    if (ans.direction !== "no_trade" && ans.explanation.length < 10) throw bad("Объясните гипотезу (минимум 10 символов)");
    const g = grade(ans, f);
    const rec = { ...sess, status: "done", answered_at: now(), answer: { ...ans, invalidation: Number.isFinite(ans.invalidation) ? ans.invalidation : null, entry: Number.isFinite(ans.entry) ? ans.entry : null, risk_percent: Number.isFinite(ans.risk_percent) ? ans.risk_percent : null }, grade: g, lessons: f.lessons };
    await db.runTransaction(async tx => { const cur = await tx.get(ref); if (cur.data().status !== "done") tx.set(ref, rec); });
    return result((await ref.get()).data(), f, label(sc));
  }
  /* «Пропустить анализ»: без оценки, не влияет на баллы; на отвеченный сценарий не действует */
  async function skip(uid, sid) {
    const ref = col("chart_sessions").doc(String(sid || ""));
    return db.runTransaction(async tx => {
      const s = await tx.get(ref); if (!s.exists || s.data().uid !== uid) throw bad("Сессия не найдена", "NOT_FOUND", 404);
      const cur = s.data(); if (cur.status === "done") throw bad("На сценарий уже дан ответ", "ALREADY_ANSWERED", 409);
      if (cur.status !== "skipped") tx.set(ref, { ...cur, status: "skipped", skipped_at: now() });
      return { session_id: sid, scenario_id: cur.scenario_id, status: "skipped" };
    });
  }
  const result = (sess, f, lbl) => ({ session_id: sess.id, scenario_id: sess.scenario_id, label: lbl, answer: sess.answer, grade: sess.grade, lessons: sess.lessons, candles: f.candles, visible: f.visible, answered_at: sess.answered_at });
  async function history(uid) {
    const all = (await col("chart_sessions").where("uid", "==", uid).get()).docs.map(d => ({ id: d.id, ...d.data() })).filter(x => x.status === "done" || x.status === "skipped");
    const at = x => x.answered_at || x.skipped_at || 0; all.sort((a, b) => at(b) - at(a));
    return all.slice(0, 100).map(x => x.status === "skipped"
      ? { session_id: x.id, scenario_id: x.scenario_id, source: x.source, status: "skipped", at: x.skipped_at, direction: null, score: null, kind: "skipped" }
      : { session_id: x.id, scenario_id: x.scenario_id, source: x.source, status: "done", at: x.answered_at, answered_at: x.answered_at, direction: x.answer.direction, score: x.grade.score, kind: x.grade.kind });
  }
  async function session(uid, sid) {
    const s = await col("chart_sessions").doc(String(sid || "")).get(); if (!s.exists || s.data().uid !== uid || s.data().status !== "done") throw bad("Разбор не найден", "NOT_FOUND", 404);
    const sc = (await scenarios()).find(x => x.id === s.data().scenario_id); return result({ id: s.id, ...s.data() }, await full(sc), label(sc));
  }
  /* ---------- Администратор ---------- */
  async function setActive(id, active) {
    const list = await scenarios(), sc = list.find(x => x.id === id); if (!sc) throw bad("Сценарий не найден", "NOT_FOUND", 404);
    await col("chart_scenarios").doc(id).set({ ...(sc.source === "csv" ? {} : { source: "synthetic" }), disabled: !active, updated_at: now() }, { merge: true });
    return { id, active: !!active };
  }
  async function importCsv(b) {
    b = b || {};
    const id = String(b.id || "").trim(); if (!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(id)) throw bad("ID: 3–40 символов, латиница, цифры, - и _");
    if ((await scenarios()).some(x => x.id === id)) throw bad("Сценарий с таким ID уже есть");
    const instrument = String(b.instrument || "").trim().slice(0, 30), timeframe = String(b.timeframe || "").trim().slice(0, 10), data_source = String(b.data_source || "").trim().slice(0, 200);
    if (!instrument || !timeframe) throw bad("Укажите инструмент и таймфрейм"); if (data_source.length < 3) throw bad("Укажите источник данных (откуда CSV и разрешено ли использование)");
    const candles = parseCsv(b.csv); const visible = Number(b.visible), hidden = candles.length - visible;
    if (candles.length < 30 || candles.length > 400) throw bad("Нужно от 30 до 400 свечей");
    if (!Number.isInteger(visible) || visible < 20 || hidden < 5) throw bad("Видимых свечей — минимум 20, скрытых — минимум 5");
    const dir = ["up", "down", "no_trade"].includes(b.expected_dir) ? b.expected_dir : null; if (!dir) throw bad("Укажите ожидаемую гипотезу (up, down или no_trade)");
    const ef = Array.isArray(b.expected_factors) ? b.expected_factors.filter(x => FACTORS.includes(x)) : [];
    const doc = { id, source: "csv", version: 1, instrument, timeframe, data_source, candles, visible, expected_dir: dir, expected_factors: ef,
      title: T3(`${instrument} ${timeframe}`, `${instrument} ${timeframe}`, `${instrument} ${timeframe}`), created_at: now(), disabled: false };
    await col("chart_scenarios").doc(id).set(doc); return { id, candles: candles.length, visible };
  }
  async function adminList() { return (await scenarios()).map(s => ({ id: s.id, source: s.source, active: s.active, pattern: s.pattern || null, instrument: s.instrument || null, timeframe: s.timeframe, data_source: s.data_source || null, title: (s.title || {}).ru })); }
  async function preview(id) { const sc = (await scenarios()).find(x => x.id === id); if (!sc) throw bad("Сценарий не найден", "NOT_FOUND", 404); const f = await full(sc); return { id, label: label(sc), candles: f.candles, visible: f.visible, expected: { direction: f.dir, factors: f.factors } }; }
  return { scenarios, next, answer, skip, history, session, setActive, importCsv, adminList, preview };
}
module.exports = { createChartTraining, synth, parseCsv, PATTERNS, SYNTH, FACTORS };
