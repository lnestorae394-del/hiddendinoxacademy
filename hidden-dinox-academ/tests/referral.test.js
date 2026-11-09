"use strict";
/* Реферальная программа и финансовый журнал: node --test tests/referral.test.js
   Настоящие обработчики, тестовая Firestore с ограничениями настоящего Firestore, настоящий путь доступа (postback). */
const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify, fakeRes, fakeReq } = require("./helpers/http");
const { adminCaller } = require("./helpers/router");
const { createAdminApi } = require("../academy/admin-api");
const { createAcademyApi } = require("../academy/api");
const { createAcademyPostback } = require("../academy/postback");
const { registerReferralRoutes, createReferral, autoReferral, configOf } = require("../academy/referral");
const SECRET = "test-postback-secret-0123456789abcdef";
const quiet = { log() {}, warn() {}, error() {} };

function setup(mode = "test", payouts = "1") {
  process.env.REFERRAL_MODE = mode; process.env.REFERRAL_PAYOUTS_ENABLED = payouts;
  const env = { REFERRAL_MODE: mode, REFERRAL_PAYOUTS_ENABLED: payouts };
  const db = new FakeFirestore();
  let t = 1_800_000_000_000; const now = () => t;
  const auto = autoReferral({ db, env, log: quiet, now });                 // тот же код подключения, что на сервере
  const academyApi = createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet, now, onAccessChange: auto.onAccessChange });
  const adminApi = createAdminApi({ db, verifyIdToken: fakeVerify, log: quiet, now });
  const pb = auto.wrapPostback(createAcademyPostback({ db, env: { POCKET_POSTBACK_SECRET: SECRET }, log: quiet, now }));
  const routes = [];
  const router = { get: (p, h) => routes.push(["GET", p, h]), post: (p, h) => routes.push(["POST", p, h]), put: (p, h) => routes.push(["PUT", p, h]) };
  registerReferralRoutes(router, { db, academyApi, env, now, log: quiet });
  const U = async (method, path, { uid, body } = {}) => {
    // как в интерфейсе: пользователь вписывает свой Trader ID (если тест не задал его явно)
    if (path === "/referral/withdrawals" && body && body.trader_id === undefined && uid) { const u = (await db.collection("users").doc(uid).get()).data(); body = { ...body, trader_id: u && u.trader_id ? String(u.trader_id) : "" }; }
    for (const [m, p, h] of routes) {
      if (m !== method) continue;
      const rx = new RegExp("^" + p.replace(/:[a-z]+/g, "([^/]+)") + "$"); const mm = path.match(rx); if (!mm) continue;
      const params = {}; (p.match(/:[a-z]+/g) || []).forEach((k, i) => (params[k.slice(1)] = decodeURIComponent(mm[i + 1])));
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
      await h({ headers: uid ? { authorization: "Bearer testtoken-" + uid } : {}, body: body || {}, params, query: {} }, res); return res;
    }
    throw new Error("no route " + method + " " + path);
  };
  const A = adminCaller(adminApi);
  const user = (uid, extra = {}) => db.collection("users").doc(uid).set({ email: uid + "@test.local", role: "student", created_at: t - 1000, ...extra }, { merge: true });
  async function giveAccess(uid, trader) {          // настоящий путь: регистрация у брокера → привязка Trader ID → FTD $60 через postback
    await academyApi.me(fakeReq({ token: "testtoken-" + uid }), fakeRes());
    await pb.handle({ type: "registration", trader_id: trader, secret: SECRET });
    await academyApi.traderId(fakeReq({ token: "testtoken-" + uid, body: { traderId: trader } }), fakeRes());
    await pb.handle({ type: "ftd", trader_id: trader, amount: "60", currency: "USD", secret: SECRET });
  }
  return { db, U, A, user, giveAccess, advance: ms => { t += ms; }, pb, academyApi, now };
}
async function invite(s, referrer, invitee) {
  await s.user(referrer); await s.user(invitee);
  const me = await s.U("GET", "/referral/me", { uid: referrer });
  const r = await s.U("POST", "/referral/attach", { uid: invitee, body: { code: me.body.code } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body)); return me.body.code;
}
const ledger = async (db, uid) => (await db.collection("ledger").where("uid", "==", uid).get()).docs.map(d => ({ id: d.id, ...d.data() }));
const bal = async (db, uid, mode = "test") => { const d = await db.collection("partner_balances").doc(`${uid}__${mode}`).get(); return d.exists ? d.data() : null; };

