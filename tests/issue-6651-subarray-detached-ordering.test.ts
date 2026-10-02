// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 — `%TypedArray%.prototype.subarray` on an identifier-backed dynamic
 * view must not take the ordinary ValidateTypedArray/materialize prelude.
 *
 * The Test262 `detached-buffer` row requires both index coercions after a
 * source is already detached; its eventual species construction then throws.
 * The byte-offset control preserves the separate rule that the source length
 * is snapped before `begin`, while the byte offset is formed before `end` can
 * detach the buffer. The latter result is not a claim that argument-expression
 * evaluation and coercion are interchangeable; each control only observes the
 * `valueOf` conversions that this lowering owns.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, { fileName: "issue-6651-subarray-detached-ordering.ts", target: "standalone" });
  expect(result.success, (result.errors ?? []).map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports.filter((entry) => entry.module === "env")).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

const dynamicFloat64 = `const ctors: any[] = [Float64Array]; const C: any = ctors[0];`;

describe("#6651 dynamic TypedArray subarray detached ordering", () => {
  it("coerces begin and end after a detached source, then propagates the constructor TypeError", async () => {
    expect(
      await run(`
        export function test(): number {
          ${dynamicFloat64}
          const buffer: any = new ArrayBuffer(16);
          const sample: any = new C(buffer);
          let steps = 0;
          const begin: any = { valueOf: function(): number { steps = steps * 10 + 1; return 0; } };
          const end: any = { valueOf: function(): number { steps = steps * 10 + 2; return 2; } };
          buffer.__detached__ = true;
          try { sample.subarray(begin, end); }
          catch (error) { steps = steps * 10 + (error instanceof TypeError ? 3 : 9); }
          return steps;
        }
      `),
    ).toBe(123);
  });

  it("snapshots source length before a begin coercion detaches the buffer", async () => {
    expect(
      await run(`
        export function test(): number {
          ${dynamicFloat64}
          const buffer: any = new ArrayBuffer(16);
          const sample: any = new C(buffer, 8, 1);
          const result: any = new C(0);
          const holder: any = {};
          let steps = 0;
          let observed = 0;
          holder[Symbol.species] = function(bufferArg: any, byteOffset: number, length: number): any {
            steps = steps * 10 + 3;
            observed = (bufferArg === buffer ? 100 : 0) + (byteOffset === 16 ? 10 : 0) + (length === 0 ? 1 : 0);
            return result;
          };
          sample.constructor = holder;
          const begin: any = { valueOf: function(): number { steps = steps * 10 + 1; buffer.__detached__ = true; return 1; } };
          const end: any = { valueOf: function(): number { steps = steps * 10 + 2; return 2; } };
          const actual: any = sample.subarray(begin, end);
          return steps * 1000 + (actual === result ? 1000 : 0) + observed;
        }
      `),
    ).toBe(124111);
  });

  it("forms the byte offset before end coercion detaches the buffer", async () => {
    expect(
      await run(`
        export function test(): number {
          ${dynamicFloat64}
          const buffer: any = new ArrayBuffer(16);
          const sample: any = new C(buffer, 8, 1);
          const result: any = new C(0);
          const holder: any = {};
          let steps = 0;
          let observed = 0;
          holder[Symbol.species] = function(bufferArg: any, byteOffset: number, length: number): any {
            steps = steps * 10 + 3;
            observed = (bufferArg === buffer ? 100 : 0) + (byteOffset === 16 ? 10 : 0) + (length === 0 ? 1 : 0);
            return result;
          };
          sample.constructor = holder;
          const begin: any = { valueOf: function(): number { steps = steps * 10 + 1; return 1; } };
          const end: any = { valueOf: function(): number { steps = steps * 10 + 2; buffer.__detached__ = true; return 0; } };
          const actual: any = sample.subarray(begin, end);
          return steps * 1000 + (actual === result ? 1000 : 0) + observed;
        }
      `),
    ).toBe(124111);
  });

  it("keeps an attached subarray as a shared dynamic view", async () => {
    expect(
      await run(`
        export function test(): number {
          ${dynamicFloat64}
          const sample: any = new C(3);
          sample[0] = 1; sample[1] = 2; sample[2] = 3;
          const child: any = sample.subarray(1, 3);
          child[0] = 9;
          return child.length * 100 + child[1] * 10 + sample[1];
        }
      `),
    ).toBe(239);
  });

  it("leaves map, filter, and slice on their existing materialized producer path", async () => {
    expect(
      await run(`
        export function test(): number {
          ${dynamicFloat64}
          const sample: any = new C(3);
          sample[0] = 1; sample[1] = 2; sample[2] = 3;
          const mapped: any = sample.map(function(value: number): number { return value + 1; });
          const filtered: any = sample.filter(function(value: number): boolean { return value > 1; });
          const sliced: any = sample.slice(1, 3);
          return mapped[2] * 100 + filtered.length * 10 + sliced[0];
        }
      `),
    ).toBe(422);
  });
});
