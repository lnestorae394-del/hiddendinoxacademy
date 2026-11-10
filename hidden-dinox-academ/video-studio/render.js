"use strict";
/* Рендер ролика 1080x1920 по шаблону. Для шаблона по умолчанию без логотипа и без ручных настроек кадра команды FFmpeg ПОБУКВЕННО совпадают
   с командами проверенной по v4 реализации (tests/video-studio-render.test.js). Дополнительно: логотип, масштаб и сдвиг кадра, прогресс. */
const fs = require("fs"), path = require("path");
const core = require("../public/video-studio/js/vs-core.js");
const { makeAssText, ffColor } = require("./ass");
class RenderError extends Error { constructor(m, retryable = false) { super(m); this.retryable = retryable; } }
const { pyFixed } = require("./pyfmt");
const f3 = x => pyFixed(x, 3), even = x => Math.max(2, Math.round(x / 2) * 2);
function layout(sw, sh, cropY, winH, cw) {
  if (sh * cw <= sw * winH) return [sw, sh, 0, even(cw * sh / sw)];
  const ch = even(winH * sw / cw);
  return [sw, ch, Math.max(0, Math.min(cropY, sh - ch)), winH];
}
function setptsExpr(rel) {
  let cum = 0; const offs = rel.map(([a, b]) => { const o = a - cum; cum += b - a; return o; });
  let e = pyFixed(offs[offs.length - 1], 4);
  for (let i = rel.length - 2; i >= 0; i--) e = "if(lt(T," + pyFixed(rel[i + 1][0], 4) + ")," + pyFixed(offs[i], 4) + "," + e + ")";
  return "setpts='PTS-(" + e + ")/TB'";
}
/* Масштаб и сдвиг кадра внутри окна с видео (framing: {zoom 1..3, pan_x, pan_y} в пикселях исходника) */
function applyFraming(cw, ch, cy, fr) {
  if (!fr || !(fr.zoom > 1 || fr.pan_x || fr.pan_y)) return [cw, ch, cy, 0];
  const z = Math.max(1, Math.min(3, fr.zoom || 1)), w = even(cw / z), h = even(ch / z);
  const x = Math.max(0, Math.min(cw - w, Math.round((cw - w) / 2 + (fr.pan_x || 0)))), y = Math.max(0, Math.round(cy + (ch - h) / 2 + (fr.pan_y || 0)));
  return [w, h, y, x];
}
/* run(cmd, {cwd}) → {code, stdout, stderr}. clip: { keep, words[{word,start,end,id}], hook, hook_cfg, cta_cfg, breaks, joins, emphasis } */
/* profile "lite" — для серверов с малой памятью (например, 512 МБ): тот же кадр, но фон со «свечением» (одинаковый в каждом кадре) считается ОДИН раз и подаётся неподвижной картинкой,
   кодер x264 — preset veryfast с малым буфером опережения. Без profile (по умолчанию) команда не меняется ни на байт (сверка с эталоном v4). */
