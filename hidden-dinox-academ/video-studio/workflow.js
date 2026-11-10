"use strict";
/* Рабочий процесс клипов (изолированный модуль): статусы и «задача для монтажёра», назначения, монтажёры, журнал изменений, общий список «Готовые клипы»,
   привязка Telegram монтажёров по одноразовому коду и отправка клипов. Хранение — только коллекции videoStudio*: рабочие данные лежат в самом документе клипа
   (поле workflow), тексты и правки — в videoStudioEdits (единый источник; копий состояния нет), монтажёры — videoStudioEditors, история — videoStudioClipEvents. */
const crypto = require("crypto");
const RC = require("./read-cache"), { COLL } = require("./constants"), E = require("./edits"), RP = require("./render-plan"), TGB = require("./tg-bot"), TG = require("./telegram"), J = require("./jobs");
const STATUSES = [["found", "Найден"], ["pending", "Ожидает редактирования"], ["needs_changes", "Нужны правки"], ["in_progress", "В работе у монтажёра"], ["review", "На проверке"], ["ready", "Готов"], ["approved", "Утверждён"]];
const LABEL = Object.fromEntries(STATUSES), SID = STATUSES.map(s => s[0]);
const sha256 = s => crypto.createHash("sha256").update(String(s)).digest("hex"), ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", code8 = () => Array.from(crypto.randomBytes(8), b => ALPHA[b % ALPHA.length]).join("");
const wfOf = c => Object.assign({ status: "found", task: "", comment: "", assignee_id: null, rev: 0 }, (c && c.workflow) || {});
const trunc = (s, n) => (String(s || "").length > n ? String(s).slice(0, n - 1) + "…" : String(s || ""));
const FIELD_NAMES = { status: "статус", task: "задание", comment: "комментарий", assignee_id: "монтажёр" };
function createWorkflow(x) {
  const { db, now, env, HttpError, ownClip, get, col, event, limited, loadSettings, seeAll, mayAccess, kick, newId, log = console } = x, rate = {}; let seq = 0;
  const text = (v, field, max, { required = false } = {}) => { const s = String(v == null ? "" : v).replace(/\r/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim(); if (required && !s) throw new HttpError(400, "INVALID", field + ": обязательное поле"); if (s.length > max) throw new HttpError(400, "TOO_LONG", field + ": не более " + max + " символов"); return s; };
  const name = (v, field, max) => { const s = text(v, field, max, { required: true }).replace(/\s+/g, " "); if (/[<>]/.test(s)) throw new HttpError(400, "INVALID", field + ": без символов < >"); return s; };
  async function logEvent(actor, clip, kind, data = {}) { try { await col(COLL.clipEvents).doc(newId("ce")).set(Object.assign({ clip_id: clip.id, project_id: clip.project_id, owner_uid: clip.owner_uid, at: now(), seq: ++seq, by: actor && (actor.email || actor.uid) || "system", by_uid: actor ? actor.uid : null, kind }, data)); } catch (e) { log.error && log.error("video-studio журнал клипа:", e && e.message); } }
  const renderState = (clip, edits, st) => (clip.status === "rendering" ? "building" : !clip.render ? "none" : edits && clip.render.hash !== E.editsHash(edits, RP.templateStamp(st)) ? "stale" : "ready");
  const editorPublic = e => ({ id: e.id, name: e.name, note: e.note || "", active: e.active !== false, telegram_status: !TGB.enabled(env) ? "disabled" : e.telegram && e.telegram.user_id ? "linked" : "not_linked", telegram_name: e.telegram ? e.telegram.name || null : null, linked_at: e.telegram ? e.telegram.linked_at || null : null, created_at: e.created_at || null });
  const ownEditor = async (actor, id) => { const e = await get(COLL.editors, String(id)); if (!e || !mayAccess(actor, e.owner_uid)) throw new HttpError(404, "NOT_FOUND", "Монтажёр не найден"); return e; };
  const H = {
    /* ---- «Готовые клипы»: общий список всех клипов с рабочими данными (один источник правды — документы клипа и правок) ---- */
    async listAllClips(req, actor) {
      const q = req.query || {}, snap = c => RC.all(db, c, async () => (await col(c).get()).docs.map(d => Object.assign({ id: d.id }, d.data()))).then(rows => ({ docs: rows.map(r => ({ id: r.id, data: () => r })) }));
      const [cd0, ed, pd, ee, st] = await Promise.all([snap(COLL.clips), snap(COLL.edits), snap(COLL.projects), snap(COLL.editors), loadSettings()]), cd = { docs: cd0.docs.filter(d => seeAll(req, actor) || d.data().owner_uid === actor.uid) };
      const edits = new Map(ed.docs.map(d => [d.id, d.data()])), projects = new Map(pd.docs.map(d => [d.id, Object.assign({ id: d.id }, d.data())])), editors = new Map(ee.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(e => mayAccess(actor, e.owner_uid)).map(e => [e.id, e]));
      const rows = cd.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(c => c.status !== "excluded" && projects.has(c.project_id) && projects.get(c.project_id).status !== "deleted").map(c => {
        const e = edits.get(c.id) || null, w = wfOf(c), ed2 = w.assignee_id ? editors.get(w.assignee_id) : null, cap = e && e.caption && e.caption.enabled ? e.caption.text || "" : "";
        return { id: c.id, project_id: c.project_id, project_title: projects.get(c.project_id).title || projects.get(c.project_id).filename, title: c.title || c.hook || "Клип", hook: (e && e.hook && e.hook.text) || c.hook || "", caption_text: cap, duration_s: c.render && c.render.duration ? c.render.duration : c.duration_s ?? null, has_thumb: !!c.thumb_path,
          workflow: { status: w.status, status_label: LABEL[w.status] || w.status, task_preview: trunc(w.task, 160), has_task: !!w.task, assignee_id: w.assignee_id, assignee_name: ed2 ? ed2.name : null, rev: w.rev }, render_state: renderState(c, e, st), render: c.render ? { size: c.render.size || null, duration: c.render.duration || null, at: c.render.at || null } : null,
          telegram: c.telegram ? c.telegram.status : null, deliveries: Object.keys(c.deliveries || {}).length, updated_at: Math.max(c.updated_at || 0, (e && e.updated_at) || 0, w.updated_at || 0, (c.render && c.render.at) || 0, c.created_at || 0) };
      });
      const hay = it => (it.title + " " + it.hook + " " + it.caption_text + " " + it.project_title + " " + it.workflow.task_preview).toLowerCase(), qq = String(q.q || "").trim().toLowerCase();
      let items = rows.filter(it => (!q.project_id || it.project_id === q.project_id) && (!q.editor_id || (q.editor_id === "none" ? !it.workflow.assignee_id : it.workflow.assignee_id === q.editor_id)) && (!qq || hay(it).includes(qq)) && (!q.state || (q.state === "rendered" ? ["ready", "stale"].includes(it.render_state) : it.render_state === q.state)));
      const counts = { total: items.length }; for (const [id] of STATUSES) counts[id] = items.filter(it => it.workflow.status === id).length; if (q.status && SID.includes(q.status)) items = items.filter(it => it.workflow.status === q.status);
      items.sort((a, b) => b.updated_at - a.updated_at);
      return { clips: items.slice(0, 300), counts, statuses: STATUSES.map(([id, label]) => ({ id, label })), editors: [...editors.values()].filter(e => e.active !== false).map(editorPublic), projects: [...projects.values()].filter(p => p.status !== "deleted" && (seeAll(req, actor) || p.owner_uid === actor.uid)).map(p => ({ id: p.id, title: p.title || p.filename })) };
    },
    /* ---- статус, задача и комментарий: сохранение с проверкой версии, журнал изменений ---- */
    async putWorkflow(req, actor) {
      const { clip } = await ownClip(actor, req.params.id), b = req.body || {}; if (!Number.isInteger(b.base_rev)) throw new HttpError(400, "INVALID", "Нужен base_rev");
      const patch = {}; if (b.status !== undefined) { if (!SID.includes(b.status)) throw new HttpError(400, "INVALID", "Недопустимый статус"); patch.status = b.status; }
      if (b.task !== undefined) patch.task = text(b.task, "Задание", 5000); if (b.comment !== undefined) patch.comment = text(b.comment, "Комментарий", 2000);
      if (!Object.keys(patch).length) throw new HttpError(400, "INVALID", "Нечего сохранять");
      const ref = col(COLL.clips).doc(clip.id), out = await db.runTransaction(async tx => {
        const s = await tx.get(ref); if (!s.exists) throw new HttpError(404, "NOT_FOUND"); const cur = wfOf(s.data()); if (cur.rev !== b.base_rev) return { conflict: cur };
        const next = Object.assign({}, cur, patch, { rev: cur.rev + 1, updated_at: now(), updated_by: actor.email || actor.uid }); tx.update(ref, { workflow: next, updated_at: now() }); return { before: cur, next };
      });
      if (out.conflict) throw new HttpError(409, "REV_CONFLICT", "Клип изменён в другом окне: данные обновлены", { workflow: out.conflict });
      const changes = Object.keys(patch).filter(k => out.before[k] !== out.next[k]).map(k => ({ field: k, label: FIELD_NAMES[k], from: k === "task" || k === "comment" ? trunc(out.before[k], 200) : out.before[k], to: k === "task" || k === "comment" ? trunc(out.next[k], 200) : out.next[k] }));
      if (changes.length) await logEvent(actor, clip, "workflow", { changes, comment: patch.comment !== undefined && patch.comment !== out.before.comment ? trunc(patch.comment, 500) : null });
      return { workflow: out.next, changed: changes.length };
    },
    /* ---- назначение клипов монтажёру (один или несколько) ---- */
    async assignClips(req, actor) {
      const b = req.body || {}, ids = b.clip_ids; if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(i => typeof i !== "string")) throw new HttpError(400, "INVALID", "clip_ids: от 1 до 100 клипов");
      let ed = null; if (b.editor_id !== null && b.editor_id !== undefined) { ed = await ownEditor(actor, b.editor_id); if (ed.active === false) throw new HttpError(409, "EDITOR_INACTIVE", "Монтажёр отключён"); } else if (b.editor_id === undefined) throw new HttpError(400, "INVALID", "Нужен editor_id (или null, чтобы снять назначение)");
      const updated = [], skipped = [];
      for (const id of [...new Set(ids)]) {
        let clip; try { clip = (await ownClip(actor, id)).clip; } catch (e) { skipped.push({ clip_id: id, reason: "NOT_FOUND" }); continue; }
        const ref = col(COLL.clips).doc(id), r = await db.runTransaction(async tx => { const s = await tx.get(ref), cur = wfOf(s.data()); if (cur.assignee_id === (ed ? ed.id : null)) return { same: true }; const next = Object.assign({}, cur, { assignee_id: ed ? ed.id : null, status: ed && cur.status === "found" ? "pending" : cur.status, rev: cur.rev + 1, updated_at: now(), updated_by: actor.email || actor.uid }); tx.update(ref, { workflow: next, updated_at: now() }); return { before: cur, next }; });
        if (r.same) { skipped.push({ clip_id: id, reason: "UNCHANGED" }); continue; }
        updated.push(id); await logEvent(actor, clip, "assign", { changes: [{ field: "assignee_id", label: "монтажёр", from: r.before.assignee_id, to: r.next.assignee_id }, ...(r.before.status !== r.next.status ? [{ field: "status", label: "статус", from: r.before.status, to: r.next.status }] : [])], note: ed ? "Назначен: " + ed.name : "Назначение снято" });
      }
      return { updated: updated.length, updated_ids: updated, skipped };
    },
    async clipHistory(req, actor) { const { clip } = await ownClip(actor, req.params.id); return { events: (await col(COLL.clipEvents).where("clip_id", "==", clip.id).get()).docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => (b.at - a.at) || ((b.seq || 0) - (a.seq || 0))).slice(0, 100) }; },
    async activity(req, actor) {
      const n = Math.min(200, Math.max(1, Number(req.query && req.query.limit) || 80)), rows = (await col(COLL.clipEvents).orderBy("at", "desc").limit(400).get()).docs.map(d => Object.assign({ id: d.id }, d.data())).filter(e => seeAll(req, actor) || e.owner_uid === actor.uid).slice(0, n);
      const cl = new Map(); for (const e of rows) if (!cl.has(e.clip_id)) { const c = await get(COLL.clips, e.clip_id); cl.set(e.clip_id, c ? c.title || c.hook : null); } return { events: rows.map(e => Object.assign({}, e, { clip_title: cl.get(e.clip_id) })) };
    },
    /* ---- монтажёры ---- */
    async listEditors(req, actor) {
      const snap = c => RC.all(db, c, async () => (await col(c).get()).docs.map(d => Object.assign({ id: d.id }, d.data()))).then(rows => ({ docs: rows.map(r => ({ id: r.id, data: () => r })) })), [ed, cd] = await Promise.all([snap(COLL.editors), snap(COLL.clips)]), clips = cd.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(c => c.status !== "excluded"), by = {};
      for (const c of clips) { const w = wfOf(c); if (w.assignee_id) { const k = by[w.assignee_id] = by[w.assignee_id] || { total: 0, by_status: {} }; k.total++; k.by_status[w.status] = (k.by_status[w.status] || 0) + 1; } }
      return { editors: ed.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(e => mayAccess(actor, e.owner_uid)).sort((a, b) => (a.created_at || 0) - (b.created_at || 0)).map(e => Object.assign(editorPublic(e), { clips: by[e.id] || { total: 0, by_status: {} } })), telegram: TGB.status(env), statuses: STATUSES.map(([id, label]) => ({ id, label })) };
    },
    async createEditor(req, actor) {
      const b = req.body || {}, nm = name(b.name, "Имя", 60), note = text(b.note, "Заметка", 300); if (limited("ed:" + actor.uid, 60, 3600000)) throw new HttpError(429, "TOO_MANY");
      const mine = (await col(COLL.editors).get()).docs.map(d => d.data()).filter(e => mayAccess(actor, e.owner_uid)); if (mine.length >= 50) throw new HttpError(400, "LIMIT", "Не более 50 монтажёров"); if (mine.some(e => String(e.name).toLowerCase() === nm.toLowerCase())) throw new HttpError(409, "DUPLICATE", "Монтажёр с таким именем уже есть");
      const id = newId("ed"), doc = { id, name: nm, note, active: true, telegram: null, link: null, owner_uid: actor.uid, created_at: now(), created_by: actor.email || actor.uid }; await col(COLL.editors).doc(id).set(doc); await event(actor, "editor.create", { note: nm }); return { editor: editorPublic(doc) };
    },
    async updateEditor(req, actor) {
      const e = await ownEditor(actor, req.params.id), b = req.body || {}, patch = {}; if (b.name !== undefined) patch.name = name(b.name, "Имя", 60); if (b.note !== undefined) patch.note = text(b.note, "Заметка", 300); if (b.active !== undefined) { if (typeof b.active !== "boolean") throw new HttpError(400, "INVALID", "active: true или false"); patch.active = b.active; }
      if (!Object.keys(patch).length) throw new HttpError(400, "INVALID", "Нечего сохранять"); await col(COLL.editors).doc(e.id).update(Object.assign(patch, { updated_at: now() })); await event(actor, "editor.update", { note: e.name }); return { editor: editorPublic(Object.assign({}, e, patch)) };
    },
    async deleteEditor(req, actor) {
      const e = await ownEditor(actor, req.params.id), force = req.query && req.query.force === "1", mine = (await col(COLL.clips).where("workflow.assignee_id", "==", e.id).get()).docs.filter(d => d.data().status !== "excluded");
      if (mine.length && !force) throw new HttpError(409, "HAS_CLIPS", "За монтажёром закреплено клипов: " + mine.length + ". Снимите назначение или удалите с подтверждением.", { count: mine.length });
      for (const d of mine) { const c = Object.assign({ id: d.id }, d.data()), w = wfOf(c); await col(COLL.clips).doc(c.id).update({ workflow: Object.assign({}, w, { assignee_id: null, rev: w.rev + 1, updated_at: now() }) }); await logEvent(actor, c, "assign", { note: "Монтажёр удалён, назначение снято", changes: [{ field: "assignee_id", label: "монтажёр", from: e.id, to: null }] }); }
      await col(COLL.editors).doc(e.id).delete(); await event(actor, "editor.delete", { note: e.name }); return { ok: true, unassigned: mine.length };
    },
    /* очередь заданий конкретного монтажёра: только его клипы */
    async editorQueue(req, actor) {
      const e = await ownEditor(actor, req.params.id), [cd, st, pd] = await Promise.all([col(COLL.clips).where("workflow.assignee_id", "==", e.id).get(), loadSettings(), col(COLL.projects).get()]), projects = new Map(pd.docs.map(d => [d.id, d.data()]));
      const rows = cd.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(c => c.status !== "excluded" && wfOf(c).assignee_id === e.id), edits = new Map();
      for (const c of rows) edits.set(c.id, await get(COLL.edits, c.id));
      return { editor: editorPublic(e), clips: rows.map(c => { const w = wfOf(c), p = projects.get(c.project_id) || {}; return { id: c.id, title: c.title || c.hook, project_title: p.title || p.filename || "", status: w.status, status_label: LABEL[w.status], task: w.task, comment: w.comment, render_state: renderState(c, edits.get(c.id), st), updated_at: w.updated_at || c.updated_at || c.created_at || null, delivered_at: ((c.deliveries || {})[e.id] || {}).at || null }; }).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)) };
    },
    /* ---- привязка Telegram: одноразовый код (30 минут), в базе только его хэш; идентификатор — числовой Telegram user id ---- */
    async createLink(req, actor) {
      const e = await ownEditor(actor, req.params.id); if (!TGB.enabled(env)) throw new HttpError(409, "TG_DISABLED", TGB.status(env).problem || "Интеграция Telegram выключена");
      if (limited("lnk:" + actor.uid, 20, 3600000)) throw new HttpError(429, "TOO_MANY"); const code = code8(), expires = now() + 30 * 60000; await col(COLL.editors).doc(e.id).update({ link: { hash: sha256(code), expires_at: expires, created_at: now() } });
      const u = TGB.username(env); await event(actor, "editor.link", { note: e.name }); return { code, expires_at: expires, bot_link: u ? "https://t.me/" + u + "?start=" + code : null, instructions: u ? "Отправьте монтажёру ссылку: он откроет бота и нажмёт Start." : "Попросите монтажёра открыть бота Video Studio и отправить ему: /start " + code };
    },
    async unlinkTelegram(req, actor) { const e = await ownEditor(actor, req.params.id); await col(COLL.editors).doc(e.id).update({ telegram: null, link: null }); await event(actor, "editor.unlink", { note: e.name }); return { ok: true }; },
    /* ---- «Импорт в Telegram»: себе, конкретному монтажёру или каждому по назначению. Права и назначение проверяются на сервере ---- */
    async telegramStatus(req, actor) { return Object.assign(TGB.status(env), { webhook_stats: Object.assign({}, tgStats), editors_linked: (await col(COLL.editors).get()).docs.filter(d => mayAccess(actor, d.data().owner_uid) && d.data().telegram && d.data().telegram.user_id).length }); },
    async dispatch(req, actor) {
      const b = req.body || {}, ids = b.clip_ids, tg = b.target || {}; if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(i => typeof i !== "string")) throw new HttpError(400, "INVALID", "clip_ids: от 1 до 100 клипов");
      if (!TGB.enabled(env)) throw new HttpError(409, "TG_DISABLED", (TGB.status(env).problem || "Интеграция Telegram выключена") + ". Остальные функции Video Studio работают без неё.");
      if (!["owner", "editor", "assignees"].includes(tg.type)) throw new HttpError(400, "INVALID", "target.type: owner, editor или assignees"); if (limited("tgd:" + actor.uid, 60, 3600000)) throw new HttpError(429, "TOO_MANY", "Слишком много отправок за час");
      let editor = null, ownerChat = ""; if (tg.type === "owner") { ownerChat = TGB.ownerChat(env); if (!ownerChat) throw new HttpError(409, "TG_NO_OWNER", "Не задан VIDEO_STUDIO_TELEGRAM_OWNER_CHAT_ID: некуда отправлять «себе»"); }
      if (tg.type === "editor") { editor = await ownEditor(actor, tg.editor_id); if (!editor.telegram || !editor.telegram.user_id) throw new HttpError(409, "EDITOR_NOT_LINKED", "Telegram монтажёра «" + editor.name + "» не привязан"); }
      const queued = [], skipped = [], editors = new Map(), bucket = Math.floor(now() / 60000);
      for (const id of [...new Set(ids)]) {
        let clip, project; try { ({ clip, project } = await ownClip(actor, id)); } catch (e) { skipped.push({ clip_id: id, reason: "NOT_FOUND", message: "Клип не найден" }); continue; }
        const r = clip.render, w = wfOf(clip); if (!r || !r.path) { skipped.push({ clip_id: id, reason: "NOT_RENDERED", message: "Видео ещё не собрано" }); continue; }
        let target = null;
        if (tg.type === "owner") target = { kind: "owner", key: "owner", chat: ownerChat };
        else if (tg.type === "editor") { if (w.assignee_id !== editor.id) { skipped.push({ clip_id: id, reason: "NOT_ASSIGNED", message: "Клип назначен не этому монтажёру" }); continue; } target = { kind: "editor", key: editor.id, chat: String(editor.telegram.user_id), editor_id: editor.id }; }
        else { if (!w.assignee_id) { skipped.push({ clip_id: id, reason: "NO_ASSIGNEE", message: "Монтажёр не назначен" }); continue; } if (!editors.has(w.assignee_id)) editors.set(w.assignee_id, await get(COLL.editors, w.assignee_id)); const ed = editors.get(w.assignee_id);
          if (!ed || ed.active === false) { skipped.push({ clip_id: id, reason: "EDITOR_GONE", message: "Монтажёр удалён или отключён" }); continue; } if (!ed.telegram || !ed.telegram.user_id) { skipped.push({ clip_id: id, reason: "EDITOR_NOT_LINKED", message: "Telegram монтажёра «" + ed.name + "» не привязан" }); continue; } target = { kind: "editor", key: ed.id, chat: String(ed.telegram.user_id), editor_id: ed.id }; }
        const { job, created } = await J.enqueue(db, now, { type: "tg_send", project_id: project.id, clip_id: clip.id, owner_uid: project.owner_uid, key: clip.id + "_" + target.key + "_" + r.hash + "_" + bucket, payload: { clip_id: clip.id, hash: r.hash, target: target.kind, editor_id: target.editor_id || null, chat_id: target.chat, delivery_key: target.key }, priority: 4 });
        queued.push({ clip_id: id, job_id: job.id, target: target.kind, created }); await logEvent(actor, clip, "send", { note: target.kind === "owner" ? "Отправка себе в Telegram" : "Отправка монтажёру в Telegram", editor_id: target.editor_id || null });
      }
      if (queued.length) kick(); await event(actor, "telegram.dispatch", { note: tg.type + ": " + queued.length }); if (!queued.length && skipped.length && skipped.every(s => s.reason === "NOT_ASSIGNED")) throw new HttpError(403, "CLIP_NOT_ASSIGNED", "Выбранные клипы не назначены этому монтажёру", { skipped });
      return { queued: queued.length, jobs: queued, skipped };
    }
  };
  /* ---- диагностика входящих сообщений: счётчики и безопасные записи в журнал (без токена, секретов, номеров и имён пользователей, без самого кода) ---- */
  const tgStats = { updates: 0, linked: 0, code_invalid: 0, code_expired: 0, tasks: 0, other: 0, ignored: 0, forbidden: 0, disabled: 0, last_update_at: null }, logAt = {};
  const tgLog = (key, msg, level = "log") => { const t = Date.now(); if (key) { if (t - (logAt[key] || 0) < 60000) return; logAt[key] = t; } if (log[level]) log[level]("video-studio telegram: " + msg); };
  /* публичный адрес сайта для webhook: VIDEO_STUDIO_PUBLIC_URL, затем VIDEO_STUDIO_ORIGIN (если https), затем Host запроса; только публичный https */
  const webhookUrl = req => {
    const pick = v => String(v || "").trim().replace(/\/+$/, ""), a = pick(env.VIDEO_STUDIO_PUBLIC_URL), b = pick(env.VIDEO_STUDIO_ORIGIN); let base = /^https:\/\//i.test(a) ? a : /^https:\/\//i.test(b) ? b : "";
    if (!base) { const h = String((req.headers || {})["x-forwarded-host"] || (req.headers || {}).host || "").split(",")[0].trim(); if (h) base = "https://" + h; }
    let u; try { u = new URL(base + "/api/video-studio/telegram/webhook"); } catch (e) { u = null; }
    if (!u || u.protocol !== "https:" || !u.hostname.includes(".") || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname)) throw new HttpError(400, "WEBHOOK_URL", "Telegram принимает только публичный https-адрес. Задайте в Render VIDEO_STUDIO_PUBLIC_URL=https://адрес-вашего-сайта и повторите.");
    return u.toString();
  };
  const HINTS = { not_registered: "Webhook не подключён: пока не нажата «Подключить webhook», бот не получает сообщения (в очереди Telegram они накапливаются).", wrong_url: "Webhook указывает на другой адрес. Нажмите «Подключить webhook», чтобы переключить на этот сайт.", error: "Telegram не смог доставить сообщения на сайт. Проверьте VIDEO_STUDIO_TELEGRAM_WEBHOOK_SECRET (после смены нажмите «Подключить webhook» ещё раз) и доступность сайта.", ok: "Webhook подключён и принимает сообщения." };
  const infoOf = (i, expected) => { i = i || {}; const url = String(i.url || ""), err = i.last_error_message ? String(i.last_error_message).slice(0, 200) : null, errAt = i.last_error_date ? Number(i.last_error_date) * 1000 : null, fresh = !!(err && errAt && Date.now() - errAt < 3600000), state = !url ? "not_registered" : expected && url !== expected ? "wrong_url" : fresh ? "error" : "ok";
    return { state, registered: !!url, url, expected_url: expected || null, url_matches: !!expected && url === expected, pending_update_count: Number(i.pending_update_count) || 0, last_error_message: err, last_error_at: errAt, max_connections: i.max_connections || null, hint: HINTS[state] }; };
  const needTg = () => { if (!TGB.enabled(env)) throw new HttpError(409, "TG_DISABLED", TGB.status(env).problem || "Интеграция Telegram выключена"); };
  const tgFail = e => new HttpError(502, (e && e.code) || "TG_ERROR", (e && e.message) || "Ошибка Telegram");
  H.connectWebhook = async (req, actor) => {
    needTg(); const sec = TGB.secret(env); if (!sec || sec.length < 16) throw new HttpError(409, "TG_NO_SECRET", "Не задан VIDEO_STUDIO_TELEGRAM_WEBHOOK_SECRET (случайная строка не короче 16 символов). Задайте его в Render, перезапустите сервис и повторите.");
    if (limited("wh:" + actor.uid, 10, 3600000)) throw new HttpError(429, "TOO_MANY"); const url = webhookUrl(req), drop = !!(req.body && req.body.drop_pending_updates === true);
    try { await TG.setWebhook(env, { url, secret_token: sec, allowed_updates: ["message"], drop_pending_updates: drop, max_connections: 3 }); } catch (e) { tgLog(null, "регистрация webhook не удалась: " + ((e && e.code) || "ошибка"), "error"); throw tgFail(e); }
    let raw; try { raw = await TG.getWebhookInfo(env); } catch (e) { throw tgFail(e); }
    await event(actor, "telegram.webhook_set", { note: drop ? "очередь сообщений сброшена" : "очередь сообщений сохранена" }); tgLog(null, "webhook зарегистрирован; очередь Telegram " + (drop ? "сброшена" : "сохранена"));
    return { ok: true, dropped_pending: drop, webhook: infoOf(raw, url) };
  };
  H.webhookStatus = async (req, actor) => { needTg(); let url = null; try { url = webhookUrl(req); } catch (e) { /* адрес не определить — покажем только то, что знает Telegram */ } let raw; try { raw = await TG.getWebhookInfo(env); } catch (e) { throw tgFail(e); } return { webhook: infoOf(raw, url), stats: Object.assign({}, tgStats) }; };
  /* Вебхук бота Video Studio (публичный адрес, защищён секретом из заголовка Telegram): привязка монтажёра по коду и команда /tasks с ЕГО клипами */
  async function webhook(req, res) {
    try {
      if (!TGB.enabled(env)) { tgStats.disabled++; tgLog("disabled", "update отклонён: интеграция выключена (нужны VIDEO_STUDIO_TELEGRAM_ENABLED=1 и токен)", "warn"); return res.status(404).json({ error: "NOT_FOUND" }); }
      if (!TGB.secretOk(env, (req.headers || {})["x-telegram-bot-api-secret-token"])) { tgStats.forbidden++; tgLog("forbidden", "update отклонён: неверный или отсутствующий секрет вебхука (проверьте VIDEO_STUDIO_TELEGRAM_WEBHOOK_SECRET и снова нажмите «Подключить webhook»)", "warn"); return res.status(403).json({ error: "FORBIDDEN" }); }
      tgStats.updates++; tgStats.last_update_at = now();
      const m = req.body && req.body.message; if (!m || !m.from || !m.chat || m.chat.type !== "private" || typeof m.text !== "string") { tgStats.ignored++; tgLog("ignored", "update получен: тип=не_личное_текстовое_сообщение (игнорируется)"); return res.status(200).json({ ok: true }); }
      const uid = String(m.from.id), t = Date.now(); rate[uid] = (rate[uid] || []).filter(x => t - x < 60000); if (rate[uid].length >= 20) { tgLog("rate", "update отброшен: частота (больше 20 в минуту от одного пользователя)", "warn"); return res.status(200).json({ ok: true }); } rate[uid].push(t);
      const say = txt => TG.sendMessage(env, String(m.chat.id), txt).catch(() => { tgLog("say", "ответ боту не отправлен (Telegram отклонил sendMessage)", "warn"); }), cmd = /^\/(\w+)(?:@\w+)?(?:\s+(\S+))?/.exec(m.text.trim());
      if (cmd && cmd[1] === "start" && cmd[2]) {
        const hash = sha256(String(cmd[2]).toUpperCase().replace(/[^A-Z0-9]/g, "")), found = (await col(COLL.editors).where("link.hash", "==", hash).get()).docs;
        if (!found.length) { tgStats.code_invalid++; tgLog(null, "update получен: тип=start, результат=код_не_найден_или_уже_использован"); await say("Код не подходит или истёк. Попросите администратора создать новую ссылку."); }
        else if ((found[0].data().link || {}).expires_at < now()) { tgStats.code_expired++; tgLog(null, "update получен: тип=start, результат=код_истёк"); await say("Код не подходит или истёк. Попросите администратора создать новую ссылку."); }
        else { const e = Object.assign({ id: found[0].id }, found[0].data()); await col(COLL.editors).doc(e.id).update({ telegram: { user_id: uid, name: trunc(m.from.first_name || "", 60), linked_at: now() }, link: null }); RC.invalidate(db, "data"); tgStats.linked++; tgLog(null, "update получен: тип=start, результат=привязан"); await say("Готово: вы привязаны как «" + e.name + "». Клипы и задания будут приходить сюда. Команда /tasks покажет ваши задания."); await col(COLL.clipEvents).doc(newId("ce")).set({ clip_id: null, owner_uid: e.owner_uid, at: now(), by: "telegram", kind: "editor_linked", note: "Монтажёр «" + e.name + "» привязал Telegram" }).catch(() => {}); }
      } else if (cmd && cmd[1] === "tasks") {
        tgStats.tasks++; tgLog(null, "update получен: тип=tasks");
        const eds = (await col(COLL.editors).where("telegram.user_id", "==", uid).get()).docs;
        if (!eds.length) await say("Ваш Telegram не привязан. Откройте ссылку привязки от администратора."); else { const e = eds[0].id, rows = (await col(COLL.clips).where("workflow.assignee_id", "==", e).get()).docs.map(d => d.data()).filter(c => c.status !== "excluded"); await say(rows.length ? "Ваши задания (" + rows.length + "):\n" + rows.slice(0, 20).map((c, i) => (i + 1) + ". " + trunc(c.title || c.hook, 60) + " — " + (LABEL[wfOf(c).status] || "")).join("\n") : "Заданий сейчас нет."); }
      } else { tgStats.other++; tgLog(null, "update получен: тип=" + (cmd && cmd[1] === "start" ? "start_без_кода" : cmd ? "другая_команда" : "текст")); await say("Это бот монтажёров Video Studio. Чтобы привязаться, откройте ссылку, которую прислал администратор. /tasks — ваши задания."); }
      return res.status(200).json({ ok: true });
    } catch (e) { log.error && log.error("video-studio telegram: ошибка обработки update:", e && e.message); return res.status(200).json({ ok: true }); }       // Telegram не должен бесконечно повторять запрос
  }
  const routes = [["GET", "/clips", "listAllClips", null, false], ["PUT", "/clips/:id/workflow", "putWorkflow", null, true], ["POST", "/clips/assign", "assignClips", null, true], ["GET", "/clips/:id/history", "clipHistory", null, false], ["GET", "/activity", "activity", null, false],
    ["GET", "/editors", "listEditors", null, false], ["POST", "/editors", "createEditor", null, true], ["PUT", "/editors/:id", "updateEditor", null, true], ["DELETE", "/editors/:id", "deleteEditor", null, true], ["GET", "/editors/:id/queue", "editorQueue", null, false], ["POST", "/editors/:id/link", "createLink", null, true], ["DELETE", "/editors/:id/telegram", "unlinkTelegram", null, true],
    ["GET", "/telegram/status", "telegramStatus", null, false], ["POST", "/telegram/dispatch", "dispatch", null, true], ["POST", "/telegram/webhook/connect", "connectWebhook", null, true], ["GET", "/telegram/webhook/status", "webhookStatus", null, false]];
  return { handlers: H, routes, webhook, logEvent };
}
module.exports = { createWorkflow, STATUSES, LABEL, wfOf };
