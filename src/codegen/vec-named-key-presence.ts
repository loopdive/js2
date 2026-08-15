// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4062) The STATICALLY-TYPED array receiver's answer to a NAMED-key presence
 * question — `arr.hasOwnProperty("foo")`, `arr.propertyIsEnumerable("foo")`,
 * `"foo" in arr` — routed to the same runtime chokepoint the value read uses.
 *
 * ## The defect
 * `a.foo = 7` on an array stores into the #3537 expando bag (`__vec_prop_set`),
 * and every DYNAMIC surface already sees it: `__hasOwnProperty` / `__extern_has`
 * carry the vec arm that consults the #3251 overlay and then the bag
 * (`vec-bag-seed.ts`, `carrier-bag-visibility.ts`), and `Object.keys` / gOPD /
 * gOPN answer through the same natives. Measured on this tree, under the real
 * test262 harness (`var a = []; a.foo = 7`), `--target standalone`:
 *
 * | query | before | Node |
 * | --- | --- | --- |
 * | `a.foo` | `7` | `7` |
 * | `Object.getOwnPropertyDescriptor(a, "foo").value` | `7` | `7` |
 * | `Object.getOwnPropertyNames(a)` | includes `"foo"` | includes `"foo"` |
 * | `Object.keys(a)` | includes `"foo"` | includes `"foo"` |
 * | `a.hasOwnProperty("foo")` | **`false`** | `true` |
 * | `"foo" in a` | **`false`** | `true` |
 *
 * The two wrong cells are the two that never reach a runtime helper. With a
 * receiver the compiler sees as a `__vec_<k>` struct and a key it can resolve at
 * compile time, both sites answer from the STATIC shape:
 * `compilePropertyIntrospection` (object-ops.ts) folds
 * `structFieldNames ∪ checker properties`, and `compileInExpression`
 * (binary-ops-in.ts) folds `structFieldNames ∪ tsTypeHasProperty`. A vec's field
 * list is `["length", "data"]` and `any[]`'s checker properties are its
 * prototype methods, so an expando the program itself wrote a line earlier is
 * absent from both — the fold emits `i32.const 0`.
 *
 * This is the same shape as #4010 S3, one lane further out: there the vec arm
 * `return`ed the overlay answer unconditionally and never reached the bag; here
 * the query never reaches the arm at all.
 *
 * ## Why this widens only a FALSE, and why that is the whole safety argument
 * The routing predicate fires only where the fold's answer would be `0`. A fold
 * that answers `1` (`"length"`, an inherited method named by the checker, a
 * `propertyIsEnumerable` non-enumerable `0` — see below) is emitted exactly as
 * before, so no receiver/key pair that answers affirmatively today changes.
 * That is the property #4055 v1 did not have: it widened `hasOwnProperty` over a
 * bag that a REFUSED write had polluted, and the merge queue measured **-684**.
 * The refusal (`buildBuiltinFnSetRefusalArm`) is at the write source now, and the
 * vec arm's own consult order (overlay affirmative → bag) is what this route
 * inherits — it adds no new visibility of its own.
 *
 * ## Scope, deliberately narrow
 * - **Standalone only.** In host mode `env::__hasOwnProperty` / `__extern_has`
 *   own the dynamic path over a JS sidecar with different (and, measured here,
 *   worse) answers for an array expando; gc/host output stays byte-identical.
 * - **Named keys only.** A canonical array index is the vec's ELEMENT domain —
 *   #3251/#4434 own it, and the two fold sites have their own index arms above
 *   this one. `"length"` is excluded by construction: its fold answers `1`.
 * - **Nothing about `length`, and nothing about the static defineProperty
 *   lane.** #4434 landed the length arms; #3251 owns the inline define.
 */
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** A canonical array index string (`"0"`, `"7"`, …) — never `"01"` / `"-1"` / `"1e3"`. */
function isCanonicalIndexKey(key: string): boolean {
  if (key.length === 0 || key.length > 10) return false;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  if (key.length > 1 && key.charCodeAt(0) === 48) return false;
  return true;
}

/** Is `recvWasm` a reference to a `__vec_<kind>` array struct? */
function isVecStructType(ctx: CodegenContext, recvWasm: ValType | undefined): boolean {
  if (!recvWasm) return false;
  if (recvWasm.kind !== "ref" && recvWasm.kind !== "ref_null") return false;
  const structDef = ctx.mod.types[(recvWasm as { typeIdx: number }).typeIdx];
  return structDef?.kind === "struct" && (structDef.name?.startsWith("__vec_") ?? false);
}

/**
 * Should a presence question about `staticKey` on this receiver be answered by
 * the runtime chokepoint instead of the compile-time fold?
 *
 * `foldedAnswer` is what the call site would otherwise emit. Only a `0` is
 * eligible — see the module header: the affirmative answers are unchanged, which
 * is what keeps this from re-opening the #4055 v1 regression.
 */
export function vecNamedKeyNeedsRuntime(
  ctx: CodegenContext,
  recvWasm: ValType | undefined,
  staticKey: string,
  foldedAnswer: number,
): boolean {
  if (foldedAnswer !== 0) return false;
  if (!ctx.standalone) return false;
  if (isCanonicalIndexKey(staticKey)) return false;
  return isVecStructType(ctx, recvWasm);
}
