import type { Instr, ValType } from "../../ir/types.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Built-in global constructor dispatch for `new C(...)` — extracted from
 * `compileNewExpression` (new-super.ts) as WAVE-C decomposition slice 1 (#3281).
 *
 * Covers the identifier-keyed built-in globals: Promise, the
 * Number/String/Boolean wrapper objects, the Error family
 * (Error/TypeError/RangeError/…), AggregateError, SuppressedError, Object,
 * Proxy, Function, Date, and the TypedArray constructors. Each arm either fully
 * handles the ctor (emitting into `fctx.body` and returning a `ValType | null`)
 * or does nothing and falls through; a single `NEW_GLOBAL_FALLTHROUGH` sentinel
 * signals "not one of these globals" so the caller resumes its dispatch ladder.
 * The lifted arms are byte-identical to the inline originals.
 */
import { ts } from "../../ts-api.js";
import type { TypeFact } from "../../checker/oracle.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "../context/locals.js";
import { addUnionImports, getArrTypeIdxFromVec, getOrRegisterVecType, typedArrayVecStorage } from "../index.js";
import { coercionPlan } from "../coercion-plan.js";
import { emitToString, getExternrefToStringProvider } from "../coercion-engine.js";
import { emitTaViewConstruct, emitTaViewConstructWindowed } from "../dataview-native.js";
import { emitNativeDateParse } from "../date-parse-native.js";
import { compileObjectLiteralAsExternref } from "../literals.js";
import { ensureAnyToStringHelper, ensureNativeStringBoundaryBridge } from "../native-strings.js";
import { emitNativeNumberFormat } from "../number-format-native.js";
import { ensureNativeProxyRuntime } from "../object-runtime.js";
import { ensureSymbolCarrier } from "../symbol-native.js";
import { undefinedSingletonActive } from "../any-helpers.js";
import { emitStandalonePromiseFromExecutor, emitStandalonePromiseFromExecutorValue } from "../promise-executor.js";
import { isStandalonePromiseActive } from "../async-scheduler.js";
import { isInertNonCallableLiteral } from "../promise-newtarget.js"; // (#5143)
import { emitStandaloneTest262Error, emitWasiErrorConstructor, isWasiErrorName } from "../registry/error-types.js";
import { emitTest262ErrorWithModuleCtor } from "./test262-error-ctor.js";
import { errorCtorNameIsUserFunctionShadowed, errorCtorNameIsUserShadowed } from "./shadowed-error-ctor.js"; // (#4394) intrinsic-name shadow guard
import { coerceType, compileArrowAsClosure, compileExpression } from "../shared.js";
import type { InnerResult } from "../shared.js";
import { compileStringLiteral } from "../string-ops.js";
import { coerceType as coerceTypeImpl } from "../type-coercion.js";
import { ensureNativeIteratorRuntime } from "../iterator-native.js";
import { ensureDateDaysFromCivilHelper, ensureDateFormatStringHelper, ensureDateStruct } from "./builtins.js";
import { emitStandaloneDateTimestamp } from "../standalone-clock-capability.js";
import { emitObjectCoercion } from "./calls-guards.js";
import {
  emitDynamicNewFunctionHostEval,
  emitStandaloneDynamicFunctionRuntime,
  emitStandaloneDynamicFunctionStub,
  isGlobalFunctionIdentifier,
  tryStaticNewFunction,
} from "./eval-inline.js";
import { buildThrowJsErrorInstrs, emitThrowTypeError, noJsHost } from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { emitNewBooleanToBooleanArg } from "../new-boolean-tobooleanarg.js"; // (#4619)
import { emitSymbolOperandCoercionThrow } from "../tonumber-symbol-throw.js"; // (#3481)
import { emitHostTypedArrayCarrierRegistration } from "./typed-array-host-carrier.js";
import {
  emitHostTaBufferConstruct,
  hostTaBufferArgSymName,
  isStringTypedArg,
  resolvesToAmbientGlobal,
} from "./new-super.js";
import { tryEmitStandaloneDateCtorValueArg } from "../date-ctor-value-arg.js"; // (#5156) §21.4.2.2 step 4
import { emitStandaloneBooleanConstructorValue } from "./standalone-primitive-tail.js";

/** Sentinel: the `new` target is not one of the built-in global constructors. */
export const NEW_GLOBAL_FALLTHROUGH = Symbol("new-builtin-global-fallthrough");

/**
 * (#5096) The one name this file claims ON PURPOSE even when the module
 * declares it.
 *
 * `Test262Error` has no ambient declaration at all — sta.js / the #2902
 * wrapped-harness injection declares it in the module under compilation — and
 * the arms below exist precisely to reconcile that (the standalone
 * `$Error_struct` interception is what makes ~2,779 wrapped tests host-free).
 * So it must survive the shadow guard, whose whole point is that a user
 * declaration outranks an intrinsic. Its own narrower guards (#4394,
 * `errorCtorNameIsUserFunctionShadowed`) already decide which of the two
 * lowerings that declaration should get.
 */
const SHADOW_GUARD_EXEMPT_CTORS = new Set(["Test262Error"]);

/**
 * (#5096) Should the built-in claim below DECLINE because the callee name
 * resolves to a user binding at this site?
 *
 * The arms in this file key on the callee's SPELLING (`expr.expression.text ===
 * "Date"`, `builtinName === "Object"`, the TypedArray name set, …). Per §9.1
 * any lexical/var binding in scope shadows the global, so a spelling match is
 * not by itself a claim on the intrinsic — `class Date { … }; new Date()` was
 * building the native `$Date` struct while the identifier named the user class.
 * Consulting the binding HERE, at the claim point, keeps every unshadowed
 * program byte-identical (the ambient answer is unchanged) while handing a
 * shadowed one back to the caller's ordinary user-class / user-function
 * dispatch.
 *
 * `builtinNameOverride` callers are exempt: they arrive from
 * `tryCompileBuiltinPrototypeConstructorNew`, which has ALREADY proved
 * intrinsic identity through `X.prototype.constructor` (the callee there is not
 * a bare identifier, so a binding lookup on it would answer the wrong
 * question).
 */
function builtinNewClaimIsShadowed(
  ctx: CodegenContext,
  expr: ts.NewExpression,
  builtinNameOverride: string | undefined,
): boolean {
  if (builtinNameOverride !== undefined) return false;
  const callee = expr.expression;
  if (!ts.isIdentifier(callee)) return false;
  if (SHADOW_GUARD_EXEMPT_CTORS.has(callee.text)) return false;
  return !resolvesToAmbientGlobal(ctx, callee);
}

/**
 * (#4616) Is the single `new Date(arg)` argument DYNAMIC — statically able to
 * hold a String at runtime without being string-typed (any/unknown/
 * unresolvable, or a union with a string part)? Such an arg needs the runtime
 * string-vs-ToNumber dispatch below; statically-typed number/Date args keep
 * the plain ToNumber(ms) path.
 */
function isDynamicMaybeStringArg(ctx: CodegenContext, arg: ts.Expression): boolean {
  const fact = ctx.oracle.typeFactOf(arg);
  if (fact.kind === "any" || fact.kind === "unknown" || fact.kind === "unresolvable") return true;
  return fact.kind === "union" && fact.parts.some((p) => p.kind === "string");
}

/**
 * Whether a Proxy target/handler fact can carry a native Symbol at runtime.
 *
 * ProxyCreate is emitted before its arguments are compiled.  In the native
 * provider that means the one-time primitive validation body can otherwise be
 * baked before the Symbol carrier exists.  Keep this query on the TypeOracle
 * boundary: `any`/`unknown`/`unresolvable` are deliberately conservative, and
 * a union is Symbol-capable when any constituent is.
 */
function typeFactMayCarrySymbol(fact: TypeFact): boolean {
  switch (fact.kind) {
    case "symbol":
    case "any":
    case "unknown":
    case "unresolvable":
      return true;
    case "array":
      return typeFactMayCarrySymbol(fact.element);
    case "tuple":
      return fact.elements.some(typeFactMayCarrySymbol);
    case "union":
      return fact.parts.some(typeFactMayCarrySymbol);
    default:
      return false;
  }
}

function nativeProxyArgsMayCarrySymbol(ctx: CodegenContext, args: readonly ts.Expression[]): boolean {
  let positionalCount = 0;
  for (const arg of args) {
    // A spread source may supply either required position at runtime, so its
    // element fact is part of the target/handler carrier query. Once two
    // ordinary values have been seen, later extras cannot affect validation.
    const fact = ctx.oracle.typeFactOf(ts.isSpreadElement(arg) ? arg.expression : arg);
    if (typeFactMayCarrySymbol(fact)) return true;
    if (!ts.isSpreadElement(arg)) {
      positionalCount++;
      if (positionalCount === 2) return false;
    }
  }
  return false;
}

/**
 * Mirror the existing static call/new spread fast path: direct array-literal
 * spreads can be flattened without materializing an intermediate iterable.
 * A non-literal source stays on the iterator path; nested spread elements are
 * intentionally retained for that path, matching the canonical one-level
 * call-argument flattener.
 */
function flattenProxyArguments(args: readonly ts.Expression[]): ts.Expression[] | null {
  const flattened: ts.Expression[] = [];
  for (const arg of args) {
    if (!ts.isSpreadElement(arg)) {
      flattened.push(arg);
      continue;
    }
    if (!ts.isArrayLiteralExpression(arg.expression)) return null;
    for (const element of arg.expression.elements) flattened.push(element);
  }
  return flattened;
}

interface ExpandedProxyArgumentLocals {
  target: number;
  handler: number;
  count: number;
  value: number;
  source: number;
  iterator: number;
  done: number;
}

/**
 * Emit Proxy's full ArgumentListEvaluation for a call containing a spread.
 *
 * A SpreadElement contributes zero or more positional values. Drive every
 * spread through the iterator protocol used by for-of and array spread,
 * retaining only the first two expanded values while evaluating all the rest.
 * The caller resolves the Proxy provider after this emitter has finished, so
 * late imports registered by argument expressions cannot stale that call.
 */
function emitExpandedProxyArguments(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  compileValue: (arg: ts.Expression) => void,
): ExpandedProxyArgumentLocals {
  const targetLocal = allocTempLocal(fctx, { kind: "externref" });
  const handlerLocal = allocTempLocal(fctx, { kind: "externref" });
  const countLocal = allocTempLocal(fctx, { kind: "i32" });
  const valueLocal = allocTempLocal(fctx, { kind: "externref" });
  const sourceLocal = allocTempLocal(fctx, { kind: "externref" });
  const iteratorLocal = allocTempLocal(fctx, { kind: "externref" });
  const doneLocal = allocTempLocal(fctx, { kind: "i32" });

  // Missing target/handler use the same nullish carrier as the ordinary path.
  fctx.body.push(
    { op: "ref.null.extern" },
    { op: "local.set", index: targetLocal },
    { op: "ref.null.extern" },
    { op: "local.set", index: handlerLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: countLocal },
  );

  const captureValue = (): Instr[] => [
    { op: "local.get", index: countLocal },
    { op: "i32.const", value: 0 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: valueLocal },
        { op: "local.set", index: targetLocal },
      ],
      else: [
        { op: "local.get", index: countLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: valueLocal },
            { op: "local.set", index: handlerLocal },
          ],
          else: [{ op: "local.get", index: valueLocal }, { op: "drop" }],
        },
      ],
    },
    { op: "local.get", index: countLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: countLocal },
  ];

  for (const arg of args) {
    if (!ts.isSpreadElement(arg)) {
      compileValue(arg);
      fctx.body.push({ op: "local.set", index: valueLocal });
      fctx.body.push(...captureValue());
      continue;
    }

    // Evaluate the source once, obtain its iterator, and drain it before the
    // next argument. Abrupt source/iterator steps therefore win over Proxy
    // validation exactly as they do in JavaScript ArgumentListEvaluation.
    const sourceType = compileExpression(ctx, fctx, arg.expression);
    if (sourceType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (sourceType.kind !== "externref") {
      coerceTypeImpl(ctx, fctx, sourceType, { kind: "externref" });
    }
    fctx.body.push({ op: "local.set", index: sourceLocal });
    flushLateImportShifts(ctx, fctx);

    const iterIdx = ctx.funcMap.get("__iterator");
    const nextIdx = ctx.funcMap.get("__iterator_next");
    if (iterIdx === undefined || nextIdx === undefined) {
      // The iterator runtime/imports are registered before this helper. Keep a
      // defensive index-space-frozen fallback that still evaluates the source
      // and preserves the old one-positional behavior without invalid Wasm.
      fctx.body.push({ op: "local.get", index: sourceLocal }, { op: "local.set", index: valueLocal });
      fctx.body.push(...captureValue());
      continue;
    }

    fctx.body.push(
      { op: "local.get", index: sourceLocal },
      { op: "call", funcIdx: iterIdx },
      { op: "local.set", index: iteratorLocal },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: iteratorLocal },
              { op: "call", funcIdx: nextIdx },
              { op: "local.set", index: valueLocal },
              { op: "local.set", index: doneLocal },
              { op: "local.get", index: doneLocal },
              { op: "br_if", depth: 1 },
              ...captureValue(),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    );
  }

  return {
    target: targetLocal,
    handler: handlerLocal,
    count: countLocal,
    value: valueLocal,
    source: sourceLocal,
    iterator: iteratorLocal,
    done: doneLocal,
  };
}

