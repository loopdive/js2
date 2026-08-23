// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-5 T2) Native bodies for `Number.prototype.valueOf`,
 * `String.prototype.valueOf` and `Boolean.prototype.valueOf` under
 * `--target standalone`.
 *
 * ## The gap
 *
 * `Object(5)` / `new String("x")` / `Object(true)` already build the right
 * carrier: a plain `$Object` holding its [[NumberData]] / [[StringData]] /
 * [[BooleanData]] in the reserved FLAG_INTERNAL `[[PrimitiveValue]]` slot
 * (object-runtime.ts), `Object.getPrototypeOf` answers the right
 * `$NativeProto`, and `#4223`'s `__extern_get` arm already RESOLVES
 * `wrapper.valueOf` to the brand's `__proto_method_<brand>_valueOf` closure.
 * That closure's body was the catchable-TypeError refusal, so every read
 * ended in
 *
 *     TypeError: Number.prototype.valueOf is not yet implemented in --target standalone
 *
 * — measured on `built-ins/Object/S9.9_A{3,4,5}` and
 * `built-ins/Object/prototype/valueOf/S15.2.4.4_A1_T{1,2,3}`. The last three
 * are the confusing ones: the assertion renders as
 * `Expected SameValue(«1.1», «1.1») to be true`, because the fallback answers
 * `Object.prototype.valueOf` (return `this`) and test262 stringifies the
 * returned WRAPPER exactly like the primitive it wraps.
 *
 * ## The body — §21.1.3.7 / §22.1.3.28 / §20.3.3.3 `this<X>Value(this)`
 *
 * All three members are the same three-arm ladder over the same abstract op,
 * differing only in which primitive predicate they accept:
 *
 * | arm | receiver                                          | answer            |
 * | --- | ------------------------------------------------- | ----------------- |
 * | 1   | `$Object` with a `[[PrimitiveValue]]` of the brand | the slot value    |
 * | 2   | an unwrapped primitive of the brand               | the receiver      |
 * | 3   | `<Brand>.prototype` itself (`$NativeProto`)       | the §15.x constant |
 * | —   | anything else                                     | TypeError         |
 *
 * Arm 3 exists because ES5 §15.7.4 / §15.5.4 / §15.6.4 make each prototype an
 * instance of its own type ("The Number prototype object is itself a Number
 * object whose [[PrimitiveValue]] is +0"), but a standalone builtin prototype
 * is a `$NativeProto` — a different heap type with no own-props table — so it
 * has no slot to read. #4248 already ships this exact per-brand constant table
 * into `__to_primitive` for the same reason; this is the same three constants
 * at the `valueOf` entry point rather than the ToPrimitive one.
 *
 * ## Why the brand check is not optional
 *
 * The slot is brand-agnostic on the carrier — one key, three data types — so
 * arm 1 must classify the slot VALUE, not merely find the slot. Without that,
 * `Number.prototype.valueOf.call(new String("x"))` would answer `"x"` where
 * §21.1.3.7 step 3 requires a TypeError. Classification reuses the
 * `__typeof_{number,string,boolean}` predicates (the same ladder
 * object-proto-tostring.ts uses to tag a wrapper for `[object String]`), so a
 * wrapper cannot be classified one way for its tag and another for its value.
 *
 * A receiver that matches no arm THROWS — §21.1.3.7 step 3 is a real
 * `TypeError`, and `built-ins/Boolean/prototype/valueOf/S15.6.4.3_A2_T5`
 * (`s1.valueOf = Boolean.prototype.valueOf; s1.valueOf()`) asserts exactly
 * that. The throw is emitted HERE rather than left to the caller: `makeGlue`
 * reaches its refusal through `??`, so returning a non-null result short-
 * circuits it and no tail would run at all. That is not a hypothetical — the
 * first cut of this module omitted the throw and regressed that file from pass
 * to fail, measured on the wide control.
 *
 * `emitThrowTypeError` is inlined rather than reached through
 * `array-object-proto.ts`'s `emitProtoMemberBodyRefusal`: that module imports
 * THIS one, so reaching back would close an import cycle. Same reason, and same
 * shape, as `object-proto-tostring.ts`'s inlined refusal.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { WRAPPER_PRIMITIVE_KEY } from "./object-runtime.js";
import { BUILTIN_BRAND_TABLE } from "./builtin-brands.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitThrowTypeError } from "./expressions/helpers.js";

/** `$PropEntry.$value` field index (object-runtime.ts layout). */
const ENTRY_VALUE = 1;
/** `$NativeProto` field indices (native-proto.ts layout). */
const NP_BRAND = 0;
const NP_IS_CLASS = 1;

/** The three wrapper families, and the predicate that recognises each value. */
const PRIMITIVE_PREDICATE = {
  Number: "__typeof_number",
  String: "__typeof_string",
  Boolean: "__typeof_boolean",
} as const;

export type WrapperBrandName = keyof typeof PRIMITIVE_PREDICATE;

/** True when `name` is one of the three primitive-wrapper families. */
export function isWrapperBrandName(name: string): name is WrapperBrandName {
  return name in PRIMITIVE_PREDICATE;
}

/**
 * The §15.5.4 / §15.6.4 / §15.7.4 default [[PrimitiveValue]] of
 * `<Brand>.prototype`, as instructions leaving one externref on the stack.
 * Mirrors `unshiftNativeProtoToPrimitiveArm` (#4248) — `+0` is emitted as the
 * i31 small-int box directly, which is the shape `__box_number` itself
 * produces for `+0`. Returns `null` when a needed helper is absent, which
 * declines arm 3 without touching the other two.
 */
function protoDefaultPrimitive(ctx: CodegenContext, brandName: WrapperBrandName): Instr[] | null {
  if (brandName === "Number") {
    return [{ op: "i32.const", value: 0 }, { op: "ref.i31" }, { op: "extern.convert_any" }];
  }
  if (brandName === "String") {
    addStringConstantGlobal(ctx, "");
    const empty = stringConstantExternrefInstrs(ctx, "");
    return empty.length > 0 ? empty.map((i) => ({ ...i })) : null;
  }
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  if (boxBooleanIdx === undefined) return null;
  return [
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: boxBooleanIdx },
  ];
}

