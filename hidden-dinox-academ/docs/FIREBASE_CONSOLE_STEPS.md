# Firebase Console — ручные шаги (Hidden Dinox Academy)

Проект Firebase: **Project ID `ai-boost-10540`** (не меняется). Отображаемое имя — Hidden Dinox Academy.
Ничего из этого код сделать не может: настройки хранятся в Firebase, а доступа к консоли у кода нет.

---

## 1. Firebase Storage (медиабиблиотека админки)

**Причина ошибки «Bucket "ai-boost-10540.firebasestorage.app" не найден».**
Имя бакета в проекте указано верно — оно взято из веб-конфигурации Firebase (`public/academy/js/config.js`, `storageBucket`), и сервер использует то же имя (`academy/index.js`, переменная `FIREBASE_STORAGE_BUCKET`, по умолчанию — это же имя). Firebase показывает это имя в конфигурации даже тогда, когда Storage в проекте **никогда не включали**. Ошибка означает: бакета физически нет.

**Важно про тариф.** По документации Firebase с 30.10.2024 создать бакет Storage можно **только на тарифе Blaze** (оплата по факту использования; у бакетов в регионах US-CENTRAL1 / US-EAST1 / US-WEST1 есть бесплатная квота Google Cloud «Always Free»). На бесплатном тарифе Spark Storage недоступен. Поэтому Storage я **не включал** — это ваше решение.

### Вариант A — включить Storage (нужен Blaze)
1. Firebase Console → проект **Hidden Dinox Academy** → внизу слева **Spark → Upgrade** → **Blaze**, привязать платёжный аккаунт.
   Сразу после этого: Google Cloud Console → **Billing → Budgets & alerts** → создать бюджет (например, $1–5) с уведомлениями на 50/90/100%.
2. Firebase Console → **Build → Storage** → **Get started**.
3. Режим правил: **Start in production mode** (правила закрыты; сервер работает через Admin SDK и правила не обходит вслепую — их не нужно открывать).
4. Регион: **us-central1** (или us-east1 / us-west1 — для бесплатной квоты). Регион нельзя сменить после создания.
5. Убедитесь, что имя созданного бакета — `ai-boost-10540.firebasestorage.app` (Storage → вкладка Files, вверху `gs://…`).
   Если имя другое — задайте его на Render: **Environment → `FIREBASE_STORAGE_BUCKET`** = имя без `gs://`.
6. Админка → **Диагностика**: блок Storage должен стать «ok». Затем **Медиа** → загрузить PNG → файл появится в списке и откроется.
7. Если вместо «ok» — «NO_PERMISSION»: Google Cloud Console → IAM → сервисный аккаунт из `FIREBASE_KEY` (`firebase-adminsdk-…`) → роль **Storage Object Admin**.

### Вариант B — не включать Storage
Всё, кроме медиабиблиотеки админки, работает без Storage: изображения сайта (включая страницу блокировки) — статические файлы в репозитории. В админке «Медиа» теперь показывает понятную причину и шаги вместо «не найден».

---

## 2. Название в письмах Firebase («ai-boost-10540» → «Hidden Dinox Academy»)

Название в стандартных письмах — это **не** имя проекта, а отдельное поле:
1. Firebase Console → ⚙️ **Project settings** → вкладка **General** → **Public-facing name** → `Hidden Dinox Academy` → **Save**.
2. Authentication → **Templates** → у каждого шаблона значок карандаша → **Sender name**: `Hidden Dinox Academy`.

Project ID `ai-boost-10540` и технический адрес `ai-boost-10540.firebaseapp.com` остаются — это идентификаторы, их не видно в фирменном письме.

---

## 3. Фирменное письмо сброса пароля и страница на сайте

Механизм — штатный Firebase (одноразовый код создаёт и проверяет Firebase; сторонний почтовый сервис не нужен).

1. Firebase Console → **Authentication → Templates → Password reset** → ✏️ **Edit template**.
2. **Sender name**: `Hidden Dinox Academy`. **Subject**: `Сброс пароля — Hidden Dinox Academy`.
3. **Message**: вставьте целиком содержимое файла `docs/email/password-reset.html`.
   Firebase подставит `%LINK%` (ссылка) и `%EMAIL%`. Логотип грузится с сайта:
   `https://hidden-dinox-academy-test2.onrender.com/academy/assets/brand/hd-logo-email.png` — откройте этот адрес в браузере после публикации кода и убедитесь, что картинка открывается.
4. Внизу шаблона → **Customize action URL** → введите:
   `https://hidden-dinox-academy-test2.onrender.com/academy/reset-password.html` → **Save**.
   Этот адрес применяется ко **всем** письмам Firebase (сброс пароля, подтверждение и восстановление email) — страница обрабатывает все три.
5. **Authentication → Settings → Authorized domains** → убедитесь, что есть `hidden-dinox-academy-test2.onrender.com` (если нет — **Add domain**). Без этого письмо всё равно уйдёт, но без кнопки «Продолжить» после смены пароля.
6. Проверка: на сайте «Забыли пароль?» → свой email → письмо в фирменном виде → кнопка открывает `…/academy/reset-password.html` → новый пароль → вход.

Ограничения Firebase: шаблон один на проект (язык письма — RU с короткими строками EN/UA; страница на сайте открывается на языке пользователя). Если поле Message окажется недоступным для редактирования, Firebase всё равно позволит изменить имя отправителя, тему и адрес ссылки (шаги 2 и 4) — ссылка будет вести на страницу сайта.
