"use strict";
/* Поддельные внешние сервисы для тестов: Groq, Claude и Telegram Bot API (локальные HTTP-серверы). Они проверяют ФОРМУ запросов, но НЕ заменяют реальные сервисы. */
const http = require("http"), crypto = require("crypto");
const readBody = req => new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
function parseMultipart(buf, ctype) {
  const m = /boundary=(.+)$/.exec(ctype || ""); if (!m) return []; const b = Buffer.from("--" + m[1].trim()), parts = []; let i = buf.indexOf(b);
  while (i >= 0) { const s = i + b.length; if (buf.slice(s, s + 2).toString() === "--") break; const h = buf.indexOf("\r\n\r\n", s), j = buf.indexOf(b, h); if (h < 0 || j < 0) break;
    const head = buf.slice(s + 2, h).toString("utf8"), data = buf.slice(h + 4, j - 2), nm = /name="([^"]*)"/.exec(head), fn = /filename="([^"]*)"/.exec(head); parts.push({ name: nm && nm[1], filename: fn && fn[1], data }); i = j; }
  return parts;
}
const listen = h => new Promise(res => { const s = http.createServer(h); s.listen(0, "127.0.0.1", () => res({ server: s, url: "http://127.0.0.1:" + s.address().port })); });
const send = (res, code, obj, headers = {}) => { res.writeHead(code, Object.assign({ "Content-Type": "application/json" }, headers)); res.end(JSON.stringify(obj)); };
const POOL = ["Главное правило этой системы — не входить в сделку без подтверждения уровня.", "Смотрите, цена подходит к уровню поддержки и даёт отскок.", "Многие теряют депозит, потому что увеличивают ставку после минуса.", "Я всегда жду закрытия свечи, а потом принимаю решение.", "Экспирация пять минут даёт время для отработки сигнала.", "Если нет подтверждения, я просто пропускаю сделку и жду следующий вход.", "Это самая частая ошибка, и она стоит дороже любого плохого сигнала.", "Запомните: дисциплина важнее красивого входа.", "Это важно понимать до того, как вы откроете любую сделку.", "Давайте разберём эту ситуацию на графике подробнее."];
function transcript(duration, seed = 1) {
  let s = seed * 9301 + 49297; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280), words = [], segs = []; let t = 1, i = 0;
  while (t < duration - 8) { const toks = POOL[(i * 3 + seed) % POOL.length].split(" "), ws = [];
    for (const tk of toks) { const d = 0.26 + rnd() * 0.2, w = tk.replace(/[.,!?:—]/g, "") || tk; if (w === "—") continue; ws.push({ word: w, start: +t.toFixed(3), end: +(t + d).toFixed(3) }); t += d + 0.02 + rnd() * 0.1; }
    words.push(...ws); segs.push({ id: segs.length, start: ws[0].start, end: ws[ws.length - 1].end, text: " " + toks.filter(x => x !== "—").join(" "), avg_logprob: -0.2, compression_ratio: 1.4, no_speech_prob: 0.01 }); t += [0.3, 0.5, 0.9, 1.4][Math.floor(rnd() * 4)]; i++; }
  return { language: "russian", text: segs.map(x => x.text.trim()).join(" "), words, segments: segs };
}
async function groqServer(duration) {
  const st = { calls: 0, fields: [], fail: 0, duration }, { server, url } = await listen(async (req, res) => {
    const body = await readBody(req); st.calls++; st.auth = req.headers.authorization; st.path = req.url; st.fields = parseMultipart(body, req.headers["content-type"]).map(p => p.name);
    if (st.fail > 0) { st.fail--; return send(res, 503, {}, { "retry-after": "0" }); } send(res, 200, transcript(st.duration));
  });
  return Object.assign(st, { url, close: () => server.close() });
}
async function claudeServer() {
  const st = { calls: 0 }, { server, url } = await listen(async (req, res) => {
    const b = JSON.parse((await readBody(req)).toString()); st.calls++; st.last = b; const user = b.messages[0].content;
    if (b.system && b.system.startsWith("Ты редактор коротких")) {                                  // подсказка хуков
      const words = user.split(/\s+/).filter(Boolean); const q = words.slice(0, 6).join(" ");
      return send(res, 200, { content: [{ type: "text", text: JSON.stringify({ hooks: [{ text: words.slice(0, 4).join(" "), source_quote: q }, { text: "Секрет миллионеров", source_quote: "выдуманная цитата" }, { text: "Гарантированная прибыль всегда", source_quote: q }] }) }], usage: { input_tokens: 400, output_tokens: 120 } });
    }
    const units = [...user.matchAll(/\[(\d+) \| ([\d.]+) с\] (.*)/g)].map(m => ({ id: +m[1], d: +m[2], text: m[3] })), n = units.length;
    const span = (i0, target) => { const ids = []; let tot = 0; for (const u of units.slice(i0)) { ids.push(u.id); tot += u.d; if (tot >= target) break; } return ids; }, moments = [];
    for (const [f, target, score] of [[0.12, 25, 0.92], [0.45, 24, 0.85]]) { const ids = span(Math.max(1, Math.floor(n * f)), target), tk = ids.map(i => units[i].text).join(" ").split(" ");
      moments.push({ unit_ids: ids, score, category: "explanation", hook: tk.slice(0, 5).join(" ").replace(/[.,]+$/, ""), hook_source_quote: tk.slice(0, 8).join(" "), title: "Тест", reason: "Ответ симуляции.", quote_check: tk.slice(-6).join(" "), subtitle_fixes: [] }); }
    const bad = span(Math.floor(n * 0.75), 24), tk = bad.map(i => units[i].text).join(" ").split(" ");
    moments.push({ unit_ids: bad, score: 0.9, category: "quote", hook: "Секрет миллионеров раскрыт", hook_source_quote: "гарантированная прибыль", title: "x", reason: "x", quote_check: tk.slice(0, 5).join(" ") });
    send(res, 200, { content: [{ type: "text", text: JSON.stringify({ no_good_moments: false, moments }) }], usage: { input_tokens: 6200, output_tokens: 900 } });
  });
  return Object.assign(st, { url, close: () => server.close() });
}
async function telegramServer(token) {
  const st = { sent: [], messages: [], calls: [], fail: {}, n: 100, webhook: null, pending: 0, lastError: null }, { server, url } = await listen(async (req, res) => {
    const body = await readBody(req), m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url); if (!m || m[1] !== token) return send(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
    const method = m[2], ct = req.headers["content-type"] || "", parts = ct.startsWith("multipart/") ? parseMultipart(body, ct) : null, params = {};
    if (parts) for (const p of parts) { if (!p.filename) params[p.name] = p.data.toString("utf8"); } else if (body.length) Object.assign(params, JSON.parse(body.toString()));
    st.calls.push(method); const f = (st.fail[method] || []).shift(); if (f) return send(res, f.status, f.body);
    if (method === "getMe") return send(res, 200, { ok: true, result: { id: 424242, is_bot: true, first_name: "HD Test", username: "hd_test_bot" } });
    if (method === "setWebhook") { st.webhook = { url: params.url, secret_token: params.secret_token, allowed_updates: params.allowed_updates, drop_pending_updates: !!params.drop_pending_updates, max_connections: params.max_connections }; if (params.drop_pending_updates) st.pending = 0; return send(res, 200, { ok: true, result: true, description: "Webhook was set" }); }
    if (method === "getWebhookInfo") return send(res, 200, { ok: true, result: { url: st.webhook ? st.webhook.url : "", has_custom_certificate: false, pending_update_count: st.pending || 0, last_error_date: st.lastError ? st.lastError.date : undefined, last_error_message: st.lastError ? st.lastError.message : undefined, max_connections: st.webhook ? st.webhook.max_connections : undefined, allowed_updates: st.webhook ? st.webhook.allowed_updates : undefined } });
    if (method === "sendChatAction") return send(res, 200, { ok: true, result: true });
    if (method === "sendMessage") { const id = ++st.n; st.messages.push({ id, chat_id: params.chat_id, text: params.text }); return send(res, 200, { ok: true, result: { message_id: id, chat: { id: Number(params.chat_id) }, text: params.text } }); }
    if (method === "sendVideo") {
      const id = ++st.n, file = parts && parts.find(p => p.name === "video" && p.filename), rec = { id, chat_id: params.chat_id, caption: params.caption, supports_streaming: params.supports_streaming, width: params.width, height: params.height, duration: params.duration, by_file_id: !file, file_id_in: file ? null : params.video, bytes: file ? file.data.length : 0, sha: file ? crypto.createHash("sha256").update(file.data).digest("hex") : null, data: file ? file.data : null };
      st.sent.push(rec); return send(res, 200, { ok: true, result: { message_id: id, chat: { id: Number(params.chat_id) }, video: { file_id: "BAACAgIAAxkBAAI" + id, file_unique_id: "u" + id, file_size: rec.bytes || 1234 } } });
    }
    send(res, 404, { ok: false, error_code: 404, description: "Not Found" });
  });
  return Object.assign(st, { url, close: () => server.close() });
}
module.exports = { groqServer, claudeServer, telegramServer, parseMultipart, transcript };
