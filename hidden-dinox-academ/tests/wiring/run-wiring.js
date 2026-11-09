"use strict";
/* Запуск настоящего server.js в разных конфигурациях (каждая — отдельный процесс). */
const { execFileSync } = require("child_process"), path = require("path");
const KEY = JSON.stringify({ type: "service_account", project_id: "ai-boost-10540", private_key: "-----BEGIN PRIVATE KEY-----\\nTESTONLY\\n-----END PRIVATE KEY-----\\n", client_email: "test@ai-boost-10540.iam.gserviceaccount.com" });
const SECRET = "wiring-secret-0123456789abcdef-XYZ";
const run = (env, ...args) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "boot-scenario.js"), ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }));
const out = []; let failed = 0;
const check = (name, ok, info) => { out.push((ok ? "✔ " : "✘ ") + name + (ok ? "" : " — " + String(JSON.stringify(info === undefined ? null : info)).slice(0, 400))); if (!ok) failed++; };
const has = (o, s) => o.logs.some(l => l.includes(s));
const runChecked = (...a) => { const o = run(...a); if (o.flowError) { out.push("✘ ошибка внутри сценария: " + o.flowError.split("\n")[0]); failed++; } return o; };

// 1. Конфигурация как на Render: ключ + секрет, файлов ботов нет
const a = runChecked({ FIREBASE_KEY: KEY, POCKET_POSTBACK_SECRET: SECRET, POSTBACK_DEFAULT_CURRENCY: "" }, "FLOW");
check("сервер запускается без public/bot (нет «Cannot find module»)", a.listening && !a.error, a.error);
const M = a.mounts || {};
check("админ-API подключён по адресу /admin/api (не перекрыт «404» роутера /api)", M.adminApi && M.adminApiRoutes.includes("GET /me") && M.adminApiRoutes.includes("PUT /lessons/:id") && M.adminApiRoutes.includes("POST /courses/:id/publish"), M.adminApiRoutes);
check("страницы админ-панели раздаются из public/admin", M.adminStatic, M);
check("обучение подключено в /api: курсы, урок, тест, завершение, афиши", ["GET /learn/courses", "GET /learn/lessons/:id", "POST /learn/lessons/:id/quiz", "POST /learn/lessons/:id/complete", "GET /announcements"].every(x => (M.learn || []).includes(x)), M.learn);
check("файлы медиа отдаются по /media/:id", M.media, M);
check("Firebase инициализируется из FIREBASE_KEY", a.init === "credential:ai-boost-10540" && has(a, "Firebase подключён"), a.init);
check("закрытый ключ не попадает в логи", !a.logs.some(l => l.includes("TESTONLY") || l.includes("PRIVATE KEY")));
check("боты не запускаются по умолчанию, git push не запланирован", a.botsLoaded === 0 && a.gitIntervals === 0 && has(a, "ENABLE_LEGACY_BOTS"), a);
check("приём postback включён (секрет задан)", has(a, "приём postback включён"));
check("«/» отдаёт существующую страницу входа public/academy/index.html", /public[\\/]academy[\\/]index\.html$/.test(String(M.rootServes)), M.rootServes);
check("«/» и старые адреса входа зарегистрированы раньше статики /academy и public", M.rootIdx >= 0 && M.oldLoginIdx.every(i => i >= 0) && M.rootIdx < M.academyStaticIdx && M.oldLoginIdx.every(i => i < M.academyStaticIdx) && (M.publicStaticIdx < 0 || M.rootIdx < M.publicStaticIdx), M);
check("/academy/index.html?via=abc → 302 на /?via=abc", JSON.stringify(M.oldLoginRedirect) === JSON.stringify([302, "/?via=abc"]), M.oldLoginRedirect);
check("старые «чистые» маршруты без файлов не регистрируются (/login, /register, /index не дают 500)", !M.legacyGets.some(p => ["/index", "/login", "/register"].includes(p)), M.legacyGets);
const S = a.steps;
check("API без токена → 401", S.me401 === 401, S.me401);
check("postback без secret → 401", S.forgedNoSecret.code === 401, S.forgedNoSecret);
check("postback с неверным secret → 403", S.forgedWrong.code === 403, S.forgedWrong);
check("поддельный postback не создал записей (и старых полей AI BOOST)", S.legacyAfterForged === null, S.legacyAfterForged);
check("случайный Trader ID → 422", S.randomId === 422, S.randomId);
check("Registration postback → 200 registration_confirmed", S.reg.code === 200 && S.reg.status === "registration_confirmed", S.reg);
check("повтор Registration → 200 duplicate", S.regDup.code === 200 && S.regDup.status === "duplicate", S.regDup);
check("подтверждённый Trader ID принимается → 200", S.bind === 200, S.bind);
check("First Deposit $40.00 → 200 ftd_recorded", S.ftd.code === 200 && S.ftd.status === "ftd_recorded", S.ftd);
check("Re-deposit $60 → 200 redeposit_recorded; повтор → duplicate", S.redep.status === "redeposit_recorded" && S.redepDup.status === "duplicate", [S.redep, S.redepDup]);
check("неподставленные макросы → 400", S.macro.code === 400, S.macro);
check("депозит по Trader ID без регистрации (click_id не из академии) → 202, не учтён", S.unknownClick.code === 202 && S.unknownClick.status === "deposit_pending_registration", S.unknownClick);
check("старый публичный /check-deposit удалён: на маршруте один обработчик (с входом)", S["routes:/check-deposit"] === 1 && S["routes:/check"] === 1, S);
check("/check-deposit без входа → 401; /check без входа → 401", S.cdNoAuth === 401 && S.checkNoAuth === 401, [S.cdNoAuth, S.checkNoAuth]);
check("/check-deposit владельца: ok, сумма $40 по его Trader ID", S.cdOwn.code === 200 && S.cdOwn.body.ok === true && S.cdOwn.body.amount === 40 && S.cdOwn.body.traderId === "55500001", S.cdOwn);
check("/check-deposit с чужим trader_id → 403", S.cdForeign === 403, S.cdForeign);
check("статус пользователя: академия открыта, FTD $40, итог $100 за 2 депозита",
  S.profile.stage === "academy" && S.profile.access === true && S.profile.fd.amount === 40 && S.profile.deposits.totals.USD === 100 && S.profile.deposits.count === 2, S.profile);
