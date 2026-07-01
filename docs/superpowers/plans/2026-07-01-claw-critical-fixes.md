# Claw Critical-Issue Remediation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the six critical security/correctness issues (C1–C6) found in the 2026-07-01 audit, plus two shared primitives they depend on.

**Architecture:** Each fix is small and independent, landing as its own commit. Two shared primitives land first/alongside: an atomic file-write helper (TypeScript) and a per-request panic-recovery wrapper (Go). Fixes apply the principle *fail closed*: on uncertainty, refuse rather than proceed.

**Tech Stack:** TypeScript (ESM, NodeNext, tsup→esbuild, Node 20+ target; dev machine is Node 24 / Go 1.26). Go 1.22 module for pincer. No test framework in the repo — verification uses `go test` (built-in) for Go and `esbuild`-bundled `scripts/verify/*.ts` scripts with `node:assert` for TypeScript (esbuild is already a dependency via tsup; no new packages).

Design spec: `docs/superpowers/specs/2026-07-01-claw-critical-fixes-design.md`.

## Global Constraints

- **Branch:** all work on `fix/critical-issues-remediation` (already created; the spec commit is its first commit).
- **Module system:** TypeScript imports use `.js` specifiers (NodeNext). New files follow this. esbuild resolves `.js`→`.ts` when bundling verify scripts.
- **No new runtime dependencies.** Dev-only verification reuses the already-installed `esbuild`.
- **TypeScript strict mode** is the primary quality gate — run `npm run typecheck` before each TS commit; it must pass clean.
- **Go module path:** `github.com/z-zawhtet-a/claw/pincer`. Run Go tests with `cd pincer && go test ./...`.
- **TS verify run command (template):** from repo root,
  `node_modules/.bin/esbuild scripts/verify/<name>.ts --bundle --platform=node --format=esm --outfile=/tmp/claw-verify.mjs && node /tmp/claw-verify.mjs`
  A passing script prints `PASS: ...` and exits 0; a failing assertion throws and exits non-zero.
- **Approved policy decisions:** C1 = accept-new + pin, with `CLAW_STRICT_HOST_KEY=1` forcing hard-reject of unknown hosts. C3 = package-only binary resolution by default; a CWD/dev binary is honored only when `CLAW_DEV=1`.
- **One commit per task.** Commit messages end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

### Task 1: Shared primitive P1 — `writeFileAtomic` (TypeScript)

**Files:**
- Create: `src/util/fs.ts`
- Test: `scripts/verify/atomic-write.ts`

**Interfaces:**
- Produces: `export function writeFileAtomic(filePath: string, data: string): void` — writes to a same-dir temp file (mode 0600), `fsync`s, then `rename`s over the target. Consumed by Task 6 (installer).

- [ ] **Step 1: Write the failing test**

Create `scripts/verify/atomic-write.ts`:

```ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../../src/util/fs.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-atomic-"));
const target = path.join(dir, "config.json");

writeFileAtomic(target, "hello");
assert.strictEqual(fs.readFileSync(target, "utf-8"), "hello");

writeFileAtomic(target, "world");
assert.strictEqual(fs.readFileSync(target, "utf-8"), "world");

const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
assert.deepStrictEqual(leftovers, [], `temp files left behind: ${leftovers}`);

console.log("PASS: writeFileAtomic (3 checks)");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/esbuild scripts/verify/atomic-write.ts --bundle --platform=node --format=esm --outfile=/tmp/claw-verify.mjs && node /tmp/claw-verify.mjs`
Expected: FAIL — esbuild error `Could not resolve "../../src/util/fs.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/util/fs.ts`:

```ts
import fs from "node:fs";
import path from "node:path";

/**
 * Write `data` to `filePath` atomically: write to a temp file in the same
 * directory, fsync it, then rename over the target. On POSIX the rename is
 * atomic, so a crash mid-write never truncates or corrupts an existing file.
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, data, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npm run typecheck && node_modules/.bin/esbuild scripts/verify/atomic-write.ts --bundle --platform=node --format=esm --outfile=/tmp/claw-verify.mjs && node /tmp/claw-verify.mjs`
Expected: typecheck clean; prints `PASS: writeFileAtomic (3 checks)`.

- [ ] **Step 5: Commit**

```bash
git add src/util/fs.ts scripts/verify/atomic-write.ts
git commit -m "feat: add writeFileAtomic helper (temp + fsync + rename)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: C5 — `edit` literal replacement (stop `$`-substitution corruption)

**Files:**
- Modify: `src/tools/edit.ts:28`
- Test: `scripts/verify/edit-literal.ts`

**Interfaces:**
- Consumes: `edit(params: { path: string; old_string: string; new_string: string }): Promise<{ content: string; isError?: boolean }>` (already exported).

- [ ] **Step 1: Write the failing test**

Create `scripts/verify/edit-literal.ts`:

```ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { edit } from "../../src/tools/edit.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-edit-"));
const file = path.join(dir, "script.sh");

