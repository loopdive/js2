import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

// #739 Slice S1 — host-lane representation pinning (the store-unification).
//
// An empty-`{}` var (inferred type, NOT `: any` — an `any` annotation already
// disables widening) that is the receiver of an Object.defineProperty /
// defineProperties whose application lands in the RUNTIME STORE (accessor /
// no-value / explicit-undefined / dynamic descriptor / dynamic key / any
// defineProperties) must stay a host `$Object` — NOT be widened to a closed
// WasmGC struct. On `origin/main` such a var IS widened: the define routes to
// the runtime store while every later dot-read `obj.p` lowers to `struct.get`
// (a defined getter never fires → reads back `undefined`) and every dot-write
// `obj.p = X` to `struct.set` (a defined setter is bypassed). These are the
// exact #3230 read-lane (`15.2.3.6-3-207..230`) and write-lane (`-238..-260`)
// repros — verified failing on `origin/main`, passing here. S1 pins the
// receiver to the extern lane the bracket-form (`obj["p"]`) already proves
// correct. `(obj as any)` casts on the reads only satisfy `tsc` (the inferred
// `{}` type has no such member); they do not change the wasm lowering.
describe("#739 S1 — Object.defineProperty store-unification (representation pinning)", () => {
  it("dynamic accessor descriptor read lane fires the getter (#3230 minimal repro)", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const obj = {};
        const d0 = { get: function () { return "viaGetter"; } };
        Object.defineProperty(obj, "property", d0);
        return (obj as any).property;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("inline accessor literal read lane fires the getter", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const obj = {};
        Object.defineProperty(obj, "property", {
          get: function () { return "inlineGetter"; },
        });
        return (obj as any).property;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("setter accessor on empty-{} var fires on dot-write (write lane)", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const obj = {};
        let captured = "init";
        Object.defineProperty(obj, "property", {
          set: function (v: any) { captured = v; },
          get: function () { return captured; },
        });
        (obj as any).property = "overrideData";
        return (obj as any).property;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("get+set accessor round-trips through the one store", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = {};
        let store = 0;
        Object.defineProperty(obj, "x", {
          get: function () { return store + 1; },
          set: function (v: any) { store = v * 2; },
        });
        (obj as any).x = 10;
        return (obj as any).x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("dynamic (non-literal) data descriptor read-back is consistent", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = {};
        const desc = { value: 42, writable: true, enumerable: true, configurable: true };
        Object.defineProperty(obj, "k", desc);
        return (obj as any).k;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("no-value {writable:true} define then assignment reads back the write", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = {};
        Object.defineProperty(obj, "b", { writable: true });
        (obj as any).b = 11;
        return (obj as any).b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("explicit-undefined {value: undefined} define records the property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = {};
        Object.defineProperty(obj, "u", { value: undefined });
        // property PRESENT (1) with value undefined (2) → 3
        return ("u" in obj ? 1 : 0) + ((obj as any).u === undefined ? 2 : 0);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.defineProperties with an accessor descriptor fires the getter", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const obj = {};
        Object.defineProperties(obj, {
          p: { get: function () { return "viaDefineProperties"; }, enumerable: true },
          q: { value: "plain", enumerable: true },
        });
        return (obj as any).p + "|" + (obj as any).q;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("pure inline data-value define keeps the struct fast path correct (guard C)", async () => {
    // This shape is deliberately NOT pinned by S1 — an inline
    // `{ value: <literal>, ...boolean-literal flags }` data descriptor stays on
    // the struct fast path + flag side-channel. Locks the S1 boundary: the
    // read must still be correct on the (still-widened) struct receiver.
    await assertEquivalent(
      `
      export function test(): number {
        const obj = {};
        Object.defineProperty(obj, "x", {
          value: 99,
          writable: false,
          enumerable: true,
          configurable: false,
        });
        return (obj as any).x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
