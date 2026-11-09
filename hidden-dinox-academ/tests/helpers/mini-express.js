"use strict";
/* Минимальная тестовая замена Express — ТОЛЬКО для сред без установленных зависимостей (npm install недоступен).
   Воспроизводит документированное поведение, на которое опирается forgot-password:
   • req.ip при app.set("trust proxy", N): доверяются N ближайших адресов (соединение и правые значения X-Forwarded-For),
     результат — первый недоверенный адрес (как proxy-addr в Express); без trust proxy — адрес соединения;
   • express.json(): лимит 100 КБ, ошибки type "entity.too.large" (413) и "entity.parse.failed" (400);
   • маршруты app.post/app.use(path, …), обработчики ошибок (4 аргумента), res.status/json/set.
   Если установлен настоящий express, тесты используют его. */
const http = require("http");
function express() {
  const settings = {}, stack = [];
  const app = { set(k, v) { settings[k] = v; return app; }, get(k) { return k in settings ? settings[k] : (k === "trust proxy" ? false : undefined); },
    use(a, ...rest) { const path = typeof a === "string" ? a : null; for (const fn of (path ? rest : [a, ...rest])) stack.push({ path, fn, err: fn.length === 4 }); return app; },
    post(path, fn) { stack.push({ path, fn, method: "POST", exact: true }); return app; },
    listen(port, host, cb) { const srv = http.createServer((req, res) => handle(req, res)); return srv.listen(port, host, cb); } };
  function ipOf(req) {
    const sock = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean).reverse();
    const all = [sock, ...xff], tp = app.get("trust proxy");
    const n = tp === true ? all.length : typeof tp === "number" ? tp : 0;
    return all[Math.min(n, all.length - 1)];
  }
  function handle(req, res) {
    req.app = app; req.ip = ipOf(req); req.body = undefined;
    res.status = c => { res.statusCode = c; return res; }; res.set = (k, v) => { res.setHeader(k, v); return res; };
    res.json = b => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(b)); return res; };
    let i = 0;
    const next = err => {
      while (i < stack.length) {
        const l = stack[i++], u = req.url.split("?")[0];
        if (l.path && !(l.exact ? u === l.path : u === l.path || u.startsWith(l.path + "/"))) continue;
        if (l.method && l.method !== req.method) continue;
        if (!!err !== !!l.err) continue;
        try { return err ? l.fn(err, req, res, next) : l.fn(req, res, next); } catch (e) { return next(e); }
      }
      if (err) { res.statusCode = 500; res.end("error"); } else { res.statusCode = 404; res.end("not found"); }
    };
    next();
  }
  return app;
}
express.json = ({ limit = 100 * 1024 } = {}) => (req, res, next) => {
  if (!/application\/json/.test(req.headers["content-type"] || "")) return next();
  const chunks = []; let size = 0, over = false;
  req.on("data", c => { size += c.length; if (size > limit) over = true; else chunks.push(c); });
  req.on("end", () => {
    if (over) return next(Object.assign(new Error("request entity too large"), { type: "entity.too.large", status: 413 }));
    const raw = Buffer.concat(chunks).toString("utf8");
    try { req.body = raw ? JSON.parse(raw) : {}; next(); } catch (e) { next(Object.assign(new Error("invalid json"), { type: "entity.parse.failed", status: 400, body: raw })); }
  });
};
module.exports = express;
