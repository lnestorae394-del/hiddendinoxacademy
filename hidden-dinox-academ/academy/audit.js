"use strict";
/* Аудит данных академии в Firestore — ТОЛЬКО ЧТЕНИЕ. Ничего не изменяет.
   Показывает размеры коллекций и несоответствия, которые нужно увидеть до и после исправлений. */
const mask = id => (id ? "••••" + String(id).slice(-4) : id);

async function runAudit(db) {
  const all = async c => (await db.collection(c).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const [users, clicks, bindings, referrals, events] = await Promise.all(["users", "clicks", "trader_bindings", "referrals", "deposit_events"].map(all));
  const byId = arr => Object.fromEntries(arr.map(x => [x.id, x]));
  const U = byId(users), C = byId(clicks), B = byId(bindings);
  const issues = [];
  const add = (type, detail) => issues.push({ type, ...detail });

  for (const u of users) if (u.trader_id) {
    const b = B[String(u.trader_id)];
    if (!b) add("user_without_binding", { uid: u.id, trader: mask(u.trader_id) });
    else if (b.uid !== u.id) add("binding_points_to_other_user", { uid: u.id, trader: mask(u.trader_id), bindingUid: b.uid });
  }
  for (const b of bindings) { const u = U[b.uid]; if (!u || String(u.trader_id) !== b.id) add("binding_not_reflected_in_user", { trader: mask(b.id), uid: b.uid }); }

  let legacyOnly = 0, withAcademy = 0, nullCurrencyFtd = 0, pending = 0;
  for (const r of referrals) {
    const a = r.academy;
    if (!a) { legacyOnly++; continue; }
    withAcademy++;
    const reg = a.registration;
    if (reg) {
      const c = C[reg.click_id];
      if (!c) add("info_registration_click_not_from_academy", { trader: mask(r.id) }); // допустимо: поиск по trader_id
      else if (reg.uid && c.uid !== reg.uid) add("registration_click_uid_mismatch", { trader: mask(r.id) });
      if (reg.source === "ftd") add("registration_created_from_deposit_old_version", { trader: mask(r.id) });
    }
    const fd = a.first_deposit;
    if (fd && !fd.currency) { nullCurrencyFtd++; add("first_deposit_without_currency", { trader: mask(r.id), amount_cents: fd.amount_cents }); }
    if (fd && reg && fd.click_id !== reg.click_id) add("first_deposit_click_differs_from_registration", { trader: mask(r.id) });
    const b = B[r.id];
    if (b && reg && reg.uid && b.uid !== reg.uid) add("binding_uid_differs_from_registration_uid", { trader: mask(r.id) });
    for (const p of Object.values(a.pending_deposits || {})) if (p.status === "pending") pending++;
  }
  const legacyNullEvents = events.filter(e => !e.currency && !e.counted_in_totals && !e.status).length;

  return {
    counts: { users: users.length, clicks: clicks.length, trader_bindings: bindings.length, referrals: referrals.length, referrals_with_academy: withAcademy, referrals_legacy_only: legacyOnly, deposit_events: events.length },
    needs_reprocessing: { first_deposits_without_currency: nullCurrencyFtd, old_version_events_without_currency: legacyNullEvents, pending_deposits: pending },
    issues
  };
}
module.exports = { runAudit };
