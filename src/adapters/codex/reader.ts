import { basename } from "node:path";
import type {
  ToolAdapter,
  SessionInfo,
  IREntry,
  IRSessionMeta,
  IRUserMessage,
  IRAssistantMessage,
  IRToolCall,
  IRToolResult,
} from "../../types.js";
import { readJsonl } from "../../utils/fs.js";
import { isIdPrefix, isoNow } from "../../utils/id.js";
import { findRolloutFiles, sessionIdFromFilename } from "./utils.js";
import { writeCodexSession } from "./writer.js";

// ── Raw Codex JSONL line shapes ────────────────────────────────

interface CodexLine {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

// ── Adapter ────────────────────────────────────────────────────

export class CodexAdapter implements ToolAdapter {
  readonly name = "codex" as const;

  /* ---- listSessions ---- */

  async listSessions(): Promise<SessionInfo[]> {
    const files = await findRolloutFiles();
    const sessions: SessionInfo[] = [];

    for (const file of files) {
      try {
        const info = await this.sessionInfoFromFile(file);
        if (info) sessions.push(info);
      } catch {
        // Corrupt / unreadable file — skip.
      }
    }
    return sessions;
  }

  /* ---- findSession ---- */

  async findSession(sessionId: string): Promise<SessionInfo | null> {
    const files = await findRolloutFiles();

    for (const file of files) {
      const fileId = sessionIdFromFilename(basename(file));
      if (isIdPrefix(sessionId, fileId)) {
        return this.sessionInfoFromFile(file);
      }
    }

    // Also check the session_meta payload id field.
    for (const file of files) {
      try {
        const lines = await readJsonl<CodexLine>(file);
        const meta = lines.find((l) => l.type === "session_meta");
        if (meta) {
          const id = (meta.payload as Record<string, unknown>).id as string | undefined;
          if (id && isIdPrefix(sessionId, id)) {
            return this.sessionInfoFromFile(file);
          }
        }
      } catch {
        // skip
      }
    }

    return null;
  }

  /* ---- read ---- */

  async read(session: SessionInfo): Promise<IREntry[]> {
    const lines = await readJsonl<CodexLine>(session.path);
    return this.convertLines(lines);
  }

  /* ---- write ---- */

  async write(entries: IREntry[], targetCwd: string): Promise<string> {
    return writeCodexSession(entries, targetCwd);
  }

  /* ---- getResumeCommand ---- */

  getResumeCommand(sessionId: string, targetCwd?: string): { command: string; args: string[] } {
    const args = ["resume", sessionId];
    if (targetCwd) {
      args.push("--cd", targetCwd);
    }
    return { command: "codex", args };
  }

  // ── Private helpers ──────────────────────────────────────────

  private async sessionInfoFromFile(file: string): Promise<SessionInfo | null> {
    const lines = await readJsonl<CodexLine>(file);
    if (lines.length === 0) return null;

    const fileId = sessionIdFromFilename(basename(file));

    // Prefer session_meta line for metadata.
    const meta = lines.find((l) => l.type === "session_meta");
    const turnCtx = lines.find((l) => l.type === "turn_context");

    const payload = meta?.payload as Record<string, unknown> | undefined;
    const git = payload?.git as Record<string, unknown> | undefined;

    const sessionId = (payload?.id as string) ?? fileId;
    const cwd = (payload?.cwd as string) ?? undefined;
    const createdAt = (payload?.timestamp as string) ?? meta?.timestamp ?? lines[0].timestamp;
    const model = (turnCtx?.payload as Record<string, unknown>)?.model as string | undefined;

    return {
      tool: "codex",
      sessionId,
      cwd,
      model,
      createdAt,
      path: file,
    };
  }

  /** Convert raw Codex JSONL lines to IR entries. */
  private convertLines(lines: CodexLine[]): IREntry[] {
    const entries: IREntry[] = [];

    // Collect model from turn_context lines.
    let currentModel: string | undefined;

    for (const line of lines) {
      switch (line.type) {
        case "session_meta":
          entries.push(this.convertSessionMeta(line));
          break;

        case "turn_context":
          currentModel = (line.payload as Record<string, unknown>).model as string | undefined;
          break;

        case "response_item":
          this.convertResponseItem(line, entries, currentModel);
          break;

        case "event_msg":
          this.convertEventMsg(line, entries, currentModel);
          break;

        default:
          // Unknown line type — skip.
          break;
      }
    }

    return entries;
  }

