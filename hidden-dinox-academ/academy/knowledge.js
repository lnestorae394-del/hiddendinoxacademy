"use strict";
const crypto = require("crypto");
const CATEGORIES = [
  "brand", "founder", "philosophy", "academy", "courses", "hidden-reaction", "smart-money", "risk-management", "trading-psychology", "technical-analysis", "price-action", "cryptocurrency", "bitcoin-ethereum", "blockchain", "defi-web3", "forex-markets", "faq-support", "rules-policies", "products-services", "platform-instructions", "general-education"
];
const LANGS = ["ru", "en", "ua"];
const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
function validate(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("Ожидается объект материала"), { status: 400, code: "INVALID" });
  const out = {};
  for (const k of ["title", "content", "category", "language", "source", "source_url"]) if (input[k] !== undefined) out[k] = clean(input[k], k === "content" ? 30000 : 1000);
  if (!partial || input.title !== undefined) { if (!out.title) throw Object.assign(new Error("Укажите название"), { status: 400, code: "INVALID", field: "title" }); }
  if (!partial || input.content !== undefined) { if (!out.content) throw Object.assign(new Error("Укажите содержание"), { status: 400, code: "INVALID", field: "content" }); }
  if (out.category && !CATEGORIES.includes(out.category)) throw Object.assign(new Error("Неизвестная категория"), { status: 400, code: "INVALID", field: "category" });
  if (out.language && !LANGS.includes(out.language)) throw Object.assign(new Error("Язык должен быть ru, en или ua"), { status: 400, code: "INVALID", field: "language" });
  if (input.tags !== undefined) out.tags = [...new Set((Array.isArray(input.tags) ? input.tags : []).map(x => clean(x, 40)).filter(Boolean))].slice(0, 30);
  if (input.verified !== undefined) out.verified = input.verified === true;
  return out;
}
/* Кэш опубликованных материалов для поиска AI Mentor: общий для процесса (mentor создаёт модуль на каждый запрос),
   живёт не дольше 60 секунд и сбрасывается при любом изменении базы из админки. */
