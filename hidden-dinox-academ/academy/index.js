"use strict";
const { registerBookRoutes } = require("./books");
const { registerReferralRoutes, autoReferral } = require("./referral");
const { setLegacyCutoff } = require("./access");
async function ensureAccessRuleCutoff(db) {
  const ref = db.collection("system").doc("access_rule_v50");
  return db.runTransaction(async tx => { const d = await tx.get(ref); if (d.exists) return d.data().since; const since = Date.now(); tx.create(ref, { since, rule: "cumulative_usd_50", legacy_rule: "ftd_usd_40" }); return since; });
}
const { registerPartnerLinkRoutes } = require("./partner-links");
/* HIDDEN DINOX ACADEMY — подключение к существующему серверу AI BOOST.
   Вызывается из server.js одной строкой; старые маршруты не меняются. */
const path = require("path");
const { mountAcademyApi } = require("./api");
const { mountAdminApi } = require("./admin-api");
const { registerLearnRoutes } = require("./learn-api");
const { firebaseStorage } = require("./storage");
const { registerTelegramRoutes } = require("./telegram");
const { createAcademyPostback } = require("./postback");
const { testDepositConfig, createTestDeposit } = require("./test-deposit");
const { resolveTestMode } = require("./test-mode");

function attachAcademy({ app, express, admin, db, env = process.env, log = console, publicDir }) {
  // IP отправителя за прокси Render: включается явно (TRUST_PROXY=1), нужен только для POSTBACK_ALLOWED_IPS
  // Число = сколько прокси перед сервисом доверенные (на Render проверяется в Диагностике → request_ip.xff_chain).
  // true/false не принимаются: «доверять всем» позволило бы клиенту подставить свой IP. Ошибочное значение не роняет сервер.
  if (env.TRUST_PROXY) {
    const tpv = String(env.TRUST_PROXY).trim();
    if (/^\d+$/.test(tpv)) app.set("trust proxy", Number(tpv));
    else if (/^(true|false)$/i.test(tpv)) log.warn && log.warn("⚠️ TRUST_PROXY: укажите число доверенных прокси (обычно 1). Значение true/false не применено");
    else { try { app.set("trust proxy", tpv); } catch (e) { log.warn && log.warn("⚠️ TRUST_PROXY: неверное значение, не применено"); } }
  }
  // 1) API академии. Без Firebase — честный ответ 503, доступ закрыт.
  const verifyIdToken = db && admin && admin.auth ? t => admin.auth().verifyIdToken(t) : null;
  // Хранилище файлов: Firebase Storage проекта (бакет из Web Config; можно переопределить FIREBASE_STORAGE_BUCKET)
  const storage = db && admin && admin.storage ? firebaseStorage(admin, env.FIREBASE_STORAGE_BUCKET || "ai-boost-10540.firebasestorage.app") : null;
  const authAdmin = db && admin && admin.auth ? admin.auth() : null;
  // Video Studio (закрытый раздел для администраторов): выключен по умолчанию (VIDEO_STUDIO_ENABLED=1 включает); сбой модуля не должен влиять на Academy
  if (String(env.VIDEO_STUDIO_ENABLED || "") === "1") { try { require("../video-studio").attachVideoStudio(app, express, { db, verifyIdToken, admin, env, log }); } catch (e) { log.error && log.error("⚠️ Video Studio не запущена:", e && e.message); } }
  // 1а) Обучение для учеников (/api/learn/*, /api/announcements, /media/:id) — внутри роутера /api
  // Автоматическое реферальное начисление: пересчёт приглашённого после подтверждённых событий
  // (postback депозита/регистрации, привязка Trader ID). Идемпотентно: ID записи журнала детерминирован.
  // Переход на правило «сумма депозитов от $50»: момент перехода записывается один раз; ученики с первым депозитом
  // от $40, подтверждённым ДО него, сохраняют доступ (никого не отключаем после деплоя)
  if (db) ensureAccessRuleCutoff(db).then(ms => { setLegacyCutoff(ms); log.log && log.log("ℹ️ доступ: сумма депозитов от $50; прежнее правило действует для депозитов до " + new Date(ms).toISOString()); })
    .catch(e => log.error && log.error("access rule cutoff:", e && (e.code || e.message)));
  const auto = db ? autoReferral({ db, env, log }) : null;
  if (auto) { const c = auto.CFG; log.log && log.log(`ℹ️ referral: учёт ${c.tracking ? "включён" : "выключен"}, начисления ${c.rewards ? c.mode : "выключены"}, вывод ${c.payouts ? "включён" : "выключен"}`); if (c.warning) log.warn && log.warn("⚠️ referral: " + c.warning); }
  const onAccessChange = auto ? auto.onAccessChange : null;
  // 0) Восстановление пароля письмом Hidden Dinox Academy (ссылку создаёт Firebase Admin SDK) — до роутера /api
  const forgotPassword = require("./forgot-password").registerForgotPassword(app, { authAdmin, env, log });
  if (db) require("./daily-cron").registerDailyCron(app, { db, env, log });   // Daily Tests: запуск по расписанию
  mountAcademyApi(app, express, { db, verifyIdToken, log, onAccessChange }, (router, academyApi) => {
    registerLearnRoutes(app, router, { db, academyApi, storage, log });
    registerTelegramRoutes(router, { db, academyApi, env });
    registerBookRoutes(router, { db, academyApi, root: path.join(publicDir, ".."), log });
    registerReferralRoutes(router, { db, academyApi, env, log });
    registerPartnerLinkRoutes(router, { db, academyApi, env, log });
  });
  // 1б) Админ-панель: API и страницы /admin/ (права проверяет сервер)
  mountAdminApi(app, express, { db, verifyIdToken, storage, authAdmin, log });
  app.use("/admin", express.static(path.join(publicDir, "admin"), {
    index: "index.html",
    setHeaders(res, p) { // HTML/JS/CSS — всегда с проверкой (ETag → 304): иначе после обновления браузер мог взять старый файл переводов
      // и показать ключи вроде ptNext. Изображения, шрифты и прочее — кэш на час.
      res.setHeader("Cache-Control", /\.(html|js|mjs|css)$/.test(p) ? "no-cache" : "public, max-age=3600"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Referrer-Policy", "same-origin"); }
  }));

  // 2) Статика академии: HTML без кеша, остальное — короткий кеш (адреса файлов версионированы)
  // Страница входа по «/» (старые адреса /academy/index.html → «/»); до статики /academy
  require("./login-route").registerLoginRoutes(app, publicDir);
  app.use("/academy", express.static(path.join(publicDir, "academy"), {
    index: "index.html",
    setHeaders(res, p) {
      // HTML/JS/CSS — всегда с проверкой (ETag → 304): иначе после обновления браузер мог взять старый файл переводов
      // и показать ключи вроде ptNext. Изображения, шрифты и прочее — кэш на час.
      res.setHeader("Cache-Control", /\.(html|js|mjs|css)$/.test(p) ? "no-cache" : "public, max-age=3600");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "same-origin");
    }
  }));

  // 3) Обработчик postback для академии (вызывается из существующего /postback)
  const postback = createAcademyPostback({ db, env, log });
  if (auto) auto.wrapPostback(postback);   // после успешного postback — пересчёт приглашённого (логика postback не меняется)
  const pc = postback.config;
  if (!pc.secretConfigured) log.warn && log.warn("⚠️ academy: POCKET_POSTBACK_SECRET " + (pc.secretTooShort ? "короче 24 символов" : "не задан") + " — /postback отвечает 503, подтверждения не записываются");
  else log.log && log.log("✅ academy: приём postback включён" + (pc.defaultCurrency ? ", валюта по умолчанию " + pc.defaultCurrency : ", валюта по умолчанию НЕ задана"));
  // 4) ТЕСТОВЫЙ депозит по Trader ID — только в HD_TEST_MODE (эмуляторы). В production маршрута нет.
  const tcfg = testDepositConfig({ testMode: resolveTestMode(env), env });
  if (tcfg.enabled) {
    const testDeposit = createTestDeposit({ db, secret: tcfg.secret, log });
    app.get("/test/deposit", async (req, res) => {
      let r;
      try { r = await testDeposit(req.query || {}); }
      catch (e) { log.error && log.error("test deposit error:", e && (e.code || e.message)); r = { http: 503, status: "db_error", message: "Ошибка Firebase (эмулятор)" }; }
      res.status(r.http).json({ ok: r.http === 200, test: true, status: r.status, message: r.message });
    });
    log.warn && log.warn("🧪 ТЕСТОВЫЙ маршрут /test/deposit включён (только эмулятор Firebase)");
  } else if (env.TEST_POSTBACK_SECRET) {
    log.warn && log.warn("ℹ️ /test/deposit не включён: " + tcfg.reason);
  }
  return { postback };
}

/* Закрывает публичную раздачу файлов ботов из public/bot (сами файлы не трогаем: require читает их с диска).
   Путь декодируется и нормализуется так же, как это делает раздача статики, чтобы /%62ot/… или /x/../bot/… не обходили запрет. */
const BLOCKED_PREFIXES = ["/bot"];
function isBlockedPath(rawPath) {
  let p;
  try { p = decodeURIComponent(rawPath); } catch (e) { return true; }
  p = path.posix.normalize(p.replace(/\\/g, "/")).toLowerCase();
  return BLOCKED_PREFIXES.some(b => p === b || p.startsWith(b + "/"));
}
function blockPrivateStatic(app) {
  app.use((req, res, next) => (isBlockedPath(req.path) ? res.status(404).send("Not found") : next()));
}

module.exports = { attachAcademy, blockPrivateStatic, isBlockedPath };
