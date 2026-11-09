# Stage 5 — Daily Tests: type-aware sets and student UI

## Implemented
- Preserve each bank question's `kind` when a daily set is published. The type is also returned by today's endpoint, archived-task endpoint, answer review, and history.
- The set builder first keeps the existing course mix and module diversity, then prefers additional distinct question kinds within each course when suitable approved questions are available. It falls back to the remaining eligible questions, so it does not reduce the daily set size when a type is scarce.
- Student UI now shows localized type labels (RU/EN/UA) in the daily task list, task view, answer review, and completed history.
- Added regression tests for type preservation and type diversity where possible.

## Existing behavior retained
- Five daily tasks by default (2 HR, 2 SMC, 1 RM).
- Europe/Berlin date boundary and daily reset.
- Only approved bank questions are selected; no-repeat behavior remains controlled by `reuse_after_days`.
- Correct answers and explanations remain hidden until an attempt is submitted.
- One saved answer per user/question/day; completed and unfinished history remains available.
- Scheduled preparation of today/tomorrow remains idempotent.

## Important content limitation
The source bank contains 320 questions: 259 approved and 61 requiring review. Its `kind` field contains choice, situation, term, error, and chart labels. However, the four questions tagged `chart` in the current bank do not contain an attached chart/image payload. This stage therefore labels them as chart-related questions but does not fabricate chart images or claim to render real chart exercises. Actual visual chart tasks require approved chart assets and a reviewed question-to-image mapping in a later content stage.

## Tests
- `node --check academy/daily-tests.js` — passed.
- `node --check public/academy/js/pages/daily.js` — passed.
- `node --test tests/daily-tests.test.js` — 9/9 passed.
- Full unit suite within `npm test` — 255/255 passed.
- `node tests/wiring/scripts-cli.js` — 23/23 passed.
- `node tests/secret-scan.js` — 87 files scanned, no secrets found.
- `tests/wiring/run-wiring.js` still reports three existing environment/configuration negative-case assertions (truncated FIREBASE_KEY, wrong Firebase project, empty FIREBASE_KEY) as failures because the assertions expect a `503` API response but the observed test harness output contains `init:null` and logs. No attempt was made to weaken or bypass these checks.

## Deployment
No Git branch operations, Production merge, Render deployment, or Firebase writes were performed. This archive is a code artifact for review and testing only.
