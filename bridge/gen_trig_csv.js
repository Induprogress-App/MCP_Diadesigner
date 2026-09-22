// Reads the JSON summary printed by edge_to_trig.js (stdin or a file) and writes
// the DIADesigner variable-table CSV (Class,Identifiers,Address,Type,Initial
// Value,Comment) for the new TRIG_* declarations. Pairs with Import CSV File in
// the local variable table's right-click menu.
//
// Usage: node edge_to_trig.js <input.st> <transformed.st> | node gen_trig_csv.js <output.csv>
// or:    node gen_trig_csv.js <output.csv> < result.json

const fs = require('fs');
const outputCsv = process.argv[2];
if (!outputCsv) {
  console.error('Usage: node edge_to_trig.js <in> <out> | node gen_trig_csv.js <output.csv>');
  process.exit(1);
}
let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  const r = JSON.parse(data);
  const lines = ['Class,Identifiers,Address,Type,Initial Value,Comment'];
  for (const d of r.declarations) lines.push(`VAR,${d.name},,${d.type},,`);
  fs.writeFileSync(outputCsv, lines.join('\r\n') + '\r\n', 'utf-8');
  console.error(`Wrote ${r.declarations.length} declarations to ${outputCsv}`);
  if (r.warnings.length) {
    console.error('WARNINGS:');
    for (const w of r.warnings) console.error('  ' + w);
  }
});
