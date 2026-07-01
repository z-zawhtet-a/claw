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
