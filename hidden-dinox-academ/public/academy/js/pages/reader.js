/* HIDDEN DINOX ACADEMY — встроенная читалка оригинального PDF книги (PDF.js встроен локально: ../vendor/pdfjs).
   PDF и прогресс — только через сервер (вход + доступ к академии). */
import * as pdfjsLib from "../../vendor/pdfjs/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

const SLUG = "hidden-reaction-system";
const $ = id => document.getElementById(id);
const canvas = $("page"), stage = $("stage"), msg = $("msg");
let doc = null, pageNo = 1, zoom = 1, rendering = null, queued = null, saveT = null;

function applyTexts() {
  document.documentElement.lang = lang === "ua" ? "uk" : lang;
  document.querySelectorAll("[data-t]").forEach(e => (e.textContent = t(e.dataset.t)));
  document.querySelectorAll("[data-tl]").forEach(e => { e.setAttribute("aria-label", t(e.dataset.tl)); e.title = t(e.dataset.tl); });
}
/* Книга есть только в русской версии 1.0 — при EN/UA честно сообщаем, а не выдаём её за перевод */
// Версия книги на языке интерфейса; если её нет — честно сообщаем и открываем оригинал
let bookLang = "ru";
function langNotice(available) { if (lang !== "ru" && !available.includes(lang) && !document.getElementById("rdLang")) { const n = document.createElement("p"); n.id = "rdLang"; n.className = "rd-lang"; n.textContent = t("readerOnlyRu"); document.querySelector(".rd-top").appendChild(n); } }
function showMsg(html, spin) { msg.hidden = false; canvas.hidden = true; msg.innerHTML = (spin ? '<span class="rd-spin" aria-hidden="true"></span>' : "") + html; }
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function updateBar() {
  $("num").value = pageNo; $("num").max = doc ? doc.numPages : 1;
  $("of").textContent = "/ " + (doc ? doc.numPages : "—");
  $("prev").disabled = !doc || pageNo <= 1; $("next").disabled = !doc || pageNo >= doc.numPages;
}
async function render(n) {
  if (!doc) return;
  if (rendering) { queued = n; return; }
  pageNo = Math.min(Math.max(1, n), doc.numPages); updateBar();
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const fit = Math.max(0.2, (stage.clientWidth - 20) / base.width);          // по ширине экрана, без горизонтальной прокрутки при zoom=1
  const vp = page.getViewport({ scale: fit * zoom });
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = Math.floor(vp.width) + "px"; canvas.style.height = Math.floor(vp.height) + "px";
  const ctx = canvas.getContext("2d");
  rendering = page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
  try { await rendering.promise; } finally { rendering = null; }
  msg.hidden = true; canvas.hidden = false; stage.scrollTop = 0;
  document.body.dataset.page = String(pageNo);
  if (queued !== null) { const q = queued; queued = null; render(q); }
  clearTimeout(saveT); saveT = setTimeout(saveProgress, 700);               // сохранение последней страницы
}
async function saveProgress() { try { await call("PUT", `/api/learn/books/${SLUG}/progress`, { page: pageNo }); } catch (e) { /* не мешаем чтению */ } }

async function open() {
  applyTexts(); showMsg(`<span>${esc(t("readerLoading"))}</span>`, true);
  let start = 1;
  try {
    const f = await fb(); if (!f.auth.currentUser) return location.replace("/");
    const [p, list] = await Promise.all([call("GET", `/api/learn/books/${SLUG}/progress`), call("GET", "/api/learn/books").catch(() => ({ books: [] }))]);
    start = p.page || 1;
    const info = (list.books || []).find(x => x.slug === SLUG); const available = info ? info.languages : ["ru"];
    bookLang = available.includes(lang) ? lang : "ru"; langNotice(available);
    document.body.dataset.bookLang = bookLang;
  } catch (e) {
    if (e && e.code === "UNAUTHENTICATED") return location.replace("/");
    if (e && e.code === "NO_ACCESS") return showMsg(`<span>${esc(t("readerNoAccess"))}</span><a href="academy.html">${esc(t("readerBack"))}</a>`);
    return showMsg(`<span>${esc(t("readerError"))}</span><a href="reader.html">${esc(t("retry"))}</a>`);
  }
  try {
    const token = await idToken();
    doc = await pdfjsLib.getDocument({ url: `/api/learn/books/${SLUG}/file?lang=${bookLang}`, httpHeaders: { Authorization: "Bearer " + token }, rangeChunkSize: 262144, disableAutoFetch: true }).promise;
    await render(Math.min(start, doc.numPages));
  } catch (e) {
    console.error("reader: не удалось открыть PDF:", e && (e.name + ": " + e.message));   // для диагностики; без данных пользователя
    showMsg(`<span>${esc(t("readerError"))}</span><a href="reader.html">${esc(t("retry"))}</a>`);
  }
}
$("prev").onclick = () => render(pageNo - 1);
$("next").onclick = () => render(pageNo + 1);
$("goto").onsubmit = e => { e.preventDefault(); const n = parseInt($("num").value, 10); if (Number.isFinite(n)) render(n); };
$("zin").onclick = () => { zoom = Math.min(4, +(zoom * 1.25).toFixed(3)); render(pageNo); };
$("zout").onclick = () => { zoom = Math.max(0.5, +(zoom / 1.25).toFixed(3)); render(pageNo); };
$("zfit").onclick = () => { zoom = 1; render(pageNo); };
$("fs").onclick = () => { const el = $("rd"); if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen().catch(() => {}); };
document.addEventListener("fullscreenchange", () => setTimeout(() => render(pageNo), 60));
document.addEventListener("keydown", e => { if (e.target.tagName === "INPUT") return; if (e.key === "ArrowRight" || e.key === "PageDown") render(pageNo + 1); if (e.key === "ArrowLeft" || e.key === "PageUp") render(pageNo - 1); });
let sx = null; stage.addEventListener("touchstart", e => { sx = e.touches.length === 1 && zoom <= 1 ? e.touches[0].clientX : null; }, { passive: true });
stage.addEventListener("touchend", e => { if (sx === null) return; const dx = e.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) > 60) render(pageNo + (dx < 0 ? 1 : -1)); }, { passive: true });
let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => render(pageNo), 150); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && doc) saveProgress(); });
open();
