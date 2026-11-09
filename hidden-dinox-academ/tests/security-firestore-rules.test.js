"use strict";
/* Аудит правил Firestore: каждая коллекция, которую использует сервер, закрыта для клиентов; в клиентском коде нет прямой работы с Firestore. */
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path");
const root = path.join(__dirname, ".."), rules = fs.readFileSync(path.join(root, "firestore.rules.academy-proposal"), "utf8");
const walk = (d, ext, out = []) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (n === "node_modules" || n.startsWith("._") || n === ".git") continue; const st = fs.statSync(p); if (st.isDirectory()) walk(p, ext, out); else if (ext.test(n)) out.push(p); } return out; };
test("каждая коллекция серверного кода явно закрыта для клиентов, есть запрет по умолчанию, нет «allow … if true»", () => {
  const names = new Set(); for (const f of [path.join(root, "server.js"), ...walk(path.join(root, "academy"), /\.js$/), ...walk(path.join(root, "bot"), /\.js$/), ...walk(path.join(root, "scripts"), /\.js$/)]) { const t = fs.readFileSync(f, "utf8"); for (const m of t.matchAll(/\bcol\(\s*["']([A-Za-z0-9_]+)["']\s*\)|\.collection\(\s*["']([A-Za-z0-9_]+)["']\s*\)/g)) names.add(m[1] || m[2]); }
  for (const m of fs.readFileSync(path.join(root, "video-studio", "constants.js"), "utf8").matchAll(/"(videoStudio\w+)"/g)) names.add(m[1]);
  assert.ok(names.size >= 50, "найдено коллекций: " + names.size); const open = [];
  for (const n of names) if (!new RegExp("match /" + n + "/\\{[^}]*\\}\\s*\\{\\s*allow read, write: if false;\\s*\\}").test(rules) && !new RegExp("match /" + n + "/\\{\\w+\\}\\s*\\{\\s*allow read, write: if false;").test(rules)) open.push(n);
  assert.deepEqual(open, [], "коллекции без явного запрета в правилах: " + open.join(", "));
  assert.match(rules, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/, "нет запрета по умолчанию"); assert.ok(!/if\s+true\s*;/.test(rules.replace(/\/\/[^\n]*/g, "")), "в правилах есть allow … if true");
});
test("в клиентском коде нет прямой работы с Firestore (поэтому полный запрет в правилах не ломает сайт)", () => {
  const bad = []; for (const f of walk(path.join(root, "public"), /\.(js|html)$/)) { if (/[\\/]bot[\\/]/.test(f)) continue; const t = fs.readFileSync(f, "utf8"); if (/getFirestore|firebase-firestore|\bsetDoc\(|\bupdateDoc\(|\baddDoc\(|\bgetDocs?\(|onSnapshot\(/.test(t)) bad.push(path.relative(root, f)); }
  assert.deepEqual(bad, []);
});
