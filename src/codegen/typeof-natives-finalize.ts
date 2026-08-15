// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4120) Finalize pass for the standalone `typeof` natives.
 *
 * Moved verbatim out of `closure-exports.ts` (a god file under the #3102 LOC
 * budget) into its own subsystem module: the pass is about the `__typeof*`
 * helper BODIES, not about closure exports, and #4120 needed to add a fourth
 * callable classifier to it (the reified builtin-constructor carrier, which is
 * a branded `$Object` and not a closure struct at all).
 */
import type { Instr, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { buildClosureRefTestArms, collectClosureBaseWrapperTypeIdxs } from "./closure-classifier.js";
import { buildBuiltinCallableTestArm, hasBrandedBuiltinCarrier } from "./builtin-callable-brand.js";
import { installCompiledClosureToStringArm } from "./coercion-engine.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

/**
 * #1896 — teach the standalone/WASI native `__typeof_function` and
 * `__typeof_object` helpers to recognise closure wrapper structs.
 *
 * Those helpers are synthesised by `addUnionImportsAsNativeFuncs`, which runs
 * once on the first `addUnionImports` call — frequently *mid-compile*, before
 * every closure type has been registered in `ctx.closureInfoByTypeIdx`. Baking
 * the base-wrapper set at registration time would therefore miss later-registered
 * closures. Instead we rewrite the two helper bodies HERE, at finalize, after all
 * closures are registered (same late timing as `emitIsClosureExport`). We locate
 * the functions by name in `ctx.mod.functions` and splice in `ref.test` arms over
 * the closure base wrappers — no funcIdx churn (we edit existing bodies in place).
 *
 * - `__typeof_function`: was `i32.const 0` (wrong — a stored standalone closure
 *   is callable). Now: `any.convert_extern` then chained `ref.test` over each
 *   closure base wrapper; return 1 on first match, else 0.
 * - `__typeof_object`: add a closure-base-wrapper `ref.test` guard that returns 0
 *   (a callable is `"function"`, never `"object"`) BEFORE the final non-null
 *   `i32.const 1`, so a wrapper read back from an open-object slot is not
 *   mis-classified as `"object"`.
 * - (#2175 V2-S1) `__typeof`: the MATERIALIZED typeof-result native (the tag as
 *   a NativeString VALUE, used by `const t = typeof x`). It classified
 *   null/number/boolean/bigint/string and fell through to `"object"` — with NO
 *   function arm, so a closure read back dynamically produced `"object"` while
 *   the INLINE `typeof x === "function"` compare (via the `__typeof_function`
 *   predicate above) produced `"function"`. That path-dependence is the #2984
 *   `typeof` instability and contradicts `JsTag.Function` (#2949 V1 tag
 *   fidelity). We splice a closure `ref.test` arm returning the `"function"`
 *   NativeString before the terminal `"object"` sequence, using the SAME
 *   closure base-wrapper list — one predicate, all three natives in lockstep.
 *
 * All three natives now share the single closure classifier
 * (`buildClosureRefTestArms` / `collectClosureBaseWrapperTypeIdxs`,
 * `closure-classifier.ts`) — never two divergent arm lists.
 *
 * No-op unless native-strings (the helpers only exist then) and at least one
 * closure base wrapper was registered.
 */
export function fillStandaloneTypeofClosureArms(ctx: CodegenContext): void {
  if (!ctx.nativeStrings) return;
  const baseTypeIdxs = collectClosureBaseWrapperTypeIdxs(ctx);
  const runtimeEvalCallbackTypeIdx = ctx.runtimeEvalInterpretedCallbackTypeIdx;
  const proxyTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx;
  const boundaryCallableKindIdx = ctx.funcMap.get("__boundary_object_callable_kind");
  // (#4120) A reified builtin CONSTRUCTOR carrier (`Set`, `TypeError`, `Array`,
  // …) is a `$Object` branded `OBJ_FLAG_CALLABLE`, not a closure wrapper — and a
  // module can reify one without ever compiling a closure, so it must keep this
  // finalize alive on its own.
  // (#2175 S3b-3 defect C) …and a reified TypedArray view constructor is a
  // `$__ta_ctor` struct, which is neither a closure wrapper nor a brandable
  // `$Object`. A module whose only reified builtin is `Int8Array` must still
  // reach the fill, or `typeof Int8Array` silently answers `"object"`.
  const taCtorTypeIdx = ctx.taCtorTypeIdx !== undefined && ctx.taCtorTypeIdx >= 0 ? ctx.taCtorTypeIdx : undefined;
  if (
    baseTypeIdxs.length === 0 &&
    runtimeEvalCallbackTypeIdx === undefined &&
    !hasBrandedBuiltinCarrier(ctx) &&
    proxyTypeIdx === undefined &&
    boundaryCallableKindIdx === undefined &&
    taCtorTypeIdx === undefined
  )
    return;

  const fnByName = (name: string): WasmFunction | undefined =>
    ctx.mod.functions.find((f) => (f as { name?: string }).name === name) as WasmFunction | undefined;

  // Chained `ref.test` arms over the anyref-converted param in local 0/1. Each
  // i32-predicate arm returns `matchValue` on hit. Builds from the ONE shared
  // closure-base-wrapper list (`closure-classifier.ts`).
  const closureI32Arms = (anyLocalIdx: number, matchValue: number): Instr[] => {
    const onMatch: Instr[] = [{ op: "i32.const", value: matchValue }, { op: "return" }];
    const arms = buildClosureRefTestArms(ctx, anyLocalIdx, onMatch);
    if (runtimeEvalCallbackTypeIdx !== undefined) {
      // The provider wraps an interpreted callback in a uniquely branded,
      // deliberately NON-closure carrier before crossing into caller AOT. It
      // still has ECMAScript [[Call]], supplied by fillApplyClosure's exact
      // type+brand guard, so Test262's `assert.throws` precondition must observe
      // `typeof callback === "function"`. Keep this local to the typeof family:
      // adding the marker to the shared closure-root classifier would send it
      // through arity/property paths that assume closure field layout.
      arms.push(
        { op: "local.get", index: anyLocalIdx },
        { op: "ref.test", typeIdx: runtimeEvalCallbackTypeIdx },
        { op: "if", blockType: { kind: "empty" }, then: [...onMatch] },
      );
    }
    // (#4120) …and the branded builtin-constructor carrier, which is a `$Object`
    // rather than a closure struct. Kept in this SAME shared builder so all
    // three natives stay in lockstep — the docstring's "one predicate, all three
    // natives" invariant. Deliberately NOT added to the closure-root classifier,
    // for exactly the reason stated for the runtime-eval marker above.
    arms.push(...buildBuiltinCallableTestArm(ctx, anyLocalIdx, onMatch));
    if (proxyTypeIdx !== undefined) {
      const proxyAnswer: Instr[] = [
        { op: "local.get", index: anyLocalIdx },
        { op: "ref.cast", typeIdx: proxyTypeIdx },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: 5 },
        ...(matchValue === 0 ? ([{ op: "i32.eqz" }] satisfies Instr[]) : []),
        { op: "return" },
      ];
      arms.push(
        { op: "local.get", index: anyLocalIdx },
        { op: "ref.test", typeIdx: proxyTypeIdx },
        { op: "if", blockType: { kind: "empty" }, then: proxyAnswer },
      );
    }
    if (boundaryCallableKindIdx !== undefined) {
      arms.push(
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: boundaryCallableKindIdx },
        { op: "i32.const", value: 1 },
        { op: "i32.and" },
        ...(matchValue === 0 ? ([{ op: "i32.eqz" }] satisfies Instr[]) : []),
        { op: "return" },
      );
    }
    return arms;
  };

  // #3540: the single coercion engine owns compiled-closure stringification;
  // this finalizer supplies the now-complete closure classifier.
  installCompiledClosureToStringArm(ctx);

  // --- __typeof_function: param(0) externref → 1 if closure wrapper else 0.
  const tf = fnByName("__typeof_function");
  if (tf) {
    // Ensure an anyref local exists for the converted param (local index 1).
    if (tf.locals.length === 0) {
      tf.locals.push({ name: "$any_temp", type: { kind: "anyref" } });
    }
    tf.body = [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 1 },
      ...closureI32Arms(1, 1),
      { op: "i32.const", value: 0 },
    ];
  }

  // --- __typeof_object: insert closure-exclusion (return 0) before the trailing
  // non-null `i32.const 1`. The existing body already converts the param to
  // anyref into local 1 (`$any_temp`) for its boxed-primitive guards, so reuse it.
  const to = fnByName("__typeof_object");
  if (to) {
    const b = to.body;
    // The body ends with `{ i32.const 1 }` (the "non-null → object" fallthrough).
    // Splice the closure-exclusion arms immediately before that terminal const.
    const lastIdx = b.length - 1;
    const last = b[lastIdx] as { op?: string; value?: number } | undefined;
    if (last && last.op === "i32.const" && last.value === 1) {
      b.splice(lastIdx, 0, ...closureI32Arms(1, 0));
    }
  }

  // --- (#2175 V2-S1) __typeof (materialized result): splice a closure arm that
  // returns the `"function"` NativeString before the terminal `"object"`
  // sequence. The body converts param → anyref into local 1 (`$any_temp`)
  // before its boxed-primitive guards, and local 1 still holds it at the
  // terminal, so the arm reads local 1 exactly like the primitive guards.
  //
  // Robust splice point: the terminal is the last N instrs, where N is the
  // length of `stringConstantExternrefInstrs(ctx, "object")` (deterministic —
  // "object" was already registered when the body was built, so re-deriving it
  // yields the same length). We verify the tail's op-shape matches before
  // splicing; if `__typeof` is the `ref.null.extern` stub (no native-string
  // type) the shape check fails and we skip — self-guarding.
  const tt = fnByName("__typeof");
  if (tt && ctx.nativeStrTypeIdx >= 0) {
    const b = tt.body;
    const objTerminal = stringConstantExternrefInstrs(ctx, "object");
    const spliceAt = b.length - objTerminal.length;
    const tailMatches =
      spliceAt >= 0 &&
      objTerminal.every(
        (inst, i) => (b[spliceAt + i] as { op?: string } | undefined)?.op === (inst as { op?: string }).op,
      );
    if (tailMatches) {
      // Replace each predicate arm's `i32.const 1; return` body with the
      // materialized native string result. Rebuild explicitly because the i32
      // predicate and value-returning helper have different result types.
      const valueArms: Instr[] = [];
      const callableTypeIdxs = [
        ...baseTypeIdxs,
        ...(runtimeEvalCallbackTypeIdx === undefined ? [] : [runtimeEvalCallbackTypeIdx]),
      ];
      for (const typeIdx of callableTypeIdxs) {
        valueArms.push(
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, "function"), { op: "return" }],
          },
        );
      }
      // (#4120) Branded builtin-constructor carrier → the "function" string, so
      // the MATERIALIZED `const t = typeof Set` agrees with the inline
      // `typeof Set === "function"` predicate (the #2984 path-dependence).
      valueArms.push(
        ...buildBuiltinCallableTestArm(ctx, 1, [...stringConstantExternrefInstrs(ctx, "function"), { op: "return" }]),
      );
      if (proxyTypeIdx !== undefined) {
        valueArms.push(
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: proxyTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "ref.cast", typeIdx: proxyTypeIdx },
              { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: 5 },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...stringConstantExternrefInstrs(ctx, "function"), { op: "return" }],
              },
            ],
          },
        );
      }
      if (boundaryCallableKindIdx !== undefined) {
        valueArms.push(
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: boundaryCallableKindIdx },
          { op: "i32.const", value: 1 },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, "function"), { op: "return" }],
          },
        );
      }
      b.splice(spliceAt, 0, ...valueArms);
    }
  }
}
