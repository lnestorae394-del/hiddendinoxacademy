"use strict";
/* Запуск исполнителя и восстановление после перезапуска сервера.
   Регрессия: «this.cleanStale is not a function» — метод вызывался в start(), но был потерян при правке; исполнитель не стартовал, задания оставались без heartbeat. */
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path"), { spawn, spawnSync } = require("child_process");
const { FakeFirestore } = require("./video-studio-helpers/fake-firestore"), { COLL } = require("../video-studio/constants"), J = require("../video-studio/jobs");
const { Runner } = require("../video-studio/runner"), { Queue } = require("../video-studio/queue"), { memoryVideoStorage } = require("../video-studio/storage-adapter");
const HAS_FF = spawnSync("ffmpeg", ["-version"]).status === 0, LINUX = fs.existsSync("/proc/self/stat"), sleep = ms => new Promise(r => setTimeout(r, ms)), ROOT = path.join(__dirname, "..");
const mkLog = () => { const l = { errors: [], warns: [], infos: [], log: m => l.infos.push(String(m)), warn: m => l.warns.push(String(m)), error: (...a) => l.errors.push(a.join(" ")) }; return l; };
const doc = async (db, c, id) => (await db.collection(c).doc(id).get()).data();
const tmp = n => fs.mkdtempSync(path.join(os.tmpdir(), n));
test("статическая проверка связности: каждый вызов this.метод() и Модуль.функция() существует (ловит именно «this.cleanStale is not a function»)", () => {
  const dir = path.join(ROOT, "video-studio"), problems = [], files = fs.readdirSync(dir).filter(f => f.endsWith(".js") && !f.startsWith("._"));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8"), code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    /* 1. классы: this.name( внутри тела класса должен быть методом этого класса или присвоенным полем */
    const starts = [...code.matchAll(/^class (\w+)/gm)].map(m => ({ name: m[1], at: m.index }));
    starts.forEach((c, i) => {
      const body = code.slice(c.at, i + 1 < starts.length ? starts[i + 1].at : code.length), cls = require(path.join(dir, f))[c.name]; if (!cls) return;
      const assigned = new Set([...body.matchAll(/this\.(\w+)\s*=[^=]/g)].map(m => m[1])), viaAssign = [...body.matchAll(/Object\.assign\(this,\s*\{([^}]*)\}/g)].flatMap(m => m[1].split(",").map(x => x.trim().split(":")[0].trim())).filter(Boolean);
      for (const m of body.matchAll(/this\.(\w+)\(/g)) if (typeof cls.prototype[m[1]] !== "function" && !assigned.has(m[1]) && !viaAssign.includes(m[1])) problems.push(`${f}: this.${m[1]}() не определён в классе ${c.name}`);
    });
    /* 2. внешние вызовы Runner → this.queue.метод() */
    if (f === "runner.js") for (const m of code.matchAll(/this\.queue\.(\w+)\(/g)) if (typeof Queue.prototype[m[1]] !== "function") problems.push(`runner.js: this.queue.${m[1]}() не определён в Queue`);
    /* 3. модули: Имя.функция( где Имя = require("./модуль") */
    for (const im of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*["'](\.\/[\w-]+)["']\s*\)/g)) {
      const exp = require(path.join(dir, im[2])); for (const m of code.matchAll(new RegExp("\\b" + im[1] + "\\.(\\w+)\\(", "g"))) if (typeof exp[m[1]] !== "function") problems.push(`${f}: ${im[1]}.${m[1]}() — нет в экспорте ${im[2]}`);
    }
  }
  assert.deepEqual(problems, [], "оборванные ссылки:\n" + problems.join("\n"));
});
test("start(): исполнитель запускается без ошибок, убирает просроченные временные файлы (свежие не трогает), берёт и выполняет задание", { skip: !HAS_FF && "нет ffmpeg" }, async () => {
  const dir = tmp("vsrun-"), db = new FakeFirestore(), log = mkLog(), ran = []; fs.mkdirSync(path.join(dir, "old_job"), { recursive: true }); fs.writeFileSync(path.join(dir, "old_job", "x.bin"), "x"); fs.mkdirSync(path.join(dir, "fresh_job")); const old = (Date.now() - 7 * 3600 * 1000) / 1000; fs.utimesSync(path.join(dir, "old_job"), old, old);
  const r = new Runner({ db, storage: memoryVideoStorage(), env: { VIDEO_STUDIO_TMP: dir }, log, pollMs: 30, handlers: { probe: async ctx => { ran.push(ctx.job.id); return { ok: 1 }; } } });
  await r.start(); assert.deepEqual(log.errors, [], "в журнале нет ошибок запуска"); assert.equal(r.stopped, false); assert.ok(r.state.started_at && r.state.caps && r.state.caps.ok, "FFmpeg найден"); assert.ok(r.state.boot && r.state.boot.pid === process.pid);
  assert.ok(!fs.existsSync(path.join(dir, "old_job")), "просроченная папка удалена"); assert.ok(fs.existsSync(path.join(dir, "fresh_job")), "свежая папка не тронута");
  const { job } = await J.enqueue(db, Date.now, { type: "probe", project_id: "p1", owner_uid: "u", key: "k1", payload: {} }); r.kick(); const t0 = Date.now(); while (!ran.includes(job.id) && Date.now() - t0 < 4000) await sleep(20); r.stop();
  assert.ok(ran.includes(job.id), "задание выполнено после start()"); await sleep(100); assert.equal((await doc(db, COLL.jobs, job.id)).status, "succeeded"); fs.rmSync(dir, { recursive: true, force: true });
});
test("перезапуск сервера: чужое задание с живой арендой не трогается; после истечения аренды перехватывается один раз; данные проекта, клипа и исходное видео остаются на месте", { skip: !HAS_FF && "нет ffmpeg" }, async () => {
  const dir = tmp("vsrec-"), db = new FakeFirestore(), st = memoryVideoStorage(), log = mkLog(), t = Date.now(); st.put("video-studio/u/p1/source/original.mp4", { size: 123456 });
  await db.collection(COLL.projects).doc("p1").set({ id: "p1", owner_uid: "u", status: "analyzed", filename: "live.mp4", source_path: "video-studio/u/p1/source/original.mp4" }); await db.collection(COLL.clips).doc("c1").set({ id: "c1", project_id: "p1", owner_uid: "u", status: "rendering", title: "Клип" });
  const base = { id: "render_c1_x", type: "probe", project_id: "p1", clip_id: "c1", owner_uid: "u", status: "running", stage: "render", attempts: 1, max_attempts: 3, priority: 5, created_at: t - 9e5, started_at: t - 8e5, updated_at: t - 136000, heartbeat_at: t - 136000, next_run_at: 0, progress: 0, cancel_requested: false };
  await db.collection(COLL.jobs).doc(base.id).set(Object.assign({}, base, { lease: { owner: "dead-instance-1", token: "t", expires_at: t + 60000 } })); await db.collection(COLL.settings).doc("slots").set({ running: { [base.id]: { owner: "dead-instance-1", expires_at: t + 60000 } }, updated_at: t });
  const snap = async () => JSON.stringify([await doc(db, COLL.projects, "p1"), await doc(db, COLL.clips, "c1"), [...st.objects.keys()]]), before = await snap(), calls = [];
  const r = new Runner({ db, storage: st, env: { VIDEO_STUDIO_TMP: dir }, log, pollMs: 30, leaseMs: 400, workerId: "new-instance-2", handlers: { probe: async ctx => { calls.push(ctx.job.attempts); return { ok: 1 }; } } }); await r.start(); await sleep(400);
  assert.equal((await doc(db, COLL.jobs, base.id)).status, "running", "пока аренда прежнего исполнителя жива, задание не перехватывается"); assert.equal(calls.length, 0);
  await db.collection(COLL.jobs).doc(base.id).update({ lease: { owner: "dead-instance-1", token: "t", expires_at: Date.now() - 1000 } }); r.kick(); const t0 = Date.now(); while (!calls.length && Date.now() - t0 < 4000) await sleep(20); await sleep(150); r.stop();
  const j = await doc(db, COLL.jobs, base.id); assert.equal(j.status, "succeeded"); assert.deepEqual(calls, [2], "выполнено ровно один раз, попытка №2"); assert.deepEqual([j.last_retry.reason, j.last_retry.previous_owner, j.last_retry.restart_suspected], ["lease_expired_other_worker", "dead-instance-1", true]); assert.equal(j.attempt_history.length, 1 + 0 || j.attempt_history.length);
  assert.equal(await snap(), before, "проект, клип и исходное видео не изменены восстановлением"); assert.deepEqual(log.errors, []); fs.rmSync(dir, { recursive: true, force: true });
});
test("перезапуск при исчерпанных попытках: задание не выполняется бесконечно, а завершается ошибкой WORKER_LOST; клип получает понятный статус; видео и проект не тронуты", { skip: !HAS_FF && "нет ffmpeg" }, async () => {
  const dir = tmp("vsex-"), db = new FakeFirestore(), st = memoryVideoStorage(), log = mkLog(), t = Date.now(); let calls = 0; st.put("video-studio/u/p1/source/original.mp4", { size: 99 });
  await db.collection(COLL.projects).doc("p1").set({ id: "p1", owner_uid: "u", status: "analyzed", source_path: "video-studio/u/p1/source/original.mp4" }); await db.collection(COLL.clips).doc("c1").set({ id: "c1", project_id: "p1", owner_uid: "u", status: "rendering", title: "Клип" });
  await db.collection(COLL.jobs).doc("render_c1_y").set({ id: "render_c1_y", type: "render", project_id: "p1", clip_id: "c1", owner_uid: "u", status: "running", attempts: 3, max_attempts: 3, priority: 5, created_at: t - 1e6, updated_at: t - 136000, heartbeat_at: t - 136000, next_run_at: 0, lease: { owner: "dead-instance-1", token: "t", expires_at: t - 5000 }, cancel_requested: false });
  const r = new Runner({ db, storage: st, env: { VIDEO_STUDIO_TMP: dir }, log, pollMs: 30, workerId: "new-instance-2", handlers: { render: async () => { calls++; return {}; } } }); await r.start(); await sleep(500); r.stop();
  const j = await doc(db, COLL.jobs, "render_c1_y"); assert.equal(calls, 0, "обработка не запускалась повторно"); assert.equal(j.status, "failed"); assert.equal(j.error.code, "WORKER_LOST"); assert.match(j.error.message, /перезапуск|нехват/i); assert.equal(j.lease, null); assert.equal(j.attempts, 3, "счётчик попыток не вырос");
  const c = await doc(db, COLL.clips, "c1"); assert.equal(c.status, "error"); assert.equal(c.error.code, "WORKER_LOST"); assert.equal((await doc(db, COLL.projects, "p1")).status, "analyzed"); assert.ok(await st.stat("video-studio/u/p1/source/original.mp4"), "исходное видео на месте");
  const slots = await doc(db, COLL.settings, "slots"); assert.ok(!slots || !(slots.running || {})["render_c1_y"], "слот освобождён"); fs.rmSync(dir, { recursive: true, force: true });
});
test("процессы ffmpeg прежнего запуска (в рабочей папке сервера, без родителя) останавливаются при старте, посторонний ffmpeg не затрагивается", { skip: (!HAS_FF || !LINUX) && "нужен Linux и ffmpeg" }, async () => {
  const dir = tmp("vsorph-"), other = tmp("vsother-"), db = new FakeFirestore(), log = mkLog(); fs.mkdirSync(path.join(dir, "job_x"), { recursive: true });
  const args = out => ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-t", "120", "-c:v", "libx264", "-preset", "ultrafast", out], pidOf = marker => { for (const n of fs.readdirSync("/proc").filter(x => /^\d+$/.test(x))) { try { const c = fs.readFileSync("/proc/" + n + "/cmdline", "utf8"); if (c.includes(marker) && /ffmpeg/.test(c)) return Number(n); } catch (e) { /* ушёл */ } } return 0; };
  const orphanOut = path.join(dir, "job_x", "orphan_" + process.pid + ".mp4"), otherOut = path.join(other, "other_" + process.pid + ".mp4");
  spawnSync("sh", ["-c", `ffmpeg ${args(orphanOut).map(a => "'" + a + "'").join(" ")} >/dev/null 2>&1 &`]); spawnSync("sh", ["-c", `ffmpeg ${args(otherOut).map(a => "'" + a + "'").join(" ")} >/dev/null 2>&1 &`]); await sleep(700);
  const po = pidOf(orphanOut), px = pidOf(otherOut); try {
    assert.ok(po > 0 && px > 0, "оба тестовых процесса запущены: " + po + ", " + px); const r = new Runner({ db, storage: memoryVideoStorage(), env: { VIDEO_STUDIO_TMP: dir }, log, pollMs: 1e9, handlers: {} }); await r.start(); r.stop(); await sleep(400);
    assert.equal(pidOf(orphanOut), 0, "процесс прежнего запуска остановлен"); assert.ok(pidOf(otherOut) > 0, "посторонний ffmpeg не тронут"); assert.ok(log.warns.some(w => w.includes("pid=" + po)), "в журнале указан pid"); assert.deepEqual(log.errors, []);
  } finally { for (const p of [po, px]) if (p) try { process.kill(p, "SIGKILL"); } catch (e) { /* уже нет */ } fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});
