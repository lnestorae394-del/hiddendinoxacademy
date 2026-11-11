/* Сервис загрузки и раздел «Загрузки» (Upload Center): очередь файлов, S3 Multipart прямо в хранилище (части по 16 МиБ, 3 параллельно),
   повтор частей, продолжение с места остановки (в том числе после перезагрузки страницы), отмена. Резерв: возобновляемая сессия Google (если выбран Firebase Storage). */
(function () {
  "use strict";
  var VS = window.VS, $ = VS.$, esc = VS.esc, S = VS.State, U = VS.uploads = { items: [], running: false }, seq = 0, PART_CONC = 3, PART_TRIES = 6;
  var emitT = 0; function changed() { var t = Date.now(); if (t - emitT > 200) { emitT = t; VS.emit("uploads"); } else { clearTimeout(U._t); U._t = setTimeout(function () { emitT = Date.now(); VS.emit("uploads"); }, 220); } }
  var lsKey = function (fp) { return "hdvs_up_" + fp; };
  function durationOf(file) { return new Promise(function (res) { var v = document.createElement("video"), u = URL.createObjectURL(file); v.preload = "metadata"; v.onloadedmetadata = function () { res(isFinite(v.duration) ? v.duration : null); URL.revokeObjectURL(u); }; v.onerror = function () { res(null); URL.revokeObjectURL(u); }; v.src = u; }); }
  U.add = function (files) {
    var lim = S.me.limits, added = 0;
    Array.prototype.forEach.call(files, function (file) {
      var fp = [file.name, file.size, file.lastModified].join(":").replace(/[^A-Za-z0-9:_.\-]/g, "_").slice(0, 190);
      if (!/\.(mp4|mov)$/i.test(file.name)) return VS.toast("«" + file.name + "»: поддерживаются только MP4 и MOV", "bad");
      if (file.size > lim.max_upload_gb * 1073741824) return VS.toast("«" + file.name + "»: больше допустимых " + lim.max_upload_gb + " ГБ", "bad");
      if (file.size <= 0) return VS.toast("«" + file.name + "»: файл пустой", "bad");
      if (U.items.some(function (i) { return i.fp === fp && ["queued", "uploading", "completing"].indexOf(i.state) >= 0; })) return VS.toast("«" + file.name + "» уже в очереди загрузки", "bad");
      var it = { id: ++seq, file: file, fp: fp, state: "queued", sent: 0, total: file.size, speed: 0, text: "В очереди", error: null, cancelled: false, xhrs: new Set(), partProgress: {}, done: new Map(), urls: new Map(), abort: new AbortController(), project: null, duration: null };
      U.items.push(it); added++; durationOf(file).then(function (d) { it.duration = d; changed(); });
    });
    if (added) { changed(); U.pump(); } return added;
  };
  U.pump = function () { if (U.running) return; var it = U.items.find(function (i) { return i.state === "queued"; }); if (!it) return; U.running = true; run(it).then(function () { U.running = false; changed(); U.pump(); }); };
  U.cancel = async function (id) { var u = U.items.find(function (i) { return i.id === id; }); if (!u) return; u.cancelled = true; if (u.abort) u.abort.abort(); u.xhrs.forEach(function (x) { try { x.abort(); } catch (e) { /* уже завершён */ } });
    if (u.state === "queued") { u.state = "cancelled"; u.text = "Отменено"; return changed(); }
    if (u.mode !== "multipart" && u.url) { try { await fetch(u.url, { method: "DELETE" }); } catch (e) { /* сессия истечёт сама */ } }
    if (u.project) { try { await VS.api("POST", "/projects/" + u.project.id + "/upload/cancel"); } catch (e) { /* уже отменён */ } } try { localStorage.removeItem(lsKey(u.fp)); } catch (e) { /* нет доступа */ } u.state = "cancelled"; u.text = "Отменено, начатые части удалены из хранилища"; changed(); };
  U.retry = function (id) { var u = U.items.find(function (i) { return i.id === id; }); if (!u) return; Object.assign(u, { state: "queued", error: null, cancelled: false, abort: new AbortController(), partProgress: {}, text: "В очереди" }); changed(); U.pump(); };
  U.remove = function (id) { U.items = U.items.filter(function (i) { return i.id !== id || ["uploading", "completing"].indexOf(i.state) >= 0; }); changed(); };
  U.active = function () { return U.items.filter(function (i) { return ["queued", "uploading", "completing"].indexOf(i.state) >= 0; }); };
  window.addEventListener("beforeunload", function (e) { if (U.items.some(function (i) { return i.state === "uploading"; })) { e.preventDefault(); e.returnValue = ""; } });
  function update(u) { var s = 0; u.done.forEach(function (v) { s += v.size; }); Object.keys(u.partProgress).forEach(function (k) { s += u.partProgress[k]; }); u.sent = Math.min(s, u.total); var sec = (Date.now() - (u.t1 || Date.now())) / 1000; u.speed = sec > 1 ? Math.max(0, u.sent - (u.base || 0)) / sec : u.speed; changed(); }
  var partSize = function (u, n) { return n < u.totalParts ? u.partSize : u.total - (u.totalParts - 1) * u.partSize; };
  async function run(u) {
    u.state = "uploading"; u.text = "Подготовка…"; u.error = null; u.t1 = Date.now(); changed(); var file = u.file, r = null, saved = null;
    try {
      if (S.me.upload_mode !== "multipart") { try { saved = JSON.parse(localStorage.getItem(lsKey(u.fp)) || "null"); } catch (e) { saved = null; } }
      if (saved && saved.expires_at > Date.now() && saved.size === file.size) { u.mode = "resumable"; u.url = saved.url; u.chunk = saved.chunk; u.project = { id: saved.project_id }; u.resume = true; }
      else {
        try { r = await VS.api("POST", "/projects", { filename: file.name, size: file.size, content_type: file.type || undefined, fingerprint: u.fp }); }
        catch (e) {
          if (e.error === "DUPLICATE" && e.resumable) { u.status = await VS.api("GET", "/projects/" + e.project_id + "/upload/status"); u.project = { id: e.project_id }; u.mode = "multipart"; u.text = "Продолжаю с места остановки…"; }
          else if (e.error === "DUPLICATE") { u.project = { id: e.project_id }; u.state = "done"; u.text = "Этот файл уже загружен"; return; } else throw e;
        }
        if (r) { u.project = r.project; u.mode = r.upload.mode; if (u.mode === "multipart") { u.status = { part_size: r.upload.part_size, total_parts: r.upload.total_parts, parts: [] }; r.upload.urls.forEach(function (z) { u.urls.set(z.part_number, z.url); }); } else { u.url = r.upload.url; u.chunk = r.upload.chunk_bytes; try { localStorage.setItem(lsKey(u.fp), JSON.stringify({ project_id: r.project.id, url: r.upload.url, chunk: r.upload.chunk_bytes, size: file.size, expires_at: r.upload.expires_at })); } catch (e) { /* нет доступа */ } } }
      }
      if (u.mode === "multipart") await multipart(u); else { if (u.resume) { try { u.sent = await queryOffset(u); } catch (e) { u.sent = 0; } } await chunks(u); u.state = "completing"; u.text = "Проверка файла"; changed(); await VS.api("POST", "/projects/" + u.project.id + "/upload/complete"); }
      try { localStorage.removeItem(lsKey(u.fp)); } catch (e) { /* нет доступа */ } u.sent = u.total; u.state = "done"; u.text = "Загружено, идёт проверка видео"; VS.notify("Файл «" + file.name + "» загружен, идёт проверка", "ok", "#/projects/" + u.project.id); VS.pollNow();
    } catch (e) {
      if ((e && e.name === "AbortError") || u.cancelled) { if (u.state !== "cancelled") { u.state = "cancelled"; u.text = "Отменено"; } return; }
      u.state = "error"; u.error = (u.corsHint || (e && e.net)) ? "Не удалось отправить файл в хранилище. Чаще всего не настроен CORS бакета: Настройки → Хранилище → «Настроить CORS». Затем нажмите «Повторить» — загрузка продолжится с места остановки." : VS.errText(e) + " — нажмите «Повторить», загрузка продолжится с места остановки."; u.text = "Ошибка"; VS.notify("Загрузка «" + file.name + "» прервана: " + VS.errText(e), "bad", "#/uploads");
    }
  }
  async function multipart(u) {
    for (var round = 0; round < 3; round++) {
      var st = round === 0 && u.status ? u.status : await VS.api("GET", "/projects/" + u.project.id + "/upload/status");
      u.partSize = st.part_size; u.totalParts = st.total_parts; u.done = new Map(); u.partProgress = {}; st.parts.forEach(function (p) { if (p.size === partSize(u, p.part_number)) u.done.set(p.part_number, { size: p.size, etag: p.etag }); });
      var todo = []; for (var n = 1; n <= u.totalParts; n++) if (!u.done.has(n)) todo.push(n); u.t1 = Date.now(); u.sent = 0; u.done.forEach(function (v) { u.sent += v.size; }); u.base = u.sent; u.text = u.done.size ? "Продолжение загрузки" : "Загрузка"; changed();
      await pool(u, todo); u.state = "completing"; u.sent = u.total; u.text = "Проверка файла в хранилище"; changed();
      try { await VS.api("POST", "/projects/" + u.project.id + "/upload/complete", { parts: Array.from(u.done.entries()).sort(function (a, b) { return a[0] - b[0]; }).map(function (x) { return { part_number: x[0], etag: x[1].etag || undefined }; }) }); return; }
      catch (e) { if (e.error === "INCOMPLETE" && round < 2) { u.state = "uploading"; u.text = "Догружаю недостающие части"; continue; } throw e; }
    }
  }
  function pool(u, todo) { var q = todo.slice(), failed = null; function w() { return (async function () { while (q.length && !failed && !u.cancelled) { var n = q.shift(); try { await part(u, n); } catch (e) { failed = e; } } })(); } var ws = []; for (var i = 0; i < PART_CONC; i++) ws.push(w()); return Promise.all(ws).then(function () { if (u.cancelled) throw { name: "AbortError" }; if (failed) throw failed; }); }
  async function urls(u, n) { var nums = []; for (var k = n; k <= u.totalParts && nums.length < 10; k++) if (!u.done.has(k) && !u.urls.has(k)) nums.push(k); (await VS.api("POST", "/projects/" + u.project.id + "/upload/parts", { part_numbers: nums })).urls.forEach(function (z) { u.urls.set(z.part_number, z.url); }); }
  async function part(u, n) {
    var a = (n - 1) * u.partSize, b = Math.min(u.total, a + u.partSize), blob = u.file.slice(a, b), last;
    for (var t = 1; t <= PART_TRIES; t++) {
      if (u.cancelled) throw { name: "AbortError" };
      try { var url = u.urls.get(n); if (!url) { await urls(u, n); url = u.urls.get(n); } var etag = await put(u, n, url, blob); u.done.set(n, { size: b - a, etag: etag }); delete u.partProgress[n]; u.urls.delete(n); update(u); return; }
      catch (e) { last = e; delete u.partProgress[n]; if ((e && e.aborted) || u.cancelled) throw { name: "AbortError" }; if (e && [400, 401, 403].indexOf(e.status) >= 0) u.urls.delete(n); if (e && e.net && !u.done.size && t >= 2) u.corsHint = true; u.text = "Повтор части " + n + " из " + u.totalParts + " (попытка " + t + ")"; changed(); await VS.sleep(Math.min(8000, 700 * t * t)); }
    }
    throw last;
  }
  function put(u, n, url, blob) {
    return new Promise(function (res, rej) {
      var x = new XMLHttpRequest(); u.xhrs.add(x); x.open("PUT", url); x.timeout = 20 * 60 * 1000; x.upload.onprogress = function (e) { u.partProgress[n] = e.loaded; update(u); };
      x.onload = function () { u.xhrs.delete(x); if (x.status >= 200 && x.status < 300) res((x.getResponseHeader("ETag") || "").replace(/"/g, "") || null); else rej({ status: x.status }); };
      x.onerror = function () { u.xhrs.delete(x); rej({ net: true }); }; x.ontimeout = function () { u.xhrs.delete(x); rej({ net: true }); }; x.onabort = function () { u.xhrs.delete(x); rej({ aborted: true }); }; x.send(blob);
    });
  }
  async function queryOffset(u) { var r = await fetch(u.url, { method: "PUT", headers: { "Content-Range": "bytes */" + u.total }, signal: u.abort.signal }); if (r.status === 308) { var rg = r.headers.get("Range"); return rg ? parseInt(rg.split("-")[1], 10) + 1 : 0; } if (r.ok) return u.total; throw new Error("HTTP " + r.status); }
  async function chunks(u) {
    var off = u.sent || 0, tries = 0;
    while (off < u.total) { var end = Math.min(off + u.chunk, u.total), t0 = Date.now();
      try { var r = await fetch(u.url, { method: "PUT", headers: { "Content-Range": "bytes " + off + "-" + (end - 1) + "/" + u.total }, body: u.file.slice(off, end), signal: u.abort.signal }); if (r.status === 308) { var rg = r.headers.get("Range"); off = rg ? parseInt(rg.split("-")[1], 10) + 1 : 0; } else if (r.ok) off = u.total; else throw new Error("HTTP " + r.status); u.sent = off; u.speed = Math.min(u.chunk, u.total) / Math.max(0.2, (Date.now() - t0) / 1000); u.text = "Загрузка"; tries = 0; changed(); }
      catch (e) { if (e.name === "AbortError") throw e; if (++tries > 6) throw e; u.text = "Повтор после сбоя сети"; changed(); await VS.sleep(1500 * tries); try { off = await queryOffset(u); } catch (e2) { /* повторим с того же места */ } } }
  }
  /* ---------- раздел «Загрузки» ---------- */
  var STATE = { queued: ["В очереди", ""], uploading: ["Загружается", "warn"], completing: ["Проверка", "warn"], done: ["Готово", "ok"], error: ["Ошибка", "bad"], cancelled: ["Отменено", ""] };
  function eta(u) { if (u.state !== "uploading" || !u.speed) return ""; var s = (u.total - u.sent) / u.speed; return s > 5400 ? "≈ " + Math.round(s / 3600 * 10) / 10 + " ч" : "≈ " + Math.max(1, Math.round(s / 60)) + " мин"; }
  function row(u) {
    var pct = Math.round(100 * u.sent / u.total), st = STATE[u.state] || ["", ""];
    return '<div class="vs-up-row" data-id="' + u.id + '"><div class="vs-up-ico">' + VS.icon("film", 20) + '</div><div class="vs-up-main"><div class="vs-up-t"><b title="' + esc(u.file.name) + '">' + esc(u.file.name) + "</b>" + VS.badge(st[0], st[1]) + '</div><div class="vs-small vs-muted">' + VS.bytes(u.total) + (u.duration ? " · " + VS.dur(u.duration) : "") + " · " + esc(u.text) + (u.state === "uploading" ? " · " + pct + "%" + (u.speed ? " · " + (u.speed / 1e6).toFixed(1) + " МБ/с" : "") + (eta(u) ? " · осталось " + eta(u) : "") : "") + "</div>" +
      (["uploading", "completing", "queued"].indexOf(u.state) >= 0 ? '<div class="vs-prog"><i style="width:' + pct + '%"></i></div>' : "") + (u.error ? '<div class="vs-err vs-small">' + esc(u.error) + "</div>" : "") + '</div><div class="vs-up-act">' +
      (["uploading", "queued", "completing"].indexOf(u.state) >= 0 ? '<button class="vs-btn sm" data-up-cancel="' + u.id + '">Отменить</button>' : "") + (u.state === "error" || u.state === "cancelled" ? '<button class="vs-btn sm" data-up-retry="' + u.id + '">' + VS.icon("refresh", 14) + ' Повторить</button>' : "") + (u.project && u.state === "done" ? '<a class="vs-btn sm" href="#/projects/' + u.project.id + '">Открыть проект</a>' : "") + (["done", "error", "cancelled"].indexOf(u.state) >= 0 ? '<button class="vs-btn sm ghost" data-up-rm="' + u.id + '" aria-label="Убрать">' + VS.icon("x", 14) + "</button>" : "") + "</div></div>";
  }
  function summary() {
    var a = U.items.filter(function (i) { return ["uploading", "queued", "completing"].indexOf(i.state) >= 0; }); if (!a.length) return '<div class="vs-muted">Активных загрузок нет. Перетащите файлы выше или нажмите на область загрузки.</div>';
    var tot = a.reduce(function (s, i) { return s + i.total; }, 0), sent = a.reduce(function (s, i) { return s + i.sent; }, 0), sp = a.reduce(function (s, i) { return s + (i.state === "uploading" ? i.speed : 0); }, 0), pct = tot ? Math.round(100 * sent / tot) : 0;
    return '<div class="vs-sum"><b>Общий прогресс: ' + pct + "%</b><span>" + a.length + " файл(ов) · " + VS.bytes(sent) + " из " + VS.bytes(tot) + (sp ? " · " + (sp / 1e6).toFixed(1) + " МБ/с · осталось ≈ " + Math.max(1, Math.round((tot - sent) / sp / 60)) + " мин" : "") + '</span></div><div class="vs-prog big"><i style="width:' + pct + '%"></i></div>';
  }
  VS.views.uploads = {
    title: "Центр загрузки",
    mount: function (el) {
      var lim = S.me.limits; el.innerHTML = '<div class="vs-dropzone" id="up-drop" tabindex="0" role="button" aria-label="Выбрать файлы для загрузки">' + VS.icon("uploads", 34) + '<h3>Перетащите записи LIVE сюда</h3><p>или нажмите, чтобы выбрать несколько файлов</p><span class="vs-small vs-muted">MP4 и MOV · до ' + esc(lim.max_upload_gb) + " ГБ на файл · до " + esc(lim.max_duration_min) + ' мин · загрузка по частям прямо в хранилище, с продолжением после обрыва</span></div><input type="file" id="up-file" accept=".mp4,.mov,video/mp4,video/quicktime" multiple hidden>' +
        '<div class="vs-card"><div class="vs-card-h"><h3>Общий прогресс</h3></div><div id="up-sum"></div></div><div class="vs-card"><div class="vs-card-h"><h3>Очередь загрузки</h3></div><div id="up-list"></div></div><div class="vs-card" id="up-broken"></div>';
      var drop = $("#up-drop", el), inp = $("#up-file", el); drop.onclick = function () { inp.click(); }; drop.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inp.click(); } };
      drop.ondragover = function (e) { e.preventDefault(); drop.classList.add("over"); }; drop.ondragleave = function () { drop.classList.remove("over"); }; drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files.length) U.add(e.dataTransfer.files); }; inp.onchange = function () { if (inp.files.length) U.add(inp.files); inp.value = ""; };
      function paint() { var l = $("#up-list", el), s = $("#up-sum", el); if (!l) return; s.innerHTML = summary(); l.innerHTML = U.items.length ? U.items.slice().reverse().map(row).join("") : '<div class="vs-empty"><p>Файлов пока нет.</p></div>'; }
      el.addEventListener("click", function (e) { var c = e.target.closest("[data-up-cancel]"), r = e.target.closest("[data-up-retry]"), x = e.target.closest("[data-up-rm]"); if (c) U.cancel(+c.dataset.upCancel); if (r) U.retry(+r.dataset.upRetry); if (x) U.remove(+x.dataset.upRm); });
      this._off = VS.on("uploads", paint); paint();
      this._broken = VS.section($("#up-broken", el), { title: "Прерванные загрузки", load: function () { return VS.api("GET", "/projects"); }, render: function (d, box) {
        var act = U.items.filter(function (i) { return i.project; }).map(function (i) { return i.project.id; }), list = d.projects.filter(function (p) { return p.status === "uploading" && act.indexOf(p.id) < 0; });
        box.innerHTML = '<div class="vs-card-h"><h3>Прерванные загрузки</h3></div>' + (list.length ? '<p class="vs-small vs-muted">Выберите тот же файл ещё раз — недостающие части догрузятся автоматически.</p>' + list.map(function (p) { return '<div class="vs-line-row"><div><b>' + esc(p.filename) + '</b><div class="vs-small vs-muted">' + VS.bytes(p.size_bytes) + " · начата " + VS.ago(p.created_at) + '</div></div><button class="vs-btn sm danger" data-drop-broken="' + esc(p.id) + '">Удалить</button></div>'; }).join("") : '<p class="vs-muted">Прерванных загрузок нет.</p>');
        VS.$$("[data-drop-broken]", box).forEach(function (b) { b.onclick = async function () { if (!(await VS.confirm("Удалить незавершённую загрузку?", "Начатые части будут удалены из хранилища.", { danger: true, okLabel: "Удалить" }))) return; try { await VS.api("POST", "/projects/" + b.dataset.dropBroken + "/upload/cancel"); VS.toast("Загрузка удалена", "ok"); VS._ub.reload(); } catch (e) { VS.toast(VS.errText(e), "bad"); } }; });
      } }); VS._ub = this._broken;
    },
    unmount: function () { if (this._off) this._off(); }
  };
})();
