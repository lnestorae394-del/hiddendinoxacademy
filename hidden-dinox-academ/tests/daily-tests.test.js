"use strict";
/* Daily Tests: банк, ежедневный набор (Europe/Berlin), идемпотентность, нехватка вопросов, ответы, история, доступ, расписание. */
const test = require("node:test"), assert = require("node:assert"), path = require("path");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify } = require("./helpers/http");
const { adminCaller, learnCaller } = require("./helpers/router");
const { createAdminApi } = require("../academy/admin-api");
const { createLearnApi } = require("../academy/learn-api");
const { createAcademyApi } = require("../academy/api");
const D = require("../academy/daily-tests");
const { registerDailyCron } = require("../academy/daily-cron");
const BANK = path.join(__dirname, "..", "content", "daily-bank", "daily_bank.json");
const quiet = { log() {}, warn() {}, error() {} };
const T0 = Date.UTC(2026, 9, 31, 12, 0);           // 31.10.2026 13:00 по Берлину
let clock = T0; const now = () => clock;

test("время: дата и полночь по Берлину, переходы на летнее/зимнее время", () => {
  assert.strictEqual(D.berlinDateKey(Date.UTC(2026, 9, 31, 22, 59, 59)), "2026-10-31");
  assert.strictEqual(D.berlinDateKey(Date.UTC(2026, 9, 31, 23, 0, 0)), "2026-11-01");
  assert.strictEqual(new Date(D.nextReset(Date.UTC(2026, 2, 28, 23, 0))).toISOString(), "2026-03-29T22:00:00.000Z", "после перехода на летнее (CEST)");
  assert.strictEqual(new Date(D.nextReset(Date.UTC(2026, 9, 24, 22, 0))).toISOString(), "2026-10-25T23:00:00.000Z", "после перехода на зимнее (CET)");
  assert.strictEqual(new Date(D.nextReset(T0)).toISOString(), "2026-10-31T23:00:00.000Z");
});

async function setup({ bank = "file" } = {}) {
  clock = T0; const db = new FakeFirestore();
  const academyApi = createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet });
  const A = adminCaller(createAdminApi({ db, verifyIdToken: fakeVerify, log: quiet, now }));
  const L = learnCaller(createLearnApi({ db, academyApi, log: quiet, now }));
  await db.collection("users").doc("boss").set({ role: "admin", email: "b@t" });
  await db.collection("users").doc("staff").set({ role: "team_member", email: "s@t" });
  await db.collection("users").doc("staff2").set({ role: "team_member", email: "s2@t" });
  await db.collection("users").doc("stu").set({ role: "student", email: "u@t" });
  if (bank === "file") assert.strictEqual((await A("POST", "/daily/bank/import", { uid: "boss", body: { confirm: true } })).statusCode, 200);
  return { db, A, L, dt: D.createDailyTests({ db, now, log: quiet }) };
}
const activate = async (db) => { const F = require("../academy/features").createFeatures({ db }); await F.update("daily_tests", { status: "ACTIVE" }, "boss"); };

test("импорт банка: 320 вопросов (одобрено 259, на проверке 61); повторный импорт ничего не добавляет и не затирает правки", async () => {
  const { A, db } = await setup();
  const all = (await db.collection("daily_bank").get()).docs.map(d => d.data());
  assert.strictEqual(all.length, 320); assert.strictEqual(all.filter(q => q.status === "approved").length, 259);
  assert.ok(all.every(q => q.course_slug && Number.isInteger(q.module_index) && Number.isInteger(q.lesson_index) && q.block_id), "связь с курсом, модулем и уроком");
  const one = all.find(q => q.status === "approved");
  await A("PUT", "/daily/bank/" + one.id, { uid: "boss", body: { explanation: "Отредактировано администратором." } });
  const r = await A("POST", "/daily/bank/import", { uid: "boss", body: { confirm: true } });
  assert.deepStrictEqual([r.body.added, r.body.kept], [0, 320]);
  assert.strictEqual((await db.collection("daily_bank").doc(one.id).get()).data().explanation, "Отредактировано администратором.");
  assert.strictEqual((await A("POST", "/daily/bank/import", { uid: "boss", body: {} })).statusCode, 400, "без подтверждения");
});

