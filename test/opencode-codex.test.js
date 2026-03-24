import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
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

test("opencode and codex bridge both directions", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ai-bridge-opencode-"));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  process.env.HOME = home;
  delete process.env.XDG_DATA_HOME;

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
});
