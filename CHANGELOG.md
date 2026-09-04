# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Project-scoped `.mcp.json` at the repo root so an MCP client picks up the
  `diadesigner` server automatically on this checkout, pointing at
  `dist14/bin.js` and the local DIADesigner 1.14 install.

### Verified
- Fresh `npm install` plus `npm test` (61 assertions over real stdio) against
  a DIADesigner 1.14 install at
  `C:\Program Files (x86)\Delta Industrial Automation\DIAStudio\DIADesigner 1.14`,
  confirming installation detection, the x86 .NET bridge (`check_bridge`),
  and `.diade` decryption all work unmodified on a new machine.

## [1.2.0] - 2026-08-29

### Added
- Delta DIADesigner **1.14** MCP server (`diadesigner-mcp-tool`, `dist14/`),
  rewritten from scratch in `src/dia14/` — 33 tools and 3 resources.
- Native .NET bridge (`bridge/DeltaBridge.ps1`) driving DIADesigner's own
  assemblies from the 32-bit PowerShell host:
  - `read_native_project` decrypts `.diade` containers
  - `read_program_header` decodes `PLC.prog` / `PLC.diaobj` headers using the
    field offsets published by the installed version
  - `read_program` and `compile_program` drive Delta's loader and ISP compiler
- Program authoring over PLCopen `.EXPORT` XML: `create_pou` (program /
  functionBlock / function), `declare_variables`, `create_structure`,
  `set_pou_code`, `set_pou_body_xml`, `delete_pou`, `create_empty_export`.
- `export_objects` / `import_objects` to move POUs and data types between
  files, with skip-by-default and explicit `overwrite`.
- Reading tools: `list_pous`, `get_pou`, `list_variables`,
  `list_global_variables`, `list_structures`.
- Type support in declarations: `STRING(n)`, `ARRAY[lo..hi] OF <type>`,
  user-defined types, initial values and direct addresses.
- Installation autodetection — the newest `DIADesigner <major>.<minor>` install
  is found automatically, so `--diadesigner-path` is now optional.
- `check_bridge` diagnostic tool.
- End-to-end test suite (`npm test`, 61 assertions) driving the real server over
  stdio.

### Changed
- `inspect_file` now identifies the container format and distinguishes 1.13
  (raw binary) from 1.14 (Base64) `.diade` projects, with migration guidance.
- Every write still creates a timestamped backup, now suppressible per call.

### Fixed
- Indentation corruption when inserting POUs, data types and bodies: blocks were
  spliced at the closing tag without accounting for the whitespace already on
  that line, so each insert stacked one extra indent level. Splices now widen
  over the line's leading whitespace.
- `read_program_header` validates that decoded offsets fit inside the file and
  reports `headerPlausible: false` instead of returning noise for a corrupt or
  truncated container.
- `create_symbol_global_node` inserted DiaTag nodes with doubled indentation and
  left the closing `</Node>` unindented; it now uses the same splice helper as
  the PLCopen writer.

### Notes
- DIADesigner 1.13 projects are not readable by the 1.14 project reader; migrate
  them in the UI (launcher → Project Migrate) first.
- `read_program` and `compile_program` still need one run against a valid saved
  program container to be considered proven — see `docs/diadesigner14.md`.

## [1.1.16] - 2025-05-06

### Fixed
- Reverted to v1.1.3 code base which has working POU creation functionality
- Fixed path handling by using simpler approach from v1.1.3
- Restored original Application object finding logic that worked in v1.1.3

## [1.0.0] - 2025-04-23

### Added
- Initial release of the MCP server for CODESYS
- Command-line interface with configuration options
- Project management functionality:
  - Opening existing CODESYS projects
  - Creating new CODESYS projects
  - Saving projects
- POU (Program Organization Unit) management:
  - Creating POUs (Programs, Function Blocks, Functions)
  - Setting POU code (declaration and implementation)
  - Creating properties and methods for Function Blocks
- Project compilation support
- Resources for querying:
  - Project status
  - Project structure
  - POU code
- Documentation for installation and usage
