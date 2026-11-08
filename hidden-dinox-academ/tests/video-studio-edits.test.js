"use strict";
/* Video Studio: слой правок и общее ядро. node --test tests/video-studio-edits.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../video-studio/edits");
const core = require("../public/academy/admin/vs-core.js");
const S = require("../video-studio/settings");

const clip = () => ({
  hook: "Дисциплина важнее входа",
  words: [["Запомните", 10.0, 10.5], ["дисциплина", 10.6, 11.2], ["важнее", 11.3, 11.7], ["красивого", 11.8, 12.4], ["входа", 12.5, 13.0],
          ["Я", 14.2, 14.3], ["всегда", 14.4, 14.9], ["жду", 15.0, 15.3], ["закрытия", 15.4, 16.0], ["свечи", 16.1, 16.6]].map(([text, start, end], i) => ({ id: "w" + String(i).padStart(4, "0"), text, start, end }))
});
const times = e => E.visible(e).map(w => [w.text, w.start, w.end]);

test("исправление слова не меняет таймкоды, оригинал сохраняется", () => {
  const e0 = E.initEdits(clip()), e1 = E.applyOps(e0, [{ op: "set_text", id: "w0001", text: "Дисциплина," }]);
  const w = e1.words[1]; assert.equal(w.text, "Дисциплина,"); assert.equal(w.start, 10.6); assert.equal(w.end, 11.2);
  assert.deepEqual(w.orig, { text: "дисциплина", start: 10.6, end: 11.2 }); assert.equal(e1.rev, 1); assert.equal(e0.rev, 0, "исходный объект не мутируется");
});
test("удаление и восстановление слова", () => {
  const e1 = E.applyOps(E.initEdits(clip()), [{ op: "delete", id: "w0002" }]); assert.equal(E.visible(e1).length, 9);
  const e2 = E.applyOps(e1, [{ op: "restore", id: "w0002" }]); assert.deepEqual(times(e2), times(E.initEdits(clip())));
});
test("добавленное слово получает время между соседями и помечается как несинхронизированное", () => {
  const e = E.applyOps(E.initEdits(clip()), [{ op: "add_after", after_id: "w0004", text: "сегодня" }]);
  const n = e.words[5]; assert.equal(n.text, "сегодня"); assert.ok(n.start >= 12.5 && n.end <= 14.2 + 1e-9, "внутри промежутка"); assert.equal(n.synced, false); assert.equal(n.added, true);
  assert.deepEqual(E.visible(e).map(w => w.text).slice(3, 7), ["красивого", "входа", "сегодня", "Я"]);
  const ok = E.applyOps(e, [{ op: "confirm_sync", id: n.id }]); assert.equal(ok.words[5].synced, true);
});
test("слово можно вставить в самое начало и в самый конец", () => {
  const e = E.applyOps(E.initEdits(clip()), [{ op: "add_after", after_id: null, text: "Так" }, { op: "add_after", after_id: "w0009", text: "вот" }]);
  const v = E.visible(e); assert.equal(v[0].text, "Так"); assert.ok(v[0].start <= 10.0); assert.equal(v[v.length - 1].text, "вот"); assert.ok(v[v.length - 1].start >= 16.1);
});
test("ручное время нового слова принимается, но порядок слов нарушать нельзя", () => {
  const e = E.applyOps(E.initEdits(clip()), [{ op: "add_after", after_id: "w0004", text: "ага", start: 13.2, end: 13.5 }]); assert.equal(e.words[5].synced, true);
  assert.throws(() => E.applyOps(E.initEdits(clip()), [{ op: "set_time", id: "w0003", start: 9.0, end: 9.5 }]), err => err.code === "ORDER");
  assert.throws(() => E.applyOps(E.initEdits(clip()), [{ op: "set_time", id: "w0003", start: 12.0, end: 11.0 }]), err => err.code === "BAD_TIME");
});
test("правка предложения: неизменённые слова сохраняют время, новые вставляются в окно между ними", () => {
  const e0 = E.initEdits(clip());
  const e = E.applyOps(e0, [{ op: "rewrite_range", from_id: "w0000", to_id: "w0004", text: "Запомните: дисциплина всегда важнее входа" }]);
  const v = E.visible(e); assert.deepEqual(v.slice(0, 5).map(w => w.text), ["Запомните:", "дисциплина", "всегда", "важнее", "входа"]);
  const byText = t => v.find(w => w.text === t);
  assert.equal(byText("дисциплина").start, 10.6); assert.equal(byText("важнее").start, 11.3); assert.equal(byText("входа").start, 12.5);
  const nw = byText("всегда"); assert.equal(nw.synced, false); assert.ok(nw.start >= 11.2 - 1e-9 && nw.start <= 11.3 && nw.end <= 11.3 + 1e-9, "новое слово внутри окна между «дисциплина» и «важнее»");
  assert.equal(e.words.find(w => w.id === "w0003").deleted, true, "«красивого» удалено, но не стёрто");
  assert.equal(e.words.find(w => w.id === "w0003").orig.text, "красивого");
});
test("полная переписка предложения распределяет время по длине слов внутри исходного диапазона", () => {
  const e = E.applyOps(E.initEdits(clip()), [{ op: "rewrite_range", from_id: "w0005", to_id: "w0009", text: "Всегда жду закрытие свечи перед входом" }]);
  const v = E.visible(e).slice(5); assert.ok(v.length === 6); assert.ok(v[0].start >= 14.2 - 1e-9 && v[v.length - 1].end <= 16.6 + 1e-9);
  for (let i = 1; i < v.length; i++) assert.ok(v[i].start >= v[i - 1].start, "порядок сохраняется");
});
test("хук: правка, лимиты, сброс; предупреждение об обещании прибыли", () => {
  let e = E.applyOps(E.initEdits(clip()), [{ op: "set_hook", text: "Гарантированная прибыль каждый день", size: 70, y: 500 }]);
  assert.equal(e.hook.size, 70); assert.ok(E.checks(e).warnings.some(w => w.code === "PROMISE"));
  assert.throws(() => E.applyOps(e, [{ op: "set_hook", size: 5 }]), x => x.code === "BAD_HOOK");
  assert.throws(() => E.applyOps(e, [{ op: "set_hook", text: "а".repeat(81) }]), x => x.code === "HOOK_TOO_LONG");
  e = E.applyOps(e, [{ op: "reset_hook" }]); assert.equal(e.hook.text, "Дисциплина важнее входа"); assert.equal(e.hook.size, null);
});
test("служебные символы ASS не проходят в тексты", () => {
  const e = E.applyOps(E.initEdits(clip()), [{ op: "set_text", id: "w0000", text: "{\\fs200}Хак" }]); assert.equal(e.words[0].text, "fs200Хак");
  const h = E.applyOps(e, [{ op: "set_hook", text: "{\\an5}Хук" }]); assert.equal(h.hook.text, "an5Хук");
});
test("неизвестные операции и пустые наборы отклоняются", () => {
  assert.throws(() => E.applyOps(E.initEdits(clip()), [{ op: "drop_table" }]), x => x.code === "BAD_OP");
  assert.throws(() => E.applyOps(E.initEdits(clip()), []), x => x.code === "BAD_OPS");
  assert.throws(() => E.applyOps(E.initEdits(clip()), [{ op: "set_text", id: "нет", text: "x" }]), x => x.code === "NO_WORD");
  assert.throws(() => E.applyOps(E.initEdits(clip()), [{ op: "set_text", id: "w0000", text: "два слова" }]), x => x.code === "USE_REWRITE");
});
test("хэш: одинаковые правки дают одинаковый хэш, изменение хука или слова — другой, ревизия не влияет", () => {
  const a = E.initEdits(clip()), b = E.applyOps(a, [{ op: "set_hook", text: a.hook.text }]);
  assert.equal(E.editsHash(a), E.editsHash(b), "ревизия не влияет на хэш");
  assert.notEqual(E.editsHash(a), E.editsHash(E.applyOps(a, [{ op: "set_hook", text: "Другой хук" }])));
  assert.notEqual(E.editsHash(a), E.editsHash(E.applyOps(a, [{ op: "set_text", id: "w0001", text: "дисциплина," }])));
  assert.notEqual(E.editsHash(a, { v: 1 }), E.editsHash(a, { v: 2 }), "смена шаблона меняет хэш");
});
test("длительность и предупреждения считаются по эффективным словам", () => {
  const c = E.checks(E.initEdits(clip()), null, { min_s: 3, max_s: 35 }); assert.ok(c.final_s > 5 && c.final_s < 9); assert.equal(c.can_render, true);
  assert.ok(E.checks(E.initEdits(clip())).warnings.some(w => w.code === "SHORT"), "короче 15 с — предупреждение");
});
test("блоки субтитров: ручные границы и объединение", () => {
  const w = E.effectiveWords(E.initEdits(clip())), base = core.chunkWords(w).map(c => c.map(x => x.word));
  const forced = core.chunkWords(w, { breaks: ["w0000"] }).map(c => c.map(x => x.word)); assert.deepEqual(forced[0], ["Запомните"]);
  assert.equal(base[0].length, 2, "блок закрывается по длине в символах"); const joined = core.chunkWords(w, { joins: ["w0001"] }).map(c => c.map(x => x.word)); assert.equal(joined[0].length, 3, "ручное объединение не даёт разорвать блок после 2-го слова");
});
test("ядро vs-core.js совпадает с оригиналом v4 (400 случаев из настоящих функций make_clips.py, включая точные границы)", () => {
  const cases = require("./fixtures/video-studio/core_cases.json"); let probes = 0;
  const r = x => +x.toFixed(9);
  for (const c of cases) {
    const k = core.buildKeep(c.words, c.cuts); assert.deepEqual(k.map(p => p.map(r)), c.keep.map(p => p.map(r)));
    for (const [p, exp] of c.probes) { probes++; assert.ok(Math.abs(core.toOut(p, k) - exp) < 1e-9); }
    if (!c.cuts) assert.deepEqual(core.chunkWords(c.words).map(ch => ch.map(w => w.word)), c.chunks);
  }
  assert.ok(probes > 5000);
});
test("настройки: подсказка Groq укладывается в бюджет, шаблон проверяется, лимиты по умолчанию из ваших значений", () => {
  const p = S.buildGroqPrompt(S.VOCAB_DEFAULT); assert.ok(p.prompt.length <= 440); assert.ok(p.used.includes("Hidden Dinox") && p.used.includes("Pocket Option"));
  assert.throws(() => S.validateTemplatePatch({ hook: { size: 999 } }), x => x.code === "INVALID_TEMPLATE");
  assert.throws(() => S.validateTemplatePatch({ hook: { evil: 1 } }), x => x.code === "INVALID_TEMPLATE");
  assert.throws(() => S.validateTemplatePatch({ cta: { text: "{\\an5}x" } }), x => x.code === "INVALID_TEMPLATE");
  assert.deepEqual(S.validateTemplatePatch({ colors: { accent: "#a6f32b" } }), { colors: { accent: "#A6F32B" } });
  assert.equal(S.DEFAULT_LIMITS.monthly_usd, 5); assert.equal(S.DEFAULT_LIMITS.per_job_usd, 1); assert.equal(S.DEFAULT_LIMITS.max_upload_gb, 5); assert.equal(S.defaultLimits({ VIDEO_STUDIO_MONTHLY_BUDGET_USD: "12" }).monthly_usd, 12); assert.equal(S.defaultLimits({ VIDEO_STUDIO_MONTHLY_BUDGET_USD: "abc" }).monthly_usd, 5, "мусор в окружении не отключает лимит");
  const sug = S.suggestTerms([{ id: "a", text: "колл" }, { id: "b", text: "Pokket" }, { id: "c", text: "привет" }], S.VOCAB_DEFAULT);
  assert.ok(sug.find(s => s.id === "a" && s.to === "Call")); assert.ok(!sug.find(s => s.id === "c"));
});

test("булевы операции редактора принимают только true/false (а не «похожее на правду»)", () => {
  const e0 = E.initEdits(clip());
  for (const bad of ["true", "false", "1", 1, 0, null, undefined, {}, []]) {
    for (const op of [{ op: "set_emphasis", id: "w0000", on: bad }, { op: "set_break", id: "w0000", on: bad }, { op: "set_join", id: "w0000", on: bad }])
      assert.throws(() => E.applyOps(e0, [op]), x => x.code === "BAD_VALUE", op.op + " " + JSON.stringify(bad));
    if (bad !== undefined) for (const op of [{ op: "set_hook", enabled: bad }, { op: "set_cta", enabled: bad }]) assert.throws(() => E.applyOps(e0, [op]), x => x.code === "BAD_VALUE", op.op + " " + JSON.stringify(bad));
  }
  const e1 = E.applyOps(e0, [{ op: "set_emphasis", id: "w0000", on: true }, { op: "set_hook", enabled: false }, { op: "set_cta", enabled: false }]); assert.deepEqual(e1.emphasis, ["w0000"]); assert.strictEqual(e1.hook.enabled, false); assert.strictEqual(e1.cta.enabled, false);
  assert.deepEqual(E.applyOps(e1, [{ op: "set_emphasis", id: "w0000", on: false }]).emphasis, []);
});
