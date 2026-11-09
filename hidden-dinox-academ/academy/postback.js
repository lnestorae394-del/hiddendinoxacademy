"use strict";
/* HIDDEN DINOX ACADEMY — обработка postback от Pocket Partners.

   Pocket Partners (макросы): {CLICK_ID}, {TRADER_ID}, {SUMDEP}. URL (отдельно для каждого события):
     Registration:  /postback?type=registration&click_id={CLICK_ID}&trader_id={TRADER_ID}&secret=…
     First Deposit: /postback?type=ftd&click_id={CLICK_ID}&trader_id={TRADER_ID}&amount={SUMDEP}&secret=…
     Re-deposit:    /postback?type=redeposit&click_id={CLICK_ID}&trader_id={TRADER_ID}&amount={SUMDEP}&secret=…
   Без type: сумма > 0 → первый депозит, пустая/0 → регистрация (совместимость с прежними URL).

   Секрет — ТОЛЬКО из переменной окружения POCKET_POSTBACK_SECRET (≥ 24 символов); без него 503.
   ОСНОВНОЙ идентификатор — trader_id: событие сохраняется в referrals/{traderId}.academy.
   click_id необязателен; если он выдан академией (clicks), он подтверждает владельца ID.
   Параметры читаются строго: click_id, trader_id, amount, type, currency.
   cid / sub1 / sum / payout / profit НЕ используются. */

const crypto = require("crypto");
const { parseAmountToCents } = require("./access");
const D = require("./deposits");

const SECRET_PARAM = "secret";
const MIN_SECRET_LENGTH = 24;
const TRADER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CLICK_RE = /^[A-Za-z0-9_-]{8,128}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MACRO_RE = /[{}\[\]%]|^(click_id|trader_id|sum|amount|CLICK_ID|TRADER_ID|SUMDEP)$/; // макрос не подставлен платформой

const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const one = v => (Array.isArray(v) ? undefined : v);

/* Код результата → HTTP-статус и понятное сообщение (для логов Pocket Partners и Render) */
const OUTCOMES = {
  registration_confirmed:          [200, "Регистрация подтверждена"],
  registration_exists:             [200, "Регистрация уже была подтверждена ранее"],
  ftd_recorded:                    [200, "Первый депозит записан"],
  ftd_exists_counted_as_deposit:   [200, "Первый депозит уже был; событие учтено как обычный депозит"],
  redeposit_recorded:              [200, "Повторный депозит записан"],
  duplicate:                       [200, "Событие уже обработано ранее (повторная доставка)"],
  not_configured:                  [503, "POCKET_POSTBACK_SECRET не задан или короче 24 символов — postback не принимаются"],
  no_db:                           [503, "Firebase не подключён — событие не записано, повторите позже"],
  db_error:                        [503, "Ошибка Firebase — событие не записано, повторите позже"],
  secret_missing:                  [401, "Нет параметра secret"],
  secret_invalid:                  [403, "Неверный secret"],
  ip_not_allowed:                  [403, "IP-адрес не разрешён"],
  macro_not_substituted:           [400, "Макрос не подставлен платформой (пришло значение вида {click_id})"],
  invalid_trader:                  [400, "Некорректный или отсутствующий trader_id"],
  invalid_click:                   [400, "Некорректный click_id"],
  invalid_amount:                  [400, "Некорректная или отсутствующая сумма amount"],
  unknown_type:                    [400, "Неизвестный type (поддерживается только redeposit)"],
  conflict_click:                  [409, "Этот Trader ID зарегистрирован другим пользователем академии — событие не учтено"],
  trader_bound_to_other_user:      [409, "Этот Trader ID привязан к другому пользователю академии — событие не учтено"],
  trader_mismatch:                 [409, "У пользователя этого click_id привязан другой Trader ID — депозит НЕ учтён (сохранён для повторной проверки)"],
  deposit_pending_registration:    [202, "Депозит сохранён по trader_id, но НЕ учтён: регистрация этого Trader ID ещё не приходила"],
  deposit_pending_currency:        [202, "Депозит сохранён, но НЕ учтён: неизвестна валюта (нужна POSTBACK_DEFAULT_CURRENCY или параметр currency)"]
};
const outcome = (status, extra = {}) => { const [http, message] = OUTCOMES[status] || [500, "Внутренняя ошибка"]; return { status, http, message, ...extra }; };

function readConfig(env) {
  const raw = env.POCKET_POSTBACK_SECRET || "";
  const list = s => String(s || "").split(",").map(x => x.trim()).filter(Boolean);
  return {
    secret: raw.length >= MIN_SECRET_LENGTH ? raw : "",
    secretTooShort: raw.length > 0 && raw.length < MIN_SECRET_LENGTH,
    allowedIps: list(env.POSTBACK_ALLOWED_IPS),
    // Валюта по умолчанию — ТОЛЬКО если в Pocket Partners подтверждено, что {sum} всегда в USD
    defaultCurrency: (env.POSTBACK_DEFAULT_CURRENCY || "").toUpperCase(),
    eventIdParam: env.POSTBACK_EVENT_ID_PARAM || "",
    staticCids: list(env.PARTNER_STATIC_CIDS || "987453")
  };
}

