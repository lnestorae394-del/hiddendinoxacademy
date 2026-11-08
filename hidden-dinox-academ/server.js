const express = require("express");
const fs = require("fs");
const simpleGit = require("simple-git");

const app = express();
const git = simpleGit();

/* HIDDEN DINOX ACADEMY: изолированный тестовый режим (только эмуляторы Firebase, см. academy/test-mode.js).
   Без HD_TEST_MODE поведение сервера не меняется. При неверной настройке — остановка. */
const HD_TEST_MODE = require("./academy/test-mode").resolveTestMode(process.env);
if(HD_TEST_MODE) console.log("🧪 HD_TEST_MODE: эмуляторы Firebase, боты/git/approveTrader отключены");

/* Telegram-боты AI BOOST: в этом сервисе запускаются ТОЛЬКО при ENABLE_LEGACY_BOTS=1.
   Проверяем наличие файлов ДО запуска сервера: если боты включены, а файлов нет —
   остановка с понятной ошибкой (не маскируем). */
const LEGACY_BOTS_ENABLED = !HD_TEST_MODE && process.env.ENABLE_LEGACY_BOTS === "1";
if(LEGACY_BOTS_ENABLED){
for(const f of ["public/bot/bot.js","public/bot/partnerBot.js"]){
if(!fs.existsSync(require("path").join(__dirname,f))){
throw new Error("ENABLE_LEGACY_BOTS=1, но нет файла "+f+" — скопируйте папку public/bot из проекта AI BOOST или уберите переменную");
}
}
}

const PARTNER_BOT_ADMIN = 838408932; // твой телеграм

let approvedDeposits = {};

/* =========================
LOAD APPROVED
========================= */

try{
const data = fs.readFileSync("approved.json","utf8");
approvedDeposits = JSON.parse(data);
console.log("💾 approved loaded");
}catch(e){
console.log("⚠️ approved.json not found");
}

/* =========================
ERROR HANDLERS
========================= */

process.on("uncaughtException", err => {
console.error("UNCAUGHT EXCEPTION", err);
});

process.on("unhandledRejection", err => {
console.error("UNHANDLED REJECTION", err);
});

app.use(express.json({ limit: "8mb" }));

let clickPartners = {};
let traderPartners = {};
let partnerStats = {};


/* =========================
   FIREBASE
========================= */

const admin = require("firebase-admin");

/* Инициализация из FIREBASE_KEY (JSON или base64) с понятной причиной ошибки; ключ в лог не пишется */
const firebaseState = require("./academy/firebase-init").initFirebase({ admin, testMode: HD_TEST_MODE });
let db = firebaseState.db;

/* Одноразовое назначение первого Super Admin — по UID из переменной окружения ADMIN_BOOTSTRAP_UID.
   Почему UID, а не email: регистрация в академии не подтверждает владение почтой; если бы
   назначение шло по адресу, его мог бы получить тот, кто первым зарегистрирует этот адрес.
   UID присваивается вашему аккаунту при регистрации, его нельзя занять. Маркер в system/
   не даёт повторять назначение. В тестовом режиме не выполняется. */
async function bootstrapAcademySuperAdmin() {
  const uid = (process.env.ADMIN_BOOTSTRAP_UID || "").trim();
  if (!uid || HD_TEST_MODE || !db || !admin.auth) return;
  if (!/^[A-Za-z0-9]{20,128}$/.test(uid)) { console.error("⚠️ ADMIN_BOOTSTRAP_UID некорректен — назначение пропущено"); return; }
  const markerRef = db.collection("system").doc("admin_bootstrap_v2");
  try {
    const marker = await markerRef.get();
    if (marker.exists && marker.data().completed === true) return;
    const account = await admin.auth().getUser(uid);          // аккаунт должен уже существовать
    const userRef = db.collection("users").doc(account.uid);
    const now = Date.now();
    await db.runTransaction(async tx => {
      const currentMarker = await tx.get(markerRef);
      if (currentMarker.exists && currentMarker.data().completed === true) return;
      tx.set(userRef, { email: account.email || null, role: "super_admin", role_updated_at: now, role_updated_by: "one_time_server_bootstrap" }, { merge: true });
      tx.set(markerRef, { completed: true, uid: account.uid, completed_at: now }, { merge: true });
      tx.set(db.collection("audit_logs").doc("admin_bootstrap_v2"), { at: now, actor_uid: "system", actor_email: null, actor_role: "system",
        action: "user.role.bootstrap", target_type: "user", target_id: account.uid, details: { to: "super_admin" } }, { merge: true });
    });
    console.log("✅ Одноразовое назначение Super Admin выполнено (UID ••••" + uid.slice(-4) + "). Переменную ADMIN_BOOTSTRAP_UID можно удалить.");
  } catch (e) {
    const code = e && e.code;
    console.error("⚠️ Super Admin bootstrap не выполнен:", code === "auth/user-not-found" ? "аккаунт с этим UID не найден в Firebase Authentication" : (code || "ошибка Firebase"));
  }
}
void bootstrapAcademySuperAdmin();


