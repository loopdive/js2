// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4564) ToPrimitive for the carriers `__to_primitive` could not reduce — a
 * compiled CLOSURE, a `__Date`, and a `__StandaloneRegExp` — under
 * `--target standalone`.
 *
 * ## The gap
 *
 * `__to_primitive` (object-runtime.ts) reduces a `$Object` via
 * OrdinaryToPrimitive, a `$Vec` via Array.prototype.toString, and a nominal
 * class struct via `__class_to_primitive`. Everything else falls into its
 * "return the input unchanged" arm. Closure, Date and RegExp wrappers are all
 * "everything else", so ToPrimitive handed the struct straight back and the
 * caller's `__unbox_number` turned it into NaN:
 *
 * ```js
 * var f = function () { return 1; }, d = new Date(0);
 * f >= f;      // false — must be true
 * d >= d;      // false — must be true
 * +d;          // NaN   — must be 0
 * "1" + d;     // "1[object Object]" — must be "1" + d.toString()
 * /x/ + "";    // NaN   — must be "/x/"
 * ```
 *
 * ## Not the rejected shortcut
 *
 * #4564 explicitly rejects "call `__extern_toString` on whatever
 * `__to_primitive` could not reduce": that is ToString, it skips `valueOf`, and
 * it is wrong exactly where ToPrimitive(number) must prefer `valueOf` — most
 * visibly on a Date. These arms run the real §7.1.1.1 cascade instead:
 *
 *   - `valueOf`/`toString` are resolved in hint order through the complete
 *     property chain. Both carriers carry dynamic own properties in standalone,
 *     and the builtin-prototype companions can carry inherited overrides, so a
 *     user-installed method at either level must win.
 *   - a true HasProperty miss supplies THAT method's intrinsic at that exact
 *     point. A present non-callable or object-returning method still shadows
 *     the same-name intrinsic and advances to the next name. The carrier
 *     intrinsics are `Object.prototype.valueOf` / `Function.prototype.toString`
 *     for a closure, `Date.prototype.valueOf` / `Date.prototype.toString` for
 *     a Date, and `Object.prototype.valueOf` / `RegExp.prototype.toString` for
 *     a RegExp.
 *
 * ## The Date hint is three-way, not two
 *
 * §8.12.8 / §21.4.4.45: a Date's [[DefaultValue]] with hint **default**
 * behaves as hint **string** — that is why `d + d` concatenates two date
 * strings while `d < d` compares time values. `__to_primitive`'s own
 * `isStringHint` collapses default into "not string", which is right for an
 * ordinary object and wrong for a Date, so this module computes the number
 * hint separately (hint present AND not `"string"`).
 *
 * ## Placement
 *
 * Spliced at the FRONT of `__to_primitive`, like
 * `unshiftNativeProtoToPrimitiveArm`, and for the same two reasons: the
 * closure classifier is only complete after closure shapes are finalized, and
 * `any.convert_extern` of a null externref is a null anyref whose `ref.test`
 * is 0 — so a null receiver falls through to the original first instruction
 * untouched. Neither carrier can be a `$Object`, an i31, a boxed number or an
 * `$AnyString`, so the arms cannot shadow an early-out below them.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { buildClosureRefTestArms } from "./closure-classifier.js";
