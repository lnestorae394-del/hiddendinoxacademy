/* Подмена firebase-app.js для тестов (интернет недоступен) */
let apps = [];
export function initializeApp(cfg) { if (!cfg || !cfg.apiKey) throw new Error("no config"); const a = { cfg }; apps.push(a); window.__fbInitCount = (window.__fbInitCount || 0) + 1; return a; }
export function getApps() { return apps; }
export function getApp() { return apps[0]; }
