"use strict";
/* Тесты серверной логики академии: node --test tests/academy.test.js
   Тестовая Firestore в памяти и тестовая проверка токенов. Реальные postback,
   Firebase, депозиты и выплаты НЕ используются. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeReq, fakeRes, fakeVerify } = require("./helpers/http");
const { createAcademyApi } = require("../academy/api");
const { createAcademyPostback } = require("../academy/postback");
const { evaluateAccess, parseAmountToCents, ACCESS_MIN_USD_CENTS } = require("../academy/access");
const { parseServiceAccount } = require("../academy/firebase-init");
const { reprocessAll, reprocessTrader } = require("../academy/reprocess");
const { runAudit } = require("../academy/audit");

const SECRET = "test-secret-0123456789abcdef-XYZ"; // ≥ 24 символов
const quiet = { log() {}, warn() {}, error() {} };

function setup(env = {}) {
  const db = new FakeFirestore();
  let n = 0;
  const api = createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet, newClickId: () => "hd_testclick" + String(++n).padStart(4, "0") });
  const pb = createAcademyPostback({ db, env: { POCKET_POSTBACK_SECRET: SECRET, ...env }, log: quiet });
  const call = async (h, uid, body) => { const res = fakeRes(); await api[h](fakeReq({ token: uid && "testtoken-" + uid, body }), res); return res; };
  const post = (q, ip) => pb.handle(q, { ip });
  const reg = (click, trader, extra = {}) => post({ click_id: click, trader_id: trader, secret: SECRET, ...extra });
  const ftd = (click, trader, amount, extra = {}) => post({ click_id: click, trader_id: trader, amount: String(amount), currency: "USD", secret: SECRET, ...extra });
  const redep = (click, trader, amount, extra = {}) => post({ type: "redeposit", click_id: click, trader_id: trader, amount: String(amount), currency: "USD", secret: SECRET, ...extra });
  const bind = (uid, traderId, extra = {}) => call("traderId", uid, { traderId, ...extra });
  const me = async uid => (await call("me", uid)).body;
  const clickOf = async uid => { await call("me", uid); return (await call("click", uid)).body.clickId; };
  // Полный правильный путь: аккаунт → переход по ссылке (click) → postback регистрации → ввод ID
  async function ready(uid, trader) {
    const click = await clickOf(uid);
    assert.equal((await reg(click, trader)).status, "registration_confirmed");
    const r = await bind(uid, trader);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    return click;
  }
  return { db, api, pb, call, post, reg, ftd, redep, bind, me, clickOf, ready };
}

/* ======================= 1. Postback: аутентификация источника ======================= */
test("postback без настроенного POCKET_POSTBACK_SECRET → 503, ничего не записано", async () => {
  for (const env of [{ POCKET_POSTBACK_SECRET: "" }, { POCKET_POSTBACK_SECRET: "short-secret" }]) {
    const s = setup(env);
    const r = await s.post({ click_id: "hd_testclick0001", trader_id: "10000001", secret: "short-secret" });
    assert.equal(r.status, "not_configured"); assert.equal(r.http, 503);
    assert.equal(s.db.writes, 0);
  }
});

test("postback без secret → 401, с неверным → 403, повторённый параметр → 401; записей нет", async () => {
  const s = setup();
  const click = await s.clickOf("u1"); const before = s.db.writes;
  const a = await s.post({ click_id: click, trader_id: "10000001" });
  const b = await s.post({ click_id: click, trader_id: "10000001", secret: "wrong-secret-0123456789abcdef" });
  const c = await s.post({ click_id: click, trader_id: "10000001", secret: [SECRET, SECRET] });
  assert.deepEqual([a.http, b.http, c.http], [401, 403, 401]);
  assert.equal(s.db.writes, before);
});

test("ограничение по IP (если задано): посторонний IP → 403", async () => {
  const s = setup({ POSTBACK_ALLOWED_IPS: "203.0.113.10" });
  const click = await s.clickOf("u1");
  assert.equal((await s.post({ click_id: click, trader_id: "10000001", secret: SECRET }, "198.51.100.7")).http, 403);
  assert.equal((await s.post({ click_id: click, trader_id: "10000001", secret: SECRET }, "203.0.113.10")).http, 200);
});

/* ======================= 2. Postback: параметры ======================= */
test("неподставленный макрос ({click_id}, {trader_id}, {sum}) → 400", async () => {
  const s = setup();
  const click = await s.clickOf("u1");
  for (const q of [{ click_id: "{click_id}", trader_id: "10000001" }, { click_id: click, trader_id: "{trader_id}" }, { click_id: click, trader_id: "10000001", amount: "{sum}" }]) {
    const r = await s.post({ ...q, secret: SECRET });
    assert.equal(r.status, "macro_not_substituted", JSON.stringify(q)); assert.equal(r.http, 400);
  }
});

test("некорректные параметры → 400; cid/sub1/payout/sum не используются вместо trader_id и amount", async () => {
  const s = setup();
  const click = await s.clickOf("u1");
  const cases = [
    [{ click_id: click }, "invalid_trader"], [{ click_id: click, sub1: "10000001" }, "invalid_trader"],
    [{ click_id: "bad click!", trader_id: "10000001" }, "invalid_click"],
    [{ click_id: click, trader_id: "10000001", type: "bonus" }, "unknown_type"],
    [{ click_id: click, trader_id: "10000001", type: "redeposit" }, "invalid_amount"], [{ click_id: click, trader_id: "10000001", type: "ftd" }, "invalid_amount"],
    [{ click_id: click, trader_id: "10000001", type: "ftd", amount: "0" }, "invalid_amount"], [{ click_id: click, trader_id: "10000001", type: "ftd", sum: "50" }, "invalid_amount"],
    [{ click_id: click, trader_id: "10000001", amount: "40,00", type: "ftd" }, "invalid_amount"], [{ click_id: click, trader_id: "10000001", amount: "-5", type: "ftd" }, "invalid_amount"]
  ];
  for (const [q, status] of cases) { const r = await s.post({ ...q, secret: SECRET }); assert.equal(r.status, status, JSON.stringify(q)); assert.equal(r.http, 400); }
  assert.equal(Object.keys(s.db.dump("referrals")).length, 0);
});
test("click_id Pocket Partners (не из академии): регистрация и депозит находятся по trader_id", async () => {
  const s = setup();
  const r1 = await s.reg("ppclick_000777", "10000009");
  assert.deepEqual([r1.http, r1.status, r1.clickKnown], [200, "registration_confirmed", false]);
  const reg = s.db.dump("referrals")["10000009"].academy.registration;
  assert.equal(reg.click_id, "ppclick_000777"); assert.equal(reg.uid, null);         // click_id сохранён для аналитики
  const r2 = await s.ftd("ppclick_000777", "10000009", "69");
  assert.equal(r2.status, "ftd_recorded");
  await s.call("me", "u1");
  assert.equal((await s.bind("u1", "10000009")).statusCode, 200);                   // пользователь вводит только Trader ID
  const p = await s.me("u1");
  assert.equal(p.academyAccess, true); assert.equal(p.firstDeposit.amount, 69);
});
/* ======================= 3. Три вида событий и дубли ======================= */
test("регистрация → 200; повторная доставка → 200 duplicate; без изменений данных", async () => {
  const s = setup();
  const click = await s.clickOf("u1");
  const a = await s.reg(click, "10000001"), b = await s.reg(click, "10000001");
  assert.equal(a.status, "registration_confirmed"); assert.equal(a.http, 200);
  assert.equal(b.status, "duplicate"); assert.equal(b.http, 200);
  assert.equal(s.db.dump("referrals")["10000001"].academy.registration.click_id, click);
});

test("первый депозит и повторный депозит → 200; повторная доставка каждого — duplicate", async () => {
  const s = setup();
  const click = await s.ready("u1", "10000001");
  assert.equal((await s.ftd(click, "10000001", "40")).status, "ftd_recorded");
  assert.equal((await s.ftd(click, "10000001", "40")).status, "duplicate");
  assert.equal((await s.redep(click, "10000001", "60")).status, "redeposit_recorded");
  assert.equal((await s.redep(click, "10000001", "60")).status, "duplicate");
  const p = await s.me("u1");
  assert.equal(p.firstDeposit.amount, 40);
  assert.deepEqual(p.deposits, { count: 2, totals: { USD: 100 }, unknownCurrencyCount: 0 });
});

