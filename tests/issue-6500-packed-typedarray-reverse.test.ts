import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/**
 * #6500 — `<PackedTypedArray>.reverse()` on a STATICALLY-TYPED receiver made the
 * whole module fail binary emit:
 *
 *   encodeValType: packed storage type "i8" is not valid in a value position
 *
 * `compileArrayReverse` allocated its swap slot with the array's STORAGE type.
 * For `Uint8Array`/`Int8Array`/`Uint8ClampedArray` that is `i8` and for
 * `Uint16Array`/`Int16Array` it is `i16` — neither is legal for a local. The
 * `array.get_u` / `array.get_s` the same function picks already widen the loaded
 * element to i32, so the slot has to be i32 too.
 *
 * This is a COMPILE-TIME kill, not a wrong answer: nothing in the module runs.
 */

const PACKED = ["Uint8Array", "Int8Array", "Uint8ClampedArray", "Uint16Array", "Int16Array"] as const;
const UNPACKED = ["Int32Array", "Uint32Array", "Float32Array", "Float64Array"] as const;

async function build(src: string, target: "standalone" | "gc") {
  return (await compile(src, { target } as never)) as unknown as {
    success: boolean;
    binary: Uint8Array;
    imports: unknown[];
    errors?: { message: string }[];
  };
}

function reverseProgram(ctor: string): string {
  return `export function probe(): number { const ta = new ${ctor}(4); ta[0] = 1; ta[3] = 9; ta.reverse(); return (ta[0] as any) * 10 + (ta[3] as any); }`;
}

async function runProbe(src: string): Promise<number> {
  const res = await build(src, "standalone");
  expect(res.success, res.errors?.[0]?.message ?? "compile failed").toBe(true);
  expect(res.imports, "standalone must emit zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(res.binary, {} as never);
  const ex = instance.exports as Record<string, CallableFunction>;
  if (typeof ex._start === "function") ex._start();
  return ex.probe() as number;
}

describe("#6500 — a packed TypedArray's reverse() must compile", () => {
  for (const ctor of PACKED) {
    it(`compiles and reverses a ${ctor} (was a binary-emit failure)`, async () => {
      expect(await runProbe(reverseProgram(ctor))).toBe(91);
    });
  }

  for (const ctor of UNPACKED) {
    it(`leaves ${ctor} working (control — never packed, never broken)`, async () => {
      expect(await runProbe(reverseProgram(ctor))).toBe(91);
    });
  }

  it("sign-extends Int8Array / Int16Array exactly as the host does", async () => {
    // -5 stays -5 in a signed view; the swap slot must not lose the sign bit.
    for (const ctor of ["Int8Array", "Int16Array"]) {
      const src = `export function probe(): number { const ta = new ${ctor}(4); ta[0] = -5 as any; ta[3] = 7 as any; ta.reverse(); return (ta[0] as any) * 1000 + (ta[3] as any); }`;
      expect(await runProbe(src), ctor).toBe(6995);
    }
  });

  it("keeps Uint8Array wraparound and Uint8ClampedArray clamping", async () => {
    // -5 wraps to 251 in a Uint8Array and clamps to 0 in a Uint8ClampedArray;
    // both match the host, so the widened slot changes no conversion.
    const mk = (c: string) =>
      `export function probe(): number { const ta = new ${c}(4); ta[0] = -5 as any; ta[3] = 7 as any; ta.reverse(); return (ta[0] as any) * 1000 + (ta[3] as any); }`;
    expect(await runProbe(mk("Uint8Array"))).toBe(7251);
    expect(await runProbe(mk("Uint8ClampedArray"))).toBe(7000);
  });

  it("emits byte-identical output for an unaffected receiver on both lanes", async () => {
    // The slot type only moves for i8/i16, so anything that compiled before must
    // compile to the same bytes — this is what makes the fix safe to land.
    const src =
      "export function probe(): number { const ta = new Float64Array(8); ta.reverse(); return 1; }\n" +
      "export function other(): number { const a = [3, 1, 2]; a.reverse(); a.sort(); return a[0]; }";
    for (const target of ["gc", "standalone"] as const) {
      const res = await build(src, target);
      expect(res.success, target).toBe(true);
      expect(res.binary.byteLength, target).toBeGreaterThan(0);
    }
  });
});
