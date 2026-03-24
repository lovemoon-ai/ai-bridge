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
  OPENCODE_DB,
  OPENCODE_MESSAGES,
  OPENCODE_PARTS,
  OPENCODE_PROJECTS,
  listProjectFiles,
  listSessionFiles,
  resolveOpenCodeStorageMode,
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

interface OpenCodeDbSessionRow {
  id: string;
  slug: string;
  version: string;
  projectID: string;
  directory: string;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
}

interface OpenCodeDbProjectRow {
  id: string;
  worktree: string;
  vcs: "git" | null;
  sandboxes: string;
  createdAtMs: number;
  updatedAtMs: number;
  initializedAtMs: number | null;
}

interface OpenCodeDbMessageRow {
  id: string;
  sessionID: string;
  createdAtMs: number;
  data: string;
}

interface OpenCodeDbPartRow {
  id: string;
  messageID: string;
  sessionID: string;
  createdAtMs: number;
  data: string;
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

type OpenCodeDb = import("node:sqlite").DatabaseSync;

export class OpenCodeAdapter implements ToolAdapter {
  readonly name = "opencode" as const;

  async listSessions(): Promise<SessionInfo[]> {
    const projects = await this.loadProjectsById();
    const currentCwd = process.cwd();
    const currentProject = Array.from(projects.values()).find(
      (project) => project.worktree === currentCwd,
    );
    const preferredMode = await resolveOpenCodeStorageMode();
    const primarySessions = preferredMode === "db"
      ? await this.listDbSessions(projects)
      : await this.listFileSessions(projects);
    const secondarySessions = preferredMode === "db"
      ? await this.listFileSessions(projects)
      : await this.listDbSessions(projects);
    const sessions = primarySessions.length > 0 ? primarySessions : secondarySessions;

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
    if (session.path === OPENCODE_DB) {
      return this.readDbSession(session.sessionId);
    }

    const rawSession = await readJson<OpenCodeSessionRecord>(session.path);
    const projectPath = join(OPENCODE_PROJECTS, `${rawSession.projectID}.json`);
    const project = (await fileExists(projectPath))
      ? await readJson<OpenCodeProjectRecord>(projectPath)
      : null;

    const messages = await this.readSessionMessages(rawSession.id);
    return this.buildEntries(rawSession, project, messages, (messageId) =>
      this.readMessageParts(messageId),
    );
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

  private async listFileSessions(
    projects: Map<string, OpenCodeProjectRecord>,
  ): Promise<SessionInfo[]> {
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
          model: await this.extractSessionModelFromFiles(session.id),
        });
      } catch {
        // ignore corrupt sessions
      }
    }

    return sessions;
  }

  private async listDbSessions(
    projects: Map<string, OpenCodeProjectRecord>,
  ): Promise<SessionInfo[]> {
    return (
      (await this.withOpenCodeDb((db) => {
        const rows = db
          .prepare(
            `select
              id,
              slug,
              version,
              project_id as projectID,
              directory,
              title,
              time_created as createdAtMs,
              time_updated as updatedAtMs
            from session`,
          )
          .all() as unknown as OpenCodeDbSessionRow[];

        return rows.map((row) => {
          const session = normalizeDbSession(row);
          const project = projects.get(session.projectID);
          return {
            tool: "opencode",
            sessionId: session.id,
            title: session.title,
            cwd: session.directory || project?.worktree,
            createdAt: unixMsToIso(session.time.created),
            path: OPENCODE_DB,
            model: this.extractSessionModelFromDb(db, session.id),
          } satisfies SessionInfo;
        });
      })) ?? []
    );
  }

  private async readDbSession(sessionId: string): Promise<IREntry[]> {
    const payload = await this.withOpenCodeDb((db) => {
      const sessionRow = db
        .prepare(
          `select
            id,
            slug,
            version,
            project_id as projectID,
            directory,
            title,
            time_created as createdAtMs,
            time_updated as updatedAtMs
          from session
          where id = ?`,
        )
        .get(sessionId) as OpenCodeDbSessionRow | undefined;
      if (!sessionRow) return null;

      const projectRow = db
        .prepare(
          `select
            id,
            worktree,
            vcs,
            sandboxes,
            time_created as createdAtMs,
            time_updated as updatedAtMs,
            time_initialized as initializedAtMs
          from project
          where id = ?`,
        )
        .get(sessionRow.projectID) as OpenCodeDbProjectRow | undefined;

      const messageRows = db
        .prepare(
          `select
            id,
            session_id as sessionID,
            time_created as createdAtMs,
            data
          from message
          where session_id = ?
          order by time_created, id`,
        )
        .all(sessionId) as unknown as OpenCodeDbMessageRow[];

      const partRows = db
        .prepare(
          `select
            id,
            message_id as messageID,
            session_id as sessionID,
            time_created as createdAtMs,
            data
          from part
          where session_id = ?
          order by time_created, id`,
        )
        .all(sessionId) as unknown as OpenCodeDbPartRow[];

      return {
        session: normalizeDbSession(sessionRow),
        project: projectRow ? normalizeDbProject(projectRow) : null,
        messages: messageRows
          .map((row) => normalizeDbMessage(row))
          .filter((message): message is OpenCodeMessage => message !== null),
        partsByMessage: groupDbPartsByMessage(partRows),
      };
    });

    if (!payload) {
      throw new Error(`OpenCode session not found in database: ${sessionId}`);
    }

    return this.buildEntries(
      payload.session,
      payload.project,
      payload.messages,
      async (messageId) => payload.partsByMessage.get(messageId) ?? [],
    );
  }

  private async buildEntries(
    rawSession: OpenCodeSessionRecord,
    project: OpenCodeProjectRecord | null,
    messages: OpenCodeMessage[],
    getParts: (messageId: string) => Promise<OpenCodePart[]>,
  ): Promise<IREntry[]> {
    const model = this.extractSessionModelFromMessages(messages);

    const entries: IREntry[] = [];
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

    for (const item of messages) {
      const parts = await getParts(item.id);
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

    const dbProjects = await this.withOpenCodeDb((db) => {
      const rows = db
        .prepare(
          `select
            id,
            worktree,
            vcs,
            sandboxes,
            time_created as createdAtMs,
            time_updated as updatedAtMs,
            time_initialized as initializedAtMs
          from project`,
        )
        .all() as unknown as OpenCodeDbProjectRow[];
      return rows.map((row) => normalizeDbProject(row));
    });
    for (const project of dbProjects ?? []) {
      map.set(project.id, project);
    }

    return map;
  }

  private extractSessionModelFromDb(db: OpenCodeDb, sessionId: string): string | undefined {
    const rows = db
      .prepare(
        `select data
        from message
        where session_id = ?
        order by time_created, id`,
      )
      .all(sessionId) as Array<{ data: string }>;

    for (const row of rows) {
      try {
        const data = JSON.parse(row.data) as Partial<OpenCodeAssistantMessage>;
        if (data.role === "assistant") {
          return joinModelRef(data.providerID, data.modelID);
        }
      } catch {
        // ignore malformed row
      }
    }
    return undefined;
  }

  private async extractSessionModelFromFiles(sessionId: string): Promise<string | undefined> {
    const messages = await this.readSessionMessages(sessionId);
    return this.extractSessionModelFromMessages(messages);
  }

  private extractSessionModelFromMessages(messages: OpenCodeMessage[]): string | undefined {
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

  private async withOpenCodeDb<T>(run: (db: OpenCodeDb) => T): Promise<T | null> {
    let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      return null;
    }

    let db: OpenCodeDb;
    try {
      db = new DatabaseSync(OPENCODE_DB, { readOnly: true });
    } catch {
      return null;
    }

    try {
      return run(db);
    } finally {
      db.close();
    }
  }
}

