# Architecture

`second-brain-mcp` is a stdio MCP server backed by one SQLite file. It indexes two kinds of sources and answers searches over both.

```
transcripts (*.jsonl) ─┐                         ┌─ FTS5 (exact words) ─┐
                       ├─ parse → documents ─ DB ┤                      ├─ RRF → group by session
notes (*.md) ──────────┘      │                  └─ vec0 (meaning) ────┘
                              └─ mistral-embed
```

## Layout

| Path | Role |
|---|---|
| `src/cli.ts` | Entry point. `second-brain-mcp` starts the server; `second-brain-mcp index [--dry-run]` indexes once and exits (exit code 1 if a source failed, or if `MISTRAL_API_KEY` is unset without `--dry-run`). |
| `src/server.ts` | Builds the MCP server and registers the tools. |
| `src/tools/` | `search_history` and `read_exchange`. |
| `src/history/transcripts.ts` | Parses a Claude Code transcript into one document per exchange (a user prompt plus the agent text until the next prompt). Skips sidechains, tool calls and results, injected blocks, meta entries and compaction summaries. |
| `src/history/vault.ts` | Lists and parses notes: one document per `*.md`, truncated to 8,000 characters. |
| `src/history/tickets.ts` | Extracts ticket ids (`[A-Z]{2,5}-\d{1,5}`, minus a short list of standards such as `UTF-8`). |
| `src/history/index-history.ts` | Incremental indexing: skip unchanged sources, embed in batches, replace a source's documents atomically. |
| `src/history/auto-index.ts` | Background indexing at server start. |
| `src/history/search.ts` | Hybrid search. |
| `src/db/` | Schema and queries (`better-sqlite3`, `sqlite-vec`). |
| `src/ai/` | Mistral embedding client. Indexing retries rate limits (429) and server errors for up to 10 minutes; a search query gives up after about 15 s, so a search stays responsive while a first index saturates the rate limit. |

## Data model

- `history_docs`: one row per exchange or note (`kind` is `exchange` or `vault`), with `session_id`, `exchange_idx`, `repo`, `branch`, `tickets`, `ts`, `vault_note`, `text`.
- `history_fts`: FTS5 index over `text` and `tickets` (`unicode61`, diacritics removed).
- `history_vec`: `vec0` table of 1024-dimension vectors (`mistral-embed`).
- `history_sources`: one row per indexed file with a signature (size and mtime, plus parser version and linked note for transcripts). A source whose signature is unchanged is skipped.
- `meta`: schema version, embedding model and dimension (a database built with another model or dimension is refused with an error naming `SECOND_BRAIN_DB`), and the background-index claim timestamp.

## Search

1. With a `query`: FTS5 and vector search each return 50 candidates (filters applied: ticket, project substring, date range). Without one (ticket only): the filtered documents are listed.
2. Rankings are fused with Reciprocal Rank Fusion (k = 60).
3. Documents are grouped by session id (or note name for unlinked notes); a group scores as its best document. The top `limit` groups are returned.

## Indexing

- Sessions with fewer than 3 user prompts are skipped.
- Each document is prefixed with a metadata header (repo, branch, date, tickets) before embedding.
- Batches are capped at 24,000 characters and sent with a concurrency of 4.
- A note whose `session_id:` frontmatter matches a transcript is linked: the conversation's documents get the note name and, when set, the note's project.
- Notes already indexed are removed when their file disappears, but only if the notes folder itself exists. Transcripts are never removed, even when the notes folder contains the transcripts folder.
- A transcript folder entry that cannot be stat'ed (dangling symlink, no permission) is skipped with a warning.
- A source counts as indexed only once its documents are written. A source that fails (unreadable note, API error) is counted and logged; the run continues.
- An authentication error (missing key, or HTTP 401 from Mistral) stops the run at the first source: one error is logged and the remaining sources are counted as not processed.

## Background index at server start

The server answers immediately and starts an index in the background. It first claims the slot with a single atomic SQLite statement on `meta.index_claimed_at`: the claim succeeds only if the previous one is older than 30 minutes. The timestamp is never released, so it also marks the last run: if a run fails or is killed, starts within the next 30 minutes skip indexing. Without `MISTRAL_API_KEY` the server logs one warning and does not index.

## Conventions

- stdout carries only MCP protocol messages; logs go to stderr through `src/utils/logger.ts`.
- External data (transcript lines, frontmatter, tool inputs) is validated with zod.
