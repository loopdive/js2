// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3282) `$AnyValue` tag box/unbox primitive registration, lifted verbatim
 * out of `ensureAnyHelpers` (any-helpers.ts) to decompose that god-function
 * AND shrink the god-file. Byte-identical: `addHelper` (threaded in from
 * `ensureAnyHelpers`) appends each helper in the same order with the same body
 * (prove-emit-identity 39/39). The `undefinedSingletonActive` import back into
 * any-helpers.ts is a runtime-only ESM cycle (both are function declarations,
 * used only when these registrars run), so it resolves safely.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { undefinedSingletonActive } from "./any-helpers.js";

/**
 * (#3282 slice) The `$AnyValue` tag-boxing primitives (`__any_box_*`),
 * extracted verbatim from `ensureAnyHelpers` to decompose that god-function.
 * Byte-identical: `addHelper` appends each function in the same order with the
 * same body, so the emitted Wasm is unchanged (prove-emit-identity 39/39). The
 * boxing struct type/const captured by `ensureAnyHelpers` are threaded in as
 * params; `EQ_HEAP_TYPE` is passed as `eqHeapType` (same -19 value → identical
 * bytes).
 */
export function registerAnyBoxHelpers(
  ctx: CodegenContext,
  addHelper: (
    name: string,
    params: ValType[],
    results: ValType[],
    body: Instr[],
    locals?: { name: string; type: ValType }[],
  ) => void,
  anyRef: ValType,
  anyTypeIdx: number,
  eqHeapType: number,
): void {
  // __any_box_null() -> ref $AnyValue
  // tag=0, i32val=0, f64val=0.0, refval=null, externval=null
  addHelper(
    "__any_box_null",
    [],
    [anyRef],
    [
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "f64.const", value: 0 },
      { op: "ref.null", typeIdx: eqHeapType },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  );

  // __any_box_undefined() -> ref $AnyValue
  // tag=1
  addHelper(
    "__any_box_undefined",
    [],
    [anyRef],
    [
      { op: "i32.const", value: 1 },
      { op: "i32.const", value: 0 },
      { op: "f64.const", value: 0 },
      { op: "ref.null", typeIdx: eqHeapType },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  );

  // __any_box_i32(val: i32) -> ref $AnyValue
  // tag=2, i32val=val, f64val=0.0, refval=null, externval=null
  addHelper(
    "__any_box_i32",
    [{ kind: "i32" }],
    [anyRef],
    [
      { op: "i32.const", value: 2 },
      { op: "local.get", index: 0 },
      { op: "f64.const", value: 0 },
      { op: "ref.null", typeIdx: eqHeapType },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  );

  // __any_box_f64(val: f64) -> ref $AnyValue
  // tag=3, i32val=0, f64val=val, refval=null, externval=null
  addHelper(
    "__any_box_f64",
    [{ kind: "f64" }],
    [anyRef],
    [
      { op: "i32.const", value: 3 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 0 },
      { op: "ref.null", typeIdx: eqHeapType },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  );

  // __any_box_bool(val: i32) -> ref $AnyValue
  // tag=4, i32val=val, f64val=0.0, refval=null, externval=null
  addHelper(
    "__any_box_bool",
    [{ kind: "i32" }],
    [anyRef],
    [
      { op: "i32.const", value: 4 },
      { op: "local.get", index: 0 },
      { op: "f64.const", value: 0 },
      { op: "ref.null", typeIdx: eqHeapType },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  );

  // __any_box_string(val: externref) -> ref $AnyValue
  // tag=5, i32val=0, f64val=0.0, refval=null, externval=val
  addHelper(
    "__any_box_string",
    [{ kind: "externref" }],
    [anyRef],
    [
      { op: "i32.const", value: 5 },
      { op: "i32.const", value: 0 },
      { op: "f64.const", value: 0 },
      { op: "ref.null", typeIdx: eqHeapType },
      { op: "local.get", index: 0 },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  );

  // (#2106 S1, flag-only) __any_box_extern_s1(val: externref) -> ref $AnyValue
  //
  // NULLISH-honest externref boxing for the `undefinedSingleton` regime:
  //   null extern                    → tag-0 box (JS null)
  //   existing `$AnyValue`          → recovered exactly (all tags)
  //   `$BoxedNumber` w/ UNDEF_F64    → tag-1 box (undefined through f64 lane)
  //   everything else               → the legacy tag-5 box (#1888 lie KEPT)
  // Rationale: full honest classification is #2141's flag (measured −788/−794
  // when flipped alone — the comparator depends on the tag-5 lie for
  // non-nullish values). S1 only needs the NULLISH partition honest so
  // `__any_strict_eq`/`__any_eq`/`__any_to_string`/`__any_to_f64` (already
  // tag-correct) observe null≠undefined. Already-tagged compiler values must
  // round-trip unchanged: reboxing a union through a generic function turns
  // its string/number payload into an object. Untagged non-nullish values
  // retain the legacy classification below.
  if (undefinedSingletonActive(ctx) && ctx.undefinedGlobalIdx !== undefined) {
    const undefBoxInstrs: Instr[] = [{ op: "global.get", index: ctx.undefinedGlobalIdx }];
    addHelper(
      "__any_box_extern_s1",
      [{ kind: "externref" }],
      [anyRef],
      [
        { op: "local.get", index: 0 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 0 },
            { op: "i32.const", value: 0 },
            { op: "f64.const", value: 0 },
            { op: "ref.null", typeIdx: eqHeapType },
            { op: "ref.null.extern" },
            { op: "struct.new", typeIdx: anyTypeIdx },
            { op: "return" },
          ],
        },
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.tee", index: 1 },
        { op: "ref.test", typeIdx: anyTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // This is an existing compiler value, not a raw host object.
            { op: "local.get", index: 1 },
            { op: "ref.cast", typeIdx: anyTypeIdx },
            { op: "return" },
          ],
        },
        ...((ctx.nativeBoxNumberTypeIdx >= 0
          ? [
              // UNDEF_F64-sentinel $BoxedNumber → undefined (tag-1 singleton).
              { op: "local.get", index: 1 },
              { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 1 },
                  { op: "ref.cast", typeIdx: ctx.nativeBoxNumberTypeIdx },
                  { op: "struct.get", typeIdx: ctx.nativeBoxNumberTypeIdx, fieldIdx: 0 },
                  { op: "i64.reinterpret_f64" },
                  { op: "i64.const", value: 0x7ff00000deadc0den },
                  { op: "i64.eq" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [...undefBoxInstrs.map((i) => ({ ...i })), { op: "return" }],
                  },
                ],
              },
            ]
          : []) satisfies Instr[]),
        // legacy tag-5 wrap (byte-equivalent to __any_box_string)
        { op: "i32.const", value: 5 },
        { op: "i32.const", value: 0 },
        { op: "f64.const", value: 0 },
        { op: "ref.null", typeIdx: eqHeapType },
        { op: "local.get", index: 0 },
        { op: "struct.new", typeIdx: anyTypeIdx },
      ],
      [{ name: "any", type: { kind: "anyref" } }],
    );
  }

  // __any_box_ref(val: eqref) -> ref $AnyValue
  // tag=6, i32val=0, f64val=0.0, refval=val, externval=null
  addHelper(
    "__any_box_ref",
    [{ kind: "eqref" }],
    [anyRef],
    [
      { op: "i32.const", value: 6 },
      { op: "i32.const", value: 0 },
      { op: "f64.const", value: 0 },
      { op: "local.get", index: 0 },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: anyTypeIdx },
    ],
  );
}

