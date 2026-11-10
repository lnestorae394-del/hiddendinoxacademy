/* HIDDEN DINOX VIDEO STUDIO — общее ядро (браузер и сервер используют ОДИН файл).
   Повторяет алгоритмы монтажёра v4 (make_clips.py): вырезание пауз, привязка времени субтитров, деление на блоки.
   Правильность проверяется тестами против исходного Python-кода. Секретов в файле нет. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(); else root.VSCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const CUTS = { lead: 0.08, gap_max: 0.40, gap_keep: 0.12, tail: 0.30 };
  /* Отрезки исходного времени, которые остаются в ролике (v4: build_keep). words: [{start,end}] в порядке речи. */
  function buildKeep(words, cuts) {
    const c = Object.assign({}, CUTS, cuts || {});
    if (!words || !words.length) return [];
    const keep = []; let a = Math.max(0, words[0].start - c.lead);
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i + 1].start - words[i].end > c.gap_max) { keep.push([a, words[i].end + c.gap_keep]); a = words[i + 1].start - c.gap_keep; }
    }
    keep.push([a, words[words.length - 1].end + c.tail]);
    return keep.filter(p => p[1] - p[0] > 0.05);
  }
  /* Время после вырезания пауз для исходного момента t (v4: to_out). */
  function toOut(t, keep) {
    let cum = 0;
    for (const [a, b] of keep) { if (t < a) return cum; if (t <= b) return cum + (t - a); cum += b - a; }
    return cum;
  }
  const finalDuration = keep => keep.reduce((s, p) => s + (p[1] - p[0]), 0);
  /* Блоки субтитров (v4: chunk_words) + ручные границы: breaks — завершить блок после слова, joins — не разрывать после слова
     (если блок не стал длиннее max_words + 2). Без breaks/joins результат ИДЕНТИЧЕН v4. */
  function chunkWords(ws, opt) {
    const o = Object.assign({ max_words: 3, max_chars: 20 }, opt || {});
    const breaks = new Set(o.breaks || []), joins = new Set(o.joins || []);
    const chunks = []; let cur = [];
    for (const w of ws) {
      cur.push(w);
      const len = cur.reduce((s, x) => s + x.word.length, 0) + cur.length;
      const natural = cur.length >= o.max_words || len >= o.max_chars || /[,.!?…]$/.test(w.word);
      const forced = w.id !== undefined && breaks.has(w.id);
      const held = w.id !== undefined && joins.has(w.id) && cur.length < o.max_words + 2;
      if (forced || (natural && !held)) { chunks.push(cur); cur = []; }
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }
  return { CUTS, buildKeep, toOut, finalDuration, chunkWords };
});
