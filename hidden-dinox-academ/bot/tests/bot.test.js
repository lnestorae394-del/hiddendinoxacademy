"use strict";
/* Telegram-бот Hidden Dinox: /start (видео, file_id, кнопки), пользователи, админ-команды, мастер постов, рассылка
   (429/403/5xx, прогресс, идемпотентность, перезапуск, два процесса), блокировка, слой Telegraf. Telegram API — имитация. */
const test = require("node:test"), assert = require("node:assert"), path = require("path"), fs = require("fs");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { createBotCore, config, parseButtons, BTN_ACADEMY, BTN_SUPPORT, START_CAPTION } = require("../bot/core");
const { startBot, WEBHOOK_PATH } = require("../bot/index");
const ADMIN = 777, quiet = { log() {}, warn() {}, error() {} };
const tgErr = (code, description, retry_after) => Object.assign(new Error(description), { response: { ok: false, error_code: code, description, ...(retry_after ? { parameters: { retry_after } } : {}) } });
function fakeApi(rules = {}) {
  let mid = 1000, fid = 0; const calls = [];
  const api = { calls, async call(method, p) { calls.push({ method, p });
    const rule = rules[method] && rules[method](p, calls); if (rule instanceof Error) throw rule; if (rule && rule.then) return rule; if (rule !== undefined && rule !== null) return rule;
    const m = { message_id: ++mid, chat: { id: p.chat_id } };
    if (method === "sendVideo") m.video = { file_id: typeof p.video === "string" ? p.video : "VID_FILE_ID_" + (++fid), file_unique_id: "u" + fid, duration: 19 };
    return method === "answerCallbackQuery" || method === "editMessageText" ? true : m; } };
  return api;
}
function mk({ env = {}, rules, extra = {} } = {}) {
  const db = new FakeFirestore(), api = fakeApi(rules), slept = [];
  const cfg = config({ ADMIN_TELEGRAM_ID: String(ADMIN), ...env }, { sendIntervalMs: 0, progressEveryMs: 0, ...extra });
  const core = createBotCore({ db, api, cfg, sleep: async ms => { slept.push(ms); }, log: quiet });
  return { db, api, cfg, core, slept };
}
let uid = 0; const upd = o => ({ update_id: ++uid, ...o });
const msg = (from, text, more = {}) => upd({ message: { message_id: ++uid, from: { id: from, first_name: "U" + from, username: "u" + from }, chat: { id: from, type: "private" }, date: 1, text, ...more } });
const cb = (from, data) => upd({ callback_query: { id: "cb" + (++uid), from: { id: from }, data, message: { message_id: 1, chat: { id: from, type: "private" } } } });
const only = (api, m) => api.calls.filter(c => c.method === m);
async function waitJob(db, postId) { for (let i = 0; i < 400; i++) { const s = await db.collection("bot_broadcasts").doc(postId).get(); if (s.exists && s.data().status === "done") return s.data(); await new Promise(r => setImmediate(r)); } throw new Error("рассылка не завершилась"); }

test("/videoid: администратор сохраняет Telegram file_id; /start отправляет видео с подписью и двумя кнопками; пользователь сохраняется", async () => {
  const { db, api, core } = mk();
  await core.handleUpdate(msg(ADMIN, "/videoid"));
  assert.match(only(api, "sendMessage").at(-1).p.text, /отправь следующим сообщением стартовое видео/i);
  await core.handleUpdate(msg(ADMIN, undefined, { video: { file_id: "START_FILE_ID", file_unique_id: "START_UNIQUE", duration: 48 } }));
  assert.strictEqual((await db.collection("bot_config").doc("start_video").get()).data().file_id, "START_FILE_ID");
  await core.handleUpdate(msg(1, "/start"));
  const v1 = only(api, "sendVideo")[0];
  assert.strictEqual(v1.p.video, "START_FILE_ID");
  assert.strictEqual(v1.p.caption, START_CAPTION);
  assert.deepStrictEqual(v1.p.reply_markup, { inline_keyboard: [[{ text: BTN_ACADEMY, web_app: { url: "https://hiddendinox.com" } }], [{ text: BTN_SUPPORT, url: "https://t.me/hiddendinoxsupport" }]] });
  assert.strictEqual(BTN_ACADEMY, "🟢 Открыть Hidden Dinox Academy"); assert.strictEqual(BTN_SUPPORT, "Поддержка");
  await core.handleUpdate(msg(2, "/start")); await core.handleUpdate(msg(1, "/start"));
  assert.deepStrictEqual(only(api, "sendVideo").map(c => c.p.video), ["START_FILE_ID", "START_FILE_ID", "START_FILE_ID"], "каждый раз отправляется сохранённый file_id");
  const u1 = (await db.collection("bot_users").doc("1").get()).data(); assert.deepStrictEqual([u1.id, u1.status, u1.starts, u1.username], [1, "active", 2, "u1"]);
});

