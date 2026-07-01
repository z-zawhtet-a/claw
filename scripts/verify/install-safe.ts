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