/**
 * Whether an Error message can carry a native Symbol at runtime. Keep the
 * strict dynamic carrier arm out of statically ordinary string/number/object
 * messages so those existing constructor bodies remain byte-identical; an
 * oracle `symbol`, `any`, `unknown`, `unresolvable`, or union containing one
 * is the bounded set whose value may be a Symbol.
 */
function errorMessageMayCarrySymbol(ctx: CodegenContext, arg: ts.Expression): boolean {
  const fact = ctx.oracle.typeFactOf(arg);
  if (fact.kind === "symbol" || fact.kind === "any" || fact.kind === "unknown" || fact.kind === "unresolvable") {
    return true;
  }
  return (
    fact.kind === "union" &&
    fact.parts.some(
      (part) =>
        part.kind === "symbol" || part.kind === "any" || part.kind === "unknown" || part.kind === "unresolvable",
    )
  );
}

/**
 * (#4100) "Is the Error message null-or-undefined?" — leaves an i32 on the stack.
 *
 * `ref.is_null` alone misses a RUNTIME-undefined message: under the #2106
 * singleton regime `undefined` in the externref plane is a tag-1 `$AnyValue` box
 * (`global.get $undefined; extern.convert_any`), which is NOT null. So
 * `let m; new Error(m)` stored ToString(undefined) and rendered
 * "Error: undefined" where §20.5.1.1 step 3 requires the name alone.
 *
 * #4035 fixed only the STATIC literal because the obvious runtime test —
 * `__extern_is_undefined` — requires `ensureObjectRuntime`, measured at **+3KB**
 * on every standalone Error-constructing module. This is that predicate INLINED:
 * a `ref.test` plus one `struct.get` of the tag field. No helper, no import, no
 * object runtime. **Measured cost: +28 bytes** on a module that constructs an
 * Error, and **+0** on one that does not.
 *
 * It stays free because of the gate: emitted ONLY when the module ALREADY has
 * the `$AnyValue` machinery. `ensureAnyValueType` is deliberately NOT called —
 * if the regime is inactive there is no undefined singleton in this module to
 * miss, so the bare `ref.is_null` is already the complete and correct test.
 *
 * KNOWN RESIDUAL, pre-existing and NOT introduced here: `new Error(null)`
 * renders "Error" where the spec wants "Error: null" (step 3 exempts only
 * `undefined`). The original `ref.is_null` guard conflated the two; this keeps
 * that behaviour rather than silently widening scope. Verified present on the
 * base commit too.
 */
function emitNullOrUndefinedMessageTest(ctx: CodegenContext, msgTmp: number): Instr[] {
  const anyIdx = ctx.anyValueTypeIdx;
  if (!(undefinedSingletonActive(ctx) && anyIdx >= 0)) {
    return [{ op: "local.get", index: msgTmp }, { op: "ref.is_null" }];
  }
  return [
    { op: "local.get", index: msgTmp },
    { op: "ref.is_null" },
    // Re-convert rather than tee into a scratch anyref local: two extra instrs,
    // but no added local slot in every Error-constructing function.
    { op: "local.get", index: msgTmp },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: msgTmp },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyIdx },
        // field 0 = tag; tag 1 = Undefined (see `ensureAnyValueType`).
        { op: "struct.get", typeIdx: anyIdx, fieldIdx: 0 },
        { op: "i32.const", value: 1 },
        { op: "i32.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
    { op: "i32.or" },
  ];
}

/**
 * (#4035) True when `expr` is STATICALLY the `undefined` value — the bare
 * `undefined` identifier or the `undefined` keyword, through any number of
 * parens / `as T` / `satisfies T` / `!` wrappers (the failing shape was
 * `new Error(undefined as any)`). A local named `undefined` shadows the global,
 * so the identifier form defers to `fctx.localMap` exactly as the `map-runtime`
 * / `array-methods` callers of this same idiom do. Conservative by
 * construction: anything it cannot prove returns false and keeps the existing
 * runtime path.
 *
 * Why static: §20.5.1.1 step 3 is "if message is not undefined", so an
 * explicitly-undefined message must behave exactly like NO message. The
 * `ref.is_null` guard in the ToString block cannot see that by itself —
 * under the #2106 undefinedSingleton regime (standalone/native-strings)
 * `undefined` is a DISTINCT non-null sentinel externref, so
 * `new Error(undefined)` stored ToString(undefined) and rendered
 * "Error: undefined". Recognising the literal here routes it to the
 * argument-less path at ZERO code size. The alternative — always emitting a
 * runtime undefined-test — has to `ensureObjectRuntime` for
 * `__extern_is_undefined`, measured at +3KB (19.0 → 22.9KB) on every
 * standalone module that constructs any Error, which would defeat the
 * binary-size goal this very PR exists to serve (it broke that very test).
 *
 * KNOWN RESIDUAL, deliberately not fixed here: a message that is undefined
 * only at RUNTIME (`let m; new Error(m)`) still renders "Error: undefined".
 * Closing that needs the cheap undefined-sentinel comparison this site cannot
 * afford today, not a wider guard.
 */
function isStaticUndefinedExpr(expr: ts.Expression, fctx: FunctionContext): boolean {
  let node: ts.Expression = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      node = node.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(node)) {
      node = node.expression;
      continue;
    }
    break;
  }
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  return ts.isIdentifier(node) && node.text === "undefined" && !fctx.localMap.has("undefined");
}

/**
 * Does `new String(value)` need the RUNTIME ToString walk rather than the
 * compile-time one?
 *
 * Only for an ARRAY (or tuple) argument. That is the one shape where the static
 * lowering is structurally wrong: `emitToString` answers a GC-ref receiver with
 * `$__any_to_string`, which stringifies the vec as `"[object Object]"`, while
 * §23.1.3.36 says an Array's `toString` is `join(",")`. The `String(x)` call
 * arm has always had a dedicated array arm for exactly this reason
 * (`tryEmitArrayToStringNative`, #2160); this is the `new String(x)` half.
 *
 * Deliberately NOT widened to every object. `{valueOf: function(){}, toString:
 * void 0}` — an ABSENT `toString` whose `valueOf` returns `undefined`, so
 * ToPrimitive answers the primitive `undefined` and ToString answers
 * `"undefined"` — is answered correctly by the static path and NOT by the
 * runtime one (measured: `String/prototype/substring/S15.5.4.15_A1_T9`
 * regressed when the object case was included). The two walks disagree on
 * absent/undefined-returning coercion methods, and that disagreement is its own
 * work item; this arm claims only the shape where the static answer cannot be
 * right.
 */
function needsRuntimeToStringForWrapper(ctx: CodegenContext, value: ts.Expression): boolean {
  const fact = ctx.oracle.typeFactOf(value);
  return fact.kind === "array" || fact.kind === "tuple";
}

/**
 * Emit the argument stored in a String wrapper's [[StringData]] slot.
 * Returns true when a statically-known Symbol emitted a terminal TypeError.
 */
function emitStringWrapperValue(ctx: CodegenContext, fctx: FunctionContext, value: ts.Expression): boolean {
  if (ctx.oracle.staticJsTypeOf(value) === "symbol") {
    const valueType = compileExpression(ctx, fctx, value);
    if (valueType !== null) fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a string");
    return true;
  }
  // (ES5 standalone lane) §22.1.1.1 step 2 is `? ToString(value)` — the SAME
  // conversion `String(value)` performs. `emitToString` below answers it from
  // the STATIC type, and for a GC-ref receiver that means `$__any_to_string`,
  // which stringifies structurally. So the two spellings disagreed exactly
  // where the conversion is interesting:
  //
  //     function F() {}
  //     F.prototype.toString = function () { return "abc"; };
  //     String(new F())      // "abc"
  //     new String(new F())  // "[object Object]"   ← measured
  //     new String(new Array(1, 2, 3))  // "[object Object]", spec "1,2,3"
  //
  // `__extern_toString` is the runtime `ToString(ToPrimitive(v,"string"))` the
  // `String(x)` path reaches: it walks OrdinaryToPrimitive (so an INHERITED
  // `toString` runs) and reduces a vec through `Array.prototype.toString`.
  // Routing the host-free lane's non-primitive values through it makes the two
  // agree. Statically-primitive values keep the cheaper static lowering, and a
  // module without the object runtime (no `__extern_toString`) keeps today's
  // path — so this can only change the answer where it is currently structural.
  if (noJsHost(ctx) && needsRuntimeToStringForWrapper(ctx, value)) {
    const compiled = compileExpression(ctx, fctx, value, { kind: "externref" });
    if (compiled !== null) {
      if (compiled.kind !== "externref") coerceType(ctx, fctx, compiled, { kind: "externref" });
      const toStringIdx = getExternrefToStringProvider(ctx);
      if (toStringIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: toStringIdx });
        return false;
      }
      // No object runtime in this module — fall back to the static lowering on
      // the value already compiled (externref is one of its input kinds).
      const fallback = emitToString(ctx, fctx, compiled, ctx.oracle.typeFactOf(value), "string");
      if (fallback.kind !== "externref") coerceType(ctx, fctx, fallback, { kind: "externref" });
      return false;
    }
  }
  const valueTsType = ctx.oracle.typeFactOf(value);
  const valueType = compileExpression(ctx, fctx, value);
  // A host-mode externref may be a dynamic object whose conversion methods
  // live in the host sidecar (including properties assigned after the literal
  // was created). Preserve that object for `__new_String`, whose real JS
  // constructor performs the complete ToString walk. Pre-stringifying it via
  // `__extern_toString` during module start cannot invoke callback-backed
  // methods yet and regresses the inherited/dynamically-assigned valueOf path.
  //
  // Statically-known WasmGC refs still take the in-Wasm ToString path below:
  // those are precisely the module-start shapes whose closure methods the host
  // cannot reach and which #3766 resolves directly.
  if (!noJsHost(ctx) && valueType?.kind === "externref") return false;
  const stringType = emitToString(ctx, fctx, valueType, valueTsType, "string");
  if (stringType.kind !== "externref") coerceType(ctx, fctx, stringType, { kind: "externref" });
  return false;
}

