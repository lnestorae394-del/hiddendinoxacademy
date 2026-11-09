#!/usr/bin/env node
"use strict";
/* Подготовка ТЕСТОВОГО пользователя в эмуляторе Firebase (только HD_TEST_MODE).
   Создаёт аккаунт академии, выдаёт click_id, проводит НАСТОЯЩУЮ обработку registration postback
   для Trader ID и привязывает ID к пользователю тем же серверным кодом, что и сайт.

   node scripts/test-seed.js [--trader 142807701] [--email test142807701@hd.test] [--password Test12345!]
   Переменные — из .env.test (HD_TEST_MODE=1, эмуляторы, POCKET_POSTBACK_SECRET, TEST_POSTBACK_SECRET). */
const admin = require("firebase-admin");
const { resolveTestMode } = require("../academy/test-mode");
const { initFirebase } = require("../academy/firebase-init");
const { createAcademyApi } = require("../academy/api");
const { createAcademyPostback } = require("../academy/postback");

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const TRADER = val("--trader", "142807701");
const EMAIL = val("--email", `test${TRADER}@hd.test`);
const PASSWORD = val("--password", "Test12345!");
const quiet = { log() {}, warn() {}, error: m => console.error(m) };

(async () => {
  let testMode;
  try { testMode = resolveTestMode(process.env); } catch (e) { console.error(e.message); process.exit(2); }
  if (!testMode) { console.error("Отказ: скрипт работает только с HD_TEST_MODE=1 и эмуляторами Firebase (production не трогается)."); process.exit(2); }
  const { db, reason } = initFirebase({ admin, testMode: true, log: quiet });
  if (!db) { console.error("Эмулятор Firebase не подключён: " + reason); process.exit(2); }

  // 1) Аккаунт академии в эмуляторе Authentication
  let user;
  try { user = await admin.auth().getUserByEmail(EMAIL); }
  catch (e) { user = await admin.auth().createUser({ email: EMAIL, password: PASSWORD }); }
  const uid = user.uid;
  const verifyIdToken = async () => ({ uid, email: EMAIL }); // сценарий от имени созданного пользователя (только эмулятор)
  const api = createAcademyApi({ db, verifyIdToken, log: quiet });
  const call = async (h, body) => { const r = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } }; await api[h]({ headers: { authorization: "Bearer emulator-seed-token-" + uid }, body: body || {} }, r); return r; };

  await call("me");
  const click = (await call("click")).body.clickId;                              // 2) click_id, как при нажатии POCKET

  // 3) НАСТОЯЩАЯ обработка registration postback (тот же код, что и /postback)
  const pb = createAcademyPostback({ db, env: process.env, log: quiet });
  const reg = await pb.handle({ click_id: click, trader_id: TRADER, secret: process.env.POCKET_POSTBACK_SECRET });
  if (![200].includes(reg.http)) { console.error("Регистрация не подтверждена:", reg.status, reg.message); process.exit(1); }

  const bind = await call("traderId", { traderId: TRADER });                     // 4) привязка ID (с проверкой регистрации)
  if (bind.code !== 200) { console.error("Привязка не выполнена:", bind.code, bind.body); process.exit(1); }

  const port = process.env.PORT || 3000;
  console.log("Тестовый пользователь готов (эмулятор):");
  console.log("  email:     " + EMAIL);
  console.log("  пароль:    " + PASSWORD);
  console.log("  Trader ID: " + TRADER + " (регистрация: " + reg.status + ", этап: " + bind.body.stage + ")");
  console.log("Войдите: http://127.0.0.1:" + port + "/academy/");
  console.log("Тестовый депозит $69 USD:");
  console.log(`  http://127.0.0.1:${port}/test/deposit?trader_id=${TRADER}&amount=69&currency=USD&test_secret=${encodeURIComponent(process.env.TEST_POSTBACK_SECRET || "<TEST_POSTBACK_SECRET>")}`);
  process.exit(0);
})().catch(e => { console.error("Ошибка:", e.message); process.exit(1); });
