# HIDDEN DINOX ACADEMY — развёртывание на Render и Pocket Partners

> Админ-панель, обучение, первый Super Admin, Firebase Storage и курс по книге — в `ADMIN_PANEL.md`.

Сервис: `https://hidden-dinox-academy-test2.onrender.com` · Firebase: `ai-boost-10540` · Запуск: `node server.js`

## 1. Почему регистрации проходили, а депозиты не находились

Три независимые причины; каждая подтверждена по коду.

| # | Симптом | Причина | Исправление |
|---|---|---|---|
| 1 | `macro_not_substituted` | В прошлой инструкции были макросы `{click_id}`, `{trader_id}`, `{sum}`. В Pocket Partners они называются `{CLICK_ID}`, `{TRADER_ID}`, `{SUMDEP}`. Незнакомое имя не подставляется → сервер получает текст `{sum}` → `400`, событие теряется | Новые URL (п. 3). Код распознаёт неподставленные макросы в любом регистре |
| 2 | `unknown_click` | Сервер отбрасывал **любое** событие (и регистрацию, и депозит), если `click_id` не был выдан кнопкой POCKET академии. Если Pocket Partners возвращает в `{CLICK_ID}` свой идентификатор или пользователь пришёл не через кнопку — у нас не сохранялось ничего | **Поиск по `trader_id`**: события сохраняются в `referrals/{traderId}` независимо от происхождения `click_id`. `click_id` сохраняется для аналитики и, если выдан академией, подтверждает владельца |
| 3 | `/check-deposit` не видит депозит | Старый `/check-deposit` читал поле `referrals.deposit` (порог $30), а академия хранит депозит в `referrals.academy.first_deposit`; старое поле заполнялось не для всех событий. Кроме того, старый маршрут был публичным и по любому `trader_id` раскрывал сумму | `/check-deposit` читает те же данные, что и академия, требует вход и отвечает только по Trader ID **вашего** аккаунта |
| — | `ftd_recorded_unknown_currency` | Статус версии до прошлой: в URL нет валюты → первый депозит записывался без валюты и доступ не открывался | Теперь такой депозит сохраняется «в ожидании» (`202`). Старые записи исправляет скрипт (п. 9) |
| — | `currency: null`, `usd_cents: null` | То же | То же |

## 2. Переменные окружения Render (Environment)

| Переменная | Обязательна | Значение |
|---|---|---|
| `FIREBASE_KEY` | **да** | JSON сервисного аккаунта `ai-boost-10540` (Project settings → Service accounts → Generate new private key); можно в base64 |
| `POCKET_POSTBACK_SECRET` | **да** | **Новая** случайная строка ≥ 24 символов: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. Тот же секрет — в URL Pocket Partners. Если прежний секрет где-либо публиковался — замените |
| `POSTBACK_DEFAULT_CURRENCY` | по ситуации | `USD` — **только** если Pocket Partners подтверждает, что `{SUMDEP}` всегда в долларах. Без неё депозиты сохраняются, но не учитываются (`202 deposit_pending_currency`) |
| `POSTBACK_EVENT_ID_PARAM` | нет | имя параметра с уникальным ID события, если такой макрос есть в Pocket Partners (п. 7) |
| `FIREBASE_PROJECT_ID` | нет | по умолчанию `ai-boost-10540` |
| `FIREBASE_STORAGE_BUCKET` | нет | бакет для файлов админ-панели, если не `ai-boost-10540.firebasestorage.app`. Бакет должен быть **создан** (Build → Storage → Get started; требуется тариф Blaze — см. `docs/FIREBASE_CONSOLE_STEPS.md`) |
| `MAIL_PROVIDER`, `RESEND_API_KEY`, `MAIL_FROM` (+ `MAIL_REPLY_TO`) | для писем восстановления пароля | Resend или SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`) — см. `docs/EMAIL_SETUP.md`. Без них сайт использует стандартное письмо Firebase |
| `TRUST_PROXY` | после проверки | число доверенных прокси перед сервисом. Выбирается по реальной цепочке в Диагностике (`request_ip.xff_chain`), см. `docs/EMAIL_SETUP.md` п. 1.1. Ожидаемо `1`; другое значение — только если цепочка это показывает. `true` не применяется |
| `APP_BASE_URL` | да, если включены письма | публичный адрес сайта, сейчас `https://hidden-dinox-academy-test2.onrender.com`. Показывается в Диагностике вместе с готовыми адресами для Firebase; при смене домена — см. `docs/DOMAIN_MIGRATION.md` |
| `TELEGRAM_BOT_TOKEN` | нет | токен бота Mini App для привязки Telegram (`ADMIN_PANEL.md`, п. 7) |