export function tryCompileBuiltinGlobalNew(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
  builtinNameOverride?: string,
): ValType | null | typeof NEW_GLOBAL_FALLTHROUGH {
  // (#5096) Binding resolution precedes every name claim in this file.
  if (builtinNewClaimIsShadowed(ctx, expr, builtinNameOverride)) return NEW_GLOBAL_FALLTHROUGH;

  // Handle `new Promise(executor)`.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Promise") {
    // (#2959) Native standalone/WASI path — construct the `$Promise` and run the
    // executor with synthesised native resolve/reject closures, retiring the
    // `Promise_new` host import. Gated inside the helper on
    // `isStandalonePromiseActive` + a resolvable executor closure; when it can't
    // apply it emits NOTHING and returns false, falling through to the host path
    // below (byte-unchanged in host/gc mode). Guard the ambient-global binding so
    // a user `class Promise {}` / local shadow keeps the normal ctor path.
    const promiseArgs = expr.arguments ?? [];
    // (#5143 C3) §27.2.3.1 step 2: `IsCallable(executor)` is false → throw a
    // TypeError. The native lowerings below only admit a resolvable closure, so
    // a syntactically non-callable executor (`new Promise(1)`, `new Promise({})`,
    // `new Promise()`) fell through to the `Promise_new` host import — which in
    // standalone mode is a host-import LEAK that silently constructs nothing and
    // throws nothing. Only literal shapes the compiler can prove non-callable are
    // claimed here; a runtime value stays on the value path below, which does its
    // own callability check. Standalone-carrier gated, so host/gc is byte-inert.
    if (
      isStandalonePromiseActive(ctx) &&
      !ctx.classSet.has("Promise") &&
      resolvesToAmbientGlobal(ctx, expr.expression) &&
      (promiseArgs.length === 0 || isInertNonCallableLiteral(ctx, fctx, promiseArgs[0]!))
    ) {
      emitThrowTypeError(ctx, fctx, "Promise resolver is not a function");
      return { kind: "externref" };
    }
    if (
      promiseArgs.length >= 1 &&
      !ctx.classSet.has("Promise") &&
      resolvesToAmbientGlobal(ctx, expr.expression) &&
      emitStandalonePromiseFromExecutor(ctx, fctx, promiseArgs[0]!)
    ) {
      return { kind: "externref" };
    }
    // (#2903 R1) Native path for a NON-inline executor VALUE (identifier / param
    // / any runtime closure) — invoked through `__apply_closure` since its
    // concrete closure type isn't recoverable at compile time. Tried only when
    // the inline path above declined AND the executor arg is not a syntactic
    // arrow/function-expression (those are the inline path's domain). Retires the
    // `Promise_new` + `__make_callback` leak for `make(ex)=>new Promise(ex)`.
    if (
      promiseArgs.length >= 1 &&
      !ctx.classSet.has("Promise") &&
      resolvesToAmbientGlobal(ctx, expr.expression) &&
      !ts.isArrowFunction(promiseArgs[0]!) &&
      !ts.isFunctionExpression(promiseArgs[0]!) &&
      emitStandalonePromiseFromExecutorValue(ctx, fctx, () => {
        const t = compileExpression(ctx, fctx, promiseArgs[0]!, { kind: "externref" });
        if (t && t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
        else if (t === null) fctx.body.push({ op: "ref.null.extern" });
      })
    ) {
      return { kind: "externref" };
    }
    // (#2903) This is the genuine HOST `new Promise` fallthrough (executor not
    // native-lowerable) — the runtime value is a host promise, so the
    // `.then`/`.catch` bridge's miss arm must keep its host fallback for the
    // rest of this module. (`Promise_new` funcMap presence can't signal this:
    // it is upfront-registered for every syntactic `new Promise` even when the
    // lowering is native.) Order caveat: a bridge compiled BEFORE this point
    // already chose its arm; acceptable — the affected shape (a `.then` in an
    // earlier function over a later non-inline-executor promise) now throws a
    // catchable TypeError instead of host-chaining, and can only occur in
    // modules that were irreducibly host-import-leaky anyway.
    if (ctx.standalone === true && ctx.wasi !== true) {
      ctx.moduleHasHostPromiseSource = true;
    }
    let funcIdx =
      ctx.funcMap.get("Promise_new") ??
      ensureLateImport(ctx, "Promise_new", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    funcIdx = ctx.funcMap.get("Promise_new") ?? funcIdx;
    if (funcIdx !== undefined) {
      const args = expr.arguments ?? [];
      if (args.length >= 1) {
        compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  // Handle `new Number(x)`, `new String(x)`, `new Boolean(x)` — wrapper constructors
  // Return externref so typeof returns "object" (wrapper semantics).
  // Number/Boolean: box to externref via __box_number. String: already externref.
  const builtinName = builtinNameOverride ?? (ts.isIdentifier(expr.expression) ? expr.expression.text : undefined);
  if (builtinName !== undefined) {
    const ctorName = builtinName;
    if (ctorName === "Number" || ctorName === "String" || ctorName === "Boolean") {
      const args = expr.arguments ?? [];

      if (ctorName === "Number") {
        // new Number(x) → create real JS Number wrapper object via __new_Number host import
        // (typeof new Number(0) === "object", not "number")
        if (args.length >= 1) {
          // ToNumber(Symbol) throws TypeError (§7.1.4) — the wrapper ctor runs
          // ToNumber on its argument before boxing. Mirror the `Number(sym)`
          // call-path guard so `new Number(Symbol())` throws too (#1564).
          if (ctx.oracle.staticJsTypeOf(args[0]!) === "symbol") {
            const t = compileExpression(ctx, fctx, args[0]!);
            if (t !== null) fctx.body.push({ op: "drop" });
            emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a number");
            return { kind: "externref" };
          }
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        const newNumIdx = ensureLateImport(ctx, "__new_Number", [{ kind: "f64" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        const finalNumIdx = ctx.funcMap.get("__new_Number") ?? newNumIdx;
        if (finalNumIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalNumIdx });
        return { kind: "externref" };
      }

      if (ctorName === "String") {
        // new String(x) → create real JS String wrapper object via __new_String host import
        // (typeof new String("") === "object", not "string")
        if (args.length >= 1) {
          if (emitStringWrapperValue(ctx, fctx, args[0]!)) return { kind: "externref" };
        } else {
          const emptyStrResult = compileStringLiteral(ctx, fctx, "");
          if (!emptyStrResult) {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
        const newStrIdx = ensureLateImport(ctx, "__new_String", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        const finalStrIdx = ctx.funcMap.get("__new_String") ?? newStrIdx;
        if (finalStrIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalStrIdx });
        return { kind: "externref" };
      }

      if (ctorName === "Boolean") {
        // new Boolean(x) → JS Boolean wrapper object via __new_Boolean (typeof is "object").
        // Standalone uses shared ToBoolean so object and Symbol arguments remain truthy.
        if (ctx.standalone) {
          emitStandaloneBooleanConstructorValue(ctx, fctx, args);
        } else if (args.length >= 1) {
          // Host's f64 ABI preserves the existing Symbol-truthy special case.
          if (ctx.oracle.staticJsTypeOf(args[0]!) === "symbol") {
            const t = compileExpression(ctx, fctx, args[0]!);
            if (t !== null) fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "f64.const", value: 1 });
          } else if (!emitNewBooleanToBooleanArg(ctx, fctx, args[0]!)) {
            // (#4619) …and an object/string argument needs §7.1.2 ToBoolean,
            // not this f64 coercion, which INVERTS it. See the module.
            compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
          }
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        const newBoolIdx = ensureLateImport(ctx, "__new_Boolean", [{ kind: "f64" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        const finalBoolIdx = ctx.funcMap.get("__new_Boolean") ?? newBoolIdx;
        if (finalBoolIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalBoolIdx });
        return { kind: "externref" };
      }
    }
  }

  // Handle `new Error(msg)`, `new TypeError(msg)`, `new RangeError(msg)` — create real Error objects
  // via host import so .name, .message, .stack are correct and instanceof works.
  // Standalone fallback: the thrown value is just the message string (as before).
  if (builtinName !== undefined) {
    const ctorName = builtinName;
    // (#4394) `Test262Error` is deliberately NOT shadow-guarded: the harness
    // always declares it (sta.js) and the ctor-carrying lowering below exists
    // precisely to reconcile that. The intrinsic names ARE guarded — claiming
    // them by name built the INTRINSIC while the identifier read the user's
    // own binding, so `new TypeError()` under `function TypeError() {}` gave
    // `e.constructor === intrinsicTypeError`. Declining lets the ordinary
    // user-constructor path compile it.
    const isIntrinsicErrorName =
      ctorName === "Error" ||
      ctorName === "TypeError" ||
      ctorName === "RangeError" ||
      ctorName === "SyntaxError" ||
      ctorName === "URIError" ||
      ctorName === "EvalError" ||
      ctorName === "ReferenceError";
    // (#4394 standalone) The literal harness DECLARES `function Test262Error`
    // (sta.js). The standalone `$Error_struct` interception below returns a
    // value that FAILS the `$__fnctor_Test262Error` cast at the binding site —
    // the instance lands as NULL: `.message`/`.constructor` undefined,
    // `instanceof` null-derefs, and a thrown value renders "undefined". Decline
    // the claim for the declared-FUNCTION shape only (narrow helper), so the
    // ordinary user-fnctor lowering constructs it; the wrapped-harness `class
    // Test262Error extends Error` injection (#2902) keeps the interception.
    // Host mode is reconciled by emitTest262ErrorWithModuleCtor instead.
    const test262StandaloneUserFn =
      ctorName === "Test262Error" &&
      (ctx.wasi || ctx.standalone) &&
      errorCtorNameIsUserFunctionShadowed(expr, ctorName);
    // (#4394) A declined instance is an ordinary user struct — tell the #2962
    // exception renderer, or a thrown one renders "[object Object]" and the
    // merged report loses the "Test262Error: …" signature (the #4484 park).
    if (test262StandaloneUserFn) (ctx.exnRenderFnctorErrorNames ??= new Set()).add(ctorName);
    if (
      (isIntrinsicErrorName && !errorCtorNameIsUserShadowed(expr, ctorName)) ||
      (ctorName === "Test262Error" && !test262StandaloneUserFn)
    ) {
      const args = expr.arguments ?? [];
      // §7.1.17 step 3 — Error construction performs a strict ToString on a
      // supplied message. Native Symbols are represented as branded i32 ids,
      // so compiling one directly as externref would otherwise box it and let
      // the permissive general-purpose __any_to_string fallback continue.
      // Evaluate the argument (including side effects) before the catchable
      // TypeError, then stop this constructor path. Host mode keeps its real JS
      // constructor and therefore its existing coercion semantics.
      if (
        ctx.targetProfile.semanticProviders === "native-first" &&
        args.length >= 1 &&
        !isStaticUndefinedExpr(args[0]!, fctx) &&
        ctx.oracle.staticJsTypeOf(args[0]!) === "symbol"
      ) {
        // ArgumentListEvaluation completes before the constructor's message
        // ToString step. In particular, `new Error(Symbol(), later())` must
        // run `later()` (and let an abrupt completion from it win) before the
        // TypeError for the first argument. The shared single-operand helper
        // intentionally throws immediately, so this whole-argument form is
        // kept local to Error constructors.
        for (const arg of args) {
          const argType = compileExpression(ctx, fctx, arg);
          if (argType !== null) fctx.body.push({ op: "drop" });
        }
        emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a string");
        return { kind: "externref" };
      }
      // ArgumentListEvaluation completes before the constructor's message
      // ToString step. Keep the first value in a local while evaluating every
      // later argument in source order; otherwise a dynamic first message
      // (for example `const m: any = Symbol(); new Error(m, later())`) would
      // coerce/throw before `later()` ran, or skip `later()` entirely.
      const msgTmp = allocTempLocal(fctx, { kind: "externref" });
      if (args.length >= 1 && !isStaticUndefinedExpr(args[0]!, fctx)) {
        const resultType = compileExpression(ctx, fctx, args[0]!, {
          kind: "externref",
        });
        if (resultType && resultType.kind !== "externref") {
          coerceType(ctx, fctx, resultType, { kind: "externref" });
        }
      } else {
        // No message — push null externref (undefined message)
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "local.set", index: msgTmp });
      // (#5159) §20.5.1.1 step 4 — `InstallErrorCause(O, options)`. Argument 1
      // is the options bag; every later argument is surplus and stays dropped.
      //
      // Until now argument 1 was dropped with the rest, so `new Error(m, {cause})`
      // evaluated the bag (side effects DID run) and then threw the VALUE away —
      // `e.cause` was permanently absent. Keep it in a local instead and hand it
      // to `__error_install_cause` after construction (below).
      //
      // Scoped to the JS-host lowering: the native-first / standalone branches
      // below build an `$Error_struct`, which carries no `cause` slot at all, and
      // capturing there would move bytes in every standalone Error module for no
      // behavioural gain. Option-less constructions (`args.length < 2`) allocate
      // nothing and emit nothing new, so their bytes are unchanged.
      const hostErrorCtorPath =
        !(ctx.targetProfile.semanticProviders === "native-first" && isWasiErrorName(ctorName)) &&
        !((ctx.wasi || ctx.standalone) && ctorName === "Test262Error");
      const optionsTmp =
        hostErrorCtorPath && args.length >= 2 ? allocTempLocal(fctx, { kind: "externref" }) : undefined;
      for (let i = 1; i < args.length; i++) {
        if (i === 1 && optionsTmp !== undefined) {
          // The bag crosses UNCOERCED (#3481 cause 2): only the message takes
          // ToString; reducing the options struct to a primitive would destroy
          // the very `cause` reference this is here to preserve.
          const optType = compileExpression(ctx, fctx, args[i]!, { kind: "externref" });
          if (optType && optType.kind !== "externref") {
            coerceType(ctx, fctx, optType, { kind: "externref" });
          }
          fctx.body.push({ op: "local.set", index: optionsTmp });
          continue;
        }
        const argType = compileExpression(ctx, fctx, args[i]!);
        if (argType !== null) fctx.body.push({ op: "drop" });
      }
      // (#2969) §20.5.1.1 step 3 — `msg = ToString(message)` at CONSTRUCTION
      // time. In standalone/WASI the native `__new_<Name>` ctor stores its arg
      // verbatim (see error-types.ts), so `new Error(42).message` was the number
      // `42` (spec: `"42"`) and `String(new Error(42))` degraded to `"Error"`.
      // Do the ToString HERE at the user call site (null-guarded so argument-less
      // / `new Error(undefined)` still render the name alone) rather than inside
      // the SHARED ctor — the ctor is also lazily emitted for internal compiler
      // error paths (destructuring/coercion `TypeError`s), and pulling the
      // `__any_to_string` family into those emissions destabilised standalone
      // `any`-equality dispatch (the tag-5 value-eq gap deferred to #2580 M2 /
      // #3032). Host mode's `__new_<Name>` import does ToString in JS, so only
      // the native path needs this. Applies to both the WASI-error and
      // Test262Error branches below (both native, both standalone/WASI).
      if (
        ctx.targetProfile.semanticProviders === "native-first" &&
        args.length >= 1 &&
        !isStaticUndefinedExpr(args[0]!, fctx)
      ) {
        // Force `number_toString` before `__any_to_string` bakes so its number
        // arm renders a raw numeric message ("42") instead of degrading to
        // "[object Object]" (a module that only constructs `new Error(n)` never
        // otherwise pulls the number formatter). Must precede the ensure below.
        if (ctx.funcMap.get("number_toString") === undefined) {
          emitNativeNumberFormat(ctx, new Set(["number_toString"]));
        }
        // The Error constructor body can be minted before the caller that
        // supplies an `any`-typed Symbol. Register the native carrier before
        // baking the dynamic ref.test, so that callee-before-caller compilation
        // cannot leave the strict ToString arm absent.
        const symbolTypeIdx =
          ctx.targetProfile.semanticProviders === "native-first" && errorMessageMayCarrySymbol(ctx, args[0]!)
            ? ensureSymbolCarrier(ctx)
            : -1;
        const anyToStrIdx = ensureAnyToStringHelper(ctx);
        if (anyToStrIdx >= 0) {
          fctx.body.push(
            ...emitNullOrUndefinedMessageTest(ctx, msgTmp),
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              // undefined / null argument → keep null (renders name alone).
              then: [{ op: "ref.null.extern" }],
              // ToString(message): externref → anyref → __any_to_string
              // (ref $AnyString) → externref for the ctor's $message field.
              else: [
                // Dynamic `any` expressions can still carry a native Symbol
                // after the static guard above has declined. Check the branded
                // carrier immediately before the strict ToString call; the
                // throwing branch is stack-polymorphic and preserves all prior
                // argument evaluation.
                ...(symbolTypeIdx >= 0
                  ? [
                      { op: "local.get", index: msgTmp } as const,
                      { op: "any.convert_extern" } as const,
                      { op: "ref.test", typeIdx: symbolTypeIdx } as const,
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert a Symbol value to a string", {
                          forceInModuleCtor: true,
                        }),
                      } as const,
                    ]
                  : []),
                { op: "local.get", index: msgTmp },
                { op: "any.convert_extern" },
                { op: "call", funcIdx: anyToStrIdx },
                { op: "extern.convert_any" },
              ],
            },
            { op: "local.set", index: msgTmp },
          );
        }
      }
      fctx.body.push({ op: "local.get", index: msgTmp });
      releaseTempLocal(fctx, msgTmp);
      // (#1104 Phase 1) In WASI/standalone mode, the JS host is unavailable —
      // use a Wasm-native `__new_<Name>` function that builds a `$Error_struct`
      // instead of a `env.__new_<Name>` host import that would leave the
      // module unsatisfiable at instantiation time. JS-host mode is unchanged.
      const importName = `__new_${ctorName}`;
      // #1473 — standalone mode also has no JS host; build the Error in-module.
      if (ctx.targetProfile.semanticProviders === "native-first" && isWasiErrorName(ctorName)) {
        emitWasiErrorConstructor(ctx, ctorName, 1);
        const internalFuncIdx = ctx.funcMap.get(importName);
        if (internalFuncIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: internalFuncIdx });
        }
        return { kind: "externref" };
      }
      // (#2902) `Test262Error` is not a WASI builtin error, but the test262
      // harness declares it (`class Test262Error extends Error`) and `throw new
      // Test262Error(...)` appears in nearly every wrapped test. In standalone /
      // WASI mode the `__new_Test262Error` host import is unsatisfiable and
      // leaks the module out of host-free — yet the ctor is only reached on the
      // untaken failure path of a passing test. Build it natively as an
      // $Error_struct (tagged Error, name "Test262Error") so ~2,779 such tests
      // become host-free. JS-host mode keeps the host import (real Error).
      if ((ctx.wasi || ctx.standalone) && ctorName === "Test262Error") {
        emitStandaloneTest262Error(ctx, 1);
        const internalFuncIdx = ctx.funcMap.get(importName);
        if (internalFuncIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: internalFuncIdx });
        }
        return { kind: "externref" };
      }
      // (#4394) JS-host `new Test262Error(msg)` in a module that declares its
      // own `function Test262Error` — see test262-error-ctor.ts.
      if (emitTest262ErrorWithModuleCtor(ctx, fctx, expr, ctorName)) {
        return { kind: "externref" };
      }
      // (#5161) In the `nativeStrings` / `fast` lanes the message about to be
      // handed to the host ctor is a WasmGC `array i16` carrier, not a host
      // string. `_errorMessageToString` decodes it with the module's own
      // `__str_is_native` / `__str_to_extern` discriminator — but those exports
      // are otherwise emitted only when some UNRELATED part of the module needs
      // the boundary bridge. Measured 2026-08-28: `new Error("m")` threw
      // "Cannot convert object to primitive value" in a module that merely
      // constructs the error, and did not in one that also did
      // `String(e.message)` — the same source, two outcomes, decided by
      // unrelated content. Request the bridge here so the decode is available
      // whenever a host Error ctor is emitted. No-op in the default host lane
      // (`ctx.nativeStrings` false), which keeps that lane byte-identical.
      if (ctx.nativeStrings) ensureNativeStringBoundaryBridge(ctx);
      // Use host import to create a real Error object with correct .name/.message/.stack
      const funcIdx = ensureLateImport(
        ctx,
        importName,
        [{ kind: "externref" }], // message param
        [{ kind: "externref" }], // returns Error object
      );
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
      // (#5159) §20.5.1.1 step 4 — InstallErrorCause(O, options), applied to the
      // freshly constructed error. It is a SEPARATE import rather than a second
      // parameter on `__new_<Name>` on purpose: widening that signature would
      // re-emit every option-less `new Error(msg)` in every module. Here the
      // import (and the call) exist only in modules that actually pass options.
      //
      // V8's own InstallErrorCause cannot do this for us — a compiled object
      // literal reaches the host as an opaque WasmGC struct with no readable
      // `cause` property — so the install runs host-side through the shared
      // `_installErrorCause` helper that AggregateError / SuppressedError use.
      if (optionsTmp !== undefined) {
        const installIdx = ensureLateImport(
          ctx,
          "__error_install_cause",
          [{ kind: "externref" }, { kind: "externref" }], // (error, options)
          [{ kind: "externref" }], // returns the same error
        );
        flushLateImportShifts(ctx, fctx);
        if (installIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: optionsTmp }, { op: "call", funcIdx: installIdx });
        }
        releaseTempLocal(fctx, optionsTmp);
      }
      // If import not available (standalone), value is already on stack as externref message
      return { kind: "externref" };
    }
  }

  // Handle `new AggregateError(errors, message, options?)` (#844)
  // AggregateError takes (iterable, message, options?) — pass errors and message as externref
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "AggregateError") {
    const args = expr.arguments ?? [];
    // Compile errors argument (iterable) as externref
    if (args.length >= 1) {
      const errorsType = compileExpression(ctx, fctx, args[0]!, {
        kind: "externref",
      });
      if (errorsType && errorsType.kind !== "externref") {
        coerceType(ctx, fctx, errorsType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // Compile message argument as externref
    if (args.length >= 2) {
      // (#3481) §20.5.7.1 step 5a is `? ToString(message)`, which throws on a
      // Symbol (§7.1.17 step 3). A native symbol crosses to
      // `__new_AggregateError` as an opaque carrier, where the host-side
      // `String(message)` renders it as "Symbol()" instead of throwing — and
      // `String()` would not throw on a REAL symbol either, since §22.1.1.1
      // short-circuits to SymbolDescriptiveString. So the check has to happen
      // here, at the coercion site. `errors` is already evaluated above, which
      // is the §13.3.6.1 order the spec wants.
      if (emitSymbolOperandCoercionThrow(ctx, fctx, args[1]!, "string")) {
        return { kind: "externref" };
      }
      const msgType = compileExpression(ctx, fctx, args[1]!, {
        kind: "externref",
      });
      if (msgType && msgType.kind !== "externref") {
        coerceType(ctx, fctx, msgType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // Compile options argument as externref (for cause property)
    if (args.length >= 3) {
      const optsType = compileExpression(ctx, fctx, args[2]!, {
        kind: "externref",
      });
      if (optsType && optsType.kind !== "externref") {
        coerceType(ctx, fctx, optsType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // (#5161) Same native-string message decode as the plain Error family
    // above — `__new_AggregateError` reaches the SAME `_errorMessageToString`,
    // so it needs the same discriminator exports to be present.
    if (ctx.nativeStrings) ensureNativeStringBoundaryBridge(ctx);
    const funcIdx = ensureLateImport(
      ctx,
      "__new_AggregateError",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }
    return { kind: "externref" };
  }

  // Handle `new SuppressedError(error, suppressed, message, options?)` (#1634).
  // Spec §20.5.10.1: all four arguments are externref; `options.cause` is
  // installed via the dedicated `__new_SuppressedError` host import. The generic
  // 3-param extern-class path dropped `options` (no `cause`) and mishandled the
  // message coercion, so route through the dedicated import like AggregateError.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "SuppressedError") {
    const args = expr.arguments ?? [];
    for (let i = 0; i < 4; i++) {
      if (args.length > i) {
        const t = compileExpression(ctx, fctx, args[i]!, { kind: "externref" });
        if (t && t.kind !== "externref") {
          coerceType(ctx, fctx, t, { kind: "externref" });
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
    }
    // (#5161) Third caller of `_errorMessageToString` — kept consistent with
    // the Error / AggregateError sites so the three cannot drift. Unverifiable
    // today: this host has no `SuppressedError` (see the #5159 record).
    if (ctx.nativeStrings) ensureNativeStringBoundaryBridge(ctx);
    const funcIdx = ensureLateImport(
      ctx,
      "__new_SuppressedError",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }
    return { kind: "externref" };
  }

  // Handle `new Object()` — create an empty object (equivalent to `{}`).
  // (#1343) Previously this emitted `ref.null.extern`, but JS spec treats
  // `new Object()` as a real object: `Boolean(new Object()) === true`,
  // `(new Object()).hasOwnProperty(...) === false`, etc. Returning null
  // externref made the receiver fall through every host-import branch
  // expecting a real object, e.g. `Boolean(new Object())` returned `false`
  // because `__to_boolean(null) === 0`.
  //
  // Use `__new_plain_object` host import to produce a fresh empty object
  // with the ordinary `Object.prototype` prototype (#1525). `new Object()`
  // per §20.1.1.1 must inherit `Object.prototype` — using `__object_create(null)`
  // gave it a null prototype, so it had no `toString`/`valueOf` and any
  // ToPrimitive coercion (`==`, arithmetic, `String(...)`) threw
  // "Cannot convert object to primitive value" instead of producing
  // "[object Object]". Falls back to `ref.null.extern` only if the import
  // can't be registered.
  if (builtinName === "Object") {
    // (#3118) `new Object(v)` is spec-identical to `Object(v)` (§20.1.1.1:
    // return ToObject(v)). This arm previously ignored its arg and built an
    // empty object; delegate to the shared coercion so a primitive boxes to its
    // wrapper (an object passes through, null/undefined/none → fresh object).
    const r = emitObjectCoercion(ctx, fctx, expr.arguments ?? []);
    return r === null ? { kind: "externref" } : (r as ValType);
  }

  // Handle `new Proxy(target, handler)`.
  //
  // JS-host mode: delegate to the `__proxy_create(target, handler)` host import
  // (the host wraps the target in a real JS Proxy with the given handler).
  //
  // Standalone mode (#1100 Phase 1): there is no host Proxy, so route through the
  // Wasm-native `__proxy_create(target, handler)` emitted by `ensureObjectRuntime`
  // (object-runtime.ts `ensureProxyRuntime`). It reads the get/set/has/apply trap
  // closures off the handler object at runtime, allocates a `$Proxy` (subtype of
  // `$Object`), and the property-runtime front-guards (`__extern_get/set/has`)
  // dispatch reads/writes/has through the traps. Both modes share the same
  // `(target, handler) -> externref` signature, so the call site is uniform.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Proxy") {
    if (ctx.standalone || ctx.targetProfile.semanticProviders === "native-first") {
      const args = expr.arguments ?? [];
      // `ensureNativeProxyRuntime` mints `__proxy_create` before the argument
      // expressions are visited.  Pre-register the already-supported native
      // Symbol carrier whenever the target or handler can carry one, so the
      // construction-time object classifier has a stable carrier to test even
      // when this callee is compiled before its Symbol-producing caller.
      if (nativeProxyArgsMayCarrySymbol(ctx, args)) ensureSymbolCarrier(ctx);
      // Force the object runtime (which registers the native __proxy_create +
      // the trap dispatch helpers + the front-guards) before we look up the idx.
      ensureNativeProxyRuntime(ctx);
      const compileToExternref = (arg: ts.Expression | undefined): void => {
        if (arg === undefined) {
          fctx.body.push({ op: "ref.null.extern" });
          return;
        }
        // An OBJECT-LITERAL handler/target must lower to an OPEN `$Object`
        // (`__new_plain_object` + `__extern_set` per prop) so the runtime
        // `__proxy_create` can read the traps off the handler via `__extern_get`.
        // A closed typed struct (the default for an inline literal) hides its
        // fields from the open-object prop-map walk, so every trap reads null and
        // never fires. `compileObjectLiteralAsExternref` builds the open form —
        // the same shape a `const h: any = {…}` handler takes.
        if (ts.isObjectLiteralExpression(arg)) {
          const r = compileObjectLiteralAsExternref(ctx, fctx, arg);
          if (r === null) {
            // Builder unavailable — push undefined so the body stays valid.
            fctx.body.push({ op: "ref.null.extern" });
          }
          return;
        }
        // Inline functions must become the same module-owned closure values
        // used everywhere else in native semantics. Compiling them through the
        // generic externref expectation selects the callback/host lane and can
        // leave a null placeholder as the Proxy target. ProxyCreate then sees a
        // primitive even though the source value is callable. Keep the closure
        // live and cross only its canonical externref carrier here.
        const r =
          ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
            ? compileArrowAsClosure(ctx, fctx, arg)
            : compileExpression(ctx, fctx, arg, { kind: "externref" });
        if (r && r.kind !== "externref") {
          if (r.kind === "ref" || r.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          } else {
            coerceTypeImpl(ctx, fctx, r, { kind: "externref" });
          }
        } else if (!r) {
          // void result (shouldn't happen for a value arg) — push undefined.
          fctx.body.push({ op: "ref.null.extern" });
        }
      };

      if (args.some((arg) => ts.isSpreadElement(arg))) {
        const proxyArgs = flattenProxyArguments(args) ?? args;
        // Standalone/native-first uses the native GetIterator bridge for
        // non-literal sources (and for nested spreads retained by the
        // canonical one-level flattener). Register it before compiling any
        // such source so late helper registration cannot stale its calls.
        if (proxyArgs.some((arg) => ts.isSpreadElement(arg))) ensureNativeIteratorRuntime(ctx);
        const locals = emitExpandedProxyArguments(ctx, fctx, proxyArgs, (arg) => compileToExternref(arg));
        flushLateImportShifts(ctx, fctx);
        const proxyCreateIdx = ctx.funcMap.get("__proxy_create");
        if (proxyCreateIdx !== undefined) {
          fctx.body.push(
            { op: "local.get", index: locals.target },
            { op: "local.get", index: locals.handler },
            { op: "call", funcIdx: proxyCreateIdx },
          );
        } else {
          // Runtime not available (should not happen) — drop staged values and
          // leave the same undefined result as the ordinary defensive path.
          fctx.body.push(
            { op: "local.get", index: locals.target },
            { op: "drop" },
            { op: "local.get", index: locals.handler },
            { op: "drop" },
            { op: "ref.null.extern" },
          );
        }
        for (const local of [
          locals.done,
          locals.iterator,
          locals.source,
          locals.value,
          locals.count,
          locals.handler,
          locals.target,
        ]) {
          releaseTempLocal(fctx, local);
        }
        return { kind: "externref" };
      }

      // §28.2.1.1 starts with ArgumentListEvaluation.  Keep the first two
      // values alive while every remaining argument is evaluated and dropped;
      // validation in __proxy_create must not run until that whole list has
      // completed (a later abrupt extra argument wins).
      const targetLocal = allocTempLocal(fctx, { kind: "externref" });
      const handlerLocal = allocTempLocal(fctx, { kind: "externref" });
      compileToExternref(args[0]);
      fctx.body.push({ op: "local.set", index: targetLocal });
      compileToExternref(args[1]);
      fctx.body.push({ op: "local.set", index: handlerLocal });
      for (let i = 2; i < args.length; i++) {
        compileToExternref(args[i]);
        fctx.body.push({ op: "drop" });
      }

      // Argument compilation may add late imports.  Flush their shifts before
      // resolving the already-minted defined function index.
      flushLateImportShifts(ctx, fctx);
      const proxyCreateIdx = ctx.funcMap.get("__proxy_create");
      if (proxyCreateIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "local.get", index: handlerLocal });
        fctx.body.push({ op: "call", funcIdx: proxyCreateIdx });
      } else {
        // Runtime not available (should not happen) — drop args, push undefined.
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "local.get", index: handlerLocal });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
      releaseTempLocal(fctx, handlerLocal);
      releaseTempLocal(fctx, targetLocal);
      return { kind: "externref" };
    }
    const args = expr.arguments ?? [];
    if (args.length >= 1) {
      const compileHostProxyArg = (arg: ts.Expression | undefined): void => {
        if (arg === undefined) {
          fctx.body.push({ op: "ref.null.extern" });
          return;
        }
        const result = compileExpression(ctx, fctx, arg);
        if (result && result.kind !== "externref") {
          if (result.kind === "ref" || result.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          } else {
            coerceTypeImpl(ctx, fctx, result, { kind: "externref" });
          }
        } else if (!result) {
          fctx.body.push({ op: "ref.null.extern" });
        }
      };

      if (args.some((arg) => ts.isSpreadElement(arg))) {
        const proxyArgs = flattenProxyArguments(args) ?? args;
        // The host provider exposes the same iterator protocol as for-of. Do
        // the registration up front for any source that remains dynamic, then
        // resolve its indices after each source expression adds late imports.
        if (proxyArgs.some((arg) => ts.isSpreadElement(arg))) {
          ensureLateImport(ctx, "__iterator", [{ kind: "externref" }], [{ kind: "externref" }]);
          ensureLateImport(ctx, "__iterator_next", [{ kind: "externref" }], [{ kind: "i32" }, { kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
        }
        const locals = emitExpandedProxyArguments(ctx, fctx, proxyArgs, (arg) => compileHostProxyArg(arg));

        // Emit the provider only after ArgumentListEvaluation has completed.
        let proxyIdx = ensureLateImport(
          ctx,
          "__proxy_create",
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);
        proxyIdx = ctx.funcMap.get("__proxy_create") ?? proxyIdx;
        if (proxyIdx !== undefined) {
          fctx.body.push(
            { op: "local.get", index: locals.target },
            { op: "local.get", index: locals.handler },
            { op: "call", funcIdx: proxyIdx },
          );
        } else {
          fctx.body.push(
            { op: "local.get", index: locals.target },
            { op: "drop" },
            { op: "local.get", index: locals.handler },
            { op: "drop" },
            { op: "ref.null.extern" },
          );
        }
        for (const local of [
          locals.done,
          locals.iterator,
          locals.source,
          locals.value,
          locals.count,
          locals.handler,
          locals.target,
        ]) {
          releaseTempLocal(fctx, local);
        }
        return { kind: "externref" };
      }

      // Evaluate the target and handler once, retain them while all extra
      // arguments run in source order, then invoke the host provider.  This
      // mirrors the native-first path and preserves a later abrupt completion.
      const targetLocal = allocTempLocal(fctx, { kind: "externref" });
      const handlerLocal = allocTempLocal(fctx, { kind: "externref" });
      compileHostProxyArg(args[0]);
      fctx.body.push({ op: "local.set", index: targetLocal });
      compileHostProxyArg(args[1]);
      fctx.body.push({ op: "local.set", index: handlerLocal });
      for (let i = 2; i < args.length; i++) {
        compileHostProxyArg(args[i]);
        fctx.body.push({ op: "drop" });
      }

      // Emit call to __proxy_create(target, handler) -> externref.
      let proxyIdx = ensureLateImport(
        ctx,
        "__proxy_create",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      proxyIdx = ctx.funcMap.get("__proxy_create") ?? proxyIdx;
      if (proxyIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "local.get", index: handlerLocal });
        fctx.body.push({ op: "call", funcIdx: proxyIdx });
      } else {
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "local.get", index: handlerLocal });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }

      releaseTempLocal(fctx, handlerLocal);
      releaseTempLocal(fctx, targetLocal);

      return { kind: "externref" };
    }
    // No arguments — `new Proxy()`. Per §28.2.1.1 the missing target/handler
    // are `undefined`, which are not objects, so construction throws TypeError.
    // Route through __proxy_create(null, null) so the runtime raises it (#2180).
    {
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "ref.null.extern" });
      const proxyIdx = ensureLateImport(
        ctx,
        "__proxy_create",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (proxyIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: proxyIdx });
      }
    }
    return { kind: "externref" };
  }

  // Handle `new Function(...)`.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Function") {
    const args = expr.arguments ?? [];
    // (#2924) Constant param list + body → compile-away to a real AOT callable
    // (global scope, no capture). Dynamic bodies fall through to the no-op stub
    // below (the Tier-2 interpreter, #2928, handles them). Guarded on the
    // GLOBAL `Function` intrinsic (a local shadow keeps the legacy stub path).
    const staticFn = isGlobalFunctionIdentifier(expr.expression, ctx.checker)
      ? tryStaticNewFunction(ctx, fctx, args)
      : undefined;
    if (staticFn !== undefined) return staticFn;
    // (#2960) Dynamic body (non-constant args). No longer a silent no-op stub:
    //  - JS-host mode → route to the meta-circular runtime-eval shim
    //    (`__extern_eval`, global scope) so the constructed function actually
    //    works — fixes the ~119 host Function-ctor test262 cluster.
    //  - standalone/wasi (no host) → emit a source-located warning + a callable
    //    value that throws catchably at CALL time (construction still succeeds,
    //    so a program that never invokes it keeps working).
    if (isGlobalFunctionIdentifier(expr.expression, ctx.checker)) {
      const hostEval = emitDynamicNewFunctionHostEval(ctx, fctx, args);
      if (hostEval !== undefined) return hostEval;
      if (noJsHost(ctx)) {
        const runtimeEval = emitStandaloneDynamicFunctionRuntime(ctx, fctx, args);
        if (runtimeEval !== undefined) return runtimeEval;
        return emitStandaloneDynamicFunctionStub(ctx, fctx, expr, args) as ValType;
      }
    }
    // Legacy fallback (e.g. a local `Function` shadow, or JS-host with
    // nativeStrings where the shim path is unavailable): evaluate args for side
    // effects and return the historical null-value stub.
    for (const arg of args) {
      const argResult = compileExpression(ctx, fctx, arg);
      if (argResult) {
        fctx.body.push({ op: "drop" });
      }
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle `new Date()`, `new Date(ms)`, `new Date(y, m, d, ...)` — native Date struct
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Date") {
    const dateTypeIdx = ensureDateStruct(ctx);
    const args = expr.arguments ?? [];

    if (args.length === 0) {
      // (#1483) Under --target wasi, route `new Date()` (no args) to
      // clock_time_get via the __wasi_date_now helper (registered up front in
      // registerWasiImports).
      if (ctx.wasi && ctx.funcMap.has("__wasi_date_now")) {
        fctx.body.push({
          op: "call",
          funcIdx: ctx.funcMap.get("__wasi_date_now")!,
        });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" });
        fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx });
        return { kind: "ref", typeIdx: dateTypeIdx };
      }
      // (#2164) Pure standalone has no wall clock — emit the Unix epoch (0)
      // directly instead of leaking the unsatisfiable env::__date_now host
      // import (which made `new Date()` a hard instantiate failure standalone,
      // breaking unrelated Date tests). See the matching Date.now() fallback in
      // expressions/calls.ts.
      if (ctx.standalone === true) {
        emitStandaloneDateTimestamp(ctx, fctx);
        fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx });
        return { kind: "ref", typeIdx: dateTypeIdx };
      }
      const dateNowIdx = ensureLateImport(ctx, "__date_now", [], [{ kind: "f64" }]);
      if (dateNowIdx !== undefined) {
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: dateNowIdx });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" });
      } else {
        fctx.body.push({ op: "i64.const", value: 0n });
      }
      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx });
      return { kind: "ref", typeIdx: dateTypeIdx };
    }

    if (args.length === 1) {
      // new Date(ms) — millisecond timestamp.
      //
      // (#1344) Detect NaN input and store a sentinel i64 so subsequent getter
      // calls (getDay, getHours, getTime, …) can return NaN per spec
      // (`new Date(NaN).getTime() → NaN`). Without this, `i64.trunc_sat_f64_s`
      // saturates NaN to 0 and the Date silently behaves like the epoch.
      //
      // (#1343) TimeClip per §21.4.1.31: if !isFinite(ms) or abs(ms) > 8.64e15,
      // return NaN. Both NaN and out-of-range get the sentinel. ±Infinity is
      // out-of-range (abs > 8.64e15), so the single magnitude check covers it.
      //
      // (#2164) new Date(str) — §21.4.2.1: a String value is parsed as if by
      // Date.parse. Route a statically-string-typed arg through the pure-Wasm
      // __date_parse helper (yields an f64 ms, NaN on failure), then fall
      // through the same TimeClip path below. Gated to standalone / WASI for the
      // same reason as Date.parse (host strings + lazy helper wiring trip the
      // late-import shift class #2043); host keeps the prior ToNumber(str)→NaN.
      if ((ctx.standalone || ctx.wasi) && isStringTypedArg(ctx, args[0]!)) {
        emitNativeDateParse(ctx);
        const argType = compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
        if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__date_parse")! });
      } else if (
        !ctx.standalone &&
        !ctx.wasi &&
        isStringTypedArg(ctx, args[0]!) &&
        ctx.funcMap.has("__date_parse_host")
      ) {
        // (#2678) HOST mode: a String arg is parsed as if by Date.parse
        // (§21.4.2.1) — delegate to the JS `Date.parse` host import (registered
        // up-front by collectDateParseHostImports, no #2043 late-import shift).
        const argType = compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
        if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
        fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__date_parse_host")! });
      } else if (
        !ctx.standalone &&
        !ctx.wasi &&
        isDynamicMaybeStringArg(ctx, args[0]!) &&
        ctx.funcMap.has("__date_parse_host")
      ) {
        // (#4616) §21.4.2.1 for a DYNAMIC single arg (any/unknown/union-with-
        // string): ToPrimitive yields a String → parse as if by Date.parse;
        // anything else → ToNumber(ms). The static-type arms above can't see
        // this (an `any` holding "Wed, 21 Oct 2015 …" ToNumbered to NaN, which
        // silently dropped cookie's `expires` on every parsed Set-Cookie).
        // Branch at runtime on `__typeof_string`; both callees are registered
        // up-front (collector / addUnionImports), so no late-import shift can
        // strand the arm indices.
        const argType = compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
        if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
        addUnionImports(ctx);
        flushLateImportShifts(ctx, fctx);
        const typeofStringIdx = ctx.funcMap.get("__typeof_string");
        const unboxNumberIdx = ctx.funcMap.get("__unbox_number");
        const parseHostIdx = ctx.funcMap.get("__date_parse_host")!;
        if (typeofStringIdx === undefined || unboxNumberIdx === undefined) {
          coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
        } else {
          const extLocal = allocTempLocal(fctx, { kind: "externref" });
          fctx.body.push({ op: "local.tee", index: extLocal });
          fctx.body.push({ op: "call", funcIdx: typeofStringIdx });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "f64" } },
            then: [
              { op: "local.get", index: extLocal },
              { op: "call", funcIdx: parseHostIdx },
            ],
            else: [
              { op: "local.get", index: extLocal },
              { op: "call", funcIdx: unboxNumberIdx },
            ],
          });
          releaseTempLocal(fctx, extLocal);
        }
      } else if (tryEmitStandaloneDateCtorValueArg(ctx, fctx, args[0]!, dateTypeIdx)) {
        // (#5156) §21.4.2.2 step 4 — [[DateValue]] fast path + ToPrimitive.
      } else {
        compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      }
      const msLocal = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: msLocal });
      // isInvalid = (ms != ms) || (abs(ms) > 8.64e15)
      // ms != ms is true iff ms is NaN (covers NaN)
      fctx.body.push({ op: "local.get", index: msLocal });
      fctx.body.push({ op: "f64.ne" });
      fctx.body.push({ op: "local.get", index: msLocal });
      fctx.body.push({ op: "f64.abs" });
      fctx.body.push({ op: "f64.const", value: 8.64e15 });
      fctx.body.push({ op: "f64.gt" });
      fctx.body.push({ op: "i32.or" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i64" } },
        then: [{ op: "i64.const", value: -9223372036854775808n }],
        else: [{ op: "local.get", index: msLocal }, { op: "i64.trunc_sat_f64_s" }],
      });
      releaseTempLocal(fctx, msLocal);
      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx });
      return { kind: "ref", typeIdx: dateTypeIdx };
    }

    // new Date(year, month, day?, hours?, minutes?, seconds?, ms?)
    // JS months are 0-indexed. Day defaults to 1, rest default to 0.
    {
      const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);

      // (#1343) Track whether any arg is NaN or non-finite. If so, the resulting
      // Date is Invalid (§21.4.2.1 MakeDate / TimeClip step on non-finite).
      // We OR-accumulate an i32 flag and stash the f64 value before trunc.
      const nonFiniteLocal = allocTempLocal(fctx, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: nonFiniteLocal });

      const checkNonFinite = (f64Local: number) => {
        // flag = flag | (v != v) | (abs(v) == +Inf)
        // We treat ±Inf as "non-finite enough" too — abs(v) > 8.64e15 is sufficient.
        fctx.body.push({ op: "local.get", index: nonFiniteLocal });
        fctx.body.push({ op: "local.get", index: f64Local });
        fctx.body.push({ op: "local.get", index: f64Local });
        fctx.body.push({ op: "f64.ne" }); // NaN check
        fctx.body.push({ op: "i32.or" });
        fctx.body.push({ op: "local.get", index: f64Local });
        fctx.body.push({ op: "f64.abs" });
        fctx.body.push({ op: "f64.const", value: 8.64e15 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        fctx.body.push({ op: "local.set", index: nonFiniteLocal });
      };

      // Compile year
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const yearF64Local = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: yearF64Local });
      checkNonFinite(yearF64Local);
      fctx.body.push({ op: "i64.trunc_sat_f64_s" });
      const yearLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: yearLocal });
      releaseTempLocal(fctx, yearF64Local);

      // Compile month (0-indexed) + 1 for civil algorithm
      compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
      const monthF64Local = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: monthF64Local });
      checkNonFinite(monthF64Local);
      releaseTempLocal(fctx, monthF64Local);
      fctx.body.push({ op: "i64.trunc_sat_f64_s" });
      fctx.body.push({ op: "i64.const", value: 1n });
      fctx.body.push({ op: "i64.add" });
      const monthLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: monthLocal });

      // (#1343) For the remaining optional args, also accumulate the non-finite
      // flag when the arg is present.
      const compileTimePart = (argIdx: number, defaultI64: bigint, localKind: ValType) => {
        if (args.length > argIdx) {
          compileExpression(ctx, fctx, args[argIdx]!, { kind: "f64" });
          const f64L = allocTempLocal(fctx, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: f64L });
          checkNonFinite(f64L);
          releaseTempLocal(fctx, f64L);
          fctx.body.push({ op: "i64.trunc_sat_f64_s" });
        } else {
          fctx.body.push({ op: "i64.const", value: defaultI64 });
        }
        const local = allocTempLocal(fctx, localKind);
        fctx.body.push({ op: "local.set", index: local });
        return local;
      };

      const dayLocal = compileTimePart(2, 1n, { kind: "i64" });
      const hoursLocal = compileTimePart(3, 0n, { kind: "i64" });
      const minutesLocal = compileTimePart(4, 0n, { kind: "i64" });
      const secondsLocal = compileTimePart(5, 0n, { kind: "i64" });
      const msLocal = compileTimePart(6, 0n, { kind: "i64" });

      // Handle year 0-99 mapping to 1900-1999 (JS Date quirk)
      // if (0 <= year <= 99) year += 1900
      fctx.body.push(
        { op: "local.get", index: yearLocal },
        { op: "i64.const", value: 0n },
        { op: "i64.ge_s" },
        { op: "local.get", index: yearLocal },
        { op: "i64.const", value: 99n },
        { op: "i64.le_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: yearLocal },
            { op: "i64.const", value: 1900n },
            { op: "i64.add" },
            { op: "local.set", index: yearLocal },
          ],
        },
      );

      // Call days_from_civil(year, month, day) → i64 days
      fctx.body.push(
        { op: "local.get", index: yearLocal },
        { op: "local.get", index: monthLocal },
        { op: "local.get", index: dayLocal },
        { op: "call", funcIdx: daysFromCivilIdx },
      );

      // timestamp = days * 86400000 + hours * 3600000 + minutes * 60000 + seconds * 1000 + ms
      fctx.body.push(
        { op: "i64.const", value: 86400000n },
        { op: "i64.mul" },
        { op: "local.get", index: hoursLocal },
        { op: "i64.const", value: 3600000n },
        { op: "i64.mul" },
        { op: "i64.add" },
        { op: "local.get", index: minutesLocal },
        { op: "i64.const", value: 60000n },
        { op: "i64.mul" },
        { op: "i64.add" },
        { op: "local.get", index: secondsLocal },
        { op: "i64.const", value: 1000n },
        { op: "i64.mul" },
        { op: "i64.add" },
        { op: "local.get", index: msLocal },
        { op: "i64.add" },
      );

      // (#1343) TimeClip §21.4.1.31: if any arg was NaN/non-finite, or
      // abs(ts) > 8.64e15, the time is invalid. The nonFiniteLocal flag covers
      // the f64 NaN/Inf cases (i64.trunc_sat_f64_s would otherwise saturate them
      // silently); the magnitude check covers in-range f64 values that still
      // produce an out-of-range timestamp.
      const tsResultLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: tsResultLocal });
      fctx.body.push(
        { op: "local.get", index: nonFiniteLocal },
        { op: "local.get", index: tsResultLocal },
        { op: "f64.convert_i64_s" },
        { op: "f64.abs" },
        { op: "f64.const", value: 8.64e15 },
        { op: "f64.gt" },
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i64" } },
          then: [{ op: "i64.const", value: -9223372036854775808n }],
          else: [{ op: "local.get", index: tsResultLocal }],
        },
      );
      releaseTempLocal(fctx, tsResultLocal);
      releaseTempLocal(fctx, nonFiniteLocal);

      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx });

      releaseTempLocal(fctx, msLocal);
      releaseTempLocal(fctx, secondsLocal);
      releaseTempLocal(fctx, minutesLocal);
      releaseTempLocal(fctx, hoursLocal);
      releaseTempLocal(fctx, dayLocal);
      releaseTempLocal(fctx, monthLocal);
      releaseTempLocal(fctx, yearLocal);

      return { kind: "ref", typeIdx: dateTypeIdx };
    }
  }

  // Handle `new TypedArray(n)` — TypedArray constructors (Uint8Array, Int32Array, Float64Array, etc.)
  // TypedArrays are fixed-length numeric arrays. Native Uint8Array uses the
  // byte-oriented i8_byte vec; other typed arrays stay on the legacy f64
  // representation for now.
  if (ts.isIdentifier(expr.expression)) {
    const typedArrayName = expr.expression.text;
    const TYPED_ARRAY_NAMES = new Set([
      "Int8Array",
      "Uint8Array",
      "Uint8ClampedArray",
      "Int16Array",
      "Uint16Array",
      "Int32Array",
      "Uint32Array",
      "Float32Array",
      "Float64Array",
      // (#838) BigInt views — i64-element storage via `typedArrayVecStorage`.
      "BigInt64Array",
      "BigUint64Array",
    ]);
    // (#838 gate — fable-dev-5) The BigInt views take the native i64-vec path
    // ONLY in standalone/wasi. In js-host they stay host globals: a native
    // i64-element vec is not a valid receiver for the host `Atomics.wait/notify`
    // bridge (index-validation over an i64 vec doesn't throw the spec RangeError
    // first — the merge_group regression on `Atomics/*/bigint/*` tests), and the
    // SharedArrayBuffer-backed construction needs the real host BigInt64Array.
    // Numeric views ride native f64/packed vecs in js-host and DO pass Atomics
    // because the bridge handles those element kinds; extending it to i64 is the
    // follow-up. Mirrors the dual-mode principle (host lane → host paths).
    const isBigIntView838 = typedArrayName === "BigInt64Array" || typedArrayName === "BigUint64Array";
    if (TYPED_ARRAY_NAMES.has(typedArrayName) && (!isBigIntView838 || ctx.wasi || ctx.standalone)) {
      // (#2593) Standalone/WASI packs integer views into i8/i16/i32 storage
      // (Int8/Uint8/Uint8Clamped→i8_byte, Int16/Uint16→i16_byte,
      // Int32/Uint32→i32_byte); host/gc and the float views keep f64.
      // `typedArrayVecStorage` is the single source of truth so the
      // count-constructor's backing vec matches the read / byteLength paths.
      // Before #2593 only native Uint8Array packed (everything else f64), which
      // left `new Int32Array(n)` on an f64 vec while the byteLength reader cast
      // to i32_byte — a runtime type mismatch (read 0 / illegal cast).
      const storage = typedArrayVecStorage(ctx, typedArrayName);
      const elemWasm: ValType = storage.type;
      const elemKey = storage.key;
      const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemWasm);
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const args = expr.arguments ?? [];
      const resultType: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
      const finishNativeTypedArray = (): ValType => {
        emitHostTypedArrayCarrierRegistration(ctx, fctx, typedArrayName, resultType);
        return resultType;
      };

      // (#3097) JS-host lane `new <TA>(buffer[, byteOffset[, length]])`:
      // route through the host construct bridge (real host TypedArray view
      // over the canonical host ArrayBuffer) instead of the numeric-length
      // fallback below, which coerced the buffer struct to NaN → a length-0
      // vec. Standalone keeps the native `$__ta_view` paths (B1/B2 below).
      if (hostTaBufferArgSymName(ctx, args) !== undefined) {
        const hostTa = emitHostTaBufferConstruct(ctx, fctx, typedArrayName, args);
        if (hostTa) return hostTa;
      }

      if (args.length === 0) {
        // new TypedArray() → empty array, length 0
        fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
        return finishNativeTypedArray();
      }

      if (args.length === 1) {
        // Check if argument is a numeric literal or expression (size constructor)
        // vs an array/iterable (copy constructor)
        const argType = ctx.checker.getTypeAtLocation(args[0]!);
        const argSym = argType.getSymbol?.();
        // #1654 — `new Uint8Array(arrayBuffer)` views the buffer's bytes. The
        // ArrayBuffer/DataView is backed by an i32_byte vec; copy the bytes
        // into this TypedArray's backing array. Must precede the
        // size-constructor path (an ArrayBuffer is NOT a numeric length).
        //
        // #1670 — only in no-JS-host mode. The byte-buffer view path emits an
        // unconditional `ref.cast` to the native `i32_byte` vec. In JS-host
        // mode an ArrayBuffer / SharedArrayBuffer is NOT lowered to that vec
        // (e.g. `new SharedArrayBuffer(n)` has no native struct), so the cast
        // traps with `illegal cast` before any spec validation runs — this
        // regressed 28 Atomics negative tests built on
        // `new Int32Array(new SharedArrayBuffer(...))`. Host mode already
        // handles the buffer arg correctly via the runtime, so skip the
        // native view path there.
        const argSymName = argSym?.name;
        // (#3054 B1) Build a SHARED-BACKING `$__ta_view` that refs the buffer's
        // vec (not a copy) so sibling views / DataViews observe writes. Gated on
        // `noJsHost` (standalone/WASI): the native `i32_byte` vec representation
        // of ArrayBuffer/DataView only exists in the host-free lane. In JS-host
        // mode an ArrayBuffer is a host object (no native vec), so the recover
        // `any.convert_extern` + `ref.cast` would trap — host mode routes buffers
        // through the runtime instead (#1670). This replaces the former copy loop
        // (`emitTypedArrayFromByteBuffer`) that CLONED the bytes into a fresh
        // backing array, which broke sibling/DataView observability.
        const taViewOk =
          noJsHost(ctx) &&
          (argSymName === "ArrayBuffer" || argSymName === "SharedArrayBuffer" || argSymName === "DataView");
        if (taViewOk && !ts.isNumericLiteral(args[0]!)) {
          const viewResult = emitTaViewConstruct(ctx, fctx, args[0]!, expr.expression.text, (e, h) =>
            compileExpression(ctx, fctx, e, h),
          );
          if (viewResult) return viewResult;
        }
        const isArrayLike =
          argSym?.name === "Array" ||
          ((argType.flags & ts.TypeFlags.Object) !== 0 &&
            argSym?.name !== undefined &&
            TYPED_ARRAY_NAMES.has(argSym.name));

        if (!isArrayLike || ts.isNumericLiteral(args[0]!)) {
          // new TypedArray(n) → fixed-size array of length n, all zeros
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
          fctx.body.push({ op: "i32.trunc_sat_f64_s" });
          const sizeLocal = allocLocal(fctx, `__ta_size_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "local.tee", index: sizeLocal }); // length = n
          fctx.body.push({ op: "local.get", index: sizeLocal });
          fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
          return finishNativeTypedArray();
        }

        // new TypedArray(arrayLike) — copy from source array
        // Compile source, then copy elements
        const srcResult = compileExpression(ctx, fctx, args[0]!);
        if (srcResult && (srcResult.kind === "ref" || srcResult.kind === "ref_null")) {
          const srcTypeIdx = (srcResult as { typeIdx: number }).typeIdx;
          const srcTypeDef = ctx.mod.types[srcTypeIdx];
          // Check if source is a vec struct
          if (
            srcTypeDef?.kind === "struct" &&
            srcTypeDef.fields[0]?.name === "length" &&
            srcTypeDef.fields[1]?.name === "data"
          ) {
            const srcVecLocal = allocLocal(fctx, `__ta_src_${fctx.locals.length}`, srcResult);
            fctx.body.push({ op: "local.set", index: srcVecLocal });
            // Get source length
            fctx.body.push({ op: "local.get", index: srcVecLocal });
            fctx.body.push({
              op: "struct.get",
              typeIdx: srcTypeIdx,
              fieldIdx: 0,
            });
            const lenLocal = allocLocal(fctx, `__ta_len_${fctx.locals.length}`, { kind: "i32" });
            fctx.body.push({ op: "local.tee", index: lenLocal });
            // Create new array of that length
            fctx.body.push({ op: "local.get", index: lenLocal });
            fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
            const dstDataLocal = allocLocal(fctx, `__ta_dst_${fctx.locals.length}`, {
              kind: "ref",
              typeIdx: arrTypeIdx,
            });
            fctx.body.push({ op: "local.set", index: dstDataLocal });

            // If source and dest have the same array type, use array.copy
            const srcArrTypeIdx = getArrTypeIdxFromVec(ctx, srcTypeIdx);
            if (srcArrTypeIdx === arrTypeIdx) {
              fctx.body.push({ op: "local.get", index: dstDataLocal });
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.get", index: srcVecLocal });
              fctx.body.push({
                op: "struct.get",
                typeIdx: srcTypeIdx,
                fieldIdx: 1,
              });
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.get", index: lenLocal });
              fctx.body.push({
                op: "array.copy",
                dstTypeIdx: arrTypeIdx,
                srcTypeIdx: arrTypeIdx,
              });
            } else if (srcArrTypeIdx >= 0) {
              const srcArrDef = ctx.mod.types[srcArrTypeIdx];
              const dstArrDef = ctx.mod.types[arrTypeIdx];
              if (srcArrDef?.kind === "array" && dstArrDef?.kind === "array") {
                const srcDataLocal = allocLocal(fctx, `__ta_src_data_${fctx.locals.length}`, {
                  kind: "ref",
                  typeIdx: srcArrTypeIdx,
                });
                const copyIndexLocal = allocLocal(fctx, `__ta_copy_i_${fctx.locals.length}`, { kind: "i32" });
                fctx.body.push({ op: "local.get", index: srcVecLocal });
                fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx: 1 });
                fctx.body.push({ op: "local.set", index: srcDataLocal });
                fctx.body.push({ op: "i32.const", value: 0 });
                fctx.body.push({ op: "local.set", index: copyIndexLocal });

                const srcGetOp =
                  srcArrDef.element.kind === "i8"
                    ? "array.get_u"
                    : srcArrDef.element.kind === "i16"
                      ? "array.get_s"
                      : "array.get";
                // (#2934 1c) The element-conversion matrix keys on the READ
                // value's stack kind (packed i8/i16 widen to i32 via get_u/_s).
                // The old matrix only knew f64↔int, so an EXTERNREF source
                // element (`new Uint8Array([102])` where the literal compiled
                // to an any[] externref vec) flowed uncoerced into the packed
                // `array.set` — "array.set[2] expected i32, found array.get of
                // externref" (the toBase64/`__cb_0` invalid-Wasm cluster). An
                // externref element now unboxes (ToNumber) and truncates to
                // integer storage; packed stores truncate width for free.
                const srcReadKind =
                  srcArrDef.element.kind === "i8" || srcArrDef.element.kind === "i16" ? "i32" : srcArrDef.element.kind;
                const dstStoreKind =
                  dstArrDef.element.kind === "i8" || dstArrDef.element.kind === "i16" ? "i32" : dstArrDef.element.kind;
                let convertInstrs: Instr[];
                if (dstStoreKind === "i64") {
                  // (#838) BigInt view (BigInt64Array/BigUint64Array) copy target.
                  // A boxed element (`new BigInt64Array([1n, 2n])` — the literal
                  // widens to an `any[]`/externref vec) goes through §7.1.13
                  // ToBigInt (`__to_bigint`), NOT ToNumber — the elements are JS
                  // bigints and unboxing them as f64 would trap / lose the value.
                  // An already-i64 source (a `bigint[]` vec) is stored directly
                  // (identity); the same-array-type fast path (array.copy) above
                  // handles the common i64→i64 case, so this arm only fires for a
                  // heterogeneous source (externref) or a width-mismatched i64 vec.
                  if (srcReadKind === "externref") {
                    addUnionImports(ctx);
                    const toBigintIdx = ctx.funcMap.get("__to_bigint");
                    convertInstrs = toBigintIdx !== undefined ? [{ op: "call", funcIdx: toBigintIdx }] : [];
                  } else if (srcReadKind === "i64") {
                    convertInstrs = [];
                  } else if (srcReadKind === "f64") {
                    // Numeric source into a BigInt view — ToBigInt over a Number
                    // throws TypeError per spec; we approximate with a truncating
                    // convert (rare/degenerate path).
                    convertInstrs = [{ op: "i64.trunc_sat_f64_s" }];
                  } else {
                    convertInstrs = [{ op: "i64.extend_i32_s" }];
                  }
                } else if (srcReadKind === "externref" && dstStoreKind !== "externref") {
                  // ToNumber the boxed element via the single coercion table
                  // (#2108 — coercionPlan's externref→i32 row is exactly
                  // unbox + trunc_sat; externref→f64 is the bare unbox).
                  // Integer storage then truncates width on the packed store.
                  addUnionImports(ctx);
                  const plan = coercionPlan(
                    { kind: "externref" },
                    { kind: dstStoreKind === "f64" ? "f64" : "i32" },
                    {
                      boxNumberIdx: ctx.funcMap.get("__box_number") ?? null,
                      unboxNumberIdx: ctx.funcMap.get("__unbox_number") ?? null,
                    },
                  );
                  convertInstrs = plan?.instrs ?? [];
                } else if (srcReadKind === "f64" && dstStoreKind !== "f64" && dstStoreKind !== "externref") {
                  convertInstrs = [{ op: "i32.trunc_sat_f64_s" }];
                } else if (srcReadKind !== "f64" && srcReadKind !== "externref" && dstStoreKind === "f64") {
                  convertInstrs = [{ op: "f64.convert_i32_u" }];
                } else {
                  convertInstrs = [];
                }

                fctx.body.push({
                  op: "block",
                  blockType: { kind: "empty" },
                  body: [
                    {
                      op: "loop",
                      blockType: { kind: "empty" },
                      body: [
                        { op: "local.get", index: copyIndexLocal },
                        { op: "local.get", index: lenLocal },
                        { op: "i32.ge_u" },
                        { op: "br_if", depth: 1 },
                        { op: "local.get", index: dstDataLocal },
                        { op: "local.get", index: copyIndexLocal },
                        { op: "local.get", index: srcDataLocal },
                        { op: "local.get", index: copyIndexLocal },
                        { op: srcGetOp, typeIdx: srcArrTypeIdx },
                        ...convertInstrs,
                        { op: "array.set", typeIdx: arrTypeIdx },
                        { op: "local.get", index: copyIndexLocal },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: copyIndexLocal },
                        { op: "br", depth: 0 },
                      ],
                    },
                  ],
                });
              }
            }
            // Build result vec struct
            fctx.body.push({ op: "local.get", index: lenLocal });
            fctx.body.push({ op: "local.get", index: dstDataLocal });
            fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
            return finishNativeTypedArray();
          }
        }
        // Fallback: treat argument as length
        // (source was already compiled and is on stack — drop it and recompile as f64)
        if (srcResult) fctx.body.push({ op: "drop" });
        compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        const fallbackSize = allocLocal(fctx, `__ta_fsz_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.tee", index: fallbackSize });
        fctx.body.push({ op: "local.get", index: fallbackSize });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
        return finishNativeTypedArray();
      }

      // (#3054 B2) `new <TA>(buffer, byteOffset[, length])` — windowed
      // shared-backing view. Build a `$__ta_view` with the byteOffset field
      // populated (B1 pinned it 0) so `a[i]` addresses `byteOffset + i*width`
      // into the SHARED buffer (sibling/DataView windows mutually observable).
      // Standalone/WASI only — host-mode buffers are host objects, not native
      // vecs (#1670). MUST match `inferTaViewType`'s multi-arg gate so the
      // local's type and the constructed value agree.
      if (noJsHost(ctx) && args.length >= 2 && !ts.isNumericLiteral(args[0]!)) {
        // (#1930) Query the type-oracle boundary, not the raw checker — this
        // also keeps the gate in lock-step with `inferTaViewType` (variables.ts),
        // which resolves the buffer arg through the same oracle.
        const winArgSymName = ctx.oracle.builtinReceiverOf(args[0]!);
        if (winArgSymName === "ArrayBuffer" || winArgSymName === "SharedArrayBuffer" || winArgSymName === "DataView") {
          const winResult = emitTaViewConstructWindowed(
            ctx,
            fctx,
            args[0]!,
            args[1]!,
            args[2],
            expr.expression.text,
            (e, h) => compileExpression(ctx, fctx, e, h),
          );
          if (winResult) return winResult;
        }
      }

      // new TypedArray() with multiple args — shouldn't happen per spec, but handle gracefully
      // Treat like new TypedArray(0)
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return finishNativeTypedArray();
    }
  }
  return NEW_GLOBAL_FALLTHROUGH;
}

