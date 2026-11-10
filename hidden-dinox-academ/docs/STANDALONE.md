# Hidden Dinox Video Studio — самостоятельный сайт

Сайт запускается командой **`node vs-server.js`** (в Render: Settings → Docker Command / Start Command). Сайт подключается только к собственному проекту Firebase `hidden-dinox-video-staging`; имя проекта обязано соответствовать шаблону `hidden-dinox-video-…` (иначе сервер не стартует).

## Что видит пользователь
`/` — вход · `/register` — регистрация · `/forgot-password` — восстановление пароля · `/app` — Video Studio (после входа) · `/setup` — первичная настройка владельца (один раз). Всё остальное отвечает 404.

## Роли
| Роль | Доступ |
|---|---|
| `user` («Ожидает доступа») | получает каждый, кто зарегистрировался; студия закрыта, виден экран «Ожидайте подтверждения» |
| `editor` (монтажёр) | студия не открывается; задания приходят в Telegram (кабинет монтажёра в браузере ещё не сделан) |
| `admin` | вся студия + раздел «Пользователи»: назначает роли `user` и `editor`, блокирует обычных пользователей |
| `owner` | всё, плюс назначает и снимает администраторов и других владельцев |

Правила: никто не меняет собственную роль; администратор не трогает администраторов и владельца; владелец, заданный переменной сервера, защищён от изменений; новый пользователь **никогда** не получает права администратора автоматически; роли хранит только сервер (клиенту Firestore закрыт полностью).

## Первый владелец (выберите один способ)
1. **Рекомендуется:** зарегистрируйтесь на сайте → Firebase Console → Authentication → Users → скопируйте **User UID** → в Render задайте `VIDEO_STUDIO_OWNER_UID=<UID>` → Manual Deploy. При следующем входе вы — владелец.
2. **Код настройки:** задайте `VIDEO_STUDIO_SETUP_TOKEN` (случайная строка от 24 символов) → зарегистрируйтесь → на экране «Ожидайте подтверждения» нажмите «Я владелец сайта» → введите код. Работает один раз; после назначения владельца код недействителен (можно удалить переменную). Неверный код блокируется после 5 попыток.

## Что нужно сделать в Firebase Console (проект hidden-dinox-video-staging)
1. Authentication → Sign-in method → включить **Email/Password**.
2. Authentication → Settings → Authorized domains → добавить `hidden-dinox-video-staging.onrender.com`.
3. Project settings → General → Your apps → веб-приложение → скопировать конфигурацию → в Render переменная `FIREBASE_WEB_CONFIG` (JSON из полей apiKey, authDomain, projectId, appId, storageBucket, messagingSenderId).
4. Project settings → Service accounts → Generate new private key → содержимое файла вставить **только в Render** (`FIREBASE_KEY`), никому не отправлять.
5. Firestore Database создана в режиме Native; правила и индексы: `cd deploy && npx firebase-tools deploy --only firestore --project hidden-dinox-video-staging` (запускаете вы; файлы `deploy/firestore.rules`, `firestore.indexes.json`). Составных индексов запросы не требуют; если Firestore когда-нибудь попросит индекс, он покажет готовую ссылку.
Firebase Storage **не нужен** (видео хранится в Cloudflare R2).

