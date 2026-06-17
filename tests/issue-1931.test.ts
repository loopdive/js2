// #1931 — unit tests for the decomposed ES early-error rule modules.
//
// detectEarlyErrors was a single ~3,350-line function; it is now split into
// per-concern modules under src/compiler/early-errors/. These tests exercise the
// extracted units directly (predicates + rule modules) with small fixtures, plus
// an integration check that the multi-source compile path now rejects a
// duplicate-`let` early error.
import { describe, it, expect } from "vitest";
import { ts } from "../src/ts-api.js";
import { compileMulti } from "../src/index.js";
import { detectEarlyErrors } from "../src/compiler/validation.js";
import { createEarlyErrorContext } from "../src/compiler/early-errors/context.js";
import {
  collectBindingNames,
  hasOptionalChain,
  isArgumentsOrEval,
  isInsideIteration,
  isInvalidAssignmentTarget,
  isStrictMode,
} from "../src/compiler/early-errors/predicates.js";
import {
  checkDuplicateLexicalDeclarations,
  checkDuplicatePrivateNames,
} from "../src/compiler/early-errors/duplicates.js";
import { checkTDZInStatements } from "../src/compiler/early-errors/tdz.js";
import { validateArrayAssignmentPattern } from "../src/compiler/early-errors/assignment.js";

function parse(src: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
}

