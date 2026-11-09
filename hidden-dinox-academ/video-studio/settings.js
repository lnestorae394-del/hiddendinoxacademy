"use strict";
/* Настройки Video Studio: шаблон оформления, словарь, лимиты, цены. Хранятся в videoStudioSettings, дефолты — JSON-файлы.
   Один и тот же шаблон читают воркер (рендер) и страница (предпросмотр). */
const TEMPLATE_DEFAULT = require("./defaults/template.default.json");
const VOCAB_DEFAULT = require("./defaults/vocabulary.default.json");
const clone = v => JSON.parse(JSON.stringify(v));

// Допустимые поля шаблона и диапазоны: ничего кроме них сохранить нельзя
const NUM = (min, max) => ({ t: "num", min, max });
const STR = max => ({ t: "str", max });
const HEX = { t: "hex" };
const BOOL = { t: "bool" };
const SCHEMA = {
  window: { y: NUM(0, 1900), h: NUM(200, 1800), crop_y: NUM(0, 4000) },
  colors: { accent: HEX, text: HEX, outline: HEX, background: HEX },
  cuts: { lead: NUM(0, 1), gap_max: NUM(0.15, 3), gap_keep: NUM(0, 1), tail: NUM(0, 2) },
  brand: { text: STR(60), size: NUM(12, 80), spacing: NUM(0, 20), margin_l: NUM(0, 400), margin_v: NUM(0, 900) },
  hook: { size: NUM(24, 120), x: NUM(0, 1080), y: NUM(0, 1900), outline: NUM(0, 12), shadow: NUM(0, 8), margin_l: NUM(0, 400), margin_r: NUM(0, 400), show_seconds: NUM(1, 10) },
  subtitles: { size: NUM(30, 120), x: NUM(0, 1080), y: NUM(0, 1900), outline: NUM(0, 12), shadow: NUM(0, 8), margin_l: NUM(0, 400), margin_r: NUM(0, 400), margin_v: NUM(0, 900), max_words: NUM(1, 6), max_chars: NUM(8, 40) },
  cta: { enabled: BOOL, text: STR(60), size: NUM(16, 90), x: NUM(0, 1080), y: NUM(0, 1900), margin_l: NUM(0, 400), margin_r: NUM(0, 400), margin_v: NUM(0, 400), outline: NUM(0, 12), back_color: HEX, back_alpha: { t: "alpha" }, min_seconds: NUM(0.5, 10), max_seconds: NUM(0.5, 12), fraction: NUM(0.02, 0.5) },
  bar: { enabled: BOOL, y: NUM(0, 1914), h: NUM(1, 40) },
  logo: { enabled: BOOL, source: { t: "logo" }, x: NUM(0, 1080), y: NUM(0, 1900), w: NUM(40, 600) },
  quality: { crf: NUM(14, 32), preset: { t: "enum", values: ["ultrafast", "veryfast", "faster", "fast", "medium", "slow"] } },
  glow: { thin: NUM(0, 20), thick: NUM(0, 60), sigma: NUM(1, 60) }
};
function checkField(rule, v, path) {
  const bad = m => Object.assign(new Error(path + ": " + m), { status: 400, code: "INVALID_TEMPLATE", field: path });
  if (rule.t === "num") { if (typeof v !== "number" || !Number.isFinite(v) || v < rule.min || v > rule.max) throw bad("число от " + rule.min + " до " + rule.max); return v; }
  if (rule.t === "str") { if (typeof v !== "string" || !v.trim() || v.length > rule.max || /[\u0000-\u001f{}\\]/.test(v)) throw bad("строка до " + rule.max + " символов без служебных символов"); return v; }
  if (rule.t === "hex") { if (typeof v !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(v)) throw bad("цвет вида #RRGGBB"); return v.toUpperCase(); }
  if (rule.t === "bool") { if (typeof v !== "boolean") throw bad("true/false"); return v; }
  if (rule.t === "enum") { if (!rule.values.includes(v)) throw bad("одно из: " + rule.values.join(", ")); return v; }
  if (rule.t === "logo") { if (typeof v !== "string" || !/^(custom|brand:[A-Za-z0-9._-]{1,60}\.png)$/.test(v)) throw bad("custom или brand:<файл>.png"); return v; }
  if (rule.t === "alpha") { if (typeof v !== "string" || !/^[0-9A-Fa-f]{2}$/.test(v)) throw bad("два шестнадцатеричных знака"); return v.toUpperCase(); }
  throw bad("неизвестное правило");
}
/* Принимает частичный шаблон; возвращает проверенный частичный объект. Неизвестные поля — ошибка (ничего не пропускаем молча). */
function validateTemplatePatch(patch) {
  const out = {};
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw Object.assign(new Error("Нужен объект"), { status: 400, code: "INVALID_TEMPLATE" });
  for (const [sec, vals] of Object.entries(patch)) {
    if (!SCHEMA[sec]) throw Object.assign(new Error("Неизвестный раздел шаблона: " + sec), { status: 400, code: "INVALID_TEMPLATE", field: sec });
    if (!vals || typeof vals !== "object") throw Object.assign(new Error(sec + ": нужен объект"), { status: 400, code: "INVALID_TEMPLATE", field: sec });
    out[sec] = {};
    for (const [k, v] of Object.entries(vals)) {
      if (!SCHEMA[sec][k]) throw Object.assign(new Error("Неизвестное поле: " + sec + "." + k), { status: 400, code: "INVALID_TEMPLATE", field: sec + "." + k });
      out[sec][k] = checkField(SCHEMA[sec][k], v, sec + "." + k);
    }
  }
  return out;
}
function mergeTemplate(stored) {
  const t = clone(TEMPLATE_DEFAULT);
  if (!stored || typeof stored !== "object") return t;
  for (const [sec, vals] of Object.entries(stored)) if (SCHEMA[sec] && vals && typeof vals === "object") for (const [k, v] of Object.entries(vals)) if (SCHEMA[sec][k] !== undefined) t[sec][k] = v;
  return t;
}

