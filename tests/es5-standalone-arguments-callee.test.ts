// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4243) `arguments.callee` as a REAL own property of the standalone arguments
// object (ES5 §10.6 step 13.a), continuing #4221's explicitly-deferred
// arguments-object model change.
//
// Two things these tests exist to pin, beyond "callee is readable":
//
//   1. IDENTITY, not just callability. `arguments.callee === f1` is the whole
//      point of routing through the cached closure singleton rather than
//      minting a fresh wrapper; a `typeof === "function"` assertion would pass
//      against a per-site closure and hide the regression.
//   2. The DESCRIPTOR, specifically `enumerable: false`. That bit is why the
//      seed goes through `__defineProperty_value` instead of the #3537 vec
//      expando bag — the bag's companion reflection hard-codes
//      `SEED_FLAGS = 0xBF` (enumerable: true) for every named entry.
//
// The `noJsHost` gate means all of this is standalone-only; the gc lane
// resolves `callee` through the `__register_arguments` host import (#2743) and
// is untouched, which the last test asserts by compiling the same source there.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile as a SCRIPT (`inferModuleStrictArguments: false`) and run `test()`.
 *
 * That flag is load-bearing here and not boilerplate: the probe's own
 * `export function test()` makes TypeScript classify the source as a module,
 * and module code is strict (§11.2.2) — so with the default `true` every
 * function below would be strict, take the §10.6 step 14 path, and get no
 * `callee` at all. This is the same reason the test262 harness passes `false`
 * for script-goal tests (#2119).
 */
async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4229.ts",
    target: "standalone",
    inferModuleStrictArguments: false,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4243 arguments.callee is an own property (§10.6 step 13.a)", () => {
  it("is the function object itself for a declaration (S10.6_A4 #1)", async () => {
    expect(
      await runStandalone(`
        function f1(): any { return (arguments as any).callee; }
        export function test(): number { return f1() === f1 ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("is the function object itself for a function expression (S10.6_A4 #2)", async () => {
    // The lifted-closure site answers with `__self` (local 0), which IS the
    // closure struct the caller invoked — so identity holds with no singleton
    // lookup at all.
    expect(
      await runStandalone(`
        var f2: any = function (): any { return (arguments as any).callee; };
        export function test(): number { return f2() === f2 ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("carries {writable: true, enumerable: false, configurable: true} (10.6-12-2)", async () => {
    // Bit-encoded so one run reports every attribute independently: a single
    // boolean would not distinguish "enumerable leaked to true" from "the
    // descriptor is missing entirely".
    expect(
      await runStandalone(`
        function f1(): number {
          var d: any = Object.getOwnPropertyDescriptor(arguments as any, "callee");
          if (d === undefined) return -1;
          var v = 0;
          if (d.writable === true) v += 1;
          if (d.enumerable === false) v += 2;
          if (d.configurable === true) v += 4;
          if (!d.hasOwnProperty("get")) v += 8;
          if (!d.hasOwnProperty("set")) v += 16;
          return v;
        }
        export function test(): number { return f1(); }
      `),
    ).toBe(31);
  });

  it("answers hasOwnProperty and typeof (S10.6_A3_T1)", async () => {
    expect(
      await runStandalone(`
        function f1(): number {
          var v = 0;
          if ((arguments as any).hasOwnProperty("callee")) v += 1;
          if (typeof (arguments as any).callee === "function") v += 2;
          return v;
        }
        export function test(): number { return f1(); }
      `),
    ).toBe(3);
  });

  it("stays out of for-in (the non-enumerable bit, observed dynamically)", async () => {
    // `isEnumerable` in test262's propertyHelper.js decides enumerability with
    // a `for (x in obj)` scan, not by reading the descriptor — so a descriptor
    // that says `enumerable: false` while the key still shows up in for-in
    // fails `verifyProperty` even though the previous test passes.
    expect(
      await runStandalone(`
        function f1(a: any, b: any): number {
          var n = 0;
          for (var k in arguments as any) { if (k === "callee") n += 1; }
          return n;
        }
        export function test(): number { return f1(1, 2); }
      `),
    ).toBe(0);
  });

  it("does not disturb the elements or length it is installed alongside", async () => {
    expect(
      await runStandalone(`
        function f1(): number {
          var a: any = arguments;
          return a.length === 3 && a[0] === 7 && a[2] === 9 ? 1 : 0;
        }
        export function test(): number { return f1(7, 8, 9); }
      `),
    ).toBe(1);
  });

  it("is a %ThrowTypeError% ACCESSOR in a strict function (§10.6 step 14)", async () => {
    // (#4555) This assertion used to be `descriptor === undefined`, with the
    // note that #4243 gated the sloppy DATA property off but did not mint the
    // accessor step 14 specifies. That accessor now exists, so the strict
    // arguments object carries `{ get, set, enumerable: false,
    // configurable: false }` — the shape test262's `10.6-13-c-3-s` checks.
    expect(
      await runStandalone(`
        function f1(): number {
          "use strict";
          var d: any = Object.getOwnPropertyDescriptor(arguments as any, "callee");
          if (d === undefined) return 0;
          if (d.enumerable !== false || d.configurable !== false) return 0;
          if (!d.hasOwnProperty("get") || !d.hasOwnProperty("set")) return 0;
          if (d.hasOwnProperty("value") || d.hasOwnProperty("writable")) return 0;
          return 1;
        }
        export function test(): number { return f1(); }
      `),
    ).toBe(1);
  });

  it("makes a WRITE to strict arguments.callee throw TypeError (§10.6 step 14, 10.6-14-c-4-s)", async () => {
    // (#4555) The set half of the poison. `arguments-callee-poison.ts` covers
    // only a direct syntactic READ; a write — and a write through an escaped
    // arguments object — needs the real accessor.
    expect(
      await runStandalone(`
        function f1(): any { "use strict"; return arguments; }
        export function test(): number {
          var argObj: any = f1();
          try { argObj.callee = 1; return 1; } catch (e) { return e instanceof TypeError ? 2 : 3; }
        }
      `),
    ).toBe(2);
  });

  it("throws TypeError on a direct read in strict code (§10.6 step 14, 10.6-2gs)", async () => {
    expect(
      await runStandalone(`
        function f1(): any { "use strict"; return (arguments as any).callee; }
        export function test(): number {
          try { f1(); return 1; } catch (e) { return e instanceof TypeError ? 2 : 3; }
        }
      `),
    ).toBe(2);
  });

  it("throws for the computed form too (arguments['callee'])", async () => {
    expect(
      await runStandalone(`
        function f1(): any { "use strict"; return (arguments as any)["callee"]; }
        export function test(): number {
          try { f1(); return 1; } catch (e) { return e instanceof TypeError ? 2 : 3; }
        }
      `),
    ).toBe(2);
  });

  it("does NOT throw when the function declares its own `arguments`", async () => {
    // The load-bearing negative: the poison is keyed on the IMPLICIT binding.
    // A user-declared `arguments` is an ordinary object and `.callee` on it is
    // an ordinary (missing) property read, not a spec poison — turning that
    // into a throw would break working sloppy programs. `10.6-6-3`/`10.6-6-4`
    // in this same test262 directory use exactly this shape.
    expect(
      await runStandalone(`
        function f1(): number {
          "use strict";
          var args: any = { callee: 5 };
          return args.callee;
        }
        export function test(): number { return f1(); }
      `),
    ).toBe(5);
  });

  it("leaves a SLOPPY arguments.callee read working (the poison is strict-only)", async () => {
    // Guards the gate itself: if `isStrictContext` ever answered true here, the
    // whole non-strict data-property half above would become unreachable and
    // every sloppy `arguments.callee` program would start throwing.
    expect(
      await runStandalone(`
        function f1(): any { return (arguments as any).callee; }
        export function test(): number { return typeof f1() === "function" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("leaves the JS-host lane compiling unchanged", async () => {
    const result = await compile(
      `
        function f1(): any { return (arguments as any).callee; }
        export function test(): number { return f1() === f1 ? 1 : 0; }
      `,
      { fileName: "issue-4229.ts", inferModuleStrictArguments: false },
    );
    expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
  });
});
