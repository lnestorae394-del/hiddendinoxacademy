"use strict";
/* AI Mentor Vision: настоящие PNG/JPEG/WebP, проверки на сервере, модель для скриншотов, заметки по графику и продолжение разговора. */
const test = require("node:test"), assert = require("node:assert"), path = require("path"), fs = require("fs");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify } = require("./helpers/http");
const { learnCaller } = require("./helpers/router");
const { createLearnApi } = require("../academy/learn-api");
const { createAcademyApi } = require("../academy/api");
const IMG = f => fs.readFileSync(path.join(__dirname, "fixtures/images", f));
const b64 = (f, mime) => ({ mime_type: mime, data: IMG(f).toString("base64") });
const PNG = () => b64("chart.png", "image/png"), JPG = () => b64("chart.jpg", "image/jpeg"), WEBP = () => b64("chart.webp", "image/webp");
function fakeApi(replyFor = () => "Разбор графика.") {
  const calls = []; const f = async (url, init) => { const b = JSON.parse(init.body); calls.push(b);
    if (f.status) return { ok: false, status: f.status, json: async () => ({ type: "error", error: { type: "invalid_request_error", message: "Could not process image" } }) };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: replyFor(b) }], usage: { input_tokens: 2000, output_tokens: 300 } }) }; };
  f.calls = calls; return f;
}
async function setup(api = fakeApi()) {
  const db = new FakeFirestore(), logs = [];
  const log = { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  const L = learnCaller(createLearnApi({ db, academyApi: createAcademyApi({ db, verifyIdToken: fakeVerify, log }), log, env: { ANTHROPIC_API_KEY: "k" }, mentorFetch: api }));
  for (const u of ["a", "b"]) await db.collection("users").doc(u).set({ role: "team_member", email: u + "@t" });
  await require("../academy/features").createFeatures({ db }).update("ai_mentor", { status: "ACTIVE" }, "boss");
  return { db, L, api, logs };
}
let n = 0; const send = (L, uid, body) => L("POST", "/mentor/message?lang=ru", { uid, query: { lang: "ru" }, body: { client_id: "vis_" + String(++n).padStart(6, "0"), ...body } });
const notes = sys => (/\n<chart_notes>\n([\s\S]*?)\n<\/chart_notes>/.exec(sys) || [])[1] || "";

test("JPEG, PNG и WebP: модель для скриншотов, усилие, изображение перед текстом, инструкция разбора Pocket Option", async () => {
  const { L, api } = await setup();
  for (const im of [PNG(), JPG(), WEBP()]) assert.strictEqual((await send(L, "a", { text: "Что видно на графике?", images: [im] })).statusCode, 200, im.mime_type);
  for (const c of api.calls) {
    assert.deepStrictEqual([c.model, c.max_tokens, c.output_config.effort], ["claude-sonnet-5-5", 2000, "medium"]);
    const content = c.messages.at(-1).content; assert.strictEqual(content[0].type, "image"); assert.strictEqual(content.at(-1).type, "text");
    assert.match(c.system, /OTC или обычный/); assert.match(c.system, /Не путай ценовую шкалу графика, время на временной шкале, время экспирации и сумму сделки/); assert.match(c.system, /<chart_note>/);
  }
  assert.deepStrictEqual(api.calls.map(c => c.messages.at(-1).content[0].source.media_type), ["image/png", "image/jpeg", "image/webp"]);
});

test("только изображение без текста; два изображения — два блока; три — отказ без запроса к API", async () => {
  const { L, api } = await setup();
  assert.strictEqual((await send(L, "a", { images: [PNG()] })).statusCode, 200, "только изображение");
  assert.match(api.calls[0].messages.at(-1).content.at(-1).text, /Разбери приложенный скриншот/);
  assert.strictEqual((await send(L, "a", { text: "Сравни эти два", images: [PNG(), JPG()] })).statusCode, 200);
  assert.strictEqual(api.calls[1].messages.at(-1).content.filter(x => x.type === "image").length, 2);
  const r = await send(L, "a", { text: "три", images: [PNG(), JPG(), WEBP()] }); assert.deepStrictEqual([r.statusCode, r.body.error], [400, "IMAGE_COUNT"]);
  assert.strictEqual(api.calls.length, 2);
});

test("отказы на сервере без запроса к API: повреждённый, маленький, слишком широкий, тип не совпадает, больше 5 МБ, пустое сообщение", async () => {
  const { L, api } = await setup();
  const big = { mime_type: "image/png", data: Buffer.concat([IMG("chart.png"), Buffer.alloc(5 * 1024 * 1024)]).toString("base64") };
  for (const [im, code] of [[b64("corrupt.png", "image/png"), "IMAGE_INVALID"], [b64("tiny.png", "image/png"), "IMAGE_DIMENSIONS"], [b64("too-wide.png", "image/png"), "IMAGE_DIMENSIONS"],
    [{ mime_type: "image/jpeg", data: IMG("chart.png").toString("base64") }, "IMAGE_INVALID"], [{ mime_type: "image/gif", data: "R0lGOD" }, "IMAGE_INVALID"], [big, "IMAGE_TOO_LARGE"]]) {
    const r = await send(L, "a", { text: "x", images: [im] }); assert.deepStrictEqual([r.statusCode, r.body.error], [400, code], code); }
  const e = await send(L, "a", { text: "  ", images: [] }); assert.deepStrictEqual([e.statusCode, e.body.error], [400, "EMPTY"]);
  assert.strictEqual(api.calls.length, 0, "ни одного запроса к API");
});

test("заметка по графику: скрыта от ученика, сохраняется; уточнения идут на текстовую модель с выводами; второй скриншот сравнивается с первым", async () => {
  const api = fakeApi(b => b.messages.at(-1).content[0] && b.messages.at(-1).content[0].type === "image"
    ? "На графике нисходящий импульс.\n<chart_note>EUR/USD OTC; M1; нисходящая структура LH/LL; зона сопротивления у последнего максимума; сценарии: продолжение вниз или возврат к максимуму</chart_note>" : "Ответ на уточнение.");
  const { L, logs, db } = await setup(api);
  const img = PNG(), r1 = await send(L, "a", { text: "Разбери", images: [img] });
  assert.strictEqual(r1.body.reply.text, "На графике нисходящий импульс.", "служебная заметка вырезана из ответа");
  assert.deepStrictEqual((await L("GET", "/mentor/memory", { uid: "a" })).body.chart_notes, ["EUR/USD OTC; M1; нисходящая структура LH/LL; зона сопротивления у последнего максимума; сценарии: продолжение вниз или возврат к максимуму"]);
  await send(L, "a", { text: "А почему ты считаешь структуру нисходящей?" });
  const follow = api.calls.at(-1); assert.deepStrictEqual([follow.model, follow.output_config.effort], ["claude-haiku-5-5", "low"], "уточнение — на текстовой модели");
  assert.match(notes(follow.system), /EUR\/USD OTC; M1; нисходящая структура/, "уточнение видит выводы по графику");
  await send(L, "a", { text: "Вот следующий скриншот, что изменилось?", images: [JPG()] });
  assert.match(notes(api.calls.at(-1).system), /EUR\/USD OTC; M1/, "второй скриншот сравнивается с заметкой о первом");
  assert.strictEqual(notes(api.calls.at(-1).system).split("\n").length, 1);
  await send(L, "b", { text: "Что на графике?" }); assert.strictEqual(notes(api.calls.at(-1).system), "", "заметки другого ученика не видны");
  const all = JSON.stringify([...db.store.values()]) + logs.join("\n");
  assert.ok(!all.includes(img.data.slice(0, 200)), "base64 изображения нет ни в Firestore, ни в журнале");
  const um = (await db.collection("mentor_messages").where("uid", "==", "a").get()).docs.map(d => d.data()).find(m => m.role === "user" && m.has_image);
  assert.strictEqual(um.image_count, 1);
});

test("если модель не написала заметку — сохраняется начало ответа; если API отклонил изображение — понятная ошибка и лимит не тратится", async () => {
  const api = fakeApi(() => "Вижу боковое движение без явной структуры."); const { L } = await setup(api);
  await send(L, "a", { text: "Что тут?", images: [WEBP()] });
  assert.deepStrictEqual((await L("GET", "/mentor/memory", { uid: "a" })).body.chart_notes, ["Вижу боковое движение без явной структуры."]);
  const used = (await L("GET", "/mentor/thread", { uid: "a" })).body.limit.used_today;
  api.status = 400; const r = await send(L, "a", { text: "А этот?", images: [PNG()] });
  assert.deepStrictEqual([r.statusCode, r.body.error], [400, "IMAGE_INVALID"]);
  assert.strictEqual((await L("GET", "/mentor/thread", { uid: "a" })).body.limit.used_today, used, "неудачный запрос не тратит лимит");
});