async function renderClip({ src, clip, outpath, font, workdir, tpl, ffmpeg = "ffmpeg", ffprobe = "ffprobe", run, mode = "final", cropY = null, framing = null, logoPath = null, onProgress = null, cancel = null, profile = null }) {
  fs.mkdirSync(workdir, { recursive: true }); workdir = path.resolve(workdir); src = /^https?:\/\//i.test(src) ? src : path.resolve(src);               // источник может быть ссылкой (ffmpeg читает нужный фрагмент по HTTP Range)
  const cv = tpl.canvas, win = tpl.window, accent = ffColor(tpl.colors.accent), gl = tpl.glow, CW = cv.w, CH = cv.h, WIN_Y = win.y, WIN_H = win.h;
  const keep = clip.keep, words = clip.words, s0 = Math.max(0, keep[0][0] - 0.5), rel = keep.map(([a, b]) => [a - s0, b - s0]);
  const dur = keep.reduce((s, [a, b]) => s + b - a, 0), span = rel[rel.length - 1][1] + 0.3, sel = rel.map(([a, b]) => "between(t," + f3(a) + "," + f3(b) + ")").join("+");
  const pr = await run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", src], {});
  if (pr.code !== 0) throw new RenderError("ffprobe не смог прочитать видео: " + pr.stderr.slice(-200));
  const [sw, sh] = pr.stdout.trim().split(",").slice(0, 2).map(Number);
  let [cw_, chh, cy, cx] = layout(sw, sh, cropY === null ? win.crop_y : cropY, WIN_H, CW); const wh = chh === sh && cy === 0 && cw_ === sw && sh * CW <= sw * WIN_H ? layout(sw, sh, 0, WIN_H, CW)[3] : WIN_H;
  const wy = wh === WIN_H ? WIN_Y : WIN_Y + Math.floor((WIN_H - wh) / 2);
  cx = 0; if (framing && (framing.zoom > 1 || framing.pan_x || framing.pan_y)) [cw_, chh, cy, cx] = applyFraming(cw_, chh, cy, framing);
  const proc = path.join(workdir, "a_proc.wav"), fin = path.join(workdir, "a_final.wav"), runOpt = { cancel };
  let r = await run([ffmpeg, "-y", "-v", "error", "-ss", f3(s0), "-t", f3(span), "-i", src, "-vn", "-af",
    "aselect='" + sel + "',asetpts=N/SR/TB,highpass=f=70,dynaudnorm=f=200:g=15:p=0.85:m=15:s=8,acompressor=threshold=-24dB:ratio=3:attack=10:release=200:makeup=2,afade=t=in:d=0.03,afade=t=out:st=" + f3(Math.max(0, dur - 0.15)) + ":d=0.15",
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", proc], runOpt);
  if (r.code) throw new RenderError("Ошибка обработки звука: " + r.stderr.slice(-300));
  const m1 = await run([ffmpeg, "-hide_banner", "-i", proc, "-af", "loudnorm=I=-16:TP=-2:LRA=11:print_format=json", "-f", "null", "-"], runOpt);
  const mm = /\{[^{}]*"input_i"[^{}]*\}/s.exec(m1.stderr || ""); let af = "loudnorm=I=-16:TP=-2:LRA=11";
  if (mm) { const j = JSON.parse(mm[0]); af += ":measured_I=" + j.input_i + ":measured_LRA=" + j.input_lra + ":measured_TP=" + j.input_tp + ":measured_thresh=" + j.input_thresh + ":offset=" + j.target_offset + ":linear=true"; }
  r = await run([ffmpeg, "-y", "-v", "error", "-i", proc, "-af", af, "-ar", "48000", "-c:a", "pcm_s16le", fin], runOpt);
  if (r.code) throw new RenderError("Ошибка нормализации звука: " + r.stderr.slice(-300));
  const ass = makeAssText(tpl, font, clip.hook, words, keep, dur, clip.hook_cfg, clip.cta_cfg, clip.breaks || [], clip.joins || [], clip.emphasis || [], clip.caption_cfg || null);
  fs.writeFileSync(path.join(workdir, "clip.ass"), ass.text, "utf8");
  const crop = "crop=" + cw_ + ":" + chh + ":" + cx + ":" + cy, lg = tpl.logo, useLogo = !!(logoPath && lg && lg.enabled);
  const tail = useLogo ? "[ov];[2:v]scale=" + Math.trunc(lg.w) + ":-2[lg];[ov][lg]overlay=" + Math.trunc(lg.x) + ":" + Math.trunc(lg.y) + ",ass=filename=clip.ass[out]" : ",ass=filename=clip.ass[out]";
  const lite = profile === "lite", bgGraph = d => "color=c=black:s=" + CW + "x" + CH + ":r=" + cv.fps + ":d=" + f3(d) + "[bg0];[bg0]split[bgA][bgB];" +
    "[bgA]drawbox=x=0:y=" + (wy - gl.thin) + ":w=" + CW + ":h=" + gl.thin + ":color=" + accent + ":t=fill,drawbox=x=0:y=" + (wy + wh) + ":w=" + CW + ":h=" + gl.thin + ":color=" + accent + ":t=fill[bgA2];" +
    "[bgB]drawbox=x=0:y=" + (wy - gl.thick) + ":w=" + CW + ":h=" + gl.thick + ":color=" + accent + ":t=fill,drawbox=x=0:y=" + (wy + wh) + ":w=" + CW + ":h=" + gl.thick + ":color=" + accent + ":t=fill,gblur=sigma=" + gl.sigma + "[glow];" +
    "[bgA2]format=gbrp[ga];[glow]format=gbrp[gb];[ga][gb]blend=all_mode=screen,format=yuv420p";
  const bgPng = path.join(workdir, "bg.png"), bgIdx = useLogo ? 3 : 2;
  if (lite) { r = await run([ffmpeg, "-y", "-v", "error", "-filter_complex", bgGraph(1) + "[bgo]", "-map", "[bgo]", "-frames:v", "1", "-pix_fmt", "rgb24", bgPng], runOpt); if (r.code) throw new RenderError("Ошибка подготовки фона: " + r.stderr.slice(-300)); }
  const fc = "[0:v]select='" + sel + "'," + setptsExpr(rel) + ",fps=" + cv.fps + "," + crop + ",scale=" + CW + ":" + wh + ":flags=lanczos[v];" + (lite ? "[" + bgIdx + ":v]format=yuv420p[bg1];" : bgGraph(dur + 0.5) + "[bg1];") + "[bg1][v]overlay=0:" + wy + ":eof_action=repeat" + tail;
  const fc2 = mode === "preview" ? fc.replace("[out]", "[big]") + ";[big]scale=540:960:flags=bicubic[out]" : fc;
  const enc = mode === "preview" ? ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-profile:v", "main"] : lite ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", String((tpl.quality && tpl.quality.crf) || 20), "-x264-params", "rc-lookahead=8:bframes=1:ref=1:sync-lookahead=0:lookahead-threads=1:subme=2", "-profile:v", "high"] : ["-c:v", "libx264", "-preset", (tpl.quality && tpl.quality.preset) || "medium", "-crf", String((tpl.quality && tpl.quality.crf) || 20), "-profile:v", "high"];
  const t0 = Date.now(), cmd = [ffmpeg, "-y", "-v", "error"].concat(onProgress ? ["-progress", "pipe:1", "-nostats"] : [], ["-ss", f3(s0), "-t", f3(span), "-i", src, "-i", fin], useLogo ? ["-i", logoPath] : [], lite ? ["-loop", "1", "-framerate", String(cv.fps), "-i", bgPng] : [],
    ["-filter_complex", fc2, "-map", "[out]", "-map", "1:a", "-t", f3(dur)], enc, ["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", mode === "preview" ? "96k" : "192k", "-ar", "48000", "-movflags", "+faststart", path.resolve(outpath)]);
  r = await run(cmd, { cwd: workdir, cancel, onStdoutLine: onProgress ? l => { const m = /^out_time_ms=(\d+)/.exec(l); if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / dur)); } : undefined });
  if (r.code) throw new RenderError("Ошибка монтажа: " + r.stderr.slice(-500));
  return { profile: lite ? "lite" : "normal", final_s: Number(dur.toFixed(2)), render_s: Number(((Date.now() - t0) / 1000).toFixed(1)), subtitle_chunks: ass.chunks };
}
module.exports = { renderClip, layout, setptsExpr, RenderError };
