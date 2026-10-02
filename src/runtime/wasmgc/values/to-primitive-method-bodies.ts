// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
import {
  buildWrapperIntrinsicResult,
  buildWrapperMethodPresence,
  type ToPrimitiveWrapperIntrinsic,
  type ToPrimitivePresenceBindings,
} from "./to-primitive-wrapper-bodies.js";

/** Explicit captured data for the legacy recipe, not native provider authority. */
export interface ToPrimitiveCoreBindings {
  readonly frame: {
    readonly any: number;
    readonly method: number;
    readonly result: number;
    readonly slot: number;
    readonly args: number;
  };
  readonly wrapperPresence?: Pick<ToPrimitivePresenceBindings, "cursorLocal" | "presentLocal" | "companion">;
  readonly primitiveTypePredicates: readonly number[];
  readonly typeofStringIdx: number;
  readonly typeofFunctionIdx: number;
  readonly symbolKeysEnabled: boolean;
  readonly symbolTypeIdx: number;
  readonly anyStrTypeIdx: number;
  readonly objectTypeIdx: number;
  readonly propEntryTypeIdx: number;
  readonly strFlattenIdx: number;
  readonly strEqualsIdx: number;
  readonly externGetIdx: number;
  readonly externHasIdx: number;
  readonly callMethod0Idx: number;
  readonly objectTerminalAllowsImplicitProtoIdx: number;
  readonly objFindIdx: number;
  readonly flagInternal: number;
  readonly typeErrorCtorIdx: number;
  readonly exnTagIdx: number;
  readonly nullishToNullIdx: number | undefined;
  readonly objVecNewIdx: number;
  readonly objVecPushIdx: number;
}
export interface ToPrimitiveMethodLiterals {
  readonly lookup: readonly Instr[];
  readonly missingLookup?: readonly Instr[];
  readonly defaultObject?: readonly Instr[];
  readonly wrapperIntrinsic?: ToPrimitiveWrapperIntrinsic;
}
export interface ToPrimitiveArgumentsBindings {
  readonly brandIdx: number;
  readonly stringFirst: readonly [ToPrimitiveMethodLiterals, ToPrimitiveMethodLiterals];
  readonly stringTag: readonly Instr[];
  readonly numberFirst: readonly [ToPrimitiveMethodLiterals, ToPrimitiveMethodLiterals];
  readonly numberTag: readonly Instr[];
}
export interface ToPrimitiveSymbolBindings {
  readonly boxSymbolIdx: number;
  readonly applyClosureIdx: number;
  readonly defaultHint: readonly Instr[];
  readonly errors: readonly [readonly Instr[], readonly Instr[], readonly Instr[], readonly Instr[]];
}
/** Literal operands are copied per use; they are not semantic arm buffers. */
export function copyToPrimitiveLiteral(literal: readonly Instr[]): Instr[] {
  return structuredClone([...literal]);
}
export function buildToPrimitiveNullishNormalization(d: ToPrimitiveCoreBindings): Instr[] {
  return d.nullishToNullIdx === undefined ? [] : [{ op: "call", funcIdx: d.nullishToNullIdx }];
}

export function buildToPrimitiveResultReturn(
  d: ToPrimitiveCoreBindings,
  localIdx: number,
  includeSymbol = true,
): Instr[] {
  const { primitiveTypePredicates, symbolKeysEnabled, symbolTypeIdx } = d;
  return [
    { op: "local.get", index: localIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: localIdx }, { op: "return" }],
    },
    ...primitiveTypePredicates.flatMap((predicateIdx): Instr[] => [
      { op: "local.get", index: localIdx },
      { op: "call", funcIdx: predicateIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: localIdx }, { op: "return" }],
      },
    ]),
    ...(includeSymbol && symbolKeysEnabled
      ? ([
          { op: "local.get", index: localIdx },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: symbolTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: localIdx }, { op: "return" }],
          },
        ] satisfies Instr[])
      : []),
  ];
}

