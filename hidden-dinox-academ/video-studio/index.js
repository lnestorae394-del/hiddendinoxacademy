"use strict";
/* HIDDEN DINOX VIDEO STUDIO — сборка модуля и подключение к веб-серверу. Включается ТОЛЬКО переменной VIDEO_STUDIO_ENABLED=1; без неё маршруты и исполнитель очереди не создаются,
   и сайт работает так же, как раньше. Видео хранится в Firebase Storage проекта (VIDEO_STUDIO_BUCKET / FIREBASE_STORAGE_BUCKET), путь video-studio/{uid}/{проект}/…
   VIDEO_STUDIO_RUNNER=0 отключает исполнитель в этом экземпляре (если обработку делает другой экземпляр сервера). */
const { guardStorage } = require("./keys"), { mountVideoStudioApi } = require("./api"), { createStorage } = require("./storage-factory"), { Runner } = require("./runner");
/* Сборка модуля без привязки к веб-серверу: используется и подключением в Express (attachVideoStudio), и самостоятельным сервером (standalone.js) */
function buildVideoStudio({ db: rawDb, verifyIdToken, admin, env: baseEnv = process.env, log = console }) {
  /* Экономия чтений Firestore (бесплатный план: 50 000/сутки). Значения по умолчанию для работы; любое можно переопределить переменной Render (0 — выключить).
     Настройки 5 минут (меняются только через API — кэш сбрасывается сразу), пользователь 15 с, снимки коллекций 10 с, монитор/список заданий 3 с (сбрасываются при ЛЮБОМ изменении через API и при смене состояния задания), простой исполнителя до 60 с. */
  const env = Object.assign({ VIDEO_STUDIO_SETTINGS_CACHE_MS: "300000", VIDEO_STUDIO_AUTH_CACHE_MS: "15000", VIDEO_STUDIO_SNAP_CACHE_MS: "10000", VIDEO_STUDIO_MONITOR_CACHE_MS: "3000", VIDEO_STUDIO_IDLE_POLL_SEC: "60" }, baseEnv);
  const meter = require("./read-meter"), db = meter.wrap(rawDb); meter.startLog(log);
  if (!db || !verifyIdToken || !admin) { log.warn && log.warn("⚠️ Video Studio: Firebase не подключён — модуль не включён"); return null; }
  const storage = guardStorage(createStorage({ env, admin, log }));                 // VIDEO_STUDIO_STORAGE=r2 → Cloudflare R2 (без тихого перехода на Firebase Storage)
  const runner = String(env.VIDEO_STUDIO_RUNNER || "1") === "0" ? null : new Runner({ db, storage, env, log });
  return { env, db, storage, runner, verifyIdToken, log, start() {
    /* SIGTERM (деплой/перезапуск Render): активное задание останавливается вместе с FFmpeg и сразу возвращается в очередь без траты попытки; SIGKILL (нехватка памяти) перехватить нельзя — тогда в журнале не будет строки об остановке */
    if (runner && !global.__vsSigterm) { global.__vsSigterm = true; process.once("SIGTERM", () => { runner.shutdown("SIGTERM").catch(() => {}).finally(() => setTimeout(() => process.exit(0), 200)); }); }
    if (runner) runner.start().catch(e => log.error && log.error("⚠️ Video Studio: исполнитель не запущен:", e && e.message));
    const missing = []; if (!String(env.GROQ_API_KEY || "").trim()) missing.push("GROQ_API_KEY"); if (!String(env.VIDEO_STUDIO_ANTHROPIC_API_KEY || env.STUDIO_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || "").trim()) missing.push("ANTHROPIC_API_KEY");
    if (String(env.VIDEO_STUDIO_TELEGRAM_ENABLED || "") === "1" && !String(env.VIDEO_STUDIO_TELEGRAM_BOT_TOKEN || "").trim()) missing.push("VIDEO_STUDIO_TELEGRAM_BOT_TOKEN"); if (missing.length) log.warn && log.warn("⚠️ Video Studio: не заданы переменные окружения: " + missing.join(", ") + " (Настройки → Диагностика покажет, что именно не готово)");
    log.log && log.log("✅ Video Studio включена (хранилище " + storage.kind + (storage.bucketName ? ", бакет " + storage.bucketName : "") + (storage.broken ? " — НЕ НАСТРОЕНО, см. сообщение выше" : "") + (runner ? ", обработка в этом экземпляре" : ", без исполнителя") + ")");
  } };
}
function attachVideoStudio(app, express, deps) {
  if (String((deps.env || process.env).VIDEO_STUDIO_ENABLED || "") !== "1") return null;
  const b = buildVideoStudio(deps); if (!b) return null;
  const api = mountVideoStudioApi(app, express, { db: b.db, verifyIdToken: b.verifyIdToken, storage: b.storage, runner: b.runner, env: b.env, log: b.log }); api.runner = b.runner; b.start(); return api;
}
module.exports = { attachVideoStudio, buildVideoStudio };
