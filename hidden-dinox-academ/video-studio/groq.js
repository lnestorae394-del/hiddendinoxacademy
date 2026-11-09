"use strict";
/* Распознавание речи: Groq Whisper (verbose_json, слова + сегменты). Используются только документированные параметры:
   file, model, language, prompt (≤224 токена), response_format, temperature, timestamp_granularities[]. В Groq уходит ТОЛЬКО звук. */
const fs = require("fs"), path = require("path");
const { StudioError } = require("./errors");
const SINGLE_MAX_SEC = 5200, CHUNK_SEC = 1800, OVERLAP_SEC = 3.0;
const baseUrl = env => (env.GROQ_BASE_URL || "https://api.groq.com/openai/v1");
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
async function extractAudio(src, dst, { ffmpeg, run, cancel }) {
  const r = await run([ffmpeg, "-y", "-v", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-af", "dynaudnorm=f=250:g=15", "-map_metadata", "-1", "-c:a", "libopus", "-b:a", "32k", dst], { cancel });
  if (r.code) throw new StudioError("AUDIO_EXTRACT_FAILED", "Не удалось извлечь звук: " + r.stderr.slice(-200), false);
  return dst;
}
function planChunks(duration) {
  if (duration <= SINGLE_MAX_SEC) return [[0, duration]];
  const out = []; let t = 0;
  while (t < duration) { const end = Math.min(duration, t + CHUNK_SEC + OVERLAP_SEC); out.push([t, end - t]); if (end >= duration) break; t += CHUNK_SEC; }
  return out;
}
async function transcribeFile({ key, file, model, prompt, language = "ru", env = process.env, sleep = sleepMs }) {
  const buf = fs.readFileSync(file);
  for (let attempt = 0; attempt < 3; attempt++) {
    const fd = new FormData(); fd.append("model", model); fd.append("response_format", "verbose_json"); fd.append("language", language); fd.append("temperature", "0");
    fd.append("timestamp_granularities[]", "word"); fd.append("timestamp_granularities[]", "segment"); if (prompt) fd.append("prompt", prompt); fd.append("file", new Blob([buf], { type: "audio/ogg" }), "audio.ogg");
    let res;
    try { res = await fetch(baseUrl(env) + "/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + key, "User-Agent": "hd-video-studio/2.0" }, body: fd, signal: AbortSignal.timeout(900000) }); }
    catch (e) { if (attempt < 2) { await sleep(5000); continue; } throw new StudioError("GROQ_NETWORK", "Нет соединения с Groq", true); }
    if (res.ok) return res.json();
    let msg = ""; try { msg = ((await res.json()).error || {}).message || ""; } catch (e) { /* тело не JSON */ }
    if (res.status === 401 || res.status === 403) throw new StudioError("GROQ_AUTH", "Groq не принял ключ", false);
    if (res.status === 400 || res.status === 413) throw new StudioError("GROQ_BAD_REQUEST", "Groq отклонил запрос: " + msg.slice(0, 150), false);
    if (res.status === 429 || res.status >= 500) { if (attempt < 2) { await sleep(Math.min(Number(res.headers.get("retry-after") || 10), 60) * 1000); continue; } throw new StudioError("GROQ_UNAVAILABLE", "Groq временно недоступен или лимит (" + res.status + ")", true); }
    throw new StudioError("GROQ_ERROR", "Groq вернул ошибку " + res.status, false);
  }
}
/* results: [[offset, json]] → единый ответ. Перекрытие кусков: слова/сегменты следующего куска, начавшиеся раньше конца принятых, отбрасываются. */
function merge(results) {
  const words = [], segs = [], texts = []; let lastW = -1, lastS = -1;
  for (const [off, r] of results) {
    for (const w of r.words || []) { const s = w.start + off, e = w.end + off; if (s + 1e-6 >= lastW - 0.05 && (!words.length || s >= words[words.length - 1].start)) { words.push({ word: w.word, start: +s.toFixed(3), end: +e.toFixed(3) }); lastW = e; } }
    for (const sg of r.segments || []) { const s = sg.start + off, e = sg.end + off; if (e > lastS + 0.2 && s >= lastS - 0.5) { segs.push(Object.assign({}, sg, { start: +s.toFixed(3), end: +e.toFixed(3), id: segs.length })); lastS = e; texts.push(String(sg.text || "").trim()); } }
  }
  return { language: results.length ? results[0][1].language : null, text: texts.join(" "), words, segments: segs };
}
async function transcribe({ key, audio, duration, model, prompt, language = "ru", ffmpeg, run, workdir, env, onChunk, sleep, cancel }) {
  const plan = planChunks(duration), results = [];
  for (let i = 0; i < plan.length; i++) {
    const [start, length] = plan[i]; let part = audio;
    if (plan.length > 1) { part = path.join(workdir, "chunk_" + String(i).padStart(3, "0") + ".ogg"); const r = await run([ffmpeg, "-y", "-v", "error", "-ss", start.toFixed(3), "-t", length.toFixed(3), "-i", audio, "-c", "copy", part], { cancel }); if (r.code) throw new StudioError("AUDIO_CHUNK_FAILED", "Не удалось нарезать звук: " + r.stderr.slice(-150), false); }
    results.push([start, await transcribeFile({ key, file: part, model, prompt, language, env, sleep })]); if (onChunk) onChunk(i + 1, plan.length);
  }
  const out = merge(results); if (!out.words.length) throw new StudioError("NO_SPEECH", "В записи не распознано ни одного слова", false); return out;
}
module.exports = { extractAudio, planChunks, transcribeFile, merge, transcribe };
