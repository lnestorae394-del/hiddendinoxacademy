"use strict";
/* Публичный адрес сайта — ЕДИНАЯ настройка (переменная APP_BASE_URL на Render).
   Браузерная часть сайта адрес не хранит: она использует относительные пути и location.origin,
   поэтому при смене домена её менять не нужно. APP_BASE_URL нужен там, где адрес приходится
   указывать вне браузера: диагностика админки, шаблон письма (логотип), инструкции для Firebase Console. */
function appBaseUrl(env = process.env) {
  const raw = String(env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!raw) return { url: null, ok: false, hint: "APP_BASE_URL не задан — ссылки на сайте работают (они относительные), но для письма сброса пароля и Firebase Console адрес нужно указать вручную" };
  let u; try { u = new URL(raw); } catch (e) { return { url: null, ok: false, hint: "APP_BASE_URL — не URL: " + raw.slice(0, 80) }; }
  if (u.protocol !== "https:") return { url: null, ok: false, hint: "APP_BASE_URL должен начинаться с https://" };
  if (u.pathname !== "/" || u.search || u.hash) return { url: null, ok: false, hint: "APP_BASE_URL — только домен, без пути: https://example.com" };
  return { url: u.origin, ok: true,
    reset_action_url: u.origin + "/academy/reset-password.html",   // «Customize action URL» в шаблонах писем Firebase
    logo_url: u.origin + "/academy/assets/brand/hd-logo-email.png" };
}
module.exports = { appBaseUrl };
