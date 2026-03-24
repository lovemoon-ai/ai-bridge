import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

export const OPENCODE_BASE = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "opencode",
);

export const OPENCODE_STORAGE = join(OPENCODE_BASE, "storage");
export const OPENCODE_PROJECTS = join(OPENCODE_STORAGE, "project");
export const OPENCODE_SESSIONS = join(OPENCODE_STORAGE, "session");
export const OPENCODE_MESSAGES = join(OPENCODE_STORAGE, "message");
export const OPENCODE_PARTS = join(OPENCODE_STORAGE, "part");
export const OPENCODE_SESSION_DIFF = join(OPENCODE_STORAGE, "session_diff");

export interface OpenCodeProjectRecord {
  id: string;
  worktree: string;
  vcs?: "git";
  sandboxes: string[];
  time: {
    created: number;
    updated: number;
    initialized?: number;
  };
}

export function opencodeProjectIdForCwd(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex");
}

export function opencodeId(prefix: "ses" | "msg" | "prt"): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function opencodeSlug(sessionId: string): string {
  return `bridged-${sessionId.slice(-8).toLowerCase()}`;
}

export function isoToUnixMs(iso: string | undefined, fallback = Date.now()): number {
  if (!iso) return fallback;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function unixMsToIso(value: number | undefined, fallback = new Date().toISOString()): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return new Date(value).toISOString();
}

export async function listProjectFiles(): Promise<string[]> {
  try {
    const entries = await readdir(OPENCODE_PROJECTS, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(OPENCODE_PROJECTS, entry.name))
      .sort();
  } catch {
    return [];
  }
}

export async function listSessionFiles(): Promise<string[]> {
  const results: string[] = [];
  let projectDirs: Array<{ name: string; isDirectory(): boolean }>;
  try {
    projectDirs = (await readdir(OPENCODE_SESSIONS, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
    }>;
  } catch {
    return results;
  }

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const fullDir = join(OPENCODE_SESSIONS, dir.name);
    try {
      const files = await readdir(fullDir, { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && file.name.endsWith(".json")) {
          results.push(join(fullDir, file.name));
        }
      }
    } catch {
      // ignore corrupt directories
    }
  }

  return results.sort((a, b) => b.localeCompare(a));
}
