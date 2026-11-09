"use strict";
/* Аудит безопасности: старые публичные маршруты и заголовки. Данные поддельные, реальные системы не затрагиваются. */
const test = require("node:test"), assert = require("node:assert/strict");
const LG = require("../academy/legacy-guard");
const res = () => { const r = { code: 200, body: undefined, headers: {} }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; r.send = b => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
const SECRET = "s".repeat(24) + "-postback-secret", log = { log() {} };
test("/deposit: без секрета, с неверным, с коротким секретом в окружении — отказ, память не меняется (раньше любой мог «внести депозит»)", () => {
  const dep = {}; const h = env => LG.depositHandler({ env, getDeposits: () => dep, log });
  for (const [env, q] of [[{ POCKET_POSTBACK_SECRET: SECRET }, { trader_id: "T1", amount: "50" }], [{ POCKET_POSTBACK_SECRET: SECRET }, { trader_id: "T1", amount: "50", secret: "wrong" }], [{ POCKET_POSTBACK_SECRET: "short" }, { trader_id: "T1", amount: "50", secret: "short" }], [{}, { trader_id: "T1", amount: "50", secret: "" }], [{ POCKET_POSTBACK_SECRET: SECRET }, { trader_id: "T1", amount: "50", secret: [SECRET] }]]) { const r = res(); h(env)({ query: q }, r); assert.equal(r.code, 403); assert.deepEqual(dep, {}); }
});
test("/deposit с верным секретом: принимает только корректные значения", () => {
  const dep = {}, h = LG.depositHandler({ env: { POCKET_POSTBACK_SECRET: SECRET }, getDeposits: () => dep, log });
  for (const q of [{ trader_id: "../x", amount: "5" }, { trader_id: "T1", amount: "-5" }, { trader_id: "T1", amount: "abc" }, { trader_id: "T1", amount: "1e9" }, { trader_id: "T".repeat(65), amount: "5" }, { amount: "5" }]) { const r = res(); h({ query: Object.assign({ secret: SECRET }, q) }, r); assert.equal(r.code, 400, JSON.stringify(q)); }
  assert.deepEqual(dep, {}); const r = res(); h({ query: { secret: SECRET, trader_id: "T-1_a", amount: "50.5" } }, r); assert.equal(r.code, 200); assert.deepEqual(dep, { "T-1_a": 50.5 });
  const proto = {}; h({ query: { secret: SECRET, trader_id: "__proto__", amount: "5" } }, res()); assert.equal(({}).polluted, undefined, "загрязнения прототипа нет");
});
test("/dev-deposit: только при DEV_KEY ≥16 символов; сравнение за постоянное время; значения проверяются", () => {
  const dep = {}, K = "dev-key-0123456789", h = env => LG.devDepositHandler({ env, getDeposits: () => dep, log });
  for (const [env, q] of [[{}, { key: "x" }], [{ DEV_KEY: "short" }, { key: "short" }], [{ DEV_KEY: K }, { key: "nope", trader_id: "T1" }], [{ DEV_KEY: K }, {}]]) { const r = res(); h(env)({ query: q }, r); assert.equal(r.code, 403); } assert.deepEqual(dep, {});
  let r = res(); h({ DEV_KEY: K })({ query: { key: K, trader_id: "bad id!", amount: "5" } }, r); assert.equal(r.code, 400); r = res(); h({ DEV_KEY: K })({ query: { key: K, trader_id: "T1", amount: "30" } }, r); assert.equal(r.body, "ok"); assert.equal(dep.T1, 30); h({ DEV_KEY: K })({ query: { key: K, trader_id: "T1", amount: "10" } }, res()); assert.equal(dep.T1, 30, "меньшая сумма не затирает");
});
test("/setpair: только пары из списка сервера (раньше любая строка, в том числе разметка)", () => {
  let cur = "EUR/USD"; const pairs = ["EUR/USD", "GBP/USD", "BTC"], h = LG.setPairHandler({ getPairs: () => pairs, setPair: p => { cur = p; } });
  for (const p of ["<script>alert(1)</script>", "XXX/YYY", "EUR/USD ", "eur/usd", "A".repeat(40), "", ["BTC"], { a: 1 }, "__proto__"]) { const r = res(); h({ query: { pair: p } }, r); assert.equal(r.code, 400, JSON.stringify(p)); assert.equal(cur, "EUR/USD"); }
  const r = res(); h({ query: { pair: "BTC" } }, r); assert.equal(r.code, 200); assert.equal(cur, "BTC"); const r2 = res(); h({ query: {} }, r2); assert.equal(r2.code, 200); assert.equal(cur, "BTC");
  assert.ok(LG.validPair("USD/JPY") && !LG.validPair("USD/JPY/X") && !LG.validPair(5));
});
test("заголовки безопасности: nosniff и Referrer-Policy всегда, HSTS только по https (в том числе за прокси)", () => {
  const run = req => { const r = res(); let nx = 0; LG.securityHeaders()(req, r, () => nx++); assert.equal(nx, 1); return r.headers; };
  const http = run({ headers: {} }); assert.equal(http["X-Content-Type-Options"], "nosniff"); assert.equal(http["Referrer-Policy"], "strict-origin-when-cross-origin"); assert.equal(http["Strict-Transport-Security"], undefined);
  assert.match(run({ headers: { "x-forwarded-proto": "https" } })["Strict-Transport-Security"], /max-age=\d+/); assert.match(run({ secure: true, headers: {} })["Strict-Transport-Security"], /max-age/); assert.equal(run({ headers: { "x-forwarded-proto": "http" } })["Strict-Transport-Security"], undefined);
  assert.equal(LG.safeEqual("a", "ab"), false); assert.equal(LG.safeEqual("same", "same"), true);
});
test("server.js использует защитные обработчики и не содержит прежних открытых записей депозита", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  assert.match(src, /LG\.depositHandler/); assert.match(src, /LG\.setPairHandler/); assert.match(src, /LG\.devDepositHandler/); assert.match(src, /LG\.securityHeaders/); assert.match(src, /disable\("x-powered-by"\)/);
  assert.ok(!/app\.get\("\/deposit",\s*\(req,\s*res\)\s*=>/.test(src), "прежний открытый /deposit удалён"); assert.ok(!/currentPair\s*=\s*pair\b/.test(src), "прежняя запись пары без проверки удалена");
});
