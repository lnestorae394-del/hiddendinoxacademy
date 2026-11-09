/* Daily Tests — страница ученика: «Сегодня» (5 заданий, таймер до 00:00 по Берлину) и «Пройденные». */
(function () {
  let LANG = "ru"; try { const x = localStorage.getItem("hd_lang"); if (["ru", "en", "ua"].includes(x)) LANG = x; } catch (e) {}
  document.documentElement.lang = LANG === "ua" ? "uk" : LANG;
  const S = {
    ru: { today: "Сегодня", done: "Пройденные", title: "Ежедневные тесты", next: "Новые тесты через", nextDate: "Следующий набор", progress: "Пройдено {d} из {t}",
      st_new: "Новое", st_in_progress: "В процессе", st_ok: "Верно", st_no: "Неверно", start: "Начать", cont: "Продолжить", review: "Разбор", answer: "Ответить",
      right: "Верно!", wrong: "Неверно.", correctIs: "Правильный ответ:", why: "Объяснение", repeat: "Повторить урок", back: "К заданиям", toLearn: "Открыть обучение",
      time: "Время", updating: "Обновляем тесты… Проверим ещё раз через минуту.", empty: "Пока нет пройденных заданий.", unfinished: "Незавершённые задания прошлых дней",
      pass: "Пройти", choose: "Выберите вариант ответа.", NO_ACCESS: "Раздел откроется после подтверждения первого депозита.", FEATURE_UNAVAILABLE: "Раздел пока недоступен.",
      NETWORK: "Нет связи с сервером. Попробуйте ещё раз.", generic: "Не удалось загрузить. Попробуйте позже.", retry: "Повторить", sec: "с", min: "мин", course: { hr: "HR", smc: "SMC", rm: "RM" }, kind: { choice: "Выбор ответа", situation: "Ситуация", term: "Термин", error: "Найди ошибку", chart: "Вопрос по графику" } },
    en: { today: "Today", done: "Completed", title: "Daily Tests", next: "New tests in", nextDate: "Next set", progress: "Completed {d} of {t}",
      st_new: "New", st_in_progress: "In progress", st_ok: "Correct", st_no: "Incorrect", start: "Start", cont: "Continue", review: "Review", answer: "Answer",
      right: "Correct!", wrong: "Incorrect.", correctIs: "Correct answer:", why: "Explanation", repeat: "Review the lesson", back: "Back to tasks", toLearn: "Open learning",
      time: "Time", updating: "Updating the tests… We'll check again in a minute.", empty: "No completed tasks yet.", unfinished: "Unfinished tasks from previous days",
      pass: "Take", choose: "Choose an answer.", NO_ACCESS: "This section opens after your first deposit is confirmed.", FEATURE_UNAVAILABLE: "This section is not available yet.",
      NETWORK: "No connection to the server. Please try again.", generic: "Could not load. Please try later.", retry: "Retry", sec: "s", min: "min", course: { hr: "HR", smc: "SMC", rm: "RM" }, kind: { choice: "Multiple choice", situation: "Scenario", term: "Term", error: "Find the error", chart: "Chart question" } },
    ua: { today: "Сьогодні", done: "Пройдені", title: "Щоденні тести", next: "Нові тести через", nextDate: "Наступний набір", progress: "Пройдено {d} з {t}",
      st_new: "Нове", st_in_progress: "У процесі", st_ok: "Правильно", st_no: "Неправильно", start: "Почати", cont: "Продовжити", review: "Розбір", answer: "Відповісти",
      right: "Правильно!", wrong: "Неправильно.", correctIs: "Правильна відповідь:", why: "Пояснення", repeat: "Повторити урок", back: "До завдань", toLearn: "Відкрити навчання",
      time: "Час", updating: "Оновлюємо тести… Перевіримо ще раз за хвилину.", empty: "Поки немає пройдених завдань.", unfinished: "Незавершені завдання попередніх днів",
      pass: "Пройти", choose: "Оберіть варіант відповіді.", NO_ACCESS: "Розділ відкриється після підтвердження першого депозиту.", FEATURE_UNAVAILABLE: "Розділ поки недоступний.",
      NETWORK: "Немає зв’язку із сервером. Спробуйте ще раз.", generic: "Не вдалося завантажити. Спробуйте пізніше.", retry: "Повторити", sec: "с", min: "хв", course: { hr: "HR", smc: "SMC", rm: "RM" }, kind: { choice: "Вибір відповіді", situation: "Ситуація", term: "Термін", error: "Знайди помилку", chart: "Питання про графік" } }
  };
  const s = (k, v) => { let x = S[LANG][k] || S.ru[k] || k; if (v) for (const [a, b] of Object.entries(v)) x = x.split("{" + a + "}").join(String(b)); return x; };
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const main = document.getElementById("lp");
  document.title = s("title") + " — HIDDEN DINOX ACADEMY"; { const c = document.getElementById("crumb"); if (c) c.textContent = s("title"); }
  { const bk = document.getElementById("back"); if (bk) bk.textContent = "← " + ({ ru: "Академия", en: "Academy", ua: "Академія" })[LANG]; }
  const show = h => { main.innerHTML = h; };
  const dateFmt = key => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(LANG === "en" ? "en-GB" : LANG === "ua" ? "uk-UA" : "ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); };
  const dur = ms => { const t = Math.max(0, Math.round((ms || 0) / 1000)); return t >= 60 ? `${Math.floor(t / 60)} ${s("min")} ${t % 60} ${s("sec")}` : `${t} ${s("sec")}`; };
  let data = null, offset = 0, timer = null, retryT = null, picked = null;
  function fail(e) {
    if (e && e.code === "UNAUTHENTICATED") return location.replace("/");
    if (e && e.code === "NO_ACCESS") return location.replace("academy.html");
    const code = e && ["FEATURE_UNAVAILABLE", "NETWORK"].includes(e.code) ? e.code : "generic";
    show(`<h1>${esc(s("title"))}</h1><p class="lp-err" id="dtErr">${esc(s(code))}</p><div class="lp-foot"><a class="lp-btn" href="academy.html">←</a>${code !== "FEATURE_UNAVAILABLE" ? `<button class="lp-btn primary" id="dtRetry">${esc(s("retry"))}</button>` : ""}</div>`);
    const r = document.getElementById("dtRetry"); if (r) r.onclick = () => load();
  }
  const tabs = cur => `<div class="dt-tabs" role="tablist"><button class="dt-tab" role="tab" aria-selected="${cur === "today"}" data-tab="today">${esc(s("today"))}</button><button class="dt-tab" role="tab" aria-selected="${cur === "done"}" data-tab="done">${esc(s("done"))}</button></div>`;
  function bindTabs() { main.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { location.hash = b.dataset.tab; }); }
  function tick() {
    const el = document.getElementById("dtLeft"); if (!el || !data) return;
    const left = data.next_reset_at - (Date.now() + offset);
    if (left <= 0) { clearInterval(timer); setTimeout(load, 1500); el.textContent = "00:00:00"; return; }
    const h = Math.floor(left / 3600e3), m = Math.floor(left / 60e3) % 60, sec = Math.floor(left / 1e3) % 60;
    el.textContent = [h, m, sec].map(n => String(n).padStart(2, "0")).join(":");
  }
  const kindLabel = k => (S[LANG].kind || S.ru.kind)[k] || (S.ru.kind[k] || S.ru.kind.choice);
  const stLabel = t => t.status === "done" ? (t.result && t.result.ok ? ["ok", s("st_ok")] : ["no", s("st_no")]) : t.status === "in_progress" ? ["prog", s("st_in_progress")] : ["new", s("st_new")];
  function renderToday() {
    clearInterval(timer);
    if (data.status === "updating") { show(`${tabs("today")}<h1>${esc(s("title"))}</h1><p class="lp-muted" id="dtUpdating">${esc(s("updating"))}</p>`); bindTabs(); clearTimeout(retryT); retryT = setTimeout(load, 60000); return; }
    const done = data.tasks.filter(t => t.status === "done").length;
    show(`${tabs("today")}<div class="dt-head"><h1 style="margin:0">${esc(s("title"))} · ${esc(dateFmt(data.date))}</h1>
      <div class="dt-timer" role="timer">${esc(s("next"))} <b id="dtLeft">--:--:--</b><br><small>${esc(s("nextDate"))}: ${esc(dateFmt(data.next_date))}</small></div></div>
      <p id="dtProgress">${esc(s("progress", { d: done, t: data.tasks.length }))}</p><div class="dt-bar"><i style="width:${data.tasks.length ? Math.round(done * 100 / data.tasks.length) : 0}%"></i></div>
      <div class="dt-list">${data.tasks.map(t => { const [cls, lbl] = stLabel(t); return `<div class="dt-task" data-task="${esc(t.id)}"><span class="dt-c">${esc(s("course")[t.course] || t.course)}</span>
        <div class="dt-t"><b>${esc(t.title)}</b><small>${esc(t.topic)} · <span class="dt-kind">${esc(kindLabel(t.kind))}</span></small></div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end"><span class="dt-st ${cls}">${esc(lbl)}</span><a class="lp-btn ${t.status === "done" ? "" : "primary"}" href="#task/${esc(data.date)}/${esc(t.id)}">${esc(t.status === "done" ? s("review") : t.status === "in_progress" ? s("cont") : s("start"))}</a></div></div>`; }).join("")}</div>`);
    bindTabs(); tick(); timer = setInterval(tick, 1000);
  }
  async function renderTask(date, qid) {
    clearInterval(timer);
    if (!data) { const r = await call("GET", "/api/daily/today?lang=" + LANG); offset = r.server_now - Date.now(); data = r; }   // прямая ссылка / «Назад» в браузере
    let t = data && data.date === date ? data.tasks.find(x => x.id === qid) : null, rev = null;
    if (!t || (t.status === "done")) {   // разбор пройденного или задание прошлого дня
      const h = await call("GET", "/api/daily/history?lang=" + LANG); rev = h.done.find(x => x.id === qid && x.date === date);
      const un = h.unfinished.find(x => x.id === qid && x.date === date);
      if (!rev && !un && !t) return location.hash = "today";
      if (!t && !rev) { const set = await call("GET", "/api/daily/today?lang=" + LANG); t = set.tasks.find(x => x.id === qid) || null; }
    }
    if (rev) return showReview(rev, date);
    if (!t) { // задание прошлого дня без текста в «Сегодня» — берём из истории (ответить можно)
      const h = await call("GET", "/api/daily/history?lang=" + LANG); const un = h.unfinished.find(x => x.id === qid && x.date === date);
      if (!un) return location.hash = "today"; t = { ...un, q: null };
    }
    if (!t.q) { const full = await call("GET", "/api/daily/task?lang=" + LANG + "&date=" + encodeURIComponent(date) + "&qid=" + encodeURIComponent(qid)); t = { ...t, ...full }; }
    try { await call("POST", "/api/daily/start", { date, qid }); } catch (e) {}
    picked = null;
    show(`${tabs("today")}<p><span class="dt-c">${esc(s("course")[t.course] || t.course)}</span> <small class="lp-muted">${esc(t.topic)} · ${esc(t.title)}</small></p>
      <p><span class="dt-kind">${esc(kindLabel(t.kind))}</span></p>${t.chart_image && /^\/media\/med_[a-f0-9]{20}$/.test(t.chart_image) ? `<img class="dt-chart-image" src="${esc(t.chart_image)}" alt="Учебный график" loading="lazy">` : ""}<p class="dt-q" id="dtQ">${esc(t.q)}</p><div class="dt-opts">${t.options.map((o, i) => `<button class="dt-opt" type="button" aria-pressed="false" data-opt="${i}">${esc(o)}</button>`).join("")}</div>
      <p class="lp-err" id="dtChoose" hidden>${esc(s("choose"))}</p>
      <div class="lp-foot"><a class="lp-btn" href="#today">${esc(s("back"))}</a><button class="lp-btn primary" id="dtAnswer">${esc(s("answer"))}</button></div>`);
    bindTabs();
    main.querySelectorAll("[data-opt]").forEach(b => b.onclick = () => { picked = Number(b.dataset.opt); main.querySelectorAll("[data-opt]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); document.getElementById("dtChoose").hidden = true; });
    document.getElementById("dtAnswer").onclick = async e => {
      if (picked == null) { document.getElementById("dtChoose").hidden = false; return; }
      e.target.disabled = true;
      try { const r = await call("POST", "/api/daily/answer?lang=" + LANG, { date, qid, answer: picked }); showReview(r, date);
        call("GET", "/api/daily/today?lang=" + LANG).then(x => { data = x; offset = x.server_now - Date.now(); }).catch(() => { data = null; }); }   // статусы обновляются в фоне
      catch (err) { e.target.disabled = false; const c = document.getElementById("dtChoose"); c.textContent = s(err && err.code === "NETWORK" ? "NETWORK" : "generic"); c.hidden = false; }
    };
  }
  function showReview(r, date) {
    show(`${tabs("today")}<p><span class="dt-kind">${esc(kindLabel(r.kind))}</span></p>${r.chart_image && /^\/media\/med_[a-f0-9]{20}$/.test(r.chart_image) ? `<img class="dt-chart-image" src="${esc(r.chart_image)}" alt="Учебный график" loading="lazy">` : ""}<p class="dt-q">${esc(r.q)}</p><div class="dt-opts">${r.options.map((o, i) => `<button class="dt-opt ${i === r.correct_index ? "right" : i === r.answer ? "wrong" : ""}" type="button" disabled>${esc(o)}</button>`).join("")}</div>
      <div class="dt-res ${r.correct ? "ok" : "no"}" id="dtResult"><b>${esc(r.correct ? s("right") : s("wrong"))}</b>${r.correct ? "" : ` ${esc(s("correctIs"))} ${esc(r.options[r.correct_index])}`}</div>
      ${r.explanation ? `<p><b>${esc(s("why"))}:</b> <span id="dtWhy">${esc(r.explanation)}</span></p>` : ""}
      <p class="lp-muted">${esc(s("repeat"))}: ${esc(r.lesson.module_title)} → ${esc(r.lesson.lesson_title)} · ${esc(s("time"))}: ${esc(dur(r.time_ms))}</p>
      <div class="lp-foot"><a class="lp-btn" href="#today">${esc(s("back"))}</a><a class="lp-btn" href="learn.html">${esc(s("toLearn"))}</a></div>`);
    bindTabs();
  }
  async function renderDone() {
    clearInterval(timer);
    const h = await call("GET", "/api/daily/history?lang=" + LANG);
    show(`${tabs("done")}<h1>${esc(s("done"))}</h1>${h.done.length ? `<div class="dt-list" id="dtDone">${h.done.map(r => `<div class="dt-task" data-done="${esc(r.id)}"><span class="dt-c">${esc(s("course")[r.course] || r.course)}</span>
      <div class="dt-t"><b>${esc(r.lesson.lesson_title)}</b><small>${esc(dateFmt(r.date))} · ${esc(kindLabel(r.kind))} · ${esc(s("time"))}: ${esc(dur(r.time_ms))}</small></div>
      <div style="display:flex;gap:10px;align-items:center"><span class="dt-st ${r.correct ? "ok" : "no"}">${esc(r.correct ? s("st_ok") : s("st_no"))}</span><a class="lp-btn" href="#task/${esc(r.date)}/${esc(r.id)}">${esc(s("review"))}</a></div></div>`).join("")}</div>`
      : `<p class="lp-muted" id="dtEmpty">${esc(s("empty"))}</p>`}
      ${h.unfinished.length ? `<h2 class="dt-sub">${esc(s("unfinished"))}</h2><div class="dt-list" id="dtUnfinished">${h.unfinished.map(u => `<div class="dt-task"><span class="dt-c">${esc(s("course")[u.course] || u.course)}</span>
        <div class="dt-t"><b>${esc(u.title)}</b><small>${esc(dateFmt(u.date))} · ${esc(u.topic)}</small></div><a class="lp-btn" href="#task/${esc(u.date)}/${esc(u.id)}">${esc(s("pass"))}</a></div>`).join("")}</div>` : ""}`);
    bindTabs();
  }
  async function load() {
    clearTimeout(retryT);
    try { const r = await call("GET", "/api/daily/today?lang=" + LANG); offset = r.server_now - Date.now(); data = r; route(); } catch (e) { fail(e); }
  }
  async function route() {
    const h = location.hash.replace(/^#/, "");
    try {
      if (h.startsWith("task/")) { const [, date, qid] = h.split("/"); return await renderTask(date, qid); }
      if (h === "done") return await renderDone();
      if (!data) return load();
      renderToday();
    } catch (e) { fail(e); }
  }
  window.addEventListener("hashchange", route);
  document.querySelectorAll(".lp-langs [data-lang]").forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.lang === LANG));
    b.onclick = () => { LANG = b.dataset.lang; try { localStorage.setItem("hd_lang", LANG); } catch (e) {} location.reload(); }; });
  (async () => { try { const f = await fb(); if (!f.auth.currentUser) return location.replace("/"); } catch (e) { return fail({ code: "NETWORK" }); } load(); })();
})();
