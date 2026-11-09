"use strict";
/* HIDDEN DINOX ACADEMY — правила учёта депозитов (общие для postback, тестового маршрута и скрипта
   повторной обработки). Работают с копией referrals/{traderId}.academy.

   ОСНОВНОЙ ИДЕНТИФИКАТОР — trader_id. Запись referrals/{traderId} хранит регистрацию и депозиты этого ID.
   Владелец ID в академии — пользователь из trader_bindings/{traderId} (привязка через сайт).
   click_id — дополнительное подтверждение: если он выдан академией (коллекция clicks), известен uid
   пользователя, нажавшего кнопку POCKET; это «сильная» связь и она имеет приоритет.

   Депозит ЗАСЧИТЫВАЕТСЯ только если одновременно:
   1) секрет верный и событие новое (проверяет postback.js);
   2) для trader_id есть проверенная регистрация (registration postback);
   3) нет противоречия владельцев: uid из click_id (если известен) совпадает с uid регистрации и с привязкой;
   4) у пользователя из click_id не привязан ДРУГОЙ Trader ID;
   5) валюта известна (код из 3 букв), сумма > 0.
   Нарушение 3 — отказ. Нарушение 4 — отказ для доступа, событие хранится «в ожидании».
   Нет регистрации (2) или валюты (5) — «в ожидании», не учитывается, пока условие не выполнится. */

const CURRENCY_RE = /^[A-Z]{3}$/;
const clone = v => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

/* Противоречие ВЛАДЕЛЬЦЕВ Trader ID. Возвращает код отказа или null.
   depUid   — uid из click_id события (null, если click_id не выдан академией);
   regOwner — владелец регистрации: reg.uid или uid из click_id регистрации, если тот выдан академией.
   Несовпадение click_id, которые НЕ выданы академией, конфликтом НЕ считается: такой click_id —
   атрибуция Pocket Partners и ничего не говорит о владельце (поиск — по trader_id). */
function ownershipProblem({ regOwner, depUid, trader, binding, user }) {
  if (regOwner && depUid && regOwner !== depUid) return "conflict_click";           // ID зарегистрирован другим пользователем академии
  const bound = (binding && binding.uid) || null;
  // Привязка противоречит click_id академии, а регистрация владельца этого не подтверждает
  if (bound && depUid && bound !== depUid && regOwner !== depUid) return "trader_bound_to_other_user";
  if (user && user.trader_id && String(user.trader_id) !== String(trader)) return "trader_mismatch"; // у пользователя другой ID
  return null;
}
const regOwnerOf = (reg, ctx) => (reg && reg.uid) || (ctx && ctx.regClickUid) || null;

/* Засчитать один депозит в рабочую копию academy (мутирует work). */
function countDeposit(work, dep) {
  const isFirst = dep.kind === "ftd" && !work.first_deposit;
  if (isFirst) {
    work.first_deposit = {
      verified: true, click_id: dep.click_id, uid: dep.uid, event_key: dep.key, at: dep.at,
      amount_cents: dep.amount_cents, currency: dep.currency, usd_cents: dep.currency === "USD" ? dep.amount_cents : null
    };
  }
  work.deposit_totals = work.deposit_totals || {};
  const b = work.deposit_totals[dep.currency] || { sum_cents: 0, count: 0 };
  work.deposit_totals[dep.currency] = { sum_cents: b.sum_cents + dep.amount_cents, count: b.count + 1 };
  work.deposit_count = (work.deposit_count || 0) + 1;
  return isFirst ? "ftd_recorded" : (dep.kind === "ftd" ? "ftd_exists_counted_as_deposit" : "redeposit_recorded");
}

/* Решение по входящему депозиту. Возвращает { status, depositStatus, changed } и мутирует work. */
function applyIncomingDeposit(work, dep, ctx) {
  const problem = ownershipProblem({ regOwner: regOwnerOf(work.registration, ctx), depUid: dep.uid, trader: ctx.trader, binding: ctx.binding, user: ctx.user });
  if (problem === "trader_mismatch") {
    work.pending_deposits = work.pending_deposits || {};
    work.pending_deposits[dep.key] = { ...dep, status: "pending", reason: "trader_mismatch" };
    return { status: problem, depositStatus: "pending_trader_mismatch", changed: true };
  }
  if (problem) return { status: problem, depositStatus: "rejected_" + problem, changed: false };
  if (!work.registration || work.registration.verified !== true) {
    work.pending_deposits = work.pending_deposits || {};
    work.pending_deposits[dep.key] = { ...dep, status: "pending", reason: "registration" };
    return { status: "deposit_pending_registration", depositStatus: "pending_registration", changed: true };
  }
  if (!dep.currency || !CURRENCY_RE.test(dep.currency)) {
    work.pending_deposits = work.pending_deposits || {};
    work.pending_deposits[dep.key] = { ...dep, currency: null, status: "pending", reason: "currency" };
    return { status: "deposit_pending_currency", depositStatus: "pending_currency", changed: true };
  }
  // Владелец депозита: uid из click_id, иначе из регистрации (если известен)
  return { status: countDeposit(work, { ...dep, uid: dep.uid || regOwnerOf(work.registration, ctx) }), depositStatus: "counted", changed: true };
}

