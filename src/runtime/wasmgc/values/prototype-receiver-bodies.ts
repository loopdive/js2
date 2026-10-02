// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";
import { BUILTIN_BRAND_BASE, BUILTIN_BRAND_COUNT, builtinBrandOffsetOf } from "../../contracts/builtin-brands.js";

export interface PrototypeBrandOffsetResources {
  readonly nativeProtoTypeIdx?: number;
  readonly wrapper?: {
    readonly types: { readonly objectTypeIdx: number; readonly propEntryTypeIdx: number };
    readonly findOwn: number;
    readonly anyString: number;
    readonly boxNumber: number;
    readonly boxBoolean: number;
  };
}
export interface PrototypeRemainingCarriers {
  readonly symbolTypeIdx: number;
  readonly vecPropBaseTypeIdx?: number;
  readonly mapTypeIdx: number;
  readonly regExpTypeIdx?: number;
  readonly dateTypeIdx?: number;
  readonly promiseTypeIdx?: number;
  readonly boxBooleanTypeIdx: number;
  readonly boxNumberTypeIdx: number;
  readonly anyStringTypeIdx: number;
  readonly errorTypeIdx: number;
  /**
   * Instances built by `new F()` for a plain function `F` (the `__fnctor_*`
   * layouts). They share the closure-carrier predicate below only so they can
   * hold expandos; their prototype chain is F.prototype → Object.prototype, so
   * they classify as Object, never as Function.
   */
  readonly fnctorInstanceTypeIdxs?: readonly number[];
  readonly isClosureCarrier?: number;
}
export type PrototypeBrandRequest = { readonly kind: "wrapper-key" | "remaining-carriers" };
export type PrototypeBrandResponse =
  | {
      readonly kind: "wrapper-key";
      readonly materialization:
        | { readonly kind: "global"; readonly globalIdx: number }
        | { readonly kind: "callable"; readonly funcIdx: number };
    }
  | { readonly kind: "remaining-carriers"; readonly resources: PrototypeRemainingCarriers };
export type PrototypeBrandRecipe = Generator<
  PrototypeBrandRequest,
  { locals: LocalDef[]; body: Instr[] },
  PrototypeBrandResponse
>;
const ENTRY_VALUE = 1;
const I31_HEAP_TYPE = -20;
const OBJ_OFF = builtinBrandOffsetOf("Object")!;
const ARR_OFF = builtinBrandOffsetOf("Array")!;
const FUN_OFF = builtinBrandOffsetOf("Function")!;
const REGEXP_OFF = builtinBrandOffsetOf("RegExp")!;
const DATE_OFF = builtinBrandOffsetOf("Date")!;
const ERROR_OFF = builtinBrandOffsetOf("Error")!;
const PROMISE_OFF = builtinBrandOffsetOf("Promise")!;
const STRING_OFF = builtinBrandOffsetOf("String")!;
const NUMBER_OFF = builtinBrandOffsetOf("Number")!;
const BOOLEAN_OFF = builtinBrandOffsetOf("Boolean")!;
const SYMBOL_OFF = builtinBrandOffsetOf("Symbol")!;
const SET_OFF = builtinBrandOffsetOf("Set")!;
const MAP_OFF = builtinBrandOffsetOf("Map")!;
const WEAKMAP_OFF = builtinBrandOffsetOf("WeakMap")!;
const WEAKSET_OFF = builtinBrandOffsetOf("WeakSet")!;

/** `$Map.kind` field / `COLLECTION_KIND` values (map-runtime.ts). Kept as
 * literals here to avoid an import cycle: map-runtime already consumes the
 * receiver-brand helper. */
const MAP_KIND_FIELD = 4;
const MAP_KIND = 0;
const SET_KIND = 1;
const WEAKMAP_KIND = 2;
const WEAKSET_KIND = 3;

/** (#5151) `$Map.kind` → the brand offset whose companion holds that
 *  collection's prototype overrides. All four share the `$Map` carrier. */
const COLLECTION_KIND_OFFSETS: readonly (readonly [number, number])[] = [
  [MAP_KIND, MAP_OFF],
  [SET_KIND, SET_OFF],
  [WEAKMAP_KIND, WEAKMAP_OFF],
  [WEAKSET_KIND, WEAKSET_OFF],
];

