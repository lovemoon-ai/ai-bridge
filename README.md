# AI Bridge 🌉

>  Break down tool barriers, let your AI sessions flow freely.

AI Bridge lets you migrate session history between different AI coding tools. 

Halfway through a conversation in Claude and want to switch to Codex? No problem.

## ✨ Core Features

- **🔀 Seamless Migration** - Migrate sessions between Claude, Codex, Copilot, Kimi, Trae, and more
- **📦 Unified Format** - Intermediate Representation (IR) ensures no data loss
- **⚡ One-Click Resume** - Auto-generates resume commands for target tools
- **🔌 Plugin Architecture** - Easily extend with new backends

## 🚀 Quick Start

### Installation

```bash
npm install -g @love-moon/ai-bridge

# List supported backends
ai-bridge --list-backend

# Migrate session (example: from Claude to Codex)
ai-bridge --from claude:abc123 --to codex

# List sessions for a backend
ai-bridge --list-session claude
```

## 🛠️ Supported Backends

| Backend | Read | Write |
|---------|------|-------|
| Claude | ✅ | ✅ |
| Codex | ✅ | ✅ |
| Copilot | ✅ | ✅ |
| Kimi | ✅ | ✅ |

## 📖 Documentation

- [How to Add a New Backend](./docs/how-to-add-a-new-backend.md)

## 🏗️ Architecture

```
src/
├── adapters/          # AI tool adapters
│   ├── claude/
│   ├── codex/
│   ├── private/       # Private adapters
│   └── registry.ts    # Dynamic registration
├── commands/          # CLI commands
├── types.ts           # IR definitions
└── utils/             # Utilities
```

## 🔧 Development

```bash
# Dev mode
npm run dev -- --list-backend

# Build
npm run build
```

## 📝 Publishing

```bash
# Auto-increment patch version
./scripts/publish-npm.sh

# Or specify version
./scripts/publish-npm.sh 0.2.0
```
