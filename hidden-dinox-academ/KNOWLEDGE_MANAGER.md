# Hidden Dinox Knowledge Manager

## Что добавлено

- Firestore collection `hd_knowledge` — рабочие материалы базы знаний.
- Firestore collection `hd_knowledge_versions` — снимки версий при создании, изменении, публикации и удалении.
- Админ-раздел `База знаний AI` в существующей панели `/admin/`.
- Импорт и экспорт JSON; импорт создаёт только черновики.
- Фильтры по категории, языку, статусу и поиск по тексту.
- Публикация и снятие с публикации с явным подтверждением.
- История версий и восстановление через API.
- AI Mentor получает опубликованные материалы базы знаний наряду с релевантными уроками.

## Первоначальное наполнение

Файл `content/knowledge/seed.json` содержит только подтверждаемую структуру Academy и правила достоверности. Он намеренно не содержит выдуманных сведений об основателе, истории, финансовых результатах, ценах или количестве учеников.

Чтобы импортировать:
1. Откройте `/admin/` аккаунтом с правами admin.
2. Выберите «База знаний AI».
3. Нажмите «Импорт JSON».
4. Откройте `content/knowledge/seed.json`, скопируйте содержимое и вставьте в поле импорта.
5. Импортированные записи появятся как черновики.
6. Проверьте каждую запись и опубликуйте её отдельно.

После импорта новые материалы добавляются через «Добавить материал». Для учеников AI Mentor использует только опубликованные записи.

## API

Все endpoints требуют Firebase ID token в `Authorization: Bearer ...` и серверной роли.

- `GET /admin/api/knowledge` — список; query: `q`, `category`, `language`, `status`.
- `GET /admin/api/knowledge/:id` — материал.
- `POST /admin/api/knowledge` — создать черновик.
- `PUT /admin/api/knowledge/:id` — новая версия материала.
- `POST /admin/api/knowledge/:id/publish` — публикация/снятие; требует `confirm: true`, `published: boolean`.
- `POST /admin/api/knowledge/:id/delete` — удалить с сохранением версии; требует `confirm: true`.
- `GET /admin/api/knowledge/:id/versions` — версии.
- `POST /admin/api/knowledge/:id/restore` — восстановить версию; требует `confirm: true`, `version`.
- `POST /admin/api/knowledge/import` — импорт до 500 материалов; требует `confirm: true` и `items`.
- `GET /admin/api/knowledge/export` — экспорт JSON.
- `GET /admin/api/knowledge/diagnostics` — статистика базы.

## Ограничения текущего этапа

Поиск по базе знаний сейчас keyword-based, лёгкий BM25-поиск по словам, а не embeddings/semantic search. Внешний crypto web search, загрузка документов PDF/DOCX и автоматическая индексация документов пока не реализованы. Для добавления нового материала через UI деплой не требуется; изменение структуры схемы/кода — требует.
