#!/usr/bin/env node
"use strict";
/* Назначение роли (в т. ч. первого Super Admin) — ТОЛЬКО администратором сервера. Требуется FIREBASE_KEY.
   node scripts/set-role.js --email you@mail.com --role super_admin            # просмотр
   node scripts/set-role.js --email you@mail.com --role super_admin --apply    # запись
   Пользователь должен хотя бы раз войти в академию (аккаунт Firebase Auth). */
const admin = require("firebase-admin");
const { initFirebase } = require("../academy/firebase-init");
const R = require("../academy/roles");
const args = process.argv.slice(2), val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
(async () => {
  const email = val("--email"), role = val("--role"), apply = args.includes("--apply");
  if (!email || !R.ROLES.includes(role)) { console.error("Нужны --email и --role (" + R.ROLES.join(", ") + ")"); process.exit(2); }
  const { db, reason } = initFirebase({ admin, log: { log() {}, error: m => console.error(m) } });
  if (!db) { console.error("Firebase не подключён: " + reason); process.exit(2); }
  const u = await admin.auth().getUserByEmail(email);
  const ref = db.collection("users").doc(u.uid); const cur = await ref.get();
  const from = cur.exists ? (cur.data().role || "student") : "student";
  console.log(`${email} (${u.uid}): ${from} → ${role}` + (apply ? "" : "  [просмотр; для записи добавьте --apply]"));
  if (apply) {
    await ref.set({ email: u.email || email, role, role_updated_at: Date.now(), role_updated_by: "cli" }, { merge: true });
    await db.collection("audit_logs").doc("log_cli_" + Date.now()).set({ at: Date.now(), actor_uid: "cli", actor_email: null, actor_role: "cli", action: "user.role", target_type: "user", target_id: u.uid, details: { from, to: role } });
    console.log("Записано.");
  }
  process.exit(0);
})().catch(e => { console.error("Ошибка:", e.message); process.exit(1); });
