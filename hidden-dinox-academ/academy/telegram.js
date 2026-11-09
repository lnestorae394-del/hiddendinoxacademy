"use strict";
/* Telegram Mini App: проверка initData по официальному алгоритму
   (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
   secret = HMAC_SHA256(key="WebAppData", data=bot_token); hash = hex(HMAC_SHA256(key=secret, data=data_check_string)),
   где data_check_string — все поля кроме hash, отсортированные по ключу, в виде "key=value", через \n.
   Неподписанные или устаревшие данные не принимаются. Привязка к аккаунту — только для вошедшего пользователя. */
const crypto = require("crypto");

function verifyInitData(initData, botToken, { maxAgeSec = 86400, now = () => Date.now() } = {}) {
  if (!botToken) return { ok: false, error: "NOT_CONFIGURED" };
  if (typeof initData !== "string" || initData.length > 4096) return { ok: false, error: "INVALID" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return { ok: false, error: "INVALID" };
  const pairs = []; for (const [k, v] of params) if (k !== "hash") pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return { ok: false, error: "BAD_SIGNATURE" };
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || now() / 1000 - authDate > maxAgeSec) return { ok: false, error: "EXPIRED" };
  let user = null; try { user = JSON.parse(params.get("user") || "null"); } catch (e) {}
  if (!user || !Number.isSafeInteger(user.id)) return { ok: false, error: "NO_USER" };
  return { ok: true, user: { id: user.id, username: user.username || null, name: [user.first_name, user.last_name].filter(Boolean).join(" ").slice(0, 120) || null, photo_url: typeof user.photo_url === "string" && /^https:\/\//.test(user.photo_url) ? user.photo_url : null } };
}

/* POST /api/telegram/link { init_data } — привязка Telegram к ВОШЕДШЕМУ аккаунту академии.
   Один Telegram ID — один аккаунт (telegram_links/{tgId}); автоматического объединения нет. */
function registerTelegramRoutes(router, { db, academyApi, env = process.env, now = () => Date.now() }) {
  router.post("/telegram/link", async (req, res) => {
    try {
      const auth = await academyApi.authenticate(req);
      const v = verifyInitData(req.body && req.body.init_data, env.TELEGRAM_BOT_TOKEN, { now });
      if (!v.ok) return res.status(v.error === "NOT_CONFIGURED" ? 503 : 400).json({ error: v.error });
      const linkRef = db.collection("telegram_links").doc(String(v.user.id)), userRef = db.collection("users").doc(auth.uid);
      const r = await db.runTransaction(async tx => {
        const l = await tx.get(linkRef);
        if (l.exists && l.data().uid !== auth.uid) return { conflict: true };
        tx.set(linkRef, { uid: auth.uid, linked_at: now() });
        tx.set(userRef, { telegram: { ...v.user, linked_at: now() } }, { merge: true });
        return { ok: true };
      });
      if (r.conflict) return res.status(409).json({ error: "TELEGRAM_LINKED_TO_OTHER", message: "Этот Telegram уже привязан к другому аккаунту академии" });
      res.status(200).json({ ok: true, telegram: { id: v.user.id, username: v.user.username, name: v.user.name, photo_url: v.user.photo_url } });
    } catch (e) {
      const code = e && e.code; res.status(code === "UNAUTHENTICATED" ? 401 : code === "ACCOUNT_BLOCKED" ? 403 : 503).json({ error: code || "UNAVAILABLE" });
    }
  });
}
module.exports = { verifyInitData, registerTelegramRoutes };
