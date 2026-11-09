"use strict";
/* Подключение Hidden Dinox Telegram-бота к серверу (Telegraf). Включается только при BOT_ENABLED=1.
   Режим webhook (рекомендуется на Render): BOT_WEBHOOK_URL=https://<домен>/telegram/webhook и BOT_WEBHOOK_SECRET (≥ 24 символов).
   Без BOT_WEBHOOK_URL — polling (для локальной разработки; не запускайте polling в двух местах с одним токеном).
   Токен — только из переменной окружения TELEGRAM_BOT_TOKEN (или BOT_TOKEN); в коде его нет. */
const { createBotCore, config } = require("./core");
const WEBHOOK_PATH = "/telegram/webhook";
const ALLOWED = ["message", "callback_query", "my_chat_member"];
function startBot({ app, db, env = process.env, log = console, Telegraf = null } = {}) {
  if (String(env.BOT_ENABLED || "") !== "1") { log.log && log.log("ℹ️ Telegram-бот выключен (BOT_ENABLED≠1)"); return null; }
  const cfg = config(env);
  if (!cfg.token) { log.warn && log.warn("⚠️ Telegram-бот: не задан TELEGRAM_BOT_TOKEN — бот не запущен"); return null; }
  if (!cfg.admins.size) log.warn && log.warn("⚠️ Telegram-бот: не задан ADMIN_TELEGRAM_ID — команды публикаций недоступны никому");
  if (!db) { log.warn && log.warn("⚠️ Telegram-бот: Firebase не подключён — бот не запущен (пользователи и публикации хранятся в Firestore)"); return null; }
  let T = Telegraf; if (!T) { try { T = require("telegraf").Telegraf; } catch (e) { log.warn && log.warn("⚠️ Telegram-бот: пакет telegraf не установлен (npm ci) — бот не запущен"); return null; } }
  const bot = new T(cfg.token, { handlerTimeout: 9e5 });
  const api = { call: (method, payload) => bot.telegram.callApi(method, payload) };
  const core = createBotCore({ db, api, cfg, log });
  bot.use(async ctx => { try { await core.handleUpdate(ctx.update); } catch (e) { log.error && log.error("bot: ошибка обработки:", (e && e.response && e.response.description) || (e && e.message) || e); } });
  const webhookUrl = String(env.BOT_WEBHOOK_URL || "").trim(), secret = String(env.BOT_WEBHOOK_SECRET || "").trim();
  (async () => {
    // Постоянная синяя кнопка Menu Button внизу чата, рядом с полем ввода.
    try {
      await bot.telegram.callApi("setChatMenuButton", { menu_button: {
        type: "web_app", text: "Открыть академию", web_app: { url: cfg.webappUrl }
      } });
      log.log && log.log("✅ Telegram-бот: Menu Button настроена");
    } catch (e) {
      log.warn && log.warn("⚠️ Telegram-бот: не удалось настроить Menu Button:", (e && e.response && e.response.description) || (e && e.message));
    }
    if (webhookUrl) {
      if (secret.length < 24 || !/^[A-Za-z0-9_-]+$/.test(secret)) { log.warn && log.warn("⚠️ Telegram-бот: BOT_WEBHOOK_SECRET — от 24 символов (A–Z, a–z, 0–9, _ и -); webhook не включён"); return; }
      app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH, { secretToken: secret }));
      await bot.telegram.setWebhook(webhookUrl, { secret_token: secret, allowed_updates: ALLOWED });
      log.log && log.log("✅ Telegram-бот: webhook " + WEBHOOK_PATH);
    } else { await bot.launch({ allowedUpdates: ALLOWED }); log.log && log.log("✅ Telegram-бот: polling"); }
    await core.resumeJobs();
  })().catch(e => log.error && log.error("❌ Telegram-бот не запустился:", (e && e.response && e.response.description) || (e && e.message) || e));
  return { bot, core, path: WEBHOOK_PATH };
}
module.exports = { startBot, WEBHOOK_PATH };
