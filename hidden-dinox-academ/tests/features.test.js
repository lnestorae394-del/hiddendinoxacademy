"use strict";
/* Карточки функций Academy: управление из админки, статусы, доступ, языки, защита ACTIVE и API модулей. */
const test = require("node:test"), assert = require("node:assert");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify } = require("./helpers/http");
const { adminCaller, learnCaller } = require("./helpers/router");
const { createAdminApi } = require("../academy/admin-api");
const { createLearnApi } = require("../academy/learn-api");
const { createAcademyApi } = require("../academy/api");
const { createFeatures, MODULES } = require("../academy/features");
const quiet = { log() {}, warn() {}, error() {} };
async function setup() {
  const db = new FakeFirestore();
  const academyApi = createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet });
  const A = adminCaller(createAdminApi({ db, verifyIdToken: fakeVerify, log: quiet }));
  const L = learnCaller(createLearnApi({ db, academyApi, log: quiet }));
  await db.collection("users").doc("boss").set({ role: "admin", email: "boss@t" });
  await db.collection("users").doc("mentor1").set({ role: "mentor", email: "m@t" });
  await db.collection("users").doc("staff").set({ role: "team_member", email: "s@t" });   // доступ к академии как у сотрудника
  await db.collection("users").doc("stu").set({ role: "student", email: "u@t" });           // без активированной академии
  return { db, A, L };
}
const cardsOf = async (L, uid, lang = "ru") => (await L("GET", "/home/features?lang=" + lang, { uid, query: { lang } })).body;

test("по умолчанию: четыре стандартные карточки «Скоро» без ссылок; ученик видит их без деплоя и записей в базе", async () => {
  const { A, L, db } = await setup();
  const r = await A("GET", "/features", { uid: "boss" });
  assert.strictEqual(r.statusCode, 200); assert.deepStrictEqual(r.body.cards.map(c => c.id), ["ai_mentor", "daily_tests", "chart_training", "pre_trade"]);
  assert.ok(r.body.cards.every(c => c.status === "COMING_SOON" && c.builtin && !c.customized));
  assert.deepStrictEqual(Object.fromEntries(r.body.modules.map(m => [m.key, m.ready])), { "mentor": true, "daily-tests": true, "chart-training": true, "pre-trade": true }, "все четыре модуля реализованы");
  const s = await cardsOf(L, "staff");
  assert.deepStrictEqual(r.body.cards.map(c => [c.id, c.show_on_dashboard]), [["ai_mentor", true], ["daily_tests", true], ["chart_training", false], ["pre_trade", false]]);
  assert.deepStrictEqual(s.cards.map(c => [c.id, c.status, c.href]), [["ai_mentor", "COMING_SOON", null], ["daily_tests", "COMING_SOON", null]], "у ученика только две карточки");
  assert.strictEqual((await db.collection("academy_features").get()).docs.length, 0);
});

test("изменения из админки видны ученику сразу (статус, тексты, языки)", async () => {
  const { A, L } = await setup();
  const u = await A("PUT", "/features/daily_tests", { uid: "boss", body: { status: "IN_DEVELOPMENT", title: { ru: "Ежедневные тесты", en: "Daily Tests", ua: "Щоденні тести" }, description: { ru: "Пять заданий" } } });
  assert.strictEqual(u.statusCode, 200, JSON.stringify(u.body));
  const ru = (await cardsOf(L, "staff")).cards.find(c => c.id === "daily_tests");
  assert.strictEqual(ru.title, "Ежедневные тесты"); assert.strictEqual(ru.status, "IN_DEVELOPMENT"); assert.strictEqual(ru.description, "Пять заданий");
  const ua = (await cardsOf(L, "staff", "ua")).cards.find(c => c.id === "daily_tests");
  assert.strictEqual(ua.title, "Щоденні тести"); assert.strictEqual(ua.description, "Пять заданий", "нет перевода — русский текст");
});

test("ACTIVE отклоняется, пока модуль не реализован; неизвестный статус/иконка/модуль — 400", async () => {
  const { A } = await setup();
  const savedHref = MODULES["mentor"].href; MODULES["mentor"].href = null;   // имитируем модуль без страницы
  try {
  const r = await A("POST", "/features/ai_mentor/status", { uid: "boss", body: { status: "ACTIVE" } });
  assert.strictEqual(r.statusCode, 400); assert.strictEqual(r.body.field, "status"); assert.match(r.body.message, /не реализован/);
  assert.strictEqual((await A("POST", "/features/ai_mentor/status", { uid: "boss", body: { status: "LIVE" } })).statusCode, 400);
  assert.strictEqual((await A("PUT", "/features/ai_mentor", { uid: "boss", body: { icon: "<svg>" } })).statusCode, 400);
  assert.strictEqual((await A("PUT", "/features/ai_mentor", { uid: "boss", body: { module: "chart-training" } })).statusCode, 400, "модуль стандартной карточки не меняется");
  assert.strictEqual((await A("PUT", "/features/nope", { uid: "boss", body: { status: "COMING_SOON" } })).statusCode, 404);
  assert.strictEqual((await A("PUT", "/features/ai_mentor", { uid: "boss", body: { title: { ru: "x".repeat(61) } } })).statusCode, 400);
  } finally { MODULES["mentor"].href = savedHref; }
});

