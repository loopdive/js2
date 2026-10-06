// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6848) A callback-taking Array method on a NATIVE vec receiver that the
 * native lane declined, on the JS-host lane.
 *
 * `compileArrayMethodCall` lowers `arr.forEach(cb)` / `map` / `filter` / … over
 * a vec of REFERENCE elements (a vec of tuples — `Object.entries(o)`, a vec of
 * structs) natively only when the callback is "lane safe"
 * (`hofRefElemClosureLaneSafe`, #4616/#4728). A callback that captures an outer
 * binding typed `any` is not — and in untyped JavaScript that is the ordinary
 * case: hono's `convertFormDataToBodyData` runs
 * `Object.entries(form).forEach(([key, value]) => { … form … })` with `form`
 * from `Object.create(null)`. The native lane declines by design, saying the
 * call belongs to the host lane.
 *
 * But no host arm then claimed a call whose receiver is a native vec: the
 * any/externref ladder needs an any-typed receiver, and the #3201 native
 * receiver arm only claims EXPANDO members (`forEach` is declared on
 * `Array`). The call fell to `compileCallDispatchTail`'s graceful fallback,
 * which evaluates the receiver and the callback, drops both, and answers
 * `undefined` — the callback never ran, so every write it made was lost.
 *
 * This predicate widens the #3201 arm to exactly those calls. The arm already
 * passes the RAW vec struct to `__extern_method_call`, which live-mirrors it
 * (`_wrapForHost`) so the host method sees the real elements and the callback
 * — a `__make_callback` closure — runs with its own captures.
 *
 * It fires only after every native arm declined (the #3201 arm is the last
 * step of `compileMethodCallOnReceiver`), so it cannot displace a working
 * native lowering; it converts a silent `undefined` into a real call.
 */
// Leaf module on purpose (type-only imports), so it stays outside the codegen
// import cycle (#6797 ratchet); the caller supplies the vec test.
import type { CodegenContext } from "../context/types.js";

/**
 * The callback-taking methods `compileArrayMethodCall` gates on
 * `hofElemKindOk` — the ones whose native lowering can decline for a
 * reference-element receiver.
 */
const NATIVE_GATED_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  "forEach",
  "map",
  "filter",
  "reduce",
  "reduceRight",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "some",
  "every",
]);

/**
 * Is this a declinable callback method on a native vec carrier? `isVec` is the
 * caller's `getVecInfo(ctx, typeIdx) !== null`, evaluated lazily.
 */
export function isDeclinedVecCallbackMethod(ctx: CodegenContext, isVec: () => boolean, methodName: string): boolean {
  if (ctx.standalone || ctx.wasi) return false;
  if (!NATIVE_GATED_CALLBACK_METHODS.has(methodName)) return false;
  return isVec();
}
