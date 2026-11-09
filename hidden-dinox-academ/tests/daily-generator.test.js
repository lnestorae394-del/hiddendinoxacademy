"use strict";
/* Автопополнение Daily Tests: проверка вопросов, низкий запас, проверка администратором, автопубликация, раз в день, блокировка, ошибки, бюджет, cron. */
const test = require("node:test"), assert = require("node:assert"), path = require("path"), fs = require("fs");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify } = require("./helpers/http");
const { adminCaller } = require("./helpers/router");
const { createAdminApi } = require("../academy/admin-api");
const G = require("../academy/daily-generator");
const ROOT = path.join(__dirname, ".."), quiet = { log() {}, warn() {}, error() {} };
let base = null;
async function prepared() {
  if (base) return base; const db = new FakeFirestore(), A = adminCaller(createAdminApi({ db, verifyIdToken: fakeVerify, log: quiet }));
  await db.collection("users").doc("boss").set({ role: "admin", email: "b@t" });
  for (const f of ["content/hidden-reaction-course.json", "content/binary/smart_money_concepts_binary.json", "content/binary/risk_management_binary.json"]) {
    const r = await A("POST", "/import/course", { uid: "boss", body: { confirm: true, data: JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")) } });
    await A("POST", `/courses/${r.body.course_id}/ready-all`, { uid: "boss", body: { confirm: true } }); await A("POST", `/courses/${r.body.course_id}/publish`, { uid: "boss", body: { confirm: true } }); }
  await require("../academy/daily-tests").createDailyTests({ db, log: quiet }).importBank(path.join(ROOT, "content/daily-bank/daily_bank.json"));
  base = new Map(db.store); return base;
}
/* имитация Claude: цитирует текст урока дословно (как требует инструкция); mode задаёт плохие варианты */
let uniq = 0;
function fakeApi(mode = "good") {
  const calls = []; const f = async (url, init) => { const b = JSON.parse(init.body); calls.push(b);
    if (f.fail) return { ok: false, status: 529, json: async () => ({}) };
    const lesson = /<lesson>\n([\s\S]*?)\n<\/lesson>/.exec(b.messages[0].content)[1], sentence = lesson.split(/(?<=[.!?])\s+/).find(x => x.split(" ").length >= 8) || lesson.slice(0, 120);
    const quote = sentence.split(" ").slice(0, 8).join(" "), n = Number(/Составь (\d+)/.exec(b.messages[0].content)[1]);
    const qs = Array.from({ length: n }, (_, i) => { const k = ++uniq, topic = ["ликвидность", "откат", "структура", "риск", "экспирация", "импульс"][k % 6];
      const g = { type: ["terminology", "structure", "chart_scenario", "risk", "error_finding"][k % 5], difficulty: ["beginner", "intermediate", "advanced"][k % 3],
        q: `Вопрос номер ${k} про ${topic}: что верно по этому уроку для варианта ${k * 7}?`, options: [`Верный ответ ${k}`, `Неверный А ${k}`, `Неверный Б ${k}`, `Неверный В ${k}`], correct: 0,
        explanation: `Правильный ответ следует из текста урока, где прямо сказано: ${quote}.`, why_wrong: ["Противоречит уроку.", "В уроке сказано иначе.", "Это смешение понятий."], source_quote: quote,
        en: { q: `Question ${k} about the lesson: what is correct here?`, options: [`Correct ${k}`, `Wrong A ${k}`, `Wrong B ${k}`, `Wrong C ${k}`], explanation: "The lesson states this directly in its text." },
        ua: { q: `Питання ${k} щодо уроку: що тут правильно?`, options: [`Правильна ${k}`, `Хибна А ${k}`, `Хибна Б ${k}`, `Хибна В ${k}`], explanation: "Це прямо сказано в тексті уроку, і це видно з прикладу." } };
      if (mode === "bad_ua") g.ua.q = "Вопрос на русском, а не на украинском ы";
      return g; });
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "```json\n" + JSON.stringify({ questions: qs }) + "\n```" }], usage: { input_tokens: 3000, output_tokens: 2500 } }) }; };
  f.calls = calls; return f;
}
async function setup({ api = fakeApi(), gen = {}, low = true } = {}) {
  const db = new FakeFirestore(); db.store = new Map(await prepared());
  if (low) {   // низкий запас: по 6 одобренных вопросов на курс (HR/SMC — на 3 дня, RM — на 6 дней), остальные отключены
    const kept = {}; for (const d of (await db.collection("daily_bank").get()).docs) { const q = d.data(); if (q.status !== "approved") continue;
      kept[q.course] = (kept[q.course] || 0) + 1; if (kept[q.course] > 6) await db.collection("daily_bank").doc(d.id).set({ ...q, status: "disabled" }); } }
  const g = G.createGenerator({ db, env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: api, log: quiet });
  await g.setSettings({ enabled: true, auto_publish: false, min_days: 7, target_days: 10, max_per_run: 12, ...gen });
  return { db, g, api, D: require("../academy/daily-tests").createDailyTests({ db, log: quiet }) };
}
const lessonCtx = text => ({ course: "smc", existing: [{ course: "smc", q: "Что такое Order Block в бинарных опционах по курсу?" }], lessonNorm: text.toLowerCase().replace(/ё/g, "е") });
const good = () => ({ type: "terminology", difficulty: "beginner", q: "Что показывает снятие ликвидности над равными максимумами?", options: ["Сбор стопов перед разворотом", "Гарантированный рост", "Отсутствие интереса", "Ошибку котировки"], correct: 0,
  explanation: "Урок объясняет, что цена забирает ликвидность за экстремумом и часто разворачивается.", why_wrong: ["Гарантий нет.", "Интерес как раз есть.", "Котировка корректна."], source_quote: "цена забирает ликвидность за экстремумом и часто разворачивается",
  en: { q: "What does a liquidity sweep above equal highs show?", options: ["Stops taken before a reversal", "Guaranteed growth", "No interest", "A quote error"], explanation: "The lesson explains price takes liquidity beyond the extreme." },
  ua: { q: "Що показує зняття ліквідності над рівними максимумами?", options: ["Збір стопів перед розворотом", "Гарантоване зростання", "Відсутність інтересу", "Помилку котирування"], explanation: "Урок пояснює, що ціна забирає ліквідність за екстремумом." } });