test("атрибуция: код постоянный, привязка один раз, не к себе, только новый аккаунт, неверный код отклонён", async () => {
  const s = setup();
  const code = await invite(s, "refA", "invB");
  assert.equal((await s.U("GET", "/referral/me", { uid: "refA" })).body.code, code);                 // код не меняется
  assert.equal((await s.U("POST", "/referral/attach", { uid: "invB", body: { code } })).body.already, true);
  await s.user("refA2"); const code2 = (await s.U("GET", "/referral/me", { uid: "refA2" })).body.code;
  assert.equal((await s.U("POST", "/referral/attach", { uid: "invB", body: { code: code2 } })).body.already, true);   // переназначить нельзя
  assert.equal((await s.db.collection("referral_invites").doc("invB").get()).data().referrer_uid, "refA");
  assert.equal((await s.U("POST", "/referral/attach", { uid: "refA", body: { code } })).statusCode, 409);          // сам себя
  await s.user("old", { created_at: 1_800_000_000_000 - 8 * 86400000 });
  assert.equal((await s.U("POST", "/referral/attach", { uid: "old", body: { code } })).body.error, "ACCOUNT_TOO_OLD");
  assert.equal((await s.U("POST", "/referral/attach", { uid: "invB", body: { code: "<script>" } })).statusCode, 400);
  assert.equal((await s.U("GET", "/referral/me", {})).statusCode, 401);
});

test("режим off (по умолчанию): статусы считаются, денег нет — ни начислений, ни заявок", async () => {
  const s = setup("off");
  await invite(s, "refA", "invB"); await s.giveAccess("invB", "60000001");
  const me = await s.U("GET", "/referral/me", { uid: "refA" });
  assert.equal(me.body.mode, "off"); assert.equal(me.body.invites[0].status, "qualified");
  assert.equal((await ledger(s.db, "refA")).length, 0); assert.deepEqual(me.body.balances, {});
  assert.equal((await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: "req-00000001" } })).body.error, "REWARDS_DISABLED");
});

test("$10 только при подтверждённой СУММЕ депозитов от $50: $20 — нет; +$30 — ровно $10; +$500 — повторно не начисляется", async () => {
  const s = setup();
  await invite(s, "refA", "invB");
  await s.academyApi.me(fakeReq({ token: "testtoken-invB" }), fakeRes());
  await s.pb.handle({ type: "registration", trader_id: "60000002", secret: SECRET });
  await s.academyApi.traderId(fakeReq({ token: "testtoken-invB", body: { traderId: "60000002" } }), fakeRes());
  let me = await s.U("GET", "/referral/me", { uid: "refA" });
  assert.equal(me.body.invites[0].status, "trader_confirmed"); assert.equal((await ledger(s.db, "refA")).length, 0);
  await s.pb.handle({ type: "ftd", trader_id: "60000002", amount: "20", currency: "USD", secret: SECRET });      // $20 из $50
  me = await s.U("GET", "/referral/me", { uid: "refA" });
  assert.equal(me.body.invites[0].status, "ftd_confirmed"); assert.equal((await ledger(s.db, "refA")).length, 0);
  await s.pb.handle({ type: "redeposit", trader_id: "60000002", amount: "30", currency: "USD", secret: SECRET });  // $50 из $50
  me = await s.U("GET", "/referral/me", { uid: "refA" });
  assert.equal(me.body.invites[0].status, "rewarded"); assert.deepEqual((await ledger(s.db, "refA")).map(e => e.amount_cents), [1000]);
  await s.pb.handle({ type: "redeposit", trader_id: "60000002", amount: "500", currency: "USD", secret: SECRET });
  me = await s.U("GET", "/referral/me", { uid: "refA" });
  assert.deepEqual((await ledger(s.db, "refA")).map(e => e.amount_cents), [1000]);                              // тот же реферал — одно вознаграждение
});

