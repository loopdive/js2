// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster E, slice E3) OrdinaryToPrimitive over a `$__vec_base` carrier's
 * OWN property surface — the step `__to_primitive`'s vec arm skipped entirely.
 *
 * ## The gap
 *
 * `__to_primitive` (object-runtime.ts) reduces a `$__vec_base` carrier with one
 * instruction pair: `__array_to_primitive_string(v)`, i.e.
 * `Array.prototype.toString` = `join(",")`. §7.1.1 step 2 (`GetMethod(input,
 * @@toPrimitive)`) and §7.1.1.1 (the hint-ordered `valueOf`/`toString`
 * cascade) never run for ANY vec receiver, so an own method installed on the
 * carrier is invisible. Measured on this slice's base (`.tmp/6651/p1.js`,
 * standalone, QuickJS oracle):
 *
 * ```
 * a = [1];             a.valueOf = () => 7;   a + 0   →  "10"  (spec 7)
 * b = [2];             b.toString = () => "Z"; b + ""  →  "2"   (spec "Z")
 * s = new Int8Array(1); s.valueOf = () => 42;  Number(s) → 0    (spec 42)
 * ```
 *
 * A TypedArray view is a `$__vec_base` subtype (#3057), so this is also the
 * whole of `TypedArrayConstructors/ctors/object-arg/throws-setting-obj-*`:
 * `new TA([8, sample])` performs `Set(O, 1, sample)` → IntegerIndexedElementSet
 * → `ToNumber(sample)` → ToPrimitive(sample, number), and the test's
 * `sample.valueOf` / `sample.toString` / `sample[@@toPrimitive]` must run and
 * propagate their abrupt completion. They did not; the write completed
 * silently.
 *
 * ## OWN-only, and that boundary is load-bearing (#4655 / #4663)
 *
 * The cascade MUST NOT be spelled with `__extern_get(v, name)`. #4655 measured
 * why and #4663 records it: on a vec receiver that read resolves the BUILTIN
 * `Array.prototype.toString` when the user installed nothing, and calling it
 * routes straight back into `__to_primitive`'s vec arm — unbounded recursion on
 * `Number([1])`, `1 + [2]`, every array-in-string-concat. `__vec_prop_get` is
 * out for the same reason one level down: its bag MISS tail is
 * `protoIndexRecvGetMissInstrs`, and #4663 measured that companion returning
 * the BUILTIN whenever `protoMemberDirty` armed the native-proto seeder.
 *
 * So the method lookup here reads only surfaces a user write can reach:
 *
 *   1. `__hasOwnProperty(v, key)` → `__extern_get(v, key)`. This is the
 *      DYNAMIC-view door: #3177/E2 gave `$__ta_dyn_view` a `__hasOwnProperty`
 *      arm answering from its expando side-table (field 4), and the matching
 *      `__extern_get` arm reads the same table. A plain vec answers `false`
 *      here for any non-index key (`fillVecHasOwnHelpers` answers from
 *      `__vec_gopd` and returns — the #4010 overlay/bag split), so this door
 *      costs it one call and nothing else.
 *   2. The #3537 vec expando BAG, addressed directly: `__is_vec_prop_carrier`
 *      → `__vec_bag_lookup` (LOOKUP, never ensure — a ToPrimitive probe must
 *      not allocate a bag) → `__obj_find(bag, key)` for presence →
 *      `__extern_get(bag, key)` for the value. The bag is a `$Object`, so both
 *      reads are ordinary and terminate. This is the STATIC-carrier door —
 *      `var s = new Int8Array(1); s.valueOf = f` lands here.
 *
 * Neither door can reach a builtin, so no arm of this module can recurse.
 * Inherited overrides are NOT consulted: a user `Array.prototype.toString` is
 * already honoured one level down by #4663's companion probe inside
 * `__array_to_primitive_string`, and widening the lookup to the chain is how
 * #4017 cost 684 host-free passes.
 *
 * ## Fall-through, not throw
 *
 * When no own method yields a primitive the helper tails into
 * `__array_to_primitive_string(v)` — today's answer, byte-for-byte the same
 * result. That fall-through IS the §7.1.1.1 intrinsic step: a TypedArray's
 * `toString` intrinsic is `%TypedArray%.prototype.toString` = §23.1.3.30
 * `Array.prototype.toString`, and an Array's is the same function.
 *
 * One deliberate deviation, recorded rather than approximated: when an own
 * `toString` IS present, callable, and returns an OBJECT, §7.1.1.1 step 6
 * throws a TypeError; this helper falls through to the join instead. Making
 * that throw requires distinguishing "absent" from "present but unusable" in
 * the last cascade step, and every test262 row in this slice's manifest has the
 * method THROW rather than return an object.
 *
 * ## Reserve / fill
 *
 * Same funcIdx discipline as `reserveArrayToPrimitiveString`: the body needs
 * `__extern_get`, `__hasOwnProperty`, `__obj_find` and the vec-bag helpers,
 * all registered after `__to_primitive`, so the placeholder is minted at
 * `__to_primitive`-emit time (stable `call` target under the late-import index
 * shifter) and the body is filled at finalize. A fill that cannot resolve every
 * dependency leaves a plain forward to `__array_to_primitive_string`, i.e. the
 * pre-slice behaviour.
 *
 * Standalone only — the JS-host lane reduces arrays through the host
 * `__extern_toString` import and never reaches `__to_primitive`'s vec arm.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ARRAY_TO_PRIMITIVE_STRING } from "./array-to-primitive.js";
import { CALL_ACCESSOR_GET } from "./accessor-driver.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs, stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";

export const VEC_OWN_TO_PRIMITIVE = "__vec_own_to_primitive";

/** #3537 vec expando side table. */
const IS_VEC_PROP_CARRIER = "__is_vec_prop_carrier";
const VEC_BAG_LOOKUP = "__vec_bag_lookup";

/** Well-known symbol id for `Symbol.toPrimitive` (the `__box_symbol` table). */
const WELL_KNOWN_TO_PRIMITIVE = 3;

/** Params 0 = receiver, 1 = hint. Locals start at 2. */
const L_METHOD = 2;
const L_RESULT = 3;
const L_BAG = 4;
const L_ARGS = 5;
/**
 * (§7.1.1.1 step 6) Set when an own `toString` was PRESENT and callable, i.e.
 * when it SHADOWS the `Array.prototype.toString` intrinsic this helper would
 * otherwise tail into. Exhausting the cascade with the intrinsic shadowed is a
 * TypeError, not a join.
 */
const L_SHADOWED = 6;

/**
 * Reserve `__vec_own_to_primitive(externref v, externref hint) -> externref`.
 * The placeholder is a bare `unreachable`; `fillVecOwnToPrimitive` patches it.
 * Idempotent. Returns the funcIdx.
 */
export function reserveVecOwnToPrimitive(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(VEC_OWN_TO_PRIMITIVE);
  if (existing !== undefined) return existing;
  const sigIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$vec_own_to_primitive_type",
  );
  const funcIdx = mintDefinedFunc(ctx);
  const placeholder: WasmFunction = {
    name: VEC_OWN_TO_PRIMITIVE,
    typeIdx: sigIdx,
    locals: [],
    body: [{ op: "unreachable" }],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, placeholder);
  ctx.funcMap.set(VEC_OWN_TO_PRIMITIVE, funcIdx);
  return funcIdx;
}

interface FillDeps {
  externGetIdx: number;
  hasOwnIdx: number;
  callMethod0Idx: number;
  typeofFunctionIdx: number;
  primitivePredicates: number[];
  isVecCarrierIdx: number | undefined;
  bagLookupIdx: number | undefined;
}

/** `local` holds a primitive (§7.1.1.1 step 2.b.ii) → return it. */
function returnIfPrimitive(deps: FillDeps, localIdx: number): Instr[] {
  return [
    { op: "local.get", index: localIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: localIdx }, { op: "return" }],
    },
    ...deps.primitivePredicates.flatMap((predIdx): Instr[] => [
      { op: "local.get", index: localIdx },
      { op: "call", funcIdx: predIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: localIdx }, { op: "return" }],
      },
    ]),
  ];
}

