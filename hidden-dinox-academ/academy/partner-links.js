"use strict";
/* Партнёрские ссылки Pocket Partners (стримеры и партнёры).
   - Администратор создаёт запись: имя, уникальный код, ПОЛНАЯ ссылка Pocket Partners (все параметры сохраняются как есть).
   - Ссылка Academy: /academy/?via=<код>. Код запоминается до регистрации и после входа закрепляется на сервере ОДИН раз,
     только до привязки Trader ID — сменить владельца изменением адреса нельзя.
   - Кнопка брокера открывает ссылку этого партнёра (+ click_id академии, как и раньше); без партнёра — основная ссылка.
   - Разрешены только домены Pocket Partners (POCKET_LINK_HOSTS) — произвольный редирект невозможен.
   - Клик по кнопке НЕ является регистрацией или FTD: эти события учитываются только по postback. */
const CODE_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const ATTACH_WINDOW_MS = 7 * 86400000;
class LinkError extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }
const hostsOf = env => String(env.POCKET_LINK_HOSTS || "u3.shortink.io").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

function validatePocketUrl(raw, env) {
  const s = String(raw || "").trim();
  if (!s || s.length > 1500) throw new LinkError(400, "INVALID_URL", "Вставьте полную ссылку Pocket Partners");
  let u; try { u = new URL(s); } catch (e) { throw new LinkError(400, "INVALID_URL", "Некорректная ссылка"); }
  if (u.protocol !== "https:" || u.username || u.password) throw new LinkError(400, "INVALID_URL", "Нужна https-ссылка");
  if (!hostsOf(env).includes(u.hostname.toLowerCase())) throw new LinkError(400, "HOST_NOT_ALLOWED", "Разрешены только ссылки Pocket Partners: " + hostsOf(env).join(", "));
  return s;                                                  // исходная строка без изменений: UTM и все параметры сохраняются
}

function createPartnerLinks({ db, env = process.env, now = () => Date.now() }) {
  const col = n => db.collection(n);
  async function list() {
    const links = (await col("partner_links").get()).docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const users = (await col("users").get()).docs.map(d => d.data());
    return links.map(l => ({ ...l, users_count: users.filter(u => u.via && u.via.code === l.code).length }));   // реальное число привязанных
  }
  async function create({ code, name, pocket_url }, actor_uid) {
    code = String(code || "").trim().toLowerCase(); name = String(name || "").trim().slice(0, 80);
    if (!CODE_RE.test(code)) throw new LinkError(400, "INVALID_CODE", "Код: латиница, цифры, «-» и «_», 3–32 символа");
    if (!name) throw new LinkError(400, "NAME_REQUIRED", "Укажите имя партнёра");
    const url = validatePocketUrl(pocket_url, env), t = now();
    await db.runTransaction(async tx => {
      const ref = col("partner_links").doc(code); if ((await tx.get(ref)).exists) throw new LinkError(409, "CODE_TAKEN", "Такой код уже есть");
      tx.create(ref, { code, name, pocket_url: url, status: "active", created_at: t, updated_at: t, created_by: actor_uid });
    });
    return { code };
  }
  async function update(code, { name, pocket_url, status }, actor_uid) {
    const ref = col("partner_links").doc(String(code)); const d = await ref.get(); if (!d.exists) throw new LinkError(404, "NOT_FOUND");
    const patch = { updated_at: now(), updated_by: actor_uid };
    if (name !== undefined) { patch.name = String(name).trim().slice(0, 80); if (!patch.name) throw new LinkError(400, "NAME_REQUIRED"); }
    if (pocket_url !== undefined) patch.pocket_url = validatePocketUrl(pocket_url, env);
    if (status !== undefined) { if (!["active", "disabled"].includes(status)) throw new LinkError(400, "INVALID_STATUS"); patch.status = status; }
    await ref.set(patch, { merge: true });
    return { ok: true };
  }
  /* Закрепление источника за пользователем: один раз, новый аккаунт, до привязки Trader ID, только активная ссылка */
  async function attach(uid, rawCode) {
    const code = String(rawCode || "").trim().toLowerCase(); if (!CODE_RE.test(code)) throw new LinkError(400, "INVALID_CODE");
    return db.runTransaction(async tx => {
      const [l, u] = await Promise.all([tx.get(col("partner_links").doc(code)), tx.get(col("users").doc(uid))]);
      const user = u.exists ? u.data() : null;
      if (!user) throw new LinkError(409, "PROFILE_MISSING");
      if (user.via) return { ok: true, already: true, code: user.via.code };
      if (!l.exists || l.data().status !== "active") throw new LinkError(404, "INVALID_CODE");
      if (user.trader_id) throw new LinkError(409, "ALREADY_REGISTERED_AT_BROKER");
      if (!(user.created_at && now() - user.created_at <= ATTACH_WINDOW_MS)) throw new LinkError(409, "ACCOUNT_TOO_OLD");
      tx.set(col("users").doc(uid), { via: { code, at: now() } }, { merge: true });
      return { ok: true, code };
    });
  }
  /* Ссылка для кнопки брокера: партнёра, если он закреплён и активен; иначе null — клиент берёт основную */
  async function brokerLink(user) {
    if (!user || !user.via || !user.via.code) return { url: null, source: "default" };
    const l = await col("partner_links").doc(user.via.code).get();
    if (!l.exists || l.data().status !== "active") return { url: null, source: "default" };
    return { url: l.data().pocket_url, source: "partner", code: user.via.code };
  }
  return { list, create, update, attach, brokerLink };
}

