"use strict";
/* Доставка готового MP4 в Telegram через Bot API (sendVideo). Токен — только из окружения (VIDEO_STUDIO_TELEGRAM_BOT_TOKEN — отдельный бот Video Studio).
   Успех фиксируется ТОЛЬКО когда Telegram подтвердил отправку (ok:true и message_id). Исходная запись не отправляется: передаётся файл, который выдали вы. */
const fs = require("fs");
const { StudioError } = require("./errors");
const LIMIT_BYTES = 49 * 1024 * 1024;                   // облачный Bot API принимает до 50 МБ
const limitBytes = env => (Number(env.VIDEO_STUDIO_TG_LIMIT_BYTES) > 0 ? Number(env.VIDEO_STUDIO_TG_LIMIT_BYTES) : LIMIT_BYTES);
const token = env => (String(env.VIDEO_STUDIO_TELEGRAM_ENABLED || "") === "1" ? String(env.VIDEO_STUDIO_TELEGRAM_BOT_TOKEN || "").trim() : "");   // токен бота Academy НЕ используется
const apiBase = env => String(env.TELEGRAM_API_BASE || "https://api.telegram.org");
const defaultChat = env => (String(env.VIDEO_STUDIO_TELEGRAM_OWNER_CHAT_ID || "").split(/[,\s]+/).filter(x => /^-?\d+$/.test(x))[0]) || "";
const validChat = c => /^-?\d{3,20}$/.test(String(c || "").trim()) || /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(String(c || "").trim());
/* Понятные русские сообщения вместо технических ответов Telegram */
function mapError(status, body) {
  const d = String((body && body.description) || ""), retryAfter = body && body.parameters && body.parameters.retry_after;
  if (status === 401) return { code: "TG_TOKEN", message: "Telegram не принял токен бота: проверьте VIDEO_STUDIO_TELEGRAM_BOT_TOKEN.", retryable: false };
  if (status === 429) return { code: "TG_RATE_LIMIT", message: "Telegram просит подождать " + (retryAfter || 10) + " с (лимит запросов).", retryable: true, retry_after: retryAfter || 10 };
  if (/can't initiate conversation|bot can't send messages to bots|have no rights/i.test(d)) return { code: "TG_NOT_STARTED", message: "Бот не может написать первым. Откройте бота в Telegram и нажмите Start, затем повторите.", retryable: false };
  if (/blocked by the user|user is deactivated/i.test(d)) return { code: "TG_BLOCKED", message: "Бот заблокирован этим пользователем или аккаунт удалён. Разблокируйте бота и нажмите Start.", retryable: false };
  if (/chat not found|PEER_ID_INVALID|chat_id is empty/i.test(d)) return { code: "TG_CHAT", message: "Чат не найден: проверьте Chat ID и убедитесь, что вы нажали Start у бота.", retryable: false };
  if (status === 413 || /too big|too large|file is too/i.test(d)) return { code: "TG_TOO_BIG", message: "Telegram не принимает файл такого размера (лимит бота 50 МБ).", retryable: false };
  if (status >= 500) return { code: "TG_UNAVAILABLE", message: "Telegram временно недоступен.", retryable: true };
  return { code: "TG_ERROR", message: "Telegram отклонил запрос: " + d.slice(0, 160), retryable: false };
}
async function call(env, method, params = {}, file) {
  const t = token(env); if (!t) throw new StudioError("TG_NO_TOKEN", "Интеграция Telegram выключена или не задан VIDEO_STUDIO_TELEGRAM_BOT_TOKEN.", false);
  let res;
  try {
    let body, headers = {};
    if (file) { const fd = new FormData(); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) fd.append(k, String(v)); fd.append(file.field, new Blob([fs.readFileSync(file.path)], { type: file.type || "video/mp4" }), file.filename || "clip.mp4"); body = fd; }
    else { body = JSON.stringify(params); headers["Content-Type"] = "application/json"; }
    res = await fetch(apiBase(env) + "/bot" + t + "/" + method, { method: "POST", headers, body, signal: AbortSignal.timeout(file ? 300000 : 30000) });
  } catch (e) { throw new StudioError("TG_NETWORK", "Нет соединения с Telegram.", true); }
  let j = null; try { j = await res.json(); } catch (e) { /* не JSON */ }
  if (!res.ok || !j || j.ok !== true) { const m = mapError(res.status, j); throw new StudioError(m.code, m.message, m.retryable, { retry_after: m.retry_after }); }
  return j.result;
}
const getMe = env => call(env, "getMe");
async function checkConnection(env, chatId) {
  const me = await getMe(env), out = { bot: { id: me.id, username: me.username, name: me.first_name }, chat_ok: false, link: me.username ? "https://t.me/" + me.username + "?start=video_studio" : null };
  if (!chatId) return Object.assign(out, { chat_error: "Chat ID не указан." });
  try { await call(env, "sendChatAction", { chat_id: chatId, action: "upload_video" }); out.chat_ok = true; } catch (e) { out.chat_error = e.message; out.chat_code = e.code; }
  return out;
}
const sendMessage = (env, chatId, text) => call(env, "sendMessage", { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true });
/* Отправка видео: загрузкой файла или повторно по file_id (без повторной загрузки). Возвращает {message_id, file_id} только после подтверждения Telegram. */
async function sendVideo(env, { chatId, filePath, fileId, caption, width, height, duration }) {
  if (!validChat(chatId)) throw new StudioError("TG_CHAT", "Некорректный Chat ID.", false);
  const params = { chat_id: chatId, caption: caption ? String(caption).slice(0, 1000) : undefined, supports_streaming: "true", width, height, duration };
  let r;
  if (fileId) r = await call(env, "sendVideo", Object.assign(params, { video: fileId }));
  else { const size = fs.statSync(filePath).size; if (size > limitBytes(env)) throw new StudioError("TG_TOO_BIG", "Файл " + (size / 1048576).toFixed(1) + " МБ больше лимита Telegram для ботов (" + Math.round(limitBytes(env) / 1048576) + " МБ).", false, { size });
    r = await call(env, "sendVideo", params, { field: "video", path: filePath, filename: "hidden-dinox-clip.mp4", type: "video/mp4" }); }
  const v = r.video || r.document || {}; if (!r.message_id) throw new StudioError("TG_NO_CONFIRM", "Telegram не подтвердил отправку (нет message_id).", true);
  return { message_id: r.message_id, file_id: v.file_id || null, file_unique_id: v.file_unique_id || null, size: v.file_size || null };
}
module.exports = { limitBytes, token, defaultChat, validChat, mapError, call, getMe, checkConnection, sendMessage, sendVideo, LIMIT_BYTES };
