"use strict";
/* Причины отклонения заявок на вывод: администратор пишет по-русски, пользователь видит на своём языке.
   1) Стандартные причины — готовые переводы (без сервисов перевода).
   2) Произвольная причина — перевод ОДИН раз при сохранении через DeepL (если задан DEEPL_API_KEY), с таймаутом.
   Если перевод получить не удалось — переводы не выдумываются: хранится только русский оригинал,
   пользователю на EN/UA показывается нейтральная фраза на его языке. */
const REJECT_REASONS = {
  wrong_trader_id: { ru: "Заявка отклонена: указан неверный Trader ID. Проверьте данные и отправьте новую заявку.",
    en: "Request rejected: an incorrect Trader ID was provided. Please check your details and submit a new request.",
    ua: "Заявку відхилено: вказано неправильний Trader ID. Перевірте дані та надішліть нову заявку." },
  trader_not_verified: { ru: "Заявка отклонена: Trader ID получателя не подтверждён. Подтвердите Trader ID и отправьте новую заявку.",
    en: "Request rejected: the recipient Trader ID is not confirmed. Please confirm your Trader ID and submit a new request.",
    ua: "Заявку відхилено: Trader ID отримувача не підтверджено. Підтвердьте Trader ID і надішліть нову заявку." },
  duplicate_request: { ru: "Заявка отклонена: повторная заявка. Средства по ней возвращены на баланс.",
    en: "Request rejected: duplicate request. The funds have been returned to your balance.",
    ua: "Заявку відхилено: повторна заявка. Кошти повернено на баланс." },
  suspicious_activity: { ru: "Заявка отклонена: требуется дополнительная проверка приглашений. Свяжитесь с поддержкой.",
    en: "Request rejected: additional review of your referrals is required. Please contact support.",
    ua: "Заявку відхилено: потрібна додаткова перевірка запрошень. Зверніться до підтримки." },
  program_rules: { ru: "Заявка отклонена: нарушены правила партнёрской программы. Свяжитесь с поддержкой.",
    en: "Request rejected: the partner program rules were not met. Please contact support.",
    ua: "Заявку відхилено: порушено правила партнерської програми. Зверніться до підтримки." }
};

async function deeplTranslate(text, target, env, fetchImpl) {
  const key = env.DEEPL_API_KEY; if (!key) return null;
  const url = env.DEEPL_API_URL || (key.endsWith(":fx") ? "https://api-free.deepl.com/v2/translate" : "https://api.deepl.com/v2/translate");
  const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await (fetchImpl || fetch)(url, { method: "POST", signal: ctrl.signal, headers: { "Authorization": "DeepL-Auth-Key " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: [text], source_lang: "RU", target_lang: target }) });
    if (!r.ok) return null;
    const j = await r.json(); const t = j && j.translations && j.translations[0] && j.translations[0].text;
    return typeof t === "string" && t.trim() ? t.trim().slice(0, 1000) : null;
  } catch (e) { return null; } finally { clearTimeout(tm); }
}

/* Подготовка причины к сохранению: { code, ru, en, ua, source } — en/ua null, если перевода нет */
async function buildRejectReason({ code, text, en: manEn, ua: manUa }, env = process.env, fetchImpl) {
  if (code && REJECT_REASONS[code]) return { code, ...REJECT_REASONS[code], source: "dictionary" };
  const ru = String(text || "").trim().slice(0, 1000);
  if (!ru) return null;
  // Переводы, введённые администратором вручную, — приоритетнее автоперевода
  const me = String(manEn || "").trim().slice(0, 1000) || null, mu = String(manUa || "").trim().slice(0, 1000) || null;
  if (me && mu) return { code: "custom", ru, en: me, ua: mu, source: "manual" };
  const [en, ua] = await Promise.all([me ? me : deeplTranslate(ru, "EN-GB", env, fetchImpl), mu ? mu : deeplTranslate(ru, "UK", env, fetchImpl)]);
  return { code: "custom", ru, en, ua, source: me || mu ? "manual" : (en || ua ? "deepl" : "unavailable") };
}

module.exports = { REJECT_REASONS, buildRejectReason };