test("/start без настроенного file_id не пытается загружать MP4 с Render и показывает текст с кнопками", async () => {
  const { api, core } = mk(); await core.handleUpdate(msg(5, "/start"));
  assert.strictEqual(only(api, "sendVideo").length, 0, "никакой загрузки локального MP4");
  const fallback = only(api, "sendMessage").at(-1).p;
  assert.strictEqual(fallback.text, START_CAPTION);
  assert.deepStrictEqual(fallback.reply_markup.inline_keyboard.map(r => r[0].text), [BTN_ACADEMY, BTN_SUPPORT]);
});

test("/start: file_id из Firestore приоритетен; переменная окружения — резерв; неверный file_id очищается без повторной загрузки MP4", async () => {
  const b = mk({ env: { BOT_START_VIDEO_FILE_ID: "ENV_FILE_ID" } }); await b.core.handleUpdate(msg(5, "/start")); assert.strictEqual(only(b.api, "sendVideo")[0].p.video, "ENV_FILE_ID");
  await b.db.collection("bot_config").doc("start_video").set({ file_id: "ADMIN_UPLOADED_FILE_ID" }); await b.core.handleUpdate(msg(6, "/start")); assert.strictEqual(only(b.api, "sendVideo")[1].p.video, "ADMIN_UPLOADED_FILE_ID", "загруженное администратором видео важнее env");
  const c = mk({ env: { BOT_START_VIDEO_FILE_ID: "STALE" }, rules: { sendVideo: p => p.video === "STALE" ? tgErr(400, "Bad Request: wrong file identifier/HTTP URL specified") : undefined } });
  await c.core.handleUpdate(msg(6, "/start")); assert.strictEqual(only(c.api, "sendVideo").length, 1);
  assert.strictEqual((await c.db.collection("bot_config").doc("start_video").get()).data().file_id, null);
  assert.strictEqual(only(c.api, "sendMessage").length, 1, "показывается безопасный fallback с кнопками");
});

test("посторонние: администраторские команды и кнопки не отвечают и ничего не делают", async () => {
  const { db, api, core } = mk(); await db.collection("bot_posts").doc("p_0123456789").set({ id: "p_0123456789", status: "draft", text: "x", version: 1, created_at: 1 });
  for (const t of ["/newpost", "/posts", "/editpost p_0123456789", "/deletepost p_0123456789", "/broadcast p_0123456789", "/videoid", "просто текст"]) await core.handleUpdate(msg(5, t));
  await core.handleUpdate(cb(5, "pc:p_0123456789:1")); await core.handleUpdate(cb(5, "pd:p_0123456789"));
  assert.deepStrictEqual(api.calls.map(c => c.method), ["answerCallbackQuery", "answerCallbackQuery"], "только закрытие индикатора кнопки");
  assert.strictEqual((await db.collection("bot_admin_state").get()).docs.length, 0); assert.strictEqual((await db.collection("bot_broadcasts").get()).docs.length, 0);
  assert.strictEqual((await db.collection("bot_posts").doc("p_0123456789").get()).data().status, "draft");
});

