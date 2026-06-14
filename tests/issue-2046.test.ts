// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2046 — Standalone Reflect spec gaps (#1905 follow-up).
//
// PR-A (restore fail-loud):
//   - Reflect.get/set with an explicit receiver were evaluated then SILENTLY
//     DROPPED (no receiver slot in __extern_get/__reflect_set), so accessor
//     get/set ran with `this = target` instead of `receiver`. Until real
//     receiver plumbing (PR-C, deferred), refuse loudly at compile time.
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
  it("Reflect.get with an explicit receiver is refused at compile time", async () => {
    await expectCompileRefusal(
      `export function test(): number {
        const o: any = { x: 1 };
        const recv: any = {};
        return Reflect.get(o, "x", recv) as number;
      }`,
      "Reflect.get with an explicit receiver",
    );
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

  it("sloppy delete also honors freeze (shared __delete_property)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { x: 1 };
        Object.freeze(o);
        const refused = (delete o.x) ? 0 : 1;
        const kept = o.x === 1 ? 2 : 0;
        return refused + kept; // expect 3
      }`),
    ).toBe(3);
  });

  it("sloppy delete on a normal object still succeeds", async () => {
    expect(
      await runStandalone(`export function test(): boolean {
        const o: any = { x: 1 };
        return delete o.x;
      }`),
    ).toBe(1);
  });
});
