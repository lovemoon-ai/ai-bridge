import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

describe("Claude writer", () => {
  it("creates Claude resume state for bridged sessions", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ai-bridge-claude-home-"));
    const targetCwd = "/tmp/bridge-target";

    const script = `
      import { writeClaudeSession } from "./dist/adapters/claude/writer.js";

      const sessionId = await writeClaudeSession([
        {
          ir_version: "1",
          type: "session_meta",
          source_tool: "codex",
          source_session_id: "source-session-1",
          cwd: ${JSON.stringify(targetCwd)},
          created_at: "2026-03-25T00:00:00.000Z",
        },
        {
          type: "user_message",
          timestamp: "2026-03-25T00:00:01.000Z",
          content: "hello from codex",
        },
      ], ${JSON.stringify(targetCwd)});

      process.stdout.write(sessionId);
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

    const sessionId = result.stdout.trim();
    assert.match(sessionId, /^[0-9a-f-]{36}$/i);

    const projectDir = join(homeDir, ".claude", "projects", "-tmp-bridge-target");
    const sessionPath = join(projectDir, `${sessionId}.jsonl`);
    const indexPath = join(projectDir, "sessions-index.json");
    const taskDir = join(homeDir, ".claude", "tasks", sessionId);
    const sessionEnvDir = join(homeDir, ".claude", "session-env", sessionId);

    assert.equal(existsSync(sessionPath), true);
    assert.equal(existsSync(indexPath), true);
    assert.equal(existsSync(join(taskDir, ".lock")), true);
    assert.equal(existsSync(join(taskDir, ".highwatermark")), true);
    assert.equal(existsSync(sessionEnvDir), true);

    assert.equal(
      await readFile(join(taskDir, ".highwatermark"), "utf-8"),
      "0",
    );

    const index = JSON.parse(await readFile(indexPath, "utf-8"));
    const entry = index.entries.find((item) => item.sessionId === sessionId);
    assert.ok(entry);
    assert.equal(entry.projectPath, targetCwd);
  });
});
