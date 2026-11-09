# База знаний Hidden Dinox v2 — сборка, миграция, откат

## Что это
`hd_knowledge_v2` — структурированная база для AI Mentor: курсы (разделы уроков и термины), книга «The Hidden Reaction System» по страницам, сведения о проекте (заявления владельца). Старая база `hd_knowledge` (v1) не изменяется. Какую базу использует наставник, решает настройка `ai_settings/knowledge.active` (`v1` | `v2`).
Не затрагиваются: `published_courses`, `published_lessons`, курсы, прогресс учеников.

## Пересборка из исходников (после изменения курсов или книги)
```
python3 scripts/knowledge-v2/extract-book.py     # только если изменились PDF книги (нужен pdftotext)
node scripts/knowledge-v2/build.js               # → content/knowledge/v2/*.json + build-report.json
npm test                                         # схема, исходники не изменены, качество поиска ≥ 85%
```

## Миграция через админку (рекомендуется)
Админка → «База знаний v2»:
1. «Проверить импорт (dry-run)» — сколько добавится / обновится / уйдёт в архив, дубли, ошибки схемы.
2. «Импортировать» — сначала автоматически создаётся резервная копия (v1, её версии и текущая v2; хранится в `hd_knowledge_backups`, скачивается JSON), затем импорт. Повторный импорт ничего не дублирует; записи, которых нет в новой сборке, помечаются «в архиве», а не удаляются.
3. «Проверить поиск контрольными вопросами» — без результата ≥ 85% включить v2 нельзя.
4. «Включить v2 для AI Mentor». Откат — «Вернуть v1» (данные v2 сохраняются).
5. «Предпросмотр поиска» — что найдёт наставник по вопросу ученика и почему (баллы, совпадения, источник).

Права: просмотр, dry-run, предпросмотр, скачивание копии — `content.edit`; импорт, проверка, переключение, переиндексация — только admin (`import.course`).

## Миграция через командную строку (staging)
Требуется `FIREBASE_KEY` тестового проекта.
```
node scripts/knowledge-v2/import.js                                         # dry-run
node scripts/knowledge-v2/import.js --apply --backup-dir ./kb-backups       # копия в файл → импорт (без --backup-dir не запускается)
node scripts/knowledge-v2/import.js --verify
node scripts/knowledge-v2/import.js --activate v2                           # откат: --activate v1
node scripts/knowledge-v2/import.js --status
```

## Старая база v1 — только вручную и после проверки v2
```
node scripts/knowledge-v2/import.js --archive-v1 --backup-file ./kb-backups/<файл>.json --confirm "ARCHIVE hd_knowledge"
node scripts/knowledge-v2/import.js --delete-v1  --backup-file ./kb-backups/<файл>.json --confirm "DELETE hd_knowledge"
```
Архивирование копирует записи в `hd_knowledge_archive` и помечает их «в архиве», ничего не удаляя. Удаление возможно только после архивирования и только если файл копии содержит все текущие записи.