import { NATIVE_FUNCTION_SOURCE } from "./callable-to-string.js";
import { nativeStringLiteralInstrs, stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { CALL_ACCESSOR_GET } from "./accessor-driver.js";
import { ensureDateFormatStringHelper } from "./expressions/builtins.js";
import { ensureStandaloneRegExpToStringDyn, standaloneRegExpStructTypeIdx } from "./regexp-standalone.js";

/**
 * (#4564) The other half of the Date carrier: ToSTRING.
 *
 * `String(d)` and `"" + d` answered `"[object Object]"` while `[d].join(",")`
 * answered the date string — the split is which helper stringifies. `join` and
 * the `+` cascade go through `__extern_toString`, which since #4394 routes every
 * receiver through `__to_primitive` and therefore inherits the arm above. The
 * `String()` / statically-string-`+` sites call `__any_to_string` directly, and
 * its residual arm is a flat `"[object Object]"` literal baked at registration.
 *
 * So this arm delegates to `__to_primitive(v, "string")` rather than
 * re-deriving the date string: one carrier implementation, and a user-installed
 * `d.toString` keeps winning. The reduced primitive replaces parameter 0, then
 * falls through to the original body, which already owns ToString for every
 * primitive kind. Re-entering `__any_to_string` recursively would loop if the
 * carrier arm were unavailable; replacing the parameter also degrades safely
 * in that case because `__to_primitive` returns the original Date unchanged.
 */
export function unshiftDateToStringArm(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const dateTypeIdx = ctx.structMap.get("__Date");
  if (dateTypeIdx === undefined) return;
  if (ctx.anyStrTypeIdx < 0) return;
  const toPrimitiveIdx = ctx.funcMap.get("__to_primitive");
  if (toPrimitiveIdx === undefined) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__any_to_string");
  if (!fn) return;

  addStringConstantGlobal(ctx, "string");
  const hint = stringConstantExternrefInstrs(ctx, "string");
  if (hint.length === 0) return;

  fn.body.unshift({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "local.get", index: 0 },
      { op: "ref.test", typeIdx: dateTypeIdx },
      { op: "i32.eqz" },
      { op: "br_if", depth: 0 },
      { op: "local.get", index: 0 },
      { op: "extern.convert_any" },
      ...hint,
      { op: "call", funcIdx: toPrimitiveIdx },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        // Raw null is not a `$AnyValue` tag, so the original helper's residual
        // arm cannot distinguish it from an unknown object. Finish ToString
        // here; all non-null primitive representations remain delegated below.
        then: [...nativeStringLiteralInstrs(ctx, "null"), { op: "return" }],
      },
    ],
  });
}

/** `__date_format_string` mode 2 — `WkDay Mon DD YYYY HH:mm:ss GMT+0000 (…)`. */
const DATE_FORMAT_MODE_TO_STRING = 2;
/** The Invalid-Date timestamp sentinel (`__Date.timestamp` field 0). */
const INVALID_DATE_TS = -9223372036854775808n;

type HintEquals = (literal: "string" | "number") => Instr[];
type TryCarrierMethod = (name: "valueOf" | "toString", intrinsic: () => Instr[]) => Instr[];

interface CarrierArmBuilders {
  ctx: CodegenContext;
  lAny: number;
  hintEquals: HintEquals;
  tryMethod: TryCarrierMethod;
  throwTypeError: () => Instr[];
  stringExtern: (value: string) => Instr[];
}

function buildClosureCarrierArms(builders: CarrierArmBuilders): Instr[] {
  const { ctx, lAny, hintEquals, tryMethod, throwTypeError, stringExtern } = builders;
  const closureArms = buildClosureRefTestArms(ctx, lAny, [{ op: "unreachable" }]);
  if (closureArms.length === 0) return [];
  // Object.prototype.valueOf returns the closure object, so its intrinsic step
  // deliberately falls through. Function.prototype.toString returns source.
  const intrinsicValueOf = (): Instr[] => [];
  const intrinsicToString = (): Instr[] => [...stringExtern(NATIVE_FUNCTION_SOURCE), { op: "return" }];
  return buildClosureRefTestArms(ctx, lAny, [
    ...hintEquals("string"),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...tryMethod("toString", intrinsicToString), ...tryMethod("valueOf", intrinsicValueOf)],
      else: [...tryMethod("valueOf", intrinsicValueOf), ...tryMethod("toString", intrinsicToString)],
    },
    ...throwTypeError(),
  ]);
}

