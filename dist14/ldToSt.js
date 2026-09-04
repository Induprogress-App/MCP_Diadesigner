"use strict";
/**
 * LD -> ST reconstruction.
 *
 * Turns the flat network form read out of a running DIADesigner process
 * (IspProject.NetWorkData, surfaced by read_program_memory) into Structured
 * Text. Each network is one rung: a row of contacts feeding a coil.
 *
 *   - simple / series rungs (contact -> coil, SET/RST, rising/falling edges)
 *     reconstruct exactly;
 *   - rungs that carry a parallel branch (BranchData) are emitted best-effort
 *     with the contacts AND-combined and flagged for the user to verify the
 *     branch is really a series (AND) and not a parallel (OR);
 *   - rungs driven by a function block (timer / comparator) cannot be reduced
 *     to a boolean contact expression and are emitted as a commented note.
 *
 * This is intentionally the same logic proven against the MyjniaDIA test
 * project; keeping it in TypeScript means it can be iterated without
 * recompiling the ClrMD reader.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.networkToSt = networkToSt;
exports.buildStDocument = buildStDocument;
const BRANCH_TAG = "  (* siec z rownolegla galezia -- sprawdz AND/OR *)";
const PLACEHOLDER_COMMENT = "Enter comment here…";
function contactTerm(c) {
    let term = c.name;
    if (c.edge === "rising")
        term = `R_TRIG(${c.name})`;
    else if (c.edge === "falling")
        term = `F_TRIG(${c.name})`;
    if (c.negated)
        term = `NOT ${term}`;
    return term;
}
/** Converts one network to a Structured Text line (plus classification). */
function networkToSt(net) {
    const coil = net.elements.find((e) => e.kind === "coil" && e.name);
    if (!coil)
        return { st: "", category: "skipped" };
    const contacts = net.elements.filter((e) => e.kind === "contact" && e.name);
    const blocks = net.elements.filter((e) => e.kind === "block");
    const comment = net.comment && net.comment !== PLACEHOLDER_COMMENT ? `    (* ${net.comment} *)\n` : "";
    if (blocks.length > 0) {
        const blockDesc = blocks.map((b) => `${b.name}/api${b.api ?? "?"}`).join(", ");
        const inputs = contacts.map(contactTerm).join(", ") || "(none)";
        const note = `    (* NET zawiera blok funkcyjny: ${blockDesc} -- ZWERYFIKUJ *)\n` +
            `    (* wejscia: ${inputs} -> ${coil.name} *)`;
        return { st: comment + note, coil: coil.name, category: "block" };
    }
    const terms = contacts.map(contactTerm);
    const expr = terms.length === 0 ? "TRUE" : terms.length === 1 ? terms[0] : `(${terms.join(" AND ")})`;
    let rhs;
    if (coil.storage === "set")
        rhs = `IF ${expr} THEN ${coil.name} := TRUE; END_IF;`;
    else if (coil.storage === "reset")
        rhs = `IF ${expr} THEN ${coil.name} := FALSE; END_IF;`;
    else
        rhs = `${coil.name} := ${expr};`;
    const tag = net.branch ? BRANCH_TAG : "";
    return {
        st: `${comment}    ${rhs}${tag}`,
        coil: coil.name,
        category: net.branch ? "branch" : "exact"
    };
}
/** Assembles a full ST document from the networks read out of memory. */
function buildStDocument(networks, options = {}) {
    const re = options.coilPattern ? new RegExp(options.coilPattern, "i") : null;
    const pou = options.pouName || "CONVERTED_ST";
    const lines = [];
    const coils = [];
    const stats = { total: 0, exact: 0, branch: 0, block: 0, skipped: 0 };
    for (const net of networks) {
        const converted = networkToSt(net);
        if (converted.category === "skipped")
            continue;
        if (re && (!converted.coil || !re.test(converted.coil)))
            continue;
        stats.total++;
        stats[converted.category]++;
        if (converted.coil)
            coils.push(converted.coil);
        lines.push(converted.st);
    }
    const header = `(*==============================================================================\n` +
        `  ${pou} -- rekonstrukcja LD -> ST (odczyt z pamieci odszyfrowanego programu)\n` +
        `  Metoda: ClrMD read-only -> IspProject.NetWorkData -> ST.\n` +
        `  Sieci: ${stats.total} (dokladne=${stats.exact}, z galezia=${stats.branch}, z blokiem=${stats.block}).\n` +
        (re ? `  Filtr cewki: /${options.coilPattern}/i\n` : "") +
        `  Uwaga: sieci "z galezia" maja styki polaczone AND -- zweryfikuj AND/OR;\n` +
        `         sieci "z blokiem" (timer/komparator) sa oznaczone do uzupelnienia.\n` +
        `==============================================================================*)\n\n` +
        `PROGRAM ${pou}\nVAR\n    (* zmienne globalne projektu -- patrz tabela symboli *)\nEND_VAR\n\n`;
    const document = header + lines.join("\n") + "\n\nEND_PROGRAM\n";
    return { document, stats, coils };
}
