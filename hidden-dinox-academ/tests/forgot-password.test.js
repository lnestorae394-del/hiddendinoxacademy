"use strict";
/* Восстановление пароля письмом Hidden Dinox Academy: POST /api/auth/forgot-password, Resend, SMTP. */
const test = require("node:test"), assert = require("node:assert");
const net = require("net"), tls = require("tls"), fs = require("fs"), os = require("os"), path = require("path"), { execFileSync } = require("child_process");
const { createForgotPassword } = require("../academy/forgot-password");
const { createMailer, smtpSend } = require("../academy/mailer");
const BASE = "https://hidden-dinox-academy-test2.onrender.com";
const ENV = { APP_BASE_URL: BASE };
const USERS = new Set(["learner@test.com"]);
const fakeAuth = { async generatePasswordResetLink(email) {
  if (!USERS.has(email)) throw Object.assign(new Error("There is no user record"), { code: "auth/email-not-found" });
  return "https://ai-boost-10540.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=SECRETCODE123&apiKey=AIzaKEY&lang=en"; } };
function memMailer(fail) { const sent = []; return { configured: true, provider: "test", from: "Hidden Dinox Academy <no-reply@x.test>", missing: [], sent,
  async send(m) { if (fail) throw Object.assign(new Error("boom secret-pass"), { code: "SMTP_535" }); sent.push(m); return { id: "1" }; } }; }
function logger() { const lines = []; const f = (...a) => lines.push(a.join(" ")); return { lines, log: f, warn: f, error: f }; }
function call(fp, body, ip = "1.2.3.4") {
  const res = { statusCode: 200, headers: {}, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; } };
  // запрос глазами Express при TRUST_PROXY=1: прокси доверенный, req.ip вычислен Express (адрес, добавленный прокси)
  return fp.handler({ body, headers: { "x-forwarded-for": ip }, ip, app: { get: k => (k === "trust proxy" ? 1 : undefined) } }, res).then(job => ({ res, job }));
}
let t0 = 0; const now = () => t0;

test("неверный email → 400 INVALID_EMAIL; почта не настроена → 503 MAIL_NOT_CONFIGURED", async () => {
  const fp = createForgotPassword({ authAdmin: fakeAuth, mailer: memMailer(), env: ENV, log: logger(), now });
  for (const e of ["", "abc", "a@b", "a b@c.com", 123, "x".repeat(250) + "@a.com", null]) assert.strictEqual((await call(fp, { email: e })).res.statusCode, 400, String(e));
  const nm = createForgotPassword({ authAdmin: fakeAuth, mailer: { configured: false, missing: ["MAIL_PROVIDER"] }, env: ENV, log: logger(), now });
  const r = await call(nm, { email: "learner@test.com" }); assert.strictEqual(r.res.statusCode, 503); assert.strictEqual(r.res.body.error, "MAIL_NOT_CONFIGURED");
  const nb = createForgotPassword({ authAdmin: fakeAuth, mailer: memMailer(), env: {}, log: logger(), now });
  assert.strictEqual((await call(nb, { email: "learner@test.com" })).res.statusCode, 503, "без APP_BASE_URL ссылку не строим");
});

test("существующий аккаунт: письмо со ссылкой на нашу страницу (oobCode, язык); несуществующий — тот же ответ, без письма", async () => {
  const m = memMailer(), L = logger();
  const fp = createForgotPassword({ authAdmin: fakeAuth, mailer: m, env: ENV, log: L, now });
  const a = await call(fp, { email: "  Learner@Test.com ", lang: "ua" });
  assert.strictEqual(a.res.statusCode, 200); assert.deepStrictEqual(a.res.body, { ok: true }); assert.strictEqual(await a.job, "sent");
  assert.strictEqual(m.sent.length, 1); const mail = m.sent[0];
  assert.strictEqual(mail.to, "learner@test.com");
  const link = BASE + "/academy/reset-password.html?mode=resetPassword&oobCode=SECRETCODE123&lang=uk";
  assert.ok(mail.html.includes(link.replace(/&/g, "&amp;")) && mail.text.includes(link), "ссылка на /academy/reset-password.html");
  assert.ok(!mail.html.includes("firebaseapp.com") && !mail.html.includes("AIzaKEY"), "в письме нет адреса Firebase и apiKey");
  assert.ok(mail.html.includes("Скинути пароль") && mail.subject.includes("Hidden Dinox Academy") && !/ai-boost/i.test(mail.html + mail.subject));
  const b = await call(fp, { email: "nobody@test.com" });
  assert.strictEqual(b.res.statusCode, a.res.statusCode); assert.deepStrictEqual(b.res.body, a.res.body);
  assert.strictEqual(await b.job, "no_account"); assert.strictEqual(m.sent.length, 1, "письмо не отправлено");
  const all = L.lines.join("\n");
  for (const secret of ["learner@test.com", "Learner@Test.com", "nobody@test.com", "SECRETCODE123", "AIzaKEY", "reset-password.html", "http"])
    assert.ok(!all.includes(secret), "в логах нет: " + secret);
});

