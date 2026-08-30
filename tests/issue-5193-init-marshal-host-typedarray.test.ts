import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * (#5193) A compiled value handed to a HOST TypedArray constructor from
 * TOP-LEVEL code (the wasm `start` section) had no marshalling path.
 *
 * `instance.exports` does not exist while the start section runs, and every
 * probe the runtime decodes a compiled value with (`__vec_len`, `__dv_byte_len`,
 * …) is an export — so `_marshalHostConstructArg` refused with
 * "cannot marshal opaque compiled value to host Float64Array constructor".
 * The same expression inside an exported function always worked, which is what
 * makes this a TIMING bug rather than a marshalling one.
 *
 * These cases therefore all put the construct at MODULE SCOPE. On base they
 * throw from `WebAssembly.instantiate`; the test function is never reached.
 */
async function run(source: string, ...args: unknown[]): Promise<unknown> {
  const result = await compile(source, { fileName: "issue-5193.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, (...values: unknown[]) => unknown>).test(...args);
}

describe("#5193 — host TypedArray construction during module init", () => {
  it("reads back a value written through a top-level Float64Array view", async () => {
    expect(
      await run(`
        const buffer = new ArrayBuffer(8);
        const doubles = new Float64Array(buffer);
        export function test(): number {
          doubles[0] = 1.5;
          return doubles[0];
        }
      `),
    ).toBe(1.5);
  });

  it("gives the top-level view the right length", async () => {
    expect(
      await run(`
        const doubles = new Float64Array(new ArrayBuffer(32));
        export function test(): number {
          return doubles.length;
        }
      `),
    ).toBe(4);
  });

  it("aliases sibling views built at module scope over one buffer", async () => {
    // jsbi's exact idiom: __kBitConversionDouble and __kBitConversionInts are
    // two module-scope views over __kBitConversionBuffer, and the library reads
    // the IEEE-754 bits of a double back through the Int32Array. 0x3FF80000 is
    // the high word of 1.5 — proof the two views share bytes rather than each
    // getting a private copy.
    expect(
      await run(`
        // @ts-nocheck
        class Bits {}
        Bits.buffer = new ArrayBuffer(8);
        Bits.doubles = new Float64Array(Bits.buffer);
        Bits.ints = new Int32Array(Bits.buffer);
        export function test(): number {
          Bits.doubles[0] = 1.5;
          return Bits.ints[1];
        }
      `),
    ).toBe(0x3ff80000);
  });

  it("still works when the buffer reaches the constructor as `any`", async () => {
    expect(
      await run(`
        // @ts-nocheck
        const holder = { buffer: new ArrayBuffer(8) };
        const doubles = new Float64Array(holder.buffer);
        export function test(): number {
          doubles[0] = -2.25;
          return doubles[0];
        }
      `),
    ).toBe(-2.25);
  });

  it("keeps the in-function path working (never regressed, guards the gate)", async () => {
    expect(
      await run(`
        export function test(): number {
          const view = new Float64Array(new ArrayBuffer(8));
          view[0] = 3.5;
          return view[0];
        }
      `),
    ).toBe(3.5);
  });
});
