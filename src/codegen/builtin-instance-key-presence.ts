// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-5 T9) The STATICALLY-TYPED **builtin-instance** receiver — `new
 * Date()`, `new RegExp()` — asked a presence or enumeration question about a
 * key that lives in its #4008 carrier bag.
 *
 * ## The defect, measured on this tree (`--target standalone`, real harness)
 *
 * ```js
 * var d = new Date(0);
 * d.prop1 = 100;
 * ```
 *
 * | query | before | Node |
 * | --- | --- | --- |
 * | `d.prop1` | `100` | `100` |
 * | `Object.keys(d)` / `Object.getOwnPropertyNames(d)` | `["prop1"]` | `["prop1"]` |
 * | `Object.getOwnPropertyDescriptor(d, "prop1").value` | `100` | `100` |
 * | `Object.hasOwn(d, "prop1")` | `true` | `true` |
 * | `f(d)` where `function f(x){return x.hasOwnProperty("prop1")}` | `true` | `true` |
 * | **`d.hasOwnProperty("prop1")`** | **`false`** | `true` |
 * | **`"prop1" in d`** | **`false`** | `true` |
 * | **`for (var k in d)`** | **44 `Date.prototype` method names, no `prop1`** | `["prop1"]` |
 *
 * The runtime is already RIGHT — every row that reaches a native helper answers
 * correctly, and `__is_closure_prop_carrier` has covered `__Date` /
 * `__StandaloneRegExp` since #4008. The three wrong rows are the three that
 * never reach a helper, because the receiver's STATIC type is `Date` and the key
 * is known at compile time:
 *
 * - `compilePropertyIntrospection` (object-ops.ts) folds `structFieldNames ∪
 *   checker properties`. `__Date`'s field list is `["timestamp"]`, so an expando
 *   the program wrote a line earlier is absent from both → `i32.const 0`.
 * - `compileInExpression` (binary-ops-in.ts) folds the same two sources, and
 *   routes a folded `0` to `__extern_has` only for an `externref`/`anyref`
 *   receiver — a `(ref $__Date)` is neither.
 * - `for (k in d)` sees a non-dynamic Wasm type and takes the STATIC UNROLL
 *   (`for-in-static-unroll.ts`), which enumerates the receiver's declared TS
 *   members. For `Date` those are its 44 **prototype methods** plus the
 *   `[Symbol.toPrimitive]` CSV sentinel — every one of them non-enumerable and
 *   inherited, i.e. exactly the set for-in must NOT yield — while the one own
 *   enumerable key is invisible.
 *
 * This is #4062 (`vec-named-key-presence.ts`) one receiver family further out:
 * there the statically-typed ARRAY receiver's named expando was invisible to the
 * same two folds. The safety argument is inherited verbatim.
 *
 * ## Why this widens only a FALSE
 *
 * {@link builtinInstanceKeyNeedsRuntime} fires only where the fold would emit
 * `0`. An affirmative fold (`"getTime"`, a checker-named prototype method,
 * `propertyIsEnumerable`'s non-enumerable `0`-for-a-listed-name) is emitted
 * exactly as before, so no receiver/key pair that answers affirmatively today
 * moves. That is the property #4055 v1 lacked when the merge queue measured
 * **-684**: it widened `hasOwnProperty` over a bag a REFUSED write had polluted.
 * The refusal now lives at the write source (`buildBuiltinFnSetRefusalArm`), and
 * this route adds no visibility of its own — it only stops LYING about a bag the
 * dynamic surfaces already report.
 *
 * The for-in half is not a "false" in the same sense, but it is the same
 * direction: the static unroll's answer for these two receivers is unsound in
 * BOTH directions (it yields inherited non-enumerables and drops own enumerables),
 * so replacing it with the dynamic enumeration cannot preserve a correct answer
 * it was giving.
 *
 * ## Scope, deliberately narrow
 *
 * - **Standalone/WASI only.** In host mode `env::__hasOwnProperty` /
 *   `__extern_has` / the `__for_in_*` imports own these paths over a JS sidecar;
 *   gc/host output stays byte-identical.
 * - **Exactly the #4008 carrier list.** `__Date` and `__StandaloneRegExp` are the
 *   two builtin instances lowered to a dedicated WasmGC struct that shares the
 *   identity-keyed #3468 bag. `$Error_struct` (own `$props` slot) and the
 *   `$__vec_*` carriers (element domain + #4062's own route) are deliberately
 *   NOT here — they have their own stores and their own arms.
 * - **A type absent from the module is skipped**, so a program that never
 *   constructs a Date emits an identical decision.
 */
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { vecNamedKeyNeedsRuntime } from "./vec-named-key-presence.js";

/**
 * (#4008) The builtin instances lowered to a dedicated WasmGC struct that
 * carries own properties in the identity-keyed #3468 bag. ONE spelling, shared
 * with `closure-props.ts`'s `builtinInstanceCarrierTypeIdxs`, so the carrier set
 * and the fold-routing set cannot drift apart — a struct that can hold a bag
 * entry the fold cannot see is exactly a struct whose folds must be routed.
 */
export const BUILTIN_INSTANCE_CARRIER_STRUCT_NAMES: readonly string[] = ["__StandaloneRegExp", "__Date", "$Promise"];

/** Is `recvWasm` a reference to one of the {@link BUILTIN_INSTANCE_CARRIER_STRUCT_NAMES}? */
export function isBuiltinInstanceCarrierType(ctx: CodegenContext, recvWasm: ValType | undefined): boolean {
  if (!recvWasm) return false;
  if (recvWasm.kind !== "ref" && recvWasm.kind !== "ref_null") return false;
  const typeIdx = (recvWasm as { typeIdx: number }).typeIdx;
  for (const name of BUILTIN_INSTANCE_CARRIER_STRUCT_NAMES) {
    if (ctx.structMap.get(name) === typeIdx) return true;
  }
  return false;
}

/**
 * Should a presence question about a statically-known key on this receiver be
 * answered by the runtime chokepoint instead of the compile-time fold?
 *
 * `foldedAnswer` is what the call site would otherwise emit. Only a `0` is
 * eligible — see the module header.
 */
export function builtinInstanceKeyNeedsRuntime(
  ctx: CodegenContext,
  recvWasm: ValType | undefined,
  foldedAnswer: number,
): boolean {
  if (foldedAnswer !== 0) return false;
  if (!ctx.standalone && !ctx.wasi) return false;
  return isBuiltinInstanceCarrierType(ctx, recvWasm);
}

/**
 * The ONE question both fold sites ask: "could this statically-known key live in
 * a CARRIER BAG this receiver's field list cannot see?" — the #3537 array bag
 * (#4062) or the #4008 builtin-instance bag (this module).
 *
 * Merged into a single predicate rather than two chained `if`s at each site
 * because the two answers are consumed identically (route to
 * `emitRuntimePropertyIntrospection` / `__extern_has`), and because
 * `compileForInStatement` / `compileInOperator` / `compilePropertyIntrospection`
 * are all at their #3400 function-size ceiling — a second call site would have
 * cost a budget allowance for wiring that adds no branch.
 */
export function carrierBagKeyNeedsRuntime(
  ctx: CodegenContext,
  recvWasm: ValType | undefined,
  staticKey: string,
  foldedAnswer: number,
): boolean {
  return (
    vecNamedKeyNeedsRuntime(ctx, recvWasm, staticKey, foldedAnswer) ||
    builtinInstanceKeyNeedsRuntime(ctx, recvWasm, foldedAnswer)
  );
}

/**
 * `for (k in recv)` — should the receiver take the DYNAMIC enumeration
 * (`__object_keys_forin`) rather than the static unroll?
 *
 * Wraps the existing three-way Wasm-type test so the call site stays one line;
 * see the module header for why a `__Date` / `__StandaloneRegExp` receiver is a
 * closed STRUCT but not a closed SHAPE. Measured, standalone: `var d = new
 * Date(0); d.prop1 = 100; for (var k in d)` unrolled to the 44 declared `Date`
 * members (all inherited, all non-enumerable — none of which for-in may yield)
 * and never produced `prop1`, while `Object.keys(d)` was already correct.
 */
export function forInReceiverIsDynamic(ctx: CodegenContext, recvWasm: ValType): boolean {
  if (recvWasm.kind === "externref" || recvWasm.kind === "anyref" || recvWasm.kind === "ref_extern") return true;
  return isBuiltinInstanceCarrierType(ctx, recvWasm);
}
