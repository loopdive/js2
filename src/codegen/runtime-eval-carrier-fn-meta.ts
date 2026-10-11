// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 A14) `length` / `name` as configurable OWN properties of a realm
 * function reached through the runtime-eval callable carrier
 * (`$RuntimeEvalAotCallable`, `runtime-eval-callable.ts`) — the value
 * `GeneratorFunction(…)`, an eval-returned function, or a caller closure that
 * crossed the provider seam and came back.
 *
 * ## What was missing
 *
 * §10.2.9 / §10.2.10 give every such function `length` and `name` with
 * `{writable:false, enumerable:false, configurable:true}`. On the carrier the
 * three reflective surfaces disagreed (`--target standalone`, QuickJS provider,
 * `var f = GeneratorFunction("a", "")`):
 *
 * | read                                   | before | spec |
 * | -------------------------------------- | ------ | ---- |
 * | `f.length`                             | 1      | 1    |
 * | `f.hasOwnProperty("length")`           | true   | true |
 * | `Object.getOwnPropertyDescriptor(f, "length")` | undefined | `{1, --C}` |
 * | `delete f.length; f.hasOwnProperty("length")`  | true | false |
 *
 * The value came from the carrier's property-get trampoline and the has-own
 * answer from a hard-coded arm in `__hasOwnProperty`; nothing answered the
 * descriptor, and `delete` had nowhere to record itself.
 *
 * ## The mechanism — the #2896 metadata question, not a fourth spelling
 *
 * `proxy-revoker-meta.ts` / `ta-ctor-meta.ts` shape: `__builtinfn_get_meta` is
 * the one question `__builtinfn_gopd` (descriptor, `FLAG_CONFIGURABLE`) and the
 * `__extern_set` non-writable refusal both ask, so claiming the two keys there
 * answers the descriptor and the write refusal at once. The VALUE is the
 * carrier's own `get` trampoline — the same read `f.length` performs — so the
 * descriptor can never disagree with the property read.
 *
 * `delete` records the #4098 tombstone in the carrier's closure bag through
 * `__fninst_tombstone`, exactly as `function-instance-props.ts` does for a user
 * closure, and both arms stand down once the bag holds ANY entry for the key
 * (`__fninst_bag_owns`, marker-inclusive): a deleted key then reads absent
 * through the bag surfaces, and a redefined one reads the bag's record. The
 * hard-coded `__hasOwnProperty` arm asks the same `__fninst_bag_owns` question
 * (`runtime-eval-callable.ts`), which is what makes the delete observable.
 *
 * A key whose trampoline read is `undefined` is not claimed: a caller closure
 * with no name metadata keeps its previous answers.
 *
 * ## Bounded to modules with a `%GeneratorFunction%` site
 *
 * The surfaces are right for EVERY realm function behind the carrier (an
 * eval-returned function answers `gOPD(f, "length")` `undefined` today for the
 * same reason), but widening them to every provider-linked module — and to the
 * QuickJS adapter, which this compiler also builds — is a reach this slice did
 * not measure. So the arms are emitted only where the runtime-eval inventory
 * recorded a `generator-function-constructor` site; everywhere else the module
 * is byte-identical. Recorded in #6651 (A14) as the follow-up.
 *
 * Standalone only; byte-inert in a module that never minted the carrier.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { FNINST_BAG_OWNS, FNINST_TOMBSTONE } from "./function-instance-props.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { RUNTIME_EVAL_AOT_CALLABLE_BRAND_A, RUNTIME_EVAL_AOT_CALLABLE_BRAND_B } from "./runtime-eval-boundary.js";
import type { RuntimeEvalAotCallableCarrier } from "./runtime-eval-callable.js";

const EXT: ValType = { kind: "externref" };

/**
 * `i32` — does the carrier claim `length`/`name` for params (0 = receiver,
 * 1 = key)? On 1, `valueLocal` holds the target's value. Reads only the params
 * and writes only `valueLocal`, so it composes with any host body.
 */
