// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4221) Function-invocation semantics: calling a non-callable must throw a
// TypeError instead of silently answering `undefined`, and a bound function's
// `caller`/`arguments` are poison pills.
//
// The three defects pinned here are each a "the program kept going with
// undefined" failure, which is exactly the class that hides in a conformance
// number: nothing crashes, the assertion just compares against the wrong value.
//
//   1. `o.bar()` on a missing method — standalone only. The gc lane routes
//      `__extern_method_call` through a host import where the engine throws,
//      so only the in-module object runtime had the hole.
//   2. `true()` / `null()` / `new Number(1)()` — both lanes; these fell to
//      `compileCallExpression`'s last-resort "graceful fallback" arm.
//   3. `boundFn.caller` / `boundFn.arguments = x` — ES5 §15.3.4.5 steps 20-21.
//
// The NEGATIVE tests are the load-bearing half. `nonCallableCallsStillDispatch`
// covers the shapes that look non-callable to the checker but are perfectly
// callable at runtime — most importantly the test262 *probe* idiom, where an
// implicit-any binding is written only from inside a nested function, so
// TypeScript's control-flow type at the call site is `undefined`. Throwing
// there would convert working programs into hard errors (measured: it flipped
// `language/statements/function/scope-param-rest-elem-var-close.js` from pass
// to fail during development).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `source` and run its `test()` export, returning the numeric result. */
async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-4221.ts", target: "standalone" });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

/**
 * Same, for the default JS-host (gc) lane. Only compilation is asserted: the
 * gc lane needs host imports to instantiate, and the point here is that the
 * lane-independent callee guard does not break host codegen.
 */
async function compilesHosted(source: string): Promise<boolean> {
  const result = await compile(source, { fileName: "issue-4221.ts" });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  return result.binary.length > 0;
}

/**
 * Wrap `body` so the result is 2 when it threw a TypeError, 3 when it threw
 * something else, and 1 when it did not throw at all. Written as a numeric
 * verdict because a standalone module cannot hand a string back to the host.
 */
function typeErrorProbe(body: string): string {
  return `
    var verdict = 0;
    try {
      ${body}
      verdict = 1;
    } catch (e) {
      verdict = e instanceof TypeError ? 2 : 3;
    }
    export function test(): number {
      return verdict;
    }
  `;
}

const THREW_TYPE_ERROR = 2;

describe("#4221 calling a non-callable throws TypeError", () => {
  it("throws when a method is absent on an open object (standalone)", async () => {
    expect(await runStandalone(typeErrorProbe(`var o = {}; o.bar();`))).toBe(THREW_TYPE_ERROR);
  });

  it("evaluates the argument list before the callable check (§13.3.6.2)", async () => {
    // `fooCalled` must be observably true even though the call throws — the
    // spec evaluates ArgumentListEvaluation BEFORE the IsCallable check. This
    // is what `language/expressions/call/11.2.3-3_1` asserts.
    expect(
      await runStandalone(`
        var fooCalled = false;
        function foo() { fooCalled = true; }
        var o = {};
        var threw = false;
        try {
          o.bar(foo());
        } catch (e) {
          threw = e instanceof TypeError;
        }
        export function test(): number {
          return (threw ? 2 : 0) + (fooCalled ? 1 : 0);
        }
      `),
    ).toBe(3);
  });

  it("throws for a primitive callee", async () => {
    expect(await runStandalone(typeErrorProbe(`true();`))).toBe(THREW_TYPE_ERROR);
    expect(await runStandalone(typeErrorProbe(`null();`))).toBe(THREW_TYPE_ERROR);
    expect(await runStandalone(typeErrorProbe(`var x = "s"; x();`))).toBe(THREW_TYPE_ERROR);
    expect(await runStandalone(typeErrorProbe(`var x = 1; x();`))).toBe(THREW_TYPE_ERROR);
  });

  it("throws for a freshly constructed wrapper object callee", async () => {
    expect(await runStandalone(typeErrorProbe(`new Number(1)();`))).toBe(THREW_TYPE_ERROR);
    expect(await runStandalone(typeErrorProbe(`var x = new String("1"); x();`))).toBe(THREW_TYPE_ERROR);
  });

  it("compiles the primitive-callee guard in the JS-host lane too", async () => {
    // The guard is lane-independent (it is a codegen-level decision, not a
    // runtime one); assert the host lane still produces a module with it.
    expect(await compilesHosted(typeErrorProbe(`true();`))).toBe(true);
  });
});