test("кнопки: несколько URL, ряд через ||, ошибки ввода", () => {
  const r = parseButtons("Сайт | https://hiddendinox.com\nПоддержка | https://t.me/hiddendinoxsupport || Канал | https://t.me/x");
  assert.deepStrictEqual(r.rows.map(row => row.map(b => b.text)), [["Сайт"], ["Поддержка", "Канал"]]); assert.deepStrictEqual(r.errors, []);
  assert.ok(parseButtons("Сайт http://x").errors.length); assert.ok(parseButtons("Сайт | http://insecure.com").errors[0].includes("https://"));
  assert.ok(parseButtons("Сайт | javascript:alert(1)").errors.length); assert.ok(parseButtons(Array.from({ length: 11 }, (_, i) => `B${i} | https://a.com/${i}`).join("\n")).errors.includes("не больше 10 кнопок"));
});

async function makePost(t, { media = "photo", buttons = "Сайт | https://hiddendinox.com\nПоддержка | https://t.me/hiddendinoxsupport || Курс | https://hiddendinox.com/academy" } = {}) {
  await t.core.handleUpdate(msg(ADMIN, "/newpost"));
  await t.core.handleUpdate(msg(ADMIN, "Новый урок уже в академии!", { entities: [{ type: "bold", offset: 0, length: 10 }] }));
  if (media === "photo") await t.core.handleUpdate(msg(ADMIN, undefined, { photo: [{ file_id: "PH_small" }, { file_id: "PH_big" }] }));
  else if (media === "video") await t.core.handleUpdate(msg(ADMIN, undefined, { video: { file_id: "VID_POST" } })); else await t.core.handleUpdate(msg(ADMIN, "/skip"));
  await t.core.handleUpdate(msg(ADMIN, buttons));
  return (await t.db.collection("bot_posts").get()).docs.map(d => d.data()).sort((a, b) => b.created_at - a.created_at)[0];
}

