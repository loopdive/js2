// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651) `instanceof` consults `@@hasInstance` — the behavioural pin for the
 * `__instanceof_operator` wrapper (cluster I slice I2, commit 0c05cb16).
 *
 * That slice landed with test262 measurement but NO test in `tests/`, so every
 * property it established was unpinned. What it fixed is §13.10.2
 * InstanceofOperator step 2 (`GetMethod(C, @@hasInstance)`) and step 4 (call the
 * handler, ToBoolean the result) — both of which run BEFORE §7.3.20
 * OrdinaryHasInstance step 3 ever asks whether the left operand is an object,
 * and before the step-5 `IsCallable(C)` TypeError.
 *
 * `tests/issue-4484.test.ts` already pins the weaker half of this: that a module
 * installing a callable handler does not take the non-callable-RHS throw. It
 * asserts `.not.toBe(3)` — "did not throw" — and therefore stays green whether
 * the handler is invoked or silently ignored. The three test262 rows this issue
 * moved (`symbol-hasinstance-{invocation,to-boolean,get-err}.js`) all turn on
 * the part 4484 does not assert: that the handler actually RUNS, receives
 * `this === C` and the left operand as its argument, and that its return value
 * is ToBoolean-ed into the operator's answer.
 *
 * Every module is compiled `--target standalone` and instantiated with NO
 * imports, so a leaked host import fails instantiation rather than passing. None
 * of them calls `eval`/`Function(body)`, so they are independent of the
 * runtime-eval tier.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * (#4003 / #4621) Two macrotask yields between tests: each `it` compiles a
 * standalone module synchronously inside the vitest worker, and a run of those
 * back to back starves the event loop until the birpc reporter call
 * (`onTaskUpdate`) misses its deadline — a NONZERO vitest exit with every
 * assertion green. Same hook, same reason, as `issue-4484.test.ts`.
 */
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

/** Compile `src` standalone and run its exported `test`, returning the result. */
async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(`export function test(): number { ${src} }`, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6651 I2 — step 2/4: the handler is invoked, and it decides", () => {
  // test262 `symbol-hasinstance-invocation.js`. RED on 0c05cb16^: the #2998
  // primitive-LHS fold answered `false` for `0 instanceof F` without reading the
  // handler at all, so `count` stayed 0 (measured on this branch's base).
  it("invokes @@hasInstance for a PRIMITIVE left operand and returns its answer", async () => {
    expect(
      await runStandalone(`
        const F: any = {};
        let count = 0;
        F[Symbol.hasInstance] = function () { count = count + 1; return true; };
        const r = (0 as any) instanceof F;
        return (r === true && count === 1) ? 1 : (r === true ? 2 : (count === 1 ? 3 : 4));
      `),
    ).toBe(1);
  });

  // The handler's `false` must be honoured too — a fix that answered `true`
  // unconditionally once a handler exists would pass the test above.
  it("returns the handler's `false` for a primitive left operand", async () => {
    expect(
      await runStandalone(`
        const F: any = {};
        F[Symbol.hasInstance] = function () { return false; };
        return ((0 as any) instanceof F) ? 2 : 1;
      `),
    ).toBe(1);
  });

  // §13.10.2 step 4 is `Call(instOfHandler, C, « V »)`: the receiver is the RHS
  // and the single argument is the LEFT operand.
  it("passes the left operand as the argument", async () => {
    expect(
      await runStandalone(`
        const F: any = {};
        let seen: any = "unset";
        F[Symbol.hasInstance] = function (v: any) { seen = v; return true; };
        const _r = (7 as any) instanceof F;
        return seen === 7 ? 1 : 2;
      `),
    ).toBe(1);
  });

  it("calls the handler with `this` bound to the right-hand operand", async () => {
    expect(
      await runStandalone(`
        const F: any = {};
        let ok = false;
        F[Symbol.hasInstance] = function (this: any) { ok = (this === F); return true; };
        const _r = (0 as any) instanceof F;
        return ok ? 1 : 2;
      `),
    ).toBe(1);
  });

  // An OBJECT left operand takes the same step-2 route (the handler is consulted
  // before OrdinaryHasInstance, regardless of Type(V)).
  it("invokes the handler for an OBJECT left operand as well", async () => {
    expect(
      await runStandalone(`
        const F: any = {};
        let count = 0;
        F[Symbol.hasInstance] = function () { count = count + 1; return true; };
        const r = ({} as any) instanceof F;
        return (r === true && count === 1) ? 1 : 2;
      `),
    ).toBe(1);
  });
});

