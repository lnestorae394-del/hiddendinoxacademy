"use strict";
/* Блокировка аккаунтов (статус академии): node --test tests/ban.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify, fakeRes, fakeReq } = require("./helpers/http");
const { adminCaller, learnCaller } = require("./helpers/router");
const { createAdminApi } = require("../academy/admin-api");
const { createLearnApi } = require("../academy/learn-api");
const { createAcademyApi } = require("../academy/api");
const { createAcademyPostback } = require("../academy/postback");
const { registerReferralRoutes } = require("../academy/referral");
const { registerBookRoutes } = require("../academy/books");
const path = require("path");
const COURSE = require("../content/hidden-reaction-course.json");
const SECRET = "test-postback-secret-0123456789abcdef", quiet = { log() {}, warn() {}, error() {} };

function setup() {
  const db = new FakeFirestore(); const authCalls = [];
  const authAdmin = { updateUser: async (uid, v) => authCalls.push(["updateUser", uid, v]), revokeRefreshTokens: async uid => authCalls.push(["revoke", uid]) };
  const academyApi = createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet });
  const A = adminCaller(createAdminApi({ db, verifyIdToken: fakeVerify, log: quiet, authAdmin }));
  const L = learnCaller(createLearnApi({ db, academyApi, log: quiet }));
  const pb = createAcademyPostback({ db, env: { POCKET_POSTBACK_SECRET: SECRET }, log: quiet });
  const routes = []; const router = { get: (p, h) => routes.push(["GET", p, h]), post: (p, h) => routes.push(["POST", p, h]), put: (p, h) => routes.push(["PUT", p, h]) };
  registerReferralRoutes(router, { db, academyApi, env: { REFERRAL_MODE: "test" }, log: quiet });
  registerBookRoutes(router, { db, academyApi, root: path.resolve(__dirname, ".."), log: quiet });
  const R = async (method, p, uid, body) => { const r = routes.find(x => x[0] === method && x[1] === p);
    const res = { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { if (typeof k === "string") this.headers[k] = v; return this; }, setHeader() {}, end() { return this; }, send() { return this; } };
    await r[2]({ headers: { authorization: "Bearer testtoken-" + uid }, body: body || {}, params: { slug: "hidden-reaction-system" }, query: {} }, res); return res; };
  async function student(uid, trader) {
    await academyApi.me(fakeReq({ token: "testtoken-" + uid }), fakeRes());
    await pb.handle({ type: "registration", trader_id: trader, secret: SECRET });
    await academyApi.traderId(fakeReq({ token: "testtoken-" + uid, body: { traderId: trader } }), fakeRes());
    await pb.handle({ type: "ftd", trader_id: trader, amount: "60", currency: "USD", secret: SECRET });
  }
  return { db, A, L, R, academyApi, student, authCalls };
}

test("блокировка закрывает ВСЕ защищённые API академии при каждом запросе; разблокировка возвращает доступ с прогрессом и данными", async () => {
  const s = setup();
  await s.db.collection("users").doc("boss").set({ role: "super_admin", email: "boss@t" });
  const imp = await s.A("POST", "/import/course", { uid: "boss", body: { confirm: true, data: COURSE } });
  await s.A("POST", `/courses/${imp.body.course_id}/ready-all`, { uid: "boss", body: { confirm: true } }); await s.A("POST", `/courses/${imp.body.course_id}/publish`, { uid: "boss", body: { confirm: true } });
  await s.student("stu", "72000001");
  const lid = (await s.L("GET", `/learn/courses/${imp.body.course_id}`, { uid: "stu" })).body.course.modules[0].lessons[0].id;
  await s.L("POST", `/learn/lessons/${lid}/quiz`, { uid: "stu", body: { answers: COURSE.modules[0].lessons[0].blocks.find(b => b.type === "quiz").questions.map(q => q.correct) } });
  await s.db.collection("partner_balances").doc("stu__test").set({ uid: "stu", mode: "test", available_cents: 3000, reserved_cents: 0, paid_cents: 0, earned_cents: 3000 });
  assert.equal((await s.A("POST", "/users/stu/block", { uid: "boss", body: { blocked: true, reason: "Нарушение правил (внутр.)" } })).statusCode, 200);
  // каждый защищённый запрос — серверная проверка (старый токен тоже не помогает)
  const me = fakeRes(); await s.academyApi.me(fakeReq({ token: "testtoken-stu" }), me); assert.deepEqual([me.statusCode, me.body.error], [403, "ACCOUNT_BLOCKED"]);
  for (const [m, p, b] of [["GET", "/learn/courses"], ["GET", `/learn/courses/${imp.body.course_id}`], ["GET", `/learn/lessons/${lid}`], ["POST", `/learn/lessons/${lid}/quiz`, { answers: [0] }], ["POST", `/learn/lessons/${lid}/complete`, {}], ["GET", "/home/banners"]]) {
    const r = await s.L(m, p, { uid: "stu", body: b }); assert.equal(r.statusCode, 403, m + " " + p); assert.equal(r.body.error, "ACCOUNT_BLOCKED");
  }
  for (const [m, p] of [["GET", "/referral/me"], ["GET", "/learn/books/:slug/file"], ["GET", "/learn/books"]]) { const r = await s.R(m, p, "stu"); assert.equal(r.statusCode, 403, p); }
  const tr = fakeRes(); await s.academyApi.traderId(fakeReq({ token: "testtoken-stu", body: { traderId: "72000009" } }), tr); assert.equal(tr.statusCode, 403);
  const sl = fakeRes(); await s.academyApi.setLang(fakeReq({ token: "testtoken-stu", body: { lang: "en" } }), sl); assert.equal(sl.statusCode, 403);
  // данные не удалены; вход в Firebase не отключался (страница «аккаунт не активен» доступна после входа)
  assert.ok((await s.db.collection("lesson_progress").doc(`stu__${lid}`).get()).exists);
  assert.equal((await s.db.collection("partner_balances").doc("stu__test").get()).data().available_cents, 3000);
  assert.equal(s.authCalls.some(c => c[0] === "updateUser" && c[2].disabled === true), false);
  // разблокировка — доступ и прогресс на месте
  assert.equal((await s.A("POST", "/users/stu/block", { uid: "boss", body: { blocked: false } })).statusCode, 200);
  const c = await s.L("GET", "/learn/courses", { uid: "stu" }); assert.equal(c.statusCode, 200); assert.equal(c.body.courses[0].completed, 1);
  assert.equal(s.authCalls.some(c => c[0] === "updateUser" && c[2].disabled === false), true);         // вход включается, если его отключала старая версия
});

test("причина обязательна; повтор не пишет дубли в журнал; администратора не заблокировать; без прав — 403; кто и когда — сохраняется", async () => {
  const s = setup();
  for (const [uid, role] of [["boss", "super_admin"], ["adm", "admin"], ["adm2", "admin"], ["mod", "moderator"], ["u1", "student"]]) await s.db.collection("users").doc(uid).set({ role, email: uid + "@t" });
  assert.equal((await s.A("POST", "/users/u1/block", { uid: "adm", body: { blocked: true } })).body.error, "REASON_REQUIRED");
  assert.equal((await s.A("POST", "/users/u1/block", { uid: "mod", body: { blocked: true, reason: "x" } })).statusCode, 403);
  assert.equal((await s.A("POST", "/users/adm2/block", { uid: "boss", body: { blocked: true, reason: "x" } })).body.error, "STAFF_PROTECTED");
  assert.equal((await s.A("POST", "/users/u1/block", { uid: "adm", body: { blocked: true, reason: "спам" } })).statusCode, 200);
  assert.equal((await s.A("POST", "/users/u1/block", { uid: "adm", body: { blocked: true, reason: "спам" } })).body.unchanged, true);
  const info = (await s.A("GET", "/users/u1/ban", { uid: "adm" })).body;
  assert.deepEqual([info.blocked, info.blocked_by, info.blocked_by_email, info.blocked_reason], [true, "adm", "adm@t", "спам"]); assert.ok(info.blocked_at > 0);
  assert.equal((await s.A("GET", "/users/u1/ban", { uid: "mod" })).statusCode, 403);
  await s.A("POST", "/users/u1/block", { uid: "adm", body: { blocked: false } }); await s.A("POST", "/users/u1/block", { uid: "adm", body: { blocked: false } });
  const audit = (await s.db.collection("audit_logs").get()).docs.map(d => d.data().action).filter(a => a.startsWith("user."));
  assert.deepEqual(audit.sort(), ["user.block", "user.unblock"]);
});
