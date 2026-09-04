/**
 * Delta DIADesigner 1.14 interop helpers.
 *
 * DIADesigner is Delta software, not a CODESYS profile: there is no
 * `scriptengine` / `runscript` route. Automation happens through
 *  - the installation layout (helper executables, device catalogs),
 *  - Delta's own .NET assemblies driven from PowerShell (see bridge.ts),
 *  - PLCopen `.EXPORT` XML files (see plcopen.ts).
 */

import { spawn } from "child_process";
import { copyFile, mkdir, open, readdir, stat } from "fs/promises";
import * as fs from "fs";
import * as path from "path";

export interface DiaConfig {
  diadesignerPath: string;
  workspaceDir: string;
  sevenZipPath: string;
}

export const DIASTUDIO_ROOTS = [
  "C:\\Program Files (x86)\\Delta Industrial Automation\\DIAStudio",
  "C:\\Program Files\\Delta Industrial Automation\\DIAStudio"
];

/** Newest `DIADesigner <version>` install found on this machine, else null. */
export function findInstalledDiaDesigner(): string | null {
  const candidates: { version: number[]; exe: string }[] = [];
  for (const root of DIASTUDIO_ROOTS) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = /^DIADesigner\s+(\d+)\.(\d+)$/i.exec(entry);
      if (!match) continue; // skips DIADesigner-AX, which is CODESYS-based
      const exe = path.join(root, entry, "DIADesigner.exe");
      if (fs.existsSync(exe)) {
        candidates.push({ version: [Number(match[1]), Number(match[2])], exe });
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1]);
  return candidates[0].exe;
}

export const DEFAULT_DIADESIGNER_EXE =
  process.env.DIADESIGNER_PATH ||
  process.env.DIADESIGNER14_PATH ||
  findInstalledDiaDesigner() ||
  "C:\\Program Files (x86)\\Delta Industrial Automation\\DIAStudio\\DIADesigner 1.14\\DIADesigner.exe";

const PROJECT_EXTENSIONS = [
  ".diade",
  ".isp",
  ".iap",
  ".dsp",
  ".dspx",
  ".dia",
  ".diaproj",
  ".plcproj",
  ".project",
  ".export"
];

const SKIPPED_SCAN_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist14",
  "build",
  "out",
  ".vs",
  ".vscode",
  "$RECYCLE.BIN",
  "System Volume Information"
]);

export function toForwardSlash(value: string): string {
  return value.replace(/\\/g, "/");
}

export function timestampForFileName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("");
}

export function resolveWorkspacePath(workspaceDir: string, inputPath: string): string {
  return path.normalize(
    path.isAbsolute(inputPath) ? inputPath : path.join(workspaceDir, inputPath)
  );
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readFirstBytes(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const result = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number; stdin?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  return await new Promise<CommandResult>((resolve) => {
    let stdoutLength = 0;
    let stderrLength = 0;
    let timedOut = false;
    let truncated = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: options.env ? { ...process.env, ...options.env } : process.env
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutLength += chunk.length;
      if (stdoutLength <= maxOutputBytes) stdoutChunks.push(chunk);
      else {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrLength += chunk.length;
      if (stderrLength <= maxOutputBytes) stderrChunks.push(chunk);
      else {
        truncated = true;
        child.kill();
      }
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        code: null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        truncated,
        error: error.message
      });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        truncated
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin, "utf8");
    }
  });
}

export function getInstallDir(config: DiaConfig): string {
  return path.dirname(config.diadesignerPath || DEFAULT_DIADESIGNER_EXE);
}

export function getSevenZipPath(config: DiaConfig): string {
  if (config.sevenZipPath) return config.sevenZipPath;
  return path.join(getInstallDir(config), "7zTool", "7za.exe");
}

async function getWindowsFileVersion(filePath: string): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const command = `(Get-Item -LiteralPath '${filePath.replace(/'/g, "''")}').VersionInfo.ProductVersion`;
  const result = await runCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { timeoutMs: 15000, maxOutputBytes: 8192 }
  );
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

async function findFirstExe(directoryPath: string): Promise<string | null> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) {
        return path.join(directoryPath, entry.name);
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function listProjectFileAssemblies(installDir: string): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await readdir(installDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (/^(Delta\.PLC\.ProjectFile\.V\d+|DeltaIA\.DIAStudio\.ProjectFile(\.Latest)?)\.dll$/i.test(entry.name)) {
        result.push(path.join(installDir, entry.name));
      }
    }
  } catch {
    return result;
  }
  result.sort();
  return result;
}

export interface InstallationInfo {
  executablePath: string;
  executableExists: boolean;
  installDir: string;
  productVersion: string | null;
  majorMinor: string | null;
  helpers: Record<string, string | null>;
  automationAssemblies: Record<string, boolean>;
  projectFileAssemblies: string[];
  notes: string[];
}

