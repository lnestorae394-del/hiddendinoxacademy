"use strict";
/* Hidden Dinox Telegram-бот: ядро без зависимости от Telegraf (вызовы Bot API через api.call(method, payload)).
   • /start — видео (sendVideo по сохранённому file_id; первая отправка загружает файл и сохраняет file_id) и две кнопки.
   • Пользователи — bot_users/{telegram_id}; блокировка бота отмечается по my_chat_member и по ошибке 403 при рассылке.
   • Публикации (только ADMIN_TELEGRAM_ID): /newpost, /posts, /editpost, /deletepost, /broadcast.
     Мастер хранит состояние в Firestore (bot_admin_state) — перезапуск не обрывает его. Посты — bot_posts, история — bot_post_history.
   • Рассылка: аудитория фиксируется при подтверждении (bot_broadcast_targets), отметка доставки создаётся ДО отправки
     (bot_deliveries/{post}__{user}) — после перезапуска повторной отправки нет; аренда задания исключает два процесса на одну рассылку;
     429 → ожидание retry_after, 5xx/сеть → до 3 попыток, 403 → пользователь недоступен; пакеты по batchSize. */
const crypto = require("crypto");
const DEFAULTS = { batchSize: 25, sendIntervalMs: 40, progressEveryMs: 3000, leaseMs: 60e3, maxTempRetries: 3, max429: 8, targetsChunk: 400 };
const BTN_ACADEMY = "🟢 Открыть академию", BTN_SUPPORT = "Поддержка";
const START_CAPTION = "Добро пожаловать в Hidden Dinox Academy 🔥\n\nНажми кнопку ниже, чтобы открыть академию и получить доступ к обучению.";
const STATUS_RU = { draft: "черновик", sending: "идёт рассылка", sent: "разослан", deleted: "удалён" };
const esc = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const errInfo = e => { const r = (e && e.response) || {}; return { code: r.error_code || (e && e.code) || 0, description: String(r.description || (e && e.description) || (e && e.message) || ""), retryAfter: (r.parameters && r.parameters.retry_after) || null }; };
const isBlocked = i => i.code === 403 || /bot was blocked|user is deactivated|chat not found|bot can't initiate/i.test(i.description);

