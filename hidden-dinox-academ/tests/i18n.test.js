"use strict";
/* Переводы курса Hidden Reaction (EN, UA): node --test tests/i18n.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify, fakeRes, fakeReq } = require("./helpers/http");
const { adminCaller, learnCaller } = require("./helpers/router");
const { createAdminApi } = require("../academy/admin-api");
const { createLearnApi } = require("../academy/learn-api");
const { createAcademyApi } = require("../academy/api");
const { createAcademyPostback } = require("../academy/postback");
const COURSE = require("../content/hidden-reaction-course.json");
const SECRET = "test-postback-secret-0123456789abcdef", quiet = { log() {}, warn() {}, error() {} };
const CYR = /[А-Яа-яЁёІіЇїЄєҐґ]/;

function setup() {
  const db = new FakeFirestore();
  const academyApi = createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet });
  const A = adminCaller(createAdminApi({ db, verifyIdToken: fakeVerify, log: quiet }));
  const L = learnCaller(createLearnApi({ db, academyApi, log: quiet }));
  const pb = createAcademyPostback({ db, env: { POCKET_POSTBACK_SECRET: SECRET }, log: quiet });
  async function student(uid, trader) {
    await academyApi.me(fakeReq({ token: "testtoken-" + uid }), fakeRes());
    await pb.handle({ type: "registration", trader_id: trader, secret: SECRET });
    await academyApi.traderId(fakeReq({ token: "testtoken-" + uid, body: { traderId: trader } }), fakeRes());
    await pb.handle({ type: "ftd", trader_id: trader, amount: "60", currency: "USD", secret: SECRET });
  }
  async function publishAll(data) {
    await db.collection("users").doc("boss").set({ role: "super_admin" });
    const imp = await A("POST", "/import/course", { uid: "boss", body: { confirm: true, data } });
    assert.equal(imp.statusCode, 200, JSON.stringify(imp.body));
    await A("POST", `/courses/${imp.body.course_id}/ready-all`, { uid: "boss", body: { confirm: true } });
    assert.equal((await A("POST", `/courses/${imp.body.course_id}/publish`, { uid: "boss", body: { confirm: true } })).statusCode, 200);
    return imp.body.course_id;
  }
  return { db, A, L, student, publishAll };
}
const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (k === "tr" ? undefined : v)));

test("все 29 уроков на EN и UA переведены полностью; в английской выдаче нет кириллицы; правильных ответов нет", async () => {
  const s = setup(); const cid = await s.publishAll(COURSE); await s.student("stu", "71000001");
  const tree = (await s.L("GET", `/learn/courses/${cid}?lang=en`, { uid: "stu" })).body.course;
  assert.equal(tree.title, "HIDDEN DINOX — The Hidden Reaction System");
  assert.equal(tree.modules[0].title, "Foundations of the Hidden Reaction system");
  assert.equal(tree.translation.complete, true);
  const list = (await s.L("GET", "/learn/courses?lang=ua", { uid: "stu" })).body;
  for (const [name, body] of [["дерево курса", tree], ["список курсов", list]]) assert.equal(JSON.stringify(body).includes('"tr":'), false, name + ": служебное поле переводов не отдаётся");
  const ids = tree.modules.flatMap(m => m.lessons.map(l => l.id)); assert.equal(ids.length, 29);
  for (const lang of ["en", "ua"]) for (const id of ids) {
    const r = (await s.L("GET", `/learn/lessons/${id}?lang=${lang}`, { uid: "stu" })).body;
    assert.equal(r.lesson.translation.complete, true, `${lang} ${id}: не хватает ${r.lesson.translation.missing}`);
    const qs = r.lesson.blocks.filter(b => b.type === "quiz").flatMap(b => b.questions);
    assert.ok(qs.every(q => !("correct" in q) && !("explanation" in q)), "ответы скрыты");
    if (lang === "en") assert.equal(CYR.test(JSON.stringify([r.lesson, r.nav])), false, "кириллица в EN: " + id);
    assert.equal("tr" in r.lesson, false);
  }
});

test("русский по умолчанию и при неизвестном языке; поле переводов не отдаётся", async () => {
  const s = setup(); const cid = await s.publishAll(COURSE); await s.student("stu", "71000002");
  const id = (await s.L("GET", `/learn/courses/${cid}`, { uid: "stu" })).body.course.modules[0].lessons[0].id;
  for (const q of ["", "?lang=ru", "?lang=de", "?lang=__proto__"]) {
    const r = (await s.L("GET", `/learn/lessons/${id}${q}`, { uid: "stu" })).body.lesson;
    assert.equal(r.title, "Рынок не хаос: идея системы", q); assert.equal("tr" in r, false);
  }
});

test("тест: оценка одинакова на любом языке, объяснения на языке ученика; прогресс общий для всех языков", async () => {
  const s = setup(); const cid = await s.publishAll(COURSE); await s.student("stu", "71000003");
  const id = (await s.L("GET", `/learn/courses/${cid}`, { uid: "stu" })).body.course.modules[0].lessons[0].id;
  const qb = COURSE.modules[0].lessons[0].blocks.find(b => b.type === "quiz");
  const right = qb.questions.map(q => q.correct), wrong = qb.questions.map(q => (q.correct + 1) % q.options.length);
  const ru = (await s.L("POST", `/learn/lessons/${id}/quiz`, { uid: "stu", body: { block_id: null, answers: wrong } })).body;
  const en = (await s.L("POST", `/learn/lessons/${id}/quiz`, { uid: "stu", body: { block_id: null, answers: wrong, lang: "en" } })).body;
  assert.deepEqual([ru.score, ru.percent, ru.passed], [en.score, en.percent, en.passed]);
  assert.match(en.results[0].explanation, /^P\. 3/); assert.match(ru.results[0].explanation, /^Стр\. 3/);
  const ua = (await s.L("POST", `/learn/lessons/${id}/quiz`, { uid: "stu", body: { answers: right, lang: "ua" } })).body;
  assert.equal(ua.passed, true); assert.match(ua.results[0].explanation, /^Стор\. 3/);
  await s.L("POST", `/learn/lessons/${id}/complete`, { uid: "stu", body: {} });
  for (const lang of ["ru", "en", "ua"]) assert.equal((await s.L("GET", `/learn/courses/${cid}?lang=${lang}`, { uid: "stu" })).body.course.completed, 1, lang);
});

test("правка русского текста: устаревший перевод не показывается (русский + пометка), остальное остаётся переведённым; переводы не теряются при сохранении", async () => {
  const s = setup(); const cid = await s.publishAll(COURSE); await s.student("stu", "71000004");
  const lid = (await s.A("GET", "/courses/" + cid, { uid: "boss" })).body.modules[0].lessons[0].id;
  const les = (await s.A("GET", "/lessons/" + lid, { uid: "boss" })).body.lesson;
  const ti = les.blocks.findIndex(b => b.type === "text");
  les.blocks[ti].text = "Новый русский текст объяснения.";
  assert.equal((await s.A("PUT", "/lessons/" + lid, { uid: "boss", body: { title: les.title, outcome: les.outcome, source_pages: les.source_pages, status: "ready", pass_criteria: les.pass_criteria, blocks: les.blocks } })).statusCode, 200);
  assert.ok((await s.db.collection("course_lessons").doc(lid).get()).data().tr.en, "переводы сохранились после правки");
  await s.A("POST", `/courses/${cid}/publish`, { uid: "boss", body: { confirm: true } });
  const r = (await s.L("GET", `/learn/lessons/${lid}?lang=en`, { uid: "stu" })).body.lesson;
  assert.equal(r.blocks[ti].text, "Новый русский текст объяснения.");
  assert.deepEqual([r.translation.complete, r.translation.missing], [false, 1]);
  assert.equal(r.title, "The market is not chaos: the idea of the system");
});

test("«Обновить переводы»: курс без переводов получает их без смены ID и прогресса; несовпадение пропускается с объяснением; только с правами и подтверждением", async () => {
  const s = setup(); const cid = await s.publishAll(strip(COURSE)); await s.student("stu", "71000005");
  const lid = (await s.L("GET", `/learn/courses/${cid}`, { uid: "stu" })).body.course.modules[0].lessons[0].id;
  await s.L("POST", `/learn/lessons/${lid}/quiz`, { uid: "stu", body: { answers: COURSE.modules[0].lessons[0].blocks.find(b => b.type === "quiz").questions.map(q => q.correct) } });
  await s.L("POST", `/learn/lessons/${lid}/complete`, { uid: "stu", body: {} });
  // Курс импортирован без переводов (как у курса, загруженного до их появления): переводы, поставляемые с приложением,
  // подставляются автоматически — без ручных шагов, с проверкой отпечатков оригинала
  const before = (await s.L("GET", `/learn/lessons/${lid}?lang=en`, { uid: "stu" })).body.lesson;
  assert.equal(before.title, "The market is not chaos: the idea of the system"); assert.equal(before.translation.complete, true);
  await s.db.collection("users").doc("adm").set({ role: "mentor" });
  assert.equal((await s.A("POST", "/import/translations", { uid: "adm", body: { confirm: true, data: COURSE } })).statusCode, 403);
  assert.equal((await s.A("POST", "/import/translations", { uid: "boss", body: { data: COURSE } })).statusCode, 400);
  const changed = JSON.parse(JSON.stringify(COURSE)); changed.modules[5].lessons[0].title = "Другое название";
  const r = await s.A("POST", "/import/translations", { uid: "boss", body: { confirm: true, data: changed } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.lessons, 28); assert.equal(r.body.skipped.length, 1); assert.match(r.body.skipped[0], /6\.1/);
  await s.A("POST", `/courses/${cid}/publish`, { uid: "boss", body: { confirm: true } });
  const after = (await s.L("GET", `/learn/lessons/${lid}?lang=en`, { uid: "stu" })).body;
  assert.equal(after.lesson.id, lid); assert.equal(after.lesson.title, "The market is not chaos: the idea of the system"); assert.equal(after.lesson.translation.complete, true);
  assert.equal(after.progress.completed, true);                                                        // прогресс на месте
  const audit = (await s.db.collection("audit_logs").get()).docs.map(d => d.data().action); assert.ok(audit.includes("course.translations"));
});

test("переводы проверяются: неверный ключ или не-строка отклоняются", () => {
  const C = require("../academy/content");
  assert.throws(() => C.lesson({ title: "x", tr: { en: { "../x": "a" } } }), C.ValidationError);
  assert.throws(() => C.lesson({ title: "x", tr: { en: { title: 5 } } }), C.ValidationError);
  assert.throws(() => C.lesson({ title: "x", tr: "строка" }), C.ValidationError);
  assert.deepEqual(C.lesson({ title: "x", tr: { en: { title: "X" }, src: { title: C.trHash("x") } } }).tr, { en: { title: "X" }, src: { title: C.trHash("x") } });
});

test("курс без переводов в базе: EN/UA работают для всех 29 уроков за счёт переводов приложения; правка оригинала обнаруживается", async () => {
  const s = setup(); const cid = await s.publishAll(strip(COURSE)); await s.student("stu", "71000099");
  const tree = (await s.L("GET", `/learn/courses/${cid}?lang=ua`, { uid: "stu" })).body.course;
  assert.equal(tree.modules[0].title, "Основи системи Hidden Reaction");
  for (const id of tree.modules.flatMap(m => m.lessons.map(l => l.id)))
    for (const lang of ["en", "ua"]) assert.equal((await s.L("GET", `/learn/lessons/${id}?lang=${lang}`, { uid: "stu" })).body.lesson.translation.complete, true, lang + " " + id);
  // администратор меняет русский текст — перевод этой строки честно считается отсутствующим
  const lid = (await s.A("GET", "/courses/" + cid, { uid: "boss" })).body.modules[0].lessons[0].id;
  const les = (await s.A("GET", "/lessons/" + lid, { uid: "boss" })).body.lesson; const ti = les.blocks.findIndex(b => b.type === "text");
  les.blocks[ti].text = "Изменённый текст."; await s.A("PUT", "/lessons/" + lid, { uid: "boss", body: { title: les.title, outcome: les.outcome, source_pages: les.source_pages, status: "ready", blocks: les.blocks, pass_criteria: les.pass_criteria } });
  await s.A("POST", `/courses/${cid}/publish`, { uid: "boss", body: { confirm: true } });
  const r = (await s.L("GET", `/learn/lessons/${lid}?lang=en`, { uid: "stu" })).body.lesson;
  assert.deepEqual([r.translation.complete, r.translation.missing], [false, 1]);
  const d = (await s.A("GET", "/diagnostics", { uid: "boss" })).body.translations[0];
  assert.deepEqual([d.lessons, d.en.complete, d.en.missing_strings, d.ua.complete], [29, 28, 1, 28]);      // диагностика видит устаревшую строку
});

test("язык интерфейса сохраняется в профиле и возвращается при следующем входе; неверный язык и запрос без входа отклоняются", async () => {
  const db = new FakeFirestore(); const api = createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet });
  await api.me(fakeReq({ token: "testtoken-u1" }), fakeRes());
  let r = fakeRes(); await api.setLang(fakeReq({ token: "testtoken-u1", body: { lang: "ua" } }), r); assert.equal(r.statusCode, 200);
  r = fakeRes(); await api.me(fakeReq({ token: "testtoken-u1" }), r); assert.equal(r.body.lang, "ua");
  r = fakeRes(); await api.setLang(fakeReq({ token: "testtoken-u1", body: { lang: "de" } }), r); assert.equal(r.statusCode, 400);
  r = fakeRes(); await api.setLang(fakeReq({ body: { lang: "en" } }), r); assert.equal(r.statusCode, 401);
  r = fakeRes(); await api.me(fakeReq({ token: "testtoken-u1" }), r); assert.equal(r.body.lang, "ua");
});

/* ===== Прогресс курса: единый расчёт, автоматическое завершение урока по тесту, завершение курса ===== */
async function passLesson(s, uid, lid, lesson, lang) {
  const qb = lesson.blocks.find(b => b.type === "quiz");
  if (!qb) return (await s.L("POST", `/learn/lessons/${lid}/complete`, { uid, body: {} })).body;
  return (await s.L("POST", `/learn/lessons/${lid}/quiz`, { uid, body: { answers: qb.questions.map(q => q.correct), ...(lang ? { lang } : {}) } })).body;
}
test("прогресс: новый → частичный → завершён; урок завершается тестом; 29/29, 100%, 6/6 модулей, дата; повтор без дубликатов; язык не меняет числа", async () => {
  const s = setup(); const cid = await s.publishAll(COURSE); await s.student("stu", "71000201");
  const LS = COURSE.modules.flatMap(m => m.lessons);
  const sum = async lang => (await s.L("GET", `/learn/courses?lang=${lang || "ru"}`, { uid: "stu" })).body.courses[0];
  let c = await sum();
  assert.deepEqual([c.completed, c.lessons, c.percent, c.modules_completed, c.modules_total, c.course_completed], [0, 29, 0, 0, 6, false]);
  assert.equal(c.next.title, LS[0].title); assert.equal(c.tests.avg_best_percent, null);
  const ids = (await s.L("GET", `/learn/courses/${cid}`, { uid: "stu" })).body.course.modules.flatMap(m => m.lessons.map(l => l.id));
  // только тест, без кнопки «отметить» — урок завершён
  const r1 = await passLesson(s, "stu", ids[0], LS[0]);
  assert.equal(r1.passed, true); assert.equal(r1.course_completed, false);
  c = await sum(); assert.deepEqual([c.completed, c.percent], [1, 3]); assert.equal(c.next.title, LS[1].title);
  // проверка ответов на другом языке (review) не создаёт попытку
  const pdoc = async lid => (await s.db.collection("lesson_progress").doc(`stu__${lid}`).get()).data();
  const before = (await pdoc(ids[0])).quiz.attempts;
  await s.L("POST", `/learn/lessons/${ids[0]}/quiz`, { uid: "stu", body: { answers: LS[0].blocks.find(b => b.type === "quiz").questions.map(q => q.correct), lang: "en", review: true } });
  assert.equal((await pdoc(ids[0])).quiz.attempts, before);
  // модуль 1 (4 урока) → 1 модуль завершён
  for (let i = 1; i < 4; i++) await passLesson(s, "stu", ids[i], LS[i]);
  c = await sum(); assert.deepEqual([c.completed, c.modules_completed], [4, 1]); assert.equal(c.next.module_title, COURSE.modules[1].title);
  // открытие урока не сбрасывает результат
  await s.L("GET", `/learn/lessons/${ids[0]}`, { uid: "stu" }); assert.equal((await sum()).completed, 4);
  let last;
  for (let i = 4; i < 29; i++) last = await passLesson(s, "stu", ids[i], LS[i]);
  assert.equal(last.course_completed, true);                                         // сигнал для финального экрана — один раз
  c = await sum();
  assert.deepEqual([c.completed, c.lessons, c.percent, c.modules_completed, c.modules_total, c.course_completed, c.next], [29, 29, 100, 6, 6, true, null]);
  assert.ok(c.completed_at > 0); assert.equal(c.tests.avg_best_percent, 100); assert.equal(c.tests.passed, c.tests.total);
  // повторное прохождение теста: тот же документ, без дубликатов, курс уже завершён — сигнал не повторяется
  const again = await passLesson(s, "stu", ids[28], LS[28]);
  assert.equal(again.course_completed, false);
  assert.equal((await s.db.collection("lesson_progress").where("uid", "==", "stu").get()).size, 29);
  // язык не меняет числа; страница курса — тот же расчёт
  const en = await sum("en"), ua = await sum("ua");
  for (const x of [en, ua]) assert.deepEqual([x.completed, x.percent, x.modules_completed, x.course_completed], [29, 100, 6, true]);
  assert.deepEqual((await s.L("GET", `/learn/courses/${cid}?lang=ua`, { uid: "stu" })).body.summary.completed, 29);
  // рейтинг: один завершивший — данных недостаточно, процентов нет
  const rk = (await s.L("GET", `/learn/courses/${cid}/ranking`, { uid: "stu" })).body;
  assert.deepEqual([rk.available, rk.reason, rk.sample], [false, "NOT_ENOUGH_DATA", 1]);
});