export async function detectInstallation(config: DiaConfig): Promise<InstallationInfo> {
  const executablePath = config.diadesignerPath || DEFAULT_DIADESIGNER_EXE;
  const installDir = path.dirname(executablePath);
  const executableExists = await pathExists(executablePath);
  const sevenZipPath = getSevenZipPath({ ...config, diadesignerPath: executablePath });
  const version = executableExists ? await getWindowsFileVersion(executablePath) : null;
  const majorMinor = version ? (/^(\d+\.\d+)/.exec(version)?.[1] ?? null) : null;

  // The bridge needs these; report them so a broken install fails loudly.
  const automationDlls = [
    "DeltaIA.DIAStudio.ProjectFile.Latest.dll",
    "DeltaIA.DIAStudio.IspProgramming.dll",
    "DeltaIA.DIAStudio.Programming.Project.dll",
    "DeltaIA.DIAStudio.Programming.Compilation.dll"
  ];
  const automationAssemblies: Record<string, boolean> = {};
  for (const dll of automationDlls) {
    automationAssemblies[dll] = await pathExists(path.join(installDir, dll));
  }

  return {
    executablePath,
    executableExists,
    installDir,
    productVersion: version,
    majorMinor,
    helpers: {
      sevenZip: (await pathExists(sevenZipPath)) ? sevenZipPath : null,
      unzipIspFile: await findFirstExe(path.join(installDir, "UnZipISPFile")),
      zipBuilder: (await pathExists(path.join(installDir, "ZipBuilderTool", "MyZipBuilder.exe")))
        ? path.join(installDir, "ZipBuilderTool", "MyZipBuilder.exe")
        : null,
      autoImportDescriptionFile: (await pathExists(path.join(installDir, "AutoImportDescriptionFile.exe")))
        ? path.join(installDir, "AutoImportDescriptionFile.exe")
        : null
    },
    automationAssemblies,
    projectFileAssemblies: await listProjectFileAssemblies(installDir),
    notes: [
      "DIADesigner is handled as Delta software, not as a CODESYS profile.",
      "Native .diade containers are Base64-armoured from 1.14 onwards; 1.13 projects are raw binary and must be opened and re-saved in 1.14 before the native reader accepts them.",
      "PLCopen .EXPORT XML is the supported read/write path for program content."
    ]
  };
}

function classifyExtension(extension: string): string | null {
  const lower = extension.toLowerCase();
  if (lower === ".export") return "plcopen-export";
  if (lower === ".diade") return "native-project";
  if (lower === ".isp") return "isp-project";
  if (PROJECT_EXTENSIONS.indexOf(lower) >= 0) return "project-like";
  return null;
}

export interface ProjectSummary {
  path: string;
  relativePath: string;
  extension: string;
  size: number;
  modifiedAt: string;
  kind: string;
}

export async function scanWorkspaceProjects(
  workspaceDir: string,
  startDir?: string,
  maxDepth = 6,
  maxResults = 100
): Promise<ProjectSummary[]> {
  const root = resolveWorkspacePath(workspaceDir, startDir || ".");
  const summaries: ProjectSummary[] = [];

  async function walk(currentDir: string, depth: number): Promise<void> {
    if (summaries.length >= maxResults || depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (summaries.length >= maxResults) return;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_SCAN_DIRS.has(entry.name)) await walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name);
      const kind = classifyExtension(extension);
      if (!kind) continue;
      let fileStat;
      try {
        fileStat = await stat(fullPath);
      } catch {
        continue;
      }
      summaries.push({
        path: fullPath,
        relativePath: toForwardSlash(path.relative(workspaceDir, fullPath)),
        extension,
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
        kind
      });
    }
  }

  await walk(root, 0);
  return summaries;
}

function printableRatio(buffer: Buffer): number {
  if (buffer.length === 0) return 1;
  let printable = 0;
  for (let i = 0; i < buffer.length; i++) {
    const value = buffer[i];
    if (value === 9 || value === 10 || value === 13 || (value >= 32 && value <= 126) || value >= 128) {
      printable++;
    }
  }
  return printable / buffer.length;
}

function isBase64Text(buffer: Buffer): boolean {
  if (buffer.length < 32) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 512)).toString("ascii");
  return /^[A-Za-z0-9+/=\r\n]+$/.test(sample);
}

export interface FileInspection {
  path: string;
  extension: string;
  size: number;
  modifiedAt: string;
  signatureHex: string;
  kind: string;
  container: string;
  isArchiveLike: boolean;
  notes: string[];
  archive?: unknown;
}

