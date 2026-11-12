/**
 * End-to-end smoke test: drives the MCP tools through an in-memory client,
 * offline with a stub embedder, plus one real server process started without an API key.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MissingApiKeyError } from "../src/ai/client.js";
import type { Ai } from "../src/ai/index.js";
import { createDb, type Db } from "../src/db/db.js";
import { claimIndexRun } from "../src/db/schemas/meta.js";
import { startBackgroundIndex } from "../src/history/auto-index.js";
import { indexHistory } from "../src/history/index-history.js";
import { createMcpServer } from "../src/server.js";
import { EMBEDDING_DIM, INDEX_CLAIM_TTL_MS } from "../src/utils/config.js";
import { sessions, writeTranscripts } from "./fixtures/transcripts.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const stubAi: Ai = {
  embed: async (text) => normalize(bagOfWords(text)),
  embedMany: async (texts) => texts.map((text) => normalize(bagOfWords(text))),
};

function bagOfWords(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIM);
  for (const token of text.toLowerCase().match(/[a-zà-ÿ]{3,}/g) ?? []) {
    let hash = 0;
    for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) % EMBEDDING_DIM;
    vector[hash] += 1;
  }
  return vector;
}

function normalize(vector: Float32Array): Float32Array {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

type Call = (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;

/** Collects what the logger writes to stderr while `run` executes. */
async function captureStderr(run: () => Promise<void>): Promise<string> {
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = (chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  };
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return output;
}

type Connected = { client: Client; call: Call; close: () => Promise<void> };

async function connectClient(ai: Ai, db: Db): Promise<Connected> {
  const server = createMcpServer({ db, ai });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    call: async (name, args = {}) => CallToolResultSchema.parse(await client.callTool({ name, arguments: args })),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "second-brain-smoke-"));
  const db = createDb(path.join(root, "brain.db"));
  const { client, call, close } = await connectClient(stubAi, db);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["read_exchange", "search_history"],
    "only the history tools must be exposed",
  );

  await smokeHistory(root, db, call);
  await smokeDanglingEntries(root);
  await smokeTranscriptsInsideNotes(root);
  smokeDimensionMismatch(root);
  smokeIndexClaim(root);
  await smokeBackgroundIndexFailures(root);
  await smokeAuthFailureStopsRun(root);
  await smokeMissingApiKey(root);
  await smokeKeylessServerStart(root);
  smokeKeylessIndexCommand(root);

  await close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("smoke OK (stub embedder)");
}

/** Dangling symlinks in the transcripts folder are skipped; the other sessions are still indexed. */
async function smokeDanglingEntries(root: string): Promise<void> {
  const transcriptsDir = path.join(root, "dangling-projects");
  writeTranscripts(transcriptsDir);
  const nowhere = path.join(root, "nowhere");
  const session = sessions[0];
  assert.ok(session, "the fixture has sessions");
  fs.symlinkSync(nowhere, path.join(transcriptsDir, "broken-project"));
  fs.symlinkSync(`${nowhere}.jsonl`, path.join(transcriptsDir, session.repo, "broken.jsonl"));
  const db = createDb(path.join(root, "dangling.db"));
  const stats = await indexHistory(db, stubAi, { transcriptsDir, notesDir: null });
  db.close();
  assert.equal(stats.failed, 0, "dangling entries are not sources");
  assert.equal(stats.sources, sessions.length, "every real session is indexed");
}

/**
 * A notes folder that contains the transcripts folder (SECOND_BRAIN_NOTES=$HOME):
 * a deleted note is pruned, a transcript removed by Claude Code's cleanup is not.
 */
async function smokeTranscriptsInsideNotes(root: string): Promise<void> {
  const home = path.join(root, "home");
  const transcriptsDir = path.join(home, ".claude", "projects");
  writeTranscripts(transcriptsDir);
  const notesDir = path.join(home, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, "kept.md"), "# Kept\n");
  fs.writeFileSync(path.join(notesDir, "deleted.md"), "# Deleted\n");
  const session = sessions[0];
  assert.ok(session, "the fixture has sessions");

  const db = createDb(path.join(root, "inside-notes.db"));
  const options = { transcriptsDir, notesDir: home };
  const first = await indexHistory(db, stubAi, options);
  assert.equal(first.sources, sessions.length + 2, "sessions and notes are indexed");
  fs.rmSync(path.join(transcriptsDir, session.repo, `${session.id}.jsonl`));
  fs.rmSync(path.join(notesDir, "deleted.md"));
  const second = await indexHistory(db, stubAi, options);
  assert.equal(second.pruned, 1, "only the deleted note is pruned");

  const { call, close } = await connectClient(stubAi, db);
  const exchange = await call("read_exchange", { session_id: session.id, index: 0, around: 0 });
  await close();
  db.close();
  assert.notEqual(exchange.isError, true, `the cleaned-up transcript is still readable, got:\n${textOf(exchange)}`);
}

