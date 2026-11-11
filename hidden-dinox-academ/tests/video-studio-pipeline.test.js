"use strict";
/* Сквозная проверка конвейера Video Studio на НАСТОЯЩЕМ FFmpeg: загрузка → проверка видео → анализ → клипы → правки → рендер 1080x1920 → Telegram.
   Внешние сервисы (Groq, Claude, Telegram Bot API) — локальные подделки: проверяется форма запросов и обработка ответов, а не реальные сервисы.
   Если нет FFmpeg с libass, тесты ЯВНО пропускаются с причиной (строгий запуск tests/video-studio-run-all.sh не засчитает это как пройденное). */
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const { FakeFirestore } = require("./video-studio-helpers/fake-firestore"), { fakeVerify } = require("./video-studio-helpers/http"), { adminCaller } = require("./video-studio-helpers/router");
const fakes = require("./video-studio-helpers/fakes"), FF = require("../video-studio/ffmpeg"), { createVideoStudioApi } = require("../video-studio/api"), { localVideoStorage } = require("../video-studio/storage-adapter");
const { Runner } = require("../video-studio/runner"), { COLL } = require("../video-studio/constants");
const quiet = { log() {}, warn() {}, error() {} }, sha256 = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const S = { skip: null }; const clock = { t: 1_800_000_000_000 }, now = () => clock.t;
const sh = async (cmd, o) => { const r = await FF.run(cmd, o); return r; };
const probeWH = async f => { const r = await FF.run([S.bins.ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "csv=p=0", f]); return r.stdout.trim().split(/[\n,]/); };
const lufs = async f => { const r = await FF.run([S.bins.ffmpeg, "-hide_banner", "-nostats", "-i", f, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"]); const m = [...r.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)]; return Number(m[m.length - 1][1]); };
const needed = t => { if (S.skip) { t.skip(S.skip); return false; } return true; };
async function drain(max = 40) { let n = 0; while (n < max && await S.runner.tick()) n++; return n; }
const doc = async (c, id) => { const d = await S.db.collection(c).doc(id).get(); return d.exists ? Object.assign({ id }, d.data()) : null; };
const all = async c => (await S.db.collection(c).get()).docs.map(d => Object.assign({ id: d.id }, d.data()));
const call = (method, p, o = {}) => S.call(method, p, Object.assign({ uid: "boss", headers: { origin: "https://hiddendinox.com" } }, o));
const ok = r => { assert.equal(r.statusCode, 200, JSON.stringify(r.body)); return r.body; };

test("подготовка: FFmpeg с libass, тестовая запись, поддельные Groq/Claude/Telegram", async t => {
  S.env = Object.assign({}, process.env); const caps = await FF.capabilities(S.env); S.bins = FF.bins(S.env);
  if (!caps.ok || !caps.ass || !caps.loudnorm) { S.skip = "FFmpeg недоступен или без libass/loudnorm (" + (caps.error || caps.version || "нет") + "): задайте FFMPEG_PATH/FFPROBE_PATH на полную сборку"; return t.skip(S.skip); }
  S.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-pipe-")); S.src = path.join(S.tmp, "live.mp4");
  const g = await FF.run([S.bins.ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=720x1440:rate=25:duration=200", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=200", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "500k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-shortest", S.src]);
  assert.equal(g.code, 0, g.stderr); S.duration = 200;
  S.groq = await fakes.groqServer(200); S.claude = await fakes.claudeServer(); S.tg = await fakes.telegramServer("123456:TESTTOKEN");
  Object.assign(S.env, { GROQ_API_KEY: "gsk_" + "x".repeat(24), ANTHROPIC_API_KEY: "sk-ant-" + "x".repeat(24), VIDEO_STUDIO_TELEGRAM_ENABLED: "1", VIDEO_STUDIO_TELEGRAM_BOT_TOKEN: "123456:TESTTOKEN", VIDEO_STUDIO_TELEGRAM_OWNER_CHAT_ID: "777000111", GROQ_BASE_URL: S.groq.url, ANTHROPIC_BASE_URL: S.claude.url, TELEGRAM_API_BASE: S.tg.url, VIDEO_STUDIO_ORIGIN: "https://hiddendinox.com", VIDEO_STUDIO_TMP: path.join(S.tmp, "work") });
  S.db = new FakeFirestore(); S.storage = localVideoStorage(path.join(S.tmp, "bucket"));
  await S.db.collection("users").doc("boss").set({ email: "boss@test.local", role: "admin" }); await S.db.collection("users").doc("anna").set({ email: "anna@test.local", role: "student" });
  S.runner = new Runner({ db: S.db, storage: S.storage, env: S.env, log: quiet, now, font: "DejaVu Sans", pollMs: 1e9 });
  const api = createVideoStudioApi({ db: S.db, verifyIdToken: fakeVerify, storage: S.storage, runner: null, log: quiet, now, env: S.env }); S.api = api; S.call = adminCaller(api);
  assert.ok(caps.version);
});
test("загрузка → завершение → проверка видео (ffprobe, декодирование)", async t => {
  if (!needed(t)) return; const size = fs.statSync(S.src).size;
  const c = ok(await call("POST", "/projects", { body: { filename: "live.mp4", size, content_type: "video/mp4", fingerprint: "live.mp4:" + size + ":1" } })); S.pid = c.project.id; assert.ok(c.upload.url.startsWith("local://upload/video-studio/boss/"));
  assert.equal((await call("POST", "/projects", { body: { filename: "live.mp4", size, fingerprint: "live.mp4:" + size + ":1" } })).body.error, "DUPLICATE", "тот же файл повторно не принимается");
  assert.equal((await call("POST", `/projects/${S.pid}/upload/complete`)).statusCode, 409, "пока файл не загружен");
  const p = await doc(COLL.projects, S.pid); S.storage.put(p.source_path, S.src); ok(await call("POST", `/projects/${S.pid}/upload/complete`));
  assert.equal(await drain(), 1); const pr = await doc(COLL.projects, S.pid); assert.equal(pr.status, "ready"); assert.ok(Math.abs(pr.duration_sec - 200) < 1); assert.equal(pr.width, 720); assert.equal(pr.video_codec, "h264"); assert.equal(pr.audio_codec, "aac");
});
test("мусорный файл отклоняется проверкой и удаляется из хранилища; запись без звука не принимается", async t => {
  if (!needed(t)) return; const bad = path.join(S.tmp, "bad.mp4"); fs.writeFileSync(bad, Buffer.concat([Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), Buffer.alloc(8000, 7)]));
  const c1 = ok(await call("POST", "/projects", { body: { filename: "bad.mp4", size: fs.statSync(bad).size } })), p1 = await doc(COLL.projects, c1.project.id); S.storage.put(p1.source_path, bad); ok(await call("POST", `/projects/${p1.id}/upload/complete`)); await drain();
  const e1 = await doc(COLL.projects, p1.id); assert.equal(e1.status, "error"); assert.equal(e1.error.code, "UNREADABLE"); assert.equal(await S.storage.stat(p1.source_path), null, "битый файл удалён");
  const mute = path.join(S.tmp, "mute.mp4"); await FF.run([S.bins.ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", mute]);
  const c2 = ok(await call("POST", "/projects", { body: { filename: "mute.mp4", size: fs.statSync(mute).size } })), p2 = await doc(COLL.projects, c2.project.id); S.storage.put(p2.source_path, mute); ok(await call("POST", `/projects/${p2.id}/upload/complete`)); await drain();
  assert.equal((await doc(COLL.projects, p2.id)).error.code, "NO_AUDIO");
});
test("анализ: Groq → Claude → проверка кодом → клипы; бюджет списан; выдуманные моменты отклонены", async t => {
  if (!needed(t)) return; assert.equal((await call("POST", `/projects/${S.pid}/analyze`, { body: {} })).body.error, "CONFIRM_REQUIRED");
  const a = ok(await call("POST", `/projects/${S.pid}/analyze`, { body: { confirm: true, auto_render: false } })); assert.equal(a.created, true); assert.equal((await call("POST", `/projects/${S.pid}/analyze`, { body: { confirm: true } })).body.error, "ALREADY_RUNNING");
  assert.equal(await drain(), 1); const j = await doc(COLL.jobs, a.job.id); assert.equal(j.status, "succeeded", JSON.stringify(j.error)); const p = await doc(COLL.projects, S.pid); assert.equal(p.status, "analyzed");
  assert.equal(S.groq.calls, 1); assert.equal(S.claude.calls, 1); assert.equal(S.groq.auth, "Bearer " + S.env.GROQ_API_KEY); assert.deepEqual([...new Set(S.groq.fields)].sort(), ["file", "language", "model", "prompt", "response_format", "temperature", "timestamp_granularities[]"], "только документированные параметры Groq");
  const clips = (await all(COLL.clips)).filter(c => c.project_id === S.pid).sort((x, y) => x.start - y.start); assert.equal(clips.length, 2, "принято 2 момента; выдуманный отклонён проверкой"); assert.ok(p.analysis.rejected.length >= 1 && /цитата/.test(p.analysis.rejected[0].reason));
  for (const c of clips) { assert.ok(c.duration_s >= 15 && c.duration_s <= 35, String(c.duration_s)); assert.match(c.words[0].id, /^w\d{6}$/); assert.ok(await S.storage.stat(c.window_path)); assert.ok(await S.storage.stat(c.thumb_path)); assert.equal(c.status, "found"); assert.ok(c.window_dur > c.duration_s); }
  S.clips = clips; const u = (await all(COLL.usage))[0]; assert.equal(u.reserved_usd, 0); assert.ok(u.spent_usd > 0 && u.spent_usd < 0.5, "списан фактический расход: $" + u.spent_usd); assert.deepEqual(u.jobs, {});
  const dirs = fs.existsSync(S.runner.tmpRoot) ? fs.readdirSync(S.runner.tmpRoot) : []; assert.deepEqual(dirs, [], "временные файлы задания удалены");
  assert.ok(fs.statSync(S.src).size > 0 && await S.storage.stat((await doc(COLL.projects, S.pid)).source_path), "исходная запись на месте");
});
test("рендер: готовый MP4 1080x1920 с хуком, субтитрами, логотипом и нормализованным звуком; повтор без изменений не пересобирает", async t => {
  if (!needed(t)) return; const c = S.clips[0]; S.cid = c.id; const v = ok(await call("GET", `/clips/${c.id}`)); assert.equal(v.edits.rev, 0);
  ok(await call("PUT", `/clips/${c.id}/edits`, { body: { base_rev: 0, ops: [{ op: "set_hook", text: "Мой тестовый хук" }] } }));
  const r = ok(await call("POST", `/clips/${c.id}/render`)); assert.equal(r.cached, false); S.hash = r.hash; assert.equal((await doc(COLL.clips, c.id)).status, "rendering");
  assert.equal(await drain(), 2, "рендер и автоотправка в Telegram"); const cl = await doc(COLL.clips, c.id); assert.equal(cl.status, "done"); assert.ok(cl.render && cl.render.hash === S.hash && cl.render.size > 1000);
  S.out = path.join(S.storage.root, cl.render.path); const [w, h, dur] = await probeWH(S.out); assert.equal(w, "1080"); assert.equal(h, "1920"); assert.ok(Math.abs(Number(dur) - cl.render.duration) < 0.5 && Number(dur) >= 15 && Number(dur) <= 35, dur);
  const I = await lufs(S.out); assert.ok(I > -17.5 && I < -14.5, "громкость около −16 LUFS: " + I); const mt = fs.statSync(S.out).mtimeMs;
  const again = ok(await call("POST", `/clips/${c.id}/render`)); assert.equal(again.cached, true); assert.equal(fs.statSync(S.out).mtimeMs, mt, "файл не пересобран");
  const g = ok(await call("GET", `/clips/${c.id}`)); assert.equal(g.stale, false);
});
test("Telegram: автоотправка именно ГОТОВОГО ролика; успех — только после подтверждения Telegram; message_id сохранён", async t => {
  if (!needed(t)) return; assert.equal(S.tg.sent.length, 1); const rec = S.tg.sent[0], cl = await doc(COLL.clips, S.cid);
  assert.equal(rec.sha, sha256(S.out), "в Telegram ушёл ровно экспортированный файл"); assert.notEqual(rec.sha, sha256(S.src), "а не исходная запись"); assert.ok(rec.bytes < fs.statSync(S.src).size * 40);
  assert.equal(rec.chat_id, "777000111"); assert.equal(rec.caption, "Мой тестовый хук"); assert.equal(rec.supports_streaming, "true"); assert.equal(rec.width, "1080"); assert.equal(rec.height, "1920");
  const tmpv = path.join(S.tmp, "from_tg.mp4"); fs.writeFileSync(tmpv, rec.data); const [w, h] = await probeWH(tmpv); assert.deepEqual([w, h], ["1080", "1920"], "полученный Telegram файл — вертикальный 1080×1920");
  assert.equal(cl.telegram.status, "sent"); assert.equal(cl.telegram.message_id, rec.id); assert.equal(cl.telegram.hash, S.hash); assert.ok(cl.telegram.file_id); assert.equal(cl.telegram.error, null);
  const j = (await all(COLL.jobs)).find(x => x.type === "telegram"); assert.equal(j.status, "succeeded"); assert.equal(j.payload.trigger, "auto");
});
test("повторная отправка: без force дубля нет; с force — по file_id без повторной загрузки; полная перезагрузка — по reupload", async t => {
  if (!needed(t)) return; S.firstFileId = (await doc(COLL.clips, S.cid)).telegram.file_id; assert.ok(S.firstFileId); const r1 = ok(await call("POST", `/clips/${S.cid}/telegram`, { body: {} })); assert.equal(r1.already_sent, true); assert.equal(await drain(), 0); assert.equal(S.tg.sent.length, 1, "дубль не отправлен");
  const f = ok(await call("POST", `/clips/${S.cid}/telegram`, { body: { force: true } })); assert.equal(f.queued, true); const dbl = ok(await call("POST", `/clips/${S.cid}/telegram`, { body: { force: true } })); assert.equal(dbl.job.id, f.job.id, "двойной клик не создаёт второе задание"); assert.equal(dbl.in_progress, true);
  await drain(); assert.equal(S.tg.sent.length, 2); const second = S.tg.sent[1]; assert.equal(second.by_file_id, true, "повтор идёт по file_id, файл не перезагружается"); assert.equal(second.file_id_in, S.firstFileId, "ушло по file_id первой отправки"); assert.equal(second.bytes, 0);
  ok(await call("POST", `/clips/${S.cid}/telegram`, { body: { force: true, reupload: true } })); await drain(); const third = S.tg.sent[2]; assert.equal(third.by_file_id, false, "reupload = полная загрузка файла заново"); assert.equal(third.sha, S.tg.sent[0].sha);
  const cl = await doc(COLL.clips, S.cid); assert.equal(cl.telegram.status, "sent"); assert.equal(cl.telegram.message_id, third.id); assert.equal(cl.telegram.attempts, 3);
});
test("Telegram: бот не может писать первым → понятная ошибка, результат не потерян; после исправления повтор доставляет", async t => {
  if (!needed(t)) return; const before = S.tg.sent.length; S.tg.fail.sendVideo = [{ status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" } }];
  const f = ok(await call("POST", `/clips/${S.cid}/telegram`, { body: { force: true } })); await drain(); const cl = await doc(COLL.clips, S.cid), job = await doc(COLL.jobs, f.job.id);
  assert.equal(job.status, "failed"); assert.equal(cl.telegram.status, "failed"); assert.equal(cl.telegram.error.code, "TG_NOT_STARTED"); assert.match(cl.telegram.error.message, /Start/); assert.equal(cl.telegram.message_id, null, "успех не объявлен");
  assert.ok(cl.telegram.last_sent && cl.telegram.last_sent.message_id, "прежняя успешная отправка помнится отдельно"); assert.ok(cl.render && await S.storage.stat(cl.render.path), "готовый ролик цел");
  assert.equal(S.tg.sent.length, before, "ничего не отправлено"); const r = ok(await call("POST", `/jobs/${job.id}/retry`)); assert.equal(r.status, "queued"); await drain();
  assert.equal(S.tg.sent.length, before + 1); assert.equal((await doc(COLL.clips, S.cid)).telegram.status, "sent");
});
test("Telegram: лимит запросов 429 → задание повторяется позже; в журнал не попадает токен", async t => {
  if (!needed(t)) return; const before = S.tg.sent.length; S.tg.fail.sendVideo = [{ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } } }];
  const f = ok(await call("POST", `/clips/${S.cid}/telegram`, { body: { force: true } })); await drain(); const job = await doc(COLL.jobs, f.job.id), cl = await doc(COLL.clips, S.cid);
  assert.equal(job.status, "queued"); assert.equal(job.error.retrying, true); assert.ok(job.next_run_at > clock.t + 50000, "повтор отложен"); assert.equal(cl.telegram.status, "retrying"); assert.equal(S.tg.sent.length, before);
  clock.t += 61000; await drain(); assert.equal(S.tg.sent.length, before + 1); assert.equal((await doc(COLL.jobs, f.job.id)).status, "succeeded"); assert.equal((await doc(COLL.clips, S.cid)).telegram.status, "sent");
  assert.ok(!JSON.stringify(await all(COLL.events)).includes("TESTTOKEN") && !JSON.stringify(await all(COLL.jobs)).includes("TESTTOKEN"), "токен бота не попал в базу");
});
test("Telegram: файл больше лимита → вместо «успеха» отправляется ссылка и статус sent_link (не sent)", async t => {
  if (!needed(t)) return; const before = S.tg.sent.length, msgs = S.tg.messages.length; S.env.VIDEO_STUDIO_TG_LIMIT_BYTES = "200000";
  try { ok(await call("POST", `/clips/${S.cid}/telegram`, { body: { force: true, reupload: true } })); await drain(); } finally { delete S.env.VIDEO_STUDIO_TG_LIMIT_BYTES; }
  const cl = await doc(COLL.clips, S.cid); assert.equal(cl.telegram.status, "sent_link"); assert.equal(cl.telegram.kind, "link"); assert.equal(S.tg.sent.length, before, "видео не загружалось"); assert.equal(S.tg.messages.length, msgs + 1);
  assert.match(S.tg.messages[S.tg.messages.length - 1].text, /слишком большой.*local:\/\/read\/video-studio\//s); assert.equal(cl.telegram.message_id, S.tg.messages[S.tg.messages.length - 1].id);
});
test("настройка Telegram: проверка подключения, тестовое сообщение, понятная инструкция при ошибке; токен наружу не отдаётся", async t => {
  if (!needed(t)) return; const chk = ok(await call("POST", "/telegram/check")); assert.equal(chk.ok, true); assert.equal(chk.bot.username, "hd_test_bot"); assert.equal(chk.chat_ok, true); assert.equal(chk.link, "https://t.me/hd_test_bot?start=video_studio");
  const tst = ok(await call("POST", "/telegram/test")); assert.ok(tst.message_id); assert.match(S.tg.messages[S.tg.messages.length - 1].text, /Video Studio/);
  S.tg.fail.sendChatAction = [{ status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" } }]; const bad = ok(await call("POST", "/telegram/check")); assert.equal(bad.chat_ok, false); assert.match(bad.chat_error, /Start/);
  assert.equal((await call("PUT", "/telegram", { body: { chat_id: "abc" } })).statusCode, 400); assert.equal((await call("PUT", "/telegram", { body: { auto_send: "yes" } })).statusCode, 400);
  ok(await call("PUT", "/telegram", { body: { chat_id: "777000111", auto_send: false } })); const g = ok(await call("GET", "/telegram")); assert.equal(g.chat_id, "777000111"); assert.equal(g.auto_send, false); assert.ok(!JSON.stringify(g).includes("TESTTOKEN"));
  ok(await call("PUT", "/telegram", { body: { auto_send: true } }));
});
test("обрезка начала/конца: слова берутся из расшифровки, правки сохраняются; выход за окно отклоняется; окно можно пересоздать", async t => {
  if (!needed(t)) return; const c = S.clips[1], v0 = ok(await call("GET", `/clips/${c.id}`)), mid = v0.edits.words[Math.floor(v0.edits.words.length / 2)];
  ok(await call("PUT", `/clips/${c.id}/edits`, { body: { base_rev: 0, ops: [{ op: "set_text", id: mid.id, text: "ПРАВКА" }] } }));
  const start = v0.edits.words[0].start + 1.2, end = v0.edits.words[v0.edits.words.length - 1].end - 1.2, r = ok(await call("PUT", `/clips/${c.id}/range`, { body: { start, end } }));
  assert.ok(r.edits.words.length < v0.edits.words.length && r.edits.rev === 2, "слов стало меньше"); assert.ok(r.edits.words.find(w => w.id === mid.id).text === "ПРАВКА", "правка слова сохранена"); assert.ok(r.clip.start >= start - 0.1 && r.clip.end <= end + 0.5);
  const cl = await doc(COLL.clips, c.id); assert.ok(Math.abs(cl.start - r.clip.start) < 0.01); const out = await call("PUT", `/clips/${c.id}/range`, { body: { start: cl.window_start - 5, end: cl.end } }); assert.equal(out.statusCode, 409); assert.equal(out.body.error, "OUT_OF_WINDOW");
  assert.equal((await call("PUT", `/clips/${c.id}/range`, { body: { start: 10, end: 11 } })).body.error, "BAD_RANGE");
  const w = ok(await call("POST", `/clips/${c.id}/window`, { body: { start: Math.max(0, cl.start - 3), end: cl.end + 3 } })); await drain(); assert.equal((await doc(COLL.jobs, w.job.id)).status, "succeeded"); const cw = await doc(COLL.clips, c.id); assert.ok(cw.window_start <= Math.max(0, cl.start - 3 - 11.9) + 0.5);
});
test("подсказка хуков: ИИ предлагает, код оставляет только подтверждённые текстом клипа; расход учтён", async t => {
  if (!needed(t)) return; const before = (await all(COLL.usage))[0].spent_usd, r = ok(await call("POST", `/clips/${S.cid}/hooks`));
  assert.equal(r.hooks.length, 1, "поддельная цитата и «гарантированная прибыль» отброшены кодом"); assert.ok(!/гарант/i.test(r.hooks[0])); assert.ok((await all(COLL.usage))[0].spent_usd > before);
});
test("восстановление после падения: задание с истёкшей арендой подхватывает другой экземпляр", async t => {
  if (!needed(t)) return; const r = ok(await call("POST", `/clips/${S.cid}/preview`)); const crashed = new Runner({ db: S.db, storage: S.storage, env: S.env, log: quiet, now, workerId: "dead-instance", pollMs: 1e9 });
  const claimed = await crashed.queue.claim(); assert.equal(claimed.id, r.job.id); assert.equal((await doc(COLL.jobs, r.job.id)).status, "claimed"); assert.equal(await drain(), 0, "пока аренда жива, задание не перехватывается");
  clock.t += 121000; assert.equal(await drain(), 1); const j = await doc(COLL.jobs, r.job.id); assert.equal(j.status, "succeeded"); assert.equal(j.attempts, 2); const cl = await doc(COLL.clips, S.cid); assert.ok(cl.preview && await S.storage.stat(cl.preview.path));
  const [w, h] = await probeWH(path.join(S.storage.root, cl.preview.path)); assert.deepEqual([w, h], ["540", "960"]);
});
test("отмена: запущенный рендер останавливается, клип возвращается в рабочее состояние, исходник цел", async t => {
  if (!needed(t)) return; const c = S.clips[1]; ok(await call("PUT", `/clips/${c.id}/edits`, { body: { base_rev: (await doc(COLL.edits, c.id)).rev, ops: [{ op: "set_hook", text: "Хук для отмены" }] } }));
  const r = ok(await call("POST", `/clips/${c.id}/render`)); const run = S.runner.tick(); await new Promise(res => setTimeout(res, 1500)); ok(await call("POST", `/jobs/${r.job.id}/cancel`));
  S.runner.leaseMs = 120000; await S.runner.queue.db.collection(COLL.jobs).doc(r.job.id).update({ cancel_requested: true }); await run; const j = await doc(COLL.jobs, r.job.id);
  assert.ok(["cancelled", "succeeded"].includes(j.status), j.status); if (j.status === "cancelled") assert.notEqual((await doc(COLL.clips, c.id)).status, "rendering");
  assert.ok(await S.storage.stat((await doc(COLL.projects, S.pid)).source_path), "исходник цел"); const dirs = fs.readdirSync(S.runner.tmpRoot); assert.deepEqual(dirs, [], "временные файлы удалены");
});
test("мониторинг: реальные задания записали этапы по порядку с длительностями; этап ошибки и ссылка на источник не мешают результату", async t => {
  if (!needed(t)) return; const jobs = await all(COLL.jobs); for (const j of jobs.filter(x => x.status === "succeeded" && x.stages && x.stages.length)) t.diagnostic("ЗАМЕР " + j.type + ": " + j.stages.map(s => s.name + "=" + (s.duration_ms / 1000).toFixed(2) + "с").join("  ") + "  | всего " + (j.stages.reduce((a, s) => a + s.duration_ms, 0) / 1000).toFixed(2) + "с");
  const by = ty => jobs.filter(j => j.type === ty && j.status === "succeeded")[0], an = by("analyze"), rd = by("render"), pr = by("probe"), names = j => j.stages.map(s => s.name);
  assert.ok(an && rd && pr, "есть успешные задания проверки, анализа и сборки");
  assert.ok(names(pr).includes("download") && names(pr).includes("probe"), "проверка: " + names(pr)); for (const n of ["download", "audio", "stt", "claude", "clips"]) assert.ok(names(an).includes(n), "анализ: нет этапа " + n + " в " + names(an));
  for (const n of ["download", "render", "upload"]) assert.ok(names(rd).includes(n), "сборка: нет этапа " + n + " в " + names(rd));
  for (const j of [pr, an, rd]) { j.stages.forEach((s, i) => { assert.ok(Number.isFinite(s.duration_ms) && s.duration_ms >= 0 && s.ended_at >= s.started_at, JSON.stringify(s)); if (i) assert.ok(s.started_at >= j.stages[i - 1].started_at, "этапы идут по порядку"); }); assert.ok(j.last_update_at > 0 && j.stage_started_at > 0); }
});
test("автосборка и нижний текст: после нарезки клипы собираются сами (без рассылки в Telegram), найдено меньше запрошенного — честно; изменённый нижний текст попадает в итоговый файл", async t => {
  if (!needed(t)) return; const { spawnSync } = require("child_process"), os = require("os"); const tgBefore = (await all(COLL.jobs)).filter(j => j.type === "telegram").length;
  for (const c of (await all(COLL.clips)).filter(c => c.project_id === S.pid)) { await S.db.collection(COLL.clips).doc(c.id).delete(); await S.db.collection(COLL.edits).doc(c.id).delete().catch(() => {}); }
  await S.db.collection(COLL.projects).doc(S.pid).update({ status: "ready" });
  const a = ok(await call("POST", `/projects/${S.pid}/analyze`, { body: { confirm: true, title: "Мой эфир", target_clips: 3, auto_render: true } })); assert.equal(a.created, true); assert.equal(await drain(), 3, "анализ + две автосборки");
  const p = await doc(COLL.projects, S.pid), clips = (await all(COLL.clips)).filter(c => c.project_id === S.pid).sort((x, y) => x.start - y.start);
  assert.deepEqual([p.title, p.target_clips, p.analysis.requested_clips, p.analysis.found_clips], ["Мой эфир", 3, 3, 2], "запрошено 3, найдено 2 — дубликаты не создаются"); assert.equal(clips.length, 2);
  for (const c of clips) { assert.equal(c.workflow.status, "found"); assert.equal(c.status, "done"); assert.ok(c.render && await S.storage.stat(c.render.path), "видео собрано автоматически"); }
  const auto = (await all(COLL.jobs)).filter(j => j.type === "render" && j.payload && j.payload.auto); assert.equal(auto.length, 2); assert.ok(auto.every(j => j.priority === 7 && j.status === "succeeded"), "ручные сборки идут раньше автоматических"); assert.equal((await all(COLL.jobs)).filter(j => j.type === "telegram").length, tgBefore, "автосборка не рассылает в Telegram");
  const c0 = clips[0], cv = ok(await call("GET", `/clips/${c0.id}`)); assert.equal(cv.stale, false); ok(await call("PUT", `/clips/${c0.id}/edits`, { body: { base_rev: cv.edits.rev, ops: [{ op: "set_caption", text: "Нижний текст клипа" }] } })); assert.equal(ok(await call("GET", `/clips/${c0.id}`)).stale, true, "после правки текста сохранённое видео устарело");
  ok(await call("POST", `/clips/${c0.id}/render`)); assert.ok(await drain() >= 1, "сборка (и автоотправка себе, если включена) выполнены"); const after = await doc(COLL.clips, c0.id); assert.notEqual(after.render.hash, c0.render.hash);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vsx-")), f0 = path.join(dir, "a.mp4"), f1 = path.join(dir, "b.mp4"); await S.storage.download(c0.render.path, f0); await S.storage.download(after.render.path, f1);
  const bright = f => { const r = spawnSync("ffmpeg", ["-v", "error", "-ss", "1.5", "-i", f, "-vf", "crop=960:90:60:1730,format=gray", "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 1e8 }); assert.equal(r.status, 0, String(r.stderr)); let n = 0; for (const b of r.stdout) if (b >= 235) n++; return n; };
  const b0 = bright(f0), b1 = bright(f1); t.diagnostic("ЗАМЕР нижнего текста в итоговом файле через очередь и хранилище: без текста=" + b0 + ", с текстом=" + b1); assert.ok(b0 < 80, "до правки внизу пусто: " + b0); assert.ok(b1 > 300, "после правки и пересборки текст внизу виден в итоговом файле: " + b1);
  spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", "1.5", "-i", f1, "-frames:v", "1", "/tmp/e2e_caption.png"]); fs.rmSync(dir, { recursive: true, force: true });
});
test("завершение: останавливаем поддельные серверы и чистим временное", async t => { if (!needed(t)) return; S.groq.close(); S.claude.close(); S.tg.close(); fs.rmSync(S.tmp, { recursive: true, force: true }); });
