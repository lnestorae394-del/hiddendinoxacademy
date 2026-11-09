"use strict";
/* Память AI-наставника.
   • Профиль ученика — из реальных данных обучения (без запросов к ИИ): прогресс курсов, слабые уроки, ошибки Daily Tests,
     пропущенные факторы в тренировке на графике. Ученик может отключить его использование.
   • Сводка диалога и заметки по графикам хранятся в mentor_threads/{uid} и привязаны к thread_id:
     новый диалог начинается без них, «Забыть» стирает их (прогресс обучения не меняется). */
const SUMMARY_EVERY = 6, MAX_NOTES = 5, PROFILE_MS = 10 * 60e3;
const TXT = {
  ru: { course: (t, d, n) => `${t}: пройдено ${d} из ${n} уроков`, next: x => `следующий урок — «${x}»`, weakLessons: "низкий результат теста (< 70%) в уроках", dailyWeak: "ошибки в ежедневных тестах за 30 дней по темам", chart: "в тренировке на графике чаще всего пропускает", none: "данных об обучении пока нет" },
  en: { course: (t, d, n) => `${t}: ${d} of ${n} lessons completed`, next: x => `next lesson — “${x}”`, weakLessons: "low test score (< 70%) in lessons", dailyWeak: "daily test mistakes in the last 30 days by topic", chart: "in chart training most often misses", none: "no learning data yet" },
  ua: { course: (t, d, n) => `${t}: пройдено ${d} з ${n} уроків`, next: x => `наступний урок — «${x}»`, weakLessons: "низький результат тесту (< 70%) в уроках", dailyWeak: "помилки в щоденних тестах за 30 днів за темами", chart: "у тренуванні на графіку найчастіше пропускає", none: "даних про навчання поки немає" } };
const FACTOR = { structure: "структуру", liquidity_sweep: "снятие ликвидности", bos_mss: "BOS/MSS", fvg: "FVG", premium_discount: "premium/discount", no_confirmation: "отсутствие подтверждения" };

function createMemory({ db, now = () => Date.now(), courses = async () => [] }) {
  const col = n => db.collection(n), ref = uid => col("mentor_threads").doc(uid), cache = new Map();
  async function state(uid) { const s = await ref(uid).get(); return s.exists ? s.data() : {}; }
  async function profile(uid, lang) {
    const st = await state(uid); if (st.prefs && st.prefs.use_profile === false) return { text: null, disabled: true };
    const key = uid + "|" + lang, c = cache.get(key); if (c && now() - c.at < PROFILE_MS) return c.v;
    const t = TXT[lang] || TXT.ru, lines = [];
    for (const k of await courses(uid, lang)) {
      if (!k.completed && !k.weak.length) continue;
      lines.push(`- ${t.course(k.title, k.completed, k.lessons)}${k.next ? "; " + t.next(k.next) : ""}${k.weak.length ? `; ${t.weakLessons}: ${k.weak.slice(0, 4).map(x => `«${x}»`).join(", ")}` : ""}`);
    }
    const since = new Date(now() - 30 * 864e5).toISOString().slice(0, 10), topics = new Map(), sets = new Map();
    for (const a of (await col("daily_attempts").where("uid", "==", uid).get()).docs.map(d => d.data())) {
      if (a.status !== "done" || a.correct || a.date < since) continue;
      if (!sets.has(a.date)) { const s = await col("daily_sets").doc(a.date).get(); sets.set(a.date, s.exists ? s.data() : null); }
      const q = sets.get(a.date) && sets.get(a.date).questions.find(x => x.id === a.qid); if (!q) continue;
      const tl = (q.i18n && q.i18n[lang] && q.i18n[lang].module_title) || q.module_title; topics.set(tl, (topics.get(tl) || 0) + 1);
    }
    if (topics.size) lines.push(`- ${t.dailyWeak}: ${[...topics].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} (${n})`).join(", ")}`);
    const missed = new Map();
    for (const s of (await col("chart_sessions").where("uid", "==", uid).get()).docs.map(d => d.data()))
      if (s.status === "done" && (s.answered_at || 0) > now() - 30 * 864e5) for (const f of (s.grade && s.grade.missed) || []) missed.set(f, (missed.get(f) || 0) + 1);
    if (missed.size) lines.push(`- ${t.chart}: ${[...missed].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, n]) => `${FACTOR[f] || f} (${n})`).join(", ")}`);
    const v = { text: lines.length ? lines.join("\n").slice(0, 1200) : null, empty_text: t.none, disabled: false };
    cache.set(key, { at: now(), v }); return v;
  }
  /* сводка и заметки — только текущего диалога */
  async function threadMemory(uid, thread) {
    const st = await state(uid);
    return { summary: st.summary && st.summary.thread_id === thread ? st.summary.text : null,
      summary_upto: st.summary && st.summary.thread_id === thread ? st.summary.upto_at : 0,
      chartNotes: (st.chart_notes || []).filter(n => n.thread_id === thread).map(n => n.note) };
  }
  /* обновление сводки: только если за пределами окна накопилось SUMMARY_EVERY сообщений */
  async function maybeSummarize(uid, thread, all, windowSize, summarizer) {
    const mem = await threadMemory(uid, thread), older = all.slice(0, Math.max(0, all.length - windowSize)).filter(m => (m.at || 0) > (mem.summary_upto || 0));
    if (older.length < SUMMARY_EVERY) return { updated: false };
    const text = await summarizer(mem.summary, older); if (!text) return { updated: false };
    await db.runTransaction(async tx => { const s = await tx.get(ref(uid)), cur = s.exists ? s.data() : {};
      tx.set(ref(uid), { ...cur, summary: { thread_id: thread, text: String(text).slice(0, 1500), upto_at: older[older.length - 1].at, updated_at: now() } }); });
    return { updated: true };
  }
  async function addChartNote(uid, thread, note) {
    const clean = String(note || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 600); if (!clean) return;
    await db.runTransaction(async tx => { const s = await tx.get(ref(uid)), cur = s.exists ? s.data() : {};
      const notes = [...(cur.chart_notes || []).filter(n => n.thread_id === thread), { thread_id: thread, note: clean, at: now() }].slice(-MAX_NOTES);
      tx.set(ref(uid), { ...cur, chart_notes: notes }); });
  }
  async function forget(uid) {
    await db.runTransaction(async tx => { const s = await tx.get(ref(uid)), cur = s.exists ? s.data() : {}; const { summary, chart_notes, ...rest } = cur; tx.set(ref(uid), { ...rest, forgotten_at: now() }); });
    for (const k of [...cache.keys()]) if (k.startsWith(uid + "|")) cache.delete(k);
    return { ok: true };
  }
  async function setUseProfile(uid, on) {
    await db.runTransaction(async tx => { const s = await tx.get(ref(uid)), cur = s.exists ? s.data() : {}; tx.set(ref(uid), { ...cur, prefs: { ...(cur.prefs || {}), use_profile: !!on } }); });
    for (const k of [...cache.keys()]) if (k.startsWith(uid + "|")) cache.delete(k);
    return { use_profile: !!on };
  }
  async function view(uid, lang, thread) {
    const st = await state(uid), mem = await threadMemory(uid, thread), p = await profile(uid, lang);
    return { use_profile: !(st.prefs && st.prefs.use_profile === false), profile: p.text, profile_empty: p.empty_text || null, summary: mem.summary, chart_notes: mem.chartNotes };
  }
  return { profile, threadMemory, maybeSummarize, addChartNote, forget, setUseProfile, view, SUMMARY_EVERY };
}
module.exports = { createMemory, SUMMARY_EVERY, MAX_NOTES };
