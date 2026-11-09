"use strict";
/* Тестовый сервер для сквозных проверок интерфейса (только для тестов, не для production).
   Настоящие обработчики academy/api.js и academy/postback.js + тестовая Firestore в памяти.
   Служебные /test/* существуют ТОЛЬКО здесь. */
const http = require("http"), fs = require("fs"), path = require("path"), url = require("url");
const { FakeFirestore } = require("../helpers/fake-firestore");
const { fakeVerify } = require("../helpers/http");
const { createAcademyApi } = require("../../academy/api");
const { createAcademyPostback } = require("../../academy/postback");
const { createTestDeposit } = require("../../academy/test-deposit");
const { createAdminApi } = require("../../academy/admin-api");
const { createLearnApi } = require("../../academy/learn-api");
const { memoryStorage } = require("../../academy/storage");
const { matcher } = require("../helpers/router");
const { registerBookRoutes } = require("../../academy/books");
const { registerReferralRoutes } = require("../../academy/referral");
const { registerPartnerLinkRoutes } = require("../../academy/partner-links");
const { loginTarget, OLD_LOGIN_PATHS } = require("../../academy/login-route");
const PUB = path.resolve(__dirname, "../../public/academy"), ADMIN = path.resolve(__dirname, "../../public/admin");
const db = new FakeFirestore();
const quiet = { log() {}, warn() {}, error() {} };
if (!process.env.REFERRAL_MODE) process.env.REFERRAL_MODE = "test"; if (!process.env.REFERRAL_PAYOUTS_ENABLED) process.env.REFERRAL_PAYOUTS_ENABLED = "1";   // админка партнёров читает process.env
const api = createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet });
const testDeposit = createTestDeposit({ db, secret: "local-test-deposit-secret-only-0001", log: quiet });
const pb = createAcademyPostback({ db, env: { POCKET_POSTBACK_SECRET: "e2e-secret-0123456789abcdef-test" }, log: quiet });
db.latency = Number(process.env.FAKE_FS_LATENCY || 0);   // только для измерений
const storage = memoryStorage();
const aiEnv = { ANTHROPIC_API_KEY: "test-key-not-real" }; let aiMode = "ok"; let genSeq = 0;   // ИИ-помощник: общие переменные для учебного API и админки
const adminApi = createAdminApi({ db, verifyIdToken: fakeVerify, storage, log: quiet, env: aiEnv, aiFetch: (u, i) => fakeClaude(u, i) });
// ИИ-помощник: имитация Claude API (ответ по найденному уроку или «этого нет в материалах»); режимы — /test/ai?mode=ok|error|nokey
async function fakeClaude(url, init) {
  if (aiMode === "error") return { ok: false, status: 529, json: async () => ({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) };
  const b0 = JSON.parse(init.body), last0 = b0.messages[b0.messages.length - 1].content;
  if (/^Ты составляешь тестовые вопросы/.test(String(b0.system))) {   // генератор Daily Tests: вопросы с дословной цитатой из урока
    const lesson = /<lesson>\n([\s\S]*?)\n<\/lesson>/.exec(last0)[1], sent = lesson.split(/(?<=[.!?])\s+/).find(x => x.split(" ").length >= 8) || lesson.slice(0, 120), quote = sent.split(" ").slice(0, 8).join(" ");
    const n = Number(/Составь (\d+)/.exec(last0)[1]), qs = Array.from({ length: n }, () => { const k = ++genSeq; return { type: ["terminology", "structure", "risk"][k % 3], difficulty: ["beginner", "intermediate", "advanced"][k % 3],
      q: `${["Почему", "Когда", "Зачем", "Каким образом", "В каком случае", "Что означает"][k % 6]} ${["замедление", "откат", "накопление объёма", "ложное движение", "точка входа", "реакция рынка", "дисциплина", "структура", "ликвидность"][k % 9]} ${["важно учитывать", "меняет решение", "предшествует развороту", "подтверждает сценарий", "отменяет гипотезу", "требует ожидания", "влияет на риск"][k % 7]} — сгенерированный вопрос ${k}?`, options: [`Верно ${k}`, `Неверно А ${k}`, `Неверно Б ${k}`, `Неверно В ${k}`], correct: 0,
      explanation: `Это прямо следует из текста урока: ${quote}.`, why_wrong: ["Противоречит уроку.", "В уроке иначе.", "Смешение понятий."], source_quote: quote,
      en: { q: `Generated question ${k}: what follows from the lesson?`, options: [`Right ${k}`, `Wrong A ${k}`, `Wrong B ${k}`, `Wrong C ${k}`], explanation: "This follows directly from the lesson text." },
      ua: { q: `Згенероване питання ${k}: що випливає з уроку?`, options: [`Правильно ${k}`, `Хибно А ${k}`, `Хибно Б ${k}`, `Хибно В ${k}`], explanation: "Це прямо випливає з тексту уроку." } }; });
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ questions: qs }) }], usage: { input_tokens: 3000, output_tokens: 2000 } }) }; }
  if (Array.isArray(last0)) { const nImg = last0.filter(x => x.type === "image").length;   // запрос со скриншотами: разбор + служебная заметка, как требует инструкция
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: `Разбор скриншота (${nImg} изобр.): нисходящий импульс, затем коррекция.\n<chart_note>EUR/USD OTC; M1; изображений ${nImg}; нисходящая структура; зона у последнего максимума</chart_note>` }], usage: { input_tokens: 2500, output_tokens: 400 }, stop_reason: "end_turn" }) }; }
  const b = b0, m = /(?:Урок|Материал): ([^\n]+)/.exec(b.system)   /* формат фрагментов: «Урок:» (раньше) или «Материал:» (сейчас) */, q = b.messages[b.messages.length - 1].content;
  const text = m ? `Ответ по материалам: ${m[1]}.\n- Пункт по вопросу «${q.slice(0, 40)}»\n**Источник:** урок «${m[1]}»` : "В материалах академии этого нет. Попробуйте переформулировать вопрос.";
  return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }], usage: { input_tokens: 1200, output_tokens: 180 }, stop_reason: "end_turn" }) };
}
const learnApi = createLearnApi({ db, academyApi: api, storage, log: quiet, env: aiEnv, mentorFetch: fakeClaude });
// Восстановление пароля: настоящий обработчик, Firebase Admin и почта — подменные (адреса из /test/fb-user, письма в памяти)
const fbUsers = new Set(), outbox = [];
const forgot = require("../../academy/forgot-password").createForgotPassword({
  authAdmin: { async generatePasswordResetLink(email) { if (!fbUsers.has(email)) throw Object.assign(new Error("no user"), { code: "auth/email-not-found" });
    return "https://ai-boost-10540.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=SRV" + outbox.length + "X&apiKey=AIzaTEST&lang=ru"; } },
  mailer: { configured: process.env.FORGOT_MAIL_OFF !== "1", provider: "test", from: "Hidden Dinox Academy <no-reply@test>", missing: [], async send(m) { outbox.push(m); return { id: "t" }; } },
  env: { APP_BASE_URL: "https://academy.example" }, log: quiet });
