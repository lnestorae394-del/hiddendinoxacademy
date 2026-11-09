"use strict";
/* Партнёрские ссылки Pocket Partners: node --test tests/partner-links.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify, fakeRes, fakeReq } = require("./helpers/http");
const { adminCaller } = require("./helpers/router");
const { createAdminApi } = require("../academy/admin-api");
const { createAcademyApi } = require("../academy/api");
const { registerPartnerLinkRoutes, validatePocketUrl } = require("../academy/partner-links");
const quiet = { log() {}, warn() {}, error() {} };
const PP = "https://u3.shortink.io/register?utm_campaign=836358&utm_source=affiliate&utm_medium=sr&a=STREAMER123&al=1805745&ac=stream&cid=1&code=XYZ";

function setup() {
  const db = new FakeFirestore(); let t = 1_800_000_000_000; const now = () => t;
  const academyApi = createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet, now });
  const A = adminCaller(createAdminApi({ db, verifyIdToken: fakeVerify, log: quiet, now }));
  const routes = []; const router = { get: (p, h) => routes.push(["GET", p, h]), post: (p, h) => routes.push(["POST", p, h]) };
  registerPartnerLinkRoutes(router, { db, academyApi, log: quiet });
  const U = async (method, path, { uid, body } = {}) => { const r = routes.find(x => x[0] === method && x[1] === path);
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
    await r[2]({ headers: uid ? { authorization: "Bearer testtoken-" + uid } : {}, body: body || {}, params: {} }, res); return res; };
  const user = (uid, extra = {}) => db.collection("users").doc(uid).set({ email: uid + "@t.local", role: "student", created_at: t - 1000, ...extra }, { merge: true });
  return { db, A, U, user, advance: ms => { t += ms; } };
}

test("ссылка Pocket Partners сохраняется полностью; чужие домены, http и мусор отклоняются", () => {
  assert.equal(validatePocketUrl(PP, {}), PP);
  for (const bad of ["http://u3.shortink.io/register?a=1", "https://evil.example/?u3.shortink.io", "javascript:alert(1)", "https://u3.shortink.io.evil.com/x", "https://user:pw@u3.shortink.io/x", ""])
    assert.throws(() => validatePocketUrl(bad, {}), undefined, bad);
  assert.equal(validatePocketUrl("https://po.example/r?x=1", { POCKET_LINK_HOSTS: "po.example" }), "https://po.example/r?x=1");
});

test("админка: создание, уникальный код, изменение, отключение; без прав — 403; действия в аудите", async () => {
  const s = setup(); await s.user("adm", { role: "admin" }); await s.user("ment", { role: "mentor" });
  assert.equal((await s.A("POST", "/partner-links", { uid: "ment", body: { code: "streamer123", name: "S", pocket_url: PP } })).statusCode, 403);
  const c = await s.A("POST", "/partner-links", { uid: "adm", body: { code: "Streamer123", name: "Стример", pocket_url: PP } });
  assert.equal(c.statusCode, 200); assert.equal(c.body.code, "streamer123");
  assert.equal((await s.A("POST", "/partner-links", { uid: "adm", body: { code: "streamer123", name: "Дубль", pocket_url: PP } })).body.error, "CODE_TAKEN");
  assert.equal((await s.A("POST", "/partner-links", { uid: "adm", body: { code: "x", name: "S", pocket_url: PP } })).body.error, "INVALID_CODE");
  assert.equal((await s.A("POST", "/partner-links", { uid: "adm", body: { code: "evil01", name: "S", pocket_url: "https://evil.example/" } })).body.error, "HOST_NOT_ALLOWED");
  await s.A("PUT", "/partner-links/streamer123", { uid: "adm", body: { name: "Стример 2" } });
  const l = (await s.A("GET", "/partner-links", { uid: "adm" })).body.links[0];
  assert.deepEqual([l.name, l.pocket_url, l.status, l.users_count], ["Стример 2", PP, "active", 0]);
  const acts = (await s.db.collection("audit_logs").get()).docs.map(d => d.data().action);
  assert.ok(acts.includes("partner_link.create") && acts.includes("partner_link.update"));
});

test("атрибуция: закрепляется один раз; кнопка брокера — ссылка партнёра; без партнёра или при отключении — основная", async () => {
  const s = setup(); await s.user("adm", { role: "admin" });
  await s.A("POST", "/partner-links", { uid: "adm", body: { code: "streamer123", name: "A", pocket_url: PP } });
  await s.A("POST", "/partner-links", { uid: "adm", body: { code: "other01", name: "B", pocket_url: PP.replace("STREAMER123", "OTHER") } });
  await s.user("u1"); await s.user("u2");
  assert.deepEqual((await s.U("GET", "/broker-link", { uid: "u2" })).body, { url: null, source: "default" });
  assert.equal((await s.U("POST", "/via/attach", { uid: "u1", body: { code: "streamer123" } })).body.code, "streamer123");
  assert.equal((await s.U("POST", "/via/attach", { uid: "u1", body: { code: "other01" } })).body.code, "streamer123");   // не перезаписывается
  const bl = (await s.U("GET", "/broker-link", { uid: "u1" })).body;
  assert.deepEqual([bl.url, bl.source], [PP, "partner"]);
  assert.equal((await s.A("GET", "/partner-links", { uid: "adm" })).body.links.find(x => x.code === "streamer123").users_count, 1);
  await s.A("PUT", "/partner-links/streamer123", { uid: "adm", body: { status: "disabled" } });
  assert.equal((await s.U("GET", "/broker-link", { uid: "u1" })).body.source, "default");
  // ни клик, ни закрепление не создают регистраций, FTD или начислений
  for (const c of ["referral_invites", "ledger", "referrals", "trader_bindings"]) assert.equal((await s.db.collection(c).get()).size, 0, c);
});

test("атрибуцию нельзя подменить после регистрации у брокера, к старому аккаунту и неактивной ссылкой", async () => {
  const s = setup(); await s.user("adm", { role: "admin" });
  await s.A("POST", "/partner-links", { uid: "adm", body: { code: "streamer123", name: "A", pocket_url: PP } });
  await s.user("withTrader", { trader_id: "12345678" }); await s.user("old", { created_at: 1 });
  assert.equal((await s.U("POST", "/via/attach", { uid: "withTrader", body: { code: "streamer123" } })).body.error, "ALREADY_REGISTERED_AT_BROKER");
  assert.equal((await s.U("POST", "/via/attach", { uid: "old", body: { code: "streamer123" } })).body.error, "ACCOUNT_TOO_OLD");
  await s.user("u3"); assert.equal((await s.U("POST", "/via/attach", { uid: "u3", body: { code: "nosuch" } })).statusCode, 404);
  assert.equal((await s.U("POST", "/via/attach", { body: { code: "streamer123" } })).statusCode, 401);
});
