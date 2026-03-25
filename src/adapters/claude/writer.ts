import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  IREntry,
  IRSessionMeta,
  IRUserMessage,
  IRAssistantMessage,
  IRToolCall,
  IRToolResult,
} from "../../types.js";
import {
  ensureDir,
  writeJsonl,
  readJson,
  writeJson,
  fileExists,
} from "../../utils/fs.js";
import { uuid, isoNow, encodeClaudePath } from "../../utils/id.js";
import {
  CLAUDE_BASE,
  CLAUDE_TASKS_BASE,
  CLAUDE_SESSION_ENV_BASE,
} from "./utils.js";

// ── Claude-native output types ───────────────────────────────

interface ClaudeOutEntry {
  type: "user" | "assistant";
  uuid: string;
  parentUuid: string;
  sessionId: string;
  message: {
    role: "user" | "assistant";
    content: string | ClaudeOutBlock[];
    model?: string;
    stop_reason?: string;
  };
  timestamp: string;
  cwd?: string;
  version?: string;
}

type ClaudeOutBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface ClaudeIndexFile {
  version: number;
  entries: ClaudeIndexEntry[];
  originalPath?: string;
}

interface ClaudeIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime?: number;
  firstPrompt?: string;
  summary?: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain: boolean;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Write IR entries as a new Claude session.
 *
 * Creates a JSONL file under ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * and updates (or creates) the sessions-index.json for that project directory.
 *
 * @returns The new session ID.
 */
export async function writeClaudeSession(
  entries: IREntry[],
  targetCwd: string,
): Promise<string> {
  const sessionId = uuid();
  const encodedPath = encodeClaudePath(targetCwd);
  const projectDir = join(CLAUDE_BASE, encodedPath);
  const sessionPath = join(projectDir, `${sessionId}.jsonl`);
  const now = isoNow();

  // Extract metadata from IRSessionMeta if present
  const meta = entries.find((e) => e.type === "session_meta") as
    | IRSessionMeta
    | undefined;
  const gitBranch = meta?.git_branch;

  // Build Claude JSONL lines
  const lines = buildClaudeLines(entries, sessionId, targetCwd, gitBranch);

  // Write the session JSONL
  await writeJsonl(sessionPath, lines);
  await initializeClaudeResumeState(sessionId);

  // Update sessions-index.json
  const firstPrompt = extractFirstPrompt(entries);
  await updateSessionsIndex(projectDir, {
    sessionId,
    fullPath: sessionPath,
    firstPrompt,
    messageCount: lines.length,
    created: meta?.created_at || now,
    modified: now,
    gitBranch: gitBranch || "",
    projectPath: targetCwd,
    isSidechain: false,
  });

  return sessionId;
}

// ── Builders ─────────────────────────────────────────────────

/**
 * Convert IR entries into Claude-native JSONL entries.
 * Maintains a parentUuid chain so Claude can reconstruct the conversation tree.
 */
