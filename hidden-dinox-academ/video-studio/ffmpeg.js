"use strict";
/* Запуск FFmpeg/ffprobe. Порядок поиска: FFMPEG_PATH → пакет ffmpeg-static (если установлен) → ffmpeg из PATH.
   Если ffprobe недоступен, параметры видео читаются самим ffmpeg. Все длительные команды можно остановить (cancel). */
const { spawn } = require("child_process");
class Cancelled extends Error { constructor(m) { super(m || "cancelled"); this.cancelled = true; } }
function bins(env = process.env) {
  let ff = env.FFMPEG_PATH || env.FFMPEG || "", fp = env.FFPROBE_PATH || env.FFPROBE || "";
  if (!ff) { try { ff = require("ffmpeg-static") || ""; } catch (e) { /* не установлен */ } }
  if (!fp) { try { fp = (require("ffprobe-static") || {}).path || ""; } catch (e) { /* не установлен */ } }
  ff = ff || "ffmpeg"; if (!fp) fp = /ffmpeg(\.exe)?$/.test(ff) && ff !== "ffmpeg" ? ff.replace(/ffmpeg(\.exe)?$/, "ffprobe$1") : "ffprobe";
  return { ffmpeg: ff, ffprobe: fp };
}
/* run(cmd, {cwd, cancel, onStdoutLine}) → { code, stdout, stderr }. cancel — функция, возвращающая true, когда нужно остановить. */
class TimedOut extends Error { constructor(ms) { super("ffmpeg timeout"); this.name = "FfmpegTimedOut"; this.timedOut = true; this.ms = ms; } }
function run(cmd, { cwd, cancel, onStdoutLine, maxBuf = 262144, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let p; try { p = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return resolve({ code: 127, stdout: "", stderr: String(e.message) }); }
    let out = "", err = "", buf = "", done = false;
    const tail = (s, add) => { s += add; return s.length > maxBuf ? s.slice(-maxBuf) : s; };
    p.stdout.on("data", c => { const t = c.toString("utf8"); out = tail(out, t); if (onStdoutLine) { buf += t; let i; while ((i = buf.indexOf("\n")) >= 0) { onStdoutLine(buf.slice(0, i)); buf = buf.slice(i + 1); } } });
    p.stderr.on("data", c => { err = tail(err, c.toString("utf8")); });
    let timedOut = false; const tmr = timeoutMs > 0 ? setTimeout(() => { if (!done) { timedOut = true; try { p.kill("SIGKILL"); } catch (e) { /* уже завершён */ } } }, timeoutMs) : null;   // зависшая команда не держит задание до общего лимита
    const timer = cancel ? setInterval(() => { if (!done && cancel()) { try { p.kill("SIGKILL"); } catch (e) { /* уже завершён */ } } }, 400) : null;
    p.on("error", e => { done = true; if (tmr) clearTimeout(tmr); if (timer) clearInterval(timer); resolve({ code: 127, stdout: out, stderr: err + String(e.message) }); });
    p.on("close", code => { done = true; if (tmr) clearTimeout(tmr); if (timer) clearInterval(timer); if (timedOut) return reject(new TimedOut(timeoutMs)); if (cancel && cancel()) return reject(new Cancelled()); resolve({ code: code === null ? 137 : code, stdout: out, stderr: err }); });
  });
}
async function capabilities(env = process.env) {
  const { ffmpeg, ffprobe } = bins(env), r = await run([ffmpeg, "-hide_banner", "-filters"]), v = await run([ffmpeg, "-version"]);
  const f = r.stdout || "", has = n => new RegExp("\\b" + n + "\\s+\\S+->").test(f);
  const probe = await run([ffprobe, "-version"]);
  return { ffmpeg, ffprobe, ok: r.code === 0, version: (v.stdout || "").split("\n")[0], ass: has("ass"), loudnorm: has("loudnorm"), dynaudnorm: has("dynaudnorm"), blend: has("blend"), gblur: has("gblur"), ffprobe_ok: probe.code === 0 };
}
/* Единый разбор файла: { duration, format, video:{codec,width,height,fps}, audio:{codec}|null } */
async function probe(path, env = process.env, opt = {}) {
  const { ffmpeg, ffprobe } = bins(env), r = await run([ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], opt);
  if (r.code === 0) {
    let j; try { j = JSON.parse(r.stdout); } catch (e) { return { error: "unreadable" }; }
    const v = (j.streams || []).find(s => s.codec_type === "video" && s.codec_name !== "mjpeg"), a = (j.streams || []).find(s => s.codec_type === "audio"), fr = String((v && v.avg_frame_rate) || "0/1").split("/");
    return { duration: Number((j.format || {}).duration || 0), format: (j.format || {}).format_name || "", video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: Number(fr[1]) ? Math.round(1000 * Number(fr[0]) / Number(fr[1])) / 1000 : null } : null, audio: a ? { codec: a.codec_name } : null };
  }
  if (r.code !== 127) return { error: "unreadable" };
  const m = await run([ffmpeg, "-hide_banner", "-i", path], opt), t = m.stderr || "";              // запасной путь: ffprobe не установлен
  const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t), vm = /Stream #\d+:\d+[^:]*: Video: (\w+).*?(\d{2,5})x(\d{2,5})/.exec(t), am = /Stream #\d+:\d+[^:]*: Audio: (\w+)/.exec(t), im = /Input #0, ([^,]+(?:,[^,]+)*), from/.exec(t);
  if (!dm) return { error: "unreadable" };
  return { duration: +dm[1] * 3600 + +dm[2] * 60 + +dm[3], format: im ? im[1] : "", video: vm ? { codec: vm[1], width: +vm[2], height: +vm[3], fps: null } : null, audio: am ? { codec: am[1] } : null };
}
module.exports = { TimedOut, bins, run, capabilities, probe, Cancelled };
