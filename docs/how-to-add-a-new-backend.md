# How To Add A New Backend

## 1) AI Bridge Architecture Overview

The core goal of `ai-bridge` is to unify different AI tool session formats into an Intermediate Representation (IR), then write to the target tool format, enabling cross-tool session migration.

Core workflow:

1. CLI entry parses arguments (`--from`, `--to`, `--list-backend`, `--list-session`).
2. Find the source adapter based on `--from <tool:session_id>`.
3. Source adapter reads the original session and converts to IR (`read()`).
4. Save IR to `~/.ai-bridge/sessions/*.jsonl` (auditable, replayable).
5. Target adapter writes IR to the target tool session format (`write()`).
6. Generate and execute target tool resume command (`getResumeCommand()`).

Key code locations:

- CLI entry: [src/index.ts](../src/index.ts)
- Main bridge logic: [src/commands/bridge.ts](../src/commands/bridge.ts)
- Session list command: [src/commands/list.ts](../src/commands/list.ts)
- Common types and IR definitions: [src/types.ts](../src/types.ts)

## 2) Modular Organization and Dynamic Registration

Directory structure (core):

- `src/adapters/<backend>/reader.ts`: Backend entry point (required)
- `src/adapters/<backend>/writer.ts`: Write logic (optional, usually split out)
- `src/adapters/<backend>/utils.ts`: Path and format helper functions (optional)
- `src/adapters/registry.ts`: Dynamic scanning and registration of adapters
- `src/utils/*`: General utilities for files, IDs, spawn, etc.

Dynamic loading mechanism (current implementation):

1. `registry.ts` scans all subdirectories under `adapters`.
2. Each subdirectory attempts to load `reader.js` (runtime) or `reader.ts` (dev).
3. Automatically iterate over exported classes from the module, instantiate and check if it satisfies the `ToolAdapter` shape.
4. Register using the instance's `name` field as the backend name.
5. CLI backend validation and `--list-backend` come from runtime registration results.

Therefore:

- No need to hardcode backend names in `registry.ts`.
- No need to maintain fixed backend enum in `types.ts`.
- Principle: "One adapter folder = one discoverable backend (as long as `reader.ts` correctly exports adapter class)".

Currently supported backends (run `node ./dist/index.js --list-backend` for authoritative list):

- `claude`
- `codex`
- `copilot`
- `kimi`
- `opencode`

## 3) Steps to Add a New Backend

Below is an example of adding `mybackend`.

### Step 1. Create Directory

Create a new directory under `src/adapters`:

```bash
mkdir -p src/adapters/mybackend
```

### Step 2. Implement `reader.ts` and Export Adapter

At minimum, implement and export a class satisfying the `ToolAdapter` interface:

```ts
// src/adapters/mybackend/reader.ts
import type { ToolAdapter, SessionInfo, IREntry } from "../../types.js";

export class MyBackendAdapter implements ToolAdapter {
  readonly name = "mybackend";

  async listSessions(): Promise<SessionInfo[]> {
    return [];
  }

  async findSession(sessionId: string): Promise<SessionInfo | null> {
    const sessions = await this.listSessions();
    return sessions.find((s) => s.sessionId.startsWith(sessionId)) ?? null;
  }

  async read(session: SessionInfo): Promise<IREntry[]> {
    return [];
  }

  async write(entries: IREntry[], targetCwd: string): Promise<string> {
    return "new-session-id";
  }

  getResumeCommand(sessionId: string): { command: string; args: string[] } {
    return { command: "mybackend", args: ["--resume", sessionId] };
  }
}
```

Notes:

- `name` must be unique; duplicate names will error at registration.
- `reader.ts` must actually export a class (default function won't work).
- Constructor should not perform heavy operations that could fail, otherwise scanning will skip or error.

### Step 3. (Recommended) Split writer/utils

Split complex logic out to keep `reader.ts` focused on adapter assembly:

- `writer.ts`: Implement target format serialization and disk writes
- `utils.ts`: Directory paths, ID matching, field conversion

### Step 4. Build

```bash
npm run build
```

Current `build` uses `tsc`, which compiles `src/adapters/<backend>/reader.ts` to `dist/adapters/<backend>/reader.js` for dynamic loading.

### Step 5. Verify Registration and Read/Write Chain

```bash
node ./dist/index.js --list-backend
node ./dist/index.js --list-session mybackend
node ./dist/index.js --from mybackend:<session-id-prefix> --to codex --dry-run
```

To verify writing:

```bash
node ./dist/index.js --from mybackend:<session-id-prefix> --to codex
```

## 4) FAQ

### Q1: New backend doesn't appear in `--list-backend`

Common causes:

- `src/adapters/mybackend/reader.ts` doesn't exist.
- `reader.ts` doesn't export an adapter class.
- Adapter class instance doesn't satisfy `ToolAdapter` shape (missing methods or `name` not a string).
- Constructor throws exception causing scan to fail.
- Haven't run `npm run build`, so corresponding `reader.js` doesn't exist in `dist`.

### Q2: Getting `Duplicate adapter name`

Two different adapters exported the same `name`. Change the new backend's `name` to a unique value.

### Q3: `Unknown tool: xxx` but I've added the directory

Confirm:

1. `npm run build` was executed successfully.
2. `dist/adapters/<backend>/reader.js` exists.
3. The `name` from the exported class in `reader.ts` exactly matches the CLI argument.

### Q4: `--list-session mybackend` returns no data

Check `listSessions()` first:

- Is the path correct (user dir, cache dir, config dir)?
- Is the session file format parsing correct?
- Is the time field parseable (affects sorting but not display)?

### Q5: Bridge succeeds but nothing shows after resume

Check `write()` and `getResumeCommand()`:

- Is the target backend session file written to the correct directory?
- Does the generated session id match the id used in resume command?
- Are required metadata (cwd/title/model) written completely?

### Q6: I want one backend folder to register multiple names (aliases)

Currently supports exporting multiple adapter classes from same `reader.ts` (each class with its own `name`).  
But for maintainability, recommend "one backend name per directory" to avoid debugging difficulties.