**Не задавать:** `HD_TEST_MODE`, `TEST_POSTBACK_SECRET` (только эмулятор), `ENABLE_LEGACY_BOTS`, `ENABLE_GIT_AUTOSAVE`, `DEV_KEY`.
**Удалить, если остались:** `ACADEMY_POSTBACK_ENABLED`, `POSTBACK_SECRET`, `POSTBACK_SECRET_PARAM`.

## 3. URL для Pocket Partners

`ВАШ_СЕКРЕТ` — значение `POCKET_POSTBACK_SECRET` (в отчёты и в GitHub не вставлять).

**Registration**
```
https://hidden-dinox-academy-test2.onrender.com/postback?type=registration&click_id={CLICK_ID}&trader_id={TRADER_ID}&secret=ВАШ_СЕКРЕТ
```
**First Deposit (FTD)**
```
https://hidden-dinox-academy-test2.onrender.com/postback?type=ftd&click_id={CLICK_ID}&trader_id={TRADER_ID}&amount={SUMDEP}&secret=ВАШ_СЕКРЕТ
```
**Redeposit**
```
https://hidden-dinox-academy-test2.onrender.com/postback?type=redeposit&click_id={CLICK_ID}&trader_id={TRADER_ID}&amount={SUMDEP}&secret=ВАШ_СЕКРЕТ
```

Почему добавлен `type`: у FTD и Redeposit одинаковые макросы, и без явного типа сервер не может отличить первый депозит от повторного. Если вы оставите один URL без `type` (ваш формат `…?click_id={CLICK_ID}&trader_id={TRADER_ID}&amount={SUMDEP}&secret=…`), он тоже работает: сумма > 0 считается первым депозитом (второй такой — обычным депозитом), сумма пустая или `0` — регистрацией. Но тогда повторные депозиты будут неотличимы от «первых» до момента, пока первый уже записан.

`click_id` оставлен: он сохраняется для аналитики и диагностики, а если совпадает с выданным кнопкой POCKET — подтверждает, какому пользователю академии принадлежит Trader ID.

**Что нужно проверить в кабинете Pocket Partners** (по скриншоту подтвердить нельзя):
1. Для каждого события (Registration, FTD, Redeposit) — свой URL из списка выше.
2. Доступен ли `{TRADER_ID}` в событии Registration и в обоих депозитных событиях.
3. Доступен ли `{SUMDEP}` в FTD и Redeposit; это сумма пополнения клиента (не комиссия, не бонус).
4. В какой валюте `{SUMDEP}`; есть ли макрос валюты (тогда добавьте `&currency={МАКРОС}`).
5. Есть ли макрос уникального ID события/транзакции (п. 7).
6. Что приходит в `{CLICK_ID}`: значение, которое кнопка POCKET передаёт параметром `click_id` в партнёрской ссылке, или собственный ID платформы. Работает в обоих случаях; в первом связь сильнее.

## 4. Как теперь работает поиск депозита

1. **Регистрация** (registration postback): секрет → `trader_id` → запись `referrals/{traderId}.academy.registration` (`click_id` сохраняется; если он выдан академией — записывается и `uid` пользователя).
2. **Привязка**: пользователь вводит **только** Trader ID на странице брокера. Сервер (по ID-токену Firebase) принимает его, если для этого ID пришла проверенная регистрация и он не принадлежит другому пользователю → `users/{uid}.trader_id` и `trader_bindings/{traderId}` (один ID — один аккаунт).
3. **Депозит** (FTD/Redeposit postback): секрет → поиск `referrals/{traderId}` по `trader_id` → проверки → запись `academy.first_deposit` (FTD), итогов по валютам и истории `deposit_events`.
4. **Проверка**: страница проверки баланса запрашивает `/check-deposit` с токеном входа. Сервер берёт Trader ID **из привязки аккаунта**, считает доступ и возвращает сумму. `trader_id` в адресе не нужен; если указан чужой — `403`.
5. **Доступ** — когда **сумма** подтверждённых депозитов на привязанный ID достигла $50.00 USD ($20 + $30 тоже открывают). Достигнутый доступ сохраняется в базе. Ученики, у кого первый депозит от $40 подтверждён до перехода на новое правило (момент записан в `system/access_rule_v50`), доступ сохраняют.

Депозит **не** учитывается, если: секрет неверен; событие уже было; для Trader ID ещё нет регистрации (`202`, засчитается автоматически, когда регистрация придёт); `click_id` события выдан академией **другому** пользователю, чем владелец регистрации или привязки (`409`); у пользователя привязан другой ID (`409`, хранится для повторной проверки); валюта неизвестна (`202`); сумма пустая, `0` или некорректна (`400`).

