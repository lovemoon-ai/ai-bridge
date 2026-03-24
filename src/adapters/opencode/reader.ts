import { readdir } from "node:fs/promises";
import { join } from "node:path";

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
import { fileExists, readJson } from "../../utils/fs.js";
import { isIdPrefix } from "../../utils/id.js";
import {
  OPENCODE_MESSAGES,
  OPENCODE_PARTS,
  OPENCODE_PROJECTS,
  listProjectFiles,
  listSessionFiles,
  unixMsToIso,
} from "./utils.js";
import { writeOpenCodeSession } from "./writer.js";

interface OpenCodeSessionRecord {
  id: string;
  slug: string;
  version: string;
  projectID: string;
  directory: string;
  title: string;
  time: {
    created: number;
    updated: number;
  };
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
}

interface OpenCodeProjectRecord {
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

interface OpenCodeUserMessage {
  id: string;
  sessionID: string;
  role: "user";
  time: { created: number };
  agent?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
}

interface OpenCodeAssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  parentID: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  agent?: string;
  finish?: string;
}

type OpenCodeMessage = OpenCodeUserMessage | OpenCodeAssistantMessage;

type OpenCodePart =
  | {
      id: string;
      sessionID: string;
      messageID: string;
      type: "text";
      text: string;
    }
  | {
      id: string;
      sessionID: string;
      messageID: string;
      type: "reasoning";
      text: string;
    }
  | {
      id: string;
      sessionID: string;
      messageID: string;
      type: "tool";
      callID: string;
      tool: string;
      state:
        | {
            status: "pending";
            input: Record<string, unknown>;
            raw?: string;
          }
        | {
            status: "completed";
            input: Record<string, unknown>;
            output: string;
            time?: {
              start: number;
              end?: number;
            };
          }
        | {
            status: "error";
            input: Record<string, unknown>;
            error: string;
            time?: {
              start: number;
              end?: number;
            };
          };
    }
  | {
      id: string;
      sessionID: string;
      messageID: string;
      type: "step-start" | "step-finish";
    };

export class OpenCodeAdapter implements ToolAdapter {
  readonly name = "opencode" as const;

