// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * #4479 slice 2 — Annex B §B.2.2's four legacy accessor methods on
 * `Object.prototype` under `--target standalone`:
 * `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`,
 * `__lookupSetter__`.
 *
 * Before this slice nothing served them host-free: the value read answered
 * `undefined`, so `subject.__defineGetter__(k, f)` died with
 * `TypeError: called value is not a function`, and the whole
 * `built-ins/Object/prototype/__{define,lookup}{Getter,Setter}__` family was
 * **0 / 54** standalone.
 *
 * The implementation is entirely a composition of natives that already
 * existed (`__defineProperty_accessor`, `__getOwnPropertyDescriptor`,
 * `__getPrototypeOf`, `__to_property_key`, `__typeof_function`) — see
 * `src/codegen/object-proto-annex-b-accessors.ts`. Each test below pins the
 * spec step it depends on, because several of them are places where a
 * plausible simpler implementation is observably wrong:
 *
 *  - the define specifies exactly ONE of `[[Get]]`/`[[Set]]`, so redefining
 *    the getter of an existing accessor PRESERVES its setter;
 *  - the IsCallable check runs BEFORE ToPropertyKey, so a bad getter never
 *    triggers the key's `toString`;
 *  - the lookup answers `undefined` for a DATA property without needing an
 *    IsAccessorDescriptor test, because the descriptor's accessor half reads
 *    back `undefined` anyway.
 */

import { describe, expect, it } from "vitest";

import { buildImports, compile, instantiateWasm } from "../src/index.js";

/** Compile + run `test()`, returning its number. Throws on compile failure. */
async function run(source: string, standalone: boolean): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4479-s2.ts",
    ...(standalone ? { target: "standalone" as const } : {}),
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown"}`);
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  const test = (instance.exports as Record<string, () => number>).test;
  expect(test, "module exports test()").toBeTypeOf("function");
  return test();
}

const LANES: Array<[string, boolean]> = [
  ["host", false],
  ["standalone", true],
];

/**
 * This slice is STANDALONE-only by construction: every arm is `ctx.standalone`
 * -gated, because host mode routes an unknown method through the JS runtime's
 * `fixed-extern-method-call` shim and the four Annex B names are simply not in
 * its table (`method + " is not a function"`).
 *
 * That host gap is PRE-EXISTING, and this is measured, not assumed: the whole
 * file was run against a reverted tree (base `d0ae8a947`) and the host lane
 * produced the identical 7 failures / 5 passes, test for test. So these
 * `it.fails` pins record a standing host-runtime gap, not a regression from
 * this change — and they will start failing loudly the day the host shim
 * learns the names.
 */
const itStandaloneOnly = (standalone: boolean): typeof it | typeof it.fails => (standalone ? it : it.fails);