/** Complete classifier. The second binding phase follows any wrapper-key materialization. */
export function* buildPrototypeBrandOffsetDefinition(d: PrototypeBrandOffsetResources): PrototypeBrandRecipe {
  let remaining: PrototypeRemainingCarriers | undefined;
  // params: 0=v ; locals: 1=any(anyref) 2=off(i32)
  const locals: LocalDef[] = [
    { name: "any", type: { kind: "anyref" } },
    { name: "off", type: { kind: "i32" } },
  ];
  const ret = (off: number): Instr[] => [{ op: "i32.const", value: off }, { op: "return" }];
  const testArm = (typeIdx: number | undefined, off: number): Instr[] =>
    typeIdx === undefined
      ? []
      : [
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx },
          { op: "if", blockType: { kind: "empty" }, then: ret(off) },
        ];

  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];

  // $NativeProto receiver → its OWN brand offset (direct proto reads see
  // their own companion first; out-of-band brands — user-class protos — fall
  // back to Object).
  const npTypeIdx = d.nativeProtoTypeIdx;
  if (npTypeIdx !== undefined) {
    body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: npTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: npTypeIdx },
          { op: "struct.get", typeIdx: npTypeIdx, fieldIdx: 0 }, // $brand
          { op: "i32.const", value: BUILTIN_BRAND_BASE },
          { op: "i32.sub" },
          { op: "local.tee", index: 2 },
          { op: "i32.const", value: BUILTIN_BRAND_COUNT },
          { op: "i32.lt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: 2 }, { op: "return" }],
          },
          ...ret(OBJ_OFF),
        ],
      },
    );
  }
  // Boxed-primitive WRAPPER (`new String()` / `new Number()` / `new
  // Boolean()`) — a plain `$Object` carrying the [[PrimitiveValue]] internal
  // slot (see WRAPPER_PRIMITIVE_KEY above). Classify by the slot value's box
  // type so the wrapper's chain starts at its OWN prototype brand
  // (`String.prototype.enumerable = true; Object.defineProperty(o, "p",
  // new String())` — the 15.2.3.6-3-{35,141,220,250}-1 family). An ordinary
  // `$Object` (no slot) falls through to the OBJ default. The key is built
  // with `nativeStringLiteralInstrs` — finalize-safe (no import-global adds).
  {
    const types = d.wrapper?.types;
    const objFindIdx = d.wrapper?.findOwn;
    const anyStr = d.wrapper?.anyString ?? -1;
    if (types && objFindIdx !== undefined && anyStr >= 0) {
      const entryRefNull: ValType = { kind: "ref_null", typeIdx: types.propEntryTypeIdx };
      const eLocal = locals.length + 1; // params: 1 → locals start at 1
      locals.push({ name: "we", type: entryRefNull });
      const slotValue = (): Instr[] => [
        { op: "local.get", index: eLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: types.propEntryTypeIdx, fieldIdx: ENTRY_VALUE },
      ];
      const boxNum = d.wrapper!.boxNumber;
      const boxBool = d.wrapper!.boxBoolean;
      const literal = yield { kind: "wrapper-key" };
      if (literal.kind !== "wrapper-key") throw new Error("prototype classifier expected wrapper literal");
      const materialization = literal.materialization;
      const wrapperKey: Instr[] =
        materialization.kind === "global"
          ? [{ op: "global.get", index: materialization.globalIdx }]
          : [{ op: "call", funcIdx: materialization.funcIdx }];
      const response = yield { kind: "remaining-carriers" };
      if (response.kind !== "remaining-carriers") throw new Error("prototype classifier expected remaining carriers");
      remaining = response.resources;
      body.push(
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: types.objectTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "ref.cast", typeIdx: types.objectTypeIdx },
            ...wrapperKey,
            { op: "extern.convert_any" },
            { op: "call", funcIdx: objFindIdx },
            { op: "local.set", index: eLocal },
            { op: "local.get", index: eLocal },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...slotValue(),
                { op: "ref.test", typeIdx: anyStr },
                { op: "if", blockType: { kind: "empty" }, then: ret(STRING_OFF) },
                ...(boxNum >= 0
                  ? ([
                      ...slotValue(),
                      { op: "ref.test", typeIdx: boxNum },
                      ...slotValue(),
                      { op: "ref.test", typeIdx: I31_HEAP_TYPE },
                      { op: "i32.or" },
                      { op: "if", blockType: { kind: "empty" }, then: ret(NUMBER_OFF) },
                    ] satisfies Instr[])
                  : []),
                ...(boxBool >= 0
                  ? ([
                      ...slotValue(),
                      { op: "ref.test", typeIdx: boxBool },
                      { op: "if", blockType: { kind: "empty" }, then: ret(BOOLEAN_OFF) },
                    ] satisfies Instr[])
                  : []),
                // (#6651 H5) …and the SYMBOL wrapper (`Object(sym)`, built by #6651
                // I4). A `[[PrimitiveValue]]` slot holding the `$Symbol` carrier
                // (#2866) makes the wrapper a Symbol object, so §10.4.3's rule —
                // the receiver's implicit chain starts at its OWN wrapper
                // prototype — names Symbol.prototype. That is what lets
                // `Object(Symbol.toPrimitive)[Symbol.toPrimitive]` reach the
                // seeded `@@3` companion entry: this consult is key-AGNOSTIC
                // (`__protoidx_get_k` hands the key straight to `__obj_find`), so
                // a boxed-symbol key resolves here where the string-key
                // inherited-method arm cannot look at all.
                //
                // Gated on the carrier ALREADY being registered. The fill never
                // calls `ensureSymbolCarrier`, so a module with no symbols emits
                // the exact previous body — the demand gate, not a flag.
                ...(remaining.symbolTypeIdx >= 0
                  ? ([
                      ...slotValue(),
                      { op: "ref.test", typeIdx: remaining.symbolTypeIdx },
                      { op: "if", blockType: { kind: "empty" }, then: ret(SYMBOL_OFF) },
                    ] satisfies Instr[])
                  : []),
              ],
            },
            ...ret(OBJ_OFF),
          ],
        },
      );
    }
  }
  if (!remaining) {
    const response = yield { kind: "remaining-carriers" };
    if (response.kind !== "remaining-carriers") throw new Error("prototype classifier expected remaining carriers");
    remaining = response.resources;
  }
  body.push(...testArm(remaining.vecPropBaseTypeIdx, ARR_OFF));
  // The native keyed collections are the one non-`$Object` carrier family whose
  // implicit prototype participates in the companion store. The collection
  // runtime shares `$Map` for Map/Set/WeakMap/WeakSet, so discriminate by the
  // immutable kind tag before the generic Object fallback. This lets a
  // standalone constructor honor a user-installed `X.prototype.<adder>` without
  // changing the native fast path when the companion has no override.
  //
  // (#5151) Only SET was classified until now, so `Map.prototype.set = null`
  // (and the WeakMap/WeakSet twins) were invisible to every receiver-aware
  // consult: the Map receiver answered `Object`, whose companion has no `set`.
  // All four kinds map to their own brand offset here.
  if (remaining.mapTypeIdx >= 0) {
    body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: remaining.mapTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: COLLECTION_KIND_OFFSETS.flatMap(([kind, off]): Instr[] => [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: remaining.mapTypeIdx },
          { op: "struct.get", typeIdx: remaining.mapTypeIdx, fieldIdx: MAP_KIND_FIELD },
          { op: "i32.const", value: kind },
          { op: "i32.eq" },
          { op: "if", blockType: { kind: "empty" }, then: ret(off) },
        ]),
      },
    );
  }
  body.push(...testArm(remaining.regExpTypeIdx, REGEXP_OFF));
  body.push(...testArm(remaining.dateTypeIdx, DATE_OFF));
  // `$Promise` participates in the generic carrier-bag predicate so promise
  // expandos work, but its implicit prototype is Promise.prototype rather
  // than Function.prototype. Classify it before the widened closure-carrier
  // fallback or a dynamic `promise.then` read consults the wrong companion.
  body.push(...testArm(remaining.promiseTypeIdx, PROMISE_OFF));
  // (#4207) BARE primitive receiver — a native string / boxed number / boxed
  // boolean that never went through `ToObject`. The wrapper arm above only
  // classifies a `$Object` carrying [[PrimitiveValue]]; a primitive reaching a
  // consult site directly (`Number.prototype.m = f; (5).m()`, which lowers to
  // `__extern_method_call(__box_number(5), "m", …)`) fell through every test
  // and answered `Object`, so `Number.prototype`'s companion was never
  // consulted and the inherited method was invisible. §10.4.3 says the
  // receiver's implicit chain starts at its OWN wrapper prototype, so this is
  // the same rule the wrapper arm states, applied one representation earlier.
  // Ordered boolean-before-number because the boxes are distinct struct types
  // and i31 is claimed by Number (a boxed boolean is never an i31 here).
  body.push(...testArm(remaining.boxBooleanTypeIdx >= 0 ? remaining.boxBooleanTypeIdx : undefined, BOOLEAN_OFF));
  body.push(...testArm(remaining.boxNumberTypeIdx >= 0 ? remaining.boxNumberTypeIdx : undefined, NUMBER_OFF));
  body.push(...testArm(I31_HEAP_TYPE, NUMBER_OFF));
  body.push(...testArm(remaining.anyStringTypeIdx >= 0 ? remaining.anyStringTypeIdx : undefined, STRING_OFF));
  body.push(...testArm(remaining.errorTypeIdx >= 0 ? remaining.errorTypeIdx : undefined, ERROR_OFF));
  // `__is_closure_prop_carrier` also answers true for `new F()` instances (they
  // need its expando bag), so they must be claimed as Object BEFORE its
  // Function arm. Unclaimed, `inst.toString` resolved to
  // Function.prototype.toString once #6131 seeded the Function companion —
  // `(new F()).x.toString()` threw its brand TypeError (ES5
  // S11.1.1_A3.2, 2026-09-26).
  for (const typeIdx of remaining.fnctorInstanceTypeIdxs ?? []) body.push(...testArm(typeIdx, OBJ_OFF));
  const isClosureCarrierIdx = remaining.isClosureCarrier;
  if (isClosureCarrierIdx !== undefined) {
    body.push(
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isClosureCarrierIdx },
      { op: "if", blockType: { kind: "empty" }, then: ret(FUN_OFF) },
    );
  }
  body.push({ op: "i32.const", value: OBJ_OFF });
  return { locals, body };
}

/** Keep the original receiver separately from the key and its classified prototype offset. */
export function buildPrototypeReceiverConsultBody(kind: "has" | "get", brandOffset: number, consult: number): Instr[] {
  return [
    ...(kind === "get" ? [{ op: "local.get" as const, index: 0 }] : []),
    { op: "local.get", index: 1 },
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: brandOffset },
    { op: "call", funcIdx: consult },
  ];
}