test("ACTIVE работает, когда разработчик регистрирует страницу модуля; ссылка только из реестра", async () => {
  const { A, L } = await setup(); const saved = MODULES["mentor"].href;
  try {
    MODULES["mentor"].href = null;
    assert.strictEqual((await A("POST", "/features/ai_mentor/status", { uid: "boss", body: { status: "ACTIVE" } })).statusCode, 400, "страницы нет — «Открыть» недоступен");
    MODULES["mentor"].href = "/academy/mentor.html";
    assert.strictEqual((await A("POST", "/features/ai_mentor/status", { uid: "boss", body: { status: "ACTIVE" } })).statusCode, 200);
    const c = (await cardsOf(L, "staff")).cards.find(x => x.id === "ai_mentor");
    assert.deepStrictEqual([c.status, c.href], ["ACTIVE", "/academy/mentor.html"]);
    MODULES["mentor"].href = null;
    const c2 = (await cardsOf(L, "staff")).cards.find(x => x.id === "ai_mentor");
    assert.deepStrictEqual([c2.status, c2.href], ["IN_DEVELOPMENT", null], "страницу убрали — карточка не ведёт на несуществующий модуль");
  } finally { MODULES["mentor"].href = saved; }
  assert.strictEqual((await A("POST", "/features/daily_tests/status", { uid: "boss", body: { status: "ACTIVE" } })).statusCode, 200);
  const d = (await cardsOf(L, "staff")).cards.find(x => x.id === "daily_tests");
  assert.deepStrictEqual([d.status, d.href], ["ACTIVE", "/academy/daily-tests.html"]);
});

test("права: student и mentor не управляют карточками; ученик без доступа к академии — 403", async () => {
  const { A, L } = await setup();
  for (const uid of ["stu", "mentor1"]) {
    assert.strictEqual((await A("GET", "/features", { uid })).statusCode, 403, uid);
    assert.strictEqual((await A("POST", "/features/ai_mentor/status", { uid, body: { status: "DISABLED" } })).statusCode, 403, uid);
    assert.strictEqual((await A("POST", "/features", { uid, body: { id: "x_card", title: { ru: "X" } } })).statusCode, 403, uid);
  }
  assert.strictEqual((await A("GET", "/features", {})).statusCode, 401, "без токена");
  const r = await L("GET", "/home/features", { uid: "stu" }); assert.strictEqual(r.statusCode, 403); assert.strictEqual(r.body.error, "NO_ACCESS");
});

test("дополнительная карточка: информационная, ID проверяется, порядок, удаление только с подтверждением", async () => {
  const { A, L } = await setup();
  assert.strictEqual((await A("POST", "/features", { uid: "boss", body: { id: "ai_mentor", title: { ru: "дубль" } } })).statusCode, 400);
  assert.strictEqual((await A("POST", "/features", { uid: "boss", body: { id: "../x", title: { ru: "X" } } })).statusCode, 400);
  assert.strictEqual((await A("POST", "/features", { uid: "boss", body: { id: "journal", title: { ru: "Журнал" }, module: "https://evil.example" } })).statusCode, 400, "произвольный адрес запрещён");
  const c = await A("POST", "/features", { uid: "boss", body: { id: "journal", title: { ru: "Журнал сделок", en: "Trade journal" }, icon: "book", status: "ACTIVE" } });
  assert.strictEqual(c.statusCode, 400, "у карточки без модуля нет статуса «Открыть»");
  const ok = await A("POST", "/features", { uid: "boss", body: { id: "journal", title: { ru: "Журнал сделок", en: "Trade journal" }, icon: "book" } });
  assert.strictEqual(ok.statusCode, 200); assert.deepStrictEqual([ok.body.card.status, ok.body.card.module, ok.body.card.order], ["COMING_SOON", "", 5]);
  const st = (await cardsOf(L, "staff", "en")).cards; assert.deepStrictEqual(st.map(x => x.id), ["ai_mentor", "daily_tests", "journal"]);
  assert.strictEqual(st[2].title, "Trade journal"); assert.strictEqual(st[2].href, null);
  assert.strictEqual((await A("POST", "/features/order", { uid: "boss", body: { ids: ["journal", "daily_tests"] } })).statusCode, 400, "неполный список");
  const o = await A("POST", "/features/order", { uid: "boss", body: { ids: ["journal", "chart_training", "ai_mentor", "pre_trade", "daily_tests"] } });
  assert.deepStrictEqual(o.body.cards.map(x => x.id), ["journal", "chart_training", "ai_mentor", "pre_trade", "daily_tests"]);
  assert.strictEqual((await A("POST", "/features/journal/delete", { uid: "boss", body: {} })).statusCode, 400, "без подтверждения");
  assert.strictEqual((await A("POST", "/features/ai_mentor/delete", { uid: "boss", body: { confirm: true } })).statusCode, 400, "стандартную нельзя удалить");
  assert.strictEqual((await A("POST", "/features/journal/delete", { uid: "boss", body: { confirm: true } })).statusCode, 200);
});

