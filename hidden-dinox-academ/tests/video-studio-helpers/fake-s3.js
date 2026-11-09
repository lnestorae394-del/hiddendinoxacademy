"use strict";
/* Поддельный S3/R2 для тестов адаптера: имитирует AWS SDK v3 (классы команд, S3Client.send, getSignedUrl) и правила S3 Multipart Upload:
   части ≥5 МиБ (кроме последней), по возрастанию, ETag должен совпасть, все части кроме последней одного размера (требование R2), не более 10 000 частей.
   ВАЖНО: это подделка на уровне интерфейса SDK. Она НЕ доказывает, что реальный R2 примет запросы. */
const { Readable } = require("stream"), crypto = require("crypto"), MiB = 1048576;
const err = (name, status, msg) => Object.assign(new Error(msg || name), { name, $metadata: { httpStatusCode: status } });
const md5 = b => crypto.createHash("md5").update(b).digest("hex");
function makeFakeS3({ bucket = "hidden-dinox-videos", accessKeyId = "AKIATESTKEY0001", secretAccessKey = "SECRETTESTKEYVALUE0001", minPart = 5 * MiB, withTransform = true } = {}) {
  const st = { bucket, objects: new Map(), uploads: new Map(), cors: null, lifecycle: null, signed: [], calls: [], config: null, networkDown: false, failDeleteKey: null, minPart };
  const names = ["HeadBucket", "HeadObject", "GetObject", "PutObject", "DeleteObject", "DeleteObjects", "ListObjectsV2", "CreateMultipartUpload", "UploadPart", "ListParts", "CompleteMultipartUpload", "AbortMultipartUpload", "ListMultipartUploads", "PutBucketCors", "PutBucketLifecycleConfiguration"];
  class Cmd { constructor(input) { this.input = input; } }
  const sdk = {}; for (const n of names) { sdk[n + "Command"] = class extends Cmd {}; Object.defineProperty(sdk[n + "Command"], "name", { value: n + "Command" }); }
  const bodyOf = b => { const r = Readable.from([b]); if (withTransform) r.transformToByteArray = async () => new Uint8Array(b); return r; };
  const toBuf = async body => { if (Buffer.isBuffer(body)) return body; if (typeof body === "string") return Buffer.from(body); const c = []; for await (const x of body) c.push(Buffer.from(x)); return Buffer.concat(c); };
  sdk.S3Client = class { constructor(cfg) { st.config = cfg; this.config = cfg;
    this.send = async cmd => {
      const n = cmd.constructor.name.replace(/Command$/, ""), i = cmd.input || {}; st.calls.push(n);
      if (st.networkDown) throw Object.assign(new Error("getaddrinfo ENOTFOUND fake-r2.invalid"), { code: "ENOTFOUND" });
      const cr = cfg.credentials || {}; if (cr.accessKeyId !== accessKeyId) throw err("InvalidAccessKeyId", 403, "The AWS Access Key Id you provided does not exist"); if (cr.secretAccessKey !== secretAccessKey) throw err("SignatureDoesNotMatch", 403, "signature mismatch");
      if (i.Bucket !== st.bucket) throw err("NoSuchBucket", 404, "The specified bucket does not exist");
      const need = (k) => { const o = st.objects.get(k); if (!o) throw err("NoSuchKey", 404, "The specified key does not exist."); return o; };
      switch (n) {
        case "HeadBucket": return {};
        case "HeadObject": { const o = st.objects.get(i.Key); if (!o) throw err("NotFound", 404); return { ContentLength: o.body.length, ContentType: o.type, ETag: '"' + md5(o.body) + '"' }; }
        case "GetObject": { const o = need(i.Key); let b = o.body; if (i.Range) { const m = /^bytes=(\d+)-(\d+)$/.exec(i.Range); if (!m) throw err("InvalidRange", 416); b = b.subarray(+m[1], +m[2] + 1); } return { Body: bodyOf(b), ContentLength: b.length, ContentType: o.type }; }
        case "PutObject": { const b = await toBuf(i.Body); if (i.ContentLength != null && i.ContentLength !== b.length) throw err("IncompleteBody", 400); st.objects.set(i.Key, { body: b, type: i.ContentType }); return { ETag: '"' + md5(b) + '"' }; }
        case "DeleteObject": st.objects.delete(i.Key); return {};
        case "DeleteObjects": { const errors = []; for (const o of i.Delete.Objects) { if (o.Key === st.failDeleteKey) errors.push({ Key: o.Key, Code: "AccessDenied" }); else st.objects.delete(o.Key); } return errors.length ? { Errors: errors } : {}; }
        case "ListObjectsV2": { const keys = [...st.objects.keys()].filter(k => k.startsWith(i.Prefix || "") && (!i.ContinuationToken || k > i.ContinuationToken)).sort(), page = keys.slice(0, 1000); return { Contents: page.map(Key => ({ Key, Size: st.objects.get(Key).body.length })), IsTruncated: keys.length > 1000, NextContinuationToken: page[page.length - 1] }; }   /* токен — последний ключ, как у настоящего S3: удаление во время листинга безопасно */
        case "CreateMultipartUpload": { const id = "up_" + crypto.randomBytes(5).toString("hex"); st.uploads.set(id, { key: i.Key, type: i.ContentType, parts: new Map(), initiated: new Date() }); return { UploadId: id }; }
        case "ListParts": { const u = st.uploads.get(i.UploadId); if (!u || u.key !== i.Key) throw err("NoSuchUpload", 404); const all = [...u.parts.keys()].sort((a, b) => a - b).filter(x => x > (i.PartNumberMarker || 0)), page = all.slice(0, i.MaxParts || 1000);
          return { Parts: page.map(x => ({ PartNumber: x, ETag: '"' + u.parts.get(x).etag + '"', Size: u.parts.get(x).body.length })), IsTruncated: all.length > page.length, NextPartNumberMarker: page[page.length - 1] }; }
        case "CompleteMultipartUpload": {
          const u = st.uploads.get(i.UploadId); if (!u || u.key !== i.Key) throw err("NoSuchUpload", 404); const ps = i.MultipartUpload.Parts; if (!ps.length || ps.length > 10000) throw err("MalformedXML", 400);
          let total = 0; const bufs = [];
          ps.forEach((x, idx) => { if (idx && x.PartNumber <= ps[idx - 1].PartNumber) throw err("InvalidPartOrder", 400); const h = u.parts.get(x.PartNumber); if (!h || h.etag !== String(x.ETag).replace(/"/g, "")) throw err("InvalidPart", 400, "One or more of the specified parts could not be found");
            if (idx < ps.length - 1) { if (h.body.length < st.minPart) throw err("EntityTooSmall", 400); if (h.body.length !== u.parts.get(ps[0].PartNumber).body.length) throw err("InvalidPart", 400, "All non-trailing parts must have the same length"); }
            total += h.body.length; bufs.push(h.body); });
          st.objects.set(u.key, { body: Buffer.concat(bufs), type: u.type }); st.uploads.delete(i.UploadId); return { ETag: '"' + md5(Buffer.concat([Buffer.from("x")])) + '-' + ps.length + '"' };
        }
        case "AbortMultipartUpload": { if (!st.uploads.has(i.UploadId)) throw err("NoSuchUpload", 404); st.uploads.delete(i.UploadId); return {}; }
        case "ListMultipartUploads": return { Uploads: [...st.uploads.entries()].filter(([, u]) => u.key.startsWith(i.Prefix || "")).map(([id, u]) => ({ Key: u.key, UploadId: id, Initiated: u.initiated })), IsTruncated: false };
        case "PutBucketCors": if (st.denyBucketConfig) throw err("AccessDenied", 403, "Access Denied"); st.cors = i.CORSConfiguration; return {};
        case "PutBucketLifecycleConfiguration": if (st.denyBucketConfig) throw err("AccessDenied", 403, "Access Denied"); st.lifecycle = i.LifecycleConfiguration; return {};
        default: throw err("NotImplemented", 501, n);
      }
    }; } };
  sdk.getSignedUrl = async (client, cmd, o) => {
    if (!(o.expiresIn > 0 && o.expiresIn <= 604800)) throw new Error("Signature version 4 presigned URLs must have an expiration date less than one week in the future");
    const i = cmd.input, n = cmd.constructor.name.replace(/Command$/, ""), q = new URLSearchParams({ "X-Amz-Expires": String(o.expiresIn), "X-Amz-Signature": "fakesig" });
    if (n === "UploadPart") { q.set("uploadId", i.UploadId); q.set("partNumber", String(i.PartNumber)); } st.signed.push({ n, input: i, expiresIn: o.expiresIn });
    return "https://" + (client.config.endpoint ? new URL(client.config.endpoint).host : "r2.invalid") + "/" + i.Bucket + "/" + i.Key + "?" + q;
  };
  /* Имитация браузера: PUT части по подписанной ссылке → ETag */
  st.putPart = (uploadId, n, buf) => { const u = st.uploads.get(uploadId); if (!u) throw err("NoSuchUpload", 404); const etag = md5(buf); u.parts.set(n, { body: buf, etag }); return etag; };
  return { sdk, state: st, creds: { accessKeyId, secretAccessKey }, MiB };
}
module.exports = { makeFakeS3, MiB };