test("Trader ID уже подтверждён с другим click_id → 409", async () => {
  const s = setup();
  const a = await s.clickOf("a"), b = await s.clickOf("b");
  await s.reg(a, "10000001");
  const r = await s.reg(b, "10000001");
  assert.equal(r.status, "conflict_click"); assert.equal(r.http, 409);
});

test("параллельная доставка одного события учитывается один раз", async () => {
  const s = setup();
  const click = await s.ready("u1", "10000001");
  await s.ftd(click, "10000001", "40");
  const out = await Promise.all(Array.from({ length: 8 }, () => s.redep(click, "10000001", "60")));
  assert.equal(out.filter(r => r.status === "redeposit_recorded").length, 1);
  assert.deepEqual((await s.me("u1")).deposits, { count: 2, totals: { USD: 100 }, unknownCurrencyCount: 0 });
});

test("параллельные разные депозиты: итог не теряет обновлений", async () => {
  const s = setup();
  const click = await s.ready("u1", "10000001");
  await s.ftd(click, "10000001", "40");
  await Promise.all([10, 20, 30, 40, 50].map(a => s.redep(click, "10000001", a, { n: String(a) })));
  assert.deepEqual((await s.me("u1")).deposits, { count: 6, totals: { USD: 190 }, unknownCurrencyCount: 0 });
});

test("ошибка Firebase при postback → 503 (платформа повторит), ничего не записано", async () => {
  const s = setup();
  const click = await s.clickOf("u1");
  s.db.failAll = true;
  const r = await s.reg(click, "10000001");
  s.db.failAll = false;
  assert.equal(r.status, "db_error"); assert.equal(r.http, 503);
  assert.equal(s.db.dump("referrals")["10000001"], undefined);
  assert.equal((await s.reg(click, "10000001")).status, "registration_confirmed"); // повтор после восстановления проходит
});

test("Firebase не подключён → postback 503", async () => {
  const pb = createAcademyPostback({ db: null, env: { POCKET_POSTBACK_SECRET: SECRET }, log: quiet });
  const r = await pb.handle({ click_id: "hd_testclick0001", trader_id: "10000001", secret: SECRET });
  assert.equal(r.status, "no_db"); assert.equal(r.http, 503);
});

/* ======================= 4. Защита Trader ID ======================= */
test("случайный Trader ID (без postback регистрации) отклоняется: 422", async () => {
  const s = setup();
  await s.clickOf("u1");
  const r = await s.bind("u1", "12345678");
  assert.equal(r.statusCode, 422); assert.equal(r.body.error, "TRADER_NOT_CONFIRMED");
  assert.equal(s.db.dump("users").u1.trader_id, null);
  assert.equal(s.db.dump("trader_bindings")["12345678"], undefined);
});

test("подтверждённый Trader ID (регистрация по ссылке этого пользователя) принимается", async () => {
  const s = setup();
  await s.ready("u1", "10000001");
  const p = await s.me("u1");
  assert.equal(p.stage, "deposit"); assert.equal(p.traderId, "10000001"); assert.equal(p.brokerRegistrationConfirmed, true);
});

test("чужой подтверждённый Trader ID отклоняется тем же ответом 422; владелец не затронут", async () => {
  const s = setup();
  const ownerClick = await s.ready("owner", "10000001");
  await s.ftd(ownerClick, "10000001", "60");
  await s.clickOf("eve");
  const r = await s.bind("eve", "10000001");
  assert.equal(r.statusCode, 422); assert.equal(r.body.error, "TRADER_NOT_CONFIRMED");
  assert.equal(s.db.dump("trader_bindings")["10000001"].uid, "owner");
  assert.equal((await s.me("owner")).academyAccess, true);
  assert.equal((await s.me("eve")).academyAccess, false);
});

test("ID, известный только по старой схеме AI BOOST (без подтверждения академии), отклоняется", async () => {
  const s = setup();
  const click = await s.clickOf("u1");
  await s.db.collection("referrals").doc("10000005").set({ trader_id: "10000005", click_id: click, deposit: 500 });
  const r = await s.bind("u1", "10000005");
  assert.equal(r.statusCode, 422);
});

test("пользователь, ни разу не получавший click_id, не может привязать ID", async () => {
  const s = setup();
  const other = await s.clickOf("other"); await s.reg(other, "10000001");
  await s.call("me", "u1");
  assert.equal((await s.bind("u1", "10000001")).statusCode, 422);
});

test("userId / approved / verified / depositAmount из браузера игнорируются", async () => {
  const s = setup();
  const victimClick = await s.ready("victim", "10000001");
  await s.ftd(victimClick, "10000001", "80");
  await s.clickOf("eve");
  const r = await s.bind("eve", "10000001", { userId: "victim", uid: "victim", approved: true, verified: true, depositAmount: 999, academyAccess: true, brokerRegistrationConfirmed: true });
  assert.equal(r.statusCode, 422);
  const u = s.db.dump("users").eve;
  for (const k of ["approved", "verified", "depositAmount", "academyAccess", "brokerRegistrationConfirmed", "userId"]) assert.equal(k in u, false, k);
  assert.equal(s.db.dump("users").victim.trader_id, "10000001");
});

test("смена на неподтверждённый ID отклоняется, текущая привязка сохраняется", async () => {
  const s = setup();
  await s.ready("u1", "10000001");
  assert.equal((await s.bind("u1", "10000002")).statusCode, 422);
  assert.equal(s.db.dump("users").u1.trader_id, "10000001");
  assert.equal(s.db.dump("trader_bindings")["10000001"].uid, "u1");
});

test("после подтверждённого первого депозита смена ID заблокирована (409 ID_LOCKED)", async () => {
  for (const amount of ["30", "60"]) {
    const s = setup();
    const click = await s.ready("u1", "10000001");
    await s.ftd(click, "10000001", amount);
    assert.equal((await s.me("u1")).traderIdLocked, true);
    const r = await s.bind("u1", "10000002");
    assert.equal(r.statusCode, 409); assert.equal(r.body.error, "ID_LOCKED");
  }
});

test("устаревшая привязка другого аккаунта (из прежней версии) уступает подтверждённому владельцу", async () => {
  const s = setup();
  const click = await s.clickOf("owner");
  await s.db.collection("users").doc("squatter").set({ trader_id: "10000001", click_id: "hd_old" });
  await s.db.collection("trader_bindings").doc("10000001").set({ uid: "squatter" });
  await s.reg(click, "10000001");
  assert.equal((await s.bind("owner", "10000001")).statusCode, 200);
  assert.equal(s.db.dump("trader_bindings")["10000001"].uid, "owner");
  assert.equal(s.db.dump("users").squatter.trader_id, null);
  assert.equal((await s.me("squatter")).stage, "broker");
});

test("неверный формат Trader ID → 400", async () => {
  const s = setup();
  for (const bad of ["", "12ab", "123", "1".repeat(20), "../users"]) assert.equal((await s.bind("u1", bad)).statusCode, 400, bad);
});

/* ======================= 5. Депозиты и доступ ======================= */
// Правило: доступ — по СУММЕ подтверждённых депозитов в USD от $50.00 (один депозит ниже $50 доступа не даёт)
const cases = [["30.00", false], ["39.99", false], ["40.00", false], ["45.00", false], ["49.99", false], ["50.00", true], ["120", true]];
for (const [amount, open] of cases) {
  test(`первый депозит $${amount} → доступ ${open ? "открыт" : "закрыт"}`, async () => {
    const s = setup();
    const click = await s.ready("u1", "10000001");
    assert.equal((await s.ftd(click, "10000001", amount)).status, "ftd_recorded");
    const p = await s.me("u1");
    assert.equal(p.academyAccess, open); assert.equal(p.depositState, open ? "ok" : "low"); assert.equal(p.stage, open ? "academy" : "deposit");
  });
}

test("депозит для неподтверждённого / не своего ID не открывает доступ", async () => {
  const s = setup();
  const click = await s.ready("u1", "10000001");
  await s.ftd(click, "10000099", "500"); // другой ID с тем же click — не привязан к пользователю
  assert.equal((await s.me("u1")).academyAccess, false);
  const t = setup();
  const c2 = await t.clickOf("u2");
  await t.ftd(c2, "10000002", "500"); // депозит без привязки ID пользователем
  assert.equal((await t.me("u2")).academyAccess, false);
  assert.equal((await t.me("u2")).stage, "broker");
});