function config(env = process.env, extra = {}) {
  return { token: String(env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN || "").trim(),
    admins: new Set(String(env.ADMIN_TELEGRAM_ID || "").split(/[,\s]+/).filter(x => /^\d+$/.test(x))),
    webappUrl: env.BOT_WEBAPP_URL || "https://hiddendinox.com", supportUrl: env.BOT_SUPPORT_URL || "https://t.me/hiddendinoxsupport",
    startVideoPath: extra.startVideoPath || require("path").join(__dirname, "assets", "hidden_dinox_dostup_otkryt_v3.mp4"),
    startVideoFileId: String(env.BOT_START_VIDEO_FILE_ID || "").trim() || null, ...DEFAULTS, ...extra };
}
/* кнопки поста: строки «Название | https://…»; «||» — несколько кнопок в одном ряду */
function parseButtons(text) {
  const rows = [], errors = [];
  for (const [n, line] of String(text || "").split("\n").map(s => s.trim()).filter(Boolean).entries()) {
    const row = [];
    for (const part of line.split("||").map(s => s.trim()).filter(Boolean)) {
      const m = /^(.+?)\s*\|\s*(\S+)$/.exec(part);
      if (!m) { errors.push(`строка ${n + 1}: нужно «Название | https://ссылка»`); continue; }
      const t = m[1].trim(), url = m[2];
      if (t.length > 64) errors.push(`строка ${n + 1}: название длиннее 64 символов`);
      else if (!/^(https:\/\/[^\s/$.?#][^\s]*|tg:\/\/\S+)$/i.test(url)) errors.push(`строка ${n + 1}: ссылка должна начинаться с https:// или tg://`);
      else row.push({ text: t, url });
    }
    if (row.length) rows.push(row);
  }
  if (rows.flat().length > 10) errors.push("не больше 10 кнопок");
  if (rows.some(r => r.length > 3)) errors.push("не больше 3 кнопок в одном ряду");
  // в Firestore — плоский список { text, url, row }: вложенные массивы Firestore не хранит
  return { rows, buttons: rows.flatMap((r, i) => r.map(b => ({ text: b.text, url: b.url, row: i }))), errors };
}
const toRows = buttons => { const rows = []; for (const b of buttons || []) (rows[b.row || 0] = rows[b.row || 0] || []).push({ text: b.text, url: b.url }); return rows.filter(Boolean); };
const keyboard = buttons => buttons && buttons.length ? { inline_keyboard: toRows(buttons) } : undefined;
/* отправка поста в чат так, как его увидит ученик */
function postPayload(p, chatId) {
  const kb = keyboard(p.buttons);
  if (p.media && p.media.type === "photo") return ["sendPhoto", { chat_id: chatId, photo: p.media.file_id, ...(p.text ? { caption: p.text, caption_entities: p.entities || undefined } : {}), reply_markup: kb }];
  if (p.media && p.media.type === "video") return ["sendVideo", { chat_id: chatId, video: p.media.file_id, ...(p.text ? { caption: p.text, caption_entities: p.entities || undefined } : {}), reply_markup: kb }];
  return ["sendMessage", { chat_id: chatId, text: p.text, entities: p.entities || undefined, reply_markup: kb }];
}

function createBotCore({ db, api, cfg, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), log = console }) {
  const col = n => db.collection(n), instance = crypto.randomBytes(6).toString("hex");
  const isAdmin = id => cfg.admins.has(String(id));
  const send = (method, payload) => api.call(method, payload);
  const reply = (chatId, text, extra = {}) => send("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });

  /* ---------- пользователи ---------- */
  async function saveUser(from, chat) {
    const ref = col("bot_users").doc(String(from.id)), t = now();
    await db.runTransaction(async tx => { const s = await tx.get(ref), cur = s.exists ? s.data() : null;
      tx.set(ref, { id: from.id, chat_id: chat.id, username: from.username || null, first_name: from.first_name || null, language_code: from.language_code || null,
        started_at: cur ? cur.started_at : t, last_start_at: t, starts: ((cur && cur.starts) || 0) + 1, status: "active", blocked_at: null }); });
  }
  async function setUserStatus(id, status, reason = null) {
    const ref = col("bot_users").doc(String(id)), s = await ref.get(); if (!s.exists) return;
    await ref.set({ ...s.data(), status, blocked_at: status === "blocked" ? now() : null, blocked_reason: reason }, { merge: true });
  }
  /* ---------- /start: видео + кнопки ---------- */
  const startMarkup = () => ({ inline_keyboard: [[{ text: BTN_ACADEMY, web_app: { url: cfg.webappUrl } }], [{ text: BTN_SUPPORT, url: cfg.supportUrl }]] });
  let uploading = null;
  async function storedFileId() {
    const s = await col("bot_config").doc("start_video").get();
    // Админская загрузка в Firestore всегда важнее старой переменной окружения.
    if (s.exists && Object.prototype.hasOwnProperty.call(s.data(), "file_id")) return s.data().file_id || null;
    return cfg.startVideoFileId || null;
  }
  async function saveFileId(msg, source) { const v = msg && msg.video; if (!v || !v.file_id) return null;
    await col("bot_config").doc("start_video").set({ file_id: v.file_id, file_unique_id: v.file_unique_id || null, duration: v.duration || null, source, saved_at: now() }); return v.file_id; }
  async function sendStartVideo(chatId) {
    const id = await storedFileId();
    if (!id) {
      const e = new Error("Стартовое видео ещё не настроено. Администратору нужно отправить /videoid и загрузить видео.");
      e.code = "START_VIDEO_NOT_CONFIGURED";
      throw e;
    }
    try {
      return await send("sendVideo", { chat_id: chatId, video: id, caption: START_CAPTION, reply_markup: startMarkup() });
    } catch (e) {
      const i = errInfo(e);
      if (i.code === 400 && /file|identifier|wrong/i.test(i.description)) {
        log.warn && log.warn("bot: сохранённый стартовый file_id отклонён Telegram; требуется обновить через /videoid");
        const ref = col("bot_config").doc("start_video");
        await ref.set({ file_id: null, invalidated_at: now(), invalid_reason: i.description.slice(0, 180) }, { merge: true });
      }
      throw e;
    }
  }
  /* ---------- состояние мастера администратора ---------- */
  const stRef = id => col("bot_admin_state").doc(String(id));
  const getState = async id => { const s = await stRef(id).get(); return s.exists ? s.data() : null; };
  const setState = (id, v) => stRef(id).set({ ...v, updated_at: now() });
  const clearState = id => stRef(id).delete();
  async function history(postId, action, by, extra = {}) { await col("bot_post_history").doc(`${postId}_${now()}_${action}`).set({ post_id: postId, action, by: String(by || ""), at: now(), ...extra }); }
  async function getPost(id) { if (!/^p_[0-9a-f]{10}$/.test(String(id || ""))) return null; const s = await col("bot_posts").doc(id).get(); return s.exists ? s.data() : null; }
  async function activeCount() { return (await col("bot_users").where("status", "==", "active").get()).docs.length; }
  async function preview(chatId, draft) {
    await reply(chatId, "👁 <b>Предпросмотр</b> — так публикацию увидят ученики:");
    const [m, p] = postPayload(draft, chatId); await send(m, p);
  }
  const adminActions = (postId, version) => ({ inline_keyboard: [[{ text: "✅ Сохранить черновик", callback_data: `ps:${postId}` }, { text: "🚀 К отправке", callback_data: `pb:${postId}:${version}` }], [{ text: "✖ Отмена", callback_data: "px" }]] });

  /* ---------- команды администратора ---------- */
  async function adminCommand(msg, cmd, arg) {
    const chatId = msg.chat.id, uid = msg.from.id;
    if (cmd === "newpost") { await setState(uid, { flow: "new", step: "text", draft: { text: null, entities: null, media: null, buttons: [] } }); return reply(chatId, "📝 <b>Новая публикация.</b> Шаг 1 из 3 — отправьте текст публикации (можно с форматированием). /cancel — отмена."); }
    if (cmd === "cancel") { await clearState(uid); return reply(chatId, "Отменено."); }
    if (cmd === "posts") {
      const list = (await col("bot_posts").get()).docs.map(d => d.data()).filter(p => p.status !== "deleted").sort((a, b) => b.created_at - a.created_at).slice(0, 15);
      if (!list.length) return reply(chatId, "Публикаций пока нет. /newpost — создать.");
      return reply(chatId, "📋 <b>Публикации</b>\n\n" + list.map(p => `<code>${p.id}</code> · ${STATUS_RU[p.status] || p.status}${p.stats ? ` · ✅ ${p.stats.sent} · ⚠️ ${p.stats.failed} · 🚫 ${p.stats.blocked}` : ""}\n${esc(String(p.text || "(без текста)").slice(0, 80))}`).join("\n\n") +
        "\n\n/editpost ID · /deletepost ID · /broadcast ID");
    }
    if (cmd === "editpost") {
      const p = await getPost(arg); if (!p || p.status === "deleted") return reply(chatId, "Публикация не найдена. /posts — список.");
      if (p.status !== "draft") return reply(chatId, "Изменять можно только черновики: эта публикация уже " + (STATUS_RU[p.status] || p.status) + ".");
      await setState(uid, { flow: "edit", step: "text", post_id: p.id, draft: { text: p.text, entities: p.entities || null, media: p.media || null, buttons: p.buttons || [] } });
      return reply(chatId, "✏️ <b>Изменение черновика.</b> Отправьте новый текст или /skip — оставить текущий.");
    }
    if (cmd === "deletepost") {
      const p = await getPost(arg); if (!p || p.status === "deleted") return reply(chatId, "Публикация не найдена. /posts — список.");
      if (p.status === "sending") return reply(chatId, "Нельзя удалить: идёт рассылка.");
      return reply(chatId, `Удалить публикацию <code>${p.id}</code> из списка? ${p.status === "sent" ? "Сообщения у учеников останутся, история рассылки сохранится." : "Это черновик."}`,
        { reply_markup: { inline_keyboard: [[{ text: "🗑 Удалить", callback_data: `pd:${p.id}` }, { text: "Отмена", callback_data: "px" }]] } });
    }
    if (cmd === "broadcast") {
      const p = await getPost(arg); if (!p || p.status === "deleted") return reply(chatId, "Укажите ID публикации: /broadcast ID (/posts — список).");
      return confirmBroadcast(chatId, p);
    }
    if (cmd === "videoid" || cmd === "setstartvideo") {
      await setState(uid, { flow: "start_video", step: "video" });
      return reply(chatId, "🎬 Отправь следующим сообщением стартовое видео как обычное видео Telegram (не как документ). Я сохраню его file_id, и бот будет отправлять ролик без повторной загрузки MP4 с Render. /cancel — отмена.");
    }
    return null;
  }
  async function confirmBroadcast(chatId, p) {
    if (p.status === "sent") return reply(chatId, "Эта публикация уже разослана. Повторная отправка не выполняется — создайте новую публикацию.");
    if (p.status === "sending") return reply(chatId, "Рассылка этой публикации уже идёт.");
    await preview(chatId, p); const n = await activeCount();
    return reply(chatId, `Отправить эту публикацию <b>${n}</b> пользователям в личные сообщения?\nЭто нельзя отменить после запуска.`,
      { reply_markup: { inline_keyboard: [[{ text: `✅ Да, отправить ${n}`, callback_data: `pc:${p.id}:${p.version}` }, { text: "✖ Отмена", callback_data: "px" }]] } });
  }
  /* шаги мастера */
  async function wizard(msg, st) {
    const chatId = msg.chat.id, uid = msg.from.id;
    if (st.flow === "start_video") {
      if (/^\/cancel\b/.test(msg.text || "")) { await clearState(uid); return reply(chatId, "Настройка стартового видео отменена."); }
      const id = await saveFileId(msg, "admin_upload");
      if (!id) return reply(chatId, "Не вижу видео в сообщении. Отправь MP4 именно как видео, не как документ. /cancel — отмена.");
      await clearState(uid);
      return reply(chatId, `✅ Стартовое видео сохранено.\nfile_id: <code>${esc(id)}</code>\nТеперь /start будет отправлять видео по file_id.`);
    }
    const d = st.draft, text = msg.text || msg.caption || "", skip = /^\/skip\b/.test(msg.text || "");
    if (st.step === "text") {
      if (!skip || !d.text) { if (!msg.text || msg.text.startsWith("/")) return reply(chatId, "Отправьте текст публикации обычным сообщением.");
        if (msg.text.length > 4096) return reply(chatId, "Текст длиннее 4096 символов — сократите его.");
        d.text = msg.text; d.entities = msg.entities || null; }
      await setState(uid, { ...st, step: "media", draft: d });
      return reply(chatId, "🖼 Шаг 2 из 3 — отправьте фото или видео для публикации или /skip — без медиа.");
    }
    if (st.step === "media") {
      if (msg.photo && msg.photo.length) d.media = { type: "photo", file_id: msg.photo[msg.photo.length - 1].file_id };
      else if (msg.video) d.media = { type: "video", file_id: msg.video.file_id };
      else if (skip) d.media = st.flow === "edit" ? d.media : null;
      else if (/^\/nomedia\b/.test(msg.text || "")) d.media = null;
      else return reply(chatId, "Отправьте фото или видео, /skip — без медиа" + (st.flow === "edit" ? " (оставить текущее), /nomedia — убрать медиа." : "."));
      if (d.media && d.text && d.text.length > 1024) return reply(chatId, "Подпись к фото или видео — не больше 1024 символов. Сократите текст (/cancel и заново) или отправьте /skip без медиа.");
      await setState(uid, { ...st, step: "buttons", draft: d });
      return reply(chatId, "🔘 Шаг 3 из 3 — кнопки. Каждая кнопка с новой строки:\n<code>Название | https://ссылка</code>\nНесколько кнопок в одном ряду — через <code>||</code>.\n/skip — без кнопок" + (st.flow === "edit" ? " (оставить текущие), /nobuttons — убрать." : "."));
    }
    if (st.step === "buttons") {
      if (skip) { if (st.flow !== "edit") d.buttons = []; }
      else if (/^\/nobuttons\b/.test(msg.text || "")) d.buttons = [];
      else { const r = parseButtons(text); if (r.errors.length || !r.rows.length) return reply(chatId, "Не получилось разобрать кнопки:\n" + esc((r.errors.length ? r.errors : ["нет ни одной кнопки"]).join("\n")) + "\nИсправьте и отправьте ещё раз или /skip."); d.buttons = r.buttons; }
      const id = st.post_id || "p_" + crypto.randomBytes(5).toString("hex"), ref = col("bot_posts").doc(id), t = now();
      const cur = st.post_id ? await getPost(id) : null;
      if (cur && cur.status !== "draft") { await clearState(uid); return reply(chatId, "Публикация уже не черновик — изменения не сохранены."); }
      const post = { id, status: "draft", text: d.text, entities: d.entities, media: d.media, buttons: d.buttons, created_at: cur ? cur.created_at : t, created_by: String(cur ? cur.created_by : uid), updated_at: t, version: ((cur && cur.version) || 0) + 1, stats: null };
      await ref.set(post); await history(id, cur ? "edited" : "created", uid, { version: post.version });
      await clearState(uid); await preview(chatId, post);
      return reply(chatId, `Публикация <code>${id}</code> сохранена как черновик.`, { reply_markup: adminActions(id, post.version) });
    }
  }
  /* ---------- кнопки администратора ---------- */
  async function adminCallback(q) {
    const chatId = q.message ? q.message.chat.id : q.from.id, [kind, id, ver] = String(q.data || "").split(":");
    const ack = (text) => send("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) });
    if (kind === "px") { await ack("Отменено"); return reply(chatId, "Отменено."); }
    const p = await getPost(id); if (!p || p.status === "deleted") { await ack("Публикация не найдена"); return null; }
    if (kind === "ps") { await ack("Сохранено"); return reply(chatId, `Черновик <code>${p.id}</code> сохранён. /broadcast ${p.id} — отправить.`); }
    if (kind === "pb") { await ack(); return confirmBroadcast(chatId, p); }
    if (kind === "pd") {
      if (p.status === "sending") { await ack("Идёт рассылка"); return null; }
      await col("bot_posts").doc(p.id).set({ ...p, status: "deleted", deleted_at: now(), status_before_delete: p.status }); await history(p.id, "deleted", q.from.id);
      await ack("Удалено"); return reply(chatId, `Публикация <code>${p.id}</code> удалена из списка. История сохранена.`);
    }
    if (kind === "pc") {
      if (String(p.version) !== String(ver)) { await ack("Публикация изменилась — откройте предпросмотр заново"); return confirmBroadcast(chatId, p); }
      const r = await startBroadcast(p.id, q.from.id, chatId);
      await ack(r.ok ? "Рассылка запущена" : r.message); if (!r.ok) return reply(chatId, r.message);
      return null;
    }
    return ack();
  }
  /* ---------- рассылка ---------- */
  const jobRef = id => col("bot_broadcasts").doc(id);
  async function startBroadcast(postId, adminId, chatId) {
    const users = (await col("bot_users").where("status", "==", "active").get()).docs.map(d => d.data().id).sort((a, b) => a - b);
    const res = await db.runTransaction(async tx => {
      const ps = await tx.get(col("bot_posts").doc(postId)), js = await tx.get(jobRef(postId));
      if (!ps.exists || ps.data().status === "deleted") return { ok: false, message: "Публикация не найдена." };
      if (js.exists || ps.data().status !== "draft") return { ok: false, message: "Эта публикация уже разослана или рассылается — повторная отправка не выполняется." };
      const p = ps.data(), t = now();
      tx.set(col("bot_posts").doc(postId), { ...p, status: "sending", broadcast_started_at: t });
      tx.set(jobRef(postId), { post_id: postId, status: "running", snapshot: { text: p.text, entities: p.entities || null, media: p.media || null, buttons: p.buttons || [] },
        total: users.length, chunks: Math.ceil(users.length / cfg.targetsChunk), cursor: { chunk: 0, offset: 0 }, sent: 0, failed: 0, blocked: 0, uncertain: 0, skipped: 0,
        started_at: t, started_by: String(adminId), progress_chat_id: chatId, progress_message_id: null, lease_until: 0, lease_owner: null });
      return { ok: true };
    });
    if (!res.ok) return res;
    for (let i = 0; i * cfg.targetsChunk < users.length; i++) await col("bot_broadcast_targets").doc(`${postId}_${String(i).padStart(5, "0")}`).set({ post_id: postId, chunk: i, ids: users.slice(i * cfg.targetsChunk, (i + 1) * cfg.targetsChunk) });
    await jobRef(postId).set({ targets_ready: true }, { merge: true });
    await history(postId, "broadcast_started", adminId, { total: users.length });
    const m = await reply(chatId, `🚀 Рассылка запущена: ${users.length} получателей.`); await jobRef(postId).set({ progress_message_id: m && m.message_id || null }, { merge: true });
    runJob(postId).catch(e => log.error && log.error("bot: рассылка прервана:", e && e.message));
    return { ok: true, total: users.length };
  }
  async function lease(postId) { return db.runTransaction(async tx => { const s = await tx.get(jobRef(postId)); if (!s.exists) return false; const j = s.data();
    if (j.status !== "running" || !j.targets_ready) return false; if (j.lease_owner && j.lease_owner !== instance && j.lease_until > now()) return false;
    tx.set(jobRef(postId), { ...j, lease_owner: instance, lease_until: now() + cfg.leaseMs }); return true; }); }
  async function deliverOne(postId, snap, userId) {
    const dref = col("bot_deliveries").doc(`${postId}__${userId}`);
    const fresh = await db.runTransaction(async tx => { const s = await tx.get(dref); if (s.exists) return false; tx.set(dref, { post_id: postId, user_id: userId, status: "sending", at: now(), owner: instance }); return true; });
    if (!fresh) { const s = (await dref.get()).data(); if (s.status === "sending") { await dref.set({ ...s, status: "uncertain" }); return "uncertain"; } return "skipped"; }   // после перезапуска — без повтора
    let temp = 0, rl = 0;
    for (;;) {
      try { const [m, p] = postPayload(snap, userId); const r = await send(m, p); await dref.set({ post_id: postId, user_id: userId, status: "sent", message_id: (r && r.message_id) || null, at: now() }); return "sent"; }
      catch (e) { const i = errInfo(e);
        if (i.code === 429 && rl < cfg.max429) { rl++; await sleep((i.retryAfter || 1) * 1000 + 100); continue; }
        if (isBlocked(i)) { await dref.set({ post_id: postId, user_id: userId, status: "blocked", error: i.description.slice(0, 200), at: now() }); await setUserStatus(userId, "blocked", i.description.slice(0, 120)); return "blocked"; }
        if ((i.code >= 500 || !i.code) && temp < cfg.maxTempRetries - 1) { temp++; await sleep(1000 * temp); continue; }
        await dref.set({ post_id: postId, user_id: userId, status: "failed", error: `${i.code} ${i.description}`.slice(0, 200), at: now() }); return "failed";   // пользователь остаётся в базе
      }
    }
  }
  const progressText = (j, done) => `${done ? "✅ <b>Рассылка завершена</b>" : "⏳ <b>Рассылка идёт</b>"} · <code>${j.post_id}</code>\nОтправлено: ${j.sent} из ${j.total}\nОшибок: ${j.failed}\nЗаблокировали бота: ${j.blocked}` + (j.uncertain ? `\nБез подтверждения (после перезапуска, не повторялись): ${j.uncertain}` : "");
  async function progress(j, done = false) { if (!j.progress_chat_id) return; try {
      if (j.progress_message_id) await send("editMessageText", { chat_id: j.progress_chat_id, message_id: j.progress_message_id, text: progressText(j, done), parse_mode: "HTML" });
      else await reply(j.progress_chat_id, progressText(j, done)); } catch (e) { /* «message is not modified» и т. п. не мешают рассылке */ } }
  async function runJob(postId) {
    if (!(await lease(postId))) return { status: "busy" };
    let lastProgress = 0;
    for (;;) {
      const j = (await jobRef(postId).get()).data(); if (!j || j.status !== "running") return { status: j ? j.status : "missing" };
      if (j.cursor.chunk >= j.chunks) {
        const fin = { ...j, status: "done", finished_at: now(), lease_owner: null, lease_until: 0 }; await jobRef(postId).set(fin);
        const ps = await col("bot_posts").doc(postId).get(); if (ps.exists) await col("bot_posts").doc(postId).set({ ...ps.data(), status: "sent", sent_at: now(), stats: { total: j.total, sent: j.sent, failed: j.failed, blocked: j.blocked, uncertain: j.uncertain } });
        await history(postId, "broadcast_finished", j.started_by, { sent: j.sent, failed: j.failed, blocked: j.blocked, uncertain: j.uncertain }); await progress(fin, true); return { status: "done" };
      }
      const chunk = (await col("bot_broadcast_targets").doc(`${postId}_${String(j.cursor.chunk).padStart(5, "0")}`).get()).data(), ids = chunk ? chunk.ids : [];
      const batch = ids.slice(j.cursor.offset, j.cursor.offset + cfg.batchSize), inc = { sent: 0, failed: 0, blocked: 0, uncertain: 0, skipped: 0 };
      for (const uid of batch) { const r = await deliverOne(postId, j.snapshot, uid); inc[r]++; if (cfg.sendIntervalMs) await sleep(cfg.sendIntervalMs); }
      const nextOffset = j.cursor.offset + batch.length, cursor = nextOffset >= ids.length ? { chunk: j.cursor.chunk + 1, offset: 0 } : { chunk: j.cursor.chunk, offset: nextOffset };
      const ok = await db.runTransaction(async tx => { const s = await tx.get(jobRef(postId)), cur = s.data(); if (cur.lease_owner !== instance) return null;
        const next = { ...cur, cursor, sent: cur.sent + inc.sent, failed: cur.failed + inc.failed, blocked: cur.blocked + inc.blocked, uncertain: cur.uncertain + inc.uncertain, skipped: cur.skipped + inc.skipped, lease_until: now() + cfg.leaseMs };
        tx.set(jobRef(postId), next); return next; });
      if (!ok) return { status: "lost_lease" };
      if (now() - lastProgress >= cfg.progressEveryMs) { lastProgress = now(); await progress(ok); }
    }
  }
  /* при запуске процесса — продолжить незавершённые рассылки */
  async function resumeJobs() { const out = []; for (const d of (await col("bot_broadcasts").where("status", "==", "running").get()).docs) out.push(await runJob(d.id)); return out; }

  /* ---------- обработка обновлений ---------- */
  async function handleUpdate(u) {
    if (u.my_chat_member && u.my_chat_member.chat.type === "private") {
      const st = u.my_chat_member.new_chat_member.status; return setUserStatus(u.my_chat_member.from.id, st === "kicked" ? "blocked" : "active", st === "kicked" ? "заблокировал бота" : null);
    }
    if (u.callback_query) { if (!isAdmin(u.callback_query.from.id)) return send("answerCallbackQuery", { callback_query_id: u.callback_query.id }); return adminCallback(u.callback_query); }
    const msg = u.message; if (!msg || !msg.from || msg.chat.type !== "private") return null;
    const m = /^\/([a-z]+)(?:@\w+)?(?:\s+(.+))?$/i.exec(msg.text || ""), cmd = m ? m[1].toLowerCase() : null, arg = m && m[2] ? m[2].trim() : "";
    if (cmd === "start") {
      await saveUser(msg.from, msg.chat);
      try { return await sendStartVideo(msg.chat.id); }
      catch (e) {
        log.error && log.error("bot: не удалось отправить стартовое видео:", (e && e.response && e.response.description) || (e && e.message) || e);
        return reply(msg.chat.id, START_CAPTION, { reply_markup: startMarkup() });
      }
    }
    if (!isAdmin(msg.from.id)) return null;                                              // посторонним администраторские команды не отвечают
    if (cmd && ["newpost", "posts", "editpost", "deletepost", "broadcast", "cancel", "videoid", "setstartvideo"].includes(cmd)) return adminCommand(msg, cmd, arg);
    const st = await getState(msg.from.id); if (st) return wizard(msg, st);
    return null;
  }
  return { handleUpdate, resumeJobs, runJob, startBroadcast, parseButtons, instance };
}
module.exports = { createBotCore, config, parseButtons, postPayload, BTN_ACADEMY, BTN_SUPPORT, START_CAPTION };
