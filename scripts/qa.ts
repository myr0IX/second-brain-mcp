/**
 * QA against the built server, spawned as real child processes over stdio — the exact path
 * an MCP client takes. Uses the real Mistral API on a disposable database and transcripts folder.
 * Two servers start at once on the same database: exactly one may index in the background.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { sessions, writeTranscripts } from "./fixtures/transcripts.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(projectRoot, "dist", "cli.js");

const INDEX_DONE = /^\[info\] background index: \d+ sources indexed.*$/m;
const INDEX_SKIPPED = /^\[info\] background index skipped:.*$/m;
// Generous: the Mistral client backs off on rate limits before giving up.
const INDEX_TIMEOUT_MS = 180_000;
const SEARCH_TIMEOUT_MS = 60_000;

type Server = { name: string; transport: StdioClientTransport; client: Client; stderr: () => string };

function spawnServer(name: string, env: Record<string, string>): Server {
  // Only a few default variables (PATH, HOME…) are inherited, so SECOND_BRAIN_NOTES stays unset.
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env, stderr: "pipe" });
  let log = "";
  transport.stderr?.on("data", (chunk) => {
    log += String(chunk);
  });
  return { name, transport, client: new Client({ name: `qa-${name}`, version: "0.0.0" }), stderr: () => log };
}

async function callTool(server: Server, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return CallToolResultSchema.parse(await server.client.callTool({ name, arguments: args }));
}

function textOf(result: CallToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null> | T | null): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    await sleep(500);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  const apiKey = process.env.MISTRAL_API_KEY;
  assert.ok(apiKey, "MISTRAL_API_KEY is required");
  assert.ok(fs.existsSync(serverEntry), `${serverEntry} is missing — run \`npm run build\` first`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "second-brain-qa-"));
  const transcriptsDir = path.join(root, "projects");
  writeTranscripts(transcriptsDir);
  const env = {
    MISTRAL_API_KEY: apiKey,
    SECOND_BRAIN_DB: path.join(root, "brain.db"),
    SECOND_BRAIN_TRANSCRIPTS: transcriptsDir,
  };
  const servers = ["A", "B"].map((name) => spawnServer(name, env));

  try {
    await Promise.all(servers.map((server) => server.client.connect(server.transport)));

    section("background index (two servers, one database)");
    const [indexer, other] = await waitFor("one finished index run and one skip", INDEX_TIMEOUT_MS, () => {
      const done = servers.filter((server) => INDEX_DONE.test(server.stderr()));
      const skipped = servers.filter((server) => INDEX_SKIPPED.test(server.stderr()));
      return done.length + skipped.length === servers.length ? [...done, ...skipped] : null;
    });
    for (const server of servers) {
      const line = server.stderr().match(INDEX_DONE)?.[0] ?? server.stderr().match(INDEX_SKIPPED)?.[0];
      console.log(`${server.name}: ${line}`);
    }
    assert.ok(indexer && other, "both servers reported");
    assert.equal(
      servers.filter((server) => INDEX_DONE.test(server.stderr())).length,
      1,
      "exactly one process indexes",
    );
    assert.match(indexer.stderr(), /background index: 3 sources indexed, .* 0 failed/, "the three sessions are indexed");

    section("search_history (from the server that did not index)");
    const invoice = sessions[0];
    assert.ok(invoice, "the invoice fixture exists");
    const query = "comment ne plus oublier de rappeler les clients qui ne m'ont pas encore payé";
    const firstSessionId = await waitFor("the invoice session as first hit", SEARCH_TIMEOUT_MS, async () => {
      const result = await callTool(other, "search_history", { query, limit: 3 });
      assert.notEqual(result.isError, true, textOf(result));
      const first = textOf(result).match(/^session_id: (\S+)$/m)?.[1] ?? null;
      return first === invoice.id ? first : null;
    });
    console.log(`"${query}"\n  first hit: ${firstSessionId} (${invoice.label})`);

    section("read_exchange");
    const exchanges = textOf(await callTool(other, "read_exchange", { session_id: firstSessionId, index: 1, around: 1 }));
    for (const turn of invoice.turns) {
      assert.ok(exchanges.includes(turn.user), `read_exchange returns the prompt: ${turn.user}`);
    }
    console.log(`${exchanges.match(/^### exchange/gm)?.length ?? 0} exchanges returned for ${invoice.label}`);

    console.log("\nqa OK");
  } finally {
    await Promise.allSettled(servers.map((server) => server.transport.close()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
