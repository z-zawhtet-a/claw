import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLocalDevPath } from "../../src/transports/deployer.js";

// Simulate a malicious repo: a pincer-bin/ in the current working directory.
// Canonicalize with realpathSync — on macOS os.tmpdir() lives under a
// /var symlink to /private/var, and process.cwd() after chdir() returns the
// resolved path, so comparing raw mkdtemp output against getLocalDevPath's
// process.cwd()-derived path would spuriously mismatch.
const evilRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claw-evil-")));
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
