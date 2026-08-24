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
 * | arm | receiver                                          | answer            | needs |
 * | --- | ------------------------------------------------- | ----------------- | ----- |
 * | 1   | `$Object` with a `[[PrimitiveValue]]` of the brand | the slot value    | the object runtime |
 * | 2   | an unwrapped primitive of the brand               | the receiver      | the brand predicate |
 * | 3   | `<Brand>.prototype` itself (`$NativeProto`)       | the §15.x constant | `$NativeProto` (#4619: registered here, not merely read) |
 * | —   | anything else                                     | TypeError         | — |
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
import { FLAG_INTERNAL, WRAPPER_PRIMITIVE_KEY } from "./object-runtime.js";
import { BUILTIN_BRAND_TABLE } from "./builtin-brands.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { definedFuncAt } from "./func-space.js"; // (#4631) dyn valueOf arm fill
import { registerNativeProtoType } from "./native-proto.js"; // (#4619) arm 3's type, eagerly

/** `$PropEntry.$value` field index (object-runtime.ts layout). */
const ENTRY_VALUE = 1;
/** `$PropEntry.$flags` field index (object-runtime.ts layout). */
const ENTRY_FLAGS = 2;
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
 * (#4619) Will {@link emitWrapperThisValueBody} emit, for this brand and this
 * module? Exactly its decline condition, asked WITHOUT emitting.
 *
 * A caller that needs to push a PREAMBLE before the ladder (Number's
 * `toString` validates its radix argument once, ahead of the receiver arms)
 * must ask this first: the ladder's own decline returns `null` having emitted
 * nothing, but the preamble is already in `fctx.body` by then, and the glue's
 * `??` chain would go on to emit a second body over those orphaned
 * instructions. A body emitter must be all-or-nothing.
 */
export function canEmitWrapperThisValueBody(ctx: CodegenContext, brandName: WrapperBrandName): boolean {
  return ctx.standalone === true && ctx.funcMap.get(PRIMITIVE_PREDICATE[brandName]) !== undefined;
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
  return emitWrapperThisValueBody(ctx, fctx, brandName, "valueOf", () => [{ op: "return" }]);
}

/**
 * (#4619) The `this<X>Value(this)` ABSTRACT-OPERATION body, shared by
 * `<Brand>.prototype.valueOf` (§21.1.3.7 / §22.1.3.28 / §20.3.3.3) and
 * `<Brand>.prototype.toString` (§21.1.3.6 / §22.1.3.27 / §20.3.3.2).
 *
 * The three receiver arms and the step-3 TypeError tail are IDENTICAL for both
 * members — the spec says so literally: `toString` is "Let x be
 * ? this<X>Value(this value)" followed by a conversion. Only the conversion
 * differs, so it is the one thing the caller supplies.
 *
 * `buildTail()` is spliced at the point each arm has pushed the recovered
 * primitive externref onto the stack; it must consume that one value, leave
 * exactly one externref, and `return`. `valueOf` passes `() => [{ op: "return" }]`,
 * which makes its emitted body byte-identical to the pre-#4619 one.
 *
 * It is a FACTORY, called once per arm, and that is not stylistic: finalize's
 * DCE/remap walk double-remaps an `Instr` object reached twice, so a tail
 * SHARED across the three arms would be corrupted (#4221 hit exactly this and
 * records it). Any local the tail needs must be allocated by the caller
 * OUTSIDE the factory, or each call would allocate its own.
 *
 * `member` only names the member in the step-3 TypeError message.
 */
export function emitWrapperThisValueBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  brandName: WrapperBrandName,
  member: string,
  buildTail: () => Instr[],
): ValType | null {
  if (!ctx.standalone) return null;
  const predicateIdx = ctx.funcMap.get(PRIMITIVE_PREDICATE[brandName]);
  if (predicateIdx === undefined) return null;

  const emitted: Instr[] = [];

  // ── arm 1: a `$Object` carrying `[[PrimitiveValue]]`.
  //
  // (#4619) Only THIS arm needs the object runtime, and it is now the only one
  // gated on it. Arms 2 and 3 need nothing but the brand predicate and the
  // `$NativeProto` type, so a module with no object runtime — one that never
  // builds a wrapper, and therefore can only ever reach this member with a bare
  // primitive or the prototype itself — used to decline the WHOLE body and fall
  // back to the "not yet implemented" refusal. Measured on the plain-module
  // lane: `var g = Boolean.prototype.toString; g.call(true)` hit that refusal
  // while the identical program with one object literal in it answered "true".
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
                then: [{ op: "local.get", index: prim }, ...buildTail()],
              },
            ],
          },
        ],
      },
    );
  }

  // ── arm 2: §21.1.3.7 step 1 — the receiver already IS the primitive.
  emitted.push(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: predicateIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 1 }, ...buildTail()],
    },
  );

  // ── arm 3: `<Brand>.prototype` itself. `$isClass != 0` declines — a user
  // class proto is a `$NativeProto` façade (#2101) with no [[PrimitiveValue]].
  //
  // (#4619) `registerNativeProtoType`, not a bare `ctx.nativeProtoTypeIdx` read.
  // The struct type registers LAZILY, the first time a builtin prototype OBJECT
  // is materialized — and this body is often emitted BEFORE that happens, so the
  // arm was silently skipped and `<Brand>.prototype.toString()` threw the
  // step-3 TypeError instead of answering the §15.x constant. Measured, and the
  // pair that isolates it: `var NP = Number.prototype; NP.toString()` answered
  // `"0"` (the binding materialized the proto first, registering the type)
  // while the inline `Number.prototype.toString()` in the same lane threw —
  // one ordering, two answers for one expression. Registering here is
  // append-only (a type, never a funcidx) and cannot shift a baked index.
  const protoTypeIdx = registerNativeProtoType(ctx);
  const protoDefault = protoDefaultPrimitive(ctx, brandName);
  if (protoDefault !== null) {
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
                then: [...protoDefault, ...buildTail()],
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
  emitThrowTypeError(ctx, fctx, `${brandName}.prototype.${member} requires that 'this' be a ${brandName}`);
  return { kind: "externref" };
}

