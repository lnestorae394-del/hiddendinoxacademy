"use strict";
const D = require("./diag"), RC = require("./read-cache"), meter = require("./read-meter");
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
    RC.configure(db, env); this.idleMaxMs = Math.max(pollMs, Number(env.VIDEO_STUDIO_IDLE_POLL_SEC || 0) * 1000); this.idle = 0; this.kicked = false; this.inTick = false; this.backoffUntil = 0;
    this.queue = new Queue({ db, workerId: this.workerId, now, leaseMs }); this.queue.onExhausted = job => { this.log.error && this.log.error("video-studio: job=" + job.id + " исполнитель потерян, попытки исчерпаны — задание завершено с ошибкой WORKER_LOST"); return this.onFinalFailure({ spent: 0 }, job, "WORKER_LOST", job.error.message); }; this.tmpRoot = env.VIDEO_STUDIO_TMP || path.join(os.tmpdir(), "hd-video-studio"); this.bins = FF.bins(env);
    this.running = 0; this.stopped = true; this.timer = null; this.state = { started_at: null, last_job: null, last_error: null, caps: null };
  }
  async start() {
    this.stopped = false; fs.mkdirSync(this.tmpRoot, { recursive: true }); this.state.reaped = this.reapOrphans(); this.cleanStale();
    if (!this.font) this.font = await pickFont(TPL.fonts);
    D.lag.start(); this.state.started_at = this.now(); this.state.boot = { at: this.now(), pid: process.pid, worker: this.workerId, sys: D.sysDiag() }; this.log.log && this.log.log("video-studio: исполнитель запущен worker=" + this.workerId + " pid=" + process.pid + " rss=" + this.state.boot.sys.rss_mb + "МБ лимит_контейнера=" + this.state.boot.sys.cgroup_limit_mb + "МБ видимых_ядер=" + this.state.boot.sys.cpus_visible); this.state.caps = await FF.capabilities(this.env).catch(e => ({ ok: false, error: String(e.message) }));
    if (!this.state.caps.ok) this.log.warn && this.log.warn("⚠️ Video Studio: FFmpeg не найден (" + this.bins.ffmpeg + "). Задайте FFMPEG_PATH или установите ffmpeg-static / системный ffmpeg. Задания будут ждать.");
    else if (!this.state.caps.ass) this.log.warn && this.log.warn("⚠️ Video Studio: в FFmpeg нет фильтра ass (libass) — субтитры невозможны. Используйте полную сборку FFmpeg.");
    this.loop(); return this;
  }
  /* корректная остановка (SIGTERM): выполняющееся задание останавливается вместе с FFmpeg и сразу возвращается в очередь */
  async shutdown(reason = "SIGTERM", waitMs = 8000) {
    this.stopped = true; clearTimeout(this.timer); const c = this.current; this.log.log && this.log.log("video-studio: остановка исполнителя (" + reason + "), активное задание: " + (c ? c.job.id : "нет") + ", работает " + Math.round(process.uptime()) + " с");
    if (c) { c.flags.shutdown = true; const end = Date.now() + waitMs; while (this.current && Date.now() < end) await sleepMs(100); }
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
  /* Уборка рабочей папки: каталоги заданий старше 6 часов (остатки прерванных обработок) удаляются; свежие и чужие данные не затрагиваются */
  cleanStale() { try { for (const n of fs.readdirSync(this.tmpRoot)) { const f = path.join(this.tmpRoot, n); if (this.now() - fs.statSync(f).mtimeMs > 6 * 3600 * 1000) fs.rmSync(f, { recursive: true, force: true }); } } catch (e) { /* каталога ещё нет */ } }
  /* Процессы ffmpeg прежнего запуска (родитель умер, процесс продолжает писать в рабочую папку) нельзя оставлять: они дублируют работу и занимают CPU и память.
     Останавливаются ТОЛЬКО процессы ffmpeg, в командной строке которых есть рабочая папка этого сервера и родитель которых — не мы. Только Linux (/proc). */
  reapOrphans() {
    const killed = []; let pids; try { pids = fs.readdirSync("/proc").filter(n => /^\d+$/.test(n)); } catch (e) { return killed; }
    for (const n of pids) {
      const pid = Number(n); if (pid === process.pid) continue;
      try {
        const cmd = fs.readFileSync("/proc/" + n + "/cmdline", "utf8").split("\0").filter(Boolean); if (!cmd.length || !/ffmpeg/i.test(path.basename(cmd[0])) || !cmd.some(a => a.includes(this.tmpRoot))) continue;
        const st = fs.readFileSync("/proc/" + n + "/stat", "utf8"), ppid = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]); if (ppid === process.pid) continue;
        process.kill(pid, "SIGKILL"); killed.push(pid);
      } catch (e) { /* процесс уже завершился или нет прав */ }
    }
    if (killed.length && this.log.warn) this.log.warn("video-studio: остановлены процессы ffmpeg прежнего запуска сервера: " + killed.map(p => "pid=" + p).join(", ") + " (их задания будут перехвачены по истечении аренды)");
    return killed;
  }
  /* Пробуждение: новая работа (постановка задания, повтор, отмена) будит исполнителя сразу, не дожидаясь паузы простоя; во время цикла запрос запоминается и обрабатывается сразу после него */
  kick() { if (this.stopped) return; this.kicked = true; if (this.inTick) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.loop(), 20); if (this.timer.unref) this.timer.unref(); }
  /* Простой с нарастающей паузой (pollMs → до VIDEO_STUDIO_IDLE_POLL_SEC): пустая очередь не должна читать Firestore каждые 5 секунд; после работы или пробуждения опрос сразу возвращается к быстрому */
  async loop() {
    if (this.stopped || this.inTick) return; clearTimeout(this.timer); this.inTick = true; let did = false;
    try { did = await meter.run("runner.tick", () => this.tick()); }
    catch (e) { this.state.last_error = String(e.message).slice(0, 200); const q = meter.classify(e); if (q) { if (Date.now() >= this.backoffUntil) this.log.error && this.log.error("Video Studio: Firestore RESOURCE_EXHAUSTED [" + q.kind + "] — исполнитель делает паузу 5 минут (без повторов). " + q.hint); this.backoffUntil = Date.now() + 300000; } else this.log.error && this.log.error("Video Studio: цикл очереди:", e.message); }
    finally { this.inTick = false; }
    if (!this.stopped) { const wake = this.kicked || did; this.kicked = false; this.idle = wake ? 0 : Math.min(this.idle + 1, 12); const delay = wake ? 20 : Math.max(Math.min(this.pollMs * 2 ** this.idle, this.idleMaxMs), this.backoffUntil > Date.now() ? this.backoffUntil - Date.now() : 0); this.timer = setTimeout(() => this.loop(), delay); if (this.timer.unref) this.timer.unref(); }
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
    if (this.running > 0 || Date.now() < this.backoffUntil) return false;
    await this.janitor();
    const st = await RC.settings(this.db, () => S.loadSettings(this.db, this.env)); this.queue.maxRunning = st.limits.max_concurrent_jobs || 1;
    const job = await this.queue.claim(); if (!job) return false;
    RC.invalidate(this.db, "data");          // задание перешло в работу: монитор и список не должны показывать старое состояние
    this.running++; try { await meter.run("runner.job", () => this.runJob(job)); } finally { this.running--; RC.invalidate(this.db, "data"); } if (!this.stopped) this.kick(); return true;
  }
  makeCtx(job, flags) {
    const ctx = { db: this.db, storage: this.storage, env: this.env, log: this.log, now: this.now, sleep: this.sleep, job, font: this.font, tmpRoot: this.tmpRoot, ffmpeg: this.bins.ffmpeg, ffprobe: this.bins.ffprobe, spent: 0,
      settings: () => RC.settings(this.db, () => S.loadSettings(this.db, this.env)), cancel: () => flags.cancel || flags.lost || flags.timeout || flags.shutdown };
    /* Если источник — ссылка, ffmpeg получает переподключение при обрыве; у каждой команды есть таймаут (VIDEO_STUDIO_FFMPEG_TIMEOUT_MIN, по умолчанию 30 мин) */
    const defTimeout = Math.max(1, Number(this.env.VIDEO_STUDIO_FFMPEG_TIMEOUT_MIN || 30)) * 60000, RECON = ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"];
    const withReconnect = cmd => { const out = []; for (let i = 0; i < cmd.length; i++) { if (cmd[i] === "-i" && /^https?:\/\//i.test(String(cmd[i + 1] || ""))) out.push(...RECON); out.push(cmd[i]); } return out; };
    /* ресурсы ffmpeg: потоки (VIDEO_STUDIO_FFMPEG_THREADS, по умолчанию 2; 0 — не ограничивать) и пониженный приоритет (VIDEO_STUDIO_FFMPEG_NICE, по умолчанию 10), чтобы Node.js успевал отвечать на запросы и писать heartbeat */
    const thr = this.env.VIDEO_STUDIO_FFMPEG_THREADS === undefined ? 2 : Number(this.env.VIDEO_STUDIO_FFMPEG_THREADS), nice = this.env.VIDEO_STUDIO_FFMPEG_NICE === undefined ? 10 : Number(this.env.VIDEO_STUDIO_FFMPEG_NICE);
    ctx.ff = { current: null, runs: [], prevTicks: null };
    ctx.run = (cmd, o = {}) => {
      const full = D.limitArgs(withReconnect(cmd), thr), rec = { pid: null, cmd: D.redactCmd(full), started_at: this.now(), stage: ctx.stageName ? ctx.stageName() : null, attempt: job.attempts || 1 };
      const end = (r, e) => { rec.ended_at = this.now(); rec.duration_ms = r && r.ended_at && r.started_at ? r.ended_at - r.started_at : rec.ended_at - rec.started_at; if (r) { rec.exit_code = r.code; rec.signal = r.signal || null; if (r.code !== 0) rec.stderr_tail = D.redactText(String(r.stderr || "").slice(-1200)); } if (e) { rec.cancelled = !!(e instanceof FF.Cancelled); rec.timed_out = !!(e && e.timedOut); rec.exit_code = null; } ctx.ff.current = null; ctx.ff.runs.push(rec); if (ctx.ff.runs.length > 12) ctx.ff.runs.shift();
        this.log.log && this.log.log("video-studio: job=" + job.id + " project=" + (job.project_id || "-") + " attempt=" + rec.attempt + " stage=" + (rec.stage || "-") + " ffmpeg pid=" + rec.pid + " exit=" + rec.exit_code + " signal=" + (rec.signal || "-") + " ms=" + rec.duration_ms + (rec.cancelled ? " отменён" : "") + (rec.timed_out ? " таймаут" : "")); if (ctx.persistRuns) ctx.persistRuns(); };
      return FF.run(full, Object.assign({ cancel: ctx.cancel, timeoutMs: defTimeout, nice, onSpawn: pid => { rec.pid = pid; ctx.ff.current = rec; ctx.ff.prevTicks = null; }, onActivity: () => { rec.last_output_at = this.now(); } }, o)).then(r => {
        end(r, null); if ((r.signal === "SIGKILL" || r.code === 137) && !ctx.cancel()) throw new StudioError("FFMPEG_KILLED", "FFmpeg принудительно завершён системой (SIGKILL, код 137): обычно это нехватка памяти (OOM) на экземпляре Render. Задание будет повторено. Если повторяется — уменьшите VIDEO_STUDIO_FFMPEG_THREADS или возьмите экземпляр с большим объёмом памяти.", true); return r;
      }, e => { end(null, e); throw e; });
    };
    /* Реальные этапы и их длительность (аудит: раньше времени этапов не было нигде). progress_known=true только когда прогресс ИЗМЕРЕН (байты, части распознавания, клипы, кадры рендера);
       у этапов без измерения интерфейс показывает название этапа и индикатор активности, а не выдуманные проценты. */
    const T = { stages: [], cur: null, warnings: [], lastM: 0 }, upd = p => this.db.collection(COLL.jobs).doc(job.id).update(Object.assign({ last_update_at: this.now() }, p)).catch(() => {});
    const pub = (c, ms) => ({ name: c.name, started_at: c.started_at, ...(ms !== undefined ? { duration_ms: ms } : {}) });
    const closeCur = t => { if (T.cur) { const c = pub(T.cur, Date.now() - T.cur.w); c.ended_at = Math.max(t, c.started_at); T.stages.push(c); T.cur = null; } };   // длительность — по реальным часам (монотонно), метки времени — по часам сервера
    const stagesDoc = () => T.stages.concat(T.cur ? [pub(T.cur, Date.now() - T.cur.w)] : []).slice(-24);
    ctx.measured = (pct, detail) => { const t = Date.now(); if (t - T.lastM < 5000 && pct < 100) return; T.lastM = t; upd(Object.assign({ progress: Math.max(0, Math.min(100, Math.round(pct))), progress_known: true }, detail ? { detail } : {})); };
    ctx.progress = ctx.measured;
    ctx.warn = msg => { const m = String(msg).slice(0, 200); if (!T.warnings.includes(m)) { T.warnings.push(m); upd({ warnings: T.warnings.slice(-8) }); } };
    ctx.watchFile = (file, total) => { if (!(total > 0)) return () => {}; const iv = setInterval(() => { try { const n = fs.statSync(file).size; ctx.measured(Math.min(99, 100 * n / total), { bytes_done: n, bytes_total: total }); } catch (e) { /* файл ещё не создан */ } }, 3000); if (iv.unref) iv.unref(); return () => clearInterval(iv); };
    ctx.stageName = () => (T.cur ? T.cur.name : null); ctx.persistRuns = () => upd({ ffmpeg_runs: ctx.ff.runs.slice(-12) });
    ctx.endStages = async () => { closeCur(this.now()); await upd({ stages: T.stages.slice(-24), ffmpeg_runs: ctx.ff.runs.slice(-12) }); };
    ctx.check = async (stage, progress) => { if (flags.lost) throw Object.assign(new Error("lease"), { cancelled: true, lost: true }); if (flags.timeout) throw new StudioError("JOB_TIMEOUT", "Задание превысило допустимое время", false); if (flags.cancel || flags.shutdown) throw new FF.Cancelled();
      if (stage === undefined) return; if (T.cur && T.cur.name === stage) return; const t = this.now(); closeCur(t); T.cur = { name: stage, started_at: t, w: Date.now() }; T.lastM = 0;
      await upd({ stage, stage_started_at: t, stages: stagesDoc(), progress: progress || 0, progress_known: false, detail: null }); RC.invalidate(this.db, "data"); };
    return ctx;
  }
  async runJob(job) {
    const flags = { cancel: false, lost: false, timeout: false, shutdown: false }, ctx = this.makeCtx(job, flags), t0 = Date.now(); this.current = { job, flags };
    /* heartbeat: интервал не больше 15 с (и не больше 1/6 аренды), без наложения тиков, 3 попытки при сбое Firestore, диагностика процесса и FFmpeg в каждой записи */
    const hb = { seq: 0, okAt: Date.now(), fails: 0, lastErr: null, busy: false }, hbEvery = Math.max(300, Math.min(15000, Math.floor(this.leaseMs / 6)));
    const ffd = () => { const c = ctx.ff.current; if (!c) { const l = ctx.ff.runs[ctx.ff.runs.length - 1]; return { running: false, last_pid: l ? l.pid : null, last_exit: l ? l.exit_code : null }; } const ticks = D.cpuTicks(c.pid), adv = ticks != null && ctx.ff.prevTicks != null ? ticks > ctx.ff.prevTicks : null; ctx.ff.prevTicks = ticks; return { running: D.alive(c.pid), pid: c.pid, started_at: c.started_at, last_output_at: c.last_output_at || null, cpu_ticks: ticks, cpu_advancing: adv }; };
    const beat = setInterval(async () => {
      if (hb.busy) return; hb.busy = true;
      try {
        const lag = D.lag.take(), extra = { heartbeat_seq: hb.seq + 1, diag: Object.assign(D.sysDiag(), { loop_lag_max_ms: lag.max_ms, loop_lag_p99_ms: lag.p99_ms, hb_fails: hb.fails, hb_last_error: hb.lastErr, attempt: job.attempts || 1, worker: this.workerId, stage: ctx.stageName ? ctx.stageName() : null, ffmpeg: ffd() }) }; let ok = false;
        for (let a = 1; a <= 3 && !ok; a++) { try { if (await this.queue.heartbeat(job.id, undefined, undefined, extra)) flags.cancel = true; ok = true; } catch (e) { if (e instanceof LeaseLost) { flags.lost = true; ok = true; this.log.warn && this.log.warn("video-studio: job=" + job.id + " аренда потеряна (задание перехвачено другим исполнителем или истекла); выполнение будет остановлено"); } else { hb.fails++; hb.lastErr = D.redactText(String(e && e.message).slice(0, 160)); if (a < 3) await new Promise(r => setTimeout(r, 400 * a)); } } }
        if (ok && !flags.lost) { hb.seq++; hb.okAt = Date.now(); }
        const gap = Date.now() - hb.okAt; if (gap > this.leaseMs * 0.6 && this.log.error) this.log.error("video-studio: job=" + job.id + " heartbeat не проходит " + Math.round(gap / 1000) + " с (ошибок подряд: " + hb.fails + ", последняя: " + hb.lastErr + "); аренда истекает через " + Math.max(0, Math.round((this.leaseMs - gap) / 1000)) + " с");
      } finally { hb.busy = false; }
      if (Date.now() - t0 > this.maxJobMs) flags.timeout = true;
    }, hbEvery); if (beat.unref) beat.unref();
    try {
      await this.queue.heartbeat(job.id, "start", 1); const h = this.handlers[job.type]; if (!h) throw new StudioError("UNKNOWN_JOB", "Неизвестный тип задания " + job.type, false);
      const res = await h(ctx, job); if (flags.lost) return "lost"; await ctx.check(); await ctx.endStages();
      await this.queue.finish(job.id, res && Object.fromEntries(Object.entries(res).filter(([k]) => k !== "cost")), res && res.cost); this.state.last_job = { id: job.id, type: job.type, status: "succeeded", at: this.now() }; return "succeeded";
    } catch (e) {
      try {
        if (flags.lost || (e && e.lost) || e instanceof LeaseLost) return "lost";
        await ctx.endStages().catch(() => {});                       // длительность этапа, на котором случилась ошибка или отмена, тоже сохраняется
        if (e instanceof FF.TimedOut) e = new StudioError("FFMPEG_TIMEOUT", "FFmpeg не завершил операцию за " + Math.round(e.ms / 60000) + " мин и был остановлен", true);
        if (flags.shutdown) { await this.queue.release(job.id, "instance_shutdown"); this.log.log && this.log.log("video-studio: job=" + job.id + " возвращено в очередь при остановке экземпляра"); return "released"; }
        if (e instanceof FF.Cancelled || (e && e.cancelled)) { await this.queue.cancelDone(job.id); await this.onCancelled(ctx, job); return "cancelled"; }
        if (e instanceof StorageConfigError || (e && e.$metadata)) { const sp = storageProblem(e, this.storage.bucketName || ""); e = new StudioError(sp.code, sp.message, ["STORAGE_NETWORK", "STORAGE_UNAVAILABLE"].includes(sp.code)); }   // проблемы хранилища — с понятной причиной и без бессмысленных повторов
        { const q = meter.classify(e); if (q) { this.backoffUntil = Date.now() + 300000; e = Object.assign(new StudioError("FIRESTORE_QUOTA", "Firestore: " + q.hint, true), { extra: { retry_after: 900 } }); } }
        const known = e instanceof StudioError || e instanceof require("./render").RenderError, code = (e && e.code) || (known ? "RENDER_FAILED" : "INTERNAL"), retryable = known ? !!e.retryable : true;
        if (!known) this.log.error && this.log.error("Video Studio: непредвиденная ошибка задания", job.id, e && e.stack || e);
        const out = await this.queue.fail(job.id, code, known ? e.message : (e && e.message) || "Внутренняя ошибка", retryable, e && e.extra && e.extra.retry_after);
        this.state.last_job = { id: job.id, type: job.type, status: out, code, at: this.now() };
        if (out === "failed") await this.onFinalFailure(ctx, job, code, known ? e.message : "Внутренняя ошибка"); return out;
      } catch (e2) { if (e2 instanceof LeaseLost) return "lost"; this.log.error && this.log.error("Video Studio: не удалось записать итог задания", e2.message); return "error"; }
    } finally { clearInterval(beat); this.queue.tokens.delete(job.id); this.current = null; }
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
