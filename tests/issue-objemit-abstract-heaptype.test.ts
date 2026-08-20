import { describe, it, expect } from "vitest";
import { compileToObject } from "../src/index.js";

// The relocatable WasmGC object emitter (`compileToObject`, the `.o` output)
// threw `Object emit error: u32 out of range: -19` when a function used any/any
// loose/strict equality (e.g. `function eq(a:any,b:any){return a==b}`).
//
// Root cause: the any-equality / AnyValue path emits `ref.test` / `ref.cast` /
// `ref.null` instructions whose `typeIdx` is a NEGATIVE *abstract heap type*
// sentinel — `eq` is `-19` (`EQ_HEAP_TYPE` in any-helpers.ts, the signed-LEB
// heap-type encoding). `emitBinary` encodes that inline as a signed-LEB heap
// type, but the object emitter UNCONDITIONALLY pushed a type-index relocation
// (`R_WASM_TYPE_INDEX_LEB`) with `symbolIndex: instr.typeIdx`. The reloc section
// then serialized `s.u32(-19)` → RangeError. Abstract heap types are not
// relocatable concrete module types; the fix skips the relocation when
// `typeIdx < 0` (object.ts ref.test/ref.cast/ref.cast_null).
//
// This unblocked reproduction of the #2081 standalone loose-eq work.

function compileObjectOk(src: string): number {
  const r = compileToObject(src, { fileName: "test.ts" }) as {
    success: boolean;
    object?: Uint8Array;
    errors?: { message: string }[];
  };
  if (!r.success) {
    throw new Error(`compileToObject failed: ${r.errors?.map((e) => e.message).join("; ")}`);
  }
  return r.object!.length;
}

describe("object emitter — abstract heap-type typeIdx must not be relocated", () => {
  it("any/any loose equality compiles to an object file", () => {
    // Before the fix: `Object emit error: u32 out of range: -19`.
    expect(compileObjectOk(`export function eq(a: any, b: any): boolean { return a == b; }`)).toBeGreaterThan(0);
  });

  it("any/any strict equality compiles to an object file", () => {
    expect(compileObjectOk(`export function eq(a: any, b: any): boolean { return a === b; }`)).toBeGreaterThan(0);
  });

  it("any/any inequality compiles to an object file", () => {
    expect(compileObjectOk(`export function ne(a: any, b: any): boolean { return a != b; }`)).toBeGreaterThan(0);
  });

  it("any param compared then called still compiles", () => {
    expect(
      compileObjectOk(
        `function eq(a: any, b: any): boolean { return a == b; }
         export function test(): number { return eq(1, 1) ? 1 : 0; }`,
      ),
    ).toBeGreaterThan(0);
  });

  it("concrete-type relocations still work (object literal / class / array)", () => {
    // Regression guard: the fix only skips relocs for NEGATIVE typeIdx; concrete
    // (>= 0) type indices must still emit their R_WASM_TYPE_INDEX_LEB relocs.
    expect(compileObjectOk(`export function f(): number { const o: any = { x: 5 }; return o.x; }`)).toBeGreaterThan(0);
    expect(
      compileObjectOk(`class C { x: number = 3; } export function f(): number { const c = new C(); return c.x; }`),
    ).toBeGreaterThan(0);
    expect(compileObjectOk(`export function f(): number { const a = [1, 2, 3]; return a[1]; }`)).toBeGreaterThan(0);
  });
});
