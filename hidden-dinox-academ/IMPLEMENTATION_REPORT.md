# Hidden Dinox Academy — AI Mentor и Daily Tests: отчёт о реализации

Основа: архив `hidden-dinox-academy-ai-mentor-human-style.zip` (перенесён коммитом `53e7017` поверх `audit-2026-10`/`729b9b1`). Вся работа — в ветке `ai-mentor-v2` рабочей копии. Production, `main`, реальные данные Firebase, переменные и секреты Render не изменялись; деплоев и миграций на реальных данных не выполнялось.

## 1. Что сделано (по этапам)
| Этап | Коммит | Содержание |
|---|---|---|
| Основа | `53e7017` | Состояние архива как отдельный коммит |
| A | `0abb80a` | Сервер больше не падает без Firebase (регрессия архива, связи 67/70 → 70/70); кэш базы знаний; защита инструкции наставника; инвентаризация источников |
| B | `76707d9` | База знаний v2 из реальных материалов, многоязычный поиск, безопасная миграция, админка |
| C1 | `d0601d3` | Естественный наставник (гибрид общих знаний и официальных правил), память: профиль ученика, сводка диалога, «Что помнит наставник» |
| C2 | `3b47b03` | Разбор скриншотов Pocket Option: модели по документации, проверки изображений, продолжение разговора по анализу |
| C3 | `7de858e` | Бюджет $100 с резервированием, доли, лимиты ученика, админ-панель |
| D | `0a9f4ad` | Автопополнение Daily Tests из опубликованных уроков с проверками и проверкой администратором |
| E | `1622b36` | Две карточки в кабинете ученика; новый интерфейс чата (телефон и компьютер) |
| F | (этот коммит) | Полная регрессия, скрипт реальной проверки API, отчёты |

## 2. Архитектура
```
Ученик ──► /api/mentor/* (learn-api.js: Firebase Auth, доступ к академии, карточка «ИИ-помощник»)
            └─ mentor.js
                ├─ поиск знаний: knowledge-v2.js (если включена v2) или уроки + hd_knowledge (v1)
                ├─ память: mentor-memory.js (профиль из прогресса/Daily Tests/тренировки; сводка и заметки по графикам диалога)
                ├─ инструкция: гибрид общих знаний и официальных правил; правила Vision для скриншотов
                ├─ бюджет: ai-budget.js (резерв худшего случая в транзакции → вызов Claude → списание по usage)
                └─ Claude API (только сервер): текст claude-haiku-5-5 / скриншоты claude-sonnet-5-5, output_config.effort
GitHub Actions ──► POST /internal/daily/run (daily-cron.js) ──► наборы на сегодня/завтра ──► daily-generator.js (при низком запасе)
Админка ──► /admin/api/* (admin-api.js, права на сервере): база знаний v2, ИИ-помощник и бюджет, Daily Tests и автопополнение, функции Academy
```

## 3. Новые и изменённые файлы (без сгенерированных данных)
Сервер: `academy/mentor.js` (инструкция, Vision, память, бюджет), `academy/mentor-memory.js` (новый), `academy/knowledge-v2.js` (новый), `academy/knowledge.js` (ленивая коллекция, кэш), `academy/ai-budget.js` (новый), `academy/daily-generator.js` (новый), `academy/daily-tests.js` (экспорт банка, фильтр источника, review_status), `academy/daily-cron.js` (запуск генератора), `academy/learn-api.js` (маршруты памяти, профиль, v2), `academy/admin-api.js` (маршруты v2, бюджета, генератора), `academy/features.js` (флаг «показывать в кабинете»).
Интерфейс: `public/academy/js/pages/mentor.js`, `public/academy/css/mentor.css`, `public/admin/admin.js`.
Данные и скрипты: `content/knowledge/v2/*` (сборка, источники, глоссарий, контрольные вопросы), `scripts/knowledge-v2/{inventory.py, extract-book.py, build.js, import.js}`, `scripts/mentor-smoke.js`.
Тесты: `tests/{knowledge-v2, mentor-memory, mentor-vision, ai-budget, daily-generator}.test.js` (новые), `tests/{mentor, knowledge, features}.test.js`, `tests/e2e/{knowledge_v2, mentor_vision, daily_generator, ui_responsive}_e2e.py` (новые), обновлены `mentor_e2e`, `feature_cards_e2e`, `chart_training_e2e`, `pretrade_e2e`, `i18n_modules_e2e`, `test-server.js`, `tests/wiring/scripts-cli.js`; `tests/fixtures/` (изображения, отложенные вопросы).
Документы: `IMPLEMENTATION_REPORT.md`, `KNOWLEDGE_BASE_AUDIT.md`, `BUDGET_ESTIMATE.md`, `STAGING_TEST_PLAN.md`, `docs/KNOWLEDGE_V2.md`, `docs/DAILY_GENERATOR.md`.

