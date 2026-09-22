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

> Rewriting an LD POU to ST by hand in the DIADesigner UI? See
> [ld-to-st-workflow.md](ld-to-st-workflow.md) for the step-by-step recipe
> and its pitfalls — several of the gaps documented below (whole-project
> scoping, cross-POU name collisions, the mid-file BOM issue) are exactly
> what that guide exists to steer you around.

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
- The generated PLCopen shape *was* round-tripped through DIADesigner's own
  **Edit > Import** command against a real project. It surfaced a real bug
  (now fixed: the from-scratch `.EXPORT` template was missing `<fileHeader>`
  / `<contentHeader>`, which DIADesigner's importer indexes into without a
  bounds check), but Import still failed even with the fix, immediately
  triggering DIADesigner's own "Anomaly detected" crash-report prompt.
  **Root cause, confirmed**: DIADesigner's own `Edit > Export` on a real POU
  writes an AES-encrypted container, not plain PLCopen XML — the plaintext
  `.EXPORT` files shipped under `Programming/Resource/*/Standard.EXPORT` are
  library resources, unrepresentative of what Export produces for project
  content. Import expects that encrypted shape, so a hand-built plain-XML
  file can't succeed through that menu regardless of how correct its PLCopen
  structure is. This is a hard limit on the `.EXPORT` workflow for pushing
  content into a live project via Import specifically — reading and offline
  editing of `.EXPORT` files (this toolkit's actual PLCopen tools) is
  unaffected.
- **Confirmed working path to add real content to a project**: DIADesigner's
  own `New Program` (right-click the `Program` folder in the tree,
  `PRG_NewProgram`) offers ST as a language choice — DVP-series devices do
  support Structured Text, disproving the earlier suspicion that this
  project's Ladder-heavy style meant no ST support. Creating an empty ST
  POU there, then pasting generated ST source directly into its code editor
  and saving, works. Undeclared identifiers prompt once each ("Add a
  Variable to POU") — point these at an existing global tag table (e.g.
  `Default_Tag_Table`), not the POU's own local scope, and they resolve to
  the project's real shared variables (verified: the live variable count via
  `read_program_memory` didn't change after "adding" 3 apparently-new
  variables, meaning DIADesigner linked them to variables that already
  existed elsewhere in the project). `Check` on the resulting POU reported
  0 errors, 0 warnings.
