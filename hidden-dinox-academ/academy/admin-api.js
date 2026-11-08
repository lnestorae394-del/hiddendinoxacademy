"use strict";
/* HIDDEN DINOX ACADEMY — API админ-панели (/admin/api/*).
   Каждый маршрут: проверенный Firebase ID-токен → роль из users/{uid}.role (сервер) → право из roles.js.
   Все изменения пишутся в audit_logs. Публикация — только с явным подтверждением (confirm: true). */
const crypto = require("crypto");
const R = require("./roles");
const C = require("./content");
const { describeStorageError, checkUpload } = require("./storage");
const { evaluateAccess, maskTraderId } = require("./access");
const D = require("./deposits");

class HttpError extends Error { constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra; } }
const newId = p => p + "_" + crypto.randomBytes(10).toString("hex");
const DAY = 86400000;
const STARTED_AT = Date.now();

function createAdminApi({ db, verifyIdToken, storage = null, authAdmin = null, log = console, now = () => Date.now(), env = process.env, aiFetch = null }) {
  const hits = new Map();
  const limited = (key, limit, windowMs) => {
    const t = now(), arr = (hits.get(key) || []).filter(x => t - x < windowMs); arr.push(t); hits.set(key, arr);
    if (hits.size > 5000) hits.clear();
    return arr.length > limit;
  };
  const col = n => db.collection(n);
  const all = async n => (await col(n).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const get = async (n, id) => { const d = await col(n).doc(id).get(); return d.exists ? { id, ...d.data() } : null; };

  async function audit(actor, action, target_type, target_id, details = {}) {
    await col("audit_logs").doc(newId("log")).set({ at: now(), actor_uid: actor.uid, actor_email: actor.email || null, actor_role: actor.role, action, target_type, target_id: target_id || null, details });
  }

  async function authenticate(req, perm) {
    if (!db || !verifyIdToken) throw new HttpError(503, "CONFIG_MISSING");
    const h = req.headers && (req.headers.authorization || req.headers.Authorization);
    const m = typeof h === "string" && h.match(/^Bearer ([A-Za-z0-9._-]{10,4096})$/);
    if (!m) throw new HttpError(401, "UNAUTHENTICATED");
    let dec; try { dec = await verifyIdToken(m[1]); } catch (e) { throw new HttpError(401, "UNAUTHENTICATED"); }
    if (!dec || !dec.uid) throw new HttpError(401, "UNAUTHENTICATED");
    const u = await get("users", dec.uid);
    if (u && u.blocked === true) throw new HttpError(403, "ACCOUNT_BLOCKED");
    const role = R.roleOf(u);
    const actor = { uid: dec.uid, email: (u && u.email) || dec.email || null, role };
    if (!R.can(role, "admin.enter") || (perm && !R.can(role, perm))) throw new HttpError(403, "FORBIDDEN", "Недостаточно прав");
    return actor;
  }

  /* -------- Dashboard: только реальные данные; чего нет в базе — помечается -------- */
  async function dashboard() {
    const [users, bindings, courses, modules, lessons, progress, logs, published] = await Promise.all(
      ["users", "trader_bindings", "courses", "course_modules", "course_lessons", "lesson_progress", "audit_logs", "published_courses"].map(all));
    const t = now();
    const reg = users.filter(u => Number.isFinite(u.created_at));
    const byUid = Object.fromEntries(users.map(u => [u.id, u]));
    let activated = 0, ftd = 0, pending = 0;
    for (const b of bindings) {
      const u = byUid[b.uid]; if (!u || String(u.trader_id) !== b.id) continue;
      const ref = await get("referrals", b.id);
      const ev = evaluateAccess({ uid: b.uid, user: u, binding: b, referral: ref });
      if (ev.academyAccess) activated++; else pending++;
      if (ev.firstDeposit) ftd++;
    }
    const days = n => { const out = []; for (let i = n - 1; i >= 0; i--) { const d = new Date(t - i * DAY); out.push(d.toISOString().slice(0, 10)); } return out; };
    const series = (items, field, n) => { const ds = days(n), c = Object.fromEntries(ds.map(d => [d, 0])); for (const x of items) { if (!Number.isFinite(x[field])) continue; const d = new Date(x[field]).toISOString().slice(0, 10); if (d in c) c[d]++; } return ds.map(d => ({ date: d, count: c[d] })); };
    const completed = progress.filter(p => p.completed === true);
    return {
      users: { total: users.length, new7: reg.filter(u => t - u.created_at <= 7 * DAY).length, new30: reg.filter(u => t - u.created_at <= 30 * DAY).length, blocked: users.filter(u => u.blocked).length, without_created_at: users.length - reg.length },
      academy: { activated, trader_bound: bindings.length, ftd_confirmed: ftd, awaiting_deposit: pending },
      content: { courses: courses.length, courses_published: published.length, modules: modules.length, lessons: lessons.length, lessons_ready: lessons.filter(l => l.status === "ready").length },
      learning: { lessons_completed: completed.length, learners: new Set(completed.map(p => p.uid)).size },
      charts: { registrations: series(reg, "created_at", 30), completions: series(completed, "completed_at", 30) },
      recent: logs.sort((a, b) => b.at - a.at).slice(0, 12).map(l => ({ at: l.at, action: l.action, actor: l.actor_email, target_type: l.target_type, target_id: l.target_id })),
      recent_learning: completed.sort((a, b) => b.completed_at - a.completed_at).slice(0, 10).map(p => ({ at: p.completed_at, uid: p.uid, email: (byUid[p.uid] || {}).email || null, lesson_id: p.lesson_id })),
      notes: ["Последняя активность считается с момента обновления: поле users.last_active_at заполняется при входе учеников в академию."]
    };
  }

  /* -------- Пользователи -------- */
  async function userSummary(u) {
    const role = R.roleOf(u);
    let ev = null;
    if (u.trader_id) {
      const [b, r] = await Promise.all([get("trader_bindings", String(u.trader_id)), get("referrals", String(u.trader_id))]);
      ev = evaluateAccess({ uid: u.id, user: u, binding: b, referral: r });
    }
    return {
      uid: u.id, email: u.email || null, role, blocked: u.blocked === true, created_at: u.created_at || null, last_active_at: u.last_active_at || null,
      trader_id_masked: u.trader_id ? maskTraderId(u.trader_id) : null, stage: ev ? ev.stage : "broker",
      academy_access: !!(ev && ev.academyAccess), broker_confirmed: !!(ev && ev.brokerRegistrationConfirmed),
      deposit_state: ev ? ev.depositState : "none", first_deposit: ev ? ev.firstDeposit : null,
      deposit_progress: ev ? ev.depositProgress : null, access_reason: ev ? ev.accessReason : null,
      telegram: u.telegram ? { id: u.telegram.id, username: u.telegram.username || null, name: u.telegram.name || null, photo_url: u.telegram.photo_url || null } : null
    };
  }
  async function listUsers(q) {
    const users = await all("users");
    const s = String(q.q || "").trim().toLowerCase();
    let list = users.filter(u => !s || (u.email || "").toLowerCase().includes(s) || u.id.toLowerCase() === s || String(u.trader_id || "") === s || (u.telegram && (String(u.telegram.id) === s || (u.telegram.username || "").toLowerCase() === s.replace(/^@/, ""))));
    if (q.role && R.ROLES.includes(q.role)) list = list.filter(u => R.roleOf(u) === q.role);
    const from = Date.parse(q.from || ""), to = Date.parse(q.to || "");
    if (Number.isFinite(from)) list = list.filter(u => (u.created_at || 0) >= from);
    if (Number.isFinite(to)) list = list.filter(u => (u.created_at || 0) <= to + DAY);
    let out = [];
    for (const u of list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 500)) out.push(await userSummary(u));
    if (q.status === "blocked") out = out.filter(u => u.blocked);
    if (q.status === "access") out = out.filter(u => u.academy_access);
    if (q.status === "awaiting") out = out.filter(u => !u.academy_access && u.stage === "deposit");
    if (q.status === "no_trader") out = out.filter(u => u.stage === "broker");
    if (q.status === "review") out = out.filter(u => u.deposit_progress && u.deposit_progress.pending_reasons.includes("possible_repeat"));
    return out;
  }

  /* -------- Контент -------- */
  const lessonsOf = async courseId => (await col("course_lessons").where("course_id", "==", courseId).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const modulesOf = async courseId => (await col("course_modules").where("course_id", "==", courseId).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  async function courseFull(id) {
    const c = await get("courses", id); if (!c) throw new HttpError(404, "NOT_FOUND");
    const [mods, less, pub] = await Promise.all([modulesOf(id), lessonsOf(id), get("published_courses", id)]);
    return {
      course: c, published: pub ? { published_at: pub.published_at, visible_from: pub.visible_from, version: pub.version, lessons: pub.lesson_count } : null,
      has_unpublished_changes: !!(pub && (c.updated_at > pub.published_at || mods.some(m => m.updated_at > pub.published_at) || less.some(l => l.updated_at > pub.published_at))),
      modules: mods.sort((a, b) => a.order - b.order).map(m => ({ ...m, lessons: less.filter(l => l.module_id === m.id).sort((a, b) => a.order - b.order).map(l => ({ id: l.id, title: l.title, order: l.order, status: l.status, blocks: (l.blocks || []).length, source_pages: l.source_pages || "", updated_at: l.updated_at })) }))
    };
  }
  async function publishCourse(actor, id, body) {
    if (!body || body.confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED", "Публикация требует явного подтверждения");
    const visible_from = body.visible_from ? Date.parse(body.visible_from) : null;
    if (body.visible_from && !Number.isFinite(visible_from)) throw new HttpError(400, "INVALID", "некорректная дата начала показа");
    const full = await courseFull(id);
    const ready = []; for (const m of full.modules) for (const l of m.lessons) if (l.status === "ready") ready.push(l.id);
    if (!ready.length) throw new HttpError(409, "NOTHING_READY", "Нет уроков в статусе «Готов к публикации»");
    if (ready.length > 400) throw new HttpError(409, "TOO_LARGE");
    const prevPublished = (await col("published_lessons").where("course_id", "==", id).get()).docs.map(d => d.id);
    const t = now();
    await db.runTransaction(async tx => {
      const lessonDocs = []; for (const lid of ready) lessonDocs.push(await tx.get(col("course_lessons").doc(lid)));
      const prev = await tx.get(col("published_courses").doc(id));
      const version = (prev.exists ? prev.data().version || 0 : 0) + 1;
      const byId = Object.fromEntries(lessonDocs.map(d => [d.id, d.data()]));
      const pick = (tr, keys) => tr ? Object.fromEntries(["en", "ua", "src"].filter(x => tr[x]).map(x => [x, Object.fromEntries(Object.entries(tr[x]).filter(([k]) => keys.includes(k)))])) : undefined;
      const modules = full.modules.map(m => ({ id: m.id, title: m.title, goal: m.goal || "", order: m.order, mastery_criteria: m.mastery_criteria || "", ...(m.tr ? { tr: pick(m.tr, ["title", "goal", "mastery_criteria"]) } : {}),
        lessons: m.lessons.filter(l => byId[l.id]).map(l => ({ id: l.id, title: byId[l.id].title, order: l.order, outcome: byId[l.id].outcome || "", has_quiz: (byId[l.id].blocks || []).some(b => b.type === "quiz"), ...(byId[l.id].tr ? { tr: pick(byId[l.id].tr, ["title", "outcome"]) } : {}) })) })).filter(m => m.lessons.length);
      const c = full.course;
      tx.set(col("published_courses").doc(id), { title: c.title, description: c.description || "", goal: c.goal || "", level: c.level, cover_media_id: c.cover_media_id || null, disclaimer: c.disclaimer || "", ...(c.tr ? { tr: c.tr } : {}), modules, lesson_count: ready.length, published_at: t, published_by: actor.uid, visible_from: visible_from || t, version });
      for (const lid of ready) { const l = byId[lid]; tx.set(col("published_lessons").doc(lid), { course_id: id, module_id: l.module_id, title: l.title, outcome: l.outcome || "", source_pages: l.source_pages || "", blocks: l.blocks || [], pass_criteria: l.pass_criteria || {}, ...(l.tr ? { tr: l.tr } : {}), version, published_at: t }); }
      for (const old of prevPublished) if (!ready.includes(old)) tx.delete(col("published_lessons").doc(old));
      tx.set(col("courses").doc(id), { status: "published", published_at: t }, { merge: true });
    });
    await audit(actor, "course.publish", "course", id, { lessons: ready.length, visible_from: visible_from || t });
    return { ok: true, lessons: ready.length };
  }
  async function unpublishCourse(actor, id, body) {
    if (!body || body.confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED");
    const pubs = (await col("published_lessons").where("course_id", "==", id).get()).docs.map(d => d.id);
    await db.runTransaction(async tx => {
      tx.delete(col("published_courses").doc(id));
      for (const p of pubs) tx.delete(col("published_lessons").doc(p));
      tx.set(col("courses").doc(id), { status: "draft" }, { merge: true });
    });
    await audit(actor, "course.unpublish", "course", id, { lessons: pubs.length });
    return { ok: true };
  }
  async function importCourse(actor, data) {
    const c = C.course(data && data.course);
    const mods = Array.isArray(data && data.modules) ? data.modules : [];
    if (!mods.length || mods.length > 50) throw new HttpError(400, "INVALID", "нужны модули (1–50)");
    const prepared = mods.map((m, i) => ({ m: C.moduleDoc(m), lessons: (Array.isArray(m.lessons) ? m.lessons : []).map(l => C.lesson({ ...l, status: "draft" })), i }));
    // Повторный импорт того же курса (тот же slug) не создаёт дубликат
    if (c.slug) {
      const same = (await col("courses").where("slug", "==", c.slug).get()).docs;
      if (same.length) throw new HttpError(409, "ALREADY_IMPORTED", "Этот курс уже импортирован. Откройте существующий черновик или удалите его перед повторным импортом.", { course_id: same[0].id });
    }
    const t = now(), courseId = newId("crs");
    const writes = [];
    writes.push([col("courses").doc(courseId), { ...c, status: "draft", created_at: t, updated_at: t, created_by: actor.uid, imported: true }]);
    let nLessons = 0;
    for (const p of prepared) {
      const mid = newId("mod");
      writes.push([col("course_modules").doc(mid), { ...p.m, course_id: courseId, order: (p.i + 1) * 10, created_at: t, updated_at: t }]);
      p.lessons.forEach((l, j) => { nLessons++; writes.push([col("course_lessons").doc(newId("les")), { ...l, course_id: courseId, module_id: mid, order: (j + 1) * 10, created_at: t, updated_at: t }]); });
    }
    if (writes.length > 450) throw new HttpError(409, "TOO_LARGE");
    await db.runTransaction(async tx => { for (const [ref, d] of writes) tx.set(ref, d); });
    await audit(actor, "course.import", "course", courseId, { modules: prepared.length, lessons: nLessons, title: c.title });
    return { ok: true, course_id: courseId, modules: prepared.length, lessons: nLessons };
  }

  /* -------- Медиа -------- */
  async function mediaUsage(id) {
    const used = [];
    for (const c of await all("courses")) if (c.cover_media_id === id) used.push({ type: "course", id: c.id, title: c.title });
    for (const l of await all("course_lessons")) if (C.mediaRefs(l).has(id)) used.push({ type: "lesson", id: l.id, title: l.title });
    for (const a of await all("announcements")) if (a.image_media_id === id) used.push({ type: "announcement", id: a.id, title: a.title });
    return used;
  }

  /* -------- Обработчики (req.params, req.query, req.body) -------- */
  const F = require("./features").createFeatures({ db, now });
  const DT = require("./daily-tests").createDailyTests({ db, now, log });
  const CT = require("./chart-training").createChartTraining({ db, now });
  const MN = require("./mentor").createMentor({ db, env, now, log });
  const KV2 = require("./knowledge-v2").createKnowledgeV2({ db, now });
  const GEN = require("./daily-generator").createGenerator({ db, env, now, log, fetchImpl: aiFetch || globalThis.fetch });
  const KN = require("./knowledge").createKnowledge({ db, now });
  const fx = async fn => { try { return await fn(); } catch (e) { if (e && e.status && e.code) throw new HttpError(e.status, e.code, e.message); throw e; } };
  const H = {
    /* ---------- База знаний v2 ---------- */
    async kv2Status() { return { ...(await KV2.status()), backups: (await KV2.listBackups()).slice(0, 10) }; },
    async kv2DryRun() { return KV2.dryRun(); },
    async kv2Import(req, actor) { if (!(req.body || {}).confirm) throw new HttpError(400, "CONFIRM_REQUIRED");
      const b = await KV2.storeBackup(actor.uid);                                    // резервная копия до любых изменений
      const r = await fx(() => KV2.apply(undefined, actor.uid, { backupRef: b.backup_id })); await audit(actor, "knowledge_v2.import", "knowledge", "v2", { written: r.written, archived: r.archived, backup: b.backup_id });
      require("./knowledge-v2").invalidateMentorIndex(db); return { ...r, backup_id: b.backup_id }; },
    async kv2Verify(req, actor) { const r = await KV2.verify(actor.uid); require("./knowledge-v2").invalidateMentorIndex(db); return r; },
    async kv2Activate(req, actor) { const b = req.body || {}; if (!b.confirm) throw new HttpError(400, "CONFIRM_REQUIRED");
      const r = await fx(() => KV2.activate(b.version, actor.uid, { force: b.force === true })); await audit(actor, "knowledge_v2.activate", "knowledge", r.active, { force: b.force === true });
      require("./knowledge-v2").invalidateMentorIndex(db); return r; },
    async kv2Reindex(req, actor) { const r = await KV2.reindex(actor.uid); require("./knowledge-v2").invalidateMentorIndex(db); return r; },
    async kv2Backup(req) { return fx(() => KV2.loadBackup((req.query || {}).id)); },
    async kv2Search(req) { const q = req.query || {}, lang = ["ru", "en", "ua"].includes(q.lang) ? q.lang : "ru", text = String(q.q || "").slice(0, 300);
      if (!text.trim()) return { results: [] };
      const M = require("./knowledge-v2"), recs = await KV2.publishedFromDb(), { glossary } = M.loadBundled();
      const ix = l => M.buildIndex(recs.filter(r => r.language === l), glossary);
      return { results: M.searchWithFallback(ix(lang), ix("ru"), text, { limit: 8 }).map(x => ({ title: x.r.title, type: x.r.type, section: x.r.section, course: x.r.course_title || x.r.course, language: x.r.language,
        authority: x.r.authority, verified: x.r.verified, translation_status: x.r.translation_status, score: Math.round(x.score * 10) / 10, matched: x.why, fallback: x.fallback || null,
        provenance: { file: x.r.provenance.source_file, page: x.r.provenance.page || null, lesson: x.r.lesson_key || null }, excerpt: x.r.content.slice(0, 400) })) }; },
    /* ---------- ИИ-помощник ---------- */
    async mentorStatus() { return MN.status(); },
    async budgetStatus() { return MN.budget.status(); },
    async budgetSettings(req, actor) { const r = await fx(() => MN.budget.setSettings(req.body || {})); await audit(actor, "ai.budget.settings", "ai", "budget", { total: r.monthly_total_usd, features: r.features, reserve: r.reserve_usd }); return { settings: r }; },
    async mentorTestConnection(req, actor) { const r = await MN.testConnection(); await audit(actor, "mentor.connection_test", "ai", "anthropic", { ok: r.ok, code: r.code, http_status: r.http_status || null, model: r.model || null }); return r; },
    async mentorSettings(req, actor) { const r = await fx(() => MN.setSettings(req.body || {})); await audit(actor, "mentor.settings", "ai", "mentor", r); return { settings: r }; },
    /* ---------- Hidden Dinox Knowledge Base ---------- */
    async knowledgeList(req) { return { items: await KN.list(req.query || {}), categories: require("./knowledge").CATEGORIES, languages: require("./knowledge").LANGS }; },
    async knowledgeGet(req) { const item = await KN.get(req.params.id); if (!item) throw new HttpError(404, "NOT_FOUND"); return { item }; },
    async knowledgeCreate(req, actor) { const item = await KN.create(req.body || {}, actor.uid); await audit(actor, "knowledge.create", "knowledge", item.id, { category: item.category, language: item.language }); return { item }; },
    async knowledgeUpdate(req, actor) { const item = await KN.update(req.params.id, req.body || {}, actor.uid); await audit(actor, "knowledge.update", "knowledge", item.id, { version: item.version }); return { item }; },
    async knowledgePublish(req, actor) { if ((req.body || {}).confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED"); const item = await KN.publish(req.params.id, (req.body || {}).published === true, actor.uid); await audit(actor, "knowledge.publish", "knowledge", item.id, { status: item.status }); return { item }; },
    async knowledgeDelete(req, actor) { if ((req.body || {}).confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED"); const r = await KN.remove(req.params.id, actor.uid); await audit(actor, "knowledge.delete", "knowledge", req.params.id, {}); return r; },
    async knowledgeVersions(req) { return { versions: await KN.versions(req.params.id) }; },
    async knowledgeRestore(req, actor) { if ((req.body || {}).confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED"); const item = await KN.restore(req.params.id, (req.body || {}).version, actor.uid); await audit(actor, "knowledge.restore", "knowledge", item.id, { version: item.version, restored_from: item.restored_from }); return { item }; },
    async knowledgeImport(req, actor) { if ((req.body || {}).confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED"); const r = await KN.importJson(req.body, actor.uid); await audit(actor, "knowledge.import", "knowledge", "*", { imported: r.imported }); return r; },
    async knowledgeExport() { return KN.exportJson(); },
    async knowledgeDiagnostics() { return KN.diagnostics(); },
    /* ---------- Chart Training ---------- */
    async chartList() { return { scenarios: await CT.adminList(), factors: require("./chart-training").FACTORS }; },
    async chartStatus(req, actor) { const r = await fx(() => CT.setActive(req.params.id, !!(req.body || {}).active)); await audit(actor, "chart.status", "chart_scenario", r.id, r); return r; },
    async chartImport(req, actor) { const r = await fx(() => CT.importCsv(req.body || {})); await audit(actor, "chart.import", "chart_scenario", r.id, { candles: r.candles }); return r; },
    async chartPreview(req) { return fx(() => CT.preview(req.params.id)); },
    /* ---------- Daily Tests ---------- */
    async dailyStatus() { return DT.status(); },
    async dailyConfig(req, actor) { const c = await fx(() => DT.setConfig(req.body || {})); await audit(actor, "daily.config", "daily", "config", c); return { config: c }; },
    async dailyImport(req, actor) { if (!(req.body || {}).confirm) throw new HttpError(400, "CONFIRM_REQUIRED"); const r = await DT.importBank(require("path").join(__dirname, "..", "content", "daily-bank", "daily_bank.json")); await audit(actor, "daily.bank_import", "daily", "bank", r); return r; },
    async dailyRun(req, actor) { const r = await DT.run("admin"); await audit(actor, "daily.run", "daily", r.today.date, { today: r.today.status, tomorrow: r.tomorrow.status }); return r; },
    async dailyBank(req) { const q = req.query || {}; return DT.bankList({ course: q.course, status: q.status, q: q.q, source: q.source, offset: q.offset }); },
    async dailyGenStatus() { return GEN.status(); },
    async dailyGenSettings(req, actor) { const r = await fx(() => GEN.setSettings(req.body || {})); await audit(actor, "daily.generator.settings", "daily", "generator", { auto_publish: r.auto_publish, enabled: r.enabled }); return { settings: r }; },
    async dailyGenRun(req, actor) { if (!(req.body || {}).confirm) throw new HttpError(400, "CONFIRM_REQUIRED"); const r = await GEN.run({ trigger: "admin", force: true, actor: actor.uid });
      await audit(actor, "daily.generator.run", "daily", "generator", { status: r.status, accepted: r.accepted }); return r; },
    async dailyAnalytics() { return DT.analytics(); },
    async dailyBankCreate(req, actor) { const r = await fx(() => DT.bankCreate({ ...(req.body || {}), created_by: actor.uid })); await audit(actor, "daily.bank_create", "daily_question", r.id, { course: r.course, kind: r.kind }); return { question: r }; },
    async dailyBankUpdate(req, actor) { const r = await fx(() => DT.bankUpdate(req.params.id, req.body || {})); await audit(actor, "daily.bank_update", "daily_question", req.params.id, { status: r.status }); return { question: r }; },
    async dailySets(req) { return { sets: await DT.sets(Number((req.query || {}).limit) || 30) }; },
    async dailySet(req) { return fx(() => DT.setDetail(req.params.date)); },
    /* ---------- Функции Academy: карточки ---------- */
    async featuresList() { const M = require("./features"); return { cards: await F.all(), statuses: M.STATUSES, icons: M.ICONS,
      modules: Object.entries(M.MODULES).map(([key, m]) => ({ key, label: m.label, ready: !!m.href })) }; },
    async featureCreate(req, actor) { const c = await fx(() => F.create(req.body || {}, actor.uid)); await audit(actor, "feature.create", "feature", c.id, { status: c.status }); return { card: c }; },
    async featureUpdate(req, actor) { const c = await fx(() => F.update(req.params.id, req.body || {}, actor.uid)); await audit(actor, "feature.update", "feature", c.id, { status: c.status, enabled: c.enabled }); return { card: c }; },
    async featureStatus(req, actor) { const c = await fx(() => F.update(req.params.id, { status: (req.body || {}).status }, actor.uid)); await audit(actor, "feature.status", "feature", c.id, { status: c.status }); return { card: c }; },
    async featureOrder(req, actor) { const cards = await fx(() => F.setOrder((req.body || {}).ids, actor.uid)); await audit(actor, "feature.order", "feature", "*", { ids: cards.map(c => c.id) }); return { cards }; },
    async featureDelete(req, actor) { if (!(req.body || {}).confirm) throw new HttpError(400, "CONFIRM_REQUIRED"); await fx(() => F.remove(req.params.id)); await audit(actor, "feature.delete", "feature", req.params.id, {}); return { ok: true }; },
    async featuresReset(req, actor) { if (!(req.body || {}).confirm) throw new HttpError(400, "CONFIRM_REQUIRED"); const cards = await F.resetDefaults(); await audit(actor, "feature.reset", "feature", "*", {}); return { cards }; },
    async me(req, actor) {
      if (!limited("login:" + actor.uid, 1, 30 * 60000)) await audit(actor, "admin.login", "user", actor.uid, {});
      return { uid: actor.uid, email: actor.email, role: actor.role, role_label: R.LABELS[actor.role], permissions: Object.keys(R.PERMISSIONS).filter(p => R.can(actor.role, p)), roles: R.ROLES.map(r => ({ id: r, label: R.LABELS[r] })) };
    },
    async dashboard() { return dashboard(); },
    async users(req) { return { users: await listUsers(req.query || {}) }; },
    async user(req) {
      const u = await get("users", req.params.uid); if (!u) throw new HttpError(404, "NOT_FOUND");
      const progress = (await col("lesson_progress").where("uid", "==", u.id).get()).docs.map(d => d.data());
      const logs = (await all("audit_logs")).filter(l => l.target_id === u.id).sort((a, b) => b.at - a.at).slice(0, 50);
      // Депозиты и доступ: каждое событие по Trader ID пользователя, сумма, прогресс до $50, реферер
      let deposits = null;
      if (u.trader_id) {
        const tid = String(u.trader_id);
        const [evs, ref, inv] = await Promise.all([col("deposit_events").where("trader_id", "==", tid).get(), get("referrals", tid), get("referral_invites", u.id)]);
        const acad = (ref && ref.academy) || {};
        deposits = { trader_id: tid, access_granted: acad.access_granted || null,
          events: evs.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => (x.at || 0) - (y.at || 0)).map(e => ({ id: e.id, kind: e.kind, amount_cents: e.amount_cents, currency: e.currency || null, status: e.status, counted: e.counted_in_totals === true, at: e.at || null, reviewed_by: e.reviewed_by || null, review_reason: e.review_reason || null })),
          pending: Object.entries(acad.pending_deposits || {}).filter(([, p]) => p.status === "pending").map(([k, p]) => ({ key: k, reason: p.reason, amount_cents: p.amount_cents, currency: p.currency || null, at: p.at || null })),
          referrer: inv ? { referrer_uid: inv.referrer_uid, code: inv.code || null, status: inv.status || null, joined_at: inv.created_at || null } : null };
      }
      return { deposits, user: await userSummary(u), progress: progress.map(p => ({ lesson_id: p.lesson_id, course_id: p.course_id, completed: p.completed === true, completed_at: p.completed_at || null, quiz: p.quiz || null })), audit: logs };
    },
    /* Решение по депозиту «ожидает проверки» (возможный повтор): засчитать или отклонить — только с причиной;
       решение одно (повторное — 409); всё в журнале аудита. После засчитывания — пересчёт доступа и реферального начисления. */
    async reviewDeposit(req, actor) {
      const b = req.body || {}; if (b.confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED");
      if (!["count", "reject"].includes(b.decision)) throw new HttpError(400, "INVALID_DECISION");
      const reason = String(b.reason || "").trim().slice(0, 500); if (!reason) throw new HttpError(400, "REASON_REQUIRED", "Укажите причину");
      const trader = String(req.params.trader), key = String(req.params.key);
      if (!/^\d{5,14}$/.test(trader) || !/^[A-Za-z0-9_.:-]{3,200}$/.test(key)) throw new HttpError(400, "INVALID");
      const r = await db.runTransaction(async tx => {
        const ref = col("referrals").doc(trader); const d = await tx.get(ref); if (!d.exists) throw new HttpError(404, "NOT_FOUND");
        const work = D.clone((d.data() && d.data().academy) || {}); const p = (work.pending_deposits || {})[key];
        if (!p) throw new HttpError(404, "NOT_FOUND");
        if (p.status !== "pending") throw new HttpError(409, "ALREADY_DECIDED", "Решение по этому депозиту уже принято");
        if (p.reason !== "possible_repeat") throw new HttpError(409, "NOT_REVIEWABLE", "Этот депозит обрабатывается автоматически (ожидает регистрацию или валюту)");
        const t = now(); let opened = false;
        if (b.decision === "count") {
          if (!work.registration || work.registration.verified !== true) throw new HttpError(409, "REGISTRATION_REQUIRED");
          if (!p.currency || !D.CURRENCY_RE.test(p.currency)) throw new HttpError(409, "CURRENCY_REQUIRED");
          D.countDeposit(work, { ...p, uid: p.uid || work.registration.uid || null });
          work.pending_deposits[key] = { ...p, status: "counted", reviewed_by: actor.uid, review_reason: reason, reviewed_at: t };
          opened = D.grantAccessIfReached(work, t, key);
        } else work.pending_deposits[key] = { ...p, status: "rejected", reject_reason: "admin", reviewed_by: actor.uid, review_reason: reason, reviewed_at: t };
        tx.set(ref, { academy: work }, { merge: true });
        tx.set(col("deposit_events").doc(key), { status: b.decision === "count" ? "counted" : "rejected_admin", counted_in_totals: b.decision === "count", reviewed_by: actor.uid, review_reason: reason, reviewed_at: t }, { merge: true });
        return { access_opened: opened, usd_cents: work.deposit_totals && work.deposit_totals.USD ? work.deposit_totals.USD.sum_cents : 0 };
      });
      await audit(actor, "deposit.review", "deposit", key, { trader, decision: b.decision, reason });
      const bind = await get("trader_bindings", trader);                       // пересчёт приглашения (начисление $10 — один раз)
      if (bind && bind.uid) { try { await require("./referral").createReferral({ db, now }).evaluateInvitee(bind.uid); } catch (e) { log.error && log.error("review: referral", e && (e.code || e.message)); } }
      return { ok: true, ...r };
    },
    async setRole(req, actor) {
      const target = await get("users", req.params.uid); if (!target) throw new HttpError(404, "NOT_FOUND");
      if (target.id === actor.uid) throw new HttpError(403, "SELF_ROLE", "Нельзя менять собственную роль");
      const role = req.body && req.body.role;
      if (!R.canAssign(actor.role, R.roleOf(target), role)) throw new HttpError(403, "FORBIDDEN", "Можно назначать только роли ниже своей и только пользователям с ролью ниже своей");
      await col("users").doc(target.id).set({ role, role_updated_at: now(), role_updated_by: actor.uid }, { merge: true });
      await audit(actor, "user.role", "user", target.id, { from: R.roleOf(target), to: role });
      return { ok: true, role };
    },
    /* Данные блокировки для раздела «Блокировка аккаунтов» (только для прав users.block) */
    async banInfo(req) {
      const u = await get("users", req.params.uid); if (!u) throw new HttpError(404, "NOT_FOUND");
      return { uid: u.id, blocked: u.blocked === true, blocked_at: u.blocked_at || null, blocked_by: u.blocked_by || null, blocked_by_email: u.blocked_by_email || null, blocked_reason: u.blocked_reason || null, unblocked_at: u.unblocked_at || null };
    },
    async setBlocked(req, actor) {
      const target = await get("users", req.params.uid); if (!target) throw new HttpError(404, "NOT_FOUND");
      if (target.id === actor.uid) throw new HttpError(403, "SELF_BLOCK", "Нельзя заблокировать себя");
      if (R.RANK[R.roleOf(target)] >= R.RANK[actor.role]) throw new HttpError(403, "FORBIDDEN", "Нельзя блокировать пользователя с равной или более высокой ролью");
      const blocked = !!(req.body && req.body.blocked === true);
      // Администраторов (и выше) обычной блокировкой не блокируем — сначала снимите роль
      if (blocked && R.RANK[R.roleOf(target)] >= R.RANK.admin) throw new HttpError(403, "STAFF_PROTECTED", "Администратора нельзя заблокировать этой функцией — сначала измените его роль");
      const reason = String((req.body && req.body.reason) || "").trim().slice(0, 300);
      if (blocked && !reason) throw new HttpError(400, "REASON_REQUIRED", "Укажите причину блокировки (для аудита)");
      // Идемпотентно: статус уже такой — ничего не меняем и не пишем повторно в журнал
      if (!!target.blocked === blocked) return { ok: true, blocked, unchanged: true };
      const t = now();
      const actorEmail = actor.email || ((await get("users", actor.uid)) || {}).email || null;   // email администратора — из токена или профиля
      await col("users").doc(target.id).set(blocked
        ? { blocked: true, blocked_at: t, blocked_reason: reason, blocked_by: actor.uid, blocked_by_email: actorEmail }
        : { blocked: false, unblocked_at: t, unblocked_by: actor.uid, blocked_at: null, blocked_reason: null, blocked_by: null, blocked_by_email: null }, { merge: true });
      // Блокировка — статус АКАДЕМИИ (проверяется сервером при каждом запросе); вход в Firebase не отключаем, чтобы пользователь
      // увидел страницу «аккаунт не активен». При разблокировке включаем вход, если раньше он был отключён старой версией.
      if (!blocked && authAdmin) { try { await authAdmin.updateUser(target.id, { disabled: false }); } catch (e) { log.warn && log.warn("unblock: Firebase Auth:", e && e.code); } }
      await audit(actor, blocked ? "user.block" : "user.unblock", "user", target.id, { reason: blocked ? reason : null });
      return { ok: true, blocked };
    },
    async courses() {
      const [cs, pubs] = await Promise.all([all("courses"), all("published_courses")]);
      const pub = Object.fromEntries(pubs.map(p => [p.id, p]));
      return { courses: cs.sort((a, b) => b.updated_at - a.updated_at).map(c => ({ id: c.id, title: c.title, level: c.level, status: pub[c.id] ? "published" : "draft", updated_at: c.updated_at, published_at: pub[c.id] ? pub[c.id].published_at : null, cover_media_id: c.cover_media_id || null })) };
    },
    async createCourse(req, actor) {
      const c = C.course(req.body); const id = newId("crs"), t = now();
      await col("courses").doc(id).set({ ...c, status: "draft", created_at: t, updated_at: t, created_by: actor.uid });
      await audit(actor, "course.create", "course", id, { title: c.title });
      return { id };
    },
    async course(req) { return courseFull(req.params.id); },
    async updateCourse(req, actor) {
      const c0 = await get("courses", req.params.id); if (!c0) throw new HttpError(404, "NOT_FOUND");
      const c = C.course(req.body);
      await col("courses").doc(c0.id).set({ ...c, updated_at: now() }, { merge: true });
      await audit(actor, "course.update", "course", c0.id, { title: c.title });
      return { ok: true };
    },
    async duplicateCourse(req, actor) {
      const full = await courseFull(req.params.id);
      const lessons = await lessonsOf(req.params.id);
      const data = { course: { ...full.course, title: full.course.title + " (копия)", slug: "" }, modules: full.modules.map(m => ({ ...m, lessons: m.lessons.map(ls => lessons.find(x => x.id === ls.id)) })) };
      const r = await importCourse(actor, data);
      await audit(actor, "course.duplicate", "course", r.course_id, { from: req.params.id });
      return r;
    },
    async deleteCourse(req, actor) {
      if (!req.body || req.body.confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED");
      const c = await get("courses", req.params.id); if (!c) throw new HttpError(404, "NOT_FOUND");
      if (await get("published_courses", c.id)) throw new HttpError(409, "PUBLISHED", "Сначала снимите курс с публикации");
      const [mods, less] = await Promise.all([modulesOf(c.id), lessonsOf(c.id)]);
      await db.runTransaction(async tx => { for (const l of less) tx.delete(col("course_lessons").doc(l.id)); for (const m of mods) tx.delete(col("course_modules").doc(m.id)); tx.delete(col("courses").doc(c.id)); });
      await audit(actor, "course.delete", "course", c.id, { title: c.title, modules: mods.length, lessons: less.length });
      return { ok: true };
    },
    async publishCourse(req, actor) { return publishCourse(actor, req.params.id, req.body); },
    async unpublishCourse(req, actor) { return unpublishCourse(actor, req.params.id, req.body); },
    async createModule(req, actor) {
      const c = await get("courses", req.params.id); if (!c) throw new HttpError(404, "NOT_FOUND");
      const m = C.moduleDoc(req.body); const mods = await modulesOf(c.id); const id = newId("mod"), t = now();
      await col("course_modules").doc(id).set({ ...m, course_id: c.id, order: (mods.reduce((x, y) => Math.max(x, y.order || 0), 0)) + 10, created_at: t, updated_at: t });
      await col("courses").doc(c.id).set({ updated_at: t }, { merge: true });
      await audit(actor, "module.create", "module", id, { course_id: c.id, title: m.title });
      return { id };
    },
    async updateModule(req, actor) {
      const m0 = await get("course_modules", req.params.id); if (!m0) throw new HttpError(404, "NOT_FOUND");
      const m = C.moduleDoc(req.body);
      await col("course_modules").doc(m0.id).set({ ...m, updated_at: now() }, { merge: true });
      await audit(actor, "module.update", "module", m0.id, { title: m.title });
      return { ok: true };
    },
    async deleteModule(req, actor) {
      const m = await get("course_modules", req.params.id); if (!m) throw new HttpError(404, "NOT_FOUND");
      const less = (await lessonsOf(m.course_id)).filter(l => l.module_id === m.id);
      if (less.length) throw new HttpError(409, "NOT_EMPTY", "В модуле есть уроки — удалите или перенесите их");
      await col("course_modules").doc(m.id).delete();
      await audit(actor, "module.delete", "module", m.id, { title: m.title });
      return { ok: true };
    },
    async reorder(req, actor) {
      const id = req.params.id, body = req.body || {};
      const [mods, less] = await Promise.all([modulesOf(id), lessonsOf(id)]);
      const modIds = new Set(mods.map(m => m.id)), lesIds = new Set(less.map(l => l.id));
      const order = Array.isArray(body.modules) ? body.modules : [];
      if (order.some(x => !modIds.has(x))) throw new HttpError(400, "INVALID", "чужой модуль");
      const lmap = body.lessons && typeof body.lessons === "object" ? body.lessons : {};
      const t = now();
      await db.runTransaction(async tx => {
        order.forEach((mid, i) => tx.set(col("course_modules").doc(mid), { order: (i + 1) * 10, updated_at: t }, { merge: true }));
        for (const [mid, list] of Object.entries(lmap)) {
          if (!modIds.has(mid) || !Array.isArray(list)) throw new HttpError(400, "INVALID", "чужой модуль");
          list.forEach((lid, i) => { if (!lesIds.has(lid)) throw new HttpError(400, "INVALID", "чужой урок"); tx.set(col("course_lessons").doc(lid), { module_id: mid, order: (i + 1) * 10, updated_at: t }, { merge: true }); });
        }
      });
      await audit(actor, "course.reorder", "course", id, {});
      return { ok: true };
    },
    async createLesson(req, actor) {
      const m = await get("course_modules", req.params.id); if (!m) throw new HttpError(404, "NOT_FOUND");
      const l = C.lesson({ blocks: [], ...req.body }); const less = (await lessonsOf(m.course_id)).filter(x => x.module_id === m.id);
      const id = newId("les"), t = now();
      await col("course_lessons").doc(id).set({ ...l, course_id: m.course_id, module_id: m.id, order: less.reduce((x, y) => Math.max(x, y.order || 0), 0) + 10, created_at: t, updated_at: t });
      await audit(actor, "lesson.create", "lesson", id, { title: l.title });
      return { id };
    },
    async lesson(req) { const l = await get("course_lessons", req.params.id); if (!l) throw new HttpError(404, "NOT_FOUND"); return { lesson: C.forClient(l) }; },
    async updateLesson(req, actor) {
      const l0 = await get("course_lessons", req.params.id); if (!l0) throw new HttpError(404, "NOT_FOUND");
      const l = C.lesson(req.body);
      // Полная замена документа: удалённые блоки не должны «оживать» при слиянии
      // Переводы не приходят из редактора — сохраняем существующие (устаревшие строки отсекает отпечаток оригинала)
      const keepTr = l.tr !== undefined ? {} : (l0.tr ? { tr: l0.tr } : {});
      await col("course_lessons").doc(l0.id).set({ ...l, ...keepTr, course_id: l0.course_id, module_id: l0.module_id, order: l0.order, created_at: l0.created_at || now(), updated_at: now() });
      await audit(actor, "lesson.update", "lesson", l0.id, { title: l.title, status: l.status, blocks: l.blocks.length });
      return { ok: true };
    },
    async duplicateLesson(req, actor) {
      const l0 = await get("course_lessons", req.params.id); if (!l0) throw new HttpError(404, "NOT_FOUND");
      const id = newId("les"), t = now(); const { id: _, ...rest } = l0;
      await col("course_lessons").doc(id).set({ ...rest, title: l0.title + " (копия)", status: "draft", order: (l0.order || 0) + 1, created_at: t, updated_at: t });
      await audit(actor, "lesson.duplicate", "lesson", id, { from: l0.id });
      return { id };
    },
    async deleteLesson(req, actor) {
      if (!req.body || req.body.confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED");
      const l = await get("course_lessons", req.params.id); if (!l) throw new HttpError(404, "NOT_FOUND");
      if (await get("published_lessons", l.id)) throw new HttpError(409, "PUBLISHED", "Урок опубликован — опубликуйте курс заново без него или снимите курс с публикации");
      await col("course_lessons").doc(l.id).delete();
      await audit(actor, "lesson.delete", "lesson", l.id, { title: l.title });
      return { ok: true };
    },
    async media(req) {
      const q = req.query || {}, s = String(q.q || "").toLowerCase();
      let list = (await all("media")).filter(m => !m.deleted);
      if (q.kind) list = list.filter(m => m.kind === q.kind || m.category === q.kind);
      if (s) list = list.filter(m => (m.name || "").toLowerCase().includes(s));
      return { media: list.sort((a, b) => b.created_at - a.created_at).map(m => ({ id: m.id, name: m.name, kind: m.kind, category: m.category, content_type: m.content_type, size: m.size, created_at: m.created_at, url: "/media/" + m.id })), storage: !!(storage && storage.available) };
    },
    async upload(req, actor) {
      if (!storage || !storage.available) throw new HttpError(503, "STORAGE_UNAVAILABLE", "Хранилище файлов (Firebase Storage) не настроено");
      if (limited("upload:" + actor.uid, 30, 60000)) throw new HttpError(429, "TOO_MANY");
      const buf = Buffer.isBuffer(req.body) ? req.body : null;
      const ct = (req.headers["content-type"] || "").toLowerCase();
      const chk = checkUpload(ct, buf);
      if (chk.error) throw new HttpError(400, chk.error, chk.message);
      let name = ""; try { name = decodeURIComponent(String(req.headers["x-file-name"] || "")).slice(0, 120); } catch (e) {}
      name = name.replace(/[^\p{L}\p{N} ._()-]/gu, "_") || "file";
      const category = ["cover", "poster", "chart", "brand", "lesson", "pdf", "other"].includes(req.headers["x-media-category"]) ? req.headers["x-media-category"] : (chk.kind === "pdf" ? "pdf" : "other");
      const id = newId("med"), path = `academy-media/${id}`;
      try { await storage.save(path, buf, ct.split(";")[0]); }
      catch (e) {   // запись в Firestore не создаётся: битых медиа-записей не будет
        const d = describeStorageError(e, storage.bucketName);
        log.error && log.error("media upload: storage error", d.code, String((e && e.message) || "").slice(0, 200));
        throw new HttpError(503, "STORAGE_ERROR", d.hint, { storage_code: d.code });
      }
      await col("media").doc(id).set({ name, kind: chk.kind, category, content_type: ct.split(";")[0], size: buf.length, storage_path: path, created_at: now(), created_by: actor.uid });
      await audit(actor, "media.upload", "media", id, { name, size: buf.length });
      return { id, url: "/media/" + id };
    },
    async renameMedia(req, actor) {
      const m = await get("media", req.params.id); if (!m || m.deleted) throw new HttpError(404, "NOT_FOUND");
      const name = String((req.body && req.body.name) || "").trim().slice(0, 120); if (!name) throw new HttpError(400, "INVALID", "пустое название");
      await col("media").doc(m.id).set({ name }, { merge: true });
      await audit(actor, "media.rename", "media", m.id, { name });
      return { ok: true };
    },
    async deleteMedia(req, actor) {
      const m = await get("media", req.params.id); if (!m || m.deleted) throw new HttpError(404, "NOT_FOUND");
      const used = await mediaUsage(m.id);
      for (const p of await all("published_lessons")) if (C.mediaRefs(p).has(m.id)) used.push({ type: "published_lesson", id: p.id, title: p.title });
      if (used.length) throw new HttpError(409, "IN_USE", "Файл используется", { used });
      if (storage && storage.available) await storage.remove(m.storage_path);
      await col("media").doc(m.id).set({ deleted: true, deleted_at: now() }, { merge: true });
      await audit(actor, "media.delete", "media", m.id, { name: m.name });
      return { ok: true };
    },
    async announcements(req, actor) {
      // Стандартные карточки (INVITE & EARN, книга) — создаются один раз как записи CMS, если их ещё нет
      for (const d of C.SYSTEM_BANNERS) {
        const created = await db.runTransaction(async tx => { const ref = col("announcements").doc(d.id); const s = await tx.get(ref); if (s.exists) return false;
          const t = now(); tx.create(ref, { ...d, status: "published", audience: "all", priority: 0, body: "", image_media_id: "", event_at: null, cta_label: "", cta_url: "", show_from: null, show_until: null, release_at: null, created_at: t, updated_at: t, created_by: "system" }); return true; });
        if (created) await audit(actor, "announcement.seed_system", "announcement", d.id, { title: d.title });
      }
      return { announcements: (await all("announcements")).map(C.withSystemDefaults).sort((x, y) => (x.kind === "banner") - (y.kind === "banner") || C.bannerSort(x, y) || ((y.updated_at || 0) - (x.updated_at || 0))) };
    },
    async createAnnouncement(req, actor) {
      const a = C.announcement(req.body);   // каждый раз новый документ с новым ID — старые записи не трогаются
      if (a.status === "published" && !R.can(actor.role, "announcements.publish")) throw new HttpError(403, "FORBIDDEN", "Публиковать афиши может администратор");
      if (a.status === "published" && !(req.body && req.body.confirm === true)) throw new HttpError(400, "CONFIRM_REQUIRED");
      const id = newId("ann"), t = now();
      await col("announcements").doc(id).set({ ...a, created_at: t, updated_at: t, created_by: actor.uid });
      await audit(actor, "announcement.create", "announcement", id, { title: a.title, status: a.status });
      return { id };
    },
    async updateAnnouncement(req, actor) {
      const a0 = await get("announcements", req.params.id); if (!a0) throw new HttpError(404, "NOT_FOUND");
      const a = C.announcement(req.body);
      if (String(req.params.id).startsWith("sys_")) a.customized = true;   // стандартная карточка изменена администратором — код её больше не подменяет
      if (a.status === "published" && a0.status !== "published") {
        if (!R.can(actor.role, "announcements.publish")) throw new HttpError(403, "FORBIDDEN", "Публиковать афиши может администратор");
        if (!(req.body && req.body.confirm === true)) throw new HttpError(400, "CONFIRM_REQUIRED");
      }
      await col("announcements").doc(a0.id).set({ ...a, updated_at: now() }, { merge: true });
      await audit(actor, "announcement.update", "announcement", a0.id, { title: a.title, status: a.status });
      return { ok: true };
    },
    async deleteAnnouncement(req, actor) {
      const a = await get("announcements", req.params.id); if (!a) throw new HttpError(404, "NOT_FOUND");
      await col("announcements").doc(a.id).delete();
      await audit(actor, "announcement.delete", "announcement", a.id, { title: a.title });
      return { ok: true };
    },
    /* Отметить все уроки курса «Готов к публикации» (сами уроки не публикуются — это делает «Опубликовать») */
    async readyAll(req, actor) {
      if (!req.body || req.body.confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED", "Нужно явное подтверждение");
      const c = await get("courses", req.params.id); if (!c) throw new HttpError(404, "NOT_FOUND");
      const ls = await lessonsOf(c.id), todo = ls.filter(l => l.status !== "ready");
      const empty = ls.filter(l => !Array.isArray(l.blocks) || !l.blocks.length);
      if (empty.length) throw new HttpError(409, "EMPTY_LESSONS", "В курсе есть уроки без содержания — заполните или удалите их: " + empty.map(l => l.title).slice(0, 5).join(", "));
      const t = now();
      await db.runTransaction(async tx => { for (const l of todo) tx.set(col("course_lessons").doc(l.id), { status: "ready", updated_at: t }, { merge: true }); });
      await audit(actor, "course.ready_all", "course", c.id, { lessons: todo.length });
      return { ok: true, marked: todo.length, total: ls.length };
    },
    /* Диагностика для Super Admin: какая версия кода работает и что реально лежит в Firestore (только чтение) */
    async diagnostics(req) {
      const [courses, mods, less, pubC, pubL] = await Promise.all(["courses", "course_modules", "course_lessons", "published_courses", "published_lessons"].map(c => all(c)));
      const storageCheck = storage && storage.check ? await storage.check() : { ok: false, code: "NOT_CONFIGURED", hint: "Firebase Storage не подключён" };
      const refCfg = require("./referral").configOf(process.env);
      return { storage: storageCheck, referral: refCfg, site: require("./app-url").appBaseUrl(process.env), request_ip: req ? (() => { const c = require("./forgot-password").clientIp(req); const n = String((req.headers || {})["x-forwarded-for"] || "").split(",").filter(x => x.trim()).length;
        const chain = String((req.headers || {})["x-forwarded-for"] || "").split(",").map(x => x.trim()).filter(Boolean);
        // Только собственный запрос администратора (право diagnostics.view): по цепочке видно, сколько прокси стоит справа от вашего IP.
        return { trust_proxy: req.app && req.app.get ? req.app.get("trust proxy") : null, xff_entries: n, xff_chain: chain.slice(0, 10),
          socket_ip: String((req.socket && req.socket.remoteAddress) || "").replace(/^::ffff:/, ""), ip_seen_by_server: c.ip, ip_limit_active: c.trusted,
          how_to_choose: "Найдите в xff_chain свой настоящий IP. TRUST_PROXY = 1 + число адресов СПРАВА от него. Ваш IP последний → TRUST_PROXY=1." }; })() : null, mail: (() => { const m = require("./mailer").createMailer(process.env); return { configured: m.configured, provider: m.provider, from: m.from, missing: m.missing }; })(), 
        version: { commit: process.env.RENDER_GIT_COMMIT || null, branch: process.env.RENDER_GIT_BRANCH || null, service: process.env.RENDER_SERVICE_NAME || null,
          package: (() => { try { return require("../package.json").version; } catch (e) { return null; } })(), node: process.version, started_at: STARTED_AT,
          content_format: C.CONTENT_FORMAT },
        translations: pubC.map(pc => {                      // полнота перевода опубликованного курса (то, что видят ученики)
          const ls = pubL.filter(l => l.course_id === pc.id), out = { course_id: pc.id, title: pc.title, lessons: ls.length };
          for (const lang of C.TR_LANGS) {
            let complete = 0, missing = 0, none = 0;
            for (const l of ls) { const st = C.localize(C.withTr(l, "lesson"), lang).status; if (st.none) none++; else if (st.complete) complete++; else missing += st.missing; }
            out[lang] = { complete, missing_strings: missing, without_translation: none };
          }
          return out;
        }),
        courses: courses.map(c => {
          const ms = mods.filter(m => m.course_id === c.id).sort((a, b) => (a.order || 0) - (b.order || 0)), ls = less.filter(l => l.course_id === c.id);
          const pub = pubC.find(p => p.id === c.id);
          return { id: c.id, title: c.title, status: c.status || null, slug: c.slug || null, imported: !!c.imported, created_at: c.created_at || null,
            modules: ms.map(m => ({ id: m.id, title: m.title, lessons: ls.filter(l => l.module_id === m.id).length, ready: ls.filter(l => l.module_id === m.id && l.status === "ready").length })),
            lessons_total: ls.length, orphan_lessons: ls.filter(l => !ms.some(m => m.id === l.module_id)).length,
            published: pub ? { version: pub.version || null, lessons: pubL.filter(l => l.course_id === c.id).length } : null };
        }),
        modules_without_course: mods.filter(m => !courses.some(c => c.id === m.course_id)).length,
        lessons_without_course: less.filter(l => !courses.some(c => c.id === l.course_id)).length
      };
    },
    async auditLog(req) {
      const q = req.query || {}; let list = await all("audit_logs");
      if (q.action) list = list.filter(l => String(l.action).startsWith(q.action));
      return { logs: list.sort((a, b) => b.at - a.at).slice(0, Math.min(Number(q.limit) || 200, 500)) };
    },
    /* Обновить переводы существующего курса (без повторного импорта): совпадение по slug, модули и уроки — по порядку
       с проверкой русских названий. Меняется только поле tr; содержание, ID, прогресс и ответы не трогаются. */
    async importTranslations(req, actor) {
      if (!req.body || req.body.confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED");
      const data = req.body.data;
      if (!data || !data.course || !Array.isArray(data.modules)) throw new HttpError(400, "INVALID", "Нужен JSON курса с переводами");
      const slug = String(data.course.slug || "");
      const found = slug ? (await col("courses").where("slug", "==", slug).get()).docs : [];
      if (!found.length) throw new HttpError(404, "COURSE_NOT_FOUND", "Курс с таким slug не найден — сначала импортируйте курс");
      const full = await courseFull(found[0].id);
      const res = { course_id: found[0].id, modules: 0, lessons: 0, skipped: [] };
      const t = now(), writes = [];
      if (data.course.tr) writes.push([col("courses").doc(found[0].id), { tr: C.course({ ...data.course, title: data.course.title || "x" }).tr, updated_at: t }]);
      data.modules.forEach((m, mi) => {
        const dm = full.modules[mi];
        if (!dm || dm.title !== m.title) { res.skipped.push(`модуль ${mi + 1}: «${String(m.title).slice(0, 60)}» не совпадает`); return; }
        if (m.tr) { writes.push([col("course_modules").doc(dm.id), { tr: C.moduleDoc(m).tr, updated_at: t }]); res.modules++; }
        (m.lessons || []).forEach((l, li) => {
          const dl = dm.lessons[li];
          if (!dl || dl.title !== l.title) { res.skipped.push(`урок ${mi + 1}.${li + 1}: «${String(l.title).slice(0, 60)}» не совпадает`); return; }
          if (l.tr) { writes.push([col("course_lessons").doc(dl.id), { tr: C.lesson(l).tr, updated_at: t }]); res.lessons++; }
        });
      });
      for (let i = 0; i < writes.length; i += 400) { const b = writes.slice(i, i + 400); await db.runTransaction(async tx => { for (const [ref, v] of b) tx.set(ref, v, { merge: true }); }); }
      await audit(actor, "course.translations", "course", found[0].id, { modules: res.modules, lessons: res.lessons, skipped: res.skipped.length });
      return { ok: true, ...res, note: "Переводы сохранены в черновике. Опубликуйте курс заново, чтобы ученики их увидели." };
    },
    async importCourse(req, actor) { if (!req.body || req.body.confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED"); return importCourse(actor, req.body.data); }
  };

  // Таблица маршрутов: [метод, путь, обработчик, право, изменяет данные]
  const ROUTES = [
    ["GET", "/me", "me", "admin.enter"], ["GET", "/dashboard", "dashboard", "dashboard.view"],
    ["GET", "/users", "users", "users.view"], ["GET", "/users/:uid", "user", "users.view"], ["POST", "/deposits/:trader/:key/review", "reviewDeposit", "finance.payouts", true],
    ["POST", "/users/:uid/role", "setRole", "users.role", true], ["POST", "/users/:uid/block", "setBlocked", "users.block", true], ["GET", "/users/:uid/ban", "banInfo", "users.block"],
    ["GET", "/courses", "courses", "content.edit"], ["POST", "/courses", "createCourse", "content.edit", true],
    ["GET", "/courses/:id", "course", "content.edit"], ["PUT", "/courses/:id", "updateCourse", "content.edit", true],
    ["POST", "/courses/:id/duplicate", "duplicateCourse", "content.edit", true], ["POST", "/courses/:id/delete", "deleteCourse", "content.delete", true],
    ["POST", "/courses/:id/publish", "publishCourse", "content.publish", true], ["POST", "/courses/:id/unpublish", "unpublishCourse", "content.publish", true],
    ["POST", "/courses/:id/modules", "createModule", "content.edit", true], ["POST", "/courses/:id/reorder", "reorder", "content.edit", true],
    ["PUT", "/modules/:id", "updateModule", "content.edit", true], ["POST", "/modules/:id/delete", "deleteModule", "content.delete", true],
    ["POST", "/modules/:id/lessons", "createLesson", "content.edit", true],
    ["GET", "/lessons/:id", "lesson", "content.edit"], ["PUT", "/lessons/:id", "updateLesson", "content.edit", true],
    ["POST", "/lessons/:id/duplicate", "duplicateLesson", "content.edit", true], ["POST", "/lessons/:id/delete", "deleteLesson", "content.delete", true],
    ["GET", "/media", "media", "content.edit"], ["POST", "/media", "upload", "content.edit", true],
    ["PUT", "/media/:id", "renameMedia", "content.edit", true], ["POST", "/media/:id/delete", "deleteMedia", "content.delete", true],
    ["GET", "/announcements", "announcements", "announcements.edit"], ["POST", "/announcements", "createAnnouncement", "announcements.edit", true],
    ["PUT", "/announcements/:id", "updateAnnouncement", "announcements.edit", true], ["POST", "/announcements/:id/delete", "deleteAnnouncement", "announcements.publish", true],
    ["GET", "/knowledge", "knowledgeList", "content.edit"], ["GET", "/knowledge/diagnostics", "knowledgeDiagnostics", "content.edit"], ["GET", "/knowledge/export", "knowledgeExport", "content.edit"],
    ["POST", "/knowledge", "knowledgeCreate", "content.edit", true], ["POST", "/knowledge/import", "knowledgeImport", "import.course", true],
    ["GET", "/knowledge/:id", "knowledgeGet", "content.edit"], ["PUT", "/knowledge/:id", "knowledgeUpdate", "content.edit", true],
    ["GET", "/knowledge/:id/versions", "knowledgeVersions", "content.edit"], ["POST", "/knowledge/:id/publish", "knowledgePublish", "content.publish", true],
    ["POST", "/knowledge/:id/restore", "knowledgeRestore", "content.edit", true], ["POST", "/knowledge/:id/delete", "knowledgeDelete", "content.delete", true],
    ["GET", "/knowledge-v2/status", "kv2Status", "content.edit"], ["POST", "/knowledge-v2/dry-run", "kv2DryRun", "content.edit"], ["GET", "/knowledge-v2/search", "kv2Search", "content.edit"],
    ["GET", "/knowledge-v2/backup", "kv2Backup", "content.edit"], ["POST", "/knowledge-v2/import", "kv2Import", "import.course", true], ["POST", "/knowledge-v2/verify", "kv2Verify", "import.course", true],
    ["POST", "/knowledge-v2/activate", "kv2Activate", "import.course", true], ["POST", "/knowledge-v2/reindex", "kv2Reindex", "import.course", true],
    ["GET", "/ai-budget/status", "budgetStatus", "mentor.manage"], ["PUT", "/ai-budget/settings", "budgetSettings", "mentor.manage", true],
    ["GET", "/mentor/status", "mentorStatus", "mentor.manage"], ["POST", "/mentor/test-connection", "mentorTestConnection", "mentor.manage", true], ["PUT", "/mentor/settings", "mentorSettings", "mentor.manage", true],
    ["GET", "/chart/scenarios", "chartList", "chart.manage"], ["POST", "/chart/scenarios/:id/status", "chartStatus", "chart.manage", true],
    ["POST", "/chart/import", "chartImport", "chart.manage", true], ["GET", "/chart/scenarios/:id", "chartPreview", "chart.manage"],
    ["GET", "/daily/generator", "dailyGenStatus", "daily.manage"], ["PUT", "/daily/generator/settings", "dailyGenSettings", "daily.manage", true], ["POST", "/daily/generator/run", "dailyGenRun", "daily.manage", true],
    ["GET", "/daily/status", "dailyStatus", "daily.manage"], ["PUT", "/daily/config", "dailyConfig", "daily.manage", true], ["POST", "/daily/bank/import", "dailyImport", "daily.manage", true],
    ["POST", "/daily/run", "dailyRun", "daily.manage", true], ["GET", "/daily/bank", "dailyBank", "daily.manage"], ["GET", "/daily/analytics", "dailyAnalytics", "daily.manage"], ["POST", "/daily/bank", "dailyBankCreate", "daily.manage", true], ["PUT", "/daily/bank/:id", "dailyBankUpdate", "daily.manage", true],
    ["GET", "/daily/sets", "dailySets", "daily.manage"], ["GET", "/daily/sets/:date", "dailySet", "daily.manage"],
    ["GET", "/features", "featuresList", "features.manage"], ["POST", "/features", "featureCreate", "features.manage", true],
    ["POST", "/features/order", "featureOrder", "features.manage", true], ["POST", "/features/reset", "featuresReset", "features.manage", true],
    ["PUT", "/features/:id", "featureUpdate", "features.manage", true], ["POST", "/features/:id/status", "featureStatus", "features.manage", true],
    ["POST", "/features/:id/delete", "featureDelete", "features.manage", true],
    ["GET", "/audit", "auditLog", "audit.view"], ["GET", "/diagnostics", "diagnostics", "diagnostics.view"], ["POST", "/courses/:id/ready-all", "readyAll", "content.publish", true], ["POST", "/import/course", "importCourse", "import.course", true], ["POST", "/import/translations", "importTranslations", "import.course", true]
  ];

  function handler(name, perm, mutating) {
    return async (req, res) => {
      try {
        const actor = await authenticate(req, perm);
        if (mutating && limited("w:" + actor.uid, 120, 60000)) throw new HttpError(429, "TOO_MANY");
        const out = await H[name](req, actor);
        res.set && res.set("Cache-Control", "no-store");
        res.status(200).json(out);
      } catch (e) {
        if (e instanceof HttpError) return res.status(e.status).json({ error: e.code, message: e.message, ...(e.extra || {}) });
        if (e instanceof C.ValidationError) return res.status(400).json({ error: "INVALID", message: e.message, field: e.field });
        if (e && Number.isInteger(e.status) && e.code) return res.status(e.status).json({ error: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) });
        // Какой обработчик и с каким сообщением упал — без секретов и персональных данных
        log.error && log.error("admin api error:", name, e && e.code, String((e && e.message) || "").slice(0, 200));
        res.status(503).json({ error: "UNAVAILABLE", message: "Временная ошибка сервера" });
      }
    };
  }
  // Партнёры и финансовый журнал (academy/referral.js): общие права, аудит и обработчик ошибок
  const PA = require("./referral").partnerAdmin({ db, now, HttpError, audit });
  Object.assign(H, PA.handlers); ROUTES.push(...PA.routes.filter(r => !ROUTES.some(x => x[0] === r[0] && x[1] === r[1])));
  const PL = require("./partner-links").partnerLinksAdmin({ db, now, HttpError, audit });
  Object.assign(H, PL.handlers); ROUTES.push(...PL.routes.filter(r => !ROUTES.some(x => x[0] === r[0] && x[1] === r[1])));
  return { ROUTES, handler, H, authenticate, audit };
}

function mountAdminApi(app, express, deps) {
  const api = createAdminApi(deps);
  const router = express.Router();
  router.post("/media", express.raw({ type: () => true, limit: "21mb" }));
  // Свой тип JSON: общий express.json() в server.js (лимит 100 КБ) его не разбирает, поэтому крупные уроки
  // и импорт курса (~220 КБ) доходят до этого разборщика с лимитом 3 МБ. Обычный application/json тоже принимается.
  router.use(express.json({ limit: "3mb", type: ["application/json", "application/vnd.hd+json"] }));
  for (const [m, p, name, perm, mut] of api.ROUTES) router[m.toLowerCase()](p, api.handler(name, perm, mut));
  router.use((req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  app.use("/admin/api", router);
  return api;
}

module.exports = { createAdminApi, mountAdminApi, HttpError };
