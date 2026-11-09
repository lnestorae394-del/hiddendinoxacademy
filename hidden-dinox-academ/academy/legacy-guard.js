"use strict";
/* Защита старых публичных маршрутов AI BOOST (/deposit, /dev-deposit, /setpair) и базовые заголовки безопасности.
   Аудит: /deposit без проверки позволял кому угодно «внести депозит» трейдера в память сервера (оттуда он попадал в deposits.json),
   /setpair менял общую пару без проверки значения. Теперь: депозит — только с секретом postback (сравнение за постоянное время), пара — только из списка. */
const crypto = require("crypto");
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const PAIR = /^[A-Z0-9]{2,8}(\/[A-Z0-9]{2,8})?$/, TRADER = /^[A-Za-z0-9_-]{1,64}$/;
const validPair = (p, list) => typeof p === "string" && p.length <= 17 && PAIR.test(p) && (!Array.isArray(list) || list.includes(p));
const validAmount = a => Number.isFinite(a) && a > 0 && a <= 1e6;
const secretOk = (provided, secret, min) => typeof provided === "string" && String(secret || "").length >= min && safeEqual(provided, secret);
/* /deposit: только с секретом POCKET_POSTBACK_SECRET (≥24 символов) — как у /postback */
function depositHandler({ env, getDeposits, log = console }) {
  return (req, res) => {
    const q = req.query || {};
    if (!secretOk(q.secret, env.POCKET_POSTBACK_SECRET, 24)) return res.status(403).json({ ok: false, error: "forbidden" });
    const trader = q.trader_id, amount = parseFloat(q.amount);
    if (typeof trader !== "string" || !TRADER.test(trader) || !validAmount(amount)) return res.status(400).json({ ok: false, error: "invalid" });
    getDeposits()[trader] = amount; log.log && log.log("💰 депозит (проверен секрет):", trader); return res.json({ ok: true });
  };
}
/* /dev-deposit: только при заданном DEV_KEY (≥16 символов); сравнение за постоянное время; значения проверяются */
function devDepositHandler({ env, getDeposits, log = console }) {
  return (req, res) => {
    const q = req.query || {};
    if (!secretOk(q.key, env.DEV_KEY, 16)) return res.status(403).send("forbidden");
    const trader = q.trader_id, amount = parseFloat(q.amount || 25);
    if (trader !== undefined) { if (typeof trader !== "string" || !TRADER.test(trader) || !validAmount(amount)) return res.status(400).send("invalid"); const d = getDeposits(); if (!d[trader] || amount > d[trader]) d[trader] = amount; log.log && log.log("🧪 TEST депозит:", trader); }
    return res.send("ok");
  };
}
/* /setpair: только пара из списка сервера */
function setPairHandler({ getPairs, setPair }) {
  return (req, res) => { const p = (req.query || {}).pair; if (p !== undefined && !validPair(p, getPairs())) return res.status(400).json({ ok: false, error: "invalid_pair" }); if (p) setPair(p); return res.json({ ok: true }); };
}
/* Базовые заголовки: без угадывания типа файла, ограниченный Referer, HSTS только по https (за прокси Render — по X-Forwarded-Proto).
   X-Frame-Options и CSP намеренно не задаются: страницы Academy используют встроенные скрипты и могут открываться внутри Telegram. */
function securityHeaders() {
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (req.secure || String((req.headers || {})["x-forwarded-proto"] || "").split(",")[0].trim() === "https") res.setHeader("Strict-Transport-Security", "max-age=15552000");
    next();
  };
}
module.exports = { safeEqual, validPair, validAmount, depositHandler, devDepositHandler, setPairHandler, securityHeaders };
