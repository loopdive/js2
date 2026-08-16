// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4484) ES5 operator/coercion smalls — the four families this issue fixed,
 * plus `it.fails` pins for the residuals it measured and deliberately did not.
 *
 * Every module here is compiled `--target standalone` with `hostBridge: "always"`
 * and instantiated with NO host imports beyond the harness bridge, so a pin that
 * accidentally leaked an import would fail to instantiate rather than pass.
 *
 * None of these modules calls `eval` or `Function(body)` at runtime, so they run
 * unchanged under CI's `JS2WASM_EVAL_ENGINE=interpreter` REFUSAL provider (the
 * eval-tier hazard in `plan/method/es5-standalone-agent-brief.md` §5). The
 * `instanceof` rows that DO need a runtime eval tier live in test262, not here.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `src` standalone and run its exported `test`, returning the result. */
async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(`export function test(): number { ${src} }`, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#4484 A — instanceof: a non-callable RHS throws before the LHS is inspected", () => {
  // §7.3.20 OrdinaryHasInstance checks IsCallable(C) in step 1 and
  // `Type(V) is Object` only in step 3, so a primitive LHS does NOT excuse a
  // non-callable RHS. Before the fix the #2998 primitive-LHS fold ran first and
  // answered `false` (test262 `S11.8.6_A6_T2`).
  it("throws TypeError for `1 instanceof Math`", async () => {
    expect(
      await runStandalone(`
        try { const r = (1 as any) instanceof (Math as any); return r ? 2 : 3; }
        catch (e) { return e instanceof TypeError ? 1 : 4; }
      `),
    ).toBe(1);
  });

  it("throws TypeError for `1 instanceof JSON` as well", async () => {
    expect(
      await runStandalone(`
        try { const r = (1 as any) instanceof (JSON as any); return r ? 2 : 3; }
        catch (e) { return e instanceof TypeError ? 1 : 4; }
      `),
    ).toBe(1);
  });

  // The complement: a callable RHS must keep answering, not throw.
  it("still answers `false` for a primitive LHS against a real constructor", async () => {
    expect(await runStandalone(`return ((1 as any) instanceof Object) ? 2 : 1;`)).toBe(1);
  });
});

