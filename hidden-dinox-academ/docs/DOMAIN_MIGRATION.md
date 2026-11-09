# Переезд на собственный домен (hiddendinox.academy / hiddendinox.com)

Домен пока не куплен — **ничего не переключено**. Текущий адрес `https://hidden-dinox-academy-test2.onrender.com` продолжает работать и останется рабочим после подключения нового домена (Render держит оба адреса).

## Где в проекте указан адрес сайта
| Место | Что там | Нужно менять |
|---|---|---|
| Страницы и JS сайта, API | относительные пути и `location.origin` | **нет** — работают на любом домене |
| `api.resetPassword` (адрес возврата из письма) | `location.origin + /academy/index.html` | нет |
| `APP_BASE_URL` (Render → Environment) | единая настройка адреса для серверной диагностики и инструкций | да — новое значение |
| `docs/email/password-reset.html` (логотип) | `https://…/academy/assets/brand/hd-logo-email.png` | да — заменить домен и заново вставить шаблон в Firebase |
| Firebase → Templates → Customize action URL | `https://…/academy/reset-password.html` | да |
| Firebase → Authentication → Authorized domains | список доменов | да — добавить новый |
| `config.js` → `authDomain: ai-boost-10540.firebaseapp.com` | технический домен Firebase Auth | **нет** |
| Ссылки Pocket Partners / postback URL в кабинете партнёрки | адрес `/postback` | да — если постбеки должны идти на новый домен |

## Порядок переезда (после покупки домена)
1. **Render** → сервис → **Settings → Custom Domains → Add** → `hiddendinox.academy` (и `www.`, если нужно).
2. **DNS у регистратора** — записи, которые покажет Render (обычно `CNAME www → <service>.onrender.com`, для корня — `A`/`ALIAS` по инструкции Render). Дождаться статуса **Verified**; HTTPS-сертификат Render выпустит сам.
3. Проверить новый адрес вручную: `https://hiddendinox.academy/academy/index.html`.
4. **Render → Environment**: `APP_BASE_URL=https://hiddendinox.academy` → сохранить (сервис перезапустится). Админка → Диагностика → блок «site» покажет новый адрес и готовые URL для шагов 5–6.
5. **Firebase → Authentication → Settings → Authorized domains → Add domain** → `hiddendinox.academy`.
6. **Firebase → Templates → Password reset**: в шаблоне письма заменить домен логотипа; **Customize action URL** → `https://hiddendinox.academy/academy/reset-password.html`.
7. **Pocket Partners**: обновить postback URL на новый домен (старый тоже продолжит работать, пока жив адрес Render).
8. Проверить: вход, регистрация, «Забыли пароль?» → письмо → смена пароля → вход; медиабиблиотека (если включён Storage); главная (прогресс), чтение книги, партнёрский кабинет, админка.
9. Только после проверки — сообщать новый адрес ученикам. Старый адрес Render оставить (редирект можно добавить позже отдельно).

Одной переменной недостаточно: шаги 1–2 (DNS и Render), 5–6 (Firebase Console) и 7 (партнёрка) выполняются вне кода.
