import { dirname, join } from "node:path";

import type {
  IREntry,
  IRSessionMeta,
} from "../../types.js";
import { ensureDir, readJson, writeJson } from "../../utils/fs.js";
import { isoNow } from "../../utils/id.js";
import {
  OPENCODE_DB,
  OPENCODE_MESSAGES,
  OPENCODE_PARTS,
  OPENCODE_PROJECTS,
  OPENCODE_SESSIONS,
  OPENCODE_SESSION_DIFF,
  detectInstalledOpenCodeVersion,
  isoToUnixMs,
  opencodeId,
  opencodeProjectIdForCwd,
  opencodeSlug,
  listProjectFiles,
  resolveOpenCodeStorageMode,
  type OpenCodeProjectRecord,
} from "./utils.js";

interface OpenCodeSessionRecord {
  id: string;
  slug: string;
  version: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  time: {
    created: number;
    updated: number;
  };
  summary: {
    additions: number;
    deletions: number;
    files: number;
  };
}

interface OpenCodeUserMessage {
  id: string;
  sessionID: string;
  role: "user";
  time: { created: number };
  summary?: { diffs: Array<unknown> };
  agent: string;
  model: {
    providerID: string;
    modelID: string;
  };
  system?: string;
  tools?: Record<string, boolean>;
  variant?: string;
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
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  summary?: boolean;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
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
      time?: { start: number; end?: number };
    }
  | {
      id: string;
      sessionID: string;
      messageID: string;
      type: "reasoning";
      text: string;
      time: { start: number; end?: number };
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
            raw: string;
          }
        | {
            status: "completed";
            input: Record<string, unknown>;
            output: string;
            title: string;
            metadata: Record<string, unknown>;
            time: { start: number; end: number };
          }
        | {
            status: "error";
            input: Record<string, unknown>;
            error: string;
            metadata?: Record<string, unknown>;
            time: { start: number; end: number };
          };
    }
  | {
      id: string;
      sessionID: string;
      messageID: string;
      type: "step-start";
    }
  | {
      id: string;
      sessionID: string;
      messageID: string;
      type: "step-finish";
      reason: string;
      cost: number;
      tokens: {
        input: number;
        output: number;
        reasoning: number;
        cache: {
          read: number;
          write: number;
        };
      };
    };

interface PendingAssistantBundle {
  message: OpenCodeAssistantMessage;
  parts: OpenCodePart[];
  toolsByCallId: Map<string, Extract<OpenCodePart, { type: "tool" }>>;
}

type OpenCodeDb = import("node:sqlite").DatabaseSync;

