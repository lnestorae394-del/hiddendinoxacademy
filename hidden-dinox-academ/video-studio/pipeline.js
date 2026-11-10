"use strict";
/* Обработчики заданий. Каждый идемпотентен: промежуточные результаты (расшифровка, ответ Claude, готовые файлы) лежат в постоянном хранилище
   под детерминированными именами, поэтому повтор после сбоя или перезапуска не платит за уже сделанное и не рендерит заново.
   Временные файлы — только в каталоге задания и удаляются в конце; исходная запись при любой ошибке остаётся в хранилище нетронутой. */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { COLL } = require("./constants"), S = require("./settings"), B = require("./budget"), M = require("./moments"), G = require("./groq"), CL = require("./claude");
const RP = require("./render-plan"), FF = require("./ffmpeg"), R = require("./render"), TG = require("./telegram"), J = require("./jobs"), core = require("../public/video-studio/js/vs-core.js"), { StudioError } = require("./errors");
const sha = (...a) => crypto.createHash("sha256").update(a.join("|")).digest("hex").slice(0, 12);
const wid = i => "w" + String(i).padStart(6, "0");
const VIDEO_CODECS = new Set(["h264", "hevc", "vp9", "av1", "mpeg4", "prores"]);
const BRAND_DIR = require("./paths").BRAND_DIR;
const need = (env, ...names) => { for (const n of names) { const v = String(env[n] || "").trim(); if (v) return v; } throw new StudioError("MISSING_KEY", "На сервере не задан секрет " + names[0], false); };
const claudeKey = env => need(env, "VIDEO_STUDIO_ANTHROPIC_API_KEY", "STUDIO_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY");
const get = async (db, c, id) => { const d = await db.collection(c).doc(id).get(); return d.exists ? Object.assign({ id }, d.data()) : null; };
const event = (ctx, action, d = {}) => ctx.db.collection(COLL.events).doc("ev_" + ctx.now() + "_" + sha(ctx.job.id, action, Math.random())).set(Object.assign({ at: ctx.now(), uid: "system", action, job_id: ctx.job.id }, d)).catch(() => {});
const downloadSource = async (ctx, project, wd) => {
  const local = path.join(wd, "source" + (path.extname(project.source_path) || ".mp4"));
  if (!fs.existsSync(local)) { const stop = ctx.watchFile ? ctx.watchFile(local, project.size_bytes) : () => {}; try { await ctx.storage.download(project.source_path, local); } finally { stop(); } }   // прогресс скачивания — реальные байты
  return local;
};
/* Задачам, которым нужен только фрагмент (окно, предпросмотр, сборка), большой источник не скачивается целиком (аудит: раньше КАЖДАЯ сборка качала файл до 5 ГБ):
   ffmpeg читает нужные байты по подписанной ссылке (HTTP Range). Малые файлы и сбои ссылки — прежний путь (скачивание). */
