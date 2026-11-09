# Правило очистки в Cloudflare R2 (если кнопка «Настроить хранилище» не сработала из-за прав токена)

Cloudflare Dashboard → R2 → бакет `hidden-dinox-videos` → Settings → Object lifecycle rules → Add rule:
- Rule name: `abort-incomplete-multipart`
- Prefix: оставьте пустым (весь бакет)
- Действие: **Abort incomplete multipart uploads** → через **3 дня**

(Необязательно) второе правило «удалять файлы через 30 дней»: Prefix `video-studio/` → Delete uploaded objects after 30 days.
Даже без этого правила сервер сам прерывает просроченные незавершённые загрузки (раз в час) и делает суточную чистку зависших multipart-загрузок старше 4 суток.