  async listSessions(): Promise<SessionInfo[]> {
    const projects = await this.loadProjectsById();
    const currentCwd = process.cwd();
    const currentProject = Array.from(projects.values()).find(
      (project) => project.worktree === currentCwd,
    );
    const files = await listSessionFiles();
    const sessions: SessionInfo[] = [];

    for (const file of files) {
      try {
        const session = await readJson<OpenCodeSessionRecord>(file);
        const project = projects.get(session.projectID);
        sessions.push({
          tool: "opencode",
          sessionId: session.id,
          title: session.title,
          cwd: session.directory || project?.worktree,
          createdAt: unixMsToIso(session.time.created),
          path: file,
          model: await this.extractSessionModel(session.id),
        });
      } catch {
        // ignore corrupt sessions
      }
    }

    return sessions.sort((a, b) => {
      const aCurrent = currentProject && a.cwd === currentProject.worktree ? 1 : 0;
      const bCurrent = currentProject && b.cwd === currentProject.worktree ? 1 : 0;
      if (aCurrent !== bCurrent) return bCurrent - aCurrent;

      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  }

  async findSession(sessionId: string): Promise<SessionInfo | null> {
    const all = await this.listSessions();
    return all.find((session) => isIdPrefix(sessionId, session.sessionId)) ?? null;
  }

  async read(session: SessionInfo): Promise<IREntry[]> {
    const rawSession = await readJson<OpenCodeSessionRecord>(session.path);
    const projectPath = join(OPENCODE_PROJECTS, `${rawSession.projectID}.json`);
    const project = (await fileExists(projectPath))
      ? await readJson<OpenCodeProjectRecord>(projectPath)
      : null;

    const entries: IREntry[] = [];
    const model = await this.extractSessionModel(rawSession.id);
    entries.push({
      ir_version: "1",
      type: "session_meta",
      source_tool: "opencode",
      source_session_id: rawSession.id,
      cwd: rawSession.directory || project?.worktree || process.cwd(),
      title: rawSession.title,
      model,
      created_at: unixMsToIso(rawSession.time.created),
    } satisfies IRSessionMeta);

    const messages = await this.readSessionMessages(rawSession.id);
    for (const item of messages) {
      const parts = await this.readMessageParts(item.id);
      const textParts = parts
        .filter((part): part is Extract<OpenCodePart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .filter(Boolean);

      if (item.role === "user") {
        if (textParts.length > 0) {
          entries.push({
            type: "user_message",
            timestamp: unixMsToIso(item.time.created),
            content: textParts.join("\n"),
          } satisfies IRUserMessage);
        }
        continue;
      }

      const assistant = item as OpenCodeAssistantMessage;
      const thinking = parts
        .filter((part): part is Extract<OpenCodePart, { type: "reasoning" }> => part.type === "reasoning")
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n");
      entries.push({
        type: "assistant_message",
        timestamp: unixMsToIso(assistant.time.created),
        content: textParts.join("\n"),
        thinking: thinking || undefined,
        model: joinModelRef(assistant.providerID, assistant.modelID),
      } satisfies IRAssistantMessage);

      for (const part of parts) {
        if (part.type !== "tool") continue;
        const toolTimestamp =
          "time" in part.state && part.state.time && typeof part.state.time.start === "number"
            ? unixMsToIso(part.state.time.start)
            : unixMsToIso(assistant.time.created);

        entries.push({
          type: "tool_call",
          timestamp: toolTimestamp,
          tool_call_id: part.callID,
          tool_name: part.tool,
          arguments: JSON.stringify(part.state.input ?? {}),
        } satisfies IRToolCall);

        if (part.state.status === "completed") {
          entries.push({
            type: "tool_result",
            timestamp:
              "time" in part.state && part.state.time && typeof part.state.time.end === "number"
                ? unixMsToIso(part.state.time.end)
                : toolTimestamp,
            tool_call_id: part.callID,
            output: part.state.output,
          } satisfies IRToolResult);
        } else if (part.state.status === "error") {
          entries.push({
            type: "tool_result",
            timestamp:
              "time" in part.state && part.state.time && typeof part.state.time.end === "number"
                ? unixMsToIso(part.state.time.end)
                : toolTimestamp,
            tool_call_id: part.callID,
            output: part.state.error,
          } satisfies IRToolResult);
        }
      }
    }

    return entries;
  }

  async write(entries: IREntry[], targetCwd: string): Promise<string> {
    return writeOpenCodeSession(entries, targetCwd);
  }

  getResumeCommand(sessionId: string, targetCwd?: string): { command: string; args: string[] } {
    const args = [];
    if (targetCwd) args.push(targetCwd);
    args.push("--session", sessionId);
    return { command: "opencode", args };
  }

  private async loadProjectsById(): Promise<Map<string, OpenCodeProjectRecord>> {
    const map = new Map<string, OpenCodeProjectRecord>();
    const files = await listProjectFiles();
    for (const file of files) {
      try {
        const project = await readJson<OpenCodeProjectRecord>(file);
        map.set(project.id, project);
      } catch {
        // ignore bad project files
      }
    }
    return map;
  }

  private async extractSessionModel(sessionId: string): Promise<string | undefined> {
    const messages = await this.readSessionMessages(sessionId);
    const firstAssistant = messages.find(
      (message): message is OpenCodeAssistantMessage => message.role === "assistant",
    );
    return firstAssistant ? joinModelRef(firstAssistant.providerID, firstAssistant.modelID) : undefined;
  }

  private async readSessionMessages(sessionId: string): Promise<OpenCodeMessage[]> {
    const dir = join(OPENCODE_MESSAGES, sessionId);
    let filenames: string[];
    try {
      filenames = await readdir(dir);
    } catch {
      return [];
    }

    const messages: OpenCodeMessage[] = [];
    for (const filename of filenames.sort()) {
      if (!filename.endsWith(".json")) continue;
      try {
        messages.push(await readJson<OpenCodeMessage>(join(dir, filename)));
      } catch {
        // ignore bad message files
      }
    }
    return messages.sort((a, b) => {
      const ta = a.time.created;
      const tb = b.time.created;
      if (ta !== tb) return ta - tb;
      return a.id.localeCompare(b.id);
    });
  }

  private async readMessageParts(messageId: string): Promise<OpenCodePart[]> {
    const dir = join(OPENCODE_PARTS, messageId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }

    const parts: OpenCodePart[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith(".json")) continue;
      try {
        parts.push(await readJson<OpenCodePart>(join(dir, file)));
      } catch {
        // ignore bad part files
      }
    }
    return parts;
  }
}

function joinModelRef(providerID: string | undefined, modelID: string | undefined): string | undefined {
  if (!providerID && !modelID) return undefined;
  if (!providerID) return modelID;
  if (!modelID) return providerID;
  return `${providerID}/${modelID}`;
}
