"use strict";
/* Привязка Telegram монтажёров: регистрация webhook (setWebhook), проверка (getWebhookInfo: статус, pending, последняя ошибка), обработка /start CODE
   (успех, неверный, истёкший, повторный код), неверный секрет вебхука, безопасные журналы. Telegram — подделка Bot API; реальный Telegram здесь не проверяется. */
const test = require("node:test"), assert = require("node:assert/strict");
const { FakeFirestore } = require("./video-studio-helpers/fake-firestore"), { fakeVerify } = require("./video-studio-helpers/http"), { adminCaller } = require("./video-studio-helpers/router"), fakes = require("./video-studio-helpers/fakes");
const { createVideoStudioApi } = require("../video-studio/api"), { memoryVideoStorage } = require("../video-studio/storage-adapter"), { COLL } = require("../video-studio/constants");
const NOW = 1_800_000_000_000, TOKEN = "123456:LINKTESTTOKENVALUE999", SECRET = "link-secret-0123456789abcdef", PUBLIC = "https://studio.example.test", HOOK_URL = PUBLIC + "/api/video-studio/telegram/webhook";
async function setup(over = {}) {
  const tg = await fakes.telegramServer(TOKEN), db = new FakeFirestore(), clock = { t: NOW }, logs = [], log = { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  const env = Object.assign({ VIDEO_STUDIO_ORIGIN: "https://hiddendinox.example", VIDEO_STUDIO_PUBLIC_URL: PUBLIC, VIDEO_STUDIO_TELEGRAM_ENABLED: "1", VIDEO_STUDIO_TELEGRAM_BOT_TOKEN: TOKEN, VIDEO_STUDIO_TELEGRAM_WEBHOOK_SECRET: SECRET, VIDEO_STUDIO_TELEGRAM_BOT_USERNAME: "hd_video_bot", TELEGRAM_API_BASE: tg.url, VIDEO_STUDIO_SNAP_CACHE_MS: "60000" }, over);
  const api = createVideoStudioApi({ db, verifyIdToken: fakeVerify, storage: memoryVideoStorage(), log, now: () => clock.t, env });
  for (const [u, r] of [["boss", "admin"], ["anna", "student"]]) await db.collection("users").doc(u).set({ role: r, email: u + "@test.local" });
  const call = (m, p, o = {}) => adminCaller(api)(m, p, Object.assign({ uid: "boss", headers: { origin: "https://hiddendinox.example" } }, o)), ok = r => { assert.equal(r.statusCode, 200, JSON.stringify(r.body)); return r.body; };
  const x = { tg, db, env, clock, logs, call, ok, api, doc: async (c, id) => { const d = await db.collection(c).doc(id).get(); return d.exists ? d.data() : null; }, all: async c => (await db.collection(c).get()).docs.map(d => Object.assign({ id: d.id }, d.data())) };
  x.hook = async (body, secret = SECRET) => { const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; await api.webhook({ headers: secret === null ? {} : { "x-telegram-bot-api-secret-token": secret }, body }, res); return res; };
  x.msg = (uid, text, type = "private", name = "Иван") => ({ message: { from: { id: uid, first_name: name }, chat: { id: uid, type }, text } });
  x.editor = async name => ok(await call("POST", "/editors", { body: { name } })).editor; x.code = async ed => ok(await call("POST", `/editors/${ed.id}/link`)).code; x.replies = chat => tg.messages.filter(m => String(m.chat_id) === String(chat)).map(m => m.text);
  x.close = () => tg.close(); return x;
}
const noSecrets = (logs, extra = []) => { const all = logs.join("\n"); for (const bad of [TOKEN, SECRET, "LINKTESTTOKEN", ...extra]) assert.ok(!all.includes(bad), "в журнале нет: " + bad); };
test("«Подключить webhook»: setWebhook получает адрес сайта, секрет, только message и режим очереди; ответ и журнал без токена и секрета; «Проверить» показывает статус, pending и последнюю ошибку", async () => {
  const x = await setup(); try {
    let r = x.ok(await x.call("GET", "/telegram/webhook/status")); assert.equal(r.webhook.state, "not_registered"); assert.equal(r.webhook.registered, false); assert.match(r.webhook.hint, /Подключить webhook/); assert.equal(r.webhook.expected_url, HOOK_URL);
    x.tg.pending = 4; r = x.ok(await x.call("POST", "/telegram/webhook/connect", { body: {} })); assert.equal(r.ok, true); assert.equal(r.dropped_pending, false); assert.equal(r.webhook.state, "ok"); assert.equal(r.webhook.url, HOOK_URL); assert.equal(r.webhook.url_matches, true); assert.equal(r.webhook.pending_update_count, 4, "очередь сохранена");
    assert.deepEqual([x.tg.webhook.url, x.tg.webhook.secret_token, x.tg.webhook.allowed_updates, x.tg.webhook.drop_pending_updates], [HOOK_URL, SECRET, ["message"], false], "в Telegram ушёл адрес, секрет и фильтр обновлений"); assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes(TOKEN), "ответ API без секретов");
    x.tg.lastError = { message: "Wrong response from the webhook: 403 Forbidden", date: Math.floor(Date.now() / 1000) }; r = x.ok(await x.call("GET", "/telegram/webhook/status")); assert.equal(r.webhook.state, "error"); assert.match(r.webhook.last_error_message, /403/); assert.ok(r.webhook.last_error_at > 0); assert.match(r.webhook.hint, /WEBHOOK_SECRET/); assert.ok(r.stats && r.stats.updates === 0);
    x.tg.lastError = { message: "старая ошибка", date: Math.floor(Date.now() / 1000) - 7200 }; assert.equal(x.ok(await x.call("GET", "/telegram/webhook/status")).webhook.state, "ok", "ошибка старше часа не считается текущей");
    r = x.ok(await x.call("POST", "/telegram/webhook/connect", { body: { drop_pending_updates: true } })); assert.equal(r.dropped_pending, true); assert.equal(r.webhook.pending_update_count, 0); assert.equal(x.tg.webhook.drop_pending_updates, true);
    x.tg.webhook.url = "https://other.example/hook"; assert.equal(x.ok(await x.call("GET", "/telegram/webhook/status")).webhook.state, "wrong_url");
    const ev = (await x.all(COLL.events)).filter(e => e.action === "telegram.webhook_set"); assert.equal(ev.length, 2); noSecrets(x.logs); assert.ok(x.logs.some(l => /webhook зарегистрирован/.test(l)));
  } finally { x.close(); }
});
test("регистрация webhook отклоняется с понятной причиной: выключено, нет секрета, не публичный https-адрес, не администратор, ошибка Telegram, частота; адрес из Host запроса работает как запасной", async () => {
  let x = await setup({ VIDEO_STUDIO_TELEGRAM_ENABLED: "true" }); try { const r = await x.call("POST", "/telegram/webhook/connect", { body: {} }); assert.deepEqual([r.statusCode, r.body.error], [409, "TG_DISABLED"]); assert.equal((await x.call("GET", "/telegram/webhook/status")).statusCode, 409); assert.equal(x.tg.calls.includes("setWebhook"), false); } finally { x.close(); }
  x = await setup({ VIDEO_STUDIO_TELEGRAM_WEBHOOK_SECRET: "short" }); try { const r = await x.call("POST", "/telegram/webhook/connect", { body: {} }); assert.deepEqual([r.statusCode, r.body.error], [409, "TG_NO_SECRET"]); assert.match(r.body.message, /WEBHOOK_SECRET/); assert.equal(x.tg.calls.includes("setWebhook"), false); } finally { x.close(); }
  x = await setup({ VIDEO_STUDIO_PUBLIC_URL: "", VIDEO_STUDIO_ORIGIN: "http://127.0.0.1:3000" }); try { let r = await x.call("POST", "/telegram/webhook/connect", { body: {}, headers: { origin: "http://127.0.0.1:3000", host: "localhost:3000" } }); assert.deepEqual([r.statusCode, r.body.error], [400, "WEBHOOK_URL"]); assert.match(r.body.message, /VIDEO_STUDIO_PUBLIC_URL/);
    r = x.ok(await x.call("POST", "/telegram/webhook/connect", { body: {}, headers: { origin: "http://127.0.0.1:3000", host: "studio.onrender.example" } })); assert.equal(r.webhook.url, "https://studio.onrender.example/api/video-studio/telegram/webhook", "запасной вариант — Host запроса по https"); } finally { x.close(); }
  x = await setup(); try { assert.equal((await x.call("POST", "/telegram/webhook/connect", { uid: "anna", body: {} })).statusCode, 403, "не администратор"); assert.equal((await x.call("GET", "/telegram/webhook/status", { uid: "anna" })).statusCode, 403);
    x.tg.fail.setWebhook = [{ status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } }]; const r = await x.call("POST", "/telegram/webhook/connect", { body: {} }); assert.deepEqual([r.statusCode, r.body.error], [502, "TG_TOKEN"]); assert.ok(!JSON.stringify(r.body).includes(TOKEN), "в ошибке нет токена"); noSecrets(x.logs);
    let last; for (let i = 0; i < 11; i++) last = await x.call("POST", "/telegram/webhook/connect", { body: {} }); assert.equal(last.statusCode, 429, "не чаще 10 раз в час"); } finally { x.close(); }
});
test("успешная привязка: /start CODE → числовой Telegram ID в записи именно этого монтажёра, код сгорает, бот отвечает, статус виден в списке сразу (кэш сброшен), есть запись в истории и счётчик", async () => {
  const x = await setup(); try {
    const a = await x.editor("Анна"), b = await x.editor("Борис"); assert.equal(x.ok(await x.call("GET", "/editors")).editors.find(e => e.id === a.id).telegram_status, "not_linked");
    const code = await x.code(a); assert.equal(x.ok(await x.call("GET", "/editors")).editors.find(e => e.id === a.id).telegram_status, "not_linked", "кэш заполнен до привязки"); const r = await x.hook(x.msg(555001, "/start " + code)); assert.equal(r.code, 200);
    const da = await x.doc(COLL.editors, a.id), db_ = await x.doc(COLL.editors, b.id); assert.deepEqual([da.telegram.user_id, typeof da.telegram.user_id, da.telegram.name, da.link], ["555001", "string", "Иван", null]); assert.equal(db_.telegram, null, "второй монтажёр не затронут");
    assert.match(x.replies(555001)[0], /Готово: вы привязаны как «Анна»/); const list = x.ok(await x.call("GET", "/editors")).editors; assert.equal(list.find(e => e.id === a.id).telegram_status, "linked", "список (с кэшем 60 с) показывает привязку сразу"); assert.equal(list.find(e => e.id === b.id).telegram_status, "not_linked");
    assert.ok((await x.all(COLL.clipEvents)).some(e => e.kind === "editor_linked" && e.by === "telegram")); assert.equal(x.ok(await x.call("GET", "/telegram/status")).webhook_stats.linked, 1); assert.equal(x.ok(await x.call("GET", "/telegram/status")).editors_linked, 1);
    const l2 = x.ok(await x.call("POST", `/editors/${a.id}/link`)); await x.hook(x.msg(555002, "/start " + l2.code.toLowerCase() + " ")); assert.equal((await x.doc(COLL.editors, a.id)).telegram.user_id, "555002", "код без учёта регистра; повторная привязка заменяет Telegram");
    await x.hook(x.msg(555002, "/tasks")); assert.match(x.replies(555002).slice(-1)[0], /Заданий сейчас нет|Ваши задания/); assert.equal(x.tg.calls.filter(c => c === "sendMessage").length >= 3, true);
  } finally { x.close(); }
});
test("неверный, истёкший и повторный коды: привязки нет, бот отвечает одинаково, чужой пользователь не перехватывает уже использованный код", async () => {
  const x = await setup(); try {
    const a = await x.editor("Анна"); let code = await x.code(a);
    await x.hook(x.msg(600001, "/start WRONGCODE")); await x.hook(x.msg(600001, "/start")); assert.match(x.replies(600001)[0], /Код не подходит или истёк/); assert.match(x.replies(600001)[1], /Это бот монтажёров/); assert.equal((await x.doc(COLL.editors, a.id)).telegram, null);
    x.clock.t += 31 * 60000; await x.hook(x.msg(600002, "/start " + code)); assert.match(x.replies(600002)[0], /Код не подходит или истёк/); assert.equal((await x.doc(COLL.editors, a.id)).telegram, null, "по истёкшему коду привязки нет"); assert.ok((await x.doc(COLL.editors, a.id)).link, "запись кода остаётся до замены");
    code = await x.code(a); await x.hook(x.msg(600003, "/start " + code)); assert.equal((await x.doc(COLL.editors, a.id)).telegram.user_id, "600003"); await x.hook(x.msg(600004, "/start " + code)); assert.match(x.replies(600004)[0], /Код не подходит или истёк/); assert.equal((await x.doc(COLL.editors, a.id)).telegram.user_id, "600003", "повтор того же кода не перехватывает привязку");
    const s = x.ok(await x.call("GET", "/telegram/status")).webhook_stats; assert.deepEqual([s.linked, s.code_invalid, s.code_expired], [1, 2, 1]);
  } finally { x.close(); }
});
test("неверный секрет вебхука: 403 без обработки и без ответа боту; нет заголовка, короткий секрет и выключенная интеграция тоже; чужие чаты и не-сообщения игнорируются", async () => {
  const x = await setup(); try {
    const a = await x.editor("Анна"), code = await x.code(a), before = x.tg.calls.length; for (const sec of ["wrong-secret-0123456789abcdef", "", null, SECRET.toUpperCase()]) { const r = await x.hook(x.msg(700001, "/start " + code), sec); assert.deepEqual([r.code, r.body.error], [403, "FORBIDDEN"], "секрет: " + String(sec).slice(0, 4)); }
    assert.equal(x.tg.calls.length, before, "бот не отвечал"); assert.equal((await x.doc(COLL.editors, a.id)).telegram, null); assert.ok((await x.doc(COLL.editors, a.id)).link, "код не сгорел от чужих запросов"); assert.equal(x.ok(await x.call("GET", "/telegram/status")).webhook_stats.forbidden, 4);
    assert.equal((await x.hook({ message: { from: { id: 1 }, chat: { id: -100, type: "group" }, text: "/start " + code } })).code, 200); assert.equal((await x.hook({ edited_message: {} })).code, 200); assert.equal((await x.hook({})).code, 200); assert.equal((await x.doc(COLL.editors, a.id)).telegram, null, "групповое сообщение не привязывает");
    assert.ok(x.logs.some(l => /неверный или отсутствующий секрет вебхука/.test(l))); noSecrets(x.logs, [code]);
  } finally { x.close(); }
  const s = await setup({ VIDEO_STUDIO_TELEGRAM_WEBHOOK_SECRET: "short" }); try { const r = await s.hook(s.msg(1, "/start X"), "short"); assert.equal(r.code, 403, "секрет короче 16 символов не принимается даже при совпадении"); } finally { s.close(); }
  const d = await setup({ VIDEO_STUDIO_TELEGRAM_ENABLED: "0" }); try { assert.equal((await d.hook(d.msg(1, "/start X"))).code, 404); assert.ok(d.logs.some(l => /интеграция выключена/.test(l))); } finally { d.close(); }
});
test("журнал: запуск обработчика, получение update, тип команды и результат проверки кода записываются; токена, секрета, кода, Telegram ID и имени в журнале нет", async () => {
  const x = await setup(); try {
    const a = await x.editor("Секретный Монтажёр"), code = await x.code(a); await x.hook(x.msg(888777666, "/start " + code, "private", "Тайное")); await x.hook(x.msg(888777666, "/start ZZZZZZZZ", "private", "Тайное")); await x.hook(x.msg(888777666, "/tasks", "private", "Тайное")); await x.hook(x.msg(888777666, "привет", "private", "Тайное")); await x.hook(x.msg(888777666, "/start", "private", "Тайное")); await x.hook(x.msg(888777666, "/help", "private", "Тайное"));
    x.clock.t += 40 * 60000; const c2 = await x.code(a); x.clock.t += 40 * 60000; await x.hook(x.msg(888777666, "/start " + c2, "private", "Тайное"));
    const all = x.logs.join("\n"); for (const need of ["update получен: тип=start, результат=привязан", "тип=start, результат=код_не_найден_или_уже_использован", "тип=start, результат=код_истёк", "update получен: тип=tasks", "тип=текст", "тип=start_без_кода", "тип=другая_команда"]) assert.ok(all.includes(need), "в журнале есть: " + need);
    noSecrets(x.logs, [code, c2, "888777666", "Тайное", "Секретный Монтажёр"]);
    const { buildVideoStudio } = require("../video-studio/index"), boot = []; const b = buildVideoStudio({ db: x.db, verifyIdToken: fakeVerify, admin: {}, env: Object.assign({}, x.env, { VIDEO_STUDIO_RUNNER: "0", VIDEO_STUDIO_STORAGE: "r2" }), log: { log: m => boot.push(String(m)), warn: m => boot.push(String(m)), error: m => boot.push(String(m)) } }); b.start();
    const line = boot.find(l => /^Telegram: режим webhook/.test(l)); assert.ok(line && /включён=true, токен=true, секрет вебхука=true/.test(line), "при запуске записано состояние обработчика: " + boot.join(" | ")); noSecrets(boot);
    const T = require("../video-studio/tg-bot").status(x.env); assert.deepEqual([T.enabled, T.token_set, T.webhook_secret_set], [true, true, true], "признаки для строки при запуске — только булевы");
  } finally { x.close(); }
});
