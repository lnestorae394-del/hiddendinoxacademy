"use strict";
/* База знаний Hidden Dinox v2: схема записей, поиск для AI Mentor и безопасная миграция в Firestore.
   Хранение: hd_knowledge_v2/{id}; журнал hd_knowledge_v2_runs; настройка ai_settings/knowledge { active: "v1"|"v2", revision }.
   Старая база hd_knowledge не изменяется: переключение — одной настройкой, откат — обратным переключением. */
const fs = require("fs"), path = require("path");
const KB_VERSION = "v2", COLL = "hd_knowledge_v2", RUNS = "hd_knowledge_v2_runs", SETTINGS = ["ai_settings", "knowledge"];
const LANGS = ["ru", "en", "ua"];
const TYPES = ["lesson_section", "definition", "book_page", "project_fact"];
const AUTHORITY = ["official_hidden_dinox", "general_education"];
const TR_STATUS = ["original", "existing", "approved", "draft"];
const STATUS = ["published", "draft", "archived"];
const ROOT = path.resolve(__dirname, "..");
const DATA_FILES = ["courses-hr.json", "courses-smc.json", "courses-rm.json", "book.json", "project.json"];
const VERIFY_MIN = 0.85;                                             // доля верных контрольных запросов, без которой v2 не включается

function validateRecord(r) {
  if (!r || typeof r !== "object") return "не объект";
  if (!/^kb2_[0-9a-f]{16}$/.test(r.id || "")) return "id";
  if (r.kb_version !== KB_VERSION) return "kb_version";
  if (!TYPES.includes(r.type)) return "type";
  if (!AUTHORITY.includes(r.authority)) return "authority";
  if (!LANGS.includes(r.language)) return "language";
  if (!TR_STATUS.includes(r.translation_status)) return "translation_status";
  if (!STATUS.includes(r.status)) return "status";
  if (typeof r.title !== "string" || !r.title.trim() || r.title.length > 300) return "title";
  if (typeof r.content !== "string" || r.content.trim().length < 3 || r.content.length > 60000) return "content";
  if (typeof r.verified !== "boolean") return "verified";
  if (r.translation_status === "draft" && r.verified) return "черновой перевод не может быть verified";
  if (!r.provenance || typeof r.provenance.source_file !== "string") return "provenance.source_file";
  if (!/^[0-9a-f]{40}$/.test(r.checksum || "")) return "checksum";
  return null;
}
function loadBundled(root = ROOT) {
  const dir = path.join(root, "content/knowledge/v2"); const records = [];
  for (const f of DATA_FILES) records.push(...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).records);
  const glossary = JSON.parse(fs.readFileSync(path.join(dir, "glossary.json"), "utf8")).terms;
  const control = JSON.parse(fs.readFileSync(path.join(dir, "control-queries.json"), "utf8")).queries;
  return { records, glossary, control };
}

/* ---------- Поиск ---------- */
const STOP = new Set(("и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему когда даже ну ли если уже или ни быть был него до вас вам там потом себя ничего ей может они тут где есть надо для мы тебя их чем была сам без чего раз тоже себе под будет ж тогда кто этот того потому этого какой какая какие совсем ним здесь этом один мой тем чтобы сейчас были куда зачем всех можно при об другой хоть после над больше тот через эти нас про всего них много три эту моя свою этой перед лучше чуть том такой им более всегда между это эта такое расскажи объясни скажи пожалуйста подскажи помоги мне нужно хочу понять " +
  "і й та що це як на з зі у в до від за по про для чи не ні так але або коли де хто який яка яке які якщо вже ще ти ви ми він вона воно вони його її їх мені тобі нам вам там тут теж також лише тільки дуже може можна треба розкажи поясни скажи " +
  "the a an and or of to in on at for with by from is are was were be been it this that these those what which who how why when where can could should would do does did i you we they my your our me us them about please explain tell").split(" "));
