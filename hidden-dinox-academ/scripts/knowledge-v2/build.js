"use strict";
/* Сборка базы знаний Hidden Dinox v2 из реальных исходников (исходные файлы только читаются).
   node scripts/knowledge-v2/build.js → content/knowledge/v2/{courses-hr,courses-smc,courses-rm,book,project}.json + build-report.json
   Курсы переводятся той же функцией, что показывает уроки ученикам (academy/content.js) — текст совпадает с уроками. */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.resolve(__dirname, "../.."), OUT = path.join(ROOT, "content/knowledge/v2");
const C = require(path.join(ROOT, "academy/content"));
const { validateRecord, KB_VERSION } = require(path.join(ROOT, "academy/knowledge-v2"));
const LANGS = ["ru", "en", "ua"];
const sha = s => crypto.createHash("sha1").update(s).digest("hex");
const clean = s => String(s == null ? "" : s).replace(/[\u200b-\u200f\u2060\ufeff]/g, "").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
const COURSES = [
  { key: "hr", file: "content/hidden-reaction-course.json", out: "courses-hr.json" },
  { key: "smc", file: "content/binary/smart_money_concepts_binary.json", out: "courses-smc.json" },
  { key: "rm", file: "content/binary/risk_management_binary.json", out: "courses-rm.json" }
];
/* раздел по типу блока и его русскому заголовку (одинаков для всех языков) */
function sectionOf(b) {
  const t = String(b.title || "").toLowerCase();
  if (b.type === "terms") return "definitions";
  if (b.type === "quiz") return "faq";
  if (b.type === "practice") return "practice";
  if (b.type === "summary") return "summary";
  if (b.type === "example" || b.type === "chart") return "example";
  if (b.type === "heading") return null;
  if (/алгоритм/.test(t)) return "algorithm";
  if (/цел[ьи] урока|цель/.test(t)) return "goal";
  if (/не работает|огранич/.test(t)) return "limits";
  if (/ошибк/.test(t)) return "mistakes";
  if (/главная мысль|ключев/.test(t)) return "key_idea";
  if (/^источник/.test(t)) return "source_note";
  return "explanation";
}
const SECTION_TITLE = { ru: { goal: "Цели урока", explanation: "Объяснение", algorithm: "Пошаговый алгоритм", definitions: "Ключевые понятия", example: "Примеры", limits: "Когда метод не работает", mistakes: "Типичные ошибки", key_idea: "Главная мысль", practice: "Практическое задание", faq: "Вопросы и ответы", summary: "Итоги урока", source_note: "Источник" },
  en: { goal: "Lesson goals", explanation: "Explanation", algorithm: "Step-by-step algorithm", definitions: "Key concepts", example: "Examples", limits: "When the method does not work", mistakes: "Common mistakes", key_idea: "Main idea", practice: "Practice task", faq: "Questions and answers", summary: "Lesson summary", source_note: "Source" },
  ua: { goal: "Цілі уроку", explanation: "Пояснення", algorithm: "Покроковий алгоритм", definitions: "Ключові поняття", example: "Приклади", limits: "Коли метод не працює", mistakes: "Типові помилки", key_idea: "Головна думка", practice: "Практичне завдання", faq: "Запитання та відповіді", summary: "Підсумки уроку", source_note: "Джерело" } };