function carrierClaimsKey(
  ctx: CodegenContext,
  carrier: RuntimeEvalAotCallableCarrier,
  valueLocal: number,
  bagOwnsIdx: number,
  isUndefinedIdx: number,
  flattenIdx: number,
  equalsIdx: number,
): Instr[] {
  const struct = carrier.structTypeIdx;
  const recv = (): Instr[] => [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }];
  const keyIs = (key: string): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "call", funcIdx: flattenIdx },
    ...nativeStringLiteralInstrs(ctx, key),
    { op: "call", funcIdx: equalsIdx },
  ];
  const brand = (field: number, value: number): Instr[] => [
    ...recv(),
    { op: "ref.cast", typeIdx: struct },
    { op: "struct.get", typeIdx: struct, fieldIdx: field },
    { op: "i32.const", value },
    { op: "i32.eq" },
  ];
  const claimed: Instr[] = [
    ...recv(),
    { op: "ref.cast", typeIdx: struct },
    { op: "local.get", index: 1 },
    ...recv(),
    { op: "ref.cast", typeIdx: struct },
    { op: "struct.get", typeIdx: struct, fieldIdx: 1 },
    { op: "call_ref", typeIdx: carrier.propertyGetFuncTypeIdx },
    { op: "local.tee", index: valueLocal },
    { op: "call", funcIdx: isUndefinedIdx },
    { op: "i32.eqz" },
  ];
  const zero: Instr[] = [{ op: "i32.const", value: 0 }];
  const ifI32 = (then: Instr[]): Instr => ({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then,
    else: [{ op: "i32.const", value: 0 }],
  });
  return [
    ...recv(),
    { op: "ref.test", typeIdx: struct },
    ifI32([
      ...brand(3, RUNTIME_EVAL_AOT_CALLABLE_BRAND_A),
      ...brand(4, RUNTIME_EVAL_AOT_CALLABLE_BRAND_B),
      { op: "i32.and" },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
      { op: "i32.and" },
      ifI32([
        ...keyIs("length"),
        ...keyIs("name"),
        { op: "i32.or" },
        ifI32([
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: bagOwnsIdx },
          { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: zero, else: claimed },
        ]),
      ]),
    ]),
  ];
}

/** Did the runtime-eval inventory record a `%GeneratorFunction%(…)` site in this module? */
export function carrierFnMetaEnabled(ctx: CodegenContext): boolean {
  return (
    ctx.standalone &&
    (ctx.runtimeEvalBoundaryPlan?.sites.some((site) => site.kind === "generator-function-constructor") ?? false)
  );
}

/** Splice the carrier arms into `__builtinfn_get_meta` and `__builtinfn_delete`. */
export function fillRuntimeEvalCarrierFnMeta(ctx: CodegenContext, carrier: RuntimeEvalAotCallableCarrier): void {
  if (!carrierFnMetaEnabled(ctx) || carrier.propertyGetTrampolineFuncIdx === undefined) return;
  const bagOwnsIdx = ctx.funcMap.get(FNINST_BAG_OWNS);
  const tombstoneIdx = ctx.funcMap.get(FNINST_TOMBSTONE);
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (
    bagOwnsIdx === undefined ||
    tombstoneIdx === undefined ||
    isUndefinedIdx === undefined ||
    flattenIdx === undefined ||
    equalsIdx === undefined ||
    ctx.anyStrTypeIdx < 0
  ) {
    return;
  }
  const claimsInto = (fn: { locals: { name: string; type: ValType }[] }): Instr[] => {
    const valueLocal = 2 + fn.locals.length;
    fn.locals.push({ name: "__runtime_eval_carrier_meta", type: EXT });
    return carrierClaimsKey(ctx, carrier, valueLocal, bagOwnsIdx, isUndefinedIdx, flattenIdx, equalsIdx);
  };

  const getMetaFn = ctx.mod.functions.find((f) => f.name === "__builtinfn_get_meta");
  if (getMetaFn) {
    const valueLocal = 2 + getMetaFn.locals.length;
    const claims = claimsInto(getMetaFn);
    getMetaFn.body.splice(0, 0, ...claims, {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: valueLocal }, { op: "return" }],
    });
  }

  // `delete f.length` / `delete f.name` — configurable, so the delete takes
  // effect: the tombstone hides the key from every bag surface and makes
  // `__fninst_bag_owns` stand the get_meta and has-own arms down.
  const deleteFn = ctx.mod.functions.find((f) => f.name === "__builtinfn_delete");
  if (deleteFn) {
    deleteFn.body.splice(0, 0, ...claimsInto(deleteFn), {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: tombstoneIdx },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
      ],
    });
  }
}
