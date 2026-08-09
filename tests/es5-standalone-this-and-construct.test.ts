// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4246) Three §10/§13 holes that all present as "the program kept going with
// the wrong value" rather than as a crash:
//
//   1. `new <non-constructor>` answered `undefined` instead of throwing a
//      TypeError (§13.3.5.1 step 4).
//   2. A SLOPPY callee bound a primitive `thisArg` verbatim instead of
//      `ToObject(thisArg)` (§10.2.1.2 step 5.b). The strict half was already
//      right, which is why the gap survived: `foo.call(1)` and `bar.call(1)`
//      differ only in the callee's own strictness.
//   3. `(function () { this.x = 1 }).call(obj)` wrote to the AMBIENT receiver,
//      because Case 0 of the `.call` dispatch inlines the callee and dropped
//      the receiver. Asymmetric and therefore easy to miss: reading `this`
//      looked fine (sloppy top-level `this` is the global object), only writes
//      went to the wrong object.
//
// The negative tests are the load-bearing half in each case — they pin the
// shapes that must KEEP their existing answer, which is where a wider fix
// would do damage:
//
//   - a strict callee keeps its primitive `this` verbatim;
//   - `.call(null)` / `.call(undefined)` still resolve through §10.4.3 (the
//     global object in sloppy code) rather than binding a raw nullish value;
//   - a real constructor reached through an `any` binding still constructs.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile and run `source`'s `test()` export on the standalone lane.
 *
 * `inferModuleStrictArguments: false` is not optional here: the probe's own
 * `export function test()` makes TypeScript classify the source as a module,
 * and module code is strict (§11.2.2) — so with the default EVERY function
 * under test would be strict and the sloppy arms could never be exercised.
 * The test262 harness passes the same flag for script-goal tests (#2119).
 */
async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4246.ts",
    target: "standalone",
    inferModuleStrictArguments: false,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

/** Same, for the JS-host (gc) lane — compile-only; the guards are lane-independent. */
async function compilesHosted(source: string): Promise<boolean> {
  const result = await compile(source, { fileName: "issue-4246.ts", inferModuleStrictArguments: false });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  return result.binary.length > 0;
}

/** 1 = did not throw, 2 = TypeError, 3 = some other throw, 4 = ReferenceError. */
function verdict(body: string): string {
  return `
    var verdict = 0;
    try {
      ${body}
      verdict = 1;
    } catch (e) {
      verdict = e instanceof TypeError ? 2 : (e instanceof ReferenceError ? 4 : 3);
    }
    export function test(): number { return verdict; }
  `;
}

/** Map a `typeof` result to a small integer a standalone module can return. */
function typeofVerdict(expr: string, prelude: string): string {
  return `
    ${prelude}
    export function test(): number {
      var t: any = ${expr};
      if (t === "undefined") return 1;
      if (t === "object") return 2;
      if (t === "number") return 3;
      if (t === "string") return 4;
      if (t === "boolean") return 5;
      if (t === "function") return 6;
      return 9;
    }
  `;
}

describe("#4246 — `new` on a non-constructor throws TypeError", () => {
  const primitives: [string, string][] = [
    ["a boolean literal", "new (true as any)();"],
    ["a number literal", "new (1 as any)();"],
    ["a string literal", "new ('s' as any)();"],
    ["null", "new (null as any)();"],
    ["undefined", "new (undefined as any)();"],
    ["a variable holding a primitive", "var x = true; new (x as any)();"],
  ];
  for (const [label, body] of primitives) {
    it(`throws for ${label}`, async () => {
      expect(await runStandalone(verdict(body))).toBe(2);
    });
  }

  it("throws for the result of another `new` (an ordinary object)", async () => {
    // `new new Boolean(true)` — the INNER construction must still run, so this
    // also pins the §13.3.5.1 evaluation order (constructor expression first).
    expect(await runStandalone(verdict("new (new Boolean(true) as any)();"))).toBe(2);
  });

  it("throws ReferenceError, not TypeError, for an unresolvable constructor", async () => {
    // §9.1.1.1 step 3 fires while EVALUATING the constructor expression, before
    // IsConstructor is ever consulted — a different error from a different step.
    expect(await runStandalone(verdict("new (nonexistentBinding as any)();"))).toBe(4);
  });

  it("still constructs a class reached through an `any` binding", async () => {
    // The negative case for the guard: an `any` fact is NOT a proof of
    // non-constructability, so the guard must decline and let the real
    // construction happen.
    const source = `
      class Point { v: number; constructor(v: number) { this.v = v; } }
      var C: any = Point;
      var p: any = new C(7);
      export function test(): number { return p.v === 7 ? 1 : 0; }
    `;
    expect(await runStandalone(source)).toBe(1);
  });

  it("still constructs a `function` declaration used as a constructor", async () => {
    const source = `
      function Point(v) { this.v = v; }
      var p: any = new (Point as any)(7);
      export function test(): number { return p.v === 7 ? 1 : 0; }
    `;
    expect(await runStandalone(source)).toBe(1);
  });

  it("compiles the same sources on the gc lane", async () => {
    expect(await compilesHosted(verdict("new (1 as any)();"))).toBe(true);
  });
});

describe("#4246 — sloppy `this` is ToObject(thisArg)", () => {
  const sloppy = "function bar() { return typeof this; }";
  const strict = "function foo() { 'use strict'; return typeof this; }";

  it("boxes a number receiver for a sloppy callee", async () => {
    expect(await runStandalone(typeofVerdict("(bar as any).call(1)", sloppy))).toBe(2);
  });

  it("boxes a string receiver for a sloppy callee", async () => {
    expect(await runStandalone(typeofVerdict("(bar as any).call('1')", sloppy))).toBe(2);
  });

  it("boxes a boolean receiver for a sloppy callee", async () => {
    expect(await runStandalone(typeofVerdict("(bar as any).call(true)", sloppy))).toBe(2);
  });

  it("boxes through `.apply` as well as `.call`", async () => {
    expect(await runStandalone(typeofVerdict("(bar as any).apply(1)", sloppy))).toBe(2);
  });

  it("preserves the wrapper's primitive value, not just its typeof", async () => {
    const source = `
      function bar() { return (this as any).valueOf() + 1; }
      export function test(): number { return (bar as any).call(41); }
    `;
    expect(await runStandalone(source)).toBe(42);
  });

  it("does NOT box for a strict callee — the receiver stays primitive", async () => {
    // The whole point of `10.4.3-1-1-s`: same call site, opposite answers,
    // decided by the CALLEE's strictness. A call-site test would pass while
    // this one fails.
    expect(await runStandalone(typeofVerdict("(foo as any).call(1)", strict))).toBe(3);
  });

  it("leaves a nullish receiver to §10.4.3 (sloppy ⇒ the global object)", async () => {
    // Boxing must not reach here: `null` is not ToObject'd to a wrapper, it is
    // REPLACED by the global object (#4190/#4203 own that answer).
    expect(await runStandalone(typeofVerdict("(bar as any).call(null)", sloppy))).toBe(2);
  });
});

describe("#4246 — an inlined function-expression callee binds its receiver", () => {
  it("routes a property WRITE through `this` to the passed receiver", async () => {
    const source = `
      var obj = new String("soap");
      (function () { this.touched = true; }).call(obj);
      export function test(): number { return (obj as any).touched === true ? 1 : 0; }
    `;
    expect(await runStandalone(source)).toBe(1);
  });

  it("does the same through `.apply`", async () => {
    const source = `
      var obj = new String("soap");
      (function () { this.touched = true; }).apply(obj);
      export function test(): number { return (obj as any).touched === true ? 1 : 0; }
    `;
    expect(await runStandalone(source)).toBe(1);
  });

  it("restores the enclosing frame's `this` after the inlined call", async () => {
    // The save/restore is invisible unless something reads `this` AFTER the
    // inline in the same frame. Here the outer method's `this` must survive.
    const source = `
      var target: any = {};
      class Holder {
        v: number = 5;
        run(): number {
          (function () { this.touched = true; }).call(target);
          return this.v;
        }
      }
      export function test(): number { return new Holder().run(); }
    `;
    expect(await runStandalone(source)).toBe(5);
  });

  it("leaves an ARROW callee alone — its `this` is lexical, not bindable", async () => {
    // Binding a receiver for an arrow would be a new wrong answer, not a fix:
    // §10.2.1.2 is never reached for one, so `.call(target)` on an arrow must
    // stay a plain invocation whose receiver is evaluated and discarded.
    const source = `
      var target: any = { tag: 2 };
      var arrow = () => 7;
      export function test(): number { return (arrow as any).call(target); }
    `;
    expect(await runStandalone(source)).toBe(7);
  });
});
