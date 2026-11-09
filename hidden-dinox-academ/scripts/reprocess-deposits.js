#!/usr/bin/env node
"use strict";
/* Повторная обработка сохранённых депозитов академии.
   По умолчанию — ТОЛЬКО ПОКАЗЫВАЕТ, что будет изменено. Для записи добавьте --apply.

   node scripts/reprocess-deposits.js                      # все Trader ID, просмотр
   node scripts/reprocess-deposits.js --trader 12345678    # один Trader ID
   node scripts/reprocess-deposits.js --currency USD       # записи без валюты считать USD (ТОЛЬКО если это подтверждено Pocket Partners)
   node scripts/reprocess-deposits.js --currency USD --apply

   Требуется FIREBASE_KEY (как у сервера). Повторный запуск ничего не дублирует. */
const admin = require("firebase-admin");
const { initFirebase } = require("../academy/firebase-init");
const { reprocessAll } = require("../academy/reprocess");

const args = process.argv.slice(2);
const val = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const opts = { trader: val("--trader"), currency: val("--currency"), apply: args.includes("--apply") };

(async () => {
  const { db, reason } = initFirebase({ admin, log: { log() {}, error: m => console.error(m) } });
  if (!db) { console.error("Firebase не подключён: " + reason); process.exit(2); }
  console.log(opts.apply ? "РЕЖИМ ЗАПИСИ" : "Режим просмотра (ничего не записывается; для записи добавьте --apply)");
  if (opts.currency) console.log("Записи без валюты будут считаться: " + opts.currency.toUpperCase());
  const results = await reprocessAll(db, opts);
  let n = 0;
  for (const r of results) {
    if (!r.changes.length) continue;
    n += r.changes.length;
    console.log(`Trader ••••${r.trader.slice(-4)}: ` + r.changes.map(c => `${c.key.slice(0, 12)}… → ${c.depositStatus}${c.currency ? " " + c.currency : ""}${c.legacy ? " (прошлая версия)" : ""}`).join("; "));
  }
  console.log(`Проверено Trader ID: ${results.length}; изменений ${opts.apply ? "записано" : "будет"}: ${n}`);
  process.exit(0);
})().catch(e => { console.error("Ошибка:", e.message); process.exit(1); });
