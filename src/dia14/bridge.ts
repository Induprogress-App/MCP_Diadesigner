/**
 * Node-side wrapper around bridge/DeltaBridge.ps1.
 *
 * The Delta assemblies are x86 and print diagnostics to stdout, so the bridge is
 * invoked through the 32-bit PowerShell host and hands its result back through a
 * temp file rather than through the pipe.
 */

import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { DiaConfig, getInstallDir, resolveWorkspacePath, runCommand } from "./interop.js";
import { buildStDocument, LdNetwork, StBuildResult } from "./ldToSt.js";

/** 32-bit Windows PowerShell; the DIADesigner assemblies will not load in x64. */
export const POWERSHELL_X86 = "C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe";
const POWERSHELL_ANY = "powershell.exe";

export interface BridgeResult {
  ok: boolean;
  [key: string]: unknown;
}

function bridgeScriptPath(): string {
  // dist14/bridge.js -> ../bridge/DeltaBridge.ps1
  const candidates = [
    path.resolve(__dirname, "..", "bridge", "DeltaBridge.ps1"),
    path.resolve(__dirname, "..", "..", "bridge", "DeltaBridge.ps1")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `DeltaBridge.ps1 not found. Looked in: ${candidates.join(", ")}`
  );
}

function powerShellHost(): string {
  return fs.existsSync(POWERSHELL_X86) ? POWERSHELL_X86 : POWERSHELL_ANY;
}

export async function callBridge(
  config: DiaConfig,
  command: string,
  options: { path?: string; arg?: string; timeoutMs?: number } = {}
): Promise<BridgeResult> {
  const script = bridgeScriptPath();
  const installDir = getInstallDir(config);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dia-bridge-"));
  const outFile = path.join(tempDir, "result.json");

  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Command",
    command,
    "-InstallDir",
    installDir,
    "-Out",
    outFile
  ];
  if (options.path) args.push("-Path", options.path);
  if (options.arg) args.push("-Arg", options.arg);

  try {
    const result = await runCommand(powerShellHost(), args, {
      cwd: installDir,
      timeoutMs: options.timeoutMs ?? 120000,
      maxOutputBytes: 2 * 1024 * 1024
    });

    let raw: string;
    try {
      raw = await readFile(outFile, "utf8");
    } catch {
      throw new Error(
        `Bridge produced no result. exit=${result.code} stderr=${result.stderr.trim().slice(0, 500)} stdout=${result.stdout.trim().slice(0, 500)}`
      );
    }
    try {
      return JSON.parse(raw) as BridgeResult;
    } catch {
      throw new Error(`Bridge returned malformed JSON: ${raw.slice(0, 500)}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function guiScriptPath(): string {
  const candidates = [
    path.resolve(__dirname, "..", "bridge", "DiaExportGui.ps1"),
    path.resolve(__dirname, "..", "..", "bridge", "DiaExportGui.ps1")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`DiaExportGui.ps1 not found. Looked in: ${candidates.join(", ")}`);
}

function memoryReaderScriptPath(): string {
  const candidates = [
    path.resolve(__dirname, "..", "bridge", "DiaMemoryReader.ps1"),
    path.resolve(__dirname, "..", "..", "bridge", "DiaMemoryReader.ps1")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`DiaMemoryReader.ps1 not found. Looked in: ${candidates.join(", ")}`);
}

/** Finds a running 32-bit DIADesigner process, optionally matching a title substring. */
async function findDiaDesignerPid(titleMatch?: string): Promise<{ pid: number; title: string } | null> {
  const filter = titleMatch ? `-and $_.MainWindowTitle -like '*${titleMatch.replace(/'/g, "''")}*'` : "";
  const cmd =
    `Get-Process DIADesigner -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.MainWindowTitle -ne '' ${filter} } | ` +
    `Sort-Object StartTime | Select-Object -Last 1 | ` +
    `ForEach-Object { $_.Id.ToString() + '|' + $_.MainWindowTitle }`;
  const result = await runCommand(POWERSHELL_ANY, ["-NoProfile", "-NonInteractive", "-Command", cmd], {
    timeoutMs: 20000,
    maxOutputBytes: 8192
  });
  const line = result.stdout.trim();
  if (!line) return null;
  const sep = line.indexOf("|");
  const pid = Number(sep >= 0 ? line.slice(0, sep) : line);
  if (!Number.isFinite(pid)) return null;
  return { pid, title: sep >= 0 ? line.slice(sep + 1) : "" };
}

export interface MemoryReadResult extends BridgeResult {
  pid?: number;
  processTitle?: string;
  outputFile?: string;
}

