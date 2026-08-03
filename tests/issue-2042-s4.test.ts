import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2042 S4 — ValidateAndApplyPropertyDescriptor (§10.1.6.3) for the standalone
// native data-descriptor define (`__defineProperty_value`).
//
// Before S4 the native define inserted the `$PropEntry` unconditionally, so every
// invalid (re)definition silently SUCCEEDED instead of throwing a TypeError:
// redefining a non-configurable property, changing the value of a non-writable
// property, flipping configurable/enumerable, or adding a property to a
// non-extensible object. S4 adds a preflight that throws a catchable TypeError on
// each forbidden transition (spec §10.1.6.3 step order), before any table write.
// CompletePropertyDescriptor defaults (§6.2.6.4 — omitted attributes default to
// false on a fresh property) were already correct on insert and are pinned here.
//
// Receivers are produced via a helper fn (`mk()`) so they are genuinely dynamic
// `$Object` values — this avoids the separate dot-vs-bracket dual-storage path on
// empty `const o: any = {}` locals (a distinct, documented #2042 finding deferred
// behind the #2187 substrate work), keeping these assertions on the native
// `__defineProperty_value` path under test.
async function runStandalone(body: string): Promise<unknown> {
  const r = await compile(body, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error(`Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

const MK = "function mk(): any { return {}; }";

describe("#2042 S4 — ValidateAndApplyPropertyDescriptor (redefinition rules)", () => {
  it("redefining a non-configurable property throws a TypeError", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const o: any = mk();
          Object.defineProperty(o, "x", { value: 1, configurable: false });
          try { Object.defineProperty(o, "x", { value: 2 }); return 0; } catch (e) { return 1; }
        }`),
    ).toBe(1);
  });

  it("redefining a configurable property succeeds and updates the value", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const o: any = mk();
          Object.defineProperty(o, "x", { value: 1, configurable: true });
          Object.defineProperty(o, "x", { value: 2 });
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          return d.value as number;
        }`),
    ).toBe(2);
  });

  it("changing the value of a non-writable, non-configurable property throws", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const o: any = mk();
          Object.defineProperty(o, "x", { value: 1, writable: false, configurable: false });
          try { Object.defineProperty(o, "x", { value: 2 }); return 0; } catch (e) { return 1; }
        }`),
    ).toBe(1);
  });

  it("re-asserting the SAME value of a non-writable property is allowed (SameValue, no throw)", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const o: any = mk();
          Object.defineProperty(o, "x", { value: 1, writable: false, enumerable: false, configurable: false });
          try {
            Object.defineProperty(o, "x", { value: 1, writable: false, enumerable: false, configurable: false });
            return 1;
          } catch (e) { return 0; }
        }`),
    ).toBe(1);
  });

  it("flipping configurable false→true on a non-configurable property throws", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const o: any = mk();
          Object.defineProperty(o, "x", { value: 1, configurable: false });
          try { Object.defineProperty(o, "x", { value: 1, configurable: true }); return 0; } catch (e) { return 1; }
        }`),
    ).toBe(1);
  });

  it("flipping enumerable on a non-configurable property throws", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const o: any = mk();
          Object.defineProperty(o, "x", { value: 1, enumerable: false, configurable: false });
          try { Object.defineProperty(o, "x", { value: 1, enumerable: true }); return 0; } catch (e) { return 1; }
        }`),
    ).toBe(1);
  });

  it("adding a property to a non-extensible object throws", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const o: any = mk();
          Object.preventExtensions(o);
          try { Object.defineProperty(o, "x", { value: 1 }); return 0; } catch (e) { return 1; }
        }`),
    ).toBe(1);
  });

  it("a first define on a fresh object still succeeds and stores the value", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const o: any = mk();
          Object.defineProperty(o, "x", { value: 42 });
          return o.x as number;
        }`),
    ).toBe(42);
  });

  it("CompletePropertyDescriptor: omitted attributes on a fresh data desc default to false", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const o: any = mk();
          Object.defineProperty(o, "x", { value: 1 });
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          const w = d.writable ? 1 : 0;
          const e = d.enumerable ? 2 : 0;
          const c = d.configurable ? 4 : 0;
          return w + e + c; // expect 0 — all default false
        }`),
    ).toBe(0);
  });

  it("explicitly-specified attributes on a fresh data desc are preserved", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const o: any = mk();
          Object.defineProperty(o, "x", { value: 1, writable: true, enumerable: true, configurable: true });
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          const w = d.writable ? 1 : 0;
          const e = d.enumerable ? 2 : 0;
          const c = d.configurable ? 4 : 0;
          return w + e + c; // expect 7 — all true
        }`),
    ).toBe(7);
  });

  it("ordinary assignment changes only the value and preserves descriptor attributes", async () => {
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const o: any = mk();
          Object.defineProperty(o, "x", {
            value: 1,
            writable: true,
            enumerable: true,
            configurable: false,
          });
          o.x = 2;
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          return (d.value === 2 ? 1 : 0)
            + (d.writable === true ? 2 : 0)
            + (d.enumerable === true ? 4 : 0)
            + (d.configurable === false ? 8 : 0);
        }`),
    ).toBe(15);
  });

  it("a configurable property may be redefined even when currently non-writable", async () => {
    // configurable:true means ValidateAndApply permits any change, including a
    // value change on a non-writable property (§10.1.6.3 — the non-writable
    // restrictions only bind when the property is also non-configurable).
    expect(
      await runStandalone(`${MK}
        export function test(): number {
          const o: any = mk();
          Object.defineProperty(o, "x", { value: 1, writable: false, configurable: true });
          Object.defineProperty(o, "x", { value: 2 });
          const d: any = Object.getOwnPropertyDescriptor(o, "x");
          return d.value as number;
        }`),
    ).toBe(2);
  });
});