test("язык письма: ru по умолчанию, en; неизвестный язык → ru", async () => {
  const m = memMailer(); const fp = createForgotPassword({ authAdmin: fakeAuth, mailer: m, env: ENV, log: logger(), now: () => 0, limits: { email: { n: 9, ms: 1e6 }, ip: { n: 9, ms: 1e6 }, global: { n: 9, ms: 1e6 } } });
  await (await call(fp, { email: "learner@test.com", lang: "en" })).job; await (await call(fp, { email: "learner@test.com", lang: "xx" })).job;
  assert.ok(m.sent[0].html.includes("Reset password") && m.sent[0].text.includes("lang=en"));
  assert.ok(m.sent[1].html.includes("Сбросить пароль") && m.sent[1].text.includes("lang=ru"));
});

test("ограничение частоты: 3 письма на email в час, 10 запросов с IP за 15 минут → 429 + Retry-After", async () => {
  t0 = 1e9; const fp = createForgotPassword({ authAdmin: fakeAuth, mailer: memMailer(), env: ENV, log: logger(), now });
  for (let i = 0; i < 3; i++) assert.strictEqual((await call(fp, { email: "learner@test.com" }, "9.9.9." + i)).res.statusCode, 200);
  const r = await call(fp, { email: "learner@test.com" }, "9.9.9.200"); assert.strictEqual(r.res.statusCode, 429); assert.ok(Number(r.res.headers["Retry-After"]) > 0);
  t0 += 61 * 60e3; assert.strictEqual((await call(fp, { email: "learner@test.com" }, "9.9.9.201")).res.statusCode, 200, "через час снова можно");
  for (let i = 0; i < 10; i++) assert.strictEqual((await call(fp, { email: `u${i}@test.com` }, "5.5.5.5")).res.statusCode, 200);
  assert.strictEqual((await call(fp, { email: "u99@test.com" }, "5.5.5.5")).res.statusCode, 429, "11-й запрос с IP");
  // несуществующий адрес ограничивается так же, как существующий (ответы неотличимы)
  for (let i = 0; i < 3; i++) await call(fp, { email: "ghost@test.com" }, "7.7.7." + i);
  assert.strictEqual((await call(fp, { email: "ghost@test.com" }, "7.7.7.9")).res.statusCode, 429);
});

test("сбой почты: пользователь получает обычный ответ, в логе код ошибки без секретов", async () => {
  const L = logger(); const fp = createForgotPassword({ authAdmin: fakeAuth, mailer: memMailer(true), env: ENV, log: L, now: () => 0 });
  const r = await call(fp, { email: "learner@test.com" }); assert.strictEqual(r.res.statusCode, 200); assert.strictEqual(await r.job, "mail_error");
  const all = L.lines.join("\n"); assert.ok(all.includes("SMTP_535") && !all.includes("secret-pass") && !all.includes("learner@test.com") && !all.includes("SECRETCODE123"));
});

test("createMailer: список недостающих переменных; Resend — правильный запрос и ошибка без ключа в сообщении", async () => {
  assert.deepStrictEqual(createMailer({}).missing, ["MAIL_PROVIDER (resend или smtp)", "MAIL_FROM"]);
  assert.deepStrictEqual(createMailer({ MAIL_PROVIDER: "smtp", MAIL_FROM: "a@b.c", SMTP_HOST: "h" }).missing, ["SMTP_PORT", "SMTP_USER", "SMTP_PASS"]);
  let seen; const fetchImpl = async (url, o) => { seen = { url, o }; return { ok: true, status: 200, json: async () => ({ id: "re_1" }) }; };
  const m = createMailer({ MAIL_PROVIDER: "resend", MAIL_FROM: "Hidden Dinox Academy <no-reply@x.test>", RESEND_API_KEY: "re_SECRET" }, { fetchImpl });
  assert.ok(m.configured); const out = await m.send({ to: "a@b.com\r\nBcc: evil@x.com", subject: "S", html: "<b>h</b>", text: "t" });
  assert.strictEqual(out.id, "re_1"); assert.strictEqual(seen.url, "https://api.resend.com/emails"); assert.strictEqual(seen.o.headers.Authorization, "Bearer re_SECRET");
  const body = JSON.parse(seen.o.body); assert.deepStrictEqual(body.to, ["a@b.com Bcc: evil@x.com"]); assert.strictEqual(body.from, "Hidden Dinox Academy <no-reply@x.test>");
  const bad = createMailer({ MAIL_PROVIDER: "resend", MAIL_FROM: "a@b.c", RESEND_API_KEY: "re_SECRET" }, { fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: "domain not verified" }) }) });
  await assert.rejects(bad.send({ to: "a@b.com", subject: "s", html: "h", text: "t" }), e => e.code === "RESEND_403" && e.providerMessage === "domain not verified" && !String(e.message).includes("re_SECRET"));
});