/* Доступ к академии фиксируется в базе в момент, когда сумма подтверждённых депозитов в USD достигла порога.
   Дальше он не закрывается (даже если появятся новые события). Возвращает true, если доступ открыт сейчас. */
function grantAccessIfReached(work, t, eventKey, usdBefore) {
  const { ACCESS_MIN_USD_CENTS } = require("./access");
  if (work.access_granted || !work.registration || work.registration.verified !== true) return false;
  const usd = work.deposit_totals && work.deposit_totals.USD && Number.isSafeInteger(work.deposit_totals.USD.sum_cents) ? work.deposit_totals.USD.sum_cents : 0;
  if (usd < ACCESS_MIN_USD_CENTS) return false;
  // сумма уже была ≥ $50 до этого события — доступ существовал раньше; время активации неизвестно (backfilled)
  const backfilled = Number.isSafeInteger(usdBefore) && usdBefore >= ACCESS_MIN_USD_CENTS;
  work.access_granted = { at: t, usd_cents: usd, rule: "cumulative_usd_50", event_key: eventKey || null, uid: (work.registration && work.registration.uid) || null, ...(backfilled ? { backfilled: true } : {}) };
  return true;
}
/* Возможный повтор (то же содержимое пришло позже окна ретраев, а ID события нет): не засчитывается автоматически,
   ждёт решения администратора — так не теряется настоящее второе пополнение на ту же сумму и не удваивается ретрай. */
function holdForReview(work, dep, reason) {
  work.pending_deposits = work.pending_deposits || {};
  work.pending_deposits[dep.key] = { ...dep, status: "pending", reason };
  return { status: "deposit_pending_review", depositStatus: "pending_review", changed: true };
}

/* Обработка отложенных депозитов (после регистрации или при подтверждённой валюте).
   currencyOverride — применяется только к записям без валюты (решение владельца, см. скрипт).
   Возвращает список { key, depositStatus, currency }. Повторный вызов ничего не меняет. */
function promotePending(work, ctx, { currencyOverride = null } = {}) {
  const out = [];
  const pend = work.pending_deposits || {};
  const keys = Object.keys(pend).filter(k => pend[k].status === "pending").sort((a, b) => (pend[a].at || 0) - (pend[b].at || 0));
  for (const k of keys) {
    const d = pend[k];
    if (d.reason === "possible_repeat") continue;                                      // только решение администратора
    const user = ctx.users ? ctx.users[d.uid] || null : (d.uid && ctx.user && ctx.userUid === d.uid ? ctx.user : null);
    const problem = ownershipProblem({ regOwner: regOwnerOf(work.registration, ctx), depUid: d.uid || null, trader: ctx.trader, binding: ctx.binding, user });
    if (problem === "trader_mismatch") continue;                                       // ждём, пока пользователь привяжет этот ID
    if (problem) { pend[k] = { ...d, status: "rejected", reject_reason: problem }; out.push({ key: k, depositStatus: "rejected_" + problem }); continue; }
    if (!work.registration || work.registration.verified !== true) continue;          // всё ещё ждём регистрацию
    const cur = d.currency && CURRENCY_RE.test(d.currency) ? d.currency : (currencyOverride && CURRENCY_RE.test(currencyOverride) ? currencyOverride : null);
    if (!cur) { if (d.reason !== "currency") pend[k] = { ...d, reason: "currency" }; continue; } // ждём валюту
    countDeposit(work, { ...d, currency: cur, uid: d.uid || regOwnerOf(work.registration, ctx) });
    pend[k] = { ...d, currency: cur, status: "counted" };
    out.push({ key: k, depositStatus: "counted", currency: cur });
  }
  return out;
}

/* Данные прежней версии: первый депозит записан без валюты (currency: null, usd_cents: null)
   и учтён только счётчиком unknown_currency_count. Исправляется ТОЛЬКО с явно заданной валютой. */
function fixLegacyNullCurrency(work, legacyEvents, currency) {
  const out = [];
  if (!currency || !CURRENCY_RE.test(currency)) return out;
  for (const ev of legacyEvents) {
    if (ev.currency || ev.counted_in_totals || ev.status) continue;                    // уже исправлено или новая схема
    work.deposit_totals = work.deposit_totals || {};
    const b = work.deposit_totals[currency] || { sum_cents: 0, count: 0 };
    work.deposit_totals[currency] = { sum_cents: b.sum_cents + ev.amount_cents, count: b.count + 1 };
    const u = work.deposit_totals.unknown_currency_count || 0;
    work.deposit_totals.unknown_currency_count = Math.max(0, u - 1);
    const fd = work.first_deposit;
    if (fd && fd.event_key === ev.key && !fd.currency) work.first_deposit = { ...fd, currency, usd_cents: currency === "USD" ? fd.amount_cents : null };
    out.push({ key: ev.key, depositStatus: "counted", currency, legacy: true });
  }
  return out;
}

module.exports = { regOwnerOf, ownershipProblem, countDeposit, applyIncomingDeposit, promotePending, grantAccessIfReached, holdForReview, fixLegacyNullCurrency, clone, CURRENCY_RE };
