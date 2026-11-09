"use strict";
/* Обучение для учеников: только ОПУБЛИКОВАННЫЕ курсы (published_courses / published_lessons).
   Доступ: открытая академия (academyAccess, вычисляет сервер) или роль сотрудника (Team Member и выше).
   Правильные ответы тестов клиенту не отдаются; проверка — на сервере. */
const R = require("./roles");
const C = require("./content");

function createLearnApi({ db, academyApi, storage = null, log = console, now = () => Date.now(), env = process.env, mentorFetch = null }) {
  const col = n => db.collection(n);
  const fail = (res, status, error, message) => res.status(status).json({ error, message });
  class E extends Error { constructor(s, c, m) { super(m || c); this.s = s; this.c = c; } }

  async function learner(req, auth) {
    auth = auth || await academyApi.authenticate(req);
    const { user, ev } = await academyApi.stateFor(auth.uid, { user: auth.user });
    const role = R.roleOf(user);
    const staff = R.RANK[role] >= R.RANK.team_member;
    if (!ev.academyAccess && !staff) throw new E(403, "NO_ACCESS", "Обучение доступно после активации академии");
    return { uid: auth.uid, role, staff };
  }
  const langOf = req => { const x = String((req.query && req.query.lang) || (req.body && req.body.lang) || "ru"); return C.TR_LANGS.includes(x) ? x : "ru"; };
  // Снимок опубликованного курса на выбранном языке: курс, модули и названия уроков
  function localCourse(c, lang) {
    const base = C.localize(C.withTr(c, "course"), lang);
    const modules = (c.modules || []).map(m => { const lm = C.localize(C.withTr(m, "module"), lang).doc; return { ...lm, lessons: (m.lessons || []).map(x => C.localize(C.withTr(x, "lesson"), lang).doc) }; });
    return { ...base.doc, modules, translation: base.status };
  }
  const visible = (c, staff) => staff || !c.visible_from || c.visible_from <= now();
  const pid = (uid, lid) => `${uid}__${lid}`;
  const progressOf = async (uid, courseId) => (await col("lesson_progress").where("uid", "==", uid).get()).docs.map(d => d.data()).filter(p => !courseId || p.course_id === courseId);

  /* Единый расчёт прогресса курса (главная, страница курса, финальный экран) — только из сохранённых lesson_progress.
     Урок завершён — completed:true (после успешного теста — автоматически). Модуль — все его уроки. Курс — все уроки. */
  const RANK_MIN_SAMPLE = 20;                       // рейтинг показывается только при достаточной статистике
  // Урок завершён: completed:true ИЛИ успешный тест (записи прежней логики, где после теста не нажали «Отметить»).
  // Данные в базе не меняются — только прочтение; дата завершения такой записи — время успешного теста.
  const isDone = p => p && (p.completed === true || (p.quiz && p.quiz.passed === true));
  const doneAt = p => p.completed_at || (p.quiz && p.quiz.at) || 0;
  function summarize(c, prog) {
    const done = new Map(prog.filter(isDone).map(p => [p.lesson_id, { ...p, completed_at: doneAt(p) }]));
    const quiz = new Map(prog.filter(p => p.quiz).map(p => [p.lesson_id, p.quiz]));
    let total = 0, completed = 0, modulesDone = 0, next = null, lastAt = 0;
    for (const m of c.modules || []) {
      const ls = m.lessons || []; const d = ls.filter(x => done.has(x.id)).length;
      total += ls.length; completed += d; if (ls.length && d === ls.length) modulesDone++;
      if (!next) { const n = ls.find(x => !done.has(x.id)); if (n) next = { lesson_id: n.id, title: n.title, module_title: m.title, has_quiz: !!n.has_quiz }; }
      for (const x of ls) { const p = done.get(x.id); if (p && (p.completed_at || 0) > lastAt) lastAt = p.completed_at || 0; }
    }
    const quizLessons = (c.modules || []).flatMap(m => (m.lessons || []).filter(x => x.has_quiz));
    const scores = quizLessons.map(x => quiz.get(x.id)).filter(q => q && Number.isFinite(q.best_percent)).map(q => q.best_percent);
    const courseDone = total > 0 && completed === total;
    return { lessons: total, completed, percent: total ? Math.round(completed * 100 / total) : 0,
      modules_total: (c.modules || []).length, modules_completed: modulesDone, next, course_completed: courseDone, completed_at: courseDone ? lastAt || null : null,
      tests: scores.length ? { avg_best_percent: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length), passed: scores.length, total: quizLessons.length } : { avg_best_percent: null, passed: 0, total: quizLessons.length } };
  }
  async function courseOfLesson(lessonCourseId) { const d = await col("published_courses").doc(lessonCourseId).get(); return d.exists ? d.data() : null; }

  // Every learner action must enforce the same publication window as lesson viewing.
  // Otherwise a user who learns/guesses a lesson ID could submit quizzes or mark a
  // scheduled lesson complete before its course becomes visible.
  async function publishedLessonForLearner(me, lessonId) {
    const d = await col("published_lessons").doc(lessonId).get();
    if (!d.exists) throw new E(404, "NOT_FOUND");
    const l = d.data();
    const c = await col("published_courses").doc(l.course_id).get();
    if (!c.exists || !visible(c.data(), me.staff)) throw new E(404, "NOT_FOUND");
    const included = (c.data().modules || []).some(m => (m.lessons || []).some(x => x.id === lessonId));
    if (!included) throw new E(404, "NOT_FOUND");
    return l;
  }

  const wrap = fn => async (req, res) => {
    try { const out = await fn(req); res.set && res.set("Cache-Control", "no-store"); res.status(200).json(out); }
    catch (e) {
      if (e instanceof E) return fail(res, e.s, e.c, e.message);
      if (e && e.code && /^(UNAUTHENTICATED|ACCOUNT_BLOCKED|CONFIG_MISSING)$/.test(e.code)) return fail(res, e.code === "UNAUTHENTICATED" ? 401 : e.code === "ACCOUNT_BLOCKED" ? 403 : 503, e.code);
      log.error && log.error("learn api error:", e && (e.code || e.message));
      fail(res, 503, "UNAVAILABLE");
    }
  };

  const F = require("./features").createFeatures({ db, now });
  const D = require("./daily-tests").createDailyTests({ db, now, log });
  const dx = async fn => { try { return await fn(); } catch (e) { if (e && e.status && e.code) throw new E(e.status, e.code, e.message); throw e; } };
  const CT = require("./chart-training").createChartTraining({ db, now });
  /* профиль для AI-наставника — тот же расчёт прогресса, что видит ученик (summarize) */
  async function learningProfile(uid, lang) {
    const out = [], prog = await progressOf(uid);
    for (const d of (await col("published_courses").get()).docs) { const c = d.data(); if (!visible(c, false)) continue;
      const lc = C.localize(C.withTr(c, "course"), lang).doc, sm = summarize(c, prog.filter(p => p.course_id === d.id));
      const titles = new Map((lc.modules || c.modules || []).flatMap(m => (m.lessons || []).map(x => [x.id, x.title])));
      const weak = prog.filter(p => p.course_id === d.id && p.quiz && Number.isFinite(p.quiz.best_percent) && p.quiz.best_percent < 70).map(p => titles.get(p.lesson_id)).filter(Boolean);
      out.push({ title: lc.title || c.title, lessons: sm.lessons, completed: sm.completed, next: sm.next ? (titles.get(sm.next.lesson_id) || sm.next.title) : null, weak }); }
    return out;
  }
  const M = require("./mentor").createMentor({ db, env, now, log, fetchImpl: mentorFetch || globalThis.fetch, visibleCourse: c => visible(c, false), learningProfile });
  async function mentorGate(req) { const me = await learner(req); await dx(() => F.requireFeature("ai_mentor", { preview: me.staff })); return me; }
  const PT = require("./pretrade").createPreTrade({ db, features: F, daily: D, now });
  async function routineGate(req) { const me = await learner(req); await dx(() => F.requireFeature("pre_trade", { preview: me.staff })); return me; }
  async function chartGate(req) { const me = await learner(req); await dx(() => F.requireFeature("chart_training", { preview: me.staff })); return me; }
  async function dailyGate(req) { const me = await learner(req); await dx(() => F.requireFeature("daily_tests", { preview: me.staff })); return me; }
  const H = {
    features: wrap(async req => { await learner(req); return { cards: await F.publicCards(langOf(req)) }; }),
    /* Daily Tests: доступ как к курсам + карточка «Открыть» (сотрудникам — предпросмотр) */
    /* Chart Training: доступ как к курсам + карточка «Открыть» */
    /* Pre-Trade Routine */
    routineToday: wrap(async req => { const me = await routineGate(req); return PT.today(me.uid, langOf(req)); }),
    routineMark: wrap(async req => { const me = await routineGate(req); const w = (req.body || {}).step; if (!["start", "review", "complete"].includes(w)) throw new E(400, "INVALID", "Неизвестный шаг"); return dx(() => PT.mark(me.uid, w)); }),
    /* ИИ-помощник */
    mentorThread: wrap(async req => { const me = await mentorGate(req); return M.thread(me.uid); }),
    mentorMessage: wrap(async req => { const me = await mentorGate(req); return dx(() => M.send(me.uid, langOf(req), req.body)); }),
    mentorMemory: wrap(async req => { const me = await mentorGate(req); return M.memoryView(me.uid, langOf(req)); }),
    mentorForget: wrap(async req => { const me = await mentorGate(req); if (!(req.body || {}).confirm) throw new E(400, "CONFIRM_REQUIRED"); return M.forgetMemory(me.uid); }),
    mentorProfilePref: wrap(async req => { const me = await mentorGate(req); return M.setUseProfile(me.uid, (req.body || {}).use !== false); }),
    mentorNew: wrap(async req => { const me = await mentorGate(req); return M.newThread(me.uid); }),
    mentorClear: wrap(async req => { const me = await mentorGate(req); if (!(req.body || {}).confirm) throw new E(400, "CONFIRM_REQUIRED"); return M.clear(me.uid); }),
    chartNext: wrap(async req => { const me = await chartGate(req); const r = (req.query || {}).retry; return dx(() => CT.next(me.uid, langOf(req), r ? String(r).slice(0, 60) : null)); }),
    chartSkip: wrap(async req => { const me = await chartGate(req); return dx(() => CT.skip(me.uid, (req.body || {}).session_id)); }),
    chartAnswer: wrap(async req => { const me = await chartGate(req); const b = req.body || {}; return dx(() => CT.answer(me.uid, b.session_id, b)); }),
    chartHistory: wrap(async req => { const me = await chartGate(req); return { sessions: await CT.history(me.uid) }; }),
    chartSession: wrap(async req => { const me = await chartGate(req); return dx(() => CT.session(me.uid, req.params.id)); }),
    dailyToday: wrap(async req => { const me = await dailyGate(req); return D.today(me.uid, langOf(req)); }),
    dailyTask: wrap(async req => { const me = await dailyGate(req); const q = req.query || {}; return dx(() => D.task(me.uid, q.date, q.qid, langOf(req))); }),
    dailyStart: wrap(async req => { const me = await dailyGate(req); const b = req.body || {}; return dx(() => D.start(me.uid, b.date, b.qid)); }),
    dailyAnswer: wrap(async req => { const me = await dailyGate(req); const b = req.body || {}; return dx(() => D.answer(me.uid, b.date, b.qid, b.answer, langOf(req))); }),
    dailyHistory: wrap(async req => { const me = await dailyGate(req); return D.history(me.uid, langOf(req)); }),
    courses: wrap(async req => {
      // Проверка доступа и чтения курсов/прогресса — параллельно; при отказе в доступе ответ всё равно 403 и данных нет
      const auth = await academyApi.authenticate(req);
      const [me, pubSnap, prog] = await Promise.all([learner(req, auth), col("published_courses").get(), progressOf(auth.uid)]);
      const lang = langOf(req);
      const pubs = pubSnap.docs.map(d => ({ id: d.id, ...localCourse(d.data(), lang) })).filter(c => visible(c, me.staff));
      return { courses: pubs.map(c => ({ id: c.id, title: c.title, description: c.description, level: c.level, cover_url: c.cover_media_id ? "/media/" + c.cover_media_id : null,
        ...summarize(c, prog.filter(p => p.course_id === c.id || c.modules.some(m => m.lessons.some(x => x.id === p.lesson_id)))) })) };
    }),
    course: wrap(async req => {
      const me = await learner(req);
      const d = await col("published_courses").doc(req.params.id).get();
      if (!d.exists || !visible(d.data(), me.staff)) throw new E(404, "NOT_FOUND");
      const c = localCourse(d.data(), langOf(req)), prog = await progressOf(me.uid, d.id);
      const done = new Set(prog.filter(isDone).map(p => p.lesson_id));
      const total = c.modules.reduce((n, m) => n + m.lessons.length, 0), sum = summarize(c, prog);
      return { summary: sum, course: { id: d.id, title: c.title, description: c.description, goal: c.goal, level: c.level, disclaimer: c.disclaimer, translation: c.translation, cover_url: c.cover_media_id ? "/media/" + c.cover_media_id : null,
        modules: c.modules.map(m => ({ ...m, lessons: m.lessons.map(l => ({ ...l, completed: done.has(l.id) })) })), total, completed: done.size, percent: total ? Math.round(done.size * 100 / total) : 0 } };
    }),
    lesson: wrap(async req => {
      const me = await learner(req);
      const d = await col("published_lessons").doc(req.params.id).get();
      if (!d.exists) throw new E(404, "NOT_FOUND");
      const c = await col("published_courses").doc(d.data().course_id).get();
      if (!c.exists || !visible(c.data(), me.staff)) throw new E(404, "NOT_FOUND");
      const p = await col("lesson_progress").doc(pid(me.uid, d.id)).get();
      const lang = langOf(req), loc = C.localize(C.withTr(d.data(), "lesson"), lang), cc = localCourse(c.data(), lang);
      const l = C.publicLesson(loc.doc);                                       // правильные ответы удаляются ПОСЛЕ перевода
      // Ссылка на навигацию внутри курса
      const flat = cc.modules.flatMap(m => m.lessons.map(x => ({ id: x.id, title: x.title, module: m.title })));
      const i = flat.findIndex(x => x.id === d.id);
      return { lesson: { id: d.id, course_id: l.course_id, course_title: cc.title, title: l.title, outcome: l.outcome, source_pages: l.source_pages, blocks: l.blocks, pass_criteria: l.pass_criteria, translation: loc.status },
        nav: { prev: flat[i - 1] || null, next: flat[i + 1] || null, index: i + 1, total: flat.length },
        progress: p.exists ? { completed: isDone(p.data()), quiz: p.data().quiz || null } : { completed: false, quiz: null } };
    }),
    quiz: wrap(async req => {
      const me = await learner(req);
      const l = C.localize(C.withTr(await publishedLessonForLearner(me, req.params.id), "lesson"), langOf(req)).doc;   // объяснения на языке ученика; оценка по индексам не меняется
      const blockId = req.body && typeof req.body.block_id === "string" ? req.body.block_id : null;
      const qb = (l.blocks || []).find(b => b.type === "quiz" && (!blockId || b.id === blockId));
      if (!qb) throw new E(404, "NO_QUIZ");
      const answers = Array.isArray(req.body && req.body.answers) ? req.body.answers : [];
      if (answers.length !== qb.questions.length) throw new E(400, "INVALID", "Ответьте на все вопросы");
      const results = qb.questions.map((q, i) => ({ correct: Number(answers[i]) === q.correct, correct_index: q.correct, explanation: q.explanation || "" }));
      const score = results.filter(r => r.correct).length, percent = Math.round(score * 100 / results.length), passed = percent >= (qb.pass_percent ?? 70);
      // review: показать объяснения на другом языке для уже выбранных ответов — без записи новой попытки
      if (req.body && req.body.review === true) return { score, total: results.length, percent, passed, results, review: true };
      const ref = col("lesson_progress").doc(pid(me.uid, req.params.id));
      let wasCourseDone = false, completedNow = false;
      { const cdata = await courseOfLesson(l.course_id); if (cdata) wasCourseDone = summarize(cdata, await progressOf(me.uid, l.course_id)).course_completed; }
      await db.runTransaction(async tx => {
        const p = await tx.get(ref); const prev = p.exists ? p.data() : {};
        const attempts = ((prev.quiz && prev.quiz.attempts) || 0) + 1;
        const best = Math.max(percent, (prev.quiz && prev.quiz.best_percent) || 0);
        // успешный тест завершает урок сразу (раньше требовалась отдельная кнопка — из-за этого пройденные уроки оставались незавершёнными)
        if (passed && !prev.completed) { completedNow = true; tx.set(ref, { completed: true, completed_at: now() }, { merge: true }); }
        tx.set(ref, { uid: me.uid, course_id: l.course_id, lesson_id: req.params.id, quiz: { attempts, last_percent: percent, best_percent: best, passed: (prev.quiz && prev.quiz.passed) || passed, at: now() }, updated_at: now() }, { merge: true });
      });
      let course_completed = false;
      if (completedNow && !wasCourseDone) { const cdata = await courseOfLesson(l.course_id); course_completed = !!cdata && summarize(cdata, await progressOf(me.uid, l.course_id)).course_completed; }
      return { score, total: results.length, percent, passed, results, lesson_completed: passed || undefined, course_completed };
    }),
    complete: wrap(async req => {
      const me = await learner(req);
      const l = await publishedLessonForLearner(me, req.params.id);
      const ref = col("lesson_progress").doc(pid(me.uid, req.params.id));
      const p = await ref.get(); const prev = p.exists ? p.data() : {};
      const pc = l.pass_criteria || {};
      if (pc.require_quiz && !(prev.quiz && prev.quiz.passed)) throw new E(409, "QUIZ_REQUIRED", "Сначала пройдите тест урока");
      if (isDone(prev)) return { ok: true, already: true };
      const cdata = await courseOfLesson(l.course_id);
      const wasDone = cdata ? summarize(cdata, await progressOf(me.uid, l.course_id)).course_completed : false;
      await ref.set({ uid: me.uid, course_id: l.course_id, lesson_id: req.params.id, completed: true, completed_at: now(), updated_at: now() }, { merge: true });
      const course_completed = !wasDone && !!cdata && summarize(cdata, await progressOf(me.uid, l.course_id)).course_completed;
      return { ok: true, course_completed };
    }),
    /* Рейтинг среди завершивших курс: единый критерий — средний лучший результат тестов курса.
       Показывается только при достаточной статистике (RANK_MIN_SAMPLE); иначе available:false — без выдуманных процентов. */
    ranking: wrap(async req => {
      const me = await learner(req);
      const d = await col("published_courses").doc(req.params.id).get();
      if (!d.exists || !visible(d.data(), me.staff)) throw new E(404, "NOT_FOUND");
      const c = d.data(), all = (await col("lesson_progress").where("course_id", "==", d.id).get()).docs.map(x => x.data());
      const byUser = new Map(); for (const p of all) { if (!byUser.has(p.uid)) byUser.set(p.uid, []); byUser.get(p.uid).push(p); }
      const finished = [...byUser.entries()].map(([uid, ps]) => ({ uid, s: summarize(c, ps) })).filter(x => x.s.course_completed && x.s.tests.avg_best_percent !== null);
      const mine = finished.find(x => x.uid === me.uid);
      if (!mine) return { available: false, reason: "NOT_COMPLETED", sample: finished.length };
      if (finished.length < RANK_MIN_SAMPLE) return { available: false, reason: "NOT_ENOUGH_DATA", sample: finished.length, min_sample: RANK_MIN_SAMPLE };
      const lower = finished.filter(x => x.s.tests.avg_best_percent < mine.s.tests.avg_best_percent).length;
      return { available: true, better_than_percent: Math.floor(lower * 100 / (finished.length - 1 || 1)), sample: finished.length, criterion: "avg_best_test_percent" };
    }),
    /* Баннеры главной: опубликованные записи CMS kind:"banner"; если их нет — два стандартных (книга и кабинет партнёра) */
    banners: wrap(async req => {
      const auth = await academyApi.authenticate(req);
      const [{ ev }, snap] = await Promise.all([academyApi.stateFor(auth.uid, { user: auth.user }), col("announcements").where("kind", "==", "banner").get()]);
      const t = now(), all = snap.docs.map(d => C.withSystemDefaults({ id: d.id, ...d.data() }));
      const live = all.filter(a => a.status === "published" && (!a.show_from || Date.parse(a.show_from) <= t) && (!a.show_until || Date.parse(a.show_until) > t))
        .filter(a => a.audience === "all" || (a.audience === "access" && ev.academyAccess) || (a.audience === "no_access" && !ev.academyAccess))
        .sort((a, b) => (b.priority - a.priority) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
      // Раньше стандартные карточки показывались, только пока в базе не было НИ ОДНОГО баннера, — и «пропадали»
      // при создании нового. Теперь: все опубликованные записи + стандартные, если их записи ещё не созданы.
      const ids = new Set(all.map(a => a.id));
      const src = [...live, ...C.SYSTEM_BANNERS.filter(d => !ids.has(d.id))].sort(C.bannerSort);
      return { banners: src.slice(0, 12).map(a => {
        const soon = a.action_type === "soon" || (a.release_at && Date.parse(a.release_at) > t);
        return { id: a.id, title: a.title, title_i18n: a.title_i18n || {}, cta_label: a.cta_label || "", cta_i18n: a.cta_i18n || {}, category_i18n: a.category_i18n || {},
          image_url: a.image_media_id ? "/media/" + a.image_media_id : (C.BUILTIN_IMAGES[a.image_builtin] || null),
          href: soon ? null : C.bannerHref(a), external: a.action_type === "external", soon: !!soon, release_at: a.release_at || null, system: !!a.system };
      }) };
    }),
    announcements: wrap(async req => {
      const auth = await academyApi.authenticate(req);
      const [{ ev }, annSnap] = await Promise.all([academyApi.stateFor(auth.uid, { user: auth.user }), col("announcements").get()]);
      const t = now();
      const list = annSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => a.kind !== "banner")   // баннеры главной — отдельный маршрут
        .filter(a => a.status === "published" && (!a.show_from || Date.parse(a.show_from) <= t) && (!a.show_until || Date.parse(a.show_until) > t))
        .filter(a => a.audience === "all" || (a.audience === "access" && ev.academyAccess) || (a.audience === "no_access" && !ev.academyAccess))
        .sort((a, b) => (b.priority - a.priority) || String(a.event_at || "").localeCompare(String(b.event_at || "")))
        .slice(0, 10)
        .map(a => ({ id: a.id, title: a.title, body: a.body, image_url: a.image_media_id ? "/media/" + a.image_media_id : null, event_at: a.event_at, cta_label: a.cta_label, cta_url: a.cta_url }));
      return { announcements: list };
    })
  };

  /* Файлы медиа-библиотеки. Идентификаторы случайные (не перебираются); SVG/HTML не принимаются при загрузке. */
  async function media(req, res) {
    try {
      const id = String(req.params.id || "");
      if (!/^med_[a-f0-9]{20}$/.test(id) || !storage || !storage.available) return res.status(404).end();
      const d = await col("media").doc(id).get();
      if (!d.exists || d.data().deleted) return res.status(404).end();
      const buf = await storage.read(d.data().storage_path);
      res.set("Content-Type", d.data().content_type); res.set("X-Content-Type-Options", "nosniff");
      res.set("Cache-Control", "public, max-age=86400"); res.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      res.set("Content-Disposition", (d.data().kind === "pdf" ? "inline" : "inline") + `; filename="${encodeURIComponent(d.data().name || "file")}"`);
      res.status(200).send(buf);
    } catch (e) { const d = require("./storage").describeStorageError(e, storage && storage.bucketName); log.error && log.error("media error:", d.code, String((e && e.message) || "").slice(0, 200)); res.status(404).end(); }
  }


  const ROUTES = [["GET", "/mentor/thread", "mentorThread"], ["POST", "/mentor/message", "mentorMessage"], ["POST", "/mentor/new", "mentorNew"], ["GET", "/mentor/memory", "mentorMemory"], ["POST", "/mentor/memory/forget", "mentorForget"], ["POST", "/mentor/memory/profile", "mentorProfilePref"], ["POST", "/mentor/clear", "mentorClear"],
    ["GET", "/routine/today", "routineToday"], ["POST", "/routine/mark", "routineMark"],
    ["GET", "/chart/next", "chartNext"], ["POST", "/chart/answer", "chartAnswer"], ["POST", "/chart/skip", "chartSkip"], ["GET", "/chart/history", "chartHistory"], ["GET", "/chart/session/:id", "chartSession"],
    ["GET", "/daily/today", "dailyToday"], ["GET", "/daily/task", "dailyTask"], ["POST", "/daily/start", "dailyStart"], ["POST", "/daily/answer", "dailyAnswer"], ["GET", "/daily/history", "dailyHistory"],
    ["GET", "/home/features", "features"], ["GET", "/home/banners", "banners"], ["GET", "/learn/courses", "courses"], ["GET", "/learn/courses/:id", "course"], ["GET", "/learn/lessons/:id", "lesson"],
    ["POST", "/learn/lessons/:id/quiz", "quiz"], ["POST", "/learn/lessons/:id/complete", "complete"], ["GET", "/learn/courses/:id/ranking", "ranking"], ["GET", "/announcements", "announcements"]];
  return { H, ROUTES, media };
}

/* Регистрирует маршруты обучения в существующем роутере /api и маршрут файлов /media/:id */
function registerLearnRoutes(app, router, deps) {
  const api = createLearnApi(deps);
  for (const [m, p, h] of api.ROUTES) router[m.toLowerCase()](p, api.H[h]);
  app.get("/media/:id", api.media);
  return api;
}
module.exports = { createLearnApi, registerLearnRoutes };
