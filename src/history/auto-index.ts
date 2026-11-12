import type { Ai } from "../ai/index.js";
import type { Db } from "../db/db.js";
import { claimIndexRun } from "../db/schemas/meta.js";
import { INDEX_CLAIM_TTL_MS } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { indexHistory, type IndexOptions, type IndexStats } from "./index-history.js";

export function formatIndexStats(stats: IndexStats, elapsedMs: number): string {
  return (
    `${stats.sources} sources indexed, ${stats.skipped} unchanged, ${stats.pruned} removed, ` +
    `${stats.failed} failed, ${stats.notProcessed > 0 ? `${stats.notProcessed} not processed, ` : ""}` +
    `${stats.docs} documents, ${stats.chars} characters, ` +
    `${Math.round(elapsedMs / 1000)} s`
  );
}

/**
 * Indexes new conversations and notes while the server is already answering.
 * Only one process per database runs it within the claim TTL. Never rejects: every error is logged.
 */
export async function startBackgroundIndex(db: Db, ai: Ai, options: IndexOptions): Promise<void> {
  try {
    if (!claimIndexRun(db, Date.now(), INDEX_CLAIM_TTL_MS)) {
      logger.info("background index skipped: another process is indexing or indexed recently");
      return;
    }
    const started = Date.now();
    const stats = await indexHistory(db, ai, options);
    logger.info(`background index: ${formatIndexStats(stats, Date.now() - started)}`);
  } catch (err) {
    logger.warn(`background index failed: ${String(err)}`);
  }
}