test("мастер: текст с форматированием → фото → кнопки → предпросмотр → черновик; ошибки ввода; список, изменение, удаление; история", async () => {
  const t = mk(); await t.core.handleUpdate(msg(ADMIN, "/newpost")); await t.core.handleUpdate(msg(ADMIN, "Текст"));
  await t.core.handleUpdate(msg(ADMIN, undefined, { photo: [{ file_id: "P" }] })); await t.core.handleUpdate(msg(ADMIN, "Сайт | http://bad"));
  assert.match(only(t.api, "sendMessage").at(-1).p.text, /https:\/\//, "неверная кнопка — объяснение"); await t.core.handleUpdate(msg(ADMIN, "/cancel"));
  await t.core.handleUpdate(msg(ADMIN, "/newpost")); await t.core.handleUpdate(msg(ADMIN, "x".repeat(1100))); await t.core.handleUpdate(msg(ADMIN, undefined, { photo: [{ file_id: "P" }] }));
  assert.match(only(t.api, "sendMessage").at(-1).p.text, /1024/, "подпись к медиа ≤ 1024"); await t.core.handleUpdate(msg(ADMIN, "/cancel"));
  const p = await makePost(t);
  assert.deepStrictEqual([p.status, p.version, p.text, p.media, [0, 1].map(r => p.buttons.filter(b => b.row === r).length)], ["draft", 1, "Новый урок уже в академии!", { type: "photo", file_id: "PH_big" }, [1, 2]]);
  const pv = only(t.api, "sendPhoto").at(-1).p;
  assert.deepStrictEqual([pv.chat_id, pv.photo, pv.caption, pv.caption_entities[0].type], [ADMIN, "PH_big", "Новый урок уже в академии!", "bold"], "предпросмотр как у ученика");
  assert.strictEqual(pv.reply_markup.inline_keyboard[1][1].url, "https://hiddendinox.com/academy");
  await t.core.handleUpdate(msg(ADMIN, "/posts")); assert.match(only(t.api, "sendMessage").at(-1).p.text, new RegExp(`${p.id}.*черновик`));
  await t.core.handleUpdate(msg(ADMIN, `/editpost ${p.id}`)); await t.core.handleUpdate(msg(ADMIN, "/skip")); await t.core.handleUpdate(msg(ADMIN, "/nomedia")); await t.core.handleUpdate(msg(ADMIN, "/skip"));
  const e = (await t.db.collection("bot_posts").doc(p.id).get()).data(); assert.deepStrictEqual([e.version, e.text, e.media, e.buttons.length], [2, p.text, null, 3], "текст и 3 кнопки сохранены, медиа убрано");
  await t.core.handleUpdate(msg(ADMIN, `/deletepost ${p.id}`)); await t.core.handleUpdate(cb(ADMIN, `pd:${p.id}`));
  assert.strictEqual((await t.db.collection("bot_posts").doc(p.id).get()).data().status, "deleted");
  const h = (await t.db.collection("bot_post_history").get()).docs.map(d => d.data().action); assert.deepStrictEqual(h.sort(), ["created", "deleted", "edited"]);
});

async function users(db, ids, status = "active") { for (const id of ids) await db.collection("bot_users").doc(String(id)).set({ id, chat_id: id, status, started_at: 1 }); }

test("рассылка: подтверждение с версией; 403 → недоступен, 429 → retry_after, 500 → до 3 попыток (пользователь не удаляется); прогресс; повтор запрещён", async () => {
  let seen429 = false, n105 = 0;
  const t = mk({ extra: { batchSize: 3, targetsChunk: 4 }, rules: { sendPhoto: p => {
    if (p.chat_id === 102) return tgErr(403, "Forbidden: bot was blocked by the user");
    if (p.chat_id === 103 && !seen429) { seen429 = true; return tgErr(429, "Too Many Requests: retry after 2", 2); }
    if (p.chat_id === 104) return tgErr(500, "Internal Server Error");
    if (p.chat_id === 105 && ++n105 === 1) return tgErr(502, "Bad Gateway"); } } });
  await users(t.db, [101, 102, 103, 104, 105, 106, 107, 108]); await users(t.db, [109], "blocked");
  const p = await makePost(t);
  await t.core.handleUpdate(msg(ADMIN, `/broadcast ${p.id}`)); assert.match(only(t.api, "sendMessage").at(-1).p.text, /Отправить эту публикацию <b>8<\/b>/);
  await t.core.handleUpdate(cb(ADMIN, `pc:${p.id}:999`)); assert.strictEqual((await t.db.collection("bot_broadcasts").doc(p.id).get()).exists, false, "устаревшая версия — не запускается");
  await t.core.handleUpdate(cb(ADMIN, `pc:${p.id}:${p.version}`)); const j = await waitJob(t.db, p.id);
  assert.deepStrictEqual([j.total, j.sent, j.failed, j.blocked, j.uncertain], [8, 6, 1, 1, 0]);
  assert.ok(t.slept.includes(2100), "ожидание по retry_after"); assert.strictEqual(only(t.api, "sendPhoto").filter(c => c.p.chat_id === 104).length, 3, "временная ошибка — 3 попытки");
  assert.ok(!only(t.api, "sendPhoto").some(c => c.p.chat_id === 109), "заблокировавшие не входят в аудиторию");
  const st = id => t.db.collection("bot_users").doc(String(id)).get().then(s => s.exists ? s.data().status : "нет");
  assert.deepStrictEqual([await st(102), await st(104), await st(103)], ["blocked", "active", "active"], "403 — недоступен; временная ошибка — остаётся в базе");
  assert.strictEqual((await t.db.collection("bot_posts").doc(p.id).get()).data().status, "sent");
  const prog = only(t.api, "editMessageText").at(-1).p.text; assert.match(prog, /Рассылка завершена[\s\S]*Отправлено: 6 из 8[\s\S]*Ошибок: 1[\s\S]*Заблокировали бота: 1/);
  const before = only(t.api, "sendPhoto").length; await t.core.handleUpdate(cb(ADMIN, `pc:${p.id}:${p.version}`)); await t.core.handleUpdate(msg(ADMIN, `/broadcast ${p.id}`));
  assert.strictEqual(only(t.api, "sendPhoto").length, before, "повторная отправка той же публикации не выполняется"); assert.match(only(t.api, "sendMessage").at(-1).p.text, /уже разослана/);
  await t.core.handleUpdate(msg(ADMIN, `/editpost ${p.id}`)); assert.match(only(t.api, "sendMessage").at(-1).p.text, /только черновики/);
});

test("перезапуск посреди рассылки: продолжение без повторной отправки; два процесса одновременно — без дублей", async () => {
  let clock = 1e12; const db = new FakeFirestore(), cfg = config({ ADMIN_TELEGRAM_ID: String(ADMIN) }, { sendIntervalMs: 0, progressEveryMs: 0, batchSize: 4, targetsChunk: 5 });
  const hang = new Promise(() => {}); const a1 = fakeApi({ sendMessage: p => p.chat_id === 203 ? hang : undefined });   // процесс «умер» во время отправки 203
  const c1 = createBotCore({ db, api: a1, cfg, now: () => clock, sleep: async () => {}, log: quiet });
  await users(db, [201, 202, 203, 204, 205, 206, 207]);
  const t = { core: c1, db, api: a1 }; const p = await makePost(t, { media: "none" });
  c1.startBroadcast(p.id, ADMIN, ADMIN); for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r));
  clock += 61e3;                                                                                                        // аренда первого процесса истекла
  const a2 = fakeApi(), c2 = createBotCore({ db, api: a2, cfg, now: () => clock, sleep: async () => {}, log: quiet }); await c2.resumeJobs();
  const j = (await db.collection("bot_broadcasts").doc(p.id).get()).data(); assert.strictEqual(j.status, "done");
  const sentTo = [...only(a1, "sendMessage"), ...only(a2, "sendMessage")].map(c => c.p.chat_id).filter(id => id > 200 && id < 300);   // без администратора (предпросмотр, прогресс)
  assert.deepStrictEqual(sentTo.sort(), [201, 202, 203, 204, 205, 206, 207], "каждый — ровно один раз");
  assert.strictEqual(j.uncertain, 1, "203: отправка без подтверждения после «падения» — не повторялась");
  const db2 = new FakeFirestore(), cfg2 = config({ ADMIN_TELEGRAM_ID: String(ADMIN) }, { sendIntervalMs: 0, progressEveryMs: 0, batchSize: 2, targetsChunk: 3 });
  const x1 = fakeApi(), x2 = fakeApi(), k1 = createBotCore({ db: db2, api: x1, cfg: cfg2, sleep: async () => {}, log: quiet }), k2 = createBotCore({ db: db2, api: x2, cfg: cfg2, sleep: async () => {}, log: quiet });
  await users(db2, [301, 302, 303, 304, 305, 306]); const q = await makePost({ core: k1, db: db2, api: x1 }, { media: "none" });
  await k1.startBroadcast(q.id, ADMIN, ADMIN); await Promise.all([k1.runJob(q.id), k2.runJob(q.id), k2.resumeJobs()]); await waitJob(db2, q.id);
  const all = [...only(x1, "sendMessage"), ...only(x2, "sendMessage")].map(c => c.p.chat_id).filter(id => id > 300 && id < 400);
  assert.deepStrictEqual(all.sort(), [301, 302, 303, 304, 305, 306], "два процесса — без дублей");
});