export interface LivePou {
  name: string;
  /** Runtime type of the POU's code worksheet (e.g. "LDWorkSheet", "STWorkSheet") -- the language signal. */
  worksheet: string;
  /**
   * Network count from the POU's own UI/canvas layer (POU.codeBody.codeWorkSheet.graphicCanvasData._networks),
   * which is reliably scoped to that POU. There is currently no supported way to pull the matching
   * IspProject.NetWorkData objects for one POU in isolation -- see read_program_memory's pouName limitation.
   */
  networkCount: number;
}

export interface ListLivePousResult extends BridgeResult {
  pid?: number;
  processTitle?: string;
  pous?: LivePou[];
}

/**
 * Lists every POU resident in a running DIADesigner process's memory: name,
 * worksheet type (the language signal -- LDWorkSheet/STWorkSheet/...), and its
 * own network count. Read-only (ClrMD). Useful to plan work across a project's
 * POUs even though read_program_memory/convert_ld_to_st can't yet isolate one
 * POU's networks by name (use coilPattern there instead).
 */
export async function listLivePous(
  config: DiaConfig,
  options: { titleMatch?: string; pid?: number } = {}
): Promise<ListLivePousResult> {
  const script = memoryReaderScriptPath();
  let pid = options.pid;
  let title = "";
  if (!pid) {
    const found = await findDiaDesignerPid(options.titleMatch);
    if (!found) {
      return { ok: false, error: "No running DIADesigner window found. Open the project in DIADesigner first." };
    }
    pid = found.pid;
    title = found.title;
  }

  const outFile = path.join(os.tmpdir(), `dia14-pous-${pid}-${Date.now()}.json`);
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-TargetPid",
    String(pid),
    "-Out",
    outFile,
    "-ListPous"
  ];
  const result = await runCommand(POWERSHELL_X86, args, {
    cwd: getInstallDir(config),
    timeoutMs: 300000,
    maxOutputBytes: 1024 * 1024,
    env: { TEMP: os.tmpdir(), TMP: os.tmpdir() }
  });

  let raw: string;
  try {
    raw = await readFile(outFile, "utf8");
  } catch {
    throw new Error(
      `Memory reader produced no result. exit=${result.code} stderr=${result.stderr.trim().slice(0, 400)}`
    );
  } finally {
    try {
      await rm(outFile, { force: true });
    } catch {
      // best-effort cleanup
    }
  }

  let pous: LivePou[];
  try {
    pous = JSON.parse(raw) as LivePou[];
  } catch {
    return { ok: false, error: `Memory reader returned malformed JSON: ${raw.slice(0, 400)}`, pid, processTitle: title };
  }
  return { ok: true, pid, processTitle: title, pous };
}

/**
 * Reads the decrypted Ladder program out of a running DIADesigner process's heap
 * (via ClrMD, read-only). The project must be open in DIADesigner. Returns the
 * networks/variables and also writes the full JSON to `outputFile`.
 */
export async function readProgramMemory(
  config: DiaConfig,
  options: { titleMatch?: string; pid?: number; outputFile: string; maxNetworks?: number; onlyCommented?: boolean } = { outputFile: "" }
): Promise<MemoryReadResult> {
  const script = memoryReaderScriptPath();
  let pid = options.pid;
  let title = "";
  if (!pid) {
    const found = await findDiaDesignerPid(options.titleMatch);
    if (!found) {
      return { ok: false, error: "No running DIADesigner window found. Open the project in DIADesigner first." };
    }
    pid = found.pid;
    title = found.title;
  }

  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-TargetPid",
    String(pid),
    "-Out",
    options.outputFile,
    "-MaxNetworks",
    String(options.maxNetworks ?? 8000)
  ];
  if (options.onlyCommented) args.push("-OnlyCommented");

  // ClrMD must attach from a 32-bit host to match the x86 DIADesigner process.
  // Point the child's temp at the output directory: the reader compiles C# via
  // CodeDom (Add-Type), which needs writable temp, and the system drive may be
  // full. Fall back to the workspace dir when the output has no directory part.
  const scratch = path.dirname(path.resolve(config.workspaceDir, options.outputFile)) || config.workspaceDir;
  const result = await runCommand(POWERSHELL_X86, args, {
    cwd: getInstallDir(config),
    timeoutMs: 300000,
    maxOutputBytes: 1024 * 1024,
    env: { TEMP: scratch, TMP: scratch }
  });

  let raw: string;
  try {
    raw = await readFile(options.outputFile, "utf8");
  } catch {
    throw new Error(
      `Memory reader produced no result. exit=${result.code} stderr=${result.stderr.trim().slice(0, 400)}`
    );
  }
  let parsed: MemoryReadResult;
  try {
    parsed = JSON.parse(raw) as MemoryReadResult;
  } catch {
    throw new Error(`Memory reader returned malformed JSON: ${raw.slice(0, 400)}`);
  }
  parsed.pid = pid;
  parsed.processTitle = title;
  parsed.outputFile = options.outputFile;
  return parsed;
}

