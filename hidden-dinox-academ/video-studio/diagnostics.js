"use strict";
/* Системная диагностика Video Studio: каждая проверка независима (сбой одной не мешает остальным), с ограничением времени и без секретов.
   Результаты: ok | warn | fail | unknown. Используется разделом «Настройки → Диагностика» и верхней панелью. */
const os = require("os");
const { COLL } = require("./constants"), FF = require("./ffmpeg"), TG = require("./telegram"), { storageProblem } = require("./errors");
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(label + ": нет ответа за " + ms / 1000 + " с"), { name: "TimeoutError" })), ms))]);
async function runChecks({ db, storage, env, now, runner, actor, capsGetter, storageGetter }) {
  const checks = [], run = async (id, name, fn, ms = 9000) => {
    const t0 = Date.now(); try { const r = await withTimeout(Promise.resolve().then(fn), ms, name); checks.push(Object.assign({ id, name, status: "ok", message: "", took_ms: Date.now() - t0 }, r || {})); }
    catch (e) { checks.push({ id, name, status: "fail", message: String((e && e.message) || "ошибка").slice(0, 220), took_ms: Date.now() - t0 }); }
  };
  await run("backend", "Сервер (backend)", async () => ({ message: "Node " + process.version + ", работает " + Math.round(process.uptime() / 60) + " мин, память " + Math.round(process.memoryUsage().rss / 1048576) + " МБ", detail: { node: process.version, uptime_s: Math.round(process.uptime()), load: os.loadavg()[0].toFixed(2), flags: { enabled: String(env.VIDEO_STUDIO_ENABLED || "") === "1", storage: String(env.VIDEO_STUDIO_STORAGE || "gcs"), runner: String(env.VIDEO_STUDIO_RUNNER || "1") !== "0" } } }));
  await run("auth", "Авторизация и роли", async () => ({ message: "Вход подтверждён сервером: " + (actor.email || actor.uid) + ", роль " + actor.role, detail: { uid: actor.uid, role: actor.role } }));
  await run("firestore", "Firestore (база данных)", async () => {
    const ref = db.collection(COLL.settings).doc("_diag"), t = now(); await ref.set({ at: t }); const back = await ref.get(); if (!back.exists || back.data().at !== t) throw new Error("запись не прочиталась обратно"); return { message: "чтение и запись работают" };
  });
  await run("storage", "Хранилище видео", async () => {
    const h = await storageGetter(true); if (h.ok === false) return { status: "fail", message: h.message || "хранилище недоступно", detail: h }; if (h.ok === null) return { status: "unknown", message: "проверка не поддерживается этим хранилищем", detail: h };
    return { message: (h.kind === "r2" ? "Cloudflare R2" : h.kind) + (h.bucket ? ", бакет " + h.bucket : "") + ": соединение проверено запросом к хранилищу", detail: h };
  });
  await run("worker", "Обработка видео (worker)", async () => {
    const jobs = (await db.collection(COLL.jobs).get()).docs.map(d => d.data()), t = now(), queued = jobs.filter(j => j.status === "queued").length, running = jobs.filter(j => ["claimed", "running"].includes(j.status)), stuck = running.filter(j => ((j.lease || {}).expires_at || 0) < t - 60000).length;
    if (!runner) return { status: "warn", message: "В этом экземпляре обработка отключена (VIDEO_STUDIO_RUNNER=0): задания должен брать другой экземпляр", detail: { queued, running: running.length } };
    const last = runner.state && runner.state.last_error; return { status: stuck ? "warn" : last ? "warn" : "ok", message: (stuck ? stuck + " задание зависло (аренда истекла) — оно будет перехвачено. " : "") + "В очереди: " + queued + ", выполняется: " + running.length + (last ? ". Последняя ошибка цикла: " + last : ""), detail: { queued, running: running.length, stuck, started_at: runner.state && runner.state.started_at } };
  });
  await run("ffmpeg", "FFmpeg", async () => { const c = await capsGetter(); if (!c.ok) return { status: "fail", message: "FFmpeg не найден (" + (c.error || c.ffmpeg) + "). Docker-образ deploy/Dockerfile.render или npm install ffmpeg-static ffprobe-static", detail: c }; if (!c.ass) return { status: "fail", message: "В FFmpeg нет субтитров (libass)", detail: c }; return { message: String(c.version || "").slice(0, 60) + "; субтитры, нормализация звука: " + (c.loudnorm ? "есть" : "нет"), status: c.loudnorm ? "ok" : "warn", detail: c }; });
  await run("keys", "Ключи ИИ и Telegram", async () => {
    const g = !!String(env.GROQ_API_KEY || "").trim(), c = !!String(env.VIDEO_STUDIO_ANTHROPIC_API_KEY || env.STUDIO_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || "").trim(), t = !!TG.token(env), miss = [!g && "GROQ_API_KEY", !c && "ANTHROPIC_API_KEY", (String(env.VIDEO_STUDIO_TELEGRAM_ENABLED || "") === "1" && !t) && "VIDEO_STUDIO_TELEGRAM_BOT_TOKEN"].filter(Boolean);
    return { status: miss.length ? "warn" : "ok", message: miss.length ? "Не заданы: " + miss.join(", ") : "Ключи заданы (значения не показываются)", detail: { groq: g, claude: c, telegram: t } };
  });
  return checks;
}
const worst = checks => (checks.some(c => c.status === "fail") ? "fail" : checks.some(c => c.status === "warn") ? "warn" : checks.some(c => c.status === "unknown") ? "unknown" : "ok");
module.exports = { runChecks, worst, withTimeout };
