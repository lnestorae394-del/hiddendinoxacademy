/* HIDDEN DINOX ACADEMY — админ-панель (без сборки, без зависимостей).
   Все права проверяет сервер (/admin/api). Интерфейс только скрывает недоступные разделы.
   Пользовательские данные выводятся через esc() — HTML из базы не выполняется. */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const esc = window.HDLesson.esc;
  const main = $("#main"), titleEl = $("#title"), app = $("#app");
  let ME = null;
  let SEQ = 0;   // номер текущего перехода: ответы на чтение для покинутой страницы отбрасываются

  /* ---------- Служебное ---------- */
  let toastT;
  function toast(msg, bad) { const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (bad ? " bad" : ""); clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 3600); }
  const fmtDate = t => (t ? new Date(t).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
  const fmtDay = t => (t ? new Date(t).toLocaleDateString("ru-RU") : "—");
  const kb = n => (n > 1048576 ? (n / 1048576).toFixed(1) + " МБ" : Math.max(1, Math.round(n / 1024)) + " КБ");
  const can = p => !!(ME && ME.permissions.includes(p));
  const ERR = { UNAUTHENTICATED: "Сессия истекла — войдите снова", FORBIDDEN: "Недостаточно прав для этого действия", NOT_FOUND: "Не найдено", TOO_MANY: "Слишком много запросов — подождите минуту",
    CONFIRM_REQUIRED: "Нужно явное подтверждение", UNAVAILABLE: "Временная ошибка сервера — повторите", CONFIG_MISSING: "Сервер не подключён к Firebase", NETWORK: "Нет связи с сервером", BLOCKED: "Аккаунт заблокирован" };
  const errText = e => (e && (e.message && e.error !== "UNAVAILABLE" ? e.message : ERR[e.error] || ERR[e.code])) || "Не удалось выполнить действие";

  async function api(method, path, body, opts = {}) {
    const seq = SEQ;
    const token = await idToken();
    const headers = { Authorization: "Bearer " + token };
    let payload;
    if (opts.raw) { payload = opts.raw; Object.assign(headers, opts.headers || {}); }
    else if (body !== undefined) { payload = JSON.stringify(body); headers["Content-Type"] = "application/vnd.hd+json"; }   // свой тип: обходит лимит 100 КБ общего разборщика
    let r;
    try { r = await fetch("/admin/api" + path, { method, headers, body: payload, cache: "no-store" }); } catch (e) { throw { error: "NETWORK" }; }
    let j = null; try { j = await r.json(); } catch (e) {}
    if (method === "GET" && seq !== SEQ) throw { stale: true };   // пользователь уже перешёл на другую страницу
    if (!r.ok) throw Object.assign({ status: r.status }, j || { error: "UNAVAILABLE" });
    return j;
  }
  const run = async (btn, fn) => { if (btn) btn.disabled = true; try { return await fn(); } catch (e) { if (e && e.stale) return; toast(errText(e), true); if (e && e.error === "UNAUTHENTICATED") boot(); } finally { if (btn) btn.disabled = false; } };

  function modal(title, bodyHtml, buttons = [], { wide = false } = {}) {
    const d = $("#modal");
    d.className = "modal" + (wide ? " wide" : "");
    $("#modalBody").innerHTML = `<div class="mh"><h3>${esc(title)}</h3><button class="icon-btn" data-x aria-label="Закрыть">✕</button></div><div class="mb">${bodyHtml}</div>${buttons.length ? `<div class="mf">${buttons.map((b, i) => `<button class="btn ${b.cls || ""}" data-b="${i}">${esc(b.label)}</button>`).join("")}</div>` : ""}`;
    $("#modalBody").querySelector("[data-x]").onclick = () => d.close();
    buttons.forEach((b, i) => { $("#modalBody").querySelector(`[data-b="${i}"]`).onclick = async e => { const keep = await b.onClick(e.currentTarget); if (keep !== true) d.close(); }; });
    if (!d.open) d.showModal();
    return $("#modalBody");
  }
  const confirmDlg = (title, text, okLabel, onOk, cls = "danger") => modal(title, `<p>${text}</p>`, [{ label: "Отмена", cls: "ghost", onClick: () => {} }, { label: okLabel, cls, onClick: onOk }]);

  /* ---------- Навигация ---------- */
  const I = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const NAV = [
    ["dashboard", "Сводка", "dashboard.view", I('<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 4v4h6V4z"/>')],
    ["courses", "Курсы и уроки", "content.edit", I('<path d="M4 5h11a3 3 0 0 1 3 3v12H7a3 3 0 0 1-3-3z"/><path d="M8 9h6M8 13h4"/>')],
    ["media", "Медиа", "content.edit", I('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 8"/>')],
    ["announcements", "Афиши", "announcements.edit", I('<path d="M4 10v4l12 5V5zM16 9a3 3 0 0 1 0 6"/>')],
    ["users", "Пользователи", "users.view", I('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6 6 0 0 0-4-5.6"/>')],
    ["audit", "Журнал действий", "audit.view", I('<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h3"/>')],
    ["import", "Импорт курса", "import.course", I('<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>')],
    ["bans", "Блокировка аккаунтов", "users.block", I('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>')],
    ["links", "Партнёрские ссылки", "links.manage", I('<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>')],
    ["partners", "Партнёры и выплаты", "partners.view", I('<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M3 19a5 5 0 0 1 10 0M11 19a5 5 0 0 1 10 0"/>')],
    ["mentor", "ИИ-помощник", "mentor.manage", I('<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>')],
    ["kv2", "База знаний v2", "content.edit", I('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="m9 13 2 2 4-4"/>')],
    ["knowledge", "База знаний AI", "content.edit", I('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/>')],
    ["chart", "Chart Training", "chart.manage", I('<path d="M4 19h16M7 15l4-4 3 3 5-6"/><path d="M15 8h4v4"/>')],
    ["daily", "Daily Tests", "daily.manage", I('<path d="M9 4h6v2H9zM6 6h12v15H6z"/><path d="m9 14 2 2 4-4"/>')],
    ["features", "Функции Academy", "features.manage", I('<rect x="3" y="4" width="7" height="7" rx="2"/><rect x="14" y="4" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M17.5 14v7M14 17.5h7"/>')],
    ["diagnostics", "Диагностика", "diagnostics.view", I('<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>')],
    ["videostudio", "Video Studio", "features.manage", I('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>'), "/academy/admin/video-studio.html"]
  ];
  function buildNav(active) {
    $("#nav").innerHTML = NAV.filter(n => can(n[2])).map(n => `<a href="${n[4] || "#/" + n[0]}" ${n[0] === active ? 'aria-current="page"' : ""}>${n[3]}<span>${n[1]}</span></a>`).join("");
    $("#me").innerHTML = `<b>${esc(ME.email || ME.uid)}</b>${esc(ME.role_label)}<br><button class="btn sm ghost" id="logout">Выйти</button>`;
    $("#logout").onclick = async () => { await api_signOut(); location.hash = ""; boot(); };
  }
  const api_signOut = () => window.hdAuth.signOut();
  function setMenu(open) { app.classList.toggle("menu-open", open); $("#scrim").hidden = !open; $("#menuBtn").setAttribute("aria-expanded", open); }
  $("#menuBtn").onclick = () => setMenu(!app.classList.contains("menu-open"));
  $("#scrim").onclick = () => setMenu(false);
  function page(title, sub, actionsHtml = "") { titleEl.textContent = title; document.title = title + " — HIDDEN DINOX ACADEMY"; return `<div class="page-h"><div><h2>${esc(title)}</h2>${sub ? `<p>${sub}</p>` : ""}</div><div class="actions">${actionsHtml}</div></div>`; }

  /* ---------- Вход ---------- */
  function loginView(message) {
    setMenu(false);                       // на телефоне меню не должно перекрывать форму входа
    app.dataset.view = "login";
    $("#nav").innerHTML = ""; $("#me").innerHTML = ""; titleEl.textContent = "Вход";
    main.innerHTML = `<div class="login"><h2>Админ-панель</h2><p class="muted">${esc(message || "Войдите аккаунтом академии с правами администратора.")}</p>
      <form class="panel form" id="lf"><label class="f">Email<input type="email" id="le" autocomplete="username" required></label>
      <label class="f">Пароль<input type="password" id="lp" autocomplete="current-password" required></label><p class="err" id="lerr" hidden></p>
      <button class="btn primary" id="lb">Войти</button></form><p class="muted" style="margin-top:14px"><a href="/academy/">Вернуться в академию</a></p></div>`;
    $("#lf").onsubmit = async e => {
      e.preventDefault(); const b = $("#lb"); b.disabled = true; $("#lerr").hidden = true;
      try { await window.hdAuth.signIn($("#le").value.trim(), $("#lp").value); await boot(); }
      catch (er) { $("#lerr").hidden = false; $("#lerr").textContent = er && er.code === "BAD_CREDENTIALS" ? "Неверный email или пароль" : errText(er); }
      finally { b.disabled = false; }
    };
  }

  /* ---------- Сводка ---------- */
  const bars = (series, label) => { const max = Math.max(1, ...series.map(s => s.count)); return `<div class="bars" role="img" aria-label="${esc(label)}">${series.map(s => `<i style="height:${(s.count / max) * 100}%" title="${esc(s.date)}: ${s.count}"></i>`).join("")}</div><div class="bars-x"><span>${esc(series[0] ? series[0].date : "")}</span><span>${esc(series.length ? series[series.length - 1].date : "")}</span></div>`; };
  async function dashboardView() {
    main.innerHTML = page("Сводка", "Данные Firestore на момент открытия страницы") + `<p class="muted">Загрузка…</p>`;
    const d = await api("GET", "/dashboard");
    const S = (v, l, key) => `<div class="stat${key ? " key" : ""}"><span>${esc(l)}</span><b>${esc(v)}</b></div>`;
    const norm = s => Array.isArray(s) ? s.map(x => (Array.isArray(x) ? { date: x[0], count: x[1] } : x)) : Object.entries(s || {}).map(([date, count]) => ({ date, count }));
    main.innerHTML = page("Сводка", "Данные Firestore на момент открытия страницы", `<button class="btn" id="rf">Обновить</button>`) +
      `<div class="grid stats">${S(d.users.total, "Пользователей")}${S(d.academy.activated, "Доступ к академии открыт", 1)}${S(d.academy.trader_bound, "Привязано Trader ID")}${S(d.academy.ftd_confirmed, "Подтверждённых первых депозитов")}
      ${S(d.academy.awaiting_deposit, "Ожидают подтверждения депозита")}${S(d.users.new7, "Новых за 7 дней")}${S(d.users.new30, "Новых за 30 дней")}${S(d.content.courses_published + " / " + d.content.courses, "Курсов опубликовано / всего")}
      ${S(d.content.modules, "Модулей")}${S(d.content.lessons_ready + " / " + d.content.lessons, "Уроков готово / всего")}${S(d.learning.lessons_completed, "Завершённых уроков")}${S(d.learning.learners, "Учеников с прогрессом")}</div>
      <div class="grid two"><section class="panel"><h3>Регистрации за 30 дней</h3>${bars(norm(d.charts.registrations), "Регистрации по дням")}</section>
      <section class="panel"><h3>Завершённые уроки за 30 дней</h3>${bars(norm(d.charts.completions), "Завершения по дням")}</section>
      <section class="panel"><h3>Последние действия администраторов</h3>${d.recent.length ? `<div class="table-wrap"><table><tbody>${d.recent.map(r => `<tr><td class="num">${fmtDate(r.at)}</td><td>${esc(r.action)}</td><td class="hide-sm muted">${esc(r.actor || "")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Пока нет записей.</p>`}</section>
      <section class="panel"><h3>Последние завершения уроков</h3>${(d.recent_learning || []).length ? `<div class="table-wrap"><table><tbody>${d.recent_learning.map(r => `<tr><td class="num">${fmtDate(r.at)}</td><td>${esc(r.email || r.uid)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Ученики ещё не завершали уроки.</p>`}</section></div>
      ${(d.notes || []).map(n => `<p class="muted" style="margin-top:14px;font-size:13px">${esc(n)}</p>`).join("")}`;
    $("#rf").onclick = () => route();
  }

  /* ---------- Курсы ---------- */
  const LEVEL = { beginner: "Начальный", intermediate: "Средний", advanced: "Продвинутый" };
  const statusPill = s => s === "published" ? `<span class="pill ok">Опубликован</span>` : s === "ready" ? `<span class="pill info">Готов к публикации</span>` : `<span class="pill warn">Черновик</span>`;
  async function coursesView() {
    main.innerHTML = page("Курсы и уроки", "") + `<p class="muted">Загрузка…</p>`;
    const { courses } = await api("GET", "/courses");
    main.innerHTML = page("Курсы и уроки", "Черновики не видны ученикам, пока вы не опубликуете курс", `${can("import.course") ? `<a class="btn" href="#/import">Импорт</a>` : ""}<button class="btn primary" id="nc">Новый курс</button>`) +
      (courses.length ? `<div class="table-wrap"><table><thead><tr><th>Курс</th><th>Статус</th><th class="hide-sm">Уровень</th><th class="hide-sm">Изменён</th></tr></thead><tbody>${courses.map(c => `<tr><td><a href="#/courses/${esc(c.id)}"><b>${esc(c.title)}</b></a></td><td>${statusPill(c.status)}</td><td class="hide-sm">${esc(LEVEL[c.level] || c.level || "")}</td><td class="hide-sm num">${fmtDate(c.updated_at)}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">Курсов пока нет.<br><button class="btn primary" id="nc2">Создать первый курс</button></div>`);
    const create = () => courseForm(null);
    $("#nc").onclick = create; if ($("#nc2")) $("#nc2").onclick = create;
  }
  function courseFields(c = {}) {
    return `<div class="form cols"><label class="f">Название<input type="text" name="title" maxlength="160" value="${esc(c.title || "")}" required></label>
      <label class="f">Уровень<select name="level">${Object.entries(LEVEL).map(([k, v]) => `<option value="${k}" ${c.level === k ? "selected" : ""}>${v}</option>`).join("")}</select></label></div>
      <div class="form" style="margin-top:12px"><label class="f">Описание<textarea name="description" maxlength="4000">${esc(c.description || "")}</textarea></label>
      <label class="f">Цель обучения<textarea name="goal" maxlength="2000">${esc(c.goal || "")}</textarea></label>
      <label class="f">Дисклеймер о рисках<small>Показывается ученикам в курсе</small><textarea name="disclaimer" maxlength="2000">${esc(c.disclaimer || "")}</textarea></label>
      <div class="form cols"><label class="f">Обложка<small>ID из медиа-библиотеки</small><input type="text" name="cover_media_id" value="${esc(c.cover_media_id || "")}"></label>
      <div class="f" style="justify-content:flex-end"><button type="button" class="btn" data-pick="cover_media_id">Выбрать из медиа</button></div></div></div>`;
  }
  const readForm = root => Object.fromEntries([...root.querySelectorAll("[name]")].map(el => [el.name, el.type === "checkbox" ? el.checked : el.value]));
  function bindPickers(root) { root.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => pickMedia(id => { root.querySelector(`[name="${b.dataset.pick}"]`).value = id; }, b.dataset.kind)); }
  function courseForm(c) {
    const body = modal(c ? "Свойства курса" : "Новый курс", courseFields(c || {}), [{ label: "Отмена", cls: "ghost", onClick: () => {} },
      { label: c ? "Сохранить" : "Создать курс", cls: "primary", onClick: async btn => {
        const data = readForm($("#modalBody")); if (c) data.slug = c.slug; if (c && c.source) data.source = c.source;
        const r = await run(btn, () => c ? api("PUT", "/courses/" + c.id, data) : api("POST", "/courses", data));
        if (!r) return true;
        toast(c ? "Курс сохранён" : "Курс создан"); location.hash = "#/courses/" + (c ? c.id : r.id); if (c) route();
      } }]);
    bindPickers(body);
  }
  async function courseView(id) {
    main.innerHTML = page("Курс", "") + `<p class="muted">Загрузка…</p>`;
    const d = await api("GET", "/courses/" + id);
    const c = d.course, pub = d.published;
    const st = pub ? `<span class="pill ok">Опубликован, версия ${esc(pub.version)}</span>${pub.visible_from && pub.visible_from > Date.now() ? `<span class="pill info">Показ с ${fmtDate(pub.visible_from)}</span>` : ""}${d.has_unpublished_changes ? `<span class="pill warn">Есть неопубликованные изменения</span>` : ""}` : `<span class="pill warn">Черновик — ученики не видят курс</span>`;
    const ready = d.modules.reduce((n, m) => n + m.lessons.filter(l => l.status === "ready").length, 0), total = d.modules.reduce((n, m) => n + m.lessons.length, 0);
    main.innerHTML = page(c.title, `Уровень: ${esc(LEVEL[c.level] || c.level)} · уроков готово к публикации: ${ready} из ${total}`,
      `<button class="btn" id="edit">Свойства</button><button class="btn" id="dup">Дублировать</button>${can("content.publish") && ready < total ? `<button class="btn" id="readyall">Все уроки готовы</button>` : ""}${can("content.publish") ? (pub ? `<button class="btn" id="unpub">Снять с публикации</button>` : "") + `<button class="btn primary" id="pub">${pub ? "Опубликовать изменения" : "Опубликовать"}</button>` : ""}`) +
      `<div class="status-line" style="margin:-10px 0 18px">${st}</div>
      ${c.description ? `<section class="panel" style="margin-bottom:14px"><h3>Описание</h3><div class="hdl-text">${window.HDLesson.md(c.description)}</div></section>` : ""}
      <div class="tree">${d.modules.map((m, mi) => `<section class="mod"><div class="mod-h"><h4><span class="n">Модуль ${mi + 1}</span>${esc(m.title)}</h4><div class="actions">
        <button class="btn sm ghost" data-mup="${mi}" ${mi === 0 ? "disabled" : ""} aria-label="Выше">↑</button><button class="btn sm ghost" data-mdown="${mi}" ${mi === d.modules.length - 1 ? "disabled" : ""} aria-label="Ниже">↓</button>
        <button class="btn sm" data-medit="${esc(m.id)}">Изменить</button><button class="btn sm" data-nl="${esc(m.id)}">+ Урок</button>${can("content.delete") ? `<button class="btn sm danger" data-mdel="${esc(m.id)}">Удалить</button>` : ""}</div></div>
        ${m.lessons.length ? m.lessons.map((l, li) => `<div class="les"><div><a href="#/lessons/${esc(l.id)}">${mi + 1}.${li + 1}. ${esc(l.title)}</a><div class="meta">${statusPill(l.status)} блоков: ${esc(l.blocks)}</div></div><div class="actions">
          <button class="btn sm ghost" data-lup="${mi}:${li}" ${li === 0 ? "disabled" : ""} aria-label="Выше">↑</button><button class="btn sm ghost" data-ldown="${mi}:${li}" ${li === m.lessons.length - 1 ? "disabled" : ""} aria-label="Ниже">↓</button></div></div>`).join("") : `<div class="les"><span class="muted">В модуле нет уроков</span></div>`}</section>`).join("")}
        <div class="add-row"><button class="btn" id="nm">+ Модуль</button>${can("content.delete") ? `<button class="btn danger" id="del">Удалить курс</button>` : ""}</div></div>`;
    $("#edit").onclick = () => courseForm(c);
    $("#dup").onclick = e => run(e.currentTarget, async () => { const r = await api("POST", `/courses/${id}/duplicate`, {}); toast("Создана копия курса (черновик)"); location.hash = "#/courses/" + r.id; });
    $("#nm").onclick = () => moduleForm(id, null);
    if ($("#readyall")) $("#readyall").onclick = () => modal("Отметить все уроки готовыми", `<p>Все ${total} уроков получат статус «Готов к публикации». Ученики ничего не увидят, пока вы не нажмёте «Опубликовать».</p><label class="check"><input type="checkbox" id="rac"> Я проверил содержание уроков</label>`,
      [{ label: "Отмена", cls: "ghost", onClick: () => {} }, { label: "Отметить", cls: "primary", onClick: async btn => {
        if (!$("#rac").checked) { toast("Подтвердите проверку уроков", true); return true; }
        const r = await run(btn, () => api("POST", `/courses/${id}/ready-all`, { confirm: true })); if (!r) return true; toast(`Готовы к публикации: ${r.total} из ${r.total}`); route(); } }]);
    if ($("#pub")) $("#pub").onclick = () => {
      const b = modal("Публикация курса", `<p>Ученики увидят <b>${ready}</b> уроков в статусе «Готов к публикации». Черновики не публикуются.</p>
        ${ready === 0 ? `<p class="err">Нет готовых уроков: откройте урок и отметьте «Готов к публикации».</p>` : ""}
        <label class="f">Начать показ (необязательно)<small>Пусто — сразу после публикации</small><input type="datetime-local" id="vf"></label>
        <label class="check" style="margin-top:12px"><input type="checkbox" id="cf"> Я проверил материалы и подтверждаю публикацию</label>`,
        [{ label: "Отмена", cls: "ghost", onClick: () => {} }, { label: "Опубликовать", cls: "primary", onClick: async btn => {
          if (!$("#cf").checked) { toast("Подтвердите публикацию галочкой", true); return true; }
          const vf = $("#vf").value ? new Date($("#vf").value).toISOString() : undefined;
          const r = await run(btn, () => api("POST", `/courses/${id}/publish`, { confirm: true, visible_from: vf })); if (!r) return true;
          toast(`Опубликовано уроков: ${r.lessons}`); route(); } }]);
    };
    if ($("#unpub")) $("#unpub").onclick = () => confirmDlg("Снять с публикации", "Ученики перестанут видеть курс. Черновики и прогресс учеников сохранятся.", "Снять с публикации",
      async btn => { const r = await run(btn, () => api("POST", `/courses/${id}/unpublish`, { confirm: true })); if (r) { toast("Курс снят с публикации"); route(); } else return true; });
    if ($("#del")) $("#del").onclick = () => {
      modal("Удалить курс", `<p>Будут удалены курс, его модули и уроки-черновики. Опубликованный курс сначала нужно снять с публикации.</p><label class="f">Для подтверждения введите название курса<input type="text" id="dt"></label>`,
        [{ label: "Отмена", cls: "ghost", onClick: () => {} }, { label: "Удалить", cls: "danger", onClick: async btn => {
          if ($("#dt").value.trim() !== c.title) { toast("Название не совпадает", true); return true; }
          const r = await run(btn, () => api("POST", `/courses/${id}/delete`, { confirm: true })); if (!r) return true; toast("Курс удалён"); location.hash = "#/courses"; } }]);
    };
    const reorder = async (mods, lessonsMap) => run(null, async () => { await api("POST", `/courses/${id}/reorder`, { modules: mods, lessons: lessonsMap }); route(); });
    const modIds = d.modules.map(m => m.id), lessMap = Object.fromEntries(d.modules.map(m => [m.id, m.lessons.map(l => l.id)]));
    main.querySelectorAll("[data-mup],[data-mdown]").forEach(b => b.onclick = () => { const i = +(b.dataset.mup ?? b.dataset.mdown), j = b.dataset.mup !== undefined ? i - 1 : i + 1; const a = [...modIds]; [a[i], a[j]] = [a[j], a[i]]; reorder(a, lessMap); });
    main.querySelectorAll("[data-lup],[data-ldown]").forEach(b => b.onclick = () => { const [mi, li] = (b.dataset.lup ?? b.dataset.ldown).split(":").map(Number), mid = modIds[mi], a = [...lessMap[mid]], j = b.dataset.lup !== undefined ? li - 1 : li + 1; [a[li], a[j]] = [a[j], a[li]]; reorder(modIds, { ...lessMap, [mid]: a }); });
    main.querySelectorAll("[data-medit]").forEach(b => b.onclick = () => moduleForm(id, d.modules.find(m => m.id === b.dataset.medit)));
    main.querySelectorAll("[data-mdel]").forEach(b => b.onclick = () => confirmDlg("Удалить модуль", "Удалить можно только пустой модуль.", "Удалить", async btn => { const r = await run(btn, () => api("POST", `/modules/${b.dataset.mdel}/delete`, { confirm: true })); if (r) { toast("Модуль удалён"); route(); } else return true; }));
    main.querySelectorAll("[data-nl]").forEach(b => b.onclick = () => modal("Новый урок", `<label class="f">Название урока<input type="text" id="nlt" maxlength="160"></label>`,
      [{ label: "Отмена", cls: "ghost", onClick: () => {} }, { label: "Создать", cls: "primary", onClick: async btn => { const r = await run(btn, () => api("POST", `/modules/${b.dataset.nl}/lessons`, { title: $("#nlt").value, blocks: [] })); if (!r) return true; location.hash = "#/lessons/" + r.id; } }]));
  }
  function moduleForm(courseId, m) {
    m = m || {};
    modal(m.id ? "Модуль" : "Новый модуль", `<div class="form"><label class="f">Название<input type="text" name="title" maxlength="160" value="${esc(m.title || "")}"></label>
      <label class="f">Цель модуля<textarea name="goal">${esc(m.goal || "")}</textarea></label><label class="f">Предварительные знания<textarea name="prerequisites">${esc(m.prerequisites || "")}</textarea></label>
      <label class="f">Основные понятия<textarea name="concepts">${esc(m.concepts || "")}</textarea></label><label class="f">Критерии освоения<textarea name="mastery_criteria">${esc(m.mastery_criteria || "")}</textarea></label></div>`,
      [{ label: "Отмена", cls: "ghost", onClick: () => {} }, { label: "Сохранить", cls: "primary", onClick: async btn => {
        const data = readForm($("#modalBody")); const r = await run(btn, () => m.id ? api("PUT", "/modules/" + m.id, data) : api("POST", `/courses/${courseId}/modules`, data)); if (!r) return true; toast("Модуль сохранён"); route(); } }]);
  }

  /* ---------- Редактор урока ---------- */
  const BLOCKS = { heading: "Заголовок", text: "Текст", terms: "Термины", image: "Изображение", chart: "График / схема", video: "Видео", note: "Важное замечание", example: "Пример ситуации", practice: "Практическое задание", quiz: "Тест", summary: "Итог урока", file: "PDF-файл" };
  const NOTE = { important: "Важно", warning: "Предупреждение", editorial: "Редакционное дополнение", source: "Из книги", risk: "Риск" };
  const newBlock = t => ({ heading: { text: "" }, text: { title: "", text: "" }, summary: { title: "Итог урока", text: "" }, terms: { title: "Термины", items: [{ term: "", definition: "" }] }, image: { media_id: "", url: "", caption: "", alt: "" },
    chart: { chart_role: "illustration", chart: { title: "", caption: "Учебная схема, не реальные котировки", candles: [[10, 12, 9, 11.5], [11.5, 13, 11, 12.6], [12.6, 13.2, 11.8, 12]], annotations: [] } }, video: { url: "", title: "", caption: "" },
    note: { variant: "important", title: "", text: "" }, example: { title: "", text: "", chart: null }, practice: { title: "Практика", task: "", criteria: "", homework: false, chart: null },
    quiz: { title: "Проверка знаний", pass_percent: 70, questions: [{ q: "", options: ["", ""], correct: 0, explanation: "", kind: "choice" }] }, file: { media_id: "", title: "" } }[t]);
  let L = null;   // редактируемый урок
  const fieldT = (k, label, v, ta, hint) => `<label class="f">${label}${hint ? `<small>${hint}</small>` : ""}${ta ? `<textarea data-k="${k}" ${ta === "code" ? 'class="code" spellcheck="false"' : ""}>${esc(v || "")}</textarea>` : `<input type="text" data-k="${k}" value="${esc(v || "")}">`}</label>`;
  function blockBody(b, i) {
    const t = b.type;
    if (t === "heading") return fieldT("text", "Текст заголовка", b.text);
    if (t === "text" || t === "summary") return `<div class="form">${fieldT("title", "Подзаголовок (необязательно)", b.title)}${fieldT("text", "Текст", b.text, true, "Форматирование: **жирный**, *курсив*, «- » список, «1. » нумерация, [ссылка](https://…)")}</div>`;
    if (t === "note") return `<div class="form"><label class="f">Тип<select data-k="variant">${Object.entries(NOTE).map(([k, v]) => `<option value="${k}" ${b.variant === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>${fieldT("title", "Заголовок", b.title)}${fieldT("text", "Текст", b.text, true)}</div>`;
    if (t === "terms") return `<div class="form">${fieldT("title", "Заголовок", b.title)}${fieldT("items_json", "Термины", (b.items || []).map(x => x.term + " — " + x.definition).join("\n"), true, "Каждый термин с новой строки: «Термин — определение»")}</div>`;
    if (t === "image" || t === "file") return `<div class="form cols">${fieldT("media_id", "Файл из медиа-библиотеки (ID)", b.media_id)}<div class="f" style="justify-content:flex-end"><button type="button" class="btn" data-pickb="${i}" data-kind="${t === "file" ? "pdf" : "image"}">Выбрать</button></div>${t === "image" ? fieldT("url", "или https-ссылка", b.url) + fieldT("alt", "Описание для незрячих", b.alt) : fieldT("title", "Название", b.title)}${fieldT("caption", "Подпись", b.caption)}</div>`;
    if (t === "video") return `<div class="form">${fieldT("url", "Ссылка (YouTube, Vimeo или https)", b.url)}${fieldT("title", "Название", b.title)}${fieldT("caption", "Подпись", b.caption)}</div>`;
    if (t === "chart") return `<div class="form"><label class="f">Роль<select data-k="chart_role">${[["illustration", "Иллюстрация"], ["correct", "Правильный сценарий"], ["incorrect", "Ошибочный сценарий"], ["practice", "Задание по графику"]].map(([k, v]) => `<option value="${k}" ${b.chart_role === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      ${fieldT("chart_json", "Данные графика (JSON)", JSON.stringify(b.chart, null, 1), "code", "candles: [[open, high, low, close], …]; annotations: marker / zone / hline / trend с подписью label. Учебные графики синтетические — подпись об этом обязательна.")}<div class="chart-pv" data-chartpv="${i}"></div></div>`;
    if (t === "example") return `<div class="form">${fieldT("title", "Название ситуации", b.title)}${fieldT("text", "Разбор", b.text, true)}${fieldT("chart_json", "График (JSON, необязательно)", b.chart ? JSON.stringify(b.chart, null, 1) : "", "code")}</div>`;
    if (t === "practice") return `<div class="form">${fieldT("title", "Название", b.title)}${fieldT("task", "Задание", b.task, true)}${fieldT("criteria", "Критерии выполнения", b.criteria, true)}<label class="check"><input type="checkbox" data-k="homework" ${b.homework ? "checked" : ""}> Домашнее задание</label></div>`;
    if (t === "quiz") return `<div class="form cols">${fieldT("title", "Название теста", b.title)}<label class="f">Проходной балл, %<input type="number" min="0" max="100" data-k="pass_percent" value="${esc(b.pass_percent)}"></label></div>
      <div style="margin-top:10px">${(b.questions || []).map((q, qi) => `<div class="q" data-q="${qi}"><label class="f">Вопрос ${qi + 1}<textarea data-qk="q" style="min-height:60px">${esc(q.q)}</textarea></label>
        ${q.options.map((o, oi) => `<div class="opt"><input type="radio" name="c${i}_${qi}" data-correct="${oi}" ${q.correct === oi ? "checked" : ""} aria-label="Правильный ответ"><input type="text" data-opt="${oi}" value="${esc(o)}"><button type="button" class="btn sm ghost" data-delopt="${oi}" ${q.options.length <= 2 ? "disabled" : ""} aria-label="Удалить вариант">✕</button></div>`).join("")}
        <div class="actions" style="margin-top:8px"><button type="button" class="btn sm" data-addopt>+ Вариант</button><button type="button" class="btn sm danger" data-delq>Удалить вопрос</button></div>
        <label class="f" style="margin-top:8px">Объяснение (ученик видит после попытки)<textarea data-qk="explanation" style="min-height:60px">${esc(q.explanation)}</textarea></label></div>`).join("")}
        <button type="button" class="btn sm" data-addq>+ Вопрос</button></div>`;
    return "";
  }
  /* Перенос значений из формы блока в данные (вызывается при каждом изменении) */
  function readBlock(el, b) {
    el.querySelectorAll("[data-k]").forEach(f => {
      const k = f.dataset.k, v = f.type === "checkbox" ? f.checked : f.value;
      if (k === "chart_json") { if (!v.trim() && b.type === "example") { b.chart = null; return; } try { b.chart = JSON.parse(v); f.setCustomValidity(""); } catch (e) { f.setCustomValidity("Неверный JSON"); } }
      else if (k === "items_json") b.items = v.split("\n").map(s => s.trim()).filter(Boolean).map(s => { const m = s.split(/\s+[—-]\s+/); return { term: (m[0] || "").trim(), definition: m.slice(1).join(" — ").trim() }; });
      else if (k === "pass_percent") b.pass_percent = Number(v);
      else b[k] = v;
    });
    if (b.type === "quiz") el.querySelectorAll("[data-q]").forEach(qe => { const q = b.questions[+qe.dataset.q]; qe.querySelectorAll("[data-qk]").forEach(f => (q[f.dataset.qk] = f.value)); qe.querySelectorAll("[data-opt]").forEach(f => (q.options[+f.dataset.opt] = f.value)); const c = qe.querySelector("[data-correct]:checked"); if (c) q.correct = +c.dataset.correct; });
  }
  async function lessonView(id) {
    main.innerHTML = page("Урок", "") + `<p class="muted">Загрузка…</p>`;
    const { lesson } = await api("GET", "/lessons/" + id);
    L = JSON.parse(JSON.stringify(lesson));
    L.pass_criteria = L.pass_criteria || { require_quiz: false, min_percent: 70 };
    renderLessonEditor();
  }
  function renderLessonEditor() {
    const dirty = { v: false };
    main.innerHTML = page(L.title || "Урок", `<a href="#/courses/${esc(L.course_id)}">← К курсу</a>`, `<button class="btn" id="pv">Предпросмотр</button><button class="btn" id="dupl">Дублировать</button>${can("content.delete") ? `<button class="btn danger" id="dell">Удалить</button>` : ""}`) +
      `<div class="editor"><section class="panel form"><div class="form cols"><label class="f">Название урока<input type="text" id="lt" value="${esc(L.title)}" maxlength="160"></label>
        <label class="f">Статус<select id="ls"><option value="draft" ${L.status !== "ready" ? "selected" : ""}>Черновик</option><option value="ready" ${L.status === "ready" ? "selected" : ""}>Готов к публикации</option></select></label></div>
        <label class="f">Ожидаемый результат<textarea id="lo">${esc(L.outcome || "")}</textarea></label>
        <div class="form cols"><label class="f">Страницы книги<input type="text" id="lsrc" value="${esc(L.source_pages || "")}"></label>
        <label class="f">Минимум для теста, %<input type="number" id="lmin" min="0" max="100" value="${esc(L.pass_criteria.min_percent)}"></label></div>
        <label class="check"><input type="checkbox" id="lrq" ${L.pass_criteria.require_quiz ? "checked" : ""}> Урок засчитывается только после прохождения теста</label></section>
        <div class="blocks" id="blocks">${L.blocks.map((b, i) => `<section class="blk" data-i="${i}"><div class="blk-h"><b>${i + 1}. ${esc(BLOCKS[b.type] || b.type)}</b><div class="tools">
          <button class="btn sm ghost" data-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="Выше">↑</button><button class="btn sm ghost" data-down="${i}" ${i === L.blocks.length - 1 ? "disabled" : ""} aria-label="Ниже">↓</button><button class="btn sm danger" data-del="${i}" aria-label="Удалить блок">✕</button></div></div>
          <div class="blk-b">${blockBody(b, i)}</div></section>`).join("") || `<div class="empty">В уроке пока нет блоков — добавьте первый ниже.</div>`}</div>
        <div class="add-row"><span class="muted" style="align-self:center">Добавить блок:</span>${Object.entries(BLOCKS).map(([k, v]) => `<button class="btn sm" data-add="${k}">${v}</button>`).join("")}</div></div>
        <div class="sticky-bar"><span class="muted" id="dirty" style="margin-right:auto;align-self:center"></span><button class="btn primary" id="save">Сохранить</button></div>`;
    const markDirty = () => { dirty.v = true; $("#dirty").textContent = "Есть несохранённые изменения"; };
    const sync = () => { L.title = $("#lt").value; L.status = $("#ls").value; L.outcome = $("#lo").value; L.source_pages = $("#lsrc").value; L.pass_criteria = { require_quiz: $("#lrq").checked, min_percent: Number($("#lmin").value) || 0 };
      main.querySelectorAll(".blk").forEach(el => readBlock(el, L.blocks[+el.dataset.i])); };
    main.querySelector(".editor").addEventListener("input", () => { markDirty(); sync(); drawChartPreviews(); });
    main.querySelector(".editor").addEventListener("change", () => { markDirty(); sync(); });
    // Каждый обработчик сначала вызывает sync(), затем меняет L.blocks. Повторно читать форму здесь нельзя:
    // на экране ещё старый порядок блоков, и значения попали бы в соседние блоки.
    const rerender = () => { renderLessonEditor(); $("#dirty").textContent = "Есть несохранённые изменения"; };
    main.querySelectorAll("[data-add]").forEach(b => b.onclick = () => { sync(); L.blocks.push({ type: b.dataset.add, ...newBlock(b.dataset.add) }); rerender(); });
    main.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { sync(); L.blocks.splice(+b.dataset.del, 1); rerender(); });
    main.querySelectorAll("[data-up],[data-down]").forEach(b => b.onclick = () => { sync(); const i = +(b.dataset.up ?? b.dataset.down), j = b.dataset.up !== undefined ? i - 1 : i + 1; [L.blocks[i], L.blocks[j]] = [L.blocks[j], L.blocks[i]]; rerender(); });
    main.querySelectorAll(".blk").forEach(el => { const bi = +el.dataset.i, b = L.blocks[bi];
      el.querySelectorAll("[data-pickb]").forEach(p => p.onclick = () => pickMedia(mid => { el.querySelector('[data-k="media_id"]').value = mid; sync(); markDirty(); }, p.dataset.kind));
      el.querySelectorAll("[data-addq]").forEach(x => x.onclick = () => { sync(); b.questions.push({ q: "", options: ["", ""], correct: 0, explanation: "", kind: "choice" }); rerender(); });
      el.querySelectorAll("[data-q]").forEach(qe => { const q = b.questions[+qe.dataset.q];
        qe.querySelector("[data-addopt]").onclick = () => { sync(); if (q.options.length < 8) q.options.push(""); rerender(); };
        qe.querySelector("[data-delq]").onclick = () => { sync(); b.questions.splice(+qe.dataset.q, 1); rerender(); };
        qe.querySelectorAll("[data-delopt]").forEach(x => x.onclick = () => { sync(); const oi = +x.dataset.delopt; q.options.splice(oi, 1); if (q.correct >= q.options.length) q.correct = 0; rerender(); }); }); });
    function drawChartPreviews() { main.querySelectorAll("[data-chartpv]").forEach(el => { const b = L.blocks[+el.dataset.chartpv]; try { el.innerHTML = window.HDLesson.chartFigure(b.chart, b.chart_role); } catch (e) { el.innerHTML = `<p class="err">График не построен: проверьте данные</p>`; } }); }
    drawChartPreviews();
    $("#save").onclick = e => { sync(); run(e.currentTarget, async () => { await api("PUT", "/lessons/" + L.id, { title: L.title, outcome: L.outcome, source_pages: L.source_pages, status: L.status, pass_criteria: L.pass_criteria, blocks: L.blocks }); dirty.v = false; $("#dirty").textContent = "Сохранено"; toast("Урок сохранён"); titleEl.textContent = L.title; }); };
    $("#pv").onclick = () => { sync(); preview(L); };
    $("#dupl").onclick = e => run(e.currentTarget, async () => { const r = await api("POST", `/lessons/${L.id}/duplicate`, {}); toast("Создана копия урока"); location.hash = "#/lessons/" + r.id; });
    if ($("#dell")) $("#dell").onclick = () => confirmDlg("Удалить урок", "Урок будет удалён без возможности восстановления.", "Удалить", async btn => { const r = await run(btn, () => api("POST", `/lessons/${L.id}/delete`, { confirm: true })); if (!r) return true; toast("Урок удалён"); location.hash = "#/courses/" + L.course_id; });
    window.onbeforeunload = () => (dirty.v ? true : undefined);
  }
  function preview(lesson) {
    const body = modal("Предпросмотр: так увидит ученик", `<div class="pv-tabs"><button class="btn sm" data-m="phone" aria-pressed="true">Телефон</button><button class="btn sm" data-m="desktop" aria-pressed="false">Компьютер</button></div><div class="pv-frame phone" id="pvf"></div>`, [], { wide: true });
    const draw = mode => { const f = body.querySelector("#pvf"); f.className = "pv-frame " + mode; f.innerHTML = `<h2>${esc(lesson.title)}</h2><div id="pvl"></div>`;
      window.HDLesson.render(f.querySelector("#pvl"), lesson, { onQuiz: async (bid, ans) => window.HDLesson.gradeLocally(lesson, bid, ans) }); };
    body.querySelectorAll("[data-m]").forEach(b => b.onclick = () => { body.querySelectorAll("[data-m]").forEach(x => x.setAttribute("aria-pressed", x === b)); draw(b.dataset.m); });
    draw("phone");
  }

  /* ---------- Медиа ---------- */
  const isImg = m => m.kind === "image";
  async function mediaList(q, kind) { return (await api("GET", "/media?" + new URLSearchParams({ q: q || "", kind: kind || "" }))).media; }
  const mediaCard = (m, pick) => `<div class="media${pick ? " pickable" : ""}" data-id="${esc(m.id)}"><div class="thumb">${isImg(m) ? `<img onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'muted',textContent:'изображение недоступно'}))" src="/media/${esc(m.id)}" alt="${esc(m.name)}" loading="lazy">` : `<span>PDF</span>`}</div>
    <div class="info"><b>${esc(m.name)}</b><span class="muted">${esc(m.category || m.kind)} · ${kb(m.size)}</span>${pick ? "" : `<div class="actions"><button class="btn sm" data-copy>Ссылка</button><button class="btn sm" data-ren>Переименовать</button>${can("content.delete") ? `<button class="btn sm danger" data-rm>Удалить</button>` : ""}</div>`}</div></div>`;
  async function upload(file, category) {
    if (file.size > 20 * 1024 * 1024) throw { message: "Файл больше 20 МБ" };
    return api("POST", "/media", undefined, { raw: file, headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "X-Media-Category": category } });
  }
  async function mediaView() {
    main.innerHTML = page("Медиа", "Изображения (JPEG, PNG, WebP, GIF) и PDF хранятся в Firebase Storage") +
      `<div class="drop"><input type="file" id="mf" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" multiple><select id="mc">${["lesson", "cover", "poster", "chart", "brand", "pdf", "other"].map(c => `<option value="${c}">${{ lesson: "Для уроков", cover: "Обложка курса", poster: "Афиша", chart: "Скриншот графика", brand: "Бренд", pdf: "PDF", other: "Другое" }[c]}</option>`).join("")}</select><button class="btn primary" id="mu">Загрузить</button></div>
      <div class="filters"><input type="search" id="mq" placeholder="Поиск по названию"><select id="mk"><option value="">Все типы</option><option value="image">Изображения</option><option value="pdf">PDF</option><option value="poster">Афиши</option><option value="cover">Обложки</option></select></div><div id="ml"><p class="muted">Загрузка…</p></div>`;
    const load = async () => { const list = await mediaList($("#mq").value, $("#mk").value);
      $("#ml").innerHTML = list.length ? `<div class="media-grid">${list.map(m => mediaCard(m)).join("")}</div>` : `<div class="empty">Файлов нет. Загрузите первый файл выше.</div>`;
      $("#ml").querySelectorAll(".media").forEach(el => { const m = list.find(x => x.id === el.dataset.id);
        el.querySelector("[data-copy]").onclick = async () => { const u = location.origin + "/media/" + m.id; try { await navigator.clipboard.writeText(u); toast("Ссылка скопирована"); } catch (e) { modal("Ссылка на файл", `<input type="text" readonly value="${esc(u)}"><p class="muted">ID для блоков уроков: <b>${esc(m.id)}</b></p>`); } };
        el.querySelector("[data-ren]").onclick = () => modal("Переименовать", `<input type="text" id="rn" value="${esc(m.name)}" maxlength="120">`, [{ label: "Отмена", cls: "ghost", onClick: () => {} }, { label: "Сохранить", cls: "primary", onClick: async btn => { const r = await run(btn, () => api("PUT", "/media/" + m.id, { name: $("#rn").value })); if (!r) return true; toast("Сохранено"); load(); } }]);
        const rm = el.querySelector("[data-rm]"); if (rm) rm.onclick = () => confirmDlg("Удалить файл", `Удалить «${esc(m.name)}»? Используемые файлы удалить нельзя.`, "Удалить", async btn => {
          try { await api("POST", `/media/${m.id}/delete`, {}); toast("Файл удалён"); load(); }
          catch (e) { if (e.error === "IN_USE") { modal("Файл используется", `<p>Сначала замените его в материалах:</p><ul>${(e.used || []).map(u => `<li>${esc(u.title || u.id)} <span class="muted">(${esc(u.type)})</span></li>`).join("")}</ul>`); return true; } toast(errText(e), true); } }); }); };
    $("#mu").onclick = e => run(e.currentTarget, async () => { const fs = [...$("#mf").files]; if (!fs.length) { toast("Выберите файл", true); return; } for (const f of fs) await upload(f, $("#mc").value); toast(fs.length > 1 ? `Загружено файлов: ${fs.length}` : "Файл загружен"); $("#mf").value = ""; load(); });
    const safe = () => load().catch(e => { if (!(e && e.stale)) toast(errText(e), true); });
    $("#mq").oninput = () => { clearTimeout(mediaView.t); mediaView.t = setTimeout(safe, 300); }; $("#mk").onchange = safe;
    await load();
  }
  async function pickMedia(onPick, kind) {
    const body = modal("Выбор файла", `<div class="drop"><input type="file" id="pf" accept="${kind === "pdf" ? "application/pdf" : "image/jpeg,image/png,image/webp,image/gif"}"><button class="btn primary" id="pu">Загрузить и выбрать</button></div><div id="pl"><p class="muted">Загрузка…</p></div>`, [], { wide: true });
    const list = await mediaList("", kind === "pdf" ? "pdf" : "image").catch(e => { toast(errText(e), true); return []; });
    body.querySelector("#pl").innerHTML = list.length ? `<div class="media-grid">${list.map(m => mediaCard(m, true)).join("")}</div>` : `<div class="empty">Подходящих файлов нет — загрузите новый.</div>`;
    body.querySelectorAll(".media.pickable").forEach(el => el.onclick = () => { onPick(el.dataset.id); $("#modal").close(); });
    body.querySelector("#pu").onclick = e => run(e.currentTarget, async () => { const f = body.querySelector("#pf").files[0]; if (!f) return toast("Выберите файл", true); const r = await upload(f, kind === "pdf" ? "pdf" : "lesson"); onPick(r.id); $("#modal").close(); toast("Файл загружен"); });
  }

  /* ---------- Афиши ---------- */
  const AUD = { all: "Все пользователи", access: "С открытым доступом", no_access: "Без доступа к академии" };
  const toLocal = iso => (iso ? new Date(iso).toISOString().slice(0, 16) : "");
  const BUILTIN = { "invite-earn": "/academy/assets/banners/banner-invite.webp", "book-banner": "/academy/assets/banners/banner-book.webp", "book-reading": "/academy/assets/banners/banner-book.webp", "invite-pointing": "/academy/assets/banners/banner-invite.webp", mascot: "/academy/assets/brand/hd-mascot.webp" };
  const bannerPreview = f => { const img = f.image_media_id ? "/media/" + f.image_media_id : BUILTIN[f.image_builtin] || "";
    const title = f.title_i18n_ru || f.title || "Заголовок баннера", cta = f.action_type === "soon" ? "Скоро" : (f.cta_i18n_ru || "Открыть"), cat = f.category_i18n_ru || "";
    return `<div class="bn-pv">${img ? `<img src="${esc(img)}" alt="">` : ""}<span class="bn-sh"></span>${cat ? `<span class="bn-cat">${esc(cat)}</span>` : ""}<span class="bn-b"><span class="bn-t">${esc(title)}</span><span class="bn-c${f.action_type === "soon" ? " soon" : ""}">${esc(cta)}${f.action_type === "soon" ? "" : '<i>→</i>'}</span></span></div>`; };
  const annCard = a => `<div class="ann-card">${a.image_media_id ? `<img src="/media/${esc(a.image_media_id)}" alt="">` : ""}<div class="c">${a.event_at ? `<div class="when">${fmtDate(Date.parse(a.event_at))}</div>` : ""}<h5>${esc(a.title || "Заголовок афиши")}</h5>${a.body ? `<p>${esc(a.body)}</p>` : ""}${a.cta_label && a.cta_url ? `<span class="btn primary sm">${esc(a.cta_label)}</span>` : ""}</div></div>`;
  let ANN = null;                                     // последний успешно загруженный список — не теряется при ошибке
  async function announcementsView() {
    main.innerHTML = page("Афиши и объявления", "Все записи: черновики, опубликованные и архив. Баннеры главной показываются в карусели по порядку", `<button class="btn primary" id="na">Новая афиша</button>`) +
      `<div class="filters"><input type="search" id="aq" placeholder="Поиск по названию" style="max-width:260px"><select id="as"><option value="">Любой статус</option><option value="draft">Черновики</option><option value="published">Опубликованные</option><option value="archived">Архив</option></select>
       <select id="ak"><option value="">Любой тип</option><option value="banner">Баннеры главной</option><option value="poster">Афиши</option></select><select id="ao"><option value="order">По порядку</option><option value="updated">Сначала изменённые</option><option value="created">Сначала новые</option></select></div><div id="al"><p class="muted">Загрузка…</p></div>`;
    $("#na").onclick = () => annForm({ status: "draft", audience: "all", priority: 0, order: 100 });
    try { ANN = (await api("GET", "/announcements")).announcements; }
    catch (e) { if (e && e.stale) return; if (!ANN) { $("#al").innerHTML = `<div class="empty">${esc(errText(e))} <button class="btn sm" id="ar">Повторить</button></div>`; $("#ar").onclick = () => route(); return; } toast(errText(e) + " — показан прежний список", true); }
    const S = { draft: `<span class="pill warn">Черновик</span>`, published: `<span class="pill ok">Опубликована</span>`, archived: `<span class="pill">Архив</span>` };
    let pageNo = 0; const PER = 20;
    const draw = () => {
      const q = $("#aq").value.trim().toLowerCase(), st = $("#as").value, kd = $("#ak").value, ord = $("#ao").value;
      let list = ANN.filter(a => (!q || String(a.title || "").toLowerCase().includes(q)) && (!st || a.status === st) && (!kd || (a.kind || "poster") === kd));
      list = list.slice().sort(ord === "updated" ? (a, b) => (b.updated_at || 0) - (a.updated_at || 0) : ord === "created" ? (a, b) => (b.created_at || 0) - (a.created_at || 0) : (a, b) => ((a.kind === "banner") === (b.kind === "banner") ? ((a.order ?? 100) - (b.order ?? 100)) || ((b.priority || 0) - (a.priority || 0)) : (a.kind === "banner" ? -1 : 1)));
      const pages = Math.max(1, Math.ceil(list.length / PER)); pageNo = Math.min(pageNo, pages - 1);
      const part = list.slice(pageNo * PER, pageNo * PER + PER);
      $("#al").innerHTML = `<p class="muted">Показано ${part.length} из ${list.length} (всего записей: ${ANN.length})</p>` + (part.length ? `<div class="table-wrap"><table><thead><tr><th>Афиша</th><th>Статус</th><th class="hide-sm">Порядок</th><th class="hide-sm">Показ</th><th class="hide-sm">Изменена</th></tr></thead><tbody>${part.map(a => `<tr><td><a href="#" data-a="${esc(a.id)}"><b>${esc(a.title)}</b></a><div class="muted">${a.kind === "banner" ? "Баннер главной · " : "Афиша · "}${a.system ? "стандартная · " : ""}${esc(AUD[a.audience] || "")} · ${esc(a.id)}</div></td><td>${S[a.status] || ""}</td><td class="hide-sm num">${esc(a.order ?? 100)}</td><td class="hide-sm">${a.show_from ? fmtDay(Date.parse(a.show_from)) : "сразу"} — ${a.show_until ? fmtDay(Date.parse(a.show_until)) : "без срока"}</td><td class="hide-sm num">${fmtDate(a.updated_at)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Ничего не найдено.</div>`) +
        (pages > 1 ? `<div class="filters" style="margin-top:10px"><button class="btn sm" id="pp" ${pageNo ? "" : "disabled"}>← Назад</button><span class="muted">Страница ${pageNo + 1} из ${pages}</span><button class="btn sm" id="pn" ${pageNo < pages - 1 ? "" : "disabled"}>Вперёд →</button></div>` : "");
      $("#al").querySelectorAll("[data-a]").forEach(x => x.onclick = e => { e.preventDefault(); annForm(ANN.find(a => a.id === x.dataset.a)); });
      if ($("#pp")) $("#pp").onclick = () => { pageNo--; draw(); }; if ($("#pn")) $("#pn").onclick = () => { pageNo++; draw(); };
    };
    ["#aq", "#as", "#ak", "#ao"].forEach(id => $(id).addEventListener(id === "#aq" ? "input" : "change", () => { pageNo = 0; draw(); }));
    draw();
  }
  function annForm(a) {
    const body = modal(a.id ? "Афиша" : "Новая афиша", `<div class="grid two"><div class="form">
      <label class="f">Тип<select name="kind"><option value="poster" ${a.kind !== "banner" ? "selected" : ""}>Афиша (лента объявлений)</option><option value="banner" ${a.kind === "banner" ? "selected" : ""}>Баннер главной страницы</option></select></label>
      <label class="f">Заголовок (основной)<input type="text" name="title" maxlength="160" value="${esc(a.title || "")}"></label>
      <fieldset class="form" data-banner style="border:1px solid var(--line);border-radius:10px;padding:12px;margin:0">
        <legend class="muted" style="padding:0 6px">Баннер: переводы и действие</legend>
        <div class="form cols">${["ru", "en", "ua"].map(l => `<label class="f">Заголовок ${l.toUpperCase()}<input type="text" name="title_i18n_${l}" maxlength="160" value="${esc((a.title_i18n || {})[l] || "")}"></label>`).join("")}</div>
        <div class="form cols">${["ru", "en", "ua"].map(l => `<label class="f">Кнопка ${l.toUpperCase()}<input type="text" name="cta_i18n_${l}" maxlength="40" value="${esc((a.cta_i18n || {})[l] || "")}"></label>`).join("")}</div>
        <div class="form cols">${["ru", "en", "ua"].map(l => `<label class="f">Категория ${l.toUpperCase()}<input type="text" name="category_i18n_${l}" maxlength="40" value="${esc((a.category_i18n || {})[l] || "")}"></label>`).join("")}</div>
        <div class="form cols"><label class="f">Действие кнопки<select name="action_type">${[["reader", "Открыть читалку книги"], ["referral", "Кабинет партнёра"], ["course", "Открыть курс"], ["module", "Открыть модуль курса"], ["internal", "Страница академии"], ["external", "Внешняя https-ссылка"], ["soon", "Скоро (недоступно)"]].map(([k, v]) => `<option value="${k}" ${a.action_type === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          <label class="f">Назначение<small>книга: hidden-reaction-system · курс: crs_… · модуль: crs_…/mod_… · страница: learn, reader, partner, academy · внешняя: https://…</small><input type="text" name="action_target" value="${esc(a.action_target || "")}"></label></div>
        <div class="form cols"><label class="f">Встроенное изображение<select name="image_builtin"><option value="">— нет (из медиатеки)</option>${[["invite-earn", "INVITE & EARN (+$100)"], ["book-banner", "Маскот читает книгу"], ["mascot", "Маскот академии"]].map(([k, v]) => `<option value="${k}" ${a.image_builtin === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          <label class="f">Дата релиза (для «Скоро»)<input type="datetime-local" name="release_at" value="${toLocal(a.release_at)}"></label></div>
      </fieldset>
      <label class="f" data-poster>Описание<textarea name="body" maxlength="4000">${esc(a.body || "")}</textarea></label>
      <div class="form cols"><label class="f">Изображение (ID)<input type="text" name="image_media_id" value="${esc(a.image_media_id || "")}"></label><div class="f" style="justify-content:flex-end"><button type="button" class="btn" data-pick="image_media_id">Выбрать</button></div></div>
      <label class="f">Дата и время мероприятия<input type="datetime-local" name="event_at" value="${toLocal(a.event_at)}"></label>
      <div class="form cols"><label class="f">Текст кнопки<input type="text" name="cta_label" maxlength="40" value="${esc(a.cta_label || "")}"></label><label class="f">Ссылка кнопки (https)<input type="url" name="cta_url" value="${esc(a.cta_url || "")}"></label></div>
      <div class="form cols"><label class="f">Показывать с<input type="datetime-local" name="show_from" value="${toLocal(a.show_from)}"></label><label class="f">Показывать до<input type="datetime-local" name="show_until" value="${toLocal(a.show_until)}"></label></div>
      <div class="form cols"><label class="f">Аудитория<select name="audience">${Object.entries(AUD).map(([k, v]) => `<option value="${k}" ${a.audience === k ? "selected" : ""}>${v}</option>`).join("")}</select></label><label class="f">Порядок в карусели (0–1000, меньше — левее)<input type="number" name="order" min="0" max="1000" value="${esc(a.order ?? 100)}"></label><label class="f">Приоритет (0–100)<input type="number" name="priority" min="0" max="100" value="${esc(a.priority || 0)}"></label></div>
      <label class="f">Статус<select name="status">${[["draft", "Черновик"], ["published", "Опубликована"], ["archived", "Архив"]].map(([k, v]) => `<option value="${k}" ${a.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" name="confirm"> Подтверждаю публикацию (нужно для статуса «Опубликована»)</label></div>
      <div><p class="muted" style="margin:0 0 8px">Так афиша выглядит на телефоне</p><div id="annpv">${annCard(a)}</div></div></div>`,
      [...(a.id && can("announcements.publish") ? [{ label: "Удалить", cls: "danger", onClick: async btn => { const r = await run(btn, () => api("POST", `/announcements/${a.id}/delete`, {})); if (!r) return true; toast("Афиша удалена"); route(); } }] : []),
        { label: "Отмена", cls: "ghost", onClick: () => {} }, { label: "Сохранить", cls: "primary", onClick: async btn => {
          const f = readForm($("#modalBody")); const iso = v => (v ? new Date(v).toISOString() : "");
          const data = { ...f, event_at: iso(f.event_at), show_from: iso(f.show_from), show_until: iso(f.show_until), priority: Number(f.priority) || 0, order: f.order === "" || f.order == null ? 100 : Number(f.order), confirm: f.confirm === true };
          for (const k of ["title_i18n", "cta_i18n", "category_i18n"]) { data[k] = {}; for (const l of ["ru", "en", "ua"]) { if (f[k + "_" + l]) data[k][l] = f[k + "_" + l]; delete data[k + "_" + l]; } }
          data.release_at = iso(f.release_at);
          const r = await run(btn, () => a.id ? api("PUT", "/announcements/" + a.id, data) : api("POST", "/announcements", data)); if (!r) return true; toast("Афиша сохранена"); route(); } }], { wide: true });
    bindPickers(body);
    const sync = () => { const f = readForm(body), banner = f.kind === "banner";
      body.querySelector("[data-banner]").hidden = !banner; body.querySelector("[data-poster]").hidden = banner;
      body.querySelector("#annpv").innerHTML = banner ? bannerPreview(f) : annCard({ ...f, event_at: f.event_at ? new Date(f.event_at).toISOString() : "" }); };
    body.addEventListener("input", sync); body.addEventListener("change", sync); sync();
  }

  /* ---------- Пользователи ---------- */
  const ROLE_LABEL = () => Object.fromEntries((ME.roles || []).map(r => [r.id, r.label]));
  const accessPill = u => u.blocked ? `<span class="pill bad">Заблокирован</span>` : u.academy_access ? `<span class="pill ok">Доступ открыт</span>` : u.stage === "deposit" ? `<span class="pill warn">Ждёт депозит</span>` : `<span class="pill">Нет Trader ID</span>`;
  async function usersView() {
    const RL = ROLE_LABEL();
    main.innerHTML = page("Пользователи", "Поиск по email, внутреннему ID, Telegram ID или @username") +
      `<div class="filters"><input type="search" id="uq" placeholder="Поиск" style="max-width:280px"><select id="ur"><option value="">Все роли</option>${Object.entries(RL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
      <select id="us"><option value="">Любой статус</option><option value="access">Доступ открыт</option><option value="awaiting">Ждут депозит</option><option value="review">Депозиты на проверке</option><option value="no_trader">Без Trader ID</option><option value="blocked">Заблокированы</option></select>
      <label class="f" style="flex-direction:row;align-items:center;gap:6px">с<input type="datetime-local" id="uf" style="width:auto"></label><label class="f" style="flex-direction:row;align-items:center;gap:6px">по<input type="datetime-local" id="ut" style="width:auto"></label></div><div id="ul"><p class="muted">Загрузка…</p></div>`;
    const load = async () => {
      const p = new URLSearchParams({ q: $("#uq").value, role: $("#ur").value, status: $("#us").value, from: $("#uf").value ? new Date($("#uf").value).toISOString() : "", to: $("#ut").value ? new Date($("#ut").value).toISOString() : "" });
      const { users } = await api("GET", "/users?" + p);
      $("#ul").innerHTML = users.length ? `<p class="muted">Найдено: ${users.length}${users.length >= 500 ? " (показаны первые 500)" : ""}</p><div class="table-wrap"><table><thead><tr><th>Пользователь</th><th>Роль</th><th>Академия</th><th class="hide-sm">Регистрация</th><th class="hide-sm">Активность</th></tr></thead><tbody>${users.map(u => `<tr><td><a href="#/users/${esc(u.uid)}"><b>${esc(u.email || u.uid)}</b></a>${u.telegram && u.telegram.username ? `<div class="muted">@${esc(u.telegram.username)}</div>` : ""}</td><td>${esc(RL[u.role] || u.role)}</td><td>${accessPill(u)}</td><td class="hide-sm num">${fmtDay(u.created_at)}</td><td class="hide-sm num">${fmtDate(u.last_active_at)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Никого не нашли. Измените условия поиска.</div>`;
    };
    ["uq"].forEach(i => ($("#" + i).oninput = () => { clearTimeout(usersView.t); usersView.t = setTimeout(load, 350); }));
    ["ur", "us", "uf", "ut"].forEach(i => ($("#" + i).onchange = load));
    await load();
  }
  async function userView(uid) {
    const RL = ROLE_LABEL();
    main.innerHTML = page("Пользователь", "") + `<p class="muted">Загрузка…</p>`;
    const d = await api("GET", "/users/" + encodeURIComponent(uid)), u = d.user;
    const myRank = ME.roles.findIndex(r => r.id === ME.role), theirRank = ME.roles.findIndex(r => r.id === u.role);
    const canRole = can("users.role") && u.uid !== ME.uid && myRank > theirRank, canBlock = can("users.block") && u.uid !== ME.uid && myRank > theirRank;
    main.innerHTML = page(u.email || u.uid, `<a href="#/users">← Все пользователи</a>`) +
      `<div class="grid two"><section class="panel"><h3>Профиль</h3>${u.telegram && u.telegram.photo_url ? `<img src="${esc(u.telegram.photo_url)}" alt="" width="56" height="56" style="border-radius:50%;float:right">` : ""}
        <p>ID: <b>${esc(u.uid)}</b><br>Роль: <b>${esc(RL[u.role] || u.role)}</b><br>Регистрация: ${fmtDate(u.created_at)}<br>Последняя активность: ${fmtDate(u.last_active_at)}<br>
        Telegram: ${u.telegram ? esc((u.telegram.username ? "@" + u.telegram.username : "") + " " + (u.telegram.name || "") + " (ID " + u.telegram.id + ")") : "не привязан"}</p>
        <p>${accessPill(u)} ${u.broker_confirmed ? `<span class="pill ok">Брокер подтверждён</span>` : ""}</p>
        <p>Trader ID: ${esc(u.trader_id_masked || "—")}<br>Первый депозит: ${u.first_deposit ? "$" + esc(u.first_deposit.amount) + " " + esc(u.first_deposit.currency) : "не подтверждён"}</p></section>
      <section class="panel"><h3>Управление</h3>${canRole ? `<label class="f">Роль<select id="rs">${ME.roles.slice(0, myRank).map(r => `<option value="${r.id}" ${r.id === u.role ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select></label><button class="btn" id="rsave" style="margin-top:8px">Изменить роль</button>` : `<p class="muted">Роль этого пользователя вы изменить не можете.</p>`}
        ${canBlock ? `<hr style="border:0;border-top:1px solid var(--line);margin:16px 0">${u.blocked ? `<button class="btn" id="unb">Разблокировать</button>` : `<label class="f">Причина блокировки<input type="text" id="br" maxlength="300"></label><button class="btn danger" id="blk" style="margin-top:8px">Заблокировать</button>`}` : ""}</section>
      ${depositsPanel(d)}<section class="panel"><h3>Обучение</h3>${d.progress.length ? `<div class="table-wrap"><table><thead><tr><th>Урок</th><th>Статус</th><th>Тест</th></tr></thead><tbody>${d.progress.map(p => `<tr><td>${esc(p.lesson_id)}</td><td>${p.completed ? `<span class="pill ok">Завершён ${fmtDay(p.completed_at)}</span>` : `<span class="pill">В процессе</span>`}</td><td>${p.quiz ? esc(p.quiz.best_percent ?? p.quiz.percent ?? "") + "%" : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Ученик ещё не начинал уроки.</p>`}</section>
      <section class="panel"><h3>История административных действий</h3>${d.audit.length ? `<div class="table-wrap"><table><tbody>${d.audit.map(l => `<tr><td class="num">${fmtDate(l.at)}</td><td>${esc(l.action)}</td><td class="muted">${esc(l.actor_email || "")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Действий не было.</p>`}</section></div>`;
    if ($("#rsave")) $("#rsave").onclick = e => run(e.currentTarget, async () => { await api("POST", `/users/${encodeURIComponent(u.uid)}/role`, { role: $("#rs").value }); toast("Роль изменена"); route(); });
    if ($("#blk")) $("#blk").onclick = () => confirmDlg("Заблокировать", "Пользователь потеряет доступ к академии и API, пока вы его не разблокируете.", "Заблокировать", async btn => { const r = await run(btn, () => api("POST", `/users/${encodeURIComponent(u.uid)}/block`, { blocked: true, reason: $("#br").value })); if (r) { toast("Пользователь заблокирован"); route(); } else return true; });
    if ($("#unb")) $("#unb").onclick = e => run(e.currentTarget, async () => { await api("POST", `/users/${encodeURIComponent(u.uid)}/block`, { blocked: false }); toast("Пользователь разблокирован"); route(); });
    main.querySelectorAll("[data-review]").forEach(btn => btn.onclick = () => {
      const [trader, key, decision] = btn.dataset.review.split("|");
      modal(decision === "count" ? "Засчитать депозит" : "Отклонить депозит", `<p>${decision === "count" ? "Засчитывайте, только если это действительно второе пополнение (а не повтор доставки postback): проверьте в Pocket Partners." : "Депозит не войдёт в сумму."}</p>
        <div class="form"><label class="f">Причина (обязательно)<input type="text" id="rvr" maxlength="500"></label><label class="check"><input type="checkbox" id="rvc"> Подтверждаю решение — оно попадёт в журнал аудита</label></div>`,
        [{ label: "Отмена", cls: "ghost", onClick: () => {} }, { label: decision === "count" ? "Засчитать" : "Отклонить", cls: decision === "count" ? "primary" : "danger", onClick: async b => {
          if (!$("#rvc").checked || !$("#rvr").value.trim()) { toast("Укажите причину и подтвердите", true); return true; }
          const r = await run(b, () => api("POST", `/deposits/${encodeURIComponent(trader)}/${encodeURIComponent(key)}/review`, { decision, reason: $("#rvr").value, confirm: true }));
          if (!r) return true; toast(r.access_opened ? "Депозит засчитан — доступ к академии открыт" : "Решение сохранено"); route(); } }]);
    });
  }
  function depositsPanel(d) {
    const p = d.user.deposit_progress, x = d.deposits; if (!x) return `<section class="panel"><h3>Депозиты и доступ</h3><p class="muted">Trader ID не привязан.</p></section>`;
    const $$ = c => "$" + (c / 100).toFixed(2), RS = { cumulative: "сумма депозитов от $50", persisted: "доступ сохранён в базе", legacy_ftd40: "прежнее правило (первый депозит от $40 до перехода)" };
    const ST = { counted: '<span class="pill ok">засчитан</span>', pending_review: '<span class="pill warn">ожидает проверки</span>', pending_registration: '<span class="pill warn">ждёт регистрацию</span>', pending_currency: '<span class="pill warn">ждёт валюту</span>', rejected_admin: '<span class="pill bad">отклонён администратором</span>' };
    return `<section class="panel"><h3>Депозиты и доступ</h3>
      <p>Trader ID: <b>${esc(x.trader_id)}</b> · Подтверждено: <b>${p ? $$(p.confirmed_cents) : "—"}</b> из $50.00${p && p.remaining_cents ? ` · осталось <b>${$$(p.remaining_cents)}</b>` : ""}<br>
      Доступ к академии: ${d.user.academy_access ? `<span class="pill ok">открыт</span> — ${esc(RS[d.user.access_reason] || "")}${x.access_granted ? ` · с ${fmtDate(x.access_granted.at)}` : ""}` : '<span class="pill">закрыт</span>'}<br>
      Реферер: ${x.referrer ? `<a href="#/users/${encodeURIComponent(x.referrer.referrer_uid)}">${esc(x.referrer.referrer_uid)}</a> · статус: <b>${esc(x.referrer.status || "—")}</b>` : "нет"}</p>
      ${x.events.length ? `<div class="table-wrap"><table><thead><tr><th>ID события</th><th>Тип</th><th>Сумма</th><th>Статус</th><th>Время</th><th></th></tr></thead><tbody>${x.events.map(e => `<tr><td class="muted" style="word-break:break-all">${esc(e.id)}</td><td>${esc(e.kind)}</td><td class="num">${e.amount_cents != null ? (e.amount_cents / 100).toFixed(2) : "—"} ${esc(e.currency || "?")}</td><td>${ST[e.status] || esc(e.status)}${e.review_reason ? `<div class="muted" style="font-size:12px">${esc(e.review_reason)}</div>` : ""}</td><td class="num">${fmtDate(e.at)}</td>
        <td>${e.status === "pending_review" && x.pending.some(q => q.key === e.id) ? `<button class="btn sm primary" data-review="${esc(x.trader_id)}|${esc(e.id)}|count">Засчитать…</button> <button class="btn sm danger" data-review="${esc(x.trader_id)}|${esc(e.id)}|reject">Отклонить…</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Подтверждённых событий депозита нет.</p>`}</section>`;
  }

  /* ---------- Журнал и импорт ---------- */
  async function auditView() {
    main.innerHTML = page("Журнал действий", "Кто, когда и что изменил") + `<div class="filters"><select id="af"><option value="">Все действия</option><option value="admin.">Входы в админ-панель</option><option value="course.">Курсы</option><option value="lesson.">Уроки</option><option value="module.">Модули</option><option value="user.">Пользователи и роли</option><option value="media.">Медиа</option><option value="announcement.">Афиши</option></select></div><div id="al"><p class="muted">Загрузка…</p></div>`;
    const load = async () => { const { logs } = await api("GET", "/audit?limit=300&action=" + encodeURIComponent($("#af").value));
      $("#al").innerHTML = logs.length ? `<div class="table-wrap"><table><thead><tr><th>Время</th><th>Действие</th><th class="hide-sm">Кто</th><th class="hide-sm">Объект</th><th class="hide-sm">Подробности</th></tr></thead><tbody>${logs.map(l => `<tr><td class="num">${fmtDate(l.at)}</td><td>${esc(l.action)}</td><td class="hide-sm">${esc(l.actor_email || l.actor_uid || "")}</td><td class="hide-sm">${esc((l.target_type || "") + " " + (l.target_id || ""))}</td><td class="hide-sm muted">${esc(JSON.stringify(l.details || {}).slice(0, 160))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Записей нет.</div>`; };
    $("#af").onchange = load; await load();
  }
  function importView() {
    main.innerHTML = page("Импорт курса", "Файл JSON в формате CMS. Курс всегда создаётся как черновик и не публикуется автоматически") +
      `<section class="panel form" style="margin-bottom:14px"><h3>Обновить переводы существующего курса</h3><p class="muted">Добавляет переводы EN/UA к уже импортированному курсу (совпадение по slug, модули и уроки — по порядку с проверкой русских названий). Содержание, ID уроков, ответы и прогресс учеников не меняются. Используйте файл content/hidden-reaction-course.json.</p>
        <input type="file" id="tf" accept="application/json,.json"><p class="muted" id="ti"></p><label class="check"><input type="checkbox" id="tc"> Обновить только переводы</label><button class="btn" id="tb" disabled>Обновить переводы</button><div id="tr"></div></section>
      <section class="panel form"><input type="file" id="if" accept="application/json,.json"><p class="muted" id="ii"></p>
      <label class="check"><input type="checkbox" id="ic"> Импортировать как новый курс-черновик (ученики его не увидят до публикации)</label><button class="btn primary" id="ib" disabled>Импортировать как черновик</button></section>`;
    let data = null;
    $("#if").onchange = async () => { data = null; $("#ib").disabled = true; const f = $("#if").files[0]; if (!f) return;
      try { data = JSON.parse(await f.text()); const m = data.modules || [], n = m.reduce((s, x) => s + (x.lessons || []).length, 0); $("#ii").textContent = `«${(data.course && data.course.title) || "без названия"}»: модулей ${m.length}, уроков ${n}.`; $("#ib").disabled = false; }
      catch (e) { $("#ii").textContent = "Файл не является корректным JSON."; } };
    $("#ib").onclick = e => run(e.currentTarget, async () => { if (!$("#ic").checked) { toast("Отметьте подтверждение импорта", true); return; }
      let r; try { r = await api("POST", "/import/course", { confirm: true, data }); }
      catch (er) { if (er && er.error === "ALREADY_IMPORTED" && er.course_id) { toast(er.message, true); location.hash = "#/courses/" + er.course_id; return; } throw er; } toast(`Импортировано: модулей ${r.modules}, уроков ${r.lessons}`); location.hash = "#/courses/" + r.course_id; });
    bindTranslations();
  }

  /* ---------- Диагностика (Super Admin): версия кода и фактические данные Firestore ---------- */
  async function diagnosticsView() {
    main.innerHTML = page("Диагностика", "Только чтение. Показывает, какая версия кода работает и что реально лежит в Firestore") + `<p class="muted">Загрузка…</p>`;
    const d = await api("GET", "/diagnostics"), v = d.version;
    const okFmt = v.content_format === "candles-objects-v1";
    main.innerHTML = page("Диагностика", "Только чтение. Показывает, какая версия кода работает и что реально лежит в Firestore", `<button class="btn" id="rf">Обновить</button>`) +
      `<div class="grid two"><section class="panel"><h3>Версия сервера</h3><p>Коммит GitHub: <b>${esc(v.commit ? v.commit.slice(0, 12) : "неизвестен (переменная RENDER_GIT_COMMIT не задана)")}</b>${v.branch ? ` · ветка ${esc(v.branch)}` : ""}<br>
        Сервис: ${esc(v.service || "—")} · пакет ${esc(v.package || "—")} · Node ${esc(v.node)}<br>Сервер запущен: ${fmtDate(v.started_at)}</p>
        <p>${okFmt ? `<span class="pill ok">Формат графиков исправлен (${esc(v.content_format)})</span>` : `<span class="pill bad">Старый формат графиков — импорт курса с графиками будет падать</span>`}</p></section>
      <section class="panel"><h3>Firebase Storage (изображения)</h3><p>${d.storage && d.storage.ok ? `<span class="pill ok">Работает</span> бакет ${esc(d.storage.bucket)}` : `<span class="pill bad">${esc((d.storage && d.storage.code) || "нет данных")}</span><br>${esc((d.storage && d.storage.hint) || "")}`}</p></section>
      <section class="panel"><h3>Реферальная программа</h3><p>Учёт: <b>${d.referral && d.referral.tracking ? "включён" : "выключен"}</b> · Начисления: <b>${d.referral && d.referral.rewards ? esc(d.referral.mode) : "выключены"}</b> · Вывод: <b>${d.referral && d.referral.payouts ? "включён" : "выключен"}</b>${d.referral && d.referral.warning ? `<br><span class="pill bad">${esc(d.referral.warning)}</span>` : ""}</p></section>
      <section class="panel"><h3>Перевод опубликованных курсов</h3>${(d.translations || []).length ? d.translations.map(t => `<p><b>${esc(t.title)}</b> — уроков ${esc(t.lessons)}<br>${["en", "ua"].map(l => { const x = t[l]; const ok = x.complete === t.lessons; return `${l.toUpperCase()}: ${ok ? `<span class="pill ok">полностью (${esc(x.complete)}/${esc(t.lessons)})</span>` : `<span class="pill bad">переведено ${esc(x.complete)}/${esc(t.lessons)}, без перевода ${esc(x.without_translation)}, устаревших строк ${esc(x.missing_strings)}</span>`}`; }).join("<br>")}</p>`).join("") : `<p class="muted">Опубликованных курсов нет.</p>`}</section>
      <section class="panel"><h3>Целостность</h3><p>Модулей без курса: <b>${esc(d.modules_without_course)}</b><br>Уроков без курса: <b>${esc(d.lessons_without_course)}</b></p></section></div>
      <h3 style="font:600 15px var(--body);margin:20px 0 10px">Курсы в Firestore: ${d.courses.length}</h3>
      ${d.courses.length ? d.courses.map(c => `<section class="panel" style="margin-bottom:12px"><h3><a href="#/courses/${esc(c.id)}">${esc(c.title)}</a> <span class="muted">${esc(c.id)}</span></h3>
        <p class="muted">Статус: ${esc(c.status)}${c.imported ? " · импортирован" : ""}${c.slug ? " · slug " + esc(c.slug) : ""} · создан ${fmtDate(c.created_at)} · уроков всего ${esc(c.lessons_total)}${c.orphan_lessons ? ` · <b style="color:var(--bad)">уроков без модуля: ${esc(c.orphan_lessons)}</b>` : ""}
        · ${c.published ? `опубликован (версия ${esc(c.published.version)}, уроков в снимке ${esc(c.published.lessons)})` : "не опубликован"}</p>
        <div class="table-wrap"><table><thead><tr><th>Модуль</th><th>Уроков</th><th>Готово</th></tr></thead><tbody>${c.modules.map(m => `<tr><td>${esc(m.title)}</td><td class="num">${m.lessons ? esc(m.lessons) : `<span class="pill bad">0 — пустой</span>`}</td><td class="num">${esc(m.ready)}</td></tr>`).join("")}</tbody></table></div></section>`).join("") : `<div class="empty">Курсов нет.</div>`}`;
    $("#rf").onclick = () => route();
  }

  /* ---------- Партнёры и выплаты ---------- */
  const usd = c => "$" + ((c || 0) / 100).toFixed(2);
  const INV = { registered: "Зарегистрирован", trader_confirmed: "Trader ID подтверждён", ftd_confirmed: "Депозит подтверждён", access_granted: "Доступ выдан", qualified: "Подходит", rewarded: "Вознаграждён", flagged: "На проверке" };
  const WST = { pending: ["warn", "Ожидает обработки"], processing: ["info", "В обработке"], paid: ["ok", "Выплачено"], rejected: ["bad", "Отклонено"], cancelled: ["", "Отменено"] };
  const modeNote = m => m === "off" ? `<span class="pill bad">Денежная часть отключена (REFERRAL_MODE=off)</span>` : m === "test" ? `<span class="pill warn">Тестовый режим — суммы не реальные</span>` : `<span class="pill ok">Боевой режим</span>`;
  async function partnersView(uid) {
    if (uid) return partnerView(decodeURIComponent(uid));
    main.innerHTML = page("Партнёры и выплаты", "Только реальные данные Firestore") + `<p class="muted">Загрузка…</p>`;
    const st = await api("GET", "/partners/stats");
    main.innerHTML = page("Партнёры и выплаты", "Только реальные данные Firestore") + `<p>${modeNote(st.mode)}</p>
      <div class="grid stats"><div class="stat"><span>Приглашений</span><b>${esc(st.invites_total)}</b></div>${Object.entries(st.invites_by_status).map(([k, v]) => `<div class="stat"><span>${esc(INV[k] || k)}</span><b>${esc(v)}</b></div>`).join("")}
      <div class="stat"><span>Заявки в работе</span><b>${usd(st.pending_amount_cents)}</b></div><div class="stat"><span>Выплачено</span><b>${usd(st.paid_amount_cents)}</b></div></div>
      <section class="panel" style="margin-bottom:14px"><h3>Сверка исторических приглашений</h3><p class="muted">Приглашённые, у которых доступ к академии открылся до включения начислений (или в неизвестное время). Автоматически им $10 не начисляется. Предпросмотр денег не начисляет; начисление — только по отмеченным строкам, с причиной (супер-администратор).</p>
        <button class="btn" id="hpv">Предпросмотр</button><div id="hlist"></div></section>
      <section class="panel" style="margin-bottom:14px"><h3>Поиск партнёра</h3><form class="filters" id="pf"><input type="search" id="pq" placeholder="UID, Trader ID или реферальный код" style="max-width:340px"><button class="btn primary">Найти</button></form><div id="pr"></div></section>
      <section class="panel"><h3>Заявки на вывод</h3><div class="filters"><select id="wsf"><option value="">Все</option>${Object.entries(WST).map(([k, v]) => `<option value="${k}" ${k === "pending" ? "selected" : ""}>${v[1]}</option>`).join("")}</select></div><div id="wl"></div></section>`;
    $("#pf").onsubmit = async e => { e.preventDefault(); const r = await api("GET", "/partners?q=" + encodeURIComponent($("#pq").value.trim()));
      $("#pr").innerHTML = r.results.length ? `<div class="table-wrap"><table><thead><tr><th>Партнёр</th><th>Код</th><th>Trader ID</th><th>Приглашено</th></tr></thead><tbody>${r.results.map(x => `<tr><td><a href="#/partners/${encodeURIComponent(x.uid)}">${esc(x.email || x.uid)}</a><div class="muted">${esc(x.uid)}</div></td><td>${esc(x.ref_code || "—")}</td><td>${esc(x.trader_id_masked || "—")}</td><td class="num">${esc(x.invited)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Не найдено</div>`; };
    const loadW = async () => { const r = await api("GET", "/withdrawals?status=" + encodeURIComponent($("#wsf").value)); $("#wl").innerHTML = withdrawalsTable(r.withdrawals, true); bindW(); };
    $("#wsf").onchange = loadW; await loadW();
    bindHistorical();
  }
  function withdrawalsTable(ws, withUser) {
    if (!ws.length) return `<div class="empty">Заявок нет</div>`;
    return `<div class="table-wrap"><table><thead><tr><th>Создана</th>${withUser ? "<th>Партнёр</th>" : ""}<th>Сумма</th><th>Trader ID</th><th>Статус</th><th>Действия</th></tr></thead><tbody>${ws.map(w => `<tr><td class="num">${fmtDate(w.created_at)}<div class="muted">${esc(w.id)}</div></td>${withUser ? `<td><a href="#/partners/${encodeURIComponent(w.uid)}">${esc(w.uid)}</a></td>` : ""}<td class="num">${usd(w.amount_cents)} ${w.mode === "test" ? '<span class="pill warn">test</span>' : ""}</td><td><b style="user-select:all">${esc(w.trader_id || "—")}</b>${w.trader_id ? ` <button class="btn sm" data-copy-tid="${esc(w.trader_id)}" title="Копировать">Копировать</button>` : ""}</td><td><span class="pill ${WST[w.status][0]}">${WST[w.status][1]}</span><div class="muted" style="font-size:12px">${esc(((w.history || []).slice(-1)[0] || {}).note || "")}</div></td>
      <td>${can("finance.payouts") ? `${w.status === "pending" ? `<button class="btn sm" data-ws="processing" data-wid="${esc(w.id)}">В обработку</button>` : ""}${["pending", "processing"].includes(w.status) ? `<button class="btn sm danger" data-ws="rejected" data-wid="${esc(w.id)}">Отклонить</button>` : ""}${w.status === "processing" ? `<button class="btn sm primary" data-ws="paid" data-wid="${esc(w.id)}">Подтвердить выплату…</button>` : ""}${w.paid_at ? `<div class="muted" style="font-size:12px">выплачено ${fmtDate(w.paid_at)}${w.payment_reference ? " · " + esc(w.payment_reference) : ""}</div>` : ""}` : ""}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function bindW() {
    main.querySelectorAll("[data-copy-tid]").forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copyTid); toast("Trader ID скопирован"); } catch (e) { toast("Скопируйте вручную", true); } });
    main.querySelectorAll("[data-ws]").forEach(b => b.onclick = async () => {
      const to = b.dataset.ws, wid = b.dataset.wid;
      if (to === "rejected" && !REASONS.list) { try { const rr = await api("GET", "/reject-reasons"); REASONS.list = rr.reasons; REASONS.translation = rr.translation; } catch (e) { REASONS.list = []; } }
      if (to === "processing") return run(b, async () => { await api("POST", `/withdrawals/${encodeURIComponent(wid)}/status`, { status: "processing" }); toast("Заявка в обработке"); route(); });
      modal(to === "paid" ? "Подтверждение выплаты" : "Отклонить заявку", to === "paid"
        ? `<p>Нажимайте только <b>после</b> того, как вы вручную перевели средства через Pocket Partners. Кнопка не отправляет деньги — она фиксирует уже выполненный перевод. Статус «Выплачено» нельзя отменить.</p><label class="f">Номер / ссылка платежа<input type="text" id="pref" maxlength="200"></label><label class="check" style="margin-top:10px"><input type="checkbox" id="pcf"> Выплата фактически выполнена и проверена</label>`
        : `<label class="f">Стандартная причина (готовые переводы RU / EN / UA)<select id="rcode"><option value="">— своя причина —</option>${(REASONS.list || []).map(r => `<option value="${esc(r.code)}">${esc(r.ru)}</option>`).join("")}</select></label>
           <label class="f">Своя причина — по-русски<textarea id="rsn" maxlength="500" placeholder="Заявка отклонена: …"></textarea></label>
           <label class="f">Перевод на английский (необязательно)<textarea id="rsnEn" maxlength="500" placeholder="Request rejected: …"></textarea></label>
           <label class="f">Переклад українською (необязательно)<textarea id="rsnUa" maxlength="500" placeholder="Заявку відхилено: …"></textarea><small>${REASONS.translation === "deepl" ? "Будет переведена на EN и UA один раз при сохранении (DeepL)." : "Автоперевод не настроен (DEEPL_API_KEY): на EN/UA партнёр увидит нейтральное сообщение, русский текст сохранится. Для точного перевода выберите стандартную причину."}</small></label>
           <p class="muted">Резерв вернётся на доступный баланс ровно один раз. Причина сохраняется в истории и журнале.</p>`,
        [{ label: "Отмена", cls: "ghost", onClick: () => {} }, { label: to === "paid" ? "Подтвердить выплату" : "Отклонить", cls: to === "paid" ? "primary" : "danger", onClick: async btn => {
          const body = to === "paid" ? { status: "paid", confirm: $("#pcf").checked, payment_reference: $("#pref").value } : { status: "rejected", reason_code: $("#rcode").value || undefined, note: $("#rsn").value, note_en: $("#rsnEn").value, note_ua: $("#rsnUa").value };
          if (to === "rejected" && !body.reason_code && !body.note.trim()) { toast("Укажите причину", true); return true; }
          const r = await run(btn, () => api("POST", `/withdrawals/${encodeURIComponent(wid)}/status`, body)); if (!r) return true; toast(to === "paid" ? "Выплата отмечена" : "Заявка отклонена"); route(); } }]);
    });
  }
  const REASONS = { list: null, translation: "unavailable" };
  /* Сверка исторических приглашений: предпросмотр → отметить → подтвердить с причиной */
  function bindHistorical() {
    const btn = $("#hpv"); if (!btn) return;
    btn.onclick = () => run(btn, async () => {
      const r = await api("GET", "/referrals/historical");
      if (!r.rewards) { $("#hlist").innerHTML = `<p class="muted">Начисления выключены (REFERRAL_MODE=off) — сверка не нужна.</p>`; return; }
      if (!r.items.length) { $("#hlist").innerHTML = `<p class="muted">Исторических приглашений без начисления нет.</p>`; return; }
      const AR = { cumulative: "сумма депозитов от $50", persisted: "сохранённый доступ", legacy_ftd40: "прежнее правило (первый депозит от $40)" };
      $("#hlist").innerHTML = `<div class="table-wrap"><table><thead><tr><th></th><th>Приглашённый</th><th>Партнёр</th><th>Пришёл</th><th>Доступ</th><th>Начисление</th></tr></thead><tbody>${r.items.map(x => `<tr>
        <td><input type="checkbox" data-h="${esc(x.invitee_uid)}" ${x.already_rewarded ? "disabled" : ""}></td><td>${esc(x.invitee_email || x.invitee_uid)}<div class="muted" style="font-size:12px">${esc(x.invitee_uid)}</div></td>
        <td><a href="#/partners/${encodeURIComponent(x.referrer_uid)}">${esc(x.referrer_email || x.referrer_uid)}</a></td><td class="num">${fmtDate(x.joined_at)}</td>
        <td>${esc(AR[x.access_reason] || x.access_reason || "—")}${x.access_at ? `<div class="muted" style="font-size:12px">${fmtDate(x.access_at)}</div>` : ""}</td><td>${x.already_rewarded ? '<span class="pill ok">уже есть</span>' : '<span class="pill warn">нет</span>'}</td></tr>`).join("")}</tbody></table></div>
        <div class="form" style="margin-top:10px"><label class="f">Причина (обязательно)<input type="text" id="hrsn" maxlength="300" placeholder="Доступ открыт до включения программы, проверено"></label>
        <label class="check"><input type="checkbox" id="hcf"> Подтверждаю: по отмеченным приглашённым начислить партнёрам по $10 (одно начисление на приглашённого)</label><button class="btn primary" id="hap">Начислить отмеченным</button></div>`;
      $("#hap").onclick = e => run(e.currentTarget, async () => {
        const ids = [...main.querySelectorAll("[data-h]:checked")].map(c => c.dataset.h);
        if (!ids.length || !$("#hcf").checked || !$("#hrsn").value.trim()) { toast("Отметьте строки, укажите причину и подтвердите", true); return; }
        const res = await api("POST", "/referrals/historical/approve", { invitee_uids: ids, reason: $("#hrsn").value, confirm: true });
        toast(`Готово: начислено ${res.results.filter(x => x.status === "rewarded").length} из ${ids.length}`); $("#hpv").click();
      });
    });
  }
  async function partnerView(uid) {
    main.innerHTML = page("Партнёр", "") + `<p class="muted">Загрузка…</p>`;
    const d = await api("GET", "/partners/" + encodeURIComponent(uid));
    const bal = d.balances[d.mode] || d.balances.test || d.balances.live || {};
    main.innerHTML = page(d.email || d.uid, `<a href="#/partners">← Партнёры</a>`, `<button class="btn" id="pev">Пересчитать статусы</button>`) + `<p>${modeNote(d.mode)}</p>
      <div class="grid two"><section class="panel"><h3>Партнёр</h3><p>UID: <b>${esc(d.uid)}</b><br>Email: <b>${esc(d.email || "—")}</b><br>Регистрация: <b>${fmtDate(d.created_at)}</b><br>Реферальный код: <b>${esc(d.ref_code || "—")}</b><br>Trader ID: <b>${esc(d.trader_id || "не подтверждён")}</b><br>Доступ к академии: ${d.academy_access ? '<span class="pill ok">есть</span>' : '<span class="pill">нет</span>'}</p></section>
      <section class="panel"><h3>Приглашённые</h3><p>${[["invited", "Приглашено"], ["trader_confirmed", "Trader ID"], ["ftd_confirmed", "FTD"], ["access_granted", "Доступ"], ["qualified", "Подходят"], ["rewarded", "Начислено"], ["flagged", "На проверке"]].map(([k, l]) => `${l}: <b>${esc((d.counts || {})[k] ?? 0)}</b>`).join(" · ")}</p></section>
      <section class="panel"><h3>Баланс ${d.mode !== "off" ? "(" + esc(d.mode) + ")" : ""}</h3><p>Доступно: <b>${usd(bal.available_cents)}</b> · В резерве: <b>${usd(bal.reserved_cents)}</b> · Выплачено: <b>${usd(bal.paid_cents)}</b> · Начислено всего: <b>${usd(bal.earned_cents)}</b></p>
        ${can("finance.adjust") && d.mode !== "off" ? `<form class="form" id="adj"><h3 style="margin:8px 0 0">Ручное начисление / корректировка</h3><div class="form cols"><label class="f">Тип<select id="aty"><option value="credit">Начисление (+)</option><option value="debit">Списание (−)</option></select></label><label class="f">Сумма<input type="number" step="0.01" min="0.01" id="aam"></label><label class="f">Валюта<select id="acu"><option>USD</option></select></label></div>
          <label class="f">Причина (обязательно)<input type="text" id="ars" maxlength="500"></label><label class="f">Комментарий<input type="text" id="acm" maxlength="500"></label><label class="check"><input type="checkbox" id="acf"> Подтверждаю операцию — она попадёт в финансовый журнал и аудит</label><button class="btn">Провести операцию</button></form>` : ""}</section></div>
      <section class="panel" style="margin-top:14px"><h3>Приглашённые (${d.invites.length})</h3>${d.invites.length ? `<div class="table-wrap"><table><thead><tr><th>Пользователь</th><th>Trader ID</th><th>Статус</th><th>Флаги</th><th>Дата</th></tr></thead><tbody>${d.invites.map(i => `<tr><td>${esc(i.email || i.invitee_uid)}<div class="muted">${esc(i.invitee_uid)}</div></td><td>${esc(i.trader_id_masked || "—")}</td><td>${esc(INV[i.status] || i.status)}</td><td>${(i.flags || []).map(f => `<span class="pill warn">${esc(f)}</span>`).join(" ")}</td><td class="num">${fmtDay(i.created_at)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Приглашённых нет</div>`}</section>
      <section class="panel" style="margin-top:14px"><h3>Заявки на вывод</h3>${withdrawalsTable(d.withdrawals, false)}</section>
      <section class="panel" style="margin-top:14px"><h3>Журнал операций</h3>${d.ledger.length ? `<div class="table-wrap"><table><thead><tr><th>Время</th><th>Операция</th><th>Сумма</th><th>Причина</th><th>ID</th></tr></thead><tbody>${d.ledger.map(e => `<tr><td class="num">${fmtDate(e.created_at)}</td><td>${esc(e.type)} ${e.mode === "test" ? '<span class="pill warn">test</span>' : ""}</td><td class="num">${e.amount_cents ? usd(e.amount_cents) : "—"}</td><td>${esc(e.reason || "")}</td><td class="muted">${esc(e.id)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Операций нет</div>`}</section>`;
    $("#pev").onclick = e => run(e.currentTarget, async () => { const r = await api("POST", `/partners/${encodeURIComponent(uid)}/evaluate`, {}); toast("Пересчитано приглашений: " + r.invites); route(); });
    if ($("#adj")) { const opId = "op-" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      $("#adj").onsubmit = e => { e.preventDefault(); if (!$("#acf").checked) { toast("Подтвердите операцию", true); return; } if (!$("#ars").value.trim()) { toast("Укажите причину", true); return; }
        run(e.submitter, async () => { await api("POST", `/partners/${encodeURIComponent(uid)}/adjust`, { type: $("#aty").value, amount: Number($("#aam").value), currency: $("#acu").value, reason: $("#ars").value, comment: $("#acm").value, confirm: true, op_id: opId }); toast("Операция записана"); route(); }); }; }
    bindW();
  }

  /* «Обновить переводы»: только поле tr у курса, модулей и уроков */
  function bindTranslations() {
    let tdata = null;
    $("#tf").onchange = async () => { const f = $("#tf").files[0]; tdata = null; $("#tb").disabled = true;
      try { tdata = JSON.parse(await f.text()); const n = (tdata.modules || []).reduce((x, m) => x + (m.lessons || []).filter(l => l.tr).length, 0);
        $("#ti").textContent = `Курс «${tdata.course && tdata.course.title}», уроков с переводами: ${n}`; $("#tb").disabled = !n; }
      catch (e) { $("#ti").textContent = "Файл не прочитан: " + e.message; } };
    $("#tb").onclick = e => run(e.currentTarget, async () => { if (!$("#tc").checked) { toast("Отметьте подтверждение", true); return; }
      const r = await api("POST", "/import/translations", { confirm: true, data: tdata });
      $("#tr").innerHTML = `<p>Обновлено: модулей ${esc(r.modules)}, уроков ${esc(r.lessons)}.</p>${r.skipped.length ? `<p class="muted">Пропущено:<br>${r.skipped.map(esc).join("<br>")}</p>` : ""}<p><b>${esc(r.note)}</b></p>`; toast("Переводы обновлены"); });
  }

  /* ---------- Блокировка аккаунтов (статус академии; данные пользователя не удаляются) ---------- */
  async function bansView() {
    main.innerHTML = page("Блокировка аккаунтов", "Заблокированный пользователь видит страницу «аккаунт не активен»; сервер закрывает все API академии. Баланс, начисления, заявки и прогресс сохраняются.") +
      `<section class="panel" style="margin-bottom:14px"><form class="form" id="bf"><label class="f">UID пользователя<input type="text" id="buid" maxlength="128" autocomplete="off" placeholder="внутренний UID аккаунта"></label><button class="btn primary">Найти</button></form></section><div id="bres"></div>`;
    const show = async uid => {
      const d = await api("GET", `/users/${encodeURIComponent(uid)}`); const u = d.user;
      const raw = await api("GET", `/users/${encodeURIComponent(uid)}/ban`).catch(() => ({}));
      $("#bres").innerHTML = `<section class="panel"><h3>${esc(u.email || u.uid)}</h3>
        <p>UID: <b style="user-select:all">${esc(u.uid)}</b> · Роль: <b>${esc(u.role)}</b><br>Статус: ${u.blocked ? '<span class="pill bad">заблокирован</span>' : '<span class="pill ok">активен</span>'}
        ${u.blocked ? `<br>Заблокирован: <b>${fmtDate(raw.blocked_at)}</b> · администратор: <b>${esc(raw.blocked_by_email || raw.blocked_by || "—")}</b><br>Причина (внутренняя): ${esc(raw.blocked_reason || "—")}` : (raw.unblocked_at ? `<br>Последняя разблокировка: ${fmtDate(raw.unblocked_at)}` : "")}</p>
        ${u.blocked ? `<button class="btn" id="bun">Разблокировать</button>`
          : `<div class="form"><label class="f">Причина блокировки (только для аудита, пользователю не показывается)<input type="text" id="brsn" maxlength="300"></label><label class="check"><input type="checkbox" id="bcf"> Подтверждаю блокировку доступа к академии</label><button class="btn danger" id="bblk">Заблокировать</button></div>`}</section>`;
      if ($("#bblk")) $("#bblk").onclick = e => { if (!$("#bcf").checked || !$("#brsn").value.trim()) { toast("Укажите причину и подтвердите", true); return; }
        run(e.currentTarget, async () => { await api("POST", `/users/${encodeURIComponent(uid)}/block`, { blocked: true, reason: $("#brsn").value }); toast("Аккаунт заблокирован"); show(uid); }); };
      if ($("#bun")) $("#bun").onclick = e => run(e.currentTarget, async () => { await api("POST", `/users/${encodeURIComponent(uid)}/block`, { blocked: false }); toast("Аккаунт разблокирован"); show(uid); });
    };
    $("#bf").onsubmit = e => { e.preventDefault(); const uid = $("#buid").value.trim(); if (!uid) return; run(e.submitter, () => show(uid).catch(x => { $("#bres").innerHTML = `<div class="empty">${esc(errText(x))}</div>`; })); };
  }

  /* ---------- Партнёрские ссылки Pocket Partners ---------- */
  async function linksView() {
    main.innerHTML = page("Партнёрские ссылки", "Ссылки Pocket Partners для стримеров и партнёров. Кнопка регистрации у брокера откроет ссылку партнёра, по которому пришёл пользователь", `<button class="btn primary" id="nl">Новый партнёр</button>`) + `<div id="ll"><p class="muted">Загрузка…</p></div>`;
    const r = await api("GET", "/partner-links");
    const academyLink = code => location.origin + "/academy/?via=" + encodeURIComponent(code);
    $("#ll").innerHTML = `<p class="muted">Разрешённые домены ссылок: ${esc(r.allowed_hosts.join(", "))}. Число пользователей — фактически закреплённые аккаунты; регистрации и депозиты учитываются только по postback.</p>` + (r.links.length ? `<div class="table-wrap"><table><thead><tr><th>Партнёр</th><th>Ссылка Academy</th><th>Ссылка Pocket Partners</th><th>Пользователей</th><th>Статус</th><th></th></tr></thead><tbody>${r.links.map(l => `<tr><td><b>${esc(l.name)}</b><div class="muted">${esc(l.code)} · ${fmtDay(l.created_at)}</div></td>
      <td><code class="muted" style="word-break:break-all">${esc(academyLink(l.code))}</code><br><button class="btn sm" data-copy="${esc(academyLink(l.code))}">Копировать</button></td>
      <td><code class="muted" style="word-break:break-all">${esc(l.pocket_url)}</code><br><button class="btn sm" data-copy="${esc(l.pocket_url)}">Копировать</button></td>
      <td class="num">${esc(l.users_count)}</td><td>${l.status === "active" ? '<span class="pill ok">активна</span>' : '<span class="pill">отключена</span>'}</td>
      <td><button class="btn sm" data-edit="${esc(l.code)}">Изменить</button> <button class="btn sm ${l.status === "active" ? "danger" : ""}" data-toggle="${esc(l.code)}" data-to="${l.status === "active" ? "disabled" : "active"}">${l.status === "active" ? "Отключить" : "Включить"}</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Партнёров пока нет.</div>`);
    main.querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast("Скопировано"); } catch (e) { toast("Скопируйте вручную", true); } });
    main.querySelectorAll("[data-toggle]").forEach(b => b.onclick = () => run(b, async () => { await api("PUT", "/partner-links/" + encodeURIComponent(b.dataset.toggle), { status: b.dataset.to }); toast(b.dataset.to === "active" ? "Ссылка включена" : "Ссылка отключена"); route(); }));
    const form = l => modal(l ? "Изменить партнёра" : "Новый партнёр", `<div class="form"><label class="f">Имя партнёра / стримера<input type="text" id="lname" maxlength="80" value="${esc(l ? l.name : "")}"></label>
        <label class="f">Код (часть ссылки Academy)<small>латиница, цифры, «-» и «_», 3–32 символа; после создания не меняется</small><input type="text" id="lcode" maxlength="32" value="${esc(l ? l.code : "")}" ${l ? "disabled" : ""}></label>
        <label class="f">Полная ссылка Pocket Partners<small>вставьте целиком — все параметры (utm, a, ac, code…) сохраняются без изменений</small><textarea id="lurl" maxlength="1500">${esc(l ? l.pocket_url : "")}</textarea></label></div>`,
      [{ label: "Отмена", cls: "ghost", onClick: () => {} }, { label: "Сохранить", cls: "primary", onClick: async btn => {
        const body = { name: $("#lname").value, pocket_url: $("#lurl").value.trim() };
        const r = await run(btn, () => l ? api("PUT", "/partner-links/" + encodeURIComponent(l.code), body) : api("POST", "/partner-links", { ...body, code: $("#lcode").value }));
        if (!r) return true; toast("Сохранено"); route(); } }]);
    $("#nl").onclick = () => form(null);
    main.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => form(r.links.find(x => x.code === b.dataset.edit)));
  }

  /* ---------- Маршрутизация ---------- */
  /* ---------- ИИ-помощник: модель, лимиты, бюджет, расход ---------- */
  async function mentorView() {
    const my = SEQ; const st = await api("GET", "/mentor/status"); if (my !== SEQ) return;
    const u = st.usage, bd = st.budget, set = bd.settings, money = x => "$" + Number(x || 0).toFixed(x < 1 ? 4 : 2);
    const row = (l, x) => `<tr><td>${l}</td><td>${x.requests}</td><td>${x.errors}</td><td>${x.input_tokens.toLocaleString("ru-RU")}</td><td>${x.output_tokens.toLocaleString("ru-RU")}</td><td>$${x.cost_usd.toFixed(4)}</td></tr>`;
    const FN = { mentor: "Наставник (текст)", vision: "Разбор скриншотов", daily: "Генерация Daily Tests" };
    const lvl = bd.total.warning_level, warn = lvl >= 100 ? ["bad", "Месячный бюджет исчерпан: платные запросы ИИ остановлены. Уроки и Daily Tests из одобренного банка работают."]
      : lvl >= 95 ? ["bad", "Израсходовано 95% месячного бюджета."] : lvl >= 85 ? ["warn", "Израсходовано 85% месячного бюджета."] : lvl >= 70 ? ["warn", "Израсходовано 70% месячного бюджета."] : null;
    const price = m => (set.prices || {})[m] || { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    main.innerHTML = page("ИИ-помощник", "Ответы формирует Claude API на сервере. Ключ хранится только в переменной Render ANTHROPIC_API_KEY.") +
      (!st.configured ? `<div class="note bad" id="mNoKey"><b>Ключ не подключён.</b> Добавьте переменную ANTHROPIC_API_KEY в Render → Environment — до этого ученики видят «ИИ-помощник ещё не подключён».</div>` : "") +
      (warn ? `<div class="note ${warn[0]}" id="mBudgetWarn" data-level="${lvl}">${warn[1]}</div>` : "") +
      `<div class="grid two"><div class="panel"><h3>Подключение</h3><table>
        <tr><td>Ключ API</td><td id="mKey">${st.configured ? "подключён" : "<b>не подключён</b>"}</td></tr>
        <tr><td>Текст</td><td id="mModel">${esc(st.model)}</td></tr><tr><td></td><td class="muted">усилие ${esc(st.effort)}, до ${st.max_tokens} токенов ответа</td></tr>
        <tr><td>Скриншоты</td><td id="mVisionModel">${esc(st.vision_model)}</td></tr><tr><td></td><td class="muted">усилие ${esc(st.vision_effort)}, до ${st.vision_max_tokens} токенов ответа</td></tr>
        <tr><td>Кэширование промпта</td><td>${st.prompt_cache ? "включено" : "выключено"}</td></tr></table>
        <p class="muted" style="font-size:12.5px">Меняются переменными Render без правки кода: AI_MENTOR_MODEL, AI_MENTOR_EFFORT, AI_MENTOR_MAX_TOKENS, AI_MENTOR_VISION_MODEL, AI_MENTOR_VISION_EFFORT, AI_MENTOR_VISION_MAX_TOKENS, AI_MENTOR_PROMPT_CACHE. Лимит ответа — потолок стоимости одного ответа.</p></div>
      <div class="panel"><h3>Бюджет за ${esc(bd.month)} (по Берлину)</h3><table id="mBudget">
        <tr><td>Лимит</td><td>${money(bd.total.cap_usd)}</td></tr><tr><td>Потрачено</td><td id="mSpent">${money(bd.total.spent_usd)}</td></tr>
        <tr><td>Зарезервировано (идут запросы)</td><td>${money(bd.total.reserved_usd)}</td></tr><tr><td>Осталось</td><td id="mLeft">${money(bd.total.left_usd)}</td></tr>
        <tr><td>Использовано</td><td><b>${bd.total.percent}%</b></td></tr><tr><td>Прогноз до конца месяца</td><td id="mForecast">${money(bd.total.forecast_usd)}</td></tr></table></div></div>
      <div class="panel" style="margin-top:16px"><h3>По функциям</h3><table id="mFeatures"><tr><th>Функция</th><th>Лимит</th><th>Потрачено</th><th>Резерв</th><th>%</th><th>Запросы</th><th>Ошибки</th><th>Токены вход / выход</th></tr>
        ${Object.entries(bd.features).map(([k, x]) => `<tr data-feature="${k}"><td>${FN[k] || k}</td><td>${money(x.cap_usd)}</td><td>${money(x.spent_usd)}</td><td>${money(x.reserved_usd)}</td><td>${x.percent}%</td><td>${x.requests}</td><td>${x.errors}</td><td>${x.input_tokens.toLocaleString("ru-RU")} / ${x.output_tokens.toLocaleString("ru-RU")}</td></tr>`).join("")}
        <tr><td>Общий резерв</td><td>${money(bd.reserve_usd)}</td><td colspan="6" class="muted">используется функцией, исчерпавшей свою долю</td></tr></table></div>
      <div class="grid two" style="margin-top:16px"><div class="panel"><h3>Лимиты</h3><div class="form" id="mBudgetForm">
        <div class="form cols"><label class="f">Общий лимит в месяц, $<input type="number" name="monthly_total_usd" min="0" step="0.01" value="${set.monthly_total_usd}"></label><label class="f">Общий резерв, $<input type="number" name="reserve_usd" min="0" step="0.01" value="${set.reserve_usd}"></label></div>
        <div class="form cols"><label class="f">Наставник, $<input type="number" name="f_mentor" min="0" step="0.01" value="${set.features.mentor}"></label><label class="f">Скриншоты, $<input type="number" name="f_vision" min="0" step="0.01" value="${set.features.vision}"></label><label class="f">Daily Tests, $<input type="number" name="f_daily" min="0" step="0.01" value="${set.features.daily}"></label></div>
        <div class="form cols"><label class="f">На ученика в месяц, $<input type="number" name="per_user_monthly_usd" min="0" step="0.01" value="${set.per_user_monthly_usd}"></label><label class="f">Скриншотов на ученика в день<input type="number" name="per_user_daily_images" min="0" value="${set.per_user_daily_images}"></label><label class="f">Сообщений на ученика в день<input type="number" name="per_user_daily" min="1" max="500" value="${st.settings.per_user_daily}"></label></div>
        <h3 style="margin:8px 0 4px">Цены, $ за 1 млн токенов</h3><p class="muted" style="font-size:12.5px;margin:0">По умолчанию — официальная страница цен Claude API (Haiku 5.5 — для запросов до 100 тыс. токенов). Расход считается по фактическим токенам из ответов API и этим ценам.</p>
        <table id="mPrices"><tr><th>Модель</th><th>Вход</th><th>Выход</th><th>Чтение кэша</th><th>Запись кэша</th></tr>${Object.keys(set.prices).map(m => `<tr data-model="${esc(m)}"><td>${esc(m)}</td>${["input", "output", "cache_read", "cache_write"].map(k => `<td><input type="number" min="0" step="0.001" data-price="${k}" value="${price(m)[k]}" style="width:80px"></td>`).join("")}</tr>`).join("")}</table>
        <button class="btn primary" id="mSave">Сохранить</button></div></div>
      <div class="panel"><h3>Больше всего потратили в этом месяце</h3><table id="mTopUsers">${bd.top_users.map(x => `<tr><td>${esc(x.uid)}</td><td>${money(x.spent_usd)}</td></tr>`).join("") || "<tr><td>—</td></tr>"}</table>
        <h3 style="margin-top:14px">Статистика запросов</h3><table id="mUsage"><tr><th>Период</th><th>Запросы</th><th>Ошибки</th><th>Токены входа</th><th>Токены выхода</th><th>Сумма</th></tr>${row("Месяц " + esc(u.month.key), u.month)}${row("Сегодня " + esc(u.day.key), u.day)}</table></div></div>`;
    $("#mSave").onclick = async e => { const f = readForm($("#mBudgetForm")), n = k => Number(f[k]);
      const prices = {}; main.querySelectorAll("#mPrices tr[data-model]").forEach(tr => { prices[tr.dataset.model] = {}; tr.querySelectorAll("[data-price]").forEach(i => { prices[tr.dataset.model][i.dataset.price] = Number(i.value); }); });
      const body = { monthly_total_usd: n("monthly_total_usd"), reserve_usd: n("reserve_usd"), features: { mentor: n("f_mentor"), vision: n("f_vision"), daily: n("f_daily") }, per_user_monthly_usd: n("per_user_monthly_usd"), per_user_daily_images: n("per_user_daily_images"), prices };
      const r1 = await run(e.target, () => api("PUT", "/ai-budget/settings", body)); if (!r1) return;
      const r2 = await run(e.target, () => api("PUT", "/mentor/settings", { per_user_daily: n("per_user_daily") })); if (r2) { toast("Лимиты ИИ-помощника сохранены"); route(); } };
  }
  /* ---------- Chart Training: сценарии и импорт CSV ---------- */
  const C_DIR = { up: "Вверх", down: "Вниз", no_trade: "Нет сделки" };
  const C_F = { structure: "Структура", liquidity_sweep: "Снятие ликвидности", bos_mss: "BOS / MSS", fvg: "FVG", premium_discount: "Premium / Discount", no_confirmation: "Нет подтверждения" };
  async function chartView() {
    const my = SEQ; const d = await api("GET", "/chart/scenarios"); if (my !== SEQ) return;
    main.innerHTML = page("Chart Training", "Учебные сценарии графиков. Симуляции помечаются ученикам как «не реальные данные». Будущие свечи ученик видит только после ответа.",
      `<button class="btn primary" id="cImport">Импорт CSV</button>`) +
      `<div class="panel"><table id="cList"><tr><th>ID</th><th>Тип</th><th>Описание</th><th>Активен</th><th></th></tr>${d.scenarios.map(x => `<tr data-sc="${esc(x.id)}"><td>${esc(x.id)}</td><td>${x.source === "synthetic" ? "Симуляция" : "CSV"}</td>
        <td>${x.source === "synthetic" ? esc(x.pattern) + " · " + esc(x.timeframe) : esc(x.instrument) + " " + esc(x.timeframe) + " · источник: " + esc(x.data_source)}</td>
        <td><label class="check"><input type="checkbox" data-cact="${esc(x.id)}" ${x.active ? "checked" : ""}> ${x.active ? "да" : "нет"}</label></td><td><button class="btn sm" data-cprev="${esc(x.id)}">Просмотр</button></td></tr>`).join("")}</table></div>`;
    main.querySelectorAll("[data-cact]").forEach(cb => cb.onchange = async () => { const r = await run(cb, () => api("POST", `/chart/scenarios/${cb.dataset.cact}/status`, { active: cb.checked })); if (r) toast(r.active ? "Сценарий включён" : "Сценарий отключён"); route(); });
    main.querySelectorAll("[data-cprev]").forEach(b => b.onclick = async () => { const p = await api("GET", "/chart/scenarios/" + b.dataset.cprev);
      modal("Сценарий " + p.id, `<p>${p.label.kind === "synthetic" ? "Симуляция (воспроизводимая)" : `Исторические данные: ${esc(p.label.instrument)} ${esc(p.label.timeframe)}, источник: ${esc(p.label.data_source)}`}</p>
        <p>Свечей: ${p.candles.length}, видимых ученику до ответа: ${p.visible}</p><p>Ожидаемая гипотеза: <b>${esc(C_DIR[p.expected.direction])}</b>; факторы: ${p.expected.factors.map(f => esc(C_F[f] || f)).join(", ") || "—"}</p>`, [{ label: "Закрыть", cls: "primary", onClick: () => {} }]); });
    $("#cImport").onclick = () => {
      const body = modal("Импорт исторического сценария (CSV)", `<div class="form">
        <div class="form cols"><label class="f">ID<input type="text" name="id" maxlength="40" placeholder="eurusd_m15_2026_03"></label><label class="f">Инструмент<input type="text" name="instrument" maxlength="30" placeholder="EUR/USD"></label><label class="f">Таймфрейм<input type="text" name="timeframe" maxlength="10" placeholder="M15"></label></div>
        <label class="f">Источник данных<small>откуда CSV и разрешено ли учебное использование</small><input type="text" name="data_source" maxlength="200"></label>
        <div class="form cols"><label class="f">Видимых свечей до ответа<input type="number" name="visible" min="20" value="60"></label>
          <label class="f">Ожидаемая гипотеза<select name="expected_dir">${Object.entries(C_DIR).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label></div>
        <div>Ожидаемые факторы: ${d.factors.map(f => `<label class="check"><input type="checkbox" name="f_${f}"> ${esc(C_F[f] || f)}</label>`).join(" ")}</div>
        <label class="f">CSV-файл<small>столбцы Time (или Date), Open, High, Low, Close; 30–400 строк</small><input type="file" id="cFile" accept=".csv,text/csv,text/plain"></label>
        <label class="f">или текст CSV<textarea name="csv" rows="6" placeholder="Time,Open,High,Low,Close"></textarea></label></div>`,
        [{ label: "Отмена", cls: "ghost", onClick: () => {} }, { label: "Импортировать", cls: "primary", onClick: async btn => {
          const f = readForm(body); const data = { id: f.id, instrument: f.instrument, timeframe: f.timeframe, data_source: f.data_source, visible: Number(f.visible), expected_dir: f.expected_dir,
            expected_factors: d.factors.filter(x => f["f_" + x] === true), csv: f.csv };
          const r = await run(btn, () => api("POST", "/chart/import", data)); if (!r) return true; toast(`Импортировано: ${r.candles} свечей`); route(); } }], { wide: true });
      body.querySelector("#cFile").onchange = async e => { const file = e.target.files[0]; if (!file) return; if (file.size > 90000) { toast("Файл больше 90 КБ — сократите до 400 строк", true); return; } body.querySelector("textarea[name=csv]").value = await file.text(); };
    };
  }

  /* ---------- Daily Tests: банк, пропорции, наборы ---------- */
  const D_C = { hr: "Hidden Reaction", smc: "Smart Money Concepts", rm: "Risk Management" };
  const D_ST = { approved: "Одобрен", needs_review: "На проверке", disabled: "Отключён" };
  const dt = ms => ms ? new Date(ms).toLocaleString("ru-RU", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + " (Берлин)" : "—";
  let dFilter = { course: "", status: "", source: "", q: "", offset: 0 };
  /* Автопополнение банка Daily Tests (ИИ): состояние, настройки, ручной запуск */
  async function loadGenerator() {
    const box = $("#gPanel"); if (!box) return; let g; try { g = await api("GET", "/daily/generator"); } catch (e) { box.innerHTML = `<p class="muted">Автопополнение недоступно.</p>`; return; }
    const st = g.settings, CN = { hr: "Hidden Reaction", smc: "SMC", rm: "Risk Management" }, dt = ms => ms ? new Date(ms).toLocaleString("ru-RU") : "—";
    box.innerHTML = `<h3>Автопополнение банка (ИИ)</h3>
      <p class="muted" style="margin-top:0">Когда запас курса меньше порога, генератор создаёт вопросы по опубликованным урокам (Claude). Вопросы проходят автоматические проверки и по умолчанию ждут проверки администратора. Если генерация невозможна, наборы строятся из одобренного банка.</p>
      <div class="grid two"><div><table id="gCounts"><tr><td>Одобрено в банке</td><td>${g.counts.approved}</td></tr><tr><td>Ждут проверки (ИИ)</td><td><b id="gPending">${g.counts.pending_review}</b> <button class="btn sm" id="gShowPending">Показать</button></td></tr>
        <tr><td>Сгенерировано ИИ / одобрено / отклонено</td><td>${g.counts.ai_generated} / ${g.counts.ai_approved} / ${g.counts.rejected}</td></tr>
        <tr><td>Запас, дней</td><td id="gStock">${Object.entries(g.stock).map(([c, x]) => `${CN[c] || c}: ${x.days_left == null ? "—" : x.days_left}`).join(" · ")}</td></tr>
        <tr><td>Последний запуск</td><td id="gLast">${g.last_run ? `${dt(g.last_run.at)} · ${esc(g.last_run.status)} · принято ${g.last_run.accepted}` : "—"}${g.running ? " · <b>идёт сейчас</b>" : ""}</td></tr>
        <tr><td>Расход (доля Daily Tests)</td><td>$${g.spend.spent_usd.toFixed(4)} из $${g.spend.cap_usd} · запросов ${g.spend.requests}, ошибок ${g.spend.errors}</td></tr>
        <tr><td>Ошибки последних запусков</td><td>${g.errors.length ? esc([...new Set(g.errors)].join(", ")) : "нет"}</td></tr></table></div>
      <div><div class="form" id="gForm"><label class="check"><input type="checkbox" name="enabled" ${st.enabled ? "checked" : ""}> Автопополнение включено</label>
        <div class="form cols"><label class="f">Порог запаса, дней<input type="number" name="min_days" min="1" max="14" value="${st.min_days}"></label><label class="f">Целевой запас, дней (7–14)<input type="number" name="target_days" min="7" max="14" value="${st.target_days}"></label><label class="f">Максимум за запуск<input type="number" name="max_per_run" min="1" max="30" value="${st.max_per_run}"></label></div>
        <label class="check"><input type="checkbox" name="auto_publish" id="gAuto" ${st.auto_publish ? "checked" : ""}> Автопубликация (только вопросы без единого замечания)</label>
        <p class="muted" id="gAutoWarn" style="font-size:12.5px;margin:0" ${st.auto_publish ? "" : "hidden"}>Внимание: опубликованные автоматически вопросы попадут ученикам без проверки человеком. Переводы EN/UA остаются черновыми.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="gSave">Сохранить</button><button class="btn" id="gRun">Сгенерировать сейчас</button></div></div></div></div>`;
    $("#gAuto").onchange = e => { $("#gAutoWarn").hidden = !e.target.checked; };
    $("#gShowPending").onclick = () => { dFilter.source = "ai_generated"; dFilter.status = "needs_review"; dFilter.offset = 0; const s1 = $("#dfSrc"), s2 = $("#dfS"); if (s1) s1.value = "ai_generated"; if (s2) s2.value = "needs_review"; loadBank(); };
    $("#gSave").onclick = async e => { const f = readForm($("#gForm"));
      const r = await run(e.target, () => api("PUT", "/daily/generator/settings", { enabled: f.enabled === true, auto_publish: f.auto_publish === true, min_days: Number(f.min_days), target_days: Number(f.target_days), max_per_run: Number(f.max_per_run) }));
      if (r) { toast("Настройки автопополнения сохранены"); loadGenerator(); } };
    $("#gRun").onclick = () => confirmDlg("Сгенерировать вопросы сейчас?", "Генератор создаст вопросы по опубликованным урокам для курсов, где запас ниже целевого. Расход учитывается в доле Daily Tests.", "Сгенерировать",
      async btn => { const r = await run(btn, () => api("POST", "/daily/generator/run", { confirm: true })); if (!r) return true; const GS = { generated: "создано вопросов", stock_ok: "запас в норме, генерация не нужна", locked: "генерация уже идёт", failed: "ошибка генерации", nothing_accepted: "ни один вопрос не прошёл проверки", disabled: "автопополнение выключено" };
        toast(`Генерация: ${GS[r.status] || r.status}${r.accepted ? " — " + r.accepted : ""}`); loadGenerator(); loadBank(); });
  }
  async function dailyView() {
    const my = SEQ; const st = await api("GET", "/daily/status"); if (my !== SEQ) return;
    const alerts = [];
    if (st.bank_empty) alerts.push(`<div class="note warn" id="dEmpty"><b>Банк вопросов пуст.</b> Нажмите «Загрузить банк из проекта» — 320 вопросов из тестов трёх курсов.</div>`);
    if (st.bank_exhausted) alerts.push(`<div class="note bad" id="dExhausted"><b>Набор на ${esc(st.bank_exhausted.date)} не опубликован:</b> не хватает одобренных вопросов — ${Object.entries(st.bank_exhausted.shortages).map(([c, x]) => `${esc(D_C[c])}: нужно ${x.need}, есть ${x.available}`).join("; ")}. Непроверенные вопросы автоматически не используются: одобрите вопросы в банке, измените пропорции или включите повтор вопросов.</div>`);
    for (const l of st.low_stock) alerts.push(`<div class="note warn" data-low="${esc(l.course)}">Вопросов ${esc(D_C[l.course])} осталось на ${l.days_left} дн. — одобрите вопросы «на проверке» или добавьте новые.</div>`);
    const setLine = (label, x) => `<tr><td>${label}</td><td>${x ? `${esc(x.date)} · ${x.questions} заданий · ${esc(x.created_by)} · ${dt(x.created_at)}` : "<b>ещё не подготовлен</b>"}</td></tr>`;
    main.innerHTML = page("Daily Tests", `Новый набор в 00:00 по Берлину. Следующее обновление: ${dt(st.next_reset_at)}.`,
      `<button class="btn" id="dImport">Загрузить банк из проекта</button><button class="btn primary" id="dNewQ">+ Новый вопрос</button><button class="btn" id="dRun">Подготовить наборы сейчас</button>`) + alerts.join("") + `<div class="panel" id="gPanel" style="margin-bottom:16px"><p class="muted">Автопополнение банка — загрузка…</p></div>` +
      `<div class="grid two"><div class="panel"><h3>Наборы</h3><table>${setLine("Сегодня", st.today)}${setLine("Завтра", st.tomorrow)}</table>
        <h3 style="margin-top:16px">Пропорции заданий в день</h3><div class="form cols" id="dMix">${Object.keys(D_C).map(c => `<label class="f">${esc(D_C[c])}<input type="number" min="0" max="5" name="${c}" value="${st.config.mix[c]}"></label>`).join("")}</div>
        <label class="f">Повтор вопросов<small>0 — выключен (только новые вопросы); N — разрешить вопросы, использованные не раньше чем N дней назад</small><input type="number" min="0" max="365" name="reuse" id="dReuse" value="${st.config.reuse_after_days}"></label>
        <button class="btn primary" id="dSaveMix">Сохранить пропорции</button></div>
      <div class="panel"><h3>Запас вопросов</h3><table id="dStock"><tr><th>Курс</th><th>Одобрено</th><th>На проверке</th><th>Откл.</th><th>Доступно</th><th>В день</th><th>Хватит на</th></tr>
        ${Object.entries(st.stock).map(([c, x]) => `<tr><td>${esc(D_C[c])}</td><td>${x.approved}</td><td>${x.needs_review}</td><td>${x.disabled}</td><td>${x.available}</td><td>${x.per_day}</td><td>${x.days_left == null ? "—" : x.days_left + " дн."}</td></tr>`).join("")}</table>
        <h3 style="margin-top:16px">Последние запуски</h3><table>${st.runs.map(r => `<tr><td>${dt(r.at)}</td><td>${esc(r.date)}</td><td>${esc(r.source)}</td><td>${esc(r.status)}</td></tr>`).join("") || "<tr><td>—</td></tr>"}</table></div></div>
      <div class="panel" style="margin-top:16px"><h3>Банк вопросов</h3><div class="form cols"><label class="f">Курс<select id="dfC"><option value="">все</option>${Object.entries(D_C).map(([k, v]) => `<option value="${k}" ${dFilter.course === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
        <label class="f">Статус<select id="dfS"><option value="">все</option>${Object.entries(D_ST).map(([k, v]) => `<option value="${k}" ${dFilter.status === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
        <label class="f">Источник<select id="dfSrc"><option value="">все</option><option value="bank" ${dFilter.source === "bank" ? "selected" : ""}>вопросы курсов</option><option value="ai_generated" ${dFilter.source === "ai_generated" ? "selected" : ""}>ИИ-генерация</option></select></label>
        <label class="f">Поиск<input type="text" id="dfQ" value="${esc(dFilter.q)}"></label></div><div id="dBank"><p class="muted">Загрузка…</p></div></div>
      <div class="panel" style="margin-top:16px"><h3>Качество обучения · статистика ответов</h3><div id="dAnalytics"><p class="muted">Загрузка статистики…</p></div></div>
      <div class="panel" style="margin-top:16px"><h3>Архив наборов</h3><div id="dSets"><p class="muted">Загрузка…</p></div></div>`;
    $("#dNewQ").onclick = () => dailyQuestionForm();
    $("#dImport").onclick = () => confirmDlg("Загрузить банк из проекта?", "Будут добавлены только новые вопросы из content/daily-bank/daily_bank.json. Уже загруженные вопросы и ваши правки не изменятся.", "Загрузить", async btn => { const r = await run(btn, () => api("POST", "/daily/bank/import", { confirm: true })); if (!r) return true; toast(`Добавлено: ${r.added}, без изменений: ${r.kept}`); route(); });
    $("#dRun").onclick = async e => { const r = await run(e.target, () => api("POST", "/daily/run", {})); if (r) { toast(`Сегодня: ${r.today.status}, завтра: ${r.tomorrow.status}`); route(); } };
    $("#dSaveMix").onclick = async e => { const mix = Object.fromEntries([...document.querySelectorAll("#dMix input")].map(i => [i.name, Number(i.value)]));
      const r = await run(e.target, () => api("PUT", "/daily/config", { mix, reuse_after_days: Number($("#dReuse").value) })); if (r) { toast("Пропорции сохранены — применятся к следующему набору"); route(); } };
    const reload = () => { dFilter.offset = 0; loadBank(); };
    $("#dfC").onchange = e => { dFilter.course = e.target.value; reload(); }; $("#dfS").onchange = e => { dFilter.status = e.target.value; reload(); };
    let tq; $("#dfQ").oninput = e => { clearTimeout(tq); tq = setTimeout(() => { dFilter.q = e.target.value.trim(); reload(); }, 300); };
    $("#dfSrc").onchange = e => { dFilter.source = e.target.value; dFilter.offset = 0; loadBank(); };
    loadGenerator();
    loadBank(); loadSets(); loadAnalytics();
  }
  async function loadAnalytics() {
    const box = $("#dAnalytics"); if (!box) return;
    try {
      const a = await api("GET", "/daily/analytics");
      const pct = n => n == null ? "—" : n + "%";
      const courses = Object.entries(a.by_course || {}).map(([k,v]) => `<tr><td>${esc(D_C[k] || k)}</td><td>${v.attempts}</td><td>${pct(v.accuracy)}</td></tr>`).join("");
      const kinds = Object.entries(a.by_kind || {}).map(([k,v]) => `<tr><td>${esc(k)}</td><td>${v.attempts}</td><td>${pct(v.accuracy)}</td></tr>`).join("");
      const rows = (a.hardest || []).map(q => `<tr><td>${esc(q.q)}</td><td>${q.attempts}</td><td>${pct(q.accuracy)}</td></tr>`).join("");
      box.innerHTML = `<p><b>Всего ответов:</b> ${a.total_attempts} · <b>Общая точность:</b> ${pct(a.overall_accuracy)}</p><div class="grid two"><div><h4>По курсам</h4><table><tr><th>Курс</th><th>Ответы</th><th>Верно</th></tr>${courses || "<tr><td colspan=3>Пока нет данных</td></tr>"}</table></div><div><h4>По типам</h4><table><tr><th>Тип</th><th>Ответы</th><th>Верно</th></tr>${kinds || "<tr><td colspan=3>Пока нет данных</td></tr>"}</table></div></div><h4 style="margin-top:14px">Самые сложные вопросы (от 3 ответов)</h4><table><tr><th>Вопрос</th><th>Ответы</th><th>Верно</th></tr>${rows || "<tr><td colspan=3>Пока недостаточно ответов</td></tr>"}</table><small class="muted">${esc(a.note || "")}</small>`;
    } catch (e) { box.innerHTML = `<p class="muted">Статистика пока недоступна.</p>`; }
  }
  function dailyQuestionForm() {
    const body = modal("Новый вопрос Daily Tests", `<div class="form"><p class="muted">Новые вопросы создаются на русском языке и попадают в статус «На проверке». Переводы EN/UA можно добавить отдельным этапом.</p>
      <div class="form cols"><label class="f">Курс<select name="course"><option value="hr">Hidden Reaction</option><option value="smc">Smart Money Concepts</option><option value="rm">Risk Management</option></select></label><label class="f">Тип<select name="kind"><option value="choice">Выбор ответа</option><option value="situation">Ситуация</option><option value="term">Термин</option><option value="error">Найти ошибку</option><option value="chart">Задание по графику</option></select></label></div>
      <label class="f">Название модуля<input name="module_title" maxlength="180" required></label><label class="f">Название урока<input name="lesson_title" maxlength="180" required></label>
      <label class="f">Вопрос<textarea name="q" rows="3" maxlength="1200" required></textarea></label>
      <div class="form cols">${[0,1,2,3].map(i=>`<label class="f">Вариант ${i+1}<input name="opt${i}" maxlength="400" ${i<2?"required":""}></label>`).join("")}</div>
      <label class="f">Правильный вариант<select name="correct">${[0,1,2,3].map(i=>`<option value="${i}">${i+1}</option>`).join("")}</select></label>
      <label class="f">Объяснение правильного ответа<textarea name="explanation" rows="3" maxlength="1500" required></textarea></label><label class="f">Источник / страница<input name="source_ref" maxlength="300"></label>
      <label class="f">Изображение графика (необязательно, обязательно для типа «график»)<input id="dqImage" type="file" accept="image/png,image/jpeg,image/webp"><small id="dqUploadState" class="muted">PNG, JPEG или WebP, до 8 МБ. Файл сохраняется в медиатеке Firebase Storage.</small></label>
      </div>`, [{label:"Отмена",cls:"ghost",onClick:()=>{}},{label:"Создать на проверке",cls:"primary",onClick:async btn=>{
        const f=readForm(body), options=[0,1,2,3].map(i=>String(f["opt"+i]||"").trim()).filter(Boolean);
        let chart_image=null; const file=body.querySelector("#dqImage").files[0];
        if(file){ if(file.size>8*1024*1024){toast("Изображение больше 8 МБ",true);return true;} const raw=new Uint8Array(await file.arrayBuffer()); const up=await run(btn,()=>api("POST","/media",undefined,{raw,headers:{"Content-Type":file.type,"X-File-Name":encodeURIComponent(file.name),"X-Media-Category":"chart"}})); if(!up)return true; chart_image=up.url; }
        const payload={course:f.course,kind:f.kind,module_title:f.module_title,lesson_title:f.lesson_title,q:f.q,options,correct:Number(f.correct),explanation:f.explanation,source_ref:f.source_ref,chart_image};
        const r=await run(btn,()=>api("POST","/daily/bank",payload)); if(!r)return true; toast("Вопрос создан и отправлен на проверку"); loadBank();
      }}],{wide:true});
  }
  async function loadBank() {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(dFilter).filter(([, v]) => v !== "" && v != null))).toString();
    const r = await api("GET", "/daily/bank?" + qs), box = $("#dBank"); if (!box) return;
    box.innerHTML = `<p class="muted">Найдено: ${r.total}</p>` + r.items.map(q => `<div class="card" style="padding:10px;margin-bottom:8px" data-q="${esc(q.id)}"><div style="display:flex;gap:10px;justify-content:space-between;align-items:flex-start">
      <div><b>${esc(q.q)}</b><p class="muted" style="margin:4px 0 0;font-size:12.5px">${esc(D_C[q.course])} · ${esc(q.module_title)} → ${esc(q.lesson_title)}${q.source_ref ? " · источник: " + esc(q.source_ref) : ""}${q.used_on ? " · использован " + esc(q.used_on) : ""}${(q.issues || []).length ? " · <b>" + esc(q.issues.join("; ")) + "</b>" : ""}</p></div>
      <div style="display:flex;gap:6px;align-items:center"><span class="badge">${esc(D_ST[q.status] || q.status)}</span><button class="btn sm" data-qedit="${esc(q.id)}">Изменить</button></div></div></div>`).join("") +
      `<div style="display:flex;gap:8px">${dFilter.offset > 0 ? `<button class="btn sm" id="dPrev">← Назад</button>` : ""}${dFilter.offset + 50 < r.total ? `<button class="btn sm" id="dNext">Дальше →</button>` : ""}</div>`;
    box.querySelectorAll("[data-qedit]").forEach(b => b.onclick = () => bankForm(r.items.find(x => x.id === b.dataset.qedit)));
    const pv = $("#dPrev"), nx = $("#dNext"); if (pv) pv.onclick = () => { dFilter.offset -= 50; loadBank(); }; if (nx) nx.onclick = () => { dFilter.offset += 50; loadBank(); };
  }
  function bankForm(q) {
    const langs = ["en", "ua"], tr = q.i18n || {};
    const body = modal("Вопрос банка · переводы и предпросмотр", `<p><b>${esc(q.q)}</b></p><ol>${q.options.map((o, i) => `<li ${i === q.correct ? 'style="color:#8bea24;font-weight:700"' : ""}>${esc(o)}${i === q.correct ? " ✓" : ""}</li>`).join("")}</ol>
      <p class="muted">${esc(D_C[q.course])} · ${esc(q.module_title)} → ${esc(q.lesson_title)}${q.source_ref ? " · источник: " + esc(q.source_ref) : ""}</p>
      <div class="form"><label class="f">Объяснение (RU)<textarea name="explanation" rows="3" maxlength="1500">${esc(q.explanation || "")}</textarea></label>
      ${langs.map(l => `<details ${tr[l] ? "open" : ""} style="border:1px solid var(--line);padding:10px;border-radius:10px"><summary><b>Перевод ${l.toUpperCase()}</b> ${tr[l] ? "· заполнен частично/полностью" : "· не заполнен"}</summary>
        <label class="f">Вопрос (${l.toUpperCase()})<textarea name="q_${l}" rows="2" maxlength="1200">${esc((tr[l] || {}).q || "")}</textarea></label>
        <div class="form cols">${q.options.map((o,i)=>`<label class="f">Вариант ${i+1} (${l.toUpperCase()})<input name="opt_${l}_${i}" maxlength="400" value="${esc(((tr[l] || {}).options || [])[i] || "")}"></label>`).join("")}</div>
        <label class="f">Модуль (${l.toUpperCase()})<input name="module_title_${l}" maxlength="180" value="${esc((tr[l] || {}).module_title || "")}"></label>
        <label class="f">Урок (${l.toUpperCase()})<input name="lesson_title_${l}" maxlength="180" value="${esc((tr[l] || {}).lesson_title || "")}"></label>
        <label class="f">Объяснение (${l.toUpperCase()})<textarea name="explanation_${l}" rows="2" maxlength="1500">${esc((tr[l] || {}).explanation || "")}</textarea></label>
      </details>`).join("")}
      <label class="f">Предпросмотр для ученика<select id="dqPreviewLang"><option value="ru">Русский</option><option value="en">English</option><option value="ua">Українська</option></select></label>
      <div id="dqStudentPreview" class="card" style="padding:12px"><b>${esc(q.q)}</b><ol>${q.options.map(o=>`<li>${esc(o)}</li>`).join("")}</ol><small class="muted">Правильный ответ скрыт до отправки ответа.</small></div>
      <label class="f">Статус<select name="status">${Object.entries(D_ST).map(([k, v]) => `<option value="${k}" ${q.status === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
      <p class="muted" style="margin:0">Переводы вводятся и проверяются вручную. Автоматический перевод не подставляется. Одобренный вопрос может попасть в будущие наборы; уже опубликованные наборы не меняются.</p></div>`,
      [{ label: "Отмена", cls: "ghost", onClick: () => {} }, { label: "Сохранить", cls: "primary", onClick: async btn => {
        const f = readForm(body), payload = { ...f };
        for (const l of langs) payload[`options_${l}`] = q.options.map((_,i) => String(f[`opt_${l}_${i}`] || "").trim());
        const r = await run(btn, () => api("PUT", "/daily/bank/" + q.id, payload)); if (!r) return true; toast("Вопрос и переводы сохранены"); loadBank(); loadAnalytics();
      } }], { wide: true });
    const updatePreview = () => {
      const l = body.querySelector("#dqPreviewLang").value, t = (tr[l] || {}), qText = body.querySelector(`[name="q_${l}"]`)?.value || t.q || q.q;
      const opts = q.options.map((o,i) => body.querySelector(`[name="opt_${l}_${i}"]`)?.value || ((t.options || [])[i]) || o);
      const title = body.querySelector(`[name="lesson_title_${l}"]`)?.value || t.lesson_title || q.lesson_title;
      body.querySelector("#dqStudentPreview").innerHTML = `<small class="muted">${esc(title)}</small><p><b>${esc(qText)}</b></p><ol>${opts.map(o=>`<li>${esc(o)}</li>`).join("")}</ol><small class="muted">Правильный ответ скрыт до отправки ответа.</small>`;
    };
    body.querySelectorAll("input,textarea,select").forEach(el => el.addEventListener("input", updatePreview));
    body.querySelector("#dqPreviewLang").addEventListener("change", updatePreview);
  }
  async function loadSets() {
    const r = await api("GET", "/daily/sets?limit=30"), box = $("#dSets"); if (!box) return;
    box.innerHTML = r.sets.length ? `<table>${r.sets.map(x => `<tr><td>${esc(x.date)}</td><td>${x.questions} заданий</td><td>${esc(x.created_by)}</td><td><button class="btn sm" data-set="${esc(x.date)}">Открыть</button></td></tr>`).join("")}</table>` : `<p class="muted">Наборов пока нет.</p>`;
    box.querySelectorAll("[data-set]").forEach(b => b.onclick = async () => { const d = await api("GET", "/daily/sets/" + b.dataset.set);
      modal("Набор " + d.date, d.questions.map((q, i) => `<div style="margin-bottom:12px"><b>${i + 1}. ${esc(q.q)}</b><br><small class="muted">${esc(D_C[q.course])} · ${esc(q.lesson_title)}</small><ol>${q.options.map((o, j) => `<li ${j === q.correct ? 'style="color:#8bea24;font-weight:700"' : ""}>${esc(o)}</li>`).join("")}</ol></div>`).join(""), [{ label: "Закрыть", cls: "primary", onClick: () => {} }], { wide: true }); });
  }

  /* ---------- Функции Academy: карточки AI Mentor / Daily Tests / Chart Training ---------- */
  const F_ST = { ACTIVE: "Открыть", COMING_SOON: "Скоро", IN_DEVELOPMENT: "В разработке", DISABLED: "Отключено" };
  const F_IC = { mentor: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5"/>', tests: '<path d="M9 4h6v2H9zM6 6h12v15H6z"/><path d="m9 14 2 2 4-4"/>',
    chart: '<path d="M4 19h16M7 15l4-4 3 3 5-6"/><path d="M15 8h4v4"/>', book: '<path d="M4 5h11a3 3 0 0 1 3 3v12H7a3 3 0 0 1-3-3z"/>', star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/>', target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>', shield: '<path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z"/>' };
  const fPreview = (c, lang = "ru") => { const tx = o => (o && (o[lang] || o.ru)) || ""; const open = c.status === "ACTIVE";
    return `<div style="display:grid;grid-template-columns:46px 1fr auto;gap:12px;align-items:center;padding:16px 14px;border-radius:18px;border:1px solid rgba(139,234,36,.25);background:#0b0f0b;color:#e6ebe3;${c.enabled === false || c.status === "DISABLED" ? "opacity:.6" : ""}">
      <div style="width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:rgba(139,234,36,.07);border:1px solid rgba(139,234,36,.25);color:#8bea24">${I(F_IC[c.icon] || F_IC.star)}</div>
      <div><b style="display:block;margin-bottom:3px">${esc(tx(c.title) || "Без названия")}</b><span style="font-size:12.5px;color:#9aa595">${esc(tx(c.description))}</span></div>
      <span style="font-size:11.5px;font-weight:700;border-radius:999px;padding:4px 10px;${open ? "background:#8bea24;color:#061006" : "border:1px dashed #3a4a35;color:#9aa595"}">${esc(open ? (tx(c.button) || "Открыть") : F_ST[c.status] || "")}</span></div>`; };
  async function featuresView() {
    const my = SEQ; const d = await api("GET", "/features"); if (my !== SEQ) return;
    const ready = Object.fromEntries(d.modules.map(m => [m.key, m]));
    main.innerHTML = page("Функции Academy", "Карточки AI Mentor, Daily Tests, Chart Training и будущих функций. Изменения видны ученикам сразу, без деплоя.",
      `<button class="btn" id="fReset">Вернуть стандартные</button><button class="btn primary" id="fNew">+ Карточка</button>`) +
      `<div class="list">${d.cards.map((c, i) => `<div class="card" style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;padding:12px;margin-bottom:10px">
        <div>${fPreview(c)}<p class="muted" style="margin:8px 0 0;font-size:12.5px">ID: ${esc(c.id)}${c.builtin ? " · стандартная" : " · дополнительная"} · модуль: ${esc(c.module ? (ready[c.module] ? ready[c.module].label + (ready[c.module].ready ? "" : " (ещё не реализован)") : c.module) : "нет — информационная")}${c.enabled === false ? " · <b>выключена</b>" : ""}${c.show_on_dashboard === false ? " · <b>скрыта из кабинета ученика</b>" : ""}${c.status === "DISABLED" ? (c.disabled_display === "show" ? " · отключённая показывается" : " · отключённая скрыта") : ""}</p></div>
        <div class="actions" style="display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end">
          <select data-fst="${esc(c.id)}" aria-label="Статус">${d.statuses.map(st => `<option value="${st}" ${c.status === st ? "selected" : ""} ${st === "ACTIVE" && !(c.module && ready[c.module] && ready[c.module].ready) ? "disabled" : ""}>${F_ST[st]}${st === "ACTIVE" && !(c.module && ready[c.module] && ready[c.module].ready) ? " — модуль не реализован" : ""}</option>`).join("")}</select>
          <button class="btn sm" data-fup="${i}" ${i === 0 ? "disabled" : ""} aria-label="Выше">↑</button><button class="btn sm" data-fdown="${i}" ${i === d.cards.length - 1 ? "disabled" : ""} aria-label="Ниже">↓</button>
          <button class="btn sm" data-fedit="${esc(c.id)}">Изменить</button></div></div>`).join("")}</div>`;
    const ids = d.cards.map(c => c.id);
    const move = async (i, dir, btn) => { const n = ids.slice(); [n[i], n[i + dir]] = [n[i + dir], n[i]]; const r = await run(btn, () => api("POST", "/features/order", { ids: n })); if (r) { toast("Порядок сохранён"); route(); } };
    main.querySelectorAll("[data-fup]").forEach(b => b.onclick = () => move(Number(b.dataset.fup), -1, b));
    main.querySelectorAll("[data-fdown]").forEach(b => b.onclick = () => move(Number(b.dataset.fdown), 1, b));
    main.querySelectorAll("[data-fst]").forEach(sel => sel.onchange = async () => { const r = await run(sel, () => api("POST", `/features/${sel.dataset.fst}/status`, { status: sel.value })); if (r) toast("Статус: " + F_ST[sel.value]); route(); });
    main.querySelectorAll("[data-fedit]").forEach(b => b.onclick = () => featureForm(d.cards.find(c => c.id === b.dataset.fedit), d));
    $("#fNew").onclick = () => featureForm(null, d);
    $("#fReset").onclick = () => confirmDlg("Вернуть стандартные карточки?", "Три стандартные карточки получат исходные тексты, порядок и статус «Скоро». Дополнительные карточки не изменятся.", "Вернуть", async btn => { const r = await run(btn, () => api("POST", "/features/reset", { confirm: true })); if (!r) return true; toast("Стандартные настройки восстановлены"); route(); });
  }
  function featureForm(c, d) {
    const isNew = !c; c = c || { id: "", title: {}, description: {}, button: {}, icon: "star", order: (d.cards.reduce((m, x) => Math.max(m, x.order || 0), 0) + 1), enabled: true, status: "COMING_SOON", disabled_display: "hide", module: "", builtin: false };
    const L3 = ["ru", "en", "ua"], ready = Object.fromEntries(d.modules.map(m => [m.key, m]));
    const tri = (k, label, max) => `<div class="form cols">${L3.map(l => `<label class="f">${label} ${l.toUpperCase()}<input type="text" name="${k}_${l}" maxlength="${max}" value="${esc((c[k] || {})[l] || "")}"></label>`).join("")}</div>`;
    const body = modal(isNew ? "Новая карточка" : "Карточка: " + ((c.title || {}).ru || c.id), `<div class="grid two"><div class="form">
      ${isNew ? `<label class="f">ID<small>латиница, цифры, - и _ (3–40); после создания не меняется</small><input type="text" name="id" maxlength="40" required></label>` : `<p class="muted" style="margin:0">ID: ${esc(c.id)}${c.builtin ? " (стандартная)" : ""}</p>`}
      ${tri("title", "Название", 60)}${tri("description", "Описание", 240)}${tri("button", "Кнопка", 30)}
      <div class="form cols"><label class="f">Иконка<select name="icon">${d.icons.map(k => `<option value="${k}" ${c.icon === k ? "selected" : ""}>${k}</option>`).join("")}</select></label>
        <label class="f">Порядок<input type="number" name="order" min="0" max="999" value="${esc(c.order)}"></label>
        <label class="f">Статус<select name="status">${d.statuses.map(st => `<option value="${st}" ${c.status === st ? "selected" : ""}>${F_ST[st]}</option>`).join("")}</select></label></div>
      <div class="form cols"><label class="f">Модуль (страница)<small>только зарегистрированные разработчиком</small><select name="module" ${c.builtin ? "disabled" : ""}><option value="">— нет (информационная)</option>${d.modules.map(m => `<option value="${m.key}" ${c.module === m.key ? "selected" : ""}>${esc(m.label)}${m.ready ? "" : " — ещё не реализован"}</option>`).join("")}</select></label>
        <label class="f">Если «Отключено»<select name="disabled_display"><option value="hide" ${c.disabled_display !== "show" ? "selected" : ""}>Скрыть карточку</option><option value="show" ${c.disabled_display === "show" ? "selected" : ""}>Показать с меткой</option></select></label></div>
      <label class="check"><input type="checkbox" name="enabled" ${c.enabled !== false ? "checked" : ""}> Карточка включена (выключенная не показывается ученикам)</label>
      <label class="check"><input type="checkbox" name="show_on_dashboard" ${c.show_on_dashboard !== false ? "checked" : ""}> Показывать в кабинете ученика <small class="muted">(модуль и прямые ссылки работают независимо от этой галочки)</small></label>
      <p class="muted" id="fNote" style="margin:0"></p></div>
      <div><p class="muted" style="margin:0 0 8px">Предпросмотр <select id="fLang" aria-label="Язык предпросмотра"><option value="ru">RU</option><option value="en">EN</option><option value="ua">UA</option></select></p><div id="fpv"></div></div></div>`,
      [{ label: "Отмена", cls: "ghost", onClick: () => {} }, { label: "Сохранить", cls: "primary", onClick: async btn => {
        const data = collect(); const r = await run(btn, () => isNew ? api("POST", "/features", data) : api("PUT", "/features/" + c.id, data));
        if (!r) return true; toast("Карточка сохранена"); route(); } }], { wide: true });
    function collect() {
      const f = readForm(body), out = { icon: f.icon, order: Number(f.order), status: f.status, disabled_display: f.disabled_display, enabled: f.enabled === true, show_on_dashboard: f.show_on_dashboard === true };
      if (isNew) out.id = String(f.id || "").trim();
      if (!c.builtin) out.module = f.module || "";
      for (const k of ["title", "description", "button"]) { out[k] = {}; for (const l of L3) if (f[k + "_" + l]) out[k][l] = f[k + "_" + l]; }
      return out;
    }
    const upd = () => { const x = { ...c, ...collect() }; body.querySelector("#fpv").innerHTML = fPreview(x, body.querySelector("#fLang").value);
      const m = x.module || c.module; body.querySelector("#fNote").textContent = x.status === "ACTIVE" && !(m && ready[m] && ready[m].ready) ? "«Открыть» недоступен: модуль ещё не реализован — сервер не сохранит такой статус." : ""; };
    body.addEventListener("input", upd); body.addEventListener("change", upd); upd();
  }

  /* ---------- Hidden Dinox Knowledge Manager ---------- */
  /* ---------- База знаний v2: миграция, проверка, переключение, предпросмотр поиска ---------- */
  async function kv2View() {
    const my = SEQ; const st = await api("GET", "/knowledge-v2/status"); if (my !== SEQ) return;
    const kv = o => Object.entries(o || {}).map(([k, v]) => `<span class="badge" style="margin:2px">${esc(k)}: ${v}</span>`).join("") || "—";
    const dt = ms => ms ? new Date(ms).toLocaleString("ru-RU") : "—";
    main.innerHTML = page("База знаний v2", "Курсы, книга «The Hidden Reaction System» и сведения о проекте. Старая база (v1) не изменяется: переключение — одной кнопкой, откат — обратно на v1.") +
      `<div class="grid two"><div class="panel"><h3>Состояние</h3><table>
        <tr><td>Активная база для AI Mentor</td><td><b id="kvActive">${esc(st.active)}</b> (ревизия ${st.revision})</td></tr>
        <tr><td>Записей в hd_knowledge_v2</td><td id="kvTotal">${st.total}</td></tr><tr><td>Неподтверждённых (verified: false)</td><td>${st.unverified}</td></tr>
        <tr><td>Последний импорт</td><td>${st.last_import ? `${dt(st.last_import.at)} · записано ${st.last_import.written}, в архив ${st.last_import.archived}` : "—"}</td></tr>
        <tr><td>Последняя проверка поиска</td><td id="kvVerify">${st.last_verify ? `${dt(st.last_verify.at)} · ${st.last_verify.passed}/${st.last_verify.total} · <b>${st.last_verify.ok ? "пройдена" : "не пройдена"}</b>` : "—"}</td></tr></table>
        <p>Статусы: ${kv(st.by_status)}</p><p>Курсы: ${kv(st.by_course)}</p><p>Языки: ${kv(st.by_language)}</p><p>Источники: ${kv(st.by_source_type)}</p><p>Переводы: ${kv(st.by_translation_status)}</p></div>
      <div class="panel"><h3>Миграция по шагам</h3><ol style="padding-left:18px;line-height:1.9">
        <li><button class="btn sm" id="kvDry">Проверить импорт (dry-run)</button></li>
        <li><button class="btn sm" id="kvImport">Импортировать</button> <small class="muted">перед импортом автоматически создаётся резервная копия</small></li>
        <li><button class="btn sm" id="kvVerifyBtn">Проверить поиск контрольными вопросами</button></li>
        <li>${st.active === "v2" ? `<button class="btn sm" id="kvV1">Вернуть v1</button>` : `<button class="btn sm primary" id="kvV2">Включить v2 для AI Mentor</button>`} <button class="btn sm" id="kvReindex">Переиндексировать</button></li></ol>
        <div id="kvOut" class="muted" style="font-size:13px"></div>
        <h3 style="margin-top:14px">Резервные копии</h3><table id="kvBackups">${(st.backups || []).map(b => `<tr><td>${dt(b.created_at)}</td><td>v1: ${b.counts.hd_knowledge}, v2: ${b.counts.hd_knowledge_v2}</td><td><button class="btn sm" data-kvbk="${esc(b.backup_id)}">Скачать JSON</button></td></tr>`).join("") || "<tr><td>—</td></tr>"}</table></div></div>
      <div class="panel" style="margin-top:16px"><h3>Предпросмотр поиска AI Mentor</h3><div class="form cols"><label class="f">Вопрос<input type="text" id="kvQ" maxlength="300" placeholder="например: что такое ордер блок"></label>
        <label class="f">Язык<select id="kvLang"><option value="ru">RU</option><option value="en">EN</option><option value="ua">UA</option></select></label></div><button class="btn" id="kvSearch">Найти</button><div id="kvRes" style="margin-top:10px"></div></div>
      <div class="panel" style="margin-top:16px"><h3>Журнал</h3><table>${(st.runs || []).map(r => `<tr><td>${dt(r.at)}</td><td>${esc(r.action)}</td><td>${esc(r.actor || "")}</td></tr>`).join("") || "<tr><td>—</td></tr>"}</table></div>`;
    const out = $("#kvOut"), show = h => { out.innerHTML = h; };
    $("#kvDry").onclick = async e => { const r = await run(e.target, () => api("POST", "/knowledge-v2/dry-run", {})); if (r) show(`<b>Dry-run:</b> записей ${r.records} · добавить ${r.add} · обновить ${r.update} · без изменений ${r.unchanged} · в архив ${r.archive} · дублей ${r.duplicates} · ошибок ${r.errors}`); };
    $("#kvImport").onclick = () => confirmDlg("Импортировать базу знаний v2?", "Будет создана резервная копия, затем записи добавятся в hd_knowledge_v2. Старая база hd_knowledge, курсы и прогресс учеников не изменяются; отсутствующие в сборке записи v2 помечаются «в архиве», а не удаляются.", "Импортировать",
      async btn => { const r = await run(btn, () => api("POST", "/knowledge-v2/import", { confirm: true })); if (!r) return true; toast(`Импорт: записано ${r.written}, в архив ${r.archived}`); route(); });
    $("#kvVerifyBtn").onclick = async e => { const r = await run(e.target, () => api("POST", "/knowledge-v2/verify", {})); if (r) { show(`<b>Проверка:</b> ${r.passed}/${r.total} (порог ${Math.round(r.threshold * 100)}%) — <b>${r.ok ? "пройдена" : "не пройдена"}</b>${r.failed.length ? `<ul>${r.failed.map(f => `<li>${esc(f.lang)}: ${esc(f.q)}</li>`).join("")}</ul>` : ""}`); } };
    const act = (v, text) => confirmDlg(v === "v2" ? "Включить базу знаний v2?" : "Вернуть базу v1?", text, v === "v2" ? "Включить" : "Вернуть",
      async btn => { const r = await run(btn, () => api("POST", "/knowledge-v2/activate", { version: v, confirm: true })); if (!r) return true; toast("Активная база: " + r.active); route(); });
    if ($("#kvV2")) $("#kvV2").onclick = () => act("v2", "AI Mentor начнёт искать по базе v2. Вернуть v1 можно в любой момент этой же кнопкой.");
    if ($("#kvV1")) $("#kvV1").onclick = () => act("v1", "AI Mentor вернётся к прежнему поиску (уроки и база v1). Данные v2 сохранятся.");
    $("#kvReindex").onclick = async e => { const r = await run(e.target, () => api("POST", "/knowledge-v2/reindex", {})); if (r) toast("Индекс будет перестроен (ревизия " + r.revision + ")"); };
    main.querySelectorAll("[data-kvbk]").forEach(b => b.onclick = async () => { const r = await run(b, () => api("GET", "/knowledge-v2/backup?id=" + encodeURIComponent(b.dataset.kvbk))); if (!r) return;
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(r)], { type: "application/json" })); a.download = b.dataset.kvbk + ".json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); });
    const search = async () => { const q = $("#kvQ").value.trim(); if (!q) return; const r = await api("GET", `/knowledge-v2/search?lang=${$("#kvLang").value}&q=${encodeURIComponent(q)}`);
      $("#kvRes").innerHTML = r.results.length ? r.results.map((x, i) => `<div class="card" style="padding:10px;margin-bottom:8px" data-kvres><b>${i + 1}. ${esc(x.title)}</b> <span class="badge">${esc(x.type)}</span> <span class="badge">${esc(x.authority)}</span> ${x.verified ? "" : '<span class="badge">не подтверждено</span>'}${x.fallback ? ' <span class="badge">из RU</span>' : ""}
        <p class="muted" style="margin:4px 0;font-size:12.5px">${esc(x.course || "")} · ${esc(x.language)} · перевод: ${esc(x.translation_status)} · баллы ${x.score} · совпали: ${esc(x.matched.join(", "))} · источник: ${esc(x.provenance.file)}${x.provenance.page ? ", стр. " + x.provenance.page : ""}${x.provenance.lesson ? ", " + esc(x.provenance.lesson) : ""}</p>
        <p style="margin:0;font-size:13px">${esc(x.excerpt)}…</p></div>`).join("") : `<p class="muted">Ничего не найдено. В v2 нет опубликованных записей или вопрос вне материалов.</p>`; };
    $("#kvSearch").onclick = search; $("#kvQ").onkeydown = e => { if (e.key === "Enter") search(); };
  }

  async function knowledgeView() {
    const [d, diag] = await Promise.all([api("GET", "/knowledge"), api("GET", "/knowledge/diagnostics")]);
    const items = d.items || [];
    const json = x => JSON.stringify(x, null, 2);
    main.innerHTML = page("База знаний AI", "Управление официальными знаниями Hidden Dinox без изменения кода", `<button class="btn" id="kexport">Экспорт JSON</button><button class="btn" id="kimport">Импорт JSON</button><button class="btn primary" id="knew">Добавить материал</button>`) +
      `<div class="grid stats"><div class="stat key"><span>Всего материалов</span><b>${diag.total}</b></div><div class="stat"><span>Опубликовано</span><b>${diag.published}</b></div><div class="stat"><span>Черновики</span><b>${diag.drafts}</b></div><div class="stat"><span>Без источника</span><b>${diag.missing_source}</b></div><div class="stat"><span>Не подтверждено</span><b>${diag.unverified}</b></div></div>
      <section class="panel" style="margin:14px 0"><div class="form cols"><label class="f">Поиск<input id="kq" placeholder="Название, текст или тег"></label><label class="f">Категория<select id="kc"><option value="">Все категории</option>${diag.categories.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select></label><label class="f">Язык<select id="kl"><option value="">Все языки</option>${diag.languages.map(c=>`<option value="${c}">${c.toUpperCase()}</option>`).join("")}</select></label><label class="f">Статус<select id="ks"><option value="">Все</option><option value="published">Опубликовано</option><option value="draft">Черновики</option></select></label></div></section>
      <div class="table-wrap"><table><thead><tr><th>Материал</th><th>Категория</th><th>Язык</th><th>Статус</th><th>Версия</th><th></th></tr></thead><tbody id="ktbody">${items.map(k=>`<tr><td><b>${esc(k.title)}</b><small class="muted">${esc(k.source||"Источник не указан")}</small></td><td>${esc(k.category)}</td><td>${esc(k.language.toUpperCase())}</td><td>${k.status==="published"?'<span class="pill ok">Опубликован</span>':'<span class="pill warn">Черновик</span>'}</td><td>${k.version||1}</td><td><button class="btn sm" data-kedit="${esc(k.id)}">Открыть</button></td></tr>`).join("") || '<tr><td colspan="6">Материалов пока нет. Импортируйте стартовый JSON из content/knowledge/seed.json.</td></tr>'}</tbody></table></div>`;
    const refresh = async () => { const q = new URLSearchParams(); if($("#kq").value)q.set("q",$("#kq").value); if($("#kc").value)q.set("category",$("#kc").value); if($("#kl").value)q.set("language",$("#kl").value); if($("#ks").value)q.set("status",$("#ks").value); const x=await api("GET","/knowledge?"+q); $("#ktbody").innerHTML=x.items.map(k=>`<tr><td><b>${esc(k.title)}</b><small class="muted">${esc(k.source||"Источник не указан")}</small></td><td>${esc(k.category)}</td><td>${esc(k.language.toUpperCase())}</td><td>${k.status==="published"?'<span class="pill ok">Опубликован</span>':'<span class="pill warn">Черновик</span>'}</td><td>${k.version||1}</td><td><button class="btn sm" data-kedit="${esc(k.id)}">Открыть</button></td></tr>`).join("") || '<tr><td colspan="6">Ничего не найдено</td></tr>'; bindRows(); };
    const editor = async item => { const x=item||{title:"",content:"",category:"academy",language:"ru",tags:[],source:"",verified:false}; const cats=diag.categories; const body=modal(item?"Редактировать материал":"Новый материал", `<div class="form"><label class="f">Название<input id="ktitle" maxlength="1000" value="${esc(x.title)}"></label><div class="form cols"><label class="f">Категория<select id="kcategory">${cats.map(c=>`<option value="${c}" ${x.category===c?"selected":""}>${c}</option>`).join("")}</select></label><label class="f">Язык<select id="klang">${diag.languages.map(c=>`<option value="${c}" ${x.language===c?"selected":""}>${c.toUpperCase()}</option>`).join("")}</select></label></div><label class="f">Содержание<textarea id="kcontent" rows="12" maxlength="30000">${esc(x.content)}</textarea></label><label class="f">Теги через запятую<input id="ktags" value="${esc((x.tags||[]).join(", "))}"></label><label class="f">Источник<input id="ksource" value="${esc(x.source||"")}"></label><label class="f">URL источника<input id="ksourceurl" value="${esc(x.source_url||"")}"></label><label><input id="kverified" type="checkbox" ${x.verified?"checked":""}> Проверено администратором</label></div>`, [{label:"Отмена",cls:"ghost",onClick:()=>{}},{label:"Сохранить черновик",cls:"primary",onClick:async btn=>{const data={title:$("#ktitle").value,category:$("#kcategory").value,language:$("#klang").value,content:$("#kcontent").value,tags:$("#ktags").value.split(",").map(t=>t.trim()).filter(Boolean),source:$("#ksource").value,source_url:$("#ksourceurl").value,verified:$("#kverified").checked}; const r=await run(btn,()=>item?api("PUT","/knowledge/"+item.id,data):api("POST","/knowledge",data)); if(!r)return true; toast("Материал сохранён"); await knowledgeView();}}],{wide:true}); };
    function bindRows(){main.querySelectorAll("[data-kedit]").forEach(b=>b.onclick=async()=>{const r=await api("GET","/knowledge/"+b.dataset.kedit); const item=r.item; modal("Материал: "+item.title, `<p>${esc(item.category)} · ${esc(item.language)} · версия ${item.version}</p><p>${item.status==="published"?'<span class="pill ok">Опубликован</span>':'<span class="pill warn">Черновик</span>'}</p><pre style="white-space:pre-wrap;max-height:35vh;overflow:auto">${esc(item.content)}</pre>`,[{label:"Закрыть",cls:"ghost",onClick:()=>{}},{label:"Редактировать",cls:"primary",onClick:()=>editor(item)},{label:item.status==="published"?"Снять с публикации":"Опубликовать",onClick:async btn=>{const a=await run(btn,()=>api("POST","/knowledge/"+item.id+"/publish",{confirm:true,published:item.status!=="published"}));if(a){toast("Статус обновлён");await knowledgeView();}}},{label:"Удалить",cls:"danger",onClick:async btn=>{const a=await run(btn,()=>api("POST","/knowledge/"+item.id+"/delete",{confirm:true}));if(a){toast("Удалено");await knowledgeView();}}}],{wide:true});});}
    bindRows(); $("#knew").onclick=()=>editor(null); $("#kq").oninput=refresh; ["#kc","#kl","#ks"].forEach(s=>$(s).onchange=refresh);
    $("#kexport").onclick=async()=>{const x=await api("GET","/knowledge/export");const blob=new Blob([json(x)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="hidden-dinox-knowledge.json";a.click();URL.revokeObjectURL(a.href);};
    $("#kimport").onclick=()=>modal("Импорт JSON",`<p class="muted">Импорт создаёт материалы как черновики. Сначала проверьте содержимое файла.</p><textarea id="kjson" rows="12" placeholder='{"items": [...]}'></textarea>`,[{label:"Отмена",cls:"ghost",onClick:()=>{}},{label:"Импортировать",cls:"primary",onClick:async btn=>{let data;try{data=JSON.parse($("#kjson").value);}catch(e){toast("Некорректный JSON",true);return true;}const r=await run(btn,()=>api("POST","/knowledge/import",{...data,confirm:true}));if(r){toast("Импортировано: "+r.imported);await knowledgeView();}}}],{wide:true});
  }

  async function route() {
    if (!ME) return;
    SEQ++; setMenu(false); window.onbeforeunload = null;
    const [, sec, id] = (location.hash || "#/dashboard").split("/");
    const s = sec || "dashboard";
    buildNav(s === "lessons" ? "courses" : s);
    const R = { kv2: kv2View, knowledge: knowledgeView, mentor: mentorView, chart: chartView, daily: dailyView, features: featuresView, dashboard: dashboardView, courses: () => (id ? courseView(id) : coursesView()), lessons: () => lessonView(id), media: mediaView, announcements: announcementsView, users: () => (id ? userView(id) : usersView()), audit: auditView, import: importView, diagnostics: diagnosticsView, partners: () => partnersView(id), links: linksView, bans: bansView };
    const nav = NAV.find(n => n[0] === (s === "lessons" ? "courses" : s));
    if (!R[s] || (nav && !can(nav[2]))) { const first = NAV.find(n => can(n[2])); location.hash = "#/" + (first ? first[0] : "dashboard"); return; }
    try { await R[s](); main.focus({ preventScroll: true }); }
    catch (e) { if (e && e.stale) return; main.innerHTML = page("Ошибка", "") + `<div class="empty">${esc(errText(e))}<br><button class="btn" onclick="location.reload()">Обновить страницу</button></div>`; if (e && e.error === "UNAUTHENTICATED") boot(); }
  }
  window.addEventListener("hashchange", route);

  async function boot() {
    ME = null;
    try { const f = await fb(); if (!f.auth.currentUser) return loginView(); }
    catch (e) { return loginView("Не удалось подключиться к Firebase. Проверьте интернет и обновите страницу."); }
    try { ME = await api("GET", "/me"); }
    catch (e) {
      if (e.error === "FORBIDDEN") { await window.hdAuth.signOut(); return loginView("У этого аккаунта нет прав администратора. Права выдаёт владелец академии."); }
      if (e.error === "BLOCKED") { await window.hdAuth.signOut(); return loginView("Аккаунт заблокирован."); }
      return loginView(errText(e));
    }
    app.dataset.view = "app";
    route();
  }
  boot();
})();
