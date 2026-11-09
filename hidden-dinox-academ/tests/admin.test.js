"use strict";
/* Тесты админ-панели, CMS, обучения и Telegram. node --test tests/admin.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify, fakeRes, fakeReq } = require("./helpers/http");
const { adminCaller, learnCaller } = require("./helpers/router");
const { createAdminApi } = require("../academy/admin-api");
const { createAcademyApi } = require("../academy/api");
const { createLearnApi } = require("../academy/learn-api");
const { createAcademyPostback } = require("../academy/postback");
const { memoryStorage } = require("../academy/storage");
const { verifyInitData } = require("../academy/telegram");

const quiet = { log() {}, warn() {}, error() {} };
const SECRET = "test-secret-0123456789abcdef-XYZ";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64)]);

function setup({ storage = memoryStorage(), clock } = {}) {
  const db = new FakeFirestore();
  let t = clock || 1_800_000_000_000; const now = () => t;
  const adminApi = createAdminApi({ db, verifyIdToken: fakeVerify, storage, log: quiet, now });
  const academyApi = createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet, now });
  const learnApi = createLearnApi({ db, academyApi, storage, log: quiet, now });
  const pb = createAcademyPostback({ db, env: { POCKET_POSTBACK_SECRET: SECRET }, log: quiet, now });
  const A = adminCaller(adminApi), L = learnCaller(learnApi);
  const user = (uid, role, extra = {}) => db.collection("users").doc(uid).set({ email: uid + "@test.local", role, created_at: t - 1000, ...extra }, { merge: true });
  async function giveAccess(uid, trader) {      // настоящий путь доступа: регистрация → привязка → FTD $60
    const r = fakeRes(); await academyApi.me(fakeReq({ token: "testtoken-" + uid }), r);
    await pb.handle({ type: "registration", trader_id: trader, secret: SECRET });
    const b = fakeRes(); await academyApi.traderId(fakeReq({ token: "testtoken-" + uid, body: { traderId: trader } }), b);
    await pb.handle({ type: "ftd", trader_id: trader, amount: "60", currency: "USD", secret: SECRET });
  }
  const advance = ms => { t += ms; };
  return { db, A, L, user, giveAccess, adminApi, academyApi, learnApi, advance, storage, now };
}
// Минимальный корректный курс через API
async function makeCourse(s, uid = "boss") {
  const c = (await s.A("POST", "/courses", { uid, body: { title: "Курс", level: "beginner" } })).body.id;
  const m = (await s.A("POST", `/courses/${c}/modules`, { uid, body: { title: "Модуль 1" } })).body.id;
  const l = (await s.A("POST", `/modules/${m}/lessons`, { uid, body: { title: "Урок 1" } })).body.id;
  await s.A("PUT", `/lessons/${l}`, { uid, body: { title: "Урок 1", status: "ready", pass_criteria: { require_quiz: true, min_percent: 50 }, blocks: [
    { type: "heading", text: "Заголовок" }, { type: "text", text: "Текст **жирный** <script>alert(1)</script>" },
    { type: "quiz", id: "q1", pass_percent: 50, questions: [{ q: "2+2?", options: ["3", "4"], correct: 1, explanation: "Так." }, { q: "Да?", options: ["да", "нет"], correct: 0 }] }] } });
  return { c, m, l };
}

/* ---------- Права и роли ---------- */
test("админ-API: без токена 401, ученик 403, mentor видит только разрешённое", async () => {
  const s = setup(); await s.user("stud", "student"); await s.user("ment", "mentor");
  assert.equal((await s.A("GET", "/me", {})).statusCode, 401);
  assert.equal((await s.A("GET", "/me", { uid: "stud" })).statusCode, 403);
  const me = await s.A("GET", "/me", { uid: "ment" });
  assert.equal(me.statusCode, 200); assert.equal(me.body.role, "mentor");
  assert.ok(me.body.permissions.includes("content.edit")); assert.ok(!me.body.permissions.includes("content.publish"));
  assert.equal((await s.A("GET", "/users", { uid: "ment" })).statusCode, 403);
  assert.equal((await s.A("GET", "/audit", { uid: "ment" })).statusCode, 403);
  const { c } = await makeCourse(s, "ment");
  assert.equal((await s.A("POST", `/courses/${c}/publish`, { uid: "ment", body: { confirm: true } })).statusCode, 403);
});

test("роли: назначить можно только роль ниже своей, себе — нельзя; клиент не может выдать себе роль", async () => {
  const s = setup(); await s.user("boss", "super_admin"); await s.user("adm", "admin"); await s.user("adm2", "admin"); await s.user("stud", "student");
  assert.equal((await s.A("POST", "/users/stud/role", { uid: "adm", body: { role: "mentor" } })).statusCode, 200);
  for (const role of ["admin", "super_admin"]) assert.equal((await s.A("POST", "/users/stud/role", { uid: "adm", body: { role } })).statusCode, 403, role);
  assert.equal((await s.A("POST", "/users/adm2/role", { uid: "adm", body: { role: "student" } })).statusCode, 403);   // равная роль
  assert.equal((await s.A("POST", "/users/adm/role", { uid: "adm", body: { role: "super_admin" } })).statusCode, 403); // себе
  assert.equal((await s.A("POST", "/users/stud/role", { uid: "adm", body: { role: "god" } })).statusCode, 403);
  assert.equal((await s.A("POST", "/users/adm2/role", { uid: "boss", body: { role: "moderator" } })).statusCode, 200);
  // Ученик не может стать админом через обычный API академии
  const r = fakeRes(); await s.academyApi.traderId(fakeReq({ token: "testtoken-stud", body: { traderId: "12345678", role: "super_admin" } }), r);
  assert.equal(s.db.dump("users").stud.role, "mentor");
  const log = s.db.dump("audit_logs"); assert.ok(Object.values(log).some(l => l.action === "user.role" && l.target_id === "stud" && l.details.to === "mentor"));
});

