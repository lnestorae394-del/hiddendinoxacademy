"use strict";
/* Бюджет Video Studio. Полностью отдельный от AI-ментора: свои коллекции (videoStudioUsage / videoStudioSettings),
   свои лимиты. Лимиты по умолчанию — нули, поэтому без ручной настройки платная обработка НЕ стартует.
   Резерв берётся транзакцией ДО запуска (жёсткий отказ), воркер потом списывает факт и освобождает остаток. */
const { COLL } = require("./constants");
const monthKey = ms => new Date(ms).toISOString().slice(0, 7);
const SYSTEM_CHARS = 3900;            // длина системного промпта v4 + префикс запроса (измерено: 3320 + запас)
const CHARS_PER_MIN = 1150;           // ≈ 1000 симв. расшифровки в минуту + служебные префиксы «[номер | длительность]»
const MAX_OUT_TOKENS = 4500;          // потолок ответа Claude в v4
class BudgetError extends Error { constructor(code, message, extra) { super(message); this.status = 402; this.code = code; this.extra = extra; } }

function configured(limits) { return limits && limits.monthly_usd > 0 && limits.per_job_usd > 0 && limits.max_duration_min > 0 && limits.max_upload_gb > 0; }
function estimateAnalyze({ durationSec, model, whisper, prices }) {
  const hours = durationSec / 3600, gp = prices.groq_per_hour[whisper], cp = prices.claude_per_mtok[model];
  if (gp === undefined) throw new BudgetError("UNKNOWN_MODEL", "Нет цены для модели распознавания: " + whisper);
  if (!cp) throw new BudgetError("UNKNOWN_MODEL", "Нет цены для модели Claude: " + model);
  const tokensIn = Math.round((SYSTEM_CHARS + (durationSec / 60) * CHARS_PER_MIN) / 3 * 1.3);
  const groq = hours * gp, claude = (tokensIn * cp[0] + MAX_OUT_TOKENS * cp[1]) / 1e6, compute = hours * 0.5 * prices.compute_per_hour;
  const r = x => +x.toFixed(4);
  return { groq_usd: r(groq), claude_usd: r(claude), compute_usd: r(compute), total_usd: r((groq + claude + compute) * 1.2), tokens_in: tokensIn, tokens_out_max: MAX_OUT_TOKENS, safety: 1.2, prices_verified: prices.verified === true };
}
/* Проверка и резерв одной транзакцией. jobId делает операцию идемпотентной (повторный вызов не резервирует второй раз). */
async function reserve(db, now, { jobId, estimate, limits }) {
  if (!configured(limits)) throw new BudgetError("BUDGET_NOT_CONFIGURED", "Лимиты Video Studio не заданы (нулевые). Администратор должен задать их вручную.");
  if (estimate.total_usd > limits.per_job_usd) throw new BudgetError("BUDGET_PER_JOB", "Оценка $" + estimate.total_usd.toFixed(3) + " выше лимита на задачу $" + limits.per_job_usd, { estimate: estimate.total_usd, limit: limits.per_job_usd });
  const ref = db.collection(COLL.usage).doc(monthKey(now()));
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref), u = snap.exists ? snap.data() : { month: monthKey(now()), spent_usd: 0, reserved_usd: 0, jobs: {} };
    if (u.jobs && u.jobs[jobId]) return { already: true, reserved_usd: u.jobs[jobId].reserved_usd };
    if (u.spent_usd + u.reserved_usd + estimate.total_usd > limits.monthly_usd + 1e-9) throw new BudgetError("BUDGET_MONTH", "Месячный лимит $" + limits.monthly_usd + " будет превышен (потрачено $" + u.spent_usd.toFixed(3) + ", в резерве $" + u.reserved_usd.toFixed(3) + ")", { spent: u.spent_usd, reserved: u.reserved_usd });
    u.reserved_usd = +(u.reserved_usd + estimate.total_usd).toFixed(6); u.jobs = Object.assign({}, u.jobs, { [jobId]: { reserved_usd: estimate.total_usd, at: now() } }); u.updated_at = now();
    tx.set(ref, u); return { already: false, reserved_usd: estimate.total_usd };
  });
}
/* Освободить резерв (задача отменена до старта). Списание факта делает воркер. */
async function release(db, now, jobId, reservedMonth) {
  const ref = db.collection(COLL.usage).doc(reservedMonth || monthKey(now()));
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref); if (!snap.exists) return false; const u = snap.data(); const j = u.jobs && u.jobs[jobId]; if (!j) return false;
    u.reserved_usd = Math.max(0, +(u.reserved_usd - j.reserved_usd).toFixed(6)); const jobs = Object.assign({}, u.jobs); delete jobs[jobId]; u.jobs = jobs; u.updated_at = now(); tx.set(ref, u); return true;
  });
}
/* Списать фактический расход задания и освободить его резерв (одна транзакция по документу месяца) */
async function settle(db, now, job, actualUsd) {
  const ref = db.collection(COLL.usage).doc(monthKey(job.created_at || now()));
  return db.runTransaction(async tx => {
    const s = await tx.get(ref); if (!s.exists) return false; const u = s.data(), j = (u.jobs || {})[job.id]; if (!j) return false;
    const jobs = Object.assign({}, u.jobs); delete jobs[job.id];
    tx.set(ref, Object.assign({}, u, { jobs, reserved_usd: Math.max(0, +(u.reserved_usd - j.reserved_usd).toFixed(6)), spent_usd: +((u.spent_usd || 0) + actualUsd).toFixed(6), updated_at: now() })); return true;
  });
}
/* Небольшой расход вне заданий (подсказка хуков): проверка месячного лимита и сразу списание */
async function spendDirect(db, now, limits, usd) {
  const ref = db.collection(COLL.usage).doc(monthKey(now()));
  return db.runTransaction(async tx => {
    const s = await tx.get(ref), u = s.exists ? s.data() : { month: monthKey(now()), spent_usd: 0, reserved_usd: 0, jobs: {} };
    if (u.spent_usd + u.reserved_usd + usd > limits.monthly_usd + 1e-9) throw new BudgetError("BUDGET_MONTH", "Месячный лимит $" + limits.monthly_usd + " будет превышен", {});
    tx.set(ref, Object.assign({}, u, { spent_usd: +(u.spent_usd + usd).toFixed(6), updated_at: now() })); return true;
  });
}
async function usageOf(db, now) { const d = await db.collection(COLL.usage).doc(monthKey(now())).get(); return d.exists ? d.data() : { month: monthKey(now()), spent_usd: 0, reserved_usd: 0, jobs: {} }; }
module.exports = { BudgetError, configured, estimateAnalyze, reserve, release, settle, spendDirect, usageOf, monthKey, MAX_OUT_TOKENS };
