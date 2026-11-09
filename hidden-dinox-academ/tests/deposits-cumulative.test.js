"use strict";
/* Суммирование депозитов, доступ от $50, $10 партнёру, ручной вывод: node --test tests/deposits-cumulative.test.js
   Настоящие обработчики (postback → депозиты → доступ → реферал → журнал → вывод → админка), тестовая Firestore. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify, fakeRes, fakeReq } = require("./helpers/http");
const { adminCaller } = require("./helpers/router");
const { createAdminApi } = require("../academy/admin-api");
const { createAcademyApi } = require("../academy/api");
const { createAcademyPostback } = require("../academy/postback");
const { registerReferralRoutes, autoReferral } = require("../academy/referral");
const { setLegacyCutoff } = require("../academy/access");
const SECRET = "test-postback-secret-0123456789abcdef", quiet = { log() {}, warn() {}, error() {} };
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

function setup({ eventIdParam = "" } = {}) {
  process.env.REFERRAL_MODE = "test"; process.env.REFERRAL_PAYOUTS_ENABLED = "1";
  const env = { REFERRAL_MODE: "test", REFERRAL_PAYOUTS_ENABLED: "1" };
  const db = new FakeFirestore(); let t = 1_800_000_000_000; const now = () => t;
  const auto = autoReferral({ db, env, log: quiet, now });
  const academyApi = createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet, now, onAccessChange: auto.onAccessChange });
  const pb = auto.wrapPostback(createAcademyPostback({ db, env: { POCKET_POSTBACK_SECRET: SECRET, POSTBACK_EVENT_ID_PARAM: eventIdParam }, log: quiet, now }));
  const A = adminCaller(createAdminApi({ db, verifyIdToken: fakeVerify, log: quiet, now }));
  const routes = []; const router = { get: (p, h) => routes.push(["GET", p, h]), post: (p, h) => routes.push(["POST", p, h]) };
  registerReferralRoutes(router, { db, academyApi, env, now, log: quiet });
  const U = async (method, path, { uid, body } = {}) => {
    for (const [m, p, h] of routes) {
      if (m !== method) continue; const mm = path.match(new RegExp("^" + p.replace(/:[a-z]+/g, "([^/]+)") + "$")); if (!mm) continue;
      const params = {}; (p.match(/:[a-z]+/g) || []).forEach((k, i) => (params[k.slice(1)] = decodeURIComponent(mm[i + 1])));
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
      await h({ headers: { authorization: "Bearer testtoken-" + uid }, body: body || {}, params, query: {} }, res); return res;
    }
    throw new Error("no route " + path);
  };
  const user = (uid, extra = {}) => db.collection("users").doc(uid).set({ email: uid + "@t.local", role: "student", created_at: t - 1000, ...extra }, { merge: true });
  const me = async uid => { const r = fakeRes(); await academyApi.me(fakeReq({ token: "testtoken-" + uid }), r); return r.body; };
  async function ready(uid, trader) {                         // регистрация у брокера + подтверждённый Trader ID, без депозита
    await user(uid); await me(uid);
    await pb.handle({ type: "registration", trader_id: trader, secret: SECRET });
    await academyApi.traderId(fakeReq({ token: "testtoken-" + uid, body: { traderId: trader } }), fakeRes());
  }
  const dep = (trader, amount, extra = {}) => pb.handle({ type: extra.type || "redeposit", trader_id: trader, amount: String(amount), currency: extra.currency === undefined ? "USD" : extra.currency, secret: SECRET, ...(extra.event_id ? { event_id: extra.event_id } : {}) });
  async function invite(referrer, invitee) {
    await user(referrer); await user(invitee);
    const m = await U("GET", "/referral/me", { uid: referrer });
    assert.equal((await U("POST", "/referral/attach", { uid: invitee, body: { code: m.body.code } })).statusCode, 200);
  }
  const ledger = async uid => (await db.collection("ledger").where("uid", "==", uid).get()).docs.map(d => d.data());
  const bal = async uid => { const d = await db.collection("partner_balances").doc(`${uid}__test`).get(); return d.exists ? d.data() : { available_cents: 0, reserved_cents: 0, paid_cents: 0, earned_cents: 0 }; };
  const settle = () => new Promise(r => setTimeout(r, 15));
  return { db, A, U, user, me, ready, dep, invite, ledger, bal, settle, pb, advance: ms => { t += ms; }, now };
}

test("$20 + $30: доступ открывается при $50, партнёр получает ровно $10 один раз; прогресс «$20 из $50, осталось $30»", async () => {
  const s = setup(); await s.invite("refA", "invB"); await s.ready("invB", "70000001");
  await s.dep("70000001", "20", { type: "ftd" });
  let p = await s.me("invB");
  assert.equal(p.academyAccess, false); assert.equal(p.depositState, "low");
  assert.deepEqual([p.depositProgress.confirmed_cents, p.depositProgress.required_cents, p.depositProgress.remaining_cents], [2000, 5000, 3000]);
  assert.equal(p.traderIdLocked, true);                                       // депозит засчитан — Trader ID больше не меняется
  assert.equal((await s.ledger("refA")).length, 0);
  s.advance(3 * DAY); await s.dep("70000001", "30");
  p = await s.me("invB");
  assert.equal(p.academyAccess, true); assert.equal(p.stage, "academy"); assert.equal(p.depositProgress.remaining_cents, 0);
  const acad = (await s.db.collection("referrals").doc("70000001").get()).data().academy;
  assert.equal(acad.access_granted.usd_cents, 5000); assert.equal(acad.access_granted.rule, "cumulative_usd_50");   // доступ сохранён в базе
  assert.deepEqual((await s.ledger("refA")).map(e => [e.type, e.amount_cents]), [["reward", 1000]]);
});

test("$20 + $10 + $25: доступ закрыт на $30, открывается на $55", async () => {
  const s = setup(); await s.ready("u1", "70000002");
  await s.dep("70000002", "20", { type: "ftd" }); s.advance(HOUR); await s.dep("70000002", "10");
  assert.equal((await s.me("u1")).academyAccess, false); assert.equal((await s.me("u1")).depositProgress.remaining_cents, 2000);
  s.advance(HOUR); await s.dep("70000002", "25");
  const p = await s.me("u1"); assert.equal(p.academyAccess, true); assert.equal(p.depositProgress.confirmed_cents, 5500);
});

test("порог: $49.99 одним депозитом и $25 + $24.99 — доступа нет; ровно $50.00 — есть", async () => {
  const a = setup(); await a.ready("u1", "70000003"); await a.dep("70000003", "49.99", { type: "ftd" });
  assert.equal((await a.me("u1")).academyAccess, false);
  const b = setup(); await b.ready("u1", "70000004"); await b.dep("70000004", "25", { type: "ftd" }); b.advance(HOUR); await b.dep("70000004", "24.99");
  assert.equal((await b.me("u1")).academyAccess, false); assert.equal((await b.me("u1")).depositProgress.confirmed_cents, 4999);
  const c = setup(); await c.ready("u1", "70000005"); await c.dep("70000005", "50.00", { type: "ftd" });
  assert.equal((await c.me("u1")).academyAccess, true);
});

test("повторный postback (ретрай доставки в течение 15 минут) не увеличивает сумму", async () => {
  const s = setup(); await s.ready("u1", "70000006");
  await s.dep("70000006", "20", { type: "ftd" }); s.advance(MIN);
  assert.equal((await s.dep("70000006", "20", { type: "ftd" })).status, "duplicate"); s.advance(5 * MIN);
  assert.equal((await s.dep("70000006", "20", { type: "ftd" })).status, "duplicate");
  assert.equal((await s.me("u1")).depositProgress.confirmed_cents, 2000);
});

test("ID транзакции (POSTBACK_EVENT_ID_PARAM): один ID не суммируется дважды даже позже; разные ID на ту же сумму — суммируются", async () => {
  const s = setup({ eventIdParam: "event_id" }); await s.invite("refA", "invB"); await s.ready("invB", "70000007");
  await s.dep("70000007", "20", { type: "ftd", event_id: "tx-1" }); s.advance(2 * DAY);
  assert.equal((await s.dep("70000007", "20", { event_id: "tx-1" })).status, "duplicate");
  await s.dep("70000007", "20", { event_id: "tx-2" });
  assert.equal((await s.me("invB")).depositProgress.confirmed_cents, 4000);
  await s.dep("70000007", "10", { event_id: "tx-3" });
  assert.equal((await s.me("invB")).academyAccess, true);
  const evs = (await s.db.collection("deposit_events").where("trader_id", "==", "70000007").get()).docs.map(d => d.id).sort();
  assert.deepEqual(evs, ["id_tx-1", "id_tx-2", "id_tx-3"]);                   // каждый депозит — отдельная запись
  assert.equal((await s.ledger("refA")).length, 1);
});

test("без ID события: то же пополнение позже окна ретраев — не теряется и не удваивается: ждёт решения администратора", async () => {
  const s = setup(); await s.invite("refA", "invB"); await s.ready("invB", "70000008");
  await s.user("adm", { role: "admin" }); await s.user("mod", { role: "moderator" });
  await s.dep("70000008", "10", { type: "ftd" }); await s.dep("70000008", "20"); s.advance(2 * HOUR);
  const r = await s.dep("70000008", "20");
  assert.equal(r.status, "deposit_pending_review");
  let p = await s.me("invB"); assert.equal(p.depositProgress.confirmed_cents, 3000); assert.equal(p.depositProgress.pending_count, 1); assert.equal(p.academyAccess, false);
  const key = Object.keys((await s.db.collection("referrals").doc("70000008").get()).data().academy.pending_deposits)[0];
  const url = `/deposits/70000008/${encodeURIComponent(key)}/review`;
  assert.equal((await s.A("POST", url, { uid: "mod", body: { decision: "count", reason: "x", confirm: true } })).statusCode, 403);
  assert.equal((await s.A("POST", url, { uid: "adm", body: { decision: "count", confirm: true } })).body.error, "REASON_REQUIRED");
  assert.equal((await s.A("POST", url, { uid: "adm", body: { decision: "count", reason: "x" } })).body.error, "CONFIRM_REQUIRED");
  // повторный ретрай того же позднего события дубля не создаёт
  assert.equal((await s.dep("70000008", "20")).status, "duplicate");
  const ok = await s.A("POST", url, { uid: "adm", body: { decision: "count", reason: "Второе пополнение подтверждено в Pocket Partners", confirm: true } });
  assert.equal(ok.statusCode, 200); assert.equal(ok.body.access_opened, true); assert.equal(ok.body.usd_cents, 5000);
  assert.equal((await s.A("POST", url, { uid: "adm", body: { decision: "count", reason: "ещё раз", confirm: true } })).body.error, "ALREADY_DECIDED");
  await s.settle();
  p = await s.me("invB"); assert.equal(p.academyAccess, true); assert.equal(p.depositProgress.confirmed_cents, 5000);
  assert.deepEqual((await s.ledger("refA")).map(e => e.amount_cents), [1000]);
  const audit = (await s.db.collection("audit_logs").get()).docs.map(d => d.data()).filter(a => a.action === "deposit.review");
  assert.equal(audit.length, 1); assert.equal(audit[0].details.reason, "Второе пополнение подтверждено в Pocket Partners");
  const u = (await s.A("GET", "/users/invB", { uid: "adm" })).body;
  assert.equal(u.deposits.events.length, 3); assert.equal(u.deposits.referrer.referrer_uid, "refA");
  assert.equal(u.user.deposit_progress.confirmed_cents, 5000);
  assert.equal((await s.A("GET", "/users?q=70000008", { uid: "adm" })).body.users[0].uid, "invB");           // поиск по Trader ID
});

test("параллельные события: одинаковые postback и пересечение порога двумя депозитами — одна сумма, одно начисление", async () => {
  const s = setup({ eventIdParam: "event_id" }); await s.invite("refA", "invB"); await s.ready("invB", "70000009");
  await Promise.all(Array.from({ length: 6 }, () => s.dep("70000009", "20", { type: "ftd", event_id: "tx-same" })));
  assert.equal((await s.me("invB")).depositProgress.confirmed_cents, 2000);
  await Promise.all([s.dep("70000009", "15", { event_id: "tx-a" }), s.dep("70000009", "15", { event_id: "tx-b" }), s.dep("70000009", "15", { event_id: "tx-a" })]);
  await s.settle();
  assert.equal((await s.me("invB")).depositProgress.confirmed_cents, 5000);
  assert.equal((await s.me("invB")).academyAccess, true);
  assert.deepEqual((await s.ledger("refA")).map(e => e.amount_cents), [1000]);
});

test("после достижения $50 доступ остаётся открытым (сохранён в базе), дополнительные депозиты не дают партнёру ещё $10", async () => {
  const s = setup(); await s.invite("refA", "invB"); await s.ready("invB", "70000010");
  await s.dep("70000010", "50", { type: "ftd" }); s.advance(HOUR); await s.dep("70000010", "100"); s.advance(HOUR); await s.dep("70000010", "7");
  assert.equal((await s.me("invB")).academyAccess, true);
  assert.deepEqual((await s.ledger("refA")).map(e => e.amount_cents), [1000]);
  // даже если сумма в записи позже окажется меньше (корректировка данных), доступ не закрывается
  await s.db.collection("referrals").doc("70000010").set({ academy: { deposit_totals: { USD: { sum_cents: 1000, count: 1 } } } }, { merge: true });
  const p = await s.me("invB"); assert.equal(p.academyAccess, true); assert.equal(p.accessReason, "persisted");
});

test("4 квалифицированных реферала = $40 — вывод недоступен; 5-й = $50 — заявка; резерв один раз", async () => {
  const s = setup(); await s.ready("refA", "70000100");
  for (let i = 1; i <= 4; i++) { await s.invite("refA", "inv" + i); await s.ready("inv" + i, "7000010" + i); await s.dep("7000010" + i, "50", { type: "ftd" }); }
  await s.settle();
  assert.equal((await s.bal("refA")).available_cents, 4000);
  assert.equal((await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 40, trader_id: "70000100", request_id: "req-four0001" } })).body.error, "INVALID_AMOUNT");
  assert.equal((await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, trader_id: "70000100", request_id: "req-four0002" } })).body.error, "INSUFFICIENT_BALANCE");
  await s.invite("refA", "inv5"); await s.ready("inv5", "70000105"); await s.dep("70000105", "20", { type: "ftd" }); s.advance(HOUR); await s.dep("70000105", "30"); await s.settle();
  assert.equal((await s.bal("refA")).available_cents, 5000);
  const body = { amount: 50, trader_id: "70000100", request_id: "req-five0001" };
  const [w1, w2] = await Promise.all([s.U("POST", "/referral/withdrawals", { uid: "refA", body }), s.U("POST", "/referral/withdrawals", { uid: "refA", body })]);
  assert.equal(w1.body.withdrawal.id, w2.body.withdrawal.id);                      // одна заявка
  assert.deepEqual([(await s.bal("refA")).available_cents, (await s.bal("refA")).reserved_cents], [0, 5000]);
  assert.equal((await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, trader_id: "70000100", request_id: "req-five0002" } })).body.error, "INSUFFICIENT_BALANCE");
  assert.equal((await s.db.collection("withdrawals").get()).size, 1);
});

test("Trader ID получателя — только подтверждённый ID партнёра; Trader ID приглашённого подставить нельзя", async () => {
  const s = setup(); await s.ready("refA", "70000200"); await s.invite("refA", "invB"); await s.ready("invB", "70000201"); await s.dep("70000201", "50", { type: "ftd" });
  await s.user("boss", { role: "super_admin" });
  await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", confirm: true, amount: 40, reason: "тест", op_id: "op-00000777" } }); await s.settle();
  assert.equal((await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, trader_id: "70000201", request_id: "req-swap0001" } })).body.error, "TRADER_MISMATCH");
  assert.equal((await s.bal("refA")).reserved_cents, 0);
  const ok = await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, trader_id: "70000200", request_id: "req-swap0002" } });
  assert.equal(ok.body.withdrawal.trader_id, "70000200");
  const unbound = setup(); await unbound.user("lonely");
  assert.equal((await unbound.U("POST", "/referral/withdrawals", { uid: "lonely", body: { amount: 50, trader_id: "70000999", request_id: "req-none0001" } })).body.error, "TRADER_REQUIRED");
});

test("«Выплачено» — только ручным подтверждением администратора после перевода; время не меняет статус; отклонение освобождает резерв один раз", async () => {
  const s = setup(); await s.ready("refA", "70000300"); await s.user("adm", { role: "admin" }); await s.user("boss", { role: "super_admin" });
  await s.A("POST", "/partners/refA/adjust", { uid: "boss", body: { type: "credit", confirm: true, amount: 100, reason: "тест", op_id: "op-00000888" } });
  const w = (await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, trader_id: "70000300", request_id: "req-paid0001" } })).body.withdrawal;
  s.advance(3 * DAY);
  assert.equal((await s.db.collection("withdrawals").doc(w.id).get()).data().status, "pending");     // ни через 24 часа, ни через 3 дня — сам не меняется
  assert.equal((await s.A("POST", `/withdrawals/${w.id}/status`, { uid: "adm", body: { status: "paid", confirm: true, payment_reference: "PP-1" } })).statusCode, 409);   // сразу из pending нельзя
  await s.A("POST", `/withdrawals/${w.id}/status`, { uid: "adm", body: { status: "processing" } });
  assert.equal((await s.A("POST", `/withdrawals/${w.id}/status`, { uid: "adm", body: { status: "paid", payment_reference: "PP-1" } })).statusCode, 400);           // без подтверждения
  await s.A("POST", `/withdrawals/${w.id}/status`, { uid: "adm", body: { status: "paid", confirm: true, payment_reference: "PP-TRANSFER-1", note: "Переведено через Pocket Partners" } });
  const done = (await s.db.collection("withdrawals").doc(w.id).get()).data();
  assert.equal(done.status, "paid"); assert.ok(done.paid_at); assert.equal(done.payment_reference, "PP-TRANSFER-1");
  assert.equal(done.history[done.history.length - 1].actor_uid, "adm");
  assert.equal((await s.A("POST", `/withdrawals/${w.id}/status`, { uid: "adm", body: { status: "paid", confirm: true, payment_reference: "PP-2" } })).statusCode, 409);
  const w2 = (await s.U("POST", "/referral/withdrawals", { uid: "refA", body: { amount: 50, trader_id: "70000300", request_id: "req-rej00001" } })).body.withdrawal;
  assert.equal((await s.A("POST", `/withdrawals/${w2.id}/status`, { uid: "adm", body: { status: "rejected" } })).statusCode, 400);   // причина обязательна
  await s.A("POST", `/withdrawals/${w2.id}/status`, { uid: "adm", body: { status: "rejected", note: "Не тот Trader ID" } });
  assert.equal((await s.A("POST", `/withdrawals/${w2.id}/status`, { uid: "adm", body: { status: "rejected", note: "ещё раз" } })).statusCode, 409);
  const b = await s.bal("refA"); assert.deepEqual([b.available_cents, b.reserved_cents, b.paid_cents], [5000, 0, 5000]);
});

test("переход с прежнего правила: первый депозит от $40 ДО перехода сохраняет доступ, ПОСЛЕ — нет; партнёру $10 по прежнему правилу не начисляется", async () => {
  const s = setup(); await s.invite("refA", "old"); await s.ready("old", "70000400");
  await s.dep("70000400", "40", { type: "ftd" });
  setLegacyCutoff(s.now() + 1);                                                // момент перехода — после депозита «old»
  try {
    s.advance(DAY); const p = await s.me("old");
    assert.equal(p.academyAccess, true); assert.equal(p.accessReason, "legacy_ftd40");
    assert.equal((await s.U("GET", "/referral/me", { uid: "refA" })).body.invites[0].status !== "rewarded", true);
    assert.equal((await s.ledger("refA")).length, 0);
    await s.ready("new", "70000401"); await s.dep("70000401", "40", { type: "ftd" });
    assert.equal((await s.me("new")).academyAccess, false);
  } finally { setLegacyCutoff(null); }
});

test("депозит без подтверждённой валюты не засчитывается и показывается как ожидающий", async () => {
  const s = setup(); await s.ready("u1", "70000500");
  await s.dep("70000500", "60", { type: "ftd", currency: "" });
  const p = await s.me("u1");
  assert.equal(p.academyAccess, false); assert.equal(p.depositProgress.confirmed_cents, 0); assert.equal(p.depositProgress.pending_count, 1);
  assert.deepEqual(p.depositProgress.pending_reasons, ["currency"]);
});

test("депозит чужого Trader ID не попадает в сумму пользователя; Trader ID с депозитами сменить нельзя", async () => {
  const s = setup(); await s.ready("u1", "70000600"); await s.dep("70000600", "30", { type: "ftd" });
  await s.ready("u2", "70000601"); await s.dep("70000601", "30", { type: "ftd" });
  assert.equal((await s.me("u1")).depositProgress.confirmed_cents, 3000);
  await s.ready("u1x", "70000602");                                            // этот ID зарегистрирован у брокера другим пользователем
  const res = fakeRes();
  await createAcademyApi({ db: s.db, verifyIdToken: fakeVerify, log: quiet, now: s.now }).traderId(fakeReq({ token: "testtoken-u1", body: { traderId: "70000602" } }), res);
  assert.equal(res.statusCode, 409); assert.equal((await s.me("u1")).traderId, "70000600");
});

/* ===== Начисление $10 при активации доступа: исторические и восстановленные активации — только через проверку ===== */
test("доступ по прежнему правилу ($40 до перехода) — активация историческая: не автоматически, после подтверждения — ровно $10", async () => {
  const s = setup(); await s.invite("refA", "old"); await s.ready("old", "70000700");
  await s.dep("70000700", "40", { type: "ftd" }); setLegacyCutoff(s.now() + 1);
  try {
    s.advance(HOUR); await s.U("GET", "/referral/me", { uid: "refA" });
    assert.equal((await s.db.collection("referral_invites").doc("old").get()).data().status, "historical_review");
    assert.equal((await s.ledger("refA")).length, 0);
    const { createReferral } = require("../academy/referral");
    const r = createReferral({ db: s.db, env: { REFERRAL_MODE: "test" }, now: s.now });
    assert.deepEqual(await r.approveHistorical(["old"], "boss", "проверено"), [{ invitee_uid: "old", status: "rewarded" }]);
    assert.deepEqual((await s.ledger("refA")).map(e => e.amount_cents), [1000]);
  } finally { setLegacyCutoff(null); }
});

