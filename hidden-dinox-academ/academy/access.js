"use strict";
/* HIDDEN DINOX ACADEMY — расчёт доступа (чистые функции, без Express и Firebase).

   Доступ открыт только если ВСЕ условия выполнены:
   1) пользователь авторизован (проверяет вызывающий код по ID-токену);
   2) Trader ID привязан к этому UID (users/{uid}.trader_id + trader_bindings/{traderId}.uid);
   3) регистрация у партнёра подтверждена проверенным postback (по trader_id); если в ней известен
      владелец (click_id академии) — это именно этот пользователь;
   4) СУММА подтверждённых квалифицирующих депозитов этого Trader ID в USD не меньше ACCESS_MIN_USD_CENTS ($50.00).
      Несколько пополнений складываются ($20 + $30 = $50). Повторы, неподтверждённые, отклонённые и депозиты
      без подтверждённой валюты в сумму не входят (их отсекает deposits.js/postback.js).
   Достигнутый доступ записывается в базу (referrals/{traderId}.academy.access_granted) и больше не закрывается.

   Переход с прежнего правила («первый депозит от $40»): ученики, у которых первый депозит от $40 подтверждён ДО
   перехода (момент записан в system/access_rule_v50), сохраняют доступ — никого не отключаем после деплоя.
   Для новых депозитов действует только правило суммы от $50. Партнёрское $10 по старому правилу не начисляется. */

const ACCESS_MIN_USD_CENTS = 5000;          // $50.00 включительно — по сумме подтверждённых депозитов
const LEGACY_FTD_MIN_USD_CENTS = 4000;      // прежнее правило: первый депозит от $40 (только до перехода)
let LEGACY_FTD_BEFORE = null;               // момент перехода (мс); null — льгота не применяется
function setLegacyCutoff(ms) { LEGACY_FTD_BEFORE = Number.isFinite(ms) ? ms : null; }

/* Сумма из postback → целые центы. Без чисел с плавающей точкой (39.99 должно остаться 3999).
   Больше двух знаков после точки — отбрасываем (никогда не округляем вверх).
   Всё, что не похоже на неотрицательное десятичное число, — null. */