test("одно вознаграждение $10 на приглашённого: повторные пересчёты, повторный postback и параллельные запросы не дублируют", async () => {
  const s = setup();
  await invite(s, "refA", "invB"); await s.giveAccess("invB", "60000003");
  await Promise.all([1, 2, 3, 4].map(() => s.U("GET", "/referral/me", { uid: "refA" })));
  await s.pb.handle({ type: "ftd", trader_id: "60000003", amount: "60", currency: "USD", secret: SECRET });       // повторная доставка FTD
  await s.U("GET", "/referral/me", { uid: "refA" });
  const l = await ledger(s.db, "refA");
  assert.deepEqual(l.map(e => [e.type, e.amount_cents, e.mode]), [["reward", 1000, "test"]]);
  assert.equal((await bal(s.db, "refA")).available_cents, 1000);
  const me = await s.U("GET", "/referral/me", { uid: "refA" });
  assert.equal(me.body.invites[0].status, "rewarded");
  assert.equal(JSON.stringify(me.body.invites).includes("invB"), false);                                         // чужие данные не раскрываются
});

test("антифрод: тот же Trader ID или тот же email — без вознаграждения (flagged)", async () => {
  const s = setup();
  await invite(s, "refA", "invB"); await s.user("invB", { email: "refA@test.local" }); await s.giveAccess("invB", "60000004");
  const me = await s.U("GET", "/referral/me", { uid: "refA" });
  assert.equal(me.body.invites[0].status, "flagged"); assert.equal((await ledger(s.db, "refA")).length, 0);
});

test("заявки на вывод: минимум $50, резерв, идемпотентность, параллельные заявки не уводят в минус", async () => {
  const s = setup(); await s.user("boss", { role: "super_admin" });
  await invite(s, "refA", "invB"); await s.giveAccess("invB", "60000005"); await s.giveAccess("refA", "60000006");
  await s.U("GET", "/referral/me", { uid: "refA" });
  assert.equal((await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 10, request_id: "req-small-01" } })).body.error, "INVALID_AMOUNT");
  assert.equal((await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: "req-00000001" } })).body.error, "INSUFFICIENT_BALANCE");
  const adj = await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", confirm: true, amount: 50, reason: "Тестовая корректировка", op_id: "op-00000001" } });
  assert.equal(adj.statusCode, 200, JSON.stringify(adj.body));
  assert.equal((await bal(s.db, "refA")).available_cents, 6000);
  const [w1, w2, w1dup] = await Promise.all([
    s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: "req-AAAA0001" } }),
    s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: "req-BBBB0002" } }),
    s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: "req-AAAA0001" } })]);
  const ok = [w1, w2].filter(r => r.statusCode === 200), bad = [w1, w2].filter(r => r.statusCode !== 200);
  assert.equal(ok.length, 1); assert.equal(bad[0].body.error, "INSUFFICIENT_BALANCE");
  const b = await bal(s.db, "refA"); assert.deepEqual([b.available_cents, b.reserved_cents], [1000, 5000]);
  assert.equal((await s.db.collection("withdrawals").get()).size, 1);
  if (w1.statusCode === 200) assert.equal(w1dup.body.withdrawal.id, w1.body.withdrawal.id);
});

