/* Firebase Authentication (модульный SDK с CDN Google). Конфигурация приходит с сервера (/firebase-config.js → window.VS_FIREBASE_CONFIG).
   Готовность сообщается после ПЕРВОГО onAuthStateChanged, то есть когда Firebase восстановил сохранённую сессию. */
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";

const app = getApps().length ? getApp() : initializeApp(window.VS_FIREBASE_CONFIG);
const auth = getAuth(app);
let resolved = false;
onAuthStateChanged(auth, () => {
  if (resolved) return;
  resolved = true;
  window.__vsFbResolve({ auth, signOut });
});