test("DISABLED: скрыта или показана по настройке; enabled:false скрывает; сброс возвращает стандартные, дополнительные остаются", async () => {
  const { A, L } = await setup();
  await A("POST", "/features", { uid: "boss", body: { id: "extra_one", title: { ru: "Доп" } } });
  await A("PUT", "/features/daily_tests", { uid: "boss", body: { status: "DISABLED" } });
  assert.ok(!(await cardsOf(L, "staff")).cards.some(c => c.id === "daily_tests"), "DISABLED + hide → скрыта");
  await A("PUT", "/features/daily_tests", { uid: "boss", body: { disabled_display: "show" } });
  assert.strictEqual((await cardsOf(L, "staff")).cards.find(c => c.id === "daily_tests").status, "DISABLED");
  await A("PUT", "/features/ai_mentor", { uid: "boss", body: { enabled: false } });
  assert.ok(!(await cardsOf(L, "staff")).cards.some(c => c.id === "ai_mentor"), "выключена — скрыта");
  assert.strictEqual((await A("POST", "/features/reset", { uid: "boss", body: {} })).statusCode, 400, "сброс только с подтверждением");
  const r = await A("POST", "/features/reset", { uid: "boss", body: { confirm: true } });
  assert.deepStrictEqual(r.body.cards.map(c => [c.id, c.status, c.enabled]), [["ai_mentor", "COMING_SOON", true], ["daily_tests", "COMING_SOON", true], ["chart_training", "COMING_SOON", true], ["pre_trade", "COMING_SOON", true], ["extra_one", "COMING_SOON", true]]);
});

test("requireFeature: API модуля закрыт, пока карточка не ACTIVE с реализованной страницей", async () => {
  const db = new FakeFirestore(); const F = createFeatures({ db });
  await assert.rejects(F.requireFeature("daily_tests"), e => e.code === "FEATURE_UNAVAILABLE" && e.status === 403);
  await assert.rejects(F.requireFeature("unknown"), e => e.code === "FEATURE_UNAVAILABLE");
  assert.strictEqual(await F.requireFeature("daily_tests", { preview: true }), true, "предпросмотр для администратора");
});

test("журнал аудита фиксирует действия с карточками", async () => {
  const { A, db } = await setup();
  await A("PUT", "/features/ai_mentor", { uid: "boss", body: { status: "IN_DEVELOPMENT" } });
  const logs = (await db.collection("audit_logs").get()).docs.map(d => d.data());
  assert.ok(logs.some(l => l.action === "feature.update" && l.target_id === "ai_mentor"), JSON.stringify(logs.map(l => l.action)));
});


test("кабинет ученика: «Тренировка на графике» и «Подготовка» скрыты флагом, модуль и API работают; администратор может вернуть карточку", async () => {
  const { A, L, db } = await setup();
  await A("POST", "/features/chart_training/status", { uid: "boss", body: { status: "ACTIVE" } });
  assert.ok(!(await cardsOf(L, "staff")).cards.some(c => c.id === "chart_training"), "открыт, но в кабинете не показан");
  assert.strictEqual(await require("../academy/features").createFeatures({ db }).isOpen("chart_training"), true, "модуль и его API работают (прямые ссылки не ломаются)");
  await A("PUT", "/features/chart_training", { uid: "boss", body: { show_on_dashboard: true } });
  const c = (await cardsOf(L, "staff")).cards.find(x => x.id === "chart_training"); assert.deepStrictEqual([c.status, c.href], ["ACTIVE", "/academy/chart-training.html"]);
  await A("PUT", "/features/chart_training", { uid: "boss", body: { show_on_dashboard: false } });
  assert.ok(!(await cardsOf(L, "staff")).cards.some(x => x.id === "chart_training"));
  await A("PUT", "/features/ai_mentor", { uid: "boss", body: { order: 7 } });
  assert.ok((await cardsOf(L, "staff")).cards.some(x => x.id === "ai_mentor"), "правка карточки не скрывает её (флаг по умолчанию сохраняется)");
});
