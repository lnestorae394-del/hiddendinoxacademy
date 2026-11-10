"use strict";
/* Автоматическая инициализация новой базы: служебные документы создаются ТОЛЬКО если их нет (create-only в транзакции), существующие данные не трогаются, повторный запуск ничего не дублирует.
   Коллекции Firestore создаёт сам при первой записи — пустые заготовки не нужны. */
const { COLL } = require("./constants"), S = require("./settings"), SCHEMA_VERSION = 1;
async function ensureDatabase(db, { now = () => Date.now(), log = console, projectId = null } = {}) {
  const t = now(), report = { created: [], existing: [], problems: [], schema_version: SCHEMA_VERSION, project: projectId };
  const docs = [[COLL.settings, "meta", { app: "hidden-dinox-video-studio", schema_version: SCHEMA_VERSION, created_at: t }], [COLL.settings, "general", Object.assign({}, S.DEFAULT_GENERAL, { updated_at: t, updated_by: "bootstrap" })]];
  for (const [c, id, data] of docs) {
    const r = db.collection(c).doc(id);
    const made = await db.runTransaction(async tx => { const s = await tx.get(r); if (s.exists) return false; tx.create(r, data); return true; });
    (made ? report.created : report.existing).push(c + "/" + id);
  }
  const meta = (await db.collection(COLL.settings).doc("meta").get()).data() || {};
  if (meta.schema_version > SCHEMA_VERSION) report.problems.push("база создана более новой версией (schema_version " + meta.schema_version + ")");
  if (meta.app && meta.app !== "hidden-dinox-video-studio") report.problems.push("служебный документ принадлежит другому приложению: " + meta.app);
  report.ok = report.problems.length === 0; if (report.created.length) log.log && log.log("🗄️ База Video Studio: создано " + report.created.join(", ")); return report;
}
module.exports = { ensureDatabase, SCHEMA_VERSION };
