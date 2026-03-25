import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type MemoryEntry = {
  id: string;
  content: string;
  category: string;
  namespace: string;
  scope?: string;
  created_at: string;
  updated_at?: string;
};

export type ExportOpts = {
  serverUrl?: string;
  namespace: string;
  scopes?: string[];
  categories?: string[];
  query?: string;
  limit?: number;
};

const DEFAULT_SERVER = "http://localhost:8000";

export async function exportMemories(opts: ExportOpts): Promise<MemoryEntry[]> {
  const serverUrl = opts.serverUrl ?? DEFAULT_SERVER;
  const limit = opts.limit ?? 100;

  const body: Record<string, unknown> = {
    namespace: { eq: opts.namespace },
    limit,
  };

  if (opts.query) {
    body.text = opts.query;
  }

  if (opts.scopes?.length) {
    body.topics = { any: opts.scopes };
  }

  const res = await fetch(`${serverUrl}/v1/long-term-memory/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Redis memory server returned ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { memories?: Array<Record<string, unknown>> };
  const memories = data.memories ?? [];

  let entries: MemoryEntry[] = memories.map((m) => {
    const topics = (m.topics as string[]) ?? [];
    // First topic that's a known category becomes the category, rest are scopes
    const knownCategories = ["preference", "fact", "decision", "entity", "procedure", "context", "other"];
    const category = topics.find((t) => knownCategories.includes(t)) ?? "other";
    const scope = topics.find((t) => !knownCategories.includes(t));

    return {
      id: (m.id as string) ?? crypto.randomUUID(),
      content: (m.text as string) ?? (m.content as string) ?? "",
      category,
      namespace: (m.namespace as string) ?? opts.namespace,
      scope,
      created_at: (m.created_at as string) ?? new Date().toISOString(),
      updated_at: (m.updated_at as string) ?? undefined,
    };
  });

  if (opts.categories?.length) {
    entries = entries.filter((e) => opts.categories!.includes(e.category));
  }

  return entries;
}

export function writeToStaging(entries: MemoryEntry[], stagingDir: string): void {
  mkdirSync(stagingDir, { recursive: true });

  for (const entry of entries) {
    const categoryDir = join(stagingDir, entry.category);
    mkdirSync(categoryDir, { recursive: true });

    const frontmatter = [
      "---",
      `id: ${entry.id}`,
      `category: ${entry.category}`,
      `namespace: ${entry.namespace}`,
      entry.scope ? `scope: ${entry.scope}` : null,
      `created_at: ${entry.created_at}`,
      entry.updated_at ? `updated_at: ${entry.updated_at}` : null,
      "---",
    ]
      .filter(Boolean)
      .join("\n");

    const content = `${frontmatter}\n\n${entry.content}\n`;
    const filename = `${entry.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`;
    writeFileSync(join(categoryDir, filename), content, "utf-8");
  }
}

export function readFromStaging(stagingDir: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];

  let categories: string[];
  try {
    categories = readdirSync(stagingDir).filter((f) =>
      statSync(join(stagingDir, f)).isDirectory()
    );
  } catch {
    return entries;
  }

  for (const category of categories) {
    if (category === ".git") continue;
    const categoryDir = join(stagingDir, category);
    const files = readdirSync(categoryDir).filter((f) => f.endsWith(".md"));

    for (const file of files) {
      const raw = readFileSync(join(categoryDir, file), "utf-8");
      const entry = parseFrontmatter(raw, category);
      if (entry) entries.push(entry);
    }
  }

  return entries;
}

function parseFrontmatter(raw: string, fallbackCategory: string): MemoryEntry | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!match) return null;

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(": ");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 2).trim();
    }
  }

  return {
    id: meta.id ?? crypto.randomUUID(),
    content: match[2].trim(),
    category: meta.category ?? fallbackCategory,
    namespace: meta.namespace ?? "default",
    scope: meta.scope,
    created_at: meta.created_at ?? new Date().toISOString(),
    updated_at: meta.updated_at,
  };
}

export async function importToRedis(
  entries: MemoryEntry[],
  serverUrl?: string,
  namespace?: string
): Promise<number> {
  const url = serverUrl ?? DEFAULT_SERVER;

  const memories = entries.map((entry) => ({
    id: entry.id,
    namespace: namespace ?? entry.namespace,
    text: entry.content,
    memory_type: "semantic",
    topics: [entry.category, entry.scope].filter(Boolean),
  }));

  const res = await fetch(`${url}/v1/long-term-memory/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memories }),
  });

  if (!res.ok) {
    throw new Error(`Redis import failed ${res.status}: ${await res.text()}`);
  }

  return memories.length;
}