/* Словарь: ≤ 300 терминов, термин ≤ 60 символов, приоритет 1..5 */
function validateVocabulary(v) {
  if (!v || !Array.isArray(v.terms) || v.terms.length > 300) throw Object.assign(new Error("Словарь: список terms до 300 записей"), { status: 400, code: "INVALID_VOCAB" });
  const seen = new Set(), terms = [];
  for (const t of v.terms) {
    const term = t && typeof t.term === "string" ? t.term.trim() : "";
    if (!term || term.length > 60 || /[\u0000-\u001f]/.test(term)) throw Object.assign(new Error("Некорректный термин: " + String(term).slice(0, 30)), { status: 400, code: "INVALID_VOCAB" });
    const key = term.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
    const p = Number.isInteger(t.p) && t.p >= 1 && t.p <= 5 ? t.p : 3;
    const aliases = Array.isArray(t.aliases) ? t.aliases.map(a => String(a).trim()).filter(a => a && a.length <= 60).slice(0, 12) : [];
    terms.push({ term, p, aliases });
  }
  return { version: 1, terms };
}
/* Подсказка Groq ограничена 224 токенами. Берём самые приоритетные термины, пока не исчерпан бюджет символов
   (по умолчанию 440 символов ≈ 190–220 токенов для русского; точное число нужно измерить токенайзером Whisper). */
const PROMPT_INTRO = "Русская живая TikTok LIVE о трейдинге. Сохраняй речь дословно. Термины: ";
function buildGroqPrompt(vocab, maxChars = 440) {
  const terms = (vocab && vocab.terms ? vocab.terms : []).slice().sort((a, b) => a.p - b.p);
  let out = PROMPT_INTRO; const used = [];
  for (const t of terms) { const add = (used.length ? ", " : "") + t.term; if ((out + add + ".").length > maxChars) continue; out += add; used.push(t.term); }
  return { prompt: out + ".", used, skipped: terms.length - used.length };
}
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
const nk = s => String(s).toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, "");
/* ПОДСКАЗКИ исправлений (не автозамена): слово совпало с алиасом термина или отличается на 1 символ от однословного термина длиной ≥ 5.
   Применяет только человек в редакторе. */
