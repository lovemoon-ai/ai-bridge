import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function fixtureEntries(cwd) {
  const ts0 = "2026-03-24T10:00:00.000Z";
  const ts1 = "2026-03-24T10:00:05.000Z";
  const ts2 = "2026-03-24T10:00:10.000Z";
  const ts3 = "2026-03-24T10:00:11.000Z";
  const ts4 = "2026-03-24T10:00:20.000Z";
  return [
    {
      ir_version: "1",
      type: "session_meta",
      source_tool: "fixture",
      source_session_id: "fixture-session",
      cwd,
      title: "Bridge fixture",
      model: "gpt-5",
      created_at: ts0,
    },
    {
      type: "user_message",
      timestamp: ts1,
      content: "Please inspect the repo and run a tool.",
    },
    {
      type: "assistant_message",
      timestamp: ts2,
      content: "I will inspect the repo now.",
      thinking: "Need to inspect files first.",
      model: "gpt-5",
    },
    {
      type: "tool_call",
      timestamp: ts2,
      tool_call_id: "call_1",
      tool_name: "read_file",
      arguments: JSON.stringify({ path: "README.md" }),
    },
    {
      type: "tool_result",
      timestamp: ts3,
      tool_call_id: "call_1",
      output: "# README\nhello",
    },
    {
      type: "assistant_message",
      timestamp: ts4,
      content: "Done reading README.",
      model: "gpt-5",
    },
  ];
}

