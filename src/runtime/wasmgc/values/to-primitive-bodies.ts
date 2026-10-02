// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import {
  buildToPrimitiveStringHint,
  buildToPrimitiveResultReturn,
  buildToPrimitiveOrdinaryMethod,
  buildToPrimitiveTypeError,
  buildSymbolToPrimitive,
  buildArgumentsToPrimitiveArm,
  type ToPrimitiveCoreBindings,
  type ToPrimitiveMethodLiterals,
  type ToPrimitiveArgumentsBindings,
  type ToPrimitiveSymbolBindings,
} from "./to-primitive-method-bodies.js";

/** Complete selected donor data; optional historical branches are not absence certificates. */
export interface ToPrimitiveBodyBindings {
  readonly core: ToPrimitiveCoreBindings;
  readonly hintLiteral: readonly Instr[];
  readonly inputTypes: {
    readonly number: number;
    readonly boolean: number;
    readonly string: number;
    readonly error: number;
  };
  readonly array:
    | {
        readonly vecBaseTypeIdx: number;
        readonly arrayToPrimIdx: number;
        readonly vecOwnToPrimIdx?: number;
        readonly classToPrimIdx: number;
        readonly arguments: ToPrimitiveArgumentsBindings | undefined;
      }
    | undefined;
  readonly symbol: ToPrimitiveSymbolBindings | undefined;
  readonly stringFirst: readonly [ToPrimitiveMethodLiterals, ToPrimitiveMethodLiterals];
  readonly numberFirst: readonly [ToPrimitiveMethodLiterals, ToPrimitiveMethodLiterals];
  /** Literal TypeError message operand acquired at the terminal throw site. */
  readonly terminalError: readonly Instr[];
}
/** Body construction only. C1/C2 must authenticate a complete provider graph separately. */
export function buildToPrimitiveBody(bindings: ToPrimitiveBodyBindings): Instr[] {
  const d = bindings.core;
  const { any: L_ANY, result: L_RESULT } = d.frame;
  const { objectTypeIdx, symbolKeysEnabled, symbolTypeIdx } = d;
  const arrayLikeReduce = bindings.array !== undefined;
  const vecBaseTypeIdx = bindings.array?.vecBaseTypeIdx ?? -1;
  const arrayToPrimIdx = bindings.array?.arrayToPrimIdx ?? -1;
  const classToPrimIdx = bindings.array?.classToPrimIdx ?? -1;
  const isStringHint = buildToPrimitiveStringHint(d, bindings.hintLiteral);
  return [
    // Non-objects return unchanged (ToPrimitive step 1).
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 0 }, { op: "return" }],
    },
    // (#3673 round 11) Primitive identity early-out (§7.1.1 step 1): an i31
    // small int, a `$BoxedNumber`, or a native string IS already a
    // primitive — return it before the object test. Previously a plain
    // number fell into the non-$Object arm and paid a
    // `__class_to_primitive` dispatcher walk per ToNumber site.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: L_ANY },
    { op: "ref.test", typeIdx: -20 }, // abstract i31
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 0 }, { op: "return" }],
    },
    ...(bindings.inputTypes.number >= 0
      ? ([
          { op: "local.get", index: L_ANY },
          { op: "ref.test", typeIdx: bindings.inputTypes.number },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: 0 }, { op: "return" }],
          },
        ] satisfies Instr[])
      : []),
    // (ES5 standalone lane) …and a `$BoxedBoolean`. This arm was MISSING while
    // its number and string siblings were present, so `true`/`false` was the
    // one primitive that fell through to the non-`$Object` tail and got asked
    // `__class_to_primitive`. That answered correctly ONLY while the module
    // emitted no `__call_toString` dispatcher at all (absent dispatcher ⇒
    // "return the input unchanged"); the moment ANY struct in the module
    // contributed a dispatcher arm, the boxed boolean matched none of them and
    // `__class_to_primitive`'s string-hint tail rendered its
    // "toString absent ⇒ inherited Object.prototype.toString" answer,
    // "[object Object]". Measured: `String.prototype.trim.call(true)` and
    // `new Boolean().indexOf(…)` both flipped the moment an unrelated object
    // literal in the same file gained a dispatcher arm — an action-at-a-
    // distance bug that the early-out removes at the source. §7.1.1 step 1:
    // ToPrimitive of a value that is ALREADY primitive returns it unchanged.
    ...(bindings.inputTypes.boolean >= 0
      ? ([
          { op: "local.get", index: L_ANY },
          { op: "ref.test", typeIdx: bindings.inputTypes.boolean },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: 0 }, { op: "return" }],
          },
        ] satisfies Instr[])
      : []),
    ...(bindings.inputTypes.string >= 0
      ? ([
          { op: "local.get", index: L_ANY },
          { op: "ref.test", typeIdx: bindings.inputTypes.string },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: 0 }, { op: "return" }],
          },
        ] satisfies Instr[])
      : []),
    // (ES5 standalone lane) The native ERROR struct returns UNCHANGED — the
    // same action-at-a-distance hazard as the boxed-boolean arm above, third
    // instance. An error's spec toString is Error.prototype.toString, served
    // by `__any_to_string`'s error arm AFTER ToPrimitive hands the struct
    // back unchanged. That held only while the module emitted no
    // `__call_toString` dispatcher; once ANY struct contributed an arm (a
    // harness object literal with a `toString` field suffices),
    // `__class_to_primitive`'s string-hint tail rendered the error as
    // "[object Object]". Measured on the first full ES5 run after the
    // dispatcher arm landed: every `errObj.toString()` and every thrown-
    // error rendering regressed — the 15.11.4.4-* family, try/S12.14_A19,
    // and ~14 harness asyncHelpers/compare-array rows whose failure
    // MESSAGES stringify errors.
    ...(bindings.inputTypes.error >= 0
      ? ([
          { op: "local.get", index: L_ANY },
          { op: "ref.test", typeIdx: bindings.inputTypes.error },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: 0 }, { op: "return" }],
          },
        ] satisfies Instr[])
      : []),
    // (#6432) …and the native `$Symbol` carrier — the FOURTH instance of the
    // same action-at-a-distance hazard the boxed-boolean and error-struct
    // arms above document, and the one that blocked the whole linked
    // standalone Temporal lane. §7.1.1 step 1: a Symbol is ALREADY a
    // primitive, so ToPrimitive must hand it straight back; `returnIfPrimitive`
    // below has always agreed (its `includeSymbol` arm), but the INPUT
    // cascade did not, so a Symbol fell through the `$Object` test into
    // `__class_to_primitive`. That answered correctly only while
    // `__class_to_primitive` had no generic runtime walk; the moment the
    // module gained one (`buildClassToPrimitiveRuntimeWalk`, emitted as soon
    // as its probe natives resolve — which a LINKED standalone module always
    // has), the walk's `__typeof_object(sym) || __typeof_function(sym)` guard
    // answered TRUE for the Symbol carrier (`__typeof_object` has no Symbol
    // arm) and sent a property read at it: `sym.toString()` → the inherited
    // `Object.prototype.toString` glue → its loud standalone refusal.
    //
    // Measured 2026-09-12 (#6432): that refusal fired from INSIDE
    // `__protoidx_companion` → `__nativeproto_seed_<Array>` →
    // `__defineProperty_accessor(Array, @@species, …)` → `__obj_find` →
    // `__to_property_key` → here, i.e. during MODULE INIT, before any user
    // statement — which is why every linked test262 Temporal row reported
    // "Object.prototype.toString is not yet implemented in --target
    // standalone" and scored 0 pass.
    ...(symbolKeysEnabled
      ? ([
          { op: "local.get", index: L_ANY },
          { op: "ref.test", typeIdx: symbolTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: 0 }, { op: "return" }],
          },
        ] satisfies Instr[])
      : []),
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: L_ANY },
    { op: "ref.test", typeIdx: objectTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then:
        arrayLikeReduce && vecBaseTypeIdx >= 0 && arrayToPrimIdx >= 0
          ? [
              ...buildArgumentsToPrimitiveArm(d, isStringHint, bindings.array?.arguments),
              // (#2358 #10) A real array (`$__vec_base`) reduces to its
              // Array.prototype.toString (`join(",")`) — a primitive string the
              // caller's hint then coerces (`__str_to_number` / string concat).
              { op: "local.get", index: L_ANY },
              { op: "ref.test", typeIdx: vecBaseTypeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  ...(bindings.array?.vecOwnToPrimIdx !== undefined && bindings.array.vecOwnToPrimIdx >= 0
                    ? ([
                        { op: "local.get", index: 1 },
                        { op: "call", funcIdx: bindings.array.vecOwnToPrimIdx },
                      ] satisfies Instr[])
                    : ([{ op: "call", funcIdx: arrayToPrimIdx }] satisfies Instr[])),
                  { op: "return" },
                ],
              },
              // (#2638) A nominal CLASS instance is neither `$Object` nor `$Vec`.
              // Route it through `__class_to_primitive(obj, stringHint)`, which
              // calls the per-struct `__call_valueOf`/`__call_toString`
              // dispatchers per §7.1.1.1 and returns a boxed primitive on a
              // method match, or the input unchanged otherwise. If the driver
              // produced a primitive (the class had valueOf/toString), return
              // it; else fall through to "return unchanged" (a struct/closure
              // with no user ToPrimitive — today's behaviour, no regression).
              ...(classToPrimIdx >= 0
                ? ([
                    { op: "local.get", index: 0 },
                    ...structuredClone(isStringHint),
                    { op: "call", funcIdx: classToPrimIdx },
                    { op: "local.set", index: L_RESULT },
                    ...buildToPrimitiveResultReturn(d, L_RESULT),
                  ] satisfies Instr[])
                : []),
              // Any other non-$Object value (a struct/closure without a user
              // ToPrimitive) returns unchanged as before.
              { op: "local.get", index: 0 },
              { op: "return" },
            ]
          : [{ op: "local.get", index: 0 }, { op: "return" }],
    },
    // Real method lookup and missing intrinsic handling share one ordered walk.
    ...buildSymbolToPrimitive(d, isStringHint, bindings.symbol),
    ...structuredClone(isStringHint),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...buildToPrimitiveOrdinaryMethod(d, bindings.stringFirst[0]),
        ...buildToPrimitiveOrdinaryMethod(d, bindings.stringFirst[1]),
      ],
      else: [
        ...buildToPrimitiveOrdinaryMethod(d, bindings.numberFirst[0]),
        ...buildToPrimitiveOrdinaryMethod(d, bindings.numberFirst[1]),
      ],
    },
    ...buildToPrimitiveTypeError(d, bindings.terminalError),
  ];
}