const BOOK_REF = /^\s*(стр|с)\.?\s*[\d\s,–\-]+\.?\s*$/i;
const PAGE_WORD = { ru: "см. книгу «The Hidden Reaction System», стр.", en: "see the book “The Hidden Reaction System”, p.", ua: "див. книгу «The Hidden Reaction System», с." };
function blockText(b, lang) {
  switch (b.type) {
    case "terms": return (b.items || []).map(i => `${clean(i.term)} — ${clean(i.definition)}`).join("\n");
    case "practice": return [b.task, b.criteria, b.homework].map(clean).filter(Boolean).join("\n");
    case "quiz": return (b.questions || []).map(q => { const ex = clean(q.explanation);
      const why = BOOK_REF.test(ex) ? `${PAGE_WORD[lang]} ${ex.replace(/^\s*(стр|с)\.?\s*/i, "").replace(/\.$/, "")}` : ex;
      return `${clean(q.q)}\n→ ${clean(q.options[q.correct])}${why ? `. ${why}` : ""}`; }).join("\n\n");
    case "chart": return clean(b.chart && (b.chart.caption || b.chart.title) || "");
    default: return [b.title && b.type !== "note" && b.type !== "text" ? "" : "", clean(b.text)].filter(Boolean).join("\n");
  }
}
/* «книга, стр. 3, 5–6» → [3, 5, 6] (исходная строка сохраняется отдельно) */
function pagesList(s) { const out = []; for (const m of String(s || "").matchAll(/(\d+)\s*[–-]\s*(\d+)|(\d+)/g)) { if (m[3]) out.push(+m[3]); else for (let p = +m[1]; p <= +m[2] && p - +m[1] < 20; p++) out.push(p); } return out; }
function record(base) { const r = { kb_version: KB_VERSION, ...base, content: clean(base.content) }; r.checksum = sha(r.title + "\n" + r.content); return r; }
const records = { hr: [], smc: [], rm: [], book: [], project: [] }, report = { sources: [], skipped: [], errors: [] };
for (const cdef of COURSES) {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, cdef.file), "utf8")), slug = d.course.slug;
  report.sources.push({ file: cdef.file, sha1: sha(fs.readFileSync(path.join(ROOT, cdef.file))) });
  d.modules.forEach((m0, mi) => m0.lessons.forEach((l0, li) => {
    const lessonKey = `${slug}#m${mi}l${li}`, modLessons = m0.lessons.map((x, j) => `${slug}#m${mi}l${j}`).filter(k => k !== lessonKey);
    for (const lang of LANGS) {
      const course = C.localize(C.withTr(d.course, "course"), lang).doc, mod = C.localize(C.withTr(m0, "module"), lang).doc, l = C.localize(C.withTr(l0, "lesson"), lang).doc;
      const ts = lang === "ru" ? "original" : "existing";
      const base = { authority: "official_hidden_dinox", source_type: "course", course: cdef.key, course_slug: slug, course_title: clean(course.title), module_index: mi, module_title: clean(mod.title),
        lesson_index: li, lesson_key: lessonKey, lesson_title: clean(l.title), lesson_kind: /^(тест|итоговый тест|итоговый экзамен)/i.test(l0.title) ? "test" : "lesson", language: lang, verified: true, translation_status: ts, status: "published", related: modLessons };
      const groups = new Map();
      l.blocks.forEach((b, bi) => { const sec = sectionOf(l0.blocks[bi]); if (!sec) return; const txt = blockText(b, lang); if (!txt) return;
        const g = groups.get(sec) || { parts: [], blocks: [] }; g.parts.push(txt); g.blocks.push(l0.blocks[bi].id || `b${bi}`); groups.set(sec, g); });
      if (l.outcome && !groups.has("goal")) groups.set("goal", { parts: [clean(l.outcome)], blocks: ["outcome"] });
      for (const [sec, g] of groups) {
        records[cdef.key].push(record({ ...base, id: "kb2_" + sha(`${lessonKey}|${sec}|${lang}`).slice(0, 16), type: "lesson_section", section: sec,
          title: `${clean(l.title)} — ${SECTION_TITLE[lang][sec]}`, content: g.parts.join("\n\n"), tags: [cdef.key, sec],
          provenance: { source_file: cdef.file, course_slug: slug, module_index: mi, lesson_index: li, block_ids: g.blocks, source_pages: l0.source_pages || null, book_pages: pagesList(l0.source_pages) } }));
      }
      // отдельная запись на каждый термин из «Ключевых понятий» — точные ответы на «что такое X»
      l.blocks.forEach((b, bi) => { if (b.type !== "terms") return;
        (b.items || []).forEach((it, ii) => { if (!clean(it.term) || !clean(it.definition)) return;
          records[cdef.key].push(record({ ...base, id: "kb2_" + sha(`${lessonKey}|term|${bi}|${ii}|${lang}`).slice(0, 16), type: "definition", section: "definitions",
            title: clean(it.term), content: `${clean(it.term)} — ${clean(it.definition)}`, tags: [cdef.key, "definition"],
            provenance: { source_file: cdef.file, course_slug: slug, module_index: mi, lesson_index: li, block_ids: [l0.blocks[bi].id || `b${bi}`], item_index: ii } })); }); });
    }
  }));
}
/* книга: страницы с текстом, без обложки и оглавления */
for (const lang of LANGS) {
  const f = `content/knowledge/v2/sources/book-${lang}.json`, b = JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
  for (const p of b.pages) {
    const sec = clean(p.section || ""), txt = clean(p.text);
    if (/CONTENTS|CREATED BY/i.test(sec) || txt.length < 40) { report.skipped.push({ file: f, page: p.page, reason: /CONTENTS/i.test(sec) ? "оглавление" : /CREATED BY/i.test(sec) ? "обложка" : "мало текста" }); continue; }
    records.book.push(record({ id: "kb2_" + sha(`book|${lang}|${p.page}`).slice(0, 16), type: "book_page", section: "book", authority: "official_hidden_dinox", source_type: "book", course: "hr",
      course_slug: "hidden-reaction-system", course_title: "The Hidden Reaction System", module_title: sec, title: `${sec} — ${lang === "en" ? "p." : lang === "ua" ? "с." : "стр."} ${p.page}`,
      content: txt, language: lang, verified: true, translation_status: lang === "ru" ? "original" : "existing", status: "published", tags: ["hr", "book"],
      provenance: { source_file: b.meta.source_file, page: p.page, pdf_sha1: b.meta.sha1 } }));
  }
}
/* сведения о проекте — только заявления владельца; EN/UA — черновые переводы */
const pf = JSON.parse(fs.readFileSync(path.join(ROOT, "content/knowledge/v2/sources/project-facts.json"), "utf8"));
for (const f of pf.facts) for (const lang of LANGS) {
  const ru = lang === "ru";
  records.project.push(record({ id: "kb2_" + sha(`project|${f.key}|${lang}`).slice(0, 16), type: "project_fact", section: "project", authority: "official_hidden_dinox", source_type: "owner_statement",
    course: "project", title: f.title[lang], content: f.content[lang], language: lang, verified: ru, translation_status: ru ? "original" : "draft", status: ru ? "published" : "draft",
    tags: f.tags, provenance: { source_file: "content/knowledge/v2/sources/project-facts.json", key: f.key, statement: pf.meta.source } }));
}
/* проверка схемы и дублей, запись */
const all = Object.values(records).flat(), ids = new Set(), sums = new Map();
for (const r of all) {
  const err = validateRecord(r); if (err) report.errors.push({ id: r.id, error: err });
  if (ids.has(r.id)) report.errors.push({ id: r.id, error: "повторяющийся id" }); ids.add(r.id);
  const k = r.language + "|" + r.checksum; if (sums.has(k) && r.type !== "definition") report.skipped.push({ id: r.id, reason: "дубль содержания", same_as: sums.get(k) }); sums.set(k, r.id);
}
if (report.errors.length) { console.error("ОШИБКИ СХЕМЫ:", JSON.stringify(report.errors.slice(0, 5), null, 1)); process.exit(1); }
const files = { hr: "courses-hr.json", smc: "courses-smc.json", rm: "courses-rm.json", book: "book.json", project: "project.json" };
for (const [k, f] of Object.entries(files)) fs.writeFileSync(path.join(OUT, f), JSON.stringify({ kb_version: KB_VERSION, records: records[k] }, null, 1));
const count = (arr, key) => arr.reduce((m, r) => (m[r[key]] = (m[r[key]] || 0) + 1, m), {});
report.totals = { records: all.length, by_file: Object.fromEntries(Object.entries(records).map(([k, v]) => [files[k], v.length])), by_language: count(all, "language"), by_type: count(all, "type"),
  by_section: count(all, "section"), by_translation_status: count(all, "translation_status"), by_status: count(all, "status"), verified: all.filter(r => r.verified).length, unverified: all.filter(r => !r.verified).length };
fs.writeFileSync(path.join(OUT, "build-report.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.totals, null, 1)); console.log("пропущено:", report.skipped.length, JSON.stringify(report.skipped.slice(0, 4)));
