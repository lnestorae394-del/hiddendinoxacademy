"use strict";
/* Память AI-наставника: профиль ученика из реальных данных обучения, сводка диалога, изоляция, новый диалог, очистка. */
const test = require("node:test"), assert = require("node:assert"), path = require("path"), fs = require("fs");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify } = require("./helpers/http");
const { adminCaller, learnCaller } = require("./helpers/router");
const { createAdminApi } = require("../academy/admin-api");
const { createLearnApi } = require("../academy/learn-api");
const { createAcademyApi } = require("../academy/api");
const ROOT = path.join(__dirname, ".."), quiet = { log() {}, warn() {}, error() {} };
let base = null;
async function courses() {
  if (base) return base; const db = new FakeFirestore(), A = adminCaller(createAdminApi({ db, verifyIdToken: fakeVerify, log: quiet }));
  await db.collection("users").doc("boss").set({ role: "admin", email: "b@t" });
  for (const f of ["content/hidden-reaction-course.json", "content/binary/smart_money_concepts_binary.json", "content/binary/risk_management_binary.json"]) {
    const r = await A("POST", "/import/course", { uid: "boss", body: { confirm: true, data: JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")) } });
    await A("POST", `/courses/${r.body.course_id}/ready-all`, { uid: "boss", body: { confirm: true } }); await A("POST", `/courses/${r.body.course_id}/publish`, { uid: "boss", body: { confirm: true } }); }
  base = new Map(db.store); return base;
}
async function setup() {
  const db = new FakeFirestore(); db.store = new Map(await courses()); const calls = [];
  const api = async (url, init) => { const b = JSON.parse(init.body); calls.push(b); const sum = /^Сожми переписку/.test(b.system);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: sum ? "СВОДКА: ученик разбирал откат и BOS" : "Ответ наставника" }], usage: { input_tokens: 100, output_tokens: 20 } }) }; };
  const L = learnCaller(createLearnApi({ db, academyApi: createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet }), log: quiet, env: { ANTHROPIC_API_KEY: "k" }, mentorFetch: api }));
  for (const u of ["a", "b"]) await db.collection("users").doc(u).set({ role: "team_member", email: u + "@t" });
  await require("../academy/features").createFeatures({ db }).update("ai_mentor", { status: "ACTIVE" }, "boss");
  return { db, L, calls };
}
let n = 0; const say = (L, uid, text) => L("POST", "/mentor/message?lang=ru", { uid, query: { lang: "ru" }, body: { text, client_id: "mem_" + String(++n).padStart(6, "0") } });
const lastMain = calls => [...calls].reverse().find(b => !/^Сожми переписку/.test(b.system)).system;

test("профиль ученика из реальных данных: прогресс, слабый урок, ошибки Daily Tests и тренировки; можно отключить", async () => {
  const { db, L, calls } = await setup();
  const pubs = (await db.collection("published_courses").get()).docs.map(d => ({ id: d.id, ...d.data() })), hr = pubs.find(c => /HIDDEN/i.test(c.title));
  const [l1, l2] = hr.modules[0].lessons;
  await db.collection("lesson_progress").doc("a_" + l1.id).set({ uid: "a", course_id: hr.id, lesson_id: l1.id, completed: true, completed_at: Date.now() });
  await db.collection("lesson_progress").doc("a_" + l2.id).set({ uid: "a", course_id: hr.id, lesson_id: l2.id, quiz: { best_percent: 40, passed: false, at: Date.now() } });
  const today = new Date().toISOString().slice(0, 10);
  await db.collection("daily_sets").doc(today).set({ date: today, questions: [{ id: "q1", course: "smc", module_title: "Order Blocks и критерии качества", lesson_title: "Order Block", q: "?", options: ["a", "b"] }] });
  await db.collection("daily_attempts").doc("a__" + today + "__q1").set({ uid: "a", date: today, qid: "q1", status: "done", correct: false });
  await db.collection("chart_sessions").doc("s1").set({ uid: "a", status: "done", answered_at: Date.now(), grade: { missed: ["liquidity_sweep"], kind: "incomplete" } });
  await say(L, "a", "Привет, объясни откат"); const sys = lastMain(calls);
  assert.match(sys, /<student>[\s\S]*пройдено 1 из 29 уроков/); assert.match(sys, new RegExp(`низкий результат теста[^\\n]*«${l2.title}»`));
  assert.match(sys, /ошибки в ежедневных тестах[^\n]*Order Blocks и критерии качества \(1\)/); assert.match(sys, /пропускает: снятие ликвидности \(1\)/);
  assert.strictEqual((await L("POST", "/mentor/memory/profile", { uid: "a", body: { use: false } })).body.use_profile, false);
  await say(L, "a", "А что такое BOS?"); assert.doesNotMatch(lastMain(calls), /\n<student>\n/, "профиль отключён");
  await L("POST", "/mentor/new", { uid: "a", body: {} }); await say(L, "a", "Новый вопрос про FVG");
  assert.doesNotMatch(lastMain(calls), /\n<student>\n/, "настройка сохраняется после ответов и нового диалога");
  const v = await L("GET", "/mentor/memory", { uid: "a" }); assert.strictEqual(v.body.use_profile, false);
  await L("POST", "/mentor/memory/profile", { uid: "a", body: { use: true } }); await say(L, "a", "Ещё вопрос про ликвидность"); assert.match(lastMain(calls), /\n<student>\n/);
});

