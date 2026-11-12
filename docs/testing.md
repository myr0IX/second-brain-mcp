# Testing

Two scripts, both run by `npm run verify` (typecheck, build, smoke, qa).

| Level | Script | Server | Embeddings | Network |
|---|---|---|---|---|
| smoke | `scripts/smoke.ts` | built in memory from `src/` | deterministic stub | no |
| qa | `scripts/qa.ts` | `dist/cli.js` as a real stdio child process | real Mistral API | yes |

Both use disposable databases and generated transcript fixtures (`scripts/fixtures/transcripts.ts`); nothing touches your real index.

## smoke

The MCP client and server are linked in memory. The embedder is a hashed bag of words, so no key is read. It covers:

- tools list is exactly `search_history` and `read_exchange`;
- search by query, ticket, project and dates; grouping by session; `limit`;
- `read_exchange` windows and the missing-exchange error;
- notes: folder walking rules, frontmatter, links to conversations, pruning, a missing folder keeping indexed notes, an unreadable note counted as failed, a notes folder containing the transcripts folder (transcripts are never pruned);
- dangling symlinks in the transcripts folder skipped without stopping the run;
- database refused on embedding dimension mismatch;
- background index claim (one winner), failed and killed runs; a source whose embedding fails is not counted as indexed;
- an authentication error stops the run after one embedding attempt;
- missing `MISTRAL_API_KEY`: the error from `search_history`, a real server process that starts, warns once and skips indexing, and a real `index` command that exits with one error.

## qa

Two real server processes start at once on the same database with the real API. Exactly one may index in the background; then `search_history` and `read_exchange` are called through stdio and checked against the fixtures.

`qa` needs `MISTRAL_API_KEY` in its environment:

```bash
npx tsx --env-file=/path/to/env-file scripts/qa.ts
```

Run `npm run build` first: qa starts `dist/cli.js`.

## Commands

```bash
npm run typecheck   # src and scripts
npm run smoke
npm run build && npm run qa
npm run verify
```
