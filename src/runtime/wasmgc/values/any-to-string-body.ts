// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../../wasm/model/instructions.js";
import {
  literalString as litStr,
  readResidualBoxTypes,
  type AnyToStringBindings,
  type AnyToStringSteps,
} from "./any-to-string-types.js";
import { createAnyToStringObjectArms } from "./any-to-string-object-bodies.js";
import { createAnyToStringRecoveryArms } from "./any-to-string-recovery-bodies.js";

/** Construction recipe only; bindings are not issued provider authority. */
export function* buildAnyToStringBody(bindings: AnyToStringBindings): AnyToStringSteps<Instr[]> {
  const { anyStrTypeIdx, anyValueTypeIdx } = bindings;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const L_V = 0,
    L_BOX = 1,
    L_RECOVER = 2;
  const { numberArm, objectOrErrorTag } = createAnyToStringObjectArms(bindings);
  const { recoverNonStringExtern } = createAnyToStringRecoveryArms(bindings);
  const tagEq = (tag: number): Instr[] => [
    { op: "local.get", index: L_BOX },
    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: tag },
    { op: "i32.eq" },
  ];

  // tag dispatch as a nested if/else chain producing `ref $AnyString`.
  const boxDispatch: Instr[] = [
    ...tagEq(0),
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: yield* litStr("null"),
      else: [
        ...tagEq(1),
        {
          op: "if",
          blockType: { kind: "val", type: strRef },
          then: yield* litStr("undefined"),
          else: [
            ...tagEq(2),
            {
              op: "if",
              blockType: { kind: "val", type: strRef },
              then: yield* numberArm([
                { op: "local.get", index: L_BOX },
                { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 1 },
                { op: "f64.convert_i32_s" },
              ]),
              else: [
                ...tagEq(3),
                {
                  op: "if",
                  blockType: { kind: "val", type: strRef },
                  then: yield* numberArm([
                    { op: "local.get", index: L_BOX },
                    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 2 },
                  ]),
                  else: [
                    ...tagEq(4),
                    {
                      op: "if",
                      blockType: { kind: "val", type: strRef },
                      then: [
                        { op: "local.get", index: L_BOX },
                        {
                          op: "struct.get",
                          typeIdx: anyValueTypeIdx,
                          fieldIdx: 1,
                        },
                        {
                          op: "if",
                          blockType: { kind: "val", type: strRef },
                          then: yield* litStr("true"),
                          else: yield* litStr("false"),
                        },
                      ],
                      else: [
                        ...tagEq(5),
                        {
                          op: "if",
                          blockType: { kind: "val", type: strRef },
                          // tag 5 (string): the externval is USUALLY a real
                          // `$AnyString`, but the generic externref boxing also
                          // tags boxed-primitive WRAPPER objects (new String /
                          // Number / Boolean → $Object) and other open externrefs
                          // as tag-5 (#1910/#1472 S2). Test $AnyString first; only
                          // cast when it really is a string, otherwise recover via
                          // __extern_toString (reads the wrapper's internal slot
                          // through ToPrimitive). Without this guard the raw cast
                          // traps with "illegal cast" for `new String("1") + x`.
                          then: [
                            { op: "local.get", index: L_BOX },
                            {
                              op: "struct.get",
                              typeIdx: anyValueTypeIdx,
                              fieldIdx: 4,
                            },
                            { op: "any.convert_extern" },
                            { op: "local.tee", index: L_RECOVER },
                            { op: "ref.test", typeIdx: anyStrTypeIdx },
                            {
                              op: "if",
                              blockType: { kind: "val", type: strRef },
                              then: [
                                { op: "local.get", index: L_RECOVER },
                                { op: "ref.cast", typeIdx: anyStrTypeIdx },
                              ],
                              else: yield* recoverNonStringExtern([
                                { op: "local.get", index: L_RECOVER },
                                { op: "extern.convert_any" },
                              ]),
                            },
                          ],
                          // tag 6 / unknown → $Error_struct renders
                          // "Name: message" (#2962), else "[object Object]"
                          else: yield* objectOrErrorTag([
                            { op: "local.get", index: L_BOX },
                            { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 3 },
                          ]),
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
  ];

  // (#2072) Standalone primitive-box recovery — subsumes the #1988 number-only
  // arm (which lived at this exact residual location and recovered ONLY
  // `$__box_number_struct` → number_toString, e.g. the `1` in `1 + {}` after
  // ToPrimitive). An `any`-held primitive is NOT stored as a $AnyValue box on
  // the WasmGC/standalone path — `coerceType` boxes f64 via `__box_number`
  // ($__box_number_struct), bool via `__box_boolean` ($__box_boolean_struct),
  // then `extern.convert_any` makes it externref (the #1888 externref ABI the
  // test262 comparator relies on, which is why we recover the shape here rather
  // than changing the box). So when the value is neither $AnyString nor
  // $AnyValue, before yielding "[object Object]" we ref.test the boxed-primitive
  // structs and format them, matching what the $AnyValue tag-2/tag-4 arms above
  // already do. Without this, String(v) for `const v: any = 42 / true` returned
  // "[object Object]". The number sub-arm uses `numberArm(...)`, which appends
  // exactly `call number_toString; any.convert_extern; ref.cast $AnyString` —
  // byte-identical to #1988's explicit emit (and falls back to "[object Object]"
  // when `number_toString` is absent), so #1988's `1 + {}` case still holds.
  // Type indices (not func indices) are read here, so no late-import shift
  // hazard; the only func index baked in is `numToStrIdx`, which this helper
  // already bakes for tag 2/3.
  const { boxNumIdx, boxBoolIdx } = yield* readResidualBoxTypes();
  const residualArm: Instr[] =
    boxNumIdx >= 0 && boxBoolIdx >= 0
      ? [
          // $__box_number_struct (or #3673 i31 small int)? → number_toString(value)
          { op: "local.get", index: L_V },
          { op: "ref.test", typeIdx: boxNumIdx },
          { op: "local.get", index: L_V },
          { op: "ref.test", typeIdx: -20 },
          { op: "i32.or" },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: yield* numberArm([
              { op: "local.get", index: L_V },
              { op: "ref.test", typeIdx: -20 },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "f64" } },
                then: [
                  { op: "local.get", index: L_V },
                  { op: "ref.cast", typeIdx: -20 },
                  { op: "i31.get_s" },
                  { op: "f64.convert_i32_s" },
                ],
                else: [
                  { op: "local.get", index: L_V },
                  { op: "ref.cast", typeIdx: boxNumIdx },
                  { op: "struct.get", typeIdx: boxNumIdx, fieldIdx: 0 },
                ],
              },
            ]),
            else: [
              // $__box_boolean_struct? → "true" / "false"
              { op: "local.get", index: L_V },
              { op: "ref.test", typeIdx: boxBoolIdx },
              {
                op: "if",
                blockType: { kind: "val", type: strRef },
                then: [
                  { op: "local.get", index: L_V },
                  { op: "ref.cast", typeIdx: boxBoolIdx },
                  { op: "struct.get", typeIdx: boxBoolIdx, fieldIdx: 0 },
                  {
                    op: "if",
                    blockType: { kind: "val", type: strRef },
                    then: yield* litStr("true"),
                    else: yield* litStr("false"),
                  },
                ],
                // unknown ref → $Error_struct renders "Name: message"
                // (#2962), else "[object Object]"
                else: yield* objectOrErrorTag([{ op: "local.get", index: L_V }]),
              },
            ],
          },
        ]
      : // No box types registered — still recognize a raw `$Error_struct`
        // (#2962) before the "[object Object]" terminal.
        yield* objectOrErrorTag([{ op: "local.get", index: L_V }]);

  const stringArmAndBelow: Instr[] = [
    // if (v is a $AnyString) return it directly
    { op: "local.get", index: L_V },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: [
        { op: "local.get", index: L_V },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
      ],
      else: [
        // else if (v is a $AnyValue) dispatch on its tag
        { op: "local.get", index: L_V },
        { op: "ref.test", typeIdx: anyValueTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: strRef },
          then: [
            { op: "local.get", index: L_V },
            { op: "ref.cast", typeIdx: anyValueTypeIdx },
            { op: "local.set", index: L_BOX },
            ...boxDispatch,
          ],
          // else (boxed primitive externref shape, plain object, vec, …) →
          // recover number/boolean boxes, then "[object Object]"
          else: residualArm,
        },
      ],
    },
  ];

  // (#4621 D) §7.1.17 ToString(null) is "null". A RAW null ref never reached
  // the tag-0 arm above — that arm only fires for an `$AnyValue` BOX carrying
  // tag 0 — so it fell through `residualArm` to the "[object Object]" terminal.
  // The residual-arm comment even listed "null ref" among the shapes it
  // handled; it did not handle it, it rendered it as an object.
  //
  // Measured on `language/expressions/addition/S11.6.1_A3.2_T2.4`:
  // `new String("1") + null` produced `"1[object Object]"`. Any addition with an
  // OBJECT operand routes through `addition-to-primitive.ts`, which boxes both
  // sides to anyref and lands here; the all-primitive spellings (`"" + null`)
  // fold statically and were always right, which is what hid this.
  //
  // Scope note: in this representation the null externref IS the JavaScript
  // `null` (`x === null` lowers to a bare `ref.is_null`, binary-ops.ts) while
  // `undefined` is the tag-1 box / #4489 singleton, so this arm cannot swallow
  // an `undefined`. The one other producer of a raw null here is the #1105
  // nullable-`$AnyString` "undefined sentinel", which now renders "null"
  // instead of "[object Object]" — both are wrong for that sentinel, and the
  // spec-correct answer for the value this arm actually exists to serve is
  // "null".
  const body: Instr[] = [
    { op: "local.get", index: L_V },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: yield* litStr("null"),
      else: stringArmAndBelow,
    },
  ];

  return body;
}
