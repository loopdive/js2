// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3623) The module-init collection classifier — the systemic fix for a defect
// class that has recurred at least SIX times.
//
// `collectDeclarations` decides which top-level ExpressionStatements reach
// `__module_init` from an ALLOW-LIST. Anything unnamed was dropped SILENTLY:
// the statement never happened, the program gave a silent wrong answer, and any
// test covering it became a VACUOUS PASS.
//
//   #1268 `d["x"] ??= 42`     #2671 `F.prop = …`      #2992 `delete o.k`
//   #3366 `[a,b] = …`         #3468 `assert.sameValue = …`
//   #3592 top-level `throw`   #3615 bare `o.p;`
//
// Each was fixed by adding one more arm. A seventh arm does not stop the
// eighth. The sharpest instance is #3592 RC1: the dropped top-level `throw`
// broke the throw-probe technique used to DETECT vacuous passes — the mechanism
// disabled its own detector.
//
// These tests pin the property that ends the class: the classification is
// TOTAL, and the DEFAULT is never "drop quietly".
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  classifyTopLevelExpressionStatement,
  isAssignmentOperator,
  unwrapStatementExpression,
} from "../src/codegen/module-init-collection.js";

/** Parse `src` and return the first ExpressionStatement's expression. */
function exprOf(src: string): ts.Expression {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const stmt = sf.statements.find(ts.isExpressionStatement);
  if (!stmt) throw new Error(`no ExpressionStatement in: ${src}`);
  return stmt.expression;
}

const classify = (src: string) => classifyTopLevelExpressionStatement(exprOf(src));