export async function writeOpenCodeSession(
  entries: IREntry[],
  targetCwd: string,
): Promise<string> {
  const nowIso = isoNow();
  const meta = entries.find((entry) => entry.type === "session_meta") as IRSessionMeta | undefined;
  const storageMode = await resolveOpenCodeStorageMode();
  const opencodeVersion = await detectInstalledOpenCodeVersion();
  const sessionId = opencodeId("ses");
  const createdAtMs = isoToUnixMs(meta?.created_at, Date.now());
  const project = await resolveProject(targetCwd, createdAtMs, storageMode);
  const projectId = project.id;
  const sessionTitle = meta?.title || extractFirstUserText(entries) || `Bridged session ${sessionId.slice(-8)}`;

  const sessionRecord: OpenCodeSessionRecord = {
    id: sessionId,
    slug: opencodeSlug(sessionId),
    version: opencodeVersion || "ai-bridge",
    projectID: projectId,
    directory: targetCwd,
    title: sessionTitle,
    time: {
      created: createdAtMs,
      updated: createdAtMs,
    },
    summary: {
      additions: 0,
      deletions: 0,
      files: 0,
    },
  };

  const messages: Array<{ message: OpenCodeMessage; parts: OpenCodePart[] }> = [];
  let currentAssistant: PendingAssistantBundle | null = null;
  let previousMessageId: string | null = null;
  let fallbackModel = parseModelRef(meta?.model);

  const flushAssistant = (): void => {
    if (!currentAssistant) return;
    const lastTs = findLastPartTimestamp(currentAssistant.parts, currentAssistant.message.time.created);
    currentAssistant.message.time.completed = lastTs;
    currentAssistant.message.finish = currentAssistant.parts.some((part) => part.type === "tool")
      ? "tool-calls"
      : "stop";
    currentAssistant.parts.push({
      id: opencodeId("prt"),
      sessionID: sessionId,
      messageID: currentAssistant.message.id,
      type: "step-finish",
      reason: currentAssistant.message.finish,
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });
    messages.push({
      message: currentAssistant.message,
      parts: currentAssistant.parts,
    });
    previousMessageId = currentAssistant.message.id;
    currentAssistant = null;
  };

  const ensureAssistant = (timestampIso: string): PendingAssistantBundle => {
    if (currentAssistant) return currentAssistant;
    const created = isoToUnixMs(timestampIso, Date.now());
    const msgId = opencodeId("msg");
    currentAssistant = {
      message: {
        id: msgId,
        sessionID: sessionId,
        role: "assistant",
        time: { created },
        parentID: previousMessageId || opencodeId("msg"),
        modelID: fallbackModel.modelID,
        providerID: fallbackModel.providerID,
        mode: "build",
        agent: "build",
        path: { cwd: targetCwd, root: targetCwd },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [
        {
          id: opencodeId("prt"),
          sessionID: sessionId,
          messageID: msgId,
          type: "step-start",
        },
      ],
      toolsByCallId: new Map(),
    };
    return currentAssistant;
  };

  for (const entry of entries) {
    switch (entry.type) {
      case "session_meta":
        if (entry.model) {
          fallbackModel = parseModelRef(entry.model);
        }
        break;

      case "user_message": {
        flushAssistant();
        const created = isoToUnixMs(entry.timestamp, Date.now());
        const msgId = opencodeId("msg");
        const userMessage: OpenCodeUserMessage = {
          id: msgId,
          sessionID: sessionId,
          role: "user",
          time: { created },
          summary: { diffs: [] },
          agent: "build",
          model: fallbackModel,
        };
        const parts: OpenCodePart[] = [
          {
            id: opencodeId("prt"),
            sessionID: sessionId,
            messageID: msgId,
            type: "text",
            text: entry.content,
            time: { start: created, end: created },
          },
        ];
        messages.push({ message: userMessage, parts });
        previousMessageId = msgId;
        break;
      }

      case "assistant_message": {
        flushAssistant();
        const assistant = ensureAssistant(entry.timestamp);
        const modelRef = parseModelRef(entry.model || meta?.model);
        assistant.message.modelID = modelRef.modelID;
        assistant.message.providerID = modelRef.providerID;
        fallbackModel = modelRef;

        if (entry.thinking) {
          const ts = isoToUnixMs(entry.timestamp, assistant.message.time.created);
          assistant.parts.push({
            id: opencodeId("prt"),
            sessionID: sessionId,
            messageID: assistant.message.id,
            type: "reasoning",
            text: entry.thinking,
            time: { start: ts, end: ts },
          });
        }
        if (entry.content) {
          const ts = isoToUnixMs(entry.timestamp, assistant.message.time.created);
          assistant.parts.push({
            id: opencodeId("prt"),
            sessionID: sessionId,
            messageID: assistant.message.id,
            type: "text",
            text: entry.content,
            time: { start: ts, end: ts },
          });
        }
        break;
      }

      case "tool_call": {
        const assistant = ensureAssistant(entry.timestamp);
        const ts = isoToUnixMs(entry.timestamp, assistant.message.time.created);
        const input = safeParseObject(entry.arguments);
        const part: Extract<OpenCodePart, { type: "tool" }> = {
          id: opencodeId("prt"),
          sessionID: sessionId,
          messageID: assistant.message.id,
          type: "tool",
          callID: entry.tool_call_id,
          tool: entry.tool_name,
          state: {
            status: "pending",
            input,
            raw: entry.arguments,
          },
        };
        assistant.parts.push(part);
        assistant.toolsByCallId.set(entry.tool_call_id, part);
        assistant.message.time.completed = ts;
        break;
      }

      case "tool_result": {
        const assistant = ensureAssistant(entry.timestamp);
        const ts = isoToUnixMs(entry.timestamp, assistant.message.time.created);
        const existing = assistant.toolsByCallId.get(entry.tool_call_id);
        if (existing) {
          existing.state = {
            status: "completed",
            input: existing.state.input,
            output: entry.output,
            title: existing.tool,
            metadata: {},
            time: {
              start: assistant.message.time.created,
              end: ts,
            },
          };
        } else {
          assistant.parts.push({
            id: opencodeId("prt"),
            sessionID: sessionId,
            messageID: assistant.message.id,
            type: "tool",
            callID: entry.tool_call_id,
            tool: "unknown_tool",
            state: {
              status: "completed",
              input: {},
              output: entry.output,
              title: "unknown_tool",
              metadata: {},
              time: {
                start: ts,
                end: ts,
              },
            },
          });
        }
        assistant.message.time.completed = ts;
        break;
      }
    }
  }

  flushAssistant();

  const updatedAtMs = messages.length > 0
    ? findMessageUpdatedAt(messages[messages.length - 1])
    : createdAtMs;
  sessionRecord.time.updated = updatedAtMs;

  if (storageMode === "db") {
    await writeDbSession(project, sessionRecord, messages);
  } else {
    await writeJson(join(OPENCODE_PROJECTS, `${projectId}.json`), project);
    await writeJson(join(OPENCODE_SESSIONS, projectId, `${sessionId}.json`), sessionRecord);

    for (const item of messages) {
      await writeJson(join(OPENCODE_MESSAGES, sessionId, `${item.message.id}.json`), item.message);
      for (const part of item.parts) {
        await writeJson(join(OPENCODE_PARTS, item.message.id, `${part.id}.json`), part);
      }
    }
  }

  await writeJson(join(OPENCODE_SESSION_DIFF, `${sessionId}.json`), []);

  return sessionId;
}

async function buildProjectRecord(
  projectId: string,
  targetCwd: string,
  createdAtMs: number,
): Promise<OpenCodeProjectRecord> {
  return {
    id: projectId,
    worktree: targetCwd,
    vcs: "git",
    sandboxes: [],
    time: {
      created: createdAtMs,
      updated: Date.now(),
    },
  };
}

async function resolveProject(
  targetCwd: string,
  createdAtMs: number,
  storageMode: "json" | "db",
): Promise<OpenCodeProjectRecord> {
  if (storageMode === "db") {
    const dbProject = await withWritableOpenCodeDb((db) => {
      ensureDbSchema(db);
      const row = db
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
          where worktree = ?
          limit 1`,
        )
        .get(targetCwd) as
        | {
            id: string;
            worktree: string;
            vcs: "git" | null;
            sandboxes: string;
            createdAtMs: number;
            updatedAtMs: number;
            initializedAtMs: number | null;
          }
        | undefined;
      if (!row) return null;
      return {
        id: row.id,
        worktree: row.worktree,
        vcs: row.vcs ?? undefined,
        sandboxes: parseStringArray(row.sandboxes),
        time: {
          created: row.createdAtMs,
          updated: Date.now(),
          initialized: row.initializedAtMs ?? undefined,
        },
      } satisfies OpenCodeProjectRecord;
    });
    if (dbProject) return dbProject;
  }

  const files = await listProjectFiles();
  for (const file of files) {
    try {
      const project = await readJson<OpenCodeProjectRecord>(file);
      if (project.worktree === targetCwd) {
        return {
          ...project,
          time: {
            ...project.time,
            updated: Date.now(),
          },
        };
      }
    } catch {
      // ignore broken project file
    }
  }

  return buildProjectRecord(opencodeProjectIdForCwd(targetCwd), targetCwd, createdAtMs);
}

async function writeDbSession(
  project: OpenCodeProjectRecord,
  sessionRecord: OpenCodeSessionRecord,
  messages: Array<{ message: OpenCodeMessage; parts: OpenCodePart[] }>,
): Promise<void> {
  const result = await withWritableOpenCodeDb((db) => {
    ensureDbSchema(db);
    db.exec("BEGIN");
    try {
      db.prepare(
        `insert into project (
          id, worktree, vcs, sandboxes, time_created, time_updated, time_initialized
        ) values (?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          worktree=excluded.worktree,
          vcs=excluded.vcs,
          sandboxes=excluded.sandboxes,
          time_updated=excluded.time_updated,
          time_initialized=excluded.time_initialized`,
      ).run(
        project.id,
        project.worktree,
        project.vcs ?? null,
        JSON.stringify(project.sandboxes),
        project.time.created,
        project.time.updated,
        project.time.initialized ?? null,
      );

      db.prepare(
        `insert into session (
          id,
          project_id,
          parent_id,
          slug,
          directory,
          title,
          version,
          summary_additions,
          summary_deletions,
          summary_files,
          time_created,
          time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionRecord.id,
        sessionRecord.projectID,
        null,
        sessionRecord.slug,
        sessionRecord.directory,
        sessionRecord.title,
        sessionRecord.version,
        sessionRecord.summary.additions,
        sessionRecord.summary.deletions,
        sessionRecord.summary.files,
        sessionRecord.time.created,
        sessionRecord.time.updated,
      );

      const insertMessage = db.prepare(
        `insert into message (id, session_id, time_created, time_updated, data)
         values (?, ?, ?, ?, ?)`,
      );
      const insertPart = db.prepare(
        `insert into part (id, message_id, session_id, time_created, time_updated, data)
         values (?, ?, ?, ?, ?, ?)`,
      );

      for (const item of messages) {
        const messageUpdatedAt = findMessageUpdatedAt(item);
        insertMessage.run(
          item.message.id,
          item.message.sessionID,
          item.message.time.created,
          messageUpdatedAt,
          JSON.stringify(stripMessageEnvelope(item.message)),
        );
        for (const part of item.parts) {
          insertPart.run(
            part.id,
            part.messageID,
            part.sessionID,
            findPartCreatedAt(part, item.message.time.created),
            findPartUpdatedAt(part, messageUpdatedAt),
            JSON.stringify(stripPartEnvelope(part)),
          );
        }
      }

      db.exec("COMMIT");
      return true;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });

  if (result === null) {
    throw new Error("Unable to open OpenCode database for writing");
  }
}

function extractFirstUserText(entries: IREntry[]): string | undefined {
  const firstUser = entries.find((entry) => entry.type === "user_message");
  if (!firstUser || firstUser.type !== "user_message") return undefined;
  const clean = firstUser.content.trim().replace(/\s+/g, " ");
  if (!clean) return undefined;
  return clean.slice(0, 80);
}

function parseModelRef(model: string | undefined): { providerID: string; modelID: string } {
  const trimmed = model?.trim();
  if (!trimmed) {
    return { providerID: "bridged", modelID: "unknown" };
  }
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx === -1) {
    return { providerID: "bridged", modelID: trimmed };
  }
  return {
    providerID: trimmed.slice(0, slashIdx) || "bridged",
    modelID: trimmed.slice(slashIdx + 1) || "unknown",
  };
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return { raw };
}

function findLastPartTimestamp(parts: OpenCodePart[], fallback: number): number {
  let last = fallback;
  for (const part of parts) {
    if ("time" in part && part.time) {
      if (typeof part.time.end === "number") {
        last = Math.max(last, part.time.end);
      }
      if (typeof part.time.start === "number") {
        last = Math.max(last, part.time.start);
      }
    }
  }
  return last;
}

function findMessageUpdatedAt(item: { message: OpenCodeMessage; parts: OpenCodePart[] }): number {
  const base =
    item.message.role === "assistant"
      ? item.message.time.completed || item.message.time.created
      : item.message.time.created;
  return findLastPartTimestamp(item.parts, base);
}

function findPartCreatedAt(part: OpenCodePart, fallback: number): number {
  if ("time" in part && part.time && typeof part.time.start === "number") {
    return part.time.start;
  }
  return fallback;
}

function findPartUpdatedAt(part: OpenCodePart, fallback: number): number {
  if ("time" in part && part.time) {
    if (typeof part.time.end === "number") return part.time.end;
    if (typeof part.time.start === "number") return part.time.start;
  }
  return fallback;
}

function stripMessageEnvelope(message: OpenCodeMessage): Omit<OpenCodeMessage, "id" | "sessionID"> {
  const { id: _id, sessionID: _sessionID, ...data } = message;
  return data;
}

function stripPartEnvelope(
  part: OpenCodePart,
): Omit<OpenCodePart, "id" | "sessionID" | "messageID"> {
  const { id: _id, sessionID: _sessionID, messageID: _messageID, ...data } = part;
  return data;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function ensureDbSchema(db: OpenCodeDb): void {
  db.exec(`
    create table if not exists project (
      id text primary key,
      worktree text not null,
      vcs text,
      name text,
      icon_url text,
      icon_color text,
      time_created integer not null,
      time_updated integer not null,
      time_initialized integer,
      sandboxes text not null,
      commands text
    );
    create table if not exists session (
      id text primary key,
      project_id text not null,
      parent_id text,
      slug text not null,
      directory text not null,
      title text not null,
      version text not null,
      share_url text,
      summary_additions integer,
      summary_deletions integer,
      summary_files integer,
      summary_diffs text,
      revert text,
      permission text,
      time_created integer not null,
      time_updated integer not null,
      time_compacting integer,
      time_archived integer,
      workspace_id text
    );
    create table if not exists message (
      id text primary key,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null
    );
    create table if not exists part (
      id text primary key,
      message_id text not null,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null
    );
    create index if not exists message_session_time_created_id_idx on message (session_id, time_created, id);
    create index if not exists part_session_idx on part (session_id);
    create index if not exists part_message_id_id_idx on part (message_id, id);
    create index if not exists session_project_idx on session (project_id);
  `);
}

async function withWritableOpenCodeDb<T>(run: (db: OpenCodeDb) => T): Promise<T | null> {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }

  await ensureDir(dirname(OPENCODE_DB));

  let db: OpenCodeDb;
  try {
    db = new DatabaseSync(OPENCODE_DB);
  } catch {
    return null;
  }

  try {
    return run(db);
  } finally {
    db.close();
  }
}