/**
 * The Error-family constructors, all of which §20.5.1.1 / §20.5.6.1.1 define to
 * behave identically whether invoked with `new` or as a plain function: "When
 * `Error` is called as a function rather than as a constructor, it creates and
 * initializes a new Error object" — the [[Construct]] and [[Call]] behaviours
 * are the same clause.
 */
const CALLABLE_ERROR_CTORS = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "AggregateError",
  "SuppressedError",
  "Test262Error",
]);

/**
 * `Error(msg)` / `TypeError(msg)` / … called WITHOUT `new`.
 *
 * The `new` form is handled by {@link tryCompileBuiltinGlobalNew}; the bare-call
 * form previously matched no arm at all and fell through to the generic builtin
 * path, which yields `ref.null.extern`. The result was a silent, diagnostic-free
 * `null` where an Error object belonged, so the very next `.message` read
 * null-trapped. Real code hits this constantly: React's production bundle raises
 * every one of its errors as `Error(formatProdErrorMessage(...))`, so a compiled
 * React threw an opaque wasm exception instead of the real error for
 * `Children.only`, `cloneElement(null)` and friends.
 *
 * Because the spec defines [[Call]] and [[Construct]] identically here, this
 * delegates to the exact same emitter rather than duplicating it — a
 * CallExpression and a NewExpression expose the same `.expression`/`.arguments`
 * shape that emitter reads. A shadowed binding (`class Error {}`, a local, an
 * import) is left alone: those are not the ambient global.
 *
 * Returns the emitter's result when it handles the call; `undefined` otherwise
 * (caller continues its dispatch ladder).
 */
