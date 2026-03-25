import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { bridgeSessionBetweenBackends } from "../dist/api.js";

function createAdapter({
  name,
  findSession = async () => null,
  read = async () => [],
  write = async () => "target-session",
} = {}) {
  return {
    name,
    listSessions: async () => [],
    findSession,
    read,
    write,
    getResumeCommand: () => ({ command: name, args: [] }),
  };
}

function createDeps({ sourceAdapter, targetAdapter, writeJsonl } = {}) {
  return {
    listSupportedTools: async () => ["codex", "claude", "kimi"],
    getAdapter: async (tool) => {
      if (tool === sourceAdapter?.name) {
        return sourceAdapter;
      }
      if (tool === targetAdapter?.name) {
        return targetAdapter;
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
    writeJsonl: writeJsonl ?? (async () => {}),
  };
}

function createSameToolDeps({ tool, sourceAdapter, targetAdapter, writeJsonl } = {}) {
  let adapterCallCount = 0;

  return {
    listSupportedTools: async () => ["codex", "claude", "kimi"],
    getAdapter: async (requestedTool) => {
      if (requestedTool !== tool) {
        throw new Error(`unexpected tool: ${requestedTool}`);
      }

      adapterCallCount += 1;
      return adapterCallCount === 1 ? sourceAdapter : targetAdapter;
    },
    writeJsonl: writeJsonl ?? (async () => {}),
  };
}

describe("bridgeSessionBetweenBackends", () => {
  it("prefers an explicit sourceSessionPath over a discovered session path", async () => {
    let readSession = null;
    let targetWrite = null;

    const sourceAdapter = createAdapter({
      name: "codex",
      findSession: async () => ({
        tool: "codex",
        sessionId: "source-session-1",
        path: "/discovered/session.jsonl",
        cwd: "/discovered-cwd",
        title: "discovered title",
      }),
      read: async (session) => {
        readSession = session;
        return [
          {
            ir_version: "1",
            type: "session_meta",
            source_tool: "codex",
            source_session_id: session.sessionId,
            cwd: session.cwd ?? process.cwd(),
            title: session.title,
            created_at: "2024-01-01T00:00:00.000Z",
          },
        ];
      },
    });
    const targetAdapter = createAdapter({
      name: "claude",
      write: async (_entries, cwd) => {
        targetWrite = cwd;
        return "target-session-1";
      },
    });

    const result = await bridgeSessionBetweenBackends(
      {
        sourceTool: "codex",
        sourceSessionId: "source-session-1",
        sourceSessionPath: "/explicit/session.jsonl",
        sourceSessionInfo: {
          cwd: "/explicit-cwd",
          title: "explicit title",
        },
        targetTool: "claude",
        irRootDir: "/tmp/ai-bridge-tests",
      },
      createDeps({ sourceAdapter, targetAdapter }),
    );

    assert.equal(readSession.path, "/explicit/session.jsonl");
    assert.equal(readSession.cwd, "/explicit-cwd");
    assert.equal(readSession.title, "explicit title");
    assert.equal(targetWrite, "/explicit-cwd");
    assert.equal(result.cwd, "/explicit-cwd");
  });

  it("uses sourceSessionInfo.cwd when sourceSessionPath fallback would otherwise default to process.cwd()", async () => {
    let readSession = null;
    let targetWrite = null;

    const sourceAdapter = createAdapter({
      name: "kimi",
      findSession: async () => null,
      read: async (session) => {
        readSession = session;
        return [
          {
            ir_version: "1",
            type: "session_meta",
            source_tool: "kimi",
            source_session_id: session.sessionId,
            cwd: session.cwd ?? process.cwd(),
            created_at: "2024-01-02T00:00:00.000Z",
          },
        ];
      },
    });
    const targetAdapter = createAdapter({
      name: "claude",
      write: async (_entries, cwd) => {
        targetWrite = cwd;
        return "target-session-2";
      },
    });

    const result = await bridgeSessionBetweenBackends(
      {
        sourceTool: "kimi",
        sourceSessionId: "kimi-session-1",
        sourceSessionPath: "/explicit/kimi/context.jsonl",
        sourceSessionInfo: {
          cwd: "/preferred-kimi-cwd",
        },
        targetTool: "claude",
        irRootDir: "/tmp/ai-bridge-tests",
      },
      createDeps({ sourceAdapter, targetAdapter }),
    );

    assert.equal(readSession.path, "/explicit/kimi/context.jsonl");
    assert.equal(readSession.cwd, "/preferred-kimi-cwd");
    assert.equal(targetWrite, "/preferred-kimi-cwd");
    assert.equal(result.cwd, "/preferred-kimi-cwd");
  });

  it("keeps using explicit sourceSessionPath when findSession throws", async () => {
    let readSession = null;
    let targetWrite = null;

    const sourceAdapter = createAdapter({
      name: "codex",
      findSession: async () => {
        throw new Error("find exploded");
      },
      read: async (session) => {
        readSession = session;
        return [
          {
            ir_version: "1",
            type: "session_meta",
            source_tool: "codex",
            source_session_id: session.sessionId,
            cwd: session.cwd ?? process.cwd(),
            created_at: "2024-01-03T00:00:00.000Z",
          },
        ];
      },
    });
    const targetAdapter = createAdapter({
      name: "claude",
      write: async (_entries, cwd) => {
        targetWrite = cwd;
        return "target-session-3";
      },
    });

    const result = await bridgeSessionBetweenBackends(
      {
        sourceTool: "codex",
        sourceSessionId: "source-session-explicit",
        sourceSessionPath: "/explicit/fallback.jsonl",
        sourceSessionInfo: {
          cwd: "/explicit-fallback-cwd",
        },
        targetTool: "claude",
        irRootDir: "/tmp/ai-bridge-tests",
      },
      createDeps({ sourceAdapter, targetAdapter }),
    );

    assert.equal(readSession.path, "/explicit/fallback.jsonl");
    assert.equal(readSession.cwd, "/explicit-fallback-cwd");
    assert.equal(targetWrite, "/explicit-fallback-cwd");
    assert.equal(result.cwd, "/explicit-fallback-cwd");
  });

  it("rejects on API failure without process.exit or target-side effects", async () => {
    let writeJsonlCalls = 0;
    let targetWriteCalls = 0;
    let exitCalled = false;
    const originalExit = process.exit;

    const sourceAdapter = createAdapter({
      name: "codex",
      findSession: async () => ({
        tool: "codex",
        sessionId: "source-session-fail",
        path: "/discovered/fail.jsonl",
      }),
      read: async () => {
        throw new Error("read exploded");
      },
    });
    const targetAdapter = createAdapter({
      name: "claude",
      write: async () => {
        targetWriteCalls += 1;
        return "should-not-happen";
      },
    });

    process.exit = (() => {
      exitCalled = true;
      throw new Error("process.exit should not be called");
    });

    try {
      await assert.rejects(
        bridgeSessionBetweenBackends(
          {
            sourceTool: "codex",
            sourceSessionId: "source-session-fail",
            targetTool: "claude",
            irRootDir: "/tmp/ai-bridge-tests",
          },
          createDeps({
            sourceAdapter,
            targetAdapter,
            writeJsonl: async () => {
              writeJsonlCalls += 1;
            },
          }),
        ),
        /read exploded/,
      );
    } finally {
      process.exit = originalExit;
    }

    assert.equal(exitCalled, false);
    assert.equal(writeJsonlCalls, 0);
    assert.equal(targetWriteCalls, 0);
  });

  it("allows same-tool session cloning into a new target session", async () => {
    let targetWrite = null;

    const sourceAdapter = createAdapter({
      name: "codex",
      findSession: async () => ({
        tool: "codex",
        sessionId: "source-session-clone",
        path: "/discovered/source.jsonl",
        cwd: "/clone-cwd",
      }),
      read: async () => [
        {
          ir_version: "1",
          type: "session_meta",
          source_tool: "codex",
          source_session_id: "source-session-clone",
          cwd: "/clone-cwd",
          created_at: "2024-01-04T00:00:00.000Z",
        },
      ],
    });
    const targetAdapter = createAdapter({
      name: "codex",
      write: async (_entries, cwd) => {
        targetWrite = cwd;
        return "cloned-session-1";
      },
    });

    const result = await bridgeSessionBetweenBackends(
      {
        sourceTool: "codex",
        sourceSessionId: "source-session-clone",
        targetTool: "codex",
        irRootDir: "/tmp/ai-bridge-tests",
      },
      createSameToolDeps({ tool: "codex", sourceAdapter, targetAdapter }),
    );

    assert.equal(targetWrite, "/clone-cwd");
    assert.equal(result.sessionId, "cloned-session-1");
    assert.equal(result.cwd, "/clone-cwd");
  });
});
