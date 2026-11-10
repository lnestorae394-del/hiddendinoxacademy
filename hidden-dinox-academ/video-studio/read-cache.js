"use strict";
/* Кэш чтений Firestore для Video Studio (в памяти процесса). Нужен, чтобы частый опрос интерфейса и цикл исполнителя не читали одни и те же документы по кругу.
   Правила свежести: настройки, пользователь, снимки коллекций и ответы монитора живут короткое время (TTL из переменных окружения; 0 = выключено),
   ЛЮБОЕ изменение через API и любое изменение состояния задания исполнителем сразу сбрасывает кэш данных — готовый или ошибочный статус не может «застрять». */
const { unwrap } = require("./read-meter"), WM = new WeakMap(), num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
function st(db) { const k = unwrap(db); let s = WM.get(k); if (!s) { s = { ttl: { settings: 0, auth: 0, snap: 0, mon: 0 }, gen: 0, one: new Map(), users: new Map(), snaps: new Map(), memo: new Map(), hits: 0, misses: 0 }; WM.set(k, s); } return s; }
function configure(db, env = {}) { const s = st(db); for (const [k, v] of [["settings", "VIDEO_STUDIO_SETTINGS_CACHE_MS"], ["auth", "VIDEO_STUDIO_AUTH_CACHE_MS"], ["snap", "VIDEO_STUDIO_SNAP_CACHE_MS"], ["mon", "VIDEO_STUDIO_MONITOR_CACHE_MS"]]) if (env[v] !== undefined) s.ttl[k] = num(env[v]); return s.ttl; }
async function get(s, map, key, ttl, fn) {
  if (!ttl) return fn(); const e = map.get(key); if (e && Date.now() - e.t < ttl) { s.hits++; return e.p; } s.misses++;
  const gen = s.gen, ent = { t: Date.now(), p: Promise.resolve().then(fn) }; map.set(key, ent);
  ent.p.then(() => { if (s.gen !== gen && map.get(key) === ent) map.delete(key); }, () => { if (map.get(key) === ent) map.delete(key); });   // ошибка не кэшируется; ответ, начатый до изменения, не остаётся в кэше
  return ent.p;
}
const settings = (db, fn) => { const s = st(db); return get(s, s.one, "settings", s.ttl.settings, fn); }, user = (db, uid, fn) => { const s = st(db); return get(s, s.users, uid, s.ttl.auth, fn); };
const memo2 = null;
const all = (db, coll, fn) => { const s = st(db); return get(s, s.snaps, coll, s.ttl.snap, fn).then(a => (Array.isArray(a) ? a.slice() : a)); }, memo = (db, key, fn, mult = 1) => { const s = st(db); return get(s, s.memo, key, s.ttl.mon * mult, fn); };
/* scope "data" — данные заданий/клипов/проектов; "all" — ещё настройки и пользователи */
function invalidate(db, scope = "all") { const s = st(db); s.gen++; s.snaps.clear(); s.memo.clear(); if (scope === "all") { s.one.clear(); s.users.clear(); } }
const stats = db => { const s = st(db); return { ttl: Object.assign({}, s.ttl), hits: s.hits, misses: s.misses }; };
module.exports = { configure, settings, user, all, memo, invalidate, stats };
