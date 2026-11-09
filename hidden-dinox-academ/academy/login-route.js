"use strict";
/* Страница входа по чистому адресу «/».
   • GET /  → существующий файл public/academy/index.html (без копии). Относительные пути страницы (css/…, js/…, assets/…)
     разрешаются от /academy/ благодаря <base href="/academy/"> в index.html — одинаково при открытии по «/» и по старому адресу.
   • /academy, /academy/, /academy/index.html → 302 на «/» (параметры запроса сохраняются, #якорь браузер переносит сам).
     302, а не 301: браузеры не запоминают перенаправление навсегда — решение можно откатить.
   Регистрируется ДО express.static("/academy"), иначе статика сама отдала бы index.html по старому адресу. */
const path = require("path");
const OLD_LOGIN_PATHS = ["/academy", "/academy/", "/academy/index.html"];
function loginTarget(originalUrl) {                          // всегда «/» + исходный query — открытого перенаправления нет
  const q = String(originalUrl || "").indexOf("?");
  return "/" + (q >= 0 ? String(originalUrl).slice(q) : "");
}
function registerLoginRoutes(app, publicDir) {
  const file = path.join(publicDir, "academy", "index.html");
  app.get("/", (req, res, next) => {
    res.set("Cache-Control", "no-cache");
    res.sendFile(file, err => { if (err) next(err); });
  });
  for (const p of OLD_LOGIN_PATHS) app.get(p, (req, res) => res.redirect(302, loginTarget(req.originalUrl)));
}
module.exports = { registerLoginRoutes, loginTarget, OLD_LOGIN_PATHS };
