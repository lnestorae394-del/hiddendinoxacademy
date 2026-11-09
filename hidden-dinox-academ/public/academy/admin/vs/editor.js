/* Редактор клипа: предпросмотр 9:16 с оформлением, шкала обрезки начала и конца, правка хука, субтитров и кадра с автосохранением, точный предпросмотр, сборка, Telegram.
   Логика перенесена из проверенной версии без изменений поведения; подключается к рабочей области проекта через VS.editor.mount(контейнер, контекст). */
(function () {
  "use strict";
  var VS = window.VS, C = window.VSCore, $ = VS.$, $$ = VS.$$, esc = VS.esc, fmt = VS.fmt, mb = VS.bytes, sleep = VS.sleep, tgBadge = VS.tgBadge, errText = VS.errText;
  var isActive = VS.isActive, api = function (m, p, b) { return VS.api(m, p, b); }, toast = function (t, bad) { VS.toast(t, bad ? "bad" : "info"); };
  var S = { cv: null, cid: null, m: null, media: {}, logo: null, project: null, clips: [], pending: [], saving: null, saveTimer: null, tl: null, wf: null, wfDirty: {}, editors: [], tg: null, savedAt: null }, ctx = {}, root = null, rafStop = false;
  function renderLeft() { /* список клипов обновляет раздел «Проекты» при перезагрузке данных */ }
  function dirtyAny() { return S.pending.length > 0 || Object.keys(S.wfDirty).length > 0; }
  /* индикатор: «Сохранено» / «Есть несохранённые изменения» / «Сохранение…»; кнопка «Сохранить» активна только при несохранённых изменениях */
  function indicator(state) { var e = $("#ed-state"), b = $("#ed-save"); if (!e) return; var st = state || (S.saving ? "saving" : dirtyAny() ? "dirty" : "saved"); e.className = "vs-save-ind " + st; e.textContent = st === "saving" ? "Сохранение…" : st === "dirty" ? "Есть несохранённые изменения" : "Сохранено" + (S.savedAt ? " · " + new Date(S.savedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : ""); if (b) b.disabled = st !== "dirty"; }
  function statusSaving() { indicator(); }
  async function refreshProject() { if (ctx.refresh) await ctx.refresh(); await reloadClipMeta(); }
  async function reloadClipMeta() { if (!S.cid || !S.cv || S.pending.length) return; var v = await api("GET", "/clips/" + S.cid); S.cv.clip = v.clip; S.cv.stale = v.stale; S.cv.preview_stale = v.preview_stale; }
  async function downloadClip(id) { return VS.downloadClip(id); }
  async function sendTg(id, force, reupload) { var r = await api("POST", "/clips/" + id + "/telegram", { force: !!force, reupload: !!reupload }); if (r.already_sent) return toast("Это видео уже доставлено в Telegram. Для повторной отправки нажмите кнопку ещё раз."); toast("Отправка в Telegram поставлена в очередь"); await VS.pollNow(); await reloadClipMeta(); renderRight(); }

  /* ---------- клип: открытие, модель предпросмотра ---------- */
  async function openClip(id) {
    if (S.cv && S.cid && S.cid !== id && dirtyAny()) { try { await saveAll(true); } catch (e) { /* ошибка уже показана */ } }
    S.cid = id; S.cv = null; S.m = null; S.pending = []; S.wf = null; S.wfDirty = {}; S.media = {}; renderCenter(); renderRight();
    try { S.cv = await api("GET", "/clips/" + id); } catch (e) { return failBox(e, id); }
    S.wf = Object.assign({ status: "found", task: "", comment: "", assignee_id: null, rev: 0 }, S.cv.clip.workflow || {}); S.wfDirty = {}; S.savedAt = null;
    try { var edl = await api("GET", "/editors"); S.editors = edl.editors.filter(function (x) { return x.active; }); S.tg = edl.telegram; } catch (e) { S.editors = []; }
    try { S.media = await api("GET", "/clips/" + id + "/media?kind=window"); } catch (e) { S.media = { error: errText(e) }; }
    if (!S.logo) { try { S.logo = await api("GET", "/logo"); } catch (e) { S.logo = { brand: [], custom: false }; } }
    buildModel(); renderCenter(); renderRight();
  }
  function failBox(e, id) { var c = $("#vsC"); if (c) { c.innerHTML = '<div class="vs-errbox"><div class="vs-errbox-h">' + VS.icon("alert") + "<b>Клип не открылся</b></div><p>" + esc(errText(e)) + '</p><button class="vs-btn" id="ed-retry">Повторить</button></div>'; var b = $("#ed-retry"); if (b) b.onclick = function () { openClip(id); }; } var r = $("#vsR"); if (r) r.innerHTML = ""; }
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
  function capGeom() {
    var t = S.cv.template, e = S.cv.edits, c0 = t.caption || {}, ec = e.caption || {};
    return { x: ec.x != null ? ec.x : (c0.x != null ? c0.x : 540), y: ec.y != null ? ec.y : (c0.y != null ? c0.y : 1765), size: ec.size || c0.size || 46, w: 1080 - (c0.margin_l != null ? c0.margin_l : 72) - (c0.margin_r != null ? c0.margin_r : 72), cty: e.cta.y != null ? e.cta.y : t.cta.y, ctsz: e.cta.size || t.cta.size };
  }
  function drawStage() {
    var st = $("#vsstage"); if (!st || !S.cv) return; var t = S.cv.template, w = t.window, e = S.cv.edits, hk = t.hook, sb = t.subtitles, cta = t.cta, br = t.brand, bar = t.bar, cl = t.colors, fr = e.framing || { zoom: 1, pan_x: 0, pan_y: 0 };
    var cg = capGeom(), hx = e.hook.x != null ? e.hook.x : hk.x, hy = e.hook.y != null ? e.hook.y : hk.y, hs = e.hook.size || hk.size, lu = logoUrl(), sw = (S.project && S.project.width) || 720, k = 1080 / sw;
    st.innerHTML = '<video id="vsvid" playsinline preload="auto" style="top:' + w.y + "px;width:1080px;height:" + w.h + 'px;transform:scale(' + fr.zoom + ") translate(" + (-fr.pan_x * k) + "px," + (-fr.pan_y * k) + 'px)"></video>' +
      '<div class="vs-line" style="top:' + (w.y - t.glow.thin) + "px;height:" + t.glow.thin + 'px"></div><div class="vs-line" style="top:' + (w.y + w.h) + "px;height:" + t.glow.thin + 'px"></div>' +
      (lu ? '<img class="vs-logo" alt="" src="' + esc(lu) + '" style="left:' + t.logo.x + "px;top:" + t.logo.y + "px;width:" + t.logo.w + 'px">' : "") +
      '<div class="vs-hd" style="left:' + br.margin_l + "px;top:" + br.margin_v + "px;font-size:" + br.size + "px;letter-spacing:" + br.spacing + "px;color:" + cl.accent + '">' + esc(br.text) + "</div>" +
      '<div class="vs-hook" id="vshook" style="left:' + hx + "px;top:" + hy + "px;width:" + (1080 - hk.margin_l - hk.margin_r) + "px;font-size:" + hs + 'px"></div>' +
      '<div class="vs-sub" id="vssub" style="left:' + sb.x + "px;top:" + sb.y + "px;width:" + (1080 - sb.margin_l - sb.margin_r) + "px;font-size:" + sb.size + 'px"></div>' +
      '<div class="vs-cap" id="vscap" style="left:' + cg.x + "px;top:" + cg.y + "px;width:" + cg.w + "px;font-size:" + cg.size + 'px"></div><div class="vs-cta" id="vscta" style="left:' + cta.x + "px;top:" + cg.cty + "px;font-size:" + cg.ctsz + 'px"></div>' + (bar.enabled ? '<div class="vs-bar" id="vsbar" style="top:' + bar.y + "px;height:" + bar.h + 'px;width:0"></div>' : "");
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
    var cap = $("#vscap"); if (cap) { var g = capGeom(); cap.textContent = e.caption && e.caption.enabled && e.caption.text ? e.caption.text : ""; cap.style.left = g.x + "px"; cap.style.top = g.y + "px"; cap.style.fontSize = g.size + "px"; }
    var ctaP = $("#vscta"); if (ctaP) { var g2 = capGeom(); ctaP.style.top = g2.cty + "px"; ctaP.style.fontSize = g2.ctsz + "px"; }
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
  async function extendWindow() { try { await api("POST", "/clips/" + S.cid + "/window", { start: Math.max(0, S.tl.s - 8), end: Math.min(S.project.duration_sec, S.tl.e + 8) }); toast("Готовлю новое окно предпросмотра…"); await VS.pollNow(); } catch (e) { toast(errText(e), true); } }

  /* ---------- правая колонка: редактор ---------- */
  function renderRight() {
    var el = $("#vsR"); if (!el) return; if (!S.cid || !S.cv) { el.innerHTML = ""; return; }
    var v = S.cv, e = v.edits, t = v.template, c = v.clip, ck = v.checks, fr = e.framing || { zoom: 1, pan_x: 0, pan_y: 0 }, busy = VS.State.jobs.some(function (j) { return isActive(j) && j.clip_id === c.id && j.type !== "telegram"; }), tgBusy = VS.State.jobs.some(function (j) { return isActive(j) && j.clip_id === c.id && j.type === "telegram"; });
    var h = savebar() + wfCard() + captionCard() + '<div class="vs-card"><h3>Хук и призыв</h3><label class="vs-small vs-muted">Хук (на экране с первой секунды)</label><input id="f-hook" value="' + esc(e.hook.text) + '" maxlength="80"><div class="vs-row" style="margin-top:6px"><button data-act="hooks">✨ Предложить хуки (ИИ)</button><button data-act="hook-reset">Вернуть исходный</button></div><div class="vs-row" style="margin-top:6px"><label class="vs-small">Размер <input id="f-hsize" type="number" min="24" max="120" placeholder="' + t.hook.size + '" value="' + (e.hook.size || "") + '" style="width:80px"></label><label class="vs-small">Верх, px <input id="f-hy" type="number" min="0" max="1900" placeholder="' + t.hook.y + '" value="' + (e.hook.y != null ? e.hook.y : "") + '" style="width:90px"></label><label class="vs-small"><input id="f-hon" type="checkbox"' + (e.hook.enabled ? " checked" : "") + '> показывать</label></div>' +
      '<label class="vs-small vs-muted" style="display:block;margin-top:8px">Призыв в конце</label><input id="f-cta" value="' + esc(e.cta.text || "") + '" placeholder="' + esc(t.cta.text) + '" maxlength="60"><label class="vs-small"><input id="f-cton" type="checkbox"' + (e.cta.enabled !== false ? " checked" : "") + '> показывать призыв</label><div class="vs-row" style="margin-top:6px"><label class="vs-small">Положение (Y, px) <input id="f-cty" type="number" min="1000" max="1900" placeholder="' + t.cta.y + '" value="' + (e.cta.y != null ? e.cta.y : "") + '" style="width:90px"></label><label class="vs-small">Размер <input id="f-ctsz" type="number" min="16" max="90" placeholder="' + t.cta.size + '" value="' + (e.cta.size || "") + '" style="width:80px"></label></div><p class="vs-small vs-muted">Призыв стоит внизу кадра, ниже субтитров, и не перекрывает видео. Положение можно менять.</p></div>' +
      '<div class="vs-card"><h3>Кадр</h3><label class="vs-small">Масштаб: <span id="fr-zv">' + fr.zoom.toFixed(2) + '×</span><input class="vs-range" id="fr-z" type="range" min="1" max="2.5" step="0.05" value="' + fr.zoom + '"></label><label class="vs-small">Сдвиг по горизонтали: <span id="fr-xv">' + fr.pan_x + '</span><input class="vs-range" id="fr-x" type="range" min="-300" max="300" step="5" value="' + fr.pan_x + '"></label><label class="vs-small">Сдвиг по вертикали: <span id="fr-yv">' + fr.pan_y + '</span><input class="vs-range" id="fr-y" type="range" min="-300" max="300" step="5" value="' + fr.pan_y + '"></label><button data-act="fr-reset">Сбросить кадр</button></div>';
    h += '<div class="vs-card"><h3>Субтитры</h3><textarea id="f-full" rows="4">' + esc(visWords().map(function (w) { return w.text; }).join(" ")) + '</textarea><div class="vs-row" style="margin-top:6px"><button data-act="rewrite">Применить как правку предложения</button></div><p class="vs-small vs-muted">Неизменённые слова сохраняют исходное время; новые получают время между соседями и помечаются «?».</p><div class="vs-words">' + e.words.map(function (w) { return wordRow(w, e); }).join("") + '</div><p class="vs-small vs-muted">★ ключевое слово · ⌫ убрать · ＋ добавить после · ¶ граница блока · «?» время не подтверждено</p></div>';
    if (v.suggestions && v.suggestions.length) h += '<div class="vs-card"><h3>Подсказки терминов</h3>' + v.suggestions.map(function (s) { return '<div class="vs-row vs-small"><span>«' + esc(s.from) + "» → <b>" + esc(s.to) + '</b></span><button data-act="suggest" data-id="' + esc(s.id) + '" data-to="' + esc(s.to) + '">Применить</button></div>'; }).join("") + "</div>";
    h += '<div class="vs-card"><h3>Результат</h3><p class="vs-small">Длительность ролика: <b>' + ck.final_s + " с</b> · слов " + ck.words + "</p>" + ck.warnings.map(function (w) { return '<div class="vs-warn">⚠ ' + esc(w.message) + "</div>"; }).join("") + resultBlock(v, c, ck, busy, tgBusy);
    h += '<div class="vs-row" style="margin-top:8px"><button data-act="exclude" class="vs-danger">' + (c.status === "excluded" ? "Вернуть клип" : "Исключить клип") + "</button></div>" + (c.error ? '<p class="vs-err vs-small">' + esc(c.error.message) + "</p>" : "") + "</div>";
    el.innerHTML = h; indicator();
  }
  function savebar() { return '<div class="vs-savebar"><span id="ed-state" class="vs-save-ind saved">Сохранено</span><button class="vs-primary" id="ed-save" data-act="save" disabled>Сохранить</button><button data-act="hist" class="vs-link">История</button></div>'; }
  function wfCard() {
    var w = S.wf || {}, eds = S.editors || [];
    return '<div class="vs-card"><h3>Статус и задание монтажёру</h3><label class="vs-small vs-muted">Статус</label><select id="f-wf-status" class="vs-select">' + VS.WF.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === w.status ? " selected" : "") + ">" + esc(x[1]) + "</option>"; }).join("") + '</select><label class="vs-small vs-muted" style="margin-top:8px;display:block">Монтажёр</label><select id="f-wf-assignee" class="vs-select"><option value="">— не назначен —</option>' + eds.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === w.assignee_id ? " selected" : "") + ">" + esc(x.name) + (x.telegram_status === "not_linked" ? " · Telegram не привязан" : "") + "</option>"; }).join("") + "</select>" + (eds.length ? "" : '<p class="vs-small vs-muted">Монтажёров пока нет — добавьте их в разделе <a href="#/editors">«Монтажёры»</a>.</p>') +
      '<label class="vs-small vs-muted" style="margin-top:8px;display:block">Задача для монтажёра / Что нужно изменить <span class="vs-muted">(<span id="wf-cnt">' + String(w.task || "").length + '</span>/5000)</span></label><textarea id="f-wf-task" rows="9" maxlength="5000" placeholder="Например: Убрать первые две секунды. Увеличить текст внизу. Сделать субтитры крупнее. Оставить момент с демонстрацией графика. Убрать паузу в конце. Не менять оригинальный звук.">' + esc(w.task || "") + '</textarea><label class="vs-small vs-muted" style="margin-top:8px;display:block">Комментарий</label><input id="f-wf-comment" maxlength="2000" value="' + esc(w.comment || "") + '" placeholder="Короткая заметка к заданию"></div>';
  }
  function captionCard() {
    var e = S.cv.edits, c = e.caption || { text: "", enabled: false }, t = S.cv.template.caption || {};
    return '<div class="vs-card"><h3>Текст внизу видео</h3><textarea id="f-cap" rows="3" maxlength="140" placeholder="Текст, который будет виден внизу видео (до 3 строк)">' + esc(c.text || "") + '</textarea><div class="vs-row" style="margin-top:6px"><label class="vs-small"><input id="f-capon" type="checkbox"' + (c.enabled ? " checked" : "") + '> показывать</label><label class="vs-small">Размер <input id="f-capsz" type="number" min="24" max="120" placeholder="' + (t.size || 46) + '" value="' + (c.size || "") + '" style="width:80px"></label><label class="vs-small">Положение (Y, px) <input id="f-capy" type="number" min="1000" max="1900" placeholder="' + (t.y || 1765) + '" value="' + (c.y != null ? c.y : "") + '" style="width:90px"></label></div><div class="vs-row" style="margin-top:6px"><button data-act="cap-del">Удалить текст</button><button data-act="cap-reset">Вернуть по умолчанию</button></div><p class="vs-small vs-muted">Это отдельный текст клипа. В предпросмотре он виден сразу, в итоговый ролик попадёт после «Сохранить» и пересборки видео.</p></div>';
  }
  /* актуальное состояние видео и следующее доступное действие */
  function resultBlock(v, c, ck, busy, tgBusy) {
    var state = busy ? "building" : !c.render ? "none" : v.stale ? "stale" : "ready";
    var msg = { building: "Видео собирается… Обычно это около минуты; ход — в «Очереди обработки».", none: "Видео ещё не собрано. Нажмите «Собрать видео».", stale: "Вы изменили клип после последней сборки. Нажмите «Пересобрать видео с изменениями», чтобы новый текст и правки попали в итоговый файл.", ready: "Видео собрано и содержит последние сохранённые правки." }[state];
    var h = '<div class="vs-alert ' + (state === "ready" ? "ok" : state === "stale" ? "warn" : "") + '">' + esc(msg) + "</div>" + (c.render ? '<p class="vs-small vs-muted">Размер файла ' + mb(c.render.size || 0) + "</p>" : "");
    h += '<div class="vs-row" style="margin-top:8px"><button data-act="preview"' + (busy ? " disabled" : "") + '>Точный предпросмотр</button><button class="vs-primary" data-act="render"' + (busy || !ck.can_render ? " disabled" : "") + ">" + (c.render ? "Пересобрать видео с изменениями" : "Собрать видео") + "</button></div>";
    if (c.render) h += '<div class="vs-row" style="margin-top:8px"><button data-act="watch">Посмотреть видео</button><button data-act="download">Скачать MP4' + (v.stale ? " (устарел)" : "") + '</button><button data-act="tg-dispatch"' + (tgBusy ? " disabled" : "") + '>Отправить в Telegram…</button></div><div>' + tgBadge(c.telegram) + "</div>";
    return h;
  }
  function wordRow(w, e) {
    return '<div class="vs-w' + (w.deleted ? " del" : "") + (w.synced === false ? " uns" : "") + '" data-wid="' + esc(w.id) + '"><button data-act="emph" data-id="' + esc(w.id) + '" title="Ключевое слово">' + (e.emphasis.indexOf(w.id) >= 0 ? "★" : "☆") + '</button><input type="text" data-f="text" value="' + esc(w.text) + '" maxlength="60"' + (w.deleted ? " disabled" : "") + '><input type="number" step="0.05" data-f="start" value="' + w.start + '" title="начало, с"><input type="number" step="0.05" data-f="end" value="' + w.end + '" title="конец, с">' +
      (w.deleted ? '<button data-act="restore" data-id="' + esc(w.id) + '" title="Вернуть">↺</button><span></span>' : '<button data-act="del" data-id="' + esc(w.id) + '" title="Убрать слово">⌫</button><button data-act="add" data-id="' + esc(w.id) + '" title="Добавить слово после">＋</button>') + "</div>" +
      (w.deleted ? "" : '<div class="vs-small" style="grid-column:2/7;margin:-2px 0 4px 26px"><a href="#" data-act="brk" data-on="' + (e.breaks.indexOf(w.id) >= 0 ? "0" : "1") + '" data-id="' + esc(w.id) + '">' + (e.breaks.indexOf(w.id) >= 0 ? "¶ убрать границу блока" : "¶ закончить блок здесь") + '</a> · <a href="#" data-act="join" data-on="' + (e.joins.indexOf(w.id) >= 0 ? "0" : "1") + '" data-id="' + esc(w.id) + '">' + (e.joins.indexOf(w.id) >= 0 ? "не разрывать: включено — убрать" : "не разрывать после слова") + "</a></div>") +
      (w.synced === false && !w.deleted ? '<div class="vs-small vs-warn" style="margin:-2px 0 4px 26px">«?» время приблизительное <a href="#" data-act="confirm" data-id="' + esc(w.id) + '">подтвердить</a></div>' : "");
  }

  /* ---------- правки: очередь и автосохранение ---------- */
  var COALESCE = { set_text: "id", set_time: "id", set_hook: "", set_cta: "", set_framing: "", set_caption: "" };
  var SERVER_OPS = { add_after: 1, rewrite_range: 1, reset_word: 1, reset_hook: 1, reset_framing: 1, reset_caption: 1 };
  function queue(op) {
    var key = COALESCE[op.op];
    if (key === "") { var prev = S.pending.filter(function (p) { return p.op === op.op; })[0]; if (prev) Object.assign(prev, op); else S.pending.push(op); }   // частичные правки одной операции объединяются, а не затирают друг друга
    else { if (key !== undefined) S.pending = S.pending.filter(function (p) { return !(p.op === op.op && p[key] === op[key]); }); S.pending.push(op); }
    applyLocal(op); buildModel(); drawStageSoft();
    if (SERVER_OPS[op.op]) { flush(); return; }                       // операции, результат которых считает сервер, сохраняются сразу (вместе с остальными ожидающими)
    if (STRUCT[op.op]) renderRight(); indicator();
  }
  function drawStageSoft() { if (op_needs_stage()) drawStage(); else paintOverlay(S.m ? S.m.cur || 0 : 0); }
  var STAGE_OPS = false; function op_needs_stage() { var r = STAGE_OPS; STAGE_OPS = false; return r; }
  function applyLocal(op) {
    var e = S.cv.edits, w = op.id && e.words.find(function (x) { return x.id === op.id; }), tg = function (a, id, on) { var i = a.indexOf(id); if (on && i < 0) a.push(id); if (!on && i >= 0) a.splice(i, 1); };
    if (op.op === "set_text" && w) w.text = op.text; else if (op.op === "set_time" && w) { w.start = op.start; w.end = op.end; } else if (op.op === "delete" && w) w.deleted = true; else if (op.op === "restore" && w) w.deleted = false;
    else if (op.op === "set_hook") Object.keys(op).forEach(function (k) { if (k !== "op") e.hook[k] = op[k]; }); else if (op.op === "set_cta") Object.keys(op).forEach(function (k) { if (k !== "op") e.cta[k] = op[k]; });
    else if (op.op === "set_caption") { e.caption = e.caption || { text: "", enabled: false, size: null, x: null, y: null }; Object.keys(op).forEach(function (k) { if (k !== "op") e.caption[k] = op[k]; }); if (op.text !== undefined && String(op.text).trim() && op.enabled === undefined) e.caption.enabled = true; }
    else if (op.op === "set_framing") { e.framing = e.framing || { zoom: 1, pan_x: 0, pan_y: 0 }; Object.keys(op).forEach(function (k) { if (k !== "op") e.framing[k] = op[k]; }); STAGE_OPS = true; }
    else if (op.op === "set_emphasis") tg(e.emphasis, op.id, op.on); else if (op.op === "set_break") tg(e.breaks, op.id, op.on); else if (op.op === "set_join") tg(e.joins, op.id, op.on); else if (op.op === "confirm_sync" && w) w.synced = true;
  }
  var STRUCT = { set_join: 1, add_after: 1, rewrite_range: 1, reset_word: 1, reset_hook: 1, reset_framing: 1, delete: 1, restore: 1, confirm_sync: 1, set_break: 1, set_emphasis: 1 };
  /* статус, задание, комментарий и монтажёр хранятся в самом клипе (один источник); сохранение с проверкой версии */
  async function persistWorkflow(id, wf, dirty) {
    if (!Object.keys(dirty).length) return null; var rev = wf.rev;
    if ("assignee_id" in dirty) { var ra = await api("POST", "/clips/assign", { clip_ids: [id], editor_id: dirty.assignee_id || null }); if (ra.updated) rev = ((await api("GET", "/clips/" + id)).clip.workflow || {}).rev || 0; }
    var body = { base_rev: rev }, has = false; ["status", "task", "comment"].forEach(function (k) { if (k in dirty) { body[k] = dirty[k]; has = true; } });
    if (!has) return (await api("GET", "/clips/" + id)).clip.workflow; return (await api("PUT", "/clips/" + id + "/workflow", body)).workflow;
  }
  async function saveAll(silent) {
    if (!S.cv) return; var id = S.cid;
    try {
      indicator("saving"); await flush();
      if (Object.keys(S.wfDirty).length) { var wf = await persistWorkflow(id, S.wf, S.wfDirty); if (S.cid === id && wf) { S.wf = Object.assign({}, wf); S.cv.clip.workflow = Object.assign({}, wf); S.wfDirty = {}; } }
      S.savedAt = Date.now(); if (S.cid === id) { indicator(); renderRight(); } if (ctx.refresh) ctx.refresh(); toast(silent ? "Несохранённые изменения клипа сохранены автоматически" : "Сохранено");
    } catch (e) {
      if (e && e.status === 409) { toast("Клип изменён в другом окне — данные обновлены. Проверьте поля и сохраните ещё раз.", true); try { var fr = await api("GET", "/clips/" + id); if (S.cid === id) { S.cv.clip = fr.clip; S.wf = Object.assign({}, fr.clip.workflow, S.wfDirty); S.wf.rev = fr.clip.workflow.rev; renderRight(); } } catch (e2) { /* без обновления */ } } else toast(errText(e), true);
      indicator(); throw e;
    }
  }
  async function flush() {
    if (S.saving) await S.saving; if (!S.pending.length || !S.cv) return; var ops = S.pending.splice(0), id = S.cid, structural = ops.some(function (o) { return STRUCT[o.op]; });
    S.saving = (async function () {
      indicator("saving");
      try { var r = await api("PUT", "/clips/" + id + "/edits", { base_rev: S.cv.edits.rev, ops: ops }); if (S.cid !== id) return; S.cv.edits = r.edits; S.cv.checks = r.checks; S.cv.suggestions = r.suggestions; S.cv.current_hash = r.current_hash; S.cv.stale = !!(S.cv.clip.render && S.cv.clip.render.hash !== r.current_hash); S.cv.clip.status = ["rendering", "excluded"].indexOf(S.cv.clip.status) >= 0 ? S.cv.clip.status : "edited"; buildModel(); S.savedAt = Date.now(); S.saving = null; statusSaving(); if (structural || !$(".vs-words input:focus")) renderRight(); paintOverlay(S.m ? S.m.cur || 0 : 0); renderLeft(); }
      catch (e) { toast(errText(e), true); if (S.cid === id) await openClip(id); }
    })(); await S.saving; S.saving = null;
  }

  function onInput(ev) {
    var t = ev.target; if (!S.cv) return;
    if (t.id === "f-hook") queue({ op: "set_hook", text: t.value }); else if (t.id === "f-hsize") queue({ op: "set_hook", size: t.value === "" ? null : Number(t.value) }); else if (t.id === "f-hy") queue({ op: "set_hook", y: t.value === "" ? null : Number(t.value) });
    else if (t.id === "f-cta") queue({ op: "set_cta", text: t.value.trim() === "" ? null : t.value });
    else if (t.id === "f-cap") queue({ op: "set_caption", text: t.value }); else if (t.id === "f-capsz") queue({ op: "set_caption", size: t.value === "" ? null : Number(t.value) }); else if (t.id === "f-capy") queue({ op: "set_caption", y: t.value === "" ? null : Number(t.value) });
    else if (t.id === "f-cty") queue({ op: "set_cta", y: t.value === "" ? null : Number(t.value) }); else if (t.id === "f-ctsz") queue({ op: "set_cta", size: t.value === "" ? null : Number(t.value) });
    else if (t.id === "f-wf-task") { S.wf.task = t.value; S.wfDirty.task = t.value; var cn = $("#wf-cnt"); if (cn) cn.textContent = t.value.length; indicator(); }
    else if (t.id === "f-wf-comment") { S.wf.comment = t.value; S.wfDirty.comment = t.value; indicator(); }
    else if (t.id === "fr-z" || t.id === "fr-x" || t.id === "fr-y") { var k = { "fr-z": "zoom", "fr-x": "pan_x", "fr-y": "pan_y" }[t.id], val = Number(t.value), o = { op: "set_framing" }; o[k] = val; $("#" + t.id.replace("fr-", "fr-") + "v") && ($("#" + t.id + "v").textContent = k === "zoom" ? val.toFixed(2) + "×" : val); queue(o); }
    else if (t.dataset && t.dataset.f === "text") { var id = t.closest(".vs-w").dataset.wid; if (t.value.trim() && !/\s/.test(t.value.trim())) queue({ op: "set_text", id: id, text: t.value }); }
    else if (t.id === "tl-s" || t.id === "tl-e") { var n = Number(t.value); if (isFinite(n)) setTl(t.id === "tl-s" ? "s" : "e", n); }
  }
  function onChange(ev) {
    var t = ev.target;
    if (!S.cv) return;
    if (t.id === "f-wf-status") { S.wf.status = t.value; S.wfDirty.status = t.value; indicator(); } else if (t.id === "f-wf-assignee") { S.wf.assignee_id = t.value || null; S.wfDirty.assignee_id = t.value || null; indicator(); } else if (t.id === "f-capon") queue({ op: "set_caption", enabled: t.checked });
    else if (t.id === "f-hon") queue({ op: "set_hook", enabled: t.checked }, true); else if (t.id === "f-cton") queue({ op: "set_cta", enabled: t.checked }, true);
    else if (t.dataset && (t.dataset.f === "start" || t.dataset.f === "end")) { var row = t.closest(".vs-w"), id = row.dataset.wid; queue({ op: "set_time", id: id, start: Number($('[data-f="start"]', row).value), end: Number($('[data-f="end"]', row).value) }, true); }
    else if (t.dataset && t.dataset.f === "text") { var tv = t.value.trim(); if (tv && /\s/.test(tv)) { toast("Для нескольких слов используйте поле «Субтитры» выше", true); renderRight(); } }
  }
  async function editAction(act, id, a) {
    if (!S.cv && ["up", "down"].indexOf(act) < 0) return;
    if (act === "del") queue({ op: "delete", id: id }, true); else if (act === "restore") queue({ op: "restore", id: id }, true);
    else if (act === "emph") queue({ op: "set_emphasis", id: id, on: S.cv.edits.emphasis.indexOf(id) < 0 }, true); else if (act === "brk") queue({ op: "set_break", id: id, on: a.dataset.on === "1" }, true); else if (act === "join") queue({ op: "set_join", id: id, on: a.dataset.on === "1" }, true);
    else if (act === "confirm") queue({ op: "confirm_sync", id: id }, true); else if (act === "suggest") queue({ op: "set_text", id: id, text: a.dataset.to }, true); else if (act === "hook-reset") queue({ op: "reset_hook" }, true); else if (act === "fr-reset") { STAGE_OPS = true; queue({ op: "reset_framing" }, true); }
    else if (act === "add") { var txt = prompt("Какое слово добавить после этого?"); if (txt && txt.trim()) queue({ op: "add_after", after_id: id, text: txt.trim() }, true); }
    else if (act === "rewrite") { var ws = visWords(), t2 = $("#f-full").value.trim(); if (!t2) return toast("Текст пуст", true); queue({ op: "rewrite_range", from_id: ws[0].id, to_id: ws[ws.length - 1].id, text: t2 }, true); }
    else if (act === "hooks") { toast("Спрашиваю ИИ…"); var r = await api("POST", "/clips/" + S.cid + "/hooks"); if (!r.hooks.length) return toast(r.note || "ИИ не предложил подходящих хуков", true); var m = document.createElement("div"); m.className = "vs-modal"; m.innerHTML = '<div><h3 style="color:#A6F32B">Варианты хука</h3><p class="vs-small vs-muted">Каждый вариант проверен: основан на словах клипа, без обещаний. Расход ≈ $' + r.cost_usd + '.</p>' + r.hooks.map(function (h, i) { return '<p><button data-pick="' + i + '" style="width:100%;text-align:left">' + esc(h) + "</button></p>"; }).join("") + '<button id="hk-no">Закрыть</button></div>'; document.body.appendChild(m); $("#hk-no").onclick = function () { m.remove(); }; $$("[data-pick]", m).forEach(function (b) { b.onclick = function () { queue({ op: "set_hook", text: r.hooks[+b.dataset.pick] }, true); var f = $("#f-hook"); if (f) f.value = r.hooks[+b.dataset.pick]; m.remove(); }; }); }
    else if (act === "preview" || act === "render") { await flush(); var r2 = await api("POST", "/clips/" + S.cid + "/" + act); toast(r2.cached && !r2.in_progress ? "Без изменений — готовая версия актуальна" : act === "render" ? "Сборка видео запущена" : "Предпросмотр собирается"); await VS.pollNow(); await refreshProject(); }
    else if (act === "exclude") { await api("POST", "/clips/" + S.cid + "/state", { excluded: S.cv.clip.status !== "excluded" }); await refreshProject(); renderRight(); }
  }

  /* ---------- привязка к рабочей области ---------- */
  async function onClick(ev) {
    var a = ev.target.closest("[data-act]"); if (!a) return; var act = a.dataset.act, id = a.dataset.id; if (a.tagName === "A") ev.preventDefault();
    try {
      if (act === "play") { var vd = $("#vsvid"); if (vd) { if (vd.paused) vd.play(); else vd.pause(); } } else if (act === "replay") { seekOut(0); var v2 = $("#vsvid"); if (v2) v2.play(); }
      else if (act === "tl") { var d = a.dataset.d; setTl(d[0], (d[0] === "s" ? S.tl.s : S.tl.e) + (d[1] === "+" ? 0.1 : -0.1)); } else if (act === "range-apply") await applyRange(); else if (act === "win-extend") await extendWindow();
      else if (act === "save") await saveAll(); else if (act === "watch") VS.watchClip(S.cid, S.cv.clip.title || S.cv.clip.hook); else if (act === "hist") VS.clipHistory(S.cid, S.cv.clip.title || S.cv.clip.hook); else if (act === "tg-dispatch") { await flush(); VS.tgDispatch([S.cid]); }
      else if (act === "cap-del") { queue({ op: "set_caption", text: "", enabled: false }); renderRight(); } else if (act === "cap-reset") queue({ op: "reset_caption" });
      else if (act === "download") await downloadClip(S.cid);
      else if (act === "tg-send") await sendTg(S.cid, !!(a.dataset.force || (S.cv.clip.telegram && ["sent", "sent_link"].indexOf(S.cv.clip.telegram.status) >= 0)), !!a.dataset.reupload);
      else if (["del", "restore", "emph", "brk", "join", "confirm", "suggest", "add", "rewrite", "hook-reset", "hooks", "fr-reset", "preview", "render", "exclude"].indexOf(act) >= 0) await editAction(act, id, a);
    } catch (e) { toast(errText(e), true); }
  }
  function beforeUnload(e) { if (dirtyAny()) { e.preventDefault(); e.returnValue = ""; } }
  VS.editor = {
    mount: function (container, c) { this.unmount(); ctx = c || {}; S.project = ctx.project; S.clips = ctx.clips || []; root = container; rafStop = false; root.addEventListener("click", onClick); root.addEventListener("input", onInput); root.addEventListener("change", onChange); window.addEventListener("resize", scaleStage); window.addEventListener("beforeunload", beforeUnload); },
    setContext: function (c) { ctx = c || ctx; S.project = ctx.project; S.clips = ctx.clips || S.clips; },
    open: function (id) { return openClip(id); },
    unmount: function () { if (!root) return; if (S.cv && dirtyAny()) { var did = S.cid, wf0 = Object.assign({}, S.wf), d0 = Object.assign({}, S.wfDirty); flush().then(function () { return persistWorkflow(did, wf0, d0); }).then(function () { toast("Несохранённые изменения клипа сохранены автоматически"); }).catch(function (e) { toast("Не удалось сохранить изменения: " + errText(e), true); }); } rafStop = true; cancelAnimationFrame(rafId); root.removeEventListener("click", onClick); root.removeEventListener("input", onInput); root.removeEventListener("change", onChange); window.removeEventListener("resize", scaleStage); window.removeEventListener("beforeunload", beforeUnload); root = null; S.cv = null; S.cid = null; S.m = null; S.tl = null; S.media = {}; S.pending = []; }
  };
})();