fs.writeFileSync(file, "echo PLACEHOLDER\n");
const res = await edit({ path: file, old_string: "PLACEHOLDER", new_string: "pid=$$" });
assert.strictEqual(res.isError, undefined, `unexpected error: ${res.content}`);
assert.strictEqual(fs.readFileSync(file, "utf-8"), "echo pid=$$\n");

fs.writeFileSync(file, "X\n");
await edit({ path: file, old_string: "X", new_string: "a$&b" });
assert.strictEqual(fs.readFileSync(file, "utf-8"), "a$&b\n");

console.log("PASS: edit literal replacement (2 checks)");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/esbuild scripts/verify/edit-literal.ts --bundle --platform=node --format=esm --outfile=/tmp/claw-verify.mjs && node /tmp/claw-verify.mjs`
Expected: FAIL — first assertion mismatch, file contains `echo pid=$\n` (the `$$` collapsed by `String.prototype.replace`).

- [ ] **Step 3: Write minimal implementation**

In `src/tools/edit.ts`, replace line 28:

```ts
    const newContent = content.replace(params.old_string, params.new_string);
```

with an index splice (the earlier checks guarantee exactly one occurrence):

```ts
    const idx = content.indexOf(params.old_string);
    const newContent =
      content.slice(0, idx) +
      params.new_string +
      content.slice(idx + params.old_string.length);
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npm run typecheck && node_modules/.bin/esbuild scripts/verify/edit-literal.ts --bundle --platform=node --format=esm --outfile=/tmp/claw-verify.mjs && node /tmp/claw-verify.mjs`
Expected: typecheck clean; prints `PASS: edit literal replacement (2 checks)`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/edit.ts scripts/verify/edit-literal.ts
git commit -m "fix: edit uses literal splice, not String.replace (\$-substitution corruption)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: C6 (TS) — `read` rejects non-regular files

**Files:**
- Modify: `src/tools/read.ts` (after the `fs.stat` call, before the size check)
- Test: `scripts/verify/read-special.ts`

**Interfaces:**
- Consumes: `read(params: { path: string; offset?: number; limit?: number }): Promise<{ content: string; isError?: boolean }>` (already exported).

- [ ] **Step 1: Write the failing test**

Create `scripts/verify/read-special.ts`:

```ts
import assert from "node:assert";
import { read } from "../../src/tools/read.js";

// /dev/null is a size-0 character device: exactly the guard-bypass class
// (fs.stat reports size 0, so the 100MB guard passes). Reading it must be
// rejected, not silently treated as an empty regular file.
const res = await read({ path: "/dev/null" });
assert.strictEqual(res.isError, true, "expected /dev/null to be rejected");
assert.match(res.content, /not a regular file/);

console.log("PASS: read rejects non-regular files (1 check)");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/esbuild scripts/verify/read-special.ts --bundle --platform=node --format=esm --outfile=/tmp/claw-verify.mjs && node /tmp/claw-verify.mjs`
Expected: FAIL — `res.isError` is `undefined` (current code returns `{ content: "1\t" }` for `/dev/null`).

- [ ] **Step 3: Write minimal implementation**

In `src/tools/read.ts`, immediately after `const stat = await fs.stat(params.path);` (line 14) and before the `if (stat.size > MAX_FILE_SIZE)` block, insert:

```ts
    if (!stat.isFile()) {
      return {
        content: `Error: ${params.path} is not a regular file`,
        isError: true,
      };
    }
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npm run typecheck && node_modules/.bin/esbuild scripts/verify/read-special.ts --bundle --platform=node --format=esm --outfile=/tmp/claw-verify.mjs && node /tmp/claw-verify.mjs`
Expected: typecheck clean; prints `PASS: read rejects non-regular files (1 check)`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/read.ts scripts/verify/read-special.ts
git commit -m "fix: read rejects non-regular files (/dev/zero OOM/hang guard)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: C4 (P2) — pincer per-request panic recovery

**Files:**
- Modify: `pincer/rpc/server.go` (add `RecoverToResponse`; add `fmt` import)
- Modify: `pincer/main.go:44-48` (wrap `Dispatch` with `RecoverToResponse`)
- Test: `pincer/rpc/server_test.go`

**Interfaces:**
- Produces: `func RecoverToResponse(id int, fn func() *Response) *Response` — runs `fn`, converting any panic into an error `Response` for `id`. Used by `main.go`.

- [ ] **Step 1: Write the failing test**

Create `pincer/rpc/server_test.go`:

```go
package rpc

import "testing"

