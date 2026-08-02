/**
 * #4071 — own-property ENUMERATION was dead in standalone for the two carrier
 * kinds that are not `$Object` hash maps.
 *
 * `__object_keys` (src/codegen/object-runtime-enumeration.ts) treats a
 * non-`$Object` receiver as "no properties". In standalone a real JS array is a
 * `__vec_<elemKind>` struct subtyping `$__vec_base` (#2186) and a class instance
 * is a closed nominal struct, so BOTH enumerated zero keys while their reads and
 * writes round-tripped correctly — a SILENT WRONG ANSWER, not a refusal.
 *
 *   Object.keys([10, 20, 30]).length   // was 0, spec says 3
 *   Object.keys(new C()).length        // was 0, spec says 2
 *
 * Both halves of the fix already existed for sibling helpers and were simply
 * never wired to this one — #3183's `fillDynamicForinVecArms` ($__vec_base arms
 * for `__object_keys_forin` / `__extern_has` / `__extern_get`) and
 * `fillClosedStructOwnPropertyNamesArms` (closed-struct arms for
 * `__getOwnPropertyNames`). The fix extends those two existing fills to also
 * cover `__object_keys`.
 *
 * Guarded here rather than only in test262 because the failure mode is a wrong
 * VALUE: nothing downstream can detect it, so only an assertion on the value
 * itself keeps it fixed.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile standalone, assert ZERO env imports, instantiate import-free, run test(). */
async function runHostFree(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  if (!r.success) return undefined;
  const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(envImports, `unexpected env imports: ${envImports.join(",")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Record<string, unknown> & { test?: () => unknown; _start?: () => void };
  exports._start?.();
  return exports.test?.();
}

describe("#4071 standalone own-property enumeration", () => {
  it("Object.keys enumerates array index keys", async () => {
    expect(
      await runHostFree(`export function test(): number {
        const a: any = [10, 20, 30];
        return Object.keys(a).length;
      }`),
    ).toBe(3);
  });

  it("Object.keys yields the index keys in ascending order, as strings", async () => {
    // Guards the VALUES, not just the count: a stringified digit is what
    // OrdinaryOwnPropertyKeys requires, and ascending integer order is the
    // spec's first ordering group (§10.1.11.1).
    expect(
      await runHostFree(`export function test(): number {
        const a: any = [10, 20, 30];
        const k: any = Object.keys(a);
        return k[0] === "0" && k[1] === "1" && k[2] === "2" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Object.keys on an empty array is still empty", async () => {
    expect(
      await runHostFree(`export function test(): number {
        const a: any = [];
        return Object.keys(a).length;
      }`),
    ).toBe(0);
  });

  it("Object.keys does NOT report the non-enumerable 'length'", async () => {
    // The sibling `__getOwnPropertyNames` DOES include "length"; `Object.keys`
    // must not. Sharing the fill must not blur that distinction.
    expect(
      await runHostFree(`export function test(): number {
        const a: any = [7, 8];
        const k: any = Object.keys(a);
        let sawLength = 0;
        for (let i = 0; i < k.length; i++) { if (k[i] === "length") sawLength = 1; }
        return sawLength;
      }`),
    ).toBe(0);
  });

  // Class instances are NOT fixed here. Sharing
  // `fillClosedStructOwnPropertyNamesArms` with `__object_keys` would fix them,
  // but it also leaks builtin struct internals (see the two guards below), so it
  // was measured and reverted. Documented as a known gap rather than asserted,
  // so that whoever lands the user-vs-builtin struct predicate can flip it.

  it("does NOT leak builtin struct internals: Object.keys(new Date(0))", async () => {
    // Regression guard for the reverted closed-struct sharing: this answered
    // ["timestamp"] with those arms shared. Spec says [] — Date's internal slot
    // is not an own enumerable property.
    expect(
      await runHostFree(`export function test(): number {
        const v: any = new Date(0);
        return Object.keys(v).length;
      }`),
    ).toBe(0);
  });

  it("does NOT leak builtin struct internals: Object.keys(/ab/)", async () => {
    // Answered 7 (internal RegExp fields) with the closed-struct arms shared.
    expect(
      await runHostFree(`export function test(): number {
        const v: any = /ab/;
        return Object.keys(v).length;
      }`),
    ).toBe(0);
  });

  it("Object.keys still enumerates a plain object (no regression)", async () => {
    expect(
      await runHostFree(`export function test(): number {
        const o: any = { a: 1, b: 2 };
        return Object.keys(o).length;
      }`),
    ).toBe(2);
  });

  it("Object.keys on a plain object built by assignment (no regression)", async () => {
    expect(
      await runHostFree(`export function test(): number {
        const o: any = {};
        o.p = 1;
        o.q = 2;
        return Object.keys(o).length;
      }`),
    ).toBe(2);
  });

  it("for-in over an array is unchanged by the shared fill", async () => {
    // `__object_keys_forin` already had the vec arm (#3183). The shared loop
    // must not disturb it.
    expect(
      await runHostFree(`export function test(): number {
        const a: any = [10, 20, 30];
        let n = 0;
        for (const k in a) { n++; }
        return n;
      }`),
    ).toBe(3);
  });

  it("getOwnPropertyNames on a class instance is unchanged", async () => {
    expect(
      await runHostFree(`export function test(): number {
        class C { a = 1; b = 2; }
        const v: any = new C();
        return Object.getOwnPropertyNames(v).length;
      }`),
    ).toBe(2);
  });

  it("the 15.2.3.14-6-1 shape now actually executes its assertions", async () => {
    // This test262 shape passed VACUOUSLY before: `Object.keys(denseArray)` was
    // empty, so `for (index in returnedArray)` ran ZERO assertions. Assert both
    // that comparisons now happen AND that they agree — a count alone would go
    // back to passing vacuously if enumeration broke again.
    expect(
      await runHostFree(`export function test(): number {
        const a: any = [1, 2, 3];
        const t: any = [];
        for (const p in a) { if (a.hasOwnProperty(p)) t.push(p); }
        const r: any = Object.keys(a);
        let compared = 0;
        let bad = 0;
        for (const i in r) { compared++; if (t[i] !== r[i]) bad++; }
        return compared === 3 && bad === 0 ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
