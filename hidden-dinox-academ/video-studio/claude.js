"use strict";
/* Claude (Anthropic Messages API, как в academy/mentor.js: fetch, версия 2023-06-01, output_config.effort). В Claude уходит ТОЛЬКО текст расшифровки. */
const { StudioError } = require("./errors");
const moments = require("./moments");
const MAX_TOKENS = 4500, API_VERSION = "2023-06-01", sleepMs = ms => new Promise(r => setTimeout(r, ms));
const url = env => (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages";
async function call({ key, model, user, system = moments.SYSTEM, maxTokens = MAX_TOKENS, env = process.env, sleep = sleepMs, timeoutMs = 180000 }) {
  const body = JSON.stringify({ model, max_tokens: maxTokens, output_config: { effort: "medium" }, system, messages: [{ role: "user", content: user }] });
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try { res = await fetch(url(env), { method: "POST", headers: { "x-api-key": key, "anthropic-version": API_VERSION, "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { if (attempt < 2) { await sleep(5000); continue; } throw new StudioError("CLAUDE_NETWORK", "Нет соединения с Claude", true); }
    if (res.ok) return res.json();
    if (res.status === 401 || res.status === 403) throw new StudioError("CLAUDE_AUTH", "Claude не принял ключ", false);
    if (res.status === 400) throw new StudioError("CLAUDE_BAD_REQUEST", "Claude отклонил запрос", false);
    if ([429, 529, 500, 502, 503, 504].includes(res.status)) { if (attempt < 2) { await sleep(Math.min(Number(res.headers.get("retry-after") || 8), 45) * 1000); continue; } throw new StudioError("CLAUDE_UNAVAILABLE", "Claude перегружен или лимит (" + res.status + ")", true); }
    throw new StudioError("CLAUDE_ERROR", "Claude вернул ошибку " + res.status, false);
  }
}
function parse(j) { const raw = ((j && j.content) || []).filter(b => b.type === "text").map(b => b.text || "").join(""), m = /\{[\s\S]*\}/.exec(raw); try { return m ? JSON.parse(m[0]) : {}; } catch (e) { return {}; } }
const cost = (usage, model, prices) => { const [pin, pout] = prices.claude_per_mtok[model]; return (((usage || {}).input_tokens || 0) * pin + ((usage || {}).output_tokens || 0) * pout) / 1e6; };
const HOOK_SYSTEM = "Ты редактор коротких вертикальных видео на русском языке. По тексту фрагмента эфира предложи до 3 сильных хуков (текст на экране в первые секунды). Хук: 3–9 слов, до 64 символов, основан ТОЛЬКО на сказанном во фрагменте, без новых фактов, цифр и обещаний, без гарантий прибыли. Для каждого дай source_quote — дословную цитату (до 100 символов) из фрагмента, на которой основан хук. Верни ТОЛЬКО JSON: {\"hooks\":[{\"text\":\"...\",\"source_quote\":\"...\"}]}";
/* Предложить хуки для клипа; предложения, не прошедшие проверку кода (не связаны с текстом, цитата не найдена, обещания), отбрасываются */
async function suggestHooks({ key, model, clipText, env, sleep }) {
  const j = await call({ key, model, system: HOOK_SYSTEM, user: clipText, maxTokens: 600, env, sleep }), resp = parse(j), out = [], nt = moments.norm(clipText);
  for (const h of Array.isArray(resp.hooks) ? resp.hooks : []) { const t = String((h && h.text) || "").trim(), q = moments.norm(String((h && h.source_quote) || ""));
    if (!moments.checkHook(t, clipText) && q && nt.includes(q) && !out.includes(t)) out.push(t); }
  return { hooks: out.slice(0, 3), usage: j.usage || {} };
}
module.exports = { call, parse, cost, suggestHooks, MAX_TOKENS };
