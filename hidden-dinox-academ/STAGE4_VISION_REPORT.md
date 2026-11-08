# Stage 4 — AI Mentor Vision

## Implemented
- AI Mentor accepts one chart screenshot per message, in JPEG, PNG, or WebP.
- Browser UI includes file picker, filename, and remove action.
- Server validates MIME allowlist, base64 structure, actual file signature, and 5 MiB decoded size limit.
- Screenshot is sent to Anthropic Claude Messages API as a native image content block, alongside the student's question.
- Image bytes are not stored in Firestore chat history and are not written to application logs.
- System instructions ask the model to separate visible observations from hypotheses, avoid guessing unreadable prices/timeframes, and avoid claiming future outcomes.
- Existing daily message quota and monthly usage accounting apply to image requests.
- Global JSON parser limit raised to 8 MiB to allow a base64-encoded image up to 5 MiB; application-level image limit remains 5 MiB.

## Verification
- `node --check` passed for `academy/mentor.js`, `public/academy/js/pages/mentor.js`, and `server.js`.
- Unit tests: 255/255 passed, including Vision upload, native image block, no base64 persistence, MIME spoof rejection.
- Wiring CLI: 23/23 passed.
- Secret scan: 87 files checked, no secrets found.

## Limitations / deployment notes
- This stage was tested with a mocked Anthropic API; no live paid Claude Vision request was made.
- The existing `AI_MENTOR_MODEL` must be configured to an Anthropic model that supports image input. Check the selected model in Anthropic before enabling for students.
- Actual token/cost usage for images is reported by Anthropic usage; verify the configured model pricing in admin before rollout.
- No production deployment was performed. The supplied archive has no `.git` metadata, so no remote branch or commit was created or verified.
