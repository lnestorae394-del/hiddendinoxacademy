"use strict";
/* Слой правок клипа. Принципы ТЗ:
   1) оригинальный текст Groq и исходные метки времени НИКОГДА не перезаписываются (поле orig у каждого слова);
   2) правка текста не меняет время; новое слово получает время по соседям и помечается synced:false до подтверждения;
   3) вся пересчётная логика (вырезание пауз, блоки) — в vs-core.js, одна на сервер, воркер (проверено тестами) и предпросмотр. */
const crypto = require("crypto");
const core = require("../public/academy/admin/vs-core.js");

class EditError extends Error { constructor(code, message, extra) { super(message || code); this.status = 400; this.code = code; this.extra = extra; } }
const LIM = { word: 60, hook: 80, cta: 60, caption: 140, maxWordDur: 4, maxWords: 400 };
const nrm = s => String(s == null ? "" : s).toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, "");
const clean = s => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f{}\\]/g, "").replace(/\s+/g, " ").trim();
const clone = v => JSON.parse(JSON.stringify(v));
const PROMISE = /гарант|без риска|100\s?%|сто процентов|легк\w+ заработ|точно заработ|х\d+ за/i;

/* Исходные слова клипа → документ правок (rev 0). clip.words: [{id,text,start,end}] из Groq, не меняются никогда. */
function initEdits(clip) {
  return {
    rev: 0, next_id: 1,
    words: (clip.words || []).map(w => ({ id: w.id, text: w.text, start: w.start, end: w.end, orig: { text: w.text, start: w.start, end: w.end } })),
    hook: { text: clean(clip.hook || ""), size: null, x: null, y: null, enabled: true, orig_text: clean(clip.hook || "") },
    cta: { text: null, enabled: true }, caption: { text: "", enabled: false, size: null, x: null, y: null }, breaks: [], joins: [], emphasis: [], framing: { zoom: 1, pan_x: 0, pan_y: 0 }
  };
}
const visible = e => e.words.filter(w => !w.deleted);
function find(e, id) { const w = e.words.find(x => x.id === id); if (!w) throw new EditError("NO_WORD", "Слово не найдено: " + id); return w; }

function checkOrder(e) {
  let prev = -Infinity;
  for (const w of visible(e)) {
    if (!(w.start >= 0) || !(w.end >= w.start)) throw new EditError("BAD_TIME", "Некорректное время слова «" + w.text + "»");
    if (w.start + 1e-6 < prev) throw new EditError("ORDER", "Слово «" + w.text + "» начинается раньше предыдущего: порядок слов по времени нарушен");
    prev = w.start;
  }
}
/* Раскладка нескольких новых слов по окну [tL,tR] пропорционально длине. Старты строго внутри окна → порядок не нарушается. */
function distribute(tokens, tL, tR, floorStart) {
  const k = tokens.length; if (tR - tL < 0.06 * k) tL = Math.max(floorStart, tR - 0.06 * k);
  if (tR < tL) tR = tL;
  const wts = tokens.map(t => Math.max(1, nrm(t).length)), total = wts.reduce((a, b) => a + b, 0), out = []; let cum = 0;
  for (let i = 0; i < k; i++) { const s = tL + (tR - tL) * cum / total; cum += wts[i]; out.push({ start: +s.toFixed(3), end: +(tL + (tR - tL) * cum / total).toFixed(3) }); }
  return out;
}
function lcs(a, b) {
  const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] && a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return pairs;
}
const newId = e => "n" + String(e.next_id++).padStart(4, "0");
const tokensOf = text => clean(text).split(" ").filter(Boolean).map(t => { if (t.length > LIM.word) throw new EditError("WORD_TOO_LONG", "Слишком длинное слово"); return t; });
const bool = (v, name) => { if (typeof v !== "boolean") throw new EditError("BAD_VALUE", name + ": нужно строго true или false"); return v; };
const toggle = (arr, id, on) => { bool(on, "on"); const i = arr.indexOf(id); if (on && i < 0) arr.push(id); if (!on && i >= 0) arr.splice(i, 1); };