func TestRecoverToResponseCatchesPanic(t *testing.T) {
	resp := RecoverToResponse(7, func() *Response {
		panic("boom")
	})
	if resp == nil {
		t.Fatal("expected a response, got nil")
	}
	if !resp.IsError {
		t.Errorf("expected IsError=true, got false")
	}
	if resp.ID != 7 {
		t.Errorf("expected ID=7, got %d", resp.ID)
	}
}

func TestRecoverToResponsePassesThrough(t *testing.T) {
	want := &Response{ID: 3, Result: "ok"}
	got := RecoverToResponse(3, func() *Response { return want })
	if got != want {
		t.Errorf("expected pass-through of the returned response")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pincer && go test ./rpc/ -run TestRecover -v`
Expected: FAIL — compile error `undefined: RecoverToResponse`.

- [ ] **Step 3: Write minimal implementation**

In `pincer/rpc/server.go`, add `"fmt"` to the import block:

```go
import (
	"encoding/json"
	"fmt"

	"github.com/z-zawhtet-a/claw/pincer/tools"
)
```

Add this function (e.g. just below `ErrorResponse`):

```go
// RecoverToResponse runs fn and converts any panic into an error Response for
// id, so one bad request can never crash the server or drop other in-flight
// requests sharing the process.
func RecoverToResponse(id int, fn func() *Response) (resp *Response) {
	defer func() {
		if r := recover(); r != nil {
			resp = ErrorResponse(id, fmt.Sprintf("internal error: %v", r))
		}
	}()
	return fn()
}
```

In `pincer/main.go`, replace the goroutine body (lines 44-48):

```go
		go func(r rpc.Request) {
			defer wg.Done()
			resp := rpc.Dispatch(&r)
			writeResponse(resp)
		}(req)
```

with:

```go
		go func(r rpc.Request) {
			defer wg.Done()
			resp := rpc.RecoverToResponse(r.ID, func() *rpc.Response {
				return rpc.Dispatch(&r)
			})
			writeResponse(resp)
		}(req)
```

- [ ] **Step 4: Run test + build to verify pass**

Run: `cd pincer && go build ./... && go test ./rpc/ -run TestRecover -v`
Expected: build succeeds; both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add pincer/rpc/server.go pincer/main.go pincer/rpc/server_test.go
git commit -m "fix: pincer recovers per-request panics instead of crashing the server

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: C4 + C6 (Go) — `read.go` overflow guard and non-regular-file guard

**Files:**
- Modify: `pincer/tools/read.go` (overflow guard at the `end` clamp; `IsRegular` guard after `os.Stat`)
- Test: `pincer/tools/read_test.go`

**Interfaces:**
- Consumes: `func Read(p *ReadParams) (*Result, error)` (already defined). `ReadParams{ Path string; Offset *int; Limit *int }`.

- [ ] **Step 1: Write the failing test**

Create `pincer/tools/read_test.go`:

```go
package tools

import (
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestReadOffsetLimitOverflowDoesNotPanic(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(f, []byte("a\nb\nc\n"), 0644); err != nil {
		t.Fatal(err)
	}
	offset := 1
	limit := math.MaxInt // offset+limit overflows int64 → negative
	res, err := Read(&ReadParams{Path: f, Offset: &offset, Limit: &limit})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", res.Content)
	}
}

func TestReadRejectsNonRegularFile(t *testing.T) {
	dir := t.TempDir() // a directory is non-regular
	res, err := Read(&ReadParams{Path: dir})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected error for non-regular file, got: %s", res.Content)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pincer && go test ./tools/ -run TestRead -v`
Expected: FAIL — `TestReadOffsetLimitOverflowDoesNotPanic` panics with `slice bounds out of range` (negative `end`).

- [ ] **Step 3: Write minimal implementation**

In `pincer/tools/read.go`, add the non-regular guard immediately after the `os.Stat` error check (after line 21, before the `info.Size()` check):

```go
	if !info.Mode().IsRegular() {
		return &Result{Content: "Error: " + p.Path + " is not a regular file", IsError: true}, nil
	}
```

Then fix the `end` clamp (lines 55-58) from:

```go
	end := offset + limit
	if end > len(lines) {
		end = len(lines)
	}
```

to:

```go
	end := offset + limit
	if end < offset || end > len(lines) { // end < offset catches integer overflow
		end = len(lines)
	}
```

- [ ] **Step 4: Run test + build to verify pass**

Run: `cd pincer && go build ./... && go test ./tools/ -run TestRead -v`
Expected: build succeeds; both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add pincer/tools/read.go pincer/tools/read_test.go
git commit -m "fix: pincer read guards int overflow and non-regular files

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: C2 — installer safe read-modify-write

**Files:**
- Modify: `src/cli/install.ts` (safe parse via `InstallAbort`, `.bak` backup, `writeFileAtomic`, export `installClaudeCode`/`installCursor`/`InstallAbort`)
- Test: `scripts/verify/install-safe.ts`

**Interfaces:**
- Consumes: `writeFileAtomic` from `../util/fs.js` (Task 1).
- Produces: `export class InstallAbort extends Error`; `export function installClaudeCode(): void`; `export function installCursor(): void`. `installClaudeCode` aborts (throws `InstallAbort`, no write) when `~/.claude.json` exists but is unparseable; the CLI action converts that to `exit(1)`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify/install-safe.ts`:

```ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "claw-install-"));
process.env.HOME = home; // os.homedir() honors $HOME on POSIX
const { installClaudeCode, InstallAbort } = await import("../../src/cli/install.js");
const cfg = path.join(home, ".claude.json");

// 1. preserves unrelated top-level keys and other mcpServers
fs.writeFileSync(
  cfg,
  JSON.stringify({ oauthAccount: { id: "keep-me" }, mcpServers: { other: { command: "x" } } }),
);
installClaudeCode();
const parsed = JSON.parse(fs.readFileSync(cfg, "utf-8"));
assert.strictEqual(parsed.oauthAccount.id, "keep-me", "lost unrelated top-level key");
assert.ok(parsed.mcpServers.other, "lost pre-existing mcp server");
assert.ok(parsed.mcpServers.claw, "did not add claw server");

// 2. refuses to overwrite a corrupt/unparseable file
fs.writeFileSync(cfg, "{ this is not json ");
assert.throws(() => installClaudeCode(), InstallAbort);
assert.strictEqual(
  fs.readFileSync(cfg, "utf-8"),
  "{ this is not json ",
  "corrupt file must be left untouched",
);

console.log("PASS: installer safe read-modify-write (5 checks)");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/esbuild scripts/verify/install-safe.ts --bundle --platform=node --format=esm --outfile=/tmp/claw-verify.mjs && node /tmp/claw-verify.mjs`
Expected: FAIL — `installClaudeCode`/`InstallAbort` are not exported (bundle references undefined) — current code neither exports them nor guards the corrupt case.

- [ ] **Step 3: Write minimal implementation**

Rewrite `src/cli/install.ts` to:

```ts
import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeFileAtomic } from "../util/fs.js";