function suggestTerms(words, vocab) {
  const single = [], alias = new Map();
  for (const t of (vocab && vocab.terms) || []) { const k = nk(t.term); if (!/\s/.test(t.term.trim()) && k.length >= 5) single.push([k, t.term]); for (const a of t.aliases || []) if (!/\s/.test(a.trim())) alias.set(nk(a), t.term); }
  const out = [];
  for (const w of words) { const k = nk(w.text); if (!k) continue;
    if (alias.has(k) && nk(alias.get(k)) !== k) { out.push({ id: w.id, from: w.text, to: alias.get(k), why: "alias" }); continue; }
    for (const [tk, term] of single) if (tk !== k && Math.abs(tk.length - k.length) <= 1 && lev(tk, k) === 1) { out.push({ id: w.id, from: w.text, to: term, why: "near" }); break; } }
  return out;
}

const DEFAULT_PRICES = { verified: false, groq_per_hour: { "whisper-large-v3-turbo": 0.04, "whisper-large-v3": 0.111 }, claude_per_mtok: { "claude-sonnet-5-5": [2.0, 10.0], "claude-haiku-5-5": [0.10, 0.50] }, compute_per_hour: 0.2 };
/* Лимиты по умолчанию — те, что вы задали для MVP: $5 в месяц, $1 на задачу, файл до 5 ГБ, запись до 120 минут, 1 задача одновременно.
   Меняются переменными окружения или в настройках Video Studio; ЖЁСТКИЕ: превышение отклоняется ДО траты. */
const posNum = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const defaultLimits = (env = process.env) => ({ monthly_usd: posNum(env.VIDEO_STUDIO_MONTHLY_BUDGET_USD, 5), per_job_usd: posNum(env.VIDEO_STUDIO_JOB_BUDGET_USD, 1), max_upload_gb: posNum(env.VIDEO_STUDIO_MAX_UPLOAD_GB, 5),
  max_duration_min: posNum(env.VIDEO_STUDIO_MAX_DURATION_MIN, 120), max_concurrent_jobs: Math.floor(posNum(env.VIDEO_STUDIO_MAX_CONCURRENT, 1)), retention_days: 30 });
