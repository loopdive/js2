// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1936 — Async contract migration: census classifier + per-function CPS predicate.
 *
 * Locks the three pure analysis surfaces that the offline census
 * (`scripts/async-call-census.mjs`) and the call-site dispatch
 * (`src/codegen/expressions.ts`) both consume:
 *
 *   - `awaitIsStaticallyResolved` — settled-at-compile-time await operands.
 *   - `asyncFnNeedsCps`           — per-function "genuinely suspends" predicate
 *                                   (gated through `ASYNC_CPS_ENABLED`; #1796 flips).
 *   - `classifyAsyncConsumer`     — 3-state call-site consumer classification.
 *
 * The classifier is the per-call-site half of the migration; the predicate is
 * the per-definition half. #1796 joins them via the call graph to migrate
 * exactly the `value`-consumed-AND-genuinely-suspends set.
 */
import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import {
  analyzeAsyncBody,
  asyncFnNeedsCps,
  awaitIsStaticallyResolved,
  classifyAsyncConsumer,
  ASYNC_CPS_ENABLED,
  type AsyncCpsPlan,
} from "../src/codegen/async-cps.js";
import type { CodegenContext } from "../src/codegen/context/types.js";

// analyzeAsyncBody ignores its ctx argument (pure analysis). A cast is safe.
const FAKE_CTX = {} as CodegenContext;

function firstFn(src: string): { fn: ts.FunctionLikeDeclaration; plan: AsyncCpsPlan } {
  const sf = ts.createSourceFile("_wrap.ts", src, ts.ScriptTarget.Latest, true);
  const fn = sf.statements.find(ts.isFunctionDeclaration);
  if (!fn) throw new Error("test setup: no function declaration");
  return { fn, plan: analyzeAsyncBody(FAKE_CTX, fn) };
}

/** Build a real checker over an in-memory file so classifyAsyncConsumer can read cast types. */
function programFor(src: string): { checker: ts.TypeChecker; sf: ts.SourceFile } {
  const fileName = "/virtual/census.ts";
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.ES2022, true);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sf : ts.createSourceFile(name, "", ts.ScriptTarget.ES2022, true)),
    writeFile: () => {},
    getDefaultLibFileName: () => "lib.d.ts",
    getCurrentDirectory: () => "/virtual",
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (n) => n === fileName,
    readFile: (n) => (n === fileName ? src : undefined),
  };
  const program = ts.createProgram(
    [fileName],
    { target: ts.ScriptTarget.ES2022, skipLibCheck: true, noEmit: true },
    host,
  );
  return { checker: program.getTypeChecker(), sf: program.getSourceFile(fileName) ?? sf };
}

/** Find the first call expression whose callee identifier is `name`. */
function findCall(sf: ts.SourceFile, name: string): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === name) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === name))
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  if (!found) throw new Error(`test setup: no call to ${name}`);
  return found;
}

