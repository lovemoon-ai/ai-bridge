import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { fileExists } from "../../utils/fs.js";

/** Root directory where Claude stores per-project data. */
export const CLAUDE_BASE = join(homedir(), ".claude", "projects");
/** Claude per-session task state root. */
export const CLAUDE_TASKS_BASE = join(homedir(), ".claude", "tasks");
/** Claude per-session environment root. */
export const CLAUDE_SESSION_ENV_BASE = join(homedir(), ".claude", "session-env");

/**
 * List all encoded-path directories under ~/.claude/projects/.
 * Returns absolute paths to each project directory.
 */
export async function listProjectDirs(): Promise<string[]> {
  try {
    const entries = await readdir(CLAUDE_BASE, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => join(CLAUDE_BASE, e.name));
  } catch {
    return [];
  }
}

/**
 * Find all sessions-index.json files across every project directory.
 * Returns an array of { indexPath, projectDir } objects.
 */
export async function findSessionIndexes(): Promise<
  { indexPath: string; projectDir: string }[]
> {
  const dirs = await listProjectDirs();
  const results: { indexPath: string; projectDir: string }[] = [];

  for (const dir of dirs) {
    const indexPath = join(dir, "sessions-index.json");
    if (await fileExists(indexPath)) {
      results.push({ indexPath, projectDir: dir });
    }
  }

  return results;
}

/**
 * Find all top-level Claude session JSONL files across project directories.
 * This is a compatibility fallback for installations that no longer maintain
 * sessions-index.json consistently.
 */
export async function findSessionFiles(): Promise<
  { sessionPath: string; projectDir: string }[]
> {
  const dirs = await listProjectDirs();
  const results: { sessionPath: string; projectDir: string }[] = [];

  for (const dir of dirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(".jsonl")) continue;
        results.push({ sessionPath: join(dir, entry.name), projectDir: dir });
      }
    } catch {
      // skip unreadable project directories
    }
  }

  return results;
}
