# Claw — Critical Issue Remediation (C1–C6)

**Date:** 2026-07-01
**Status:** Design — awaiting approval
**Scope:** The six critical issues surfaced by the 2026-07-01 security/correctness audit.

---

## 1. Context

Claw is an MCP server that runs `bash`/`read`/`write`/`edit`/`grep`/`glob`/`ls` on
remote machines over SSH, auto-deploying a Go binary ("pincer") to each host. Because
the tool executes shell commands on remote servers using the operator's SSH
credentials, its trust boundaries (agent input, remote output, config files, network
path) are the thing that matters most.

A five-way parallel audit found **6 critical** issues (each trivially triggerable) plus
a set of HIGH/MEDIUM issues. This spec designs the fixes for the **6 criticals only**.
The HIGH/MEDIUM items are recorded in §7 as follow-ups and are explicitly out of scope
here.

A recurring root cause across the criticals is **fail-open on the security-critical
branch**: unknown host key → accept; missing checksum → skip verification; config won't
parse → overwrite it. The unifying principle of this remediation is **fail closed**: on
uncertainty, refuse rather than proceed.

## 2. Goals / Non-goals

**Goals**
- Eliminate the MITM hole (C1), the config-destruction hole (C2), the remote-code path
  (C3), the remote-crash path (C4), the silent file corruption (C5), and the
  special-file OOM/hang (C6).
- Land two small shared primitives (atomic file write; per-request panic recovery) that
  these fixes need and that later HIGH fixes will reuse.
- Keep local (TypeScript) and remote (Go) tool behavior consistent where the audit found
  them diverging (notably `edit`).

**Non-goals (this spec)**
- The HIGH/MEDIUM items in §7 (process-group kill, secret redaction in logs, ReDoS
  guard, ungated `machines add/update`, etc.). They are real and tracked, but out of
  scope for this remediation.
- Introducing a full test framework. The repo has none; verification here is targeted
  repro scripts plus Go `_test.go` files where idiomatic (§6).

## 3. Approved policy decisions

| # | Decision | Choice |
|---|----------|--------|
| C1 | Unknown host on connect | **Accept-new + pin** (TOFU): record the key to `~/.ssh/known_hosts` and proceed; later change → reject. `CLAW_STRICT_HOST_KEY=1` makes unknown hosts reject too. |
| C3 | Locally-built pincer binary | **Package-only by default** (resolve relative to the installed module, no `process.cwd()` scan, no parent-walk). CWD/dev binary honored **only when `CLAW_DEV=1`**. |

## 4. Shared primitives

**P1 — `writeFileAtomic(path, data)` (TypeScript).** Write to `path + ".tmp-<pid>"` in
the *same directory*, `fsync`, then `fs.rename` into place (atomic replace on POSIX).
Used by C2 now; reused by the H4 sweep later. Lives in a small `src/util/fs.ts`.

**P2 — Per-request panic recovery (Go).** In `pincer/main.go`, the goroutine that runs
`rpc.Dispatch` gets a `defer/recover` that converts a panic into a JSON-RPC error
response *for that request id* and keeps the server (and the pooled SSH connection)
alive. Used by C4; protects every tool.

## 5. Per-fix design

### C1 — Host-key verification: fail-closed + hashed-host support
**File:** `src/transports/pool.ts`

Problem: unknown hosts are accepted with only a stderr warning and never pinned
(`:93-103`); hashed `|1|…` entries are skipped entirely (`:53-57`), so
`HashKnownHosts yes` users get no verification at all.

Fix:
1. **Match hashed entries.** For a `|1|<b64-salt>|<b64-hash>` line, compute
   `HMAC-SHA1(base64decode(salt), hostname)` and compare to `base64decode(hash)`. The
   `hostname` string follows OpenSSH convention: bare `host` for port 22, `[host]:port`
   otherwise. Rework the verifier to iterate all known_hosts lines and test each for a
   match against the target host (plaintext compare **or** hashed HMAC), collecting the
   candidate keys.
2. **Honor markers.** `@revoked` line matching the host+key → reject. `@cert-authority`
   → skip (no CA validation performed).
3. **Known host, key mismatch → reject** (unchanged).
4. **Unknown host → accept-new + pin:** derive the key algorithm from the key blob's
   leading length-prefixed string, append a valid line
   (`<host-or-[host]:port> <algo> <base64key>`) to `~/.ssh/known_hosts` (creating
   `~/.ssh` at `0700` and the file at `0600` if absent), update the in-memory cache, and
   return `true`.
5. **`CLAW_STRICT_HOST_KEY=1`** → unknown host returns `false` (no pin, no connect).

Edge cases: `~/.ssh/known_hosts` missing → create on first pin; multiple keys per host
(different algos) → any match accepts; in-memory cache updated after a pin so repeated
connects in one process stay consistent. Document that accept-new is first-use trust
(a MITM present on the *very first* connect is trusted — same model as OpenSSH
`accept-new`).

### C2 — Installer safe read-modify-write
**File:** `src/cli/install.ts`

Problem: a single `catch` conflates "file absent" with "file unparseable" and then
overwrites the whole file (`:40-55`, `:64-78`); write is non-atomic.

Fix:
1. Read step distinguishes cases: `ENOENT` → start fresh (`{}`); any other read error
   (e.g. `EACCES`) → **abort**.
2. Parse step is separate: on `JSON.parse` failure → **abort** with
   `Refusing to overwrite <path>: it exists but is not valid JSON. Fix or remove it first.`
   Never write.