/* Настоящий SMTP-диалог с локальным сервером: STARTTLS (самоподписанный сертификат), AUTH PLAIN, DATA */
function certs() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "smtp-")); execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", d + "/k.pem", "-out", d + "/c.pem", "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  return { key: fs.readFileSync(d + "/k.pem"), cert: fs.readFileSync(d + "/c.pem") }; }
function fakeSmtp({ starttls = true, cred }) {
  const log = { auth: null, data: "", tls: false, rcpt: null, from: null };
  const srv = net.createServer(sock => {
    let s = sock, buf = "", inData = false;
    const w = l => s.write(l + "\r\n");
    const onLine = line => {
      if (inData) { if (line === ".") { inData = false; w("250 2.0.0 OK queued-abcdef123"); } else log.data += line + "\r\n"; return; }
      const u = line.toUpperCase();
      if (u.startsWith("EHLO")) { w("250-localhost"); if (starttls && !log.tls) w("250-STARTTLS"); w("250 AUTH PLAIN LOGIN"); }
      else if (u === "STARTTLS") { w("220 go"); s.removeAllListeners("data"); const t = new tls.TLSSocket(s, { isServer: true, ...cred }); s = t; log.tls = true; buf = ""; t.on("data", feed); }
      else if (u.startsWith("AUTH PLAIN")) { log.auth = Buffer.from(line.slice(11), "base64").toString(); w("235 ok"); }
      else if (u.startsWith("MAIL FROM")) { log.from = line; w("250 ok"); } else if (u.startsWith("RCPT TO")) { log.rcpt = line; w("250 ok"); }
      else if (u === "DATA") { inData = true; w("354 go"); } else if (u === "QUIT") { w("221 bye"); s.end(); } else w("500 ?");
    };
    const feed = d => { buf += d.toString(); let i; while ((i = buf.indexOf("\r\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); } };
    sock.on("data", feed); sock.on("error", () => {}); w("220 localhost ESMTP");
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ srv, port: srv.address().port, log })));
}
test("SMTP: STARTTLS + AUTH PLAIN + письмо в UTF-8 (имя отправителя, тема, HTML и текст)", async () => {
  const cred = certs(); const { srv, port, log } = await fakeSmtp({ starttls: true, cred });
  try {
    const out = await smtpSend({ host: "127.0.0.1", port, user: "mailer@x.test", pass: "app-pass", from: "Hidden Dinox Academy <mailer@x.test>", to: "learner@test.com",
      subject: "Восстановление пароля — Hidden Dinox Academy", html: "<a href=\"https://site/x?a=1\">Восстановить пароль</a>", text: "Восстановить пароль: https://site/x?a=1",
      tlsOptions: { rejectUnauthorized: false } });   // только в тесте: самоподписанный сертификат
    assert.ok(log.tls, "соединение переведено в TLS до авторизации"); assert.strictEqual(log.auth, "\0mailer@x.test\0app-pass");
    assert.strictEqual(log.from, "MAIL FROM:<mailer@x.test>"); assert.strictEqual(log.rcpt, "RCPT TO:<learner@test.com>");
    assert.ok(/^From: Hidden Dinox Academy <mailer@x\.test>$/m.test(log.data) && /^Subject: =\?UTF-8\?B\?/m.test(log.data));
    const parts = [...log.data.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)--/g)].map(m => Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString());
    assert.ok(parts.some(p => p.includes("Восстановить пароль: https://site/x?a=1")) && parts.some(p => p.includes("<a href=")), "текст и HTML");
    assert.ok(out.id);
  } finally { srv.close(); }
});
test("SMTP: без STARTTLS письмо не отправляется (пароль не уходит открытым текстом)", async () => {
  const { srv, port, log } = await fakeSmtp({ starttls: false });
  try { await assert.rejects(smtpSend({ host: "127.0.0.1", port, user: "u", pass: "p", from: "a@b.c", to: "x@y.z", subject: "s", html: "h", text: "t" }), e => e.code === "SMTP_NO_TLS"); assert.strictEqual(log.auth, null); }
  finally { srv.close(); }
});
