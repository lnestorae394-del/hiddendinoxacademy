"use strict";
const crypto = require("crypto");
/* Очередь заданий Video Studio (Firestore): захват с арендой, heartbeat, повтор с задержкой, отмена, ограничение числа тяжёлых задач.
   Лимит max_running АТОМАРЕН: все экземпляры сервера меняют ОДИН общий документ слотов videoStudioSettings/queue_slots внутри той же транзакции,
   что и захват задания. Аренда упавшего экземпляра истекает сама — задание подхватывает другой (или тот же после перезапуска). */
const { COLL } = require("./constants");
const BACKOFF = [60, 300, 900], SLOTS = "queue_slots";
class LeaseLost extends Error {}
/* закрывает последнюю запись истории попыток результатом (успех / повтор / ошибка / отмена) */
const endHist = (j, outcome, reason, t) => { const h = (j.attempt_history || []).slice(-10); if (h.length) h[h.length - 1] = Object.assign({}, h[h.length - 1], { ended_at: t, outcome, end_reason: reason || null }); return h; };
class Queue {
  constructor({ db, workerId, now = () => Date.now(), leaseMs = 120000, maxRunning = 1 }) { Object.assign(this, { db, workerId, now, leaseMs, maxRunning }); this.tokens = new Map(); }   // token — уникальный номер ЭТОГО захвата: устаревшее выполнение не может завершить или затереть задание после перехвата
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
        const prev = j.lease || {}, same = prev.owner === this.workerId, takeover = ["claimed", "running"].includes(j.status), token = crypto.randomBytes(6).toString("hex");
        /* причина повторной попытки фиксируется в задании: перехват по истёкшей аренде (чужой исполнитель = перезапуск экземпляра/OOM; свой = heartbeat не проходил) или повтор после ошибки */
        const info = takeover ? { reason: same ? "lease_expired_same_worker" : "lease_expired_other_worker", previous_owner: prev.owner || null, previous_heartbeat_at: j.heartbeat_at || j.updated_at || null, previous_stage: j.stage || null, lease_overdue_ms: t - (prev.expires_at || 0), restart_suspected: !same } : j.attempts ? { reason: (j.error && j.error.code) || "retry", previous_error: j.error ? j.error.message : null } : null;
        const hist = (j.attempt_history || []).slice(-9).concat([{ attempt: attempts, owner: this.workerId, started_at: t, via: takeover ? "takeover" : j.attempts ? "retry" : "first", reason: info ? info.reason : null }]);
        tx.set(this.slotsRef, { running, updated_at: t });
        tx.update(jref, Object.assign({ status: "claimed", attempts, lease: { owner: this.workerId, token, expires_at: t + this.leaseMs }, updated_at: t, heartbeat_at: t, started_at: j.started_at || t, attempt_history: hist }, info ? { last_retry: Object.assign({ at: t, attempt: attempts }, info) } : {}));
        return Object.assign({}, j, { id: c.id, status: "claimed", attempts, lease_token: token, last_retry: info });
      });
      if (r === "BUSY") return null; if (r) { this.tokens.set(c.id, r.lease_token); return r; }
    }
    return null;
  }
  async owned(tx, id) { const s = await tx.get(this.job(id)); const l = s.exists ? (s.data().lease || {}) : {}; if (!s.exists || l.owner !== this.workerId || (this.tokens.has(id) && l.token !== this.tokens.get(id))) throw new LeaseLost(id); return s.data(); }
  async heartbeat(id, stage, progress, extra) {
    const limit = Math.max(1, Math.floor(this.maxRunning || 1));
    return this.db.runTransaction(async tx => {
      const t = this.now(), j = await this.owned(tx, id), running = this.live(await tx.get(this.slotsRef), t);
      if (!running[id] && Object.keys(running).length >= limit) throw new LeaseLost(id);                    // свой слот истёк, а свободных нет — аренда потеряна
      running[id] = { owner: this.workerId, expires_at: t + this.leaseMs }; tx.set(this.slotsRef, { running, updated_at: t });
      const p = { status: "running", lease: { owner: this.workerId, token: this.tokens.get(id) || (j.lease || {}).token || null, expires_at: t + this.leaseMs }, updated_at: t, heartbeat_at: t }; if (extra) Object.assign(p, extra, { heartbeat_at: t }); if (stage !== undefined) p.stage = stage; if (progress !== undefined) p.progress = progress;
      tx.update(this.job(id), p); return !!j.cancel_requested;
    });
  }
  async free(tx, id, t) { const running = this.live(await tx.get(this.slotsRef), t); delete running[id]; tx.set(this.slotsRef, { running, updated_at: t }); }
  async finish(id, result, cost) { return this.db.runTransaction(async tx => { const t = this.now(), j0 = await this.owned(tx, id); await this.free(tx, id, t); const p = { status: "succeeded", progress: 100, finished_at: t, updated_at: t, lease: null, error: null, attempt_history: endHist(j0, "succeeded", null, t) }; if (result !== undefined) p.result = result; if (cost) p.cost = cost; tx.update(this.job(id), p); }); }
  /* остановка экземпляра (SIGTERM при деплое/перезапуске Render): задание возвращается в очередь СРАЗУ, без ожидания истечения аренды и без траты попытки */
  async release(id, reason) { return this.db.runTransaction(async tx => { const t = this.now(), j = await this.owned(tx, id); await this.free(tx, id, t); tx.update(this.job(id), { status: "queued", next_run_at: t, lease: null, updated_at: t, attempts: Math.max(0, (j.attempts || 1) - 1), last_retry: { reason, at: t, attempt: j.attempts || 1, previous_owner: this.workerId }, attempt_history: endHist(j, "released", reason, t) }); }); }
  async cancelDone(id) { return this.db.runTransaction(async tx => { const t = this.now(), j0 = await this.owned(tx, id); await this.free(tx, id, t); tx.update(this.job(id), { status: "cancelled", finished_at: t, updated_at: t, lease: null, attempt_history: endHist(j0, "cancelled", null, t) }); }); }
  /* → "retry" (будет повтор с задержкой) или "failed" (окончательно) */
  async fail(id, code, message, retryable, retryAfterSec) {
    return this.db.runTransaction(async tx => {
      const t = this.now(), j = await this.owned(tx, id), att = j.attempts || 1; await this.free(tx, id, t);
      if (retryable && att < (j.max_attempts || 3)) { const delay = Math.max(retryAfterSec || 0, BACKOFF[Math.min(att - 1, BACKOFF.length - 1)]); tx.update(this.job(id), { status: "queued", next_run_at: t + delay * 1000, lease: null, updated_at: t, last_failure: { code, message: String(message).slice(0, 300), at: t, attempt: att, retryable: true }, attempt_history: endHist(j, "retry", code, t), error: { code, message: String(message).slice(0, 300), retrying: true } }); return "retry"; }
      tx.update(this.job(id), { status: "failed", finished_at: t, updated_at: t, lease: null, last_failure: { code, message: String(message).slice(0, 300), at: t, attempt: att, retryable: !!retryable }, attempt_history: endHist(j, "failed", code, t), error: { code, message: String(message).slice(0, 300) } }); return "failed";
    });
  }
}
module.exports = { Queue, LeaseLost, BACKOFF };
