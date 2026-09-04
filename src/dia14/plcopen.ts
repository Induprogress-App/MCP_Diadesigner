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

import { randomUUID } from "crypto";
import { readFile, stat, writeFile } from "fs/promises";
import * as path from "path";
import { DiaConfig, createProjectBackup, resolveWorkspacePath } from "./interop.js";
import {
  XmlRange,
  cdata,
  detectNewline,
  ensureChildContainer,
  findDirectChildRange,
  findDirectChildren,
  findElementRange,
  indentBlock,
  indentOfLine,
  innerXml,
  insertAsLastChild,
  nextXmlTag,
  parseAttributes,
  replaceRange,
  spliceIndentedBlock,
  validateIdentifier,
  xmlEscapeAttribute
} from "./xml.js";

export type PouType = "program" | "functionBlock" | "function";
export type VarKind = "inputVars" | "outputVars" | "inOutVars" | "localVars" | "tempVars";

const VAR_KIND_SCOPE: Record<VarKind, string> = {
  inputVars: "VAR_INPUT",
  outputVars: "VAR_OUTPUT",
  inOutVars: "VAR_IN_OUT",
  localVars: "VAR",
  tempVars: "VAR_TEMP"
};

const VAR_KIND_ORDER: VarKind[] = [
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

export interface VariableSpec {
  name: string;
  type: string;
  initialValue?: string;
  address?: string;
  documentation?: string;
}

export interface PouSpec {
  name: string;
  pouType: PouType;
  returnType?: string;
  inputVars?: VariableSpec[];
  outputVars?: VariableSpec[];
  inOutVars?: VariableSpec[];
  localVars?: VariableSpec[];
  code?: string;
  bodyXml?: string;
  overwrite?: boolean;
  backup?: boolean;
}

export interface StructureSpec {
  name: string;
  fields: VariableSpec[];
  overwrite?: boolean;
  backup?: boolean;
}

interface ExportDocument {
  fullPath: string;
  xml: string;
  hadBom: boolean;
  newline: string;
}

// --------------------------------------------------------------- document ---

async function readExportXml(config: DiaConfig, exportFilePath: string): Promise<ExportDocument> {
  const fullPath = resolveWorkspacePath(config.workspaceDir, exportFilePath);
  await stat(fullPath);
  if (!/\.export$/i.test(fullPath)) {
    throw new Error(`Expected a .EXPORT/.export file, got: ${fullPath}`);
  }
  const buffer = await readFile(fullPath);
  const text = buffer.toString("utf8");
  const hadBom = text.charCodeAt(0) === 0xfeff;
  const xml = hadBom ? text.slice(1) : text;
  assertPlcOpenExport(xml, fullPath);
  return { fullPath, xml, hadBom, newline: detectNewline(xml) };
}

async function writeExportXml(
  config: DiaConfig,
  document: ExportDocument,
  xml: string,
  backup?: boolean
): Promise<string | undefined> {
  let backupPath: string | undefined;
  if (backup !== false) {
    backupPath = (await createProjectBackup(config.workspaceDir, document.fullPath)).backupPath;
  }
  await writeFile(document.fullPath, `${document.hadBom ? "﻿" : ""}${xml}`, "utf8");
  return backupPath;
}

function assertPlcOpenExport(xml: string, fullPath: string): void {
  const head = xml.slice(0, 400);
  if (!/^\s*<\?xml/i.test(head) && !/^\s*<project\b/i.test(head)) {
    throw new Error(`Not an XML document: ${fullPath}`);
  }
  const project = findElementRange(xml, "project");
  const types = project ? findDirectChildRange(xml, project, "types") : null;
  if (!project || !types) {
    throw new Error(
      `File does not contain the expected <project><types> PLCopen structure: ${fullPath}`
    );
  }
}

function pouRangeByName(xml: string, name: string): XmlRange | null {
  return findElementRange(xml, "pou", 0, (tag) => parseAttributes(tag.raw).name === name);
}

function dataTypeRangeByName(xml: string, name: string): XmlRange | null {
  return findElementRange(xml, "dataType", 0, (tag) => parseAttributes(tag.raw).name === name);
}

// ------------------------------------------------------------- generation ---

function typeElementXml(typeName: string, indent: string): string {
  const trimmed = typeName.trim();
  const stringLength = /^(W?STRING)\s*\(\s*(\d+)\s*\)$/i.exec(trimmed);
  if (stringLength) {
    return `${indent}<${stringLength[1].toUpperCase()} length="${stringLength[2]}" />`;
  }
  const arrayMatch = /^ARRAY\s*\[\s*([\d.]+)\s*\]\s*OF\s+(.+)$/i.exec(trimmed);
  if (arrayMatch) {
    const bounds = arrayMatch[1].split("..");
    if (bounds.length !== 2) throw new Error(`Unsupported array bounds: ${trimmed}`);
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
  if (PRIMITIVE_TYPES.has(normalized)) return `${indent}<${normalized} />`;
  if (!DERIVED_TYPE_RE.test(trimmed)) {
    throw new Error(`Unsupported type declaration: ${typeName}`);
  }
  return `${indent}<derived name="${xmlEscapeAttribute(trimmed)}" />`;
}

function typeXml(typeName: string, indent: string, newline: string): string {
  const inner = typeElementXml(typeName, `${indent}  `).replace(/\n/g, newline);
  return `${indent}<type>${newline}${inner}${newline}${indent}</type>`;
}

function variableXml(
  variable: VariableSpec,
  scopeTag: string | null,
  indent: string,
  newline: string
): string {
  validateIdentifier(variable.name, "Variable name");
  const lines = [
    `${indent}<variable name="${xmlEscapeAttribute(variable.name)}" globalId="${randomUUID()}"${
      variable.address ? ` address="${xmlEscapeAttribute(variable.address)}"` : ""
    }>`,
    typeXml(variable.type, `${indent}  `, newline)
  ];
  if (scopeTag) {
    lines.push(`${indent}  <scope>`);
    lines.push(`${indent}    <${scopeTag} />`);
    lines.push(`${indent}  </scope>`);
  }
  if (variable.initialValue !== undefined) {
    lines.push(`${indent}  <initialValue>`);
    lines.push(`${indent}    <simpleValue value="${xmlEscapeAttribute(variable.initialValue)}" />`);
    lines.push(`${indent}  </initialValue>`);
  }
  if (variable.documentation !== undefined) {
    lines.push(`${indent}  <documentation><![CDATA[${cdata(variable.documentation)}]]></documentation>`);
  }
  lines.push(`${indent}</variable>`);
  return lines.join(newline);
}

/** One `<inputVars>`-style group holding every variable of that kind. */
function variableGroupXml(
  kind: VarKind,
  variables: VariableSpec[],
  indent: string,
  newline: string
): string {
  const scope = VAR_KIND_SCOPE[kind];
  const body = variables
    .map((variable) => variableXml(variable, scope, `${indent}  `, newline))
    .join(newline);
  return [`${indent}<${kind}>`, body, `${indent}</${kind}>`].join(newline);
}

export function stBodyXml(code: string, newline: string): string {
  return [
    "<body>",
    "  <ST>",
    `    <xhtml xmlns="http://www.w3.org/1999/xhtml"><![CDATA[${cdata(code)}]]></xhtml>`,
    "  </ST>",
    "</body>"
  ].join(newline);
}

function assertBodyXml(bodyXml: string): void {
  const trimmed = bodyXml.trim();
  const range = findElementRange(trimmed, "body");
  if (!range || range.start !== 0 || range.end !== trimmed.length) {
    throw new Error("bodyXml must be exactly one complete <body>...</body> element");
  }
}

function pouXml(spec: PouSpec, newline: string): string {
  validateIdentifier(spec.name, "POU name");
  if (!["program", "functionBlock", "function"].includes(spec.pouType)) {
    throw new Error(`Unsupported pouType: ${spec.pouType}`);
  }
  if (spec.pouType === "function" && !spec.returnType) {
    throw new Error("Function POUs require returnType");
  }
  if (spec.bodyXml) assertBodyXml(spec.bodyXml);

  const lines = [
    `<pou name="${xmlEscapeAttribute(spec.name)}" pouType="${spec.pouType}">`,
    "  <interface>"
  ];
  if (spec.returnType) {
    lines.push("    <returnType>");
    lines.push(typeElementXml(spec.returnType, "      ").replace(/\n/g, newline));
    lines.push("    </returnType>");
  }
  const groups: [VarKind, VariableSpec[] | undefined][] = [
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
  lines.push(indentBlock(spec.bodyXml || stBodyXml(spec.code || "", newline), "  ", newline));
  lines.push("</pou>");
  return lines.join(newline);
}

function structureXml(spec: StructureSpec, newline: string): string {
  validateIdentifier(spec.name, "Structure name");
  if (!spec.fields || spec.fields.length === 0) {
    throw new Error("A structure needs at least one field");
  }
  const lines = [
    `<dataType name="${xmlEscapeAttribute(spec.name)}">`,
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

// ----------------------------------------------------------------- reading ---

export interface VariableInfo {
  name: string;
  type: string;
  kind: VarKind | "field";
  initialValue?: string;
  address?: string;
}

function describeType(xml: string, typeRange: XmlRange): string {
  const inner = innerXml(xml, typeRange);
  const tag = nextXmlTag(inner, 0);
  if (!tag) return "?";
  const attributes = parseAttributes(tag.raw);
  if (tag.name === "derived") return attributes.name || "derived";
  if (tag.name === "STRING" || tag.name === "WSTRING") {
    return attributes.length ? `${tag.name}(${attributes.length})` : tag.name;
  }
  if (tag.name === "array") {
    const dimension = findElementRange(inner, "dimension");
    const base = findElementRange(inner, "baseType");
    const dimensionAttributes = dimension ? parseAttributes(dimension.openTag) : {};
    const baseName = base ? describeType(inner, base) : "?";
    return `ARRAY[${dimensionAttributes.lower ?? "?"}..${dimensionAttributes.upper ?? "?"}] OF ${baseName}`;
  }
  return tag.name;
}

function readVariables(xml: string, container: XmlRange, kind: VariableInfo["kind"]): VariableInfo[] {
  const variables: VariableInfo[] = [];
  for (const range of findDirectChildren(xml, container, "variable")) {
    const attributes = parseAttributes(range.openTag);
    const typeRange = findDirectChildRange(xml, range, "type");
    const initial = findDirectChildRange(xml, range, "initialValue");
    let initialValue: string | undefined;
    if (initial) {
      const simple = findElementRange(xml, "simpleValue", initial.openEnd);
      if (simple && simple.start < initial.closeStart) {
        initialValue = parseAttributes(simple.openTag).value;
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

function pouInterfaceVariables(xml: string, pou: XmlRange): VariableInfo[] {
  const iface = findDirectChildRange(xml, pou, "interface");
  if (!iface) return [];
  const all: VariableInfo[] = [];
  for (const kind of VAR_KIND_ORDER) {
    for (const group of findDirectChildren(xml, iface, kind)) {
      all.push(...readVariables(xml, group, kind));
    }
  }
  return all;
}

function firstBodyLanguage(xml: string, pou: XmlRange): string | null {
  const body = findDirectChildRange(xml, pou, "body");
  if (!body) return null;
  const inner = innerXml(xml, body);
  const tag = nextXmlTag(inner, 0);
  return tag ? tag.name : null;
}

function extractStCode(xml: string, pou: XmlRange): string | null {
  const body = findDirectChildRange(xml, pou, "body");
  if (!body) return null;
  const section = xml.slice(body.start, body.end);
  const cdataStart = section.indexOf("<![CDATA[");
  if (cdataStart >= 0) {
    const cdataEnd = section.indexOf("]]>", cdataStart + 9);
    if (cdataEnd >= 0) return section.slice(cdataStart + 9, cdataEnd);
  }
  const xhtml = findElementRange(section, "xhtml");
  if (xhtml) return innerXml(section, xhtml).trim();
  return null;
}

export interface PouSummary {
  name: string;
  pouType: string;
  bodyLanguage: string | null;
  variableCounts: Record<string, number>;
}

function summarizePou(xml: string, pou: XmlRange): PouSummary {
  const attributes = parseAttributes(pou.openTag);
  const variables = pouInterfaceVariables(xml, pou);
  const counts: Record<string, number> = {};
  for (const kind of VAR_KIND_ORDER) {
    const n = variables.filter((v) => v.kind === kind).length;
    if (n > 0) counts[kind] = n;
  }
  return {
    name: attributes.name ?? "?",
    pouType: attributes.pouType ?? "?",
    bodyLanguage: firstBodyLanguage(xml, pou),
    variableCounts: counts
  };
}

export async function listPous(config: DiaConfig, exportFilePath: string) {
  const document = await readExportXml(config, exportFilePath);
  const pous: PouSummary[] = [];
  let from = 0;
  let range: XmlRange | null;
  while ((range = findElementRange(document.xml, "pou", from)) !== null) {
    pous.push(summarizePou(document.xml, range));
    from = range.end;
  }
  return { path: document.fullPath, pouCount: pous.length, pous };
}

export async function getPou(config: DiaConfig, exportFilePath: string, name: string) {
  const document = await readExportXml(config, exportFilePath);
  const range = pouRangeByName(document.xml, name);
  if (!range) throw new Error(`POU not found: ${name}`);
  const body = findDirectChildRange(document.xml, range, "body");
  const iface = findDirectChildRange(document.xml, range, "interface");
  return {
    path: document.fullPath,
    ...summarizePou(document.xml, range),
    variables: pouInterfaceVariables(document.xml, range),
    stCode: extractStCode(document.xml, range),
    interfaceXml: iface ? document.xml.slice(iface.start, iface.end) : null,
    bodyXml: body ? document.xml.slice(body.start, body.end) : null
  };
}

export async function listStructures(config: DiaConfig, exportFilePath: string) {
  const document = await readExportXml(config, exportFilePath);
  const structures: { name: string; fields: VariableInfo[] }[] = [];
  let from = 0;
  let range: XmlRange | null;
  while ((range = findElementRange(document.xml, "dataType", from)) !== null) {
    const attributes = parseAttributes(range.openTag);
    const struct = findElementRange(document.xml, "struct", range.openEnd);
    const fields =
      struct && struct.start < range.closeStart
        ? readVariables(document.xml, struct, "field")
        : [];
    structures.push({ name: attributes.name ?? "?", fields });
    from = range.end;
  }
  return { path: document.fullPath, structureCount: structures.length, structures };
}

export async function listGlobalVariables(config: DiaConfig, exportFilePath: string) {
  const document = await readExportXml(config, exportFilePath);
  const groups: { name: string; variables: VariableInfo[] }[] = [];
  let from = 0;
  let range: XmlRange | null;
  while ((range = findElementRange(document.xml, "globalVars", from)) !== null) {
    const attributes = parseAttributes(range.openTag);
    groups.push({
      name: attributes.name ?? "(unnamed)",
      variables: readVariables(document.xml, range, "field")
    });
    from = range.end;
  }
  return { path: document.fullPath, groupCount: groups.length, groups };
}

// ----------------------------------------------------------------- writing ---

export async function createPou(config: DiaConfig, exportFilePath: string, spec: PouSpec) {
  const document = await readExportXml(config, exportFilePath);
  let xml = document.xml;
  const existing = pouRangeByName(xml, spec.name);
  const generated = pouXml(spec, document.newline);
  let action: "created" | "replaced" = "created";

  if (existing) {
    if (!spec.overwrite) {
      throw new Error(`POU already exists: ${spec.name}. Pass overwrite=true to replace it.`);
    }
    const indent = indentOfLine(xml, existing.start);
    xml = spliceIndentedBlock(xml, existing.start, existing.end, generated, indent, document.newline);
    action = "replaced";
  } else {
    const ensured = ensureChildContainer(xml, "types", "pous", document.newline);
    xml = insertAsLastChild(ensured.xml, ensured.range, generated, document.newline);
  }

  const backupPath = await writeExportXml(config, document, xml, spec.backup);
  return { path: document.fullPath, backupPath, action, name: spec.name, pouType: spec.pouType };
}

export async function deletePou(
  config: DiaConfig,
  exportFilePath: string,
  name: string,
  backup?: boolean
) {
  const document = await readExportXml(config, exportFilePath);
  const range = pouRangeByName(document.xml, name);
  if (!range) throw new Error(`POU not found: ${name}`);
  const lineStart = range.start - indentOfLine(document.xml, range.start).length;
  let end = range.end;
  // swallow the trailing newline so no blank line is left behind
  if (document.xml.startsWith(document.newline, end)) end += document.newline.length;
  const xml = replaceRange(document.xml, lineStart, end, "");
  const backupPath = await writeExportXml(config, document, xml, backup);
  return { path: document.fullPath, backupPath, action: "deleted", name };
}

export async function setPouCode(
  config: DiaConfig,
  exportFilePath: string,
  name: string,
  code: string,
  backup?: boolean
) {
  return setPouBodyXml(config, exportFilePath, name, stBodyXml(code, "\n"), backup, "generated-st");
}

export async function setPouBodyXml(
  config: DiaConfig,
  exportFilePath: string,
  name: string,
  bodyXml: string,
  backup?: boolean,
  kind: "generated-st" | "verbatim" = "verbatim"
) {
  assertBodyXml(bodyXml);
  const document = await readExportXml(config, exportFilePath);
  const pou = pouRangeByName(document.xml, name);
  if (!pou) throw new Error(`POU not found: ${name}`);
  const body = findDirectChildRange(document.xml, pou, "body");
  if (!body) throw new Error(`POU has no <body> element: ${name}`);

  const indent = indentOfLine(document.xml, body.start);
  const xml = spliceIndentedBlock(
    document.xml,
    body.start,
    body.end,
    bodyXml,
    indent,
    document.newline
  );
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
export async function declareVariables(
  config: DiaConfig,
  exportFilePath: string,
  pouName: string,
  kind: VarKind,
  variables: VariableSpec[],
  options: { replaceExisting?: boolean; backup?: boolean } = {}
) {
  if (!variables || variables.length === 0) {
    throw new Error("No variables supplied");
  }
  if (!VAR_KIND_ORDER.includes(kind)) {
    throw new Error(`Unsupported variable kind: ${kind}`);
  }
  const document = await readExportXml(config, exportFilePath);
  let xml = document.xml;

  const pou = pouRangeByName(xml, pouName);
  if (!pou) throw new Error(`POU not found: ${pouName}`);
  const iface = findDirectChildRange(xml, pou, "interface");
  if (!iface) throw new Error(`POU has no <interface> element: ${pouName}`);

  const existingNames = new Set(
    pouInterfaceVariables(xml, pou).map((v) => v.name.toUpperCase())
  );
  const conflicts = variables.filter((v) => existingNames.has(v.name.toUpperCase()));
  if (conflicts.length > 0 && !options.replaceExisting) {
    throw new Error(
      `Already declared in ${pouName}: ${conflicts.map((v) => v.name).join(", ")}. Pass replaceExisting=true to overwrite.`
    );
  }

  // Drop the variables we are about to redeclare, deepest-last so earlier
  // offsets stay valid while splicing.
  if (conflicts.length > 0) {
    const doomed = new Set(conflicts.map((v) => v.name.toUpperCase()));
    for (;;) {
      const currentPou = pouRangeByName(xml, pouName);
      if (!currentPou) break;
      const currentIface = findDirectChildRange(xml, currentPou, "interface");
      if (!currentIface) break;
      let removed = false;
      for (const groupKind of VAR_KIND_ORDER) {
        for (const group of findDirectChildren(xml, currentIface, groupKind)) {
          for (const variable of findDirectChildren(xml, group, "variable")) {
            const name = parseAttributes(variable.openTag).name ?? "";
            if (!doomed.has(name.toUpperCase())) continue;
            const lineStart = variable.start - indentOfLine(xml, variable.start).length;
            let end = variable.end;
            if (xml.startsWith(document.newline, end)) end += document.newline.length;
            xml = replaceRange(xml, lineStart, end, "");
            removed = true;
            break;
          }
          if (removed) break;
        }
        if (removed) break;
      }
      if (!removed) break;
    }
  }

  const pouAfter = pouRangeByName(xml, pouName);
  if (!pouAfter) throw new Error(`POU disappeared while editing: ${pouName}`);
  const ifaceAfter = findDirectChildRange(xml, pouAfter, "interface");
  if (!ifaceAfter) throw new Error(`Interface disappeared while editing: ${pouName}`);

  const groups = findDirectChildren(xml, ifaceAfter, kind);
  let placement: "appended" | "group-created";
  if (groups.length > 0) {
    const target = groups[groups.length - 1];
    const block = variables
      .map((variable) => variableXml(variable, VAR_KIND_SCOPE[kind], "", document.newline))
      .join(document.newline);
    xml = insertAsLastChild(xml, target, block, document.newline);
    placement = "appended";
  } else {
    const block = variableGroupXml(kind, variables, "", document.newline);
    xml = insertAsLastChild(xml, ifaceAfter, block, document.newline);
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

export async function createStructure(
  config: DiaConfig,
  exportFilePath: string,
  spec: StructureSpec
) {
  const document = await readExportXml(config, exportFilePath);
  let xml = document.xml;
  const existing = dataTypeRangeByName(xml, spec.name);
  const generated = structureXml(spec, document.newline);
  let action: "created" | "replaced" = "created";

  if (existing) {
    if (!spec.overwrite) {
      throw new Error(`Data type already exists: ${spec.name}. Pass overwrite=true to replace it.`);
    }
    const indent = indentOfLine(xml, existing.start);
    xml = spliceIndentedBlock(xml, existing.start, existing.end, generated, indent, document.newline);
    action = "replaced";
  } else {
    const ensured = ensureChildContainer(xml, "types", "dataTypes", document.newline);
    xml = insertAsLastChild(ensured.xml, ensured.range, generated, document.newline);
  }

  const backupPath = await writeExportXml(config, document, xml, spec.backup);
  return { path: document.fullPath, backupPath, action, name: spec.name };
}

// ------------------------------------------------------- export and import ---

// DIADesigner's own importer indexes into fileHeader/contentHeader without an
// existence check, so an .EXPORT missing them throws
// "Specified argument was out of range. Parameter name: index" instead of a
// readable error. Shape verified against Delta's own shipped exports (e.g.
// Programming/Resource/AS_Series/*/Standard.EXPORT).
const EMPTY_EXPORT = (newline: string) =>
  [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    "<project>",
    '  <fileHeader companyName="" productName="" productVersion="" creationDateTime="0001-01-01T00:00:00" />',
    '  <contentHeader name="">',
    "    <coordinateInfo>",
    '      <pageSize x="0" y="1" />',
    "      <fbd>",
    '        <scaling x="0" y="1" />',
    "      </fbd>",
    "      <ld>",
    '        <scaling x="0" y="1" />',
    "      </ld>",
    "      <sfc>",
    '        <scaling x="0" y="1" />',
    "      </sfc>",
    "    </coordinateInfo>",
    "  </contentHeader>",
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
export async function exportObjects(
  config: DiaConfig,
  sourceExportPath: string,
  targetPath: string,
  selection: { pous?: string[]; dataTypes?: string[] }
) {
  const source = await readExportXml(config, sourceExportPath);
  const newline = source.newline;
  const fullTarget = resolveWorkspacePath(config.workspaceDir, targetPath);
  if (!/\.export$/i.test(fullTarget)) {
    throw new Error(`Target must be a .EXPORT file: ${fullTarget}`);
  }

  let xml = EMPTY_EXPORT(newline);
  const exportedPous: string[] = [];
  const exportedTypes: string[] = [];

  for (const name of selection.dataTypes ?? []) {
    const range = dataTypeRangeByName(source.xml, name);
    if (!range) throw new Error(`Data type not found in source: ${name}`);
    const block = source.xml.slice(range.start, range.end);
    const container = findElementRange(xml, "dataTypes");
    if (!container) throw new Error("Malformed export skeleton");
    xml = insertAsLastChild(xml, container, block, newline);
    exportedTypes.push(name);
  }
  for (const name of selection.pous ?? []) {
    const range = pouRangeByName(source.xml, name);
    if (!range) throw new Error(`POU not found in source: ${name}`);
    const block = source.xml.slice(range.start, range.end);
    const container = findElementRange(xml, "pous");
    if (!container) throw new Error("Malformed export skeleton");
    xml = insertAsLastChild(xml, container, block, newline);
    exportedPous.push(name);
  }

  if (exportedPous.length === 0 && exportedTypes.length === 0) {
    throw new Error("Nothing selected to export");
  }

  await writeFile(fullTarget, xml, "utf8");
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
export async function importObjects(
  config: DiaConfig,
  targetExportPath: string,
  sourceExportPath: string,
  options: { pous?: string[]; dataTypes?: string[]; overwrite?: boolean; backup?: boolean } = {}
) {
  const target = await readExportXml(config, targetExportPath);
  const source = await readExportXml(config, sourceExportPath);
  const newline = target.newline;
  let xml = target.xml;

  const collect = (xmlText: string, tagName: string): Map<string, string> => {
    const found = new Map<string, string>();
    let from = 0;
    let range: XmlRange | null;
    while ((range = findElementRange(xmlText, tagName, from)) !== null) {
      const name = parseAttributes(range.openTag).name;
      if (name) found.set(name, xmlText.slice(range.start, range.end));
      from = range.end;
    }
    return found;
  };

  const sourceTypes = collect(source.xml, "dataType");
  const sourcePous = collect(source.xml, "pou");

  const wantedTypes = options.dataTypes ?? Array.from(sourceTypes.keys());
  const wantedPous = options.pous ?? Array.from(sourcePous.keys());

  const imported: string[] = [];
  const replaced: string[] = [];
  const skipped: string[] = [];

  for (const name of wantedTypes) {
    const block = sourceTypes.get(name);
    if (!block) throw new Error(`Data type not found in source: ${name}`);
    const existing = dataTypeRangeByName(xml, name);
    if (existing) {
      if (!options.overwrite) {
        skipped.push(`dataType:${name}`);
        continue;
      }
      const indent = indentOfLine(xml, existing.start);
      xml = spliceIndentedBlock(xml, existing.start, existing.end, block, indent, newline);
      replaced.push(`dataType:${name}`);
    } else {
      const ensured = ensureChildContainer(xml, "types", "dataTypes", newline);
      xml = insertAsLastChild(ensured.xml, ensured.range, block, newline);
      imported.push(`dataType:${name}`);
    }
  }

  for (const name of wantedPous) {
    const block = sourcePous.get(name);
    if (!block) throw new Error(`POU not found in source: ${name}`);
    const existing = pouRangeByName(xml, name);
    if (existing) {
      if (!options.overwrite) {
        skipped.push(`pou:${name}`);
        continue;
      }
      const indent = indentOfLine(xml, existing.start);
      xml = spliceIndentedBlock(xml, existing.start, existing.end, block, indent, newline);
      replaced.push(`pou:${name}`);
    } else {
      const ensured = ensureChildContainer(xml, "types", "pous", newline);
      xml = insertAsLastChild(ensured.xml, ensured.range, block, newline);
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
export async function createEmptyExport(config: DiaConfig, targetPath: string) {
  const fullTarget = resolveWorkspacePath(config.workspaceDir, targetPath);
  if (!/\.export$/i.test(fullTarget)) {
    throw new Error(`Target must be a .EXPORT file: ${fullTarget}`);
  }
  await writeFile(fullTarget, EMPTY_EXPORT("\r\n"), "utf8");
  return { path: fullTarget, note: "Empty PLCopen export created." };
}

export function exportFileName(fullPath: string): string {
  return path.basename(fullPath);
}
