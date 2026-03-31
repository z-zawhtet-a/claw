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

interface KnownHost {
  key: string; // base64-encoded key
}

let knownHostsCache: Map<string, KnownHost[]> | null = null;

function loadKnownHosts(): Map<string, KnownHost[]> {
  if (knownHostsCache) return knownHostsCache;
  knownHostsCache = new Map();

  const khPath = path.join(os.homedir(), ".ssh", "known_hosts");
  let content: string;
  try {
    content = fs.readFileSync(khPath, "utf-8");
  } catch {
    return knownHostsCache;
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("@")) continue;

    // Skip hashed hosts (|1|...) — we can't reverse them
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3 || parts[0].startsWith("|")) continue;

    const hostnames = parts[0];
    const keyData = parts[2]; // base64

    for (const hostEntry of hostnames.split(",")) {
      // Strip [host]:port format
      let hostname = hostEntry;
      let port = 22;
      const bracketMatch = hostEntry.match(/^\[(.+)\]:(\d+)$/);
      if (bracketMatch) {
        hostname = bracketMatch[1];
        port = parseInt(bracketMatch[2]);
      }

      const lookupKey = `${hostname}:${port}`;
      const existing = knownHostsCache.get(lookupKey) ?? [];
      existing.push({ key: keyData });
      knownHostsCache.set(lookupKey, existing);
    }
  }

  return knownHostsCache;
}

function createHostVerifier(
  host: string,
  port: number,
): (key: Buffer) => boolean {
  return (key: Buffer): boolean => {
    const knownHosts = loadKnownHosts();
    const lookupKey = `${host}:${port}`;
    const entries = knownHosts.get(lookupKey);

    const receivedKey = key.toString("base64");

    if (!entries || entries.length === 0) {
      // Host not in known_hosts — accept but warn
      const fingerprint = crypto
        .createHash("sha256")
        .update(key)
        .digest("base64");
      process.stderr.write(
        `Warning: host "${host}:${port}" not found in known_hosts (fingerprint: SHA256:${fingerprint})\n`,
      );
      return true;
    }

    // Check if any known key matches
    for (const entry of entries) {
      if (entry.key === receivedKey) return true;
    }

    // Host is known but key doesn't match — possible MITM
    process.stderr.write(
      `ERROR: Host key verification failed for "${host}:${port}".\n` +
        `The host key has changed. This could indicate a man-in-the-middle attack.\n` +
        `Update ~/.ssh/known_hosts if the key change is expected.\n`,
    );
    return false;
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
