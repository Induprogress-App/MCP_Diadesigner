// Standalone prototype: parse DIADesigner's clipboard "Network" XML format
// (Ctrl+A / Ctrl+C in the Ladder editor) into Structured Text.
//
// Schema notes (reverse-engineered from a real export):
//   <LD><ldNetwork comment=... executionOrderId=...>
//     <rootLink> ...terms... </rootLink>   -- the rung's condition (AND-of-OR)
//     <outLink> ...terms/actions... </outLink>  -- one or more guarded actions
//   </ldNetwork>...
//
// Within rootLink/outLink, elements appear as a flat sequence:
//   <contact negated edge><variable>X</variable></contact>  -- one term
//   <verticalLine/>                                          -- OR-separator between AND-groups
//   <marco type="normal|fb|mps" .../>                        -- visual-only, no data, ignore
//   <inVariablesMarco><inVariable><expression>E</expression></inVariable>...</inVariablesMarco>
//   <block typeName="=|<>|>|<|>=|<=|+|-|*|/|MOV|..." />
//   <outVariablesMarco><outVariable><expression>E</expression></outVariable></outVariablesMarco>
//     -- together: one function-block term. Compare ops -> boolean term (lhs OP rhs).
//        Non-compare ops (arithmetic, MOV) -> an assignment action, guarded by
//        whatever contacts preceded it since the last leg boundary.
//   <coil storage="none|set|reset"><variable>X</variable></coil>
//     -- ends the current leg: emit X := guard; (or IF guard THEN X:=TRUE/FALSE for set/reset)

const fs = require('fs');

function stripXmlDecl(s) { return s.replace(/^﻿?<\?xml[^>]*\?>\s*/, ''); }

// Minimal streaming tag tokenizer -- good enough for this well-formed, regular document.
function tokenize(xml) {
  const tokens = [];
  const re = /<(\/?)([a-zA-Z_][\w:.]*)((?:\s+[a-zA-Z_][\w:.-]*="(?:[^"\\]|\\.)*")*)\s*(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[5] !== undefined) { tokens.push({ type: 'cdata', text: m[5] }); continue; }
    if (m[6] !== undefined) { if (m[6].trim()) tokens.push({ type: 'text', text: m[6] }); continue; }
    const closing = m[1] === '/';
    const name = m[2];
    const attrStr = m[3] || '';
    const selfClose = m[4] === '/';
    if (closing) { tokens.push({ type: 'close', name }); continue; }
    const attrs = {};
    const attrRe = /([a-zA-Z_][\w:.-]*)="((?:[^"\\]|\\.)*)"/g;
    let am;
    while ((am = attrRe.exec(attrStr))) {
      attrs[am[1]] = am[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    }
    tokens.push({ type: selfClose ? 'selfclose' : 'open', name, attrs });
  }
  return tokens;
}

