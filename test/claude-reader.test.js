import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

describe("Claude reader", () => {
  it("finds sessions from jsonl files when sessions-index.json is missing", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ai-bridge-claude-reader-"));
    const projectDir = join(
      homeDir,
      ".claude",
      "projects",
      "-Users-duino-ws-agents",
    );
    const sessionId = "17a85cc9-9a8f-496c-8e34-21e219e96680";
    const sessionPath = join(projectDir, `${sessionId}.jsonl`);

    await mkdir(projectDir, { recursive: true });
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "user",
          sessionId,
          timestamp: "2026-03-25T08:06:14.595Z",
          cwd: "/Users/duino/ws/agents",
          message: {
            role: "user",
            content: "first prompt title\nmore details",
          },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId,
          timestamp: "2026-03-25T08:06:30.686Z",
          cwd: "/Users/duino/ws/agents",
          message: {
            role: "assistant",
            model: "claude-opus-4-6",
            content: [{ type: "text", text: "reply" }],
          },
        }),
        "",
      ].join("\n"),
      "utf-8",
    );

    const script = `
      import { ClaudeAdapter } from "./dist/adapters/claude/reader.js";

      const adapter = new ClaudeAdapter();
      const session = await adapter.findSession(${JSON.stringify(sessionId)});
      const sessions = await adapter.listSessions();

      process.stdout.write(JSON.stringify({ session, count: sessions.length }));
    `;

    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      cwd: "/Users/duino/ws/ai-session/ai-bridge",
      env: {
        ...process.env,
        HOME: homeDir,
      },
      encoding: "utf-8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);

    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.session);
    assert.equal(parsed.session.sessionId, sessionId);
    assert.equal(parsed.session.cwd, "/Users/duino/ws/agents");
    assert.equal(parsed.session.title, "first prompt title");
    assert.equal(parsed.session.model, "claude-opus-4-6");
    assert.equal(parsed.count, 1);
  });
});