test("блокировка: заблокированный не получает данные академии и админки; равного по роли блокировать нельзя", async () => {
  const s = setup(); await s.user("adm", "admin"); await s.user("adm2", "admin"); await s.user("stud", "student"); await s.user("ment", "mentor");
  assert.equal((await s.A("POST", "/users/stud/block", { uid: "adm", body: { blocked: true, reason: "спам" } })).statusCode, 200);
  const r = fakeRes(); await s.academyApi.me(fakeReq({ token: "testtoken-stud" }), r);
  assert.deepEqual([r.statusCode, r.body.error], [403, "ACCOUNT_BLOCKED"]);
  assert.equal((await s.L("GET", "/learn/courses", { uid: "stud" })).statusCode, 403);
  assert.equal((await s.A("POST", "/users/adm2/block", { uid: "adm", body: { blocked: true, reason: "тест" } })).statusCode, 403);
  assert.equal((await s.A("POST", "/users/ment/block", { uid: "adm", body: { blocked: true, reason: "тест" } })).statusCode, 200);
  assert.equal((await s.A("GET", "/me", { uid: "ment" })).statusCode, 403);
  assert.equal((await s.A("POST", "/users/stud/block", { uid: "adm", body: { blocked: false } })).statusCode, 200);
  const r2 = fakeRes(); await s.academyApi.me(fakeReq({ token: "testtoken-stud" }), r2); assert.equal(r2.statusCode, 200);
});

/* ---------- CMS ---------- */
test("CMS: курс, модуль, урок; неверный блок → 400 с полем; удалённые блоки не возвращаются", async () => {
  const s = setup(); await s.user("boss", "super_admin");
  const { c, l } = await makeCourse(s);
  const bad = await s.A("PUT", `/lessons/${l}`, { uid: "boss", body: { title: "x", blocks: [{ type: "quiz", questions: [{ q: "?", options: ["a"], correct: 0 }] }] } });
  assert.equal(bad.statusCode, 400); assert.match(bad.body.field, /blocks\[0\]/);
  const bad2 = await s.A("PUT", `/lessons/${l}`, { uid: "boss", body: { title: "x", blocks: [{ type: "video", url: "javascript:alert(1)" }] } });
  assert.equal(bad2.statusCode, 400);
  await s.A("PUT", `/lessons/${l}`, { uid: "boss", body: { title: "Урок 1", blocks: [{ type: "heading", text: "Только он" }] } });
  assert.equal((await s.A("GET", `/lessons/${l}`, { uid: "boss" })).body.lesson.blocks.length, 1);
  const full = (await s.A("GET", `/courses/${c}`, { uid: "boss" })).body;
  assert.equal(full.modules.length, 1); assert.equal(full.modules[0].lessons.length, 1);
});

test("CMS: порядок модулей и уроков; перенос урока в другой модуль; чужие ID отклоняются", async () => {
  const s = setup(); await s.user("boss", "super_admin");
  const { c, m, l } = await makeCourse(s);
  const m2 = (await s.A("POST", `/courses/${c}/modules`, { uid: "boss", body: { title: "Модуль 2" } })).body.id;
  assert.equal((await s.A("POST", `/courses/${c}/reorder`, { uid: "boss", body: { modules: [m2, m], lessons: { [m2]: [l], [m]: [] } } })).statusCode, 200);
  const full = (await s.A("GET", `/courses/${c}`, { uid: "boss" })).body;
  assert.deepEqual(full.modules.map(x => x.title), ["Модуль 2", "Модуль 1"]);
  assert.equal(full.modules[0].lessons[0].id, l);
  assert.equal((await s.A("POST", `/courses/${c}/reorder`, { uid: "boss", body: { modules: ["mod_alien000000"] } })).statusCode, 400);
});

test("публикация: только с подтверждением, только уроки «Готов»; черновые правки не видны ученикам до повторной публикации", async () => {
  const s = setup(); await s.user("boss", "super_admin");
  const { c, m, l } = await makeCourse(s);
  const l2 = (await s.A("POST", `/modules/${m}/lessons`, { uid: "boss", body: { title: "Черновой урок" } })).body.id;
  assert.equal((await s.A("POST", `/courses/${c}/publish`, { uid: "boss", body: {} })).statusCode, 400);
  assert.equal((await s.A("POST", `/courses/${c}/publish`, { uid: "boss", body: { confirm: true } })).statusCode, 200);
  assert.ok(s.db.dump("published_lessons")[l]); assert.equal(s.db.dump("published_lessons")[l2], undefined);
  await s.giveAccess("stud", "50000001");
  const course = (await s.L("GET", `/learn/courses/${c}`, { uid: "stud" })).body.course;
  assert.equal(course.total, 1);
  s.advance(60000);                                                                     // правка через минуту после публикации
  await s.A("PUT", `/lessons/${l}`, { uid: "boss", body: { title: "Изменённый", status: "ready", blocks: [{ type: "heading", text: "Новое" }] } });
  assert.equal((await s.L("GET", `/learn/lessons/${l}`, { uid: "stud" })).body.lesson.title, "Урок 1");      // ещё старая версия
  assert.equal((await s.A("GET", `/courses/${c}`, { uid: "boss" })).body.has_unpublished_changes, true);
  s.advance(1000);
  await s.A("POST", `/courses/${c}/publish`, { uid: "boss", body: { confirm: true } });
  assert.equal((await s.L("GET", `/learn/lessons/${l}`, { uid: "stud" })).body.lesson.title, "Изменённый");
  await s.A("POST", `/courses/${c}/unpublish`, { uid: "boss", body: { confirm: true } });
  assert.equal((await s.L("GET", `/learn/courses`, { uid: "stud" })).body.courses.length, 0);
  assert.equal((await s.L("GET", `/learn/lessons/${l}`, { uid: "stud" })).statusCode, 404);
});

