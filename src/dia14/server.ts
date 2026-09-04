/**
 * MCP server for Delta DIADesigner 1.14.
 *
 * Tools are grouped by the layer they act on:
 *   installation/workspace -> plain filesystem + install layout
 *   native project         -> Delta .NET assemblies through bridge/DeltaBridge.ps1
 *   program content        -> PLCopen .EXPORT XML (read, edit, create, compile via import)
 *   symbols                -> DiaTag Symbolconfiguration XML
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  DiaConfig,
  createProjectBackup,
  detectInstallation,
  extractProjectArchive,
  formatAsJson,
  inspectProjectFile,
  launchDiaDesigner,
  listArchiveEntries,
  listDeviceCatalog,
  resolveWorkspacePath,
  scanWorkspaceProjects
} from "./interop.js";
import {
  bridgeDetect,
  compileProgram,
  convertLdToSt,
  exportProjectGui,
  loadProgram,
  readNativeProject,
  readProgramHeader,
  readProgramMemory
} from "./bridge.js";
import * as path from "path";
import {
  createEmptyExport,
  createPou,
  createStructure,
  declareVariables,
  deletePou,
  exportObjects,
  getPou,
  importObjects,
  listGlobalVariables,
  listPous,
  listStructures,
  setPouBodyXml,
  setPouCode
} from "./plcopen.js";
import {
  createSymbolGlobalNode,
  createSymbolStructure,
  findFreeDRange,
  listSymbolGlobalNodes,
  listSymbolStructures
} from "./symbols.js";

const variableSchema = z.object({
  name: z.string().describe("IEC identifier"),
  type: z.string().describe("IEC type, e.g. BOOL, INT, REAL, STRING(20), ARRAY[0..9] OF INT, or a user type name"),
  initialValue: z.string().optional(),
  address: z.string().optional().describe("Direct address, e.g. %MW100"),
  documentation: z.string().optional()
});

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: formatAsJson(value) }] };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

async function guard<T>(fn: () => Promise<T>) {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(error);
  }
}

export function createServer(config: DiaConfig): McpServer {
  const server = new McpServer(
    { name: "Delta DIADesigner 1.14 MCP Server", version: "0.2.0" },
    {
      capabilities: { resources: { listChanged: true }, tools: { listChanged: true } },
      instructions: [
        "Automates Delta DIADesigner 1.14.",
        "Program content is read and written through PLCopen .EXPORT XML: export from DIADesigner, edit here, import back.",
        "Native .diade containers can be read directly (1.14 format only); 1.13 projects must be migrated in the UI first."
      ].join(" ")
    }
  );

  // ------------------------------------------------------------- resources ---

  server.resource(
    "diadesigner-installation-status",
    "diadesigner://installation/status",
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "application/json", text: formatAsJson(await detectInstallation(config)) }
      ]
    })
  );

  server.resource(
    "diadesigner-workspace-projects",
    "diadesigner://workspace/projects",
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: formatAsJson(await scanWorkspaceProjects(config.workspaceDir))
        }
      ]
    })
  );

  server.resource(
    "diadesigner-export-structure",
    new ResourceTemplate("diadesigner://export/{+export_path}/structure", { list: undefined }),
    async (uri, params) => {
      const exportPath = decodeURIComponent(String(params.export_path));
      const pous = await listPous(config, exportPath);
      const structures = await listStructures(config, exportPath);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: formatAsJson({ ...pous, ...structures })
          }
        ]
      };
    }
  );

  // --------------------------------------------- installation and workspace ---

  server.tool(
    "detect_installation",
    "Detects the local DIADesigner installation: executable, version, helper tools and the .NET assemblies the native bridge needs.",
    {},
    async () => guard(async () => detectInstallation(config))
  );

  server.tool(
    "check_bridge",
    "Verifies that the native .NET bridge can load DIADesigner's own assemblies. Run this first when native project tools misbehave.",
    {},
    async () => guard(async () => bridgeDetect(config))
  );

  server.tool(
    "scan_workspace_projects",
    "Finds DIADesigner projects and PLCopen exports (.diade, .EXPORT, .isp, ...) under the workspace.",
    {
      startDir: z.string().optional().describe("Directory to scan, relative to the workspace"),
      maxDepth: z.number().int().min(1).max(12).optional(),
      maxResults: z.number().int().min(1).max(500).optional()
    },
    async ({ startDir, maxDepth, maxResults }) =>
      guard(async () => scanWorkspaceProjects(config.workspaceDir, startDir, maxDepth, maxResults))
  );

  server.tool(
    "inspect_file",
    "Classifies a project-like file: container format, whether it is a 1.13 or 1.14 native project, and archive contents when applicable.",
    {
      filePath: z.string(),
      maxEntries: z.number().int().min(1).max(2000).optional()
    },
    async ({ filePath, maxEntries }) =>
      guard(async () => inspectProjectFile(config, filePath, true, maxEntries))
  );

  server.tool(
    "list_archive_entries",
    "Lists entries inside an archive-like file using DIADesigner's bundled 7-Zip helper.",
    { filePath: z.string(), maxEntries: z.number().int().min(1).max(2000).optional() },
    async ({ filePath, maxEntries }) =>
      guard(async () => listArchiveEntries(config, filePath, maxEntries))
  );

  server.tool(
    "extract_archive",
    "Extracts an archive-like project file into a directory for inspection.",
    { filePath: z.string(), outputDir: z.string() },
    async ({ filePath, outputDir }) =>
      guard(async () => extractProjectArchive(config, filePath, outputDir))
  );

  server.tool(
    "create_backup",
    "Creates a timestamped copy of a file next to it.",
    { filePath: z.string() },
    async ({ filePath }) => guard(async () => createProjectBackup(config.workspaceDir, filePath))
  );

  server.tool(
    "list_device_catalog",
    "Lists the device and resource catalogs present in the DIADesigner installation.",
    {},
    async () => guard(async () => listDeviceCatalog(config))
  );

  server.tool(
    "resolve_path",
    "Resolves a path against the configured workspace.",
    { inputPath: z.string() },
    async ({ inputPath }) =>
      guard(async () => ({
        inputPath,
        resolvedPath: resolveWorkspacePath(config.workspaceDir, inputPath)
      }))
  );

  server.tool(
    "open_in_diadesigner",
    "Launches the DIADesigner UI, optionally on a project.",
    { projectPath: z.string().optional() },
    async ({ projectPath }) => guard(async () => launchDiaDesigner(config, projectPath))
  );

  // ------------------------------------------------------- native project ----

  server.tool(
    "read_native_project",
    "Decrypts a native .diade project container and returns its solution and device tree. Works on DIADesigner 1.14 containers; 1.13 projects must be migrated first.",
    { projectPath: z.string().describe("Path to the .diade file") },
    async ({ projectPath }) => guard(async () => readNativeProject(config, projectPath))
  );

  server.tool(
    "read_program_header",
    "Parses the header of a PLC.prog / PLC.diaobj program container (version, project offsets, executable code size).",
    { programPath: z.string() },
    async ({ programPath }) => guard(async () => readProgramHeader(config, programPath))
  );

  server.tool(
    "read_program",
    "Loads a PLC program container through DIADesigner's own loader and lists the POUs and data types it contains.",
    { programPath: z.string().describe("Path to PLC.prog or PLC.diaobj") },
    async ({ programPath }) => guard(async () => loadProgram(config, programPath))
  );

  server.tool(
    "compile_program",
    "Compiles (or only syntax-checks) a PLC program container using DIADesigner's ISP compiler.",
    {
      programPath: z.string(),
      mode: z.enum(["compile", "check"]).optional().describe("check runs validation only; default is compile")
    },
    async ({ programPath, mode }) => guard(async () => compileProgram(config, programPath, mode ?? "compile"))
  );

  server.tool(
    "export_project",
    "Drives the DIADesigner GUI to export a project's whole program to a native .export file (there is no headless export). Requires an interactive, unlocked Windows desktop; reuses an already-open instance of the project or launches one.",
    {
      projectPath: z.string().describe("Path to the .diade project file"),
      exportPath: z.string().describe("Target .export file to write"),
      timeoutSec: z.number().int().min(30).max(600).optional()
    },
    async ({ projectPath, exportPath, timeoutSec }) =>
      guard(async () => exportProjectGui(config, projectPath, exportPath, timeoutSec ?? 240))
  );

  server.tool(
    "read_program_memory",
    "Reads the DECRYPTED Ladder program out of a running DIADesigner process's memory (ClrMD, read-only). DIADesigner keeps program logic AES-encrypted on disk, but an open project holds it decrypted in RAM. Returns networks (comment + contacts/coils/blocks with variables, NC/NO, edge, storage) and all variables; the full JSON is written to a file. Open the project in DIADesigner first.",
    {
      titleMatch: z.string().optional().describe("Substring of the DIADesigner window title to pick the right instance (e.g. the project name)"),
      pid: z.number().int().optional().describe("Explicit DIADesigner process id (overrides titleMatch)"),
      outputFile: z.string().optional().describe("Where to write the full JSON (default: <workspace>/program_memory.json)"),
      maxNetworks: z.number().int().min(1).max(20000).optional(),
      onlyCommented: z.boolean().optional().describe("Only include networks that have a comment"),
      sampleSize: z.number().int().min(0).max(200).optional().describe("How many networks to include inline in the response (default 25)")
    },
    async ({ titleMatch, pid, outputFile, maxNetworks, onlyCommented, sampleSize }) =>
      guard(async () => {
        const outFile = outputFile
          ? resolveWorkspacePath(config.workspaceDir, outputFile)
          : path.join(config.workspaceDir, "program_memory.json");
        const result = await readProgramMemory(config, {
          titleMatch,
          pid,
          outputFile: outFile,
          maxNetworks,
          onlyCommented
        });
        if (!result.ok) return result;
        // Trim the inline response: full data is in the file.
        const nets = Array.isArray(result.networks) ? (result.networks as unknown[]) : [];
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
          note:
            "Full program written to outputFile. Networks list contacts/coils/blocks per rung; grid topology (exact AND/OR wiring) is not yet reconstructed into expressions."
        };
      })
  );

  server.tool(
    "convert_ld_to_st",
    "Converts the open project's Ladder program to Structured Text and writes a .st document. Reads the DECRYPTED program from the running DIADesigner's memory (ClrMD), then reconstructs each rung: simple/series rungs and SET/RST with rising/falling edges convert exactly; rungs with a parallel branch are AND-combined and flagged (verify AND/OR); rungs driven by a function block are emitted as a note. Use coilPattern to isolate one station/POU's outputs. Open the project in DIADesigner first.",
    {
      titleMatch: z.string().optional().describe("Substring of the DIADesigner window title (e.g. the project name)"),
      pid: z.number().int().optional().describe("Explicit DIADesigner process id (overrides titleMatch)"),
      outputFile: z.string().optional().describe("Where to write the .st (default: <workspace>/converted.st)"),
      coilPattern: z.string().optional().describe("Case-insensitive regex; keep only networks whose coil variable matches (e.g. 'stacja6|_st6')"),
      pouName: z.string().optional().describe("Name for the generated PROGRAM POU (default: CONVERTED_ST)")
    },
    async ({ titleMatch, pid, outputFile, coilPattern, pouName }) =>
      guard(async () => {
        const outFile = outputFile
          ? resolveWorkspacePath(config.workspaceDir, outputFile)
          : path.join(config.workspaceDir, "converted.st");
        return convertLdToSt(config, { titleMatch, pid, outputFile: outFile, coilPattern, pouName });
      })
  );

  // ------------------------------------------------- program content (PLCopen) ---

  server.tool(
    "list_pous",
    "Lists the POUs in a PLCopen .EXPORT file with their type, body language and variable counts.",
    { exportPath: z.string() },
    async ({ exportPath }) => guard(async () => listPous(config, exportPath))
  );

  server.tool(
    "get_pou",
    "Reads one POU: declared variables, Structured Text source, and the raw interface and body XML.",
    { exportPath: z.string(), name: z.string() },
    async ({ exportPath, name }) => guard(async () => getPou(config, exportPath, name))
  );

  server.tool(
    "create_pou",
    "Creates or replaces a POU (program, functionBlock or function) with its variable declarations and Structured Text body.",
    {
      exportPath: z.string(),
      name: z.string(),
      pouType: z.enum(["program", "functionBlock", "function"]),
      returnType: z.string().optional().describe("Required for function POUs"),
      inputVars: z.array(variableSchema).optional(),
      outputVars: z.array(variableSchema).optional(),
      inOutVars: z.array(variableSchema).optional(),
      localVars: z.array(variableSchema).optional(),
      code: z.string().optional().describe("Structured Text body"),
      overwrite: z.boolean().optional(),
      backup: z.boolean().optional()
    },
    async (args) => guard(async () => createPou(config, args.exportPath, args))
  );

  server.tool(
    "delete_pou",
    "Removes a POU from a PLCopen .EXPORT file.",
    { exportPath: z.string(), name: z.string(), backup: z.boolean().optional() },
    async ({ exportPath, name, backup }) => guard(async () => deletePou(config, exportPath, name, backup))
  );

  server.tool(
    "set_pou_code",
    "Replaces a POU body with generated Structured Text.",
    {
      exportPath: z.string(),
      name: z.string(),
      code: z.string(),
      backup: z.boolean().optional()
    },
    async ({ exportPath, name, code, backup }) =>
      guard(async () => setPouCode(config, exportPath, name, code, backup))
  );

  server.tool(
    "set_pou_body_xml",
    "Replaces a POU body with an exact <body>...</body> element. Use this for LD, FBD, SFC or CFC bodies that must be preserved verbatim.",
    {
      exportPath: z.string(),
      name: z.string(),
      bodyXml: z.string(),
      backup: z.boolean().optional()
    },
    async ({ exportPath, name, bodyXml, backup }) =>
      guard(async () => setPouBodyXml(config, exportPath, name, bodyXml, backup))
  );

  server.tool(
    "declare_variables",
    "Declares variables on a POU interface. Appends to the existing group of that kind when one is present, so the file keeps DIADesigner's own layout.",
    {
      exportPath: z.string(),
      pouName: z.string(),
      kind: z.enum(["inputVars", "outputVars", "inOutVars", "localVars", "tempVars"]),
      variables: z.array(variableSchema).min(1),
      replaceExisting: z.boolean().optional().describe("Redeclare variables that already exist"),
      backup: z.boolean().optional()
    },
    async ({ exportPath, pouName, kind, variables, replaceExisting, backup }) =>
      guard(async () =>
        declareVariables(config, exportPath, pouName, kind, variables, { replaceExisting, backup })
      )
  );

  server.tool(
    "list_variables",
    "Lists every variable declared on a POU interface.",
    { exportPath: z.string(), pouName: z.string() },
    async ({ exportPath, pouName }) =>
      guard(async () => {
        const pou = await getPou(config, exportPath, pouName);
        return { path: pou.path, pou: pou.name, variables: pou.variables };
      })
  );

  server.tool(
    "list_global_variables",
    "Lists global variable groups declared in a PLCopen .EXPORT file.",
    { exportPath: z.string() },
    async ({ exportPath }) => guard(async () => listGlobalVariables(config, exportPath))
  );

  server.tool(
    "list_structures",
    "Lists STRUCT data types and their fields.",
    { exportPath: z.string() },
    async ({ exportPath }) => guard(async () => listStructures(config, exportPath))
  );

  server.tool(
    "create_structure",
    "Creates or replaces a STRUCT data type.",
    {
      exportPath: z.string(),
      name: z.string(),
      fields: z.array(variableSchema).min(1),
      overwrite: z.boolean().optional(),
      backup: z.boolean().optional()
    },
    async ({ exportPath, name, fields, overwrite, backup }) =>
      guard(async () => createStructure(config, exportPath, { name, fields, overwrite, backup }))
  );

  server.tool(
    "create_empty_export",
    "Creates an empty PLCopen .EXPORT document to build a program from scratch.",
    { targetPath: z.string() },
    async ({ targetPath }) => guard(async () => createEmptyExport(config, targetPath))
  );

  server.tool(
    "export_objects",
    "Writes selected POUs and data types into a new .EXPORT file that DIADesigner can import.",
    {
      sourceExportPath: z.string(),
      targetPath: z.string(),
      pous: z.array(z.string()).optional(),
      dataTypes: z.array(z.string()).optional()
    },
    async ({ sourceExportPath, targetPath, pous, dataTypes }) =>
      guard(async () => exportObjects(config, sourceExportPath, targetPath, { pous, dataTypes }))
  );

  server.tool(
    "import_objects",
    "Merges POUs and data types from another .EXPORT file into this one.",
    {
      targetExportPath: z.string(),
      sourceExportPath: z.string(),
      pous: z.array(z.string()).optional().describe("Defaults to every POU in the source"),
      dataTypes: z.array(z.string()).optional(),
      overwrite: z.boolean().optional(),
      backup: z.boolean().optional()
    },
    async ({ targetExportPath, sourceExportPath, pous, dataTypes, overwrite, backup }) =>
      guard(async () =>
        importObjects(config, targetExportPath, sourceExportPath, { pous, dataTypes, overwrite, backup })
      )
  );

  // ------------------------------------------------------------- DiaTag ------

  server.tool(
    "list_symbol_structures",
    "Lists STRUCT types in the DiaTag symbol configuration. Accepts a .diade path, a project directory, or the DiaTag XML path.",
    { projectOrSymbolPath: z.string() },
    async ({ projectOrSymbolPath }) =>
      guard(async () => listSymbolStructures(config, projectOrSymbolPath))
  );

  server.tool(
    "list_symbol_global_nodes",
    "Lists DiaTag global nodes with the D-register range each one occupies.",
    { projectOrSymbolPath: z.string() },
    async ({ projectOrSymbolPath }) =>
      guard(async () => listSymbolGlobalNodes(config, projectOrSymbolPath))
  );

  server.tool(
    "find_free_d_range",
    "Finds free D-register ranges, using the real declared type sizes.",
    {
      projectOrSymbolPath: z.string(),
      requiredBytes: z.number().int().min(1),
      preferredDAddress: z.number().int().min(0).optional(),
      minD: z.number().int().min(0).optional(),
      maxD: z.number().int().min(0).optional()
    },
    async ({ projectOrSymbolPath, requiredBytes, preferredDAddress, minD, maxD }) =>
      guard(async () =>
        findFreeDRange(config, projectOrSymbolPath, requiredBytes, preferredDAddress, minD, maxD)
      )
  );

  server.tool(
    "create_symbol_structure",
    "Creates or replaces a STRUCT type in the DiaTag symbol configuration.",
    {
      projectOrSymbolPath: z.string(),
      name: z.string(),
      fields: z.array(z.object({ name: z.string(), type: z.string() })).min(1),
      overwrite: z.boolean().optional(),
      backup: z.boolean().optional()
    },
    async ({ projectOrSymbolPath, name, fields, overwrite, backup }) =>
      guard(async () =>
        createSymbolStructure(config, projectOrSymbolPath, { name, fields, overwrite, backup })
      )
  );

  server.tool(
    "create_symbol_global_node",
    "Declares a global DiaTag node in Default_Tag_Table, picking a D address from the free ranges.",
    {
      projectOrSymbolPath: z.string(),
      name: z.string(),
      typeName: z.string(),
      preferredDAddress: z.number().int().min(0).optional(),
      useNextFree: z.boolean().optional(),
      backup: z.boolean().optional()
    },
    async ({ projectOrSymbolPath, name, typeName, preferredDAddress, useNextFree, backup }) =>
      guard(async () =>
        createSymbolGlobalNode(config, projectOrSymbolPath, {
          name,
          typeName,
          preferredDAddress,
          useNextFree,
          backup
        })
      )
  );

  return server;
}

export async function startServer(config: DiaConfig): Promise<void> {
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("DIADESIGNER14 MCP server connected via stdio.");
}