export async function inspectProjectFile(
  config: DiaConfig,
  projectFilePath: string,
  includeArchiveEntries = true,
  maxEntries = 200
): Promise<FileInspection> {
  const fullPath = resolveWorkspacePath(config.workspaceDir, projectFilePath);
  const fileStat = await stat(fullPath);
  const header = await readFirstBytes(fullPath, 8192);
  const extension = path.extname(fullPath);
  const lower = extension.toLowerCase();
  const headerText = header.toString("utf8").trimStart();

  let kind = classifyExtension(extension) || "binary";
  let container = "unknown";
  let isArchiveLike = false;
  const notes: string[] = [];

  if (header.length >= 4 && header[0] === 0x50 && header[1] === 0x4b) {
    container = "zip";
    isArchiveLike = true;
  } else if (header.length >= 6 && header[0] === 0x37 && header[1] === 0x7a) {
    container = "7z";
    isArchiveLike = true;
  } else if (headerText.startsWith("<?xml") || headerText.startsWith("<")) {
    container = "xml";
    kind = lower === ".export" ? "plcopen-export" : "xml";
  } else if (isBase64Text(header)) {
    container = "base64-encrypted";
    if (lower === ".diade") {
      notes.push("Base64 container: DIADesigner 1.14 format, readable via read_native_project.");
    }
  } else if (printableRatio(header) > 0.85) {
    container = "text";
  } else {
    container = "binary-encrypted";
    if (lower === ".diade") {
      notes.push(
        "Raw binary container: DIADesigner 1.13 format. The 1.14 project reader cannot decrypt it; open and re-save the project in DIADesigner 1.14 first."
      );
    }
  }

  const inspection: FileInspection = {
    path: fullPath,
    extension,
    size: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    signatureHex: header.subarray(0, 16).toString("hex").replace(/(.{2})/g, "$1 ").trim(),
    kind,
    container,
    isArchiveLike,
    notes
  };

  if (includeArchiveEntries && isArchiveLike) {
    try {
      inspection.archive = await listArchiveEntries(config, fullPath, maxEntries);
    } catch (error) {
      notes.push(`Archive listing failed: ${(error as Error).message}`);
    }
  }

  return inspection;
}

export interface ArchiveEntry {
  path: string;
  size?: number;
  packedSize?: number;
  modified?: string;
  attributes?: string;
  encrypted: boolean;
  method?: string;
  crc?: string;
  offset?: number;
  isDirectory: boolean;
}

function parse7zSlt(output: string, archivePath: string, maxEntries: number): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let current: Record<string, string> = {};
  const archivePathNormalized = path.normalize(archivePath).toLowerCase();

  function pushCurrent(): void {
    const entryPath = current["Path"];
    if (!entryPath) {
      current = {};
      return;
    }
    const normalizedEntryPath = path.normalize(entryPath).toLowerCase();
    const hasEntryFields =
      current["Attributes"] !== undefined ||
      current["Size"] !== undefined ||
      current["Folder"] !== undefined;
    if (hasEntryFields && normalizedEntryPath !== archivePathNormalized && entries.length < maxEntries) {
      const size = current["Size"] !== undefined ? Number(current["Size"]) : undefined;
      const packedSize = current["Packed Size"] !== undefined ? Number(current["Packed Size"]) : undefined;
      const offset = current["Offset"] !== undefined ? Number(current["Offset"]) : undefined;
      entries.push({
        path: entryPath,
        size: Number.isFinite(size) ? size : undefined,
        packedSize: Number.isFinite(packedSize) ? packedSize : undefined,
        modified: current["Modified"],
        attributes: current["Attributes"],
        encrypted: current["Encrypted"] === "+",
        method: current["Method"],
        crc: current["CRC"],
        offset: Number.isFinite(offset) ? offset : undefined,
        isDirectory: current["Folder"] === "+"
      });
    }
    current = {};
  }

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      pushCurrent();
      continue;
    }
    const index = line.indexOf(" = ");
    if (index === -1) continue;
    current[line.substring(0, index)] = line.substring(index + 3);
  }
  pushCurrent();
  return entries;
}

export async function listArchiveEntries(
  config: DiaConfig,
  projectFilePath: string,
  maxEntries = 200
): Promise<ArchiveEntry[]> {
  const archivePath = resolveWorkspacePath(config.workspaceDir, projectFilePath);
  const sevenZipPath = getSevenZipPath(config);
  if (!(await pathExists(sevenZipPath))) {
    throw new Error(`7-Zip helper not found: ${sevenZipPath}`);
  }
  const result = await runCommand(sevenZipPath, ["l", "-slt", archivePath], {
    cwd: path.dirname(sevenZipPath),
    timeoutMs: 30000,
    maxOutputBytes: 4 * 1024 * 1024
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `7za exited with code ${result.code}`);
  }
  return parse7zSlt(result.stdout, archivePath, maxEntries);
}

