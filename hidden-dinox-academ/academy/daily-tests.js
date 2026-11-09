"use strict";
/* Daily Tests: ежедневный набор из проверенного банка вопросов (без ИИ).
   • Дата набора — календарная дата Europe/Berlin (dateKey "YYYY-MM-DD"); новый набор виден с 00:00 по Берлину.
   • Набор готовится заранее (на сегодня и завтра) защищённым запуском по расписанию (GitHub Actions → POST /internal/daily/run);
     страховка — при первом запросе ученика, если набора на сегодня нет. Всё идемпотентно: daily_sets/{dateKey} создаётся
     в транзакции один раз; повторный запуск ничего не меняет.
   • Только одобренные (approved) вопросы банка; если по курсу не хватает — набор НЕ публикуется, администратор получает тревогу.
   • Правильные ответы — в daily_keys/{dateKey}, ученику только после ответа. Попытка daily_attempts/{uid}__{date}__{qid} — один раз. */
const crypto = require("crypto");
const TZ = "Europe/Berlin";
const COURSES = ["hr", "smc", "rm"];
const DEFAULT_CONFIG = { mix: { hr: 2, smc: 2, rm: 1 }, reuse_after_days: 0, low_stock_days: 7 };

/* ---------- Время по Берлину ---------- */
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function parts(ms) { const o = {}; for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value; return o; }
function berlinDateKey(ms) { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; }
const addDays = (key, n) => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
/* UTC-момент 00:00 по Берлину для даты key (переходы CET/CEST в 02:00/03:00 — полночь всегда одна) */
function berlinMidnight(key) {
  const [y, m, d] = key.split("-").map(Number); let t = Date.UTC(y, m - 1, d) - 3600e3;   // приблизительно (UTC+1)
  for (let i = 0; i < 3; i++) { const p = parts(t); const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second); t += Date.UTC(y, m - 1, d) - wall; }
  return t;
}
const nextReset = ms => berlinMidnight(addDays(berlinDateKey(ms), 1));
const hashOrder = (seed, id) => crypto.createHash("sha1").update(seed + "|" + id).digest("hex");
const daysBetween = (a, b) => Math.round((Date.UTC(...b.split("-").map((x, i) => i === 1 ? x - 1 : +x)) - Date.UTC(...a.split("-").map((x, i) => i === 1 ? x - 1 : +x))) / 864e5);

