"use strict";
/* База знаний v2: сборка из реальных исходников, поиск, безопасная миграция и использование AI Mentor. */
const test = require("node:test"), assert = require("node:assert"), path = require("path"), fs = require("fs"), crypto = require("crypto");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify } = require("./helpers/http");
const { adminCaller, learnCaller } = require("./helpers/router");
const { createAdminApi } = require("../academy/admin-api");
const { createLearnApi } = require("../academy/learn-api");
const { createAcademyApi } = require("../academy/api");
const KV2 = require("../academy/knowledge-v2");
const ROOT = path.join(__dirname, ".."), quiet = { log() {}, warn() {}, error() {} };
const B = KV2.loadBundled();
const sha = p => crypto.createHash("sha1").update(fs.readFileSync(path.join(ROOT, p))).digest("hex");

test("сборка: все записи по схеме, id уникальны, черновые переводы не verified, исходники курсов не изменены", () => {
  assert.ok(B.records.length > 2000);
  assert.deepStrictEqual(B.records.map(KV2.validateRecord).filter(Boolean), []);
  assert.strictEqual(new Set(B.records.map(r => r.id)).size, B.records.length);
  assert.ok(B.records.filter(r => r.translation_status === "draft").every(r => r.verified === false && r.status === "draft"));
  for (const lang of ["ru", "en", "ua"]) assert.ok(B.records.some(r => r.language === lang && r.type === "lesson_section"), lang);
  const rep = JSON.parse(fs.readFileSync(path.join(ROOT, "content/knowledge/v2/build-report.json"), "utf8"));
  for (const s of rep.sources) assert.strictEqual(sha(s.file), s.sha1, "исходник изменился после сборки: " + s.file);
  assert.strictEqual(KV2.validateRecord({ ...B.records[0], translation_status: "draft", verified: true }), "черновой перевод не может быть verified");
  const founder = B.records.filter(r => r.type === "project_fact" && r.provenance.key === "founder");
  assert.ok(founder.every(r => !/\b(19|20)\d\d\b|\$|млн|million|лиценз(ия|ией)\s+№/i.test(r.content)), "в сведениях о проекте нет выдуманных лет/сумм/лицензий");
});

test("поиск: контрольный набор и отложенный набор (не использовался при настройке) — не ниже порога", () => {
  const pub = B.records.filter(r => r.status === "published");
  const c = KV2.runControl(pub, B.glossary, B.control), h = KV2.runControl(pub, B.glossary, require("./fixtures/knowledge-holdout.json").queries);
  assert.ok(c.rate >= KV2.VERIFY_MIN, `контрольный: ${c.passed}/${c.total} ${JSON.stringify(c.failed.slice(0, 3))}`);
  assert.ok(h.rate >= KV2.VERIFY_MIN, `отложенный: ${h.passed}/${h.total} ${JSON.stringify(h.failed.slice(0, 3))}`);
});

test("поиск: синонимы, опечатки, транслит, языки и вопросы «что такое»", () => {
  const ix = l => KV2.buildIndex(B.records.filter(r => r.status === "published" && r.language === l), B.glossary);
  const ru = ix("ru"), en = ix("en"), ua = ix("ua");
  const top = (i, q, ru2) => KV2.searchWithFallback(i, ru2, q, { limit: 3 }).map(x => x.r);
  assert.match(top(ru, "что такое ордер блок")[0].title, /Order Block/i, "синоним → английский термин");
  assert.strictEqual(top(ru, "что такое ордер блок")[0].type, "definition", "на «что такое» — определение");
  assert.ok(top(ru, "ликвидноть над максимумами").some(r => r.lesson_key === "smart-money-concepts-binary#m3l0"), "опечатка");
  assert.ok(top(ru, "martingeil").some(r => r.lesson_key === "risk-management-binary#m2l1"), "транслит + опечатка");
  assert.ok(top(en, "fair value gap").every(r => r.language === "en"), "EN — английские записи");
  assert.ok(top(ua, "хто створив hidden reaction", ru).some(r => r.type === "project_fact"), "UA: факт о проекте из русской базы");
  assert.deepStrictEqual(top(ru, "рецепт борща с пампушками"), [], "вне материалов — ничего");
});

async function withCourses() {
  const db = new FakeFirestore(), A = adminCaller(createAdminApi({ db, verifyIdToken: fakeVerify, log: quiet }));
  await db.collection("users").doc("boss").set({ role: "admin", email: "b@t" });
  const ids = {};
  for (const f of ["content/hidden-reaction-course.json", "content/binary/smart_money_concepts_binary.json", "content/binary/risk_management_binary.json"]) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); const r = await A("POST", "/import/course", { uid: "boss", body: { confirm: true, data } }); const id = r.body.course_id; ids[data.course.slug] = id;
    await A("POST", `/courses/${id}/ready-all`, { uid: "boss", body: { confirm: true } }); await A("POST", `/courses/${id}/publish`, { uid: "boss", body: { confirm: true } }); }
  for (const [i, it] of JSON.parse(fs.readFileSync(path.join(ROOT, "content/knowledge/seed.json"), "utf8")).items.entries()) await db.collection("hd_knowledge").doc("old_" + i).set({ ...it, status: "published" });
  return { db, A, ids };
}
const snap = async (db, n) => JSON.stringify((await db.collection(n).get()).docs.map(d => [d.id, d.data()]).sort());

