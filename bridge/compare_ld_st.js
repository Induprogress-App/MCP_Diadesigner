// Compare an "ideal" LD-derived ST reference (typically a whole-project dump from
// convert_ld_to_st) against one or more actually-committed ST POUs' captured text
// (e.g. via Ctrl+A/Ctrl+C on the ST worksheet -- see docs/diadesigner14.md,
// "Reliable way to read an ST POU's actual current source"), matched by the
// assignment target variable (coil name). Reports statements whose target appears
// in the ideal reference but whose guard/expression text differs, and targets
// present in one side but missing from the other.
//
// CAVEATS (see docs/diadesigner14.md for full detail) -- read before trusting output:
//   - convert_ld_to_st's flat, whole-project dump has no per-network POU tag, so if
//     the SAME coil name is written by more than one POU, this script's target->
//     statement map conflates them and can report a false mismatch. Cross-check any
//     flagged target with DIADesigner's own Find and Replace (Look in: Current
//     Project, Find All) before treating it as a real bug.
//   - The ideal dump is known to silently drop whole POUs' worth of networks for
//     some projects (root cause not isolated). A POU showing up entirely under
//     `missingInIdeal` is far more likely a dump gap than 100% of that POU being
//     wrong -- verify a sample by hand in DIADesigner before assuming otherwise.
//   - This is a starting point for a manual, in-DIADesigner audit, not a
//     substitute for one. Every genuine finding in this project's audit session
//     was confirmed by opening the LD network and reading it directly.
//
// Usage: node compare_ld_st.js <idealReferencePath> <dirOfActualStCaptures> [--glob <pattern>]
// Writes compare_report.json next to this script and prints a summary to stdout.

const fs = require('fs');
const path = require('path');

const [, , idealArg, dirArg] = process.argv;
if (!idealArg || !dirArg) {
  console.error('Usage: node compare_ld_st.js <idealReferencePath> <dirOfActualStCaptures>');
  process.exit(1);
}
const scratchDir = path.resolve(dirArg);
const idealPath = path.resolve(idealArg);