test("отмена и отклонение освобождают резерв ровно один раз; «выплачено» — только с подтверждением и номером платежа", async () => {
  const s = setup(); await s.user("boss", { role: "super_admin" }); await s.user("adm", { role: "admin" });
  await s.user("refA"); await s.giveAccess("refA", "60000007");
  await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", confirm: true, amount: 150, reason: "Тест", op_id: "op-00000002" } });
  const w = (await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: "req-cancel01" } })).body.withdrawal;
  assert.equal((await s.U("POST", `/referral/withdrawals/${w.id}/cancel`, { uid: "refA" })).statusCode, 200);
  assert.equal((await s.U("POST", `/referral/withdrawals/${w.id}/cancel`, { uid: "refA" })).statusCode, 409);   // второй раз — нет
  await s.user("eve"); assert.equal((await s.U("POST", `/referral/withdrawals/${w.id}/cancel`, { uid: "eve" })).statusCode, 403);
  let b = await bal(s.db, "refA"); assert.deepEqual([b.available_cents, b.reserved_cents], [15000, 0]);
  const w2 = (await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: "req-reject01" } })).body.withdrawal;
  assert.equal((await s.A("POST", `/withdrawals/${w2.id}/status`, { uid: "adm", body: { status: "rejected" } })).body.error, "REASON_REQUIRED");
  assert.equal((await s.A("POST", `/withdrawals/${w2.id}/status`, { uid: "adm", body: { status: "rejected", note: "Не подтверждён аккаунт" } })).statusCode, 200);
  assert.equal((await s.A("POST", `/withdrawals/${w2.id}/status`, { uid: "adm", body: { status: "rejected", note: "ещё раз" } })).statusCode, 409);
  const w3 = (await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 100, request_id: "req-paid0001" } })).body.withdrawal;
  assert.equal((await s.A("POST", `/withdrawals/${w3.id}/status`, { uid: "adm", body: { status: "paid", confirm: true, payment_reference: "X" } })).body.error, "INVALID_TRANSITION");   // сначала processing
  await s.A("POST", `/withdrawals/${w3.id}/status`, { uid: "adm", body: { status: "processing" } });
  assert.equal((await s.A("POST", `/withdrawals/${w3.id}/status`, { uid: "adm", body: { status: "paid" } })).body.error, "PAYMENT_CONFIRMATION_REQUIRED");
  assert.equal((await s.A("POST", `/withdrawals/${w3.id}/status`, { uid: "adm", body: { status: "paid", confirm: true, payment_reference: "PO-TRANSFER-123" } })).statusCode, 200);
  assert.equal((await s.A("POST", `/withdrawals/${w3.id}/status`, { uid: "adm", body: { status: "rejected", note: "поздно" } })).statusCode, 409);
  b = await bal(s.db, "refA"); assert.deepEqual([b.available_cents, b.reserved_cents, b.paid_cents], [5000, 0, 10000]);
  // журнал сходится с балансом: сумма записей = доступно; резерв = резервы − освобождения − выплаты
  const l = await ledger(s.db, "refA");
  assert.equal(l.reduce((n, e) => n + e.amount_cents, 0), b.available_cents);
  assert.equal(-l.filter(e => e.type === "reserve").reduce((n, e) => n + e.amount_cents, 0) - l.filter(e => e.type === "release").reduce((n, e) => n + e.amount_cents, 0) - b.paid_cents, b.reserved_cents);
  const audit = (await s.db.collection("audit_logs").get()).docs.map(d => d.data().action);
  for (const a of ["partner.adjust", "withdrawal.rejected", "withdrawal.processing", "withdrawal.paid"]) assert.ok(audit.includes(a), a);
});

test("корректировки: только super_admin, обязательная причина, без ухода в минус, идемпотентны по op_id", async () => {
  const s = setup(); await s.user("boss", { role: "super_admin" }); await s.user("adm", { role: "admin" }); await s.user("refA");
  assert.equal((await s.A("POST", "/partners/refA/adjust", { uid: "adm", body: { type: "credit", confirm: true, amount: 10, reason: "x", op_id: "op-00000003" } })).statusCode, 403);
  assert.equal((await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", confirm: true, amount: 10, op_id: "op-00000003" } })).body.error, "REASON_REQUIRED");
  assert.equal((await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "debit", confirm: true, amount: 5, reason: "минус", op_id: "op-00000004" } })).body.error, "NEGATIVE_BALANCE");
  await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", confirm: true, amount: 10, reason: "бонус", op_id: "op-00000005" } });
  const again = await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", confirm: true, amount: 10, reason: "бонус", op_id: "op-00000005" } });
  assert.equal(again.body.duplicate, true); assert.equal((await bal(s.db, "refA")).available_cents, 1000);
});

test("админка партнёров: поиск по UID, Trader ID и коду; карточка; ученик без прав — 403", async () => {
  const s = setup(); await s.user("adm", { role: "admin" });
  const code = await invite(s, "refAuidAAAAAAAAAAAAAAAAAA", "invB"); await s.giveAccess("refAuidAAAAAAAAAAAAAAAAAA", "60000008");
  for (const q of ["refAuidAAAAAAAAAAAAAAAAAA", "60000008", code]) {
    const r = await s.A("GET", "/partners", { uid: "adm", query: { q } });
    assert.deepEqual(r.body.results.map(x => x.uid), ["refAuidAAAAAAAAAAAAAAAAAA"], q);
  }
  const p = await s.A("GET", "/partners/refAuidAAAAAAAAAAAAAAAAAA", { uid: "adm" });
  assert.equal(p.body.invites.length, 1); assert.equal(p.body.trader_id, "60000008");
  assert.equal((await s.A("GET", "/partners", { uid: "invB", query: { q: code } })).statusCode, 403);
  const st = await s.A("GET", "/partners/stats", { uid: "adm" }); assert.equal(st.body.invites_total, 1);
});

test("для заявки нужен подтверждённый Trader ID", async () => {
  const s = setup(); await s.user("boss", { role: "super_admin" }); await s.user("refA");
  await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", confirm: true, amount: 60, reason: "тест", op_id: "op-00000006" } });
  assert.equal((await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: "req-notrader1" } })).body.error, "TRADER_REQUIRED");
});

