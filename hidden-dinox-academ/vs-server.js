"use strict";
/* HIDDEN DINOX VIDEO STUDIO — точка входа самостоятельного сайта (Render: Start Command = node vs-server.js).
   Нужен собственный проект Firebase (FIREBASE_PROJECT_ID + FIREBASE_KEY). */
const admin = require("firebase-admin");
const { initFirebase } = require("./video-studio/firebase-init"), { buildVideoStudio } = require("./video-studio/index"), { createStandalone, misconfigured } = require("./video-studio/standalone"), { ensureDatabase } = require("./video-studio/bootstrap");
const env = process.env, PORT = Number(env.PORT) || 3000, log = console;
const fb = initFirebase({ admin, env, log });
if (!fb.db) { misconfigured(fb.reason).listen(PORT, () => log.error("⚠️ Video Studio запущена в режиме «не настроено»: " + fb.reason)); return; }
const built = buildVideoStudio({ db: fb.db, verifyIdToken: t => admin.auth().verifyIdToken(t), admin, env, log });
const app = createStandalone({ db: built.db, verifyIdToken: built.verifyIdToken, storage: built.storage, runner: built.runner, env: built.env, log });
if (app.config.error) log.error("⚠️ " + app.config.error + " — страницы входа покажут ошибку настройки");
ensureDatabase(fb.db, { log, projectId: fb.projectId }).then(r => { if (!r.ok) log.error("⚠️ База Video Studio: " + r.problems.join("; ")); }).catch(e => log.error("⚠️ Инициализация базы не удалась:", e && e.message));
app.server().listen(PORT, () => { log.log("🌐 Hidden Dinox Video Studio: порт " + PORT + ", проект Firebase " + fb.projectId); built.start(); });
