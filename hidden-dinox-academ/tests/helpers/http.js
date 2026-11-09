"use strict";
/* Мини-адаптер req/res в стиле Express для тестов обработчиков без установки Express */
function fakeReq({ token, body, ip } = {}) {
  return { headers: token ? { authorization: "Bearer " + token } : {}, body: body || {}, ip: ip || "127.0.0.1" };
}
function fakeRes() {
  const r = { statusCode: 200, body: undefined, headers: {} };
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  return r;
}
/* Проверка токена в тестах: "testtoken-<uid>" → { uid }. Любой другой — ошибка, как у Admin SDK. */
async function fakeVerify(token) {
  const m = /^testtoken-([A-Za-z0-9_]+)$/.exec(token);
  if (!m) throw new Error("auth/argument-error");
  return { uid: m[1], email: m[1] + "@test.local" };
}
module.exports = { fakeReq, fakeRes, fakeVerify };