## Переменные Render
| Переменная | Нужна | Значение | Менять | Прежнее значение |
|---|---|---|---|---|
| `FIREBASE_PROJECT_ID` | да | `hidden-dinox-video-staging` | **да** | нет (проект обязан называться `hidden-dinox-video-…`, иначе сервер не стартует) |
| `FIREBASE_KEY` | да | JSON сервисного аккаунта нового проекта (или base64) | **да** | нет (ключ другого проекта отклоняется) |
| `FIREBASE_WEB_CONFIG` | да | JSON веб-приложения нового проекта | **новая** | — |
| `VIDEO_STUDIO_OWNER_UID` или `VIDEO_STUDIO_SETUP_TOKEN` | одна из двух | UID владельца / случайный код от 24 символов | новая | — |
| `VIDEO_STUDIO_ORIGIN` | рекомендуется | `https://hidden-dinox-video-staging.onrender.com` | задать | — |
| `VIDEO_STUDIO_ENABLED` | да | `1` | нет | да |
| `VIDEO_STUDIO_STORAGE` | да | `r2` | нет | да |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | да | прежние (Cloudflare R2 не меняется) | нет | **да** |
| `R2_REGION` | нет | `auto` | нет | да |
| `GROQ_API_KEY` | да | прежний | нет | да |
| `ANTHROPIC_API_KEY` (или `VIDEO_STUDIO_ANTHROPIC_API_KEY` / `STUDIO_ANTHROPIC_API_KEY`, они приоритетнее) | да | прежний | нет | да |
| `VIDEO_STUDIO_TELEGRAM_ENABLED` | нет | `1` чтобы включить | нет | да |
| `VIDEO_STUDIO_TELEGRAM_BOT_TOKEN`, `VIDEO_STUDIO_TELEGRAM_WEBHOOK_SECRET`, `VIDEO_STUDIO_TELEGRAM_OWNER_CHAT_ID`, `VIDEO_STUDIO_TELEGRAM_BOT_USERNAME` | при Telegram | как раньше | нет | да |
| `PORT` | авто | задаёт Render | нет | — |
| Настройка нагрузки (все необязательные) | нет | `VIDEO_STUDIO_FFMPEG_THREADS`, `…_FFMPEG_NICE`, `…_IDLE_POLL_SEC`, `…_SETTINGS_CACHE_MS`, `…_AUTH_CACHE_MS`, `…_SNAP_CACHE_MS`, `…_MONITOR_CACHE_MS`, `…_MAX_UPLOAD_GB`, `…_MAX_DURATION_MIN`, `…_MONTHLY_BUDGET_USD`, `…_JOB_BUDGET_USD`, `…_MAX_CONCURRENT`, `…_RETENTION_DAYS`, `…_RUNNER`, `…_OWNER_ONLY`, `…_JOB_MAX_RUNTIME_MIN`, `…_FFMPEG_TIMEOUT_MIN`, `…_REMOTE_INPUT`, `…_REMOTE_MIN_MB`, `…_TMP`, `…_BRAND_DIR`, `FFMPEG_PATH`, `FFPROBE_PATH` | нет | да, значения по умолчанию подходят |

**Не должны быть заданы** в этом сервисе: `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`, `GOOGLE_APPLICATION_CREDENTIALS` (сервер откажется стартовать).
**Сайту не нужны:** `APP_BASE_URL` (письма для сброса пароля отправляет сам Firebase), `TELEGRAM_BOT_TOKEN` (в студии используется только для маскирования в журналах). Список получен статическим разбором кода, который загружает `vs-server.js`.

## Коллекции Firestore (реальные названия из кода)
`users` (профили и роли) · `videoStudioProjects` · `videoStudioJobs` · `videoStudioClips` · `videoStudioEdits` · `videoStudioEditors` · `videoStudioClipEvents` · `videoStudioEvents` (журнал действий и «Активность») · `videoStudioUsage` (расход на ИИ) · `videoStudioSettings` (документы `meta`, `general`, `template`, `limits`, … и `owner` после первичной настройки). Отдельных коллекций для загрузок, доставок и аналитики нет: загрузки — поле `upload` в проекте, доставки в Telegram — поле `deliveries` в клипе, аналитика считается из заданий и клипов. Коллекции создаются при первой записи; служебные документы `meta` и `general` создаёт `vs-server.js` при запуске (повторный запуск ничего не сбрасывает; вручную: `node scripts/vs-init.js [--check]`).

## Структура проекта
```
vs-server.js            точка входа (node vs-server.js)
video-studio/           серверный модуль: API, очередь, исполнитель, FFmpeg, ИИ, Telegram, роли
public/video-studio/    весь сайт: *.html (вход, регистрация, сброс пароля, настройка, приложение),
                        css/, js/ (js/vs/ — интерфейс студии), assets/brand/ (логотипы)
deploy/                 правила и индексы Firestore, Dockerfile.render (образ с FFmpeg)
scripts/vs-init.js      ручная инициализация базы
tests/                  Node-тесты, браузерный тест (tests/ui), фикстуры, проверка секретов
docs/                   документация
```
Установка зависимостей: `npm install` (создаст `package-lock.json`; запасного файла в архиве нет). FFmpeg с поддержкой libass должен быть на сервере: проще всего образ `deploy/Dockerfile.render`; проверка — Настройки → Диагностика.

## Намеренно сохранённые упоминания бренда канала
Название канала «Hidden Dinox Academy» осталось в содержимом по умолчанию: подсказка ИИ для поиска моментов (`video-studio/defaults/moments.json`), словарь распознавания речи (`vocabulary.default.json`) и текст шапки клипа «HIDDEN DINOX | ACADEMY» (`template.default.json`). Это содержимое клипов, а не инфраструктура; меняется в Настройки → Брендинг / Словарь. Тестовые фикстуры содержат реальные тексты расшифровок.
