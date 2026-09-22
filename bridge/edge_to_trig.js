// Replace the manual EDGE_<x> shadow-bit pattern (see bridge/_parse_clip.js's
// comment on why it was used instead of a real R_TRIG/F_TRIG call) with a proper
// local DFB_R_TRIG / DFB_F_TRIG function-block instance per distinct edge-detected
// signal, called once at the top of the body and read via its .Q output wherever
// the shadow-bit condition previously appeared.
//
// Rising:  (X AND NOT EDGE_X)  ->  TRIG_R_X.Q   (+ declare TRIG_R_X : DFB_R_TRIG, call TRIG_R_X(CLK := X); at top)
// Falling: (NOT X AND EDGE_X)  ->  TRIG_F_X.Q   (+ declare TRIG_F_X : DFB_F_TRIG, call TRIG_F_X(CLK := X); at top)
//
// Also strips the trailing "(* edge-detection shadow bits... *)" comment and its
// EDGE_x := x; maintenance lines (no longer needed -- the FB instances track their
// own edge state), and reports which EDGE_x local variables can now be removed
// from the POU's variable table and which TRIG_* instances must be added instead.
//
// Usage: node edge_to_trig.js <input.st> [outputFile]
// Prints a JSON summary to stdout: { declarations: [{name,type}], removedEdgeVars: [...],
// callsInserted: [...], warnings: [...] }. Writes the transformed body to outputFile
// (default: <input>.transformed.st) for review before pasting into DIADesigner.

const fs = require('fs');
const path = require('path');

// IEC ST identifiers are case-insensitive (confirmed live in this project:
// "ALARM_st2" and "alARM_st2" are used interchangeably for the same variable
// in several POUs), but a generated FB instance name must use exactly ONE
// consistent casing everywhere it's declared and called, or DIADesigner sees
// two different identifiers that collide case-insensitively (a compile error)
// or -- worse -- two unrelated FB instances silently tracking the same signal.
// So matching is case-insensitive, but every match is re-cased to a single
// canonical spelling before it's used for a declaration or substitution.
const RISING_RE = /\(([A-Za-z_][A-Za-z0-9_]*) AND NOT EDGE_\1\)/gi;
const FALLING_RE = /\(NOT ([A-Za-z_][A-Za-z0-9_]*) AND EDGE_\1\)/gi;
const EDGE_ASSIGN_RE = /^\s*EDGE_([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([A-Za-z_][A-Za-z0-9_]*)\s*;\s*$/gm;

function transform(text) {
  const warnings = [];
  // canonical casing per signal, keyed by lowercase -- the "EDGE_x := y;"
  // maintenance footer is the authoritative source (it's written once,
  // mechanically, from the original clipboard-XML conversion), so prefer its
  // casing of y over whatever casing shows up at each individual usage site.
  const canonical = new Map();
  let m;
  EDGE_ASSIGN_RE.lastIndex = 0;
  while ((m = EDGE_ASSIGN_RE.exec(text))) canonical.set(m[2].toLowerCase(), m[2]);

  function canon(v) {
    const c = canonical.get(v.toLowerCase());
    if (c) return c;
    warnings.push(`No "EDGE_${v} := ${v};" maintenance line found to confirm canonical casing for "${v}" -- using the casing seen at first use; verify this is the same identifier as its declaration`);
    canonical.set(v.toLowerCase(), v);
    return v;
  }

  const risingVars = new Set();
  const fallingVars = new Set();
  RISING_RE.lastIndex = 0;
  while ((m = RISING_RE.exec(text))) risingVars.add(canon(m[1]));
  FALLING_RE.lastIndex = 0;
  while ((m = FALLING_RE.exec(text))) fallingVars.add(canon(m[1]));

  // A signal referenced by bare "EDGE_x" outside of one of the two recognized
  // patterns (e.g. a typo, or a shape this script doesn't know) must not be
  // silently mishandled -- surfaced as a warning instead of guessed at.
  const allEdgeRefs = new Set();
  const edgeRefRe = /EDGE_([A-Za-z_][A-Za-z0-9_]*)/gi;
  while ((m = edgeRefRe.exec(text))) allEdgeRefs.add(canon(m[1]));
  for (const v of allEdgeRefs) {
    if (!risingVars.has(v) && !fallingVars.has(v)) {
      warnings.push(`EDGE_${v} referenced but not in a recognized (X AND NOT EDGE_X) or (NOT X AND EDGE_X) shape -- left untouched, needs manual review`);
    }
  }

  let body = text.replace(RISING_RE, (whole, v) => `TRIG_R_${canon(v)}.Q`);
  body = body.replace(FALLING_RE, (whole, v) => `TRIG_F_${canon(v)}.Q`);

  // Strip the maintenance footer: the comment line + every "EDGE_x := x;" line
  // for a variable we've actually replaced above. Leaves alone (with a warning)
  // any EDGE_x := x; whose x wasn't recognized, so nothing is silently dropped.
  const handled = new Set([...risingVars, ...fallingVars]);
  const lines = body.split('\n');
  const keptLines = [];
  for (const line of lines) {
    const assign = /^\s*EDGE_([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*[A-Za-z_][A-Za-z0-9_]*\s*;\s*$/.exec(line);
    if (assign && handled.has(canon(assign[1]))) continue; // drop -- FB tracks its own state now
    if (/^\s*\(\*\s*edge-detection shadow bits/.test(line)) continue; // drop the header comment
    keptLines.push(line);
  }
  body = keptLines.join('\n').replace(/\n{3,}$/, '\n');

  // Insert the FB calls right after the leading "(* N networks ... *)" header
  // comment + blank line, if present; otherwise at the very top.
  const declarations = [];
  const callLines = [];
  for (const v of [...risingVars].sort()) { declarations.push({ name: `TRIG_R_${v}`, type: 'DFB_R_TRIG' }); callLines.push(`    TRIG_R_${v}(CLK := ${v});`); }
  for (const v of [...fallingVars].sort()) { declarations.push({ name: `TRIG_F_${v}`, type: 'DFB_F_TRIG' }); callLines.push(`    TRIG_F_${v}(CLK := ${v});`); }

  if (callLines.length > 0) {
    const headerMatch = /^(﻿?\(\*[^\n]*networks parsed from clipboard XML[^\n]*\*\)\n\n)/.exec(body);
    const insertion = callLines.join('\n') + '\n\n';
    if (headerMatch) {
      body = body.slice(0, headerMatch[0].length) + insertion + body.slice(headerMatch[0].length);
    } else {
      body = insertion + body;
    }
  }

  const removedEdgeVars = [...handled].sort().map((v) => `EDGE_${v}`);
  return { body, declarations, removedEdgeVars, warnings, risingCount: risingVars.size, fallingCount: fallingVars.size };
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node edge_to_trig.js <input.st> [outputFile]');
  process.exit(1);
}
const outputPath = process.argv[3] || inputPath.replace(/\.st$/i, '') + '.transformed.st';
const text = fs.readFileSync(inputPath, 'utf-8');
const result = transform(text);
fs.writeFileSync(outputPath, result.body, 'utf-8');
console.log(JSON.stringify({
  outputPath,
  declarations: result.declarations,
  removedEdgeVars: result.removedEdgeVars,
  warnings: result.warnings,
  risingCount: result.risingCount,
  fallingCount: result.fallingCount,
}, null, 2));