/* ===== Автоматическое начисление и режимы (ТЗ, этап 17) ===== */
const settle = () => new Promise(r => setTimeout(r, 20));   // хук после привязки Trader ID не блокирует ответ

test("причина «off не начисляет»: при REFERRAL_MODE не задан/off — записи нет, баланс $0.00, статус не «вознаграждён»", async () => {
  delete process.env.REFERRAL_MODE;
  assert.equal(configOf({}).mode, "off"); assert.equal(configOf({}).rewards, false); assert.equal(configOf({}).tracking, true);
  const s = setup("off", "0");
  await invite(s, "refA", "invB"); await s.giveAccess("invB", "61000001");
  const me = await s.U("GET", "/referral/me", { uid: "refA" });
  assert.equal((await ledger(s.db, "refA")).length, 0);
  assert.deepEqual(me.body.balance, { available_cents: 0, reserved_cents: 0, paid_cents: 0, earned_cents: 0 });
  assert.equal(me.body.invites[0].status, "qualified"); assert.equal(me.body.stats.rewarded, 0); assert.equal(me.body.flags.rewards, false);
});

test("live включается только с REFERRAL_LIVE_CONFIRMED=1; вывод — только с REFERRAL_PAYOUTS_ENABLED=1", () => {
  assert.equal(configOf({ REFERRAL_MODE: "live" }).mode, "off"); assert.match(configOf({ REFERRAL_MODE: "live" }).warning, /REFERRAL_LIVE_CONFIRMED/);
  assert.equal(configOf({ REFERRAL_MODE: "live", REFERRAL_LIVE_CONFIRMED: "1" }).mode, "live");
  assert.equal(configOf({ REFERRAL_MODE: "test" }).payouts, false); assert.equal(configOf({ REFERRAL_MODE: "test", REFERRAL_PAYOUTS_ENABLED: "1" }).payouts, true);
  assert.equal(configOf({ REFERRAL_MODE: "off", REFERRAL_PAYOUTS_ENABLED: "1" }).payouts, false);
  assert.equal(configOf({ REFERRAL_TRACKING_ENABLED: "0" }).tracking, false);
});

test("АВТОМАТИЧЕСКИ: $10.00 появляется сразу после postback FTD — партнёр кабинет не открывал; повторный postback дубля не даёт", async () => {
  const s = setup("test");
  await invite(s, "refA", "invB");                       // единственный вызов кабинета — до депозита
  await s.giveAccess("invB", "61000002");                 // postback FTD → хук → начисление
  let l = await ledger(s.db, "refA");
  assert.deepEqual(l.map(e => [e.type, e.amount_cents, e.mode, e.ref.invitee_trader_id]), [["reward", 1000, "test", "61000002"]]);
  assert.equal((await bal(s.db, "refA")).available_cents, 1000);
  for (let i = 0; i < 3; i++) await s.pb.handle({ type: "ftd", trader_id: "61000002", amount: "60", currency: "USD", secret: SECRET });
  await s.pb.handle({ type: "redeposit", trader_id: "61000002", amount: "100", currency: "USD", secret: SECRET });
  l = await ledger(s.db, "refA"); assert.equal(l.length, 1); assert.equal((await bal(s.db, "refA")).available_cents, 1000);
  assert.equal((await s.db.collection("referral_invites").doc("invB").get()).data().status, "rewarded");
});

test("АВТОМАТИЧЕСКИ: если FTD пришёл раньше привязки Trader ID — начисление при привязке", async () => {
  const s = setup("test");
  await invite(s, "refA", "invB");
  await s.academyApi.me(fakeReq({ token: "testtoken-invB" }), fakeRes());
  await s.pb.handle({ type: "registration", trader_id: "61000003", secret: SECRET });
  await s.pb.handle({ type: "ftd", trader_id: "61000003", amount: "60", currency: "USD", secret: SECRET });   // депозит до привязки
  assert.equal((await ledger(s.db, "refA")).length, 0);
  await s.academyApi.traderId(fakeReq({ token: "testtoken-invB", body: { traderId: "61000003" } }), fakeRes()); await settle();
  assert.deepEqual((await ledger(s.db, "refA")).map(e => e.amount_cents), [1000]);
});

