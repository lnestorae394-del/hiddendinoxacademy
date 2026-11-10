"use strict";
/* Расчёт частей S3 Multipart Upload. Ограничения S3/R2: часть не меньше 5 МиБ (кроме последней), не больше 5 ГиБ, не более 10 000 частей;
   R2 дополнительно требует, чтобы все части, кроме последней, были ОДИНАКОВОГО размера. Берём 16 МиБ: файл 5 ГБ — 320 частей. */
const MiB = 1048576, MIN_PART = 5 * MiB, MAX_PART = 5 * 1024 * MiB, MAX_PARTS = 10000, DEFAULT_PART = 16 * MiB;
function planParts(size, preferred = DEFAULT_PART) {
  if (!Number.isInteger(size) || size <= 0) throw new Error("Некорректный размер файла");
  let ps = Math.max(MIN_PART, Math.ceil(preferred / MiB) * MiB);
  if (Math.ceil(size / ps) > MAX_PARTS - 100) ps = Math.ceil(size / (MAX_PARTS - 100) / MiB) * MiB;       // запас от лимита в 10 000 частей
  if (ps > MAX_PART) throw new Error("Файл слишком большой для multipart-загрузки");
  return { partSize: ps, totalParts: Math.ceil(size / ps) };
}
const expectedPartSize = (n, plan, size) => (n < plan.totalParts ? plan.partSize : size - (plan.totalParts - 1) * plan.partSize);
module.exports = { planParts, expectedPartSize, MiB, MIN_PART, MAX_PART, MAX_PARTS, DEFAULT_PART };
