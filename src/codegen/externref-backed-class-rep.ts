// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5201) Value representation of an EXTERNREF-BACKED user class.
//
// `collectClassDeclaration` records a class in `ctx.classExternrefBackedSet`
// when its parent is a host-constructible builtin (`Array`, `Error`, `Map`,
// `Object`, the TypedArrays, …) or an extern class. For those classes
// `<Class>_new` builds a real HOST object and installs `<Class>.prototype` on
// it — so the instance's Wasm representation is `externref`, and the class's
// own methods live on that prototype. Nothing else carries them.
//
// `resolveWasmType` already knew this (#1366a) — but its check sat at the
// named-struct lookup, ~380 lines below the arm that matches array-like
// shapes. `class JSBI extends Array` never got that far:
// `inheritedArrayElementType` matched it first and answered
// `ref_null $__vec_externref`. The two answers disagree, and the disagreement
// is LOSSY in one direction: every externref→vec coercion (`const d = new
// JSBI()`, an argument entering a `D`-typed parameter, a field write)
// MATERIALIZES A FRESH VEC by copying elements out of the host object. The
// copy has no prototype, so the method table is gone; re-entering the host it
// is an opaque WasmGC struct, and `_.__clzmsd()` reported
// `__clzmsd is not a function` (jsbi@4.3.0 under @js-temporal/polyfill — the
// third #4628 Option A module-init blocker, after #5191 and #5193).
//
// Only that direction was ever wrong, which is why the one-line repro
// (`new C().m()`) looks healthy: `f(new D())` keeps the constructor's
// externref end-to-end and never meets a `D`-typed slot. The defect needs the
// value to pass through a DECLARED BINDING of the class's own type first.
//
// Genuinely-builtin methods are unaffected — `d.push(1)` / `d.length` /
// `d[0]` / `for…of d` dispatch on the externref receiver through the same
// host member paths a plain array uses. Membership is decided solely by
// `classExternrefBackedSet`, so a plain user class, a user-derived class, and
// any lane that never joins the set resolve byte-identically.

import type { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/**
 * `{ kind: "externref" }` when `sym` names an externref-backed user class,
 * otherwise `undefined` (caller keeps its existing resolution).
 *
 * Resolves through `classExprNameMap` as well, so a class EXPRESSION whose
 * display name differs from its synthetic registration name is recognized.
 */
export function externrefBackedClassValType(ctx: CodegenContext, sym: ts.Symbol | undefined): ValType | undefined {
  const name = sym?.name;
  if (name === undefined) return undefined;
  if (ctx.classExternrefBackedSet.has(name)) return { kind: "externref" };
  const synthetic = ctx.classExprNameMap.get(name);
  if (synthetic !== undefined && ctx.classExternrefBackedSet.has(synthetic)) return { kind: "externref" };
  return undefined;
}
