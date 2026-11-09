/* Страница действий из писем Firebase (reset-password.html).
   Адрес этой страницы указывается в Firebase Console → Authentication → Templates → «Customize action URL»,
   поэтому сюда приходят ВСЕ ссылки из писем Firebase: сброс пароля, подтверждение и восстановление email.
   Используются только официальные функции Firebase Auth; код из ссылки не сохраняется и не логируется. */
const Q = new URLSearchParams(location.search);
const ACTION = { mode: Q.get("mode") || "", code: Q.get("oobCode") || "" };
(function () {                                   // язык письма Firebase (lang=ru/en/uk), если пользователь ещё не выбирал язык
  const l = (Q.get("lang") || "").toLowerCase(), m = l === "uk" ? "ua" : l;
  if (m && T[m] && !ls.get("hd_lang")) lang = m;
  // убрать код из адресной строки и истории (не попадёт в закладки, историю и Referer)
  try { if (location.search) history.replaceState(null, "", location.pathname); } catch (e) {}
})();
let state = { view: "checking", email: "", err: null };
const ok = (titleKey, textKey, vars) => `<div class="screen card"><div class="hero"><h1>${t(titleKey)}</h1><p class="sub">${t(textKey, vars)}</p></div>
  <a class="btn btn-primary" href="/" id="toLogin">${t("rpToLogin")}</a></div>`;
const VIEWS = {
  checking: () => `<div class="screen"><div class="hero"><h1>${t("rpTitle")}</h1><p class="sub">${t("rpChecking")}</p></div></div>`,
  form: () => `<div class="screen card"><div class="hero"><h1>${t("rpTitle")}</h1><p class="sub">${t("rpSub", { email: escH(state.email) })}</p></div>
    <form id="rpForm" novalidate>${notice()}${field("password", t("rpNew"), "password")}<div class="hint" style="margin-top:-8px">${t("hint")}</div>${field("password2", t("pass2"), "password")}${btn("rpBtn", t("rpBtn"))}</form>
    <div class="switch"><a class="link" href="/">${t("back")}</a></div></div>`,
  done: () => ok("rpDoneT", "rpDoneS"),
  verified: () => ok("veDoneT", "veDoneS"),
  recovered: () => ok("reDoneT", "reDoneS", { email: escH(state.email) }),
  bad: () => `<div class="screen card"><div class="hero"><h1>${t("rpBadT")}</h1><p class="sub" id="rpBadText">${escH(errMsg(state.err))}</p></div>
    ${state.err && state.err.code === "NETWORK" ? `<button type="button" class="btn btn-primary" id="rpRetry">${t("rpRetry")}</button>` : `<a class="btn btn-primary" href="/#reset" id="rpNewLink">${t("rpNewLink")}</a>`}
    <div class="switch"><a class="link" href="/">${t("back")}</a></div></div>`
};
function escH(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function render() {
  const keep = {}; ["password", "password2"].forEach(id => { if ($(id)) keep[id] = $(id).value; });
  $("main").innerHTML = VIEWS[state.view](); $("main").removeAttribute("aria-busy"); bindCommon($("main"));
  Object.entries(keep).forEach(([id, v]) => { if ($(id) && v) $(id).value = v; });
  bind(); applyStatic();
}
function show(view, extra) { Object.assign(state, { view }, extra || {}); render(); }
async function start() {
  if (!ACTION.code || !["resetPassword", "verifyEmail", "recoverEmail", "verifyAndChangeEmail"].includes(ACTION.mode)) return show("bad", { err: { code: "INVALID_LINK" } });
  show("checking");
  try {
    if (ACTION.mode === "resetPassword") { const email = await api.checkResetCode(ACTION.code); return show("form", { email }); }
    const email = await api.applyEmailAction(ACTION.code, ACTION.mode);
    return show(ACTION.mode === "recoverEmail" ? "recovered" : "verified", { email });
  } catch (e) { show("bad", { err: e && e.code ? e : { code: "GENERIC" } }); }
}
function bind() {
  const r = $("rpRetry"); if (r) r.onclick = start;
  const f = $("rpForm"); if (!f) return;
  f.onsubmit = async e => {
    e.preventDefault(); const pw = $("password").value, pw2 = $("password2").value; let good = true;
    if (!pw) { setErr("password", t("eReq"), 1); good = false; } else if (pw.length < CONFIG.minPassword) { setErr("password", t("ePass"), 1); good = false; }
    if (pw2 !== pw) { setErr("password2", t("ePass2"), 1); good = false; }
    if (!good) return; const b = $("rpBtn"); if (b.disabled) return; busy(b, true);
    try { await api.confirmReset(ACTION.code, pw); show("done"); }
    catch (err) {
      if (err && (err.code === "EXPIRED_LINK" || err.code === "INVALID_LINK" || err.code === "USER_DISABLED")) return show("bad", { err });
      showNotice(errMsg(err));                     // слабый пароль, нет сети и т. п. — остаёмся на форме, код не потерян
    } finally { if ($("rpBtn")) busy($("rpBtn"), false); }
  };
}
initTelegram && initTelegram(); initParticles && initParticles(); initLang(render); render(); start();
