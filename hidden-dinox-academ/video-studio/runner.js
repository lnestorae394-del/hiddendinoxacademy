"use strict";
/* Исполнитель очереди внутри сервера Express: берёт задания из Firestore, выполняет (FFmpeg, Groq, Claude, Telegram), держит аренду (heartbeat),
   повторяет временные сбои с задержкой, останавливает по отмене или лимиту времени, после перезапуска подхватывает незавершённое (аренда упавшего экземпляра истекает сама). */
const fs = require("fs"), os = require("os"), path = require("path"), { execFile } = require("child_process");
const { COLL } = require("./constants"), S = require("./settings"), B = require("./budget"), FF = require("./ffmpeg"), P = require("./pipeline"), { Queue, LeaseLost } = require("./queue"), { StudioError } = require("./errors"), TPL = require("./defaults/template.default.json");
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
function pickFont(candidates) {
  return new Promise(res => execFile("fc-list", [":", "family"], (e, out) => { const have = new Set(String(out || "").split("\n").map(x => x.split(",")[0].trim().toLowerCase())); res(candidates.find(c => have.has(c.toLowerCase())) || candidates[candidates.length - 1] || "Arial"); }));
}
class Runner {
  constructor({ db, storage, env = process.env, log = console, now = () => Date.now(), workerId, pollMs = 5000, leaseMs = 120000, maxJobMs, handlers = P.HANDLERS, sleep = sleepMs, font }) {
    Object.assign(this, { db, storage, env, log, now, pollMs, leaseMs, handlers, sleep, font });
    this.workerId = workerId || ((env.RENDER_INSTANCE_ID || os.hostname()) + "-" + process.pid); this.maxJobMs = maxJobMs || (Number(env.VIDEO_STUDIO_JOB_MAX_RUNTIME_MIN || 90) * 60000);
    this.queue = new Queue({ db, workerId: this.workerId, now, leaseMs }); this.tmpRoot = env.VIDEO_STUDIO_TMP || path.join(os.tmpdir(), "hd-video-studio"); this.bins = FF.bins(env);
    this.running = 0; this.stopped = true; this.timer = null; this.state = { started_at: null, last_job: null, last_error: null, caps: null };
  }
  async start() {
    this.stopped = false; fs.mkdirSync(this.tmpRoot, { recursive: true }); this.cleanStale();
    if (!this.font) this.font = await pickFont(TPL.fonts);
    this.state.started_at = this.now(); this.state.caps = await FF.capabilities(this.env).catch(e => ({ ok: false, error: String(e.message) }));
    if (!this.state.caps.ok) this.log.warn && this.log.warn("⚠️ Video Studio: FFmpeg не найден (" + this.bins.ffmpeg + "). Задайте FFMPEG_PATH или установите ffmpeg-static / системный ffmpeg. Задания будут ждать.");
    else if (!this.state.caps.ass) this.log.warn && this.log.warn("⚠️ Video Studio: в FFmpeg нет фильтра ass (libass) — субтитры невозможны. Используйте полную сборку FFmpeg.");
    this.loop(); return this;
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
  kick() { if (!this.stopped) { clearTimeout(this.timer); this.timer = setTimeout(() => this.loop(), 20); if (this.timer.unref) this.timer.unref(); } }
  cleanStale() { try { for (const n of fs.readdirSync(this.tmpRoot)) { const f = path.join(this.tmpRoot, n); if (this.now() - fs.statSync(f).mtimeMs > 6 * 3600 * 1000) fs.rmSync(f, { recursive: true, force: true }); } } catch (e) { /* каталога ещё нет */ } }
  async loop() {
    if (this.stopped) return;
    try { await this.tick(); } catch (e) { this.state.last_error = String(e.message).slice(0, 200); this.log.error && this.log.error("Video Studio: цикл очереди:", e.message); }
    if (!this.stopped) { this.timer = setTimeout(() => this.loop(), this.pollMs); if (this.timer.unref) this.timer.unref(); }
  }
  /* Забрать и выполнить одно задание (если есть свободный слот); возвращает true, если задание было выполнено */
  async tick() {
    if (this.running > 0) return false;
    const st = await S.loadSettings(this.db, this.env); this.queue.maxRunning = st.limits.max_concurrent_jobs || 1;
    const job = await this.queue.claim(); if (!job) return false;
    this.running++; try { await this.runJob(job); } finally { this.running--; } if (!this.stopped) this.kick(); return true;
  }
  makeCtx(job, flags) {
    const ctx = { db: this.db, storage: this.storage, env: this.env, log: this.log, now: this.now, sleep: this.sleep, job, font: this.font, tmpRoot: this.tmpRoot, ffmpeg: this.bins.ffmpeg, ffprobe: this.bins.ffprobe, spent: 0,
      settings: () => S.loadSettings(this.db, this.env), cancel: () => flags.cancel || flags.lost || flags.timeout };
    ctx.run = (cmd, o = {}) => FF.run(cmd, Object.assign({ cancel: ctx.cancel }, o));
    ctx.check = async (stage, progress) => { if (flags.lost) throw Object.assign(new Error("lease"), { cancelled: true, lost: true }); if (flags.timeout) throw new StudioError("JOB_TIMEOUT", "Задание превысило допустимое время", false); if (flags.cancel) throw new FF.Cancelled();
      if (stage !== undefined) await this.db.collection(COLL.jobs).doc(job.id).update({ stage, progress: progress || 0 }).catch(() => {}); };
    let last = 0; ctx.progress = pct => { const t = Date.now(); if (t - last > 1500) { last = t; this.db.collection(COLL.jobs).doc(job.id).update({ progress: Math.round(pct) }).catch(() => {}); } };
    return ctx;
  }
  async runJob(job) {
    const flags = { cancel: false, lost: false, timeout: false }, ctx = this.makeCtx(job, flags), t0 = Date.now();
    const beat = setInterval(async () => { try { if (await this.queue.heartbeat(job.id)) flags.cancel = true; } catch (e) { if (e instanceof LeaseLost) flags.lost = true; } if (Date.now() - t0 > this.maxJobMs) flags.timeout = true; }, Math.max(1000, this.leaseMs / 3)); if (beat.unref) beat.unref();
    try {
      await this.queue.heartbeat(job.id, "start", 1); const h = this.handlers[job.type]; if (!h) throw new StudioError("UNKNOWN_JOB", "Неизвестный тип задания " + job.type, false);
      const res = await h(ctx, job); if (flags.lost) return "lost"; await ctx.check();
      await this.queue.finish(job.id, res && Object.fromEntries(Object.entries(res).filter(([k]) => k !== "cost")), res && res.cost); this.state.last_job = { id: job.id, type: job.type, status: "succeeded", at: this.now() }; return "succeeded";
    } catch (e) {
      try {
        if (flags.lost || (e && e.lost) || e instanceof LeaseLost) return "lost";
        if (e instanceof FF.Cancelled || (e && e.cancelled)) { await this.queue.cancelDone(job.id); await this.onCancelled(ctx, job); return "cancelled"; }
        const known = e instanceof StudioError || e instanceof require("./render").RenderError, code = (e && e.code) || (known ? "RENDER_FAILED" : "INTERNAL"), retryable = known ? !!e.retryable : true;
        if (!known) this.log.error && this.log.error("Video Studio: непредвиденная ошибка задания", job.id, e && e.stack || e);
        const out = await this.queue.fail(job.id, code, known ? e.message : (e && e.message) || "Внутренняя ошибка", retryable, e && e.extra && e.extra.retry_after);
        this.state.last_job = { id: job.id, type: job.type, status: out, code, at: this.now() };
        if (out === "failed") await this.onFinalFailure(ctx, job, code, known ? e.message : "Внутренняя ошибка"); return out;
      } catch (e2) { if (e2 instanceof LeaseLost) return "lost"; this.log.error && this.log.error("Video Studio: не удалось записать итог задания", e2.message); return "error"; }
    } finally { clearInterval(beat); }
  }
  async onCancelled(ctx, job) {
    const col = n => this.db.collection(n), t = this.now();
    if (job.type === "analyze") { await B.settle(this.db, this.now, job, +ctx.spent.toFixed(6)); await col(COLL.projects).doc(job.project_id).update({ status: "ready", updated_at: t }).catch(() => {}); }
    else if (job.type === "render" && job.clip_id) { const c = await col(COLL.clips).doc(job.clip_id).get(); if (c.exists && c.data().status === "rendering") await col(COLL.clips).doc(job.clip_id).update({ status: c.data().render ? "done" : "edited", updated_at: t }); }
    else if (job.type === "telegram" && job.clip_id) { await col(COLL.clips).doc(job.clip_id).update({ "telegram.status": "cancelled", updated_at: t }).catch(() => {}); }
  }
  async onFinalFailure(ctx, job, code, message) {
    const col = n => this.db.collection(n), t = this.now(), err = { code, message: String(message).slice(0, 200) };
    if (job.type === "analyze") { await B.settle(this.db, this.now, job, +ctx.spent.toFixed(6)); await col(COLL.projects).doc(job.project_id).update({ status: "ready", updated_at: t, analysis: { job_id: job.id, error: err, cost_usd: +ctx.spent.toFixed(6) } }).catch(() => {}); }
    else if (job.type === "render" && job.clip_id) await col(COLL.clips).doc(job.clip_id).update({ status: "error", error: err, updated_at: t }).catch(() => {});
    else if (job.type === "probe") await col(COLL.projects).doc(job.project_id).update({ status: "error", error: err, updated_at: t }).catch(() => {});
    else if (job.type === "telegram" && job.clip_id) { const c = await col(COLL.clips).doc(job.clip_id).get(); const tg = (c.exists && c.data().telegram) || {}; await col(COLL.clips).doc(job.clip_id).update({ telegram: Object.assign({}, tg, { status: "failed", error: Object.assign({}, err, { retryable: false }), updated_at: t }) }).catch(() => {}); }
  }
}
module.exports = { Runner, pickFont };
