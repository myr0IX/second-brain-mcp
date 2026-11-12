import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ai } from "../ai/index.js";
import type { Db } from "../db/db.js";

export type ToolContext = {
  db: Db;
  ai: Ai;
};

export type ToolRegistrar = (server: McpServer, ctx: ToolContext) => void;

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
