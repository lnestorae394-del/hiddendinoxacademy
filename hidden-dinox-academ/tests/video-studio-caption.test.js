"use strict";
/* Текст внизу видео и положение призыва: операции правок, ASS-слои, значения по умолчанию и НАСТОЯЩИЙ рендер (ffmpeg): изменение текста меняет итоговое видео, а не только предпросмотр. */
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");
const E = require("../video-studio/edits"), S = require("../video-studio/settings"), R = require("../video-studio/render"), FF = require("../video-studio/ffmpeg"), { makeAssText } = require("../video-studio/ass"), RP = require("../video-studio/render-plan");
const { FakeFirestore } = require("./video-studio-helpers/fake-firestore"), { COLL } = require("../video-studio/constants");
const HAS_FF = spawnSync("ffmpeg", ["-version"]).status === 0, clip = { id: "c1", hook: "Хук", start: 10, end: 16, words: Array.from({ length: 6 }, (_, i) => ({ id: "w" + String(i).padStart(6, "0"), text: "слово" + i, start: 10 + i, end: 10.8 + i })) };
const bad = (fn, code) => assert.throws(fn, e => e.code === code, code);

test("операции правок: текст внизу (до 3 строк, длина, границы), положение и размер призыва, сброс; значения строгие", () => {
  let e = E.initEdits(clip); assert.deepEqual(e.caption, { text: "", enabled: false, size: null, x: null, y: null });
  e = E.applyOps(e, [{ op: "set_caption", text: "  Первая   строка \n\n Вторая{} строка\\" }]); assert.equal(e.caption.text, "Первая строка\nВторая строка"); assert.equal(e.caption.enabled, true, "текст сразу показывается");
  e = E.applyOps(e, [{ op: "set_caption", size: 60, x: 500, y: 1700 }]); assert.deepEqual([e.caption.size, e.caption.x, e.caption.y], [60, 500, 1700]); e = E.applyOps(e, [{ op: "set_caption", enabled: false }]); assert.equal(e.caption.enabled, false); assert.equal(e.caption.text, "Первая строка\nВторая строка", "скрытый текст сохраняется");
  e = E.applyOps(e, [{ op: "set_caption", text: "" }]); assert.equal(e.caption.text, ""); e = E.applyOps(e, [{ op: "set_caption", text: "x", size: null, y: null }, { op: "reset_caption" }]); assert.deepEqual(e.caption, { text: "", enabled: false, size: null, x: null, y: null });
  for (const [op, code] of [[{ text: "a\nb\nc\nd" }, "CAPTION_LINES"], [{ text: "я".repeat(141) }, "CAPTION_TOO_LONG"], [{ size: 10 }, "BAD_CAPTION"], [{ size: 500 }, "BAD_CAPTION"], [{ y: 500 }, "BAD_CAPTION"], [{ x: -5 }, "BAD_CAPTION"], [{ y: "1700" }, "BAD_CAPTION"], [{ enabled: "true" }, "BAD_VALUE"]]) bad(() => E.applyOps(E.initEdits(clip), [Object.assign({ op: "set_caption" }, op)]), code);
  e = E.applyOps(E.initEdits(clip), [{ op: "set_cta", y: 1800, size: 30 }]); assert.deepEqual([e.cta.y, e.cta.size], [1800, 30]); e = E.applyOps(e, [{ op: "set_cta", y: null, size: null }]); assert.deepEqual([e.cta.y, e.cta.size], [null, null]); for (const op of [{ y: 100 }, { y: 2500 }, { size: 5 }, { size: "x" }]) bad(() => E.applyOps(E.initEdits(clip), [Object.assign({ op: "set_cta" }, op)]), "BAD_CTA");
  const old = E.initEdits(clip); delete old.caption; assert.equal(E.applyOps(old, [{ op: "set_caption", text: "Текст" }]).caption.text, "Текст", "правки старых клипов (без caption) тоже работают");
});
test("хэш рендера: прежние клипы не пересобираются после обновления; текст внизу и положение призыва меняют хэш", () => {
  const a = E.initEdits(clip), old = JSON.parse(JSON.stringify(a)); delete old.caption; assert.equal(E.editsHash(a, { v: 1 }), E.editsHash(old, { v: 1 }), "без текста внизу хэш прежний");
  assert.equal(E.editsHash(E.applyOps(a, [{ op: "set_caption", text: "Т" }, { op: "set_caption", enabled: false }]), { v: 1 }), E.editsHash(a, { v: 1 }), "скрытый текст видео не меняет");
  const h = x => E.editsHash(x, { v: 1 }), c1 = E.applyOps(a, [{ op: "set_caption", text: "Текст" }]), c2 = E.applyOps(c1, [{ op: "set_caption", text: "Другой" }]), c3 = E.applyOps(c1, [{ op: "set_caption", y: 1800 }]);
  assert.equal(new Set([h(a), h(c1), h(c2), h(c3)]).size, 4, "текст, правка текста и положение — разные версии рендера"); assert.notEqual(h(E.applyOps(a, [{ op: "set_cta", y: 1800 }])), h(a)); assert.equal(h(E.applyOps(a, [{ op: "set_cta", y: null }])), h(a));
});
test("ASS: слой «Cap» только при включённом тексте (строки через \\N, позиция и размер из правок); призыв: положение и размер из правок", () => {
  const tpl = S.mergeTemplate({ cta: { y: 1885 } }), words = [{ word: "раз", start: 0.5, end: 0.9, id: "w1" }], mk = (cap, cta = {}) => makeAssText(tpl, "Arial", "Хук", words, [[0, 8]], 8, {}, cta, [], [], [], cap).text;
  const off = mk(null); assert.ok(!off.includes("Style: Cap") && !/,Cap,,/.test(off), "без текста слоя нет"); assert.ok(!mk({ enabled: false, text: "Привет" }).includes("Cap,,"), "скрытый текст не рисуется"); assert.ok(!mk({ enabled: true, text: "  \n " }).includes("Cap,,"));
  const on = mk({ enabled: true, text: "Первая строка\nВторая" }); assert.match(on, /Style: Cap,Arial,46,/); assert.match(on, /Dialogue: 2,0:00:00\.00,0:00:08\.00,Cap,,0,0,0,,\{\\an5\\pos\(540,1765\)\}Первая строка\\NВторая/);
  const ov = mk({ enabled: true, text: "Т", size: 60, x: 300, y: 1700 }); assert.match(ov, /Style: Cap,Arial,60,/); assert.match(ov, /pos\(300,1700\)/);
  assert.match(off, /,CTA,,0,0,0,,\{\\fad\(220,180\)\\pos\(540,1885\)\\fscx94/, "призыв по умолчанию — ниже"); const c = mk(null, { y: 1800, size: 30 }); assert.match(c, /pos\(540,1800\)\\fs30\\fscx94/);
});
test("значения по умолчанию: призыв опущен ниже (слой студии), эталон mergeTemplate прежний, сохранённое администратором сильнее, текст внизу настраивается в шаблоне", async () => {
  assert.equal(S.mergeTemplate().cta.y, 1760, "эталон v4 не менялся"); const db = new FakeFirestore(); let st = await S.loadSettings(db, {}); assert.equal(st.template.cta.y, 1885); assert.deepEqual(Object.keys(st.template.caption).sort(), ["margin_l", "margin_r", "outline", "shadow", "size", "x", "y"]);
  await db.collection(COLL.settings).doc("template").set({ cta: { y: 1700 }, caption: { size: 52 } }); st = await S.loadSettings(db, {}); assert.equal(st.template.cta.y, 1700); assert.equal(st.template.caption.size, 52); assert.equal(st.template.caption.y, 1765);
  assert.equal(S.validateTemplatePatch({ caption: { y: 1800, size: 50 } }).caption.y, 1800); for (const p of [{ caption: { y: 500 } }, { caption: { size: 5 } }, { caption: { evil: 1 } }]) assert.throws(() => S.validateTemplatePatch(p), e => e.code === "INVALID_TEMPLATE");
});
test("план сборки: общий для ручной и автосборки; в задание попадает текст внизу и положение призыва; правки создаются при первом обращении", async () => {
  const db = new FakeFirestore(), st = await S.loadSettings(db, {}), c = Object.assign({}, clip); await db.collection(COLL.clips).doc("c1").set(c);
  const p1 = await RP.planRender({ db, now: () => 1, clip: c, st }); assert.equal(p1.payload.caption.enabled, false); assert.equal(p1.key, "c1_" + p1.hash); assert.ok((await db.collection(COLL.edits).doc("c1").get()).exists);
  await db.collection(COLL.edits).doc("c1").set(E.applyOps((await db.collection(COLL.edits).doc("c1").get()).data(), [{ op: "set_caption", text: "Внизу", y: 1750 }, { op: "set_cta", y: 1820 }])); const p2 = await RP.planRender({ db, now: () => 2, clip: c, st });
  assert.notEqual(p2.hash, p1.hash); assert.deepEqual([p2.payload.caption.text, p2.payload.caption.y, p2.payload.cta.y], ["Внизу", 1750, 1820]); assert.equal(RP.templateStamp(st), RP.sha(st.template));
});
test("РЕАЛЬНЫЙ рендер (ffmpeg): текст внизу появляется в готовом видео, меняется вместе с правкой и положением; призыв опускается ниже", { skip: !HAS_FF && "нет ffmpeg" }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vscap-")), src = path.join(dir, "src.mp4"), gen = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "7", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src]); assert.equal(gen.status, 0, String(gen.stderr));
  const font = (spawnSync("fc-match", ["-f", "%{family}", "sans"]).stdout || "").toString().split(",")[0] || "Arial", tpl = S.mergeTemplate({ cta: { y: 1885 } }); tpl.logo.enabled = false;
  const words = Array.from({ length: 6 }, (_, i) => ({ id: "w" + i, word: "слово" + i, start: 0.5 + i, end: 1.2 + i }));
  const render = async (name, extra) => { const out = path.join(dir, name + ".mp4"); await R.renderClip({ src, clip: Object.assign({ words, keep: [[0, 7]], hook: "", hook_cfg: { enabled: false }, cta_cfg: {}, breaks: [], joins: [], emphasis: [] }, extra), outpath: out, font, workdir: path.join(dir, "w_" + name), tpl, run: FF.run, ffmpeg: "ffmpeg", ffprobe: "ffprobe", mode: "final" }); return out; };
  const bright = (file, ts, [x, y, w, h]) => { const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(ts), "-i", file, "-vf", `crop=${w}:${h}:${x}:${y},format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 1e8 }); assert.equal(r.status, 0, String(r.stderr)); let n = 0; for (const b of r.stdout) if (b >= 235) n++; return n; };
  const A = await render("A", {}), B = await render("B", { caption_cfg: { enabled: true, text: "Первая строка\nВторая строка" } }), C = await render("C", { caption_cfg: { enabled: true, text: "Первая строка\nВторая строка", y: 1450 } }), D = await render("D", { cta_cfg: { y: 1100 } });
  const lower = [60, 1725, 960, 90], midband = [60, 1400, 960, 90], bottomEdge = [60, 1835, 960, 85];
  const a = bright(A, 1.5, lower), b = bright(B, 1.5, lower), c = bright(C, 1.5, lower), c2 = bright(C, 1.5, midband), b2 = bright(B, 1.5, midband);
  t.diagnostic(`ЗАМЕР белых пикселей нижней зоны: без текста=${a}, с текстом=${b}, текст перенесён выше=${c}; зона выше: ${b2} → ${c2}`);
  assert.ok(a < 50, "без текста внизу пусто: " + a); assert.ok(b > 300, "текст внизу виден в готовом видео: " + b); assert.ok(c < b / 3, "при смене положения текст ушёл из нижней зоны: " + c); assert.ok(c2 > b2 + 100, "и появился там, куда его перенесли: " + b2 + " → " + c2);
  const ctaA = bright(A, 6, bottomEdge), ctaD = bright(D, 6, bottomEdge); t.diagnostic(`ЗАМЕР призыва у нижнего края (6 с): по умолчанию=${ctaA}, перенесён выше=${ctaD}`); assert.ok(ctaA > 200, "призыв по умолчанию внизу: " + ctaA); assert.ok(ctaD < ctaA / 3, "призыв можно переместить: " + ctaD);
  spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", "2", "-i", B, "-frames:v", "1", "/tmp/cap_B.png"]); spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", "6", "-i", A, "-frames:v", "1", "/tmp/cap_A_cta.png"]); fs.rmSync(dir, { recursive: true, force: true });
});
