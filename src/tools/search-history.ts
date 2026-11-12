import { z } from "zod/v4";
import { MissingApiKeyError } from "../ai/client.js";
import { searchHistory, type SessionHit } from "../history/search.js";
import { truncate } from "../utils/format.js";
import { errorResult, textResult, type ToolRegistrar } from "./types.js";

const EXCERPT_CHARS = 500;
const EXCERPTS_PER_SESSION = 2;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function formatHit(hit: SessionHit): string {
  const exchanges = hit.docs.filter((doc) => doc.kind === "exchange");
  const notes = [...new Set(hit.docs.map((doc) => doc.vault_note).filter(Boolean))];
  const first = exchanges[0] ?? hit.docs[0];
  const tickets = [...new Set(hit.docs.flatMap((doc) => doc.tickets.split(" ").filter(Boolean)))];
  const header = [
    first?.ts?.slice(0, 10),
    first?.repo,
    first?.branch,
    tickets.length ? tickets.join(" ") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const lines = [`### ${header || hit.key}`];
  if (exchanges[0]?.session_id) lines.push(`session_id: ${exchanges[0].session_id}`);
  if (notes.length) lines.push(`notes: ${notes.map((note) => `[[${note}]]`).join(", ")}`);
  const excerpts = (exchanges.length ? exchanges : hit.docs).slice(0, EXCERPTS_PER_SESSION);
  for (const doc of excerpts) {
    const where = doc.kind === "exchange" ? `exchange ${doc.exchange_idx}` : `note ${doc.vault_note}`;
    lines.push(`\n[${where}]\n${truncate(doc.text, EXCERPT_CHARS)}`);
  }
  return lines.join("\n");
}

export const registerSearchHistoryTool: ToolRegistrar = (server, { db, ai }) => {
  server.registerTool(
    "search_history",
    {
      description: `Search the user's whole work history: raw Claude Code conversations (one document per
        exchange) and, when a notes folder is configured, their Markdown notes (decisions, topics, session notes).
        Use it before answering about past work: a ticket ("PROJ-123"), "why did we do X", "what was decided
        about Y", a bug that came back. Exact terms and meaning are both matched; results are grouped by session.
        Then use read_exchange to read the raw conversation around a hit.`,
      inputSchema: z.object({
        query: z.string().optional().describe("What to look for, in any wording. Optional when ticket is set."),
        ticket: z.string().optional().describe("Exact ticket id, e.g. PROJ-123"),
        project: z.string().optional().describe("Repo or project substring, e.g. acme"),
        since: z.string().regex(ISO_DATE).optional().describe("ISO date lower bound, e.g. 2026-09-01"),
        until: z.string().regex(ISO_DATE).optional().describe("ISO date upper bound"),
        limit: z.number().int().min(1).max(20).default(8).describe("Number of sessions to return"),
      }),
    },
    async ({ query, ticket, project, since, until, limit }) => {
      if (!query && !ticket) return errorResult("Provide at least query or ticket.");
      let hits: SessionHit[];
      try {
        hits = await searchHistory(db, ai, query, { ticket, project, since, until }, limit);
      } catch (err) {
        if (err instanceof MissingApiKeyError) return errorResult(err.message);
        throw err;
      }
      if (hits.length === 0) return textResult("No results in the history.");
      return textResult(hits.map(formatHit).join("\n\n---\n\n"));
    },
  );
};
