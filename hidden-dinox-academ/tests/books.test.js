"use strict";
/* Книга (выдача PDF, Range, прогресс) и безопасность баннеров: node --test tests/books.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { FakeFirestore } = require("./helpers/fake-firestore");
const { fakeVerify, fakeRes, fakeReq } = require("./helpers/http");
const { createAcademyApi } = require("../academy/api");
const { createAcademyPostback } = require("../academy/postback");
const { registerBookRoutes, BOOKS } = require("../academy/books");
const C = require("../academy/content");
const ROOT = path.resolve(__dirname, ".."), SECRET = "test-postback-secret-0123456789abcdef";
const quiet = { log() {}, warn() {}, error() {} };
const PDF = path.join(ROOT, BOOKS["hidden-reaction-system"].files.ru);
const PDF_EN = path.join(ROOT, BOOKS["hidden-reaction-system"].files.en), PDF_UA = path.join(ROOT, BOOKS["hidden-reaction-system"].files.ua);

function setup(root = ROOT) {
  const db = new FakeFirestore(); const academyApi = createAcademyApi({ db, verifyIdToken: fakeVerify, log: quiet });
  const pb = createAcademyPostback({ db, env: { POCKET_POSTBACK_SECRET: SECRET }, log: quiet });
  const routes = []; const router = { get: (p, h) => routes.push(["GET", p, h]), put: (p, h) => routes.push(["PUT", p, h]), post: (p, h) => routes.push(["POST", p, h]) };
  registerBookRoutes(router, { db, academyApi, root, log: quiet });
  const call = (method, fullPath, { uid, body, range } = {}) => new Promise(resolve => {
    const [p, qs] = fullPath.split("?"); const query = Object.fromEntries(new URLSearchParams(qs || ""));
    for (const [m, rp, h] of routes) {
      if (m !== method) continue; const rx = new RegExp("^" + rp.replace(/:[a-z]+/g, "([^/]+)") + "$"); const mm = p.match(rx); if (!mm) continue;
      const chunks = []; const { Writable } = require("stream");
      const res = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
      Object.assign(res, { statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, set(k, v) { if (typeof k === "object") Object.assign(this.headers, k); else this.headers[k] = v; return this; },
        json(b) { this.body = b; resolve(this); return this; }, end(x) { if (x) chunks.push(Buffer.from(x)); this.bytes = Buffer.concat(chunks); resolve(this); return this; }, headersSent: false });
      res.on("finish", () => { res.bytes = Buffer.concat(chunks); resolve(res); });
      h({ params: mm[1] ? { slug: decodeURIComponent(mm[1]) } : {}, query, body: body || {}, headers: { ...(uid ? { authorization: "Bearer testtoken-" + uid } : {}), ...(range ? { range } : {}) } }, res); return;
    }
    resolve({ statusCode: 404 });
  });
  async function giveAccess(uid, trader) {
    await academyApi.me(fakeReq({ token: "testtoken-" + uid }), fakeRes());
    await pb.handle({ type: "registration", trader_id: trader, secret: SECRET });
    await academyApi.traderId(fakeReq({ token: "testtoken-" + uid, body: { traderId: trader } }), fakeRes());
    await pb.handle({ type: "ftd", trader_id: trader, amount: "60", currency: "USD", secret: SECRET });
  }
  return { db, call, giveAccess };
}

test("оригинальный PDF на месте: 49 страниц, русский текст, не в public/", () => {
  const buf = fs.readFileSync(PDF);
  assert.equal(buf.slice(0, 5).toString(), "%PDF-");
  for (const f of Object.values(BOOKS["hidden-reaction-system"].files)) assert.ok(!f.startsWith("public/"), "книги не в публичном каталоге: " + f);
  assert.equal(BOOKS["hidden-reaction-system"].pages, 49); assert.equal(BOOKS["hidden-reaction-system"].default_lang, "ru");
  for (const f of [PDF_EN, PDF_UA]) assert.equal(fs.readFileSync(f).slice(0, 5).toString(), "%PDF-");
});

test("книга: без входа 401, без доступа 403, неизвестная книга и подстановка пути — 404", async () => {
  const s = setup();
  assert.equal((await s.call("GET", "/learn/books/hidden-reaction-system/file")).statusCode, 401);
  await s.db.collection("users").doc("nodep").set({ email: "n@t", created_at: 1 });
  assert.equal((await s.call("GET", "/learn/books/hidden-reaction-system/file", { uid: "nodep" })).body.error, "NO_ACCESS");
  await s.giveAccess("rd", "70000001");
  for (const slug of ["unknown-book", "..%2F..%2Fserver.js", "x"]) assert.equal((await s.call("GET", `/learn/books/${slug}/file`, { uid: "rd" })).statusCode, 404, slug);
});

test("книга: полный файл и частичная загрузка (Range) отдают точные байты оригинала; неверный диапазон — 416", async () => {
  const s = setup(); await s.giveAccess("rd", "70000002");
  const orig = fs.readFileSync(PDF);
  const full = await s.call("GET", "/learn/books/hidden-reaction-system/file", { uid: "rd" });
  assert.equal(full.statusCode, 200); assert.equal(full.headers["Content-Type"], "application/pdf"); assert.ok(full.bytes.equals(orig));
  assert.equal(full.headers["Cache-Control"], "private, no-store");
  const part = await s.call("GET", "/learn/books/hidden-reaction-system/file", { uid: "rd", range: "bytes=1000-1999" });
  assert.equal(part.statusCode, 206); assert.ok(part.bytes.equals(orig.slice(1000, 2000))); assert.equal(part.headers["Content-Range"], `bytes 1000-1999/${orig.length}`);
  const tail = await s.call("GET", "/learn/books/hidden-reaction-system/file", { uid: "rd", range: "bytes=-500" });
  assert.ok(tail.bytes.equals(orig.slice(orig.length - 500)));
  assert.equal((await s.call("GET", "/learn/books/hidden-reaction-system/file", { uid: "rd", range: `bytes=${orig.length}-` })).statusCode, 416);
});

test("прогресс чтения: проверка номера страницы, сохранение и восстановление, у каждого свой", async () => {
  const s = setup(); await s.giveAccess("rd", "70000003"); await s.giveAccess("rd2", "70000004");
  assert.equal((await s.call("GET", "/learn/books/hidden-reaction-system/progress", { uid: "rd" })).body.page, 1);
  for (const page of [0, 50, "3", 2.5, -1]) assert.equal((await s.call("PUT", "/learn/books/hidden-reaction-system/progress", { uid: "rd", body: { page } })).statusCode, 400, String(page));
  assert.equal((await s.call("PUT", "/learn/books/hidden-reaction-system/progress", { uid: "rd", body: { page: 18 } })).statusCode, 200);
  assert.equal((await s.call("GET", "/learn/books/hidden-reaction-system/progress", { uid: "rd" })).body.page, 18);
  assert.equal((await s.call("GET", "/learn/books/hidden-reaction-system/progress", { uid: "rd2" })).body.page, 1);
});

test("баннеры: действие только из списка, ссылку строит сервер; javascript:, http:// и чужие пути отклоняются", () => {
  const base = { title: "T", kind: "banner" };
  const bad = [{ action_type: "internal", action_target: "javascript:alert(1)" }, { action_type: "internal", action_target: "../server.js" }, { action_type: "external", action_target: "http://evil.example" },
    { action_type: "external", action_target: "javascript:alert(1)" }, { action_type: "course", action_target: "abc" }, { action_type: "eval", action_target: "x" }, { action_type: "reader", action_target: "../../x" }];
  for (const b of bad) assert.throws(() => C.announcement({ ...base, ...b }), C.ValidationError, JSON.stringify(b));
  assert.equal(C.bannerHref(C.announcement({ ...base, action_type: "internal", action_target: "learn" })), "learn.html");
  assert.equal(C.bannerHref(C.announcement({ ...base, action_type: "external", action_target: "https://t.me/hiddendinox" })), "https://t.me/hiddendinox");
  assert.equal(C.bannerHref({ action_type: "external", action_target: "javascript:alert(1)" }), null);    // даже если в базе окажется мусор
  assert.equal(C.bannerHref(C.announcement({ ...base, action_type: "soon" })), null);
  assert.equal(C.announcement({ title: "Афиша" }).kind, "poster");                                        // старые афиши не меняются
});

test("книга на языке читателя: RU — оригинал, EN и UA — переводы; Range работает; неизвестный язык → оригинал", async () => {
  const s = setup(); await s.giveAccess("rd", "70000011");
  for (const [lang, file] of [["ru", PDF], ["en", PDF_EN], ["ua", PDF_UA], ["", PDF], ["de", PDF]]) {
    const full = await s.call("GET", `/learn/books/hidden-reaction-system/file${lang ? "?lang=" + lang : ""}`, { uid: "rd" });
    assert.equal(full.statusCode, 200, lang); assert.ok(full.bytes.equals(fs.readFileSync(file)), "байты файла: " + (lang || "по умолчанию"));
  }
  const en = fs.readFileSync(PDF_EN);
  const part = await s.call("GET", "/learn/books/hidden-reaction-system/file?lang=en", { uid: "rd", range: "bytes=500-1499" });
  assert.equal(part.statusCode, 206); assert.ok(part.bytes.equals(en.slice(500, 1500)));
  assert.equal(part.headers["Content-Language"], "en");
  assert.equal((await s.call("GET", "/learn/books/hidden-reaction-system/file?lang=ua", { uid: "rd" })).headers["Content-Language"], "uk");
});

test("список книг показывает реально доступные языки; отсутствующий файл — понятная ошибка, а не пустой ответ", async () => {
  const s = setup(); await s.giveAccess("rd", "70000012");
  assert.deepEqual((await s.call("GET", "/learn/books", { uid: "rd" })).body.books[0].languages, ["ru", "en", "ua"]);
  const os = require("os"); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "books-"));
  fs.mkdirSync(path.join(tmp, "private/books"), { recursive: true }); fs.copyFileSync(PDF, path.join(tmp, BOOKS["hidden-reaction-system"].files.ru));
  const s2 = setup(tmp); await s2.giveAccess("rd2", "70000013");
  assert.deepEqual((await s2.call("GET", "/learn/books", { uid: "rd2" })).body.books[0].languages, ["ru"]);
  const miss = await s2.call("GET", "/learn/books/hidden-reaction-system/file?lang=en", { uid: "rd2" });
  assert.equal(miss.statusCode, 404); assert.equal(miss.body.error, "FILE_MISSING");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("книга без версии на языке читателя — ошибка LANG_NOT_AVAILABLE (404), а не пустой ответ", async () => {
  const s = setup(); await s.giveAccess("rd", "70000014");
  const files = BOOKS["hidden-reaction-system"].files, saved = files.ua; delete files.ua;
  try {
    const r = await s.call("GET", "/learn/books/hidden-reaction-system/file?lang=ua", { uid: "rd" });
    assert.equal(r.statusCode, 404); assert.equal(r.body.error, "LANG_NOT_AVAILABLE");
    assert.deepEqual((await s.call("GET", "/learn/books", { uid: "rd" })).body.books[0].languages, ["ru", "en"]);
  } finally { files.ua = saved; }
});
