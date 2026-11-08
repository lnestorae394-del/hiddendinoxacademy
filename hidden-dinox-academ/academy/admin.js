"use strict";
/* Администрирование Trader ID — только через скрипты (scripts/), без HTTP-маршрутов.
   inspectTrader — только чтение. rebindTrader — явный перенос привязки (по умолчанию просмотр). */
const { registrationOf, firstDepositOf } = require("./access");
const CLICK_RE = /^[A-Za-z0-9_-]{8,128}$/;
const maskClick = c => (c ? String(c).slice(0, 4) + "…" + String(c).slice(-3) : null);

async function ownerOfRegistration(get, db, reg) {
  if (!reg) return { owner: null, via: null };
  if (reg.uid) return { owner: reg.uid, via: "registration.uid" };
  if (typeof reg.click_id === "string" && CLICK_RE.test(reg.click_id)) {
    const c = await get(db.collection("clicks").doc(reg.click_id));
    if (c.exists) return { owner: c.data().uid, via: "click_id академии" };
  }
  return { owner: null, via: null };
}

/* Только чтение: всё, что нужно, чтобы понять причину 409 по конкретному Trader ID */
async function inspectTrader(db, trader) {
  const get = ref => ref.get();
  const [refDoc, bindDoc] = await Promise.all([get(db.collection("referrals").doc(trader)), get(db.collection("trader_bindings").doc(trader))]);
  const ref = refDoc.exists ? refDoc.data() : null;
  const reg = ref ? registrationOf(ref) : null;
  const fd = ref ? firstDepositOf(ref) : null;
  const { owner, via } = await ownerOfRegistration(get, db, reg);
  const binding = bindDoc.exists ? bindDoc.data() : null;
  const events = (await db.collection("postback_events").where("trader_id", "==", trader).get()).docs
    .map(d => d.data()).sort((a, b) => (a.received_at || 0) - (b.received_at || 0))
    .map(e => ({ kind: e.kind, status: e.status, click: maskClick(e.click_id), click_academy: !!e.click_known, at: e.received_at ? new Date(e.received_at).toISOString() : null }));
  const pending = Object.values((ref && ref.academy && ref.academy.pending_deposits) || {}).map(p => ({ kind: p.kind, amount: p.amount_cents / 100, currency: p.currency, status: p.status, reason: p.reason || p.reject_reason || null }));
  return {
    trader: "••••" + String(trader).slice(-4),
    legacy_fields_only: !!(ref && !ref.academy),
    registration: reg ? { verified: reg.verified === true, click: maskClick(reg.click_id), owner_uid: owner, owner_via: via } : null,
    binding_uid: binding ? binding.uid : null,
    binding_matches_owner: binding && owner ? binding.uid === owner : null,
    first_deposit: fd ? { amount: fd.amount_cents / 100, currency: fd.currency, uid: fd.uid || null } : null,
    deposit_totals: (ref && ref.academy && ref.academy.deposit_totals) || {},
    pending_deposits: pending,
    events
  };
}

/* Явный перенос привязки Trader ID на другой аккаунт академии. Ничего не удаляет.
   Отказ, если регистрация или первый депозит подтверждены за ДРУГИМ пользователем. */
async function rebindTrader(db, { trader, toUid, reason = "", apply = false, now = () => Date.now() }) {
  if (!trader || !toUid) throw new Error("нужны trader и toUid");
  return db.runTransaction(async tx => {
    const get = ref => tx.get(ref);
    const refDoc = await get(db.collection("referrals").doc(trader));
    const bindRef = db.collection("trader_bindings").doc(trader);
    const bindDoc = await get(bindRef);
    const toRef = db.collection("users").doc(toUid);
    const toDoc = await get(toRef);
    const ref = refDoc.exists ? refDoc.data() : null;
    const reg = ref ? registrationOf(ref) : null;
    if (!reg || reg.verified !== true) return { ok: false, reason: "нет подтверждённой регистрации этого Trader ID" };
    const { owner } = await ownerOfRegistration(get, db, reg);
    if (owner && owner !== toUid) return { ok: false, reason: "регистрация подтверждена за другим пользователем (" + owner + ") — перенос запрещён" };
    const fd = firstDepositOf(ref);
    if (fd && fd.uid && fd.uid !== toUid) return { ok: false, reason: "первый депозит подтверждён за другим пользователем (" + fd.uid + ") — перенос запрещён" };
    if (!toDoc.exists) return { ok: false, reason: "аккаунт академии " + toUid + " не найден (пользователь должен хотя бы раз войти)" };
    const toUser = toDoc.data();
    if (toUser.trader_id && String(toUser.trader_id) !== String(trader)) return { ok: false, reason: "у нового аккаунта уже привязан другой Trader ID" };
    const fromUid = bindDoc.exists ? bindDoc.data().uid : null;
    if (fromUid === toUid) return { ok: true, changed: false, reason: "уже привязан к этому аккаунту" };
    if (apply) {
      const t = now();
      tx.set(bindRef, { uid: toUid, bound_at: t, previous_uid: fromUid, rebound_at: t, rebound_by: "admin-script", rebound_reason: String(reason).slice(0, 200) }, { merge: true });
      if (fromUid) tx.set(db.collection("users").doc(fromUid), { trader_id: null, trader_unbound_at: t }, { merge: true });
      tx.set(toRef, { trader_id: String(trader), trader_bound_at: t }, { merge: true });
    }
    return { ok: true, changed: !!apply, from: fromUid, to: toUid };
  });
}

module.exports = { inspectTrader, rebindTrader };
