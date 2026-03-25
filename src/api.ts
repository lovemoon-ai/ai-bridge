import { homedir } from "node:os";
import { join } from "node:path";

import type { IREntry, SessionInfo, ToolName } from "./types.js";
import { getAdapter, listSupportedTools } from "./adapters/registry.js";
import { writeJsonl } from "./utils/fs.js";

export interface BridgeSessionBetweenBackendsParams {
  sourceTool: ToolName;
  sourceSessionId: string;
  sourceSessionPath?: string;
  sourceSessionInfo?: Partial<SessionInfo>;
  targetTool: ToolName;
  skipTools?: boolean;
  targetCwdFallback?: string;
  irRootDir?: string;
}

export interface BridgeSessionBetweenBackendsResult {
  sessionId: string;
  cwd: string;
  irPath: string;
  entryCount: number;
}

interface BridgeSessionBetweenBackendsDeps {
  getAdapter?: typeof getAdapter;
  listSupportedTools?: typeof listSupportedTools;
  writeJsonl?: typeof writeJsonl;
}

function normalizeOptionalString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function firstIrCwd(entries: IREntry[]): string {
  const sessionMeta = entries.find(
    (entry) => entry && typeof entry === "object" && entry.type === "session_meta",
  );
  return normalizeOptionalString(sessionMeta?.cwd);
}

function buildSourceSessionInfo(
  sourceTool: ToolName,
  sourceSessionId: string,
  sourceSessionPath: string,
  sourceSessionInfo?: Partial<SessionInfo>,
): Partial<SessionInfo> {
  const session: Partial<SessionInfo> = {
    tool: sourceTool,
    sessionId: sourceSessionId,
  };

  const normalizedPath =
    normalizeOptionalString(sourceSessionPath) ||
    normalizeOptionalString(sourceSessionInfo?.path);
  const normalizedTitle = normalizeOptionalString(sourceSessionInfo?.title);
  const normalizedCwd = normalizeOptionalString(sourceSessionInfo?.cwd);
  const normalizedModel = normalizeOptionalString(sourceSessionInfo?.model);
  const normalizedCreatedAt = normalizeOptionalString(sourceSessionInfo?.createdAt);

  if (normalizedPath) {
    session.path = normalizedPath;
  }
  if (normalizedTitle) {
    session.title = normalizedTitle;
  }
  if (normalizedCwd) {
    session.cwd = normalizedCwd;
  }
  if (normalizedModel) {
    session.model = normalizedModel;
  }
  if (normalizedCreatedAt) {
    session.createdAt = normalizedCreatedAt;
  }

  return session;
}

function mergeSourceSessionInfo(
  baseSession: SessionInfo,
  sourceSessionInfo: Partial<SessionInfo>,
): SessionInfo {
  return {
    ...baseSession,
    ...sourceSessionInfo,
    tool: baseSession.tool,
    sessionId: baseSession.sessionId,
    path: normalizeOptionalString(sourceSessionInfo.path) || baseSession.path,
  };
}

async function resolveSourceSession({
  sourceTool,
  sourceSessionId,
  sourceSessionPath,
  sourceSessionInfo,
}: Pick<
  BridgeSessionBetweenBackendsParams,
  "sourceTool" | "sourceSessionId" | "sourceSessionPath" | "sourceSessionInfo"
>,
deps: Required<Pick<BridgeSessionBetweenBackendsDeps, "getAdapter">> = {
  getAdapter,
},
): Promise<SessionInfo> {
  const { getAdapter: loadAdapter } = deps;
  const explicitSessionInfo = buildSourceSessionInfo(
    sourceTool,
    sourceSessionId,
    sourceSessionPath ?? "",
    sourceSessionInfo,
  );
  const explicitPath = normalizeOptionalString(explicitSessionInfo.path);
  const sourceAdapter = await loadAdapter(sourceTool);

  if (explicitPath) {
    try {
      const discoveredSession = await sourceAdapter.findSession(sourceSessionId);
      if (
        discoveredSession &&
        normalizeOptionalString(discoveredSession.path) === explicitPath
      ) {
        return mergeSourceSessionInfo(discoveredSession, explicitSessionInfo);
      }
    } catch {
      // Explicit sourceSessionPath takes precedence; discovery failure should not block it.
    }

    return {
      tool: sourceTool,
      sessionId: sourceSessionId,
      path: explicitPath,
      title: explicitSessionInfo.title,
      cwd: explicitSessionInfo.cwd,
      model: explicitSessionInfo.model,
      createdAt: explicitSessionInfo.createdAt,
    };
  }

  const discoveredSession = await sourceAdapter.findSession(sourceSessionId);
  if (discoveredSession) {
    return mergeSourceSessionInfo(discoveredSession, explicitSessionInfo);
  }

  throw new Error(`Source session not found: ${sourceTool}:${sourceSessionId}`);
}

export async function bridgeSessionBetweenBackends(
  params: BridgeSessionBetweenBackendsParams,
  deps: BridgeSessionBetweenBackendsDeps = {},
): Promise<BridgeSessionBetweenBackendsResult> {
  const loadAdapter = deps.getAdapter ?? getAdapter;
  const listTools = deps.listSupportedTools ?? listSupportedTools;
  const writeJsonlFn = deps.writeJsonl ?? writeJsonl;
  const sourceTool = normalizeOptionalString(params.sourceTool);
  const sourceSessionId = normalizeOptionalString(params.sourceSessionId);
  const targetTool = normalizeOptionalString(params.targetTool);
  const targetCwdFallback = normalizeOptionalString(params.targetCwdFallback);

  if (!sourceTool || !sourceSessionId || !targetTool) {
    throw new Error("sourceTool, sourceSessionId, and targetTool are required");
  }

  const supportedTools = await listTools();
  if (!supportedTools.includes(sourceTool)) {
    throw new Error(`Unsupported source tool: ${sourceTool}`);
  }
  if (!supportedTools.includes(targetTool)) {
    throw new Error(`Unsupported target tool: ${targetTool}`);
  }
  const sourceSession = await resolveSourceSession({
    sourceTool,
    sourceSessionId,
    sourceSessionPath: params.sourceSessionPath,
    sourceSessionInfo: params.sourceSessionInfo,
  }, {
    getAdapter: loadAdapter,
  });

  const sourceAdapter = await loadAdapter(sourceTool);
  let entries = await sourceAdapter.read(sourceSession);
  if (params.skipTools) {
    entries = entries.filter((entry) => entry.type !== "tool_call" && entry.type !== "tool_result");
  }

  const targetCwd =
    normalizeOptionalString(sourceSession.cwd) ||
    firstIrCwd(entries) ||
    targetCwdFallback;
  if (!targetCwd) {
    throw new Error(`Unable to determine target cwd for ${sourceTool}:${sourceSessionId}`);
  }

  const irRootDir = normalizeOptionalString(params.irRootDir) || join(homedir(), ".ai-bridge", "sessions");
  const irPath = join(irRootDir, `${sourceTool}_${sourceSession.sessionId}.jsonl`);
  await writeJsonlFn(irPath, entries);

  const targetAdapter = await loadAdapter(targetTool);
  const sessionId = await targetAdapter.write(entries, targetCwd);

  return {
    sessionId,
    cwd: targetCwd,
    irPath,
    entryCount: entries.length,
  };
}
