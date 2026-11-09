"use strict";
/* ТЕСТОВЫЙ депозит по Trader ID (без click_id) — ТОЛЬКО для эмулятора Firebase.

   Маршрут GET /test/deposit регистрируется сервером ТОЛЬКО если одновременно:
   - включён HD_TEST_MODE=1 (а он запускается лишь с эмуляторами, demo-проектом и без FIREBASE_KEY);
   - задан TEST_POSTBACK_SECRET (≥ 24 символов) и он НЕ совпадает с POCKET_POSTBACK_SECRET.
   В production (Render) маршрут не существует: запрос получает обычный 404.

   Принимается только ЗАРАНЕЕ ПОДТВЕРЖДЁННЫЙ Trader ID: у него должна быть проверенная регистрация
   (registration postback) и привязка к пользователю академии; поиск — по trader_id, click_id не нужен,
   а депозит обрабатывается ТЕМИ ЖЕ правилами, что и настоящий postback (academy/deposits.js):
   принадлежность ID, валюта, сумма, уникальность события. Никакая проверка не отключается.
   Событие помечается test: true. */
const crypto = require("crypto");
const { parseAmountToCents } = require("./access");
const D = require("./deposits");

const MIN = 24;
const TRADER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const one = v => (Array.isArray(v) ? undefined : v);
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function testDepositConfig({ testMode, env }) {
  const secret = env.TEST_POSTBACK_SECRET || "";
  if (!testMode) return { enabled: false, reason: "HD_TEST_MODE не включён (production)" };
  if (secret.length < MIN) return { enabled: false, reason: "TEST_POSTBACK_SECRET не задан или короче 24 символов" };
  if (env.POCKET_POSTBACK_SECRET && secret === env.POCKET_POSTBACK_SECRET) return { enabled: false, reason: "TEST_POSTBACK_SECRET должен отличаться от POCKET_POSTBACK_SECRET" };
  return { enabled: true, secret };
}

const R = (http, status, message, extra = {}) => ({ http, status, message, ...extra });

function createTestDeposit({ db, secret, log = console, now = () => Date.now() }) {
  return async function handle(query = {}) {
    const given = one(query.test_secret);
    if (!given) return R(401, "secret_missing", "Нет параметра test_secret");
    if (!safeEqual(given, secret)) return R(403, "secret_invalid", "Неверный test_secret");
    const trader = one(query.trader_id), amountRaw = one(query.amount), cur = String(one(query.currency) || "").toUpperCase();
    if (!trader || !TRADER_RE.test(trader)) return R(400, "invalid_trader", "Некорректный trader_id");
    const cents = parseAmountToCents(amountRaw);
    if (cents === null || cents <= 0) return R(400, "invalid_amount", "Некорректная сумма amount");
    if (!D.CURRENCY_RE.test(cur)) return R(400, "invalid_currency", "Нужен параметр currency, например USD");
    const type = one(query.type) === "redeposit" ? "redeposit" : "ftd";
    if (!db) return R(503, "no_db", "Firebase (эмулятор) не подключён");

    const eventId = String(one(query.event_id) || "1").slice(0, 64);
    const key = "test_" + crypto.createHash("sha256").update(JSON.stringify([trader, type, cents, cur, eventId])).digest("hex").slice(0, 40);
    const refRef = db.collection("referrals").doc(trader);
    const evRef = db.collection("postback_events").doc(key);

    const res = await db.runTransaction(async tx => {
      const ev = await tx.get(evRef);
      if (ev.exists) return { status: "duplicate" };
      const refDoc = await tx.get(refRef);
      const bind = await tx.get(db.collection("trader_bindings").doc(trader));
      const academy = (refDoc.exists && refDoc.data().academy) || {};
      const reg = academy.registration;
      const binding = bind.exists ? bind.data() : null;
      // Только заранее подтверждённый ID: проверенная регистрация + привязка к пользователю академии,
      // и регистрация не принадлежит другому пользователю
      if (!reg || reg.verified !== true) return { status: "trader_not_confirmed" };
      let regClickUid = null;
      if (!reg.uid && typeof reg.click_id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(reg.click_id)) {
        const c = await tx.get(db.collection("clicks").doc(reg.click_id)); regClickUid = c.exists ? c.data().uid : null;
      }
      const owner = reg.uid || regClickUid;
      if (!binding || !binding.uid || (owner && owner !== binding.uid)) return { status: "trader_not_bound" };
      const uid = binding.uid;
      const userDoc = await tx.get(db.collection("users").doc(uid));
      const ctx = { trader, binding, regClickUid, user: userDoc.exists ? userDoc.data() : null };

      const work = D.clone(academy);
      const t = now();
      const dep = { key, kind: type, amount_cents: cents, currency: cur, click_id: reg.click_id || null, uid, at: t, test: true };
      const r = D.applyIncomingDeposit(work, dep, ctx);
      tx.create(db.collection("deposit_events").doc(key), { trader_id: trader, click_id: reg.click_id || null, uid, kind: type, amount_cents: cents, currency: cur, status: r.depositStatus, counted_in_totals: r.depositStatus === "counted", at: t, test: true });
      if (JSON.stringify(work) !== JSON.stringify(academy)) tx.set(refRef, { academy: work }, { merge: true });
      tx.create(evRef, { kind: type, status: r.status, uid, trader_id: trader, click_id: reg.click_id || null, amount_raw: String(amountRaw).slice(0, 32), currency: cur, received_at: t, test: true });
      return { status: r.status, uid };
    });

    const map = {
      ftd_recorded: [200, "Тестовый первый депозит учтён"], redeposit_recorded: [200, "Тестовый повторный депозит учтён"],
      ftd_exists_counted_as_deposit: [200, "Первый депозит уже был; учтён как обычный"], duplicate: [200, "Это тестовое событие уже обработано (добавьте &event_id=2 для нового)"],
      trader_not_confirmed: [422, "Trader ID не подтверждён: нет проверенной регистрации"], trader_not_bound: [422, "Trader ID не привязан к пользователю академии"],
      trader_mismatch: [409, "У пользователя привязан другой Trader ID"], conflict_click: [409, "Конфликт регистрации"]
    };
    const [http, message] = map[res.status] || [500, "Неожиданный результат"];
    log.log && log.log("🧪 test deposit:", res.status, "→", http);
    return R(http, res.status, message, { test: true });
  };
}

module.exports = { testDepositConfig, createTestDeposit };
