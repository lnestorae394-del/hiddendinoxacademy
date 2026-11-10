"use strict";
/* Защита ключей хранилища на границе адаптера (аудит): любой ключ обязан лежать внутри video-studio/, без «..», скрытых сегментов, обратных слэшей и нулевых байтов;
   удаление по префиксу — только целого проекта (video-studio/<uid>/<проект>/). Защищает и R2/GCS, и локальный диск от выхода за пределы своих файлов. */
const KEY = /^video-studio\/[A-Za-z0-9_][A-Za-z0-9_.\-]*(\/[A-Za-z0-9_][A-Za-z0-9_.\-]*)*$/, PREFIX = /^video-studio\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,64}\/$/;
const bad = m => Object.assign(new Error(m), { name: "InvalidKey", code: "INVALID_KEY" });
function assertKey(k) { if (typeof k !== "string" || k.length > 512 || !KEY.test(k) || k.includes("..")) throw bad("Недопустимый ключ хранилища"); return k; }
function assertPrefix(p) { if (typeof p !== "string" || !PREFIX.test(p)) throw bad("Недопустимый префикс: удалять можно только целый проект"); return p; }
const CHECK = {
  stat: a => assertKey(a[0]), readHead: a => assertKey(a[0]), signedReadUrl: a => assertKey(a[0]), remove: a => assertKey(a[0]), download: a => assertKey(a[0]), upload: a => assertKey(a[1]), readBuffer: a => assertKey(a[0]), writeBuffer: a => assertKey(a[0]),
  startMultipart: a => assertKey(a[0] && a[0].path), presignPart: a => assertKey(a[0]), listParts: a => assertKey(a[0]), completeMultipart: a => assertKey(a[0]), abortMultipart: a => assertKey(a[0]),
  createResumableSession: a => assertKey(a[0] && a[0].path), removePrefix: a => assertPrefix(a[0])
};
function guardStorage(storage) {
  if (!storage || storage.__vsGuarded) return storage;
  return new Proxy(storage, { get(t, k) { if (k === "__vsGuarded") return true; const v = t[k]; if (typeof v !== "function" || !Object.prototype.hasOwnProperty.call(CHECK, k)) return v; return async function (...a) { CHECK[k](a); return v.apply(t, a); }; } });   // всегда Promise, как у самого адаптера
}
module.exports = { assertKey, assertPrefix, guardStorage };
