"use strict";
/* HIDDEN DINOX VIDEO STUDIO — самостоятельный веб-сервер (без Express). Отдаёт ТОЛЬКО страницы входа/регистрации/восстановления/приложения и файлы из каталога public/video-studio по белому списку; всё остальное — 404. */
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { createVideoStudioApi } = require("./api"), { webConfig } = require("./firebase-init"), { BRAND_DIR } = require("./paths");
const SITE = path.join(__dirname, "..", "public", "video-studio");
const PAGES = { "/": "login.html", "/register": "register.html", "/forgot-password": "forgot.html", "/setup": "setup.html", "/app": "app.html" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };
const NAME = /^[A-Za-z0-9._-]{1,80}$/;
/* Белый список файлов сайта: только css/*.css, js/*.js, js/vs/*.js и логотипы; HTML отдаётся только по таблице PAGES */
function assetFile(p) {
  let m;
  if ((m = /^\/css\/([^/]+\.css)$/.exec(p)) && NAME.test(m[1])) return path.join(SITE, "css", m[1]);
  if ((m = /^\/js\/vs\/([^/]+\.js)$/.exec(p)) && NAME.test(m[1])) return path.join(SITE, "js", "vs", m[1]);
  if ((m = /^\/js\/([^/]+\.js)$/.exec(p)) && NAME.test(m[1])) return path.join(SITE, "js", m[1]);
  if ((m = /^\/assets\/brand\/([^/]+\.png)$/.exec(p)) && NAME.test(m[1])) return path.join(BRAND_DIR, m[1]);
  return null;
}
const CSP = "default-src 'self'; script-src 'self' https://www.gstatic.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.firebaseapp.com https://*.r2.cloudflarestorage.com; font-src 'self' data:; frame-src https://*.firebaseapp.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
function headers(extra) { return Object.assign({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin", "Permissions-Policy": "camera=(), microphone=(), geolocation=()", "Content-Security-Policy": CSP, "Strict-Transport-Security": "max-age=15552000" }, extra); }
const matcher = p => { const keys = []; const re = new RegExp("^" + p.replace(/:([a-z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$"); return u => { const m = u.match(re); if (!m) return null; const o = {}; keys.forEach((k, i) => { try { o[k] = decodeURIComponent(m[i + 1]); } catch (e) { o[k] = m[i + 1]; } }); return o; }; };
function createStandalone({ db, verifyIdToken, storage, runner, env = process.env, log = console }) {
  const api = createVideoStudioApi({ db, verifyIdToken, storage, runner, env, log }), wc = webConfig(env);
  const table = api.ROUTES.map(([m, p, name, perm, mut]) => ({ m, match: matcher(p), h: api.handler(name, perm, mut) }));
  const send = (res, code, body, type, extra) => { const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body)); res.writeHead(code, headers(Object.assign({ "Content-Type": type || "application/json; charset=utf-8", "Content-Length": buf.length, "Cache-Control": "no-store" }, extra))); res.end(buf); };
  const clientIp = req => (env.TRUST_PROXY === "0" ? "" : String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || (req.socket && req.socket.remoteAddress) || "-";
  function configJs() { const c = wc.config ? JSON.stringify(wc.config) : "null"; return "window.VS_STANDALONE=true;window.VS_FIREBASE_CONFIG=" + c + ";" + (wc.error ? "window.VS_CONFIG_ERROR=" + JSON.stringify(wc.error) + ";" : ""); }
  async function readBody(req, limit = 2 * 1024 * 1024) { const chunks = []; let n = 0, over = false; for await (const c of req) { n += c.length; if (n > limit) { over = true; if (n > limit * 10) { req.destroy(); break; } continue; } chunks.push(c); } if (over) { const e = new Error("TOO_LARGE"); e.status = 413; throw e; } return Buffer.concat(chunks); }   // слишком большое тело дочитывается и отбрасывается, чтобы клиент получил 413, а не обрыв соединения
  async function handler(req, res) {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    try {
      if (req.method === "GET" && p === "/healthz") return send(res, 200, { ok: true });
      if (req.method === "GET" && p === "/firebase-config.js") return send(res, 200, configJs(), TYPES[".js"]);
      if ((req.method === "GET" || req.method === "HEAD") && PAGES[p]) return send(res, 200, fs.readFileSync(path.join(SITE, PAGES[p])), TYPES[".html"]);
      if ((req.method === "GET" || req.method === "HEAD") && /^\/(assets|css|js)\//.test(p)) {
        const f = assetFile(p); if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, { error: "NOT_FOUND" });
        const st = fs.statSync(f), etag = '"' + st.size + "-" + Math.floor(st.mtimeMs) + '"'; if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers({ ETag: etag })); return res.end(); }
        return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)] || "application/octet-stream", { ETag: etag, "Cache-Control": "no-cache" });
      }
      if (p === "/api/video-studio" || p.startsWith("/api/video-studio/")) {
        const sub = p.slice("/api/video-studio".length) || "/"; let body;
        if (req.method !== "GET" && req.method !== "HEAD") { const raw = await readBody(req); if (raw.length) { try { body = JSON.parse(raw.toString("utf8")); } catch (e) { return send(res, 400, { error: "BAD_REQUEST", message: "Некорректный запрос" }); } } }
        const r = { method: req.method, headers: req.headers, query: Object.fromEntries(u.searchParams), body, ip: clientIp(req), protocol: String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim(), originalUrl: req.url };
        const out = { code: 200, h: {}, status(c) { out.code = c; return out; }, set(k, v) { out.h[k] = v; return out; }, json(b) { send(res, out.code, b, undefined, out.h); }, send(b) { send(res, out.code, b, undefined, out.h); } };
        if (req.method === "POST" && sub === "/telegram/webhook") return api.webhook(Object.assign(r, { params: {} }), out);
        for (const t of table) { if (t.m !== req.method) continue; const params = t.match(sub); if (!params) continue; return t.h(Object.assign(r, { params }), out); }
        return send(res, 404, { error: "NOT_FOUND" });
      }
      return send(res, 404, { error: "NOT_FOUND" });
    } catch (e) { if (e && e.status === 413) return send(res, 413, { error: "TOO_LARGE" }); log.error && log.error("video-studio: ", req.method, p, e && e.message); try { send(res, 500, { error: "INTERNAL" }); } catch (x) { /* ответ уже отправлен */ } }
  }
  return { handler, api, config: wc, server: () => http.createServer(handler) };
}
/* Режим «не настроено»: сервер отвечает понятным сообщением, а не падает (Render не уходит в бесконечный перезапуск) */
function misconfigured(reason) { return http.createServer((req, res) => { const b = Buffer.from(JSON.stringify({ error: "NOT_CONFIGURED", message: reason })); res.writeHead(req.url === "/healthz" ? 200 : 503, headers({ "Content-Type": "application/json; charset=utf-8", "Content-Length": b.length })); res.end(b); }); }
module.exports = { createStandalone, misconfigured, PAGES, assetFile, CSP };
