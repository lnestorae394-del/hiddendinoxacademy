"use strict";
/* Форматирование чисел как в Python ("%.Nf"): точные «половинки» (например 4.25) округляются к чётному, а не вверх, как делает toFixed.
   Нужно, чтобы запросы и команды FFmpeg совпадали с проверенной реализацией v4. Только для неотрицательных чисел. */
function pyFixed(x, n) {
  if (!(x >= 0) || !Number.isFinite(x)) return x.toFixed(n);
  const bin = x.toString(2), dot = bin.indexOf("."), f = dot < 0 ? 0 : bin.length - dot - 1;
  if (f === 0 || f > 60) return x.toFixed(n);
  const M = BigInt("0b" + bin.replace(".", "")), den = 2n ** BigInt(f), num = M * 10n ** BigInt(n) * 2n;      // x·10^n·2 = num/den
  if (num % den !== 0n || (num / den) % 2n !== 1n) return x.toFixed(n);                                      // не точная половинка — toFixed округляет верно
  let k = (num / den - 1n) / 2n; if (k % 2n === 1n) k += 1n;                                                  // к чётному
  const s = k.toString().padStart(n + 1, "0"); return n ? s.slice(0, -n) + "." + s.slice(-n) : s;
}
module.exports = { pyFixed };
