"use strict";
/* Измерение памяти и времени финального монтажа на РЕАЛЬНОМ ffmpeg: запускает настоящий renderClip и по /proc/<pid>/status следит за пиковой резидентной памятью (VmHWM) каждого процесса ffmpeg.
   Запуск: node tests/tools/video-studio-render-memory.js [--quick] [--variant=current|lean] ; результат — таблица. Только Linux. Память не зависит от доли процессора, время — зависит (см. отчёт). */
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
const FF = require("../../video-studio/ffmpeg"), D = require("../../video-studio/diag"), R = require("../../video-studio/render"), S = require("../../video-studio/settings"), { pickFont } = require("../../video-studio/runner");
const core = require("../../public/video-studio/js/vs-core.js"), TPL = JSON.parse(fs.readFileSync(path.join(__dirname, "../../video-studio/defaults/template.default.json"), "utf8"));
const arg = n => (process.argv.find(a => a.startsWith("--" + n + "=")) || "").split("=")[1], QUICK = process.argv.includes("--quick"), CLIP_S = Number(arg("clip") || (QUICK ? 12 : 30)), THREADS = Number(arg("threads") || 2);
const kb = f => { try { const s = fs.readFileSync(f, "utf8"), g = k => Number((new RegExp(k + ":\\s+(\\d+) kB").exec(s) || [0, 0])[1]); return { hwm: g("VmHWM"), rss: g("VmRSS") }; } catch (e) { return null; } };
async function main() {
  const font = await pickFont(TPL.fonts), dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsmem-")), rows = [], scen = (arg("scen") ? arg("scen").split(",") : ["p1080x1920@30", "l1920x1080@30", "l1920x1080@60"]).map(s => { const m = /^[pl]?(\d+)x(\d+)@(\d+)$/.exec(s); return { name: s, w: +m[1], h: +m[2], fps: +m[3] }; });
  for (const sc of scen) {
    const src = path.join(dir, "src_" + sc.name.replace(/[^\w]/g, "_") + ".mp4");
    spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${sc.w}x${sc.h}:rate=${sc.fps}`, "-f", "lavfi", "-i", "sine=frequency=300", "-t", String(CLIP_S + 6), "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "6M", "-g", String(sc.fps * 2), "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
    const words = Array.from({ length: Math.floor(CLIP_S / 0.45) }, (_, i) => ({ word: "слово" + i, start: 2 + i * 0.45, end: 2 + i * 0.45 + 0.4, id: "w" + String(i).padStart(6, "0") })), keep = core.buildKeep(words, TPL.cuts), peaks = [];
    const run = (cmd, o = {}) => { const full = D.limitArgs(cmd, THREADS), rec = { kind: /-filter_complex/.test(full.join(" ")) ? "видео" : /loudnorm=I=-16:TP=-2:LRA=11:print/.test(full.join(" ")) ? "loudnorm-замер" : /ffprobe/.test(full[0]) ? "ffprobe" : /-vn/.test(full.join(" ")) ? "звук" : "прочее", hwm: 0, t0: Date.now() }; peaks.push(rec); let timer;
      return FF.run(full, Object.assign({ nice: 10, onSpawn: pid => { timer = setInterval(() => { const m = kb("/proc/" + pid + "/status"); if (m) rec.hwm = Math.max(rec.hwm, m.hwm); }, 40); } }, o)).finally(() => { clearInterval(timer); rec.ms = Date.now() - rec.t0; }); };
    const out = path.join(dir, "out_" + sc.name.replace(/[^\w]/g, "_") + ".mp4"), tpl = S.mergeTemplate(JSON.parse(JSON.stringify(TPL)));
    const t0 = Date.now(), nodeRss0 = process.memoryUsage().rss; let err = null, res = null;
    try { res = await R.renderClip({ src, clip: { words, keep, hook: "Тестовый хук", hook_cfg: {}, cta_cfg: {}, caption_cfg: null, breaks: [], joins: [], emphasis: [] }, outpath: out, font, workdir: path.join(dir, "w_" + sc.name.replace(/[^\w]/g, "_")), tpl, ffmpeg: "ffmpeg", ffprobe: "ffprobe", run, mode: "final", variant: arg("variant") || "current" }); } catch (e) { err = String(e.message).slice(0, 160); }
    const v = peaks.filter(p => p.kind === "видео")[0] || {}, top = Math.max(...peaks.map(p => p.hwm));
    rows.push({ scen: sc.name, quality: `${tpl.quality.preset}/crf${tpl.quality.crf}`, video_peak_mb: Math.round((v.hwm || 0) / 1024), any_peak_mb: Math.round(top / 1024), video_s: v.ms ? +(v.ms / 1000).toFixed(1) : null, total_s: +((Date.now() - t0) / 1000).toFixed(1), clip_s: res ? res.final_s : null, out_mb: fs.existsSync(out) ? +(fs.statSync(out).size / 1048576).toFixed(2) : null, node_rss_mb: Math.round(process.memoryUsage().rss / 1048576), err });
    for (const p of peaks) if (p.kind === "звук" || p.kind === "loudnorm-замер") rows[rows.length - 1]["audio_peak_mb_" + p.kind] = Math.round(p.hwm / 1024);
  }
  fs.rmSync(dir, { recursive: true, force: true }); console.log(JSON.stringify({ cpus_visible: os.availableParallelism(), threads: THREADS, clip_s: CLIP_S, rows }, null, 1));
}
main().catch(e => { console.error(e); process.exit(1); });
