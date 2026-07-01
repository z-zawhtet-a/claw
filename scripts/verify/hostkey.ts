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