export class InstallAbort extends Error {}

function getMcpConfig(): { command: string; args: string[] } {
  // process.argv[1] is the currently running claw CLI script (dist/bin/claw.js)
  const clawBin = path.resolve(process.argv[1]);
  return {
    command: "node",
    args: [clawBin, "serve"],
  };
}

// Read + parse an existing JSON config. Missing file → fresh {}. A file that
// exists but does not parse → abort (never overwrite something we can't read).
function loadJsonConfig(configPath: string): any {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw new InstallAbort(`Cannot read ${configPath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new InstallAbort(
      `Refusing to overwrite ${configPath}: it exists but is not valid JSON. Fix or remove it first.`,
    );
  }
}

function backup(configPath: string): void {
  if (fs.existsSync(configPath)) {
    try {
      fs.copyFileSync(configPath, configPath + ".bak");
    } catch {
      // best-effort backup
    }
  }
}

export function registerInstall(program: Command): void {
  program
    .command("install <target>")
    .description("Install Claw into an AI agent's MCP config")
    .action((target: string) => {
      try {
        switch (target) {
          case "claude-code":
            installClaudeCode();
            break;
          case "cursor":
            installCursor();
            break;
          default:
            console.error(
              `Unknown target: "${target}". Supported: claude-code, cursor`,
            );
            process.exit(1);
        }
      } catch (err) {
        if (err instanceof InstallAbort) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      }
    });
}

export function installClaudeCode(): void {
  const configPath = path.join(os.homedir(), ".claude.json");
  const config = loadJsonConfig(configPath);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.claw = { type: "stdio", ...getMcpConfig() };
  backup(configPath);
  writeFileAtomic(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`Installed Claw MCP server into ${configPath}`);
  console.log("Restart Claude Code to pick up the changes.");
}

export function installCursor(): void {
  const configPath = path.join(process.cwd(), ".cursor", "mcp.json");
  const config = loadJsonConfig(configPath);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.claw = getMcpConfig();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  backup(configPath);
  writeFileAtomic(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`Installed Claw MCP server into ${configPath}`);
  console.log("Restart Cursor to pick up the changes.");
}
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npm run typecheck && node_modules/.bin/esbuild scripts/verify/install-safe.ts --bundle --platform=node --format=esm --outfile=/tmp/claw-verify.mjs && node /tmp/claw-verify.mjs`
Expected: typecheck clean; prints `PASS: installer safe read-modify-write (5 checks)`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/install.ts scripts/verify/install-safe.ts
git commit -m "fix: installer never clobbers ~/.claude.json (safe parse + atomic write)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: C1 — host-key verification: fail-closed + hashed-host support

**Files:**
- Modify: `src/transports/pool.ts` (remove `interface KnownHost`, `knownHostsCache`, `loadKnownHosts`; add `matchKnownHost`, `sshKeyAlgo`, `pinHostKey`, helpers; rewrite `createHostVerifier`)
- Test: `scripts/verify/hostkey.ts`

**Interfaces:**
- Produces (exported for testing): `type HostMatch = "match" | "mismatch" | "unknown"`; `function matchKnownHost(lines: string[], host: string, port: number, receivedKeyB64: string): HostMatch`; `function sshKeyAlgo(key: Buffer): string`; `function pinHostKey(khPath: string, host: string, port: number, key: Buffer): void`.
- `createHostVerifier(host, port)` returns `(key: Buffer) => boolean` (unchanged signature; used by `getConnection` at `pool.ts:199`).

- [ ] **Step 1: Write the failing test**

Create `scripts/verify/hostkey.ts`:

```ts
import assert from "node:assert";
import crypto from "node:crypto";
import { matchKnownHost, sshKeyAlgo } from "../../src/transports/pool.js";

// Build a fake SSH key blob: uint32 len + "ssh-ed25519" + 32 body bytes.
function fakeKey(seed: number): Buffer {
  const algo = Buffer.from("ssh-ed25519", "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(algo.length, 0);
  return Buffer.concat([len, algo, Buffer.alloc(32, seed)]);
}

const keyA = fakeKey(1);
const keyB = fakeKey(2);
const aB64 = keyA.toString("base64");
const bB64 = keyB.toString("base64");

assert.strictEqual(sshKeyAlgo(keyA), "ssh-ed25519");

// plaintext entry
const plain = [`example.com ssh-ed25519 ${aB64}`];
assert.strictEqual(matchKnownHost(plain, "example.com", 22, aB64), "match");
assert.strictEqual(matchKnownHost(plain, "example.com", 22, bB64), "mismatch");
assert.strictEqual(matchKnownHost(plain, "other.com", 22, aB64), "unknown");

// hashed entry (|1|salt|hash) must be matched, not skipped
const salt = crypto.randomBytes(20);
const mac = crypto.createHmac("sha1", salt).update("h.example.com").digest();
const hashed = [`|1|${salt.toString("base64")}|${mac.toString("base64")} ssh-ed25519 ${aB64}`];
assert.strictEqual(matchKnownHost(hashed, "h.example.com", 22, aB64), "match");
assert.strictEqual(matchKnownHost(hashed, "h.example.com", 22, bB64), "mismatch");
assert.strictEqual(matchKnownHost(hashed, "nope.com", 22, aB64), "unknown");

// [host]:port form
const ported = [`[gw.example.com]:2222 ssh-ed25519 ${aB64}`];
assert.strictEqual(matchKnownHost(ported, "gw.example.com", 2222, aB64), "match");
assert.strictEqual(matchKnownHost(ported, "gw.example.com", 22, aB64), "unknown");

// @revoked key → hard reject even when the key matches
const rev = [`@revoked example.com ssh-ed25519 ${aB64}`];
assert.strictEqual(matchKnownHost(rev, "example.com", 22, aB64), "mismatch");

console.log("PASS: host-key matching (11 checks)");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/esbuild scripts/verify/hostkey.ts --bundle --platform=node --format=esm --outfile=/tmp/claw-verify.mjs && node /tmp/claw-verify.mjs`
Expected: FAIL — `matchKnownHost`/`sshKeyAlgo` are not exported (current `pool.ts` has neither).

- [ ] **Step 3: Write minimal implementation**

In `src/transports/pool.ts`, delete the current known-hosts machinery — `interface KnownHost` (lines 33-35), `let knownHostsCache` (line 37), the entire `loadKnownHosts` function (lines 39-80), and the entire `createHostVerifier` function (lines 82-118) — and replace them with:

```ts
export type HostMatch = "match" | "mismatch" | "unknown";

function hostLabel(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function hostPatternMatches(pattern: string, host: string, port: number): boolean {
  // Hashed entry: |1|<b64 salt>|<b64 hash>
  if (pattern.startsWith("|1|")) {
    const parts = pattern.split("|"); // ["", "1", salt, hash]
    if (parts.length !== 4) return false;
    const salt = Buffer.from(parts[2], "base64");
    const hash = Buffer.from(parts[3], "base64");
    const mac = crypto.createHmac("sha1", salt).update(hostLabel(host, port)).digest();
    return mac.length === hash.length && crypto.timingSafeEqual(mac, hash);
  }
  // Plaintext: bare host (implies port 22) or [host]:port
  const bracket = pattern.match(/^\[(.+)\]:(\d+)$/);
  if (bracket) {
    return bracket[1] === host && parseInt(bracket[2], 10) === port;
  }
  return pattern === host && port === 22;
}

/**
 * Classify a received host key against known_hosts lines.
 * - "match":    an unrevoked entry for this host has this exact key
 * - "mismatch": the host is known but the key differs, or the key is @revoked
 * - "unknown":  no entry references this host at all
 */
export function matchKnownHost(
  lines: string[],
  host: string,
  port: number,
  receivedKeyB64: string,
): HostMatch {
  let hostKnown = false;
  let validMatch = false;

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let revoked = false;
    if (line.startsWith("@")) {
      const sp = line.indexOf(" ");
      if (sp === -1) continue;
      const marker = line.slice(0, sp);
      if (marker === "@cert-authority") continue; // CA validation unsupported
      if (marker === "@revoked") revoked = true;
      line = line.slice(sp + 1).trim();
    }

    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const patterns = parts[0].split(",");
    const keyB64 = parts[2];

    let matchesHost = false;
    for (const pattern of patterns) {
      if (pattern.includes("*") || pattern.includes("?")) continue; // wildcards unsupported
      if (hostPatternMatches(pattern, host, port)) {
        matchesHost = true;
        break;
      }
    }
    if (!matchesHost) continue;

    hostKnown = true;
    if (keyB64 === receivedKeyB64) {
      if (revoked) return "mismatch"; // revoked key → hard reject
      validMatch = true;
    }
  }

  if (validMatch) return "match";
  return hostKnown ? "mismatch" : "unknown";
}

// The key algorithm name is the first length-prefixed string in the SSH key blob.
export function sshKeyAlgo(key: Buffer): string {
  const len = key.readUInt32BE(0);
  return key.subarray(4, 4 + len).toString("ascii");
}

// Append a new host key to known_hosts (accept-new / TOFU), creating ~/.ssh
// (0700) and the file (0600) if needed.
export function pinHostKey(
  khPath: string,
  host: string,
  port: number,
  key: Buffer,
): void {
  fs.mkdirSync(path.dirname(khPath), { recursive: true, mode: 0o700 });
  const line = `${hostLabel(host, port)} ${sshKeyAlgo(key)} ${key.toString("base64")}\n`;
  fs.appendFileSync(khPath, line, { mode: 0o600 });
}

function createHostVerifier(
  host: string,
  port: number,
): (key: Buffer) => boolean {
  return (key: Buffer): boolean => {
    const khPath = path.join(os.homedir(), ".ssh", "known_hosts");
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(khPath, "utf-8").split("\n");
    } catch {
      lines = [];
    }

    const receivedKeyB64 = key.toString("base64");
    const result = matchKnownHost(lines, host, port, receivedKeyB64);

    if (result === "match") return true;

    if (result === "mismatch") {
      process.stderr.write(
        `ERROR: Host key verification failed for "${host}:${port}". ` +
          `The host key has changed or is revoked — possible man-in-the-middle attack. ` +
          `Update ${khPath} if this change is expected.\n`,
      );
      return false;
    }

    // result === "unknown"
    const fingerprint = crypto.createHash("sha256").update(key).digest("base64");
    if (process.env.CLAW_STRICT_HOST_KEY) {
      process.stderr.write(
        `ERROR: host "${host}:${port}" is not in ${khPath} and CLAW_STRICT_HOST_KEY is set ` +
          `(fingerprint SHA256:${fingerprint}). Refusing to connect.\n`,
      );
      return false;
    }
    try {
      pinHostKey(khPath, host, port, key);
      process.stderr.write(
        `Pinned new host key for "${host}:${port}" to ${khPath} (SHA256:${fingerprint}).\n`,
      );
      return true;
    } catch (err: any) {
      process.stderr.write(
        `Failed to pin host key for "${host}:${port}": ${err.message}\n`,
      );
      return false; // fail closed if we cannot record the key
    }
  };
}
```

(The `crypto`, `fs`, `os`, and `path` imports already exist at the top of `pool.ts`.)

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npm run typecheck && node_modules/.bin/esbuild scripts/verify/hostkey.ts --bundle --platform=node --format=esm --outfile=/tmp/claw-verify.mjs && node /tmp/claw-verify.mjs`
Expected: typecheck clean; prints `PASS: host-key matching (11 checks)`.

- [ ] **Step 5: Commit**

```bash
git add src/transports/pool.ts scripts/verify/hostkey.ts
git commit -m "fix: host-key verification fails closed + supports hashed known_hosts

Unknown host -> accept-new + pin (CLAW_STRICT_HOST_KEY=1 to hard-reject);
hashed |1| entries now matched via HMAC-SHA1; revoked keys rejected.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: C3 — deploy integrity: fail-closed + no CWD binary trust

**Files:**
- Modify: `src/transports/deployer.ts` (lock down `getLocalDevPath` + export it; fail-closed in `downloadPincer`; atomic remote upload + hash verify in `ensurePincer`)
- Test: `scripts/verify/devpath.ts`

**Interfaces:**
- Produces (exported for testing): `function getLocalDevPath(goArch: string): string | null`.
- Consumes: existing `computeFileHash(filePath: string): string`, `getChecksumUrl()`, `execCommand`, `getSftp` in the same module.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify/devpath.ts`:

```ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLocalDevPath } from "../../src/transports/deployer.js";

// Simulate a malicious repo: a pincer-bin/ in the current working directory.
const evilRepo = fs.mkdtempSync(path.join(os.tmpdir(), "claw-evil-"));
fs.mkdirSync(path.join(evilRepo, "pincer-bin"));
const evilBin = path.join(evilRepo, "pincer-bin", "pincer-linux-amd64");
fs.writeFileSync(evilBin, "#!/bin/sh\necho pwned\n");

const origCwd = process.cwd();
process.chdir(evilRepo);
try {
  delete process.env.CLAW_DEV;
  assert.notStrictEqual(
    getLocalDevPath("amd64"),
    evilBin,
    "SECURITY: a CWD pincer-bin was trusted without CLAW_DEV",
  );

  process.env.CLAW_DEV = "1";
  assert.strictEqual(
    getLocalDevPath("amd64"),
    evilBin,
    "CLAW_DEV=1 should honor a CWD dev binary",
  );
} finally {
  process.chdir(origCwd);
  delete process.env.CLAW_DEV;
}

console.log("PASS: dev-binary lockdown (2 checks)");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/esbuild scripts/verify/devpath.ts --bundle --platform=node --format=esm --outfile=/tmp/claw-verify.mjs && node /tmp/claw-verify.mjs`
Expected: FAIL — `getLocalDevPath` is not exported, and the current implementation trusts `process.cwd()/pincer-bin` unconditionally.

- [ ] **Step 3: Write minimal implementation**

In `src/transports/deployer.ts`, replace `getLocalDevPath` (lines 58-75) with a package-bounded version that ignores the CWD unless `CLAW_DEV` is set:

```ts
export function getLocalDevPath(goArch: string): string | null {
  const binName = `pincer-linux-${goArch}`;
  const candidates: string[] = [];

  // Trust only a binary bundled inside claw's own package tree — resolve
  // relative to THIS module and walk up to the package root. Never scan the
  // current working directory (an untrusted repo could plant a binary there).
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 4; i++) {
    candidates.push(path.join(dir, "pincer-bin", binName));
    dir = path.dirname(dir);
  }

  // Explicit dev mode additionally trusts a locally-built binary in the CWD.
  if (process.env.CLAW_DEV) {
    candidates.unshift(path.join(process.cwd(), "pincer-bin", binName));
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
```

In `downloadPincer`, make integrity **fail-closed**. Replace the current block (lines 96-106):

```ts
  // Verify integrity if checksums are available
  const expectedHash = await fetchExpectedChecksum(goArch);
  if (expectedHash) {
    const actualHash = computeFileHash(tmpPath);
    if (actualHash !== expectedHash) {
      fs.unlinkSync(tmpPath);
      throw new Error(
        `Pincer binary integrity check failed.\nExpected: ${expectedHash}\nActual:   ${actualHash}\nThe downloaded binary may be corrupted or tampered with.`,
      );
    }
  }
```

with:

```ts
  // Verify integrity — fail closed if we cannot obtain a checksum.
  const expectedHash = await fetchExpectedChecksum(goArch);
  if (!expectedHash) {
    fs.unlinkSync(tmpPath);
    throw new Error(
      `Refusing to deploy pincer: no verified checksum available from ${getChecksumUrl()}. ` +
        `The release must publish checksums.txt.`,
    );
  }
  const actualHash = computeFileHash(tmpPath);
  if (actualHash !== expectedHash) {
    fs.unlinkSync(tmpPath);
    throw new Error(
      `Pincer binary integrity check failed.\nExpected: ${expectedHash}\nActual:   ${actualHash}\nThe downloaded binary may be corrupted or tampered with.`,
    );
  }
```

In `ensurePincer`, make the remote upload atomic and verify the remote hash. Replace the SFTP block + `chmod` (lines 209-224):

```ts
  // Upload binary via SFTP
  const sftp = await getSftp(conn);

  try {
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remoteBinaryPath, (err) => {
        if (err) reject(new Error(`SFTP upload failed: ${err.message}`));
        else resolve();
      });
    });
  } finally {
    sftp.end();
  }

  // Make executable
  await execCommand(conn, `chmod +x ${remoteBinaryPath}`);

  return remoteBinaryPath;
