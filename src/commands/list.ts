import type { ToolName, SessionInfo } from "../types.js";
import { getAdapter, listSupportedTools } from "../adapters/registry.js";

export async function listCommand(toolName?: string): Promise<void> {
  const supported = await listSupportedTools();
  if (supported.length === 0) {
    console.log("No adapters discovered.");
    return;
  }

  const selectedTool = parseToolName(toolName, supported);
  const tools: ToolName[] = selectedTool ? [selectedTool] : [...supported];

  if (toolName && !selectedTool) {
    console.error(`Unknown tool: ${toolName}`);
    console.error(`Supported tools: ${supported.join(", ")}`);
    process.exit(1);
  }

  let totalCount = 0;

  for (const tool of tools) {
    const adapter = await getAdapter(tool);
    let sessions: SessionInfo[];
    try {
      sessions = await adapter.listSessions();
    } catch {
      if (!toolName) continue; // skip tools that aren't installed
      sessions = [];
    }

    if (sessions.length === 0) {
      if (toolName) {
        console.log(`No sessions found for ${tool}.`);
      }
      continue;
    }

    console.log(`\n  ${tool} (${sessions.length} sessions)`);
    console.log("  " + "─".repeat(60));

    // Sort by createdAt descending (newest first)
    sessions.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });

    for (const s of sessions.slice(0, 20)) {
      const sessionId = s.sessionId;
      const title = s.title ? truncate(s.title, 50) : "(untitled)";
      const date = s.createdAt
        ? new Date(s.createdAt).toLocaleDateString()
        : "";
      console.log(`  ${sessionId.padEnd(32)} ${title.padEnd(52)} ${date}`);
    }

    if (sessions.length > 20) {
      console.log(`  ... and ${sessions.length - 20} more`);
    }

    totalCount += sessions.length;
  }

  if (!toolName) {
    console.log(`\n  Total: ${totalCount} sessions across ${tools.length} tools\n`);
  } else {
    console.log();
  }
}

function parseToolName(toolName: string | undefined, supported: ToolName[]): ToolName | null {
  if (!toolName) return null;
  if (supported.includes(toolName)) return toolName;
  return null;
}

function truncate(s: string, max: number): string {
  // Remove newlines
  const clean = s.replace(/\n/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + "…";
}