describe("#6651 I2 — step 4: ToBoolean(handler result)", () => {
  // test262 `symbol-hasinstance-to-boolean.js`. The operator returns
  // ToBoolean(result), never the raw value, so a truthy non-boolean is `true`
  // and a falsy non-boolean is `false`.
  const truthy: ReadonlyArray<readonly [string, string]> = [
    ["a non-empty string", `"x"`],
    ["a non-zero number", `1`],
    ["an object", `({})`],
  ];
  for (const [label, expr] of truthy) {
    it(`coerces ${label} to true`, async () => {
      expect(
        await runStandalone(`
          const F: any = {};
          F[Symbol.hasInstance] = function () { return ${expr}; };
          return ((0 as any) instanceof F) === true ? 1 : 2;
        `),
      ).toBe(1);
    });
  }

  const falsy: ReadonlyArray<readonly [string, string]> = [
    ["the empty string", `""`],
    ["zero", `0`],
    ["undefined", `undefined`],
    ["null", `null`],
  ];
  for (const [label, expr] of falsy) {
    it(`coerces ${label} to false`, async () => {
      expect(
        await runStandalone(`
          const F: any = {};
          F[Symbol.hasInstance] = function () { return ${expr}; };
          return ((0 as any) instanceof F) === false ? 1 : 2;
        `),
      ).toBe(1);
    });
  }
});

describe("#6651 I2 — step 2 is a GET, so an accessor spelling counts", () => {
  // The #4484 A gate (`moduleInstallsCallableHasInstance`) scanned for the
  // ASSIGNMENT spelling only. `Object.defineProperty(F, Symbol.hasInstance, …)`
  // installs the same handler and must take the same route.
  it("honours a handler installed via Object.defineProperty(value:)", async () => {
    expect(
      await runStandalone(`
        const F: any = {};
        Object.defineProperty(F, Symbol.hasInstance, {
          value: function () { return true; },
        });
        return ((0 as any) instanceof F) === true ? 1 : 2;
      `),
    ).toBe(1);
  });

  it("honours a handler reached through the getter", async () => {
    expect(
      await runStandalone(`
        const F: any = {};
        Object.defineProperty(F, Symbol.hasInstance, {
          get: function (): any { return function () { return true; }; },
        });
        return ((0 as any) instanceof F) === true ? 1 : 2;
      `),
    ).toBe(1);
  });

  // test262 `symbol-hasinstance-get-err.js`: step 2 is `GetMethod`, i.e. an
  // ordinary [[Get]], so an abrupt completion from the getter propagates OUT of
  // the operator. RED on 0c05cb16^, where this spelling took the #4484 A
  // non-callable-RHS arm and produced a TypeError instead ("Expected a
  // Test262Error but got a TypeError").
  // The thrown value is a TAGGED PLAIN OBJECT, not an Error subclass: the
  // assertion is "the getter's own abrupt completion came out", and reading a
  // marker property keeps it independent of whether `e instanceof RangeError`
  // itself answers correctly inside a module that installs a handler (that
  // question is the separate control below).
  it("propagates a throw from the @@hasInstance GETTER", async () => {
    expect(
      await runStandalone(`
        const F: any = {};
        Object.defineProperty(F, Symbol.hasInstance, {
          get: function (): any { throw { mark: 42 }; },
        });
        try { const _r = (0 as any) instanceof F; return 2; }
        catch (e) { return (e as any).mark === 42 ? 1 : 3; }
      `),
    ).toBe(1);
  });
});

