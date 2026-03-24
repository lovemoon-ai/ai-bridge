import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { fileExists } from "../../utils/fs.js";

export const OPENCODE_BASE = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "opencode",
);

export const OPENCODE_DB = join(OPENCODE_BASE, "opencode.db");
export const OPENCODE_STORAGE = join(OPENCODE_BASE, "storage");
export const OPENCODE_PROJECTS = join(OPENCODE_STORAGE, "project");
export const OPENCODE_SESSIONS = join(OPENCODE_STORAGE, "session");
export const OPENCODE_MESSAGES = join(OPENCODE_STORAGE, "message");
export const OPENCODE_PARTS = join(OPENCODE_STORAGE, "part");
export const OPENCODE_SESSION_DIFF = join(OPENCODE_STORAGE, "session_diff");

export type OpenCodeStorageMode = "json" | "db";

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

export async function detectInstalledOpenCodeVersion(): Promise<string | null> {
  const override = process.env.AIBRIDGE_OPENCODE_VERSION?.trim();
  if (override) return override;

  const output = await execFileText("opencode", ["--version"]);
  if (!output) return null;

  const match = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match?.[0] ?? null;
}

export async function resolveOpenCodeStorageMode(): Promise<OpenCodeStorageMode> {
  const override = process.env.AIBRIDGE_OPENCODE_STORAGE_MODE?.trim().toLowerCase();
  if (override === "json" || override === "db") return override;

  const version = await detectInstalledOpenCodeVersion();
  if (version) {
    return compareVersions(version, "1.2.0") >= 0 ? "db" : "json";
  }

  const hasDb = await fileExists(OPENCODE_DB);
  const sessionFiles = await listSessionFiles();
  if (hasDb && sessionFiles.length === 0) return "db";
  if (!hasDb && sessionFiles.length > 0) return "json";
  if (hasDb) return "db";
  return "json";
}

function execFileText(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf-8" }, (error, stdout, stderr) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve((stdout || stderr || "").trim() || null);
    });
  });
}

function compareVersions(a: string, b: string): number {
  const pa = normalizeVersionParts(a);
  const pb = normalizeVersionParts(b);
  const maxLen = Math.max(pa.length, pb.length);
  for (let i = 0; i < maxLen; i += 1) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function normalizeVersionParts(version: string): number[] {
  const main = version.trim().replace(/^v/i, "").split(/[+-]/, 1)[0] ?? "";
  return main.split(".").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}
