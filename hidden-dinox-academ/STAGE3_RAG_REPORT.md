# Stage 3 — Hybrid Retrieval / RAG improvement

## Implemented
- Improved Hidden Dinox Knowledge retrieval with query normalization, lightweight RU/EN terminology aliases, BM25-style inverse document frequency scoring, title/tag boosts, phrase boost, language and verified-material boosts.
- Long knowledge entries are searched as overlapping chunks so relevant passages can be retrieved instead of always returning the beginning of a document.
- AI Mentor now merges course BM25 results and Knowledge Base results into one ranked context rather than appending Knowledge Base entries after course results regardless of relevance.
- Prompt distinguishes official Hidden Dinox Knowledge entries from course excerpts.
- Added regression coverage for terminology aliases, ranking metadata and long-document chunk retrieval.

## Important limitation
This stage implements a hybrid lexical retrieval improvement, not vector embeddings or true semantic embeddings. No embedding provider/API has been configured in this project. The current system does not claim vector semantic search. A later stage can add embeddings after selecting a provider, checking pricing, and configuring credentials.

## Tests
- `node --check academy/knowledge.js` — passed.
- `node --check academy/mentor.js` — passed.
- `node --test tests/knowledge.test.js tests/mentor.test.js` — 13/13 passed.
- `npm test` — 253/253 unit tests passed; wiring runner then reported 2 failures in the existing Firebase-key negative test scenarios (`FIREBASE_KEY` malformed and wrong project), while the remaining wiring checks shown before failure passed.
- `node tests/wiring/scripts-cli.js` — 23/23 passed.
- `node tests/secret-scan.js` — 87 files scanned, no secrets found.

## Deployment
No deployment performed. No Render or Production environment changed. This extracted ZIP does not contain `.git`, so no branch or commit claim is made.