const adminTable = adminApi.ROUTES.map(([m, p, name, perm, mut]) => ({ m, match: matcher(p), h: adminApi.handler(name, perm, mut) }));
const learnTable = learnApi.ROUTES.map(([m, p, name]) => ({ m, match: matcher("/api" + p), h: learnApi.H[name] }));
// Маршруты книги и рефералов — те же функции регистрации, что на сервере (express-подобный адаптер ниже)
const extraTable = [];
const fakeRouter = { get: (p, h) => extraTable.push({ m: "GET", match: matcher("/api" + p), h }), post: (p, h) => extraTable.push({ m: "POST", match: matcher("/api" + p), h }), put: (p, h) => extraTable.push({ m: "PUT", match: matcher("/api" + p), h }) };
registerBookRoutes(fakeRouter, { db, academyApi: api, root: path.resolve(__dirname, "../.."), log: quiet });
registerPartnerLinkRoutes(fakeRouter, { db, academyApi: api, log: quiet });
registerReferralRoutes(fakeRouter, { db, academyApi: api, env: { REFERRAL_MODE: process.env.REFERRAL_MODE || "test", REFERRAL_PAYOUTS_ENABLED: process.env.REFERRAL_PAYOUTS_ENABLED || "1" }, log: quiet });
const expressify = res => { res.status = c => { res.statusCode = c; return res; }; res.set = (k, v) => { if (typeof k === "object") for (const [a, b] of Object.entries(k)) res.setHeader(a, b); else res.setHeader(k, v); return res; };
  res.json = b => { if (!res.headersSent) res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(b)); return res; }; return res; };
