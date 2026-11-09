"use strict";
/* Chart Training: симуляции, скрытые свечи, оценка аргументации, одна попытка, CSV, доступ. */
const test = require("node:test"), assert = require("node:assert");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify } = require("./helpers/http");
const { adminCaller, learnCaller } = require("./helpers/router");
const { createAdminApi } = require("../academy/admin-api");
const { createLearnApi } = require("../academy/learn-api");
const { createAcademyApi } = require("../academy/api");
const C = require("../academy/chart-training");
const quiet = { log() {}, warn() {}, error() {} };
async function setup({ open = true } = {}) {
  const db = new FakeFirestore();
  const academyApi = createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet });
  const A = adminCaller(createAdminApi({ db, verifyIdToken: fakeVerify, log: quiet }));
  const L = learnCaller(createLearnApi({ db, academyApi, log: quiet }));
  for (const [id, role] of [["boss", "admin"], ["staff", "team_member"], ["staff2", "team_member"], ["stu", "student"]]) await db.collection("users").doc(id).set({ role, email: id + "@t" });
  if (open) await require("../academy/features").createFeatures({ db }).update("chart_training", { status: "ACTIVE" }, "boss");
  return { db, A, L, ct: C.createChartTraining({ db }) };
}
// только один активный сценарий — чтобы выбор был предсказуем
async function only(A, id) { for (const s of C.SYNTH) if (s.id !== id) await A("POST", `/chart/scenarios/${s.id}/status`, { uid: "boss", body: { active: false } }); }
const full = { factors: [], invalidation: "", risk_percent: 1, explanation: "Структура вверх, откат в дисконт." };

test("генератор: 12 сценариев, воспроизводимость, корректные свечи", () => {
  assert.strictEqual(C.SYNTH.length, 12);
  for (const s of C.SYNTH) { const a = C.synth(s.pattern, s.seed), b = C.synth(s.pattern, s.seed);
    assert.deepStrictEqual(a, b); assert.ok(a.every(x => x.h >= Math.max(x.o, x.c) && x.l <= Math.min(x.o, x.c))); assert.ok(a.length > C.PATTERNS[s.pattern].visible + 5); }
});

test("ученик получает только видимые свечи без ответа и критериев; скрытые — после ответа", async () => {
  const { A, L } = await setup(); await only(A, "sim_trend_up_pullback_1");
  const n = await L("GET", "/chart/next", { uid: "staff" });
  assert.strictEqual(n.statusCode, 200); const vis = C.PATTERNS.trend_up_pullback.visible;
  assert.strictEqual(n.body.scenario.candles.length, vis); assert.deepStrictEqual(n.body.scenario.label, { kind: "synthetic" });
  assert.ok(!/expected|"dir"|factors|pattern|seed/.test(JSON.stringify(n.body)), "нет ответа, шаблона и seed");
  const last = n.body.scenario.candles[vis - 1].c, low = Math.min(...n.body.scenario.candles.slice(-20).map(x => x.l));
  const r = await L("POST", "/chart/answer", { uid: "staff", body: { ...full, session_id: n.body.session_id, direction: "up", factors: ["structure", "premium_discount"], invalidation: (low - 0.0002).toFixed(5) } });
  assert.strictEqual(r.statusCode, 200); assert.ok(r.body.candles.length > vis, "раскрыты следующие свечи"); assert.strictEqual(r.body.visible, vis);
  assert.deepStrictEqual([r.body.grade.score, r.body.grade.kind], [100, "sound"], JSON.stringify(r.body.grade));
  assert.ok(last > 0);
});

test("оценка: противоположное направление, уровень отмены не с той стороны, высокий риск, нет объяснения", async () => {
  const { A, L } = await setup(); await only(A, "sim_trend_up_pullback_1");
  const n = await L("GET", "/chart/next", { uid: "staff" }), last = n.body.scenario.candles.slice(-1)[0].c;
  assert.strictEqual((await L("POST", "/chart/answer", { uid: "staff", body: { session_id: n.body.session_id, direction: "down", explanation: "коротко" } })).statusCode, 400, "объяснение короче 10");
  assert.strictEqual((await L("POST", "/chart/answer", { uid: "staff", body: { session_id: n.body.session_id, direction: "sideways" } })).statusCode, 400);
  const r = await L("POST", "/chart/answer", { uid: "staff", body: { session_id: n.body.session_id, direction: "down", factors: ["fvg"], invalidation: (last - 0.001).toFixed(5), risk_percent: 10, explanation: "Кажется, будет падение." } });
  const g = r.body.grade;
  assert.deepStrictEqual([g.criteria.direction, g.criteria.factors, g.criteria.invalidation, g.criteria.risk, g.kind], [0, 0, 0, 0, "rule_error"], JSON.stringify(g));
  assert.deepStrictEqual(g.missed.sort(), ["premium_discount", "structure"]); assert.deepStrictEqual(g.extra, ["fvg"]);
});

