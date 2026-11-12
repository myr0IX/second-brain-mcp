# Tools

The server exposes exactly two tools.

## `search_history`

Searches conversations (one document per exchange) and, when `SECOND_BRAIN_NOTES` is set, Markdown notes. Exact words and meaning are both matched; results are grouped by session.

| Parameter | Type | Notes |
|---|---|---|
| `query` | string, optional | Any wording. Optional when `ticket` is set. |
| `ticket` | string, optional | Exact ticket id, e.g. `PROJ-123`. |
| `project` | string, optional | Substring of the repo (conversations) or project (notes). |
| `since` | string `YYYY-MM-DD...`, optional | Lower date bound. |
| `until` | string `YYYY-MM-DD...`, optional | Upper date bound. |
| `limit` | integer 1-20, default 8 | Number of sessions returned. |

At least `query` or `ticket` is required, otherwise the tool returns an error.

Output: one block per session, separated by `---`:

```
### 2026-09-14 · my-repo · feat/PROJ-42-invoices · PROJ-42
session_id: <uuid>
notes: [[decision-invoice-numbering]]

[exchange 3]
<excerpt, 500 characters max>
```

The header is date, repo, branch and tickets (whatever is known). `session_id` and `exchange N` feed `read_exchange`. Up to two excerpts are shown per session. No hit returns `No results in the history.`

Errors: without `MISTRAL_API_KEY`, a query search returns an error naming the variable.

## `read_exchange`

Reads the raw conversation around an exchange found by `search_history`.

| Parameter | Type | Notes |
|---|---|---|
| `session_id` | string | From a search result. |
| `index` | integer >= 0 | Exchange number from a search result. |
| `around` | integer 0-10, default 2 | Exchanges included before and after. |

Output: each exchange as `### exchange N · <date time>` followed by its text, separated by `---`. If nothing is indexed for that range, the tool returns an error.
