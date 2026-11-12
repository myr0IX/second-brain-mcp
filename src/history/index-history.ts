import fs from "node:fs";
import path from "node:path";
import { isAuthenticationError } from "../ai/client.js";
import type { Ai } from "../ai/index.js";
import type { Db } from "../db/db.js";
import {
  getSourceSignature,
  pruneMissingSources,
  replaceSourceDocs,
  type HistoryDocInput,
} from "../db/schemas/history.js";
import {
  HISTORY_BATCH_CHARS,
  HISTORY_EMBED_CONCURRENCY,
  HISTORY_MIN_USER_PROMPTS,
} from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { mapWithConcurrency } from "../utils/pool.js";
import { parseTranscript } from "./transcripts.js";
import { listNoteFiles, parseNote } from "./vault.js";

export type IndexOptions = {
  transcriptsDir: string;
  /** Markdown notes folder; null indexes conversations only. */
  notesDir: string | null;
  /** Parse and count only: no embedding call, nothing written. */
  dryRun?: boolean;
};

export type IndexStats = {
  sources: number;
  skipped: number;
  docs: number;
  chars: number;
  failed: number;
  /** Sources left untouched because the run stopped on an authentication error. */
  notProcessed: number;
  pruned: number;
};

type Source = { path: string; signature: string; load: () => HistoryDocInput[] };

/** Text sent to the embedder: a metadata header gives each exchange its context. */
function embeddingInput(doc: HistoryDocInput): string {
  const header = [doc.repo, doc.branch, doc.ts?.slice(0, 10), doc.tickets.join(" ")]
    .filter(Boolean)
    .join(" · ");
  return header ? `${header}\n\n${doc.text}` : doc.text;
}

function batchByChars(inputs: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const input of inputs) {
    if (current.length > 0 && size + input.length > HISTORY_BATCH_CHARS) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(input);
    size += input.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// Bumped when parseTranscript changes what it keeps, so already indexed transcripts are parsed again.
const TRANSCRIPT_PARSER_VERSION = 2;

function signatureOf(stat: fs.Stats): string {
  return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
}

/** An entry that cannot be stat'ed (dangling symlink, no permission) is skipped instead of aborting the run. */
function statOrSkip(entryPath: string): fs.Stats | null {
  try {
    return fs.statSync(entryPath);
  } catch (err) {
    logger.warn(`index: skipped ${entryPath}: ${String(err)}`);
    return null;
  }
}

type SessionLink = { note: string; project: string | null };

/** A note that cannot be read stays a source, so it fails on its own instead of aborting the run. */
type ReadNote = { path: string; doc: HistoryDocInput } | { path: string; error: unknown };

function readNote(filePath: string, notesDir: string): ReadNote {
  try {
    return { path: filePath, doc: parseNote(filePath, notesDir) };
  } catch (error) {
    return { path: filePath, error };
  }
}

function listSources(options: IndexOptions): Source[] {
  const { notesDir } = options;
  const notes = notesDir ? listNoteFiles(notesDir).map((filePath) => readNote(filePath, notesDir)) : [];
  // A note whose frontmatter carries `session_id:` is linked to that conversation.
  const sessionLinks = new Map<string, SessionLink>(
    notes.flatMap((note) =>
      "doc" in note && note.doc.sessionId && note.doc.vaultNote
        ? [[note.doc.sessionId, { note: note.doc.vaultNote, project: note.doc.repo }]]
        : [],
    ),
  );
  const transcripts = fs.existsSync(options.transcriptsDir)
    ? fs.readdirSync(options.transcriptsDir).flatMap((project) => {
        const dir = path.join(options.transcriptsDir, project);
        if (!statOrSkip(dir)?.isDirectory()) return [];
        return fs
          .readdirSync(dir)
          .filter((name) => name.endsWith(".jsonl"))
          .flatMap((name) => {
            const filePath = path.join(dir, name);
            const stat = statOrSkip(filePath);
            return stat ? [{ filePath, stat }] : [];
          });
      })
    : [];

  return [
    ...transcripts.map(({ filePath, stat }) => {
      const link = sessionLinks.get(path.basename(filePath, ".jsonl"));
      return {
        path: filePath,
        // The linked note may appear after the first indexing: it is part of the signature.
        signature: `v${TRANSCRIPT_PARSER_VERSION}:${signatureOf(stat)}:${link?.note ?? ""}:${link?.project ?? ""}`,
        load: () => {
          const parsed = parseTranscript(filePath);
          if (parsed.userPrompts < HISTORY_MIN_USER_PROMPTS) return [];
          // Some worktree folders are opaque ids; the linked note knows the project.
          return parsed.docs.map((doc) => ({
            ...doc,
            repo: link?.project ?? doc.repo,
            vaultNote: link?.note ?? null,
          }));
        },
      };
    }),
    ...notes.map((note) => ({
      path: note.path,
      signature: "doc" in note ? signatureOf(fs.statSync(note.path)) : "unreadable",
      load: () => {
        if ("error" in note) throw note.error;
        return [note.doc];
      },
    })),
  ];
}

function folderPrefix(dir: string): string {
  return dir.endsWith(path.sep) ? dir : dir + path.sep;
}

/** Indexes new or changed transcripts and notes; unchanged sources are skipped. */
export async function indexHistory(db: Db, ai: Ai, options: IndexOptions): Promise<IndexStats> {
  const stats: IndexStats = { sources: 0, skipped: 0, docs: 0, chars: 0, failed: 0, notProcessed: 0, pruned: 0 };
  const sources = listSources(options);
  // A missing folder (unmounted drive, typo) must not wipe the notes already indexed.
  if (!options.dryRun && options.notesDir && fs.existsSync(options.notesDir)) {
    stats.pruned = pruneMissingSources(
      db,
      folderPrefix(options.notesDir),
      folderPrefix(path.resolve(options.transcriptsDir)),
      new Set(sources.map((source) => source.path)),
    );
  }

  for (const [i, source] of sources.entries()) {
    if (getSourceSignature(db, source.path) === source.signature) {
      stats.skipped++;
      continue;
    }
    try {
      const docs = source.load();
      const inputs = docs.map(embeddingInput);
      if (!options.dryRun) {
        const batches = await mapWithConcurrency(
          batchByChars(inputs),
          HISTORY_EMBED_CONCURRENCY,
          (batch) => ai.embedMany(batch),
        );
        replaceSourceDocs(db, source.path, source.signature, docs, batches.flat());
      }
      stats.sources++;
      stats.docs += docs.length;
      stats.chars += inputs.reduce((sum, input) => sum + input.length, 0);
    } catch (err) {
      stats.failed++;
      if (isAuthenticationError(err)) {
        stats.notProcessed = sources.length - i - 1;
        logger.error(`index stopped: ${String(err)}`);
        break;
      }
      logger.warn(`index: ${source.path}: ${String(err)}`);
    }
  }
  return stats;
}
