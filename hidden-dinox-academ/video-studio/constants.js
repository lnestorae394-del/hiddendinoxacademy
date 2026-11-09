"use strict";
/* HIDDEN DINOX VIDEO STUDIO — общие константы. Все коллекции Firestore модуля начинаются с «videoStudio»:
   существующие коллекции Academy модуль не читает и не меняет (кроме чтения users/{uid} для проверки роли). */
const COLL = {
  projects: "videoStudioProjects", jobs: "videoStudioJobs", clips: "videoStudioClips", edits: "videoStudioEdits",
  access: "videoStudioAccess", usage: "videoStudioUsage", settings: "videoStudioSettings", events: "videoStudioEvents",
  editors: "videoStudioEditors", clipEvents: "videoStudioClipEvents"      // монтажёры и журнал изменений клипов
};
const JOB_TYPES = ["probe", "analyze", "preview", "render", "tg_send"];
const CLIP_STATUS = ["found", "review", "edited", "ready", "rendering", "done", "error", "excluded"];
const ALLOWED_EXT = ["mp4", "mov"];
const ALLOWED_MIME = ["video/mp4", "video/quicktime"];
// Потолки, зашитые в код: настройки администратора не могут их превысить
const HARD_CAPS = { maxUploadBytes: 20 * 2 ** 30, maxDurationSec: 8 * 3600, maxClipSeconds: 60 };
const SIGNED_URL_TTL_SEC = 15 * 60;
const UPLOAD_SESSION_TTL_SEC = 48 * 3600;       // сколько живёт начатая загрузка (потом сервер прерывает её и освобождает место)
const PART_URL_TTL_SEC = 3600;                 // срок действия ссылки на одну часть при multipart-загрузке
const CHUNK_BYTES = 16 * 1024 * 1024;           // кратно 256 КиБ, как требует загрузка кусками
module.exports = { COLL, JOB_TYPES, CLIP_STATUS, ALLOWED_EXT, ALLOWED_MIME, HARD_CAPS, SIGNED_URL_TTL_SEC, UPLOAD_SESSION_TTL_SEC, PART_URL_TTL_SEC, CHUNK_BYTES };
