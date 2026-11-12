import { Mistral } from "@mistralai/mistralai";
import { MistralError } from "@mistralai/mistralai/models/errors";

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "MISTRAL_API_KEY is not set. Embedding needs it — " +
        "add it to the server env in .mcp.json or export it in your shell.",
    );
    this.name = "MissingApiKeyError";
  }
}

export function hasMistralApiKey(): boolean {
  return Boolean(process.env.MISTRAL_API_KEY);
}

/** A missing key or one Mistral rejects fails every request the same way. */
export function isAuthenticationError(err: unknown): boolean {
  return err instanceof MissingApiKeyError || (err instanceof MistralError && err.statusCode === 401);
}

/**
 * How long each use waits out rate limits (429) and server errors before failing.
 * Indexing can wait minutes; a search must answer or fail within about 15 s,
 * even while a first index saturates the rate limit.
 */
const BACKOFF = {
  indexing: { initialInterval: 10_000, maxInterval: 60_000, exponent: 1.5, maxElapsedTime: 600_000 },
  search: { initialInterval: 500, maxInterval: 4_000, exponent: 1.5, maxElapsedTime: 10_000 },
};

export type ClientUse = keyof typeof BACKOFF;

const clients = new Map<ClientUse, Mistral>();

export function getMistralClient(use: ClientUse): Mistral {
  const cached = clients.get(use);
  if (cached) return cached;
  if (!hasMistralApiKey()) throw new MissingApiKeyError();
  const client = new Mistral({
    apiKey: process.env.MISTRAL_API_KEY,
    retryConfig: { strategy: "backoff", backoff: BACKOFF[use], retryConnectionErrors: true },
  });
  clients.set(use, client);
  return client;
}
