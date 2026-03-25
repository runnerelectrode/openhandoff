# openhandoff

Git-versioned memory handoff for AI agents.

Export memories from Redis, snapshot with git, send via email or local file drop.

## What it does

1. Queries your agent's memory (Redis agent-memory-server)
2. Git-snapshots the memories (versioned, delta-sync capable)
3. Sends them via email (Apify/Resend) or writes locally

The recipient gets a readable markdown with the memory context + a git bundle for versioned import.

## Usage

```bash
# Send via email
APIFY_TOKEN=your_token node dist/index.js send \
  --namespace my-project \
  --query "auth middleware review" \
  --to colleague@example.com \
  --message "Continue the PR review at home"

# Send to local directory
node dist/index.js send \
  --namespace my-project \
  --query "auth middleware" \
  --dir ./handoffs \
  --message "Continue the PR review"

# Receive a handoff
node dist/index.js receive \
  --bundle ./handoffs/ahp_123/memory.bundle \
  --target ./my-memory \
  --import-redis
```

## OpenClaw Plugin

Also ships as an OpenClaw plugin that registers a `handoff` native tool. The agent can call it directly from chat:

```
/handoff user@example.com continue the PR review
```

See `plugin/` for the OpenClaw plugin source.

## How it works

```
Redis memory → categorized markdown files → git commit → git bundle → send
```

- **Memory**: Pulls from Redis agent-memory-server via `/v1/long-term-memory/search`
- **Versioning**: Git tracks changes per-entry. Delta bundles on repeat handoffs to same peer.
- **Transport**: Email (Apify send-mail actor) or local file (HANDOFF.md + memory.bundle)
- **Receive**: `git bundle verify` + `git fetch/merge` + optional Redis re-import

## Requirements

- Node.js 18+
- Git
- Redis agent-memory-server (for memory source)
- Apify token (for email transport) or Resend API key

## Zero dependencies

No runtime npm dependencies. Uses native `fetch` and `child_process.execFile("git", ...)`.

## License

MIT
