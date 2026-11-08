"use strict";
/* Бюджет AI: стоимость по официальным ценам, резервирование, параллельные запросы, доли и резерв, лимит ученика, предупреждения, Берлин. */
const test = require("node:test"), assert = require("node:assert"), path = require("path"), fs = require("fs");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify } = require("./helpers/http");
const { learnCaller } = require("./helpers/router");
const { createLearnApi } = require("../academy/learn-api");
const { createAcademyApi } = require("../academy/api");
const BG = require("../academy/ai-budget");
const T0 = Date.UTC(2026, 9, 15, 12, 0);
const mk = async (settings = {}, now = () => T0) => { const db = new FakeFirestore(), b = BG.createBudget({ db, now });
  await b.setSettings({ monthly_total_usd: 100, features: { mentor: 40, vision: 45, daily: 10 }, reserve_usd: 5, per_user_monthly_usd: 1.5, per_user_daily_images: 5, ...settings }); return { db, b }; };

test("стоимость по официальным ценам (включая кэш) и оценка входа с изображением", () => {
  const sonnet = BG.DEFAULTS.prices["claude-sonnet-5-5"], haiku = BG.DEFAULTS.prices["claude-haiku-5-5"];
  assert.deepStrictEqual([sonnet.input, sonnet.output, sonnet.cache_read, sonnet.cache_write], [2, 10, 0.10, 2.50]);
  assert.deepStrictEqual([haiku.input, haiku.output, haiku.cache_read, haiku.cache_write], [0.10, 0.50, 0.01, 0.125]);
  assert.strictEqual(BG.costOf({ input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }, sonnet), 14.6);
  assert.strictEqual(BG.costOf({ input_tokens: 5000, output_tokens: 400 }, haiku), 0.0007);
  assert.strictEqual(BG.estimateInputTokens(0, [{ w: 3000, h: 2000 }]), Math.ceil(1568 * (2000 * 1568 / 3000) / 750), "изображение уменьшается до 1568 px");
  assert.strictEqual(BG.estimateInputTokens(3000), Math.ceil(3000 / 3 * 1.3));
});

test("резерв → списание по факту; ошибка → возврат; доли функций, общий резерв и лимит ученика", async () => {
  const { b } = await mk({ monthly_total_usd: 1, features: { mentor: 0.3, vision: 0.5, daily: 0.1 }, reserve_usd: 0.1, per_user_monthly_usd: 0.25 });
  const r = await b.reserve("mentor", 0.2, "u1"); let st = await b.status();
  assert.deepStrictEqual([st.features.mentor.reserved_usd, st.total.reserved_usd], [0.2, 0.2]);
  await b.settle(r, 0.05); st = await b.status();
  assert.deepStrictEqual([st.features.mentor.spent_usd, st.features.mentor.reserved_usd, st.total.spent_usd], [0.05, 0, 0.05]);
  const e = await b.reserve("mentor", 0.1, "u2"); await b.release(e); st = await b.status();
  assert.deepStrictEqual([st.features.mentor.spent_usd, st.features.mentor.reserved_usd, st.features.mentor.errors], [0.05, 0, 1], "ошибка ничего не тратит");
  await assert.rejects(b.reserve("mentor", 0.21, "u1"), x => x.code === "USER_BUDGET", "лимит ученика: 0.05 + 0.21 > 0.25");
  await b.settle(await b.reserve("mentor", 0.3), 0.3);   // без ученика (как генерация тестов) — проверяются доли                         // 0.05 + 0.3 = 0.35 > 0.3 → 0.05 из общего резерва
  await assert.rejects(b.reserve("mentor", 0.06), x => x.code === "BUDGET_EXHAUSTED", "резерв 0.1: 0.05 уже взято, 0.06 не помещается");
  await b.settle(await b.reserve("vision", 0.5), 0.5);
  await assert.rejects(b.reserve("vision", 0.06, "u6"), x => x.code === "BUDGET_EXHAUSTED", "общий резерв делится между функциями");
  assert.ok((await b.reserve("vision", 0.05, "u6")).id, "остаток резерва 0.05 доступен Vision");
});

test("30 параллельных запросов при лимите на 20 — проходят ровно 20, превышения нет", async () => {
  const { b } = await mk({ monthly_total_usd: 1, features: { mentor: 1, vision: 0, daily: 0 }, reserve_usd: 0, per_user_monthly_usd: 10 });
  const out = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => b.reserve("mentor", 0.05, "u" + (i % 5))));
  assert.strictEqual(out.filter(x => x.status === "fulfilled").length, 20);
  assert.ok(out.filter(x => x.status === "rejected").every(x => x.reason.code === "BUDGET_EXHAUSTED"));
  const st = await b.status(); assert.ok(st.total.reserved_usd <= 1 + 1e-9, String(st.total.reserved_usd)); assert.strictEqual(st.open_reservations, 20);
});

