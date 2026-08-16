// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * #4479 — plain-object (`$Object`) property-descriptor attribute semantics.
 *
 * Three independent defects, each one a place where a descriptor's fields were
 * read through a channel that could not see them, so the attributes were
 * silently replaced by CompletePropertyDescriptor defaults instead of being
 * honoured. All three are `$Object`-receiver lane; the `$Vec` / array-index
 * overlay is #3251's and is deliberately untouched here.
 *
 * 1. **`Object.defineProperties(obj, <object literal>)` handed the native a
 *    CLOSED STRUCT.** The `Properties` map's contextual type is
 *    `PropertyDescriptorMap`, so the literal compiled to a WasmGC struct. The
 *    native `__defineProperties` implements §20.1.2.3.1 over an `$Object` —
 *    it walks own keys and reads each descriptor field with `__desc_has_own` /
 *    `__extern_get` — and a struct carries no `$PropEntry`s, so every read
 *    missed. Same `$Object`-vs-struct mismatch #3253 fixed for
 *    `Object.create`'s per-key descriptor; the plural entry point never got it
 *    for the MAP itself.
 *
 * 2. **A numeric-literal key in that map was silently DROPPED.** The static
 *    expansion's `propName === undefined ⇒ continue` treated an unnameable key
 *    as "nothing to do", so `Object.defineProperties(obj, {0: {…}})` defined
 *    nothing and reported success — including when the define should have
 *    thrown for redefining a non-configurable property.
 *
 * 3. **`__obj_define_from_desc` collapsed a descriptor's `value: undefined` to
 *    NULL.** The `__nullish_to_null` normalization (#2106) is right for
 *    `writable`/`get`/… where null is the "absent" convention, and wrong for
 *    `value`, where `undefined` is a REAL value. The plural applier had opted
 *    out at #3991; the singular one had not, so a descriptor whose `value`
 *    read back `undefined` defined a property holding `null` and
 *    `typeof o.prop` answered `"object"`.
 *
 * The three fixes are independent — each test below names which one it pins.
 * Cases that still fail are pinned with `it.fails` and attributed in the issue
 * file's Residuals section.
 */

import { describe, expect, it } from "vitest";

import { buildImports, compile, instantiateWasm } from "../src/index.js";

/** Compile + run `test()`, returning its number. Throws on compile failure. */
async function run(source: string, standalone: boolean): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4479.ts",
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
 * The three fixes are all STANDALONE-gated, by construction and on purpose:
 *
 *  - the `Properties`-map materialization is `ctx.standalone`-only because in
 *    host mode `__defineProperties` is a real JS import that reads a struct
 *    across the boundary, so rebuilding the map would change emitted bytes for
 *    no behaviour;
 *  - `__obj_define_from_desc` is itself the standalone applier (host mode uses
 *    the `__defineProperty_desc` import).
 *
 * The host lane has its OWN, older gap in the same territory — a descriptor
 * held in a variable loses `value`/`writable`/`enumerable` there too — and it
 * is a different code path (#2668 Slice A's `emitDefinePropertyDescRuntime`
 * route, whose scope comment explicitly declines non-literal descriptors).
 * Measured on this branch's base AND after (see the issue's Residuals): the
 * host results are byte-for-byte the same before and after, so these are
 * pre-existing and NOT regressions. They are pinned `it.fails` rather than
 * deleted so the day the host route is fixed, this file says so.
 */
const itStandaloneOnly = (standalone: boolean): typeof it | typeof it.fails => (standalone ? it : it.fails);

describe("#4479 — plain-object descriptor attribute semantics", () => {
  for (const [lane, standalone] of LANES) {
    describe(lane, () => {
      // ── (1) the Properties map reached the applier as a struct ────────────
      // test262 shape: built-ins/Object/defineProperties/15.2.3.7-5-b-*
      itStandaloneOnly(standalone)("keeps `enumerable` from a descriptor held in a variable", async () => {
        const src = `
var obj: any = {};
var descObj: any = { enumerable: true };
Object.defineProperties(obj, { prop: descObj });
var d: any = Object.getOwnPropertyDescriptor(obj, "prop");
export function test(): number { return d && d.enumerable === true ? 1 : 0; }
`;
        expect(await run(src, standalone)).toBe(1);
      });

      itStandaloneOnly(standalone)("keeps `value` and `writable` from a descriptor held in a variable", async () => {
        const src = `
var obj: any = {};
var descObj: any = { value: 9, writable: true };
Object.defineProperties(obj, { prop: descObj });
var d: any = Object.getOwnPropertyDescriptor(obj, "prop");
export function test(): number { return d && d.value === 9 && d.writable === true ? 1 : 0; }
`;
        expect(await run(src, standalone)).toBe(1);
      });

      // The all-literal spelling was already correct — it must stay correct,
      // because the fix moves the MIXED spelling onto a different applier.
      it("still honours an all-literal Properties map", async () => {
        const src = `
var obj: any = {};
Object.defineProperties(obj, { a: { value: 1, enumerable: true }, b: { value: 2 } });
export function test(): number { return obj.a + obj.b; }
`;
        expect(await run(src, standalone)).toBe(3);
      });

      // Mixed literal + variable descriptors in ONE map: the literal half must
      // survive the reroute of the whole call.
      it("honours a map mixing a literal and a variable descriptor", async () => {
        const src = `
var obj: any = {};
var descObj: any = { value: 2 };
Object.defineProperties(obj, { a: { value: 1 }, b: descObj });
export function test(): number { return obj.a + obj.b; }
`;
        expect(await run(src, standalone)).toBe(3);
      });

      // ── (2) numeric-literal key in the Properties map ─────────────────────
      // test262 shape: built-ins/Object/defineProperties/15.2.3.7-6-a-93-*
      it("defines a numeric-literal key instead of dropping it", async () => {
        const src = `
var obj: any = {};
Object.defineProperties(obj, { 0: { value: 12 } } as any);
export function test(): number { return obj[0] === 12 ? 1 : 0; }
`;
        expect(await run(src, standalone)).toBe(1);
      });

      // ── (3) `value: undefined` must not become null ───────────────────────
      // test262 shape: built-ins/Object/create/15.2.3.5-4-162 … -165
      it("treats a descriptor `value` that reads back undefined as undefined", async () => {
        const src = `
var descObj: any = {};
Object.defineProperty(descObj, "value", { set: function (v: any): void {} });
var newObj: any = Object.create({}, { prop: descObj });
export function test(): number {
  return newObj.hasOwnProperty("prop") && typeof newObj.prop === "undefined" ? 1 : 0;
}
`;
        expect(await run(src, standalone)).toBe(1);
      });

      it("an explicit `value: undefined` defines undefined, not null", async () => {
        const src = `
var o: any = {};
var descObj: any = { value: undefined };
Object.defineProperty(o, "prop", descObj);
export function test(): number {
  return o.hasOwnProperty("prop") && typeof o.prop === "undefined" ? 1 : 0;
}
`;
        expect(await run(src, standalone)).toBe(1);
      });

      // A real (non-undefined) value through the same applier must be
      // unaffected — the opt-out is scoped to the `value` field's nullish
      // normalization, not to the field read.
      itStandaloneOnly(standalone)("still stores a real value through the dynamic applier", async () => {
        const src = `
var o: any = {};
var descObj: any = { value: 41, enumerable: true };
Object.defineProperty(o, "prop", descObj);
var d: any = Object.getOwnPropertyDescriptor(o, "prop");
export function test(): number { return d.value === 41 && d.enumerable === true ? 1 : 0; }
`;
        expect(await run(src, standalone)).toBe(1);
      });
    });
  }
});
