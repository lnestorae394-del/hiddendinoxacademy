"use strict";
/* Очередь: лимит одновременных задач АТОМАРЕН. Тестовая Firestore ведёт себя как настоящая: транзакции оптимистичные (при конфликте повторяются),
   запросы вне транзакции не защищают от гонки, у чтений есть задержка — воркеры гарантированно пересекаются. */
const test = require("node:test"), assert = require("node:assert/strict");
const { FakeFirestore } = require("./video-studio-helpers/fake-firestore"), { Queue } = require("../video-studio/queue"), { COLL } = require("../video-studio/constants");
const sleep = ms => new Promise(r => setTimeout(r, ms)), RETRY = Symbol("retry");
class OptimisticFirestore extends FakeFirestore {
  constructor(lat = 0) { super(); this.lat = lat; this._commit = Promise.resolve(); }
  runTransaction(fn) {
    const attempt = async n => {
      const reads = new Map(), ops = []; let wrote = false;
      const tx = { get: async ref => { if (wrote) throw new Error("reads must come before writes"); const s = await ref.get(); if (this.lat) await sleep(this.lat); reads.set(ref._c + "/" + ref._id, JSON.stringify(s.exists ? s.data() : null)); return s; },
        set: (ref, d, o) => { wrote = true; ops.push(() => this._applySet(ref._c, ref._id, d, o)); return tx; }, update: (ref, d) => { wrote = true; ops.push(() => this._applyUpdate(ref._c, ref._id, d)); return tx; },
        create: (ref, d) => { wrote = true; ops.push(() => this._applyCreate(ref._c, ref._id, d)); return tx; }, delete: ref => { wrote = true; ops.push(() => this.store.delete(this._key(ref._c, ref._id))); return tx; } };
      const res = await fn(tx);
      const done = this._commit.then(() => {                      // фиксация атомарна: сверка версий прочитанного и применение записей без пауз
        for (const [k, v] of reads) { const i = k.indexOf("/"), cur = this._get(k.slice(0, i), k.slice(i + 1)); if (JSON.stringify(cur === undefined ? null : cur) !== v) return RETRY; }
        const snap = new Map(this.store); try { for (const op of ops) op(); } catch (e) { this.store = snap; throw e; } return res;
      });
      this._commit = done.catch(() => {}); const r = await done; if (r === RETRY) { if (n >= 40) throw new Error("слишком много конфликтов"); return attempt(n + 1); } return r;
    };
    return attempt(0);
  }
}
class RotQueue extends Queue {                                    // каждый воркер целится в РАЗНОЕ задание (например, пришло задание с более высоким приоритетом)
  async candidates() { const c = await super.candidates(); const k = c.length ? this.rot % c.length : 0; return c.slice(k).concat(c.slice(0, k)); }
}
const mk = async (db, n) => { for (let i = 0; i < n; i++) await db.collection(COLL.jobs).doc("j" + i).set({ type: "analyze", status: "queued", attempts: 0, max_attempts: 3, priority: 5, next_run_at: 0, created_at: i, lease: null, cancel_requested: false }); };
const running = async db => (await db.collection(COLL.jobs).get()).docs.filter(d => ["claimed", "running"].includes(d.data().status)).length;
const NOW = 1_800_000_000_000;
async function race(db, workers, maxRunning) {
  const qs = Array.from({ length: workers }, (_, i) => Object.assign(new RotQueue({ db, workerId: "w" + i, now: () => NOW, maxRunning }), { rot: i }));
  return (await Promise.all(qs.map(q => q.claim()))).filter(Boolean);
}
test("два воркера одновременно (разные задания) не превышают лимит 1", async () => { for (let i = 0; i < 20; i++) { const db = new OptimisticFirestore(3); await mk(db, 2); const got = await race(db, 2, 1); assert.ok(got.length <= 1, "проба " + i + ": взяли " + got.map(g => g.id)); assert.ok(await running(db) <= 1); } });
test("шесть воркеров одновременно не превышают лимит 2, и задание достаётся одному", async () => { for (let i = 0; i < 8; i++) { const db = new OptimisticFirestore(3); await mk(db, 6); const got = await race(db, 6, 2); assert.ok(got.length <= 2, String(got.length)); assert.equal(new Set(got.map(g => g.id)).size, got.length); assert.ok(await running(db) <= 2); } });
test("слот освобождается при завершении, ошибке и отмене; heartbeat его удерживает; упавший воркер освобождает слот по истечении аренды", async () => {
  const db = new OptimisticFirestore(), t = { v: NOW }, now = () => t.v; await mk(db, 5); const a = new Queue({ db, workerId: "a", now, leaseMs: 120000, maxRunning: 1 }), b = new Queue({ db, workerId: "b", now, leaseMs: 120000, maxRunning: 1 });
  let j = await a.claim(); assert.ok(j); assert.equal(await b.claim(), null, "слот занят"); await a.finish(j.id); j = await b.claim(); assert.ok(j, "после finish свободно");
  assert.equal(await b.fail(j.id, "X", "x", false), "failed"); j = await a.claim(); assert.ok(j, "после fail свободно"); await a.cancelDone(j.id); j = await b.claim(); assert.ok(j, "после отмены свободно");
  t.v += 100000; await b.heartbeat(j.id); t.v += 100000; assert.equal(await a.claim(), null, "heartbeat продлил слот"); t.v += 130000; const j2 = await a.claim(); assert.ok(j2, "аренда упавшего истекла: слот свободен, задание перехвачено"); assert.equal(j2.id, j.id); assert.equal(j2.attempts, 2);
});
test("повтор с задержкой: временный сбой возвращает задание в очередь после паузы, постоянный — завершает", async () => {
  const db = new OptimisticFirestore(), t = { v: NOW }, now = () => t.v; await mk(db, 1); const q = new Queue({ db, workerId: "a", now, maxRunning: 1 });
  let j = await q.claim(); assert.equal(await q.fail(j.id, "TG_RATE_LIMIT", "x", true, 200), "retry"); const d = (await db.collection(COLL.jobs).doc("j0").get()).data(); assert.equal(d.status, "queued"); assert.ok(d.next_run_at >= NOW + 200000, "учтён retry_after"); assert.equal(await q.claim(), null);
  t.v += 201000; j = await q.claim(); assert.equal(j.attempts, 2); assert.equal(await q.fail(j.id, "E", "x", true), "retry"); t.v += 400000; j = await q.claim(); assert.equal(await q.fail(j.id, "E", "x", true), "failed", "после трёх попыток — окончательно");
});
test("отмена: поставленное в очередь с cancel_requested не берётся в работу и не занимает слот", async () => {
  const db = new OptimisticFirestore(), t = { v: NOW }, now = () => t.v; await mk(db, 2); await db.collection(COLL.jobs).doc("j0").update({ cancel_requested: true }); const q = new Queue({ db, workerId: "a", now, maxRunning: 1 });
  const j = await q.claim(); assert.equal(j.id, "j1"); assert.equal((await db.collection(COLL.jobs).doc("j0").get()).data().status, "cancelled");
});
