"use strict";
/**
 * In-process host for the real DIADesigner application (AS / AX-AS devices).
 *
 * The AS compiler cannot be created without the application shell, so bridge/host/DiaHost.cs
 * starts DIADesigner.exe itself, opens the project like a double click, runs one request
 * (inspect / import / compile / save) against it and writes a JSON result. No UI interaction.
 *
 * DIADesigner resolves Resource\ and Programming\ next to its own exe, so the host runs from
 * a private runtime dir under %LOCALAPPDATA%: root files copied, sub-directories junctioned
 * to the installation, DiaHost.exe built next to them.
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
exports.ensureHostRuntime = ensureHostRuntime;
exports.runHost = runHost;
exports.diaDesignerRunning = diaDesignerRunning;
exports.formatCompileReport = formatCompileReport;
exports.backupProjectDirectory = backupProjectDirectory;
exports.importIntoProgram = importIntoProgram;
const promises_1 = require("fs/promises");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const interop_js_1 = require("./interop.js");
const CSC = "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe";
function hostSourcePath() {
    const candidates = [
        path.resolve(__dirname, "..", "bridge", "host", "DiaHost.cs"),
        path.resolve(__dirname, "..", "..", "bridge", "host", "DiaHost.cs")
    ];
    for (const c of candidates)
        if (fs.existsSync(c))
            return c;
    throw new Error(`DiaHost.cs not found. Looked in: ${candidates.join(", ")}`);
}
function runtimeRoot() {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "diadesigner-mcp");
}
/** Builds (once per installation version + host source revision) the private runtime dir. */
async function ensureHostRuntime(config) {
    const installDir = (0, interop_js_1.getInstallDir)(config);
    const exePath = path.join(installDir, "DIADesigner.exe");
    if (!fs.existsSync(exePath))
        throw new Error(`DIADesigner.exe not found in ${installDir}`);
    const stat = fs.statSync(exePath);
    const tag = `host-${stat.size}-${Math.floor(stat.mtimeMs / 1000)}`;
    const dir = path.join(runtimeRoot(), tag);
    const src = hostSourcePath();
    const marker = path.join(dir, ".ready");
    const srcStamp = String(fs.statSync(src).mtimeMs);
    let needFiles = !fs.existsSync(marker);
    if (needFiles) {
        await (0, promises_1.mkdir)(dir, { recursive: true });
        // Root files: copy (robocopy, no sub-dirs). Exit codes < 8 are success.
        const rc = await (0, interop_js_1.runCommand)("robocopy", [installDir, dir, "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/XF", "DiaHost.exe"], {
            timeoutMs: 300000
        });
        if (rc.code === null || rc.code >= 8)
            throw new Error(`robocopy failed (${rc.code}): ${rc.stdout.slice(0, 400)}`);
        for (const e of await (0, promises_1.readdir)(installDir, { withFileTypes: true })) {
            if (!e.isDirectory())
                continue;
            const link = path.join(dir, e.name);
            if (fs.existsSync(link))
                continue;
            const mk = await (0, interop_js_1.runCommand)("cmd.exe", ["/c", "mklink", "/J", link, path.join(installDir, e.name)], { timeoutMs: 20000 });
            if (mk.code !== 0)
                throw new Error(`mklink failed for ${e.name}: ${mk.stdout}${mk.stderr}`);
        }
    }
    const stampFile = path.join(dir, ".hoststamp");
    let built = fs.existsSync(path.join(dir, "DiaHost.exe")) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === srcStamp;
    if (!built) {
        if (!fs.existsSync(CSC))
            throw new Error(`csc.exe (.NET Framework 4) not found at ${CSC}`);
        const refs = [
            "System.dll", "System.Core.dll", "System.Xml.dll", "System.Xml.Linq.dll", "System.Web.Extensions.dll",
            "System.Xaml.dll"
        ].map((r) => `-r:${r}`);
        const wpf = path.join(path.dirname(CSC), "WPF");
        for (const r of ["WindowsBase.dll", "PresentationCore.dll", "PresentationFramework.dll"])
            refs.push(`-r:${path.join(wpf, r)}`);
        const args = ["-nologo", "-platform:x86", "-target:winexe", `-out:${path.join(dir, "DiaHost.exe")}`, ...refs, src];
        const r = await (0, interop_js_1.runCommand)(CSC, args, { timeoutMs: 120000 });
        if (r.code !== 0)
            throw new Error(`DiaHost build failed:\n${r.stdout}\n${r.stderr}`);
        await (0, promises_1.writeFile)(stampFile, srcStamp);
    }
    if (needFiles)
        await (0, promises_1.writeFile)(marker, new Date().toISOString());
    return dir;
}
async function runHost(config, projectPath, request, timeoutSec = 600) {
    if (!fs.existsSync(projectPath))
        throw new Error(`Project not found: ${projectPath}`);
    const dir = await ensureHostRuntime(config);
    const tmp = await (0, promises_1.mkdtemp)(path.join(os.tmpdir(), "dia-host-"));
    const reqFile = path.join(tmp, "request.json");
    const outFile = path.join(tmp, "result.json");
    await (0, promises_1.writeFile)(reqFile, JSON.stringify(request));
    try {
        const r = await (0, interop_js_1.runCommand)(path.join(dir, "DiaHost.exe"), [projectPath], {
            cwd: dir,
            timeoutMs: timeoutSec * 1000,
            maxOutputBytes: 256 * 1024,
            env: { DIAHOST_REQUEST: reqFile, DIAHOST_OUT: outFile }
        });
        let raw;
        try {
            raw = await (0, promises_1.readFile)(outFile, "utf8");
        }
        catch {
            throw new Error(`DiaHost produced no result (exit=${r.code}, timedOut=${r.timedOut}). ${r.stderr.slice(0, 400)}`);
        }
        return JSON.parse(raw);
    }
    finally {
        await (0, promises_1.rm)(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
}
/** True when a DIADesigner.exe (the real application) is running. */
async function diaDesignerRunning() {
    const r = await (0, interop_js_1.runCommand)("tasklist", ["/FI", "IMAGENAME eq DIADesigner.exe", "/NH"], { timeoutMs: 15000 });
    return /DIADesigner\.exe/i.test(r.stdout);
}
/** Formats compile messages as a readable report. */
function formatCompileReport(c) {
    const lines = [`Errors: ${c.errorCount}, warnings: ${c.warningCount}, code size: ${c.exeSize ?? "?"}, ${c.seconds ?? "?"}s`];
    for (const m of c.messages) {
        const pos = [m.program, m.position].filter(Boolean).join(" ");
        lines.push(`[${m.type}] ${m.errorCode} ${pos}${m.line ? ` (${m.line}:${m.column ?? 0})` : ""}: ${m.description}`);
    }
    return lines.join("\n");
}
/** Copies the whole project directory next to the project (before anything is written into it). */
async function backupProjectDirectory(projectPath) {
    const dir = path.dirname(projectPath);
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const target = `${dir}_backup_${stamp}`;
    fs.cpSync(dir, target, { recursive: true });
    return target;
}
/**
 * Merges an .EXPORT fragment into a .diade project through the in-process host, optionally
 * compiles and saves. Saving is refused while a DIADesigner.exe is running (it may hold the project).
 */
async function importIntoProgram(config, projectPath, o) {
    const save = o.save ?? false;
    let backupPath;
    if (save) {
        if (await diaDesignerRunning()) {
            throw new Error("DIADesigner.exe is running; close it before saving into a project (it may have the project open).");
        }
        if (o.backup !== false)
            backupPath = await backupProjectDirectory(projectPath);
    }
    const r = await runHost(config, projectPath, { action: "import", exportPath: o.exportPath, clean: o.clean ?? false, compile: o.compile ?? true, save, openTimeoutSec: o.openTimeoutSec, dumpXml: o.dumpXml }, 900);
    return {
        ok: r.ok,
        error: r.error,
        blockedByDialog: r.blockedByDialog,
        backupPath,
        saved: r.saved ?? false,
        import: r.import,
        compile: r.compile
            ? { errorCount: r.compile.errorCount, warningCount: r.compile.warningCount, exeSize: r.compile.exeSize, report: formatCompileReport(r.compile) }
            : undefined,
        project: r.project,
        dialogs: r.dialogs,
        log: r.log
    };
}
