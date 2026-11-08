"use strict";
/* Адаптеры хранилища видео. Сервер НЕ принимает видео сам: выдаёт защищённую сессию загрузки (возобновляемую) прямо в Firebase Storage и короткоживущие ссылки.
   gcsVideoStorage — настоящий бакет; localVideoStorage — каталог на диске (тесты сквозной обработки); memoryVideoStorage — только метаданные (тесты API). */
const crypto = require("crypto"), fs = require("fs"), path = require("path");
function memoryVideoStorage() {
  const objects = new Map(), deleted = [], sessions = [];
  return {
    kind: "memory", objects, sessions, deleted,
    put(p, { size, contentType = "video/mp4", head = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]) }) { objects.set(p, { size, contentType, head }); },
    async createResumableSession({ path: p, contentType, size, origin }) { this.sessions.push({ path: p, contentType, size, origin }); return { url: "memory://upload/" + p + "?s=" + crypto.randomBytes(6).toString("hex") }; },
    async cancelSession(url) { this.sessions.push({ cancelled: url }); },
    async stat(p) { const o = objects.get(p); return o ? { size: o.size, contentType: o.contentType } : null; },
    async readHead(p, n) { const o = objects.get(p); return o ? o.head.subarray(0, n) : null; },
    async signedReadUrl(p, { ttlSec, filename }) { return "memory://read/" + p + "?ttl=" + ttlSec + (filename ? "&dl=" + encodeURIComponent(filename) : ""); },
    async remove(p) { deleted.push(p); objects.delete(p); },
    async removePrefix(prefix) { for (const k of [...objects.keys()]) if (k.startsWith(prefix)) { deleted.push(k); objects.delete(k); } },
    async readBuffer(p) { const o = objects.get(p); if (!o || !o.data) throw new Error("not found"); return o.data; },
    async writeBuffer(p, buf, contentType = "application/octet-stream") { objects.set(p, { size: buf.length, contentType, head: buf.subarray(0, 16), data: buf }); },
    async setCors(origins) { this.cors = origins; return { ok: true }; }
  };
}
/* Файлы на диске: root/<путь объекта>. Нужен для проверки всего конвейера настоящим FFmpeg без обращения к облаку. */
function localVideoStorage(root) {
  const sessions = [];
  const full = p => { const f = path.join(root, p); if (!f.startsWith(path.resolve(root))) throw new Error("bad path"); return f; };
  return {
    kind: "local", root, sessions, deleted: [],
    put(p, localFile) { fs.mkdirSync(path.dirname(full(p)), { recursive: true }); fs.copyFileSync(localFile, full(p)); },
    async createResumableSession({ path: p, contentType, size, origin }) { sessions.push({ path: p, contentType, size, origin }); return { url: "local://upload/" + p }; },
    async cancelSession() {},
    async stat(p) { try { const s = fs.statSync(full(p)); return { size: s.size, contentType: "application/octet-stream" }; } catch (e) { return null; } },
    async readHead(p, n) { try { const fd = fs.openSync(full(p), "r"), b = Buffer.alloc(n); const k = fs.readSync(fd, b, 0, n, 0); fs.closeSync(fd); return b.subarray(0, k); } catch (e) { return null; } },
    async signedReadUrl(p, { ttlSec, filename }) { return "local://read/" + p + "?ttl=" + ttlSec + (filename ? "&dl=" + encodeURIComponent(filename) : ""); },
    async remove(p) { this.deleted.push(p); try { fs.unlinkSync(full(p)); } catch (e) { /* уже нет */ } },
    async removePrefix(prefix) { this.deleted.push(prefix); fs.rmSync(full(prefix), { recursive: true, force: true }); },
    async download(p, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(full(p), dst); },
    async upload(src, p) { fs.mkdirSync(path.dirname(full(p)), { recursive: true }); fs.copyFileSync(src, full(p)); },
    async readBuffer(p) { return fs.readFileSync(full(p)); },
    async writeBuffer(p, buf) { fs.mkdirSync(path.dirname(full(p)), { recursive: true }); fs.writeFileSync(full(p), buf); },
    async setCors(origins) { this.cors = origins; return { ok: true }; }
  };
}
function gcsVideoStorage({ bucket, now = () => Date.now() }) {
  const notFound = e => e && (e.code === 404 || /No such object|Not Found/i.test(String(e.message)));
  return {
    kind: "gcs",
    async createResumableSession({ path: p, contentType, origin }) { const [url] = await bucket.file(p).createResumableUpload({ metadata: { contentType }, origin, validation: false }); return { url }; },
    async cancelSession(url) { try { await fetch(url, { method: "DELETE", headers: { "Content-Length": "0" } }); } catch (e) { /* сессия и так истечёт */ } },
    async stat(p) { try { const [m] = await bucket.file(p).getMetadata(); return { size: Number(m.size), contentType: m.contentType, generation: m.generation }; } catch (e) { if (notFound(e)) return null; throw e; } },
    async readHead(p, n) { return new Promise((resolve, reject) => { const chunks = []; bucket.file(p).createReadStream({ start: 0, end: n - 1 }).on("data", c => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks))).on("error", e => (notFound(e) ? resolve(null) : reject(e))); }); },
    async signedReadUrl(p, { ttlSec, filename, contentType }) {
      const [url] = await bucket.file(p).getSignedUrl({ version: "v4", action: "read", expires: now() + ttlSec * 1000, ...(filename ? { responseDisposition: "attachment; filename*=UTF-8''" + encodeURIComponent(filename) } : {}), ...(contentType ? { responseType: contentType } : {}) }); return url;
    },
    async remove(p) { await bucket.file(p).delete({ ignoreNotFound: true }); },
    async removePrefix(prefix) { await bucket.deleteFiles({ prefix }); },
    async download(p, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); await bucket.file(p).download({ destination: dst }); },
    async upload(src, p, contentType) { await bucket.upload(src, { destination: p, metadata: { contentType: contentType || "application/octet-stream" }, resumable: fs.statSync(src).size > 5 * 1024 * 1024 }); },
    async readBuffer(p) { const [b] = await bucket.file(p).download(); return b; },
    async writeBuffer(p, buf, contentType) { await bucket.file(p).save(buf, { contentType: contentType || "application/json", resumable: false }); },
    async setCors(origins) { await bucket.setMetadata({ cors: [{ origin: origins, method: ["PUT", "GET", "HEAD", "OPTIONS"], responseHeader: ["Content-Type", "Content-Range", "Range", "x-goog-resumable"], maxAgeSeconds: 3600 }] }); return { ok: true }; }
  };
}
/* Магические байты: у MP4/MOV на смещении 4 стоит атом ftyp (у старых MOV — moov/mdat/wide/free/skip) */
function looksLikeIsoVideo(head) { if (!head || head.length < 12) return false; return ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(head.subarray(4, 8).toString("latin1")); }
module.exports = { memoryVideoStorage, localVideoStorage, gcsVideoStorage, looksLikeIsoVideo };
