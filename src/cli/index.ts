import { Command } from "commander";
import { registerServe } from "./serve.js";
import { registerInit } from "./init.js";
import { registerAdd } from "./add.js";
import { registerInstall } from "./install.js";
import { VERSION } from "../version.js";

export const cli = new Command()
  .name("claw")
  .description("MCP server for remote machine access over SSH")
  .version(VERSION);

registerServe(cli);
registerInit(cli);
registerAdd(cli);
registerInstall(cli);
