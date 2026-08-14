// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2046 — Standalone Reflect spec gaps (#1905 follow-up).
//
// PR-A (restore fail-loud):
//   - Reflect.get with an explicit receiver now threads that receiver through
//     the native accessor path. Reflect.set remains fail-loud until its
//     separate receiver/write semantics are implemented.
//   - Reflect.deleteProperty(primitive, k) returned true; §28.1.4 requires a
//     TypeError. Guarded at the call site (ref.test $Object) so the SHARED
//     __delete_property (also backing sloppy `delete`, a no-op success on
//     primitives) is untouched.
// PR-B (delete integrity/configurability preflight):
//   - __delete_property ignored sealed/frozen objects and per-entry
//     FLAG_CONFIGURABLE. Object.freeze/seal set only the object-level flag and
//     do NOT clear each entry's FLAG_CONFIGURABLE, so the preflight checks BOTH
//     the object OBJ_FLAG_SEALED bit and the per-entry FLAG_CONFIGURABLE bit.
//     Correct for both Reflect.deleteProperty and sloppy `delete`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  // Permissive stub for any unrelated env helper (none expected for these).
  const stub = new Proxy({}, { get: () => () => 0 });
  const { instance } = await WebAssembly.instantiate(r.binary, { env: stub } as unknown as WebAssembly.Imports);
  return (instance.exports as Record<string, () => number>).test();
}

async function expectCompileRefusal(source: string, needle: string): Promise<void> {
  const r = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, "expected a compile refusal but the module compiled").toBe(false);
  const joined = r.errors.map((e) => e.message).join("\n");
  expect(joined).toContain(needle);
}

async function expectThrows(source: string): Promise<void> {
  const r = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const stub = new Proxy({}, { get: () => () => 0 });
  const { instance } = await WebAssembly.instantiate(r.binary, { env: stub } as unknown as WebAssembly.Imports);
  expect(() => (instance.exports as Record<string, () => number>).test()).toThrow();
}

