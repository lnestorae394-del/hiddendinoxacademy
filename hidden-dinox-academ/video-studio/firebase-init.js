"use strict";
/* Инициализация Firebase Admin SDK для Video Studio.
   Проект Firebase задаётся явно (FIREBASE_PROJECT_ID, запасного значения нет) и обязан соответствовать шаблону имён Video Studio (по умолчанию «hidden-dinox-video-…»,
   можно изменить VIDEO_STUDIO_ALLOWED_PROJECT_PATTERN). Ключ сервисного аккаунта обязан принадлежать именно этому проекту; эмуляторы и GOOGLE_APPLICATION_CREDENTIALS вне тестового режима не принимаются.
   В журнал пишутся только причина ошибки и id проекта — никогда сам ключ. */
const DEFAULT_PROJECT_PATTERN = "^hidden-dinox-video-[a-z0-9-]+$";
function parseServiceAccount(raw) {
  if (!raw || !String(raw).trim()) return { error: "FIREBASE_KEY не задан" };
  let s = String(raw).trim(), obj; const tryJson = t => { try { return JSON.parse(t); } catch (e) { return undefined; } };
  obj = tryJson(s); if (obj === undefined && /^'.*'$/s.test(s)) obj = tryJson(s.slice(1, -1));
  if (obj === undefined && !s.startsWith("{")) { const d = Buffer.from(s, "base64").toString("utf8").trim(); if (d.startsWith("{")) obj = tryJson(d); }
  if (typeof obj === "string") obj = tryJson(obj.trim());
  if (!obj || typeof obj !== "object") return { error: "FIREBASE_KEY не является корректным JSON (или base64 от JSON)" };
  const missing = ["type", "project_id", "private_key", "client_email"].filter(k => typeof obj[k] !== "string" || !obj[k]); if (missing.length) return { error: "в FIREBASE_KEY нет полей: " + missing.join(", ") };
  if (obj.type !== "service_account") return { error: "FIREBASE_KEY: type должен быть service_account" };
  if (obj.private_key.includes("\\n")) obj.private_key = obj.private_key.replace(/\\n/g, "\n");
  if (!obj.private_key.includes("BEGIN PRIVATE KEY")) return { error: "FIREBASE_KEY: private_key повреждён" };
  return { account: obj };
}
function checkProject(id, env) {
  const exp = String(id || "").trim(); if (!exp) return "FIREBASE_PROJECT_ID не задан: проект Firebase указывается явно (например hidden-dinox-video-staging)";
  let re; try { re = new RegExp(String((env && env.VIDEO_STUDIO_ALLOWED_PROJECT_PATTERN) || DEFAULT_PROJECT_PATTERN)); } catch (e) { return "VIDEO_STUDIO_ALLOWED_PROJECT_PATTERN не является корректным выражением"; }
  return re.test(exp) ? null : "проект «" + exp + "» не разрешён для Video Studio (ожидается имя вида hidden-dinox-video-…; шаблон можно изменить переменной VIDEO_STUDIO_ALLOWED_PROJECT_PATTERN)";
}
function initFirebase({ admin, env = process.env, log = console, testMode = false }) {
  try {
    if (testMode) { if (String(env.VIDEO_STUDIO_TEST_MODE || "") !== "1") return { db: null, reason: "тестовый режим без VIDEO_STUDIO_TEST_MODE=1 запрещён" }; admin.initializeApp({ projectId: env.GCLOUD_PROJECT || "demo-hd-video" }); return { db: admin.firestore(), projectId: env.GCLOUD_PROJECT || "demo-hd-video", test: true }; }
    const bad = ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "GOOGLE_APPLICATION_CREDENTIALS"].find(k => env[k]); if (bad) { const reason = bad + " задан: Video Studio принимает только ключ из FIREBASE_KEY нового проекта"; log.error("❌ Firebase отключён: " + reason); return { db: null, reason }; }
    const pe = checkProject(env.FIREBASE_PROJECT_ID, env); if (pe) { log.error("❌ Firebase отключён: " + pe); return { db: null, reason: pe }; }
    const { account, error } = parseServiceAccount(env.FIREBASE_KEY); if (error) { log.error("❌ Firebase отключён: " + error); return { db: null, reason: error }; }
    const expected = String(env.FIREBASE_PROJECT_ID).trim();
    if (account.project_id !== expected) { const reason = `FIREBASE_KEY относится к проекту «${account.project_id}», ожидается «${expected}»`; log.error("❌ Firebase отключён: " + reason); return { db: null, reason }; }
    admin.initializeApp({ credential: admin.credential.cert(account), projectId: expected });
    const got = admin.app().options && admin.app().options.projectId; if (got && got !== expected) { const reason = "после инициализации projectId=" + got + ", ожидается " + expected; log.error("❌ Firebase отключён: " + reason); return { db: null, reason }; }
    log.log && log.log("🔥 Firebase подключён: " + expected); return { db: admin.firestore(), projectId: expected };
  } catch (e) { const reason = String(e && e.message || e).replace(/-----BEGIN[\s\S]*?END PRIVATE KEY-----/g, "[ключ скрыт]").slice(0, 200); log.error("❌ Firebase отключён: " + reason); return { db: null, reason }; }
}
/* Публичная конфигурация веб-приложения Firebase: берётся из переменной окружения и ОБЯЗАНА относиться к тому же проекту, что и сервер */
function webConfig(env) {
  let c; try { c = JSON.parse(String(env.FIREBASE_WEB_CONFIG || "")); } catch (e) { return { error: "FIREBASE_WEB_CONFIG не задан или не является JSON" }; }
  const need = ["apiKey", "authDomain", "projectId", "appId"].filter(k => typeof c[k] !== "string" || !c[k]); if (need.length) return { error: "в FIREBASE_WEB_CONFIG нет полей: " + need.join(", ") };
  const pe = checkProject(c.projectId, env); if (pe) return { error: "FIREBASE_WEB_CONFIG: " + pe };
  if (env.FIREBASE_PROJECT_ID && c.projectId !== String(env.FIREBASE_PROJECT_ID).trim()) return { error: "FIREBASE_WEB_CONFIG.projectId «" + c.projectId + "» не совпадает с FIREBASE_PROJECT_ID" };
  const pub = {}; for (const k of ["apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId", "measurementId"]) if (typeof c[k] === "string" && c[k]) pub[k] = c[k]; return { config: pub };
}
module.exports = { initFirebase, parseServiceAccount, checkProject, webConfig, DEFAULT_PROJECT_PATTERN };
