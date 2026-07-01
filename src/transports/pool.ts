import { Client } from "ssh2";
import type { Machine } from "../config/types.js";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";

export interface PooledConnection {
  conn: Client;
  machine: Machine;
}

const pool: Map<string, PooledConnection> = new Map();
const inflight: Map<string, Promise<PooledConnection>> = new Map();

function getDefaultKeyPaths(): string[] {
  const sshDir = path.join(os.homedir(), ".ssh");
  const candidates = ["id_ed25519", "id_rsa", "id_ecdsa"];
  return candidates
    .map((k) => path.join(sshDir, k))
    .filter((p) => {
      try {
        fs.accessSync(p);
        return true;
      } catch {
        return false;
      }
    });
}

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
    if (process.env.CLAW_STRICT_HOST_KEY === "1") {
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

export async function getConnection(
  machine: Machine,
): Promise<PooledConnection> {
  const key = machine.name;
  const existing = pool.get(key);
  if (existing) return existing;

  // Return existing in-flight connection attempt to avoid race condition
  const pending = inflight.get(key);
  if (pending) return pending;

  const hostAddr = machine.host ?? "localhost";
  const hostPort = machine.port ?? 22;
  const username = machine.user ?? os.userInfo().username;

  // Resolve proxy socket before creating the connection promise
  let proxySock: Duplex | null = null;
  let proxyProc: ReturnType<typeof spawn> | null = null;

  // ProxyJump: create an intermediate SSH connection and forward through it
  if (machine.proxyJump && !machine.proxyCommand) {
    const jumpHost = machine.proxyJump;
    const jumpMatch = jumpHost.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
    if (jumpMatch) {
      const jumpMachine: Machine = {
        name: `__jump_${machine.name}`,
        transport: "ssh",
        host: jumpMatch[2],
        user: jumpMatch[1],
        port: jumpMatch[3] ? parseInt(jumpMatch[3]) : undefined,
      };
      const { conn: jumpConn } = await getConnection(jumpMachine);
      proxySock = await new Promise<any>((resolveStream, rejectStream) => {
        jumpConn.forwardOut(
          "127.0.0.1",
          0,
          hostAddr,
          hostPort,
          (err, stream) => {
            if (err) return rejectStream(err);
            resolveStream(stream);
          },
        );
      });
    }
  }

  // ProxyCommand: spawn a subprocess and use its stdio as the SSH socket
  if (machine.proxyCommand && !proxySock) {
    const expandedCmd = machine.proxyCommand
      .replace(/%h/g, hostAddr)
      .replace(/%p/g, String(hostPort))
      .replace(/%r/g, username);
    proxyProc = spawn("/bin/sh", ["-c", expandedCmd], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const proc = proxyProc;
    proxySock = new Duplex({
      read() {},
      write(chunk, encoding, callback) {
        proc.stdin!.write(chunk, encoding, callback);
      },
      final(callback) {
        proc.stdin!.end(callback);
      },
    });
    proc.stdout!.on("data", (data) => proxySock!.push(data));
    proc.stdout!.on("end", () => proxySock!.push(null));
    proc.on("close", () => proxySock!.destroy());
  }

  const promise = new Promise<PooledConnection>((resolve, reject) => {
    const conn = new Client();

    const config: any = {
      host: hostAddr,
      port: hostPort,
      username,
      readyTimeout: 30000,
      hostVerifier: createHostVerifier(hostAddr, hostPort),
    };

    if (proxySock) {
      config.sock = proxySock;
    }

    // Try to use identity file from machine config or defaults
    if (machine.identityFile) {
      try {
        const keyPath = machine.identityFile.replace(
          /^~(?=$|\/)/,
          os.homedir(),
        );
        config.privateKey = fs.readFileSync(keyPath);
      } catch {
        // Fall through to agent
      }
    } else {
      const keys = getDefaultKeyPaths();
      if (keys.length > 0) {
        try {
          config.privateKey = fs.readFileSync(keys[0]);
        } catch {
          // Fall through to agent
        }
      }
    }

    // Use SSH agent if available
    if (!config.privateKey && process.env.SSH_AUTH_SOCK) {
      config.agent = process.env.SSH_AUTH_SOCK;
    }

    conn.on("ready", () => {
      const pooled = { conn, machine };
      pool.set(key, pooled);
      inflight.delete(key);
      resolve(pooled);
    });

    conn.on("error", (err: Error) => {
      pool.delete(key);
      inflight.delete(key);
      reject(
        new Error(
          `SSH connection to "${machine.name}" failed: ${err.message}`,
        ),
      );
    });

    conn.on("close", () => {
      pool.delete(key);
      if (proxyProc) proxyProc.kill();
    });

    conn.connect(config);
  });

  inflight.set(key, promise);
  return promise;
}

export function removeConnection(name: string): void {
  const entry = pool.get(name);
  if (entry) {
    entry.conn.end();
    pool.delete(name);
  }
}

export function closeAll(): void {
  for (const [name, entry] of pool) {
    entry.conn.end();
  }
  pool.clear();
}