test("подтверждение приглашённого без доступа ничего не начисляет и не оставляет «заранее одобренной» отметки", async () => {
  const s = setup(); await s.invite("refA", "invB"); await s.ready("invB", "70000701");
  const { createReferral } = require("../academy/referral");
  const r = createReferral({ db: s.db, env: { REFERRAL_MODE: "test" }, now: s.now });
  const res = await r.approveHistorical(["invB"], "boss", "попытка");
  assert.notEqual(res[0].status, "rewarded");
  assert.equal((await s.db.collection("referral_invites").doc("invB").get()).data().historical_approved, undefined);
  assert.equal((await s.ledger("refA")).length, 0);
});

test("восстановленный доступ (сумма была ≥ $50 до записи о доступе) — не новая активация: на проверку, без автоматических $10", async () => {
  const s = setup(); await s.ready("invB", "70000702");
  await s.dep("70000702", "60", { type: "ftd" });
  // старые данные: доступ был, но записи о нём в базе нет
  const ref = s.db.collection("referrals").doc("70000702"); const data = (await ref.get()).data(); delete data.academy.access_granted; await ref.set(data);
  await s.invite("refA", "invB"); s.advance(HOUR);
  await s.U("GET", "/referral/me", { uid: "refA" });                                     // начисления активны с этого момента
  s.advance(HOUR); await s.dep("70000702", "5");                                         // новое событие восстанавливает запись о доступе
  assert.equal((await ref.get()).data().academy.access_granted.backfilled, true);
  assert.equal((await s.db.collection("referral_invites").doc("invB").get()).data().status, "historical_review");
  assert.equal((await s.ledger("refA")).length, 0);
});
