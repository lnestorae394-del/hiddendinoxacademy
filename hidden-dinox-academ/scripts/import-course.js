#!/usr/bin/env node
"use strict";
/* Импорт курса из JSON в CMS как ЧЕРНОВИК (ничего не публикуется). Требуется FIREBASE_KEY.
   node scripts/import-course.js --file content/hidden-reaction-course.json            # проверка файла
   node scripts/import-course.js --file content/hidden-reaction-course.json --apply    # запись черновика */
const fs = require("fs");
const admin = require("firebase-admin");
const { initFirebase } = require("../academy/firebase-init");
const { createAdminApi } = require("../academy/admin-api");
const C = require("../academy/content");
const args = process.argv.slice(2), val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
(async () => {
  const file = val("--file"); if (!file) { console.error("Укажите --file"); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  // Проверка всего файла теми же правилами, что и CMS
  C.course(data.course); let n = 0;
  for (const m of data.modules) { C.moduleDoc(m); for (const l of m.lessons) { C.lesson(l); n++; } }
  console.log(`Файл корректен: «${data.course.title}», модулей ${data.modules.length}, уроков ${n}.`);
  if (!args.includes("--apply")) { console.log("Просмотр. Для записи черновика добавьте --apply."); process.exit(0); }
  const { db, reason } = initFirebase({ admin, log: { log() {}, error: m => console.error(m) } });
  if (!db) { console.error("Firebase не подключён: " + reason); process.exit(2); }
  const api = createAdminApi({ db, verifyIdToken: null, log: console });
  const r = await api.H.importCourse({ body: { confirm: true, data } }, { uid: "cli", email: null, role: "super_admin" });
  console.log("Черновик создан:", r);
  process.exit(0);
})().catch(e => { console.error("Ошибка:", e.message, e.field ? "(" + e.field + ")" : ""); process.exit(1); });
