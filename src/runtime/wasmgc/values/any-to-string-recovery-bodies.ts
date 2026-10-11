// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../../wasm/model/instructions.js";
import {
  literalString as litStr,
  readObjectType,
  type AnyToStringBindings,
  type AnyToStringSteps,
} from "./any-to-string-types.js";
import { createAnyToStringObjectArms } from "./any-to-string-object-bodies.js";

export function createAnyToStringRecoveryArms(bindings: AnyToStringBindings) {
  const { anyStrTypeIdx } = bindings;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const L_RECOVER = 2;
  const { numberArm, objectOrErrorTag } = createAnyToStringObjectArms(bindings);
  // #1910/#1472 S2 — recover the string for an externref that is tagged as a
  // string (tag 5) but is NOT actually a `$AnyString`. The generic
  // externref→AnyValue boxing tags EVERY externref as tag-5 (see
  // value-tags.ts:185), so a boxed-primitive WRAPPER (`new String`/`new Number`/
  // `new Boolean` → a `$Object` carrying the internal [[PrimitiveValue]] slot)
  // reaches the tag-5 arm; the raw `ref.cast $AnyString` would trap ("illegal
  // cast"). When the value is a `$Object`, reduce it with `__to_primitive`
  // (registered by ensureObjectRuntime BEFORE this helper bakes, so its funcIdx
  // is known here — same no-intervening-shift invariant the rest of this helper
  // relies on), which reads the wrapper's internal slot and returns its boxed
  // primitive. That primitive is then a `$AnyString` (string wrapper) or a
  // `$__box_number_struct`/`$__box_boolean_struct` (number/boolean wrapper), all
  // of which the existing $AnyString test + residual box-recovery format
  // correctly — so we route the reduced value back through that recovery
  // (`stringifyExtern`). Non-`$Object` tag-5 externrefs (boxed primitive carriers
  // crossing the open-any boundary) skip straight to that recovery unchanged.
  const toPrimitiveIdx = bindings.toPrimitiveIdx;
  const objectRtTypes = bindings.objectRuntimePresent;
  const boxNumIdxEarly = bindings.boxNumIdxEarly;
  const boxBoolIdxEarly = bindings.boxBoolIdxEarly;
  // Format an externref already known NOT to be a $AnyString: recover a
  // $__box_number_struct / $__box_boolean_struct, else "[object Object]".
  function* stringifyBoxedExtern(loadExtern: Instr[]): AnyToStringSteps<Instr[]> {
    return boxNumIdxEarly >= 0 && boxBoolIdxEarly >= 0
      ? [
          ...loadExtern,
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
            else: [
              { op: "local.get", index: L_RECOVER },
              { op: "ref.test", typeIdx: boxNumIdxEarly },
              // (#3673) …or an i31-boxed small int.
              { op: "local.get", index: L_RECOVER },
              { op: "ref.test", typeIdx: -20 },
              { op: "i32.or" },
              {
                op: "if",
                blockType: { kind: "val", type: strRef },
                then: yield* numberArm([
                  { op: "local.get", index: L_RECOVER },
                  { op: "ref.test", typeIdx: -20 },
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "f64" } },
                    then: [
                      { op: "local.get", index: L_RECOVER },
                      { op: "ref.cast", typeIdx: -20 },
                      { op: "i31.get_s" },
                      { op: "f64.convert_i32_s" },
                    ],
                    else: [
                      { op: "local.get", index: L_RECOVER },
                      { op: "ref.cast", typeIdx: boxNumIdxEarly },
                      { op: "struct.get", typeIdx: boxNumIdxEarly, fieldIdx: 0 },
                    ],
                  },
                ]),
                else: [
                  { op: "local.get", index: L_RECOVER },
                  { op: "ref.test", typeIdx: boxBoolIdxEarly },
                  {
                    op: "if",
                    blockType: { kind: "val", type: strRef },
                    then: [
                      { op: "local.get", index: L_RECOVER },
                      { op: "ref.cast", typeIdx: boxBoolIdxEarly },
                      { op: "struct.get", typeIdx: boxBoolIdxEarly, fieldIdx: 0 },
                      {
                        op: "if",
                        blockType: { kind: "val", type: strRef },
                        then: yield* litStr("true"),
                        else: yield* litStr("false"),
                      },
                    ],
                    // (#2962) a `$Error_struct` reaching the tag-5 boxed-extern
                    // recovery (a caught error re-boxed as `any`) renders
                    // "Name: message" instead of "[object Object]".
                    else: yield* objectOrErrorTag([{ op: "local.get", index: L_RECOVER }]),
                  },
                ],
              },
            ],
          },
        ]
      : yield* litStr("[object Object]");
  }
  function* recoverNonStringExtern(loadExtern: Instr[]): AnyToStringSteps<Instr[]> {
    return toPrimitiveIdx !== undefined && objectRtTypes
      ? [
          // if (value is a $Object wrapper) value = __to_primitive(value, default)
          ...loadExtern,
          { op: "any.convert_extern" },
          { op: "local.tee", index: L_RECOVER },
          { op: "ref.test", typeIdx: yield* readObjectType() },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: yield* stringifyBoxedExtern([
              { op: "local.get", index: L_RECOVER },
              { op: "extern.convert_any" },
              { op: "ref.null.extern" }, // default hint
              { op: "call", funcIdx: toPrimitiveIdx },
            ]),
            else: yield* stringifyBoxedExtern([{ op: "local.get", index: L_RECOVER }, { op: "extern.convert_any" }]),
          },
        ]
      : yield* stringifyBoxedExtern(loadExtern);
  }

  return { recoverNonStringExtern };
}
