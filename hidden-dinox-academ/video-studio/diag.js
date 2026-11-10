"use strict";
/* Диагностика обработки: состояние процесса и контейнера, задержка цикла событий Node.js, признаки работы процесса FFmpeg, безопасное описание команд.
   Нужна, чтобы по записи задания можно было отличить: FFmpeg работает медленно, FFmpeg убит системой (память), Node.js не успевает (нехватка CPU) или экземпляр перезапускался. */
const fs = require("fs"), os = require("os"), path = require("path");
let hist = null; try { hist = require("perf_hooks").monitorEventLoopDelay({ resolution: 20 }); } catch (e) { hist = null; }
const lag = { start() { if (hist) try { hist.enable(); } catch (e) { /* уже включено */ } }, take() { if (!hist) return { max_ms: null, p99_ms: null }; const r = { max_ms: Math.round(hist.max / 1e6), p99_ms: Math.round(hist.percentile(99) / 1e6) }; hist.reset(); return r; } };
const readNum = f => { try { const s = fs.readFileSync(f, "utf8").trim(); return /^\d+$/.test(s) ? Number(s) : null; } catch (e) { return null; } };
function sysDiag() {
  const m = process.memoryUsage(), cg = readNum("/sys/fs/cgroup/memory.current") ?? readNum("/sys/fs/cgroup/memory/memory.usage_in_bytes"), lim = readNum("/sys/fs/cgroup/memory.max") ?? readNum("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const mb = v => (v == null ? null : Math.round(v / 1048576));
  return { rss_mb: mb(m.rss), heap_mb: mb(m.heapUsed), free_mem_mb: mb(os.freemem()), load1: +os.loadavg()[0].toFixed(2), cpus_visible: (os.availableParallelism ? os.availableParallelism() : os.cpus().length), cgroup_mem_mb: mb(cg), cgroup_limit_mb: lim && lim < 2 ** 50 ? mb(lim) : null, uptime_s: Math.round(process.uptime()) };
}
/* тики процессора процесса (utime+stime) из /proc: растут — процесс реально работает, а не завис */
function cpuTicks(pid) { try { const s = fs.readFileSync("/proc/" + pid + "/stat", "utf8"), a = s.slice(s.lastIndexOf(")") + 2).split(" "); return Number(a[11]) + Number(a[12]); } catch (e) { return null; } }
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; } };
/* команда без подписанных ссылок и секретов: у ссылок остаётся только хост */
function redactCmd(cmd) { return cmd.map(a => { const s = String(a); const m = /^(https?:\/\/[^/?#]+)/i.exec(s); return m ? m[1] + "/…" : s.length > 160 ? s.slice(0, 157) + "…" : s; }).slice(0, 60); }
const redactText = t => String(t || "").replace(/https?:\/\/[^\s"']+/gi, u => (/^(https?:\/\/[^/?#]+)/i.exec(u) || [u])[1] + "/…").replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[скрыто]");
/* ограничение ресурсов ffmpeg: потоки декодера/кодера/фильтров (по умолчанию 2): libx264 иначе берёт все ядра ХОСТА, а не квоту контейнера */
function limitArgs(cmd, threads) {
  const n = Number(threads); if (!(n >= 1) || !/ffmpeg/i.test(path.basename(String(cmd[0]))) || cmd.includes("-threads")) return cmd;
  const out = [cmd[0], "-filter_threads", String(n), "-filter_complex_threads", String(n)];
  for (let i = 1; i < cmd.length; i++) { const last = i === cmd.length - 1, a = cmd[i]; if (a === "-i") out.push("-threads", String(n)); else if (last && a !== "-" && !String(a).startsWith("-") && cmd[i - 1] !== "-i") out.push("-threads", String(n)); out.push(a); }
  return out;
}
module.exports = { lag, sysDiag, cpuTicks, alive, redactCmd, redactText, limitArgs };