test("публикация без готовых уроков → 409; удаление опубликованного курса запрещено", async () => {
  const s = setup(); await s.user("boss", "super_admin");
  const c = (await s.A("POST", "/courses", { uid: "boss", body: { title: "Пустой" } })).body.id;
  assert.equal((await s.A("POST", `/courses/${c}/publish`, { uid: "boss", body: { confirm: true } })).statusCode, 409);
  const k = await makeCourse(s);
  await s.A("POST", `/courses/${k.c}/publish`, { uid: "boss", body: { confirm: true } });
  assert.equal((await s.A("POST", `/courses/${k.c}/delete`, { uid: "boss", body: { confirm: true } })).statusCode, 409);
});

test("отложенная публикация: до даты ученик не видит курс, сотрудник видит", async () => {
  const s = setup(); await s.user("boss", "super_admin"); await s.user("team", "team_member");
  const { c, l } = await makeCourse(s);
  const when = new Date(s.now() + 3 * 86400000).toISOString();
  await s.A("POST", `/courses/${c}/publish`, { uid: "boss", body: { confirm: true, visible_from: when } });
  await s.giveAccess("stud", "50000002");
  assert.equal((await s.L("GET", "/learn/courses", { uid: "stud" })).body.courses.length, 0);
  assert.equal((await s.L("GET", "/learn/courses", { uid: "team" })).body.courses.length, 1);
  // Не только просмотр, но и тест/завершение должны уважать отложенную публикацию.
  assert.equal((await s.L("POST", `/learn/lessons/${l}/quiz`, { uid: "stud", body: { answers: [1, 0] } })).statusCode, 404);
  assert.equal((await s.L("POST", `/learn/lessons/${l}/complete`, { uid: "stud" })).statusCode, 404);
  s.advance(3 * 86400000 + 1);
  assert.equal((await s.L("GET", "/learn/courses", { uid: "stud" })).body.courses.length, 1);
});

/* ---------- Обучение ---------- */
test("обучение: без открытой академии — 403; ответы тестов скрыты; проверка на сервере; завершение требует теста", async () => {
  const s = setup(); await s.user("boss", "super_admin");
  const { c, l } = await makeCourse(s);
  await s.A("POST", `/courses/${c}/publish`, { uid: "boss", body: { confirm: true } });
  const r0 = fakeRes(); await s.academyApi.me(fakeReq({ token: "testtoken-noaccess" }), r0);
  assert.equal((await s.L("GET", "/learn/courses", { uid: "noaccess" })).statusCode, 403);
  await s.giveAccess("stud", "50000003");
  const les = (await s.L("GET", `/learn/lessons/${l}`, { uid: "stud" })).body.lesson;
  const quiz = les.blocks.find(b => b.type === "quiz");
  assert.equal(JSON.stringify(quiz).includes("correct"), false); assert.equal(JSON.stringify(quiz).includes("Так."), false);
  assert.equal((await s.L("POST", `/learn/lessons/${l}/complete`, { uid: "stud" })).statusCode, 409);
  const bad = await s.L("POST", `/learn/lessons/${l}/quiz`, { uid: "stud", body: { answers: [0, 1] } });
  assert.deepEqual([bad.body.percent, bad.body.passed], [0, false]);
  const good = await s.L("POST", `/learn/lessons/${l}/quiz`, { uid: "stud", body: { answers: [1, 0] } });
  assert.deepEqual([good.body.percent, good.body.passed, good.body.results[0].explanation], [100, true, "Так."]);
  assert.equal((await s.L("POST", `/learn/lessons/${l}/complete`, { uid: "stud" })).statusCode, 200);
  const course = (await s.L("GET", `/learn/courses/${c}`, { uid: "stud" })).body.course;
  assert.deepEqual([course.completed, course.percent], [1, 100]);
  assert.equal(s.db.dump("lesson_progress")[`stud__${l}`].quiz.attempts, 2);
});

/* ---------- Медиа ---------- */
test("медиа: принимаются только разрешённые форматы с верной сигнатурой; SVG/HTML отклоняются; размер ограничен", async () => {
  const s = setup(); await s.user("boss", "super_admin");
  const up = (ct, body) => s.A("POST", "/media", { uid: "boss", body, headers: { "content-type": ct, "x-file-name": encodeURIComponent("схема.png") } });
  assert.equal((await up("image/svg+xml", Buffer.from("<svg onload=alert(1)>"))).body.error, "UNSUPPORTED_TYPE");
  assert.equal((await up("text/html", Buffer.from("<html>"))).body.error, "UNSUPPORTED_TYPE");
  assert.equal((await up("image/png", Buffer.from("<html>not png"))).body.error, "BAD_SIGNATURE");
  assert.equal((await up("image/png", Buffer.concat([PNG, Buffer.alloc(9 << 20)]))).body.error, "TOO_LARGE");
  const ok = await up("image/png", PNG);
  assert.equal(ok.statusCode, 200); assert.match(ok.body.url, /^\/media\/med_[a-f0-9]{20}$/);
  const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; }, end() { return this; } };
  await s.learnApi.media({ params: { id: ok.body.id } }, res);
  assert.equal(res.code, 200); assert.equal(res.headers["Content-Type"], "image/png"); assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
});

