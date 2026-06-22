import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { instantiateWasm } from "../src/runtime-instantiate.js";
import type { CompileOptions } from "../src/index.js";

// #2596 — standalone TypedArray/DataView `.buffer` accessor trapped `illegal
//   cast` at runtime. With no dedicated arm, `view.buffer` fell to the generic
//   `__extern_get(view, "buffer")` read whose externref result was `ref.cast` to
//   the i32_byte ArrayBuffer vec — but a `new TA(n)` view's backing is an f64/i8
//   vec (not an i32_byte buffer) and standalone has no real buffer object, so the
//   cast trapped, breaking EVERY `.buffer`-touching test.
//
//   Fix (non-trapping floor, §22.2/§25.x): synthesize a fresh i32_byte
//   ArrayBuffer vec whose byte length == the view's byte length
//   (element-count × BYTES_PER_ELEMENT for a TypedArray; the backing byte count
//   for a DataView, via a runtime `ref.test $__dv_window` branch for the
//   windowed/bare shapes). `.buffer.byteLength` now reads correctly and never
//   traps. TRUE write-through aliasing + `a.buffer === b.buffer` identity are
//   OUT OF SCOPE (need the unified byte-storage rep; pairs with #2593).
async function runStandalone(source: string): Promise<Record<string, Function>> {
  const opts: CompileOptions = { target: "standalone" };
  const result = await compile(source, opts);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const built = buildImports(result.imports, undefined, result.stringPool);
  // instantiateWasm trapping `illegal cast` on first `.buffer` touch is exactly
  // the bug this fixes — a clean instantiate + correct byteLength is the assertion.
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("#2596 — TypedArray .buffer.byteLength (no illegal cast, standalone)", () => {
  const cases: Array<[string, number, number]> = [
    ["Int32Array", 4, 16],
    ["Float64Array", 3, 24],
    ["Uint8Array", 10, 10],
    ["Int16Array", 5, 10],
    ["Int8Array", 7, 7],
    ["Int32Array", 0, 0], // empty — must not trap
  ];
  for (const [name, len, bytes] of cases) {
    it(`new ${name}(${len}).buffer.byteLength === ${bytes}`, async () => {
      const e = await runStandalone(`export function test(): number { return new ${name}(${len}).buffer.byteLength; }`);
      expect(e.test!()).toBe(bytes);
    });
  }

  it("`.buffer` stored to a local then read (byteLength === 16)", async () => {
    const e = await runStandalone(
      `export function test(): number {
         const a = new Int32Array(4);
         const buf = a.buffer;
         return buf.byteLength;
       }`,
    );
    expect(e.test!()).toBe(16);
  });
});

describe("#2596 — DataView .buffer.byteLength (bare + windowed, standalone)", () => {
  it("bare DataView(new ArrayBuffer(16)).buffer.byteLength === 16", async () => {
    const e = await runStandalone(
      `export function test(): number {
         const buf = new ArrayBuffer(16);
         return new DataView(buf).buffer.byteLength;
       }`,
    );
    expect(e.test!()).toBe(16);
  });

  it("windowed DataView(buf, 8, 16).buffer.byteLength === 16 (ref.test $__dv_window branch)", async () => {
    const e = await runStandalone(
      `export function test(): number {
         const buf = new ArrayBuffer(32);
         const dv = new DataView(buf, 8, 16);
         return dv.buffer.byteLength;
       }`,
    );
    expect(e.test!()).toBe(16);
  });
});
