# Daily Tests — ежедневные задания из банка вопросов

## Как устроено
- Банк — `content/daily-bank/daily_bank.json`, собран скриптом `scripts/build-daily-bank.py` из тестов трёх курсов (файлы курсов не меняются). Отчёт: `content/daily-bank/REPORT.md`.
  320 вопросов: SMC 168, RM 56 — одобрены; HR 96 — 35 одобрены, 61 «на проверке» (в источнике вместо объяснения ссылка на страницу книги). Удалены 43 дубля (копии из итоговых экзаменов).
- Каждый день — один общий набор: 2 HR + 2 SMC + 1 RM (меняется в админке). Только одобренные, ранее не использованные вопросы.
- Дата набора — по Europe/Berlin; новый набор виден с 00:00 по Берлину. Наборы на сегодня и завтра готовятся заранее; повторный запуск ничего не дублирует.
- Если одобренных вопросов не хватает — набор НЕ публикуется (неполный и непроверенный — никогда), админка показывает тревогу, ученик видит «Обновляем тесты». Решение: одобрить вопросы, изменить пропорции или включить повтор вопросов.
- Правильные ответы хранятся отдельно и отдаются ученику только после его ответа; ответ сохраняется один раз.

## Запас вопросов
При 2 HR в день 35 одобренных вопросов HR хватит примерно на 17 дней. Чтобы увеличить запас — админка → Daily Tests → Банк → фильтр «На проверке» → «Изменить» → объяснение (RU/EN/UA) → «Одобрен».
Админка заранее предупреждает, если вопросов курса осталось меньше чем на 7 дней.

## Настройка (один раз)
1. Render → Environment: `DAILY_CRON_SECRET` = случайная строка 32+ символов (например, `openssl rand -hex 24`). Без неё `/internal/daily/run` выключен (503).
2. GitHub → репозиторий → Settings → Secrets and variables → Actions → New repository secret:
   - `DAILY_RUN_URL` = `https://hidden-dinox-academy-test2.onrender.com/internal/daily/run`
   - `DAILY_CRON_SECRET` = то же значение, что на Render.
3. GitHub → Actions → «Daily Tests — подготовка наборов» → Run workflow (проверка) → в логе `HTTP 200`.
4. Админка → Daily Tests → «Загрузить банк из проекта» → «Подготовить наборы сейчас».
5. Админка → Функции Academy → Daily Tests → статус «Открыть».

Примечание: GitHub отключает расписания в репозиториях без активности 60 дней — тогда Actions покажет уведомление, расписание включается кнопкой. Даже без запуска по расписанию набор опубликуется при первом заходе ученика после полуночи (из банка, без дублей).

## API
Ученик (доступ как к курсам + карточка «Открыть»): `GET /api/daily/today`, `GET /api/daily/task`, `POST /api/daily/start`, `POST /api/daily/answer`, `GET /api/daily/history`.
Админка (право `daily.manage`): `GET /admin/api/daily/status`, `PUT /admin/api/daily/config`, `POST /admin/api/daily/bank/import`, `POST /admin/api/daily/run`, `GET /admin/api/daily/bank`, `PUT /admin/api/daily/bank/:id`, `GET /admin/api/daily/sets`, `GET /admin/api/daily/sets/:date`.
Расписание: `POST /internal/daily/run` с заголовком `X-Cron-Secret`.
Firestore: `daily_bank`, `daily_sets`, `daily_keys`, `daily_attempts`, `daily_settings`, `daily_runs`.

## Откат
- Без деплоя: карточку Daily Tests → «Скоро» (страница и API закрываются для учеников).
- Кода: коммит до этапа 2 (`e48f1af`). Существующие коллекции этап 2 не меняет.