const TRANSLIT = [["shch", "щ"], ["sch", "щ"], ["zh", "ж"], ["kh", "х"], ["ts", "ц"], ["ch", "ч"], ["sh", "ш"], ["yu", "ю"], ["ya", "я"], ["yo", "ё"], ["ye", "е"],
  ["a", "а"], ["b", "б"], ["v", "в"], ["g", "г"], ["d", "д"], ["e", "е"], ["z", "з"], ["i", "и"], ["j", "й"], ["k", "к"], ["l", "л"], ["m", "м"], ["n", "н"], ["o", "о"], ["p", "п"], ["r", "р"], ["s", "с"], ["t", "т"], ["u", "у"], ["f", "ф"], ["h", "х"], ["c", "к"], ["y", "ы"], ["w", "в"], ["x", "кс"], ["q", "к"]];
const norm = s => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[\u200b-\u200f]/g, "");
const stem = w => /[а-яіїєґ]/.test(w) ? (w.length > 6 ? w.slice(0, 6) : w) : w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w;
const words = s => (norm(s).match(/[a-zа-яіїєґ0-9%]{2,}/g) || []).filter(w => !STOP.has(w));
const toks = s => words(s).map(stem);
const translit = w => { let out = "", i = 0; while (i < w.length) { const t = TRANSLIT.find(([l]) => w.startsWith(l, i)); if (t) { out += t[1]; i += t[0].length; } else { out += w[i]; i++; } } return out; };
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1; const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { let cur = [i], best = i; for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); best = Math.min(best, cur[j]); }
    if (best > max) return max + 1; prev.splice(0, prev.length, ...cur); }
  return prev[b.length];
}
function buildIndex(records, glossary) {
  const aliases = [];                                                 // [нормализованная фраза, канонический токен]
  for (const [key, list] of Object.entries(glossary || {})) for (const a of [key, ...list]) aliases.push([norm(a), "§" + key.replace(/\s+/g, "_")]);
  aliases.sort((x, y) => y[0].length - x[0].length);
  const canon = text => { const t = " " + norm(text).replace(/[^a-zа-яіїєґ0-9%]+/g, " ") + " "; const out = new Set(); for (const [a, c] of aliases) if (t.includes(" " + a + " ")) out.add(c); return [...out]; };
  // английские написания термина (заголовки уроков SMC — «Order Block», «Fair Value Gap», «BOS»): синоним в вопросе добавляет их в запрос
  const latin = new Map(Object.entries(glossary || {}).map(([key, list]) => ["§" + key.replace(/\s+/g, "_"), [...new Set([key, ...list].filter(a => !/[а-яіїєґ]/i.test(a)).flatMap(a => toks(a)))]]));
  const docs = records.map(r => {
    const title = toks(r.title), lesson = toks((r.lesson_title || "") + " " + (r.module_title || "")), tags = toks((r.tags || []).join(" ")), body = toks(r.content);
    return { r, title, lesson, tags, body, canon: canon(r.title + " " + r.content + " " + (r.lesson_title || "")), len: body.length };
  });
  const df = new Map(); for (const d of docs) for (const w of new Set([...d.title, ...d.lesson, ...d.tags, ...d.body, ...d.canon])) df.set(w, (df.get(w) || 0) + 1);
  const vocab = [...df.keys()].filter(w => w.length >= 4 && !w.startsWith("§"));
  // полные слова (без сокращения до основы) — для исправления опечаток до поиска синонимов
  const wordVocab = new Map(); for (const r of records) for (const w of words(r.title + " " + r.content)) if (w.length >= 4) wordVocab.set(w, (wordVocab.get(w) || 0) + 1);
  for (const [key, list] of Object.entries(glossary || {})) for (const w of words([key, ...list].join(" "))) wordVocab.set(w, (wordVocab.get(w) || 0) + 1000);   // слова глоссария не «исправляются»
  return { docs, df, vocab, wordVocab, canon, latin, N: docs.length || 1, avg: docs.reduce((n, d) => n + d.len, 0) / (docs.length || 1) || 1 };
}
const BRAND = new Set(["hidden", "reaction", "dinox", "smart", "money", "concept", "smc", "academy", "академ", "академі", "§hidden_reaction", "§smc", "§risk_management", "risk", "management", "менедж", "ризик", "риск"]);
const DEF_Q = /^(что такое|что значит|что означает|що таке|що означає|what is|what are|what does|define|определени|визначенн)/i;
/* исправление опечаток по полным словам базы: «ликвидноть» → «ликвидность» (тогда находятся и синонимы глоссария) */
function correctQuery(ix, query) {
  return norm(query).replace(/[a-zа-яіїєґ0-9%]{5,}/g, w => {
    if (ix.wordVocab.has(w) || STOP.has(w)) return w; const max = w.length >= 9 ? 2 : 1; let best = null, bd = max + 1, bf = 0;
    for (const [v, f] of ix.wordVocab) { if (v[0] !== w[0] || Math.abs(v.length - w.length) > max) continue; const d = lev(w, v, max); if (d < bd || (d === bd && f > bf)) { bd = d; best = v; bf = f; } }
    return best && bd <= max ? best : w;
  });
}
function searchIndex(ix, query0, { limit = 6, allowCourses = null } = {}) {
  const query = /[а-яіїєґ]/i.test(query0) ? correctQuery(ix, query0) : query0;
  let q = toks(query);
  if (!/[а-яіїєґ]/i.test(query)) q = [...q, ...words(query).map(translit).map(stem)];   // транслит латиницей
  const known = new Set(ix.df.keys()), fixed = [];
  for (const w of q) { if (known.has(w) || w.length < 4) continue;                       // опечатки: ближайшее слово словаря
    const max = w.length >= 9 ? 2 : 1; let best = null, bd = max + 1;
    for (const v of ix.vocab) { if (v[0] !== w[0]) continue; const d = lev(w, v, max); if (d < bd || (d === bd && best && ix.df.get(v) > ix.df.get(best))) { bd = d; best = v; } }
    if (best && bd <= max) fixed.push(best); }
  const canon = ix.canon(query), terms = [...new Set([...q, ...fixed, ...canon, ...canon.flatMap(c => ix.latin.get(c) || [])])]; if (!terms.length) return [];
  // названия курсов и бренда — фон: если в вопросе есть содержательные слова, их вес снижается
  const content = terms.filter(w => !BRAND.has(w)), brandWeight = content.length ? 0.2 : 1;
  const phrase = norm(query).replace(/[^a-zа-яіїєґ0-9% ]+/g, " ").replace(/\s+/g, " ").trim(), isDef = DEF_Q.test(String(query).trim());
  const out = [];
  for (const d of ix.docs) {
    if (allowCourses && d.r.course !== "project" && d.r.source_type !== "book" && !allowCourses.has(d.r.course_slug)) continue;
    let s = 0; const tf = new Map(); for (const w of d.body) tf.set(w, (tf.get(w) || 0) + 1); const why = [];
    for (const w of terms) { const df = ix.df.get(w) || 0; if (!df) continue; const idf = Math.log(1 + (ix.N - df + 0.5) / (df + 0.5));
      const f = tf.get(w) || 0; let part = f ? idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / ix.avg)) : 0;
      if (d.title.includes(w)) part += idf * 2.5; if (d.lesson.includes(w)) part += idf * 1.2; if (d.tags.includes(w)) part += idf * 1.2; if (d.canon.includes(w)) part += idf * 2;
      if (part) { s += part * (BRAND.has(w) ? brandWeight : 1); why.push(w); } }
    if (!s) continue;
    // покрытие заголовка: «Order Block» на «что такое ордер блок» выше, чем «Bearish order block»
    const tt = [...new Set(d.title)]; if (tt.length) s *= 1 + 0.5 * tt.filter(w => terms.includes(w)).length / tt.length;
    if (phrase.split(" ").length >= 2 && norm(d.r.title + " " + d.r.content).includes(phrase)) s += 3;
    if (d.r.authority === "official_hidden_dinox") s *= 1.05;
    if (isDef && d.r.type === "definition") s *= 1.6;
    if (d.r.type === "project_fact") s *= 1.3;
    if (d.r.lesson_kind === "test") s *= 0.7;                                          // тесты модулей — ниже обучающих уроков
    out.push({ r: d.r, score: s, why });
  }
  out.sort((a, b) => b.score - a.score);
  return out.filter(x => x.score > 1.5).slice(0, limit);
}
/* Поиск на языке ученика; если своих результатов мало — дополняется русскими (вес ниже, без повторов того же урока/записи) */
function searchWithFallback(ixLang, ixRu, query, opts = {}) {
  const limit = opts.limit || 6, own = searchIndex(ixLang, query, { ...opts, limit });
  if (!ixRu || ixLang === ixRu) return own;                                         // EN/UA: всегда объединяется с русскими (факты о проекте есть только в RU)
  const key = r => r.lesson_key ? r.lesson_key + "|" + r.section : (r.provenance && (r.provenance.key || "p" + r.provenance.page)) || r.id;
  const seen = new Set(own.map(x => key(x.r))), extra = searchIndex(ixRu, query, { ...opts, limit }).filter(x => !seen.has(key(x.r))).map(x => ({ ...x, score: x.score * 0.8, fallback: "ru" }));
  return [...own, ...extra].sort((a, b) => b.score - a.score).slice(0, limit);
}
/* попадание контрольного запроса: ожидаемый урок/запись в первых 3; страница книги — если входит в source_pages урока */
function hit(results, expect, pagesByLesson) {
  return results.slice(0, 3).some(({ r }) => expect.some(e => e.startsWith("project:") ? r.provenance && r.provenance.key === e.slice(8)
    : r.lesson_key === e || (r.type === "book_page" && (pagesByLesson.get(e) || []).includes(r.provenance.page))));
}
function runControl(records, glossary, control) {
  const byLang = {}, pagesByLesson = new Map();
  for (const r of records) if (r.lesson_key && r.provenance && Array.isArray(r.provenance.book_pages) && r.provenance.book_pages.length) pagesByLesson.set(r.lesson_key, r.provenance.book_pages);
  const ix = lang => byLang[lang] = byLang[lang] || buildIndex(records.filter(r => r.status === "published" && r.language === lang), glossary);
  const res = control.map(c => { const lang = c.lang;
    const found = searchWithFallback(ix(lang), ix("ru"), c.q, { limit: 3 }); return { q: c.q, lang, ok: hit(found, c.expect, pagesByLesson), top: found.map(x => x.r.lesson_key || (x.r.provenance && (x.r.provenance.key || "p." + x.r.provenance.page))) }; });
  const passed = res.filter(x => x.ok).length;
  return { total: res.length, passed, rate: res.length ? passed / res.length : 0, failed: res.filter(x => !x.ok) };
}