test("первый $35, затем повторный $100: сумма $135 открывает доступ; первый депозит остаётся $35", async () => {
  const s = setup();
  const click = await s.ready("u1", "10000001");
  await s.ftd(click, "10000001", "35"); await s.redep(click, "10000001", "100");
  const p = await s.me("u1");
  assert.equal(p.academyAccess, true); assert.equal(p.firstDeposit.amount, 35);
  assert.deepEqual(p.deposits, { count: 2, totals: { USD: 135 }, unknownCurrencyCount: 0 });
});

test("второе событие без type после FTD не заменяет первый депозит, учитывается как депозит", async () => {
  const s = setup();
  const click = await s.ready("u1", "10000001");
  await s.ftd(click, "10000001", "39.99");
  assert.equal((await s.ftd(click, "10000001", "100")).status, "ftd_exists_counted_as_deposit");
  const p = await s.me("u1");
  assert.equal(p.firstDeposit.amount, 39.99); assert.equal(p.academyAccess, true);           // $39.99 + $100 — сумма от $50
});

test("история депозитов хранится отдельно от итоговой суммы", async () => {
  const s = setup();
  const click = await s.ready("u1", "10000001");
  await s.ftd(click, "10000001", "40"); await s.redep(click, "10000001", "60");
  const ev = Object.values(s.db.dump("deposit_events"));
  assert.deepEqual(ev.map(e => [e.kind, e.amount_cents]).sort(), [["ftd", 4000], ["redeposit", 6000]]);
  assert.deepEqual(s.db.dump("referrals")["10000001"].academy.deposit_totals, { USD: { sum_cents: 10000, count: 2 } });
});

test("неизвестная валюта не открывает доступ; разные валюты не складываются", async () => {
  const s = setup();
  const click = await s.ready("u1", "10000001");
  await s.ftd(click, "10000001", "500", { currency: "EUR" });
  await s.redep(click, "10000001", "10", { currency: "" });
  const p = await s.me("u1");
  assert.equal(p.academyAccess, false); assert.equal(p.firstDeposit, null);
  assert.deepEqual(p.deposits, { count: 1, totals: { EUR: 500 }, unknownCurrencyCount: 0 }); // без валюты — в ожидании, не учтён
});

test("без параметра валюты: USD только если явно задан POSTBACK_DEFAULT_CURRENCY", async () => {
  const s = setup();
  const click = await s.ready("u1", "10000001");
  await s.post({ click_id: click, trader_id: "10000001", amount: "60", secret: SECRET });
  assert.equal((await s.me("u1")).academyAccess, false);
  const t = setup({ POSTBACK_DEFAULT_CURRENCY: "USD" });
  const c = await t.ready("u1", "10000001");
  await t.post({ click_id: c, trader_id: "10000001", amount: "60", secret: SECRET });
  assert.equal((await t.me("u1")).academyAccess, true);
});

test("payout / profit / sum / commission не считаются депозитом клиента", async () => {
  const s = setup();
  const click = await s.ready("u1", "10000001");
  for (const k of ["payout", "profit", "sum", "commission"]) await s.post({ click_id: click, trader_id: "10000001", [k]: "500", currency: "USD", secret: SECRET, n: k });
  const p = await s.me("u1");
  assert.equal(p.firstDeposit, null); assert.deepEqual(p.deposits, { count: 0, totals: {}, unknownCurrencyCount: 0 });
});

test("порог доступа $50.00 — один и тот же в коде и в интерфейсе; упоминаний $40 нет", () => {
  assert.equal(ACCESS_MIN_USD_CENTS, 5000);
  const fs = require("fs"), base = __dirname + "/../public/academy/";
  assert.match(fs.readFileSync(base + "js/config.js", "utf8"), /minFirstDeposit:\s*50\b/);
  const ui = ["js/i18n-auth.js", "js/i18n-academy.js", "js/config.js", "js/pages/deposit.js", "deposit.html", "broker.html"].map(f => fs.readFileSync(base + f, "utf8")).join("\n");
  assert.doesNotMatch(ui, /\$\s?40\b|40\.00|\b4000\b/);
});

/* ======================= 6. API и сессия ======================= */
test("без токена и с поддельным токеном — 401 на всех защищённых маршрутах", async () => {
  const s = setup();
  for (const h of ["me", "click", "traderId"]) { const r = fakeRes(); await s.api[h](fakeReq({}), r); assert.equal(r.statusCode, 401); }
  const r = fakeRes(); await s.api.me({ headers: { authorization: "Bearer forged-token-xyz" } }, r); assert.equal(r.statusCode, 401);
});

test("пользователь видит только свои данные", async () => {
  const s = setup();
  const c = await s.ready("owner", "10000001"); await s.ftd(c, "10000001", "60");
  const eve = await s.me("eve");
  assert.equal(eve.traderId, null); assert.equal(eve.deposits, null); assert.equal(JSON.stringify(eve).includes("owner"), false);
});

test("click_id устойчив: повторные и одновременные запросы дают один", async () => {
  const s = setup();
  const ids = new Set((await Promise.all([1, 2, 3, 4, 5].map(() => s.call("click", "u1")))).map(r => r.body.clickId));
  assert.equal(ids.size, 1); assert.equal((await s.call("click", "u1")).body.clickId, [...ids][0]);
  assert.equal(Object.keys(s.db.dump("clicks")).length, 1);
});

test("статус после «перезагрузки» и повторного входа берётся из Firebase", async () => {
  const s = setup();
  assert.equal((await s.me("u1")).stage, "broker");
  const click = await s.ready("u1", "10000001");
  assert.equal((await s.me("u1")).stage, "deposit");
  await s.ftd(click, "10000001", "50");
  assert.equal((await s.me("u1")).stage, "academy");
});

test("ошибка Firestore в API → 503, доступ не открывается", async () => {
  const s = setup();
  await s.ready("u1", "10000001");
  s.db.failAll = true;
  const r = await s.call("me", "u1");
  s.db.failAll = false;
  assert.equal(r.statusCode, 503); assert.equal(r.body.academyAccess, undefined);
});

test("сервер без Firebase → API 503 CONFIG_MISSING", async () => {
  const api = createAcademyApi({ db: null, verifyIdToken: null, log: quiet });
  const r = fakeRes(); await api.me(fakeReq({ token: "testtoken-u1" }), r);
  assert.equal(r.statusCode, 503); assert.equal(r.body.error, "CONFIG_MISSING");
});

/* ======================= 7. Расчёт доступа — второй слой ======================= */
test("evaluateAccess: чужая привязка, не-USD, непроверенные записи — доступ закрыт", () => {
  const base = { uid: "u1", user: { trader_id: "10000001", click_id: "c1" }, binding: { uid: "u1" } };
  const ref = (fdOver = {}, regOver = {}) => ({ academy: { registration: { verified: true, click_id: "c1", ...regOver }, first_deposit: { verified: true, click_id: "c1", currency: "USD", usd_cents: 9000, ...fdOver } } });
  assert.equal(evaluateAccess({ ...base, referral: ref() }).academyAccess, true);
  assert.equal(evaluateAccess({ ...base, binding: { uid: "u2" }, referral: ref() }).academyAccess, false);
  for (const cur of ["EUR", null, "usd", ""]) assert.equal(evaluateAccess({ ...base, referral: ref({ currency: cur }) }).academyAccess, false, String(cur));
  assert.equal(evaluateAccess({ ...base, referral: ref({ verified: 1 }) }).academyAccess, false);
  assert.equal(evaluateAccess({ ...base, referral: ref({}, { verified: "true" }) }).academyAccess, false);
  assert.equal(evaluateAccess({ ...base, referral: ref({}, { uid: "u2" }) }).academyAccess, false);   // регистрация другого пользователя
  assert.equal(evaluateAccess({ ...base, referral: ref({}, { uid: "u2" }) }).deposits, null);
  assert.equal(evaluateAccess({ ...base, referral: ref({ uid: "u2" }) }).academyAccess, false);       // депозит другого пользователя
  assert.equal(parseAmountToCents("39.999"), 3999);
});

