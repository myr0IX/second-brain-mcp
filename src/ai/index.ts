import { embedMany, embedText } from "./embed.js";

/** Injected into the tools so tests can run without an API key. */
export type Ai = {
  embed: (text: string) => Promise<Float32Array>;
  embedMany: (texts: string[]) => Promise<Float32Array[]>;
};

export function createAi(): Ai {
  return { embed: embedText, embedMany };
}
