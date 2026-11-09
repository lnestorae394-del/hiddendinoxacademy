#!/usr/bin/env node
"use strict";
/* Реальная проверка Claude API для AI Mentor (без имитаций). Запуск на staging, где задан ANTHROPIC_API_KEY:
     node scripts/mentor-smoke.js
   Проверяет: текстовый запрос (AI_MENTOR_MODEL, effort), запрос с изображением (AI_MENTOR_VISION_MODEL), фактические токены
   и стоимость по ценам модуля бюджета, ответ API на неверный ключ. Ключ не печатается. Стоимость прогона — порядка $0.02. */
const fs = require("fs"), path = require("path");
const { cfgFromEnv } = require("../academy/mentor");
const { DEFAULTS, costOf } = require("../academy/ai-budget");
const URL = "https://api.anthropic.com/v1/messages", VERSION = "2023-06-01";
const c = cfgFromEnv(process.env), results = [];
const ok = (name, pass, info = "") => { results.push(pass); console.log(`${pass ? "✔" : "✘"} ${name}${info ? " — " + info : ""}`); };
async function call(key, body) {
  const r = await fetch(URL, { method: "POST", headers: { "x-api-key": key, "anthropic-version": VERSION, "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
const text = j => ((j && j.content) || []).filter(x => x.type === "text").map(x => x.text).join("\n").trim();
const price = m => DEFAULTS.prices[m];
(async () => {
  if (!c.key) { console.error("ANTHROPIC_API_KEY не задан — проверка невозможна. Задайте его в переменных окружения staging (не в чате и не в Git)."); process.exit(2); }
  console.log(`Модель текста: ${c.model} (effort ${c.effort}, max_tokens ${c.max_tokens}); модель скриншотов: ${c.vision_model} (effort ${c.vision_effort})`);
  try {
    const t = await call(c.key, { model: c.model, max_tokens: c.max_tokens, output_config: { effort: c.effort }, system: "Ты AI-наставник Hidden Dinox Academy. Отвечай кратко по-русски.",
      messages: [{ role: "user", content: "Объясни простыми словами, что такое слом структуры (BOS) в Smart Money Concepts." }] });
    const tc = t.j && t.j.usage ? costOf(t.j.usage, price(c.model) || DEFAULTS.prices["claude-haiku-5-5"]) : null;
    ok("текстовый запрос: HTTP 200 и ответ", t.status === 200 && text(t.j).length > 20, `HTTP ${t.status}; ${text(t.j).slice(0, 120).replace(/\n/g, " ")}`);
    ok("usage: фактические токены входа и выхода", !!(t.j && t.j.usage && t.j.usage.input_tokens > 0 && t.j.usage.output_tokens > 0), JSON.stringify(t.j && t.j.usage));
    ok("стоимость текстового запроса по ценам бюджета", tc !== null && tc > 0 && tc < 0.01, tc === null ? "нет usage" : `$${tc}`);
    const img = fs.readFileSync(path.join(__dirname, "../tests/fixtures/images/chart.png")).toString("base64");
    const v = await call(c.key, { model: c.vision_model, max_tokens: c.vision_max_tokens, output_config: { effort: c.vision_effort },
      system: "Ты AI-наставник Hidden Dinox Academy. Опиши только то, что видно на графике, по-русски, кратко. Не угадывай нечитаемые значения.",
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: img } }, { type: "text", text: "Что видно на этом графике? Какой актив и таймфрейм подписаны?" }] }] });
    const vc = v.j && v.j.usage ? costOf(v.j.usage, price(c.vision_model) || DEFAULTS.prices["claude-sonnet-5-5"]) : null;
    ok("запрос с изображением: HTTP 200 и ответ", v.status === 200 && text(v.j).length > 20, `HTTP ${v.status}; ${text(v.j).slice(0, 160).replace(/\n/g, " ")}`);
    ok("изображение учтено во входных токенах (больше 300)", !!(v.j && v.j.usage && v.j.usage.input_tokens > 300), JSON.stringify(v.j && v.j.usage));
    ok("стоимость разбора скриншота по ценам бюджета", vc !== null && vc > 0 && vc < 0.05, vc === null ? "нет usage" : `$${vc}`);
    ok("подпись на тестовом графике распознана (EUR/USD, OTC, M1)", /EUR\s*\/?\s*USD/i.test(text(v.j)) && /OTC/i.test(text(v.j)), "ожидание; не влияет на работу, показывает качество распознавания");
    const bad = await call("sk-ant-invalid-key-for-smoke-test", { model: c.model, max_tokens: 20, messages: [{ role: "user", content: "ping" }] });
    ok("неверный ключ: API отвечает 401 (ошибка обрабатывается, ключ не раскрывается)", bad.status === 401, `HTTP ${bad.status}`);
    for (const m of [c.model, c.vision_model]) if (!price(m)) console.log(`! Для модели ${m} нет цены по умолчанию — задайте её в админке «ИИ-помощник», иначе запросы будут отклонены.`);
  } catch (e) { ok("соединение с api.anthropic.com", false, String(e && (e.cause && e.cause.code || e.message) || e)); }
  console.log(`\nИтог: ${results.filter(Boolean).length}/${results.length}`); process.exit(results.every(Boolean) ? 0 : 1);
})();