test("неподтверждённый FTD не начисляет: ниже порога, без валюты, неверный секрет", async () => {
  const s = setup("test"); await invite(s, "refA", "invB");
  await s.academyApi.me(fakeReq({ token: "testtoken-invB" }), fakeRes());
  await s.pb.handle({ type: "registration", trader_id: "61000004", secret: SECRET });
  await s.academyApi.traderId(fakeReq({ token: "testtoken-invB", body: { traderId: "61000004" } }), fakeRes()); await settle();
  await s.pb.handle({ type: "ftd", trader_id: "61000004", amount: "20", currency: "USD", secret: SECRET });
  await s.pb.handle({ type: "ftd", trader_id: "61000004", amount: "60", secret: SECRET });              // без валюты — в ожидании
  await s.pb.handle({ type: "ftd", trader_id: "61000004", amount: "60", currency: "USD", secret: "wrong-secret-0123456789abcdef" });
  assert.equal((await ledger(s.db, "refA")).length, 0);
});

test("вывод: $49.99 отклоняется, $50.00 разрешён; без REFERRAL_PAYOUTS_ENABLED — PAYOUTS_DISABLED", async () => {
  const s = setup("test"); await s.user("boss", { role: "super_admin" }); await s.user("refA"); await s.giveAccess("refA", "61000005");
  await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", confirm: true, amount: 60, reason: "тест", op_id: "op-00000099" } });
  assert.equal((await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 49.99, request_id: "req-4999xxxx" } })).body.error, "INVALID_AMOUNT");
  const ok = await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: "req-5000xxxx" } });
  assert.equal(ok.statusCode, 200); assert.equal(ok.body.withdrawal.amount_cents, 5000); assert.equal(ok.body.withdrawal.trader_id, "61000005");
  const s2 = setup("test", "0"); await s2.user("refB"); 
  assert.equal((await s2.U("POST", "/referral/withdrawals", { uid: "refB", body: { amount: 50, request_id: "req-nopayout" } })).body.error, "PAYOUTS_DISABLED");
});

test("выплата: подтверждает только уполномоченный, дата выплаты фиксируется; кабинет показывает ID, сумму, Trader ID, даты и комментарий", async () => {
  const s = setup("test"); await s.user("boss", { role: "super_admin" }); await s.user("adm", { role: "admin" }); await s.user("mod", { role: "moderator" });
  await invite(s, "refA", "invB"); await s.giveAccess("invB", "61000006"); await s.giveAccess("refA", "61000007");
  await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", confirm: true, amount: 40, reason: "бонус за стрим", comment: "акция", op_id: "op-00000100" } });
  const w = (await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: "req-paidflow" } })).body.withdrawal;
  assert.equal((await s.A("POST", `/withdrawals/${w.id}/status`, { uid: "mod", body: { status: "processing" } })).statusCode, 403);
  await s.A("POST", `/withdrawals/${w.id}/status`, { uid: "adm", body: { status: "processing", note: "Перевожу через Pocket Partners" } });
  await s.A("POST", `/withdrawals/${w.id}/status`, { uid: "adm", body: { status: "paid", confirm: true, payment_reference: "PP-777", note: "Переведено" } });
  assert.equal((await s.A("POST", `/withdrawals/${w.id}/status`, { uid: "adm", body: { status: "paid", confirm: true, payment_reference: "PP-777" } })).statusCode, 409);
  const me = (await s.U("GET", "/referral/me", { uid: "refA" })).body;
  const mw = me.withdrawals[0];
  assert.deepEqual([mw.id, mw.amount_cents, mw.trader_id, mw.status, mw.reject_reason], [w.id, 5000, "61000007", "paid", null]);
  assert.equal(JSON.stringify(me).includes("Перевожу через Pocket Partners"), false);          // служебные заметки администратора не показываются
  assert.ok(mw.paid_at > 0 && mw.created_at > 0);
  const reward = me.ledger.find(e => e.type === "reward");
  assert.ok(reward.id && reward.created_at); assert.equal(reward.amount_cents, 1000); assert.equal(reward.invitee_trader_masked, "••••0006");
  assert.deepEqual(me.balance, { available_cents: 0, reserved_cents: 0, paid_cents: 5000, earned_cents: 5000 });
  assert.equal(JSON.stringify(me).includes("61000006"), false);           // полный Trader ID приглашённого не раскрывается
});