const OPS = {
  set_text(e, op) {
    const w = find(e, op.id), text = clean(op.text);
    if (!text) throw new EditError("EMPTY", "Пустое слово: используйте «удалить»");
    if (/\s/.test(text)) throw new EditError("USE_REWRITE", "Для нескольких слов используйте правку предложения");
    if (text.length > LIM.word) throw new EditError("WORD_TOO_LONG", "Слишком длинное слово");
    w.text = text;
  },
  delete(e, op) { find(e, op.id).deleted = true; },
  restore(e, op) { find(e, op.id).deleted = false; },
  reset_word(e, op) {
    const w = find(e, op.id);
    if (w.added) { w.deleted = true; return; }
    w.text = w.orig.text; w.start = w.orig.start; w.end = w.orig.end; w.deleted = false; delete w.manual; delete w.synced;
  },
  add_after(e, op) {
    const tokens = tokensOf(op.text); if (!tokens.length) throw new EditError("EMPTY", "Пустой текст");
    let idx = -1; if (op.after_id !== null && op.after_id !== undefined) idx = e.words.indexOf(find(e, op.after_id));
    const prev = e.words.slice(0, idx + 1).reverse().find(w => !w.deleted), next = e.words.slice(idx + 1).find(w => !w.deleted);
    let times;
    if (tokens.length === 1 && Number.isFinite(op.start) && Number.isFinite(op.end)) times = [{ start: op.start, end: op.end, manual: true }];
    else {
      const tR = next ? next.start : (prev ? prev.end + 0.3 : 0.3), tL = prev ? Math.min(prev.end, tR) : Math.max(0, tR - 0.3);
      times = distribute(tokens, tL, tR, prev ? prev.start : 0);
    }
    const created = tokens.map((t, i) => ({ id: newId(e), text: t, start: times[i].start, end: times[i].end, added: true, synced: !!times[i].manual, manual: !!times[i].manual }));
    e.words.splice(idx + 1, 0, ...created);
  },
  set_time(e, op) {
    const w = find(e, op.id);
    if (!Number.isFinite(op.start) || !Number.isFinite(op.end) || op.end < op.start) throw new EditError("BAD_TIME", "Конец раньше начала");
    if (op.end - op.start > LIM.maxWordDur) throw new EditError("BAD_TIME", "Слово длиннее " + LIM.maxWordDur + " с");
    w.start = +op.start.toFixed(3); w.end = +op.end.toFixed(3); w.manual = true; w.synced = true;
  },
  confirm_sync(e, op) { find(e, op.id).synced = true; },
  /* Правка предложения: слова, оставшиеся без изменений, сохраняют время; новые получают время внутри окна между «якорями». */
  rewrite_range(e, op) {
    const vis = visible(e), ia = vis.indexOf(find(e, op.from_id)), ib = vis.indexOf(find(e, op.to_id));
    if (ia < 0 || ib < 0 || ia > ib) throw new EditError("BAD_RANGE", "Некорректный диапазон слов");
    const old = vis.slice(ia, ib + 1), tokens = tokensOf(op.text);
    const pairs = lcs(old.map(w => nrm(w.text)), tokens.map(nrm)), matchedOld = new Set(pairs.map(p => p[0])), matchedNew = new Map(pairs.map(p => [p[1], p[0]]));
    for (const [i, j] of pairs) old[i].text = tokens[j];
    old.forEach((w, i) => { if (!matchedOld.has(i)) w.deleted = true; });
    const groups = []; let j = 0;
    while (j < tokens.length) {
      if (matchedNew.has(j)) { j++; continue; }
      const from = j; while (j < tokens.length && !matchedNew.has(j)) j++;
      const left = from > 0 && matchedNew.has(from - 1) ? old[matchedNew.get(from - 1)] : null, right = j < tokens.length && matchedNew.has(j) ? old[matchedNew.get(j)] : null;
      groups.push({ from, to: j, left, right });
    }
    const jobs = groups.map(g => {
      const tL = g.left ? g.left.end : old[0].start, tR0 = g.right ? g.right.start : old[old.length - 1].end, tR = Math.max(tR0, tL);
      return { at: g.left ? e.words.indexOf(g.left) + 1 : e.words.indexOf(old[0]), toks: tokens.slice(g.from, g.to), tL, tR, floor: g.left ? g.left.start : old[0].start };
    }).sort((a, b) => b.at - a.at);
    for (const jb of jobs) {
      const times = distribute(jb.toks, jb.tL, jb.tR, jb.floor);
      e.words.splice(jb.at, 0, ...jb.toks.map((t, i) => ({ id: newId(e), text: t, start: times[i].start, end: times[i].end, added: true, synced: false })));
    }
  },
  set_hook(e, op) {
    const h = e.hook;
    if (op.text !== undefined) { const t = clean(op.text); if (t.length > LIM.hook) throw new EditError("HOOK_TOO_LONG", "Хук длиннее " + LIM.hook + " символов"); h.text = t; }
    const num = (k, lo, hi) => { if (op[k] === undefined) return; if (op[k] === null) { h[k] = null; return; } if (!Number.isFinite(op[k]) || op[k] < lo || op[k] > hi) throw new EditError("BAD_HOOK", "hook." + k + ": от " + lo + " до " + hi); h[k] = op[k]; };
    num("size", 24, 120); num("x", 0, 1080); num("y", 0, 1900);
    if (op.enabled !== undefined) h.enabled = bool(op.enabled, "enabled");
  },
  reset_hook(e) { e.hook = Object.assign(e.hook, { text: e.hook.orig_text, size: null, x: null, y: null, enabled: true }); },
  set_framing(e, op) {                                  // масштаб и сдвиг кадра внутри окна с видео (пиксели исходника)
    const f = e.framing || (e.framing = { zoom: 1, pan_x: 0, pan_y: 0 }), num = (k, lo, hi) => { if (op[k] === undefined) return; if (!Number.isFinite(op[k]) || op[k] < lo || op[k] > hi) throw new EditError("BAD_FRAMING", "framing." + k + ": от " + lo + " до " + hi); f[k] = op[k]; };
    num("zoom", 1, 3); num("pan_x", -2000, 2000); num("pan_y", -2000, 2000);
  },
  reset_framing(e) { e.framing = { zoom: 1, pan_x: 0, pan_y: 0 }; },
  set_cta(e, op) {
    if (op.text !== undefined) { if (op.text === null) e.cta.text = null; else { const t = clean(op.text); if (!t || t.length > LIM.cta) throw new EditError("BAD_CTA", "Текст CTA: 1–" + LIM.cta + " символов"); e.cta.text = t; } }
    if (op.enabled !== undefined) e.cta.enabled = bool(op.enabled, "enabled");
    for (const [k, lo, hi] of [["y", 1000, 1900], ["size", 16, 90]]) { if (op[k] === undefined) continue; if (op[k] === null) { e.cta[k] = null; continue; } if (!Number.isFinite(op[k]) || op[k] < lo || op[k] > hi) throw new EditError("BAD_CTA", "cta." + k + ": от " + lo + " до " + hi); e.cta[k] = op[k]; }   // положение и размер призыва настраиваются
  },
  /* Текст в нижней части видео: свой у каждого клипа, до 3 строк; попадает в итоговый рендер (не только в предпросмотр) */
  set_caption(e, op) {
    const c = e.caption || (e.caption = { text: "", enabled: false, size: null, x: null, y: null });
    if (op.text !== undefined) { const raw = op.text === null ? "" : String(op.text), lines = raw.replace(/\r/g, "").split("\n").map(clean).filter(Boolean); if (lines.length > 3) throw new EditError("CAPTION_LINES", "Не более 3 строк"); const t = lines.join("\n"); if (t.length > LIM.caption) throw new EditError("CAPTION_TOO_LONG", "Текст внизу длиннее " + LIM.caption + " символов"); c.text = t; if (t) c.enabled = op.enabled === undefined ? true : c.enabled; }
    const num = (k, lo, hi) => { if (op[k] === undefined) return; if (op[k] === null) { c[k] = null; return; } if (!Number.isFinite(op[k]) || op[k] < lo || op[k] > hi) throw new EditError("BAD_CAPTION", "caption." + k + ": от " + lo + " до " + hi); c[k] = op[k]; };
    num("size", 24, 120); num("x", 0, 1080); num("y", 1000, 1900);
    if (op.enabled !== undefined) c.enabled = bool(op.enabled, "enabled");
  },
  reset_caption(e) { e.caption = { text: "", enabled: false, size: null, x: null, y: null }; },
  set_break(e, op) { find(e, op.id); toggle(e.breaks, op.id, op.on); },
  set_join(e, op) { find(e, op.id); toggle(e.joins, op.id, op.on); },
  set_emphasis(e, op) { find(e, op.id); toggle(e.emphasis, op.id, op.on); }
};
function applyOps(base, ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 200) throw new EditError("BAD_OPS", "Нужен список операций (1–200)");
  const e = clone(base);
  for (const op of ops) { const f = op && OPS[op.op]; if (!f) throw new EditError("BAD_OP", "Неизвестная операция: " + (op && op.op)); f(e, op); }
  checkOrder(e);
  if (visible(e).length > LIM.maxWords || visible(e).length < 1) throw new EditError("BAD_WORDS", "В клипе должно остаться от 1 до " + LIM.maxWords + " слов");
  e.rev = base.rev + 1; return e;
}
const effectiveWords = e => visible(e).map(w => ({ id: w.id, word: w.text, start: w.start, end: w.end, emph: e.emphasis.includes(w.id) }));
/* Хэш только того, что влияет на видео: одинаковые правки → один и тот же рендер (идемпотентность и кэш) */
function editsHash(e, template) {
  const canon = { w: visible(e).map(w => [w.id, w.text, w.start, w.end]), h: [e.hook.text, e.hook.size, e.hook.x, e.hook.y, e.hook.enabled], c: [e.cta.text, e.cta.enabled], b: e.breaks.slice().sort(), j: e.joins.slice().sort(), m: e.emphasis.slice().sort(), f: e.framing ? [e.framing.zoom, e.framing.pan_x, e.framing.pan_y] : [1, 0, 0], t: template || null };
  if (e.caption && e.caption.enabled && e.caption.text) canon.cap = [e.caption.text, e.caption.size ?? null, e.caption.x ?? null, e.caption.y ?? null];   // ключи добавляются только когда используются: хэши прежних клипов не меняются
  if (e.cta && (e.cta.y != null || e.cta.size != null)) canon.cy = [e.cta.y ?? null, e.cta.size ?? null];
  return crypto.createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16);
}
function checks(e, cuts, limits = {}) {
  const words = effectiveWords(e), keep = core.buildKeep(words, cuts), dur = core.finalDuration(keep), out = [];
  const min = limits.min_s || 15, max = limits.max_s || 35;
  if (dur < min) out.push({ code: "SHORT", message: "Ролик короче " + min + " с (" + dur.toFixed(1) + " с)" });
  if (dur > max) out.push({ code: "LONG", message: "Ролик длиннее " + max + " с (" + dur.toFixed(1) + " с)" });
  const unsynced = visible(e).filter(w => w.synced === false).length; if (unsynced) out.push({ code: "UNSYNCED", message: "Слов без подтверждённого времени: " + unsynced, count: unsynced });
  if (e.hook.enabled && PROMISE.test(e.hook.text)) out.push({ code: "PROMISE", message: "Хук похож на обещание прибыли — так нельзя публиковать" });
  if (e.hook.enabled && !e.hook.text) out.push({ code: "NO_HOOK", message: "Хук пуст" });
  return { final_s: +dur.toFixed(2), words: words.length, warnings: out, can_render: dur > 0 && dur <= 60 };
}
module.exports = { EditError, initEdits, applyOps, effectiveWords, editsHash, checks, visible, LIM, clean };
