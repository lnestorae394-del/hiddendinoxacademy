"use strict";
/* Безопасная повторная обработка сохранённых депозитов (без HTTP-маршрута; запуск — scripts/reprocess-deposits.js).
   - Отложенные депозиты (регистрация пришла позже / валюта была неизвестна) засчитываются по тем же правилам,
     что и при приёме postback (academy/deposits.js), включая проверку принадлежности Trader ID.
   - Записи прошлой версии с currency: null / usd_cents: null исправляются ТОЛЬКО при явно заданной валюте.
   - Каждое событие учитывается не более одного раза: статус события проверяется внутри транзакции.
   - По умолчанию ничего не записывает (apply: false). */
const D = require("./deposits");

async function tradersToCheck(db, onlyTrader) {
  if (onlyTrader) return [String(onlyTrader)];
  const snap = await db.collection("referrals").get();
  return snap.docs.filter(d => d.data().academy).map(d => d.id);
}

async function reprocessTrader(db, trader, { currency = null, apply = false, now = () => Date.now() } = {}) {
  const cur = currency ? String(currency).toUpperCase() : null;
  if (cur && !D.CURRENCY_RE.test(cur)) throw new Error("валюта должна быть кодом из 3 букв, например USD");
  // Кандидаты прошлой версии ищем вне транзакции, внутри — перечитываем и перепроверяем
  const evSnap = await db.collection("deposit_events").where("trader_id", "==", trader).get();
  const legacyKeys = evSnap.docs.filter(d => { const x = d.data(); return !x.currency && !x.counted_in_totals && !x.status; }).map(d => d.id);

  return db.runTransaction(async tx => {
    const refRef = db.collection("referrals").doc(trader);
    const refDoc = await tx.get(refRef);
    const original = refDoc.exists ? refDoc.data().academy : null;
    if (!original) return { trader, changes: [] };
    const legacy = [];
    for (const k of legacyKeys) { const e = await tx.get(db.collection("deposit_events").doc(k)); if (e.exists) legacy.push({ key: k, ...e.data() }); }
    const work = D.clone(original);
    const bindDoc = await tx.get(db.collection("trader_bindings").doc(trader));
    const binding = bindDoc.exists ? bindDoc.data() : null;
    const uids = new Set([work.registration && work.registration.uid, ...Object.values(work.pending_deposits || {}).map(p => p.uid)].filter(Boolean));
    const users = {};
    for (const u of uids) { const d = await tx.get(db.collection("users").doc(u)); users[u] = d.exists ? d.data() : null; }
    let regClickUid = null;
    const reg0 = work.registration;
    if (reg0 && !reg0.uid && typeof reg0.click_id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(reg0.click_id)) {
      const c = await tx.get(db.collection("clicks").doc(reg0.click_id)); regClickUid = c.exists ? c.data().uid : null;
    }
    const ctx = { trader, binding, users, regClickUid };

    const changes = [...D.fixLegacyNullCurrency(work, legacy, cur), ...D.promotePending(work, ctx, { currencyOverride: cur })];
    if (apply && changes.length) {
      const t = now();
      tx.set(refRef, { academy: work }, { merge: true });
      for (const c of changes) {
        tx.set(db.collection("deposit_events").doc(c.key), { status: c.depositStatus, counted_in_totals: c.depositStatus === "counted", ...(c.currency ? { currency: c.currency } : {}), reprocessed_at: t, ...(cur ? { reprocess_currency: cur } : {}) }, { merge: true });
      }
    }
    const fd = work.first_deposit;
    return { trader, changes, firstDeposit: fd ? { amount_cents: fd.amount_cents, currency: fd.currency, usd_cents: fd.usd_cents } : null, totals: work.deposit_totals || {} };
  });
}

async function reprocessAll(db, opts = {}) {
  const traders = await tradersToCheck(db, opts.trader);
  const results = [];
  for (const t of traders) results.push(await reprocessTrader(db, t, opts));
  return results;
}

module.exports = { reprocessTrader, reprocessAll };
