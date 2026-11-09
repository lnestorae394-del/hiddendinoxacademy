"use strict";
/* HIDDEN DINOX VIDEO STUDIO — API (/api/video-studio/*).
   Каждый маршрут: проверенный Firebase ID-токен → users/{uid} (блокировка, роль) → только admin/super_admin → владелец проекта.
   Видео сервер не принимает: выдаёт защищённую возобновляемую сессию загрузки прямо в Firebase Storage и ссылки на 15 минут.
   Из чужих коллекций Academy читается только users/{uid}; секреты (токен бота, ключи) в ответы и в Firestore не попадают. */
const crypto = require("crypto"), fs = require("fs"), path = require("path");
const R = require("../academy/roles"), K = require("./constants"), S = require("./settings"), E = require("./edits"), B = require("./budget"), J = require("./jobs");
const M = require("./moments"), CL = require("./claude"), TG = require("./telegram"), FF = require("./ffmpeg"), { looksLikeIsoVideo } = require("./storage-adapter"), core = require("../public/academy/admin/vs-core.js");
const { COLL } = K;
class HttpError extends Error { constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra; } }
const newId = p => p + "_" + crypto.randomBytes(8).toString("hex");
const sha = o => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 12);
const ACTIVE = ["queued", "claimed", "running"], MIME_BY_EXT = { mp4: "video/mp4", mov: "video/quicktime" }, BRAND_DIR = path.join(__dirname, "..", "public", "academy", "assets", "brand");
const wid = i => "w" + String(i).padStart(6, "0");