test("статический cid из настроек не используется для связи с пользователем", async () => {
  const s = setup({ PARTNER_STATIC_CIDS: "987453,staticcid12345" });
  await s.db.collection("clicks").doc("staticcid12345").set({ uid: "u1" });
  const r = await s.reg("staticcid12345", "10000001");
  assert.equal(r.status, "registration_confirmed"); assert.equal(r.clickKnown, false);
  assert.equal(s.db.dump("referrals")["10000001"].academy.registration.uid, null);
});
/* ======================= 8. Инициализация Firebase ======================= */
test("FIREBASE_KEY: JSON, base64, кавычки, «\\n» в ключе; понятные ошибки; ключ не в тексте ошибки", () => {
  const ok = { type: "service_account", project_id: "ai-boost-10540", private_key: "-----BEGIN PRIVATE KEY-----\\nSECRETDATA\\n-----END PRIVATE KEY-----\\n", client_email: "x@y.iam.gserviceaccount.com" };
  const j = JSON.stringify(ok);
  for (const v of [j, Buffer.from(j).toString("base64"), "'" + j + "'", JSON.stringify(j), "\n " + j + " \n"]) {
    const r = parseServiceAccount(v); assert.equal(r.error, undefined); assert.ok(r.account.private_key.includes("\n"));
  }
  for (const v of ["", j.slice(0, 40), JSON.stringify({ ...ok, private_key: undefined }), JSON.stringify({ ...ok, type: "x" })]) {
    const r = parseServiceAccount(v); assert.ok(r.error); assert.doesNotMatch(r.error, /SECRETDATA/);
  }
});

test("Firebase: ключ другого проекта не принимается", () => {
  const { initFirebase } = require("../academy/firebase-init");
  const key = JSON.stringify({ type: "service_account", project_id: "other-project", private_key: "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----\n", client_email: "a@b" });
  let inited = false;
  const r = initFirebase({ admin: { initializeApp() { inited = true; }, credential: { cert: x => x }, firestore: () => ({}) }, env: { FIREBASE_KEY: key }, log: quiet });
  assert.equal(r.db, null); assert.match(r.reason, /other-project/); assert.equal(inited, false);
});

/* ======================= 9. Строгая привязка Trader ID к депозитам (п. 8 требований) ======================= */
const rest = s => ({ http: s.http, status: s.status });

test("[п.8] подтверждённый ID + депозит $59 → доступ открыт", async () => {
  const s = setup();
  const click = await s.ready("u1", "20000001");
  const r = await s.ftd(click, "20000001", "59");
  assert.deepEqual(rest(r), { http: 200, status: "ftd_recorded" });
  const p = await s.me("u1");
  assert.equal(p.academyAccess, true); assert.equal(p.firstDeposit.amount, 59);
});

test("[п.8] неподтверждённый ID + депозит $59 → не учтён, доступа нет, ID нельзя привязать", async () => {
  const s = setup();
  const click = await s.clickOf("u1");
  const r = await s.ftd(click, "20000001", "59");                                   // регистрации нет
  assert.deepEqual(rest(r), { http: 202, status: "deposit_pending_registration" });
  assert.equal(s.db.dump("referrals")["20000001"].academy.first_deposit, undefined);
  assert.equal(s.db.dump("referrals")["20000001"].academy.registration, undefined); // депозит НЕ создаёт регистрацию
  assert.equal((await s.bind("u1", "20000001")).statusCode, 422);
  const p = await s.me("u1");
  assert.equal(p.academyAccess, false); assert.equal(p.traderId, null);
});

test("[п.8] регистрация одного ID и депозит другого → отказ, ничего не учтено", async () => {
  const s = setup();
  const click = await s.ready("u1", "20000001");                                   // зарегистрирован и привязан A
  const r = await s.ftd(click, "20000002", "59");                                  // депозит по B
  assert.deepEqual(rest(r), { http: 409, status: "trader_mismatch" });
  const refB = s.db.dump("referrals")["20000002"];
  assert.equal(refB.academy.first_deposit, undefined);
  assert.equal(refB.academy.deposit_count, undefined);
  const p = await s.me("u1");
  assert.equal(p.academyAccess, false); assert.equal(p.firstDeposit, null);
  assert.deepEqual(p.deposits, { count: 0, totals: {}, unknownCurrencyCount: 0 });
});

test("[п.8] депозит по ID другого пользователя → 409; баланс и доступ владельца не меняются", async () => {
  const s = setup();
  const ownerClick = await s.ready("owner", "20000001");
  await s.ftd(ownerClick, "20000001", "45");
  const before = JSON.stringify(s.db.dump("referrals")["20000001"].academy);
  const eveClick = await s.clickOf("eve");
  const r1 = await s.ftd(eveClick, "20000001", "500");
  const r2 = await s.redep(eveClick, "20000001", "500");
  const r3 = await s.reg(eveClick, "20000001");
  assert.deepEqual([r1.http, r2.http, r3.http], [409, 409, 409]);
  assert.equal(JSON.stringify(s.db.dump("referrals")["20000001"].academy), before);
  assert.equal((await s.me("owner")).firstDeposit.amount, 45);
  assert.equal((await s.me("eve")).academyAccess, false);
  assert.equal((await s.bind("eve", "20000001")).statusCode, 422);
});

test("[п.8] повторный postback → депозит не дублируется", async () => {
  const s = setup();
  const click = await s.ready("u1", "20000001");
  assert.equal((await s.ftd(click, "20000001", "59")).status, "ftd_recorded");
  assert.equal((await s.ftd(click, "20000001", "59")).status, "duplicate");
  await Promise.all([1, 2, 3, 4].map(() => s.redep(click, "20000001", "10")));
  const p = await s.me("u1");
  assert.deepEqual(p.deposits, { count: 2, totals: { USD: 69 }, unknownCurrencyCount: 0 });
  assert.equal(Object.keys(s.db.dump("deposit_events")).length, 2);
});

test("[п.8] валюта неизвестна → депозит в ожидании, доступ не открыт", async () => {
  const s = setup();
  const click = await s.ready("u1", "20000001");
  const r = await s.post({ click_id: click, trader_id: "20000001", amount: "59", secret: SECRET });
  assert.deepEqual(rest(r), { http: 202, status: "deposit_pending_currency" });
  const ref = s.db.dump("referrals")["20000001"].academy;
  assert.equal(ref.first_deposit, undefined);                                       // больше нет записи currency:null / usd_cents:null
  assert.equal((await s.me("u1")).academyAccess, false);
});

/* ======================= 10. Отложенные депозиты и повторная обработка ======================= */
test("депозит, пришедший раньше регистрации, засчитывается автоматически после её подтверждения", async () => {
  const s = setup();
  const click = await s.clickOf("u1");
  assert.equal((await s.ftd(click, "20000001", "59")).status, "deposit_pending_registration");
  const r = await s.reg(click, "20000001");
  assert.equal(r.status, "registration_confirmed"); assert.equal(r.promoted, 1);
  assert.equal((await s.bind("u1", "20000001")).statusCode, 200);
  const p = await s.me("u1");
  assert.equal(p.academyAccess, true); assert.equal(p.firstDeposit.amount, 59);
  assert.equal(s.db.dump("deposit_events")[Object.keys(s.db.dump("deposit_events"))[0]].status, "counted");
  assert.equal((await s.ftd(click, "20000001", "59")).status, "duplicate");
});

test("отложенный депозит чужого click_id отклоняется при регистрации владельца", async () => {
  const s = setup();
  const owner = await s.clickOf("owner"), eve = await s.clickOf("eve");
  await s.ftd(eve, "20000001", "500");                                              // Eve раньше регистрации владельца
  await s.reg(owner, "20000001");
  const a = s.db.dump("referrals")["20000001"].academy;
  assert.equal(a.first_deposit, undefined);
  assert.equal(Object.values(a.pending_deposits)[0].status, "rejected");
  assert.equal((await s.bind("owner", "20000001")).statusCode, 200);
  assert.equal((await s.me("owner")).academyAccess, false);
});

test("повторная обработка: без явной валюты ничего не меняет; с USD засчитывает; повторный запуск — без дублей", async () => {
  const s = setup();
  const click = await s.ready("u1", "20000001");
  await s.post({ click_id: click, trader_id: "20000001", amount: "59", secret: SECRET });
  const dry = await reprocessAll(s.db, {});                                         // валюта не указана
  assert.equal(dry.reduce((n, r) => n + r.changes.length, 0), 0);
  const writes = s.db.writes;
  const preview = await reprocessAll(s.db, { currency: "USD" });                    // просмотр — без записи
  assert.equal(preview[0].changes.length, 1); assert.equal(s.db.writes, writes);
  assert.equal((await s.me("u1")).academyAccess, false);
  await reprocessAll(s.db, { currency: "USD", apply: true });
  let p = await s.me("u1");
  assert.equal(p.academyAccess, true); assert.equal(p.firstDeposit.amount, 59);
  assert.deepEqual(p.deposits, { count: 1, totals: { USD: 59 }, unknownCurrencyCount: 0 });
  await reprocessAll(s.db, { currency: "USD", apply: true });                       // второй запуск
  await Promise.all([1, 2].map(() => reprocessTrader(s.db, "20000001", { currency: "USD", apply: true })));
  p = await s.me("u1");
  assert.deepEqual(p.deposits, { count: 1, totals: { USD: 59 }, unknownCurrencyCount: 0 });
});

