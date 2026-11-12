import { z } from "zod/v4";
import { getExchanges } from "../db/schemas/history.js";
import { errorResult, textResult, type ToolRegistrar } from "./types.js";

export const registerReadExchangeTool: ToolRegistrar = (server, { db }) => {
  server.registerTool(
    "read_exchange",
    {
      description: `Read the raw conversation around an exchange found by search_history.`,
      inputSchema: z.object({
        session_id: z.string().describe("session_id from a search_history result"),
        index: z.number().int().min(0).describe("Exchange number from a search_history result"),
        around: z.number().int().min(0).max(10).default(2).describe("Exchanges to include before and after"),
      }),
    },
    async ({ session_id, index, around }) => {
      const exchanges = getExchanges(db, session_id, index - around, index + around);
      if (exchanges.length === 0) {
        return errorResult(`No exchange indexed for session ${session_id} around ${index}.`);
      }
      const blocks = exchanges.map(
        (doc) => `### exchange ${doc.exchange_idx} · ${doc.ts?.slice(0, 16) ?? "?"}\n\n${doc.text}`,
      );
      return textResult(blocks.join("\n\n---\n\n"));
    },
  );
};
