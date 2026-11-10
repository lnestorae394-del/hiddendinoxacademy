"use strict";
/* Инициализация базы самостоятельной Video Studio вручную (то же самое выполняется автоматически при запуске vs-server.js).
   Использование: FIREBASE_KEY=... FIREBASE_PROJECT_ID=hidden-dinox-video-staging node scripts/vs-init.js [--check]
   --check — только проверка, ничего не создаётся. Повторный запуск безопасен: существующие данные не меняются. */
const admin = require("firebase-admin"), { initFirebase } = require("../video-studio/firebase-init"), { ensureDatabase } = require("../video-studio/bootstrap");
(async () => {
  const fb = initFirebase({ admin, env: process.env }); if (!fb.db) { console.error("Не удалось подключиться: " + fb.reason); process.exit(1); }
  console.log("Проект Firebase: " + fb.projectId);
  if (process.argv.includes("--check")) { const m = (await fb.db.collection("videoStudioSettings").doc("meta").get()); console.log(m.exists ? "Служебные документы на месте (schema_version " + m.data().schema_version + ")" : "База ещё не инициализирована — будет создана при первом запуске vs-server.js"); return; }
  const r = await ensureDatabase(fb.db, { projectId: fb.projectId }); console.log("Создано: " + (r.created.join(", ") || "ничего (всё уже есть)")); if (!r.ok) { console.error("Проблемы: " + r.problems.join("; ")); process.exit(2); }
})().catch(e => { console.error("Ошибка:", e && e.message); process.exit(1); });