export function tryCompileErrorCtorCallWithoutNew(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (expr.questionDotToken) return undefined;
  const callee = expr.expression;
  if (!ts.isIdentifier(callee)) return undefined;
  if (!CALLABLE_ERROR_CTORS.has(callee.text)) return undefined;
  if (ctx.classSet.has(callee.text)) return undefined;
  if (!resolvesToAmbientGlobal(ctx, callee)) return undefined;

  const result = tryCompileBuiltinGlobalNew(ctx, fctx, expr as unknown as ts.NewExpression);
  return result === NEW_GLOBAL_FALLTHROUGH ? undefined : result;
}

/**
 * (#4732) `WeakSet(...)` is not callable — §23.4.1.1 step 1 requires a
 * TypeError when `NewTarget` is undefined. The generic identifier-call path
 * used to answer with the undefined sentinel instead, so both `WeakSet()` and
 * `WeakSet([])` silently succeeded. Evaluate arguments first (including their
 * side effects), then emit the same real TypeError instance used by the other
 * call-without-`new` guards.
 *
 * The ambient-global and class checks are important: a user binding named
 * `WeakSet` must retain ordinary call semantics, just like the Error and Date
 * guards above.
 *
 * (#5151) The same clause governs the other three keyed collections
 * (§24.1.1.1 / §24.2.1.1 / §24.3.1.1 step 1), which were never added here — so
 * `Map()`, `Set()` and `WeakMap()` each returned an object instead of throwing.
 * They are table-driven off the one set below rather than three copies.
 */