// Parse a .st text into a map: targetVar -> array of {raw, guard, rhs, isIf}
// Handles two shapes emitted by both the parser and convert_ld_to_st:
//   target := expr;
//   IF guard THEN\n    target := expr;\nEND_IF;   (also single-line "IF guard THEN target := expr; END_IF;")
function parseStatements(text) {
  // Normalize line endings, strip BOM
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const map = new Map();
  // Remove block comments (* ... *) including multi-line, but keep placeholders so
  // indices don't shift oddly -- simplest: strip them entirely.
  let noComments = text.replace(/\(\*[\s\S]*?\*\)/g, ' ');
  // A stripped comment that stood for a skip-worthy visual/layout element (e.g.
  // "RegionLogicCommandData", matching _parse_clip.js's treatment of
  // regionLogicCommand as visual-only) leaves a dangling AND/OR right before THEN,
  // or at the end of an expression -- clean that up so it doesn't look like a
  // missing term when the ACTUAL ST rightly has none.
  noComments = noComments
    .replace(/\b(AND|OR)\s+THEN\b/g, ' THEN')
    .replace(/\b(AND|OR)\s*;/g, ';')
    .replace(/\b(AND|OR)\s*\)/g, ')');

  // Split into candidate statement chunks: either a full IF...END_IF; block or a bare "x := y;"
  // We scan token by token using a simple regex-based approach since the grammar is small.
  let i = 0;
  const N = noComments.length;
  function skipWs() { while (i < N && /\s/.test(noComments[i])) i++; }

  function readUntilTopLevelSemicolon(start) {
    // reads forward balancing parens, returns index just after the terminating ';'
    let depth = 0;
    let j = start;
    while (j < N) {
      const c = noComments[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ';' && depth <= 0) return j + 1;
      j++;
    }
    return N;
  }

  while (i < N) {
    skipWs();
    if (i >= N) break;
    const rest = noComments.slice(i);
    const ifMatch = /^IF\b/.exec(rest);
    if (ifMatch) {
      // find matching THEN at top level, then matching END_IF; consuming nested IFs
      const thenIdx = rest.search(/\bTHEN\b/);
      if (thenIdx === -1) { i += 2; continue; }
      const guard = rest.slice(2, thenIdx).trim();
      // now walk forward counting IF/END_IF to find our END_IF
      let depth = 1;
      let k = thenIdx + 4; // past THEN
      let bodyStart = k;
      const ifRe = /\bIF\b/g;
      const endRe = /\bEND_IF\b/g;
      // simple scanning loop
      while (depth > 0 && k < rest.length) {
        const nextIf = rest.indexOf('IF', k);
        const nextEnd = rest.indexOf('END_IF', k);
        if (nextEnd === -1) { depth = 0; k = rest.length; break; }
        if (nextIf !== -1 && nextIf < nextEnd && /\bIF\b/.test(rest.substr(nextIf, 2))) {
          // could be a false positive inside identifiers; require word boundary
          const before = rest[nextIf - 1] || ' ';
          const after = rest[nextIf + 2] || ' ';
          if (/[^A-Za-z0-9_]/.test(before) && /[^A-Za-z0-9_]/.test(after)) {
            depth++;
            k = nextIf + 2;
            continue;
          } else {
            k = nextIf + 2;
            continue;
          }
        }
        depth--;
        k = nextEnd + 6;
      }
      const bodyEnd = rest.lastIndexOf('END_IF', k) === -1 ? k : rest.lastIndexOf('END_IF', k);
      let body = rest.slice(bodyStart, k - 6).trim();
      // Body may contain MULTIPLE statements (e.g. two assignments guarded by the
      // same IF) -- split on top-level ';' and register each as its own entry
      // under the same guard, rather than requiring the whole body to be one
      // assignment.
      let bi = 0, depth2 = 0, segStart = 0;
      const segments = [];
      while (bi < body.length) {
        const c = body[bi];
        if (c === '(') depth2++;
        else if (c === ')') depth2--;
        else if (c === ';' && depth2 <= 0) { segments.push(body.slice(segStart, bi + 1)); segStart = bi + 1; }
        bi++;
      }
      if (segStart < body.length && body.slice(segStart).trim()) segments.push(body.slice(segStart));
      let anyAssign = false;
      for (const seg of segments) {
        const simpleAssign = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([\s\S]*?);?\s*$/.exec(seg);
        if (simpleAssign) {
          anyAssign = true;
          const target = simpleAssign[1];
          const rhs = simpleAssign[2].trim();
          const entry = { raw: `IF ${guard} THEN ${seg.trim()} END_IF;`, guard, rhs, isIf: true };
          if (!map.has(target)) map.set(target, []);
          map.get(target).push(entry);
        }
      }
      if (!anyAssign) {
        const key = '__OPAQUE_IF__' + (map.size);
        map.set(key, [{ raw: rest.slice(0, k).trim(), guard, rhs: body, isIf: true }]);
      }
      i += k;
      continue;
    }
    // bare assignment "target := expr;" or a call "NAME(args);" (statement call, e.g. TMR(...))
    const bareMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*/.exec(rest);
    if (bareMatch) {
      const end = readUntilTopLevelSemicolon(i);
      const stmtText = noComments.slice(i, end);
      const m2 = /^([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([\s\S]*?);\s*$/.exec(stmtText.trim());
      if (m2) {
        const target = m2[1];
        const rhs = m2[2].trim();
        if (!map.has(target)) map.set(target, []);
        map.get(target).push({ raw: stmtText.trim(), guard: null, rhs, isIf: false });
      }
      i = end;
      continue;
    }
    const callMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(rest);
    if (callMatch) {
      const end = readUntilTopLevelSemicolon(i);
      i = end; // skip bare calls entirely -- not a target assignment
      continue;
    }
    // Unrecognized token -- advance by one char to avoid infinite loop
    i++;
  }
  return map;
}

const { canonicalizeExpr } = require('./bool_normalize');

function normalizeExpr(s) {
  const r = canonicalizeExpr(s);
  if (r.ok) return r.canon;
  // fall back to crude text normalization, tagged so we know it wasn't parsed
  return 'RAW::' + s.replace(/\s+/g, ' ').trim().toUpperCase();
}

const idealText = fs.readFileSync(idealPath, 'utf-8');
const idealMap = parseStatements(idealText);

const files = fs
  .readdirSync(scratchDir)
  .filter((f) => f.toLowerCase().endsWith('.st') && path.resolve(scratchDir, f) !== idealPath);

const report = [];
for (const file of files) {
  const pouName = file.replace(/\.st$/i, '');
  const actualText = fs.readFileSync(path.join(scratchDir, file), 'utf-8');
  const actualMap = parseStatements(actualText);
  const pouReport = { pou: file, mismatches: [], missingInIdeal: [], onlyOneStatementSet: [] };

  for (const [target, actualEntries] of actualMap) {
    if (target.startsWith('__OPAQUE_IF__')) continue;
    const idealEntries = idealMap.get(target);
    if (!idealEntries) {
      pouReport.missingInIdeal.push(target);
      continue;
    }
    // Compare normalized rhs+guard sets (order-insensitive, since multiple legs can target same var)
    const combo = (e) => normalizeExpr(e.guard || 'TRUE') + ' ==> ' + normalizeExpr(e.rhs);
    const actualNorm = actualEntries.map(combo);
    const idealNorm = idealEntries.map(combo);
    const actualSet = new Set(actualNorm);
    const idealSet = new Set(idealNorm);
    let same = actualSet.size === idealSet.size;
    if (same) {
      for (const v of actualSet) if (!idealSet.has(v)) { same = false; break; }
    }
    if (!same) {
      pouReport.mismatches.push({
        target,
        actual: actualEntries.map((e) => e.raw),
        ideal: idealEntries.map((e) => e.raw),
      });
    }
  }
  if (pouReport.mismatches.length || pouReport.missingInIdeal.length) {
    report.push(pouReport);
  }
}

const reportPath = path.join(__dirname, 'compare_report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`Report written to ${reportPath}`);
console.log(`Compared ${files.length} POU files against ideal reference (${idealMap.size} ideal targets).`);
console.log(`POUs with at least one flagged difference: ${report.length}`);
for (const r of report) {
  console.log(`\n=== ${r.pou} ===`);
  console.log(`  mismatches: ${r.mismatches.length}, missingInIdeal: ${r.missingInIdeal.length}`);
}