test("миграция: dry-run, резервная копия, идемпотентный импорт, архив вместо удаления, проверка, переключение и откат; v1 и курсы не тронуты", async () => {
  let clock = 1800000000000; const { db } = await withCourses(); const K = KV2.createKnowledgeV2({ db, now: () => ++clock });
  const before = { v1: await snap(db, "hd_knowledge"), pc: await snap(db, "published_courses"), pl: await snap(db, "published_lessons"), lp: await snap(db, "lesson_progress") };
  const d0 = await K.dryRun(); assert.deepStrictEqual([d0.add, d0.update, d0.unchanged, d0.archive, d0.errors], [B.records.length, 0, 0, 0, 0]);
  const bk = await K.backup(); assert.strictEqual(bk.hd_knowledge.length, 5); assert.strictEqual(bk.hd_knowledge_v2.length, 0);
  const bad = [{ ...B.records[0], language: "de" }, ...B.records.slice(1)];
  await assert.rejects(K.apply(bad), e => e.code === "INVALID"); assert.strictEqual((await db.collection(KV2.COLL).get()).docs.length, 0, "ошибка схемы — ничего не записано");
  const a1 = await K.apply(undefined, "boss", { backupRef: "test-backup" }); assert.strictEqual(a1.written, B.records.length);
  const a2 = await K.apply(undefined, "boss"); assert.deepStrictEqual([a2.written, a2.archived, a2.unchanged], [0, 0, B.records.length], "повторный импорт ничего не пишет");
  const changed = B.records.map((r, i) => i === 0 ? { ...r, content: r.content + " (уточнение)", checksum: crypto.createHash("sha1").update(r.title + "\n" + r.content + " (уточнение)").digest("hex") } : r).slice(0, -1);
  const d1 = await K.dryRun(changed); assert.deepStrictEqual([d1.update, d1.archive], [1, 1]);
  const a3 = await K.apply(changed, "boss"); assert.deepStrictEqual([a3.written, a3.archived], [1, 1]);
  const gone = await db.collection(KV2.COLL).doc(B.records[B.records.length - 1].id).get(); assert.strictEqual(gone.exists, true); assert.strictEqual(gone.data().status, "archived", "не удалена, а в архиве");
  await assert.rejects(K.activate("v2", "boss"), e => e.code === "NOT_VERIFIED", "без проверки v2 не включается");
  const v = await K.verify("boss"); assert.ok(v.ok, `${v.passed}/${v.total}`);
  assert.strictEqual((await K.activate("v2", "boss")).active, "v2"); assert.strictEqual((await K.activate("v1", "boss")).active, "v1", "откат одной настройкой");
  const st = await K.status(); assert.strictEqual(st.by_status.archived, 1); assert.ok(st.runs.length >= 4);
  assert.deepStrictEqual({ v1: await snap(db, "hd_knowledge"), pc: await snap(db, "published_courses"), pl: await snap(db, "published_lessons"), lp: await snap(db, "lesson_progress") }, before, "старая база, курсы, уроки и прогресс не изменились");
});

test("AI Mentor: с v2 — разделы уроков и сведения о проекте в запросе к модели; снятый с публикации курс исключается; v1 — прежний путь", async () => {
  const { db, A, ids } = await withCourses(); const K = KV2.createKnowledgeV2({ db }); await K.apply(); await K.verify(); await K.activate("v2");
  const calls = []; const api = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Ответ" }], usage: { input_tokens: 100, output_tokens: 20 } }) }; };
  const L = learnCaller(createLearnApi({ db, academyApi: createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet }), log: quiet, env: { ANTHROPIC_API_KEY: "k" }, mentorFetch: api }));
  await db.collection("users").doc("st").set({ role: "team_member", email: "s@t" }); await require("../academy/features").createFeatures({ db }).update("ai_mentor", { status: "ACTIVE" }, "boss");
  let n = 0; const ask = async t => { KV2.invalidateMentorIndex(db); await L("POST", "/mentor/message?lang=ru", { uid: "st", query: { lang: "ru" }, body: { text: t, client_id: "cid_v2_" + (++n).toString().padStart(4, "0") } }); return calls[calls.length - 1].system; };
  assert.match(await ask("Что такое откат в системе?"), /Откат — /, "раздел урока из v2");
  assert.match(await ask("Кто создал Hidden Reaction?"), /авторская система \(методология\), созданная основателем Hidden Dinox/);
  await A("POST", `/courses/${ids["risk-management-binary"]}/unpublish`, { uid: "boss", body: { confirm: true } });
  assert.doesNotMatch(await ask("Почему мартингейл опасен?"), /Мартингейл и отыгрыш — /, "курс снят с публикации — его записи не используются");
  await K.activate("v1"); assert.doesNotMatch(await ask("Что такое откат в системе?"), /Откат — /, "v1 — прежний поиск по урокам");
});