function parseAmountToCents(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!/^\d{1,9}(\.\d+)?$/.test(s)) return null;
  const [int, frac = ""] = s.split(".");
  const cents = Number(int) * 100 + Number((frac + "00").slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

const TRADER_ID_RE = /^\d{5,14}$/; // предположение — сверить с брокером

function isValidTraderId(v) { return typeof v === "string" && TRADER_ID_RE.test(v); }

function maskTraderId(id) {
  if (!id) return null;
  const s = String(id);
  return "••••" + s.slice(-4);
}

/* Подтверждения академии хранятся в referrals/{traderId}.academy (не пересекается со старыми полями). */
function registrationOf(referral) { return referral && referral.academy && referral.academy.registration || null; }
function firstDepositOf(referral) { return referral && referral.academy && referral.academy.first_deposit || null; }

/* user: users/{uid} (+ uid), binding: trader_bindings/{traderId}, referral: referrals/{traderId} */
/* regOwner (необязательно) — владелец регистрации, определённый по click_id академии, если в записи нет uid */
function evaluateAccess({ uid, user, binding, referral, regOwner = null }) {
  const out = {
    stage: "broker",
    traderId: null,
    traderIdMasked: null,
    traderIdLocked: false,
    brokerRegistrationConfirmed: false,
    depositState: "none",          // "none" | "low" | "ok"
    firstDeposit: null,            // { amount, currency } — только подтверждённый USD
    deposits: null,                // { count, totals: { USD: 100.00, … }, unknownCurrencyCount } — все депозиты
    depositProgress: null,         // { confirmed_cents, required_cents, remaining_cents, pending_count, pending_reasons }
    accessReason: null,            // "cumulative" | "persisted" | "legacy_ftd40"
    accessGrantedAt: null,         // мс; null — время неизвестно (историческая активация)
    academyAccess: false
  };
  if (!uid || !user || !user.trader_id) return out;

  const traderId = String(user.trader_id);
  // Привязка должна принадлежать именно этому пользователю
  if (!binding || binding.uid !== uid) return out;

  out.traderId = traderId;
  out.traderIdMasked = maskTraderId(traderId);
  out.stage = "deposit";

  // Регистрация засчитывается владельцу привязки; если регистрация знает владельца (click_id академии) — только ему
  const reg = registrationOf(referral);
  const owner = (reg && reg.uid) || regOwner || null;
  const regOk = !!(reg && reg.verified === true && (!owner || owner === uid));
  out.brokerRegistrationConfirmed = regOk;

  const fd = firstDepositOf(referral);
  const fdMine = !!(regOk && fd && fd.verified === true && (!fd.uid || fd.uid === uid));
  // Смена Trader ID блокируется, как только к нему подтверждён первый депозит этого пользователя
  out.traderIdLocked = fdMine;

  const fdUsable = fdMine && fd.currency === "USD" && Number.isSafeInteger(fd.usd_cents) && fd.usd_cents >= 0;
  if (fdUsable) out.firstDeposit = { amount: fd.usd_cents / 100, currency: "USD" };

  // Сумма подтверждённых депозитов в USD (каждый засчитан один раз; только для владельца подтверждённой регистрации)
  const acad = (referral && referral.academy) || {};
  // Записи самых ранних версий могли не иметь накопленной суммы — тогда учитывается подтверждённый первый депозит
  const usd = !regOk ? 0 : (acad.deposit_totals ? (acad.deposit_totals.USD && Number.isSafeInteger(acad.deposit_totals.USD.sum_cents) ? acad.deposit_totals.USD.sum_cents : 0) : (fdUsable ? fd.usd_cents : 0));
  const pend = Object.values(acad.pending_deposits || {}).filter(p => p && p.status === "pending" && (!p.uid || p.uid === uid));
  out.depositProgress = { confirmed_cents: usd, required_cents: ACCESS_MIN_USD_CENTS, remaining_cents: Math.max(0, ACCESS_MIN_USD_CENTS - usd),
    pending_count: regOk || pend.length ? pend.length : 0, pending_reasons: [...new Set(pend.map(p => p.reason || "pending"))] };
  if (regOk && usd > 0) out.traderIdLocked = true;                                  // есть засчитанные депозиты — ID не меняется

  const granted = acad.access_granted && (!acad.access_granted.uid || acad.access_granted.uid === uid);
  const legacy = fdUsable && fd.usd_cents >= LEGACY_FTD_MIN_USD_CENTS && LEGACY_FTD_BEFORE !== null && Number.isFinite(fd.at) && fd.at < LEGACY_FTD_BEFORE;
  // Время активации доступа (для начисления партнёру): сохранённое в базе; для прежнего правила — время первого депозита.
  // Неизвестно (доступ был до записи в базу) — null: такая активация считается исторической.
  out.accessGrantedAt = granted && !acad.access_granted.backfilled ? (acad.access_granted.at || null) : null;
  if (regOk && usd >= ACCESS_MIN_USD_CENTS) out.accessReason = "cumulative";
  else if (regOk && granted) out.accessReason = "persisted";
  else if (regOk && legacy) { out.accessReason = "legacy_ftd40"; out.accessGrantedAt = null; }
  out.depositState = out.accessReason ? "ok" : (regOk && (usd > 0 || fdUsable) ? "low" : "none");

  // Итоги по всем депозитам — независимый показатель, на доступ НЕ влияет.
  // Показываются только владельцу подтверждённой регистрации; валюты не складываются между собой.
  if (regOk && referral.academy) {
    const t = referral.academy.deposit_totals || {};
    const totals = {};
    for (const [cur, v] of Object.entries(t)) {
      if (/^[A-Z]{3}$/.test(cur) && v && Number.isSafeInteger(v.sum_cents)) totals[cur] = v.sum_cents / 100;
    }
    out.deposits = {
      count: Number.isSafeInteger(referral.academy.deposit_count) ? referral.academy.deposit_count : 0,
      totals,
      unknownCurrencyCount: Number.isSafeInteger(t.unknown_currency_count) ? t.unknown_currency_count : 0
    };
  }

  out.academyAccess = regOk && out.depositState === "ok";
  if (out.academyAccess) out.stage = "academy";
  return out;
}

module.exports = { ACCESS_MIN_USD_CENTS, LEGACY_FTD_MIN_USD_CENTS, setLegacyCutoff, parseAmountToCents, isValidTraderId, maskTraderId, evaluateAccess, registrationOf, firstDepositOf };