test("набор: 5 заданий (2 HR + 2 SMC + 1 RM), только одобренные; повтор и параллельные запуски — один набор", async () => {
  const { db, dt } = await setup();
  const rs = await Promise.all([dt.ensureSet("2026-10-31"), dt.ensureSet("2026-10-31"), dt.ensureSet("2026-10-31")]);
  assert.deepStrictEqual(rs.map(r => r.status).sort(), ["created", "exists", "exists"]);
  const set = (await db.collection("daily_sets").doc("2026-10-31").get()).data();
  const by = c => set.questions.filter(q => q.course === c).length;
  assert.deepStrictEqual([set.questions.length, by("hr"), by("smc"), by("rm")], [5, 2, 2, 1]);
  const bank = new Map((await db.collection("daily_bank").get()).docs.map(d => [d.id, d.data()]));
  assert.ok(set.questions.every(q => bank.get(q.id).status === "approved"));
  assert.ok(set.questions.every(q => q.kind === bank.get(q.id).kind), "тип вопроса сохраняется в опубликованном наборе");
  assert.ok(new Set(set.questions.filter(q => q.course === "hr").map(q => q.kind)).size >= 2, "по возможности разные типы внутри курса");
  assert.ok(set.questions.every(q => bank.get(q.id).used_on === "2026-10-31" && bank.get(q.id).used_count === 1), "отмечены один раз");
  assert.ok(!JSON.stringify(set).includes('"correct"') && !JSON.stringify(set).includes('"explanation"'), "в наборе нет ответов и объяснений");
  assert.strictEqual(new Set(set.questions.filter(q => q.course === "hr").map(q => q.module_index)).size, 2, "разные модули");
  assert.strictEqual((await dt.ensureSet("2026-10-31")).status, "exists");
});

test("следующий день: новые вопросы без повторов; пропорции из админки влияют на следующий набор", async () => {
  const { A, db, dt } = await setup();
  await dt.ensureSet("2026-10-31");
  assert.strictEqual((await A("PUT", "/daily/config", { uid: "boss", body: { mix: { hr: 1, smc: 3, rm: 1 } } })).statusCode, 200);
  assert.strictEqual((await A("PUT", "/daily/config", { uid: "boss", body: { mix: { hr: 0, smc: 0, rm: 0 } } })).statusCode, 400);
  assert.strictEqual((await A("PUT", "/daily/config", { uid: "boss", body: { mix: { hr: 9, smc: 0, rm: 0 } } })).statusCode, 400);
  await dt.ensureSet("2026-11-01");
  const a = (await db.collection("daily_sets").doc("2026-10-31").get()).data().questions.map(q => q.id);
  const b = (await db.collection("daily_sets").doc("2026-11-01").get()).data().questions;
  assert.ok(!b.some(q => a.includes(q.id)), "без повторов");
  assert.deepStrictEqual(["hr", "smc", "rm"].map(c => b.filter(q => q.course === c).length), [1, 3, 1]);
});

