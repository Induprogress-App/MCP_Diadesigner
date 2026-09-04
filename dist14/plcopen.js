"use strict";
/**
 * PLCopen `.EXPORT` reader/writer for DIADesigner.
 *
 * This is the supported round trip for program content: DIADesigner exports a
 * `<project><types>` document, we edit it in place, and DIADesigner imports it
 * back. Native `.diade`/`PLC.prog` containers stay encrypted, so nothing here
 * touches them.
 *
 * Edits are byte-range splices rather than a parse/serialize cycle, so anything
 * we do not understand in the document survives untouched.
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
exports.stBodyXml = stBodyXml;
exports.listPous = listPous;
exports.getPou = getPou;
exports.listStructures = listStructures;
exports.listGlobalVariables = listGlobalVariables;
exports.createPou = createPou;
exports.deletePou = deletePou;
exports.setPouCode = setPouCode;
exports.setPouBodyXml = setPouBodyXml;
exports.declareVariables = declareVariables;
exports.createStructure = createStructure;
exports.exportObjects = exportObjects;
exports.importObjects = importObjects;
exports.createEmptyExport = createEmptyExport;
exports.exportFileName = exportFileName;
const crypto_1 = require("crypto");
const promises_1 = require("fs/promises");
const path = __importStar(require("path"));
const interop_js_1 = require("./interop.js");
const xml_js_1 = require("./xml.js");
const VAR_KIND_SCOPE = {
    inputVars: "VAR_INPUT",
    outputVars: "VAR_OUTPUT",
    inOutVars: "VAR_IN_OUT",
    localVars: "VAR",
    tempVars: "VAR_TEMP"
};
const VAR_KIND_ORDER = [
    "inputVars",
    "outputVars",
    "inOutVars",
    "localVars",
    "tempVars"
];
const PRIMITIVE_TYPES = new Set([
    "BOOL", "BYTE", "WORD", "DWORD", "LWORD",
    "SINT", "INT", "DINT", "LINT",
    "USINT", "UINT", "UDINT", "ULINT",
    "REAL", "LREAL",
    "TIME", "DATE", "DT", "TOD", "TIME_OF_DAY", "DATE_AND_TIME",
    "STRING", "WSTRING"
]);
const DERIVED_TYPE_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;
// --------------------------------------------------------------- document ---
async function readExportXml(config, exportFilePath) {
    const fullPath = (0, interop_js_1.resolveWorkspacePath)(config.workspaceDir, exportFilePath);
    await (0, promises_1.stat)(fullPath);
    if (!/\.export$/i.test(fullPath)) {
        throw new Error(`Expected a .EXPORT/.export file, got: ${fullPath}`);
    }
    const buffer = await (0, promises_1.readFile)(fullPath);
    const text = buffer.toString("utf8");
    const hadBom = text.charCodeAt(0) === 0xfeff;
    const xml = hadBom ? text.slice(1) : text;
    assertPlcOpenExport(xml, fullPath);
    return { fullPath, xml, hadBom, newline: (0, xml_js_1.detectNewline)(xml) };
}
async function writeExportXml(config, document, xml, backup) {
    let backupPath;
    if (backup !== false) {
        backupPath = (await (0, interop_js_1.createProjectBackup)(config.workspaceDir, document.fullPath)).backupPath;
    }
    await (0, promises_1.writeFile)(document.fullPath, `${document.hadBom ? "﻿" : ""}${xml}`, "utf8");
    return backupPath;
}
function assertPlcOpenExport(xml, fullPath) {
    const head = xml.slice(0, 400);
    if (!/^\s*<\?xml/i.test(head) && !/^\s*<project\b/i.test(head)) {
        throw new Error(`Not an XML document: ${fullPath}`);
    }
    const project = (0, xml_js_1.findElementRange)(xml, "project");
    const types = project ? (0, xml_js_1.findDirectChildRange)(xml, project, "types") : null;
    if (!project || !types) {
        throw new Error(`File does not contain the expected <project><types> PLCopen structure: ${fullPath}`);
    }
}
function pouRangeByName(xml, name) {
    return (0, xml_js_1.findElementRange)(xml, "pou", 0, (tag) => (0, xml_js_1.parseAttributes)(tag.raw).name === name);
}
function dataTypeRangeByName(xml, name) {
    return (0, xml_js_1.findElementRange)(xml, "dataType", 0, (tag) => (0, xml_js_1.parseAttributes)(tag.raw).name === name);
}
// ------------------------------------------------------------- generation ---
function typeElementXml(typeName, indent) {
    const trimmed = typeName.trim();
    const stringLength = /^(W?STRING)\s*\(\s*(\d+)\s*\)$/i.exec(trimmed);
    if (stringLength) {
        return `${indent}<${stringLength[1].toUpperCase()} length="${stringLength[2]}" />`;
    }
    const arrayMatch = /^ARRAY\s*\[\s*([\d.]+)\s*\]\s*OF\s+(.+)$/i.exec(trimmed);
    if (arrayMatch) {
        const bounds = arrayMatch[1].split("..");
        if (bounds.length !== 2)
            throw new Error(`Unsupported array bounds: ${trimmed}`);
        return [
            `${indent}<array>`,
            `${indent}  <dimension lower="${bounds[0]}" upper="${bounds[1]}" />`,
            `${indent}  <baseType>`,
            typeElementXml(arrayMatch[2], `${indent}    `),
            `${indent}  </baseType>`,
            `${indent}</array>`
        ].join("\n");
    }
    const normalized = trimmed.toUpperCase();
    if (PRIMITIVE_TYPES.has(normalized))
        return `${indent}<${normalized} />`;
    if (!DERIVED_TYPE_RE.test(trimmed)) {
        throw new Error(`Unsupported type declaration: ${typeName}`);
    }
    return `${indent}<derived name="${(0, xml_js_1.xmlEscapeAttribute)(trimmed)}" />`;
}
function typeXml(typeName, indent, newline) {
    const inner = typeElementXml(typeName, `${indent}  `).replace(/\n/g, newline);
    return `${indent}<type>${newline}${inner}${newline}${indent}</type>`;
}
function variableXml(variable, scopeTag, indent, newline) {
    (0, xml_js_1.validateIdentifier)(variable.name, "Variable name");
    const lines = [
        `${indent}<variable name="${(0, xml_js_1.xmlEscapeAttribute)(variable.name)}" globalId="${(0, crypto_1.randomUUID)()}"${variable.address ? ` address="${(0, xml_js_1.xmlEscapeAttribute)(variable.address)}"` : ""}>`,
        typeXml(variable.type, `${indent}  `, newline)
    ];
    if (scopeTag) {
        lines.push(`${indent}  <scope>`);
        lines.push(`${indent}    <${scopeTag} />`);
        lines.push(`${indent}  </scope>`);
    }
    if (variable.initialValue !== undefined) {
        lines.push(`${indent}  <initialValue>`);
        lines.push(`${indent}    <simpleValue value="${(0, xml_js_1.xmlEscapeAttribute)(variable.initialValue)}" />`);
        lines.push(`${indent}  </initialValue>`);
    }
    if (variable.documentation !== undefined) {
        lines.push(`${indent}  <documentation><![CDATA[${(0, xml_js_1.cdata)(variable.documentation)}]]></documentation>`);
    }
    lines.push(`${indent}</variable>`);
    return lines.join(newline);
}
/** One `<inputVars>`-style group holding every variable of that kind. */
function variableGroupXml(kind, variables, indent, newline) {
    const scope = VAR_KIND_SCOPE[kind];
    const body = variables
        .map((variable) => variableXml(variable, scope, `${indent}  `, newline))
        .join(newline);
    return [`${indent}<${kind}>`, body, `${indent}</${kind}>`].join(newline);
}
function stBodyXml(code, newline) {
    return [
        "<body>",
        "  <ST>",
        `    <xhtml xmlns="http://www.w3.org/1999/xhtml"><![CDATA[${(0, xml_js_1.cdata)(code)}]]></xhtml>`,
        "  </ST>",
        "</body>"
    ].join(newline);
}
function assertBodyXml(bodyXml) {
    const trimmed = bodyXml.trim();
    const range = (0, xml_js_1.findElementRange)(trimmed, "body");
    if (!range || range.start !== 0 || range.end !== trimmed.length) {
        throw new Error("bodyXml must be exactly one complete <body>...</body> element");
    }
}
function pouXml(spec, newline) {
    (0, xml_js_1.validateIdentifier)(spec.name, "POU name");
    if (!["program", "functionBlock", "function"].includes(spec.pouType)) {
        throw new Error(`Unsupported pouType: ${spec.pouType}`);
    }
    if (spec.pouType === "function" && !spec.returnType) {
        throw new Error("Function POUs require returnType");
    }
    if (spec.bodyXml)
        assertBodyXml(spec.bodyXml);
    const lines = [
        `<pou name="${(0, xml_js_1.xmlEscapeAttribute)(spec.name)}" pouType="${spec.pouType}">`,
        "  <interface>"
    ];
    if (spec.returnType) {
        lines.push("    <returnType>");
        lines.push(typeElementXml(spec.returnType, "      ").replace(/\n/g, newline));
        lines.push("    </returnType>");
    }
    const groups = [
        ["inputVars", spec.inputVars],
        ["outputVars", spec.outputVars],
        ["inOutVars", spec.inOutVars],
        ["localVars", spec.localVars]
    ];
    for (const [kind, variables] of groups) {
        if (variables && variables.length > 0) {
            lines.push(variableGroupXml(kind, variables, "    ", newline));
        }
    }
    lines.push("  </interface>");
    lines.push((0, xml_js_1.indentBlock)(spec.bodyXml || stBodyXml(spec.code || "", newline), "  ", newline));
    lines.push("</pou>");
    return lines.join(newline);
}
function structureXml(spec, newline) {
    (0, xml_js_1.validateIdentifier)(spec.name, "Structure name");
    if (!spec.fields || spec.fields.length === 0) {
        throw new Error("A structure needs at least one field");
    }
    const lines = [
        `<dataType name="${(0, xml_js_1.xmlEscapeAttribute)(spec.name)}">`,
        "  <baseType>",
        "    <struct>"
    ];
    for (const field of spec.fields) {
        lines.push(variableXml(field, null, "      ", newline));
    }
    lines.push("    </struct>");
    lines.push("  </baseType>");
    lines.push("</dataType>");
    return lines.join(newline);
}
function describeType(xml, typeRange) {
    const inner = (0, xml_js_1.innerXml)(xml, typeRange);
    const tag = (0, xml_js_1.nextXmlTag)(inner, 0);
    if (!tag)
        return "?";
    const attributes = (0, xml_js_1.parseAttributes)(tag.raw);
    if (tag.name === "derived")
        return attributes.name || "derived";
    if (tag.name === "STRING" || tag.name === "WSTRING") {
        return attributes.length ? `${tag.name}(${attributes.length})` : tag.name;
    }
    if (tag.name === "array") {
        const dimension = (0, xml_js_1.findElementRange)(inner, "dimension");
        const base = (0, xml_js_1.findElementRange)(inner, "baseType");
        const dimensionAttributes = dimension ? (0, xml_js_1.parseAttributes)(dimension.openTag) : {};
        const baseName = base ? describeType(inner, base) : "?";
        return `ARRAY[${dimensionAttributes.lower ?? "?"}..${dimensionAttributes.upper ?? "?"}] OF ${baseName}`;
    }
    return tag.name;
}
function readVariables(xml, container, kind) {
    const variables = [];
    for (const range of (0, xml_js_1.findDirectChildren)(xml, container, "variable")) {
        const attributes = (0, xml_js_1.parseAttributes)(range.openTag);
        const typeRange = (0, xml_js_1.findDirectChildRange)(xml, range, "type");
        const initial = (0, xml_js_1.findDirectChildRange)(xml, range, "initialValue");
        let initialValue;
        if (initial) {
            const simple = (0, xml_js_1.findElementRange)(xml, "simpleValue", initial.openEnd);
            if (simple && simple.start < initial.closeStart) {
                initialValue = (0, xml_js_1.parseAttributes)(simple.openTag).value;
            }
        }
        variables.push({
            name: attributes.name ?? "?",
            type: typeRange ? describeType(xml, typeRange) : "?",
            kind,
            initialValue,
            address: attributes.address
        });
    }
    return variables;
}
function pouInterfaceVariables(xml, pou) {
    const iface = (0, xml_js_1.findDirectChildRange)(xml, pou, "interface");
    if (!iface)
        return [];
    const all = [];
    for (const kind of VAR_KIND_ORDER) {
        for (const group of (0, xml_js_1.findDirectChildren)(xml, iface, kind)) {
            all.push(...readVariables(xml, group, kind));
        }
    }
    return all;
}
function firstBodyLanguage(xml, pou) {
    const body = (0, xml_js_1.findDirectChildRange)(xml, pou, "body");
    if (!body)
        return null;
    const inner = (0, xml_js_1.innerXml)(xml, body);
    const tag = (0, xml_js_1.nextXmlTag)(inner, 0);
    return tag ? tag.name : null;
}
function extractStCode(xml, pou) {
    const body = (0, xml_js_1.findDirectChildRange)(xml, pou, "body");
    if (!body)
        return null;
    const section = xml.slice(body.start, body.end);
    const cdataStart = section.indexOf("<![CDATA[");
    if (cdataStart >= 0) {
        const cdataEnd = section.indexOf("]]>", cdataStart + 9);
        if (cdataEnd >= 0)
            return section.slice(cdataStart + 9, cdataEnd);
    }
    const xhtml = (0, xml_js_1.findElementRange)(section, "xhtml");
    if (xhtml)
        return (0, xml_js_1.innerXml)(section, xhtml).trim();
    return null;
}
function summarizePou(xml, pou) {
    const attributes = (0, xml_js_1.parseAttributes)(pou.openTag);
    const variables = pouInterfaceVariables(xml, pou);
    const counts = {};
    for (const kind of VAR_KIND_ORDER) {
        const n = variables.filter((v) => v.kind === kind).length;
        if (n > 0)
            counts[kind] = n;
    }
    return {
        name: attributes.name ?? "?",
        pouType: attributes.pouType ?? "?",
        bodyLanguage: firstBodyLanguage(xml, pou),
        variableCounts: counts
    };
}
async function listPous(config, exportFilePath) {
    const document = await readExportXml(config, exportFilePath);
    const pous = [];
    let from = 0;
    let range;
    while ((range = (0, xml_js_1.findElementRange)(document.xml, "pou", from)) !== null) {
        pous.push(summarizePou(document.xml, range));
        from = range.end;
    }
    return { path: document.fullPath, pouCount: pous.length, pous };
}
async function getPou(config, exportFilePath, name) {
    const document = await readExportXml(config, exportFilePath);
    const range = pouRangeByName(document.xml, name);
    if (!range)
        throw new Error(`POU not found: ${name}`);
    const body = (0, xml_js_1.findDirectChildRange)(document.xml, range, "body");
    const iface = (0, xml_js_1.findDirectChildRange)(document.xml, range, "interface");
    return {
        path: document.fullPath,
        ...summarizePou(document.xml, range),
        variables: pouInterfaceVariables(document.xml, range),
        stCode: extractStCode(document.xml, range),
        interfaceXml: iface ? document.xml.slice(iface.start, iface.end) : null,
        bodyXml: body ? document.xml.slice(body.start, body.end) : null
    };
}
async function listStructures(config, exportFilePath) {
    const document = await readExportXml(config, exportFilePath);
    const structures = [];
    let from = 0;
    let range;
    while ((range = (0, xml_js_1.findElementRange)(document.xml, "dataType", from)) !== null) {
        const attributes = (0, xml_js_1.parseAttributes)(range.openTag);
        const struct = (0, xml_js_1.findElementRange)(document.xml, "struct", range.openEnd);
        const fields = struct && struct.start < range.closeStart
            ? readVariables(document.xml, struct, "field")
            : [];
        structures.push({ name: attributes.name ?? "?", fields });
        from = range.end;
    }
    return { path: document.fullPath, structureCount: structures.length, structures };
}
async function listGlobalVariables(config, exportFilePath) {
    const document = await readExportXml(config, exportFilePath);
    const groups = [];
    let from = 0;
    let range;
    while ((range = (0, xml_js_1.findElementRange)(document.xml, "globalVars", from)) !== null) {
        const attributes = (0, xml_js_1.parseAttributes)(range.openTag);
        groups.push({
            name: attributes.name ?? "(unnamed)",
            variables: readVariables(document.xml, range, "field")
        });
        from = range.end;
    }
    return { path: document.fullPath, groupCount: groups.length, groups };
}
// ----------------------------------------------------------------- writing ---
async function createPou(config, exportFilePath, spec) {
    const document = await readExportXml(config, exportFilePath);
    let xml = document.xml;
    const existing = pouRangeByName(xml, spec.name);
    const generated = pouXml(spec, document.newline);
    let action = "created";
    if (existing) {
        if (!spec.overwrite) {
            throw new Error(`POU already exists: ${spec.name}. Pass overwrite=true to replace it.`);
        }
        const indent = (0, xml_js_1.indentOfLine)(xml, existing.start);
        xml = (0, xml_js_1.spliceIndentedBlock)(xml, existing.start, existing.end, generated, indent, document.newline);
        action = "replaced";
    }
    else {
        const ensured = (0, xml_js_1.ensureChildContainer)(xml, "types", "pous", document.newline);
        xml = (0, xml_js_1.insertAsLastChild)(ensured.xml, ensured.range, generated, document.newline);
    }
    const backupPath = await writeExportXml(config, document, xml, spec.backup);
    return { path: document.fullPath, backupPath, action, name: spec.name, pouType: spec.pouType };
}
async function deletePou(config, exportFilePath, name, backup) {
    const document = await readExportXml(config, exportFilePath);
    const range = pouRangeByName(document.xml, name);
    if (!range)
        throw new Error(`POU not found: ${name}`);
    const lineStart = range.start - (0, xml_js_1.indentOfLine)(document.xml, range.start).length;
    let end = range.end;
    // swallow the trailing newline so no blank line is left behind
    if (document.xml.startsWith(document.newline, end))
        end += document.newline.length;
    const xml = (0, xml_js_1.replaceRange)(document.xml, lineStart, end, "");
    const backupPath = await writeExportXml(config, document, xml, backup);
    return { path: document.fullPath, backupPath, action: "deleted", name };
}
async function setPouCode(config, exportFilePath, name, code, backup) {
    return setPouBodyXml(config, exportFilePath, name, stBodyXml(code, "\n"), backup, "generated-st");
}
async function setPouBodyXml(config, exportFilePath, name, bodyXml, backup, kind = "verbatim") {
    assertBodyXml(bodyXml);
    const document = await readExportXml(config, exportFilePath);
    const pou = pouRangeByName(document.xml, name);
    if (!pou)
        throw new Error(`POU not found: ${name}`);
    const body = (0, xml_js_1.findDirectChildRange)(document.xml, pou, "body");
    if (!body)
        throw new Error(`POU has no <body> element: ${name}`);
    const indent = (0, xml_js_1.indentOfLine)(document.xml, body.start);
    const xml = (0, xml_js_1.spliceIndentedBlock)(document.xml, body.start, body.end, bodyXml, indent, document.newline);
    const backupPath = await writeExportXml(config, document, xml, backup);
    return { path: document.fullPath, backupPath, action: "updated", name, bodySource: kind };
}
/**
 * Adds variables to a POU interface.
 *
 * When a group of that kind already exists the variables are appended to it, so
 * the file keeps whatever grouping style DIADesigner wrote. Only when no group
 * exists do we create one.
 */