test("предупреждения 70 / 85 / 95 / 100 %, прогноз; зависший резерв снимается через 10 минут", async () => {
  let t = T0; const { b } = await mk({ monthly_total_usd: 1, features: { mentor: 1, vision: 0, daily: 0 }, reserve_usd: 0, per_user_monthly_usd: 10 }, () => t);
  const levels = []; for (const x of [0.5, 0.2, 0.15, 0.1, 0.05]) { await b.settle(await b.reserve("mentor", x), x); levels.push((await b.status()).total.warning_level); }
  assert.deepStrictEqual(levels, [0, 70, 85, 95, 100]);
  const st = await b.status(); assert.strictEqual(st.total.forecast_usd, Math.round(1 / 15 * 31 * 1e6) / 1e6, "прогноз: 15 дней → 31 день октября");
  const { b: b2 } = await mk({ monthly_total_usd: 0.1, features: { mentor: 0.1, vision: 0, daily: 0 }, reserve_usd: 0, per_user_monthly_usd: 10 }, () => t);
  await b2.reserve("mentor", 0.1, "u1"); await assert.rejects(b2.reserve("mentor", 0.01), x => x.code === "BUDGET_EXHAUSTED");
  t += 11 * 60e3; assert.ok((await b2.reserve("mentor", 0.1, "u1")).id, "резерв, оставшийся после перезапуска, снят");
});

test("дневной лимит скриншотов с возвратом; месяц считается по Берлину", async () => {
  const { b } = await mk({ per_user_daily_images: 3 });
  const back = await b.takeImageSlot("u1", 2); await b.takeImageSlot("u1", 1);
  await assert.rejects(b.takeImageSlot("u1", 1), x => x.code === "IMAGE_LIMIT");
  await back(); assert.ok(await b.takeImageSlot("u1", 2), "возврат освободил слоты");
  const { b: night } = await mk({}, () => Date.UTC(2026, 9, 31, 23, 30));        // 00:30 1 ноября по Берлину
  assert.strictEqual((await night.status()).month, "2026-11");
});

test("AI Mentor: скриншоты — в долю Vision, текст — в долю Mentor, по фактической стоимости; ошибка API ничего не тратит", async () => {
  const db = new FakeFirestore(); let fail = false;
  const api = async (url, init) => { const bd = JSON.parse(init.body); if (fail) return { ok: false, status: 529, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "ok" }], usage: bd.model === "claude-sonnet-5-5" ? { input_tokens: 3000, output_tokens: 500 } : { input_tokens: 4000, output_tokens: 300, cache_read_input_tokens: 1000 } }) }; };
  const L = learnCaller(createLearnApi({ db, academyApi: createAcademyApi({ db, verifyIdToken: fakeVerify, log: { log() {}, warn() {}, error() {} } }), log: { log() {}, warn() {}, error() {} }, env: { ANTHROPIC_API_KEY: "k" }, mentorFetch: api }));
  await db.collection("users").doc("a").set({ role: "team_member", email: "a@t" }); await require("../academy/features").createFeatures({ db }).update("ai_mentor", { status: "ACTIVE" }, "boss");
  const img = { mime_type: "image/png", data: fs.readFileSync(path.join(__dirname, "fixtures/images/chart.png")).toString("base64") };
  let n = 0; const send = body => L("POST", "/mentor/message", { uid: "a", body: { client_id: "bud_" + String(++n).padStart(6, "0"), ...body } });
  assert.strictEqual((await send({ text: "Разбери", images: [img] })).statusCode, 200); assert.strictEqual((await send({ text: "Что такое BOS?" })).statusCode, 200);
  const b = BG.createBudget({ db }); let st = await b.status();
  assert.strictEqual(st.features.vision.spent_usd, 0.011, "Sonnet: 3000 × $2 + 500 × $10 за 1 млн");
  assert.strictEqual(st.features.mentor.spent_usd, 0.00056, "Haiku: 4000 × $0.10 + 300 × $0.50 + 1000 × $0.01 за 1 млн");
  assert.strictEqual(st.total.reserved_usd, 0);
  fail = true; assert.strictEqual((await send({ text: "Ещё вопрос" })).statusCode, 503); st = await b.status();
  assert.deepStrictEqual([st.features.mentor.spent_usd, st.total.reserved_usd, st.features.mentor.errors], [0.00056, 0, 1]);
});

test("округление: сотни резервов и возвратов с «некруглыми» суммами не оставляют остатка в резерве", async () => {
  const { b } = await mk({ monthly_total_usd: 100, features: { mentor: 95, vision: 0, daily: 0 }, reserve_usd: 5, per_user_monthly_usd: 100 });
  for (let i = 0; i < 300; i++) { const r = await b.reserve("mentor", 0.000123456789 * (i % 7 + 1), "u" + (i % 3)); if (i % 2) await b.release(r); else await b.settle(r, 0.00003141592); }
  const st = await b.status(); assert.strictEqual(st.total.reserved_usd, 0); assert.strictEqual(st.features.mentor.reserved_usd, 0); assert.strictEqual(st.open_reservations, 0);
});
