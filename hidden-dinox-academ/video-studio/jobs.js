"use strict";
/* Очередь заданий (Firestore). Сервер только СТАВИТ, отменяет и повторяет задания; захват, аренду и выполнение делает воркер.
   id задания детерминирован (тип + объект + хэш параметров): повторный запрос с теми же данными не создаёт дубль. */
const crypto = require("crypto");
const { COLL } = require("./constants");
const budget = require("./budget");
const hash = o => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
const TERMINAL = ["succeeded", "failed", "cancelled"];

async function enqueue(db, now, { type, project_id, clip_id = null, owner_uid, key, payload = {}, reserved_usd = 0, max_attempts = 3, priority = 5 }) {
  const id = type + "_" + key, ref = db.collection(COLL.jobs).doc(id);
  const doc = { id, type, project_id, clip_id, owner_uid, status: "queued", stage: null, progress: 0, attempts: 0, max_attempts, priority, next_run_at: now(), lease: null, cancel_requested: false,
    payload, reserved_usd, cost: { actual_usd: 0 }, error: null, created_at: now(), updated_at: now() };
  const created = await db.runTransaction(async tx => { const s = await tx.get(ref); if (s.exists) return { exists: s.data() }; tx.create(ref, doc); return { ok: true }; });
  if (created.ok) return { job: doc, created: true };
  return { job: Object.assign({ id }, created.exists), created: false };
}
async function cancel(db, now, jobId) {
  const ref = db.collection(COLL.jobs).doc(jobId); let release = null;
  const out = await db.runTransaction(async tx => {
    const s = await tx.get(ref); if (!s.exists) return null; const j = s.data();
    if (TERMINAL.includes(j.status)) return { status: j.status, changed: false };
    if (j.status === "queued") { tx.update(ref, { status: "cancelled", cancel_requested: true, updated_at: now(), finished_at: now() }); if (j.reserved_usd) release = j; return { status: "cancelled", changed: true }; }
    tx.update(ref, { cancel_requested: true, updated_at: now() }); return { status: j.status, changed: true, cancelling: true };      // выполняется: воркер увидит флаг и остановится
  });
  if (out && release) await budget.release(db, now, jobId, budget.monthKey(release.created_at));
  return out;
}
async function retry(db, now, jobId) {
  const ref = db.collection(COLL.jobs).doc(jobId);
  return db.runTransaction(async tx => {
    const s = await tx.get(ref); if (!s.exists) return null; const j = s.data();
    if (!["failed", "cancelled"].includes(j.status)) return { status: j.status, changed: false };
    tx.update(ref, { status: "queued", attempts: 0, error: null, cancel_requested: false, lease: null, next_run_at: now(), progress: 0, retries: (j.retries || 0) + 1, updated_at: now(), finished_at: null }); return { status: "queued", changed: true };
  });
}
/* Перезапуск задания с новыми данными (результат устарел или прошлая попытка не удалась). Активное задание не трогаем. */
async function requeue(db, now, jobId, patch = {}) {
  const ref = db.collection(COLL.jobs).doc(jobId);
  return db.runTransaction(async tx => {
    const s = await tx.get(ref); if (!s.exists) return null; const j = s.data();
    if (!TERMINAL.includes(j.status)) return { status: j.status, changed: false };
    tx.update(ref, Object.assign({ status: "queued", attempts: 0, error: null, cancel_requested: false, lease: null, next_run_at: now(), progress: 0, stage: null, retries: (j.retries || 0) + 1, updated_at: now(), finished_at: null }, patch)); return { status: "queued", changed: true };
  });
}
module.exports = { enqueue, cancel, retry, requeue, hash, TERMINAL };