/* ---------- Firestore: dry-run, резервная копия, импорт, проверка, переключение ---------- */
function createKnowledgeV2({ db, now = () => Date.now(), root = ROOT }) {
  const col = n => db.collection(n);
  const setRef = () => col(SETTINGS[0]).doc(SETTINGS[1]);
  async function settings() { const s = await setRef().get(); return { active: "v1", revision: 0, ...(s.exists ? s.data() : {}) }; }
  async function existing() { return (await col(COLL).get()).docs.map(d => ({ id: d.id, ...d.data() })); }
  async function dryRun(records = loadBundled(root).records) {
    const errors = [], ids = new Set(), seen = new Map(), dups = [];
    for (const r of records) { const e = validateRecord(r); if (e) errors.push({ id: r && r.id, error: e }); if (ids.has(r.id)) errors.push({ id: r.id, error: "повторяющийся id" }); ids.add(r.id);
      const k = r.language + "|" + r.checksum; if (seen.has(k) && r.type !== "definition") dups.push({ id: r.id, same_as: seen.get(k) }); seen.set(k, r.id); }
    const cur = new Map((await existing()).map(x => [x.id, x]));
    const add = records.filter(r => !cur.has(r.id)).length, update = records.filter(r => cur.has(r.id) && (cur.get(r.id).checksum !== r.checksum || cur.get(r.id).status !== r.status)).length;
    const unchanged = records.filter(r => cur.has(r.id) && cur.get(r.id).checksum === r.checksum && cur.get(r.id).status === r.status).length;
    const archive = [...cur.values()].filter(x => !ids.has(x.id) && x.status !== "archived").length;
    return { records: records.length, add, update, unchanged, archive, duplicates: dups.length, duplicate_examples: dups.slice(0, 5), errors: errors.length, error_examples: errors.slice(0, 10) };
  }
  async function backup() {
    const dump = async n => (await col(n).get()).docs.map(d => ({ id: d.id, ...d.data() }));
    return { kind: "hidden-dinox-knowledge-backup", created_at: now(), settings: await settings(),
      hd_knowledge: await dump("hd_knowledge"), hd_knowledge_versions: await dump("hd_knowledge_versions"), hd_knowledge_v2: await dump(COLL) };
  }
  async function bump(patch) { return db.runTransaction(async tx => { const s = await tx.get(setRef()), cur = s.exists ? s.data() : { active: "v1", revision: 0 };
    const next = { ...cur, ...patch, revision: (cur.revision || 0) + 1, updated_at: now() }; tx.set(setRef(), next); return next; }); }
  async function log(action, data, actor) { await col(RUNS).doc(`${now()}_${action}`).set({ action, actor: actor || null, at: now(), ...data }); }
  /* импорт: идемпотентно (по id и checksum); отсутствующие в сборке записи — archived, не удаляются */
  async function apply(records = loadBundled(root).records, actor = null, { backupRef = null } = {}) {
    const plan = await dryRun(records); if (plan.errors) throw Object.assign(new Error("В записях есть ошибки схемы"), { status: 400, code: "INVALID", plan });
    const cur = new Map((await existing()).map(x => [x.id, x])), ids = new Set(records.map(r => r.id)), t = now(); let written = 0, archived = 0;
    const work = [];
    for (const r of records) { const c = cur.get(r.id); if (c && c.checksum === r.checksum && c.status === r.status) continue;
      const { id, ...data } = r; work.push(() => col(COLL).doc(id).set({ ...data, id, imported_at: t, updated_at: t, created_at: (c && c.created_at) || t, imported_by: actor })); written++; }
    for (const c of cur.values()) if (!ids.has(c.id) && c.status !== "archived") { const { id, ...data } = c; work.push(() => col(COLL).doc(id).set({ ...data, status: "archived", archived_at: t })); archived++; }
    for (let i = 0; i < work.length; i += 50) await Promise.all(work.slice(i, i + 50).map(f => f()));
    const s = await bump({ last_import: { at: t, written, archived, records: records.length, backup_ref: backupRef } });
    await log("import", { written, archived, records: records.length, backup_ref: backupRef }, actor);
    return { ...plan, written, archived, revision: s.revision };
  }
  async function publishedFromDb() { return (await existing()).filter(x => x.status === "published"); }
  async function verify(actor = null, control = loadBundled(root).control) {
    const { glossary } = loadBundled(root), recs = await publishedFromDb();
    const r = recs.length ? runControl(recs, glossary, control) : { total: control.length, passed: 0, rate: 0, failed: control.map(c => ({ q: c.q, lang: c.lang, ok: false, top: [] })) };
    const ok = r.rate >= VERIFY_MIN; await bump({ last_verify: { at: now(), passed: r.passed, total: r.total, rate: r.rate, ok } }); await log("verify", { passed: r.passed, total: r.total, ok }, actor);
    return { ...r, ok, threshold: VERIFY_MIN };
  }
  async function activate(version, actor = null, { force = false } = {}) {
    if (!["v1", "v2"].includes(version)) throw Object.assign(new Error("Версия: v1 или v2"), { status: 400, code: "INVALID" });
    const s = await settings();
    if (version === "v2" && !force && !(s.last_verify && s.last_verify.ok)) throw Object.assign(new Error("Сначала выполните проверку контрольными запросами (verify) с успешным результатом"), { status: 409, code: "NOT_VERIFIED" });
    const n = await bump({ active: version, activated_at: now(), activated_by: actor }); await log("activate", { version, force }, actor); return { active: n.active, revision: n.revision };
  }
  async function status() {
    const s = await settings(), all = await existing(), count = (a, k) => a.reduce((m, r) => (m[r[k]] = (m[r[k]] || 0) + 1, m), {});
    const runs = (await col(RUNS).orderBy("at", "desc").limit(10).get()).docs.map(d => d.data());
    return { active: s.active, revision: s.revision, last_import: s.last_import || null, last_verify: s.last_verify || null, total: all.length,
      by_status: count(all, "status"), by_language: count(all, "language"), by_type: count(all, "type"), by_course: count(all, "course"), by_source_type: count(all, "source_type"),
      by_translation_status: count(all, "translation_status"), unverified: all.filter(x => !x.verified).length, runs };
  }
  /* Старая база hd_knowledge: архивирование (копия + пометка) и удаление — только вручную, с резервной копией и фразой-подтверждением */
  async function v1Docs() { return (await col("hd_knowledge").get()).docs.map(d => ({ id: d.id, ...d.data() })); }
  function backupCovers(backupObj, docs) { const ids = new Set(((backupObj && backupObj.hd_knowledge) || []).map(x => x.id)); return docs.every(d => ids.has(d.id)); }
  async function archiveV1(backupObj, confirm, actor = null) {
    if (confirm !== "ARCHIVE hd_knowledge") throw Object.assign(new Error("Нужна фраза подтверждения: ARCHIVE hd_knowledge"), { status: 400, code: "CONFIRM_REQUIRED" });
    const docs = await v1Docs(); if (!backupCovers(backupObj, docs)) throw Object.assign(new Error("Резервная копия не содержит все текущие записи hd_knowledge"), { status: 409, code: "BACKUP_MISMATCH" });
    const t = now(); for (const { id, ...d } of docs) { await col("hd_knowledge_archive").doc(id).set({ ...d, archived_at: t, archived_by: actor }); await col("hd_knowledge").doc(id).set({ ...d, status: "archived", archived_at: t }); }
    await log("archive_v1", { count: docs.length }, actor); return { archived: docs.length };
  }
  async function deleteV1(backupObj, confirm, actor = null) {
    if (confirm !== "DELETE hd_knowledge") throw Object.assign(new Error("Нужна фраза подтверждения: DELETE hd_knowledge"), { status: 400, code: "CONFIRM_REQUIRED" });
    const docs = await v1Docs(); if (!backupCovers(backupObj, docs)) throw Object.assign(new Error("Резервная копия не содержит все текущие записи hd_knowledge"), { status: 409, code: "BACKUP_MISMATCH" });
    const arch = new Set((await col("hd_knowledge_archive").get()).docs.map(d => d.id));
    if (!docs.every(d => arch.has(d.id))) throw Object.assign(new Error("Сначала выполните архивирование (--archive-v1)"), { status: 409, code: "NOT_ARCHIVED" });
    for (const d of docs) await col("hd_knowledge").doc(d.id).delete();
    await log("delete_v1", { count: docs.length }, actor); return { deleted: docs.length };
  }
  /* резервные копии из админки: в Firestore частями по 250 записей (база v2 не помещается в один документ) */
  async function storeBackup(actor = null) {
    const bk = await backup(), id = `kb_${now()}`, parts = [];
    for (const name of ["hd_knowledge", "hd_knowledge_versions", "hd_knowledge_v2"]) for (let i = 0; i < bk[name].length; i += 250) parts.push({ name, items: bk[name].slice(i, i + 250) });
    for (const [n, p] of parts.entries()) await col("hd_knowledge_backups").doc(`${id}_${String(n).padStart(4, "0")}`).set({ backup_id: id, part: n, ...p });
    await col("hd_knowledge_backups").doc(id).set({ backup_id: id, meta: true, created_at: bk.created_at, by: actor, counts: { hd_knowledge: bk.hd_knowledge.length, hd_knowledge_versions: bk.hd_knowledge_versions.length, hd_knowledge_v2: bk.hd_knowledge_v2.length }, parts: parts.length, settings: bk.settings });
    await log("backup", { backup_id: id, parts: parts.length }, actor); return { backup_id: id, parts: parts.length };
  }
  async function listBackups() { return (await col("hd_knowledge_backups").where("meta", "==", true).get()).docs.map(d => d.data()).sort((a, b) => b.created_at - a.created_at); }
  async function loadBackup(id) {
    const docs = (await col("hd_knowledge_backups").where("backup_id", "==", String(id)).get()).docs.map(d => d.data()); const meta = docs.find(d => d.meta);
    if (!meta) throw Object.assign(new Error("Резервная копия не найдена"), { status: 404, code: "NOT_FOUND" });
    const out = { kind: "hidden-dinox-knowledge-backup", created_at: meta.created_at, settings: meta.settings, hd_knowledge: [], hd_knowledge_versions: [], hd_knowledge_v2: [] };
    for (const p of docs.filter(d => !d.meta).sort((a, b) => a.part - b.part)) out[p.name].push(...p.items);
    return out;
  }
  async function reindex(actor = null) { const s = await bump({}); await log("reindex", {}, actor); return { revision: s.revision }; }
  return { settings, dryRun, backup, apply, verify, activate, status, publishedFromDb, archiveV1, deleteV1, storeBackup, listBackups, loadBackup, reindex };
}
/* Кэш индексов для AI Mentor: по ревизии настроек (настройки перечитываются не чаще раза в 60 с) */
const MENTOR_CACHE = new WeakMap();
async function mentorIndex(db, lang, now = () => Date.now(), root = ROOT) {
  let c = MENTOR_CACHE.get(db); if (!c) { c = { checkedAt: 0, settings: null, rev: -1, byLang: new Map() }; MENTOR_CACHE.set(db, c); }
  if (!c.settings || now() - c.checkedAt > 60e3) { const s = await db.collection(SETTINGS[0]).doc(SETTINGS[1]).get(); c.settings = { active: "v1", revision: 0, ...(s.exists ? s.data() : {}) }; c.checkedAt = now(); }
  if (c.settings.active !== "v2") return null;
  if (c.rev !== c.settings.revision) { c.rev = c.settings.revision; c.byLang = new Map(); c.records = null; }
  if (!c.records) c.records = (await db.collection(COLL).where("status", "==", "published").get()).docs.map(d => ({ id: d.id, ...d.data() }));
  if (!c.byLang.has(lang)) c.byLang.set(lang, buildIndex(c.records.filter(r => r.language === lang), loadBundled(root).glossary));
  if (!c.byLang.has("ru")) c.byLang.set("ru", buildIndex(c.records.filter(r => r.language === "ru"), loadBundled(root).glossary));
  return { lang: c.byLang.get(lang), ru: c.byLang.get("ru"), revision: c.rev };
}
function invalidateMentorIndex(db) { MENTOR_CACHE.delete(db); }
module.exports = { KB_VERSION, COLL, validateRecord, loadBundled, buildIndex, searchIndex, searchWithFallback, runControl, createKnowledgeV2, mentorIndex, invalidateMentorIndex, VERIFY_MIN, DATA_FILES };