describe("#2046 standalone Reflect spec gaps", () => {
  // ── PR-A defect 1: explicit-receiver refusal ──────────────────────────────
  it("Reflect.get binds an accessor to its explicit receiver", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const target: any = {};
        Object.defineProperty(target, "x", {
          get: function (): number { return (this as any).value; },
        });
        const receiver: any = { value: 42 };
        return Reflect.get(target, "x", receiver) as number;
      }`),
    ).toBe(42);
  });

  it("Reflect.set with an explicit receiver is refused at compile time", async () => {
    await expectCompileRefusal(
      `export function test(): boolean {
        const o: any = { x: 1 };
        const recv: any = {};
        return Reflect.set(o, "x", 2, recv);
      }`,
      "Reflect.set with an explicit receiver",
    );
  });

  it("Reflect.get/set WITHOUT a receiver still compile and work", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        Reflect.set(o, "x", 41);
        return (Reflect.get(o, "x") as number) + 1;
      }`),
    ).toBe(42);
  });

  // ── PR-A defect 3a: non-object deleteProperty → TypeError ─────────────────
  it("Reflect.deleteProperty on a primitive throws a TypeError", async () => {
    await expectThrows(`export function test(): boolean {
      const n: any = 5;
      return Reflect.deleteProperty(n, "x");
    }`);
  });

  it("Reflect.deleteProperty on an object still returns true and deletes", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { x: 1 };
        const deleted = Reflect.deleteProperty(o, "x") ? 1 : 0;
        const gone = Reflect.has(o, "x") ? 0 : 2;
        return deleted + gone; // expect 3
      }`),
    ).toBe(3);
  });

  // ── PR-B: configurability / integrity preflight ───────────────────────────
  it("Reflect.deleteProperty on a frozen object returns false and keeps the property", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { x: 1 };
        Object.freeze(o);
        const refused = Reflect.deleteProperty(o, "x") ? 0 : 1;
        const kept = (Reflect.get(o, "x") as number) === 1 ? 2 : 0;
        return refused + kept; // expect 3
      }`),
    ).toBe(3);
  });

  it("Reflect.deleteProperty on a sealed object returns false and keeps the property", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { x: 1 };
        Object.seal(o);
        const refused = Reflect.deleteProperty(o, "x") ? 0 : 1;
        const kept = (Reflect.get(o, "x") as number) === 1 ? 2 : 0;
        return refused + kept; // expect 3
      }`),
    ).toBe(3);
  });

  it("preventExtensions does NOT make existing props non-configurable — delete still succeeds", async () => {
    expect(
      await runStandalone(`export function test(): boolean {
        const o: any = { x: 1 };
        Object.preventExtensions(o);
        return Reflect.deleteProperty(o, "x");
      }`),
    ).toBe(1);
  });

  it("strict module delete throws for a frozen property", async () => {
    await expectThrows(`export function test(): number {
      const o: any = { x: 1 };
      Object.freeze(o);
      return delete o.x ? 1 : 0;
    }`);
  });

  it("strict module delete on a configurable property still succeeds", async () => {
    expect(
      await runStandalone(`export function test(): boolean {
        const o: any = { x: 1 };
        return delete o.x;
      }`),
    ).toBe(1);
  });

  // ── S5: Reflect.getOwnPropertyDescriptor → native __getOwnPropertyDescriptor ──
  // §26.1.7 — routes the (target, key) pair to the same native that backs
  // standalone Object.getOwnPropertyDescriptor, restoring a data-descriptor
  // `$Object`. Replaces the #1472 Phase C refusal.
  it("Reflect.getOwnPropertyDescriptor reads back the data value", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { x: 7 };
        const d: any = Reflect.getOwnPropertyDescriptor(o, "x");
        return d.value as number;
      }`),
    ).toBe(7);
  });

  it("Reflect.getOwnPropertyDescriptor reports writable/enumerable/configurable for a plain data prop", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { x: 7 };
        const d: any = Reflect.getOwnPropertyDescriptor(o, "x");
        const w = d.writable ? 1 : 0;
        const e = d.enumerable ? 2 : 0;
        const c = d.configurable ? 4 : 0;
        return w + e + c; // expect 7 — all true for a literal data property
      }`),
    ).toBe(7);
  });

  it("Reflect.getOwnPropertyDescriptor returns undefined for a missing own property", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { x: 7 };
        const d: any = Reflect.getOwnPropertyDescriptor(o, "y");
        return d === undefined ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.getOwnPropertyDescriptor coerces a numeric key via ToPropertyKey (§7.1.19)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { "1": 5 };
        const d: any = Reflect.getOwnPropertyDescriptor(o, 1);
        return d.value as number;
      }`),
    ).toBe(5);
  });

  it("Reflect.getOwnPropertyDescriptor throws a TypeError on a non-object target (§26.1.7)", async () => {
    await expectThrows(`export function test(): number {
      const p: any = 5;
      Reflect.getOwnPropertyDescriptor(p, "x");
      return 0;
    }`);
  });

  // PR-D (numeric-key Reflect.get) is now subsumed by #2042 S1's __to_property_key
  // hardening — Reflect.get(o, 1) coerces the key to "1" instead of trapping on
  // the ref.cast $AnyString in __obj_hash. Regression-pin it here.
  it("Reflect.get coerces a numeric key via ToPropertyKey instead of trapping (PR-D / #2042 S1)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { "1": 42 };
        return Reflect.get(o, 1) as number;
      }`),
    ).toBe(42);
  });

  // ── #2046 defineProperty slice: route to the native __obj_define_from_desc ──
  // applier (the SAME path backing standalone Object.defineProperty, incl. the
  // #2372 descriptor-struct reify so INLINE object-literal descriptors work).
  it("Reflect.defineProperty applies a data descriptor (inline literal) and reads back", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        Reflect.defineProperty(o, "x", { value: 42, writable: true, enumerable: true, configurable: true });
        return o.x === 42 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.defineProperty returns the boolean true on success", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        return Reflect.defineProperty(o, "y", { value: 7 }) === true ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.defineProperty coerces a numeric key via ToPropertyKey", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        Reflect.defineProperty(o, 1, { value: 99, writable: true, enumerable: true, configurable: true });
        return o["1"] === 99 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.defineProperty applies an accessor descriptor (get runs on read)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        Reflect.defineProperty(o, "g", { get() { return 13; }, enumerable: true, configurable: true });
        return o.g === 13 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.defineProperty accepts a pre-built (dynamic) descriptor object", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { a: 1 };
        const d: any = { value: 5, writable: true, enumerable: true, configurable: true };
        Reflect.defineProperty(o, "z", d);
        return o.z === 5 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.defineProperty honors enumerable:false (key hidden from for-in)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        Reflect.defineProperty(o, "h", { value: 1, enumerable: false });
        let count = 0;
        for (const k in o) count++;
        return count === 0 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.defineProperty on a primitive target throws a catchable TypeError (§28.1.3 step 1)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        try { Reflect.defineProperty(5, "x", { value: 1 }); return 0; }
        catch (e) { return 1; }
      }`),
    ).toBe(1);
  });

  it("Reflect.defineProperty on a null target throws a catchable TypeError", async () => {
    expect(
      await runStandalone(`export function test(): number {
        try { Reflect.defineProperty(null, "x", { value: 1 }); return 0; }
        catch (e) { return 1; }
      }`),
    ).toBe(1);
  });

  // ── PR-C: Reflect.getPrototypeOf / setPrototypeOf (§26.1.8 / §26.1.14) ─────
  // Routed to the SAME natives backing standalone Object.getPrototypeOf
  // (__getPrototypeOf) / Object.setPrototypeOf (__object_setPrototypeOf).
  // Reflect/Object share the §10.1.2.1 OrdinarySetPrototypeOf semantics and the
  // closed-struct-vs-$Object substrate gap (#2580 M3): the round-trip is only
  // observable for dynamic ($any-typed / Object.create) objects, which is what
  // the test262 Reflect rows use — these tests pin that working path.

  it("Reflect.setPrototypeOf then getPrototypeOf round-trips by identity", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const proto: any = { m: 42 };
        const o: any = {};
        Reflect.setPrototypeOf(o, proto);
        return Reflect.getPrototypeOf(o) === proto ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.setPrototypeOf returns true on a successful set", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const proto: any = { m: 1 };
        const o: any = {};
        return Reflect.setPrototypeOf(o, proto) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.getPrototypeOf returns the proto set via Object.create", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const proto: any = { m: 7 };
        const o: any = Object.create(proto);
        return Reflect.getPrototypeOf(o) === proto ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.getPrototypeOf of a plain object is null (standalone models null proto)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { a: 1 };
        return Reflect.getPrototypeOf(o) === null ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.getPrototypeOf returns a stable identity across calls", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const proto: any = { m: 1 };
        const o: any = {};
        Reflect.setPrototypeOf(o, proto);
        return Reflect.getPrototypeOf(o) === Reflect.getPrototypeOf(o) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.setPrototypeOf with a null proto is legal and returns true (§26.1.14)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        return Reflect.setPrototypeOf(o, null) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.getPrototypeOf on a primitive throws a catchable TypeError (§26.1.8 step 1)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        try { Reflect.getPrototypeOf(5); return 0; }
        catch (e) { return 1; }
      }`),
    ).toBe(1);
  });

  it("Reflect.getPrototypeOf on undefined/null throws a catchable TypeError", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let caught = 0;
        try { Reflect.getPrototypeOf(undefined); } catch (e) { caught++; }
        try { Reflect.getPrototypeOf(null); } catch (e) { caught++; }
        return caught === 2 ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("Reflect.setPrototypeOf on a primitive target throws a catchable TypeError (§26.1.14 step 1)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        try { Reflect.setPrototypeOf(5, {}); return 0; }
        catch (e) { return 1; }
      }`),
    ).toBe(1);
  });

  it("Reflect.setPrototypeOf with a non-null primitive proto throws a catchable TypeError (§26.1.14 step 2)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = {};
        try { Reflect.setPrototypeOf(o, 42); return 0; }
        catch (e) { return 1; }
      }`),
    ).toBe(1);
  });

  // ── PR-C: Reflect.apply stays out of scope (no native call/spread analog) ──
  it("Reflect.apply is still refused at compile time in standalone (out of PR-C scope)", async () => {
    await expectCompileRefusal(
      `function add(a: number, b: number): number { return a + b; }
       export function test(): number {
         return Reflect.apply(add, undefined, [2, 3]);
       }`,
      "Reflect.apply not supported in standalone mode",
    );
  });
});