function buildDateCarrierArms(builders: CarrierArmBuilders, dateTypeIdx: number | undefined): Instr[] {
  if (dateTypeIdx === undefined) return [];
  const { ctx, lAny, hintEquals, tryMethod, throwTypeError, stringExtern } = builders;
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  if (boxNumberIdx === undefined) return [];
  const fmtStrIdx = ensureDateFormatStringHelper(ctx);
  const timestamp = (): Instr[] => [
    { op: "local.get", index: lAny },
    { op: "ref.cast", typeIdx: dateTypeIdx },
    { op: "struct.get", typeIdx: dateTypeIdx, fieldIdx: 0 },
  ];
  const isInvalid = (): Instr[] => [...timestamp(), { op: "i64.const", value: INVALID_DATE_TS }, { op: "i64.eq" }];
  const intrinsicValueOf = (): Instr[] => [
    ...isInvalid(),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: NaN }],
      else: [...timestamp(), { op: "f64.convert_i64_s" }],
    },
    { op: "call", funcIdx: boxNumberIdx },
    { op: "return" },
  ];
  const intrinsicToString = (): Instr[] => [
    ...isInvalid(),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: stringExtern("Invalid Date"),
      else: [
        ...timestamp(),
        { op: "i32.const", value: DATE_FORMAT_MODE_TO_STRING },
        { op: "call", funcIdx: fmtStrIdx },
        { op: "extern.convert_any" },
      ],
    },
    { op: "return" },
  ];
  return [
    { op: "local.get", index: lAny },
    { op: "ref.test", typeIdx: dateTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...hintEquals("number"),
        {
          op: "if",
          blockType: { kind: "empty" },
          // Date DEFAULT behaves as STRING; only an explicit number hint takes
          // valueOf first (§21.4.4.44/§21.4.4.41).
          then: [
            ...tryMethod("valueOf", intrinsicValueOf),
            ...tryMethod("toString", intrinsicToString),
            ...throwTypeError(),
          ],
          else: [
            ...tryMethod("toString", intrinsicToString),
            ...tryMethod("valueOf", intrinsicValueOf),
            ...throwTypeError(),
          ],
        },
      ],
    },
  ];
}

function buildRegExpCarrierArms(builders: CarrierArmBuilders, regexpTypeIdx: number | undefined): Instr[] {
  if (regexpTypeIdx === undefined) return [];
  const { ctx, lAny, hintEquals, tryMethod, throwTypeError } = builders;
  const regexpToStringIdx = ensureStandaloneRegExpToStringDyn(ctx);
  if (regexpToStringIdx === undefined) return [];
  // RegExp has ordinary DEFAULT/NUMBER ordering. Object.prototype.valueOf
  // returns the receiver; RegExp.prototype.toString supplies /source/flags.
  const intrinsicValueOf = (): Instr[] => [];
  const intrinsicToString = (): Instr[] => [
    { op: "local.get", index: lAny },
    { op: "call", funcIdx: regexpToStringIdx },
    { op: "extern.convert_any" },
    { op: "return" },
  ];
  return [
    { op: "local.get", index: lAny },
    { op: "ref.test", typeIdx: regexpTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...hintEquals("string"),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...tryMethod("toString", intrinsicToString), ...tryMethod("valueOf", intrinsicValueOf)],
          else: [...tryMethod("valueOf", intrinsicValueOf), ...tryMethod("toString", intrinsicToString)],
        },
        ...throwTypeError(),
      ],
    },
  ];
}

/**
 * Prepend the closure, `__Date`, and `__StandaloneRegExp`
 * OrdinaryToPrimitive arms onto
 * `__to_primitive`. No-op outside standalone, without `__to_primitive`, or when
 * any helper the arms call is absent (a finalize splice must not conjure one).
 */
