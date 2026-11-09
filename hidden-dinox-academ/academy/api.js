"use strict";
/* HIDDEN DINOX ACADEMY — защищённые API.
   Пользователь определяется ТОЛЬКО по проверенному Firebase ID-токену (Authorization: Bearer).
   UID из параметров запроса не принимается. Защищённые поля пишет только сервер. */

const crypto = require("crypto");
const { evaluateAccess, isValidTraderId, registrationOf, firstDepositOf } = require("./access");

const ERR = {
  TRADER_NOT_YOURS: 403,
  UNAUTHENTICATED: 401, ACCOUNT_BLOCKED: 403, INVALID: 400, INVALID_LANG: 400, TRADER_TAKEN: 409, ID_LOCKED: 409, TRADER_NOT_CONFIRMED: 422,
  TOO_MANY: 429, CONFIG_MISSING: 503, UNAVAILABLE: 503, SERVER_ERROR: 500
};
class ApiError extends Error { constructor(code) { super(code); this.code = code; } }
const send = (res, code, body) => res.status(code).json(body);
const fail = (res, code) => send(res, ERR[code] || 500, { error: code });

/* Простое ограничение частоты (в памяти процесса) */
function rateLimiter({ limit, windowMs, now }) {
  const hits = new Map();
  return key => {
    const t = now(), arr = (hits.get(key) || []).filter(x => t - x < windowMs);
    arr.push(t); hits.set(key, arr);
    if (hits.size > 5000) hits.clear();
    return arr.length <= limit;
  };
}

