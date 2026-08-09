import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #2651 M1 / D2 — standalone: `<TypedArrayView>.prototype` as a first-class
//   readable VALUE (host-free).
//
// The ctor-iteration harness (`test262/harness/testTypedArray.js`) + the
// runner's `needsTypedArrayBinding` shim build
//   `const TypedArray = Object.getPrototypeOf(Int8Array.prototype).constructor;`
// then `propertyHelper.js`'s `verifyProperty(TypedArray.prototype.<m>, …)` reads
// `<View>.prototype` (and its members) AS A VALUE. Pre-#2651 every such read hit
// the `#1907 / #1888 S6-b` `<View>.prototype built-in static property value read`
// compile-error refusal in `--target standalone`, so the bulk of
// `built-ins/TypedArray/prototype/*` rows failed to compile.
//
// Fix (M1 / D2): register the reserved TypedArray `$NativeProto` glue
// (`ensureTypedArrayViewNativeProtoGlue` + the shared `%TypedArray%` intrinsic),
// mirroring the landed `ensureDateNativeProtoGlue`. The proto OBJECT is a PURE
// value object (member CSV + name; `emitLazyNativeProtoGet` never calls
// `emitMemberBody`), so the value read resolves host-free; reflective member
// CLOSURE bodies still degrade to a catchable TypeError (the method bodies live
// on the native instance-method vec dispatch, reached via the instance — never
// re-emitted on the proto value, per the #2375 vec/runtime-state caution).
//
// Out of scope for M1 (later slices): the bare-constructor `$NativeCtor` singleton
// (D1), `new <iteratedCtorValue>(arg)` (M2), and `%TypedArray%` intrinsic identity
// `Object.getPrototypeOf(Int8Array) === Object.getPrototypeOf(Uint8Array)` (M3).

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

async function compilesStandalone(src: string): Promise<boolean> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  return r.success;
}

const WIRED_VIEWS = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
] as const;

describe("#2651 M1 — TypedArray <View>.prototype value read resolves host-free standalone", () => {
  for (const view of WIRED_VIEWS) {
    it(`${view}.prototype compiles standalone (was the #1907 S6-b CE)`, async () => {
      const ok = await compilesStandalone(
        `export function test(): number { const p: any = ${view}.prototype; return p === null ? 0 : 1; }`,
      );
      expect(ok).toBe(true);
    });

    it(`${view}.prototype is a non-null value at runtime`, async () => {
      const r = await runStandalone(
        `export function test(): number { const p: any = ${view}.prototype; return p === null ? 0 : 1; }`,
      );
      expect(r).toBe(1);
    });

    it(`${view}.prototype.indexOf reads as a value standalone`, async () => {
      const ok = await compilesStandalone(`export function test(): any { return ${view}.prototype.indexOf; }`);
      expect(ok).toBe(true);
    });
  }

  it("the harness alias chain (Object.getPrototypeOf(Int8Array.prototype).constructor).prototype compiles", async () => {
    // The full `Object.getPrototypeOf(...).constructor` intrinsic identity is M3;
    // but the inner `Int8Array.prototype` value read (the M1 lever) must compile.
    const ok = await compilesStandalone(
      `const TA: any = Object.getPrototypeOf(Int8Array.prototype).constructor;
       export function test(): any { return TA.prototype; }`,
    );
    expect(ok).toBe(true);
  });

  it("zero env.global_<Name> host imports for a wired-view prototype read", async () => {
    const r = await compile(
      `export function test(): number { const p: any = Int8Array.prototype; return p === null ? 0 : 1; }`,
      {
        target: "standalone",
        skipSemanticDiagnostics: true,
      } as never,
    );
    expect(r.success).toBe(true);
    const mod = await WebAssembly.compile(r.binary as Uint8Array);
    const leaked = WebAssembly.Module.imports(mod).filter((i) => i.name.startsWith("global_"));
    expect(leaked).toEqual([]);
  });

  it("the meta-fold reports spec arities (TypedArray set=1, not Map set=2; subarray=2)", async () => {
    expect(await runStandalone(`export function test(): number { return Int8Array.prototype.indexOf.length; }`)).toBe(
      1,
    );
    expect(await runStandalone(`export function test(): number { return Int8Array.prototype.set.length; }`)).toBe(1);
    expect(await runStandalone(`export function test(): number { return Int8Array.prototype.subarray.length; }`)).toBe(
      2,
    );
  });
});

// #1907 (reopen, 2026-07-21) closed the bigint-view gap that #2651 M1 left "out
// of scope": `BigInt64Array.prototype` / `BigUint64Array.prototype` VALUE reads
// now resolve host-free through the same shared `%TypedArray%.prototype` glue as
// the 9 non-bigint views (they inherit that member set per §23.2; the proto is a
// pure value object). Kept out of `isWiredTypedArrayViewName` (intrinsic-ctor /
// dynamic-new / reflective-i64-getter paths remain a separate slice).
describe("#1907 — bigint TypedArray views' <View>.prototype value read resolves host-free standalone", () => {
  for (const view of ["BigInt64Array", "BigUint64Array"] as const) {
    it(`${view}.prototype is a non-null value at runtime (was the #1907 S6-b CE)`, async () => {
      const r = await runStandalone(
        `export function test(): number { const p: any = ${view}.prototype; return p === null ? 0 : 1; }`,
      );
      expect(r).toBe(1);
    });

    it(`${view}.prototype reads with zero env.global_<Name> host imports`, async () => {
      const r = await compile(
        `export function test(): number { const p: any = ${view}.prototype; return p === null ? 0 : 1; }`,
        { target: "standalone", skipSemanticDiagnostics: true } as never,
      );
      expect(r.success).toBe(true);
      const mod = await WebAssembly.compile(r.binary as Uint8Array);
      const leaked = WebAssembly.Module.imports(mod).filter((i) => i.name.startsWith("global_"));
      expect(leaked).toEqual([]);
    });
  }
});

describe("#2651 M1 — host/gc mode is untouched (dual-mode invariant)", () => {
  it("host new Int8Array + element read still compiles (path unchanged)", async () => {
    const r = await compile(`export function test(): number { const a = new Int8Array([1, 2, 3]); return a[0]; }`, {
      fileName: "t.ts",
    });
    expect(r.success).toBe(true);
  });

  it("host Int8Array.BYTES_PER_ELEMENT static fold still compiles", async () => {
    const r = await compile(`export function test(): number { return Int8Array.BYTES_PER_ELEMENT; }`, {
      fileName: "t.ts",
    });
    expect(r.success).toBe(true);
  });
});
