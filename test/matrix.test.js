import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeConversation(entries) {
  return entries
    .filter((entry) => entry.type !== "session_meta")
    .map((entry) => {
      switch (entry.type) {
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

function countBodyEntries(entries) {
  const counts = {};
  for (const entry of entries) {
    if (entry.type === "session_meta") continue;
    counts[entry.type] = (counts[entry.type] || 0) + 1;
  }
  return counts;
}

function asMultiset(items) {
  const map = new Map();
  for (const item of items.map((entry) => JSON.stringify(entry)).sort()) {
    map.set(item, (map.get(item) || 0) + 1);
  }
  return map;
}

function equalMultiset(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, count] of a) {
    if (b.get(key) !== count) return false;
  }
  return true;
}

test("matrix conversions across codex/claude/opencode/kimi", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ai-bridge-matrix-"));
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

  const tools = ["codex", "claude", "opencode", "kimi"];
  const adapters = Object.fromEntries(
    await Promise.all(tools.map(async (tool) => [tool, await getAdapter(tool)])),
  );
  const entries = fixtureEntries(workspace);

  const seeds = {};
  for (const tool of tools) {
    const sessionId = await adapters[tool].write(entries, workspace);
    const session = await adapters[tool].findSession(sessionId);
    assert.ok(session, `seed session not found for ${tool}:${sessionId}`);
    const sourceEntries = await adapters[tool].read(session);
    seeds[tool] = { sessionId, session, sourceEntries };
  }

  for (const sourceTool of tools) {
    for (const targetTool of tools) {
      if (sourceTool === targetTool) continue;

      await t.test(`${sourceTool} -> ${targetTool}`, async () => {
        const source = seeds[sourceTool];
        const result = await bridgeSessionBetweenBackends({
          sourceTool,
          sourceSessionId: source.sessionId,
          sourceSessionPath: source.session.path,
          sourceSessionInfo: source.session,
          targetTool,
          targetCwdFallback: workspace,
          irRootDir: join(home, ".ai-bridge", "sessions"),
        });

        const targetSession = await adapters[targetTool].findSession(result.sessionId);
        assert.ok(targetSession, `target session not found for ${sourceTool}->${targetTool}`);

        const targetEntries = await adapters[targetTool].read(targetSession);
        const sourceBody = normalizeConversation(source.sourceEntries);
        const targetBody = normalizeConversation(targetEntries);

        assert.deepEqual(
          countBodyEntries(targetEntries),
          countBodyEntries(source.sourceEntries),
          `body entry counts differ for ${sourceTool}->${targetTool}`,
        );

        assert.ok(
          equalMultiset(asMultiset(sourceBody), asMultiset(targetBody)),
          `conversation multiset differs for ${sourceTool}->${targetTool}`,
        );

        assert.deepEqual(
          targetBody,
          sourceBody,
          `conversation order differs for ${sourceTool}->${targetTool}`,
        );
      });
    }
  }
});
