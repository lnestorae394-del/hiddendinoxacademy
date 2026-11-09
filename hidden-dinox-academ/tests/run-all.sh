#!/bin/sh
# Все проверки академии. Требуется Node.js 18+; для e2e — Python 3 и Playwright (pip install playwright && playwright install chromium).
set -e
cd "$(dirname "$0")/.."
echo "== 1. Серверная логика (node:test) ==";            node --test tests/academy.test.js tests/admin.test.js tests/referral.test.js tests/books.test.js tests/partner-links.test.js tests/i18n.test.js tests/deposits-cumulative.test.js tests/ban.test.js
echo "== 2. Запуск server.js в разных конфигурациях ==";      node tests/wiring/run-wiring.js
echo "== 2б. Скрипты повторной обработки и аудита =="; node tests/wiring/scripts-cli.js
echo "== 3. Поиск секретов ==";                           node tests/secret-scan.js
if command -v python3 >/dev/null && python3 -c "import playwright" 2>/dev/null; then
  echo "== 4. Сквозной тест в браузере ==";              python3 tests/e2e/e2e_test.py
  echo "== 5. Админ-панель и обучение в браузере ==";    python3 tests/e2e/admin_e2e.py
  echo "== 6. Полный курс Hidden Reaction глазами ученика =="; python3 tests/e2e/full_course_e2e.py
  echo "== 7. Состояния загрузки обучения ==";              python3 tests/e2e/load_states_e2e.py
  echo "== 8. Баннеры, читалка, партнёры ==";               python3 tests/e2e/features_e2e.py
  echo "== 8б. Сумма депозитов в браузере ==";              python3 tests/e2e/deposit_sum_e2e.py
  echo "== 8в. Язык без перезагрузки, прогресс, финальный экран ==";  python3 tests/e2e/lang_progress_e2e.py
  echo "== 8г. Вёрстка RU/EN/UA на 320–1280 px ==";       python3 tests/e2e/layout_e2e.py
  echo "== 8д. Блокировка, мобильный кабинет, причины отказа ==";  python3 tests/e2e/ban_partner_e2e.py
  echo "== 9. Переведённые книги (EN, UA) ==";              python3 tests/book_pdfs_check.py
  echo "== 10. Все 29 уроков и 96 вопросов на RU/EN/UA ==";  for l in ru en ua; do python3 tests/e2e/lang_all_lessons_e2e.py $l; done
else
  echo "== 4. Сквозной тест пропущен: нет Python/Playwright =="
fi
