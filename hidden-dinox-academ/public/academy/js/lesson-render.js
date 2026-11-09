/* HIDDEN DINOX ACADEMY — отображение уроков (общий модуль для академии и предпросмотра в админ-панели).
   Весь пользовательский текст экранируется; разрешена только упрощённая разметка:
   **жирный**, *курсив*, списки «- » и «1. », ссылки [текст](https://…). HTML из контента не выполняется. */
(function () {
  /* Тексты интерфейса уроков: RU / EN / UA. Содержание урока переводит сервер (поле tr). */
  const UI = {
    ru: { chartFoot: "Учебная схема · синтетические данные · не котировка", chartAria: "Учебный график", correct: "Корректно", wrong: "Ошибка", practice: "Практика", video: "Видео", openVideo: "Открыть видео ↗",
      important: "Важно", mistake: "Типичная ошибка", editorial: "Редакционное дополнение", source: "Источник", risk: "Риск", summary: "Итог урока", example: "Пример ситуации", homework: "Домашнее задание",
      criteria: "Критерии выполнения", quizHead: "Тест · проходной балл {p}%", check: "Проверить ответы", right: "✓ Верно", wrongAns: "✗ Неверно. Правильный ответ: «{a}»",
      result: "Результат: {s} из {t} ({p}%) — {v}", passed: "тест пройден", retry: "попробуйте ещё раз", outcome: "Результат урока:", sourceP: "Источник: {s}", answerAll: "Ответьте на все вопросы", checkFail: "Не удалось проверить ответы", openPdf: "Открыть PDF" },
    en: { chartFoot: "Training diagram · synthetic data · not a quote", chartAria: "Training chart", correct: "Correct", wrong: "Mistake", practice: "Practice", video: "Video", openVideo: "Open video ↗",
      important: "Important", mistake: "Typical mistake", editorial: "Editorial note", source: "Source", risk: "Risk", summary: "Lesson summary", example: "Example situation", homework: "Homework",
      criteria: "Completion criteria", quizHead: "Test · pass mark {p}%", check: "Check answers", right: "✓ Correct", wrongAns: "✗ Incorrect. Correct answer: “{a}”",
      result: "Result: {s} of {t} ({p}%) — {v}", passed: "test passed", retry: "try again", outcome: "Lesson outcome:", sourceP: "Source: {s}", answerAll: "Answer all the questions", checkFail: "Couldn’t check the answers", openPdf: "Open PDF" },
    ua: { chartFoot: "Навчальна схема · синтетичні дані · не котирування", chartAria: "Навчальний графік", correct: "Коректно", wrong: "Помилка", practice: "Практика", video: "Відео", openVideo: "Відкрити відео ↗",
      important: "Важливо", mistake: "Типова помилка", editorial: "Редакційне доповнення", source: "Джерело", risk: "Ризик", summary: "Підсумок уроку", example: "Приклад ситуації", homework: "Домашнє завдання",
      criteria: "Критерії виконання", quizHead: "Тест · прохідний бал {p}%", check: "Перевірити відповіді", right: "✓ Правильно", wrongAns: "✗ Неправильно. Правильна відповідь: «{a}»",
      result: "Результат: {s} з {t} ({p}%) — {v}", passed: "тест пройдено", retry: "спробуйте ще раз", outcome: "Результат уроку:", sourceP: "Джерело: {s}", answerAll: "Дайте відповідь на всі запитання", checkFail: "Не вдалося перевірити відповіді", openPdf: "Відкрити PDF" }
  };
  let LANG = "ru";
  const tt = (k, v) => { let x = (UI[LANG] && UI[LANG][k]) || UI.ru[k] || k; if (v) for (const [a, b] of Object.entries(v)) x = x.replace("{" + a + "}", b); return x; };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function inline(s) {
    return esc(s)
      .replace(/\[([^\]]{1,200})\]\((https:\/\/[^\s)]{1,500})\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(«])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  }
  function md(text) {
    const out = []; let list = null;
    const flush = () => { if (list) { out.push(`<${list.t}>${list.items.map(i => `<li>${inline(i)}</li>`).join("")}</${list.t}>`); list = null; } };
    for (const para of String(text || "").split(/\n{2,}/)) {
      const lines = para.split("\n"); let buf = [];
      const pushP = () => { if (buf.length) { out.push(`<p>${buf.map(inline).join("<br>")}</p>`); buf = []; } };
      for (const line of lines) {
        const ul = line.match(/^\s*[-•—]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ul || ol) { pushP(); const t = ul ? "ul" : "ol"; if (!list || list.t !== t) { flush(); list = { t, items: [] }; } list.items.push((ul || ol)[1]); }
        else { flush(); buf.push(line); }
      }
      pushP(); flush();
    }
    return out.join("");
  }

  /* ---- Учебный свечной график (SVG) ---- */
  const TONE = { neutral: "#8a9187", good: "#8bea24", bad: "#ff6b5e", accent: "#e8b93b" };
  function chartSVG(spec) {
    // В базе свеча — объект {o,h,l,c} (Firestore не хранит массивы в массивах); в JSON курса — [o,h,l,c]
    const cs = (spec.candles || []).map(k => Array.isArray(k) ? k : [k.o, k.h, k.l, k.c]), n = cs.length; if (!n) return "";
    const W = 360, H = 240, top = 46, bottom = 26, left = 10, right = 10;
    let lo = Infinity, hi = -Infinity;
    for (const [o, h, l, c] of cs) { lo = Math.min(lo, l); hi = Math.max(hi, h); }
    for (const a of spec.annotations || []) { if (a.type === "hline") { lo = Math.min(lo, a.price); hi = Math.max(hi, a.price); } if (a.type === "trend") { lo = Math.min(lo, a.p1, a.p2); hi = Math.max(hi, a.p1, a.p2); } }
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    const step = (W - left - right) / n, bw = Math.max(2, Math.min(14, step * 0.62));
    const X = i => left + step * i + step / 2, Y = p => top + (hi - p) / (hi - lo) * (H - top - bottom);
    const parts = [];
    // зоны — под свечами
    let zoneRow = 0;
    for (const a of spec.annotations || []) if (a.type === "zone") {
      const x1 = X(Math.min(a.from, a.to)) - step / 2, x2 = X(Math.max(a.from, a.to)) + step / 2, col = TONE[a.tone] || TONE.neutral;
      parts.push(`<rect x="${x1.toFixed(1)}" y="${top - 4}" width="${(x2 - x1).toFixed(1)}" height="${H - top - bottom + 8}" rx="4" fill="${col}" fill-opacity=".09" stroke="${col}" stroke-opacity=".45" stroke-dasharray="3 3"/>`);
      // Пронумерованные зоны («1. Замедление») — на графике только номер, полное название в легенде
      const num = String(a.text || "").match(/^(\d+)[.)]\s*/);
      const cx = ((x1 + x2) / 2).toFixed(1);
      if (num) parts.push(`<circle cx="${cx}" cy="${top - 14}" r="9" fill="${col}" fill-opacity=".18" stroke="${col}"/><text x="${cx}" y="${top - 10}" text-anchor="middle" font-size="11" font-weight="800" fill="${col}">${num[1]}</text>`);
      else if (a.text) { const ty = 13 + (zoneRow++ % 2) * 14; parts.push(`<text x="${cx}" y="${ty}" text-anchor="middle" font-size="10" font-weight="700" fill="${col}" paint-order="stroke" stroke="#050605" stroke-width="3">${esc(a.text)}</text>`); }
    }
    for (const a of spec.annotations || []) if (a.type === "hline") {
      const y = Y(a.price).toFixed(1);
      parts.push(`<line x1="${left}" x2="${W - right}" y1="${y}" y2="${y}" stroke="#c9cfc5" stroke-opacity=".7" ${a.dashed ? 'stroke-dasharray="5 4"' : ""}/>`);
      if (a.text) parts.push(`<text x="${W - right - 2}" y="${(+y - 4).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#c9cfc5">${esc(a.text)}</text>`);
    }
    cs.forEach(([o, h, l, c], i) => {
      const up = c >= o, col = up ? "#e9eee6" : "#ff6b5e", x = X(i);
      parts.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${Y(h).toFixed(1)}" y2="${Y(l).toFixed(1)}" stroke="${col}" stroke-width="1.2"/>`);
      const y1 = Y(Math.max(o, c)), y2 = Y(Math.min(o, c));
      parts.push(`<rect x="${(x - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1.2, y2 - y1).toFixed(1)}" rx="1" fill="${col}"/>`);
    });
    for (const a of spec.annotations || []) if (a.type === "trend") parts.push(`<line x1="${X(a.from).toFixed(1)}" y1="${Y(a.p1).toFixed(1)}" x2="${X(a.to).toFixed(1)}" y2="${Y(a.p2).toFixed(1)}" stroke="#8bea24" stroke-width="1.4" stroke-dasharray="6 4" stroke-opacity=".8"/>`);
    for (const a of spec.annotations || []) if (a.type === "marker") {
      const [o, h, l] = cs[a.at], x = X(a.at), col = TONE[a.tone] || TONE.accent, above = a.pos !== "below";
      const y0 = above ? Y(h) - 6 : Y(l) + 6;
      const y1 = above ? Math.max(top + 4, y0 - 16) : Math.min(H - bottom - 2, y0 + 16);   // не заходить в полосу подписей зон
      parts.push(`<line x1="${x.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${col}" stroke-width="1.4"/><circle cx="${x.toFixed(1)}" cy="${y0.toFixed(1)}" r="2.6" fill="${col}"/>`);
      const anchor = x < W * 0.2 ? "start" : x > W * 0.8 ? "end" : "middle";
      if (a.text) parts.push(`<text x="${x.toFixed(1)}" y="${(above ? Math.max(top + 2, y1 - 4) : Math.min(H - bottom + 8, y1 + 11)).toFixed(1)}" text-anchor="${anchor}" font-size="10" font-weight="700" fill="${col}" paint-order="stroke" stroke="#050605" stroke-width="3">${esc(a.text)}</text>`);
    }
    parts.push(`<text x="${W / 2}" y="${H - 6}" text-anchor="middle" font-size="9" fill="#6f766d">${esc(tt("chartFoot"))}</text>`);
    return `<svg class="hdl-chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title || tt("chartAria"))}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
  }
  function chartFigure(spec, role) {
    const badge = role === "correct" ? `<span class="hdl-badge good">${esc(tt("correct"))}</span>` : role === "incorrect" ? `<span class="hdl-badge bad">${esc(tt("wrong"))}</span>` : role === "practice" ? `<span class="hdl-badge">${esc(tt("practice"))}</span>` : "";
    const legend = (spec.annotations || []).filter(a => a.type === "zone" && a.text).map(a => `<span><i style="background:${TONE[a.tone] || TONE.neutral}"></i>${esc(a.text)}</span>`).join("");
    return `<figure class="hdl-chart">${spec.title ? `<figcaption class="hdl-chart-title">${esc(spec.title)} ${badge}</figcaption>` : badge}${chartSVG(spec)}${legend ? `<div class="hdl-legend">${legend}</div>` : ""}${spec.caption ? `<p class="hdl-caption">${esc(spec.caption)}</p>` : ""}</figure>`;
  }

  function videoEmbed(url) {
    let m = url.match(/^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,20})/);
    if (m) return `<div class="hdl-video"><iframe src="https://www.youtube-nocookie.com/embed/${m[1]}" title="${esc(tt("video"))}" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
    m = url.match(/^https:\/\/(?:www\.)?vimeo\.com\/(\d{5,12})/);
    if (m) return `<div class="hdl-video"><iframe src="https://player.vimeo.com/video/${m[1]}" title="${esc(tt("video"))}" allowfullscreen loading="lazy"></iframe></div>`;
    return `<p><a class="hdl-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(tt("openVideo"))}</a></p>`;
  }
  const mediaUrl = b => b.media_id ? "/media/" + encodeURIComponent(b.media_id) : b.url;
  const NOTE_KEYS = { important: "important", warning: "mistake", editorial: "editorial", source: "source", risk: "risk" };

  function block(b, ctx) {
    switch (b.type) {
      case "heading": return `<h2 class="hdl-h">${esc(b.text)}</h2>`;
      case "text": return `<section class="hdl-text">${b.title ? `<h3>${esc(b.title)}</h3>` : ""}${md(b.text)}</section>`;
      case "summary": return `<section class="hdl-summary"><h3>${esc(b.title || tt("summary"))}</h3>${md(b.text)}</section>`;
      case "terms": return `<section class="hdl-terms">${b.title ? `<h3>${esc(b.title)}</h3>` : ""}<dl>${b.items.map(i => `<dt>${esc(i.term)}</dt><dd>${inline(i.definition)}</dd>`).join("")}</dl></section>`;
      case "image": return `<figure class="hdl-image"><img src="${esc(mediaUrl(b))}" alt="${esc(b.alt || b.caption || "")}" loading="lazy">${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ""}</figure>`;
      case "file": return `<p class="hdl-file"><a href="${esc(mediaUrl(b))}" target="_blank" rel="noopener">📄 ${esc(b.title || b.caption || tt("openPdf"))}</a></p>`;
      case "chart": return chartFigure(b.chart, b.chart_role);
      case "video": return `<section class="hdl-text">${b.title ? `<h3>${esc(b.title)}</h3>` : ""}${videoEmbed(b.url)}${b.caption ? `<p class="hdl-caption">${esc(b.caption)}</p>` : ""}</section>`;
      case "note": return `<aside class="hdl-note ${esc(b.variant)}"><strong>${esc(b.title || (NOTE_KEYS[b.variant] ? tt(NOTE_KEYS[b.variant]) : tt("important")))}</strong>${md(b.text)}</aside>`;
      case "example": return `<section class="hdl-example"><div class="hdl-kicker">${esc(tt("example"))}</div><h3>${esc(b.title)}</h3>${md(b.text)}${b.chart ? chartFigure(b.chart) : ""}</section>`;
      case "practice": return `<section class="hdl-practice"><div class="hdl-kicker">${esc(b.homework ? tt("homework") : tt("practice"))}</div>${b.title ? `<h3>${esc(b.title)}</h3>` : ""}${md(b.task)}${b.chart ? chartFigure(b.chart, "practice") : ""}${b.criteria ? `<details><summary>${esc(tt("criteria"))}</summary>${md(b.criteria)}</details>` : ""}</section>`;
      case "quiz": return quizHTML(b, ctx);
      default: return "";
    }
  }
  function quizHTML(b, ctx) {
    const qs = b.questions.map((q, i) => `<fieldset class="hdl-q" data-i="${i}"><legend>${i + 1}. ${esc(q.q)}</legend>${q.chart ? chartFigure(q.chart) : ""}${q.options.map((o, j) => `<label><input type="radio" name="${esc(b.id)}_${i}" value="${j}"> <span>${esc(o)}</span></label>`).join("")}<div class="hdl-q-res" hidden></div></fieldset>`).join("");
    return `<section class="hdl-quiz" data-block="${esc(b.id)}"><div class="hdl-kicker">${esc(tt("quizHead", { p: b.pass_percent ?? 70 }))}</div>${b.title ? `<h3>${esc(b.title)}</h3>` : ""}${qs}<button type="button" class="hdl-btn" data-quiz-submit>${esc(tt("check"))}</button><div class="hdl-quiz-total" hidden></div></section>`;
  }
  function showQuizResult(section, r) {
    section.querySelectorAll(".hdl-q").forEach((fs, i) => {
      const res = r.results[i], box = fs.querySelector(".hdl-q-res");
      fs.classList.toggle("ok", res.correct); fs.classList.toggle("bad", !res.correct);
      box.hidden = false; box.innerHTML = (res.correct ? tt("right") : tt("wrongAns", { a: esc(fs.querySelectorAll("label span")[res.correct_index].textContent) })) + (res.explanation ? `<div>${inline(res.explanation)}</div>` : "");
    });
    const t = section.querySelector(".hdl-quiz-total"); t.hidden = false;
    t.className = "hdl-quiz-total " + (r.passed ? "ok" : "bad");
    t.textContent = tt("result", { s: r.score, t: r.total, p: r.percent, v: r.passed ? tt("passed") : tt("retry") });
  }
  /* render(container, lesson, { onQuiz(blockId, answers) → Promise<result> }) */
  function render(el, lesson, ctx = {}) {
    el.innerHTML = `<article class="hdl">${lesson.outcome ? `<p class="hdl-outcome"><span>${esc(tt("outcome"))}</span> ${esc(lesson.outcome)}</p>` : ""}${(lesson.blocks || []).map(b => block(b, ctx)).join("")}${lesson.source_pages ? `<p class="hdl-source">${esc(tt("sourceP", { s: lesson.source_pages }))}</p>` : ""}</article>`;
    el.querySelectorAll(".hdl-quiz").forEach(sec => {
      sec.querySelector("[data-quiz-submit]").onclick = async () => {
        const answers = [...sec.querySelectorAll(".hdl-q")].map(fs => { const c = fs.querySelector("input:checked"); return c ? Number(c.value) : null; });
        if (answers.some(a => a === null)) { const t = sec.querySelector(".hdl-quiz-total"); t.hidden = false; t.className = "hdl-quiz-total bad"; t.textContent = tt("answerAll"); return; }
        const btn = sec.querySelector("[data-quiz-submit]"); btn.disabled = true;
        try { const r = await ctx.onQuiz(sec.dataset.block, answers); showQuizResult(sec, r); if (ctx.afterQuiz) ctx.afterQuiz(r); }
        catch (e) { const t = sec.querySelector(".hdl-quiz-total"); t.hidden = false; t.className = "hdl-quiz-total bad"; t.textContent = (e && e.message) || tt("checkFail"); }
        finally { btn.disabled = false; }
      };
    });
  }
  /* Локальная проверка (только предпросмотр в админ-панели, где ответы известны) */
  function gradeLocally(lesson, blockId, answers) {
    const b = (lesson.blocks || []).find(x => x.type === "quiz" && x.id === blockId);
    const results = b.questions.map((q, i) => ({ correct: answers[i] === q.correct, correct_index: q.correct, explanation: q.explanation || "" }));
    const score = results.filter(r => r.correct).length, percent = Math.round(score * 100 / results.length);
    return { score, total: results.length, percent, passed: percent >= (b.pass_percent ?? 70), results };
  }
  window.HDLesson = { setLang: l => { LANG = UI[l] ? l : "ru"; }, render, md, inline, esc, chartSVG, chartFigure, gradeLocally };
})();