const DEFAULT_LIMITS = defaultLimits({});
const DEFAULT_CLIPS = { min_s: 15, max_s: 35, max_clips: 10, model: "claude-sonnet-5-5", whisper: "whisper-large-v3-turbo" };
function validateClips(p) {
  const out = {}, bad = (m, f) => Object.assign(new Error(m), { status: 400, code: "INVALID_CLIPS", field: f });
  for (const [k, v] of Object.entries(p || {})) {
    if (["min_s", "max_s"].includes(k)) { if (typeof v !== "number" || !(v >= 5 && v <= 60)) throw bad(k + ": число секунд от 5 до 60", k); out[k] = v; }
    else if (k === "max_clips") { if (!Number.isInteger(v) || v < 1 || v > 20) throw bad("max_clips: целое от 1 до 20", k); out[k] = v; }
    else if (["model", "whisper"].includes(k)) { if (typeof v !== "string" || !/^[A-Za-z0-9._-]{1,60}$/.test(v)) throw bad(k + ": некорректное имя модели", k); out[k] = v; }
    else throw bad("Неизвестная настройка: " + k, k);
  }
  return out;
}
function validateTelegram(p) {
  const out = {}, bad = (m, f) => Object.assign(new Error(m), { status: 400, code: "INVALID_TELEGRAM", field: f });
  for (const [k, v] of Object.entries(p || {})) {
    if (k === "chat_id") { const c = String(v === null ? "" : v).trim(); if (c && !/^-?\d{3,20}$/.test(c) && !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(c)) throw bad("Chat ID: число (например 123456789) или @канал", k); out[k] = c; }
    else if (["auto_send", "link_fallback"].includes(k)) { if (typeof v !== "boolean") throw bad(k + ": только true или false", k); out[k] = v; }
    else throw bad("Неизвестная настройка: " + k, k);
  }
  return out;
}
/* Все настройки из Firestore поверх значений по умолчанию (из окружения) */
async function loadSettings(db, env = process.env) {
  const get = async id => { const d = await db.collection("videoStudioSettings").doc(id).get(); if (!d.exists) return null; const x = Object.assign({}, d.data()); delete x.updated_at; delete x.updated_by; return x; };
  const [t, v, l, p, c, tg] = await Promise.all(["template", "vocabulary", "limits", "prices", "clips", "telegram"].map(get));
  const chat = (String(env.ADMIN_TELEGRAM_ID || "").split(/[,\s]+/).filter(x => /^-?\d+$/.test(x))[0]) || "";
  return { template: mergeTemplate(t), template_stored: t, vocabulary: v && v.terms ? v : clone(VOC_DEFAULT_REF()), limits: Object.assign({}, defaultLimits(env), l || {}), prices: Object.assign(clone(DEFAULT_PRICES), p || {}),
    clips: Object.assign({}, DEFAULT_CLIPS, c || {}), telegram: Object.assign({ chat_id: chat, auto_send: true, link_fallback: true }, tg || {}) };
}
const VOC_DEFAULT_REF = () => VOCAB_DEFAULT;
function validateLimits(p) {
  const out = {}; const rules = { monthly_usd: [0.1, 1000], per_job_usd: [0.05, 100], max_upload_gb: [0.1, 20], max_duration_min: [1, 480], max_concurrent_jobs: [1, 4], retention_days: [1, 365] };
  for (const [k, v] of Object.entries(p || {})) { const r = rules[k]; if (!r) throw Object.assign(new Error("Неизвестный лимит: " + k), { status: 400, code: "INVALID_LIMITS", field: k });
    if (typeof v !== "number" || !Number.isFinite(v) || v < r[0] || v > r[1]) throw Object.assign(new Error(k + ": число от " + r[0] + " до " + r[1]), { status: 400, code: "INVALID_LIMITS", field: k }); out[k] = v; }
  return out;
}
function validatePrices(p) {
  if (!p || typeof p !== "object") throw Object.assign(new Error("Нужен объект цен"), { status: 400, code: "INVALID_PRICES" });
  const out = clone(DEFAULT_PRICES); if (typeof p.verified === "boolean") out.verified = p.verified;
  const num = (x, max) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= max;
  for (const [m, v] of Object.entries(p.groq_per_hour || {})) if (num(v, 5)) out.groq_per_hour[m] = v; else throw Object.assign(new Error("Цена Groq: " + m), { status: 400, code: "INVALID_PRICES" });
  for (const [m, v] of Object.entries(p.claude_per_mtok || {})) if (Array.isArray(v) && v.length === 2 && num(v[0], 200) && num(v[1], 500)) out.claude_per_mtok[m] = v; else throw Object.assign(new Error("Цена Claude: " + m), { status: 400, code: "INVALID_PRICES" });
  if (p.compute_per_hour !== undefined) { if (!num(p.compute_per_hour, 20)) throw Object.assign(new Error("Цена вычислений"), { status: 400, code: "INVALID_PRICES" }); out.compute_per_hour = p.compute_per_hour; }
  return out;
}
module.exports = { loadSettings, defaultLimits, DEFAULT_CLIPS, validateClips, validateTelegram, TEMPLATE_DEFAULT, VOCAB_DEFAULT, SCHEMA, validateTemplatePatch, mergeTemplate, validateVocabulary, buildGroqPrompt, suggestTerms, DEFAULT_PRICES, DEFAULT_LIMITS, validateLimits, validatePrices, clone };
