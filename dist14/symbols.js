"use strict";
/**
 * DiaTag `Symbolconfiguration` editor.
 *
 * DIADesigner stores the tag/symbol table as plain XML next to the project, so
 * unlike the program itself it can be edited directly. This module also does the
 * D-register arithmetic: node addresses are derived from the real declared type
 * sizes in the file, not guessed.
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
exports.listSymbolStructures = listSymbolStructures;
exports.listSymbolGlobalNodes = listSymbolGlobalNodes;
exports.findFreeDRange = findFreeDRange;
exports.createSymbolStructure = createSymbolStructure;
exports.createSymbolGlobalNode = createSymbolGlobalNode;
const promises_1 = require("fs/promises");
const path = __importStar(require("path"));
const interop_js_1 = require("./interop.js");
const xml_js_1 = require("./xml.js");
const DIRECT_D_RE = /^D(\d+)$/i;
const IEC_TYPE_TO_SYMBOL_TYPE = {
    BOOL: "T_BOOL",
    INT: "T_INT",
    REAL: "T_REAL",
    FLOAT: "T_REAL",
    DINT: "T_DINT",
    DWORD: "T_DWORD",
    WORD: "T_WORD",
    TIMER: "T_TIMER"
};
function normalizeSymbolType(typeName) {
    const trimmed = typeName.trim();
    return IEC_TYPE_TO_SYMBOL_TYPE[trimmed.toUpperCase()] || trimmed;
}
function symbolTypeForStructureName(name) {
    return name.startsWith("T_") ? name : `T_${name}`;
}
function publicTypeName(typeName) {
    return typeName.replace(/^T_/, "");
}
/**
 * Accepts a DiaTag XML path, a `.diade` path, or a project directory and
 * resolves to the single symbol XML under `<project>/DiaTag`.
 */
