"use strict";
const path = require("path");
/* Каталог логотипов Video Studio; можно переопределить VIDEO_STUDIO_BRAND_DIR */
module.exports = { BRAND_DIR: process.env.VIDEO_STUDIO_BRAND_DIR || path.join(__dirname, "..", "public", "video-studio", "assets", "brand") };