`click_id`, **не** выданный академией (собственный ID Pocket Partners), владельца не определяет: если он отличается от `click_id` регистрации, это **не** конфликт — событие обрабатывается по `trader_id`, а в журнале ставится пометка `click_note: differs_from_registration`.

## 5. Ответы `/postback`

| Код | `status` | Значение |
|---|---|---|
| 200 | `registration_confirmed`, `registration_exists` | регистрация сохранена / уже была |
| 200 | `ftd_recorded`, `redeposit_recorded`, `ftd_exists_counted_as_deposit` | депозит **учтён** |
| 200 | `duplicate` | событие уже обработано — повторно не учитывается |
| 202 | `deposit_pending_registration` | депозит сохранён по `trader_id`, но регистрация ещё не приходила |
| 202 | `deposit_pending_currency` | депозит сохранён, валюта неизвестна |
| 400 | `macro_not_substituted` | платформа не подставила макрос — проверьте URL (п. 3) |
| 400 | `invalid_trader`, `invalid_click`, `invalid_amount`, `unknown_type` | неверные параметры |
| 401 / 403 | `secret_missing` / `secret_invalid` | нет или неверный секрет — ничего не записано |
| 409 | `conflict_click` | `click_id` события выдан академией пользователю, который **не** владелец регистрации этого Trader ID |
| 409 | `trader_bound_to_other_user` | `click_id` академии одного пользователя, а ID привязан к другому |
| 409 | `trader_mismatch` | у пользователя из `click_id` привязан другой Trader ID (депозит хранится для повторной проверки) |
| 503 | `not_configured`, `no_db`, `db_error` | нет секрета / Firebase / ошибка Firebase |

В логе Render каждое событие видно строкой вида `postback ftd: trader ••••7701, click не из академии → ftd_recorded` (без секрета и полного ID).

## 6. `/check-deposit`

`GET /check-deposit` с заголовком `Authorization: Bearer <Firebase ID token>` (страница академии добавляет его сама).

Ответ: `{ ok, amount, confirmedTotal, progress, state, stage, traderId, traderIdLocked, brokerRegistrationConfirmed, firstDeposit, deposits, academyAccess }` — `amount` — первый депозит, `confirmedTotal` — сумма подтверждённых депозитов, `progress` — `{ confirmed_cents, required_cents, remaining_cents, pending_count, pending_reasons }`.

## 7. Повторные события (идемпотентность)

Если в Pocket Partners есть макрос уникального ID события — добавьте его в URL (например `&event_id={МАКРОС}`) и задайте `POSTBACK_EVENT_ID_PARAM=event_id`: дубли будут отсекаться точно.

Без него ключ события — отпечаток `тип + trader_id + click_id + сумма + валюта`. Повторная доставка того же postback в течение 15 минут — дубль. То же событие позже (например, второе пополнение на ту же сумму) не теряется и не засчитывается автоматически: оно «ожидает проверки», и администратор засчитывает или отклоняет его в карточке пользователя (с причиной и записью в журнале). С `POSTBACK_EVENT_ID_PARAM` все пополнения учитываются автоматически — **настройте его, если в Pocket Partners есть макрос уникального ID депозита**.

## 8. Развёртывание

1. Скачайте резервную копию репозитория `hidden-dinox-academy-test2`.
2. Render → Settings → **Root Directory**: если пусто — файлы в корне репозитория.
3. Распакуйте архив; содержимое папки `hidden-dinox-academy-integration` положите в корень репозитория с заменой (`server.js`, `package.json`, `package-lock.json`, `academy/`, `public/academy/`, `scripts/`).
4. Отправьте в GitHub.
5. Render → Settings: Build Command `npm install`, Start Command `node server.js`.
6. Render → Environment: переменные из п. 2 (новый `POCKET_POSTBACK_SECRET`) → Save.
7. Manual Deploy → **Clear build cache & deploy**.
8. Логи: `🔥 Firebase подключён: ai-boost-10540`, `✅ academy: приём postback включён…`, `🚀 SERVER START`.
9. Pocket Partners: замените три URL (п. 3) на новые с новым секретом.
10. `npm run audit` (локально с `FIREBASE_KEY`) — посмотреть текущие данные (только чтение).

## 9. Записи без валюты и отложенные депозиты

1. Узнайте у Pocket Partners валюту `{SUMDEP}`. Без подтверждения шаги 3–4 не выполняйте.
2. Если всегда USD — `POSTBACK_DEFAULT_CURRENCY=USD` в Render и деплой.
3. Просмотр: `npm run reprocess -- --currency USD`
4. Запись: `npm run reprocess -- --currency USD --apply` (повторный запуск безопасен).

