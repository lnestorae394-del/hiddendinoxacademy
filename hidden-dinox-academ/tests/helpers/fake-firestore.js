"use strict";
/* Тестовая Firestore в памяти (только для тестов).
   Повторяет важные правила настоящей Firestore:
   - в транзакции все чтения должны идти до записей;
   - create() падает, если документ существует; update() — если не существует;
   - set(..., {merge:true}) объединяет вложенные объекты;
   - транзакции выполняются последовательно (сериализуемость);
   - failNext / failAll имитируют недоступность базы. */
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
function deepMerge(a, b) {
  const out = isObj(a) ? clone(a) : {};
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : clone(v);
  return out;
}
function makeQuery(list, filters, order, lim) {
  const check = (v, op, val) => ({ "==": v === val, "!=": v !== val, ">=": v >= val, "<=": v <= val, ">": v > val, "<": v < val,
    "in": Array.isArray(val) && val.includes(v), "array-contains": Array.isArray(v) && v.includes(val) })[op];
  const run = () => {
    let docs = list().filter(d => filters.every(([f, op, val]) => { const v = String(f).split(".").reduce((o, k) => (o == null ? undefined : o[k]), d.data()); if (op !== "!=" && (v === undefined || v === null) && op !== "==") return false; return check(v, op, val); }));
    if (order) { const [f, dir] = order; const g = (d) => String(f).split(".").reduce((o, k) => (o == null ? undefined : o[k]), d.data()); docs.sort((a, b) => { const x = g(a), y = g(b); const r = x === y ? 0 : (x === undefined ? -1 : y === undefined ? 1 : (x < y ? -1 : 1)); return dir === "desc" ? -r : r; }); }
    if (lim != null) docs = docs.slice(0, lim);
    return docs;
  };
  return {
    where(f, op, val) { return makeQuery(list, [...filters, [f, op, val]], order, lim); },
    orderBy(f, dir) { return makeQuery(list, filters, [f, dir || "asc"], lim); },
    limit(n) { return makeQuery(list, filters, order, n); },
    async get() { const docs = run(); return { docs, size: docs.length, empty: !docs.length }; },
    count() { return { async get() { return { data: () => ({ count: run().length }) }; } }; }
  };
}
class Snap { constructor(id, data) { this.id = id; this.exists = data !== undefined; this._d = data; } data() { return clone(this._d); } }

/* Ограничения настоящего Firestore, которые тестовая база обязана воспроизводить:
   массив внутри массива запрещён («Property array contains an invalid nested entity»),
   undefined запрещён (если не включён ignoreUndefinedProperties), функции и символы недопустимы. */