async function declareVariables(config, exportFilePath, pouName, kind, variables, options = {}) {
    if (!variables || variables.length === 0) {
        throw new Error("No variables supplied");
    }
    if (!VAR_KIND_ORDER.includes(kind)) {
        throw new Error(`Unsupported variable kind: ${kind}`);
    }
    const document = await readExportXml(config, exportFilePath);
    let xml = document.xml;
    const pou = pouRangeByName(xml, pouName);
    if (!pou)
        throw new Error(`POU not found: ${pouName}`);
    const iface = (0, xml_js_1.findDirectChildRange)(xml, pou, "interface");
    if (!iface)
        throw new Error(`POU has no <interface> element: ${pouName}`);
    const existingNames = new Set(pouInterfaceVariables(xml, pou).map((v) => v.name.toUpperCase()));
    const conflicts = variables.filter((v) => existingNames.has(v.name.toUpperCase()));
    if (conflicts.length > 0 && !options.replaceExisting) {
        throw new Error(`Already declared in ${pouName}: ${conflicts.map((v) => v.name).join(", ")}. Pass replaceExisting=true to overwrite.`);
    }
    // Drop the variables we are about to redeclare, deepest-last so earlier
    // offsets stay valid while splicing.
    if (conflicts.length > 0) {
        const doomed = new Set(conflicts.map((v) => v.name.toUpperCase()));
        for (;;) {
            const currentPou = pouRangeByName(xml, pouName);
            if (!currentPou)
                break;
            const currentIface = (0, xml_js_1.findDirectChildRange)(xml, currentPou, "interface");
            if (!currentIface)
                break;
            let removed = false;
            for (const groupKind of VAR_KIND_ORDER) {
                for (const group of (0, xml_js_1.findDirectChildren)(xml, currentIface, groupKind)) {
                    for (const variable of (0, xml_js_1.findDirectChildren)(xml, group, "variable")) {
                        const name = (0, xml_js_1.parseAttributes)(variable.openTag).name ?? "";
                        if (!doomed.has(name.toUpperCase()))
                            continue;
                        const lineStart = variable.start - (0, xml_js_1.indentOfLine)(xml, variable.start).length;
                        let end = variable.end;
                        if (xml.startsWith(document.newline, end))
                            end += document.newline.length;
                        xml = (0, xml_js_1.replaceRange)(xml, lineStart, end, "");
                        removed = true;
                        break;
                    }
                    if (removed)
                        break;
                }
                if (removed)
                    break;
            }
            if (!removed)
                break;
        }
    }
    const pouAfter = pouRangeByName(xml, pouName);
    if (!pouAfter)
        throw new Error(`POU disappeared while editing: ${pouName}`);
    const ifaceAfter = (0, xml_js_1.findDirectChildRange)(xml, pouAfter, "interface");
    if (!ifaceAfter)
        throw new Error(`Interface disappeared while editing: ${pouName}`);
    const groups = (0, xml_js_1.findDirectChildren)(xml, ifaceAfter, kind);
    let placement;
    if (groups.length > 0) {
        const target = groups[groups.length - 1];
        const block = variables
            .map((variable) => variableXml(variable, VAR_KIND_SCOPE[kind], "", document.newline))
            .join(document.newline);
        xml = (0, xml_js_1.insertAsLastChild)(xml, target, block, document.newline);
        placement = "appended";
    }
    else {
        const block = variableGroupXml(kind, variables, "", document.newline);
        xml = (0, xml_js_1.insertAsLastChild)(xml, ifaceAfter, block, document.newline);
        placement = "group-created";
    }
    const backupPath = await writeExportXml(config, document, xml, options.backup);
    return {
        path: document.fullPath,
        backupPath,
        pou: pouName,
        kind,
        placement,
        declared: variables.map((v) => `${v.name} : ${v.type}`),
        replaced: conflicts.map((v) => v.name)
    };
}
async function createStructure(config, exportFilePath, spec) {
    const document = await readExportXml(config, exportFilePath);
    let xml = document.xml;
    const existing = dataTypeRangeByName(xml, spec.name);
    const generated = structureXml(spec, document.newline);
    let action = "created";
    if (existing) {
        if (!spec.overwrite) {
            throw new Error(`Data type already exists: ${spec.name}. Pass overwrite=true to replace it.`);
        }
        const indent = (0, xml_js_1.indentOfLine)(xml, existing.start);
        xml = (0, xml_js_1.spliceIndentedBlock)(xml, existing.start, existing.end, generated, indent, document.newline);
        action = "replaced";
    }
    else {
        const ensured = (0, xml_js_1.ensureChildContainer)(xml, "types", "dataTypes", document.newline);
        xml = (0, xml_js_1.insertAsLastChild)(ensured.xml, ensured.range, generated, document.newline);
    }
    const backupPath = await writeExportXml(config, document, xml, spec.backup);
    return { path: document.fullPath, backupPath, action, name: spec.name };
}
// ------------------------------------------------------- export and import ---
const EMPTY_EXPORT = (newline) => [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<project>",
    "  <types>",
    "    <dataTypes>",
    "    </dataTypes>",
    "    <pous>",
    "    </pous>",
    "  </types>",
    "</project>",
    ""
].join(newline);
/**
 * Writes selected POUs and data types into a fresh `.EXPORT` document that
 * DIADesigner can import. Elements are copied verbatim from the source.
 */