test("корректировка: требуется подтверждение и тип операции; комментарий сохраняется", async () => {
  const s = setup("test"); await s.user("boss", { role: "super_admin" }); await s.user("refA");
  assert.equal((await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", amount: 5, reason: "x", op_id: "op-00000200" } })).body.error, "CONFIRM_REQUIRED");
  assert.equal((await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "gift", confirm: true, amount: 5, reason: "x", op_id: "op-00000201" } })).body.error, "INVALID_TYPE");
  await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", confirm: true, amount: 5, reason: "x", comment: "за отзыв", op_id: "op-00000202" } });
  assert.equal((await ledger(s.db, "refA"))[0].comment, "за отзыв");
});

test("вывод: нужен полный Trader ID получателя, и он должен совпасть с подтверждённым Trader ID аккаунта", async () => {
  const s = setup(); await s.user("boss", { role: "super_admin" }); await s.user("refA"); await s.giveAccess("refA", "61000301");
  await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", confirm: true, amount: 60, reason: "тест", op_id: "op-00000301" } });
  assert.equal((await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: "req-tid00001", trader_id: "" } })).body.error, "TRADER_ID_REQUIRED");
  assert.equal((await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: "req-tid00002", trader_id: "61000302" } })).body.error, "TRADER_MISMATCH");
  assert.equal((await bal(s.db, "refA")).reserved_cents, 0);                                         // ничего не зарезервировано
  const ok = await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: "req-tid00003", trader_id: " 61000301 " } });
  assert.equal(ok.statusCode, 200); assert.equal(ok.body.withdrawal.trader_id, "61000301");
});

test("историческая активация (доступ открыт до включения начислений): без автоматических $10; предпросмотр; начисление только по подтверждению, один раз", async () => {
  const off = setup("off", "0"); await invite(off, "refA", "invB"); await off.giveAccess("invB", "61000901");
  await off.user("boss", { role: "super_admin" }); await off.user("adm", { role: "admin" });
  const { createReferral, partnerAdmin } = require("../academy/referral");
  off.advance(60 * 60 * 1000);                                                             // начисления включили позже
  process.env.REFERRAL_MODE = "test";
  const on = createReferral({ db: off.db, env: { REFERRAL_MODE: "test" }, now: () => off.now() });
  await on.evaluateInvitee("invB");                                                        // любое событие — денег нет
  assert.equal((await off.db.collection("referral_invites").doc("invB").get()).data().status, "historical_review");
  assert.equal((await ledger(off.db, "refA")).length, 0);
  const pv = await on.previewHistorical();
  assert.deepEqual(pv.items.map(x => [x.invitee_uid, x.referrer_uid, x.already_rewarded]), [["invB", "refA", false]]);
  assert.equal((await ledger(off.db, "refA")).length, 0);                                    // предпросмотр ничего не начисляет
  const ap = await on.approveHistorical(["invB"], "boss", "Доступ открыт до включения программы, проверено");
  assert.deepEqual(ap, [{ invitee_uid: "invB", status: "rewarded" }]);
  assert.deepEqual(await on.approveHistorical(["invB"], "boss", "ещё раз"), [{ invitee_uid: "invB", status: "rewarded" }]);
  assert.deepEqual((await ledger(off.db, "refA")).map(e => e.amount_cents), [1000]);         // ровно одно начисление
});

test("новая активация доступа после включения начислений — $10 сразу; регистрация без доступа — ничего", async () => {
  const s = setup("test"); await invite(s, "refA", "invB"); await invite(s, "refA", "invC");
  await s.academyApi.me(fakeReq({ token: "testtoken-invC" }), fakeRes());                   // только регистрация
  await s.giveAccess("invB", "61000902");
  assert.deepEqual((await ledger(s.db, "refA")).map(e => [e.ref.invitee_uid, e.amount_cents]), [["invB", 1000]]);
});