test("нехватка вопросов: набор не публикуется, тревога администратору, «на проверке» не используются", async () => {
  const { A, L, db, dt } = await setup({ bank: "none" });
  const bank = db.collection("daily_bank"), mk = (id, course, status) => bank.doc(id).set({ id, course, course_slug: course, module_index: 0, lesson_index: 0, question_index: 0, block_id: "b", module_title: "M", lesson_title: "L",
    q: "Вопрос " + id, options: ["a", "b"], correct: 0, explanation: status === "approved" ? "Потому что a." : "", i18n: {}, status, used_on: null, used_count: 0 });
  await mk("h1", "hr", "approved"); await mk("h2", "hr", "needs_review"); await mk("s1", "smc", "approved"); await mk("s2", "smc", "approved"); await mk("r1", "rm", "approved");
  const r = await dt.ensureSet("2026-10-31");
  assert.strictEqual(r.status, "exhausted"); assert.deepStrictEqual(r.shortages, { hr: { need: 2, available: 1 } });
  assert.strictEqual((await db.collection("daily_sets").doc("2026-10-31").get()).exists, false, "неполный набор не публикуется");
  assert.strictEqual((await bank.doc("h2").get()).data().used_on, null, "непроверенный вопрос не использован");
  const st = await A("GET", "/daily/status", { uid: "boss" });
  assert.deepStrictEqual(st.body.bank_exhausted.shortages, { hr: { need: 2, available: 1 } });
  assert.ok(st.body.low_stock.some(x => x.course === "hr"));
  await activate(db);
  const t = await L("GET", "/daily/today", { uid: "staff" });
  assert.strictEqual(t.body.status, "updating"); assert.deepStrictEqual(t.body.tasks, []);
});

test("ученик: задания без ответов; ответ — разбор; повтор не меняет результат; будущая дата закрыта; история", async () => {
  const { L, db } = await setup(); await activate(db);
  const t = await L("GET", "/daily/today?lang=en", { uid: "staff", query: { lang: "en" } });
  assert.strictEqual(t.statusCode, 200); assert.strictEqual(t.body.tasks.length, 5); assert.strictEqual(t.body.date, "2026-10-31");
  assert.strictEqual(t.body.next_reset_at, Date.UTC(2026, 9, 31, 23, 0));
  assert.ok(!/"correct"|explanation|correct_index/.test(JSON.stringify(t.body)), "правильных ответов нет до попытки");
  assert.ok(t.body.tasks.every(x => x.status === "new" && !/[А-Яа-яЁё]/.test(x.q)), "EN-текст");
  assert.ok(t.body.tasks.every(x => typeof x.kind === "string"), "тип задания доступен ученику");
  const task = t.body.tasks[0];
  await L("POST", "/daily/start", { uid: "staff", body: { date: t.body.date, qid: task.id } });
  assert.strictEqual((await L("GET", "/daily/today", { uid: "staff" })).body.tasks[0].status, "in_progress");
  const keys = (await db.collection("daily_keys").doc("2026-10-31").get()).data().answers[task.id];
  const wrong = (keys.correct + 1) % task.options.length;
  clock += 42000;
  const a1 = await L("POST", "/daily/answer", { uid: "staff", body: { date: t.body.date, qid: task.id, answer: wrong } });
  assert.deepStrictEqual([a1.body.correct, a1.body.correct_index, a1.body.answer, a1.body.time_ms], [false, keys.correct, wrong, 42000]);
  assert.ok(a1.body.explanation && a1.body.lesson.lesson_title);
  assert.ok(typeof a1.body.kind === "string", "тип задания сохраняется в разборе");
  const a2 = await L("POST", "/daily/answer", { uid: "staff", body: { date: t.body.date, qid: task.id, answer: keys.correct } });
  assert.deepStrictEqual([a2.body.correct, a2.body.answer], [false, wrong], "повтор не меняет сохранённый результат");
  assert.strictEqual((await db.collection("daily_attempts").where("uid", "==", "staff").get()).docs.length, 1, "без дубликатов");
  assert.strictEqual((await L("POST", "/daily/answer", { uid: "staff", body: { date: t.body.date, qid: t.body.tasks[1].id, answer: 99 } })).statusCode, 400);
  assert.strictEqual((await L("POST", "/daily/answer", { uid: "staff", body: { date: "2026-11-05", qid: task.id, answer: 0 } })).statusCode, 403, "будущая дата");
  // на следующий день: пройденное — в истории, непройденное — в архиве незавершённых
  clock = Date.UTC(2026, 9, 31, 23, 30);
  const t2 = await L("GET", "/daily/today", { uid: "staff" });
  assert.strictEqual(t2.body.date, "2026-11-01"); assert.ok(t2.body.tasks.every(x => x.status === "new"), "старые задания не переносятся в «Сегодня»");
  const h = await L("GET", "/daily/history", { uid: "staff" });
  assert.deepStrictEqual(h.body.done.map(x => [x.id, x.correct]), [[task.id, false]]);
  assert.strictEqual(h.body.unfinished.length, 4); assert.ok(h.body.unfinished.every(x => x.date === "2026-10-31"));
  const late = await L("POST", "/daily/answer", { uid: "staff", body: { date: "2026-10-31", qid: h.body.unfinished[0].id, answer: 0 } });
  assert.strictEqual(late.statusCode, 200, "незавершённое из архива можно пройти");
  assert.strictEqual((await db.collection("daily_attempts").doc(`staff__2026-10-31__${h.body.unfinished[0].id}`).get()).data().archived, true);
  const other = await L("GET", "/daily/history", { uid: "staff2" });
  assert.strictEqual(other.body.done.length, 0, "результаты одного ученика не видны другому");
});

