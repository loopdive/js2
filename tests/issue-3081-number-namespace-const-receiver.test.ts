/**
 * #3081 — a Number.prototype method called on a NAMESPACE-CONSTANT receiver
 * (`Number.NaN.toFixed(0)`, `Number.POSITIVE_INFINITY.toExponential(2)`, …) must
 * compile to VALID Wasm.
 *
 * `Number.NaN` / `Number.POSITIVE_INFINITY` / `Number.MAX_VALUE` are typed
 * `number` by the checker, so they enter the numeric `toFixed`/`toPrecision`/
 * `toExponential` lowering — but the value itself lowers through `__get_builtin`
 * to a BOXED-number **externref**, not an f64. Pre-fix, `emitNumberMethodReceiverF64`
 * only widened an i32 receiver and left an externref receiver un-coerced, so the
 * externref was fed straight to the `number_to*` runtime helper (which expects an
 * f64) → invalid Wasm at instantiate:
 *
 *   WebAssembly.instantiate(): Compiling function "f" failed:
 *   call[0] expected type f64, found call of type externref
 *
 * Fix: `emitNumberMethodReceiverF64` recovers an externref/ref receiver to f64 via
 * `__unbox_number` (the same helper the standalone Number-wrapper path uses).
 * An externref receiver was ALWAYS invalid Wasm here, so the unbox cannot regress
 * any previously-instantiable module.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runFn(source: string, exportName: string): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message ?? "?"}`);
  const importResult = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, importResult as any);
  importResult.setExports?.(instance.exports as any);
  return (instance.exports as any)[exportName]();
}

describe("#3081 — Number.prototype method on a namespace-constant receiver compiles to valid Wasm", () => {
  it("Number.NaN.toFixed(0) → 'NaN' (was invalid Wasm)", async () => {
    const src = `export function r(): string { return Number.NaN.toFixed(0 as any); }`;
    expect(await runFn(src, "r")).toBe("NaN");
  });

  it("Number.POSITIVE_INFINITY.toExponential(2) → 'Infinity' (was invalid Wasm)", async () => {
    const src = `export function r(): string { return Number.POSITIVE_INFINITY.toExponential(2 as any); }`;
    expect(await runFn(src, "r")).toBe("Infinity");
  });

  it("Number.NEGATIVE_INFINITY.toPrecision(3) → '-Infinity' (was invalid Wasm)", async () => {
    const src = `export function r(): string { return Number.NEGATIVE_INFINITY.toPrecision(3 as any); }`;
    expect(await runFn(src, "r")).toBe("-Infinity");
  });

  it("Number.MAX_SAFE_INTEGER.toFixed(0) → '9007199254740991'", async () => {
    const src = `export function r(): string { return Number.MAX_SAFE_INTEGER.toFixed(0 as any); }`;
    expect(await runFn(src, "r")).toBe("9007199254740991");
  });

  // Regression guards: primitive-number and i32 receivers still work unchanged.
  it("(5.5).toFixed(2) → '5.50' (primitive f64 receiver unchanged)", async () => {
    const src = `export function r(): string { const n: number = 5.5; return n.toFixed(2); }`;
    expect(await runFn(src, "r")).toBe("5.50");
  });

  it("(255).toString(16) → 'ff' (i32 receiver / radix path unchanged)", async () => {
    const src = `export function r(): string { return (255).toString(16); }`;
    expect(await runFn(src, "r")).toBe("ff");
  });
});