test("повторная обработка исправляет данные прошлой версии (currency: null, usd_cents: null) без дублей", async () => {
  const s = setup();
  const click = await s.ready("u1", "20000001");
  // Ровно так прошлая версия записывала первый депозит без валюты
  await s.db.collection("referrals").doc("20000001").set({ academy: {
    first_deposit: { verified: true, click_id: click, uid: "u1", event_key: "fp_old1", at: 1, amount_cents: 5900, currency: null, usd_cents: null },
    deposit_totals: { unknown_currency_count: 1 }, deposit_count: 1 } }, { merge: true });
  await s.db.collection("deposit_events").doc("fp_old1").set({ trader_id: "20000001", click_id: click, uid: "u1", kind: "ftd", amount_cents: 5900, currency: null, counted_in_totals: false, at: 1 });
  assert.equal((await s.me("u1")).academyAccess, false);
  const audit1 = await runAudit(s.db);
  assert.equal(audit1.needs_reprocessing.first_deposits_without_currency, 1);
  await reprocessAll(s.db, { currency: "USD", apply: true });
  await reprocessAll(s.db, { currency: "USD", apply: true });
  const p = await s.me("u1");
  assert.equal(p.academyAccess, true); assert.equal(p.firstDeposit.amount, 59);
  assert.deepEqual(p.deposits, { count: 1, totals: { USD: 59 }, unknownCurrencyCount: 0 });
  assert.equal((await runAudit(s.db)).needs_reprocessing.first_deposits_without_currency, 0);
});

test("депозит по другому ID сохраняется в ожидании и засчитывается только после законной смены ID", async () => {
  const s = setup();
  const click = await s.ready("u1", "20000001");                                   // A привязан, депозита нет
  assert.equal((await s.ftd(click, "20000002", "59")).status, "trader_mismatch");   // депозит по B
  await reprocessAll(s.db, { apply: true });
  assert.equal((await s.me("u1")).academyAccess, false);                            // пока привязан A — не учтён
  await s.reg(click, "20000002");                                                   // регистрация B по ссылке пользователя
  assert.equal((await s.bind("u1", "20000002")).statusCode, 200);                   // законная смена ID
  await reprocessAll(s.db, { apply: true });
  const p = await s.me("u1");
  assert.equal(p.traderId, "20000002"); assert.equal(p.academyAccess, true);
});

test("аудит Firestore только читает и находит несоответствия", async () => {
  const s = setup();
  const click = await s.ready("u1", "20000001");
  await s.db.collection("trader_bindings").doc("20000009").set({ uid: "ghost" });
  await s.db.collection("referrals").doc("30000000").set({ trader_id: "30000000", click_id: "old", deposit: 50 });
  const writes = s.db.writes;
  const a = await runAudit(s.db);
  assert.equal(s.db.writes, writes);
  assert.equal(a.counts.referrals_legacy_only, 1);
  assert.ok(a.issues.some(i => i.type === "binding_not_reflected_in_user"));
  assert.ok(!JSON.stringify(a).includes("20000009"));                               // ID замаскированы
});

test("второй слой: регистрация или депозит на чужой uid не дают доступа", () => {
  const base = { uid: "u1", user: { trader_id: "1", click_id: "c1" }, binding: { uid: "u1" } };
  const ok = { registration: { verified: true, click_id: "c1", uid: "u1" }, first_deposit: { verified: true, click_id: "c1", uid: "u1", currency: "USD", usd_cents: 5900 } };
  assert.equal(evaluateAccess({ ...base, referral: { academy: ok } }).academyAccess, true);
  assert.equal(evaluateAccess({ ...base, referral: { academy: { ...ok, registration: { ...ok.registration, uid: "u2" } } } }).academyAccess, false);
  assert.equal(evaluateAccess({ ...base, referral: { academy: { ...ok, first_deposit: { ...ok.first_deposit, uid: "u2" } } } }).academyAccess, false);
});

test("click_id регистрации выдан академией владельцу: click_id академии другого пользователя → 409; click_id платформы — не конфликт", async () => {
  const s = setup();
  const ownerClick = await s.clickOf("owner"), eveClick = await s.clickOf("eve");
  await s.db.collection("referrals").doc("20000001").set({ academy: { registration: { verified: true, click_id: ownerClick } } }); // uid не записан
  const r1 = await s.ftd(eveClick, "20000001", "500");
  assert.deepEqual([r1.http, r1.status], [409, "conflict_click"]);                        // владелец определён по click_id регистрации
  assert.equal(s.db.dump("referrals")["20000001"].academy.first_deposit, undefined);
  const r2 = await s.ftd("ppclick_other1", "20000001", "60");                              // click_id платформы — атрибуция, не владелец
  assert.equal(r2.status, "ftd_recorded");
  assert.equal(s.db.dump("referrals")["20000001"].academy.first_deposit.uid, "owner");     // депозит закреплён за владельцем
  await s.call("me", "eve");
  assert.equal((await s.bind("eve", "20000001")).statusCode, 422);                          // eve не может привязать
});test("одновременный запуск двух обработок данных прошлой версии не дублирует депозит", async () => {
  const s = setup();
  const click = await s.ready("u1", "20000001");
  await s.db.collection("referrals").doc("20000001").set({ academy: {
    first_deposit: { verified: true, click_id: click, uid: "u1", event_key: "fp_old1", at: 1, amount_cents: 5900, currency: null, usd_cents: null },
    deposit_totals: { unknown_currency_count: 1 }, deposit_count: 1 } }, { merge: true });
  await s.db.collection("deposit_events").doc("fp_old1").set({ trader_id: "20000001", click_id: click, uid: "u1", kind: "ftd", amount_cents: 5900, currency: null, counted_in_totals: false, at: 1 });
  await Promise.all([1, 2, 3].map(() => reprocessTrader(s.db, "20000001", { currency: "USD", apply: true })));
  assert.deepEqual((await s.me("u1")).deposits, { count: 1, totals: { USD: 59 }, unknownCurrencyCount: 0 });
});

/* ======================= 11. Тестовый депозит по Trader ID (только эмулятор) ======================= */
const { testDepositConfig, createTestDeposit } = require("../academy/test-deposit");
const TSECRET = "test-deposit-secret-0123456789-abc";
function withTest(env = {}) {
  const s = setup(env);
  s.td = createTestDeposit({ db: s.db, secret: TSECRET, log: quiet });
  s.dep = (q) => s.td({ test_secret: TSECRET, currency: "USD", ...q });
  return s;
}

test("тестовый маршрут: выключен без HD_TEST_MODE, с коротким или совпадающим секретом", () => {
  assert.equal(testDepositConfig({ testMode: false, env: { TEST_POSTBACK_SECRET: TSECRET } }).enabled, false);
  assert.equal(testDepositConfig({ testMode: true, env: {} }).enabled, false);
  assert.equal(testDepositConfig({ testMode: true, env: { TEST_POSTBACK_SECRET: "short" } }).enabled, false);
  assert.equal(testDepositConfig({ testMode: true, env: { TEST_POSTBACK_SECRET: SECRET, POCKET_POSTBACK_SECRET: SECRET } }).enabled, false);
  assert.equal(testDepositConfig({ testMode: true, env: { TEST_POSTBACK_SECRET: TSECRET, POCKET_POSTBACK_SECRET: SECRET } }).enabled, true);
});