describe("#4484 A — instanceof: the non-callable throw yields to @@hasInstance", () => {
  // §13.10.2 consults @@hasInstance at step 2 and reaches the IsCallable throw
  // only at step 5, so "the RHS is a non-callable object" does not by itself
  // license a throw. Reordering the step-1 arm ahead of the primitive-LHS fold
  // (the fix in the describe above) widened it to primitive LHSs and turned
  // test262 `symbol-hasinstance-to-boolean.js` from a wrong VALUE into a wrong
  // THROW — invisible to a pass/fail sweep, since the row fails either way, but
  // catchable and therefore observable. `moduleInstallsCallableHasInstance`
  // declines the arm for any module that installs a callable handler.
  it("does NOT throw when the RHS carries a callable @@hasInstance", async () => {
    expect(
      await runStandalone(`
        const F: any = {};
        F[Symbol.hasInstance] = function () { return true; };
        try { const r = (0 as any) instanceof F; return r === true ? 1 : 2; }
        catch (e) { return 3; }
      `),
    ).not.toBe(3);
  });

  // The complement, and the row this issue FLIPS: `GetMethod` maps a `null`
  // property value to `undefined`, so step 4 is skipped and step 5's TypeError
  // is exactly right (test262 `symbol-hasinstance-not-callable.js`, measured
  // fail->pass). A guard that declined on any mention of `Symbol.hasInstance`
  // would give this row back for no correctness gain.
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

describe("#4484 A — instanceof: the static primitive-RHS fold declines on a reassigned binding", () => {
  // `var OBJECT = 0; OBJECT = Object` leaves the DECLARED type `number` while the
  // value is the real constructor. The §13.10.2 step-1 fold used to throw
  // "Right-hand side of 'instanceof' is not an object" on it — a WRONG throw,
  // observable in a `catch`. It must now decline to the runtime path instead.
  //
  // NOTE this asserts the ABSENCE of the wrong throw, not the spec's `true`:
  // answering `true` needs the plain-object → `Object.prototype` [[Prototype]]
  // edge, which is #4480's and is pinned as a residual below.
  it("does not throw for `(OBJECT = Object, {}) instanceof OBJECT`", async () => {
    expect(
      await runStandalone(`
        let OBJECT: any = 0;
        try { const r = ((OBJECT = Object, {}) as any) instanceof OBJECT; return r ? 1 : 2; }
        catch (e) { return 3; }
      `),
    ).toBe(2);
  });
});

describe("#4484 B — RequireObjectCoercible on a syntactic null/undefined receiver", () => {
  // §7.3.2 via GetValue on the member Reference. All four forms silently
  // returned a value before the fix (test262 `S11.2.1_A3_T4` / `_A3_T5`).
  const forms: ReadonlyArray<readonly [string, string]> = [
    ["undefined.toString()", `(undefined as any).toString();`],
    ["null.toString()", `(null as any).toString();`],
    ["undefined['toString']()", `(undefined as any)["toString"]();`],
    ["null['toString']()", `(null as any)["toString"]();`],
    ["undefined.foo", `const _v = (undefined as any).foo;`],
    ["null.foo", `const _v = (null as any).foo;`],
    ["undefined['foo']", `const _v = (undefined as any)["foo"];`],
  ];
  for (const [label, stmt] of forms) {
    it(`throws TypeError for \`${label}\``, async () => {
      expect(
        await runStandalone(`try { ${stmt} return 2; } catch (e) { return e instanceof TypeError ? 1 : 3; }`),
      ).toBe(1);
    });
  }

  // The guard is SYNTACTIC on purpose: a binding whose static type is
  // `undefined` must NOT throw, because the checker's flow type is routinely
  // wrong about a value written from a nested function (the `isEvolvingAnyBinding`
  // false positive in calls-guards.ts). This is the regression that would show up
  // if the guard were ever re-pointed at the static type.
  it("does NOT throw for a binding the checker merely types as undefined", async () => {
    expect(
      await runStandalone(`
        let probe: any;
        function fill() { probe = { toString: function () { return "ok"; } }; }
        fill();
        try { probe.toString(); return 1; } catch (e) { return 2; }
      `),
    ).toBe(1);
  });

  // Optional chaining short-circuits instead of throwing (§13.3.9).
  it("does NOT throw for `undefined?.foo`", async () => {
    expect(await runStandalone(`try { const _v = (undefined as any)?.foo; return 1; } catch (e) { return 2; }`)).toBe(
      1,
    );
  });

  // A binding named `undefined` shadows the global (it is not a reserved word),
  // so the receiver is an ordinary object and the guard must DECLINE. Asserted
  // as "no throw" rather than "the read returns 7": whether a property read off
  // a binding named `undefined` round-trips is a separate question this issue
  // neither measured nor changed (it returns a non-7 value on this base).
  it("does NOT throw when `undefined` is shadowed by a parameter", async () => {
    expect(
      await runStandalone(`
        function read(undefined: any): number { const _v = undefined.foo; return 1; }
        return read({ foo: 7 });
      `),
    ).toBe(1);
  });
});

describe("#4484 B — `<Builtin>.constructor` reads %Function% instead of refusing", () => {
  // These two were `compile_error` — the whole module refused
  // ("built-in static property value read is not supported"), failing test262
  // `S11.2.1_A4_T2` / `_A4_T6` over one read the spec answers uniformly:
  // a builtin constructor inherits `constructor` from `Function.prototype`.
  it("`typeof Object.constructor` is 'function'", async () => {
    expect(await runStandalone(`return typeof (Object as any).constructor === "function" ? 1 : 2;`)).toBe(1);
  });

  // `Boolean.constructor` is NOT pinned here even though test262 `S11.2.1_A4_T6`
  // (its JS lane) flipped compile_error→pass. In this TS harness the read never
  // reaches the standalone builtin-static arm this issue changed — it answers
  // `undefined` (probed: `typeof` is `"undefined"`, no compile error), a
  // pre-existing TS-lane divergence in a different dispatch path. Pinning it
  // would assert something this change does not control.

  it("`typeof Object['constructor']` is 'function'", async () => {
    expect(await runStandalone(`return typeof (Object as any)["constructor"] === "function" ? 1 : 2;`)).toBe(1);
  });
});

describe("#4484 C — strict-mode write to a builtin's non-writable own property", () => {
  // §10.1.9.2 step 2.b. The #3872 arm only mirrors properties the PROGRAM
  // defined via `Object.defineProperty`, so the spec-declared ones never reached
  // it and the write silently did nothing (test262 `11.13.1-4-28gs`, `-29gs`,
  // `11.13.1-4-6-s`: "no exception was thrown at all").
  it("throws TypeError for `Math.PI = 20` in strict code", async () => {
    expect(
      await runStandalone(`
        "use strict";
        try { (Math as any).PI = 20; return 2; } catch (e) { return e instanceof TypeError ? 1 : 3; }
      `),
    ).toBe(1);
  });

  // `Array.length` stands in for the §20.2.4.1 `<Ctor>.length` row. `Function`
  // itself is deliberately NOT used here: reading the bare `Function` value
  // links the module against `js2wasm:runtime-eval` (#4442), which this
  // import-free harness cannot instantiate. test262 `11.13.1-4-6-s` covers the
  // `Function.length` spelling in the lane that has the provider.
  it("throws TypeError for `Array.length = 42` in strict code", async () => {
    expect(
      await runStandalone(`
        "use strict";
        try { (Array as any).length = 42; return 2; } catch (e) { return e instanceof TypeError ? 1 : 3; }
      `),
    ).toBe(1);
  });

  it("throws TypeError for `Number.MAX_VALUE = 1` in strict code", async () => {
    expect(
      await runStandalone(`
        "use strict";
        try { (Number as any).MAX_VALUE = 1; return 2; } catch (e) { return e instanceof TypeError ? 1 : 3; }
      `),
    ).toBe(1);
  });

  // A writable builtin property must still be writable in strict code — the
  // table admits only `{[[Writable]]: false}` members.
  it("does NOT throw for a write to a WRITABLE builtin static", async () => {
    expect(
      await runStandalone(`
        "use strict";
        try { (Math as any).myExpando = 1; return 1; } catch (e) { return 2; }
      `),
    ).toBe(1);
  });

  // Shadowing: the receiver must be the intrinsic. A parameter named `Math` is
  // an ordinary object, so the guard must DECLINE — asserted as "no throw"
  // rather than "the write lands", because whether an untyped-parameter property
  // write round-trips in this harness is a separate question this issue neither
  // measured nor changed.
  it("does NOT throw when the builtin name is shadowed by a parameter", async () => {
    expect(
      await runStandalone(`
        "use strict";
        function write(Math: any): number { Math.PI = 20; return 1; }
        return write({ PI: 3 });
      `),
    ).toBe(1);
  });
});

describe("#4484 — measured residuals (routed, not fixed)", () => {
  // ROUTED TO #4480 (prototype-dependent). A plain object literal is created with
  // `$proto = null`, not the `Object.prototype` `$NativeProto` singleton, so the
  // §7.3.20 chain walk finds nothing. Probed directly on this branch:
  // `Object.getPrototypeOf({}) !== Object.prototype` and
  // `Object.prototype.isPrototypeOf({}) === false` through an indirection.
  // This is the single root cause behind test262
  // `S11.8.6_A2.4_T1`/`_T4` (dynamic `{} instanceof <Object alias>`),
  // `in/S8.12.6_A2_T1`/`_T2` (`"valueOf" in {}`) and
  // `types/object/S8.6.2_A1`/`_A2`.
  it.fails("`{} instanceof` a runtime-held Object constructor answers true", async () => {
    expect(
      await runStandalone(`
        let OBJECT: any = 0;
        OBJECT = Object;
        return (({} as any) instanceof OBJECT) ? 1 : 2;
      `),
    ).toBe(1);
  });

  it.fails("`Object.getPrototypeOf({})` is `Object.prototype`", async () => {
    expect(
      await runStandalone(`
        function ind(x: any): any { return x; }
        return Object.getPrototypeOf(ind({})) === Object.prototype ? 1 : 2;
      `),
    ).toBe(1);
  });

  // ROUTED TO #4480 as well — same missing edge, reached through `in`.
  it.fails("`'valueOf' in {}` finds the inherited Object.prototype method", async () => {
    expect(await runStandalone(`const o: any = {}; return ("valueOf" in o) ? 1 : 2;`)).toBe(1);
  });

  // RESIDUAL, LANE-SPECIFIC — the closed-struct-literal vs open-object divide,
  // NOT this issue's operator layer. Deliberately NOT pinned here: both shapes
  // below PASS in this TS harness (`: any` opens the object) and fail only in the
  // JS lane, where `{foo:"bar"}` lowers to a closed struct whose `foo` field is
  // typed `string`. Measured on the JS lane via `.tmp/probes/d3.js` / `d4.js`:
  //   `m.foo++` then `m.foo`      → `undefined`, want `NaN`  (`types/object/S8.6_A2_T1`, `_A3_T1`)
  //   for-in over a grown literal → count 1,     want 3      (`types/object/S8.6_A4_T1`)
  // An `it.fails` pin that passes is worse than no pin, so the record lives in
  // the issue file's `## Residuals` instead.

  // RESIDUAL — an assignment to an UNDECLARED global does not round-trip: the
  // implicit global is never created, so the read answers `undefined`. This is
  // what blocks test262 `S11.8.6_A2.4_T4` independently of the prototype edge.
  it.fails("an implicit global assignment is readable afterwards", async () => {
    expect(
      await runStandalone(`
        (globalThis as any).eval;
        IMPLICIT = Object;
        return typeof IMPLICIT === "function" ? 1 : 2;
      `),
    ).toBe(1);
  });
});