function registerPartnerLinkRoutes(router, { db, academyApi, env = process.env, log = console }) {
  const pl = createPartnerLinks({ db, env });
  const h = fn => async (req, res) => {
    try { const auth = await academyApi.authenticate(req); res.set("Cache-Control", "no-store"); res.json(await fn(req, auth)); }
    catch (e) { const s = e && e.status ? e.status : (e && (e.code === "UNAUTHENTICATED" ? 401 : e.code === "ACCOUNT_BLOCKED" ? 403 : 0)); if (s) return res.status(s).json({ error: e.code }); log.error && log.error("partner link error:", e && (e.code || e.message)); res.status(503).json({ error: "UNAVAILABLE" }); }
  };
  router.post("/via/attach", h(async (req, auth) => pl.attach(auth.uid, req.body && req.body.code)));
  router.get("/broker-link", h(async (req, auth) => pl.brokerLink(auth.user)));
}

function partnerLinksAdmin({ db, env = process.env, now, HttpError, audit }) {
  const pl = createPartnerLinks({ db, env, now });
  const wrapErr = fn => async (req, actor) => { try { return await fn(req, actor); } catch (e) { if (e instanceof LinkError) throw new HttpError(e.status, e.code, e.message); throw e; } };
  return {
    handlers: {
      partnerLinks: wrapErr(async () => ({ links: await pl.list(), allowed_hosts: hostsOf(env) })),
      createPartnerLink: wrapErr(async (req, actor) => { const r = await pl.create(req.body || {}, actor.uid); await audit(actor, "partner_link.create", "partner_link", r.code, { name: String((req.body || {}).name || "").slice(0, 80) }); return r; }),
      updatePartnerLink: wrapErr(async (req, actor) => { const r = await pl.update(String(req.params.code), req.body || {}, actor.uid); await audit(actor, "partner_link.update", "partner_link", req.params.code, { status: (req.body || {}).status || null }); return r; })
    },
    routes: [["GET", "/partner-links", "partnerLinks", "links.manage"], ["POST", "/partner-links", "createPartnerLink", "links.manage", true], ["PUT", "/partner-links/:code", "updatePartnerLink", "links.manage", true]]
  };
}

module.exports = { createPartnerLinks, registerPartnerLinkRoutes, partnerLinksAdmin, validatePocketUrl, CODE_RE };
