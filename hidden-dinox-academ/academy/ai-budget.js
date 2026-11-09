"use strict";
/* Бюджет AI с резервированием (жёсткий месячный потолок).
   • Перед запросом резервируется худший случай (оценка входа + полный max_tokens) в транзакции Firestore:
     проходит, только если укладывается в долю функции (+ общий резерв), общий лимит и месячный лимит ученика.
     Транзакция защищает от параллельных запросов и нескольких экземпляров сервера.
   • После ответа списывается фактическая стоимость по usage (включая токены кэша), при ошибке резерв возвращается.
   • Резервы старше 10 минут (перезапуск сервера) снимаются автоматически. Месяц — по Europe/Berlin.
   Цены по умолчанию — официальная страница цен Anthropic (Claude Haiku 5.5 до 100 тыс. токенов запроса; Claude Sonnet 5.5). */
const crypto = require("crypto");
const { berlinDateKey } = require("./daily-tests");
const FEATURES = ["mentor", "vision", "daily"];
const DEFAULTS = {
  monthly_total_usd: 100, features: { mentor: 40, vision: 45, daily: 10 }, reserve_usd: 5,
  per_user_monthly_usd: 1.5, per_user_daily_images: 5,
  prices: { "claude-haiku-5-5": { input: 0.10, output: 0.50, cache_read: 0.01, cache_write: 0.125 }, "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.10, cache_write: 2.50 } }
};
const LEVELS = [70, 85, 95, 100], STALE_MS = 10 * 60e3;
const r6 = x => Math.round(x * 1e6) / 1e6;
const err = (status, code, message) => Object.assign(new Error(message || code), { status, code });
/* оценка входных токенов: ~3 символа на токен для RU/UA текста, +30% (новый токенизатор моделей 4.7+); изображение — по формуле документации (w·h/750, после уменьшения до 1568 px) */
function estimateInputTokens(chars, images = []) {
  const img = images.reduce((n, im) => { const k = Math.min(1, 1568 / Math.max(im.w, im.h)); return n + Math.ceil((im.w * k) * (im.h * k) / 750); }, 0);
  return Math.ceil(chars / 3 * 1.3) + img;
}
function costOf(usage, price) {
  const u = usage || {};
  return r6(((u.input_tokens || 0) * price.input + (u.output_tokens || 0) * price.output + (u.cache_read_input_tokens || 0) * price.cache_read + (u.cache_creation_input_tokens || 0) * price.cache_write) / 1e6);
}
function createBudget({ db, now = () => Date.now(), log = console }) {
  const col = n => db.collection(n), month = () => berlinDateKey(now()).slice(0, 7), day = () => berlinDateKey(now());
  async function settings() { const s = await col("ai_settings").doc("budget").get(); const v = s.exists ? s.data() : {};
    return { ...DEFAULTS, ...v, features: { ...DEFAULTS.features, ...(v.features || {}) }, prices: { ...DEFAULTS.prices, ...(v.prices || {}) } }; }
  async function setSettings(b) {
    b = b || {}; const out = {}, num = (v, lo, hi, name) => { const x = Number(v); if (!Number.isFinite(x) || x < lo || x > hi) throw err(400, "INVALID", `${name}: ${lo}–${hi}`); return x; };
    out.monthly_total_usd = num(b.monthly_total_usd, 0, 100000, "monthly_total_usd"); out.reserve_usd = num(b.reserve_usd, 0, 100000, "reserve_usd");
    out.features = {}; for (const f of FEATURES) out.features[f] = num((b.features || {})[f], 0, 100000, "features." + f);
    if (out.features.mentor + out.features.vision + out.features.daily + out.reserve_usd > out.monthly_total_usd + 1e-9) throw err(400, "INVALID", "Сумма долей и резерва больше общего лимита");
    out.per_user_monthly_usd = num(b.per_user_monthly_usd, 0, 10000, "per_user_monthly_usd"); out.per_user_daily_images = Math.round(num(b.per_user_daily_images, 0, 1000, "per_user_daily_images"));
    if (b.prices) { out.prices = {}; for (const [m, p] of Object.entries(b.prices)) { if (!/^[a-z0-9.-]{3,60}$/.test(m)) throw err(400, "INVALID", "модель");
      out.prices[m] = { input: num(p.input, 0, 1000, "price"), output: num(p.output, 0, 1000, "price"), cache_read: num(p.cache_read, 0, 1000, "price"), cache_write: num(p.cache_write, 0, 1000, "price") }; } }
    await col("ai_settings").doc("budget").set({ ...out, updated_at: now() }, { merge: true }); return settings();
  }
  async function priceOf(model) { const s = await settings(); const p = s.prices[model]; if (!p) throw err(503, "AI_PRICE_UNKNOWN", "Нет цены для модели " + model); return p; }
  const monthRef = () => col("ai_budget").doc(month()), userRef = uid => col("ai_budget_users").doc(`${uid}__${month()}`);
  const clean = (doc, t) => { for (const [id, r] of Object.entries(doc.reservations || {})) if (t - r.at > STALE_MS) { const f = doc.features[r.feature] || (doc.features[r.feature] = { spent: 0, reserved: 0 });
    f.reserved = r6(Math.max(0, f.reserved - r.amount)); doc.reserved_total = r6(Math.max(0, doc.reserved_total - r.amount)); delete doc.reservations[id]; } };
  const empty = () => ({ month: month(), spent_total: 0, reserved_total: 0, features: Object.fromEntries(FEATURES.map(f => [f, { spent: 0, reserved: 0 }])), reservations: {}, requests: {} });
  /* резерв: { id, amount } или ошибка BUDGET_EXHAUSTED / USER_BUDGET */
  async function reserve(feature, amount, uid = null) {
    if (!FEATURES.includes(feature)) throw err(400, "INVALID", "feature"); const s = await settings(), t = now(), id = crypto.randomBytes(8).toString("hex");
    amount = Math.ceil(Math.max(0, Number(amount) || 0) * 1e6) / 1e6;   // сумма резерва — сразу в 6 знаках (вверх): возврат точно обнуляет резерв, без накопления остатков
    await db.runTransaction(async tx => {
      const ms = await tx.get(monthRef()), us = uid ? await tx.get(userRef(uid)) : null;
      const doc = ms.exists ? { ...empty(), ...ms.data() } : empty(); doc.features = { ...empty().features, ...doc.features }; doc.reservations = { ...(doc.reservations || {}) }; clean(doc, t);
      const used = f => doc.features[f].spent + doc.features[f].reserved;
      const reserveUsed = FEATURES.reduce((n, f) => n + Math.max(0, used(f) - s.features[f]), 0), reserveLeft = Math.max(0, s.reserve_usd - reserveUsed);
      const featureRoom = Math.max(0, s.features[feature] - used(feature)) + reserveLeft;
      if (amount > featureRoom + 1e-12 || doc.spent_total + doc.reserved_total + amount > s.monthly_total_usd + 1e-12) throw err(429, "BUDGET_EXHAUSTED", "Месячный лимит ИИ исчерпан");
      const u = us && us.exists ? { spent: 0, reserved: 0, reservations: {}, ...us.data() } : { uid, month: month(), spent: 0, reserved: 0, reservations: {} };
      if (uid) { for (const [rid, r] of Object.entries(u.reservations || {})) if (t - r.at > STALE_MS) { u.reserved = r6(Math.max(0, u.reserved - r.amount)); delete u.reservations[rid]; }
        if (u.spent + u.reserved + amount > s.per_user_monthly_usd + 1e-12) throw err(429, "USER_BUDGET", "Месячный лимит ИИ для ученика исчерпан"); }
      doc.features[feature].reserved = r6(doc.features[feature].reserved + amount); doc.reserved_total = r6(doc.reserved_total + amount);
      doc.reservations[id] = { feature, amount, at: t, uid }; tx.set(monthRef(), doc);
      if (uid) { u.reserved = r6(u.reserved + amount); u.reservations = { ...(u.reservations || {}), [id]: { amount, at: t, feature } }; tx.set(userRef(uid), u); }
    });
    return { id, amount, feature, uid };
  }
  /* списание фактической стоимости (actual = 0 — возврат резерва без расхода) */
  async function settle(res, actual, meta = {}) {
    if (!res) return; const t = now();
    await db.runTransaction(async tx => {
      const ms = await tx.get(monthRef()), us = res.uid ? await tx.get(userRef(res.uid)) : null; const doc = ms.exists ? { ...empty(), ...ms.data() } : empty();
      doc.features = { ...empty().features, ...doc.features }; doc.reservations = { ...(doc.reservations || {}) }; doc.requests = { ...(doc.requests || {}) };
      const r = doc.reservations[res.id], f = doc.features[res.feature];
      if (r) { f.reserved = r6(Math.max(0, f.reserved - r.amount)); doc.reserved_total = r6(Math.max(0, doc.reserved_total - r.amount)); delete doc.reservations[res.id]; }
      f.spent = r6(f.spent + actual); doc.spent_total = r6(doc.spent_total + actual);
      if (meta.counted !== false) { const k = res.feature + (meta.ok === false ? "_errors" : "_requests"); doc.requests[k] = (doc.requests[k] || 0) + 1; }
      for (const [k, v] of Object.entries(meta.tokens || {})) doc.requests[`${res.feature}_${k}`] = (doc.requests[`${res.feature}_${k}`] || 0) + v;
      tx.set(monthRef(), doc);
      if (us) { const u = us.exists ? { spent: 0, reserved: 0, reservations: {}, ...us.data() } : { uid: res.uid, month: month(), spent: 0, reserved: 0, reservations: {} };
        const ur = (u.reservations || {})[res.id]; if (ur) { u.reserved = r6(Math.max(0, u.reserved - ur.amount)); delete u.reservations[res.id]; }
        u.spent = r6(u.spent + actual); u.updated_at = t; tx.set(userRef(res.uid), u); }
    });
  }
  const release = (res, meta = {}) => settle(res, 0, { ...meta, ok: false });
  /* дневной лимит скриншотов ученика (атомарно; возврат при ошибке) */
  async function takeImageSlot(uid, count) {
    const s = await settings(), ref = col("ai_budget_images").doc(`${uid}__${day()}`);
    const ok = await db.runTransaction(async tx => { const x = await tx.get(ref), n = x.exists ? x.data().count || 0 : 0; if (n + count > s.per_user_daily_images) return false; tx.set(ref, { uid, day: day(), count: n + count }); return true; });
    if (!ok) throw err(429, "IMAGE_LIMIT", "Дневной лимит разборов скриншотов исчерпан");
    return async () => db.runTransaction(async tx => { const x = await tx.get(ref); if (x.exists) tx.set(ref, { ...x.data(), count: Math.max(0, (x.data().count || 0) - count) }); });
  }
  async function status() {
    const s = await settings(), ms = await monthRef().get(), doc = ms.exists ? { ...empty(), ...ms.data() } : empty(); doc.features = { ...empty().features, ...doc.features };
    const pct = (a, b) => b > 0 ? Math.round(a / b * 1000) / 10 : 0, level = p => LEVELS.filter(l => p >= l).pop() || 0;
    const [y, m] = month().split("-").map(Number), dim = new Date(Date.UTC(y, m, 0)).getUTCDate(), dayN = Number(day().slice(8, 10));
    const users = (await col("ai_budget_users").where("month", "==", month()).get()).docs.map(d => d.data()).sort((a, b) => b.spent - a.spent).slice(0, 10).map(u => ({ uid: u.uid, spent_usd: r6(u.spent) }));
    const used = doc.spent_total + doc.reserved_total;
    return { month: month(), settings: s, total: { cap_usd: s.monthly_total_usd, spent_usd: r6(doc.spent_total), reserved_usd: r6(doc.reserved_total), left_usd: r6(Math.max(0, s.monthly_total_usd - used)), percent: pct(used, s.monthly_total_usd), warning_level: level(pct(used, s.monthly_total_usd)),
        forecast_usd: r6(dayN ? doc.spent_total / dayN * dim : 0) },
      features: Object.fromEntries(FEATURES.map(f => { const x = doc.features[f], u2 = x.spent + x.reserved; return [f, { cap_usd: s.features[f], spent_usd: r6(x.spent), reserved_usd: r6(x.reserved), percent: pct(u2, s.features[f]), warning_level: level(pct(u2, s.features[f])),
        requests: (doc.requests || {})[f + "_requests"] || 0, errors: (doc.requests || {})[f + "_errors"] || 0, input_tokens: (doc.requests || {})[f + "_input_tokens"] || 0, output_tokens: (doc.requests || {})[f + "_output_tokens"] || 0 }]; })),
      reserve_usd: s.reserve_usd, top_users: users, open_reservations: Object.keys(doc.reservations || {}).length };
  }
  return { settings, setSettings, priceOf, reserve, settle, release, takeImageSlot, status, costOf, estimateInputTokens };
}
module.exports = { createBudget, costOf, estimateInputTokens, DEFAULTS, FEATURES, LEVELS };