function createDailyTests({ db, now = () => Date.now(), log = console }) {
  const col = n => db.collection(n);
  async function config() { const s = await col("daily_settings").doc("config").get(); const c = s.exists ? s.data() : {};
    return { mix: { ...DEFAULT_CONFIG.mix, ...(c.mix || {}) }, reuse_after_days: Number(c.reuse_after_days) || 0, low_stock_days: Number(c.low_stock_days) || DEFAULT_CONFIG.low_stock_days }; }
  async function setConfig(body) {
    const mix = {}, b = body || {};
    for (const c of COURSES) { const n = Number((b.mix || {})[c]); if (!Number.isInteger(n) || n < 0 || n > 5) throw Object.assign(new Error("Количество по курсу: целое 0–5"), { code: "INVALID", status: 400, field: "mix." + c }); mix[c] = n; }
    const total = COURSES.reduce((s, c) => s + mix[c], 0);
    if (total < 1 || total > 10) throw Object.assign(new Error("Всего заданий в день: от 1 до 10"), { code: "INVALID", status: 400, field: "mix" });
    const reuse = Number(b.reuse_after_days || 0);
    if (!Number.isInteger(reuse) || reuse < 0 || reuse > 365) throw Object.assign(new Error("Повтор вопросов: 0 (выключен) или 1–365 дней"), { code: "INVALID", status: 400, field: "reuse_after_days" });
    const cfg = { mix, reuse_after_days: reuse, low_stock_days: DEFAULT_CONFIG.low_stock_days, updated_at: now() };
    await col("daily_settings").doc("config").set(cfg); return cfg;
  }
  async function bankAll() { return (await col("daily_bank").get()).docs.map(d => ({ id: d.id, ...d.data() })); }
  const eligible = (q, key, cfg) => q.status === "approved" && (!q.used_on || (cfg.reuse_after_days > 0 && daysBetween(q.used_on, key) >= cfg.reuse_after_days));

  /* Подготовить набор на дату (идемпотентно). Возвращает { status: "exists" | "created" | "exhausted", date, shortages? } */
  async function ensureSet(key, { source = "manual" } = {}) {
    const setRef = col("daily_sets").doc(key);
    if ((await setRef.get()).exists) return { status: "exists", date: key };
    const cfg = await config(), bank = await bankAll(), picked = [], shortages = {};
    for (const c of COURSES) {
      const need = cfg.mix[c] || 0; if (!need) continue;
      const pool = bank.filter(q => q.course === c && eligible(q, key, cfg))
        .sort((a, b) => (a.used_on ? 1 : 0) - (b.used_on ? 1 : 0) || String(a.used_on || "").localeCompare(String(b.used_on || "")) || hashOrder(key, a.id).localeCompare(hashOrder(key, b.id)));
      // Сначала разнообразим типы вопросов, затем модули; не жертвуем доступностью банка.
      const chosen = [], kinds = new Set(), mods = new Set();
      for (const q of pool) { if (chosen.length >= need) break; if (!mods.has(q.module_index)) { chosen.push(q); mods.add(q.module_index); kinds.add(q.kind || "choice"); } }
      for (const q of pool) { if (chosen.length >= need) break; if (!chosen.includes(q) && !kinds.has(q.kind || "choice")) { chosen.push(q); kinds.add(q.kind || "choice"); mods.add(q.module_index); } }
      for (const q of pool) { if (chosen.length >= need) break; if (!chosen.includes(q)) chosen.push(q); }
      if (chosen.length < need) shortages[c] = { need, available: chosen.length };
      picked.push(...chosen);
    }
    if (Object.keys(shortages).length) {
      await logRun({ date: key, source, status: "exhausted", shortages });
      await col("daily_settings").doc("alerts").set({ bank_exhausted: { date: key, shortages, at: now() } }, { merge: true });
      log.warn && log.warn(`⚠️ Daily Tests ${key}: в банке не хватает одобренных вопросов — набор не опубликован (${JSON.stringify(shortages)})`);
      return { status: "exhausted", date: key, shortages };
    }
    const pub = q => ({ id: q.id, course: q.course, course_slug: q.course_slug, module_index: q.module_index, module_title: q.module_title, lesson_index: q.lesson_index, lesson_title: q.lesson_title, chart_image: q.chart_image || null,
      q: q.q, options: q.options, kind: q.kind || "choice", i18n: Object.fromEntries(Object.entries(q.i18n || {}).map(([l, v]) => [l, { q: v.q, options: v.options, lesson_title: v.lesson_title, module_title: v.module_title }])) });
    const result = await db.runTransaction(async tx => {
      const s = await tx.get(setRef); if (s.exists) return { status: "exists", date: key };
      tx.create(setRef, { date: key, status: "published", version: 1, source: "bank", created_by: source, created_at: now(), mix: cfg.mix, questions: picked.map(pub) });
      tx.set(col("daily_keys").doc(key), { date: key, answers: Object.fromEntries(picked.map(q => [q.id, { correct: q.correct, explanation: q.explanation, i18n: Object.fromEntries(Object.entries(q.i18n || {}).map(([l, v]) => [l, v.explanation])) }])) });
      for (const q of picked) tx.update(col("daily_bank").doc(q.id), { used_on: key, used_count: (q.used_count || 0) + 1 });
      return { status: "created", date: key, questions: picked.length };
    });
    if (result.status === "created") { await logRun({ date: key, source, status: "created", questions: result.questions }); await col("daily_settings").doc("alerts").set({ bank_exhausted: null }, { merge: true }); }
    return result;
  }
  async function logRun(r) { try { await col("daily_runs").doc(`${now()}_${r.date}_${r.source}`).set({ ...r, at: now() }); } catch (e) {} }
  /* Запуск по расписанию / вручную: сегодня и завтра */
  async function run(source) { const today = berlinDateKey(now()); return { today: await ensureSet(today, { source }), tomorrow: await ensureSet(addDays(today, 1), { source }) }; }

  /* ---------- Ученик ---------- */
  const tx3 = (q, lang) => { const t = (q.i18n || {})[lang] || {};
    return { q: t.q || q.q, options: t.q ? t.options : q.options, title: t.lesson_title || q.lesson_title, topic: t.module_title || q.module_title, kind: q.kind || "choice", chart_image: q.chart_image || null }; };
  const attemptId = (uid, date, qid) => `${uid}__${date}__${qid}`;
  async function today(uid, lang) {
    const t = now(), key = berlinDateKey(t);
    let s = await col("daily_sets").doc(key).get();
    if (!s.exists) { const r = await ensureSet(key, { source: "lazy" }); if (r.status !== "exhausted") s = await col("daily_sets").doc(key).get(); }
    const base = { date: key, server_now: t, next_reset_at: nextReset(t), next_date: addDays(key, 1) };
    if (!s.exists) return { ...base, status: "updating", tasks: [] };
    const atts = new Map((await col("daily_attempts").where("uid", "==", uid).where("date", "==", key).get()).docs.map(d => [d.data().qid, d.data()]));
    return { ...base, status: "ok", tasks: s.data().questions.map(q => { const a = atts.get(q.id); const x = tx3(q, lang);
      return { id: q.id, course: q.course, kind: x.kind, title: x.title, topic: x.topic, q: x.q, options: x.options, chart_image: q.chart_image || null, status: a ? a.status : "new", result: a && a.status === "done" ? { ok: a.correct, answer: a.answer } : null }; }) };
  }
  async function setOf(date) { const s = await col("daily_sets").doc(date).get(); return s.exists ? s.data() : null; }
  function bad(msg, code = "INVALID", status = 400) { return Object.assign(new Error(msg), { code, status }); }
  async function checkTask(date, qid) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw bad("Неверная дата");
    if (date > berlinDateKey(now())) throw bad("Набор ещё не открыт", "NOT_YET", 403);
    const set = await setOf(date); if (!set) throw bad("Набор не найден", "NOT_FOUND", 404);
    const q = set.questions.find(x => x.id === qid); if (!q) throw bad("Задание не найдено", "NOT_FOUND", 404);
    return { set, q };
  }
  /* Задание по дате (для незавершённых прошлых дней): без правильного ответа */
  async function task(uid, date, qid, lang) {
    const { q } = await checkTask(date, qid); const x = tx3(q, lang);
    const a = (await col("daily_attempts").doc(attemptId(uid, date, qid)).get()).data();
    return { id: q.id, date, course: q.course, kind: x.kind, title: x.title, topic: x.topic, q: x.q, options: x.options, chart_image: q.chart_image || null, status: a ? a.status : "new" };
  }
  async function start(uid, date, qid) {
    await checkTask(date, qid); const ref = col("daily_attempts").doc(attemptId(uid, date, qid));
    await db.runTransaction(async tx => { const s = await tx.get(ref); if (!s.exists) tx.create(ref, { uid, date, qid, status: "in_progress", started_at: now() }); });
    return { ok: true };
  }
  async function answer(uid, date, qid, ans, lang) {
    const { q } = await checkTask(date, qid);
    if (!Number.isInteger(ans) || ans < 0 || ans >= q.options.length) throw bad("Вариант ответа вне списка");
    const keys = (await col("daily_keys").doc(date).get()).data(), key = keys && keys.answers[qid];
    if (!key) throw bad("Ключ ответа недоступен", "UNAVAILABLE", 503);
    const ref = col("daily_attempts").doc(attemptId(uid, date, qid));
    const saved = await db.runTransaction(async tx => {
      const s = await tx.get(ref), cur = s.exists ? s.data() : null;
      if (cur && cur.status === "done") return cur;                                       // повтор — без изменений
      const t = now(), rec = { uid, date, qid, course: q.course, status: "done", answer: ans, correct: ans === key.correct,
        started_at: (cur && cur.started_at) || t, answered_at: t, time_ms: t - ((cur && cur.started_at) || t), archived: date < berlinDateKey(t) };
      tx.set(ref, rec); return rec;
    });
    return review(q, key, saved, lang);
  }
  function review(q, key, a, lang) {
    const x = tx3(q, lang);
    return { id: q.id, date: a.date, course: q.course, kind: x.kind, q: x.q, options: x.options, chart_image: q.chart_image || null, answer: a.answer, correct: a.correct, correct_index: key.correct,
      explanation: (key.i18n || {})[lang] || key.explanation, time_ms: a.time_ms, answered_at: a.answered_at,
      lesson: { course_slug: q.course_slug, module_index: q.module_index, module_title: x.topic, lesson_index: q.lesson_index, lesson_title: x.title } };
  }
  async function history(uid, lang, limitDays = 60) {
    const todayKey = berlinDateKey(now());
    const atts = (await col("daily_attempts").where("uid", "==", uid).get()).docs.map(d => d.data());
    const sets = (await col("daily_sets").orderBy("date", "desc").limit(limitDays).get()).docs.map(d => d.data()).filter(s => s.date <= todayKey);
    const done = [], unfinished = [];
    for (const s of sets) {
      const keys = (await col("daily_keys").doc(s.date).get()).data() || { answers: {} };
      for (const q of s.questions) {
        const a = atts.find(x => x.date === s.date && x.qid === q.id);
        if (a && a.status === "done") done.push(review(q, keys.answers[q.id] || {}, a, lang));
        else if (s.date < todayKey) { const x = tx3(q, lang); unfinished.push({ date: s.date, id: q.id, course: q.course, kind: x.kind, title: x.title, topic: x.topic, status: a ? a.status : "new" }); }
      }
    }
    done.sort((a, b) => b.answered_at - a.answered_at);
    return { done, unfinished };
  }

  /* ---------- Администратор ---------- */
  async function importBank(file) {
    const data = require(file), ref = col("daily_bank"); let added = 0, kept = 0;
    const existing = new Set((await ref.get()).docs.map(d => d.id));
    for (const q of data.questions) { if (existing.has(q.id)) { kept++; continue; } await ref.doc(q.id).set({ ...q, used_on: null, used_count: 0, imported_at: now(), bank_version: data.version }); added++; }
    return { added, kept, total: data.questions.length };
  }
  async function status() {
    const cfg = await config(), bank = await bankAll(), key = berlinDateKey(now()), stock = {};
    for (const c of COURSES) {
      const qs = bank.filter(q => q.course === c), avail = qs.filter(q => eligible(q, addDays(key, 1), cfg)).length, per = cfg.mix[c] || 0;
      stock[c] = { total: qs.length, approved: qs.filter(q => q.status === "approved").length, needs_review: qs.filter(q => q.status === "needs_review").length,
        disabled: qs.filter(q => q.status === "disabled").length, available: avail, per_day: per, days_left: per ? Math.floor(avail / per) : null };
    }
    const low = Object.entries(stock).filter(([, s]) => s.per_day && s.days_left < cfg.low_stock_days).map(([c, s]) => ({ course: c, days_left: s.days_left }));
    const alerts = (await col("daily_settings").doc("alerts").get()).data() || {};
    const runs = (await col("daily_runs").orderBy("at", "desc").limit(10).get()).docs.map(d => d.data());
    const sum = async d => { const s = await setOf(d); return s ? { date: d, questions: s.questions.length, created_at: s.created_at, created_by: s.created_by } : null; };
    return { config: cfg, stock, low_stock: low, bank_exhausted: alerts.bank_exhausted || null, today: await sum(key), tomorrow: await sum(addDays(key, 1)),
      date: key, next_reset_at: nextReset(now()), runs, bank_empty: bank.length === 0 };
  }
  async function bankList({ course, status: st, q, source, offset = 0 } = {}) {
    let list = await bankAll();
    if (source === "ai_generated") list = list.filter(x => x.source === "ai_generated"); else if (source === "bank") list = list.filter(x => x.source !== "ai_generated");
    if (course) list = list.filter(x => x.course === course);
    if (st) list = list.filter(x => x.status === st);
    if (q) { const s = String(q).toLowerCase(); list = list.filter(x => x.q.toLowerCase().includes(s) || x.lesson_title.toLowerCase().includes(s)); }
    list.sort((a, b) => a.course.localeCompare(b.course) || a.module_index - b.module_index || a.lesson_index - b.lesson_index || a.question_index - b.question_index);
    return { total: list.length, items: list.slice(Number(offset) || 0, (Number(offset) || 0) + 50) };
  }
  async function bankCreate(body) {
    const b = body || {}, clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
    const course = clean(b.course, 8), kind = clean(b.kind || "choice", 20), q = clean(b.q, 1200), module_title = clean(b.module_title, 180), lesson_title = clean(b.lesson_title, 180);
    const options = Array.isArray(b.options) ? b.options.map(x => clean(x, 400)) : [];
    const correct = Number(b.correct);
    if (!COURSES.includes(course)) throw bad("Выберите корректный курс");
    if (!q || !module_title || !lesson_title) throw bad("Заполните вопрос, модуль и урок");
    if (!['choice','situation','term','error','chart'].includes(kind)) throw bad("Неизвестный тип вопроса");
    if (options.length < 2 || options.length > 6 || options.some(x => !x) || new Set(options).size !== options.length) throw bad("Нужно 2–6 непустых уникальных вариантов ответа");
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) throw bad("Выберите правильный вариант");
    const explanation = clean(b.explanation, 1500);
    if (explanation.length < 5) throw bad("Добавьте объяснение правильного ответа");
    const chart_image = b.chart_image ? clean(b.chart_image, 120) : null;
    if (chart_image && !/^\/media\/med_[a-f0-9]{20}$/.test(chart_image)) throw bad("Изображение должно быть загружено в медиатеку Academy");
    if (kind === "chart" && !chart_image) throw bad("Для задания по графику загрузите изображение графика");
    const id = "q_manual_" + crypto.randomBytes(8).toString("hex");
    const rec = { id, course, course_slug: clean(b.course_slug || course, 80), module_index: Math.max(0, Math.min(999, Number(b.module_index) || 0)), module_title,
      lesson_index: Math.max(0, Math.min(999, Number(b.lesson_index) || 0)), lesson_title, lesson_kind: "lesson", block_id: "admin_manual", block_index: 0, question_index: 0,
      q, options, correct, explanation, source_ref: clean(b.source_ref, 300) || null, kind, chart_image, i18n: {}, status: "needs_review", issues: ["manual_review"], used_on: null, used_count: 0, created_at: now(), created_by: clean(b.created_by, 128) || null };
    await col("daily_bank").doc(id).set(rec);
    return rec;
  }
  async function bankUpdate(id, body) {
    const ref = col("daily_bank").doc(id), s = await ref.get(); if (!s.exists) throw bad("Вопрос не найден", "NOT_FOUND", 404);
    const cur = s.data(), b = body || {}, patch = {};
    const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
    if (b.explanation !== undefined) patch.explanation = clean(b.explanation, 1500);
    // Полные ручные переводы RU → EN/UA. Автоперевод не выдаём за проверенный перевод.
    const i18n = JSON.parse(JSON.stringify(cur.i18n || {})); let i18nChanged = false;
    for (const l of ["en", "ua"]) {
      const fields = { q: 1200, lesson_title: 180, module_title: 180, explanation: 1500 };
      const translated = { ...(i18n[l] || {}) };
      for (const [field, max] of Object.entries(fields)) if (b[`${field}_${l}`] !== undefined) { translated[field] = clean(b[`${field}_${l}`], max); i18nChanged = true; }
      if (b[`options_${l}`] !== undefined) {
        if (!Array.isArray(b[`options_${l}`]) || b[`options_${l}`].length !== (cur.options || []).length) throw bad(`Перевод вариантов ${l.toUpperCase()}: количество должно совпадать с RU`);
        translated.options = b[`options_${l}`].map(x => clean(x, 400));
        if (translated.options.some(x => !x)) throw bad(`Перевод вариантов ${l.toUpperCase()} не может быть пустым`);
        i18nChanged = true;
      }
      if (Object.keys(translated).length) i18n[l] = translated;
    }
    if (i18nChanged) patch.i18n = i18n;
    if (b.status !== undefined) {
      if (!["approved", "needs_review", "disabled"].includes(b.status)) throw bad("Неизвестный статус");
      const expl = patch.explanation !== undefined ? patch.explanation : cur.explanation;
      if (b.status === "approved" && String(expl || "").length < 5) throw bad("Нельзя одобрить: добавьте объяснение правильного ответа", "INVALID", 400);
      patch.status = b.status; if (b.status === "approved") patch.issues = [];
      if (cur.source === "ai_generated") patch.review_status = b.status === "approved" ? "approved" : b.status === "disabled" ? "rejected" : "pending_review";   // решение администратора по ИИ-вопросу
    }
    patch.updated_at = now(); await ref.update(patch);   // опубликованные наборы хранят свою копию — их это не меняет
    return { ...cur, ...patch, id };
  }
  async function analytics() {
    const since = addDays(berlinDateKey(now()), -89);
    const [bank, attemptsSnap] = await Promise.all([bankAll(), col("daily_attempts").where("date", ">=", since).limit(10000).get()]);
    const attempts = attemptsSnap.docs.map(d => d.data()).filter(a => a && a.status === "done");
    const byQ = new Map(), byCourse = {}, byKind = {};
    for (const a of attempts) {
      const q = byQ.get(a.qid) || { attempts: 0, correct: 0 }; q.attempts++; if (a.correct === true) q.correct++; byQ.set(a.qid, q);
      const c = byCourse[a.course] || { attempts: 0, correct: 0 }; c.attempts++; if (a.correct === true) c.correct++; byCourse[a.course] = c;
    }
    const qMap = new Map(bank.map(q => [q.id, q]));
    for (const [qid, v] of byQ) { const q = qMap.get(qid); if (!q) continue; const k = q.kind || "choice", x = byKind[k] || { attempts: 0, correct: 0 }; x.attempts += v.attempts; x.correct += v.correct; byKind[k] = x; }
    const rate = x => x.attempts ? Math.round(100 * x.correct / x.attempts) : null;
    const questions = [...byQ].map(([id, v]) => { const q = qMap.get(id); return q ? { id, q: q.q, course: q.course, kind: q.kind || "choice", attempts: v.attempts, correct: v.correct, accuracy: rate(v) } : null; }).filter(Boolean);
    return { total_attempts: attempts.length, overall_accuracy: attempts.length ? Math.round(100 * attempts.filter(a => a.correct === true).length / attempts.length) : null,
      by_course: Object.fromEntries(Object.entries(byCourse).map(([k,v]) => [k, { ...v, accuracy: rate(v) }])),
      by_kind: Object.fromEntries(Object.entries(byKind).map(([k,v]) => [k, { ...v, accuracy: rate(v) }])),
      hardest: questions.filter(q => q.attempts >= 3).sort((a,b) => a.accuracy - b.accuracy || b.attempts-a.attempts).slice(0,10),
      easiest: questions.filter(q => q.attempts >= 3).sort((a,b) => b.accuracy - a.accuracy || b.attempts-a.attempts).slice(0,10),
      note: "Статистика рассчитана по завершённым попыткам за последние 90 дней (до 10 000 записей); вопросы с менее чем 3 ответами не попадают в рейтинг сложности." };
  }
  async function sets(limit = 30) { return (await col("daily_sets").orderBy("date", "desc").limit(Math.min(60, limit)).get()).docs.map(d => { const s = d.data(); return { date: s.date, questions: s.questions.length, created_by: s.created_by, created_at: s.created_at }; }); }
  async function setDetail(date) { const s = await setOf(date); if (!s) throw bad("Набор не найден", "NOT_FOUND", 404); const k = (await col("daily_keys").doc(date).get()).data() || { answers: {} };
    return { ...s, questions: s.questions.map(q => ({ ...q, correct: (k.answers[q.id] || {}).correct, explanation: (k.answers[q.id] || {}).explanation })) }; }
  return { config, setConfig, ensureSet, run, today, task, start, answer, history, importBank, status, bankAll, bankList, bankCreate, bankUpdate, analytics, sets, setDetail };
}
module.exports = { createDailyTests, berlinDateKey, berlinMidnight, nextReset, addDays, DEFAULT_CONFIG, COURSES };
