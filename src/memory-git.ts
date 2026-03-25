import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFile = promisify(execFileCb);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, "rev-parse", "--git-dir");
    return true;
  } catch {
    return false;
  }
}

async function hasCommits(dir: string): Promise<boolean> {
  try {
    await git(dir, "rev-parse", "HEAD");
    return true;
  } catch {
    return false;
  }
}

export async function snapshot(
  stagingDir: string,
  peerId?: string
): Promise<Buffer> {
  mkdirSync(stagingDir, { recursive: true });

  if (!(await isGitRepo(stagingDir))) {
    await git(stagingDir, "init");
  }

  // Stage everything
  await git(stagingDir, "add", "-A");

  // Check if there are changes to commit
  try {
    await git(stagingDir, "diff", "--cached", "--quiet");
    // No changes — check if we have any commits at all
    if (!(await hasCommits(stagingDir))) {
      throw new Error("No memory files found in staging directory");
    }
  } catch (e) {
    // There are staged changes (diff --cached --quiet exits non-zero) or no commits yet
    if (e instanceof Error && e.message.includes("No memory files")) throw e;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    await git(stagingDir, "commit", "-m", `ahp snapshot ${timestamp}`);
  }

  // Create bundle
  const bundlePath = join(tmpdir(), `ahp-${crypto.randomUUID()}.bundle`);
  const syncTag = peerId ? `ahp-sync/${peerId.replace(/[^a-zA-Z0-9_-]/g, "_")}` : null;

  if (syncTag) {
    // Check if sync tag exists for delta bundle
    try {
      await git(stagingDir, "rev-parse", syncTag);
      // Tag exists — delta bundle
      await git(stagingDir, "bundle", "create", bundlePath, `${syncTag}..HEAD`);
    } catch {
      // No sync tag — full bundle
      await git(stagingDir, "bundle", "create", bundlePath, "HEAD");
    }
  } else {
    await git(stagingDir, "bundle", "create", bundlePath, "HEAD");
  }

  const bundle = readFileSync(bundlePath);

  // Update sync tag
  if (syncTag) {
    try {
      await git(stagingDir, "tag", "-f", syncTag, "HEAD");
    } catch {
      // Tag creation failed — non-fatal
    }
  }

  return bundle;
}

export async function apply(
  targetDir: string,
  bundleData: Buffer
): Promise<{ filesImported: number }> {
  mkdirSync(targetDir, { recursive: true });

  // Write bundle to temp file
  const bundlePath = join(tmpdir(), `ahp-recv-${crypto.randomUUID()}.bundle`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(bundlePath, bundleData);

  if (!(await isGitRepo(targetDir))) {
    await git(targetDir, "init");
  }

  // Verify bundle
  await git(targetDir, "bundle", "verify", bundlePath);

  if (await hasCommits(targetDir)) {
    // Fetch and merge
    await git(targetDir, "fetch", bundlePath, "HEAD");
    try {
      await git(targetDir, "merge", "FETCH_HEAD", "--no-edit", "--allow-unrelated-histories");
    } catch (e) {
      // Merge conflict — leave it for manual resolution
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("CONFLICT")) {
        console.error("Merge conflict detected. Resolve manually in:", targetDir);
      }
      throw e;
    }
  } else {
    // No commits yet — pull directly
    await git(targetDir, "pull", bundlePath, "HEAD");
  }

  // Count files
  const { readdirSync, statSync } = await import("node:fs");
  let count = 0;
  const dirs = readdirSync(targetDir).filter(
    (f) => f !== ".git" && statSync(join(targetDir, f)).isDirectory()
  );
  for (const d of dirs) {
    count += readdirSync(join(targetDir, d)).filter((f) => f.endsWith(".md")).length;
  }

  return { filesImported: count };
}
