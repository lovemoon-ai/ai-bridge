import { join, basename } from "node:path";
import type {
  ToolAdapter,
  ToolName,
  SessionInfo,
  IREntry,
  IRUserMessage,
  IRAssistantMessage,
  IRToolCall,
  IRToolResult,
} from "../../types.js";
import { readJsonl, readJson } from "../../utils/fs.js";
import { isIdPrefix } from "../../utils/id.js";
import { findSessionIndexes, findSessionFiles } from "./utils.js";
import { writeClaudeSession } from "./writer.js";

// ── Claude-native types (partial, only what we need) ─────────

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
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

interface ClaudeTextBlock {
  type: "text";
  text: string;
}

interface ClaudeThinkingBlock {
  type: "thinking";
  thinking: string;
}

interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<{ type: string; text?: string }>;
}

type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeThinkingBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock;

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
  model?: string;
  stop_reason?: string;
}

interface ClaudeEntry {
  type: string;
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  message?: ClaudeMessage;
  timestamp?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
}

// ── Adapter ──────────────────────────────────────────────────

export class ClaudeAdapter implements ToolAdapter {
  readonly name: ToolName = "claude";

  async listSessions(): Promise<SessionInfo[]> {
    const indexes = await findSessionIndexes();
    const sessions: SessionInfo[] = [];
    const seenSessionIds = new Set<string>();

    for (const { indexPath, projectDir } of indexes) {
      try {
        const index = await readJson<ClaudeIndexFile>(indexPath);
        for (const entry of index.entries) {
          const session = indexEntryToSessionInfo(entry, projectDir);
          sessions.push(session);
          seenSessionIds.add(session.sessionId);
        }
      } catch {
        // skip unreadable index files
      }
    }

    const files = await findSessionFiles();
    for (const { sessionPath } of files) {
      try {
        const session = await sessionInfoFromFile(sessionPath);
        if (!session || seenSessionIds.has(session.sessionId)) continue;
        sessions.push(session);
        seenSessionIds.add(session.sessionId);
      } catch {
        // skip unreadable session files
      }
    }

    return sessions;
  }

  async findSession(sessionId: string): Promise<SessionInfo | null> {
    const indexes = await findSessionIndexes();

    for (const { indexPath, projectDir } of indexes) {
      try {
        const index = await readJson<ClaudeIndexFile>(indexPath);
        for (const entry of index.entries) {
          if (
            entry.sessionId === sessionId ||
            isIdPrefix(sessionId, entry.sessionId)
          ) {
            return indexEntryToSessionInfo(entry, projectDir);
          }
        }
      } catch {
        // skip
      }
    }

    const files = await findSessionFiles();
    for (const { sessionPath } of files) {
      const fileSessionId = basename(sessionPath, ".jsonl");
      if (!isIdPrefix(sessionId, fileSessionId)) continue;

      try {
        const session = await sessionInfoFromFile(sessionPath);
        if (session) return session;
      } catch {
        // skip unreadable session files
      }
    }

    return null;
  }

  async read(session: SessionInfo): Promise<IREntry[]> {
    const raw = await readJsonl<ClaudeEntry>(session.path);
    return convertClaudeEntries(raw);
  }

  async write(entries: IREntry[], targetCwd: string): Promise<string> {
    return writeClaudeSession(entries, targetCwd);
  }

  getResumeCommand(sessionId: string, _targetCwd?: string): { command: string; args: string[] } {
    return { command: "claude", args: ["--resume", sessionId] };
  }
}

// ── Helpers ──────────────────────────────────────────────────

function indexEntryToSessionInfo(
  entry: ClaudeIndexEntry,
  projectDir: string,
): SessionInfo {
  const path =
    entry.fullPath || join(projectDir, `${entry.sessionId}.jsonl`);
  return {
    tool: "claude",
    sessionId: entry.sessionId,
    title: entry.summary || entry.firstPrompt,
    cwd: entry.projectPath,
    createdAt: entry.created,
    path,
  };
}

async function sessionInfoFromFile(path: string): Promise<SessionInfo | null> {
  const raw = await readJsonl<ClaudeEntry>(path);
  if (raw.length === 0) return null;

  const first = raw[0];
  const firstMessageEntry = raw.find((entry) => entry.message);
  const sessionId = first.sessionId || basename(path, ".jsonl");
  const title = deriveTitle(raw);
  const cwd = firstMessageEntry?.cwd || first.cwd;
  const createdAt = first.timestamp;
  const model = raw.find((entry) => entry.message?.model)?.message?.model;

  return {
    tool: "claude",
    sessionId,
    title,
    cwd,
    model,
    createdAt,
    path,
  };
}