describe("#3623 the six historical silent drops are all `keep`", () => {
  // Each row is a shape that WAS silently dropped and caused a documented
  // silent wrong answer. They must never be classified anything but `keep`.
  const REGRESSIONS: [string, string, string][] = [
    ["#1268 logical assignment", `d["x"] ??= 42;`, "PutValue"],
    ["#2671 static property write", `F.prop = 1;`, "PutValue"],
    ["#2992 delete", `delete o.k;`, "delete"],
    ["#3366 destructuring assignment", `[a, b] = c;`, "PutValue"],
    ["#3468 harness assert assignment", `assert.sameValue = function () {};`, "PutValue"],
    ["#3615 bare property read", `o.p;`, "accessor"],
    ["#3615 bare element read", `o["p"];`, "accessor"],
    ["#3615 void-wrapped read", `void o.p;`, "accessor"],
    ["#3615 parenthesized read", `(o.p);`, "accessor"],
    ["call", `f();`, "invokes"],
    ["new", `new C();`, "invokes"],
    ["increment", `x++;`, "PutValue"],
  ];

  for (const [name, src, reasonFragment] of REGRESSIONS) {
    it(`${name}: ${src.trim()}`, () => {
      const c = classify(src);
      expect(c.disposition, `${src} must be kept`).toBe("keep");
      expect(c.reason).toContain(reasonFragment);
    });
  }

  // #3592 RC1 (top-level `throw`) is a ThrowStatement, not an
  // ExpressionStatement, so it is handled by its own arm one level up. It is
  // listed in the header because it is the same defect class and the same
  // allow-list — recorded here so the omission is deliberate, not an oversight.
  it("top-level `throw` is a ThrowStatement, handled above this classifier", () => {
    const sf = ts.createSourceFile("t.ts", `throw new Error("x");`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    expect(sf.statements.some(ts.isThrowStatement)).toBe(true);
    expect(sf.statements.some(ts.isExpressionStatement)).toBe(false);
  });
});

describe("#3623 `inert` is an explicit deny-list, and every claim is a correctness claim", () => {
  const INERT: [string, string][] = [
    ["numeric literal", `1;`],
    ["string literal", `"s";`],
    ["bigint literal", `2n;`],
    ["regex literal", `/x/g;`],
    ["null", `null;`],
    ["true", `true;`],
    ["false", `false;`],
    ["this", `this;`],
    ["function expression", `(function () { sideEffect(); });`],
    ["arrow function", `() => sideEffect();`],
    ["template with no substitutions", "`plain`;"],
  ];

  for (const [name, src] of INERT) {
    it(`${name} is inert, with a stated reason`, () => {
      const c = classify(src);
      expect(c.disposition, src).toBe("inert");
      expect(c.reason.length, "an inert claim must justify itself").toBeGreaterThan(10);
    });
  }

  it("creating a closure is inert even when the BODY has effects — the body does not run", () => {
    expect(classify(`(function () { throw new Error("never"); });`).disposition).toBe("inert");
    expect(classify(`() => { throw new Error("never"); };`).disposition).toBe("inert");
  });
});

describe("#3623 the DEFAULT is loud — this is the property that ends the class", () => {
  // Shapes that are NOT provably inert and are NOT collected today. Each would
  // have been the next silent wrong answer. They must surface as `unhandled`.
  const UNHANDLED: [string, string][] = [
    ["bare identifier (ReferenceError / TDZ)", `x;`],
    ["typeof on a TDZ binding throws", `typeof x;`],
    ["tagged template calls the tag function", "tag`hello`;"],
    ["comma expression can contain calls", `a = f(), b = g();`.replace(/^/, "0, ")],
    ["conditional evaluates a branch", `c ? f() : g();`],
    ["binary operand can be a call", `f() + g();`],
    ["ToPrimitive coercion can throw", `obj + 1;`],
    ["object literal: computed key runs code", `({ [k()]: 1 });`],
    ["array literal: element runs code", `[f()];`],
    ["class expression: static block runs", `(class { static { f(); } });`],
    ["template substitution evaluates", "`a${f()}b`;"],
    ["await is observable", `await p;`],
    ["new.target", `new.target;`],
    ["instanceof invokes Symbol.hasInstance", `a instanceof B;`],
    ["`in` invokes a proxy trap", `k in obj;`],
  ];

  for (const [why, src] of UNHANDLED) {
    it(`${why}: ${src.trim()}`, () => {
      const c = classify(src);
      expect(c.disposition, `${src} must NOT be silently dropped`).toBe("unhandled");
      expect(c.reason).toContain("not provably inert");
    });
  }

  it("labels binary expressions with their operator, so the report is actionable", () => {
    expect(classify(`a + b;`).shape).toBe("BinaryExpression(PlusToken)");
    expect(classify(`a, b;`).shape).toBe("BinaryExpression(CommaToken)");
  });

  it("is TOTAL — every classification is one of the three dispositions", () => {
    const SAMPLES = [`1;`, `f();`, `x;`, `o.p;`, `a + b;`, `await p;`, `(class {});`, `/re/;`, `a = 1;`];
    for (const s of SAMPLES) {
      expect(["keep", "inert", "unhandled"]).toContain(classify(s).disposition);
    }
  });
});

describe("#3623 statement-position unwrapping matches the collector", () => {
  it("unwraps parentheses and `void`, which are transparent in statement position", () => {
    expect(ts.isCallExpression(unwrapStatementExpression(exprOf(`void f();`)))).toBe(true);
    expect(ts.isCallExpression(unwrapStatementExpression(exprOf(`((f()));`)))).toBe(true);
    expect(ts.isDeleteExpression(unwrapStatementExpression(exprOf(`void (delete o.k);`)))).toBe(true);
  });

  it("does NOT unwrap anything else", () => {
    expect(ts.isAwaitExpression(unwrapStatementExpression(exprOf(`await p;`)))).toBe(true);
  });
});

describe("#3623 assignment-operator set is complete", () => {
  it("covers every compound and logical assignment", () => {
    for (const op of [
      "=",
      "+=",
      "-=",
      "*=",
      "**=",
      "/=",
      "%=",
      "&=",
      "|=",
      "^=",
      "<<=",
      ">>=",
      ">>>=",
      "??=",
      "||=",
      "&&=",
    ]) {
      const c = classify(`a ${op} b;`);
      expect(c.disposition, `a ${op} b`).toBe("keep");
    }
  });

  it("does not mistake a comparison for an assignment", () => {
    expect(isAssignmentOperator(ts.SyntaxKind.EqualsEqualsToken)).toBe(false);
    expect(isAssignmentOperator(ts.SyntaxKind.EqualsEqualsEqualsToken)).toBe(false);
    expect(isAssignmentOperator(ts.SyntaxKind.EqualsToken)).toBe(true);
  });
});