test("доступ: карточка не «Открыть» → 403 ученику, предпросмотр сотруднику; админ-API закрыт для ученика", async () => {
  const { A, L, db } = await setup();
  await db.collection("users").doc("stu2").set({ role: "student", email: "x@t", academy_status: "active" });
  const r = await L("GET", "/daily/today", { uid: "stu" });
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual((await L("GET", "/daily/today", { uid: "staff" })).statusCode, 200, "предпросмотр для сотрудника");
  for (const [m, p] of [["GET", "/daily/status"], ["GET", "/daily/bank"], ["POST", "/daily/run"], ["PUT", "/daily/config"]])
    assert.strictEqual((await A(m, p, { uid: "stu", body: {} })).statusCode, 403, p);
});

test("банк: одобрить без объяснения нельзя; правка не меняет опубликованный набор", async () => {
  const { A, db, dt } = await setup();
  const nr = (await db.collection("daily_bank").where("status", "==", "needs_review").get()).docs[0].data();
  assert.strictEqual((await A("PUT", "/daily/bank/" + nr.id, { uid: "boss", body: { status: "approved" } })).statusCode, 400);
  const ok = await A("PUT", "/daily/bank/" + nr.id, { uid: "boss", body: { explanation: "Реакция появляется после замедления и отката.", status: "approved" } });
  assert.strictEqual(ok.statusCode, 200); assert.strictEqual(ok.body.question.status, "approved");
  await dt.ensureSet("2026-10-31");
  const q = (await db.collection("daily_sets").doc("2026-10-31").get()).data().questions[0];
  await A("PUT", "/daily/bank/" + q.id, { uid: "boss", body: { explanation: "Новое объяснение", status: "disabled" } });
  const after = await A("GET", "/daily/sets/2026-10-31", { uid: "boss" });
  assert.notStrictEqual(after.body.questions[0].explanation, "Новое объяснение", "опубликованный набор не меняется задним числом");
});

