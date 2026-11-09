"use strict";
/* POST /api/auth/forgot-password — письмо восстановления пароля от имени Hidden Dinox Academy.
   Ссылку создаёт Firebase Admin SDK (generatePasswordResetLink): одноразовый oobCode выдаёт и проверяет Firebase.
   Из неё берётся только oobCode, а ссылка в письме ведёт на страницу сайта /academy/reset-password.html,
   где новый пароль устанавливается через Firebase Auth (confirmPasswordReset).

   Защита:
   • ответ одинаковый для существующих и несуществующих адресов, работа выполняется ПОСЛЕ ответа (нет утечки и по времени);
   • ограничение частоты: на email, на IP и общий предел сервиса;
   • в логах нет email, ссылок и кодов — только категория результата и короткий хеш адреса. */
const crypto = require("crypto");
const { appBaseUrl } = require("./app-url");
const { renderResetEmail } = require("./reset-email");
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const LIMITS = { email: { n: 3, ms: 60 * 60e3 }, ip: { n: 10, ms: 15 * 60e3 }, global: { n: 200, ms: 60 * 60e3 } };
const NO_ACCOUNT = new Set(["auth/user-not-found", "auth/email-not-found", "auth/user-disabled", "auth/invalid-email"]);

/* IP клиента — только по правилам Express (req.ip) и настройке TRUST_PROXY (academy/index.js → app.set("trust proxy")).
   Сами заголовки X-Forwarded-For / CF-Connecting-IP / True-Client-IP здесь НЕ читаются: их может прислать клиент.
   При TRUST_PROXY=N Express отбрасывает значения, дописанные клиентом слева, и берёт адрес, добавленный доверенным прокси.
   Если запрос пришёл через прокси (есть X-Forwarded-For), а доверие не настроено, req.ip — это адрес самого прокси,
   общий для всех посетителей; такой IP помечается ненадёжным, и лимит по IP к нему не применяется
   (иначе один лимит действовал бы на всех сразу). Лимиты по email и общий предел работают всегда. */
function clientIp(req) {
  const h = req.headers || {};
  const viaProxy = !!h["x-forwarded-for"];
  const tp = req.app && typeof req.app.get === "function" ? req.app.get("trust proxy") : false;
  const proxyTrusted = !(tp === false || tp === undefined || tp === null || tp === 0 || tp === "false");
  const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || "unknown").replace(/^::ffff:/, "");
  return { ip, trusted: !viaProxy || proxyTrusted };
}
const idOf = email => crypto.createHash("sha256").update(email).digest("hex").slice(0, 10);   // для логов вместо адреса

