"use strict";
/**
 * LD -> ST reconstruction.
 *
 * Turns the network tree read out of a running DIADesigner process
 * (IspProject.NetWorkData, surfaced by read_program_memory) into Structured
 * Text. Each network is one rung: a `terms` AND-chain feeding a coil, where
 * a term can itself be an `or` of AND-chains (a parallel branch) or a
 * `compare` (a "=" / "<>" / relational function-block instance -- DIADesigner
 * resolves these against a nested InVariablesMacro, not a flat contact list).
 *
 * DiaMemoryReader.cs walks the real grid (BranchData rows = OR alternatives,
 * columns within a row = AND) instead of collapsing everything it doesn't
 * recognize into a flat AND chain, so the expression built here matches what
 * DIADesigner's own Ladder editor draws -- including nested branches and
 * comparator blocks, not just simple series contacts. Anything the reader
 * still can't resolve comes through as an explicit `unknown` term with a
 * description, so it surfaces as a visible TODO in the generated ST instead
 * of silently vanishing.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.networkToSt = networkToSt;
exports.buildStDocument = buildStDocument;
const PLACEHOLDER_COMMENT = "Enter comment here…";
function edgeWrap(varName, edge) {
    if (edge === "rising")
        return `R_TRIG(${varName})`;
    if (edge === "falling")
        return `F_TRIG(${varName})`;
    return varName;
}
/** True if this term (or anything nested in it) is an `unknown` we couldn't resolve. */
function hasUnknown(term) {
    if (term.t === "unknown")
        return true;
    if (term.t === "or")
        return term.rows.some((row) => row.some(hasUnknown));
    return false;
}
function termToSt(term) {
    switch (term.t) {
        case "contact": {
            const base = edgeWrap(term.var, term.edge);
            return term.negated ? `NOT ${base}` : base;
        }
        case "compare":
            return `(${term.lhs} ${term.op} ${term.rhs})`;
        case "or": {
            const rowExprs = term.rows.map((row) => andChain(row)).filter((s) => s.length > 0);
            if (rowExprs.length === 0)
                return "TRUE";
            if (rowExprs.length === 1)
                return rowExprs[0];
            return `(${rowExprs.join(" OR ")})`;
        }
        case "unknown":
            return `(* UNRESOLVED: ${term.desc.replace(/\*\)/g, ")")} *)`;
    }
}
function andChain(terms) {
    const parts = terms.map(termToSt).filter((s) => s.length > 0);
    if (parts.length === 0)
        return "";
    if (parts.length === 1)
        return parts[0];
    return parts.join(" AND ");
}
/** Converts one network to a Structured Text assignment (plus classification). */
function networkToSt(net) {
    if (!net.coil)
        return { st: "", category: "skipped" };
    const unresolved = net.terms.some(hasUnknown);
    const comment = net.comment && net.comment !== PLACEHOLDER_COMMENT ? `    (* ${net.comment} *)\n` : "";
    const expr = net.terms.length === 0 ? "TRUE" : andChain(net.terms);
    let rhs;
    if (net.storage === "set")
        rhs = `IF ${expr} THEN ${net.coil} := TRUE; END_IF;`;
    else if (net.storage === "reset")
        rhs = `IF ${expr} THEN ${net.coil} := FALSE; END_IF;`;
    else
        rhs = `${net.coil} := ${expr};`;
    return {
        st: `${comment}    ${rhs}`,
        coil: net.coil,
        category: unresolved ? "unresolved" : "ok"
    };
}
/** Assembles a full ST document from the networks read out of memory. */
function buildStDocument(networks, options = {}) {
    const re = options.coilPattern ? new RegExp(options.coilPattern, "i") : null;
    const pou = options.pouName || "CONVERTED_ST";
    const lines = [];
    const coils = [];
    const stats = { total: 0, ok: 0, unresolved: 0, skipped: 0 };
    // ClrMD sometimes walks two live copies of the same rung (e.g. an editor's
    // working buffer alongside the saved one); keep only the first occurrence
    // per coil so the generated POU doesn't assign the same variable twice.
    const seenCoils = new Set();
    for (const net of networks) {
        const converted = networkToSt(net);
        if (converted.category === "skipped")
            continue;
        if (re && (!converted.coil || !re.test(converted.coil)))
            continue;
        if (converted.coil) {
            if (seenCoils.has(converted.coil))
                continue;
            seenCoils.add(converted.coil);
        }
        stats.total++;
        stats[converted.category]++;
        if (converted.coil)
            coils.push(converted.coil);
        lines.push(converted.st);
    }
    const header = `(*==============================================================================\n` +
        `  ${pou} -- rekonstrukcja LD -> ST (odczyt z pamieci odszyfrowanego programu)\n` +
        `  Metoda: ClrMD read-only -> IspProject.NetWorkData grid (rows=OR, columns=AND,\n` +
        `  nested "fb" branches = compare blocks) -> ST.\n` +
        `  Sieci: ${stats.total} (ok=${stats.ok}, niezweryfikowane=${stats.unresolved}).\n` +
        (re ? `  Filtr cewki: /${options.coilPattern}/i\n` : "") +
        (stats.unresolved > 0
            ? `  UWAGA: ${stats.unresolved} siec(i) zawiera fragmenty oznaczone "UNRESOLVED" --\n` +
                `         DiaMemoryReader nie rozpoznal elementu (np. blok API biblioteki, nie\n` +
                `         prosty komparator). Zweryfikuj je recznie w DIADesignerze.\n`
            : "") +
        `==============================================================================*)\n\n` +
        `PROGRAM ${pou}\nVAR\n    (* zmienne globalne projektu -- patrz tabela symboli *)\nEND_VAR\n\n`;
    const document = header + lines.join("\n") + "\n\nEND_PROGRAM\n";
    return { document, stats, coils };
}
