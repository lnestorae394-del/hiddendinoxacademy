"use strict";
/* Запускает НАСТОЯЩИЙ server.js в отдельной временной папке. Заменены только внешние пакеты
   (express, firebase-admin, simple-git) и, при необходимости, файлы ботов. Печатает JSON-наблюдения.
   Сценарий задаётся переменными окружения процесса и аргументом WITH_BOTS=1. */
const fs = require("fs"), os = require("os"), path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-boot-"));
const cp = rel => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel)); };
const write = (rel, s) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), s); };
cp("server.js"); for (const f of fs.readdirSync(path.join(ROOT, "academy"))) cp("academy/" + f);
for (const f of fs.readdirSync(path.join(ROOT, "bot")).filter(f => f.endsWith(".js"))) cp("bot/" + f);   // Telegram-бот (без видео: бот здесь не включён)
if (process.argv.includes("WITH_BOTS")) {
  write("public/bot/bot.js", "global.__obs.botsLoaded++; module.exports={};");
  write("public/bot/partnerBot.js", "global.__obs.botsLoaded++; module.exports={approveTrader(){ global.__obs.approveCalls++ }};");
}
const H = p => JSON.stringify(path.join(ROOT, "tests/helpers", p));
write("node_modules/simple-git/index.js", "module.exports=()=>({add:async()=>{},commit:async()=>{},push:async()=>{ global.__obs.gitPush++ }});");
write("node_modules/firebase-admin/index.js", `const {FakeFirestore}=require(${H("fake-firestore.js")}); const {fakeVerify}=require(${H("http.js")}); let db=null;
module.exports={ initializeApp(o){ global.__obs.init = o && o.credential ? "credential:"+o.projectId : "projectId:"+(o&&o.projectId); db=new FakeFirestore(); global.__db=db; },
 credential:{ cert(x){ return { cert:true } } }, firestore(){ return db; }, auth(){ return { verifyIdToken: fakeVerify, async getUser(uid){ if (uid === "OwnerUid0000000000000001") return { uid, email: "owner@test" }; const e = new Error("nf"); e.code = "auth/user-not-found"; throw e; } }; } };`);
write("node_modules/express/index.js", `function express(){ const app={stack:[],use(...a){const p=typeof a[0]==='string'?a.shift():'/';for(const fn of a)app.stack.push({kind:'use',path:p,fn});return app},get(p,fn){app.stack.push({kind:'get',path:p,fn});return app},post(p,fn){app.stack.push({kind:'post',path:p,fn});return app},set(){return app},listen(){global.__obs.listening=true;return{close(){}}}}; global.__app=app; return app; }
express.static=(d,o)=>{const f=(q,r,n)=>n();f.__static=d;f.__opts=o;return f};express.json=()=>{const f=(q,r,n)=>n();f.__json=true;return f};express.raw=()=>{const f=(q,r,n)=>n();f.__raw=true;return f};
express.Router=()=>{const r={routes:[],use(...a){r.routes.push(['use',...a]);return r},get(p,f){r.routes.push(['get',p,f]);return r},post(p,f){r.routes.push(['post',p,f]);return r},put(p,f){r.routes.push(['put',p,f]);return r},delete(p,f){r.routes.push(['delete',p,f]);return r}};const f=(q,s,n)=>n();return Object.assign(f,r,{__router:r})};module.exports=express;`);

global.__obs = { listening: false, error: null, botsLoaded: 0, approveCalls: 0, gitIntervals: 0, init: null, logs: [], steps: {} };
process.chdir(tmp);
const realSI = global.setInterval, realST = global.setTimeout, L = console.log, W = console.warn, E = console.error;
const cap = (...a) => global.__obs.logs.push(a.map(String).join(" "));
console.log = cap; console.warn = cap; console.error = cap;
global.setInterval = (fn, ms) => { if (ms === 300000) global.__obs.gitIntervals++; return 0; };
global.setTimeout = (f, ms) => (ms > 100 ? 0 : realST(f, ms));
try { require(path.join(tmp, "server.js")); } catch (e) { global.__obs.error = e.message; }
global.setInterval = realSI;

const res = () => { const r = { code: 200, body: null }; r.status = c => (r.code = c, r); r.json = b => (r.body = b, r); r.send = b => (r.body = b, r); r.set = () => r; return r; };
const route = (kind, p) => { const l = global.__app && global.__app.stack.find(x => x.kind === kind && x.path === p); return l && l.fn; };
const apiRoute = (m, p) => { const a = global.__app.stack.find(x => x.kind === "use" && x.path === "/api"); return a.fn.__router.routes.find(r => r[0] === m && r[1] === p)[2]; };
const pb = async q => { const r = res(); await route("get", "/postback")({ query: q, ip: "127.0.0.1" }, r); return { code: r.code, status: r.body && r.body.status }; };
const api = async (m, p, uid, body) => { const r = res(); await apiRoute(m, p)({ headers: uid ? { authorization: "Bearer testtoken-" + uid } : {}, body: body || {} }, r); return { code: r.code, body: r.body }; };

