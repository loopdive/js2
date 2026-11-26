// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3267 — Split property-access.ts: extract the built-in static/prototype
 * VALUE-read subsystem into src/codegen/builtin-value-read.ts (subtask of #3182).
 *
 * This is a PURE MOVE (verbatim cut-paste, no logic changes); the acceptance
 * proof is the prove-emit-identity byte-identity gate (39/39 emits IDENTICAL).
 * This smoke test is the #2093 probe-coverage witness: it compiles small
 * programs under `--target standalone` (where the moved machinery is the active
 * value-read path) that route through each cut in the extracted module:
 *
 *   - Math/Number constant folds        → MATH_CONSTANT_VALUES / NUMBER_CONSTANT_VALUES,
 *                                          hasNativeBuiltinConstantHandler
 *   - reflective `Math["PI"]`           → tryEmitBuiltinNamespaceConstantValue
 *   - `<TypedArray>.BYTES_PER_ELEMENT`  → TYPED_ARRAY_BYTES_PER_ELEMENT
 *   - typed-array element signedness    → typedArrayViewSignedness
 *   - `Symbol.iterator`                 → wellKnownSymbolId / WELL_KNOWN_SYMBOL_IDS
 *   - `<Builtin>.prototype.<member>`    → tryCompileStandaloneBuiltinProtoMemberRead,
 *                                          tryEnsureNativeProtoBrand
 *   - `Array.isArray` as a value        → ensureStandaloneBuiltinStaticMethodClosure,
 *                                          emitArrayIsArrayExternrefPredicate,
 *                                          makeBuiltinClosureFctx
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function numResult(body: string): Promise<number> {
  const src = `export function test(): number {\n${body}\n}`;
  const r = await compile(src, {
    fileName: "issue-3267.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#3267 builtin-value-read subsystem (standalone value reads)", () => {
  it("folds Number static numeric constants", async () => {
    expect(await numResult(`return Number.MAX_SAFE_INTEGER === 9007199254740991 ? 1 : 0;`)).toBe(1);
    expect(await numResult(`return Number.EPSILON > 0 ? 1 : 0;`)).toBe(1);
  });

  it("folds Math constants for direct and reflective reads", async () => {
    expect(await numResult(`return Math.PI > 3.14 && Math.PI < 3.15 ? 1 : 0;`)).toBe(1);
    // reflective element access — tryEmitBuiltinNamespaceConstantValue
    expect(await numResult(`return Math["PI"] > 3.14 && Math["PI"] < 3.15 ? 1 : 0;`)).toBe(1);
  });

  it("folds TypedArray BYTES_PER_ELEMENT static reads", async () => {
    expect(await numResult(`return Int32Array.BYTES_PER_ELEMENT;`)).toBe(4);
    expect(await numResult(`return Uint8Array.BYTES_PER_ELEMENT;`)).toBe(1);
    expect(await numResult(`return Float64Array.BYTES_PER_ELEMENT;`)).toBe(8);
  });

  it("recovers typed-array element signedness from the view name", async () => {
    // signed Int8Array read sign-extends; unsigned Uint8Array does not
    expect(await numResult(`const a = new Int8Array(1); a[0] = -1 as any; return a[0];`)).toBe(-1);
    expect(await numResult(`const a = new Uint8Array(1); a[0] = 255 as any; return a[0];`)).toBe(255);
  });

  it("resolves the Symbol.iterator well-known id", async () => {
    expect(await numResult(`return typeof Symbol.iterator !== "undefined" ? 1 : 0;`)).toBe(1);
  });

  it("reads <Builtin>.prototype.<member> as an identity-stable method value", async () => {
    // same (brand, member) → one singleton value (===); distinct members → !==
    expect(await numResult(`return (RegExp.prototype.exec as any) === (RegExp.prototype.exec as any) ? 1 : 0;`)).toBe(
      1,
    );
    expect(await numResult(`return (RegExp.prototype.exec as any) === (RegExp.prototype.test as any) ? 1 : 0;`)).toBe(
      0,
    );
  });

  it("reifies Array.isArray as a first-class value closure", async () => {
    expect(await numResult(`const f: any = Array.isArray; return f([1, 2, 3]) ? 1 : 0;`)).toBe(1);
    expect(await numResult(`const f: any = Array.isArray; return f(42) ? 1 : 0;`)).toBe(0);
  });
});
