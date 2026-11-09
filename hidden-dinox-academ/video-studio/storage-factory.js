"use strict";
/* Выбор хранилища Video Studio по VIDEO_STUDIO_STORAGE: r2 (Cloudflare R2) или gcs (Firebase Storage, по умолчанию для обратной совместимости).
   Если выбран r2, тихого перехода на Firebase Storage НЕТ: при ошибке настройки возвращается «сломанное» хранилище, каждая операция которого
   даёт понятную диагностику (её видно на странице Video Studio и в логах), а сервер остаётся рабочим. */
const { StorageConfigError } = require("./errors"), { createR2Storage } = require("./storage-r2"), { gcsVideoStorage } = require("./storage-adapter");
function brokenStorage(kind, err) {
  const fail = async () => { throw err; }, base = { kind, broken: true, multipart: kind === "r2", bucketName: "", error: err, check: fail, corsConfig: () => [] };
  return new Proxy(base, { get: (t, k) => (k in t ? t[k] : (typeof k === "string" && k !== "then" ? fail : undefined)) });
}
function createStorage({ env = process.env, admin, log = console, sdk } = {}) {
  const kind = String(env.VIDEO_STUDIO_STORAGE || "gcs").trim().toLowerCase();
  if (kind === "r2") {
    try { return createR2Storage({ env, sdk, log }); }
    catch (e) { if (e instanceof StorageConfigError) { log.error && log.error("⚠️ Video Studio: хранилище R2 не настроено — " + e.message); return brokenStorage("r2", e); } throw e; }
  }
  if (kind === "gcs" || kind === "firebase") {
    if (!admin || !admin.storage) return brokenStorage("gcs", new StorageConfigError("Firebase Storage недоступен (нет подключения Firebase Admin).", "STORAGE_CONFIG"));
    const bucketName = String(env.VIDEO_STUDIO_BUCKET || env.FIREBASE_STORAGE_BUCKET || "ai-boost-10540.firebasestorage.app").trim(), st = gcsVideoStorage({ bucket: admin.storage().bucket(bucketName) }); st.bucketName = bucketName; return st;
  }
  const err = new StorageConfigError("Неизвестное значение VIDEO_STUDIO_STORAGE=«" + kind.slice(0, 20) + "». Допустимо: r2 или gcs.", "STORAGE_CONFIG", ["VIDEO_STUDIO_STORAGE"]);
  log.error && log.error("⚠️ Video Studio: " + err.message); return brokenStorage(kind, err);
}
module.exports = { createStorage, brokenStorage };
