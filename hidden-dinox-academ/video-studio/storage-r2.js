"use strict";
/* Хранилище Video Studio в Cloudflare R2 (S3-совместимый API, официальный AWS SDK v3).
   Видео в обход Express: браузер грузит файл ЧАСТЯМИ прямо в R2 по подписанным ссылкам (S3 Multipart Upload), сервер только создаёт загрузку,
   выдаёт ссылки на части, проверяет итог (ListParts) и завершает (CompleteMultipartUpload). Бакет остаётся приватным: чтение — только по подписанным ссылкам с ограниченным сроком. */
const fs = require("fs"), { pipeline } = require("stream/promises");
const { StorageConfigError } = require("./errors"), { planParts, MiB } = require("./multipart");
const sdkVersion = () => { try { return require("@aws-sdk/client-s3/package.json").version; } catch (e) { return null; } };
const strip = e => String(e || "").replace(/^"+|"+$/g, "");
function r2Config(env) {
  const g = n => String((env && env[n]) || "").trim(), cfg = { endpoint: g("R2_ENDPOINT"), accessKeyId: g("R2_ACCESS_KEY_ID"), secretAccessKey: g("R2_SECRET_ACCESS_KEY"), bucket: g("R2_BUCKET"), region: g("R2_REGION") || "auto" };
  const missing = [["R2_ENDPOINT", cfg.endpoint], ["R2_ACCESS_KEY_ID", cfg.accessKeyId], ["R2_SECRET_ACCESS_KEY", cfg.secretAccessKey], ["R2_BUCKET", cfg.bucket]].filter(x => !x[1]).map(x => x[0]);
  if (missing.length) throw new StorageConfigError("VIDEO_STUDIO_STORAGE=r2, но в Render не заданы переменные: " + missing.join(", ") + ". Добавьте их в Environment и сделайте Deploy.", "STORAGE_CONFIG", missing);
  let u; try { u = new URL(cfg.endpoint); } catch (e) { throw new StorageConfigError("R2_ENDPOINT не похож на адрес: ожидается https://<account_id>.r2.cloudflarestorage.com", "STORAGE_CONFIG", ["R2_ENDPOINT"]); }
  if (u.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) throw new StorageConfigError("R2_ENDPOINT должен начинаться с https://", "STORAGE_CONFIG", ["R2_ENDPOINT"]);
  if (u.pathname && u.pathname !== "/") throw new StorageConfigError("R2_ENDPOINT должен быть без имени бакета и без пути: https://<account_id>.r2.cloudflarestorage.com (имя бакета задаётся в R2_BUCKET).", "STORAGE_CONFIG", ["R2_ENDPOINT"]);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(cfg.bucket)) throw new StorageConfigError("R2_BUCKET содержит недопустимое имя бакета (строчные буквы, цифры, дефис; 3–63 символа).", "STORAGE_CONFIG", ["R2_BUCKET"]);
  cfg.notes = [];
  if (u.hostname.toLowerCase().startsWith(cfg.bucket + ".")) { u.hostname = u.hostname.slice(cfg.bucket.length + 1); cfg.notes.push("Из R2_ENDPOINT автоматически убрано имя бакета в начале адреса: правильный адрес — " + u.origin + "."); }
  if (!/\.r2\.cloudflarestorage\.com$/i.test(u.hostname) && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) cfg.notes.push("Нестандартный адрес R2_ENDPOINT (ожидается …r2.cloudflarestorage.com).");
  cfg.endpoint = u.origin; return cfg;
}
function loadSdk() {
  try { return Object.assign({}, require("@aws-sdk/client-s3"), { getSignedUrl: require("@aws-sdk/s3-request-presigner").getSignedUrl }); }
  catch (e) { throw new StorageConfigError("Не установлены пакеты AWS SDK (@aws-sdk/client-s3, @aws-sdk/s3-request-presigner). В папке проекта выполните npm install, затем закоммитьте package.json и package-lock.json и сделайте Deploy.", "STORAGE_SDK"); }
}
async function bodyToBuffer(body) {
  if (!body) return Buffer.alloc(0); if (typeof body.transformToByteArray === "function") return Buffer.from(await body.transformToByteArray());
  const chunks = []; for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return Buffer.concat(chunks);
}
const isMissing = e => !!e && (/^(NotFound|NoSuchKey)$/.test(String(e.name || e.Code || "")) || (e.$metadata && e.$metadata.httpStatusCode === 404 && !/NoSuchBucket|NoSuchUpload/.test(String(e.name || e.Code || ""))));
function createR2Storage({ env = process.env, sdk, client, log = console, httpRequest = require("./http-util").httpRequest } = {}) {
  const cfg = r2Config(env); sdk = sdk || loadSdk(); const B = cfg.bucket;
  client = client || new sdk.S3Client({ region: cfg.region, endpoint: cfg.endpoint, forcePathStyle: true, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", maxAttempts: 3 });          // без «CRC32 по умолчанию»: иначе R2 отклоняет подписанные ссылки новых версий SDK
  const send = cmd => client.send(cmd), presign = (cmd, ttl) => sdk.getSignedUrl(client, cmd, { expiresIn: Math.max(60, Math.min(Math.floor(ttl) || 900, 604800)) });
  const corsRules = origins => [{ AllowedOrigins: origins, AllowedMethods: ["GET", "PUT", "HEAD"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"], MaxAgeSeconds: 3600 }];
  return {
    kind: "r2", multipart: true, bucketName: B, endpointHost: new URL(cfg.endpoint).host, region: cfg.region, notes: cfg.notes,
    /* Независимая проверка адреса БЕЗ ключей (обычный HTTP): отличает «бакета нет по этому адресу» от «бакет есть, но ключи не подходят» */
    async probe() {
      try { const r = await httpRequest(cfg.endpoint + "/" + B + "?list-type=2&max-keys=1", { method: "GET", timeoutMs: 8000 }), m = /<Code>([A-Za-z]+)<\/Code>/.exec(r.body ? r.body.toString("utf8") : ""); return { status: r.status, code: m ? m[1] : null }; }
      catch (e) { return { error: String((e && (e.code || e.name)) || "ошибка сети").slice(0, 40) }; }
    },
    /* Реальная проверка: авторизованный запрос списка объектов (работает с токеном Object Read & Write); запасной вариант — HeadBucket. При сбое — подробности и проверка адреса */
    async check() {
      try { await send(new sdk.ListObjectsV2Command({ Bucket: B, Prefix: "video-studio/", MaxKeys: 1 })); return true; }
      catch (e1) { try { await send(new sdk.HeadBucketCommand({ Bucket: B })); return true; } catch (e2) { /* оба запроса не прошли */ } e1.vsOp = "bucket"; try { e1.vsProbe = await this.probe(); } catch (e3) { /* без проверки адреса */ } throw e1; }
    },
    diagnose() { return { kind: "r2", bucket: B, endpoint_host: new URL(cfg.endpoint).host, region: cfg.region, sdk_version: sdkVersion(), path_style: true, notes: cfg.notes }; },
    async stat(p) { try { const r = await send(new sdk.HeadObjectCommand({ Bucket: B, Key: p })); return { size: Number(r.ContentLength), contentType: r.ContentType, etag: strip(r.ETag) }; } catch (e) { if (isMissing(e)) return null; throw e; } },
    async readHead(p, n) { try { const r = await send(new sdk.GetObjectCommand({ Bucket: B, Key: p, Range: "bytes=0-" + (n - 1) })); return (await bodyToBuffer(r.Body)).subarray(0, n); } catch (e) { if (isMissing(e) || /InvalidRange/i.test(String(e && e.name))) return null; throw e; } },
    async signedReadUrl(p, { ttlSec, filename, contentType } = {}) {
      return presign(new sdk.GetObjectCommand({ Bucket: B, Key: p, ...(filename ? { ResponseContentDisposition: "attachment; filename*=UTF-8''" + encodeURIComponent(filename) } : {}), ...(contentType ? { ResponseContentType: contentType } : {}) }), ttlSec);
    },
    async remove(p) { await send(new sdk.DeleteObjectCommand({ Bucket: B, Key: p })); },
    async removePrefix(prefix) {
      if (!/^video-studio\/.{3,}/.test(prefix)) throw new Error("Отказ: удаление по префиксу допускается только внутри video-studio/");
      let token, total = 0;
      do {
        const l = await send(new sdk.ListObjectsV2Command({ Bucket: B, Prefix: prefix, ContinuationToken: token })), keys = (l.Contents || []).map(o => ({ Key: o.Key }));
        for (let i = 0; i < keys.length; i += 1000) { const r = await send(new sdk.DeleteObjectsCommand({ Bucket: B, Delete: { Objects: keys.slice(i, i + 1000), Quiet: true } })); if (r && r.Errors && r.Errors.length) throw Object.assign(new Error("Не удалось удалить объекты: " + r.Errors[0].Code), { name: r.Errors[0].Code }); total += Math.min(1000, keys.length - i); }
        token = l.IsTruncated ? l.NextContinuationToken : undefined;
      } while (token); return total;
    },
    async download(p, dst) {
      fs.mkdirSync(require("path").dirname(dst), { recursive: true }); const r = await send(new sdk.GetObjectCommand({ Bucket: B, Key: p }));
      try { await pipeline(r.Body, fs.createWriteStream(dst)); } catch (e) { try { fs.unlinkSync(dst); } catch (e2) { /* нечего удалять */ } throw e; }
      if (r.ContentLength != null && fs.statSync(dst).size !== Number(r.ContentLength)) { try { fs.unlinkSync(dst); } catch (e) { /* уже нет */ } throw new Error("Файл скачан не полностью"); }
    },
    async upload(src, p, contentType) { const size = fs.statSync(src).size; await send(new sdk.PutObjectCommand({ Bucket: B, Key: p, Body: fs.createReadStream(src), ContentLength: size, ContentType: contentType || "application/octet-stream" })); },
    async readBuffer(p) { const r = await send(new sdk.GetObjectCommand({ Bucket: B, Key: p })); return bodyToBuffer(r.Body); },
    async writeBuffer(p, buf, contentType) { await send(new sdk.PutObjectCommand({ Bucket: B, Key: p, Body: buf, ContentLength: buf.length, ContentType: contentType || "application/json" })); },
    /* ---- S3 Multipart Upload ---- */
    async startMultipart({ path, contentType, size }) { const plan = planParts(size), r = await send(new sdk.CreateMultipartUploadCommand({ Bucket: B, Key: path, ContentType: contentType })); if (!r.UploadId) throw new Error("R2 не вернул UploadId"); return { uploadId: r.UploadId, partSize: plan.partSize, totalParts: plan.totalParts }; },
    async presignPart(path, uploadId, partNumber, ttlSec) { return presign(new sdk.UploadPartCommand({ Bucket: B, Key: path, UploadId: uploadId, PartNumber: partNumber }), ttlSec); },
    async listParts(path, uploadId) {
      const out = []; let marker;
      do { const r = await send(new sdk.ListPartsCommand({ Bucket: B, Key: path, UploadId: uploadId, MaxParts: 1000, PartNumberMarker: marker })); for (const x of r.Parts || []) out.push({ part_number: x.PartNumber, etag: strip(x.ETag), size: Number(x.Size) }); marker = r.IsTruncated ? r.NextPartNumberMarker : undefined; } while (marker);
      return out.sort((a, b) => a.part_number - b.part_number);
    },
    async completeMultipart(path, uploadId, parts) { await send(new sdk.CompleteMultipartUploadCommand({ Bucket: B, Key: path, UploadId: uploadId, MultipartUpload: { Parts: parts.map(x => ({ PartNumber: x.part_number, ETag: '"' + strip(x.etag) + '"' })) } })); },
    async abortMultipart(path, uploadId) { try { await send(new sdk.AbortMultipartUploadCommand({ Bucket: B, Key: path, UploadId: uploadId })); return true; } catch (e) { if (/NoSuchUpload/i.test(String(e && (e.name || e.Code))) || (e && e.$metadata && e.$metadata.httpStatusCode === 404)) return false; throw e; } },
    /* Страховка от «зависших» загрузок: прервать все незавершённые multipart-загрузки старше olderThanMs внутри video-studio/ */
    async abortStale(prefix, olderThanMs, nowMs = Date.now()) {
      let aborted = 0, keyMarker, idMarker, more = true;
      while (more) { const r = await send(new sdk.ListMultipartUploadsCommand({ Bucket: B, Prefix: prefix, KeyMarker: keyMarker, UploadIdMarker: idMarker, MaxUploads: 1000 }));
        for (const u of r.Uploads || []) if (u.Initiated && nowMs - new Date(u.Initiated).getTime() > olderThanMs) { if (await this.abortMultipart(u.Key, u.UploadId)) aborted++; }
        more = !!r.IsTruncated; keyMarker = r.NextKeyMarker; idMarker = r.NextUploadIdMarker; if (!keyMarker && !idMarker) more = false; }
      return aborted;
    },
    /* ---- настройка бакета (нужен токен с правом администрирования; иначе — вручную в панели Cloudflare) ---- */
    corsConfig: corsRules,
    async setCors(origins) { await send(new sdk.PutBucketCorsCommand({ Bucket: B, CORSConfiguration: { CORSRules: corsRules(origins) } })); return { ok: true }; },
    async setLifecycle({ retentionDays } = {}) {
      const rules = [{ ID: "abort-incomplete-multipart", Status: "Enabled", Filter: { Prefix: "" }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 } }];
      if (retentionDays > 0) rules.push({ ID: "expire-video-studio", Status: "Enabled", Filter: { Prefix: "video-studio/" }, Expiration: { Days: Math.floor(retentionDays) } });
      await send(new sdk.PutBucketLifecycleConfigurationCommand({ Bucket: B, LifecycleConfiguration: { Rules: rules } })); return { ok: true, rules: rules.length };
    }
  };
}
module.exports = { createR2Storage, r2Config, loadSdk, bodyToBuffer };