function deriveTitle(raw: ClaudeEntry[]): string | undefined {
  for (const entry of raw) {
    const content = entry.message?.content;
    if (typeof content === "string" && content.trim()) {
      return content.trim().split("\n")[0];
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          return block.text.trim().split("\n")[0];
        }
      }
    }
  }
  return undefined;
}

/**
 * Convert an array of raw Claude JSONL entries into IR entries.
 */
function convertClaudeEntries(raw: ClaudeEntry[]): IREntry[] {
  const results: IREntry[] = [];

  for (const entry of raw) {
    // Skip non-message types
    if (
      entry.type !== "user" &&
      entry.type !== "assistant"
    ) {
      continue;
    }

    const ts = entry.timestamp || new Date().toISOString();
    const msg = entry.message;
    if (!msg) continue;

    if (entry.type === "user") {
      processUserEntry(msg, ts, results);
    } else if (entry.type === "assistant") {
      processAssistantEntry(msg, ts, results);
    }
  }

  return results;
}

/**
 * Process a Claude "user" entry.
 *
 * Content can be:
 * - A plain string → IRUserMessage
 * - An array of content blocks:
 *   - "text" blocks → IRUserMessage
 *   - "tool_result" blocks → IRToolResult
 */
function processUserEntry(
  msg: ClaudeMessage,
  timestamp: string,
  out: IREntry[],
): void {
  if (typeof msg.content === "string") {
    out.push({
      type: "user_message",
      timestamp,
      content: msg.content,
    } satisfies IRUserMessage);
    return;
  }

  // Array of content blocks
  const textParts: string[] = [];

  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        textParts.push((block as ClaudeTextBlock).text);
        break;

      case "tool_result": {
        const tr = block as ClaudeToolResultBlock;
        const output = extractToolResultContent(tr);
        out.push({
          type: "tool_result",
          timestamp,
          tool_call_id: tr.tool_use_id,
          output,
        } satisfies IRToolResult);
        break;
      }
      // Other block types in user messages are ignored
    }
  }

  if (textParts.length > 0) {
    out.push({
      type: "user_message",
      timestamp,
      content: textParts.join("\n"),
    } satisfies IRUserMessage);
  }
}

/**
 * Process a Claude "assistant" entry.
 *
 * Content is always an array of blocks:
 * - "text" blocks → collected into IRAssistantMessage.content
 * - "thinking" blocks → set IRAssistantMessage.thinking
 * - "tool_use" blocks → IRToolCall each
 */
function processAssistantEntry(
  msg: ClaudeMessage,
  timestamp: string,
  out: IREntry[],
): void {
  if (typeof msg.content === "string") {
    out.push({
      type: "assistant_message",
      timestamp,
      content: msg.content,
      model: msg.model,
    } satisfies IRAssistantMessage);
    return;
  }

  const textParts: string[] = [];
  let thinking: string | undefined;

  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        textParts.push((block as ClaudeTextBlock).text);
        break;

      case "thinking":
        // Concatenate multiple thinking blocks if present
        if (thinking) {
          thinking += "\n" + (block as ClaudeThinkingBlock).thinking;
        } else {
          thinking = (block as ClaudeThinkingBlock).thinking;
        }
        break;

      case "tool_use": {
        const tu = block as ClaudeToolUseBlock;
        out.push({
          type: "tool_call",
          timestamp,
          tool_call_id: tu.id,
          tool_name: tu.name,
          arguments: JSON.stringify(tu.input),
        } satisfies IRToolCall);
        break;
      }
    }
  }

  // Emit an assistant message if there was any text or thinking content
  if (textParts.length > 0 || thinking) {
    out.push({
      type: "assistant_message",
      timestamp,
      content: textParts.join("\n"),
      thinking,
      model: msg.model,
    } satisfies IRAssistantMessage);
  }
}

/**
 * Extract text from a tool_result block's content field.
 * Content can be a string, an array of text blocks, or undefined.
 */
function extractToolResultContent(block: ClaudeToolResultBlock): string {
  if (!block.content) return "";
  if (typeof block.content === "string") return block.content;

  return block.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}