test("тестовый депозит $69 по подтверждённому ID 142807701 → учтён, пользователь переходит в академию", async () => {
  const s = withTest();
  await s.ready("tester", "142807701");
  assert.equal((await s.me("tester")).stage, "deposit");
  const r = await s.dep({ trader_id: "142807701", amount: "69" });
  assert.equal(r.http, 200); assert.equal(r.status, "ftd_recorded");
  const p = await s.me("tester");
  assert.equal(p.stage, "academy"); assert.equal(p.academyAccess, true); assert.equal(p.firstDeposit.amount, 69);
  const ev = Object.values(s.db.dump("deposit_events"));
  assert.equal(ev.length, 1); assert.equal(ev[0].test, true); assert.equal(ev[0].status, "counted");
  assert.equal((await s.dep({ trader_id: "142807701", amount: "69" })).status, "duplicate");
  assert.deepEqual((await s.me("tester")).deposits, { count: 1, totals: { USD: 69 }, unknownCurrencyCount: 0 });
});

test("тестовый депозит: неподтверждённый или непривязанный ID отклоняется, ничего не записано", async () => {
  const s = withTest();
  assert.equal((await s.dep({ trader_id: "142807701", amount: "69" })).status, "trader_not_confirmed");   // нет регистрации
  const click = await s.clickOf("tester");
  await s.reg(click, "142807701");                                                                     // регистрация есть, привязки нет
  const r = await s.dep({ trader_id: "142807701", amount: "69" });
  assert.equal(r.http, 422); assert.equal(r.status, "trader_not_bound");
  assert.equal(Object.keys(s.db.dump("deposit_events")).length, 0);
  assert.equal(s.db.dump("referrals")["142807701"].academy.first_deposit, undefined);
});

test("тестовый депозит: секрет и параметры проверяются; секрет реальных postback не подходит", async () => {
  const s = withTest();
  await s.ready("tester", "142807701");
  assert.equal((await s.td({ trader_id: "142807701", amount: "69", currency: "USD" })).http, 401);
  assert.equal((await s.td({ trader_id: "142807701", amount: "69", currency: "USD", test_secret: SECRET })).http, 403);
  assert.equal((await s.dep({ trader_id: "142807701", amount: "69,00" })).http, 400);
  assert.equal((await s.dep({ trader_id: "142807701", amount: "69", currency: "" })).http, 400);
  assert.equal((await s.me("tester")).academyAccess, false);
});

test("тестовый депозит подчиняется тем же правилам: $39.99 не открывает доступ; чужой привязанный ID не трогается", async () => {
  const s = withTest();
  await s.ready("tester", "142807701");
  await s.dep({ trader_id: "142807701", amount: "39.99" });
  assert.equal((await s.me("tester")).academyAccess, false);
  const t = withTest();
  await t.ready("owner", "142807701");
  const before = JSON.stringify(t.db.dump("referrals"));
  await t.ready("other", "142807702");
  await t.db.collection("users").doc("owner").set({ trader_id: "142807702" }, { merge: true }); // искусственное расхождение
  const r = await t.dep({ trader_id: "142807701", amount: "69" });
  assert.equal(r.status, "trader_mismatch");
  assert.equal(JSON.stringify(t.db.dump("referrals")["142807701"].academy.first_deposit), undefined);
});

test("реальный /postback: секрет обязателен; без click_id депозит находится по trader_id; тестовый секрет не подходит", async () => {
  const s = withTest();
  await s.ready("tester", "142807701");
  assert.equal((await s.post({ trader_id: "142807701", amount: "69", currency: "USD", test_secret: TSECRET })).http, 401);
  assert.equal((await s.me("tester")).academyAccess, false);
  const r = await s.post({ trader_id: "142807701", amount: "69", currency: "USD", secret: SECRET });
  assert.equal(r.status, "ftd_recorded");
  assert.equal((await s.me("tester")).academyAccess, true);
});
test("тестовый депозит: непроверенная или неполная регистрация не считается подтверждением", async () => {
  for (const reg of [{ verified: false }, { verified: "true" }, { verified: true, uid: "someone_else" }]) {
    const s = withTest();
    const click = await s.clickOf("tester");
    await s.db.collection("referrals").doc("142807701").set({ academy: { registration: { click_id: click, uid: "tester", ...reg } } });
    await s.db.collection("trader_bindings").doc("142807701").set({ uid: "tester" });
    await s.db.collection("users").doc("tester").set({ trader_id: "142807701" }, { merge: true });
    const r = await s.dep({ trader_id: "142807701", amount: "69" });
    assert.ok(["trader_not_confirmed", "trader_not_bound"].includes(r.status), JSON.stringify(reg) + " → " + r.status);
    assert.equal(s.db.dump("referrals")["142807701"].academy.first_deposit, undefined);
  }
});

/* ======================= 12. Поиск депозита по trader_id и /check-deposit (п. 11 требований) ======================= */
const checkDep = async (s, uid, traderQuery) => { const r = fakeRes(); await s.api.checkDeposit({ headers: uid ? { authorization: "Bearer testtoken-" + uid } : {}, query: traderQuery ? { trader_id: traderQuery } : {} }, r); return r; };
// Полный путь, как в Pocket Partners: макросы {CLICK_ID} → свой click_id платформы, поиск — по {TRADER_ID}
async function ppFlow(s, uid, trader, ppClick) {
  await s.call("me", uid);
  assert.equal((await s.post({ type: "registration", click_id: ppClick, trader_id: trader, secret: SECRET })).status, "registration_confirmed");
  assert.equal((await s.bind(uid, trader)).statusCode, 200);
}

test("[11.1–2] регистрация сохраняет trader_id и click_id; привязка UID ↔ Trader ID в users и trader_bindings", async () => {
  const s = setup();
  await ppFlow(s, "u1", "30000001", "ppclick_100001");
  assert.equal(s.db.dump("referrals")["30000001"].academy.registration.click_id, "ppclick_100001");
  assert.equal(s.db.dump("users").u1.trader_id, "30000001");
  assert.equal(s.db.dump("trader_bindings")["30000001"].uid, "u1");
});

test("[11.3–6] FTD по trader_id → /check-deposit находит его и открывает доступ", async () => {
  const s = setup();
  await ppFlow(s, "u1", "30000001", "ppclick_100001");
  assert.equal((await s.post({ type: "ftd", click_id: "ppclick_100001", trader_id: "30000001", amount: "69", currency: "USD", secret: SECRET })).status, "ftd_recorded");
  const r = await checkDep(s, "u1");
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.ok, r.body.amount, r.body.state, r.body.stage, r.body.traderId], [true, 69, "ok", "academy", "30000001"]);
  assert.equal((await checkDep(s, "u1", "30000001")).body.ok, true);                 // явный свой trader_id — тоже можно
});

test("[11.7, 11.15] без депозита и до postback: /check-deposit — ожидание, доступа нет", async () => {
  const s = setup();
  await s.call("me", "u1");
  let r = await checkDep(s, "u1");                                                      // ID ещё не введён
  assert.deepEqual([r.statusCode, r.body.ok, r.body.amount, r.body.state, r.body.stage], [200, false, 0, "none", "broker"]);
  await ppFlow(s, "u1", "30000001", "ppclick_100001");
  r = await checkDep(s, "u1");                                                          // регистрация есть, депозита нет
  assert.deepEqual([r.body.ok, r.body.amount, r.body.state, r.body.brokerRegistrationConfirmed], [false, 0, "none", true]);
});

test("[11.8–9] повторный депозит и повторная доставка: FTD не меняется, без двойного учёта", async () => {
  const s = setup();
  await ppFlow(s, "u1", "30000001", "ppclick_100001");
  const q = { click_id: "ppclick_100001", trader_id: "30000001", currency: "USD", secret: SECRET };
  await s.post({ ...q, type: "ftd", amount: "50" });
  await s.post({ ...q, type: "redeposit", amount: "25" });
  await Promise.all([1, 2, 3].map(() => s.post({ ...q, type: "redeposit", amount: "25" })));
  await s.post({ ...q, type: "ftd", amount: "50" });
  const r = await checkDep(s, "u1");
  assert.equal(r.body.amount, 50); assert.deepEqual(r.body.deposits, { count: 2, totals: { USD: 75 }, unknownCurrencyCount: 0 });
});

test("[11.10] неизвестный Trader ID: депозит не учитывается, ID нельзя привязать", async () => {
  const s = setup();
  const r = await s.post({ type: "ftd", click_id: "ppclick_999999", trader_id: "39999999", amount: "500", currency: "USD", secret: SECRET });
  assert.deepEqual([r.http, r.status], [202, "deposit_pending_registration"]);
  await s.call("me", "u1");
  assert.equal((await s.bind("u1", "39999999")).statusCode, 422);
  assert.equal((await checkDep(s, "u1")).body.ok, false);
});

