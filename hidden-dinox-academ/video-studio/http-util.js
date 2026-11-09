"use strict";
/* Простой HTTP-запрос с любыми заголовками (в том числе Origin) — для сквозной проверки хранилища. Адреса — только подписанные ссылки, которые создал сам сервер (не пользовательский ввод). */
const http = require("http"), https = require("https");
function httpRequest(urlStr, { method = "GET", headers = {}, body = null, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr), mod = u.protocol === "http:" ? http : https, h = Object.assign({}, headers); if (body) h["Content-Length"] = Buffer.byteLength(body);
    const req = mod.request(u, { method, headers: h, timeout: timeoutMs }, res => { const c = []; res.on("data", x => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))); req.on("error", reject); if (body) req.write(body); req.end();
  });
}
module.exports = { httpRequest };