test("медиа: удаление используемого файла запрещено (409 со списком); после освобождения — удаляется", async () => {
  const s = setup(); await s.user("boss", "super_admin");
  const id = (await s.A("POST", "/media", { uid: "boss", body: PNG, headers: { "content-type": "image/png" } })).body.id;
  const c = (await s.A("POST", "/courses", { uid: "boss", body: { title: "С обложкой", cover_media_id: id } })).body.id;
  const r = await s.A("POST", `/media/${id}/delete`, { uid: "boss" });
  assert.equal(r.statusCode, 409); assert.equal(r.body.used[0].id, c);
  await s.A("PUT", `/courses/${c}`, { uid: "boss", body: { title: "Без обложки" } });
  assert.equal((await s.A("POST", `/media/${id}/delete`, { uid: "boss" })).statusCode, 200);
  assert.equal(s.storage.files.size, 0);
});

test("медиа: без настроенного хранилища загрузка — 503 с понятным сообщением", async () => {
  const s = setup({ storage: null }); await s.user("boss", "super_admin");
  const r = await s.A("POST", "/media", { uid: "boss", body: PNG, headers: { "content-type": "image/png" } });
  assert.deepEqual([r.statusCode, r.body.error], [503, "STORAGE_UNAVAILABLE"]);
});

/* ---------- Афиши ---------- */
test("афиши: модератор создаёт черновик, публикует только админ с подтверждением; показ по аудитории и датам", async () => {
  const s = setup(); await s.user("mod", "moderator"); await s.user("boss", "super_admin");
  const draft = await s.A("POST", "/announcements", { uid: "mod", body: { title: "Эфир", status: "draft", audience: "access" } });
  assert.equal(draft.statusCode, 200);
  assert.equal((await s.A("PUT", `/announcements/${draft.body.id}`, { uid: "mod", body: { title: "Эфир", status: "published" } })).statusCode, 403);
  // Модератор не может опубликовать афишу и сразу при создании — даже с подтверждением
  const direct = await s.A("POST", "/announcements", { uid: "mod", body: { title: "Сразу в эфир", status: "published", confirm: true } });
  assert.equal(direct.statusCode, 403);
  assert.equal((await s.A("GET", "/announcements", { uid: "boss" })).body.announcements.some(a => a.title === "Сразу в эфир"), false);
  assert.equal((await s.A("PUT", `/announcements/${draft.body.id}`, { uid: "boss", body: { title: "Эфир", status: "published", audience: "access" } })).statusCode, 400);
  assert.equal((await s.A("PUT", `/announcements/${draft.body.id}`, { uid: "boss", body: { title: "Эфир", status: "published", audience: "access", confirm: true } })).statusCode, 200);
  const future = new Date(s.now() + 86400000).toISOString();
  await s.A("POST", "/announcements", { uid: "boss", body: { title: "Позже", status: "published", show_from: future, confirm: true } });
  await s.A("POST", "/announcements", { uid: "boss", body: { title: "Для новичков", status: "published", audience: "no_access", confirm: true } });
  await s.A("POST", "/announcements", { uid: "boss", body: { title: "Архив", status: "archived" } });
  await s.giveAccess("stud", "50000004");
  assert.deepEqual((await s.L("GET", "/announcements", { uid: "stud" })).body.announcements.map(a => a.title), ["Эфир"]);
  const r0 = fakeRes(); await s.academyApi.me(fakeReq({ token: "testtoken-newbie" }), r0);
  assert.deepEqual((await s.L("GET", "/announcements", { uid: "newbie" })).body.announcements.map(a => a.title), ["Для новичков"]);
  assert.equal((await s.A("POST", "/announcements", { uid: "boss", body: { title: "x", cta_url: "http://insecure.example" } })).statusCode, 400);
});

/* ---------- Dashboard ---------- */
test("dashboard: только реальные данные — пользователи, активации, контент, прогресс", async () => {
  const s = setup(); await s.user("boss", "super_admin");
  await s.giveAccess("stud", "50000005");
  const r0 = fakeRes(); await s.academyApi.me(fakeReq({ token: "testtoken-waiting" }), r0);
  await s.academyApi.click(fakeReq({ token: "testtoken-waiting" }), fakeRes());
  const { c, l } = await makeCourse(s);
  await s.A("POST", `/courses/${c}/publish`, { uid: "boss", body: { confirm: true } });
  await s.L("POST", `/learn/lessons/${l}/quiz`, { uid: "stud", body: { answers: [1, 0] } });
  await s.L("POST", `/learn/lessons/${l}/complete`, { uid: "stud" });
  const d = (await s.A("GET", "/dashboard", { uid: "boss" })).body;
  assert.equal(d.users.total, 3);
  assert.deepEqual(d.academy, { activated: 1, trader_bound: 1, ftd_confirmed: 1, awaiting_deposit: 0 });
  assert.deepEqual([d.content.courses, d.content.courses_published, d.content.lessons], [1, 1, 1]);
  assert.deepEqual([d.learning.lessons_completed, d.learning.learners], [1, 1]);
  assert.equal(d.charts.registrations.length, 30);
});

/* ---------- Импорт и аудит ---------- */
test("импорт курса: только с подтверждением, всё как черновик, без публикации; журнал действий", async () => {
  const s = setup(); await s.user("boss", "super_admin"); await s.user("ment", "mentor");
  const data = { course: { title: "Импорт" }, modules: [{ title: "М1", lessons: [{ title: "У1", status: "ready", blocks: [{ type: "heading", text: "Привет" }] }] }] };
  assert.equal((await s.A("POST", "/import/course", { uid: "ment", body: { confirm: true, data } })).statusCode, 403);
  assert.equal((await s.A("POST", "/import/course", { uid: "boss", body: { data } })).statusCode, 400);
  const r = await s.A("POST", "/import/course", { uid: "boss", body: { confirm: true, data } });
  assert.deepEqual([r.statusCode, r.body.lessons], [200, 1]);
  assert.equal(Object.values(s.db.dump("course_lessons"))[0].status, "draft");          // «ready» из файла не принимается
  assert.equal(Object.keys(s.db.dump("published_courses")).length, 0);
  const logs = (await s.A("GET", "/audit", { uid: "boss" })).body.logs.map(l => l.action);
  assert.ok(logs.includes("course.import"));
});

