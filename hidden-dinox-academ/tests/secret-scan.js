"use strict";
/* Поиск секретов во всех файлах проекта (кроме node_modules и .git). Публичная веб-конфигурация Firebase (ключ «AIza…») в файлах проекта не допускается:
   она приходит с сервера из переменной окружения FIREBASE_WEB_CONFIG. */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const PATTERNS = [
  ["приватный ключ", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["сервисный аккаунт", /"type"\s*:\s*"service_account"|private_key_id/],
  ["токен Telegram-бота", /\b\d{8,10}:[A-Za-z0-9_-]{30,50}(?![A-Za-z0-9_-])/],
  ["ключ Google API", /AIza[0-9A-Za-z_-]{35}/],
  ["ключ Anthropic", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["ключ Groq", /gsk_[A-Za-z0-9]{20,}/]
];
const files = [];
(function walk(d) { for (const n of fs.readdirSync(d)) { if (n === "node_modules" || n === ".git" || n.startsWith("._")) continue; const p = path.join(d, n), s = fs.statSync(p); if (s.isDirectory()) walk(p); else if (/\.(js|html|css|json|md|txt|sh|py|yml|yaml|rules)$/.test(n) || n === "Dockerfile.render") files.push(p); } })(ROOT);
/* заведомо поддельные значения в тестах (проверяют маскирование и разбор ключей) */
const FAKE = { "tests/video-studio-insights.test.js": ["ключ Groq"], "tests/video-studio-standalone.test.js": ["приватный ключ"] };
const found = [];
for (const f of files) {
  const rel = path.relative(ROOT, f); if (rel === "tests/secret-scan.js") continue;
  const s = fs.readFileSync(f, "utf8");
  for (const [name, re] of PATTERNS) if (re.test(s) && !(FAKE[rel] || []).includes(name)) found.push(`${rel}: ${name}`);
}
console.log(`проверено файлов: ${files.length}`);
console.log(found.length ? "НАЙДЕНО:\n" + found.join("\n") : "секретов не найдено");
process.exit(found.length ? 1 : 0);
