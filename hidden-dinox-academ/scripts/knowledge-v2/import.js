#!/usr/bin/env node
"use strict";
/* Миграция базы знаний Hidden Dinox на v2 (Firestore по FIREBASE_KEY). По умолчанию — только просмотр (dry-run).
   node scripts/knowledge-v2/import.js                                        # dry-run: добавить / обновить / архивировать / дубли / ошибки
   node scripts/knowledge-v2/import.js --apply --backup-dir ./kb-backups      # резервная копия в файл → импорт в hd_knowledge_v2
   node scripts/knowledge-v2/import.js --verify                               # контрольные запросы по импортированной базе
   node scripts/knowledge-v2/import.js --activate v2 [--force]                # переключить AI Mentor на v2 (откат: --activate v1)
   node scripts/knowledge-v2/import.js --status
   node scripts/knowledge-v2/import.js --archive-v1 --backup-file F --confirm "ARCHIVE hd_knowledge"   # копия в hd_knowledge_archive, без удаления
   node scripts/knowledge-v2/import.js --delete-v1  --backup-file F --confirm "DELETE hd_knowledge"    # удаление старой базы — только после архивирования
   Не трогает published_courses, published_lessons, курсы и прогресс учеников. */
const fs = require("fs"), path = require("path");
const admin = require("firebase-admin");
const { initFirebase } = require("../../academy/firebase-init");
const KV2 = require("../../academy/knowledge-v2");
const args = process.argv.slice(2), has = n => args.includes(n), val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
(async () => {
  const { db, reason } = initFirebase({ admin, log: { log() {}, error: m => console.error(m) } });
  if (!db) { console.error("Firebase не подключён: " + reason); process.exit(2); }
  const K = KV2.createKnowledgeV2({ db }), who = "cli";
  if (has("--status")) { console.log(JSON.stringify(await K.status(), null, 1)); process.exit(0); }
  if (has("--verify")) { const r = await K.verify(who); console.log(`Контрольные запросы: ${r.passed}/${r.total} (порог ${Math.round(r.threshold * 100)}%) — ${r.ok ? "УСПЕХ" : "НЕ ПРОЙДЕНО"}`); for (const f of r.failed) console.log("  ✘", f.lang, f.q); process.exit(r.ok ? 0 : 1); }
  if (val("--activate")) { const r = await K.activate(val("--activate"), who, { force: has("--force") }); console.log("Активная база знаний:", r.active, "ревизия", r.revision); process.exit(0); }
  const readBackup = () => { const f = val("--backup-file"); if (!f || !fs.existsSync(f)) { console.error("Укажите существующий --backup-file"); process.exit(2); } return JSON.parse(fs.readFileSync(f, "utf8")); };
  if (has("--archive-v1")) { console.log(await K.archiveV1(readBackup(), val("--confirm"), who)); process.exit(0); }
  if (has("--delete-v1")) { console.log(await K.deleteV1(readBackup(), val("--confirm"), who)); process.exit(0); }
  const plan = await K.dryRun();
  console.log(`Записей в сборке: ${plan.records}\n  добавить: ${plan.add}\n  обновить: ${plan.update}\n  без изменений: ${plan.unchanged}\n  в архив (нет в сборке): ${plan.archive}\n  дублей: ${plan.duplicates}\n  ошибок схемы: ${plan.errors}`);
  if (plan.errors) { console.error(JSON.stringify(plan.error_examples, null, 1)); process.exit(1); }
  if (!has("--apply")) { console.log("Это просмотр. Для импорта: --apply --backup-dir <папка> (резервная копия обязательна)."); process.exit(0); }
  const dir = val("--backup-dir"); if (!dir) { console.error("Импорт без резервной копии запрещён: укажите --backup-dir"); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, `knowledge-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const bk = await K.backup(); fs.writeFileSync(file, JSON.stringify(bk)); console.log(`Резервная копия: ${file} (hd_knowledge ${bk.hd_knowledge.length}, версий ${bk.hd_knowledge_versions.length}, v2 ${bk.hd_knowledge_v2.length})`);
  const r = await K.apply(undefined, who, { backupRef: path.basename(file) });
  console.log(`Импорт завершён: записано ${r.written}, в архив ${r.archived}, ревизия ${r.revision}. Дальше: --verify, затем --activate v2.`);
  process.exit(0);
})().catch(e => { console.error("Ошибка:", e.message); process.exit(1); });