check("старые поля AI BOOST записаны после проверки (merge, данные академии сохранены)", S.legacyFields.click_id && S.legacyFields.deposit === 40 && S.legacyFields.hasAcademy, S.legacyFields);
check("чужой пользователь не может взять этот Trader ID → 422", S.otherUser === 422, S.otherUser);
check("депозит по другому ID того же пользователя → 409 trader_mismatch, не учтён", S.mismatch.code === 409 && S.mismatch.status === "trader_mismatch" && S.mismatchLegacyDeposit, [S.mismatch, S.mismatchLegacyDeposit]);
check("депозит без валюты → 202 deposit_pending_currency (не учтён)", S.noCurrency.code === 202 && S.noCurrency.status === "deposit_pending_currency", S.noCurrency);
check("депозит другого пользователя по чужому ID → 409", S.foreignDeposit.code === 409, S.foreignDeposit);
check("баланс и доступ владельца после всех попыток не изменились", S.ownerAfter.fd === 40 && S.ownerAfter.total === 100 && S.ownerAfter.access === true, S.ownerAfter);
check("redeposit без включённых ботов не вызывает approveTrader", a.approveCalls === 0 && has(a, "approveTrader не вызывается"), a.approveCalls);

// 2. Без секрета: postback отклоняются с 503
const b = runChecked({ FIREBASE_KEY: KEY }, "FLOW");
check("без POCKET_POSTBACK_SECRET postback → 503 и предупреждение в логе", b.steps.reg && b.steps.reg.code === 503 && has(b, "POCKET_POSTBACK_SECRET не задан"), b.steps.reg);

// 3. Неверный FIREBASE_KEY: сервер работает, Firebase выключен, причина понятна, API 503
for (const [name, key] of [["обрезанный", KEY.slice(0, 50)], ["другой проект", KEY.replace("ai-boost-10540\"", "other-proj\"")], ["пустой", ""]]) {
  const c = runChecked({ FIREBASE_KEY: key, POCKET_POSTBACK_SECRET: SECRET }, "FLOW");
  check(`FIREBASE_KEY ${name}: сервер запущен, понятная причина, API → 503`, c.listening && c.init === null && c.steps.meNoFirebase === 503 && has(c, "Firebase отключён:"), { init: c.init, me: c.steps.meNoFirebase, logs: c.logs.filter(l => l.includes("Firebase")) });
}

