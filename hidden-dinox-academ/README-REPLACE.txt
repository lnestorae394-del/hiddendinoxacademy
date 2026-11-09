ИСПРАВЛЕНИЕ TELEGRAM-БОТА HIDDEN DINОX

Заменить в корне репозитория только:
- bot/index.js
- bot/core.js
- bot/assets/hidden_dinox_dostup_otkryt_v3.mp4

Что исправлено:
1. Локальный MP4 передаётся в Telegram через Telegraf Input.fromLocalFile(), а не через неподдерживаемый для Telegraf объект { source: path }.
2. Если Telegram всё равно не примет видео, /start отправит текст и обе рабочие кнопки, чтобы пользователь не остался без доступа.
3. Видеофайл заменён на предоставленный пользователем hidden_dinox_dostup_otkryt_v3(3).mp4 (с сохранением ожидаемого в коде имени).

Не заменять server.js, package.json, Firebase-конфигурацию и остальные файлы.
После замены сделать commit/push в используемую ветку и проверить Render logs.