test("[11.11] неверный секрет — ничего не записано", async () => {
  const s = setup();
  const r = await s.post({ type: "ftd", click_id: "ppclick_100001", trader_id: "30000001", amount: "69", currency: "USD", secret: "wrong-secret-0123456789abcdef" });
  assert.equal(r.http, 403); assert.equal(s.db.writes, 0);
});

test("[11.12] отсутствующая или некорректная сумма; регистрация с {SUMDEP}=0 не становится депозитом", async () => {
  const s = setup();
  await ppFlow(s, "u1", "30000001", "ppclick_100001");
  for (const amount of [undefined, "", "abc", "0", "-1"]) {
    const r = await s.post({ type: "ftd", click_id: "ppclick_100001", trader_id: "30000001", amount, currency: "USD", secret: SECRET });
    assert.equal(r.status, "invalid_amount", String(amount));
  }
  const reg0 = await s.post({ click_id: "ppclick_100001", trader_id: "30000001", amount: "0", secret: SECRET, n: "1" }); // без type, сумма 0
  assert.equal(reg0.status, "registration_exists");
  assert.equal((await checkDep(s, "u1")).body.amount, 0);
});

test("[11.13] отсутствующая валюта → депозит в ожидании (202), доступа нет; USD не подставляется", async () => {
  const s = setup();
  await ppFlow(s, "u1", "30000001", "ppclick_100001");
  const r = await s.post({ type: "ftd", click_id: "ppclick_100001", trader_id: "30000001", amount: "69", secret: SECRET });
  assert.deepEqual([r.http, r.status], [202, "deposit_pending_currency"]);
  assert.equal((await checkDep(s, "u1")).body.ok, false);
});

test("[11.14] чужой Trader ID: нельзя привязать занятый ID, нельзя запросить чужой в /check-deposit", async () => {
  const s = setup();
  await ppFlow(s, "owner", "30000001", "ppclick_100001");
  await s.post({ type: "ftd", click_id: "ppclick_100001", trader_id: "30000001", amount: "69", currency: "USD", secret: SECRET });
  await s.call("me", "eve");
  const b = await s.bind("eve", "30000001");
  assert.equal(b.statusCode, 409); assert.equal(b.body.error, "TRADER_TAKEN");
  const c = await checkDep(s, "eve", "30000001");
  assert.equal(c.statusCode, 403); assert.equal(c.body.error, "TRADER_NOT_YOURS");
  assert.equal(JSON.stringify(c.body).includes("69"), false);
  assert.equal((await checkDep(s, "owner")).body.ok, true);
});

test("[11.14] /check-deposit без входа → 401; сумма и статус из браузера не учитываются", async () => {
  const s = setup();
  const r = await checkDep(s, null, "30000001");
  assert.equal(r.statusCode, 401);
  await s.call("me", "u1");
  const r2 = fakeRes(); await s.api.checkDeposit({ headers: { authorization: "Bearer testtoken-u1" }, query: { amount: "9999", ok: "true", academyAccess: "true" } }, r2);
  assert.deepEqual([r2.body.ok, r2.body.amount], [false, 0]);
});

test("регистрация без владельца уточняется, когда приходит событие с click_id академии", async () => {
  const s = setup();
  const click = await s.clickOf("u1");
  await s.post({ type: "registration", trader_id: "30000002", secret: SECRET });                 // без click_id
  assert.equal(s.db.dump("referrals")["30000002"].academy.registration.uid, null);
  await s.post({ type: "registration", click_id: click, trader_id: "30000002", secret: SECRET });
  assert.equal(s.db.dump("referrals")["30000002"].academy.registration.uid, "u1");
  await s.call("me", "eve");
  assert.equal((await s.bind("eve", "30000002")).statusCode, 422);                               // владелец известен — только ему
  assert.equal((await s.bind("u1", "30000002")).statusCode, 200);
});

test("макросы Pocket Partners в верхнем регистре не подставлены → 400 macro_not_substituted", async () => {
  const s = setup();
  for (const q of [{ click_id: "{CLICK_ID}", trader_id: "30000001" }, { click_id: "ppclick_1", trader_id: "{TRADER_ID}" }, { click_id: "ppclick_1", trader_id: "30000001", amount: "{SUMDEP}", type: "ftd" }]) {
    const r = await s.post({ ...q, secret: SECRET });
    assert.deepEqual([r.http, r.status], [400, "macro_not_substituted"], JSON.stringify(q));
  }
});

test("[11.16] совместимость: записи прошлой версии (click академии, uid) работают; старое поле deposit не даёт доступа", async () => {
  const s = setup();
  // Как записала прошлая версия: регистрация с uid и click академии, привязка, первый депозит
  const click = await s.clickOf("old");
  await s.db.collection("referrals").doc("30000003").set({ trader_id: "30000003", click_id: click, academy: {
    registration: { verified: true, click_id: click, uid: "old", source: "registration" },
    first_deposit: { verified: true, click_id: click, uid: "old", event_key: "fp_x", at: 1, amount_cents: 6000, currency: "USD", usd_cents: 6000 } } });
  await s.db.collection("trader_bindings").doc("30000003").set({ uid: "old" });
  await s.db.collection("users").doc("old").set({ trader_id: "30000003" }, { merge: true });
  assert.equal((await checkDep(s, "old")).body.ok, true);
  // Только старая схема AI BOOST (поле deposit без подтверждения академии) — не доказательство депозита
  await s.db.collection("referrals").doc("30000004").set({ trader_id: "30000004", click_id: "x", deposit: 500 });
  await s.call("me", "u9");
  assert.equal((await s.bind("u9", "30000004")).statusCode, 422);
});

test("регистрация без click_id, но с известным владельцем: депозит с click_id другого пользователя → 409", async () => {
  const s = setup();
  await s.clickOf("owner");
  const eveClick = await s.clickOf("eve");
  await s.db.collection("referrals").doc("30000005").set({ academy: { registration: { verified: true, click_id: null, uid: "owner" } } });
  const r = await s.ftd(eveClick, "30000005", "500");
  assert.deepEqual([r.http, r.status], [409, "conflict_click"]);
  assert.equal(s.db.dump("referrals")["30000005"].academy.first_deposit, undefined);
});

test("регистрация без click_id и владельца, ID привязан одним пользователем: депозит с click_id другого → 409", async () => {
  const s = setup();
  await s.call("me", "owner");
  await s.post({ type: "registration", trader_id: "30000006", secret: SECRET });              // без click_id
  assert.equal((await s.bind("owner", "30000006")).statusCode, 200);
  const eveClick = await s.clickOf("eve");
  const r = await s.ftd(eveClick, "30000006", "500");
  assert.deepEqual([r.http, r.status], [409, "trader_bound_to_other_user"]);
  assert.equal((await checkDep(s, "owner")).body.ok, false);
  assert.equal((await s.ftd(null, "30000006", "60")).status, "ftd_recorded");               // депозит без click_id — по trader_id
  assert.equal((await checkDep(s, "owner")).body.ok, true);
});

/* ======================= 13. Случай 142808073 (production: conflict_click → 409) ======================= */
const { inspectTrader, rebindTrader } = require("../academy/admin");
const T8073 = "142808073";
// Состояние как в production: регистрация пришла с click_id платформы, ID привязан к прежнему аккаунту
async function prod8073(s, regClick = "ppclickREG0001") {
  await s.call("me", "old_uid");
  assert.equal((await s.post({ type: "registration", click_id: regClick, trader_id: T8073, secret: SECRET })).status, "registration_confirmed");
  assert.equal((await s.bind("old_uid", T8073)).statusCode, 200);                            // trader_bindings/142808073 → old_uid
}
const ftd8073 = (s, click, amount = "60", extra = {}) => s.post({ type: "ftd", click_id: click, trader_id: T8073, amount, currency: "USD", secret: SECRET, ...extra });

test("[8073] воспроизведение: FTD с другим click_id платформы больше не conflict_click — 200, тот же владелец", async () => {
  const s = setup();
  await prod8073(s);
  const r = await ftd8073(s, "ppclickFTD9999");                                                // click_id отличается от регистрации
  assert.deepEqual([r.http, r.status], [200, "ftd_recorded"]);
  assert.equal(s.db.dump("postback_events")[r.key].click_note, "differs_from_registration");  // отмечено для диагностики
  assert.equal((await checkDep(s, "old_uid")).body.ok, true);
});