test("диапазон: «Нет сделки» — 100; сделка в диапазоне — «лучше было пропустить»", async () => {
  const { A, L } = await setup(); await only(A, "sim_range_chop_1");
  const a = await L("GET", "/chart/next", { uid: "staff" });
  const r1 = await L("POST", "/chart/answer", { uid: "staff", body: { session_id: a.body.session_id, direction: "no_trade", factors: ["no_confirmation"] } });
  assert.deepStrictEqual([r1.body.grade.score, r1.body.grade.kind], [100, "sound"]);
  const b = await L("GET", "/chart/next", { uid: "staff2" });
  const r2 = await L("POST", "/chart/answer", { uid: "staff2", body: { session_id: b.body.session_id, direction: "up", factors: ["structure"], invalidation: "1.08", risk_percent: 1, explanation: "Пробью вверх наугад." } });
  assert.strictEqual(r2.body.grade.kind, "forced_trade");
});

test("одна попытка: повтор возвращает тот же разбор; чужая сессия недоступна; история", async () => {
  const { A, L } = await setup(); await only(A, "sim_range_chop_1");
  const n = await L("GET", "/chart/next", { uid: "staff" });
  const r1 = await L("POST", "/chart/answer", { uid: "staff", body: { session_id: n.body.session_id, direction: "no_trade", factors: ["no_confirmation"] } });
  const r2 = await L("POST", "/chart/answer", { uid: "staff", body: { session_id: n.body.session_id, direction: "up", factors: [], invalidation: "1", risk_percent: 1, explanation: "Попробую изменить ответ" } });
  assert.deepStrictEqual(r2.body.answer, r1.body.answer); assert.deepStrictEqual(r2.body.grade, r1.body.grade);
  assert.strictEqual((await L("POST", "/chart/answer", { uid: "staff2", body: { session_id: n.body.session_id, direction: "no_trade" } })).statusCode, 404);
  assert.strictEqual((await L("GET", "/chart/session/" + n.body.session_id, { uid: "staff2", params: { id: n.body.session_id } })).statusCode, 404);
  const h = await L("GET", "/chart/history", { uid: "staff" }); assert.strictEqual(h.body.sessions.length, 1); assert.strictEqual(h.body.sessions[0].score, 100);
  const s = await L("GET", "/chart/session/" + n.body.session_id, { uid: "staff", params: { id: n.body.session_id } }); assert.strictEqual(s.statusCode, 200);
  assert.strictEqual((await L("GET", "/chart/history", { uid: "staff2" })).body.sessions.length, 0);
});

test("отключённые сценарии не выдаются; все отключены — NO_SCENARIOS", async () => {
  const { A, L } = await setup(); await only(A, "sim_range_chop_2");
  for (let i = 0; i < 3; i++) assert.strictEqual((await L("GET", "/chart/next", { uid: "staff" })).body.scenario.id, "sim_range_chop_2");
  await A("POST", "/chart/scenarios/sim_range_chop_2/status", { uid: "boss", body: { active: false } });
  const r = await L("GET", "/chart/next", { uid: "staff" }); assert.strictEqual(r.statusCode, 404); assert.strictEqual(r.body.error, "NO_SCENARIOS");
});

function csv(n, drift, from = 1.1) { let p = from, t = Date.UTC(2025, 5, 2, 8); const rows = ["Time,Open,High,Low,Close"];
  for (let i = 0; i < n; i++) { const o = p, c = +(o + drift(i)).toFixed(5); rows.push(`${new Date(t).toISOString()},${o.toFixed(5)},${(Math.max(o, c) + 0.0002).toFixed(5)},${(Math.min(o, c) - 0.0002).toFixed(5)},${c}`); p = c; t += 900e3; }
  return rows.join("\n"); }
test("CSV: импорт с источником; ошибки формата; обоснованная гипотеза, которая не реализовалась", async () => {
  const { A, L } = await setup();
  const base = { id: "eurusd_csv_1", instrument: "EUR/USD", timeframe: "M15", data_source: "Экспорт из терминала, учебное использование", visible: 50, expected_dir: "up", expected_factors: ["structure"] };
  const good = csv(70, i => i < 50 ? 0.0003 : -0.0004);       // до обрыва рост, после — падение
  assert.strictEqual((await A("POST", "/chart/import", { uid: "boss", body: { ...base, csv: good } })).statusCode, 200);
  assert.strictEqual((await A("POST", "/chart/import", { uid: "boss", body: { ...base, csv: good } })).statusCode, 400, "повтор ID");
  for (const [b, why] of [[{ ...base, id: "x2", data_source: "" }, "нет источника"], [{ ...base, id: "x3", visible: 10 }, "мало видимых"],
    [{ ...base, id: "x4", csv: good.replace(/\n.*$/, "\n2025-06-02T08:00:00.000Z,1.1,1.2,1.0,1.1") }, "время не возрастает"],
    [{ ...base, id: "x5", csv: good.replace(/^(Time[^\n]*\n[^,]*,)([^,]*),([^,]*),/m, "$1$2,0.5,") }, "High ниже Open/Close"], [{ ...base, id: "x6", csv: "a,b\n1,2" }, "нет столбцов"]])
    assert.strictEqual((await A("POST", "/chart/import", { uid: "boss", body: b })).statusCode, 400, why);
  await only(A, "eurusd_csv_1");
  const n = await L("GET", "/chart/next", { uid: "staff" });
  assert.deepStrictEqual(n.body.scenario.label, { kind: "historical", instrument: "EUR/USD", timeframe: "M15", data_source: base.data_source });
  assert.strictEqual(n.body.scenario.candles.length, 50);
  const last = n.body.scenario.candles[49].c;
  const r = await L("POST", "/chart/answer", { uid: "staff", body: { session_id: n.body.session_id, direction: "up", factors: ["structure"], invalidation: (last - 0.003).toFixed(5), risk_percent: 1, explanation: "Восходящая структура, жду продолжения." } });
  assert.deepStrictEqual([r.body.grade.kind, r.body.grade.outcome], ["sound_not_realized", "down"], "решение верное, рынок пошёл против — это не ошибка");
});

