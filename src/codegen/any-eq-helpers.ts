// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3282) The `any`-typed equality & relational-comparison helper family
 * (`__any_eq`, `__any_strict_eq`, `__any_lt`, `__any_gt`, `__any_le`,
 * `__any_ge`), lifted verbatim out of `ensureAnyHelpers` (any-helpers.ts) to
 * decompose that god-function AND shrink the god-file (~516 LOC). Byte-identical:
 * `addHelper` (threaded in from `ensureAnyHelpers`) appends each helper in the
 * same order with the same body, and the tag-5 coercion/equality closures
 * (`tag5ToNumber`/`tag5ValueEqThen`) are threaded in so their captured
 * environment is unchanged (prove-emit-identity across gc/standalone/wasi). The
 * standalone/wasi-gated reference-identity reconciliation (#2175 V2-S3) inside
 * `__any_strict_eq` moves verbatim WITH its `ctx.standalone || ctx.wasi` guard.
 *
 * The loose-eq and strict-eq(+relational) registrars are split into two private
 * functions (each < the #3400 per-function LOC ceiling) so the decomposition
 * does not merely relocate the god-code into one new large function; the exported
 * `registerAnyEqHelpers` calls them in the SAME registration order
 * (eq -> strict_eq -> lt -> gt -> le -> ge), preserving funcIdx assignment.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** The `ensureAnyHelpers` `addHelper` closure, threaded in as a callback. */
type AddHelper = (
  name: string,
  params: ValType[],
  results: ValType[],
  body: Instr[],
  locals?: { name: string; type: ValType }[],
) => void;

/**
 * (#3282 slice) Register the equality & relational-comparison operators over
 * `$AnyValue`. Order (eq -> strict_eq -> lt -> gt -> le -> ge) is preserved
 * exactly, so funcIdx assignment — and the emitted Wasm — is unchanged.
 */
export function registerAnyEqHelpers(
  ctx: CodegenContext,
  addHelper: AddHelper,
  anyRefNull: ValType,
  anyTypeIdx: number,
  toF64Idx: number,
  strToNumIdx: number,
  tag5ToNumber: (opIdx: number) => Instr[],
  tag5ValueEqThen: () => Instr[],
): void {
  registerAnyLooseEqHelper(addHelper, anyRefNull, anyTypeIdx, toF64Idx, strToNumIdx, tag5ToNumber, tag5ValueEqThen);
  registerAnyStrictEqAndComparisonHelpers(ctx, addHelper, anyRefNull, anyTypeIdx, toF64Idx, tag5ValueEqThen);
}

/** Loose equality (`==`, §7.2.15): `__any_eq`. */
function registerAnyLooseEqHelper(
  addHelper: AddHelper,
  anyRefNull: ValType,
  anyTypeIdx: number,
  toF64Idx: number,
  strToNumIdx: number,
  tag5ToNumber: (opIdx: number) => Instr[],
  tag5ValueEqThen: () => Instr[],
): void {
  // __any_eq(a, b) -> i32
  // Same tag: compare values. Different tag: return 0.
  addHelper(
    "__any_eq",
    [anyRefNull, anyRefNull],
    [{ kind: "i32" }],
    [
      // Fast path: if both refs point to the same AnyValue struct, they are equal.
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "ref.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 1 }],
        else: [
          // tagA = a.tag
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 2 },
          // tagB = b.tag
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 3 },
          // if tagA != tagB → 0
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "i32.ne" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              // Cross-tag loose equality (§7.2.15):
              // 1. null == undefined (tags 0+1): both tags < 2 → true
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 2 },
              { op: "i32.lt_s" },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 2 },
              { op: "i32.lt_s" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "i32.const", value: 1 }],
                else: [
                  // 2. Both tags are numeric-coercible (tags 2,3,4 = i32,f64,bool)?
                  //    §7.2.15 steps 4-5, 8-9: coerce to number and compare
                  //    Check: both tags are in {2,3,4} → tag >= 2 && tag <= 4
                  { op: "local.get", index: 2 },
                  { op: "i32.const", value: 2 },
                  { op: "i32.ge_s" },
                  { op: "local.get", index: 2 },
                  { op: "i32.const", value: 4 },
                  { op: "i32.le_s" },
                  { op: "i32.and" },
                  { op: "local.get", index: 3 },
                  { op: "i32.const", value: 2 },
                  { op: "i32.ge_s" },
                  { op: "local.get", index: 3 },
                  { op: "i32.const", value: 4 },
                  { op: "i32.le_s" },
                  { op: "i32.and" },
                  { op: "i32.and" },
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "i32" } },
                    then: [
                      { op: "local.get", index: 0 },
                      { op: "call", funcIdx: toF64Idx },
                      { op: "local.get", index: 1 },
                      { op: "call", funcIdx: toF64Idx },
                      { op: "f64.eq" },
                    ],
                    // (#2081) §7.2.15 steps 4-7: String(tag 5) ⇄ Number/Boolean
                    // (tags 2,3,4) ⇒ compare ToNumber(both). Today this returned
                    // a wrong `false` (`"1" == 1`). Gate on EXACTLY one side being
                    // a string and the other numeric-coercible — never pull
                    // null/undefined (tag<2) or object (tag 6) into coercion. Only
                    // available with the native StringToNumber scanner (standalone
                    // /WASI nativeStrings); else fall through to the prior `0`.
                    else:
                      strToNumIdx >= 0
                        ? [
                            // (tagA==5 && tagB in {2..4}) || (tagB==5 && tagA in {2..4})
                            { op: "local.get", index: 2 },
                            { op: "i32.const", value: 5 },
                            { op: "i32.eq" },
                            { op: "local.get", index: 3 },
                            { op: "i32.const", value: 2 },
                            { op: "i32.ge_s" },
                            { op: "local.get", index: 3 },
                            { op: "i32.const", value: 4 },
                            { op: "i32.le_s" },
                            { op: "i32.and" },
                            { op: "i32.and" },
                            { op: "local.get", index: 3 },
                            { op: "i32.const", value: 5 },
                            { op: "i32.eq" },
                            { op: "local.get", index: 2 },
                            { op: "i32.const", value: 2 },
                            { op: "i32.ge_s" },
                            { op: "local.get", index: 2 },
                            { op: "i32.const", value: 4 },
                            { op: "i32.le_s" },
                            { op: "i32.and" },
                            { op: "i32.and" },
                            { op: "i32.or" },
                            {
                              op: "if",
                              blockType: { kind: "val", type: { kind: "i32" } },
                              then: [
                                // ToNumber(a): tag5 → (boxed-number? __any_to_f64 : __str_to_number),
                                // else __any_to_f64. (#2040) The tag-5 field-4 may hold a
                                // $BoxedNumber, not a string — __str_to_number on it would
                                // mis-coerce; route those through __any_to_f64's #1888 recovery.
                                { op: "local.get", index: 2 },
                                { op: "i32.const", value: 5 },
                                { op: "i32.eq" },
                                {
                                  op: "if",
                                  blockType: { kind: "val", type: { kind: "f64" } },
                                  then: tag5ToNumber(0),
                                  else: [
                                    { op: "local.get", index: 0 },
                                    { op: "call", funcIdx: toF64Idx },
                                  ],
                                },
                                // ToNumber(b)
                                { op: "local.get", index: 3 },
                                { op: "i32.const", value: 5 },
                                { op: "i32.eq" },
                                {
                                  op: "if",
                                  blockType: { kind: "val", type: { kind: "f64" } },
                                  then: tag5ToNumber(1),
                                  else: [
                                    { op: "local.get", index: 1 },
                                    { op: "call", funcIdx: toF64Idx },
                                  ],
                                },
                                { op: "f64.eq" },
                              ],
                              else: [{ op: "i32.const", value: 0 }],
                            },
                          ]
                        : [{ op: "i32.const", value: 0 }],
                  },
                ],
              },
            ],
            else: [
              // Same tag — compare by tag type
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 2 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  // i32 eq
                  { op: "local.get", index: 0 },
                  { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                  { op: "local.get", index: 1 },
                  { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                  { op: "i32.eq" },
                ],
                else: [
                  { op: "local.get", index: 2 },
                  { op: "i32.const", value: 3 },
                  { op: "i32.eq" },
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "i32" } },
                    then: [
                      // f64 eq
                      { op: "local.get", index: 0 },
                      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                      { op: "local.get", index: 1 },
                      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                      { op: "f64.eq" },
                    ],
                    else: [
                      { op: "local.get", index: 2 },
                      { op: "i32.const", value: 4 },
                      { op: "i32.eq" },
                      {
                        op: "if",
                        blockType: { kind: "val", type: { kind: "i32" } },
                        then: [
                          // bool eq (compare i32val)
                          { op: "local.get", index: 0 },
                          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                          { op: "local.get", index: 1 },
                          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                          { op: "i32.eq" },
                        ],
                        else: [
                          // tag 6 (ref): compare refval (eqref) with ref.eq
                          { op: "local.get", index: 2 },
                          { op: "i32.const", value: 6 },
                          { op: "i32.eq" },
                          {
                            op: "if",
                            blockType: { kind: "val", type: { kind: "i32" } },
                            then: [
                              { op: "local.get", index: 0 },
                              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 3 },
                              { op: "local.get", index: 1 },
                              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 3 },
                              { op: "ref.eq" },
                            ],
                            else: [
                              // tag 5 (string): compare content via wasm:js-string equals
                              { op: "local.get", index: 2 },
                              { op: "i32.const", value: 5 },
                              { op: "i32.eq" },
                              {
                                op: "if",
                                blockType: { kind: "val", type: { kind: "i32" } },
                                // (#2040/#1888) tag-5 string-CONTENT equality, GUARDED on
                                // `ref.test $AnyString` (see tag5StringEqThen). The #2040
                                // numeric (`f64.eq`) + #2585 object-identity (`ref.eq`)
                                // CLASSIFIER arms are DROPPED: changing tag-5 boxed-value
                                // equality for non-strings flips a comparison the
                                // destructuring / generator-iterator lowering implicitly
                                // relied on, regressing the class/dstr cluster by −162
                                // (ejected #1888 from the standalone floor). Those arms move
                                // to the value-rep substrate (#2580 M2 / #35). The guarded
                                // string path keeps #2579 boxed-string-eq + #2583 search.
                                then: tag5ValueEqThen(),
                                else: [
                                  // null/undefined (tag < 2): both same tag → equal
                                  { op: "local.get", index: 2 },
                                  { op: "i32.const", value: 2 },
                                  { op: "i32.lt_s" },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    [
      { name: "tagA", type: { kind: "i32" } },
      { name: "tagB", type: { kind: "i32" } },
      // (#2040/#2585) tag-5 field-4 classifier scratch (anyA/anyB at locals 4/5).
      { name: "anyA", type: { kind: "anyref" } },
      { name: "anyB", type: { kind: "anyref" } },
    ],
  );
}

/** Strict equality (`===`) + relational comparisons (`<`,`>`,`<=`,`>=`). */
function registerAnyStrictEqAndComparisonHelpers(
  ctx: CodegenContext,
  addHelper: AddHelper,
  anyRefNull: ValType,
  anyTypeIdx: number,
  toF64Idx: number,
  tag5ValueEqThen: () => Instr[],
): void {
  // __any_strict_eq(a, b) -> i32
  // Strict equality (===): different tags always return 0 (no cross-type coercion). (#296)
  addHelper(
    "__any_strict_eq",
    [anyRefNull, anyRefNull],
    [{ kind: "i32" }],
    [
      // Fast path: if both refs point to the same AnyValue struct, they are equal.
      // This handles object identity (var b = a) for all tag types.
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "ref.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 1 }],
        else: [
          // tagA = a.tag
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 2 },
          // tagB = b.tag
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 3 },
          // Numeric class first: tags 2 (i32) and 3 (f64) are ONE JS type
          // ("number") split only by internal representation. `23 === 23.0`
          // must be true even when one side is a tag-2 box and the other a
          // tag-3 box (e.g. a value recovered via __any_from_extern from a
          // __box_number carrier vs a directly boxed i32 literal). Compare
          // numerically as f64 whenever BOTH tags are in {2, 3}.
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 2 },
          { op: "i32.ge_s" },
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 3 },
          { op: "i32.le_s" },
          { op: "i32.and" },
          { op: "local.get", index: 3 },
          { op: "i32.const", value: 2 },
          { op: "i32.ge_s" },
          { op: "local.get", index: 3 },
          { op: "i32.const", value: 3 },
          { op: "i32.le_s" },
          { op: "i32.and" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: toF64Idx },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: toF64Idx },
              { op: "f64.eq" },
              { op: "return" },
            ],
          },
          // if tagA != tagB → 0 (strict: no cross-type coercion), EXCEPT the
          // (#2175 V2-S3 — raw-anyref carrier) cross-representation identity case.
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "i32.ne" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            // (#2175 V2-S3) Reference-IDENTITY reconciliation, cross-representation
            // ONLY. A GC object can reach `===` under TWO $AnyValue reps that point
            // at the SAME reference: tag-6 `refval` (raw GC ref via `__any_box_ref`)
            // vs tag-5 `externval` (the SAME ref externref-wrapped, e.g. a
            // descriptor `.value` / array-element read boxed via `__any_box_string`).
            // Those differ in TAG, so they land in THIS `tagA != tagB` arm — where
            // the legacy answer was a flat `0`. Recover each operand's reference
            // payload (refval if non-null, else `any.convert_extern(externval)`) to
            // a common `eqref`; if both are `eq` refs and `ref.eq`-identical they are
            // the identical object → 1, else 0. This lives ONLY in the different-tag
            // branch: same-tag pairs keep their existing tag-specific arms untouched
            // (an earlier revision ran this before the tag gate — for ALL tag pairs —
            // and regressed same-tag identity, measured −7228 host-free; #2175).
            // Cannot false-positive a primitive: distinct number/string/object boxes
            // are distinct refs. GATED on standalone/wasi (native-GC-only; host mode
            // uses host externrefs and answers identity correctly, byte-identical).
            then:
              ctx.standalone === true || ctx.wasi === true
                ? (() => {
                    const EQ_HEAP_TYPE = -19; // WasmGC `eq` abstract heap type
                    const recoverRefPayload = (opIdx: number, dstLocal: number): Instr[] => [
                      { op: "local.get", index: opIdx },
                      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 3 }, // refval (eqref)
                      { op: "local.tee", index: dstLocal },
                      { op: "ref.is_null" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: opIdx },
                          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 }, // externval (externref)
                          { op: "any.convert_extern" },
                          { op: "local.set", index: dstLocal },
                        ],
                      },
                    ];
                    return [
                      ...recoverRefPayload(0, 4),
                      ...recoverRefPayload(1, 5),
                      { op: "local.get", index: 4 },
                      { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
                      { op: "local.get", index: 5 },
                      { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
                      { op: "i32.and" },
                      {
                        op: "if",
                        blockType: { kind: "val", type: { kind: "i32" } },
                        then: [
                          { op: "local.get", index: 4 },
                          { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                          { op: "local.get", index: 5 },
                          { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                          { op: "ref.eq" },
                        ],
                        else: [{ op: "i32.const", value: 0 }],
                      },
                    ];
                  })()
                : [{ op: "i32.const", value: 0 }],
            else: [
              // Same tag — compare by tag type
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 2 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  // i32 eq (unreachable in practice — the numeric-class arm
                  // above already handled tag2/tag2 — kept as a safe fallback)
                  { op: "local.get", index: 0 },
                  { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                  { op: "local.get", index: 1 },
                  { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                  { op: "i32.eq" },
                ],
                else: [
                  { op: "local.get", index: 2 },
                  { op: "i32.const", value: 3 },
                  { op: "i32.eq" },
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "i32" } },
                    then: [
                      // f64 eq
                      { op: "local.get", index: 0 },
                      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                      { op: "local.get", index: 1 },
                      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                      { op: "f64.eq" },
                    ],
                    else: [
                      { op: "local.get", index: 2 },
                      { op: "i32.const", value: 4 },
                      { op: "i32.eq" },
                      {
                        op: "if",
                        blockType: { kind: "val", type: { kind: "i32" } },
                        then: [
                          // bool eq (compare i32val)
                          { op: "local.get", index: 0 },
                          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                          { op: "local.get", index: 1 },
                          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
                          { op: "i32.eq" },
                        ],
                        else: [
                          // tag 6 (ref): compare refval (eqref) with ref.eq
                          { op: "local.get", index: 2 },
                          { op: "i32.const", value: 6 },
                          { op: "i32.eq" },
                          {
                            op: "if",
                            blockType: { kind: "val", type: { kind: "i32" } },
                            then: [
                              { op: "local.get", index: 0 },
                              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 3 },
                              { op: "local.get", index: 1 },
                              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 3 },
                              { op: "ref.eq" },
                            ],
                            else: [
                              // tag 5 (string): compare content via wasm:js-string equals
                              { op: "local.get", index: 2 },
                              { op: "i32.const", value: 5 },
                              { op: "i32.eq" },
                              {
                                op: "if",
                                blockType: { kind: "val", type: { kind: "i32" } },
                                // (#2040/#1888) tag-5 string-CONTENT equality, GUARDED on
                                // `ref.test $AnyString` (see tag5StringEqThen). The #2040
                                // numeric (`f64.eq`) + #2585 object-identity (`ref.eq`)
                                // CLASSIFIER arms are DROPPED: changing tag-5 boxed-value
                                // equality for non-strings flips a comparison the
                                // destructuring / generator-iterator lowering implicitly
                                // relied on, regressing the class/dstr cluster by −162
                                // (ejected #1888 from the standalone floor). Those arms move
                                // to the value-rep substrate (#2580 M2 / #35). The guarded
                                // string path keeps #2579 boxed-string-eq + #2583 search.
                                then: tag5ValueEqThen(),
                                else: [
                                  // null/undefined (tag < 2): both same tag → equal
                                  { op: "local.get", index: 2 },
                                  { op: "i32.const", value: 2 },
                                  { op: "i32.lt_s" },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    [
      { name: "tagA", type: { kind: "i32" } },
      { name: "tagB", type: { kind: "i32" } },
      // (#2040/#2585) tag-5 field-4 classifier scratch (anyA/anyB at locals 4/5).
      { name: "anyA", type: { kind: "anyref" } },
      { name: "anyB", type: { kind: "anyref" } },
    ],
  );

  // Comparison helpers: __any_lt, __any_gt, __any_le, __any_ge
  // All use numeric comparison (convert to f64, compare)
  function addComparisonHelper(name: string, f64op: "f64.lt" | "f64.gt" | "f64.le" | "f64.ge"): void {
    addHelper(
      name,
      [anyRefNull, anyRefNull],
      [{ kind: "i32" }],
      [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: toF64Idx },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: toF64Idx },
        { op: f64op },
      ],
    );
  }

  addComparisonHelper("__any_lt", "f64.lt");
  addComparisonHelper("__any_gt", "f64.gt");
  addComparisonHelper("__any_le", "f64.le");
  addComparisonHelper("__any_ge", "f64.ge");
}
