# AI Mentor — conversational style update

Date: 2026-11-01

## Changes
- Rewrote the system prompt to make the mentor sound like a natural, patient course tutor rather than a templated support bot.
- Added direct-answer-first behavior, short natural greetings, context-aware follow-ups, and a single clarifying question when needed.
- Removed mandatory source-footer wording from every response; sources can be mentioned naturally when useful.
- Kept strict grounding in published course lessons and approved Hidden Dinox knowledge. The assistant must not invent course-specific rules or trading outcomes.
- Added common Russian transliterations `смартмани`, `смарт мани`, and `смс` to course retrieval so they map to Smart Money Concepts.

## Verification
- `node --check academy/mentor.js`: passed.
- `node --check academy/knowledge.js`: passed.
- `node --test tests/mentor.test.js tests/knowledge.test.js`: 15/15 passed.
- Full `npm test`: 258/258 unit tests passed; wiring suite then stopped on the same two known negative Firebase-key cases (truncated key and wrong project). Scripts CLI and secret scan were therefore not reached in that full run.

## Important deployment note
This archive changes application code only. It does not populate Firestore in the live Render environment. The admin Knowledge Base still needs approved materials imported/published, and actual deployed Claude responses must be tested after deployment. The archive does not contain API keys or production credentials. No deploy, push, merge, or production change was performed.
