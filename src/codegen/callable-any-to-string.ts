// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4492 wave-5) §7.1.17 ToString of a CALLABLE, for every DYNAMIC spelling.
 *
 * ## The defect: one value, four renderings
 *
 * Measured on campaign HEAD `c42bdbe3e`, standalone, one module
 * (`.tmp/probes/t6.js`), with `f1.toString = function(){ return "OWN_F_TS" }`:
 *
 * | spelling        | f1 (own toString) | f2 (plain) |
 * | --------------- | ----------------- | ---------- |
 * | `f.toString()`  | `OWN_F_TS`        | `function f2() {}` |
 * | `"" + f`        | `OWN_F_TS`        | `function () { [native code] }` |
 * | `` `${f}` ``    | `[object Object]` | — |
 * | `String(f)`     | `[object Object]` | `[object Object]` |
 *
 * `+` is right because #4491's `emitAddOrdinaryToPrimitiveResidue` runs a REAL
 * §7.1.1.1 probe (`__extern_get` + `__call_accessor_get`) — but that residue is
 * deliberately scoped to the `+` operator. Every other dynamic spelling lands on
 * `__any_to_string`, whose object terminal is the literal `"[object Object]"`.
 * §20.2.3.5 says ToPrimitive of a callable reaches `Function.prototype.toString`
 * and NEVER `Object.prototype.toString`, so `[object Object]` is wrong for a
 * function under every hint.
 *
 * ## Shape: a guarded PREPEND, callables only
 *
 * `fillSymbolAnyToStringArm` (symbol-native.ts) established the pattern — splice
 * an early-return arm onto the front of the built `__any_to_string`. The guard
 * here is `__typeof_function`, and restricting to callables is what makes the
 * arm safe to put in FRONT of every other arm: a `$AnyString`, an `$AnyValue`
 * box, a `$Vec`, a `__Date`, an `$Error_struct` and a boxed primitive are all
 * non-callable, so each still reaches its own (correct) rendering byte-for-byte.
 * The only values this arm can claim are exactly the ones measured above as
 * `[object Object]`.
 *
 * Inside the arm, §7.1.1.1 OrdinaryToPrimitive with hint **string**: `toString`
 * first, then `valueOf`, each read with `__extern_get` (which walks own slots
 * AND the prototype chain — that is what makes a user's
 * `Function.prototype.toString = …` visible, verified on `.tmp/probes/t8.js`)
 * and invoked through the same `__call_accessor_get` arity bridge the `+`
 * residue uses.
 *
 * ## Only a PRIMITIVE result is accepted, and `null` is not one of the accepted
 * shapes
 *
 * A method that returns an object falls through to the next method, then to the
 * §20.2.3.5 step-3 NativeFunction terminal — so the arm cannot loop and cannot
 * hand `__any_to_string` back an object.
 *
 * A NULL result is DECLINED rather than rendered. In standalone `undefined` and
 * `null` are the same null externref (`__typeof_undefined` is a bare
 * `ref.is_null`, object-runtime.ts), so the two spec answers `"null"` and
 * `"undefined"` are indistinguishable here and the module already contains BOTH
 * conventions — `tryStructToString`'s `normaliseToString` renders a
 * void-returning method as `"undefined"`, while `__any_to_string`'s own #4621-D
 * raw-null arm renders `"null"`. Picking either would make this arm disagree
 * with one of them for a value it cannot actually distinguish, so it picks
 * neither and falls through (absent-not-wrong).
 *
 * ## Declines
 *
 * Non-standalone, no native strings, `__any_to_string` not built, or any of
 * `__typeof_function` / `__typeof_object` / `__extern_get` /
 * `__call_accessor_get` missing → the fill returns having changed nothing, and
 * the module is byte-identical.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { NATIVE_FUNCTION_SOURCE } from "./callable-to-string.js";

/**
 * Prepend the §7.1.17-for-callables arm to the built `__any_to_string`.
 * Idempotent by construction (called once per finalize path); a second call on
 * an already-armed helper would double the arm, so callers must not repeat it.
 */