test("журнал: каждое изменение пользователя и контента записывается с автором", async () => {
  const s = setup(); await s.user("boss", "super_admin"); await s.user("stud", "student");
  await makeCourse(s);
  await s.A("POST", "/users/stud/role", { uid: "boss", body: { role: "streamer" } });
  await s.A("POST", "/users/stud/block", { uid: "boss", body: { blocked: true, reason: "тест" } });
  const acts = Object.values(s.db.dump("audit_logs")).map(l => [l.action, l.actor_uid]);
  for (const a of ["course.create", "module.create", "lesson.create", "lesson.update", "user.role", "user.block"]) assert.ok(acts.some(x => x[0] === a && x[1] === "boss"), a);
});

/* ---------- Telegram ---------- */
function signInit(fields, token) {
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort();
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
test("Telegram: подпись initData проверяется по официальному алгоритму; подделка и устаревшие данные отклоняются", () => {
  const token = "123456:TEST_TOKEN_ONLY", nowMs = 1_800_000_000_000;
  const user = JSON.stringify({ id: 777, first_name: "Иван", username: "ivan", photo_url: "https://t.me/i/userpic/1.jpg" });
  const good = signInit({ auth_date: String(Math.floor(nowMs / 1000) - 60), query_id: "AAA", user }, token);
  const v = verifyInitData(good, token, { now: () => nowMs });
  assert.equal(v.ok, true); assert.deepEqual([v.user.id, v.user.username, v.user.name], [777, "ivan", "Иван"]);
  assert.equal(verifyInitData(good.replace("ivan", "evil"), token, { now: () => nowMs }).error, "BAD_SIGNATURE");
  assert.equal(verifyInitData(good, "999:OTHER", { now: () => nowMs }).error, "BAD_SIGNATURE");
  assert.equal(verifyInitData(good, token, { now: () => nowMs + 2 * 86400000 }).error, "EXPIRED");
  assert.equal(verifyInitData(good, "", {}).error, "NOT_CONFIGURED");
  assert.equal(verifyInitData("user=%7B%7D", token, {}).error, "INVALID");
});

/* ===== Регрессия: «3 INVALID_ARGUMENT: Property array contains an invalid nested entity» =====
   Тестовая база воспроизводит ограничение настоящего Firestore: массив внутри массива запрещён. */
const COURSE = require("../content/hidden-reaction-course.json");
const nestedArrayPaths = v => { const out = []; (function walk(x, p, inArr) { if (Array.isArray(x)) { if (inArr) out.push(p); x.forEach((y, i) => walk(y, p + "[" + i + "]", true)); } else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) walk(y, p + "." + k, false); })(v, "", false); return out; };

test("тестовая база отклоняет массив внутри массива, как настоящий Firestore", async () => {
  const s = setup();
  await assert.rejects(s.db.collection("x").doc("y").set({ a: [[1, 2]] }), /invalid nested entity/);
  await s.db.collection("x").doc("z").set({ a: [{ o: 1 }] });   // массив объектов допустим
});

test("импорт курса по книге: сохраняется в Firestore без вложенных массивов, уроки внутри модулей", async () => {
  const s = setup(); await s.user("boss", "super_admin");
  const r = await s.A("POST", "/import/course", { uid: "boss", body: { confirm: true, data: COURSE } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.modules, r.body.lessons], [6, 29]);
  const lessons = (await s.db.collection("course_lessons").get()).docs.map(d => d.data());
  assert.equal(lessons.length, 29);
  for (const l of lessons) assert.deepEqual(nestedArrayPaths(l), [], l.title);
  const chart = lessons.flatMap(l => l.blocks).find(b => b.type === "chart").chart;
  assert.deepEqual(Object.keys(chart.candles[0]).sort(), ["c", "h", "l", "o"]);
  const tree = await s.A("GET", "/courses/" + r.body.course_id, { uid: "boss" });
  assert.deepEqual(tree.body.modules.map(m => m.lessons.length), [4, 6, 7, 5, 3, 4]);       // ни одного пустого модуля
  assert.ok(tree.body.modules.every(m => m.lessons.every(l => l.status === "draft")));
});

test("повторный импорт того же курса не создаёт дубликат (409 со ссылкой на черновик)", async () => {
  const s = setup(); await s.user("boss", "super_admin");
  const first = await s.A("POST", "/import/course", { uid: "boss", body: { confirm: true, data: COURSE } });
  const again = await s.A("POST", "/import/course", { uid: "boss", body: { confirm: true, data: COURSE } });
  assert.equal(again.statusCode, 409); assert.equal(again.body.error, "ALREADY_IMPORTED"); assert.equal(again.body.course_id, first.body.course_id);
  assert.equal((await s.db.collection("courses").get()).size, 1);
  assert.equal((await s.db.collection("course_lessons").get()).size, 29);
});

