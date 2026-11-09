"use strict";
/* Pre-Trade Routine: этапы из реальных данных Daily Tests / Chart Training, итог, завершение, выключенные модули, доступ. */
const test = require("node:test"), assert = require("node:assert"), path = require("path");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify } = require("./helpers/http");
const { learnCaller } = require("./helpers/router");
const { createLearnApi } = require("../academy/learn-api");
const { createAcademyApi } = require("../academy/api");
const D = require("../academy/daily-tests");
const quiet = { log() {}, warn() {}, error() {} };
let clock = Date.UTC(2026, 9, 31, 12, 0); const now = () => clock;
async function setup({ open = ["daily_tests", "chart_training", "pre_trade"] } = {}) {
  clock = Date.UTC(2026, 9, 31, 12, 0); const db = new FakeFirestore();
  const L = learnCaller(createLearnApi({ db, academyApi: createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet }), log: quiet, now }));
  for (const [id, role] of [["boss", "admin"], ["staff", "team_member"], ["staff2", "team_member"], ["stu", "student"]]) await db.collection("users").doc(id).set({ role, email: id + "@t" });
  const F = require("../academy/features").createFeatures({ db }); for (const id of open) await F.update(id, { status: "ACTIVE" }, "boss");
  const dt = D.createDailyTests({ db, now, log: quiet }); await dt.importBank(path.join(__dirname, "..", "content", "daily-bank", "daily_bank.json"));
  const CT = require("../academy/chart-training");
  for (const s of CT.SYNTH) if (s.id !== "sim_range_chop_1") await CT.createChartTraining({ db }).setActive(s.id, false);
  return { db, L, F };
}
const R = async (L, uid) => (await L("GET", "/routine/today", { uid })).body;
const step = (r, k) => r.steps.find(x => x.key === k);

test("новый ученик: этапы ожидают, завершить нельзя", async () => {
  const { L } = await setup(); const r = await R(L, "staff");
  assert.deepStrictEqual(r.steps.map(x => [x.key, x.status]), [["review", "pending"], ["daily", "pending"], ["chart", "pending"]]);
  assert.strictEqual(step(r, "daily").total, 5); assert.deepStrictEqual(step(r, "review").recommended, []);
  assert.strictEqual(r.can_complete, false); assert.strictEqual(r.summary.last_completed_date, null);
  const c = await L("POST", "/routine/mark", { uid: "staff", body: { step: "complete" } }); assert.strictEqual(c.statusCode, 409);
  assert.strictEqual((await L("POST", "/routine/mark", { uid: "staff", body: { step: "hack" } })).statusCode, 400);
});

test("полный маршрут: тесты (2 ошибки) → практика → повторение → итог и завершение; другой ученик не затронут", async () => {
  const { L, db } = await setup();
  const t = await L("GET", "/daily/today", { uid: "staff" }); const keys = (await db.collection("daily_keys").doc(t.body.date).get()).data().answers;
  for (const [i, task] of t.body.tasks.entries()) await L("POST", "/daily/answer", { uid: "staff", body: { date: t.body.date, qid: task.id, answer: i < 2 ? (keys[task.id].correct + 1) % task.options.length : keys[task.id].correct } });
  let r = await R(L, "staff");
  assert.deepStrictEqual([step(r, "daily").status, step(r, "daily").done, step(r, "daily").correct], ["done", 5, 3]);
  assert.deepStrictEqual(r.summary.tests, { done: 5, total: 5, correct: 3 });
  assert.strictEqual(r.summary.mistakes.topics.reduce((s, m) => s + m.n, 0), 2, "две ошибки в темах");
  assert.ok(step(r, "review").recommended.length >= 1 && step(r, "review").recommended.every(x => x.course_slug && Number.isInteger(x.module_index)), "уроки для повторения по ошибкам");
  const n = await L("GET", "/chart/next", { uid: "staff" });
  await L("POST", "/chart/answer", { uid: "staff", body: { session_id: n.body.session_id, direction: "up", factors: ["structure"], invalidation: "1.08", risk_percent: 1, explanation: "Покупаю в диапазоне без подтверждения." } });
  r = await R(L, "staff");
  assert.strictEqual(step(r, "chart").status, "done"); assert.strictEqual(r.summary.practice.sessions, 1);
  assert.ok(r.summary.mistakes.chart_factors.some(f => f.factor === "no_confirmation"), "пропущенный фактор в итоге");
  assert.strictEqual(r.can_complete, false, "повторение ещё не отмечено");
  await L("POST", "/routine/mark", { uid: "staff", body: { step: "review" } });
  r = await R(L, "staff"); assert.strictEqual(step(r, "review").status, "done"); assert.strictEqual(r.can_complete, true);
  assert.strictEqual((await L("POST", "/routine/mark", { uid: "staff", body: { step: "complete" } })).statusCode, 200);
  assert.strictEqual((await L("POST", "/routine/mark", { uid: "staff", body: { step: "complete" } })).statusCode, 200, "повтор не ломает");
  r = await R(L, "staff"); assert.deepStrictEqual([r.completed, r.summary.last_completed_date], [true, "2026-10-31"]);
  const other = await R(L, "staff2"); assert.deepStrictEqual([other.completed, other.summary.tests ? other.summary.tests.done : 0, step(other, "chart").status], [false, 0, "pending"]);
  // следующий день: этапы заново, дата последней подготовки и рекомендации за 7 дней сохраняются
  clock = Date.UTC(2026, 10, 1, 9, 0); r = await R(L, "staff");
  assert.deepStrictEqual([r.date, r.completed, step(r, "daily").status, step(r, "chart").status, step(r, "review").status], ["2026-11-01", false, "pending", "pending", "pending"]);
  assert.strictEqual(r.summary.last_completed_date, "2026-10-31"); assert.ok(step(r, "review").recommended.length >= 1);
});

test("выключенный модуль: этап «недоступен» и не блокирует завершение", async () => {
  const { L } = await setup({ open: ["daily_tests", "pre_trade"] });
  let r = await R(L, "staff"); assert.strictEqual(step(r, "chart").status, "unavailable");
  const t = await L("GET", "/daily/today", { uid: "staff" });
  for (const task of t.body.tasks) await L("POST", "/daily/answer", { uid: "staff", body: { date: t.body.date, qid: task.id, answer: 0 } });
  await L("POST", "/routine/mark", { uid: "staff", body: { step: "review" } });
  r = await R(L, "staff"); assert.strictEqual(r.can_complete, true);
});

test("доступ: карточка Pre-Trade не «Открыть» → 403 ученику, предпросмотр сотруднику", async () => {
  const { L } = await setup({ open: ["daily_tests", "chart_training"] });
  assert.strictEqual((await L("GET", "/routine/today", { uid: "stu" })).statusCode, 403);
  assert.strictEqual((await L("GET", "/routine/today", { uid: "staff" })).statusCode, 200);
});