export function buildToPrimitiveTypeError(d: ToPrimitiveCoreBindings, message: readonly Instr[]): Instr[] {
  return [
    ...copyToPrimitiveLiteral(message),
    { op: "call", funcIdx: d.typeErrorCtorIdx },
    { op: "throw", tagIdx: d.exnTagIdx },
  ];
}

export function buildToPrimitiveStringHint(d: ToPrimitiveCoreBindings, literal: readonly Instr[]): Instr[] {
  const { typeofStringIdx, anyStrTypeIdx, strFlattenIdx, strEqualsIdx } = d;
  return [
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: typeofStringIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: 1 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: anyStrTypeIdx },
            { op: "call", funcIdx: strFlattenIdx },
            ...copyToPrimitiveLiteral(literal),
            { op: "call", funcIdx: strFlattenIdx },
            { op: "call", funcIdx: strEqualsIdx },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
    },
  ];
}

function implicitObjectToStringFallbackAllowed(d: ToPrimitiveCoreBindings): Instr[] {
  const { objectTypeIdx, objectTerminalAllowsImplicitProtoIdx } = d;
  const L_ANY = d.frame.any;
  return [
    { op: "local.get", index: L_ANY },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "call", funcIdx: objectTerminalAllowsImplicitProtoIdx },
  ];
}

export function buildToPrimitiveOrdinaryMethod(
  d: ToPrimitiveCoreBindings,
  literals: ToPrimitiveMethodLiterals,
): Instr[] {
  const { externGetIdx, externHasIdx, typeofFunctionIdx, callMethod0Idx } = d;
  const { method: L_METHOD, result: L_RESULT } = d.frame;
  const defaultObjectToStringOnMissing = literals.defaultObject !== undefined;
  const hasImplicitFallback = defaultObjectToStringOnMissing || literals.wrapperIntrinsic !== undefined;
  if (hasImplicitFallback && !literals.missingLookup) throw new Error("ToPrimitive: missing own-property literal");
  if (literals.wrapperIntrinsic !== undefined && d.wrapperPresence === undefined)
    throw new Error("ToPrimitive: missing complete wrapper presence data");
  return [
    ...(literals.wrapperIntrinsic === undefined
      ? []
      : buildWrapperMethodPresence(
          {
            ...d.wrapperPresence!,
            anyLocal: d.frame.any,
            objectTypeIdx: d.objectTypeIdx,
            objFindIdx: d.objFindIdx,
            implicitProtoIdx: d.objectTerminalAllowsImplicitProtoIdx,
          },
          literals.lookup,
        )),
    { op: "local.get", index: 0 },
    ...copyToPrimitiveLiteral(literals.lookup),
    { op: "call", funcIdx: externGetIdx },
    ...buildToPrimitiveNullishNormalization(d),
    { op: "local.tee", index: L_METHOD },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: hasImplicitFallback
        ? [
            { op: "local.get", index: 0 },
            ...copyToPrimitiveLiteral(literals.missingLookup!),
            { op: "call", funcIdx: externHasIdx },
            { op: "i32.eqz" },
            ...(literals.wrapperIntrinsic === undefined
              ? []
              : ([
                  { op: "local.get", index: d.wrapperPresence!.presentLocal },
                  { op: "i32.eqz" },
                  { op: "i32.and" },
                ] satisfies Instr[])),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...implicitObjectToStringFallbackAllowed(d),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    ...(literals.wrapperIntrinsic === undefined
                      ? []
                      : buildWrapperIntrinsicResult(
                          {
                            anyLocal: d.frame.any,
                            slotLocal: d.frame.slot,
                            objectTypeIdx: d.objectTypeIdx,
                            propEntryTypeIdx: d.propEntryTypeIdx,
                            objFindIdx: d.objFindIdx,
                            flagInternal: d.flagInternal,
                          },
                          literals.wrapperIntrinsic,
                        )),
                    ...(defaultObjectToStringOnMissing
                      ? ([...copyToPrimitiveLiteral(literals.defaultObject!), { op: "return" }] satisfies Instr[])
                      : []),
                  ],
                },
              ],
            },
          ]
        : [],
      else: [
        { op: "local.get", index: L_METHOD },
        { op: "call", funcIdx: typeofFunctionIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "local.get", index: L_METHOD },
            { op: "call", funcIdx: callMethod0Idx },
            { op: "local.set", index: L_RESULT },
            ...buildToPrimitiveResultReturn(d, L_RESULT),
          ],
        },
      ],
    },
  ];
}

