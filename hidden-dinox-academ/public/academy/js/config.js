/* HIDDEN DINOX ACADEMY — клиентская конфигурация.
   Здесь нет секретов. Порог депозита дублируется только для текста в интерфейсе:
   решение о доступе принимает сервер. */
const CONFIG = {
  partnerUrl: "https://u3.shortink.io/register?utm_campaign=836358&utm_source=affiliate&utm_medium=sr&a=h9nxhW8rfWngjm&al=1805745&ac=academy&cid=987453&code=BTM134",
  clickIdParam: "click_id",       // TODO(интеграция): сверить с партнёрской платформой
  traderIdPattern: /^\d{5,14}$/,  // TODO(интеграция): сверить формат Trader ID
  minFirstDeposit: 50,            // USD — только для отображения (порог проверяет сервер: сумма подтверждённых депозитов)
  lowPollMs: 30000,               // сумма ниже $50: проверять пополнение раз в 30 с
  minPassword: 8,
  pollMs: 3000,
  maxBackoffMs: 30000,
  apiBase: ""                     // тот же сервер, что раздаёт /academy/
};

/* Firebase Web Config — публичный идентификатор проекта, не секрет.
   Безопасность обеспечивают правила Firestore и проверка токенов на сервере. */
window.HD_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAB7sETTaO3mKj1OdBjtdeIEGeozeVXDVM",
  authDomain: "ai-boost-10540.firebaseapp.com",
  projectId: "ai-boost-10540",
  storageBucket: "ai-boost-10540.firebasestorage.app",
  messagingSenderId: "1024595520009",
  appId: "1:1024595520009:web:650af4d5912ef70da5e6d8"
};

/* Тестовое окружение: на localhost страницы работают ТОЛЬКО с эмулятором Firebase Auth
   и демо-проектом (он не существует в облаке). Production-адреса это не затрагивает. */
window.HD_AUTH_EMULATOR = null;
if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  window.HD_FIREBASE_CONFIG = { apiKey: "demo-api-key", authDomain: "localhost", projectId: "demo-hd-academy" };
  window.HD_AUTH_EMULATOR = "http://127.0.0.1:9099";
}

/* Страницы проекта */
const PAGES = { login: "/", broker: "broker.html", deposit: "deposit.html", academy: "academy.html" };

/* Партнёрская ссылка: исходные параметры не трогаем, click_id дописываем в конец */
// base — ссылка партнёра Pocket Partners (если пользователь пришёл по ?via=), иначе основная ссылка академии; click_id добавляется всегда
const partnerLink = (clickId, base) => { const b = base || CONFIG.partnerUrl; return b + (b.includes("?") ? "&" : "?") + CONFIG.clickIdParam + "=" + encodeURIComponent(clickId); };

/* Этап пользователя по ответу сервера (тот же принцип, что в превью) */
/* Этап берётся из ответа сервера; при неизвестном значении — самый ранний безопасный */
function stageOf(p) {
  if (!p) return "login";
  if (["broker", "deposit", "academy"].includes(p.stage)) {
    if (p.stage === "academy" && p.academyAccess !== true) return "deposit";
    return p.stage;
  }
  return "broker";
}
