/* Страница заблокированного аккаунта: RU / EN / UA. Внутренняя причина блокировки не показывается.
   «Создать новый аккаунт» — выход из заблокированного аккаунта и существующий экран регистрации (index.html#register). */
(function () {
  "use strict";
  const T = {
    ru: { title: "Ваш аккаунт не активен", text: "Доступ к академии для этого аккаунта приостановлен. Чтобы восстановить доступ, обратитесь в поддержку или создайте новый аккаунт.", support: "Обратиться в поддержку", create: "Создать новый аккаунт" },
    en: { title: "Your account is inactive", text: "Access to the academy has been suspended for this account. To restore access, contact support or create a new account.", support: "Contact Support", create: "Create a New Account" },
    ua: { title: "Ваш акаунт неактивний", text: "Доступ до академії для цього акаунта призупинено. Щоб відновити доступ, зверніться до служби підтримки або створіть новий акаунт.", support: "Звернутися до підтримки", create: "Створити новий акаунт" }
  };
  let lang = "ru"; try { const x = localStorage.getItem("hd_lang"); if (T[x]) lang = x; } catch (e) {}
  function render() {
    const d = T[lang]; document.documentElement.lang = lang === "ua" ? "uk" : lang;
    document.getElementById("blT").textContent = d.title; document.getElementById("blP").textContent = d.text;
    document.getElementById("blSupport").textContent = d.support; document.getElementById("blNew").textContent = d.create;
    document.title = d.title + " — HIDDEN DINOX ACADEMY";
    document.querySelectorAll(".hd-langs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
  }
  document.querySelectorAll(".hd-langs button").forEach(b => (b.onclick = () => { lang = b.dataset.lang; try { localStorage.setItem("hd_lang", lang); } catch (e) {} render(); }));
  document.getElementById("blNew").onclick = async e => {
    e.currentTarget.disabled = true;
    try { await api.signOut(); } catch (x) {}                      // новый аккаунт регистрируется после выхода из заблокированного
    location.href = "/#register";
  };
  render();
})();
