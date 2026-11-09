#!/usr/bin/env node
"use strict";
/* Перенос привязки Trader ID на другой аккаунт академии — ТОЛЬКО по решению администратора.
   По умолчанию показывает, что будет сделано. Для записи — --apply. Ничего не удаляет.
   node scripts/rebind-trader.js --trader 142808073 --to-email new@mail.com --reason "владелец сменил аккаунт"
   node scripts/rebind-trader.js --trader 142808073 --to-email new@mail.com --reason "…" --apply
   Перед переносом убедитесь, что новый аккаунт принадлежит владельцу Trader ID. */
const admin = require("firebase-admin");
const { initFirebase } = require("../academy/firebase-init");
const { rebindTrader } = require("../academy/admin");
const args = process.argv.slice(2), val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
(async () => {
  const trader = val("--trader"), email = val("--to-email"), uidArg = val("--to-uid"), reason = val("--reason") || "", apply = args.includes("--apply");
  if (!trader || !(email || uidArg)) { console.error("Нужны --trader и --to-email (или --to-uid)"); process.exit(2); }
  if (apply && !reason) { console.error("Для --apply укажите --reason"); process.exit(2); }
  const { db, reason: why } = initFirebase({ admin, log: { log() {}, error: m => console.error(m) } });
  if (!db) { console.error("Firebase не подключён: " + why); process.exit(2); }
  const toUid = uidArg || (await admin.auth().getUserByEmail(email)).uid;
  const r = await rebindTrader(db, { trader, toUid, reason, apply });
  console.log(apply ? "РЕЖИМ ЗАПИСИ" : "Просмотр (ничего не записано; для записи добавьте --apply)");
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
})().catch(e => { console.error("Ошибка:", e.message); process.exit(1); });
