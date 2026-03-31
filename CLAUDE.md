# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claw (`@z-zawhtet-a/claw`) is an MCP server that extends AI agents' tools (bash, read, write, edit, grep, glob, ls) to any machine reachable over SSH. It runs locally, connects to remote hosts using existing SSH keys, and auto-deploys a small Go binary ("pincer") for remote execution.

## Development Commands

```bash
npm install              # Install dependencies
npm run build            # Build TypeScript with tsup → dist/
npm run dev              # Watch mode (rebuilds on change)
npm run typecheck        # Type-check without emitting (tsc --noEmit)
npm run build-pincer     # Cross-compile pincer Go binary (requires Go 1.22+)
```

No test framework is configured. No linter is configured. TypeScript strict mode is the primary quality gate.

## Architecture

### Two-component system

1. **TypeScript MCP server** (`src/`) — runs locally, speaks MCP over stdio to AI agents
2. **Go binary "pincer"** (`pincer/`) — deployed to remote hosts on first SSH connect, speaks JSON-RPC over stdin/stdout, executes tools remotely

### Request flow

```
Agent → MCP stdio → createServer() → Router → Transport → Tool execution
                                                 ├── LocalTransport (direct tool calls)
                                                 └── SSHTransport (JSON-RPC to pincer over SSH)
```

### Key modules

| Module | Role |
|--------|------|
| `src/server/index.ts` | MCP server factory, single `claw()` tool definition, command dispatch |
| `src/server/router.ts` | Maps host names to transports, caches connections, dispatches `execute()` calls |
| `src/server/parser.ts` | Parses CLI-style command strings (`"bash host=prod"`) into structured params |
| `src/tools/` | 7 local tool implementations (bash, read, write, edit, grep, glob, ls) |
| `src/transports/interface.ts` | `Transport` interface: `execute()`, optional `connect()`/`disconnect()` |
| `src/transports/ssh.ts` | SSH transport using ssh2, JSON-RPC over stdin/stdout to pincer |
| `src/transports/pool.ts` | Persistent SSH connection pooling |
| `src/transports/deployer.ts` | Auto-deploys pincer binary to remote hosts |
| `src/config/loader.ts` | Merges global (`~/.config/claw/machines.yaml`) + project (`claw.yaml`) configs |
| `src/config/ssh-parser.ts` | Imports machines from `~/.ssh/config` |
| `src/cli/` | CLI commands via Commander.js: serve, init, add, install |
| `pincer/main.go` | Remote JSON-RPC server; `pincer/tools/` mirrors `src/tools/` in Go |

### Single-tool MCP interface

All operations go through one MCP tool: `claw(command, stdin?)`. The `command` string is parsed CLI-style (e.g., `"bash host=prod"`, `"read host=m path=/etc/hosts"`). This is intentional — it reduces tool proliferation for agents.

### Build output

tsup bundles to `dist/` with ESM format, targeting Node.js 20+. Two entry points: `bin/claw.ts` (CLI) and `src/index.ts` (library exports).

## Configuration

- **Global**: `~/.config/claw/machines.yaml`
- **Project**: `claw.yaml` in project root
- **Audit logs**: `~/.config/claw/logs/`

Project config overrides global. Both use the same YAML schema with a `machines:` map.

## Release process

Releases are triggered by pushing a `v*` tag. GitHub Actions cross-compiles pincer, creates a GitHub release with binaries, and publishes to npm via OIDC trusted publishing. Version bumps are handled by `scripts/release.sh`.
