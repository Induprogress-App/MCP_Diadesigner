"use strict";
/**
 * MCP server for Delta DIADesigner 1.14.
 *
 * Tools are grouped by the layer they act on:
 *   installation/workspace -> plain filesystem + install layout
 *   native project         -> Delta .NET assemblies through bridge/DeltaBridge.ps1
 *   program content        -> PLCopen .EXPORT XML (read, edit, create, compile via import)
 *   symbols                -> DiaTag Symbolconfiguration XML
 */
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
exports.createServer = createServer;
exports.startServer = startServer;
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const interop_js_1 = require("./interop.js");
const bridge_js_1 = require("./bridge.js");
const path = __importStar(require("path"));
const plcopen_js_1 = require("./plcopen.js");
const symbols_js_1 = require("./symbols.js");
const variableSchema = zod_1.z.object({
    name: zod_1.z.string().describe("IEC identifier"),
    type: zod_1.z.string().describe("IEC type, e.g. BOOL, INT, REAL, STRING(20), ARRAY[0..9] OF INT, or a user type name"),
    initialValue: zod_1.z.string().optional(),
    address: zod_1.z.string().optional().describe("Direct address, e.g. %MW100"),
    documentation: zod_1.z.string().optional()
});
function ok(value) {
    return { content: [{ type: "text", text: (0, interop_js_1.formatAsJson)(value) }] };
}
function fail(error) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text: message }] };
}
async function guard(fn) {
    try {
        return ok(await fn());
    }
    catch (error) {
        return fail(error);
    }
}
function createServer(config) {
    const server = new mcp_js_1.McpServer({ name: "Delta DIADesigner 1.14 MCP Server", version: "0.2.0" }, {
        capabilities: { resources: { listChanged: true }, tools: { listChanged: true } },
        instructions: [
            "Automates Delta DIADesigner 1.14.",
            "Program content is read and written through PLCopen .EXPORT XML: export from DIADesigner, edit here, import back.",
            "Native .diade containers can be read directly (1.14 format only); 1.13 projects must be migrated in the UI first."
        ].join(" ")
    });
    // ------------------------------------------------------------- resources ---
    server.resource("diadesigner-installation-status", "diadesigner://installation/status", async (uri) => ({
        contents: [
            { uri: uri.href, mimeType: "application/json", text: (0, interop_js_1.formatAsJson)(await (0, interop_js_1.detectInstallation)(config)) }
        ]
    }));
    server.resource("diadesigner-workspace-projects", "diadesigner://workspace/projects", async (uri) => ({
        contents: [
            {
                uri: uri.href,
                mimeType: "application/json",
                text: (0, interop_js_1.formatAsJson)(await (0, interop_js_1.scanWorkspaceProjects)(config.workspaceDir))
            }
        ]
    }));
    server.resource("diadesigner-export-structure", new mcp_js_1.ResourceTemplate("diadesigner://export/{+export_path}/structure", { list: undefined }), async (uri, params) => {
        const exportPath = decodeURIComponent(String(params.export_path));
        const pous = await (0, plcopen_js_1.listPous)(config, exportPath);
        const structures = await (0, plcopen_js_1.listStructures)(config, exportPath);
        return {
            contents: [
                {
                    uri: uri.href,
                    mimeType: "application/json",
                    text: (0, interop_js_1.formatAsJson)({ ...pous, ...structures })
                }
            ]
        };
    });
    // --------------------------------------------- installation and workspace ---
    server.tool("detect_installation", "Detects the local DIADesigner installation: executable, version, helper tools and the .NET assemblies the native bridge needs.", {}, async () => guard(async () => (0, interop_js_1.detectInstallation)(config)));
    server.tool("check_bridge", "Verifies that the native .NET bridge can load DIADesigner's own assemblies. Run this first when native project tools misbehave.", {}, async () => guard(async () => (0, bridge_js_1.bridgeDetect)(config)));
    server.tool("scan_workspace_projects", "Finds DIADesigner projects and PLCopen exports (.diade, .EXPORT, .isp, ...) under the workspace.", {
        startDir: zod_1.z.string().optional().describe("Directory to scan, relative to the workspace"),
        maxDepth: zod_1.z.number().int().min(1).max(12).optional(),
        maxResults: zod_1.z.number().int().min(1).max(500).optional()
    }, async ({ startDir, maxDepth, maxResults }) => guard(async () => (0, interop_js_1.scanWorkspaceProjects)(config.workspaceDir, startDir, maxDepth, maxResults)));
    server.tool("inspect_file", "Classifies a project-like file: container format, whether it is a 1.13 or 1.14 native project, and archive contents when applicable.", {
        filePath: zod_1.z.string(),
        maxEntries: zod_1.z.number().int().min(1).max(2000).optional()
    }, async ({ filePath, maxEntries }) => guard(async () => (0, interop_js_1.inspectProjectFile)(config, filePath, true, maxEntries)));
    server.tool("list_archive_entries", "Lists entries inside an archive-like file using DIADesigner's bundled 7-Zip helper.", { filePath: zod_1.z.string(), maxEntries: zod_1.z.number().int().min(1).max(2000).optional() }, async ({ filePath, maxEntries }) => guard(async () => (0, interop_js_1.listArchiveEntries)(config, filePath, maxEntries)));
    server.tool("extract_archive", "Extracts an archive-like project file into a directory for inspection.", { filePath: zod_1.z.string(), outputDir: zod_1.z.string() }, async ({ filePath, outputDir }) => guard(async () => (0, interop_js_1.extractProjectArchive)(config, filePath, outputDir)));
    server.tool("create_backup", "Creates a timestamped copy of a file next to it.", { filePath: zod_1.z.string() }, async ({ filePath }) => guard(async () => (0, interop_js_1.createProjectBackup)(config.workspaceDir, filePath)));
    server.tool("list_device_catalog", "Lists the device and resource catalogs present in the DIADesigner installation.", {}, async () => guard(async () => (0, interop_js_1.listDeviceCatalog)(config)));
    server.tool("resolve_path", "Resolves a path against the configured workspace.", { inputPath: zod_1.z.string() }, async ({ inputPath }) => guard(async () => ({
        inputPath,
        resolvedPath: (0, interop_js_1.resolveWorkspacePath)(config.workspaceDir, inputPath)
    })));
    server.tool("open_in_diadesigner", "Launches the DIADesigner UI, optionally on a project.", { projectPath: zod_1.z.string().optional() }, async ({ projectPath }) => guard(async () => (0, interop_js_1.launchDiaDesigner)(config, projectPath)));
    // ------------------------------------------------------- native project ----
    server.tool("read_native_project", "Decrypts a native .diade project container and returns its solution and device tree. Works on DIADesigner 1.14 containers; 1.13 projects must be migrated first.", { projectPath: zod_1.z.string().describe("Path to the .diade file") }, async ({ projectPath }) => guard(async () => (0, bridge_js_1.readNativeProject)(config, projectPath)));
    server.tool("read_program_header", "Parses the header of a PLC.prog / PLC.diaobj program container (version, project offsets, executable code size).", { programPath: zod_1.z.string() }, async ({ programPath }) => guard(async () => (0, bridge_js_1.readProgramHeader)(config, programPath)));
    server.tool("read_program", "Loads a PLC program container through DIADesigner's own loader and lists the POUs and data types it contains.", { programPath: zod_1.z.string().describe("Path to PLC.prog or PLC.diaobj") }, async ({ programPath }) => guard(async () => (0, bridge_js_1.loadProgram)(config, programPath)));
    server.tool("compile_program", "Compiles (or only syntax-checks) a PLC program container using DIADesigner's ISP compiler.", {
        programPath: zod_1.z.string(),
        mode: zod_1.z.enum(["compile", "check"]).optional().describe("check runs validation only; default is compile")
    }, async ({ programPath, mode }) => guard(async () => (0, bridge_js_1.compileProgram)(config, programPath, mode ?? "compile")));
    server.tool("export_project", "Drives the DIADesigner GUI to export a project's whole program to a native .export file (there is no headless export). Requires an interactive, unlocked Windows desktop; reuses an already-open instance of the project or launches one.", {
        projectPath: zod_1.z.string().describe("Path to the .diade project file"),
        exportPath: zod_1.z.string().describe("Target .export file to write"),
        timeoutSec: zod_1.z.number().int().min(30).max(600).optional()
    }, async ({ projectPath, exportPath, timeoutSec }) => guard(async () => (0, bridge_js_1.exportProjectGui)(config, projectPath, exportPath, timeoutSec ?? 240)));
    server.tool("read_program_memory", "Reads the DECRYPTED Ladder program out of a running DIADesigner process's memory (ClrMD, read-only). DIADesigner keeps program logic AES-encrypted on disk, but an open project holds it decrypted in RAM. Returns one entry per network: its coil, storage mode (none/set/reset), and a `terms` AND-chain where each term is a contact, a resolved compare block (\"=\"/\"<>\"/relational, with its operands), a nested `or` of parallel AND-chains (a real branch, not flattened), or an explicit `unknown` for anything the reader could not resolve (e.g. a library/timer function block) -- surfaced rather than silently dropped. The full JSON is written to a file. Open the project in DIADesigner first.", {
        titleMatch: zod_1.z.string().optional().describe("Substring of the DIADesigner window title to pick the right instance (e.g. the project name)"),
        pid: zod_1.z.number().int().optional().describe("Explicit DIADesigner process id (overrides titleMatch)"),
        outputFile: zod_1.z.string().optional().describe("Where to write the full JSON (default: <workspace>/program_memory.json)"),
        maxNetworks: zod_1.z.number().int().min(1).max(20000).optional(),
        onlyCommented: zod_1.z.boolean().optional().describe("Only include networks that have a comment"),
        sampleSize: zod_1.z.number().int().min(0).max(200).optional().describe("How many networks to include inline in the response (default 25)")
    }, async ({ titleMatch, pid, outputFile, maxNetworks, onlyCommented, sampleSize }) => guard(async () => {
        const outFile = outputFile
            ? (0, interop_js_1.resolveWorkspacePath)(config.workspaceDir, outputFile)
            : path.join(config.workspaceDir, "program_memory.json");
        const result = await (0, bridge_js_1.readProgramMemory)(config, {
            titleMatch,
            pid,
            outputFile: outFile,
            maxNetworks,
            onlyCommented
        });
        if (!result.ok)
            return result;
        // Trim the inline response: full data is in the file.
        const nets = Array.isArray(result.networks) ? result.networks : [];
        const n = sampleSize ?? 25;
        return {
            ok: true,
            pid: result.pid,
            processTitle: result.processTitle,
            outputFile: result.outputFile,
            stats: result.stats,
            networksEmitted: result.networksEmitted,
            variableCount: Array.isArray(result.variables) ? result.variables.length : 0,
            sampleNetworks: nets.slice(0, n),
            note: "Full program written to outputFile. Each network's `terms` is a ready AND-chain (with nested `or` for real parallel branches and resolved `compare` blocks); an `unknown` term means that piece needs manual review."
        };
    }));
    server.tool("list_live_pous", "Lists every POU resident in a running DIADesigner process's memory (ClrMD, read-only): name, worksheet type (the language signal, e.g. LDWorkSheet/STWorkSheet), and that POU's own network count (from its UI/canvas layer, reliably scoped to it). Useful to plan work across a project's POUs and to see which are Ladder vs already ST. NOTE: read_program_memory / convert_ld_to_st cannot yet isolate one POU's networks by name -- use coilPattern there to filter by the coils' naming convention instead. Open the project in DIADesigner first.", {
        titleMatch: zod_1.z.string().optional().describe("Substring of the DIADesigner window title to pick the right instance"),
        pid: zod_1.z.number().int().optional().describe("Explicit DIADesigner process id (overrides titleMatch)")
    }, async ({ titleMatch, pid }) => guard(async () => (0, bridge_js_1.listLivePous)(config, { titleMatch, pid })));
    server.tool("convert_ld_to_st", "Converts the open project's Ladder program to Structured Text and writes a .st document. Reads the DECRYPTED program from the running DIADesigner's memory (ClrMD), then reconstructs each rung from its real grid: series contacts AND, parallel branches OR (nested, not flattened), SET/RST and rising/falling edges convert exactly, and \"=\"/\"<>\"/relational compare blocks resolve to their actual operands (e.g. `(nr_programu_st1 = 8)`). Anything unrecognized (e.g. a library/timer function block) is left as a visible `(* UNRESOLVED: ... *)` marker instead of being silently dropped or mis-flattened. Use coilPattern to isolate one station/POU's outputs. Open the project in DIADesigner first.", {
        titleMatch: zod_1.z.string().optional().describe("Substring of the DIADesigner window title (e.g. the project name)"),
        pid: zod_1.z.number().int().optional().describe("Explicit DIADesigner process id (overrides titleMatch)"),
        outputFile: zod_1.z.string().optional().describe("Where to write the .st (default: <workspace>/converted.st)"),
        coilPattern: zod_1.z.string().optional().describe("Case-insensitive regex; keep only networks whose coil variable matches (e.g. 'stacja6|_st6')"),
        pouName: zod_1.z.string().optional().describe("Name for the generated PROGRAM POU (default: CONVERTED_ST)")
    }, async ({ titleMatch, pid, outputFile, coilPattern, pouName }) => guard(async () => {
        const outFile = outputFile
            ? (0, interop_js_1.resolveWorkspacePath)(config.workspaceDir, outputFile)
            : path.join(config.workspaceDir, "converted.st");
        return (0, bridge_js_1.convertLdToSt)(config, { titleMatch, pid, outputFile: outFile, coilPattern, pouName });
    }));
    // ------------------------------------------------- program content (PLCopen) ---
    server.tool("list_pous", "Lists the POUs in a PLCopen .EXPORT file with their type, body language and variable counts.", { exportPath: zod_1.z.string() }, async ({ exportPath }) => guard(async () => (0, plcopen_js_1.listPous)(config, exportPath)));
    server.tool("get_pou", "Reads one POU: declared variables, Structured Text source, and the raw interface and body XML.", { exportPath: zod_1.z.string(), name: zod_1.z.string() }, async ({ exportPath, name }) => guard(async () => (0, plcopen_js_1.getPou)(config, exportPath, name)));
    server.tool("create_pou", "Creates or replaces a POU (program, functionBlock or function) with its variable declarations and Structured Text body.", {
        exportPath: zod_1.z.string(),
        name: zod_1.z.string(),
        pouType: zod_1.z.enum(["program", "functionBlock", "function"]),
        returnType: zod_1.z.string().optional().describe("Required for function POUs"),
        inputVars: zod_1.z.array(variableSchema).optional(),
        outputVars: zod_1.z.array(variableSchema).optional(),
        inOutVars: zod_1.z.array(variableSchema).optional(),
        localVars: zod_1.z.array(variableSchema).optional(),
        code: zod_1.z.string().optional().describe("Structured Text body"),
        overwrite: zod_1.z.boolean().optional(),
        backup: zod_1.z.boolean().optional()
    }, async (args) => guard(async () => (0, plcopen_js_1.createPou)(config, args.exportPath, args)));
    server.tool("delete_pou", "Removes a POU from a PLCopen .EXPORT file.", { exportPath: zod_1.z.string(), name: zod_1.z.string(), backup: zod_1.z.boolean().optional() }, async ({ exportPath, name, backup }) => guard(async () => (0, plcopen_js_1.deletePou)(config, exportPath, name, backup)));
    server.tool("set_pou_code", "Replaces a POU body with generated Structured Text.", {
        exportPath: zod_1.z.string(),
        name: zod_1.z.string(),
        code: zod_1.z.string(),
        backup: zod_1.z.boolean().optional()
    }, async ({ exportPath, name, code, backup }) => guard(async () => (0, plcopen_js_1.setPouCode)(config, exportPath, name, code, backup)));
    server.tool("set_pou_body_xml", "Replaces a POU body with an exact <body>...</body> element. Use this for LD, FBD, SFC or CFC bodies that must be preserved verbatim.", {
        exportPath: zod_1.z.string(),
        name: zod_1.z.string(),
        bodyXml: zod_1.z.string(),
        backup: zod_1.z.boolean().optional()
    }, async ({ exportPath, name, bodyXml, backup }) => guard(async () => (0, plcopen_js_1.setPouBodyXml)(config, exportPath, name, bodyXml, backup)));
    server.tool("declare_variables", "Declares variables on a POU interface. Appends to the existing group of that kind when one is present, so the file keeps DIADesigner's own layout.", {
        exportPath: zod_1.z.string(),
        pouName: zod_1.z.string(),
        kind: zod_1.z.enum(["inputVars", "outputVars", "inOutVars", "localVars", "tempVars"]),
        variables: zod_1.z.array(variableSchema).min(1),
        replaceExisting: zod_1.z.boolean().optional().describe("Redeclare variables that already exist"),
        backup: zod_1.z.boolean().optional()
    }, async ({ exportPath, pouName, kind, variables, replaceExisting, backup }) => guard(async () => (0, plcopen_js_1.declareVariables)(config, exportPath, pouName, kind, variables, { replaceExisting, backup })));
    server.tool("list_variables", "Lists every variable declared on a POU interface.", { exportPath: zod_1.z.string(), pouName: zod_1.z.string() }, async ({ exportPath, pouName }) => guard(async () => {
        const pou = await (0, plcopen_js_1.getPou)(config, exportPath, pouName);
        return { path: pou.path, pou: pou.name, variables: pou.variables };
    }));
    server.tool("list_global_variables", "Lists global variable groups declared in a PLCopen .EXPORT file.", { exportPath: zod_1.z.string() }, async ({ exportPath }) => guard(async () => (0, plcopen_js_1.listGlobalVariables)(config, exportPath)));
    server.tool("list_structures", "Lists STRUCT data types and their fields.", { exportPath: zod_1.z.string() }, async ({ exportPath }) => guard(async () => (0, plcopen_js_1.listStructures)(config, exportPath)));
    server.tool("create_structure", "Creates or replaces a STRUCT data type.", {
        exportPath: zod_1.z.string(),
        name: zod_1.z.string(),
        fields: zod_1.z.array(variableSchema).min(1),
        overwrite: zod_1.z.boolean().optional(),
        backup: zod_1.z.boolean().optional()
    }, async ({ exportPath, name, fields, overwrite, backup }) => guard(async () => (0, plcopen_js_1.createStructure)(config, exportPath, { name, fields, overwrite, backup })));
    server.tool("create_empty_export", "Creates an empty PLCopen .EXPORT document to build a program from scratch.", { targetPath: zod_1.z.string() }, async ({ targetPath }) => guard(async () => (0, plcopen_js_1.createEmptyExport)(config, targetPath)));
    server.tool("export_objects", "Writes selected POUs and data types into a new .EXPORT file that DIADesigner can import.", {
        sourceExportPath: zod_1.z.string(),
        targetPath: zod_1.z.string(),
        pous: zod_1.z.array(zod_1.z.string()).optional(),
        dataTypes: zod_1.z.array(zod_1.z.string()).optional()
    }, async ({ sourceExportPath, targetPath, pous, dataTypes }) => guard(async () => (0, plcopen_js_1.exportObjects)(config, sourceExportPath, targetPath, { pous, dataTypes })));
    server.tool("import_objects", "Merges POUs and data types from another .EXPORT file into this one.", {
        targetExportPath: zod_1.z.string(),
        sourceExportPath: zod_1.z.string(),
        pous: zod_1.z.array(zod_1.z.string()).optional().describe("Defaults to every POU in the source"),
        dataTypes: zod_1.z.array(zod_1.z.string()).optional(),
        overwrite: zod_1.z.boolean().optional(),
        backup: zod_1.z.boolean().optional()
    }, async ({ targetExportPath, sourceExportPath, pous, dataTypes, overwrite, backup }) => guard(async () => (0, plcopen_js_1.importObjects)(config, targetExportPath, sourceExportPath, { pous, dataTypes, overwrite, backup })));
    // ------------------------------------------------------------- DiaTag ------
    server.tool("list_symbol_structures", "Lists STRUCT types in the DiaTag symbol configuration. Accepts a .diade path, a project directory, or the DiaTag XML path.", { projectOrSymbolPath: zod_1.z.string() }, async ({ projectOrSymbolPath }) => guard(async () => (0, symbols_js_1.listSymbolStructures)(config, projectOrSymbolPath)));
    server.tool("list_symbol_global_nodes", "Lists DiaTag global nodes with the D-register range each one occupies.", { projectOrSymbolPath: zod_1.z.string() }, async ({ projectOrSymbolPath }) => guard(async () => (0, symbols_js_1.listSymbolGlobalNodes)(config, projectOrSymbolPath)));
    server.tool("find_free_d_range", "Finds free D-register ranges, using the real declared type sizes.", {
        projectOrSymbolPath: zod_1.z.string(),
        requiredBytes: zod_1.z.number().int().min(1),
        preferredDAddress: zod_1.z.number().int().min(0).optional(),
        minD: zod_1.z.number().int().min(0).optional(),
        maxD: zod_1.z.number().int().min(0).optional()
    }, async ({ projectOrSymbolPath, requiredBytes, preferredDAddress, minD, maxD }) => guard(async () => (0, symbols_js_1.findFreeDRange)(config, projectOrSymbolPath, requiredBytes, preferredDAddress, minD, maxD)));
    server.tool("create_symbol_structure", "Creates or replaces a STRUCT type in the DiaTag symbol configuration.", {
        projectOrSymbolPath: zod_1.z.string(),
        name: zod_1.z.string(),
        fields: zod_1.z.array(zod_1.z.object({ name: zod_1.z.string(), type: zod_1.z.string() })).min(1),
        overwrite: zod_1.z.boolean().optional(),
        backup: zod_1.z.boolean().optional()
    }, async ({ projectOrSymbolPath, name, fields, overwrite, backup }) => guard(async () => (0, symbols_js_1.createSymbolStructure)(config, projectOrSymbolPath, { name, fields, overwrite, backup })));
    server.tool("create_symbol_global_node", "Declares a global DiaTag node in Default_Tag_Table, picking a D address from the free ranges.", {
        projectOrSymbolPath: zod_1.z.string(),
        name: zod_1.z.string(),
        typeName: zod_1.z.string(),
        preferredDAddress: zod_1.z.number().int().min(0).optional(),
        useNextFree: zod_1.z.boolean().optional(),
        backup: zod_1.z.boolean().optional()
    }, async ({ projectOrSymbolPath, name, typeName, preferredDAddress, useNextFree, backup }) => guard(async () => (0, symbols_js_1.createSymbolGlobalNode)(config, projectOrSymbolPath, {
        name,
        typeName,
        preferredDAddress,
        useNextFree,
        backup
    })));
    return server;
}
async function startServer(config) {
    const server = createServer(config);
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error("DIADESIGNER14 MCP server connected via stdio.");
}
