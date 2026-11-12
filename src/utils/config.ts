import os from "node:os";
import path from "node:path";

export const DB_PATH =
  process.env.SECOND_BRAIN_DB ?? path.join(os.homedir(), ".second-brain-mcp", "brain.db");

export const SCHEMA_VERSION = 1;

export const TRANSCRIPTS_DIR =
  process.env.SECOND_BRAIN_TRANSCRIPTS ?? path.join(os.homedir(), ".claude", "projects");

const notesSetting = process.env.SECOND_BRAIN_NOTES;
/** Optional Markdown notes folder; unset means conversations only. Resolved so pruning can match its prefix. */
export const NOTES_DIR: string | null = notesSetting ? path.resolve(notesSetting) : null;

/** A server start skips indexing when another process started one less than this long ago. */
export const INDEX_CLAIM_TTL_MS = 30 * 60_000;

/** Sessions with fewer user prompts are noise (aborted starts, one-shot checks). */
export const HISTORY_MIN_USER_PROMPTS = 3;

/** One exchange or note, capped well below the 8k-token limit of mistral-embed. */
export const HISTORY_DOC_MAX_CHARS = 8_000;

/** Characters per embedding request, so a batch stays under the per-request token budget. */
export const HISTORY_BATCH_CHARS = 24_000;

export const HISTORY_EMBED_CONCURRENCY = 4;

export const EMBEDDING_MODEL = "mistral-embed";
export const EMBEDDING_DIM = 1024;

/** mistral-embed accepts 8k tokens; ~20k characters stays comfortably below. */
export const EMBEDDING_CHUNK_CHARS = 20_000;
