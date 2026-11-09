#!/usr/bin/env node
"use strict";
/* Диагностика Trader ID — ТОЛЬКО ЧТЕНИЕ. Требуется FIREBASE_KEY.
   node scripts/inspect-trader.js --trader 142808073 */
const admin = require("firebase-admin");
const { initFirebase } = require("../academy/firebase-init");
const { inspectTrader } = require("../academy/admin");
const args = process.argv.slice(2), val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
(async () => {
  const trader = val("--trader");
  if (!trader) { console.error("Укажите --trader"); process.exit(2); }
  const { db, reason } = initFirebase({ admin, log: { log() {}, error: m => console.error(m) } });
  if (!db) { console.error("Firebase не подключён: " + reason); process.exit(2); }
  console.log(JSON.stringify(await inspectTrader(db, trader), null, 2));
  process.exit(0);
})().catch(e => { console.error("Ошибка:", e.message); process.exit(1); });