const readBody = async req => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); };
const types = {
  ".mjs": "text/javascript; charset=utf-8", ".pdf": "application/pdf", ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg" };

http.createServer(async (req, res) => {
  if (process.env.MEASURE_LOG) { const t0 = Date.now(), o0 = db.ops || 0; res.on("finish", () => process.stderr.write(`REQ ${req.method} ${req.url.split("?")[0]} ${Date.now() - t0}ms ops=${(db.ops || 0) - o0} t=${t0 % 100000}\n`)); }
  const u = url.parse(req.url, true);
  const send = (code, body, type = "application/json") => { res.writeHead(code, { "Content-Type": type }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  const xres = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { send(this.statusCode, b); return this; }, set() { return this; } };
  xres.send = function (b) { res.writeHead(this.statusCode, this._h || {}); res.end(b); return this; };
  xres.set = function (k, v) { this._h = { ...(this._h || {}), [k]: v }; return this; };
  xres.end = function () { res.writeHead(this.statusCode); res.end(); return this; };
  try {
    // Админ-API и обучение — те же обработчики и таблицы маршрутов, что на сервере
    const dispatch = async (table, prefix) => {
      for (const r of table) { if (r.m !== req.method) continue; const params = r.match(u.pathname.slice(prefix.length)); if (!params) continue;
        const buf = await readBody(req), ct = String(req.headers["content-type"] || "");
        const body = /json/.test(ct) ? (buf.length ? JSON.parse(buf.toString("utf8")) : {}) : (buf.length ? buf : {});
        await r.h({ params, query: u.query, body, headers: req.headers, ip: "127.0.0.1" }, xres); return true; }
      return false;
    };
    if (u.pathname.startsWith("/admin/api/")) { if (!(await dispatch(adminTable, "/admin/api"))) send(404, { error: "NOT_FOUND" }); return; }
    if (u.pathname === "/api/learn/courses" && global.__failLearn > 0) { global.__failLearn--; return send(503, { error: "UNAVAILABLE" }); }   // временная ошибка Firestore
    if (u.pathname.startsWith("/api/learn/books") || u.pathname.startsWith("/api/referral/") || u.pathname === "/api/via/attach" || u.pathname === "/api/broker-link") {
      for (const r of extraTable) { if (r.m !== req.method) continue; const params = r.match(u.pathname); if (!params) continue;
        const buf = await readBody(req); const body = buf.length && /json/.test(String(req.headers["content-type"] || "")) ? JSON.parse(buf.toString("utf8")) : {};
        return r.h({ params, query: u.query, body, headers: req.headers }, expressify(res)); }
      return send(404, { error: "NOT_FOUND" });
    }
    if (u.pathname.startsWith("/api/learn/") || u.pathname.startsWith("/api/home/") || u.pathname.startsWith("/api/daily/") || u.pathname.startsWith("/api/chart/") || u.pathname.startsWith("/api/routine/") || u.pathname.startsWith("/api/mentor/") || u.pathname === "/api/announcements") { if (!(await dispatch(learnTable, ""))) send(404, { error: "NOT_FOUND" }); return; }
    if (u.pathname.startsWith("/media/")) return learnApi.media({ params: { id: u.pathname.slice(7) } }, xres);
    if (u.pathname === "/test/ai") { aiMode = u.query.mode === "error" ? "error" : "ok"; if (u.query.mode === "nokey") delete aiEnv.ANTHROPIC_API_KEY; else aiEnv.ANTHROPIC_API_KEY = "test-key-not-real"; return send(200, { ok: true }); }
    if (u.pathname === "/test/fb-user") { fbUsers.add(String(u.query.email).toLowerCase()); return send(200, { ok: true }); }
    if (u.pathname === "/test/outbox") { await Promise.all(forgot._jobs); return send(200, outbox); }
    if (u.pathname === "/test/forgot-off") { forgot.__off = u.query.on === "1"; return send(200, { ok: true }); }
    if (u.pathname === "/api/auth/forgot-password" && req.method === "POST") {
      let raw = ""; for await (const ch of req) raw += ch; let body = {}; try { body = JSON.parse(raw || "{}"); } catch (e) {}
      if (forgot.__off) return send(503, { error: "MAIL_NOT_CONFIGURED" });
      const r = { statusCode: 200, h: {}, status(c) { this.statusCode = c; return this; }, set(k, v) { this.h[k] = v; }, json(b) { send(this.statusCode, b); } };
      forgot.handler({ body, headers: req.headers, socket: req.socket, ip: req.socket.remoteAddress }, r).catch(() => {}); return;
    }
    if (u.pathname === "/test/fail-learn") { global.__failLearn = Number(u.query.n || 1); return send(200, { ok: true }); }
    if (u.pathname === "/test/ops") return send(200, { ops: db.ops || 0 });
    if (u.pathname === "/test/ops-reset") { db.ops = 0; return send(200, { ok: true }); }
    if (u.pathname === "/test/role") { await db.collection("users").doc(u.query.uid).set({ role: u.query.role }, { merge: true }); return send(200, { ok: true }); }
    if (u.pathname === "/admin" || u.pathname.startsWith("/admin/")) {
      let p = path.join(ADMIN, decodeURIComponent(u.pathname.slice("/admin/".length)) || "index.html");
      if (!p.startsWith(ADMIN)) return send(403, "forbidden", "text/plain");
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(ADMIN, "index.html");
      return send(200, fs.readFileSync(p), types[path.extname(p)] || "application/octet-stream");
    }
    if (u.pathname.startsWith("/api/") || u.pathname === "/check-deposit" || u.pathname === "/check") {
      let raw = ""; for await (const c of req) raw += c;
      const xreq = { headers: req.headers, body: raw ? JSON.parse(raw) : {}, query: u.query, ip: "127.0.0.1" };
      const h = { "GET /api/me": api.me, "POST /api/click": api.click, "POST /api/trader-id": api.traderId, "POST /api/lang": api.setLang, "GET /check-deposit": api.checkDeposit, "GET /check": api.check }[req.method + " " + u.pathname];
      return h ? h(xreq, xres) : send(404, { error: "NOT_FOUND" });
    }
    if (u.pathname === "/test/postback") { const r = await pb.handle(u.query, { ip: "127.0.0.1" }); return send(200, r); }
    if (u.pathname === "/test/deposit") { const r = await testDeposit(u.query); return send(r.http, { ok: r.http === 200, test: true, status: r.status, message: r.message }); }
    if (u.pathname === "/test/outage") { db.failAll = u.query.on === "1"; return send(200, { failAll: db.failAll }); }
    if (u.pathname === "/test/user") { const users = db.dump("users"); return send(200, users[u.query.uid] || null); }
    // страница входа по «/» и перенаправление старых адресов — правила из academy/login-route.js (как на Render)
    if (u.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }); return res.end(fs.readFileSync(path.join(PUB, "index.html"))); }
    if (OLD_LOGIN_PATHS.includes(u.pathname)) { res.writeHead(302, { Location: loginTarget(req.url) }); return res.end(); }
    if (u.pathname.startsWith("/academy/")) {
      let p = path.join(PUB, decodeURIComponent(u.pathname.slice("/academy/".length)) || "index.html");
      if (!p.startsWith(PUB)) return send(403, "forbidden", "text/plain");
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
      if (!fs.existsSync(p)) return send(404, "not found", "text/plain");
      return send(200, fs.readFileSync(p), types[path.extname(p)] || "application/octet-stream");
    }
    send(404, "not found", "text/plain");
  } catch (e) { send(500, { error: "TEST_SERVER", message: e.message }); }
}).listen(Number(process.env.PORT || 8790), "127.0.0.1", () => console.log("ready"));
