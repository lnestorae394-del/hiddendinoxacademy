/* HIDDEN DINOX ACADEMY — связь с Firebase Authentication и сервером.

   Источник истины — сервер (/api/*). Клиент ничего не решает о доступе:
   этап, статусы и сумма приходят только в ответе сервера, проверенном по ID-токену.

   Коды ошибок для интерфейса: EMAIL_EXISTS, BAD_CREDENTIALS, WEAK_PASSWORD, INVALID_EMAIL,
   TOO_MANY, NETWORK, UNAUTHENTICATED, TRADER_TAKEN, ID_LOCKED, INVALID, UNAVAILABLE, GENERIC. */

const fbReady = new Promise((resolve, reject) => {
  window.__hdFbResolve = resolve;
  window.__hdFbReject = reject;
  setTimeout(() => reject({ code: "NETWORK" }), 15000); // Firebase не загрузился — не ждём бесконечно
});
fbReady.catch(() => {});

function fbError(e) {
  const c = (e && e.code) || "";
  if (c === "auth/email-already-in-use") return { code: "EMAIL_EXISTS" };
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-login-credentials"].includes(c)) return { code: "BAD_CREDENTIALS" };
  if (c === "auth/weak-password") return { code: "WEAK_PASSWORD" };
  if (c === "auth/invalid-email") return { code: "INVALID_EMAIL" };
  if (c === "auth/too-many-requests") return { code: "TOO_MANY" };
  if (c === "auth/network-request-failed") return { code: "NETWORK" };
  if (c === "auth/expired-action-code") return { code: "EXPIRED_LINK" };          // ссылка из письма просрочена
  if (c === "auth/invalid-action-code") return { code: "INVALID_LINK" };          // уже использована или повреждена
  if (c === "auth/user-disabled") return { code: "USER_DISABLED" };
  if (c && !c.startsWith("auth/")) return { code: c };
  return { code: "GENERIC" };
}

async function fb() { return fbReady; }

async function idToken() {
  const f = await fb();
  const u = f.auth.currentUser;
  if (!u) throw { code: "UNAUTHENTICATED" };
  try { return await u.getIdToken(); } catch (e) { throw fbError(e); }
}

async function call(method, path, body) {
  const token = await idToken();
  let r;
  try {
    r = await fetch(CONFIG.apiBase + path, {
      method, cache: "no-store", credentials: "same-origin",
      headers: Object.assign({ Authorization: "Bearer " + token }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) { throw { code: "NETWORK" }; }
  let j = null;
  try { j = await r.json(); } catch (e) {}
  const code = (j && typeof j.error === "string" && j.error) || "UNAVAILABLE";
  // Аккаунт заблокирован (сервер проверяет при каждом запросе) — отдельная страница на языке пользователя
  if (!r.ok && code === "ACCOUNT_BLOCKED" && !/blocked\.html$/.test(location.pathname)) { location.replace("blocked.html"); }
  if (!r.ok) throw { code };
  if (!j || typeof j !== "object") throw { code: "UNAVAILABLE" };
  return j;
}

const api = {
  async signUp(email, password) {
    const f = await fb();
    try { await f.createUserWithEmailAndPassword(f.auth, email, password); } catch (e) { throw fbError(e); }
    return call("GET", "/api/me");
  },
  async signIn(email, password) {
    const f = await fb();
    try { await f.signInWithEmailAndPassword(f.auth, email, password); } catch (e) { throw fbError(e); }
  },
  async signOut() {
    try { const f = await fb(); await f.signOut(f.auth); } catch (e) {}
  },
  /* Восстановление пароля: письмо Hidden Dinox Academy отправляет наш сервер (POST /api/auth/forgot-password,
     ссылку создаёт Firebase Admin SDK). Ответ одинаковый для любых адресов — существование аккаунта не раскрывается.
     Если на сервере почта ещё не настроена (503 MAIL_NOT_CONFIGURED) или маршрута нет (404) — прежнее письмо Firebase. */
  async resetPassword(email) {
    let r = null;
    try {
      r = await fetch(CONFIG.apiBase + "/api/auth/forgot-password", { method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, lang }) });
    } catch (e) { throw { code: "NETWORK" }; }
    if (r.ok) return true;
    let code = null; try { const j = await r.json(); code = j && j.error; } catch (e) {}
    if (r.status === 400) throw { code: "INVALID_EMAIL" };
    if (r.status === 429) throw { code: "TOO_MANY" };
    if (!(r.status === 503 && code === "MAIL_NOT_CONFIGURED") && r.status !== 404) throw { code: "UNAVAILABLE" };
    return this.resetPasswordViaFirebase(email);
  },
  async resetPasswordViaFirebase(email) {
    const f = await fb();
    f.auth.languageCode = lang === "ua" ? "uk" : lang;
    const settings = { url: location.origin + "/" };
    try {
      try { await f.sendPasswordResetEmail(f.auth, email, settings); }
      catch (e1) { if (/continue-uri|unauthorized-domain/.test((e1 && e1.code) || "")) await f.sendPasswordResetEmail(f.auth, email); else throw e1; }
    }
    catch (e) {
      const m = fbError(e);
      if (m.code === "BAD_CREDENTIALS") return true; // не раскрываем, есть ли такой email
      throw m;
    }
    return true;
  },
  /* Страница сброса пароля (reset-password.html): только официальные функции Firebase Auth.
     Код из ссылки не сохраняется и не логируется; проверку и смену пароля выполняет Firebase. */
  async checkResetCode(code) { const f = await fb(); try { return await f.verifyPasswordResetCode(f.auth, code); } catch (e) { throw fbError(e); } },
  async confirmReset(code, password) { const f = await fb(); try { await f.confirmPasswordReset(f.auth, code, password); return true; } catch (e) { throw fbError(e); } },
  async applyEmailAction(code, mode) {
    const f = await fb();
    try { if (mode === "recoverEmail") { const i = await f.checkActionCode(f.auth, code); await f.applyActionCode(f.auth, code); return (i && i.data && i.data.email) || ""; }
          await f.applyActionCode(f.auth, code); return ""; }
    catch (e) { throw fbError(e); }
  },
  getProfile() { return call("GET", "/api/me"); },
  async getClickId() { const j = await call("POST", "/api/click"); if (!j.clickId) throw { code: "UNAVAILABLE" }; return j.clickId; },
  submitTraderId(traderId) { return call("POST", "/api/trader-id", { traderId }); },
  /* Статус депозита — по Trader ID текущего пользователя (сервер берёт ID из привязки к аккаунту) */
  async getDepositStatus() {
    const p = await call("GET", "/check-deposit");
    return { state: p.state, brokerRegistrationConfirmed: p.brokerRegistrationConfirmed === true,
      firstDeposit: p.firstDeposit || null, academyAccess: p.academyAccess === true, traderId: p.traderId,
      traderIdLocked: p.traderIdLocked === true, stage: p.stage,
      progress: p.progress || null, confirmedTotal: typeof p.confirmedTotal === "number" ? p.confirmedTotal : null };   // сумма подтверждённых депозитов
  }
};