const sourceFor = async (ctx, project, wd) => {
  const minMb = Number(ctx.env.VIDEO_STUDIO_REMOTE_MIN_MB === undefined ? 256 : ctx.env.VIDEO_STUDIO_REMOTE_MIN_MB);
  if (ctx.env.VIDEO_STUDIO_REMOTE_INPUT !== "0" && (project.size_bytes || 0) >= minMb * 1048576 && typeof ctx.storage.signedReadUrl === "function") {
    try { const url = await ctx.storage.signedReadUrl(project.source_path, { ttlSec: 7200 }); if (/^https?:\/\//i.test(String(url))) { await ctx.check("prepare", 5); return { src: url, remote: true }; } } catch (e) { /* ссылка не получена — скачаем */ }
  }
  await ctx.check("download", 5); return { src: await downloadSource(ctx, project, wd), remote: false };
};
const tryRemote = async (ctx, project, wd, s, fn) => {
  try { return await fn(s.src); } catch (e) { if (!s.remote || (e && (e.cancelled || e.timedOut || e instanceof FF.Cancelled))) throw e; ctx.warn && ctx.warn("Чтение исходника по ссылке не удалось — скачиваю файл целиком"); await ctx.check("download", 5); return fn(await downloadSource(ctx, project, wd)); }
};
const mkwd = ctx => { const wd = path.join(ctx.tmpRoot, ctx.job.id.replace(/[^A-Za-z0-9_-]/g, "_")); fs.mkdirSync(wd, { recursive: true }); return wd; };
const rmwd = wd => fs.rmSync(wd, { recursive: true, force: true });

/* ---------------------------------------------------------------- проверка загруженного видео */
async function handleProbe(ctx, job) {
  const p = await get(ctx.db, COLL.projects, job.project_id); if (!p || p.status === "deleted") return { skipped: "project_gone" };
  const wd = mkwd(ctx), st = await ctx.settings();
  const invalid = async (code, message) => { await ctx.storage.remove(p.source_path); await ctx.db.collection(COLL.projects).doc(p.id).update({ status: "error", error: { code, message }, updated_at: ctx.now() }); return { invalid: code }; };
  try {
    await ctx.check("download", 5); const src = await downloadSource(ctx, p, wd); await ctx.check("probe", 40);
    const info = await FF.probe(src, ctx.env, { cancel: ctx.cancel });
    if (info.error) return invalid("UNREADABLE", "Видео повреждено или не читается");
    if (!/mp4|mov/.test(info.format || "")) return invalid("BAD_FORMAT", "Контейнер не MP4/MOV");
    if (!info.video) return invalid("NO_VIDEO", "В файле нет видеодорожки");
    if (!VIDEO_CODECS.has(info.video.codec)) return invalid("BAD_CODEC", "Видеокодек не поддерживается: " + info.video.codec);
    if (!info.audio) return invalid("NO_AUDIO", "В файле нет звуковой дорожки: распознавать нечего");
    if (info.duration < 5) return invalid("TOO_SHORT", "Видео короче 5 секунд");
    const mx = (st.limits.max_duration_min || 0) * 60; if (mx && info.duration > mx) return invalid("TOO_LONG", "Видео длиннее допустимого (" + Math.floor(mx / 60) + " мин)");
    for (const ss of [0, Math.max(0, info.duration - 3)]) { const r = await ctx.run([ctx.ffmpeg, "-v", "error", "-ss", ss.toFixed(2), "-t", "3", "-i", src, "-f", "null", "-"]); if (r.code || r.stderr.trim()) return invalid("UNREADABLE", "Видео не декодируется (повреждено)"); }
    await ctx.db.collection(COLL.projects).doc(p.id).update({ status: "ready", duration_sec: Number(info.duration.toFixed(2)), width: info.video.width, height: info.video.height, fps: info.video.fps || null, video_codec: info.video.codec, audio_codec: info.audio.codec, error: null, updated_at: ctx.now() });
    return { duration_sec: Number(info.duration.toFixed(2)) };
  } finally { rmwd(wd); }
}

/* ---------------------------------------------------------------- окно предпросмотра (небольшой файл вокруг клипа) */
async function makeWindow(ctx, src, wd, ws, length, thumbAt, tpl, cdir) {
  const pr = await ctx.run([ctx.ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", src]);
  if (pr.code) throw new StudioError("PROBE_FAILED", "Не удалось прочитать размер видео", true);
  const [w, h] = pr.stdout.trim().split(",").map(Number), [cw, ch, cy] = R.layout(w, h, tpl.window.crop_y, tpl.window.h, tpl.canvas.w), out = path.join(wd, "window.mp4"), th = path.join(wd, "thumb.jpg");
  const r = await ctx.run([ctx.ffmpeg, "-y", "-v", "error", "-ss", ws.toFixed(3), "-t", length.toFixed(3), "-i", src, "-vf", "crop=" + cw + ":" + ch + ":0:" + cy + ",scale=540:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", out]);
  if (r.code) throw new StudioError("WINDOW_FAILED", "Не удалось подготовить предпросмотр: " + r.stderr.slice(-150), true);
  await ctx.run([ctx.ffmpeg, "-y", "-v", "error", "-ss", Math.max(0, thumbAt).toFixed(2), "-i", out, "-frames:v", "1", "-vf", "scale=270:-2", th]);
  await ctx.storage.upload(out, cdir + "window.mp4", "video/mp4"); const hasThumb = fs.existsSync(th); if (hasThumb) await ctx.storage.upload(th, cdir + "thumb.jpg", "image/jpeg");
  return { window_path: cdir + "window.mp4", thumb_path: hasThumb ? cdir + "thumb.jpg" : null, window_dur: length };
}
const WINDOW_PAD = 12;

/* ---------------------------------------------------------------- анализ: речь → моменты → клипы */
async function handleAnalyze(ctx, job) {
  const pl = job.payload, p = await get(ctx.db, COLL.projects, job.project_id); if (!p || p.status === "deleted") return { skipped: "project_gone" };
  const st = await ctx.settings(), tpl = st.template, prices = st.prices, gkey = need(ctx.env, "GROQ_API_KEY"), ckey = claudeKey(ctx.env);
  const base = "video-studio/" + p.owner_uid + "/" + p.id + "/transcripts/", wd = mkwd(ctx), dur = Number(pl.duration_sec), model = pl.model, whisper = pl.whisper, reserved = job.reserved_usd || 0, t0 = Date.now();
  try {
    const tkey = sha(whisper, pl.groq_prompt || "", Math.round(dur), p.source_path), tpath = base + "groq_" + tkey + ".json"; let tr;
    await ctx.check("download", 3);
    if (await ctx.storage.stat(tpath)) tr = JSON.parse((await ctx.storage.readBuffer(tpath)).toString("utf8"));        // расшифровка уже есть: повторная оплата Groq не нужна
    else {
      const src = await downloadSource(ctx, p, wd); await ctx.check("audio", 12); const audio = await G.extractAudio(src, path.join(wd, "audio.ogg"), { ffmpeg: ctx.ffmpeg, run: ctx.run, cancel: ctx.cancel });
      const spend = dur / 3600 * prices.groq_per_hour[whisper]; if (spend > reserved + 1e-9) throw new StudioError("BUDGET_EXCEEDED", "Стоимость распознавания выше зарезервированной", false);
      await ctx.check("stt", 20); tr = await G.transcribe({ key: gkey, audio, duration: dur, model: whisper, prompt: pl.groq_prompt, language: pl.language || "ru", ffmpeg: ctx.ffmpeg, run: ctx.run, workdir: wd, env: ctx.env, cancel: ctx.cancel, sleep: ctx.sleep, onChunk: (i, n) => { ctx.measured(100 * i / n, { chunk: i + 1, chunks: n }); return ctx.check(); } });
      ctx.spent += spend; await ctx.storage.writeBuffer(tpath, Buffer.from(JSON.stringify(tr)), "application/json");
    }
    const units = M.buildUnits(tr); if (units.length < 3) throw new StudioError("TOO_FEW_PHRASES", "В расшифровке слишком мало фраз", false);
    const N = pl.target_clips ? Number(pl.target_clips) : null, wish = N ? "\n\nЗАДАЧА ПОЛЬЗОВАТЕЛЯ: нужно найти до " + N + " самых сильных самостоятельных моментов. Если действительно сильных моментов меньше — верни только их (или no_good_moments), не придумывай моменты и не повторяй одни и те же, чтобы дотянуть до числа." : "";
    const user = M.promptFor(units) + wish, cpath = base + "claude_" + (N ? sha(model, tkey, "p4", M.SYSTEM.length, "n" + N) : sha(model, tkey, "p4", M.SYSTEM.length)) + ".json", maxTok = N ? Math.min(8000, Math.max(CL.MAX_TOKENS, 1200 + 300 * N)) : CL.MAX_TOKENS; let j;
    await ctx.check("claude", 55);
    if (await ctx.storage.stat(cpath)) j = JSON.parse((await ctx.storage.readBuffer(cpath)).toString("utf8"));
    else {
      const [pin, pout] = prices.claude_per_mtok[model], est = (((M.SYSTEM.length + user.length) / 3 * 1.3) * pin + maxTok * pout) / 1e6;
      if (ctx.spent + est > reserved + 1e-9) throw new StudioError("BUDGET_EXCEEDED", "Не хватает зарезервированного бюджета на анализ Claude", false);
      j = await CL.call({ key: ckey, model, user, env: ctx.env, sleep: ctx.sleep, maxTokens: maxTok }); ctx.spent += CL.cost(j.usage, model, prices); await ctx.storage.writeBuffer(cpath, Buffer.from(JSON.stringify(j)), "application/json");
    }
    const resp = CL.parse(j), { ok: okAll, bad } = M.validate(resp, units, { minFinal: st.clips.min_s, maxFinal: st.clips.max_s, cuts: tpl.cuts }), ok = okAll.slice(0, Number(pl.max_clips || st.clips.max_clips));
    await ctx.check("clips", 70); const src = ok.length ? await downloadSource(ctx, p, wd) : null; let made = 0, firstCid = null; const madeClips = [];
    for (let i = 0; i < ok.length; i++) {
      const c = ok[i]; await ctx.check(); ctx.measured(100 * i / Math.max(1, ok.length), { clip: i + 1, clips: ok.length });
      const byUnit = {}; units.forEach(u => { byUnit[u.id] = u.words.map(w => Object.assign({}, w)); }); M.applyFixes(byUnit, c.fixes);
      const words = M.trimFillers(c.unit_ids.flatMap(id => byUnit[id])); if (!words.length) continue;
      const keep = core.buildKeep(words, tpl.cuts), final = keep.reduce((s, [a, b]) => s + b - a, 0), cid = "c_" + p.id + "_" + sha(c.unit_ids.join(","), tkey);
      if (await get(ctx.db, COLL.clips, cid)) continue;                                                    // клип уже есть (мог быть отредактирован) — не перезаписываем
      const start = words[0].start, end = words[words.length - 1].end, ws = Math.max(0, start - WINDOW_PAD), len = Math.min(end - start + 2 * WINDOW_PAD, Math.max(5, dur - ws)), cdir = "video-studio/" + p.owner_uid + "/" + p.id + "/clips/" + cid + "/";
      const win = await makeWindow(ctx, src, wd, ws, len, start - ws + 0.4, tpl, cdir);
      const clipDoc = { id: cid, project_id: p.id, owner_uid: p.owner_uid, n: i + 1, order: i, title: c.title || c.hook, hook: c.hook, hook_source_quote: c.hook_source_quote || "", start: +start.toFixed(3), end: +end.toFixed(3), duration_s: +final.toFixed(1),
        category: c.category, score: c.score, reason: c.reason || "", status: "found", window_path: win.window_path, thumb_path: win.thumb_path, window_start: +ws.toFixed(3), window_dur: +len.toFixed(3),
        words: words.map(w => ({ id: wid(w.gi), text: w.word, start: +w.start.toFixed(3), end: +w.end.toFixed(3) })), created_at: ctx.now(), workflow: { status: "found", task: "", comment: "", assignee_id: null, rev: 0 } }; await ctx.db.collection(COLL.clips).doc(cid).set(clipDoc); madeClips.push(clipDoc); made++; if (!firstCid) firstCid = cid;
    }
    const compute = (Date.now() - t0) / 3600000 * (prices.compute_per_hour || 0.2), actual = +(ctx.spent + compute).toFixed(6);
    const clipsCount = (await ctx.db.collection(COLL.clips).where("project_id", "==", p.id).get()).docs.length;
    await ctx.db.collection(COLL.projects).doc(p.id).update({ status: "analyzed", counts: { clips: clipsCount }, ...(firstCid ? { cover_clip_id: firstCid } : {}), updated_at: ctx.now(), analysis: { requested_clips: N || Number(pl.max_clips) || null, found_clips: clipsCount, new_clips: made, valid_candidates: okAll.length, job_id: job.id, model, whisper, cost_usd: actual, transcript_path: tpath, no_good_moments: !!resp.no_good_moments || !ok.length, rejected: bad.slice(0, 20).map(r => ({ reason: r.reason, hook: String(r.hook || "").slice(0, 80) })), at: ctx.now() } });
    /* Автосборка: клипы, созданные анализом, сразу собираются в готовые видео (пользователь не собирает каждый вручную). Ручные сборки идут раньше (приоритет 5 < 7). */
    if (pl.auto_render !== false && madeClips.length) {
      await ctx.check("autorender", 99);
      for (const cl of madeClips) { try { const plan = await RP.planRender({ db: ctx.db, now: ctx.now, clip: cl, st, kind: "render" }); if (!plan.checks.can_render) { ctx.warn && ctx.warn("Клип «" + String(cl.title || cl.hook).slice(0, 40) + "»: слишком длинный для автосборки"); continue; }
        await J.enqueue(ctx.db, ctx.now, { type: "render", project_id: p.id, clip_id: cl.id, owner_uid: p.owner_uid, key: plan.key, priority: 7, payload: Object.assign(plan.payload, { auto: true }) }); await ctx.db.collection(COLL.clips).doc(cl.id).update({ status: "rendering", updated_at: ctx.now() }); }
      catch (e) { ctx.warn && ctx.warn("Автосборка клипа не поставлена: " + String(e && e.message).slice(0, 100)); } }
    }
    await B.settle(ctx.db, ctx.now, job, actual); await event(ctx, "analyze.done", { clips: made, cost_usd: actual });
    return { clips: made, rejected: bad.length, cost: { actual_usd: actual, ai_usd: +ctx.spent.toFixed(6) } };
  } finally { rmwd(wd); }
}

/* ---------------------------------------------------------------- новое окно предпросмотра вокруг изменённого диапазона */
async function handleWindow(ctx, job) {
  const c = await get(ctx.db, COLL.clips, job.clip_id), p = c && await get(ctx.db, COLL.projects, c.project_id); if (!c || !p || p.status === "deleted") return { skipped: "gone" };
  const pl = job.payload, st = await ctx.settings(), wd = mkwd(ctx);
  try {
    const S0 = await sourceFor(ctx, p, wd), dur = p.duration_sec, ws = Math.max(0, pl.start - WINDOW_PAD), len = Math.min(pl.end - pl.start + 2 * WINDOW_PAD, Math.max(5, dur - ws)), cdir = "video-studio/" + p.owner_uid + "/" + p.id + "/clips/" + c.id + "/";
    await ctx.check("render", 40); const win = await tryRemote(ctx, p, wd, S0, src => makeWindow(ctx, src, wd, ws, len, pl.start - ws + 0.4, st.template, cdir));
    await ctx.db.collection(COLL.clips).doc(c.id).update({ window_path: win.window_path, thumb_path: win.thumb_path || c.thumb_path || null, window_start: +ws.toFixed(3), window_dur: +len.toFixed(3), updated_at: ctx.now() }); return { window_start: ws, window_dur: len };
  } finally { rmwd(wd); }
}

/* ---------------------------------------------------------------- рендер и предпросмотр; после готового экспорта — автоотправка в Telegram */
async function resolveLogo(ctx, tpl, wd) {
  const lg = tpl.logo; if (!lg || !lg.enabled) return null;
  if (lg.source === "custom") { const loc = path.join(wd, "logo.png"); try { await ctx.storage.download("video-studio/_brand/logo.png", loc); return loc; } catch (e) { return null; } }
  const m = /^brand:([A-Za-z0-9._-]{1,60}\.png)$/.exec(lg.source || ""); if (!m) return null; const f = path.join(BRAND_DIR, path.basename(m[1])); return fs.existsSync(f) ? f : null;
}
async function handleRender(ctx, job, mode) {
  const pl = job.payload, clip = await get(ctx.db, COLL.clips, job.clip_id), p = await get(ctx.db, COLL.projects, job.project_id); if (!clip || !p || p.status === "deleted") return { skipped: "gone" };
  const tpl = pl.template, wd = mkwd(ctx), folder = mode === "final" ? "exports" : "previews", outRel = "video-studio/" + p.owner_uid + "/" + p.id + "/" + folder + "/" + clip.id + "_" + pl.hash + ".mp4";
  try {
    let info = {};
    if (!(await ctx.storage.stat(outRel))) {                                                                 // готовый файл с тем же хэшем уже есть — не пересобираем
      const S0 = await sourceFor(ctx, p, wd), logoPath = await resolveLogo(ctx, tpl, wd);
      const words = pl.words.map(w => ({ word: w.word, start: w.start, end: w.end, id: w.id })), keep = core.buildKeep(words, tpl.cuts), out = path.join(wd, "out.mp4");
      await ctx.check("render", 20);
      info = await tryRemote(ctx, p, wd, S0, src => R.renderClip({ src, clip: { words, keep, hook: pl.hook.text, hook_cfg: pl.hook, cta_cfg: pl.cta || {}, caption_cfg: pl.caption || null, breaks: pl.breaks || [], joins: pl.joins || [], emphasis: pl.emphasis || [] }, outpath: out, font: ctx.font, workdir: path.join(wd, "w"), tpl,
        ffmpeg: ctx.ffmpeg, ffprobe: ctx.ffprobe, run: ctx.run, mode, framing: pl.framing || null, logoPath, cancel: ctx.cancel, onProgress: f => ctx.measured(Math.round(100 * f)) }));
      await ctx.check("upload", 92); await ctx.storage.upload(out, outRel, "video/mp4");
    } else info = { final_s: clip.duration_s };
    const stat = await ctx.storage.stat(outRel), rec = { hash: pl.hash, path: outRel, at: ctx.now(), size: stat ? stat.size : null, duration: info.final_s };
    if (mode === "final") await ctx.db.collection(COLL.clips).doc(clip.id).update({ render: rec, status: "done", error: null, updated_at: ctx.now() });
    else await ctx.db.collection(COLL.clips).doc(clip.id).update({ preview: rec, updated_at: ctx.now() });
    await event(ctx, mode + ".done", { clip_id: clip.id, size: rec.size });
    if (mode === "final") {                                                                                  // автоотправка: только готового MP4 и только если Telegram настроен и включён
      const st = await ctx.settings(), chat = st.telegram.chat_id || TG.defaultChat(ctx.env);
      if (!pl.auto && st.telegram.auto_send && chat && TG.token(ctx.env)) await J.enqueue(ctx.db, ctx.now, { type: "telegram", project_id: p.id, clip_id: clip.id, owner_uid: p.owner_uid, key: clip.id + "_" + pl.hash + "_auto", payload: { clip_id: clip.id, hash: pl.hash, force: false, trigger: "auto" }, priority: 4 });
    }
    return { path: outRel, size: rec.size, duration: rec.duration };
  } finally { rmwd(wd); }
}

/* ---------------------------------------------------------------- доставка в Telegram */
async function fitForTelegram(ctx, file, durationS, wd) {
  const limit = TG.limitBytes(ctx.env); if (fs.statSync(file).size <= limit) return file;
  const out = path.join(wd, "tg_fit.mp4"), bitrate = Math.max(300, Math.floor((limit * 8 * 0.9) / Math.max(1, durationS) / 1000) - 192);          // целевой размер ≈ 90% лимита
  const r = await ctx.run([ctx.ffmpeg, "-y", "-v", "error", "-i", file, "-c:v", "libx264", "-preset", "medium", "-b:v", bitrate + "k", "-maxrate", bitrate + "k", "-bufsize", bitrate * 2 + "k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out], { cancel: ctx.cancel });
  return r.code === 0 && fs.statSync(out).size <= limit ? out : file;
}
/* Отправка готового клипа в чат «себе» или монтажёру (бот Video Studio): видео + подпись + отдельное сообщение с заданием; права и назначение перепроверяются в момент отправки */
async function handleTgSend(ctx, job) {
  const pl = job.payload, clip = await get(ctx.db, COLL.clips, pl.clip_id), p = clip && await get(ctx.db, COLL.projects, clip.project_id); if (!clip || !p) return { skipped: "gone" };
  if (!TG.token(ctx.env)) throw new StudioError("TG_DISABLED", "Интеграция Telegram для Video Studio выключена", false);
  const r = clip.render; if (!r || !r.path) throw new StudioError("NOT_RENDERED", "У клипа нет готового видео", false); const w = Object.assign({ status: "found", task: "", comment: "", assignee_id: null }, clip.workflow || {});
  if (pl.target === "editor") { const ed = await get(ctx.db, COLL.editors, pl.editor_id); if (!ed || ed.active === false || !ed.telegram || String(ed.telegram.user_id) !== String(pl.chat_id) || w.assignee_id !== ed.id) throw new StudioError("NOT_ASSIGNED", "Клип больше не назначен этому монтажёру: отправка отменена", false); }
  const LBL = { found: "Найден", pending: "Ожидает редактирования", needs_changes: "Нужны правки", in_progress: "В работе у монтажёра", review: "На проверке", ready: "Готов", approved: "Утверждён" }, title = String(clip.title || clip.hook || "Клип").slice(0, 120);
  const caption = ("🎬 " + title + "\nПроект: " + String(p.title || p.filename).slice(0, 80) + "\nСтатус: " + (LBL[w.status] || w.status) + (w.task ? "\n\n📝 Задание — в следующем сообщении" : "")).slice(0, 1000), wd = mkwd(ctx);
  await ctx.check("download", 10); const local = path.join(wd, "clip.mp4"); await ctx.storage.download(r.path, local); const file = await fitForTelegram(ctx, local, r.duration || clip.duration_s || 30, wd);
  await ctx.check("upload", 60); let res;
  try { res = await TG.sendVideo(ctx.env, { chatId: pl.chat_id, filePath: file, caption, width: 1080, height: 1920, duration: Math.round(r.duration || 0) || undefined }); }
  catch (e) { if (e.code === "TG_TOO_BIG") { const url = await ctx.storage.signedReadUrl(r.path, { ttlSec: 24 * 3600, filename: "clip.mp4" }); res = await TG.sendMessage(ctx.env, pl.chat_id, caption + "\n\nВидео больше лимита Telegram, скачать (ссылка действует 24 часа): " + url); } else throw e; }
  if (w.task) { const t = (w.comment ? "📝 Задание:\n" + w.task + "\n\n💬 Комментарий:\n" + w.comment : "📝 Задание:\n" + w.task); for (let i = 0; i < t.length; i += 3800) await TG.sendMessage(ctx.env, pl.chat_id, t.slice(i, i + 3800)); }
  { const ref = ctx.db.collection(COLL.clips).doc(clip.id), rec = { at: ctx.now(), message_id: res && res.message_id || null, hash: r.hash, target: pl.target };
    await ctx.db.runTransaction(async tx => { const cur = await tx.get(ref); tx.update(ref, { deliveries: Object.assign({}, (cur.data() || {}).deliveries || {}, { [pl.delivery_key]: rec }) }); }); }   // слияние в транзакции: параллельные отправки разным монтажёрам не затирают друг друга
  await ctx.db.collection(COLL.clipEvents).doc("ce_" + job.id).set({ clip_id: clip.id, project_id: p.id, owner_uid: p.owner_uid, at: ctx.now(), by: "system", kind: "sent", note: pl.target === "owner" ? "Доставлено себе в Telegram" : "Доставлено монтажёру в Telegram", editor_id: pl.editor_id || null }).catch(() => {});
  return { ok: true, message_id: res && res.message_id || null };
}
async function handleTelegram(ctx, job) {
  const pl = job.payload, clip = await get(ctx.db, COLL.clips, pl.clip_id), p = clip && await get(ctx.db, COLL.projects, clip.project_id); if (!clip || !p) return { skipped: "gone" };
  const r = clip.render; if (!r || !r.path) throw new StudioError("NOT_RENDERED", "У клипа нет готового экспорта: сначала нажмите «Пересобрать видео».", false);
  if (pl.hash && pl.hash !== r.hash) return { skipped: "stale_render" };                                          // за это время клип пересобрали: отправим актуальную версию отдельным заданием
  const st = await ctx.settings(), chat = st.telegram.chat_id || TG.defaultChat(ctx.env); if (!chat) throw new StudioError("TG_CHAT", "Не указан Chat ID Telegram.", false);
  // защита от повторной отправки: одна отправка на версию экспорта, и только одним заданием одновременно
  const ref = ctx.db.collection(COLL.clips).doc(clip.id), gate = await ctx.db.runTransaction(async tx => {
    const s = await tx.get(ref), c = s.data(), tg = c.telegram || {};
    if (tg.status === "sent" && tg.hash === r.hash && !pl.force) return { skip: "already_sent", tg };
    if (tg.status === "sending" && tg.lock && tg.lock !== job.id && ctx.now() - (tg.started_at || 0) < 600000) return { skip: "in_progress", tg };
    tx.update(ref, { telegram: Object.assign({}, tg, { status: "sending", lock: job.id, started_at: ctx.now(), hash: r.hash, chat_id: chat, error: null }) }); return { ok: true, tg };
  });
  if (gate.skip) return { skipped: gate.skip };
  const wd = mkwd(ctx), attempts = ((gate.tg || {}).attempts || 0) + 1;
  const fail = async e => { const err = { code: e.code || "TG_ERROR", message: e.message, retryable: !!e.retryable }, prev = gate.tg || {}, last = prev.last_sent || (prev.status === "sent" || prev.status === "sent_link" ? { message_id: prev.message_id || null, sent_at: prev.sent_at || null } : null); await ctx.db.collection(COLL.clips).doc(clip.id).update({ telegram: { status: e.retryable ? "retrying" : "failed", hash: r.hash, chat_id: chat, attempts, error: err, updated_at: ctx.now(), message_id: null, last_sent: last } }); };
  try {
    // повторная отправка уже загруженного ролика идёт по file_id (без скачивания и повторной загрузки); полная перезагрузка — по запросу (reupload)
    const useId = (!pl.reupload && (gate.tg || {}).hash === r.hash && (gate.tg || {}).file_id) || null; let file = null;
    const ed = await get(ctx.db, COLL.edits, clip.id), caption = String((ed && ed.hook && ed.hook.text) || clip.hook || "").slice(0, 900);
    if (!useId) { await ctx.check("download", 10); const local = path.join(wd, "clip.mp4"); await ctx.storage.download(r.path, local); file = await fitForTelegram(ctx, local, r.duration || clip.duration_s || 30, wd); }
    await ctx.check("upload", 50); let res, kind = "video";
    try { res = await TG.sendVideo(ctx.env, { chatId: chat, filePath: file, fileId: useId, caption, width: 1080, height: 1920, duration: Math.round(r.duration || 0) || undefined }); }
    catch (e) {
      if (useId && /file identifier|wrong remote file|file_id/i.test(String(e.message))) { await ctx.db.collection(COLL.clips).doc(clip.id).update({ "telegram.file_id": null }); throw new StudioError("TG_FILE_ID", "Telegram не принял сохранённый file_id — загрузим файл заново.", true); }
      if (e.code === "TG_TOO_BIG" && st.telegram.link_fallback) { const url = await ctx.storage.signedReadUrl(r.path, { ttlSec: 24 * 3600, filename: "hidden-dinox-clip.mp4" }); const m = await TG.sendMessage(ctx.env, chat, "Готовый ролик слишком большой для Telegram (лимит бота 50 МБ). Скачать можно по ссылке (действует 24 часа):\n" + url); res = { message_id: m.message_id, file_id: null }; kind = "link"; }
      else throw e;
    }
    await ctx.db.collection(COLL.clips).doc(clip.id).update({ telegram: { status: kind === "link" ? "sent_link" : "sent", kind, hash: r.hash, chat_id: chat, message_id: res.message_id, file_id: res.file_id || null, attempts, sent_at: ctx.now(), error: null } });
    await event(ctx, "telegram.sent", { clip_id: clip.id, message_id: res.message_id, kind }); return { message_id: res.message_id, kind };
  } catch (e) { if (e && e.cancelled) throw e; if (e instanceof StudioError) { await fail(e); throw e; } await fail({ code: "TG_ERROR", message: String(e.message).slice(0, 200), retryable: true }); throw e; }
  finally { rmwd(wd); }
}
const HANDLERS = { tg_send: handleTgSend, probe: handleProbe, analyze: handleAnalyze, window: handleWindow, render: (c, j) => handleRender(c, j, "final"), preview: (c, j) => handleRender(c, j, "preview"), telegram: handleTelegram };
module.exports = { __test: { sourceFor, tryRemote, downloadSource }, HANDLERS, wid, makeWindow, WINDOW_PAD, claudeKey };
