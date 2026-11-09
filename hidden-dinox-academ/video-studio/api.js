"use strict";
/* HIDDEN DINOX VIDEO STUDIO — API (/api/video-studio/*).
   Каждый маршрут: проверенный Firebase ID-токен → users/{uid} (блокировка, роль) → только admin/super_admin → владелец проекта.
   Видео сервер не принимает: выдаёт защищённую возобновляемую сессию загрузки прямо в Firebase Storage и ссылки на 15 минут.
   Из чужих коллекций Academy читается только users/{uid}; секреты (токен бота, ключи) в ответы и в Firestore не попадают. */
const crypto = require("crypto"), fs = require("fs"), path = require("path");
const R = require("../academy/roles"), K = require("./constants"), S = require("./settings"), E = require("./edits"), B = require("./budget"), J = require("./jobs");
const M = require("./moments"), CL = require("./claude"), TG = require("./telegram"), FF = require("./ffmpeg"), { looksLikeIsoVideo } = require("./storage-adapter"), core = require("../public/academy/admin/vs-core.js");
const { storageProblem, redact } = require("./errors"), MP = require("./multipart"), Dg = require("./diagnostics"), Ins = require("./insights"), { guardStorage } = require("./keys"), RP = require("./render-plan"), { createWorkflow } = require("./workflow");
const { COLL } = K;
class HttpError extends Error { constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra; } }
const newId = p => p + "_" + crypto.randomBytes(8).toString("hex");
const sha = o => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 12);
const ACTIVE = ["queued", "claimed", "running"], MIME_BY_EXT = { mp4: "video/mp4", mov: "video/quicktime" }, BRAND_DIR = path.join(__dirname, "..", "public", "academy", "assets", "brand");
const wid = i => "w" + String(i).padStart(6, "0");

