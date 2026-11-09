"use strict";
/* Единый тип ошибок обработки: code — машинный код, retryable — имеет ли смысл повторить задание */
class StudioError extends Error { constructor(code, message, retryable = false, extra) { super(message); this.code = code; this.retryable = retryable; this.extra = extra; } }
/* Ошибка настройки хранилища (нет переменных, неверный адрес, не установлен AWS SDK): сообщение — готовая диагностика для администратора, без секретов */
class StorageConfigError extends Error { constructor(message, code = "STORAGE_CONFIG", missing = []) { super(message); this.code = code; this.missing = missing; } }
/* Из любой ошибки хранилища (AWS SDK, сеть, Google) — понятная причина БЕЗ секретов: { status, code, message, detail }.
   detail — технические подробности для диагностики (HTTP-статус, имя ошибки, id запроса, результат независимой проверки адреса). */
const httpOf = e => (e && ((e.$metadata && e.$metadata.httpStatusCode) || (e.$response && e.$response.statusCode) || e.statusCode)) || null;
function probeText(p) {
  if (!p) return ""; if (p.error) return " Проверка адреса без ключей: адрес недоступен (" + p.error + ").";
  if (p.status === 404) return " Проверка адреса без ключей: бакет по этому адресу не найден (проверьте ID аккаунта в R2_ENDPOINT и имя R2_BUCKET).";
  if (p.status === 401 || p.status === 403) return " Проверка адреса без ключей: бакет существует и требует ключи — значит, адрес и бакет указаны верно, а проблема в ключах или правах токена.";
  return " Проверка адреса без ключей: ответ HTTP " + p.status + (p.code ? " " + p.code : "") + ".";
}
function storageProblem(e, bucket = "") {
  if (e instanceof StorageConfigError) return { status: 503, code: e.code, message: e.message, detail: { missing: e.missing || [] } };
  const name = String((e && (e.name || e.Code)) || ""), http = httpOf(e), net = String((e && (e.code || (e.cause && e.cause.code))) || ""), msg = String((e && e.message) || ""), op = e && e.vsOp, probe = (e && e.vsProbe) || null;
  const detail = { http, name: name || null, request_id: (e && e.$metadata && (e.$metadata.requestId || e.$metadata.cfId)) || null, probe }, pr = probeText(probe), at = http ? " (HTTP " + http + ")" : "";
  if (/InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|InvalidToken|Unauthorized|Forbidden|CredentialsProvider/i.test(name) || http === 401 || http === 403)
    return { status: 503, code: "STORAGE_AUTH", detail, message: "Хранилище отклонило ключи доступа" + at + ": проверьте R2_ACCESS_KEY_ID и R2_SECRET_ACCESS_KEY и права токена (Object Read & Write для бакета «" + bucket + "»)." + pr };
  if (/NoSuchBucket/i.test(name) || (op === "bucket" && http === 404)) return { status: 503, code: "STORAGE_BUCKET", detail, message: "Бакет «" + bucket + "» не найден: проверьте R2_BUCKET и что токен выдан именно для этого бакета." + pr };
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|UND_ERR|TimeoutError|NetworkingError|fetch failed|getaddrinfo/i.test(name + " " + net + " " + msg))
    return { status: 503, code: "STORAGE_NETWORK", detail, message: "Нет соединения с хранилищем: проверьте R2_ENDPOINT (вид https://<account_id>.r2.cloudflarestorage.com, без имени бакета)." + pr };
  if (op === "bucket" && (http === 400 || /^Unknown/i.test(name)))
    return { status: 503, code: "STORAGE_REQUEST", detail, message: "R2 отклонил запрос проверки" + at + ". Чаще всего причина — неверный R2_ENDPOINT (нужен только адрес вида https://<ID_аккаунта>.r2.cloudflarestorage.com, без имени бакета ни в пути, ни в начале адреса) или R2_REGION (должен быть auto)." + pr };
  const extra = msg && !/^(Unknown|UnknownError)$/i.test(msg) ? ": " + msg.replace(/\s+/g, " ").slice(0, 140) : "";
  return { status: 503, code: http && http < 500 ? "STORAGE_ERROR" : "STORAGE_UNAVAILABLE", detail, message: (http && http < 500 ? "Хранилище вернуло ошибку" : "Хранилище временно недоступно") + " (" + (http ? "HTTP " + http + ", " : "") + (name || "Unknown") + ")" + extra + "." + pr };
}
/* Убирает значения секретов из текста (для логов и сообщений) */
function redact(text, env) { let s = String(text); for (const k of ["R2_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID", "TELEGRAM_BOT_TOKEN", "VIDEO_STUDIO_TELEGRAM_BOT_TOKEN", "VIDEO_STUDIO_TELEGRAM_WEBHOOK_SECRET", "GROQ_API_KEY", "ANTHROPIC_API_KEY"]) { const v = String((env && env[k]) || ""); if (v.length >= 6) s = s.split(v).join("***"); } return s; }
module.exports = { StudioError, StorageConfigError, storageProblem, redact };