test("рейтинг: при 20+ завершивших — процент тех, у кого средний результат тестов ниже; не завершившему — не показывается", async () => {
  const s = setup(); const cid = await s.publishAll(COURSE);
  const LS = COURSE.modules.flatMap(m => m.lessons);
  const ids = (await s.L("GET", `/learn/courses/${cid}`, { uid: "boss" })).body.course.modules.flatMap(m => m.lessons.map(l => l.id));
  // 20 завершивших с разными результатами — прямо в базе, в том же формате, что пишет сервер
  for (let u = 0; u < 20; u++) for (let i = 0; i < 29; i++)
    await s.db.collection("lesson_progress").doc(`u${u}__${ids[i]}`).set({ uid: "u" + u, course_id: cid, lesson_id: ids[i], completed: true, completed_at: 1000 + i, quiz: LS[i].blocks.some(b => b.type === "quiz") ? { best_percent: 60 + u, passed: true, attempts: 1 } : undefined });
  await s.student("u19", "71000300");
  const r = (await s.L("GET", `/learn/courses/${cid}/ranking`, { uid: "u19" })).body;
  assert.equal(r.available, true); assert.equal(r.better_than_percent, 100); assert.equal(r.sample, 20);
  await s.student("late", "71000301");
  assert.equal((await s.L("GET", `/learn/courses/${cid}/ranking`, { uid: "late" })).body.reason, "NOT_COMPLETED");
});