function buildClaudeLines(
  entries: IREntry[],
  sessionId: string,
  cwd: string,
  gitBranch?: string,
): ClaudeOutEntry[] {
  const lines: ClaudeOutEntry[] = [];
  let parentUuid = "root";

  // We may need to batch consecutive tool_calls into a single assistant entry
  // and consecutive tool_results into a single user entry.
  let pendingToolUseBlocks: ClaudeOutBlock[] = [];
  let pendingToolUseTimestamp: string | undefined;
  let pendingToolUseModel: string | undefined;

  let pendingToolResultBlocks: ClaudeOutBlock[] = [];
  let pendingToolResultTimestamp: string | undefined;

  function flushToolUse(): void {
    if (pendingToolUseBlocks.length === 0) return;
    const entryUuid = uuid();
    lines.push({
      type: "assistant",
      uuid: entryUuid,
      parentUuid,
      sessionId,
      message: {
        role: "assistant",
        content: pendingToolUseBlocks,
        model: pendingToolUseModel,
        stop_reason: "tool_use",
      },
      timestamp: pendingToolUseTimestamp || isoNow(),
    });
    parentUuid = entryUuid;
    pendingToolUseBlocks = [];
    pendingToolUseTimestamp = undefined;
    pendingToolUseModel = undefined;
  }

  function flushToolResults(): void {
    if (pendingToolResultBlocks.length === 0) return;
    const entryUuid = uuid();
    lines.push({
      type: "user",
      uuid: entryUuid,
      parentUuid,
      sessionId,
      message: {
        role: "user",
        content: pendingToolResultBlocks,
      },
      timestamp: pendingToolResultTimestamp || isoNow(),
    });
    parentUuid = entryUuid;
    pendingToolResultBlocks = [];
    pendingToolResultTimestamp = undefined;
  }

  for (const entry of entries) {
    switch (entry.type) {
      case "session_meta":
        // Metadata is used for index, not emitted as a line
        break;

      case "user_message": {
        // Flush any pending tool-related blocks first
        flushToolUse();
        flushToolResults();

        const entryUuid = uuid();
        lines.push({
          type: "user",
          uuid: entryUuid,
          parentUuid,
          sessionId,
          message: {
            role: "user",
            content: entry.content,
          },
          timestamp: entry.timestamp,
          cwd,
          version: "1",
        });
        parentUuid = entryUuid;
        break;
      }

      case "assistant_message": {
        // Flush any pending tool results first
        flushToolResults();

        // If there are pending tool_use blocks, the assistant text goes with them
        const blocks: ClaudeOutBlock[] = [];

        if (entry.thinking) {
          blocks.push({ type: "thinking", thinking: entry.thinking });
        }
        if (entry.content) {
          blocks.push({ type: "text", text: entry.content });
        }

        if (pendingToolUseBlocks.length > 0) {
          // Prepend text/thinking blocks before tool_use blocks
          pendingToolUseBlocks = [...blocks, ...pendingToolUseBlocks];
          pendingToolUseModel = pendingToolUseModel || entry.model;
        } else {
          // Standalone assistant message
          flushToolUse();
          const entryUuid = uuid();
          lines.push({
            type: "assistant",
            uuid: entryUuid,
            parentUuid,
            sessionId,
            message: {
              role: "assistant",
              content: blocks.length > 0 ? blocks : entry.content,
              model: entry.model,
              stop_reason: "end_turn",
            },
            timestamp: entry.timestamp,
          });
          parentUuid = entryUuid;
        }
        break;
      }

      case "tool_call": {
        // Flush tool results first - a new tool call means new assistant turn
        flushToolResults();

        let parsedInput: Record<string, unknown>;
        try {
          parsedInput = JSON.parse(entry.arguments) as Record<string, unknown>;
        } catch {
          parsedInput = { raw: entry.arguments };
        }

        pendingToolUseBlocks.push({
          type: "tool_use",
          id: entry.tool_call_id,
          name: entry.tool_name,
          input: parsedInput,
        });
        if (!pendingToolUseTimestamp) {
          pendingToolUseTimestamp = entry.timestamp;
        }
        break;
      }

      case "tool_result": {
        // Flush tool_use blocks first - results come after tool calls
        flushToolUse();

        pendingToolResultBlocks.push({
          type: "tool_result",
          tool_use_id: entry.tool_call_id,
          content: entry.output,
        });
        if (!pendingToolResultTimestamp) {
          pendingToolResultTimestamp = entry.timestamp;
        }
        break;
      }
    }
  }

  // Flush any remaining pending blocks
  flushToolUse();
  flushToolResults();

  return lines;
}

/**
 * Extract the first user prompt from IR entries (used for index metadata).
 */
function extractFirstPrompt(entries: IREntry[]): string {
  for (const entry of entries) {
    if (entry.type === "user_message") {
      return entry.content.slice(0, 200);
    }
  }
  return "";
}

/**
 * Update or create the sessions-index.json for a project directory.
 */
async function updateSessionsIndex(
  projectDir: string,
  newEntry: ClaudeIndexEntry,
): Promise<void> {
  const indexPath = join(projectDir, "sessions-index.json");

  let index: ClaudeIndexFile;
  if (await fileExists(indexPath)) {
    index = await readJson<ClaudeIndexFile>(indexPath);
  } else {
    index = {
      version: 1,
      entries: [],
      originalPath: newEntry.projectPath,
    };
  }

  // Remove any existing entry with the same sessionId (shouldn't happen, but be safe)
  index.entries = index.entries.filter(
    (e) => e.sessionId !== newEntry.sessionId,
  );

  index.entries.push(newEntry);

  await writeJson(indexPath, index);
}

/**
 * Claude CLI refuses `--resume <sessionId>` for synthetic sessions unless the
 * per-session task state directory already exists under ~/.claude/tasks.
 * Real Claude sessions also have an empty session-env directory, so we create
 * both here to match the expected on-disk shape.
 */
async function initializeClaudeResumeState(sessionId: string): Promise<void> {
  const taskDir = join(CLAUDE_TASKS_BASE, sessionId);
  await ensureDir(taskDir);
  await writeFile(join(taskDir, ".lock"), "", "utf-8");
  await writeFile(join(taskDir, ".highwatermark"), "0", "utf-8");

  await ensureDir(join(CLAUDE_SESSION_ENV_BASE, sessionId));
}