test("проверка вопросов: отклоняются неверный индекс, нет объяснений, «все перечисленные», цитата не из урока, дубли; плохой перевод отбрасывается", () => {
  const ctx = lessonCtx("В уроке: цена забирает ликвидность за экстремумом и часто разворачивается после этого.");
  assert.strictEqual(G.validate(good(), ctx).ok, true);
  const bad = (patch, reason) => { const r = G.validate({ ...good(), ...patch }, ctx); assert.strictEqual(r.ok, false, reason); assert.ok(r.reasons.includes(reason), reason + ": " + r.reasons); };
  bad({ correct: 4 }, "correct_index"); bad({ explanation: "коротко" }, "explanation"); bad({ why_wrong: ["одно"] }, "why_wrong");
  bad({ options: ["Все перечисленные", "Б вариант", "В вариант", "Г вариант"] }, "ambiguous_option"); bad({ source_quote: "этой фразы в уроке совсем нет и быть не может" }, "not_grounded");
  bad({ q: "Что такое Order Block в бинарных опционах по курсу?" }, "duplicate"); bad({ q: "Что именно такое Order Block в бинарных опционах по курсу?" }, "near_duplicate");
  bad({ options: ["А", "А", "Б", "В"] }, "options");
  const t = G.validate({ ...good(), en: { q: "Вопрос по-русски", options: ["а", "б", "в", "г"], explanation: "Объяснение по-русски для проверки" } }, ctx);
  assert.strictEqual(t.ok, true); assert.ok(!t.tr.en && t.tr.ua && t.issues.includes("translation_en"), "испорченный перевод отброшен, вопрос сохранён");
});

