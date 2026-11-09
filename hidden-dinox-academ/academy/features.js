"use strict";
/* Карточки функций Academy (AI Mentor, Daily Tests, Chart Training и дополнительные) — управляются из админки без деплоя.
   Хранение: academy_features/{id}. Три стандартные карточки заданы здесь (DEFAULTS) и попадают в базу только после правки;
   «Вернуть стандартные» = удалить сохранённые правки стандартных карточек (дополнительные карточки не трогаются).
   Ссылки карточек — ТОЛЬКО модули из реестра MODULES (в коде): произвольных адресов нет, неизвестный маршрут недоступен.
   Статус ACTIVE разрешён лишь для модуля, у которого есть реализованная страница (href). API модулей проверяют requireFeature(). */
const C = require("./content");
const STATUSES = ["ACTIVE", "COMING_SOON", "IN_DEVELOPMENT", "DISABLED"];
const ICONS = ["mentor", "tests", "chart", "book", "star", "bell", "target", "shield"];
const LANGS = ["ru", "en", "ua"];
// Реестр модулей: ключ → страница. href = null — модуль ещё не реализован (статус «Открыть» недоступен).
// При реализации модуля разработчик указывает здесь его страницу — тогда администратор сможет включить ACTIVE.
const MODULES = {
  "mentor": { label: "AI Mentor", href: "/academy/mentor.html" },   // реализован (этап C)
  "daily-tests": { label: "Daily Tests", href: "/academy/daily-tests.html" },   // реализован (этап 2)
  "chart-training": { label: "Chart Training", href: "/academy/chart-training.html" },   // реализован (этап 3)
  "pre-trade": { label: "Pre-Trade Routine", href: "/academy/pre-trade.html" }            // реализован (этап 4)
};
const T3 = (ru, en, ua) => ({ ru, en, ua });
const DEFAULTS = [
  { id: "ai_mentor", order: 1, icon: "mentor", module: "mentor", status: "COMING_SOON", enabled: true, disabled_display: "hide", show_on_dashboard: true,
    title: T3("ИИ-помощник", "AI Mentor", "ШІ-помічник"),
    description: T3("Персональный помощник: повторение Hidden Reaction, SMC и Risk Management перед торговой сессией.",
      "Your personal assistant: review Hidden Reaction, SMC and Risk Management before a trading session.",
      "Персональний помічник: повторення Hidden Reaction, SMC і Risk Management перед торговою сесією."),
    button: T3("Открыть", "Open", "Відкрити") },
  { id: "daily_tests", order: 2, icon: "tests", module: "daily-tests", status: "COMING_SOON", enabled: true, disabled_display: "hide", show_on_dashboard: true,
    title: T3("Ежедневные тесты", "Daily Tests", "Щоденні тести"),
    description: T3("Пять новых заданий каждый день в 00:00 по Берлину по курсам Hidden Reaction, Smart Money Concepts и Risk Management.",
      "Five new tasks every day at 00:00 Berlin time: Hidden Reaction, SMC and Risk Management.",
      "П’ять нових завдань щодня о 00:00 за Берліном за курсами Hidden Reaction, Smart Money Concepts і Risk Management."),
    button: T3("Открыть", "Open", "Відкрити") },
  { id: "chart_training", order: 3, icon: "chart", module: "chart-training", status: "COMING_SOON", enabled: true, disabled_display: "hide", show_on_dashboard: false,
    title: T3("Тренировка на графике", "Chart Training", "Тренування на графіку"),
    description: T3("Тренировка анализа графика: гипотеза, аргументы, условие отмены и разбор.",
      "Chart analysis practice: hypothesis, arguments, invalidation and review.",
      "Тренування аналізу графіка: гіпотеза, аргументи, умова скасування та розбір."),
    button: T3("Открыть", "Open", "Відкрити") },
  { id: "pre_trade", order: 4, icon: "target", module: "pre-trade", status: "COMING_SOON", enabled: true, disabled_display: "hide", show_on_dashboard: false,
    title: T3("Подготовка к торговой сессии", "Pre-Trade Routine", "Підготовка до торгової сесії"),
    description: T3("Повторение, ежедневные тесты, тренировка на графике и итог подготовки.",
      "Session preparation: review, Daily Tests, Chart Training and a summary.",
      "Повторення, щоденні тести, тренування на графіку та підсумок підготовки."),
    button: T3("Начать", "Start", "Почати") }
];
const BUILTIN = new Set(DEFAULTS.map(d => d.id));
const MAX_CARDS = 20;
const bad = (msg, field) => new C.ValidationError(msg, field);

function text3(v, field, max, required) {
  const out = {};
  for (const l of LANGS) {
    const s = v && typeof v[l] === "string" ? v[l].replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    if (s.length > max) throw bad(`Слишком длинно (${l.toUpperCase()}, максимум ${max})`, field + "." + l);
    if (s) out[l] = s;
  }
  if (required && !out.ru) throw bad("Нужен текст хотя бы на русском", field + ".ru");
  return out;
}
const moduleReady = m => !!(m && MODULES[m] && MODULES[m].href);

