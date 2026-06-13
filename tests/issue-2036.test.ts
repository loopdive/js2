// #2036 — standalone: `Array.prototype.<m>.call(arrayLike, …)` over a NON-array
// receiver (open `$Object`, `arguments`, `any`) used to emit invalid Wasm
// (`local.set expected f64, found externref`), a null-deref, or a silently
// wrong result (`indexOf` → -1) — violating the #1888 dual-mode invariant
// ("any uncertainty ⇒ fail loud, never invalid Wasm").
//
// Stage-1 fix (compileArrayPrototypeCall): in standalone/WASI mode, bail to the
// loud `#1888 Slice 3/4` refusal for non-array receivers (the typed fast paths
// and the `__extern_length`/`__extern_get_idx` host-import path can't handle
// them standalone), exactly like `map`/`reduce` already do. Genuine native
// arrays still compile; host mode is unchanged.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(source: string) {
  return compile(source, { target: "standalone", fileName: "test.ts" });
}

const REFUSAL = /not yet.*supported in --target standalone.*#1888|#1888 Slice/;

describe("#2036 standalone Array.prototype generics over array-like receivers", () => {
  it("refuses indexOf.call on an array-like object loudly (was invalid Wasm)", async () => {
    const r = await compileStandalone(`
      export function test(): number {
        const obj: any = { 0: 5, 5: "length", length: 6 };
        return Array.prototype.indexOf.call(obj, "length");
      }`);
    expect(r.success).toBe(false);
    expect(r.errors.some((e) => REFUSAL.test(e.message))).toBe(true);
  });

  it("refuses filter.call on an array-like object loudly (was invalid Wasm)", async () => {
    const r = await compileStandalone(`
      export function test(): number {
        const obj: any = { 0: 1, 1: 2, length: 2 };
        const out = Array.prototype.filter.call(obj, (x: any) => true);
        return out.length;
      }`);
    expect(r.success).toBe(false);
    expect(r.errors.some((e) => REFUSAL.test(e.message))).toBe(true);
  });

  it("refuses forEach.call on an array-like object loudly (was silently wrong: 0)", async () => {
    const r = await compileStandalone(`
      export function test(): number {
        const obj: any = { 0: 1, 1: 2, length: 2 };
        let s = 0;
        Array.prototype.forEach.call(obj, (x: any) => { s += 1; });
        return s;
      }`);
    expect(r.success).toBe(false);
    expect(r.errors.some((e) => REFUSAL.test(e.message))).toBe(true);
  });

  it("still compiles + runs indexOf.call on a GENUINE standalone array", async () => {
    const r = await compileStandalone(`
      export function test(): number {
        const a: number[] = [10, 20, 30];
        return Array.prototype.indexOf.call(a, 20);
      }`);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(1); // node: [10,20,30].indexOf(20) === 1
  });

  it("host mode is unchanged — the array-like call still compiles (no refusal)", async () => {
    // The host path keeps its existing (separately-tracked) behaviour; the only
    // requirement here is that the standalone refusal did NOT leak into host mode.
    const r = await compile(
      `export function test(): number {
        const obj: any = { 0: 5, 5: "length", length: 6 };
        return Array.prototype.indexOf.call(obj, "length");
      }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
  });
});