export interface LdToStResult extends BridgeResult {
  pid?: number;
  processTitle?: string;
  outputFile?: string;
  stats?: StBuildResult["stats"];
  coils?: string[];
}

/**
 * Reads the open project's Ladder program from memory and converts it to
 * Structured Text, writing the .st document to `outputFile`. Optionally limits
 * the output to networks whose coil variable matches `coilPattern` (so a single
 * station / POU's logic can be isolated).
 */
export async function convertLdToSt(
  config: DiaConfig,
  options: {
    titleMatch?: string;
    pid?: number;
    outputFile: string;
    coilPattern?: string;
    pouName?: string;
  }
): Promise<LdToStResult> {
  const resolvedOut = resolveWorkspacePath(config.workspaceDir, options.outputFile);
  // Keep the intermediate JSON next to the output rather than in the system temp
  // dir: the machine's system drive can be full, and the workspace drive is the
  // one the caller already writes to.
  const jsonFile = resolvedOut + ".networks.json";
  try {
    const mem = await readProgramMemory(config, {
      titleMatch: options.titleMatch,
      pid: options.pid,
      outputFile: jsonFile,
      maxNetworks: 8000
    });
    if (!mem.ok) return { ok: false, error: mem.error, pid: mem.pid, processTitle: mem.processTitle };

    const networks = (mem.networks as LdNetwork[] | undefined) ?? [];
    const built = buildStDocument(networks, {
      coilPattern: options.coilPattern,
      pouName: options.pouName
    });
    await writeFile(resolvedOut, built.document, "utf8");
    return {
      ok: true,
      pid: mem.pid,
      processTitle: mem.processTitle,
      outputFile: resolvedOut,
      stats: built.stats,
      coils: built.coils
    };
  } finally {
    await rm(jsonFile, { force: true }).catch(() => {});
  }
}

/**
 * Exports the project's program to a native .export by driving DIADesigner's GUI
 * (there is no headless export). Requires an interactive, unlocked desktop.
 *
 * Runs under the normal (64-bit) PowerShell host, not the x86 one the assembly
 * bridge uses: this path only touches UIAutomation + user32, which work in both,
 * and the GUI it drives is the running 64-bit... (actually 32-bit) app either way.
 */
export async function exportProjectGui(
  config: DiaConfig,
  projectDiade: string,
  exportPath: string,
  timeoutSec = 240
): Promise<BridgeResult> {
  const script = guiScriptPath();
  const installDir = getInstallDir(config);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dia-export-"));
  const outFile = path.join(tempDir, "result.json");
  const resolvedProject = resolveWorkspacePath(config.workspaceDir, projectDiade);
  const resolvedExport = resolveWorkspacePath(config.workspaceDir, exportPath);

  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-DiaExe",
    config.diadesignerPath,
    "-ProjectDiade",
    resolvedProject,
    "-OutFile",
    outFile,
    "-ExportPath",
    resolvedExport,
    "-TimeoutSec",
    String(timeoutSec)
  ];

  try {
    const result = await runCommand(POWERSHELL_ANY, args, {
      cwd: installDir,
      timeoutMs: (timeoutSec + 60) * 1000,
      maxOutputBytes: 2 * 1024 * 1024
    });
    let raw: string;
    try {
      raw = await readFile(outFile, "utf8");
    } catch {
      throw new Error(
        `Export driver produced no result. exit=${result.code} stderr=${result.stderr.trim().slice(0, 500)}`
      );
    }
    try {
      return JSON.parse(raw) as BridgeResult;
    } catch {
      throw new Error(`Export driver returned malformed JSON: ${raw.slice(0, 500)}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function bridgeDetect(config: DiaConfig): Promise<BridgeResult> {
  return callBridge(config, "detect", { timeoutMs: 60000 });
}

export async function readNativeProject(
  config: DiaConfig,
  projectPath: string
): Promise<BridgeResult> {
  return callBridge(config, "read-project", {
    path: resolveWorkspacePath(config.workspaceDir, projectPath),
    timeoutMs: 60000
  });
}

export async function readProgramHeader(
  config: DiaConfig,
  programPath: string
): Promise<BridgeResult> {
  return callBridge(config, "program-header", {
    path: resolveWorkspacePath(config.workspaceDir, programPath),
    timeoutMs: 60000
  });
}

export async function loadProgram(
  config: DiaConfig,
  programPath: string
): Promise<BridgeResult> {
  return callBridge(config, "load-program", {
    path: resolveWorkspacePath(config.workspaceDir, programPath),
    timeoutMs: 180000
  });
}

export async function compileProgram(
  config: DiaConfig,
  programPath: string,
  mode: "compile" | "check" = "compile"
): Promise<BridgeResult> {
  return callBridge(config, "compile", {
    path: resolveWorkspacePath(config.workspaceDir, programPath),
    arg: mode,
    timeoutMs: 300000
  });
}
