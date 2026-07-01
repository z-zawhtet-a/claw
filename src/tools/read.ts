import fs from "node:fs/promises";
import type { ToolResult } from "./bash.js";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export interface ReadParams {
  path: string;
  offset?: number;
  limit?: number;
}

export async function read(params: ReadParams): Promise<ToolResult> {
  try {
    const stat = await fs.stat(params.path);
    if (!stat.isFile()) {
      return {
        content: `Error: ${params.path} is not a regular file`,
        isError: true,
      };
    }
    if (stat.size > MAX_FILE_SIZE) {
      return {
        content: `Error: file is ${Math.round(stat.size / 1024 / 1024)}MB, exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit. Use bash with head/tail/sed to read portions.`,
        isError: true,
      };
    }

    const content = await fs.readFile(params.path, "utf-8");
    const lines = content.split("\n");

    const offset = Math.min(Math.max(0, params.offset ?? 0), lines.length);
    const limit = Math.max(0, params.limit ?? lines.length);
    const sliced = lines.slice(offset, offset + limit);

    // Format with line numbers (1-indexed)
    const numbered = sliced
      .map((line, i) => `${offset + i + 1}\t${line}`)
      .join("\n");

    return { content: numbered };
  } catch (err: any) {
    return {
      content: `Error reading file: ${err.message}`,
      isError: true,
    };
  }
}
