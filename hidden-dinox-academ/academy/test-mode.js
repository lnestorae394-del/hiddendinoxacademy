"use strict";
/* Изолированный тестовый режим (HD_TEST_MODE=1).
   Разрешён ТОЛЬКО с эмуляторами Firebase на этой же машине и демо-проектом "demo-*",
   который не существует в облаке Google. Иначе сервер не запускается (fail-closed).
   В тестовом режиме отключаются действия с внешними последствиями: Telegram-боты,
   git push статистики и одобрение партнёрам (approveTrader). */
const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/;

function resolveTestMode(env) {
  if (env.HD_TEST_MODE === undefined || env.HD_TEST_MODE === "") return false;
  const problems = [];
  if (env.HD_TEST_MODE !== "1") problems.push("HD_TEST_MODE должен быть «1»");
  if (!LOCAL.test(env.FIRESTORE_EMULATOR_HOST || "")) problems.push("FIRESTORE_EMULATOR_HOST должен указывать на локальный эмулятор");
  if (!LOCAL.test(env.FIREBASE_AUTH_EMULATOR_HOST || "")) problems.push("FIREBASE_AUTH_EMULATOR_HOST должен указывать на локальный эмулятор");
  if (!/^demo-[a-z0-9-]+$/.test(env.GCLOUD_PROJECT || "")) problems.push("GCLOUD_PROJECT должен начинаться с «demo-»");
  if (env.FIREBASE_KEY) problems.push("FIREBASE_KEY задан — production-ключ в тестовом режиме запрещён");
  if (problems.length) {
    const e = new Error("Тестовый режим отклонён: " + problems.join("; "));
    e.code = "HD_TEST_MODE_INVALID";
    throw e;
  }
  return true;
}
module.exports = { resolveTestMode };
