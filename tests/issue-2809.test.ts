// #2809 — uniform `undefined[]`/`void[]` externref representation.
//
// Carved from #2806: an `any[]`/`undefined[]` receiver lowers to an externref
// vec (the uniform externref-undefined representation, #2806 site #3). The
// construction/method sites must derive their element rep from that externref
// vec — emitting `$Hole`/`undefined` for holes/undefined, never the f64 sNaN
// sentinel — so the type-side (consumers, `.length`) and value-side
// (construction, method backing) agree.
//
// Site C regression fixed here: `compileArrayReduceRight` over a sparse
// (`[, , ,]`) externref vec with NO initial value. The seed/loop map a `$Hole`
// element to `undefined` via `holeToUndefinedInstrs`, which emits `__get_undefined`
// into a DETACHED body — its internal `flushLateImportShifts` patched that
// detached array, not the real body holding the callback closure's `ref.func`.
// `__get_undefined` first registering there silently consumed the late-import
// funcIdx shift, leaving the closure `ref.func` pointing at the wrong function →
// `call_ref` dereferenced a stale/null funcref and trapped ("dereferencing a
// null pointer"). Pre-ensuring `__get_undefined` before the closure is emitted
// fixes the desync (reference_1461 class). Regressed test262:
// `built-ins/Array/prototype/reduceRight/15.4.4.22-8-c-4.js`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runRet(src: string): Promise<unknown> {
  const r: any = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
  expect(r.binary).toBeTruthy();
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const imp: any = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imp);
  imp.setExports?.(instance.exports);
  return (instance.exports as any).test();
}

describe("#2809 — undefined[] externref representation", () => {
  it("reduceRight (no initial value) over a sparse hole array does not trap", async () => {
    // The regressed sparse-`[,,,]` reduceRight null-deref.
    expect(
      await runRet(`export function test(): number {
        var arr = [, , ,];
        arr.reduceRight(function () {});
        return 1;
      }`),
    ).toBe(1);
  });

  it("reduceRight (no initial value, 2-arg cb) over a sparse hole array does not trap", async () => {
    expect(
      await runRet(`export function test(): number {
        var arr = [, , ,];
        arr.reduceRight(function (a: any, b: any) { return a; });
        return 1;
      }`),
    ).toBe(1);
  });

  it("Array(undefined, undefined).length === 2", async () => {
    expect(await runRet(`export function test(): number { return Array(undefined, undefined).length; }`)).toBe(2);
  });

  it("new Array(undefined, undefined).length === 2 and sort() preserves length", async () => {
    expect(await runRet(`export function test(): number { return new Array(undefined, undefined).length; }`)).toBe(2);
    expect(
      await runRet(`export function test(): number { return new Array(undefined, undefined).sort().length; }`),
    ).toBe(2);
  });

  it("new Array(undefined, undefined) elements read back as undefined", async () => {
    expect(
      await runRet(
        `export function test(): number { var a: any[] = new Array(undefined, undefined); return (typeof a[0] === "undefined" && typeof a[1] === "undefined") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("numeric arrays and reduceRight are untouched", async () => {
    expect(await runRet(`export function test(): number { return Array(0, 1, 0, 1).length; }`)).toBe(4);
    expect(await runRet(`export function test(): number { return [1, 2, 3, 4].reduceRight((a, b) => a + b); }`)).toBe(
      10,
    );
    expect(
      await runRet(
        `export function test(): number { var a = [3, 1, 2].sort(); return a[0] * 100 + a[1] * 10 + a[2]; }`,
      ),
    ).toBe(123);
  });
});