test("причина отказа: стандартная — готовые переводы; своя — перевод один раз при сохранении; без перевода — без выдумки; резерв освобождается один раз", async () => {
  const s = setup("test"); await s.user("boss", { role: "super_admin" }); await s.user("adm", { role: "admin" }); await s.user("refA"); await s.giveAccess("refA", "61000903");
  await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", confirm: true, amount: 150, reason: "тест", op_id: "op-00000903" } });
  const mk = async rid => (await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: rid } })).body.withdrawal;
  const w1 = await mk("req-rr000001"), w2 = await mk("req-rr000002"), w3 = await mk("req-rr000003");
  assert.equal((await s.A("POST", `/withdrawals/${w1.id}/status`, { uid: "adm", body: { status: "rejected" } })).body.error, "REASON_REQUIRED");
  await s.A("POST", `/withdrawals/${w1.id}/status`, { uid: "adm", body: { status: "rejected", reason_code: "wrong_trader_id" } });
  assert.equal((await s.A("POST", `/withdrawals/${w1.id}/status`, { uid: "adm", body: { status: "rejected", reason_code: "wrong_trader_id" } })).statusCode, 409);
  const realFetch = global.fetch; let calls = 0;
  global.fetch = async (url, o) => { calls++; const b = JSON.parse(o.body); return { ok: true, json: async () => ({ translations: [{ text: b.target_lang === "UK" ? "Причина українською" : "Reason in English" }] }) }; };
  process.env.DEEPL_API_KEY = "test-key:fx";
  try { await s.A("POST", `/withdrawals/${w2.id}/status`, { uid: "adm", body: { status: "rejected", note: "Своя причина по-русски" } }); }
  finally { global.fetch = realFetch; delete process.env.DEEPL_API_KEY; }
  await s.A("POST", `/withdrawals/${w3.id}/status`, { uid: "adm", body: { status: "rejected", note: "Причина без перевода" } });
  const me = (await s.U("GET", "/referral/me", { uid: "refA" })).body; const by = id => me.withdrawals.find(w => w.id === id).reject_reason;
  assert.deepEqual([by(w1.id).code, by(w1.id).source, by(w1.id).en.startsWith("Request rejected: an incorrect Trader ID")], ["wrong_trader_id", "dictionary", true]);
  assert.deepEqual([by(w2.id).ru, by(w2.id).en, by(w2.id).ua, by(w2.id).source, calls], ["Своя причина по-русски", "Reason in English", "Причина українською", "deepl", 2]);
  assert.deepEqual([by(w3.id).ru, by(w3.id).en, by(w3.id).ua, by(w3.id).source], ["Причина без перевода", null, null, "unavailable"]);
  // повторное открытие кабинета не переводит заново
  await s.U("GET", "/referral/me", { uid: "refA" }); assert.equal(calls, 2);
  assert.deepEqual([(await bal(s.db, "refA")).available_cents, (await bal(s.db, "refA")).reserved_cents], [15000, 0]);
  const releases = (await ledger(s.db, "refA")).filter(e => e.type === "release"); assert.equal(releases.length, 3);
  const audit = (await s.db.collection("audit_logs").get()).docs.map(d => d.data()).filter(a => a.action === "withdrawal.rejected");
  assert.deepEqual(audit.map(a => a.details.note).sort(), ["Заявка отклонена: указан неверный Trader ID. Проверьте данные и отправьте новую заявку.", "Причина без перевода", "Своя причина по-русски"].sort());
});

test("причина отказа с переводами EN/UA от администратора: сохраняются как есть (source: manual), сервис перевода не вызывается", async () => {
  const s = setup("test"); await s.user("boss", { role: "super_admin" }); await s.user("adm", { role: "admin" }); await s.user("refA"); await s.giveAccess("refA", "61000904");
  await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", confirm: true, amount: 60, reason: "тест", op_id: "op-00000904" } });
  const w = (await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, request_id: "req-man00001" } })).body.withdrawal;
  const realFetch = global.fetch; let calls = 0; global.fetch = async () => { calls++; return { ok: false }; };
  try { await s.A("POST", `/withdrawals/${w.id}/status`, { uid: "adm", body: { status: "rejected", note: "Причина по-русски", note_en: "Reason in English", note_ua: "Причина українською" } }); }
  finally { global.fetch = realFetch; }
  const rr = (await s.U("GET", "/referral/me", { uid: "refA" })).body.withdrawals.find(x => x.id === w.id).reject_reason;
  assert.deepEqual([rr.ru, rr.en, rr.ua, rr.source, calls], ["Причина по-русски", "Reason in English", "Причина українською", "manual", 0]);
});

test("причина отказа: перевод только на UA — сохраняется, EN остаётся пустым (нейтральная фраза), без выдумки", async () => {
  const { buildRejectReason } = require("../academy/reason-i18n");
  const r = await buildRejectReason({ text: "Причина", ua: "Причина українською" }, {}, async () => { throw new Error("не должно вызываться"); });
  assert.deepEqual([r.ru, r.en, r.ua, r.source], ["Причина", null, "Причина українською", "manual"]);
});
