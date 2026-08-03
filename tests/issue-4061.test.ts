// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * #4061 — `Object.create(proto, Properties)` never validated its descriptor
 * ARGUMENTS.
 *
 * `Object.defineProperty` and `Object.defineProperties` both run the §6.2.5.6
 * (ES5 §8.10.5) ToPropertyDescriptor checks — non-object descriptor, literal
 * `get: null` / `set: null`, and (via `isStaticDescWellFormed`, #3991) the
 * data+accessor conflict. `Object.create` carried its OWN parallel static
 * expansion in `call-builtin-static.ts` that consulted none of them, so every
 * one of those spec violations was silently *defined* rather than thrown:
 *
 * ```js
 * Object.create({}, {prop: null});             // defined nothing, threw nothing
 * Object.create({}, {prop: {get: null}});      // ACCESSOR flag + null value
 * Object.create({}, {prop: {get: f, value: 1}}); // HAS_VALUE *and* ACCESSOR
 * ```
 *
 * The fix routes anything `isStaticDescWellFormed` rejects to the dynamic
 * applier (the only path that implements ToPropertyDescriptor at all) and
 * emits the two throws that applier structurally cannot — a non-object
 * descriptor, which it treats as a lenient no-op, and a literal null accessor,
 * which is indistinguishable from the *legal* `{get: undefined}` at the wasm
 * boundary (#2106).
 *
 * Every case here is asserted in BOTH lanes: the JS-host lane and
 * `--target standalone`. The population that motivated the issue is
 * standalone-lane test262, but the defective expansion is lane-independent.
 */

import { describe, expect, it } from "vitest";

import { buildImports, compile, instantiateWasm } from "../src/index.js";

/** Compile + run `test()`, returning its number. Throws on compile failure. */
async function run(source: string, standalone: boolean): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4061.ts",
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

/**
 * Wrap a spec-violating `Object.create` call so the module reports 1 when it
 * threw and 0 when it did not. `assert.throws(TypeError, …)`, reduced.
 */
function throwsProbe(createCall: string): string {
  return `
var threw: number = 0;
try {
  ${createCall}
} catch (e) {
  threw = 1;
}
export function test(): number { return threw; }
`;
}

const LANES: Array<[string, boolean]> = [
  ["host", false],
  ["standalone", true],
];

describe("#4061 — Object.create descriptor-argument validation (§6.2.5.6)", () => {
  for (const [lane, standalone] of LANES) {
    describe(lane, () => {
      // §6.2.5.6 step 1 — the descriptor is not an Object.
      // test262: built-ins/Object/create/15.2.3.5-4-42.js
      it("throws TypeError when a descriptor is null", async () => {
        expect(await run(throwsProbe(`Object.create({}, { prop: null });`), standalone)).toBe(1);
      });

      it("throws TypeError when a descriptor is a primitive number", async () => {
        expect(await run(throwsProbe(`Object.create({}, { prop: 5 });`), standalone)).toBe(1);
      });

      it("throws TypeError when a descriptor is a primitive string", async () => {
        expect(await run(throwsProbe(`Object.create({}, { prop: "s" });`), standalone)).toBe(1);
      });

      // §6.2.5.6 step 7.b — `get` is present, not undefined, and not callable.
      // test262: built-ins/Object/create/15.2.3.5-4-258.js … -262.js
      it("throws TypeError for get: null", async () => {
        expect(await run(throwsProbe(`Object.create({}, { prop: { get: null } });`), standalone)).toBe(1);
      });

      it("throws TypeError for a boolean get", async () => {
        expect(await run(throwsProbe(`Object.create({}, { prop: { get: true } });`), standalone)).toBe(1);
      });

      it("throws TypeError for a numeric get", async () => {
        expect(await run(throwsProbe(`Object.create({}, { prop: { get: 42 } });`), standalone)).toBe(1);
      });

      // §6.2.5.6 step 8.b — same, for `set`.
      // test262: built-ins/Object/create/15.2.3.5-4-293.js … -300.js
      it("throws TypeError for set: null", async () => {
        expect(await run(throwsProbe(`Object.create({}, { prop: { set: null } });`), standalone)).toBe(1);
      });

      it("throws TypeError for a string set", async () => {
        expect(await run(throwsProbe(`Object.create({}, { prop: { set: "x" } });`), standalone)).toBe(1);
      });

      // §6.2.5.6 step 9.a — data and accessor fields are mutually exclusive.
      // test262: built-ins/Object/create/15.2.3.5-4-301.js … -304.js
      it("throws TypeError when get and value are both present", async () => {
        const src = throwsProbe(`
var g: any = function() { return 1; };
Object.create({}, { prop: { get: g, value: 12 } });`);
        expect(await run(src, standalone)).toBe(1);
      });

      it("throws TypeError when set and writable are both present", async () => {
        const src = throwsProbe(`
var s: any = function(v: any) {};
Object.create({}, { prop: { set: s, writable: true } });`);
        expect(await run(src, standalone)).toBe(1);
      });

      // LOUD STAYS LOUD, and legal stays legal — the gate must not start
      // refusing well-formed descriptors. `{get: undefined}` is a VALID accessor
      // descriptor, not a TypeError (that distinction is exactly why the null
      // case cannot be delegated to the runtime).
      it("does NOT throw for a well-formed data descriptor", async () => {
        const src = `
var o: any = Object.create({}, { prop: { value: 7, enumerable: true } });
export function test(): number { return o.prop; }
`;
        expect(await run(src, standalone)).toBe(7);
      });

      it("does NOT throw for a well-formed accessor descriptor", async () => {
        const src = `
var o: any = Object.create({}, { prop: { get: function() { return 9; } } });
export function test(): number { return o.prop; }
`;
        expect(await run(src, standalone)).toBe(9);
      });

      it("does NOT throw for get: undefined (a valid accessor descriptor)", async () => {
        expect(await run(throwsProbe(`Object.create({}, { prop: { get: undefined } });`), standalone)).toBe(0);
      });

      // Ordering: §20.1.2.3.1 walks the keys in order, so a descriptor that is
      // fine must be applied before a later one throws.
      it("applies earlier keys before throwing on a later bad descriptor", async () => {
        const src = `
var o: any = {};
var threw: number = 0;
try {
  o = Object.create({}, { good: { value: 3 }, bad: null });
} catch (e) {
  threw = 1;
}
export function test(): number { return threw; }
`;
        expect(await run(src, standalone)).toBe(1);
      });
    });
  }
});
