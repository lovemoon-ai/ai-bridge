#!/usr/bin/env node

import { Command } from "commander";
import { bridgeCommand } from "./commands/bridge.js";
import { listCommand } from "./commands/list.js";
import { updateCommand } from "./commands/update.js";
import { listSupportedTools } from "./adapters/registry.js";

const program = new Command();

program
  .name("ai-bridge")
  .description("Cross-AI-Tool Session Sharing CLI")
  .version("0.1.0");

// ── Main bridge command ─────────────────────────────────────
program
  .option("--from <tool:session_id>", "source tool and session ID")
  .option("--to <tool>", "target tool name")
  .option("--list-backend", "list supported backends", false)
  .option("--list-session [tool]", "list sessions (optionally for a specific backend)")
  .option("--dry-run", "show what would happen without writing", false)
  .option("--verbose", "enable verbose output", false)
  .option("--skip-tools", "skip tool calls and results in the target session", false)
  .action(async (opts) => {
    if (opts.listBackend) {
      const tools = await listSupportedTools();
      console.log("\n  Supported backends:");
      for (const tool of tools) {
        console.log(`  - ${tool}`);
      }
      console.log();
      return;
    }

    if (opts.listSession !== undefined) {
      const tool = typeof opts.listSession === "string" ? opts.listSession : undefined;
      await listCommand(tool);
      return;
    }

    if (opts.from && opts.to) {
      await bridgeCommand(opts.from, opts.to, {
        dryRun: opts.dryRun,
        verbose: opts.verbose,
        skipTools: opts.skipTools,
      });
    } else if (opts.from || opts.to) {
      console.error("Both --from and --to are required.");
      process.exit(1);
    } else {
      program.help();
    }
  });

// ── Update command ──────────────────────────────────────────
program
  .command("update")
  .description("Check for and install updates to ai-bridge")
  .option("-f, --force", "force update even if already on latest version", false)
  .option("-y, --yes", "skip confirmation prompt", false)
  .action(async (opts) => {
    await updateCommand(opts.force, opts.yes);
  });

program.parse();
