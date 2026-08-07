/**
 * (#4173) Fast tag-pair dispatch for `__extern_strict_eq`'s identity-MISS
 * path (flag-gated via `ctx.fastStrictEq`, default ON).
 *
 * Profiled on the standalone acorn parse, `this.type === tt.x` style
 * comparisons MISS identity most of the time (token mismatch is the common
 * case), and the legacy fallthrough then allocates TWO 5-field `$AnyValue`
 * boxes (`__any_from_extern` per operand) plus a third call
 * (`__any_strict_eq`) only to conclude "different objects → false". That made
 * `__extern_strict_eq` 3.7% self-time (plus hidden GC pressure) in the #4157
 * post-campaign profile. Since §7.2.16 IsStrictlyEqual on two NON-$AnyValue
 * eq-refs is fully decidable by local classification —
 *   number×number  → f64.eq (NaN≠NaN and +0===-0 fall out of f64.eq)
 *   string×string  → content equality (`__str_equals`, self-flattening)
 *   bool×bool      → normalized payload equality
 *   bigint×bigint  → i64.eq
 *   any other pair → false (identity already failed; cross-type strict
 *                    equality of distinct value classes is always false)
 * — the dispatch answers without calls or allocations. `$AnyValue` carriers
 * on EITHER side keep the legacy path: a tag-6/tag-5 box can wrap the SAME
 * reference the other operand holds raw (the #2175 cross-representation
 * identity case), so only `__any_strict_eq`'s reconciliation may decide
 * those. This mirrors the default-ON tag-5 value classifier's answers
 * (#2040/#2585) — two distinct plain objects already compare `ref.eq`-false
 * there — so flag-ON is answer-equivalent, just call- and alloc-free.
 *
 * If the module HAS a native string type but no `__str_equals`, the whole
 * fast path is skipped (a string pair would otherwise fast-false wrongly).
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

const I31_HEAP_TYPE = -20;

/** `f64` payload of a numeric operand (local holds a BoxedNumber or i31 ref). */
function numPayload(ctx: CodegenContext, localIdx: number): Instr[] {
  return [
    { op: "local.get", index: localIdx },
    { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "local.get", index: localIdx },
        { op: "ref.cast", typeIdx: ctx.nativeBoxNumberTypeIdx },
        { op: "struct.get", typeIdx: ctx.nativeBoxNumberTypeIdx, fieldIdx: 0 },
      ],
      else: [
        { op: "local.get", index: localIdx },
        { op: "ref.cast", typeIdx: I31_HEAP_TYPE },
        { op: "i31.get_s" },
        { op: "f64.convert_i32_s" },
      ],
    },
  ];
}

function isNumeric(ctx: CodegenContext, localIdx: number): Instr[] {
  return [
    { op: "local.get", index: localIdx },
    { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx },
    { op: "local.get", index: localIdx },
    { op: "ref.test", typeIdx: I31_HEAP_TYPE },
    { op: "i32.or" },
  ];
}

/** string × string → content equality (flattens cons internally). */
function stringArm(ctx: CodegenContext, strEqualsIdx: number | undefined): Instr[] {
  if (ctx.anyStrTypeIdx < 0 || strEqualsIdx === undefined) return [];
  return [
    { op: "local.get", index: 2 },
    { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 3 },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 2 },
            { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
            { op: "local.get", index: 3 },
            { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
            { op: "call", funcIdx: strEqualsIdx },
            { op: "return" },
          ],
        },
        { op: "i32.const", value: 0 },
        { op: "return" },
      ],
    },
  ];
}

