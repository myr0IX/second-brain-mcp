#!/usr/bin/env node
import { hasMistralApiKey } from "./ai/client.js";
import { createAi } from "./ai/index.js";
import { createDb } from "./db/db.js";
import { formatIndexStats, startBackgroundIndex } from "./history/auto-index.js";
import { indexHistory, type IndexOptions } from "./history/index-history.js";
import { startMcpServer } from "./server.js";
import { DB_PATH, NOTES_DIR, TRANSCRIPTS_DIR } from "./utils/config.js";
import { logger } from "./utils/logger.js";

const indexOptions: IndexOptions = { transcriptsDir: TRANSCRIPTS_DIR, notesDir: NOTES_DIR };

/** `second-brain-mcp index [--dry-run]`: indexes transcripts and notes now, whatever the last run, then exits. */
async function runIndex(dryRun: boolean): Promise<void> {
  if (!dryRun && !hasMistralApiKey()) {
    logger.error("index: MISTRAL_API_KEY is not set. Set it to index, or run `index --dry-run` to count without it.");
    process.exitCode = 1;
    return;
  }
  const db = createDb();
  const started = Date.now();
  const stats = await indexHistory(db, createAi(), { ...indexOptions, dryRun });
  db.close();
  logger.info(`index${dryRun ? " (dry run)" : ""}: ${formatIndexStats(stats, Date.now() - started)}`);
  if (stats.failed > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (process.argv[2] === "index") {
    await runIndex(process.argv.includes("--dry-run"));
    return;
  }

  const db = createDb();
  logger.info(`database: ${DB_PATH}`);
  const ai = createAi();
  await startMcpServer({ db, ai });
  if (!hasMistralApiKey()) {
    logger.warn("MISTRAL_API_KEY is not set: background indexing is off and search_history will fail.");
    return;
  }
  // Long-lived stdio process: the promise logs its own errors and never rejects.
  void startBackgroundIndex(db, ai, indexOptions);
}

main().catch((err) => {
  logger.error(String(err));
  process.exit(1);
});
