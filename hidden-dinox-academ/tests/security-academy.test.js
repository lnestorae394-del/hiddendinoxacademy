"use strict";
/* Аудит безопасности Academy: роли и повышение прав, закрытие административных маршрутов, кэш сводки. Все данные поддельные (Firestore в памяти). */
const test = require("node:test"), assert = require("node:assert/strict");
const { FakeFirestore } = require("./helpers/fake-firestore"), { fakeVerify } = require("./helpers/http"), { adminCaller } = require("./helpers/router"), { createAdminApi } = require("../academy/admin-api"), R = require("../academy/roles");
const quiet = { log() {}, warn() {}, error() {} }, NOW = 1_800_000_000_000;
async function setup(env = {}) {
  const db = new FakeFirestore(), clock = { t: NOW }, api = createAdminApi({ db, verifyIdToken: fakeVerify, storage: null, log: quiet, now: () => clock.t, env });
  for (const [u, r, extra] of [["stud", "student"], ["ment", "mentor"], ["mod", "moderator"], ["adm", "admin"], ["adm2", "admin"], ["sup", "super_admin"], ["victim", "student"], ["blk", "admin", { blocked: true }]]) await db.collection("users").doc(u).set(Object.assign({ email: u + "@test.local", role: r, created_at: NOW - 1000 }, extra || {}));
  return { db, clock, call: (m, p, o = {}) => adminCaller(api)(m, p, o), role: async u => (await db.collection("users").doc(u).get()).data().role };
}
test("повышение прав: роль меняется только строго выше своей, нельзя назначить равную/высшую, нельзя себе, нельзя администратору со стороны администратора", async () => {
  const x = await setup(), set = (uid, target, role) => x.call("POST", `/users/${target}/role`, { uid, body: { role } });
  for (const uid of ["stud", "ment", "mod"]) assert.equal((await set(uid, "victim", "moderator")).statusCode, 403, uid + " не может менять роли"); assert.equal(await x.role("victim"), "student");
  assert.equal((await set("adm", "victim", "admin")).statusCode, 403, "admin не назначает admin"); assert.equal((await set("adm", "victim", "super_admin")).statusCode, 403); assert.equal((await set("adm", "adm", "super_admin")).statusCode, 403, "самоповышение"); assert.equal((await set("adm", "adm2", "student")).statusCode, 403, "admin не понижает другого admin"); assert.equal((await set("adm", "sup", "student")).statusCode, 403);
  assert.deepEqual([await x.role("victim"), await x.role("adm"), await x.role("adm2"), await x.role("sup")], ["student", "admin", "admin", "super_admin"]);
  assert.equal((await set("adm", "victim", "moderator")).statusCode, 200); assert.equal(await x.role("victim"), "moderator"); assert.equal((await set("sup", "adm2", "mentor")).statusCode, 200); assert.equal((await set("adm", "victim", "нет-такой-роли")).statusCode >= 400, true); assert.equal(await x.role("victim"), "moderator");
  assert.equal((await set("sup", "victim", "__proto__")).statusCode >= 400, true);
});
test("блокировка: нельзя блокировать равного или выше; заблокированный администратор теряет доступ; поддельный токен и студент — отказ", async () => {
  const x = await setup(), block = (uid, target, reason = "проверка аудита") => x.call("POST", `/users/${target}/block`, { uid, body: { blocked: true, reason } });
  assert.equal((await block("adm", "adm2")).statusCode, 403); assert.equal((await block("adm", "sup")).statusCode, 403); assert.equal((await block("mod", "victim")).statusCode, 403); assert.equal((await block("adm", "victim", "")).statusCode, 400, "причина обязательна для журнала"); assert.equal((await block("adm", "adm")).statusCode, 403, "себя блокировать нельзя"); assert.equal((await block("adm", "victim")).statusCode, 200); assert.equal((await x.db.collection("users").doc("victim").get()).data().blocked, true);
  assert.equal((await x.call("GET", "/dashboard", { uid: "blk" })).statusCode, 403); assert.equal((await x.call("GET", "/dashboard", { uid: "stud" })).statusCode, 403); assert.equal((await x.call("GET", "/dashboard", { uid: undefined })).statusCode, 401);
  const r = await adminCaller(createAdminApi({ db: x.db, verifyIdToken: fakeVerify, storage: null, log: quiet, now: () => NOW }))("GET", "/dashboard", { headers: { authorization: "Bearer forged.jwt.token" } }); assert.equal(r.statusCode, 401);
});
test("финансовые права: ручная корректировка баланса только у super_admin; выплаты — у admin и выше; остальные роли отказ", () => {
  assert.ok(R.can("super_admin", "finance.adjust") && !R.can("admin", "finance.adjust") && !R.can("moderator", "finance.adjust"));
  assert.ok(R.can("admin", "finance.payouts") && !R.can("moderator", "finance.payouts") && !R.can("student", "finance.payouts")); assert.ok(!R.can("student", "admin.enter") && R.can("mentor", "admin.enter")); assert.ok(!R.can("super_admin", "несуществующее.право"), "неизвестное право не выдаётся никому");
  assert.equal(R.roleOf({ role: "super_admin " }), "student", "роль с лишним пробелом не повышает"); assert.equal(R.roleOf({ role: "__proto__" }), "student"); assert.equal(R.roleOf(null), "student");
});
test("кэш сводки админки: в пределах TTL — один подсчёт (защита Firestore от лавины чтений), после TTL данные свежие; кэш можно отключить", async () => {
  const x = await setup({ ADMIN_DASH_CACHE_MS: "15000" }), total = async () => (await x.call("GET", "/dashboard", { uid: "adm" })).body.users.total, n0 = await total();
  await x.db.collection("users").doc("newbie").set({ email: "n@test.local", role: "student", created_at: NOW }); assert.equal(await total(), n0, "в пределах TTL — из кэша"); x.clock.t += 16000; assert.equal(await total(), n0 + 1, "после TTL — свежие данные");
  const y = await setup({ ADMIN_DASH_CACHE_MS: "0" }), t0 = (await y.call("GET", "/dashboard", { uid: "adm" })).body.users.total; await y.db.collection("users").doc("n2").set({ email: "n2@test.local", role: "student", created_at: NOW }); assert.equal((await y.call("GET", "/dashboard", { uid: "adm" })).body.users.total, t0 + 1, "с отключённым кэшем — сразу");
});