function createVideoStudioApi({ db, verifyIdToken, storage, runner = null, log = console, now = () => Date.now(), env = process.env }) {
  const hits = new Map(), tcache = new Map(), capsCache = { t: 0, v: null };
  const limited = (key, limit, windowMs) => { const t = now(), arr = (hits.get(key) || []).filter(x => t - x < windowMs); arr.push(t); hits.set(key, arr); if (hits.size > 5000) hits.clear(); return arr.length > limit; };
  const col = n => db.collection(n), kick = () => { if (runner && runner.kick) runner.kick(); };
  const get = async (n, id) => { const d = await col(n).doc(id).get(); return d.exists ? Object.assign({ id }, d.data()) : null; };
  const event = (actor, action, d = {}) => col(COLL.events).doc(newId("ev")).set(Object.assign({ at: now(), uid: actor.uid, action }, d)).catch(e => log.error && log.error("video-studio event:", e && e.message));
  const loadSettings = () => S.loadSettings(db, env);

  /* -------- доступ: ТОЛЬКО администраторы, проверка на сервере -------- */
  async function authenticate(req) {
    if (!db || !verifyIdToken) throw new HttpError(503, "CONFIG_MISSING");
    const h = req.headers && (req.headers.authorization || req.headers.Authorization), m = typeof h === "string" && h.match(/^Bearer ([A-Za-z0-9._-]{10,4096})$/);
    if (!m) throw new HttpError(401, "UNAUTHENTICATED");
    let dec; try { dec = await verifyIdToken(m[1]); } catch (e) { throw new HttpError(401, "UNAUTHENTICATED"); }
    if (!dec || !dec.uid) throw new HttpError(401, "UNAUTHENTICATED");
    const u = await get("users", dec.uid); if (u && u.blocked === true) throw new HttpError(403, "ACCOUNT_BLOCKED");
    const role = R.roleOf(u); if (!(R.RANK[role] >= R.RANK.admin)) throw new HttpError(403, "FORBIDDEN", "Video Studio доступна только администраторам");
    return { uid: dec.uid, email: (u && u.email) || dec.email || null, role, isAdmin: true };
  }
  const ownProject = async (actor, id) => { const p = await get(COLL.projects, String(id)); if (!p || p.status === "deleted") throw new HttpError(404, "NOT_FOUND"); if (p.owner_uid !== actor.uid && !actor.isAdmin) throw new HttpError(404, "NOT_FOUND"); return p; };
  const ownClip = async (actor, id) => { const c = await get(COLL.clips, String(id)); if (!c) throw new HttpError(404, "NOT_FOUND"); return { clip: c, project: await ownProject(actor, c.project_id) }; };
  const ownJob = async (actor, id) => { const j = await get(COLL.jobs, String(id)); if (!j) throw new HttpError(404, "NOT_FOUND"); if (j.owner_uid !== actor.uid && !actor.isAdmin) throw new HttpError(404, "NOT_FOUND"); return j; };

  /* -------- доверенные адреса загрузки: из VIDEO_STUDIO_ORIGIN и адрес самой страницы (same-origin) -------- */
  function trustedOrigins(req) {
    const list = String(env.VIDEO_STUDIO_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean), host = req.headers && req.headers.host;
    if (host) { const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim(); list.push(proto + "://" + host); }
    return [...new Set(list.map(o => { try { const u = new URL(o); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.origin : null; } catch (e) { return null; } }).filter(Boolean))];
  }
  function pickOrigin(req) {
    const trusted = trustedOrigins(req); if (!trusted.length) throw new HttpError(503, "ORIGIN_NOT_CONFIGURED", "Не задан VIDEO_STUDIO_ORIGIN: загрузка отключена");
    const raw = req.headers && req.headers.origin; if (raw === undefined) return trusted[0];
    let o = null; try { o = new URL(String(raw)).origin; } catch (e) { /* некорректный */ }
    if (!o || o === "null" || !trusted.includes(o)) throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "Загрузка разрешена только со страницы Video Studio"); return o;
  }
  const claudeKey = () => String(env.VIDEO_STUDIO_ANTHROPIC_API_KEY || env.STUDIO_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || "").trim();

  const H = {
    async me(req, actor) {
      const st = await loadSettings();
      return { uid: actor.uid, role: actor.role, is_admin: true, configured: B.configured(st.limits), limits: { max_upload_gb: st.limits.max_upload_gb, max_duration_min: st.limits.max_duration_min, monthly_usd: st.limits.monthly_usd, per_job_usd: st.limits.per_job_usd },
        clips: st.clips, chunk_bytes: K.CHUNK_BYTES, telegram: { configured: !!TG.token(env), chat_id: st.telegram.chat_id || TG.defaultChat(env) || "", auto_send: st.telegram.auto_send } };
    },
    async health(req, actor) {
      if (!capsCache.v || now() - capsCache.t > 60000) { capsCache.v = await FF.capabilities(env).catch(e => ({ ok: false, error: String(e.message) })); capsCache.t = now(); }
      const jobs = (await col(COLL.jobs).where("status", "==", "queued").get()).docs.length;
      return { ffmpeg: capsCache.v, storage: storage.kind, keys: { groq: !!String(env.GROQ_API_KEY || "").trim(), claude: !!claudeKey(), telegram: !!TG.token(env), telegram_chat: !!TG.defaultChat(env) },
        runner: runner ? { running: runner.running > 0, started_at: runner.state && runner.state.started_at, last_job: runner.state && runner.state.last_job, last_error: runner.state && runner.state.last_error } : null, queued_jobs: jobs, origins: trustedOrigins(req) };
    },
    async getSettings(req, actor) {
      const st = await loadSettings(), usage = await B.usageOf(db, now); delete usage.jobs;
      return { template: st.template, vocabulary: st.vocabulary, limits: st.limits, prices: st.prices, clips: st.clips, telegram: { chat_id: st.telegram.chat_id, auto_send: st.telegram.auto_send, link_fallback: st.telegram.link_fallback }, usage, groq_prompt: S.buildGroqPrompt(st.vocabulary), can_edit: true };
    },
    async putSettings(req, actor) {
      const b = req.body || {}, wrote = [], set = (id, data) => col(COLL.settings).doc(id).set(Object.assign(data, { updated_at: now(), updated_by: actor.uid }));
      if (b.template !== undefined) { const patch = S.validateTemplatePatch(b.template), cur = (await get(COLL.settings, "template")) || {}; const next = Object.assign({}, cur); for (const [sec, vals] of Object.entries(patch)) next[sec] = Object.assign({}, cur[sec] || {}, vals); delete next.id; await set("template", next); wrote.push("template"); }
      if (b.vocabulary !== undefined) { await set("vocabulary", S.validateVocabulary(b.vocabulary)); wrote.push("vocabulary"); }
      if (b.limits !== undefined) { const cur = (await get(COLL.settings, "limits")) || {}; delete cur.id; await set("limits", Object.assign(cur, S.validateLimits(b.limits))); wrote.push("limits"); }
      if (b.prices !== undefined) { await set("prices", S.validatePrices(b.prices)); wrote.push("prices"); }
      if (b.clips !== undefined) { const v = S.validateClips(b.clips), cur = (await get(COLL.settings, "clips")) || {}; delete cur.id; const merged = Object.assign({}, S.DEFAULT_CLIPS, cur, v); if (merged.max_s <= merged.min_s) throw new HttpError(400, "INVALID_CLIPS", "Максимум должен быть больше минимума"); await set("clips", Object.assign(cur, v)); wrote.push("clips"); }
      if (!wrote.length) throw new HttpError(400, "INVALID", "Нечего сохранять"); await event(actor, "settings.update", { sections: wrote }); return { ok: true, saved: wrote };
    },

    async resetTemplate(req, actor) { await col(COLL.settings).doc("template").delete(); await event(actor, "settings.template_reset", {}); return { ok: true }; },
    /* ---- Telegram ---- */
    async getTelegram(req, actor) { const st = await loadSettings(); return { configured: !!TG.token(env), chat_id: st.telegram.chat_id || TG.defaultChat(env) || "", default_chat: TG.defaultChat(env) || "", auto_send: st.telegram.auto_send, link_fallback: st.telegram.link_fallback, limit_mb: Math.round(TG.limitBytes(env) / 1048576) }; },
    async putTelegram(req, actor) { const v = S.validateTelegram(req.body || {}); if (!Object.keys(v).length) throw new HttpError(400, "INVALID", "Нечего сохранять"); const cur = (await get(COLL.settings, "telegram")) || {}; delete cur.id; await col(COLL.settings).doc("telegram").set(Object.assign(cur, v, { updated_at: now(), updated_by: actor.uid })); await event(actor, "telegram.settings", {}); return { ok: true }; },
    async checkTelegram(req, actor) {
      const st = await loadSettings(), chat = String((req.body && req.body.chat_id) || st.telegram.chat_id || TG.defaultChat(env) || "").trim();
      try { return Object.assign({ ok: true }, await TG.checkConnection(env, chat)); } catch (e) { return { ok: false, error: e.message, code: e.code || "TG_ERROR" }; }
    },
    async testTelegram(req, actor) {
      const st = await loadSettings(), chat = String((req.body && req.body.chat_id) || st.telegram.chat_id || TG.defaultChat(env) || "").trim(); if (!TG.validChat(chat)) throw new HttpError(400, "TG_CHAT", "Укажите корректный Chat ID.");
      try { const m = await TG.sendMessage(env, chat, "✅ Hidden Dinox Video Studio: тестовое сообщение. Если вы это видите, готовые ролики будут приходить сюда."); await event(actor, "telegram.test", { message_id: m.message_id }); return { ok: true, message_id: m.message_id }; }
      catch (e) { throw new HttpError(e.retryable ? 502 : 400, e.code || "TG_ERROR", e.message); }
    },
    async sendTelegram(req, actor) {
      const { clip, project } = await ownClip(actor, req.params.id), force = !!(req.body && req.body.force === true), r = clip.render;
      if (!r || !r.path) throw new HttpError(409, "NOT_RENDERED", "У клипа нет готового экспорта: сначала нажмите «Пересобрать видео».");
      if (!TG.token(env)) throw new HttpError(503, "TG_NO_TOKEN", "Не задан TELEGRAM_BOT_TOKEN в переменных окружения сервера.");
      const st = await loadSettings(); if (!(st.telegram.chat_id || TG.defaultChat(env))) throw new HttpError(400, "TG_CHAT", "Не указан Chat ID Telegram (⚙ → Telegram).");
      const tg = clip.telegram || {}; if (tg.status === "sent" && tg.hash === r.hash && !force) return { already_sent: true, telegram: publicTelegram(tg) };
      // уже идёт отправка этого клипа — двойной клик не создаёт второе задание; иначе всегда новое задание (повтор возможен в любой момент)
      const active = (await col(COLL.jobs).where("clip_id", "==", clip.id).get()).docs.map(d => Object.assign({ id: d.id }, d.data())).find(j => j.type === "telegram" && ACTIVE.includes(j.status)); if (active) return { job: publicJob(active), queued: true, in_progress: true };
      const reupload = !!(req.body && req.body.reupload === true), { job } = await J.enqueue(db, now, { type: "telegram", project_id: project.id, clip_id: clip.id, owner_uid: project.owner_uid, key: clip.id + "_" + r.hash + "_m" + now() + "_" + crypto.randomBytes(3).toString("hex"), payload: { clip_id: clip.id, hash: r.hash, force, reupload, trigger: "manual" }, priority: 3 });
      const wasSent = tg.status === "sent" || tg.status === "sent_link"; await col(COLL.clips).doc(clip.id).update({ telegram: Object.assign({}, tg, { status: "queued", hash: r.hash, error: null, last_sent: wasSent ? { message_id: tg.message_id || null, sent_at: tg.sent_at || null } : (tg.last_sent || null) }) }); kick(); await event(actor, "telegram.send", { clip_id: clip.id, force, reupload }); return { job: publicJob(job), queued: true };
    },

    /* ---- логотип ---- */
    async getLogo(req, actor) {
      let files = []; try { files = fs.readdirSync(BRAND_DIR).filter(f => /^[A-Za-z0-9._-]+\.png$/.test(f) && !f.startsWith("._")); } catch (e) { /* нет каталога */ }
      const custom = await storage.stat("video-studio/_brand/logo.png"); let url = null; if (custom) url = await storage.signedReadUrl("video-studio/_brand/logo.png", { ttlSec: K.SIGNED_URL_TTL_SEC, contentType: "image/png" });
      return { brand: files, custom: !!custom, custom_url: url };
    },
    async putLogo(req, actor) {
      const b64 = req.body && req.body.png_base64; if (typeof b64 !== "string" || b64.length > 1000000) throw new HttpError(400, "INVALID", "Нужен PNG до ~700 КБ в base64");
      const buf = Buffer.from(b64, "base64"); if (buf.length < 100 || buf.length > 720000 || buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new HttpError(400, "BAD_FORMAT", "Это не PNG-файл или он слишком большой (до 700 КБ)");
      const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20); if (!(w > 0 && h > 0 && w <= 3000 && h <= 3000)) throw new HttpError(400, "BAD_FORMAT", "Размер логотипа до 3000×3000 пикселей");
      await storage.writeBuffer("video-studio/_brand/logo.png", buf, "image/png"); const cur = (await get(COLL.settings, "template")) || {}; delete cur.id; cur.logo = Object.assign({}, cur.logo || {}, { source: "custom" });
      await col(COLL.settings).doc("template").set(Object.assign(cur, { updated_at: now(), updated_by: actor.uid })); await event(actor, "logo.upload", { size: buf.length }); return { ok: true, width: w, height: h };
    },
    async setCors(req, actor) {
      const origins = trustedOrigins(req); if (!origins.length) throw new HttpError(503, "ORIGIN_NOT_CONFIGURED", "Не задан VIDEO_STUDIO_ORIGIN");
      try { await storage.setCors(origins); await event(actor, "storage.cors", { origins }); return { ok: true, origins }; }
      catch (e) { return { ok: false, origins, error: String(e.message).slice(0, 200), manual: "gsutil cors set cors.json gs://<бакет>  (cors.json: [{\"origin\":" + JSON.stringify(origins) + ",\"method\":[\"PUT\",\"GET\",\"HEAD\",\"OPTIONS\"],\"responseHeader\":[\"Content-Type\",\"Content-Range\",\"Range\",\"x-goog-resumable\"],\"maxAgeSeconds\":3600}])" }; }
    },

    /* ---- проекты и загрузка ---- */
    async listProjects(req, actor) {
      const q = req.query && req.query.all === "1" ? col(COLL.projects) : col(COLL.projects).where("owner_uid", "==", actor.uid);
      return { projects: (await q.get()).docs.map(d => Object.assign({ id: d.id }, d.data())).filter(p => p.status !== "deleted").sort((a, b) => b.created_at - a.created_at).slice(0, 100).map(publicProject) };
    },
    async createProject(req, actor) {
      const origin = pickOrigin(req);                                    // САМАЯ ПЕРВАЯ проверка: чужой Origin не расходует квоту и не оставляет следов
      if (limited("up:" + actor.uid, 20, 3600000)) throw new HttpError(429, "TOO_MANY", "Слишком много загрузок за час");
      const b = req.body || {}, st = await loadSettings(); if (!B.configured(st.limits)) throw new HttpError(402, "BUDGET_NOT_CONFIGURED", "Лимиты Video Studio не заданы (⚙).");
      const name = String(b.filename || "").replace(/[\u0000-\u001f\u007f\\/]/g, "").trim().slice(0, 200), ext = (name.split(".").pop() || "").toLowerCase();
      if (!name || !K.ALLOWED_EXT.includes(ext)) throw new HttpError(400, "BAD_FORMAT", "Поддерживаются только MP4 и MOV");
      const ctype = b.content_type ? String(b.content_type).toLowerCase() : MIME_BY_EXT[ext]; if (!K.ALLOWED_MIME.includes(ctype)) throw new HttpError(400, "BAD_FORMAT", "Недопустимый тип файла: " + ctype);
      const size = b.size, maxBytes = Math.min(st.limits.max_upload_gb * 2 ** 30, K.HARD_CAPS.maxUploadBytes);
      if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, "BAD_SIZE", "Не указан размер файла"); if (size > maxBytes) throw new HttpError(413, "FILE_TOO_LARGE", "Файл больше допустимого (" + (maxBytes / 2 ** 30).toFixed(1) + " ГБ)");
      const fp = b.fingerprint === undefined ? null : String(b.fingerprint); if (fp !== null && !/^[A-Za-z0-9:_.\-]{1,200}$/.test(fp)) throw new HttpError(400, "INVALID", "Некорректный отпечаток файла");
      const mine = (await col(COLL.projects).where("owner_uid", "==", actor.uid).get()).docs.map(d => Object.assign({ id: d.id }, d.data()));
      const dup = fp && mine.find(p => p.fingerprint === fp && !["error", "deleted"].includes(p.status) && !(p.status === "uploading" && now() > ((p.upload || {}).expires_at || 0)));
      if (dup && b.allow_duplicate !== true) throw new HttpError(409, "DUPLICATE", "Этот файл уже загружен или загружается", { project_id: dup.id, status: dup.status });
      if (mine.filter(p => p.status === "uploading" && now() < ((p.upload || {}).expires_at || 0)).length >= 2) throw new HttpError(429, "TOO_MANY_UPLOADS", "Уже идут две загрузки: завершите или отмените их");
      const id = newId("p"), p = "video-studio/" + actor.uid + "/" + id + "/source/original." + ext, expires = now() + K.UPLOAD_SESSION_TTL_SEC * 1000;
      let session; try { session = storage.kind === "r2" ? await storage.createMultipartSession({ path: p, contentType: ctype, size }) : await storage.createResumableSession({ path: p, contentType: ctype, size, origin }); } catch (e) { log.error && log.error("video-studio session:", e && e.message); throw new HttpError(503, "STORAGE_UNAVAILABLE", "Хранилище временно недоступно"); }
      const doc = { id, owner_uid: actor.uid, owner_email: actor.email, filename: name, size_bytes: size, content_type: ctype, fingerprint: fp, status: "uploading", source_path: p, upload: { expires_at: expires, declared_size: size, ...(storage.kind === "r2" ? { upload_id: session.upload_id, multipart: true } : {}) }, duration_sec: null, counts: { clips: 0 }, error: null, created_at: now(), updated_at: now() };
      await col(COLL.projects).doc(id).set(doc); await event(actor, "project.create", { project_id: id, size });
      return { project: publicProject(doc), upload: storage.kind === "r2" ? { multipart: true, upload_id: session.upload_id, part_bytes: 64 * 1024 * 1024, expires_at: expires, content_type: ctype } : { url: session.url, chunk_bytes: K.CHUNK_BYTES, expires_at: expires, content_type: ctype } };
    },
    async getProject(req, actor) { const p = await ownProject(actor, req.params.id), jobs = (await col(COLL.jobs).where("project_id", "==", p.id).get()).docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => b.created_at - a.created_at).slice(0, 12); return { project: publicProject(p), jobs: jobs.map(publicJob) }; },
    async uploadPartUrl(req, actor) {
      const p = await ownProject(actor, req.params.id); if (storage.kind !== "r2" || !p.upload || !p.upload.upload_id) throw new HttpError(409, "NOT_MULTIPART");
      const n = Number(req.body && req.body.part_number); const total = Math.ceil(p.upload.declared_size / (64 * 1024 * 1024));
      if (!Number.isInteger(n) || n < 1 || n > total || n > 10000) throw new HttpError(400, "BAD_PART", "Некорректный номер части");
      const url = await storage.signUploadPart({ path: p.source_path, uploadId: p.upload.upload_id, partNumber: n, ttlSec: 3600 }); return { url, part_number: n };
    },
    async listUploadParts(req, actor) {
      const p = await ownProject(actor, req.params.id); if (storage.kind !== "r2" || !p.upload || !p.upload.upload_id) throw new HttpError(409, "NOT_MULTIPART");
      return { parts: await storage.listMultipartParts({ path: p.source_path, uploadId: p.upload.upload_id }) };
    },
    async completeMultipart(req, actor) {
      const p = await ownProject(actor, req.params.id); if (p.status !== "uploading" || storage.kind !== "r2" || !p.upload || !p.upload.upload_id) throw new HttpError(409, "WRONG_STATE");
      const parts = Array.isArray(req.body && req.body.parts) ? req.body.parts : [];
      const expected = Math.ceil(p.upload.declared_size / (64 * 1024 * 1024));
      if (parts.length !== expected || parts.some((x,i) => !x || Number(x.PartNumber) !== i+1 || typeof x.ETag !== "string" || x.ETag.length > 200)) throw new HttpError(400, "PARTS_INCOMPLETE", "Не все части видео загружены");
      await storage.completeMultipartSession({ path: p.source_path, uploadId: p.upload.upload_id, parts });
      await col(COLL.projects).doc(p.id).update({ "upload.multipart_completed": true, "upload.completed_parts": parts.length, updated_at: now() }); return { ok: true, parts: parts.length };
    },
    async completeUpload(req, actor) {
      const p = await ownProject(actor, req.params.id); if (p.status !== "uploading") throw new HttpError(409, "WRONG_STATE", "Загрузка уже завершена или отменена");
      const fail = async (code, msg) => { await storage.remove(p.source_path).catch(() => {}); await col(COLL.projects).doc(p.id).update({ status: "error", error: { code, message: msg }, updated_at: now() }); throw new HttpError(400, code, msg); };
      const st = await storage.stat(p.source_path); if (!st) throw new HttpError(409, "NOT_UPLOADED", "Файл ещё не загружен целиком");
      if (st.size !== p.upload.declared_size) return fail("SIZE_MISMATCH", "Размер загруженного файла не совпал с заявленным");
      if (!looksLikeIsoVideo(await storage.readHead(p.source_path, 16))) return fail("BAD_FORMAT", "Файл не похож на MP4/MOV (заголовок не распознан)");
      await col(COLL.projects).doc(p.id).update({ status: "validating", updated_at: now(), upload: Object.assign({}, p.upload, { completed_at: now() }) });
      const { job } = await J.enqueue(db, now, { type: "probe", project_id: p.id, owner_uid: p.owner_uid, key: p.id, payload: { source_path: p.source_path, size_bytes: p.size_bytes } }); kick(); await event(actor, "upload.complete", { project_id: p.id });
      return { project: publicProject(Object.assign({}, p, { status: "validating" })), job: publicJob(job) };
    },
    async cancelUpload(req, actor) { const p = await ownProject(actor, req.params.id); if (p.status !== "uploading") throw new HttpError(409, "WRONG_STATE", "Загрузка не идёт"); if (storage.kind === "r2" && p.upload && p.upload.upload_id) await storage.abortMultipartSession({ path: p.source_path, uploadId: p.upload.upload_id }).catch(() => {}); await storage.remove(p.source_path).catch(() => {}); await col(COLL.projects).doc(p.id).update({ status: "deleted", updated_at: now(), deleted_at: now() }); await event(actor, "upload.cancel", { project_id: p.id }); return { ok: true }; },
    async deleteProject(req, actor) {
      const p = await ownProject(actor, req.params.id), jobs = (await col(COLL.jobs).where("project_id", "==", p.id).get()).docs.map(d => Object.assign({ id: d.id }, d.data()));
      if (jobs.some(j => ["claimed", "running"].includes(j.status))) throw new HttpError(409, "JOB_RUNNING", "Проект обрабатывается: сначала отмените задание и дождитесь остановки");
      for (const j of jobs) if (j.status === "queued") await J.cancel(db, now, j.id);
      const clips = (await col(COLL.clips).where("project_id", "==", p.id).get()).docs; for (const c of clips) { await col(COLL.edits).doc(c.id).delete(); await col(COLL.clips).doc(c.id).delete(); }
      await storage.removePrefix("video-studio/" + p.owner_uid + "/" + p.id + "/"); await col(COLL.projects).doc(p.id).update({ status: "deleted", updated_at: now(), deleted_at: now(), counts: { clips: 0 } }); await event(actor, "project.delete", { project_id: p.id, clips: clips.length }); return { ok: true };
    },

    /* ---- анализ ---- */
    async estimate(req, actor) { const x = await analysisPlan(req, actor); return { estimate: x.estimate, limits: pubLimits(x.st.limits), clips: x.st.clips, model: x.model, whisper: x.whisper, duration_sec: x.p.duration_sec, groq_prompt_chars: x.groq.prompt.length, ok: true }; },
    async analyze(req, actor) {
      const x = await analysisPlan(req, actor); if (!req.body || req.body.confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED", "Подтвердите расход", { estimate: x.estimate });
      const all = (await col(COLL.jobs).where("project_id", "==", x.p.id).get()).docs.map(d => Object.assign({ id: d.id }, d.data())).filter(j => j.type === "analyze"); if (all.some(j => ACTIVE.includes(j.status))) throw new HttpError(409, "ALREADY_RUNNING", "Анализ уже выполняется");
      const mineActive = (await col(COLL.jobs).where("owner_uid", "==", actor.uid).get()).docs.map(d => d.data()).filter(j => ACTIVE.includes(j.status)).length; if (mineActive >= 4) throw new HttpError(429, "TOO_MANY_JOBS", "В очереди уже 4 ваших задания");
      const key = x.p.id + "_" + sha({ m: x.model, w: x.whisper, pv: 4, vv: sha(x.st.vocabulary.terms), a: x.st.clips.min_s + "-" + x.st.clips.max_s }), jobId = "analyze_" + key, cached = all.find(j => j.id === jobId && j.status === "succeeded");
      if (cached) return { job: publicJob(cached), cached: true, estimate: x.estimate };
      const prev = await get(COLL.jobs, jobId); if (prev && ["failed", "cancelled"].includes(prev.status)) throw new HttpError(409, "USE_RETRY", "Прошлая попытка завершилась ошибкой: нажмите «Повторить»", { job: publicJob(prev) });
      await B.reserve(db, now, { jobId, estimate: x.estimate, limits: x.st.limits });
      const { job, created } = await J.enqueue(db, now, { type: "analyze", project_id: x.p.id, owner_uid: x.p.owner_uid, key, reserved_usd: x.estimate.total_usd, payload: { model: x.model, whisper: x.whisper, language: "ru", groq_prompt: x.groq.prompt, duration_sec: x.p.duration_sec, source_path: x.p.source_path, max_clips: x.st.clips.max_clips, estimate: x.estimate } });
      if (created) await col(COLL.projects).doc(x.p.id).update({ status: "analyzing", updated_at: now() }); else await B.release(db, now, jobId); kick(); await event(actor, "analyze.start", { project_id: x.p.id, estimate_usd: x.estimate.total_usd }); return { job: publicJob(job), created, estimate: x.estimate };
    },

    /* ---- клипы и редактор ---- */
    async listClips(req, actor) { const p = await ownProject(actor, req.params.id), rows = (await col(COLL.clips).where("project_id", "==", p.id).get()).docs.map(d => Object.assign({ id: d.id }, d.data())); rows.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.start - b.start); return { clips: rows.map(publicClip) }; },
    async getClip(req, actor) { const { clip, project } = await ownClip(actor, req.params.id), st = await loadSettings(); return clipView(clip, project, await ensureEdits(clip), st); },
    async patchEdits(req, actor) {
      const { clip } = await ownClip(actor, req.params.id), b = req.body || {}; if (!Number.isInteger(b.base_rev)) throw new HttpError(400, "INVALID", "Нужен base_rev");
      await ensureEdits(clip); const ref = col(COLL.edits).doc(clip.id);
      const result = await db.runTransaction(async tx => { const s = await tx.get(ref), cur = s.data(); if (cur.rev !== b.base_rev) return { conflict: cur }; const next = E.applyOps(cur, b.ops); next.updated_at = now(); next.updated_by = actor.uid; tx.set(ref, next); return { edits: next }; });
      if (result.conflict) throw new HttpError(409, "REV_CONFLICT", "Клип изменён в другом окне: обновите страницу", { edits: result.conflict });
      if (!["rendering", "excluded"].includes(clip.status)) await col(COLL.clips).doc(clip.id).update({ status: "edited", updated_at: now() });
      const st = await loadSettings(); return { edits: result.edits, checks: E.checks(result.edits, st.template.cuts, clipLimits(st)), current_hash: E.editsHash(result.edits, templateStamp(st)), suggestions: S.suggestTerms(E.effectiveWords(result.edits).map(w => ({ id: w.id, text: w.word })), st.vocabulary) };
    },
    /* Обрезка начала/конца: слова берутся из расшифровки, правки уже внесённых слов сохраняются (id слов = номер слова в расшифровке) */
    async setRange(req, actor) {
      const { clip, project } = await ownClip(actor, req.params.id), b = req.body || {}, start = b.start, end = b.end;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 3 || end - start > K.HARD_CAPS.maxClipSeconds) throw new HttpError(400, "BAD_RANGE", "Длительность клипа: от 3 до " + K.HARD_CAPS.maxClipSeconds + " с");
      if (clip.status === "rendering") throw new HttpError(409, "RENDERING", "Клип сейчас собирается");
      const ws = clip.window_start || 0, we = ws + (clip.window_dur || 0); if (!clip.window_path || start < ws + 0.3 || end > we - 0.3) throw new HttpError(409, "OUT_OF_WINDOW", "Диапазон выходит за пределы подготовленного окна предпросмотра", { window: { start: +ws.toFixed(2), end: +we.toFixed(2) } });
      const tpath = project.analysis && project.analysis.transcript_path; if (!tpath) throw new HttpError(409, "NO_TRANSCRIPT", "Расшифровка недоступна — запустите анализ заново");
      let tr = tcache.get(tpath); if (!tr) { tr = JSON.parse((await storage.readBuffer(tpath)).toString("utf8")); tcache.clear(); tcache.set(tpath, tr); }
      const edits = await ensureEdits(clip), byId = new Map(edits.words.map(w => [w.id, w])), merged = [];
      (tr.words || []).forEach((w, i) => { if (w.start >= start - 0.05 && w.start < end) { const id = wid(i); merged.push(byId.get(id) || { id, text: String(w.word).trim(), start: w.start, end: w.end, orig: { text: String(w.word).trim(), start: w.start, end: w.end } }); } });
      for (const w of edits.words) if (w.added && w.start >= start - 0.05 && w.start < end) merged.push(w);
      merged.sort((a, c) => a.start - c.start); if (merged.filter(w => !w.deleted).length < 3) throw new HttpError(400, "BAD_RANGE", "В диапазоне меньше трёх слов");
      const ids = new Set(merged.map(w => w.id)), next = Object.assign({}, edits, { words: merged, breaks: edits.breaks.filter(i => ids.has(i)), joins: edits.joins.filter(i => ids.has(i)), emphasis: edits.emphasis.filter(i => ids.has(i)), rev: edits.rev + 1, updated_at: now(), updated_by: actor.uid });
      await col(COLL.edits).doc(clip.id).set(next); const st = await loadSettings(), vis = E.effectiveWords(next);
      await col(COLL.clips).doc(clip.id).update({ start: +vis[0].start.toFixed(3), end: +vis[vis.length - 1].end.toFixed(3), duration_s: +E.checks(next, st.template.cuts).final_s.toFixed(1), status: "edited", updated_at: now() }); await event(actor, "clip.range", { clip_id: clip.id, start, end });
      return clipView(Object.assign({}, clip, { start: vis[0].start, end: vis[vis.length - 1].end }), project, next, st);
    },
    async setWindow(req, actor) {
      const { clip, project } = await ownClip(actor, req.params.id), b = req.body || {}; if (!Number.isFinite(b.start) || !Number.isFinite(b.end) || b.end <= b.start || b.end - b.start > K.HARD_CAPS.maxClipSeconds + 20) throw new HttpError(400, "BAD_RANGE", "Некорректный диапазон");
      if (!(project.duration_sec > 0) || b.start < 0 || b.end > project.duration_sec) throw new HttpError(400, "BAD_RANGE", "Диапазон выходит за пределы записи");
      const { job } = await J.enqueue(db, now, { type: "window", project_id: project.id, clip_id: clip.id, owner_uid: project.owner_uid, key: clip.id + "_" + Math.round(b.start) + "_" + Math.round(b.end), payload: { start: b.start, end: b.end }, priority: 3 }); kick(); return { job: publicJob(job) };
    },
    async suggestHooks(req, actor) {
      const { clip } = await ownClip(actor, req.params.id), st = await loadSettings(), edits = await ensureEdits(clip), text = E.effectiveWords(edits).map(w => w.word).join(" ");
      const usage = await B.usageOf(db, now); if (usage.spent_usd + usage.reserved_usd + 0.03 > st.limits.monthly_usd) throw new HttpError(402, "BUDGET_MONTH", "Месячный лимит расходов исчерпан");
      if (limited("hooks:" + actor.uid, 20, 3600000)) throw new HttpError(429, "TOO_MANY", "Слишком много запросов хуков");
      const key = claudeKey(); if (!key) throw new HttpError(503, "MISSING_KEY", "На сервере не задан ключ Claude (ANTHROPIC_API_KEY).");
      let r; try { r = await CL.suggestHooks({ key, model: st.clips.model, clipText: text, env }); } catch (e) { throw new HttpError(e.retryable ? 502 : 400, e.code || "CLAUDE_ERROR", e.message); }
      const usd = +CL.cost(r.usage, st.clips.model, st.prices).toFixed(6); await B.spendDirect(db, now, st.limits, usd).catch(() => {}); await event(actor, "hooks.suggest", { clip_id: clip.id, usd });
      return { hooks: r.hooks, cost_usd: usd, note: r.hooks.length ? null : "ИИ не предложил ни одного хука, подтверждённого текстом клипа" };
    },
    async setClipState(req, actor) { const { clip } = await ownClip(actor, req.params.id), b = req.body || {}; if (typeof b.excluded !== "boolean") throw new HttpError(400, "INVALID", "Нужен excluded: true/false"); if (clip.status === "rendering") throw new HttpError(409, "RENDERING", "Клип сейчас собирается"); const status = b.excluded ? "excluded" : (clip.render ? "done" : "found"); await col(COLL.clips).doc(clip.id).update({ status, updated_at: now() }); return { ok: true, status }; },
    async reorderClips(req, actor) {
      const p = await ownProject(actor, req.params.id), ids = req.body && req.body.ids; if (!Array.isArray(ids) || ids.length > 100) throw new HttpError(400, "INVALID", "Нужен список ids");
      const own = new Set((await col(COLL.clips).where("project_id", "==", p.id).get()).docs.map(d => d.id)); if (!ids.every(i => own.has(i)) || new Set(ids).size !== ids.length) throw new HttpError(400, "INVALID", "Список содержит чужие или повторяющиеся клипы");
      for (let i = 0; i < ids.length; i++) await col(COLL.clips).doc(ids[i]).update({ order: i, updated_at: now() }); return { ok: true };
    },
    async renderClip(req, actor) { return enqueueRender(req, actor, "render"); },
    async previewClip(req, actor) { return enqueueRender(req, actor, "preview"); },
    async media(req, actor) {
      const { clip, project } = await ownClip(actor, req.params.id), kind = String((req.query && req.query.kind) || ""), pick = { thumb: clip.thumb_path, window: clip.window_path, preview: clip.preview && clip.preview.path, export: clip.render && clip.render.path, source: project.source_path };
      if (!(kind in pick)) throw new HttpError(400, "INVALID", "kind: thumb|window|preview|export|source"); const p = pick[kind]; if (!p) throw new HttpError(404, "NOT_READY", "Файл ещё не готов");
      if (!(await storage.stat(p))) throw new HttpError(404, "NOT_READY", "Файл ещё не готов");
      const filename = kind === "export" ? "hidden-dinox-clip-" + String((clip.order ?? 0) + 1).padStart(2, "0") + ".mp4" : undefined, url = await storage.signedReadUrl(p, { ttlSec: K.SIGNED_URL_TTL_SEC, filename, contentType: kind === "thumb" ? "image/jpeg" : undefined });
      await event(actor, "media." + kind, { clip_id: clip.id }); return { url, expires_in: K.SIGNED_URL_TTL_SEC, kind, ...(kind === "export" ? { render_hash: clip.render.hash } : {}) };
    },

    /* ---- очередь, история ---- */
    async listJobs(req, actor) {
      const q = req.query && req.query.all === "1" ? col(COLL.jobs) : col(COLL.jobs).where("owner_uid", "==", actor.uid), rows = (await q.get()).docs.map(d => Object.assign({ id: d.id }, d.data()));
      const rank = j => (ACTIVE.includes(j.status) ? 0 : 1); rows.sort((a, b) => rank(a) - rank(b) || (b.updated_at || 0) - (a.updated_at || 0)); return { jobs: rows.slice(0, 60).map(publicJob) };
    },
    async getJob(req, actor) { return { job: publicJob(await ownJob(actor, req.params.id)) }; },
    async cancelJob(req, actor) {
      const j = await ownJob(actor, req.params.id), r = await J.cancel(db, now, j.id);
      if (r && r.status === "cancelled") { if (j.type === "analyze") await col(COLL.projects).doc(j.project_id).update({ status: "ready", updated_at: now() }).catch(() => {}); if (j.type === "render" && j.clip_id) { const c = await get(COLL.clips, j.clip_id); if (c && c.status === "rendering") await col(COLL.clips).doc(c.id).update({ status: c.render ? "done" : "edited", updated_at: now() }); } }
      await event(actor, "job.cancel", { job_id: j.id }); return r;
    },
    async retryJob(req, actor) {
      const j = await ownJob(actor, req.params.id); if (!["failed", "cancelled"].includes(j.status)) throw new HttpError(409, "WRONG_STATE", "Повторить можно только неудавшееся или отменённое задание");
      if (j.type === "analyze") { const st = await loadSettings(); await B.reserve(db, now, { jobId: j.id, estimate: j.payload.estimate, limits: st.limits }); }
      const r = await J.retry(db, now, j.id);
      if (!r || !r.changed) { if (j.type === "analyze") await B.release(db, now, j.id); }
      else if (j.type === "analyze") await col(COLL.projects).doc(j.project_id).update({ status: "analyzing", updated_at: now() }).catch(() => {});
      else if (j.type === "render" && j.clip_id) await col(COLL.clips).doc(j.clip_id).update({ status: "rendering", error: null, updated_at: now() }).catch(() => {});
      else if (j.type === "telegram" && j.clip_id) await col(COLL.clips).doc(j.clip_id).update({ "telegram.status": "queued", "telegram.error": null }).catch(() => {});
      kick(); await event(actor, "job.retry", { job_id: j.id }); return r;
    },
    async history(req, actor) {
      const q = req.query && req.query.all === "1" ? col(COLL.clips) : col(COLL.clips).where("owner_uid", "==", actor.uid), rows = (await q.get()).docs.map(d => Object.assign({ id: d.id }, d.data())).filter(c => c.render && c.status !== "excluded");
      rows.sort((a, b) => (b.render.at || 0) - (a.render.at || 0)); const pj = new Map(); for (const c of rows.slice(0, 100)) if (!pj.has(c.project_id)) pj.set(c.project_id, await get(COLL.projects, c.project_id));
      return { items: rows.slice(0, 100).map(c => Object.assign(publicClip(c), { project: (pj.get(c.project_id) || {}).filename || "" })) };
    }
  };
  const clipLimits = st => ({ min_s: st.clips.min_s, max_s: st.clips.max_s }), templateStamp = st => sha(st.template), pubLimits = l => ({ monthly_usd: l.monthly_usd, per_job_usd: l.per_job_usd, max_duration_min: l.max_duration_min });

  async function analysisPlan(req, actor) {
    const p = await ownProject(actor, req.params.id), st = await loadSettings(), q = Object.assign({}, req.query || {}, req.body || {});
    if (!B.configured(st.limits)) throw new HttpError(402, "BUDGET_NOT_CONFIGURED", "Лимиты Video Studio не заданы (⚙).");
    if (!["ready", "analyzed", "analyzing"].includes(p.status)) throw new HttpError(409, "NOT_READY", "Видео ещё проверяется или недоступно (статус: " + p.status + ")");
    if (!(p.duration_sec > 0)) throw new HttpError(409, "NOT_READY", "Длительность видео ещё неизвестна");
    if (p.duration_sec > Math.min(st.limits.max_duration_min * 60, K.HARD_CAPS.maxDurationSec)) throw new HttpError(413, "TOO_LONG", "Видео длиннее допустимого (" + st.limits.max_duration_min + " мин)");
    const model = String(q.model || st.clips.model), whisper = String(q.whisper || st.clips.whisper), groq = S.buildGroqPrompt(st.vocabulary);
    let estimate; try { estimate = B.estimateAnalyze({ durationSec: p.duration_sec, model, whisper, prices: st.prices }); } catch (e) { if (e.code === "UNKNOWN_MODEL") throw new HttpError(400, e.code, e.message); throw e; }
    return { p, st, model, whisper, estimate, groq };
  }
  async function ensureEdits(clip) { const ref = col(COLL.edits).doc(clip.id), init = Object.assign(E.initEdits(clip), { created_at: now() }); return db.runTransaction(async tx => { const s = await tx.get(ref); if (s.exists) return s.data(); tx.create(ref, init); return init; }); }
  function clipView(clip, project, edits, st) {
    const words = E.effectiveWords(edits), keep = core.buildKeep(words, st.template.cuts), hash = E.editsHash(edits, templateStamp(st));
    return { clip: publicClip(clip), edits, checks: E.checks(edits, st.template.cuts, clipLimits(st)), keep, current_hash: hash, stale: !!(clip.render && clip.render.hash !== hash), preview_stale: !!(clip.preview && clip.preview.hash !== hash),
      suggestions: S.suggestTerms(words.map(w => ({ id: w.id, text: w.word })), st.vocabulary), template: st.template, project: { id: project.id, filename: project.filename, duration_sec: project.duration_sec } };
  }
  async function enqueueRender(req, actor, type) {
    const { clip, project } = await ownClip(actor, req.params.id), st = await loadSettings();
    if (clip.status === "excluded") throw new HttpError(409, "EXCLUDED", "Клип исключён"); if (clip.status === "rendering" && type === "render") throw new HttpError(409, "RENDERING", "Клип уже собирается");
    const edits = await ensureEdits(clip), checks = E.checks(edits, st.template.cuts, clipLimits(st)); if (!checks.can_render) throw new HttpError(400, "CANNOT_RENDER", "Нельзя собрать ролик: длительность " + checks.final_s + " с (максимум " + K.HARD_CAPS.maxClipSeconds + " с)");
    const hash = E.editsHash(edits, templateStamp(st)), key = clip.id + "_" + hash, prior = await get(COLL.jobs, type + "_" + key);
    if (prior && prior.status === "succeeded" && ((type === "render" && clip.render && clip.render.hash === hash) || (type === "preview" && clip.preview && clip.preview.hash === hash))) return { job: publicJob(prior), cached: true, hash };
    if (prior && ACTIVE.includes(prior.status)) return { job: publicJob(prior), cached: true, hash, in_progress: true };
    const mineActive = (await col(COLL.jobs).where("owner_uid", "==", actor.uid).get()).docs.map(d => d.data()).filter(j => ACTIVE.includes(j.status)).length; if (mineActive >= 4) throw new HttpError(429, "TOO_MANY_JOBS", "В очереди уже 4 ваших задания");
    const payload = { kind: type, edits_rev: edits.rev, hash, clip_start: clip.start, clip_end: clip.end, words: E.effectiveWords(edits), hook: { text: edits.hook.text, size: edits.hook.size, x: edits.hook.x, y: edits.hook.y, enabled: edits.hook.enabled }, cta: edits.cta, breaks: edits.breaks, joins: edits.joins, emphasis: edits.emphasis, framing: edits.framing || null, template: st.template };
    let job; if (!prior) job = (await J.enqueue(db, now, { type, project_id: project.id, clip_id: clip.id, owner_uid: project.owner_uid, key, payload, priority: type === "preview" ? 3 : 5 })).job; else { await J.requeue(db, now, prior.id, { payload }); job = Object.assign({}, prior, { status: "queued", payload }); }
    if (type === "render") await col(COLL.clips).doc(clip.id).update({ status: "rendering", error: null, updated_at: now() }); kick(); await event(actor, type + ".start", { clip_id: clip.id, hash }); return { job: publicJob(job), cached: false, hash };
  }

  const ROUTES = [
    ["GET", "/me", "me", null, false], ["GET", "/health", "health", null, false], ["GET", "/settings", "getSettings", null, false], ["PUT", "/settings", "putSettings", null, true], ["POST", "/settings/template/reset", "resetTemplate", null, true],
    ["GET", "/telegram", "getTelegram", null, false], ["PUT", "/telegram", "putTelegram", null, true], ["POST", "/telegram/check", "checkTelegram", null, true], ["POST", "/telegram/test", "testTelegram", null, true],
    ["GET", "/logo", "getLogo", null, false], ["POST", "/logo", "putLogo", null, true], ["POST", "/storage/cors", "setCors", null, true],
    ["GET", "/projects", "listProjects", null, false], ["POST", "/projects", "createProject", null, true], ["GET", "/projects/:id", "getProject", null, false], ["DELETE", "/projects/:id", "deleteProject", null, true],
    ["POST", "/projects/:id/upload/part-url", "uploadPartUrl", null, true], ["GET", "/projects/:id/upload/parts", "listUploadParts", null, false], ["POST", "/projects/:id/upload/complete-multipart", "completeMultipart", null, true], ["POST", "/projects/:id/upload/complete", "completeUpload", null, true], ["POST", "/projects/:id/upload/cancel", "cancelUpload", null, true],
    ["GET", "/projects/:id/estimate", "estimate", null, false], ["POST", "/projects/:id/analyze", "analyze", null, true], ["GET", "/projects/:id/clips", "listClips", null, false], ["POST", "/projects/:id/clips/order", "reorderClips", null, true],
    ["GET", "/clips/:id", "getClip", null, false], ["PUT", "/clips/:id/edits", "patchEdits", null, true], ["PUT", "/clips/:id/range", "setRange", null, true], ["POST", "/clips/:id/window", "setWindow", null, true], ["POST", "/clips/:id/hooks", "suggestHooks", null, true],
    ["POST", "/clips/:id/state", "setClipState", null, true], ["POST", "/clips/:id/preview", "previewClip", null, true], ["POST", "/clips/:id/render", "renderClip", null, true], ["POST", "/clips/:id/telegram", "sendTelegram", null, true], ["GET", "/clips/:id/media", "media", null, false],
    ["GET", "/jobs", "listJobs", null, false], ["GET", "/jobs/:id", "getJob", null, false], ["POST", "/jobs/:id/cancel", "cancelJob", null, true], ["POST", "/jobs/:id/retry", "retryJob", null, true], ["GET", "/history", "history", null, false]
  ];
  function handler(name, perm, mutating) {
    return async (req, res) => {
      try { const actor = await authenticate(req); if (mutating && limited("w:" + actor.uid, 240, 60000)) throw new HttpError(429, "TOO_MANY"); const out = await H[name](req, actor); if (res.set) res.set("Cache-Control", "no-store"); res.status(200).json(out); }
      catch (e) {
        if (e instanceof HttpError) return res.status(e.status).json(Object.assign({ error: e.code, message: e.message }, e.extra || {}));
        if (e && Number.isInteger(e.status) && e.code) return res.status(e.status).json(Object.assign({ error: e.code, message: e.message }, e.extra ? { extra: e.extra } : {}, e.field ? { field: e.field } : {}));
        log.error && log.error("video-studio:", name, e && (e.code || e.message)); res.status(503).json({ error: "UNAVAILABLE", message: "Временная ошибка сервера" });
      }
    };
  }
  return { ROUTES, handler, H, authenticate, loadSettings, HttpError, trustedOrigins };
}