/* =========================
   RAM БАЗА
========================= */

let registeredUsers = {};
let deposits = {};

try{
const data = fs.readFileSync("deposits.json","utf8");
deposits = JSON.parse(data);
console.log("💾 deposits loaded");
}catch(e){
console.log("⚠️ deposits.json not found");
}

/* =========================
   STATS LOAD
========================= */

let stats = 
{"users":166259,"profit":320236555,"win":75,"loss":25,"time":"20:00"}

try{
const data = fs.readFileSync("stats.json","utf8");
stats = JSON.parse(data);
console.log("📊 stats loaded");
}catch(e){
console.log("⚠️ stats.json not found, creating...");
fs.writeFileSync("stats.json", JSON.stringify(stats,null,2));
}

function saveStats(){
try{

const tmp = "stats.tmp";

fs.writeFileSync(tmp, JSON.stringify(stats,null,2));
fs.renameSync(tmp, "stats.json");

}catch(e){
console.log("stats save error", e);
}
}

let liveTrades = [];
let totalTrades = 0;

let winChance = 0.74;

const DEV_MODE = true;


/* =========================
   STATIC
========================= */

/* =========================
   HIDDEN DINOX ACADEMY
   (закрывает public/bot, подключает /api и /academy; старые маршруты не меняются)
========================= */

const { attachAcademy, blockPrivateStatic } = require("./academy");
blockPrivateStatic(app);
const academy = attachAcademy({
app, express, admin, db,
publicDir: require("path").join(__dirname, "public")
});

/* =========================
   TELEGRAM-БОТ (включается BOT_ENABLED=1; токен — только из окружения)
========================= */
try { require("./bot").startBot({ app, db, env: process.env }); }   // ошибка модуля бота не должна ронять сайт
catch (e) { console.warn("⚠️ Telegram-бот не подключён:", e && e.message); }

app.set("etag", true);

app.use(express.static("public", {
  maxAge: "6h"
}));


/* =========================
   CLEAN ROUTES (без .html)
========================= */

const path = require("path");

const pages = [
"index",
"login",
"register",
"signals",
"history",
"rules",
"deposit",
"pocket",
"instruction",
"delete",
"about",

];

pages.filter(page => require("fs").existsSync(path.join(__dirname, "public", page + ".html"))).forEach(page=>{   // нет файла — нет маршрута (раньше: 500)

app.get("/"+page,(req,res)=>{
res.sendFile(path.join(__dirname,"public",page+".html"));
});

});


/* =========================
   DEV DEPOSIT
========================= */

app.get("/dev-deposit",(req,res)=>{

const adminKey = req.query.key;

if(!process.env.DEV_KEY || adminKey !== process.env.DEV_KEY){
return res.send("forbidden");
}

const trader = req.query.trader_id;
const amount = parseFloat(req.query.amount || 25);

if(trader){

if(!deposits[trader] || amount > deposits[trader]){
deposits[trader] = amount;
}


console.log("🧪 TEST депозит:",trader,"+",amount);

}

res.send("ok");

});



/* =========================
   РЕАЛ ДЕПОЗИТ
========================= */

app.get("/deposit",(req,res)=>{

const trader = req.query.trader_id;
const amount = parseFloat(req.query.amount || 0);

if(trader && amount){

deposits[trader] = amount;

console.log("💰 депозит:",trader,"+",amount);

}

res.send("OK");

});


/* =========================
   /check и /check-deposit — перенесены в academy/api.js:
   теперь требуют вход (Firebase ID token) и отвечают только по Trader ID текущего пользователя.
   Прежние версии были публичными: по любому trader_id раскрывали сумму депозита (порог 30)
   и читали поле referrals.deposit, которое академия заполняет не для всех событий.
========================= */

/* =========================
   ПРОВЕРКА АПРУВА
========================= */