function assertFirestoreValue(v, path, opts, inArray) {
  if (v === undefined) { if (opts.ignoreUndefined) return; throw Object.assign(new Error(`3 INVALID_ARGUMENT: Cannot use "undefined" as a Firestore value (found in field "${path}")`), { code: 3 }); }
  if (typeof v === "function" || typeof v === "symbol") throw Object.assign(new Error(`3 INVALID_ARGUMENT: invalid value in field "${path}"`), { code: 3 });
  if (Array.isArray(v)) {
    if (inArray) throw Object.assign(new Error("3 INVALID_ARGUMENT: Property array contains an invalid nested entity."), { code: 3, field: path });
    v.forEach((x, i) => assertFirestoreValue(x, `${path}[${i}]`, opts, true));
    return;
  }
  if (v && typeof v === "object" && !Buffer.isBuffer(v) && !(v instanceof Date)) for (const [k, x] of Object.entries(v)) assertFirestoreValue(x, path ? path + "." + k : k, opts, false);
}
class FakeFirestore {
  /* Для измерений: искусственная задержка каждой операции (мс) и счётчик операций */
  async _lat() { this.ops = (this.ops || 0) + 1; if (this.latency) await new Promise(r => setTimeout(r, this.latency)); }
  settings(o) { if (o && o.ignoreUndefinedProperties) this.ignoreUndefined = true; }
  constructor() { this.store = new Map(); this.failAll = false; this.failNext = 0; this._chain = Promise.resolve(); this.writes = 0; }
  _check() { if (this.failAll || this.failNext > 0) { if (this.failNext > 0) this.failNext--; const e = new Error("UNAVAILABLE: fake outage"); e.code = 14; throw e; } }
  _key(c, id) { return c + "/" + id; }
  _get(c, id) { return this.store.get(this._key(c, id)); }
  _put(c, id, d) { this.writes++; this.store.set(this._key(c, id), clone(d)); }
  collection(c) {
    const db = this;
    const list = () => [...db.store.entries()].filter(([k]) => k.startsWith(c + "/") && !k.slice(c.length + 1).includes("/")).map(([k, v]) => ({ id: k.slice(c.length + 1), data: () => clone(v), exists: true }));
    return {
    async get() { db._check(); await db._lat(); const docs = list(); return { docs, size: docs.length, empty: !docs.length }; },
    // Запросы: where (==, !=, >=, <=, >, <, in, array-contains), orderBy, limit, count — как в Admin SDK
    where(field, op, val) { return makeQuery(list, [[field, op, val]], null, null); },
    orderBy(field, dir) { return makeQuery(list, [], [field, dir || "asc"], null); },
    limit(n) { return makeQuery(list, [], null, n); },
    count() { return { async get() { db._check(); await db._lat(); const n = list().length; return { data: () => ({ count: n }) }; } }; },
    doc(id) {
      if (typeof id !== "string" || !id || id.includes("/")) throw new Error("bad doc id " + id);
      return {
        _c: c, _id: id, id,
        async get() { db._check(); await db._lat(); return new Snap(id, clone(db._get(c, id))); },
        async set(d, o) { db._check(); await db._lat(); db._applySet(c, id, d, o); },
        async update(d) { db._check(); await db._lat(); db._applyUpdate(c, id, d); },
        async delete() { db._check(); await db._lat(); db.store.delete(db._key(c, id)); }
      };
    } };
  }
  _applySet(c, id, d, o) { assertFirestoreValue(d, "", { ignoreUndefined: !!this.ignoreUndefined }, false); const cur = this._get(c, id); this._put(c, id, o && o.merge ? deepMerge(cur, d) : d); }
  _applyUpdate(c, id, d) { assertFirestoreValue(d, "", { ignoreUndefined: !!this.ignoreUndefined }, false); const cur = this._get(c, id); if (cur === undefined) { const e = new Error("NOT_FOUND"); e.code = 5; throw e; } this._put(c, id, Object.assign(clone(cur), clone(d))); }
  _applyCreate(c, id, d) { assertFirestoreValue(d, "", { ignoreUndefined: !!this.ignoreUndefined }, false); if (this._get(c, id) !== undefined) { const e = new Error("ALREADY_EXISTS"); e.code = 6; throw e; } this._put(c, id, d); }
  runTransaction(fn) {
    const run = async () => {
      this._check(); await this._lat();                                   // начало транзакции
      const ops = []; let wrote = false;
      const tx = {
        get: async ref => { if (wrote) throw new Error("Firestore: reads must come before writes in a transaction"); this._check(); await this._lat(); return new Snap(ref._id, clone(this._get(ref._c, ref._id))); },
        set: (ref, d, o) => { wrote = true; ops.push(() => this._applySet(ref._c, ref._id, d, o)); return tx; },
        update: (ref, d) => { wrote = true; ops.push(() => this._applyUpdate(ref._c, ref._id, d)); return tx; },
        create: (ref, d) => { wrote = true; ops.push(() => this._applyCreate(ref._c, ref._id, d)); return tx; },
        delete: ref => { wrote = true; ops.push(() => this.store.delete(this._key(ref._c, ref._id))); return tx; }
      };
      const res = await fn(tx);
      if (ops.length) await this._lat();                                  // фиксация
      const snapshot = new Map(this.store);
      try { for (const op of ops) op(); } catch (e) { this.store = snapshot; throw e; } // атомарность
      return res;
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }
  dump(c) { const out = {}; for (const [k, v] of this.store) if (k.startsWith(c + "/")) out[k.slice(c.length + 1)] = clone(v); return out; }
}
module.exports = { FakeFirestore };
