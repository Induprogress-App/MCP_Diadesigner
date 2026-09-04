"use strict";
/**
 * Node-side wrapper around bridge/DeltaBridge.ps1.
 *
 * The Delta assemblies are x86 and print diagnostics to stdout, so the bridge is
 * invoked through the 32-bit PowerShell host and hands its result back through a
 * temp file rather than through the pipe.
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
exports.POWERSHELL_X86 = void 0;
exports.callBridge = callBridge;
exports.listLivePous = listLivePous;
exports.readProgramMemory = readProgramMemory;
exports.convertLdToSt = convertLdToSt;
exports.exportProjectGui = exportProjectGui;
exports.bridgeDetect = bridgeDetect;
exports.readNativeProject = readNativeProject;
exports.readProgramHeader = readProgramHeader;
exports.loadProgram = loadProgram;
exports.compileProgram = compileProgram;
const promises_1 = require("fs/promises");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const interop_js_1 = require("./interop.js");
const ldToSt_js_1 = require("./ldToSt.js");
/** 32-bit Windows PowerShell; the DIADesigner assemblies will not load in x64. */
exports.POWERSHELL_X86 = "C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe";
const POWERSHELL_ANY = "powershell.exe";
function bridgeScriptPath() {
    // dist14/bridge.js -> ../bridge/DeltaBridge.ps1
    const candidates = [
        path.resolve(__dirname, "..", "bridge", "DeltaBridge.ps1"),
        path.resolve(__dirname, "..", "..", "bridge", "DeltaBridge.ps1")
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    throw new Error(`DeltaBridge.ps1 not found. Looked in: ${candidates.join(", ")}`);
}
function powerShellHost() {
    return fs.existsSync(exports.POWERSHELL_X86) ? exports.POWERSHELL_X86 : POWERSHELL_ANY;
}
async function callBridge(config, command, options = {}) {
    const script = bridgeScriptPath();
    const installDir = (0, interop_js_1.getInstallDir)(config);
    const tempDir = await (0, promises_1.mkdtemp)(path.join(os.tmpdir(), "dia-bridge-"));
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
    if (options.path)
        args.push("-Path", options.path);
    if (options.arg)
        args.push("-Arg", options.arg);
    try {
        const result = await (0, interop_js_1.runCommand)(powerShellHost(), args, {
            cwd: installDir,
            timeoutMs: options.timeoutMs ?? 120000,
            maxOutputBytes: 2 * 1024 * 1024
        });
        let raw;
        try {
            raw = await (0, promises_1.readFile)(outFile, "utf8");
        }
        catch {
            throw new Error(`Bridge produced no result. exit=${result.code} stderr=${result.stderr.trim().slice(0, 500)} stdout=${result.stdout.trim().slice(0, 500)}`);
        }
        try {
            return JSON.parse(raw);
        }
        catch {
            throw new Error(`Bridge returned malformed JSON: ${raw.slice(0, 500)}`);
        }
    }
    finally {
        await (0, promises_1.rm)(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
function guiScriptPath() {
    const candidates = [
        path.resolve(__dirname, "..", "bridge", "DiaExportGui.ps1"),
        path.resolve(__dirname, "..", "..", "bridge", "DiaExportGui.ps1")
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    throw new Error(`DiaExportGui.ps1 not found. Looked in: ${candidates.join(", ")}`);
}
function memoryReaderScriptPath() {
    const candidates = [
        path.resolve(__dirname, "..", "bridge", "DiaMemoryReader.ps1"),
        path.resolve(__dirname, "..", "..", "bridge", "DiaMemoryReader.ps1")
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    throw new Error(`DiaMemoryReader.ps1 not found. Looked in: ${candidates.join(", ")}`);
}
/** Finds a running 32-bit DIADesigner process, optionally matching a title substring. */
async function findDiaDesignerPid(titleMatch) {
    const filter = titleMatch ? `-and $_.MainWindowTitle -like '*${titleMatch.replace(/'/g, "''")}*'` : "";
    const cmd = `Get-Process DIADesigner -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.MainWindowTitle -ne '' ${filter} } | ` +
        `Sort-Object StartTime | Select-Object -Last 1 | ` +
        `ForEach-Object { $_.Id.ToString() + '|' + $_.MainWindowTitle }`;
    const result = await (0, interop_js_1.runCommand)(POWERSHELL_ANY, ["-NoProfile", "-NonInteractive", "-Command", cmd], {
        timeoutMs: 20000,
        maxOutputBytes: 8192
    });
    const line = result.stdout.trim();
    if (!line)
        return null;
    const sep = line.indexOf("|");
    const pid = Number(sep >= 0 ? line.slice(0, sep) : line);
    if (!Number.isFinite(pid))
        return null;
    return { pid, title: sep >= 0 ? line.slice(sep + 1) : "" };
}
/**
 * Lists every POU resident in a running DIADesigner process's memory: name,
 * worksheet type (the language signal -- LDWorkSheet/STWorkSheet/...), and its
 * own network count. Read-only (ClrMD). Useful to plan work across a project's
 * POUs even though read_program_memory/convert_ld_to_st can't yet isolate one
 * POU's networks by name (use coilPattern there instead).
 */
async function listLivePous(config, options = {}) {
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
    const result = await (0, interop_js_1.runCommand)(exports.POWERSHELL_X86, args, {
        cwd: (0, interop_js_1.getInstallDir)(config),
        timeoutMs: 300000,
        maxOutputBytes: 1024 * 1024,
        env: { TEMP: os.tmpdir(), TMP: os.tmpdir() }
    });
    let raw;
    try {
        raw = await (0, promises_1.readFile)(outFile, "utf8");
    }
    catch {
        throw new Error(`Memory reader produced no result. exit=${result.code} stderr=${result.stderr.trim().slice(0, 400)}`);
    }
    finally {
        try {
            await (0, promises_1.rm)(outFile, { force: true });
        }
        catch {
            // best-effort cleanup
        }
    }
    let pous;
    try {
        pous = JSON.parse(raw);
    }
    catch {
        return { ok: false, error: `Memory reader returned malformed JSON: ${raw.slice(0, 400)}`, pid, processTitle: title };
    }
    return { ok: true, pid, processTitle: title, pous };
}
/**
 * Reads the decrypted Ladder program out of a running DIADesigner process's heap
 * (via ClrMD, read-only). The project must be open in DIADesigner. Returns the
 * networks/variables and also writes the full JSON to `outputFile`.
 */
async function readProgramMemory(config, options = { outputFile: "" }) {
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
    if (options.onlyCommented)
        args.push("-OnlyCommented");
    // ClrMD must attach from a 32-bit host to match the x86 DIADesigner process.
    // Point the child's temp at the output directory: the reader compiles C# via
    // CodeDom (Add-Type), which needs writable temp, and the system drive may be
    // full. Fall back to the workspace dir when the output has no directory part.
    const scratch = path.dirname(path.resolve(config.workspaceDir, options.outputFile)) || config.workspaceDir;
    const result = await (0, interop_js_1.runCommand)(exports.POWERSHELL_X86, args, {
        cwd: (0, interop_js_1.getInstallDir)(config),
        timeoutMs: 300000,
        maxOutputBytes: 1024 * 1024,
        env: { TEMP: scratch, TMP: scratch }
    });
    let raw;
    try {
        raw = await (0, promises_1.readFile)(options.outputFile, "utf8");
    }
    catch {
        throw new Error(`Memory reader produced no result. exit=${result.code} stderr=${result.stderr.trim().slice(0, 400)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error(`Memory reader returned malformed JSON: ${raw.slice(0, 400)}`);
    }
    parsed.pid = pid;
    parsed.processTitle = title;
    parsed.outputFile = options.outputFile;
    return parsed;
}
/**
 * Reads the open project's Ladder program from memory and converts it to
 * Structured Text, writing the .st document to `outputFile`. Optionally limits
 * the output to networks whose coil variable matches `coilPattern` (so a single
 * station / POU's logic can be isolated).
 */
async function convertLdToSt(config, options) {
    const resolvedOut = (0, interop_js_1.resolveWorkspacePath)(config.workspaceDir, options.outputFile);
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
        if (!mem.ok)
            return { ok: false, error: mem.error, pid: mem.pid, processTitle: mem.processTitle };
        const networks = mem.networks ?? [];
        const built = (0, ldToSt_js_1.buildStDocument)(networks, {
            coilPattern: options.coilPattern,
            pouName: options.pouName
        });
        await (0, promises_1.writeFile)(resolvedOut, built.document, "utf8");
        return {
            ok: true,
            pid: mem.pid,
            processTitle: mem.processTitle,
            outputFile: resolvedOut,
            stats: built.stats,
            coils: built.coils
        };
    }
    finally {
        await (0, promises_1.rm)(jsonFile, { force: true }).catch(() => { });
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
async function exportProjectGui(config, projectDiade, exportPath, timeoutSec = 240) {
    const script = guiScriptPath();
    const installDir = (0, interop_js_1.getInstallDir)(config);
    const tempDir = await (0, promises_1.mkdtemp)(path.join(os.tmpdir(), "dia-export-"));
    const outFile = path.join(tempDir, "result.json");
    const resolvedProject = (0, interop_js_1.resolveWorkspacePath)(config.workspaceDir, projectDiade);
    const resolvedExport = (0, interop_js_1.resolveWorkspacePath)(config.workspaceDir, exportPath);
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
        const result = await (0, interop_js_1.runCommand)(POWERSHELL_ANY, args, {
            cwd: installDir,
            timeoutMs: (timeoutSec + 60) * 1000,
            maxOutputBytes: 2 * 1024 * 1024
        });
        let raw;
        try {
            raw = await (0, promises_1.readFile)(outFile, "utf8");
        }
        catch {
            throw new Error(`Export driver produced no result. exit=${result.code} stderr=${result.stderr.trim().slice(0, 500)}`);
        }
        try {
            return JSON.parse(raw);
        }
        catch {
            throw new Error(`Export driver returned malformed JSON: ${raw.slice(0, 500)}`);
        }
    }
    finally {
        await (0, promises_1.rm)(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
async function bridgeDetect(config) {
    return callBridge(config, "detect", { timeoutMs: 60000 });
}
async function readNativeProject(config, projectPath) {
    return callBridge(config, "read-project", {
        path: (0, interop_js_1.resolveWorkspacePath)(config.workspaceDir, projectPath),
        timeoutMs: 60000
    });
}
async function readProgramHeader(config, programPath) {
    return callBridge(config, "program-header", {
        path: (0, interop_js_1.resolveWorkspacePath)(config.workspaceDir, programPath),
        timeoutMs: 60000
    });
}
async function loadProgram(config, programPath) {
    return callBridge(config, "load-program", {
        path: (0, interop_js_1.resolveWorkspacePath)(config.workspaceDir, programPath),
        timeoutMs: 180000
    });
}
async function compileProgram(config, programPath, mode = "compile") {
    return callBridge(config, "compile", {
        path: (0, interop_js_1.resolveWorkspacePath)(config.workspaceDir, programPath),
        arg: mode,
        timeoutMs: 300000
    });
}
