import type { ToolName } from "../types.js";
import { getAdapter, listSupportedTools } from "../adapters/registry.js";
import { spawnInteractive } from "../utils/spawn.js";
import { bridgeSessionBetweenBackends } from "../api.js";

export interface BridgeOptions {
  dryRun?: boolean;
  verbose?: boolean;
  skipTools?: boolean;
}

function parseToolName(input: string, supported: ToolName[]): ToolName | null {
  if (supported.includes(input)) return input;
  return null;
}

/** Parse "tool:session_id" format */
export function parseToolSession(
  input: string,
  supported: ToolName[],
): { tool: ToolName; sessionId: string } {
  const colonIdx = input.indexOf(":");
  if (colonIdx === -1) {
    console.error(`Invalid format: "${input}". Expected tool:session_id`);
    process.exit(1);
  }
  const toolRaw = input.slice(0, colonIdx);
  const tool = parseToolName(toolRaw, supported);
  const sessionId = input.slice(colonIdx + 1);

  if (!tool) {
    console.error(`Unknown tool: ${toolRaw}`);
    console.error(`Supported tools: ${supported.join(", ")}`);
    process.exit(1);
  }
  if (!sessionId) {
    console.error(`Missing session ID in: "${input}"`);
    process.exit(1);
  }
  return { tool, sessionId };
}

export async function bridgeCommand(
  from: string,
  to: string,
  opts: BridgeOptions,
): Promise<void> {
  const supported = await listSupportedTools();
  if (supported.length === 0) {
    console.error("No adapters discovered under src/adapters or dist/adapters.");
    process.exit(1);
  }

  const source = parseToolSession(from, supported);
  const targetTool = parseToolName(to, supported);

  if (!targetTool) {
    console.error(`Unknown target tool: ${to}`);
    console.error(`Supported tools: ${supported.join(", ")}`);
    process.exit(1);
  }

  const log = opts.verbose ? console.log : () => {};

  // ── Step 1: Find source session ──────────────────────────
  log(`[1/5] Finding ${source.tool} session: ${source.sessionId}`);
  const sourceAdapter = await getAdapter(source.tool);
  const session = await sourceAdapter.findSession(source.sessionId);
  if (!session) {
    console.error(`Session not found: ${source.tool}:${source.sessionId}`);
    console.error(`Try: ai-bridge --list-session ${source.tool}`);
    process.exit(1);
  }
  log(`  Found: ${session.sessionId} (${session.title || "untitled"})`);

  // ── Step 2: Read → IR ────────────────────────────────────
  log(`[2/5] Reading session from ${source.tool}...`);
  let entries = await sourceAdapter.read(session);
  log(`  Read ${entries.length} IR entries`);

  // ── Step 2.5: Filter tool calls if skipTools is enabled ───
  if (opts.skipTools) {
    const originalCount = entries.length;
    entries = entries.filter((e) => e.type !== "tool_call" && e.type !== "tool_result");
    const filteredCount = originalCount - entries.length;
    log(`  Filtered out ${filteredCount} tool-related entries (--skip-tools)`);
  }

  if (opts.dryRun) {
    const targetCwd = session.cwd || process.cwd();
    const irPath = `~/.ai-bridge/sessions/${source.tool}_${session.sessionId}.jsonl`;
    console.log("\n  Dry-run summary:");
    console.log(`  ─────────────────────────────────────`);
    console.log(`  Source:      ${source.tool}:${session.sessionId}`);
    console.log(`  Target:      ${targetTool}`);
    console.log(`  Title:       ${session.title || "(untitled)"}`);
    console.log(`  CWD:         ${targetCwd}`);
    console.log(`  IR entries:  ${entries.length}`);
    console.log(`  IR file:     ${irPath}`);

    const msgCount = entries.filter(
      (e) => e.type === "user_message" || e.type === "assistant_message",
    ).length;
    const toolCount = entries.filter((e) => e.type === "tool_call").length;
    console.log(`  Messages:    ${msgCount}`);
    console.log(`  Tool calls:  ${toolCount}`);

    const targetAdapter = await getAdapter(targetTool);
    const cmd = targetAdapter.getResumeCommand("<new-session-id>", targetCwd);
    console.log(`  Resume cmd:  ${cmd.command} ${cmd.args.join(" ")}`);
    console.log(`\n  No files written (dry-run mode).\n`);
    return;
  }

  log(`[3/5] Saving IR and writing session to ${targetTool}...`);
  const result = await bridgeSessionBetweenBackends({
    sourceTool: source.tool,
    sourceSessionId: session.sessionId,
    sourceSessionPath: session.path,
    sourceSessionInfo: session,
    targetTool,
    skipTools: opts.skipTools,
    targetCwdFallback: process.cwd(),
  });
  const targetAdapter = await getAdapter(targetTool);
  console.log(`\n  Session bridged successfully!`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Source:      ${source.tool}:${session.sessionId.slice(0, 8)}`);
  console.log(`  Target:      ${targetTool}:${result.sessionId.slice(0, 8)}`);
  console.log(`  IR file:     ${result.irPath}`);

  // ── Step 5: Spawn target tool ────────────────────────────
  const resumeCmd = targetAdapter.getResumeCommand(result.sessionId, result.cwd);
  console.log(`  Resume cmd:  ${resumeCmd.command} ${resumeCmd.args.join(" ")}\n`);

  log(`[5/5] Spawning ${targetTool}...`);
  await spawnInteractive(resumeCmd.command, resumeCmd.args);
}