test("доступ: карточка не «Открыть» → 403 ученику; админ-API закрыт для ученика", async () => {
  const { A, L } = await setup({ open: false });
  assert.strictEqual((await L("GET", "/chart/next", { uid: "stu" })).statusCode, 403);
  assert.strictEqual((await L("GET", "/chart/next", { uid: "staff" })).statusCode, 200, "предпросмотр для сотрудника");
  for (const [m, p] of [["GET", "/chart/scenarios"], ["POST", "/chart/import"], ["POST", "/chart/scenarios/sim_range_chop_1/status"]]) assert.strictEqual((await A(m, p, { uid: "stu", body: {} })).statusCode, 403, p);
});

test("«Пропустить анализ»: без оценки, повтор безопасен, нельзя после ответа и нельзя ответить после пропуска; история; «Пройти снова»", async () => {
  const { A, L } = await setup(); await only(A, "sim_range_chop_1");
  const n = await L("GET", "/chart/next", { uid: "staff" });
  const k = await L("POST", "/chart/skip", { uid: "staff", body: { session_id: n.body.session_id } });
  assert.deepStrictEqual([k.statusCode, k.body.status], [200, "skipped"]);
  assert.strictEqual((await L("POST", "/chart/skip", { uid: "staff", body: { session_id: n.body.session_id } })).statusCode, 200, "повторный пропуск ничего не меняет");
  const ans = await L("POST", "/chart/answer", { uid: "staff", body: { session_id: n.body.session_id, direction: "no_trade" } });
  assert.deepStrictEqual([ans.statusCode, ans.body.error], [409, "SKIPPED"], "на пропущенный ответить нельзя");
  assert.strictEqual((await L("POST", "/chart/skip", { uid: "staff2", body: { session_id: n.body.session_id } })).statusCode, 404, "чужую сессию пропустить нельзя");
  const h = (await L("GET", "/chart/history", { uid: "staff" })).body.sessions;
  assert.deepStrictEqual(h.map(x => [x.status, x.score, x.kind]), [["skipped", null, "skipped"]]);
  // «Пройти снова» — только пропущенный сценарий
  assert.strictEqual((await L("GET", "/chart/next?retry=sim_trend_up_pullback_1", { uid: "staff", query: { retry: "sim_trend_up_pullback_1" } })).statusCode, 403);
  const again = await L("GET", "/chart/next?retry=sim_range_chop_1", { uid: "staff", query: { retry: "sim_range_chop_1" } });
  assert.strictEqual(again.statusCode, 200); assert.strictEqual(again.body.scenario.id, "sim_range_chop_1"); assert.notStrictEqual(again.body.session_id, n.body.session_id, "новая попытка");
  const r = await L("POST", "/chart/answer", { uid: "staff", body: { session_id: again.body.session_id, direction: "no_trade", factors: ["no_confirmation"] } });
  assert.strictEqual(r.body.grade.score, 100);
  assert.strictEqual((await L("POST", "/chart/skip", { uid: "staff", body: { session_id: again.body.session_id } })).statusCode, 409, "после ответа пропуск невозможен");
  const h2 = (await L("GET", "/chart/history", { uid: "staff" })).body.sessions;
  assert.deepStrictEqual(h2.map(x => x.status).sort(), ["done", "skipped"]);
});

test("пропуск не засчитывается в подготовку к сессии", async () => {
  const { A, L, db } = await setup(); await only(A, "sim_range_chop_1");
  await require("../academy/features").createFeatures({ db }).update("pre_trade", { status: "ACTIVE" }, "boss");
  const n = await L("GET", "/chart/next", { uid: "staff" });
  await L("POST", "/chart/skip", { uid: "staff", body: { session_id: n.body.session_id } });
  const r = (await L("GET", "/routine/today", { uid: "staff" })).body;
  assert.deepStrictEqual([r.steps.find(x => x.key === "chart").status, r.summary.practice], ["pending", null]);
});
