/* Оболочка: боковая навигация, верхняя панель (состояние системы и хранилища, уведомления, профиль), маршрутизация по адресу страницы, опрос заданий и состояния. */
(function () {
  "use strict";
  var VS = window.VS, $ = VS.$, esc = VS.esc, S = VS.State;
  var NAV = [["dashboard", "Обзор"], ["projects", "Проекты"], ["uploads", "Загрузки"], ["queue", "Очередь"], ["templates", "Шаблоны"], ["media", "Медиатека"], ["history", "История"], ["analytics", "Аналитика"], ["settings", "Настройки"]];
  VS.go = function (p) { location.hash = "#/" + p; };
  function screen(html) { $("#app").innerHTML = html; }
  function notice(title, text, link) { screen('<div class="vs-center"><div class="vs-panel vs-narrow"><div class="vs-logo-line"><b>HIDDEN DINOX</b> <span>VIDEO STUDIO</span></div><h2>' + esc(title) + '</h2><p class="vs-muted">' + esc(text) + "</p>" + (link ? '<a class="vs-btn primary" href="' + link[1] + '">' + esc(link[0]) + "</a>" : "") + "</div></div>"); }
  VS.start = async function () {
    try { VS.auth.fb = await window.__vsFb; } catch (e) { return notice("Нет связи с Firebase", "Проверьте интернет и обновите страницу."); }
    if (!VS.auth.fb.auth.currentUser) return notice("Нужен вход", "Video Studio использует ту же сессию, что и админ-панель Academy.", ["Открыть админ-панель", "/admin/"]);
    try { S.me = await VS.api("GET", "/me"); } catch (e) {
      if (e.status === 404) return notice("Video Studio отключена", "На сервере не задана переменная VIDEO_STUDIO_ENABLED=1.", ["В админ-панель", "/admin/"]);
      if (e.status === 401) return notice("Сессия истекла", "Войдите в админ-панель заново.", ["Открыть админ-панель", "/admin/"]);
      if (e.status === 403) return notice("Доступ запрещён", "Video Studio доступна только администраторам (admin, super_admin).", ["В админ-панель", "/admin/"]);
      return notice("Не удалось запустить", VS.errText(e), ["В админ-панель", "/admin/"]);
    }
    S.general = Object.assign(S.general, S.me.general || {}); frame(); window.addEventListener("hashchange", route); VS.on("auth:expired", function () { VS.toast("Сессия истекла — откройте админ-панель и войдите заново", "bad"); });
    if (!location.hash || location.hash === "#") location.hash = "#/" + (S.general.start_view || "dashboard"); else route(); poll(); healthLoop();
  };
  function frame() {
    document.title = S.general.studio_name; var initial = String((S.me.email || S.me.uid || "?")[0]).toUpperCase();
    screen('<div class="vs-app" data-density="' + esc(S.general.density) + '"><aside class="vs-side" id="vs-side"><a class="vs-brand" href="#/dashboard"><span class="vs-mark">H</span><span><b>HIDDEN DINOX</b><i id="vs-studio-name">' + esc(S.general.studio_name) + '</i></span></a><nav class="vs-nav" aria-label="Разделы">' +
      NAV.map(function (n) { return '<a href="#/' + n[0] + '" data-nav="' + n[0] + '">' + VS.icon(n[0]) + "<span>" + n[1] + '</span><em class="vs-nav-n" data-nav-n="' + n[0] + '"></em></a>'; }).join("") + '</nav><div class="vs-side-f"><a href="/admin/">' + VS.icon("back", 16) + ' Админ-панель Academy</a><span>Video Studio ' + VS.version + '</span></div></aside><div class="vs-scrim" id="vs-scrim"></div>' +
      '<div class="vs-main"><header class="vs-topbar"><button class="vs-icon-btn vs-burger" id="vs-burger" aria-label="Меню">' + VS.icon("menu") + '</button><h1 id="vs-title">Video Studio</h1><div class="vs-pills" id="vs-pills"></div><div class="vs-top-r"><div class="vs-notes-wrap"><button class="vs-icon-btn" id="vs-bell" aria-label="Уведомления">' + VS.icon("bell") + '<i class="vs-dot-n" id="vs-bell-n" hidden></i></button><div class="vs-notes" id="vs-notes" hidden></div></div><a class="vs-profile" href="#/settings/security" title="' + esc(S.me.email || S.me.uid) + '"><span class="vs-avatar">' + esc(initial) + '</span><span class="vs-profile-t"><b>' + esc(S.me.email || S.me.uid) + "</b><i>" + esc(S.me.role) + '</i></span></a></div></header><main class="vs-content" id="vs-view" tabindex="-1"></main></div></div>');
    $("#vs-burger").onclick = function () { $(".vs-app").classList.toggle("open"); }; $("#vs-scrim").onclick = function () { $(".vs-app").classList.remove("open"); };
    $("#vs-bell").onclick = function (e) { e.stopPropagation(); var n = $("#vs-notes"); n.hidden = !n.hidden; VS.unread = 0; renderBell(); }; document.addEventListener("click", function (e) { var n = $("#vs-notes"); if (n && !n.hidden && !e.target.closest(".vs-notes-wrap")) n.hidden = true; });
    VS.on("notes", renderBell); VS.on("health", renderPills); VS.on("jobs", function () { renderPills(); navBadges(); }); renderPills(); renderBell();
  }
  function renderBell() {
    var b = $("#vs-bell-n"), n = $("#vs-notes"); if (b) { b.hidden = !VS.unread; b.textContent = VS.unread > 9 ? "9+" : VS.unread; }
    if (n) n.innerHTML = '<div class="vs-notes-h"><b>Уведомления</b>' + (S.notes.length ? '<button class="vs-link" id="vs-notes-clear">Очистить</button>' : "") + "</div>" + (S.notes.length ? S.notes.map(function (x) { return '<div class="vs-note ' + esc(x.kind) + '"><span class="vs-muted vs-small">' + VS.ago(x.t) + "</span><div>" + esc(x.text) + "</div>" + (x.link ? '<a href="' + esc(x.link) + '">Открыть</a>' : "") + "</div>"; }).join("") : '<div class="vs-empty-s">Пока нет уведомлений</div>');
    var c = $("#vs-notes-clear"); if (c) c.onclick = function () { S.notes = []; try { localStorage.removeItem("hdvs_notes_v2"); } catch (e) { /* нет доступа */ } renderBell(); };
  }
  function pill(kind, text, href, title) { return '<a class="vs-pill ' + kind + '" href="' + href + '" title="' + esc(title || "") + '"><i></i>' + esc(text) + "</a>"; }
  function renderPills() {
    var h = S.health, el = $("#vs-pills"); if (!el) return; var out = [], act = S.jobs.filter(VS.isActive).length;
    if (!h) out.push(pill("", "Проверяю систему…", "#/settings/diagnostics"));
    else {
      var st = h.storage || {}, kind = st.kind === "r2" ? "R2" : (st.kind || "Хранилище");
      out.push(st.ok === true ? pill("ok", kind + " подключено", "#/settings/storage", "Хранилище видео работает") : st.ok === false ? pill("bad", kind + ": ошибка", "#/settings/storage", st.message || "") : pill("warn", kind + ": не проверено", "#/settings/storage"));
      var sys = h.ffmpeg && h.ffmpeg.ok && h.ffmpeg.ass && h.keys && h.keys.groq && h.keys.claude; out.push(sys ? pill("ok", "Система в норме", "#/settings/diagnostics") : pill("warn", "Нужна настройка", "#/settings/diagnostics", "Не все компоненты готовы"));
    }
    if (act) out.push(pill("run", "Обработка: " + act, "#/queue")); el.innerHTML = out.join("");
  }
  function navBadges() { var n = S.jobs.filter(VS.isActive).length; VS.$$("[data-nav-n]").forEach(function (e) { e.textContent = e.dataset.navN === "queue" && n ? n : ""; e.style.display = e.textContent ? "" : "none"; }); }
  function parse() { var p = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent); return { view: p[0] || S.general.start_view || "dashboard", args: p.slice(1) }; }
  function route() {
    var r = parse(), v = VS.views[r.view], el = $("#vs-view"); if (!el) return;
    if (VS.current && VS.current.unmount) { try { VS.current.unmount(); } catch (e) { console.error(e); } } VS.current = null; el.innerHTML = ""; $(".vs-app").classList.remove("open");
    VS.$$("[data-nav]").forEach(function (a) { a.classList.toggle("on", a.dataset.nav === r.view); });
    if (!v) { $("#vs-title").textContent = "Раздел не найден"; el.innerHTML = '<div class="vs-errbox"><b>Такого раздела нет.</b> <a href="#/dashboard">На главную</a></div>'; return; }
    $("#vs-title").textContent = v.title; VS.current = v; window.scrollTo(0, 0);
    try { v.mount(el, r.args); } catch (e) { console.error(e); el.innerHTML = '<div class="vs-errbox"><div class="vs-errbox-h">' + VS.icon("alert") + "<b>Раздел не открылся</b></div><p>" + esc(e.message) + '</p><button class="vs-btn" onclick="location.reload()">Обновить страницу</button></div>'; }
  }
  /* ---------- опрос заданий и состояния системы ---------- */
  var prev = null, timer = 0;
  function jobDone(j) {
    var T = VS.statusLabels.jobType[j.type] || j.type, link = j.type === "telegram" || j.type === "render" ? "#/history" : "#/queue";
    if (j.status === "succeeded") VS.notify(({ probe: "Видео проверено — можно запускать анализ", analyze: "Анализ завершён — клипы готовы к просмотру", render: "Видео собрано — можно скачать или отправить", telegram: "Ролик доставлен в Telegram", preview: "Точный предпросмотр готов", window: "Окно предпросмотра обновлено" })[j.type] || T + ": готово", "ok", link);
    else if (j.status === "failed") VS.notify(T + ": ошибка — " + (j.error ? j.error.message : "неизвестная"), "bad", "#/queue"); else VS.notify(T + ": отменено", "warn", "#/queue");
  }
  VS.pollNow = async function () {
    try {
      var jobs = (await VS.api("GET", "/jobs")).jobs, changed = false; S.jobs = jobs; if (prev) jobs.forEach(function (j) { var p = prev[j.id]; if (p && VS.isActive(p) && !VS.isActive(j)) { changed = true; jobDone(j); } });
      prev = {}; jobs.forEach(function (j) { prev[j.id] = j; }); VS.emit("jobs", { changed: changed, jobs: jobs });
    } catch (e) { /* временный сбой сети: повторим позже */ }
  };
  function poll() { clearTimeout(timer); VS.pollNow().then(function () { timer = setTimeout(poll, S.jobs.some(VS.isActive) ? 2500 : 8000); }); }
  VS.refreshHealth = async function () { try { S.health = await VS.api("GET", "/health"); } catch (e) { S.health = S.health || null; } VS.emit("health", S.health); };
  function healthLoop() { VS.refreshHealth().then(function () { setTimeout(healthLoop, 30000); }); }
  VS.setStudio = function (g) { Object.assign(S.general, g); var a = $(".vs-app"); if (a) a.dataset.density = S.general.density; var n = $("#vs-studio-name"); if (n) n.textContent = S.general.studio_name; document.title = S.general.studio_name; };
})();
