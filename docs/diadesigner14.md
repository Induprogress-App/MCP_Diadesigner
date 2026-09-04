# Delta DIADesigner 1.14 MCP Server

```bash
diadesigner-mcp-tool
```

DIADesigner is Delta software, not a CODESYS profile, and ships no scripting
engine. This server automates it through three layers:

| Layer | How | What it gives you |
| --- | --- | --- |
| Installation / workspace | filesystem + install layout | detection, project discovery, backups, device catalogs |
| Native project | Delta's own .NET assemblies via `bridge/DeltaBridge.ps1` | decrypt `.diade`, parse `PLC.prog` headers, load and compile programs |
| Program content | PLCopen `.EXPORT` XML | read, edit, create POUs, declare variables, export, import |

## Configuration

```json
{
  "mcpServers": {
    "diadesigner": {
      "command": "node",
      "args": [
        "C:\\path\\to\\Diadesigner-mcp-toolkit\\dist14\\bin.js",
        "--diadesigner-path", "C:\\Program Files (x86)\\Delta Industrial Automation\\DIAStudio\\DIADesigner 1.14\\DIADesigner.exe",
        "--workspace", "D:\\YourProjectRoot"
      ]
    }
  }
}
```

`--diadesigner-path` is optional: the server scans
`…\DIAStudio\DIADesigner <major>.<minor>` under both Program Files trees and
picks the newest install. Pass it explicitly if several versions are installed.
`--sevenzip-path` defaults to `7zTool\7za.exe` next to the executable.

## Working model

DIADesigner keeps program logic inside encrypted containers, so the server does
not edit `PLC.prog` in place. The supported loop is:

1. In DIADesigner, export the POUs you want to work on to a `.EXPORT` file.
2. Read and edit that file with the tools below.
3. Import the file back in DIADesigner and let it compile and validate.

`compile_program` shortens step 3 when you already have a program container, but
DIADesigner remains the authority on whether code is valid.

## Tools

### Installation and workspace

- `detect_installation` — executable, version, helper tools, and whether the
  assemblies the bridge needs are present
- `check_bridge` — confirms the .NET bridge loads Delta's assemblies (run this
  first when native tools misbehave)
- `scan_workspace_projects`, `inspect_file`, `resolve_path`
- `list_archive_entries`, `extract_archive`, `create_backup`
- `list_device_catalog`, `open_in_diadesigner`

### Native project

- `read_native_project` — decrypts a `.diade` container and returns the
  solution and device tree
- `read_program_header` — `PLC.prog` / `PLC.diaobj` header fields
- `read_program` — loads a container through DIADesigner's own loader and lists
  its POUs and data types
- `compile_program` — runs the ISP compiler (`mode: "check"` validates only)

### Program content (PLCopen `.EXPORT`)

- Read: `list_pous`, `get_pou`, `list_variables`, `list_global_variables`,
  `list_structures`
- Create: `create_empty_export`, `create_pou`, `create_structure`
- Edit: `set_pou_code`, `set_pou_body_xml`, `declare_variables`, `delete_pou`
- Move: `export_objects`, `import_objects`

### Symbols (DiaTag)

- `list_symbol_structures`, `list_symbol_global_nodes`, `find_free_d_range`
- `create_symbol_structure`, `create_symbol_global_node`

D-register ranges are computed from the type sizes declared in the symbol file,
so `find_free_d_range` reflects real occupancy rather than an assumed layout.

## Types accepted in declarations

Elementary IEC types (`BOOL`, `INT`, `DINT`, `REAL`, `LREAL`, `TIME`, …),
`STRING(n)` / `WSTRING(n)`, `ARRAY[lo..hi] OF <type>`, and any user-defined
type name (emitted as `<derived name="…"/>`).

`declare_variables` appends to an existing variable group when the POU already
has one of that kind, so the file keeps whatever layout DIADesigner wrote.
Redeclaring an existing name requires `replaceExisting: true`.

## Project format: 1.13 versus 1.14

The `.diade` container changed between versions:

| Version | Container | `read_native_project` |
| --- | --- | --- |
| 1.13 | raw binary AES | fails — the 1.14 reader expects Base64 |
| 1.14 | Base64-armoured AES | works |

`inspect_file` reports which container a `.diade` uses. To bring a 1.13 project
forward, open it in DIADesigner 1.14 (launcher → **Project Migrate**) and save
it; afterwards the native tools accept it.

## Editing bodies other than ST

`set_pou_code` generates a Structured Text body:

```xml
<body>
  <ST>
    <xhtml xmlns="http://www.w3.org/1999/xhtml"><![CDATA[...]]></xhtml>
  </ST>
</body>
```

For LD, FBD, SFC or CFC, pass a complete known-good element to
`set_pou_body_xml` instead. Edits are byte-range splices, so anything the tools
do not understand elsewhere in the document survives untouched.

## Safety

Every write creates a timestamped `.bak-<timestamp>` copy next to the file
unless you pass `backup: false`.

## Requirements

- Windows (the bridge drives Delta's x86 assemblies through
  `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`)
- Node.js 18+
- DIADesigner 1.14 installed, for anything beyond pure `.EXPORT` editing

## Verified behaviour and known gaps

Covered by `npm test` (61 assertions, run against the real server over stdio):
installation detection, bridge startup, decrypting a 1.14 `.diade`, creating
structures and all three POU kinds, variable declaration including arrays and
`replaceExisting`, ST round-trips, export/import with skip and overwrite, POU
deletion, DiaTag D-range arithmetic with next-free fallback, and XML
well-formedness of every produced file.

Not yet verified on this machine:

- `read_program` and `compile_program` against a **valid** program container.
  The code path is exercised — Delta's loader runs and reports through the
  bridge — but every local `PLC.prog` / `PLC.diaobj` available for testing was
  a corrupt recovery dump, which the loader correctly refuses. These two tools
  need one run against a real saved project to be considered proven.
- The generated PLCopen shape has not been round-tripped through DIADesigner's
  own importer. It is standard PLCopen and validates as XML, but the first
  import into DIADesigner is worth doing on a throwaway project.
- Adding a device failed in the local 1.14 install (*"This device model is not
  supported by current version of DIADesigner"*) for every controller tried,
  which blocked producing a reference project. This looks like an installation
  or device-description issue rather than something in this toolkit.