/**
 * (#4631) Finalize fill: the BIGINT wrapper arm of `__dyn_valueOf`
 * (wrapper-valueof.ts) — the dispatcher that actually lowers a zero-arg
 * `<any>.valueOf()` call.
 *
 * ## Which dispatcher, and how that was established
 *
 * `a.valueOf()` on an `any` receiver does NOT go through
 * `__extern_method_call`, nor through an `__extern_get` + apply pair at the
 * call site. `tryEmitValueOfFallback` (expressions/valueof-fallback.ts)
 * intercepts the shape `<expr>.valueOf()` with zero arguments BEFORE the
 * generic dynamic method-call lowering and routes it to the single-argument
 * native `__dyn_valueOf`. Confirmed empirically for
 * `function anyv(v){return v} anyv(Object(1n)).valueOf()` by returning a
 * distinct native-string sentinel from each of that helper's four exits: the
 * program observed `A4631_APPLY`, i.e. the helper's arm 1.
 *
 * ## Why arm 1 answered wrongly for a bigint wrapper
 *
 * Arm 1 is `m = __extern_get(recv, "valueOf")` → `__apply_closure(m, recv,
 * [])`. For a Number/String/Boolean wrapper `m` is the brand's minted
 * `__proto_method_<brand>_valueOf` closure, which returns the
 * `[[PrimitiveValue]]` slot — right answer. A BigInt wrapper has no minted
 * brand closure, so `m` resolved to the Object-brand `valueOf` (return
 * `this`), and arm 2 — the slot read that WOULD have been right — is only
 * reached when `m` is null. The receiver came back instead of `1n`, which
 * renders in a test262 diff as an object-vs-bigint mismatch
 * (`harness/deepEqual-primitives-bigint.js`, leg `deepEqual(Object(1n), 1n)`).
 *
 * ## The arm
 *
 * Prepended to the helper body, so it runs BEFORE the property probe:
 *
 *     recv is $Object
 *       ∧ no OWN "valueOf" (an own property still shadows — §21.1.3.7 is only
 *         the INHERITED intrinsic)
 *       ∧ the reserved FLAG_INTERNAL `[[PrimitiveValue]]` slot is present
 *       ∧ that slot's VALUE is the native bigint carrier
 *     ⇒ return the slot value.
 *
 * The last conjunct is what keeps this from re-ordering anything that works
 * today: a Number/String/Boolean slot fails the `ref.test`, falls through, and
 * keeps resolving through the proto walk exactly as before — so a program that
 * REPLACES `Number.prototype.valueOf` still wins over the slot. Only the brand
 * with no proto closure to walk to changes behaviour. A module with no bigint
 * carrier type (`nativeBigIntTypeIdx < 0`) or no `__dyn_valueOf` emits nothing.
 */
export function fillBigIntDynValueOfArm(ctx: CodegenContext): void {
  const objTypes = ctx.objectRuntimeTypes;
  const dynValueOfIdx = ctx.funcMap.get("__dyn_valueOf");
  const objFindIdx = ctx.funcMap.get("__obj_find");
  if (!objTypes || dynValueOfIdx === undefined || objFindIdx === undefined) return;
  if (ctx.nativeBigIntTypeIdx < 0) return;
  const fn = definedFuncAt(ctx, dynValueOfIdx);
  if (!fn) return;
  const marker = ctx as unknown as { __bigintDynValueOfArmFilled?: boolean };
  if (marker.__bigintDynValueOfArmFilled) return;
  marker.__bigintDynValueOfArmFilled = true;

  const { objectTypeIdx, propEntryTypeIdx } = objTypes;
  addStringConstantGlobal(ctx, WRAPPER_PRIMITIVE_KEY);
  addStringConstantGlobal(ctx, "valueOf");
  // The helper declares param 0 + locals 1..3; append our own entry local
  // rather than reusing `e`, which arm 2 also writes.
  const entryLocal = 1 + fn.locals.length;
  fn.locals.push({ name: "__bdvo_e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } });

  const castObj = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectTypeIdx },
  ];
  const slotValue = (): Instr[] => [
    { op: "local.get", index: entryLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: ENTRY_VALUE },
  ];

  fn.body.splice(
    0,
    0,
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // An OWN `valueOf` shadows the intrinsic — leave the call alone.
        ...castObj(),
        ...stringConstantExternrefInstrs(ctx, "valueOf"),
        { op: "call", funcIdx: objFindIdx },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...castObj(),
            ...stringConstantExternrefInstrs(ctx, WRAPPER_PRIMITIVE_KEY),
            { op: "call", funcIdx: objFindIdx },
            { op: "local.tee", index: entryLocal },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: entryLocal },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: ENTRY_FLAGS },
                { op: "i32.const", value: FLAG_INTERNAL },
                { op: "i32.and" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    ...slotValue(),
                    { op: "ref.test", typeIdx: ctx.nativeBigIntTypeIdx },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [...slotValue(), { op: "extern.convert_any" }, { op: "return" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  );
}
