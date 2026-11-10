"use strict";
/* Единый источник для задания сборки: штамп шаблона, лимиты клипа и состав задания. Им пользуются и ручная сборка (api.js), и автосборка после анализа (pipeline.js) —
   одна логика, один хэш: готовый файл не пересобирается, если ничего не изменилось. */
const crypto = require("crypto"), E = require("./edits"), { COLL } = require("./constants");
const sha = o => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 12);
const clipLimits = st => ({ min_s: st.clips.min_s, max_s: st.clips.max_s }), templateStamp = st => sha(st.template);
function buildPayload({ kind, edits, clip, st, hash }) {
  return { kind, edits_rev: edits.rev, hash, clip_start: clip.start, clip_end: clip.end, words: E.effectiveWords(edits), hook: { text: edits.hook.text, size: edits.hook.size, x: edits.hook.x, y: edits.hook.y, enabled: edits.hook.enabled }, cta: edits.cta, caption: edits.caption || null,
    breaks: edits.breaks, joins: edits.joins, emphasis: edits.emphasis, framing: edits.framing || null, template: st.template };
}
/* Правки клипа создаются при первом обращении (клип создаёт анализ, правки — по требованию) */
async function ensureEditsDoc(db, clip, now) {
  const ref = db.collection(COLL.edits).doc(clip.id), s = await ref.get(); if (s.exists) return s.data();
  const e = E.initEdits(clip); e.updated_at = now(); await ref.set(e); return e;
}
async function planRender({ db, now, clip, st, kind = "render" }) {
  const edits = await ensureEditsDoc(db, clip, now), checks = E.checks(edits, st.template.cuts, clipLimits(st)), hash = E.editsHash(edits, templateStamp(st));
  return { edits, checks, hash, key: clip.id + "_" + hash, payload: buildPayload({ kind, edits, clip, st, hash }) };
}
module.exports = { sha, clipLimits, templateStamp, buildPayload, ensureEditsDoc, planRender };
