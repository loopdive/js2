// RESEARCH STAND-IN (never committed): (a) a top-level function declaration read as a value becomes `F$fv`, one
// function-expression wrapper per declaration created before the first statement; (b) a static own property
// `F.p` of such a declaration becomes the script var `F$$p` (and `F.prototype.q` becomes `F$$prototype$$q`).
// Line numbers are preserved: wrappers go at the start of `firstLine`, slot `var`s on a new last line.
import ts from "typescript";
const KEEP_MEMBER = new Set(["length", "name", "call", "apply", "bind", "toString", "constructor", "hasOwnProperty"]);
const SLOTS_ON = process.env.FN_STANDIN_SLOTS !== "0";
const C1_ON = process.env.FN_STANDIN_C1 === "1";
export function rewriteFunctionValues(source, firstLine) {
  const sf = ts.createSourceFile("t.js", source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
  const decls = new Map();
  for (const s of sf.statements) if (ts.isFunctionDeclaration(s) && s.name && s.body) decls.set(s.name.text, s);
  const edits = [];
  const wrappers = new Set();
  const slots = new Set();
  const declared = (scope, name) => scope.some((set) => set.has(name));
  const scopeNames = (fn) => {
    const names = new Set(fn.parameters.flatMap((p) => (ts.isIdentifier(p.name) ? [p.name.text] : [])));
    if (fn.name && !ts.isFunctionDeclaration(fn)) names.add(fn.name.text);
    const walk = (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) names.add(n.name.text);
      if (ts.isFunctionDeclaration(n) && n.name) {
        names.add(n.name.text);
        return;
      }
      if (ts.isFunctionLike(n)) return;
      ts.forEachChild(n, walk);
    };
    if (fn.body) ts.forEachChild(fn.body, walk);
    return names;
  };
  const value = (n, name) => {
    wrappers.add(name);
    edits.push([n.getStart(sf), n.end, `${name}$fv`]);
  };
  const visit = (n, scope) => {
    // C1 STAND-IN (FN_STANDIN_C1=1): `Test262Error` is a plain function returning 262; `new Test262Error(…)` a call.
    if (C1_ON && ts.isFunctionDeclaration(n) && n.name?.text === "Test262Error" && n.body) {
      const lines = source.slice(n.body.getStart(sf), n.body.end).split("\n").length - 1;
      edits.push([n.body.getStart(sf), n.body.end, `{ return 262;${"\n".repeat(lines)}}`]);
      return;
    }
    if (C1_ON && ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Test262Error")
      edits.push([n.getStart(sf), n.expression.getStart(sf), ""]);
    // PRELUDE STAND-IN (with C1): the runtime's `$262` object literal (globalThis, slices O / B) becomes `0`.
    if (
      C1_ON &&
      ts.isVariableDeclaration(n) &&
      n.name.getText(sf) === "$262" &&
      n.initializer &&
      n.parent.parent.parent === sf
    ) {
      const lines = source.slice(n.initializer.getStart(sf), n.initializer.end).split("\n").length - 1;
      edits.push([n.initializer.getStart(sf), n.initializer.end, `0${"\n".repeat(lines)}`]);
      return;
    }
    if (ts.isFunctionLike(n)) scope = [...scope, scopeNames(n)];
    if (ts.isIdentifier(n) && decls.has(n.text) && !declared(scope, n.text)) {
      const p = n.parent;
      const name = n.text;
      const skip =
        (ts.isFunctionDeclaration(p) && p.name === n) ||
        ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n) ||
        (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) ||
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name === n) ||
        ts.isShorthandPropertyAssignment(p);
      if (!skip) {
        if (SLOTS_ON && ts.isPropertyAccessExpression(p) && p.expression === n && !KEEP_MEMBER.has(p.name.text)) {
          const gp = p.parent;
          if (p.name.text !== "prototype") {
            const slot = `${name}$$${p.name.text}`;
            slots.add(slot);
            edits.push([p.getStart(sf), p.end, slot]);
            return;
          }
          if (ts.isPropertyAccessExpression(gp) && gp.expression === p) {
            const slot = `${name}$$prototype$$${gp.name.text}`;
            slots.add(slot);
            edits.push([gp.getStart(sf), gp.end, slot]);
            return;
          }
        }
        value(n, name);
      }
    }
    ts.forEachChild(n, (c) => visit(c, scope));
  };
  visit(sf, []);
  if (edits.length === 0) return source;
  edits.sort((a, b) => b[0] - a[0]);
  let out = source;
  for (const [s, e, t] of edits) out = out.slice(0, s) + t + out.slice(e);
  const returnsValue = (fn) => {
    let r = false;
    const w = (n) => {
      if (ts.isReturnStatement(n) && n.expression) r = true;
      if (!ts.isFunctionLike(n)) ts.forEachChild(n, w);
    };
    ts.forEachChild(fn.body, w);
    return r;
  };
  const head = [...wrappers]
    .map((name) => {
      const ps = decls
        .get(name)
        .parameters.map((_, i) => `a${i}`)
        .join(", ");
      return `var ${name}$fv = function (${ps}) { ${returnsValue(decls.get(name)) ? "return " : ""}${name}(${ps}); };`;
    })
    .join(" ");
  if (C1_ON) out = out.replace("  console.log(value);", "  void value; // STAND-IN");
  if (C1_ON)
    out = out.replace(
      `return "[" + Array.prototype.map.call(arrayLike, String).join(", ") + "]";`,
      `return "[" + arrayLike + "]"; // STAND-IN`,
    );
  if (C1_ON) out = out.replace(`return "Test262Error: " + this.message;`, `return "Test262Error"; // STAND-IN`);
  const lines = out.split("\n");
  const i = Math.max(0, firstLine - 1);
  if (head) lines[i] = `${head} ${lines[i]}`;
  if (slots.size) lines.push(`var ${[...slots].join(", ")};`);
  return lines.join("\n");
}
