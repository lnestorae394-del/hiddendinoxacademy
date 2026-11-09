"use strict";
/* Единый тип ошибок обработки: code — машинный код, retryable — имеет ли смысл повторить задание */
class StudioError extends Error { constructor(code, message, retryable = false, extra) { super(message); this.code = code; this.retryable = retryable; this.extra = extra; } }
/* Ошибка настройки хранилища (нет переменных, неверный адрес, не установлен AWS SDK): сообщение — готовая диагностика для администратора, без секретов */
class StorageConfigError extends Error { constructor(message, code = "STORAGE_CONFIG", missing = []) { super(message); this.code = code; this.missing = missing; } }
/* Из любой ошибки хранилища (AWS SDK, сеть, Google) — понятная причина без секретов: { status, code, message } */
function storageProblem(e, bucket = "") {
  if (e instanceof StorageConfigError) return { status: 503, code: e.code, message: e.message };
  const name = String((e && (e.name || e.Code)) || ""), http = e && e.$metadata && e.$metadata.httpStatusCode, net = String((e && (e.code || (e.cause && e.cause.code))) || ""), msg = String((e && e.message) || "");
  if (/InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|InvalidToken|Unauthorized|Forbidden|CredentialsProvider/i.test(name) || http === 401 || http === 403)
    return { status: 503, code: "STORAGE_AUTH", message: "Хранилище отклонило ключи доступа: проверьте R2_ACCESS_KEY_ID и R2_SECRET_ACCESS_KEY и права токена (Object Read & Write для бакета «" + bucket + "»)." };
  if (/NoSuchBucket/i.test(name)) return { status: 503, code: "STORAGE_BUCKET", message: "Бакет «" + bucket + "» не найден: проверьте R2_BUCKET и что токен выдан именно для этого бакета." };
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|UND_ERR|TimeoutError|NetworkingError|fetch failed|getaddrinfo/i.test(name + " " + net + " " + msg))
    return { status: 503, code: "STORAGE_NETWORK", message: "Нет соединения с хранилищем: проверьте R2_ENDPOINT (вид https://<account_id>.r2.cloudflarestorage.com, без имени бакета)." };
  return { status: 503, code: "STORAGE_UNAVAILABLE", message: "Хранилище временно недоступно (" + (name || http || "ошибка") + ")." };
}
/* Убирает значения секретов из текста (для логов и сообщений) */
function redact(text, env) { let s = String(text); for (const k of ["R2_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID", "TELEGRAM_BOT_TOKEN", "GROQ_API_KEY", "ANTHROPIC_API_KEY"]) { const v = String((env && env[k]) || ""); if (v.length >= 6) s = s.split(v).join("***"); } return s; }
module.exports = { StudioError, StorageConfigError, storageProblem, redact };