function createAcademyApi({ db, verifyIdToken, log = console, now = () => Date.now(), newClickId, onAccessChange = null }) {
  const genClick = newClickId || (() => "hd_" + crypto.randomBytes(16).toString("hex"));
  const writeLimit = rateLimiter({ limit: 20, windowMs: 60000, now });

  async function authenticate(req) {
    if (!db || !verifyIdToken) throw new ApiError("CONFIG_MISSING");
    const h = req.headers && (req.headers.authorization || req.headers.Authorization);
    const m = typeof h === "string" && h.match(/^Bearer ([A-Za-z0-9._-]{10,4096})$/);
    if (!m) throw new ApiError("UNAUTHENTICATED");
    let decoded;
    try { decoded = await verifyIdToken(m[1]); } catch (e) { throw new ApiError("UNAUTHENTICATED"); }
    if (!decoded || typeof decoded.uid !== "string" || !decoded.uid) throw new ApiError("UNAUTHENTICATED");
    // Заблокированный администратором аккаунт не получает доступ ни к каким данным
    const ud = await db.collection("users").doc(decoded.uid).get();
    if (ud.exists && ud.data().blocked === true) throw new ApiError("ACCOUNT_BLOCKED");
    // Документ пользователя уже прочитан — передаём его дальше, чтобы не читать повторно
    return { uid: decoded.uid, email: decoded.email || null, role: ud.exists ? (ud.data().role || "student") : "student", user: ud.exists ? ud.data() : null };
  }

  const refs = uid => ({ user: db.collection("users").doc(uid) });

  async function loadState(uid, pre) {
    let user;
    if (pre && "user" in pre) user = pre.user;                      // уже прочитан при проверке входа
    else { const u = await refs(uid).user.get(); user = u.exists ? u.data() : null; }
    let binding = null, referral = null;
    if (user && user.trader_id) {
      const [b, r] = await Promise.all([
        db.collection("trader_bindings").doc(String(user.trader_id)).get(),
        db.collection("referrals").doc(String(user.trader_id)).get()
      ]);
      binding = b.exists ? b.data() : null;
      referral = r.exists ? r.data() : null;
    }
    // Владелец регистрации без uid определяется по её click_id, если тот выдан академией
    let regOwner = null;
    const reg = referral ? registrationOf(referral) : null;
    if (reg && !reg.uid && typeof reg.click_id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(reg.click_id)) {
      const c = await db.collection("clicks").doc(reg.click_id).get();
      regOwner = c.exists ? c.data().uid : null;
    }
    return { user, binding, referral, regOwner };
  }

  function profileBody(auth, user, ev) {
    return {
      email: (user && user.email) || auth.email,
      lang: user && ["ru", "en", "ua"].includes(user.lang) ? user.lang : null,       // выбранный язык интерфейса (для входа с другого устройства)
      stage: ev.stage,
      traderId: ev.traderId,
      traderIdMasked: ev.traderIdMasked,
      traderIdLocked: ev.traderIdLocked,
      brokerRegistrationConfirmed: ev.brokerRegistrationConfirmed,
      depositState: ev.depositState,
      firstDeposit: ev.firstDeposit,
      deposits: ev.deposits,
      depositProgress: ev.depositProgress,
      accessReason: ev.accessReason,                                              // "cumulative" | "persisted" | "legacy_ftd40"
      academyAccess: ev.academyAccess,
      role: (user && user.role) || "student"
    };
  }

  function wrap(fn) {
    return async (req, res) => {
      try { await fn(req, res); }
      catch (e) {
        if (e instanceof ApiError) return fail(res, e.code);
        log.error && log.error("academy api error:", e && (e.code || e.message)); // без токенов и тел запросов
        return fail(res, "UNAVAILABLE"); // при любой ошибке доступ не открывается
      }
    };
  }

  /* GET /api/me — профиль, этап, статусы (создаёт users/{uid} при первом обращении) */
  const me = wrap(async (req, res) => {
    const auth = await authenticate(req);
    const userRef = refs(auth.uid).user;
    let pre = { user: auth.user };
    if (!auth.user) {
      // Новый пользователь: профиль создаётся в транзакции (защита от двойного создания)
      await db.runTransaction(async tx => {
        const u = await tx.get(userRef);
        if (!u.exists) tx.create(userRef, { email: auth.email, click_id: null, trader_id: null, created_at: now(), last_active_at: now() });
      });
      pre = undefined;                                                   // перечитать созданный профиль
    } else if (!(auth.user.last_active_at > now() - 10 * 60000)) {
      await userRef.set({ last_active_at: now() }, { merge: true });      // не чаще раза в 10 минут; транзакция не нужна
    }
    const { user, binding, referral, regOwner } = await loadState(auth.uid, pre);
    const ev = evaluateAccess({ uid: auth.uid, user, binding, referral, regOwner });
    res.set && res.set("Cache-Control", "no-store");
    send(res, 200, profileBody(auth, user, ev));
  });

  /* POST /api/click — устойчивый click_id: создаётся один раз на пользователя */
  const click = wrap(async (req, res) => {
    const auth = await authenticate(req);
    if (!writeLimit("c:" + auth.uid)) throw new ApiError("TOO_MANY");
    const userRef = refs(auth.uid).user;
    const clickId = await db.runTransaction(async tx => {
      const u = await tx.get(userRef);
      if (u.exists && u.data().click_id) return u.data().click_id;
      const id = genClick();
      const cRef = db.collection("clicks").doc(id);
      const c = await tx.get(cRef);
      if (c.exists) throw new Error("click collision");
      tx.create(cRef, { uid: auth.uid, created_at: now() });
      if (u.exists) tx.update(userRef, { click_id: id });
      else tx.create(userRef, { email: auth.email, click_id: id, trader_id: null, created_at: now() });
      return id;
    });
    res.set && res.set("Cache-Control", "no-store");
    send(res, 200, { clickId });
  });

  /* POST /api/trader-id {traderId} — привязка или смена Trader ID (связь UID ↔ Trader ID).
     Принимается ТОЛЬКО ID, для которого сервер получил проверенный registration postback; если
     владелец регистрации известен (click_id академии) — только ему. Один ID — один аккаунт.
     Поля из тела запроса, кроме traderId, игнорируются. */
  const traderId = wrap(async (req, res) => {
    const auth = await authenticate(req);
    if (!writeLimit("t:" + auth.uid)) throw new ApiError("TOO_MANY");
    const body = req.body || {};
    const tid = typeof body.traderId === "string" ? body.traderId.trim() : "";
    if (!isValidTraderId(tid)) throw new ApiError("INVALID");
    const userRef = refs(auth.uid).user;

    await db.runTransaction(async tx => {
      const u = await tx.get(userRef);
      const user = u.exists ? u.data() : { email: auth.email, click_id: null, trader_id: null, created_at: now() };
      const curTid = user.trader_id ? String(user.trader_id) : null;
      const newBRef = db.collection("trader_bindings").doc(tid);
      const newRefRef = db.collection("referrals").doc(tid);
      const reads = [tx.get(newBRef), tx.get(newRefRef)];
      if (curTid && curTid !== tid) reads.push(tx.get(db.collection("trader_bindings").doc(curTid)), tx.get(db.collection("referrals").doc(curTid)));
      const [nb, nr, ob, or] = await Promise.all(reads);

      // 1) Смена запрещена, если к текущему ID уже подтверждён первый депозит этого пользователя
      if (curTid) {
        const curRef = curTid === tid ? nr : or;
        const fd = curRef && curRef.exists ? firstDepositOf(curRef.data()) : null;
        const curReg = curRef && curRef.exists ? registrationOf(curRef.data()) : null;
        if (fd && fd.verified === true && curReg && curReg.verified === true && (!curReg.uid || curReg.uid === auth.uid) && (!fd.uid || fd.uid === auth.uid)) {
          if (curTid === tid) return;
          throw new ApiError("ID_LOCKED");
        }
      }
      // 2) Главная проверка: для этого Trader ID пришёл проверенный registration postback,
      //    и регистрация не принадлежит другому пользователю академии (если владелец известен по click_id)
      const reg = nr.exists ? registrationOf(nr.data()) : null;
      let owner = (reg && reg.uid) || null;
      if (reg && !owner && typeof reg.click_id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(reg.click_id)) {
        const c = await tx.get(db.collection("clicks").doc(reg.click_id));          // чтение до записей
        owner = c.exists ? c.data().uid : null;
      }
      const confirmedForMe = !!(reg && reg.verified === true && (!owner || owner === auth.uid));
      if (!confirmedForMe) throw new ApiError("TRADER_NOT_CONFIRMED"); // единый ответ: не раскрываем, существует ли ID
      if (curTid === tid && nb.exists && nb.data().uid === auth.uid) return; // уже привязан

      // 3) ID уже привязан другим аккаунтом: уступает только подтверждённому владельцу (reg.uid)
      if (nb.exists && nb.data().uid !== auth.uid) {
        if (owner !== auth.uid) throw new ApiError("TRADER_TAKEN");
        tx.set(db.collection("users").doc(nb.data().uid), { trader_id: null }, { merge: true });
      }
      if (curTid && curTid !== tid && ob && ob.exists && ob.data().uid === auth.uid) tx.delete(db.collection("trader_bindings").doc(curTid));
      tx.set(newBRef, { uid: auth.uid, bound_at: now() });
      if (u.exists) tx.update(userRef, { trader_id: tid, trader_bound_at: now() });
      else tx.create(userRef, { ...user, trader_id: tid, trader_bound_at: now() });
    });

    const { user, binding, referral, regOwner } = await loadState(auth.uid);
    const ev = evaluateAccess({ uid: auth.uid, user, binding, referral, regOwner });
    send(res, 200, profileBody(auth, user, ev));
    if (onAccessChange) Promise.resolve().then(() => onAccessChange(auth.uid)).catch(() => {});   // реферальное начисление (не блокирует ответ)
  });

  /* GET /check-deposit[?trader_id=…] — статус подтверждённого депозита по Trader ID ТЕКУЩЕГО пользователя.
     Требует вход. Ищет по Trader ID, привязанному к аккаунту; чужой trader_id → 403.
     Совместим со старым форматом { ok, amount }: ok = доступ открыт, amount = подтверждённый первый депозит. */
  const checkDeposit = wrap(async (req, res) => {
    const auth = await authenticate(req);
    const { user, binding, referral, regOwner } = await loadState(auth.uid);
    const ev = evaluateAccess({ uid: auth.uid, user, binding, referral, regOwner });
    const asked = req.query && typeof req.query.trader_id === "string" ? req.query.trader_id.trim() : "";
    if (asked && asked !== ev.traderId) throw new ApiError("TRADER_NOT_YOURS");
    res.set && res.set("Cache-Control", "no-store");
    send(res, 200, {
      ok: ev.academyAccess === true,
      amount: ev.firstDeposit ? ev.firstDeposit.amount : 0,                                 // первый депозит (прежний смысл поля)
      confirmedTotal: ev.depositProgress ? ev.depositProgress.confirmed_cents / 100 : 0,   // подтверждённая СУММА депозитов (USD)
      progress: ev.depositProgress,
      state: ev.depositState,
      stage: ev.stage,
      traderId: ev.traderId,
      traderIdLocked: ev.traderIdLocked,
      brokerRegistrationConfirmed: ev.brokerRegistrationConfirmed,
      firstDeposit: ev.firstDeposit,
      deposits: ev.deposits,
      academyAccess: ev.academyAccess
    });
  });

  /* GET /check[?trader_id=…] — подтверждена ли регистрация Trader ID текущего пользователя (с входом). */
  const check = wrap(async (req, res) => {
    const auth = await authenticate(req);
    const { user, binding, referral, regOwner } = await loadState(auth.uid);
    const ev = evaluateAccess({ uid: auth.uid, user, binding, referral, regOwner });
    const asked = req.query && typeof req.query.trader_id === "string" ? req.query.trader_id.trim() : "";
    if (asked && asked !== ev.traderId) throw new ApiError("TRADER_NOT_YOURS");
    send(res, 200, { ok: ev.brokerRegistrationConfirmed === true, trader_id: ev.traderId });
  });

  /* Для других модулей (обучение): состояние доступа пользователя, вычисленное сервером */
  async function stateFor(uid, pre) {
    const { user, binding, referral, regOwner } = await loadState(uid, pre);
    return { user, ev: evaluateAccess({ uid, user, binding, referral, regOwner }) };
  }

  const setLang = wrap(async (req, res) => {
    const auth = await authenticate(req); const l = req.body && req.body.lang;
    if (!["ru", "en", "ua"].includes(l)) throw new ApiError("INVALID_LANG");
    await db.collection("users").doc(auth.uid).set({ lang: l, lang_updated_at: now() }, { merge: true });
    send(res, 200, { ok: true, lang: l });
  });
  return { me, click, traderId, checkDeposit, check, authenticate, stateFor, wrap, setLang };
}

/* Подключение к Express: маршруты под /api/ (до общей статики и обработчика ошибок) */
function mountAcademyApi(app, express, deps, extend) {
  const api = createAcademyApi(deps);
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));
  // Server-Timing: время обработки запроса сервером (видно в DevTools → Network → Timing). Без данных пользователя.
  router.use((req, res, next) => { const t0 = Date.now(), j = res.json.bind(res); res.json = b => { try { res.set("Server-Timing", `app;dur=${Date.now() - t0}`); } catch (e) {} return j(b); }; next(); });
  router.get("/me", api.me);
  router.post("/click", api.click);
  router.post("/trader-id", api.traderId);
  // Язык интерфейса сохраняется в профиле: выбор переживает повторный вход и смену устройства
  router.post("/lang", api.setLang);
  if (extend) extend(router, api); // дополнительные маршруты /api/* (обучение) — до заглушки 404
  router.use((req, res) => send(res, 404, { error: "NOT_FOUND" }));
  app.use("/api", router);
  // Проверка депозита по Trader ID (замена старых публичных /check и /check-deposit — теперь с входом)
  app.get("/check-deposit", api.checkDeposit);
  app.get("/check", api.check);
  return api;
}

module.exports = { createAcademyApi, mountAcademyApi, ApiError };