const CALL_WITHOUT_NEW_COLLECTION_CTORS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

export function tryCompileCollectionCtorCallWithoutNew(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (expr.questionDotToken) return undefined;
  const callee = expr.expression;
  if (!ts.isIdentifier(callee) || !CALL_WITHOUT_NEW_COLLECTION_CTORS.has(callee.text)) return undefined;
  if (ctx.classSet.has(callee.text)) return undefined;
  if (!resolvesToAmbientGlobal(ctx, callee)) return undefined;

  for (const arg of expr.arguments ?? []) {
    const argResult = compileExpression(ctx, fctx, arg);
    if (argResult) fctx.body.push({ op: "drop" });
  }
  emitThrowTypeError(ctx, fctx, `Constructor ${callee.text} requires 'new'`);
  return { kind: "externref" };
}

/** `__date_format_string` mode selector for §21.4.4.41 `toString`. */
const DATE_FORMAT_MODE_TO_STRING = 2;

/**
 * (#4640 D7) `Date()` / `Date(1970, 1)` / `Date(anything)` called WITHOUT `new`.
 *
 * §21.4.2.1 step 1: "If NewTarget is undefined, then let now be the time value
 * ... return ToDateString(now)". Every argument is IGNORED — not ToNumber'd, not
 * inspected — and the result is a **String**, never a Date object. The `new`
 * form (handled by {@link tryCompileBuiltinGlobalNew}) is a different clause
 * entirely, which is why this cannot delegate the way the Error-family arm does.
 *
 * ## Why this is a CRASH fix, not a cosmetic one
 *
 * Before this arm, a bare `Date(...)` matched nothing and fell through to the
 * generic builtin-identifier terminal, which yields `ref.null.extern`. The
 * checker types the call `string` (lib.es5's `DateConstructor` call signature),
 * so nothing downstream re-checked it: `Date.parse(Date())` handed a NULL
 * externref to the native `__date_parse`, whose first act is
 * `any.convert_extern` + `ref.cast` to the string struct — an **illegal cast
 * trap**, not a wrong answer (`built-ins/Date/S15.9.2.1_A2`). The static type
 * being right while the runtime value is `null` is exactly what made this
 * invisible: `typeof Date()` folds to `"string"` off the checker type, so the
 * obvious probe agrees with the spec while the emitted value does not.
 *
 * ## Shape
 *
 * The same time value the zero-arg `new Date()` arm uses
 * ({@link emitStandaloneDateTimestamp} standalone, `__date_now` on host), fed to
 * the SAME `__date_format_string` formatter mode `d.toString()` compiles to, so
 * the two spellings cannot drift — one formatter, as in `date-any-to-string.ts`.
 *
 * ## Declines (absent-not-wrong)
 *
 * - No native strings (`ctx.nativeStrings` false / no `$NativeString` type):
 *   the formatter builds a native string and there is nothing to build it into.
 *   Host mode keeps its prior behaviour rather than getting a half-answer.
 * - A shadowed `Date` (a local, a `class Date {}`, an import) is not the ambient
 *   global and is left to the ordinary call lane.
 *
 * Arguments are still COMPILED and dropped: ArgumentListEvaluation runs before
 * [[Call]], so `Date(sideEffect())` must observe the side effect even though the
 * value is discarded.
 */