app.get("/check-approve",(req,res)=>{

const trader = req.query.trader_id;

if(!trader){
return res.json({ok:false});
}

if(approvedDeposits[trader]){
console.log("✅ approve found:", trader);

return res.json({
ok:true
});
}

res.json({
ok:false
});

});



/* =========================
   РЫНОК
========================= */

let currentPrice = 1.18420;
let currentPair = "EUR/USD";

function movePrice(){

let baseMove = (Math.random()-0.5)*0.00025;
let trend = (Math.random()>0.5?1:-1)*0.00005;

currentPrice += baseMove + trend;
currentPrice += (Math.random()-0.5)*0.00003;

if(currentPrice < 1) currentPrice = 1.1;

}

setInterval(movePrice,900);


/* =========================
   ПОЛУЧЕНИЕ ЦЕНЫ
========================= */

app.get("/price",(req,res)=>{
res.json({
price: currentPrice,
pair: currentPair
});
});


/* =========================
   SET PAIR (для signals)
========================= */

app.get("/setpair",(req,res)=>{

const pair = req.query.pair;

if(pair){
currentPair = pair;
}

res.json({ok:true});

});


/* =========================
   ENTRY
========================= */

app.get("/get-entry",(req,res)=>{

let wait = 3000 + Math.random()*5000;

setTimeout(()=>{

let entry = currentPrice;
entry += (Math.random()-0.5)*0.00015;

res.json({
entry: entry,
pair: currentPair
});

},wait);

});


/* =========================
   BLOCK DIRECT HTML ACCESS
========================= */

app.get(/\.html$/, (req,res)=>{
res.redirect("/");
});

/* =========================
   SERVER
========================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT,()=>{
console.log("🚀 SERVER START");
console.log("PORT:",PORT);
console.log("🧪 DEV MODE:",DEV_MODE);
});

/* =========================
   REAL MARKET SIMULATOR
========================= */

function getMarketDelay(){

let hour = new Date().getHours();

/* ночь */
if(hour >=0 && hour <7){
return 7000 + Math.random()*4000;
}

/* утро */
if(hour >=7 && hour <12){
return 4000 + Math.random()*2000;
}

/* день */
if(hour >=12 && hour <18){
return 2000 + Math.random()*1000;
}

/* вечер пик */
if(hour >=18 && hour <23){
return 1200 + Math.random()*600;
}

/* поздний вечер */
return 3000 + Math.random()*1500;

}

function generateTrade(){

let pairs = ["EUR/USD","GBP/USD","BTC","ETH","GOLD","USD/JPY"];

let pair = pairs[Math.floor(Math.random()*pairs.length)];

let end = Math.floor(100 + Math.random()*900);
let id = "ID 12****" + end;

/* суммы */

let amount;
let r = Math.random();

if(r < 0.65){
amount = Math.floor(Math.random()*120)+40;
}else if(r < 0.9){
amount = Math.floor(Math.random()*600)+200;
}else if(r < 0.98){
amount = Math.floor(Math.random()*1200)+600;
}else{
amount = Math.floor(Math.random()*2000)+2000;
}

/* плавный винрейт */

if(Math.random()>0.9){
winChance += (Math.random()-0.5)*0.02;
}

if(winChance > 0.89) winChance = 0.89;
if(winChance < 0.63) winChance = 0.63;

let isWin = Math.random() < winChance;
let result = isWin ? "win":"loss";

/* обновляем прибыль */

if(isWin){
stats.profit += Math.floor(amount*0.7);
}else{
stats.profit -= Math.floor(amount*0.3);
}

/* рост пользователей */

if(Math.random()>0.92){
stats.users += 1;
}

/* время */

let kyiv = new Date().toLocaleString("en-US",{timeZone:"Europe/Kyiv"});
let hour = new Date(kyiv).getHours().toString().padStart(2,"0");

stats.time = hour+":00";

/* сделки */

liveTrades.push({
id,
pair,
amount,
result,
time:Date.now()
});

if(liveTrades.length>40){
liveTrades = liveTrades.slice(-40);
}

/* winrate */

stats.win = Math.round(winChance*100);
stats.loss = 100 - stats.win;

/* сохранить */

saveStats();

console.log("📈 trade generated");

/* следующая сделка */

setTimeout(generateTrade, getMarketDelay());

}

/* запуск рынка */

generateTrade();

/* Telegram-боты AI BOOST (проверка файлов — в начале файла) */
if(LEGACY_BOTS_ENABLED){
require("./public/bot/bot");
require("./public/bot/partnerBot");
console.log("🤖 Telegram-боты AI BOOST запущены");
}else{
console.log("ℹ️ Telegram-боты AI BOOST не запускаются (ENABLE_LEGACY_BOTS≠1)");
}

