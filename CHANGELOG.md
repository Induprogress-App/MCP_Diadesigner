# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed (critical, live re-verification session)
- **The `rowCount` heuristic from the previous fix was wrong and has been replaced.**
  Direct visual inspection of the Ladder canvas (zooming into the actual diagram in
  DIADesigner) proved that `rowCount` does not reliably indicate branch count, or
  even whether branching exists at all: three different real networks with
  `rowCount=="1"` turned out to be genuine OR grids (each contact/term
  independently bridging the same left rail to the same right bus -- textbook
  ladder OR), including one -- mycie_st1's "PRACA_ST1 OR alarm-rising-edge" guard,
  feeding 8 coils -- that had been shipped live as AND based on domain-reasoning
  alone. The real, now-confirmed rule: the *presence* of a trailing
  `<marco type="normal" columnCount="N" .../>` at all (regardless of `rowCount`)
  means the preceding top-level contact/compare terms are OR'd, because a true
  AND-series carries no such marco in its rootLink whatsoever. Boundary detection
  now also tracks the marco's exact position in the sequence (not just prefix vs.
  suffix relative to the whole list), since a shared AND-term can appear *after*
  the OR-group too (confirmed on mycie_st1's credit-increment rung: 3 OR'd
  payment-trigger contacts, THEN the grid marco, THEN a 4th
  "zezwolenie_pracy_stanowisko1" contact ANDed onto the result). A further wrinkle:
  a compare immediately following a contact merges into that contact's own branch
  only when this "contact+compare" pairing repeats 2+ times (confirmed on
  promocje's 7 "day contact + (SR397=n)" pairs); a single such adjacency is treated
  as coincidental (a shared prefix that merely precedes the first of several
  independent compare-only branches, confirmed on alarmy's "NOT Lizcznik" prefix
  before 6 independent `godziny_pracy_stN > 350` branches) and is left
  unmerged. **This bug had already shipped wrong logic to five live POUs** --
  `mycie_st1ST`, `WEJSCIAST`, `alarmyST`, `promocjeST`, `programyST` -- all
  re-verified against the real diagrams and re-pasted with corrected AND/OR
  structure; all still `Check` to 0 errors.
- `D+`/`D-`/`D*`/`D/` (Delta's double-word/32-bit arithmetic mnemonics) have the
  same problem as `F+`/`F-` (a `+`/`-`/`*`//` character breaks ST identifier
  parsing) and now map to the same plain operators. Confirmed live: cascaded into
  a bare "D" being treated as an undeclared identifier and dozens of further
  errors in `STATYSTYKI`.
- `INC`/`DINC` (Delta's increment-in-place mnemonics: one register, no separate
  output pin) are also undeclared identifiers in this compiler, same as
  `FLT`/`INT`/`D+` -- but unlike those, the semantics are unambiguous plain ST, so
  `INC(x)` now emits `x := x + 1;` directly with no `VERIFY` marker at all (no
  vendor-specific risk). This single fix cleared most of a 65-error cascade in
  `STATYSTYKI` (which calls `INC`/`DINC` roughly twenty times).
- `WSUM(base, N)` (sum of N consecutive registers from a base address) and
  `SER(base, from, N)` (find max value + its index among N registers) are also
  undeclared identifiers, with no safe generic expansion -- `WSUM` was hand-fixed
  in `STATYSTYKI` to an explicit sum since the station variable names were already
  known (`LICZNIK_INNE_ST1 + ... + LICZNIK_INNE_ST6`); `SER` (and the two lines
  reading its result via `E0`/`@E0` indexed addressing) is left as a flagged,
  unresolved gap needing Delta's own DVP ST instruction reference -- the last two
  live compile errors in `STATYSTYKIST`.
- Converted `STATYSTYKI` (36 networks, coin/card/counter statistics) to
  `STATYSTYKIST` -- 2 remaining errors, both on the one documented `SER` gap
  above.

### Added
- `bridge/_parse_clip.js` -- a standalone Node parser for DIADesigner's clipboard
  "Network" XML format (select all networks in a POU's Ladder editor, Ctrl+C; the
  clipboard holds a clean, unencrypted PLCopen-style XML document under the format
  name `"Network"`, readable via `[System.Windows.Forms.Clipboard]::GetData('Network')`
  as a `MemoryStream`). This **solves per-POU network extraction**, which the
  ClrMD-based `read_program_memory` path could never do (see the "investigated, not
  solved" entry below) -- the clipboard content is exactly and only the selected
  POU's own networks. Not yet ported into `src/dia14/` as a formal MCP tool; used so
  far as a manual workflow (open POU -> copy -> parse -> paste generated ST into a
  new `{name}ST` POU -> resolve declarations -> `Check`) to convert `FalownikiST`,
  `mycie_st1ST`, `RTCST`, `WEJSCIAST`, `alarmyST`, `promocjeST`.
- Edge detection (`R_TRIG`/`F_TRIG`) in generated ST uses a manual shadow-bit
  pattern instead of calling `R_TRIG(x)`/`F_TRIG(x)` as functions: rising edge is
  `(X AND NOT EDGE_X)`, falling edge is `(NOT X AND EDGE_X)`, with `EDGE_X := X;`
  emitted once per distinct signal at the end of the POU body. Confirmed live that
  bare `R_TRIG(x)`/`F_TRIG(x)` calls are rejected ("Undefined identifier"), and that
  declaring an FB instance of the library POU `DFB_R_TRIG` compiles but reports
  "Undefined data type" -- this compiler doesn't support instantiating it from ST
  text. The shadow-bit pattern is standard IEC ST with no vendor-specific risk.

### Fixed
- **Two silent AND/OR-corruption bugs in `_parse_clip.js`'s grid handling, both
  confirmed live against real Ladder diagrams (not just plausible-looking guesses):**
  - Some genuine parallel-branch (OR) grids carry no `<verticalLine/>` separators at
    all -- the whole link just ends with a `<marco type="normal" columnCount="N"
    rowCount="M" .../>` summarizing the grid shape, with the branch content itself a
    flat, undifferentiated element sequence. The parser used to silently AND-chain
    that entire sequence into one (usually always-false or wrong) expression.
    Confirmed on `promocje`/`PROMOCJA_ZAL` (a 7-day-of-week OR, flattened into an
    AND that could never be true) and two rungs in `alarmy`
    (`NISKA_TEMPERATURA_PIECA`'s `(T<300) AND (T>1000)` -- physically impossible,
    silently dead code instead of the intended out-of-range OR; and
    `aLARM_wYMAGANY_PRZEGLAD_ST1`'s 6-station OR collapsed to AND). A first attempt
    at auto-reconstructing the OR-partition from `columnCount` alone produced a
    plausible-looking result for the 7-day case but then silently mis-guessed
    AND-as-OR on other, already-correct networks when applied broadly (e.g. turning
    `PRACA_ST1 AND (alarm rising edge)` into `PRACA_ST1 OR (alarm rising edge)`).
    Guessing AND/OR structure is exactly the class of bug this conversion effort
    exists to avoid, so the parser now only auto-resolves the unambiguous case
    (`rowCount==1`, which cannot be a multi-branch grid at all) and otherwise emits
    an explicit `(* UNRESOLVED GRID: ... *)` marker demanding a look at the real
    diagram -- never a guess. The three confirmed cases above were fixed by hand
    after visually confirming the branch topology in DIADesigner (zooming the
    Ladder canvas and tracing which rows share a bus), the same rigor used earlier
    for the `falowniki` `BranchData` fix.
  - A **different** grid shape: an `outLink` with several independent `<coil>`s
    sharing one `rootLink` is a genuine "MPS" (multiple parallel split) rung -- a
    shared AND-prefix feeds N *independent* legs, each pairing one term with its
    own dedicated coil, not all N terms ANDed into every coil and not ORed into one
    coil. Confirmed on `alarmy`/`CZAS_PRACY_POMPY_ST1..6`: one shared "NOT
    Lizcznik_czasu_pracy_pomp_CAT" contact, then 6 independent
    "godziny_pracy_stN > 400" terms, each driving its own station's coil (i.e. each
    station's overdue-maintenance flag depends only on that station's own hours,
    not all 6 pumps' hours combined -- the parser had been emitting the same
    all-6-ANDed expression identically to all 6 coils). Added
    `splitSharedRootIntoLegs`, which recognizes an `outLink` that is purely N>1
    coils and, if the `rootLink`'s shared-prefix-plus-N-terms shape matches
    exactly, pairs each term positionally with its coil; falls through to the safe
    UNRESOLVED-flagging path (never a guess) if the shape doesn't match cleanly.
  - `timer_ST1_N := FALSE;` (a `RST` coil on what is actually a timer's numeric
    accumulator, not a BOOL) caused a real "operands' data type don't match" error
    in `mycie_st1ST` -- fixed by hand to `:= 0`, a real, project-specific gap in the
    parser's coil-storage handling (it always emits `TRUE`/`FALSE`, with no way to
    know a coil's target isn't boolean from the clipboard XML alone).
  - `FLT`/`INT` (Delta's int<->float ladder mnemonics) can't be emitted as bare
    function calls: `INT` is the IEC-reserved `INT` type keyword (a hard syntax
    error, confirmed live -- cascaded into 60 "operator might be missing" errors in
    `RTCST`), and the IEC-standard names `INT_TO_REAL`/`REAL_TO_INT` aren't
    recognized either -- DIADesigner treated them as undeclared identifiers and
    prompted to declare them as POU variables, meaning this DVP-series compiler has
    no such built-in conversion function under either name. Now emitted as a plain
    `:=` assignment relying on implicit numeric conversion (common in less strictly
    IEC-conformant industrial ST dialects) -- unverified, so `RTCST`'s credit-rate
    calculation block (`FLT`/`INT`/`F+`/`F-`/`F/`) still has ~30 flagged
    type-mismatch errors pending a look at Delta's own DVP ST instruction reference.
  - `F+`/`F-`/`F*`/`F/` (Delta's float-typed arithmetic mnemonics) were being
    emitted as function calls, but a symbol like `F-` isn't a legal ST identifier
    and breaks parsing. ST's arithmetic operators are polymorphic over REAL, so
    these now map to the same plain `+`/`-`/`*`/`/` as the integer forms.
  - Unmapped Delta API instructions with exactly one output (anything not already
    mapped by `computeExpr`) were emitted as a bare call with the output silently
    dropped (`OP(ins);` instead of `out := OP(ins);`) -- meaning the computed value
    was never actually assigned anywhere. Now emits the assignment even when the
    call syntax itself is still unverified (flagged `VERIFY`).

### Verified (continued)
- Live re-conversion, via `_parse_clip.js`, of `FalownikiST` (30 rungs, done in an
  earlier pass with the ClrMD-based `read_program_memory` tool -- unaffected by any
  of the above), `mycie_st1ST`, `RTCST`, `WEJSCIAST`, `alarmyST`, `promocjeST` --
  all `Check` to 0 errors, 0 warnings except `RTCST`'s flagged FLT/INT block above.

### Added
  `dist14/bin.js` and the local DIADesigner 1.14 install.
- `list_live_pous` — lists every POU resident in a running DIADesigner
  process's memory: name, worksheet type (the language signal, e.g.
  `LDWorkSheet`/`STWorkSheet`), and that POU's own network count. The count
  comes from `POU.codeBody.codeWorkSheet.graphicCanvasData._networks`, which
  is reliably scoped to that one POU -- but it is **lazily populated**: a POU
  reports `networkCount: 0` until its Ladder editor tab has been opened at
  least once in the running session, then reflects the real count from then
  on. Useful for surveying a project (which POUs actually have logic worth
  converting) even though per-POU network *extraction* isn't solved yet --
  see Known gaps.
- `read_program_memory` / `convert_ld_to_st` now reconstruct the real Ladder
  grid instead of a flattened AND-only guess. `bridge/DiaMemoryReader.cs`
  walks `NetWorkData.iList` recursively: a `BranchData` row/column grid is
  read as OR-of-rows / AND-within-a-row (previously only its presence was
  flagged, its contents were discarded), and a nested `type="fb"` branch is
  resolved through its `InVariablesMacro`/`Block`/`typeName` into an actual
  `=` / `<>` / relational comparison with real operands (e.g.
  `(nr_programu_st1 = 8)`) instead of being silently dropped. Each network
  now reports a `terms` tree (`contact` / `compare` / `or` / `unknown`)
  rather than a flat element list; `src/dia14/ldToSt.ts` was rewritten to
  render that tree straight into ST, with an explicit
  `(* UNRESOLVED: ... *)` marker for anything it still can't interpret
  (e.g. a timer or other library function-block instance) instead of
  dropping it. `convert_ld_to_st` also now dedupes networks by coil name,
  since ClrMD sometimes walks two live copies of the same rung.
  Verified against the `MyjniaDIA` test project: hand-traced the raw
  `BranchData` grid for `falownik_pompy_ST1_bieg2` against a screenshot of
  DIADesigner's own Ladder editor (parallel `=`/`<>` compare blocks feeding
  a shared vertical bus) and confirmed the tool's reconstruction matches
  exactly; ran the same reconstruction across all 30 falownik-station rungs
  with 0 unresolved terms.

### Fixed
- `create_empty_export` (and therefore every POU built from scratch with
  `create_pou`) produced a `<project><types>...` document missing
  `<fileHeader>` and `<contentHeader>`. DIADesigner's own Import command
  indexes into those without an existence check, so importing one of our
  from-scratch `.EXPORT` files threw `Specified argument was out of the
  range of valid values. Parameter name: index` instead of loading. The
  empty-document template now matches the shape of Delta's own shipped
  exports (`Programming/Resource/AS_Series/*/Standard.EXPORT`).

### Verified
- Fresh `npm install` plus `npm test` (61 assertions over real stdio) against
  a DIADesigner 1.14 install at
  `C:\Program Files (x86)\Delta Industrial Automation\DIAStudio\DIADesigner 1.14`,
  confirming installation detection, the x86 .NET bridge (`check_bridge`),
  and `.diade` decryption all work unmodified on a new machine.
- First real attempt at round-tripping a from-scratch `.EXPORT` through
  DIADesigner's own **Edit > Import** (`BOP_Import`) command, against a real
  customer-style project (single-device, Ladder-only, no existing POUs).
  Fixing the header issue above stopped the "index" exception, but Import
  still fails on this project — see Known gaps below.

### Known gaps
- DIADesigner's Import command (`Edit > Import` / `BOP_Import`) fails on any
  plain PLCopen `.EXPORT` — including a header-only file with zero POUs —
  with an `ArgumentOutOfRangeException` immediately followed by DIADesigner's
  own "Anomaly detected, DIADesigner needs to be closed" report prompt
  (declined sending the report both times). Root cause, confirmed by using
  DIADesigner's own `Edit > Export` on an existing project POU: **Export
  writes an AES-encrypted container, not the plain XML shape used by Delta's
  shipped library files** (`Programming/Resource/*/Standard.EXPORT` are
  library resources, not representative of what a real project exports).
  Import expects that same encrypted shape, so a hand-built plain-XML
  `.EXPORT` — however well-formed — was never going to import through this
  menu command, regardless of PLCopen structure. This is a hard limit on the
  `.EXPORT`-file workflow for pushing new content into a real project via
  the UI's Import command; earlier suspicion that this project's Ladder-only
  "Basic Designer" style, or lack of ST support, was the cause turned out to
  be wrong — see Verified below.
- `read_program` / `load-program` still fails on this project's `PLC.prog`
  offline (unrelated to the above; still unconfirmed against a container that
  loads cleanly).

### Verified (continued)
- **The actual working path to add a new POU to a real project**, found by
  testing this project interactively: DIADesigner's project tree exposes
  real POUs (this project already had ~30, e.g. `falowniki`, `alarmy`,
  `programy` — ladder-language pages, not just one flat program), and its
  own `New Program` dialog (`PRG_NewProgram`, right-click the `Program`
  folder) offers ST as a language choice alongside LD/SFC/C/CFC — DVP-series
  devices support ST. Creating an empty ST program natively, then pasting
  generated ST source into its code editor (`Ctrl+A`, `Ctrl+V` into the
  `STView` document control) and saving, works cleanly. DIADesigner prompts
  once per identifier that isn't yet known to that POU ("Add a Variable to
  POU") — ST requires explicit declarations that Ladder doesn't, since named
  coils/contacts resolve directly against the project's shared tag tables
  (`Default_Tag_Table` etc.) without per-POU declaration. Routing each
  prompt to an existing global tag table (not the POU's own local scope)
  links back to the *same* project-wide variable already used elsewhere —
  confirmed here because the live decrypted variable count
  (`read_program_memory`) didn't change after adding 3 "new" declarations,
  meaning all three already existed as real project variables. `Check`
  (`BOP_MENU_CHECK`) on the new POU reported 0 errors, 0 warnings.
  Net effect: **PLCopen `.EXPORT` generation/editing stays useful for
  reading and offline authoring, but getting new content into a live
  project currently has to go through DIADesigner's own POU editor UI, not
  Import.**

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
