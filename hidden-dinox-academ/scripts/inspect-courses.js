#!/usr/bin/env node
"use strict";
/* Диагностика курсов в Firestore — ТОЛЬКО ЧТЕНИЕ. Требуется FIREBASE_KEY.
   node scripts/inspect-courses.js
   Показывает по каждому курсу: статус, модули и число уроков в каждом, уроки без модуля,
   опубликованный снимок. Помогает понять, почему модули выглядят пустыми. */
const admin = require("firebase-admin");
const { initFirebase } = require("../academy/firebase-init");
(async () => {
  const { db, reason } = initFirebase({ admin, log: { log() {}, error: m => console.error(m) } });
  if (!db) { console.error("Firebase не подключён: " + reason); process.exit(2); }
  const all = async c => (await db.collection(c).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const [courses, modules, lessons, pubC, pubL] = await Promise.all(["courses", "course_modules", "course_lessons", "published_courses", "published_lessons"].map(all));
  if (!courses.length) console.log("Курсов в базе нет.");
  for (const c of courses) {
    const ms = modules.filter(m => m.course_id === c.id).sort((a, b) => (a.order || 0) - (b.order || 0));
    const ls = lessons.filter(l => l.course_id === c.id);
    const orphans = ls.filter(l => !ms.some(m => m.id === l.module_id));
    const pub = pubC.find(p => p.id === c.id);
    console.log(`\nКурс «${c.title}» (${c.id}) — статус ${c.status || "?"}${c.imported ? ", импортирован" : ""}, создан ${c.created_at ? new Date(c.created_at).toISOString() : "?"}`);
    for (const m of ms) { const n = ls.filter(l => l.module_id === m.id); console.log(`  модуль «${m.title}»: уроков ${n.length} (готовы к публикации: ${n.filter(l => l.status === "ready").length})`); }
    if (orphans.length) console.log(`  ⚠ уроков без существующего модуля: ${orphans.length}`);
    console.log(pub ? `  опубликован: версия ${pub.version || "?"}, уроков в снимке ${pubL.filter(l => l.course_id === c.id).length}` : "  не опубликован");
  }
  const strayMods = modules.filter(m => !courses.some(c => c.id === m.course_id));
  if (strayMods.length) console.log(`\n⚠ модулей без курса: ${strayMods.length}`);
  process.exit(0);
})().catch(e => { console.error("Ошибка:", e.message); process.exit(1); });