async function exportObjects(config, sourceExportPath, targetPath, selection) {
    const source = await readExportXml(config, sourceExportPath);
    const newline = source.newline;
    const fullTarget = (0, interop_js_1.resolveWorkspacePath)(config.workspaceDir, targetPath);
    if (!/\.export$/i.test(fullTarget)) {
        throw new Error(`Target must be a .EXPORT file: ${fullTarget}`);
    }
    let xml = EMPTY_EXPORT(newline);
    const exportedPous = [];
    const exportedTypes = [];
    for (const name of selection.dataTypes ?? []) {
        const range = dataTypeRangeByName(source.xml, name);
        if (!range)
            throw new Error(`Data type not found in source: ${name}`);
        const block = source.xml.slice(range.start, range.end);
        const container = (0, xml_js_1.findElementRange)(xml, "dataTypes");
        if (!container)
            throw new Error("Malformed export skeleton");
        xml = (0, xml_js_1.insertAsLastChild)(xml, container, block, newline);
        exportedTypes.push(name);
    }
    for (const name of selection.pous ?? []) {
        const range = pouRangeByName(source.xml, name);
        if (!range)
            throw new Error(`POU not found in source: ${name}`);
        const block = source.xml.slice(range.start, range.end);
        const container = (0, xml_js_1.findElementRange)(xml, "pous");
        if (!container)
            throw new Error("Malformed export skeleton");
        xml = (0, xml_js_1.insertAsLastChild)(xml, container, block, newline);
        exportedPous.push(name);
    }
    if (exportedPous.length === 0 && exportedTypes.length === 0) {
        throw new Error("Nothing selected to export");
    }
    await (0, promises_1.writeFile)(fullTarget, xml, "utf8");
    return {
        source: source.fullPath,
        target: fullTarget,
        exportedPous,
        exportedDataTypes: exportedTypes,
        note: "Import this file in DIADesigner to bring the objects into a native project."
    };
}
/**
 * Merges POUs and data types from another `.EXPORT` file into this one.
 * Existing objects are only touched when `overwrite` is set.
 */
