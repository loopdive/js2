import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #1966: Array.prototype.unshift mutates the array in place (§23.1.3.34) —
// prepend the items, shift the rest right, return the new length. It was never
// registered in ARRAY_METHODS, so it fell through to the host-import generic
// path that does not write the mutation back to the WasmGC vec: a silent no-op
// (host mode) / corruption (standalone). This adds the native lowering and
// includes unshift in the MUTATING write-back set.

async function evalNum(body: string): Promise<unknown> {
  const exports = await compileToWasm(body);
  return (exports as { test: () => unknown }).test();
}

describe("#1966 Array.prototype.unshift", () => {
  it("prepends a single element and grows the array", async () => {
    expect(await evalNum(`export function test(): number { const a = [2, 3]; a.unshift(1); return a.length; }`)).toBe(
      3,
    );
    expect(await evalNum(`export function test(): number { const a = [2, 3]; a.unshift(1); return a[0]; }`)).toBe(1);
    expect(await evalNum(`export function test(): number { const a = [2, 3]; a.unshift(1); return a[1]; }`)).toBe(2);
    expect(await evalNum(`export function test(): number { const a = [2, 3]; a.unshift(1); return a[2]; }`)).toBe(3);
  });

  it("returns the new length", async () => {
    expect(await evalNum(`export function test(): number { const a = [2, 3]; return a.unshift(1); }`)).toBe(3);
  });

  it("interacts correctly with shift (the original repro)", async () => {
    // [2,3] -> unshift(1) -> [1,2,3] -> shift() returns 1, leaving [2,3]
    expect(
      await evalNum(`export function test(): number { const a = [2, 3]; a.unshift(1); return a.shift() as number; }`),
    ).toBe(1);
    expect(
      await evalNum(`export function test(): number { const a = [2, 3]; a.unshift(1); a.shift(); return a[0]; }`),
    ).toBe(2);
  });

  it("prepends multiple elements in order", async () => {
    expect(await evalNum(`export function test(): number { const a = [3]; a.unshift(1, 2); return a.length; }`)).toBe(
      3,
    );
    expect(await evalNum(`export function test(): number { const a = [3]; a.unshift(1, 2); return a[0]; }`)).toBe(1);
    expect(await evalNum(`export function test(): number { const a = [3]; a.unshift(1, 2); return a[1]; }`)).toBe(2);
    expect(await evalNum(`export function test(): number { const a = [3]; a.unshift(1, 2); return a[2]; }`)).toBe(3);
  });

  it("unshifts into an empty array", async () => {
    expect(await evalNum(`export function test(): number { const a: number[] = []; a.unshift(5); return a[0]; }`)).toBe(
      5,
    );
    expect(
      await evalNum(`export function test(): number { const a: number[] = []; a.unshift(5); return a.length; }`),
    ).toBe(1);
  });

  it("no-arg unshift is a no-op returning the current length", async () => {
    expect(await evalNum(`export function test(): number { const a = [1, 2, 3]; return a.unshift(); }`)).toBe(3);
    expect(await evalNum(`export function test(): number { const a: number[] = []; return a.unshift(); }`)).toBe(0);
  });

  it("repeated unshifts keep order across reallocation", async () => {
    expect(
      await evalNum(
        `export function test(): number { const a = [5]; a.unshift(1); a.unshift(2); a.unshift(3); return a[0] * 100 + a[3]; }`,
      ),
    ).toBe(305); // [3,2,1,5] -> 3*100 + 5
  });

  it("mutates a module-global array (write-back path)", async () => {
    expect(await evalNum(`const g = [2, 3]; export function test(): number { g.unshift(1); return g.length; }`)).toBe(
      3,
    );
    expect(await evalNum(`const g = [2, 3]; export function test(): number { g.unshift(1); return g[0]; }`)).toBe(1);
    expect(await evalNum(`const g = [2, 3]; export function test(): number { g.unshift(1); return g[2]; }`)).toBe(3);
  });

  it("does not regress push / pop / shift on the same array", async () => {
    expect(
      await evalNum(
        `export function test(): number { const a = [1]; a.push(2); a.unshift(0); a.shift(); a.pop(); return a[0]; }`,
      ),
    ).toBe(1); // [1]->[1,2]->[0,1,2]->[1,2]->[1]
  });
});