const PUBLISHED_CACHE = new WeakMap(), CACHE_MS = 60e3;
function createKnowledge({ db, now = () => Date.now() }) {
  // Коллекция берётся лениво: модуль можно создать и без Firebase (сервер не падает, API отвечает 503)
  const col = { get: () => db.collection("hd_knowledge").get(), doc: id => db.collection("hd_knowledge").doc(id) };
  const invalidate = () => { if (db) PUBLISHED_CACHE.delete(db); };
  const all = async () => (await col.get()).docs.map(d => ({ id: d.id, ...d.data() }));
  async function published() {
    const c = PUBLISHED_CACHE.get(db); if (c && now() - c.at < CACHE_MS) return c.items;
    const items = (await all()).filter(x => x.status === "published"); PUBLISHED_CACHE.set(db, { at: now(), items }); return items;
  }
  async function list(q = {}) {
    let a = await all();
    if (q.status) a = a.filter(x => x.status === q.status);
    if (q.category) a = a.filter(x => x.category === q.category);
    if (q.language) a = a.filter(x => x.language === q.language);
    const term = clean(q.q, 150).toLowerCase();
    if (term) a = a.filter(x => (x.title + " " + x.content + " " + (x.tags || []).join(" ")).toLowerCase().includes(term));
    return a.sort((x, y) => (y.updated_at || 0) - (x.updated_at || 0)).slice(0, 500);
  }
  async function get(id) { const d = await col.doc(id).get(); return d.exists ? { id, ...d.data() } : null; }
  async function create(input, actor) {
    const v = validate(input); if (!v.category || !v.language) throw Object.assign(new Error("Укажите category и language"), { status: 400, code: "INVALID" });
    const id = "k_" + crypto.randomBytes(12).toString("hex"), t = now();
    const doc = { ...v, status: "draft", version: 1, verified: v.verified === true, created_at: t, updated_at: t, created_by: actor, updated_by: actor };
    await col.doc(id).set(doc);
    await db.collection("hd_knowledge_versions").doc(id + "__1").set({ material_id: id, version: 1, snapshot: doc, at: t, actor });
    return { id, ...doc };
  }
  async function update(id, input, actor) {
    const old = await get(id); if (!old) throw Object.assign(new Error("Материал не найден"), { status: 404, code: "NOT_FOUND" });
    const v = validate(input, { partial: true }); const t = now(), version = (old.version || 1) + 1;
    const next = { ...old, ...v, version, updated_at: t, updated_by: actor };
    delete next.id; await col.doc(id).set(next);
    await db.collection("hd_knowledge_versions").doc(id + "__" + version).set({ material_id: id, version, snapshot: next, at: t, actor });
    return { id, ...next };
  }
  async function publish(id, publish, actor) {
    const old = await get(id); if (!old) throw Object.assign(new Error("Материал не найден"), { status: 404, code: "NOT_FOUND" });
    if (publish && (!old.title || !old.content || !old.category || !old.language)) throw Object.assign(new Error("Материал неполный"), { status: 400, code: "INVALID" });
    const t = now(), version = (old.version || 1) + 1, next = { ...old, status: publish ? "published" : "draft", version, updated_at: t, updated_by: actor, published_at: publish ? t : null };
    delete next.id; await col.doc(id).set(next); await db.collection("hd_knowledge_versions").doc(id + "__" + version).set({ material_id: id, version, snapshot: next, at: t, actor });
    return { id, ...next };
  }
  async function remove(id, actor) {
    const old = await get(id); if (!old) throw Object.assign(new Error("Материал не найден"), { status: 404, code: "NOT_FOUND" });
    const t = now(), version = (old.version || 1) + 1;
    await db.collection("hd_knowledge_versions").doc(id + "__" + version).set({ material_id: id, version, snapshot: old, deleted: true, at: t, actor });
    await col.doc(id).delete(); return { ok: true };
  }
  async function versions(id) { return (await db.collection("hd_knowledge_versions").where("material_id", "==", id).get()).docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => b.version-a.version); }
  async function restore(id, version, actor) {
    const ref = db.collection("hd_knowledge_versions").doc(id + "__" + Number(version)), snap = await ref.get();
    if (!snap.exists || !snap.data().snapshot) throw Object.assign(new Error("Версия не найдена"), { status: 404, code: "NOT_FOUND" });
    const old = await get(id), v = snap.data().snapshot, n = (old && old.version || 0) + 1, t = now();
    const next = { ...v, version: n, status: "draft", updated_at: t, updated_by: actor, restored_from: Number(version) }; delete next.id;
    await col.doc(id).set(next); await db.collection("hd_knowledge_versions").doc(id + "__" + n).set({ material_id: id, version: n, snapshot: next, at: t, actor, restored_from: Number(version) });
    return { id, ...next };
  }
  async function importJson(payload, actor) {
    const items = Array.isArray(payload) ? payload : payload && Array.isArray(payload.items) ? payload.items : null;
    if (!items || items.length > 500) throw Object.assign(new Error("JSON должен содержать массив items (до 500 материалов)"), { status: 400, code: "INVALID" });
    const out = []; for (const item of items) out.push(await create(item, actor)); return { imported: out.length, items: out };
  }
  async function exportJson() { const items = await all(); return { schema_version: 1, exported_at: now(), items }; }
  async function diagnostics() { const a = await all(); return { total: a.length, published: a.filter(x=>x.status==="published").length, drafts: a.filter(x=>x.status!=="published").length, by_category: Object.fromEntries(CATEGORIES.map(c=>[c,a.filter(x=>x.category===c).length]).filter(x=>x[1])), by_language: Object.fromEntries(LANGS.map(l=>[l,a.filter(x=>x.language===l).length]).filter(x=>x[1])), missing_source: a.filter(x=>!x.source && !x.source_url).length, unverified: a.filter(x=>!x.verified).length, categories: CATEGORIES, languages: LANGS }; }
  function terms(value) {
    return (String(value || "").toLowerCase().normalize("NFKC").match(/[a-zа-яёіїєґ0-9]{2,}/g) || [])
      .map(w => w.length > 5 ? w.replace(/(иями|ями|ами|ого|ему|ыми|ими|ать|ять|ить|ого|ому|ее|ые|ий|ый|ой|ая|яя|ое|ее|ов|ев|ам|ям|ах|ях|ом|ем|ы|и|а|я|е|у|ю)$/u, "") : w)
      .filter(Boolean);
  }
  const SYNONYMS = {
    "смс": ["smart", "money", "concepts", "смарт", "мани"],
    "смарт": ["smart", "money", "concepts", "смс", "смартмани"],
    "смартмани": ["smart", "money", "concepts", "смарт", "смс", "smartmoney"],
    "smartmoney": ["smart", "money", "concepts", "смартмани"],
    "ликвидность": ["liquidity", "liquidity", "стопы", "ликвидности"],
    "liquidity": ["ликвидность", "стопы"],
    "риск": ["risk", "management", "риск-менеджмент", "управление"],
    "risk": ["риск", "менеджмент", "management"],
    "бос": ["bos", "break", "structure", "структура"],
    "bos": ["бос", "break", "structure", "структура"],
    "чоч": ["choch", "change", "character", "смена", "характера"],
    "choch": ["чоч", "change", "character", "смена", "характера"],
    "об": ["order", "block", "блок", "ордера"],
    "fvg": ["fair", "value", "gap", "имбаланс", "гэп"]
  };
  async function search(lang, query, limit = 5) {
    const a = (await published()).filter(x => x.language === lang || x.language === "ru");
    const q = [...new Set(terms(query).flatMap(w => [w, ...(SYNONYMS[w] || []).flatMap(terms)]))];
    if (!q.length) return [];
    const docs = [];
    for (const x of a) {
      const raw = String(x.content || "");
      const parts = [];
      // Chunk long entries so the relevant passage, not an arbitrary prefix, is retrieved.
      for (let i = 0; i < raw.length; i += 900) parts.push(raw.slice(i, i + 1100));
      if (!parts.length) parts.push(raw);
      for (let i = 0; i < parts.length; i++) docs.push({ x, text: parts[i], title: terms(x.title), body: terms(parts[i]), tags: terms((x.tags || []).join(" ")), part: i });
    }
    const N = docs.length || 1, df = new Map();
    for (const d of docs) for (const w of new Set([...d.title, ...d.body, ...d.tags])) df.set(w, (df.get(w) || 0) + 1);
    const avg = docs.reduce((n,d)=>n+d.body.length,0) / N || 1;
    const scored = docs.map(d => {
      const tf = new Map(); for (const w of d.body) tf.set(w,(tf.get(w)||0)+1);
      let score = 0;
      for (const w of q) {
        const f = tf.get(w) || 0, frequency = df.get(w) || 0;
        if (!f && !d.title.includes(w) && !d.tags.includes(w)) continue;
        const idf = Math.log(1 + (N - frequency + 0.5) / (frequency + 0.5));
        score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.body.length / avg));
        if (d.title.includes(w)) score += idf * 2.5;
        if (d.tags.includes(w)) score += idf * 1.5;
      }
      const phrase = String(query).toLowerCase().trim();
      if (phrase.length > 3 && (d.x.title + " " + d.text).toLowerCase().includes(phrase)) score += 3;
      if (d.x.verified === true) score *= 1.05;
      if (d.x.language === lang) score *= 1.08;
      return { d, score };
    }).filter(z => z.score > 0.8).sort((u,v)=>v.score-u.score);
    const out = [], seen = new Set();
    for (const z of scored) {
      const x = z.d.x; if (seen.has(x.id) || out.length >= Math.min(10, Math.max(1, limit))) continue;
      seen.add(x.id);
      out.push({ title: x.title, category: x.category, content: z.d.text.slice(0, 2500), language: x.language,
        source: x.source || x.source_url || "Hidden Dinox Knowledge Base", verified: x.verified === true,
        score: Math.round(z.score * 1000) / 1000, material_id: x.id, chunk: z.d.part });
    }
    return out;
  }
  const w = fn => async (...a) => { try { return await fn(...a); } finally { invalidate(); } };   // любое изменение сбрасывает кэш поиска
  return { list, get, create: w(create), update: w(update), publish: w(publish), remove: w(remove), versions, restore: w(restore), importJson: w(importJson), exportJson, diagnostics, search, invalidate };
}
module.exports = { createKnowledge, CATEGORIES, LANGS, validate };
