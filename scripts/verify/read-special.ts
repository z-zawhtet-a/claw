import assert from "node:assert";
import { read } from "../../src/tools/read.js";

// /dev/null is a size-0 character device: exactly the guard-bypass class
// (fs.stat reports size 0, so the 100MB guard passes). Reading it must be
// rejected, not silently treated as an empty regular file.
const res = await read({ path: "/dev/null" });
assert.strictEqual(res.isError, true, "expected /dev/null to be rejected");
assert.match(res.content, /not a regular file/);

console.log("PASS: read rejects non-regular files (1 check)");
