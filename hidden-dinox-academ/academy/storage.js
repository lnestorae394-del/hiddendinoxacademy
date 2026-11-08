"use strict";
/* Хранилище файлов медиа-библиотеки. Firebase Storage (через Admin SDK) — в production;
   в памяти — только для тестов. В Firestore хранятся лишь метаданные (коллекция media). */
const TYPES = {
  "image/png":  { kind: "image", max: 8 << 20, sig: b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  "image/jpeg": { kind: "image", max: 8 << 20, sig: b => b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  "image/webp": { kind: "image", max: 8 << 20, sig: b => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" },
  "image/gif":  { kind: "image", max: 8 << 20, sig: b => b.length > 6 && b.toString("latin1", 0, 4) === "GIF8" },
  "application/pdf": { kind: "pdf", max: 20 << 20, sig: b => b.length > 5 && b.toString("latin1", 0, 5) === "%PDF-" }
};
// SVG, HTML и исполняемые форматы не принимаются: их можно использовать для XSS
function checkUpload(contentType, buf) {
  const t = TYPES[String(contentType || "").split(";")[0].trim().toLowerCase()];
  if (!t) return { error: "UNSUPPORTED_TYPE", message: "Допустимы PNG, JPEG, WEBP, GIF и PDF. Видео — ссылкой (YouTube, Vimeo и т. п.)" };
  if (!buf || !buf.length) return { error: "EMPTY", message: "Пустой файл" };
  if (buf.length > t.max) return { error: "TOO_LARGE", message: `Файл больше ${Math.round(t.max / 1048576)} МБ` };
  if (!t.sig(buf)) return { error: "BAD_SIGNATURE", message: "Содержимое файла не соответствует его типу" };
  return { kind: t.kind };
}

/* Понятная причина ошибки Firebase Storage (без секретов) — для админки, диагностики и логов Render */
function describeStorageError(e, bucketName) {
  const code = e && (e.code || (e.response && e.response.status)); const msg = String((e && e.message) || "");
  if (code === 402 || /billing|blaze|spark pricing|no longer supports Firebase projects/i.test(msg)) return { code: "BILLING_REQUIRED", hint: `Firebase Storage недоступен на бесплатном тарифе Spark: для бакета «${bucketName}» проекту нужен тариф Blaze (Firebase Console → Upgrade). Решение о тарифе принимает владелец проекта` };
  if (code === 404 || /bucket does not exist|not ?found|notFound/i.test(msg)) return { code: "BUCKET_NOT_FOUND", hint: `Бакет «${bucketName}» ещё не создан в проекте. Имя указано верно (оно из веб-конфигурации Firebase), но сам Storage не включён: Firebase Console → Build → Storage → Get started. С 30.10.2024 создание бакета требует тарифа Blaze (есть бесплатная квота в регионах US-CENTRAL1/US-EAST1/US-WEST1). Другое имя бакета задаётся переменной FIREBASE_STORAGE_BUCKET` };
  if (code === 403 || code === 401 || /permission|forbidden|unauthori|denied/i.test(msg)) return { code: "NO_PERMISSION", hint: "Сервисному аккаунту из FIREBASE_KEY не хватает прав на Firebase Storage (нужна роль Storage Object Admin)" };
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|network/i.test(msg)) return { code: "NETWORK", hint: "Сервер не смог связаться с Firebase Storage — повторите позже" };
  return { code: "STORAGE_ERROR", hint: "Ошибка Firebase Storage: " + msg.slice(0, 160) };
}
function firebaseStorage(admin, bucketName) {
  let bucket = null;
  try { bucket = admin.storage().bucket(bucketName); } catch (e) { bucket = null; }
  return {
    available: !!bucket, bucketName,
    /* Реальная проверка доступности бакета (создание объекта bucket ничего не проверяет) */
    async check() {
      if (!bucket) return { ok: false, code: "NOT_CONFIGURED", hint: "Firebase Storage не инициализирован" };
      try { const [exists] = await bucket.exists(); return exists ? { ok: true, bucket: bucketName } : { ok: false, bucket: bucketName, ...describeStorageError({ code: 404 }, bucketName) }; }
      catch (e) { return { ok: false, bucket: bucketName, ...describeStorageError(e, bucketName) }; }
    },
    async save(path, buf, contentType) { await bucket.file(path).save(buf, { contentType, resumable: false, metadata: { cacheControl: "public, max-age=86400" } }); },
    async read(path) { const [b] = await bucket.file(path).download(); return b; },
    async remove(path) { await bucket.file(path).delete({ ignoreNotFound: true }); }
  };
}
function memoryStorage() {
  const m = new Map();
  return { available: true, bucketName: "memory", files: m, async check() { return { ok: true, bucket: "memory" }; }, async save(p, b) { m.set(p, Buffer.from(b)); }, async read(p) { if (!m.has(p)) throw new Error("not found"); return m.get(p); }, async remove(p) { m.delete(p); } };
}
module.exports = { checkUpload, firebaseStorage, memoryStorage, describeStorageError, TYPES };
