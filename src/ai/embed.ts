import { EMBEDDING_CHUNK_CHARS, EMBEDDING_DIM, EMBEDDING_MODEL } from "../utils/config.js";
import { chunkText } from "../utils/chunk.js";
import { getMistralClient, type ClientUse } from "./client.js";

/**
 * One vector for a search query. A text over the 8k-token limit of mistral-embed
 * is embedded chunk by chunk and averaged instead of being truncated.
 */
export async function embedText(text: string): Promise<Float32Array> {
  const chunks = chunkText(text, EMBEDDING_CHUNK_CHARS);
  const vectors = await embedInputs(chunks, "search");
  if (vectors.length === 0) throw new Error("Mistral returned no embedding");
  return normalize(meanPool(vectors));
}

/** One normalized vector per text, in a single request, for indexing; each text must fit the 8k-token limit. */
export async function embedMany(texts: string[]): Promise<Float32Array[]> {
  const vectors = await embedInputs(texts, "indexing");
  if (vectors.length !== texts.length) {
    throw new Error(`Mistral returned ${vectors.length} embeddings for ${texts.length} inputs`);
  }
  return vectors.map((vector) => normalize(Float32Array.from(vector)));
}

async function embedInputs(inputs: string[], use: ClientUse): Promise<number[][]> {
  const response = await getMistralClient(use).embeddings.create({ model: EMBEDDING_MODEL, inputs });
  return response.data.map((item) => {
    if (!item.embedding) throw new Error("Mistral returned an empty embedding");
    if (item.embedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `Expected ${EMBEDDING_DIM} dimensions from ${EMBEDDING_MODEL}, got ${item.embedding.length}`,
      );
    }
    return item.embedding;
  });
}

function meanPool(vectors: number[][]): Float32Array {
  const pooled = new Float32Array(EMBEDDING_DIM);
  for (const vector of vectors) {
    for (let i = 0; i < EMBEDDING_DIM; i++) pooled[i] += vector[i] ?? 0;
  }
  for (let i = 0; i < EMBEDDING_DIM; i++) pooled[i] /= vectors.length;
  return pooled;
}

function normalize(vector: Float32Array): Float32Array {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  const norm = Math.sqrt(sumOfSquares);
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}
