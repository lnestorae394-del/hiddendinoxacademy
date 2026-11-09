"use strict";
/* Поиск секретов в публичных файлах академии и модулях сервера.
   Web Config Firebase (apiKey "AIza…") публичен по своей природе и разрешён только в public/academy/js/config.js. */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const PATTERNS = [
  ["приватный ключ", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["сервисный аккаунт", /"type"\s*:\s*"service_account"|private_key_id/],
  ["токен Telegram-бота", /\b\d{8,10}:[A-Za-z0-9_-]{30,50}(?![A-Za-z0-9_-])/],
  ["секрет postback в коде", /POSTBACK_SECRET\s*[:=]\s*["'][^"']+["']/],
  ["ключ Google API вне config.js", /AIza[0-9A-Za-z_-]{35}/]
];
const files = [];
(function walk(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else if (/\.(js|html|css|json|md|txt)$/.test(n)) files.push(p); } })(path.join(ROOT, "public/academy"));
for (const f of fs.readdirSync(path.join(ROOT, "academy"))) files.push(path.join(ROOT, "academy", f));
files.push(path.join(ROOT, "server.js"));
for (const f of [".env.test.example", "firebase.json", ".firebaserc"]) if (fs.existsSync(path.join(ROOT, f))) files.push(path.join(ROOT, f));
const found = [];
for (const f of files) {
  const rel = path.relative(ROOT, f), s = fs.readFileSync(f, "utf8");
  for (const [name, re] of PATTERNS) {
    if (!re.test(s)) continue;
    if (name.startsWith("ключ Google API") && rel === "public/academy/js/config.js") continue;
    found.push(`${rel}: ${name}`);
  }
}
console.log(`проверено файлов: ${files.length}`);
console.log(found.length ? "НАЙДЕНО:\n" + found.join("\n") : "секретов не найдено");
process.exit(found.length ? 1 : 0);
