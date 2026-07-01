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