```

with:

```ts
  // Upload to a temp path, then atomically move into place on the remote.
  const remoteTmp = `${remoteBinaryPath}.tmp`;
  const sftp = await getSftp(conn);

  try {
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remoteTmp, (err) => {
        if (err) reject(new Error(`SFTP upload failed: ${err.message}`));
        else resolve();
      });
    });
  } finally {
    sftp.end();
  }

  await execCommand(conn, `mv -f ${remoteTmp} ${remoteBinaryPath} && chmod +x ${remoteBinaryPath}`);

  // Verify the uploaded binary matches what we sent (detect truncation/tamper).
  const localHash = computeFileHash(localPath);
  const remoteHashOut = await execCommand(
    conn,
    `sha256sum ${remoteBinaryPath} 2>/dev/null || shasum -a 256 ${remoteBinaryPath}`,
  );
  const remoteHash = remoteHashOut.trim().split(/\s+/)[0];
  if (remoteHash !== localHash) {
    throw new Error(
      `Remote pincer hash mismatch after upload (expected ${localHash}, got ${remoteHash}).`,
    );
  }

  return remoteBinaryPath;
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npm run typecheck && node_modules/.bin/esbuild scripts/verify/devpath.ts --bundle --platform=node --format=esm --outfile=/tmp/claw-verify.mjs && node /tmp/claw-verify.mjs`
Expected: typecheck clean; prints `PASS: dev-binary lockdown (2 checks)`.

Note: the download fail-closed and remote atomic-upload/verify paths require a real remote to exercise end-to-end; they are covered here by typecheck + review. The unit test covers the CWD-binary RCE vector, which is the critical part of C3.

- [ ] **Step 5: Commit**

```bash
git add src/transports/deployer.ts scripts/verify/devpath.ts
git commit -m "fix: deploy fails closed — no CWD binary trust, require checksum, verify remote