test("старые записи: тест пройден, но урок не отмечен (прежняя логика) — урок считается завершённым; данные в базе не меняются", async () => {
  const s = setup(); const cid = await s.publishAll(COURSE); await s.student("old", "71000401");
  const ids = (await s.L("GET", `/learn/courses/${cid}`, { uid: "old" })).body.course.modules.flatMap(m => m.lessons.map(l => l.id));
  for (let i = 0; i < 29; i++) await s.db.collection("lesson_progress").doc(`old__${ids[i]}`).set({ uid: "old", course_id: cid, lesson_id: ids[i], quiz: { attempts: 1, best_percent: 90, last_percent: 90, passed: true, at: 5000 + i } });
  const c = (await s.L("GET", "/learn/courses?lang=en", { uid: "old" })).body.courses[0];
  assert.deepEqual([c.completed, c.percent, c.modules_completed, c.course_completed, c.completed_at], [29, 100, 6, true, 5028]);
  assert.equal((await s.L("GET", `/learn/lessons/${ids[0]}`, { uid: "old" })).body.progress.completed, true);
  assert.equal((await s.db.collection("lesson_progress").doc(`old__${ids[0]}`).get()).data().completed, undefined);   // запись не переписана
  // тест не пройден — урок не завершён
  await s.student("fail", "71000402");
  await s.db.collection("lesson_progress").doc(`fail__${ids[0]}`).set({ uid: "fail", course_id: cid, lesson_id: ids[0], quiz: { attempts: 2, best_percent: 40, passed: false, at: 1 } });
  assert.equal((await s.L("GET", "/learn/courses", { uid: "fail" })).body.courses[0].completed, 0);
});
