"use strict";
/* Отправка писем академии без сторонних зависимостей.
   Провайдер выбирается переменными окружения Render:
     MAIL_PROVIDER = resend | smtp
     MAIL_FROM     = "Hidden Dinox Academy <no-reply@ваш-домен>"   (адрес должен быть разрешён у провайдера)
     MAIL_REPLY_TO = необязательно
     resend: RESEND_API_KEY
     smtp:   SMTP_HOST, SMTP_PORT (465 — TLS сразу, 587 — STARTTLS), SMTP_USER, SMTP_PASS
   Без шифрования письма не отправляются. Пароли, ключи и содержимое писем в логи не пишутся. */
const net = require("net"), tls = require("tls"), crypto = require("crypto"), os = require("os");

const clean = s => String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim();          // защита от подстановки заголовков
const addrOf = s => { const m = /<([^<>\s]+@[^<>\s]+)>/.exec(s); return clean(m ? m[1] : s); };
const enc = s => /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=";
function fromHeader(from) {                                                              // "Имя <адрес>" с кодированием имени
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(clean(from));
  return m && m[1] ? `${enc(m[1].trim())} <${m[2].trim()}>` : clean(from);
}
const b64lines = s => Buffer.from(s, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");

function buildMime({ from, to, replyTo, subject, html, text, now = new Date() }) {
  const boundary = "hd-" + crypto.randomBytes(12).toString("hex");
  const domain = (addrOf(from).split("@")[1] || "localhost").replace(/[^A-Za-z0-9.-]/g, "");
  const head = [
    `From: ${fromHeader(from)}`, `To: ${clean(to)}`, replyTo ? `Reply-To: ${clean(replyTo)}` : null,
    `Subject: ${enc(clean(subject))}`, `Date: ${now.toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(16).toString("hex")}@${domain}>`, "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ].filter(Boolean).join("\r\n");
  const part = (type, body) => `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64lines(body)}`;
  return `${head}\r\n\r\n${part("text/plain", text || "")}${part("text/html", html || "")}--${boundary}--\r\n`;
}

/* Минимальный SMTP-клиент: EHLO, STARTTLS/TLS, AUTH PLAIN/LOGIN, MAIL/RCPT/DATA, QUIT. */
function smtpSend(o) {
  const { host, port, user, pass, timeoutMs = 20000, tlsOptions = {}, allowInsecure = false } = o;
  const secure = o.secure != null ? o.secure : Number(port) === 465;
  return new Promise((resolve, reject) => {
    let sock, buf = "", waiter = null, done = false, timer;
    const fail = e => { if (done) return; done = true; clearTimeout(timer); try { sock && sock.destroy(); } catch (x) {} reject(e); };
    const ok = v => { if (done) return; done = true; clearTimeout(timer); try { sock.end(); } catch (x) {} resolve(v); };
    timer = setTimeout(() => fail(Object.assign(new Error("SMTP timeout"), { code: "SMTP_TIMEOUT" })), timeoutMs);
    const onData = d => { buf += d.toString("utf8"); const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) { if (/^\d{3} /.test(lines[i])) { const reply = lines.slice(0, i + 1).join("\n"); buf = lines.slice(i + 1).join("\r\n"); const w = waiter; waiter = null; w && w(reply); return; } } };
    const read = () => new Promise(r => { waiter = r; onData(""); });
    const cmd = async (line, expect) => { if (line != null) sock.write(line + "\r\n"); const r = await read(); const code = Number(r.slice(0, 3));
      if (!expect.includes(code)) throw Object.assign(new Error("SMTP " + code), { code: "SMTP_" + code, smtpCode: code, step: line ? line.split(" ")[0].replace(/:.*/, "") : "GREETING" }); return r; };
    const attach = s => { sock = s; s.on("data", onData); s.on("error", e => fail(Object.assign(new Error("SMTP connection"), { code: e.code || "SMTP_CONN" }))); };
    const opts = { host, port: Number(port), servername: host, ...tlsOptions };
    const run = async () => {
      await cmd(null, [220]);
      const me = clean(os.hostname() || "localhost").replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
      let ehlo = await cmd(`EHLO ${me}`, [250]);
      if (!secure) {
        if (/STARTTLS/i.test(ehlo)) {
          await cmd("STARTTLS", [220]);
          sock.removeListener("data", onData); buf = "";
          await new Promise((res, rej) => { const t = tls.connect({ socket: sock, servername: host, ...tlsOptions }, res); t.on("error", rej); attach(t); });
          ehlo = await cmd(`EHLO ${me}`, [250]);
        } else if (!allowInsecure) throw Object.assign(new Error("SMTP server offers no STARTTLS"), { code: "SMTP_NO_TLS" });
      }
      if (user) {
        if (/AUTH[^\n]*PLAIN/i.test(ehlo)) await cmd("AUTH PLAIN " + Buffer.from(`\0${user}\0${pass}`).toString("base64"), [235]);
        else { await cmd("AUTH LOGIN", [334]); await cmd(Buffer.from(user).toString("base64"), [334]); await cmd(Buffer.from(pass).toString("base64"), [235]); }
      }
      await cmd(`MAIL FROM:<${addrOf(o.from)}>`, [250]);
      await cmd(`RCPT TO:<${addrOf(o.to)}>`, [250, 251]);
      await cmd("DATA", [354]);
      const r = await cmd(buildMime(o).replace(/\r\n$/, "") + "\r\n.", [250]);
      try { sock.write("QUIT\r\n"); } catch (e) {}
      ok({ id: (r.match(/[A-Za-z0-9._-]{8,}/) || [null])[0] });
    };
    try { attach(secure ? tls.connect(opts) : net.connect(opts)); } catch (e) { return fail(e); }
    run().catch(fail);
  });
}

function createMailer(env = process.env, { fetchImpl = globalThis.fetch, smtpImpl = smtpSend } = {}) {
  const provider = String(env.MAIL_PROVIDER || "").trim().toLowerCase(), from = String(env.MAIL_FROM || "").trim(), replyTo = String(env.MAIL_REPLY_TO || "").trim() || null;
  const missing = [];
  if (!["resend", "smtp"].includes(provider)) missing.push("MAIL_PROVIDER (resend или smtp)");
  if (!/@/.test(from)) missing.push("MAIL_FROM");
  if (provider === "resend" && !env.RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (provider === "smtp") for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"]) if (!env[k]) missing.push(k);
  const configured = !missing.length;
  async function send({ to, subject, html, text }) {
    if (!configured) throw Object.assign(new Error("mail not configured"), { code: "MAIL_NOT_CONFIGURED" });
    if (provider === "resend") {
      const r = await fetchImpl("https://api.resend.com/emails", { method: "POST",
        headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [clean(to)], subject: clean(subject), html, text, ...(replyTo ? { reply_to: replyTo } : {}) }) });
      let j = null; try { j = await r.json(); } catch (e) {}
      if (!r.ok) throw Object.assign(new Error("Resend " + r.status), { code: "RESEND_" + r.status, providerMessage: j && typeof j.message === "string" ? j.message.slice(0, 160) : null });
      return { id: j && j.id };
    }
    return smtpImpl({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT), user: env.SMTP_USER, pass: env.SMTP_PASS, from, to, replyTo, subject, html, text });
  }
  return { configured, provider: configured ? provider : null, missing, from: configured ? from : null, send };
}
module.exports = { createMailer, smtpSend, buildMime };
