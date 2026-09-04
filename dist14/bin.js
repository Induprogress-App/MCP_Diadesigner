#!/usr/bin/env node
"use strict";
/** CLI entrypoint for the Delta DIADesigner 1.14 MCP server. */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const interop_js_1 = require("./interop.js");
const server_js_1 = require("./server.js");
function readVersion() {
    for (const candidate of [
        path.resolve(__dirname, "..", "package.json"),
        path.resolve(__dirname, "..", "..", "package.json")
    ]) {
        try {
            return JSON.parse(fs.readFileSync(candidate, "utf8")).version ?? "0.0.0";
        }
        catch {
            // try the next candidate
        }
    }
    return "0.0.0";
}
const version = readVersion();
const program = new commander_1.Command()
    .name("diadesigner-mcp-tool")
    .description("Model Context Protocol (MCP) server for Delta DIADesigner 1.14")
    .version(version)
    .option("-d, --diadesigner-path <path>", "Path to DIADesigner.exe", process.env.DIADESIGNER_PATH || interop_js_1.DEFAULT_DIADESIGNER_EXE)
    .option("-z, --sevenzip-path <path>", "Path to the bundled 7za.exe helper")
    .option("-w, --workspace <dir>", "Workspace directory for relative paths", process.cwd());
program.parse(process.argv);
const options = program.opts();
const config = (0, interop_js_1.configWithDefaults)({
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
(0, server_js_1.startServer)(config).catch((error) => {
    console.error("Fatal error starting DIADesigner MCP server:", error);
    process.exit(1);
});
