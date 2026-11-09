"use strict";
/* HIDDEN DINOX VIDEO STUDIO — подключение к Academy. Storage выбирается через VIDEO_STUDIO_STORAGE=r2|firebase. Firebase Auth и Firestore остаются обязательными.
   Для R2 задаются R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID и R2_SECRET_ACCESS_KEY. VIDEO_STUDIO_RUNNER=0 отключает исполнителя в этом экземпляре. */
const { mountVideoStudioApi } = require("./api"), { gcsVideoStorage, r2VideoStorage } = require("./storage-adapter"), { Runner } = require("./runner");
function attachVideoStudio(app, express, { db, verifyIdToken, admin, env = process.env, log = console }) {
  if (String(env.VIDEO_STUDIO_ENABLED || "") !== "1") return null;
  if (!db || !verifyIdToken || !admin) { log.warn && log.warn("⚠️ Video Studio: Firebase не подключён — модуль не включён"); return null; }
  const storageMode = String(env.VIDEO_STUDIO_STORAGE || (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ENDPOINT && env.R2_BUCKET ? "r2" : "firebase")).toLowerCase();
  let storage, bucketName;
  if (storageMode === "r2") {
    try { storage = r2VideoStorage({ env }); bucketName = storage.bucket; }
    catch (e) { log.error && log.error("⚠️ Video Studio R2 config:", e.message); return null; }
  } else {
    bucketName = String(env.VIDEO_STUDIO_BUCKET || env.FIREBASE_STORAGE_BUCKET || "ai-boost-10540.firebasestorage.app").trim();
    storage = gcsVideoStorage({ bucket: admin.storage().bucket(bucketName) });
  }
  const runner = String(env.VIDEO_STUDIO_RUNNER || "1") === "0" ? null : new Runner({ db, storage, env, log });
  const api = mountVideoStudioApi(app, express, { db, verifyIdToken, storage, runner, env, log }); api.runner = runner;
  if (runner) runner.start().catch(e => log.error && log.error("⚠️ Video Studio: исполнитель не запущен:", e && e.message));
  const missing = []; if (!String(env.GROQ_API_KEY || "").trim()) missing.push("GROQ_API_KEY"); if (!String(env.VIDEO_STUDIO_ANTHROPIC_API_KEY || env.STUDIO_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || "").trim()) missing.push("ANTHROPIC_API_KEY");
  if (!String(env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN || "").trim()) missing.push("TELEGRAM_BOT_TOKEN"); if (missing.length) log.warn && log.warn("⚠️ Video Studio: не заданы переменные окружения: " + missing.join(", ") + " (страница Video Studio → Настройки → Диагностика покажет, что именно не готово)");
  log.log && log.log("✅ Video Studio включена (хранилище " + storage.kind + ": " + bucketName + (runner ? ", обработка в этом экземпляре" : ", без исполнителя") + ")"); return api;
}
module.exports = { attachVideoStudio };
