/* HIDDEN DINOX ACADEMY — Firebase Authentication (модульный SDK с CDN Google).
   Инициализируется один раз. Готовность сообщается после ПЕРВОГО onAuthStateChanged,
   то есть когда Firebase восстановил сохранённую сессию. */
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, sendPasswordResetEmail, verifyPasswordResetCode, confirmPasswordReset, applyActionCode, checkActionCode
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";

const app = getApps().length ? getApp() : initializeApp(window.HD_FIREBASE_CONFIG);
const auth = getAuth(app);
if (window.HD_AUTH_EMULATOR) connectAuthEmulator(auth, window.HD_AUTH_EMULATOR, { disableWarnings: true });
let resolved = false;
onAuthStateChanged(auth, () => {
  if (resolved) return;
  resolved = true;
  window.__hdFbResolve({ auth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
    verifyPasswordResetCode, confirmPasswordReset, applyActionCode, checkActionCode });
});