test("блокировка и разблокировка бота пользователем (my_chat_member), новый /start возвращает в рассылку", async () => {
  const { db, core } = mk(); await core.handleUpdate(msg(9, "/start"));
  const mcm = status => upd({ my_chat_member: { chat: { id: 9, type: "private" }, from: { id: 9 }, date: 1, old_chat_member: { status: "member" }, new_chat_member: { status } } });
  await core.handleUpdate(mcm("kicked")); assert.strictEqual((await db.collection("bot_users").doc("9").get()).data().status, "blocked");
  await core.handleUpdate(mcm("member")); assert.strictEqual((await db.collection("bot_users").doc("9").get()).data().status, "active");
  await core.handleUpdate(mcm("kicked")); await core.handleUpdate(msg(9, "/start")); assert.strictEqual((await db.collection("bot_users").doc("9").get()).data().status, "active");
});

test("слой Telegraf: выключен без BOT_ENABLED; без токена или Firebase — не запускается; webhook с секретом; обновления идут в ядро через callApi", async () => {
  const logs = []; const log = { log: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(String(m)) };
  const calls = []; class FakeTelegraf { constructor(token) { this.token = token; this.mw = []; this.telegram = { callApi: async (m, p) => { calls.push({ m, p }); return m === "sendVideo" ? { message_id: 1, video: { file_id: "F1" } } : true; }, setWebhook: async (url, o) => { calls.push({ m: "setWebhook", url, o }); return true; } }; }
    use(f) { this.mw.push(f); } webhookCallback(p, o) { this.hook = { p, o }; return (req, res) => res.end(); } async launch() { this.launched = true; } }
  const routes = []; const app = { post: (p, h) => routes.push(p) };
  assert.strictEqual(startBot({ app, db: new FakeFirestore(), env: {}, log, Telegraf: FakeTelegraf }), null);
  assert.strictEqual(startBot({ app, db: new FakeFirestore(), env: { BOT_ENABLED: "1" }, log, Telegraf: FakeTelegraf }), null); assert.ok(logs.some(m => /TELEGRAM_BOT_TOKEN/.test(m)));
  assert.strictEqual(startBot({ app, db: null, env: { BOT_ENABLED: "1", TELEGRAM_BOT_TOKEN: "1:x" }, log, Telegraf: FakeTelegraf }), null);
  startBot({ app, db: new FakeFirestore(), env: { BOT_ENABLED: "1", TELEGRAM_BOT_TOKEN: "1:x", BOT_WEBHOOK_URL: "https://hiddendinox.com/telegram/webhook", BOT_WEBHOOK_SECRET: "short" }, log, Telegraf: FakeTelegraf });
  await new Promise(r => setImmediate(r)); assert.deepStrictEqual(routes, [], "короткий секрет — webhook не включается");
  const botDb = new FakeFirestore(); await botDb.collection("bot_config").doc("start_video").set({ file_id: "TEST_START_FILE_ID" });
  const r = startBot({ app, db: botDb, env: { BOT_ENABLED: "1", TELEGRAM_BOT_TOKEN: "1:x", ADMIN_TELEGRAM_ID: "777", BOT_WEBHOOK_URL: "https://hiddendinox.com/telegram/webhook", BOT_WEBHOOK_SECRET: "s".repeat(32) }, log, Telegraf: FakeTelegraf });
  for (let i = 0; i < 5; i++) await new Promise(x => setImmediate(x));
  assert.deepStrictEqual([routes, r.bot.hook.p, r.bot.hook.o.secretToken], [[WEBHOOK_PATH], WEBHOOK_PATH, "s".repeat(32)]);
  const sw = calls.find(c => c.m === "setWebhook"); assert.deepStrictEqual([sw.url, sw.o.secret_token, sw.o.allowed_updates], ["https://hiddendinox.com/telegram/webhook", "s".repeat(32), ["message", "callback_query", "my_chat_member"]]);
  const menu = calls.find(c => c.m === "setChatMenuButton"); assert.deepStrictEqual(menu.p.menu_button, { type: "web_app", text: "Открыть Hidden Dinox Academy", web_app: { url: "https://hiddendinox.com" } });
  await r.bot.mw[0]({ update: msg(55, "/start") }); const v = calls.find(c => c.m === "sendVideo"); assert.ok(v && v.p.chat_id === 55 && v.p.reply_markup.inline_keyboard[0][0].web_app.url === "https://hiddendinox.com");
});

test("в коде бота нет токена", () => {
  for (const f of fs.readdirSync(path.join(__dirname, "../bot")).filter(f => f.endsWith(".js"))) assert.ok(!/\d{8,10}:[A-Za-z0-9_-]{30,}/.test(fs.readFileSync(path.join(__dirname, "../bot", f), "utf8")), f);
});