function createForgotPassword({ authAdmin, mailer, env = process.env, log = console, now = () => Date.now(), limits = LIMITS }) {
  const hits = new Map();                                          // ключ → метки времени (одиночный сервис Render)
  function limited(key, { n, ms }) {
    const t = now(), arr = (hits.get(key) || []).filter(x => t - x < ms);
    if (arr.length >= n) { hits.set(key, arr); return Math.ceil((ms - (t - arr[0])) / 1000); }
    arr.push(t); hits.set(key, arr); return 0;
  }
  const sweep = setInterval(() => { const t = now(); for (const [k, v] of hits) if (!v.some(x => t - x < 60 * 60e3)) hits.delete(k); }, 10 * 60e3);
  if (sweep && typeof sweep.unref === "function") sweep.unref();   // не держит процесс; подменные таймеры в тестах без unref не ломают запуск
  const jobs = []; let warnedIp = false;
  async function work(email, lang, rid) {
    const base = appBaseUrl(env).url;
    let link;
    try { link = await authAdmin.generatePasswordResetLink(email); }
    catch (e) {
      const code = (e && (e.code || (e.errorInfo && e.errorInfo.code))) || "unknown";
      if (NO_ACCOUNT.has(code)) { log.log && log.log(`ℹ️ forgot-password ${rid}: аккаунт не найден или отключён (письмо не отправлено)`); return "no_account"; }
      log.error && log.error(`forgot-password ${rid}: Firebase не создал ссылку (${String(code).slice(0, 60)})`); return "firebase_error";
    }
    let oob = null;
    try { const u = new URL(link); oob = u.searchParams.get("oobCode"); if (!oob && u.searchParams.get("link")) oob = new URL(u.searchParams.get("link")).searchParams.get("oobCode"); } catch (e) {}
    if (!oob) { log.error && log.error(`forgot-password ${rid}: в ссылке Firebase нет oobCode`); return "bad_link"; }
    const url = `${base}/academy/reset-password.html?mode=resetPassword&oobCode=${encodeURIComponent(oob)}&lang=${lang === "ua" ? "uk" : lang}`;
    const msg = renderResetEmail({ link: url, email, lang, baseUrl: base });
    try { await mailer.send({ to: email, subject: msg.subject, html: msg.html, text: msg.text }); log.log && log.log(`✅ forgot-password ${rid}: письмо отправлено (${mailer.provider})`); return "sent"; }
    catch (e) { log.error && log.error(`forgot-password ${rid}: ошибка отправки ${mailer.provider}: ${String((e && e.code) || "error").slice(0, 40)}${e && e.providerMessage ? " — " + String(e.providerMessage).replace(/[^\s@<>"']+@[^\s@<>"']+/g, "[email]").replace(/https?:\/\/\S+/g, "[url]").slice(0, 160) : ""}`); return "mail_error"; }
  }
  async function handler(req, res) {
    res.set && res.set("Cache-Control", "no-store");
    const raw = req.body && req.body.email;
    const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) return res.status(400).json({ error: "INVALID_EMAIL" });
    const lang = ["ru", "en", "ua"].includes(req.body && req.body.lang) ? req.body.lang : "ru";
    if (!authAdmin || !mailer || !mailer.configured || !appBaseUrl(env).ok) return res.status(503).json({ error: "MAIL_NOT_CONFIGURED" });
    const cip = clientIp(req);
    if (!cip.trusted && !warnedIp) { warnedIp = true; log.warn && log.warn("⚠️ forgot-password: запрос через прокси, но TRUST_PROXY не задан — лимит по IP не применяется (лимиты по email и общий работают). На Render задайте TRUST_PROXY=1"); }
    const wait = limited("e:" + email, limits.email) || (cip.trusted ? limited("i:" + cip.ip, limits.ip) : 0) || limited("g", limits.global);
    if (wait) { res.set && res.set("Retry-After", String(wait)); return res.status(429).json({ error: "TOO_MANY" }); }
    const rid = idOf(email);
    res.status(200).json({ ok: true });                            // одинаковый ответ — до любой проверки аккаунта
    const p = work(email, lang, rid).catch(e => { log.error && log.error(`forgot-password ${rid}: ${String((e && e.code) || "error").slice(0, 40)}`); return "error"; });
    jobs.push(p); if (jobs.length > 50) jobs.shift();
    return p;
  }
  function status() { const m = mailer || {}; const site = appBaseUrl(env);
    return { configured: !!(authAdmin && m.configured && site.ok), provider: m.provider || null, from: m.from || null, missing: [...(m.missing || []), ...(site.ok ? [] : ["APP_BASE_URL"])] }; }
  return { handler, status, _jobs: jobs };
}
function registerForgotPassword(app, { authAdmin, env = process.env, log = console, mailer = null }) {
  const m = mailer || require("./mailer").createMailer(env);
  const fp = createForgotPassword({ authAdmin, mailer: m, env, log });
  app.post("/api/auth/forgot-password", (req, res) => { fp.handler(req, res).catch(() => {}); });
  app.use("/api/auth/forgot-password", (err, req, res, next) => {          // ошибки разбора тела (express.json в server.js)
    const type = (err && err.type) || "";
    if (type === "entity.too.large") return res.status(413).json({ error: "TOO_LARGE" });
    if (type === "entity.parse.failed" || type === "encoding.unsupported" || type === "charset.unsupported") return res.status(400).json({ error: "INVALID_REQUEST" });
    log.error && log.error("forgot-password: ошибка запроса (" + String(type || (err && err.code) || "error").slice(0, 40) + ")");
    return res.status(500).json({ error: "SERVER_ERROR" });
  });
  const st = fp.status();
  if (st.configured) log.log && log.log(`ℹ️ восстановление пароля: письма Hidden Dinox Academy через ${st.provider}`);
  else log.warn && log.warn(`⚠️ восстановление пароля: свои письма выключены (нет: ${st.missing.join(", ")}) — сайт использует письмо Firebase`);
  return fp;
}
module.exports = { createForgotPassword, registerForgotPassword, clientIp, EMAIL_RE, LIMITS };
