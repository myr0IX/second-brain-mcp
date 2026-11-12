import type { Db } from "../db.js";

/**
 * Takes the indexing slot when no other process took it in the last `ttlMs`.
 * One statement, so two servers starting together on the same file cannot both win.
 * The timestamp is never released: it also marks the last run, so restarts within the TTL skip.
 */
export function claimIndexRun(db: Db, now: number, ttlMs: number): boolean {
  const { changes } = db
    .prepare(
      `INSERT INTO meta (key, value) VALUES ('index_claimed_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE CAST(meta.value AS INTEGER) <= ?`,
    )
    .run(String(now), now - ttlMs);
  return changes === 1;
}