test("урок с графиком: сохранение, повторное открытие и повторное сохранение без потерь", async () => {
  const s = setup(); await s.user("boss", "super_admin");
  const { l } = await makeCourse(s);
  const chart = { title: "Учебная схема", caption: "синтетика", candles: [[10, 12, 9, 11.5], [11.5, 13, 11, 12.6], [12.6, 13.2, 11.8, 12]], annotations: [{ type: "marker", at: 1, text: "Замедление" }] };
  const put = await s.A("PUT", "/lessons/" + l, { uid: "boss", body: { title: "Урок с графиком", status: "ready", blocks: [{ type: "text", text: "Строка 1\n- пункт" }, { type: "chart", chart }] } });
  assert.equal(put.statusCode, 200, JSON.stringify(put.body));
  const got = (await s.A("GET", "/lessons/" + l, { uid: "boss" })).body.lesson;
  assert.deepEqual(got.blocks[1].chart.candles, chart.candles);                           // API: исходная структура [o, h, l, c]
  const stored = (await s.db.collection("course_lessons").doc(l).get()).data();
  assert.deepEqual(stored.blocks[1].chart.candles[0], { o: 10, h: 12, l: 9, c: 11.5 });    // Firestore: объекты
  assert.deepEqual(nestedArrayPaths(stored), []);
  assert.equal(got.blocks[0].text, "Строка 1\n- пункт");
  const again = await s.A("PUT", "/lessons/" + l, { uid: "boss", body: { title: got.title, status: got.status, blocks: got.blocks } });   // как редактор после перезагрузки
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  assert.deepEqual((await s.A("GET", "/lessons/" + l, { uid: "boss" })).body.lesson.blocks, got.blocks);
});

test("курс по книге глазами ученика: импорт → публикация готовых уроков → ученик видит урок с графиком и без ответов", async () => {
  const s = setup(); await s.user("boss", "super_admin");
  const imp = await s.A("POST", "/import/course", { uid: "boss", body: { confirm: true, data: COURSE } });
  const tree = (await s.A("GET", "/courses/" + imp.body.course_id, { uid: "boss" })).body;
  const first = tree.modules[1].lessons[0];                                          // «Замедление» — урок с графиком
  const full = (await s.A("GET", "/lessons/" + first.id, { uid: "boss" })).body.lesson;
  assert.equal((await s.A("PUT", "/lessons/" + first.id, { uid: "boss", body: { ...full, status: "ready" } })).statusCode, 200);
  assert.equal((await s.A("POST", `/courses/${imp.body.course_id}/publish`, { uid: "boss", body: { confirm: true } })).statusCode, 200);
  await s.giveAccess("stud", "50000077");
  const list = await s.L("GET", "/learn/courses", { uid: "stud" });
  assert.equal(list.body.courses.length, 1);
  const lesson = await s.L("GET", "/learn/lessons/" + first.id, { uid: "stud" });
  assert.equal(lesson.statusCode, 200);
  const blocks = lesson.body.lesson.blocks;
  assert.ok(blocks.some(b => b.type === "chart" && b.chart.candles.length > 3));
  const src = COURSE.modules[1].lessons[0].blocks.find(b => b.type === "chart").chart.candles;
  assert.deepEqual(blocks.find(b => b.type === "chart").chart.candles, src);              // ученик получает свечи точно как в JSON курса
  assert.equal(JSON.stringify(blocks).includes('"correct"'), false);
  global.window = {}; require("../public/academy/js/lesson-render.js");
  const svg = global.window.HDLesson.chartSVG(blocks.find(b => b.type === "chart").chart);
  assert.match(svg, /<svg/); assert.ok((svg.match(/<rect/g) || []).length >= 4);
  const draft = tree.modules[0].lessons[0];                                          // не готов — не опубликован
  assert.equal((await s.L("GET", "/learn/lessons/" + draft.id, { uid: "stud" })).statusCode, 404);
});

test("безопасность: КАЖДЫЙ маршрут админ-API — без входа 401, ученику 403, заблокированному админу 403", async () => {
  const s = setup(); await s.user("stud", "student"); await s.user("blk", "super_admin", { blocked: true });
  const { ROUTES } = s.adminApi;
  assert.ok(ROUTES.length > 20);
  for (const [method, path] of ROUTES) {
    const p = path.replace(/:[a-z_]+/g, "x_1");
    assert.equal((await s.A(method, p, { body: {} })).statusCode, 401, method + " " + path);
    assert.equal((await s.A(method, p, { uid: "stud", body: {} })).statusCode, 403, method + " " + path);
    assert.equal((await s.A(method, p, { uid: "blk", body: {} })).statusCode, 403, method + " " + path);
  }
});

test("импорт без потерь: каждый урок — те же блоки, вопросы, правильные ответы и свечи графиков, что в JSON", async () => {
  const s = setup(); await s.user("boss", "super_admin");
  const imp = await s.A("POST", "/import/course", { uid: "boss", body: { confirm: true, data: COURSE } });
  const tree = (await s.A("GET", "/courses/" + imp.body.course_id, { uid: "boss" })).body;
  assert.deepEqual(tree.modules.map(m => m.title), COURSE.modules.map(m => m.title));
  let charts = 0, questions = 0;
  for (const [mi, m] of COURSE.modules.entries()) {
    assert.deepEqual(tree.modules[mi].lessons.map(l => l.title), m.lessons.map(l => l.title), "модуль " + (mi + 1));
    for (const [li, src] of m.lessons.entries()) {
      const got = (await s.A("GET", "/lessons/" + tree.modules[mi].lessons[li].id, { uid: "boss" })).body.lesson;
      assert.deepEqual(got.blocks.map(b => b.type), src.blocks.map(b => b.type), src.title);
      src.blocks.forEach((b, bi) => {
        const g = got.blocks[bi];
        if (b.chart) { assert.deepEqual(g.chart.candles, b.chart.candles, src.title + ": свечи"); assert.equal(g.chart.annotations.length, (b.chart.annotations || []).length); charts++; }
        if (b.type === "quiz") { assert.deepEqual(g.questions.map(q => [q.q, q.options, q.correct]), b.questions.map(q => [q.q, q.options, q.correct]), src.title + ": тест"); questions += b.questions.length; }
      });
    }
  }
  assert.equal(questions, 96); assert.ok(charts >= 22, "графиков: " + charts);
});