(async () => {
  const O = global.__obs, S = O.steps, sec = process.env.POCKET_POSTBACK_SECRET;
  try {
  if (O.listening && global.__app) {
    const st = global.__app.stack;
    const mount = p => st.find(x => x.kind === "use" && x.path === p);
    const adm = mount("/admin/api"), apiR = mount("/api");
    O.mounts = {
      adminApi: !!(adm && adm.fn.__router), adminApiRoutes: adm && adm.fn.__router ? adm.fn.__router.routes.filter(r => r[0] !== "use").map(r => r[0].toUpperCase() + " " + r[1]) : [],
      adminStatic: st.some(x => x.kind === "use" && x.path === "/admin" && x.fn.__static && /public[\\/]admin$/.test(x.fn.__static)),
      learn: apiR && apiR.fn.__router ? apiR.fn.__router.routes.filter(r => r[0] !== "use").map(r => r[0].toUpperCase() + " " + r[1]) : [],
      media: st.some(x => x.kind === "get" && x.path === "/media/:id"),
      adminBeforeApi404: st.findIndex(x => x.path === "/admin/api") >= 0,
      // страница входа по «/»: порядок регистрации и что именно отдаётся
      rootIdx: st.findIndex(x => x.kind === "get" && x.path === "/"),
      oldLoginIdx: ["/academy", "/academy/", "/academy/index.html"].map(p => st.findIndex(x => x.kind === "get" && x.path === p)),
      academyStaticIdx: st.findIndex(x => x.kind === "use" && x.path === "/academy" && x.fn.__static),
      publicStaticIdx: st.findIndex(x => x.kind === "use" && x.fn.__static && /public$/.test(String(x.fn.__static))),
      legacyGets: st.filter(x => x.kind === "get" && ["/index", "/login", "/register", "/signals", "/history", "/rules", "/deposit", "/pocket", "/instruction", "/delete", "/about"].includes(x.path)).map(x => x.path),
      rootServes: (() => { const r = st.find(x => x.kind === "get" && x.path === "/"); if (!r) return null; let f = null; r.fn({}, { set() { return this; }, sendFile(p) { f = p; } }, () => {}); return f; })(),
      oldLoginRedirect: (() => { const r = st.find(x => x.kind === "get" && x.path === "/academy/index.html"); if (!r) return null; let out = null; r.fn({ originalUrl: "/academy/index.html?via=abc" }, { redirect(c, l) { out = [c, l]; } }); return out; })()
    };
  }
  if (O.listening && process.argv.includes("FLOW")) {
    S.me401 = (await api("get", "/me")).code;
    S.meNoFirebase = global.__db ? null : (await api("get", "/me", "u1")).code;
    if (global.__db) {
      await api("get", "/me", "u1");
      const click = (await api("post", "/click", "u1")).body.clickId;
      S.forgedNoSecret = await pb({ click_id: click, trader_id: "55500001" });
      S.forgedWrong = await pb({ click_id: click, trader_id: "55500001", secret: "wrong-secret-0123456789abcdef" });
      S.legacyAfterForged = (global.__db.dump("referrals")["55500001"] || null);
      S.randomId = (await api("post", "/trader-id", "u1", { traderId: "99999999" })).code;
      S.reg = await pb({ click_id: click, trader_id: "55500001", secret: sec });
      S.regDup = await pb({ click_id: click, trader_id: "55500001", secret: sec });
      S.bind = (await api("post", "/trader-id", "u1", { traderId: "55500001" })).code;
      S.ftd = await pb({ click_id: click, trader_id: "55500001", amount: "40.00", currency: "USD", secret: sec });
      S.redep = await pb({ type: "redeposit", click_id: click, trader_id: "55500001", amount: "60", currency: "USD", secret: sec });
      S.redepDup = await pb({ type: "redeposit", click_id: click, trader_id: "55500001", amount: "60", currency: "USD", secret: sec });
      S.macro = await pb({ click_id: "{click_id}", trader_id: "{trader_id}", secret: sec });
      S.unknownClick = await pb({ click_id: "someoneelse123", trader_id: "55500009", amount: "100", currency: "USD", secret: sec });
      const me = (await api("get", "/me", "u1")).body;
      S.profile = { stage: me.stage, access: me.academyAccess, fd: me.firstDeposit, deposits: me.deposits };
      const ref = global.__db.dump("referrals")["55500001"] || {};
      S.legacyFields = { trader_id: ref.trader_id, click_id: ref.click_id, deposit: ref.deposit, hasAcademy: !!ref.academy };
      S.otherUser = (await api("post", "/trader-id", "eve", { traderId: "55500001" })).code;
      // Строгая привязка: депозит по другому ID того же пользователя и депозит без валюты
      S.mismatch = await pb({ click_id: click, trader_id: "55500002", amount: "59", currency: "USD", secret: sec });
      S.noCurrency = await pb({ type: "redeposit", click_id: click, trader_id: "55500001", amount: "15", secret: sec });
      const r2 = global.__db.dump("referrals")["55500002"] || {};
      S.mismatchLegacyDeposit = r2.deposit === undefined && !(r2.academy && r2.academy.first_deposit);
      const eveClick = (await api("post", "/click", "eve")).body.clickId;
      S.foreignDeposit = await pb({ click_id: eveClick, trader_id: "55500001", amount: "500", currency: "USD", secret: sec });
      // /check-deposit через настоящий server.js (маршрут из academy/api.js)
      const appGet = async (p, uid, q) => { const r = res(); const routes = global.__app.stack.filter(x => x.kind === "get" && x.path === p); S["routes:" + p] = routes.length; await routes[0].fn({ headers: uid ? { authorization: "Bearer testtoken-" + uid } : {}, query: q || {} }, r); return { code: r.code, body: r.body }; };
      S.cdNoAuth = (await appGet("/check-deposit", null, { trader_id: "55500001" })).code;
      S.cdOwn = await appGet("/check-deposit", "u1");
      S.cdForeign = (await appGet("/check-deposit", "eve", { trader_id: "55500001" })).code;
      S.checkNoAuth = (await appGet("/check", null, { trader_id: "55500001" })).code;
      const after = (await api("get", "/me", "u1")).body;
      S.ownerAfter = { fd: after.firstDeposit && after.firstDeposit.amount, total: after.deposits && after.deposits.totals.USD, access: after.academyAccess };
    }
  }
  if (O.listening && process.argv.includes("TESTDEP")) {
    S.testRoute = !!route("get", "/test/deposit");
    if (S.testRoute && global.__db) {
      const tsec = process.env.TEST_POSTBACK_SECRET;
      const tdep = async q => { const r = res(); await route("get", "/test/deposit")({ query: q }, r); return { code: r.code, status: r.body && r.body.status }; };
      S.beforeReg = await tdep({ trader_id: "142807701", amount: "69", currency: "USD", test_secret: tsec });
      await api("get", "/me", "tester");
      const click = (await api("post", "/click", "tester")).body.clickId;
      S.reg = await pb({ click_id: click, trader_id: "142807701", secret: sec });
      S.bind = (await api("post", "/trader-id", "tester", { traderId: "142807701" })).code;
      S.stageBefore = (await api("get", "/me", "tester")).body.stage;
      S.wrongSecret = await tdep({ trader_id: "142807701", amount: "69", currency: "USD", test_secret: sec });
      S.dep = await tdep({ trader_id: "142807701", amount: "69", currency: "USD", test_secret: tsec });
      S.depDup = await tdep({ trader_id: "142807701", amount: "69", currency: "USD", test_secret: tsec });
      const me = (await api("get", "/me", "tester")).body;
      S.after = { stage: me.stage, access: me.academyAccess, fd: me.firstDeposit && me.firstDeposit.amount, total: me.deposits && me.deposits.totals.USD };
      S.realNoClick = await pb({ trader_id: "142807701", amount: "69", currency: "USD", secret: sec });
      const ev = Object.values(global.__db.dump("deposit_events"));
      S.events = ev.map(e => ({ test: e.test, status: e.status }));
    }
  }
  if (process.argv.includes("BOOTSTRAP")) {
    await new Promise(r => realST(r, 50));                                       // дождаться асинхронного назначения
    const d = global.__db ? global.__db.dump("users") : {};
    S.boot = { role: d.OwnerUid0000000000000001 && d.OwnerUid0000000000000001.role, marker: global.__db ? !!global.__db.dump("system").admin_bootstrap_v2 : false };
  }
  if (O.listening && process.argv.includes("CASE8073") && global.__db) {
    const T = "142808073";
    await api("get", "/me", "old_uid");
    S.c_reg = await pb({ type: "registration", click_id: "ppclickREG0001", trader_id: T, secret: sec });
    S.c_bind = (await api("post", "/trader-id", "old_uid", { traderId: T })).code;
    O.logs.length = 0;
    S.c_ftd = await pb({ type: "ftd", click_id: "ppclickFTD9999", trader_id: T, amount: "60", currency: "USD", secret: sec });
    S.c_log = O.logs.filter(l => l.startsWith("postback ftd") || l.startsWith("📬")).slice(-2);
    S.c_dup = await pb({ type: "ftd", click_id: "ppclickFTD9999", trader_id: T, amount: "60", currency: "USD", secret: sec });
    const eveClick = (await api("post", "/click", "eve")).body.clickId;
    S.c_eve = await pb({ type: "ftd", click_id: eveClick, trader_id: T, amount: "500", currency: "USD", secret: sec });
    await api("get", "/me", "new_uid");
    S.c_newBind = (await api("post", "/trader-id", "new_uid", { traderId: T })).code;
    S.c_binding = global.__db.dump("trader_bindings")[T];
    S.c_old = (await api("get", "/me", "old_uid")).body.academyAccess;
    S.c_new = (await api("get", "/me", "new_uid")).body.academyAccess;
  }
  } catch (e) { O.flowError = e && (e.stack || e.message); }
  console.log = L; console.warn = W; console.error = E;
  process.stdout.write(JSON.stringify(O));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})();