- **Per-POU network extraction: investigated, not solved.** `read_program_memory`
  reads every `IspProject.NetWorkData` resident on the heap (the ISP
  compiler's flat model, eagerly loaded for the whole project) but that class
  carries no back-reference to which POU it belongs to. `coilPattern` sidesteps
  this by matching on the coil's *name*, which only works when a POU's coils
  share a distinctive naming convention -- and even then it is not reliable:
  re-deriving `falowniki` from first principles (via the newly-added
  `list_live_pous`, see above) showed it actually owns 44 networks, not the
  ~30 `coilPattern: "falow"` had captured -- some (`alarm_falownika_pompy_*`)
  actually belong to a *different* POU (`alarmy`) that merely shares the
  naming convention, while others belonging to `falowniki`
  (`MYCIE_WLACZONE_ST*` set/reset pairs) don't contain "falow" at all and were
  silently missed. Five different avenues for a *real* POU→network
  correlation were tried against the live process and all came up empty on an
  idle document: `NetworkCanvasData.CompilerRefGuid` (always
  `00000000-...`, even immediately after first opening the POU -- likely
  wired only for a project-compare/diff feature, not general editing),
  `BlockCanvasData.ModelInfo` (always null), `NetworkCanvasData.rowData`
  (always null), and `ContactData.currentBlock`/`.parentBlock` →
  `.ParentNetwork` (the block reference itself populates once nested in a
  branch, but its own `ParentNetwork` back-reference is null). One promising
  but unproven lead: `IspProject.NetWorkData` objects belonging to the same
  POU appear **address-contiguous** when enumerating the ClrMD heap, in the
  same order as `list_live_pous`' own POU enumeration -- consistent with
  in-order parsing at project load. This could support a count-based slice
  (`list_live_pous`' `networkCount` gives an exact per-POU boundary) but
  needs a reliable way to exclude stale/duplicate `NetWorkData` copies
  (confirmed to exist -- e.g. re-`Check`ing a POU leaves extra copies behind)
  before it can be trusted for something that ends up as real control logic.
  Not implemented; `read_program_memory`'s `-PouName` bridge parameter exists
  in `DiaMemoryReader.cs` but currently returns
  `PouName-scoped extraction is not yet implemented` rather than a wrong
  answer.
- **`read_program_memory` / `convert_ld_to_st` grid reconstruction, fixed and
  verified**: the previous reader only looked at `NetWorkData.iList`'s
  top-level elements, so any rung built from a `BranchData` (a parallel OR
  branch) or a nested `type="fb"` branch (a `=`/`<>`/relational compare
  block) had that entire piece silently dropped — the tool would emit a
  plausible-looking but wrong ST expression with no indication anything was
  missing. `bridge/DiaMemoryReader.cs` now walks `BranchData` grids
  recursively (rows are OR alternatives, columns within a row are AND) and
  resolves an `fb` branch's `InVariablesMacro` + `Block.typeName` into the
  actual comparison and its operands. Verified by hand-tracing the raw grid
  for `falownik_pompy_ST1_bieg2` against a screenshot of the same rung open
  in DIADesigner's Ladder editor (parallel `=6`/`=9`/`=2`/`<>8` compare
  blocks, several with a trailing series contact, feeding a shared vertical
  bus) and confirming an exact match, then running the same path across all
  30 falownik-station rungs in that project with 0 unresolved terms. A
  genuinely unrecognized element (e.g. a timer or other library
  function-block instance) now comes through as an explicit
  `(* UNRESOLVED: ... *)` marker in the generated ST instead of vanishing.
- **`export_project` (GUI-driven whole-project export) does not produce PLCopen
  XML.** Despite the tool description, driving DIADesigner's own
  `Programming` → right-click → **Export** with *many* POUs selected (either
  the whole tree via Shift+click range-select, or an explicit multi-item
  selection) writes a small, AES-encrypted file — `list_pous`/`get_pou` reject
  it with `Not an XML document`. This reproduces even for a 2-object
  selection, so it is not a size/count threshold; it looks like Export always
  encrypts once more than one object is selected. A **single-object** Export
  (right-click exactly one POU, e.g. just `FalownikiST`) reliably produces
  plain, well-formed PLCopen XML that the toolkit's tools parse correctly —
  confirmed on several POUs this session. Until multi-object export is
  understood or fixed, the only proven way to get a POU's XML via this menu is
  one Export per POU.
- **`convert_ld_to_st` is not scoped to the open/active POU tab** — it walks
  every `IspProject.NetWorkData` resident in the process regardless of which
  POU is frontmost in the UI (same underlying source as `read_program_memory`;
  see the per-POU extraction section above). Calling it with no `coilPattern`
  after opening a single small POU (`RTC`) still returned 574 networks spread
  across most of the project's LD POUs in one flat list, with no per-network
  POU tag. Two consequences for anyone trying to use its output as a
  "ground truth" reference per POU:
  - When the **same coil name is written by more than one POU** (e.g.
    `komunikat1_st1`, set independently by both `mycie_st1` — on a
    credit/impulse condition — and `komunikaty_1` — on `D31` display-code
    edges, a real and intentional dual-writer pattern, verified via
    **Find and Replace → Look in: Current Project → Find All**, which reports
    every `Network/Element (n, TYPE)` hit with its owning POU in the `Source`
    column), a flat coil-name → statement map silently conflates the two.
    Comparing an actual POU's ST against "the" ideal entry for that coil name
    can flag a false mismatch that is actually a same-named rung belonging to
    a *different* POU. **`Find All` with `Look in: Current Project` is the
    reliable way to enumerate every POU that touches a given variable**,
    something no MCP tool here currently exposes.
  - Whole swaths of some POUs are **silently absent** from the flat dump even
    though they compile with 0 errors and are clearly present in the LD
    canvas — observed for `STATYSTYKI`, `SMS`, `wykresy`, `komunikacja`,
    `alarmy`, `odkurzacze`, `osmoza`, `programy`, `WYKRES_ROCZNY` (all showed
    dozens of target variables with no corresponding entry at all, versus
    POUs like `RTC`, `promocje`, `mycie_st1`/`MYCIE_ST2..6`, `komunikaty_1..6`,
    `licencja`, `pompy` which came through close to completely). Root cause
    not isolated — plausibly instructions the reader doesn't recognize
    causing it to drop the *whole* network rather than emit `UNRESOLVED` for
    just the unrecognized piece, but not confirmed.
  - A comment-stripping mismatch: `RegionLogicCommandData` (a grid/layout
    element inside a network — the same thing `bridge/_parse_clip.js`'s
    clipboard-XML parser already learned to skip as visual-only, see its
    `regionLogicCommand` handling) comes through `convert_ld_to_st` as a
    literal `(* UNRESOLVED: unhandled element type RegionLogicCommandData *)`
    inside the emitted boolean expression, e.g.
    `IF (2 = D31) AND (* UNRESOLVED: ... *) THEN ...`. Naively stripping `(*
    ... *)` comments for a text/logic diff leaves a dangling `AND`/`OR` right
    before `THEN` or `;`, which reads as a missing term when the real LD (and
    the correctly-translated ST) never had one. `DiaMemoryReader.cs` should
    most likely skip `RegionLogicCommandData` the same way `_parse_clip.js`
    skips `regionLogicCommand`, rather than surfacing it as UNRESOLVED.
- **Reliable way to read an ST POU's actual current source without exporting
  anything**: open the POU's ST worksheet tab in the UI, click into the code
  editor, `Ctrl+A` then `Ctrl+C`, then read the OS clipboard directly
  (`Get-Clipboard` from PowerShell). Unlike a Ladder worksheet — where
  `Ctrl+A`/`Ctrl+C` yields the clipboard "Network" XML format that
  `bridge/_parse_clip.js` exists to decode — copying from an **ST** worksheet
  puts the plain ST text on the clipboard verbatim, no parsing needed.
  Verified byte-for-byte stable: a fresh capture of `MYCIE_ST4ST` this session
  matched a capture of the same POU taken in an earlier session days prior.
  This is the cheapest path to "what does this ST POU actually contain right
  now" when `export_project`'s multi-object path is unusable (previous
  bullet) and doing one single-object Export per POU is too slow.