/**
 * Emit the `this<X>Value(this)` body for `<brandName>.prototype.valueOf` into
 * `fctx` (closure ABI: param 0 = self, param 1 = `this`, result externref).
 *
 * Returns `{ kind: "externref" }` when the arms were emitted, or `null` to
 * decline WITHOUT emitting anything — the caller then keeps the member's
 * existing catchable-TypeError refusal, unchanged.
 *
 * Every arm `return`s its answer; the tail is the §21.1.3.7 step-3 TypeError,
 * so a receiver the arms cannot place throws rather than falling off the end.
 */
export function emitWrapperProtoValueOfBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  brandName: WrapperBrandName,
): ValType | null {
  if (!ctx.standalone) return null;
  const predicateIdx = ctx.funcMap.get(PRIMITIVE_PREDICATE[brandName]);
  if (predicateIdx === undefined) return null;

  const emitted: Instr[] = [];

  // ── arms 1-2: a `$Object` carrying `[[PrimitiveValue]]`, or a bare primitive.
  const objTypes = ctx.objectRuntimeTypes;
  const objFindIdx = ctx.funcMap.get("__obj_find");
  if (objTypes !== undefined && objFindIdx !== undefined) {
    const { objectTypeIdx, propEntryTypeIdx } = objTypes;
    const thisAny = allocLocal(fctx, `__wvo_any_${fctx.locals.length}`, { kind: "anyref" });
    const slot = allocLocal(fctx, `__wvo_slot_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: propEntryTypeIdx,
    });
    const prim = allocLocal(fctx, `__wvo_prim_${fctx.locals.length}`, { kind: "externref" });
    addStringConstantGlobal(ctx, WRAPPER_PRIMITIVE_KEY);

    emitted.push(
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.set", index: thisAny },
      { op: "local.get", index: thisAny },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: thisAny },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          ...stringConstantExternrefInstrs(ctx, WRAPPER_PRIMITIVE_KEY),
          { op: "call", funcIdx: objFindIdx },
          { op: "local.tee", index: slot },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: slot },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: ENTRY_VALUE },
              { op: "extern.convert_any" },
              { op: "local.set", index: prim },
              { op: "local.get", index: prim },
              { op: "call", funcIdx: predicateIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                // §21.1.3.7 step 2 / §22.1.3.28 step 2 / §20.3.3.3 step 2.
                then: [{ op: "local.get", index: prim }, { op: "return" }],
              },
            ],
          },
        ],
      },
      // §21.1.3.7 step 1 — the receiver already IS the primitive.
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: predicateIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 1 }, { op: "return" }],
      },
    );
  }

  if (emitted.length === 0) return null;

  // ── arm 3: `<Brand>.prototype` itself. `$isClass != 0` declines — a user
  // class proto is a `$NativeProto` façade (#2101) with no [[PrimitiveValue]].
  const protoTypeIdx = ctx.nativeProtoTypeIdx;
  const protoDefault = protoTypeIdx === undefined ? null : protoDefaultPrimitive(ctx, brandName);
  if (protoTypeIdx !== undefined && protoDefault !== null) {
    emitted.push(
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: protoTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: protoTypeIdx },
          { op: "struct.get", typeIdx: protoTypeIdx, fieldIdx: NP_IS_CLASS },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [],
            else: [
              { op: "local.get", index: 1 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: protoTypeIdx },
              { op: "struct.get", typeIdx: protoTypeIdx, fieldIdx: NP_BRAND },
              { op: "i32.const", value: BUILTIN_BRAND_TABLE[brandName]! },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...protoDefault, { op: "return" }],
              },
            ],
          },
        ],
      },
    );
  }

  fctx.body.push(...emitted);
  // §21.1.3.7 step 3 / §22.1.3.28 step 3 / §20.3.3.3 step 3 — a receiver that is
  // neither the primitive nor an object holding the matching internal slot is a
  // TypeError. Ends `unreachable`, so the declared externref result is satisfied
  // on every path that reaches here.
  emitThrowTypeError(ctx, fctx, `${brandName}.prototype.valueOf requires that 'this' be a ${brandName}`);
  return { kind: "externref" };
}
