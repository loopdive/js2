// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4582) Native reflective bodies for `Boolean.prototype.valueOf` /
 * `Number.prototype.valueOf` / `String.prototype.valueOf` under
 * `--target standalone`.
 *
 * ## What was actually broken
 *
 * `Object(true).valueOf()` returned `true` on its own and threw
 * "Boolean.prototype.valueOf is not yet implemented in --target standalone"
 * as soon as the module ALSO mentioned `Boolean.prototype` — an unrelated
 * statement breaking the line above it.
 *
 * The mechanism is `__dyn_valueOf` (wrapper-valueof.ts), whose three arms are,
 * in spec order: (1) an own/inherited `valueOf` property → call it; (2) else
 * the wrapper's `[[PrimitiveValue]]` slot → return it; (3) else the receiver.
 * Reading `Boolean.prototype` REIFIES the builtin prototype, so the wrapper's
 * chain acquires a `valueOf` property — the refusing glue stub — and arm (1)
 * calls it. Arm (2), which held the correct answer, is never reached.
 *
 * So the intrinsic has to become real, and the receiver it must handle is a
 * plain `$Object` carrying a BOXED primitive under the FLAG_INTERNAL
 * `[[PrimitiveValue]]` key (what `__new_Number`/`__new_String`/`__new_Boolean`
 * install), NOT a raw `$BoxedBoolean`/`$BoxedNumber` carrier. A previous
 * attempt (#4582, reverted) unboxed the receiver directly with
 * `__unbox_boolean` and therefore answered `false` for `Object(true)` — a
 * silent wrong value, strictly worse than the refusal it replaced.
 *
 * ## Shape
 *
 * §20.3.3.3 / §21.1.3.7 / §22.1.3.28 are one algorithm, `thisXValue(this)`:
 * return `this` when it is already a primitive of the brand; return the
 * internal slot when it is an Object carrying that brand; otherwise throw a
 * TypeError. Brand membership is decided at the real representation boundary —
 * the CARRIER of the slot value (`$BoxedBoolean` / `$BoxedNumber`-or-i31 /
 * `$AnyString`), the same discrimination `standalone-wrapper-instanceof.ts`
 * uses for `x instanceof Boolean`.
 *
 * The helper answers `ref.null extern` for every non-match and the caller
 * turns that into a catchable TypeError, so a receiver this code cannot
 * positively identify produces a LOUD refusal, never a value. That asymmetry
 * is deliberate: the reverted attempt's failure mode was a plausible-looking
 * wrong boolean.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { mintDefinedFunc, pushDefinedFunc, definedFuncAt } from "./func-space.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime, FLAG_INTERNAL, WRAPPER_PRIMITIVE_KEY } from "./object-runtime.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";

/** The three primitive-wrapper brands that own a `valueOf` intrinsic. */
export type BoxedValueOfBrand = "Boolean" | "Number" | "String";

/** The `i31` abstract heap type (signed-LEB128 -20), mirroring the constant
 *  `standalone-wrapper-instanceof.ts` uses for the small-integer number
 *  carrier. A `$BoxedNumber` test alone misses `Object(1)`. */
const ABSTRACT_I31 = -20;

/**
 * Register (idempotently) `__wrapper_valueOf_<Brand>(anyref) -> externref`:
 * the brand's primitive value, or `ref.null extern` when the receiver does not
 * carry the brand. Returns `-1` when the standalone object runtime is
 * unavailable, in which case the caller keeps its existing refusal — a module
 * that cannot host the helper stays byte-identical.
 */
export function ensureBoxedValueOfHelper(ctx: CodegenContext, brand: BoxedValueOfBrand): number {
  const helperName = `__wrapper_valueOf_${brand}`;
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  ensureObjectRuntime(ctx);
  const objTypes = ctx.objectRuntimeTypes;
  const objFindIdx = ctx.funcMap.get("__obj_find");
  if (!objTypes || objFindIdx === undefined) return -1;
  const { objectTypeIdx, propEntryTypeIdx } = objTypes;

  const externref: ValType = { kind: "externref" };
  // 0 = receiver (anyref), 1 = the resolved `$PropEntry`.
  const E = 1;

  /** `ref.test` chain deciding brand membership of the anyref on the stack.
   *  Consumes the value; leaves i32. Callers push the value themselves, once
   *  per test, because `ref.test` pops it. */
  const brandTestOf = (push: () => Instr[]): Instr[] => {
    switch (brand) {
      case "String":
        return [...push(), { op: "ref.test", typeIdx: ctx.anyStrTypeIdx }];
      case "Number":
        // A `$BoxedNumber` OR an i31 — `Object(1)` stores the small-integer
        // carrier, so testing only the struct brand misses integral wrappers.
        return [
          ...push(),
          { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx },
          ...push(),
          { op: "ref.test", typeIdx: ABSTRACT_I31 },
          { op: "i32.or" },
        ];
      case "Boolean":
        return [...push(), { op: "ref.test", typeIdx: ctx.nativeBoxBooleanTypeIdx }];
    }
  };

  const slotValue = (): Instr[] => [
    { op: "local.get", index: E },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 }, // value (anyref)
  ];
  const receiver = (): Instr[] => [{ op: "local.get", index: 0 }];
  const nullResult: Instr[] = [{ op: "ref.null.extern" }];

  addStringConstantGlobal(ctx, WRAPPER_PRIMITIVE_KEY);

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      // Wrapper object: require the genuine internal slot, then brand-test the
      // slot's CARRIER. A `$Object` without the slot (a plain object literal)
      // and a cross-brand wrapper (`Number.prototype.valueOf.call(new
      // Boolean(1))`) both fall through to the null → TypeError.
      then: [
        { op: "local.get", index: 0 },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        ...stringConstantExternrefInstrs(ctx, WRAPPER_PRIMITIVE_KEY),
        { op: "call", funcIdx: objFindIdx },
        { op: "local.tee", index: E },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: externref },
          then: nullResult,
          else: [
            { op: "local.get", index: E },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 }, // flags
            { op: "i32.const", value: FLAG_INTERNAL },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "val", type: externref },
              then: [
                ...brandTestOf(slotValue),
                {
                  op: "if",
                  blockType: { kind: "val", type: externref },
                  then: [...slotValue(), { op: "extern.convert_any" }],
                  else: nullResult,
                },
              ],
              else: nullResult,
            },
          ],
        },
      ],
      // Primitive receiver — `Boolean.prototype.valueOf.call(true)`. Return it
      // unchanged when the carrier says it is this brand. A primitive arriving
      // in some other carrier the tests do not recognise yields null, i.e. a
      // TypeError: a refusal, which is what today's stub already does, and
      // never a fabricated value.
      else: [
        ...brandTestOf(receiver),
        {
          op: "if",
          blockType: { kind: "val", type: externref },
          then: [{ op: "local.get", index: 0 }, { op: "extern.convert_any" }],
          else: nullResult,
        },
      ],
    },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "anyref" }], [externref]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals: [{ name: "e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } }],
    body,
    exported: false,
  });
  // A minted index that did not land is a silent mis-call later.
  return definedFuncAt(ctx, funcIdx) ? funcIdx : -1;
}

/**
 * Native body for the reflective `<Brand>.prototype.valueOf` closure. Closure
 * ABI: local 0 = self wrapper, local 1 = externref `this`.
 *
 * Returns `null` when the helper cannot be registered, so the caller falls back
 * to its existing refusal.
 */
export function emitBoxedProtoValueOfBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  brand: BoxedValueOfBrand,
): ValType | null {
  if (!ctx.standalone) return null;
  const helperIdx = ensureBoxedValueOfHelper(ctx, brand);
  if (helperIdx < 0) return null;

  fctx.body.push({ op: "local.get", index: 1 });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "call", funcIdx: helperIdx });
  const resultLocal = allocLocal(fctx, `__vo_${brand}_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.tee", index: resultLocal });
  fctx.body.push({ op: "ref.is_null" });
  const throwInstrs: Instr[] = [];
  // §20.3.3.3 step 3 / §21.1.3.7 step 3 / §22.1.3.28 step 3.
  emitBrandCheckTypeError(ctx, throwInstrs, `${brand}.prototype.valueOf called on incompatible receiver`);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs });
  fctx.body.push({ op: "local.get", index: resultLocal });
  return { kind: "externref" };
}
