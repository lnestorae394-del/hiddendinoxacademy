"use strict";
/* Очередь заданий Video Studio (Firestore): захват с арендой, heartbeat, повтор с задержкой, отмена, ограничение числа тяжёлых задач.
   Лимит max_running АТОМАРЕН: все экземпляры сервера меняют ОДИН общий документ слотов videoStudioSettings/queue_slots внутри той же транзакции,
   что и захват задания. Аренда упавшего экземпляра истекает сама — задание подхватывает другой (или тот же после перезапуска). */
const { COLL } = require("./constants");
const BACKOFF = [60, 300, 900], SLOTS = "queue_slots";
class LeaseLost extends Error {}
class Queue {
  constructor({ db, workerId, now = () => Date.now(), leaseMs = 120000, maxRunning = 1 }) { Object.assign(this, { db, workerId, now, leaseMs, maxRunning }); }
  job(id) { return this.db.collection(COLL.jobs).doc(id); }
  get slotsRef() { return this.db.collection(COLL.settings).doc(SLOTS); }
  async candidates() {
    const t = this.now(), out = [], col = this.db.collection(COLL.jobs);
    for (const d of (await col.where("status", "==", "queued").get()).docs) { const j = d.data(); if ((j.next_run_at || 0) <= t) out.push(Object.assign({ id: d.id }, j)); }
    for (const st of ["claimed", "running"]) for (const d of (await col.where("status", "==", st).get()).docs) { const j = d.data(); if (((j.lease || {}).expires_at || 0) <= t) out.push(Object.assign({ id: d.id }, j)); }
    return out.sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5) || (a.created_at || 0) - (b.created_at || 0));
  }
  live(snap, t) { const run = ((snap.exists ? snap.data() : {}).running) || {}, out = {}; for (const [k, v] of Object.entries(run)) if (((v || {}).expires_at || 0) > t) out[k] = v; return out; }
  async claim() {
    const limit = Math.max(1, Math.floor(this.maxRunning || 1));
    for (const c of await this.candidates()) {
      const r = await this.db.runTransaction(async tx => {
        const t = this.now(), jref = this.job(c.id), js = await tx.get(jref), ss = await tx.get(this.slotsRef);        // все чтения — до записей
        if (!js.exists) return null; const j = js.data(), running = this.live(ss, t), expired = ((j.lease || {}).expires_at || 0) <= t;
        if (!((j.status === "queued" && (j.next_run_at || 0) <= t) || (["claimed", "running"].includes(j.status) && expired))) return null;
        if (j.cancel_requested) { delete running[c.id]; tx.set(this.slotsRef, { running, updated_at: t }); tx.update(jref, { status: "cancelled", finished_at: t, updated_at: t, lease: null }); return null; }
        delete running[c.id]; if (Object.keys(running).length >= limit) return "BUSY";
        running[c.id] = { owner: this.workerId, expires_at: t + this.leaseMs }; const attempts = (j.attempts || 0) + 1;
        tx.set(this.slotsRef, { running, updated_at: t });
        tx.update(jref, { status: "claimed", attempts, lease: { owner: this.workerId, expires_at: t + this.leaseMs }, updated_at: t, started_at: j.started_at || t });
        return Object.assign({}, j, { id: c.id, status: "claimed", attempts });
      });
      if (r === "BUSY") return null; if (r) return r;
    }
    return null;
  }
  async owned(tx, id) { const s = await tx.get(this.job(id)); if (!s.exists || ((s.data().lease || {}).owner) !== this.workerId) throw new LeaseLost(id); return s.data(); }
  async heartbeat(id, stage, progress) {
    const limit = Math.max(1, Math.floor(this.maxRunning || 1));
    return this.db.runTransaction(async tx => {
      const t = this.now(), j = await this.owned(tx, id), running = this.live(await tx.get(this.slotsRef), t);
      if (!running[id] && Object.keys(running).length >= limit) throw new LeaseLost(id);                    // свой слот истёк, а свободных нет — аренда потеряна
      running[id] = { owner: this.workerId, expires_at: t + this.leaseMs }; tx.set(this.slotsRef, { running, updated_at: t });
      const p = { status: "running", lease: { owner: this.workerId, expires_at: t + this.leaseMs }, updated_at: t }; if (stage !== undefined) p.stage = stage; if (progress !== undefined) p.progress = progress;
      tx.update(this.job(id), p); return !!j.cancel_requested;
    });
  }
  async free(tx, id, t) { const running = this.live(await tx.get(this.slotsRef), t); delete running[id]; tx.set(this.slotsRef, { running, updated_at: t }); }
  async finish(id, result, cost) { return this.db.runTransaction(async tx => { const t = this.now(); await this.owned(tx, id); await this.free(tx, id, t); const p = { status: "succeeded", progress: 100, finished_at: t, updated_at: t, lease: null, error: null }; if (result !== undefined) p.result = result; if (cost) p.cost = cost; tx.update(this.job(id), p); }); }
  async cancelDone(id) { return this.db.runTransaction(async tx => { const t = this.now(); await this.owned(tx, id); await this.free(tx, id, t); tx.update(this.job(id), { status: "cancelled", finished_at: t, updated_at: t, lease: null }); }); }
  /* → "retry" (будет повтор с задержкой) или "failed" (окончательно) */
  async fail(id, code, message, retryable, retryAfterSec) {
    return this.db.runTransaction(async tx => {
      const t = this.now(), j = await this.owned(tx, id), att = j.attempts || 1; await this.free(tx, id, t);
      if (retryable && att < (j.max_attempts || 3)) { const delay = Math.max(retryAfterSec || 0, BACKOFF[Math.min(att - 1, BACKOFF.length - 1)]); tx.update(this.job(id), { status: "queued", next_run_at: t + delay * 1000, lease: null, updated_at: t, error: { code, message: String(message).slice(0, 300), retrying: true } }); return "retry"; }
      tx.update(this.job(id), { status: "failed", finished_at: t, updated_at: t, lease: null, error: { code, message: String(message).slice(0, 300) } }); return "failed";
    });
  }
}
module.exports = { Queue, LeaseLost, BACKOFF };
