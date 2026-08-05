// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4160 — prototype-index store (standalone): integer-index properties written
 * onto `Object.prototype` / `Array.prototype` must be visible through the
 * prototype chain, and a flag-clear module must carry NO trace of the
 * mechanism (the byte-identity guarantee, asserted structurally on the WAT).
 *
 * The P2/P3 shapes are the acceptance probes from the #4159 architect spec —
 * both measured failing on main (P3 → NaN; P2 → sum 2 / visits 2).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { main: () => unknown }).main();
}

describe("#4160 prototype-index store (standalone)", () => {
  it("P3: Object.prototype[1] = 111 is readable through a plain array-like", async () => {
    const r = await runStandalone(`
      export function main(): number {
        (Object.prototype as any)[1] = 111;
        const o: any = { length: 3 };
        return o[1];
      }
    `);
    expect(r).toBe(111);
  });

  it("P2: forEach.call visits the inherited index and skips the absent one", async () => {
    const r = await runStandalone(`
      export function main(): number {
        (Object.prototype as any)[1] = 111;
        const obj: any = { 0: 0, 2: 2, length: 3 };
        let sum = 0;
        let visits = 0;
        Array.prototype.forEach.call(obj, function (v: any) {
          sum += v;
          visits++;
        });
        return sum * 10 + visits;
      }
    `);
    expect(r).toBe(1133); // sum 113, visits 3
  });

  it("defineProperty(Object.prototype, index, {value}) lands and reads back", async () => {
    const r = await runStandalone(`
      export function main(): number {
        Object.defineProperty(Object.prototype, "1", { value: 55, configurable: true });
        const o: any = { length: 3 };
        return o[1];
      }
    `);
    expect(r).toBe(55);
  });

  it("OOB read on a real array resolves through the Array.prototype companion", async () => {
    const r = await runStandalone(`
      export function main(): number {
        (Array.prototype as any)[5] = 42;
        const arr: any = [1, 2];
        return arr[5];
      }
    `);
    expect(r).toBe(42);
  });

  it("the in-operator sees the inherited index", async () => {
    const r = await runStandalone(`
      export function main(): number {
        (Object.prototype as any)[1] = 111;
        const o: any = { length: 3 };
        return (1 in o ? 10 : 0) + (2 in o ? 1 : 0);
      }
    `);
    expect(r).toBe(10);
  });

  it("non-integer keys do not participate (canonical-integer gate)", async () => {
    const r = await runStandalone(`
      export function main(): number {
        (Object.prototype as any)["01"] = 5;
        (Object.prototype as any)[1.5] = 6;
        const o: any = { length: 3 };
        const a = o[1];
        return a === undefined ? -1 : a;
      }
    `);
    expect(r).toBe(-1);
  });

  it("dirty flag does not change dense-array HOF results (gate correctness)", async () => {
    const r = await runStandalone(`
      function red(a: any): number {
        return a.reduce(function (x: any, y: any) { return x + y; });
      }
      export function main(): number {
        (Object.prototype as any)[9] = 1;
        return red([5, 10, 20]);
      }
    `);
    expect(r).toBe(35);
  });

  it("__hof_ gate SKIP branch: callback shrink makes later indices absent -> skipped", async () => {
    // len is fixed at 3; pop() inside the callback shrinks the array, so i=2
    // is OOB -> HasProperty false (no proto entry in range) -> skipped.
    // Ungated (main) behaviour visits all 3 with an undefined read.
    const r = await runStandalone(`
      function visit(a: any): number {
        let visits = 0;
        a.forEach(function (v: any) { visits++; a.pop(); });
        return visits;
      }
      export function main(): number {
        (Object.prototype as any)[9] = 1; // dirty only
        return visit([10, 20, 30]);
      }
    `);
    expect(r).toBe(2);
  });

  it("__hof_ gate PROTO branch: vacated index resolves through Array.prototype", async () => {
    const r = await runStandalone(`
      function visit(a: any): number {
        let sum = 0;
        a.forEach(function (v: any) { sum += v; a.pop(); });
        return sum;
      }
      export function main(): number {
        (Array.prototype as any)[2] = 99;
        return visit([10, 20, 30]);
      }
    `);
    expect(r).toBe(129); // 10 + 20 + 99 (index 2 OOB after pop -> proto)
  });

  it("flag-clear module emits NO proto-index machinery (structural byte-identity witness)", async () => {
    // A dense loop + HOF + dynamic read program that never touches a prototype
    // index: the compiled WAT must contain no __protoidx_ symbol and no
    // proto-index companion global. This is the CI-durable form of the
    // branch-vs-main byte-identity A/B (which cannot run in CI).
    const result = await compile(
      `
      export function main(): number {
        const a = [1, 2, 3];
        let s = 0;
        for (let i = 0; i < a.length; i++) s += a[i];
        const o: any = { length: 3, 0: 1 };
        return s + (o[0] as number) + a.map((x) => x + 1).length;
      }
      `,
      { target: "standalone" },
    );
    expect(result.success).toBe(true);
    expect(result.wat).not.toContain("__protoidx_");
    expect(result.wat).not.toContain("protoidx_obj_companion");
  });
});