Package-only binary resolution by default (CWD honored only under CLAW_DEV=1);
refuse download when no checksum; atomic remote upload + sha256 verify.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Full regression sweep

**Files:** none (verification only).

- [ ] **Step 1: TypeScript typecheck**

Run: `npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 2: Build succeeds**

Run: `npm run build`
Expected: tsup completes, `dist/` regenerated, no errors.

- [ ] **Step 3: Go build + all Go tests**

Run: `cd pincer && go build ./... && go test ./...`
Expected: build clean; all tests PASS.

- [ ] **Step 4: Run every TS verify script**

Run each and confirm a `PASS:` line:

```bash
for s in atomic-write edit-literal read-special install-safe hostkey devpath; do
  node_modules/.bin/esbuild "scripts/verify/$s.ts" --bundle --platform=node --format=esm --outfile=/tmp/claw-verify.mjs \
    && node /tmp/claw-verify.mjs || { echo "FAILED: $s"; break; }
done
```

Expected: six `PASS:` lines, no `FAILED`.

- [ ] **Step 5: No commit** (verification task). If anything fails, return to the owning task.

---

## Self-Review

**Spec coverage:**
- C1 host-key → Task 7. ✓ (accept-new+pin, `CLAW_STRICT_HOST_KEY`, hashed `|1|` via HMAC-SHA1, `@revoked`)
- C2 installer → Task 6. ✓ (ENOENT vs parse-fail split, `.bak`, atomic write via P1)
- C3 deploy → Task 8. ✓ (package-only + `CLAW_DEV`, checksum fail-closed, remote atomic+verify)
- C4 pincer crash → Tasks 4 (recover) + 5 (read overflow). ✓
- C5 edit corruption → Task 2. ✓
- C6 read special-file → Task 3 (TS) + Task 5 (Go parity). ✓
- P1 writeFileAtomic → Task 1. ✓  P2 recover → Task 4. ✓

**Placeholder scan:** no TBD/TODO; every code and test step contains complete content.

**Type consistency:** `writeFileAtomic(filePath, data)` defined in Task 1, consumed identically in Task 6. `matchKnownHost`/`sshKeyAlgo`/`pinHostKey` signatures in Task 7 match their test usage. `RecoverToResponse(id, fn)` defined in Task 4 and called with matching arity in `main.go`. `getLocalDevPath(goArch)` defined and consumed consistently in Task 8.

**Ordering:** Task 1 (P1) precedes Task 6 (consumer). Independent fixes otherwise; Tasks 2–8 may be executed in any order after Task 1, but the listed order matches the spec's cheap-first sequence.
