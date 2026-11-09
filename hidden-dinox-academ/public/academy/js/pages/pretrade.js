/* Pre-Trade Routine — маршрут подготовки к сессии и итог (Session Summary). */
(function () {
  let LANG = "ru"; try { const x = localStorage.getItem("hd_lang"); if (["ru", "en", "ua"].includes(x)) LANG = x; } catch (e) {}
  document.documentElement.lang = LANG === "ua" ? "uk" : LANG;
  const S = {
    ru: { title: "Подготовка к торговой сессии", s_review: "Повторение", s_daily: "Ежедневные тесты", s_chart: "Тренировка на графике", s_sum: "Итог подготовки",
      st_done: "Готово", st_in_progress: "В процессе", st_pending: "Ожидает", st_unavailable: "Недоступен", recIntro: "Повторите темы, где были ошибки за последние 7 дней:",
      recNone: "Ошибок за последние дни нет — повторите последний пройденный урок курса.", openLearn: "Открыть обучение", reviewed: "Повторил материал",
      dailyLine: "Пройдено {d} из {t}, верно {c}", dailyNone: "Набор на сегодня ещё не готов.", openDaily: "Открыть ежедневные тесты", chartLine: "Разборов сегодня: {n}, средний балл: {a}/100",
      chartNone: "Сегодня разборов ещё не было.", openChart: "Открыть тренировку", unav: "Раздел сейчас недоступен — этап можно пропустить.",
      tests: "Тесты", practice: "Практика", mistakes: "Основные ошибки", rec: "Рекомендуемые уроки", last: "Последняя завершённая подготовка", none: "—",
      testsVal: "{c} верно из {t}", practiceVal: "{n} разбор(а), средний балл {a}/100", complete: "Завершить подготовку", completed: "Подготовка на сегодня завершена",
      notReady: "Завершить можно после доступных этапов.", module: "модуль", course: { "smart-money-concepts-binary": "Smart Money Concepts", "risk-management-binary": "Risk Management", "hidden-reaction-system": "Hidden Reaction" },
      f_structure: "структура", f_liquidity_sweep: "снятие ликвидности", f_bos_mss: "BOS / MSS", f_fvg: "FVG", f_premium_discount: "Premium / Discount", f_no_confirmation: "нет подтверждения",
      disclaimer: "Подготовка помогает повторить правила и потренироваться. Она не гарантирует прибыль и не означает готовность к реальной торговле.",
      NO_ACCESS: "Раздел откроется после подтверждения первого депозита.", FEATURE_UNAVAILABLE: "Раздел пока недоступен.", NETWORK: "Нет связи с сервером. Попробуйте ещё раз.", generic: "Не удалось загрузить. Попробуйте позже.", retry: "Повторить" },
    en: { title: "Pre-Trade Routine", s_review: "Review", s_daily: "Daily Tests", s_chart: "Chart Training", s_sum: "Preparation summary",
      st_done: "Done", st_in_progress: "In progress", st_pending: "Pending", st_unavailable: "Unavailable", recIntro: "Review the topics where you made mistakes in the last 7 days:",
      recNone: "No mistakes in recent days — review the last lesson you completed.", openLearn: "Open learning", reviewed: "I have reviewed the material",
      dailyLine: "Completed {d} of {t}, correct {c}", dailyNone: "Today's set is not ready yet.", openDaily: "Open Daily Tests", chartLine: "Reviews today: {n}, average score: {a}/100",
      chartNone: "No reviews today yet.", openChart: "Open Chart Training", unav: "This section is not available now — the step can be skipped.",
      tests: "Tests", practice: "Practice", mistakes: "Main mistakes", rec: "Recommended lessons", last: "Last completed preparation", none: "—",
      testsVal: "{c} correct of {t}", practiceVal: "{n} review(s), average score {a}/100", complete: "Complete preparation", completed: "Today's preparation is complete",
      notReady: "You can complete it after the available steps.", module: "module", course: { "smart-money-concepts-binary": "Smart Money Concepts", "risk-management-binary": "Risk Management", "hidden-reaction-system": "Hidden Reaction" },
      f_structure: "structure", f_liquidity_sweep: "liquidity sweep", f_bos_mss: "BOS / MSS", f_fvg: "FVG", f_premium_discount: "Premium / Discount", f_no_confirmation: "no confirmation",
      disclaimer: "Preparation helps you review the rules and practise. It does not guarantee profit or mean you are ready for real trading.",
      NO_ACCESS: "This section opens after your first deposit is confirmed.", FEATURE_UNAVAILABLE: "This section is not available yet.", NETWORK: "No connection to the server. Please try again.", generic: "Could not load. Please try later.", retry: "Retry" },
    ua: { title: "Підготовка до торгової сесії", s_review: "Повторення", s_daily: "Щоденні тести", s_chart: "Тренування на графіку", s_sum: "Підсумок підготовки",
      st_done: "Готово", st_in_progress: "У процесі", st_pending: "Очікує", st_unavailable: "Недоступно", recIntro: "Повторіть теми, де були помилки за останні 7 днів:",
      recNone: "Помилок за останні дні немає — повторіть останній пройдений урок курсу.", openLearn: "Відкрити навчання", reviewed: "Повторив матеріал",
      dailyLine: "Пройдено {d} з {t}, правильно {c}", dailyNone: "Набір на сьогодні ще не готовий.", openDaily: "Відкрити щоденні тести", chartLine: "Розборів сьогодні: {n}, середній бал: {a}/100",
      chartNone: "Сьогодні розборів ще не було.", openChart: "Відкрити тренування", unav: "Розділ зараз недоступний — етап можна пропустити.",
      tests: "Тести", practice: "Практика", mistakes: "Основні помилки", rec: "Рекомендовані уроки", last: "Остання завершена підготовка", none: "—",
      testsVal: "{c} правильно з {t}", practiceVal: "{n} розбір(и), середній бал {a}/100", complete: "Завершити підготовку", completed: "Підготовку на сьогодні завершено",
      notReady: "Завершити можна після доступних етапів.", module: "модуль", course: { "smart-money-concepts-binary": "Smart Money Concepts", "risk-management-binary": "Risk Management", "hidden-reaction-system": "Hidden Reaction" },
      f_structure: "структура", f_liquidity_sweep: "зняття ліквідності", f_bos_mss: "BOS / MSS", f_fvg: "FVG", f_premium_discount: "Premium / Discount", f_no_confirmation: "немає підтвердження",
      disclaimer: "Підготовка допомагає повторити правила й потренуватися. Вона не гарантує прибутку й не означає готовності до реальної торгівлі.",
      NO_ACCESS: "Розділ відкриється після підтвердження першого депозиту.", FEATURE_UNAVAILABLE: "Розділ поки недоступний.", NETWORK: "Немає зв’язку із сервером. Спробуйте ще раз.", generic: "Не вдалося завантажити. Спробуйте пізніше.", retry: "Повторити" }
  };
  const s = (k, v) => { let x = S[LANG][k] != null ? S[LANG][k] : S.ru[k] != null ? S.ru[k] : k; if (v && typeof x === "string") for (const [a, b] of Object.entries(v)) x = x.split("{" + a + "}").join(String(b)); return x; };
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const main = document.getElementById("lp"); const show = h => { main.innerHTML = h; };
  document.title = s("title") + " — HIDDEN DINOX ACADEMY"; { const c = document.getElementById("crumb"); if (c) c.textContent = s("title"); }
  { const bk = document.getElementById("back"); if (bk) bk.textContent = "← " + ({ ru: "Академия", en: "Academy", ua: "Академія" })[LANG]; }
  const dateFmt = key => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(LANG === "en" ? "en-GB" : LANG === "ua" ? "uk-UA" : "ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); };
  const recLine = r => `${esc(s("course")[r.course_slug] || r.course_slug)} — ${esc(s("module"))} ${r.module_index + 1}${r.topic ? ": " + esc(r.topic) : ""}${r.lessons && r.lessons.length ? ` <small class="lp-muted">(${r.lessons.map(esc).join("; ")})</small>` : ""}`;
  function fail(e) {
    if (e && e.code === "UNAUTHENTICATED") return location.replace("/");
    if (e && e.code === "NO_ACCESS") return location.replace("academy.html");
    const code = e && ["FEATURE_UNAVAILABLE", "NETWORK"].includes(e.code) ? e.code : "generic";
    show(`<h1>${esc(s("title"))}</h1><p class="lp-err" id="ptErr">${esc(s(code))}</p><div class="lp-foot"><a class="lp-btn" href="academy.html">←</a>${code !== "FEATURE_UNAVAILABLE" ? `<button class="lp-btn primary" id="ptRetry">${esc(s("retry"))}</button>` : ""}</div>`);
    const r = document.getElementById("ptRetry"); if (r) r.onclick = () => load();
  }
  function render(d) {
    const [rv, dl, ch] = d.steps, st = x => `<span class="pt-st ${x.status}" data-st="${x.status}">${esc(s("st_" + x.status))}</span>`, sm = d.summary;
    const step = (n, key, x, body) => `<section class="pt-step ${x.status}" data-step="${key}"><div class="pt-n">${x.status === "done" ? "✓" : n}</div><div><div class="pt-h"><b>${esc(s("s_" + key))}</b>${st(x)}</div>${body}</div></section>`;
    show(`<h1>${esc(s("title"))} · ${esc(dateFmt(d.date))}</h1><div class="pt-steps">
      ${step(1, "review", rv, `<p>${rv.recommended.length ? esc(s("recIntro")) : esc(s("recNone"))}</p>${rv.recommended.length ? `<ul id="ptRec">${rv.recommended.map(r => `<li>${recLine(r)}</li>`).join("")}</ul>` : ""}
        <div class="pt-act"><a class="lp-btn" href="learn.html">${esc(s("openLearn"))}</a>${rv.status !== "done" ? `<button class="lp-btn primary" id="ptReviewed">${esc(s("reviewed"))}</button>` : ""}</div>`)}
      ${step(2, "daily", dl, dl.status === "unavailable" ? `<p>${esc(s("unav"))}</p>` : `<p id="ptDaily">${dl.total ? esc(s("dailyLine", { d: dl.done, t: dl.total, c: dl.correct })) : esc(s("dailyNone"))}</p><div class="pt-act"><a class="lp-btn ${dl.status === "done" ? "" : "primary"}" href="daily-tests.html">${esc(s("openDaily"))}</a></div>`)}
      ${step(3, "chart", ch, ch.status === "unavailable" ? `<p>${esc(s("unav"))}</p>` : `<p id="ptChart">${ch.sessions ? esc(s("chartLine", { n: ch.sessions, a: ch.avg_score })) : esc(s("chartNone"))}</p><div class="pt-act"><a class="lp-btn ${ch.status === "done" ? "" : "primary"}" href="chart-training.html">${esc(s("openChart"))}</a></div>`)}
      </div>
      <section class="pt-sum" id="ptSummary"><h2>4. ${esc(s("s_sum"))}</h2><div class="pt-grid">
        <div><small class="lp-muted">${esc(s("tests"))}</small><br><b id="ptTests">${sm.tests ? esc(s("testsVal", { c: sm.tests.correct, t: sm.tests.total })) : esc(s("none"))}</b></div>
        <div><small class="lp-muted">${esc(s("practice"))}</small><br><b id="ptPractice">${sm.practice ? esc(s("practiceVal", { n: sm.practice.sessions, a: sm.practice.avg_score })) : esc(s("none"))}</b></div>
        <div><small class="lp-muted">${esc(s("mistakes"))}</small><br><span id="ptMistakes">${sm.mistakes.topics.length || sm.mistakes.chart_factors.length ? [...sm.mistakes.topics.map(m => esc(m.topic) + (m.n > 1 ? ` ×${m.n}` : "")), ...sm.mistakes.chart_factors.map(m => esc(s("f_" + m.factor)))].join("; ") : esc(s("none"))}</span></div>
        <div><small class="lp-muted">${esc(s("last"))}</small><br><b id="ptLast">${sm.last_completed_date ? esc(dateFmt(sm.last_completed_date)) : esc(s("none"))}</b></div></div>
        ${sm.recommended.length ? `<p><small class="lp-muted">${esc(s("rec"))}</small></p><ul>${sm.recommended.map(r => `<li>${recLine(r)}</li>`).join("")}</ul>` : ""}
        ${d.completed ? `<span class="pt-done" id="ptCompleted">✓ ${esc(s("completed"))}</span>` : `<div class="pt-act"><button class="lp-btn primary" id="ptComplete" ${d.can_complete ? "" : "disabled"}>${esc(s("complete"))}</button></div>${d.can_complete ? "" : `<p class="lp-muted" id="ptNotReady"><small>${esc(s("notReady"))}</small></p>`}`}
      </section><p class="lp-muted"><small>${esc(s("disclaimer"))}</small></p>`);
    const rb = document.getElementById("ptReviewed"); if (rb) rb.onclick = async () => { rb.disabled = true; try { await call("POST", "/api/routine/mark", { step: "review" }); load(); } catch (e) { rb.disabled = false; } };
    const cb = document.getElementById("ptComplete"); if (cb) cb.onclick = async () => { cb.disabled = true; try { await call("POST", "/api/routine/mark", { step: "complete" }); load(); } catch (e) { cb.disabled = false; } };
  }
  let started = false;
  async function load() {
    try { if (!started) { started = true; await call("POST", "/api/routine/mark", { step: "start" }); } render(await call("GET", "/api/routine/today?lang=" + LANG)); }
    catch (e) { fail(e); }
  }
  document.querySelectorAll(".lp-langs [data-lang]").forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.lang === LANG));
    b.onclick = () => { LANG = b.dataset.lang; try { localStorage.setItem("hd_lang", LANG); } catch (e) {} location.reload(); }; });
  window.addEventListener("pageshow", e => { if (e.persisted) load(); });   // возврат «назад» из модуля — свежие статусы
  (async () => { try { const f = await fb(); if (!f.auth.currentUser) return location.replace("/"); } catch (e) { return fail({ code: "NETWORK" }); } load(); })();
})();
