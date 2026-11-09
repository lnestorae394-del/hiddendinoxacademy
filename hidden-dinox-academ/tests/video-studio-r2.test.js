"use strict";
/* Адаптер Cloudflare R2. Проверяется НАШ код поверх интерфейса AWS SDK v3 с поддельным S3 (правила multipart как у S3/R2).
   РЕАЛЬНЫЙ R2 и РЕАЛЬНЫЙ AWS SDK этими тестами НЕ проверяются: подключение к настоящему R2 нужно проверить отдельно (см. docs/VIDEO_STUDIO.md, раздел «Проверка R2»). */
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const { makeFakeS3, MiB } = require("./video-studio-helpers/fake-s3"), { createR2Storage, r2Config } = require("../video-studio/storage-r2"), { createStorage, brokenStorage } = require("../video-studio/storage-factory");
const { StorageConfigError, storageProblem, redact } = require("../video-studio/errors"), { planParts, expectedPartSize } = require("../video-studio/multipart");
const ENV = { R2_ENDPOINT: "https://abc123.r2.cloudflarestorage.com", R2_ACCESS_KEY_ID: "AKIATESTKEY0001", R2_SECRET_ACCESS_KEY: "SECRETTESTKEYVALUE0001", R2_BUCKET: "hidden-dinox-videos", R2_REGION: "auto", VIDEO_STUDIO_STORAGE: "r2" };
const quiet = { log() {}, warn() {}, error() {} };
const mk = (over = {}, fakeOpts = {}) => { const f = makeFakeS3(fakeOpts), st = createR2Storage({ env: Object.assign({}, ENV, over), sdk: f.sdk, log: quiet }); return Object.assign(f, { st }); };

