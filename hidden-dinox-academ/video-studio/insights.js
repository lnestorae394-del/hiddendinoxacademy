"use strict";
/* Сводные данные для Dashboard, Analytics, Media Library и журнала действий — ТОЛЬКО из реальных данных Firestore (никаких вымышленных цифр). */
const { COLL } = require("./constants"), DAY = 86400000;
const rows = q => q.get().then(r => r.docs.map(d => Object.assign({ id: d.id }, d.data())));
const all = (db, c) => rows(db.collection(c));
/* задания: активные (любого возраста) + изменённые за окно; события — только последние N. Раньше читались ВСЕ документы при каждом открытии Dashboard (рост затрат Firestore со временем). */
const jobsWindow = async (db, since) => { const [a, r] = await Promise.all([rows(db.collection(COLL.jobs).where("status", "in", ["queued", "claimed", "running"])), rows(db.collection(COLL.jobs).where("updated_at", ">", since))]); const m = new Map(); for (const j of a.concat(r)) m.set(j.id, j); return [...m.values()]; };
const recentEvents = (db, n) => rows(db.collection(COLL.events).orderBy("at", "desc").limit(n));
const dayKey = t => new Date(t).toISOString().slice(0, 10);
const monthKey = t => new Date(t).toISOString().slice(0, 7);
const series = (now, days, items, at) => { const m = {}; for (let i = days - 1; i >= 0; i--) m[dayKey(now - i * DAY)] = 0; for (const it of items) { const k = dayKey(at(it)); if (k in m) m[k]++; } return Object.entries(m).map(([date, n]) => ({ date, n })); };
async function dashboard(db, now) {
  const [projects, clips, jobs, usage, events, editors] = await Promise.all([all(db, COLL.projects), all(db, COLL.clips), jobsWindow(db, now - 8 * DAY), all(db, COLL.usage), recentEvents(db, 10), all(db, COLL.editors)]);
  const live = projects.filter(p => p.status !== "deleted"), week = now - 7 * DAY, exp = clips.filter(c => c.render), cur = usage.find(u => u.month === monthKey(now)) || usage.find(u => u.id === monthKey(now)) || {};
  const by = {}; live.forEach(p => { by[p.status] = (by[p.status] || 0) + 1; });
  const cnt = {}; clips.forEach(c => { const k = c.project_id; (cnt[k] = cnt[k] || { clips: 0, exports: 0 }).clips++; if (c.render) cnt[k].exports++; });
  const srcBytes = live.filter(p => p.status !== "uploading").reduce((s, p) => s + (p.size_bytes || 0), 0), expBytes = exp.reduce((s, c) => s + ((c.render && c.render.size) || 0), 0), prevBytes = clips.reduce((s, c) => s + ((c.preview && c.preview.size) || 0), 0);
  return { projects: { total: live.length, by_status: by, analyzed: by.analyzed || 0 }, clips: { total: clips.length, exports: exp.length, telegram_sent: clips.filter(c => c.telegram && ["sent", "sent_link"].includes(c.telegram.status)).length },
    workflow: (() => { const w = { total: 0 }; for (const c of clips) { if (c.status === "excluded") continue; const k = (c.workflow && c.workflow.status) || "found"; w[k] = (w[k] || 0) + 1; w.total++; } w.rendered = clips.filter(c => c.render && c.status !== "excluded").length; w.building = clips.filter(c => c.status === "rendering").length; w.assigned = clips.filter(c => c.workflow && c.workflow.assignee_id && c.status !== "excluded").length; return w; })(),
    editors: { total: editors.filter(e => e.active !== false).length, linked: editors.filter(e => e.telegram && e.telegram.user_id).length },
    queue: { waiting: jobs.filter(j => j.status === "queued").length, processing: jobs.filter(j => ["claimed", "running"].includes(j.status)).length, failed_7d: jobs.filter(j => j.status === "failed" && (j.updated_at || 0) > week).length, succeeded_7d: jobs.filter(j => j.status === "succeeded" && (j.updated_at || 0) > week).length, cancelled_7d: jobs.filter(j => j.status === "cancelled" && (j.updated_at || 0) > week).length },
    storage: { source_bytes: srcBytes, export_bytes: expBytes, preview_bytes: prevBytes, total_bytes: srcBytes + expBytes + prevBytes, note: "по данным о проектах и экспортах (без расшифровок и временных окон)" },
    usage: { month: monthKey(now), spent_usd: Number(cur.spent_usd || 0), reserved_usd: Number(cur.reserved_usd || 0) },
    recent_projects: live.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 6).map(p => ({ id: p.id, filename: p.filename, status: p.status, size_bytes: p.size_bytes, duration_sec: p.duration_sec ?? null, created_at: p.created_at, clips: (cnt[p.id] || {}).clips || 0, exports: (cnt[p.id] || {}).exports || 0 })),
    recent_events: events.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 10).map(publicEvent) };
}
const publicEvent = e => ({ id: e.id, at: e.at, action: e.action, who: e.email || e.uid || "system", project_id: e.project_id || null, clip_id: e.clip_id || null, job_id: e.job_id || null, ok: e.ok === undefined ? null : e.ok, note: e.note || null });
/* среднее время этапов по реально записанным длительностям: { тип: { этап: секунды } } */
const stageAvg = jobs => { const acc = {}; for (const j of jobs) for (const s of j.stages || []) if (Number.isFinite(s.duration_ms)) { const a = ((acc[j.type] = acc[j.type] || {})[s.name] = (acc[j.type] || {})[s.name] || { sum: 0, n: 0 }); a.sum += s.duration_ms; a.n++; } return Object.fromEntries(Object.entries(acc).map(([t, o]) => [t, Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +(v.sum / v.n / 1000).toFixed(1)]))])); };
async function analytics(db, now, days = 14) {
  const [projects, clips, jobs, usage] = await Promise.all([all(db, COLL.projects), all(db, COLL.clips), jobsWindow(db, now - (days + 1) * DAY), all(db, COLL.usage)]);
  const live = projects.filter(p => p.status !== "deleted"), done = jobs.filter(j => j.status === "succeeded" && j.finished_at && j.started_at), avg = type => { const x = done.filter(j => j.type === type).map(j => (j.finished_at - j.started_at) / 1000); return x.length ? Math.round(x.reduce((a, b) => a + b, 0) / x.length) : null; };
  const cats = {}; clips.forEach(c => { if (c.category) cats[c.category] = (cats[c.category] || 0) + 1; }); const tg = { sent: 0, failed: 0, link: 0 }; clips.forEach(c => { const s = c.telegram && c.telegram.status; if (s === "sent") tg.sent++; else if (s === "sent_link") tg.link++; else if (s === "failed") tg.failed++; });
  return { days, projects_created: series(now, days, live, p => p.created_at || 0), exports_done: series(now, days, clips.filter(c => c.render), c => c.render.at || 0), jobs_failed: series(now, days, jobs.filter(j => j.status === "failed"), j => j.updated_at || 0), jobs_succeeded: series(now, days, jobs.filter(j => j.status === "succeeded"), j => j.updated_at || 0),
    stage_seconds: stageAvg(done), avg_seconds: { analyze: avg("analyze"), render: avg("render"), probe: avg("probe"), telegram: avg("telegram") }, categories: Object.entries(cats).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n), telegram: tg,
    spend: usage.map(u => ({ month: u.month || u.id, spent_usd: Number(u.spent_usd || 0) })).sort((a, b) => a.month.localeCompare(b.month)).slice(-6), totals: { projects: live.length, clips: clips.length, exports: clips.filter(c => c.render).length } };
}
async function events(db, limit = 60) { return (await recentEvents(db, Math.min(200, Math.max(1, Number(limit) || 60)))).map(publicEvent); }
/* Библиотека: исходные записи, готовые ролики, логотипы, шаблоны. Файлы остаются в R2, здесь только метаданные из Firestore. */
async function media(db, { kind, q, logos = [], presets = [] }) {
  const [projects, clips] = await Promise.all([all(db, COLL.projects), all(db, COLL.clips)]), items = [];
  for (const p of projects) if (p.status !== "deleted" && p.status !== "uploading") items.push({ id: "src_" + p.id, kind: "source", title: p.filename, size: p.size_bytes || 0, duration: p.duration_sec ?? null, project_id: p.id, clip_id: null, created_at: p.created_at || 0, status: p.status });
  for (const c of clips) if (c.render) items.push({ id: "exp_" + c.id, kind: "export", title: c.hook || c.title || "Ролик", size: c.render.size || 0, duration: c.render.duration ?? c.duration_s ?? null, project_id: c.project_id, clip_id: c.id, created_at: c.render.at || 0, has_thumb: !!c.thumb_path, telegram: c.telegram ? c.telegram.status : null });
  for (const l of logos) items.push({ id: "logo_" + l.id, kind: "logo", title: l.title, size: l.size || 0, created_at: l.created_at || 0, source: l.source });
  for (const t of presets) items.push({ id: "tpl_" + t.id, kind: "template", title: t.name, size: 0, created_at: t.created_at || 0, preset_id: t.id });
  const counts = {}; items.forEach(i => { counts[i.kind] = (counts[i.kind] || 0) + 1; });
  const qq = String(q || "").trim().toLowerCase(), out = items.filter(i => (!kind || i.kind === kind) && (!qq || String(i.title).toLowerCase().includes(qq))).sort((a, b) => b.created_at - a.created_at);
  return { items: out.slice(0, 300), counts, total: items.length };
}
module.exports = { dashboard, analytics, events, media, publicEvent, monthKey };
