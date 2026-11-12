import type { Ai } from "../ai/index.js";
import type { Db } from "../db/db.js";
import {
  getDocs,
  listFiltered,
  searchFts,
  searchVector,
  type HistoryDoc,
  type HistoryFilters,
} from "../db/schemas/history.js";

/** Reciprocal Rank Fusion constant from the original paper; robust without tuning. */
const RRF_K = 60;
const CANDIDATES_PER_RETRIEVER = 50;

export type SessionHit = {
  /** Session id, or the vault note name for notes not tied to a session. */
  key: string;
  score: number;
  docs: HistoryDoc[];
};

export function fuseRanks(rankings: number[][]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return scores;
}

/** Duplicates are merged here, at query time: every hit of a session lands in one group. */
export function groupBySession(docs: HistoryDoc[], scores: Map<number, number>): SessionHit[] {
  const groups = new Map<string, SessionHit>();
  for (const doc of docs) {
    const key = doc.session_id ?? doc.vault_note ?? String(doc.id);
    const score = scores.get(doc.id) ?? 0;
    const group = groups.get(key) ?? { key, score: 0, docs: [] };
    group.score = Math.max(group.score, score);
    group.docs.push(doc);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.docs.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
  }
  return [...groups.values()].sort((a, b) => b.score - a.score);
}

/** Hybrid search: exact terms (FTS5/BM25) and meaning (vectors), fused with RRF, grouped by session. */
export async function searchHistory(
  db: Db,
  ai: Ai,
  query: string | undefined,
  filters: HistoryFilters,
  limit: number,
): Promise<SessionHit[]> {
  let scores: Map<number, number>;
  if (query) {
    scores = fuseRanks([
      searchFts(db, query, filters, CANDIDATES_PER_RETRIEVER),
      searchVector(db, await ai.embed(query), filters, CANDIDATES_PER_RETRIEVER),
    ]);
  } else {
    scores = fuseRanks([listFiltered(db, filters, CANDIDATES_PER_RETRIEVER * 4)]);
  }
  return groupBySession(getDocs(db, [...scores.keys()]), scores).slice(0, limit);
}