async function resolveSymbolXmlPath(config, inputPath) {
    const fullPath = (0, interop_js_1.resolveWorkspacePath)(config.workspaceDir, inputPath);
    const info = await (0, promises_1.stat)(fullPath);
    const lower = fullPath.toLowerCase();
    if (info.isFile() && lower.endsWith(".xml"))
        return fullPath;
    const projectDir = info.isFile() && lower.endsWith(".diade") ? path.dirname(fullPath) : info.isDirectory() ? fullPath : path.dirname(fullPath);
    const diaTagDir = path.join(projectDir, "DiaTag");
    const entries = await (0, promises_1.readdir)(diaTagDir, { withFileTypes: true });
    const xmlFiles = entries
        .filter((entry) => entry.isFile() &&
        entry.name.toLowerCase().endsWith(".xml") &&
        entry.name.toLowerCase() !== "devicelist.xml")
        .map((entry) => path.join(diaTagDir, entry.name));
    if (xmlFiles.length !== 1) {
        throw new Error(`Expected exactly one DiaTag symbol XML under ${diaTagDir}, found ${xmlFiles.length}`);
    }
    return xmlFiles[0];
}
async function readSymbolXml(config, inputPath) {
    const fullPath = await resolveSymbolXmlPath(config, inputPath);
    const buffer = await (0, promises_1.readFile)(fullPath);
    const text = buffer.toString("utf8");
    const hadBom = text.charCodeAt(0) === 0xfeff;
    const xml = hadBom ? text.slice(1) : text;
    if (!/<Symbolconfiguration\b/i.test(xml.slice(0, 400))) {
        throw new Error(`Not a DIADesigner DiaTag Symbolconfiguration XML: ${fullPath}`);
    }
    return { fullPath, xml, hadBom, newline: (0, xml_js_1.detectNewline)(xml) };
}
async function writeSymbolXml(config, document, xml, backup) {
    let backupPath;
    if (backup !== false) {
        backupPath = (await (0, interop_js_1.createProjectBackup)(config.workspaceDir, document.fullPath)).backupPath;
    }
    await (0, promises_1.writeFile)(document.fullPath, `${document.hadBom ? "﻿" : ""}${xml}`, "utf8");
    return backupPath;
}
/** Declared byte size of every type in the file, keyed by DiaTag type name. */
function buildTypeSizeMap(xml) {
    const sizes = new Map();
    const typeRe = /<Type(?:Simple|Array|UserDef)\b[^>]*>/g;
    let match;
    while ((match = typeRe.exec(xml)) !== null) {
        const attributes = (0, xml_js_1.parseAttributes)(match[0]);
        const size = Number(attributes.size);
        if (attributes.name && Number.isFinite(size))
            sizes.set(attributes.name, size);
    }
    return sizes;
}
function listGlobalNodesFromXml(xml) {
    const sizes = buildTypeSizeMap(xml);
    const nodes = [];
    const nodeRe = /<Node\b[^>]*\/>/g;
    let match;
    while ((match = nodeRe.exec(xml)) !== null) {
        const attributes = (0, xml_js_1.parseAttributes)(match[0]);
        if (!attributes.name || !attributes.type)
            continue;
        const sizeBytes = sizes.get(attributes.type);
        const dMatch = attributes.directaddress ? DIRECT_D_RE.exec(attributes.directaddress) : null;
        const startD = dMatch ? Number(dMatch[1]) : undefined;
        const endD = startD !== undefined && sizeBytes !== undefined
            ? startD + Math.ceil(sizeBytes / 2) - 1
            : undefined;
        nodes.push({
            name: attributes.name,
            type: attributes.type,
            directaddress: attributes.directaddress,
            access: attributes.access,
            startD,
            endD,
            sizeBytes
        });
    }
    return nodes;
}
function dRanges(xml) {
    return listGlobalNodesFromXml(xml)
        .filter((node) => node.startD !== undefined && node.endD !== undefined && node.sizeBytes !== undefined)
        .map((node) => ({
        name: node.name,
        type: node.type,
        startD: node.startD,
        endD: node.endD,
        sizeBytes: node.sizeBytes
    }))
        .sort((a, b) => a.startD - b.startD || a.endD - b.endD);
}
function findFreeDGaps(xml, requiredBytes, minD, maxD) {
    const requiredWords = Math.ceil(requiredBytes / 2);
    const occupied = dRanges(xml);
    const gaps = [];
    let cursor = minD;
    for (const range of occupied) {
        if (range.endD < minD || range.startD > maxD)
            continue;
        if (range.startD > cursor) {
            const startD = cursor;
            const endD = Math.min(range.startD - 1, maxD);
            if (endD - startD + 1 >= requiredWords)
                gaps.push({ startD, endD, words: endD - startD + 1 });
        }
        cursor = Math.max(cursor, range.endD + 1);
    }
    if (cursor <= maxD && maxD - cursor + 1 >= requiredWords) {
        gaps.push({ startD: cursor, endD: maxD, words: maxD - cursor + 1 });
    }
    return { gaps, occupied };
}
function isDRangeFree(occupied, startD, requiredBytes) {
    const endD = startD + Math.ceil(requiredBytes / 2) - 1;
    return occupied.every((range) => endD < range.startD || startD > range.endD);
}
function findElementByOpenTag(xml, tagName, predicate) {
    return (0, xml_js_1.findElementRange)(xml, tagName, 0, (tag) => predicate(tag.raw));
}
// ------------------------------------------------------------------ public ---
async function listSymbolStructures(config, projectOrSymbolPath) {
    const document = await readSymbolXml(config, projectOrSymbolPath);
    const structures = [];
    const typeRe = /<TypeUserDef\b[^>]*>[\s\S]*?<\/TypeUserDef>/g;
    let match;
    while ((match = typeRe.exec(document.xml)) !== null) {
        const openTagEnd = match[0].indexOf(">");
        const attributes = (0, xml_js_1.parseAttributes)(match[0].slice(0, openTagEnd + 1));
        if (attributes.pouclass !== "STRUCTURE")
            continue;
        structures.push({
            name: attributes.name,
            iecname: attributes.iecname,
            sizeBytes: Number(attributes.size),
            fieldCount: (match[0].match(/<UserDefElement\b/g) || []).length
        });
    }
    return { path: document.fullPath, structureCount: structures.length, structures };
}
async function listSymbolGlobalNodes(config, projectOrSymbolPath) {
    const document = await readSymbolXml(config, projectOrSymbolPath);
    const nodes = listGlobalNodesFromXml(document.xml);
    return { path: document.fullPath, nodeCount: nodes.length, nodes };
}
async function findFreeDRange(config, projectOrSymbolPath, requiredBytes, preferredDAddress, minD = 0, maxD = 32767) {
    const document = await readSymbolXml(config, projectOrSymbolPath);
    const { gaps, occupied } = findFreeDGaps(document.xml, requiredBytes, minD, maxD);
    const requiredWords = Math.ceil(requiredBytes / 2);
    return {
        path: document.fullPath,
        requiredBytes,
        requiredWords,
        preferred: preferredDAddress === undefined
            ? undefined
            : {
                startD: preferredDAddress,
                endD: preferredDAddress + requiredWords - 1,
                free: isDRangeFree(occupied, preferredDAddress, requiredBytes)
            },
        gaps
    };
}
async function createSymbolStructure(config, projectOrSymbolPath, spec) {
    (0, xml_js_1.validateIdentifier)(spec.name, "Structure name");
    const document = await readSymbolXml(config, projectOrSymbolPath);
    const typeName = symbolTypeForStructureName(spec.name);
    const iecname = publicTypeName(typeName);
    const sizes = buildTypeSizeMap(document.xml);
    let offset = 0;
    const fieldsXml = [];
    for (const field of spec.fields) {
        (0, xml_js_1.validateIdentifier)(field.name, "Field name");
        const symbolType = normalizeSymbolType(field.type);
        const size = sizes.get(symbolType);
        if (!size) {
            throw new Error(`Unknown DiaTag type '${field.type}' (normalized to '${symbolType}')`);
        }
        fieldsXml.push(`      <UserDefElement iecname="${(0, xml_js_1.xmlEscapeAttribute)(field.name)}" type="${(0, xml_js_1.xmlEscapeAttribute)(symbolType)}" vartype="VAR" byteoffset="${offset}" />`);
        offset += size;
    }
    const generated = [
        `    <TypeUserDef name="${(0, xml_js_1.xmlEscapeAttribute)(typeName)}" iecname="${(0, xml_js_1.xmlEscapeAttribute)(iecname)}" pouclass="STRUCTURE" typeclass="Userdef" size="${offset}" swapsize="${offset}">`,
        ...fieldsXml,
        "    </TypeUserDef>"
    ].join(document.newline);
    const existing = findElementByOpenTag(document.xml, "TypeUserDef", (tag) => (0, xml_js_1.parseAttributes)(tag).name === typeName);
    let xml = document.xml;
    let action = "created";
    if (existing) {
        if (!spec.overwrite) {
            throw new Error(`Structure already exists: ${typeName}. Pass overwrite=true to replace it.`);
        }
        xml = xml.slice(0, existing.start) + generated.trimStart() + xml.slice(existing.end);
        action = "replaced";
    }
    else {
        const typeListClose = xml.indexOf("  </TypeList>");
        if (typeListClose < 0)
            throw new Error("Could not find closing </TypeList> in symbol XML");
        xml = xml.slice(0, typeListClose) + `${generated}${document.newline}` + xml.slice(typeListClose);
    }
    const backupPath = await writeSymbolXml(config, document, xml, spec.backup);
    return { path: document.fullPath, backupPath, action, typeName, iecname, sizeBytes: offset };
}
async function createSymbolGlobalNode(config, projectOrSymbolPath, spec) {
    (0, xml_js_1.validateIdentifier)(spec.name, "Global node name");
    const document = await readSymbolXml(config, projectOrSymbolPath);
    const sizes = buildTypeSizeMap(document.xml);
    const typeName = symbolTypeForStructureName(spec.typeName);
    const sizeBytes = sizes.get(typeName);
    if (!sizeBytes)
        throw new Error(`Unknown DiaTag type: ${typeName}`);
    if (listGlobalNodesFromXml(document.xml).some((node) => node.name === spec.name)) {
        throw new Error(`Global node already exists: ${spec.name}`);
    }
    const { gaps, occupied } = findFreeDGaps(document.xml, sizeBytes, 0, 32767);
    let startD = spec.preferredDAddress ?? gaps[0]?.startD;
    const notes = [];
    if (startD === undefined) {
        throw new Error(`No free D range large enough for ${typeName} (${sizeBytes} bytes)`);
    }
    if (spec.preferredDAddress !== undefined &&
        !isDRangeFree(occupied, spec.preferredDAddress, sizeBytes)) {
        const preferredEnd = spec.preferredDAddress + Math.ceil(sizeBytes / 2) - 1;
        const nextGap = gaps.find((gap) => gap.startD >= spec.preferredDAddress) ||
            gaps.find((gap) => gap.endD >= preferredEnd);
        if (!spec.useNextFree || nextGap === undefined) {
            throw new Error(`Preferred D${spec.preferredDAddress} is occupied. Pass useNextFree=true to use D${nextGap?.startD}.`);
        }
        notes.push(`Preferred D${spec.preferredDAddress} was occupied; used next free range D${nextGap.startD}.`);
        startD = nextGap.startD;
    }
    const defaultTable = findElementByOpenTag(document.xml, "Node", (tag) => (0, xml_js_1.parseAttributes)(tag).name === "Default_Tag_Table");
    if (!defaultTable || defaultTable.selfClosing) {
        throw new Error('Could not find <Node name="Default_Tag_Table"> container');
    }
    const node = `<Node name="${(0, xml_js_1.xmlEscapeAttribute)(spec.name)}" type="${(0, xml_js_1.xmlEscapeAttribute)(typeName)}" access="ReadWrite" directaddress="D${startD}" />`;
    const xml = (0, xml_js_1.insertAsLastChild)(document.xml, defaultTable, node, document.newline);
    const backupPath = await writeSymbolXml(config, document, xml, spec.backup);
    return {
        path: document.fullPath,
        backupPath,
        action: "created",
        name: spec.name,
        typeName,
        directaddress: `D${startD}`,
        sizeBytes,
        notes
    };
}
