import assert from "node:assert";
import { execFileSync } from "node:child_process";
import path from "node:path";

// run.sh cd's to the repo root before executing the bundled verifier.
const script = path.resolve("install.sh");

type Run = { status: number; stdout: string };

// Runs `bash <args>` and captures exit status + stdout without throwing on a
// non-zero exit, so we can assert on failure paths.
function run(args: string[], env: Record<string, string> = {}): Run {
  try {
    const stdout = execFileSync("bash", args, {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: String(err.stdout ?? "") };
  }
}

// 1. Script is syntactically valid.
assert.strictEqual(run(["-n", script]).status, 0, "bash -n found a syntax error");

// 2. --help exits 0 and prints usage. This is the regression guard for the
//    EXIT-trap bug: an empty-SCRATCH cleanup used to return 1 and poison a
//    successful exit, making every clean run look failed to an && chain.
const help = run([script, "--help"]);
assert.strictEqual(help.status, 0, "--help must exit 0");
assert.ok(/claw installer/.test(help.stdout), "--help must print usage");

// 3. Unknown flags fail closed.
assert.notStrictEqual(run([script, "--nope"]).status, 0, "unknown flag must exit non-zero");

// 4. A CLAW_SRC that isn't a claw checkout is rejected before any build/install.
assert.notStrictEqual(
  run([script, "--no-configure"], { CLAW_SRC: "/nonexistent-claw-src" }).status,
  0,
  "invalid CLAW_SRC must be rejected",
);

console.log("PASS: install.sh syntax + arg handling + exit codes (4 checks)");