app.get("/stats",(req,res)=>{

try{
const data = fs.readFileSync("stats.json","utf8");
stats = JSON.parse(data);
}catch(e){
console.log("stats reload error", e);
}

res.json(stats);

});
app.get("/live",(req,res)=>{
res.json(liveTrades);
});

/* =========================
   GLOBAL ERROR HANDLER
========================= */

app.use((err, req, res, next) => {

console.error("SERVER ERROR:", err);

res.status(500).json({
error: "server_error"
});

});

/* =========================
   AUTO SAVE STATS TO GIT
========================= */

if(!HD_TEST_MODE && process.env.ENABLE_GIT_AUTOSAVE === "1") setInterval(async()=>{

try{

await git.add("stats.json");

await git.commit("auto stats update");

await git.push();

console.log("📦 stats saved to git");

}catch(e){

console.log("git save error", e.message);

}

},300000);

app.get("/postback", async (req,res)=>{

/* HIDDEN DINOX ACADEMY: секрет и параметры проверяются ДО любых записей (academy/postback.js).
   Ответ отражает реальный результат: 200 — обработано (или уже было обработано), иначе 4xx/5xx. */
let result;
try{
result = await academy.postback.handle(req.query, { ip: req.ip });
}catch(e){
console.log("postback error", e && (e.code || e.message));
result = { status: "server_error", http: 500, message: "Внутренняя ошибка" };
}

/* Совместимость со старой схемой AI BOOST — только для проверенных, новых событий */
if(result.verified && result.http === 200 && result.status !== "duplicate"){
try{ await legacyPostbackCompat(req.query); }catch(e){ console.log("legacy postback error", e && e.message); }
}

console.log("📬 postback:", result.kind || "-", result.status, "→", result.http);
res.status(result.http).json({ ok: result.http === 200, status: result.status, message: result.message });

});

/* Старая запись AI BOOST (referrals.{trader_id,click_id,deposit}, deposits.json, traders.json, одобрение партнёру).
   Вызывается ТОЛЬКО после проверки секрета. Параметры — строго click_id / trader_id / amount / type. */
async function legacyPostbackCompat(q){

const click = typeof q.click_id === "string" ? q.click_id : null;
const trader = typeof q.trader_id === "string" ? q.trader_id : null;
const amount = parseFloat(q.amount || 0);
const type = q.type === "redeposit" ? "redeposit" : "ftd";
if(!click || !trader) return;

/* REGISTRATION */
if(db){
await db.collection("referrals").doc(trader).set({
trader_id: trader,
click_id: click,
created: Date.now()
}, { merge: true }); // merge: не стирает deposit и данные академии
}
traders[trader] = { click_id: click, created: Date.now() };
saveTraders();
if(clickPartners[click]){ traderPartners[trader] = clickPartners[click]; }

/* FIRST DEPOSIT (старое поле deposit) */
if(amount > 0 && type !== "redeposit"){
deposits[trader] = amount;
saveDeposits();
if(db){
await db.collection("referrals").doc(trader).set({ deposit: amount, deposit_at: Date.now() }, { merge: true });
}
}

/* REDEPOSIT → одобрение партнёру (только если боты включены в этом сервисе) */
if(type === "redeposit"){
if(approvedDeposits[trader]) return;
if(!LEGACY_BOTS_ENABLED){
console.log("ℹ️ redeposit: approveTrader не вызывается (боты AI BOOST в этом сервисе выключены)");
return;
}
const { approveTrader } = require("./public/bot/partnerBot");
approveTrader(trader, click, amount);
approvedDeposits[trader] = true; // защита от повторной выплаты
saveApproved();
console.log("🔥 REDEPOSIT APPROVED:", trader, amount);
}

}



function saveDeposits(){
fs.writeFileSync("deposits.json", JSON.stringify(deposits,null,2));
}

/* =========================
   TRADERS LOAD
========================= */

let traders = {};

try{
const data = fs.readFileSync("traders.json","utf8");
traders = JSON.parse(data);
console.log("💾 traders loaded");
}catch(e){
console.log("⚠️ traders.json not found");
}

function saveTraders(){
fs.writeFileSync("traders.json", JSON.stringify(traders,null,2));
}

function saveApproved(){
fs.writeFileSync("approved.json", JSON.stringify(approvedDeposits,null,2));
}

/* =========================
SAVE TRADER ID
========================= */

