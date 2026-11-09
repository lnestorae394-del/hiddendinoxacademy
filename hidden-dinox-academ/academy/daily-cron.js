"use strict";
/* POST /internal/daily/run — подготовка наборов Daily Tests (сегодня и завтра) и пополнение банка при низком запасе по расписанию (GitHub Actions).
   Защита: заголовок X-Cron-Secret = DAILY_CRON_SECRET (≥ 24 символов), сравнение за постоянное время.
   Без переменной маршрут выключен (503). Запуск идемпотентен: повтор ничего не дублирует. */
const crypto = require("crypto");
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function registerDailyCron(app, { db, env = process.env, log = console, now = () => Date.now(), aiFetch = null }) {
  const D = require("./daily-tests").createDailyTests({ db, now, log });
  const GEN = require("./daily-generator").createGenerator({ db, env, now, log, fetchImpl: aiFetch || globalThis.fetch });   // пополнение банка при низком запасе
  let last = 0;
  app.post("/internal/daily/run", async (req, res) => {
    res.set && res.set("Cache-Control", "no-store");
    const secret = String(env.DAILY_CRON_SECRET || "");
    if (secret.length < 24) return res.status(503).json({ error: "CRON_NOT_CONFIGURED" });
    if (!same(req.get ? req.get("x-cron-secret") || "" : (req.headers || {})["x-cron-secret"] || "", secret)) return res.status(403).json({ error: "FORBIDDEN" });
    if (now() - last < 5000) return res.status(429).json({ error: "TOO_MANY" });
    last = now();
    try { const r = await D.run("cron"); log.log && log.log(`ℹ️ Daily Tests: запуск по расписанию — сегодня ${r.today.status}, завтра ${r.tomorrow.status}`);
      // генерация — после наборов; её ошибка не мешает Daily Tests (наборы уже собраны из одобренного банка)
      try { const g = await GEN.run({ trigger: "cron" }); r.generator = { status: g.status, accepted: g.accepted || 0 }; } catch (e) { r.generator = { status: "error" }; log.warn && log.warn("Daily Tests: генерация не выполнена:", (e && (e.code || e.message)) || "error"); }
      return res.status(200).json(r); }
    catch (e) { log.error && log.error("Daily Tests: ошибка запуска по расписанию:", (e && (e.code || e.message)) || "error"); return res.status(503).json({ error: "UNAVAILABLE" }); }
  });
}
module.exports = { registerDailyCron };
