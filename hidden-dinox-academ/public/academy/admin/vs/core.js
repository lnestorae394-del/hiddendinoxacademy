/* HIDDEN DINOX VIDEO STUDIO 2.0 — ядро интерфейса: утилиты, API-клиент с единой обработкой ошибок, события, уведомления, диалоги, секции с собственными состояниями. */
(function () {
  "use strict";
  var VS = window.VS = { views: {}, State: { me: null, general: { studio_name: "Hidden Dinox Video Studio", density: "comfortable", start_view: "dashboard" }, health: null, jobs: [], notes: [], jsErrors: 0, lastJsError: null }, version: "2.0", API: "/api/video-studio" };
  var $ = VS.$ = function (s, r) { return (r || document).querySelector(s); }, $$ = VS.$$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = VS.esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  VS.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  VS.fmt = function (t) { t = Math.max(0, t || 0); return Math.floor(t / 60) + ":" + ("0" + Math.floor(t % 60)).slice(-2); };
  VS.dur = function (t) { if (t == null) return "—"; t = Math.round(t); var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return h ? h + ":" + ("0" + m).slice(-2) + ":" + ("0" + s).slice(-2) : m + ":" + ("0" + s).slice(-2); };
  VS.bytes = function (n) { n = Number(n) || 0; return n >= 1e9 ? (n / 1e9).toFixed(2) + " ГБ" : n >= 1e6 ? (n / 1e6).toFixed(1) + " МБ" : n >= 1e3 ? Math.round(n / 1e3) + " КБ" : n + " Б"; };
  VS.dt = function (ts) { return ts ? new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"; };
  VS.ago = function (ts) { if (!ts) return "—"; var s = Math.round((Date.now() - ts) / 1000); if (s < 45) return "только что"; if (s < 3600) return Math.round(s / 60) + " мин назад"; if (s < 86400) return Math.round(s / 3600) + " ч назад"; if (s < 172800) return "вчера"; return VS.dt(ts); };
  var ICONS = { dashboard: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z", projects: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", uploads: "M12 16V4m0 0L7 9m5-5 5 5M4 20h16", queue: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", templates: "M3 3h18v6H3zM3 13h8v8H3zM15 13h6v8h-6z", media: "M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M9 9h.01", history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2", analytics: "M4 20V10M10 20V4M16 20v-7M22 20H2", settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z", bell: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0", check: "M20 6 9 17l-5-5", alert: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z", play: "M6 4l14 8-14 8z", trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14", download: "M12 4v12m0 0 5-5m-5 5-5-5M4 20h16", refresh: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5", search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3", grid: "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z", list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", x: "M18 6 6 18M6 6l12 12", plus: "M12 5v14M5 12h14", send: "M22 2 11 13M22 2l-7 20-4-9-9-4z", film: "M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4", menu: "M3 6h18M3 12h18M3 18h18", back: "M15 18l-6-6 6-6", db: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6", cpu: "M6 6h12v12H6zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4", shield: "M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z", user: "M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", cloud: "M17 18a4 4 0 0 0 0-8 6 6 0 0 0-11.7 1.5A3.5 3.5 0 0 0 6 18z", palette: "M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2s-.5-2 1-2H17a4 4 0 0 0 4-4c0-5-4-10-9-10z", sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6", terminal: "M4 17l6-6-6-6M12 19h8", info: "M12 16v-4m0-4h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z", copy: "M9 9h11v11H9zM5 15V5h10" };
  VS.icon = function (n, s) { return '<svg class="vs-i" width="' + (s || 18) + '" height="' + (s || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (ICONS[n] || ICONS.info) + '"/></svg>'; };
  var L = {}; VS.on = function (e, f) { (L[e] = L[e] || []).push(f); return function () { L[e] = (L[e] || []).filter(function (x) { return x !== f; }); }; };
  VS.emit = function (e, d) { (L[e] || []).slice().forEach(function (f) { try { f(d); } catch (x) { console.error(x); } }); };
  /* ---------- ошибки и API-клиент ---------- */
  var ERR = { UNAUTHENTICATED: "Сессия истекла — войдите в админ-панель заново", FORBIDDEN: "Video Studio доступна только администраторам", ACCOUNT_BLOCKED: "Аккаунт заблокирован", NETWORK: "Нет связи с сервером. Проверьте интернет и повторите.", FILE_TOO_LARGE: "Файл больше допустимого", BAD_FORMAT: "Поддерживаются только MP4 и MOV", TOO_LONG: "Видео длиннее допустимого", REV_CONFLICT: "Клип изменён в другом окне — данные обновлены", ALREADY_RUNNING: "Анализ уже выполняется", DUPLICATE: "Этот файл уже загружен", ORIGIN_NOT_ALLOWED: "Загрузка запрещена с этого адреса (проверьте VIDEO_STUDIO_ORIGIN)", OUT_OF_WINDOW: "Диапазон выходит за пределы окна предпросмотра", TOO_MANY: "Слишком много запросов — подождите минуту" };
  function ApiError(status, code, message, extra) { var e = new Error(message); e.name = "ApiError"; e.status = status; e.code = code; e.error = code; if (extra) Object.keys(extra).forEach(function (k) { if (k !== "status" && k !== "message" && k !== "error") e[k] = extra[k]; }); return e; }
  VS.ApiError = ApiError;
  VS.errText = function (e) { return (e && e.name === "AbortError") ? "Отменено" : (e && e.message && e.message !== "Failed to fetch" ? e.message : (e && ERR[e.error]) || "Не удалось выполнить действие"); };
  VS.auth = { fb: null, token: function () { var u = VS.auth.fb && VS.auth.fb.auth.currentUser; if (!u) return Promise.reject(new Error("no user")); return u.getIdToken(); } };
  VS.api = async function (method, path, body, opt) {
    var token; try { token = await VS.auth.token(); } catch (e) { throw ApiError(401, "UNAUTHENTICATED", ERR.UNAUTHENTICATED); }
    var res; try { res = await fetch(VS.API + path, { method: method, headers: Object.assign({ Authorization: "Bearer " + token }, body !== undefined ? { "Content-Type": "application/json" } : {}), body: body !== undefined ? JSON.stringify(body) : undefined, signal: opt && opt.signal }); }
    catch (e) { if (e && e.name === "AbortError") throw e; throw ApiError(0, "NETWORK", ERR.NETWORK); }
    var j = {}; try { j = await res.json(); } catch (e) { /* ответ не JSON */ }
    if (!res.ok) { if (res.status === 401) VS.emit("auth:expired"); throw ApiError(res.status, j.error || "HTTP_" + res.status, j.message || ERR[j.error] || "Ошибка сервера (HTTP " + res.status + ")", j); }
    return j;
  };
  /* ---------- уведомления и всплывающие сообщения ---------- */
  VS.toast = function (text, kind) { var box = $("#vs-toasts"); if (!box) { box = document.createElement("div"); box.id = "vs-toasts"; document.body.appendChild(box); } var t = document.createElement("div"); t.className = "vs-toast " + (kind || "info"); t.setAttribute("role", "status"); t.textContent = text; box.appendChild(t); setTimeout(function () { t.classList.add("out"); setTimeout(function () { t.remove(); }, 300); }, kind === "bad" ? 7000 : 4500); };
  var NKEY = "hdvs_notes_v2"; try { VS.State.notes = JSON.parse(localStorage.getItem(NKEY) || "[]").slice(0, 50); } catch (e) { VS.State.notes = []; }
  VS.unread = 0;
  VS.notify = function (text, kind, link) { VS.State.notes.unshift({ t: Date.now(), text: text, kind: kind || "info", link: link || null }); VS.State.notes = VS.State.notes.slice(0, 50); VS.unread++; try { localStorage.setItem(NKEY, JSON.stringify(VS.State.notes)); } catch (e) { /* хранилище браузера недоступно */ } VS.toast(text, kind); VS.emit("notes"); };
  /* ---------- диалоги ---------- */
  VS.modal = function (o) {
    var ov = document.createElement("div"); ov.className = "vs-modal"; ov.innerHTML = '<div class="vs-dialog' + (o.wide ? " wide" : "") + '" role="dialog" aria-modal="true"><div class="vs-dialog-h"><h3>' + esc(o.title || "") + '</h3><button class="vs-x" aria-label="Закрыть">' + VS.icon("x") + '</button></div><div class="vs-dialog-b">' + (o.html || "") + '</div><div class="vs-dialog-f"></div></div>';
    document.body.appendChild(ov); var done = false, api = { el: ov, body: $(".vs-dialog-b", ov), close: function (v) { if (done) return; done = true; document.removeEventListener("keydown", onKey); ov.remove(); if (o.onClose) o.onClose(v); } };
    function onKey(e) { if (e.key === "Escape") api.close(false); } document.addEventListener("keydown", onKey);
    $(".vs-x", ov).onclick = function () { api.close(false); }; ov.addEventListener("mousedown", function (e) { if (e.target === ov && !o.persistent) api.close(false); });
    (o.actions || []).forEach(function (a) { var b = document.createElement("button"); b.className = "vs-btn" + (a.primary ? " primary" : "") + (a.danger ? " danger" : ""); b.textContent = a.label; b.onclick = function () { a.onClick ? a.onClick(api) : api.close(true); }; $(".vs-dialog-f", ov).appendChild(b); });
    var f = $("button.primary,input,textarea", ov); if (f) setTimeout(function () { f.focus(); }, 30); return api;
  };
  VS.confirm = function (title, text, o) { o = o || {}; return new Promise(function (res) { VS.modal({ title: title, html: '<p>' + esc(text) + '</p>' + (o.extra || ""), onClose: function (v) { res(v === true); }, actions: [{ label: "Отмена", onClick: function (m) { m.close(false); } }, { label: o.okLabel || "Подтвердить", primary: !o.danger, danger: !!o.danger, onClick: function (m) { m.close(true); } }] }); }); };
  /* ---------- секция: собственные состояния загрузки / ошибки / повтора (сбой одного запроса не ломает страницу) ---------- */
  VS.section = function (el, o) {
    var token = 0;
    function reload(silent) {
      var my = ++token; if (!silent) el.innerHTML = '<div class="vs-skel"><i></i><i></i><i style="width:60%"></i></div>';
      return Promise.resolve().then(o.load).then(function (data) { if (my !== token || !el.isConnected) return; o.render(data, el); if (o.after) o.after(data, el); }).catch(function (e) {
        if (my !== token || !el.isConnected) return; if (e && e.name === "AbortError") return;
        el.innerHTML = '<div class="vs-errbox"><div class="vs-errbox-h">' + VS.icon("alert") + '<b>' + esc(o.title ? o.title + ": не удалось загрузить" : "Не удалось загрузить") + '</b></div><p>' + esc(VS.errText(e)) + '</p>' + (e && e.status ? '<p class="vs-muted vs-small">HTTP ' + e.status + (e.code ? " · " + esc(e.code) : "") + '</p>' : "") + '<button class="vs-btn" data-retry>' + VS.icon("refresh", 15) + ' Повторить</button></div>';
        var b = $("[data-retry]", el); if (b) b.onclick = function () { reload(); };
      });
    }
    reload(); return { reload: reload };
  };
  VS.badge = function (text, kind) { return '<span class="vs-badge ' + (kind || "") + '">' + esc(text) + "</span>"; };
  VS.tgBadge = function (t) {
    var L = { sent: "Доставлено в Telegram", sent_link: "Отправлена ссылка (файл слишком большой)", queued: "В очереди на отправку", sending: "Отправка…", retrying: "Повтор отправки…", failed: "Не доставлено", cancelled: "Отправка отменена" };
    if (!t) return '<span class="vs-badge">Не отправлялось</span>'; var k = t.status === "sent" ? "ok" : t.status === "failed" ? "bad" : "warn";
    return '<span class="vs-badge ' + k + '">' + esc(L[t.status] || t.status) + (t.status === "sent" && t.message_id ? " · #" + t.message_id : "") + "</span>" + (t.error && t.status === "failed" ? '<div class="vs-err vs-small">' + esc(t.error.message) + "</div>" : "");
  };
  VS.statusLabels = { project: { uploading: "Загрузка", validating: "Проверка видео", ready: "Готово к анализу", analyzing: "Анализ", analyzed: "Клипы найдены", error: "Ошибка" }, clip: { found: "Найден", edited: "Отредактирован", rendering: "Рендерится", done: "Готов", error: "Ошибка", excluded: "Исключён" }, job: { queued: "В очереди", claimed: "Запуск", running: "Выполняется", succeeded: "Готово", failed: "Ошибка", cancelled: "Отменено" }, jobType: { probe: "Проверка видео", analyze: "Анализ LIVE", window: "Окно предпросмотра", preview: "Точный предпросмотр", render: "Сборка видео", telegram: "Отправка в Telegram" }, stage: { start: "запуск", prepare: "подготовка источника", download: "загрузка файла", probe: "проверка", audio: "подготовка звука", stt: "распознавание речи", claude: "поиск моментов", clips: "нарезка клипов", render: "монтаж", upload: "сохранение" } };
  VS.projectBadge = function (s) { return VS.badge(VS.statusLabels.project[s] || s, s === "error" ? "bad" : s === "analyzed" ? "ok" : /ing$/.test(s) ? "warn" : ""); };
  VS.isActive = function (j) { return ["queued", "claimed", "running"].indexOf(j.status) >= 0; };
  /* ошибки JavaScript считаются для раздела «Диагностика» (frontend health) */
  window.addEventListener("error", function (e) { VS.State.jsErrors++; VS.State.lastJsError = String(e.message || "").slice(0, 160); });
  window.addEventListener("unhandledrejection", function (e) { VS.State.jsErrors++; VS.State.lastJsError = String((e.reason && e.reason.message) || e.reason || "").slice(0, 160); });
})();
