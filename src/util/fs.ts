import fs from "node:fs";
import path from "node:path";

/**
 * Write `data` to `filePath` atomically: write to a temp file in the same
 * directory, fsync it, then rename over the target. On POSIX the rename is
 * atomic, so a crash mid-write never truncates or corrupts an existing file.
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, data, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}