test("запуск по расписанию: без секрета 503, неверный 403, верный — сегодня и завтра, частые вызовы 429", async () => {
  clock = T0; const db = new FakeFirestore(); const routes = {};
  const app = { post: (p, fn) => { routes[p] = fn; } };
  const call = async (secret, env) => { const res = { code: 0, body: null, set() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await routes["/internal/daily/run"]({ headers: secret ? { "x-cron-secret": secret } : {} }, res); return res; };
  registerDailyCron(app, { db, env: {}, log: quiet, now });
  assert.strictEqual((await call("x")).code, 503);
  const env = { DAILY_CRON_SECRET: "s".repeat(32) };
  registerDailyCron(app, { db, env, log: quiet, now });
  await D.createDailyTests({ db, now, log: quiet }).importBank(BANK);
  assert.strictEqual((await call("wrong")).code, 403);
  assert.strictEqual((await call("")).code, 403);
  const ok = await call("s".repeat(32));
  assert.strictEqual(ok.code, 200); assert.deepStrictEqual([ok.body.today.status, ok.body.tomorrow.status], ["created", "created"]);
  assert.strictEqual((await call("s".repeat(32))).code, 429);
  clock += 6000; const again = await call("s".repeat(32));
  assert.deepStrictEqual([again.body.today.status, again.body.tomorrow.status], ["exists", "exists"], "идемпотентно");
});

test("админ создаёт вопрос: валидация, график с media ID и обязательная ручная проверка", async () => {
  const { A, db, dt } = await setup({ bank: "none" });
  const base = { course: "smc", kind: "chart", module_title: "Структура рынка", lesson_title: "BOS и CHOCH", q: "Что видно на графике?", options: ["BOS", "CHOCH", "Нет подтверждения"], correct: 0, explanation: "Цена закрылась за предыдущим структурным максимумом." };
  assert.strictEqual((await A("POST", "/daily/bank", { uid: "boss", body: base })).statusCode, 400, "chart без изображения запрещён");
  const bad = await A("POST", "/daily/bank", { uid: "boss", body: { ...base, chart_image: "/media/not-valid" } });
  assert.strictEqual(bad.statusCode, 400, "нельзя передать произвольный URL");
  const created = await A("POST", "/daily/bank", { uid: "boss", body: { ...base, chart_image: "/media/med_0123456789abcdefabcd" } });
  assert.strictEqual(created.statusCode, 200);
  const q = created.body.question;
  assert.strictEqual(q.status, "needs_review"); assert.strictEqual(q.kind, "chart");
  assert.strictEqual(q.chart_image, "/media/med_0123456789abcdefabcd");
  assert.strictEqual((await db.collection("daily_bank").doc(q.id).get()).data().status, "needs_review");
  assert.strictEqual((await A("PUT", "/daily/bank/" + q.id, { uid: "boss", body: { status: "approved" } })).statusCode, 200);
  assert.strictEqual((await dt.bankList({ course: "smc", status: "approved" })).items.some(x => x.id === q.id), true);
});

test("Stage 7: полные переводы EN/UA сохраняются и валидируются по числу вариантов", async () => {
  const { dt } = await setup();
  const q = await dt.bankCreate({ course: "hr", kind: "choice", module_title: "Модуль", lesson_title: "Урок", q: "Вопрос?", options: ["Да", "Нет"], correct: 0, explanation: "Потому что да." });
  const updated = await dt.bankUpdate(q.id, { q_en: "Question?", options_en: ["Yes", "No"], lesson_title_en: "Lesson", module_title_en: "Module", explanation_en: "Because yes.", q_ua: "Питання?", options_ua: ["Так", "Ні"], explanation_ua: "Тому що так." });
  assert.strictEqual(updated.i18n.en.q, "Question?");
  assert.deepStrictEqual(updated.i18n.en.options, ["Yes", "No"]);
  assert.strictEqual(updated.i18n.ua.q, "Питання?");
  await assert.rejects(() => dt.bankUpdate(q.id, { options_en: ["Only one"] }), /количество должно совпадать/);
});

test("Stage 7: аналитика точности по курсам, типам и самым сложным вопросам", async () => {
  const { db, dt } = await setup();
  const q = await dt.bankCreate({ course: "hr", kind: "situation", module_title: "Модуль", lesson_title: "Урок", q: "Сложный вопрос?", options: ["A", "B"], correct: 0, explanation: "Потому что A." });
  await db.collection("daily_attempts").doc("a1").set({ qid: q.id, course: "hr", date: "2026-10-31", answer: 1, correct: false, status: "done" });
  await db.collection("daily_attempts").doc("a2").set({ qid: q.id, course: "hr", date: "2026-10-31", answer: 0, correct: true, status: "done" });
  await db.collection("daily_attempts").doc("a3").set({ qid: q.id, course: "hr", date: "2026-10-31", answer: 1, correct: false, status: "done" });
  const a = await dt.analytics();
  assert.strictEqual(a.total_attempts, 3);
  assert.strictEqual(a.overall_accuracy, 33);
  assert.strictEqual(a.by_course.hr.accuracy, 33);
  assert.strictEqual(a.by_kind.situation.attempts, 3);
  assert.strictEqual(a.hardest[0].id, q.id);
});
