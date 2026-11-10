"use strict";
/* Субтитры и оформление в формате ASS. Для шаблона по умолчанию без логотипа и без ручных правок результат ПОБАЙТОВО равен ASS из проверенной реализации (v4);
   сверка — tests/video-studio-render.test.js. */
const core = require("../public/video-studio/js/vs-core.js");
const pyRound = x => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };   // округление к чётному, как round() в Python
const assColor = (hex, alpha = "00") => { const h = String(hex).replace("#", ""); return "&H" + alpha.toUpperCase() + (h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toUpperCase(); };
const ffColor = hex => "0x" + String(hex).replace("#", "").toUpperCase();
const assTime = t => { const cs = Math.max(0, pyRound(t * 100)); return Math.trunc(cs / 360000) + ":" + String(Math.trunc((cs % 360000) / 6000)).padStart(2, "0") + ":" + String(Math.trunc((cs % 6000) / 100)).padStart(2, "0") + "." + String(cs % 100).padStart(2, "0"); };
const clean = t => String(t).replace(/[{}\\]/g, "").trim();
const d = Math.trunc;
function makeAssText(tpl, font, hook, words, keep, dur, hookCfg, ctaCfg, breaks = [], joins = [], emphasis = [], captionCfg = null) {
  const c = tpl.colors, cv = tpl.canvas, hk = tpl.hook, sb = tpl.subtitles, cta = tpl.cta, br = tpl.brand, bar = tpl.bar;
  const capLines = captionCfg && captionCfg.enabled ? String(captionCfg.text || "").split("\n").map(clean).filter(Boolean) : [], capOn = capLines.length > 0, cp = Object.assign({ size: 46, x: 540, y: 1765, outline: 3, shadow: 1, margin_l: 72, margin_r: 72 }, tpl.caption || {}, capOn ? Object.fromEntries(["size", "x", "y"].filter(k => captionCfg[k] != null).map(k => [k, captionCfg[k]])) : {});
  const accent = assColor(c.accent), white = assColor(c.text), outline = assColor(c.outline), ctaBack = assColor(cta.back_color, cta.back_alpha);
  const ow = words.map(w => ({ word: clean(w.word), start: core.toOut(w.start, keep), end: core.toOut(w.end, keep), id: w.id }));
  const H = "[Script Info]\nScriptType: v4.00+\nPlayResX: " + d(cv.w) + "\nPlayResY: " + d(cv.h) + "\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n" +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    ["Style: Sub", font, d(sb.size), accent, white, outline, "&H80000000", "-1", "0", "0", "0", "100", "100", "0", "0", "1", d(sb.outline), d(sb.shadow), "2", d(sb.margin_l), d(sb.margin_r), d(sb.margin_v), "1"].join(",").replace("Style: Sub,", "Style: Sub,") + "\n" +
    ["Style: Hook", font, d(hk.size), white, white, accent, "&H00000000", "-1", "0", "0", "0", "100", "100", "0", "0", "1", d(hk.outline), d(hk.shadow), "8", d(hk.margin_l), d(hk.margin_r), "140", "1"].join(",") + "\n" +
    ["Style: Brand", font, d(br.size), accent, accent, "&H00000000", "&H00000000", "-1", "0", "0", "0", "100", "100", d(br.spacing), "0", "1", "0", "0", "7", d(br.margin_l), "0", d(br.margin_v), "1"].join(",") + "\n" +
    ["Style: CTA", font, d(cta.size), white, white, accent, ctaBack, "-1", "0", "0", "0", "100", "100", "0", "0", "3", d(cta.outline), "0", "2", d(cta.margin_l), d(cta.margin_r), d(cta.margin_v), "1"].join(",") + "\n" +
    (capOn ? ["Style: Cap", font, d(cp.size), white, white, outline, "&H80000000", "-1", "0", "0", "0", "100", "100", "0", "0", "1", d(cp.outline), d(cp.shadow), "2", d(cp.margin_l), d(cp.margin_r), "0", "1"].join(",") + "\n" : "") + ["Style: Bar", font, "20", accent, accent, "&H00000000", "&H00000000", "0", "0", "0", "0", "100", "100", "0", "0", "1", "0", "0", "7", "0", "0", "0", "1"].join(",") + "\n\n" +
    "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
  const ev = ["Dialogue: 0," + assTime(0) + "," + assTime(dur) + ",Brand,,0,0,0,," + br.text];
  const h = hookCfg || {};
  if (h.enabled !== false && clean(hook)) {
    const hx = h.x != null ? h.x : hk.x, hy = h.y != null ? h.y : hk.y, fs = h.size ? "\\fs" + d(h.size) : "";
    ev.push("Dialogue: 1," + assTime(0) + "," + assTime(Math.min(hk.show_seconds, dur)) + ",Hook,,0,0,0,,{\\an8\\pos(" + d(hx) + "," + d(hy) + ")" + fs + "\\fad(0,250)\\fscx90\\fscy90\\t(0,170,\\fscx100\\fscy100)}" + clean(hook).replace(/\n/g, " "));
  }
  if (capOn) ev.push("Dialogue: 2," + assTime(0) + "," + assTime(dur) + ",Cap,,0,0,0,,{\\an5\\pos(" + d(cp.x) + "," + d(cp.y) + ")}" + capLines.join("\\N"));   // слой «текст внизу видео»
  const cc = ctaCfg || {};
  if (cta.enabled && cc.enabled !== false) {
    const ctaStart = Math.max(0, dur - Math.min(cta.max_seconds, Math.max(cta.min_seconds, dur * cta.fraction)));
    ev.push("Dialogue: 3," + assTime(ctaStart) + "," + assTime(dur) + ",CTA,,0,0,0,,{\\fad(220,180)\\pos(" + d(cta.x) + "," + d(cc.y != null ? cc.y : cta.y) + ")" + (cc.size ? "\\fs" + d(cc.size) : "") + "\\fscx94\\fscy94\\t(0,180,\\fscx100\\fscy100)}" + clean(cc.text || cta.text));
  }
  if (bar.enabled) ev.push("Dialogue: 1," + assTime(0) + "," + assTime(dur) + ",Bar,,0,0,0,,{\\p1\\an7\\pos(0," + d(bar.y) + ")\\bord0\\shad0\\fscx0\\t(0," + d(dur * 1000) + ",\\fscx100)}m 0 0 l " + d(cv.w) + " 0 l " + d(cv.w) + " " + d(bar.h) + " l 0 " + d(bar.h));
  const chunks = core.chunkWords(ow, { max_words: sb.max_words, max_chars: sb.max_chars, breaks, joins }), emph = new Set(emphasis);
  chunks.forEach((ch, ci) => {
    const st = ch[0].start; let en = ch[ch.length - 1].end + 0.12;
    if (ci + 1 < chunks.length) en = Math.min(en, chunks[ci + 1][0].start);
    en = Math.min(Math.max(en, st + 0.2), dur);
    const parts = ch.map((w, i) => {
      const nxt = i + 1 < ch.length ? ch[i + 1].start : en, k = Math.max(1, d(pyRound((nxt - w.start) * 100))), txt = w.word.replace(/[,.;:]+$/, "");
      return emph.has(w.id) ? "{\\k" + k + "\\2c" + accent + "&}" + txt + "{\\2c" + white + "&}" : "{\\k" + k + "}" + txt;
    });
    ev.push("Dialogue: 2," + assTime(st) + "," + assTime(en) + ",Sub,,0,0,0,,{\\an5\\pos(" + d(sb.x) + "," + d(sb.y) + ")\\fscx88\\fscy88\\t(0,110,\\fscx100\\fscy100)}" + parts.join(" "));
  });
  return { text: H + ev.join("\n") + "\n", chunks: chunks.length };
}
module.exports = { makeAssText, assColor, ffColor, assTime, clean, pyRound };
