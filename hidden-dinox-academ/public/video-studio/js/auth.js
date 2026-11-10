/* Страницы входа, регистрации, восстановления пароля и первичной настройки. Используют Firebase Authentication ТОЛЬКО того проекта, который задан на сервере (FIREBASE_WEB_CONFIG). */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
const $ = s => document.querySelector(s), page = document.body.dataset.page;
const msg = (t, bad) => { const m = $("#msg"); m.textContent = t || ""; m.className = "msg " + (bad ? "bad" : "ok"); m.hidden = !t; };
const ERR = { "auth/invalid-credential": "Неверный email или пароль", "auth/wrong-password": "Неверный email или пароль", "auth/user-not-found": "Неверный email или пароль", "auth/invalid-email": "Некорректный email", "auth/email-already-in-use": "Этот email уже зарегистрирован — войдите или восстановите пароль", "auth/weak-password": "Пароль слишком простой (минимум 8 символов)", "auth/too-many-requests": "Слишком много попыток. Подождите несколько минут", "auth/network-request-failed": "Нет связи. Проверьте интернет и повторите", "auth/user-disabled": "Аккаунт отключён" };
const human = e => ERR[e && e.code] || "Не получилось. Повторите попытку позже";
const cfg = window.VS_FIREBASE_CONFIG;
if (!cfg) { msg("Вход временно недоступен: сервер не настроен." + (window.VS_CONFIG_ERROR ? " " + window.VS_CONFIG_ERROR : ""), true); throw new Error("no firebase config"); }
const auth = getAuth(initializeApp(cfg));
const api = async (user, path, body) => { const t = await user.getIdToken(); const r = await fetch("/api/video-studio" + path, { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }); const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.message || "Ошибка " + r.status); e.code = j.error; throw e; } return j; };
const busy = on => { const b = $("#go"); if (b) b.disabled = on; };
const done = () => { location.replace("/app"); };
const ready = new Promise(r => { const off = onAuthStateChanged(auth, u => { off(); r(u); }); });
async function run() {
  const form = $("#f"), user = await ready;
  if (page === "setup") { if (!user) return location.replace("/"); }
  else if (user && (page === "login" || page === "register")) return done();
  form.addEventListener("submit", async ev => {
    ev.preventDefault(); msg(""); const email = ($("#email") || {}).value ? $("#email").value.trim() : "", pass = ($("#pass") || {}).value || "";
    try {
      busy(true);
      if (page === "login") { if (!email || !pass) throw { code: "x", message: "Введите email и пароль" }; const c = await signInWithEmailAndPassword(auth, email, pass); await api(c.user, "/account/session"); done(); }
      else if (page === "register") { if (!/^\S+@\S+\.\S+$/.test(email)) return msg("Введите корректный email", true); if (pass.length < 8) return msg("Пароль — минимум 8 символов", true); if (pass !== $("#pass2").value) return msg("Пароли не совпадают", true); const c = await createUserWithEmailAndPassword(auth, email, pass); await api(c.user, "/account/session"); done(); }
      else if (page === "forgot") { if (!/^\S+@\S+\.\S+$/.test(email)) return msg("Введите корректный email", true); try { await sendPasswordResetEmail(auth, email); } catch (e) { if (e && e.code !== "auth/user-not-found") throw e; } msg("Если такой адрес зарегистрирован, письмо со ссылкой отправлено. Проверьте почту (и папку «Спам»).", false); }
      else if (page === "setup") { const t = $("#token").value; if (!t) return msg("Введите код настройки", true); await api(auth.currentUser, "/account/claim-owner", { token: t }); done(); }
    } catch (e) { msg(e && e.code && String(e.code).startsWith("auth/") ? human(e) : (e && e.message) || human(e), true); }
    finally { busy(false); }
  });
}
run();
