// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-5 T7, slice B) The §20.2.2 OWN-property surface of the realm's
 * `%Function%` value under `--target standalone` with the runtime-eval provider
 * linked.
 *
 * ## What was missing
 *
 * `Object` / `Array` / `String` / `RegExp` all answer
 * `hasOwnProperty("prototype")` correctly because a bare read of those
 * identifiers mints the #3006 `__builtin_ctor_*` carrier, a real `$Object`
 * whose own properties `pushBuiltinCtorOwnPropSeed` seeds. A bare `Function`
 * read is the ONE builtin that does not take that route: it is an
 * `intrinsic-value` boundary site, so it resolves through the provider realm
 * and arrives as the canonical `$RuntimeEvalInterpretedCallback` marker with
 * `kind = INTRINSIC_FUNCTION` (`function-intrinsic-carrier.ts`'s header records
 * this as failure mode 1). `Function` is even present in `BUILTIN_CTOR_ARITY`
 * — the seed simply never reaches this value.
 *
 * The marker is a nominal struct, so `__hasOwnProperty` / `__object_hasOwn`
 * `ref.test $Object`, miss, and answer FALSE for every key. Measured on this
 * branch's base with the real `runTest262File` (`--target standalone`, quickjs
 * provider active):
 *
 * | probe                                | base    | spec   |
 * | ------------------------------------ | ------- | ------ |
 * | `Function.hasOwnProperty("prototype")` | `false` | `true` |
 * | `Function.hasOwnProperty("length")`    | `false` | `true` |
 * | `Function.hasOwnProperty("name")`      | `false` | `true` |
 * | `typeof Function.prototype`            | `object`| `object` (already right) |
 *
 * ## Why the marker grows a surface instead of being swapped for the carrier
 *
 * Swapping the bare read to `__builtin_ctor_Function` is the fix #4440 built
 * and rejected twice, for a reason that has not changed: the carrier has no
 * [[Call]] slot, and `var F = Function; F("a", "return a")` must keep working
 * in a provider-linked module — and the value must stay identity-equal to the
 * `%Function%` the provider hands back for an interpreted function's
 * `.constructor`. So the marker keeps its identity and this module answers the
 * three §20.2.2 own properties on it directly.
 *
 * ## Scope — INTRINSIC_FUNCTION only, and `prototype` is the reason
 *
 * The arm fires only for `kind === INTRINSIC_FUNCTION`, i.e. the bare
 * `Function` VALUE. A `kind = GENERIC` marker (the result of `Function(src)`)
 * also owns a `prototype` per §20.2.1.1, but answering `true` there would be a
 * silent lie: no `prototype` OBJECT exists for it to hand back, so
 * `f.hasOwnProperty("prototype")` would be `true` while `f.prototype` stayed
 * `undefined` — two surfaces disagreeing about one value, which is the exact
 * defect class this slice exists to remove. Minting that object needs a mutable
 * slot on a struct type that is STRUCTURALLY shared with the separately
 * compiled provider module, i.e. a cross-module ABI change; it is priced and
 * declined in the issue's T7 plan, not smuggled in here.
 *
 * `name` and `length` for a GENERIC marker are already served (the universal
 * property getter's marker arm in `runtime-eval-callable.ts` reads them out of
 * the marker's own `name`/`length` fields), so this module adds nothing there.
 *
 * ## `delete` ships with visibility, not after it (#4010's ordering law)
 *
 * test262's `isConfigurable` is `delete obj[name]; return !hasOwnProperty(obj,
 * name)`, so a property that becomes VISIBLE without a matching `delete`
 * answer reads as "configurable: true" to every `verifyProperty`. §20.2.2 makes
 * `Function.prototype` `{writable: false, enumerable: false, configurable:
 * false}`, so the honest `delete` answer for that ONE key is `false`, and
 * `built-ins/Function/prototype/S15.3.3.1_A3.js` asserts exactly that
 * (`verifyNotConfigurable` first, then `assert.sameValue(delete
 * Function.prototype, false)`).
 *
 * `length` and `name` are `configurable: true` and are deliberately NOT claimed
 * by the delete arm — there is no store on the marker to record a tombstone in,
 * so a `delete` that answered `true` would leave the key visible and the two
 * surfaces would contradict each other. They keep the pre-existing answer.
 * Stated residual: `delete Function.length` does not remove it. That is a
 * narrower wrong answer than the property being absent outright, and
 * `Object.getOwnPropertyDescriptor(Function, "length")` — which already answers
 * correctly on base (`built-ins/Function/length/15.3.3.2-1.js` passes) — is
 * untouched either way.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers, nativeStringLiteralInstrs } from "./native-strings.js";
import {
  RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A,
  RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B,
  RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_FUNCTION,
} from "./runtime-eval-boundary.js";

/** §20.2.2 — the own properties of the `%Function%` constructor object. */
const FUNCTION_INTRINSIC_OWN_KEYS = ["prototype", "length", "name"] as const;

/**
 * The keys whose §20.2.2 attributes make `delete` FAIL, paired with the answer
 * the arm returns. Only `prototype` is `configurable: false`; see the module
 * header for why `length` / `name` are left to the pre-existing body.
 */
const FUNCTION_INTRINSIC_UNDELETABLE_KEYS = ["prototype"] as const;

/**
 * The three natives this module widens, and what its arm answers on a match.
 * `__hasOwnProperty` / `__object_hasOwn` / `__delete_property` all have the
 * shape `(externref obj, externref key) -> i32`, which is what makes one
 * emitter serve all three.
 */
const WIDENED_NATIVES: ReadonlyArray<readonly [string, readonly string[], number]> = [
  ["__hasOwnProperty", FUNCTION_INTRINSIC_OWN_KEYS, 1],
  ["__object_hasOwn", FUNCTION_INTRINSIC_OWN_KEYS, 1],
  ["__delete_property", FUNCTION_INTRINSIC_UNDELETABLE_KEYS, 0],
];

/**
 * Splice the `%Function%` own-key arm onto `__hasOwnProperty`,
 * `__object_hasOwn` and `__delete_property`. All are
 * `(externref obj, externref key) -> i32`.
 *
 * Runs at FINALIZE, next to `fillRuntimeEvalCallablePropertyGetArm`, because
 * the marker type index is only known once a boundary site has minted it.
 * Declines — writing nothing at all — whenever the module has no marker type,
 * no native strings, or no string helpers, so a module that never links the
 * provider is byte-identical.
 */
export function fillRuntimeEvalIntrinsicFunctionOwnProps(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const markerTypeIdx = ctx.runtimeEvalInterpretedCallbackTypeIdx;
  if (markerTypeIdx === undefined) return;
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return;

  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (flattenIdx === undefined || equalsIdx === undefined) return;

  for (const [name, keys, answer] of WIDENED_NATIVES) {
    const fn = ctx.mod.functions.find((candidate) => candidate.name === name);
    if (!fn) continue;

    // Two params on all three, so appended locals start at 2 + locals.length —
    // the same index discipline the AOT-carrier front-guard one file away uses.
    const markerLocal = 2 + fn.locals.length;
    fn.locals.push({ name: "__fnintrinsic_marker", type: { kind: "ref_null", typeIdx: markerTypeIdx } });
    const keyAnyLocal = 2 + fn.locals.length;
    fn.locals.push({ name: "__fnintrinsic_key_any", type: { kind: "anyref" } });

    const keyEquals = (key: string): Instr[] => [
      { op: "local.get", index: keyAnyLocal },
      { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
      { op: "call", funcIdx: flattenIdx },
      ...nativeStringLiteralInstrs(ctx, key),
      { op: "call", funcIdx: equalsIdx },
    ];

    const keyArms: Instr[] = [];
    for (const key of keys) {
      keyArms.push(...keyEquals(key), {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: answer }, { op: "return" }],
      });
    }

    // Falling out of the arm without returning leaves the pre-existing body to
    // answer, so a marker key this slice does not own (`call`, an expando)
    // keeps exactly today's answer rather than a fabricated `false`.
    fn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: markerTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: markerTypeIdx },
          { op: "local.set", index: markerLocal },
          { op: "local.get", index: markerLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: markerTypeIdx, fieldIdx: 1 },
          { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A },
          { op: "i32.eq" },
          { op: "local.get", index: markerLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: markerTypeIdx, fieldIdx: 2 },
          { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B },
          { op: "i32.eq" },
          { op: "i32.and" },
          { op: "local.get", index: markerLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: markerTypeIdx, fieldIdx: 3 },
          { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_FUNCTION },
          { op: "i32.eq" },
          { op: "i32.and" },
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "local.tee", index: keyAnyLocal },
          { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
          { op: "i32.and" },
          { op: "if", blockType: { kind: "empty" }, then: keyArms },
        ],
      },
    );
  }
}
