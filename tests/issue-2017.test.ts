import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

// (#2017) Writing to a getter-only object-literal property used to silently
// no-op (and, earlier, trap "illegal cast") instead of throwing the strict-mode
// TypeError the spec mandates (§13.15.2 → §10.1.9 OrdinarySetWithOwnDescriptor:
// an accessor with no [[Set]] → throw in strict code; ESM is always strict).
// The fix routes accessor-detected property writes through a strict host setter
// (`__extern_set_strict`) that throws a CATCHABLE TypeError; getter+setter pairs
// and ordinary writable properties are unaffected.

async function run<T = unknown>(src: string, fn: string): Promise<T> {
  const exports = (await compileAndInstantiate(src)) as Record<string, () => T>;
  return exports[fn]!();
}

describe("#2017 getter-only assignment", () => {
  it("assigning a getter-only object-literal property throws a catchable TypeError", async () => {
    const src = `
      const o: any = { get x() { return 1; } };
      export function t(): string {
        try { o.x = 99; return "set:" + o.x; } catch (e) { return "threw"; }
      }
    `;
    expect(await run<string>(src, "t")).toBe("threw");
  });

  it("getter+setter pair still routes the write to the setter", async () => {
    const src = `
      let store = 0;
      const o: any = { get x() { return store; }, set x(v: number) { store = v; } };
      export function t(): number { o.x = 42; return o.x; }
    `;
    expect(await run<number>(src, "t")).toBe(42);
  });

  it("the getter still returns its value after a rejected write", async () => {
    const src = `
      const o: any = { get x() { return 7; } };
      export function t(): number {
        try { o.x = 99; } catch (e) { /* swallow */ }
        return o.x;
      }
    `;
    expect(await run<number>(src, "t")).toBe(7);
  });

  it("the thrown error is a TypeError instance", async () => {
    const src = `
      const o: any = { get x() { return 1; } };
      export function t(): string {
        try { o.x = 5; return "no-throw"; }
        catch (e) { return (e instanceof TypeError) ? "TypeError" : "other"; }
      }
    `;
    expect(await run<string>(src, "t")).toBe("TypeError");
  });

  // (#2017 regression guard) The strict [[Set]] must NOT over-throw. These
  // writes go through the same `__extern_set_strict` path, but in sloppy/noStrict
  // SCRIPT context (the default for plain member writes) a write to a
  // non-writable DATA property silently no-ops — it must NOT throw. Regressed
  // test262 S8.5_A9 / S8.12.4_A1 / S8.6.1_A1 when the pre-check threw for
  // non-writable data props and the catch arm blanket-re-threw the engine's
  // strict TypeError.
  it("writing a non-writable built-in data property silently no-ops (no throw)", async () => {
    // Math.E is non-writable; `Math.E = 1` must be a silent no-op, leaving it
    // unchanged — NOT a TypeError.
    const src = `
      export function t(): number {
        const before = Math.E;
        (Math as any).E = 1;
        return Math.E === before ? 1 : 0;
      }
    `;
    expect(await run<number>(src, "t")).toBe(1);
  });

  it("writing the non-writable Number.NaN silently no-ops (no throw)", async () => {
    const src = `
      export function t(): number {
        (Number as any).NaN = 1;
        // NaN stays NaN (self-inequality) — the write did nothing.
        return Number.NaN !== Number.NaN ? 1 : 0;
      }
    `;
    expect(await run<number>(src, "t")).toBe(1);
  });
});