  private convertSessionMeta(line: CodexLine): IRSessionMeta {
    const p = line.payload as Record<string, unknown>;
    const git = p.git as Record<string, unknown> | undefined;
    return {
      ir_version: "1",
      type: "session_meta",
      source_tool: "codex",
      source_session_id: (p.id as string) ?? "",
      cwd: (p.cwd as string) ?? "",
      git_branch: git?.branch as string | undefined,
      title: (p.title as string) ?? undefined,
      model: (p.model as string) ?? undefined,
      created_at: (p.timestamp as string) ?? line.timestamp,
    };
  }

  private convertResponseItem(
    line: CodexLine,
    entries: IREntry[],
    model: string | undefined,
  ): void {
    const p = line.payload as Record<string, unknown>;
    const itemType = p.type as string;

    switch (itemType) {
      case "message": {
        const role = p.role as string;
        const content = p.content as Array<Record<string, unknown>> | undefined;
        const text = this.joinContentParts(content);

        // Skip system/developer messages and injected context (AGENTS.md, environment_context).
        if (role === "developer" || role === "system") break;
        if (role === "user" && (text.includes("<environment_context>") || text.startsWith("# AGENTS.md"))) break;

        if (role === "user") {
          entries.push({
            type: "user_message",
            timestamp: line.timestamp,
            content: text,
          } satisfies IRUserMessage);
        } else if (role === "assistant") {
          entries.push({
            type: "assistant_message",
            timestamp: line.timestamp,
            content: text,
            model,
          } satisfies IRAssistantMessage);
        }
        break;
      }

      case "function_call": {
        entries.push({
          type: "tool_call",
          timestamp: line.timestamp,
          tool_call_id: (p.call_id as string) ?? "",
          tool_name: (p.name as string) ?? "unknown",
          arguments: (p.arguments as string) ?? "{}",
        } satisfies IRToolCall);
        break;
      }

      case "function_call_output": {
        entries.push({
          type: "tool_result",
          timestamp: line.timestamp,
          tool_call_id: (p.call_id as string) ?? "",
          output: (p.output as string) ?? "",
        } satisfies IRToolResult);
        break;
      }

      case "reasoning": {
        // Attach reasoning/thinking to the nearest assistant message.
        const summary = p.summary as Array<Record<string, unknown>> | undefined;
        const thinkingText = summary
          ?.map((s) => (s.text as string) ?? "")
          .filter(Boolean)
          .join("\n") ?? "";

        if (thinkingText) {
          // Walk backwards to find the previous assistant message.
          for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (entry.type === "assistant_message") {
              (entry as IRAssistantMessage).thinking = thinkingText;
              break;
            }
          }
          // If no prior assistant message, skip this reasoning.
          // It will be picked up by the following agent_reasoning handler
          // or lost if there's no subsequent assistant message.
        }
        break;
      }

      default:
        break;
    }
  }

  private convertEventMsg(
    line: CodexLine,
    entries: IREntry[],
    model: string | undefined,
  ): void {
    const p = line.payload as Record<string, unknown>;
    const eventType = p.type as string;

    switch (eventType) {
      // Skip user_message and agent_message from event_msg —
      // they duplicate the response_item "message" entries.
      case "user_message":
      case "agent_message":
        break;

      case "agent_reasoning": {
        // Attach to previous assistant message if available.
        const text = (p.text as string) ?? "";
        if (text) {
          for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (entry.type === "assistant_message") {
              const existing = (entry as IRAssistantMessage).thinking;
              (entry as IRAssistantMessage).thinking = existing
                ? existing + "\n" + text
                : text;
              return;
            }
          }
          // No prior assistant message — skip.
          // The reasoning will be picked up by the following assistant message.
        }
        break;
      }

      // Intentionally skip token_count, turn_aborted, and other event types.
      default:
        break;
    }
  }

  /** Join content parts (input_text / output_text) into a single string. */
  private joinContentParts(parts: Array<Record<string, unknown>> | undefined): string {
    if (!parts || !Array.isArray(parts)) return "";
    return parts
      .map((part) => (part.text as string) ?? "")
      .filter(Boolean)
      .join("\n");
  }
}