// 4. Боты включены: файлы есть → запускаются; файлов нет → понятная остановка
const d = runChecked({ FIREBASE_KEY: KEY, POCKET_POSTBACK_SECRET: SECRET, ENABLE_LEGACY_BOTS: "1" }, "WITH_BOTS", "FLOW");
check("ENABLE_LEGACY_BOTS=1 и файлы есть → боты запущены", d.listening && d.botsLoaded === 2, d.error);
check("с включёнными ботами redeposit вызывает approveTrader один раз (повтор — нет)", d.approveCalls === 1, d.approveCalls);
const e = run({ FIREBASE_KEY: KEY, ENABLE_LEGACY_BOTS: "1" });
check("ENABLE_LEGACY_BOTS=1 без файлов → остановка с понятной ошибкой", !e.listening && /ENABLE_LEGACY_BOTS=1, но нет файла public\/bot\/bot\.js/.test(e.error || ""), e.error);

// 5. git push — только по явному флагу
check("ENABLE_GIT_AUTOSAVE=1 → автосохранение запланировано", run({ FIREBASE_KEY: KEY, ENABLE_GIT_AUTOSAVE: "1" }).gitIntervals === 1);

// 6. Тестовый режим: только эмуляторы, без ключа
const EMU = { HD_TEST_MODE: "1", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099", GCLOUD_PROJECT: "demo-hd-academy" };
const t = run({ ...EMU, ENABLE_LEGACY_BOTS: "1", ENABLE_GIT_AUTOSAVE: "1" }, "WITH_BOTS");
check("тестовый режим: demo-проект, боты и git отключены даже при флагах", t.listening && t.init === "projectId:demo-hd-academy" && t.botsLoaded === 0 && t.gitIntervals === 0, t);
const tk = run({ ...EMU, FIREBASE_KEY: KEY });
check("тестовый режим с production-ключом → не запускается", !tk.listening && /production-ключ/.test(tk.error || ""), tk.error);

// 7. Тестовый депозит по Trader ID: в production маршрута нет, в тестовом режиме — работает по правилам
const TSEC = "local-test-deposit-secret-only-0001";
const prod = run({ FIREBASE_KEY: KEY, POCKET_POSTBACK_SECRET: SECRET, TEST_POSTBACK_SECRET: TSEC }, "TESTDEP");
check("production (FIREBASE_KEY): /test/deposit НЕ существует даже при заданном TEST_POSTBACK_SECRET", prod.listening && prod.steps.testRoute === false, prod.steps);
const emu = runChecked({ ...EMU, POCKET_POSTBACK_SECRET: SECRET, TEST_POSTBACK_SECRET: TSEC }, "TESTDEP");
const T = emu.steps;
check("тестовый режим: маршрут /test/deposit включён и предупреждение в логе", T.testRoute === true && has(emu, "/test/deposit включён"), T.testRoute);
check("тестовый депозит до регистрации ID → 422 trader_not_confirmed", T.beforeReg && T.beforeReg.code === 422 && T.beforeReg.status === "trader_not_confirmed", T.beforeReg);
check("регистрация 142807701 через настоящий /postback и привязка → этап deposit", T.reg && T.reg.code === 200 && T.bind === 200 && T.stageBefore === "deposit", T);
check("секрет реальных postback не подходит к тестовому маршруту → 403", T.wrongSecret && T.wrongSecret.code === 403, T.wrongSecret);
check("тестовый депозит $69 USD по 142807701 → 200 ftd_recorded; повтор → duplicate", T.dep && T.dep.code === 200 && T.dep.status === "ftd_recorded" && T.depDup.status === "duplicate", [T.dep, T.depDup]);
check("профиль после депозита: этап academy, доступ открыт, FTD $69, итог $69", T.after && T.after.stage === "academy" && T.after.access === true && T.after.fd === 69 && T.after.total === 69, T.after);
check("тестовое событие в базе помечено test: true и учтено один раз", T.events && T.events.filter(e => e.test).length === 1 && T.events.find(e => e.test).status === "counted", T.events);
check("настоящий /postback без click_id находит пользователя по trader_id (с верным секретом)", T.realNoClick && T.realNoClick.code === 200, T.realNoClick);
const same = run({ ...EMU, POCKET_POSTBACK_SECRET: SECRET, TEST_POSTBACK_SECRET: SECRET }, "TESTDEP");
check("тестовый секрет, совпадающий с POCKET_POSTBACK_SECRET → маршрут не включается", same.steps.testRoute === false && has(same, "должен отличаться"), same.steps);

// 8. Случай 142808073 из production
const c8 = runChecked({ FIREBASE_KEY: KEY, POCKET_POSTBACK_SECRET: SECRET, POSTBACK_DEFAULT_CURRENCY: "" }, "CASE8073");
const C = c8.steps;
check("[8073] регистрация (click_id платформы) и привязка прежнего аккаунта", C.c_reg && C.c_reg.code === 200 && C.c_bind === 200, [C.c_reg, C.c_bind]);
check("[8073] FTD с другим click_id платформы → 200 ftd_recorded (было 409 conflict_click)", C.c_ftd && C.c_ftd.code === 200 && C.c_ftd.status === "ftd_recorded", C.c_ftd);
check("[8073] в логе: владелец, привязка и пометка о другом click_id", (C.c_log || []).some(l => /trader ••••8073, click не из академии, владелец не известен, привязка есть → ftd_recorded \(click_id отличается/.test(l)), C.c_log);
check("[8073] повтор → 200 duplicate", C.c_dup && C.c_dup.status === "duplicate", C.c_dup);
check("[8073] click_id академии другого пользователя → 409", C.c_eve && C.c_eve.code === 409, C.c_eve);
check("[8073] новый аккаунт не может взять ID (409), привязка не изменена и не удалена", C.c_newBind === 409 && C.c_binding && C.c_binding.uid === "old_uid", [C.c_newBind, C.c_binding]);
check("[8073] доступ у владельца привязки, не у нового аккаунта", C.c_old === true && C.c_new === false, [C.c_old, C.c_new]);

// 9. Одноразовое назначение Super Admin по UID (ADMIN_BOOTSTRAP_UID)
const bNone = runChecked({ FIREBASE_KEY: KEY }, "BOOTSTRAP");
check("bootstrap: без ADMIN_BOOTSTRAP_UID роль никому не назначается", bNone.listening && !bNone.steps.boot.role && !bNone.steps.boot.marker, bNone.steps);
const bBad = runChecked({ FIREBASE_KEY: KEY, ADMIN_BOOTSTRAP_UID: "olya@gmail.com" }, "BOOTSTRAP");
check("bootstrap: email вместо UID отклоняется", !bBad.steps.boot.role && has(bBad, "ADMIN_BOOTSTRAP_UID некорректен"), bBad.logs.slice(-3));
const bOk = runChecked({ FIREBASE_KEY: KEY, ADMIN_BOOTSTRAP_UID: "OwnerUid0000000000000001" }, "BOOTSTRAP");
check("bootstrap: существующий UID получает super_admin, маркер записан", bOk.steps.boot.role === "super_admin" && bOk.steps.boot.marker && has(bOk, "Одноразовое назначение Super Admin выполнено"), bOk.steps);
const bMissing = runChecked({ FIREBASE_KEY: KEY, ADMIN_BOOTSTRAP_UID: "UnknownUid00000000000009" }, "BOOTSTRAP");
check("bootstrap: несуществующий UID — роль не назначена, понятная ошибка", !bMissing.steps.boot.marker && has(bMissing, "аккаунт с этим UID не найден"), bMissing.logs.slice(-3));
const bTest = runChecked({ ...EMU, ADMIN_BOOTSTRAP_UID: "OwnerUid0000000000000001" }, "BOOTSTRAP");
check("bootstrap: в тестовом режиме не выполняется", !bTest.steps.boot.role, bTest.steps);
check("адрес olya@gmail.com в коде сервера отсутствует", !require("fs").readFileSync(require("path").join(__dirname, "../../server.js"), "utf8").includes("olya@"));

console.log(out.join("\n"));
console.log(`итого: ${out.length - failed} из ${out.length}`);
process.exit(failed ? 1 : 0);
