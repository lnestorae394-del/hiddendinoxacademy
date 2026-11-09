"use strict";
/* Проверка на эмуляторах Firebase (Auth + Firestore) и сервере в HD_TEST_MODE.
   ВНИМАНИЕ: в среде разработки этот скрипт НЕ запускался (нет Firebase CLI и сети).
   Требуется Node.js 18+ (встроенный fetch). Не использует реальные postback и production.

   Порядок запуска — см. ACADEMY_INTEGRATION.md, раздел «Тестовое окружение». */
const PROJECT = process.env.GCLOUD_PROJECT || "demo-hd-academy";
const AUTH = "http://" + (process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099");
const FS = "http://" + (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080");
const SERVER = process.env.SERVER_URL || "http://127.0.0.1:" + (process.env.PORT || 3000);
const SECRET = process.env.POCKET_POSTBACK_SECRET;
const PARAM = "secret";
if (!PROJECT.startsWith("demo-")) { console.error("Отказ: проект должен начинаться с demo-"); process.exit(2); }
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(SERVER)) { console.error("Отказ: SERVER_URL должен быть локальным"); process.exit(2); }
if (!SECRET) { console.error("Нужен POCKET_POSTBACK_SECRET (тот же, что у тестового сервера)"); process.exit(2); }

const results = []; let failed = 0;
const check = (name, ok, info) => { results.push((ok ? "✔ " : "✘ ") + name + (ok ? "" : " — " + JSON.stringify(info))); if (!ok) failed++; };
const j = async r => { try { return await r.json(); } catch (e) { return null; } };

async function signUp(email, password = "password123") {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  return { status: r.status, body: await j(r) };
}
async function signIn(email, password = "password123") {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  return { status: r.status, body: await j(r) };
}
async function api(method, path, token, body) {
  const r = await fetch(SERVER + path, { method, headers: Object.assign({}, token ? { Authorization: "Bearer " + token } : {}, body ? { "Content-Type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await j(r) };
}
async function postback(q, withSecret = true) {
  const p = new URLSearchParams(q); if (withSecret) p.set(PARAM, SECRET);
  const r = await fetch(SERVER + "/postback?" + p.toString()); return r.status; // 200 / 4xx / 5xx
}
async function newUser(tag, trader) {
  const email = `${tag}-${Date.now()}@test.local`;
  const s = await signUp(email); const token = s.body.idToken;
  await api("GET", "/api/me", token);
  const click = (await api("POST", "/api/click", token)).body.clickId;
  if (trader) {
    await postback({ click_id: click, trader_id: trader });                 // регистрация от «Pocket Partners»
    await api("POST", "/api/trader-id", token, { traderId: trader });
  }
  return { email, token, click, uid: s.body.localId };
}
const me = async u => (await api("GET", "/api/me", u.token)).body;
let traderSeq = 70000000 + Math.floor(Math.random() * 900000);
const nextTrader = () => String(++traderSeq);

(async () => {
  // Очистка данных эмуляторов перед проверкой
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
  await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });

  // --- Авторизация ---
  const a = await newUser("anna", null);
  check("регистрация в эмуляторе Auth", !!a.token);
  check("повторная регистрация того же email отклоняется", (await signUp(a.email)).status === 400);
  check("вход с верным паролем", (await signIn(a.email)).status === 200);
  check("вход с неверным паролем отклоняется", (await signIn(a.email, "wrong-password")).status === 400);
  const oob = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=demo-api-key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestType: "PASSWORD_RESET", email: a.email }) });
  check("письмо сброса пароля создаётся в эмуляторе", oob.status === 200);

  // --- Защита API ---
  check("без токена /api/me → 401", (await api("GET", "/api/me")).status === 401);
  check("с поддельным токеном /api/me → 401", (await api("GET", "/api/me", "x".repeat(40))).status === 401);
  const p0 = await me(a);
  check("ID-токен проверяется сервером, этап — broker", p0 && p0.stage === "broker", p0);
  const c1 = (await api("POST", "/api/click", a.token)).body.clickId, c2 = (await api("POST", "/api/click", a.token)).body.clickId;
  check("click_id устойчив", c1 === c2 && c1 === a.click, { c1, c2 });

  // --- Правила Firestore: клиент не может писать защищённые данные ---
  const fsDoc = p => `${FS}/v1/projects/${PROJECT}/databases/(default)/documents/${p}`;
  const w = await fetch(fsDoc(`users/${a.uid}?updateMask.fieldPaths=academyAccess`), { method: "PATCH", headers: { Authorization: "Bearer " + a.token, "Content-Type": "application/json" }, body: JSON.stringify({ fields: { academyAccess: { booleanValue: true } } }) });
  check("правила: клиент не может записать users/{uid}", w.status === 403, w.status);
  const rr = await fetch(fsDoc("referrals/1"), { headers: { Authorization: "Bearer " + a.token } });
  check("правила: клиент не может читать referrals", rr.status === 403, rr.status);
  const de = await fetch(fsDoc("deposit_events/x"), { method: "PATCH", headers: { Authorization: "Bearer " + a.token, "Content-Type": "application/json" }, body: JSON.stringify({ fields: { amount_cents: { integerValue: "999999" } } }) });
  check("правила: клиент не может создать deposit_events", de.status === 403, de.status);

  // --- Пороги и fail-closed ---
  async function scenario(name, steps, expectOpen, extra) {
    const t = nextTrader(); const u = await newUser(name, null);
    for (const s of steps) await postback({ click_id: u.click, trader_id: t, ...s.q }, s.secret !== false);
    await api("POST", "/api/trader-id", u.token, { traderId: t });
    const p = await me(u);
    check(`${name}: доступ ${expectOpen ? "открыт" : "закрыт"}`, p && p.academyAccess === expectOpen, p);
    if (extra) extra(p);
  }
  const REG = { q: {} }, FTD = a => ({ q: { amount: a, currency: "USD" } }), RED = a => ({ q: { type: "redeposit", amount: a, currency: "USD" } });
  await scenario("без секрета", [{ q: {}, secret: false }, { q: { amount: "500", currency: "USD" }, secret: false }], false);
  await scenario("FTD $39.99", [REG, FTD("39.99")], false);
  await scenario("FTD $40.00", [REG, FTD("40.00")], true);
  await scenario("FTD $35 + повторный $100", [REG, FTD("35"), RED("100")], false, p =>
    check("FTD $35 + $100: итог $135, 2 депозита", p.deposits && p.deposits.totals.USD === 135 && p.deposits.count === 2, p.deposits));
  await scenario("FTD $40 + повторный $60", [REG, FTD("40"), RED("60"), RED("60")], true, p =>
    check("FTD $40 + $60 (+дубль): FTD $40, итог $100, 2 депозита", p.firstDeposit.amount === 40 && p.deposits.totals.USD === 100 && p.deposits.count === 2, p));
  await scenario("неизвестная валюта", [REG, { q: { amount: "500", currency: "EUR" } }], false);

  // --- Изоляция пользователей и Trader ID ---
  const t = nextTrader(); const owner = await newUser("owner", t); const other = await newUser("other", null);
  const take = await api("POST", "/api/trader-id", other.token, { traderId: t });
  check("один Trader ID нельзя привязать ко второму аккаунту", take.status === 409, take);
  const po = await me(other);
  check("чужие данные не возвращаются", po.traderId === null && !JSON.stringify(po).includes(owner.email), po);
  const forged = await api("POST", "/api/trader-id", other.token, { traderId: nextTrader(), academyAccess: true, verified: true, deposits: { count: 9 } });
  check("случайный ID с полями доступа из браузера → 422", forged.status === 422, forged);
  check("postback без secret → 401", (await postback({ click_id: other.click, trader_id: nextTrader() }, false)) === 401);

  // --- Восстановление этапа после «нового входа» ---
  const again = await signIn(owner.email);
  const pr = (await api("GET", "/api/me", again.body.idToken)).body;
  check("после повторного входа этап восстановлен", pr.stage === "deposit" && pr.traderId === t, pr);

  console.log(results.join("\n"));
  console.log(`итого: ${results.length - failed} из ${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("Ошибка проверки:", e.message); process.exit(1); });
