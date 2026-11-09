#!/bin/sh
# Строгий запуск ВСЕХ тестов Video Studio. Пропущенный тест НЕ считается пройденным.
# Использование (из корня проекта):  sh tests/video-studio-run-all.sh [--no-ui]
# Код выхода: 0 — всё прошло, ничего не пропущено; 1 — есть падения; 3 — падений нет, но есть пропуски или не запущенные наборы.
cd "$(dirname "$0")/.." || exit 1
FAIL=0; SKIP=0; NOUI=0; [ "$1" = "--no-ui" ] && NOUI=1
T=$(mktemp -d)
echo "== 1/2 Node: отбор моментов, рендер, редактор, очередь, API, весь конвейер на настоящем FFmpeg"
node --test --test-reporter=tap tests/video-studio-moments.test.js tests/video-studio-render.test.js tests/video-studio-edits.test.js tests/video-studio-queue.test.js tests/video-studio-api.test.js tests/video-studio-r2.test.js tests/video-studio-pipeline.test.js > "$T/node.txt" 2>&1
NP=$(grep -E "^# pass " "$T/node.txt" | awk '{print $3}'); NF=$(grep -E "^# fail " "$T/node.txt" | awk '{print $3}'); NS=$(grep -E "^# skipped " "$T/node.txt" | awk '{print $3}')
echo "   пройдено: ${NP:-0}, упало: ${NF:-?}, пропущено: ${NS:-0}"
[ "${NF:-1}" != "0" ] && { FAIL=1; grep -E "^not ok|^\s+error:" "$T/node.txt" | head -6; }
if [ "${NS:-0}" != "0" ]; then SKIP=$((SKIP+NS)); echo "   ПРОПУЩЕНЫ (причины):"; grep -E "# SKIP" "$T/node.txt" | sed 's/^/     /' | cut -c1-220; fi
echo "== 2/2 Страница в браузере (Chromium)"
if [ "$NOUI" = "1" ]; then SKIP=$((SKIP+1)); echo "   НЕ ЗАПУСКАЛОСЬ по флагу --no-ui (не считается пройденным)"
else python3 -W ignore tests/ui/test_video_studio_ui.py > "$T/ui.txt" 2>&1; UC=$?
  if [ "$UC" = "0" ]; then echo "   $(grep -E '^ИТОГ' "$T/ui.txt")"; elif [ "$UC" = "3" ]; then SKIP=$((SKIP+1)); echo "   $(grep -E 'ПРОПУЩЕНО' "$T/ui.txt")"; else FAIL=1; grep -E "^FAIL|ИТОГ" "$T/ui.txt" | head -6; fi; fi
echo; if [ "$FAIL" = "1" ]; then echo "РЕЗУЛЬТАТ: ЕСТЬ ПАДЕНИЯ"; rm -rf "$T"; exit 1
elif [ "$SKIP" != "0" ]; then echo "РЕЗУЛЬТАТ: падений нет, НО пропущено/не запущено: $SKIP — проверка НЕ полная"; rm -rf "$T"; exit 3
else echo "РЕЗУЛЬТАТ: ВСЕ ТЕСТЫ ПРОЙДЕНЫ, пропусков нет"; rm -rf "$T"; exit 0; fi
