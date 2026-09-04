# Delta DIADesigner 1.13 MCP Server

This package now includes a second MCP server for Delta DIADesigner 1.13:

```bash
diadesigner13-mcp-tool
```

DIADesigner 1.13 is handled as Delta software, not as a CODESYS profile. The server does not use the CODESYS Python `scriptengine` route. It provides a safe first integration layer for local agents:

- detect the installed DIADesigner 1.13 executable and helper tools
- scan the workspace for Delta project/export-like files
- inspect `.EXPORT`, `.isp`, and archive-like project files
- list, read, and extract archive entries through DIADesigner's bundled `7za.exe`
- create timestamped project backups
- inspect and safely edit DiaTag `Symbolconfiguration` XML next to `.diade` projects:
  - list structure types
  - list global nodes and calculate occupied D-register ranges from real type sizes
  - find free D-register ranges
  - create STRUCT symbol types
  - create global nodes in `Default_Tag_Table`
  - create the `PumpType` symbol demo with a preferred D address and next-free fallback
- edit PLC `.EXPORT` XML files experimentally:
  - list and read POUs
  - create program/function/functionBlock POUs
  - create function blocks through a convenience tool
  - replace a POU body with generated Structured Text XML
  - replace a POU body with exact advanced `<body>...</body>` XML
  - list and create `STRUCT` data types
- launch the native DIADesigner UI with an optional project path
- list detected device/resource catalogs

## Example MCP Configuration

```json
{
  "mcpServers": {
    "diadesigner13_local": {
      "command": "diadesigner13-mcp-tool",
      "args": [
        "--diadesigner-path", "C:\\Program Files (x86)\\Delta Industrial Automation\\DIAStudio\\DIADesigner 1.13\\DIADesigner.exe",
        "--workspace", "D:\\SynologyDrive\\YourProjectRoot"
      ]
    }
  }
}
```

Optional argument:

```json
"--sevenzip-path", "C:\\Program Files (x86)\\Delta Industrial Automation\\DIAStudio\\DIADesigner 1.13\\7zTool\\7za.exe"
```

If omitted, the server resolves `7zTool\\7za.exe` next to the configured `DIADesigner.exe`.

## DiaTag Symbol Editing

The `.diade` project itself can contain opaque/binary programming files. For that format the server does not patch PLC program binaries directly. It can, however, edit the explicit `DiaTag/*.xml` symbol file that DIADesigner stores next to the project.

Useful tools for a `.diade` workspace:

- `list_symbol_structures`
- `list_symbol_global_nodes`
- `find_free_d_range`
- `create_symbol_structure`
- `create_symbol_global_node`
- `create_pumptype_symbol_demo`

Example:

```json
{
  "projectOrSymbolPath": "CA-6/CA-6.diade",
  "preferredDAddress": 3500,
  "useNextFree": true
}
```

If `D3500` is occupied, `create_pumptype_symbol_demo` uses the next free D range after the preferred address.

## Editing Boundary

This is still not a full semantic editor for opaque DIADesigner `.isp` projects. The installation contains Delta project file assemblies such as `Delta.PLC.ProjectFile.V0002.dll` through newer versions, but no public headless scripting interface was assumed.

The write tools intentionally target DIADesigner 1.13 PLC `.EXPORT` XML files with the `<project><types>...</types></project>` shape seen in the local Delta installation. They create timestamped backups by default. Generated ST bodies use a PLCopen-style XML shape:

```xml
<body>
  <ST>
    <xhtml xmlns="http://www.w3.org/1999/xhtml"><![CDATA[...]]></xhtml>
  </ST>
</body>
```

For LD/FBD/CFC or any DIADesigner-specific body format that must be preserved exactly, use `set_export_pou_body_xml` with a complete known-good `<body>...</body>` element instead of generated ST.

Typical workflow:

1. Export or locate the PLC `.EXPORT` file.
2. Use `create_export_structure`, `create_export_pou`, `create_export_fb`, or `set_export_pou_code`.
3. Open/import the edited export in DIADesigner 1.13 and let the native application validate/compile it.
