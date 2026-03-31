import { glob as globFn } from "glob";
import type { ToolResult } from "./bash.js";

const MAX_RESULTS = 10_000;

export interface GlobParams {
  pattern: string;
}

export async function glob(params: GlobParams): Promise<ToolResult> {
  try {
    const files = await globFn(params.pattern, {
      absolute: true,
      nodir: false,
      dot: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });

    if (files.length === 0) {
      return { content: "No files matched the pattern." };
    }

    const truncated = files.length > MAX_RESULTS;
    const result = truncated ? files.slice(0, MAX_RESULTS) : files;
    let output = result.join("\n");
    if (truncated) {
      output += `\n\n(results truncated at ${MAX_RESULTS} of ${files.length} matches — use a more specific pattern)`;
    }

    return { content: output };
  } catch (err: any) {
    return {
      content: `Error: ${err.message}`,
      isError: true,
    };
  }
}
