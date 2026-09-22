# Converting LD programs to ST: a practical workflow

This is the step-by-step recipe for rewriting a Ladder Diagram (LD) POU into
Structured Text (ST) in a real DIADesigner 1.14 project, using the MCP server
plus the helper scripts under `bridge/`. It comes out of doing this on a real,
live production PLC project across many POUs — every pitfall listed here was
hit at least once. Read the whole "Pitfalls" section before touching a live
project; several of them cause silent, compiling-but-wrong logic rather than
an obvious error.

**This workflow edits a live, potentially production PLC project. There is no
"undo" once DIADesigner's ST editor has a paste in it — see [Pitfall
1](#1-diadesigners-st-editor-auto-persists-there-is-no-undo-safety-net).
Always confirm what a change should do before making it on anything you can't
afford to break.**

## Overview

There is no single MCP tool that reliably does "give me the ideal ST for this
LD POU" end to end (see the gaps documented in
[diadesigner14.md](diadesigner14.md#verified-behaviour-and-known-gaps)). The
proven path chains several pieces instead:

```
LD network (DIADesigner canvas)
  -> Ctrl+A / Ctrl+C in the Ladder worksheet (clipboard "Network" XML)
  -> bridge/_parse_clip.js            -> raw ST (EDGE_x shadow-bit pattern)
  -> bridge/edge_to_trig.js           -> ST using DFB_R_TRIG / DFB_F_TRIG
  -> bridge/gen_trig_csv.js           -> CSV of new local FB declarations
  -> DIADesigner: Import CSV File     -> declares the new TRIG_* instances
  -> DIADesigner: paste ST body       -> the POU's actual code
  -> DIADesigner: Compile / Check     -> the only authority on correctness
  -> bridge/compare_ld_st.js          -> optional second-opinion diff vs. LD
```

`convert_ld_to_st` / `read_program_memory` (the MCP tools) can shortcut the
first two steps for a quick look, but they are **whole-project scoped, not
per-POU** — read their caveats in
[diadesigner14.md](diadesigner14.md#verified-behaviour-and-known-gaps) before
trusting their output as a POU's complete, authoritative source. The
clipboard method above is slower but has no such gap: what you copy from the
canvas is exactly what's on the canvas.

## Step by step

### 1. Get the LD source for one POU

Open the POU's LD worksheet in DIADesigner, click into the canvas, `Ctrl+A`
then `Ctrl+C`. Save the clipboard to a file:

```powershell
Get-Clipboard -Raw | Set-Content -Path clip.xml -Encoding utf8
```

### 2. Translate to ST

```bash
node bridge/_parse_clip.js clip.xml > raw.st
```

This handles series contacts (AND), parallel branches (OR, real nested
branches not flattened), `=`/`<>`/relational compare blocks, and emits an
explicit `(* UNRESOLVED: ... *)` marker for anything it doesn't recognize —
grep the output for `UNRESOLVED` and resolve those by hand before trusting
the rest. It also emits the old-style `EDGE_x` shadow-bit pattern for any
rising/falling-edge contact (`P`/`N` in the LD, `^`/`v` in some views) — see
step 3.

### 3. Replace EDGE_x shadow bits with real edge-detection function blocks

`_parse_clip.js` reproduces edge detection the way older hand-written LD
often does it: a manual `EDGE_x` shadow bit compared against the current
value every scan. That's not wrong, but it's not the IEC 61131-3 way and it
reads worse than a declared `R_TRIG`/`F_TRIG` instance. Convert it:

```bash
node bridge/edge_to_trig.js raw.st transformed.st
```

This replaces `(x AND NOT EDGE_x)` with `TRIG_R_x.Q` (and the falling-edge
mirror with `TRIG_F_x.Q`), inserts the `TRIG_R_x(CLK := x);` call, and prints
a JSON summary of every new declaration needed. **Read [Pitfall
3](#3-fb-instance-and-coil-names-are-not-reliably-scoped-per-pou) before
importing those declarations** — this is the single most impactful lesson
from doing this at scale.

### 4. Generate the variable-table CSV and import it

```bash
node bridge/edge_to_trig.js raw.st transformed.st | node bridge/gen_trig_csv.js new_vars.csv
```

In DIADesigner, open the POU's local variable table, right-click →
**Import CSV File** → pick `new_vars.csv`. This is far faster and less
error-prone than declaring each `DFB_R_TRIG`/`DFB_F_TRIG` instance by hand,
and confirmed to work with these function-block types.

### 5. Paste the transformed body into the POU

Do **not** type the code in. See [Pitfall
2](#2-never-type-generated-code-character-by-character-always-paste) — use a
clipboard set → verify → paste → re-capture → diff cycle:

```powershell
$content = Get-Content -Raw -Path transformed.st
Set-Clipboard -Value $content
Start-Sleep -Milliseconds 300
if ((Get-Clipboard -Raw) -ne $content) { throw "clipboard mismatch, do not paste" }
# now click into the POU's ST worksheet, Ctrl+A, Ctrl+V
```

Then immediately re-capture (`Ctrl+A`, `Ctrl+C`, `Get-Clipboard -Raw`) and
diff it byte-for-byte against `transformed.st` (ignore CRLF/BOM-position
differences — see [Pitfall 4](#4-a-stray-bom-mid-file-silently-breaks-compilation)).
Don't move on until they match.

### 6. Compile and confirm

Run DIADesigner's Compile/Check on the POU (or the whole project). Compare
the error/warning count against a baseline taken *before* your edit — "0 new
errors" is the bar, not "0 errors" (this project, like most real ones, may
already carry pre-existing, unrelated issues).

### 7. Optional: cross-check against the LD original

```bash
node bridge/compare_ld_st.js <idealReferenceFromConvertLdToSt> <dirOfActualStCaptures>
```

Reports statements whose guard/expression text differs between the "ideal"
LD-derived reference and the actual ST, using a canonicalizing boolean
expression parser (`bridge/bool_normalize.js`) so that reordered/
re-parenthesized-but-equivalent AND/OR terms don't show up as false
positives. Read the caveats printed in the script's own header — it inherits
`convert_ld_to_st`'s whole-project scoping gaps, so treat a flagged mismatch
as a lead to verify by hand in DIADesigner, not a proven bug.

## Pitfalls

These are not theoretical — every one of them caused a real incident on a
real project during development of this workflow.

### 1. DIADesigner's ST editor auto-persists; there is no undo safety net

Body-text edits in the ST worksheet save live as you type/paste — there is no
"save?" prompt when closing the tab, and closing without saving does **not**
reliably revert a change already made. Treat every paste as committed the
moment it lands. Capture a known-good baseline (full `Ctrl+A`/`Ctrl+C`
export of the POU's current text) *before* editing anything you might need
to restore.

### 2. Never type generated code character-by-character — always paste

Typing ST into the editor via keystroke automation (SendKeys or similar) can
silently trigger DIADesigner's autocomplete popup mid-identifier, which has
been observed to eat characters (e.g. a dropped `(`) and once dropped an
entire `END_IF;`, producing a mis-nested `IF` that still **compiled with 0
errors** — compile success alone does not prove correctness for a
structurally-edited body. Always build the full new body as a string,
clipboard-paste it as one atomic operation, and byte-diff the result against
what you intended to paste.

### 3. FB instance and coil names are not reliably scoped per POU

This is the costliest lesson: generating a function-block instance name (or
any identifier) purely from the *signal* name, with no awareness of which
POU it lives in, is not safe on this platform. Two different POUs each
independently declaring, say, `TRIG_R_impuls_modulu_kart_1 : DFB_R_TRIG` (one
in a per-station program, one in an aggregating statistics program) produced
two *separate* local declarations with the *same name* — and whichever one's
`(CLK := ...)` call executed later in the scan cycle never saw a rising edge,
because the platform's edge-tracking state for that name had already been
updated earlier in the same scan by the other POU's call. The symptom was
silent: no compile error, just one POU's counters permanently frozen. The
same class of bug applies to plain coils — this project has a confirmed,
intentional dual-writer case (`Find and Replace` → **Look in: Current
Project** → **Find All** is the reliable way to check whether a name is
written by more than one POU before assuming a collision is a bug rather
than deliberate).

**Prefix generated FB instance names with something POU-specific** (e.g. a
short tag derived from the POU name) whenever the same underlying signal
might reasonably be edge-detected by more than one program — which, on this
platform, you cannot assume the compiler will catch for you.

### 4. A stray BOM mid-file silently breaks compilation

A UTF-8 BOM (`U+FEFF`) at byte 0 of a file is normal and harmless. The same
character sitting in the *middle* of the body — e.g. because a text
transform inserted new lines before it, or a paste round-tripped it through
the OS clipboard on Windows and it ended up preceding a `(* ... *)` comment
instead of the code's true beginning — has been observed to break
DIADesigner's comment recognition (the compiler faults with `Undefined
identifier`, `Invalid statement`, `Missing ;`, at a line number one or more
past where the actual character sits) even though the surrounding text looks
completely normal in the editor (the invisible character sometimes renders
as a garbled glyph like `_` or `ď»ż`, sometimes as nothing at all). After any
script-based text transformation that prepends or reorders content, grep the
result for a bare BOM byte sequence (`EF BB BF` in UTF-8) anywhere *other*
than offset 0, and strip it if found.

### 5. Check whether the LD original is still the one actually running

Some projects keep the pre-migration LD POU and its ST rewrite **both**
assigned to the same live PLC task, running every scan, side by side — the ST
version was added as a shadow copy for offline validation, not (yet) meant
to control anything, but nothing stops it from being wired into the task
list and writing the same output variables as the original. If it does, and
both compute the same correct result, this is invisible. If a bug is
introduced into the ST side (see Pitfall 3), the ST program's wrong output
silently overwrites the LD original's correct one, because it runs later in
the scan — with no compile error to flag it. Before editing an ST POU that
has an LD counterpart, check DIADesigner's **Task Manager** (Program
Organization) for both names, and if both are active, know that whichever
one comes *later* in the task's program list wins on every shared variable.

## Reference: the scripts

| Script | Input | Output | Purpose |
| --- | --- | --- | --- |
| `_parse_clip.js` | clipboard "Network" XML from an LD worksheet | ST source (stdout) | LD → ST translation |
| `edge_to_trig.js` | ST source | transformed ST + JSON summary | `EDGE_x` shadow bits → `DFB_R_TRIG`/`DFB_F_TRIG` |
| `gen_trig_csv.js` | `edge_to_trig.js`'s JSON summary (stdin) | CSV | variable-table CSV for the new FB instances |
| `bool_normalize.js` | (library, `canonicalizeExpr`) | — | canonicalizes a boolean/arithmetic expression for comparison |
| `compare_ld_st.js` | an "ideal" LD-derived reference + a folder of ST captures | JSON report + summary | flags statements whose guard/expression differs |
| `DiaMemoryReader.cs` / `.ps1` | a running DIADesigner process | POU/network data | backs the `read_program_memory` / `convert_ld_to_st` MCP tools |

Run any script with no arguments to print its usage.
