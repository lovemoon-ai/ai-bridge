import { join } from "node:path";
import { stat } from "node:fs/promises";
import type {
  ToolAdapter,
  SessionInfo,
  IREntry,
  IRUserMessage,
  IRAssistantMessage,
  IRToolCall,
  IRToolResult,
  IRSessionMeta,
} from "../../types.js";
import { readJsonl, fileExists } from "../../utils/fs.js";
import { isoNow, isIdPrefix } from "../../utils/id.js";
import { KIMI_BASE, listSessionPaths } from "./utils.js";

// ── Kimi raw record shapes ────────────────────────────────────

interface KimiContentBlock {
  type: string;
  text?: string;
  think?: string;
  encrypted?: unknown;
}

interface KimiToolCallFunction {
  name: string;
  arguments: string;
}

interface KimiToolCall {
  type: "function";
  id: string;
  function: KimiToolCallFunction;
}

interface KimiRecord {
  role: string;
  id?: number;
  token_count?: number;
  content?: string | KimiContentBlock[];
  tool_calls?: KimiToolCall[];
  tool_call_id?: string;
}

// ── Adapter ────────────────────────────────────────────────────

export class KimiAdapter implements ToolAdapter {
  readonly name = "kimi" as const;

  async listSessions(): Promise<SessionInfo[]> {
    const paths = await listSessionPaths();
    const sessions: SessionInfo[] = [];

    for (const p of paths) {
      if (!(await fileExists(p.contextPath))) continue;

      const title = await this.extractTitle(p.contextPath);
      const createdAt = await this.getCreatedAt(p.contextPath);

      sessions.push({
        tool: "kimi",
        sessionId: p.uuid,
        title,
        path: p.contextPath,
        createdAt,
      });
    }

    return sessions;
  }

  async findSession(sessionId: string): Promise<SessionInfo | null> {
    const paths = await listSessionPaths();
    // Try matching on UUID or hash
    const match = paths.find(
      (p) => isIdPrefix(sessionId, p.uuid) || isIdPrefix(sessionId, p.hash),
    );
    if (!match) return null;
    if (!(await fileExists(match.contextPath))) return null;

    const title = await this.extractTitle(match.contextPath);
    const createdAt = await this.getCreatedAt(match.contextPath);

    return {
      tool: "kimi",
      sessionId: match.uuid,
      title,
      path: match.contextPath,
      createdAt,
    };
  }

  async read(session: SessionInfo): Promise<IREntry[]> {
    const records = await readJsonl<KimiRecord>(session.path);

    // Attempt to load wire.jsonl for timestamps
    const wireDir = join(session.path, "..");
    const wirePath = join(wireDir, "wire.jsonl");
    let wireTimestamps: string[] = [];
    if (await fileExists(wirePath)) {
      try {
        const wireRecords = await readJsonl<{ timestamp?: number; message?: { type?: string } }>(wirePath);
        wireTimestamps = wireRecords
          .filter((r) => r.timestamp)
          .map((r) => new Date(r.timestamp! * 1000).toISOString());
      } catch {
        // Ignore wire parse errors
      }
    }

    const fallbackBaseMs = Date.parse(session.createdAt ?? isoNow());
    let wireIdx = 0;
    let fallbackIdx = 0;

    const nextTimestamp = (): string => {
      if (wireIdx < wireTimestamps.length) {
        return wireTimestamps[wireIdx++];
      }
      return new Date(fallbackBaseMs + fallbackIdx++).toISOString();
    };

    const entries: IREntry[] = [];

    // Session meta
    const meta: IRSessionMeta = {
      ir_version: "1",
      type: "session_meta",
      source_tool: "kimi",
      source_session_id: session.sessionId,
      cwd: session.cwd ?? process.cwd(),
      title: session.title,
      model: session.model,
      created_at: session.createdAt ?? new Date(fallbackBaseMs).toISOString(),
    };
    entries.push(meta);

    for (const record of records) {
      if (record.role === "_checkpoint" || record.role === "_usage") {
        continue;
      }

      if (record.role === "user") {
        const msg: IRUserMessage = {
          type: "user_message",
          timestamp: nextTimestamp(),
          content: typeof record.content === "string" ? record.content : "",
        };
        entries.push(msg);
        continue;
      }

      if (record.role === "assistant") {
        const ts = nextTimestamp();
        const textParts: string[] = [];
        const thinkParts: string[] = [];

        if (Array.isArray(record.content)) {
          for (const block of record.content) {
            if (block.type === "text" && block.text) {
              textParts.push(block.text);
            } else if (block.type === "think" && block.think) {
              thinkParts.push(block.think);
            }
          }
        } else if (typeof record.content === "string") {
          textParts.push(record.content);
        }

        const assistantMsg: IRAssistantMessage = {
          type: "assistant_message",
          timestamp: ts,
          content: textParts.join("\n"),
        };
        if (thinkParts.length > 0) {
          assistantMsg.thinking = thinkParts.join("\n");
        }
        entries.push(assistantMsg);

        // Emit tool calls if present
        if (record.tool_calls) {
          for (const tc of record.tool_calls) {
            const toolCall: IRToolCall = {
              type: "tool_call",
              timestamp: ts,
              tool_call_id: tc.id,
              tool_name: tc.function.name,
              arguments: tc.function.arguments,
            };
            entries.push(toolCall);
          }
        }
        continue;
      }

      if (record.role === "tool") {
        const toolResult: IRToolResult = {
          type: "tool_result",
          timestamp: nextTimestamp(),
          tool_call_id: record.tool_call_id ?? "",
          output: typeof record.content === "string" ? record.content : JSON.stringify(record.content),
        };
        entries.push(toolResult);
        continue;
      }
    }

    return entries;
  }

  async write(entries: IREntry[], targetCwd: string): Promise<string> {
    const { writeKimiSession } = await import("./writer.js");
    return writeKimiSession(entries, targetCwd);
  }

  getResumeCommand(sessionId: string, targetCwd?: string): { command: string; args: string[] } {
    const args = ["--session", sessionId];
    if (targetCwd) {
      args.push("--work-dir", targetCwd);
    }
    return { command: "kimi", args };
  }

  // ── Private helpers ────────────────────────────────────────

  private async extractTitle(contextPath: string): Promise<string | undefined> {
    try {
      const records = await readJsonl<KimiRecord>(contextPath);
      for (const r of records) {
        if (r.role === "user" && typeof r.content === "string") {
          const text = r.content;
          return text.length > 80 ? text.slice(0, 77) + "..." : text;
        }
      }
    } catch {
      // Ignore
    }
    return undefined;
  }

  private async getCreatedAt(path: string): Promise<string | undefined> {
    try {
      const st = await stat(path);
      return st.birthtime.toISOString();
    } catch {
      return undefined;
    }
  }
}
