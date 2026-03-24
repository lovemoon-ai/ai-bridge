import { join } from "node:path";
import type {
  IREntry,
  IRSessionMeta,
  IRUserMessage,
  IRAssistantMessage,
  IRToolCall,
  IRToolResult,
} from "../../types.js";
import { writeJsonl } from "../../utils/fs.js";
import { uuid, isoNow } from "../../utils/id.js";
import { CODEX_BASE } from "./utils.js";

// ── Raw Codex JSONL line shape ─────────────────────────────────

interface CodexLine {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

const BRIDGE_ORIGINATOR = "ai-bridge";
const BRIDGE_CLI_VERSION = "0.0.0";

// ── Writer ─────────────────────────────────────────────────────

/**
 * Convert IR entries into the Codex JSONL format and write them to a new
 * rollout file under ~/.codex/sessions/YYYY/MM/DD/.
 *
 * Returns the session ID for the newly written session.
 */
export async function writeCodexSession(
  entries: IREntry[],
  targetCwd: string,
): Promise<string> {
  const sessionId = uuid();
  const now = new Date();

  // Build path: YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const filename = `rollout-${yyyy}-${mm}-${dd}T${hh}-${mi}-${ss}-${sessionId}.jsonl`;
  const outPath = join(CODEX_BASE, yyyy, mm, dd, filename);

  const lines: CodexLine[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case "session_meta":
        lines.push(convertSessionMeta(entry, sessionId, targetCwd));
        break;

      case "user_message":
        lines.push(...convertUserMessage(entry));
        break;

      case "assistant_message":
        lines.push(...convertAssistantMessage(entry));
        break;

      case "tool_call":
        lines.push(convertToolCall(entry));
        break;

      case "tool_result":
        lines.push(convertToolResult(entry));
        break;

      default:
        break;
    }
  }

  // If no session_meta was present in the IR entries, synthesize one.
  if (!entries.some((e) => e.type === "session_meta")) {
    const syntheticMeta: CodexLine = {
      timestamp: isoNow(),
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: isoNow(),
        cwd: targetCwd,
        originator: BRIDGE_ORIGINATOR,
        cli_version: BRIDGE_CLI_VERSION,
        source: "cli",
      },
    };
    lines.unshift(syntheticMeta);
  }

  await writeJsonl(outPath, lines);
  return sessionId;
}

// ── Converters ─────────────────────────────────────────────────

function convertSessionMeta(
  entry: IRSessionMeta,
  sessionId: string,
  targetCwd: string,
): CodexLine {
  const payload: Record<string, unknown> = {
    id: sessionId,
    timestamp: entry.created_at,
    cwd: targetCwd || entry.cwd,
    originator: BRIDGE_ORIGINATOR,
    cli_version: BRIDGE_CLI_VERSION,
    source: "cli",
  };

  if (entry.git_branch) {
    payload.git = { branch: entry.git_branch };
  }
  if (entry.title) {
    payload.title = entry.title;
  }
  if (entry.model) {
    payload.model = entry.model;
  }

  return {
    timestamp: entry.created_at,
    type: "session_meta",
    payload,
  };
}

function convertUserMessage(entry: IRUserMessage): CodexLine[] {
  const lines: CodexLine[] = [];

  // Emit event_msg for user_message.
  lines.push({
    timestamp: entry.timestamp,
    type: "event_msg",
    payload: {
      type: "user_message",
      message: entry.content,
      kind: "plain",
    },
  });

  // Also emit a response_item message with role "user".
  lines.push({
    timestamp: entry.timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: entry.content }],
    },
  });

  return lines;
}

function convertAssistantMessage(entry: IRAssistantMessage): CodexLine[] {
  const lines: CodexLine[] = [];

  // Emit the assistant message.
  lines.push({
    timestamp: entry.timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: entry.content }],
    },
  });

  // Emit reasoning after the assistant message so the reader can
  // attach it to the preceding assistant turn.
  if (entry.thinking) {
    lines.push({
      timestamp: entry.timestamp,
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [{ text: entry.thinking }],
        content: null,
        encrypted_content: "",
      },
    });
  }

  return lines;
}

function convertToolCall(entry: IRToolCall): CodexLine {
  return {
    timestamp: entry.timestamp,
    type: "response_item",
    payload: {
      type: "function_call",
      name: entry.tool_name,
      arguments: entry.arguments,
      call_id: entry.tool_call_id,
    },
  };
}

function convertToolResult(entry: IRToolResult): CodexLine {
  return {
    timestamp: entry.timestamp,
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: entry.tool_call_id,
      output: entry.output,
    },
  };
}
