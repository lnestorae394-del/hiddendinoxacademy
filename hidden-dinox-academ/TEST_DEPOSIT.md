# Тестовый депозит по Trader ID (без click_id) — только эмулятор Firebase

## Почему только эмулятор

Сервис `hidden-dinox-academy-test2` на Render работает с **production**-базой `ai-boost-10540`. Тестовый депозит там открыл бы доступ в настоящей базе, то есть стал бы поддельным реальным депозитом. Поэтому маршрут `GET /test/deposit`:

- регистрируется сервером **только** при `HD_TEST_MODE=1`, а тестовый режим запускается лишь с эмуляторами Firebase, демо-проектом `demo-*` и **без** `FIREBASE_KEY`;
- требует отдельный секрет `TEST_POSTBACK_SECRET` (≥ 24 символов, не равный `POCKET_POSTBACK_SECRET`);
- на Render **не существует** (обычный 404), даже если задать `TEST_POSTBACK_SECRET`.

Настоящий `/postback` не изменён: по-прежнему требует `click_id`, `secret` и проверку Trader ID.

## Что делает маршрут

Принимает `trader_id`, `amount`, `currency` (+ `test_secret`). Работает **только** для заранее подтверждённого Trader ID:
- есть проверенная регистрация (registration postback, `verified: true`);
- ID привязан (`trader_bindings`) к пользователю академии, и регистрация не принадлежит другому пользователю.

Поиск — по `trader_id` (как у настоящего postback), депозит обрабатывается **теми же правилами**: принадлежность ID, валюта, сумма, уникальность события, порог доступа. Событие помечается `test: true`.

## Запуск (Node.js 18+, Firebase CLI, Java JDK)

```bash
# 0. В папке проекта (копия, НЕ production-сервер)
npm install
npm install -g firebase-tools
cp .env.test.example .env.test

# 1. Терминал 1 — эмуляторы (данные в памяти, исчезают при остановке)
firebase emulators:start --only auth,firestore --project demo-hd-academy

# 2. Терминал 2 — сервер в тестовом режиме
set -a; . ./.env.test; set +a
unset FIREBASE_KEY
node server.js
#   в логе: «🧪 HD_TEST_MODE…» и «🧪 ТЕСТОВЫЙ маршрут /test/deposit включён»

# 3. Терминал 3 — тестовый пользователь с подтверждённым Trader ID 142807701
set -a; . ./.env.test; set +a
npm run test:seed
#   выводит email/пароль, «регистрация: registration_confirmed, этап: deposit» и тестовую ссылку
```

4. Откройте `http://127.0.0.1:3000/academy/`, войдите под email/паролем из шага 3 → страница «Проверка баланса брокера».
5. В **другой вкладке** откройте тестовую ссылку:

```
http://127.0.0.1:3000/test/deposit?trader_id=142807701&amount=69&currency=USD&test_secret=local-test-deposit-secret-only-0001
```

6. Вкладка академии в течение нескольких секунд сама перейдёт на главную: «Доступ — Активирован», «Первый депозит $69».

Секрет в ссылке — значение `TEST_POSTBACK_SECRET` из `.env.test.example`. Он существует только для локального эмулятора; если вы его измените в `.env.test`, измените и в ссылке.

## Ожидаемые ответы `/test/deposit`

| Ситуация | Ответ |
|---|---|
| первый вызов ссылки выше | `200` `ftd_recorded` |
| повторный вызов той же ссылки | `200` `duplicate` (без двойного учёта; для нового события добавьте `&event_id=2`) |
| повторный депозит | добавьте `&type=redeposit&event_id=2` → `200` `redeposit_recorded` |
| ID без регистрации / регистрация не проверена | `422` `trader_not_confirmed` |
| ID не привязан к пользователю | `422` `trader_not_bound` |
| нет / неверный `test_secret` (в т. ч. боевой секрет) | `401` / `403` |
| неверные `amount` или `currency` | `400` |
| сервер на Render или без `HD_TEST_MODE` | `404` (маршрута нет) |

## Остановка и очистка

`Ctrl+C` в терминалах 1 и 2 — данные эмуляторов удаляются. Production-база не затрагивается ни на одном шаге.
