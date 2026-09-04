#!/usr/bin/env node
/**
 * End-to-end test for the DIADesigner 1.14 MCP server.
 *
 * Drives the real server over stdio JSON-RPC in a throwaway workspace, so it
 * exercises the same path an MCP client takes. Everything except the native
 * bridge runs offline; bridge assertions are skipped when DIADesigner is not
 * installed, and the native-project check is skipped unless a 1.14 `.diade`
 * fixture is present at test/fixtures/sample.diade.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "dist14", "bin.js");
const FIXTURE = path.join(__dirname, "fixtures", "sample.diade");

if (!fs.existsSync(BIN)) {
  console.error(`Build first: ${BIN} is missing (npm run build)`);
  process.exit(1);
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "dia14-e2e-"));
const hasFixture = fs.existsSync(FIXTURE);
if (hasFixture) fs.copyFileSync(FIXTURE, path.join(WS, "sample.diade"));

const child = spawn(process.execPath, [BIN, "--workspace", WS], {
  stdio: ["pipe", "pipe", "pipe"]
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let index;
  while ((index = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, index).trim();
    buf = buf.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});
child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  if (/Fatal/i.test(text)) process.stderr.write(`[server] ${text}`);
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` -> ${String(detail).slice(0, 300)}` : ""}`);
  }
}

async function call(name, args, options = {}) {
  const response = await send("tools/call", { name, arguments: args });
  const result = response.result || {};
  const isError = Boolean(result.isError);
  const text = result.content && result.content[0] ? result.content[0].text : JSON.stringify(response.error);
  if (options.expectError) {
    check(`${name} rejects invalid input`, isError, text);
  } else {
    check(name, !isError, text);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { _text: text };
  }
}

(async () => {
  console.log(`workspace: ${WS}\n`);
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1.0.0" }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const toolList = await send("tools/list", {});
  const toolNames = toolList.result.tools.map((tool) => tool.name);
  console.log(`== ${toolNames.length} tools registered ==`);
  for (const required of [
    "list_pous", "get_pou", "create_pou", "declare_variables",
    "set_pou_code", "export_objects", "import_objects", "compile_program"
  ]) {
    check(`tool ${required} registered`, toolNames.includes(required));
  }

  console.log("\n== installation ==");
  const install = await call("detect_installation", {});
  if (install.executableExists) {
    check("DIADesigner detected", true);
    check("automation assemblies present", Object.values(install.automationAssemblies).every(Boolean));
    const bridge = await call("check_bridge", {});
    check("bridge runs as x86", bridge.bitness === "x86", JSON.stringify(bridge));
  } else {
    skipped += 3;
    console.log("  skip DIADesigner not installed - bridge checks skipped");
  }

  console.log("\n== native project ==");
  if (hasFixture && install.executableExists) {
    const native = await call("read_native_project", { projectPath: "sample.diade" });
    check("1.14 container decrypted", native.ok === true, JSON.stringify(native));
  } else {
    skipped++;
    console.log("  skip no test/fixtures/sample.diade (or no install)");
  }

  console.log("\n== create program content ==");
  await call("create_empty_export", { targetPath: "Prog.EXPORT" });
  await call("create_structure", {
    exportPath: "Prog.EXPORT",
    name: "PumpType",
    fields: [
      { name: "Run", type: "BOOL" },
      { name: "Speed", type: "INT" },
      { name: "Label", type: "STRING(20)" }
    ],
    backup: false
  });
  await call("create_pou", {
    exportPath: "Prog.EXPORT",
    name: "PumpFB",
    pouType: "functionBlock",
    inputVars: [
      { name: "iEnable", type: "BOOL" },
      { name: "iSetpoint", type: "INT", initialValue: "0" }
    ],
    outputVars: [{ name: "qRunning", type: "BOOL" }],
    localVars: [{ name: "tState", type: "PumpType" }],
    code: "qRunning := iEnable;\ntState.Speed := iSetpoint;",
    backup: false
  });
  await call("create_pou", {
    exportPath: "Prog.EXPORT",
    name: "MainPRG",
    pouType: "program",
    localVars: [{ name: "fbPump", type: "PumpFB" }, { name: "iCycle", type: "DINT", initialValue: "0" }],
    code: "iCycle := iCycle + 1;",
    backup: false
  });
  await call("create_pou", {
    exportPath: "Prog.EXPORT",
    name: "ScaleFC",
    pouType: "function",
    returnType: "REAL",
    inputVars: [{ name: "iRaw", type: "INT" }],
    code: "ScaleFC := INT_TO_REAL(iRaw) / 100.0;",
    backup: false
  });
  await call(
    "create_pou",
    { exportPath: "Prog.EXPORT", name: "NoReturn", pouType: "function", code: "x := 1;", backup: false },
    { expectError: true }
  );

  console.log("\n== declare variables ==");
  await call("declare_variables", {
    exportPath: "Prog.EXPORT",
    pouName: "MainPRG",
    kind: "localVars",
    variables: [
      { name: "arrBuf", type: "ARRAY[0..9] OF INT" },
      { name: "rTemp", type: "REAL", initialValue: "0.0" }
    ],
    backup: false
  });
  await call(
    "declare_variables",
    {
      exportPath: "Prog.EXPORT",
      pouName: "MainPRG",
      kind: "localVars",
      variables: [{ name: "rTemp", type: "REAL" }],
      backup: false
    },
    { expectError: true }
  );
  await call("declare_variables", {
    exportPath: "Prog.EXPORT",
    pouName: "MainPRG",
    kind: "localVars",
    variables: [{ name: "rTemp", type: "LREAL" }],
    replaceExisting: true,
    backup: false
  });

  console.log("\n== read back ==");
  const pous = await call("list_pous", { exportPath: "Prog.EXPORT" });
  check("three POUs present", pous.pouCount === 3, JSON.stringify(pous.pous));
  const main = await call("list_variables", { exportPath: "Prog.EXPORT", pouName: "MainPRG" });
  const names = main.variables.map((v) => v.name);
  check("appended variables visible", names.includes("arrBuf") && names.includes("rTemp"), names.join(","));
  const rTemp = main.variables.find((v) => v.name === "rTemp");
  check("replaceExisting changed the type", rTemp && rTemp.type === "LREAL", JSON.stringify(rTemp));
  const arrBuf = main.variables.find((v) => v.name === "arrBuf");
  check("array type round-trips", arrBuf && arrBuf.type === "ARRAY[0..9] OF INT", JSON.stringify(arrBuf));
  const structures = await call("list_structures", { exportPath: "Prog.EXPORT" });
  check("STRING(20) field round-trips",
    structures.structures[0].fields.some((f) => f.type === "STRING(20)"),
    JSON.stringify(structures.structures[0].fields));

  console.log("\n== edit code ==");
  await call("set_pou_code", {
    exportPath: "Prog.EXPORT",
    name: "MainPRG",
    code: "iCycle := iCycle + 1;\nIF iCycle > 1000 THEN\n  iCycle := 0;\nEND_IF;",
    backup: false
  });
  const edited = await call("get_pou", { exportPath: "Prog.EXPORT", name: "MainPRG" });
  check("ST body round-trips", edited.stCode.includes("END_IF;"), edited.stCode);

  console.log("\n== export and import ==");
  await call("export_objects", {
    sourceExportPath: "Prog.EXPORT",
    targetPath: "Shared.EXPORT",
    pous: ["PumpFB", "ScaleFC"],
    dataTypes: ["PumpType"]
  });
  const shared = await call("list_pous", { exportPath: "Shared.EXPORT" });
  check("export produced two POUs", shared.pouCount === 2, JSON.stringify(shared));

  await call("create_empty_export", { targetPath: "Target.EXPORT" });
  const firstImport = await call("import_objects", {
    targetExportPath: "Target.EXPORT",
    sourceExportPath: "Shared.EXPORT",
    backup: false
  });
  check("import brought in three objects", firstImport.imported.length === 3, JSON.stringify(firstImport));
  const secondImport = await call("import_objects", {
    targetExportPath: "Target.EXPORT",
    sourceExportPath: "Shared.EXPORT",
    backup: false
  });
  check("re-import skips existing", secondImport.skipped.length === 3, JSON.stringify(secondImport));
  const overwriteImport = await call("import_objects", {
    targetExportPath: "Target.EXPORT",
    sourceExportPath: "Shared.EXPORT",
    overwrite: true,
    backup: false
  });
  check("overwrite replaces existing", overwriteImport.replaced.length === 3, JSON.stringify(overwriteImport));

  console.log("\n== delete ==");
  await call("delete_pou", { exportPath: "Prog.EXPORT", name: "ScaleFC", backup: false });
  const afterDelete = await call("list_pous", { exportPath: "Prog.EXPORT" });
  check("POU removed", afterDelete.pouCount === 2, JSON.stringify(afterDelete.pous));

  console.log("\n== DiaTag symbols ==");
  const symDir = path.join(WS, "symproj", "DiaTag");
  fs.mkdirSync(symDir, { recursive: true });
  fs.writeFileSync(
    path.join(symDir, "Symbols.xml"),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Symbolconfiguration version="1.0">',
      "  <TypeList>",
      '    <TypeSimple name="T_BOOL" iecname="BOOL" size="2" swapsize="2" />',
      '    <TypeSimple name="T_INT" iecname="INT" size="2" swapsize="2" />',
      '    <TypeSimple name="T_DINT" iecname="DINT" size="4" swapsize="4" />',
      '    <TypeSimple name="T_REAL" iecname="REAL" size="4" swapsize="4" />',
      '    <TypeUserDef name="T_Existing" iecname="Existing" pouclass="STRUCTURE" typeclass="Userdef" size="8" swapsize="8">',
      '      <UserDefElement iecname="A" type="T_INT" vartype="VAR" byteoffset="0" />',
      "    </TypeUserDef>",
      "  </TypeList>",
      "  <NodeList>",
      '    <Node name="Default_Tag_Table">',
      '      <Node name="OldTag" type="T_Existing" access="ReadWrite" directaddress="D100" />',
      '      <Node name="Counter" type="T_DINT" access="ReadWrite" directaddress="D200" />',
      "    </Node>",
      "  </NodeList>",
      "</Symbolconfiguration>",
      ""
    ].join("\r\n"),
    "utf8"
  );

  const symNodes = await call("list_symbol_global_nodes", { projectOrSymbolPath: "symproj" });
  const oldTag = symNodes.nodes.find((n) => n.name === "OldTag");
  check("D range derived from type size", oldTag && oldTag.startD === 100 && oldTag.endD === 103, JSON.stringify(oldTag));

  const free = await call("find_free_d_range", {
    projectOrSymbolPath: "symproj",
    requiredBytes: 8,
    preferredDAddress: 100
  });
  check("occupied preferred address detected", free.preferred && free.preferred.free === false, JSON.stringify(free.preferred));
  check("gap found after the occupied range",
    free.gaps.some((g) => g.startD === 104),
    JSON.stringify(free.gaps.slice(0, 3)));

  await call("create_symbol_structure", {
    projectOrSymbolPath: "symproj",
    name: "PumpType",
    fields: [{ name: "Run", type: "BOOL" }, { name: "Speed", type: "INT" }, { name: "Flow", type: "REAL" }],
    backup: false
  });
  const node = await call("create_symbol_global_node", {
    projectOrSymbolPath: "symproj",
    name: "Pump1",
    typeName: "PumpType",
    preferredDAddress: 100,
    useNextFree: true,
    backup: false
  });
  check("next-free fallback picked D104", node.directaddress === "D104", JSON.stringify(node));
  await call(
    "create_symbol_global_node",
    {
      projectOrSymbolPath: "symproj",
      name: "Pump2",
      typeName: "PumpType",
      preferredDAddress: 100,
      backup: false
    },
    { expectError: true }
  );

  console.log("\n== output is well-formed XML ==");
  let validator = null;
  try {
    ({ XMLValidator: validator } = require("fast-xml-parser"));
  } catch {
    // optional dev dependency
  }
  const produced = [
    "Prog.EXPORT",
    "Shared.EXPORT",
    "Target.EXPORT",
    path.join("symproj", "DiaTag", "Symbols.xml")
  ];
  for (const file of produced) {
    const xml = fs.readFileSync(path.join(WS, file), "utf8");
    if (validator) {
      const verdict = validator.validate(xml);
      check(`${file} is well-formed`, verdict === true, JSON.stringify(verdict));
    } else {
      skipped++;
      console.log(`  skip ${file} (install fast-xml-parser to validate)`);
    }
  }

  console.log(`\n==== ${passed} passed, ${failed} failed, ${skipped} skipped ====`);
  child.kill();
  fs.rmSync(WS, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  child.kill();
  process.exit(1);
});
