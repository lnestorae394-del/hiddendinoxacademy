/* Разделы «Медиатека» и «Шаблоны» + общая форма настройки оформления (используется и в «Настройках → Оформление»).
   Файлы остаются в приватном хранилище; здесь — метаданные из Firestore и короткоживущие ссылки. */
(function () {
  "use strict";
  var VS = window.VS, $ = VS.$, $$ = VS.$$, esc = VS.esc;
  var GROUPS = {
    subtitles: ["Субтитры", [["subtitles", "size", "Размер текста", "n"], ["subtitles", "y", "Положение по вертикали, px", "n"], ["subtitles", "max_words", "Слов в блоке", "n"], ["subtitles", "max_chars", "Символов в блоке", "n"], ["subtitles", "outline", "Обводка", "n"]]],
    hook: ["Хук", [["hook", "size", "Размер текста", "n"], ["hook", "y", "Положение (верх), px", "n"], ["hook", "show_seconds", "Секунд на экране", "n"], ["hook", "outline", "Обводка", "n"]]],
    window: ["Видео в кадре", [["window", "y", "Верх окна, px", "n"], ["window", "h", "Высота окна, px", "n"], ["window", "crop_y", "Сдвиг кадра по вертикали (вертикальные исходники), px", "n"]]],
    quality: ["Качество экспорта", [["quality", "crf", "CRF (меньше — лучше качество, больше файл)", "n"], ["quality", "preset", "Скорость кодирования", "s", ["ultrafast", "veryfast", "faster", "fast", "medium", "slow"]]]],
    colors: ["Цвета", [["colors", "accent", "Фирменный цвет", "c"], ["colors", "text", "Цвет текста", "c"], ["colors", "outline", "Цвет обводки", "c"]]],
    brand: ["Шапка, призыв, полоса", [["brand", "text", "Текст шапки", "t"], ["brand", "size", "Размер шапки", "n"], ["cta", "enabled", "Показывать призыв в конце", "b"], ["cta", "text", "Текст призыва", "t"], ["cta", "size", "Размер призыва", "n"], ["bar", "enabled", "Полоса прогресса", "b"]]],
    logo: ["Положение логотипа", [["logo", "enabled", "Показывать логотип", "b"], ["logo", "x", "X, px", "n"], ["logo", "y", "Y, px", "n"], ["logo", "w", "Ширина, px", "n"]]]
  };
  VS.TPL_GROUPS = GROUPS;
  /* форма: groups — ключи GROUPS; tpl — текущее оформление */
  VS.tplForm = function (names, tpl, extraHtml) {
    return names.map(function (n) { var g = GROUPS[n]; return '<div class="vs-fgroup"><h4>' + esc(g[0]) + '</h4><div class="vs-form">' + g[1].map(function (f) {
      var val = (tpl[f[0]] || {})[f[1]], id = "tp-" + f[0] + "-" + f[1], dt = ' data-tp="' + f[0] + "." + f[1] + '" id="' + id + '"';
      if (f[3] === "b") return '<label class="chk"><input type="checkbox"' + dt + (val ? " checked" : "") + "> " + esc(f[2]) + "</label>";
      if (f[3] === "s") return "<label>" + esc(f[2]) + "<select" + dt + ">" + f[4].map(function (o) { return '<option value="' + o + '"' + (o === val ? " selected" : "") + ">" + o + "</option>"; }).join("") + "</select></label>";
      return "<label>" + esc(f[2]) + "<input" + dt + ' type="' + (f[3] === "c" ? "color" : f[3] === "n" ? "number" : "text") + '" value="' + esc(val) + '"></label>';
    }).join("") + (n === "logo" && extraHtml ? extraHtml : "") + "</div></div>"; }).join("");
  };
  VS.tplCollect = function (root) { var patch = {}; $$("[data-tp]", root).forEach(function (el) { if (el.type !== "checkbox" && el.value === "") return; var p = el.dataset.tp.split("."), v = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value; (patch[p[0]] = patch[p[0]] || {})[p[1]] = v; }); return patch; };
  VS.saveTemplate = async function (patch, okText) { try { await VS.api("PUT", "/settings", { template: patch }); VS.toast(okText || "Оформление сохранено", "ok"); return true; } catch (e) { VS.toast((e.field ? e.field + ": " : "") + VS.errText(e), "bad"); return false; } };
  /* ---------- Шаблоны ---------- */
  VS.views.templates = {
    title: "Шаблоны оформления",
    mount: function (el) {
      el.innerHTML = '<div class="vs-card"><div class="vs-card-h"><h3>Сохранённые шаблоны</h3></div><p class="vs-small vs-muted">Шаблон — набор настроек оформления (субтитры, хук, цвета, логотип, качество). «Применить» делает его оформлением по умолчанию для новых сборок; клипы, собранные раньше, получат пометку «устарел».</p><div class="vs-inline"><input id="tp-name" maxlength="40" placeholder="Название нового шаблона" aria-label="Название шаблона"><button class="vs-btn primary" id="tp-save">' + VS.icon("plus", 15) + ' Сохранить текущее оформление как шаблон</button></div><div id="tp-list"></div></div><div class="vs-card"><div class="vs-card-h"><h3>Текущее оформление: субтитры, хук, кадр, качество</h3></div><div id="tp-form"></div></div>';
      var pl = VS.section($("#tp-list", el), { title: "Шаблоны", load: function () { return VS.api("GET", "/presets"); }, render: function (d, box) {
        box.innerHTML = d.presets.length ? '<div class="vs-presets">' + d.presets.map(function (p) { return '<div class="vs-preset"><div><b>' + esc(p.name) + '</b><div class="vs-small vs-muted">' + VS.dt(p.created_at) + " · " + esc(p.by || "") + '</div></div><div><button class="vs-btn sm" data-ap="' + esc(p.id) + '">Применить</button><button class="vs-btn sm ghost danger" data-dp="' + esc(p.id) + '" aria-label="Удалить шаблон">' + VS.icon("trash", 14) + "</button></div></div>"; }).join("") + "</div>" : '<div class="vs-empty-s">Шаблонов пока нет. Настройте оформление ниже и сохраните его.</div>';
      } });
      var fm = VS.section($("#tp-form", el), { title: "Оформление", load: function () { return VS.api("GET", "/settings"); }, render: function (s, box) { box.innerHTML = VS.tplForm(["subtitles", "hook", "window", "quality"], s.template) + '<div class="vs-row"><button class="vs-btn primary" id="tp-apply">Сохранить оформление</button><button class="vs-btn danger" id="tp-reset">Вернуть стандартное</button></div>'; $("#tp-apply", box).onclick = async function () { if (await VS.saveTemplate(VS.tplCollect(box))) fm.reload(true); }; $("#tp-reset", box).onclick = async function () { if (!(await VS.confirm("Вернуть стандартное оформление?", "Все текущие настройки оформления будут сброшены к стандартным Hidden Dinox.", { danger: true, okLabel: "Сбросить" }))) return; try { await VS.api("POST", "/settings/template/reset"); VS.toast("Стандартное оформление возвращено", "ok"); fm.reload(true); } catch (e) { VS.toast(VS.errText(e), "bad"); } }; } });
      $("#tp-save", el).onclick = async function () { var n = $("#tp-name", el).value.trim(); if (!n) return VS.toast("Введите название шаблона", "bad"); try { await VS.api("POST", "/presets", { name: n }); $("#tp-name", el).value = ""; VS.toast("Шаблон сохранён", "ok"); pl.reload(true); } catch (e) { VS.toast(VS.errText(e), "bad"); } };
      $("#tp-list", el).addEventListener("click", async function (e) { var a = e.target.closest("[data-ap]"), d = e.target.closest("[data-dp]"); try { if (a) { await VS.api("POST", "/presets/" + a.dataset.ap + "/apply"); VS.toast("Шаблон применён", "ok"); fm.reload(true); } if (d && (await VS.confirm("Удалить шаблон?", "Сам шаблон будет удалён; текущее оформление не изменится.", { danger: true, okLabel: "Удалить" }))) { await VS.api("DELETE", "/presets/" + d.dataset.dp); VS.toast("Шаблон удалён", "ok"); pl.reload(true); } } catch (er) { VS.toast(VS.errText(er), "bad"); } });
    }
  };
  /* ---------- Медиатека ---------- */
  var K = "", Q = "", KINDS = [["", "Все"], ["source", "Исходные записи"], ["export", "Готовые ролики"], ["logo", "Логотипы"], ["template", "Шаблоны"]];
  VS.views.media = {
    title: "Медиатека",
    mount: function (el) {
      el.innerHTML = '<div class="vs-toolbar"><div class="vs-search">' + VS.icon("search", 16) + '<input id="m-q" type="search" placeholder="Поиск по названию" value="' + esc(Q) + '" aria-label="Поиск"></div><div class="vs-seg" id="m-k"></div></div><div id="m-body"></div>'; var data = null, custom = null;
      function paint() {
        var qq = Q.toLowerCase(), list = data.items.filter(function (i) { return (!K || i.kind === K) && (!qq || String(i.title).toLowerCase().indexOf(qq) >= 0); });
        $("#m-k", el).innerHTML = KINDS.map(function (k) { return '<button data-k="' + k[0] + '" class="' + (K === k[0] ? "on" : "") + '">' + k[1] + " <em>" + (k[0] ? data.counts[k[0]] || 0 : data.total) + "</em></button>"; }).join("");
        $("#m-list", el).innerHTML = list.length ? '<div class="vs-mgrid">' + list.map(card).join("") + "</div>" : '<div class="vs-empty"><h3>Ничего не найдено</h3><p>В медиатеке пока нет файлов этого типа.</p></div>'; VS.loadThumbs($("#m-list", el));
      }
      function card(i) {
        var pv = i.kind === "export" ? '<div class="vs-cover" data-cover="' + (i.has_thumb ? esc(i.clip_id) : "") + '">' + (i.has_thumb ? "" : VS.icon("film", 26)) + "</div>" : i.kind === "logo" ? '<div class="vs-cover logo">' + (i.source === "custom" ? (custom ? '<img alt="" src="' + esc(custom) + '">' : VS.icon("media", 26)) : '<img alt="" src="/academy/assets/brand/' + esc(String(i.source).replace("brand:", "")) + '">') + "</div>" : '<div class="vs-cover">' + VS.icon(i.kind === "template" ? "templates" : "film", 26) + "</div>";
        var meta = i.kind === "export" ? VS.dur(i.duration) + " · " + VS.bytes(i.size) + " · " + VS.dt(i.created_at) : i.kind === "source" ? VS.bytes(i.size) + (i.duration ? " · " + VS.dur(i.duration) : "") + " · " + VS.dt(i.created_at) : i.kind === "logo" ? "PNG · " + VS.bytes(i.size) : "Шаблон оформления · " + VS.dt(i.created_at);
        var act = i.kind === "export" ? '<button class="vs-btn sm" data-m-dl="' + esc(i.clip_id) + '">' + VS.icon("download", 14) + '</button><a class="vs-btn sm" href="#/projects/' + esc(i.project_id) + "/" + esc(i.clip_id) + '">Открыть</a><button class="vs-btn sm ghost danger" data-m-del="' + esc(i.clip_id) + '" aria-label="Удалить файл">' + VS.icon("trash", 14) + "</button>" : i.kind === "source" ? '<a class="vs-btn sm" href="#/projects/' + esc(i.project_id) + '">Открыть проект</a>' : i.kind === "logo" ? '<a class="vs-btn sm" href="#/settings/branding">Брендинг</a>' : '<a class="vs-btn sm" href="#/templates">Шаблоны</a>';
        return '<article class="vs-mcard">' + pv + '<div class="vs-mcard-b"><div class="vs-mk">' + esc(({ source: "Исходник", export: "Готовый ролик", logo: "Логотип", template: "Шаблон" })[i.kind]) + '</div><b title="' + esc(i.title) + '">' + esc(i.title) + '</b><span class="vs-small vs-muted">' + meta + '</span><div class="vs-pcard-a">' + act + "</div></div></article>";
      }
      var sec = VS.section($("#m-body", el), { title: "Медиатека", load: async function () { var d = await VS.api("GET", "/media"), l = null; if (d.items.some(function (i) { return i.source === "custom"; })) { try { l = (await VS.api("GET", "/logo")).custom_url; } catch (e) { l = null; } } custom = l; return d; }, render: function (d, box) { data = d; box.innerHTML = '<div id="m-list"></div>'; paint(); } });
      $("#m-q", el).oninput = function (e) { Q = e.target.value; if (data) paint(); }; el.addEventListener("click", async function (e) { var k = e.target.closest("[data-k]"), dl = e.target.closest("[data-m-dl]"), del = e.target.closest("[data-m-del]"); if (k && data) { K = k.dataset.k; paint(); } if (dl) VS.downloadClip(dl.dataset.mDl); if (del) { if (!(await VS.confirm("Удалить готовый ролик?", "Файл будет удалён из хранилища. Клип останется в проекте, его можно собрать заново.", { danger: true, okLabel: "Удалить файл" }))) return; try { await VS.api("DELETE", "/clips/" + del.dataset.mDel + "/export"); VS.toast("Файл удалён", "ok"); sec.reload(true); } catch (er) { VS.toast(VS.errText(er), "bad"); } } });
    }
  };
})();
