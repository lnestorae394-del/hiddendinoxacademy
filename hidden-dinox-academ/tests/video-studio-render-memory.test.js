"use strict";
/* Монтаж при малой памяти (Render Free: 512 МБ). Доказательства получены измерением VmHWM настоящего ffmpeg на боевой команде:
   обычный профиль (preset medium, 1080×1920) ≈ 520–575 МБ пика — больше всего контейнера; профиль lite ≈ 240 МБ. */
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
const { renderClip } = require("../video-studio/render"), S = require("../video-studio/settings"), FF = require("../video-studio/ffmpeg"), D = require("../video-studio/diag");
const { FakeFirestore } = require("./video-studio-helpers/fake-firestore"), { COLL } = require("../video-studio/constants"), J = require("../video-studio/jobs"), { Runner } = require("../video-studio/runner"), { memoryVideoStorage } = require("../video-studio/storage-adapter");
const HAS_FF = spawnSync("ffmpeg", ["-version"]).status === 0, LINUX = fs.existsSync("/proc/self/status"), sleep = ms => new Promise(r => setTimeout(r, ms));
const words = Array.from({ length: 8 }, (_, i) => ({ id: "w" + i, word: "слово" + i, start: 1 + i * 0.3, end: 1 + i * 0.3 + 0.25 })), keep = [[1, 3.2]], clip = { words, keep, hook: "Хук", hook_cfg: {}, cta_cfg: {}, caption_cfg: null, breaks: [], joins: [], emphasis: [] };
const tpl = () => { const t = S.mergeTemplate({}); t.logo.enabled = false; return t; };
const fakeRun = log => async (cmd, o = {}) => { log.push(cmd.slice()); return /ffprobe$/.test(cmd[0]) ? { code: 0, stdout: "1920,1080\n", stderr: "" } : { code: 0, stdout: "", stderr: cmd.includes("print_format=json") ? 'x\n{ "input_i" : "-20", "input_tp" : "-3", "input_lra" : "5", "input_thresh" : "-30", "target_offset" : "0.5" }' : "" }; };
test("профиль lite: фон со свечением считается один раз и подаётся картинкой, кодер veryfast с малым буфером; без профиля команда прежняя; предпросмотр не меняется", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "vsmem-")), logs = {};
  for (const [name, profile, mode] of [["normal", null, "final"], ["lite", "lite", "final"], ["lite-preview", "lite", "preview"]]) { logs[name] = []; await renderClip({ src: "/S/s.mp4", clip, outpath: wd + "/o.mp4", font: "Arial", workdir: wd + "/w", tpl: tpl(), run: fakeRun(logs[name]), mode, profile }); }
  const main = n => logs[n][logs[n].length - 1], fcOf = c => c[c.indexOf("-filter_complex") + 1], norm = main("normal"), lite = main("lite");
  assert.ok(!norm.includes("-loop") && norm[norm.indexOf("-preset") + 1] === "medium" && /gblur/.test(fcOf(norm)), "обычный профиль не изменился");
  assert.deepEqual([lite[lite.indexOf("-preset") + 1], lite.includes("-x264-params"), lite.includes("-loop"), /gblur/.test(fcOf(lite)), /\[2:v\]format=yuv420p\[bg1\]/.test(fcOf(lite))], ["veryfast", true, true, false, true]);
  const bg = logs.lite.find(c => c.includes("-frames:v")); assert.ok(bg && /gblur/.test(bg[bg.indexOf("-filter_complex") + 1]) && bg.includes("rgb24"), "фон строится отдельной командой ровно из одного кадра"); assert.equal(logs.lite.filter(c => c.includes("-frames:v")).length, 1);
  const pv = main("lite-preview"); assert.equal(pv[pv.indexOf("-preset") + 1], "ultrafast"); fs.rmSync(wd, { recursive: true, force: true });
});
test("настоящий ffmpeg: lite даёт тот же кадр (PSNR ≥ 40 дБ, длительность совпадает), занимает заметно меньше памяти и не превышает 330 МБ", { skip: (!HAS_FF || !LINUX) && "нужен ffmpeg и Linux" }, async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "vsmem2-")), src = path.join(wd, "s.mp4"); assert.equal(spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000", "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", src]).status, 0);
  const peaks = {}, mk = label => (cmd, o = {}) => { const heavy = cmd.includes("libx264"); let mon, hwm = 0; return FF.run(D.limitArgs(cmd, 1), Object.assign({}, o, { nice: 10, onSpawn: pid => { if (heavy) mon = setInterval(() => { const m = D.procRssMb(pid); if (m) hwm = Math.max(hwm, m.hwm_mb, m.rss_mb); }, 25); } })).then(r => { clearInterval(mon); if (heavy) peaks[label] = hwm; return r; }); };
  const outs = {}; for (const [label, profile] of [["normal", null], ["lite", "lite"]]) { outs[label] = path.join(wd, label + ".mp4"); const info = await renderClip({ src, clip, outpath: outs[label], font: "DejaVu Sans", workdir: path.join(wd, "w-" + label), tpl: tpl(), run: mk(label), mode: "final", profile }); assert.equal(info.profile, profile || "normal"); assert.ok(fs.statSync(outs[label]).size > 5000); }
  const dur = f => Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).stdout.toString()); assert.ok(Math.abs(dur(outs.normal) - dur(outs.lite)) < 0.15, "длительность совпадает");
  const ps = spawnSync("ffmpeg", ["-i", outs.normal, "-i", outs.lite, "-lavfi", "psnr", "-f", "null", "-"]).stderr.toString(), m = /average:([\d.]+|inf)/.exec(ps), psnr = m && m[1] === "inf" ? 99 : Number(m && m[1]); t_diag("ЗАМЕР: пик памяти кодирования normal=" + peaks.normal + " МБ, lite=" + peaks.lite + " МБ; PSNR " + psnr + " дБ");
  assert.ok(psnr >= 40, "кадры совпадают: PSNR " + psnr); assert.ok(peaks.lite < 330, "lite укладывается в бюджет: " + peaks.lite + " МБ"); assert.ok(peaks.normal > peaks.lite * 1.4, "обычный профиль заметно тяжелее: " + peaks.normal + " против " + peaks.lite); fs.rmSync(wd, { recursive: true, force: true });
  function t_diag(msg) { console.log("# " + msg); }
});
test("выбор профиля: лимит памяти ≤ 1 ГБ — lite, больше — обычный; переменная VIDEO_STUDIO_RENDER_PROFILE и признак нехватки памяти переопределяют", () => {
  const mk = env => new Runner({ db: new FakeFirestore(), storage: memoryVideoStorage(), env, log: { log() {}, warn() {}, error() {} }, handlers: {} });
  const r = mk({}); assert.deepEqual([r.renderProfile(512), r.renderProfile(1024), r.renderProfile(2048), r.renderProfile(8192)], ["lite", "lite", "normal", "normal"]); r.forceLite = true; assert.equal(r.renderProfile(8192), "lite");
  assert.equal(mk({ VIDEO_STUDIO_RENDER_PROFILE: "normal" }).renderProfile(512), "normal"); assert.equal(mk({ VIDEO_STUDIO_RENDER_PROFILE: "lite" }).renderProfile(8192), "lite");
});
test("бюджет памяти: FFmpeg, вышедший за бюджет, останавливается ДО перезапуска контейнера; ошибка понятная, диагностика с PID и пиком памяти; процесс не остаётся; обычный профиль → повтор в lite, lite → окончательная ошибка без удаления данных", { skip: (!HAS_FF || !LINUX) && "нужен ffmpeg и Linux" }, async () => {
  for (const profile of ["normal", "lite"]) {
    const db = new FakeFirestore(), st = memoryVideoStorage(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsg-")), logs = []; st.put("video-studio/u/p1/source/original.mp4", { size: 777 });
    await db.collection(COLL.projects).doc("p1").set({ id: "p1", owner_uid: "u", status: "analyzed", source_path: "video-studio/u/p1/source/original.mp4" }); await db.collection(COLL.clips).doc("c1").set({ id: "c1", project_id: "p1", owner_uid: "u", status: "rendering", title: "К" });
    let pidSeen = 0; const handlers = { render: async ctx => { await ctx.check("render", 0); const out = path.join(dir, "o.mp4"); await ctx.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-t", "40", "-c:v", "libx264", "-preset", "medium", out]); return {}; } };
    const r = new Runner({ db, storage: st, env: { VIDEO_STUDIO_TMP: dir, VIDEO_STUDIO_RENDER_PROFILE: profile === "normal" ? "auto" : "lite", VIDEO_STUDIO_MEMORY_BUDGET_MB: "170" }, log: { log() {}, warn() {}, error: m => logs.push(m) }, pollMs: 1e9, handlers });
    const { job } = await J.enqueue(db, Date.now, { type: "render", project_id: "p1", clip_id: "c1", owner_uid: "u", key: "g" + profile, payload: {} }); const t0 = Date.now(); assert.equal(await r.tick(), true); assert.ok(Date.now() - t0 < 25000, "остановлен быстро, а не после полного кодирования");
    const j = (await db.collection(COLL.jobs).doc(job.id).get()).data(), run = j.ffmpeg_runs[0]; pidSeen = run.pid;
    assert.equal(j.error.code, "RENDER_MEMORY"); assert.match(j.error.message, /Не хватило памяти.*FFmpeg занимал \d+ МБ и Node\.js \d+ МБ/); assert.ok(run.mem_guard && run.mem_guard.budget_mb === 170 && run.peak_rss_mb > 0 && run.pid > 0 && run.signal === "SIGKILL" && run.profile === profile, JSON.stringify(run));
    assert.ok(logs.some(l => l.includes("pid=" + run.pid) && l.includes("бюджету памяти")), "строка журнала"); assert.throws(() => process.kill(pidSeen, 0), "процесс ffmpeg не остался");
    if (profile === "normal") { assert.equal(j.status, "queued", "повтор будет"); assert.equal(r.forceLite, true); assert.equal(r.renderProfile(8192), "lite", "следующая попытка — экономичная"); } else { assert.equal(j.status, "failed"); assert.equal((await db.collection(COLL.clips).doc("c1").get()).data().status, "error"); }
    assert.equal((await db.collection(COLL.projects).doc("p1").get()).data().status, "analyzed"); assert.ok(await st.stat("video-studio/u/p1/source/original.mp4"), "исходник на месте"); fs.rmSync(dir, { recursive: true, force: true });
  }
});