## 4. База знаний v2
Запись (`hd_knowledge_v2/{id}`): `id`, `kb_version`, `type` (lesson_section / definition / book_page / project_fact), `section` (goal, explanation, algorithm, definitions, example, limits, mistakes, key_idea, practice, faq, summary, source_note, book, project), `authority` (official_hidden_dinox / general_education), `source_type`, курс / модуль / урок (`lesson_key`), `title`, `content`, `language`, `translation_status` (original / existing / approved / draft), `verified`, `status` (published / draft / archived), `tags`, `related`, `provenance` (файл, ID блоков, страницы книги, хеш PDF), `checksum`.
Содержимое: 2466 записей (822 × RU/EN/UA) — разделы уроков трёх курсов, 405 определений терминов, 46 страниц книги, 5 сведений о проекте (только заявления владельца; EN/UA — черновики). Подробно — `KNOWLEDGE_BASE_AUDIT.md`.
Сборка: `python3 scripts/knowledge-v2/extract-book.py` (только при изменении PDF) → `node scripts/knowledge-v2/build.js`.
Миграция (админка «База знаний v2» или CLI на staging): dry-run → импорт с автоматической резервной копией → проверка поиска (порог 85 %) → «Включить v2»; откат «Вернуть v1». CLI: `node scripts/knowledge-v2/import.js [--apply --backup-dir DIR | --verify | --activate v1|v2 | --status | --archive-v1 … | --delete-v1 …]` — см. `docs/KNOWLEDGE_V2.md`. Старая `hd_knowledge`, курсы, `published_*` и прогресс не затрагиваются.
Качество поиска: контрольный набор 42/42, отложенный (не использовался при настройке) 20/20.

## 5. Переменные окружения и бюджет
Новые (все необязательные, со значениями по умолчанию): `AI_MENTOR_MODEL` (claude-haiku-5-5), `AI_MENTOR_EFFORT` (low), `AI_MENTOR_MAX_TOKENS` (1200), `AI_MENTOR_VISION_MODEL` (claude-sonnet-5-5), `AI_MENTOR_VISION_EFFORT` (medium), `AI_MENTOR_VISION_MAX_TOKENS` (2000), `AI_MENTOR_TIMEOUT_MS` (45000), `AI_MENTOR_PROMPT_CACHE` (выключено). Уже существующие: `ANTHROPIC_API_KEY`, `FIREBASE_KEY`, `DAILY_CRON_SECRET`.
Бюджет (админка «ИИ-помощник»): $100 в месяц = Mentor $40 + Vision $45 + Daily Tests $10 + резерв $5; на ученика $1.5/месяц, 5 скриншотов/день, 30 сообщений/день; цены моделей — по официальной странице цен. Резерв худшего случая до запроса, списание по факту, предупреждения 70/85/95/100 %, прогноз. Расчёт — `BUDGET_ESTIMATE.md`.

## 6. Cron
Существующий workflow `.github/workflows/daily-tests.yml` не менялся: он вызывает `POST /internal/daily/run` с `X-Cron-Secret`. Endpoint теперь после подготовки наборов запускает генератор (не чаще раза в день, блокировка в Firestore, журнал `daily_generator_runs`); ошибка генерации не влияет на наборы.

## 7. Новые API (права проверяются на сервере)
Ученик: `GET /api/mentor/memory`, `POST /api/mentor/memory/forget`, `POST /api/mentor/memory/profile`; `POST /api/mentor/message` принимает `images` (до 2).
Админка: `/admin/api/knowledge-v2/{status, dry-run, search, backup, import, verify, activate, reindex}`, `/admin/api/ai-budget/{status, settings}`, `/admin/api/daily/generator`, `/admin/api/daily/generator/{settings, run}`; `/admin/api/daily/bank?source=ai_generated|bank`.
Новые коллекции Firestore (только сервер, через Admin SDK): `hd_knowledge_v2`, `hd_knowledge_v2_runs`, `hd_knowledge_backups`, `hd_knowledge_archive` (только по ручной команде), `ai_settings/{knowledge, budget}`, `ai_budget`, `ai_budget_users`, `ai_budget_images`, `daily_generator`, `daily_generator_runs`, `daily_settings/generator`; новые поля `mentor_threads` (summary, chart_notes, prefs), `daily_bank` (source, review_status, source_material_ids, model, difficulty, translation_status), `academy_features` (show_on_dashboard).