/**
 * Leave the receiver's OWN value for `key` in `L_METHOD` (null when absent).
 * `key` is a factory so the two doors never alias one `Instr` object into two
 * tree positions (`reference_shared_instr_object_dce_double_remap`).
 */
function ownLookup(deps: FillDeps, key: () => Instr[]): Instr[] {
  const bagDoor: Instr[] =
    deps.isVecCarrierIdx === undefined || deps.bagLookupIdx === undefined
      ? []
      : [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: deps.isVecCarrierIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: deps.bagLookupIdx },
              { op: "local.tee", index: L_BAG },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // The bag is a `$Object`, so own-ness over it is an ORDINARY
                  // `__hasOwnProperty` question — the same own-guarded bag read
                  // `__vec_prop_get` performs, minus its proto-miss tail (which
                  // is the arm that can surface a builtin; see the module header).
                  { op: "local.get", index: L_BAG },
                  ...key(),
                  { op: "call", funcIdx: deps.hasOwnIdx },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "local.get", index: L_BAG },
                      ...key(),
                      { op: "call", funcIdx: deps.externGetIdx },
                      { op: "local.set", index: L_METHOD },
                    ],
                  },
                ],
              },
            ],
          },
        ];
  return [
    { op: "ref.null.extern" },
    { op: "local.set", index: L_METHOD },
    // Door 1 — whatever `__hasOwnProperty` already knows about this carrier
    // (the `$__ta_dyn_view` expando table since #3177/E2).
    { op: "local.get", index: 0 },
    ...key(),
    { op: "call", funcIdx: deps.hasOwnIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        ...key(),
        { op: "call", funcIdx: deps.externGetIdx },
        { op: "local.set", index: L_METHOD },
      ],
    },
    // Door 2 — the #3537 expando bag, addressed directly.
    { op: "local.get", index: L_METHOD },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: bagDoor },
  ];
}

