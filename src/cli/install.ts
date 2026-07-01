import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeFileAtomic } from "../util/fs.js";

export class InstallAbort extends Error {}

function getMcpConfig(): { command: string; args: string[] } {
  // process.argv[1] is the currently running claw CLI script (dist/bin/claw.js)
  const clawBin = path.resolve(process.argv[1]);
  return {
    command: "node",
    args: [clawBin, "serve"],
  };
}

// Read + parse an existing JSON config. Missing file → fresh {}. A file that
// exists but does not parse → abort (never overwrite something we can't read).
function loadJsonConfig(configPath: string): any {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw new InstallAbort(`Cannot read ${configPath}: ${err.message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InstallAbort(
      `Refusing to overwrite ${configPath}: it exists but is not valid JSON. Fix or remove it first.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InstallAbort(
      `Refusing to overwrite ${configPath}: it is valid JSON but not an object.`,
    );
  }
  return parsed;
}

function backup(configPath: string): void {
  if (fs.existsSync(configPath)) {
    try {
      fs.copyFileSync(configPath, configPath + ".bak");
    } catch {
      // best-effort backup
    }
  }
}

export function registerInstall(program: Command): void {
  program
    .command("install <target>")
    .description("Install Claw into an AI agent's MCP config")
    .action((target: string) => {
      try {
        switch (target) {
          case "claude-code":
            installClaudeCode();
            break;
          case "cursor":
            installCursor();
            break;
          default:
            console.error(
              `Unknown target: "${target}". Supported: claude-code, cursor`,
            );
            process.exit(1);
        }
      } catch (err) {
        if (err instanceof InstallAbort) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      }
    });
}

export function installClaudeCode(): void {
  const configPath = path.join(os.homedir(), ".claude.json");
  const config = loadJsonConfig(configPath);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.claw = { type: "stdio", ...getMcpConfig() };
  backup(configPath);
  writeFileAtomic(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`Installed Claw MCP server into ${configPath}`);
  console.log("Restart Claude Code to pick up the changes.");
}

export function installCursor(): void {
  const configPath = path.join(process.cwd(), ".cursor", "mcp.json");
  const config = loadJsonConfig(configPath);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.claw = getMcpConfig();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  backup(configPath);
  writeFileAtomic(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`Installed Claw MCP server into ${configPath}`);
  console.log("Restart Cursor to pick up the changes.");
}
