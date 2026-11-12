# second-brain-mcp

A second brain for your coding agent: search your past Claude Code conversations and your Markdown notes, by meaning and by exact words.

## What it does

- Hybrid search: SQLite FTS5 (exact words) and vector search (meaning) are fused with Reciprocal Rank Fusion, and results are grouped by session.
- Ticket filter: ids like `PROJ-123` found in conversations and notes can be filtered exactly.
- Links conversations to notes: a note whose frontmatter has `session_id:` is attached to that conversation.
- Works in French and English (embeddings by `mistral-embed`).

## Install

```bash
claude mcp add second-brain --scope user --transport stdio \
  --env MISTRAL_API_KEY=your-key -- npx -y @myr0ix/second-brain-mcp
```

To also index a folder of Markdown notes, add `--env SECOND_BRAIN_NOTES=/absolute/path/to/notes` before the `--`. A ready-made `.mcp.json` is in `.mcp.json.example`.

Requires Node 22 or later, on macOS (x64, arm64), Linux with glibc (x64, arm64) or Windows x64: the vector search extension `sqlite-vec` ships prebuilt binaries for these platforms only, so Alpine and other musl-based Linux, and Windows on ARM, are not supported.

## Configuration

Environment variables. Values are used as is: `~` is not expanded, so write absolute paths.

| Variable | Default | Meaning |
|---|---|---|
| `MISTRAL_API_KEY` | none | Required for indexing and search. Without it the server starts, skips indexing with one warning, and `search_history` returns an error naming this variable for searches with a `query` (a ticket-only search needs no key). The `index` command exits with an error unless `--dry-run` is set. |
| `SECOND_BRAIN_DB` | `~/.second-brain-mcp/brain.db` | SQLite database file. |
| `SECOND_BRAIN_TRANSCRIPTS` | `~/.claude/projects` | Claude Code transcripts folder. |
| `SECOND_BRAIN_NOTES` | unset | Markdown notes folder. Unset means conversations only. |

## Indexing

The server starts an incremental index in the background. It runs at most once per 30 minutes across all processes that share the same database. If a background run fails or is killed, starts in the next 30 minutes skip indexing. To force a run:

```bash
npx -y @myr0ix/second-brain-mcp index            # index now
npx -y @myr0ix/second-brain-mcp index --dry-run  # no API call, no documents written; counts what is not indexed yet
```

Unchanged files are skipped on later runs. Conversations with fewer than 3 user prompts are never indexed (aborted starts, one-shot questions). `index` exits with code 1 when a source failed. A file that fails (unreadable note, API error) is logged and the run continues, except when Mistral rejects the API key: the run stops at the first source, logs one error, and reports the remaining sources as not processed.

**First run.** Conversations are embedded with `mistral-embed`, one document per exchange, so the first run is the slowest and the only one that sends your whole history. As an example, on a machine with about 1,600 conversation files, a dry run counted about 4,600 documents, about 6.4 million characters. On a fresh database, `index --dry-run` shows the size of your first run before anything is sent (it still creates the empty database file).

**Notes.** Every `*.md` file under the notes folder is indexed, recursively. Folders starting with `.` and `node_modules` are skipped; symlinked folders and files are not followed. The project comes from the `project:` frontmatter, or else from the folder under `projects/<name>/`. A note links to a conversation through `session_id:` frontmatter. A deleted note is removed from the index; a conversation is never removed, even if Claude Code cleans up its transcript or the notes folder contains the transcripts folder. A missing notes folder never deletes notes already indexed, and an unreadable note counts as failed without stopping the run.

## Tools

### `search_history`

Search conversations and notes. Results are grouped by session, with a short excerpt per hit.

| Parameter | Type | Meaning |
|---|---|---|
| `query` | string, optional | What to look for, in any wording. Optional when `ticket` is set. |
| `ticket` | string, optional | Exact ticket id, e.g. `PROJ-123`. |
| `project` | string, optional | Repo or project substring. |
| `since` | `YYYY-MM-DD`, optional | Lower date bound. |
| `until` | `YYYY-MM-DD`, optional | Upper date bound. |
| `limit` | integer 1-20, default 8 | Number of sessions returned. |

At least `query` or `ticket` is required.

### `read_exchange`

Read the raw conversation around an exchange found by `search_history`.

| Parameter | Type | Meaning |
|---|---|---|
| `session_id` | string | `session_id` from a search result. |
| `index` | integer >= 0 | Exchange number from a search result. |
| `around` | integer 0-10, default 2 | Exchanges to include before and after. |

## Supported today

- Claude Code transcripts (`~/.claude/projects`).
- Any folder of Markdown notes.
- Other coding agents: not yet.

## How it compares

- [claude-historian-mcp](https://github.com/Vvkmnn/claude-historian-mcp): its README describes an MCP server for searching your Claude Code conversation history, finding past solutions and tracking file changes.
- [deja-vu](https://github.com/vshulcz/deja-vu): its README describes shared local memory, session history search and cross-agent handoff across 43 coding agents, with a local index and zero LLM calls.

second-brain-mcp differs in that it also indexes your Markdown notes and uses embeddings, which sends text to Mistral (see Privacy).

## Privacy

The database, transcripts and notes stay on your machine. The only data that leaves it is the text of exchanges and notes sent to Mistral to compute embeddings, plus your search queries. Nothing is sent when `MISTRAL_API_KEY` is unset.

## License

MIT, see `LICENSE`.

Not affiliated with or endorsed by Anthropic. Claude is a trademark of Anthropic, PBC.