describe("#4479 slice 2 — Annex B Object.prototype accessor methods", () => {
  for (const [lane, standalone] of LANES) {
    describe(lane, () => {
      // ── §B.2.2.2 __defineGetter__ ─────────────────────────────────────────
      // test262: built-ins/Object/prototype/__defineGetter__/define-new.js
      itStandaloneOnly(standalone)("installs a getter and the §B.2.2.2 attributes", async () => {
        const src = `
var subject: any = {};
var get: any = function (): number { return 42; };
subject.__defineGetter__("acsr", get);
var d: any = Object.getOwnPropertyDescriptor(subject, "acsr");
export function test(): number {
  return subject.acsr === 42 && d.get === get && d.enumerable === true && d.configurable === true ? 1 : 0;
}
`;
        expect(await run(src, standalone)).toBe(1);
      });

      // The single-half `[[Get]] specified` flag bit is what makes this hold —
      // specifying both halves would clear the setter.
      // test262: __defineGetter__/define-existing.js
      itStandaloneOnly(standalone)("redefining the getter preserves the existing setter", async () => {
        const src = `
var subject: any = {};
var originalGet: any = function (): number { return 1; };
var originalSet: any = function (v: number): void {};
var newGet: any = function (): number { return 2; };
Object.defineProperty(subject, "acsr", {
  get: originalGet,
  set: originalSet,
  enumerable: false,
  configurable: true,
});
subject.__defineGetter__("acsr", newGet);
var d: any = Object.getOwnPropertyDescriptor(subject, "acsr");
export function test(): number {
  return d.get === newGet && d.set === originalSet && d.enumerable === true && d.configurable === true ? 1 : 0;
}
`;
        expect(await run(src, standalone)).toBe(1);
      });

      // test262: __defineSetter__/define-new.js
      it("installs a setter that receives the assigned value", async () => {
        const src = `
var subject: any = {};
var seen: number = 0;
subject.__defineSetter__("acsr", function (v: number): void { seen = v; });
subject.acsr = 7;
var d: any = Object.getOwnPropertyDescriptor(subject, "acsr");
export function test(): number {
  return seen === 7 && d.get === undefined && d.enumerable === true && d.configurable === true ? 1 : 0;
}
`;
        expect(await run(src, standalone)).toBe(1);
      });

      // ── §B.2.2.4 / §B.2.2.5 the [[Prototype]]-chain walk ──────────────────
      // test262: __lookupGetter__/lookup-own-acsr-w-getter.js
      itStandaloneOnly(standalone)("__lookupGetter__ finds an own accessor's getter", async () => {
        const src = `
var subject: any = {};
var get: any = function (): number { return 1; };
subject.__defineGetter__("target", get);
export function test(): number { return subject.__lookupGetter__("target") === get ? 1 : 0; }
`;
        expect(await run(src, standalone)).toBe(1);
      });

      // test262: __lookupGetter__/lookup-proto-acsr-w-getter.js — the walk must
      // cross TWO links (subject → intermediary → the accessor's holder).
      itStandaloneOnly(standalone)("__lookupGetter__ walks the prototype chain", async () => {
        const src = `
var root: any = {};
var get: any = function (): number { return 1; };
root.__defineGetter__("target", get);
var intermediary: any = Object.create(root);
var subject: any = Object.create(intermediary);
export function test(): number { return subject.__lookupGetter__("target") === get ? 1 : 0; }
`;
        expect(await run(src, standalone)).toBe(1);
      });

      // Step 4.b.ii: an own DATA property SHADOWS an inherited accessor and the
      // answer is `undefined`, not the inherited getter.
      // test262: __lookupGetter__/lookup-own-data.js
      it("__lookupGetter__ answers undefined for a shadowing data property", async () => {
        const src = `
var root: any = {};
root.__defineGetter__("target", function (): number { return 1; });
var subject: any = Object.create(root, { target: { value: 5 } });
export function test(): number { return subject.__lookupGetter__("target") === undefined ? 1 : 0; }
`;
        expect(await run(src, standalone)).toBe(1);
      });

      // test262: __lookupSetter__/lookup-own-acsr-w-setter.js
      itStandaloneOnly(standalone)("__lookupSetter__ finds the setter half only", async () => {
        const src = `
var subject: any = {};
var set: any = function (v: number): void {};
subject.__defineSetter__("target", set);
export function test(): number {
  return subject.__lookupSetter__("target") === set && subject.__lookupGetter__("target") === undefined ? 1 : 0;
}
`;
        expect(await run(src, standalone)).toBe(1);
      });

      // test262: __lookupGetter__/lookup-not-found.js
      itStandaloneOnly(standalone)("__lookupGetter__ answers undefined when the chain has no such key", async () => {
        const src = `
var subject: any = Object.create(Object.create({}));
export function test(): number { return subject.__lookupGetter__("missing") === undefined ? 1 : 0; }
`;
        expect(await run(src, standalone)).toBe(1);
      });

      // ── ordering + error steps ────────────────────────────────────────────
      // §B.2.2.2 step 2 precedes step 4, which `getter-non-callable.js` asserts
      // by counting the key's `toString` calls: it must still be 0.
      //
      // The success half is load-bearing, not padding: WITHOUT it this test
      // passed on the un-fixed base too, because there `__defineGetter__` was
      // `undefined` and calling it threw "called value is not a function" —
      // also a TypeError, also before any `toString`. A rejection-only pin
      // cannot tell "rejected for the right reason" from "not implemented".
      itStandaloneOnly(standalone)(
        "throws TypeError for a non-callable getter WITHOUT running ToPropertyKey",
        async () => {
          const src = `
var subject: any = {};
var toStringCount: number = 0;
var key: any = { toString: function (): string { toStringCount = toStringCount + 1; return "k"; } };
var threw: number = 0;
try {
  subject.__defineGetter__(key, 23);
} catch (e) {
  if (e instanceof TypeError) threw = 1;
}
var callableOk: number = 0;
subject.__defineGetter__("ok", function (): number { return 5; });
if (subject.ok === 5) callableOk = 1;
export function test(): number { return threw === 1 && toStringCount === 0 && callableOk === 1 ? 1 : 0; }
`;
          expect(await run(src, standalone)).toBe(1);
        },
      );

      // test262: __defineGetter__/this-non-obj.js — RequireObjectCoercible.
      // Same non-vacuity concern as above: on the un-fixed base `dg` was
      // `undefined`, so `dg.call(...)` threw a TypeError four times and a
      // rejection-only pin was green. The fifth assertion — a SUCCESSFUL
      // `.call` on a real receiver — is what makes it discriminating.
      itStandaloneOnly(standalone)("throws TypeError when `this` is null or undefined", async () => {
        const src = `
var dg: any = (Object.prototype as any).__defineGetter__;
var lg: any = (Object.prototype as any).__lookupGetter__;
var noop: any = function (): number { return 1; };
var count: number = 0;
try { dg.call(undefined, "k", noop); } catch (e) { if (e instanceof TypeError) count = count + 1; }
try { dg.call(null, "k", noop); } catch (e) { if (e instanceof TypeError) count = count + 1; }
try { lg.call(undefined, "k"); } catch (e) { if (e instanceof TypeError) count = count + 1; }
try { lg.call(null, "k"); } catch (e) { if (e instanceof TypeError) count = count + 1; }
var subject: any = {};
dg.call(subject, "k", noop);
if (lg.call(subject, "k") === noop) count = count + 1;
export function test(): number { return count; }
`;
        expect(await run(src, standalone)).toBe(5);
      });

      // DefinePropertyOrThrow's extensibility failure — a NEW key on a
      // non-extensible object must THROW, while an EXISTING key still succeeds.
      // test262: __defineGetter__/define-non-extensible.js
      itStandaloneOnly(standalone)("throws TypeError for a new key on a non-extensible object", async () => {
        const src = `
var noop: any = function (): number { return 1; };
var subject: any = Object.preventExtensions({ existing: null });
var existingOk: number = 0;
var threw: number = 0;
try { subject.__defineGetter__("existing", noop); existingOk = 1; } catch (e) { existingOk = 0; }
try { subject.__defineGetter__("brand new", noop); } catch (e) { if (e instanceof TypeError) threw = 1; }
export function test(): number { return existingOk === 1 && threw === 1 ? 1 : 0; }
`;
        expect(await run(src, standalone)).toBe(1);
      });

      // test262: __defineGetter__/{length,name}.js — the member's own function
      // metadata, which comes from the glue's arity table.
      it("reports the spec .length and .name for the four methods", async () => {
        const src = `
var p: any = Object.prototype;
export function test(): number {
  return p.__defineGetter__.length === 2 &&
    p.__defineSetter__.length === 2 &&
    p.__lookupGetter__.length === 1 &&
    p.__lookupSetter__.length === 1 &&
    p.__defineGetter__.name === "__defineGetter__" &&
    p.__lookupSetter__.name === "__lookupSetter__"
    ? 1 : 0;
}
`;
        expect(await run(src, standalone)).toBe(1);
      });
    });
  }

  // ── measured residual ────────────────────────────────────────────────────
  /**
   * A Proxy sitting in the MIDDLE of the prototype chain is severed at
   * `Object.create` time: `__object_create` keeps `$proto` only when the value
   * is a `$Object`, and a Proxy is not, so the link becomes null and the walk
   * ends one level early. That is the Proxy carrier representation (#2615 /
   * #4397), not the Annex B walk — the SAME test with the Proxy as the direct
   * receiver passes (`lookup-own-{get,proto}-err.js` both flip in this slice).
   * Pinned so the day the carrier lands, this file says so.
   *
   * test262 residuals: __lookup{Getter,Setter}__/lookup-proto-{get,proto}-err.js
   * and __define{Getter,Setter}__/define-abrupt.js — 6 of the 54.
   */
  it.fails("standalone: a Proxy in the middle of the chain still relays its traps", async () => {
    const src = `
var root: any = {};
var get: any = function (): number { return 1; };
root.__defineGetter__("target", get);
var intermediary: any = new Proxy(Object.create(root), {});
var subject: any = Object.create(intermediary);
export function test(): number { return subject.__lookupGetter__("target") === get ? 1 : 0; }
`;
    expect(await run(src, true)).toBe(1);
  });
});