function classify(query) {
  const type = one(query.type), amountRaw = one(query.amount);
  if (type === "redeposit") return "redeposit";
  if (type === "ftd") return "ftd";
  if (type === "registration") return "registration";
  if (type !== undefined && type !== "") return "unknown";
  // Без type: сумма > 0 — депозит; пустая или 0 — регистрация (событие регистрации с {SUMDEP}=0 не станет депозитом $0)
  const c = parseAmountToCents(amountRaw);
  return c !== null && c > 0 ? "ftd" : "registration";
}

function eventKey(kind, f, cfg, query) {
  const eid = cfg.eventIdParam ? one(query[cfg.eventIdParam]) : undefined;
  if (eid && /^[A-Za-z0-9_.:-]{1,128}$/.test(eid)) return "id_" + eid;
  return "fp_" + crypto.createHash("sha256").update(JSON.stringify([kind, f.click, f.trader, f.amountRaw, f.currency])).digest("hex").slice(0, 40);
}

/* Окно ретраев: то же событие без ID пришло повторно в течение 15 минут — это повтор доставки, а не новый депозит. */
const REPEAT_WINDOW_MS = 15 * 60 * 1000;
function createAcademyPostback({ db, env = process.env, log = console, now = () => Date.now() }) {
  const cfg = readConfig(env);

  async function handle(query = {}, meta = {}) {
    // 1) Аутентификация источника — до любых обращений к базе
    if (!cfg.secret) return outcome("not_configured");
    const given = one(query[SECRET_PARAM]);
    if (given === undefined || given === "") return outcome("secret_missing");
    if (!safeEqual(given, cfg.secret)) return outcome("secret_invalid");
    if (cfg.allowedIps.length && !(meta.ip && cfg.allowedIps.includes(meta.ip))) return outcome("ip_not_allowed");

    // 2) Параметры
    const kind = classify(query);
    const click = one(query.click_id), trader = one(query.trader_id), amountRaw = one(query.amount), currencyRaw = one(query.currency);
    for (const v of [click, trader, amountRaw]) if (typeof v === "string" && MACRO_RE.test(v)) return outcome("macro_not_substituted");
    if (!trader || !TRADER_RE.test(trader)) return outcome("invalid_trader");
    if (click != null && click !== "" && !CLICK_RE.test(click)) return outcome("invalid_click");
    if (kind === "unknown") return outcome("unknown_type");
    let cents = null;
    if (kind !== "registration") { cents = parseAmountToCents(amountRaw); if (cents === null || cents <= 0) return outcome("invalid_amount"); }
    const currency = currencyRaw ? String(currencyRaw).toUpperCase() : (cfg.defaultCurrency || null);
    if (!db) return outcome("no_db");

    // 3) Запись — одна транзакция на событие
    const key = eventKey(kind, { click, trader, amountRaw, currency }, cfg, query);
    const clickKnownFormat = !!(click && CLICK_RE.test(click) && !cfg.staticCids.includes(click));
    const evRef = db.collection("postback_events").doc(key);
    const refRef = db.collection("referrals").doc(trader);
    const bindRef = db.collection("trader_bindings").doc(trader);
    let res;
    try {
      res = await db.runTransaction(async tx => {
        // --- все чтения до записей (требование Firestore) ---
        const ev = await tx.get(evRef);
        let repeatKey = null;
        if (ev.exists) {
          const prevAt = Number(ev.data().received_at) || 0;
          // С ID события, регистрация или повтор в окне ретраев — дубль. Иначе (тот же депозит позже, без ID) —
          // возможное новое пополнение на ту же сумму: сохраняем отдельно, но НЕ засчитываем до решения администратора.
          if (kind === "registration" || key.startsWith("id_") || now() - prevAt <= REPEAT_WINDOW_MS) return { status: "duplicate", uid: ev.data().uid || null };
          repeatKey = key + "_r" + now();
          if ((await tx.get(db.collection("postback_events").doc(repeatKey))).exists) return { status: "duplicate", uid: ev.data().uid || null };
        }
        const k = repeatKey || key;
        const refDoc = await tx.get(refRef);
        const bindDoc = await tx.get(bindRef);
        const clickDoc = clickKnownFormat ? await tx.get(db.collection("clicks").doc(click)) : null;
        const clickUid = clickDoc && clickDoc.exists ? clickDoc.data().uid : null;   // «сильная» связь, если click выдан академией
        const original = (refDoc.exists && refDoc.data().academy) || {};
        // Владелец регистрации: reg.uid, а если его нет — uid из click_id регистрации (если тот выдан академией)
        const oreg = original.registration;
        let regClickUid = null;
        if (oreg && !oreg.uid && oreg.click_id && CLICK_RE.test(oreg.click_id) && !cfg.staticCids.includes(oreg.click_id)) {
          if (oreg.click_id === click) regClickUid = clickUid;
          else { const rc = await tx.get(db.collection("clicks").doc(oreg.click_id)); regClickUid = rc.exists ? rc.data().uid : null; }
        }
        const uids = new Set([clickUid, ...Object.values(original.pending_deposits || {}).map(p => p.uid)].filter(Boolean));
        const users = {};
        for (const u of uids) { const d = await tx.get(db.collection("users").doc(u)); users[u] = d.exists ? d.data() : null; }
        const binding = bindDoc.exists ? bindDoc.data() : null;

        const work = D.clone(original);
        const t = now();
        let status, promoted = [], clickNote = null;

        if (kind === "registration") {
          const reg = work.registration;
          const owner = (reg && reg.uid) || regClickUid;
          if (reg && owner && clickUid && owner !== clickUid) status = "conflict_click";
          else if (reg) {
            // Регистрация уже есть. Если раньше владелец был неизвестен, а теперь пришёл click_id академии — уточняем
            if (!owner && clickUid && (!binding || binding.uid === clickUid)) work.registration = { ...reg, uid: clickUid, click_id: reg.click_id || click, click_known: true, uid_confirmed_at: t };
            status = "registration_exists";
          } else {
            work.registration = { verified: true, click_id: click || null, uid: clickUid, click_known: !!clickUid, source: "registration", event_key: key, at: t };
            status = "registration_confirmed";
          }
          if (status !== "conflict_click") promoted = D.promotePending(work, { trader, binding, users, regClickUid }, { currencyOverride: cfg.defaultCurrency || null });
        } else {
          const cur = currency && CURRENCY_RE.test(currency) ? currency : null;
          const dep = { key: k, kind, amount_cents: cents, currency: cur, click_id: click || null, uid: clickUid, at: t };
          const r = repeatKey ? D.holdForReview(work, dep, "possible_repeat") : D.applyIncomingDeposit(work, dep, { trader, binding, regClickUid, user: clickUid ? users[clickUid] : null });
          status = r.status;
          const regClick = work.registration && work.registration.click_id;
          if (click && regClick && click !== regClick) clickNote = "click_id отличается от регистрации (не конфликт: click_id не определяет владельца)";
          tx.create(db.collection("deposit_events").doc(k), {
            trader_id: trader, click_id: click || null, uid: clickUid || (work.registration && work.registration.uid) || null, kind, amount_cents: cents, currency: cur,
            status: r.depositStatus, counted_in_totals: r.depositStatus === "counted", at: t
          });
        }

        const usdBefore = original.deposit_totals && original.deposit_totals.USD ? original.deposit_totals.USD.sum_cents : 0;
        const accessOpened = D.grantAccessIfReached(work, t, k, usdBefore);                // сумма достигла $50 — доступ фиксируется в базе
        if (JSON.stringify(work) !== JSON.stringify(original)) tx.set(refRef, { academy: work }, { merge: true });
        for (const p of promoted) {
          tx.set(db.collection("deposit_events").doc(p.key), { status: p.depositStatus, counted_in_totals: p.depositStatus === "counted", ...(p.currency ? { currency: p.currency } : {}), promoted_at: t }, { merge: true });
        }
        tx.create(repeatKey ? db.collection("postback_events").doc(repeatKey) : evRef, { kind, status, ...(repeatKey ? { repeat_of: key } : {}), uid: clickUid, click_known: !!clickUid, ...(clickNote ? { click_note: "differs_from_registration" } : {}), trader_id: trader, click_id: click || null, amount_raw: amountRaw != null ? String(amountRaw).slice(0, 32) : null, currency: currency || null, received_at: now() });
        return { status, accessGranted: accessOpened, uid: clickUid, promoted: promoted.length, clickKnown: !!clickUid, clickNote, ownerKnown: !!((work.registration && work.registration.uid) || regClickUid), bound: !!binding };
      });
    } catch (e) {
      log.error && log.error("postback: ошибка Firebase:", e && (e.code || e.message));
      return outcome("db_error");
    }
    log.log && log.log(`postback ${kind}: trader ••••${String(trader).slice(-4)}, click ${res.clickKnown ? "академии" : (click ? "не из академии" : "нет")}, владелец ${res.ownerKnown ? "известен" : "не известен"}, привязка ${res.bound ? "есть" : "нет"} → ${res.status}` + (res.clickNote ? ` (${res.clickNote})` : ""));
    return outcome(res.status, { kind, key, verified: true, promoted: res.promoted || 0, clickKnown: !!res.clickKnown, accessGranted: !!res.accessGranted });
  }

  return { handle, config: { secretConfigured: !!cfg.secret, secretTooShort: cfg.secretTooShort, ipListConfigured: cfg.allowedIps.length > 0, defaultCurrency: cfg.defaultCurrency || null } };
}

module.exports = { createAcademyPostback, readConfig, classify, MIN_SECRET_LENGTH, SECRET_PARAM, OUTCOMES };