3. Best-effort backup: copy existing file to `<path>.bak` before writing.
4. Write via `writeFileAtomic` (P1).
5. Same treatment for the Cursor config path.

### C3 — Deploy integrity: fail-closed
**File:** `src/transports/deployer.ts`

Problem: `getLocalDevPath` scans `process.cwd()` + 5 parent dirs and uses any found
binary unverified (`:58-75`) — a malicious repo shipping `pincer-bin/` gets its binary
uploaded and executed on every remote. Separately, the download checksum is skipped when
`checksums.txt` can't be fetched (`:97-109`).

Fix:
1. **Dev-path lockdown.** Default: resolve `pincer-bin/` *only* relative to the installed
   module's own package directory (bounded; no `process.cwd()`, no parent-walk). When
   `CLAW_DEV=1`, additionally allow the current looser CWD/parent lookup for local
   development. (Note: `pincer-bin` is not in the package's published `files`, so real
   npm installs always take the verified-download path — this is the intended outcome.)
2. **Download fail-closed.** If `fetchExpectedChecksum` returns null, **throw** (refuse to
   chmod+exec). Releases must publish `checksums.txt` — noted as a release requirement.
3. **Remote upload hardening** (related, cheap): SFTP to `<path>.tmp`, `mv -f` into place
   (atomic on the remote), then `sha256sum` the remote file and compare to the local
   hash before executing; abort on mismatch.

### C4 — One request can't crash the remote server
**Files:** `pincer/main.go`, `pincer/tools/read.go`

Problem: `read` with `limit = MaxInt64` overflows `offset + limit` to a negative slice
bound → panic (`read.go:47-60`); the request goroutine has no `recover()`
(`main.go:43-48`), so the whole pincer dies and drops all concurrent requests.

Fix:
1. **P2 recover** in the request goroutine → error response for that id, server survives.
2. **Overflow guard in `read.go`:** clamp a supplied `limit` to `>= 0`; compute
   `end := offset + limit` and clamp with `if end < offset || end > len(lines) { end = len(lines) }`
   (the `end < offset` test catches integer overflow).
3. **Parity:** also guard `pincer/tools/read.go` against non-regular files (see C6) so the
   remote side can't be hung by `read path=/dev/zero`.

### C5 — `edit` literal replacement (stop `$`-corruption)
**File:** `src/tools/edit.ts`

Problem: `content.replace(old_string, new_string)` (`:28`) treats `$$`, `$&`, `` $` ``,
`$'` in the replacement as templates, silently writing wrong content. The Go side
(`edit.go:38`, `strings.Replace`) is literal — so the two diverge.

Fix: replace with an index splice using the already-validated unique match:
`const idx = content.indexOf(old_string); const newContent = content.slice(0, idx) + new_string + content.slice(idx + old_string.length);`
Now byte-for-byte literal and consistent with the Go implementation.

### C6 — `read` rejects non-regular files
**File:** `src/tools/read.ts` (+ `pincer/tools/read.go` for parity)

Problem: `fs.stat` reports size 0 for `/dev/zero`, `/dev/random`, FIFOs, so the 100 MB
guard is bypassed and `fs.readFile` reads forever (OOM) or blocks forever (FIFO).

Fix: after `stat`, require `stat.isFile()`; otherwise return
`Error: <path> is not a regular file`. Add a defensive byte cap on the read as a
backstop. Mirror with `info.Mode().IsRegular()` in `pincer/tools/read.go`.

## 6. Verification (no test framework)

- **Go (pincer):** add `pincer/tools/read_test.go` — table test asserting
  `offset=1, limit=MaxInt64` returns a bounded result (no panic) and that a non-regular
  path is rejected. Run with `go test ./...` in `pincer/`.
- **TypeScript:** targeted repro scripts (run via `node` against the built `dist/`, kept
  in the scratch dir, not committed unless we decide to add a `scripts/verify/` home):
  - C1: feed plaintext / hashed / mismatched / unknown keys through `createHostVerifier`
    and assert accept/reject/pin.
  - C2: run installer against missing / valid-with-other-servers / corrupt config; assert
    other servers survive and a corrupt file is left untouched.
  - C3: stub the checksum fetch to 404 and assert deploy aborts; assert a CWD `pincer-bin`
    is ignored without `CLAW_DEV=1`.
  - C5: edit with `new_string="echo $$"`; assert the file contains `echo $$` verbatim.
  - C6: `read path=/dev/zero` returns an error immediately.

## 7. Out of scope — tracked follow-ups

HIGH: bash timeout doesn't kill the process tree (H1); ungated persisted
`machines add/update` target hijack (H2); bash commands logged verbatim world-readable
(H3); non-atomic writes across all tools/config (H4 — reuses P1); grep ReDoS + 64 KB
line-cap silent misses (H5); 50 MB RPC Scanner cap kills pincer (H6); installer writes
npx-ephemeral path (H7).

MEDIUM: connect race duplicate channels; buffer-overflow wedged transport; dead pooled
connection reuse; ProxyCommand injection from untrusted `claw.yaml`; ssh-parser
multi-alias `[object Object]`; `parseInt` no radix/NaN guard; `command=` fallback
tokenizer mangling; unknown-host raw-error contract break + machine-name leak;
`init --from-ssh` clobbers manual machines.

## 8. Rollout

Independent fixes, one commit each for reviewability. Suggested order (cheap/high-impact
first, security last so each gets a focused commit):
C5 → C6 → C4 → C2 → C1 → C3, with P1/P2 landing alongside C2/C4 respectively.