function normalizeEntries(entries) {
  return entries.map((entry) => {
    switch (entry.type) {
      case "session_meta":
        return {
          type: entry.type,
          cwd: entry.cwd,
          title: entry.title,
        };
      case "user_message":
        return {
          type: entry.type,
          content: entry.content,
        };
      case "assistant_message":
        return {
          type: entry.type,
          content: entry.content,
          thinking: entry.thinking || "",
        };
      case "tool_call":
        return {
          type: entry.type,
          tool_call_id: entry.tool_call_id,
          tool_name: entry.tool_name,
          arguments: safeParse(entry.arguments),
        };
      case "tool_result":
        return {
          type: entry.type,
          tool_call_id: entry.tool_call_id,
          output: entry.output,
        };
      default:
        return entry;
    }
  });
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function createOpenCodeDbFixture(home, workspace) {
  const opencodeRoot = join(home, ".local", "share", "opencode");
  mkdirSync(opencodeRoot, { recursive: true });
  const dbPath = join(opencodeRoot, "opencode.db");
  const db = new DatabaseSync(dbPath);

  db.exec(`
    create table if not exists project (
      id text primary key,
      worktree text not null,
      vcs text,
      sandboxes text not null,
      time_created integer not null,
      time_updated integer not null,
      time_initialized integer
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
  `);

  const projectId = "proj_sqlite_fixture";
  const sessionId = "ses_sqliteFixture000000000001";
  const created0 = Date.parse("2026-03-24T10:00:00.000Z");
  const created1 = Date.parse("2026-03-24T10:00:05.000Z");
  const created2 = Date.parse("2026-03-24T10:00:10.000Z");
  const created3 = Date.parse("2026-03-24T10:00:11.000Z");
  const created4 = Date.parse("2026-03-24T10:00:20.000Z");

  db.prepare(
    `insert into project (id, worktree, vcs, sandboxes, time_created, time_updated, time_initialized)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(projectId, workspace, "git", "[]", created0, created3, created0);

  db.prepare(
    `insert into session (
      id, project_id, slug, directory, title, version,
      summary_additions, summary_deletions, summary_files,
      time_created, time_updated
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    projectId,
    "sqlite-fixture",
    workspace,
    "Bridge fixture",
    "1.2.27",
    0,
    0,
    0,
    created0,
    created3,
  );

  db.prepare(
    `insert into message (id, session_id, time_created, time_updated, data)
     values (?, ?, ?, ?, ?)`,
  ).run(
    "msg_sql_user",
    sessionId,
    created1,
    created1,
    JSON.stringify({
      role: "user",
      time: { created: created1 },
      agent: "build",
      model: { providerID: "opencode", modelID: "gpt-5" },
    }),
  );
  db.prepare(
    `insert into part (id, message_id, session_id, time_created, time_updated, data)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(
    "prt_sql_user_text",
    "msg_sql_user",
    sessionId,
    created1,
    created1,
    JSON.stringify({ type: "text", text: "Please inspect the repo and run a tool." }),
  );

  db.prepare(
    `insert into message (id, session_id, time_created, time_updated, data)
     values (?, ?, ?, ?, ?)`,
  ).run(
    "msg_sql_assistant",
    sessionId,
    created2,
    created3,
    JSON.stringify({
      role: "assistant",
      time: { created: created2, completed: created3 },
      parentID: "msg_sql_user",
      modelID: "gpt-5",
      providerID: "opencode",
      mode: "build",
      agent: "build",
      finish: "stop",
    }),
  );
  db.prepare(
    `insert into part (id, message_id, session_id, time_created, time_updated, data)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(
    "prt_sql_reasoning",
    "msg_sql_assistant",
    sessionId,
    created2,
    created2,
    JSON.stringify({
      type: "reasoning",
      text: "Need to inspect files first.",
      time: { start: created2, end: created2 },
    }),
  );
  db.prepare(
    `insert into part (id, message_id, session_id, time_created, time_updated, data)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(
    "prt_sql_tool",
    "msg_sql_assistant",
    sessionId,
    created2,
    created3,
    JSON.stringify({
      type: "tool",
      callID: "call_1",
      tool: "read_file",
      state: {
        status: "completed",
        input: { path: "README.md" },
        output: "# README\nhello",
        time: { start: created2, end: created3 },
      },
    }),
  );
  db.prepare(
    `insert into part (id, message_id, session_id, time_created, time_updated, data)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(
    "prt_sql_text",
    "msg_sql_assistant",
    sessionId,
    created3,
    created3,
    JSON.stringify({
      type: "text",
      text: "I will inspect the repo now.",
      time: { start: created3, end: created3 },
    }),
  );
  db.prepare(
    `insert into message (id, session_id, time_created, time_updated, data)
     values (?, ?, ?, ?, ?)`,
  ).run(
    "msg_sql_assistant_2",
    sessionId,
    created4,
    created4,
    JSON.stringify({
      role: "assistant",
      time: { created: created4, completed: created4 },
      parentID: "msg_sql_user",
      modelID: "gpt-5",
      providerID: "opencode",
      mode: "build",
      agent: "build",
      finish: "stop",
    }),
  );
  db.prepare(
    `insert into part (id, message_id, session_id, time_created, time_updated, data)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(
    "prt_sql_text_2",
    "msg_sql_assistant_2",
    sessionId,
    created4,
    created4,
    JSON.stringify({
      type: "text",
      text: "Done reading README.",
      time: { start: created4, end: created4 },
    }),
  );

  db.close();
  return sessionId;
}

test("opencode and codex bridge both directions", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ai-bridge-opencode-"));
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_DATA_HOME;
  const previousVersion = process.env.AIBRIDGE_OPENCODE_VERSION;
  const previousStorageMode = process.env.AIBRIDGE_OPENCODE_STORAGE_MODE;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    if (previousVersion === undefined) delete process.env.AIBRIDGE_OPENCODE_VERSION;
    else process.env.AIBRIDGE_OPENCODE_VERSION = previousVersion;
    if (previousStorageMode === undefined) delete process.env.AIBRIDGE_OPENCODE_STORAGE_MODE;
    else process.env.AIBRIDGE_OPENCODE_STORAGE_MODE = previousStorageMode;
    await rm(home, { recursive: true, force: true });
  });

  process.env.HOME = home;
  delete process.env.XDG_DATA_HOME;
  process.env.AIBRIDGE_OPENCODE_VERSION = "1.3.0";
  delete process.env.AIBRIDGE_OPENCODE_STORAGE_MODE;

  const workspace = join(home, "workspace", "demo");
  await mkdir(workspace, { recursive: true });

  const { getAdapter } = await import("../dist/adapters/registry.js");
  const { bridgeSessionBetweenBackends } = await import("../dist/api.js");

  const codex = await getAdapter("codex");
  const opencode = await getAdapter("opencode");
  const entries = fixtureEntries(workspace);

  await t.test("codex -> opencode", async () => {
    const codexId = await codex.write(entries, workspace);
    const sourceSession = await codex.findSession(codexId);
    assert.ok(sourceSession);
    const sourceEntries = await codex.read(sourceSession);

    const result = await bridgeSessionBetweenBackends({
      sourceTool: "codex",
      sourceSessionId: codexId,
      targetTool: "opencode",
      targetCwdFallback: workspace,
      irRootDir: join(home, ".ai-bridge", "sessions"),
    });

    assert.equal(result.cwd, workspace);
    await stat(result.irPath);

    const targetSession = await opencode.findSession(result.sessionId);
    assert.ok(targetSession);
    const targetEntries = await opencode.read(targetSession);

    assert.deepEqual(normalizeEntries(targetEntries), normalizeEntries(sourceEntries));
  });

  await t.test("opencode -> codex", async () => {
    const opencodeId = await opencode.write(entries, workspace);
    const sourceSession = await opencode.findSession(opencodeId);
    assert.ok(sourceSession);
    const sourceEntries = await opencode.read(sourceSession);

    const result = await bridgeSessionBetweenBackends({
      sourceTool: "opencode",
      sourceSessionId: opencodeId,
      targetTool: "codex",
      targetCwdFallback: workspace,
      irRootDir: join(home, ".ai-bridge", "sessions"),
    });

    assert.equal(result.cwd, workspace);
    await stat(result.irPath);

    const targetSession = await codex.findSession(result.sessionId);
    assert.ok(targetSession);
    const targetEntries = await codex.read(targetSession);

    assert.deepEqual(normalizeEntries(targetEntries), normalizeEntries(sourceEntries));
  });

  await t.test("opencode sqlite-backed sessions are discoverable and readable", async () => {
    const sqliteSessionId = createOpenCodeDbFixture(home, workspace);

    const sessions = await opencode.listSessions();
    assert.ok(sessions.some((session) => session.sessionId === sqliteSessionId));

    const sourceSession = await opencode.findSession(sqliteSessionId);
    assert.ok(sourceSession);
    assert.equal(sourceSession.path, join(home, ".local", "share", "opencode", "opencode.db"));

    const sourceEntries = await opencode.read(sourceSession);
    assert.deepEqual(normalizeEntries(sourceEntries), normalizeEntries(fixtureEntries(workspace)));
  });

  await t.test("legacy OpenCode versions still use JSON storage", async () => {
    process.env.AIBRIDGE_OPENCODE_VERSION = "1.1.31";
    delete process.env.AIBRIDGE_OPENCODE_STORAGE_MODE;

    const legacySessionId = await opencode.write(entries, workspace);
    const sourceSession = await opencode.findSession(legacySessionId);
    assert.ok(sourceSession);
    assert.notEqual(sourceSession.path, join(home, ".local", "share", "opencode", "opencode.db"));

    const sourceEntries = await opencode.read(sourceSession);
    assert.deepEqual(normalizeEntries(sourceEntries), normalizeEntries(fixtureEntries(workspace)));
  });
});
