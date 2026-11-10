"use strict";
/* Отдельный Telegram-бот Video Studio. Всё управляется переменными окружения сервера; токен и секрет вебхука никогда не попадают во Firestore, браузер и журнал.
   Пока VIDEO_STUDIO_TELEGRAM_ENABLED≠1 интеграция выключена: интерфейс показывает понятное сообщение, остальные функции работают. */
const crypto = require("crypto"), TG = require("./telegram");
const flag = env => String(env.VIDEO_STUDIO_TELEGRAM_ENABLED || "") === "1", secret = env => String(env.VIDEO_STUDIO_TELEGRAM_WEBHOOK_SECRET || "").trim();
const enabled = env => flag(env) && !!TG.token(env), ownerChat = env => TG.defaultChat(env), username = env => String(env.VIDEO_STUDIO_TELEGRAM_BOT_USERNAME || "").replace(/^@/, "").trim();
const status = env => ({ enabled: enabled(env), flag: flag(env), token_set: !!String(env.VIDEO_STUDIO_TELEGRAM_BOT_TOKEN || "").trim(), webhook_secret_set: secret(env).length >= 16, owner_chat_set: !!ownerChat(env), bot_username: username(env) || null, webhook_path: "/api/video-studio/telegram/webhook",
  problem: !flag(env) ? "Интеграция выключена: в Render не задано VIDEO_STUDIO_TELEGRAM_ENABLED=1" : !String(env.VIDEO_STUDIO_TELEGRAM_BOT_TOKEN || "").trim() ? "Не задан VIDEO_STUDIO_TELEGRAM_BOT_TOKEN (токен отдельного бота Video Studio)" : null });
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const secretOk = (env, provided) => secret(env).length >= 16 && typeof provided === "string" && safeEqual(provided, secret(env));
module.exports = { enabled, status, ownerChat, username, secretOk, secret };