/** A database built with another embedding size must be refused, naming the setting to change. */
function smokeDimensionMismatch(root: string): void {
  const dbPath = path.join(root, "other-dim.db");
  const db = createDb(dbPath);
  db.prepare(`UPDATE meta SET value = ? WHERE key = 'embedding_dim'`).run(String(EMBEDDING_DIM + 1));
  db.close();
  assert.throws(() => createDb(dbPath), /SECOND_BRAIN_DB/, "the dimension error names SECOND_BRAIN_DB");
}

/** Two connections on one file: only one claim wins until the previous one is older than the TTL. */
function smokeIndexClaim(root: string): void {
  const dbPath = path.join(root, "claim.db");
  const a = createDb(dbPath);
  const b = createDb(dbPath);
  assert.equal(claimIndexRun(a, 1000, INDEX_CLAIM_TTL_MS), true, "the first claim wins");
  assert.equal(claimIndexRun(b, 1001, INDEX_CLAIM_TTL_MS), false, "a second claim within the TTL loses");
  assert.equal(
    claimIndexRun(b, 1000 + INDEX_CLAIM_TTL_MS, INDEX_CLAIM_TTL_MS),
    true,
    "a claim older than the TTL can be taken again",
  );
  a.close();
  b.close();
}

/** Background indexing logs its failures and never rejects: the server must keep serving. */
async function smokeBackgroundIndexFailures(root: string): Promise<void> {
  const failingAi: Ai = {
    embed: async () => {
      throw new Error("embedder down");
    },
    embedMany: async () => {
      throw new Error("embedder down");
    },
  };
  const transcriptsDir = path.join(root, "background-projects");
  const lines = [1, 2, 3].map((n) =>
    JSON.stringify({ type: "user", uuid: `u${n}`, cwd: "/home/dev/app", message: { content: `Prompt ${n}` } }),
  );
  fs.mkdirSync(path.join(transcriptsDir, "repo"), { recursive: true });
  fs.writeFileSync(path.join(transcriptsDir, "repo", "background.jsonl"), lines.join("\n"));
  const notADir = path.join(root, "not-a-directory");
  fs.writeFileSync(notADir, "");

  const cases = [
    { label: "embedder throws", transcriptsDir, expected: /^\[warn\] .*embedder down/m },
    { label: "transcripts path is a file", transcriptsDir: notADir, expected: /^\[warn\] background index failed/m },
  ];
  for (const [i, { label, transcriptsDir: dir, expected }] of cases.entries()) {
    const db = createDb(path.join(root, `background-${i}.db`));
    const output = await captureStderr(() => startBackgroundIndex(db, failingAi, { transcriptsDir: dir, notesDir: null }));
    db.close();
    assert.match(output, expected, `${label}: the failure is logged as a warning, got:\n${output}`);
  }

  const db = createDb(path.join(root, "background-direct.db"));
  const stats = await indexHistory(db, failingAi, { transcriptsDir, notesDir: null });
  db.close();
  assert.equal(stats.sources, 0, "a source whose embedding failed is not counted as indexed");
  assert.equal(stats.docs, 0, "nor are its documents");
  assert.ok(stats.failed > 0, "it is counted as failed");
}

/** A missing or rejected key fails every source the same way: the run stops at the first one. */
async function smokeAuthFailureStopsRun(root: string): Promise<void> {
  let attempts = 0;
  const rejectingAi: Ai = {
    embed: async () => {
      throw new MissingApiKeyError();
    },
    embedMany: async () => {
      attempts++;
      throw new MissingApiKeyError();
    },
  };
  const transcriptsDir = path.join(root, "auth-projects");
  writeTranscripts(transcriptsDir);
  const db = createDb(path.join(root, "auth.db"));
  let stats: Awaited<ReturnType<typeof indexHistory>> | undefined;
  const output = await captureStderr(async () => {
    stats = await indexHistory(db, rejectingAi, { transcriptsDir, notesDir: null });
  });
  db.close();
  assert.equal(attempts, 1, "one embedding attempt across all sources");
  assert.equal(stats?.sources, 0, "nothing is indexed");
  assert.equal(stats?.failed, 1, "the source that hit the error is failed");
  assert.equal(stats?.notProcessed, 2, "the other sources are not processed");
  assert.equal(output.match(/^\[error\] .*MISTRAL_API_KEY/gm)?.length, 1, `exactly one error, got:\n${output}`);
  assert.doesNotMatch(output, /^\[warn\]/m, `no per-source warning, got:\n${output}`);
}