/**
 * (#3282 slice B) The `$AnyValue` tag-UNBOXING primitives (`__any_unbox_*`),
 * extracted verbatim from `ensureAnyHelpers` to further decompose that
 * god-function. Byte-identical: `addHelper` appends each function in the same
 * order with the same body (prove-emit-identity 39/39). The struct type/const
 * plus the two captured locals the unbox arms read (`canNativeStrEq`, the
 * native-string flatten funcidx) are threaded in as params.
 */
export function registerAnyUnboxHelpers(
  ctx: CodegenContext,
  addHelper: (
    name: string,
    params: ValType[],
    results: ValType[],
    body: Instr[],
    locals?: { name: string; type: ValType }[],
  ) => void,
  anyRefNull: ValType,
  anyTypeIdx: number,
  canNativeStrEq: boolean,
  nativeStrFlattenIdx: number,
): void {
  // __any_unbox_i32(val: ref $AnyValue) -> i32
  // Returns i32val field; if tag==3 (f64), truncate f64val
  addHelper(
    "__any_unbox_i32",
    [anyRefNull],
    [{ kind: "i32" }],
    [
      // Check if tag == 3 (f64 number)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: 3 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
          { op: "i32.trunc_sat_f64_s" },
        ],
        else: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
        ],
      },
    ],
  );

  // __any_unbox_f64(val: ref $AnyValue) -> f64
  // Returns f64val field; if tag==2 (i32 number), convert i32val
  addHelper(
    "__any_unbox_f64",
    [anyRefNull],
    [{ kind: "f64" }],
    [
      // Check if tag == 2 (i32 number)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: 2 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
          { op: "f64.convert_i32_s" },
        ],
        else: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
        ],
      },
    ],
  );

  // __any_unbox_bool(val: ref $AnyValue) -> i32
  // Truthiness check: tag 4 → i32val, tag 2 → i32val!=0, tag 3 → f64val!=0,
  // tag 0/1 → 0 (null/undefined), tag >= 5 → 1 (truthy object).
  //
  // (#745 S3, flag-gated) Under `unionAnyRep` in the native-string lane the
  // legacy "tag >= 5 → 1" arm is WRONG for tag-5 strings: ToBoolean("") is
  // false (§7.1.2), but a `number|string` $AnyValue local holding "" answered
  // truthy. The corrected arm recovers the tag-5 externval ($AnyString via
  // extern.convert_any), and answers flatten(str).length > 0; a non-string
  // tag-5 carrier (the overloaded field-4 case, see tag5StringEqThen's guard)
  // keeps the legacy truthy answer. Tags 6/7 stay truthy, 0/1 falsy. The
  // corrected body (and its scratch local) is emitted ONLY when the flag is
  // on — flag-off modules stay byte-identical.
  const unionTag5Truthy = ctx.unionAnyRep === true && canNativeStrEq && ctx.nativeStrTypeIdx >= 0;
  const tag5TruthyElse: Instr[] = unionTag5Truthy
    ? [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 5 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: 0 },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
            { op: "any.convert_extern" },
            { op: "local.tee", index: 1 },
            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                { op: "local.get", index: 1 },
                { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
                { op: "call", funcIdx: nativeStrFlattenIdx },
                { op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 0 },
                { op: "i32.const", value: 0 },
                { op: "i32.gt_s" },
              ],
              else: [{ op: "i32.const", value: 1 }],
            },
          ],
          else: [
            { op: "local.get", index: 0 },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
            { op: "i32.const", value: 5 },
            { op: "i32.ge_s" },
          ],
        },
      ]
    : [
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 5 },
        { op: "i32.ge_s" },
      ];
  addHelper(
    "__any_unbox_bool",
    [anyRefNull],
    [{ kind: "i32" }],
    [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: 4 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
        ],
        else: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
          { op: "i32.const", value: 2 },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 },
              { op: "i32.const", value: 0 },
              { op: "i32.ne" },
            ],
            else: [
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
              { op: "i32.const", value: 3 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 },
                  { op: "f64.const", value: 0 },
                  { op: "f64.ne" },
                ],
                else: tag5TruthyElse,
              },
            ],
          },
        ],
      },
    ],
    unionTag5Truthy ? [{ name: "t5str", type: { kind: "anyref" } as ValType }] : undefined,
  );

  // __any_unbox_extern(val: ref $AnyValue) -> externref
  // Returns externval field
  addHelper(
    "__any_unbox_extern",
    [anyRefNull],
    [{ kind: "externref" }],
    [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
    ],
  );
}
