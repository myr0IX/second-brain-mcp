import { registerReadExchangeTool } from "./read-exchange.js";
import { registerSearchHistoryTool } from "./search-history.js";
import type { ToolRegistrar } from "./types.js";

export const toolRegistrars: ToolRegistrar[] = [
  registerSearchHistoryTool,
  registerReadExchangeTool,
];