События, отклонённые прежними версиями с `unknown_click` или `macro_not_substituted`, **не сохранялись**: их нельзя обработать повторно. Если Pocket Partners умеет повторно отправить postback за период — после деплоя они будут приняты; иначе такие депозиты нужно сверить в кабинете Pocket Partners вручную.

## 10. Проверка после деплоя

Без записи в базу:

| Запрос | Ожидание |
|---|---|
| `/postback` | `401 secret_missing` |
| `/postback?type=ftd&trader_id=1&amount=1&secret=НЕВЕРНЫЙ_0123456789abcdef` | `403 secret_invalid` |
| `/postback?type=ftd&trader_id=1&amount={SUMDEP}&secret=ВАШ_СЕКРЕТ` | `400 macro_not_substituted` |
| `/check-deposit` в браузере без входа | `401` |
| `/academy/` | страница входа |

Проверка реального депозита (по-настоящему, без синтетических событий в production):
1. Новый аккаунт академии → «Зарегистрироваться на POCKET» → регистрация на Pocket Option.
2. Лог Render: `postback registration: trader ••••XXXX … → registration_confirmed` → `200`. Если `400 macro_not_substituted` — URL Registration настроен неверно.
3. В академии ввести Trader ID → страница проверки баланса («Ожидаем подтверждение депозита»).
4. Пополнить счёт Pocket Option.
5. Лог: `postback ftd: … → ftd_recorded` (`200`). Варианты: `202 deposit_pending_currency` — не задана валюта (п. 2, 9); `202 deposit_pending_registration` — регистрация не пришла (проверьте URL Registration).
6. Страница академии сама переходит на главную: «Доступ — Активирован», сумма первого депозита.

Синтетическая проверка всей цепочки — только на эмуляторе: `TEST_DEPOSIT.md`.

## 11. Разбор `409` по конкретному Trader ID (пример: 142808073)

**Что было:** `postback ftd: trader ••••8073, click не из академии → conflict_click`. Причина — проверка прошлой версии: она отклоняла депозит, если его `click_id` отличался от `click_id` регистрации, даже когда оба `click_id` принадлежат Pocket Partners и о владельце ничего не говорят. Исправлено: конфликтом считается только расхождение **владельцев**. После обновления такой FTD принимается (`200 ftd_recorded`).

**Диагностика (только чтение):**
```bash
npm run inspect -- --trader 142808073
```
Покажет: подтверждена ли регистрация и кто её владелец (`owner_uid`, `owner_via`), к какому аккаунту привязан ID (`binding_uid`), первый депозит, отложенные депозиты и все события с их результатами (`click_id` замаскированы).

**Если ID привязан к прежнему аккаунту, а владелец пользуется новым.** Новый аккаунт при вводе ID получит «ID уже привязан» — это защита от присвоения чужого ID, автоматически привязка не меняется и не удаляется. Варианты:
1. Войти в прежний аккаунт академии — доступ там.
2. Перенести привязку вручную, **убедившись**, что новый аккаунт принадлежит владельцу Trader ID (например, по подтверждению из кабинета Pocket Option):
```bash
npm run rebind -- --trader 142808073 --to-email НОВЫЙ_EMAIL                                # просмотр
npm run rebind -- --trader 142808073 --to-email НОВЫЙ_EMAIL --reason "причина" --apply    # перенос
```
Скрипт ничего не удаляет: прежний аккаунт сохраняется в `previous_uid`, регистрация и депозиты не меняются. Он **откажет**, если регистрация или первый депозит подтверждены за другим пользователем академии.

Скрипты запускаются локально в папке проекта после `npm install` с переменной `FIREBASE_KEY` (как у сервера) или в Render Shell, если он доступен на тарифе. HTTP-маршрутов для этого нет.

## 12. Ограничения

- Макросы, наличие `{TRADER_ID}`/`{SUMDEP}` в каждом событии и валюта `{SUMDEP}` по коду не подтверждаются — только в кабинете Pocket Partners или по реальному событию.
- Если `{CLICK_ID}` — собственный ID платформы, владельца Trader ID определяет первая привязка в академии: человек, знающий чужой Trader ID **раньше владельца**, может его привязать. Владелец увидит «ID уже привязан» и должен обратиться в поддержку. Сильная связь (без этого риска) — когда `{CLICK_ID}` возвращает `click_id` кнопки POCKET.
- Без макроса ID события одинаковые по сумме повторные депозиты считаются одним (п. 7).
- Старые записи `referrals.deposit` (схема AI BOOST, писалась без проверки секрета) доступ в академию не дают.
- На старом сервере AI BOOST маршруты `/postback`, `/check`, `/check-deposit` по-прежнему публичные — это другой сервис, здесь не менялся.