describe("#4221 calls that only LOOK non-callable still dispatch", () => {
  it("still calls a method installed dynamically on a plain object", async () => {
    expect(
      await runStandalone(`
        var o = {};
        o.bar = function () { return 7; };
        export function test(): number {
          return o.bar();
        }
      `),
    ).toBe(7);
  });

  it("still calls an implicit-any binding written only from a nested function", async () => {
    // THE test262 probe idiom. TypeScript's CFA reports `probe` as `undefined`
    // at the call site because the sole assignment lives inside `install`.
    expect(
      await runStandalone(`
        var probe;
        function install() { probe = function () { return 5; }; }
        install();
        export function test(): number {
          return probe();
        }
      `),
    ).toBe(5);
  });

  it("does not turn a bound-function callee into a static throw", async () => {
    // `bind` returns a callable, so `tryNonCallableValueCall` must decline —
    // the callee's fact is `function`, not a primitive. Asserted at the
    // COMPILE level rather than by running: calling a bound function still
    // null-derefs in standalone (a pre-existing gap this issue does not fix,
    // see `built-ins/Function/prototype/bind/S15.3.4.5_A1`), so a run-based
    // assertion here would be testing that unrelated bug, not this guard.
    const result = await compile(
      `
        function target(a: number, b: number): number { return a + b; }
        var bound = target.bind(null, 4);
        export function test(): number {
          return bound(3);
        }
      `,
      { fileName: "issue-4221.ts", target: "standalone" },
    );
    expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
    const wat = result.wat ?? "";
    expect(wat.length).toBeGreaterThan(0);
  });

  it("leaves an optional call short-circuiting rather than throwing", async () => {
    // The verdict distinguishes "did not throw" (1 or 9) from "threw" (3).
    // Which of 1/9 comes back depends on how the undefined sentinel compares,
    // which is orthogonal to this guard — the assertion is only that the
    // optional call is NOT rewritten into a TypeError.
    const verdict = await runStandalone(`
      var maybe;
      var verdict = 0;
      try {
        var r = maybe?.();
        verdict = r === undefined ? 9 : 1;
      } catch (e) {
        verdict = 3;
      }
      export function test(): number {
        return verdict;
      }
    `);
    expect(verdict).not.toBe(3);
  });
});

describe("#4221 a bound function poisons caller/arguments (§15.3.4.5 steps 20-21)", () => {
  it("throws on a `caller` read", async () => {
    expect(await runStandalone(typeErrorProbe(`function foo() {} var obj = foo.bind({}); var c = obj.caller;`))).toBe(
      THREW_TYPE_ERROR,
    );
  });

  it("throws on an `arguments` read", async () => {
    expect(
      await runStandalone(typeErrorProbe(`function foo() {} var obj = foo.bind({}); var a = obj.arguments;`)),
    ).toBe(THREW_TYPE_ERROR);
  });

  it("throws on a `caller` assignment", async () => {
    // `obj.caller` is declared `Function` in lib.d.ts, so the assigned value
    // has to type-check even though the assignment can never succeed at
    // runtime — the poison setter throws first.
    expect(
      await runStandalone(
        typeErrorProbe(`function foo() {} function other() {} var obj = foo.bind({}); obj.caller = other;`),
      ),
    ).toBe(THREW_TYPE_ERROR);
  });

  it("throws on an `arguments` assignment", async () => {
    expect(await runStandalone(typeErrorProbe(`function foo() {} var obj = foo.bind({}); obj.arguments = 12;`))).toBe(
      THREW_TYPE_ERROR,
    );
  });

  it("throws for a direct `f.bind(…).caller` read, with no intervening binding", async () => {
    expect(await runStandalone(typeErrorProbe(`function foo() {} var c = foo.bind({}).caller;`))).toBe(
      THREW_TYPE_ERROR,
    );
  });
});