/** `index` without MISTRAL_API_KEY refuses to start: one error naming the variable, exit code 1. */
function smokeKeylessIndexCommand(root: string): void {
  const dir = path.join(root, "keyless-index");
  const dbPath = path.join(dir, "brain.db");
  const transcriptsDir = path.join(dir, "projects");
  writeTranscripts(transcriptsDir);
  // Only the SDK's default variables (PATH, HOME…) reach the child, so MISTRAL_API_KEY is absent.
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(projectRoot, "src", "cli.ts"), "index"],
    {
      cwd: projectRoot,
      env: { ...getDefaultEnvironment(), SECOND_BRAIN_DB: dbPath, SECOND_BRAIN_TRANSCRIPTS: transcriptsDir },
      encoding: "utf8",
    },
  );
  const { stderr, status } = result;
  assert.equal(status, 1, `exit code 1, got ${status}:\n${stderr}`);
  assert.equal(stderr.match(/^\[error\] .*MISTRAL_API_KEY.*$/gm)?.length, 1, `exactly one error naming the key, got:\n${stderr}`);
  assert.doesNotMatch(stderr, /^\[(warn|info)\]/m, `no per-source warning and no summary, got:\n${stderr}`);
  assert.equal(result.stdout, "", "nothing on stdout");
  assert.equal(fs.existsSync(dbPath), false, "no database is created");
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Without MISTRAL_API_KEY the server still answers, with an error that names the variable. */
async function smokeMissingApiKey(root: string): Promise<void> {
  const missingKeyAi: Ai = {
    embed: async () => {
      throw new MissingApiKeyError();
    },
    embedMany: async () => {
      throw new MissingApiKeyError();
    },
  };
  const db = createDb(path.join(root, "missing-key.db"));
  const { call, close } = await connectClient(missingKeyAi, db);
  const result = await call("search_history", { query: "x" });
  await close();
  db.close();
  assert.equal(result.isError, true, "a missing key is an error result");
  assert.match(textOf(result), /MISTRAL_API_KEY/, "the error names MISTRAL_API_KEY");
}

/**
 * The real CLI, started without MISTRAL_API_KEY on a folder with sessions to index:
 * it serves the tools, warns once, and never claims or runs a background index.
 * Spawned from the TypeScript entry through tsx, so no build is needed.
 */
