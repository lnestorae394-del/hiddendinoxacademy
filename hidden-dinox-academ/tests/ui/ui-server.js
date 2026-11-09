"use strict";
/* Тестовый сервер для проверки страницы в браузере: НАСТОЯЩИЙ API Video Studio + фейковые Firestore/хранилище/Telegram.
   Вход Firebase подменяется заглушкой (/academy/js/firebase.js); загрузка эмулирует возобновляемые сессии Google (308 + Range). Исполнитель очереди не запускается:
   задания остаются в очереди, чтобы страница показала их состояние (выполнение заданий проверяется в tests/video-studio-pipeline.test.js). */
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { FakeFirestore } = require(path.join(ROOT, "tests/video-studio-helpers/fake-firestore"));
const { fakeVerify } = require(path.join(ROOT, "tests/video-studio-helpers/http"));
const { createVideoStudioApi } = require(path.join(ROOT, "video-studio/api"));
const { memoryVideoStorage } = require(path.join(ROOT, "video-studio/storage-adapter"));
const { COLL } = require(path.join(ROOT, "video-studio/constants"));
const fakes = require(path.join(ROOT, "tests/video-studio-helpers/fakes"));
const MEDIA = process.env.UI_MEDIA_DIR || path.join(os.tmpdir(), "vs_ui");
const db = new FakeFirestore(), storage = memoryVideoStorage({ multipart: true }); let PORT = 0, tg = null;
storage.signedReadUrl = async (p, o) => "http://127.0.0.1:" + PORT + "/media/" + encodeURIComponent(p) + (o && o.filename ? "?dl=" + encodeURIComponent(o.filename) : "");
storage.presignPart = async (p, id, n) => "http://127.0.0.1:" + PORT + "/r2part?path=" + encodeURIComponent(p) + "&uploadId=" + id + "&n=" + n;   // подделка подписанной ссылки R2: части принимает этот же тестовый сервер
const ORIG = { stat: storage.stat, check: storage.check };
const env = { TELEGRAM_BOT_TOKEN: "123456:TESTTOKEN", ADMIN_TELEGRAM_ID: "777000111", FFMPEG_PATH: process.env.FFMPEG_PATH || process.env.FFMPEG || "" };
if (!env.FFMPEG_PATH) delete env.FFMPEG_PATH;
const api = createVideoStudioApi({ db, verifyIdToken: fakeVerify, storage, log: { log() {}, warn() {}, error() {} }, env });
const matcher = p => { const keys = []; const re = new RegExp("^" + p.replace(/:([a-z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$"); return u => { const m = u.match(re); if (!m) return null; const o = {}; keys.forEach((k, i) => (o[k] = decodeURIComponent(m[i + 1]))); return o; }; };
const table = api.ROUTES.map(([m, p, name, perm, mut]) => ({ m, match: matcher(p), h: api.handler(name, perm, mut) }));
const FW = ["Запомните", "дисциплина", "важнее", "красивого", "входа", "Я", "всегда", "жду", "закрытия", "свечи", "а", "потом", "принимаю", "решение"];
async function seed() {
  const set = (c, i, d) => db.collection(c).doc(i).set(d), t = Date.now();
  await set("users", "boss", { email: "boss@test.local", role: "admin" }); await set("users", "anna", { email: "anna@test.local", role: "student" }); await set("users", "mia", { email: "mia@test.local", role: "mentor" });
  const base = "video-studio/boss/p_demo/";
  const tr = { words: Array.from({ length: 80 }, (_, i) => ({ word: "слово" + i, start: +(55 + 0.55 * i).toFixed(2), end: +(55 + 0.55 * i + 0.4).toFixed(2) })) };
  await storage.writeBuffer(base + "transcripts/groq_x.json", Buffer.from(JSON.stringify(tr)), "application/json");
  await set(COLL.projects, "p_demo", { id: "p_demo", owner_uid: "boss", owner_email: "boss@test.local", filename: "live-demo.mp4", size_bytes: 40e6, content_type: "video/mp4", status: "analyzed", source_path: base + "source/original.mp4", duration_sec: 466, width: 720, height: 1440, counts: { clips: 2 }, analysis: { model: "claude-sonnet-5-5", whisper: "whisper-large-v3-turbo", cost_usd: 0.21, transcript_path: base + "transcripts/groq_x.json", rejected: [], at: t }, created_at: t - 1000, updated_at: t });
  const words = tr.words.slice(20, 34).map((w, i) => ({ id: "w" + String(20 + i).padStart(6, "0"), text: FW[i], start: w.start, end: w.end }));
  await set(COLL.clips, "c1", { id: "c1", project_id: "p_demo", owner_uid: "boss", n: 1, order: 0, title: "Дисциплина важнее входа", hook: "Дисциплина важнее входа", start: words[0].start, end: words[13].end, duration_s: 8.2, category: "explanation", score: 0.9, reason: "Ясная мысль", status: "found", window_path: base + "clips/c1/window.mp4", thumb_path: base + "clips/c1/thumb.jpg", window_start: 60, window_dur: 40, words, created_at: t });
  const w2 = tr.words.slice(40, 52).map((w, i) => ({ id: "w" + String(40 + i).padStart(6, "0"), text: "ответ" + i, start: w.start, end: w.end }));
  await set(COLL.clips, "c2", { id: "c2", project_id: "p_demo", owner_uid: "boss", n: 2, order: 1, title: "Готовый ролик", hook: "Готовый ролик", start: w2[0].start, end: w2[11].end, duration_s: 17, category: "reaction", score: 0.8, status: "done", window_path: base + "clips/c2/window.mp4", thumb_path: base + "clips/c2/thumb.jpg", window_start: 70, window_dur: 40, words: w2, render: { hash: "abc123abc123", path: base + "exports/c2_abc123abc123.mp4", at: t, size: 6200000, duration: 17 }, telegram: { status: "sent", kind: "video", hash: "abc123abc123", message_id: 555, file_id: "BAAC555", sent_at: t, attempts: 1, chat_id: "777000111" }, created_at: t });
  for (const p of [base + "source/original.mp4", base + "clips/c1/window.mp4", base + "clips/c1/thumb.jpg", base + "clips/c2/window.mp4", base + "clips/c2/thumb.jpg", base + "exports/c2_abc123abc123.mp4"]) storage.put(p, { size: 1000 });
}
const send = (res, code, body, type = "application/json", extra = {}) => { res.writeHead(code, Object.assign({ "Content-Type": type }, extra)); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const FB = `window.__hdFbResolve && (function(){ var u = localStorage.getItem("vs_user"); var auth = { currentUser: u ? { uid: u, getIdToken: async function(){ return "testtoken-" + u; } } : null }; window.__hdFbResolve({ auth: auth, signOut: async function(){ localStorage.removeItem("vs_user"); } }); })();`;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  try {
    if (p === "/academy/js/config.js") return send(res, 200, "window.HD_FIREBASE_CONFIG={};", "application/javascript");
    if (p === "/academy/js/firebase.js") return send(res, 200, FB, "application/javascript");
    if (p.startsWith("/academy/admin/") || p.startsWith("/academy/assets/")) { const f = path.join(ROOT, "public", p); if (!f.startsWith(path.join(ROOT, "public")) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, "nf", "text/plain"); return send(res, 200, fs.readFileSync(f), f.endsWith(".js") ? "application/javascript" : f.endsWith(".css") ? "text/css" : f.endsWith(".png") ? "image/png" : "text/html"); }
    if (p === "/__db") { const c = u.searchParams.get("c"); return send(res, 200, (await db.collection(c).get()).docs.map(d => ({ id: d.id, ...d.data() }))); }
    if (p === "/__fail") { const on = u.searchParams.get("on") === "1"; storage.stat = on ? async () => { throw Object.assign(new Error("UnknownError"), { name: "Unknown", $metadata: { httpStatusCode: 400 } }); } : ORIG.stat; storage.check = on ? async () => { throw Object.assign(new Error("UnknownError"), { name: "Unknown", vsOp: "bucket", $metadata: { httpStatusCode: 400 } }); } : ORIG.check; return send(res, 200, { on }); }
    if (p === "/__seed_upload") { await db.collection(COLL.projects).doc("p_broken").set({ id: "p_broken", owner_uid: "boss", filename: "обрыв.mp4", size_bytes: 40e6, status: "uploading", source_path: "video-studio/boss/p_broken/source/original.mp4", upload: { mode: "multipart", upload_id: "x", part_size: 16777216, total_parts: 3, declared_size: 40e6, expires_at: Date.now() + 86400000 }, created_at: Date.now(), updated_at: Date.now() }); return send(res, 200, { ok: true }); }
    if (p === "/__tg") return send(res, 200, { messages: tg.messages, sent: tg.sent.map(s => ({ id: s.id, chat_id: s.chat_id })), calls: tg.calls });
    if (p.startsWith("/media/")) { const rel = decodeURIComponent(p.slice(7)), f = rel.endsWith(".jpg") ? path.join(MEDIA, "thumb.jpg") : path.join(MEDIA, "window.mp4"); const st = fs.statSync(f), r = req.headers.range;
      if (r) { const m = /bytes=(\d+)-(\d*)/.exec(r), a = +m[1], b = m[2] ? +m[2] : st.size - 1; res.writeHead(206, { "Content-Type": f.endsWith(".jpg") ? "image/jpeg" : "video/mp4", "Content-Range": `bytes ${a}-${b}/${st.size}`, "Accept-Ranges": "bytes", "Content-Length": b - a + 1 }); return fs.createReadStream(f, { start: a, end: b }).pipe(res); }
      res.writeHead(200, { "Content-Type": f.endsWith(".jpg") ? "image/jpeg" : "video/mp4", "Accept-Ranges": "bytes", "Content-Length": st.size }); return fs.createReadStream(f).pipe(res); }
    if (p === "/__storage") return send(res, 200, { objects: [...storage.objects.entries()].map(([k, v]) => ({ key: k, size: v.size })), uploads: storage.uploads.size });
    if (p === "/r2part" && req.method === "PUT") { const chunks = []; for await (const c of req) chunks.push(c); const buf = Buffer.concat(chunks), etag = storage.putPart(u.searchParams.get("path"), u.searchParams.get("uploadId"), Number(u.searchParams.get("n")), buf); res.writeHead(200, { ETag: '"' + etag + '"', "Access-Control-Expose-Headers": "ETag" }); return res.end(); }
    if (p.startsWith("/api/video-studio")) {
      const sub = p.slice("/api/video-studio".length); const chunks = []; for await (const c of req) chunks.push(c); let body; try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined; } catch (e) { body = undefined; }
      for (const r of table) { if (r.m !== req.method) continue; const params = r.match(sub); if (!params) continue; const rr = { status(c) { rr.code = c; return rr; }, json(b) { send(res, rr.code || 200, b); }, set() {} };
        return r.h({ params, query: Object.fromEntries(u.searchParams), body, headers: req.headers }, rr); }
      return send(res, 404, { error: "NOT_FOUND" });
    }
    send(res, 404, "nf", "text/plain");
  } catch (e) { send(res, 500, { error: String(e && e.message) }); }
});
(async () => { tg = await fakes.telegramServer("123456:TESTTOKEN"); env.TELEGRAM_API_BASE = tg.url; await seed(); server.listen(0, "127.0.0.1", () => { PORT = server.address().port; env.VIDEO_STUDIO_ORIGIN = "http://127.0.0.1:" + PORT; console.log(JSON.stringify({ port: PORT })); }); })();