describe("#6651 H2 — the installation scan looks through TypeScript type-only syntax", () => {
  // `as`/`satisfies`/`!`/parentheses erase at runtime, so they cannot change
  // whether a module installs a handler. They DID on this base: the key matcher
  // required a bare `Symbol.hasInstance` property access, so a cast spelling
  // read as "no handler in this module" and the #4484 A step-1 arm threw
  // `TypeError: Right-hand side of 'instanceof' is not callable` instead of
  // consulting the handler — a wrong THROW out of a correct program. These four
  // are RED on this branch's base and are the only rows this slice changes.
  const spellings: ReadonlyArray<readonly [string, string]> = [
    ["`as any` on an assignment key", `F[Symbol.hasInstance as any] = function () { return true; };`],
    ["a parenthesised key", `F[(Symbol.hasInstance)] = function () { return true; };`],
    [
      "`as any` on a defineProperty key",
      `Object.defineProperty(F, Symbol.hasInstance as any, { value: function () { return true; } });`,
    ],
    ['the `Symbol["hasInstance"]` spelling', `F[Symbol["hasInstance"]] = function () { return true; };`],
  ];
  for (const [label, install] of spellings) {
    it(`consults the handler installed with ${label}`, async () => {
      expect(
        await runStandalone(`
          const F: any = {};
          ${install}
          try { return ((0 as any) instanceof F) === true ? 1 : 2; }
          catch (e) { return 3; }
        `),
      ).toBe(1);
    });
  }
});

describe("#6651 I2 — the gate is MODULE-scoped, so the controls live here", () => {
  // The route is selected per SOURCE FILE: one module installing a handler
  // re-points EVERY `instanceof` site in that module at the wrapper. These pin
  // that the ordinary answers survive that re-pointing — the regression class a
  // per-row test262 count could hide.
  // NOTE these use `class`, not `function C() {}` + `new (C as any)()`. The
  // function-constructor spelling answers `false` in this TS harness WITH AND
  // WITHOUT a handler in the module (probed on this base), so it measures a
  // pre-existing unrelated gap rather than this route — an example of a
  // "control" that would have reported a regression that is not one.
  it("a class instanceof still answers true in a handler-installing module", async () => {
    expect(
      await runStandalone(`
        class K {}
        const F: any = {};
        F[Symbol.hasInstance] = function () { return true; };
        const o = new K();
        return (o instanceof K) ? 1 : 2;
      `),
    ).toBe(1);
  });

  it("a non-instance still answers false in a handler-installing module", async () => {
    expect(
      await runStandalone(`
        class K {}
        class L {}
        const F: any = {};
        F[Symbol.hasInstance] = function () { return true; };
        const o = new K();
        return (o instanceof L) ? 2 : 1;
      `),
    ).toBe(1);
  });

  it("a builtin instanceof still answers true in a handler-installing module", async () => {
    expect(
      await runStandalone(`
        const F: any = {};
        F[Symbol.hasInstance] = function () { return true; };
        const a: any = [1, 2];
        return (a instanceof Array) ? 1 : 2;
      `),
    ).toBe(1);
  });

  it("a primitive left operand against a handler-FREE constructor is still false", async () => {
    expect(
      await runStandalone(`
        const F: any = {};
        F[Symbol.hasInstance] = function () { return true; };
        return ((0 as any) instanceof Object) ? 2 : 1;
      `),
    ).toBe(1);
  });

  // GetMethod maps a `null`/`undefined` property to "no handler", so step 5's
  // IsCallable TypeError is exactly right. A wrapper that treated "the module
  // mentions Symbol.hasInstance" as "always defer to the handler" would lose
  // this (test262 `symbol-hasinstance-not-callable.js`).
  it("still throws TypeError when @@hasInstance is null", async () => {
    expect(
      await runStandalone(`
        const F: any = {};
        F[Symbol.hasInstance] = null;
        try { const _r = (0 as any) instanceof F; return 2; }
        catch (e) { return e instanceof TypeError ? 1 : 3; }
      `),
    ).toBe(1);
  });
});
