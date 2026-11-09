"use strict";
/* HIDDEN DINOX VIDEO STUDIO — подключение к Academy. Включается ТОЛЬКО переменной VIDEO_STUDIO_ENABLED=1; без неё маршруты и исполнитель очереди не создаются,
   и сайт работает так же, как раньше. Видео хранится в Firebase Storage проекта (VIDEO_STUDIO_BUCKET / FIREBASE_STORAGE_BUCKET), путь video-studio/{uid}/{проект}/…
   VIDEO_STUDIO_RUNNER=0 отключает исполнитель в этом экземпляре (если обработку делает другой экземпляр сервера). */
const { mountVideoStudioApi } = require("./api"), { createStorage } = require("./storage-factory"), { Runner } = require("./runner");
function attachVideoStudio(app, express, { db, verifyIdToken, admin, env = process.env, log = console }) {
  if (String(env.VIDEO_STUDIO_ENABLED || "") !== "1") return null;
  if (!db || !verifyIdToken || !admin) { log.warn && log.warn("⚠️ Video Studio: Firebase не подключён — модуль не включён"); return null; }
  const storage = createStorage({ env, admin, log });                 // VIDEO_STUDIO_STORAGE=r2 → Cloudflare R2 (без тихого перехода на Firebase Storage)
  const runner = String(env.VIDEO_STUDIO_RUNNER || "1") === "0" ? null : new Runner({ db, storage, env, log });
  const api = mountVideoStudioApi(app, express, { db, verifyIdToken, storage, runner, env, log }); api.runner = runner;
  if (runner) runner.start().catch(e => log.error && log.error("⚠️ Video Studio: исполнитель не запущен:", e && e.message));
  const missing = []; if (!String(env.GROQ_API_KEY || "").trim()) missing.push("GROQ_API_KEY"); if (!String(env.VIDEO_STUDIO_ANTHROPIC_API_KEY || env.STUDIO_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || "").trim()) missing.push("ANTHROPIC_API_KEY");
  if (!String(env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN || "").trim()) missing.push("TELEGRAM_BOT_TOKEN"); if (missing.length) log.warn && log.warn("⚠️ Video Studio: не заданы переменные окружения: " + missing.join(", ") + " (страница Video Studio → Настройки → Диагностика покажет, что именно не готово)");
  log.log && log.log("✅ Video Studio включена (хранилище " + storage.kind + (storage.bucketName ? ", бакет " + storage.bucketName : "") + (storage.broken ? " — НЕ НАСТРОЕНО, см. сообщение выше" : "") + (runner ? ", обработка в этом экземпляре" : ", без исполнителя") + ")"); return api;
}
module.exports = { attachVideoStudio };
