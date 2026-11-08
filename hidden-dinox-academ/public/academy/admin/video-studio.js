/* HIDDEN DINOX VIDEO STUDIO — страница для администраторов Academy. Вход — общая сессия Firebase админ-панели (отдельной авторизации нет);
   права проверяет СЕРВЕР (/api/video-studio/*). Видео не проходит через сервер: файл уходит напрямую в Firebase Storage по защищённой возобновляемой сессии. */
(function () {
  "use strict";
  var C = window.VSCore, API = "/api/video-studio";
  var $ = function (s, r) { return (r || document).querySelector(s); }, $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var fmt = function (t) { t = Math.max(0, t || 0); return Math.floor(t / 60) + ":" + ("0" + Math.floor(t % 60)).slice(-2); };
  var mb = function (b) { return b >= 1e9 ? (b / 1e9).toFixed(2) + " ГБ" : (b / 1e6).toFixed(1) + " МБ"; };
  var S = { fb: null, me: null, st: null, tab: "projects", projects: [], pid: null, project: null, clips: [], cid: null, cv: null, media: {}, m: null, jobs: [], prevJobs: null, pending: [], saving: null, saveTimer: null, upload: null, notes: [], unread: 0, thumbs: {}, poll: null, logo: null, health: null, tg: null };
  var STATUS = { found: "Найден", edited: "Отредактирован", rendering: "Рендерится", done: "Готов", error: "Ошибка", excluded: "Исключён" };
  var PSTATUS = { uploading: "Загрузка", validating: "Проверка видео", ready: "Готово к анализу", analyzing: "Анализ", analyzed: "Клипы найдены", error: "Ошибка" };
  var JTYPE = { probe: "Проверка видео", analyze: "Анализ LIVE", window: "Окно предпросмотра", preview: "Точный предпросмотр", render: "Сборка видео", telegram: "Отправка в Telegram" };
  var STAGE = { start: "запуск", download: "загрузка файла", probe: "проверка", audio: "подготовка звука", stt: "распознавание речи", claude: "поиск моментов", clips: "нарезка клипов", render: "монтаж", upload: "сохранение" };
  var JSTATUS = { queued: "в очереди", claimed: "запуск", running: "выполняется", succeeded: "готово", failed: "ошибка", cancelled: "отменено" };
  var ERR = { UNAUTHENTICATED: "Сессия истекла — войдите в админ-панель заново", FORBIDDEN: "Video Studio доступна только администраторам", ACCOUNT_BLOCKED: "Аккаунт заблокирован", FILE_TOO_LARGE: "Файл больше допустимого", BAD_FORMAT: "Поддерживаются только MP4 и MOV", TOO_LONG: "Видео длиннее допустимого", REV_CONFLICT: "Клип изменён в другом окне — данные обновлены", ALREADY_RUNNING: "Анализ уже выполняется", DUPLICATE: "Этот файл уже загружен", ORIGIN_NOT_ALLOWED: "Загрузка запрещена с этого адреса (VIDEO_STUDIO_ORIGIN)", OUT_OF_WINDOW: "Диапазон выходит за пределы окна предпросмотра" };
  var errText = function (e) { return (e && (e.message && e.error !== "UNAVAILABLE" ? e.message : ERR[e.error])) || (e && ERR[e.error]) || "Не удалось выполнить действие"; };
  var TG_LABEL = { sent: "Доставлено в Telegram", sent_link: "Отправлена ссылка (файл слишком большой)", queued: "В очереди на отправку", sending: "Отправка…", retrying: "Повтор отправки…", failed: "Не доставлено", cancelled: "Отправка отменена" };

  function toast(text, bad) { var t = document.createElement("div"); t.className = "vs-toast"; if (bad) t.style.borderColor = "#ff6b6b"; t.textContent = text; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 5200); }
  function notify(text, bad) { S.notes.unshift({ t: Date.now(), text: text, bad: !!bad }); S.notes = S.notes.slice(0, 40); S.unread++; toast(text, bad); renderBell(); }
  async function token() { var u = S.fb.auth.currentUser; if (!u) throw { error: "UNAUTHENTICATED" }; return u.getIdToken(); }
  async function api(method, path, body) {
    var r = await fetch(API + path, { method: method, headers: Object.assign({ Authorization: "Bearer " + await token() }, body !== undefined ? { "Content-Type": "application/json" } : {}), body: body !== undefined ? JSON.stringify(body) : undefined }), j = {};
    try { j = await r.json(); } catch (e) { /* не JSON */ }
    if (!r.ok) throw Object.assign(new Error(j.message || j.error || "HTTP " + r.status), { status: r.status }, j);
    return j;
  }
  function screen(html) { $("#app").innerHTML = html; }
  var tgBadge = function (t) { if (!t) return '<span class="vs-chip">Не отправлялось</span>'; var cls = t.status === "sent" ? "ok" : t.status === "failed" ? "bad" : "warn"; return '<span class="vs-chip ' + cls + '">' + esc(TG_LABEL[t.status] || t.status) + (t.status === "sent" && t.message_id ? " · #" + t.message_id : "") + "</span>" + (t.error && t.status === "failed" ? '<div class="vs-err vs-small">' + esc(t.error.message) + "</div>" : ""); };

  /* ---------- запуск ---------- */
  async function boot() {
    try { S.fb = await window.__vsFb; } catch (e) { return screen('<p class="vs-err" style="padding:24px">Не удалось подключиться к Firebase. Проверьте интернет и обновите страницу.</p>'); }
    if (!S.fb.auth.currentUser) { screen('<div class="vs-card vs-login"><div class="vs-brand">HIDDEN DINOX | <b>VIDEO STUDIO</b></div><p class="vs-muted">Нужно войти в админ-панель Academy: Video Studio использует ту же сессию.</p><a class="vs-btn vs-primary" href="/admin/" style="display:inline-block;text-decoration:none;padding:8px 14px;border-radius:8px">Открыть админ-панель</a></div>'); return; }
    try { S.me = await api("GET", "/me"); } catch (e) {
      if (e.status === 404) return screen('<div class="vs-card vs-login"><div class="vs-brand">HIDDEN DINOX | <b>VIDEO STUDIO</b></div><p class="vs-err">Video Studio отключена на сервере (VIDEO_STUDIO_ENABLED=1 не задана).</p><a href="/admin/">← В админ-панель</a></div>');
      return screen('<div class="vs-card vs-login"><div class="vs-brand">HIDDEN DINOX | <b>VIDEO STUDIO</b></div><p class="vs-err">' + esc(errText(e)) + '</p><a href="/admin/">← В админ-панель</a></div>');
    }
    S.st = await api("GET", "/settings"); await loadProjects(); await loadBanner(); frame(); renderView(); pollLoop();
  }
  /* «Что не настроено»: понятный список на странице, чтобы сразу видеть причину, а не гадать */
  async function loadBanner() {
    S.banner = "";
    try {
      var hl = await api("GET", "/health"), p = [];
      if (!hl.ffmpeg.ok) p.push("FFmpeg не найден на сервере. Выберите Docker (deploy/Dockerfile.render) или выполните npm install ffmpeg-static ffprobe-static — инструкция в docs/VIDEO_STUDIO.md.");
      else if (!hl.ffmpeg.ass) p.push("В FFmpeg нет субтитров (libass): используйте Docker-образ deploy/Dockerfile.render.");
      if (!hl.keys.groq) p.push("Не задана переменная GROQ_API_KEY (распознавание речи).");
      if (!hl.keys.claude) p.push("Не задан ключ Claude (ANTHROPIC_API_KEY).");
      if (!hl.keys.telegram) p.push("Не задан TELEGRAM_BOT_TOKEN: ролики не смогут приходить в Telegram.");
      if (hl.runner === null) p.push("Обработка в этом экземпляре сервера отключена (VIDEO_STUDIO_RUNNER=0).");
      if (p.length) S.banner = '<div class="vs-card vs-banner"><h3>Не всё настроено — Video Studio ещё не сможет обрабатывать видео</h3>' + p.map(function (x) { return "<div>• " + esc(x) + "</div>"; }).join("") + '<div class="vs-small vs-muted" style="margin-top:6px">Добавьте переменные в Render (Environment), сделайте Deploy и обновите страницу. Подробности: Настройки → Диагностика.</div></div>';
    } catch (e) { /* диагностика недоступна — не мешаем работе */ }
  }
  function frame() {
    screen('<header class="vs-top"><a href="/admin/" title="Админ-панель" style="color:inherit;text-decoration:none"><span class="vs-brand">HIDDEN DINOX | <b>VIDEO STUDIO</b></span></a><nav class="vs-tabs">' +
      [["projects", "Проекты"], ["queue", "Очередь"], ["history", "История"], ["settings", "Настройки"]].map(function (t) { return '<button data-tab="' + t[0] + '">' + t[1] + "</button>"; }).join("") + '</nav><div class="vs-status" id="vsstat"></div><button class="vs-bell" id="vsbell" title="Уведомления">🔔<i id="vsbadge" hidden></i></button></header><main id="vsview"></main><div class="vs-notes" id="vsnotes" hidden></div>');
    $("#app").addEventListener("click", onClick); $("#app").addEventListener("change", onChange); $("#app").addEventListener("input", onInput); window.addEventListener("resize", scaleStage);
    $("#vsbell").onclick = function () { var n = $("#vsnotes"); n.hidden = !n.hidden; S.unread = 0; renderBell(); };
  }
  function renderBell() { var b = $("#vsbadge"); if (b) { b.hidden = !S.unread; b.textContent = S.unread; } var n = $("#vsnotes"); if (n) n.innerHTML = S.notes.length ? S.notes.map(function (x) { return '<div class="' + (x.bad ? "bad" : "") + '"><span class="vs-muted">' + new Date(x.t).toLocaleTimeString("ru-RU") + "</span> " + esc(x.text) + "</div>"; }).join("") : '<div class="vs-muted">Пока нет уведомлений</div>'; }
  function renderView() {
    $$("[data-tab]").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === S.tab); });
    var v = $("#vsview"); if (S.tab === "projects") { v.innerHTML = (S.banner ? '<div class="vs-wrap" style="padding-bottom:0">' + S.banner + '</div>' : '') + '<div class="vs-grid"><div class="vs-col" id="vsL"></div><div class="vs-col" id="vsC"></div><div class="vs-col" id="vsR"></div></div>'; renderLeft(); renderCenter(); renderRight(); }
    else if (S.tab === "queue") queueView(); else if (S.tab === "history") historyView(); else settingsView(); renderTop(); renderBell();
  }
  function renderTop() {
    var st = $("#vsstat"); if (!st) return; var j = S.jobs.filter(function (x) { return ["queued", "claimed", "running"].indexOf(x.status) >= 0; })[0];
    st.innerHTML = j ? '<span class="vs-dot run"></span><span>' + esc(JTYPE[j.type] || j.type) + (j.stage ? " · " + esc(STAGE[j.stage] || j.stage) : j.status === "queued" ? " · в очереди" : "") + (j.progress ? " · " + Math.round(j.progress) + "%" : "") + "</span>" : '<span class="vs-dot"></span><span>Готов к работе</span>';
  }

  /* ---------- данные и опрос ---------- */
  async function loadProjects() { S.projects = (await api("GET", "/projects")).projects; if (S.pid && !S.projects.find(function (p) { return p.id === S.pid; })) { S.pid = null; S.project = null; S.clips = []; S.cid = null; } }
  async function openProject(id) { S.pid = id; S.cid = null; S.cv = null; S.m = null; S.project = (await api("GET", "/projects/" + id)).project; S.clips = S.project.counts.clips || S.project.status === "analyzed" ? (await api("GET", "/projects/" + id + "/clips")).clips : []; renderView(); loadThumbs(); }
  async function refreshProject() { if (!S.pid) return; await loadProjects(); if (!S.pid) return renderView(); S.project = (await api("GET", "/projects/" + S.pid)).project; S.clips = (await api("GET", "/projects/" + S.pid + "/clips")).clips; if (S.cid) await reloadClipMeta(); if (S.tab === "projects") { renderLeft(); renderRight(); } loadThumbs(); }
  async function reloadClipMeta() { if (!S.cid || !S.cv || S.pending.length) return; var v = await api("GET", "/clips/" + S.cid); S.cv.clip = v.clip; S.cv.stale = v.stale; S.cv.preview_stale = v.preview_stale; }
  async function loadThumbs() { for (var c of S.clips) { if (c.has_thumb && !S.thumbs[c.id]) { try { S.thumbs[c.id] = (await api("GET", "/clips/" + c.id + "/media?kind=thumb")).url; var el = $('[data-thumb="' + c.id + '"]'); if (el) el.style.backgroundImage = "url(" + S.thumbs[c.id] + ")"; } catch (e) { /* ещё нет */ } } } }
  var isActive = function (j) { return ["queued", "claimed", "running"].indexOf(j.status) >= 0; };
  function pollLoop() {
    clearTimeout(S.poll);
    S.poll = setTimeout(async function () {
      try {
        var jobs = (await api("GET", "/jobs")).jobs, prev = S.prevJobs, changed = false; S.jobs = jobs;
        if (prev) jobs.forEach(function (j) { var p = prev[j.id]; if (p && isActive(p) && !isActive(j)) { changed = true; jobDone(j); } });
        S.prevJobs = {}; jobs.forEach(function (j) { S.prevJobs[j.id] = j; });
        if (changed) { await refreshProject(); if (S.tab === "history") historyView(); }
        else if (jobs.some(isActive) && S.pid) { S.project = (await api("GET", "/projects/" + S.pid)).project; if (S.tab === "projects") renderLeft(); }
        renderTop(); if (S.tab === "queue") queueView();
      } catch (e) { /* временный сбой сети: попробуем позже */ }
      pollLoop();
    }, S.jobs.some(isActive) ? 2500 : 8000);
  }
  function jobDone(j) {
    var label = JTYPE[j.type] || j.type;
    if (j.status === "succeeded") notify(({ probe: "Видео проверено — можно запускать анализ", analyze: "Анализ завершён — клипы готовы к просмотру", render: "Видео собрано — можно скачать или отправить", telegram: "Ролик доставлен в Telegram ✓", preview: "Точный предпросмотр готов", window: "Окно предпросмотра обновлено" })[j.type] || label + ": готово");
    else if (j.status === "failed") notify(label + ": ошибка — " + (j.error ? j.error.message : "неизвестная"), true); else notify(label + ": отменено");
    if (j.type === "window" && j.clip_id === S.cid) openClip(S.cid);
  }

  /* ---------- левая колонка: загрузка, проекты, клипы ---------- */
  function renderLeft() {
    var el = $("#vsL"); if (!el) return; var u = S.upload, p = S.project, active = S.jobs.some(function (j) { return isActive(j) && j.project_id === S.pid; });
    var h = '<div class="vs-card"><h3>Загрузка записи LIVE</h3><div class="vs-drop" id="vsdrop" data-act="pick">Перетащите запись сюда или нажмите, чтобы выбрать файл<br><span class="vs-small">MP4 или MOV · до ' + esc(S.me.limits.max_upload_gb) + ' ГБ · до ' + esc(S.me.limits.max_duration_min) + ' мин</span></div><input type="file" id="vsfile" accept=".mp4,.mov,video/mp4,video/quicktime" hidden>';
    if (u) h += '<div style="margin-top:10px"><div class="vs-small"><b>' + esc(u.file.name) + "</b> · " + mb(u.file.size) + (u.duration ? " · " + fmt(u.duration) : "") + '</div><div class="vs-prog"><i style="width:' + Math.round(100 * u.sent / u.file.size) + '%"></i></div><div class="vs-row vs-small"><span>' + esc(u.text || "Загрузка…") + " " + Math.round(100 * u.sent / u.file.size) + "%" + (u.speed ? " · " + (u.speed / 1e6).toFixed(1) + " МБ/с" : "") + '</span><button data-act="cancel-upload">Отменить загрузку</button></div></div>';
    h += '</div><div class="vs-card"><h3>Проекты</h3>' + (S.projects.length ? S.projects.map(function (x) { return '<div class="vs-proj' + (x.id === S.pid ? " sel" : "") + '" data-act="open-project" data-id="' + esc(x.id) + '"><div><div>' + esc(x.filename) + '</div><div class="vs-small vs-muted">' + mb(x.size_bytes) + (x.duration_sec ? " · " + fmt(x.duration_sec) : "") + '</div></div><span class="vs-badge ' + (x.status === "error" ? "err" : x.status === "analyzed" ? "ok" : /ing$|ating$/.test(x.status) ? "run" : "") + '">' + esc(PSTATUS[x.status] || x.status) + "</span></div>"; }).join("") : '<p class="vs-muted vs-small">Проектов пока нет. Загрузите запись выше.</p>') + "</div>";
    if (p) {
      h += '<div class="vs-card"><h3>Найденные клипы</h3>';
      if (p.status === "error") h += '<p class="vs-err">' + esc(p.error && p.error.message || "Ошибка") + '</p><button data-act="del-project">Удалить проект</button>';
      else if (p.status === "validating" || p.status === "uploading") h += '<p class="vs-muted">Видео проверяется…</p>';
      else {
        h += '<div class="vs-row"><button class="vs-primary" data-act="analyze"' + (active || p.status === "analyzing" ? " disabled" : "") + ">" + (p.status === "analyzed" ? "Найти моменты заново" : "Найти лучшие моменты") + '</button><button data-act="del-project" class="vs-danger"' + (active ? " disabled" : "") + ">Удалить</button></div>";
        if (p.analysis && p.analysis.error) h += '<p class="vs-err vs-small">Прошлый анализ: ' + esc(p.analysis.error.message) + "</p>";
        if (p.status === "analyzed" && !S.clips.length) h += '<p class="vs-muted">Сильных моментов не найдено — это нормальный результат: ролики не создаются ради количества.</p>';
      }
      h += S.clips.map(function (c, i) { return '<div class="vs-clip' + (c.id === S.cid ? " sel" : "") + (c.status === "excluded" ? " excl" : "") + '" data-act="open-clip" data-id="' + esc(c.id) + '"><div class="vs-thumb" data-thumb="' + esc(c.id) + '"' + (S.thumbs[c.id] ? ' style="background-image:url(' + S.thumbs[c.id] + ')"' : "") + '></div><div><h4>' + (i + 1) + ". " + esc(c.title || c.hook) + "</h4><p>«" + esc(c.hook) + "»</p><p>" + esc(c.duration_s) + " с · с " + fmt(c.start) + " · " + esc(c.category) + " · AI " + esc(c.score) + '</p><span class="vs-badge ' + (c.status === "done" ? "ok" : c.status === "error" ? "err" : c.status === "rendering" ? "run" : "") + '">' + esc(STATUS[c.status] || c.status) + "</span> " + (c.telegram ? tgBadge(c.telegram) : "") + ' <span class="vs-small"><a href="#" data-act="up" data-id="' + esc(c.id) + '">▲</a> <a href="#" data-act="down" data-id="' + esc(c.id) + '">▼</a></span></div></div>'; }).join("") + "</div>";
    }
    el.innerHTML = h; var d = $("#vsdrop"), f = $("#vsfile");
    if (d && f) { d.ondragover = function (e) { e.preventDefault(); d.classList.add("over"); }; d.ondragleave = function () { d.classList.remove("over"); }; d.ondrop = function (e) { e.preventDefault(); d.classList.remove("over"); if (e.dataTransfer.files[0]) startUpload(e.dataTransfer.files[0]); }; f.onchange = function () { if (f.files[0]) startUpload(f.files[0]); f.value = ""; }; }
  }

  /* ---------- загрузка: возобновляемая, с защитой от повторной отправки ---------- */
  var lsKey = function (fp) { return "hdvs_up_" + fp; };
  function videoDuration(file) { return new Promise(function (res) { var v = document.createElement("video"), u = URL.createObjectURL(file); v.preload = "metadata"; v.onloadedmetadata = function () { res(isFinite(v.duration) ? v.duration : null); URL.revokeObjectURL(u); }; v.onerror = function () { res(null); URL.revokeObjectURL(u); }; v.src = u; }); }
  async function queryOffset(u) { var res = await fetch(u.url, { method: "PUT", headers: { "Content-Range": "bytes */" + u.file.size }, signal: u.abort.signal }); if (res.status === 308) { var rg = res.headers.get("Range"); return rg ? parseInt(rg.split("-")[1], 10) + 1 : 0; } if (res.ok) return u.file.size; throw new Error("HTTP " + res.status); }
  async function startUpload(file) {
    if (S.upload) return toast("Дождитесь окончания текущей загрузки", true);
    if (!/\.(mp4|mov)$/i.test(file.name)) return toast("Поддерживаются только MP4 и MOV", true);
    var maxB = S.me.limits.max_upload_gb * 1073741824; if (file.size > maxB) return toast("Файл больше допустимого (" + S.me.limits.max_upload_gb + " ГБ)", true);
    var fp = [file.name, file.size, file.lastModified].join(":").replace(/[^A-Za-z0-9:_.\-]/g, "_").slice(0, 190), dur = await videoDuration(file), saved = null, resume = false;
    try { saved = JSON.parse(localStorage.getItem(lsKey(fp)) || "null"); } catch (e) { saved = null; }
    var u = { file: file, duration: dur, abort: new AbortController(), sent: 0, text: "Подготовка…", fp: fp, t0: Date.now() };
    if (saved && saved.expires_at > Date.now() && saved.size === file.size) { u.url = saved.url; u.chunk = saved.chunk; u.project = { id: saved.project_id }; resume = true; }
    else {
      try { var r = await api("POST", "/projects", { filename: file.name, size: file.size, content_type: file.type || undefined, fingerprint: fp }); u.project = r.project; u.url = r.upload.url; u.chunk = r.upload.chunk_bytes; localStorage.setItem(lsKey(fp), JSON.stringify({ project_id: r.project.id, url: r.upload.url, chunk: r.upload.chunk_bytes, size: file.size, expires_at: r.upload.expires_at })); }
      catch (e) { if (e.error === "DUPLICATE") { toast("Этот файл уже загружен — открываю проект", true); if (e.project_id) { await loadProjects(); return openProject(e.project_id); } } return toast(errText(e), true); }
    }
    S.upload = u; S.pid = u.project.id; await loadProjects(); S.project = S.projects.find(function (p) { return p.id === S.pid; }) || null; S.tab = "projects"; renderView();
    try {
      if (resume) { u.text = "Возобновление загрузки…"; renderLeft(); try { u.sent = await queryOffset(u); } catch (e) { u.sent = 0; } }
      await putChunks(u); u.text = "Проверка файла"; renderLeft(); await api("POST", "/projects/" + u.project.id + "/upload/complete"); localStorage.removeItem(lsKey(fp)); S.upload = null; await loadProjects(); await openProject(u.project.id); notify("Файл загружен, идёт проверка");
    } catch (e) {
      var cancelled = e && e.name === "AbortError"; var netFail = e && e.name === "TypeError" && !(u.sent > 0); S.upload = null;
      if (netFail) toast("Файл не удалось отправить в хранилище. Чаще всего не настроен CORS: Настройки → Диагностика → «Настроить CORS хранилища». Затем выберите файл ещё раз.", true);
      if (!cancelled) { toast("Загрузка прервана: " + errText(e) + " — выберите тот же файл ещё раз, и загрузка продолжится с места остановки", true); if (e && (e.error === "NOT_UPLOADED" || e.status === 404 || e.status === 410)) localStorage.removeItem(lsKey(fp)); }
      await loadProjects().catch(function () {}); renderView();
    }
  }
  async function putChunks(u) {
    var off = u.sent || 0, retries = 0;
    while (off < u.file.size) {
      var end = Math.min(off + u.chunk, u.file.size), t0 = Date.now();
      try {
        var res = await fetch(u.url, { method: "PUT", headers: { "Content-Range": "bytes " + off + "-" + (end - 1) + "/" + u.file.size }, body: u.file.slice(off, end), signal: u.abort.signal });
        if (res.status === 308) { var rg = res.headers.get("Range"); off = rg ? parseInt(rg.split("-")[1], 10) + 1 : 0; } else if (res.ok) off = u.file.size; else throw new Error("HTTP " + res.status);
        u.sent = off; u.speed = (end - (off - (end - off > 0 ? 0 : 0))) && (Math.min(u.chunk, u.file.size) / Math.max(0.2, (Date.now() - t0) / 1000)); u.text = "Загрузка"; retries = 0; renderLeft();
      } catch (e) { if (e.name === "AbortError") throw e; if (++retries > 6) throw e; u.text = "Повтор после сбоя сети…"; renderLeft(); await sleep(1500 * retries); try { off = await queryOffset(u); } catch (e2) { /* повторим с тем же местом */ } }
    }
  }
  async function cancelUpload() { var u = S.upload; if (!u) return; u.abort.abort(); try { await fetch(u.url, { method: "DELETE" }); } catch (e) { /* сессия истечёт сама */ } try { await api("POST", "/projects/" + u.project.id + "/upload/cancel"); } catch (e) { /* уже отменён */ } localStorage.removeItem(lsKey(u.fp)); toast("Загрузка отменена"); }

  /* ---------- анализ: подтверждение расхода ---------- */
  async function analyze() {
    var r; try { r = await api("GET", "/projects/" + S.pid + "/estimate"); } catch (e) { return toast(errText(e), true); }
    var est = r.estimate, m = document.createElement("div"); m.className = "vs-modal";
    m.innerHTML = '<div><h3 style="color:#A6F32B">Оценка расхода</h3><p>Запись: ' + fmt(r.duration_sec) + ". Распознавание Groq ≈ $" + est.groq_usd + " · Claude ≈ $" + est.claude_usd + " · вычисления ≈ $" + est.compute_usd + '.</p><p><b>Итого с запасом ≈ $' + est.total_usd + "</b> (лимит на задачу $" + esc(r.limits.per_job_usd) + ", на месяц $" + esc(r.limits.monthly_usd) + ').</p><p class="vs-small vs-muted">Клипы: ' + esc(r.clips.min_s) + "–" + esc(r.clips.max_s) + " с, не более " + esc(r.clips.max_clips) + ". В Groq уходит только звук, в Claude только текст расшифровки; видео никому не передаётся.</p>" + '<div class="vs-row"><button class="vs-primary" id="vsgo">Подтвердить и запустить</button><button id="vsno">Отмена</button></div></div>';
    document.body.appendChild(m); $("#vsno").onclick = function () { m.remove(); };
    $("#vsgo").onclick = async function () { m.remove(); try { var a = await api("POST", "/projects/" + S.pid + "/analyze", { confirm: true }); toast(a.cached ? "Такой анализ уже выполнен: платить повторно не нужно" : "Анализ запущен"); await refreshProject(); S.jobs = (await api("GET", "/jobs")).jobs; renderTop(); } catch (e) { toast(errText(e), true); } };
  }

  /* ---------- клип: открытие, модель предпросмотра ---------- */
  async function openClip(id) {
    S.cid = id; S.cv = null; S.m = null; S.pending = []; S.media = {}; if (S.tab !== "projects") { S.tab = "projects"; renderView(); } else { renderCenter(); renderRight(); renderLeft(); }
    try { S.cv = await api("GET", "/clips/" + id); } catch (e) { return toast(errText(e), true); }
    try { S.media = await api("GET", "/clips/" + id + "/media?kind=window"); } catch (e) { S.media = { error: errText(e) }; }
    if (!S.logo) { try { S.logo = await api("GET", "/logo"); } catch (e) { S.logo = { brand: [], custom: false }; } }
    buildModel(); renderCenter(); renderRight(); renderLeft();
  }
  var visWords = function () { return S.cv.edits.words.filter(function (w) { return !w.deleted; }); };
  function buildModel() {
    var v = S.cv, t = v.template, e = v.edits, ws = visWords().map(function (w) { return { id: w.id, word: w.text, start: w.start, end: w.end }; }); if (!ws.length) { S.m = null; return; }
    var keep = C.buildKeep(ws, t.cuts), dur = C.finalDuration(keep), ow = ws.map(function (w) { return { id: w.id, word: w.word.replace(/[{}\\]/g, "").trim(), start: C.toOut(w.start, keep), end: C.toOut(w.end, keep) }; });
    var chunks = C.chunkWords(ow, { max_words: t.subtitles.max_words, max_chars: t.subtitles.max_chars, breaks: e.breaks, joins: e.joins }).map(function (ch, i, arr) { var st = ch[0].start, en = ch[ch.length - 1].end + 0.12; if (i + 1 < arr.length) en = Math.min(en, arr[i + 1][0].start); return { words: ch, st: st, en: Math.min(Math.max(en, st + 0.2), dur) }; });
    S.m = { keep: keep, dur: dur, chunks: chunks, ws: ws, cur: 0 };
  }
  function logoUrl() { var l = S.cv && S.cv.template.logo; if (!l || !l.enabled) return null; if (l.source === "custom") return S.logo && S.logo.custom_url; var m = /^brand:(.+)$/.exec(l.source || ""); return m ? "/academy/assets/brand/" + encodeURIComponent(m[1]) : null; }

  /* ---------- центр: предпросмотр 9:16 + шкала обрезки ---------- */
  function renderCenter() {
    var el = $("#vsC"); if (!el) return;
    if (!S.cid || !S.cv) { el.innerHTML = '<div class="vs-card"><h3>Предпросмотр</h3><p class="vs-muted">' + (S.cid ? "Загрузка клипа…" : "Выберите клип слева: здесь появится видео 9:16 с хуком, субтитрами, логотипом и оформлением Hidden Dinox.") + "</p></div>"; return; }
    el.innerHTML = '<div class="vs-card"><h3>Предпросмотр · ' + esc(S.cv.clip.title || S.cv.clip.hook) + '</h3><div class="vs-stage-wrap" id="vswrap"><div class="vs-stage" id="vsstage"></div></div><div class="vs-ctl"><button data-act="play" id="vsplay">▶</button><button data-act="replay" title="Сначала">↺</button><input type="range" id="vsseek" min="0" max="1000" value="0"><span class="vs-small" id="vstime">0:00</span></div>' +
      '<div class="vs-tl" id="vstl"></div><p class="vs-small vs-muted">Быстрый предпросмотр показывает оформление в браузере; «Точный предпросмотр» собирает черновик тем же кодом, что и финал.' + (S.media.error ? ' <span class="vs-err">' + esc(S.media.error) + "</span>" : "") + "</p></div>";
    drawStage(); scaleStage(); mountVideo(); renderTimeline();
  }
  function drawStage() {
    var st = $("#vsstage"); if (!st || !S.cv) return; var t = S.cv.template, w = t.window, e = S.cv.edits, hk = t.hook, sb = t.subtitles, cta = t.cta, br = t.brand, bar = t.bar, cl = t.colors, fr = e.framing || { zoom: 1, pan_x: 0, pan_y: 0 };
    var hx = e.hook.x != null ? e.hook.x : hk.x, hy = e.hook.y != null ? e.hook.y : hk.y, hs = e.hook.size || hk.size, lu = logoUrl(), sw = (S.project && S.project.width) || 720, k = 1080 / sw;
    st.innerHTML = '<video id="vsvid" playsinline preload="auto" style="top:' + w.y + "px;width:1080px;height:" + w.h + 'px;transform:scale(' + fr.zoom + ") translate(" + (-fr.pan_x * k) + "px," + (-fr.pan_y * k) + 'px)"></video>' +
      '<div class="vs-line" style="top:' + (w.y - t.glow.thin) + "px;height:" + t.glow.thin + 'px"></div><div class="vs-line" style="top:' + (w.y + w.h) + "px;height:" + t.glow.thin + 'px"></div>' +
      (lu ? '<img class="vs-logo" alt="" src="' + esc(lu) + '" style="left:' + t.logo.x + "px;top:" + t.logo.y + "px;width:" + t.logo.w + 'px">' : "") +
      '<div class="vs-hd" style="left:' + br.margin_l + "px;top:" + br.margin_v + "px;font-size:" + br.size + "px;letter-spacing:" + br.spacing + "px;color:" + cl.accent + '">' + esc(br.text) + "</div>" +
      '<div class="vs-hook" id="vshook" style="left:' + hx + "px;top:" + hy + "px;width:" + (1080 - hk.margin_l - hk.margin_r) + "px;font-size:" + hs + 'px"></div>' +
      '<div class="vs-sub" id="vssub" style="left:' + sb.x + "px;top:" + sb.y + "px;width:" + (1080 - sb.margin_l - sb.margin_r) + "px;font-size:" + sb.size + 'px"></div>' +
      '<div class="vs-cta" id="vscta" style="left:' + cta.x + "px;top:" + cta.y + "px;font-size:" + cta.size + 'px"></div>' + (bar.enabled ? '<div class="vs-bar" id="vsbar" style="top:' + bar.y + "px;height:" + bar.h + 'px;width:0"></div>' : "");
    st.style.setProperty("--ac", cl.accent); paintOverlay(S.m ? S.m.cur || 0 : 0);
  }
  function scaleStage() { var wrap = $("#vswrap"), st = $("#vsstage"); if (!wrap || !st) return; var avail = Math.max(240, ($("#vsC").clientWidth || 360) - 28), k = Math.min(avail / 1080, Math.max(0.2, (window.innerHeight - 330) / 1920)); st.style.transform = "scale(" + k + ")"; wrap.style.width = Math.round(1080 * k) + "px"; wrap.style.height = Math.round(1920 * k) + "px"; }
  function mountVideo() {
    var v = $("#vsvid"); if (!v || !S.media || !S.media.url) return; v.src = S.media.url; v.muted = false;
    v.addEventListener("loadedmetadata", function () { if (v.videoWidth) { var w = S.cv.template.window, h = Math.min(w.h, Math.round(1080 * v.videoHeight / v.videoWidth)); v.style.height = h + "px"; v.style.top = (w.y + Math.round((w.h - h) / 2)) + "px"; } seekOut(0); });
    v.addEventListener("play", function () { var b = $("#vsplay"); if (b) b.textContent = "⏸"; raf(); }); v.addEventListener("pause", function () { var b = $("#vsplay"); if (b) b.textContent = "▶"; });
    v.addEventListener("seeked", function () { paintOverlay(curOut()); }); var sk = $("#vsseek"); sk.oninput = function () { if (S.m) seekOut(S.m.dur * sk.value / 1000); };
  }
  var rafId = 0; function raf() { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(function loop() { var v = $("#vsvid"); if (!v || v.paused) return; tick(); rafId = requestAnimationFrame(loop); }); }
  var wsOf = function () { return S.cv.clip.window_start || 0; };
  function absTime() { var v = $("#vsvid"); return v ? v.currentTime + wsOf() : 0; }
  function curOut() { return S.m ? C.toOut(absTime(), S.m.keep) : 0; }
  function fromOut(o) { var cum = 0, k = S.m.keep; for (var i = 0; i < k.length; i++) { var len = k[i][1] - k[i][0]; if (o <= cum + len) return k[i][0] + (o - cum); cum += len; } return k[k.length - 1][1]; }
  function seekOut(o) { var v = $("#vsvid"); if (!v || !S.m) return; v.currentTime = Math.max(0, fromOut(Math.max(0, Math.min(o, S.m.dur))) - wsOf()); paintOverlay(o); }
  function tick() { var v = $("#vsvid"); if (!v || !S.m) return; var abs = absTime(), k = S.m.keep, inside = k.some(function (p) { return abs >= p[0] - 0.02 && abs <= p[1]; }); if (!inside) { var nx = k.find(function (p) { return p[0] > abs; }); if (nx) v.currentTime = nx[0] - wsOf(); else { v.pause(); seekOut(0); return; } } paintOverlay(C.toOut(abs, k)); }
  function paintOverlay(o) {
    if (!S.m || !S.cv) return; S.m.cur = o; var t = S.cv.template, e = S.cv.edits, m = S.m;
    var hook = $("#vshook"); if (hook) { hook.textContent = e.hook.enabled && e.hook.text ? e.hook.text : ""; hook.style.opacity = o <= t.hook.show_seconds ? 1 : 0; }
    var sub = $("#vssub"); if (sub) { var ch = m.chunks.find(function (c) { return o >= c.st && o < c.en; }); sub.innerHTML = ch ? ch.words.map(function (w) { var em = e.emphasis.indexOf(w.id) >= 0, on = o >= w.start; return '<span class="' + (on || em ? (em ? "em" : "on") : "") + '">' + esc(w.word.replace(/[,.;:]+$/, "")) + "</span>"; }).join(" ") : ""; }
    var cta = $("#vscta"); if (cta) { var c = t.cta, show = c.enabled && e.cta.enabled !== false, len = Math.min(c.max_seconds, Math.max(c.min_seconds, m.dur * c.fraction)); cta.textContent = e.cta.text || c.text; cta.style.opacity = show && o >= m.dur - len ? 1 : 0; }
    var bar = $("#vsbar"); if (bar) bar.style.width = (1080 * o / m.dur) + "px"; var tm = $("#vstime"); if (tm) tm.textContent = fmt(o) + " / " + fmt(m.dur); var sk = $("#vsseek"); if (sk && document.activeElement !== sk) sk.value = Math.round(1000 * o / m.dur);
    var cur = m.ws.find(function (w) { return C.toOut(w.start, m.keep) <= o && o <= C.toOut(w.end, m.keep) + 0.05; }); $$(".vs-w.cur").forEach(function (r) { r.classList.remove("cur"); }); if (cur) { var row = $('.vs-w[data-wid="' + cur.id + '"]'); if (row) row.classList.add("cur"); }
    var tc = $("#tlcur"); if (tc && S.cv.clip.window_dur) tc.style.left = (100 * (absTime() - wsOf()) / S.cv.clip.window_dur) + "%";
  }

  /* ---------- шкала обрезки начала и конца ---------- */
  function renderTimeline() {
    var el = $("#vstl"); if (!el || !S.cv) return; var c = S.cv.clip, ws = c.window_start, wd = c.window_dur; if (ws == null || !wd) { el.innerHTML = '<p class="vs-muted vs-small">Обрезка недоступна: окно предпросмотра не подготовлено.</p>'; return; }
    S.tl = S.tl && S.tl.id === c.id ? S.tl : { id: c.id, s: c.start, e: c.end }; if (S.tl.s < ws || S.tl.e > ws + wd) { S.tl.s = c.start; S.tl.e = c.end; }
    el.innerHTML = '<div class="vs-small vs-muted">Обрезка: перетащите границы или введите время. Окно ' + fmt(ws) + "–" + fmt(ws + wd) + ' записи.</div><div class="vs-tl-bar" id="tlbar"><i class="rng" id="tlrng"></i><b class="h" id="tlh1" data-h="s"></b><b class="h" id="tlh2" data-h="e"></b><u id="tlcur"></u></div>' +
      '<div class="vs-row" style="margin-top:6px"><label class="vs-small">Начало, с <input type="number" step="0.1" id="tl-s" style="width:90px"></label><button data-act="tl" data-d="s-" title="−0,1 с">−</button><button data-act="tl" data-d="s+">+</button><label class="vs-small">Конец, с <input type="number" step="0.1" id="tl-e" style="width:90px"></label><button data-act="tl" data-d="e-">−</button><button data-act="tl" data-d="e+">+</button><button class="vs-primary" data-act="range-apply">Применить обрезку</button><button data-act="win-extend" title="Подготовить новое окно предпросмотра шире текущего">Расширить окно</button></div><div class="vs-small" id="tlinfo"></div>';
    paintTl(); var bar = $("#tlbar");
    $$(".h", bar).forEach(function (h) { h.onpointerdown = function (ev) { ev.preventDefault(); h.setPointerCapture(ev.pointerId); var which = h.dataset.h; h.onpointermove = function (e2) { var r = bar.getBoundingClientRect(), t = ws + wd * Math.max(0, Math.min(1, (e2.clientX - r.left) / r.width)); setTl(which, t); }; h.onpointerup = function () { h.onpointermove = null; h.onpointerup = null; }; }; });
  }
  function setTl(which, t) { var c = S.cv.clip, ws = c.window_start, we = ws + c.window_dur; t = Math.round(t * 10) / 10; if (which === "s") S.tl.s = Math.max(ws + 0.3, Math.min(t, S.tl.e - 3)); else S.tl.e = Math.min(we - 0.3, Math.max(t, S.tl.s + 3)); paintTl(); }
  function paintTl() {
    var c = S.cv.clip, ws = c.window_start, wd = c.window_dur, p = function (t) { return 100 * (t - ws) / wd; }; var r = $("#tlrng"); if (!r) return; r.style.left = p(S.tl.s) + "%"; r.style.width = (p(S.tl.e) - p(S.tl.s)) + "%"; $("#tlh1").style.left = p(S.tl.s) + "%"; $("#tlh2").style.left = p(S.tl.e) + "%";
    var a = $("#tl-s"), b = $("#tl-e"); if (a && document.activeElement !== a) a.value = S.tl.s.toFixed(1); if (b && document.activeElement !== b) b.value = S.tl.e.toFixed(1);
    var inf = $("#tlinfo"); if (inf) inf.textContent = "Длина фрагмента: " + (S.tl.e - S.tl.s).toFixed(1) + " с" + (Math.abs(S.tl.s - c.start) > 0.05 || Math.abs(S.tl.e - c.end) > 0.05 ? " · изменения не применены" : "");
  }
  async function applyRange() {
    await flush(); try { S.cv = Object.assign({}, S.cv, await api("PUT", "/clips/" + S.cid + "/range", { start: S.tl.s, end: S.tl.e })); S.tl = null; buildModel(); renderRight(); drawStage(); renderTimeline(); await refreshProject(); toast("Обрезка применена: слова взяты из расшифровки, ваши правки сохранены"); }
    catch (e) { if (e.error === "OUT_OF_WINDOW") toast("Диапазон шире окна предпросмотра — нажмите «Расширить окно» и дождитесь готовности", true); else toast(errText(e), true); }
  }
  async function extendWindow() { try { await api("POST", "/clips/" + S.cid + "/window", { start: Math.max(0, S.tl.s - 8), end: Math.min(S.project.duration_sec, S.tl.e + 8) }); toast("Готовлю новое окно предпросмотра…"); S.jobs = (await api("GET", "/jobs")).jobs; renderTop(); } catch (e) { toast(errText(e), true); } }

  /* ---------- правая колонка: редактор ---------- */
  function renderRight() {
    var el = $("#vsR"); if (!el) return; if (!S.cid || !S.cv) { el.innerHTML = ""; return; }
    var v = S.cv, e = v.edits, t = v.template, c = v.clip, ck = v.checks, fr = e.framing || { zoom: 1, pan_x: 0, pan_y: 0 }, busy = S.jobs.some(function (j) { return isActive(j) && j.clip_id === c.id && j.type !== "telegram"; }), tgBusy = S.jobs.some(function (j) { return isActive(j) && j.clip_id === c.id && j.type === "telegram"; });
    var h = '<div class="vs-card"><h3>Хук и призыв</h3><label class="vs-small vs-muted">Хук (на экране с первой секунды)</label><input id="f-hook" value="' + esc(e.hook.text) + '" maxlength="80"><div class="vs-row" style="margin-top:6px"><button data-act="hooks">✨ Предложить хуки (ИИ)</button><button data-act="hook-reset">Вернуть исходный</button></div><div class="vs-row" style="margin-top:6px"><label class="vs-small">Размер <input id="f-hsize" type="number" min="24" max="120" placeholder="' + t.hook.size + '" value="' + (e.hook.size || "") + '" style="width:80px"></label><label class="vs-small">Верх, px <input id="f-hy" type="number" min="0" max="1900" placeholder="' + t.hook.y + '" value="' + (e.hook.y != null ? e.hook.y : "") + '" style="width:90px"></label><label class="vs-small"><input id="f-hon" type="checkbox"' + (e.hook.enabled ? " checked" : "") + '> показывать</label></div>' +
      '<label class="vs-small vs-muted" style="display:block;margin-top:8px">Призыв в конце</label><input id="f-cta" value="' + esc(e.cta.text || "") + '" placeholder="' + esc(t.cta.text) + '" maxlength="60"><label class="vs-small"><input id="f-cton" type="checkbox"' + (e.cta.enabled !== false ? " checked" : "") + "> показывать призыв</label></div>" +
      '<div class="vs-card"><h3>Кадр</h3><label class="vs-small">Масштаб: <span id="fr-zv">' + fr.zoom.toFixed(2) + '×</span><input class="vs-range" id="fr-z" type="range" min="1" max="2.5" step="0.05" value="' + fr.zoom + '"></label><label class="vs-small">Сдвиг по горизонтали: <span id="fr-xv">' + fr.pan_x + '</span><input class="vs-range" id="fr-x" type="range" min="-300" max="300" step="5" value="' + fr.pan_x + '"></label><label class="vs-small">Сдвиг по вертикали: <span id="fr-yv">' + fr.pan_y + '</span><input class="vs-range" id="fr-y" type="range" min="-300" max="300" step="5" value="' + fr.pan_y + '"></label><button data-act="fr-reset">Сбросить кадр</button></div>';
    h += '<div class="vs-card"><h3>Субтитры</h3><textarea id="f-full" rows="4">' + esc(visWords().map(function (w) { return w.text; }).join(" ")) + '</textarea><div class="vs-row" style="margin-top:6px"><button data-act="rewrite">Применить как правку предложения</button></div><p class="vs-small vs-muted">Неизменённые слова сохраняют исходное время; новые получают время между соседями и помечаются «?».</p><div class="vs-words">' + e.words.map(function (w) { return wordRow(w, e); }).join("") + '</div><p class="vs-small vs-muted">★ ключевое слово · ⌫ убрать · ＋ добавить после · ¶ граница блока · «?» время не подтверждено</p></div>';
    if (v.suggestions && v.suggestions.length) h += '<div class="vs-card"><h3>Подсказки терминов</h3>' + v.suggestions.map(function (s) { return '<div class="vs-row vs-small"><span>«' + esc(s.from) + "» → <b>" + esc(s.to) + '</b></span><button data-act="suggest" data-id="' + esc(s.id) + '" data-to="' + esc(s.to) + '">Применить</button></div>'; }).join("") + "</div>";
    h += '<div class="vs-card"><h3>Результат</h3><p class="vs-small">Длительность ролика: <b>' + ck.final_s + " с</b> · слов " + ck.words + "</p>" + ck.warnings.map(function (w) { return '<div class="vs-warn">⚠ ' + esc(w.message) + "</div>"; }).join("") +
      '<div class="vs-row" style="margin-top:8px"><button data-act="preview"' + (busy ? " disabled" : "") + '>Точный предпросмотр</button><button class="vs-primary" data-act="render"' + (busy || !ck.can_render ? " disabled" : "") + '>ПЕРЕСОБРАТЬ ВИДЕО</button></div>';
    if (c.render) h += '<div class="vs-row" style="margin-top:8px"><button data-act="download">Скачать MP4' + (v.stale ? " (устарел)" : "") + '</button><button data-act="tg-send"' + (tgBusy ? " disabled" : "") + ">" + (c.telegram && (c.telegram.status === "sent" || c.telegram.status === "sent_link") ? "Отправить в Telegram повторно" : "Отправить в Telegram") + '</button></div><p class="vs-small vs-muted">Готовая версия: ' + (v.stale ? "есть, но вы изменили клип после сборки — пересоберите" : "актуальна") + " · " + mb(c.render.size || 0) + '</p><div>' + tgBadge(c.telegram) + "</div>" + (c.telegram && c.telegram.status === "failed" ? '<div class="vs-row" style="margin-top:6px"><button data-act="tg-send" data-force="1">Повторить отправку</button><button data-act="tg-send" data-reupload="1">Загрузить файл заново</button></div>' : "");
    h += '<div class="vs-row" style="margin-top:8px"><button data-act="exclude" class="vs-danger">' + (c.status === "excluded" ? "Вернуть клип" : "Исключить клип") + "</button></div>" + (c.error ? '<p class="vs-err vs-small">' + esc(c.error.message) + "</p>" : "") + "</div>";
    el.innerHTML = h;
  }
  function wordRow(w, e) {
    return '<div class="vs-w' + (w.deleted ? " del" : "") + (w.synced === false ? " uns" : "") + '" data-wid="' + esc(w.id) + '"><button data-act="emph" data-id="' + esc(w.id) + '" title="Ключевое слово">' + (e.emphasis.indexOf(w.id) >= 0 ? "★" : "☆") + '</button><input type="text" data-f="text" value="' + esc(w.text) + '" maxlength="60"' + (w.deleted ? " disabled" : "") + '><input type="number" step="0.05" data-f="start" value="' + w.start + '" title="начало, с"><input type="number" step="0.05" data-f="end" value="' + w.end + '" title="конец, с">' +
      (w.deleted ? '<button data-act="restore" data-id="' + esc(w.id) + '" title="Вернуть">↺</button><span></span>' : '<button data-act="del" data-id="' + esc(w.id) + '" title="Убрать слово">⌫</button><button data-act="add" data-id="' + esc(w.id) + '" title="Добавить слово после">＋</button>') + "</div>" +
      (w.deleted ? "" : '<div class="vs-small" style="grid-column:2/7;margin:-2px 0 4px 26px"><a href="#" data-act="brk" data-on="' + (e.breaks.indexOf(w.id) >= 0 ? "0" : "1") + '" data-id="' + esc(w.id) + '">' + (e.breaks.indexOf(w.id) >= 0 ? "¶ убрать границу блока" : "¶ закончить блок здесь") + '</a> · <a href="#" data-act="join" data-on="' + (e.joins.indexOf(w.id) >= 0 ? "0" : "1") + '" data-id="' + esc(w.id) + '">' + (e.joins.indexOf(w.id) >= 0 ? "не разрывать: включено — убрать" : "не разрывать после слова") + "</a></div>") +
      (w.synced === false && !w.deleted ? '<div class="vs-small vs-warn" style="margin:-2px 0 4px 26px">«?» время приблизительное <a href="#" data-act="confirm" data-id="' + esc(w.id) + '">подтвердить</a></div>' : "");
  }

  /* ---------- правки: очередь и автосохранение ---------- */
  var COALESCE = { set_text: "id", set_time: "id", set_hook: "", set_cta: "", set_framing: "" };
  function queue(op, immediate) {
    var key = COALESCE[op.op]; if (key !== undefined) S.pending = S.pending.filter(function (p) { return !(p.op === op.op && (key === "" || p[key] === op[key])); });
    S.pending.push(op); applyLocal(op); buildModel(); drawStageSoft(); statusSaving("Сохранение…"); clearTimeout(S.saveTimer); S.saveTimer = setTimeout(flush, immediate ? 0 : 600);
  }
  function drawStageSoft() { if (op_needs_stage()) drawStage(); else paintOverlay(S.m ? S.m.cur || 0 : 0); }
  var STAGE_OPS = false; function op_needs_stage() { var r = STAGE_OPS; STAGE_OPS = false; return r; }
  function statusSaving(t) { var s = $("#vsstat"); if (s && !S.jobs.some(isActive)) s.innerHTML = '<span class="vs-dot"></span><span>' + esc(t) + "</span>"; }
  function applyLocal(op) {
    var e = S.cv.edits, w = op.id && e.words.find(function (x) { return x.id === op.id; }), tg = function (a, id, on) { var i = a.indexOf(id); if (on && i < 0) a.push(id); if (!on && i >= 0) a.splice(i, 1); };
    if (op.op === "set_text" && w) w.text = op.text; else if (op.op === "set_time" && w) { w.start = op.start; w.end = op.end; } else if (op.op === "delete" && w) w.deleted = true; else if (op.op === "restore" && w) w.deleted = false;
    else if (op.op === "set_hook") Object.keys(op).forEach(function (k) { if (k !== "op") e.hook[k] = op[k]; }); else if (op.op === "set_cta") Object.keys(op).forEach(function (k) { if (k !== "op") e.cta[k] = op[k]; });
    else if (op.op === "set_framing") { e.framing = e.framing || { zoom: 1, pan_x: 0, pan_y: 0 }; Object.keys(op).forEach(function (k) { if (k !== "op") e.framing[k] = op[k]; }); STAGE_OPS = true; }
    else if (op.op === "set_emphasis") tg(e.emphasis, op.id, op.on); else if (op.op === "set_break") tg(e.breaks, op.id, op.on); else if (op.op === "set_join") tg(e.joins, op.id, op.on); else if (op.op === "confirm_sync" && w) w.synced = true;
  }
  var STRUCT = { set_join: 1, add_after: 1, rewrite_range: 1, reset_word: 1, reset_hook: 1, reset_framing: 1, delete: 1, restore: 1, confirm_sync: 1, set_break: 1, set_emphasis: 1 };
  async function flush() {
    if (S.saving) await S.saving; if (!S.pending.length || !S.cv) return; var ops = S.pending.splice(0), id = S.cid, structural = ops.some(function (o) { return STRUCT[o.op]; });
    S.saving = (async function () {
      try { var r = await api("PUT", "/clips/" + id + "/edits", { base_rev: S.cv.edits.rev, ops: ops }); if (S.cid !== id) return; S.cv.edits = r.edits; S.cv.checks = r.checks; S.cv.suggestions = r.suggestions; S.cv.current_hash = r.current_hash; S.cv.stale = !!(S.cv.clip.render && S.cv.clip.render.hash !== r.current_hash); S.cv.clip.status = ["rendering", "excluded"].indexOf(S.cv.clip.status) >= 0 ? S.cv.clip.status : "edited"; buildModel(); statusSaving("сохранено"); if (structural || !$(".vs-words input:focus")) renderRight(); paintOverlay(S.m ? S.m.cur || 0 : 0); renderLeft(); }
      catch (e) { toast(errText(e), true); if (S.cid === id) await openClip(id); }
    })(); await S.saving; S.saving = null;
  }

  /* ---------- вкладка «Очередь» ---------- */
  function queueView() {
    var v = $("#vsview"); if (!v) return; var name = function (id) { var p = S.projects.find(function (x) { return x.id === id; }); return p ? p.filename : id; };
    v.innerHTML = '<div class="vs-wrap"><div class="vs-card"><h3>Очередь обработки</h3>' + (S.jobs.length ? '<table class="vs-table"><tr><th>Задание</th><th>Проект</th><th>Статус</th><th>Прогресс</th><th></th></tr>' + S.jobs.map(function (j) {
      var act = isActive(j); return "<tr><td>" + esc(JTYPE[j.type] || j.type) + '<div class="vs-small vs-muted">' + new Date(j.created_at).toLocaleString("ru-RU") + "</div></td><td>" + esc(name(j.project_id)) + '</td><td><span class="vs-chip ' + (j.status === "succeeded" ? "ok" : j.status === "failed" ? "bad" : act ? "warn" : "") + '">' + esc(JSTATUS[j.status] || j.status) + "</span>" + (j.stage && act ? '<div class="vs-small vs-muted">' + esc(STAGE[j.stage] || j.stage) + "</div>" : "") + (j.error ? '<div class="vs-small ' + (j.status === "failed" ? "vs-err" : "vs-warn") + '">' + esc(j.error.message) + (j.error.retrying && j.next_run_at ? " · повтор в " + new Date(j.next_run_at).toLocaleTimeString("ru-RU") : "") + "</div>" : "") + '</td><td style="width:140px">' + (act ? '<div class="vs-prog"><i style="width:' + Math.round(j.progress || 0) + '%"></i></div>' : "") + "</td><td>" + (act ? '<button data-act="cancel-job" data-id="' + esc(j.id) + '">Отмена</button>' : (j.status === "failed" || j.status === "cancelled") ? '<button data-act="retry-job" data-id="' + esc(j.id) + '">Повторить</button>' : "") + "</td></tr>";
    }).join("") + "</table>" : '<p class="vs-muted">Заданий пока нет.</p>') + "</div></div>";
  }

  /* ---------- вкладка «История» ---------- */
  async function historyView() {
    var v = $("#vsview"); if (!v) return; v.innerHTML = '<div class="vs-wrap"><p class="vs-muted">Загрузка…</p></div>'; var items;
    try { items = (await api("GET", "/history")).items; } catch (e) { v.innerHTML = '<div class="vs-wrap"><p class="vs-err">' + esc(errText(e)) + "</p></div>"; return; }
    if (S.tab !== "history") return;
    v.innerHTML = '<div class="vs-wrap"><div class="vs-card"><h3>Готовые видео</h3>' + (items.length ? '<div class="vs-hist">' + items.map(function (c) { return '<div class="vs-hcard"><div class="vs-thumb" data-thumb="' + esc(c.id) + '"' + (S.thumbs[c.id] ? ' style="background-image:url(' + S.thumbs[c.id] + ')"' : "") + "></div><div><b>" + esc(c.hook) + '</b><span class="vs-small vs-muted">' + esc(c.project) + " · " + esc(c.render.duration ? Number(c.render.duration).toFixed(0) : c.duration_s) + " с · " + mb(c.render.size || 0) + " · " + new Date(c.render.at).toLocaleString("ru-RU") + "</span><div>" + tgBadge(c.telegram) + '</div><div class="vs-row"><button data-act="h-download" data-id="' + esc(c.id) + '">Скачать</button><button data-act="h-tg" data-id="' + esc(c.id) + '">' + (c.telegram && c.telegram.status === "sent" ? "Отправить повторно" : "В Telegram") + '</button><button data-act="h-open" data-id="' + esc(c.id) + '" data-pid="' + esc(c.project_id) + '">Открыть</button></div></div></div>'; }).join("") + "</div>" : '<p class="vs-muted">Готовых видео пока нет: соберите клип кнопкой «Пересобрать видео».</p>') + "</div></div>";
    items.forEach(function (c) { if (c.has_thumb && !S.thumbs[c.id]) api("GET", "/clips/" + c.id + "/media?kind=thumb").then(function (r) { S.thumbs[c.id] = r.url; var el = $('[data-thumb="' + c.id + '"]'); if (el) el.style.backgroundImage = "url(" + r.url + ")"; }).catch(function () {}); });
  }

  /* ---------- вкладка «Настройки» ---------- */
  var TPL_FIELDS = [
    ["Субтитры", [["subtitles", "size", "Размер текста", "n"], ["subtitles", "y", "Положение по вертикали, px", "n"], ["subtitles", "max_words", "Слов в блоке", "n"], ["subtitles", "max_chars", "Символов в блоке", "n"], ["subtitles", "outline", "Обводка", "n"]]],
    ["Хук", [["hook", "size", "Размер текста", "n"], ["hook", "y", "Положение (верх), px", "n"], ["hook", "show_seconds", "Секунд на экране", "n"], ["hook", "outline", "Обводка", "n"]]],
    ["Видео в кадре", [["window", "y", "Верх окна, px", "n"], ["window", "h", "Высота окна, px", "n"], ["window", "crop_y", "Сдвиг кадра по вертикали (вертикальные исходники), px", "n"]]],
    ["Цвета", [["colors", "accent", "Фирменный цвет", "c"], ["colors", "text", "Цвет текста", "c"], ["colors", "outline", "Цвет обводки", "c"]]],
    ["Шапка, призыв, полоса", [["brand", "text", "Текст шапки", "t"], ["brand", "size", "Размер шапки", "n"], ["cta", "enabled", "Показывать призыв", "b"], ["cta", "text", "Текст призыва", "t"], ["cta", "size", "Размер призыва", "n"], ["bar", "enabled", "Полоса прогресса", "b"]]],
    ["Логотип", [["logo", "enabled", "Показывать логотип", "b"], ["logo", "x", "X, px", "n"], ["logo", "y", "Y, px", "n"], ["logo", "w", "Ширина, px", "n"]]],
    ["Качество", [["quality", "crf", "CRF (меньше — лучше качество, больше файл)", "n"], ["quality", "preset", "Скорость кодирования", "s", ["ultrafast", "veryfast", "faster", "fast", "medium", "slow"]]]]
  ];
  async function settingsView() {
    var v = $("#vsview"); if (!v) return; v.innerHTML = '<div class="vs-wrap"><p class="vs-muted">Загрузка…</p></div>';
    try { S.st = await api("GET", "/settings"); S.tg = await api("GET", "/telegram"); S.logo = await api("GET", "/logo"); S.health = await api("GET", "/health"); } catch (e) { v.innerHTML = '<div class="vs-wrap"><p class="vs-err">' + esc(errText(e)) + "</p></div>"; return; }
    if (S.tab !== "settings") return; var st = S.st, tg = S.tg, t = st.template, hl = S.health, l = st.limits, u = st.usage || {};
    var field = function (f) { var sec = f[0], key = f[1], val = t[sec][key], id = "tp-" + sec + "-" + key; if (f[3] === "b") return '<label class="chk"><input type="checkbox" data-tp="' + sec + "." + key + '" id="' + id + '"' + (val ? " checked" : "") + "> " + esc(f[2]) + "</label>"; if (f[3] === "s") return '<label>' + esc(f[2]) + '<select data-tp="' + sec + "." + key + '" id="' + id + '">' + f[4].map(function (o) { return '<option value="' + o + '"' + (o === val ? " selected" : "") + ">" + o + "</option>"; }).join("") + "</select></label>"; return "<label>" + esc(f[2]) + '<input data-tp="' + sec + "." + key + '" data-k="' + f[3] + '" id="' + id + '" type="' + (f[3] === "c" ? "color" : f[3] === "n" ? "number" : "text") + '" value="' + esc(val) + '"></label>'; };
    var logoOpts = (S.logo.brand || []).map(function (f) { return '<option value="brand:' + esc(f) + '"' + (t.logo.source === "brand:" + f ? " selected" : "") + ">" + esc(f) + "</option>"; }).join("") + (S.logo.custom ? '<option value="custom"' + (t.logo.source === "custom" ? " selected" : "") + ">Загруженный логотип</option>" : "");
    if (t.logo.source && t.logo.source !== "custom" && (S.logo.brand || []).indexOf(String(t.logo.source).replace(/^brand:/, "")) < 0) logoOpts = '<option value="' + esc(t.logo.source) + '" selected>' + esc(String(t.logo.source).replace(/^brand:/, "")) + " (файла нет в проекте)</option>" + logoOpts;
    v.innerHTML = '<div class="vs-wrap"><div class="vs-grid" style="grid-template-columns:repeat(auto-fit,minmax(380px,1fr))">' +
      '<div class="vs-card"><h3>Telegram</h3><p class="vs-small vs-muted">Готовые ролики приходят в Telegram через бота проекта. Токен берётся из переменной окружения <b>TELEGRAM_BOT_TOKEN</b> и здесь не показывается: ' + (tg.configured ? '<span class="vs-ok">токен задан</span>' : '<span class="vs-err">токен НЕ задан</span>') + '.</p><label class="vs-small vs-muted">Chat ID (ваш Telegram ID)</label><input id="tg-chat" value="' + esc(tg.chat_id) + '" placeholder="' + esc(tg.default_chat || "123456789") + '"><label class="vs-small"><input type="checkbox" id="tg-auto"' + (tg.auto_send ? " checked" : "") + '> Отправлять автоматически после экспорта</label><label class="vs-small"><input type="checkbox" id="tg-link"' + (tg.link_fallback ? " checked" : "") + '> Если файл больше ' + tg.limit_mb + ' МБ — присылать ссылку</label>' +
      '<div class="vs-row" style="margin-top:8px"><button class="vs-primary" data-act="tg-save">Сохранить</button><button data-act="tg-check">Проверить подключение</button><button data-act="tg-test">Отправить тестовое сообщение</button></div><div id="tg-res" class="vs-small" style="margin-top:8px"></div>' +
      '<div class="vs-steps" style="margin-top:10px"><b>Первое подключение:</b><br>1. Нажмите «Проверить подключение» — появится ссылка на бота.<br>2. Откройте бота в Telegram и нажмите <b>Start</b> (бот не может написать первым).<br>3. Узнайте свой Chat ID у бота @userinfobot и вставьте выше.<br>4. Нажмите «Отправить тестовое сообщение».</div></div>' +
      '<div class="vs-card"><h3>Клипы</h3><div class="vs-form"><label>Минимум, с<input id="cl-min" type="number" value="' + st.clips.min_s + '"></label><label>Максимум, с<input id="cl-max" type="number" value="' + st.clips.max_s + '"></label><label>Не более клипов<input id="cl-n" type="number" value="' + st.clips.max_clips + '"></label><label>Модель Claude<select id="cl-model">' + Object.keys(st.prices.claude_per_mtok).map(function (m) { return '<option' + (m === st.clips.model ? " selected" : "") + ">" + esc(m) + "</option>"; }).join("") + '</select></label></div><div class="vs-row" style="margin-top:8px"><button class="vs-primary" data-act="cl-save">Сохранить</button></div><p class="vs-small vs-muted">Длительность выбирается здесь: система ищет моменты в этих пределах (лучшие — 20–30 с). Менять начало и конец каждого клипа можно в редакторе.</p></div>' +
      '<div class="vs-card" style="grid-column:1/-1"><h3>Оформление клипов</h3>' + TPL_FIELDS.map(function (g) { return '<h4 style="margin:12px 0 6px">' + esc(g[0]) + '</h4><div class="vs-form">' + g[1].map(field).join("") + (g[0] === "Логотип" ? '<label>Источник логотипа<select data-tp="logo.source" id="tp-logo-source">' + logoOpts + '</select></label><label>Загрузить свой логотип (PNG до 700 КБ)<input type="file" id="logo-file" accept="image/png"></label>' : "") + "</div>"; }).join("") + '<div class="vs-row" style="margin-top:12px"><button class="vs-primary" data-act="tpl-save">Сохранить оформление</button><button data-act="tpl-reset" class="vs-danger">Вернуть стандартное</button></div><p class="vs-small vs-muted">Изменения применяются к новым сборкам: у клипов, собранных раньше, появится пометка «устарел».</p></div>' +
      '<div class="vs-card"><h3>Лимиты и расход</h3><div class="vs-form"><label>В месяц, $<input id="lm-m" type="number" step="0.5" value="' + l.monthly_usd + '"></label><label>На задачу, $<input id="lm-j" type="number" step="0.1" value="' + l.per_job_usd + '"></label><label>Макс. файл, ГБ<input id="lm-g" type="number" step="0.5" value="' + l.max_upload_gb + '"></label><label>Макс. запись, мин<input id="lm-d" type="number" value="' + l.max_duration_min + '"></label></div><div class="vs-row" style="margin-top:8px"><button class="vs-primary" data-act="lm-save">Сохранить лимиты</button></div><p class="vs-small">Потрачено в этом месяце: <b>$' + Number(u.spent_usd || 0).toFixed(3) + "</b> · зарезервировано: $" + Number(u.reserved_usd || 0).toFixed(3) + '</p><p class="vs-small vs-muted">Цены поставщиков (Groq, Claude) заданы в настройках сервера; сверьте их с вашими консолями. Лимиты жёсткие: превышение отклоняется до траты.</p></div>' +
      '<div class="vs-card"><h3>Словарь терминов</h3><p class="vs-small vs-muted">По строке: «термин | приоритет 1–5 | варианты через запятую». Из него строится подсказка распознаванию речи и исправления в субтитрах.</p><textarea id="voc" rows="7">' + esc((st.vocabulary.terms || []).map(function (x) { return x.term + " | " + x.p + " | " + (x.aliases || []).join(", "); }).join("\n")) + '</textarea><div class="vs-row" style="margin-top:8px"><button class="vs-primary" data-act="voc-save">Сохранить словарь</button></div></div>' +
      '<div class="vs-card"><h3>Диагностика</h3><div class="vs-small">' + [["FFmpeg", hl.ffmpeg.ok ? '<span class="vs-ok">найден</span> ' + esc(hl.ffmpeg.version || "") : '<span class="vs-err">НЕ найден — задайте FFMPEG_PATH или установите ffmpeg-static</span>'], ["Субтитры (libass)", hl.ffmpeg.ass ? '<span class="vs-ok">есть</span>' : '<span class="vs-err">нет — нужна полная сборка FFmpeg</span>'], ["Нормализация звука", hl.ffmpeg.loudnorm ? '<span class="vs-ok">есть</span>' : '<span class="vs-err">нет</span>'], ["Ключ Groq", hl.keys.groq ? '<span class="vs-ok">задан</span>' : '<span class="vs-err">не задан (GROQ_API_KEY)</span>'], ["Ключ Claude", hl.keys.claude ? '<span class="vs-ok">задан</span>' : '<span class="vs-err">не задан</span>'], ["Telegram-бот", hl.keys.telegram ? '<span class="vs-ok">токен задан</span>' : '<span class="vs-err">не задан</span>'], ["Исполнитель очереди", hl.runner ? (hl.runner.last_error ? '<span class="vs-err">ошибка: ' + esc(hl.runner.last_error) + "</span>" : '<span class="vs-ok">работает</span>') : "отключён в этом экземпляре"], ["Заданий в очереди", hl.queued_jobs], ["Разрешённые адреса загрузки", esc((hl.origins || []).join(", ") || "—")]].map(function (r) { return "<div>" + r[0] + ": " + r[1] + "</div>"; }).join("") + '</div><div class="vs-row" style="margin-top:8px"><button data-act="cors">Настроить CORS хранилища</button></div><div id="cors-res" class="vs-small" style="margin-top:6px"></div></div></div></div>';
  }

  /* ---------- обработчики ---------- */
  function onInput(ev) {
    var t = ev.target; if (!S.cv || S.tab !== "projects") return;
    if (t.id === "f-hook") queue({ op: "set_hook", text: t.value }); else if (t.id === "f-hsize") queue({ op: "set_hook", size: t.value === "" ? null : Number(t.value) }); else if (t.id === "f-hy") queue({ op: "set_hook", y: t.value === "" ? null : Number(t.value) });
    else if (t.id === "f-cta") queue({ op: "set_cta", text: t.value.trim() === "" ? null : t.value });
    else if (t.id === "fr-z" || t.id === "fr-x" || t.id === "fr-y") { var k = { "fr-z": "zoom", "fr-x": "pan_x", "fr-y": "pan_y" }[t.id], val = Number(t.value), o = { op: "set_framing" }; o[k] = val; $("#" + t.id.replace("fr-", "fr-") + "v") && ($("#" + t.id + "v").textContent = k === "zoom" ? val.toFixed(2) + "×" : val); queue(o); }
    else if (t.dataset && t.dataset.f === "text") { var id = t.closest(".vs-w").dataset.wid; if (t.value.trim() && !/\s/.test(t.value.trim())) queue({ op: "set_text", id: id, text: t.value }); }
    else if (t.id === "tl-s" || t.id === "tl-e") { var n = Number(t.value); if (isFinite(n)) setTl(t.id === "tl-s" ? "s" : "e", n); }
  }
  function onChange(ev) {
    var t = ev.target;
    if (t.id === "logo-file" && t.files[0]) return uploadLogo(t.files[0]);
    if (!S.cv || S.tab !== "projects") return;
    if (t.id === "f-hon") queue({ op: "set_hook", enabled: t.checked }, true); else if (t.id === "f-cton") queue({ op: "set_cta", enabled: t.checked }, true);
    else if (t.dataset && (t.dataset.f === "start" || t.dataset.f === "end")) { var row = t.closest(".vs-w"), id = row.dataset.wid; queue({ op: "set_time", id: id, start: Number($('[data-f="start"]', row).value), end: Number($('[data-f="end"]', row).value) }, true); }
    else if (t.dataset && t.dataset.f === "text") { var tv = t.value.trim(); if (tv && /\s/.test(tv)) { toast("Для нескольких слов используйте поле «Субтитры» выше", true); renderRight(); } }
  }
  function uploadLogo(f) { if (f.size > 700000) return toast("Логотип должен быть не больше 700 КБ", true); var r = new FileReader(); r.onload = async function () { try { await api("POST", "/logo", { png_base64: String(r.result).split(",")[1] }); await api("PUT", "/settings", { template: { logo: { source: "custom" } } }); toast("Логотип загружен"); S.logo = null; settingsView(); } catch (e) { toast(errText(e), true); } }; r.readAsDataURL(f); }
  async function saveSettings(body, ok) { try { await api("PUT", "/settings", body); toast(ok || "Сохранено"); S.st = await api("GET", "/settings"); S.me = await api("GET", "/me"); } catch (e) { toast((e.field ? e.field + ": " : "") + errText(e), true); } }
  async function onClick(ev) {
    if (ev.target.id === "vsbell") return; var tb = ev.target.closest("[data-tab]"); if (tb) { S.tab = tb.dataset.tab; return renderView(); }
    var a = ev.target.closest("[data-act]"); if (!a) return; var act = a.dataset.act, id = a.dataset.id; if (a.tagName === "A") ev.preventDefault();
    try {
      if (act === "pick") $("#vsfile").click(); else if (act === "open-project") await openProject(id); else if (act === "open-clip") await openClip(id); else if (act === "cancel-upload") await cancelUpload(); else if (act === "analyze") await analyze();
      else if (act === "del-project") { if (confirm("Удалить проект, все его клипы и файлы?")) { await api("DELETE", "/projects/" + S.pid); S.pid = S.cid = null; S.project = S.cv = null; S.clips = []; await loadProjects(); renderView(); toast("Проект удалён"); } }
      else if (act === "cancel-job") { await api("POST", "/jobs/" + id + "/cancel"); S.jobs = (await api("GET", "/jobs")).jobs; await refreshProject(); renderTop(); if (S.tab === "queue") queueView(); }
      else if (act === "retry-job") { await api("POST", "/jobs/" + id + "/retry"); toast("Задание поставлено в очередь снова"); S.jobs = (await api("GET", "/jobs")).jobs; renderTop(); queueView(); }
      else if (act === "play") { var vd = $("#vsvid"); if (vd) { if (vd.paused) vd.play(); else vd.pause(); } } else if (act === "replay") { seekOut(0); var v2 = $("#vsvid"); if (v2) v2.play(); }
      else if (act === "tl") { var d = a.dataset.d; setTl(d[0], (d[0] === "s" ? S.tl.s : S.tl.e) + (d[1] === "+" ? 0.1 : -0.1)); } else if (act === "range-apply") await applyRange(); else if (act === "win-extend") await extendWindow();
      else if (act === "h-download") await downloadClip(id); else if (act === "h-tg") { await sendTg(id, true, false); historyView(); } else if (act === "h-open") { await openProject(a.dataset.pid); await openClip(id); }
      else if (act.indexOf("tg-") === 0 && act !== "tg-send") await tgSettings(act); else if (["cl-save", "lm-save", "voc-save", "tpl-save", "tpl-reset", "cors"].indexOf(act) >= 0) await settingsAct(act);
      else if (act === "tg-send") await sendTg(S.cid, !!(a.dataset.force || (S.cv.clip.telegram && ["sent", "sent_link"].indexOf(S.cv.clip.telegram.status) >= 0)), !!a.dataset.reupload);
      else if (act === "download") await downloadClip(S.cid);
      else if (["del", "restore", "emph", "brk", "join", "confirm", "suggest", "add", "rewrite", "hook-reset", "hooks", "fr-reset", "preview", "render", "exclude", "up", "down"].indexOf(act) >= 0) await editAction(act, id, a);
    } catch (e) { toast(errText(e), true); }
  }
  async function downloadClip(id) { var d = await api("GET", "/clips/" + id + "/media?kind=export"); window.location.href = d.url; }
  async function sendTg(id, force, reupload) { var r = await api("POST", "/clips/" + id + "/telegram", { force: !!force, reupload: !!reupload }); if (r.already_sent) return toast("Это видео уже доставлено в Telegram. Для повторной отправки нажмите кнопку ещё раз."); toast("Отправка в Telegram поставлена в очередь"); S.jobs = (await api("GET", "/jobs")).jobs; renderTop(); if (S.tab === "projects") { await reloadClipMeta(); renderRight(); } }
  async function tgSettings(act) {
    var res = $("#tg-res"), chat = $("#tg-chat").value.trim(); res.textContent = "…";
    if (act === "tg-save") { try { await api("PUT", "/telegram", { chat_id: chat, auto_send: $("#tg-auto").checked, link_fallback: $("#tg-link").checked }); res.innerHTML = '<span class="vs-ok">Сохранено</span>'; } catch (e) { res.innerHTML = '<span class="vs-err">' + esc(errText(e)) + "</span>"; } return; }
    if (act === "tg-check") { var r = await api("POST", "/telegram/check", { chat_id: chat || undefined }); res.innerHTML = r.ok ? "Бот: <b>@" + esc(r.bot.username) + "</b> · " + (r.chat_ok ? '<span class="vs-ok">чат доступен, можно отправлять</span>' : '<span class="vs-err">' + esc(r.chat_error) + "</span>") + (r.link ? '<br><a href="' + esc(r.link) + '" target="_blank" rel="noopener">Открыть бота и нажать Start</a>' : "") : '<span class="vs-err">' + esc(r.error) + "</span>"; return; }
    if (act === "tg-test") { try { var t = await api("POST", "/telegram/test", { chat_id: chat || undefined }); res.innerHTML = '<span class="vs-ok">Тестовое сообщение доставлено (#' + t.message_id + ")</span>"; } catch (e) { res.innerHTML = '<span class="vs-err">' + esc(errText(e)) + "</span>"; } }
  }
  async function settingsAct(act) {
    if (act === "cl-save") await saveSettings({ clips: { min_s: Number($("#cl-min").value), max_s: Number($("#cl-max").value), max_clips: Number($("#cl-n").value), model: $("#cl-model").value } });
    else if (act === "lm-save") await saveSettings({ limits: { monthly_usd: Number($("#lm-m").value), per_job_usd: Number($("#lm-j").value), max_upload_gb: Number($("#lm-g").value), max_duration_min: Number($("#lm-d").value) } });
    else if (act === "voc-save") await saveSettings({ vocabulary: { terms: $("#voc").value.split("\n").map(function (l) { var p = l.split("|").map(function (x) { return x.trim(); }); return p[0] ? { term: p[0], p: parseInt(p[1], 10) || 3, aliases: (p[2] || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean) } : null; }).filter(Boolean) } });
    else if (act === "tpl-save") { var patch = {}; $$("[data-tp]").forEach(function (el) { if (el.type !== "checkbox" && el.value === "") return; var p = el.dataset.tp.split("."), val = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value; (patch[p[0]] = patch[p[0]] || {})[p[1]] = val; }); await saveSettings({ template: patch }, "Оформление сохранено"); }
    else if (act === "tpl-reset") { if (!confirm("Вернуть стандартное оформление Hidden Dinox?")) return; await api("POST", "/settings/template/reset"); toast("Стандартное оформление возвращено"); settingsView(); }
    else if (act === "cors") { var r = await api("POST", "/storage/cors"); $("#cors-res").innerHTML = r.ok ? '<span class="vs-ok">CORS настроен для: ' + esc(r.origins.join(", ")) + "</span>" : '<span class="vs-err">Не удалось: ' + esc(r.error) + "</span><br>Вручную: <code>" + esc(r.manual) + "</code>"; }
  }
  async function editAction(act, id, a) {
    if (!S.cv && ["up", "down"].indexOf(act) < 0) return;
    if (act === "del") queue({ op: "delete", id: id }, true); else if (act === "restore") queue({ op: "restore", id: id }, true);
    else if (act === "emph") queue({ op: "set_emphasis", id: id, on: S.cv.edits.emphasis.indexOf(id) < 0 }, true); else if (act === "brk") queue({ op: "set_break", id: id, on: a.dataset.on === "1" }, true); else if (act === "join") queue({ op: "set_join", id: id, on: a.dataset.on === "1" }, true);
    else if (act === "confirm") queue({ op: "confirm_sync", id: id }, true); else if (act === "suggest") queue({ op: "set_text", id: id, text: a.dataset.to }, true); else if (act === "hook-reset") queue({ op: "reset_hook" }, true); else if (act === "fr-reset") { STAGE_OPS = true; queue({ op: "reset_framing" }, true); }
    else if (act === "add") { var txt = prompt("Какое слово добавить после этого?"); if (txt && txt.trim()) queue({ op: "add_after", after_id: id, text: txt.trim() }, true); }
    else if (act === "rewrite") { var ws = visWords(), t2 = $("#f-full").value.trim(); if (!t2) return toast("Текст пуст", true); queue({ op: "rewrite_range", from_id: ws[0].id, to_id: ws[ws.length - 1].id, text: t2 }, true); }
    else if (act === "hooks") { toast("Спрашиваю ИИ…"); var r = await api("POST", "/clips/" + S.cid + "/hooks"); if (!r.hooks.length) return toast(r.note || "ИИ не предложил подходящих хуков", true); var m = document.createElement("div"); m.className = "vs-modal"; m.innerHTML = '<div><h3 style="color:#A6F32B">Варианты хука</h3><p class="vs-small vs-muted">Каждый вариант проверен: основан на словах клипа, без обещаний. Расход ≈ $' + r.cost_usd + '.</p>' + r.hooks.map(function (h, i) { return '<p><button data-pick="' + i + '" style="width:100%;text-align:left">' + esc(h) + "</button></p>"; }).join("") + '<button id="hk-no">Закрыть</button></div>'; document.body.appendChild(m); $("#hk-no").onclick = function () { m.remove(); }; $$("[data-pick]", m).forEach(function (b) { b.onclick = function () { queue({ op: "set_hook", text: r.hooks[+b.dataset.pick] }, true); var f = $("#f-hook"); if (f) f.value = r.hooks[+b.dataset.pick]; m.remove(); }; }); }
    else if (act === "preview" || act === "render") { await flush(); var r2 = await api("POST", "/clips/" + S.cid + "/" + act); toast(r2.cached && !r2.in_progress ? "Без изменений — готовая версия актуальна" : act === "render" ? "Сборка видео запущена" : "Предпросмотр собирается"); S.jobs = (await api("GET", "/jobs")).jobs; await refreshProject(); renderTop(); }
    else if (act === "exclude") { await api("POST", "/clips/" + S.cid + "/state", { excluded: S.cv.clip.status !== "excluded" }); await refreshProject(); renderRight(); }
    else if (act === "up" || act === "down") { var ids = S.clips.map(function (c) { return c.id; }), i = ids.indexOf(id), j = i + (act === "up" ? -1 : 1); if (j >= 0 && j < ids.length) { ids.splice(j, 0, ids.splice(i, 1)[0]); await api("POST", "/projects/" + S.pid + "/clips/order", { ids: ids }); S.clips = (await api("GET", "/projects/" + S.pid + "/clips")).clips; renderLeft(); loadThumbs(); } }
  }
  boot();
})();