test("конфигурация: недостающие переменные называются по именам (без значений), адрес и бакет проверяются", () => {
  const miss = Object.assign({}, ENV); delete miss.R2_BUCKET; delete miss.R2_SECRET_ACCESS_KEY;
  assert.throws(() => r2Config(miss), e => e instanceof StorageConfigError && e.code === "STORAGE_CONFIG" && /R2_SECRET_ACCESS_KEY, R2_BUCKET/.test(e.message) && !e.message.includes("AKIATESTKEY0001") && e.missing.length === 2);
  assert.throws(() => r2Config({}), e => /R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET/.test(e.message));
  assert.throws(() => r2Config(Object.assign({}, ENV, { R2_ENDPOINT: "https://abc123.r2.cloudflarestorage.com/hidden-dinox-videos" })), e => /без имени бакета/.test(e.message), "в адрес добавили бакет — частая ошибка");
  assert.throws(() => r2Config(Object.assign({}, ENV, { R2_ENDPOINT: "http://abc123.r2.cloudflarestorage.com" })), e => /https/.test(e.message)); assert.throws(() => r2Config(Object.assign({}, ENV, { R2_ENDPOINT: "не адрес" })), e => /адрес/.test(e.message));
  assert.throws(() => r2Config(Object.assign({}, ENV, { R2_BUCKET: "Bad Bucket!" })), e => /R2_BUCKET/.test(e.message));
  assert.equal(r2Config(Object.assign({}, ENV, { R2_ENDPOINT: "https://abc123.r2.cloudflarestorage.com/" })).endpoint, "https://abc123.r2.cloudflarestorage.com"); assert.equal(r2Config(Object.assign({}, ENV, { R2_REGION: "" })).region, "auto");
});
test("клиент S3 настроен для R2: адрес, регион auto, path-style, без контрольных сумм «по умолчанию»; секреты не попадают в публичные свойства", () => {
  const { st, state } = mk(); const c = state.config; assert.equal(c.endpoint, "https://abc123.r2.cloudflarestorage.com"); assert.equal(c.region, "auto"); assert.equal(c.forcePathStyle, true);
  assert.equal(c.requestChecksumCalculation, "WHEN_REQUIRED", "иначе R2 отклоняет подписанные ссылки на части"); assert.equal(c.responseChecksumValidation, "WHEN_REQUIRED"); assert.equal(st.kind, "r2"); assert.equal(st.multipart, true); assert.equal(st.bucketName, "hidden-dinox-videos");
  assert.ok(!JSON.stringify(Object.assign({}, st)).includes("SECRETTESTKEYVALUE0001"));
});
test("пакеты AWS SDK: если не установлены — понятная инструкция; если установлены — клиент создаётся без обращения к сети", () => {
  let installed = true; try { require.resolve("@aws-sdk/client-s3"); require.resolve("@aws-sdk/s3-request-presigner"); } catch (e) { installed = false; }
  if (installed) { const s = createR2Storage({ env: ENV, log: quiet }); assert.equal(s.kind, "r2"); }
  else assert.throws(() => createR2Storage({ env: ENV, log: quiet }), e => e instanceof StorageConfigError && e.code === "STORAGE_SDK" && /npm install/.test(e.message) && /package-lock\.json/.test(e.message));
});
test("проверка подключения (HeadBucket); верный бакет", async () => { const { st } = mk(); assert.equal(await st.check(), true); });
test("неверные ключи и неверный бакет дают понятные причины без секретов", async () => {
  const bad = mk({ R2_SECRET_ACCESS_KEY: "WRONGSECRETVALUE9999" }); await assert.rejects(bad.st.check(), e => { const p = storageProblem(e, "hidden-dinox-videos"); assert.equal(p.code, "STORAGE_AUTH"); assert.match(p.message, /R2_ACCESS_KEY_ID/); assert.ok(!p.message.includes("WRONGSECRETVALUE9999") && !p.message.includes("AKIATESTKEY0001")); return true; });
  const badKey = mk({ R2_ACCESS_KEY_ID: "AKIAWRONG000000" }); await assert.rejects(badKey.st.check(), e => storageProblem(e).code === "STORAGE_AUTH");
  const nb = mk({ R2_BUCKET: "no-such-bucket" }); await assert.rejects(nb.st.check(), e => { const p = storageProblem(e, "no-such-bucket"); return p.code === "STORAGE_BUCKET" && /no-such-bucket/.test(p.message) && /R2_BUCKET/.test(p.message); });
  const down = mk(); down.state.networkDown = true; await assert.rejects(down.st.check(), e => { const p = storageProblem(e); return p.code === "STORAGE_NETWORK" && /R2_ENDPOINT/.test(p.message); });
  assert.equal(storageProblem(Object.assign(new Error("x"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } })).code, "STORAGE_UNAVAILABLE");
  assert.equal(redact("ключ SECRETTESTKEYVALUE0001 и AKIATESTKEY0001", ENV), "ключ *** и ***");
});
test("объекты: запись и чтение буфера, метаданные, начало файла, отсутствующий файл, удаление", async () => {
  const { st } = mk(); await st.writeBuffer("video-studio/u/p/a.json", Buffer.from('{"a":1}'), "application/json"); assert.equal((await st.readBuffer("video-studio/u/p/a.json")).toString(), '{"a":1}');
  assert.deepEqual(await st.stat("video-studio/u/p/a.json").then(x => ({ size: x.size, contentType: x.contentType })), { size: 7, contentType: "application/json" });
  assert.equal((await st.readHead("video-studio/u/p/a.json", 3)).toString(), '{"a'); assert.equal(await st.stat("video-studio/u/p/none.mp4"), null); assert.equal(await st.readHead("video-studio/u/p/none.mp4", 8), null);
  await assert.rejects(st.readBuffer("video-studio/u/p/none.mp4")); await st.remove("video-studio/u/p/a.json"); assert.equal(await st.stat("video-studio/u/p/a.json"), null);
  const noTr = mk({}, { withTransform: false }); await noTr.st.writeBuffer("k", Buffer.from("abc")); assert.equal((await noTr.st.readBuffer("k")).toString(), "abc", "Body без transformToByteArray тоже читается");
});
test("файлы: загрузка с диска и скачивание; подписанные ссылки (срок, имя файла)", async () => {
  const { st, state } = mk(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r2t-")), src = path.join(tmp, "a.mp4"); fs.writeFileSync(src, Buffer.alloc(300000, 7));
  await st.upload(src, "video-studio/u/p/exports/a.mp4", "video/mp4"); assert.equal((await st.stat("video-studio/u/p/exports/a.mp4")).size, 300000); assert.equal(state.objects.get("video-studio/u/p/exports/a.mp4").type, "video/mp4");
  const dst = path.join(tmp, "d", "b.mp4"); await st.download("video-studio/u/p/exports/a.mp4", dst); assert.deepEqual(fs.readFileSync(dst), fs.readFileSync(src)); await assert.rejects(st.download("video-studio/u/p/none.mp4", path.join(tmp, "c.mp4"))); assert.ok(!fs.existsSync(path.join(tmp, "c.mp4")));
  const url = await st.signedReadUrl("video-studio/u/p/exports/a.mp4", { ttlSec: 900, filename: "клип 1.mp4", contentType: "video/mp4" }); assert.match(url, /^https:\/\/abc123\.r2\.cloudflarestorage\.com\/hidden-dinox-videos\/video-studio\/u\/p\/exports\/a\.mp4\?X-Amz-Expires=900/);
  const g = state.signed.at(-1); assert.equal(g.input.ResponseContentDisposition, "attachment; filename*=UTF-8''" + encodeURIComponent("клип 1.mp4")); assert.equal(g.input.ResponseContentType, "video/mp4");
  await st.signedReadUrl("k", { ttlSec: 99999999 }); assert.equal(state.signed.at(-1).expiresIn, 604800, "срок ограничен неделей, как требует S3"); await st.signedReadUrl("k", { ttlSec: 1 }); assert.equal(state.signed.at(-1).expiresIn, 60);
  fs.rmSync(tmp, { recursive: true, force: true });
});
test("удаление по префиксу: пачки по 1000, только внутри video-studio/, ошибки удаления не скрываются", async () => {
  const { st, state } = mk(); for (let i = 0; i < 2500; i++) state.objects.set("video-studio/u/p1/f" + i, { body: Buffer.from("x") }); state.objects.set("video-studio/u/p2/keep", { body: Buffer.from("x") }); state.objects.set("other/x", { body: Buffer.from("x") });
  assert.equal(await st.removePrefix("video-studio/u/p1/"), 2500); assert.equal([...state.objects.keys()].filter(k => k.startsWith("video-studio/u/p1/")).length, 0); assert.ok(state.objects.has("video-studio/u/p2/keep") && state.objects.has("other/x"));
  for (const bad of ["", "/", "video-studio/", "other/", "video-studio"]) await assert.rejects(st.removePrefix(bad), /video-studio/, "защита от удаления лишнего: «" + bad + "»");
  state.failDeleteKey = "video-studio/u/p3/a"; state.objects.set("video-studio/u/p3/a", { body: Buffer.from("x") }); await assert.rejects(st.removePrefix("video-studio/u/p3/"), e => e.name === "AccessDenied");
});
test("multipart: план частей (файл 5 ГБ — 320 частей по 16 МиБ), загрузка частей, проверка, завершение; результат — один файл", async () => {
  assert.deepEqual(planParts(5 * 1024 ** 3), { partSize: 16 * MiB, totalParts: 320 }); assert.deepEqual(planParts(1), { partSize: 16 * MiB, totalParts: 1 }); assert.ok(planParts(200 * 1024 ** 3).totalParts <= 9900); assert.throws(() => planParts(0));
  const { st, state } = mk(), size = 20 * MiB + 123, plan = planParts(size); assert.equal(plan.totalParts, 2); assert.equal(expectedPartSize(1, plan, size), 16 * MiB); assert.equal(expectedPartSize(2, plan, size), 4 * MiB + 123);
  const m = await st.startMultipart({ path: "video-studio/u/p/source/original.mp4", contentType: "video/mp4", size }); assert.equal(m.partSize, 16 * MiB); assert.equal(m.totalParts, 2);
  const u1 = await st.presignPart("video-studio/u/p/source/original.mp4", m.uploadId, 1, 3600); assert.match(u1, /uploadId=up_[0-9a-f]+&partNumber=1/); assert.equal(state.signed.at(-1).n, "UploadPart"); assert.equal(state.signed.at(-1).expiresIn, 3600);
  const file = Buffer.alloc(size, 9); file.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70], 0);                             // «ftyp» как у настоящего MP4
  const e1 = state.putPart(m.uploadId, 1, file.subarray(0, 16 * MiB)); assert.deepEqual(await st.listParts("video-studio/u/p/source/original.mp4", m.uploadId), [{ part_number: 1, etag: e1, size: 16 * MiB }]);
  const e2 = state.putPart(m.uploadId, 2, file.subarray(16 * MiB)); const parts = await st.listParts("video-studio/u/p/source/original.mp4", m.uploadId); assert.equal(parts.length, 2);
  await st.completeMultipart("video-studio/u/p/source/original.mp4", m.uploadId, parts); assert.equal((await st.stat("video-studio/u/p/source/original.mp4")).size, size); assert.equal(state.uploads.size, 0); assert.equal((await st.readHead("video-studio/u/p/source/original.mp4", 8)).toString("hex"), "0000001866747970");
  assert.deepEqual(state.calls.filter(c => ["CreateMultipartUpload", "CompleteMultipartUpload"].includes(c)), ["CreateMultipartUpload", "CompleteMultipartUpload"]);
});
test("multipart: листинг частей постранично; правила S3 (мелкая часть, порядок, чужой ETag, разный размер) отклоняются; повторное завершение невозможно", async () => {
  const small = mk({}, { minPart: 1 }), big = small.st; const m = await big.startMultipart({ path: "k", contentType: "video/mp4", size: 1100 * 1000 * 1000 }); for (let i = 1; i <= 1200; i++) small.state.putPart(m.uploadId, i, Buffer.from([i & 255]));
  const all = await big.listParts("k", m.uploadId); assert.equal(all.length, 1200, "страницы по 1000 склеены"); assert.deepEqual(all.map(x => x.part_number).slice(0, 3), [1, 2, 3]);
  const { st, state } = mk(), q = await st.startMultipart({ path: "k", contentType: "video/mp4", size: 40 * MiB });
  state.putPart(q.uploadId, 1, Buffer.alloc(1 * MiB)); state.putPart(q.uploadId, 2, Buffer.alloc(1 * MiB)); let ps = await st.listParts("k", q.uploadId);
  await assert.rejects(st.completeMultipart("k", q.uploadId, ps), e => e.name === "EntityTooSmall", "часть меньше 5 МиБ (не последняя)");
  state.putPart(q.uploadId, 1, Buffer.alloc(5 * MiB)); state.putPart(q.uploadId, 2, Buffer.alloc(6 * MiB)); state.putPart(q.uploadId, 3, Buffer.alloc(1 * MiB)); ps = await st.listParts("k", q.uploadId);
  await assert.rejects(st.completeMultipart("k", q.uploadId, ps), e => e.name === "InvalidPart", "R2: все части, кроме последней, одного размера");
  state.putPart(q.uploadId, 2, Buffer.alloc(5 * MiB)); ps = await st.listParts("k", q.uploadId); await assert.rejects(st.completeMultipart("k", q.uploadId, [ps[1], ps[0], ps[2]]), e => e.name === "InvalidPartOrder"); await assert.rejects(st.completeMultipart("k", q.uploadId, [{ part_number: 1, etag: "deadbeef" }, ps[1], ps[2]]), e => e.name === "InvalidPart");
  await st.completeMultipart("k", q.uploadId, ps); assert.equal((await st.stat("k")).size, 11 * MiB); await assert.rejects(st.completeMultipart("k", q.uploadId, ps), e => e.name === "NoSuchUpload", "повторное завершение отклоняется хранилищем");
});
test("отмена загрузки и страховочная чистка зависших загрузок", async () => {
  const { st, state } = mk(), a = await st.startMultipart({ path: "video-studio/u/p/source/a.mp4", contentType: "video/mp4", size: 30 * MiB }), b = await st.startMultipart({ path: "video-studio/u/p/source/b.mp4", contentType: "video/mp4", size: 30 * MiB }), o = await st.startMultipart({ path: "other/c.mp4", contentType: "video/mp4", size: 30 * MiB });
  assert.equal(await st.abortMultipart("video-studio/u/p/source/a.mp4", a.uploadId), true); assert.equal(await st.abortMultipart("video-studio/u/p/source/a.mp4", a.uploadId), false, "повторная отмена не ошибка"); assert.ok(!state.uploads.has(a.uploadId));
  state.uploads.get(b.uploadId).initiated = new Date(Date.now() - 5 * 86400000); assert.equal(await st.abortStale("video-studio/", 4 * 86400000), 1); assert.ok(!state.uploads.has(b.uploadId)); assert.ok(state.uploads.has(o.uploadId), "чужой префикс не тронут");
  assert.equal(await st.abortStale("video-studio/", 4 * 86400000), 0);
});
test("CORS и жизненный цикл: точный адрес (не *), методы GET/PUT/HEAD, заголовок ETag доступен браузеру; прерывание неоконченных загрузок", async () => {
  const { st, state } = mk(), origin = "https://hidden-dinox-video-staging.onrender.com"; await st.setCors([origin]); const r = state.cors.CORSRules[0];
  assert.deepEqual(r.AllowedOrigins, [origin]); assert.ok(!JSON.stringify(state.cors).includes('"*"') || r.AllowedHeaders[0] === "*", "звёздочка допустима только в заголовках"); assert.ok(!r.AllowedOrigins.includes("*"));
  assert.deepEqual(r.AllowedMethods.sort(), ["GET", "HEAD", "PUT"]); assert.ok(r.ExposeHeaders.includes("ETag"), "без ETag браузер не увидит ответ части"); assert.ok(r.MaxAgeSeconds >= 600);
  assert.deepEqual(st.corsConfig([origin])[0].AllowedOrigins, [origin]); await st.setLifecycle({}); assert.equal(state.lifecycle.Rules.length, 1); assert.equal(state.lifecycle.Rules[0].AbortIncompleteMultipartUpload.DaysAfterInitiation, 3);
  await st.setLifecycle({ retentionDays: 30 }); assert.equal(state.lifecycle.Rules.length, 2); assert.equal(state.lifecycle.Rules[1].Expiration.Days, 30); assert.equal(state.lifecycle.Rules[1].Filter.Prefix, "video-studio/");
});
test("выбор хранилища: r2 без настройки НЕ переключается на Firebase — каждая операция даёт диагностику; неизвестное значение; gcs по умолчанию", async () => {
  const fakeAdmin = { storage: () => { throw new Error("Firebase Storage не должен вызываться при VIDEO_STUDIO_STORAGE=r2"); } };
  const s = createStorage({ env: { VIDEO_STUDIO_STORAGE: "r2", R2_ENDPOINT: ENV.R2_ENDPOINT }, admin: fakeAdmin, log: quiet }); assert.equal(s.kind, "r2"); assert.equal(s.broken, true); assert.equal(s.multipart, true);
  for (const m of ["check", "stat", "startMultipart", "signedReadUrl", "readBuffer", "createResumableSession"]) await assert.rejects(s[m]("x"), e => e instanceof StorageConfigError && /R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET/.test(e.message), m);
  const ok = createStorage({ env: ENV, admin: fakeAdmin, log: quiet, sdk: makeFakeS3().sdk }); assert.equal(ok.kind, "r2"); assert.ok(!ok.broken);
  const unk = createStorage({ env: { VIDEO_STUDIO_STORAGE: "s3x" }, admin: fakeAdmin, log: quiet }); assert.equal(unk.broken, true); await assert.rejects(unk.check(), /VIDEO_STUDIO_STORAGE/);
  const gcs = createStorage({ env: {}, admin: { storage: () => ({ bucket: n => ({ name: n }) }) }, log: quiet }); assert.equal(gcs.kind, "gcs"); assert.equal(gcs.bucketName, "ai-boost-10540.firebasestorage.app");
  const logs = []; createStorage({ env: { VIDEO_STUDIO_STORAGE: "r2", R2_ACCESS_KEY_ID: "AKIASECRETKEY00001" }, admin: fakeAdmin, log: { error: m => logs.push(m) } }); assert.ok(logs.length === 1 && !logs[0].includes("AKIASECRETKEY00001"), "значения секретов в журнал не попадают");
});