export function unshiftCarrierToPrimitiveArms(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__to_primitive");
  if (!fn) return;
  if (ctx.anyStrTypeIdx < 0) return;

  // `WasmFunction.locals` excludes the two parameters. Resolve the scratch
  // slots by the canonical names registered in object-runtime.ts instead of
  // coupling this finalize splice to their current numeric order.
  const localIndex = (name: "any" | "method" | "result"): number | undefined => {
    const offset = fn.locals.findIndex((local) => local.name === name);
    return offset < 0 ? undefined : 2 + offset;
  };
  const L_ANY = localIndex("any");
  const L_METHOD = localIndex("method");
  const L_RESULT = localIndex("result");
  if (L_ANY === undefined || L_METHOD === undefined || L_RESULT === undefined) return;

  const externGetIdx = ctx.funcMap.get("__extern_get");
  const externHasIdx = ctx.funcMap.get("__extern_has");
  const callMethod0Idx = ctx.funcMap.get(CALL_ACCESSOR_GET);
  const typeofNumberIdx = ctx.funcMap.get("__typeof_number");
  const typeofStringIdx = ctx.funcMap.get("__typeof_string");
  const typeofBooleanIdx = ctx.funcMap.get("__typeof_boolean");
  const typeofUndefinedIdx = ctx.funcMap.get("__typeof_undefined");
  const typeofBigintIdx = ctx.funcMap.get("__typeof_bigint");
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (
    externGetIdx === undefined ||
    externHasIdx === undefined ||
    callMethod0Idx === undefined ||
    typeofNumberIdx === undefined ||
    typeofStringIdx === undefined ||
    typeofBooleanIdx === undefined ||
    typeofFunctionIdx === undefined ||
    typeErrorCtorIdx === undefined ||
    ctx.exnTagIdx < 0 ||
    strFlattenIdx === undefined ||
    strEqualsIdx === undefined
  ) {
    return;
  }

  const closureArms = buildClosureRefTestArms(ctx, L_ANY, [{ op: "unreachable" }]);
  const dateTypeIdx = ctx.structMap.get("__Date");
  const regexpTypeIdx = standaloneRegExpStructTypeIdx(ctx);
  if (closureArms.length === 0 && dateTypeIdx === undefined && regexpTypeIdx === undefined) return;

  const stringExtern = (value: string): Instr[] => {
    addStringConstantGlobal(ctx, value);
    return stringConstantExternrefInstrs(ctx, value);
  };

  const primitivePredicates = [
    typeofNumberIdx,
    typeofBooleanIdx,
    typeofStringIdx,
    typeofUndefinedIdx,
    typeofBigintIdx,
  ].filter((idx): idx is number => idx !== undefined);

  /** `local` holds a primitive (§7.1.1.1 step 2.c) → return it. */
  const returnIfPrimitive = (localIdx: number): Instr[] => [
    // Under the standalone singleton regime this is JS null; without it the
    // legacy representation aliases null/undefined. Either way it is primitive.
    { op: "local.get", index: localIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: localIdx }, { op: "return" }],
    },
    ...primitivePredicates.flatMap((predIdx): Instr[] => [
      { op: "local.get", index: localIdx },
      { op: "call", funcIdx: predIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: localIdx }, { op: "return" }],
      },
    ]),
  ];

  const typeErrorMessage = "Cannot convert object to primitive value";
  const throwTypeError = (): Instr[] => [
    ...stringExtern(typeErrorMessage),
    { op: "call", funcIdx: typeErrorCtorIdx },
    { op: "throw", tagIdx: ctx.exnTagIdx },
  ];

  /**
   * §7.1.1.1 step 2 for ONE method name. A present property (own carrier bag or
   * inherited builtin-prototype companion) shadows the intrinsic regardless of
   * callability/result type. Only a full HasProperty miss executes the
   * same-name intrinsic at this exact point in the hint-ordered cascade.
   */
  const tryCarrierMethod = (name: "valueOf" | "toString", intrinsic: () => Instr[]): Instr[] => [
    { op: "local.get", index: 0 },
    ...stringExtern(name),
    { op: "call", funcIdx: externHasIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        ...stringExtern(name),
        { op: "call", funcIdx: externGetIdx },
        { op: "local.set", index: L_METHOD },
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
            ...returnIfPrimitive(L_RESULT),
          ],
        },
      ],
      else: intrinsic(),
    },
  ];

  /** `hint === "string"` — the same test `__to_primitive` makes on its own param. */
  const hintEquals = (literal: "string" | "number"): Instr[] => [
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
            { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
            { op: "call", funcIdx: strFlattenIdx },
            ...nativeStringLiteralInstrs(ctx, literal),
            { op: "call", funcIdx: strFlattenIdx },
            { op: "call", funcIdx: strEqualsIdx },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
    },
  ];

  const builders: CarrierArmBuilders = {
    ctx,
    lAny: L_ANY,
    hintEquals,
    tryMethod: tryCarrierMethod,
    throwTypeError,
    stringExtern,
  };
  const arms: Instr[] = [
    ...buildClosureCarrierArms(builders),
    ...buildDateCarrierArms(builders, dateTypeIdx),
    ...buildRegExpCarrierArms(builders, regexpTypeIdx),
  ];

  if (arms.length === 0) return;
  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: L_ANY },
    ...arms,
  );
}
