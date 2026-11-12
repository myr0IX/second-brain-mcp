import { z } from "zod/v4";
import type { Db } from "../db.js";
import { toBlob } from "./embeddings.js";

export type HistoryDocInput = {
  kind: "exchange" | "vault";
  sourcePath: string;
  sessionId: string | null;
  exchangeIdx: number | null;
  repo: string | null;
  branch: string | null;
  tickets: string[];
  ts: string | null;
  vaultNote: string | null;
  text: string;
};

const HistoryDocSchema = z.object({
  id: z.number().int(),
  kind: z.enum(["exchange", "vault"]),
  source_path: z.string(),
  session_id: z.string().nullable(),
  exchange_idx: z.number().int().nullable(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  tickets: z.string(),
  ts: z.string().nullable(),
  vault_note: z.string().nullable(),
  text: z.string(),
});
export type HistoryDoc = z.infer<typeof HistoryDocSchema>;

export type HistoryFilters = {
  ticket?: string;
  /** Substring of the repo (exchanges) or project (notes): "acme" matches both. */
  project?: string;
  since?: string;
  until?: string;
};

const RankedSchema = z.object({ id: z.number().int() });

export function getSourceSignature(db: Db, sourcePath: string): string | null {
  return (
    db
      .prepare<[string], { signature: string }>(
        `SELECT signature FROM history_sources WHERE path = ?`,
      )
      .get(sourcePath)?.signature ?? null
  );
}

function deleteSourceDocs(db: Db, sourcePath: string): void {
  const ids = db
    .prepare<[string], { id: number }>(`SELECT id FROM history_docs WHERE source_path = ?`)
    .all(sourcePath)
    .map((row) => row.id);
  for (const id of ids) {
    db.prepare(`DELETE FROM history_fts WHERE rowid = ?`).run(id);
    db.prepare(`DELETE FROM history_vec WHERE rowid = CAST(? AS INTEGER)`).run(id);
  }
  db.prepare(`DELETE FROM history_docs WHERE source_path = ?`).run(sourcePath);
}

/**
 * Drops the documents of sources under `dir` that no longer exist on disk, except those under `keptDir`:
 * a transcript removed by Claude Code's cleanup must stay searchable, even when the notes folder contains it.
 * Both arguments are folder prefixes ending with a path separator, compared exactly (case and `_` included).
 */
export function pruneMissingSources(db: Db, dir: string, keptDir: string, existing: Set<string>): number {
  const gone = db
    .prepare<[string, string, string, string], { path: string }>(
      `SELECT path FROM history_sources
       WHERE substr(path, 1, length(?)) = ? AND substr(path, 1, length(?)) != ?`,
    )
    .all(dir, dir, keptDir, keptDir)
    .map((row) => row.path)
    .filter((sourcePath) => !existing.has(sourcePath));
  db.transaction(() => {
    for (const sourcePath of gone) {
      deleteSourceDocs(db, sourcePath);
      db.prepare(`DELETE FROM history_sources WHERE path = ?`).run(sourcePath);
    }
  })();
  return gone.length;
}

/** Replaces every document of a source atomically, then records its signature. */
export function replaceSourceDocs(
  db: Db,
  sourcePath: string,
  signature: string,
  docs: HistoryDocInput[],
  vectors: Float32Array[],
): void {
  db.transaction(() => {
    deleteSourceDocs(db, sourcePath);

    const insertDoc = db.prepare(
      `INSERT INTO history_docs
         (kind, source_path, session_id, exchange_idx, repo, branch, tickets, ts, vault_note, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = db.prepare(`INSERT INTO history_fts (rowid, text, tickets) VALUES (?, ?, ?)`);
    // vec0 rejects a float-bound rowid, and better-sqlite3 binds JS numbers as REAL.
    const insertVec = db.prepare(
      `INSERT INTO history_vec (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`,
    );
    docs.forEach((doc, i) => {
      const tickets = doc.tickets.join(" ");
      const { lastInsertRowid } = insertDoc.run(
        doc.kind, doc.sourcePath, doc.sessionId, doc.exchangeIdx, doc.repo,
        doc.branch, tickets, doc.ts, doc.vaultNote, doc.text,
      );
      const id = Number(lastInsertRowid);
      insertFts.run(id, doc.text, tickets);
      const vector = vectors[i];
      if (vector) insertVec.run(id, toBlob(vector));
    });

    db.prepare(
      `INSERT INTO history_sources (path, signature, indexed_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET signature = excluded.signature, indexed_at = excluded.indexed_at`,
    ).run(sourcePath, signature, new Date().toISOString());
  })();
}

function filterClause(filters: HistoryFilters): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (filters.ticket) {
    parts.push(`(' ' || d.tickets || ' ') LIKE ?`);
    params.push(`% ${filters.ticket.toUpperCase()} %`);
  }
  if (filters.project) {
    parts.push(`d.repo LIKE ?`);
    params.push(`%${filters.project}%`);
  }
  if (filters.since) {
    parts.push(`d.ts >= ?`);
    params.push(filters.since);
  }
  if (filters.until) {
    // `until` is a day: its whole day is included, whatever the time stored in d.ts.
    parts.push(`d.ts < date(?, '+1 day')`);
    params.push(filters.until);
  }
  return { sql: parts.length ? `AND ${parts.join(" AND ")}` : "", params };
}

/** Words become OR-ed quoted terms, so FTS5 syntax in the query cannot break the MATCH. */
function toFtsQuery(query: string): string | null {
  const terms = query.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return terms.length ? terms.map((term) => `"${term.replaceAll('"', "")}"`).join(" OR ") : null;
}

export function searchFts(db: Db, query: string, filters: HistoryFilters, limit: number): number[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  const { sql, params } = filterClause(filters);
  return db
    .prepare(
      `SELECT d.id FROM history_fts f JOIN history_docs d ON d.id = f.rowid
       WHERE history_fts MATCH ? ${sql}
       ORDER BY bm25(history_fts) LIMIT CAST(? AS INTEGER)`,
    )
    .all(match, ...params, limit)
    .map((row) => RankedSchema.parse(row).id);
}

/** vec0 KNN cannot filter or join, so over-fetch and apply the filters afterwards. */
export function searchVector(
  db: Db,
  vector: Float32Array,
  filters: HistoryFilters,
  limit: number,
): number[] {
  const nearest = db
    .prepare(
      `SELECT rowid AS id FROM history_vec
       WHERE embedding MATCH ? AND k = CAST(? AS INTEGER) ORDER BY distance`,
    )
    .all(toBlob(vector), limit * 4)
    .map((row) => RankedSchema.parse(row).id);
  if (nearest.length === 0) return [];
  const { sql, params } = filterClause(filters);
  const kept = new Set(
    db
      .prepare(
        `SELECT d.id FROM history_docs d
         WHERE d.id IN (${nearest.map(() => "?").join(",")}) ${sql}`,
      )
      .all(...nearest, ...params)
      .map((row) => RankedSchema.parse(row).id),
  );
  return nearest.filter((id) => kept.has(id)).slice(0, limit);
}

/** Every document matching the filters, newest first — used when there is no free-text query. */
export function listFiltered(db: Db, filters: HistoryFilters, limit: number): number[] {
  const { sql, params } = filterClause(filters);
  return db
    .prepare(
      `SELECT d.id FROM history_docs d WHERE 1 = 1 ${sql}
       ORDER BY d.ts DESC LIMIT CAST(? AS INTEGER)`,
    )
    .all(...params, limit)
    .map((row) => RankedSchema.parse(row).id);
}

export function getDocs(db: Db, ids: number[]): HistoryDoc[] {
  if (ids.length === 0) return [];
  return db
    .prepare(`SELECT * FROM history_docs WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids)
    .map((row) => HistoryDocSchema.parse(row));
}

export function getExchanges(db: Db, sessionId: string, from: number, to: number): HistoryDoc[] {
  return db
    .prepare(
      `SELECT * FROM history_docs
       WHERE kind = 'exchange' AND session_id = ? AND exchange_idx BETWEEN ? AND ?
       ORDER BY exchange_idx`,
    )
    .all(sessionId, from, to)
    .map((row) => HistoryDocSchema.parse(row));
}
