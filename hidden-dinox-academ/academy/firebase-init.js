"use strict";
/* Безопасная инициализация Firebase Admin SDK из переменной окружения FIREBASE_KEY.
   Принимает JSON сервисного аккаунта как есть или в base64. Исправляет типичную ошибку
   вставки: «\\n» вместо переносов строк в private_key. В логи пишет только причину
   ошибки и project_id — никогда сам ключ. */

function parseServiceAccount(raw) {
  if (!raw || !String(raw).trim()) return { error: "FIREBASE_KEY не задан" };
  let s = String(raw).trim();
  let obj;
  const tryJson = t => { try { return JSON.parse(t); } catch (e) { return undefined; } };
  obj = tryJson(s);                                                     // 1) JSON как есть
  if (obj === undefined && /^'.*'$/s.test(s)) obj = tryJson(s.slice(1, -1));   // 2) в одинарных кавычках
  if (obj === undefined && !s.startsWith("{")) {                        // 3) base64 от JSON
    const d = Buffer.from(s, "base64").toString("utf8").trim();
    if (d.startsWith("{")) obj = tryJson(d);
  }
  if (typeof obj === "string") obj = tryJson(obj.trim());               // JSON, сохранённый строкой
  if (!obj || typeof obj !== "object") return { error: "FIREBASE_KEY не является корректным JSON (или base64 от JSON)" };
  const missing = ["type", "project_id", "private_key", "client_email"].filter(k => !obj || typeof obj[k] !== "string" || !obj[k]);
  if (missing.length) return { error: "в FIREBASE_KEY нет полей: " + missing.join(", ") };
  if (obj.type !== "service_account") return { error: "FIREBASE_KEY: type должен быть service_account" };
  if (obj.private_key.includes("\\n")) obj.private_key = obj.private_key.replace(/\\n/g, "\n");
  if (!obj.private_key.includes("BEGIN PRIVATE KEY")) return { error: "FIREBASE_KEY: private_key повреждён" };
  return { account: obj };
}

function initFirebase({ admin, env = process.env, log = console, testMode = false }) {
  try {
    if (testMode) {
      admin.initializeApp({ projectId: env.GCLOUD_PROJECT });
    } else {
      const { account, error } = parseServiceAccount(env.FIREBASE_KEY);
      if (error) { log.error("❌ Firebase отключён: " + error); return { db: null, reason: error }; }
      const expected = env.FIREBASE_PROJECT_ID || "ai-boost-10540";
      if (account.project_id !== expected) {
        const reason = `FIREBASE_KEY относится к проекту «${account.project_id}», ожидается «${expected}»`;
        log.error("❌ Firebase отключён: " + reason);
        return { db: null, reason };
      }
      admin.initializeApp({ credential: admin.credential.cert(account), projectId: account.project_id });
    }
    const db = admin.firestore();
    if (db && typeof db.settings === "function") db.settings({ ignoreUndefinedProperties: true });
    log.log("🔥 Firebase подключён: " + (testMode ? env.GCLOUD_PROJECT + " (эмулятор)" : (env.FIREBASE_PROJECT_ID || "ai-boost-10540")));
    return { db, reason: null };
  } catch (e) {
    const reason = "ошибка инициализации Firebase: " + (e && e.code ? e.code : "unknown");
    log.error("❌ " + reason);
    return { db: null, reason };
  }
}

module.exports = { initFirebase, parseServiceAccount };
