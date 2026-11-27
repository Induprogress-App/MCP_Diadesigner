"use strict";
/**
 * Generator of a DIADesigner project fragment (".EXPORT"-style XML) from IEC 61131-3 Structured Text files.
 *
 * Supported file kinds (one object per file, as written by the AMIX project):
 *   TYPE n : ( a := 0, ... ); END_TYPE                  -> enumeration data type
 *   TYPE n : STRUCT ... END_STRUCT END_TYPE             -> structure data type
 *   FUNCTION_BLOCK n / PROGRAM n  + VAR blocks + body   -> POU (ST body after the last END_VAR)
 *   VAR_GLOBAL ... END_VAR                              -> global variables (address read from the
 *                                                          first comment of a line, e.g. (* M0 - text *))
 *
 * The result is merged into a project container by the host (import_export_into_program).
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
exports.qualifyEnumValues = qualifyEnumValues;
exports.collectEnums = collectEnums;
exports.buildCallContext = buildCallContext;
exports.hoistCallArguments = hoistCallArguments;
exports.stToExport = stToExport;
const promises_1 = require("fs/promises");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const ELEMENTARY = new Set([
    "BOOL", "SINT", "INT", "DINT", "LINT", "USINT", "UINT", "UDINT", "ULINT",
    "BYTE", "WORD", "DWORD", "LWORD", "REAL", "LREAL", "TIME"
]);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function applyRenames(text, renames) {
    if (!renames)
        return text;
    let out = text;
    for (const [from, to] of Object.entries(renames)) {
        out = out.replace(new RegExp(`(?<![A-Za-z0-9_.])${from}(?![A-Za-z0-9_])`, "g"), to);
    }
    return out;
}
function typeXml(type, warnings) {
    const t = type.trim();
    const upper = t.toUpperCase();
    if (ELEMENTARY.has(upper))
        return `<${upper} />`;
    let m = /^STRING(?:\s*\[\s*(\d+)\s*\])?$/i.exec(t);
    if (m)
        return `<string length="${m[1] ?? 80}" />`;
    m = /^ARRAY\s*\[(.+?)\]\s*OF\s+(.+)$/i.exec(t);
    if (m) {
        const dims = m[1].split(",").map((d) => {
            const r = /^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$/.exec(d);
            if (!r)
                throw new Error(`Unsupported array bounds '${d}' in '${type}'`);
            return `<dimension lower="${r[1]}" upper="${r[2]}" />`;
        });
        return `<array>${dims.join("")}<baseType>${typeXml(m[2], warnings)}</baseType></array>`;
    }
    if (!/^[A-Za-z_]\w*$/.test(t))
        throw new Error(`Unsupported type '${type}'`);
    return `<derived name="${esc(t)}" />`;
}
function initXml(init) {
    if (init === undefined)
        return "";
    return `<initialValue><simpleValue value="${esc(init.trim())}" /></initialValue>`;
}
/** Parses declaration lines of one VAR block body. Comments are collected per line. */
function parseVarLines(lines, file) {
    const vars = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line)
            continue;
        if (/^\(\*.*\*\)$/.test(line) && !/;/.test(line.replace(/\(\*.*?\*\)/g, "")))
            continue; // comment-only line
        const m = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:\s*(.+?)\s*;\s*(.*)$/.exec(line);
        if (!m)
            throw new Error(`${file}: cannot parse declaration line: ${raw.trim()}`);
        const comments = [...m[3].matchAll(/\(\*(.*?)\*\)/g)].map((c) => c[1].trim());
        let type = m[2];
        let init;
        const ix = type.indexOf(":=");
        if (ix >= 0) {
            init = type.slice(ix + 2).trim();
            type = type.slice(0, ix).trim();
        }
        for (const name of m[1].split(",").map((s) => s.trim())) {
            const v = { name, type, init, comment: comments[0] };
            const a = /^([MDSTC]\d+)\b/.exec(comments[0] ?? "");
            if (a)
                v.address = a[1];
            vars.push(v);
        }
    }
    return vars;
}
/** Splits text into VAR blocks (outside comments) and returns the implementation after the last END_VAR. */
function splitDeclaration(text) {
    const lines = text.split(/\r?\n/);
    const blocks = [];
    let head = "";
    let cur = null;
    let lastEnd = -1;
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        const open = /^(VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR)(\s+CONSTANT|\s+RETAIN|\s+PERSISTENT)*\s*$/.exec(t);
        if (!cur && open) {
            cur = { kind: open[1] + (/CONSTANT/.test(t) ? " CONSTANT" : ""), lines: [] };
            continue;
        }
        if (cur && /^END_VAR\b/.test(t)) {
            blocks.push(cur);
            cur = null;
            lastEnd = i;
            continue;
        }
        if (cur) {
            cur.lines.push(lines[i]);
            continue;
        }
        if (blocks.length === 0 && /^(PROGRAM|FUNCTION_BLOCK|FUNCTION)\b/.test(t))
            head = t;
    }
    const body = lastEnd >= 0 ? lines.slice(lastEnd + 1).join("\n").replace(/^\s*\n/, "") : lines.join("\n");
    return { head, blocks, body };
}
function varXml(v, scope, warnings, withAddress = false) {
    const addr = withAddress && v.address ? ` address="${v.address}"` : "";
    return `<variable name="${esc(v.name)}"${addr}><type>${typeXml(v.type, warnings)}</type><scope><${scope} /></scope>${initXml(v.init)}</variable>`;
}
function parseEnum(text, name) {
    const m = /\(([\s\S]*?)\)\s*;?\s*END_TYPE/.exec(text.replace(/\(\*[\s\S]*?\*\)/g, ""));
    if (!m)
        throw new Error(`${name}: enum body not found`);
    let next = 0;
    const values = m[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
        const r = /^([A-Za-z_]\w*)\s*(?::=\s*(-?\d+))?$/.exec(s);
        if (!r)
            throw new Error(`${name}: bad enum value '${s}'`);
        const v = r[2] !== undefined ? parseInt(r[2], 10) : next;
        next = v + 1;
        return `<value name="${r[1]}" value="${v}" />`;
    });
    return `<baseType><enum><values>${values.join("")}</values></enum></baseType>`;
}
function parseStruct(text, name, warnings) {
    const m = /STRUCT\s*\r?\n([\s\S]*?)END_STRUCT/.exec(text);
    if (!m)
        throw new Error(`${name}: STRUCT body not found`);
    const vars = parseVarLines(m[1].split(/\r?\n/), name).map((v) => `<variable name="${esc(v.name)}"><type>${typeXml(v.type, warnings)}</type>${initXml(v.init)}</variable>`);
    return `<baseType><struct>${vars.join("")}</struct></baseType>`;
}
/** Replaces bare enumeration values by Enum.Value outside comments and string literals. */
function qualifyEnumValues(code, enums) {
    if (enums.size === 0)
        return code;
    const re = /\(\*[\s\S]*?\*\)|\/\/[^\n]*|'(?:[^']|\$')*'|(?<![A-Za-z0-9_.#$])([A-Za-z_]\w*)(?![A-Za-z0-9_])/g;
    return code.replace(re, (m, id) => {
        if (!id)
            return m;
        const e = enums.get(id);
        return e ? `${e}.${id}` : m;
    });
}
/** value name -> enum name, from TYPE ... ( ... ) END_TYPE files. */
function collectEnums(texts) {
    const map = new Map();
    for (const t of texts) {
        const clean = t.replace(/\(\*[\s\S]*?\*\)/g, "");
        const m = /^\s*TYPE\s+([A-Za-z_]\w*)\s*:\s*\(([\s\S]*?)\)\s*;?\s*END_TYPE/.exec(clean);
        if (!m)
            continue;
        for (const v of m[2].split(",")) {
            const n = /^\s*([A-Za-z_]\w*)/.exec(v)?.[1];
            if (n)
                map.set(n, m[1]);
        }
    }
    return map;
}
/** Builds the context from the declaration parts of all files. */
function buildCallContext(texts, file = "?") {
    const ctx = { fbInputs: new Map(), globals: new Map() };
    for (const t of texts) {
        const first = t.replace(/\(\*[\s\S]*?\*\)/g, "").trim();
        const fb = /^FUNCTION_BLOCK\s+([A-Za-z_]\w*)/.exec(first);
        const { blocks } = splitDeclaration(t);
        if (fb) {
            const inputs = new Map();
            for (const b of blocks)
                if (b.kind === "VAR_INPUT")
                    for (const v of parseVarLines(b.lines, file))
                        inputs.set(v.name, v.type.trim());
            ctx.fbInputs.set(fb[1], inputs);
        }
        else if (/^VAR_GLOBAL\b/.test(first)) {
            for (const b of blocks)
                if (b.kind === "VAR_GLOBAL")
                    for (const v of parseVarLines(b.lines, file))
                        ctx.globals.set(v.name, v.type.trim());
        }
    }
    return ctx;
}
const SIMPLE_ARG = /^(?:-?\d+(?:\.\d+)?|\d+#[0-9A-Fa-f_]+|TRUE|FALSE|[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*(?:\[\s*[\w.]+\s*\])?)$/i;
function stripComments(s) {
    return s.replace(/\(\*[\s\S]*?\*\)/g, " ");
}
/**
 * AS accepts only variables, members and literals as function block call parameters.
 * Every other expression (A AND B, NOT x, (a = b)) is evaluated into a helper variable
 * Inst_Param on the line before the call; the helper is declared in the POU's VAR block.
 */
function hoistCallArguments(text, ctx) {
    const nl = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    let lastEnd = -1;
    for (let i = 0; i < lines.length; i++)
        if (/^\s*END_VAR\b/.test(lines[i]))
            lastEnd = i;
    const decl = lines.slice(0, lastEnd + 1).join("\n");
    let body = lines.slice(lastEnd + 1).join("\n");
    // instances: globals + locals of this POU
    const instances = new Map(ctx.globals);
    for (const b of splitDeclaration(decl + "\n").blocks)
        if (b.kind === "VAR")
            for (const v of parseVarLines(b.lines, "local"))
                instances.set(v.name, v.type.trim());
    const added = [];
    const usedNames = new Set([...instances.keys()]);
    let pos = 0;
    const names = [...instances.entries()].filter(([, t]) => ctx.fbInputs.has(t)).map(([n]) => n);
    if (names.length === 0)
        return { text, added: [] };
    const callRe = new RegExp(`(?<![A-Za-z0-9_.])(${names.map((n) => n.replace(/[^\w]/g, "")).join("|")})\\s*\\(`, "g");
    // mask comments with spaces so positions stay valid while searching
    const masked = body.replace(/\(\*[\s\S]*?\*\)/g, (m) => m.replace(/[^\n]/g, " "));
    let out = "";
    let m;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(masked))) {
        const inst = m[1];
        const open = m.index + m[0].length - 1;
        let depth = 0, close = -1;
        for (let i = open; i < masked.length; i++) {
            if (masked[i] === "(")
                depth++;
            else if (masked[i] === ")") {
                depth--;
                if (depth === 0) {
                    close = i;
                    break;
                }
            }
        }
        if (close < 0)
            continue;
        // split top-level arguments in the masked text
        const segs = [];
        let d = 0, st = open + 1;
        for (let i = open + 1; i <= close; i++) {
            const c = masked[i];
            if (c === "(")
                d++;
            else if (c === ")") {
                if (d === 0) {
                    segs.push({ start: st, end: i });
                    break;
                }
                d--;
            }
            else if (c === "," && d === 0) {
                segs.push({ start: st, end: i });
                st = i + 1;
            }
        }
        const type = instances.get(inst);
        const params = ctx.fbInputs.get(type);
        const lineStart = body.lastIndexOf("\n", m.index) + 1;
        const indent = /^\s*/.exec(body.slice(lineStart))[0];
        const hoists = [];
        const edits = [];
        for (const sg of segs) {
            const raw = masked.slice(sg.start, sg.end);
            const am = /^(\s*)([A-Za-z_]\w*)\s*:=([\s\S]*)$/.exec(raw);
            if (!am)
                continue;
            const expr = am[3].trim();
            if (!expr || SIMPLE_ARG.test(expr))
                continue;
            const exprStart = sg.start + raw.length - am[3].length + (am[3].length - am[3].trimStart().length);
            const exprEnd = exprStart + expr.length;
            let name = `${inst}_${am[2]}`;
            for (let k = 2; usedNames.has(name) && !added.some((a) => a.name === name); k++)
                name = `${inst}_${am[2]}${k}`;
            if (!added.some((a) => a.name === name)) {
                added.push({ name, type: params.get(am[2]) ?? "BOOL" });
                usedNames.add(name);
            }
            hoists.push(`${indent}${name} := ${body.slice(exprStart, exprEnd).replace(/\s*\n\s*/g, " ")};`);
            edits.push({ start: exprStart, end: exprEnd, text: name });
        }
        if (!edits.length)
            continue;
        let call = body.slice(lineStart, close + 1);
        for (const e of edits.sort((a, b) => b.start - a.start))
            call = call.slice(0, e.start - lineStart) + e.text + call.slice(e.end - lineStart);
        out += body.slice(pos, lineStart) + hoists.join("\n") + "\n" + call;
        pos = close + 1;
        callRe.lastIndex = close + 1;
    }
    body = out + body.slice(pos);
    let newDecl = decl;
    if (added.length) {
        const declLines = decl.split("\n");
        const varLine = [...declLines.keys()].find((i) => /^\s*VAR\s*$/.test(declLines[i]));
        const rows = added.map((a, i) => `    ${a.name} : ${a.type};${i === 0 ? "   (* AS: wyrazenia nie moga byc parametrami wywolania FB - liczone przed wywolaniem *)" : ""}`);
        if (varLine !== undefined) {
            const endIdx = declLines.findIndex((l, i) => i > varLine && /^\s*END_VAR/.test(l));
            declLines.splice(endIdx, 0, ...rows);
        }
        else {
            declLines.splice(1, 0, "VAR", ...rows, "END_VAR");
        }
        newDecl = declLines.join("\n");
    }
    return { text: (newDecl + "\n" + body).replace(/\n/g, nl), added: added.map((a) => a.name) };
}
async function collectFiles(inputs) {
    const files = [];
    for (const p of inputs) {
        const st = fs.statSync(p);
        if (st.isDirectory()) {
            for (const f of (await (0, promises_1.readdir)(p)).sort())
                if (f.toLowerCase().endsWith(".st"))
                    files.push(path.join(p, f));
        }
        else
            files.push(p);
    }
    return files;
}
async function stToExport(inputs, outputPath, options = {}) {
    const warnings = [];
    const skipObjects = new Set((options.skipObjects ?? []).map((s) => s.toLowerCase()));
    const skipTypes = new Set(options.skipTypes ?? []);
    const files = await collectFiles(inputs);
    const dataTypes = [];
    const pous = [];
    const skipped = [];
    const dtXml = [];
    const pouXmls = [];
    const globals = [];
    let withAddress = 0;
    const seen = new Set();
    // Function block instances take no address; a comment such as (* M3 motor *) is a label, not an address.
    const fbNames = new Set();
    for (const f of files) {
        const mm = /^\s*FUNCTION_BLOCK\s+([A-Za-z_]\w*)/m.exec(await (0, promises_1.readFile)(f, "utf8"));
        if (mm)
            fbNames.add(mm[1]);
    }
    const enums = options.qualifyEnums === false
        ? new Map()
        : collectEnums(await Promise.all(files.map((f) => (0, promises_1.readFile)(f, "utf8").then((t) => applyRenames(t, options.renames)))));
    const callCtx = buildCallContext(await Promise.all(files.map((f) => (0, promises_1.readFile)(f, "utf8").then((t) => applyRenames(t, options.renames)))));
    for (const file of files) {
        const obj = path.basename(file, path.extname(file));
        if (skipObjects.has(obj.toLowerCase()) || skipTypes.has(obj)) {
            skipped.push(obj);
            continue;
        }
        if (seen.has(obj.toLowerCase())) {
            warnings.push(`duplicate object '${obj}' ignored (${file})`);
            continue;
        }
        seen.add(obj.toLowerCase());
        let text = applyRenames(await (0, promises_1.readFile)(file, "utf8"), options.renames);
        const first = text.replace(/\(\*[\s\S]*?\*\)/g, "").trim();
        if (/^TYPE\b/.test(first)) {
            const nm = /^TYPE\s+([A-Za-z_]\w*)\s*:/.exec(first)?.[1] ?? obj;
            const inner = /STRUCT/.test(first) ? parseStruct(text, nm, warnings) : parseEnum(text, nm);
            dtXml.push(`<dataType name="${nm}">${inner}<codeSection><![CDATA[${text.trimEnd()}\n]]></codeSection></dataType>`);
            dataTypes.push(nm);
            continue;
        }
        if (/^VAR_GLOBAL\b/.test(first)) {
            const { blocks } = splitDeclaration(text);
            for (const b of blocks) {
                if (b.kind !== "VAR_GLOBAL")
                    continue;
                for (const v of parseVarLines(b.lines, obj)) {
                    if (skipTypes.has(v.type.trim()))
                        continue;
                    if (fbNames.has(v.type.trim()))
                        v.address = undefined;
                    globals.push(varXml(v, "VAR", warnings, true));
                    if (v.address)
                        withAddress++;
                }
            }
            continue;
        }
        const kindM = /^(PROGRAM|FUNCTION_BLOCK)\s+([A-Za-z_]\w*)/.exec(first);
        if (kindM) {
            if (options.hoistCallArgs !== false)
                text = hoistCallArguments(text, callCtx).text;
            const { blocks, body } = splitDeclaration(text);
            const groups = { inputVars: [], outputVars: [], inOutVars: [], localVars: [] };
            const map = {
                VAR_INPUT: ["inputVars", "VAR_INPUT"], VAR_OUTPUT: ["outputVars", "VAR_OUTPUT"], VAR_IN_OUT: ["inOutVars", "VAR_IN_OUT"],
                VAR: ["localVars", "VAR"], "VAR CONSTANT": ["localVars", "VAR"], VAR_TEMP: ["localVars", "VAR"]
            };
            for (const b of blocks) {
                const mm = map[b.kind];
                if (!mm) {
                    warnings.push(`${obj}: unsupported block ${b.kind}`);
                    continue;
                }
                for (const v of parseVarLines(b.lines, obj))
                    groups[mm[0]].push(varXml(v, mm[1], warnings));
            }
            let code = qualifyEnumValues(body, enums);
            if (options.directIo)
                code = code.replace(/\b([XY])(\d+)_(\d+)\b/g, "$1$2.$3");
            // DIADesigner keeps only the first variable of a group: emit one group element per variable.
            const iface = Object.entries(groups).map(([k, v]) => v.map((x) => `<${k}>${x}</${k}>`).join("")).join("");
            const pouType = kindM[1] === "PROGRAM" ? "program" : "functionBlock";
            pouXmls.push(`<pou name="${kindM[2]}" pouType="${pouType}" active="true"><interface>${iface}</interface><body><ST><![CDATA[${code.trimEnd()}\n]]></ST></body></pou>`);
            pous.push(kindM[2]);
            continue;
        }
        warnings.push(`${file}: unrecognised content, skipped`);
        skipped.push(obj);
    }
    const taskPrograms = options.taskPrograms ?? (pous.includes("PlcPrg") ? ["PlcPrg"] : []);
    for (const tp of taskPrograms)
        if (!pous.includes(tp))
            warnings.push(`task program '${tp}' not among generated POUs`);
    const task = taskPrograms.length
        ? `<task priority="${options.taskPriority ?? 0}">${taskPrograms.map((tp) => `<pouInstance name="${tp}" typeName="${tp}" />`).join("")}</task>`
        : "";
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<project><types><dataTypes>${dtXml.join("\n")}</dataTypes><pous>${pouXmls.join("\n")}</pous></types>` +
        `<instances><configurations><configuration name="Config"><resource name="Res">` +
        `<globalVars name="${esc(options.tagTable ?? "Default_Tag_Table")}" type="Default">${globals.join("\n")}</globalVars>${task}` +
        `</resource></configuration></configurations></instances></project>\n`;
    await (0, promises_1.writeFile)(outputPath, xml, "utf8");
    return { outputPath, dataTypes, pous, globalVariables: globals.length, withAddress, skipped, task: taskPrograms, warnings };
}