test("диагностика: только Super Admin; показывает версию кода и фактические модули/уроки", async () => {
  const s = setup(); await s.user("boss", "super_admin"); await s.user("adm", "admin");
  assert.equal((await s.A("GET", "/diagnostics", { uid: "adm" })).statusCode, 403);
  const before = process.env.RENDER_GIT_COMMIT; process.env.RENDER_GIT_COMMIT = "abc123def4567890";
  try {
    const imp = await s.A("POST", "/import/course", { uid: "boss", body: { confirm: true, data: COURSE } });
    await s.db.collection("course_modules").doc("mod_empty_x").set({ course_id: imp.body.course_id, title: "Пустой модуль", order: 999 });   // как «пустой модуль» на Render
    const w = s.db.writes, d = await s.A("GET", "/diagnostics", { uid: "boss" });
    assert.equal(s.db.writes, w);                                                         // только чтение
    assert.equal(d.statusCode, 200);
    assert.equal(d.body.version.commit, "abc123def4567890"); assert.equal(d.body.version.content_format, "candles-objects-v1");
    const c = d.body.courses[0];
    assert.deepEqual(c.modules.map(m => m.lessons), [4, 6, 7, 5, 3, 4, 0]);
    assert.equal(c.lessons_total, 29); assert.equal(c.orphan_lessons, 0);
  } finally { if (before === undefined) delete process.env.RENDER_GIT_COMMIT; else process.env.RENDER_GIT_COMMIT = before; }
});

test("«все уроки готовы»: только с подтверждением и правом публикации; не публикует; пустые уроки блокируют", async () => {
  const s = setup(); await s.user("boss", "super_admin"); await s.user("ment", "mentor");
  const imp = await s.A("POST", "/import/course", { uid: "boss", body: { confirm: true, data: COURSE } });
  const cid = imp.body.course_id;
  assert.equal((await s.A("POST", `/courses/${cid}/ready-all`, { uid: "ment", body: { confirm: true } })).statusCode, 403);
  assert.equal((await s.A("POST", `/courses/${cid}/ready-all`, { uid: "boss", body: {} })).statusCode, 400);
  const r = await s.A("POST", `/courses/${cid}/ready-all`, { uid: "boss", body: { confirm: true } });
  assert.deepEqual([r.statusCode, r.body.marked, r.body.total], [200, 29, 29]);
  assert.equal((await s.db.collection("published_lessons").get()).size, 0);                 // ничего не опубликовано
  const p = await s.A("POST", `/courses/${cid}/publish`, { uid: "boss", body: { confirm: true } });
  assert.equal(p.statusCode, 200); assert.equal((await s.db.collection("published_lessons").get()).size, 29);
  const m = (await s.A("GET", "/courses/" + cid, { uid: "boss" })).body.modules[0].id;
  await s.A("POST", `/modules/${m}/lessons`, { uid: "boss", body: { title: "Пустой", blocks: [] } });
  assert.equal((await s.A("POST", `/courses/${cid}/ready-all`, { uid: "boss", body: { confirm: true } })).statusCode, 409);
});

/* ===== ТЗ этапы 1–3: афиши не пропадают, порядок карусели, понятные ошибки Storage ===== */
test("афиши: несколько подряд — все сохраняются с разными ID; правка одной не трогает другие; стандартные создаются один раз", async () => {
  const s = setup(); await s.user("boss", "super_admin");
  const ids = [];
  for (let i = 1; i <= 4; i++) ids.push((await s.A("POST", "/announcements", { uid: "boss", body: { title: "Афиша " + i, kind: i % 2 ? "banner" : "poster", action_type: "internal", action_target: "learn", order: 10 * i } })).body.id);
  assert.equal(new Set(ids).size, 4);
  const l1 = (await s.A("GET", "/announcements", { uid: "boss" })).body.announcements, l2 = (await s.A("GET", "/announcements", { uid: "boss" })).body.announcements;
  assert.equal(l1.length, 7); assert.equal(l2.length, 7);                                     // 4 своих + 3 стандартных, повторный запрос не дублирует
  assert.deepEqual(l1.filter(a => a.system).map(a => a.id).sort(), ["sys_book", "sys_invite", "sys_story"]);
  await s.A("PUT", "/announcements/" + ids[1], { uid: "boss", body: { title: "Афиша 2 — изменена", kind: "poster" } });
  const l3 = (await s.A("GET", "/announcements", { uid: "boss" })).body.announcements;
  assert.deepEqual(ids.map(id => l3.find(a => a.id === id).title), ["Афиша 1", "Афиша 2 — изменена", "Афиша 3", "Афиша 4"]);
  assert.equal((await s.db.collection("audit_logs").get()).docs.filter(d => d.data().action === "announcement.seed_system").length, 3);
});

