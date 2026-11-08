"use strict";
/* Перенос рендера и субтитров на Node сверяется с эталоном — проверенной по v4 реализацией (команды FFmpeg и ASS должны совпасть ПОБУКВЕННО). */
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const { renderClip, layout, setptsExpr } = require("../video-studio/render");
const { makeAssText } = require("../video-studio/ass"), S = require("../video-studio/settings"), core = require("../public/academy/admin/vs-core.js");
const cases = require("./fixtures/video-studio/render_cases.json");
const LN = 'junk\n{ "input_i" : "-27.3", "input_tp" : "-6.9", "input_lra" : "24.4", "input_thresh" : "-41.7", "output_i":"-16.8","target_offset" : "0.87" }\n';
test("рендер и субтитры на Node побуквенно совпадают с эталоном на %d случаях".replace("%d", cases.length), async () => {
  for (const c of cases) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hdfx")), log = [], size = c.size;
    const run = async (cmd, o = {}) => { log.push({ cmd: cmd.slice(), cwd: o.cwd || null }); if (/ffprobe$/.test(cmd[0])) return { code: 0, stdout: size[0] + "," + size[1] + "\n", stderr: "" };
      if (cmd.includes("loudnorm=I=-16:TP=-2:LRA=11:print_format=json")) return { code: 0, stdout: "", stderr: LN }; return { code: 0, stdout: "", stderr: "" }; };
    const tpl = S.mergeTemplate(c.tpl_patch); tpl.logo.enabled = false;                                  // в эталоне логотипа нет
    const clip = Object.assign({}, c.clip, { keep: c.keep, words: c.clip.words });
    await renderClip({ src: "/S/src.mp4", clip, outpath: path.join(tmp, "o.mp4"), font: "Arial", workdir: path.join(tmp, "w"), tpl, run, mode: c.mode, cropY: c.crop_y });
    const norm = s => s == null ? s : String(s).split(tmp).join("{TMP}");
    const got = log.map(e => ({ cmd: e.cmd.map(norm), cwd: norm(e.cwd) }));
    assert.deepEqual(got, c.commands, "команды FFmpeg расходятся: " + c.name);
    assert.equal(fs.readFileSync(path.join(tmp, "w", "clip.ass"), "utf8"), c.ass, "ASS расходится: " + c.name);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test("логотип, масштаб и сдвиг кадра меняют команду только когда включены", async () => {
  const c = cases[0], tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hdfx")), cmds = [];
  const run = async cmd => { cmds.push(cmd); return /ffprobe$/.test(cmd[0]) ? { code: 0, stdout: "720,1440\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }; };
  const base = { src: "/S/s.mp4", clip: Object.assign({}, c.clip, { keep: c.keep }), outpath: tmp + "/o.mp4", font: "Arial", workdir: tmp + "/w", run };
  const t1 = S.mergeTemplate(); await renderClip(Object.assign({ tpl: t1, logoPath: "/L/logo.png" }, base));
  const fc = cmds[cmds.length - 1][cmds[cmds.length - 1].indexOf("-filter_complex") + 1]; assert.match(fc, /\[2:v\]scale=130:-2\[lg\];\[ov\]\[lg\]overlay=60:110,ass=filename=clip\.ass\[out\]/); assert.ok(cmds[cmds.length - 1].includes("/L/logo.png"));
  cmds.length = 0; await renderClip(Object.assign({ tpl: t1 }, base)); assert.ok(!cmds[cmds.length - 1].join(" ").includes("overlay=60:110"), "без logoPath логотипа нет");
  cmds.length = 0; await renderClip(Object.assign({ tpl: t1, framing: { zoom: 1.5, pan_x: 10, pan_y: -20 } }, base)); const f2 = cmds[cmds.length - 1][cmds[cmds.length - 1].indexOf("-filter_complex") + 1]; const m = /crop=(\d+):(\d+):(\d+):(\d+),scale=1080:1160/.exec(f2); assert.ok(m, f2.slice(0, 200)); assert.ok(+m[1] < 720 && +m[2] < 1160 * 720 / 1080 + 2, "кадр приближен");
  cmds.length = 0; await renderClip(Object.assign({ tpl: t1, onProgress: () => {} }, base)); assert.ok(cmds[cmds.length - 1].includes("-progress"));
  fs.rmSync(tmp, { recursive: true, force: true });
});
test("геометрия и привязка кадров совпадают с эталонами ядра", () => { assert.deepEqual(layout(720, 1440, 130, 1160, 1080), [720, 774, 130, 1160]); assert.deepEqual(layout(1920, 1080, 130, 1160, 1080), [1920, 1080, 0, 608]); assert.match(setptsExpr([[0, 3], [4, 7]]), /^setpts='PTS-\(if\(lt\(T,4\.0000\),0\.0000,1\.0000\)\)\/TB'$/); });