export function fillCallableAnyToStringArm(ctx: CodegenContext): void {
  if (!ctx.standalone || !ctx.nativeStrings) return;
  if (ctx.anyStrTypeIdx < 0) return;
  const helperIdx = ctx.nativeStrHelpers.get("__any_to_string");
  if (helperIdx === undefined) return;
  const fn = definedFuncAt(ctx, helperIdx);
  if (!fn) return;

  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const callMethod0Idx = ctx.funcMap.get("__call_accessor_get");
  if (
    typeofFunctionIdx === undefined ||
    typeofObjectIdx === undefined ||
    externGetIdx === undefined ||
    callMethod0Idx === undefined
  ) {
    return;
  }
  // The driver is reserved with an `unreachable` stub and only filled when the
  // module has a real arity-0 closure (accessor-driver.ts). Calling an unfilled
  // stub would TRAP — strictly worse than the `[object Object]` this replaces.
  const driver = definedFuncAt(ctx, callMethod0Idx);
  if (!driver || (driver.body.length === 1 && driver.body[0]?.op === "unreachable")) return;

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const boxNumIdx = ctx.nativeBoxNumberTypeIdx;
  const boxBoolIdx = ctx.nativeBoxBooleanTypeIdx;
  const numToStrIdx = ctx.funcMap.get("number_toString");

  // Two fresh externref scratch locals, APPENDED so every index already baked
  // into the helper's body keeps its meaning.
  const L_METHOD = 1 + fn.locals.length;
  const L_RESULT = L_METHOD + 1;
  fn.locals.push(
    { name: "$callable_ts_method", type: { kind: "externref" } },
    { name: "$callable_ts_result", type: { kind: "externref" } },
  );

  /** The receiver (param 0 is `anyref`), as an externref. */
  const recv = (): Instr[] => [{ op: "local.get", index: 0 }, { op: "extern.convert_any" }];

  /**
   * `L_RESULT` holds a primitive we can render → leave a `ref $AnyString` and
   * `return`. Anything else falls out of the `if` and the walk continues.
   * `null` is deliberately NOT one of the accepted shapes (see the header).
   */
  const renderPrimitiveAndReturn = (): Instr[] => {
    const asAny: Instr[] = [{ op: "local.get", index: L_RESULT }, { op: "any.convert_extern" }];
    const numberArm: Instr[] =
      numToStrIdx !== undefined && boxNumIdx >= 0
        ? [
            ...asAny,
            { op: "ref.test", typeIdx: boxNumIdx },
            ...asAny,
            { op: "ref.test", typeIdx: -20 }, // abstract i31 (small int)
            { op: "i32.or" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...asAny,
                { op: "ref.test", typeIdx: -20 },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "f64" } },
                  then: [...asAny, { op: "ref.cast", typeIdx: -20 }, { op: "i31.get_s" }, { op: "f64.convert_i32_s" }],
                  else: [
                    ...asAny,
                    { op: "ref.cast", typeIdx: boxNumIdx },
                    { op: "struct.get", typeIdx: boxNumIdx, fieldIdx: 0 },
                  ],
                },
                { op: "call", funcIdx: numToStrIdx },
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx: anyStrTypeIdx },
                { op: "return" },
              ],
            },
          ]
        : [];
    const boolArm: Instr[] =
      boxBoolIdx >= 0
        ? [
            ...asAny,
            { op: "ref.test", typeIdx: boxBoolIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...asAny,
                { op: "ref.cast", typeIdx: boxBoolIdx },
                { op: "struct.get", typeIdx: boxBoolIdx, fieldIdx: 0 },
                {
                  op: "if",
                  blockType: { kind: "val", type: strRef },
                  then: nativeStringLiteralInstrs(ctx, "true"),
                  else: nativeStringLiteralInstrs(ctx, "false"),
                },
                { op: "return" },
              ],
            },
          ]
        : [];
    return [
      // already a native string?
      ...asAny,
      { op: "ref.test", typeIdx: anyStrTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...asAny, { op: "ref.cast", typeIdx: anyStrTypeIdx }, { op: "return" }],
      },
      ...numberArm,
      ...boolArm,
    ];
  };

  /** §7.1.1.1 steps 2-5 for ONE method name on the callable receiver. */
  const probe = (name: "toString" | "valueOf"): Instr[] => {
    addStringConstantGlobal(ctx, name);
    return [
      ...recv(),
      ...stringConstantExternrefInstrs(ctx, name),
      { op: "call", funcIdx: externGetIdx },
      { op: "local.tee", index: L_METHOD },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // IsCallable(method)? — an `undefined`/data-valued slot is skipped.
          { op: "local.get", index: L_METHOD },
          { op: "call", funcIdx: typeofFunctionIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...recv(),
              { op: "local.get", index: L_METHOD },
              { op: "call", funcIdx: callMethod0Idx },
              { op: "local.set", index: L_RESULT },
              // A non-null, non-object, non-function result is a primitive.
              { op: "local.get", index: L_RESULT },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: L_RESULT },
                  { op: "call", funcIdx: typeofObjectIdx },
                  { op: "local.get", index: L_RESULT },
                  { op: "call", funcIdx: typeofFunctionIdx },
                  { op: "i32.or" },
                  { op: "i32.eqz" },
                  { op: "if", blockType: { kind: "empty" }, then: renderPrimitiveAndReturn() },
                ],
              },
            ],
          },
        ],
      },
    ];
  };

  const arm: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...recv(),
        { op: "call", funcIdx: typeofFunctionIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...probe("toString"),
            ...probe("valueOf"),
            // §20.2.3.5 step 3 — the implementation-defined NativeFunction
            // representation, the same constant `callable-to-string.ts` (#4265)
            // and `installCompiledClosureToStringArm` already answer.
            ...nativeStringLiteralInstrs(ctx, NATIVE_FUNCTION_SOURCE),
            { op: "return" },
          ],
        },
      ],
    },
  ];
  fn.body.splice(0, 0, ...arm);
}