// Build a simple tree: {name, attrs, children:[...], text}
function buildTree(tokens) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  for (const t of tokens) {
    const top = stack[stack.length - 1];
    if (t.type === 'open') {
      const node = { name: t.name, attrs: t.attrs, children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (t.type === 'selfclose') {
      top.children.push({ name: t.name, attrs: t.attrs, children: [] });
    } else if (t.type === 'close') {
      stack.pop();
    } else if (t.type === 'cdata' || t.type === 'text') {
      top.children.push({ name: '#text', text: t.text, children: [] });
    }
  }
  return root;
}

function textOf(node) {
  return (node.children || []).filter((c) => c.name === '#text').map((c) => c.text).join('');
}
function child(node, name) {
  return (node.children || []).find((c) => c.name === name);
}
function children(node, name) {
  return (node.children || []).filter((c) => c.name === name);
}

const COMPARE_OPS = new Set(['=', '<>', '>', '<', '>=', '<=']);

// Signals that need an EDGE_<name> shadow bit, collected across the whole
// document so one `EDGE_X := X;` update per distinct signal is emitted once,
// at the very end of the POU body (see main loop below). Delta's ST compiler
// rejects both bare `R_TRIG(x)`/`F_TRIG(x)` calls and inline `VAR ... END_VAR`
// FB-instance declarations in the body text, so edges are reproduced with a
// manual auxiliary-bit pattern instead: rising = "(X AND NOT EDGE_X)",
// falling = "(NOT X AND EDGE_X)", with EDGE_X updated to X after all rungs
// that read it have executed for this scan.
const edgeVars = new Set();

function contactTerm(c) {
  const varName = textOf(child(c, 'variable')).trim();
  const negated = c.attrs.negated === 'true';
  const edge = c.attrs.edge;
  let base = varName;
  if (edge === 'rising' || edge === 'falling') {
    edgeVars.add(varName);
    base = edge === 'rising'
      ? `(${varName} AND NOT EDGE_${varName})`
      : `(NOT ${varName} AND EDGE_${varName})`;
  }
  return negated ? `NOT ${base}` : base;
}

// Groups a flat element sequence into OR-of-AND using <verticalLine/> as the separator.
// Returns {expr, i} where i is the index just past the consumed run (stops at a <coil>,
// or at end of the parent, or -- for outLink parsing -- lets the caller decide leg boundaries).
//
// Some genuine parallel-branch (OR) grids carry NO <verticalLine/> separators at all --
// instead the whole link ends with a <marco type="normal" columnCount="N" rowCount="M" .../>
// summarizing the grid shape. A grid with rowCount==1 is just a plain single-row
// AND-series (confirmed on a real network: "PRACA_ST1 AND alarm-rising-edge",
// columnCount=2 rowCount=1 -- genuinely AND, not two branches) and is left untouched.
// A grid with rowCount>1 DOES hold real parallel branches, but the row/column
// bookkeeping isn't fully understood yet -- a first attempt at inferring OR-groups
// from columnCount and contact-boundaries produced a *plausible-looking* result for
// a 7-day-of-week check (promocje/PROMOCJA_ZAL) that can't actually be confirmed
// without seeing the source Ladder diagram, and that same heuristic silently
// mis-guessed AND-as-OR on other, already-verified-correct networks when re-run
// broadly. Guessing AND/OR structure is exactly the class of bug this whole
// conversion effort exists to avoid, so a rowCount>1 grid without a verticalLine is
// now always flagged UNRESOLVED for manual review against the real diagram instead
// of auto-partitioned.
function parseCondition(elems, start, stopNames) {
  const rows = [];
  let group = [];
  let gridColumnCount = null;
  let gridRowCount = null;
  let i = start;
  for (; i < elems.length; i++) {
    const e = elems[i];
    if (stopNames.has(e.name)) break;
    if (e.name === 'verticalLine') { rows.push(group); group = []; continue; }
    if (e.name === 'marco') {
      if (e.attrs.type === 'normal' && e.attrs.columnCount) {
        gridColumnCount = parseInt(e.attrs.columnCount, 10);
        gridRowCount = parseInt(e.attrs.rowCount, 10);
      }
      continue; // visual/layout only, otherwise
    }
    if (e.name === 'emptyObject' || e.name === 'regionLogicCommand' || e.name === 'label') { continue; } // visual/layout only
    if (e.name === 'contact') { group.push(contactTerm(e)); continue; }
    if (e.name === 'inVariablesMarco') {
      // consume inVariablesMarco, block, outVariablesMarco as one compare/compute term
      const inMacro = e;
      const block = elems[i + 1] && elems[i + 1].name === 'block' ? elems[i + 1] : null;
      const outMacro = elems[i + 2] && elems[i + 2].name === 'outVariablesMarco' ? elems[i + 2] : null;
      if (block) {
        const op = block.attrs.typeName;
        const ins = children(inMacro, 'inVariable').map((iv) => textOf(child(iv, 'expression')).trim());
        if (COMPARE_OPS.has(op) && ins.length === 2) {
          group.push(`(${ins[0]} ${op} ${ins[1]})`);
          i += 2; // skip block + outVariablesMarco (outVariablesMarco is empty/irrelevant for a compare)
          continue;
        } else {
          group.push(`/* UNRESOLVED COMPARE-CONTEXT BLOCK ${op}(${ins.join(', ')}) */`);
          i += outMacro ? 2 : 1;
          continue;
        }
      }
    }
    // Unknown element inside a condition -- surface it, don't drop it.
    group.push(`/* UNRESOLVED COND ELEMENT <${e.name}> */`);
  }
  rows.push(group);
  // No <verticalLine/> ever split this into rows (rows.length === 1). If the trailing
  // grid marco says rowCount>1, this flat sequence actually hides real parallel
  // branches we can't safely reconstruct -- flag it rather than guess (see comment
  // above parseCondition). rowCount==1 is a plain AND-series; leave it as-is.
  if (rows.length === 1 && gridRowCount && gridRowCount > 1) {
    rows[0] = [`/* UNRESOLVED GRID: columnCount=${gridColumnCount} rowCount=${gridRowCount} with no <verticalLine/> -- AND/OR structure not auto-derivable, verify against the source Ladder diagram: ${rows[0].join(' | ')} */`];
  }
  const rowExprs = rows.map((g) => g.join(' AND ')).filter((s) => s.length > 0);
  let expr;
  if (rowExprs.length === 0) expr = null;
  else if (rowExprs.length === 1) expr = rowExprs[0];
  else expr = '(' + rowExprs.join(' OR ') + ')';
  return { expr, next: i };
}

// A different grid shape from parseCondition's OR-grid: an outLink with several
// independent <coil>s sharing one rootLink is a genuine "MPS" (multiple parallel
// split) rung -- a shared AND-prefix feeds N *independent* legs, each pairing one
// term with its own dedicated coil (NOT all N terms ANDed into every coil, and NOT
// ORed into one coil). Confirmed on a real network (alarmy/CZAS_PRACY_POMPY_ST1..6):
// one shared "NOT <reset flag>" contact, then 6 independent "godziny_pracy_stN > 400"
// terms, each driving its own station's coil -- i.e. each station's own overdue-
// maintenance flag depends only on that station's own hours, not all 6 combined.
// Returns null (never a guess) if the shape doesn't cleanly match legCount.
function splitSharedRootIntoLegs(rootElems, legCount) {
  const flat = [];
  const boundaries = [];
  let gridColumnCount = null;
  for (let i = 0; i < rootElems.length; i++) {
    const e = rootElems[i];
    if (e.name === 'verticalLine') return null; // a real OR-row split -- not this shape
    if (e.name === 'marco') {
      if (e.attrs.type === 'normal' && e.attrs.columnCount) gridColumnCount = parseInt(e.attrs.columnCount, 10);
      continue;
    }
    if (e.name === 'emptyObject' || e.name === 'regionLogicCommand' || e.name === 'label') continue;
    // Each contact or compare-tuple is a candidate new-leg boundary -- not just
    // contacts. A leg here can be a bare contact ("NOT reset_flag") or a whole
    // compare-block ("godziny_pracy_stN > 400"), and both start fresh legs.
    if (e.name === 'contact') { boundaries.push(flat.length); flat.push(contactTerm(e)); continue; }
    if (e.name === 'inVariablesMarco') {
      const block = rootElems[i + 1] && rootElems[i + 1].name === 'block' ? rootElems[i + 1] : null;
      if (block) {
        const op = block.attrs.typeName;
        const ins = children(e, 'inVariable').map((iv) => textOf(child(iv, 'expression')).trim());
        if (COMPARE_OPS.has(op) && ins.length === 2) {
          boundaries.push(flat.length);
          flat.push(`(${ins[0]} ${op} ${ins[1]})`);
          i += 2;
          continue;
        }
      }
      return null;
    }
    return null; // unrecognized element -- don't guess at this shape
  }
  const prefixCount = boundaries.length - legCount;
  if (prefixCount < 0 || boundaries[0] !== 0 || gridColumnCount !== legCount) return null;
  const legBoundaries = boundaries.slice(prefixCount);
  const prefix = flat.slice(0, legBoundaries[0]);
  const legs = legBoundaries.map((startIdx, bi) => {
    const endIdx = bi + 1 < legBoundaries.length ? legBoundaries[bi + 1] : flat.length;
    return flat.slice(startIdx, endIdx).join(' AND ');
  });
  return { prefix, legs };
}

function parseNetwork(net) {
  const executionOrderId = net.attrs.executionOrderId;
  const commentNode = child(net, 'comment');
  const comment = commentNode ? textOf(child(commentNode, 'content')).trim() : '';
  const rootLink = child(net, 'rootLink');
  const outLink = child(net, 'outLink');
  const rootElems = rootLink ? rootLink.children.filter((c) => c.name !== '#text') : [];
  const outElems = outLink ? outLink.children.filter((c) => c.name !== '#text') : [];

  // MPS check: an outLink that is purely N>1 coils (plus visual-only marco/emptyObject
  // noise) is a candidate multi-parallel-split rung -- see splitSharedRootIntoLegs.
  const outCoils = outElems.filter((e) => e.name === 'coil');
  const outIsPureCoilList = outCoils.length > 1 &&
    outElems.every((e) => e.name === 'coil' || e.name === 'marco' || e.name === 'emptyObject' || e.name === 'regionLogicCommand' || e.name === 'label');
  if (outIsPureCoilList) {
    const split = splitSharedRootIntoLegs(rootElems, outCoils.length);
    if (split) {
      const prefixStr = split.prefix.length ? split.prefix.join(' AND ') + ' AND ' : '';
      const statements = outCoils.map((coilEl, idx) => ({
        kind: 'coil',
        varName: textOf(child(coilEl, 'variable')).trim(),
        storage: coilEl.attrs.storage || 'none',
        guard: prefixStr + split.legs[idx],
      }));
      return { executionOrderId, comment, statements };
    }
    // Couldn't confidently split -- fall through to the normal single-guard path
    // below, which will flag an UNRESOLVED GRID rather than silently guess.
  }

  const condResult = parseCondition(rootElems, 0, new Set());
  const guardBase = condResult.expr; // null if rootLink is empty (unconditional)

  // Walk outLink, splitting into legs at each <coil> or compute-block boundary.
  const statements = [];
  let i = 0;
  let legGuardExtra = []; // extra AND-terms accumulated since last leg boundary (guard contacts local to outLink)
  let legRiskyGrid = null; // set if a rowCount>1 grid marco appears in this leg -- see parseCondition's comment
  while (i < outElems.length) {
    const e = outElems[i];
    if (e.name === 'marco') {
      if (e.attrs.type === 'normal' && e.attrs.rowCount && parseInt(e.attrs.rowCount, 10) > 1) {
        legRiskyGrid = `columnCount=${e.attrs.columnCount} rowCount=${e.attrs.rowCount}`;
      }
      i++;
      continue; // otherwise visual/layout only
    }
    if (e.name === 'emptyObject' || e.name === 'regionLogicCommand' || e.name === 'label') { i++; continue; } // visual/layout only
    if (e.name === 'verticalLine') { i++; continue; } // rare in outLink; ignore defensively
    if (e.name === 'contact') {
      legGuardExtra.push(contactTerm(e));
      i++;
      continue;
    }
    if (e.name === 'coil') {
      const varName = textOf(child(e, 'variable')).trim();
      const storage = e.attrs.storage || 'none';
      let guardParts = [guardBase, legGuardExtra.length ? legGuardExtra.join(' AND ') : null].filter(Boolean);
      let guard = guardParts.length ? guardParts.join(' AND ') : 'TRUE';
      if (legRiskyGrid) {
        guard = `/* UNRESOLVED GRID in outLink leg: ${legRiskyGrid} -- AND/OR structure not auto-derivable, verify against the source Ladder diagram: ${guard} */`;
      }
      statements.push({ kind: 'coil', varName, storage, guard });
      legGuardExtra = [];
      legRiskyGrid = null;
      i++;
      continue;
    }
    if (e.name === 'inVariablesMarco') {
      const inMacro = e;
      const block = outElems[i + 1] && outElems[i + 1].name === 'block' ? outElems[i + 1] : null;
      const outMacro = outElems[i + 2] && outElems[i + 2].name === 'outVariablesMarco' ? outElems[i + 2] : null;
      if (block) {
        const op = block.attrs.typeName;
        const ins = children(inMacro, 'inVariable').map((iv) => textOf(child(iv, 'expression')).trim());
        const outs = outMacro ? children(outMacro, 'outVariable').map((ov) => textOf(child(ov, 'expression')).trim()) : [];
        // A compare block with no output acts as a contact (a boolean gate for what
        // follows in this leg), same as in rootLink -- not a value-producing statement.
        if (COMPARE_OPS.has(op) && ins.length === 2 && outs.length === 0) {
          legGuardExtra.push(`(${ins[0]} ${op} ${ins[1]})`);
          i += outMacro ? 3 : 2;
          continue;
        }
        const guardParts = [guardBase, legGuardExtra.length ? legGuardExtra.join(' AND ') : null].filter(Boolean);
        const guard = guardParts.length ? guardParts.join(' AND ') : null;
        statements.push({ kind: 'compute', op, ins, outs, guard });
        legGuardExtra = [];
        i += outMacro ? 3 : 2;
        continue;
      }
    }
    // Unknown element in outLink.
    statements.push({ kind: 'unknown', desc: `<${e.name}>` });
    i++;
  }

  return { executionOrderId, comment, statements };
}

function computeExpr(op, ins) {
  // F+/F-/F*/F// are Delta's float-typed arithmetic mnemonics; ST's arithmetic
  // operators are polymorphic over numeric types (including REAL), so they map to
  // the same plain operators as the integer forms -- and must, since "F-" etc. isn't
  // a legal ST identifier and would break parsing if emitted as a function call.
  if (op === '+' || op === 'F+') return ins.join(' + ');
  if (op === '-' || op === 'F-') return ins.join(' - ');
  if (op === '*' || op === 'MUL16' || op === 'MUL' || op === 'F*') return ins.join(' * ');
  if (op === '/' || op === 'DIV16' || op === 'DIV' || op === 'F/') return ins.join(' / ');
  if (op === 'MOV' || op === 'DMOV') return ins[0];
  return null;
}

function statementToSt(s) {
  if (s.kind === 'coil') {
    if (s.storage === 'set') return s.guard === 'TRUE' ? `${s.varName} := TRUE;` : `IF ${s.guard} THEN ${s.varName} := TRUE; END_IF;`;
    if (s.storage === 'reset') return s.guard === 'TRUE' ? `${s.varName} := FALSE;` : `IF ${s.guard} THEN ${s.varName} := FALSE; END_IF;`;
    return `${s.varName} := ${s.guard};`;
  }
  if (s.kind === 'compute') {
    const target = s.outs[0];
    const expr = computeExpr(s.op, s.ins);
    if (target && expr !== null) {
      const assign = `${target} := ${expr};`;
      return s.guard ? `IF ${s.guard} THEN ${assign} END_IF;` : assign;
    }
    // Unmapped Delta API instruction (timers, counters, type conversions, custom FB
    // instances, ...). If it has exactly one output, treat it as a function -- e.g.
    // F+/F-/F*/F// (float arithmetic) follow this shape -- and assign the result;
    // dropping the output here would silently discard the computed value entirely,
    // which is worse than an unverified call syntax. Multi-/zero-output instructions
    // (TMR, DMOV, counters, ...) are emitted as a direct call using the block's own
    // typeName instead. Either way this is unverified against Delta's ST compiler,
    // so it's flagged for a Check() pass.
    //
    // FLT/INT (Delta's int<->float conversion mnemonics) are special-cased to a
    // plain assignment, no function call at all. Confirmed live, in this order:
    // (1) bare "INT(...)" is a hard syntax error -- INT is the IEC-reserved type
    // keyword, not an identifier; (2) the IEC-standard names INT_TO_REAL/REAL_TO_INT
    // aren't recognized either -- DIADesigner treated them as undeclared
    // identifiers and prompted to declare them as POU variables, meaning this
    // compiler has no such built-in function under either name. A plain `:=`
    // between INT and REAL variables relies on this ST compiler doing implicit
    // numeric conversion on assignment, which is common in less strictly
    // IEC-conformant industrial ST dialects -- unverified, hence still flagged.
    let call;
    if (s.op === 'FLT' || s.op === 'INT') {
      call = s.outs.length === 1 ? `${s.outs[0]} := ${s.ins[0]};` : `${s.ins[0]};`;
    } else if (s.outs.length === 1) {
      call = `${s.outs[0]} := ${s.op}(${s.ins.join(', ')});`;
    } else {
      call = `${s.op}(${s.ins.join(', ')});`;
    }
    const body = s.guard ? `IF ${s.guard} THEN ${call} END_IF;` : call;
    return `${body} (* VERIFY: Delta API instruction "${s.op}", outs=[${s.outs.join(', ')}] -- confirm ST call syntax *)`;
  }
  return `(* UNRESOLVED STATEMENT: ${s.desc} *)`;
}

// ---- main ----
const file = process.argv[2];
const xml = stripXmlDecl(fs.readFileSync(file, 'utf-8'));
const tree = buildTree(tokenize(xml));
const ldRoot = child(tree, 'LD');
const networks = children(ldRoot, 'ldNetwork');

console.log(`(* ${networks.length} networks parsed from clipboard XML *)\n`);
let unresolvedCount = 0;
for (const net of networks) {
  const { comment, statements } = parseNetwork(net);
  if (comment && comment !== 'Enter comment here…') console.log(`    (* ${comment.replace(/\n/g, ' ')} *)`);
  for (const s of statements) {
    const line = statementToSt(s);
    if (line.includes('UNRESOLVED')) unresolvedCount++;
    console.log('    ' + line);
  }
}
if (edgeVars.size > 0) {
  console.log('\n    (* edge-detection shadow bits: update after all rungs above have read them this scan *)');
  for (const v of [...edgeVars].sort()) {
    console.log(`    EDGE_${v} := ${v};`);
  }
}
console.error(`\n[stats] networks=${networks.length} unresolvedLines=${unresolvedCount} edgeVars=${edgeVars.size}`);
