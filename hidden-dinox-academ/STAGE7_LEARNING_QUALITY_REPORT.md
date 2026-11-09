# Stage 7 — Daily Tests: learning quality, translations and preview

## Implemented
- Added protected admin endpoint `GET /admin/api/daily/analytics` (`daily.manage`).
- Admin Daily Tests page now shows completed-answer volume, overall accuracy, accuracy by course and question kind, and hardest questions (minimum 3 completed attempts).
- Analytics use the latest 90 calendar days in Europe/Berlin, capped at 10,000 attempt documents. Only completed attempts are counted.
- Added full manual EN/UA translation editing for question text, options, module title, lesson title and explanation. Option count must match RU and translated options cannot be blank.
- Added student-style preview selector RU/EN/UA in the question editor. Correct answer remains hidden in the preview.
- Added regression tests for translation persistence/validation and analytics aggregation.

## Important limits
- Translations are manually entered and reviewed; no automatic machine translation is generated or claimed.
- Analytics reflect only stored completed attempts. A question is included in difficulty rankings only after at least 3 responses.
- Analytics are capped at 10,000 attempts for the most recent 90 days; data beyond that cap is not included.
- This is not a live production deployment. No Firebase data was changed, no Git push was made, and Production was not touched.

## Tests
- `node --test tests/daily-tests.test.js`: 12/12 passed.
- `npm test`: all 258 unit tests passed. The subsequent Wiring suite reports 3 existing configuration/log assertion failures for malformed, wrong-project and empty `FIREBASE_KEY`; the test process stops there.
- `node tests/wiring/scripts-cli.js`: 23/23 passed.
- `node tests/secret-scan.js`: 87 files scanned, no secrets found.
- `node --check` passed for `academy/daily-tests.js`, `academy/admin-api.js`, and `public/admin/admin.js`.
