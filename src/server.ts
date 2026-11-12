import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { toolRegistrars } from "./tools/index.js";
import type { ToolContext } from "./tools/types.js";
import { logger } from "./utils/logger.js";

const require = createRequire(import.meta.url);
const { version } = z
  .object({ version: z.string() })
  .parse(require("../package.json"));

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "second-brain-mcp", version },
    {
      instructions: `Searches the user's past Claude Code conversations and, when configured, their Markdown notes. For past work, a ticket id, a decision or "why did we do X", call search_history before searching files by hand. It matches meaning as well as exact words.`,
    },
  );
  toolRegistrars.forEach((register) => register(server, ctx));
  return server;
}

export async function startMcpServer(ctx: ToolContext): Promise<void> {
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("second-brain-mcp server running on stdio");
}