/* ---- API + адаптер R2 (поддельный S3): сквозной путь загрузки и понятные ответы при ошибках настройки ---- */
const { FakeFirestore } = require("./video-studio-helpers/fake-firestore"), { fakeVerify } = require("./video-studio-helpers/http"), { adminCaller } = require("./video-studio-helpers/router"), { createVideoStudioApi } = require("../video-studio/api"), { COLL } = require("../video-studio/constants");
async function apiWith(storage) { const db = new FakeFirestore(), api = createVideoStudioApi({ db, verifyIdToken: fakeVerify, storage, log: quiet, env: { VIDEO_STUDIO_ORIGIN: "https://hidden-dinox-video-staging.onrender.com" } }); await db.collection("users").doc("boss").set({ role: "admin" }); await db.collection("users").doc("anna").set({ role: "student" });
  return { db, call: (m, p, o = {}) => adminCaller(api)(m, p, Object.assign({ uid: "boss", headers: { origin: "https://hidden-dinox-video-staging.onrender.com" } }, o)) }; }
test("API + R2: полный путь — создание, части, статус, завершение, проверка файла; бакет приватный (ссылки только подписанные)", async () => {
  const f = makeFakeS3(), st = createR2Storage({ env: ENV, sdk: f.sdk, log: quiet }), { db, call } = await apiWith(st), size = 20 * MiB + 77;
  const c = await call("POST", "/projects", { body: { filename: "live.mp4", size, content_type: "video/mp4", fingerprint: "k1" } }); assert.equal(c.statusCode, 200, JSON.stringify(c.body)); assert.equal(c.body.upload.mode, "multipart"); assert.equal(c.body.upload.urls.length, 2);
  assert.match(c.body.upload.urls[0].url, /^https:\/\/abc123\.r2\.cloudflarestorage\.com\/hidden-dinox-videos\/video-studio\/boss\/p_[0-9a-f]+\/source\/original\.mp4\?.*partNumber=1/); assert.ok(!JSON.stringify(c.body).includes("SECRET") && !JSON.stringify(c.body).includes("AKIA"));
  const pid = c.body.project.id, uploadId = [...f.state.uploads.keys()][0], file = Buffer.alloc(size, 3); file.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70], 0);
  const e1 = f.state.putPart(uploadId, 1, file.subarray(0, 16 * MiB)); const s1 = await call("GET", `/projects/${pid}/upload/status`); assert.equal(s1.statusCode, 200); assert.deepEqual(s1.body.parts, [{ part_number: 1, etag: e1, size: 16 * MiB }]);
  const more = await call("POST", `/projects/${pid}/upload/parts`, { body: { part_numbers: [2] } }); assert.match(more.body.urls[0].url, /partNumber=2/);
  assert.equal((await call("POST", `/projects/${pid}/upload/complete`, { body: {} })).body.error, "INCOMPLETE"); const e2 = f.state.putPart(uploadId, 2, file.subarray(16 * MiB));
  const done = await call("POST", `/projects/${pid}/upload/complete`, { body: { parts: [{ part_number: 1, etag: e1 }, { part_number: 2, etag: '"' + e2 + '"' }] } }); assert.equal(done.statusCode, 200, JSON.stringify(done.body)); assert.equal(done.body.project.status, "validating");
  const obj = [...f.state.objects.entries()].find(([k]) => k.endsWith("/source/original.mp4")); assert.equal(obj[1].body.length, size); assert.deepEqual(obj[1].body, file); assert.equal((await db.collection(COLL.jobs).get()).docs.filter(d => d.data().type === "probe").length, 1);
  const pr = (await db.collection(COLL.projects).doc(pid).get()).data(); await assert.doesNotReject(st.signedReadUrl(pr.source_path, { ttlSec: 900 }));
});
test("API + R2: неверные ключи, бакет, адрес и отсутствие переменных — понятная причина вместо «временно недоступно», проекты не создаются", async () => {
  const cases = [[{ R2_SECRET_ACCESS_KEY: "WRONGSECRETVALUE9999" }, "STORAGE_AUTH", /R2_ACCESS_KEY_ID/], [{ R2_BUCKET: "no-such-bucket" }, "STORAGE_BUCKET", /no-such-bucket/]];
  for (const [over, code, re] of cases) { const f = makeFakeS3(), { db, call } = await apiWith(createR2Storage({ env: Object.assign({}, ENV, over), sdk: f.sdk, log: quiet })); const r = await call("POST", "/projects", { body: { filename: "a.mp4", size: 30 * MiB } });
    assert.equal(r.statusCode, 503); assert.equal(r.body.error, code); assert.match(r.body.message, re); assert.ok(!/WRONGSECRETVALUE9999|AKIATESTKEY0001|SECRETTESTKEYVALUE0001/.test(JSON.stringify(r.body))); assert.equal((await db.collection(COLL.projects).get()).docs.length, 0, "проект не создан");
    const h = await call("GET", "/health"); assert.equal(h.body.storage.ok, false); assert.equal(h.body.storage.code, code); assert.equal(h.body.storage.kind, "r2"); }
  const f = makeFakeS3(); f.state.networkDown = true; const net = await apiWith(createR2Storage({ env: ENV, sdk: f.sdk, log: quiet })); const rn = await net.call("POST", "/projects", { body: { filename: "a.mp4", size: 30 * MiB } }); assert.equal(rn.body.error, "STORAGE_NETWORK"); assert.match(rn.body.message, /R2_ENDPOINT/);
  const broken = createStorage({ env: { VIDEO_STUDIO_STORAGE: "r2" }, admin: { storage: () => { throw new Error("не должно вызываться"); } }, log: quiet }), b = await apiWith(broken); const rb = await b.call("POST", "/projects", { body: { filename: "a.mp4", size: 30 * MiB } });
  assert.equal(rb.statusCode, 503); assert.equal(rb.body.error, "STORAGE_CONFIG"); assert.match(rb.body.message, /R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET/); const hb = await b.call("GET", "/health"); assert.equal(hb.body.storage.ok, false); assert.equal(hb.body.storage.kind, "r2"); assert.equal((await b.call("GET", "/me")).statusCode, 200, "сервер и страница остаются рабочими");
  assert.equal((await b.call("POST", "/projects", { uid: "anna", body: {} })).statusCode, 403, "неадминистратор не получает даже диагностику хранилища");
});
test("API + R2: настройка CORS и жизненного цикла кнопкой; при токене без прав — готовый JSON для панели Cloudflare с ExposeHeaders ETag", async () => {
  const f = makeFakeS3(), { call } = await apiWith(createR2Storage({ env: ENV, sdk: f.sdk, log: quiet })), origin = "https://hidden-dinox-video-staging.onrender.com";
  const r = await call("POST", "/storage/cors"); assert.equal(r.statusCode, 200); assert.equal(r.body.ok, true); assert.deepEqual(f.state.cors.CORSRules[0].AllowedOrigins, [origin]); assert.ok(f.state.cors.CORSRules[0].ExposeHeaders.includes("ETag")); assert.equal(r.body.lifecycle.ok, true);
  f.state.denyBucketConfig = true; const d = await call("POST", "/storage/cors"); assert.equal(d.body.ok, false); assert.match(d.body.error, /Admin Read & Write/); const m = JSON.parse(d.body.manual); assert.deepEqual(m[0].AllowedOrigins, [origin]); assert.ok(m[0].ExposeHeaders.includes("ETag")); assert.match(d.body.where, /Cloudflare/);
  assert.equal((await call("POST", "/storage/cors", { uid: "anna" })).statusCode, 403);
});