function createVideoStudioApi({ db, verifyIdToken, storage: rawStorage, runner = null, log = console, now = () => Date.now(), env = process.env, httpRequest = require("./http-util").httpRequest }) {
  const storage = guardStorage(rawStorage);                                  // аудит: ключи проверяются на границе адаптера
  const ownerOnly = String(env.VIDEO_STUDIO_OWNER_ONLY || "") === "1";   // 1 — администратор видит только СВОИ проекты (чужие — только super_admin)
  const mayAccess = (actor, ownerUid) => ownerUid === actor.uid || (ownerOnly ? actor.role === "super_admin" : !!actor.isAdmin);
  const seeAll = (req, actor) => !!(req.query && req.query.all === "1") && (!ownerOnly || actor.role === "super_admin");
  const hits = new Map(), tcache = new Map(), capsCache = { t: 0, v: null };
  const limited = (key, limit, windowMs) => { const t = now(), arr = (hits.get(key) || []).filter(x => t - x < windowMs); arr.push(t); hits.set(key, arr); if (hits.size > 5000) hits.clear(); return arr.length > limit; };
  const col = n => db.collection(n), kick = () => { if (runner && runner.kick) runner.kick(); };
  const get = async (n, id) => { const d = await col(n).doc(id).get(); return d.exists ? Object.assign({ id }, d.data()) : null; };
  const event = (actor, action, d = {}) => col(COLL.events).doc(newId("ev")).set(Object.assign({ at: now(), uid: actor.uid, email: actor.email || null, action }, d)).catch(e => log.error && log.error("video-studio event:", e && e.message));
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
  const ownProject = async (actor, id) => { const p = await get(COLL.projects, String(id)); if (!p || p.status === "deleted") throw new HttpError(404, "NOT_FOUND"); if (!mayAccess(actor, p.owner_uid)) throw new HttpError(404, "NOT_FOUND"); return p; };
  const ownClip = async (actor, id) => { const c = await get(COLL.clips, String(id)); if (!c) throw new HttpError(404, "NOT_FOUND"); return { clip: c, project: await ownProject(actor, c.project_id) }; };
  const ownJob = async (actor, id) => { const j = await get(COLL.jobs, String(id)); if (!j) throw new HttpError(404, "NOT_FOUND"); if (!mayAccess(actor, j.owner_uid)) throw new HttpError(404, "NOT_FOUND"); return j; };

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
  /* Ошибка хранилища → понятный ответ без секретов (причина видна в интерфейсе и в логах, а не «временно недоступно») */
  const storageFail = e => { const sp = storageProblem(e, storage.bucketName || ""); log.error && log.error("video-studio хранилище:", sp.code, redact(String((e && (e.name || e.code)) || "") + " " + String((e && e.message) || "").slice(0, 160), env)); return new HttpError(sp.status, sp.code, sp.message); };
  const storageState = { t: 0, v: null, saved: 0 }, memo = {};
  const cached = async (k, ms, fn) => { const m = memo[k]; if (m && now() - m.t < ms) return m.v; const v = await fn(); memo[k] = { t: now(), v }; return v; };
  /* Состояние хранилища: РЕАЛЬНЫЙ запрос к нему (кэш 30 с, force — всегда заново). Результат последней проверки сохраняется в Firestore. */
  async function storageHealth(force) {
    if (!force && storageState.v && now() - storageState.t < 30000) return storageState.v;
    const v = { kind: storage.kind, bucket: storage.bucketName || null, multipart: !!storage.multipart, ok: null, checked_at: now() };
    if (typeof storage.diagnose === "function") { try { Object.assign(v, { endpoint_host: storage.diagnose().endpoint_host, region: storage.diagnose().region, sdk_version: storage.diagnose().sdk_version, notes: storage.diagnose().notes || [] }); } catch (e) { /* без подробностей */ } }
    if (typeof storage.check === "function") { try { await storage.check(); v.ok = true; } catch (e) { const sp = storageProblem(e, storage.bucketName || ""); v.ok = false; v.code = sp.code; v.message = sp.message; v.detail = sp.detail; log.error && log.error("video-studio хранилище (проверка):", sp.code, redact(String((e && e.name) || "") + " " + String((e && e.message) || "").slice(0, 120), env)); } }
    storageState.t = now(); storageState.v = v; if (force || now() - storageState.saved > 600000) { storageState.saved = now(); persistStorageCheck(v).catch(() => {}); } return v;
  }
  async function persistStorageCheck(v, steps) { await col(COLL.settings).doc("storage_check").set({ at: now(), ok: v.ok, code: v.code || null, message: v.message || null, kind: v.kind, bucket: v.bucket, ...(steps ? { steps } : {}) }); }
  async function lastStorageCheck() { try { const d = await col(COLL.settings).doc("storage_check").get(); return d.exists ? d.data() : null; } catch (e) { return null; } }
  const capsOf = async () => { if (!capsCache.v || now() - capsCache.t > 60000) { capsCache.v = await FF.capabilities(env).catch(e => ({ ok: false, error: String(e.message) })); capsCache.t = now(); } return capsCache.v; };
  const claudeKey = () => String(env.VIDEO_STUDIO_ANTHROPIC_API_KEY || env.STUDIO_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || "").trim();

  const H = {
    async me(req, actor) {
      const st = await loadSettings();
      return { uid: actor.uid, email: actor.email, role: actor.role, general: st.general, is_admin: true, configured: B.configured(st.limits), limits: { max_upload_gb: st.limits.max_upload_gb, max_duration_min: st.limits.max_duration_min, monthly_usd: st.limits.monthly_usd, per_job_usd: st.limits.per_job_usd },
        clips: st.clips, chunk_bytes: K.CHUNK_BYTES, upload_mode: storage.multipart ? "multipart" : "resumable", storage_kind: storage.kind, telegram: { configured: !!TG.token(env), chat_id: st.telegram.chat_id || TG.defaultChat(env) || "", auto_send: st.telegram.auto_send } };
    },
    async health(req, actor) {
      const [caps, st] = await Promise.all([capsOf().catch(() => ({ ok: false })), storageHealth().catch(e => ({ ok: false, message: String(e && e.message).slice(0, 120) }))]); let queued = null; try { queued = (await col(COLL.jobs).where("status", "==", "queued").get()).docs.length; } catch (e) { /* Firestore недоступен — покажем в диагностике */ }
      return { ffmpeg: caps, storage: st, keys: { groq: !!String(env.GROQ_API_KEY || "").trim(), claude: !!claudeKey(), telegram: !!TG.token(env), telegram_chat: !!TG.defaultChat(env) },
        runner: runner ? { running: runner.running > 0, started_at: runner.state && runner.state.started_at, last_job: runner.state && runner.state.last_job, last_error: runner.state && runner.state.last_error } : null, queued_jobs: queued, origins: trustedOrigins(req), storage_check: await lastStorageCheck() };
    },
    async getSettings(req, actor) {
      const st = await loadSettings(), usage = await B.usageOf(db, now); delete usage.jobs;
      return { template: st.template, vocabulary: st.vocabulary, limits: st.limits, prices: st.prices, clips: st.clips, general: st.general, telegram: { chat_id: st.telegram.chat_id, auto_send: st.telegram.auto_send, link_fallback: st.telegram.link_fallback }, usage, groq_prompt: S.buildGroqPrompt(st.vocabulary), can_edit: true };
    },
    async putSettings(req, actor) {
      const b = req.body || {}, wrote = [], set = (id, data) => col(COLL.settings).doc(id).set(Object.assign(data, { updated_at: now(), updated_by: actor.uid }));
      if (b.template !== undefined) { const patch = S.validateTemplatePatch(b.template), cur = (await get(COLL.settings, "template")) || {}; const next = Object.assign({}, cur); for (const [sec, vals] of Object.entries(patch)) next[sec] = Object.assign({}, cur[sec] || {}, vals); delete next.id; await set("template", next); wrote.push("template"); }
      if (b.vocabulary !== undefined) { await set("vocabulary", S.validateVocabulary(b.vocabulary)); wrote.push("vocabulary"); }
      if (b.limits !== undefined) { const cur = (await get(COLL.settings, "limits")) || {}; delete cur.id; await set("limits", Object.assign(cur, S.validateLimits(b.limits))); wrote.push("limits"); }
      if (b.prices !== undefined) { await set("prices", S.validatePrices(b.prices)); wrote.push("prices"); }
      if (b.clips !== undefined) { const v = S.validateClips(b.clips), cur = (await get(COLL.settings, "clips")) || {}; delete cur.id; const merged = Object.assign({}, S.DEFAULT_CLIPS, cur, v); if (merged.max_s <= merged.min_s) throw new HttpError(400, "INVALID_CLIPS", "Максимум должен быть больше минимума"); await set("clips", Object.assign(cur, v)); wrote.push("clips"); }
      if (b.general !== undefined) { const v = S.validateGeneral(b.general), cur = (await get(COLL.settings, "general")) || {}; delete cur.id; await set("general", Object.assign(cur, v)); wrote.push("general"); }
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
      if (!TG.token(env)) throw new HttpError(503, "TG_NO_TOKEN", "Не задан VIDEO_STUDIO_TELEGRAM_BOT_TOKEN в переменных окружения сервера.");
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
      let custom = null, url = null, storage_error = null;                                       // сбой хранилища НЕ должен ломать раздел «Настройки»: ошибка показывается рядом, остальное работает
      try { custom = await storage.stat("video-studio/_brand/logo.png"); if (custom) url = await storage.signedReadUrl("video-studio/_brand/logo.png", { ttlSec: K.SIGNED_URL_TTL_SEC, contentType: "image/png" }); } catch (e) { storage_error = storageProblem(e, storage.bucketName || "").message; }
      return { brand: files, custom: !!custom, custom_url: url, storage_error };
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
      const manual = JSON.stringify(typeof storage.corsConfig === "function" ? storage.corsConfig(origins) : [{ AllowedOrigins: origins }], null, 2), where = storage.kind === "r2" ? "Cloudflare Dashboard → R2 → ваш бакет → Settings → CORS Policy → Add CORS policy → вставьте этот JSON → Save" : "gsutil cors set cors.json gs://<бакет>";
      try {
        await storage.setCors(origins); let lifecycle = null;
        if (typeof storage.setLifecycle === "function") { try { lifecycle = await storage.setLifecycle({ retentionDays: Number(env.VIDEO_STUDIO_RETENTION_DAYS) || 0 }); } catch (e) { lifecycle = { ok: false, error: storageProblem(e, storage.bucketName).message }; } }
        await event(actor, "storage.cors", { origins }); return { ok: true, origins, lifecycle };
      } catch (e) { const sp = storageProblem(e, storage.bucketName || ""); return { ok: false, origins, error: sp.code === "STORAGE_AUTH" ? "У ключа нет права менять настройки бакета (нужен токен Admin Read & Write). Настройте CORS вручную." : sp.message, manual, where }; }
    },

    /* Живой монитор обработки: что выполняется сейчас (этап, длительность этапа, измеримый прогресс, возраст последнего обновления, предупреждения), очередь с позициями,
       состояние исполнителя и последние завершённые с РЕАЛЬНЫМИ длительностями этапов. Состояние хранится в Firestore, поэтому после обновления страницы или перезапуска сервера оно восстанавливается. */
    async monitor(req, actor) {
      const t = now(), rowsOf = q => q.get().then(r => r.docs.map(d => Object.assign({ id: d.id }, d.data())));
      const [active, queued, recent] = await Promise.all([rowsOf(col(COLL.jobs).where("status", "in", ["claimed", "running"])), rowsOf(col(COLL.jobs).where("status", "==", "queued")), rowsOf(col(COLL.jobs).where("updated_at", ">", t - 2 * 86400000))]);
      const done = recent.filter(j => ["succeeded", "failed", "cancelled"].includes(j.status)).sort((a, b) => (b.finished_at || b.updated_at || 0) - (a.finished_at || a.updated_at || 0)).slice(0, 10), pids = [...new Set([...active, ...queued, ...done].map(j => j.project_id).filter(Boolean))], names = {};
      await Promise.all(pids.map(async id => { try { const p = await get(COLL.projects, String(id)); if (p) names[id] = p.filename; } catch (e) { /* без имени */ } }));
      const STALL = 90000, base = j => Object.assign(publicJob(j), { project_name: names[j.project_id] || null });
      const act = active.map(j => { const since = t - (j.updated_at || t), exp = ((j.lease || {}).expires_at || 0) - t; return Object.assign(base(j), { worker: (j.lease || {}).owner || null, total_elapsed_ms: t - (j.started_at || j.created_at || t), stage_elapsed_ms: j.stage_started_at ? t - j.stage_started_at : null, since_update_ms: since, stalled: since > STALL, lease_expires_in_ms: exp }); });
      const q = queued.sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5) || (a.created_at || 0) - (b.created_at || 0)).map((j, i) => Object.assign(base(j), { position: i + 1, wait_ms: t - (j.created_at || t), ahead_running: act.length, retry_at: (j.next_run_at || 0) > t ? j.next_run_at : null }));
      const fin = done.map(j => Object.assign(base(j), { total_ms: j.finished_at && j.started_at ? j.finished_at - j.started_at : null }));
      let free = null; try { const sf = fs.statfsSync((runner && runner.tmpRoot) || require("os").tmpdir()); free = Math.round(sf.bavail * sf.bsize / 1048576); } catch (e) { /* нет данных */ }
      const caps = await capsOf().catch(() => null), warnings = [];
      if (!runner) warnings.push("Обработка в этом экземпляре сервера отключена (VIDEO_STUDIO_RUNNER=0): задания должен брать другой экземпляр.");
      else if (caps && !caps.ok) warnings.push("FFmpeg не найден: задания ждут.");
      if (act.some(j => j.stalled)) warnings.push("Есть задание без обновлений более 90 секунд: если зависание не пройдёт, аренда истечёт и задание будет перехвачено.");
      if (free !== null && free < 2048) warnings.push("На диске сервера осталось " + free + " МБ: для больших записей нужно не менее 2 ГБ.");
      if (q.length && !runner) warnings.push("В очереди " + q.length + " заданий, но этот экземпляр их не выполняет.");
      return { now: t, worker: runner ? { running: runner.running > 0, started_at: runner.state && runner.state.started_at, uptime_ms: runner.state && runner.state.started_at ? t - runner.state.started_at : null, last_job: runner.state && runner.state.last_job, last_error: runner.state && runner.state.last_error, id: runner.workerId, max_job_min: Math.round((runner.maxJobMs || 0) / 60000), tmp_free_mb: free, ffmpeg_ok: !!(caps && caps.ok && caps.ass) } : null, active: act, queued: q, recent: fin, warnings };
    },

    /* ---- сводные разделы: Dashboard, Analytics, журнал, диагностика, библиотека ---- */
    async dashboard(req, actor) { const d = await cached("dash", 8000, () => Ins.dashboard(db, now())); const st = await storageHealth().catch(() => null), caps = await capsOf().catch(() => null); return Object.assign({}, d, { storage_status: st, worker: runner ? { running: runner.running > 0, last_job: runner.state && runner.state.last_job, last_error: runner.state && runner.state.last_error, started_at: runner.state && runner.state.started_at } : null, ffmpeg_ok: !!(caps && caps.ok && caps.ass), generated_at: now() }); },
    async analytics(req, actor) { const days = Math.min(60, Math.max(7, Number(req.query && req.query.days) || 14)); return cached("an" + days, 15000, () => Ins.analytics(db, now(), days)); },
    async events(req, actor) { return { events: await Ins.events(db, Number(req.query && req.query.limit) || 60) }; },
    async diagnostics(req, actor) {
      const checks = await Dg.runChecks({ db, storage, env, now, runner, actor, capsGetter: capsOf, storageGetter: storageHealth });
      return { checks, status: Dg.worst(checks), at: now(), storage_check: await lastStorageCheck(), storage_info: typeof storage.diagnose === "function" ? storage.diagnose() : { kind: storage.kind, bucket: storage.bucketName || null } };
    },
    async storageCheck(req, actor) { const v = await storageHealth(true); await event(actor, "storage.check", { ok: v.ok, note: v.ok ? "соединение с хранилищем проверено" : v.code }); return Object.assign({}, v, { info: typeof storage.diagnose === "function" ? storage.diagnose() : null }); },
    async mediaLibrary(req, actor) {
      const q = req.query || {}; let logos = [], presets = [];
      try { logos = fs.readdirSync(BRAND_DIR).filter(f => /^[A-Za-z0-9._-]+\.png$/.test(f) && !f.startsWith("._")).map(f => ({ id: "brand_" + f, title: f, source: "brand:" + f, size: (fs.statSync(path.join(BRAND_DIR, f)).size) })); } catch (e) { /* нет каталога */ }
      try { const c = await storage.stat("video-studio/_brand/logo.png"); if (c) logos.push({ id: "custom", title: "Загруженный логотип", source: "custom", size: c.size }); } catch (e) { /* хранилище недоступно: логотип проекта всё равно виден */ }
      try { presets = (await loadPresets()).items; } catch (e) { /* пресеты недоступны */ }
      return Ins.media(db, { kind: q.kind, q: q.q, logos, presets });
    },
    async deleteExport(req, actor) {
      const { clip, project } = await ownClip(actor, req.params.id), r = clip.render; if (!r || !r.path) throw new HttpError(404, "NOT_FOUND", "У клипа нет готового экспорта");
      if (clip.status === "rendering") throw new HttpError(409, "RENDERING", "Клип сейчас собирается");
      const prefix = "video-studio/" + project.owner_uid + "/" + project.id + "/exports/"; if (!String(r.path).startsWith(prefix) || String(r.path).includes("..")) throw new HttpError(400, "INVALID", "Недопустимый путь файла");     // нельзя удалить чужой или произвольный объект
      try { await storage.remove(r.path); } catch (e) { throw storageFail(e); }
      await col(COLL.clips).doc(clip.id).update({ render: null, telegram: null, status: clip.status === "done" ? "edited" : clip.status, updated_at: now() }); await event(actor, "export.delete", { clip_id: clip.id, project_id: project.id }); return { ok: true };
    },
    async listPresets(req, actor) { return { presets: (await loadPresets()).items }; },
    async createPreset(req, actor) {
      const name = String((req.body && req.body.name) || "").trim(); if (!name || name.length > 40 || /[<>]/.test(name)) throw new HttpError(400, "INVALID", "Название шаблона: от 1 до 40 символов без < >");
      const cur = await loadPresets(); if (cur.items.length >= 20) throw new HttpError(400, "LIMIT", "Не более 20 шаблонов"); const st = await loadSettings(), patch = editablePatch(st.template), id = newId("tpl");
      cur.items.push({ id, name, template: patch, created_at: now(), by: actor.email || actor.uid }); await col(COLL.settings).doc("presets").set({ items: cur.items, updated_at: now() }); await event(actor, "preset.create", { note: name }); return { ok: true, id };
    },
    async applyPreset(req, actor) {
      const p = (await loadPresets()).items.find(x => x.id === req.params.id); if (!p) throw new HttpError(404, "NOT_FOUND", "Шаблон не найден"); const patch = S.validateTemplatePatch(p.template), cur = (await get(COLL.settings, "template")) || {}, next = Object.assign({}, cur); delete next.id;
      for (const [sec, vals] of Object.entries(patch)) next[sec] = Object.assign({}, cur[sec] || {}, vals); await col(COLL.settings).doc("template").set(Object.assign(next, { updated_at: now(), updated_by: actor.uid })); await event(actor, "preset.apply", { note: p.name }); return { ok: true };
    },
    async deletePreset(req, actor) { const cur = await loadPresets(), n = cur.items.length; cur.items = cur.items.filter(x => x.id !== req.params.id); if (cur.items.length === n) throw new HttpError(404, "NOT_FOUND", "Шаблон не найден"); await col(COLL.settings).doc("presets").set({ items: cur.items, updated_at: now() }); await event(actor, "preset.delete", {}); return { ok: true }; },

    /* Сквозная проверка настоящего хранилища кнопкой (запись, чтение, ссылка, multipart из 2 частей, CORS и ETag). Всё за собой удаляет. Нагрузка ничтожна (≈17 МБ, несколько запросов). */
    async storageSelfTest(req, actor) {
      if (limited("selftest:" + actor.uid, 10, 3600000)) throw new HttpError(429, "TOO_MANY", "Слишком много проверок: подождите");
      const steps = [], MiB = 2 ** 20, key = "video-studio/_selftest/" + String(actor.uid).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) + "/" + now() + "_" + crypto.randomBytes(3).toString("hex"), origin = trustedOrigins(req)[0] || null, cleanup = [];
      const selfErr = m => Object.assign(new Error(m), { selftest: true });
      const run = async (name, fn) => { const t0 = Date.now(); try { const detail = await fn(); steps.push({ name, ok: true, detail: detail || "", ms: Date.now() - t0 }); return true; } catch (e) { steps.push({ name, ok: false, error: e && e.selftest ? e.message : storageProblem(e, storage.bucketName || "").message, ms: Date.now() - t0 }); return false; } };
      const connected = await run("Подключение к хранилищу и ключи", async () => { await storage.check(); return (storage.kind === "r2" ? "Cloudflare R2, бакет " : storage.kind + " ") + (storage.bucketName || ""); });
      if (connected) {
        await run("Запись и чтение файла", async () => { const data = Buffer.from("hd-selftest-" + key), k = key + "/a.txt"; await storage.writeBuffer(k, data, "text/plain"); cleanup.push(k); const back = await storage.readBuffer(k); if (!back.equals(data)) throw selfErr("Прочитанные данные не совпали с записанными"); const st = await storage.stat(k); if (!st || st.size !== data.length) throw selfErr("Размер объекта не совпал"); return data.length + " байт записано и прочитано"; });
        await run("Подписанная ссылка на чтение (для просмотра и Telegram)", async () => { const r = await httpRequest(await storage.signedReadUrl(key + "/a.txt", { ttlSec: 120 })); if (r.status !== 200) throw selfErr("Ссылка не открылась (HTTP " + r.status + ")"); if (!r.body.toString().startsWith("hd-selftest-")) throw selfErr("Ссылка вернула другие данные"); return "ссылка открывается"; });
        if (storage.multipart) await run("Загрузка частями (multipart) из двух частей, CORS и заголовок ETag", async () => {
          const size = 16 * MiB + 1024, k = key + "/m.bin", m = await storage.startMultipart({ path: k, contentType: "application/octet-stream", size }); let done = false;
          try {
            const u1 = await storage.presignPart(k, m.uploadId, 1, 300), u2 = await storage.presignPart(k, m.uploadId, 2, 300); let cors = "проверка CORS пропущена (адрес страницы неизвестен)";
            if (origin) {
              const pf = await httpRequest(u1, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "PUT" } }), ao = pf.headers["access-control-allow-origin"];
              if (ao !== origin && ao !== "*") throw selfErr("CORS не настроен для " + origin + " (ответ: «" + (ao || "нет заголовка Access-Control-Allow-Origin") + "»). Нажмите «Настроить хранилище (CORS)» или вставьте JSON из deploy/r2-cors.json в Cloudflare → R2 → бакет → Settings → CORS Policy.");
              if (!/PUT/i.test(String(pf.headers["access-control-allow-methods"] || ""))) throw selfErr("В CORS-правиле не разрешён метод PUT");
              cors = "CORS разрешён для " + origin;
            }
            const put = async (url, body) => { const r = await httpRequest(url, { method: "PUT", body, headers: origin ? { Origin: origin } : {} }); if (r.status < 200 || r.status >= 300) throw selfErr("Хранилище не приняло часть (HTTP " + r.status + ")"); return r; };
            const r1 = await put(u1, Buffer.alloc(16 * MiB, 1)); await put(u2, Buffer.alloc(1024, 2));
            if (origin && !String(r1.headers["access-control-expose-headers"] || "").toLowerCase().includes("etag")) throw selfErr("Браузер не сможет прочитать ETag: в CORS-правиле должен быть ExposeHeaders = ETag");
            const have = await storage.listParts(k, m.uploadId); if (have.length !== 2 || have[0].size !== 16 * MiB || have[1].size !== 1024) throw selfErr("Список частей в хранилище не совпал с загруженным");
            await storage.completeMultipart(k, m.uploadId, have); done = true; cleanup.push(k); const st = await storage.stat(k); if (!st || st.size !== size) throw selfErr("Итоговый размер собранного файла не совпал");
            return "обе части загружены и собраны в один файл; " + cors;
          } finally { if (!done) await storage.abortMultipart(k, m.uploadId).catch(() => {}); }
        });
      }
      for (const k of cleanup) await storage.remove(k).catch(() => {});
      const ok = steps.length > 0 && steps.every(s => s.ok); await event(actor, "storage.selftest", { ok }); await persistStorageCheck({ ok, kind: storage.kind, bucket: storage.bucketName || null, code: ok ? null : "SELFTEST_FAILED", message: ok ? null : (steps.find(s => !s.ok) || {}).error }, steps).catch(() => {}); return { ok, steps, storage: { kind: storage.kind, bucket: storage.bucketName || null } };
    },

    /* ---- проекты и загрузка ---- */
    async listProjects(req, actor) {
      const mine = seeAll(req, actor), pq = mine ? col(COLL.projects) : col(COLL.projects).where("owner_uid", "==", actor.uid), cq = mine ? col(COLL.clips) : col(COLL.clips).where("owner_uid", "==", actor.uid);
      const [pd, cd] = await Promise.all([pq.get(), cq.get()]), cnt = {}; for (const d of cd.docs) { const c = d.data(), k = (cnt[c.project_id] = cnt[c.project_id] || { clips: 0, exports: 0, sent: 0, cover: null, firstOrder: 1e9 }); k.clips++; if (c.render) { k.exports++; if (!k.exportClip) k.exportClip = d.id; } if (c.telegram && ["sent", "sent_link"].includes(c.telegram.status)) k.sent++; if (c.thumb_path && (c.order ?? 1e9) < k.firstOrder) { k.firstOrder = c.order ?? 1e9; k.cover = d.id; } }
      return { projects: pd.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(p => p.status !== "deleted").sort((a, b) => b.created_at - a.created_at).slice(0, 200).map(p => { const k = cnt[p.id] || {}; return Object.assign(publicProject(p), { clips_count: k.clips || 0, exports_count: k.exports || 0, telegram_sent: k.sent || 0, cover_clip_id: p.cover_clip_id || k.cover || null, export_clip_id: k.exportClip || null }); }) };
    },
    async createProject(req, actor) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(actor.uid))) throw new HttpError(403, "INVALID_UID", "Идентификатор пользователя не подходит для хранения файлов");   // uid попадает в путь файла
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
      if (dup && b.allow_duplicate !== true) throw new HttpError(409, "DUPLICATE", "Этот файл уже загружен или загружается", { project_id: dup.id, project_status: dup.status, resumable: dup.status === "uploading" && !!(dup.upload && dup.upload.mode === "multipart") });
      if (mine.filter(p => p.status === "uploading" && now() < ((p.upload || {}).expires_at || 0)).length >= 2) throw new HttpError(429, "TOO_MANY_UPLOADS", "Уже идут две загрузки: завершите или отмените их");
      const id = newId("p"), p = "video-studio/" + actor.uid + "/" + id + "/source/original." + ext, expires = now() + K.UPLOAD_SESSION_TTL_SEC * 1000;
      /* атомарная защита от дублей: два одновременных запроса с одним файлом не создадут два проекта (раньше проверка и запись были раздельными) */
      let fpRef = null;
      if (fp && b.allow_duplicate !== true) {
        const claim = await db.runTransaction(async tx => {
          const ref = col(COLL.settings).doc("fp_" + crypto.createHash("sha1").update(actor.uid + "|" + fp).digest("hex")), s = await tx.get(ref);
          if (s.exists) { const d = s.data(), pr = await tx.get(col(COLL.projects).doc(String(d.project_id))), pd = pr.exists ? pr.data() : null;
            const alive = pd ? !["deleted", "error"].includes(pd.status) && !(pd.status === "uploading" && now() > ((pd.upload || {}).expires_at || 0)) : now() - (d.at || 0) < 60000;
            if (alive) return { dup: d.project_id, status: pd ? pd.status : "creating", multipart: !!(pd && pd.upload && pd.upload.mode === "multipart") }; }
          tx.set(ref, { project_id: id, uid: actor.uid, at: now() }); return { ref };
        });
        if (claim.dup) throw new HttpError(409, "DUPLICATE", "Этот файл уже загружен или загружается", { project_id: claim.dup, project_status: claim.status, resumable: claim.status === "uploading" && claim.multipart });
        fpRef = claim.ref;
      }
      const release = () => (fpRef ? fpRef.delete().catch(() => {}) : null);
      let upload, sessionUrl = null; const firstUrls = [];
      try {
        if (storage.multipart) {                                           // R2 / S3: загрузка ЧАСТЯМИ прямо из браузера
          const m = await storage.startMultipart({ path: p, contentType: ctype, size });
          upload = { mode: "multipart", upload_id: m.uploadId, part_size: m.partSize, total_parts: m.totalParts, expires_at: expires, declared_size: size };
          for (let i = 1; i <= Math.min(m.totalParts, 12); i++) firstUrls.push({ part_number: i, url: await storage.presignPart(p, m.uploadId, i, K.PART_URL_TTL_SEC) });
        } else { const session = await storage.createResumableSession({ path: p, contentType: ctype, size, origin }); sessionUrl = session.url; upload = { mode: "resumable", expires_at: expires, declared_size: size }; }
      } catch (e) { if (upload && upload.upload_id) await storage.abortMultipart(p, upload.upload_id).catch(() => {}); await release(); throw storageFail(e); }
      const doc = { id, owner_uid: actor.uid, owner_email: actor.email, filename: name, size_bytes: size, content_type: ctype, fingerprint: fp, status: "uploading", source_path: p, upload, duration_sec: null, counts: { clips: 0 }, error: null, created_at: now(), updated_at: now() };
      try { await col(COLL.projects).doc(id).set(doc); } catch (e) { if (upload.upload_id) await storage.abortMultipart(p, upload.upload_id).catch(() => {}); await release(); throw e; }
      await event(actor, "project.create", { project_id: id, size, mode: upload.mode });
      return { project: publicProject(doc), upload: upload.mode === "multipart" ? { mode: "multipart", part_size: upload.part_size, total_parts: upload.total_parts, expires_at: expires, content_type: ctype, urls: firstUrls, url_ttl: K.PART_URL_TTL_SEC } : { mode: "resumable", url: sessionUrl, chunk_bytes: K.CHUNK_BYTES, expires_at: expires, content_type: ctype } };
    },
    async getProject(req, actor) { const p = await ownProject(actor, req.params.id), jobs = (await col(COLL.jobs).where("project_id", "==", p.id).get()).docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => b.created_at - a.created_at).slice(0, 12); return { project: publicProject(p), jobs: jobs.map(publicJob) }; },
    /* Ссылки на части (multipart): выдаются пачками, чтобы не истекали при долгой загрузке; чужой проект и чужой ключ получить нельзя */
    async uploadParts(req, actor) {
      const p = await ownProject(actor, req.params.id), up = p.upload || {}; if (p.status !== "uploading" || up.mode !== "multipart") throw new HttpError(409, "WRONG_STATE", "Загрузка по частям не идёт");
      if (now() > up.expires_at) throw new HttpError(410, "UPLOAD_EXPIRED", "Срок этой загрузки истёк: начните загрузку заново");
      const nums = req.body && req.body.part_numbers; if (!Array.isArray(nums) || !nums.length || nums.length > 50 || !nums.every(n => Number.isInteger(n) && n >= 1 && n <= up.total_parts) || new Set(nums).size !== nums.length) throw new HttpError(400, "INVALID", "part_numbers: от 1 до 50 разных номеров в пределах 1…" + up.total_parts);
      if (limited("parts:" + actor.uid, 1500, 3600000)) throw new HttpError(429, "TOO_MANY");
      try { const urls = []; for (const n of nums) urls.push({ part_number: n, url: await storage.presignPart(p.source_path, up.upload_id, n, K.PART_URL_TTL_SEC) }); return { urls, expires_in: K.PART_URL_TTL_SEC }; } catch (e) { throw storageFail(e); }
    },
    /* Что уже загружено (по данным R2): по этому ответу страница возобновляет загрузку, в том числе после перезагрузки или с другого компьютера */
    async uploadStatus(req, actor) {
      const p = await ownProject(actor, req.params.id), up = p.upload || {}; if (!["uploading", "completing"].includes(p.status)) throw new HttpError(409, "WRONG_STATE", "Загрузка не идёт");
      if (up.mode !== "multipart") return { mode: up.mode || "resumable", expires_at: up.expires_at };
      if (now() > up.expires_at) throw new HttpError(410, "UPLOAD_EXPIRED", "Срок этой загрузки истёк: начните загрузку заново");
      let parts; try { parts = await storage.listParts(p.source_path, up.upload_id); } catch (e) { if (/NoSuchUpload/i.test(String(e && (e.name || e.Code)))) throw new HttpError(410, "UPLOAD_EXPIRED", "Загрузка была прервана в хранилище: начните заново"); throw storageFail(e); }
      return { mode: "multipart", part_size: up.part_size, total_parts: up.total_parts, declared_size: up.declared_size, expires_at: up.expires_at, parts, uploaded_bytes: parts.reduce((s, x) => s + x.size, 0) };
    },
    async completeUpload(req, actor) {
      const p = await ownProject(actor, req.params.id), up = p.upload || {}; if (!["uploading", "completing"].includes(p.status)) throw new HttpError(409, "WRONG_STATE", "Загрузка уже завершена или отменена");
      const ref = col(COLL.projects).doc(p.id);
      const locked = await db.runTransaction(async tx => { const s = await tx.get(ref), c = s.data(); if (c.status === "uploading" || (c.status === "completing" && now() - (c.completing_at || 0) > 300000)) { tx.update(ref, { status: "completing", completing_at: now(), updated_at: now() }); return true; } return false; });
      if (!locked) throw new HttpError(409, "WRONG_STATE", "Завершение этой загрузки уже выполняется");        // защита от повторного завершения одной загрузки
      const revert = () => ref.update({ status: "uploading", updated_at: now() }).catch(() => {});
      const fail = async (code, msg) => { await storage.remove(p.source_path).catch(() => {}); if (up.mode === "multipart" && storage.abortMultipart) await storage.abortMultipart(p.source_path, up.upload_id).catch(() => {}); await ref.update({ status: "error", error: { code, message: msg }, updated_at: now() }); throw new HttpError(400, code, msg); };
      try {
        if (up.mode === "multipart") {
          let have; try { have = await storage.listParts(p.source_path, up.upload_id); } catch (e) { await revert(); if (/NoSuchUpload/i.test(String(e && (e.name || e.Code)))) throw new HttpError(410, "UPLOAD_EXPIRED", "Загрузка была прервана в хранилище: начните заново"); throw storageFail(e); }
          const byN = new Map(have.map(x => [x.part_number, x])), plan = { partSize: up.part_size, totalParts: up.total_parts }, missing = [], wrong = [];
          for (let n = 1; n <= up.total_parts; n++) { const x = byN.get(n); if (!x) missing.push(n); else if (x.size !== MP.expectedPartSize(n, plan, up.declared_size)) wrong.push(n); }
          for (const n of byN.keys()) if (n < 1 || n > up.total_parts) wrong.push(n);
          if (missing.length || wrong.length) { await revert(); throw new HttpError(409, "INCOMPLETE", "Загружены не все части файла или размер части неверен", { missing: missing.slice(0, 100), wrong: wrong.slice(0, 100) }); }
          const client = req.body && req.body.parts; if (client !== undefined) {
            if (!Array.isArray(client) || client.length > up.total_parts) { await revert(); throw new HttpError(400, "INVALID", "parts: список {part_number, etag}"); }
            for (const c of client) { const x = byN.get(c && c.part_number); if (!x || (c.etag && String(c.etag).replace(/"/g, "") !== x.etag)) { await revert(); throw new HttpError(409, "PARTS_MISMATCH", "Список частей не совпадает с загруженным в хранилище: загрузите файл заново"); } }
          }
          try { await storage.completeMultipart(p.source_path, up.upload_id, have); } catch (e) { await revert(); throw storageFail(e); }
        }
        const st = await storage.stat(p.source_path); if (!st) { await revert(); throw new HttpError(409, "NOT_UPLOADED", "Файл ещё не загружен целиком"); }
        if (st.size !== up.declared_size) return await fail("SIZE_MISMATCH", "Размер загруженного файла не совпал с заявленным");
        if (!looksLikeIsoVideo(await storage.readHead(p.source_path, 16))) return await fail("BAD_FORMAT", "Файл не похож на MP4/MOV (заголовок не распознан)");
        await ref.update({ status: "validating", updated_at: now(), upload: Object.assign({}, up, { completed_at: now() }) });
        const { job } = await J.enqueue(db, now, { type: "probe", project_id: p.id, owner_uid: p.owner_uid, key: p.id, payload: { source_path: p.source_path, size_bytes: p.size_bytes } }); kick(); await event(actor, "upload.complete", { project_id: p.id });
        return { project: publicProject(Object.assign({}, p, { status: "validating" })), job: publicJob(job) };
      } catch (e) { if (e instanceof HttpError) throw e; await revert(); throw storageFail(e); }
    },
    async cancelUpload(req, actor) {
      const p = await ownProject(actor, req.params.id), up = p.upload || {}; if (!["uploading", "completing"].includes(p.status)) throw new HttpError(409, "WRONG_STATE", "Загрузка не идёт");
      if (up.mode === "multipart" && storage.abortMultipart) await storage.abortMultipart(p.source_path, up.upload_id).catch(() => {});
      await storage.remove(p.source_path).catch(() => {}); await col(COLL.projects).doc(p.id).update({ status: "deleted", updated_at: now(), deleted_at: now() }); await event(actor, "upload.cancel", { project_id: p.id }); return { ok: true };
    },
    async deleteProject(req, actor) {
      const p = await ownProject(actor, req.params.id), jobs = (await col(COLL.jobs).where("project_id", "==", p.id).get()).docs.map(d => Object.assign({ id: d.id }, d.data()));
      if (jobs.some(j => ["claimed", "running"].includes(j.status))) throw new HttpError(409, "JOB_RUNNING", "Проект обрабатывается: сначала отмените задание и дождитесь остановки");
      if (p.status === "uploading" && p.upload && p.upload.mode === "multipart" && storage.abortMultipart) await storage.abortMultipart(p.source_path, p.upload.upload_id).catch(() => {});
      for (const j of jobs) if (j.status === "queued") await J.cancel(db, now, j.id);
      const clips = (await col(COLL.clips).where("project_id", "==", p.id).get()).docs; for (const c of clips) { await col(COLL.edits).doc(c.id).delete(); await col(COLL.clips).doc(c.id).delete(); }
      await storage.removePrefix("video-studio/" + p.owner_uid + "/" + p.id + "/"); await col(COLL.projects).doc(p.id).update({ status: "deleted", updated_at: now(), deleted_at: now(), counts: { clips: 0 } }); await event(actor, "project.delete", { project_id: p.id, clips: clips.length }); return { ok: true };
    },

    /* ---- анализ ---- */
    async estimate(req, actor) { const x = await analysisPlan(req, actor); return { estimate: x.estimate, limits: pubLimits(x.st.limits), clips: x.st.clips, model: x.model, whisper: x.whisper, duration_sec: x.p.duration_sec, groq_prompt_chars: x.groq.prompt.length, ok: true }; },
    async analyze(req, actor) {
      const x = await analysisPlan(req, actor); if (!req.body || req.body.confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED", "Подтвердите расход", { estimate: x.estimate });
      const b = req.body || {}, explicit = b.target_clips !== undefined, target = explicit ? b.target_clips : x.st.clips.max_clips, autoRender = b.auto_render !== false;
      if (!Number.isInteger(target) || target < 1 || target > 50) throw new HttpError(400, "INVALID", "Количество клипов: целое число от 1 до 50");
      let title; if (b.title !== undefined) { if (typeof b.title !== "string") throw new HttpError(400, "INVALID", "Название проекта: текст"); title = String(b.title).replace(/\s+/g, " ").trim(); if (!title || title.length > 120 || /[<>]/.test(title)) throw new HttpError(400, "INVALID", "Название проекта: от 1 до 120 символов без < >"); }
      const all = (await col(COLL.jobs).where("project_id", "==", x.p.id).get()).docs.map(d => Object.assign({ id: d.id }, d.data())).filter(j => j.type === "analyze"); if (all.some(j => ACTIVE.includes(j.status))) throw new HttpError(409, "ALREADY_RUNNING", "Анализ уже выполняется");
      const mineActive = (await col(COLL.jobs).where("owner_uid", "==", actor.uid).get()).docs.map(d => d.data()).filter(j => ACTIVE.includes(j.status)).length; if (mineActive >= 4) throw new HttpError(429, "TOO_MANY_JOBS", "В очереди уже 4 ваших задания");
      const key = x.p.id + "_" + sha({ m: x.model, w: x.whisper, pv: 4, vv: sha(x.st.vocabulary.terms), a: x.st.clips.min_s + "-" + x.st.clips.max_s + (explicit ? "-n" + target + (autoRender ? "" : "-nr") : "") }), jobId = "analyze_" + key, cached = all.find(j => j.id === jobId && j.status === "succeeded");
      if (cached) return { job: publicJob(cached), cached: true, estimate: x.estimate };
      const prev = await get(COLL.jobs, jobId); if (prev && ["failed", "cancelled"].includes(prev.status)) throw new HttpError(409, "USE_RETRY", "Прошлая попытка завершилась ошибкой: нажмите «Повторить»", { job: publicJob(prev) });
      const rsv = await B.reserve(db, now, { jobId, estimate: x.estimate, limits: x.st.limits });   // резерв привязан к заданию: повторный запрос получает already:true
      const { job, created } = await J.enqueue(db, now, { type: "analyze", project_id: x.p.id, owner_uid: x.p.owner_uid, key, reserved_usd: x.estimate.total_usd, payload: { model: x.model, whisper: x.whisper, language: "ru", groq_prompt: x.groq.prompt, duration_sec: x.p.duration_sec, source_path: x.p.source_path, max_clips: target, ...(explicit ? { target_clips: target } : {}), auto_render: autoRender, estimate: x.estimate } });
      if (created) await col(COLL.projects).doc(x.p.id).update(Object.assign({ status: "analyzing", updated_at: now(), auto_render: autoRender }, explicit ? { target_clips: target } : {}, title ? { title } : {})); else if (!rsv.already) await B.release(db, now, jobId); kick();   // аудит: раньше второй параллельный запрос снимал общий резерв первого
       await event(actor, "analyze.start", { project_id: x.p.id, estimate_usd: x.estimate.total_usd }); return { job: publicJob(job), created, estimate: x.estimate };
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
      const q = seeAll(req, actor) ? col(COLL.jobs) : col(COLL.jobs).where("owner_uid", "==", actor.uid), rows = (await q.get()).docs.map(d => Object.assign({ id: d.id }, d.data()));
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
      const q = seeAll(req, actor) ? col(COLL.clips) : col(COLL.clips).where("owner_uid", "==", actor.uid), allRows = (await q.get()).docs.map(d => Object.assign({ id: d.id }, d.data())).filter(c => c.status !== "excluded"), rows = allRows.filter(c => c.render);
      rows.sort((a, b) => (b.render.at || 0) - (a.render.at || 0)); const pj = new Map(); for (const c of rows.slice(0, 100)) if (!pj.has(c.project_id)) pj.set(c.project_id, await get(COLL.projects, c.project_id));
      return { clips_total: allRows.length, items: rows.slice(0, 100).map(c => Object.assign(publicClip(c), { project: (pj.get(c.project_id) || {}).filename || "" })) };
    }
  };
  const loadPresets = async () => { const d = await col(COLL.settings).doc("presets").get(); return { items: d.exists && Array.isArray(d.data().items) ? d.data().items.slice() : [] }; };
  /* Только настраиваемые значения оформления (то, что проходит проверку), без служебных разделов */
  const editablePatch = tpl => { const out = {}; for (const [sec, vals] of Object.entries(tpl || {})) { if (!vals || typeof vals !== "object" || Array.isArray(vals)) continue; for (const [k, v] of Object.entries(vals)) { try { const p = S.validateTemplatePatch({ [sec]: { [k]: v } }); if (p[sec]) out[sec] = Object.assign(out[sec] || {}, p[sec]); } catch (e) { /* значение не настраивается */ } } } return out; };
  const clipLimits = RP.clipLimits, templateStamp = RP.templateStamp, pubLimits = l => ({ monthly_usd: l.monthly_usd, per_job_usd: l.per_job_usd, max_duration_min: l.max_duration_min });

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
    const payload = RP.buildPayload({ kind: type, edits, clip, st, hash });
    let job; if (!prior) job = (await J.enqueue(db, now, { type, project_id: project.id, clip_id: clip.id, owner_uid: project.owner_uid, key, payload, priority: type === "preview" ? 3 : 5 })).job; else { await J.requeue(db, now, prior.id, { payload }); job = Object.assign({}, prior, { status: "queued", payload }); }
    if (type === "render") await col(COLL.clips).doc(clip.id).update({ status: "rendering", error: null, updated_at: now() }); kick(); await event(actor, type + ".start", { clip_id: clip.id, hash }); return { job: publicJob(job), cached: false, hash };
  }

  const WF = createWorkflow({ db, now, env, HttpError, ownClip, get, col, event, limited, loadSettings, seeAll, mayAccess, kick, newId, log });
  Object.assign(H, WF.handlers);
  const ROUTES = [
    ["GET", "/me", "me", null, false], ["GET", "/health", "health", null, false], ["GET", "/settings", "getSettings", null, false], ["PUT", "/settings", "putSettings", null, true], ["POST", "/settings/template/reset", "resetTemplate", null, true],
    ["GET", "/telegram", "getTelegram", null, false], ["PUT", "/telegram", "putTelegram", null, true], ["POST", "/telegram/check", "checkTelegram", null, true], ["POST", "/telegram/test", "testTelegram", null, true],
    ["GET", "/logo", "getLogo", null, false], ["POST", "/logo", "putLogo", null, true], ["POST", "/storage/cors", "setCors", null, true], ["POST", "/storage/check", "storageCheck", null, true], ["GET", "/monitor", "monitor", null, false], ["GET", "/dashboard", "dashboard", null, false], ["GET", "/analytics", "analytics", null, false], ["GET", "/events", "events", null, false], ["GET", "/diagnostics", "diagnostics", null, false], ["GET", "/media", "mediaLibrary", null, false], ["DELETE", "/clips/:id/export", "deleteExport", null, true], ["GET", "/presets", "listPresets", null, false], ["POST", "/presets", "createPreset", null, true], ["POST", "/presets/:id/apply", "applyPreset", null, true], ["DELETE", "/presets/:id", "deletePreset", null, true], ["POST", "/storage/selftest", "storageSelfTest", null, true],
    ["GET", "/projects", "listProjects", null, false], ["POST", "/projects", "createProject", null, true], ["GET", "/projects/:id", "getProject", null, false], ["DELETE", "/projects/:id", "deleteProject", null, true],
    ["POST", "/projects/:id/upload/parts", "uploadParts", null, true], ["GET", "/projects/:id/upload/status", "uploadStatus", null, false], ["POST", "/projects/:id/upload/complete", "completeUpload", null, true], ["POST", "/projects/:id/upload/cancel", "cancelUpload", null, true],
    ["GET", "/projects/:id/estimate", "estimate", null, false], ["POST", "/projects/:id/analyze", "analyze", null, true], ["GET", "/projects/:id/clips", "listClips", null, false], ["POST", "/projects/:id/clips/order", "reorderClips", null, true],
    ["GET", "/clips/:id", "getClip", null, false], ["PUT", "/clips/:id/edits", "patchEdits", null, true], ["PUT", "/clips/:id/range", "setRange", null, true], ["POST", "/clips/:id/window", "setWindow", null, true], ["POST", "/clips/:id/hooks", "suggestHooks", null, true],
    ["POST", "/clips/:id/state", "setClipState", null, true], ["POST", "/clips/:id/preview", "previewClip", null, true], ["POST", "/clips/:id/render", "renderClip", null, true], ["POST", "/clips/:id/telegram", "sendTelegram", null, true], ["GET", "/clips/:id/media", "media", null, false],
    ["GET", "/jobs", "listJobs", null, false], ["GET", "/jobs/:id", "getJob", null, false], ["POST", "/jobs/:id/cancel", "cancelJob", null, true], ["POST", "/jobs/:id/retry", "retryJob", null, true], ["GET", "/history", "history", null, false]
  ];
  ROUTES.push(...WF.routes);
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
  return { ROUTES, handler, H, authenticate, loadSettings, HttpError, trustedOrigins, webhook: WF.webhook };
}

/* Публичные представления: без внутренних путей хранилища и служебных данных */
const publicTelegram = t => (t ? { status: t.status, kind: t.kind || null, message_id: t.message_id || null, chat_id: t.chat_id || null, sent_at: t.sent_at || null, attempts: t.attempts || 0, hash: t.hash || null, error: t.error || null } : null);
const publicProject = p => ({ id: p.id, title: p.title || p.filename, target_clips: p.target_clips ?? null, auto_render: p.auto_render !== false, cover_clip_id: p.cover_clip_id || null, width: p.width ?? null, height: p.height ?? null, filename: p.filename, size_bytes: p.size_bytes, status: p.status, duration_sec: p.duration_sec ?? null, counts: p.counts || { clips: 0 }, error: p.error || null, created_at: p.created_at, updated_at: p.updated_at, owner_uid: p.owner_uid, analysis: p.analysis ? { model: p.analysis.model, whisper: p.analysis.whisper, cost_usd: p.analysis.cost_usd, no_good_moments: !!p.analysis.no_good_moments, rejected: p.analysis.rejected || [], error: p.analysis.error || null, at: p.analysis.at } : null });
const publicJob = j => ({ id: j.id, type: j.type, project_id: j.project_id, clip_id: j.clip_id || null, status: j.status, auto: !!(j.payload && j.payload.auto), stage: j.stage || null, stage_started_at: j.stage_started_at || null, stages: j.stages || [], progress: j.progress || 0, progress_known: j.progress_known === true, detail: j.detail || null, warnings: j.warnings || [], started_at: j.started_at || null, finished_at: j.finished_at || null, last_update_at: j.last_update_at || j.updated_at || null, attempts: j.attempts || 0, max_attempts: j.max_attempts, error: j.error || null, cancel_requested: !!j.cancel_requested, cost: j.cost || null, created_at: j.created_at, updated_at: j.updated_at, next_run_at: j.next_run_at || null });
const publicClip = c => ({ id: c.id, project_id: c.project_id, n: c.n ?? null, order: c.order ?? null, title: c.title || "", hook: c.hook || "", start: c.start, end: c.end, duration_s: c.duration_s ?? null, category: c.category || null, score: c.score ?? null, reason: c.reason || "", status: c.status, has_render: !!c.render, workflow: Object.assign({ status: "found", task: "", comment: "", assignee_id: null, rev: 0 }, c.workflow || {}), updated_at: c.updated_at ?? null, has_thumb: !!c.thumb_path, has_window: !!c.window_path, window_start: c.window_start ?? null, window_dur: c.window_dur ?? null,
  render: c.render ? { hash: c.render.hash, at: c.render.at, size: c.render.size, duration: c.render.duration } : null, preview: c.preview ? { hash: c.preview.hash, at: c.preview.at } : null, telegram: publicTelegram(c.telegram), error: c.error || null });
function mountVideoStudioApi(app, express, deps) {
  const api = createVideoStudioApi(deps), router = express.Router();
  router.use(express.json({ limit: "2mb", type: ["application/json", "application/vnd.hd+json"] }));
  for (const [method, p, name, perm, mut] of api.ROUTES) router[method.toLowerCase()](p, api.handler(name, perm, mut));
  router.post("/telegram/webhook", api.webhook);                         // публичный адрес бота: защищён секретом Telegram, не авторизацией Firebase
  router.use((req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  router.use((err, req, res, next) => res.status(err && err.status >= 400 && err.status < 500 ? err.status : 400).json({ error: err && err.type === "entity.too.large" ? "TOO_LARGE" : "BAD_REQUEST", message: "Некорректный запрос" }));   // 4 аргумента: обработчик ошибок Express
  app.use("/api/video-studio", router); return api;
}
module.exports = { createVideoStudioApi, mountVideoStudioApi, HttpError, publicClip, publicJob, publicProject };
