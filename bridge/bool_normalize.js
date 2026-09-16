// Minimal ST boolean/arithmetic expression parser + canonicalizer, used to compare
// expressions for logical equivalence while ignoring redundant parentheses and
// AND/OR operand ordering (both commutative & associative here -- no side effects
// in these pure comparisons/arithmetic reads).
//
// Grammar (precedence low->high): Or -> And (OR And)* ; And -> Not (AND Not)* ;
// Not -> NOT? Cmp ; Cmp -> Add ((=|<>|>=|<=|>|<) Add)? ; Add -> Mul ((+|-) Mul)* ;
// Mul -> Atom ((*|/) Atom)* ; Atom -> '(' Or ')' | IDENT ('(' ArgList ')')? | NUMBER

function tokenize(s) {
  const toks = [];
  const re = /\s*(<>|>=|<=|:=|[()=><+\-*/,]|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?)/g;
  let m;
  let last = 0;
  while ((m = re.exec(s))) {
    if (m.index !== last) { /* skip stray */ }
    toks.push(m[1]);
    last = re.lastIndex;
  }
  return toks;
}

function parseExpr(tokens) {
  let pos = 0;
  function peek() { return tokens[pos]; }
  function next() { return tokens[pos++]; }
  function parseOr() {
    let node = parseAnd();
    const kids = [node];
    while (peek() && peek().toUpperCase() === 'OR') { next(); kids.push(parseAnd()); }
    return kids.length === 1 ? node : { type: 'OR', kids };
  }
  function parseAnd() {
    let node = parseNot();
    const kids = [node];
    while (peek() && peek().toUpperCase() === 'AND') { next(); kids.push(parseNot()); }
    return kids.length === 1 ? node : { type: 'AND', kids };
  }
  function parseNot() {
    if (peek() && peek().toUpperCase() === 'NOT') { next(); return { type: 'NOT', kid: parseNot() }; }
    return parseCmp();
  }
  function parseCmp() {
    let lhs = parseAdd();
    const op = peek();
    if (op && ['=', '<>', '>=', '<=', '>', '<'].includes(op)) {
      next();
      const rhs = parseAdd();
      return { type: 'CMP', op, lhs, rhs };
    }
    return lhs;
  }
  function parseAdd() {
    let node = parseMul();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      node = { type: 'BIN', op, lhs: node, rhs: parseMul() };
    }
    return node;
  }
  function parseMul() {
    let node = parseAtom();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      node = { type: 'BIN', op, lhs: node, rhs: parseAtom() };
    }
    return node;
  }
  function parseAtom() {
    if (peek() === '(') {
      next();
      const inner = parseOr();
      if (peek() === ')') next();
      return inner;
    }
    const t = next();
    if (t === undefined) return { type: 'ERR' };
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '(') {
        next();
        const args = [];
        if (peek() !== ')') {
          args.push(parseOr());
          while (peek() === ',') { next(); args.push(parseOr()); }
        }
        if (peek() === ')') next();
        return { type: 'CALL', name: t, args };
      }
      return { type: 'ID', name: t };
    }
    return { type: 'NUM', value: t };
  }
  const result = parseOr();
  return { result, consumed: pos, total: tokens.length };
}

function canon(node) {
  if (!node) return '';
  switch (node.type) {
    case 'ID': return node.name.toUpperCase();
    case 'NUM': return node.value;
    case 'ERR': return '<ERR>';
    case 'NOT': {
      const k = canon(node.kid);
      return `NOT(${k})`;
    }
    case 'CMP':
      return `CMP(${node.op},${canon(node.lhs)},${canon(node.rhs)})`;
    case 'BIN':
      return `${node.op}(${canon(node.lhs)},${canon(node.rhs)})`;
    case 'CALL':
      return `${node.name.toUpperCase()}(${node.args.map(canon).join(',')})`;
    case 'AND': {
      const parts = node.kids.map(canon).sort();
      return `AND[${parts.join('|')}]`;
    }
    case 'OR': {
      const parts = node.kids.map(canon).sort();
      return `OR[${parts.join('|')}]`;
    }
    default: return JSON.stringify(node);
  }
}

function canonicalizeExpr(exprText) {
  try {
    const tokens = tokenize(exprText);
    const { result, consumed, total } = parseExpr(tokens);
    if (consumed !== total) return { ok: false, reason: `trailing tokens: ${tokens.slice(consumed).join(' ')}`, raw: exprText };
    return { ok: true, canon: canon(result) };
  } catch (e) {
    return { ok: false, reason: e.message, raw: exprText };
  }
}

module.exports = { canonicalizeExpr };
