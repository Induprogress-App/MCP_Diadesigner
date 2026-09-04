#!/usr/bin/env node
/** CLI entrypoint for the Delta DIADesigner 1.14 MCP server. */

import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import { DEFAULT_DIADESIGNER_EXE, configWithDefaults } from "./interop.js";
import { startServer } from "./server.js";

function readVersion(): string {
  for (const candidate of [
    path.resolve(__dirname, "..", "package.json"),
    path.resolve(__dirname, "..", "..", "package.json")
  ]) {
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf8")).version ?? "0.0.0";
    } catch {
      // try the next candidate
    }
  }
  return "0.0.0";
}

const version = readVersion();

const program = new Command()
  .name("diadesigner-mcp-tool")
  .description("Model Context Protocol (MCP) server for Delta DIADesigner 1.14")
  .version(version)
  .option(
    "-d, --diadesigner-path <path>",
    "Path to DIADesigner.exe",
    process.env.DIADESIGNER_PATH || DEFAULT_DIADESIGNER_EXE
  )
  .option("-z, --sevenzip-path <path>", "Path to the bundled 7za.exe helper")
  .option("-w, --workspace <dir>", "Workspace directory for relative paths", process.cwd());

program.parse(process.argv);
const options = program.opts<{
  diadesignerPath: string;
  sevenzipPath?: string;
  workspace: string;
}>();

const config = configWithDefaults({
  diadesignerPath: options.diadesignerPath,
  sevenZipPath: options.sevenzipPath,
  workspaceDir: path.resolve(options.workspace)
});

console.error("========================================");
console.error(`Starting Delta DIADesigner 1.14 MCP Server v${version}`);
console.error(`  DIADesigner: ${config.diadesignerPath}`);
console.error(`  7-Zip helper: ${config.sevenZipPath}`);
console.error(`  Workspace: ${config.workspaceDir}`);
console.error(`  Node.js: ${process.version}`);
console.error("========================================");

startServer(config).catch((error) => {
  console.error("Fatal error starting DIADesigner MCP server:", error);
  process.exit(1);
});
