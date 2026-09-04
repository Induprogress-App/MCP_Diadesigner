# Delta DIADesigner 1.14 MCP Server

A Model Context Protocol (MCP) server for **Delta DIADesigner 1.14**. It lets
an MCP client (Claude Desktop, Claude Code, …) read and edit DIADesigner
program content, inspect native project containers, and drive the ISP
compiler — without a scripting engine, since DIADesigner ships none.

DIADesigner is not a CODESYS profile, so this server automates it through
three layers instead:

| Layer | How | What it gives you |
| --- | --- | --- |
| Installation / workspace | filesystem + install layout | detection, project discovery, backups, device catalogs |
| Native project | Delta's own .NET assemblies via `bridge/DeltaBridge.ps1` | decrypt `.diade`, parse `PLC.prog` headers, load and compile programs |
| Program content | PLCopen `.EXPORT` XML | read, edit, create POUs, declare variables, export, import |

## Requirements

- Windows (the bridge drives Delta's x86 assemblies through
  `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`)
- Node.js 18+
- DIADesigner 1.14 installed, for anything beyond pure `.EXPORT` editing

## Installation

```bash
git clone https://github.com/Induprogress/MCP_Diadesigner.git
cd MCP_Diadesigner
npm install
```

A prebuilt `dist14/` is committed, so you can point an MCP client at it right
away. If you change the TypeScript sources, rebuild with:

```bash
npm run build
```

## Configuration

Point your MCP client at `dist14/bin.js` directly (see
[examples/diadesigner14_config.json](examples/diadesigner14_config.json)):

```json
{
  "mcpServers": {
    "diadesigner": {
      "command": "node",
      "args": [
        "C:\\Path\\To\\MCP_Diadesigner\\dist14\\bin.js",
        "--diadesigner-path",
        "C:\\Program Files (x86)\\Delta Industrial Automation\\DIAStudio\\DIADesigner 1.14\\DIADesigner.exe",
        "--workspace",
        "D:\\YourProjectRoot"
      ]
    }
  }
}
```

Restart your MCP client to apply the change.

### Command-line arguments

- `-d, --diadesigner-path <path>` — path to `DIADesigner.exe`. Optional: the
  server scans `…\DIAStudio\DIADesigner <major>.<minor>` under both Program
  Files trees and picks the newest install if omitted.
- `-z, --sevenzip-path <path>` — path to the bundled `7za.exe` helper.
  Defaults to `7zTool\7za.exe` next to the executable.
- `-w, --workspace <dir>` — workspace directory for resolving relative paths
  passed to tools. Defaults to the current working directory.

## Working model

DIADesigner keeps program logic inside encrypted containers, so the server
does not edit `PLC.prog` in place. The supported loop is:

1. In DIADesigner, export the POUs you want to work on to a `.EXPORT` file.
2. Read and edit that file with the tools below.
3. Import the file back in DIADesigner and let it compile and validate.

`compile_program` shortens step 3 when you already have a program container,
but DIADesigner remains the authority on whether code is valid.

## Tools

### Installation and workspace

- `detect_installation` — executable, version, helper tools, and whether the
  assemblies the bridge needs are present
- `check_bridge` — confirms the .NET bridge loads Delta's assemblies (run
  this first when native tools misbehave)
- `scan_workspace_projects`, `inspect_file`, `resolve_path`
- `list_archive_entries`, `extract_archive`, `create_backup`
- `list_device_catalog`, `open_in_diadesigner`

### Native project

- `read_native_project` — decrypts a `.diade` container and returns the
  solution and device tree
- `read_program_header` — `PLC.prog` / `PLC.diaobj` header fields
- `read_program` — loads a container through DIADesigner's own loader and
  lists its POUs and data types
- `compile_program` — runs the ISP compiler (`mode: "check"` validates only)
- `read_program_memory` — reads the decrypted program straight out of a
  *running* DIADesigner process's memory (ClrMD, read-only); the project must
  be open in DIADesigner first
- `convert_ld_to_st` — reconstructs Structured Text from the Ladder networks
  read via `read_program_memory`, optionally isolated to one POU/station with
  a coil-name regex

### Program content (PLCopen `.EXPORT`)

- Read: `list_pous`, `get_pou`, `list_variables`, `list_global_variables`,
  `list_structures`
- Create: `create_empty_export`, `create_pou`, `create_structure`
- Edit: `set_pou_code`, `set_pou_body_xml`, `declare_variables`, `delete_pou`
- Move: `export_objects`, `import_objects`

### Symbols (DiaTag)

- `list_symbol_structures`, `list_symbol_global_nodes`, `find_free_d_range`
- `create_symbol_structure`, `create_symbol_global_node`

D-register ranges are computed from the type sizes declared in the symbol
file, so `find_free_d_range` reflects real occupancy rather than an assumed
layout.

## Types accepted in declarations

Elementary IEC types (`BOOL`, `INT`, `DINT`, `REAL`, `LREAL`, `TIME`, …),
`STRING(n)` / `WSTRING(n)`, `ARRAY[lo..hi] OF <type>`, and any user-defined
type name (emitted as `<derived name="…"/>`).

`declare_variables` appends to an existing variable group when the POU
already has one of that kind, so the file keeps whatever layout DIADesigner
wrote. Redeclaring an existing name requires `replaceExisting: true`.

## Project format: 1.13 versus 1.14

The `.diade` container changed between versions:

| Version | Container | `read_native_project` |
| --- | --- | --- |
| 1.13 | raw binary AES | fails — the 1.14 reader expects Base64 |
| 1.14 | Base64-armoured AES | works |

`inspect_file` reports which container a `.diade` uses. To bring a 1.13
project forward, open it in DIADesigner 1.14 (launcher → **Project
Migrate**) and save it; afterwards the native tools accept it.

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
`set_pou_body_xml` instead. Edits are byte-range splices, so anything the
tools do not understand elsewhere in the document survives untouched.

## Safety

Every write creates a timestamped `.bak-<timestamp>` copy next to the file
unless you pass `backup: false`.

## Documentation

See [docs/diadesigner14.md](docs/diadesigner14.md) for the full reference,
including verified behaviour and known gaps.

## License

MIT — see [LICENSE](LICENSE).