export function tryCompileDateCallWithoutNew(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (expr.questionDotToken) return undefined;
  const callee = expr.expression;
  if (!ts.isIdentifier(callee) || callee.text !== "Date") return undefined;
  if (ctx.classSet.has("Date")) return undefined;
  if (!resolvesToAmbientGlobal(ctx, callee)) return undefined;
  if (!ctx.nativeStrings || ctx.nativeStrTypeIdx < 0) return undefined;

  for (const arg of expr.arguments ?? []) {
    const argResult = compileExpression(ctx, fctx, arg);
    if (argResult) fctx.body.push({ op: "drop" });
  }

  const fmtIdx = ensureDateFormatStringHelper(ctx);
  if (ctx.wasi && ctx.funcMap.has("__wasi_date_now")) {
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__wasi_date_now")! });
    fctx.body.push({ op: "i64.trunc_sat_f64_s" });
  } else if (ctx.standalone === true) {
    emitStandaloneDateTimestamp(ctx, fctx);
  } else {
    const dateNowIdx = ensureLateImport(ctx, "__date_now", [], [{ kind: "f64" }]);
    if (dateNowIdx === undefined) {
      fctx.body.push({ op: "i64.const", value: 0n });
    } else {
      flushLateImportShifts(ctx, fctx);
      fctx.body.push({ op: "call", funcIdx: dateNowIdx });
      fctx.body.push({ op: "i64.trunc_sat_f64_s" });
    }
  }
  fctx.body.push({ op: "i32.const", value: DATE_FORMAT_MODE_TO_STRING });
  fctx.body.push({ op: "call", funcIdx: fmtIdx });
  return { kind: "ref", typeIdx: ctx.nativeStrTypeIdx };
}