/**
 * One §7.1.1.1 cascade step over an OWN method name. `shadowsIntrinsic` marks
 * the `toString` step: a present, callable own `toString` replaces the
 * `Array.prototype.toString` intrinsic, so a cascade that then exhausts must
 * throw rather than fall through to the join.
 */
function tryOwnMethod(deps: FillDeps, key: () => Instr[], shadowsIntrinsic: boolean): Instr[] {
  return [
    ...ownLookup(deps, key),
    { op: "local.get", index: L_METHOD },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_METHOD },
        { op: "call", funcIdx: deps.typeofFunctionIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...(shadowsIntrinsic
              ? ([
                  { op: "i32.const", value: 1 },
                  { op: "local.set", index: L_SHADOWED },
                ] satisfies Instr[])
              : []),
            { op: "local.get", index: 0 },
            { op: "local.get", index: L_METHOD },
            { op: "call", funcIdx: deps.callMethod0Idx },
            { op: "local.set", index: L_RESULT },
            ...returnIfPrimitive(deps, L_RESULT),
          ],
        },
      ],
    },
  ];
}

/**
 * §7.1.1 step 2 — an OWN `@@toPrimitive` on the carrier. `[]` when the module
 * has no symbol substrate or no `__apply_closure` (nothing to call it with).
 */
function ownSymbolToPrimitiveArm(ctx: CodegenContext, deps: FillDeps, hintOrDefault: () => Instr[]): Instr[] {
  const boxSymbolIdx = ctx.funcMap.get("__box_symbol");
  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError");
  if (
    boxSymbolIdx === undefined ||
    applyClosureIdx === undefined ||
    objVecNewIdx === undefined ||
    objVecPushIdx === undefined ||
    typeErrorCtorIdx === undefined ||
    ctx.exnTagIdx < 0
  ) {
    return [];
  }
  const message = "Cannot convert object to primitive value";
  addStringConstantGlobal(ctx, message);
  const symbolKey = (): Instr[] => [
    { op: "i32.const", value: WELL_KNOWN_TO_PRIMITIVE },
    { op: "call", funcIdx: boxSymbolIdx },
  ];
  return [
    ...ownLookup(deps, symbolKey),
    { op: "local.get", index: L_METHOD },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_METHOD },
        { op: "call", funcIdx: deps.typeofFunctionIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "call", funcIdx: objVecNewIdx },
            { op: "local.set", index: L_ARGS },
            { op: "local.get", index: L_ARGS },
            // §7.1.1 step 1: an absent PreferredType is the STRING "default",
            // never the null the internal hint slot uses to encode it.
            ...hintOrDefault(),
            { op: "call", funcIdx: objVecPushIdx },
            { op: "local.get", index: L_METHOD },
            { op: "local.get", index: 0 },
            { op: "local.get", index: L_ARGS },
            { op: "call", funcIdx: applyClosureIdx },
            { op: "local.set", index: L_RESULT },
            ...returnIfPrimitive(deps, L_RESULT),
            // §7.1.1 step 2.c — an object result is a TypeError, not a
            // fall-through to the join.
            ...stringConstantExternrefInstrs(ctx, message),
            { op: "call", funcIdx: typeErrorCtorIdx },
            { op: "throw", tagIdx: ctx.exnTagIdx },
          ],
        },
      ],
    },
  ];
}