test("[8073] совпадающий click_id → 200; повтор того же события → duplicate (не конфликт)", async () => {
  const s = setup();
  await prod8073(s);
  assert.equal((await ftd8073(s, "ppclickREG0001")).status, "ftd_recorded");
  const again = await ftd8073(s, "ppclickREG0001");
  assert.deepEqual([again.http, again.status], [200, "duplicate"]);
  assert.equal((await s.post({ type: "registration", click_id: "ppclickREG0001", trader_id: T8073, secret: SECRET })).status, "duplicate");
  assert.equal((await s.post({ type: "registration", click_id: "ppclickOTHER77", trader_id: T8073, secret: SECRET })).status, "registration_exists");
});

test("[8073] существующая привязка + НОВЫЙ UID: новый аккаунт не может взять ID; депозит засчитывается владельцу привязки", async () => {
  const s = setup();
  await prod8073(s);
  await s.call("me", "new_uid");
  const b = await s.bind("new_uid", T8073);
  assert.deepEqual([b.statusCode, b.body.error], [409, "TRADER_TAKEN"]);
  assert.equal(s.db.dump("trader_bindings")[T8073].uid, "old_uid");                          // привязка не удалена и не изменена
  assert.equal((await ftd8073(s, "ppclickFTD9999")).status, "ftd_recorded");
  assert.equal((await checkDep(s, "new_uid")).body.ok, false);
  assert.equal((await checkDep(s, "new_uid", T8073)).statusCode, 403);
  assert.equal((await checkDep(s, "old_uid")).body.ok, true);
});

test("[8073] тот же UID: событие с click_id академии этого же пользователя → 200", async () => {
  const s = setup();
  const myClick = await s.clickOf("old_uid");
  await prod8073(s);
  const r = await ftd8073(s, myClick);
  assert.deepEqual([r.http, r.status], [200, "ftd_recorded"]);
  assert.equal((await checkDep(s, "old_uid")).body.ok, true);
});

test("[8073] РАЗНЫЕ владельцы по-прежнему блокируются: click_id академии другого пользователя → 409, ничего не изменено", async () => {
  const s = setup();
  await prod8073(s);
  const eveClick = await s.clickOf("eve");
  const before = JSON.stringify(s.db.dump("referrals")[T8073]);
  const r = await ftd8073(s, eveClick, "500");
  assert.deepEqual([r.http, r.status], [409, "trader_bound_to_other_user"]);
  assert.equal(JSON.stringify(s.db.dump("referrals")[T8073]), before);
  assert.equal((await checkDep(s, "eve")).body.ok, false);
  // Регистрация владельца известна по click_id академии → другой пользователь академии → conflict_click
  const t = setup();
  const ownerClick = await t.clickOf("owner");
  await t.post({ type: "registration", click_id: ownerClick, trader_id: T8073, secret: SECRET });
  const eve2 = await t.clickOf("eve");
  assert.deepEqual([(await ftd8073(t, eve2, "500")).status], ["conflict_click"]);
  assert.equal((await t.post({ type: "registration", click_id: eve2, trader_id: T8073, secret: SECRET })).status, "conflict_click");
});

test("[8073] подтверждённые регистрация и депозит не перезаписываются ни дублями, ни конфликтами", async () => {
  const s = setup();
  await prod8073(s);
  await ftd8073(s, "ppclickFTD9999", "60");
  const snapshot = JSON.stringify({ reg: s.db.dump("referrals")[T8073].academy.registration, fd: s.db.dump("referrals")[T8073].academy.first_deposit });
  await ftd8073(s, "ppclickFTD9999", "60");                                                 // дубль
  await ftd8073(s, "ppclickANOTHER1", "999");                                                // второй «FTD» — обычный депозит
  await ftd8073(s, await s.clickOf("eve"), "500");                                          // конфликт
  await s.post({ type: "registration", click_id: "ppclickNEWREG1", trader_id: T8073, secret: SECRET });
  const a = s.db.dump("referrals")[T8073].academy;
  assert.equal(JSON.stringify({ reg: a.registration, fd: a.first_deposit }), snapshot);
  assert.equal(a.first_deposit.amount_cents, 6000);
});

test("[8073] inspect-trader показывает владельца, привязку и события (только чтение, ID замаскирован)", async () => {
  const s = setup();
  await prod8073(s);
  await ftd8073(s, "ppclickFTD9999");
  const w = s.db.writes;
  const info = await inspectTrader(s.db, T8073);
  assert.equal(s.db.writes, w);
  assert.equal(info.trader, "••••8073"); assert.equal(info.binding_uid, "old_uid");
  assert.equal(info.registration.owner_uid, null); assert.equal(info.first_deposit.amount, 60);
  assert.deepEqual(info.events.map(e => e.status), ["registration_confirmed", "ftd_recorded"]);
  assert.equal(JSON.stringify(info).includes("ppclickREG0001"), false);                      // click_id маскируется
});

test("[8073] rebind-trader: просмотр ничего не пишет; перенос на новый аккаунт без удаления; новый получает доступ", async () => {
  const s = setup();
  await prod8073(s);
  await ftd8073(s, "ppclickFTD9999", "60");
  await s.call("me", "new_uid");
  const w = s.db.writes;
  const dry = await rebindTrader(s.db, { trader: T8073, toUid: "new_uid", reason: "владелец сменил аккаунт" });
  assert.deepEqual([dry.ok, dry.changed], [true, false]); assert.equal(s.db.writes, w);
  const r = await rebindTrader(s.db, { trader: T8073, toUid: "new_uid", reason: "владелец сменил аккаунт", apply: true });
  assert.deepEqual([r.ok, r.from, r.to], [true, "old_uid", "new_uid"]);
  const b = s.db.dump("trader_bindings")[T8073];
  assert.deepEqual([b.uid, b.previous_uid, b.rebound_by], ["new_uid", "old_uid", "admin-script"]);
  assert.equal(s.db.dump("users").old_uid.trader_id, null);
  assert.equal(s.db.dump("referrals")[T8073].academy.first_deposit.amount_cents, 6000);     // депозит не тронут
  assert.equal((await checkDep(s, "new_uid")).body.ok, true);
  assert.equal((await checkDep(s, "old_uid")).body.ok, false);
});

test("[8073] rebind-trader отказывает, если регистрация или депозит подтверждены за другим пользователем", async () => {
  const s = setup();
  const ownerClick = await s.clickOf("owner");
  await s.post({ type: "registration", click_id: ownerClick, trader_id: T8073, secret: SECRET });
  await s.bind("owner", T8073);
  await s.call("me", "intruder");
  const r = await rebindTrader(s.db, { trader: T8073, toUid: "intruder", reason: "x", apply: true });
  assert.equal(r.ok, false); assert.match(r.reason, /другим пользователем/);
  assert.equal(s.db.dump("trader_bindings")[T8073].uid, "owner");
  const t = setup();
  await prod8073(t);
  await t.db.collection("referrals").doc(T8073).set({ academy: { first_deposit: { verified: true, uid: "old_uid", amount_cents: 6000, currency: "USD", usd_cents: 6000 } } }, { merge: true });
  await t.call("me", "new_uid");
  const r2 = await rebindTrader(t.db, { trader: T8073, toUid: "new_uid", reason: "x", apply: true });
  assert.equal(r2.ok, false); assert.match(r2.reason, /первый депозит/);
});

test("[8073] данные старой версии: регистрация с click_id академии владельца без uid, ID привязан к другому — доступа у другого нет", async () => {
  const s = setup();
  const ownerClick = await s.clickOf("owner");
  await s.call("me", "squatter");
  await s.db.collection("referrals").doc(T8073).set({ academy: {
    registration: { verified: true, click_id: ownerClick },
    first_deposit: { verified: true, click_id: ownerClick, amount_cents: 6000, currency: "USD", usd_cents: 6000 } } });
  await s.db.collection("trader_bindings").doc(T8073).set({ uid: "squatter" });
  await s.db.collection("users").doc("squatter").set({ trader_id: T8073 }, { merge: true });
  const r = await checkDep(s, "squatter");
  assert.deepEqual([r.body.ok, r.body.amount, r.body.brokerRegistrationConfirmed], [false, 0, false]);
  assert.equal((await s.bind("owner", T8073)).statusCode, 200);                               // владелец забирает ID
  assert.equal((await checkDep(s, "owner")).body.ok, true);
  assert.equal(s.db.dump("users").squatter.trader_id, null);
});
