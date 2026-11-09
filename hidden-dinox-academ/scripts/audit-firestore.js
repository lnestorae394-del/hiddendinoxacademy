#!/usr/bin/env node
"use strict";
/* Аудит данных академии в Firestore — только чтение. Требуется FIREBASE_KEY.
   node scripts/audit-firestore.js */
const admin = require("firebase-admin");
const { initFirebase } = require("../academy/firebase-init");
const { runAudit } = require("../academy/audit");
(async () => {
  const { db, reason } = initFirebase({ admin, log: { log() {}, error: m => console.error(m) } });
  if (!db) { console.error("Firebase не подключён: " + reason); process.exit(2); }
  console.log(JSON.stringify(await runAudit(db), null, 2));
  process.exit(0);
})().catch(e => { console.error("Ошибка:", e.message); process.exit(1); });
