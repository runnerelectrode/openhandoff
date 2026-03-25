#!/usr/bin/env node

import { exportMemories, writeToStaging, readFromStaging, importToRedis, type MemoryEntry } from "./memory-redis.js";
import { snapshot, apply } from "./memory-git.js";
import { sendViaEmail, sendViaFile } from "./send.js";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

function usage(): never {
  console.log(`
openclaw-ahp — Git-versioned memory handoff

SEND:
  ahp send --to <email>           Send via email (Resend)
  ahp send --dir <path>           Write to local directory (for local agents)

  Options:
    --namespace <ns>              Redis namespace (default: AHP_NAMESPACE or "default")
    --query <text>                Semantic search to find relevant memories
    --categories <a,b,c>          Filter by category (preference,decision,fact,entity)
    --message <text>              Handoff context message
    --from <email>                Sender email (default: ahp@resend.dev)

RECEIVE:
  ahp receive --bundle <path>     Apply a git bundle to local directory
    --target <dir>                Target directory (default: .ahp-received)
    --import-redis                Also push entries into local Redis

Environment:
  RESEND_API_KEY                  For email transport
  AHP_REDIS_URL                   Agent memory server (default: http://localhost:8000)
  AHP_NAMESPACE                   Default namespace
`);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 0) args._command = positional[0];
  return args;
}

function entriesToMarkdown(entries: MemoryEntry[]): string {
  const grouped: Record<string, MemoryEntry[]> = {};
  for (const e of entries) {
    (grouped[e.category] ??= []).push(e);
  }

  const lines: string[] = [];
  for (const [category, items] of Object.entries(grouped)) {
    lines.push(`### ${category}`);
    lines.push("");
    for (const item of items) {
      lines.push(`- ${item.content}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function send(args: Record<string, string>): Promise<void> {
  const namespace = args.namespace ?? process.env.AHP_NAMESPACE ?? "default";
  const redisUrl = args["redis-url"] ?? process.env.AHP_REDIS_URL ?? "http://localhost:8000";
  const message = args.message ?? "AHP Handoff";
  const categories = args.categories?.split(",").map((c) => c.trim());

  // 1. Export memories from Redis
  console.log(`Querying Redis for namespace "${namespace}"...`);
  const entries = await exportMemories({
    serverUrl: redisUrl,
    namespace,
    categories,
    query: args.query,
  });

  if (entries.length === 0) {
    console.error("No memories found.");
    process.exit(1);
  }
  console.log(`Found ${entries.length} memories.`);

  // 2. Write to staging + git bundle
  const stagingDir = join(tmpdir(), `ahp-staging-${crypto.randomUUID()}`);
  mkdirSync(stagingDir, { recursive: true });
  writeToStaging(entries, stagingDir);

  const peerId = args.to ?? args.dir ?? "default";
  const bundle = await snapshot(stagingDir, peerId);
  console.log(`Git bundle: ${bundle.length} bytes`);

  // 3. Build readable memory context
  const memoryContext = entriesToMarkdown(entries);
  const handoffId = `ahp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  // 4. Send
  if (args.to) {
    // Email transport via Apify
    const apifyToken = process.env.APIFY_TOKEN;
    if (!apifyToken) {
      console.error("Error: APIFY_TOKEN required");
      process.exit(1);
    }

    console.log(`Sending to ${args.to}...`);
    const result = await sendViaEmail({
      apifyToken,
      to: args.to,
      subject: `[AHP] ${message}`,
      message,
      memoryContext,
      bundle,
    });
    console.log(`Sent! Email ID: ${result.id}`);

  } else if (args.dir) {
    // File transport
    const result = sendViaFile({
      dir: args.dir,
      handoffId,
      message,
      memoryContext,
      bundle,
    });
    console.log(`Written to: ${result.path}`);

  } else {
    console.error("Error: --to <email> or --dir <path> required");
    process.exit(1);
  }

  console.log(`Handoff ID: ${handoffId}`);

  // Cleanup
  try { rmSync(stagingDir, { recursive: true, force: true }); } catch {}
}

async function receive(args: Record<string, string>): Promise<void> {
  const bundlePath = args.bundle;
  if (!bundlePath) {
    console.error("Error: --bundle required");
    process.exit(1);
  }

  const targetDir = args.target ?? join(process.cwd(), ".ahp-received");
  const redisUrl = args["redis-url"] ?? process.env.AHP_REDIS_URL ?? "http://localhost:8000";

  console.log(`Applying bundle to ${targetDir}...`);
  const { readFileSync } = await import("node:fs");
  const bundleData = readFileSync(bundlePath);
  const result = await apply(targetDir, bundleData);
  console.log(`Imported ${result.filesImported} files.`);

  if (args["import-redis"] === "true") {
    const entries = readFromStaging(targetDir);
    const imported = await importToRedis(entries, redisUrl);
    console.log(`Pushed ${imported} entries to Redis.`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args._command) {
    case "send":
      await send(args);
      break;
    case "receive":
      await receive(args);
      break;
    default:
      usage();
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
