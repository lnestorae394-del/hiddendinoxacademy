"use strict";
/* Пользователи и роли самостоятельной Video Studio: профиль при первом входе, безопасное назначение владельца, управление ролями.
   Профили создаёт ТОЛЬКО сервер (правила Firestore запрещают клиенту любые записи). Новый пользователь получает роль user (доступа к студии нет). */
const crypto = require("crypto"), Roles = require("./roles"), { COLL } = require("./constants"), USERS = "users", OWNER_MARKER = "owner";
function createAccounts(x) {
  const { db, now, env, HttpError, col, event, limited, log = console } = x, ref = uid => col(USERS).doc(uid);
  const ownerEnv = () => String(env.VIDEO_STUDIO_OWNER_UID || "").split(/[,\s]+/).filter(u => /^[A-Za-z0-9_-]{6,128}$/.test(u));
  const pub = (id, u) => ({ uid: id, email: u.email || null, role: Roles.normalize(u.role), blocked: u.blocked === true, created_at: u.created_at || null, last_login_at: u.last_login_at || null });
  const sha = s => crypto.createHash("sha256").update(String(s)).digest();
  async function ensureProfile(actor) {
    const t = now(), isEnvOwner = ownerEnv().includes(actor.uid);
    const d = await db.runTransaction(async tx => {
      const r = ref(actor.uid), s = await tx.get(r), email = actor.email || null;
      if (!s.exists) { const n = { uid: actor.uid, email, email_lower: email ? email.toLowerCase() : null, role: isEnvOwner ? "owner" : "user", blocked: false, created_at: t, last_login_at: t, source: "video-studio" }; tx.create(r, n); return n; }
      const u = s.data(), patch = {}; if (isEnvOwner && Roles.normalize(u.role) !== "owner") patch.role = "owner"; if (email && u.email !== email) { patch.email = email; patch.email_lower = email.toLowerCase(); } if (!u.last_login_at || t - u.last_login_at > 600000) patch.last_login_at = t;
      if (Object.keys(patch).length) tx.update(r, patch); return Object.assign({}, u, patch);
    });
    return pub(actor.uid, d);
  }
  const setupEnabled = () => String(env.VIDEO_STUDIO_SETUP_TOKEN || "").length >= 24;
  const ownerExists = async () => { if (ownerEnv().length) return true; if ((await col(COLL.settings).doc(OWNER_MARKER).get()).exists) return true; return !(await col(USERS).where("role", "==", "owner").limit(1).get()).empty; };
  const owners = async () => (await col(USERS).where("role", "==", "owner").limit(5).get()).docs.map(d => d.id);
  const H = {
    async accountSession(req, actor) { const profile = await ensureProfile(actor); const a = Roles.RANK[profile.role] >= Roles.RANK.admin; return { profile, studio_access: a && !profile.blocked, owner_setup_available: !a && setupEnabled() && !(await ownerExists()) }; },
    async claimOwner(req, actor) {
      if (!setupEnabled()) throw new HttpError(404, "SETUP_DISABLED", "Первичная настройка владельца не включена на сервере");
      if (limited("claim:" + actor.uid, 5, 600000) || limited("claim:ip:" + (req.ip || "-"), 20, 600000)) throw new HttpError(429, "TOO_MANY");
      if (!crypto.timingSafeEqual(sha(req.body && req.body.token || ""), sha(env.VIDEO_STUDIO_SETUP_TOKEN))) { event(actor, "owner.claim_failed"); throw new HttpError(403, "BAD_TOKEN", "Неверный код настройки"); }
      if (await ownerExists()) throw new HttpError(409, "OWNER_EXISTS", "Владелец уже назначен");
      await ensureProfile(actor);
      await db.runTransaction(async tx => { const m = col(COLL.settings).doc(OWNER_MARKER), ms = await tx.get(m); if (ms.exists) throw new HttpError(409, "OWNER_EXISTS", "Владелец уже назначен"); tx.create(m, { uid: actor.uid, claimed_at: now() }); tx.update(ref(actor.uid), { role: "owner", role_changed_at: now(), role_changed_by: actor.uid }); });
      event(actor, "owner.claimed"); return { ok: true, role: "owner" };
    },
    async listUsers(req, actor) { const s = await col(USERS).orderBy("created_at", "desc").limit(200).get(); return { users: s.docs.map(d => pub(d.id, d.data())), me: actor.uid, can_grant_admin: actor.role === "owner" }; },
    async setUserRole(req, actor) { return change(req, actor, "role"); },
    async setUserBlocked(req, actor) { return change(req, actor, "blocked"); }
  };
  async function change(req, actor, kind) {
    const uid = String(req.params.uid || ""), body = req.body || {}; if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new HttpError(400, "BAD_UID");
    if (uid === actor.uid) throw new HttpError(403, "SELF_CHANGE", "Нельзя менять собственную роль или блокировку");
    if (ownerEnv().includes(uid)) throw new HttpError(403, "PROTECTED_OWNER", "Владелец, заданный в настройках сервера, защищён от изменений");
    const s = await ref(uid).get(); if (!s.exists) throw new HttpError(404, "NOT_FOUND", "Пользователь не найден"); const cur = Roles.normalize(s.data().role), me = Roles.RANK[actor.role];
    if (me < Roles.RANK.admin) throw new HttpError(403, "FORBIDDEN");
    if (me === Roles.RANK.admin && Roles.RANK[cur] >= Roles.RANK.admin) throw new HttpError(403, "FORBIDDEN_ROLE", "Администратор не может менять администраторов и владельца");
    const patch = { updated_by: actor.uid, updated_at: now() }; let from, to;
    if (kind === "role") { to = String(body.role || ""); if (!Roles.ROLES.includes(to)) throw new HttpError(400, "BAD_ROLE", "Допустимые роли: " + Roles.ROLES.join(", ")); if (me === Roles.RANK.admin && Roles.RANK[to] >= Roles.RANK.admin) throw new HttpError(403, "FORBIDDEN_ROLE", "Администратор может назначать только роли user и editor"); from = cur; patch.role = to; patch.role_changed_at = now(); patch.role_changed_by = actor.uid; }
    else { if (typeof body.blocked !== "boolean") throw new HttpError(400, "BAD_REQUEST", "Ожидается blocked: true/false"); from = s.data().blocked === true; to = body.blocked; patch.blocked = to; }
    if (cur === "owner" && (kind === "role" ? to !== "owner" : to === true)) { const o = await owners(); if (o.filter(i => i !== uid).length === 0) throw new HttpError(409, "LAST_OWNER", "Нельзя лишить сайт последнего владельца"); }
    await ref(uid).update(patch); event(actor, kind === "role" ? "user.role" : "user.blocked", { target: uid, from, to });
    return { user: pub(uid, Object.assign({}, s.data(), patch)) };
  }
  const routes = [["POST", "/account/session", "accountSession", "any", true], ["POST", "/account/claim-owner", "claimOwner", "any", true], ["GET", "/users", "listUsers", "admin", false], ["PUT", "/users/:uid/role", "setUserRole", "admin", true], ["PUT", "/users/:uid/blocked", "setUserBlocked", "admin", true]];
  return { handlers: H, routes, ensureProfile, setupEnabled, ownerExists };
}
module.exports = { createAccounts, USERS, OWNER_MARKER };