/* Публичные представления: без внутренних путей хранилища и служебных данных */
const publicTelegram = t => (t ? { status: t.status, kind: t.kind || null, message_id: t.message_id || null, chat_id: t.chat_id || null, sent_at: t.sent_at || null, attempts: t.attempts || 0, hash: t.hash || null, error: t.error || null } : null);
const publicProject = p => ({ id: p.id, width: p.width ?? null, height: p.height ?? null, filename: p.filename, size_bytes: p.size_bytes, status: p.status, duration_sec: p.duration_sec ?? null, counts: p.counts || { clips: 0 }, error: p.error || null, created_at: p.created_at, updated_at: p.updated_at, owner_uid: p.owner_uid, analysis: p.analysis ? { model: p.analysis.model, whisper: p.analysis.whisper, cost_usd: p.analysis.cost_usd, no_good_moments: !!p.analysis.no_good_moments, rejected: p.analysis.rejected || [], error: p.analysis.error || null, at: p.analysis.at } : null });
const publicJob = j => ({ id: j.id, type: j.type, project_id: j.project_id, clip_id: j.clip_id || null, status: j.status, stage: j.stage || null, progress: j.progress || 0, attempts: j.attempts || 0, max_attempts: j.max_attempts, error: j.error || null, cancel_requested: !!j.cancel_requested, cost: j.cost || null, created_at: j.created_at, updated_at: j.updated_at, next_run_at: j.next_run_at || null });
const publicClip = c => ({ id: c.id, project_id: c.project_id, n: c.n ?? null, order: c.order ?? null, title: c.title || "", hook: c.hook || "", start: c.start, end: c.end, duration_s: c.duration_s ?? null, category: c.category || null, score: c.score ?? null, reason: c.reason || "", status: c.status, has_thumb: !!c.thumb_path, has_window: !!c.window_path, window_start: c.window_start ?? null, window_dur: c.window_dur ?? null,
  render: c.render ? { hash: c.render.hash, at: c.render.at, size: c.render.size, duration: c.render.duration } : null, preview: c.preview ? { hash: c.preview.hash, at: c.preview.at } : null, telegram: publicTelegram(c.telegram), error: c.error || null });
function mountVideoStudioApi(app, express, deps) {
  const api = createVideoStudioApi(deps), router = express.Router();
  router.use(express.json({ limit: "2mb", type: ["application/json", "application/vnd.hd+json"] }));
  for (const [method, p, name, perm, mut] of api.ROUTES) router[method.toLowerCase()](p, api.handler(name, perm, mut));
  router.use((req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  router.use((err, req, res, next) => res.status(err && err.status >= 400 && err.status < 500 ? err.status : 400).json({ error: err && err.type === "entity.too.large" ? "TOO_LARGE" : "BAD_REQUEST", message: "Некорректный запрос" }));   // 4 аргумента: обработчик ошибок Express
  app.use("/api/video-studio", router); return api;
}
module.exports = { createVideoStudioApi, mountVideoStudioApi, HttpError, publicClip, publicJob, publicProject };