- **Auditing LD-vs-ST translation quality (this session's actual task)**: with
  no tool able to produce a reliable per-POU "ideal" ST reference at scale
  (both gaps above), the only trustworthy method found was fully manual:
  open the LD POU's canvas directly, read each network, and compare it by
  hand against the ST worksheet's actual text (captured per the clipboard
  method above). A same-text-but-different-shape trap worth recording for
  future comparisons: DVP's `SER`/`DSER` (find index of max/min over an
  array) and `WSUM` (sum of n consecutive words) are frequently hand-unrolled
  into an explicit ST comparison chain or `+` chain rather than called
  directly — confirmed correct in `WYKRES_STANOWISKA`, `WYKRES_PROGRAMY`,
  `WYKRES_ROCZNY` (`DSER` → sequential max-tracking `IF x > max THEN max :=
  x`) and `odkurzacze` (`WSUM` → explicit `+`). These are legitimate,
  semantically-equivalent rewrites, not translation bugs, and a naive
  instruction-name-based comparison would flag every one of them as a
  mismatch. Likewise `WSFL` (circular shift register) gets hand-unrolled into
  one assignment per slot, highest-index first (to avoid clobbering a value
  before it's copied) plus a final zero-and-reset of the source slot —
  verified step-by-step against the LD's actual `WSFL(S, D, n1, n2)`
  parameters in `WYKRES_ROCZNY` and found to match exactly.
  Also worth noting for whoever automates this further: naive text/AST
  equality is not enough even after fixing parenthesization — `AND`/`OR` are
  associative and commutative in this domain (no side effects in these pure
  boolean/arithmetic reads), so a real comparison needs a canonicalizing
  boolean-expression parser (tokenize → parse with standard precedence → flatten
  nested AND/OR into sorted operand lists → compare canonical forms) rather
  than string matching, or every reordered/re-parenthesized-but-equivalent
  rung reads as a false positive.