test("исполнитель очереди: при неверной настройке R2 задание завершается ПОНЯТНОЙ причиной (без бесполезных повторов), исходная запись не трогается", async () => {
  const { Runner } = require("../video-studio/runner"), J = require("../video-studio/jobs"), clock = { t: 1_800_000_000_000 }, now = () => clock.t;
  for (const [storage, code, re] of [[createStorage({ env: { VIDEO_STUDIO_STORAGE: "r2" }, log: quiet }), "STORAGE_CONFIG", /R2_ENDPOINT/], [createR2Storage({ env: Object.assign({}, ENV, { R2_SECRET_ACCESS_KEY: "WRONGSECRETVALUE9999" }), sdk: makeFakeS3().sdk, log: quiet }), "STORAGE_AUTH", /R2_ACCESS_KEY_ID/]]) {
    const db = new FakeFirestore(); await db.collection(COLL.projects).doc("p1").set({ id: "p1", owner_uid: "boss", status: "validating", source_path: "video-studio/boss/p1/source/original.mp4", filename: "a.mp4" });
    await J.enqueue(db, now, { type: "probe", project_id: "p1", owner_uid: "boss", key: "p1", payload: {} }); const runner = new Runner({ db, storage, env: {}, log: quiet, now, pollMs: 1e9 }); assert.equal(await runner.tick(), true);
    const job = (await db.collection(COLL.jobs).get()).docs[0].data(), pr = (await db.collection(COLL.projects).doc("p1").get()).data(); assert.equal(job.status, "failed"); assert.equal(job.error.code, code); assert.match(job.error.message, re); assert.equal(job.attempts, 1, "без повторов"); assert.equal(pr.status, "error"); assert.equal(pr.error.code, code);
  }
});
/* Поддельный HTTP для самопроверки: ведёт себя как R2 с CORS-правилами из state.cors; не доказывает поведение настоящего R2 */
function fakeHttp(f) {
  const st = f.state;
  return async (url, o = {}) => {
    const u = new URL(url), method = o.method || "GET", origin = (o.headers || {}).Origin, parts = decodeURIComponent(u.pathname).split("/").slice(2), key = parts.join("/");
    const rule = st.cors && st.cors.CORSRules[0], allowed = !!(origin && rule && rule.AllowedOrigins.includes(origin));
    const cors = allowed ? { "access-control-allow-origin": origin, "access-control-allow-methods": rule.AllowedMethods.join(","), "access-control-expose-headers": rule.ExposeHeaders.join(",") } : {};
    if (method === "OPTIONS") return { status: allowed ? 200 : 403, headers: cors, body: Buffer.alloc(0) };
    if (method === "GET") { const x = st.objects.get(key); return x ? { status: 200, headers: {}, body: x.body } : { status: 404, headers: {}, body: Buffer.alloc(0) }; }
    if (method === "PUT") { const etag = st.putPart(u.searchParams.get("uploadId"), Number(u.searchParams.get("partNumber")), Buffer.from(o.body)); return { status: 200, headers: Object.assign({ etag: '"' + etag + '"' }, cors), body: Buffer.alloc(0) }; }
    return { status: 405, headers: {}, body: Buffer.alloc(0) };
  };
}
test("проверка хранилища кнопкой: пошаговый отчёт, понятная причина про CORS, ETag и ключи; за собой всё удаляет; только администратор", async () => {
  const origin = "https://hidden-dinox-video-staging.onrender.com", mkApi = async over => { const f = makeFakeS3(), st = createR2Storage({ env: Object.assign({}, ENV, over || {}), sdk: f.sdk, log: quiet }), db = new FakeFirestore(), api = createVideoStudioApi({ db, verifyIdToken: fakeVerify, storage: st, log: quiet, env: { VIDEO_STUDIO_ORIGIN: origin }, httpRequest: fakeHttp(f) }); await db.collection("users").doc("boss").set({ role: "admin" }); await db.collection("users").doc("anna").set({ role: "student" }); return { f, call: (m, p, o = {}) => adminCaller(api)(m, p, Object.assign({ uid: "boss", headers: { origin } }, o)) }; };
  const a = await mkApi(); let r = await a.call("POST", "/storage/selftest"); assert.equal(r.statusCode, 200); assert.equal(r.body.ok, false, "CORS ещё не настроен"); assert.equal(r.body.steps.length, 4); assert.deepEqual(r.body.steps.map(s => s.ok), [true, true, true, false]);
  assert.match(r.body.steps[3].error, /CORS не настроен для https:\/\/hidden-dinox-video-staging\.onrender\.com/); assert.match(r.body.steps[3].error, /r2-cors\.json/); assert.equal(a.f.state.uploads.size, 0, "незавершённая загрузка прервана"); assert.equal([...a.f.state.objects.keys()].filter(k => k.includes("_selftest")).length, 0, "тестовые файлы удалены");
  assert.equal((await a.call("POST", "/storage/cors")).body.ok, true); r = await a.call("POST", "/storage/selftest"); assert.equal(r.body.ok, true, JSON.stringify(r.body.steps)); assert.match(r.body.steps[3].detail, /обе части загружены и собраны.*CORS разрешён для https:\/\/hidden-dinox-video-staging/); assert.equal(a.f.state.objects.size, 0, "после проверки бакет чист");
  a.f.state.cors.CORSRules[0].ExposeHeaders = ["Content-Length"]; r = await a.call("POST", "/storage/selftest"); assert.match(r.body.steps[3].error, /ETag/, "без ExposeHeaders ETag браузер не прочитает ответ части");
  const bad = await mkApi({ R2_SECRET_ACCESS_KEY: "WRONGSECRETVALUE9999" }); r = await bad.call("POST", "/storage/selftest"); assert.equal(r.body.ok, false); assert.equal(r.body.steps.length, 1); assert.match(r.body.steps[0].error, /ключи доступа/); assert.ok(!JSON.stringify(r.body).includes("WRONGSECRETVALUE9999"));
  assert.equal((await a.call("POST", "/storage/selftest", { uid: "anna" })).statusCode, 403);
});
