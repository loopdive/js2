// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3420 — element write to a frozen receiver.
 *
 * `Object.freeze(a); a[0] = 99` never consulted the frozen bit. The two
 * pre-existing `frozenVars` consults in `assignment.ts` both test
 * `ts.isPropertyAccessExpression`, so they only covered `o.x = v`;
 * `ElementAccessExpression` fell straight through to the vec store, which
 * stored anyway and grew the backing array for an index past the end.
 *
 * The originally filed symptom was an uncatchable `array element access out of
 * bounds` trap. That is gone on current main (#2744's integrity substrate plus
 * #3742/#3750). The defect these tests pin is the one measured 2026-07-31: a
 * SILENT successful write, which is worse than a trap because
 * `assert.throws(TypeError, …)` sees neither a throw nor a wrong value.
 *
 * Module code is always strict (§11.2.2), so every case below is a strict-mode
 * case: the write must throw a *catchable* TypeError. Each probe catches
 * in-Wasm and returns a code so we assert catchability, not merely "it trapped":
 *   1 = TypeError caught   2 = other throwable caught   0 = no throw
 *
 * Measured A/B on the same probe set: stock main 9/13 → fixed 13/13, the delta
 * being exactly the four frozen-element-write cases, with the nine
 * already-passing cases (controls, seal, isFrozen, frozen property write)
 * unchanged.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string): Promise<unknown> {
  const result = await compile(source);
  expect(result.success, `Compile failed: ${result.errors.map((e) => e.message).join("; ")}`).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as Record<string, () => unknown>).test!();
}

/** Standalone = pure Wasm. Asserts zero imports, then runs with an empty import object. */
async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, `Compile failed: ${result.errors.map((e) => e.message).join("; ")}`).toBe(true);
  expect(result.imports?.length ?? 0, "standalone module must declare no host imports").toBe(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, () => unknown>).test!();
}

const FROZEN_WRITE_THROWS = `export function test(): number {
  const a: number[] = [1, 2, 3];
  Object.freeze(a);
  try { a[0] = 99; } catch (e: any) { return e instanceof TypeError ? 1 : 2; }
  return 0;
}`;

const FROZEN_WRITE_LEAVES_VALUE = `export function test(): number {
  const a: number[] = [1, 2, 3];
  Object.freeze(a);
  try { a[0] = 99; } catch (e: any) {}
  return a[0];
}`;

const FROZEN_APPEND_THROWS = `export function test(): number {
  const a: number[] = [1, 2, 3];
  Object.freeze(a);
  try { a[3] = 9; } catch (e: any) { return e instanceof TypeError ? 1 : 2; }
  return 0;
}`;

const FROZEN_DOES_NOT_GROW = `export function test(): number {
  const a: number[] = [1, 2, 3];
  Object.freeze(a);
  try { a[3] = 9; } catch (e: any) {}
  return a.length;
}`;

describe("#3420 — element write to a frozen array", () => {
  it("throws a catchable TypeError (host)", async () => {
    expect(await runHost(FROZEN_WRITE_THROWS)).toBe(1);
  });

  it("leaves the existing element untouched", async () => {
    expect(await runHost(FROZEN_WRITE_LEAVES_VALUE)).toBe(1);
  });

  it("throws when appending past the end", async () => {
    expect(await runHost(FROZEN_APPEND_THROWS)).toBe(1);
  });

  it("does not grow the backing array", async () => {
    expect(await runHost(FROZEN_DOES_NOT_GROW)).toBe(3);
  });

  it("evaluates the RHS for its side effects before failing", async () => {
    // §13.15.2: the RHS is evaluated before Set is attempted, so `bump()` runs
    // even though the store never lands.
    expect(
      await runHost(`let n = 0;
        function bump(): number { n = n + 1; return 7; }
        export function test(): number {
          const a: number[] = [1, 2, 3];
          Object.freeze(a);
          try { a[0] = bump(); } catch (e: any) {}
          return n;
        }`),
    ).toBe(1);
  });

  it("evaluates the key expression for its side effects", async () => {
    expect(
      await runHost(`let k = 0;
        function idx(): number { k = k + 1; return 0; }
        export function test(): number {
          const a: number[] = [1, 2, 3];
          Object.freeze(a);
          try { a[idx()] = 5; } catch (e: any) {}
          return k;
        }`),
    ).toBe(1);
  });
});

describe("#3420 — standalone lane (host-free)", () => {
  it("throws a catchable TypeError with zero host imports", async () => {
    expect(await runStandalone(FROZEN_WRITE_THROWS)).toBe(1);
  });

  it("leaves the existing element untouched", async () => {
    expect(await runStandalone(FROZEN_WRITE_LEAVES_VALUE)).toBe(1);
  });

  it("does not grow the backing array", async () => {
    expect(await runStandalone(FROZEN_DOES_NOT_GROW)).toBe(3);
  });
});

describe("#3420 — non-regression", () => {
  it("an ordinary (unfrozen) element write still stores", async () => {
    expect(
      await runHost(`export function test(): number {
        const a: number[] = [1, 2, 3]; a[0] = 99; return a[0];
      }`),
    ).toBe(99);
  });

  it("an ordinary array still grows past its end", async () => {
    expect(
      await runHost(`export function test(): number {
        const a: number[] = [1, 2, 3]; a[5] = 7; return a.length;
      }`),
    ).toBe(6);
  });

  it("an unfrozen write does not throw", async () => {
    expect(
      await runHost(`export function test(): number {
        const a: number[] = [1, 2, 3];
        try { a[0] = 99; } catch (e: any) { return e instanceof TypeError ? 1 : 2; }
        return 0;
      }`),
    ).toBe(0);
  });

  it("Object.seal still permits writing an EXISTING element", async () => {
    // seal makes the object non-extensible but leaves existing data properties
    // writable — only freeze clears [[Writable]].
    expect(
      await runHost(`export function test(): number {
        const a: number[] = [1, 2, 3]; Object.seal(a); a[0] = 99; return a[0];
      }`),
    ).toBe(99);
  });

  it("Object.isFrozen still reports true", async () => {
    expect(
      await runHost(`export function test(): number {
        const a: number[] = [1, 2, 3]; Object.freeze(a); return Object.isFrozen(a) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("a frozen object PROPERTY write still throws (pre-existing path)", async () => {
    expect(
      await runHost(`export function test(): number {
        const o: any = { x: 1 };
        Object.freeze(o);
        try { o.x = 9; } catch (e: any) { return e instanceof TypeError ? 1 : 2; }
        return 0;
      }`),
    ).toBe(1);
  });

  it("freezing one array does not affect another", async () => {
    expect(
      await runHost(`export function test(): number {
        const a: number[] = [1, 2, 3];
        const b: number[] = [4, 5, 6];
        Object.freeze(a);
        b[0] = 99;
        return b[0];
      }`),
    ).toBe(99);
  });
});