test("карусель: стандартные карточки не исчезают после создания новых; INVITE & EARN первая, книга вторая; черновики и архив скрыты", async () => {
  const s = setup(); await s.user("boss", "super_admin"); await s.giveAccess("stud", "50000099");
  const before = (await s.L("GET", "/home/banners", { uid: "stud" })).body.banners.map(b => b.id);
  assert.deepEqual(before, ["sys_invite", "sys_book", "sys_story"]);
  const mk = async (title, order, status) => (await s.A("POST", "/announcements", { uid: "boss", body: { title, kind: "banner", action_type: "internal", action_target: "learn", order, status, confirm: true } })).body.id;
  const b2 = await mk("Второй", 20, "published"), b1 = await mk("Первый", 10, "published"); await mk("Черновик", 5, "draft");
  const arch = await mk("Архивный", 1, "published");
  await s.A("PUT", "/announcements/" + arch, { uid: "boss", body: { title: "Архивный", kind: "banner", action_type: "internal", action_target: "learn", status: "archived" } });
  const r1 = (await s.L("GET", "/home/banners", { uid: "stud" })).body.banners.map(b => b.id), r2 = (await s.L("GET", "/home/banners", { uid: "stud" })).body.banners.map(b => b.id);
  assert.deepEqual(r1, ["sys_invite", "sys_book", "sys_story", b1, b2]); assert.deepEqual(r2, r1);
  await s.A("GET", "/announcements", { uid: "boss" });                                                   // стандартные стали записями CMS
  assert.deepEqual((await s.L("GET", "/home/banners", { uid: "stud" })).body.banners.map(b => b.id), ["sys_invite", "sys_book", "sys_story", b1, b2]);
  await s.A("PUT", "/announcements/sys_book", { uid: "boss", body: { title: "THE HIDDEN REACTION SYSTEM", kind: "banner", action_type: "reader", action_target: "hidden-reaction-system", image_builtin: "book-reading", status: "archived" } });
  assert.deepEqual((await s.L("GET", "/home/banners", { uid: "stud" })).body.banners.map(b => b.id), ["sys_invite", "sys_story", b1, b2]);   // администратор управляет стандартной карточкой
  const posters = (await s.L("GET", "/announcements", { uid: "stud" })).body.announcements;
  assert.equal(posters.some(a => [b1, b2].includes(a.id)), false);                                     // баннеры не попадают в ленту афиш
});

function failingStorage(code, message) {
  return { available: true, bucketName: "ai-boost-10540.firebasestorage.app", files: new Map(),
    async check() { const { describeStorageError } = require("../academy/storage"); return { ok: false, bucket: this.bucketName, ...describeStorageError(Object.assign(new Error(message), { code }), this.bucketName) }; },
    async save() { throw Object.assign(new Error(message), { code }); }, async read() { throw Object.assign(new Error(message), { code }); }, async remove() {} };
}
test("Storage: нет бакета или прав — понятная причина (а не общая «временная ошибка»), запись в медиатеке не создаётся", async () => {
  for (const [code, msg, want] of [[404, "The specified bucket does not exist.", "BUCKET_NOT_FOUND"], [403, "caller does not have storage.objects.create access", "NO_PERMISSION"]]) {
    const s = setup({ storage: failingStorage(code, msg) }); await s.user("boss", "super_admin");
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(40)]);
    const r = await s.A("POST", "/media", { uid: "boss", body: png, headers: { "content-type": "image/png", "x-file-name": "a.png" } });
    assert.equal(r.statusCode, 503); assert.equal(r.body.error, "STORAGE_ERROR"); assert.equal(r.body.storage_code, want); assert.ok(r.body.message.length > 20);
    assert.equal((await s.db.collection("media").get()).size, 0);
    const d = await s.A("GET", "/diagnostics", { uid: "boss" });
    assert.equal(d.body.storage.ok, false); assert.equal(d.body.storage.code, want);
  }
  const ok = setup(); await ok.user("boss", "super_admin");
  assert.equal((await ok.A("GET", "/diagnostics", { uid: "boss" })).body.storage.ok, true);
});

test("карусель: даже с порядком 0 и высоким приоритетом чужая карточка идёт после INVITE & EARN и книги", async () => {
  const s = setup(); await s.user("boss", "super_admin"); await s.giveAccess("stud", "50000098");
  const id = (await s.A("POST", "/announcements", { uid: "boss", body: { title: "Важная", kind: "banner", action_type: "internal", action_target: "learn", order: 0, priority: 100, status: "published", confirm: true } })).body.id;
  assert.deepEqual((await s.L("GET", "/home/banners", { uid: "stud" })).body.banners.map(b => b.id), ["sys_invite", "sys_book", "sys_story", id]);
});

test("стандартные карточки: тексты по языку, честная сумма $10; старые записи обновляются, отредактированные — нет", async () => {
  const s = setup(); await s.user("boss", "super_admin"); await s.giveAccess("stud", "50000097");
  // запись, созданная прежней версией (старые тексты и картинка с +$100)
  await s.db.collection("announcements").doc("sys_invite").set({ kind: "banner", status: "published", audience: "all", title: "INVITE & EARN", title_i18n: { ru: "INVITE & EARN" }, image_builtin: "invite-pointing", action_type: "referral", action_target: "", created_at: 1, updated_at: 1 });
  const b = (await s.L("GET", "/home/banners", { uid: "stud" })).body.banners;
  const inv = b.find(x => x.id === "sys_invite"), story = b.find(x => x.id === "sys_story");
  assert.deepEqual(inv.title_i18n, { ru: "ПРИГЛАШАЙ И ЗАРАБАТЫВАЙ", en: "INVITE & EARN", ua: "ЗАПРОШУЙ ТА ЗАРОБЛЯЙ" });
  assert.equal(inv.category_i18n.en, "$10 per qualified referral"); assert.equal(JSON.stringify(b).includes("100"), false);
  assert.deepEqual(story.title_i18n, { ru: "ИСТОРИЯ СОЗДАНИЯ HIDDEN DINOX", en: "THE STORY BEHIND HIDDEN DINOX", ua: "ІСТОРІЯ СТВОРЕННЯ HIDDEN DINOX" });
  assert.equal(story.href, "story.html"); assert.equal(story.image_url, "assets/banners/banner-story.webp");
  await s.A("PUT", "/announcements/sys_invite", { uid: "boss", body: { kind: "banner", title: "Моя акция", title_i18n: { ru: "МОЯ АКЦИЯ" }, action_type: "referral", status: "published" } });
  const after = (await s.L("GET", "/home/banners", { uid: "stud" })).body.banners.find(x => x.id === "sys_invite");
  assert.deepEqual(after.title_i18n, { ru: "МОЯ АКЦИЯ" });                                              // правка администратора сохраняется
});