/** Find the first node matching a predicate (depth-first). */
function find<T extends ts.Node>(root: ts.Node, pred: (n: ts.Node) => n is T): T | undefined {
  let result: T | undefined;
  const walk = (n: ts.Node) => {
    if (result) return;
    if (pred(n)) {
      result = n;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(root);
  return result;
}

describe("#1931 predicates (pure helpers)", () => {
  it("isStrictMode: true under a 'use strict' prologue, false for bare module", () => {
    const strict = parse('"use strict"; x;');
    const idStrict = find(strict, ts.isIdentifier)!;
    expect(isStrictMode(idStrict)).toBe(true);

    // A module (has export) is NOT automatically strict (#1931 stale-comment fix).
    const mod = parse("export {}; x;");
    const idMod = find(mod, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === "x")!;
    expect(isStrictMode(idMod)).toBe(false);
  });

  it("isStrictMode: class bodies are always strict", () => {
    const sf = parse("class C { m() { y; } }");
    const idY = find(sf, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === "y")!;
    expect(isStrictMode(idY)).toBe(true);
  });

  it("isArgumentsOrEval: detects arguments/eval, unwraps parens", () => {
    const sf = parse("(arguments); (eval); foo;");
    const args = find(sf, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === "arguments")!;
    const evl = find(sf, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === "eval")!;
    const foo = find(sf, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === "foo")!;
    expect(isArgumentsOrEval(args)).toBe("arguments");
    expect(isArgumentsOrEval(evl)).toBe("eval");
    expect(isArgumentsOrEval(foo)).toBe(null);
  });

  it("isInvalidAssignmentTarget: identifier/property valid, literal invalid", () => {
    const id = find(parse("x = 1;"), ts.isIdentifier)!;
    expect(isInvalidAssignmentTarget(id as ts.Expression)).toBe(false);
    const lit = find(parse("1;"), ts.isNumericLiteral)!;
    expect(isInvalidAssignmentTarget(lit as ts.Expression)).toBe(true);
  });

  it("hasOptionalChain: detects ?. in the chain", () => {
    const chain = find(parse("a?.b;"), ts.isPropertyAccessExpression)!;
    expect(hasOptionalChain(chain as ts.Expression)).toBe(true);
    const plain = find(parse("a.b;"), ts.isPropertyAccessExpression)!;
    expect(hasOptionalChain(plain as ts.Expression)).toBe(false);
  });

  it("isInsideIteration: true inside a for body, false at top level", () => {
    const sf = parse("for (;;) { inside; } outside;");
    const inside = find(sf, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === "inside")!;
    const outside = find(sf, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === "outside")!;
    expect(isInsideIteration(inside)).toBe(true);
    expect(isInsideIteration(outside)).toBe(false);
  });

  it("collectBindingNames: flattens destructuring patterns", () => {
    const decl = find(parse("const { a, b: { c }, ...d } = o;"), ts.isVariableDeclaration)!;
    const names = new Set<string>();
    collectBindingNames(decl.name, names);
    expect([...names].sort()).toEqual(["a", "c", "d"]);
  });
});

describe("#1931 rule modules (ctx-threaded)", () => {
  it("checkDuplicateLexicalDeclarations flags a duplicate let", () => {
    const sf = parse("let x; let x;");
    const ctx = createEarlyErrorContext(sf);
    checkDuplicateLexicalDeclarations(ctx, sf);
    expect(ctx.errors.map((e) => e.message)).toContain("Duplicate identifier 'x'");
  });

  it("checkDuplicateLexicalDeclarations is silent for distinct names", () => {
    const sf = parse("let x; let y; const z = 1;");
    const ctx = createEarlyErrorContext(sf);
    checkDuplicateLexicalDeclarations(ctx, sf);
    expect(ctx.errors).toHaveLength(0);
  });

  it("checkDuplicatePrivateNames flags a repeated #field", () => {
    const sf = parse("class C { #x; #x; }");
    const cls = find(sf, ts.isClassDeclaration)!;
    const ctx = createEarlyErrorContext(sf);
    checkDuplicatePrivateNames(ctx, cls);
    expect(ctx.errors.map((e) => e.message)).toContain("Duplicate private name '#x'");
  });

  it("checkDuplicatePrivateNames allows a get/set pair with same staticness", () => {
    const sf = parse("class C { get #x() { return 1; } set #x(v) {} }");
    const cls = find(sf, ts.isClassDeclaration)!;
    const ctx = createEarlyErrorContext(sf);
    checkDuplicatePrivateNames(ctx, cls);
    expect(ctx.errors).toHaveLength(0);
  });

  it("checkTDZInStatements warns on use-before-declaration", () => {
    const sf = parse("x; let x = 1;");
    const ctx = createEarlyErrorContext(sf);
    checkTDZInStatements(ctx, sf.statements);
    const msgs = ctx.errors.map((e) => e.message);
    expect(msgs).toContain("Cannot access 'x' before initialization");
    expect(ctx.errors.every((e) => e.severity === "warning")).toBe(true);
  });

  it("validateArrayAssignmentPattern flags rest-not-last", () => {
    const arr = find(parse("[...a, b] = c;"), ts.isArrayLiteralExpression)!;
    const ctx = createEarlyErrorContext(arr.getSourceFile());
    validateArrayAssignmentPattern(ctx, arr, /*strict*/ false);
    expect(ctx.errors.map((e) => e.message)).toContain("Rest element must be last in a destructuring pattern");
  });
});

describe("#1931 detectEarlyErrors integration", () => {
  const cases: Array<[string, string, string | null]> = [
    ["strict eval assignment", '"use strict"; eval = 1;', "Cannot assign to 'eval' in strict mode"],
    ["duplicate constructor", "class C { constructor() {} constructor() {} }", "A class may only have one constructor"],
    ["duplicate export default", "export default 1; export default 2;", "Duplicate export name 'default'"],
    ["with in strict mode", '"use strict"; with (o) {}', "Strict mode code may not include a with statement"],
    ["clean program", "const a = 1; export const b = a + 1;", null],
  ];

  for (const [name, src, expectedMsg] of cases) {
    it(name, () => {
      const errors = detectEarlyErrors(parse(src));
      if (expectedMsg === null) {
        expect(errors.filter((e) => e.severity === "error")).toHaveLength(0);
      } else {
        expect(errors.map((e) => e.message)).toContain(expectedMsg);
      }
    });
  }
});

describe("#1931 multi-source early errors", () => {
  it("rejects a duplicate-let in a multi-source compile", async () => {
    const r = await compileMulti({ "main.ts": "let x = 1;\nlet x = 2;\nexport const y = x;" }, "main.ts", {});
    expect(r.success).toBe(false);
    expect(r.errors?.some((e) => e.message === "Duplicate identifier 'x'")).toBe(true);
  });

  it("still compiles a clean multi-file program", async () => {
    const r = await compileMulti(
      { "a.ts": "export const a = 1;", "main.ts": 'import { a } from "./a";\nexport const b = a + 1;' },
      "main.ts",
      {},
    );
    expect(r.success).toBe(true);
    expect((r.errors ?? []).filter((e) => e.severity === "error")).toHaveLength(0);
  });
});