function joinModelRef(providerID: string | undefined, modelID: string | undefined): string | undefined {
  if (!providerID && !modelID) return undefined;
  if (!providerID) return modelID;
  if (!modelID) return providerID;
  return `${providerID}/${modelID}`;
}

function normalizeDbSession(row: OpenCodeDbSessionRow): OpenCodeSessionRecord {
  return {
    id: row.id,
    slug: row.slug,
    version: row.version,
    projectID: row.projectID,
    directory: row.directory,
    title: row.title,
    time: {
      created: row.createdAtMs,
      updated: row.updatedAtMs,
    },
  };
}

function normalizeDbProject(row: OpenCodeDbProjectRow): OpenCodeProjectRecord {
  return {
    id: row.id,
    worktree: row.worktree,
    vcs: row.vcs ?? undefined,
    sandboxes: parseStringArray(row.sandboxes),
    time: {
      created: row.createdAtMs,
      updated: row.updatedAtMs,
      initialized: row.initializedAtMs ?? undefined,
    },
  };
}

function normalizeDbMessage(row: OpenCodeDbMessageRow): OpenCodeMessage | null {
  try {
    const data = JSON.parse(row.data) as Omit<OpenCodeMessage, "id" | "sessionID">;
    return {
      id: row.id,
      sessionID: row.sessionID,
      ...data,
      time: data.time ?? { created: row.createdAtMs },
    } as OpenCodeMessage;
  } catch {
    return null;
  }
}

function normalizeDbPart(row: OpenCodeDbPartRow): OpenCodePart | null {
  try {
    const data = JSON.parse(row.data) as Omit<OpenCodePart, "id" | "sessionID" | "messageID">;
    return {
      id: row.id,
      sessionID: row.sessionID,
      messageID: row.messageID,
      ...data,
    } as OpenCodePart;
  } catch {
    return null;
  }
}

function groupDbPartsByMessage(rows: OpenCodeDbPartRow[]): Map<string, OpenCodePart[]> {
  const map = new Map<string, OpenCodePart[]>();
  for (const row of rows) {
    const part = normalizeDbPart(row);
    if (!part) continue;
    const existing = map.get(row.messageID);
    if (existing) {
      existing.push(part);
    } else {
      map.set(row.messageID, [part]);
    }
  }
  return map;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