test("старая база: архивирование и удаление — только с фразой, полной резервной копией и после архива", async () => {
  const { db } = await withCourses(); const K = KV2.createKnowledgeV2({ db });
  const bk = await K.backup(), partial = { ...bk, hd_knowledge: bk.hd_knowledge.slice(1) };
  await assert.rejects(K.archiveV1(bk, "archive"), e => e.code === "CONFIRM_REQUIRED");
  await assert.rejects(K.archiveV1(partial, "ARCHIVE hd_knowledge"), e => e.code === "BACKUP_MISMATCH");
  await assert.rejects(K.deleteV1(bk, "DELETE hd_knowledge"), e => e.code === "NOT_ARCHIVED", "удалить без архивирования нельзя");
  assert.strictEqual((await K.archiveV1(bk, "ARCHIVE hd_knowledge")).archived, 5);
  assert.strictEqual((await db.collection("hd_knowledge").get()).docs.length, 5, "архивирование ничего не удаляет");
  assert.ok((await db.collection("hd_knowledge").get()).docs.every(d => d.data().status === "archived"));
  assert.strictEqual((await db.collection("hd_knowledge_archive").get()).docs.length, 5);
  await assert.rejects(K.deleteV1(partial, "DELETE hd_knowledge"), e => e.code === "BACKUP_MISMATCH");
  assert.strictEqual((await K.deleteV1(bk, "DELETE hd_knowledge")).deleted, 5);
  assert.strictEqual((await db.collection("hd_knowledge_archive").get()).docs.length, 5, "архив сохранён");
});

test("админка v2: права, импорт с автоматической резервной копией, скачивание копии, проверка, переключение, предпросмотр поиска", async () => {
  const { db, A } = await withCourses();
  await db.collection("users").doc("mentor1").set({ role: "mentor", email: "m@t" }); await db.collection("users").doc("stu").set({ role: "student", email: "s@t" });
  assert.strictEqual((await A("GET", "/knowledge-v2/status", { uid: "stu" })).statusCode, 403);
  assert.strictEqual((await A("GET", "/knowledge-v2/status", { uid: "mentor1" })).statusCode, 200, "методист видит состояние");
  assert.strictEqual((await A("POST", "/knowledge-v2/import", { uid: "mentor1", body: { confirm: true } })).statusCode, 403, "методист не импортирует");
  assert.strictEqual((await A("POST", "/knowledge-v2/import", { uid: "boss", body: {} })).statusCode, 400, "без подтверждения");
  const v1Before = (await db.collection("hd_knowledge").get()).docs.map(d => d.id).sort();
  const imp = await A("POST", "/knowledge-v2/import", { uid: "boss", body: { confirm: true } });
  assert.strictEqual(imp.statusCode, 200, JSON.stringify(imp.body).slice(0, 300)); assert.strictEqual(imp.body.written, B.records.length); assert.match(imp.body.backup_id, /^kb_\d+$/);
  const bk = await A("GET", "/knowledge-v2/backup?id=" + imp.body.backup_id, { uid: "boss", query: { id: imp.body.backup_id } });
  assert.deepStrictEqual(bk.body.hd_knowledge.map(x => x.id).sort(), v1Before, "копия содержит старую базу до импорта"); assert.strictEqual(bk.body.hd_knowledge_v2.length, 0);
  assert.strictEqual((await A("POST", "/knowledge-v2/activate", { uid: "boss", body: { version: "v2", confirm: true } })).statusCode, 409, "без проверки — нельзя");
  const v = await A("POST", "/knowledge-v2/verify", { uid: "boss", body: {} }); assert.strictEqual(v.body.ok, true);
  assert.strictEqual((await A("POST", "/knowledge-v2/activate", { uid: "boss", body: { version: "v2", confirm: true } })).body.active, "v2");
  const s = await A("GET", "/knowledge-v2/search?lang=ru&q=" + encodeURIComponent("что такое ордер блок"), { uid: "mentor1", query: { lang: "ru", q: "что такое ордер блок" } });
  assert.match(s.body.results[0].title, /Order Block/i); assert.ok(s.body.results[0].provenance.file.includes("smart_money_concepts_binary.json"));
  const st = await A("GET", "/knowledge-v2/status", { uid: "boss" }); assert.strictEqual(st.body.active, "v2"); assert.strictEqual(st.body.backups.length, 1);
});
