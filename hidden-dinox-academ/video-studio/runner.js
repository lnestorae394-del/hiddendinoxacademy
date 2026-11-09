"use strict";
/* Исполнитель очереди внутри сервера Express: берёт задания из Firestore, выполняет (FFmpeg, Groq, Claude, Telegram), держит аренду (heartbeat),
   повторяет временные сбои с задержкой, останавливает по отмене или лимиту времени, после перезапуска подхватывает незавершённое (аренда упавшего экземпляра истекает сама). */
const fs = require("fs"), os = require("os"), path = require("path"), { execFile } = require("child_process");
const { COLL } = require("./constants"), S = require("./settings"), B = require("./budget"), FF = require("./ffmpeg"), P = require("./pipeline"), { Queue, LeaseLost } = require("./queue"), { StudioError, StorageConfigError, storageProblem } = require("./errors"), TPL = require("./defaults/template.default.json");
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
  /* Уборка: просроченные незавершённые загрузки прерываются (место в хранилище освобождается); раз в сутки — страховочная чистка зависших multipart-загрузок */
  async janitor() {
    const t = this.now(); if (t - (this._lastJanitor || 0) < 3600000) return; this._lastJanitor = t;
    try {
      for (const d of (await this.db.collection(COLL.projects).where("status", "==", "uploading").get()).docs) {
        const p = d.data(), up = p.upload || {}; if (!(up.expires_at && up.expires_at < t)) continue;
        if (up.mode === "multipart" && this.storage.abortMultipart) await this.storage.abortMultipart(p.source_path, up.upload_id).catch(() => {});
        await this.storage.remove(p.source_path).catch(() => {}); await this.db.collection(COLL.projects).doc(d.id).update({ status: "deleted", updated_at: t, deleted_at: t, error: { code: "UPLOAD_EXPIRED", message: "Загрузка не завершена вовремя и прервана" } });
      }
      if (this.storage.abortStale && t - (this._lastStale || 0) > 86400000) { this._lastStale = t; await this.storage.abortStale("video-studio/", 4 * 86400000, t); }
    } catch (e) { this.log.error && this.log.error("Video Studio: уборка загрузок:", String(e && e.message).slice(0, 160)); }
  }
  /* Забрать и выполнить одно задание (если есть свободный слот); возвращает true, если задание было выполнено */
  async tick() {
    if (this.running > 0) return false;
    await this.janitor();
    const st = await S.loadSettings(this.db, this.env); this.queue.maxRunning = st.limits.max_concurrent_jobs || 1;
    const job = await this.queue.claim(); if (!job) return false;
    this.running++; try { await this.runJob(job); } finally { this.running--; } if (!this.stopped) this.kick(); return true;
  }
  makeCtx(job, flags) {
    const ctx = { db: this.db, storage: this.storage, env: this.env, log: this.log, now: this.now, sleep: this.sleep, job, font: this.font, tmpRoot: this.tmpRoot, ffmpeg: this.bins.ffmpeg, ffprobe: this.bins.ffprobe, spent: 0,
      settings: () => S.loadSettings(this.db, this.env), cancel: () => flags.cancel || flags.lost || flags.timeout };
    /* Если источник — ссылка, ffmpeg получает переподключение при обрыве; у каждой команды есть таймаут (VIDEO_STUDIO_FFMPEG_TIMEOUT_MIN, по умолчанию 30 мин) */
    const defTimeout = Math.max(1, Number(this.env.VIDEO_STUDIO_FFMPEG_TIMEOUT_MIN || 30)) * 60000, RECON = ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"];
    const withReconnect = cmd => { const out = []; for (let i = 0; i < cmd.length; i++) { if (cmd[i] === "-i" && /^https?:\/\//i.test(String(cmd[i + 1] || ""))) out.push(...RECON); out.push(cmd[i]); } return out; };
    ctx.run = (cmd, o = {}) => FF.run(withReconnect(cmd), Object.assign({ cancel: ctx.cancel, timeoutMs: defTimeout }, o));
    /* Реальные этапы и их длительность (аудит: раньше времени этапов не было нигде). progress_known=true только когда прогресс ИЗМЕРЕН (байты, части распознавания, клипы, кадры рендера);
       у этапов без измерения интерфейс показывает название этапа и индикатор активности, а не выдуманные проценты. */
    const T = { stages: [], cur: null, warnings: [], lastM: 0 }, upd = p => this.db.collection(COLL.jobs).doc(job.id).update(Object.assign({ last_update_at: this.now() }, p)).catch(() => {});
    const pub = (c, ms) => ({ name: c.name, started_at: c.started_at, ...(ms !== undefined ? { duration_ms: ms } : {}) });
    const closeCur = t => { if (T.cur) { const c = pub(T.cur, Date.now() - T.cur.w); c.ended_at = Math.max(t, c.started_at); T.stages.push(c); T.cur = null; } };   // длительность — по реальным часам (монотонно), метки времени — по часам сервера
    const stagesDoc = () => T.stages.concat(T.cur ? [pub(T.cur, Date.now() - T.cur.w)] : []).slice(-24);
    ctx.measured = (pct, detail) => { const t = Date.now(); if (t - T.lastM < 1500 && pct < 100) return; T.lastM = t; upd(Object.assign({ progress: Math.max(0, Math.min(100, Math.round(pct))), progress_known: true }, detail ? { detail } : {})); };
    ctx.progress = ctx.measured;
    ctx.warn = msg => { const m = String(msg).slice(0, 200); if (!T.warnings.includes(m)) { T.warnings.push(m); upd({ warnings: T.warnings.slice(-8) }); } };
    ctx.watchFile = (file, total) => { if (!(total > 0)) return () => {}; const iv = setInterval(() => { try { const n = fs.statSync(file).size; ctx.measured(Math.min(99, 100 * n / total), { bytes_done: n, bytes_total: total }); } catch (e) { /* файл ещё не создан */ } }, 1500); if (iv.unref) iv.unref(); return () => clearInterval(iv); };
    ctx.endStages = async () => { closeCur(this.now()); await upd({ stages: T.stages.slice(-24) }); };
    ctx.check = async (stage, progress) => { if (flags.lost) throw Object.assign(new Error("lease"), { cancelled: true, lost: true }); if (flags.timeout) throw new StudioError("JOB_TIMEOUT", "Задание превысило допустимое время", false); if (flags.cancel) throw new FF.Cancelled();
      if (stage === undefined) return; if (T.cur && T.cur.name === stage) return; const t = this.now(); closeCur(t); T.cur = { name: stage, started_at: t, w: Date.now() }; T.lastM = 0;
      await upd({ stage, stage_started_at: t, stages: stagesDoc(), progress: progress || 0, progress_known: false, detail: null }); };
    return ctx;
  }
  async runJob(job) {
    const flags = { cancel: false, lost: false, timeout: false }, ctx = this.makeCtx(job, flags), t0 = Date.now();
    const beat = setInterval(async () => { try { if (await this.queue.heartbeat(job.id)) flags.cancel = true; } catch (e) { if (e instanceof LeaseLost) flags.lost = true; } if (Date.now() - t0 > this.maxJobMs) flags.timeout = true; }, Math.max(1000, this.leaseMs / 3)); if (beat.unref) beat.unref();
    try {
      await this.queue.heartbeat(job.id, "start", 1); const h = this.handlers[job.type]; if (!h) throw new StudioError("UNKNOWN_JOB", "Неизвестный тип задания " + job.type, false);
      const res = await h(ctx, job); if (flags.lost) return "lost"; await ctx.check(); await ctx.endStages();
      await this.queue.finish(job.id, res && Object.fromEntries(Object.entries(res).filter(([k]) => k !== "cost")), res && res.cost); this.state.last_job = { id: job.id, type: job.type, status: "succeeded", at: this.now() }; return "succeeded";
    } catch (e) {
      try {
        if (flags.lost || (e && e.lost) || e instanceof LeaseLost) return "lost";
        await ctx.endStages().catch(() => {});                       // длительность этапа, на котором случилась ошибка или отмена, тоже сохраняется
        if (e instanceof FF.TimedOut) e = new StudioError("FFMPEG_TIMEOUT", "FFmpeg не завершил операцию за " + Math.round(e.ms / 60000) + " мин и был остановлен", true);
        if (e instanceof FF.Cancelled || (e && e.cancelled)) { await this.queue.cancelDone(job.id); await this.onCancelled(ctx, job); return "cancelled"; }
        if (e instanceof StorageConfigError || (e && e.$metadata)) { const sp = storageProblem(e, this.storage.bucketName || ""); e = new StudioError(sp.code, sp.message, ["STORAGE_NETWORK", "STORAGE_UNAVAILABLE"].includes(sp.code)); }   // проблемы хранилища — с понятной причиной и без бессмысленных повторов
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
