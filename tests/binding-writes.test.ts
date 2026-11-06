// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4495 / #6992 — `src/shared/binding-writes.ts` is the ONE identifier-write
// enumerator. `identifierWritesOf` names every store and what it stores; the
// closure-capture / loop-boxing predicate `isLexicalBindingWrite` and
// `varDeclaratorWrittenNames` are projections of it. These tests pin both the
// per-shape answers and the parity of the projections, so the scans cannot
// drift apart again (#4495 review: the old private walks disagreed on `+=`,
// for-in, TS wrappers and `var` re-declarations).
import { describe, expect, it } from "vitest";
import {
  identifierWritesOf,
  isLexicalBindingWrite,
  varDeclaratorWrittenNames,
  type IdentifierWrite,
} from "../src/shared/binding-writes.js";
import { ts } from "../src/ts-api.js";

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function describeWrite(write: IdentifierWrite): string {
  switch (write.kind) {
    case "value":
      return `${write.target.text}:value(${write.expr.getText()})`;
    case "element":
      return `${write.target.text}:element(${write.iterable.getText()})`;
    case "property":
      return `${write.target.text}:property(${write.object.getText()}.${write.key})`;
    default:
      return `${write.target.text}:${write.kind}`;
  }
}

/** Every write in `source`, in walk order. */
function writesIn(source: string, options?: { updates?: boolean }): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    for (const write of identifierWritesOf(node, options)) out.push(describeWrite(write));
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  return out;
}

describe("identifierWritesOf — what each store writes", () => {
  const CASES: [string, string[]][] = [
    ["x = f();", ["x:value(f())"]],
    ["x += 'a';", ["x:value(x += 'a')"]],
    ["x -= 1; x **= 2; x |= 1;", ["x:numeric", "x:numeric", "x:numeric"]],
    ["x ||= y; x &&= y; x ??= y;", ["x:value(y)", "x:value(y)", "x:value(y)"]],
    ["x++; --x;", ["x:numeric", "x:numeric"]],
    [
      "(x as any) = 1; x! = 2; (<any>x) = 3; (x satisfies any) = 4;",
      ["x:value(1)", "x:value(2)", "x:value(3)", "x:value(4)"],
    ],
    ["[a, b] = [1, 'x'];", ["a:value(1)", "b:value('x')"]],
    ["[a, , b] = [1];", ["a:value(1)", "b:unknown"]],
    ["[a, ...r] = xs;", ["a:element(xs)", "r:rest"]],
    ["[a] = [...xs];", ["a:unknown"]],
    ["({ a, b: c, ...o } = src);", ["a:property(src.a)", "c:property(src.b)", "o:rest"]],
    ["({ a, b: c } = { a: 1, b: g() });", ["a:value(1)", "c:value(g())"]],
    ["({ [k]: a } = src);", ["a:unknown"]],
    ["[a = 1] = xs;", ["a:element(xs)", "a:value(1)", "a:value(1)"]],
    // A nested pattern under a non-literal source sees an unnamed element AND its default.
    ["[[a] = ['z']] = src;", ["a:unknown", "a:value('z')", "a:value('z')"]],
    ["[[a]] = [[1]];", ["a:value(1)"]],
    ["[[a]] = [ys];", ["a:element(ys)"]],
    ["for (k in o) {}", ["k:key"]],
    ["for (v of xs) {}", ["v:element(xs)"]],
    ["for ([p] of xs) {}", ["p:unknown"]],
    ["for (var w of xs) {} for (const c in o) {}", ["w:element(xs)", "c:key"]],
    ["var q = 1; var [m, { n }] = [2, src];", ["q:value(1)", "m:value(2)", "n:property(src.n)"]],
    ["let z = 1; const y = 2; var u;", []],
    ["o.p = 1; o[k] += 2; f(x); x + 1; -x; !x;", []],
  ];
  for (const [source, expected] of CASES) {
    it(source, () => {
      expect(writesIn(source)).toEqual(expected);
    });
  }

  it("`updates: false` leaves `++`/`--` out and nothing else", () => {
    expect(writesIn("x++; --y; x -= 1;", { updates: false })).toEqual(["x:numeric"]);
  });
});

describe("isLexicalBindingWrite / varDeclaratorWrittenNames are projections of identifierWritesOf", () => {
  // Shapes the closure-capture and loop-boxing scans see (#6992), plus the
  // ones the #4495 enumerator used to miss.
  const SHAPES = [
    "x = 1; y += 2; z -= 3; w ||= 4; v ??= 5; u &&= 6;",
    "x++; ++y; z--; --w; -v; !u; typeof t;",
    "[a, b] = [b, a]; [c, ...d] = e; [f = g] = h; [[i] = [j]] = k;",
    "({ a, b: c, ...d } = e); ({ f = g } = h); ({ [i]: j } = k); ({ l: { m } } = n);",
    "for (a in b) {} for (c of d) {} for ([e, f] of g) {} for ({ h } of i) {} for (var j in k) {} for (let l of m) {}",
    "(a) = 1; (a as any) = 2; a! = 3; [b as any] = c; ({ d: e! } = f);",
    "o.p = 1; o[q] = 2; [r.s] = t; ({ u: v.w } = x); f(...y); z = [a1, ...b1];",
    "var a = 1; var a = 2; var [b, { c }] = d; let e = 3; const f = 4; var g;",
    "x = y = z; x = [y] = z; [x = y] = z;",
  ];
  for (const source of SHAPES) {
    it(source, () => {
      const file = parse(source);
      const viaPredicate = new Set<ts.Identifier>();
      const viaEnumerator = new Set<ts.Identifier>();
      const viaDeclarators = new Set<ts.Identifier>();
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && isLexicalBindingWrite(node)) viaPredicate.add(node);
        for (const id of varDeclaratorWrittenNames(node)) viaDeclarators.add(id);
        if (!ts.isVariableDeclaration(node)) {
          for (const { target } of identifierWritesOf(node)) {
            // A loop head's declaration names a fresh binding, not a write the
            // capture scans look for.
            if (!ts.isVariableDeclaration(target.parent) && !ts.isBindingElement(target.parent)) {
              viaEnumerator.add(target);
            }
          }
        } else {
          const own = identifierWritesOf(node).map((w) => w.target);
          expect(new Set(own)).toEqual(new Set(varDeclaratorWrittenNames(node)));
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      expect([...viaPredicate].map((id) => id.text)).toEqual([...viaEnumerator].map((id) => id.text));
      for (const id of viaDeclarators) expect(isLexicalBindingWrite(id)).toBe(false);
    });
  }

  it("the predicate's write sets per shape", () => {
    const written = (source: string): string[] => {
      const out: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && isLexicalBindingWrite(node)) out.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(parse(source));
      return out;
    };
    expect(written(SHAPES[0]!)).toEqual(["x", "y", "z", "w", "v", "u"]);
    expect(written(SHAPES[1]!)).toEqual(["x", "y", "z", "w"]);
    expect(written(SHAPES[2]!)).toEqual(["a", "b", "c", "d", "f", "i"]);
    expect(written(SHAPES[3]!)).toEqual(["a", "c", "d", "f", "j", "m"]);
    expect(written(SHAPES[4]!)).toEqual(["a", "c", "e", "f", "h"]);
    expect(written(SHAPES[5]!)).toEqual(["a", "a", "a", "b", "e"]);
    expect(written(SHAPES[6]!)).toEqual(["z"]); // member targets, spread arguments and RHS elements are not writes
    expect(written(SHAPES[8]!)).toEqual(["x", "y", "x", "y", "x"]);
  });
});
