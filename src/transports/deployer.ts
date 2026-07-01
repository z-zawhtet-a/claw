import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import type { Client, SFTPWrapper } from "ssh2";
import { VERSION } from "../version.js";
const REMOTE_DIR = ".claw";
const REMOTE_BINARY_REL = `${REMOTE_DIR}/pincer`;
const RELEASE_URL_BASE = "https://github.com/z-zawhtet-a/claw/releases/download";
const CACHE_DIR = path.join(os.homedir(), ".config", "claw", "bin");

function getArchName(unameMArch: string): string {
  const archMap: Record<string, string> = {
    x86_64: "amd64",
    aarch64: "arm64",
    arm64: "arm64",
  };
  return archMap[unameMArch] ?? "amd64";
}

function getCachedPath(goArch: string): string {
  return path.join(CACHE_DIR, `pincer-linux-${goArch}-${VERSION}`);
}

function getDownloadUrl(goArch: string): string {
  return `${RELEASE_URL_BASE}/v${VERSION}/pincer-linux-${goArch}`;
}

function getChecksumUrl(): string {
  return `${RELEASE_URL_BASE}/v${VERSION}/checksums.txt`;
}

async function fetchExpectedChecksum(goArch: string): Promise<string | null> {
  try {
    const res = await fetch(getChecksumUrl(), { redirect: "follow" });
    if (!res.ok) return null;
    const text = await res.text();
    const binaryName = `pincer-linux-${goArch}`;
    for (const line of text.split("\n")) {
      // Format: "<sha256>  <filename>" or "<sha256> <filename>"
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2 && parts[1] === binaryName) {
        return parts[0];
      }
    }
    return null;
  } catch {
    return null;
  }
}

function computeFileHash(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function getLocalDevPath(goArch: string): string | null {
  const binName = `pincer-linux-${goArch}`;
  const candidates: string[] = [];

  // Trust only a binary bundled inside claw's own package tree — resolve
  // relative to THIS module and walk up to the package root. Never scan the
  // current working directory (an untrusted repo could plant a binary there).
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 4; i++) {
    candidates.push(path.join(dir, "pincer-bin", binName));
    dir = path.dirname(dir);
  }

  // Explicit dev mode additionally trusts a locally-built binary in the CWD.
  if (process.env.CLAW_DEV) {
    candidates.unshift(path.join(process.cwd(), "pincer-bin", binName));
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function downloadPincer(goArch: string): Promise<string> {
  const cached = getCachedPath(goArch);
  if (fs.existsSync(cached)) return cached;

  const url = getDownloadUrl(goArch);
  const res = await fetch(url, { redirect: "follow" });

  if (!res.ok || !res.body) {
    throw new Error(
      `Failed to download pincer from ${url}: ${res.status} ${res.statusText}`,
    );
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const tmpPath = `${cached}.tmp`;
  const fileStream = fs.createWriteStream(tmpPath);
  await pipeline(res.body as any, fileStream);

  // Verify integrity — fail closed if we cannot obtain a checksum.
  const expectedHash = await fetchExpectedChecksum(goArch);
  if (!expectedHash) {
    fs.unlinkSync(tmpPath);
    throw new Error(
      `Refusing to deploy pincer: no verified checksum available from ${getChecksumUrl()}. ` +
        `The release must publish checksums.txt.`,
    );
  }
  const actualHash = computeFileHash(tmpPath);
  if (actualHash !== expectedHash) {
    fs.unlinkSync(tmpPath);
    throw new Error(
      `Pincer binary integrity check failed.\nExpected: ${expectedHash}\nActual:   ${actualHash}\nThe downloaded binary may be corrupted or tampered with.`,
    );
  }

  fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, cached);

  return cached;
}

async function resolvePincerBinary(goArch: string): Promise<string> {
  // 1. Check local dev build first
  const localPath = getLocalDevPath(goArch);
  if (localPath) return localPath;

  // 2. Check cache / download from GitHub Releases
  return downloadPincer(goArch);
}

const EXEC_TIMEOUT = 30_000; // 30 seconds

async function execCommand(conn: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    conn.exec(command, (err, stream) => {
      if (err) return reject(err);

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          stream.destroy();
          reject(
            new Error(`Command timed out after ${EXEC_TIMEOUT}ms: ${command}`),
          );
        }
      }, EXEC_TIMEOUT);

      let output = "";
      let stderr = "";
      stream.on("data", (data: Buffer) => {
        output += data.toString();
      });
      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      stream.on("close", (code: number) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code !== 0 && !output.trim()) {
          reject(new Error(`Command failed (exit ${code}): ${stderr.trim()}`));
        } else {
          resolve(output.trim());
        }
      });
    });
  });
}

function getSftp(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

export async function ensurePincer(conn: Client): Promise<string> {
  // Detect remote home directory and architecture
  const [remoteHome, arch] = await Promise.all([
    execCommand(conn, "echo $HOME"),
    execCommand(conn, "uname -m"),
  ]);

  const goArch = getArchName(arch);
  const remoteBinaryPath = `${remoteHome}/${REMOTE_BINARY_REL}`;

  // Check if pincer already exists with correct version
  try {
    const remoteVersion = await execCommand(
      conn,
      `${remoteBinaryPath} --version`,
    );
    if (remoteVersion === VERSION) {
      return remoteBinaryPath;
    }
  } catch {
    // pincer doesn't exist yet
  }

  // Resolve local binary (dev build or download from GitHub Releases)
  const localPath = await resolvePincerBinary(goArch);

  // Kill stale pincer processes (separate exec so pkill doesn't match the shell running our commands)
  try {
    await execCommand(conn, `pkill -x pincer 2>/dev/null || true`);
  } catch {
    // Ignore — no matching process is fine
  }

  // Remove old binary (can't overwrite a running executable on Linux) and ensure directory exists
  await execCommand(conn, `mkdir -p ${remoteHome}/${REMOTE_DIR} && rm -f ${remoteBinaryPath}`);

  // Upload to a temp path, then atomically move into place on the remote.
  const remoteTmp = `${remoteBinaryPath}.tmp`;
  const sftp = await getSftp(conn);

  try {
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remoteTmp, (err) => {
        if (err) reject(new Error(`SFTP upload failed: ${err.message}`));
        else resolve();
      });
    });
  } finally {
    sftp.end();
  }

  await execCommand(conn, `mv -f ${remoteTmp} ${remoteBinaryPath} && chmod +x ${remoteBinaryPath}`);

  // Verify the uploaded binary matches what we sent (detect truncation/tamper).
  const localHash = computeFileHash(localPath);
  const remoteHashOut = await execCommand(
    conn,
    `sha256sum ${remoteBinaryPath} 2>/dev/null || shasum -a 256 ${remoteBinaryPath}`,
  );
  const remoteHash = remoteHashOut.trim().split(/\s+/)[0];
  if (remoteHash !== localHash) {
    throw new Error(
      `Remote pincer hash mismatch after upload (expected ${localHash}, got ${remoteHash}).`,
    );
  }

  return remoteBinaryPath;
}
