"use strict";
/* Отбор моментов: перенос алгоритмов монтажёра v4 (build_units, trim_fillers, apply_fixes, validate, prompt_for) на Node.
   Результаты сверяются с оригинальными функциями Python v4 на сотнях случайных данных (tests/video-studio-moments.test.js).
   Принцип: Claude выбирает ТОЛЬКО номера фраз; время, цитаты и хуки проверяет код. Выдуманное отклоняется. */
const M = require("./defaults/moments.json");
const core = require("../public/video-studio/js/vs-core.js"), { pyFixed } = require("./pyfmt");
const STOP = new Set(M.stop), FILLERS = new Set(M.fillers), CATS = new Set(M.cats), C = M.constants;
const W = "\\p{L}\\p{N}_";                                       // «\w» из Python
const NONWORD = new RegExp("[^" + W + "]", "gu");
const norm = s => String(s).toLowerCase().replace(/ё/g, "е").replace(new RegExp("[^" + W + "\\s]", "gu"), " ").replace(/\s+/gu, " ").trim();
const cps = s => Array.from(s);
const stemsOf = s => new Set(norm(s).split(" ").filter(w => w && cps(w).length >= 4 && !STOP.has(w)).map(w => cps(w).slice(0, 5).join("")));
const B1 = "(?<![" + W + "])", B2 = "(?![" + W + "])";                 // «\b» из Python
const LOW_VALUE = new RegExp("(?:все\\s+)?кидаем\\s+в\\s+чат|" + B1 + "якор[ьяь]?" + B2 + "|напишите\\s+в\\s+чат|пишите\\s+в\\s+чат|ставьте\\s+лайк|поставьте\\s+лайк|подписывайтесь|подпишитесь|кто\\s+не\\s+в\\s+телеграм", "iu");
const BAD_HOOK = new RegExp("гарант|без риска|100\\s?%|сто процентов|легк[" + W + "]+ заработ|точно заработ|х\\p{Nd}+ за", "iu");
const SENT_END = /[.!?…]+["»)]*$/u;
const py1 = x => Number(pyFixed(x, 1));

function buildUnits(data) {
  const words = ((data && data.words) || []).filter(w => w && String(w.word || "").trim()).map((w, gi) => ({ word: String(w.word).trim(), start: Number(w.start), end: Number(w.end), gi }));
  let segs = (data && data.segments) || [];
  const units = []; let p = 0;
  const push = cur => { if (cur.length) units.push({ id: units.length, start: cur[0].start, end: cur[cur.length - 1].end, words: cur, text: cur.map(x => x.word).join(" ") }); };
  if (!segs.length) segs = [{ start: 0, end: 1e9, text: "" }];
  for (const s of segs) {
    const sw = [];
    while (p < words.length && words[p].start < s.end + 0.05) { sw.push(words[p]); p++; }
    if (!sw.length) continue;
    const toks = String(s.text || "").split(/\s+/u).filter(Boolean);
    const ends = toks.length === sw.length ? new Set(toks.map((t, i) => (SENT_END.test(t) ? i : -1)).filter(i => i >= 0)) : new Set();
    let cur = [];
    sw.forEach((w, i) => {
      cur.push(w);
      const gap = i + 1 < sw.length ? sw[i + 1].start - w.end : 9;
      if (ends.has(i) || gap > 0.8 || w.end - cur[0].start > 12 || i === sw.length - 1) { push(cur); cur = []; }
    });
  }
  return units;
}
function trimFillers(words) {
  const ws = words.slice();
  for (let k = 0; k < 2; k++) if (ws.length > 6 && FILLERS.has(ws[0].word.toLowerCase().replace(NONWORD, ""))) ws.shift();
  return ws;
}
function applyFixes(byUnit, fixes) {
  let n = 0; if (!Array.isArray(fixes)) return n;
  const key = s => String(s).toLowerCase().replace(NONWORD, "");
  for (const f of fixes) {
    if (!f || typeof f !== "object" || Array.isArray(f)) continue;
    const ws = byUnit[f.unit_id];
    if (!ws || !ws.length || !f.old || !f.new || String(f.new).split(/\s+/u).filter(Boolean).length !== 1 || String(f.old).split(/\s+/u).filter(Boolean).length !== 1) continue;
    for (const w of ws) if (key(w.word) === key(f.old)) { w.word = String(f.new).trim(); n++; break; }
  }
  return n;
}
/* opts: { minFinal, maxFinal, hookMax, minScore, cuts } — длительность клипа выбирается в настройках (по умолчанию 15–35 с, лучшее 20–30 с) */
function validate(resp, units, opts = {}) {
  const o = Object.assign({ minFinal: C.MIN_FINAL, maxFinal: C.MAX_FINAL, sweetLo: C.SWEET_LO, sweetHi: C.SWEET_HI, hookMax: C.HOOK_MAX, minScore: C.MIN_SCORE, cuts: null }, opts);
  const byId = new Map(units.map(u => [u.id, u])), ok = [], bad = [];
  if (!resp || typeof resp !== "object" || Array.isArray(resp) || (resp.moments !== undefined && !Array.isArray(resp.moments))) return { ok: [], bad: [{ reason: "ответ Claude не соответствует схеме" }] };
  const taken = [];
  const moments = (resp.moments || []).filter(m => m && typeof m === "object" && !Array.isArray(m));
  moments.sort((a, b) => (typeof b.score === "number" ? b.score : 0) - (typeof a.score === "number" ? a.score : 0));
  for (const m of moments) {
    let why = null; const ids = m.unit_ids;
    if (!Array.isArray(ids) || !ids.length || !ids.every(i => Number.isInteger(i) && byId.has(i))) why = "номера фраз отсутствуют или не существуют в транскрипте";
    else if (ids.some((v, i) => i > 0 && v <= ids[i - 1])) why = "номера фраз повторяются или идут не по порядку";
    else if (ids.some((v, i) => i > 0 && v - ids[i - 1] !== 1)) why = "фразы идут не подряд";
    else {
      const sel = ids.map(i => byId.get(i)), text = norm(sel.map(u => u.text).join(" "));
      const words = trimFillers(sel.flatMap(u => u.words.map(w => Object.assign({}, w))));
      const hook = String(m.hook === undefined ? "" : m.hook).trim(), q1 = norm(String(m.hook_source_quote === undefined ? "" : m.hook_source_quote)), q2 = norm(String(m.quote_check === undefined ? "" : m.quote_check));
      let keep = [], final = 0;
      if (!words.length) why = "во фрагменте нет слов с таймкодами"; else { keep = core.buildKeep(words, o.cuts); final = keep.reduce((s, [a, b]) => s + b - a, 0); }
      const stemsText = stemsOf(sel.map(u => u.text).join(" ")), overlap = [...stemsOf(hook)].filter(x => stemsText.has(x)).length;
      if (why) { /* уже есть причина */ }
      else if (LOW_VALUE.test(text)) why = "стримерская перекличка/команда чату (например, «якорь») — исключаем такие моменты";
      else if (final < o.minFinal) why = "после вырезания пауз короче " + Math.trunc(o.minFinal) + " с (" + pyFixed(final, 1) + " с)";
      else if (final > o.maxFinal) why = "после вырезания пауз длиннее " + Math.trunc(o.maxFinal) + " с (" + pyFixed(final, 1) + " с)";
      else if (!q1 || !text.includes(q1) || !q2 || !text.includes(q2)) why = "цитата-подтверждение не найдена дословно в расшифровке";
      else if (!hook || cps(hook).length > o.hookMax || BAD_HOOK.test(hook)) why = "хук пустой, длиннее " + o.hookMax + " символов или содержит запрещённое обещание";
      else if (overlap < 1) why = "хук не связан с содержанием фрагмента (нет общих значимых слов)";
      else if (!CATS.has(m.category) || typeof m.score !== "number" || !(m.score >= o.minScore && m.score <= 1)) why = "категория или оценка вне допустимых (оценка ниже 0,45)";
      else if (taken.some(([a, b]) => !(words[words.length - 1].end <= a || words[0].start >= b))) why = "пересекается с более сильным моментом";
      else {
        taken.push([words[0].start, words[words.length - 1].end]);
        ok.push({ unit_ids: ids, words, keep, final_s: py1(final), sweet_spot: final >= o.sweetLo && final <= o.sweetHi, score: Number(m.score), category: m.category, trade_result: ["profit", "recovery", "neutral", "unknown"].includes(m.trade_result) ? m.trade_result : "unknown", hook, title: String(m.title === undefined ? "" : m.title).trim(),
          reason: String(m.reason === undefined ? "" : m.reason), hook_source_quote: String(m.hook_source_quote === undefined ? "" : m.hook_source_quote), fixes: m.subtitle_fixes || [], start: words[0].start, end: words[words.length - 1].end });
      }
    }
    if (why) bad.push({ reason: why, hook: String(m.hook === undefined ? "" : m.hook), unit_ids: Array.isArray(ids) ? ids : null });
  }
  /* Явно подтверждённые прибыльные сделки идут первыми; recovery/перекрытия не вытесняют их. */
  const tradeRank = x => x.trade_result === "profit" ? 3 : x.trade_result === "recovery" ? 0 : 2;
  const categoryRank = x => x.category === "motivation" ? 2 : 1;
  ok.sort((a, b) => (tradeRank(b) - tradeRank(a)) || (categoryRank(b) - categoryRank(a)) || (Number(b.sweet_spot) - Number(a.sweet_spot)) || (b.score - a.score));
  return { ok, bad };
}
const SAMPLE = M.prompt_sample, PREFIX = SAMPLE.slice(0, SAMPLE.indexOf("[7 | 3.5 с] пример фразы"));
const promptFor = units => PREFIX + units.map(u => "[" + u.id + " | " + pyFixed(u.end - u.start, 1) + " с] " + u.text).join("\n");
/* Проверка хука, предложенного ИИ или введённого человеком, против текста клипа (для «Предложить хук») */
function checkHook(hook, clipText, hookMax = C.HOOK_MAX) {
  const h = String(hook || "").trim();
  if (!h || cps(h).length > hookMax || BAD_HOOK.test(h)) return "хук пустой, слишком длинный или содержит запрещённое обещание";
  const st = stemsOf(clipText); if (![...stemsOf(h)].some(x => st.has(x))) return "хук не связан с содержанием клипа";
  return null;
}
module.exports = { M, norm, stemsOf, buildUnits, trimFillers, applyFixes, validate, promptFor, checkHook, SYSTEM: M.system, LOW_VALUE, BAD_HOOK };
