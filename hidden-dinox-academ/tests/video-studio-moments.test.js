"use strict";
/* Перенос отбора моментов v4 на Node сверяется с настоящими функциями Python v4 (build_units, validate, trim_fillers, apply_fixes, prompt_for, norm, stems_of). */
const test = require("node:test"), assert = require("node:assert/strict");
const m = require("../video-studio/moments"), fx = require("./fixtures/video-studio/moments_cases.json");
test("norm, stems_of, trim_fillers, apply_fixes совпадают с v4", () => {
  for (const [s, e] of fx.misc.norm) assert.equal(m.norm(s), e, JSON.stringify(s));
  for (const [s, e] of fx.misc.stems) assert.deepEqual([...m.stemsOf(s)].sort(), e, s);
  for (const c of fx.misc.trim) assert.deepEqual(m.trimFillers(c.words).map(w => w.word), c.out);
  for (const c of fx.misc.fixes) { const d = { 0: [{ word: "колл", start: 0, end: 1 }], 1: [{ word: "Пут,", start: 1, end: 2 }, { word: "два", start: 2, end: 3 }] }; const n = m.applyFixes(d, c.fixes); assert.equal(n, c.n); assert.deepEqual(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.map(w => w.word)])), c.after); }
});
test("фразы, запрос к Claude и проверка моментов совпадают с v4 на %d случаях".replace("%d", fx.cases.length), () => {
  let okTotal = 0, badTotal = 0;
  for (const [i, c] of fx.cases.entries()) {
    const units = m.buildUnits(c.transcript);
    assert.deepEqual(units.map(u => ({ id: u.id, start: u.start, end: u.end, text: u.text, n: u.words.length })), c.units, "фразы, случай " + i);
    assert.equal(m.promptFor(units), c.prompt, "запрос, случай " + i);
    const r = m.validate(c.response, units, { minFinal: 15, maxFinal: 35 });
    assert.deepEqual(r.bad.map(b => b.reason), c.bad, "отклонённые, случай " + i);
    assert.deepEqual(r.ok.map(o => ({ unit_ids: o.unit_ids, final_s: o.final_s, sweet_spot: o.sweet_spot, score: o.score, category: o.category, hook: o.hook, start: o.start, end: o.end, nwords: o.words.length, keep: o.keep })), c.ok, "принятые, случай " + i);
    okTotal += r.ok.length; badTotal += r.bad.length;
  }
  assert.ok(okTotal >= 30 && badTotal >= 100, "эталон содержит и принимаемые, и отклоняемые моменты: " + okTotal + "/" + badTotal);
});
test("настройка длительности клипа: границы берутся из параметров, а не зашиты", () => {
  const c = fx.cases.find(x => x.ok.length), units = m.buildUnits(c.transcript), o = c.ok[0];
  assert.equal(m.validate(c.response, units, { minFinal: o.final_s + 1, maxFinal: 60 }).ok.some(x => x.unit_ids.join() === o.unit_ids.join()), false, "минимум выше длительности — момент отклоняется");
  assert.equal(m.validate(c.response, units, { minFinal: 5, maxFinal: o.final_s - 1 }).ok.some(x => x.unit_ids.join() === o.unit_ids.join()), false, "максимум ниже длительности — момент отклоняется");
});
test("checkHook: хук должен быть связан с текстом клипа и не содержать обещаний", () => {
  assert.equal(m.checkHook("Дисциплина важнее входа", "Запомните дисциплина важнее красивого входа"), null);
  assert.ok(m.checkHook("Гарантированная прибыль", "Запомните дисциплина важнее красивого входа"));
  assert.ok(m.checkHook("Секрет миллионеров", "Запомните дисциплина важнее красивого входа"));
  assert.ok(m.checkHook("", "текст")); assert.ok(m.checkHook("x".repeat(80), "x текст"));
});
test("pyFixed округляет как Python: точные половинки к чётному, остальное как обычно", () => {
  const { pyFixed } = require("../video-studio/pyfmt");
  for (const [x, n, e] of [[4.25, 1, "4.2"], [4.35, 1, "4.3"], [0.15, 1, "0.1"], [0.0625, 3, "0.062"], [0.1875, 3, "0.188"], [2.5, 0, "2"], [3.5, 0, "4"], [12, 1, "12.0"], [0.0, 3, "0.000"], [35.0499, 1, "35.0"], [0.375, 2, "0.38"], [0.125, 2, "0.12"]]) assert.equal(pyFixed(x, n), e, x + " / " + n);
});
