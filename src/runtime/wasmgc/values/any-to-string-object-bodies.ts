// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../../wasm/model/instructions.js";
import {
  literalString as litStr,
  readArgumentsBrand,
  type AnyToStringBindings,
  type AnyToStringSteps,
} from "./any-to-string-types.js";

export function createAnyToStringObjectArms(bindings: AnyToStringBindings) {
  const { anyStrTypeIdx, numToStrIdx, errToStrIdx, errStructTypeIdx, dateToStrIdx, dateStructTypeIdx } = bindings;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const L_TOPRIM = 3;
  function* numberArm(loadNumeric: Instr[]): AnyToStringSteps<Instr[]> {
    return numToStrIdx !== undefined
      ? [
          ...loadNumeric,
          { op: "call", funcIdx: numToStrIdx },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
        ]
      : yield* litStr("[object Object]");
  }

  // (ES5 standalone lane) §7.1.17 step 5 — ToString of an OBJECT is
  // `ToString(? ToPrimitive(argument, string))`, and it is `ToPrimitive` that
  // runs a user `toString`/`valueOf`. Every arm above this terminal handles a
  // value that is ALREADY primitive, so reaching here means "an object we could
  // not render" — precisely where the OrdinaryToPrimitive step belongs.
  //
  // Root cause this closes: a plain-function-constructor ("fnctor") instance —
  // `function F(){ this.toString = function(){…} }; new F()` — is a NOMINAL
  // WasmGC struct, so it is neither `$Object` nor `$Vec`. `__to_primitive`'s
  // `$Object` arm (the only ToPrimitive step `__any_to_string` had, in
  // `recoverNonStringExtern`) misses it, and the value fell straight through to
  // the "[object Object]" literal. Measured standalone before this change:
  // `"" + new F()`, `String(new F())`, and every borrowed
  // `String.prototype.<m>.call(new F(), …)` answered "[object Object]" for a
  // receiver whose own OR inherited `toString` returns "OWN".
  //
  // The driver is `__class_to_primitive(obj, stringHint)` (class-to-primitive.ts)
  // rather than `__to_primitive`, deliberately: it dispatches ONLY on the
  // per-struct `__call_valueOf`/`__call_toString` arms, so a `$Object`, a `$Vec`
  // or a bare closure struct gets `ref.null.extern` from the dispatchers and the
  // driver's string-hint tail answers the same "[object Object]" as before. The
  // blast radius is therefore exactly "nominal struct carrying a user
  // valueOf/toString", leaving the `$Object` and array renderings byte-identical.
  //
  // Only a PRIMITIVE result is accepted (`$AnyString`, boxed number / i31 small
  // int, boxed boolean); anything else falls back to "[object Object]". That is
  // what makes the terminal non-recursive: it never re-enters `__any_to_string`,
  // so a driver that answers with another object cannot loop.
  const classToPrimIdx = bindings.classToPrimIdx;
  const boxNumTerminalIdx = bindings.boxNumTerminalIdx;
  const boxBoolTerminalIdx = bindings.boxBoolTerminalIdx;
  function* objectTag(loadRef: readonly Instr[]): AnyToStringSteps<Instr[]> {
    if (classToPrimIdx === undefined) return yield* litStr("[object Object]");
    const boxArms: Instr[] =
      boxNumTerminalIdx >= 0 && boxBoolTerminalIdx >= 0
        ? [
            { op: "local.get", index: L_TOPRIM },
            { op: "ref.test", typeIdx: boxNumTerminalIdx },
            { op: "local.get", index: L_TOPRIM },
            { op: "ref.test", typeIdx: -20 }, // abstract i31 (#3673 small int)
            { op: "i32.or" },
            {
              op: "if",
              blockType: { kind: "val", type: strRef },
              then: yield* numberArm([
                { op: "local.get", index: L_TOPRIM },
                { op: "ref.test", typeIdx: -20 },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "f64" } },
                  then: [
                    { op: "local.get", index: L_TOPRIM },
                    { op: "ref.cast", typeIdx: -20 },
                    { op: "i31.get_s" },
                    { op: "f64.convert_i32_s" },
                  ],
                  else: [
                    { op: "local.get", index: L_TOPRIM },
                    { op: "ref.cast", typeIdx: boxNumTerminalIdx },
                    { op: "struct.get", typeIdx: boxNumTerminalIdx, fieldIdx: 0 },
                  ],
                },
              ]),
              else: [
                { op: "local.get", index: L_TOPRIM },
                { op: "ref.test", typeIdx: boxBoolTerminalIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: strRef },
                  then: [
                    { op: "local.get", index: L_TOPRIM },
                    { op: "ref.cast", typeIdx: boxBoolTerminalIdx },
                    { op: "struct.get", typeIdx: boxBoolTerminalIdx, fieldIdx: 0 },
                    {
                      op: "if",
                      blockType: { kind: "val", type: strRef },
                      then: yield* litStr("true"),
                      else: yield* litStr("false"),
                    },
                  ],
                  else: yield* litStr("[object Object]"),
                },
              ],
            },
          ]
        : yield* litStr("[object Object]");
    return [
      ...loadRef.map((instruction) => ({ ...instruction })),
      { op: "extern.convert_any" },
      { op: "i32.const", value: 1 }, // string hint (§7.1.17 → ToPrimitive(_, string))
      { op: "call", funcIdx: classToPrimIdx },
      { op: "any.convert_extern" },
      { op: "local.tee", index: L_TOPRIM },
      { op: "ref.test", typeIdx: anyStrTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          { op: "local.get", index: L_TOPRIM },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
        ],
        else: boxArms,
      },
    ];
  }

  // (#2962) Shared terminal for an unrecognized object ref: `$Error_struct` →
  // `__error_to_string` (a real "TypeError: boom"), anything else → the
  // OrdinaryToPrimitive terminal above, which ends at the canonical
  // "[object Object]". `loadRef` is a FACTORY (fresh instruction
  // objects per use) because the ref is loaded twice (test + call) — aliasing
  // one instr array into two tree positions double-shifts funcIdx fields when
  // post-codegen passes walk the tree (the #1448 corruption class).
  function* objectOrErrorTagInner(loadRef: readonly Instr[]): AnyToStringSteps<Instr[]> {
    return errToStrIdx !== undefined && errStructTypeIdx >= 0
      ? [
          ...loadRef.map((instruction) => ({ ...instruction })),
          { op: "ref.test", typeIdx: errStructTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [...loadRef.map((instruction) => ({ ...instruction })), { op: "call", funcIdx: errToStrIdx }],
            else: yield* objectTag(loadRef),
          },
        ]
      : yield* objectTag(loadRef);
  }

  // (#4491 T4-B) The Date arm sits OUTSIDE the error arm, same factory
  // discipline. `d.toString()` is folded statically to `__date_format_string`;
  // every DYNAMIC spelling (`String(d)`, `"" + d`, `d + d`, a template
  // substitution) arrived here and answered "[object Object]" — one value, two
  // renderings, and the spelling one reaches for when checking is the correct
  // one. `__date_any_to_string` calls that same formatter, so the two cannot
  // drift.
  function* objectOrErrorTagBase(loadRef: readonly Instr[]): AnyToStringSteps<Instr[]> {
    return dateToStrIdx !== undefined && dateStructTypeIdx >= 0
      ? [
          ...loadRef.map((instruction) => ({ ...instruction })),
          { op: "ref.test", typeIdx: dateStructTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [...loadRef.map((instruction) => ({ ...instruction })), { op: "call", funcIdx: dateToStrIdx }],
            else: yield* objectOrErrorTagInner(loadRef),
          },
        ]
      : yield* objectOrErrorTagInner(loadRef);
  }

  // Arguments objects use the same vec carrier as Arrays, but §10.6's
  // ordinary Object tag is `[object Arguments]`. Keep this brand check outside
  // the Error/Date/ordinary-object terminal so every residual ToString route
  // (dynamic concat, String(), and borrowed String methods) observes the same
  // class tag. `loadRef` is a factory because the value is consumed once by
  // the brand query and again by the fallback arm.
  const argumentsVecTypeIdx = bindings.argumentsVecTypeIdx;
  function* objectOrErrorTag(loadRef: readonly Instr[]): AnyToStringSteps<Instr[]> {
    const brandIdx = yield* readArgumentsBrand();
    if (brandIdx === undefined || argumentsVecTypeIdx < 0) return yield* objectOrErrorTagBase(loadRef);
    return [
      ...loadRef.map((instruction) => ({ ...instruction })),
      { op: "extern.convert_any" },
      { op: "call", funcIdx: brandIdx },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: yield* litStr("[object Arguments]"),
        else: yield* objectOrErrorTagBase(loadRef),
      },
    ];
  }

  return { numberArm, objectOrErrorTag };
}
