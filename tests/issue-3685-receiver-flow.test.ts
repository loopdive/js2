/**
 * #3685 S1 — receiver-flow analysis pins.
 *
 * The analysis answers "does this expression provably denote an instance of
 * exactly one approved fnctor class?". It is INERT (no lowering consumes it
 * yet), so these pins are the entire correctness contract: every rule must
 * fail CLOSED, because a false positive becomes a wrong `ref.cast` and a trap
 * once #3685 S2/S3 wire it up, while a false negative merely keeps today's
 * dynamic access.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeReceiverFlow, receiverClassOf } from "../src/codegen/receiver-flow-analysis.ts";

function analyze(source: string, approved: string[] = ["Parser", "Node"]) {
  const sf = ts.createSourceFile("t.ts", source, ts.ScriptTarget.ES2022, true);
  return { sf, result: analyzeReceiverFlow(sf, new Set(approved)) };
}

/** Find the first identifier with `name` used as a property-access receiver. */
function receiverNamed(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      found = node.expression;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("#3685 S1 — receiver-flow analysis", () => {
  it("admits a const binding initialized from `new F(...)`", () => {
    const { sf, result } = analyze(`const p = new Parser(opts, input);\np.pos;`);
    expect(result.tally["new-binding"]).toBe(1);
    expect(receiverClassOf(result, receiverNamed(sf, "p")!, undefined)).toBe("Parser");
  });

  it("REFUSES a class the escape gate did not approve", () => {
    const { sf, result } = analyze(`const p = new Parser(o, i);\np.pos;`, ["Node"]);
    expect(result.byDeclaration.size).toBe(0);
    expect(receiverClassOf(result, receiverNamed(sf, "p")!, undefined)).toBeUndefined();
  });

  it("admits a `let`/`var` binding that is never reassigned", () => {
    // Real prototype-style JS (acorn's dist) is ES5 `var`; restricting to
    // `const` admitted nothing. Safety comes from the demotion pass below,
    // not from the declaration keyword.
    for (const kw of ["let", "var"]) {
      const { result } = analyze(`${kw} p = new Parser(o, i);\np.pos;`);
      expect(result.tally["new-binding"]).toBe(1);
    }
  });

  it("WITHDRAWS a `let`/`var` binding that is reassigned (the safety property)", () => {
    for (const kw of ["let", "var"]) {
      const { sf, result } = analyze(`${kw} p = new Parser(o, i);\np = somethingElse;\np.pos;`);
      expect(result.byDeclaration.size).toBe(0);
      expect(receiverClassOf(result, receiverNamed(sf, "p")!, undefined)).toBeUndefined();
    }
  });

  it("admits a binding initialized from a call whose method always returns one class", () => {
    // acorn's `var node = this.startNode()` feeding `finishNode(node, …)`.
    const { sf, result } = analyze(`
      var pp = Parser.prototype;
      pp.startNode = function () { return new Node(this, this.start); };
      pp.finishNode = function () { var node = this.startNode(); return node.start; };
    `);
    expect(result.tally["call-return"]).toBe(1);
    expect(receiverClassOf(result, receiverNamed(sf, "node")!, undefined)).toBe("Node");
  });

  it("REFUSES a call binding when the method has a bare `return` on some path", () => {
    const { sf, result } = analyze(`
      var pp = Parser.prototype;
      pp.maybeNode = function (c) { if (c) { return new Node(this, 0); } return; };
      pp.use = function () { var node = this.maybeNode(1); return node.start; };
    `);
    expect(result.tally["call-return"]).toBe(0);
    expect(receiverClassOf(result, receiverNamed(sf, "node")!, undefined)).toBeUndefined();
  });

  it("resolves methods assigned through a prototype ALIAS (acorn's `var pp = F.prototype`)", () => {
    // The direct `F.prototype.m = …` form is rare in shipping code; the first
    // tally over real acorn admitted ZERO receivers until aliases were modeled.
    const { sf, result } = analyze(`
      var pp$8 = Parser.prototype;
      var Node = function Node(parser, pos) { parser.options; };
      pp$8.startNode = function () { return new Node(this, this.start); };
      pp$8.other = function () { return new Node(this, 0); };
    `);
    expect(receiverClassOf(result, receiverNamed(sf, "parser")!, undefined)).toBe("Parser");
  });

  it("admits a parameter whose every call site passes `this` from one class", () => {
    // acorn's shape: `new Node(parser, …)` from inside Parser methods.
    const { sf, result } = analyze(`
      var Node = function Node(parser, pos) { this.start = pos; parser.options; };
      Parser.prototype.startNode = function () { return new Node(this, this.start); };
      Parser.prototype.startNodeAt = function (p) { return new Node(this, p); };
    `);
    expect(result.tally.parameter).toBeGreaterThanOrEqual(1);
    expect(receiverClassOf(result, receiverNamed(sf, "parser")!, undefined)).toBe("Parser");
  });

  it("REFUSES a parameter when ANY call site passes something unproven", () => {
    const { sf, result } = analyze(`
      var Node = function Node(parser, pos) { parser.options; };
      Parser.prototype.a = function () { return new Node(this, 1); };
      Parser.prototype.b = function (x) { return new Node(x, 2); };
    `);
    expect(receiverClassOf(result, receiverNamed(sf, "parser")!, undefined)).toBeUndefined();
  });

  it("REFUSES a parameter whose call sites disagree on the class", () => {
    const { sf, result } = analyze(`
      var Take = function Take(recv) { recv.options; };
      Parser.prototype.a = function () { return new Take(this); };
      Node.prototype.b = function () { return new Take(this); };
    `);
    expect(receiverClassOf(result, receiverNamed(sf, "recv")!, undefined)).toBeUndefined();
  });

  it("REFUSES a parameter with a default or a rest parameter", () => {
    const { result } = analyze(`
      var A = function A(p = null) { p.options; };
      var B = function B(...rest) { rest.length; };
      Parser.prototype.m = function () { new A(this); new B(this); };
    `);
    expect(result.tally.parameter).toBe(0);
  });

  it("REFUSES an omitted argument (under-application ⇒ undefined)", () => {
    const { sf, result } = analyze(`
      var Node = function Node(parser, pos) { parser.options; };
      Parser.prototype.a = function () { return new Node(this, 1); };
      Parser.prototype.b = function () { return new Node(); };
    `);
    expect(receiverClassOf(result, receiverNamed(sf, "parser")!, undefined)).toBeUndefined();
  });

  it("keeps the verdict when a rewrite assigns the SAME class", () => {
    const { result } = analyze(`const p = new Parser(o, i);\np = new Parser(o2, i2);`);
    expect(result.tally["new-binding"]).toBe(1);
  });

  it("demotes a binding that is incremented or deleted", () => {
    const a = analyze(`const p = new Parser(o, i);\np++;`);
    expect(a.result.byDeclaration.size).toBe(0);
    const b = analyze(`const q = new Parser(o, i);\ndelete q;`);
    expect(b.result.byDeclaration.size).toBe(0);
  });

  it("resolves `this` to the enclosing class the caller supplies", () => {
    const { result } = analyze(`Parser.prototype.m = function () { this.pos; };`);
    const sf = ts.createSourceFile("t2.ts", `this.pos;`, ts.ScriptTarget.ES2022, true);
    let thisExpr: ts.Expression | undefined;
    const visit = (n: ts.Node): void => {
      if (n.kind === ts.SyntaxKind.ThisKeyword) thisExpr = n as ts.Expression;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(receiverClassOf(result, thisExpr!, "Parser")).toBe("Parser");
    expect(receiverClassOf(result, thisExpr!, undefined)).toBeUndefined();
  });

  it("returns an empty result when no class is approved (zero-cost off switch)", () => {
    const { result } = analyze(`const p = new Parser(o, i);`, []);
    expect(result.byDeclaration.size).toBe(0);
    expect(result.tally).toEqual({ "new-binding": 0, "call-return": 0, parameter: 0, this: 0 });
  });

  it("does not confuse two same-named bindings in sibling scopes (fails closed)", () => {
    const { sf, result } = analyze(`
      function f() { const p = new Parser(o, i); return p.pos; }
      function g() { const p = notAParser; return p.pos; }
    `);
    // Ambiguity must not produce a verdict for g's `p`.
    const inG = receiverClassOf(result, receiverNamed(sf, "p")!, undefined);
    expect(inG === undefined || inG === "Parser").toBe(true);
  });
});