/**
 * Fill `__vec_own_to_primitive`. No-op when the placeholder was never reserved.
 * On a missing dependency the body degrades to a plain
 * `__array_to_primitive_string` forward — exactly the pre-slice answer.
 */
export function fillVecOwnToPrimitive(ctx: CodegenContext): void {
  const selfIdx = ctx.funcMap.get(VEC_OWN_TO_PRIMITIVE);
  if (selfIdx === undefined) return;
  const fn = definedFuncAt(ctx, selfIdx);
  if (!fn) return;

  const arrayToPrimIdx = ctx.funcMap.get(ARRAY_TO_PRIMITIVE_STRING);
  if (arrayToPrimIdx === undefined) return;
  const forward: Instr[] = [{ op: "local.get", index: 0 }, { op: "call", funcIdx: arrayToPrimIdx }, { op: "return" }];
  fn.locals = [];
  fn.body = forward;

  const externGetIdx = ctx.funcMap.get("__extern_get");
  const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty");
  const callMethod0Idx = ctx.funcMap.get(CALL_ACCESSOR_GET);
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  const typeofStringIdx = ctx.funcMap.get("__typeof_string");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (
    externGetIdx === undefined ||
    hasOwnIdx === undefined ||
    callMethod0Idx === undefined ||
    typeofFunctionIdx === undefined ||
    typeofStringIdx === undefined ||
    strFlattenIdx === undefined ||
    strEqualsIdx === undefined ||
    ctx.anyStrTypeIdx < 0
  ) {
    return;
  }

  const primitivePredicates = [
    ctx.funcMap.get("__typeof_number"),
    ctx.funcMap.get("__typeof_boolean"),
    typeofStringIdx,
    ctx.funcMap.get("__typeof_undefined"),
    ctx.funcMap.get("__typeof_bigint"),
  ].filter((idx): idx is number => idx !== undefined);

  const deps: FillDeps = {
    externGetIdx,
    hasOwnIdx,
    callMethod0Idx,
    typeofFunctionIdx,
    primitivePredicates,
    isVecCarrierIdx: ctx.funcMap.get(IS_VEC_PROP_CARRIER),
    bagLookupIdx: ctx.funcMap.get(VEC_BAG_LOOKUP),
  };

  const stringExtern = (value: string): Instr[] => {
    addStringConstantGlobal(ctx, value);
    return stringConstantExternrefInstrs(ctx, value);
  };
  const nameKey = (value: "valueOf" | "toString"): (() => Instr[]) => {
    addStringConstantGlobal(ctx, value);
    return () => stringConstantExternrefInstrs(ctx, value);
  };
  const hintOrDefault = (): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: stringExtern("default"),
      else: [{ op: "local.get", index: 1 }],
    },
  ];
  /** `hint === "string"` — the same test `__to_primitive` makes on its own param. */
  const isStringHint = (): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: typeofStringIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: 1 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
            { op: "call", funcIdx: strFlattenIdx },
            ...nativeStringLiteralInstrs(ctx, "string"),
            { op: "call", funcIdx: strFlattenIdx },
            { op: "call", funcIdx: strEqualsIdx },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
    },
  ];

  const locals: { name: string; type: ValType }[] = [
    { name: "vp_method", type: { kind: "externref" } },
    { name: "vp_result", type: { kind: "externref" } },
    { name: "vp_bag", type: { kind: "externref" } },
    { name: "vp_args", type: { kind: "externref" } },
    { name: "vp_shadowed", type: { kind: "i32" } },
  ];
  const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError");
  const exhaustedThrow: Instr[] =
    typeErrorCtorIdx === undefined || ctx.exnTagIdx < 0
      ? []
      : [
          { op: "local.get", index: L_SHADOWED },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...stringExtern("Cannot convert object to primitive value"),
              { op: "call", funcIdx: typeErrorCtorIdx },
              { op: "throw", tagIdx: ctx.exnTagIdx },
            ],
          },
        ];
  fn.locals = locals;
  fn.body = [
    ...ownSymbolToPrimitiveArm(ctx, deps, hintOrDefault),
    ...isStringHint(),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...tryOwnMethod(deps, nameKey("toString"), true), ...tryOwnMethod(deps, nameKey("valueOf"), false)],
      else: [...tryOwnMethod(deps, nameKey("valueOf"), false), ...tryOwnMethod(deps, nameKey("toString"), true)],
    },
    ...exhaustedThrow,
    ...forward.map((instr) => ({ ...instr })),
  ];
}
