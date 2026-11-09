"use strict";
/* Pre-Trade Routine: повторение → Daily Tests → Chart Training → итог подготовки (Session Summary).
   Состояние шагов вычисляется из сохранённых данных (daily_attempts, chart_sessions) за текущую дату Europe/Berlin;
   хранится только отметка «повторил» и завершение: pretrade_runs/{uid}__{date}. Выключенный модуль не блокирует маршрут. */
const { berlinDateKey, addDays } = require("./daily-tests");
const COURSE_SLUG = { hr: "hidden-reaction-system", smc: "smart-money-concepts-binary", rm: "risk-management-binary" };

function createPreTrade({ db, features, daily = null, now = () => Date.now() }) {
  const col = n => db.collection(n);
  const runId = (uid, date) => `${uid}__${date}`;
  async function setOf(date) { const s = await col("daily_sets").doc(date).get(); return s.exists ? s.data() : null; }
  const loc = (q, lang) => { const t = (q.i18n || {})[lang] || {}; return { lesson: t.lesson_title || q.lesson_title, topic: t.module_title || q.module_title }; };

  /* Ошибки за период: неверные ответы Daily Tests и пропущенные факторы Chart Training */
  async function mistakes(uid, fromDate, toDate, lang) {
    const atts = (await col("daily_attempts").where("uid", "==", uid).get()).docs.map(d => d.data()).filter(a => a.status === "done" && a.date >= fromDate && a.date <= toDate);
    const sets = {}, wrong = [];
    for (const a of atts.filter(x => !x.correct)) {
      sets[a.date] = sets[a.date] || await setOf(a.date); const q = sets[a.date] && sets[a.date].questions.find(x => x.id === a.qid); if (!q) continue;
      const l = loc(q, lang); wrong.push({ source: "daily", date: a.date, course: q.course, topic: l.topic, lesson: l.lesson, course_slug: q.course_slug || COURSE_SLUG[q.course], module_index: q.module_index });
    }
    const charts = (await col("chart_sessions").where("uid", "==", uid).get()).docs.map(d => d.data()).filter(s => s.status === "done" && berlinDateKey(s.answered_at) >= fromDate && berlinDateKey(s.answered_at) <= toDate);
    const chartMiss = [];
    for (const s of charts) if (s.grade && (s.grade.kind === "rule_error" || s.grade.kind === "incomplete" || s.grade.kind === "forced_trade" || (s.grade.missed || []).length))
      chartMiss.push({ source: "chart", date: berlinDateKey(s.answered_at), kind: s.grade.kind, missed: s.grade.missed || [], lessons: s.lessons || [] });
    return { wrong, chartMiss, atts, charts };
  }
  function recommend(m) {                                            // уроки для повторения: без повторов, сначала частые
    const map = new Map();
    const add = (slug, mi, title, topic) => { const k = slug + "|" + mi; const cur = map.get(k) || { course_slug: slug, module_index: mi, topic: topic || null, lessons: new Set(), weight: 0 };
      if (title) cur.lessons.add(title); if (topic && !cur.topic) cur.topic = topic; cur.weight++; map.set(k, cur); };
    for (const w of m.wrong) add(w.course_slug, w.module_index, w.lesson, w.topic);
    for (const c of m.chartMiss) for (const l of c.lessons) add(l.course_slug, l.module_index, null, null);
    return [...map.values()].sort((a, b) => b.weight - a.weight).slice(0, 6).map(x => ({ course_slug: x.course_slug, module_index: x.module_index, topic: x.topic, lessons: [...x.lessons].slice(0, 3) }));
  }

  async function today(uid, lang) {
    const date = berlinDateKey(now()), runRef = col("pretrade_runs").doc(runId(uid, date)), run = (await runRef.get()).data() || {};
    const open = { daily: await features.isOpen("daily_tests"), chart: await features.isOpen("chart_training") };
    const week = await mistakes(uid, addDays(date, -6), date, lang), day = await mistakes(uid, date, date, lang);
    let set = open.daily ? await setOf(date) : null;
    if (open.daily && !set && daily) { const r = await daily.ensureSet(date, { source: "lazy" }); if (r.status !== "exhausted") set = await setOf(date); }   // та же страховка, что на странице Daily Tests
    const dAtt = day.atts.filter(a => a.date === date), dDone = set ? set.questions.filter(q => dAtt.some(a => a.qid === q.id)).length : 0;
    const dCorrect = dAtt.filter(a => a.correct && set && set.questions.some(q => q.id === a.qid)).length;
    const scores = day.charts.map(s => s.grade.score);
    const steps = [
      { key: "review", status: run.review_done_at ? "done" : "pending", recommended: recommend(week) },
      { key: "daily", status: !open.daily ? "unavailable" : !set ? "pending" : dDone >= set.questions.length ? "done" : dDone ? "in_progress" : "pending", done: dDone, total: set ? set.questions.length : 0, correct: dCorrect },
      { key: "chart", status: !open.chart ? "unavailable" : scores.length ? "done" : "pending", sessions: scores.length, avg_score: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null }
    ];
    const ready = steps.every(s => s.status === "done" || s.status === "unavailable");
    const topics = {}; for (const w of day.wrong) topics[w.topic] = (topics[w.topic] || 0) + 1;
    const missed = {}; for (const c of day.chartMiss) for (const f of c.missed) missed[f] = (missed[f] || 0) + 1;
    const last = (await col("pretrade_runs").where("uid", "==", uid).get()).docs.map(d => d.data()).filter(r => r.completed_at).sort((a, b) => b.completed_at - a.completed_at)[0];
    return { date, started: !!run.started_at, completed: !!run.completed_at, can_complete: ready && !run.completed_at, steps,
      summary: { tests: steps[1].total ? { done: dDone, total: steps[1].total, correct: dCorrect } : null, practice: steps[2].sessions ? { sessions: steps[2].sessions, avg_score: steps[2].avg_score } : null,
        mistakes: { topics: Object.entries(topics).sort((a, b) => b[1] - a[1]).map(([topic, n]) => ({ topic, n })), chart_factors: Object.entries(missed).sort((a, b) => b[1] - a[1]).map(([factor, n]) => ({ factor, n })) },
        recommended: recommend(day).length ? recommend(day) : steps[0].recommended, last_completed_date: last ? last.date : null } };
  }
  async function mark(uid, what) {
    const date = berlinDateKey(now()), ref = col("pretrade_runs").doc(runId(uid, date));
    if (what === "complete") { const t = await today(uid, "ru"); if (!t.can_complete && !t.completed) throw Object.assign(new Error("Сначала пройдите доступные этапы"), { code: "NOT_READY", status: 409 }); }
    await db.runTransaction(async tx => { const s = await tx.get(ref), cur = s.exists ? s.data() : { uid, date, started_at: now() };
      if (what === "start" && !cur.started_at) cur.started_at = now();
      if (what === "review" && !cur.review_done_at) cur.review_done_at = now();
      if (what === "complete" && !cur.completed_at) cur.completed_at = now();
      tx.set(ref, cur); });
    return { ok: true };
  }
  return { today, mark };
}
module.exports = { createPreTrade };
