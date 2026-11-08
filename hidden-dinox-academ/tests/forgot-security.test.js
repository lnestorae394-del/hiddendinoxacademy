"use strict";
/* Безопасность POST /api/auth/forgot-password на настоящем Express: IP за прокси (TRUST_PROXY), подмена заголовков,
   нормализация email, ошибки тела запроса, выбор почтового провайдера, отсутствие установки пароля сервером. */
const test = require("node:test"), assert = require("node:assert");
let express, REAL = true;
try { express = require("express"); } catch (e) { express = require("./helpers/mini-express"); REAL = false; }   // после npm install — настоящий Express
console.log(REAL ? "# Express: настоящий (" + require("express/package.json").version + ")" : "# Express не установлен — тестовая реализация tests/helpers/mini-express.js (правила trust proxy/express.json как в Express)");
const { registerForgotPassword } = require("../academy/forgot-password");
const { createMailer } = require("../academy/mailer");
const ENV = { APP_BASE_URL: "https://hidden-dinox-academy-test2.onrender.com" };
function setup({ trust, mailFail, providerMessage } = {}) {
  const calls = [], sent = [], lines = [];
  const L = { log: (...a) => lines.push(a.join(" ")), warn: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
  const authAdmin = {
    async generatePasswordResetLink(email) { calls.push("link"); if (email !== "learner@test.com") throw Object.assign(new Error("no user"), { code: "auth/email-not-found" });
      return "https://ai-boost-10540.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=OOB123&apiKey=AIzaX"; },
    async updateUser() { calls.push("updateUser"); throw new Error("сервер не должен менять пароль"); }
  };
  const mailer = { configured: true, provider: "test", from: "x", missing: [],
    async send(m) { if (mailFail) throw Object.assign(new Error("fail"), { code: "RESEND_403", providerMessage }); sent.push(m); return { id: "1" }; } };
  const app = express(); if (trust !== undefined) app.set("trust proxy", trust);
  app.use(express.json());                                               // как server.js (лимит 100 КБ)
  const fp = registerForgotPassword(app, { authAdmin, env: ENV, log: L, mailer });
  app.use((err, req, res, next) => res.status(500).json({ error: "server_error" }));   // как глобальный обработчик server.js
  return new Promise(r => { const srv = app.listen(0, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/api/auth/forgot-password`, calls, sent, lines, fp })); });
}
const post = (url, body, headers = {}, raw) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: raw !== undefined ? raw : JSON.stringify(body) });
const settle = fp => Promise.all(fp._jobs);

test("TRUST_PROXY=1: подменённое начало X-Forwarded-For не обходит лимит по IP; разные клиенты считаются отдельно", async () => {
  const s = await setup({ trust: 1 });
  try {
    for (let i = 0; i < 10; i++) assert.strictEqual((await post(s.url, { email: `a${i}@test.com` }, { "X-Forwarded-For": `10.0.0.${i}, 198.51.100.7` })).status, 200);
    const r = await post(s.url, { email: "a99@test.com" }, { "X-Forwarded-For": "1.2.3.4, 5.6.7.8, 198.51.100.7" });
    assert.strictEqual(r.status, 429, "клиент 198.51.100.7 ограничен, сколько бы адресов он ни дописал слева");
    assert.strictEqual((await post(s.url, { email: "b0@test.com" }, { "X-Forwarded-For": "198.51.100.8" })).status, 200, "другой клиент не затронут");
    const c = await post(s.url, { email: "a98@test.com" }, { "X-Forwarded-For": "198.51.100.7", "CF-Connecting-IP": "9.9.9.9", "True-Client-IP": "8.8.8.8" });
    assert.strictEqual(c.status, 429, "CF-Connecting-IP / True-Client-IP не учитываются");
  } finally { s.srv.close(); }
});

test("прокси без TRUST_PROXY: подмена X-Forwarded-For бесполезна (IP-лимит не используется), лимит по email действует; предупреждение одно", async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 3; i++) assert.strictEqual((await post(s.url, { email: "learner@test.com" }, { "X-Forwarded-For": `203.0.113.${i}` })).status, 200);
    assert.strictEqual((await post(s.url, { email: "learner@test.com" }, { "X-Forwarded-For": "203.0.113.250" })).status, 429, "смена «IP» не сбрасывает лимит по email");
    for (let i = 0; i < 12; i++) assert.strictEqual((await post(s.url, { email: `u${i}@test.com` }, { "X-Forwarded-For": "203.0.113.9" })).status, 200, "адрес прокси общий — по нему не ограничиваем всех");
    assert.strictEqual(s.lines.filter(l => l.includes("TRUST_PROXY не задан")).length, 1);
  } finally { s.srv.close(); }
});

test("прямое подключение без прокси: IP-лимит по адресу соединения (11-й запрос → 429)", async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 10; i++) assert.strictEqual((await post(s.url, { email: `d${i}@test.com` })).status, 200);
    const r = await post(s.url, { email: "d99@test.com" }); assert.strictEqual(r.status, 429); assert.ok(Number(r.headers.get("retry-after")) > 0);
  } finally { s.srv.close(); }
});

test("email: регистр и пробелы не обходят лимит; не строка / перевод строки → 400", async () => {
  const s = await setup({ trust: 1 });
  try {
    const H = i => ({ "X-Forwarded-For": "192.0.2." + i });
    for (const [i, e] of ["LEARNER@test.com", "  learner@TEST.com ", "learner@test.com"].entries()) assert.strictEqual((await post(s.url, { email: e }, H(i))).status, 200);
    assert.strictEqual((await post(s.url, { email: "Learner@Test.Com" }, H(9))).status, 429, "четвёртый запрос на тот же адрес в любом написании");
    for (const e of [["learner@test.com"], { a: 1 }, "learner@test.com\r\nBcc: x@y.z", "x@y", true])
      assert.strictEqual((await post(s.url, { email: e }, H(50))).status, 400, JSON.stringify(e));
  } finally { s.srv.close(); }
});

test("ошибки тела: битый JSON → 400 без содержимого в логах; больше 100 КБ → 413", async () => {
  const s = await setup({ trust: 1 });
  try {
    const r = await post(s.url, null, {}, '{"email":"secret-user@test.com",');
    assert.strictEqual(r.status, 400); assert.deepStrictEqual(await r.json(), { error: "INVALID_REQUEST" });
    const big = await post(s.url, { email: "learner@test.com", pad: "x".repeat(120 * 1024) });
    assert.strictEqual(big.status, 413); assert.deepStrictEqual(await big.json(), { error: "TOO_LARGE" });
    assert.ok(!s.lines.join("\n").includes("secret-user@test.com"));
  } finally { s.srv.close(); }
});

test("ответы для существующего и несуществующего email совпадают (код, тело, заголовки); пароль сервер не меняет", async () => {
  const s = await setup({ trust: 1 });
  try {
    const a = await post(s.url, { email: "learner@test.com", password: "hacked123", lang: "en" }, { "X-Forwarded-For": "192.0.2.10" });
    const b = await post(s.url, { email: "nobody@test.com", password: "hacked123", lang: "en" }, { "X-Forwarded-For": "192.0.2.11" });
    assert.strictEqual(a.status, b.status); assert.strictEqual(await a.text(), await b.text());
    assert.strictEqual(a.headers.get("cache-control"), b.headers.get("cache-control"));
    await settle(s.fp);
    assert.deepStrictEqual(s.calls, ["link", "link"], "только генерация ссылки, updateUser не вызывается");
    assert.strictEqual(s.sent.length, 1); assert.ok(!s.sent[0].html.includes("hacked123"));
  } finally { s.srv.close(); }
});

test("ошибка Resend: клиенту обычный ответ, в логе код без email и ссылок", async () => {
  const s = await setup({ trust: 1, mailFail: true, providerMessage: "You can only send testing emails to your own email address (owner@private.com). See https://resend.com/domains" });
  try {
    const r = await post(s.url, { email: "learner@test.com" }, { "X-Forwarded-For": "192.0.2.20" });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(await r.json(), { ok: true });
    await settle(s.fp); const all = s.lines.join("\n");
    assert.ok(all.includes("RESEND_403") && all.includes("[email]") && all.includes("[url]"), all);
    for (const x of ["owner@private.com", "learner@test.com", "OOB123", "resend.com/domains", "reset-password.html"]) assert.ok(!all.includes(x), "в логе нет: " + x);
  } finally { s.srv.close(); }
});

test("выбор провайдера однозначен: MAIL_PROVIDER решает, без молчаливого переключения", () => {
  const both = { MAIL_FROM: "a@b.c", RESEND_API_KEY: "re_x", SMTP_HOST: "h", SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASS: "p" };
  assert.strictEqual(createMailer({ ...both, MAIL_PROVIDER: "resend" }).provider, "resend");
  assert.strictEqual(createMailer({ ...both, MAIL_PROVIDER: "smtp" }).provider, "smtp");
  const m = createMailer({ MAIL_PROVIDER: "smtp", MAIL_FROM: "a@b.c", RESEND_API_KEY: "re_x" });
  assert.strictEqual(m.configured, false, "SMTP не настроен — Resend не подставляется сам"); assert.deepStrictEqual(m.missing, ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"]);
  assert.strictEqual(createMailer({ ...both, MAIL_PROVIDER: "sendgrid" }).configured, false);
  assert.strictEqual(createMailer({ ...both, MAIL_PROVIDER: " RESEND " }).provider, "resend");
});
