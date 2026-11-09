/* HIDDEN DINOX ACADEMY — обучение ученика: курсы → курс → урок. Данные только с сервера (/api/learn). */
(function () {
  "use strict";
  const el = document.getElementById("lp"), crumb = document.getElementById("crumb"), back = document.getElementById("back");
  const H = window.HDLesson, esc = H.esc;
  /* Язык — тот же, что выбран в академии (localStorage hd_lang); сервер переводит содержание курса */
  let LANG = "ru"; try { const x = localStorage.getItem("hd_lang"); if (["ru", "en", "ua"].includes(x)) LANG = x; } catch (e) {}
  H.setLang(LANG); document.documentElement.lang = LANG === "ua" ? "uk" : LANG;
  const S = {
    ru: { NO_ACCESS: "Обучение откроется после подтверждения первого депозита.", NOT_FOUND: "Материал не найден или снят с публикации.", TOO_MANY: "Слишком много попыток — подождите минуту.", NETWORK: "Нет связи с сервером.", generic: "Не удалось загрузить данные. Обновите страницу.",
      toList: "К списку курсов", learning: "Обучение", academy: "Академия", done: "Пройдено {d} из {t} уроков", empty: "Курсы появятся здесь после публикации.", allCourses: "Все курсы", cont: "Продолжить", start: "Начать обучение",
      courseDone: "Курс пройден", module: "Модуль", toCourse: "К курсу", lessonOf: "Урок {i} из {n}", prev: "Предыдущий урок", next: "Следующий урок", lessonDone: "Урок пройден", markDone: "Отметить урок пройденным", quizFirst: "Сначала пройдите тест урока.", passedB: "Пройден", withQuiz: "С тестом",
      trPartial: "Перевод этого материала неполный: часть текста показана на русском.", trNone: "Перевода на этот язык пока нет — показан русский текст.",
      modulesDone: "Завершено модулей: {d} из {t}", courseCompleted: "КУРС ЗАВЕРШЁН", openCongrats: "Посмотреть результаты", loading: "Загрузка…",
      cgTitle: "ПОЗДРАВЛЯЕМ!", cgSub: "Ты завершил курс «{course}».",
      cgP1: "Ты прошёл все уроки курса ({d} из {t}) и завершил обучение.", cgAbout: "О программе",
      cgP2: "Следующий этап — применять полученные знания дисциплинированно, проверять свои решения и помнить об управлении риском.",
      cgP3: "Это не конец пути. Это начало следующего этапа.", cgSlogan: "HIDDEN DINOX — Built through experience. Defined by discipline.",
      cgLessons: "Уроков завершено", cgModules: "Модулей завершено", cgTests: "Средний результат тестов", cgDate: "Дата завершения", cgStatus: "Статус",
      cgRank: "Ты прошёл курс лучше, чем {p}% участников, завершивших его (по среднему результату тестов).", cgNoRank: "Ты в числе тех, кто прошёл курс до конца. Сравнение с другими участниками появится, когда завершивших курс станет больше.",
      cgBack: "Вернуться в академию", cgNotDone: "Курс ещё не завершён — вот текущий прогресс.", cgInProgress: "КУРС В ПРОЦЕССЕ" },
    en: { NO_ACCESS: "Learning opens after your first deposit is confirmed.", NOT_FOUND: "The material was not found or has been unpublished.", TOO_MANY: "Too many attempts — wait a minute.", NETWORK: "No connection to the server.", generic: "Couldn’t load the data. Refresh the page.",
      toList: "Back to courses", learning: "Learning", academy: "Academy", done: "{d} of {t} lessons completed", empty: "Courses will appear here once published.", allCourses: "All courses", cont: "Continue", start: "Start learning",
      courseDone: "Course completed", module: "Module", toCourse: "Back to course", lessonOf: "Lesson {i} of {n}", prev: "Previous lesson", next: "Next lesson", lessonDone: "Lesson completed", markDone: "Mark lesson as completed", quizFirst: "Pass the lesson test first.", passedB: "Completed", withQuiz: "With test",
      trPartial: "This material is only partly translated: some text is shown in Russian.", trNone: "There is no translation into this language yet — the Russian text is shown.",
      modulesDone: "Modules completed: {d} of {t}", courseCompleted: "COURSE COMPLETED", openCongrats: "View results", loading: "Loading…",
      cgTitle: "CONGRATULATIONS!", cgSub: "You have completed “{course}”.",
      cgP1: "You finished every lesson of the course ({d} of {t}) and completed your training.", cgAbout: "About the programme",
      cgP2: "Your next step is to apply what you learned with discipline, evaluate your decisions, and keep risk management at the center of your process.",
      cgP3: "This is not the end of the journey. It is the beginning of the next stage.", cgSlogan: "HIDDEN DINOX — Built through experience. Defined by discipline.",
      cgLessons: "Lessons completed", cgModules: "Modules completed", cgTests: "Average test score", cgDate: "Completion date", cgStatus: "Status",
      cgRank: "You completed the course better than {p}% of participants who finished it (by average test score).", cgNoRank: "You are among those who completed the course. A comparison with other participants will appear once more people have finished it.",
      cgBack: "Return to Academy", cgNotDone: "The course is not completed yet — here is your current progress.", cgInProgress: "COURSE IN PROGRESS" },
    ua: { NO_ACCESS: "Навчання відкриється після підтвердження першого депозиту.", NOT_FOUND: "Матеріал не знайдено або знято з публікації.", TOO_MANY: "Забагато спроб — зачекайте хвилину.", NETWORK: "Немає зв'язку із сервером.", generic: "Не вдалося завантажити дані. Оновіть сторінку.",
      toList: "До списку курсів", learning: "Навчання", academy: "Академія", done: "Пройдено {d} із {t} уроків", empty: "Курси з'являться тут після публікації.", allCourses: "Усі курси", cont: "Продовжити", start: "Почати навчання",
      courseDone: "Курс пройдено", module: "Модуль", toCourse: "До курсу", lessonOf: "Урок {i} з {n}", prev: "Попередній урок", next: "Наступний урок", lessonDone: "Урок пройдено", markDone: "Позначити урок пройденим", quizFirst: "Спочатку пройдіть тест уроку.", passedB: "Пройдено", withQuiz: "З тестом",
      trPartial: "Переклад цього матеріалу неповний: частину тексту показано російською.", trNone: "Перекладу цією мовою поки немає — показано російський текст.",
      modulesDone: "Завершено модулів: {d} із {t}", courseCompleted: "КУРС ЗАВЕРШЕНО", openCongrats: "Переглянути результати", loading: "Завантаження…",
      cgTitle: "ВІТАЄМО!", cgSub: "Ти завершив курс «{course}».",
      cgP1: "Ти пройшов усі уроки курсу ({d} з {t}) і завершив навчання.", cgAbout: "Про програму",
      cgP2: "Наступний етап — застосовувати отримані знання дисципліновано, перевіряти свої рішення та пам’ятати про управління ризиком.",
      cgP3: "Це не кінець шляху. Це початок наступного етапу.", cgSlogan: "HIDDEN DINOX — Built through experience. Defined by discipline.",
      cgLessons: "Уроків завершено", cgModules: "Модулів завершено", cgTests: "Середній результат тестів", cgDate: "Дата завершення", cgStatus: "Статус",
      cgRank: "Ти пройшов курс краще, ніж {p}% учасників, які його завершили (за середнім результатом тестів).", cgNoRank: "Ти серед тих, хто пройшов курс до кінця. Порівняння з іншими учасниками з’явиться, коли курс завершить більше людей.",
      cgBack: "Повернутися до академії", cgNotDone: "Курс ще не завершено — ось поточний прогрес.", cgInProgress: "КУРС У ПРОЦЕСІ" }
  };
  const s = (k, v) => { let x = S[LANG][k] || S.ru[k] || k; if (v) for (const [a, b] of Object.entries(v)) x = x.split("{" + a + "}").join(String(b)); return x; };
  const qs = () => "?lang=" + LANG;
  const cache = new Map();                                   // ответы сервера по (адрес, язык): повторное переключение — без запросов
  // Содержимое уроков кэшируется без срока; сводки курса/прогресса — не дольше 15 с (прогресс мог измениться в другой вкладке)
  const get = async (path, fresh) => { const k = path + qs(), now = Date.now(), ttl = fresh ? 0 : /\/lessons\//.test(path) ? Infinity : 15000;
    const hit = cache.get(k); if (hit && now - hit.t < ttl) return hit.v;
    const r = await call("GET", k); cache.set(k, { t: now, v: r }); return r; };
  const drop = () => cache.clear();                          // после изменения прогресса — свежие данные
  const dateFmt = ms => new Date(ms).toLocaleDateString(LANG === "en" ? "en-GB" : LANG === "ua" ? "uk-UA" : "ru-RU", { day: "numeric", month: "long", year: "numeric" });
  const trNote = tr => (LANG === "ru" || !tr || tr.complete) ? "" : `<p class="lp-trnote" role="note">${esc(s(tr.none ? "trNone" : "trPartial"))}</p>`;
  const msg = e => (e && ["NO_ACCESS", "NOT_FOUND", "TOO_MANY", "NETWORK"].includes(e.code)) ? s(e.code) : s("generic");
  // Шапка: подпись под брендом всегда короткая («Обучение»); название курса — в содержимом страницы
  const setHead = (href, text) => { crumb.textContent = s("learning"); back.href = href; back.setAttribute("aria-label", text); const tt = back.querySelector(".t"); if (tt) tt.textContent = text; };
  const show = html => { el.innerHTML = html; el.focus({ preventScroll: true }); window.scrollTo(0, 0); };
  const fail = e => {
    if (e && e.code === "UNAUTHENTICATED") { location.replace("/"); return; }
    if (e && e.code === "NO_ACCESS") { location.replace("academy.html"); return; }
    show(`<p class="lp-err">${esc(msg(e))}</p><a class="lp-btn" href="learn.html">${esc(s("toList"))}</a>`);
  };

  async function courses() {
    setHead("academy.html", s("academy"));
    const { courses } = await get("/api/learn/courses");
    show(`<h1>${esc(s("learning"))}</h1>${courses.length ? courses.map(c => `<a class="lp-card" href="#/course/${encodeURIComponent(c.id)}">${c.cover_url ? `<img src="${esc(c.cover_url)}" alt="">` : ""}<h2>${esc(c.title)}</h2>${c.description ? `<p class="lp-muted">${esc(c.description)}</p>` : ""}
      <div class="lp-bar"><i style="width:${c.percent}%"></i></div><small class="lp-muted">${esc(s("done", { d: c.completed, t: c.lessons }))}</small></a>`).join("") : `<p class="lp-muted">${esc(s("empty"))}</p>`}`);
  }
  async function course(id) {
    const { course: c, summary: sm } = await get("/api/learn/courses/" + encodeURIComponent(id));
    setHead("#/", s("allCourses")); document.title = c.title + " — HIDDEN DINOX ACADEMY";
    const next = c.modules.flatMap(m => m.lessons).find(l => !l.completed);
    show(`<h1>${esc(c.title)}</h1>${trNote(c.translation)}${c.goal ? `<div class="hdl-text">${H.md(c.goal)}</div>` : ""}
      <div class="lp-bar"><i style="width:${c.percent}%"></i></div><p class="lp-meta">${esc(s("done", { d: c.completed, t: c.total }))} · ${esc(s("modulesDone", { d: sm.modules_completed, t: sm.modules_total }))}</p>
      ${next ? `<a class="lp-btn primary" href="#/lesson/${encodeURIComponent(next.id)}">${esc(c.completed ? s("cont") : s("start"))}</a>` : `<p class="lp-done">${esc(s("courseCompleted"))}</p><a class="lp-btn primary" href="#/done/${encodeURIComponent(c.id)}">${esc(s("openCongrats"))}</a>`}
      ${c.disclaimer ? `<div class="lp-disc">${esc(c.disclaimer)}</div>` : ""}
      ${c.modules.map((m, mi) => `<section class="lp-mod"><h2>${esc(s("module"))} ${mi + 1}. ${esc(m.title)}</h2>${m.goal ? `<p>${esc(m.goal)}</p>` : ""}
        ${m.lessons.map((l, li) => `<a class="lp-les" href="#/lesson/${encodeURIComponent(l.id)}"><span>${mi + 1}.${li + 1}. ${esc(l.title)}</span><em class="${l.completed ? "ok" : ""}">${l.completed ? s("passedB") : l.has_quiz ? s("withQuiz") : ""}</em></a>`).join("")}</section>`).join("")}`);
  }
  async function lesson(id) {
    const r = await get("/api/learn/lessons/" + encodeURIComponent(id));
    const l = r.lesson;
    setHead("#/course/" + encodeURIComponent(l.course_id), s("toCourse")); document.title = l.title + " — HIDDEN DINOX ACADEMY";
    show(`<p class="lp-course"><a href="#/course/${encodeURIComponent(l.course_id)}">${esc(l.course_title)}</a></p><p class="lp-meta">${esc(s("lessonOf", { i: r.nav.index, n: r.nav.total }))}</p><h1>${esc(l.title)}</h1>${trNote(l.translation)}<div id="body"></div>
      <div class="lp-foot">${r.nav.prev ? `<a class="lp-btn" href="#/lesson/${encodeURIComponent(r.nav.prev.id)}">${esc(s("prev"))}</a>` : "<span></span>"}
      <span id="doneWrap">${r.progress.completed ? `<span class="lp-done">${esc(s("lessonDone"))}</span>` : `<button class="lp-btn primary" id="done">${esc(s("markDone"))}</button>`}</span>
      ${r.nav.next ? `<a class="lp-btn" href="#/lesson/${encodeURIComponent(r.nav.next.id)}">${esc(s("next"))}</a>` : ""}</div><p class="lp-err" id="doneErr" hidden></p>`);
    H.render(document.getElementById("body"), l, {
      onQuiz: async (blockId, answers) => {
        const review = reviewing; reviewing = false;
        try {
          const res = await call("POST", `/api/learn/lessons/${encodeURIComponent(id)}/quiz`, { block_id: blockId, answers, lang: LANG, ...(review ? { review: true } : {}) });
          lastQuiz = { lesson: id, answers };
          if (!review) { drop(); if (res.lesson_completed) { const w = document.getElementById("doneWrap"); if (w) w.innerHTML = `<span class="lp-done">${esc(s("lessonDone"))}</span>`; } }
          if (res.course_completed) setTimeout(() => { location.hash = "#/done/" + encodeURIComponent(l.course_id); }, 1600);   // финальный экран — автоматически
          return res;
        } catch (e) { throw new Error(msg(e)); }
      }
    });
    const b = document.getElementById("done");
    if (b) b.onclick = async () => {
      b.disabled = true; const er = document.getElementById("doneErr"); er.hidden = true;
      try { const res = await call("POST", `/api/learn/lessons/${encodeURIComponent(id)}/complete`, {}); drop(); document.getElementById("doneWrap").innerHTML = `<span class="lp-done">${esc(s("lessonDone"))}</span>`;
        if (res.course_completed) location.hash = "#/done/" + encodeURIComponent(l.course_id); }
      catch (e) { er.hidden = false; er.textContent = e && e.code === "QUIZ_REQUIRED" ? s("quizFirst") : msg(e); b.disabled = false; }
    };
  }
  /* Финальный экран курса: только реальные данные (сводка сервера); рейтинг — только при достаточной статистике */
  async function congrats(id) {
    // итоги — всегда свежие данные с сервера (без кэша)
    const [{ course: c, summary: sm }, rk] = await Promise.all([get("/api/learn/courses/" + encodeURIComponent(id), true), get("/api/learn/courses/" + encodeURIComponent(id) + "/ranking", true).catch(() => ({ available: false }))]);
    setHead("#/course/" + encodeURIComponent(c.id), s("toCourse")); document.title = s("cgTitle") + " — " + c.title + " — HIDDEN DINOX ACADEMY";
    const stat = (k, v) => `<div class="cg-stat"><b>${esc(v)}</b><span>${esc(s(k))}</span></div>`;
    if (!sm.course_completed) {                                     // курс не завершён: реальный прогресс и следующий шаг, без ложного «завершено»
      show(`<section class="cg" aria-labelledby="cgH"><p class="cg-badge">${esc(s("cgInProgress"))}</p><h1 id="cgH">${esc(c.title)}</h1><p class="cg-sub">${esc(s("cgNotDone"))}</p>
        <div class="cg-stats">${stat("cgLessons", `${sm.completed} / ${sm.lessons}`)}${stat("cgModules", `${sm.modules_completed} / ${sm.modules_total}`)}${sm.tests.avg_best_percent !== null ? stat("cgTests", sm.tests.avg_best_percent + "%") : ""}</div>
        <div class="cg-actions">${sm.next ? `<a class="lp-btn primary" href="#/lesson/${encodeURIComponent(sm.next.lesson_id)}">${esc(s("cont"))}: ${esc(sm.next.title)}</a>` : ""}<a class="lp-btn" href="#/course/${encodeURIComponent(c.id)}">${esc(s("toCourse"))}</a></div></section>`);
      return;
    }
    show(`<section class="cg" aria-labelledby="cgH"><img class="cg-img" src="assets/mascot/mascot-pointing-forward.webp" alt="" width="300" height="400">
      <p class="cg-badge">${esc(s("courseCompleted"))}</p><h1 id="cgH">${esc(s("cgTitle"))}</h1><p class="cg-sub" id="cgCourse">${esc(s("cgSub", { course: c.title }))}</p>
      <div class="cg-stats">${stat("cgLessons", `${sm.completed} / ${sm.lessons}`)}${stat("cgModules", `${sm.modules_completed} / ${sm.modules_total}`)}${sm.tests.avg_best_percent !== null ? stat("cgTests", sm.tests.avg_best_percent + "%") : ""}${sm.completed_at ? stat("cgDate", dateFmt(sm.completed_at)) : ""}${stat("cgStatus", s("courseCompleted"))}</div>
      <p class="cg-rank">${esc(rk && rk.available ? s("cgRank", { p: rk.better_than_percent }) : s("cgNoRank"))}</p>
      <p>${esc(s("cgP1", { d: sm.completed, t: sm.lessons }))}</p>${c.description ? `<p class="cg-about" id="cgAbout"><b>${esc(s("cgAbout"))}:</b> ${esc(c.description)}</p>` : ""}<p>${esc(s("cgP2"))}</p><p class="cg-strong">${esc(s("cgP3"))}</p><p class="cg-slogan">${esc(s("cgSlogan"))}</p>
      <div class="cg-actions"><a class="lp-btn primary cg-back" href="academy.html">${esc(s("cgBack"))}</a><a class="lp-btn" href="#/course/${encodeURIComponent(c.id)}">${esc(s("toCourse"))}</a></div></section>`);
  }
  async function route() {
    const [, kind, id] = (location.hash || "#/").split("/");
    try { if (kind === "course" && id) await course(decodeURIComponent(id)); else if (kind === "lesson" && id) await lesson(decodeURIComponent(id)); else if (kind === "done" && id) await congrats(decodeURIComponent(id)); else await courses(); }
    catch (e) { fail(e); }
  }
  let reviewing = false, lastQuiz = null;
  function setLang(l) {
    if (l === LANG || !S[l]) return;
    // запомнить выбранные ответы и показанный результат теста текущего урока
    const quizzes = [...document.querySelectorAll(".hdl-quiz")].map(q => ({ answers: [...q.querySelectorAll(".hdl-q")].map(f => { const c = f.querySelector("input:checked"); return c ? c.value : null; }),
      shown: !!(q.querySelector(".hdl-quiz-total") && !q.querySelector(".hdl-quiz-total").hidden) }));
    LANG = l; H.setLang(l); document.documentElement.lang = l === "ua" ? "uk" : l;
    try { localStorage.setItem("hd_lang", l); } catch (e) {}
    call("POST", "/api/lang", { lang: l }).catch(() => {});                        // язык в профиле (повторный вход, другое устройство)
    paintLangs();
    route().then(() => {
      document.querySelectorAll(".hdl-quiz").forEach((q, qi) => {
        const st = quizzes[qi]; if (!st) return;
        q.querySelectorAll(".hdl-q").forEach((f, i) => { const v = st.answers[i]; if (v !== null && v !== undefined) { const r = f.querySelector(`input[value="${v}"]`); if (r) r.checked = true; } });
        if (st.shown) { reviewing = true; const b = q.querySelector("[data-quiz-submit]"); if (b) b.click(); }   // объяснения на новом языке, без новой попытки
      });
    });
  }
  function paintLangs() { document.querySelectorAll(".hd-langs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.lang === LANG))); }
  document.querySelectorAll(".hd-langs button").forEach(b => (b.onclick = () => setLang(b.dataset.lang)));
  paintLangs();
  window.addEventListener("hashchange", route);
  (async () => { try { const f = await fb(); if (!f.auth.currentUser) return location.replace("/"); } catch (e) { return fail({ code: "NETWORK" }); } route(); })();
})();