/* Проверка карточки целиком: что сохраняется в базе */
function normalize(input, base) {
  const x = { ...base, ...input };
  const card = {
    id: base.id, builtin: !!base.builtin,
    title: text3(x.title, "title", 60, true),
    description: text3(x.description, "description", 240, false),
    button: text3(x.button, "button", 30, false),
    icon: ICONS.includes(x.icon) ? x.icon : null,
    order: Number.isInteger(Number(x.order)) ? Math.max(0, Math.min(999, Number(x.order))) : NaN,
    enabled: x.enabled !== false,
    status: x.status,
    disabled_display: x.disabled_display === "show" ? "show" : "hide",
    show_on_dashboard: x.show_on_dashboard !== false,   // показывать в кабинете ученика (отдельно от статуса: модуль и прямые ссылки продолжают работать)
    module: x.module == null || x.module === "" ? "" : String(x.module)
  };
  if (!card.icon) throw bad("Неизвестная иконка", "icon");
  if (Number.isNaN(card.order)) throw bad("Порядок — целое число", "order");
  if (!STATUSES.includes(card.status)) throw bad("Неизвестный статус", "status");
  if (card.module && !MODULES[card.module]) throw bad("Такого модуля нет в реестре", "module");
  if (base.builtin && card.module !== base.module) throw bad("Модуль стандартной карточки не меняется", "module");
  if (card.status === "ACTIVE" && !moduleReady(card.module)) throw bad("Статус «Открыть» недоступен: модуль ещё не реализован. Используйте «Скоро» или «В разработке»", "status");
  return card;
}

function createFeatures({ db, now = () => Date.now() }) {
  const col = () => db.collection("academy_features");
  async function all() {
    const snap = await col().get(), saved = new Map(snap.docs.map(d => [d.id, d.data()]));
    const out = DEFAULTS.map(d => ({ ...d, builtin: true, ...(saved.get(d.id) || {}), id: d.id, builtin: true, customized: saved.has(d.id) }));
    for (const [id, v] of saved) if (!BUILTIN.has(id)) out.push({ ...v, id, builtin: false, customized: true });
    return out.sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)));
  }
  const pick = (o, lang) => (o && (o[lang] || o.ru)) || "";
  // Ученику: только видимые карточки, на его языке; ссылка — только у ACTIVE с реализованным модулем
  async function publicCards(lang) {
    return (await all()).filter(c => c.enabled !== false && c.show_on_dashboard !== false && !(c.status === "DISABLED" && c.disabled_display !== "show")).map(c => {
      const open = c.status === "ACTIVE" && moduleReady(c.module);
      return { id: c.id, title: pick(c.title, lang), description: pick(c.description, lang), button: pick(c.button, lang) || null,
        icon: c.icon, order: c.order, status: open ? "ACTIVE" : c.status === "ACTIVE" ? "IN_DEVELOPMENT" : c.status, href: open ? MODULES[c.module].href : null };
    });
  }
  async function get(id) { return (await all()).find(c => c.id === id) || null; }
  // Для API модулей: функция открыта ученику? (сотрудникам с правом управления — для предпросмотра)
  async function isOpen(id) { const c = await get(id); return !!(c && c.enabled !== false && c.status === "ACTIVE" && moduleReady(c.module)); }
  async function requireFeature(id, { preview = false } = {}) {
    if (preview) return true;
    if (!(await isOpen(id))) throw Object.assign(new Error("Функция недоступна"), { code: "FEATURE_UNAVAILABLE", status: 403 });
    return true;
  }
  async function save(card, actorUid) {
    const doc = { ...card, updated_at: now(), updated_by: actorUid || null };
    delete doc.customized;
    await col().doc(card.id).set(doc);
    return doc;
  }
  async function create(body, actorUid) {
    const id = String((body && body.id) || "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(id)) throw bad("ID: 3–40 символов, латиница, цифры, - и _", "id");
    const list = await all();
    if (BUILTIN.has(id) || list.some(c => c.id === id)) throw bad("Карточка с таким ID уже есть", "id");
    if (list.length >= MAX_CARDS) throw bad(`Не больше ${MAX_CARDS} карточек`, "id");
    const base = { id, builtin: false, status: "COMING_SOON", module: "", icon: "star", order: (list.reduce((m, c) => Math.max(m, c.order || 0), 0) + 1), enabled: true, disabled_display: "hide" };
    return save(normalize(body || {}, base), actorUid);
  }
  async function update(id, body, actorUid) {
    const cur = await get(id); if (!cur) throw Object.assign(new Error("Карточка не найдена"), { code: "NOT_FOUND", status: 404 });
    const patch = { ...(body || {}) }; delete patch.id; delete patch.builtin;
    const base = cur.builtin ? { ...DEFAULTS.find(d => d.id === id), ...cur, builtin: true } : cur;
    return save(normalize(patch, base), actorUid);
  }
  async function setOrder(ids, actorUid) {
    const list = await all();
    if (!Array.isArray(ids) || ids.length !== list.length || new Set(ids).size !== ids.length || ids.some(i => !list.find(c => c.id === i))) throw bad("Нужен полный список ID карточек без повторов", "ids");
    for (const [i, id] of ids.entries()) { const c = list.find(x => x.id === id); if (c.order !== i + 1) await save(normalize({ order: i + 1 }, c), actorUid); }
    return all();
  }
  async function remove(id) {
    if (BUILTIN.has(id)) throw bad("Стандартную карточку нельзя удалить — её можно отключить", "id");
    const ref = col().doc(id); if (!(await ref.get()).exists) throw Object.assign(new Error("Карточка не найдена"), { code: "NOT_FOUND", status: 404 });
    await ref.delete(); return { ok: true };
  }
  async function resetDefaults() { for (const d of DEFAULTS) await col().doc(d.id).delete(); return all(); }
  return { all, publicCards, get, isOpen, requireFeature, create, update, setOrder, remove, resetDefaults };
}
module.exports = { createFeatures, DEFAULTS, MODULES, STATUSES, ICONS, normalize };