async function importObjects(config, targetExportPath, sourceExportPath, options = {}) {
    const target = await readExportXml(config, targetExportPath);
    const source = await readExportXml(config, sourceExportPath);
    const newline = target.newline;
    let xml = target.xml;
    const collect = (xmlText, tagName) => {
        const found = new Map();
        let from = 0;
        let range;
        while ((range = (0, xml_js_1.findElementRange)(xmlText, tagName, from)) !== null) {
            const name = (0, xml_js_1.parseAttributes)(range.openTag).name;
            if (name)
                found.set(name, xmlText.slice(range.start, range.end));
            from = range.end;
        }
        return found;
    };
    const sourceTypes = collect(source.xml, "dataType");
    const sourcePous = collect(source.xml, "pou");
    const wantedTypes = options.dataTypes ?? Array.from(sourceTypes.keys());
    const wantedPous = options.pous ?? Array.from(sourcePous.keys());
    const imported = [];
    const replaced = [];
    const skipped = [];
    for (const name of wantedTypes) {
        const block = sourceTypes.get(name);
        if (!block)
            throw new Error(`Data type not found in source: ${name}`);
        const existing = dataTypeRangeByName(xml, name);
        if (existing) {
            if (!options.overwrite) {
                skipped.push(`dataType:${name}`);
                continue;
            }
            const indent = (0, xml_js_1.indentOfLine)(xml, existing.start);
            xml = (0, xml_js_1.spliceIndentedBlock)(xml, existing.start, existing.end, block, indent, newline);
            replaced.push(`dataType:${name}`);
        }
        else {
            const ensured = (0, xml_js_1.ensureChildContainer)(xml, "types", "dataTypes", newline);
            xml = (0, xml_js_1.insertAsLastChild)(ensured.xml, ensured.range, block, newline);
            imported.push(`dataType:${name}`);
        }
    }
    for (const name of wantedPous) {
        const block = sourcePous.get(name);
        if (!block)
            throw new Error(`POU not found in source: ${name}`);
        const existing = pouRangeByName(xml, name);
        if (existing) {
            if (!options.overwrite) {
                skipped.push(`pou:${name}`);
                continue;
            }
            const indent = (0, xml_js_1.indentOfLine)(xml, existing.start);
            xml = (0, xml_js_1.spliceIndentedBlock)(xml, existing.start, existing.end, block, indent, newline);
            replaced.push(`pou:${name}`);
        }
        else {
            const ensured = (0, xml_js_1.ensureChildContainer)(xml, "types", "pous", newline);
            xml = (0, xml_js_1.insertAsLastChild)(ensured.xml, ensured.range, block, newline);
            imported.push(`pou:${name}`);
        }
    }
    const backupPath = await writeExportXml(config, target, xml, options.backup);
    return {
        target: target.fullPath,
        source: source.fullPath,
        backupPath,
        imported,
        replaced,
        skipped
    };
}
/** Creates an empty PLCopen export document to build a program up from nothing. */
async function createEmptyExport(config, targetPath) {
    const fullTarget = (0, interop_js_1.resolveWorkspacePath)(config.workspaceDir, targetPath);
    if (!/\.export$/i.test(fullTarget)) {
        throw new Error(`Target must be a .EXPORT file: ${fullTarget}`);
    }
    await (0, promises_1.writeFile)(fullTarget, EMPTY_EXPORT("\r\n"), "utf8");
    return { path: fullTarget, note: "Empty PLCopen export created." };
}
function exportFileName(fullPath) {
    return path.basename(fullPath);
}