describe("#1936 — awaitIsStaticallyResolved", () => {
  const operand = (src: string): ts.Expression => {
    const sf = ts.createSourceFile("_a.ts", src, ts.ScriptTarget.Latest, true);
    let aw: ts.AwaitExpression | undefined;
    const walk = (n: ts.Node): void => {
      if (aw) return;
      if (ts.isAwaitExpression(n)) {
        aw = n;
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    if (!aw) throw new Error("no await");
    return aw.expression;
  };

  it("literals are statically resolved", () => {
    expect(awaitIsStaticallyResolved(operand(`async function f() { await 1; }`))).toBe(true);
    expect(awaitIsStaticallyResolved(operand(`async function f() { await "x"; }`))).toBe(true);
    expect(awaitIsStaticallyResolved(operand(`async function f() { await true; }`))).toBe(true);
    expect(awaitIsStaticallyResolved(operand(`async function f() { await null; }`))).toBe(true);
    expect(awaitIsStaticallyResolved(operand(`async function f() { await undefined; }`))).toBe(true);
  });

  it("arithmetic over literals is statically resolved", () => {
    expect(awaitIsStaticallyResolved(operand(`async function f() { await (1 + 2 * 3); }`))).toBe(true);
    expect(awaitIsStaticallyResolved(operand(`async function f() { await -5; }`))).toBe(true);
  });

  it("Promise.resolve(<static>) and Promise.resolve() are statically resolved", () => {
    expect(awaitIsStaticallyResolved(operand(`async function f() { await Promise.resolve(42); }`))).toBe(true);
    expect(awaitIsStaticallyResolved(operand(`async function f() { await Promise.resolve(); }`))).toBe(true);
  });

  it("calls / member reads / identifiers are NOT statically resolved", () => {
    expect(awaitIsStaticallyResolved(operand(`async function f() { await g(); }`))).toBe(false);
    expect(awaitIsStaticallyResolved(operand(`async function f() { await obj.p; }`))).toBe(false);
    expect(awaitIsStaticallyResolved(operand(`async function f(p) { await p; }`))).toBe(false);
    expect(awaitIsStaticallyResolved(operand(`async function f() { await Promise.resolve(g()); }`))).toBe(false);
  });
});

describe("#1936 — asyncFnNeedsCps (gated through ASYNC_CPS_ENABLED)", () => {
  it("the master gate is ON (#1796 flipped it)", () => {
    expect(ASYNC_CPS_ENABLED).toBe(true);
  });

  it("returns true for a genuinely-suspending single-tail-await body, false otherwise (#1796)", () => {
    // `const x = await g(); return x` — `g()` is a non-static call ⇒ real
    // suspension ⇒ canonical single-tail-await shape ⇒ CPS-lowered.
    const a = firstFn(`async function f() { const x = await g(); return x; }`);
    expect(asyncFnNeedsCps(a.fn, a.plan)).toBe(true);
    // No await ⇒ await-elidable / sync ⇒ legacy path.
    const b = firstFn(`async function f() { return 1; }`);
    expect(asyncFnNeedsCps(b.fn, b.plan)).toBe(false);
    // Await present but fully statically resolved ⇒ await-elidable ⇒ legacy path.
    const c = firstFn(`async function f() { const x = await 1; return x; }`);
    expect(asyncFnNeedsCps(c.fn, c.plan)).toBe(false);
    // Two awaits ⇒ outside the single-tail-await shape ⇒ legacy path.
    const d = firstFn(`async function f() { const x = await g(); const y = await h(); return x + y; }`);
    expect(asyncFnNeedsCps(d.fn, d.plan)).toBe(false);
  });

  it("populates awaitedStaticallyResolved per await point", () => {
    const { plan } = firstFn(`async function f() { const a = await 1; const b = await g(); return a + b; }`);
    expect(plan.awaitPoints).toHaveLength(2);
    expect(plan.awaitedStaticallyResolved.get(plan.awaitPoints[0]!)).toBe(true); // await 1
    expect(plan.awaitedStaticallyResolved.get(plan.awaitPoints[1]!)).toBe(false); // await g()
  });

  it("no-await body has an empty resolution map", () => {
    const { plan } = firstFn(`async function f(n: number) { return n + 1; }`);
    expect(plan.awaitPoints).toHaveLength(0);
    expect(plan.awaitedStaticallyResolved.size).toBe(0);
  });
});

describe("#1936 — classifyAsyncConsumer", () => {
  it("classifies an awaited async call as 'await'", () => {
    const { checker, sf } = programFor(`
      async function g(): Promise<number> { return 1; }
      async function h() { const x = await g(); return x; }
    `);
    expect(classifyAsyncConsumer(checker, findCall(sf, "g"))).toBe("await");
  });

  it("classifies a non-Promise cast sink as 'value'", () => {
    const { checker, sf } = programFor(`
      async function g(): Promise<number> { return 1; }
      function h(): number { return g() as unknown as number; }
    `);
    expect(classifyAsyncConsumer(checker, findCall(sf, "g"))).toBe("value");
  });

  it("classifies a .then consumer as 'thenable'", () => {
    const { checker, sf } = programFor(`
      async function g(): Promise<number> { return 1; }
      function h() { g().then((x) => x + 1); }
    `);
    // The async call is `g()`; its receiver-of-.then consumer is a Promise → thenable.
    expect(classifyAsyncConsumer(checker, findCall(sf, "g"))).toBe("thenable");
  });

  it("classifies a bare (unwrapped) async call as 'thenable'", () => {
    const { checker, sf } = programFor(`
      async function g(): Promise<number> { return 1; }
      function h() { return g(); }
    `);
    expect(classifyAsyncConsumer(checker, findCall(sf, "g"))).toBe("thenable");
  });

  it("parity: 'await'/'value' are the raw-T consumers, only 'thenable' wraps", () => {
    // The legacy boolean `asyncResultConsumedAsValue` is exactly
    // `classifyAsyncConsumer(...) !== "thenable"`. Encode the contract so a
    // future refactor can't silently diverge the two.
    const cases: Array<[string, string, "await" | "value" | "thenable"]> = [
      [
        `async function g(): Promise<number> { return 1; }\nasync function h(){ const x = await g(); return x; }`,
        "g",
        "await",
      ],
      [
        `async function g(): Promise<number> { return 1; }\nfunction h(): number { return g() as any as number; }`,
        "g",
        "value",
      ],
      [`async function g(): Promise<number> { return 1; }\nfunction h(){ g().then(x=>x); }`, "g", "thenable"],
    ];
    for (const [src, name, expected] of cases) {
      const { checker, sf } = programFor(src);
      const kind = classifyAsyncConsumer(checker, findCall(sf, name));
      expect(kind).toBe(expected);
      const legacyConsumedAsValue = kind !== "thenable";
      expect(legacyConsumedAsValue).toBe(expected !== "thenable");
    }
  });
});