export function buildSymbolToPrimitive(
  d: ToPrimitiveCoreBindings,
  isStringHint: Instr[],
  binding: ToPrimitiveSymbolBindings | undefined,
): Instr[] {
  if (!d.symbolKeysEnabled || !binding) return [];
  const { boxSymbolIdx, applyClosureIdx } = binding;
  const { externGetIdx, typeofFunctionIdx, objVecNewIdx, objVecPushIdx, symbolTypeIdx } = d;
  const { method: L_METHOD, args: L_ARGS, result: L_RESULT } = d.frame;
  return [
    { op: "local.get", index: 0 },
    { op: "i32.const", value: 3 }, // well-known Symbol.toPrimitive
    { op: "call", funcIdx: boxSymbolIdx },
    { op: "call", funcIdx: externGetIdx },
    ...buildToPrimitiveNullishNormalization(d),
    { op: "local.set", index: L_METHOD },
    { op: "local.get", index: L_METHOD },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: [
        { op: "local.get", index: L_METHOD },
        { op: "call", funcIdx: typeofFunctionIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "call", funcIdx: objVecNewIdx },
            { op: "local.set", index: L_ARGS },
            { op: "local.get", index: L_ARGS },
            // (#5270 step 8) §7.1.1.1 step 2.b passes the HINT STRING, and
            // an absent PreferredType is the string `"default"` (step 1),
            // never the null the internal hint slot uses to encode it.
            // Passing local 1 raw made a user `@@toPrimitive` method see
            // `null` where the spec mandates `"default"` (probe p02 logged
            // `LnullRnull`).
            { op: "local.get", index: 1 },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: copyToPrimitiveLiteral(binding.defaultHint),
              else: [{ op: "local.get", index: 1 }],
            },
            { op: "call", funcIdx: objVecPushIdx },
            { op: "local.get", index: L_METHOD },
            { op: "local.get", index: 0 },
            { op: "local.get", index: L_ARGS },
            { op: "call", funcIdx: applyClosureIdx },
            { op: "local.set", index: L_RESULT },
            ...buildToPrimitiveResultReturn(d, L_RESULT, false),
            // ToNumber(Symbol) is abrupt. Keep the Symbol result for
            // string-hint users such as ToPropertyKey; number/default
            // consumers must throw before __unbox_number can degrade
            // the carrier to NaN.
            { op: "local.get", index: L_RESULT },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: symbolTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...structuredClone(isStringHint),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "local.get", index: L_RESULT }, { op: "return" }],
                  else: [...buildToPrimitiveTypeError(d, binding.errors[0])],
                },
              ],
              else: [...buildToPrimitiveTypeError(d, binding.errors[1])],
            },
            ...buildToPrimitiveTypeError(d, binding.errors[2]),
          ],
          else: [...buildToPrimitiveTypeError(d, binding.errors[3])],
        },
      ],
    },
  ];
}
export function buildArgumentsToPrimitiveArm(
  d: ToPrimitiveCoreBindings,
  isStringHint: Instr[],
  binding: ToPrimitiveArgumentsBindings | undefined,
): Instr[] {
  if (!binding) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: binding.brandIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...structuredClone(isStringHint),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...buildToPrimitiveOrdinaryMethod(d, binding.stringFirst[0]),
            ...buildToPrimitiveOrdinaryMethod(d, binding.stringFirst[1]),
            ...copyToPrimitiveLiteral(binding.stringTag),
            { op: "return" },
          ],
          else: [
            ...buildToPrimitiveOrdinaryMethod(d, binding.numberFirst[0]),
            ...buildToPrimitiveOrdinaryMethod(d, binding.numberFirst[1]),
            ...copyToPrimitiveLiteral(binding.numberTag),
            { op: "return" },
          ],
        },
      ],
    },
  ];
}
