"use strict";
/* Адаптеры хранилища видео. Сервер НЕ принимает видео сам: выдаёт защищённую сессию загрузки (возобновляемую) прямо в Firebase Storage и короткоживущие ссылки.
   gcsVideoStorage — настоящий бакет; localVideoStorage — каталог на диске (тесты сквозной обработки); memoryVideoStorage — только метаданные (тесты API). */
const crypto = require("crypto"), fs = require("fs"), path = require("path");
function memoryVideoStorage({ multipart = false } = {}) {
  const objects = new Map(), deleted = [], sessions = [], uploads = new Map();
  const api = {
    kind: "memory", multipart, bucketName: "memory", uploads, objects, sessions, deleted, async check() { return true; },
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
  if (multipart) {                         // эмуляция S3 Multipart Upload по правилам S3/R2: части ≥5 МиБ (кроме последней), одинаковый размер, ETag = md5
    const { planParts } = require("./multipart"), md5 = b => crypto.createHash("md5").update(b).digest("hex");
    Object.assign(api, {
      async startMultipart({ path: p, contentType, size }) { const plan = planParts(size), id = "mp_" + crypto.randomBytes(6).toString("hex"); uploads.set(id, { path: p, contentType, size, plan, parts: new Map(), initiated: Date.now() }); return { uploadId: id, partSize: plan.partSize, totalParts: plan.totalParts }; },
      async presignPart(p, id, n, ttlSec) { if (!uploads.has(id)) throw Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" }); return "memory://part/" + p + "?uploadId=" + id + "&partNumber=" + n + "&ttl=" + ttlSec; },
      putPart(p, id, n, buf) { const u = uploads.get(id); if (!u || u.path !== p) throw Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" }); const etag = md5(buf); u.parts.set(n, { size: buf.length, etag, head: buf.subarray(0, 16) }); return etag; },
      async listParts(p, id) { const u = uploads.get(id); if (!u || u.path !== p) throw Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" }); return [...u.parts.entries()].sort((a, b) => a[0] - b[0]).map(([n, x]) => ({ part_number: n, etag: x.etag, size: x.size })); },
      async completeMultipart(p, id, parts) {
        const u = uploads.get(id); if (!u || u.path !== p) throw Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" }); let total = 0;
        parts.forEach((x, i) => { const h = u.parts.get(x.part_number); if (!h || h.etag !== String(x.etag).replace(/"/g, "")) throw Object.assign(new Error("InvalidPart"), { name: "InvalidPart" }); if (i && x.part_number <= parts[i - 1].part_number) throw Object.assign(new Error("InvalidPartOrder"), { name: "InvalidPartOrder" }); if (i < parts.length - 1 && h.size < 5 * 1048576) throw Object.assign(new Error("EntityTooSmall"), { name: "EntityTooSmall" }); total += h.size; });
        objects.set(p, { size: total, contentType: u.contentType, head: u.parts.get(parts[0].part_number).head }); uploads.delete(id);
      },
      async abortMultipart(p, id) { const had = uploads.has(id); uploads.delete(id); return had; },
      async abortStale(prefix, olderThanMs, nowMs = Date.now()) { let n = 0; for (const [id, u] of [...uploads]) if (u.path.startsWith(prefix) && nowMs - u.initiated > olderThanMs) { uploads.delete(id); n++; } return n; }
    });
  }
  return api;
}
/* Файлы на диске: root/<путь объекта>. Нужен для проверки всего конвейера настоящим FFmpeg без обращения к облаку. */
function localVideoStorage(root) {
  const sessions = [];
  const full = p => { const f = path.join(root, p); if (!f.startsWith(path.resolve(root))) throw new Error("bad path"); return f; };
  return {
    kind: "local", root, sessions, multipart: false, bucketName: "local", async check() { return true; }, deleted: [],
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
    kind: "gcs", multipart: false,
    async check() { const [ok] = await bucket.exists(); if (!ok) throw Object.assign(new Error("Bucket not found"), { name: "NoSuchBucket" }); return true; },
    corsConfig: origins => [{ origin: origins, method: ["PUT", "GET", "HEAD", "OPTIONS"], responseHeader: ["Content-Type", "Content-Range", "Range", "x-goog-resumable"], maxAgeSeconds: 3600 }],
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