async function smokeKeylessServerStart(root: string): Promise<void> {
  const dir = path.join(root, "keyless");
  const dbPath = path.join(dir, "brain.db");
  const transcriptsDir = path.join(dir, "projects");
  writeTranscripts(transcriptsDir);
  // Only the SDK's default variables (PATH, HOME…) reach the child: MISTRAL_API_KEY is absent
  // even when this process has it.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(projectRoot, "src", "cli.ts")],
    cwd: projectRoot,
    env: { SECOND_BRAIN_DB: dbPath, SECOND_BRAIN_TRANSCRIPTS: transcriptsDir },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "smoke-keyless", version: "0.0.0" });
  // The SDK skips a stdout line that is not JSON-RPC and only reports it here.
  const protocolErrors: string[] = [];
  client.onerror = (err) => protocolErrors.push(String(err));
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["read_exchange", "search_history"],
      "the keyless server still exposes its tools",
    );
    const result = CallToolResultSchema.parse(
      await client.callTool({ name: "search_history", arguments: { query: "x" } }),
    );
    assert.equal(result.isError, true, "search without a key is an error result");
    assert.match(textOf(result), /MISTRAL_API_KEY/, "the search error names MISTRAL_API_KEY");
    assert.deepEqual(protocolErrors, [], "stdout carries only protocol messages");

    await transport.close();
    assert.equal(
      stderr.match(/^\[warn\] MISTRAL_API_KEY is not set.*$/gm)?.length,
      1,
      `exactly one missing-key warning, got:\n${stderr}`,
    );
    assert.doesNotMatch(stderr, /background index(:| skipped| failed)/, `no background index runs or skips, got:\n${stderr}`);
    const db = createDb(dbPath);
    const claim = db.prepare(`SELECT value FROM meta WHERE key = 'index_claimed_at'`).get();
    db.close();
    assert.equal(claim, undefined, "a keyless start takes no index claim");
  } finally {
    await transport.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A fixture transcript and notes folder, indexed with the stub embedder, then searched through the tools. */
async function smokeHistory(root: string, db: Db, call: Call): Promise<void> {
  const transcriptsDir = path.join(root, "projects");
  const notesDir = path.join(root, "notes");
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const decisionPath = path.join(notesDir, "projects", "acme-shop", "decisions", "2026-09-02-checkout-retry.md");
  const writeFile = (filePath: string, content: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };

  // An opaque worktree folder name: only the linked session note knows the project.
  const cwd = "/home/dev/worktrees/3f9c2b7e";
  const entry = (type: string, uuid: string, content: unknown, extra: object = {}) =>
    JSON.stringify({
      type, uuid, cwd, gitBranch: "feature/SHOP-42-checkout", timestamp: "2026-09-02T10:00:00Z",
      message: { content }, ...extra,
    });
  const lines = [
    entry("user", "u1", "The checkout retry fails on the staging server."),
    entry("assistant", "a1", [{ type: "text", text: "The payment_id is missing from the retry route." }]),
    entry("assistant", "a1", [{ type: "text", text: "duplicate ignored" }]),
    entry("user", "u2", [{ type: "tool_result", content: "tool output ignored" }]),
    entry("user", "u3", "<command-name>/clear</command-name>"),
    entry("user", "u4", "Add a test for the retry route."),
    entry("assistant", "a4", [{ type: "text", text: "Test added for payment_id." }]),
    entry("assistant", "s1", [{ type: "text", text: "sidechain ignored" }], { isSidechain: true }),
    entry("user", "m1", "Base directory for this skill: injected content ignored", { isMeta: true }),
    entry("user", "c1", "This session is being continued: summary ignored", { isCompactSummary: true }),
    entry("user", "u5", "Perfect, let's merge."),
    "not json",
  ];
  writeFile(path.join(transcriptsDir, "repo", `${sessionId}.jsonl`), lines.join("\n"));
  writeFile(path.join(transcriptsDir, "repo", "short.jsonl"), entry("user", "x1", "A single question, ignored."));

  writeFile(
    decisionPath,
    "---\ntype: decision\ndate: 2026-09-02\nstatus: active\n---\n\n# Pass payment_id to the retry route (SHOP-42)\n",
  );
  writeFile(path.join(notesDir, "inbox", "idea.md"), "# Idea\n\nCache the shipping rates.\n");
  for (const skipped of [".obsidian/workspace.md", ".git/notes.md", "node_modules/pkg/readme.md", ".trash/old.md"]) {
    writeFile(path.join(notesDir, skipped), "# Skipped\n\nSHOP-42 must not be indexed from here.\n");
  }
  writeFile(
    path.join(notesDir, "sessions", "2026-09-02-checkout.md"),
    `---\ntype: session\nproject: acme-shop\nsession_id: ${sessionId}\n---\n\n# Checkout retry fix\n`,
  );

  const options = { transcriptsDir, notesDir };
  const first = await indexHistory(db, stubAi, options);
  assert.equal(first.failed, 0, "indexing succeeds");
  assert.equal(
    first.docs,
    6,
    "3 exchanges (sidechain, tool result, <…>, meta, summary and duplicate skipped) + 3 notes (decision, inbox, session)",
  );
  const indexedPaths = db
    .prepare<[], { source_path: string }>(`SELECT DISTINCT source_path FROM history_docs`)
    .all()
    .map((row) => row.source_path);
  for (const hidden of [".obsidian", ".git", "node_modules", ".trash"]) {
    assert.ok(
      indexedPaths.every((sourcePath) => !sourcePath.includes(hidden)),
      `nothing under ${hidden} is indexed, got:\n${indexedPaths.join("\n")}`,
    );
  }
  const second = await indexHistory(db, stubAi, options);
  assert.equal(second.sources, 0, "re-indexing unchanged sources does nothing");

  const byTicket = textOf(await call("search_history", { ticket: "SHOP-42" }));
  assert.match(byTicket, new RegExp(`session_id: ${sessionId}`), "ticket filter finds the session");
  assert.match(byTicket, /\[\[2026-09-02-checkout\]\]/, "the session note linked through session_id is shown");
  assert.match(byTicket, /2026-09-02-checkout-retry/, "the decision note matches the ticket too");
  assert.match(byTicket, /\[exchange \d+\]/, "exchange excerpts are labelled in English");
  assert.match(byTicket, /\[note 2026-09-02-checkout-retry\]/, "note excerpts are labelled with the note name");
  assert.equal(
    byTicket.match(/^### /gm)?.length,
    2,
    "the three exchanges are grouped into one session hit, plus the decision",
  );

  const byQuery = textOf(await call("search_history", { query: "checkout retry route", project: "acme" }));
  assert.match(
    byQuery,
    /^### 2026-09-02 · acme-shop · feature\/SHOP-42-checkout/m,
    `an opaque worktree folder takes the session note's project, got:\n${byQuery}`,
  );

  const raw = textOf(await call("read_exchange", { session_id: sessionId, index: 1, around: 1 }));
  assert.match(raw, /^### exchange 0[\s\S]*^### exchange 1[\s\S]*^### exchange 2/m, "read_exchange returns the neighbours");
  assert.match(raw, /^USER: /m, "the user turn is labelled USER");
  assert.match(raw, /^AGENT: /m, "the agent turn is labelled AGENT");
  assert.doesNotMatch(raw, /sidechain|tool output|duplicate|injected|summary ignored/, "skipped entries never reach the index");

  const untilSameDay = textOf(await call("search_history", { ticket: "SHOP-42", until: "2026-09-02" }));
  assert.match(untilSameDay, new RegExp(`session_id: ${sessionId}`), "until includes its whole day");
  const untilDayBefore = textOf(await call("search_history", { ticket: "SHOP-42", until: "2026-09-01" }));
  assert.doesNotMatch(untilDayBefore, new RegExp(`session_id: ${sessionId}`), "until excludes the next day");

  assert.equal(
    textOf(await call("search_history", { ticket: "NONE-1" })),
    "No results in the history.",
    "an empty search says so in English",
  );
  const missingArgs = await call("search_history", {});
  assert.equal(missingArgs.isError, true, "query or ticket is required");
  assert.match(textOf(missingArgs), /query or ticket/, "the error names the missing arguments");

  const conversationsOnly: { label: string; dir: string | null }[] = [
    { label: "unset", dir: null },
    { label: "missing", dir: path.join(root, "no-such-notes") },
  ];
  for (const { label, dir } of conversationsOnly) {
    const otherDb = createDb(path.join(root, `conversations-only-${label}.db`));
    const stats = await indexHistory(otherDb, stubAi, { transcriptsDir, notesDir: dir });
    otherDb.close();
    assert.equal(stats.failed, 0, `notes folder ${label}: indexing succeeds`);
    assert.equal(stats.docs, 3, `notes folder ${label}: only the 3 exchanges are indexed`);
    assert.equal(stats.pruned, 0, `notes folder ${label}: nothing is pruned`);
  }

  // The indexed folder disappears (unmounted drive, renamed folder): its notes must survive.
  fs.renameSync(notesDir, `${notesDir}-away`);
  const missingFolder = await indexHistory(db, stubAi, options);
  fs.renameSync(`${notesDir}-away`, notesDir);
  assert.equal(missingFolder.pruned, 0, "a missing notes folder does not prune the notes already indexed");
  assert.match(
    textOf(await call("search_history", { ticket: "SHOP-42" })),
    /2026-09-02-checkout-retry/,
    "notes indexed before the folder went missing still match",
  );

  if (process.getuid?.() !== 0) {
    const lockedPath = path.join(notesDir, "inbox", "locked.md");
    writeFile(lockedPath, "# Locked\n");
    fs.chmodSync(lockedPath, 0o000);
    writeFile(path.join(notesDir, "inbox", "later.md"), "# Later\n\nFollow-up for SHOP-42.\n");
    const withUnreadable = await indexHistory(db, stubAi, options);
    fs.rmSync(lockedPath);
    assert.ok(withUnreadable.failed >= 1, "an unreadable note counts as a failed source");
    assert.match(
      textOf(await call("search_history", { ticket: "SHOP-42" })),
      /\[\[later\]\]/,
      "the other notes are still indexed in the same run",
    );
  }

  fs.rmSync(decisionPath);
  const third = await indexHistory(db, stubAi, options);
  assert.equal(third.pruned, 1, "a deleted note is pruned");
  fs.rmSync(path.join(transcriptsDir, "repo", `${sessionId}.jsonl`));
  assert.equal((await indexHistory(db, stubAi, options)).pruned, 0, "a cleaned-up transcript stays indexed");
  assert.match(
    textOf(await call("search_history", { ticket: "SHOP-42" })),
    new RegExp(`session_id: ${sessionId}`),
    "its exchanges are still searchable",
  );
  assert.doesNotMatch(
    textOf(await call("search_history", { ticket: "SHOP-42" })),
    /2026-09-02-checkout-retry/,
    "pruned notes no longer match",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
