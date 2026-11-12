import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import type { HistoryDocInput } from "../db/schemas/history.js";
import { HISTORY_DOC_MAX_CHARS } from "../utils/config.js";
import { truncate } from "../utils/format.js";
import { extractTickets } from "./tickets.js";

/** Only the fields we read; the transcript format is internal to Claude Code and may change. */
const EntrySchema = z.object({
  type: z.string(),
  uuid: z.string().optional(),
  isSidechain: z.boolean().optional(),
  // Skill bodies, caveats and compaction summaries: injected by Claude Code, not typed by the user.
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  timestamp: z.string().optional(),
  message: z.object({ content: z.unknown() }).optional(),
});

const TextBlockSchema = z.object({ type: z.literal("text"), text: z.string() });

type Exchange = {
  user: string[];
  assistant: string[];
  ts: string | null;
  cwd: string | null;
  branch: string | null;
};

export type ParsedTranscript = {
  sessionId: string;
  userPrompts: number;
  docs: HistoryDocInput[];
};

function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const parsed = TextBlockSchema.safeParse(block);
    return parsed.success ? [parsed.data.text] : [];
  });
}

/** Repo name from a Superset worktree path (`.superset/worktrees/<repo>/…`), else the folder name. */
export function repoName(cwd: string): string {
  const parts = cwd.split(path.sep);
  const superset = parts.indexOf(".superset");
  return superset >= 0 && parts.length > superset + 2
    ? (parts[superset + 2] ?? path.basename(cwd))
    : path.basename(cwd);
}

/**
 * One document per exchange: a user prompt plus the agent's text until the next prompt.
 * Sidechains, tool calls/results, injected `<…>` blocks, meta entries and compaction summaries
 * are skipped.
 */
export function parseTranscript(filePath: string): ParsedTranscript {
  const sessionId = path.basename(filePath, ".jsonl");
  const exchanges: Exchange[] = [];
  const seen = new Set<string>();

  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = EntrySchema.safeParse(raw);
    if (!parsed.success) continue;
    const entry = parsed.data;
    if (entry.isSidechain || entry.isMeta || entry.isCompactSummary) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.uuid) {
      if (seen.has(entry.uuid)) continue;
      seen.add(entry.uuid);
    }

    const texts = textsOf(entry.message?.content)
      .map((text) => text.trim())
      .filter((text) => text && !text.startsWith("<"));
    if (texts.length === 0) continue;

    if (entry.type === "user") {
      exchanges.push({
        user: texts,
        assistant: [],
        ts: entry.timestamp ?? null,
        cwd: entry.cwd ?? null,
        branch: entry.gitBranch ?? null,
      });
    } else {
      exchanges.at(-1)?.assistant.push(...texts);
    }
  }

  const docs = exchanges.map((exchange, index): HistoryDocInput => {
    const text = truncate(
      `USER: ${exchange.user.join("\n")}\n\nAGENT: ${exchange.assistant.join("\n")}`,
      HISTORY_DOC_MAX_CHARS,
    );
    return {
      kind: "exchange",
      sourcePath: filePath,
      sessionId,
      exchangeIdx: index,
      repo: exchange.cwd ? repoName(exchange.cwd) : null,
      branch: exchange.branch,
      tickets: extractTickets(text, exchange.branch?.toUpperCase()),
      ts: exchange.ts,
      vaultNote: null,
      text,
    };
  });

  return { sessionId, userPrompts: exchanges.length, docs };
}
