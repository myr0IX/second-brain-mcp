import fs from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import type { HistoryDocInput } from "../db/schemas/history.js";
import { HISTORY_DOC_MAX_CHARS } from "../utils/config.js";
import { truncate } from "../utils/format.js";
import { extractTickets } from "./tickets.js";

/** Every `*.md` under `notesDir`, skipping hidden folders (.git, .obsidian, .trash…) and node_modules. */
export function listNoteFiles(notesDir: string): string[] {
  if (!fs.existsSync(notesDir)) return [];
  return fs.readdirSync(notesDir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(notesDir, entry.name);
    if (entry.isDirectory()) {
      return entry.name.startsWith(".") || entry.name === "node_modules" ? [] : listNoteFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
  });
}

const FrontmatterSchema = z.object({
  project: z.string().optional(),
  session_id: z.string().optional(),
  date: z.string().optional(),
});
type Frontmatter = z.infer<typeof FrontmatterSchema>;

/** Flat `key: value` pairs of the leading `---` block; other keys are ignored. */
function readFrontmatter(text: string): Frontmatter {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
  const pairs = block.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([\w-]+):[ \t]*(.*?)\s*$/);
    const value = match?.[2]?.replace(/^(["'])(.*)\1$/, "$2");
    return match?.[1] && value ? [[match[1], value]] : [];
  });
  return FrontmatterSchema.parse(Object.fromEntries(pairs));
}

/** Project: `project:` frontmatter, else the folder right under `projects/`, else none. */
export function parseNote(filePath: string, notesDir: string): HistoryDocInput {
  const text = fs.readFileSync(filePath, "utf8");
  const frontmatter = readFrontmatter(text);
  const relative = path.relative(notesDir, filePath).split(path.sep);
  const folderProject = relative[0] === "projects" && relative.length > 2 ? (relative[1] ?? null) : null;
  return {
    kind: "vault",
    sourcePath: filePath,
    sessionId: frontmatter.session_id ?? null,
    exchangeIdx: null,
    repo: frontmatter.project ?? folderProject,
    branch: null,
    tickets: extractTickets(text),
    ts: frontmatter.date ?? null,
    vaultNote: path.basename(filePath, ".md"),
    text: truncate(text, HISTORY_DOC_MAX_CHARS),
  };
}
