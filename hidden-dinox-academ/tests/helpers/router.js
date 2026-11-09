"use strict";
/* Вызов обработчиков по той же таблице маршрутов, что и на сервере (для тестов без Express) */
const { fakeRes } = require("./http");
function matcher(pattern) {
  const keys = []; const re = new RegExp("^" + pattern.replace(/:([a-z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  return path => { const m = path.match(re); if (!m) return null; const p = {}; keys.forEach((k, i) => (p[k] = decodeURIComponent(m[i + 1]))); return p; };
}
function adminCaller(api) {
  const table = api.ROUTES.map(([m, p, name, perm, mut]) => ({ m, match: matcher(p), h: api.handler(name, perm, mut) }));
  return async (method, fullPath, { uid, body, query, headers } = {}) => {
    const [path, qs] = fullPath.split("?"); query = { ...Object.fromEntries(new URLSearchParams(qs || "")), ...(query || {}) };   // поддержка ?q=…
    for (const r of table) { if (r.m !== method) continue; const params = r.match(path); if (!params) continue;
      const res = fakeRes(); await r.h({ params, query, body, headers: { ...(uid ? { authorization: "Bearer testtoken-" + uid } : {}), ...(headers || {}) } }, res); return res; }
    throw new Error("нет маршрута " + method + " " + path);
  };
}
function learnCaller(api) {
  const table = api.ROUTES.map(([m, p, name]) => ({ m, match: matcher(p), h: api.H[name] }));
  return async (method, fullPath, { uid, body } = {}) => {
    const [path, qs] = fullPath.split("?"); const query = Object.fromEntries(new URLSearchParams(qs || ""));   // поддержка ?lang=…
    for (const r of table) { if (r.m !== method) continue; const params = r.match(path); if (!params) continue;
      const res = fakeRes(); await r.h({ params, query, body, headers: uid ? { authorization: "Bearer testtoken-" + uid } : {} }, res); return res; }
    throw new Error("нет маршрута " + method + " " + path);
  };
}
module.exports = { adminCaller, learnCaller, matcher };
