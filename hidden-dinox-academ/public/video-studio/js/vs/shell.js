/* Оболочка: боковая навигация, верхняя панель (состояние системы и хранилища, уведомления, профиль), маршрутизация по адресу страницы, опрос заданий и состояния. */
(function () {
  "use strict";
  var VS = window.VS, $ = VS.$, esc = VS.esc, S = VS.State;
  var NAV = [["dashboard", "Обзор"], ["projects", "Проекты"], ["uploads", "Загрузки"], ["queue", "Очередь обработки"], ["clips", "Готовые клипы"], ["editors", "Монтажёры"], ["media", "Медиа"], ["history", "История"], ["analytics", "Аналитика"], ["settings", "Настройки"]];
  VS.go = function (p) { location.hash = "#/" + p; };
  function screen(html) { $("#app").innerHTML = html; }
  function notice(title, text, link) { screen('<div class="vs-center"><div class="vs-panel vs-narrow"><div class="vs-logo-line"><b>HIDDEN DINOX</b> <span>VIDEO STUDIO</span></div><h2>' + esc(title) + '</h2><p class="vs-muted">' + esc(text) + "</p>" + (link ? '<a class="vs-btn primary" href="' + link[1] + '">' + esc(link[0]) + "</a>" : "") + "</div></div>"); }
  /* Выход (самостоятельный сайт) и экран «доступ не открыт» */
  VS.logout = async function () { try { await VS.auth.fb.signOut(VS.auth.fb.auth); } catch (e) { /* уже вышли */ } location.replace("/"); };
  function pending(acc) {
    var p = acc.profile, who = esc(p.email || ""), t, x;
    if (p.blocked) { t = "Аккаунт заблокирован"; x = "Обратитесь к администратору сайта."; }
    else if (p.role === "editor") { t = "Вы — монтажёр"; x = "Задания приходят вам в Telegram. Кабинет монтажёра в браузере пока не подключён."; }
    else { t = "Ожидайте подтверждения"; x = "Аккаунт " + (p.email || "") + " создан. Администратор должен открыть вам доступ."; }
    screen('<div class="vs-center"><div class="vs-panel vs-narrow"><div class="vs-logo-line"><b>HIDDEN DINOX</b> <span>VIDEO STUDIO</span></div><h2>' + esc(t) + '</h2><p class="vs-muted">' + esc(x) + "</p>" + (acc.owner_setup_available ? '<p><a href="/setup">Я владелец сайта — выполнить первичную настройку</a></p>' : "") + '<button class="vs-btn" id="vs-out">Выйти</button></div></div>');
    $("#vs-out").onclick = VS.logout;
  }
  var HOME = function () { return ["Войти", "/"]; };
  VS.start = async function () {
    try { VS.auth.fb = await window.__vsFb; } catch (e) { return notice("Нет связи с Firebase", "Проверьте интернет и обновите страницу."); }
    if (!VS.auth.fb.auth.currentUser) { location.replace("/"); return; }
    {
      try { S.account = await VS.api("POST", "/account/session", {}); } catch (e) { if (e.status === 401) { location.replace("/"); return; } return notice("Не удалось запустить", VS.errText(e), HOME()); }
      if (!S.account.studio_access) return pending(S.account);
    }
    try { S.me = await VS.api("GET", "/me"); } catch (e) {
      if (e.status === 404) return notice("Video Studio отключена", "На сервере не задана переменная VIDEO_STUDIO_ENABLED=1.", HOME());
      if (e.status === 401) { location.replace("/"); return; }
      if (e.status === 403) return notice("Доступ запрещён", "Для этого аккаунта доступ к Video Studio не открыт.", HOME());
      return notice("Не удалось запустить", VS.errText(e), HOME());
    }
    S.general = Object.assign(S.general, S.me.general || {}); frame(); window.addEventListener("hashchange", route); VS.on("auth:expired", function () { VS.toast("Сессия истекла — войдите заново", "bad"); setTimeout(function () { location.replace("/"); }, 1500); });
    if (!location.hash || location.hash === "#") location.hash = "#/" + (S.general.start_view || "dashboard"); else route(); poll(); healthLoop();
  };
  function navItems() { var r = S.account && S.account.profile && S.account.profile.role; return (r === "admin" || r === "owner") ? NAV.concat([["users", "Пользователи"]]) : NAV; }
  function footLink() { return '<a href="#" id="vs-logout">' + VS.icon("back", 16) + " Выйти</a>"; }
  function frame() {
    document.title = S.general.studio_name; var initial = String((S.me.email || S.me.uid || "?")[0]).toUpperCase();
    screen('<div class="vs-app" data-density="' + esc(S.general.density) + '"><aside class="vs-side" id="vs-side"><a class="vs-brand" href="#/dashboard"><span class="vs-mark">H</span><span><b>HIDDEN DINOX</b><i id="vs-studio-name">' + esc(S.general.studio_name) + '</i></span></a><nav class="vs-nav" aria-label="Разделы">' +
      navItems().map(function (n) { return '<a href="#/' + n[0] + '" data-nav="' + n[0] + '">' + VS.icon(n[0] === "users" ? "editors" : n[0]) + "<span>" + n[1] + '</span><em class="vs-nav-n" data-nav-n="' + n[0] + '"></em></a>'; }).join("") + '</nav><div class="vs-side-f">' + footLink() + '<span>Video Studio ' + VS.version + '</span></div></aside><div class="vs-scrim" id="vs-scrim"></div>' +
      '<div class="vs-main"><header class="vs-topbar"><button class="vs-icon-btn vs-burger" id="vs-burger" aria-label="Меню">' + VS.icon("menu") + '</button><h1 id="vs-title">Video Studio</h1><div class="vs-pills" id="vs-pills"></div><div class="vs-top-r"><div class="vs-notes-wrap"><button class="vs-icon-btn" id="vs-bell" aria-label="Уведомления">' + VS.icon("bell") + '<i class="vs-dot-n" id="vs-bell-n" hidden></i></button><div class="vs-notes" id="vs-notes" hidden></div></div><a class="vs-profile" href="#/settings/security" title="' + esc(S.me.email || S.me.uid) + '"><span class="vs-avatar">' + esc(initial) + '</span><span class="vs-profile-t"><b>' + esc(S.me.email || S.me.uid) + "</b><i>" + esc(S.me.role) + '</i></span></a></div></header><main class="vs-content" id="vs-view" tabindex="-1"></main></div></div>');
    if ($("#vs-logout")) $("#vs-logout").onclick = function (e) { e.preventDefault(); VS.logout(); };
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
  function parse() { var p = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent); if (p[0] === "templates") return { view: "settings", args: ["templates"] }; return { view: p[0] || S.general.start_view || "dashboard", args: p.slice(1) }; }
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
    var T = VS.statusLabels.jobType[j.type] || j.type, link = j.type === "telegram" ? "#/history" : (j.type === "render" || j.type === "analyze" || j.type === "tg_send") ? "#/clips" : j.type === "probe" && j.project_id ? "#/projects/" + j.project_id : "#/queue";
    if (j.auto && j.status === "succeeded") return;                 // автосборка клипов после нарезки идёт тихо: итог виден в «Готовых клипах»
    if (j.status === "succeeded") VS.notify(({ probe: "Видео проверено — откройте проект и нажмите «Начать нарезку»", analyze: "Нарезка завершена — клипы в разделе «Готовые клипы»", render: "Видео собрано — можно скачать или отправить", telegram: "Ролик доставлен в Telegram", tg_send: "Клип доставлен в Telegram", preview: "Точный предпросмотр готов", window: "Окно предпросмотра обновлено" })[j.type] || T + ": готово", "ok", link);
    else if (j.status === "failed") VS.notify(T + ": ошибка — " + (j.error ? j.error.message : "неизвестная"), "bad", "#/queue"); else VS.notify(T + ": отменено", "warn", "#/queue");
  }
  /* Опрос заданий: ведёт ОДНА видимая вкладка (лидер), остальные получают те же данные через localStorage (событие storage); скрытая вкладка не опрашивает;
     лидер освобождает роль при скрытии/закрытии; при ошибках пауза нарастает (и учитывает Retry-After сервера), а не повторяется каждые 2,5 с. */
  var TAB = Math.random().toString(36).slice(2), LKEY = "hdvs_leader", JKEY = "hdvs_jobs", HKEY = "hdvs_health", errN = 0, retryAt = 0, lastJ = 0;
  function visible() { return !document.hidden; }
  function ls(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || "null"); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  /* роль лидера берётся, если лидера нет, он молчит или его данные давно не обновлялись; устаревшие данные из localStorage не показываются */
  function lead() { if (!visible()) return false; var l = ls(LKEY), j = ls(JKEY), t = Date.now(); if (!l || t - l.t > 20000 || l.id === TAB || (j && t - j.t > 45000)) { ls(LKEY, { id: TAB, t: t }); var c = ls(LKEY); return !c || c.id === TAB; } return false; }
  function release() { var l = ls(LKEY); if (l && l.id === TAB) { try { localStorage.removeItem(LKEY); } catch (e) { /* нет доступа */ } } }
  function applyJobs(jobs) { var changed = false; S.jobs = jobs; if (prev) jobs.forEach(function (j) { var p = prev[j.id]; if (p && VS.isActive(p) && !VS.isActive(j)) { changed = true; jobDone(j); } }); prev = {}; jobs.forEach(function (j) { prev[j.id] = j; }); VS.emit("jobs", { changed: changed, jobs: jobs }); schedule(); }
  /* Опрос в два уровня: обычно запрашиваются только АКТИВНЫЕ задания (1 чтение в простое); полный список — при старте, при появлении нового и при завершении задания (оно исчезло из активных) */
  VS.pollNow = async function (full) {
    try {
      if (!full && S.jobs.length) {
        var act = (await VS.api("GET", "/jobs?active=1")).jobs, was = S.jobs.filter(VS.isActive), ids = {}, byId = {}; act.forEach(function (j) { ids[j.id] = 1; byId[j.id] = j; });
        if (was.some(function (j) { return !ids[j.id]; }) || act.some(function (j) { return !prev || !prev[j.id]; })) return VS.pollNow(true);
        var merged = S.jobs.map(function (j) { return byId[j.id] || j; }); errN = 0; retryAt = 0; lastJ = Date.now(); ls(JKEY, { t: lastJ, by: TAB, jobs: merged }); applyJobs(merged); return;
      }
      var jobs = (await VS.api("GET", "/jobs")).jobs; errN = 0; retryAt = 0; lastJ = Date.now(); ls(JKEY, { t: lastJ, by: TAB, jobs: jobs }); applyJobs(jobs);
    } catch (e) { if (window.console && !(e && e.status)) console.error("Video Studio: опрос заданий:", e); errN++; retryAt = Date.now() + Math.min(60000, ((e && e.retry_after) || 0) * 1000 || 4000 * Math.pow(2, errN)); schedule(); } };
  function fromLeader() { var j = ls(JKEY); if (j && j.jobs && j.t > lastJ && j.by !== TAB && Date.now() - j.t < 15000) { lastJ = j.t; applyJobs(j.jobs); } }
  window.addEventListener("storage", function (e) { if (e.key === JKEY && e.newValue) fromLeader(); else if (e.key === HKEY && e.newValue) { try { S.health = JSON.parse(e.newValue).h; VS.emit("health", S.health); } catch (x) { /* битые данные */ } } });
  setInterval(function () { if (visible()) lead(); }, 5000);                      // лидер подтверждает роль без обращений к серверу
  document.addEventListener("visibilitychange", function () { if (visible()) { fromLeader(); poll(); } else release(); }); window.addEventListener("beforeunload", release);
  /* интервал выбирается по ТЕКУЩЕМУ состоянию и пересчитывается при каждом получении данных (в том числе после действия пользователя), иначе начало работы ждало бы старую паузу простоя */
  function schedule() { clearTimeout(timer); var d = S.jobs.some(VS.isActive) ? 4000 : 30000; if (Date.now() < retryAt) d = Math.max(d, retryAt - Date.now()); timer = setTimeout(poll, visible() ? d : 15000); }
  var firstPoll = true;
  function poll() { clearTimeout(timer); fromLeader(); var first = firstPoll; firstPoll = false; var go = first ? VS.pollNow(true) : (lead() && Date.now() >= retryAt ? VS.pollNow() : Promise.resolve()); go.then(schedule); }   // при открытии страницы вкладка всегда делает собственный запрос: состояние не берётся «из прошлого»
  VS.refreshHealth = async function () { try { S.health = await VS.api("GET", "/health"); ls(HKEY, { t: Date.now(), h: S.health }); } catch (e) { S.health = S.health || null; } VS.emit("health", S.health); };
  function healthLoop() { (lead() && Date.now() >= retryAt ? VS.refreshHealth() : Promise.resolve()).then(function () { setTimeout(healthLoop, 60000); }); }
  VS.setStudio = function (g) { Object.assign(S.general, g); var a = $(".vs-app"); if (a) a.dataset.density = S.general.density; var n = $("#vs-studio-name"); if (n) n.textContent = S.general.studio_name; document.title = S.general.studio_name; };
})();
