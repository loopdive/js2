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
 * The walk runs `userInstalledOnly` — see that option's doc: on a callable,
 * `__extern_get`'s INHERITED resolution answers `Object.prototype.toString`
 * rather than `Function.prototype.toString`, so an unrestricted walk renders a
 * plain function `"[object Function]"`. Gating on "the program installed this
 * member" (own slot, or a `<Ctor>.prototype.<m> = …` write on the #4176
 * companion) admits exactly the overrides this arm exists for.
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
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { ANY_TO_STRING_HELPER, EXTERN_TO_STRING_HELPER } from "./native-strings.js";
import { NATIVE_FUNCTION_SOURCE } from "./callable-to-string.js";
import { buildOrdinaryToPrimitiveProbe, resolveOrdinaryToPrimitiveProbeDeps } from "./ordinary-to-primitive-probe.js";

/**
 * Prepend the §7.1.17-for-callables arm to the built `__any_to_string`.
 * Idempotent by construction (called once per finalize path); a second call on
 * an already-armed helper would double the arm, so callers must not repeat it.
 */
export function fillCallableAnyToStringArm(ctx: CodegenContext): void {
  if (!ctx.standalone || !ctx.nativeStrings) return;
  if (ctx.anyStrTypeIdx < 0) return;
  const helperIdx = ctx.nativeStrHelpers.get(ANY_TO_STRING_HELPER);
  if (helperIdx === undefined) return;
  const fn = definedFuncAt(ctx, helperIdx);
  if (!fn) return;

  const deps = resolveOrdinaryToPrimitiveProbeDeps(ctx);
  if (deps === undefined) return;
  const typeofFunctionIdx = deps.typeofFunctionIdx;

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
   * `L_RESULT` holds a value already PROVEN primitive (not null, not object,
   * not function) — render it and `return`.
   *
   * The rendering is a SELF-CALL back into `__any_to_string`, not a local
   * number/boolean/string matrix. Two reasons, and the second is the one that
   * decides it:
   *  - it terminates by construction: the recursive argument is non-callable, so
   *    this arm's own `__typeof_function` guard fails on re-entry and the value
   *    falls to the helper's ordinary primitive arms;
   *  - a local matrix would be a FOURTH hand-rolled copy of the same §7.1.17
   *    cascade, which is exactly the drift the #2108 coercion-sites gate exists
   *    to stop — and it would have had to re-derive the boxed-number / i31 /
   *    boxed-boolean / `$undefined`-singleton arms that this helper already owns.
   */
  const renderPrimitiveAndReturn = (): Instr[] => [
    { op: "local.get", index: L_RESULT },
    { op: "any.convert_extern" },
    { op: "call", funcIdx: helperIdx },
    { op: "return" },
  ];

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
            // §7.1.1.1 with hint "string": toString → valueOf, over the shared
            // runtime walk (ordinary-to-primitive-probe.ts).
            ...buildOrdinaryToPrimitiveProbe(ctx, deps, {
              recv,
              methodLocal: L_METHOD,
              resultLocal: L_RESULT,
              order: ["toString", "valueOf"],
              onPrimitive: renderPrimitiveAndReturn,
              stopWhenFirstAbsent: true,
              userInstalledOnly:
                !ctx.protoNamedWrittenMembers.has("toString") && !ctx.protoNamedWrittenMembers.has("valueOf"),
            }),
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

/**
 * (#4492 wave-5) The SAME consult for `__extern_toString`, which is the dispatcher
 * a callable reaches when the receiver compiles to an `externref` rather than a
 * concrete closure-struct ref.
 *
 * ## Why a second site is not a duplicate
 *
 * `__extern_toString`'s own body is already right — `__to_primitive(v, "string")`
 * then `__any_to_string` — but `installCompiledClosureToStringArm` (#3540,
 * coercion-engine.ts) PREPENDS a closure arm that answers §20.2.3.5 step 3's
 * `"function () { [native code] }"` constant and RETURNS, before any of it runs.
 * That short-circuit is what makes the defect receiver-representation-dependent,
 * and it is why the same source reads differently in two module shapes:
 *
 * ```js
 * function f() {} f.toString = function () { return "OWN_F_TS"; }; String(f)
 * ```
 *
 * answers `"[object Object]"` at test262 top level (concrete ref →
 * `__any_to_string`) and `"function () { [native code] }"` inside an exported
 * function (externref → `__extern_toString`). Measured 2026-08-23: the first
 * cut of this slice fixed only the former, and the pin suite — whose bodies are
 * wrapped in `export function test()` — still failed 4 of 4 callable pins while
 * every test262 row of the same family passed. Two dispatchers, one defect.
 *
 * ## Shape
 *
 * Prepended AFTER the closure arm is installed, so it runs BEFORE it, and it
 * carries NO terminal of its own: when the walk finds no own/inherited method the
 * arm falls straight through and the closure constant answers exactly as today.
 * Callables only, same guard and same shared walk as
 * {@link fillCallableAnyToStringArm}.
 */
export function fillCallableExternToStringArm(ctx: CodegenContext): void {
  if (!ctx.standalone || !ctx.nativeStrings) return;
  if (ctx.anyStrTypeIdx < 0) return;
  const anyToStringIdx = ctx.nativeStrHelpers.get(ANY_TO_STRING_HELPER);
  if (anyToStringIdx === undefined) return;
  const externToStringIdx = ctx.funcMap.get(EXTERN_TO_STRING_HELPER);
  if (externToStringIdx === undefined) return;
  const fn = definedFuncAt(ctx, externToStringIdx);
  if (!fn) return;

  const deps = resolveOrdinaryToPrimitiveProbeDeps(ctx);
  if (deps === undefined) return;

  const L_METHOD = 1 + fn.locals.length;
  const L_RESULT = L_METHOD + 1;
  fn.locals.push(
    { name: "$callable_ets_method", type: { kind: "externref" } },
    { name: "$callable_ets_result", type: { kind: "externref" } },
  );

  const recv = (): Instr[] => [{ op: "local.get", index: 0 }];
  const walk = buildOrdinaryToPrimitiveProbe(ctx, deps, {
    recv,
    methodLocal: L_METHOD,
    resultLocal: L_RESULT,
    order: ["toString", "valueOf"],
    stopWhenFirstAbsent: true,
    // Same gate, same measured reason as the `__any_to_string` twin: this is the
    // path on which the unrestricted walk answered `"[object Function]"` for a
    // plain function (`built-ins/Function/prototype/toString/Function.js`).
    userInstalledOnly: !ctx.protoNamedWrittenMembers.has("toString") && !ctx.protoNamedWrittenMembers.has("valueOf"),
    // The result is a PRIMITIVE externref; this helper owes its caller a STRING
    // externref, so render through the ToString dispatcher (which cannot
    // re-enter this arm — its argument is non-callable by construction).
    onPrimitive: () => [
      { op: "local.get", index: L_RESULT },
      { op: "any.convert_extern" },
      { op: "call", funcIdx: anyToStringIdx },
      { op: "extern.convert_any" },
      { op: "return" },
    ],
  });

  fn.body.splice(0, 0, {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      { op: "br_if", depth: 0 },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: deps.typeofFunctionIdx },
      { op: "i32.eqz" },
      { op: "br_if", depth: 0 },
      ...walk,
    ],
  });
}
