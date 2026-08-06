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
 *
 * NOTE on the `as any` casts. A spec-violating descriptor cannot be SPELLED in
 * TypeScript without one — `Object.create`'s lib signature types `Properties`
 * as `PropertyDescriptorMap`, so a bare `{prop: null}` is a type error long
 * before codegen sees it, and these sources are compiled by the real front end.
 * Type assertions are erased, so `null as any` reaches codegen as exactly the
 * `null` the equivalent test262 JS produces — which is why the classifiers in
 * `descriptor-shape.ts` unwrap transparent expressions rather than parens
 * alone. The untyped-JS spelling is covered by the test262 measurement recorded
 * in the issue (16/17), not by this file.
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
        expect(await run(throwsProbe(`Object.create({}, { prop: null as any });`), standalone)).toBe(1);
      });

      it("throws TypeError when a descriptor is a primitive number", async () => {
        expect(await run(throwsProbe(`Object.create({}, { prop: 5 as any });`), standalone)).toBe(1);
      });

      it("throws TypeError when a descriptor is a primitive string", async () => {
        expect(await run(throwsProbe(`Object.create({}, { prop: "s" as any });`), standalone)).toBe(1);
      });

      // §6.2.5.6 step 7.b — `get` is present, not undefined, and not callable.
      // test262: built-ins/Object/create/15.2.3.5-4-258.js … -262.js
      it("throws TypeError for get: null", async () => {
        expect(await run(throwsProbe(`Object.create({}, { prop: { get: null as any } });`), standalone)).toBe(1);
      });
      // §6.2.5.6 step 8.b — same, for `set`.
      // test262: built-ins/Object/create/15.2.3.5-4-293.js … -300.js
      it("throws TypeError for set: null", async () => {
        expect(await run(throwsProbe(`Object.create({}, { prop: { set: null as any } });`), standalone)).toBe(1);
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
      // The data path must be untouched by the accessor reroute.
      it("still honours a plain data descriptor on the static path", async () => {
        const src = `
var o: any = Object.create({}, { a: { value: 1 }, b: { value: 2, enumerable: true } });
export function test(): number { return o.a + o.b; }
`;
        expect(await run(src, standalone)).toBe(3);
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
  o = Object.create({}, { good: { value: 3 }, bad: null as any });
} catch (e) {
  threw = 1;
}
export function test(): number { return threw; }
`;
        expect(await run(src, standalone)).toBe(1);
      });
    });
  }

  // ── standalone only ───────────────────────────────────────────────────────
  //
  // These are the cases whose TypeError (or working accessor) comes from the
  // DYNAMIC APPLIER rather than a compile-time throw. In standalone that is
  // `__obj_define_from_desc`, which implements ToPropertyDescriptor's callable
  // and conflict checks. In the JS-host lane the same route goes through the
  // `__defineProperty_desc` import, which does neither — measured, with
  // `Object.defineProperty` as the control:
  //
  //     defineProperty + get: fn       host 9    standalone 9    <- control works in BOTH
  //     create        + get: fn        host NaN  standalone 9
  //     defineProperty + get: true     host throws  standalone does NOT
  //     create        + get: true      host does NOT  standalone throws
  //
  // So the host gap is specific to what `Object.create` routes into, it is
  // PRE-EXISTING (before #4061 these descriptors took the static path and were
  // dropped just as silently), and this PR neither causes nor fixes it — it
  // only makes it reachable by more shapes. Tracked separately; asserting it
  // here would either fail or force the assertion to encode the bug.
  //
  // The control row also exposes the mirror-image gap: standalone
  // `Object.defineProperty` does NOT throw for a non-callable `get` while the
  // host does. Same tracking issue.
  describe("standalone (dynamic-applier cases)", () => {
    it("throws TypeError for a boolean get", async () => {
      expect(await run(throwsProbe(`Object.create({}, { prop: { get: true as any } });`), true)).toBe(1);
    });

    it("throws TypeError for a numeric get", async () => {
      expect(await run(throwsProbe(`Object.create({}, { prop: { get: 42 as any } });`), true)).toBe(1);
    });

    it("throws TypeError for a string set", async () => {
      expect(await run(throwsProbe(`Object.create({}, { prop: { set: "x" as any } });`), true)).toBe(1);
    });

    // An IDENTIFIER-valued, non-callable accessor. The old expansion accepted
    // any identifier-like get/set as "statically classifiable" and never
    // checked callability at all.
    // test262: built-ins/Object/create/15.2.3.5-4-297.js, -300.js
    it("throws TypeError for an identifier-valued non-callable set", async () => {
      const src = throwsProbe(`
var notCallable: any = {};
Object.create({}, { prop: { set: notCallable } });`);
      expect(await run(src, true)).toBe(1);
    });

    // §6.2.5.6 step 9.a — data and accessor fields are mutually exclusive.
    // test262: built-ins/Object/create/15.2.3.5-4-301.js … -304.js
    it("throws TypeError when get and value are both present", async () => {
      const src = throwsProbe(`
var g: any = function() { return 1; };
Object.create({}, { prop: { get: g, value: 12 } });`);
      expect(await run(src, true)).toBe(1);
    });

    it("throws TypeError when set and writable are both present", async () => {
      const src = throwsProbe(`
var s: any = function(v: any) {};
Object.create({}, { prop: { set: s, writable: true } });`);
      expect(await run(src, true)).toBe(1);
    });

    // Not merely "does not throw" — the getter must actually RUN. Before
    // #4061 this returned 0: the expansion set the ACCESSOR flag and called
    // `__defineProperty_value` with a null value, never compiling the getter.
    // A silent wrong answer, and the reason every accessor now leaves the
    // static path.
    it("honours a well-formed accessor descriptor (the getter runs)", async () => {
      const src = `
var o: any = Object.create({}, { prop: { get: function() { return 9; } } });
export function test(): number { return o.prop; }
`;
      expect(await run(src, true)).toBe(9);
    });

    it("honours an identifier-valued getter", async () => {
      const src = `
var g: any = function() { return 5; };
var o: any = Object.create({}, { prop: { get: g } });
export function test(): number { return o.prop; }
`;
      expect(await run(src, true)).toBe(5);
    });
  });
});