test("низкий запас: генерация до лимита, на проверке по умолчанию, источник и метаданные, расход в доле Daily Tests; в наборы — только после одобрения", async () => {
  const { db, g, api, D } = await setup({ gen: { max_per_run: 6 } });
  const r = await g.run({ trigger: "cron" });
  assert.strictEqual(r.status, "generated", JSON.stringify(r)); assert.strictEqual(r.accepted, 6); assert.ok(api.calls.length >= 2);
  assert.deepStrictEqual([api.calls[0].model, api.calls[0].output_config.effort], ["claude-haiku-5-5", "low"]);
  const ai = (await D.bankAll()).filter(q => q.source === "ai_generated"); assert.strictEqual(ai.length, 6);
  for (const q of ai) { assert.deepStrictEqual([q.status, q.review_status, q.model], ["needs_review", "pending_review", "claude-haiku-5-5"]);
    assert.ok(q.source_material_ids.length === 2 && /#m\d+l\d+$/.test(q.source_material_ids[1])); assert.ok(["term", "choice", "situation", "error"].includes(q.kind) && q.difficulty);
    assert.deepStrictEqual(q.translation_status, { en: "draft", ua: "draft" }); assert.match(q.explanation, /Почему не другие варианты/); assert.match(q.source_ref, /^урок «/); }
  const st = await require("../academy/ai-budget").createBudget({ db }).status(); assert.ok(st.features.daily.spent_usd > 0 && st.features.daily.requests >= 2); assert.strictEqual(st.total.reserved_usd, 0);
  const set = await D.ensureSet("2026-12-01"); assert.ok(set.status === "created");
  const used = (await db.collection("daily_sets").doc("2026-12-01").get()).data().questions.map(q => q.id); assert.ok(!used.some(id => id.startsWith("q_ai_")), "неодобренные ИИ-вопросы не попадают в наборы");
  const up = await D.bankUpdate(ai[0].id, { status: "approved" }); assert.deepStrictEqual([up.status, up.review_status], ["approved", "approved"]);
  assert.strictEqual((await D.bankUpdate(ai[1].id, { status: "disabled" })).review_status, "rejected");
});

test("автопубликация — только вопросы без замечаний; нормальный запас — без обращения к API", async () => {
  const a = await setup({ api: fakeApi("bad_ua"), gen: { auto_publish: true, max_per_run: 3 } });
  await a.g.run({ trigger: "cron" }); const ai = (await a.D.bankAll()).filter(q => q.source === "ai_generated");
  assert.ok(ai.length === 3 && ai.every(q => q.status === "needs_review" && q.issues.includes("translation_ua")), "с замечанием — не публикуется автоматически");
  const b = await setup({ gen: { auto_publish: true, max_per_run: 3 } }); await b.g.run({ trigger: "cron" });
  assert.ok((await b.D.bankAll()).filter(q => q.source === "ai_generated").every(q => q.status === "approved" && q.review_status === "auto_approved"));
  const c = await setup({ low: false }); const r = await c.g.run({ trigger: "cron" });   // полный банк: запаса на 17+ дней
  assert.strictEqual(r.status, "stock_ok"); assert.strictEqual(c.api.calls.length, 0);
});

test("раз в день, ручной запуск из админки, блокировка параллельного запуска, ошибка API и исчерпанный бюджет", async () => {
  const { g, api, db } = await setup({ gen: { max_per_run: 3 } });
  const [x, y] = await Promise.all([g.run({ trigger: "cron" }), g.run({ trigger: "cron" })]);
  assert.deepStrictEqual([x.status, y.status].sort(), ["generated", "locked"].sort(), "второй параллельный запуск заблокирован");
  assert.strictEqual((await g.run({ trigger: "cron" })).status, "already_ran"); const calls = api.calls.length;
  assert.strictEqual((await g.run({ trigger: "admin", force: true })).status, "generated", "ручной запуск работает всегда"); assert.ok(api.calls.length > calls);
  api.fail = true; const f = await g.run({ trigger: "admin", force: true }); assert.strictEqual(f.status, "failed"); assert.ok(f.errors.includes("AI_UNAVAILABLE"));
  assert.strictEqual((await require("../academy/ai-budget").createBudget({ db }).status()).total.reserved_usd, 0, "резерв возвращён");
  api.fail = false; await require("../academy/ai-budget").createBudget({ db }).setSettings({ monthly_total_usd: 100, features: { mentor: 50, vision: 50, daily: 0 }, reserve_usd: 0, per_user_monthly_usd: 2, per_user_daily_images: 5 });
  const before = api.calls.length, e = await g.run({ trigger: "admin", force: true });
  assert.ok(e.errors.includes("BUDGET_EXHAUSTED")); assert.strictEqual(api.calls.length, before, "без обращения к API");
});

test("cron: наборы создаются даже при ошибке генерации; админка — права и проверка настроек", async () => {
  const api = fakeApi(); api.fail = true; const { db } = await setup({ api, gen: {} });
  const routes = {}; const app = { post: (p, h) => { routes[p] = h; } };
  require("../academy/daily-cron").registerDailyCron(app, { db, env: { DAILY_CRON_SECRET: "x".repeat(30), ANTHROPIC_API_KEY: "k" }, log: quiet, aiFetch: api });
  let out; await routes["/internal/daily/run"]({ headers: { "x-cron-secret": "x".repeat(30) } }, { set() {}, status() { return this; }, json(b) { out = b; } });
  assert.ok(["created", "exists"].includes(out.today.status), "наборы созданы"); assert.strictEqual(out.generator.status, "failed");
  const A = adminCaller(createAdminApi({ db, verifyIdToken: fakeVerify, log: quiet, env: { ANTHROPIC_API_KEY: "k" }, aiFetch: fakeApi() }));
  await db.collection("users").doc("stu").set({ role: "student", email: "s@t" });
  assert.strictEqual((await A("GET", "/daily/generator", { uid: "stu" })).statusCode, 403);
  assert.strictEqual((await A("PUT", "/daily/generator/settings", { uid: "boss", body: { min_days: 7, target_days: 20, max_per_run: 5 } })).statusCode, 400, "запас 7–14 дней");
  assert.strictEqual((await A("POST", "/daily/generator/run", { uid: "boss", body: {} })).statusCode, 400, "ручной запуск — с подтверждением");
  const st = await A("GET", "/daily/generator", { uid: "boss" }); assert.strictEqual(st.statusCode, 200); assert.ok("pending_review" in st.body.counts && st.body.spend);
});