test("сводка диалога: создаётся после накопления сообщений, не на каждый запрос; используется дальше; изоляция учеников", async () => {
  const { L, calls } = await setup();
  for (let i = 1; i <= 7; i++) await say(L, "a", `Вопрос номер ${i} про откат и структуру рынка`);
  const sums = () => calls.filter(b => /^Сожми переписку/.test(b.system)).length;
  assert.strictEqual(sums(), 1, "одна сводка после 7 обменов (6 сообщений за окном), а не на каждый запрос");
  await say(L, "a", "А если наоборот?"); assert.match(lastMain(calls), /<conversation_summary>\nСВОДКА: ученик разбирал откат и BOS/);
  assert.strictEqual(sums(), 1, "следующее сообщение не вызывает новую сводку");
  await say(L, "b", "Что такое BOS?"); assert.doesNotMatch(lastMain(calls), /\n<conversation_summary>\n/, "сводка другого ученика не видна");
  await L("POST", "/mentor/new", { uid: "a", body: {} }); await say(L, "a", "Начнём заново");
  assert.doesNotMatch(lastMain(calls), /\n<conversation_summary>\n/, "новый диалог — без сводки прошлого");
});

test("«Забыть» стирает сводку (прогресс не трогает); «Очистить историю» удаляет сообщения и память", async () => {
  const { db, L, calls } = await setup();
  for (let i = 1; i <= 7; i++) await say(L, "a", `Вопрос ${i} про ордер блок и ликвидность`);
  assert.ok((await L("GET", "/mentor/memory", { uid: "a" })).body.summary);
  await db.collection("lesson_progress").doc("p").set({ uid: "a", course_id: "x", lesson_id: "y", completed: true });
  assert.strictEqual((await L("POST", "/mentor/memory/forget", { uid: "a", body: {} })).statusCode, 400, "с подтверждением");
  await L("POST", "/mentor/memory/forget", { uid: "a", body: { confirm: true } });
  assert.strictEqual((await L("GET", "/mentor/memory", { uid: "a" })).body.summary, null); assert.ok((await db.collection("lesson_progress").doc("p").get()).exists, "прогресс не тронут");
  await say(L, "a", "Продолжим"); assert.doesNotMatch(lastMain(calls), /\n<conversation_summary>\n/);
  for (let i = 1; i <= 7; i++) await say(L, "a", `Ещё вопрос ${i} про FVG и имбаланс`);
  await L("POST", "/mentor/clear", { uid: "a", body: { confirm: true } });
  assert.strictEqual((await db.collection("mentor_messages").where("uid", "==", "a").get()).docs.length, 0);
  assert.strictEqual((await L("GET", "/mentor/memory", { uid: "a" })).body.summary, null, "очистка истории стирает и сводку");
});