## 8. Тесты и точные результаты (локально)
| Команда | Результат |
|---|---|
| `npm test` | 289/289 модульных; проверка связей 70/70; скрипты 23/23; поиск секретов — не найдено |
| `node --check` всех 25 JS-файлов, изменённых после `53e7017` | 0 ошибок |
| 24 браузерных набора `python3 tests/e2e/<набор>.py` | 24/24, 609 проверок из 609 |
| `node scripts/mentor-smoke.js` | здесь не выполним: нет доступа к сети (0/8, HTTP 403 прокси) — запускать на staging |

Браузерные наборы: e2e_test 61, admin 55, audit 63, ban_partner 19, deposit_sum 6, full_course 28, features 64, feature_cards 22, forgot 14, routing 31, lang_progress 19, load_states 9, daily_tests 22, daily_generator 8, chart_training 19, chart_layout 25, pretrade 15, i18n_modules 31, knowledge_v2 10, mentor 31, mentor_vision 11, ui_responsive 42 (ширины 320–1440 px), layout 1, lang_all_lessons 3.

## 9. Проверено локально / требует staging
Локально (с имитацией Claude API и тестовой Firestore проекта): весь поток наставника, Vision (запросы, проверки, заметки), память и изоляция, поиск v2 и миграция, бюджет (включая 30 параллельных запросов), генератор, интерфейс на 8 ширинах и 3 языках.
Требует staging: реальные ответы Claude и их качество, фактическое распознавание скриншотов Pocket Option, реальные токены и стоимость, принятие API параметра `output_config.effort` и выбранных моделей (`scripts/mentor-smoke.js`), импорт v2 в настоящий Firestore, GitHub Actions на вашем репозитории, safe-area на реальном iPhone, `npm ci` с настоящим Express 5.

## 10. Что НЕ менялось
Production, `main`, реальные Firebase и Render; правила Firestore; авторизация, роли и права (добавлены только новые проверки для новых маршрутов); реферальная система, депозиты, postback, выплаты; курсы, `published_courses`, `published_lessons`, прогресс; старая база `hd_knowledge` (только чтение и необязательные ручные команды архива); модули «Тренировка на графике» и «Подготовка» (скрыты только их карточки у ученика); workflow GitHub Actions.

## 11. Ошибки, найденные тестами и исправленные
Сервер падал без Firebase (из архива); импортёр v2 писал записи с ID `undefined` при архивировании; снимок `published_courses` не содержит `slug` (наставник на v2 потерял бы уроки); `source_pages` уроков — строка, связь «урок ↔ книга» не работала; исправление опечаток ломало синонимы; перезапись `mentor_threads` стирала бы память и настройки; тест Vision архива пропускал «PNG» из 12 байт; остаток округления накапливался в резерве бюджета; порог запаса в форме генератора был несовместим с целевым; галочка «показывать в кабинете» попала не в ту форму (сохранение карточки скрывало бы её).

## 12. Известные ограничения
Сервер проверяет заголовок и размеры изображения, а не все пиксели (при отказе API ученик видит «изображение не удалось обработать»). Сравнение скриншотов в диалоге — по сохранённому текстовому описанию, изображения не хранятся. Генератор не создаёт вопросы с картинками графиков. Сведения о проекте ограничены заявлениями владельца. Наборы вопросов для оценки поиска составлены разработчиком. Админка — на русском (как и вся существующая админка); всё, что видит ученик, — RU/EN/UA. Кэширование промпта выключено по умолчанию (выгода не измерена).

## 13. Откат
Без деплоя: «ИИ-помощник» → «Скоро»; база знаний → «Вернуть v1»; автопополнение → выключить; карточки — галочкой «Показывать в кабинете». Код: ветка `audit-2026-10` или нужный коммит `ai-mentor-v2`.