/** boolean × boolean → normalized payload equality. */
function boolArm(ctx: CodegenContext): Instr[] {
  return [
    { op: "local.get", index: 2 },
    { op: "ref.test", typeIdx: ctx.nativeBoxBooleanTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 3 },
        { op: "ref.test", typeIdx: ctx.nativeBoxBooleanTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 2 },
            { op: "ref.cast", typeIdx: ctx.nativeBoxBooleanTypeIdx },
            { op: "struct.get", typeIdx: ctx.nativeBoxBooleanTypeIdx, fieldIdx: 0 },
            { op: "i32.eqz" },
            { op: "local.get", index: 3 },
            { op: "ref.cast", typeIdx: ctx.nativeBoxBooleanTypeIdx },
            { op: "struct.get", typeIdx: ctx.nativeBoxBooleanTypeIdx, fieldIdx: 0 },
            { op: "i32.eqz" },
            { op: "i32.eq" },
            { op: "return" },
          ],
        },
        { op: "i32.const", value: 0 },
        { op: "return" },
      ],
    },
  ];
}

/** bigint × bigint → i64.eq (mirrors the #3173 legacy arm). */
function bigintArm(ctx: CodegenContext): Instr[] {
  if (ctx.nativeBigIntTypeIdx < 0) return [];
  return [
    { op: "local.get", index: 2 },
    { op: "ref.test", typeIdx: ctx.nativeBigIntTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 3 },
        { op: "ref.test", typeIdx: ctx.nativeBigIntTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 2 },
            { op: "ref.cast", typeIdx: ctx.nativeBigIntTypeIdx },
            { op: "struct.get", typeIdx: ctx.nativeBigIntTypeIdx, fieldIdx: 0 },
            { op: "local.get", index: 3 },
            { op: "ref.cast", typeIdx: ctx.nativeBigIntTypeIdx },
            { op: "struct.get", typeIdx: ctx.nativeBigIntTypeIdx, fieldIdx: 0 },
            { op: "i64.eq" },
            { op: "return" },
          ],
        },
        { op: "i32.const", value: 0 },
        { op: "return" },
      ],
    },
  ];
}

/**
 * Build the fast-dispatch instruction sequence for `ensureExternStrictEqHelper`
 * (any-helpers.ts). Emitted INSIDE the both-eq-refs branch, right after the
 * `ref.eq` identity check missed; locals 2/3 hold the internalized anyref
 * operands. Returns `[]` when the fast path cannot be built (flag off, box
 * types unregistered, or strings present without a native `__str_equals`).
 */
export function buildFastStrictEqDispatch(ctx: CodegenContext): Instr[] {
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const canFastDispatch =
    ctx.fastStrictEq === true &&
    ctx.nativeBoxNumberTypeIdx >= 0 &&
    ctx.nativeBoxBooleanTypeIdx >= 0 &&
    (ctx.anyStrTypeIdx < 0 || strEqualsIdx !== undefined);
  if (!canFastDispatch) return [];
  return [
    // Neither operand is an `$AnyValue` box → classify locally.
    ...(ctx.anyValueTypeIdx >= 0
      ? ([
          { op: "local.get", index: 2 },
          { op: "ref.test", typeIdx: ctx.anyValueTypeIdx },
          { op: "local.get", index: 3 },
          { op: "ref.test", typeIdx: ctx.anyValueTypeIdx },
          { op: "i32.or" },
          { op: "i32.eqz" },
        ] satisfies Instr[])
      : ([{ op: "i32.const", value: 1 }] satisfies Instr[])),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // number × number → f64.eq (NaN/±0 semantics are f64.eq's).
        ...isNumeric(ctx, 2),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...isNumeric(ctx, 3),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [...numPayload(ctx, 2), ...numPayload(ctx, 3), { op: "f64.eq" }, { op: "return" }],
            },
            { op: "i32.const", value: 0 },
            { op: "return" },
          ],
        },
        ...stringArm(ctx, strEqualsIdx),
        ...boolArm(ctx),
        ...bigintArm(ctx),
        // Left operand is a plain eq-ref (object/function/symbol/array…):
        // identity already failed and the right side is not an `$AnyValue`
        // carrier, so §7.2.16 answers false for every remaining pairing.
        { op: "i32.const", value: 0 },
        { op: "return" },
      ],
    },
    // `$AnyValue` on either side → legacy path (cross-rep identity #2175).
  ];
}
