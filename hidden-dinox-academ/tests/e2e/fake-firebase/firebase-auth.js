/* Подмена firebase-auth.js для тестов: аккаунты и сессия в localStorage, токен "testtoken-<uid>" */
const K = "fakeFbAccounts", S = "fakeFbSession";
const accounts = () => JSON.parse(localStorage.getItem(K) || "{}");
const uidOf = email => email.toLowerCase().replace(/[^a-z0-9]/g, "_");
const mkUser = email => ({ email, uid: uidOf(email), getIdToken: async () => "testtoken-" + uidOf(email) });
const err = code => Object.assign(new Error(code), { code });
export function getAuth() {
  if (!window.__fakeAuth) { const s = localStorage.getItem(S); window.__fakeAuth = { currentUser: s ? mkUser(s) : null, languageCode: null }; }
  return window.__fakeAuth;
}
export function onAuthStateChanged(auth, cb) { setTimeout(() => cb(auth.currentUser), 30); return () => {}; }
export async function createUserWithEmailAndPassword(auth, email, pw) {
  if (window.__fakeNetDown) throw err("auth/network-request-failed");
  const a = accounts(); if (a[email.toLowerCase()]) throw err("auth/email-already-in-use");
  if (pw.length < 6) throw err("auth/weak-password");
  a[email.toLowerCase()] = pw; localStorage.setItem(K, JSON.stringify(a));
  localStorage.setItem(S, email.toLowerCase()); auth.currentUser = mkUser(email.toLowerCase());
}
export async function signInWithEmailAndPassword(auth, email, pw) {
  const a = accounts(); if (a[email.toLowerCase()] !== pw) throw err("auth/invalid-credential");
  localStorage.setItem(S, email.toLowerCase()); auth.currentUser = mkUser(email.toLowerCase());
}
export async function signOut(auth) { localStorage.removeItem(S); auth.currentUser = null; }
export async function sendPasswordResetEmail(auth, email, settings) {
  if (settings && window.__fakeRejectContinue) throw err("auth/unauthorized-continue-uri");   // домен не в Authorized domains
  window.__resetSentTo = email; window.__resetSettings = settings || null;
}
/* Коды из писем: localStorage fakeFbCodes = { code: { email, state: "ok" | "expired" | "used", mode } } */
const CK = "fakeFbCodes", codes = () => JSON.parse(localStorage.getItem(CK) || "{}");
function codeOf(code) {
  if (window.__fakeNetDown) throw err("auth/network-request-failed");
  const c = codes()[code]; if (!c || c.state === "used") throw err("auth/invalid-action-code");
  if (c.state === "expired") throw err("auth/expired-action-code"); return c;
}
export async function verifyPasswordResetCode(auth, code) { return codeOf(code).email; }
export async function confirmPasswordReset(auth, code, pw) {
  const c = codeOf(code); if (pw.length < 6 || pw === "password123") throw err("auth/weak-password");
  const a = accounts(); a[c.email] = pw; localStorage.setItem(K, JSON.stringify(a));
  const all = codes(); all[code].state = "used"; localStorage.setItem(CK, JSON.stringify(all));
}
export async function checkActionCode(auth, code) { const c = codeOf(code); return { data: { email: c.email }, operation: c.mode }; }
export async function applyActionCode(auth, code) { codeOf(code); const all = codes(); all[code].state = "used"; localStorage.setItem(CK, JSON.stringify(all)); }
export function connectAuthEmulator(auth, url) { window.__emulatorUrl = url; }
