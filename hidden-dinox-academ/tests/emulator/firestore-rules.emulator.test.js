"use strict";
/* Проверка правил Firestore на ЭМУЛЯТОРЕ (никакого доступа к production: проект «demo-…» существует только в эмуляторе).
   Запуск — см. docs/EMULATOR_TESTING.md. Без эмулятора и пакета @firebase/rules-unit-testing тест честно ПРОПУСКАЕТСЯ (не считается пройденным).
   ВНИМАНИЕ: этот файл написан, но в среде разработки НЕ запускался (там нет эмулятора). */
const test = require("node:test"), fs = require("fs"), path = require("path");
let T = null; try { T = require("@firebase/rules-unit-testing"); } catch (e) { T = null; }
const hostPort = process.env.FIRESTORE_EMULATOR_HOST, PROJECT = "demo-hd-rules";
const skip = !T ? "нет пакета @firebase/rules-unit-testing (npm i -D @firebase/rules-unit-testing)" : !hostPort ? "эмулятор не запущен (нет FIRESTORE_EMULATOR_HOST)" : false;
const root = path.join(__dirname, "..", "..");
const walk = (d, out = []) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (n === "node_modules" || n.startsWith("._")) continue; const st = fs.statSync(p); if (st.isDirectory()) walk(p, out); else if (/\.js$/.test(n)) out.push(p); } return out; };
function collections() {
  const names = new Set(); for (const f of [path.join(root, "server.js"), ...walk(path.join(root, "academy")), ...walk(path.join(root, "bot"))]) for (const m of fs.readFileSync(f, "utf8").matchAll(/\bcol\(\s*["']([A-Za-z0-9_]+)["']\s*\)|\.collection\(\s*["']([A-Za-z0-9_]+)["']\s*\)/g)) names.add(m[1] || m[2]);
  for (const m of fs.readFileSync(path.join(root, "video-studio", "constants.js"), "utf8").matchAll(/"(videoStudio\w+)"/g)) names.add(m[1]); names.add("коллекция_которой_нет_в_правилах".replace(/[^\x00-\x7F]/g, "x")); return [...names];
}
test("эмулятор: ни аноним, ни вошедший пользователь, ни «админ» с клиента не читают и не пишут ни одну коллекцию", { skip }, async () => {
  const [host, port] = hostPort.split(":"), env = await T.initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(path.join(root, "firestore.rules.academy-proposal"), "utf8"), host, port: Number(port) } });
  try {
    await env.withSecurityRulesDisabled(async ctx => { await ctx.firestore().collection("users").doc("u1").set({ role: "student", secret: 1 }); });      // как Admin SDK: правила не применяются
    for (const name of collections()) for (const ctx of [env.unauthenticatedContext(), env.authenticatedContext("u1"), env.authenticatedContext("adm", { role: "super_admin", admin: true })]) {
      const ref = ctx.firestore().collection(name).doc("u1");
      await T.assertFails(ref.get()); await T.assertFails(ref.set({ role: "super_admin" })); await T.assertFails(ref.update({ role: "super_admin" })); await T.assertFails(ctx.firestore().collection(name).get());
    }
  } finally { await env.cleanup(); }
});
