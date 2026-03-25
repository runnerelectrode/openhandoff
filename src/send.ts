import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// --- Email Transport (Apify send-mail) ---

export type EmailOpts = {
  apifyToken: string;
  to: string;
  subject: string;
  message: string;
  memoryContext: string;
  bundle: Buffer;
};

export async function sendViaEmail(opts: EmailOpts): Promise<{ id: string }> {
  const body = {
    to: opts.to,
    subject: opts.subject,
    text: [
      opts.message,
      "",
      "---",
      "",
      "## Memory Context",
      "",
      opts.memoryContext,
      "",
      "---",
      `Git bundle (${opts.bundle.length} bytes) available for versioned import.`,
    ].join("\n"),
  };

  const url = `https://api.apify.com/v2/acts/apify~send-mail/runs?token=${opts.apifyToken}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Apify send-mail error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { data?: { id?: string } };
  return { id: data.data?.id ?? "unknown" };
}

// --- File Transport (local agents) ---

export type FileOpts = {
  dir: string;
  handoffId: string;
  message: string;
  memoryContext: string;
  bundle: Buffer;
};

export function sendViaFile(opts: FileOpts): { path: string } {
  const handoffDir = join(opts.dir, opts.handoffId);
  mkdirSync(handoffDir, { recursive: true });

  // Human + agent readable markdown
  writeFileSync(
    join(handoffDir, "HANDOFF.md"),
    [
      `# Handoff: ${opts.handoffId}`,
      "",
      opts.message,
      "",
      "---",
      "",
      "## Memory Context",
      "",
      opts.memoryContext,
    ].join("\n"),
    "utf-8"
  );

  // Git bundle for versioned import
  writeFileSync(join(handoffDir, "memory.bundle"), opts.bundle);

  return { path: handoffDir };
}