export async function extractProjectArchive(
  config: DiaConfig,
  projectFilePath: string,
  outputDir: string
): Promise<{ archivePath: string; outputDir: string; output: string }> {
  const archivePath = resolveWorkspacePath(config.workspaceDir, projectFilePath);
  const targetDir = resolveWorkspacePath(config.workspaceDir, outputDir);
  const sevenZipPath = getSevenZipPath(config);
  if (!(await pathExists(sevenZipPath))) {
    throw new Error(`7-Zip helper not found: ${sevenZipPath}`);
  }
  await mkdir(targetDir, { recursive: true });
  const result = await runCommand(sevenZipPath, ["x", archivePath, `-o${targetDir}`, "-y"], {
    cwd: path.dirname(sevenZipPath),
    timeoutMs: 60000,
    maxOutputBytes: 2 * 1024 * 1024
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `7za exited with code ${result.code}`);
  }
  return { archivePath, outputDir: targetDir, output: result.stdout.trim() };
}

export async function createProjectBackup(
  workspaceDir: string,
  projectFilePath: string
): Promise<{ sourcePath: string; backupPath: string }> {
  const sourcePath = resolveWorkspacePath(workspaceDir, projectFilePath);
  if (!(await pathExists(sourcePath))) {
    throw new Error(`File not found: ${sourcePath}`);
  }
  const backupPath = `${sourcePath}.bak-${timestampForFileName()}`;
  await copyFile(sourcePath, backupPath);
  return { sourcePath, backupPath };
}

export async function launchDiaDesigner(
  config: DiaConfig,
  projectFilePath?: string
): Promise<{
  executablePath: string;
  projectPath?: string;
  launchPath?: string;
  launchPathReason?: string;
  pid?: number;
}> {
  const executablePath = config.diadesignerPath || DEFAULT_DIADESIGNER_EXE;
  if (!(await pathExists(executablePath))) {
    throw new Error(`DIADesigner executable not found: ${executablePath}`);
  }

  let projectPath: string | undefined;
  let launchPath: string | undefined;
  let launchPathReason: string | undefined;

  if (projectFilePath) {
    projectPath = resolveWorkspacePath(config.workspaceDir, projectFilePath);
    if (!(await pathExists(projectPath))) {
      throw new Error(`Project path not found: ${projectPath}`);
    }
    const projectStat = await stat(projectPath);
    if (projectStat.isDirectory()) {
      launchPath = projectPath;
      launchPathReason = "DIADesigner opens native projects from their project directory.";
    } else if (path.extname(projectPath).toLowerCase() === ".diade") {
      launchPath = path.dirname(projectPath);
      launchPathReason =
        "DIADesigner does not reliably open a .diade file path from the command line; using its containing project directory.";
    } else {
      launchPath = projectPath;
      launchPathReason = "Using the supplied file path.";
    }
  }

  const child = spawn(executablePath, launchPath ? [launchPath] : [], {
    cwd: path.dirname(executablePath),
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  return { executablePath, projectPath, launchPath, launchPathReason, pid: child.pid };
}

export async function listDeviceCatalog(config: DiaConfig): Promise<{
  installDir: string;
  hcModels: string[];
  dutFamilies: string[];
  programmingFamilies: string[];
}> {
  const installDir = getInstallDir(config);
  const hcModels: string[] = [];
  const dutFamilies: string[] = [];
  const programmingFamilies: string[] = [];

  try {
    for (const entry of await readdir(path.join(installDir, "HCModel"), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        const modelName = entry.name.replace(/^HC(Data|Menu)_/i, "").replace(/\.json$/i, "");
        if (hcModels.indexOf(modelName) === -1) hcModels.push(modelName);
      }
    }
  } catch {
    // Optional installation content.
  }
  try {
    for (const entry of await readdir(path.join(installDir, "Resource", "DUT"), { withFileTypes: true })) {
      if (entry.isDirectory()) dutFamilies.push(entry.name);
    }
  } catch {
    // Optional installation content.
  }
  try {
    for (const entry of await readdir(path.join(installDir, "Programming", "Resource"), { withFileTypes: true })) {
      if (entry.isDirectory() && /_Series$/i.test(entry.name)) programmingFamilies.push(entry.name);
    }
  } catch {
    // Optional installation content.
  }

  hcModels.sort();
  dutFamilies.sort();
  programmingFamilies.sort();
  return { installDir, hcModels, dutFamilies, programmingFamilies };
}

export function configWithDefaults(partial: Partial<DiaConfig>): DiaConfig {
  const diadesignerPath = partial.diadesignerPath || DEFAULT_DIADESIGNER_EXE;
  return {
    diadesignerPath,
    workspaceDir: partial.workspaceDir || process.cwd(),
    sevenZipPath: partial.sevenZipPath || path.join(path.dirname(diadesignerPath), "7zTool", "7za.exe")
  };
}

export function formatAsJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
