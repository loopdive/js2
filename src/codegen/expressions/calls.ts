// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Call expression compilation: direct calls, optional calls, closure calls,
 * property method calls, IIFEs, and conditional callees.
 */
import { ts, forEachChild } from "../../ts-api.js";
import {
  isBigIntType,
  isBooleanType,
  isBooleanWrapperType,
  isExternalDeclaredClass,
  isGeneratorType,
  isNumberType,
  isNumberWrapperType,
  isPromiseType,
  isStringType,
  isStringWrapperType,
  isSymbolType,
  isVoidType,
} from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { compileArrayMethodCall, compileArrayPrototypeCall, resolveArrayInfo } from "../array-methods.js";
import { classMemberFuncKey } from "../class-member-keys.js"; // (#1983) collision-free class-member funcMap keys
import { reserveClosedMethodDispatch } from "../closed-method-dispatch.js";
import { ensureObjVecBuilders, ensureObjectRuntime } from "../object-runtime.js";
import {
  emitStandalonePromiseReject,
  emitStandalonePromiseResolve,
  emitStandalonePromiseThen,
  isStandalonePromiseActive,
  type StandalonePromiseThenCallback,
} from "../async-scheduler.js";
import {
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  compileArrowAsClosure,
  compileArrowFunction,
  getOrCreateFuncRefWrapperTypes,
} from "../closures.js";
import { popBody, pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import { allocLocal, allocTempLocal, getLocalType, releaseTempLocal } from "../context/locals.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "../context/types.js";
import {
  addFuncType,
  addImport,
  addStringConstantGlobal,
  addStringImports,
  addUnionImports,
  ensureExnTag,
  ensureI32Condition,
  getArrTypeIdxFromVec,
  getOrRegisterRefCellType,
  getOrRegisterVecType,
  hoistLetConstWithTdz,
  hoistVarDeclarations,
  nativeStringType,
  resolveWasmType,
} from "../index.js";
import {
  compileArrayConstructorCall,
  compileObjectLiteralAsExternref,
  compileSymbolCall,
  resolveComputedKeyExpression,
  resolvePropertyNameText,
} from "../literals.js";
import { tryEmitJsonParseLiteral, tryEmitJsonStringifyStatic } from "../json-standalone.js";
import { emitJsonParsePrimitive, emitJsonQuoteString } from "../json-runtime.js";
import {
  compileObjectDefineProperties,
  compileObjectDefineProperty,
  compileObjectKeysOrValues,
  compilePropertyIntrospection,
} from "../object-ops.js";
import { emitArrayIsArrayExternrefPredicate, emitNullCheckThrow, typeErrorThrowInstrs } from "../property-access.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, valTypesMatch, VOID_RESULT } from "../shared.js";
import { compileStatement, hoistFunctionDeclarations } from "../statements.js";
import {
  emitSetExtrasArgv,
  ensureArgcGlobal,
  ensureExtrasArgvGlobal,
  maybeSetArgcForKnownCall,
} from "../statements/nested-declarations.js";
import { compileNativeStringMethodCall, compileStringLiteral, emitBoolToString } from "../string-ops.js";
import { tryCompileNodeProcessCall } from "../node-process-api.js";
import { isSupportedBuiltinStaticProperty, resolveBuiltinNamespaceValueName } from "../builtin-static-globals.js";
import {
  defaultValueInstrs,
  emitGuardedFuncRefCast,
  emitGuardedRefCast,
  pushDefaultValue,
  pushParamSentinel,
} from "../type-coercion.js";
import {
  compileConsoleCall,
  compileDateMethodCall,
  compileMathCall,
  ensureDateDaysFromCivilHelper,
  wasiAllocStringData,
} from "./builtins.js";
import { tryCompileTemporalMethodCall, tryCompileTemporalStaticCall } from "../temporal-native.js";
import {
  compileCallableElementAccessCall,
  compileCallablePropertyCall,
  compileClosureCall,
  compileGetterCallable,
  compileObjectPrototypeFallback,
  tryExternClassMethodOnAny,
} from "./calls-closures.js";
import { compileOptionalCallExpression } from "./calls-optional.js";
import { tryStaticEvalInline } from "./eval-inline.js";
import { compileExternMethodCall, compileSpreadCallArgs, emitLazyProtoGet } from "./extern.js";
import {
  compileStandaloneRegExpConstructor,
  isGlobalRegExpIdentifier,
  tryCompileStandaloneRegExpExec,
  tryCompileStandaloneRegExpTest,
} from "../regexp-standalone.js";
import {
  emitThrowTypeError,
  getFuncParamTypes,
  getWasmFuncReturnType,
  isEffectivelyVoidReturn,
  noJsHost,
  wasmFuncReturnsVoid,
} from "./helpers.js";
import {
  tryJsxRuntimeCall,
  tryNamespaceNonCallable,
  tryObjectCoercionCall,
  tryRegExpConstructorCall,
} from "./calls-guards.js";
import { analyzeTdzAccessByPos, emitLocalTdzCheck, emitStaticTdzThrow } from "./identifiers.js";
import { emitUndefined, ensureLateImport, flushLateImportShifts, shiftLateImportIndices } from "./late-imports.js";
import { ensureSymbolRegistry } from "../symbol-native.js";
import { resolveStructName } from "./misc.js";
import { compileSuperElementMethodCall, compileSuperMethodCall } from "./new-super.js";
import {
  emitNativeGeneratorToVec,
  nativeGeneratorInfoForForOfSubject,
  tryCompileNativeGeneratorMethodCall,
} from "../generators-native.js";
import {
  ensureNativeStringExternBridge,
  ensureStrToCharVecHelper,
  ensureTextEncodingHelpers,
  stringConstantExternrefInstrs,
} from "../native-strings.js";
import { emitVariadicStringConcat, hostStringRepr, nativeStringRepr } from "../builtin-scaffold.js";
import { emitArrayBufferSlice, emitDataViewAccessor, isDataViewAccessor } from "../dataview-native.js";
import {
  getLinearU8Buffer,
  getLinearU8ParamIndicesForCall,
  sourceParamCountFromExpanded,
  wasmParamIndexForSourceParam,
} from "../linear-uint8-signatures.js";

/**
 * Known built-in global class/object names that compile to ref.null.extern
 * via compileIdentifier's graceful fallback. These need __get_builtin to
 * resolve the real JS object for host-delegated calls (method dispatch,
 * getOwnPropertyDescriptor, etc.).
 */
const BUILTIN_CLASS_NAMES = new Set([
  "Object",
  "Array",
  "Function",
  "Symbol",
  "Proxy",
  "Reflect",
  "Math",
  "BigInt",
  "JSON",
  "Date",
  "RegExp",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Promise",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "Atomics",
  "Iterator",
  "Map",
  "Set",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "String",
  "Number",
  "Boolean",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/**
 * Statically evaluate `ToBoolean(expr)` for descriptor flag literals.
 * Per §6.2.6 ToPropertyDescriptor each attribute flag is ToBoolean-coerced —
 * `configurable: 123` / `'x'` / `{}` / `[]` are all truthy. Used by the
 * Object.create/defineProperties static-expansion fast path so the emitted
 * descriptor flags reflect the spec rather than degrading every non-`true`
 * literal to `false`. Returns `undefined` when the value isn't statically
 * resolvable (caller should fall back to the runtime path).
 */
/**
 * (#2076) Compile an `Object.assign(target, ...sources)` argument, pushing an
 * externref onto the stack. Under `--target standalone`, the native
 * `__object_assign` reads each operand by `ref.test $Object` and iterates its
 * `$PropEntry` table; a *closed-struct* literal fails that test, so its
 * properties are silently dropped and `Object.keys` on the result sees nothing
 * (the bug). The struct path is what `compileObjectLiteral` picks for a literal
 * argument whose TS contextual type — here `Object.assign`'s generic signature
 * resolves it to a CONCRETE object type, not `any` — so the open-`$Object`
 * diversion (literals.ts) never fires.
 *
 * Fix: when the argument is a *plain data-property / spread* object literal
 * (no accessors, methods, or computed/symbol keys — the same shapes the
 * `$Object` builder accepts at literals.ts:870-874), build it directly as a
 * native `$Object` via `compileObjectLiteralAsExternref` so `__object_assign`
 * recognises it. Any other argument (identifiers, calls, accessor-bearing
 * literals) keeps the ordinary `compileExpression` path. Standalone-only — host
 * / WASI mode owns the `__object_assign` JS import and is untouched.
 */
function compileObjectAssignArg(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  if (
    ctx.standalone &&
    ts.isObjectLiteralExpression(arg) &&
    arg.properties.length > 0 &&
    arg.properties.every(
      (p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p),
    ) &&
    arg.properties.every((p) => ts.isSpreadAssignment(p) || resolvePropertyNameText(ctx, p) !== undefined)
  ) {
    const objResult = compileObjectLiteralAsExternref(ctx, fctx, arg);
    if (objResult) {
      if (objResult.kind !== "externref") coerceType(ctx, fctx, objResult, { kind: "externref" });
      return;
    }
    // fall through to the ordinary path if the $Object builder declined.
  }
  const t = compileExpression(ctx, fctx, arg, { kind: "externref" });
  if (t && t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
}

function staticToBoolean(expr: ts.Expression): boolean | undefined {
  while (
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isParenthesizedExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = (
      expr as
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.ParenthesizedExpression
        | ts.SatisfiesExpression
        | ts.NonNullExpression
    ).expression;
  }
  switch (expr.kind) {
    case ts.SyntaxKind.TrueKeyword:
      return true;
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return false;
    case ts.SyntaxKind.NumericLiteral:
      return Number((expr as ts.NumericLiteral).text) !== 0;
    case ts.SyntaxKind.BigIntLiteral: {
      const t = (expr as ts.BigIntLiteral).text;
      return BigInt(t.slice(0, -1)) !== 0n;
    }
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return (expr as ts.StringLiteralLike).text.length > 0;
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.ClassExpression:
      return true;
    case ts.SyntaxKind.Identifier: {
      const text = (expr as ts.Identifier).text;
      if (text === "undefined") return false;
      if (text === "NaN") return false;
      if (text === "Infinity") return true;
      return undefined;
    }
    case ts.SyntaxKind.VoidExpression:
      return false;
    case ts.SyntaxKind.PrefixUnaryExpression: {
      const u = expr as ts.PrefixUnaryExpression;
      if (u.operator === ts.SyntaxKind.ExclamationToken) {
        const inner = staticToBoolean(u.operand);
        return inner === undefined ? undefined : !inner;
      }
      if (u.operator === ts.SyntaxKind.MinusToken || u.operator === ts.SyntaxKind.PlusToken) {
        if (u.operand.kind === ts.SyntaxKind.NumericLiteral) {
          return Number((u.operand as ts.NumericLiteral).text) !== 0;
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Coerce an already-pushed Number.prototype method argument (toFixed /
 * toPrecision / toExponential digits) to f64. These runtime helpers take an
 * f64 argument, but the source argument may be i32 (boolean) or externref/ref
 * (e.g. a Symbol). Per §21.1.3.x the argument runs through ToInteger, which
 * begins with ToNumber — and ToNumber(Symbol) throws TypeError (§7.1.4).
 * Routing externref/ref through coerceType funnels Symbols into the throwing
 * ToNumber path (#1564) and keeps the value stack f64-typed for the
 * subsequent local.tee/local.set into an f64 local.
 */
function coerceNumberMethodArgToF64(ctx: CodegenContext, fctx: FunctionContext, argType: ValType | null): void {
  if (!argType) return;
  if (argType.kind === "f64") return;
  if (argType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }
  coerceType(ctx, fctx, argType, { kind: "f64" });
}

/**
 * (#1735) Normalise an f64 local holding a Number.prototype.{toExponential,
 * toPrecision} digits/precision argument so that NaN becomes 0, matching
 * ToIntegerOrInfinity (§7.1.5 / §21.1.3.{3,5} step 5: NaN → +0).
 *
 * The `number_toExponential` / `number_toPrecision` runtime helpers overload
 * NaN as their "no argument supplied" sentinel (the codegen no-arg branch
 * pushes `f64.const NaN`). Without this normalisation an *explicit* NaN
 * argument (`(1).toExponential(NaN)`, `(1).toExponential(0/0)`) carries the
 * same bits as the sentinel and is wrongly handled as no-arg. Rewriting the
 * local in place — `local = (d == d) ? d : 0` via `f64.eq` self-compare (false
 * only for NaN) feeding `select` — keeps the subsequent range-check and call
 * reading a spec-correct value with no host-side change.
 */
function normalizeNaNToZero(fctx: FunctionContext, f64Local: number): void {
  fctx.body.push({ op: "local.get", index: f64Local }); // val-if-true: d
  fctx.body.push({ op: "f64.const", value: 0 }); // val-if-false: 0
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "f64.eq" }); // condition: d == d (0 only when NaN)
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "local.set", index: f64Local });
}

/**
 * Look up closure info for a variable by checking if its local type
 * is a ref to a known closure struct. Handles cases like:
 *   var f = function() { ... }; f();
 *   const f = makeAdder(5); f.call(null, 10);
 */
function resolveClosureInfoFromLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
): ClosureInfo | undefined {
  const localIdx = fctx.localMap.get(name);
  if (localIdx === undefined) return undefined;
  const localType =
    localIdx < fctx.params.length ? fctx.params[localIdx]?.type : fctx.locals[localIdx - fctx.params.length]?.type;
  if (localType && (localType.kind === "ref" || localType.kind === "ref_null")) {
    return ctx.closureInfoByTypeIdx.get(localType.typeIdx);
  }
  return undefined;
}

/**
 * (#1324 primitives slice) Try to emit `JSON.stringify(arg)` for a
 * statically-typed primitive value without the `JSON_stringify` JS host call.
 *
 * Supported shapes (all leave an externref string on the stack):
 *   - `null`       → string `"null"`
 *   - `undefined`  → undefined (ref.null.extern) — per spec §25.5.4.2,
 *                    `JSON.stringify(undefined)` returns `undefined`,
 *                    not the string "null"
 *   - `boolean`    → string `"true"` or `"false"`
 *   - `number`     → result of `number_toString(value)` when available, except
 *                    `NaN`/`±Infinity` serialize to the string `"null"`
 *                    per §25.5.4.2 step 9
 *
 * Deferred to #1353 (full architect spec):
 *   - `string`  — needs runtime JSON-escape helper
 *   - `bigint`  — needs runtime check + TypeError throw
 *   - object / array — needs WasmGC shape walking
 *
 * Returns the emitted type and pushes a string/undefined value onto the wasm
 * stack when emission succeeded; returns `undefined` (no stack effect) otherwise so
 * the caller can fall through to the `JSON_stringify` host import.
 */
function tryEmitJsonStringifyPrimitive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
): ValType | null | undefined {
  let argType: ts.Type;
  try {
    argType = ctx.checker.getTypeAtLocation(arg);
  } catch {
    return undefined;
  }
  const flags = argType.flags;

  // (#2166) TypeScript models the `boolean` primitive as the union
  // `true | false`, so a `boolean`-typed value (e.g. `const b: boolean = x`)
  // carries the `Union` flag and was wrongly skipped by the ambiguous-mask
  // early-return below — so `JSON.stringify(b)` refused in standalone instead
  // of serializing to "true"/"false". A `BooleanLike` type (the boolean union
  // or a boolean literal) is unambiguously serializable, so recognize it before
  // the mask. Guard on `intrinsicName === "boolean"` for the union so we don't
  // misfire on a mixed union that merely contains a boolean member.
  const isBooleanType =
    (flags & ts.TypeFlags.BooleanLiteral) !== 0 ||
    ((flags & ts.TypeFlags.Boolean) !== 0 &&
      (argType as ts.Type & { intrinsicName?: string }).intrinsicName === "boolean");

  // Skip ambiguous shapes (any/unknown/union/object/intersection) — let
  // the caller fall through to the host import which handles them. The
  // `boolean` union is the documented exception (see above).
  const ambiguousMask =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Union |
    ts.TypeFlags.Intersection |
    ts.TypeFlags.Object |
    ts.TypeFlags.NonPrimitive |
    ts.TypeFlags.TypeParameter;
  if (!isBooleanType && flags & ambiguousMask) return undefined;

  // null literal
  if (flags & ts.TypeFlags.Null) {
    const t = compileExpression(ctx, fctx, arg);
    if (t) fctx.body.push({ op: "drop" } as Instr);
    return compileStringLiteral(ctx, fctx, "null", arg);
  }

  // undefined / void — `JSON.stringify(undefined)` returns the JS
  // `undefined` value (not the string "undefined" or "null"). Emit via
  // the existing `emitUndefined` helper so JS sees the right value
  // (host-mode pulls it from `__get_undefined`; standalone mode falls
  // back to `ref.null.extern` which JS sees as `null` — acceptable per
  // the existing helper's documented contract).
  if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
    const t = compileExpression(ctx, fctx, arg);
    if (t) fctx.body.push({ op: "drop" } as Instr);
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  // boolean / true / false
  if (flags & ts.TypeFlags.BooleanLike) {
    const argResult = compileExpression(ctx, fctx, arg, { kind: "i32" });
    if (argResult === null) {
      // Failed to compile the arg as i32 — abandon (no stack effect from this fn).
      return undefined;
    }
    const savedBody = fctx.body;
    fctx.body = [];
    const trueType = compileStringLiteral(ctx, fctx, "true", arg);
    const trueBody = fctx.body;
    fctx.body = [];
    const falseType = compileStringLiteral(ctx, fctx, "false", arg);
    const falseBody = fctx.body;
    fctx.body = savedBody;
    const resultType = trueType ?? falseType ?? ({ kind: "externref" } as ValType);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: trueBody,
      else: falseBody,
    } as Instr);
    return resultType;
  }

  // number / numeric literal
  if (flags & ts.TypeFlags.NumberLike) {
    const numToStrIdx = ctx.funcMap.get("number_toString");
    if (numToStrIdx === undefined) return undefined;
    const savedBody = fctx.body;
    fctx.body = [];
    const nullType = compileStringLiteral(ctx, fctx, "null", arg);
    const nullBody = fctx.body;
    fctx.body = savedBody;
    const resultType = (ctx.standalone || ctx.wasi ? nullType : ({ kind: "externref" } as ValType)) ?? {
      kind: "externref",
    };

    const argResult = compileExpression(ctx, fctx, arg, { kind: "f64" });
    if (argResult === null) return undefined;

    // Stack: [f64 value]. Save to a local so we can both test for
    // finiteness AND pass to number_toString in the finite branch.
    const valLocal = allocTempLocal(fctx, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: valLocal } as Instr);

    // isFinite check: x - x === 0. NaN-NaN and ±Infinity-±Infinity both
    // produce NaN, which fails the equality. Finite values produce 0.
    fctx.body.push({ op: "local.get", index: valLocal } as Instr);
    fctx.body.push({ op: "local.get", index: valLocal } as Instr);
    fctx.body.push({ op: "f64.sub" } as Instr);
    fctx.body.push({ op: "f64.const", value: 0 } as Instr);
    fctx.body.push({ op: "f64.eq" } as Instr);

    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: [
        { op: "local.get", index: valLocal } as Instr,
        { op: "call", funcIdx: numToStrIdx } as Instr,
        ...(ctx.standalone || ctx.wasi
          ? ([
              { op: "any.convert_extern" } as Instr,
              { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
            ] as Instr[])
          : []),
      ],
      else: nullBody,
    } as Instr);
    releaseTempLocal(fctx, valLocal);
    return resultType;
  }

  // string / String — standalone/WASI have no JSON_stringify host import.
  // Emit the pure-Wasm `__json_quote_string` runtime helper (#1599 Phase 2):
  // it scans the runtime string's UTF-16 code units and produces a
  // JSON-quoted $NativeString per §25.5.4.3 QuoteJSONString. In JS-host mode
  // we fall through to the JSON_stringify import (it observes replacer/space
  // and toJSON, which the helper does not).
  if ((ctx.standalone || ctx.wasi) && flags & ts.TypeFlags.StringLike) {
    const argResult = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (argResult === null) return undefined;
    if (argResult.kind !== "externref") {
      coerceType(ctx, fctx, argResult, { kind: "externref" });
    }
    const quoteIdx = emitJsonQuoteString(ctx);
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__json_quote_string") ?? quoteIdx } as Instr);
    // __json_quote_string returns a native string ref (matches compileStringLiteral
    // in nativeStrings mode), so downstream string ops (===, return) see the same
    // type they expect rather than an over-wrapped externref.
    return nativeStringType(ctx);
  }

  // bigint / unhandled — fall through to the host import. Full
  // pure-Wasm support tracked under #1353.
  return undefined;
}

/**
 * (#1599 Phase 2) Try to emit `JSON.parse(s)` for a runtime string-typed
 * argument in standalone / WASI mode, where there is no `env::JSON_parse`
 * host import. Handles the JSON *primitive* slice — number / `true` / `false`
 * / `null` — via the pure-Wasm `__json_parse_primitive` helper, which boxes
 * the parsed value into the host-free `$AnyValue` tagged union.
 *
 * Returns the emitted `ref $AnyValue` type (so the downstream AnyValue→
 * primitive coercion path unboxes it to number / boolean as the consumer
 * requires) and pushes the value; returns `undefined` (no stack effect) when
 * the argument is not a runtime string — objects, arrays, and string *values*
 * still fall through to the #1599 refusal (they need the full Phase 2 codec).
 *
 * Spec: ECMA-262 §25.5.2 `JSON.parse` / `ParseJSON`, ECMA-404.
 */
function tryEmitJsonParsePrimitive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  call: ts.CallExpression,
  arg: ts.Expression,
): ValType | undefined {
  if (!(ctx.standalone || ctx.wasi)) return undefined;
  // A property/element read on the result — `JSON.parse(s).x` / `JSON.parse(s)[i]`
  // — means the parsed value is consumed as an object/array, which the primitive
  // slice does not produce. Leave those to the #1599 refusal (full Phase 2 codec).
  const parent = call.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.expression === call) ||
    (ts.isElementAccessExpression(parent) && parent.expression === call)
  ) {
    return undefined;
  }
  let argType: ts.Type;
  try {
    argType = ctx.checker.getTypeAtLocation(arg);
  } catch {
    return undefined;
  }
  // Only a string-typed argument routes here. `JSON.parse(<string literal>)`
  // is folded earlier by tryEmitJsonParseLiteral; this handles the runtime
  // string-value case.
  if ((argType.flags & ts.TypeFlags.StringLike) === 0) return undefined;

  const argResult = compileExpression(ctx, fctx, arg, { kind: "externref" });
  if (argResult === null) return undefined;
  if (argResult.kind !== "externref") {
    coerceType(ctx, fctx, argResult, { kind: "externref" });
  }
  const parseIdx = emitJsonParsePrimitive(ctx);
  flushLateImportShifts(ctx, fctx);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__json_parse_primitive") ?? parseIdx } as Instr);
  return { kind: "ref", typeIdx: ctx.anyValueTypeIdx };
}

/**
 * Check if a node (function body) uses the `arguments` binding.
 * Skips nested function/function-expression scopes (they have their own `arguments`),
 * but traverses arrow functions (which inherit the enclosing `arguments`).
 */
/**
 * (#1465) Emit an iterable argument for a host-bound Promise combinator
 * (Promise.all / race / allSettled / any).
 *
 * The runtime helper delegates to native `Promise.METHOD.call(C, iter)` which
 * drives the spec's `GetIterator(iter)` algorithm — strings, arguments,
 * generators, custom Symbol.iterator objects, Set/Map/TypedArrays all "just
 * work" when the host engine sees them as real iterables.
 *
 * The pain point is array literals: by default `[p1, p2]` compiles to a
 * wasm vec or tuple struct, which is opaque to the host engine. Native
 * GetIterator on an opaque externref throws "object is not iterable".
 *
 * Fix: when the iterable argument is a syntactic ArrayLiteralExpression,
 * compile each element to externref and push it into a JS array via
 * `__js_array_new` / `__js_array_push`. For any other shape (variables,
 * function returns, spread, …) fall back to plain externref coercion and
 * trust the runtime helper's `_toIterable` to dispatch (it handles strings,
 * known JS iterables, and wasm vec via __vec_len/__vec_get).
 */
function emitIterableArg(ctx: CodegenContext, fctx: FunctionContext, argExpr: ts.Expression): void {
  // Strip parens/as so `(p as any[])` and similar wrappers still match.
  let inner: ts.Expression = argExpr;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) {
    inner = inner.expression;
  }
  if (ts.isArrayLiteralExpression(inner)) {
    const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
    const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
    flushLateImportShifts(ctx, fctx);
    if (arrNewIdx !== undefined && arrPushIdx !== undefined) {
      // Build a JS array eagerly, push each element coerced to externref.
      fctx.body.push({ op: "call", funcIdx: arrNewIdx });
      const jsArrLocal = allocLocal(fctx, `__promise_iter_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: jsArrLocal });
      for (const el of inner.elements) {
        // Spread inside the array literal: fall back to a generic coercion of
        // the entire literal to externref. Native engine will iterate the
        // spread source on our behalf.
        if (ts.isSpreadElement(el)) {
          fctx.body.push({ op: "drop" } as Instr);
          compileExpression(ctx, fctx, argExpr, { kind: "externref" });
          return;
        }
        fctx.body.push({ op: "local.get", index: jsArrLocal });
        // OmittedExpression (sparse array hole) — push undefined sentinel.
        if (ts.isOmittedExpression(el)) {
          emitUndefined(ctx, fctx);
        } else {
          const elType = compileExpression(ctx, fctx, el, { kind: "externref" });
          if (elType && elType.kind !== "externref") {
            // compileExpression with target externref should coerce already;
            // belt-and-braces fallback.
            fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
          }
        }
        fctx.body.push({ op: "call", funcIdx: arrPushIdx });
      }
      fctx.body.push({ op: "local.get", index: jsArrLocal });
      return;
    }
  }
  // Default: coerce to externref and let the runtime helper dispatch.
  compileExpression(ctx, fctx, argExpr, { kind: "externref" });
}

/**
 * (#1632a) Static-resolve the name of a function-like expression for the
 * `__bind_function` nameHint argument. Returns "" when no static name is
 * available (anonymous function, complex expression). The host falls back to
 * the wrapped callable's own `.name` when the hint is empty.
 *
 * Per spec §15.2.5 / NamedEvaluation: a named function expression
 * `function namedFn(){}` keeps its inner name even when bound to a different
 * identifier (`const fn = function namedFn(){}`); the inner name wins.
 */
function resolveStaticFunctionName(ctx: CodegenContext, expr: ts.Expression): string {
  let cursor: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(cursor) ||
    ts.isAsExpression(cursor) ||
    ts.isTypeAssertionExpression(cursor) ||
    ts.isSatisfiesExpression(cursor) ||
    ts.isNonNullExpression(cursor)
  ) {
    cursor = (cursor as ts.AsExpression | ts.ParenthesizedExpression).expression;
  }
  if (ts.isIdentifier(cursor)) {
    // Look through `const fn = function namedFn(){}` to prefer the inner name
    // (named function expression) over the binding identifier.
    const sym = ctx.checker.getSymbolAtLocation(cursor);
    const decl = sym?.valueDeclaration;
    if (decl && (ts.isVariableDeclaration(decl) || ts.isBindingElement(decl)) && decl.initializer) {
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isFunctionExpression(init) && init.name) return init.name.text;
    }
    return cursor.text;
  }
  if (ts.isPropertyAccessExpression(cursor)) return cursor.name.text;
  // Named function expression: `(function namedFn(){}).bind(...)`
  if (ts.isFunctionExpression(cursor) && cursor.name) return cursor.name.text;
  return "";
}

/**
 * (#1632a) Static-resolve the declared parameter count of a function-like
 * expression for the `__bind_function` lengthHint. Returns -1 when no static
 * arity is available; the host falls back to the wrapped callable's `.length`.
 *
 * Spec §20.2.4.2: `Function.prototype.length` is the count of formal parameters
 * before the first default-valued, rest, or destructured parameter.
 */
function resolveStaticFunctionLength(ctx: CodegenContext, expr: ts.Expression): number {
  let cursor: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(cursor) ||
    ts.isAsExpression(cursor) ||
    ts.isTypeAssertionExpression(cursor) ||
    ts.isSatisfiesExpression(cursor) ||
    ts.isNonNullExpression(cursor)
  ) {
    cursor = (cursor as ts.AsExpression | ts.ParenthesizedExpression).expression;
  }
  // Inline function expression / arrow — read parameters directly.
  if (ts.isFunctionExpression(cursor) || ts.isArrowFunction(cursor)) {
    return countSpecLength(cursor.parameters);
  }
  // Try the TS checker's call signatures.
  const tsType = ctx.checker.getTypeAtLocation(cursor);
  const sigs = tsType?.getCallSignatures?.() ?? [];
  if (sigs.length > 0) {
    const sig = sigs[0]!;
    const decl = sig.getDeclaration?.();
    if (decl && decl.parameters) {
      return countSpecLength(decl.parameters);
    }
    // Fallback: signature parameter count (less precise — counts optional/rest).
    const minArity = (sig as unknown as { minArgumentCount?: number }).minArgumentCount;
    if (typeof minArity === "number") return minArity;
    return sig.parameters.length;
  }
  return -1;
}

function countSpecLength(params: ts.NodeArray<ts.ParameterDeclaration>): number {
  let count = 0;
  for (const p of params) {
    // Skip the TypeScript `this` pseudo-parameter — it's not part of
    // Function.prototype.length per spec.
    if (ts.isIdentifier(p.name) && p.name.text === "this") continue;
    // Stop at first default, rest, or optional — per spec.
    if (p.questionToken !== undefined) break;
    if (p.dotDotDotToken !== undefined) break;
    if (p.initializer !== undefined) break;
    count++;
  }
  return count;
}

/**
 * (#1632a) Compile `target.bind(thisArg, ...partialArgs)` to a
 * `__bind_function(target, thisArg, argsArray, nameHint, lengthHint)` host
 * import call. The host delegates to `Function.prototype.bind.apply(wrapped,
 * [thisArg, ...partial])` and returns a real JS bound-function exotic.
 *
 * Standalone mode falls back to identity-bind (drops partial args, returns
 * the receiver). Returns `undefined` to signal "no codegen happened, caller
 * should fall through" — this can only happen if `compileExpression` for the
 * receiver returns null (e.g. unresolvable identifier); callers retain the
 * old "throws on missing receiver" behaviour in that case.
 */
function compileFunctionBind(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  const externRef: ValType = { kind: "externref" };
  const i32Ty: ValType = { kind: "i32" };

  // Standalone (--target wasi / noJsHost): no JS host → identity-bind degraded.
  // Drop partial args, push the receiver as externref, return it unchanged.
  if (ctx.standalone || noJsHost(ctx)) {
    for (const arg of expr.arguments) {
      const t = compileExpression(ctx, fctx, arg);
      if (t !== null) fctx.body.push({ op: "drop" });
    }
    const recvType = compileExpression(ctx, fctx, propAccess.expression, externRef);
    if (recvType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (recvType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
    }
    return externRef;
  }

  // Static hints from the receiver expression (host falls back when -1 / "").
  const targetName = resolveStaticFunctionName(ctx, propAccess.expression);
  const targetLength = resolveStaticFunctionLength(ctx, propAccess.expression);

  // 1. Push target externref.
  const recvType = compileExpression(ctx, fctx, propAccess.expression, externRef);
  if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
  }

  // 2. Push thisArg externref (or ref.null.extern when omitted).
  const args = expr.arguments;
  if (args.length >= 1) {
    const t = compileExpression(ctx, fctx, args[0]!, externRef);
    if (t === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (t.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // 3. Build argsArray as a JS Array of partial args (args[1..]).
  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [externRef]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [externRef, externRef], []);
  flushLateImportShifts(ctx, fctx);
  const arrNewResolvedIdx = ctx.funcMap.get("__js_array_new") ?? arrNewIdx;
  const arrPushResolvedIdx = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
  if (arrNewResolvedIdx === undefined || arrPushResolvedIdx === undefined) {
    // Late-import setup failed (very unusual). Bail to identity-bind for safety.
    fctx.body.push({ op: "drop" } as Instr); // drop thisArg
    return externRef;
  }
  fctx.body.push({ op: "call", funcIdx: arrNewResolvedIdx });
  const argsArrayLocal = allocLocal(fctx, `__bind_args_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.set", index: argsArrayLocal });
  for (let i = 1; i < args.length; i++) {
    fctx.body.push({ op: "local.get", index: argsArrayLocal });
    const argExpr = args[i]!;
    if (ts.isSpreadElement(argExpr)) {
      // Spread in bind partials is rare — coerce the spread argument to
      // externref and let the host accept it as a single value. Real spread
      // handling would need iterable expansion at compile time.
      const t = compileExpression(ctx, fctx, argExpr.expression, externRef);
      if (t === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (t.kind !== "externref") {
        fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
      }
    } else {
      const t = compileExpression(ctx, fctx, argExpr, externRef);
      if (t === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (t.kind !== "externref") {
        fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
      }
    }
    fctx.body.push({ op: "call", funcIdx: arrPushResolvedIdx });
  }
  fctx.body.push({ op: "local.get", index: argsArrayLocal });

  // 4. Push nameHint (string externref or ref.null.extern).
  if (targetName) {
    fctx.body.push(...stringConstantExternrefInstrs(ctx, targetName));
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // 5. Push lengthHint i32 (-1 = unknown).
  fctx.body.push({ op: "i32.const", value: targetLength });

  // 6. Call __bind_function. Result is externref.
  const bindIdx = ensureLateImport(
    ctx,
    "__bind_function",
    [externRef, externRef, externRef, externRef, i32Ty],
    [externRef],
  );
  flushLateImportShifts(ctx, fctx);
  const bindResolvedIdx = ctx.funcMap.get("__bind_function") ?? bindIdx;
  if (bindResolvedIdx === undefined) {
    // Should not happen in host mode — drop the staged args and degrade.
    fctx.body.push({ op: "drop" } as Instr); // length hint
    fctx.body.push({ op: "drop" } as Instr); // name hint
    fctx.body.push({ op: "drop" } as Instr); // args array
    fctx.body.push({ op: "drop" } as Instr); // thisArg
    // Leave receiver on the stack as identity-bind fallback.
    return externRef;
  }
  fctx.body.push({ op: "call", funcIdx: bindResolvedIdx });
  return externRef;
}

/**
 * (#1337) True when the callee expression denotes a variable whose initializer
 * is a `Function.prototype.bind` result — i.e. its runtime value is a host
 * bound-function externref. Mirrors the `isBindHostCall` detector in
 * statements/variables.ts (which forces the local to externref). Only the
 * single-assignment `const`/`let`/`var = fn.bind(...)` form is recognised; this
 * matches the bulk of the test262 bound-function-invocation corpus.
 */
function calleeIsBoundFunctionVar(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const sym = ctx.checker.getSymbolAtLocation(expr);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;
  const init = decl.initializer;
  if (!ts.isCallExpression(init)) return false;
  const callee = init.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  // Direct `<receiver>.bind(...)`.
  if (callee.name.text === "bind") return true;
  // Indirect `Function.prototype.bind.call(fn, ...)`.
  if (
    callee.name.text === "call" &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === "bind" &&
    ts.isPropertyAccessExpression(callee.expression.expression) &&
    callee.expression.expression.name.text === "prototype" &&
    ts.isIdentifier(callee.expression.expression.expression) &&
    callee.expression.expression.expression.text === "Function"
  ) {
    return true;
  }
  return false;
}

/**
 * (#1712 / #1941) Static gate for the host-callable dispatch fallback.
 *
 * The callable-param dispatch below emits an extra `__call_function` arm so a
 * callee that arrives as a non-closure externref (a host builtin held in a JS
 * variable — acorn's `var hasOwn = Object.hasOwn || function(…){…}`) dispatches
 * through the host instead of trapping on `struct.get` of a null cast. That arm
 * is only ever *taken* when the runtime value is NOT a wasm closure struct, but
 * it was emitted for EVERY callable-param dispatch, which unconditionally pulls
 * `__js_array_new` / `__js_array_push` / `__call_function` host imports into the
 * module — even for pure local-closure programs (`applyTwice((x)=>x+1, 10)`,
 * `const add5 = makeAdder(5)`) that need no JS host at all. That regressed the
 * #1941 optimize-differential gate (LinkError: `__js_array_new` not provided)
 * and violated the dual-mode "JS host optional" principle for these programs.
 *
 * Gate the fallback to callees whose runtime value can plausibly be a foreign
 * (non-wasm-closure) callable: a variable whose initializer references a host
 * builtin member directly (`var f = Object.hasOwn`) or as the left operand of a
 * `||` / `??` short-circuit (`Object.hasOwn || function(){}`). Function
 * parameters and locals/globals initialized from wasm expressions (closures,
 * local function results) are always wrapped into the closure struct by the
 * call-site coercion, so the fallback can never fire for them — and we must not
 * burden them with host imports.
 */
function calleeMayBeHostCallable(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const sym = ctx.checker.getSymbolAtLocation(expr);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;

  // Does `node` reference a host-builtin member (Object.hasOwn, Math.max, …)?
  const isHostBuiltinMember = (node: ts.Expression): boolean => {
    const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
    if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
      const recv = inner.expression;
      return ts.isIdentifier(recv) && BUILTIN_CLASS_NAMES.has(recv.text);
    }
    return false;
  };

  // Unwrap `<host> || fn` / `<host> ?? fn` short-circuit fallbacks (and nested
  // chains), checking whether any reachable left operand is a host builtin.
  const initMayBeHost = (node: ts.Expression): boolean => {
    const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
    if (isHostBuiltinMember(inner)) return true;
    if (
      ts.isBinaryExpression(inner) &&
      (inner.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return initMayBeHost(inner.left) || initMayBeHost(inner.right);
    }
    return false;
  };

  return initMayBeHost(decl.initializer);
}

/**
 * (#2028) Is `expr` an identifier resolving to a parameter of a **Promise
 * executor** — the `(resolve, reject) => {…}` arrow/function-expression passed
 * directly to `new Promise(...)`?
 *
 * Those params are bound by the host (native `new Promise` calls the executor
 * with real JS `resolve`/`reject` functions), so they arrive as plain externref
 * JS callables, NOT wasm closure structs. Calling them through the closure-struct
 * `ref.test`/`ref.cast`/`struct.get`/`call_ref` dispatch path nulls the cast and
 * traps on the null deref — they must take the `__call_function` arm instead.
 *
 * This is intentionally narrow. An ordinary callable parameter (`cb` in
 * `function apply(cb, v) { return cb(v); }`) is ALSO lowered with an `externref`
 * wasm type — the closure struct is recovered dynamically at the call site via
 * `ref.test (ref $closure)`. So "externref-typed callable param" alone is NOT a
 * safe discriminator: gating on it would re-emit the `__call_function` arm for
 * pure local-closure programs and regress the #1941 dual-mode guarantee. The
 * precise signal is that the param's *declaring function is a Promise executor*
 * (an arrow/function-expression that is the direct argument of `new Promise`),
 * whose param values are genuinely host-supplied.
 */
function calleeIsPromiseExecutorParam(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const sym = ctx.checker.getSymbolAtLocation(expr);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isParameter(decl)) return false;
  // The parameter's declaring function must be the executor of `new Promise(...)`:
  // an arrow / function expression that is a direct argument of a `new Promise`.
  const fn = decl.parent;
  if (!fn || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))) return false;
  const argParent = fn.parent;
  if (!argParent || !ts.isNewExpression(argParent)) return false;
  const ctor = argParent.expression;
  if (!ts.isIdentifier(ctor) || ctor.text !== "Promise") return false;
  // Confirm the executor is actually in the argument list (not, e.g., a type arg).
  const fnNode: ts.Node = fn;
  return (argParent.arguments ?? []).some((a) => a === fnNode);
}

/**
 * (#1337) Emit a call to a host bound-function externref via the
 * `__call_function(fn, thisArg, argsArray)` host helper. The bound function
 * already carries [[BoundThis]] and [[BoundArguments]], so `thisArg` is passed
 * as `undefined` (ref.null.extern) and only the call-site arguments are packed.
 *
 * Returns `{ kind: "externref" }` on success, or `null` to let the caller fall
 * through to the normal dispatch (e.g. if late-import wiring fails).
 */
function emitBoundFunctionCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | null {
  const externRef: ValType = { kind: "externref" };

  // 1. Compile callee → externref, stash in a local.
  const calleeType = compileExpression(ctx, fctx, expr.expression, externRef);
  if (calleeType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (calleeType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
  }
  const calleeLocal = allocLocal(fctx, `__bfn_callee_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.set", index: calleeLocal });

  // 2. Build the arguments array (JS Array externref).
  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [externRef]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [externRef, externRef], []);
  flushLateImportShifts(ctx, fctx);
  const arrNewResolvedIdx = ctx.funcMap.get("__js_array_new") ?? arrNewIdx;
  const arrPushResolvedIdx = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
  if (arrNewResolvedIdx === undefined || arrPushResolvedIdx === undefined) return null;

  fctx.body.push({ op: "call", funcIdx: arrNewResolvedIdx });
  const argsArrayLocal = allocLocal(fctx, `__bfn_args_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.set", index: argsArrayLocal });
  for (const argExpr of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsArrayLocal });
    const inner = ts.isSpreadElement(argExpr) ? argExpr.expression : argExpr;
    const t = compileExpression(ctx, fctx, inner, externRef);
    if (t === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (t.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
    }
    fctx.body.push({ op: "call", funcIdx: arrPushResolvedIdx });
  }

  // 3. Call __call_function(callee, undefined, argsArray).
  const callIdx = ensureLateImport(ctx, "__call_function", [externRef, externRef, externRef], [externRef]);
  flushLateImportShifts(ctx, fctx);
  const callResolvedIdx = ctx.funcMap.get("__call_function") ?? callIdx;
  if (callResolvedIdx === undefined) return null;

  fctx.body.push({ op: "local.get", index: calleeLocal });
  fctx.body.push({ op: "ref.null.extern" }); // thisArg — bound fn carries [[BoundThis]]
  fctx.body.push({ op: "local.get", index: argsArrayLocal });
  fctx.body.push({ op: "call", funcIdx: callResolvedIdx });
  return externRef;
}

/**
 * (#1116b) Resolve a Promise-combinator `thisArg`/receiver that names a
 * Wasm-compiled `class X extends Promise`.
 *
 * Such a class is externref-backed (#1366a/b): its instances are real host
 * Promises (built via `__new_Promise`), but the class *identifier itself* has
 * no class-object singleton global, so `compileExpression(MyPromise)` yields
 * `null`/opaque — and `Promise.all.call(MyPromise, iter)` then throws
 * `[object Object] is not a constructor` in V8. The fix: resolve the
 * identifier to a real JS-callable Promise subclass synthesized (and cached)
 * by the `__promise_subclass_ctor` host import, keyed on the class name.
 *
 * Returns true if it emitted a JS-constructor externref for `argExpr`; false
 * if the caller should fall back to plain `compileExpression`.
 */
function resolvePromiseSubclassThisArg(ctx: CodegenContext, fctx: FunctionContext, argExpr: ts.Expression): boolean {
  // (E7) Standalone (WASI) mode has no JS host, so `__promise_subclass_ctor`
  // is unsatisfiable. Never emit the import there.
  if (isStandalonePromiseActive(ctx)) return false;
  // Only fires for a bare identifier (or class-expr alias) naming a class.
  if (!ts.isIdentifier(argExpr)) return false;
  const resolved = ctx.classExprNameMap.get(argExpr.text) ?? argExpr.text;
  // Walk the parent chain so a chained subclass (E3 — `class B extends A`,
  // `class A extends Promise`) still resolves: `classBuiltinParentMap` only
  // records the *immediate* builtin parent, so B maps to "A", not "Promise".
  let cursor: string | undefined = resolved;
  let extendsPromise = false;
  const seen = new Set<string>();
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    if (ctx.classBuiltinParentMap.get(cursor) === "Promise") {
      extendsPromise = true;
      break;
    }
    cursor = ctx.classParentMap.get(cursor);
  }
  if (!extendsPromise) return false;
  const importName = "__promise_subclass_ctor";
  let funcIdx =
    ctx.funcMap.get(importName) ?? ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  funcIdx = ctx.funcMap.get(importName) ?? funcIdx;
  if (funcIdx === undefined) return false;
  // Push the class name (the synthesized subclass is cached per name). Use the
  // same host-string mechanism as extern method dispatch so it works in both
  // string backends.
  addStringConstantGlobal(ctx, resolved);
  const nameIdx = ctx.stringGlobalMap.get(resolved);
  if (nameIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: nameIdx } as Instr);
  } else {
    compileStringLiteral(ctx, fctx, resolved);
  }
  fctx.body.push({ op: "call", funcIdx });
  return true;
}

function usesArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") return true;
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    return false;
  }
  return forEachChild(node, usesArguments) ?? false;
}

/**
 * (#1397) Conservative scope-level reassignment scan: returns true if the
 * source file contains any assignment expression of the form `X.<method> = ...`
 * (any LHS expression, member name === `methodName`).
 *
 * Used to gate static-dispatch fast-paths for wrapper-type method calls
 * (`new String(...).toString()`, `new Number(...).valueOf()`, etc.) so that
 * sources that explicitly reassign these methods fall through to the
 * dynamic-dispatch path (`__extern_method_call`) and pick up the override
 * at runtime — preserving spec semantics where transferred prototype methods
 * throw TypeError on the wrong receiver type.
 *
 * Conservative scan rationale: scope-narrowing (only the enclosing function)
 * would miss patterns like `obj.toString = OtherType.prototype.toString`
 * defined at module scope and used inside a function. False positives
 * (sources that reassign in some unrelated branch) only cost the static
 * fast-path on wrapper objects — not a measurable perf hit because wrappers
 * are uncommon at runtime in real code.
 *
 * Cached per `(sourceFile, methodName)` so repeated calls are O(1).
 */
const _reassignmentCache = new WeakMap<ts.SourceFile, Map<string, boolean>>();
function sourceHasMethodReassignment(ctx: CodegenContext, anchor: ts.Node, methodName: string): boolean {
  const sf = anchor.getSourceFile();
  if (!sf) return false;
  let perFile = _reassignmentCache.get(sf);
  if (perFile === undefined) {
    perFile = new Map<string, boolean>();
    _reassignmentCache.set(sf, perFile);
  }
  const cached = perFile.get(methodName);
  if (cached !== undefined) return cached;

  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.name) &&
      node.left.name.text === methodName
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  }
  visit(sf);
  perFile.set(methodName, found);
  // Reference ctx so the parameter isn't unused — the cache is keyed on the
  // SourceFile (not ctx) but we keep ctx in the signature for future
  // refinements that need scope-narrowing or per-symbol resolution.
  void ctx;
  return found;
}

/**
 * (#1397) Emit a dynamic-dispatch method call on a wrapper-object receiver:
 *
 *   __extern_method_call(receiver, methodName, [])
 *
 * Used by the wrapper-reassignment branch at the top of compileMethodCall
 * to bypass the static fast-paths when source has reassigned the method.
 * Returns the result type (externref) on success, null if the necessary
 * runtime imports cannot be registered (caller falls through to the
 * static path as a best-effort fallback).
 */
export function emitWrapperDynamicMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvExpr: ts.Expression,
  methodName: string,
  callExpr?: ts.CallExpression,
): ValType | null {
  // (#1888 Slice 2) Standalone routes __extern_method_call native, which reads
  // its args over a $ObjVec — build the (empty) args list with the native
  // $ObjVec builder, not the host __js_array_new. JS-host keeps the host import.
  const arrNewIdx = ctx.standalone
    ? ensureObjVecBuilders(ctx).newIdx
    : ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
  // (#1712) Args support: when a call expression with arguments is supplied,
  // pack them into the args array via __js_array_push. JS-host only — the
  // standalone $ObjVec path stays empty-args until it grows a native push.
  const wantArgs = callExpr !== undefined && callExpr.arguments.length > 0 && !ctx.standalone && !ctx.wasi;
  const arrPushIdx = wantArgs
    ? ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], [])
    : undefined;
  const methodCallIdx = ensureLateImport(
    ctx,
    "__extern_method_call",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (arrNewIdx === undefined || methodCallIdx === undefined) return null;
  if (wantArgs && arrPushIdx === undefined) return null;

  // Compile receiver as externref.
  const recvType = compileExpression(ctx, fctx, recvExpr, { kind: "externref" });
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // Push method name as a string constant.
  addStringConstantGlobal(ctx, methodName);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));

  // Args array: __js_array_new() → externref (+ per-arg __js_array_push).
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__js_array_new") ?? arrNewIdx });
  if (wantArgs) {
    const argsArrLocal = allocLocal(fctx, `__dynm_args_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: argsArrLocal });
    for (const argExpr of callExpr!.arguments) {
      fctx.body.push({ op: "local.get", index: argsArrLocal });
      const t = compileExpression(ctx, fctx, argExpr, { kind: "externref" });
      if (t === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (t.kind !== "externref") {
        coerceType(ctx, fctx, t, { kind: "externref" });
      }
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__js_array_push") ?? arrPushIdx! });
    }
    fctx.body.push({ op: "local.get", index: argsArrLocal });
  }

  // Re-lookup methodCallIdx in case args compilation triggered shifts.
  const finalMcIdx = ctx.funcMap.get("__extern_method_call") ?? methodCallIdx;
  fctx.body.push({ op: "call", funcIdx: finalMcIdx });
  return { kind: "externref" };
}

/**
 * Emit `global.set __argc` with the actual call-site argument count.
 * This communicates how many args were really passed so the callee can
 * build a correctly-sized `arguments` object (per ES spec, arguments.length
 * equals the number of args passed, not the number of formal params).
 * Only emitted when the callee is known to use `arguments`.
 */
function emitSetArgc(ctx: CodegenContext, fctx: FunctionContext, actualArgCount: number, paramCount: number): void {
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  // Set __argc = min(actualArgCount, paramCount) — the count of formal param
  // slots actually filled. Overflow args are in __extras_argv and tracked by
  // extrasLen, so totalLen = argc + extrasLen gives the correct arguments.length.
  const argc = Math.min(actualArgCount, paramCount);
  fctx.body.push({ op: "i32.const", value: argc });
  fctx.body.push({ op: "global.set", index: argcGlobalIdx } as Instr);
}

/**
 * Reset the __argc and __extras_argv globals to their sentinel values
 * (-1 / null). Used after closure / indirect call paths where we set the
 * globals unconditionally but can't be sure the callee consumed them
 * (its prologue only consumes when the body reads `arguments`). Without
 * cleanup, a subsequent function that does read `arguments` would
 * inherit a stale extras_argv and produce a wrong arguments.length.
 * (#1511)
 */
export function emitResetArgcExtras(ctx: CodegenContext, fctx: FunctionContext): void {
  const { globalIdx: extrasGlobalIdx, vecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  fctx.body.push({ op: "ref.null", typeIdx: vecTypeIdx } as Instr);
  fctx.body.push({ op: "global.set", index: extrasGlobalIdx } as Instr);
  fctx.body.push({ op: "i32.const", value: -1 } as Instr);
  fctx.body.push({ op: "global.set", index: argcGlobalIdx } as Instr);
}

/**
 * For indirect (closure / call_ref) call paths where the callee is not
 * statically known, set `__argc` and (if there are overflow args) build
 * `__extras_argv` from the call-site args beyond `paramCount`. The
 * lifted callee's prologue reads these to compute `arguments.length`
 * correctly even when more args were passed than the lifted function's
 * formal signature accepts.
 *
 * Must be called AFTER the formal args have been compiled / pushed onto
 * the stack (or saved to locals), but BEFORE the call_ref. Pair with
 * `emitResetArgcExtras` after the call to prevent stale-extras leaking
 * into a subsequent callee that DOES read `arguments`. (#1511)
 */
export function emitClosureCallArgcExtras(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  paramCount: number,
): void {
  if (args.length > paramCount) {
    emitSetExtrasArgv(ctx, fctx, args as unknown as ts.Expression[], paramCount);
  }
  emitSetArgc(ctx, fctx, args.length, paramCount);
}

/**
 * Build the wasm instructions that set `__extras_argv` from a list of
 * pre-saved externref locals, and `__argc` to (paramCount + extrasLocals.length).
 *
 * Used by indirect-call paths that have already compiled overflow args
 * into externref locals (so we don't re-evaluate side effects). The
 * returned instruction list leaves the wasm value stack unchanged.
 * (#1511)
 */
function buildArgcExtrasSetupFromLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramCount: number,
  extrasLocals: number[],
): Instr[] {
  const out: Instr[] = [];
  const callArgCount = paramCount + extrasLocals.length;
  if (extrasLocals.length > 0) {
    const { globalIdx: extrasGlobalIdx, vecTypeIdx: extrasVecTi } = ensureExtrasArgvGlobal(ctx);
    const extrasArrTi = getArrTypeIdxFromVec(ctx, extrasVecTi);
    for (const el of extrasLocals) {
      out.push({ op: "local.get", index: el } as Instr);
    }
    out.push({ op: "array.new_fixed", typeIdx: extrasArrTi, length: extrasLocals.length } as Instr);
    const arrTmp = allocLocal(fctx, `__extras_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: extrasArrTi });
    out.push({ op: "local.set", index: arrTmp } as Instr);
    out.push({ op: "i32.const", value: extrasLocals.length } as Instr);
    out.push({ op: "local.get", index: arrTmp } as Instr);
    out.push({ op: "struct.new", typeIdx: extrasVecTi } as Instr);
    out.push({ op: "global.set", index: extrasGlobalIdx } as Instr);
  }
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  out.push({ op: "i32.const", value: Math.min(callArgCount, paramCount) } as Instr);
  out.push({ op: "global.set", index: argcGlobalIdx } as Instr);
  return out;
}

/**
 * Build the wasm instructions that reset `__argc` and `__extras_argv` to
 * their sentinel values. Useful for inlining into dispatch arms / if
 * bodies. The returned list leaves the wasm value stack unchanged.
 * (#1511)
 */
function buildArgcExtrasReset(ctx: CodegenContext): Instr[] {
  const { globalIdx: extrasGlobalIdx, vecTypeIdx: extrasVecTi } = ensureExtrasArgvGlobal(ctx);
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  return [
    { op: "ref.null", typeIdx: extrasVecTi } as Instr,
    { op: "global.set", index: extrasGlobalIdx } as Instr,
    { op: "i32.const", value: -1 } as Instr,
    { op: "global.set", index: argcGlobalIdx } as Instr,
  ];
}

/**
 * Flatten call-site arguments, expanding spread elements on array literals
 * into individual expressions. Returns the flat list of expressions.
 * For spread on non-literal arrays, returns null (cannot flatten at compile time).
 */
function flattenCallArgs(args: readonly ts.Expression[]): ts.Expression[] | null {
  const result: ts.Expression[] = [];
  for (const arg of args) {
    if (ts.isSpreadElement(arg)) {
      if (ts.isArrayLiteralExpression(arg.expression)) {
        for (const el of arg.expression.elements) {
          result.push(el);
        }
      } else {
        return null;
      }
    } else {
      result.push(arg);
    }
  }
  return result;
}

function compileOptionalDirectCall(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): InnerResult {
  const callee = expr.expression as ts.Identifier;
  const calleeType = compileExpression(ctx, fctx, callee);
  if (!calleeType) return null;

  if (calleeType.kind !== "ref" && calleeType.kind !== "ref_null" && calleeType.kind !== "externref") {
    fctx.body.push({ op: "drop" });
    const syntheticCall = ts.factory.createCallExpression(callee, expr.typeArguments, expr.arguments);
    ts.setTextRange(syntheticCall, expr);
    return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
  }

  const tmp = allocLocal(fctx, `__optdcall_${fctx.locals.length}`, calleeType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });

  let resultType: ValType = { kind: "externref" };
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) {
      const resolved = resolveWasmType(ctx, retType);
      resultType = resolved.kind === "ref" ? { kind: "ref_null", typeIdx: resolved.typeIdx } : resolved;
    }
  }

  const savedBody = pushBody(fctx);
  const funcName = callee.text;
  const closureInfo = ctx.closureMap.get(funcName);
  const funcIdx = ctx.funcMap.get(funcName);
  let resolved = false;

  if (closureInfo && (calleeType.kind === "ref" || calleeType.kind === "ref_null")) {
    fctx.body.push({ op: "local.get", index: tmp });
    if (calleeType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" } as Instr);
    const closureTmp = allocLocal(fctx, `__optdcall_cls_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: calleeType.typeIdx,
    });
    fctx.body.push({ op: "local.tee", index: closureTmp });
    fctx.body.push({ op: "local.get", index: closureTmp });
    for (const arg of expr.arguments) compileExpression(ctx, fctx, arg);
    fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
    resolved = true;
  } else if (funcIdx !== undefined) {
    const paramTypes = getFuncParamTypes(ctx, funcIdx);
    for (let i = 0; i < expr.arguments.length; i++) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
    }
    if (paramTypes) {
      const optInfo = ctx.funcOptionalParams.get(funcName);
      for (let i = expr.arguments.length; i < paramTypes.length; i++) {
        const opt = optInfo?.find((o) => o.index === i);
        if (opt) {
          pushParamSentinel(fctx, paramTypes[i]!, ctx, opt);
        } else {
          pushDefaultValue(fctx, paramTypes[i]!, ctx);
        }
      }
      maybeSetArgcForKnownCall(ctx, fctx, funcName, expr.arguments.length, paramTypes.length);
    }
    fctx.body.push({ op: "call", funcIdx });
    resolved = true;
  }

  if (!resolved) fctx.body.push(...defaultValueInstrs(resultType));

  const elseInstrs = fctx.body;
  popBody(fctx, savedBody);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: defaultValueInstrs(resultType),
    else: elseInstrs,
  });

  return resultType;
}

/**
 * Classify an eval call expression as `direct`, `indirect`, or `none`.
 *
 * Per ECMA-262 §19.2.1, a *direct* eval is a call whose callee is the
 * lexical Identifier `eval` (after stripping parentheses).  Anything that
 * forces a reference resolution detour — `(0, eval)(...)` or any other
 * non-Identifier callee that resolves to the eval function — is *indirect*.
 *
 * The compiler-side flag is forwarded to `__extern_eval` so the host shim
 * can preserve the spec-mandated scope distinction (#1164).  Direct eval
 * runs in the caller's lexical scope; indirect eval runs in global scope.
 *
 * Uses the TypeScript checker to verify that any `eval` identifier resolves
 * to the *global* eval, not a locally-shadowed variable or parameter named
 * `eval` (e.g. `function foo(eval) { return eval(42); }`).
 */
function classifyEvalCallExpression(expr: ts.CallExpression, checker: ts.TypeChecker): "direct" | "indirect" | "none" {
  if (expr.questionDotToken) return "none";
  let callee: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (ts.isIdentifier(callee) && callee.text === "eval") {
    if (isGlobalEvalIdentifier(callee, checker)) return "direct";
    return "none";
  }
  // Indirect form: (0, eval)(src) — a comma expression whose right side is `eval`.
  if (
    ts.isBinaryExpression(callee) &&
    callee.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    ts.isIdentifier(callee.right) &&
    callee.right.text === "eval"
  ) {
    if (isGlobalEvalIdentifier(callee.right, checker)) return "indirect";
    return "none";
  }
  return "none";
}

/**
 * #1229 peephole — detect `eval("/" + X + "/")` and rewrite to `new RegExp(X)`.
 *
 * Test262's BMP-codepoint regex tests are 65k-iteration loops that build a
 * regex literal via eval per iteration:
 *
 * ```js
 * for (var cu = 0; cu <= 0xffff; ++cu) {
 *   var pattern = eval("/" + xx + "/");
 * }
 * ```
 *
 * Each `eval()` call on js2wasm pays the full TS-parse + js2wasm-codegen +
 * Wasm-instantiate pipeline (~50ms). 65,536 × 50ms = an hour of wall-clock,
 * so the test always hits the 30s pool ceiling. By detecting the literal-
 * fence shape `"/" + X + "/"` we can route directly to the RegExp
 * constructor host call — same observable semantics for any code that
 * inspects `.source` / `.flags` / matching behavior, but ~one
 * host-call's worth of work instead of two.
 *
 * Returns:
 *   - `InnerResult` (with stack push of the constructed RegExp externref) on match
 *   - `undefined` if the AST shape doesn't match — caller falls through
 */
function tryEvalAsRegExpPeephole(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  // #1474 — this peephole desugars `eval("/" + X + "/")` to a RegExp_new
  // host call. RegExp has no Wasm-native engine yet, so refuse to register
  // the host import in --target standalone (eval itself is also host-only).
  if (ctx.standalone) return undefined;
  if (expr.arguments.length !== 1) return undefined;

  // Strip parens around the argument.
  let arg = expr.arguments[0]!;
  while (ts.isParenthesizedExpression(arg)) arg = arg.expression;

  // Outer shape: BinaryExpression(`+`, BinaryExpression(`+`, "/", X), "/")
  // (left-associative `+`).
  if (!ts.isBinaryExpression(arg)) return undefined;
  if (arg.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined;
  if (!ts.isStringLiteral(arg.right)) return undefined;
  if (arg.right.text !== "/") return undefined;

  let inner: ts.Expression = arg.left;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!ts.isBinaryExpression(inner)) return undefined;
  if (inner.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined;
  if (!ts.isStringLiteral(inner.left)) return undefined;
  if (inner.left.text !== "/") return undefined;

  const xExpr = inner.right;

  // Register `RegExp_new(pattern, flags) -> externref` on demand. The 7 target
  // tests (regexp/S7.8.5_*, comments/S7.4_A6, AnnexB/RegExp/RegExp-*-escape-BMP)
  // build their regex via eval *only* — they never write `new RegExp(...)` or a
  // `/.../` literal in source, so the pre-pass scan in `index.ts` does NOT
  // register `RegExp_new` and `ctx.externClasses` does NOT contain a `"RegExp"`
  // entry at this point. We mirror the on-demand registration pattern from
  // `compileRegExpLiteral` (`src/codegen/typeof-delete.ts:172-180`) so the
  // peephole works even when the source has no other RegExp use.
  //
  // Both the import AND a minimal externClasses entry are needed: the host
  // import resolver (`src/compiler/import-manifest.ts:46-51`) only routes
  // `RegExp_new` to the extern_class constructor when "RegExp" is in
  // `mod.externClasses`. Without that entry, the resolver falls through to
  // the "builtin" branch, which has no handler for `RegExp_new` and resolves
  // to a no-op that returns undefined — making the produced "regex" undefined
  // at runtime even though codegen looked correct.
  if (!ctx.externClasses.has("RegExp")) {
    ctx.externClasses.set("RegExp", {
      importPrefix: "RegExp",
      namespacePath: [],
      className: "RegExp",
      constructorParams: [{ kind: "externref" }, { kind: "externref" }],
      methods: new Map(),
      properties: new Map(),
    });
  }
  let funcIdx = ctx.funcMap.get("RegExp_new");
  if (funcIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const regexpNewType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "RegExp_new", { kind: "func", typeIdx: regexpNewType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    funcIdx = ctx.funcMap.get("RegExp_new");
  }
  if (funcIdx === undefined) return undefined;

  // Argument 0: pattern source (X compiled to externref).
  compileExpression(ctx, fctx, xExpr, { kind: "externref" });
  // Argument 1: flags — empty string. The eval-of-regex shape is
  // `eval("/" + X + "/")` with no flag tail, so flags is always "".
  const emptyFlagsResult = compileStringLiteral(ctx, fctx, "", expr);
  if (!emptyFlagsResult) return undefined;
  const finalIdx = ctx.funcMap.get("RegExp_new") ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalIdx });
  return { kind: "externref" };
}

/** Returns true if the given `eval` identifier resolves to the global eval function (not a local shadow). */
function isGlobalEvalIdentifier(ident: ts.Identifier, checker: ts.TypeChecker): boolean {
  const sym = checker.getSymbolAtLocation(ident);
  if (!sym) return true; // unresolved → assume global eval
  const decls = sym.declarations;
  if (!decls || decls.length === 0) return true;
  // Global eval is declared only in .d.ts files. A local shadow has at least one
  // declaration in a non-declaration (.ts) source file.
  return decls.every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * #1063 Part B: inline dynamic-dispatch for an identifier callee whose static
 * type is `any` (externref) but which may hold a wrapped closure struct at
 * runtime (e.g. `function outer(op: any) { return function (x) { return op(x); } }`).
 *
 * Emits a `ref.test`/`ref.cast`/`struct.get`/`call_ref` chain against every
 * closure struct type in the module whose arity matches the call's arg count.
 * Mirrors `emitClosureCallExport` (__call_fn_0) but specialized to arity N
 * with inline arg marshalling.
 *
 * Returns `{ kind: "externref" }` on success, or `null` to let the caller
 * fall back to the existing `ref.null.extern` behavior.
 */
function tryEmitInlineDynamicCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  isKnownVariable: boolean,
): InnerResult | null {
  if (!isKnownVariable) return null;

  const arity = expr.arguments.length;

  // Pre-filter candidates: matching arity, and all param/return types
  // supported by inline marshalling (f64 / i32 / externref / ref / ref_null).
  type Cand = { structTypeIdx: number; info: ClosureInfo };
  const supported = (t: ValType | null): boolean => {
    if (t === null) return true;
    return t.kind === "f64" || t.kind === "i32" || t.kind === "externref" || t.kind === "ref" || t.kind === "ref_null";
  };

  const allCandidates: Cand[] = [];
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.paramTypes.length !== arity) continue;
    if (!supported(info.returnType)) continue;
    let ok = true;
    for (const p of info.paramTypes) {
      if (!supported(p)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    allCandidates.push({ structTypeIdx: typeIdx, info });
  }
  if (allCandidates.length === 0) return null;

  // Dedupe by funcTypeIdx — concrete subtypes share funcTypeIdx with their
  // base wrapper; one dispatch arm per unique funcref type is enough.
  const seenFuncType = new Set<number>();
  const candidates: Cand[] = [];
  for (const c of allCandidates) {
    if (seenFuncType.has(c.info.funcTypeIdx)) continue;
    seenFuncType.add(c.info.funcTypeIdx);
    candidates.push(c);
  }

  // Ensure box/unbox helpers.
  addUnionImports(ctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const unboxNumberIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  if (boxNumberIdx === undefined || unboxNumberIdx === undefined) return null;

  // Compile callee (externref) → anyref → temp local.
  const calleeType = compileExpression(ctx, fctx, expr.expression);
  if (calleeType === null) return null;
  // If already a ref type, skip the extern→any convert; otherwise expect externref.
  if (calleeType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
  } else if (calleeType.kind !== "ref" && calleeType.kind !== "ref_null") {
    // Unexpected stack type — bail, the existing fallback will run.
    fctx.body.push({ op: "drop" });
    return null;
  }
  const anyLocal = allocLocal(fctx, `__dyn_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyLocal });

  // Compile each argument to externref and stash in a temp local so each
  // dispatch arm can marshal it independently without re-evaluating.
  const argLocals: number[] = [];
  for (let i = 0; i < arity; i++) {
    compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
    const argLocal = allocLocal(fctx, `__dyn_arg${i}_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: argLocal });
    argLocals.push(argLocal);
  }

  // Build dispatch chain (innermost = default, outermost = first).
  // Default: ref.null.extern (matches existing fallback semantics).
  let dispatch: Instr[] = [{ op: "ref.null.extern" } as Instr];

  for (const cand of candidates) {
    const funcTypeDef = ctx.mod.types[cand.info.funcTypeIdx];
    const selfParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[0] : undefined;
    const selfTypeIdx =
      selfParam && (selfParam.kind === "ref" || selfParam.kind === "ref_null")
        ? (selfParam as { typeIdx: number }).typeIdx
        : cand.structTypeIdx;

    const callBody: Instr[] = [];

    // Self arg: anyref → the concrete struct type this funcref expects.
    callBody.push({ op: "local.get", index: anyLocal } as Instr);
    callBody.push({ op: "ref.cast", typeIdx: selfTypeIdx } as Instr);

    // Push each call arg, unboxing per the candidate's declared param type.
    for (let i = 0; i < arity; i++) {
      const pType = cand.info.paramTypes[i]!;
      callBody.push({ op: "local.get", index: argLocals[i]! } as Instr);
      if (pType.kind === "f64") {
        callBody.push({ op: "call", funcIdx: unboxNumberIdx } as Instr);
      } else if (pType.kind === "i32") {
        callBody.push({ op: "call", funcIdx: unboxNumberIdx } as Instr);
        callBody.push({ op: "i32.trunc_sat_f64_s" } as Instr);
      } else if (pType.kind === "externref") {
        // already externref
      } else if (pType.kind === "ref" || pType.kind === "ref_null") {
        callBody.push({ op: "any.convert_extern" } as Instr);
        callBody.push({ op: "ref.cast", typeIdx: (pType as { typeIdx: number }).typeIdx } as Instr);
      }
    }

    // Extract funcref from field 0 and call_ref.
    callBody.push({ op: "local.get", index: anyLocal } as Instr);
    callBody.push({ op: "ref.cast", typeIdx: selfTypeIdx } as Instr);
    callBody.push({ op: "struct.get", typeIdx: selfTypeIdx, fieldIdx: 0 } as Instr);
    callBody.push({ op: "ref.cast", typeIdx: cand.info.funcTypeIdx } as Instr);
    callBody.push({ op: "call_ref", typeIdx: cand.info.funcTypeIdx } as Instr);

    // Coerce return value to externref.
    const ret = cand.info.returnType;
    if (ret === null) {
      callBody.push({ op: "ref.null.extern" } as Instr);
    } else if (ret.kind === "f64") {
      callBody.push({ op: "call", funcIdx: boxNumberIdx } as Instr);
    } else if (ret.kind === "i32") {
      callBody.push({ op: "f64.convert_i32_s" } as Instr);
      callBody.push({ op: "call", funcIdx: boxNumberIdx } as Instr);
    } else if (ret.kind === "ref" || ret.kind === "ref_null") {
      callBody.push({ op: "extern.convert_any" } as Instr);
    }
    // externref: no conversion

    dispatch = [
      { op: "local.get", index: anyLocal } as Instr,
      { op: "ref.test", typeIdx: selfTypeIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: callBody,
        else: dispatch,
      } as Instr,
    ];
  }

  fctx.body.push(...dispatch);
  return { kind: "externref" };
}

/**
 * (#1299) Emit a tag-based virtual method dispatch for a base-typed
 * receiver where multiple subclasses provide overriding implementations.
 * Mirrors the `instanceof` codegen: load the receiver's `__tag` field
 * (i32, set in each subclass's constructor) and compare against each
 * candidate's known `classTag` value, calling the matching subclass's
 * method body. Receiver and arguments are evaluated once and saved to
 * temp locals so each branch can reference them.
 *
 * Returns the call's IR result type, or undefined if dispatch could not
 * be emitted (caller falls back to the existing static path).
 */
function emitVirtualMethodDispatchByTag(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  candidates: { className: string; funcIdx: number; classTag: number }[],
  baseClassName: string,
): InnerResult | undefined {
  // Resolve the base struct typeIdx for `struct.get __tag` (field 0).
  const baseStructIdx = ctx.structMap.get(baseClassName);
  if (baseStructIdx === undefined) return undefined;

  // Validate first candidate's signature (used as the schema for arg
  // type hints and return-type lookup; all overrides share the same
  // user-visible signature).
  const firstCand = candidates[0]!;
  const firstParamTypes = getFuncParamTypes(ctx, firstCand.funcIdx);
  if (!firstParamTypes || firstParamTypes.length === 0) return undefined;

  // Compile the receiver expression — produces a ref-typed value.
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (!recvType || (recvType.kind !== "ref" && recvType.kind !== "ref_null")) return undefined;

  const recvLocalType: ValType = { kind: "ref_null", typeIdx: (recvType as { typeIdx: number }).typeIdx };
  const recvLocal = allocTempLocal(fctx, recvLocalType);
  fctx.body.push({ op: "local.set", index: recvLocal });

  // Evaluate args and save each to a temp local. Pad missing args with
  // default values so call sites can omit trailing arguments.
  const argLocals: { idx: number; type: ValType }[] = [];
  const userParamCount = firstParamTypes.length - 1; // exclude self
  const argCount = Math.min(expr.arguments.length, userParamCount);
  for (let i = 0; i < argCount; i++) {
    const expectedArgType = firstParamTypes[i + 1];
    const aType = compileExpression(ctx, fctx, expr.arguments[i]!, expectedArgType);
    if (!aType) return undefined;
    const local = allocTempLocal(fctx, aType);
    fctx.body.push({ op: "local.set", index: local });
    argLocals.push({ idx: local, type: aType });
  }
  for (let i = expr.arguments.length + 1; i < firstParamTypes.length; i++) {
    const paramType = firstParamTypes[i]!;
    pushDefaultValue(fctx, paramType, ctx);
    const local = allocTempLocal(fctx, paramType);
    fctx.body.push({ op: "local.set", index: local });
    argLocals.push({ idx: local, type: paramType });
  }

  // Determine return type from the first candidate's signature.
  const sig = ctx.checker.getResolvedSignature(expr);
  let resultType: ValType | typeof VOID_RESULT = VOID_RESULT;
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    const fullName0 = `${firstCand.className}_${propAccess.name.text}`;
    if (!isEffectivelyVoidReturn(ctx, retType, fullName0)) {
      const wasmRet = getWasmFuncReturnType(ctx, firstCand.funcIdx);
      resultType = wasmRet ?? resolveWasmType(ctx, retType);
    }
  }
  if (resultType !== VOID_RESULT && wasmFuncReturnsVoid(ctx, firstCand.funcIdx)) {
    resultType = VOID_RESULT;
  }

  const blockType: { kind: "val"; type: ValType } | { kind: "empty" } =
    resultType === VOID_RESULT ? { kind: "empty" } : { kind: "val", type: resultType };

  // Build the call body for one candidate. We need to ref.cast the
  // receiver to the candidate's struct type before calling, so the
  // function-type signature matches.
  function callBody(cand: { className: string; funcIdx: number; classTag: number }): Instr[] {
    const candParams = getFuncParamTypes(ctx, cand.funcIdx);
    if (!candParams || candParams.length === 0) return [];
    const selfType = candParams[0]!;
    if (selfType.kind !== "ref" && selfType.kind !== "ref_null") return [];
    const selfTypeIdx = (selfType as { typeIdx: number }).typeIdx;
    const body: Instr[] = [];
    body.push({ op: "local.get", index: recvLocal });
    // ref.cast_null preserves nullability if the receiver might be null;
    // ref.cast (non-null) traps on null. Use ref.cast_null since the
    // receiver could be null at the static type level.
    body.push({ op: "ref.cast_null", typeIdx: selfTypeIdx } as Instr);
    for (const a of argLocals) {
      body.push({ op: "local.get", index: a.idx });
    }
    const finalIdx = ctx.funcMap.get(`${cand.className}_${propAccess.name.text}`) ?? cand.funcIdx;
    body.push({ op: "call", funcIdx: finalIdx });
    return body;
  }

  // Build the cascade: load __tag, compare to each candidate's classTag.
  // Outermost: candidates[0]; deepest else: unreachable.
  let elseInstrs: Instr[] = [{ op: "unreachable" } as Instr];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const cand = candidates[i]!;
    const branch: Instr[] = [
      { op: "local.get", index: recvLocal },
      { op: "struct.get", typeIdx: baseStructIdx, fieldIdx: 0 } as Instr,
      { op: "i32.const", value: cand.classTag } as Instr,
      { op: "i32.eq" } as Instr,
      {
        op: "if",
        blockType,
        then: callBody(cand),
        else: elseInstrs,
      } as Instr,
    ];
    elseInstrs = branch;
  }
  for (const instr of elseInstrs) fctx.body.push(instr);

  for (const a of argLocals) releaseTempLocal(fctx, a.idx);
  releaseTempLocal(fctx, recvLocal);

  return resultType;
}

/**
 * Statically flatten an array literal's elements into a positional argument
 * list, expanding spreads of nested array literals (`[...[a, b]]` → `a, b`).
 * Returns undefined when the literal contains an element we cannot expand at
 * compile time (a spread of a non-literal, or an elided hole). Used by the
 * `fn.apply(thisArg, [...])` rewrite (#1596).
 */
function flattenStaticArrayElements(arr: ts.ArrayLiteralExpression): ts.Expression[] | undefined {
  const out: ts.Expression[] = [];
  for (const el of arr.elements) {
    if (ts.isOmittedExpression(el)) return undefined;
    if (ts.isSpreadElement(el)) {
      let inner: ts.Expression = el.expression;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      if (!ts.isArrayLiteralExpression(inner)) return undefined;
      const nested = flattenStaticArrayElements(inner);
      if (nested === undefined) return undefined;
      out.push(...nested);
    } else {
      out.push(el);
    }
  }
  return out;
}

function isNullishPromiseThenCallbackArg(expr: ts.Expression | undefined): boolean {
  if (expr === undefined) return true;
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = (
      cur as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.SatisfiesExpression
        | ts.NonNullExpression
        | ts.TypeAssertion
    ).expression;
  }
  return (
    cur.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(cur) && cur.text === "undefined") ||
    (ts.isVoidExpression(cur) && cur.expression.kind === ts.SyntaxKind.NumericLiteral)
  );
}

function compilePromiseThenReceiverBuffer(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  liveBuffers: Instr[][],
): Instr[] {
  const instrs: Instr[] = [];
  liveBuffers.push(instrs);
  ctx.liveBodies.add(instrs);
  const savedBody = fctx.body;
  fctx.body = instrs;
  try {
    const type = compileExpression(ctx, fctx, expr, { kind: "externref" });
    if (type && type.kind !== "externref") {
      coerceType(ctx, fctx, type, { kind: "externref" });
    }
  } finally {
    fctx.body = savedBody;
  }
  return instrs;
}

function compileStandalonePromiseThenCallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression | undefined,
  liveBuffers: Instr[][],
): StandalonePromiseThenCallback | null {
  if (arg === undefined || isNullishPromiseThenCallbackArg(arg)) return null;

  const instrs: Instr[] = [];
  liveBuffers.push(instrs);
  ctx.liveBodies.add(instrs);
  const savedBody = fctx.body;
  fctx.body = instrs;
  try {
    const type =
      ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
        ? compileArrowAsClosure(ctx, fctx, arg)
        : compileExpression(ctx, fctx, arg);
    let closureInfo: ClosureInfo | undefined;
    if (type && (type.kind === "ref" || type.kind === "ref_null")) {
      closureInfo = ctx.closureInfoByTypeIdx.get(type.typeIdx);
    }
    if (!closureInfo && ts.isIdentifier(arg)) {
      closureInfo = ctx.closureMap.get(arg.text);
    }
    if (!closureInfo) {
      instrs.length = 0;
      return null;
    }
    if (type && type.kind !== "externref") {
      coerceType(ctx, fctx, type, { kind: "externref" });
    }
    return { instrs, closureInfo };
  } finally {
    fctx.body = savedBody;
  }
}

/**
 * #2034: compile a `Number.is*` predicate argument as an f64, honouring the
 * spec rule that these predicates do NOT coerce (ES §21.1.2.x): a non-Number
 * argument must yield `false` without ToNumber. (The *global* `isNaN`/`isFinite`
 * DO coerce — they are handled elsewhere and unaffected.)
 *
 * Emits one of two shapes and returns i32 (0/1):
 *   - static number arg → `predicate(arg)` (unchanged fast path).
 *   - any-typed arg → `__typeof_number(box) ? predicate(__unbox_number(box)) : 0`.
 *     The typeof guard runs first, so a string/object/null box short-circuits to
 *     0 (false) and never reaches the numeric test.
 *
 * `emitPredicate` receives the local holding the f64 value and pushes the
 * boolean (i32) test for that value.
 */
function compileNumberIsPredicate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
  emitPredicate: (valLocal: number) => Instr[],
): ValType {
  const argTsType = ctx.checker.getTypeAtLocation(arg);
  const argWasm = resolveWasmType(ctx, argTsType);
  const isStaticNumber = isNumberType(argTsType) || argWasm.kind === "f64" || argWasm.kind === "i32";

  if (isStaticNumber) {
    // Fast path: the argument is statically a number — apply the test directly.
    compileExpression(ctx, fctx, arg, { kind: "f64" });
    const valTmp = allocLocal(fctx, `__numpred_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: valTmp });
    for (const instr of emitPredicate(valTmp)) fctx.body.push(instr);
    return { kind: "i32" };
  }

  // Any-typed argument: inspect the box's runtime type. Non-numbers are `false`
  // (no coercion); numbers unbox to f64 and run the test.
  addUnionImports(ctx);
  const typeofNumIdx = ctx.funcMap.get("__typeof_number")!;
  const unboxIdx = ctx.funcMap.get("__unbox_number")!;

  compileExpression(ctx, fctx, arg, { kind: "externref" });
  const boxTmp = allocLocal(fctx, `__numpred_box_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: boxTmp });

  const valTmp = allocLocal(fctx, `__numpred_${fctx.locals.length}`, { kind: "f64" });

  fctx.body.push({ op: "local.get", index: boxTmp });
  fctx.body.push({ op: "call", funcIdx: typeofNumIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [
      { op: "local.get", index: boxTmp } as Instr,
      { op: "call", funcIdx: unboxIdx } as Instr,
      { op: "local.set", index: valTmp } as Instr,
      ...emitPredicate(valTmp),
    ],
    else: [{ op: "i32.const", value: 0 } as Instr],
  } as Instr);
  return { kind: "i32" };
}

/**
 * (#2069) Detect whether a named callee was declared with an explicit
 * TypeScript `this` parameter (`function f(this: T, …)`). Such a function
 * materializes a leading `externref` `this` slot in its Wasm signature, so a
 * `.call`/`.apply` lowering must thread the user's thisArg into that slot
 * rather than dropping it. Returns the function's first ParameterDeclaration
 * when it is the `this` pseudo-parameter, else undefined.
 */
function getExplicitThisParam(ctx: CodegenContext, callee: ts.Expression): ts.ParameterDeclaration | undefined {
  const sym = ctx.checker.getSymbolAtLocation(callee);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (
    decl &&
    (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) &&
    decl.parameters.length > 0
  ) {
    const p0 = decl.parameters[0]!;
    if (ts.isIdentifier(p0.name) && p0.name.text === "this") return p0;
  }
  return undefined;
}

/**
 * #2088 — `String.fromCharCode` / `String.fromCodePoint`, all four lanes
 * (native helper × host import) served by one definition.
 *
 * Each argument becomes a one-char(-or-code-point) string via `helperIdx`;
 * the variadic concatenation that joins them is the shared
 * {@link emitVariadicStringConcat} primitive, so the single-argument-drop bug
 * that #2122 / #1955 fixed independently in every arm can no longer reappear
 * in just one lane.
 *
 * `native` selects the representation: native helpers concat with
 * `__str_concat` over `(ref $NativeString)` parts (zero host imports); the
 * host import path concats with the `wasm:js-string` `concat` builtin over
 * externref parts. `argToCode` is the per-argument numeric coercion the helper
 * expects (`i32.trunc_sat_f64_s` for the i32-typed native helpers,
 * `f64.convert_i32_s` for the f64-typed host imports).
 */
function compileFromCharCodeFamily(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  opts: { native: boolean; helperIdx: number },
): ValType | null {
  const { native, helperIdx } = opts;
  const repr = native ? nativeStringRepr(ctx) : hostStringRepr(ctx);
  if (repr === undefined) return null;

  // Build one string `part` per argument by compiling its code into a buffer
  // and applying the per-rep numeric coercion + the 1-char-string helper. The
  // buffers are registered with `ctx.liveBodies` so a late import added while
  // compiling a *later* argument still shifts indices baked into earlier ones.
  const parts: Instr[][] = [];
  for (let i = 0; i < expr.arguments.length; i++) {
    const buf: Instr[] = [];
    ctx.liveBodies.add(buf);
    const savedBody = fctx.body;
    fctx.body = buf;
    try {
      const argType = compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "f64" });
      if (native) {
        if (argType && argType.kind !== "i32") buf.push({ op: "i32.trunc_sat_f64_s" });
      } else {
        if (argType && argType.kind === "i32") buf.push({ op: "f64.convert_i32_s" });
      }
      buf.push({ op: "call", funcIdx: helperIdx });
    } finally {
      fctx.body = savedBody;
    }
    parts.push(buf);
  }

  fctx.body.push(...emitVariadicStringConcat(repr, parts));
  // The part instructions now live (spliced) inside `fctx.body`, which every
  // future `flushLateImportShifts` already walks. Drop the standalone buffer
  // registrations so the same instruction objects are not shifted twice (the
  // shift dedup keys on array identity, not instruction identity).
  for (const buf of parts) ctx.liveBodies.delete(buf);
  return repr.resultType;
}

function compileCallExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  expectedType?: ValType,
): InnerResult {
  // Optional chaining on calls: obj?.method() and obj.method?.().
  //
  // In the TS AST the `?.` of `o?.m(args)` sits on the inner
  // PropertyAccessExpression, NOT on the CallExpression — only `o.m?.(args)`
  // sets `expr.questionDotToken`. Gating on the call token alone (#2049) missed
  // the common `o?.m(args)` form, so it fell into the regular method-call path
  // which evaluates arguments unconditionally and derefs the receiver (trapping
  // on a null class instance). Gate on the optional chain itself so both forms
  // route to the short-circuiting path.
  if (ts.isOptionalChain(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    return compileOptionalCallExpression(ctx, fctx, expr);
  }

  // (#1732/#2180) Calling a built-in non-constructor namespace (Math, JSON,
  // Reflect, Atomics, Proxy) as a function must throw TypeError ("no [[Call]]").
  // Extracted to calls-guards.ts (#742).
  {
    const r = tryNamespaceNonCallable(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // (#1540) JSX runtime call intercept — `_jsx` / `_jsxs` / `_jsxDEV`. Routed to
  // the matching `__jsx_runtime_*` host import. Extracted to calls-guards.ts (#742).
  {
    const r = tryJsxRuntimeCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // Node-shaped process APIs are lowered in their own module so the generic
  // call-expression compiler does not accumulate host API special cases.
  const nodeProcessCall = tryCompileNodeProcessCall(ctx, fctx, expr);
  if (nodeProcessCall !== undefined) return nodeProcessCall;

  // RegExp(pattern, flags) called without `new`. Extracted to calls-guards.ts (#742).
  {
    const r = tryRegExpConstructorCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // `Object(x)` called without `new` — §20.1.1.1 / §7.1.18 ToObject.
  // Extracted to calls-guards.ts (#742).
  {
    const r = tryObjectCoercionCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // Optional chaining on direct call: fn?.()
  if (expr.questionDotToken && ts.isIdentifier(expr.expression)) {
    return compileOptionalDirectCall(ctx, fctx, expr);
  }

  // eval(...) — first try static inlining (#1163): if the source argument is
  // a compile-time-constant string, parse it and splice the AST inline at the
  // call site.  This is the zero-runtime-cost path.  If the argument is not
  // a constant (or parsing fails), fall through to __extern_eval (#1006/#1164).
  // Covers direct `eval(src)` and indirect `(0, eval)(src)` / `(0,eval)(src)`.
  // In standalone/WASI mode the host import is unavailable and will trap at
  // instantiation time — callers that need eval must use a JS host.
  //
  // #1164: signature is `(externref src, i32 isDirect) -> externref`.  The
  // isDirect flag (1 = direct call, 0 = indirect) lets the host shim
  // preserve ECMA-262 §19.2.1 scope semantics — direct eval has access to
  // the caller's lexical scope, indirect eval runs in global scope.
  {
    const evalKind = classifyEvalCallExpression(expr, ctx.checker);
    if (evalKind !== "none") {
      // #1229 — peephole: `eval("/" + X + "/")` → `new RegExp(X)`.
      // Test262's BMP-codepoint regex tests build a regex literal per
      // iteration via eval; the eval pipeline (TS+codegen+wasm-instantiate)
      // is ~50ms per call, hitting the 30s pool ceiling on the first few
      // hundred of 65k iterations. Rewriting to the RegExp constructor
      // avoids the eval pipeline entirely — one host call (regex parse +
      // compile) instead of two (eval pipeline + regex parse + compile).
      // The semantic difference (eval throws SyntaxError-by-eval; new RegExp
      // throws SyntaxError-by-RegExp) is invisible to callers that only
      // inspect `.source` / `.flags` / matching behavior, which is the
      // entire test set this targets.
      const rewritten = tryEvalAsRegExpPeephole(ctx, fctx, expr);
      if (rewritten !== undefined) return rewritten;
      const inlined = tryStaticEvalInline(ctx, fctx, expr);
      if (inlined !== undefined) return inlined;
      let evalIdx = ctx.funcMap.get("__extern_eval");
      if (evalIdx === undefined) {
        const importsBefore = ctx.numImportFuncs;
        const evalType = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "externref" }]);
        addImport(ctx, "env", "__extern_eval", { kind: "func", typeIdx: evalType });
        shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
        evalIdx = ctx.funcMap.get("__extern_eval");
      }
      if (evalIdx === undefined) {
        fctx.body.push({ op: "unreachable" });
        return null;
      }
      if (expr.arguments.length === 0) {
        // eval() with no args returns undefined per spec.  Avoid the host
        // round-trip entirely.
        // NOTE(#1095): preserved as-is — original used `{ op: "ref.null", refType: "extern" }`
        // with `as unknown as Instr` to bypass typecheck. The `refType` field is not part of
        // the Instr union and is ignored by the emitter (which would read `typeIdx` as undefined).
        // The semantically-correct form is `{ op: "ref.null.extern" }`; left as legacy to keep
        // this refactor byte-identical. See follow-up.
        fctx.body.push({ op: "ref.null", refType: "extern" } as unknown as Instr);
        return { kind: "externref" };
      }
      const srcArg = expr.arguments[0]!;
      const srcType = compileExpression(ctx, fctx, srcArg);
      if (srcType && srcType.kind !== "externref") {
        coerceType(ctx, fctx, srcType, { kind: "externref" });
      }
      // Push isDirect flag.
      fctx.body.push({ op: "i32.const", value: evalKind === "direct" ? 1 : 0 });
      for (let ai = 1; ai < expr.arguments.length; ai++) {
        const extraType = compileExpression(ctx, fctx, expr.arguments[ai]!);
        if (extraType) fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "call", funcIdx: evalIdx });
      return { kind: "externref" };
    }
  }

  // import.defer(...) / import.source(...) — Stage 3 proposals not implemented.
  // Without this guard, falling through to type-resolution lower in the call
  // pipeline triggers `Debug Failure: Trying to get the type of import.defer
  // in import.defer(...)` from the TypeScript checker (it doesn't know how to
  // type these meta-properties). Emit a clean compile error instead — for
  // negative parse/early SyntaxError tests this counts as the expected error
  // (compilation rejecting the source). #1315.
  if (
    ts.isMetaProperty(expr.expression) &&
    expr.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    (expr.expression.name.text === "defer" || expr.expression.name.text === "source")
  ) {
    reportError(
      ctx,
      expr,
      `SyntaxError: import.${expr.expression.name.text}(...) is not supported (Stage 3 proposal — import-defer / source-phase-imports)`,
    );
    return null;
  }

  // Dynamic import() — delegate to __dynamic_import host import.
  // Takes a specifier (externref string) and returns an externref (Promise).
  // In standalone (no JS host) mode, this will trap since there is no host.
  if (expr.expression.kind === ts.SyntaxKind.ImportKeyword) {
    // Ensure __dynamic_import is registered
    let dynIdx = ctx.funcMap.get("__dynamic_import");
    if (dynIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const dynType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "__dynamic_import", { kind: "func", typeIdx: dynType });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      dynIdx = ctx.funcMap.get("__dynamic_import");
    }
    if (dynIdx === undefined) {
      fctx.body.push({ op: "unreachable" });
      return null;
    }
    // Compile the specifier argument
    const specArg = expr.arguments[0];
    if (specArg) {
      const specResult = compileExpression(ctx, fctx, specArg);
      // Coerce to externref if needed
      if (specResult && specResult.kind !== "externref") {
        coerceType(ctx, fctx, specResult, { kind: "externref" });
      }
    } else {
      // No argument — pass undefined (null externref)
      // NOTE(#1095): see eval() note above; original used `{ op: "ref.null", refType: "extern" }`
      // bypass-cast. Preserved verbatim for byte-identical output.
      fctx.body.push({ op: "ref.null", refType: "extern" } as unknown as Instr);
    }

    // Evaluate remaining arguments (e.g. import attributes/options) for side effects.
    // Per spec, the second argument (optionsExpression) is evaluated before the
    // host import is performed. If it throws, the throw propagates synchronously.
    // We evaluate and drop the result since __dynamic_import only takes the specifier.
    for (let ai = 1; ai < expr.arguments.length; ai++) {
      const extraArg = expr.arguments[ai];
      const extraResult = compileExpression(ctx, fctx, extraArg);
      // Drop the value from the stack if the expression produced one
      if (extraResult) {
        fctx.body.push({ op: "drop" });
      }
    }

    fctx.body.push({ op: "call", funcIdx: dynIdx });
    return { kind: "externref" };
  }

  // Unwrap parenthesized callee: (fn)(...), ((obj.method))(...) etc.
  // This handles patterns like (0, fn)() which are already handled below,
  // but also (fn)(), ((fn))(), (obj.method)() etc. which would otherwise fail.
  if (ts.isParenthesizedExpression(expr.expression)) {
    let unwrapped: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(unwrapped)) {
      unwrapped = unwrapped.expression;
    }
    // Only unwrap if it's NOT a function expression or arrow (those are IIFEs, handled later)
    // and NOT a binary/comma expression (handled separately below)
    if (
      !ts.isFunctionExpression(unwrapped) &&
      !ts.isArrowFunction(unwrapped) &&
      !(ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken)
    ) {
      // Handle conditional callee inline: (cond ? fn1 : fn2)(args)
      // Cannot create a synthetic call because ts.factory wraps non-LeftHandSide
      // expressions in ParenthesizedExpression, causing infinite recursion.
      if (ts.isConditionalExpression(unwrapped)) {
        return compileConditionalCallee(ctx, fctx, expr, unwrapped);
      }

      // Handle assignment/binary expressions as callee: (x = fn)(), (a || fn)()
      // These are non-LeftHandSideExpressions, so ts.factory.createCallExpression
      // would re-wrap them in ParenthesizedExpression, causing infinite recursion.
      // Instead, compile the expression for its side effects and value, then use
      // the generic closure-matching path to call the result.
      if (ts.isBinaryExpression(unwrapped)) {
        return compileExpressionCallee(ctx, fctx, expr, unwrapped);
      }

      // Handle prefix/postfix unary as callee (rare but possible)
      if (ts.isPrefixUnaryExpression(unwrapped) || ts.isPostfixUnaryExpression(unwrapped)) {
        return compileExpressionCallee(ctx, fctx, expr, unwrapped);
      }

      const syntheticCall = ts.factory.createCallExpression(
        unwrapped as ts.Expression as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Unwrap `expr!(...)` non-null assertions on the callee (#1298). The TS type
  // of NonNullExpression is the original type minus null/undefined, so the
  // underlying PropertyAccessExpression / Identifier / etc. dispatch sees a
  // callable type. Mirrors the ParenthesizedExpression unwrap above.
  if (ts.isNonNullExpression(expr.expression)) {
    let inner: ts.Expression = expr.expression.expression;
    // Strip nested non-null assertions: `obj.fn!!(...)`
    while (ts.isNonNullExpression(inner)) {
      inner = inner.expression;
    }
    // Only build a synthetic CallExpression for LeftHandSide-shaped inner
    // expressions; non-LHS (e.g. binary, conditional) would be re-wrapped in
    // ParenthesizedExpression by ts.factory and infinite-recurse. For those,
    // fall through to compileExpressionCallee.
    if (
      !ts.isFunctionExpression(inner) &&
      !ts.isArrowFunction(inner) &&
      !ts.isBinaryExpression(inner) &&
      !ts.isConditionalExpression(inner) &&
      !ts.isPrefixUnaryExpression(inner) &&
      !ts.isPostfixUnaryExpression(inner)
    ) {
      const syntheticCall = ts.factory.createCallExpression(
        inner as ts.Expression as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Handle super.method() calls — resolve to ParentClass_method with this as first arg
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    return compileSuperMethodCall(ctx, fctx, expr);
  }

  // (#1467) AggregateError(errors, message, options?) — called WITHOUT `new`.
  // Per ES §20.5.7.1, AggregateError called as a function must construct
  // normally (same effective semantics as `new`). Mirror the codegen in
  // new-super.ts so the without-new and with-new failures resolve together.
  // Must run BEFORE the property-access dispatch since the expression is a
  // bare identifier, and BEFORE the BUILTIN_CLASS_NAMES generic path which
  // would otherwise emit a host-method call without spec coercion.
  // Unwrap parenthesized expressions and as/satisfies casts so
  // `(AggregateError as any)([], 'msg')` also reaches this dispatch.
  let _aggCallee: ts.Expression = expr.expression;
  while (
    ts.isParenthesizedExpression(_aggCallee) ||
    ts.isAsExpression(_aggCallee) ||
    ts.isTypeAssertionExpression(_aggCallee) ||
    ts.isSatisfiesExpression(_aggCallee) ||
    ts.isNonNullExpression(_aggCallee)
  ) {
    _aggCallee = (_aggCallee as ts.AsExpression | ts.ParenthesizedExpression).expression;
  }
  if (ts.isIdentifier(_aggCallee) && _aggCallee.text === "AggregateError") {
    const args = expr.arguments ?? [];
    if (args.length >= 1) {
      const errorsType = compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
      if (errorsType && errorsType.kind !== "externref") {
        coerceType(ctx, fctx, errorsType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    if (args.length >= 2) {
      const msgType = compileExpression(ctx, fctx, args[1]!, { kind: "externref" });
      if (msgType && msgType.kind !== "externref") {
        coerceType(ctx, fctx, msgType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    if (args.length >= 3) {
      const optsType = compileExpression(ctx, fctx, args[2]!, { kind: "externref" });
      if (optsType && optsType.kind !== "externref") {
        coerceType(ctx, fctx, optsType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
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

  // (#1634) SuppressedError(error, suppressed, message, options?) — called
  // WITHOUT `new`. Per ES §20.5.10.1, called as a function it constructs
  // normally. Mirror the new-super.ts codegen so without-new and with-new
  // resolve together. Unwrap parenthesized/cast wrappers like the AggregateError
  // dispatch above.
  let _suppCallee: ts.Expression = expr.expression;
  while (
    ts.isParenthesizedExpression(_suppCallee) ||
    ts.isAsExpression(_suppCallee) ||
    ts.isTypeAssertionExpression(_suppCallee) ||
    ts.isSatisfiesExpression(_suppCallee) ||
    ts.isNonNullExpression(_suppCallee)
  ) {
    _suppCallee = (_suppCallee as ts.AsExpression | ts.ParenthesizedExpression).expression;
  }
  if (ts.isIdentifier(_suppCallee) && _suppCallee.text === "SuppressedError") {
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

  // Handle property access calls: console.log, Math.xxx, extern methods
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const propAccess = expr.expression;

    const standaloneRegExpExec = tryCompileStandaloneRegExpExec(ctx, fctx, expr, propAccess);
    if (standaloneRegExpExec !== undefined) return standaloneRegExpExec;

    const standaloneRegExpTest = tryCompileStandaloneRegExpTest(ctx, fctx, expr, propAccess);
    if (standaloneRegExpTest !== undefined) return standaloneRegExpTest;

    // Handle Array.prototype.METHOD.call(obj, ...args) — inline as array method on shape-inferred obj
    {
      const callResult = compileArrayPrototypeCall(ctx, fctx, expr, propAccess);
      if (callResult !== undefined) return callResult;
    }

    // (#1337) Function.prototype.bind.call(fn, thisArg, ...args) reshape.
    // Mirrors the #1596 reshape for Function.prototype.{apply,call}.call: rewrite
    // to `fn.bind(thisArg, ...args)` so the existing #1632a bind dispatch fires
    // and routes through __bind_function instead of leaking to the host's
    // Function.prototype.bind on a wasm-struct receiver ("Bind must be called
    // on a function"). Only the outer `.call` form is matched —
    // `Function.prototype.bind.apply(fn, [thisArg, ...args])` is rare.
    //
    // Narrowing: only fires when the `fn` target has TS call signatures.
    // This preserves the legacy "Function.prototype.bind.call(undefined, ...)
    // throws TypeError" behaviour for spec tests like S15.3.4.5_A13 — the
    // bind dispatch only intercepts callable receivers; non-callable
    // targets fall through to the legacy host path which throws correctly.
    if (
      propAccess.name.text === "call" &&
      ts.isPropertyAccessExpression(propAccess.expression) &&
      propAccess.expression.name.text === "bind" &&
      ts.isPropertyAccessExpression(propAccess.expression.expression) &&
      propAccess.expression.expression.name.text === "prototype" &&
      ts.isIdentifier(propAccess.expression.expression.expression) &&
      propAccess.expression.expression.expression.text === "Function" &&
      expr.arguments.length >= 1
    ) {
      const fnExpr = expr.arguments[0]!;
      const fnTsType = ctx.checker.getTypeAtLocation(fnExpr);
      const fnHasCallSig = (fnTsType?.getCallSignatures?.()?.length ?? 0) > 0;
      if (fnHasCallSig) {
        const reshapedArgs = expr.arguments.slice(1);
        const reshapedProp = ts.factory.createPropertyAccessExpression(fnExpr as ts.LeftHandSideExpression, "bind");
        ts.setTextRange(reshapedProp, propAccess);
        const reshapedCall = ts.factory.createCallExpression(reshapedProp, undefined, reshapedArgs);
        ts.setTextRange(reshapedCall, expr);
        (reshapedCall as any).parent = expr.parent;
        return compileCallExpression(ctx, fctx, reshapedCall as ts.CallExpression);
      }
    }

    // Handle fn.bind(thisArg, ...partialArgs).
    //
    // (#1632a) JS-host mode: lower to `__bind_function(target, thisArg, argsArray,
    // nameHint, lengthHint)` which delegates to `Function.prototype.bind` on the host.
    // The host owns [[BoundTargetFunction]] / [[BoundThis]] / [[BoundArguments]] /
    // .name (`"bound " + target.name`) / .length (max(0, target.length - bound.length)) /
    // [[Call]] / [[Construct]] — see runtime.ts:__bind_function. Wasm closure structs
    // are wrapped via `_wrapWasmClosure` so the host receives a real JS callable.
    //
    // Standalone (--target wasi / noJsHost): fall back to identity-bind (drop partial
    // args, return target unchanged). Documented gap: standalone needs a native
    // bound-function struct, tracked as a follow-up to #1632a.
    //
    // Narrowing: only fires when the receiver's TS type has call signatures. This
    // preserves the legacy "throws on non-function receiver" behavior that a
    // handful of test262 assertions implicitly rely on
    // (e.g. `assert.throws(TypeError, () => nonFn.bind())` and `JSON.bind()`).
    //
    // Exclusion: fn.bind(...)(...) (immediate bind+call) is already handled later
    // with proper argument threading — don't intercept it here.
    if (propAccess.name.text === "bind" && !(ts.isCallExpression(expr.parent) && expr.parent.expression === expr)) {
      const recvTsType = ctx.checker.getTypeAtLocation(propAccess.expression);
      const recvHasCallSig = (recvTsType?.getCallSignatures?.()?.length ?? 0) > 0;
      if (recvHasCallSig) {
        const bindResult = compileFunctionBind(ctx, fctx, expr, propAccess);
        if (bindResult !== undefined) return bindResult;
      }
    }

    // Handle fn.call(thisArg, ...args) and fn.apply(thisArg, argsArray)
    // For standalone functions (no `this`), drop thisArg and call directly.
    // For class methods, use thisArg as the receiver.
    if (propAccess.name.text === "call" || propAccess.name.text === "apply") {
      const isCall = propAccess.name.text === "call";
      const innerExpr = propAccess.expression;

      // Sub-fix 3 (#1596): Function.prototype.{apply,call}.call(fn, ...) reshape.
      // Rewrite `Function.prototype.apply.call(fn, thisArg, argsArr)` to
      // `fn.apply(thisArg, argsArr)` (and analogous for .call.call) so the
      // existing Case 0 / Case 1 handlers fire. Only the outer `.call` form is
      // matched — `Function.prototype.apply.apply(fn, [thisArg, argsArr])` is
      // rare and would need a packed-args reshape.
      if (
        isCall &&
        ts.isPropertyAccessExpression(innerExpr) &&
        (innerExpr.name.text === "apply" || innerExpr.name.text === "call") &&
        ts.isPropertyAccessExpression(innerExpr.expression) &&
        innerExpr.expression.name.text === "prototype" &&
        ts.isIdentifier(innerExpr.expression.expression) &&
        innerExpr.expression.expression.text === "Function" &&
        expr.arguments.length >= 1
      ) {
        const innerMethod = innerExpr.name.text; // "apply" or "call"
        const fnExpr = expr.arguments[0]!;
        const reshapedArgs = expr.arguments.slice(1);
        const reshapedProp = ts.factory.createPropertyAccessExpression(
          fnExpr as ts.LeftHandSideExpression,
          innerMethod,
        );
        ts.setTextRange(reshapedProp, propAccess);
        const reshapedCall = ts.factory.createCallExpression(reshapedProp, undefined, reshapedArgs);
        ts.setTextRange(reshapedCall, expr);
        (reshapedCall as any).parent = expr.parent;
        return compileCallExpression(ctx, fctx, reshapedCall as ts.CallExpression);
      }

      // (#2069) `.call`/`.apply` on a callee declared with an explicit
      // TypeScript `this` parameter (`function f(this: T, …)`). Such a function
      // has a leading `externref` `this` slot in its Wasm signature, so the
      // legacy "evaluate thisArg, drop it" lowering passed `undefined` for
      // `this` AND shifted every user argument into the wrong slot. Rewrite to a
      // direct call that supplies the thisArg as the first positional argument —
      // it lands in param 0 (the `this` slot, boxed to externref by the regular
      // arg coercion) and the remaining args fill the declared params in order.
      // Only fires when the thisArg can be threaded soundly: a named callee with
      // a static this-param, and (for `.apply`) a statically-flattenable args
      // array. Anything else falls through to the legacy paths below.
      if (getExplicitThisParam(ctx, innerExpr) !== undefined && expr.arguments.length > 0) {
        const thisArg = expr.arguments[0]!;
        let directArgs: ts.Expression[] | undefined;
        if (isCall) {
          directArgs = [thisArg, ...expr.arguments.slice(1)];
        } else if (expr.arguments.length === 1) {
          // .apply(thisArg) — no args array
          directArgs = [thisArg];
        } else {
          const argsExpr = expr.arguments[1]!;
          if (ts.isArrayLiteralExpression(argsExpr)) {
            const flattened = flattenStaticArrayElements(argsExpr);
            if (flattened !== undefined) directArgs = [thisArg, ...flattened];
          }
        }
        if (directArgs !== undefined) {
          const directCall = ts.factory.createCallExpression(
            innerExpr as ts.LeftHandSideExpression,
            undefined,
            directArgs,
          );
          ts.setTextRange(directCall, expr);
          (directCall as { parent?: ts.Node }).parent = expr.parent;
          return compileCallExpression(ctx, fctx, directCall as ts.CallExpression);
        }
      }

      // Case 0: (function(){}).call/apply(...) and (() => {}).call/apply(...).
      // A compiled function is a WasmGC funcref/struct, not a JS Function, so a
      // host-side `.apply`/`.call` lookup fails ("apply is not a function").
      // Rewrite statically to a direct invocation of the function expression,
      // dropping thisArg (standalone functions ignore `this`). This reuses the
      // IIFE-inlining path, which also binds `arguments` correctly (#1596).
      {
        let fnExpr: ts.Expression = innerExpr;
        while (ts.isParenthesizedExpression(fnExpr)) fnExpr = fnExpr.expression;
        const isFnLiteral =
          (ts.isFunctionExpression(fnExpr) && fnExpr.asteriskToken === undefined) || ts.isArrowFunction(fnExpr);
        if (isFnLiteral) {
          let directArgs: readonly ts.Expression[] | undefined;
          if (isCall) {
            // fn.call(thisArg, a, b, ...) → fn(a, b, ...)
            directArgs = expr.arguments.slice(1);
          } else if (expr.arguments.length < 2) {
            // fn.apply(thisArg) / fn.apply() → fn()
            directArgs = [];
          } else {
            // fn.apply(thisArg, [a, b, ...]) → fn(a, b, ...). Statically flatten
            // the args-array literal into positional call arguments so the
            // IIFE-inlining path sees a fixed argument count (it binds
            // `arguments` from the literal arg list and does not expand spreads
            // itself). A spread of a nested array literal (`[...[3,4,5]]`, the
            // common test262 shape) is flattened recursively. Anything we
            // cannot statically flatten (dynamic spread source, elided holes)
            // is left to the generic path.
            const argsExpr = expr.arguments[1]!;
            if (ts.isArrayLiteralExpression(argsExpr)) {
              const flattened = flattenStaticArrayElements(argsExpr);
              if (flattened !== undefined) directArgs = flattened;
            }
          }
          if (directArgs !== undefined) {
            // Evaluate the receiver-position thisArg for side effects (spec:
            // arguments are evaluated even though standalone functions ignore
            // `this`). For .call/.apply the thisArg is expr.arguments[0].
            if (expr.arguments.length > 0) {
              const thisType = compileExpression(ctx, fctx, expr.arguments[0]!);
              if (thisType !== null) fctx.body.push({ op: "drop" });
            }
            const directCall = ts.factory.createCallExpression(
              fnExpr as ts.LeftHandSideExpression,
              undefined,
              directArgs,
            );
            ts.setTextRange(directCall, expr);
            (directCall as any).parent = expr.parent;
            return compileCallExpression(ctx, fctx, directCall as ts.CallExpression);
          }
        }
      }

      // Case 1: identifier.call(thisArg, args...) — standalone function
      if (ts.isIdentifier(innerExpr)) {
        const funcName = innerExpr.text;
        let closureInfo = ctx.closureMap.get(funcName);
        const funcIdx = ctx.funcMap.get(funcName);

        if (!closureInfo && funcIdx === undefined) {
          closureInfo = resolveClosureInfoFromLocal(ctx, fctx, funcName);
        }

        if (closureInfo || funcIdx !== undefined) {
          // Evaluate and drop thisArg (first argument) if present
          if (expr.arguments.length > 0) {
            const thisType = compileExpression(ctx, fctx, expr.arguments[0]!);
            if (thisType) {
              fctx.body.push({ op: "drop" });
            }
          }

          if (isCall) {
            // .call(thisArg, arg1, arg2, ...) — remaining args are positional
            const remainingArgs = expr.arguments.slice(1);

            if (closureInfo) {
              // Create a synthetic call expression with remaining args
              const syntheticCall = ts.factory.createCallExpression(
                innerExpr,
                undefined,
                remainingArgs as unknown as readonly ts.Expression[],
              );
              // Copy source file info for error reporting
              (syntheticCall as any).parent = expr.parent;
              return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
            }

            // Check for rest parameters on the callee
            const callRestInfo = ctx.funcRestParams.get(funcName);

            if (callRestInfo) {
              // Calling a rest-param function via .call(): pack trailing args into a GC array
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              // Compile non-rest arguments
              for (let i = 0; i < callRestInfo.restIndex; i++) {
                if (i < remainingArgs.length) {
                  compileExpression(ctx, fctx, remainingArgs[i]!, paramTypes?.[i]);
                } else {
                  pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" }, ctx);
                }
              }
              // Pack remaining arguments into a vec struct (array + length)
              const restArgCount = Math.max(0, remainingArgs.length - callRestInfo.restIndex);
              fctx.body.push({ op: "i32.const", value: restArgCount });
              for (let i = callRestInfo.restIndex; i < remainingArgs.length; i++) {
                compileExpression(ctx, fctx, remainingArgs[i]!, callRestInfo.elemType);
              }
              fctx.body.push({
                op: "array.new_fixed",
                typeIdx: callRestInfo.arrayTypeIdx,
                length: restArgCount,
              });
              fctx.body.push({
                op: "struct.new",
                typeIdx: callRestInfo.vecTypeIdx,
              });
            } else {
              // Regular function call
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              for (let i = 0; i < remainingArgs.length; i++) {
                compileExpression(ctx, fctx, remainingArgs[i]!, paramTypes?.[i]);
              }

              // Supply defaults for missing optional params
              const optInfo = ctx.funcOptionalParams.get(funcName);
              if (optInfo) {
                const numProvided = remainingArgs.length;
                for (const opt of optInfo) {
                  if (opt.index >= numProvided) {
                    pushParamSentinel(fctx, opt.type, ctx, opt);
                  }
                }
              }

              // Pad any remaining missing arguments with defaults
              if (paramTypes) {
                const providedCount = Math.min(remainingArgs.length, paramTypes.length);
                const optFilledCount = ctx.funcOptionalParams.get(funcName)
                  ? ctx.funcOptionalParams.get(funcName)!.filter((o) => o.index >= remainingArgs.length).length
                  : 0;
                const totalPushed = providedCount + optFilledCount;
                for (let i = totalPushed; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!, ctx);
                }
              }
            }

            maybeSetArgcForKnownCall(
              ctx,
              fctx,
              funcName,
              remainingArgs.length,
              getFuncParamTypes(ctx, funcIdx!)?.length ?? remainingArgs.length,
            );
            const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
            fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

            // Use actual Wasm return type — TS checker reports `any` for .call()/.apply()
            // which resolves to externref, but the actual function may return f64/i32/ref.
            if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalFuncIdx) ?? VOID_RESULT;
          }
          // .apply(thisArg, argsArray) — spread array literal elements as positional args
          if (!isCall && expr.arguments.length >= 2) {
            const argsExpr = expr.arguments[1]!;
            if (ts.isArrayLiteralExpression(argsExpr)) {
              const elements = argsExpr.elements;
              if (closureInfo) {
                const syntheticCall = ts.factory.createCallExpression(
                  innerExpr,
                  undefined,
                  elements as unknown as readonly ts.Expression[],
                );
                (syntheticCall as any).parent = expr.parent;
                return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
              }
              const applyRestInfo = ctx.funcRestParams.get(funcName);
              if (applyRestInfo) {
                // Rest-param function via .apply(): pack trailing elements into vec
                const paramTypes = getFuncParamTypes(ctx, funcIdx!);
                for (let i = 0; i < applyRestInfo.restIndex; i++) {
                  if (i < elements.length) {
                    compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i]);
                  } else {
                    pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" }, ctx);
                  }
                }
                const restArgCount = Math.max(0, elements.length - applyRestInfo.restIndex);
                fctx.body.push({ op: "i32.const", value: restArgCount });
                for (let i = applyRestInfo.restIndex; i < elements.length; i++) {
                  compileExpression(ctx, fctx, elements[i]!, applyRestInfo.elemType);
                }
                fctx.body.push({
                  op: "array.new_fixed",
                  typeIdx: applyRestInfo.arrayTypeIdx,
                  length: restArgCount,
                });
                fctx.body.push({
                  op: "struct.new",
                  typeIdx: applyRestInfo.vecTypeIdx,
                });
              } else {
                const paramTypes = getFuncParamTypes(ctx, funcIdx!);
                for (let i = 0; i < elements.length; i++) {
                  compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i]);
                }
                const optInfo = ctx.funcOptionalParams.get(funcName);
                if (optInfo) {
                  for (const opt of optInfo) {
                    if (opt.index >= elements.length) pushParamSentinel(fctx, opt.type, ctx, opt);
                  }
                }
                // Pad any remaining missing arguments with defaults
                if (paramTypes) {
                  const providedCount = Math.min(elements.length, paramTypes.length);
                  const optFilledCount = ctx.funcOptionalParams.get(funcName)
                    ? ctx.funcOptionalParams.get(funcName)!.filter((o) => o.index >= elements.length).length
                    : 0;
                  const totalPushed = providedCount + optFilledCount;
                  for (let i = totalPushed; i < paramTypes.length; i++) {
                    pushDefaultValue(fctx, paramTypes[i]!, ctx);
                  }
                }
              }
              const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
              maybeSetArgcForKnownCall(
                ctx,
                fctx,
                funcName,
                elements.length,
                getFuncParamTypes(ctx, finalFuncIdx)?.length ?? elements.length,
              );
              fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
              // Use actual Wasm return type for .apply()
              if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
              return getWasmFuncReturnType(ctx, finalFuncIdx) ?? VOID_RESULT;
            }
          }
          // .apply() with no args array — call with no args
          if (!isCall) {
            if (closureInfo) {
              const syntheticCall = ts.factory.createCallExpression(innerExpr, undefined, []);
              (syntheticCall as any).parent = expr.parent;
              return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
            }
            const applyNoArgsRestInfo = ctx.funcRestParams.get(funcName);
            if (applyNoArgsRestInfo) {
              // Rest-param function with no args: push empty vec
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              for (let i = 0; i < applyNoArgsRestInfo.restIndex; i++) {
                pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" }, ctx);
              }
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({
                op: "array.new_fixed",
                typeIdx: applyNoArgsRestInfo.arrayTypeIdx,
                length: 0,
              });
              fctx.body.push({
                op: "struct.new",
                typeIdx: applyNoArgsRestInfo.vecTypeIdx,
              });
            } else {
              const optInfo = ctx.funcOptionalParams.get(funcName);
              if (optInfo) {
                for (const opt of optInfo) pushParamSentinel(fctx, opt.type, ctx, opt);
              }
              // Pad any remaining missing arguments with defaults
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              if (paramTypes) {
                const optFilledCount = ctx.funcOptionalParams.get(funcName)
                  ? ctx.funcOptionalParams.get(funcName)!.length
                  : 0;
                for (let i = optFilledCount; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!, ctx);
                }
              }
            }
            const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
            maybeSetArgcForKnownCall(ctx, fctx, funcName, 0, getFuncParamTypes(ctx, finalFuncIdx)?.length ?? 0);
            fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
            // Use actual Wasm return type for .apply() with no args
            if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalFuncIdx) ?? VOID_RESULT;
          }
        }
      }

      // Case 2: obj.method.call/apply — method call with different receiver
      if (ts.isPropertyAccessExpression(innerExpr)) {
        const methodName = innerExpr.name.text;
        const objExpr = innerExpr.expression;
        const objType = ctx.checker.getTypeAtLocation(objExpr);

        // Case 2a: Type.prototype.method.call(receiver, ...args)
        // Use __proto_method_call host import to correctly dispatch through
        // the Type's prototype, even when receiver doesn't inherit from Type.
        // e.g. Array.prototype.every.call(fnObj, cb) where fnObj is a Function.
        if (
          ts.isPropertyAccessExpression(objExpr) &&
          objExpr.name.text === "prototype" &&
          ts.isIdentifier(objExpr.expression) &&
          isCall &&
          expr.arguments.length >= 1
        ) {
          const typeName = objExpr.expression.text;
          const isBuiltinRegExpPrototype = typeName === "RegExp" && isGlobalRegExpIdentifier(ctx, objExpr.expression);
          if (ctx.standalone && isBuiltinRegExpPrototype) {
            if (methodName === "test" || methodName === "exec") {
              const receiverArg = expr.arguments[0]!;
              const syntheticProp = ts.factory.createPropertyAccessExpression(receiverArg, methodName);
              ts.setTextRange(syntheticProp, innerExpr);
              const syntheticCall = ts.factory.createCallExpression(
                syntheticProp,
                undefined,
                Array.from(expr.arguments).slice(1),
              );
              ts.setTextRange(syntheticCall, expr);
              (syntheticCall as any).parent = expr.parent;
              const standaloneRegExpMethod =
                methodName === "exec"
                  ? tryCompileStandaloneRegExpExec(ctx, fctx, syntheticCall, syntheticProp)
                  : tryCompileStandaloneRegExpTest(ctx, fctx, syntheticCall, syntheticProp);
              if (standaloneRegExpMethod !== undefined) return standaloneRegExpMethod;
            }
            reportError(
              ctx,
              expr,
              `Codegen error: standalone RegExp literal-substring backend does not support ` +
                `RegExp.prototype.${methodName}.call(...) (#682/#1474). Use RegExp.prototype.test/exec ` +
                `with a plain static pattern and no flags, or recompile without --target standalone.`,
            );
            return null;
          }
          // (#1888 Slice 3) Standalone borrowed-method dispatch
          // `Type.prototype.<m>.call(recv, …args)` (ES §7.3.14 Call). The host
          // `__proto_method_call` is refused under --target standalone (no JS
          // runtime). Per the "compile away" principle, typeName + methodName
          // are compile-time constants here, so we dispatch STATICALLY by
          // synthesising `recv.<m>(…args)` and routing it through the native
          // member-call path — no new runtime helper, no funcIdx shift.
          //   - String: route to compileNativeStringMethodCall, which coerces
          //     the borrowed receiver to a native string ($NativeString brand)
          //     and emits the __str_* fast path. The covered method set is the
          //     ones whose native helper round-trips correctly (see below).
          //   - Object.hasOwnProperty/propertyIsEnumerable: synthesise the bare
          //     call, which already has a clean native standalone path
          //     (compilePropertyIntrospection → __hasOwnProperty /
          //     __propertyIsEnumerable) while preserving closed class-struct
          //     field/method semantics.
          //   - Object.isPrototypeOf: route directly to the native open-object
          //     prototype-chain helper. Array/Number/Boolean/Function have no
          //     clean native borrowed path yet → refuse-loud below (Array brand
          //     arm rides on #6407). Never a silent-wrong answer.
          if (ctx.standalone && expr.arguments.length >= 1 && !isBuiltinRegExpPrototype) {
            // Native String methods whose __str_* helper + return marshaling
            // round-trip correctly standalone (verified end-to-end). Methods
            // outside this set refuse-loud rather than risk a wrong result.
            const STANDALONE_STR_PROTO_METHODS = new Set<string>([
              "charAt",
              "charCodeAt",
              "codePointAt",
              "indexOf",
              "lastIndexOf",
              "includes",
              "startsWith",
              "endsWith",
              "toUpperCase",
              "toLowerCase",
              "trim",
              "trimStart",
              "trimEnd",
              "concat",
              "repeat",
              "padStart",
              "padEnd",
              "substring",
              "slice",
              "at",
            ]);
            const synthesizeBorrowedCall = (): { prop: ts.PropertyAccessExpression; call: ts.CallExpression } => {
              const receiverArg = expr.arguments[0]!;
              const restArgs = Array.from(expr.arguments).slice(1);
              const sProp = ts.factory.createPropertyAccessExpression(receiverArg, methodName);
              ts.setTextRange(sProp, innerExpr);
              (sProp as unknown as { parent: ts.Node }).parent = expr;
              const sCall = ts.factory.createCallExpression(sProp, undefined, restArgs);
              ts.setTextRange(sCall, expr);
              (sCall as unknown as { parent: ts.Node }).parent = expr.parent;
              return { prop: sProp, call: sCall };
            };

            if (typeName === "String" && STANDALONE_STR_PROTO_METHODS.has(methodName)) {
              const { prop, call } = synthesizeBorrowedCall();
              const strResult = compileNativeStringMethodCall(ctx, fctx, call, prop, methodName);
              if (strResult !== null) return strResult;
              // Native string path declined (unexpected shape) — fall through
              // to the refuse-loud below rather than the host import.
            } else if (
              typeName === "Object" &&
              (methodName === "hasOwnProperty" || methodName === "propertyIsEnumerable")
            ) {
              // Object.prototype.{hasOwnProperty,propertyIsEnumerable}.call(o, k)
              // → o.<method>(k), which routes through compilePropertyIntrospection.
              const { prop, call } = synthesizeBorrowedCall();
              const introspectionResult = compilePropertyIntrospection(ctx, fctx, prop, call);
              if (introspectionResult !== null) return introspectionResult;
            } else if (typeName === "Object" && methodName === "isPrototypeOf") {
              const protoIdx = ensureLateImport(
                ctx,
                "__isPrototypeOf",
                [{ kind: "externref" }, { kind: "externref" }],
                [{ kind: "i32" }],
              );
              flushLateImportShifts(ctx, fctx);
              if (protoIdx !== undefined) {
                const receiverType = compileExpression(ctx, fctx, expr.arguments[0]!);
                if (receiverType && receiverType.kind !== "externref") {
                  coerceType(ctx, fctx, receiverType, { kind: "externref" });
                }
                if (expr.arguments[1]) {
                  const candidateType = compileExpression(ctx, fctx, expr.arguments[1]!);
                  if (candidateType && candidateType.kind !== "externref") {
                    coerceType(ctx, fctx, candidateType, { kind: "externref" });
                  }
                } else {
                  fctx.body.push({ op: "ref.null.extern" });
                }
                fctx.body.push({ op: "call", funcIdx: protoIdx });
                return { kind: "i32" };
              }
            }

            // Unsupported (typeName, methodName) under standalone: refuse-loud,
            // never leak the host import or return a silent-wrong value.
            const cite =
              typeName === "Array"
                ? "the Array brand arm rides on #6407 ($Vec element retrieval)"
                : typeName === "Object"
                  ? "only Object.prototype hasOwnProperty/propertyIsEnumerable/isPrototypeOf borrowed calls are wired (valueOf is a follow-on)"
                  : "this prototype's borrowed-method brand arm is not yet native";
            reportError(
              ctx,
              expr,
              `Codegen error: ${typeName}.prototype.${methodName}.call(...) is not yet ` +
                `supported in --target standalone (#1888 Slice 3/4) — ${cite}. ` +
                `Recompile without --target standalone, or call the method directly on a typed receiver.`,
            );
            return null;
          }
          if (
            (typeName === "String" ||
              typeName === "Number" ||
              typeName === "Array" ||
              typeName === "Boolean" ||
              typeName === "Object" ||
              typeName === "Function" ||
              isBuiltinRegExpPrototype) &&
            expr.arguments.length >= 1
          ) {
            const protoCallIdx = ensureLateImport(
              ctx,
              "__proto_method_call",
              [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
              [{ kind: "externref" }],
            );
            const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
            const arrPushIdx = ensureLateImport(
              ctx,
              "__js_array_push",
              [{ kind: "externref" }, { kind: "externref" }],
              [],
            );
            flushLateImportShifts(ctx, fctx);

            if (protoCallIdx !== undefined && arrNewIdx !== undefined && arrPushIdx !== undefined) {
              // Push typeName string
              addStringConstantGlobal(ctx, typeName);
              fctx.body.push(...stringConstantExternrefInstrs(ctx, typeName));

              // Push methodName string
              addStringConstantGlobal(ctx, methodName);
              fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));

              // Compile receiver (first argument to .call).
              // (#1442) When the receiver's static TS type is `boolean`, the
              // i32 → externref auto-coercion uses `__box_number` and arrives
              // host-side as `Number(0)` / `Number(1)`. That makes
              // `String.prototype.trim.call(true)` return `"1"` instead of
              // `"true"`. Box booleans through `__box_boolean` so the host
              // gets a real `Boolean` wrapper, then String() / ToString
              // produces the spec-correct `"true"` / `"false"`.
              const receiverArg = expr.arguments[0]!;
              const receiverTsType = ctx.checker.getTypeAtLocation(receiverArg);
              if (isBooleanType(receiverTsType)) {
                const recvWasm = compileExpression(ctx, fctx, receiverArg);
                if (recvWasm && recvWasm.kind === "i32") {
                  addUnionImports(ctx);
                  flushLateImportShifts(ctx, fctx);
                  const boxBoolIdx = ctx.funcMap.get("__box_boolean");
                  if (boxBoolIdx !== undefined) {
                    fctx.body.push({ op: "call", funcIdx: boxBoolIdx });
                  } else {
                    fctx.body.push({ op: "extern.convert_any" });
                  }
                } else if (recvWasm && recvWasm.kind !== "externref") {
                  fctx.body.push({ op: "extern.convert_any" });
                } else if (recvWasm === null) {
                  fctx.body.push({ op: "ref.null.extern" });
                }
              } else {
                const recvType = compileExpression(ctx, fctx, receiverArg, { kind: "externref" });
                if (recvType && recvType.kind !== "externref") {
                  fctx.body.push({ op: "extern.convert_any" });
                }
                if (recvType === null) {
                  fctx.body.push({ op: "ref.null.extern" });
                }
              }

              // Build args array from remaining arguments
              const remainingArgs = Array.from(expr.arguments).slice(1);
              const argsLocal = allocLocal(fctx, `__pmc_args_${fctx.locals.length}`, { kind: "externref" });
              fctx.body.push({ op: "call", funcIdx: arrNewIdx });
              fctx.body.push({ op: "local.set", index: argsLocal });
              for (const arg of remainingArgs) {
                fctx.body.push({ op: "local.get", index: argsLocal });
                const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
                if (argType && argType.kind !== "externref") {
                  fctx.body.push({ op: "extern.convert_any" });
                }
                if (argType === null) {
                  fctx.body.push({ op: "ref.null.extern" });
                }
                fctx.body.push({ op: "call", funcIdx: arrPushIdx });
              }
              fctx.body.push({ op: "local.get", index: argsLocal });

              // Call __proto_method_call(typeName, methodName, receiver, args)
              fctx.body.push({ op: "call", funcIdx: protoCallIdx });
              return { kind: "externref" };
            }
          }
        }

        // Resolve class name from the object's type
        let className = objType.getSymbol()?.name;
        if (className && !ctx.classSet.has(className)) {
          className = ctx.classExprNameMap.get(className) ?? className;
        }

        // Also try struct name
        if (!className || !ctx.classSet.has(className)) {
          className = resolveStructName(ctx, objType) ?? undefined;
        }

        if (className && (ctx.classSet.has(className) || ctx.funcMap.has(`${className}_${methodName}`))) {
          const fullName = `${className}_${methodName}`;
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined && expr.arguments.length > 0) {
            // First argument is the thisArg (receiver).
            // For class methods called via .call()/.apply() the receiver might
            // not actually be an instance of the class (e.g. `method.call({})`).
            // Without a brand check, the downstream ref.cast traps with
            // uncatchable "illegal cast". Instead, emit a ref.test guard and
            // throw a catchable TypeError on mismatch — matches the ES
            // private-field brand-check semantics (#826, class/elements
            // illegal_cast bucket).
            const selfParamTypes = getFuncParamTypes(ctx, funcIdx);
            const selfParamType = selfParamTypes?.[0];
            const thisArgType = compileExpression(ctx, fctx, expr.arguments[0]!);
            if (
              thisArgType &&
              selfParamType &&
              (selfParamType.kind === "ref" || selfParamType.kind === "ref_null") &&
              (thisArgType.kind === "externref" ||
                thisArgType.kind === "anyref" ||
                thisArgType.kind === "eqref" ||
                ((thisArgType.kind === "ref" || thisArgType.kind === "ref_null") &&
                  (thisArgType as { typeIdx: number }).typeIdx !== (selfParamType as { typeIdx: number }).typeIdx))
            ) {
              const selfTypeIdx = (selfParamType as { typeIdx: number }).typeIdx;
              if (thisArgType.kind === "externref") {
                fctx.body.push({ op: "any.convert_extern" });
              }
              const thisTmpType: ValType = { kind: "anyref" };
              const thisTmp = allocTempLocal(fctx, thisTmpType);
              fctx.body.push({ op: "local.tee", index: thisTmp } as Instr);
              fctx.body.push({ op: "ref.test", typeIdx: selfTypeIdx } as Instr);
              fctx.body.push({ op: "i32.eqz" } as Instr);
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: typeErrorThrowInstrs(ctx, expr),
              } as Instr);
              fctx.body.push({ op: "local.get", index: thisTmp } as Instr);
              fctx.body.push({ op: "ref.cast", typeIdx: selfTypeIdx } as Instr);
              releaseTempLocal(fctx, thisTmp);
            }

            if (isCall) {
              // .call(thisArg, arg1, arg2, ...) — remaining args are positional
              const paramTypes = getFuncParamTypes(ctx, funcIdx);
              // User-visible param count excludes self (param 0);
              // .call() args start at index 1 (index 0 is thisArg)
              const callParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length - 1;
              for (let i = 1; i < expr.arguments.length; i++) {
                if (i - 1 < callParamCount) {
                  compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
                } else {
                  // Extra argument beyond method's parameter count — evaluate for
                  // side effects (JS semantics) and discard the result
                  const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                  if (extraType !== null) {
                    fctx.body.push({ op: "drop" });
                  }
                }
              }
              // Pad missing arguments with defaults (skip self at index 0)
              if (paramTypes) {
                for (let i = expr.arguments.length; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!, ctx);
                }
              }
            } else if (expr.arguments.length >= 2 && ts.isArrayLiteralExpression(expr.arguments[1]!)) {
              // .apply(thisArg, [arg1, arg2, ...]) — spread array literal
              const elements = (expr.arguments[1] as ts.ArrayLiteralExpression).elements;
              const paramTypes = getFuncParamTypes(ctx, funcIdx);
              // User-visible param count excludes self (param 0)
              const applyParamCount = paramTypes ? paramTypes.length - 1 : elements.length;
              for (let i = 0; i < elements.length; i++) {
                if (i < applyParamCount) {
                  compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i + 1]); // param 0 = self
                } else {
                  // Extra argument beyond method's parameter count — evaluate for
                  // side effects (JS semantics) and discard the result
                  const extraType = compileExpression(ctx, fctx, elements[i]!);
                  if (extraType !== null) {
                    fctx.body.push({ op: "drop" });
                  }
                }
              }
              // Pad missing arguments with defaults (skip self at index 0)
              if (paramTypes) {
                for (let i = elements.length + 1; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!, ctx);
                }
              }
            }

            // Re-lookup funcIdx: argument compilation may trigger addUnionImports
            const finalCallIdx = ctx.funcMap.get(fullName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalCallIdx });

            // Use actual Wasm return type for .call()/.apply() on class methods
            if (wasmFuncReturnsVoid(ctx, finalCallIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalCallIdx) ?? VOID_RESULT;
          }
        }
      }
    }

    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "console" &&
      (propAccess.name.text === "log" ||
        propAccess.name.text === "warn" ||
        propAccess.name.text === "error" ||
        propAccess.name.text === "info" ||
        propAccess.name.text === "debug")
    ) {
      return compileConsoleCall(ctx, fctx, expr, propAccess.name.text);
    }

    // (#1490) Non-WASI Node.js host mode: process.exit(code) and process.cwd().
    // process.exit routes to the __process_exit host import (calls real process.exit
    // when running under Node). process.cwd() returns a string via __get_process_cwd.
    if (!ctx.wasi && ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "process") {
      const isShadowed = fctx.localMap.has("process") || (fctx.boxedCaptures?.has("process") ?? false);
      if (!isShadowed) {
        const procMethod = propAccess.name.text;
        if (procMethod === "exit") {
          const idx = ensureLateImport(ctx, "__process_exit", [{ kind: "f64" }], []);
          flushLateImportShifts(ctx, fctx);
          if (idx !== undefined) {
            if (expr.arguments.length >= 1) {
              compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
            } else {
              fctx.body.push({ op: "f64.const", value: 0 });
            }
            fctx.body.push({ op: "call", funcIdx: idx });
          }
          return VOID_RESULT;
        }
        if (procMethod === "cwd") {
          const idx = ensureLateImport(ctx, "__get_process_cwd", [], [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          if (idx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: idx });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          return { kind: "externref" };
        }
      }
    }

    // (#1503) Web Crypto host imports: crypto.randomUUID() / crypto.getRandomValues(buf).
    // Available wherever the host exposes a `crypto` global (browsers + Node 19+).
    // In WASI mode there is no JS host, so the imports are still added but resolve
    // to a throw at runtime (no silent fallback to Math.random — that would be a
    // security trap, see issue #1503). Shadow-aware.
    if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "crypto") {
      const isShadowed = fctx.localMap.has("crypto") || (fctx.boxedCaptures?.has("crypto") ?? false);
      if (!isShadowed) {
        const cryptoMethod = propAccess.name.text;
        if (cryptoMethod === "randomUUID") {
          const idx = ensureLateImport(ctx, "__crypto_random_uuid", [], [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          if (idx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: idx });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          return { kind: "externref" };
        }
        if (cryptoMethod === "getRandomValues") {
          // Compile the typed-array argument. Uint8Array compiles to a vec
          // struct typed `ref_null $vec_f64`. We need to pass the RAW
          // extern-wrapped vec to the host (so the host can call back
          // `__vec_set_byte(vec, i, byte)` and mutate the same struct).
          // The generic coerceType path would wrap the vec with
          // `__make_iterable` (so JS sees a real iterable) — but that
          // wrapping strips the vec identity, leaving the host unable to
          // ref.test against the vec type. Emit `extern.convert_any`
          // directly to bypass `__make_iterable`.
          const idx = ensureLateImport(
            ctx,
            "__crypto_get_random_values",
            [{ kind: "externref" }],
            [{ kind: "externref" }],
          );
          if (expr.arguments.length >= 1) {
            const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
            if (argType?.kind === "ref" || argType?.kind === "ref_null") {
              fctx.body.push({ op: "extern.convert_any" } as Instr);
            } else if (argType && argType.kind !== "externref") {
              // Fall back to the standard coerce for non-ref result types.
              coerceType(ctx, fctx, argType, { kind: "externref" });
            }
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          flushLateImportShifts(ctx, fctx);
          if (idx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: idx });
          } else {
            // Fallback: pop the arg and push null so the stack stays balanced.
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "ref.null.extern" });
          }
          return { kind: "externref" };
        }
      }
    }

    // WASI mode: process.exit(code) -> proc_exit(code)
    if (
      ctx.wasi &&
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "process" &&
      propAccess.name.text === "exit" &&
      ctx.wasiProcExitIdx >= 0
    ) {
      if (expr.arguments.length >= 1) {
        // #1801: `proc_exit` takes an i32 exit code. Compiling the argument
        // with expected type `{ kind: "i32" }` already delivers an i32 on the
        // stack (a numeric literal lowers directly to `i32.const N`, and
        // f64-valued expressions are truncated by coerceType). The previous
        // code *also* pushed `i32.trunc_sat_f64_s`, which expects an f64
        // operand — so the i32 already on the stack made the module fail
        // `WebAssembly.validate()` ("i32.trunc_sat_f64_s expected type f64,
        // found ... i32"). The expected-type compile and the truncation are
        // mutually exclusive; keep the former, drop the latter.
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "i32" });
      } else {
        fctx.body.push({ op: "i32.const", value: 0 } as Instr);
      }
      fctx.body.push({ op: "call", funcIdx: ctx.wasiProcExitIdx });
      return VOID_RESULT;
    }

    if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "Math") {
      const mathResult = compileMathCall(ctx, fctx, propAccess.name.text, expr);
      if (mathResult !== undefined) return mathResult;
      // Unknown Math method — fall through to generic call handling
      // (e.g. Array.prototype.every.call(Math, ...) rewritten as Math.every(...))
    }

    // Handle Number.isNaN(n) and Number.isInteger(n)
    if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "Number") {
      const method = propAccess.name.text;
      // #2034: `Number.is*` predicates must NOT coerce their argument — a
      // non-Number value is `false` (ES §21.1.2.x). compileNumberIsPredicate
      // guards an any-typed argument with `__typeof_number` before applying the
      // numeric test; a static number keeps the direct f64 fast path.
      if (method === "isNaN" && expr.arguments.length >= 1) {
        // NaN !== NaN is true; for any other number it's false.
        return compileNumberIsPredicate(ctx, fctx, expr.arguments[0]!, (v) => [
          { op: "local.get", index: v },
          { op: "local.get", index: v },
          { op: "f64.ne" } as Instr,
        ]);
      }
      if (method === "isInteger" && expr.arguments.length >= 1) {
        // n === trunc(n) && isFinite(n)
        return compileNumberIsPredicate(ctx, fctx, expr.arguments[0]!, (v) => [
          { op: "local.get", index: v },
          { op: "local.get", index: v },
          { op: "f64.trunc" } as Instr,
          { op: "f64.eq" } as Instr,
          // finite: n - n === 0 (Infinity - Infinity = NaN, NaN !== 0)
          { op: "local.get", index: v },
          { op: "local.get", index: v },
          { op: "f64.sub" } as Instr,
          { op: "f64.const", value: 0 },
          { op: "f64.eq" } as Instr,
          { op: "i32.and" } as Instr,
        ]);
      }
      if (method === "isFinite" && expr.arguments.length >= 1) {
        // isFinite(n) → n - n === 0.0
        return compileNumberIsPredicate(ctx, fctx, expr.arguments[0]!, (v) => [
          { op: "local.get", index: v },
          { op: "local.get", index: v },
          { op: "f64.sub" } as Instr,
          { op: "f64.const", value: 0 },
          { op: "f64.eq" } as Instr,
        ]);
      }
      if (method === "isSafeInteger" && expr.arguments.length >= 1) {
        // isSafeInteger(n) = isInteger(n) && abs(n) <= MAX_SAFE_INTEGER
        return compileNumberIsPredicate(ctx, fctx, expr.arguments[0]!, (v) => [
          // isInteger: n === trunc(n) && isFinite(n)
          { op: "local.get", index: v },
          { op: "local.get", index: v },
          { op: "f64.trunc" } as Instr,
          { op: "f64.eq" } as Instr,
          { op: "local.get", index: v },
          { op: "local.get", index: v },
          { op: "f64.sub" } as Instr,
          { op: "f64.const", value: 0 },
          { op: "f64.eq" } as Instr,
          { op: "i32.and" } as Instr,
          // abs(n) <= MAX_SAFE_INTEGER
          { op: "local.get", index: v },
          { op: "f64.abs" } as Instr,
          { op: "f64.const", value: Number.MAX_SAFE_INTEGER },
          { op: "f64.le" } as Instr,
          { op: "i32.and" } as Instr,
        ]);
      }
      if ((method === "parseFloat" || method === "parseInt") && expr.arguments.length >= 1) {
        // Delegate to the global parseInt / parseFloat host import
        const funcIdx = ctx.funcMap.get(method === "parseFloat" ? "parseFloat" : "parseInt");
        if (funcIdx !== undefined) {
          compileExpression(ctx, fctx, expr.arguments[0]!, {
            kind: "externref",
          });
          if (method === "parseInt") {
            if (expr.arguments.length >= 2) {
              compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
            } else {
              // No radix supplied — push NaN sentinel so runtime treats it as undefined
              fctx.body.push({ op: "f64.const", value: NaN });
            }
          }
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "f64" };
        }
      }
    }

    // (#1467) Error.isError(v) — ES2025 static method.
    // Returns true for any value with an [[ErrorData]] internal slot. Host
    // import returns i32 (0/1); coerce to f64 / leave as i32 depending on
    // caller context — we return i32 so callers can use it as a boolean.
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Error" &&
      propAccess.name.text === "isError" &&
      expr.arguments.length >= 1
    ) {
      const isErrorIdx = ensureLateImport(ctx, "__error_isError", [{ kind: "externref" }], [{ kind: "i32" }]);
      if (isErrorIdx !== undefined) {
        const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        if (argType && argType.kind !== "externref") {
          if (argType.kind === "ref" || argType.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          } else {
            // Numbers, bools, etc. aren't errors — drop and push 0.
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "i32.const", value: 0 });
            return { kind: "i32" };
          }
        }
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: isErrorIdx });
        return { kind: "i32" };
      }
    }

    // Handle Array.isArray(x) — compile-time type check
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Array" &&
      propAccess.name.text === "isArray" &&
      expr.arguments.length >= 1
    ) {
      // Check the TypeScript type of the argument at compile time
      const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
      const argWasmType = resolveWasmType(ctx, argTsType);
      // externref args carry values whose array-ness can't be decided
      // statically. Two runtime cases must both be handled:
      //   (#1678) a compiled native array materialised into the externref slot
      //     (e.g. a rest/array binding default whose value is `any`-typed
      //     becomes a __vec_externref) — detected via `ref.test` against every
      //     registered vec struct type. Pure Wasm, works in standalone/WASI.
      //   (#1328) a genuine host JS value (e.g. a RegExp match result) — these
      //     are not WasmGC vec structs, so fall back to the host predicate
      //     `__extern_is_array` when a JS host is present.
      // We OR the two checks so neither case regresses; in standalone mode the
      // host predicate is simply absent and only the `ref.test` path runs.
      if (argWasmType.kind === "externref") {
        const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        if (argType && argType.kind !== "externref") {
          // Non-externref values (numbers, bools) are never arrays.
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: 0 });
          return { kind: "i32" };
        }
        emitArrayIsArrayExternrefPredicate(ctx, fctx);
        return { kind: "i32" };
      }
      // If the wasm type is a ref to a vec struct (array), return true; otherwise false
      const isArr = argWasmType.kind === "ref" || argWasmType.kind === "ref_null";
      // Still compile the argument for side effects, then drop it
      const argSideType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argSideType) fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: isArr ? 1 : 0 });
      return { kind: "i32" };
    }

    // Handle String.fromCharCode(code) — native helper (nativeStrings) or host import
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "String" &&
      propAccess.name.text === "fromCharCode" &&
      expr.arguments.length >= 1
    ) {
      // #1598: nativeStrings mode (forced on for --target wasi / standalone) uses
      // a pure-Wasm __str_fromCharCode helper — no env.String_fromCharCode import.
      // #2088: the variadic concat fold is shared via compileFromCharCodeFamily.
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        const helperIdx = ctx.nativeStrHelpers.get("__str_fromCharCode");
        if (helperIdx !== undefined) {
          const r = compileFromCharCodeFamily(ctx, fctx, expr, { native: true, helperIdx });
          if (r !== null) return r;
        }
      }
      const funcIdx = ctx.funcMap.get("String_fromCharCode");
      if (funcIdx !== undefined) {
        // #2122: fromCharCode is variadic (ES §22.1.2.1). The host import is
        // 1-arg, so each code unit produces a 1-char string joined via the
        // js-string `concat` import — register it before the shared fold so the
        // host repr can resolve it.
        if (expr.arguments.length > 1) addStringImports(ctx);
        const r = compileFromCharCodeFamily(ctx, fctx, expr, { native: false, helperIdx: funcIdx });
        if (r === null) return r;
        // In fast mode, marshal externref string to native string.
        if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
          ensureNativeStringExternBridge(ctx);
          flushLateImportShifts(ctx, fctx);
          const fromExternIdx = ctx.nativeStrHelpers.get("__str_from_extern");
          if (fromExternIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: fromExternIdx });
          }
          return nativeStringType(ctx);
        }
        return { kind: "externref" };
      }
    }

    // Handle String.fromCodePoint(code) — native helper (nativeStrings) or host import
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "String" &&
      propAccess.name.text === "fromCodePoint" &&
      expr.arguments.length >= 1
    ) {
      // Native strings mode: use pure-Wasm __str_fromCodePoint (no host import).
      // #2088: shares the variadic concat fold via compileFromCharCodeFamily.
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        const helperIdx = ctx.nativeStrHelpers.get("__str_fromCodePoint");
        if (helperIdx !== undefined) {
          const r = compileFromCharCodeFamily(ctx, fctx, expr, { native: true, helperIdx });
          if (r !== null) return r;
        }
      }
      // Host import path (non-nativeStrings mode)
      const funcIdx = ctx.funcMap.get("String_fromCodePoint");
      if (funcIdx !== undefined) {
        // #2122: variadic — each code point produces a string joined via the
        // js-string `concat` import; register it before the shared fold.
        if (expr.arguments.length > 1) addStringImports(ctx);
        const r = compileFromCharCodeFamily(ctx, fctx, expr, { native: false, helperIdx: funcIdx });
        if (r === null) return r;
        return { kind: "externref" };
      }
    }

    // Handle Array.fromAsync(items, mapFn?, thisArg?) — ES2024 (#1517)
    // Delegates to host import which implements the spec algorithm using
    // native `for await...of` over async iterables, sync iterables (awaiting
    // each value), and array-likes. Returns a Promise externref; the outer
    // `await` unwraps it via the standard async/await machinery.
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Array" &&
      propAccess.name.text === "fromAsync"
    ) {
      // items
      if (expr.arguments.length >= 1) {
        const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      // mapFn
      if (expr.arguments.length >= 2) {
        const mapType = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
        if (mapType && mapType.kind !== "externref") coerceType(ctx, fctx, mapType, { kind: "externref" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      // thisArg
      if (expr.arguments.length >= 3) {
        const thisType = compileExpression(ctx, fctx, expr.arguments[2]!, { kind: "externref" });
        if (thisType && thisType.kind !== "externref") coerceType(ctx, fctx, thisType, { kind: "externref" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      const fromAsyncIdx = ensureLateImport(
        ctx,
        "__array_from_async",
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (fromAsyncIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: fromAsyncIdx });
        return { kind: "externref" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle Array.from(arr) — array copy
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Array" &&
      propAccess.name.text === "from" &&
      expr.arguments.length >= 1
    ) {
      const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
      const argWasmType = resolveWasmType(ctx, argTsType);
      // (#1382 Phase 2) The native fast-path applies only when there's
      // NO mapFn. With a mapFn, route to the host fallback below — the
      // runtime's `__array_from` materializes the wasm vec via
      // `__vec_len`/`__vec_get` and wraps the mapFn closure via
      // `_wrapWasmClosure`. The fast path's `array.copy` would silently
      // drop the mapFn.
      const hasMapFn = expr.arguments.length >= 2;
      // (#1470) Array.from(string) without a mapFn — the string iterable
      // yields code points (§23.1.2.1 via §22.1.5.1). In native-strings mode
      // materialize the char vec in pure Wasm. Without this the string fell
      // into the host `__array_from` fallback below, which both leaks a JS
      // host import and (post late-import shift) emitted an invalid module
      // under --target standalone. Tentatively compile and only commit when
      // the argument genuinely lowers to a native string ref (#1610 pattern).
      if (!hasMapFn && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && isStringType(argTsType)) {
        const bodyLenBefore = fctx.body.length;
        const t = compileExpression(ctx, fctx, expr.arguments[0]!);
        if (
          t &&
          (t.kind === "ref" || t.kind === "ref_null") &&
          (t.typeIdx === ctx.anyStrTypeIdx || t.typeIdx === ctx.nativeStrTypeIdx)
        ) {
          if (t.kind === "ref_null") {
            fctx.body.push({ op: "ref.as_non_null" } as Instr);
          }
          const { funcIdx: toCharVecIdx, vecTypeIdx: nstrVecTypeIdx } = ensureStrToCharVecHelper(ctx);
          fctx.body.push({ op: "call", funcIdx: toCharVecIdx });
          return { kind: "ref", typeIdx: nstrVecTypeIdx };
        }
        // Didn't lower as a native string — roll back and use the paths below.
        fctx.body.length = bodyLenBefore;
      }
      // (#2169) Array.from(g()) over a Wasm-native generator without a mapFn.
      // The argument lowers to the generator state struct, NOT a __vec — the
      // host fallback below would convert it to externref and call __array_from
      // (an env import that doesn't exist standalone). Drain the generator into
      // an f64 vec via the native resume loop instead (shares the spread
      // helper). Tentatively compile + commit only when the arg genuinely
      // lowers to a native-generator subject (mirrors the #1470 native-string
      // probe above).
      if (!hasMapFn) {
        const bodyLenBefore = fctx.body.length;
        const t = compileExpression(ctx, fctx, expr.arguments[0]!);
        const genInfo = t ? nativeGeneratorInfoForForOfSubject(ctx, t) : undefined;
        if (genInfo) {
          const genVecTypeIdx = getOrRegisterVecType(ctx, "f64");
          const genArrTypeIdx = getArrTypeIdxFromVec(ctx, genVecTypeIdx);
          emitNativeGeneratorToVec(ctx, fctx, genInfo, t!, genVecTypeIdx, genArrTypeIdx);
          return { kind: "ref", typeIdx: genVecTypeIdx };
        }
        // Not a native generator — roll back and use the paths below.
        fctx.body.length = bodyLenBefore;
      }
      // Only handle array arguments — create a shallow copy
      if (!hasMapFn && (argWasmType.kind === "ref" || argWasmType.kind === "ref_null")) {
        const arrInfo = resolveArrayInfo(ctx, argTsType);
        if (arrInfo) {
          const { vecTypeIdx, arrTypeIdx, elemType } = arrInfo;
          // Compile the source array
          compileExpression(ctx, fctx, expr.arguments[0]!);
          const srcVec = allocLocal(fctx, `__arrfrom_src_${fctx.locals.length}`, {
            kind: "ref_null",
            typeIdx: vecTypeIdx,
          });
          const srcData = allocLocal(fctx, `__arrfrom_sdata_${fctx.locals.length}`, {
            kind: "ref_null",
            typeIdx: arrTypeIdx,
          });
          const lenTmp = allocLocal(fctx, `__arrfrom_len_${fctx.locals.length}`, { kind: "i32" });
          const dstData = allocLocal(fctx, `__arrfrom_ddata_${fctx.locals.length}`, {
            kind: "ref_null",
            typeIdx: arrTypeIdx,
          });

          fctx.body.push({ op: "local.set", index: srcVec });
          // Get length
          fctx.body.push({ op: "local.get", index: srcVec });
          fctx.body.push({
            op: "struct.get",
            typeIdx: vecTypeIdx,
            fieldIdx: 0,
          });
          fctx.body.push({ op: "local.set", index: lenTmp });
          // Get source data
          fctx.body.push({ op: "local.get", index: srcVec });
          fctx.body.push({
            op: "struct.get",
            typeIdx: vecTypeIdx,
            fieldIdx: 1,
          });
          fctx.body.push({ op: "local.set", index: srcData });
          // Create new data array with default value — defaultValueInstrs
          // handles externref/ref/ref_null/i32/f64/i64 uniformly. Hand-rolling
          // `ref.null typeIdx: -1` for the externref element case produced
          // "Unknown heap type -1" wasm_compile errors (#1338).
          for (const ins of defaultValueInstrs(elemType)) fctx.body.push(ins);
          fctx.body.push({ op: "local.get", index: lenTmp });
          fctx.body.push({ op: "array.new", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "local.set", index: dstData });
          // Copy elements: array.copy dst dstOff src srcOff len
          fctx.body.push({ op: "local.get", index: dstData });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.get", index: srcData });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.get", index: lenTmp });
          fctx.body.push({
            op: "array.copy",
            dstTypeIdx: arrTypeIdx,
            srcTypeIdx: arrTypeIdx,
          } as Instr);
          // Create new vec struct with copied data
          fctx.body.push({ op: "local.get", index: lenTmp });
          fctx.body.push({ op: "local.get", index: dstData });
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
          fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
          return { kind: "ref", typeIdx: vecTypeIdx };
        }
      }
      // Fallback: Array.from(externref/iterable) — delegate to host (#965)
      {
        const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
        // Optional mapFn argument
        if (expr.arguments.length >= 2) {
          const mapType = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
          if (mapType && mapType.kind !== "externref") coerceType(ctx, fctx, mapType, { kind: "externref" });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        const fromIdx = ensureLateImport(
          ctx,
          "__array_from",
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);
        if (fromIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: fromIdx });
          return { kind: "externref" };
        }
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
    }

    // Handle Array.of(...items) — creates array from arguments (#965)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Array" &&
      propAccess.name.text === "of"
    ) {
      // Build a JS array of the arguments and delegate to host
      const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
      const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
      const ofIdx = ensureLateImport(ctx, "__array_of", [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (ofIdx !== undefined && arrNewIdx !== undefined && arrPushIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: arrNewIdx });
        const itemsLocal = allocLocal(fctx, `__arrof_items_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: itemsLocal });
        for (const arg of expr.arguments) {
          fctx.body.push({ op: "local.get", index: itemsLocal });
          const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
          if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
          fctx.body.push({ op: "call", funcIdx: arrPushIdx });
        }
        fctx.body.push({ op: "local.get", index: itemsLocal });
        fctx.body.push({ op: "call", funcIdx: ofIdx });
        return { kind: "externref" };
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle Object.keys(obj), Object.values(obj), and Object.entries(obj)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      (propAccess.name.text === "keys" || propAccess.name.text === "values" || propAccess.name.text === "entries") &&
      expr.arguments.length === 1
    ) {
      return compileObjectKeysOrValues(ctx, fctx, propAccess.name.text, expr);
    }

    // Handle Object.freeze/seal/preventExtensions — compile-away strategy
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      (propAccess.name.text === "freeze" ||
        propAccess.name.text === "seal" ||
        propAccess.name.text === "preventExtensions") &&
      expr.arguments.length >= 1
    ) {
      const method = propAccess.name.text;
      const arg0 = expr.arguments[0]!;

      // Compile-time tracking: mark variable by freeze/seal/preventExtensions state.
      // Two binding shapes carry the integrity to a variable the write-path /
      // isFrozen consult (both keyed on the identifier name in ctx.frozenVars):
      //   (a) `Object.freeze(o)` — the ARGUMENT is the identifier.
      //   (b) `const o = Object.freeze({...})` (#2012) — the inline-literal arg
      //       is not an identifier, but the CALL is the initializer of a
      //       variable declaration, so mark the DECLARED variable instead.
      //       Without this, an inline-literal freeze was a complete no-op for
      //       struct receivers (no frozenVars entry → write never throws,
      //       isFrozen → false).
      const markIntegrity = (name: string): void => {
        ctx.nonExtensibleVars.add(name);
        if (method === "freeze") {
          ctx.frozenVars.add(name);
          ctx.sealedVars.add(name); // frozen implies sealed
        } else if (method === "seal") {
          ctx.sealedVars.add(name);
        }
      };
      if (ts.isIdentifier(arg0)) {
        markIntegrity(arg0.text);
      } else if (
        // (#2012) `const/let o = Object.<freeze|seal|preventExtensions>(<expr>)`
        ts.isVariableDeclaration(expr.parent) &&
        ts.isIdentifier(expr.parent.name) &&
        expr.parent.initializer === expr
      ) {
        markIntegrity(expr.parent.name.text);
      }

      // Compile the argument — returns the object itself (freeze/seal return their arg)
      let argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (!argType) return null;

      // #1472 Phase B Blocker A Half 2 — open-`any` receiver normalization.
      // The open-object representation is a $Object wrapped to externref, but a
      // variable reference (`Object.freeze(o)` where `o: any`) can compile to a
      // ref/ref_null/anyref rather than externref, which would fall through to
      // the return-arg no-op and never reach the native __object_freeze (the
      // $flags would never be set). In standalone, coerce a non-externref
      // ref/anyref receiver to externref first (extern.convert_any) so the
      // native SET helper fires and the integrity bits actually get written.
      // JS-host mode is unchanged (it already routes externref args to the host
      // import; non-externref args there are typed objects with no dynamic
      // freeze semantics).
      if (
        ctx.standalone &&
        argType.kind !== "externref" &&
        (argType.kind === "ref" || argType.kind === "ref_null" || argType.kind === "anyref")
      ) {
        coerceType(ctx, fctx, argType, { kind: "externref" });
        argType = { kind: "externref" };
      }

      // For externref objects, delegate to host import for runtime enforcement
      if (argType.kind === "externref") {
        const objLocal = allocLocal(fctx, `__freeze_obj_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: objLocal });

        // Use the actual JS Object.freeze/seal/preventExtensions via host import
        const importName =
          method === "freeze" ? "__object_freeze" : method === "seal" ? "__object_seal" : "__object_preventExtensions";
        const hostIdx = ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);

        if (hostIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: objLocal });
          fctx.body.push({ op: "call", funcIdx: hostIdx });
          return { kind: "externref" };
        }

        // Fallback: just return the object as-is
        fctx.body.push({ op: "local.get", index: objLocal });
        return { kind: "externref" };
      }

      // For struct/ref types, compile-time tracking is sufficient — return as-is
      return argType;
    }

    // Handle Object.isFrozen/isSealed — compile-time fast path + runtime delegation
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      (propAccess.name.text === "isFrozen" || propAccess.name.text === "isSealed") &&
      expr.arguments.length >= 1
    ) {
      const method = propAccess.name.text;
      const arg0 = expr.arguments[0]!;

      // Compile-time fast path: identifier known to be frozen/sealed at compile
      // time. This is execution-order-blind (Object.freeze(o) populates
      // ctx.frozenVars during codegen, so an *earlier* Object.isFrozen(o) would
      // wrongly fold to const 1). In standalone mode the Wasm-native
      // __object_isFrozen/__object_isSealed read the live $Object.flags, so we
      // skip the static fold and let the runtime answer correctly (#1472
      // Phase B Blocker A Half 1).
      if (!ctx.standalone && ts.isIdentifier(arg0)) {
        const isKnown =
          (method === "isFrozen" && ctx.frozenVars.has(arg0.text)) ||
          (method === "isSealed" && ctx.sealedVars.has(arg0.text));
        if (isKnown) {
          const argType = compileExpression(ctx, fctx, arg0);
          if (argType) fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: 1 });
          return { kind: "i32" };
        }
      }

      // General case: compile arg and delegate to runtime host import
      const argType = compileExpression(ctx, fctx, arg0);
      if (argType?.kind === "externref") {
        const importName = method === "isFrozen" ? "__object_isFrozen" : "__object_isSealed";
        const hostIdx = ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "i32" }]);
        flushLateImportShifts(ctx, fctx);
        if (hostIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: hostIdx });
          return { kind: "i32" };
        }
        fctx.body.push({ op: "drop" });
      } else if (argType) {
        fctx.body.push({ op: "drop" });
        // (#1462) Primitive (f64/i32/i64) is not an Object per ES2015+ §19.1.2.13/14;
        // isFrozen/isSealed on a primitive returns TRUE.
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }
      // Fallback (no argType): treat as not frozen/sealed
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }

    // Handle Object.isExtensible — compile-time fast path + runtime delegation
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "isExtensible" &&
      expr.arguments.length >= 1
    ) {
      const arg0 = expr.arguments[0]!;

      // Compile-time fast path: identifier known to be non-extensible.
      // Skipped in standalone (execution-order-blind, same reason as
      // isFrozen/isSealed above) — the native __object_isExtensible reads the
      // live $Object.flags instead (#1472 Phase B Blocker A Half 1).
      if (!ctx.standalone && ts.isIdentifier(arg0) && ctx.nonExtensibleVars.has(arg0.text)) {
        const argType = compileExpression(ctx, fctx, arg0);
        if (argType) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }

      // General case: delegate to runtime
      const argType = compileExpression(ctx, fctx, arg0);
      if (argType?.kind === "externref") {
        const hostIdx = ensureLateImport(ctx, "__object_isExtensible", [{ kind: "externref" }], [{ kind: "i32" }]);
        flushLateImportShifts(ctx, fctx);
        if (hostIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: hostIdx });
          return { kind: "i32" };
        }
        fctx.body.push({ op: "drop" });
      } else if (argType) {
        fctx.body.push({ op: "drop" });
        // (#1462) Primitive (f64/i32/i64) is not an Object per ES2015+ §19.1.2.12;
        // isExtensible on a primitive returns FALSE.
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
      // Fallback (no argType): extensible (conservative)
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    }

    // Handle Object.setPrototypeOf(obj, proto).
    //   - Standalone (#1888 Slice 7): route to the native __object_setPrototypeOf
    //     runtime helper, which writes $Object.$proto (field 0) after the
    //     §10.1.2.1 OrdinarySetPrototypeOf extensibility + cycle checks and
    //     returns obj. No host import leaks (the name is in
    //     OBJECT_RUNTIME_HELPER_NAMES, so ensureLateImport lands the native fn).
    //   - GC/host: keep the existing stub (compile both args, drop proto,
    //     return obj) — byte-for-byte unchanged, the host runtime owns proto.
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "setPrototypeOf" &&
      expr.arguments.length >= 2
    ) {
      if (ctx.standalone) {
        // obj (externref)
        const objType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        if (!objType) {
          // obj produced no value — nothing to set on; push null result.
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
        if (objType.kind !== "externref") {
          coerceType(ctx, fctx, objType, { kind: "externref" });
        }
        // proto (externref)
        const protoType = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
        if (!protoType) {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (protoType.kind !== "externref") {
          coerceType(ctx, fctx, protoType, { kind: "externref" });
        }
        const spoIdx = ensureLateImport(
          ctx,
          "__object_setPrototypeOf",
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);
        if (spoIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: spoIdx });
        } else {
          // Helper unavailable (should not happen in standalone) — fall back to
          // the stub: drop proto, leave obj on the stack.
          fctx.body.push({ op: "drop" });
        }
        return { kind: "externref" };
      }
      // GC/host stub: compile both args, drop proto, return obj.
      const objType = compileExpression(ctx, fctx, expr.arguments[0]!);
      const protoType = compileExpression(ctx, fctx, expr.arguments[1]!);
      if (protoType) {
        fctx.body.push({ op: "drop" });
      }
      return objType;
    }

    // Handle Object.getPrototypeOf(obj) — return prototype as externref
    // For class instances, creates a struct representing the prototype and returns
    // it as externref via extern.convert_any. For plain objects, returns null.
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "getPrototypeOf" &&
      expr.arguments.length >= 1
    ) {
      const arg0 = expr.arguments[0]!;

      // For Object.getPrototypeOf(Child.prototype), return Parent's prototype singleton
      // Must check BEFORE the general class instance check, because TS types
      // Child.prototype as Child (the instance type).
      if (
        ts.isPropertyAccessExpression(arg0) &&
        ts.isIdentifier(arg0.expression) &&
        arg0.name.text === "prototype" &&
        ctx.classSet.has(arg0.expression.text)
      ) {
        const childClassName = arg0.expression.text;
        const parentClassName = ctx.classParentMap.get(childClassName);
        if (parentClassName && emitLazyProtoGet(ctx, fctx, parentClassName)) {
          return { kind: "externref" };
        }
        // Base class with no parent: return null (Object.prototype not modeled)
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }

      // (#1516) `Object.getPrototypeOf(g)` where `g` is a generator function
      // declaration must return `%GeneratorFunction.prototype%` (= `%Generator%`)
      // — the object whose `.prototype` is `%GeneratorPrototype%`. The compiled
      // closure is opaque to the host, so we resolve the call statically here
      // by routing to a dedicated runtime import.
      //
      // Same shape for `async function*`. Tests rely on this:
      //   var GeneratorPrototype = Object.getPrototypeOf(g).prototype;
      //   GeneratorPrototype.next.call(non_gen);  // → TypeError
      if (ts.isIdentifier(arg0)) {
        const argName = arg0.text;
        const isGen = ctx.generatorFunctions.has(argName);
        // ctx.asyncFunctions excludes async generators by design — codegen
        // checks the original AST for the async keyword. Re-derive the flag
        // from the symbol declaration so we route async-generators correctly.
        let isAsyncGen = false;
        if (isGen) {
          const sym = ctx.checker.getSymbolAtLocation(arg0);
          const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
          if (decl && (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl))) {
            isAsyncGen = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
          }
        }
        if (isGen) {
          const helperName = isAsyncGen
            ? "__get_async_generator_function_prototype"
            : "__get_generator_function_prototype";
          const helperIdx = ensureLateImport(ctx, helperName, [], [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          if (helperIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: helperIdx });
            return { kind: "externref" };
          }
          // Standalone mode (no host): fall through to legacy null path.
        }
      }

      const argTsType = ctx.checker.getTypeAtLocation(arg0);
      const className = resolveStructName(ctx, argTsType);

      // For known class instances, return the class prototype singleton
      if (className && ctx.classSet.has(className)) {
        // Compile and drop the argument (for side effects)
        const argType = compileExpression(ctx, fctx, arg0);
        if (argType) {
          fctx.body.push({ op: "drop" });
        }
        if (emitLazyProtoGet(ctx, fctx, className)) {
          return { kind: "externref" };
        }
      }

      // Fallback: use host import for externref/dynamic objects (e.g. Object.create results)
      const argTypeF = compileExpression(ctx, fctx, arg0, { kind: "externref" });
      if (!argTypeF) {
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      if (argTypeF.kind !== "externref") {
        coerceType(ctx, fctx, argTypeF, { kind: "externref" });
      }
      const gptFuncIdx = ensureLateImport(ctx, "__getPrototypeOf", [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (gptFuncIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: gptFuncIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
      return { kind: "externref" };
    }

    // Handle Object.create(proto) — create instances for known prototypes
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "create" &&
      expr.arguments.length >= 1
    ) {
      const arg0 = expr.arguments[0]!;

      // Object.create(Foo.prototype) → struct.new with default fields (Wasm-native fast path)
      if (ts.isPropertyAccessExpression(arg0) && ts.isIdentifier(arg0.expression) && arg0.name.text === "prototype") {
        const protoClassName = arg0.expression.text;
        if (ctx.classSet.has(protoClassName)) {
          const structTypeIdx = ctx.structMap.get(protoClassName);
          const fields = ctx.structFields.get(protoClassName);
          if (structTypeIdx !== undefined && fields) {
            // Push default values for all fields, then struct.new
            for (const field of fields) {
              pushDefaultValue(fctx, field.type, ctx);
            }
            fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
            return { kind: "ref", typeIdx: structTypeIdx };
          }
        }
      }

      // Host import path: Object.create(null) and Object.create(proto[, descriptors])
      // Object.create(null) → empty object with null prototype
      // Object.create(proto) → new object with __proto__ set to proto
      // Object.create(proto, descriptors) → expand descriptors at compile time
      const hostIdx = ensureLateImport(ctx, "__object_create", [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);

      if (hostIdx !== undefined) {
        // Compile the proto argument
        if (arg0.kind === ts.SyntaxKind.NullKeyword) {
          fctx.body.push({ op: "ref.null.extern" });
        } else {
          const argType = compileExpression(ctx, fctx, arg0);
          if (!argType) {
            // Expression produced no value — push null as fallback
            fctx.body.push({ op: "ref.null.extern" });
          } else if (argType.kind !== "externref") {
            // (#1462) Use coerceType — handles f64 → __box_number, i32 → boxed,
            // ref/ref_null → extern.convert_any. Bare extern.convert_any here would
            // emit an illegal cast on primitive types (e.g. `Object.create(5)`).
            coerceType(ctx, fctx, argType, { kind: "externref" });
          }
        }
        fctx.body.push({ op: "call", funcIdx: hostIdx });

        // If there's a second argument (property descriptors), expand at compile time.
        // Only use static expansion when every descriptor value is an object literal AND
        // every writable/enumerable/configurable flag inside each descriptor is
        // statically ToBoolean-resolvable (per §6.2.6). Non-resolvable flags
        // (`configurable: someVar`) need runtime ToBoolean — fall through to the
        // non-fast-path so the runtime honors §7.1.2 instead of silently degrading
        // to `false`.
        if (
          expr.arguments.length >= 2 &&
          ts.isObjectLiteralExpression(expr.arguments[1]!) &&
          (expr.arguments[1] as ts.ObjectLiteralExpression).properties.every((p) => {
            if (!ts.isPropertyAssignment(p)) return true;
            const init = (p as ts.PropertyAssignment).initializer;
            if (!ts.isObjectLiteralExpression(init)) return false;
            for (const dp of init.properties) {
              if (!ts.isPropertyAssignment(dp) || !ts.isIdentifier(dp.name)) continue;
              const n = dp.name.text;
              if (n === "writable" || n === "enumerable" || n === "configurable") {
                if (staticToBoolean(dp.initializer) === undefined) return false;
              }
            }
            return true;
          })
        ) {
          const descsLiteral = expr.arguments[1] as ts.ObjectLiteralExpression;
          // Save created object to local for repeated use
          const objLocal = allocLocal(fctx, `__ocreate_obj_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: objLocal });

          // Expand each property descriptor as Object.defineProperty(obj, key, desc)
          for (const prop of descsLiteral.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const propName = ts.isIdentifier(prop.name)
              ? prop.name.text
              : ts.isStringLiteral(prop.name)
                ? prop.name.text
                : ts.isNumericLiteral(prop.name)
                  ? prop.name.text
                  : undefined;
            if (propName === undefined) continue;

            // Parse descriptor fields from the object literal
            let valueExpr: ts.Expression | undefined;
            let getExpr: ts.Expression | undefined;
            let setExpr: ts.Expression | undefined;
            let descWritable: boolean | undefined;
            let descEnumerable: boolean | undefined;
            let descConfigurable: boolean | undefined;

            if (ts.isObjectLiteralExpression(prop.initializer)) {
              for (const dp of prop.initializer.properties) {
                if (ts.isPropertyAssignment(dp) && ts.isIdentifier(dp.name)) {
                  if (dp.name.text === "value") valueExpr = dp.initializer;
                  if (dp.name.text === "get") getExpr = dp.initializer;
                  if (dp.name.text === "set") setExpr = dp.initializer;
                  // Per §6.2.6 ToPropertyDescriptor: each flag is ToBoolean-coerced —
                  // `configurable: 123` / `'x'` / `{}` are all truthy. Statically
                  // evaluate ToBoolean for literal-shape initializers; bail to the
                  // runtime fallback (descWritable left undefined → handled below)
                  // for anything we can't resolve at compile time.
                  if (dp.name.text === "writable") {
                    descWritable = staticToBoolean(dp.initializer);
                  }
                  if (dp.name.text === "enumerable") {
                    descEnumerable = staticToBoolean(dp.initializer);
                  }
                  if (dp.name.text === "configurable") {
                    descConfigurable = staticToBoolean(dp.initializer);
                  }
                }
              }
            }

            // Emit __defineProperty_value(obj, prop, value, flags)
            const dpIdx = ensureLateImport(
              ctx,
              "__defineProperty_value",
              [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "i32" }],
              [{ kind: "externref" }],
            );
            flushLateImportShifts(ctx, fctx);

            if (dpIdx !== undefined) {
              // obj
              fctx.body.push({ op: "local.get", index: objLocal });
              // prop name as string constant
              addStringConstantGlobal(ctx, propName);
              const strGlobalIdx = ctx.stringGlobalMap.get(propName);
              if (strGlobalIdx !== undefined) {
                fctx.body.push({ op: "global.get", index: strGlobalIdx } as Instr);
              } else {
                fctx.body.push({ op: "ref.null.extern" });
              }
              // value (or null for accessor descriptors)
              if (valueExpr) {
                const vt = compileExpression(ctx, fctx, valueExpr);
                if (!vt) {
                  fctx.body.push({ op: "ref.null.extern" });
                } else if (vt.kind !== "externref") {
                  coerceType(ctx, fctx, vt, { kind: "externref" });
                }
              } else {
                fctx.body.push({ op: "ref.null.extern" });
              }
              // flags: bit 0=writable, 1=enumerable, 2=configurable, 3=writable specified,
              //        4=enumerable specified, 5=configurable specified, 7=has value
              let flags = 0;
              if (descWritable) flags |= 1;
              if (descEnumerable) flags |= 2;
              if (descConfigurable) flags |= 4;
              if (descWritable !== undefined) flags |= 8;
              if (descEnumerable !== undefined) flags |= 16;
              if (descConfigurable !== undefined) flags |= 32;
              if (valueExpr) flags |= 128; // has value
              if (getExpr || setExpr) flags |= 64; // is accessor
              fctx.body.push({ op: "i32.const", value: flags });
              fctx.body.push({ op: "call", funcIdx: dpIdx });
              fctx.body.push({ op: "drop" }); // defineProperty returns obj, drop it
            }
          }
          // Push obj back on stack as the result
          fctx.body.push({ op: "local.get", index: objLocal });
        } else if (expr.arguments.length >= 2 && ts.isObjectLiteralExpression(expr.arguments[1]!)) {
          // Object literal second arg with non-literal descriptor values (identifiers/expressions).
          // Iterate properties at compile time, calling __defineProperty_desc(obj, key, desc)
          // for each. This lets the runtime use native Object.defineProperty which traverses
          // the descriptor's prototype chain per ToPropertyDescriptor (ECMA-262 §10.1).
          const descsLiteral = expr.arguments[1] as ts.ObjectLiteralExpression;
          const objLocal = allocLocal(fctx, `__ocreate_obj_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: objLocal });

          const dpDescIdx = ensureLateImport(
            ctx,
            "__defineProperty_desc",
            [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
            [{ kind: "externref" }],
          );
          flushLateImportShifts(ctx, fctx);

          for (const prop of descsLiteral.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const propName = ts.isIdentifier(prop.name)
              ? prop.name.text
              : ts.isStringLiteral(prop.name)
                ? prop.name.text
                : ts.isNumericLiteral(prop.name)
                  ? prop.name.text
                  : undefined;
            if (propName === undefined) continue;

            if (dpDescIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: objLocal });
              addStringConstantGlobal(ctx, propName);
              const strGlobalIdx = ctx.stringGlobalMap.get(propName);
              if (strGlobalIdx !== undefined) {
                fctx.body.push({ op: "global.get", index: strGlobalIdx } as Instr);
              } else {
                fctx.body.push({ op: "ref.null.extern" });
              }
              const descValType = compileExpression(ctx, fctx, prop.initializer);
              if (!descValType) {
                fctx.body.push({ op: "ref.null.extern" });
              } else if (descValType.kind !== "externref") {
                coerceType(ctx, fctx, descValType, { kind: "externref" });
              }
              fctx.body.push({ op: "call", funcIdx: dpDescIdx });
              fctx.body.push({ op: "drop" });
            }
          }
          fctx.body.push({ op: "local.get", index: objLocal });
        } else if (expr.arguments.length >= 2) {
          // Non-literal second arg: use __defineProperties host import
          const objLocal = allocLocal(fctx, `__ocreate_obj_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: objLocal });

          const dpIdx = ensureLateImport(
            ctx,
            "__defineProperties",
            [{ kind: "externref" }, { kind: "externref" }],
            [{ kind: "externref" }],
          );
          flushLateImportShifts(ctx, fctx);

          if (dpIdx !== undefined) {
            fctx.body.push({ op: "local.get", index: objLocal });
            const descType = compileExpression(ctx, fctx, expr.arguments[1]!);
            if (!descType) {
              fctx.body.push({ op: "ref.null.extern" });
            } else if (descType.kind !== "externref") {
              fctx.body.push({ op: "extern.convert_any" });
            }
            fctx.body.push({ op: "call", funcIdx: dpIdx });
          } else {
            // No host import available — just return obj without descriptors
            fctx.body.push({ op: "local.get", index: objLocal });
          }
        }
        return { kind: "externref" };
      }

      // Standalone fallback (no host): compile arg for side effects, return null externref
      if (arg0.kind === ts.SyntaxKind.NullKeyword) {
        fctx.body.push({ op: "ref.null.extern" });
      } else {
        const argType = compileExpression(ctx, fctx, arg0);
        if (argType) {
          fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "ref.null.extern" });
      }
      return { kind: "externref" };
    }

    // Handle Object.defineProperty(obj, prop, descriptor) — stub
    // If descriptor is an object literal with a `value` property, sets obj[prop] = value via __extern_set.
    // Otherwise compiles all args for side effects and returns obj.
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "defineProperty" &&
      expr.arguments.length >= 3
    ) {
      return compileObjectDefineProperty(ctx, fctx, expr);
    }

    // Handle Object.defineProperties(obj, props) — expand to individual defineProperty calls
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "defineProperties" &&
      expr.arguments.length >= 2
    ) {
      return compileObjectDefineProperties(ctx, fctx, expr);
    }

    // Handle Object.getOwnPropertyDescriptor(obj, prop)
    // Fast path: known struct type + string literal prop → inline struct.get + __create_descriptor
    // Fallback: __getOwnPropertyDescriptor host import for dynamic cases
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "getOwnPropertyDescriptor" &&
      expr.arguments.length >= 2
    ) {
      const arg0 = expr.arguments[0]!;
      const arg1 = expr.arguments[1]!;

      // Try compile-time fast path: known struct + literal property name
      const arg0TsType = ctx.checker.getTypeAtLocation(arg0);
      const structName = resolveStructName(ctx, arg0TsType);
      const propLiteral = ts.isStringLiteral(arg1) ? arg1.text : undefined;

      if (structName && propLiteral !== undefined) {
        const structTypeIdx = ctx.structMap.get(structName);
        const fields = ctx.structFields.get(structName);

        if (structTypeIdx !== undefined && fields) {
          // Find the field index for the property name
          const userFields = fields
            .map((f, idx) => ({ field: f, fieldIdx: idx }))
            .filter((e) => !e.field.name.startsWith("__"));
          const entry = userFields.find((e) => e.field.name === propLiteral);
          const sidecarDefinedKey =
            ts.isIdentifier(arg0) && ctx.sidecarDefinedPropertyKeys.has(`${arg0.text}:${propLiteral}`);

          if (entry && !sidecarDefinedKey) {
            // #1629b: Object.defineProperty updates `definedPropertyFlags`
            // (keyed `varName:propName`) but `shapePropFlags` is built AFTER
            // body compilation finishes, so per-variable updates made during
            // codegen are lost when the table is initialized with defaults.
            // Read the per-variable map first, then fall back to the shape table.
            const flagsArr = ctx.shapePropFlags.get(structTypeIdx);
            const userFieldIdx = userFields.indexOf(entry);
            let flags = flagsArr && userFieldIdx >= 0 ? flagsArr[userFieldIdx]! : 0x07; // default WEC
            if (ts.isIdentifier(arg0)) {
              const dpfKey = `${arg0.text}:${propLiteral}`;
              const dpfFlags = ctx.definedPropertyFlags.get(dpfKey);
              if (dpfFlags !== undefined) flags = dpfFlags & 0x0f;
            }

            // Compile the object expression
            const objType = compileExpression(ctx, fctx, arg0);
            if (!objType) {
              fctx.body.push({ op: "ref.null.extern" });
              return { kind: "externref" };
            }

            // Guard cast with ref.test to avoid illegal cast traps (#778).
            // If the runtime type doesn't match, convert to anyref for testing.
            {
              let needsCast = false;
              if (objType.kind === "externref") {
                fctx.body.push({ op: "any.convert_extern" });
                needsCast = true;
              } else if (objType.kind === "ref_null" && objType.typeIdx !== structTypeIdx) {
                needsCast = true;
              }
              if (needsCast) {
                const gopdTmp = allocLocal(fctx, `__gopd_tmp_${fctx.locals.length}`, { kind: "anyref" });
                fctx.body.push({ op: "local.set", index: gopdTmp });
                fctx.body.push({ op: "local.get", index: gopdTmp });
                fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx } as Instr);
                fctx.body.push({
                  op: "if",
                  blockType: { kind: "val", type: { kind: "externref" } as ValType },
                  then: (() => {
                    // Cast succeeds — proceed with struct.get + descriptor
                    const thenInstrs: Instr[] = [
                      { op: "local.get", index: gopdTmp } as Instr,
                      { op: "ref.cast", typeIdx: structTypeIdx } as Instr,
                      { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: entry.fieldIdx } as Instr,
                    ];
                    // Coerce field value to externref
                    const ft = entry.field.type;
                    if (ft.kind === "f64") {
                      const boxIdx2 = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                      flushLateImportShifts(ctx, fctx);
                      if (boxIdx2 !== undefined) thenInstrs.push({ op: "call", funcIdx: boxIdx2 } as Instr);
                    } else if (ft.kind === "i32") {
                      thenInstrs.push({ op: "f64.convert_i32_s" } as Instr);
                      const boxIdx2 = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                      flushLateImportShifts(ctx, fctx);
                      if (boxIdx2 !== undefined) thenInstrs.push({ op: "call", funcIdx: boxIdx2 } as Instr);
                    } else if (ft.kind === "ref" || ft.kind === "ref_null") {
                      thenInstrs.push({ op: "extern.convert_any" } as Instr);
                    } else if (ft.kind !== "externref") {
                      thenInstrs.push({ op: "extern.convert_any" } as Instr);
                    }
                    // Push flags + call __create_descriptor
                    thenInstrs.push({ op: "i32.const", value: flags } as Instr);
                    const createIdx2 = ensureLateImport(
                      ctx,
                      "__create_descriptor",
                      [{ kind: "externref" }, { kind: "i32" }],
                      [{ kind: "externref" }],
                    );
                    flushLateImportShifts(ctx, fctx);
                    if (createIdx2 !== undefined) thenInstrs.push({ op: "call", funcIdx: createIdx2 } as Instr);
                    return thenInstrs;
                  })(),
                  else: [
                    // Cast would fail — return undefined (property not own)
                    { op: "ref.null.extern" } as Instr,
                  ],
                } as Instr);
                return { kind: "externref" };
              }
            }

            // Save obj ref for struct.get (direct path — type already matches)
            const objLocal = allocLocal(fctx, `__gopd_obj_${fctx.locals.length}`, {
              kind: "ref",
              typeIdx: structTypeIdx,
            });
            fctx.body.push({ op: "local.set", index: objLocal });

            // Get field value: struct.get → coerce to externref
            fctx.body.push({ op: "local.get", index: objLocal });
            fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: entry.fieldIdx });

            // Coerce field value to externref for __create_descriptor
            const fieldType = entry.field.type;
            if (fieldType.kind === "f64") {
              const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
              flushLateImportShifts(ctx, fctx);
              if (boxIdx !== undefined) {
                fctx.body.push({ op: "call", funcIdx: boxIdx });
              }
            } else if (fieldType.kind === "i32") {
              fctx.body.push({ op: "f64.convert_i32_s" });
              const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
              flushLateImportShifts(ctx, fctx);
              if (boxIdx !== undefined) {
                fctx.body.push({ op: "call", funcIdx: boxIdx });
              }
            } else if (fieldType.kind === "i64") {
              fctx.body.push({ op: "f64.convert_i64_s" });
              const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
              flushLateImportShifts(ctx, fctx);
              if (boxIdx !== undefined) {
                fctx.body.push({ op: "call", funcIdx: boxIdx });
              }
            } else if (fieldType.kind === "ref" || fieldType.kind === "ref_null") {
              fctx.body.push({ op: "extern.convert_any" });
            } else if (fieldType.kind !== "externref") {
              // Other types: try extern.convert_any
              fctx.body.push({ op: "extern.convert_any" });
            }

            // Push flags as i32 constant
            fctx.body.push({ op: "i32.const", value: flags });

            // Call __create_descriptor(value, flags) → externref
            const createIdx = ensureLateImport(
              ctx,
              "__create_descriptor",
              [{ kind: "externref" }, { kind: "i32" }],
              [{ kind: "externref" }],
            );
            flushLateImportShifts(ctx, fctx);
            if (createIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: createIdx });
            }
            return { kind: "externref" };
          }
          // #1364a — if the property is a registered class method, fall
          // through to the dynamic `__getOwnPropertyDescriptor` host import
          // path (which now handles proto-method allowlists by returning a
          // descriptor with `enumerable: false, configurable: true,
          // writable: true`). Without this, the fast path returns
          // `ref.null.extern` (undefined) for any class method lookup, and
          // `verifyProperty(C.prototype, "m", {...})` fails before checking
          // any flag.
          //
          // (#1395) Same logic for static methods on the class object —
          // `verifyProperty(C, "m", {...})` lookups need the runtime arm to
          // fire instead of returning `ref.null.extern` here.
          if (!sidecarDefinedKey) {
            const methodNames = ctx.classMethodNames.get(structName);
            const staticMethodNames = ctx.classStaticMethodNames.get(structName);
            const isMethodLookup =
              (methodNames && methodNames.includes(propLiteral)) ||
              (staticMethodNames && staticMethodNames.includes(propLiteral));
            if (isMethodLookup) {
              // Skip the fast-path null-return; let the dynamic fallback below
              // handle the method case via the host import.
            } else {
              // Property not found in struct — return undefined
              // (own property doesn't exist on this shape)
              const argResult = compileExpression(ctx, fctx, arg0);
              if (argResult) fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "ref.null.extern" });
              return { kind: "externref" };
            }
          }
        }
      }

      // Fallback: dynamic case — delegate to __getOwnPropertyDescriptor host import
      // If arg0 is a known built-in global identifier, use __get_builtin to get
      // the real JS object instead of the ref.null.extern from compileIdentifier.
      const arg0IsBuiltin = ts.isIdentifier(arg0) && BUILTIN_CLASS_NAMES.has((arg0 as ts.Identifier).text);

      let getBuiltinFuncIdx: number | undefined;
      if (arg0IsBuiltin) {
        getBuiltinFuncIdx = ensureLateImport(ctx, "__get_builtin", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
      }

      let objType: ReturnType<typeof compileExpression>;
      if (arg0IsBuiltin && getBuiltinFuncIdx !== undefined) {
        const builtinName = (arg0 as ts.Identifier).text;
        addStringConstantGlobal(ctx, builtinName);
        const strIdx = ctx.stringGlobalMap.get(builtinName);
        if (strIdx !== undefined) {
          fctx.body.push({ op: "global.get", index: strIdx } as Instr);
        } else {
          compileStringLiteral(ctx, fctx, builtinName);
        }
        fctx.body.push({ op: "call", funcIdx: getBuiltinFuncIdx });
        objType = { kind: "externref" };
      } else {
        objType = compileExpression(ctx, fctx, arg0, { kind: "externref" });
        if (!objType) {
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
        if (objType.kind !== "externref") {
          coerceType(ctx, fctx, objType, { kind: "externref" });
        }
      }

      const propType = compileExpression(ctx, fctx, arg1, { kind: "externref" });
      if (!propType) {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      if (propType.kind !== "externref") {
        coerceType(ctx, fctx, propType, { kind: "externref" });
      }
      const funcIdx = ensureLateImport(
        ctx,
        "__getOwnPropertyDescriptor",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
      return { kind: "externref" };
    }

    // Handle Object.getOwnPropertyNames(obj) — returns all own string-keyed property names
    // (including non-enumerable), delegates to __getOwnPropertyNames host import.
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "getOwnPropertyNames" &&
      expr.arguments.length >= 1
    ) {
      const arg = expr.arguments[0]!;
      const argResult = compileExpression(ctx, fctx, arg, { kind: "externref" });
      if (!argResult) {
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      if (argResult.kind !== "externref") {
        coerceType(ctx, fctx, argResult, { kind: "externref" });
      }
      const funcIdx = ensureLateImport(ctx, "__getOwnPropertyNames", [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
      return { kind: "externref" };
    }

    // Handle Object.getOwnPropertySymbols(obj) — returns own symbol-keyed properties
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "getOwnPropertySymbols" &&
      expr.arguments.length >= 1
    ) {
      const arg = expr.arguments[0]!;
      const argResult = compileExpression(ctx, fctx, arg, { kind: "externref" });
      if (!argResult) {
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      if (argResult.kind !== "externref") {
        coerceType(ctx, fctx, argResult, { kind: "externref" });
      }
      const funcIdx = ensureLateImport(
        ctx,
        "__getOwnPropertySymbols",
        [{ kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
      return { kind: "externref" };
    }

    // Handle Object.hasOwn(obj, key) — ES2022 static method (#965)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "hasOwn" &&
      expr.arguments.length >= 2
    ) {
      const objArg = expr.arguments[0]!;
      const keyArg = expr.arguments[1]!;
      const objType = compileExpression(ctx, fctx, objArg, { kind: "externref" });
      if (objType && objType.kind !== "externref") coerceType(ctx, fctx, objType, { kind: "externref" });
      const keyType = compileExpression(ctx, fctx, keyArg, { kind: "externref" });
      if (keyType && keyType.kind !== "externref") coerceType(ctx, fctx, keyType, { kind: "externref" });
      const funcIdx = ensureLateImport(
        ctx,
        "__object_hasOwn",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }

    // Handle Object.is(x, y) — SameValue comparison (#965)
    // Delegates to host: handles NaN===NaN and +0!==-0 correctly.
    // Uses type-aware boxing: booleans use __box_boolean, numbers use __box_number,
    // so that Object.is(false, 0) correctly returns false (different JS types).
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "is" &&
      expr.arguments.length >= 2
    ) {
      // Helper: compile an argument and coerce to externref preserving JS type
      const compileArgAsExternref = (arg: ts.Expression) => {
        const argTsType = ctx.checker.getTypeAtLocation(arg);
        const wasmType = compileExpression(ctx, fctx, arg);
        if (!wasmType || wasmType.kind === "externref") return;
        if (wasmType.kind === "i32" && isBooleanType(argTsType)) {
          // Boolean i32: box as JS boolean (not number) so Object.is(false, 0) = false
          addUnionImports(ctx);
          const boxIdx = ctx.funcMap.get("__box_boolean");
          if (boxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: boxIdx });
            return;
          }
        }
        coerceType(ctx, fctx, wasmType, { kind: "externref" });
      };
      const xArg = expr.arguments[0]!;
      const yArg = expr.arguments[1]!;
      compileArgAsExternref(xArg);
      compileArgAsExternref(yArg);
      const isIdx = ensureLateImport(
        ctx,
        "__object_is",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (isIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: isIdx });
        return { kind: "i32" };
      }
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }

    // Handle Object.assign(target, ...sources) — shallow copy properties (#965)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "assign" &&
      expr.arguments.length >= 1
    ) {
      const targetArg = expr.arguments[0]!;
      // (#2076) Object-literal operands must build as native $Objects in
      // standalone so __object_assign's `ref.test $Object` recognises them.
      compileObjectAssignArg(ctx, fctx, targetArg);
      // Build the variadic `...sources` list. Under --target standalone there is
      // no JS array, so the native __object_assign iterates a $ObjVec built by
      // the native $ObjVec builders (__objvec_new / __objvec_push) instead of the
      // host __js_array_new / __js_array_push. JS-host / WASI keep the host
      // imports unchanged (byte-for-byte). Per the #1472 S3 note the __js_array_*
      // builders are NOT globally safe to alias (real JS arrays elsewhere depend
      // on them) — so this is a per-call-site swap.
      let arrNewIdx: number | undefined;
      let arrPushIdx: number | undefined;
      if (ctx.standalone) {
        const b = ensureObjVecBuilders(ctx);
        arrNewIdx = b.newIdx;
        arrPushIdx = b.pushIdx;
      } else {
        arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
        arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
      }
      const assignIdx = ensureLateImport(
        ctx,
        "__object_assign",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (assignIdx !== undefined && arrNewIdx !== undefined && arrPushIdx !== undefined) {
        const targetLocal = allocLocal(fctx, `__assign_tgt_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: targetLocal });
        fctx.body.push({ op: "call", funcIdx: arrNewIdx });
        const sourcesLocal = allocLocal(fctx, `__assign_src_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: sourcesLocal });
        for (let i = 1; i < expr.arguments.length; i++) {
          fctx.body.push({ op: "local.get", index: sourcesLocal });
          compileObjectAssignArg(ctx, fctx, expr.arguments[i]!);
          fctx.body.push({ op: "call", funcIdx: arrPushIdx });
        }
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "local.get", index: sourcesLocal });
        fctx.body.push({ op: "call", funcIdx: assignIdx });
        return { kind: "externref" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle Object.fromEntries(iterable) — create object from [key,value] pairs (#965)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "fromEntries" &&
      expr.arguments.length >= 1
    ) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
      const funcIdx = ensureLateImport(ctx, "__object_fromEntries", [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle Object.getOwnPropertyDescriptors(obj) — all own descriptors (#965)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "getOwnPropertyDescriptors" &&
      expr.arguments.length >= 1
    ) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
      const funcIdx = ensureLateImport(
        ctx,
        "__object_getOwnPropertyDescriptors",
        [{ kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle Object.groupBy(iterable, keyFn) — ES2024 grouping (#965)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Object" &&
      propAccess.name.text === "groupBy" &&
      expr.arguments.length >= 2
    ) {
      const iterType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (iterType && iterType.kind !== "externref") coerceType(ctx, fctx, iterType, { kind: "externref" });
      const fnType = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
      if (fnType && fnType.kind !== "externref") coerceType(ctx, fctx, fnType, { kind: "externref" });
      const funcIdx = ensureLateImport(
        ctx,
        "__object_groupBy",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Standalone has no JS Proxy machinery, so reject Proxy.revocable before
    // argument lowering or generic built-in lookup can register host imports.
    if (
      ctx.standalone &&
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Proxy" &&
      propAccess.name.text === "revocable"
    ) {
      reportError(ctx, expr, "Codegen error: Proxy not supported in standalone mode (#1472 Phase C).");
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle Proxy.revocable(target, handler) — creates revocable Proxy (#965)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "Proxy" &&
      propAccess.name.text === "revocable" &&
      expr.arguments.length >= 2
    ) {
      const tgtType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (tgtType && tgtType.kind !== "externref") coerceType(ctx, fctx, tgtType, { kind: "externref" });
      const hndType = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
      if (hndType && hndType.kind !== "externref") coerceType(ctx, fctx, hndType, { kind: "externref" });
      const funcIdx = ensureLateImport(
        ctx,
        "__proxy_revocable",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Handle Symbol.for(key) and Symbol.keyFor(sym) — global symbol registry (#965)
    if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "Symbol") {
      const symMethod = propAccess.name.text;
      if (symMethod === "for" && expr.arguments.length >= 1) {
        // §20.4.2.2 step 1: stringKey = ? ToString(key). A Symbol key makes
        // ToString throw TypeError before the registry lookup runs.
        const keyTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
        if (isSymbolType(keyTsType)) {
          emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a string");
          return { kind: "externref" };
        }
        // (#2163) No-JS-host mode: use the Wasm-native registry. The key lowers
        // to a `ref $AnyString`; `__symbol_for_native` does the content-equality
        // lookup / insert and returns the i32 symbol id (also recording the key
        // as the registered symbol's description). Zero host imports.
        if (noJsHost(ctx)) {
          const { forIdx } = ensureSymbolRegistry(ctx);
          const keyType = compileExpression(ctx, fctx, expr.arguments[0]!, {
            kind: "ref",
            typeIdx: ctx.anyStrTypeIdx,
          });
          if (keyType && (keyType.kind !== "ref" || keyType.typeIdx !== ctx.anyStrTypeIdx)) {
            coerceType(ctx, fctx, keyType, { kind: "ref", typeIdx: ctx.anyStrTypeIdx });
          }
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
          fctx.body.push({ op: "call", funcIdx: forIdx });
          return { kind: "i32" };
        }
        const keyType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        if (keyType && keyType.kind !== "externref") coerceType(ctx, fctx, keyType, { kind: "externref" });
        const funcIdx = ensureLateImport(ctx, "__symbol_for", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      if (symMethod === "keyFor" && expr.arguments.length >= 1) {
        // (#2163) No-JS-host mode: the symbol is an i32 id; the native registry
        // returns its registration key (`ref_null $AnyString`, i.e. a native
        // string or undefined for an unregistered symbol). Zero host imports.
        if (noJsHost(ctx)) {
          const { keyForIdx } = ensureSymbolRegistry(ctx);
          const symType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "i32" });
          if (symType && symType.kind !== "i32") coerceType(ctx, fctx, symType, { kind: "i32" });
          fctx.body.push({ op: "call", funcIdx: keyForIdx });
          return { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
        }
        const symType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        if (symType && symType.kind !== "externref") coerceType(ctx, fctx, symType, { kind: "externref" });
        const funcIdx = ensureLateImport(ctx, "__symbol_keyFor", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
    }

    // Handle ArrayBuffer.isView(arg) — checks if arg is a TypedArray/DataView (#965)
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "ArrayBuffer" &&
      propAccess.name.text === "isView" &&
      expr.arguments.length >= 1
    ) {
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      if (argType && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
      const funcIdx = ensureLateImport(ctx, "__arraybuffer_isView", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "i32" };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }

    // ── Reflect API — host dispatch via __reflect_* imports (#1466) ──────
    // Replaces the previous compile-time rewrites that bypassed the Proxy MOP.
    // Each method routes through a thin host wrapper around Reflect.X so
    // Proxy targets see their traps fire and boolean returns are preserved.
    if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "Reflect") {
      const reflectMethod = propAccess.name.text;

      // Helper — compile each argument as externref, padding missing positions with ref.null.extern.
      const emitReflectArgs = (count: number): void => {
        const externRef: ValType = { kind: "externref" };
        for (let i = 0; i < count; i++) {
          const arg = expr.arguments[i];
          if (arg !== undefined) {
            const argTy = compileExpression(ctx, fctx, arg, externRef);
            if (argTy && argTy.kind !== "externref") {
              coerceType(ctx, fctx, argTy, externRef);
            } else if (argTy === null) {
              // Expression had no value — push null externref to keep arity.
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
      };

      // Helper — drop N pushed args and return a fallback constant when the import is unavailable.
      // (#2046 cleanup) `i32-false` is the safer default for boolean-returning
      // Reflect methods on a registration failure (the module is already marked
      // failed by reportError; false is the less-wrong observable value).
      const fallbackReturn = (n: number, ret: "i32-true" | "i32-false" | "extern-null"): InnerResult => {
        for (let i = 0; i < n; i++) fctx.body.push({ op: "drop" });
        if (ret === "i32-true" || ret === "i32-false") {
          fctx.body.push({ op: "i32.const", value: ret === "i32-true" ? 1 : 0 });
          return { kind: "i32" };
        }
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      };

      const externRef: ValType = { kind: "externref" };
      const i32Ty: ValType = { kind: "i32" };

      // ── #1472 Phase C — Reflect.* under --target standalone ───────────────
      //
      // The host-dispatch path below registers an env::__reflect_* import for
      // every Reflect method. There is no JS host in standalone mode, so any
      // such import would leak into the binary and fail at instantiation with
      // an opaque "unknown import" linker error. Route the one method backed by
      // a native helper through it, and refuse the rest with a clear compile
      // error rather than emitting a half-working module.
      //
      // - Reflect.get/has/deleteProperty(target, key) → native keyed $Object
      //   helpers, which already perform the same own/prototype walk or delete
      //   operation used by dynamic property access.
      // - Reflect.set(target, key, value) → native __reflect_set, a boolean
      //   wrapper around the supported __extern_set data-write subset.
      // - Reflect.ownKeys(target) → native __object_keys (string own keys of
      //   the $Object hash-map, insertion order). The native runtime tracks
      //   only string keys; Symbol/non-enumerable keys are out of scope for the
      //   standalone object runtime (consistent approximation across #1472
      //   Phase B). __object_keys is in OBJECT_RUNTIME_HELPER_NAMES, so
      //   ensureLateImport auto-routes it to the in-module native func.
      // - Reflect.apply/construct require call/constructor machinery with no
      //   native analog in this slice. Descriptor/prototype/integrity methods
      //   stay refused until their native invariants are proven end-to-end.
      if (ctx.standalone) {
        if (reflectMethod === "get" && expr.arguments.length >= 2) {
          // (#2046 PR-A defect 1) The native __extern_get has no separate
          // receiver slot — an explicit receiver was previously evaluated and
          // SILENTLY DROPPED, so accessor getters (live since #1888 S5b) ran
          // with `this = target` instead of `receiver` (§28.1.5 → §10.1.8).
          // Until real receiver plumbing (PR-C, senior/deferred), refuse loudly
          // rather than mis-bind `this` — restores the #1888 fail-loud invariant.
          if (expr.arguments.length > 2) {
            reportError(
              ctx,
              expr,
              "Codegen error: Reflect.get with an explicit receiver argument is not yet supported " +
                "in --target standalone (#2046); the receiver would be silently dropped and accessor " +
                "getters would bind `this` to the target instead of the receiver.",
            );
            fctx.body.push({ op: "ref.null.extern" });
            return { kind: "externref" };
          }
          emitReflectArgs(2);
          const funcIdx = ensureLateImport(ctx, "__extern_get", [externRef, externRef], [externRef]);
          flushLateImportShifts(ctx, fctx);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "externref" };
          }
          return fallbackReturn(2, "extern-null");
        }

        if (reflectMethod === "set" && expr.arguments.length >= 2) {
          // (#2046 PR-A defect 1) Same as Reflect.get: __reflect_set writes the
          // data-property subset on `target` itself and has no receiver slot, so
          // an explicit receiver was evaluated then dropped — writing to the
          // wrong object for accessor setters (§28.1.12 → §10.1.9). Refuse
          // loudly with an explicit receiver until PR-C lands.
          if (expr.arguments.length > 3) {
            reportError(
              ctx,
              expr,
              "Codegen error: Reflect.set with an explicit receiver argument is not yet supported " +
                "in --target standalone (#2046); the receiver would be silently dropped and accessor " +
                "setters would write to the target instead of the receiver.",
            );
            fctx.body.push({ op: "i32.const", value: 0 });
            return { kind: "i32" };
          }
          emitReflectArgs(3);
          const funcIdx = ensureLateImport(ctx, "__reflect_set", [externRef, externRef, externRef], [i32Ty]);
          flushLateImportShifts(ctx, fctx);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "i32" };
          }
          return fallbackReturn(3, "i32-false");
        }

        if (reflectMethod === "has" && expr.arguments.length >= 2) {
          emitReflectArgs(2);
          const funcIdx = ensureLateImport(ctx, "__extern_has", [externRef, externRef], [i32Ty]);
          flushLateImportShifts(ctx, fctx);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "i32" };
          }
          // (#2046 cleanup) i32-false: a registration failure should not report
          // a phantom `true` for `Reflect.has`.
          return fallbackReturn(2, "i32-false");
        }

        if (reflectMethod === "deleteProperty" && expr.arguments.length >= 2) {
          // (#2046 PR-A defect 3a) Reflect.deleteProperty(primitive, k) must
          // throw a TypeError (§28.1.4 — Reflect requires an Object target),
          // NOT return true. The shared __delete_property helper returns 1 for
          // non-$Object targets because sloppy `delete primitive[k]` is a no-op
          // SUCCESS — correct there, wrong for Reflect. So gate at the CALL SITE
          // (do NOT touch the shared helper): ref.test the target against
          // $Object; if it is not an open object, throw a catchable TypeError.
          const ort = ensureObjectRuntime(ctx);
          const targetLocal = allocTempLocal(fctx, externRef);
          // Evaluate the target once, save it for both the guard and the call.
          {
            const tArg = expr.arguments[0];
            if (tArg !== undefined) {
              const tTy = compileExpression(ctx, fctx, tArg, externRef);
              if (tTy && tTy.kind !== "externref") coerceType(ctx, fctx, tTy, externRef);
              else if (tTy === null) fctx.body.push({ op: "ref.null.extern" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          }
          fctx.body.push({ op: "local.set", index: targetLocal });
          // Pre-register the TypeError constructor + any late import the throw
          // needs BEFORE entering the `if`, so capturing the throw instrs by
          // splice below cannot interleave a late-import index shift into the
          // nested block (the registration happens against the flat body here).
          const throwInstrs: Instr[] = (() => {
            const before = fctx.body.length;
            emitThrowTypeError(ctx, fctx, "Reflect.deleteProperty called on non-object");
            return fctx.body.splice(before);
          })();
          // if !ref.test $Object(target) → throw TypeError
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({ op: "any.convert_extern" } as Instr);
          fctx.body.push({ op: "ref.test", typeIdx: ort.objectTypeIdx } as Instr);
          fctx.body.push({ op: "i32.eqz" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: throwInstrs,
          } as Instr);
          // target is an $Object — push [target, key] and delete.
          fctx.body.push({ op: "local.get", index: targetLocal });
          releaseTempLocal(fctx, targetLocal);
          {
            const kArg = expr.arguments[1];
            if (kArg !== undefined) {
              const kTy = compileExpression(ctx, fctx, kArg, externRef);
              if (kTy && kTy.kind !== "externref") coerceType(ctx, fctx, kTy, externRef);
              else if (kTy === null) fctx.body.push({ op: "ref.null.extern" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          }
          const funcIdx = ensureLateImport(ctx, "__delete_property", [externRef, externRef], [i32Ty]);
          flushLateImportShifts(ctx, fctx);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "i32" };
          }
          return fallbackReturn(0, "i32-false");
        }

        if (reflectMethod === "ownKeys" && expr.arguments.length >= 1) {
          emitReflectArgs(1);
          const funcIdx = ensureLateImport(ctx, "__object_keys", [externRef], [externRef]);
          flushLateImportShifts(ctx, fctx);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "externref" };
          }
          return fallbackReturn(1, "extern-null");
        }
        // Boolean-returning methods need an i32 on the stack; the rest return
        // externref. Pick the fallback shape per method so the surrounding
        // expression still type-checks even though the module is already marked
        // failed by reportError.
        const booleanReflect = new Set([
          "set",
          "has",
          "deleteProperty",
          "defineProperty",
          "setPrototypeOf",
          "isExtensible",
          "preventExtensions",
        ]);
        reportError(
          ctx,
          expr,
          `Codegen error: Reflect.${reflectMethod} not supported in standalone mode (#1472 Phase C).`,
        );
        if (booleanReflect.has(reflectMethod)) {
          fctx.body.push({ op: "i32.const", value: 0 });
          return { kind: "i32" };
        }
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }

      // Reflect.get(target, key, [receiver]) — returns externref.
      if (reflectMethod === "get" && expr.arguments.length >= 2) {
        emitReflectArgs(3);
        const funcIdx = ensureLateImport(ctx, "__reflect_get", [externRef, externRef, externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(3, "extern-null");
      }

      // Reflect.set(target, key, value, [receiver]) — returns i32 (boolean).
      if (reflectMethod === "set" && expr.arguments.length >= 2) {
        emitReflectArgs(4);
        const funcIdx = ensureLateImport(ctx, "__reflect_set", [externRef, externRef, externRef, externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(4, "i32-true");
      }

      // Reflect.has(target, key) — returns i32 (boolean).
      if (reflectMethod === "has" && expr.arguments.length >= 2) {
        emitReflectArgs(2);
        const funcIdx = ensureLateImport(ctx, "__reflect_has", [externRef, externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(2, "i32-true");
      }

      // Reflect.deleteProperty(target, key) — returns i32 (boolean).
      if (reflectMethod === "deleteProperty" && expr.arguments.length >= 2) {
        emitReflectArgs(2);
        const funcIdx = ensureLateImport(ctx, "__reflect_deleteProperty", [externRef, externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(2, "i32-true");
      }

      // Reflect.defineProperty(target, key, desc) — returns i32 (boolean).
      if (reflectMethod === "defineProperty" && expr.arguments.length >= 3) {
        emitReflectArgs(3);
        const funcIdx = ensureLateImport(ctx, "__reflect_defineProperty", [externRef, externRef, externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(3, "i32-true");
      }

      // Reflect.getOwnPropertyDescriptor(target, key) — returns externref.
      if (reflectMethod === "getOwnPropertyDescriptor" && expr.arguments.length >= 2) {
        emitReflectArgs(2);
        const funcIdx = ensureLateImport(
          ctx,
          "__reflect_getOwnPropertyDescriptor",
          [externRef, externRef],
          [externRef],
        );
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(2, "extern-null");
      }

      // Reflect.getPrototypeOf(target) — returns externref.
      if (reflectMethod === "getPrototypeOf" && expr.arguments.length >= 1) {
        emitReflectArgs(1);
        const funcIdx = ensureLateImport(ctx, "__reflect_getPrototypeOf", [externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(1, "extern-null");
      }

      // Reflect.setPrototypeOf(target, proto) — returns i32 (boolean).
      if (reflectMethod === "setPrototypeOf" && expr.arguments.length >= 2) {
        emitReflectArgs(2);
        const funcIdx = ensureLateImport(ctx, "__reflect_setPrototypeOf", [externRef, externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(2, "i32-true");
      }

      // Reflect.ownKeys(target) — returns externref (Array including Symbol keys, per §28.1.13).
      if (reflectMethod === "ownKeys" && expr.arguments.length >= 1) {
        emitReflectArgs(1);
        const funcIdx = ensureLateImport(ctx, "__reflect_ownKeys", [externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(1, "extern-null");
      }

      // Reflect.isExtensible(target) — returns i32 (boolean).
      // Preserve ctx.nonExtensibleVars marking (used by Object.isFrozen / Object.preventExtensions
      // compile-time tracking at calls.ts:2089/2180) for identifiers so legacy callers still see
      // the same answer; but the runtime answer always comes from the host.
      if (reflectMethod === "isExtensible" && expr.arguments.length >= 1) {
        emitReflectArgs(1);
        const funcIdx = ensureLateImport(ctx, "__reflect_isExtensible", [externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(1, "i32-true");
      }

      // Reflect.preventExtensions(target) — returns i32 (boolean).
      // Keep ctx.nonExtensibleVars side-effect for identifiers so the Object.* compile-time
      // fast path stays consistent with the host's runtime answer.
      if (reflectMethod === "preventExtensions" && expr.arguments.length >= 1) {
        const arg0 = expr.arguments[0]!;
        if (ts.isIdentifier(arg0)) {
          ctx.nonExtensibleVars.add(arg0.text);
        }
        emitReflectArgs(1);
        const funcIdx = ensureLateImport(ctx, "__reflect_preventExtensions", [externRef], [i32Ty]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "i32" };
        }
        return fallbackReturn(1, "i32-true");
      }

      // Reflect.apply(fn, thisArg, argList) — returns externref. Host performs CreateListFromArrayLike.
      if (reflectMethod === "apply" && expr.arguments.length >= 3) {
        emitReflectArgs(3);
        const funcIdx = ensureLateImport(ctx, "__reflect_apply", [externRef, externRef, externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(3, "extern-null");
      }

      // Reflect.construct(C, args, [newTarget]) — returns externref.
      // Passing ref.null.extern for omitted newTarget lets the host wrapper default to `C`.
      if (reflectMethod === "construct" && expr.arguments.length >= 2) {
        emitReflectArgs(3);
        const funcIdx = ensureLateImport(ctx, "__reflect_construct", [externRef, externRef, externRef], [externRef]);
        flushLateImportShifts(ctx, fctx);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
        return fallbackReturn(3, "extern-null");
      }
    }

    // Handle Promise.all / Promise.race / Promise.allSettled / Promise.any / Promise.resolve / Promise.reject — host-delegated static calls
    //
    // (#1368) For the four aggregators, we pass `thisArg` so the spec-compliant
    // helper can construct via `thisArg.call(...)` for subclass support.
    // Resolve/reject keep their original 1-arg signature (no thisArg needed).
    {
      const isAggregatorMethod =
        propAccess.name.text === "all" ||
        propAccess.name.text === "race" ||
        propAccess.name.text === "allSettled" ||
        propAccess.name.text === "any";
      // (#1116b, E1) `Sub.all(iter)` where `Sub` is a `class extends Promise`
      // is a subclass static inherited from Promise. Recognise the subclass
      // receiver here too so it reaches the aggregator lowering (the thisArg
      // resolution below switches it to directCall=0).
      const isPromiseSubclassReceiver =
        ts.isIdentifier(propAccess.expression) &&
        (() => {
          const name = ctx.classExprNameMap.get(propAccess.expression.text) ?? propAccess.expression.text;
          let cursor: string | undefined = name;
          const seen = new Set<string>();
          while (cursor !== undefined && !seen.has(cursor)) {
            seen.add(cursor);
            if (ctx.classBuiltinParentMap.get(cursor) === "Promise") return true;
            cursor = ctx.classParentMap.get(cursor);
          }
          return false;
        })();
      const isAggregator =
        ts.isIdentifier(propAccess.expression) &&
        (propAccess.expression.text === "Promise" || isPromiseSubclassReceiver) &&
        isAggregatorMethod;
      const isResolveReject =
        ts.isIdentifier(propAccess.expression) &&
        propAccess.expression.text === "Promise" &&
        (propAccess.name.text === "resolve" || propAccess.name.text === "reject");
      if (isAggregator) {
        const methodName = propAccess.name.text;
        const importName = `Promise_${methodName}`;
        // Three-arg signature: (thisArg, iterable, directCall) → result
        // (#1116) directCall=1 means "no explicit `.call` was used; default to
        // globalThis.Promise". directCall=0 means "user wrote `.call(thisArg, …)`;
        // pass thisArg through unchanged so the runtime / V8 can apply the
        // spec-mandated TypeError when thisArg is non-Object."
        let funcIdx =
          ctx.funcMap.get(importName) ??
          ensureLateImport(
            ctx,
            importName,
            [{ kind: "externref" }, { kind: "externref" }, { kind: "i32" }],
            [{ kind: "externref" }],
          );
        flushLateImportShifts(ctx, fctx);
        funcIdx = ctx.funcMap.get(importName) ?? funcIdx;
        if (funcIdx !== undefined) {
          // (#1116b, E1) Subclass static `Sub.all(iter)` — the receiver
          // `Sub` is a `class extends Promise`. Resolve it to the synthesized
          // JS subclass as thisArg and switch to directCall=0 so the runtime
          // uses it instead of substituting globalThis.Promise.
          const subclassThisArg = resolvePromiseSubclassThisArg(ctx, fctx, propAccess.expression);
          if (!subclassThisArg) {
            // Direct `Promise.METHOD(iter)` — no explicit thisArg.
            fctx.body.push({ op: "ref.null.extern" });
          }
          if (expr.arguments.length >= 1) {
            // (#1465) The runtime helper delegates to native
            // `Promise.METHOD.call(C, iter)` which drives `GetIterator(iter)`
            // per spec. For that to work the host engine must see a real JS
            // iterable. Array literals tend to compile to a wasm tuple/vec
            // struct that's opaque to the host, so materialise them into a
            // JS array eagerly here. Other expressions fall back to plain
            // externref coercion (the runtime helper handles strings, JS
            // arrays, generators, custom iterables, and known wasm vec
            // shapes via __vec_len/__vec_get).
            emitIterableArg(ctx, fctx, expr.arguments[0]!);
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          // directCall=1 — runtime substitutes globalThis.Promise. When a
          // subclass receiver was resolved (E1), directCall=0 so the runtime
          // uses the synthesized thisArg ctor instead.
          fctx.body.push({ op: "i32.const", value: subclassThisArg ? 0 : 1 });
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }
      if (isResolveReject) {
        const methodName = propAccess.name.text;
        // (#1326 Phase 1B) Standalone-mode `Promise.resolve(v)` /
        // `Promise.reject(r)` — emit Wasm-native `$Promise` struct.new
        // instead of calling the JS-host `Promise_resolve_import` /
        // `Promise_reject_import` (unsatisfiable in WASI).
        if (isStandalonePromiseActive(ctx)) {
          // Compile the value/reason argument FIRST into a side buffer
          // so the helper controls the final Wasm op order
          // (state | value | null | struct.new | extern.convert_any).
          const argInstrs: Instr[] = [];
          const savedBody = fctx.body;
          fctx.body = argInstrs;
          try {
            if (expr.arguments.length >= 1) {
              compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          } finally {
            fctx.body = savedBody;
          }
          if (methodName === "resolve") {
            emitStandalonePromiseResolve(ctx, fctx, argInstrs);
          } else {
            emitStandalonePromiseReject(ctx, fctx, argInstrs);
          }
          return { kind: "externref" };
        }
        const importName = `Promise_${methodName}`;
        let funcIdx =
          ctx.funcMap.get(importName) ??
          ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        funcIdx = ctx.funcMap.get(importName) ?? funcIdx;
        if (funcIdx !== undefined) {
          if (expr.arguments.length >= 1) {
            compileExpression(ctx, fctx, expr.arguments[0]!, {
              kind: "externref",
            });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }
    }

    // (#1368) Detect `Promise.METHOD.call(thisArg, iter)` pattern — common in
    // test262 to set a custom constructor (`Promise.all.call(SubClass, iter)`).
    // The current call expression looks like `(Promise.METHOD).call(thisArg, iter)`,
    // i.e. propAccess.name.text === "call" and propAccess.expression is a
    // PropertyAccess `Promise.METHOD`.
    if (
      propAccess.name.text === "call" &&
      ts.isPropertyAccessExpression(propAccess.expression) &&
      ts.isIdentifier(propAccess.expression.expression) &&
      propAccess.expression.expression.text === "Promise" &&
      (propAccess.expression.name.text === "all" ||
        propAccess.expression.name.text === "race" ||
        propAccess.expression.name.text === "allSettled" ||
        propAccess.expression.name.text === "any") &&
      expr.arguments.length >= 1
    ) {
      // (#1326 Phase 1B note) The `.call(...)` aggregator pattern only
      // fires for all/race/allSettled/any (see `condition above`), NOT
      // for Promise.resolve/reject. Phase 1B's standalone path lives at
      // the earlier direct-call site (`Promise.resolve(v)` /
      // `Promise.reject(r)` without `.call`) and does not apply here.
      const methodName = propAccess.expression.name.text;
      const importName = `Promise_${methodName}`;
      // Three-arg signature: (thisArg, iterable, directCall) → result. See (#1116)
      // comment at the direct-call branch above.
      let funcIdx =
        ctx.funcMap.get(importName) ??
        ensureLateImport(
          ctx,
          importName,
          [{ kind: "externref" }, { kind: "externref" }, { kind: "i32" }],
          [{ kind: "externref" }],
        );
      flushLateImportShifts(ctx, fctx);
      funcIdx = ctx.funcMap.get(importName) ?? funcIdx;
      if (funcIdx !== undefined) {
        // arg0 = thisArg (user-provided — may be undefined/null/primitive,
        // in which case the runtime / V8 throws TypeError per spec §27.2.4.X step 2).
        // (#1116b) When thisArg names a `class X extends Promise`, resolve it to
        // a synthesized JS-callable Promise subclass; otherwise compile normally.
        if (!resolvePromiseSubclassThisArg(ctx, fctx, expr.arguments[0]!)) {
          compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
        }
        // arg1 = iterable (or ref.null if missing). #1465: materialise array
        // literals to JS arrays so native GetIterator can drive them.
        if (expr.arguments.length >= 2) {
          emitIterableArg(ctx, fctx, expr.arguments[1]!);
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        // directCall=0 — user invoked via `.call`, so thisArg is meaningful.
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }

    // Handle JSON.stringify / JSON.parse as host import calls
    if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "JSON") {
      const method = propAccess.name.text;
      if ((method === "stringify" || method === "parse") && expr.arguments.length >= 1) {
        // (#1324 primitives slice) For JSON.stringify of statically-typed
        // primitive values (null / undefined / boolean, plus number when the
        // target has a number_toString helper), emit the result without the
        // JSON_stringify host import. Standalone/WASI number stringify falls
        // through to the #1599 refusal until Phase 2 has pure-Wasm formatting.
        // Object/array/string/bigint cases fall through to the existing
        // JSON_stringify host import — full pure-Wasm shape walking is
        // tracked under #1353 (architect-spec follow-up).
        if (method === "stringify") {
          const primitiveStringType = tryEmitJsonStringifyPrimitive(ctx, fctx, expr.arguments[0]!);
          if (primitiveStringType !== undefined) {
            // Compile remaining args (replacer, space) for their side
            // effects only — primitive stringify ignores them per spec
            // §25.5.4 (replacer doesn't observe primitives, space only
            // affects nested output).
            for (let i = 1; i < expr.arguments.length; i++) {
              const t = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (t) fctx.body.push({ op: "drop" } as Instr);
            }
            return primitiveStringType;
          }
          if ((ctx.standalone || ctx.wasi) && expr.arguments.length >= 1) {
            // #2166: thread the optional replacer (must be null/undefined) and
            // space args so `JSON.stringify(value, null, 2)` produces the
            // indented form statically instead of refusing.
            const staticStringType = tryEmitJsonStringifyStatic(
              ctx,
              fctx,
              expr.arguments[0]!,
              expr.arguments[1],
              expr.arguments[2],
            );
            if (staticStringType !== undefined) {
              return staticStringType;
            }
          }
        }
        if (method === "parse" && (ctx.standalone || ctx.wasi)) {
          const parsedType = tryEmitJsonParseLiteral(ctx, fctx, expr);
          if (parsedType !== undefined) {
            return parsedType;
          }
          // (#1599 Phase 2) Runtime string-value JSON.parse → primitive slice
          // (number / true / false / null) via pure-Wasm helper, boxed as
          // $AnyValue. Strings / objects / arrays still fall through to refusal.
          const primitiveParsed = tryEmitJsonParsePrimitive(ctx, fctx, expr, expr.arguments[0]!);
          if (primitiveParsed !== undefined) {
            return primitiveParsed;
          }
        }
        // (#1599 Phase 1) Refuse-and-document: in standalone (no-JS-host) /
        // WASI mode there is no `env::JSON_*` host import to fall back to.
        // The primitive `JSON.stringify` slice above (#1324) already handles
        // null / undefined / boolean as pure Wasm; everything else
        // (objects, arrays, strings, and all `JSON.parse`) needs the pure-Wasm
        // codec from Phase 2, which is not yet implemented. Emit a clear
        // compile error rather than a module that traps at instantiation.
        if (ctx.standalone || ctx.wasi) {
          reportError(
            ctx,
            expr,
            `Codegen error: JSON.${method} of this value is not yet supported in --target standalone/wasi (#1599). ` +
              `Pure-Wasm JSON.stringify of null/undefined/boolean works standalone; ` +
              `numbers, objects, arrays, strings, and JSON.parse require the Phase 2 pure-Wasm codec (#1599 Phase 2). ` +
              `Avoid JSON for these shapes in standalone/WASI targets for now.`,
          );
          return null;
        }
        const importName = `JSON_${method}`;
        const funcIdx = ctx.funcMap.get(importName);
        if (funcIdx !== undefined) {
          // Compile first argument and coerce to externref
          const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
          if (argType && argType.kind !== "externref") {
            coerceType(ctx, fctx, argType, { kind: "externref" });
          }
          if (method === "stringify") {
            // Pass replacer (arg 2) and space (arg 3), or null sentinels
            if (expr.arguments.length >= 2) {
              const repType = compileExpression(ctx, fctx, expr.arguments[1]!);
              if (repType && repType.kind !== "externref") {
                coerceType(ctx, fctx, repType, { kind: "externref" });
              }
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            if (expr.arguments.length >= 3) {
              const spType = compileExpression(ctx, fctx, expr.arguments[2]!);
              if (spType && spType.kind !== "externref") {
                coerceType(ctx, fctx, spType, { kind: "externref" });
              }
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else {
            // #2013 — `JSON.parse(text, reviver)` §25.5.1: forward the reviver
            // (arg 2) so the host applies InternalizeJSONProperty. A WasmGC
            // closure reviver coerces to externref like any other ref and the
            // host bridges it via `__call_fn_2`; absent → null sentinel (no-op).
            if (expr.arguments.length >= 2) {
              const revType = compileExpression(ctx, fctx, expr.arguments[1]!);
              if (revType && revType.kind !== "externref") {
                coerceType(ctx, fctx, revType, { kind: "externref" });
              }
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          }
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }
    }

    // (#1483) performance.now() under --target wasi → clock_time_get
    // (CLOCK_MONOTONIC). In JS-host mode we leave existing behaviour (declared
    // global) alone so this branch only fires when a WASI helper exists.
    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "performance" &&
      propAccess.name.text === "now" &&
      ctx.wasi &&
      ctx.funcMap.has("__wasi_performance_now")
    ) {
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__wasi_performance_now")! } as Instr);
      return { kind: "f64" };
    }

    {
      const temporalStaticResult = tryCompileTemporalStaticCall(ctx, fctx, propAccess, expr);
      if (temporalStaticResult !== undefined) return temporalStaticResult;
    }

    // Handle Date.now() and Date.UTC() — pure Wasm static methods
    if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "Date") {
      const method = propAccess.name.text;
      if (method === "now") {
        // (#1483) Under --target wasi, route to clock_time_get instead of the
        // env::__date_now host import (which wasmtime does not provide).
        if (ctx.wasi && ctx.funcMap.has("__wasi_date_now")) {
          fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__wasi_date_now")! } as Instr);
          return { kind: "f64" };
        }
        // (#2164) Pure standalone (--target standalone, no JS host AND no WASI
        // clock) has no wall-clock source, so the env::__date_now host import is
        // unsatisfiable — every module that calls Date.now() (or new Date() with
        // no args) failed to instantiate standalone, breaking unrelated Date
        // tests that only touch Date.now() in setup. Emit the Unix epoch (0)
        // directly: deterministic, no import leak, module instantiates. Tests
        // that construct explicit timestamps (the bulk of the gap) then work;
        // only tests asserting a *real* current time (which standalone WasmGC
        // cannot provide) stay failing — and those need a clock source, not a
        // host import.
        if (ctx.standalone === true) {
          fctx.body.push({ op: "f64.const", value: 0 } as Instr);
          return { kind: "f64" };
        }
        const dateNowIdx = ensureLateImport(ctx, "__date_now", [], [{ kind: "f64" }]);
        if (dateNowIdx !== undefined) {
          flushLateImportShifts(ctx, fctx);
          fctx.body.push({ op: "call", funcIdx: dateNowIdx } as Instr);
        } else {
          fctx.body.push({ op: "f64.const", value: 0 } as Instr);
        }
        return { kind: "f64" };
      }
      if (method === "UTC") {
        // Date.UTC(year, month, day?, hours?, minutes?, seconds?, ms?)
        // Same as new Date(y,m,d,...).getTime() but without the year 0-99 quirk
        const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);
        const args = expr.arguments;

        // year
        if (args.length >= 1) {
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        } else {
          fctx.body.push({ op: "f64.const", value: 1970 } as Instr);
        }
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        const yearL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: yearL } as Instr);

        // month (0-indexed) + 1
        if (args.length >= 2) {
          compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
          fctx.body.push({ op: "i64.const", value: 1n } as Instr);
          fctx.body.push({ op: "i64.add" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 1n } as Instr);
        }
        const monthL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: monthL } as Instr);

        // day (default 1)
        if (args.length >= 3) {
          compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 1n } as Instr);
        }
        const dayL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: dayL } as Instr);

        // hours (default 0)
        if (args.length >= 4) {
          compileExpression(ctx, fctx, args[3]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 0n } as Instr);
        }
        const hoursL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: hoursL } as Instr);

        // minutes (default 0)
        if (args.length >= 5) {
          compileExpression(ctx, fctx, args[4]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 0n } as Instr);
        }
        const minutesL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: minutesL } as Instr);

        // seconds (default 0)
        if (args.length >= 6) {
          compileExpression(ctx, fctx, args[5]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 0n } as Instr);
        }
        const secondsL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: secondsL } as Instr);

        // ms (default 0)
        if (args.length >= 7) {
          compileExpression(ctx, fctx, args[6]!, { kind: "f64" });
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: 0n } as Instr);
        }
        const msL = allocTempLocal(fctx, { kind: "i64" });
        fctx.body.push({ op: "local.set", index: msL } as Instr);

        // days_from_civil(year, month, day) * 86400000 + h*3600000 + m*60000 + s*1000 + ms
        fctx.body.push(
          { op: "local.get", index: yearL } as Instr,
          { op: "local.get", index: monthL } as Instr,
          { op: "local.get", index: dayL } as Instr,
          { op: "call", funcIdx: daysFromCivilIdx } as Instr,
          { op: "i64.const", value: 86400000n } as Instr,
          { op: "i64.mul" } as Instr,
          { op: "local.get", index: hoursL } as Instr,
          { op: "i64.const", value: 3600000n } as Instr,
          { op: "i64.mul" } as Instr,
          { op: "i64.add" } as Instr,
          { op: "local.get", index: minutesL } as Instr,
          { op: "i64.const", value: 60000n } as Instr,
          { op: "i64.mul" } as Instr,
          { op: "i64.add" } as Instr,
          { op: "local.get", index: secondsL } as Instr,
          { op: "i64.const", value: 1000n } as Instr,
          { op: "i64.mul" } as Instr,
          { op: "i64.add" } as Instr,
          { op: "local.get", index: msL } as Instr,
          { op: "i64.add" } as Instr,
          { op: "f64.convert_i64_s" } as Instr,
        );

        releaseTempLocal(fctx, msL);
        releaseTempLocal(fctx, secondsL);
        releaseTempLocal(fctx, minutesL);
        releaseTempLocal(fctx, hoursL);
        releaseTempLocal(fctx, dayL);
        releaseTempLocal(fctx, monthL);
        releaseTempLocal(fctx, yearL);

        return { kind: "f64" };
      }
      // Date.parse — stub: return NaN
      if (method === "parse") {
        // Drop argument if any
        for (const arg of expr.arguments) {
          const t = compileExpression(ctx, fctx, arg);
          if (t) fctx.body.push({ op: "drop" } as Instr);
        }
        fctx.body.push({ op: "f64.const", value: NaN } as Instr);
        return { kind: "f64" };
      }
    }

    // Check if this is a static method call: ClassName.staticMethod(args)
    if (ts.isIdentifier(propAccess.expression) && ctx.classSet.has(propAccess.expression.text)) {
      const clsName = propAccess.expression.text;
      const methodName = propAccess.name.text;
      const fullName = `${clsName}_${methodName}`;
      if (ctx.staticMethodSet.has(fullName)) {
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)); // (#1983)
        if (funcIdx !== undefined) {
          // No self parameter for static methods
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const staticParamCount = paramTypes ? paramTypes.length : expr.arguments.length;
          const calleeReadsArgsEarly = ctx.funcUsesArguments.has(fullName);
          for (let i = 0; i < Math.min(expr.arguments.length, staticParamCount); i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
          }
          if (expr.arguments.length > staticParamCount) {
            if (calleeReadsArgsEarly) {
              emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], staticParamCount);
            } else {
              for (let i = staticParamCount; i < expr.arguments.length; i++) {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
          }
          // Pad missing arguments with defaults
          if (paramTypes) {
            for (let i = expr.arguments.length; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          // Set __argc before the call so the callee knows the actual arg count
          maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, staticParamCount);
          // Re-lookup funcIdx: argument compilation may trigger addUnionImports
          const finalStaticIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)) ?? funcIdx; // (#1983)
          fctx.body.push({ op: "call", funcIdx: finalStaticIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalStaticIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalStaticIdx) ?? resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
      }
    }

    // Check if receiver is an externref object
    const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);

    // TextEncoder/TextDecoder under no-JS-host targets. These are standard
    // Web/Node APIs, but WASI/standalone cannot rely on env.TextEncoder_* host
    // imports. Lower the narrow UTF-8 surface natively.
    if ((noJsHost(ctx) || ctx.strictNoHostImports) && ctx.nativeStrings) {
      const recvSym =
        receiverType.getSymbol()?.name ??
        (ts.isNewExpression(propAccess.expression) && ts.isIdentifier(propAccess.expression.expression)
          ? propAccess.expression.expression.text
          : undefined);
      const method = propAccess.name.text;
      if (recvSym === "TextEncoder" && method === "encode") {
        const { encodeIdx, vecTypeIdx } = ensureTextEncodingHelpers(ctx);
        const recvResult = compileExpression(ctx, fctx, propAccess.expression);
        if (recvResult !== null) fctx.body.push({ op: "drop" } as Instr);
        if (expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!, nativeStringType(ctx));
        } else {
          compileStringLiteral(ctx, fctx, "");
        }
        for (let i = 1; i < expr.arguments.length; i++) {
          const extra = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extra !== null) fctx.body.push({ op: "drop" } as Instr);
        }
        fctx.body.push({ op: "call", funcIdx: encodeIdx } as Instr);
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }

      if (recvSym === "TextDecoder" && method === "decode") {
        const { decodeU8Idx, vecTypeIdx } = ensureTextEncodingHelpers(ctx);
        const recvResult = compileExpression(ctx, fctx, propAccess.expression);
        if (recvResult !== null) fctx.body.push({ op: "drop" } as Instr);
        if (expr.arguments.length === 0) {
          compileStringLiteral(ctx, fctx, "");
          return nativeStringType(ctx);
        }
        const expected: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
        const argType = compileExpression(ctx, fctx, expr.arguments[0]!, expected);
        if (argType && !valTypesMatch(argType, expected)) {
          coerceType(ctx, fctx, argType, expected);
        }
        for (let i = 1; i < expr.arguments.length; i++) {
          const extra = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extra !== null) fctx.body.push({ op: "drop" } as Instr);
        }
        fctx.body.push({ op: "call", funcIdx: decodeU8Idx } as Instr);
        return nativeStringType(ctx);
      }
    }

    // Handle Date instance method calls BEFORE extern class dispatch,
    // because Date is declared in lib.d.ts (so isExternalDeclaredClass returns true)
    // but we implement it natively as a WasmGC struct.
    {
      const temporalResult = tryCompileTemporalMethodCall(ctx, fctx, propAccess, expr);
      if (temporalResult !== undefined) return temporalResult;
    }

    {
      const dateResult = compileDateMethodCall(ctx, fctx, propAccess, expr, receiverType);
      if (dateResult !== undefined) return dateResult;
    }

    // Property introspection: hasOwnProperty / propertyIsEnumerable
    // Must be checked BEFORE extern class dispatch so that calls like
    // regexp.hasOwnProperty("x") use the generic handler instead of
    // looking for a non-existent RegExp_hasOwnProperty import.
    if (propAccess.name.text === "hasOwnProperty" || propAccess.name.text === "propertyIsEnumerable") {
      return compilePropertyIntrospection(ctx, fctx, propAccess, expr);
    }

    // #1654 — native DataView accessors in no-JS-host mode. In JS-host mode the
    // runtime materializes a real DataView over the byte array; standalone/WASI
    // has no JS runtime, so emit Wasm-native byte read/write into the i32_byte
    // backing array directly. Must run BEFORE the extern-class dispatch, which
    // would otherwise route DataView_setUint32 to an unsatisfiable host import
    // (or silently drop the call).
    if (noJsHost(ctx) && isDataViewAccessor(propAccess.name.text)) {
      const recvSym = receiverType.getSymbol()?.name;
      if (recvSym === "DataView") {
        const dvResult = emitDataViewAccessor(
          ctx,
          fctx,
          propAccess.name.text,
          propAccess.expression,
          expr.arguments,
          (e, hint) => compileExpression(ctx, fctx, e, hint),
        );
        if (dvResult) {
          return dvResult.kind === "get" ? dvResult.result : VOID_RESULT;
        }
      }
    }

    // #1698 / #1717 — native ArrayBuffer.prototype.slice. The ArrayBuffer
    // backing store is the same `i32_byte` vec struct in BOTH JS-host and
    // standalone modes, so the byte-by-byte copy is mode-agnostic. In JS-host
    // mode `slice` was previously dropped by the extern-class dispatch
    // (`slice is not a function`, #1717); in standalone there is no runtime
    // (#1698). Route both through the same native emitter — emit a byte copy
    // into a fresh i32_byte vec. (SharedArrayBuffer is filtered out: it has no
    // i32_byte struct, so the cast would trap.)
    if (propAccess.name.text === "slice") {
      const recvSym = receiverType.getSymbol()?.name;
      if (recvSym === "ArrayBuffer") {
        const sliceResult = emitArrayBufferSlice(ctx, fctx, propAccess.expression, expr.arguments, (e, hint) =>
          compileExpression(ctx, fctx, e, hint),
        );
        if (sliceResult) return sliceResult;
      }
    }

    if (isExternalDeclaredClass(receiverType, ctx.checker)) {
      const externResult = compileExternMethodCall(ctx, fctx, propAccess, expr);
      // undefined means method not found in extern class hierarchy — fall through to generic handlers
      if (externResult !== undefined) return externResult;
    }

    // Generator method calls: gen.next(), gen.return(value), gen.throw(error)
    if (isGeneratorType(receiverType)) {
      const methodName = propAccess.name.text;
      const nativeResult = tryCompileNativeGeneratorMethodCall(
        ctx,
        fctx,
        propAccess.expression,
        methodName,
        expr.arguments,
      );
      if (nativeResult !== undefined) return nativeResult;
      if (methodName === "next") {
        compileExpression(ctx, fctx, propAccess.expression);
        const funcIdx = ctx.funcMap.get("__gen_next");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" }; // Returns IteratorResult as externref
        }
      } else if (methodName === "return") {
        compileExpression(ctx, fctx, propAccess.expression);
        // Push the argument (value to return), default to ref.null if none
        if (expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!, {
            kind: "externref",
          });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        const funcIdx = ctx.funcMap.get("__gen_return");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" }; // Returns IteratorResult as externref
        }
      } else if (methodName === "throw") {
        compileExpression(ctx, fctx, propAccess.expression);
        // Push the argument (error to throw), default to ref.null if none
        if (expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!, {
            kind: "externref",
          });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        const funcIdx = ctx.funcMap.get("__gen_throw");
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" }; // Returns IteratorResult as externref
        }
      }
    }

    // Handle Promise instance methods: .then(cb1, cb2?), .catch(cb), .finally(cb)
    // Promise values are externref; delegate to host imports registered as LATE
    // imports (during codegen, not collection) to avoid type index corruption (#961).
    // GUARD: Only match when receiver TS type is Promise (prevents routing
    // compiled async function returns through host Promise path — v1 regression)
    {
      const method = propAccess.name.text;
      if ((method === "then" || method === "catch" || method === "finally") && expr.arguments.length >= 1) {
        const receiverTsType = ctx.checker.getTypeAtLocation(propAccess.expression);
        const recvSym = receiverTsType.getSymbol()?.name;
        const apparentSym = ctx.checker.getApparentType(receiverTsType).getSymbol()?.name;
        const isPromiseReceiver = recvSym === "Promise" || apparentSym === "Promise";

        if (isPromiseReceiver) {
          if (isStandalonePromiseActive(ctx) && method === "then") {
            const liveBuffers: Instr[][] = [];
            try {
              const promiseInstrs = compilePromiseThenReceiverBuffer(ctx, fctx, propAccess.expression, liveBuffers);
              const onFulfilled = compileStandalonePromiseThenCallback(ctx, fctx, expr.arguments[0], liveBuffers);
              const onRejected = compileStandalonePromiseThenCallback(ctx, fctx, expr.arguments[1], liveBuffers);
              emitStandalonePromiseThen(ctx, fctx, promiseInstrs, onFulfilled, onRejected);
            } finally {
              for (const b of liveBuffers) ctx.liveBodies.delete(b);
            }
            return { kind: "externref" };
          }

          // (#2165) Standalone `.catch(onRejected)` ≡ `.then(undefined, onRejected)`
          // per §27.2.5.1. Reuse the native `$Promise` then-machinery so WASI
          // mode doesn't leak the `Promise_catch` / `__make_callback` host
          // imports. The chained promise still propagates a fulfilled receiver
          // unchanged (onFulfilled = null) and routes a rejection through the
          // user's onRejected continuation.
          if (isStandalonePromiseActive(ctx) && method === "catch") {
            const liveBuffers: Instr[][] = [];
            try {
              const promiseInstrs = compilePromiseThenReceiverBuffer(ctx, fctx, propAccess.expression, liveBuffers);
              const onRejected = compileStandalonePromiseThenCallback(ctx, fctx, expr.arguments[0], liveBuffers);
              emitStandalonePromiseThen(ctx, fctx, promiseInstrs, null, onRejected);
            } finally {
              for (const b of liveBuffers) ctx.liveBodies.delete(b);
            }
            return { kind: "externref" };
          }

          // Determine import name: use Promise_then2 for .then(cb1, cb2)
          const useThen2 = method === "then" && expr.arguments.length >= 2;
          const importName = useThen2 ? "Promise_then2" : `Promise_${method}`;

          // Register as late import (NOT during collection — #960 fix)
          const paramTypes: ValType[] = useThen2
            ? [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }]
            : [{ kind: "externref" }, { kind: "externref" }];
          let funcIdx =
            ctx.funcMap.get(importName) ?? ensureLateImport(ctx, importName, paramTypes, [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          funcIdx = ctx.funcMap.get(importName) ?? funcIdx;

          if (funcIdx !== undefined) {
            // Compile the Promise value (receiver)
            compileExpression(ctx, fctx, propAccess.expression, {
              kind: "externref",
            });
            // Compile the first callback argument, coercing to externref
            const cbType = compileExpression(ctx, fctx, expr.arguments[0]!, {
              kind: "externref",
            });
            if (cbType && cbType.kind !== "externref") {
              coerceType(ctx, fctx, cbType, { kind: "externref" });
            }
            // For .then(cb1, cb2): compile second callback
            if (useThen2) {
              const cb2Type = compileExpression(ctx, fctx, expr.arguments[1]!, {
                kind: "externref",
              });
              if (cb2Type && cb2Type.kind !== "externref") {
                coerceType(ctx, fctx, cb2Type, { kind: "externref" });
              }
            }
            // Re-lookup funcIdx after compiling args (late imports may shift)
            const finalIdx = ctx.funcMap.get(importName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalIdx });
            return { kind: "externref" };
          }
        }
      }
    }

    // (#1397) Wrapper-object dynamic dispatch on reassigned methods.
    //
    // For wrapper-object receivers (`new String/Number/Boolean(...)`) where
    // `.toString` or `.valueOf` has been reassigned somewhere in the source,
    // skip every static fast-path and route through `__extern_method_call`
    // so the runtime property lookup picks up the override. Required for
    // spec compliance with transferred prototype methods (S15.7.4.2_A4_*,
    // S15.7.4.4_A2_*, S15.6.4.2_A2_*, S15.6.4.3_A2_*):
    //
    //   var s1 = new String();
    //   s1.toString = Number.prototype.toString;
    //   s1.toString();   // spec: TypeError; we used to return s1 itself.
    //
    // Primitives keep the static fast-path — primitives can't have own
    // properties, so `"abc".toString = …` is a no-op and the short-circuit
    // is correct. Wrappers without any matching reassignment in the source
    // also keep the static fast-path (no perf regression for the common
    // case). The reassignment scan is conservative — any
    // `<expr>.<method> = …` anywhere in the source disables the static
    // path for wrappers; that's a narrower hit than Option B (always
    // dynamic) and matches the architect's Option D feasibility study.
    {
      const wrapperMethodName = propAccess.name.text;
      const isWrapperReceiver =
        isStringWrapperType(receiverType) || isNumberWrapperType(receiverType) || isBooleanWrapperType(receiverType);
      if (
        isWrapperReceiver &&
        (wrapperMethodName === "valueOf" || wrapperMethodName === "toString") &&
        expr.arguments.length === 0 &&
        sourceHasMethodReassignment(ctx, propAccess.expression, wrapperMethodName)
      ) {
        const dynResult = emitWrapperDynamicMethodCall(ctx, fctx, propAccess.expression, wrapperMethodName);
        if (dynResult) return dynResult;
      }
    }

    // Handle wrapper type method calls: new Number(x).valueOf(), etc.
    // Since wrapper constructors now return primitives, valueOf() is a no-op identity.
    {
      const wrapperMethodName = propAccess.name.text;
      const recvSymName = receiverType.getSymbol()?.name;
      if (recvSymName === "Number" && wrapperMethodName === "valueOf") {
        compileExpression(ctx, fctx, propAccess.expression, { kind: "f64" });
        return { kind: "f64" };
      }
      if (recvSymName === "String" && wrapperMethodName === "valueOf") {
        // new String("x") now returns a real String wrapper object (externref).
        // valueOf() must extract the primitive string via __unbox_string (#929).
        compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
        const unboxIdx = ensureLateImport(ctx, "__unbox_string", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (unboxIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: unboxIdx });
        }
        return { kind: "externref" };
      }
      if (recvSymName === "Boolean" && wrapperMethodName === "valueOf") {
        compileExpression(ctx, fctx, propAccess.expression, { kind: "i32" });
        return { kind: "i32" };
      }
    }

    // Check if receiver is a local class instance
    let receiverClassName = receiverType.getSymbol()?.name;
    // Map class expression symbol names to their synthetic names
    if (receiverClassName && !ctx.classSet.has(receiverClassName)) {
      receiverClassName = ctx.classExprNameMap.get(receiverClassName) ?? receiverClassName;
    }
    // Fallback for union types, interfaces, abstract classes:
    // When the direct symbol name is not a known class, try to resolve via
    // union members, apparent type, or base types.
    if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
      const methodName = ts.isPrivateIdentifier(propAccess.name)
        ? "__priv_" + propAccess.name.text.slice(1)
        : propAccess.name.text;
      // Try union type members: for `A | B`, check each member for a known class
      if (receiverType.isUnion()) {
        for (const memberType of (receiverType as ts.UnionType).types) {
          let memberName = memberType.getSymbol()?.name;
          if (memberName && !ctx.classSet.has(memberName)) {
            memberName = ctx.classExprNameMap.get(memberName) ?? memberName;
          }
          if (memberName && ctx.classSet.has(memberName)) {
            const fullName = `${memberName}_${methodName}`;
            if (ctx.funcMap.has(fullName)) {
              receiverClassName = memberName;
              break;
            }
            // Walk inheritance chain
            let ancestor = ctx.classParentMap.get(memberName);
            while (ancestor) {
              if (ctx.funcMap.has(`${ancestor}_${methodName}`)) {
                receiverClassName = memberName;
                break;
              }
              ancestor = ctx.classParentMap.get(ancestor);
            }
            if (receiverClassName && ctx.classSet.has(receiverClassName)) break;
          }
        }
      }
      // Try apparent type (handles interfaces, abstract classes)
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const apparentType = ctx.checker.getApparentType(receiverType);
        if (apparentType !== receiverType) {
          let apparentName = apparentType.getSymbol()?.name;
          if (apparentName && !ctx.classSet.has(apparentName)) {
            apparentName = ctx.classExprNameMap.get(apparentName) ?? apparentName;
          }
          if (apparentName && ctx.classSet.has(apparentName) && ctx.funcMap.has(`${apparentName}_${methodName}`)) {
            receiverClassName = apparentName;
          }
        }
      }
      // Try base types: if the receiver type has base types (e.g. abstract class → concrete class)
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const baseTypes = receiverType.getBaseTypes?.();
        if (baseTypes) {
          for (const baseType of baseTypes) {
            let baseName = baseType.getSymbol()?.name;
            if (baseName && !ctx.classSet.has(baseName)) {
              baseName = ctx.classExprNameMap.get(baseName) ?? baseName;
            }
            if (baseName && ctx.classSet.has(baseName) && ctx.funcMap.has(`${baseName}_${methodName}`)) {
              receiverClassName = baseName;
              break;
            }
          }
        }
      }
      // Try struct name from the receiver's wasm type
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const structName = resolveStructName(ctx, receiverType);
        if (structName && ctx.classSet.has(structName) && ctx.funcMap.has(`${structName}_${methodName}`)) {
          receiverClassName = structName;
        }
      }
      // Final fallback: scan all known classes for one that has the method.
      // This handles interface types and abstract classes where we can't determine
      // the implementing class from the type alone. We pick the first class that
      // has the method and whose struct fields are a superset of the receiver type's properties.
      if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
        const recvProps = receiverType.getProperties?.() ?? [];
        const recvPropNames = new Set(recvProps.map((p) => p.name));
        for (const className of ctx.classSet) {
          if (!ctx.funcMap.has(`${className}_${methodName}`)) continue;
          // Quick heuristic: check that the class has at least the same property names
          // as the interface (structural compatibility check)
          const classFields = ctx.structFields.get(className);
          if (classFields && recvPropNames.size > 0) {
            const classFieldNames = new Set(classFields.map((f) => f.name));
            let compatible = true;
            for (const prop of recvPropNames) {
              // Methods won't be in struct fields, so skip function-typed properties
              const propSymbol = recvProps.find((p) => p.name === prop);
              const propType = propSymbol ? ctx.checker.getTypeOfSymbol(propSymbol) : undefined;
              const isMethod = propType && (propType.getCallSignatures?.()?.length ?? 0) > 0;
              if (!isMethod && !classFieldNames.has(prop)) {
                compatible = false;
                break;
              }
            }
            if (!compatible) continue;
          }
          receiverClassName = className;
          break;
        }
      }
    }
    if (receiverClassName && ctx.classSet.has(receiverClassName)) {
      const methodName = ts.isPrivateIdentifier(propAccess.name)
        ? "__priv_" + propAccess.name.text.slice(1)
        : propAccess.name.text;
      let fullName = `${receiverClassName}_${methodName}`;
      let funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)); // (#1983)
      // Walk inheritance chain to find the method in a parent class
      if (funcIdx === undefined) {
        let ancestor = ctx.classParentMap.get(receiverClassName);
        while (ancestor && funcIdx === undefined) {
          fullName = `${ancestor}_${methodName}`;
          funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)); // (#1983)
          ancestor = ctx.classParentMap.get(ancestor);
        }
      }
      // Walk child classes (handles abstract class → concrete subclass).
      // (#1299) Collect ALL subclass implementations so we can emit a
      // runtime tag-based dispatch (virtual dispatch) when more than one
      // exists. Without this, a base-typed receiver would unconditionally
      // call the first subclass's method regardless of runtime type.
      let virtualCandidates: { className: string; funcIdx: number; classTag: number }[] | undefined;
      if (funcIdx === undefined) {
        const candidates: { className: string; funcIdx: number; classTag: number }[] = [];
        const baseClass = fullName.split("_")[0];
        for (const [childClass, parentClass] of ctx.classParentMap) {
          if (parentClass === receiverClassName || parentClass === baseClass) {
            const childFullName = `${childClass}_${methodName}`;
            const childFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, childFullName)); // (#1983)
            const childTag = ctx.classTagMap.get(childClass);
            if (childFuncIdx !== undefined && childTag !== undefined) {
              candidates.push({ className: childClass, funcIdx: childFuncIdx, classTag: childTag });
            }
          }
        }
        if (candidates.length === 1) {
          fullName = `${candidates[0]!.className}_${methodName}`;
          funcIdx = candidates[0]!.funcIdx;
        } else if (candidates.length > 1) {
          virtualCandidates = candidates;
          fullName = `${candidates[0]!.className}_${methodName}`;
          funcIdx = candidates[0]!.funcIdx;
        }
      } else {
        // Method exists on receiver class — also check for subclass overrides.
        const candidates: { className: string; funcIdx: number; classTag: number }[] = [];
        const recvTag = ctx.classTagMap.get(receiverClassName);
        if (recvTag !== undefined) {
          candidates.push({ className: receiverClassName, funcIdx, classTag: recvTag });
        }
        for (const [childClass, parentClass] of ctx.classParentMap) {
          // Walk full ancestry to capture transitive subclasses.
          let cur: string | undefined = parentClass;
          while (cur) {
            if (cur === receiverClassName) break;
            cur = ctx.classParentMap.get(cur);
          }
          if (cur === receiverClassName && childClass !== receiverClassName) {
            const childFullName = `${childClass}_${methodName}`;
            const childFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, childFullName)); // (#1983)
            const childTag = ctx.classTagMap.get(childClass);
            if (
              childFuncIdx !== undefined &&
              childTag !== undefined &&
              !candidates.some((c) => c.className === childClass)
            ) {
              candidates.push({ className: childClass, funcIdx: childFuncIdx, classTag: childTag });
            }
          }
        }
        if (candidates.length > 1) {
          virtualCandidates = candidates;
        }
      }
      // Early intercept: emit virtual dispatch (tag-comparison cascade,
      // same pattern as `instanceof`) if multiple candidates exist.
      if (virtualCandidates && virtualCandidates.length > 1) {
        const vresult = emitVirtualMethodDispatchByTag(
          ctx,
          fctx,
          expr,
          propAccess,
          virtualCandidates,
          receiverClassName,
        );
        if (vresult !== undefined) return vresult;
      }
      // If no method found, check if the property is a callable struct field
      // (e.g. this.callback() where callback is a function-typed property)
      if (funcIdx === undefined) {
        const callablePropResult = compileCallablePropertyCall(ctx, fctx, expr, propAccess, receiverClassName);
        if (callablePropResult !== undefined) return callablePropResult;
      }
      // If still no method, check if this is a getter that returns a callable.
      // Pattern: c.method(args) where `method` is a getter returning a function ref.
      // We call the getter first, then invoke the returned callable.
      if (funcIdx === undefined) {
        const getterName = `${receiverClassName}_get_${methodName}`;
        const getterIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName)); // (#1983)
        if (getterIdx !== undefined) {
          const getterCallResult = compileGetterCallable(ctx, fctx, expr, propAccess, receiverClassName, getterIdx);
          if (getterCallResult !== undefined) return getterCallResult;
        }
      }
      // Object.prototype fallback for known class instances (#799 WI1):
      // When no method found on the class or its ancestors, check if the method
      // is an Object.prototype method and delegate to the host via externref.
      if (funcIdx === undefined) {
        const objProtoResult = compileObjectPrototypeFallback(
          ctx,
          fctx,
          expr,
          propAccess,
          receiverClassName,
          methodName,
        );
        if (objProtoResult !== undefined) return objProtoResult;
      }
      if (funcIdx !== undefined) {
        const isStaticMethod = ctx.staticMethodSet.has(fullName);
        // Static methods: evaluate receiver for side effects, drop, call directly
        if (isStaticMethod) {
          const recvType = compileExpression(ctx, fctx, propAccess.expression);
          if (recvType !== null) {
            fctx.body.push({ op: "drop" });
          }
          // Re-resolve funcIdx after receiver compilation — emitUndefined (for `this` in static
          // context) triggers addUnionImports which shifts all function indices (#998)
          const resolvedStaticIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)) ?? funcIdx; // (#1983)
          const paramTypes = getFuncParamTypes(ctx, resolvedStaticIdx);
          const paramCount = paramTypes ? paramTypes.length : expr.arguments.length;
          const calleeReadsArgsStatic = ctx.funcUsesArguments.has(fullName);
          for (let i = 0; i < Math.min(expr.arguments.length, paramCount); i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
          }
          if (expr.arguments.length > paramCount) {
            if (calleeReadsArgsStatic) {
              emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], paramCount);
            } else {
              for (let i = paramCount; i < expr.arguments.length; i++) {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
          }
          if (paramTypes) {
            for (let i = expr.arguments.length; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          // Set __argc before the call so the callee knows the actual arg count
          maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, paramCount);
          const finalMethodIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)) ?? resolvedStaticIdx; // (#1983)
          fctx.body.push({ op: "call", funcIdx: finalMethodIdx });
          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalMethodIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalMethodIdx) ?? resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
        // Push self (the receiver) as first argument, with type hint from method's first param
        const methodParamTypes0 = getFuncParamTypes(ctx, funcIdx);
        // (#2132) A method call on a statically-nullable receiver (`C | null`,
        // incl. when laundered through `as any`) must throw a CATCHABLE
        // TypeError on null, not a bare `ref.as_non_null` trap (Wasm null-deref
        // traps bypass the module's exception tags and abort uncatchably).
        // Detect nullability from the static type here, because the param-0 type
        // hint passed to compileExpression below can coerce the value to a
        // non-null `ref` and hide it from the `recvType.kind === "ref_null"`
        // guard further down.
        const NULL_OR_UNDEF = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
        const typeIsMaybeNull = (t: ts.Type): boolean =>
          (t.flags & NULL_OR_UNDEF) !== 0 ||
          (t.isUnion?.() === true && t.types.some((u) => (u.flags & NULL_OR_UNDEF) !== 0));
        // Peel `as`/`!`/parens so `(c as any)` / `c!` reveal the underlying
        // declared nullability — `as any` launders Null out of the static type,
        // so checking only the cast expression's own type would miss it (#2132).
        let receiverInner: ts.Expression = propAccess.expression;
        while (
          ts.isAsExpression(receiverInner) ||
          ts.isNonNullExpression(receiverInner) ||
          ts.isParenthesizedExpression(receiverInner) ||
          ts.isTypeAssertionExpression(receiverInner)
        ) {
          receiverInner = (
            receiverInner as ts.AsExpression | ts.NonNullExpression | ts.ParenthesizedExpression | ts.TypeAssertion
          ).expression;
        }
        const receiverMaybeNull =
          typeIsMaybeNull(ctx.checker.getTypeAtLocation(propAccess.expression)) ||
          typeIsMaybeNull(ctx.checker.getTypeAtLocation(receiverInner));
        // (#2132) When the receiver may be null, pass a NULLABLE param-0 hint (or
        // none) so compileExpression keeps the value nullable on the stack — a
        // non-null `ref` hint makes coerceType emit `ref.as_non_null`, which
        // would trap on null BEFORE the guard below can throw a catchable
        // TypeError. The `ref_null` guard further down re-asserts non-null only
        // on the non-null branch.
        const recvHint0: ValType | undefined =
          receiverMaybeNull && methodParamTypes0?.[0]?.kind === "ref"
            ? { kind: "ref_null", typeIdx: (methodParamTypes0[0] as { typeIdx: number }).typeIdx }
            : methodParamTypes0?.[0];
        let recvType = compileExpression(ctx, fctx, propAccess.expression, recvHint0);
        // Track whether receiver went through emitGuardedRefCast — if so, null
        // means "wrong struct type" (not genuinely null), so we should NOT throw
        // TypeError on null after cast.
        let receiverWasCast = false;
        // (#2132) If the receiver is statically nullable but compiled to a
        // non-null `ref` (e.g. via `as any`), force `ref_null` so the null-guard
        // below fires and throws a catchable TypeError instead of trapping.
        if (
          receiverMaybeNull &&
          recvType &&
          recvType.kind === "ref" &&
          (recvType as { typeIdx?: number }).typeIdx !== undefined
        ) {
          recvType = { kind: "ref_null", typeIdx: (recvType as { typeIdx: number }).typeIdx };
        }
        // If receiver is externref but the method expects a struct ref, coerce
        if (recvType && recvType.kind === "externref") {
          const structTypeIdx = ctx.structMap.get(receiverClassName);
          if (structTypeIdx !== undefined) {
            // Check for null BEFORE the guarded cast — only genuine null should throw TypeError
            emitNullCheckThrow(ctx, fctx, { kind: "externref" });
            fctx.body.push({ op: "any.convert_extern" } as Instr);
            emitGuardedRefCast(fctx, structTypeIdx);
            recvType = { kind: "ref_null", typeIdx: structTypeIdx };
            receiverWasCast = true;
          }
        }
        // Null-guard: if receiver is ref_null, check for null before calling method
        if (recvType && recvType.kind === "ref_null") {
          // Determine return type early so we can build null-guard
          const sig = ctx.checker.getResolvedSignature(expr);
          let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (!isEffectivelyVoidReturn(ctx, retType, fullName))
              callReturnType = getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType);
          }
          const tmp = allocLocal(fctx, `__ng_recv_${fctx.locals.length}`, recvType);
          fctx.body.push({ op: "local.tee", index: tmp });
          fctx.body.push({ op: "ref.is_null" });

          // Build the else branch (non-null path) with the full call
          const savedBody = pushBody(fctx);
          fctx.body.push({ op: "local.get", index: tmp });
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          // Coerce receiver (self param) if ref type doesn't match function's first param
          if (paramTypes?.[0]) {
            const recvRefType: ValType = { kind: "ref", typeIdx: (recvType as any).typeIdx };
            if (!valTypesMatch(recvRefType, paramTypes[0])) {
              coerceType(ctx, fctx, recvRefType, paramTypes[0]);
            }
          }
          // User-visible param count excludes self (param 0)
          const ngParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
          const calleeReadsArgsNg = ctx.funcUsesArguments.has(fullName);
          for (let i = 0; i < Math.min(expr.arguments.length, ngParamCount); i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
          }
          if (expr.arguments.length > ngParamCount) {
            if (calleeReadsArgsNg) {
              emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], ngParamCount);
            } else {
              for (let i = ngParamCount; i < expr.arguments.length; i++) {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
          }
          if (paramTypes) {
            for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          // Set __argc before the call so the callee knows the actual arg count
          maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, ngParamCount);
          const finalMethodIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)) ?? funcIdx; // (#1983)
          fctx.body.push({ op: "call", funcIdx: finalMethodIdx });
          const elseInstrs = fctx.body;
          fctx.body = savedBody;

          if (callReturnType === VOID_RESULT) {
            // Void method: if null after cast, skip (wrong type); if genuinely null, throw TypeError
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: receiverWasCast ? ([] as Instr[]) : typeErrorThrowInstrs(ctx),
              else: elseInstrs,
            });
            return VOID_RESULT;
          } else {
            const resultType: ValType =
              callReturnType.kind === "ref"
                ? { kind: "ref_null", typeIdx: (callReturnType as any).typeIdx }
                : callReturnType;
            // throw is divergent, so the then branch is valid without producing a value
            fctx.body.push({
              op: "if",
              blockType: { kind: "val" as const, type: resultType },
              then: receiverWasCast ? defaultValueInstrs(resultType) : typeErrorThrowInstrs(ctx),
              else: elseInstrs,
            });
            return resultType;
          }
        }
        // Non-nullable receiver: emit call directly.
        // User-visible param count excludes self (param 0). Clamp to ≥ 0 —
        // when funcMap indirectly points at a stale index (e.g. a zero-arg
        // constructor entry that wasn't shifted after a late import), the
        // raw `length - 1` would go negative and the `for` loop would read
        // `expr.arguments[-1]` → undefined → "unexpected undefined AST node".
        // Seen in tests that mix static + instance private methods under
        // the #1162 yield* async-generator cluster.
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const methodParamCount = paramTypes ? Math.max(0, paramTypes.length - 1) : expr.arguments.length;
        const calleeReadsArgsNn = ctx.funcUsesArguments.has(fullName);
        for (let i = 0; i < Math.min(expr.arguments.length, methodParamCount); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
        }
        if (expr.arguments.length > methodParamCount) {
          if (calleeReadsArgsNn) {
            emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], methodParamCount);
          } else {
            for (let i = methodParamCount; i < expr.arguments.length; i++) {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
        }
        // Pad missing arguments with defaults (skip self param at index 0)
        if (paramTypes) {
          for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        // Set __argc before the call so the callee knows the actual arg count
        maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, methodParamCount);
        // Re-lookup funcIdx: argument compilation may trigger addUnionImports
        const finalMethodIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)) ?? funcIdx; // (#1983)
        fctx.body.push({ op: "call", funcIdx: finalMethodIdx });

        // Determine return type
        const sig = ctx.checker.getResolvedSignature(expr);
        if (sig) {
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
          if (wasmFuncReturnsVoid(ctx, finalMethodIdx)) return VOID_RESULT;
          return getWasmFuncReturnType(ctx, finalMethodIdx) ?? resolveWasmType(ctx, retType);
        }
        return VOID_RESULT;
      }
    }

    // Check if receiver is a struct type (e.g. object literal with methods)
    {
      const structTypeName = resolveStructName(ctx, receiverType);
      if (structTypeName) {
        const methodName = propAccess.name.text;
        const fullName = `${structTypeName}_${methodName}`;
        const funcIdx = ctx.funcMap.get(fullName);
        // If no method found, check callable property on struct
        if (funcIdx === undefined) {
          const callablePropResult = compileCallablePropertyCall(ctx, fctx, expr, propAccess, structTypeName);
          if (callablePropResult !== undefined) return callablePropResult;
        }
        if (funcIdx !== undefined) {
          // Push self (the receiver) as first argument, with type hint from method's first param
          const structMethodPTypes = getFuncParamTypes(ctx, funcIdx);
          const recvType = compileExpression(ctx, fctx, propAccess.expression, structMethodPTypes?.[0]);
          // Check if receiver went through emitGuardedRefCast — null may mean
          // "wrong struct type" rather than genuinely null (#789)
          const smReceiverWasCast = (fctx as any).__lastGuardedCastBackup !== undefined;
          // Module globals produce ref_null but method params expect ref — null-guard
          if (recvType && recvType.kind === "ref_null") {
            const sig = ctx.checker.getResolvedSignature(expr);
            let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (!isEffectivelyVoidReturn(ctx, retType, fullName))
                callReturnType = getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType);
            }
            const tmp = allocLocal(fctx, `__ng_srecv_${fctx.locals.length}`, recvType);
            fctx.body.push({ op: "local.tee", index: tmp });
            fctx.body.push({ op: "ref.is_null" });

            const savedBody = pushBody(fctx);
            fctx.body.push({ op: "local.get", index: tmp });
            fctx.body.push({ op: "ref.as_non_null" } as Instr);
            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            // Coerce receiver (self param) if ref type doesn't match function's first param
            if (paramTypes?.[0]) {
              const recvRefType: ValType = { kind: "ref", typeIdx: (recvType as any).typeIdx };
              if (!valTypesMatch(recvRefType, paramTypes[0])) {
                coerceType(ctx, fctx, recvRefType, paramTypes[0]);
              }
            }
            const smMethodParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
            const calleeReadsArgsSm = ctx.funcUsesArguments.has(fullName);
            for (let i = 0; i < Math.min(expr.arguments.length, smMethodParamCount); i++) {
              compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
            }
            if (expr.arguments.length > smMethodParamCount) {
              if (calleeReadsArgsSm) {
                emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], smMethodParamCount);
              } else {
                for (let i = smMethodParamCount; i < expr.arguments.length; i++) {
                  const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                  if (extraType !== null) {
                    fctx.body.push({ op: "drop" });
                  }
                }
              }
            }
            if (paramTypes) {
              for (let i = Math.min(expr.arguments.length, smMethodParamCount) + 1; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!, ctx);
              }
            }
            // Set __argc before the call so the callee knows the actual arg count
            maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, smMethodParamCount);
            const finalStructMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalStructMethodIdx });
            const elseInstrs = fctx.body;
            fctx.body = savedBody;

            if (callReturnType === VOID_RESULT) {
              // Void method: if null after cast, skip (wrong type); if genuinely null, throw TypeError (#789)
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: smReceiverWasCast ? ([] as Instr[]) : typeErrorThrowInstrs(ctx),
                else: elseInstrs,
              });
              return VOID_RESULT;
            } else {
              const resultType: ValType =
                callReturnType.kind === "ref"
                  ? {
                      kind: "ref_null",
                      typeIdx: (callReturnType as any).typeIdx,
                    }
                  : callReturnType;
              // throw is divergent, valid without producing a value (#789)
              fctx.body.push({
                op: "if",
                blockType: { kind: "val" as const, type: resultType },
                then: smReceiverWasCast ? defaultValueInstrs(resultType) : typeErrorThrowInstrs(ctx),
                else: elseInstrs,
              });
              return resultType;
            }
          }
          // Non-nullable receiver
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const nnMethodParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
          const calleeReadsArgsNns = ctx.funcUsesArguments.has(fullName);
          for (let i = 0; i < Math.min(expr.arguments.length, nnMethodParamCount); i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
          }
          if (expr.arguments.length > nnMethodParamCount) {
            if (calleeReadsArgsNns) {
              emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], nnMethodParamCount);
            } else {
              for (let i = nnMethodParamCount; i < expr.arguments.length; i++) {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
          }
          // Pad missing arguments with defaults (skip self param at index 0)
          if (paramTypes) {
            for (let i = Math.min(expr.arguments.length, nnMethodParamCount) + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          // Set __argc before the call so the callee knows the actual arg count
          maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, nnMethodParamCount);
          // Re-lookup funcIdx: argument compilation may trigger addUnionImports
          const finalStructMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
          fctx.body.push({ op: "call", funcIdx: finalStructMethodIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalStructMethodIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalStructMethodIdx) ?? resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
      }
    }

    // Array method calls
    {
      const arrMethodResult = compileArrayMethodCall(
        ctx,
        fctx,
        propAccess,
        expr,
        receiverType,
        undefined,
        expectedType,
      );
      if (arrMethodResult !== undefined) return arrMethodResult;
    }

    // Primitive method calls: number.toString(), number.toFixed()
    if (isNumberType(receiverType) && propAccess.name.text === "toString") {
      // RangeError: if radix argument is provided, must be integer 2-36
      // Also captures the validated, floored radix in `radixLocalIdx` so it can
      // be passed to the 2-arg `number_toString_radix` host import below (#1321).
      let radixLocalIdx: number | undefined;
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        // Floor the radix (ToInteger semantics: NaN→0, 2.5→2, etc.)
        fctx.body.push({ op: "f64.floor" });
        radixLocalIdx = allocLocal(fctx, `__radix_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: radixLocalIdx });
        // Check radix < 2 (also catches NaN since NaN < 2 after floor(NaN)=NaN is still false)
        fctx.body.push({ op: "f64.const", value: 2 });
        fctx.body.push({ op: "f64.lt" });
        // Check radix > 36
        fctx.body.push({ op: "local.get", index: radixLocalIdx });
        fctx.body.push({ op: "f64.const", value: 36 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        // Check radix is NaN (NaN != NaN)
        fctx.body.push({ op: "local.get", index: radixLocalIdx });
        fctx.body.push({ op: "local.get", index: radixLocalIdx });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: toString() radix must be between 2 and 36";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
            else: [],
          });
        }
        // radix was consumed by the validation comparisons above (via local.tee);
        // the original (floored) value is preserved in radixLocalIdx for the call.
      }
      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      // number_toString expects f64 but source may be i32 (e.g. string.length)
      if (exprType && exprType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      // #1321: when a radix was provided, route to the 2-arg host import that
      // actually uses it. The legacy 1-arg `number_toString` only handled base 10
      // and silently dropped the radix — `(255).toString(16)` returned "255".
      // #1335: in standalone / WASI (nativeStrings) mode the native
      // number_toString[_radix] helpers return an externref that wraps a
      // `$NativeString`. Downstream string consumers (`.charAt`, `+`, return)
      // coerce externref→native via `any.convert_extern` + `ref.cast`; if we
      // report the value type as `externref` here, a consumer that ALSO
      // unwraps applies a SECOND `any.convert_extern` to the already-native
      // ref ("any.convert_extern expected externref, found native ref"). Unwrap
      // once at the call site and report the native string type so consumers
      // see a native receiver directly. JS-host mode keeps the externref.
      const unwrapToNative = ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0 && (ctx.standalone || ctx.wasi);
      if (radixLocalIdx !== undefined) {
        const radixFuncIdx = ctx.funcMap.get("number_toString_radix");
        if (radixFuncIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: radixLocalIdx });
          fctx.body.push({ op: "call", funcIdx: radixFuncIdx });
          if (unwrapToNative) {
            fctx.body.push({ op: "any.convert_extern" } as Instr);
            fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr);
            return nativeStringType(ctx);
          }
          return { kind: "externref" };
        }
      }
      const funcIdx = ctx.funcMap.get("number_toString");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        if (unwrapToNative) {
          fctx.body.push({ op: "any.convert_extern" } as Instr);
          fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr);
          return nativeStringType(ctx);
        }
        return { kind: "externref" };
      }
    }
    // (#1644 Slice D) BigInt.prototype.toString — bigint receivers cross the
    // boundary as i64. Mirror the number branch: validate radix range (2-36),
    // throw RangeError otherwise, then call bigint_toString_radix (or the
    // 1-arg bigint_toString for the default radix-10 case).
    if (isBigIntType(receiverType) && propAccess.name.text === "toString") {
      let radixLocalIdx: number | undefined;
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
        fctx.body.push({ op: "f64.floor" });
        radixLocalIdx = allocLocal(fctx, `__bi_radix_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: radixLocalIdx });
        fctx.body.push({ op: "f64.const", value: 2 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "local.get", index: radixLocalIdx });
        fctx.body.push({ op: "f64.const", value: 36 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        fctx.body.push({ op: "local.get", index: radixLocalIdx });
        fctx.body.push({ op: "local.get", index: radixLocalIdx });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: toString() radix must be between 2 and 36";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
            else: [],
          });
        }
      }
      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      if (exprType && exprType.kind === "i32") {
        fctx.body.push({ op: "i64.extend_i32_s" });
      }
      if (radixLocalIdx !== undefined) {
        const radixFuncIdx = ctx.funcMap.get("bigint_toString_radix");
        if (radixFuncIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: radixLocalIdx });
          fctx.body.push({ op: "i32.trunc_sat_f64_s" });
          fctx.body.push({ op: "call", funcIdx: radixFuncIdx });
          return { kind: "externref" };
        }
      }
      const funcIdx = ctx.funcMap.get("bigint_toString");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
    if (isNumberType(receiverType) && propAccess.name.text === "toFixed") {
      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      if (exprType && exprType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      // Compile the digits argument (default 0)
      if (expr.arguments.length > 0) {
        // ToInteger(fractionDigits) begins with ToNumber (§21.1.3.3 step 4).
        // A non-f64 argument (externref/ref, e.g. a Symbol) must funnel through
        // ToNumber, which throws TypeError on Symbol; coerce to f64 here so the
        // subsequent f64 local.tee is type-correct and Symbols throw (#1564).
        coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
        // RangeError: fractionDigits must be 0-100
        const digitsLocal = allocLocal(fctx, `__toFixed_digits_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: digitsLocal });
        // Check digits < 0
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        // Check digits > 100
        fctx.body.push({ op: "local.get", index: digitsLocal });
        fctx.body.push({ op: "f64.const", value: 100 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: toFixed() digits argument must be between 0 and 100";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
            else: [],
          });
        }
        fctx.body.push({ op: "local.get", index: digitsLocal });
      } else {
        fctx.body.push({ op: "f64.const", value: 0 });
      }
      const funcIdx = ctx.funcMap.get("number_toFixed");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
    // number.toPrecision(precision)
    if (isNumberType(receiverType) && propAccess.name.text === "toPrecision") {
      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      if (exprType && exprType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      if (expr.arguments.length > 0) {
        // (#49) Spec §21.1.3.5 step 4 says: if x is non-finite, return
        // Number::toString(x) BEFORE the precision range check. Save the
        // receiver into a local, check finiteness, and only run the
        // range check when x is finite. Non-finite v with bad precision
        // (e.g. `(NaN).toPrecision(Infinity)`) must return "NaN" not
        // throw RangeError.
        const recvLocalP = allocLocal(fctx, `__toPrecision_recv_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: recvLocalP });
        // ToNumber(precision) funnel — Symbol args must throw TypeError (#1564).
        coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
        const precLocal = allocLocal(fctx, `__toPrecision_prec_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: precLocal });

        // (#1735) §21.1.3.5 step 5: p = ToIntegerOrInfinity(precision), NaN → 0.
        // The `number_toPrecision` runtime helper uses NaN as its "no precision
        // supplied" sentinel, so an explicit NaN precision (`(1).toPrecision(NaN)`)
        // must be normalised to 0 here so it isn't mistaken for no-arg. (A 0
        // precision then trips the RangeError gate below — 0 is out of [1,100] —
        // which matches V8: explicit NaN precision throws RangeError.)
        normalizeNaNToZero(fctx, precLocal);

        // Re-push receiver for the runtime call.
        fctx.body.push({ op: "local.get", index: recvLocalP });

        // Range-check fires only when receiver is finite.
        // isFinite(v) ⇔ v - v == 0 ⇔ v != NaN AND |v| != Infinity. We
        // detect non-finite via `v + (-v) != 0`: NaN gives NaN (≠ 0),
        // ±Infinity gives NaN (≠ 0). Equivalent to `!Number.isFinite(v)`.
        // Use the simpler `v == v` (false for NaN) followed by
        // `abs(v) != Infinity` — but Wasm has no abs/Infinity literal in
        // f64 const. Use the spec-equivalent `!isNaN(v) && v != ±Inf`:
        //   isFinite(v)  ≡  (v - v) == 0
        // The `i32.eqz` of that is "is non-finite".
        const isFiniteLocal = allocLocal(fctx, `__toPrecision_finite_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.get", index: recvLocalP });
        fctx.body.push({ op: "local.get", index: recvLocalP });
        fctx.body.push({ op: "f64.sub" });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.eq" });
        fctx.body.push({ op: "local.set", index: isFiniteLocal });

        // RangeError gate: only when v is finite.
        fctx.body.push({ op: "local.get", index: isFiniteLocal });
        const rangeErrMsg = "RangeError: toPrecision() argument must be between 1 and 100";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const tagIdx = ensureExnTag(ctx);
        const rangeCheckBody: Instr[] = [];
        // Build: if (p < 1 || p > 100 || p != p) throw RangeError
        rangeCheckBody.push({ op: "local.get", index: precLocal });
        rangeCheckBody.push({ op: "f64.const", value: 1 });
        rangeCheckBody.push({ op: "f64.lt" });
        rangeCheckBody.push({ op: "local.get", index: precLocal });
        rangeCheckBody.push({ op: "f64.const", value: 100 });
        rangeCheckBody.push({ op: "f64.gt" });
        rangeCheckBody.push({ op: "i32.or" });
        rangeCheckBody.push({ op: "local.get", index: precLocal });
        rangeCheckBody.push({ op: "local.get", index: precLocal });
        rangeCheckBody.push({ op: "f64.ne" });
        rangeCheckBody.push({ op: "i32.or" });
        rangeCheckBody.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
          else: [],
        });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: rangeCheckBody,
          else: [],
        });

        fctx.body.push({ op: "local.get", index: precLocal });
      } else {
        // No argument → push NaN sentinel; the `number_toPrecision` host runtime
        // recognises NaN as "no precision provided" and returns String(v).
        fctx.body.push({ op: "f64.const", value: NaN });
      }
      const funcIdx = ctx.funcMap.get("number_toPrecision");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
    // number.toExponential(fractionDigits)
    if (isNumberType(receiverType) && propAccess.name.text === "toExponential") {
      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      if (exprType && exprType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      }
      if (expr.arguments.length > 0) {
        // (#49) Spec §21.1.3.3 step 3: if x is non-finite, return
        // Number::toString(x) BEFORE the fractionDigits range check.
        // Save receiver, run range check only when x is finite. The
        // runtime helper `number_toExponential` short-circuits for
        // non-finite x; pre-check would fire for
        // `(NaN).toExponential(101)` which spec requires to return "NaN".
        const recvLocalE = allocLocal(fctx, `__toExponential_recv_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: recvLocalE });
        // ToNumber(fractionDigits) funnel — Symbol args must throw TypeError (#1564).
        coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
        const digitsLocal = allocLocal(fctx, `__toExponential_digits_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: digitsLocal });

        // (#1735) §21.1.3.3 step 5: f = ToIntegerOrInfinity(fractionDigits),
        // which maps NaN → 0. The `number_toExponential` runtime helper reads
        // NaN as its "no argument supplied" sentinel (see else-branch below),
        // so an *explicit* NaN argument — e.g. `(1).toExponential(NaN)` or
        // `(1).toExponential(0/0)` — must be normalised to 0 here, otherwise it
        // collides with the sentinel and is wrongly treated as no-arg (variable
        // digits) instead of 0 digits. Spec: explicit NaN → 0 → "Ne+E"; genuine
        // no-arg → variable digits. test262
        // Number/prototype/toExponential/tointeger-fractiondigits.js.
        normalizeNaNToZero(fctx, digitsLocal);

        // Re-push receiver for the runtime call.
        fctx.body.push({ op: "local.get", index: recvLocalE });

        // isFinite(v): (v - v) == 0 (NaN/Infinity give NaN ≠ 0).
        const isFiniteLocal = allocLocal(fctx, `__toExponential_finite_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.get", index: recvLocalE });
        fctx.body.push({ op: "local.get", index: recvLocalE });
        fctx.body.push({ op: "f64.sub" });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.eq" });
        fctx.body.push({ op: "local.set", index: isFiniteLocal });

        // Range check gate: only when v is finite.
        const rangeErrMsg = "RangeError: toExponential() argument must be between 0 and 100";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const tagIdx = ensureExnTag(ctx);
        const rangeCheckBody: Instr[] = [];
        rangeCheckBody.push({ op: "local.get", index: digitsLocal });
        rangeCheckBody.push({ op: "f64.const", value: 0 });
        rangeCheckBody.push({ op: "f64.lt" });
        rangeCheckBody.push({ op: "local.get", index: digitsLocal });
        rangeCheckBody.push({ op: "f64.const", value: 100 });
        rangeCheckBody.push({ op: "f64.gt" });
        rangeCheckBody.push({ op: "i32.or" });
        rangeCheckBody.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
          else: [],
        });
        fctx.body.push({ op: "local.get", index: isFiniteLocal });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: rangeCheckBody,
          else: [],
        });

        fctx.body.push({ op: "local.get", index: digitsLocal });
      } else {
        // No argument → pass NaN as sentinel for "no argument provided"
        fctx.body.push({ op: "f64.const", value: NaN });
      }
      const funcIdx = ctx.funcMap.get("number_toExponential");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }

    // String method calls
    if (isStringType(receiverType)) {
      const method = propAccess.name.text;

      // string.toString() and string.valueOf() — identity, just return the string itself.
      // (#1397) Skip the identity short-circuit when the receiver is a String
      // wrapper object (`new String(...)`) AND the source has a reassignment
      // of the form `<id>.toString = ...` / `.valueOf = ...`. For wrappers
      // the .toString / .valueOf property is reassignable, and the identity
      // short-circuit silently ignores the override; the runtime spec
      // requires dispatch through the actual property. Primitive strings
      // can't have own properties, so the short-circuit stays correct.
      if (method === "toString" || method === "valueOf") {
        const skipForReassignment =
          isStringWrapperType(receiverType) && sourceHasMethodReassignment(ctx, propAccess.expression, method);
        if (!skipForReassignment) {
          return compileExpression(ctx, fctx, propAccess.expression);
        }
        // Fall through — let the generic externref method-call path at the
        // bottom of compileMethodCall handle dynamic dispatch.
      }

      // Fast mode: native string method dispatch
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        return compileNativeStringMethodCall(ctx, fctx, expr, propAccess, method);
      }

      // charCodeAt: uses wasm:js-string charCodeAt import (not string_charCodeAt)
      // Use jsStringImports to avoid shadowing by user-defined functions (#1072).
      if (method === "charCodeAt") {
        // #2003 — the wasm:js-string `charCodeAt` builtin TRAPS on an
        // out-of-range index, but §22.1.3.3 requires `NaN` for any index
        // `< 0` or `>= length`. Emit a bounds guard around the builtin and
        // return f64 so the NaN case is representable:
        //   idx = ToInteger(arg); len = s.length
        //   (idx >= 0 && idx < len) ? f64(charCodeAt(s, idx)) : NaN
        const charCodeAtIdx = ctx.jsStringImports.get("charCodeAt");
        const lengthIdx = ctx.jsStringImports.get("length");
        if (charCodeAtIdx !== undefined && lengthIdx !== undefined) {
          // Save receiver to a temp so we can read both its length and its char.
          compileExpression(ctx, fctx, propAccess.expression);
          const recvLocal = allocLocal(fctx, `__cca_recv_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.tee", index: recvLocal });
          // Compute the (truncated) index into an i32 temp.
          if (expr.arguments.length > 0) {
            const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
            if (!argType) {
              fctx.body.push({ op: "i32.const", value: 0 });
            } else if (argType.kind === "f64") {
              fctx.body.push({ op: "i32.trunc_sat_f64_s" });
            }
          } else {
            fctx.body.push({ op: "i32.const", value: 0 });
          }
          // (the receiver pushed by local.tee is still on the stack below idx;
          //  drop it — we re-load from the temp inside each branch.)
          const idxLocal = allocLocal(fctx, `__cca_idx_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "local.set", index: idxLocal });
          fctx.body.push({ op: "drop" }); // drop the receiver left by local.tee
          // Bounds test: (idx >= 0) & (idx < len)
          fctx.body.push({ op: "local.get", index: idxLocal });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "i32.ge_s" });
          fctx.body.push({ op: "local.get", index: idxLocal });
          fctx.body.push({ op: "local.get", index: recvLocal });
          fctx.body.push({ op: "call", funcIdx: lengthIdx });
          fctx.body.push({ op: "i32.lt_s" });
          fctx.body.push({ op: "i32.and" });
          // then: f64(charCodeAt(recv, idx)) ; else: NaN
          const thenInstrs: Instr[] = [
            { op: "local.get", index: recvLocal } as Instr,
            { op: "local.get", index: idxLocal } as Instr,
            { op: "call", funcIdx: charCodeAtIdx } as Instr,
            { op: "f64.convert_i32_u" } as Instr,
          ];
          const elseInstrs: Instr[] = [{ op: "f64.const", value: Number.NaN } as Instr];
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "f64" } },
            then: thenInstrs,
            else: elseInstrs,
          } as Instr);
          return { kind: "f64" };
        }
      }

      const importName = `string_${method}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        // #1445 — ECMA-262 §7.1.4 ToNumber throws TypeError on BigInt /
        // Symbol arguments. String.prototype methods feed certain args
        // through ToInteger / ToLength (which call ToNumber). For those
        // arg positions, emit a static TypeError throw when the arg's
        // static TS type is `bigint` or `symbol`.
        //
        // Map: method → set of arg indices that are ToInteger-coerced.
        const TO_INTEGER_ARG_INDICES: Record<string, ReadonlyArray<number>> = {
          charAt: [0],
          charCodeAt: [0],
          codePointAt: [0],
          at: [0],
          substring: [0, 1],
          slice: [0, 1],
          substr: [0, 1],
          indexOf: [1],
          lastIndexOf: [1],
          includes: [1],
          startsWith: [1],
          endsWith: [1],
          padStart: [0],
          padEnd: [0],
          repeat: [0],
        };
        const integerArgs = TO_INTEGER_ARG_INDICES[method];
        if (integerArgs) {
          for (const idx of integerArgs) {
            const arg = expr.arguments[idx];
            if (!arg) continue;
            let argTsType: ts.Type | undefined;
            try {
              argTsType = ctx.checker.getTypeAtLocation(arg);
            } catch {
              continue;
            }
            if (!argTsType) continue;
            const isBig = isBigIntType(argTsType);
            const isSym = isSymbolType(argTsType);
            if (!isBig && !isSym) continue;
            const msg = isBig
              ? "TypeError: Cannot convert a BigInt value to a number"
              : "TypeError: Cannot convert a Symbol value to a number";
            addStringConstantGlobal(ctx, msg);
            const strIdx = ctx.stringGlobalMap.get(msg)!;
            // #1473 — no JS host: throw a TypeError INSTANCE via the in-module
            // constructor (no `__throw_type_error` host import).
            if (noJsHost(ctx)) {
              emitThrowTypeError(ctx, fctx, msg);
              fctx.body.push({ op: "unreachable" } as Instr);
            } else {
              const throwIdx = ensureLateImport(ctx, "__throw_type_error", [{ kind: "externref" }], []);
              if (throwIdx !== undefined) {
                flushLateImportShifts(ctx, fctx);
                const throwFuncIdx = ctx.funcMap.get("__throw_type_error")!;
                fctx.body.push({ op: "global.get", index: strIdx } as Instr);
                fctx.body.push({ op: "call", funcIdx: throwFuncIdx } as Instr);
                fctx.body.push({ op: "unreachable" } as Instr);
              } else {
                const tagIdx = ensureExnTag(ctx);
                fctx.body.push({ op: "global.get", index: strIdx } as Instr);
                fctx.body.push({ op: "throw", tagIdx } as Instr);
              }
            }
            // After unreachable / throw, the wasm stack is polymorphic.
            // Push a sentinel matching the method's return type so any
            // downstream consumer (the implicit drop / coercion in the
            // statement context) still validates cleanly.
            const returnsBool = method === "includes" || method === "startsWith" || method === "endsWith";
            const returnsNum =
              method === "indexOf" || method === "lastIndexOf" || method === "codePointAt" || method === "search";
            if (returnsBool) {
              fctx.body.push({ op: "i32.const", value: 0 });
              return { kind: "i32" };
            }
            if (returnsNum) {
              fctx.body.push({ op: "f64.const", value: 0 });
              return { kind: "f64" };
            }
            fctx.body.push({ op: "ref.null.extern" });
            return { kind: "externref" };
          }
        }
        // #1248: substring/slice with a single argument default the missing
        // `end` to `s.length`, NOT 0. Without this, the generic padding loop
        // below pushes f64.const 0, and the host import calls
        // `s.substring(start, 0)` — which JS spec swaps to `substring(0, start)`,
        // returning the wrong prefix instead of the suffix from `start`.
        // Save the receiver into a temp local so we can re-compute its length
        // when padding the missing `end` arg.
        const args = expr.arguments;
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        // #1248 + no-arg: substring/slice with a missing `end` (0 OR 1 args)
        // default `end` to `s.length` per §22.1.3.24 (substring: end ?? len) /
        // §22.1.3.21 (slice: ToIntegerOrInfinity(end ?? len)). With only the
        // single-arg case handled, `s.substring()` / `s.slice()` padded BOTH
        // start and end to 0 → host called `s.substring(0, 0)` → "" instead of
        // the whole string. The pad loop's `pi === 2` branch supplies s.length
        // for the missing end; the missing start (pi === 1) correctly pads to 0.
        // (#2124) An explicit `undefined` end arg is spec-equivalent to absent:
        // substring/slice default `end` to `s.length`. Without this, the f64
        // slot coerces `undefined` → NaN and the host runs `substring(1, NaN)`
        // → wrong length. Detect a statically-undefined end so the same
        // length-default path that handles a missing end fires.
        const isStaticUndefinedExpr = (a: ts.Expression | undefined): boolean => {
          if (a === undefined) return false;
          let cur: ts.Expression = a;
          while (
            ts.isParenthesizedExpression(cur) ||
            ts.isAsExpression(cur) ||
            ts.isNonNullExpression(cur) ||
            ts.isTypeAssertionExpression(cur)
          ) {
            cur = (cur as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.TypeAssertion)
              .expression;
          }
          return (
            (ts.isIdentifier(cur) && cur.text === "undefined") ||
            (ts.isVoidExpression(cur) && ts.isNumericLiteral(cur.expression))
          );
        };
        const substringEndUndefined =
          (method === "substring" || method === "slice") && args.length === 2 && isStaticUndefinedExpr(args[1]);
        const needsLengthDefault =
          (method === "substring" || method === "slice") &&
          (args.length <= 1 || substringEndUndefined) &&
          paramTypes !== undefined &&
          paramTypes.length === 3;
        let savedReceiverLocal: number | undefined;
        if (needsLengthDefault) {
          // Ensure wasm:js-string.length is registered so we can compute s.length below.
          addStringImports(ctx);
          // Compile receiver, save to temp, leave on stack for the call.
          compileExpression(ctx, fctx, propAccess.expression);
          savedReceiverLocal = allocLocal(fctx, `__substr_recv_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.tee", index: savedReceiverLocal });
        } else {
          compileExpression(ctx, fctx, propAccess.expression);
        }
        // Cap at declared param count (excluding self) to avoid pushing extra values
        const userParamCount = paramTypes ? paramTypes.length - 1 : args.length;
        for (let ai = 0; ai < args.length; ai++) {
          if (substringEndUndefined && ai === 1 && savedReceiverLocal !== undefined) {
            // Explicit `undefined` end → s.length (#2124). Skip compiling the
            // undefined arg; emit the receiver's length for the f64 end slot.
            const lenIdx = ctx.jsStringImports.get("length");
            if (lenIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: savedReceiverLocal });
              fctx.body.push({ op: "call", funcIdx: lenIdx });
              fctx.body.push({ op: "f64.convert_i32_u" } as Instr);
            } else {
              fctx.body.push({ op: "f64.const", value: 0x7fffffff });
            }
            continue;
          }
          if (ai < userParamCount) {
            const expectedArgType = paramTypes?.[ai + 1]; // +1 for self param
            const argResult = compileExpression(ctx, fctx, args[ai]!, expectedArgType);
            if (!argResult) {
              // void/null result — push a default value for the expected type
              pushDefaultValue(fctx, expectedArgType ?? { kind: "f64" }, ctx);
            } else if (expectedArgType && argResult.kind !== expectedArgType.kind) {
              coerceType(ctx, fctx, argResult, expectedArgType);
            }
          } else {
            // Extra argument beyond function's parameter count — evaluate for
            // side effects and drop the result
            const extraType = compileExpression(ctx, fctx, args[ai]!);
            if (extraType !== null) {
              fctx.body.push({ op: "drop" });
            }
          }
        }
        // Pad missing optional args with defaults (e.g. indexOf 2nd arg)
        if (paramTypes && args.length + 1 < paramTypes.length) {
          // #1381 — `endsWith`/`startsWith`/`includes`/`lastIndexOf` distinguish
          // null vs undefined for the position arg (endsWith(s) ⇒ pos defaults
          // to length, but endsWith(s, null) ⇒ ToInteger(null)=0 ⇒ "" check).
          // Pad missing externref position args with JS undefined (via
          // `__get_undefined`) so the host sees the spec-correct "not passed"
          // value instead of `null`.
          // #1740 — padStart/padEnd: an OMITTED fillString must default to a
          // single space " " (§22.1.3.17 StringPad: if fillString is
          // undefined, set it to " "). Padding the missing externref arg with
          // `ref.null.extern` makes the host see JS `null`, which ToString-
          // coerces to "null" → e.g. `"abc".padStart(6)` returned "nulabc"
          // instead of "   abc". Pass JS `undefined` so the host applies the
          // spec default. (Same null-vs-undefined distinction as endsWith.)
          const padsUndefined =
            method === "endsWith" || method === "lastIndexOf" || method === "padStart" || method === "padEnd";
          let undefIdx: number | undefined;
          if (padsUndefined) {
            undefIdx = ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
            flushLateImportShifts(ctx, fctx);
          }
          for (let pi = args.length + 1; pi < paramTypes.length; pi++) {
            const pt = paramTypes[pi]!;
            if (needsLengthDefault && pi === 2 && savedReceiverLocal !== undefined && pt.kind === "f64") {
              // #1248: For substring/slice missing-end, push s.length instead of 0.
              const lenIdx = ctx.jsStringImports.get("length");
              if (lenIdx !== undefined) {
                fctx.body.push({ op: "local.get", index: savedReceiverLocal });
                fctx.body.push({ op: "call", funcIdx: lenIdx });
                fctx.body.push({ op: "f64.convert_i32_u" } as Instr);
              } else {
                // Fallback if length import is unavailable for some reason
                fctx.body.push({ op: "f64.const", value: 0x7fffffff });
              }
            } else if (pt.kind === "externref") {
              if (padsUndefined && undefIdx !== undefined) {
                fctx.body.push({ op: "call", funcIdx: undefIdx });
              } else {
                fctx.body.push({ op: "ref.null.extern" });
              }
            } else if (pt.kind === "f64") {
              // #1441 — `split` uses NaN as the "limit was not provided"
              // sentinel. ToUint32(NaN) === 0 would produce `[]` if the runtime
              // passed it through verbatim, so the `string_method` host shim
              // strips a trailing NaN limit before invoking the JS method.
              // #2002 — includes/startsWith/endsWith likewise use NaN for an
              // omitted position so the host shim drops it and the JS method
              // applies its spec default (0 for includes/startsWith, length
              // for endsWith) instead of ToInteger(NaN)=0.
              if (method === "split" || method === "includes" || method === "startsWith" || method === "endsWith") {
                fctx.body.push({ op: "f64.const", value: Number.NaN });
              } else {
                fctx.body.push({ op: "f64.const", value: 0 });
              }
            } else if (pt.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
          }
        }
        fctx.body.push({ op: "call", funcIdx });
        const returnsBool = method === "includes" || method === "startsWith" || method === "endsWith";
        const returnsNum =
          method === "indexOf" || method === "lastIndexOf" || method === "codePointAt" || method === "search";
        return returnsBool ? { kind: "i32" } : returnsNum ? { kind: "f64" } : { kind: "externref" };
      }
    }

    // Boolean method calls: bool.toString(), bool.valueOf()
    if (isBooleanType(receiverType)) {
      const method = propAccess.name.text;
      if (method === "toString") {
        compileExpression(ctx, fctx, propAccess.expression);
        return emitBoolToString(ctx, fctx);
      }
      if (method === "valueOf") {
        // Boolean.valueOf() returns the boolean primitive — just compile the expression
        return compileExpression(ctx, fctx, propAccess.expression);
      }
    }

    // number.valueOf() — return the number itself
    if (isNumberType(receiverType) && propAccess.name.text === "valueOf") {
      return compileExpression(ctx, fctx, propAccess.expression);
    }

    // Fallback .toLocaleString() — delegates to the JS host so that
    // Array/TypedArray/wrapped-object instances return the real
    // locale-formatted string and — critically for test262 — any abrupt
    // completion from the element's patched toLocaleString/valueOf
    // propagates as a real JS exception instead of being silently dropped.
    // Without this path, sample.toLocaleString() on a TypedArray hits the
    // graceful null-extern fallback and the test fails with "null/undefined
    // access" instead of reaching the expected throw.
    if (propAccess.name.text === "toLocaleString" && expr.arguments.length === 0) {
      const toLSIdx = ensureLateImport(
        ctx,
        "__extern_toLocaleString",
        [{ kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (toLSIdx !== undefined) {
        const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
        if (recvType === null) {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (recvType.kind !== "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        }
        fctx.body.push({ op: "call", funcIdx: toLSIdx });
        return { kind: "externref" };
      }
    }

    // Fallback .toString() for any type not already handled above
    // Handles: function.toString(), object.toString(), array.toString(), class instance.toString()
    if (propAccess.name.text === "toString" && expr.arguments.length === 0) {
      // #1463 — `someFn.toString()` where `someFn` is a top-level function
      // declaration → return the captured source text directly. Must happen
      // BEFORE the externref-routes-to-JS fallback below: top-level functions
      // resolve to externref at the type system level, so the default path
      // would call `__extern_toString` on a Wasm closure (which JS doesn't
      // know how to stringify) and the spec text would be lost.
      if (ts.isIdentifier(propAccess.expression)) {
        const captured = ctx.funcSourceText.get(propAccess.expression.text);
        if (captured) {
          addStringConstantGlobal(ctx, captured);
          const idx = ctx.stringGlobalMap.get(captured)!;
          fctx.body.push({ op: "global.get", index: idx });
          return { kind: "externref" };
        }
      }
      const tsType = ctx.checker.getTypeAtLocation(propAccess.expression);
      const wasm = resolveWasmType(ctx, tsType);

      // For externref values (e.g. RegExp.exec result, host objects), delegate to JS toString
      if (wasm.kind === "externref") {
        const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (toStrIdx !== undefined) {
          compileExpression(ctx, fctx, propAccess.expression);
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
          return { kind: "externref" };
        }
      }

      const exprType = compileExpression(ctx, fctx, propAccess.expression);
      if (exprType) {
        // If the compiled expression produced an externref, try JS toString
        if (exprType.kind === "externref") {
          const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          if (toStrIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: toStrIdx });
            return { kind: "externref" };
          }
        }
        fctx.body.push({ op: "drop" });
      }
      // Check if it's an array type (ref to vec struct)
      let isArray = false;
      if (wasm.kind === "ref" || wasm.kind === "ref_null") {
        const arrInfo = resolveArrayInfo(ctx, tsType);
        if (arrInfo) isArray = true;
      }
      // Check if this is a function type (has call signatures, is not a class/interface)
      const callSigs = tsType.getCallSignatures?.();
      const isFunc = callSigs && callSigs.length > 0 && !tsType.getProperties?.()?.length;

      if (isFunc) {
        // #1463 — return captured source text when the receiver is an
        // identifier resolving to a known top-level function declaration.
        // Falls back to the legacy placeholder for arrow functions, method
        // references, or any receiver we can't resolve statically.
        let toStrStr = "function () { [native code] }";
        if (ts.isIdentifier(propAccess.expression)) {
          const captured = ctx.funcSourceText.get(propAccess.expression.text);
          if (captured) toStrStr = captured;
        }
        addStringConstantGlobal(ctx, toStrStr);
        const idx = ctx.stringGlobalMap.get(toStrStr)!;
        fctx.body.push({ op: "global.get", index: idx });
      } else {
        const str = isArray ? "[object Array]" : "[object Object]";
        addStringConstantGlobal(ctx, str);
        const idx = ctx.stringGlobalMap.get(str)!;
        fctx.body.push({ op: "global.get", index: idx });
      }
      return { kind: "externref" };
    }

    // Fallback .valueOf() for any type not already handled above
    // valueOf() on non-primitive types typically returns the object itself
    if (propAccess.name.text === "valueOf" && expr.arguments.length === 0) {
      return compileExpression(ctx, fctx, propAccess.expression);
    }

    // Fallback for method calls on any-typed / externref / unresolvable receivers.
    // This handles patterns like: ref(args).next(), anyObj.someMethod(), etc.
    // Common in test262 where variables are typed as `any` or inferred as `any`.
    {
      const recvTsType = ctx.checker.getTypeAtLocation(propAccess.expression);
      const recvWasm = resolveWasmType(ctx, recvTsType);
      const isAnyOrExternref = (recvTsType.flags & ts.TypeFlags.Any) !== 0 || recvWasm.kind === "externref";

      if (isAnyOrExternref) {
        const methodName = propAccess.name.text;
        const nativeResult = tryCompileNativeGeneratorMethodCall(
          ctx,
          fctx,
          propAccess.expression,
          methodName,
          expr.arguments,
        );
        if (nativeResult !== undefined) return nativeResult;

        // Generator protocol: .next(), .return(value), .throw(error) on any/externref
        // These are very common in test262 generator tests where variables are typed as `any`.
        if (methodName === "next") {
          const genNextIdx = ctx.funcMap.get("__gen_next");
          if (genNextIdx !== undefined) {
            compileExpression(ctx, fctx, propAccess.expression, {
              kind: "externref",
            });
            // Drop any arguments (generator .next() with args not yet supported)
            for (const arg of expr.arguments) {
              const argType = compileExpression(ctx, fctx, arg);
              if (argType) {
                fctx.body.push({ op: "drop" });
              }
            }
            fctx.body.push({ op: "call", funcIdx: genNextIdx });
            return { kind: "externref" };
          }
        }
        if (methodName === "return") {
          const genReturnIdx = ctx.funcMap.get("__gen_return");
          if (genReturnIdx !== undefined) {
            compileExpression(ctx, fctx, propAccess.expression, {
              kind: "externref",
            });
            if (expr.arguments.length > 0) {
              compileExpression(ctx, fctx, expr.arguments[0]!, {
                kind: "externref",
              });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            fctx.body.push({ op: "call", funcIdx: genReturnIdx });
            return { kind: "externref" };
          }
        }
        if (methodName === "throw") {
          const genThrowIdx = ctx.funcMap.get("__gen_throw");
          if (genThrowIdx !== undefined) {
            compileExpression(ctx, fctx, propAccess.expression, {
              kind: "externref",
            });
            if (expr.arguments.length > 0) {
              compileExpression(ctx, fctx, expr.arguments[0]!, {
                kind: "externref",
              });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            fctx.body.push({ op: "call", funcIdx: genThrowIdx });
            return { kind: "externref" };
          }
        }

        // Try to resolve via registered extern classes (e.g. Set.union, Map.get)
        // when the receiver type is `any` but the method matches a built-in.
        {
          const builtinNamespace = ctx.standalone
            ? resolveBuiltinNamespaceValueName(ctx, propAccess.expression)
            : undefined;
          const preferOpenBuiltinNamespace =
            builtinNamespace !== undefined && isSupportedBuiltinStaticProperty(builtinNamespace, methodName);
          if (!preferOpenBuiltinNamespace) {
            const externResult = tryExternClassMethodOnAny(ctx, fctx, expr, propAccess, methodName);
            if (externResult !== null) return externResult;
          }
        }

        // (#2151) Standalone/WASI closed-struct method dispatch. An object
        // literal `{ m(){…} }` is a CLOSED nominal WasmGC struct; the generic
        // __extern_method_call below only handles the OPEN $Object receiver
        // (ref.test $Object), so `o.m()` on a closed struct returns null/0 and
        // never invokes the method (standalone analog of the JS-host #2015 bug).
        // Route 0-arg any-receiver calls through a reserved per-name dispatcher
        // `__call_m_<name>` that type-switches over every closed struct having
        // `<Struct>_<name>` (threading the struct as `this`) and falls through to
        // __extern_method_call for the open-$Object case. Reserve-then-fill
        // (#1719): the body is built at finalize once all structs are known.
        // Slice 1: zero-arg only (covers next()/getx()/iterator protocol); calls
        // with arguments keep the existing generic path below.
        const recvIsBuiltinClass =
          ts.isIdentifier(propAccess.expression) && BUILTIN_CLASS_NAMES.has(propAccess.expression.text);
        // (#2151 Slice 2) N-ary: the dispatcher is arity-specialized
        // `__call_m_<name>_<arity>(recv, arg0..arg{arity-1})` (all externref).
        // (#2151 Slice 3) Spread of an ARRAY LITERAL (`o.m(...[2,3])`) flattens
        // to a fixed argument list at compile time, so it can use the same
        // arity-specialized dispatcher. A spread of a DYNAMIC source
        // (`o.m(...xs)`) has no statically-known arity → flattenCallArgs returns
        // null and it falls through to the generic path.
        const hasSpreadArg = expr.arguments.some((a) => ts.isSpreadElement(a));
        const dispatchArgs: ts.Expression[] | null = hasSpreadArg
          ? flattenCallArgs(expr.arguments)
          : [...expr.arguments];
        if ((ctx.standalone || ctx.wasi) && dispatchArgs !== null && !recvIsBuiltinClass) {
          const arity = dispatchArgs.length;
          const dispatchIdx = reserveClosedMethodDispatch(ctx, methodName, arity);
          flushLateImportShifts(ctx, fctx);
          // Receiver as externref.
          const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
          if (recvType && recvType.kind !== "externref") {
            fctx.body.push({ op: "extern.convert_any" });
          } else if (recvType === null) {
            fctx.body.push({ op: "ref.null.extern" });
          }
          // Each argument compiled and boxed to externref (the dispatcher unboxes
          // to the method's declared param type per candidate struct).
          for (const arg of dispatchArgs) {
            const at = compileExpression(ctx, fctx, arg, { kind: "externref" });
            if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
            else if (at === null) fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "call", funcIdx: dispatchIdx });
          return { kind: "externref" };
        }

        // (#799 WI3) Generic host-delegated method call for any/externref receivers.
        // Builds a JS array of arguments and calls __extern_method_call(obj, methodName, args).
        // (#965) For known built-in class identifiers (Object, Array, Proxy, etc.) that would
        // otherwise compile to ref.null.extern, use __get_builtin to get the real JS object.
        {
          // (#1888 Slice 2) Under --target standalone the native
          // __extern_method_call reads its args via __extern_length /
          // __extern_get_idx over a $ObjVec (no JS array exists). Build the args
          // list with the native $ObjVec builders instead of the host
          // __js_array_new / __js_array_push. JS-host / WASI keep the host
          // imports unchanged (byte-for-byte). Per the #1472 S3 note, the
          // __js_array_* builders are NOT globally safe to alias (real JS arrays
          // elsewhere depend on them) — so this is a per-call-site swap.
          let arrNewIdx: number | undefined;
          let arrPushIdx: number | undefined;
          if (ctx.standalone) {
            const b = ensureObjVecBuilders(ctx);
            arrNewIdx = b.newIdx;
            arrPushIdx = b.pushIdx;
          } else {
            arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
            arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
          }
          const methodCallIdx = ensureLateImport(
            ctx,
            "__extern_method_call",
            [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
            [{ kind: "externref" }],
          );
          // For built-in class identifiers, import __get_builtin to resolve real JS object
          const receiverIsBuiltin =
            ts.isIdentifier(propAccess.expression) && BUILTIN_CLASS_NAMES.has(propAccess.expression.text);
          const getBuiltinIdx = receiverIsBuiltin
            ? ensureLateImport(ctx, "__get_builtin", [{ kind: "externref" }], [{ kind: "externref" }])
            : undefined;
          flushLateImportShifts(ctx, fctx);

          if (methodCallIdx !== undefined && arrNewIdx !== undefined && arrPushIdx !== undefined) {
            // Compile receiver as externref.
            // For known built-in class identifiers, use __get_builtin to get the real JS object
            // instead of the null produced by compileIdentifier's graceful fallback.
            let recvType: ValType | null;
            if (receiverIsBuiltin && getBuiltinIdx !== undefined) {
              const builtinName = (propAccess.expression as ts.Identifier).text;
              addStringConstantGlobal(ctx, builtinName);
              fctx.body.push(...stringConstantExternrefInstrs(ctx, builtinName));
              fctx.body.push({ op: "call", funcIdx: getBuiltinIdx });
              recvType = { kind: "externref" };
            } else {
              recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
              if (recvType && recvType.kind !== "externref") {
                fctx.body.push({ op: "extern.convert_any" });
              }
            }
            const recvLocal = allocLocal(fctx, `__emc_recv_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.set", index: recvLocal });

            // Build args array
            fctx.body.push({ op: "call", funcIdx: arrNewIdx });
            const argsLocal = allocLocal(fctx, `__emc_args_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.set", index: argsLocal });

            for (const arg of expr.arguments) {
              fctx.body.push({ op: "local.get", index: argsLocal });
              const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
              if (argType && argType.kind !== "externref") {
                fctx.body.push({ op: "extern.convert_any" });
              }
              if (argType === null) {
                fctx.body.push({ op: "ref.null.extern" });
              }
              fctx.body.push({ op: "call", funcIdx: arrPushIdx });
            }

            // Push receiver, method name, args array → call __extern_method_call
            fctx.body.push({ op: "local.get", index: recvLocal });
            addStringConstantGlobal(ctx, methodName);
            fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
            fctx.body.push({ op: "local.get", index: argsLocal });
            fctx.body.push({ op: "call", funcIdx: methodCallIdx });
            return { kind: "externref" };
          }

          // Fallback if imports unavailable: evaluate for side effects, return null
          const recvType = compileExpression(ctx, fctx, propAccess.expression);
          if (recvType) {
            fctx.body.push({ op: "drop" });
          }
          for (const arg of expr.arguments) {
            const argType = compileExpression(ctx, fctx, arg);
            if (argType) {
              fctx.body.push({ op: "drop" });
            }
          }
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
    }
  }

  // #1491 — non-WASI fs.readFileSync / writeFileSync as JS-host imports.
  // Gated behind `--allow-fs` (CompileOptions.allowFs) to prevent accidental
  // capability leakage. The corresponding host imports are bound at runtime via
  // the `node_builtin_fn` ImportIntent. Initial scope: 2-arg shapes only —
  // readFileSync(path, "utf-8") returns string, writeFileSync(path, data)
  // returns void. Buffer-shaped reads are deferred to a follow-up.
  if (
    !ctx.wasi &&
    ts.isIdentifier(expr.expression) &&
    ctx.wasiNodeFsFuncs.has(expr.expression.text) &&
    (expr.expression.text === "readFileSync" || expr.expression.text === "writeFileSync")
  ) {
    const fnName = expr.expression.text;
    if (!ctx.allowFs) {
      const { line, character } = expr.getSourceFile().getLineAndCharacterOfPosition(expr.getStart());
      ctx.errors.push({
        message:
          `'node:fs' call to '${fnName}' requires the --allow-fs flag (or { allowFs: true } ` +
          `in CompileOptions) for non-WASI targets (#1491). Refusing to emit the host import ` +
          `to prevent accidental capability leakage.`,
        line: line + 1,
        column: character + 1,
        severity: "error",
      });
      // Drop args, emit a safe placeholder so codegen can continue.
      for (const arg of expr.arguments) {
        const t = compileExpression(ctx, fctx, arg);
        if (t) fctx.body.push({ op: "drop" });
      }
      if (fnName === "writeFileSync") return VOID_RESULT;
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Lazily register the host import. Both fns are (externref, externref) -> externref|void.
    // Use ensureLateImport so late additions correctly shift existing function
    // indices (export tables, call instructions, etc.) — calling raw addImport
    // here would otherwise misalign the exported function indices.
    const importName = `__node_fs_${fnName}`;
    const params: ValType[] = [{ kind: "externref" }, { kind: "externref" }];
    const results: ValType[] = fnName === "writeFileSync" ? [] : [{ kind: "externref" }];
    const funcIdx = ensureLateImport(ctx, importName, params, results);
    if (funcIdx === undefined) {
      // Should be unreachable — emit a defensive placeholder.
      for (const arg of expr.arguments) {
        const t = compileExpression(ctx, fctx, arg);
        if (t) fctx.body.push({ op: "drop" });
      }
      if (fnName === "writeFileSync") return VOID_RESULT;
      fctx.body.push({ op: "ref.null.extern" } as Instr);
      return { kind: "externref" };
    }
    flushLateImportShifts(ctx, fctx);

    // Compile 2 args as externref (pad missing with ref.null.extern so the call
    // typechecks even when the user under-supplied args).
    const argCount = Math.min(2, expr.arguments.length);
    for (let i = 0; i < argCount; i++) {
      compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
    }
    for (let i = argCount; i < 2; i++) {
      fctx.body.push({ op: "ref.null.extern" } as Instr);
    }
    // Drop extra args (e.g. callback overload) without emitting them — Initial
    // scope is sync 2-arg shapes only.
    for (let i = 2; i < expr.arguments.length; i++) {
      const t = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (t) fctx.body.push({ op: "drop" });
    }

    fctx.body.push({ op: "call", funcIdx });
    if (fnName === "writeFileSync") return VOID_RESULT;
    return { kind: "externref" };
  }

  // WASI mode: writeFileSync(path, data) → __wasi_write_file_sync(pathPtr, pathLen, dataPtr, dataLen)
  if (
    ctx.wasi &&
    ts.isIdentifier(expr.expression) &&
    ctx.wasiNodeFsFuncs.has(expr.expression.text) &&
    expr.expression.text === "writeFileSync" &&
    expr.arguments.length >= 2
  ) {
    const writeFileSyncIdx = ctx.funcMap.get("__wasi_write_file_sync");
    if (writeFileSyncIdx !== undefined) {
      const pathArg = expr.arguments[0]!;
      const dataArg = expr.arguments[1]!;

      // Handle path argument — must be a string literal for now (embedded in data segment)
      if (ts.isStringLiteral(pathArg)) {
        const pathData = wasiAllocStringData(ctx, pathArg.text);
        fctx.body.push({ op: "i32.const", value: pathData.offset } as Instr);
        fctx.body.push({ op: "i32.const", value: pathData.length } as Instr);
      } else {
        // Dynamic path: compile expression and use runtime string-to-linear-memory copy
        // For now, use bump allocator to store the string data
        compileWasiStringArgToLinearMemory(ctx, fctx, pathArg);
      }

      // Handle data argument — string literal or expression
      if (ts.isStringLiteral(dataArg) || ts.isNoSubstitutionTemplateLiteral(dataArg)) {
        const dataData = wasiAllocStringData(ctx, dataArg.text);
        fctx.body.push({ op: "i32.const", value: dataData.offset } as Instr);
        fctx.body.push({ op: "i32.const", value: dataData.length } as Instr);
      } else {
        // Dynamic data: compile and convert to linear memory
        compileWasiStringArgToLinearMemory(ctx, fctx, dataArg);
      }

      fctx.body.push({ op: "call", funcIdx: writeFileSyncIdx });
      return VOID_RESULT;
    }
  }

  // Handle global isNaN(n) / isFinite(n) / parseInt / parseFloat — inline wasm
  if (ts.isIdentifier(expr.expression)) {
    // Resolve aliases like `var freeParseInt = parseInt; freeParseInt(...)` (#1109)
    let funcName = expr.expression.text;
    const _knownGlobalFuncs = new Set(["parseInt", "parseFloat", "isNaN", "isFinite"]);
    if (!_knownGlobalFuncs.has(funcName)) {
      const sym = ctx.checker.getSymbolAtLocation(expr.expression);
      const decl = sym?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isIdentifier(decl.initializer)) {
        const initName = decl.initializer.text;
        if (_knownGlobalFuncs.has(initName)) {
          funcName = initName;
        }
      }
    }

    if (funcName === "isNaN" && expr.arguments.length >= 1) {
      // isNaN(n) → n !== n
      compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      const tmp = allocLocal(fctx, `__isnan_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: tmp });
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "f64.ne" } as Instr);
      return { kind: "i32" };
    }

    if (funcName === "isFinite" && expr.arguments.length >= 1) {
      // isFinite(n) → n - n === 0.0  (Infinity - Infinity = NaN, NaN - NaN = NaN, finite - finite = 0)
      compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      const tmp = allocLocal(fctx, `__isfin_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: tmp });
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "f64.sub" } as Instr);
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.eq" } as Instr);
      return { kind: "i32" };
    }

    // parseInt(s, radix?) and parseFloat(s) — host imports
    if ((funcName === "parseInt" || funcName === "parseFloat") && expr.arguments.length >= 1) {
      const importFuncIdx = ctx.funcMap.get(funcName);
      if (importFuncIdx !== undefined) {
        const arg0 = expr.arguments[0]!;
        const arg0Type = compileExpression(ctx, fctx, arg0);
        // Coerce to externref, preserving boolean identity (not boxing as number)
        if (arg0Type && arg0Type.kind !== "externref") {
          if (
            arg0Type.kind === "i32" &&
            (arg0.kind === ts.SyntaxKind.TrueKeyword || arg0.kind === ts.SyntaxKind.FalseKeyword)
          ) {
            // Boolean literal: box as boolean so String(true) → "true"
            addUnionImports(ctx);
            const boxIdx = ctx.funcMap.get("__box_boolean");
            if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
          } else {
            coerceType(ctx, fctx, arg0Type, { kind: "externref" });
          }
        }
        if (funcName === "parseInt") {
          if (expr.arguments.length >= 2) {
            compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
          } else {
            // No radix supplied — push NaN sentinel so runtime treats it as undefined
            fctx.body.push({ op: "f64.const", value: NaN });
          }
        }
        fctx.body.push({ op: "call", funcIdx: importFuncIdx });
        return { kind: "f64" };
      }
    }

    // decodeURI, decodeURIComponent, encodeURI, encodeURIComponent — host imports
    if (
      (funcName === "decodeURI" ||
        funcName === "decodeURIComponent" ||
        funcName === "encodeURI" ||
        funcName === "encodeURIComponent") &&
      expr.arguments.length >= 1
    ) {
      const importFuncIdx = ctx.funcMap.get(funcName);
      if (importFuncIdx !== undefined) {
        const arg0Type = compileExpression(ctx, fctx, expr.arguments[0]!);
        if (arg0Type && arg0Type.kind !== "externref") {
          coerceType(ctx, fctx, arg0Type, { kind: "externref" });
        }
        fctx.body.push({ op: "call", funcIdx: importFuncIdx });
        return { kind: "externref" };
      }
    }

    // Number(x) — ToNumber coercion
    if (funcName === "Number" && expr.arguments.length >= 1) {
      // ToNumber(Symbol) must throw TypeError (§7.1.4). Symbols are lowered to
      // i32 ids, so a numeric pass-through would silently leak the id; detect
      // the symbol TS type and throw instead.
      if (isSymbolType(ctx.checker.getTypeAtLocation(expr.arguments[0]!))) {
        const t = compileExpression(ctx, fctx, expr.arguments[0]!);
        if (t !== null) fctx.body.push({ op: "drop" });
        emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a number");
        return { kind: "f64" };
      }
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType?.kind === "i64") {
        // BigInt → number: f64.convert_i64_s
        fctx.body.push({ op: "f64.convert_i64_s" });
        return { kind: "f64" };
      }
      if (argType?.kind === "externref") {
        if (ctx.standalone) {
          coerceType(ctx, fctx, argType, { kind: "f64" }, "number");
          return { kind: "f64" };
        }
        // Number(x) uses ToNumber semantics — __unbox_number calls Number(v) in JS.
        // parseFloat is wrong here: Number(null)=0 but parseFloat(null)=NaN,
        // Number("")=0 but parseFloat("")=NaN, Number("0x1F")=31 but parseFloat gives 0.
        addUnionImports(ctx);
        const unboxIdx = ctx.funcMap.get("__unbox_number");
        if (unboxIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: unboxIdx });
          return { kind: "f64" };
        }
      }
      if (argType?.kind === "ref" || argType?.kind === "ref_null") {
        // Native-string ref (WasmGC AnyString/NativeString) → §7.1.4.1
        // StringToNumber. The generic struct ToPrimitive path below has no
        // string case and silently yields 0 in standalone (#1688), so detect
        // the string struct type and route to the pure-Wasm __str_to_number.
        const refTypeIdx = (argType as { typeIdx?: number }).typeIdx;
        if (
          ctx.nativeStrings &&
          refTypeIdx !== undefined &&
          (refTypeIdx === ctx.anyStrTypeIdx || refTypeIdx === ctx.nativeStrTypeIdx)
        ) {
          // Emitted upfront during the parseNeeded finalize (declarations.ts)
          // when `Number` is referenced under native strings, so no mid-body
          // function registration (which would shift func indices) happens here.
          const s2nIdx = ctx.funcMap.get("__str_to_number");
          if (s2nIdx !== undefined) {
            // __str_to_number takes an externref; convert the ref first.
            fctx.body.push({ op: "extern.convert_any" });
            fctx.body.push({ op: "call", funcIdx: s2nIdx });
            return { kind: "f64" };
          }
        }
        // Object → number: coerce via @@toPrimitive("number") or valueOf
        coerceType(ctx, fctx, argType, { kind: "f64" }, "number");
        return { kind: "f64" };
      }
      // Already numeric — no-op
      return argType;
    }

    // BigInt(x) — §21.2.1.1 constructor. (#1644 Slice A+B) The result is
    // brand-bigint so it boxes as a JS bigint at the externref frontier.
    //
    // - i32 / native-i64: already an integer Number representation, no
    //   RangeError possible — extend/identity directly (avoids a host call).
    // - f64: may be a non-safe-integer / NaN / ±Infinity → must throw
    //   RangeError (NumberToBigInt). Box to externref, then __bigint_ctor.
    // - string / object / boolean (externref): StringToBigInt (SyntaxError on
    //   malformed syntax), ToPrimitive on objects, boolean → 0n/1n →
    //   __bigint_ctor.
    if (funcName === "BigInt" && expr.arguments.length >= 1) {
      // Compile-time numeric literal: fold to an i64.const when it is a safe
      // integer (NumberToBigInt with no RangeError), avoiding a host call.
      // A negative literal parses as a unary-minus on a NumericLiteral.
      const litArg = expr.arguments[0]!;
      let litNum: number | undefined;
      if (ts.isNumericLiteral(litArg)) {
        litNum = Number(litArg.text);
      } else if (
        ts.isPrefixUnaryExpression(litArg) &&
        litArg.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(litArg.operand)
      ) {
        litNum = -Number(litArg.operand.text);
      }
      if (litNum !== undefined && Number.isSafeInteger(litNum)) {
        fctx.body.push({ op: "i64.const", value: BigInt(litNum) } as Instr);
        return { kind: "i64", bigint: true };
      }
      if (ts.isStringLiteral(litArg) || ts.isNoSubstitutionTemplateLiteral(litArg)) {
        try {
          const litBig = BigInt(litArg.text);
          const minI64 = -(1n << 63n);
          const maxI64 = (1n << 63n) - 1n;
          if (litBig >= minI64 && litBig <= maxI64) {
            fctx.body.push({ op: "i64.const", value: litBig } as Instr);
            return { kind: "i64", bigint: true };
          }
        } catch {
          // Keep malformed strings on the runtime path so JS-host mode throws
          // the native SyntaxError and no-JS-host mode uses its native throw.
        }
      }

      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      if (argType?.kind === "i32") {
        fctx.body.push({ op: "i64.extend_i32_s" });
        return { kind: "i64", bigint: true };
      }
      // Already i64 — tag as bigint-branded (native integer, no RangeError).
      if (argType?.kind === "i64") {
        return { kind: "i64", bigint: true };
      }
      addUnionImports(ctx);
      // Coerce the argument to externref so the §21.2.1.1 host helper can run
      // ToPrimitive + NumberToBigInt / StringToBigInt with the correct
      // RangeError / SyntaxError / TypeError semantics.
      if (argType && argType.kind !== "externref") {
        coerceType(ctx, fctx, argType, { kind: "externref" }, "default");
      }
      const ctorIdx = ctx.funcMap.get("__bigint_ctor");
      if (ctorIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: ctorIdx });
        return { kind: "i64", bigint: true };
      }
      return { kind: "i64", bigint: true };
    }

    // Number() with 0 args → 0
    if (funcName === "Number" && expr.arguments.length === 0) {
      fctx.body.push({
        op: ctx.fast ? "i32.const" : "f64.const",
        value: 0,
      } as Instr);
      return ctx.fast ? { kind: "i32" } : { kind: "f64" };
    }

    // Symbol() / Symbol('description') — create unique i32 symbol ID
    if (funcName === "Symbol") {
      return compileSymbolCall(ctx, fctx, expr.arguments);
    }

    // String(x) — ToString coercion
    if (funcName === "String") {
      // #1470: route every literal-string emission through compileStringLiteral
      // so native-strings / standalone (`--target standalone` / WASI) materializes
      // a NativeString GC struct inline. The old `addStringConstantGlobal` +
      // `global.get` path reaches a JS-host string-constant global that is never
      // registered in native-strings mode, so its index resolves to the -1
      // sentinel and the module fails validation ("Invalid global index:
      // 4294967295"). In JS-host mode compileStringLiteral keeps the existing
      // global.get behaviour, so this is a no-op there.
      if (expr.arguments.length === 0) {
        // String() with no args → ""
        return compileStringLiteral(ctx, fctx, "", expr) ?? { kind: "externref" };
      }

      // Check if argument is a null/undefined literal before compiling
      const strArg0 = expr.arguments[0]!;
      const strArg0IsNull = strArg0.kind === ts.SyntaxKind.NullKeyword;
      const strArg0IsUndefined =
        strArg0.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isIdentifier(strArg0) && strArg0.text === "undefined") ||
        ts.isVoidExpression(strArg0);

      if (strArg0IsNull) {
        // String(null) → "null"
        return compileStringLiteral(ctx, fctx, "null", strArg0) ?? { kind: "externref" };
      }

      if (strArg0IsUndefined) {
        // String(undefined) → "undefined"
        return compileStringLiteral(ctx, fctx, "undefined", strArg0) ?? { kind: "externref" };
      }

      const argType = compileExpression(ctx, fctx, strArg0);

      if (argType === null) {
        // String(void-expr) → "undefined"
        return compileStringLiteral(ctx, fctx, "undefined", strArg0) ?? { kind: "externref" };
      }

      if (argType?.kind === "i32") {
        // Check if it's a boolean type → "true"/"false"
        const argTsType = ctx.checker.getTypeAtLocation(strArg0);
        if (isBooleanType(argTsType)) {
          return emitBoolToString(ctx, fctx);
        }
        // number (i32) → string via f64 conversion
        const toStrIdx = ctx.funcMap.get("number_toString");
        if (toStrIdx !== undefined) {
          fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
          return { kind: "externref" };
        }
      }

      if (argType?.kind === "f64") {
        // number → string
        const toStrIdx = ctx.funcMap.get("number_toString");
        if (toStrIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
          return { kind: "externref" };
        }
      }

      if (argType?.kind === "externref") {
        // Check TS type to determine what this externref actually is
        const argTsType = ctx.checker.getTypeAtLocation(strArg0);
        if (argTsType.flags & ts.TypeFlags.Null) {
          // Drop the ref.null.extern, push "null" constant (#1470: native-aware)
          fctx.body.push({ op: "drop" });
          return compileStringLiteral(ctx, fctx, "null", strArg0) ?? { kind: "externref" };
        }
        if (argTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
          fctx.body.push({ op: "drop" });
          return compileStringLiteral(ctx, fctx, "undefined", strArg0) ?? { kind: "externref" };
        }
        if (isStringType(argTsType)) {
          // Already a string — return as-is
          return { kind: "externref" };
        }
        // Other externref — coerce via __extern_toString, which routes
        // through the runtime's `_toPrimitive` walker (valueOf/toString
        // per §7.1.1.1 with hint "string"). Pre-#1525 this looked up
        // "extern_toString" — missing the leading underscores that the
        // runtime actually exposes — so the call was silently dropped
        // and `String(obj)` returned the unchanged externref. The
        // explicit hint also keeps the dispatch table in
        // `__extern_method_call` honest for wasmGC structs that V8
        // can't introspect natively.
        const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (toStrIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
        }
        return { kind: "externref" };
      }

      if (argType?.kind === "ref" || argType?.kind === "ref_null") {
        // Check if it's a native string type
        const argTsType = ctx.checker.getTypeAtLocation(strArg0);
        if (isStringType(argTsType)) {
          // Already a native string — return as-is
          return argType;
        }
        // Object ref → coerce via @@toPrimitive("string") or toString(), else "[object Object]"
        coerceType(ctx, fctx, argType, { kind: "externref" }, "string");
        return { kind: "externref" };
      }

      return argType ?? { kind: "externref" };
    }

    // Boolean(x) — ToBoolean coercion → returns i32 (0 or 1)
    if (funcName === "Boolean") {
      if (expr.arguments.length === 0) {
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
      // void / undefined → always false
      if (argType === null) {
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
      if (argType?.kind === "f64") {
        // f64: truthy if != 0 and != NaN
        const tmp = allocLocal(fctx, `__bool_${fctx.locals.length}`, {
          kind: "f64",
        });
        fctx.body.push({ op: "local.tee", index: tmp });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.ne" } as Instr);
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "f64.eq" } as Instr); // NaN check: x == x
        fctx.body.push({ op: "i32.and" } as Instr);
        return { kind: "i32" };
      }
      if (argType?.kind === "i32") {
        // i32: truthy if != 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.ne" } as Instr);
        return { kind: "i32" };
      }
      if (argType?.kind === "i64") {
        // BigInt (§7.1.2 ToBoolean): 0n → false, any other BigInt → true.
        // i64.eqz yields 1 for 0n; invert with i32.eqz so nonzero → 1.
        // Must NOT route through f64.convert_i64_s — that loses precision
        // for |x| > 2^53 and would misreport large BigInts.
        fctx.body.push({ op: "i64.eqz" } as Instr);
        fctx.body.push({ op: "i32.eqz" } as Instr);
        return { kind: "i32" };
      }
      // String: truthy if length > 0
      if (
        (argType?.kind === "ref" || argType?.kind === "ref_null") &&
        ctx.nativeStrings &&
        ctx.anyStrTypeIdx >= 0 &&
        isStringType(ctx.checker.getTypeAtLocation(expr.arguments[0]!))
      ) {
        // Get length (field 0 of $AnyString) and check != 0
        fctx.body.push({
          op: "struct.get",
          typeIdx: ctx.anyStrTypeIdx,
          fieldIdx: 0,
        });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.ne" } as Instr);
        return { kind: "i32" };
      }
      if (argType?.kind === "externref") {
        // Check if this is a primitive string type — use string length > 0 for truthiness.
        // (#1343) Restrict to PRIMITIVE strings only; `new String("")` is a wrapper
        // object (always truthy, even when empty per spec) and would be incorrectly
        // reported as falsy by a length check. Same caveat for any other JS wrapper.
        const argTsType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
        const isPrimString =
          (argTsType.flags & ts.TypeFlags.String) !== 0 || (argTsType.flags & ts.TypeFlags.StringLiteral) !== 0;
        if (isPrimString) {
          addStringImports(ctx);
          const lenIdx = ctx.jsStringImports.get("length");
          if (lenIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: lenIdx });
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "i32.ne" } as Instr);
            return { kind: "i32" };
          }
        }
        // (#1343) Use the host `__to_boolean` helper for full ECMA-262
        // §7.1.2 semantics. Previously we only checked `ref.is_null`,
        // which returned 1 for JS `undefined` (defined externref, not
        // a null reference) and broke `Boolean(undefined) === false` plus
        // every other ToBoolean edge case (NaN, +/-0, "", 0n, wrapper
        // objects which must always be truthy).
        const toBoolIdx = ensureLateImport(ctx, "__to_boolean", [{ kind: "externref" }], [{ kind: "i32" }]);
        flushLateImportShifts(ctx, fctx);
        if (toBoolIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toBoolIdx });
          return { kind: "i32" };
        }
        // Fallback: the legacy null-only check (preserves prior behaviour
        // when the host import couldn't be registered).
        fctx.body.push({ op: "ref.is_null" } as Instr);
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "i32.xor" } as Instr);
        return { kind: "i32" };
      }
      // Ref types (objects, arrays): always truthy — drop the ref, push 1
      if (argType?.kind === "ref" || argType?.kind === "ref_null") {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }
      // fallback: treat as truthy (non-null ref)
      return { kind: "i32" };
    }

    // Array(n) — create array of length n, or Array(a,b,c) → [a,b,c]
    // Treat Array() the same as new Array() — they have identical semantics in JS.
    if (funcName === "Array") {
      return compileArrayConstructorCall(ctx, fctx, expr);
    }
  }

  // Regular function call
  if (ts.isIdentifier(expr.expression)) {
    const funcName = expr.expression.text;

    // (#1301) Param/local that shadows an outer function with nested captures:
    // the funcMap path emits a direct call AND prepends the outer's nested
    // captures using `cap.outerLocalIdx` indices. Inside a lifted closure
    // body those indices map to unrelated locals in the lifted fctx, which
    // produces struct.new validation errors:
    //   "struct.new[0] expected type f64, found local.get of type anyref".
    //
    // Narrow trigger: only redirect when ALL of:
    //   1. The current fctx has a local/param with this name (real shadow)
    //   2. The funcMap entry has nestedFuncCaptures (the broken path)
    //   3. The local has a callable TS type (actually used as a callable)
    //
    // Other shadow cases stay on the funcMap path — direct calls that don't
    // emit cap-prepend logic are already correct, even if a coincidental
    // local with the same name exists in the current scope.
    let isLocallyShadowed = false;
    if (fctx.localMap.has(funcName) && ctx.nestedFuncCaptures.has(funcName)) {
      const localCalleeTsType = ctx.checker.getTypeAtLocation(expr.expression);
      const localCallSigs = localCalleeTsType?.getCallSignatures?.();
      if (localCallSigs && localCallSigs.length > 0) {
        isLocallyShadowed = true;
      }
    }

    // Check if this is a closure call
    let closureInfo = isLocallyShadowed ? undefined : ctx.closureMap.get(funcName);

    if (!closureInfo) {
      closureInfo = resolveClosureInfoFromLocal(ctx, fctx, funcName);
    }
    if (closureInfo) {
      return compileClosureCall(ctx, fctx, expr, funcName, closureInfo);
    }

    // #1177: funcIdx must be re-fetched from funcMap whenever a late-import
    // shift may have run. Late imports added during argument/cap compilation
    // (e.g. emitLocalTdzCheck → ensureLateImport(__throw_reference_error))
    // shift `ctx.numImportFuncs` and update `ctx.funcMap` entries, but a
    // local `const funcIdx` would hold the pre-shift value.
    // (#1301) Skip funcMap when locally shadowed; the local-callable fallback
    // below handles dispatch via call_ref through the param/local.
    let funcIdx = isLocallyShadowed ? undefined : ctx.funcMap.get(funcName);
    if (funcIdx === undefined) {
      // Before giving up, check if this identifier is a local/param with callable TS type
      // (e.g. function parameter `fn: (x: number) => number` stored as externref).
      // If so, create or find a matching closure wrapper type and dispatch via call_ref.
      // Only attempt this for actual locals/params — not for unknown imported functions.
      const calleeLocalIdx = fctx.localMap.get(funcName);
      const calleeModGlobal = calleeLocalIdx === undefined ? ctx.moduleGlobals.get(funcName) : undefined;
      const calleeCapturedGlobal =
        calleeLocalIdx === undefined && calleeModGlobal === undefined ? ctx.capturedGlobals.get(funcName) : undefined;
      const isKnownVariable =
        calleeLocalIdx !== undefined || calleeModGlobal !== undefined || calleeCapturedGlobal !== undefined;
      const calleeTsType = ctx.checker.getTypeAtLocation(expr.expression);
      let callSigs = isKnownVariable ? calleeTsType.getCallSignatures?.() : undefined;
      if (isKnownVariable && (!callSigs || callSigs.length === 0)) {
        // (#1298) `Fn | null | undefined` callees: strip nullable members
        // before reading call signatures. Storage is externref either way.
        const nonNull = ctx.checker.getNonNullableType(calleeTsType);
        callSigs = nonNull.getCallSignatures?.();
      }
      // (#1337) If the callee is a variable holding a `Function.prototype.bind`
      // result, its runtime value is a host bound-function externref, NOT a
      // wasm closure struct — the struct-cast + call_ref path below would null
      // it and trap. Route the call through the `__call_function` host helper
      // (Reflect.apply on the bound function, which already carries
      // [[BoundThis]]/[[BoundArguments]]). JS-host mode only; standalone
      // degrades bind to identity so the normal path applies.
      if (isKnownVariable && !ctx.standalone && !noJsHost(ctx) && calleeIsBoundFunctionVar(ctx, expr.expression)) {
        const hostCall = emitBoundFunctionCall(ctx, fctx, expr);
        if (hostCall !== null) return hostCall;
      }
      if (callSigs && callSigs.length > 0) {
        const sig = callSigs[0]!;
        const sigParamCount = sig.parameters.length;
        const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
        const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
        const sigParamWasmTypes: ValType[] = [];
        for (let i = 0; i < sigParamCount; i++) {
          // (#820d) Destructuring-pattern parameters (e.g. `method({ x = 5 } = {})`)
          // are compiled by the callee as a single `externref` slot — the binding
          // pattern is destructured inside the body from that externref, and the
          // param-default check uses `__extern_is_undefined`. Resolving the TS
          // type of such a param to a concrete struct ref (which `resolveWasmType`
          // does once the anonymous object type gets a registered struct) produces
          // a funcref wrapper type that mismatches the actual method/trampoline
          // signature. The closure call then casts the trampoline funcref to the
          // wrong (struct-param) type and traps with `illegal cast` — and for an
          // unresolvable default the spec-correct ReferenceError never gets a
          // chance to throw. Force `externref` for binding-pattern params so the
          // call site agrees with the compiled callee.
          const paramDecl = sig.parameters[i]!.valueDeclaration;
          if (
            paramDecl &&
            ts.isParameter(paramDecl) &&
            (ts.isObjectBindingPattern(paramDecl.name) || ts.isArrayBindingPattern(paramDecl.name))
          ) {
            sigParamWasmTypes.push({ kind: "externref" });
            continue;
          }
          const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
          sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
        }

        // Eagerly create the closure wrapper types for this signature so the
        // lookup succeeds even when no actual closure with this signature has
        // been compiled yet (compilation order issue).
        // All callers must wrap their closures into this wrapper type before
        // passing them (see coercion in compileExpression and compileAssignment).
        const resultTypes = sigRetWasm ? [sigRetWasm] : [];
        const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, sigParamWasmTypes, resultTypes);

        if (wrapperTypes) {
          const matchedClosureInfo = wrapperTypes.closureInfo;
          const matchedStructTypeIdx = wrapperTypes.structTypeIdx;
          // (#2174) When the callee's signature returns `Promise<T>`,
          // `resolveWasmType` strips the Promise wrapper and yields the awaited
          // value's wasm type (e.g. f64 for `() => Promise<number>`). But an
          // *internal* call to an async closure leaves the **Promise object**
          // (externref) on the stack — the async closure's real funcref type
          // returns externref, which is registered as a separate dispatch
          // candidate below (`tryAltFuncType([externref])`). If the dispatch
          // block were typed `(result f64)`, the async candidate's `call_ref`
          // (externref) would mismatch the block result → invalid Wasm
          // (`__closure_N fallthru expected f64/i32, got externref`). Worse, a
          // type-only externref→f64 coercion would unbox the Promise to NaN and
          // corrupt the value. So when the callee is async, widen the dispatch
          // result to externref: the Promise flows through intact and the
          // surrounding `wrapAsyncReturn` (expressions.ts) consumes it as the
          // call expression's value. Surfaced by the test262 cluster
          // `async-function/returns-async-function-returns-arguments-*`.
          const calleeIsAsync = isPromiseType(sigRetType);
          const expectedReturn: ValType | null = calleeIsAsync ? { kind: "externref" } : matchedClosureInfo.returnType; // null for void

          // (#1131) Preemptively create alternative closure wrapper types.
          // TypeScript allows covariant return types in callbacks, e.g.
          // () => string is assignable to () => void. The actual closure may
          // use a different funcref type than the declared signature expects.
          // V8's isorecursive canonicalization merges struct types with the same
          // layout, so struct-level casts succeed. But funcref types remain
          // distinct per return type — we must dispatch on funcref type.
          // Create common return-type variants now so closures compiled later
          // reuse the same funcref types and the dispatch chain finds them.
          type FuncCandidate = { funcTypeIdx: number; structTypeIdx: number; returnType: ValType | null };
          const funcCandidates: FuncCandidate[] = [
            {
              funcTypeIdx: matchedClosureInfo.funcTypeIdx,
              structTypeIdx: matchedClosureInfo.structTypeIdx,
              returnType: matchedClosureInfo.returnType,
            },
          ];
          const seenFuncTypeIdx = new Set<number>([matchedClosureInfo.funcTypeIdx]);

          const tryAltFuncType = (retTypes: ValType[]) => {
            const alt = getOrCreateFuncRefWrapperTypes(ctx, sigParamWasmTypes, retTypes);
            if (alt && !seenFuncTypeIdx.has(alt.closureInfo.funcTypeIdx)) {
              seenFuncTypeIdx.add(alt.closureInfo.funcTypeIdx);
              funcCandidates.push({
                funcTypeIdx: alt.closureInfo.funcTypeIdx,
                structTypeIdx: alt.closureInfo.structTypeIdx,
                returnType: alt.closureInfo.returnType,
              });
            }
          };
          // Create externref-return variant if not already expected
          if (!expectedReturn || expectedReturn.kind !== "externref") {
            tryAltFuncType([{ kind: "externref" }]);
          }
          // Create void-return variant if not already expected
          if (expectedReturn !== null) {
            tryAltFuncType([]);
          }
          // Also scan closureInfoByTypeIdx for other matching-arity func types
          for (const [, info] of ctx.closureInfoByTypeIdx) {
            if (info.paramTypes.length !== sigParamCount) continue;
            if (seenFuncTypeIdx.has(info.funcTypeIdx)) continue;
            let paramsMatch = true;
            for (let pi = 0; pi < sigParamCount; pi++) {
              if (!valTypesMatch(info.paramTypes[pi]!, sigParamWasmTypes[pi]!)) {
                paramsMatch = false;
                break;
              }
            }
            if (paramsMatch) {
              seenFuncTypeIdx.add(info.funcTypeIdx);
              funcCandidates.push({
                funcTypeIdx: info.funcTypeIdx,
                structTypeIdx: info.structTypeIdx,
                returnType: info.returnType,
              });
            }
          }

          // Compile the callee to get the value on the stack
          const innerResultType = compileExpression(ctx, fctx, expr.expression);

          // Save closure ref to a local
          let closureLocal: number;
          let rawCalleeLocal: number | undefined;
          if (innerResultType?.kind === "externref") {
            const closureRefType: ValType = {
              kind: "ref_null",
              typeIdx: matchedStructTypeIdx,
            };
            closureLocal = allocLocal(fctx, `__callable_param_${fctx.locals.length}`, closureRefType);
            // (#1712) Keep the raw externref callee around for the host-callable
            // fallback below. When the guarded struct cast nulls out (the callee
            // is a host builtin like `Object.hasOwn`, a bound function, or a
            // closure of a foreign struct shape), the call must dispatch through
            // `__call_function` instead of trapping on `struct.get` of null.
            rawCalleeLocal = allocLocal(fctx, `__callable_raw_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.tee", index: rawCalleeLocal });
            fctx.body.push({ op: "any.convert_extern" });
            emitGuardedRefCast(fctx, matchedStructTypeIdx);
            fctx.body.push({ op: "local.set", index: closureLocal });
          } else {
            const closureRefType: ValType = innerResultType ?? {
              kind: "ref",
              typeIdx: matchedStructTypeIdx,
            };
            closureLocal = allocLocal(fctx, `__callable_param_${fctx.locals.length}`, closureRefType);
            fctx.body.push({ op: "local.set", index: closureLocal });
          }

          // Compile call arguments with type coercion (only up to declared param count)
          // Save them to locals so they can be re-pushed in each dispatch branch.
          const argLocals: number[] = [];
          const cpParamCnt = matchedClosureInfo.paramTypes.length;
          // (#1511) Save overflow args to externref locals so we can pack them
          // into __extras_argv right before the call (whichever dispatch arm
          // wins). The lifted callee may read `arguments` and needs the full
          // call-site arg list.
          const cpExtrasLocals: number[] = [];
          // biome-ignore lint/complexity/noUselessLoneBlockStatements: groups arg-emit + extras-pack as one logical unit
          {
            for (let i = 0; i < Math.min(expr.arguments.length, cpParamCnt); i++) {
              compileExpression(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
              const argLocal = allocLocal(fctx, `__carg_${fctx.locals.length}`, matchedClosureInfo.paramTypes[i]!);
              fctx.body.push({ op: "local.set", index: argLocal });
              argLocals.push(argLocal);
            }
            for (let i = cpParamCnt; i < expr.arguments.length; i++) {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
              if (extraType === null) {
                fctx.body.push({ op: "ref.null.extern" });
              } else if (extraType.kind === "f64") {
                const boxIdx = ctx.funcMap.get("__box_number");
                if (boxIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else {
                  fctx.body.push({ op: "drop" });
                  fctx.body.push({ op: "ref.null.extern" });
                }
              } else if (extraType.kind === "i32") {
                fctx.body.push({ op: "f64.convert_i32_s" });
                const boxIdx = ctx.funcMap.get("__box_number");
                if (boxIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else {
                  fctx.body.push({ op: "drop" });
                  fctx.body.push({ op: "ref.null.extern" });
                }
              } else if (extraType.kind === "ref" || extraType.kind === "ref_null") {
                fctx.body.push({ op: "extern.convert_any" } as Instr);
              }
              const extraLocal = allocLocal(fctx, `__cextra_${fctx.locals.length}`, { kind: "externref" });
              fctx.body.push({ op: "local.set", index: extraLocal });
              cpExtrasLocals.push(extraLocal);
            }
          }

          // Pad missing arguments with defaults and save to locals.
          // For non-nullable ref params, widen the padding slot to nullable so
          // pushDefaultValue emits a plain ref.null (without ref.as_non_null,
          // which would trap at runtime). The callee wrapper signature accepts
          // nullable refs, so this is assignment-compatible. (#1131)
          for (let i = expr.arguments.length; i < matchedClosureInfo.paramTypes.length; i++) {
            const paramType = matchedClosureInfo.paramTypes[i]!;
            const padType: ValType =
              paramType.kind === "ref" ? { kind: "ref_null", typeIdx: paramType.typeIdx } : paramType;
            pushDefaultValue(fctx, padType, ctx);
            const argLocal = allocLocal(fctx, `__carg_${fctx.locals.length}`, padType);
            fctx.body.push({ op: "local.set", index: argLocal });
            argLocals.push(argLocal);
          }

          // (#1712) Host-callable fallback: when the callee arrived as externref
          // and the guarded cast to the wrapper struct failed (closureLocal is
          // null) while the raw value is non-null, the callee is callable but
          // not a closure of the matched shape — a host builtin held in a JS
          // variable (acorn's `var hasOwn = Object.hasOwn || function(…){…}`),
          // a bound function, or a closure with a foreign struct layout. The
          // struct.get below would trap "dereferencing a null pointer". Route
          // that case through `__call_function(callee, undefined, argsArray)`
          // instead. JS-host mode only — standalone/WASI keeps the existing
          // (trapping) path since __call_function has no host there.
          // Eligibility excludes i64/v128-typed params/returns (no boxing rule).
          const boxableKind = (t: ValType | null): boolean =>
            t === null ||
            t.kind === "externref" ||
            t.kind === "f64" ||
            t.kind === "i32" ||
            t.kind === "ref" ||
            t.kind === "ref_null";
          const hostCallFallback =
            rawCalleeLocal !== undefined &&
            !ctx.standalone &&
            !ctx.wasi &&
            boxableKind(expectedReturn) &&
            matchedClosureInfo.paramTypes.every((t) => boxableKind(t)) &&
            // (#1941) Only emit the host-call arm for callees that can actually
            // be a foreign (non-wasm-closure) callable — a JS variable holding a
            // host builtin (`Object.hasOwn || fn`). Pure local closures /
            // function params are always wrapped into the closure struct, so the
            // arm would be dead code and only serve to pull host imports
            // (__js_array_new/…) into otherwise self-contained modules.
            // (#2028) ALSO emit it for a Promise-executor `resolve`/`reject`
            // parameter — those arrive as host JS functions and must dispatch
            // through __call_function, not the closure-struct call_ref path
            // (which traps on the null cast). Narrowly gated to Promise-executor
            // params so the #1941 dual-mode guarantee for ordinary callable
            // params is preserved.
            (calleeMayBeHostCallable(ctx, expr.expression) || calleeIsPromiseExecutorParam(ctx, expr.expression));

          let fallbackInstrs: Instr[] | null = null;
          let dispatchOuterBody: Instr[] | null = null;
          if (hostCallFallback) {
            // Ensure all fallback imports BEFORE detaching buffers so the index
            // shifts land while every buffer is reachable by the shifters.
            const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
            const arrPushIdx = ensureLateImport(
              ctx,
              "__js_array_push",
              [{ kind: "externref" }, { kind: "externref" }],
              [],
            );
            const callFnIdx = ensureLateImport(
              ctx,
              "__call_function",
              [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
              [{ kind: "externref" }],
            );
            flushLateImportShifts(ctx, fctx);
            const arrNew = ctx.funcMap.get("__js_array_new") ?? arrNewIdx;
            const arrPush = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
            const callFn = ctx.funcMap.get("__call_function") ?? callFnIdx;
            if (arrNew !== undefined && arrPush !== undefined && callFn !== undefined) {
              // Build the fallback arm in a detached buffer parked in savedBodies
              // (late-import/global shifters walk savedBodies — #1712 blocker 1).
              const mainBuf = fctx.body;
              fctx.savedBodies.push(mainBuf);
              fctx.body = [];
              fctx.body.push({ op: "call", funcIdx: arrNew });
              const argsArrLocal = allocLocal(fctx, `__callable_hargs_${fctx.locals.length}`, { kind: "externref" });
              fctx.body.push({ op: "local.set", index: argsArrLocal });
              for (let ai = 0; ai < argLocals.length; ai++) {
                // Only pass the call-site arg count — padded defaults must stay
                // invisible to the host callee (fn.length / arguments.length).
                if (ai >= expr.arguments.length) break;
                fctx.body.push({ op: "local.get", index: argsArrLocal });
                fctx.body.push({ op: "local.get", index: argLocals[ai]! });
                const at = matchedClosureInfo.paramTypes[ai]!;
                if (at.kind !== "externref") {
                  coerceType(ctx, fctx, at, { kind: "externref" });
                }
                fctx.body.push({ op: "call", funcIdx: arrPush });
              }
              for (const exLocal of cpExtrasLocals) {
                fctx.body.push({ op: "local.get", index: argsArrLocal });
                fctx.body.push({ op: "local.get", index: exLocal });
                fctx.body.push({ op: "call", funcIdx: arrPush });
              }
              fctx.body.push({ op: "local.get", index: rawCalleeLocal! });
              fctx.body.push({ op: "ref.null.extern" });
              fctx.body.push({ op: "local.get", index: argsArrLocal });
              fctx.body.push({ op: "call", funcIdx: callFn });
              if (expectedReturn === null) {
                fctx.body.push({ op: "drop" });
              } else if (expectedReturn.kind !== "externref") {
                coerceType(ctx, fctx, { kind: "externref" }, expectedReturn);
              }
              fallbackInstrs = fctx.body;
              // Redirect the existing dispatch emission below into a second
              // detached buffer; both stay parked until the if-assembly.
              fctx.savedBodies.push(fallbackInstrs);
              fctx.body = [];
              dispatchOuterBody = mainBuf;
            }
          }

          // Extract funcref from the closure struct (field 0) — null-check → TypeError (#728)
          fctx.body.push({ op: "local.get", index: closureLocal });
          emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });
          fctx.body.push({
            op: "struct.get",
            typeIdx: matchedStructTypeIdx,
            fieldIdx: 0,
          });

          if (funcCandidates.length <= 1) {
            // Single func type — push self+args back onto stack then call
            // Stack before: [funcref]
            // Need: [self, ...args, funcref] for call_ref
            // Re-push self and args under the funcref by saving funcref first
            const funcrefLocal = allocLocal(fctx, `__frd_${fctx.locals.length}`, { kind: "funcref" } as ValType);
            fctx.body.push({ op: "local.set", index: funcrefLocal });
            // Push self (null-check)
            fctx.body.push({ op: "local.get", index: closureLocal });
            emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });
            // Push args
            for (const al of argLocals) {
              fctx.body.push({ op: "local.get", index: al });
            }
            // (#1511) Set __extras_argv from saved overflow locals + __argc
            for (const ins of buildArgcExtrasSetupFromLocals(ctx, fctx, cpParamCnt, cpExtrasLocals)) {
              fctx.body.push(ins);
            }
            // Push funcref back, guarded cast, call
            fctx.body.push({ op: "local.get", index: funcrefLocal });
            emitGuardedFuncRefCast(fctx, matchedClosureInfo.funcTypeIdx);
            emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });
            fctx.body.push({
              op: "call_ref",
              typeIdx: matchedClosureInfo.funcTypeIdx,
            });
            // (#1511) Reset globals (callee may not have consumed them).
            // Return value already on stack — save, reset, restore.
            if (expectedReturn !== null) {
              const _retL = allocLocal(fctx, `__cp_ret_${fctx.locals.length}`, expectedReturn);
              fctx.body.push({ op: "local.set", index: _retL });
              for (const ins of buildArgcExtrasReset(ctx)) fctx.body.push(ins);
              fctx.body.push({ op: "local.get", index: _retL });
            } else {
              for (const ins of buildArgcExtrasReset(ctx)) fctx.body.push(ins);
            }
          } else {
            // (#1131) Multi-funcref-type dispatch: the closure may have a different
            // return type than declared (e.g. () => string passed as () => void).
            // Save funcref, then dispatch on funcref type. Each branch re-pushes
            // self + args + typed funcref for call_ref.
            const funcrefLocal = allocLocal(fctx, `__frd_${fctx.locals.length}`, { kind: "funcref" } as ValType);
            fctx.body.push({ op: "local.set", index: funcrefLocal });

            const retBlockType =
              expectedReturn === null ? ({ kind: "empty" } as const) : ({ kind: "val", type: expectedReturn } as const);

            // Build dispatch chain bottom-up (innermost = throw TypeError)
            let funcDispatch: Instr[] = typeErrorThrowInstrs(ctx);

            for (const fc of [...funcCandidates].reverse()) {
              // Each candidate needs: push self, push args, push typed funcref, call_ref
              // The self struct type must match the funcref's expected first param.
              // All wrapper struct types have the same layout so closureLocal works,
              // but call_ref expects (ref $specificStruct). We use ref.cast to cast
              // closureLocal to the funcref's expected struct type.
              const fcCallBody: Instr[] = [];
              // Push self (cast to the funcref's expected struct type)
              fcCallBody.push({ op: "local.get", index: closureLocal });
              if (fc.structTypeIdx !== matchedStructTypeIdx) {
                // V8 canonicalizes same-layout structs, so this cast succeeds
                fcCallBody.push({ op: "ref.cast", typeIdx: fc.structTypeIdx });
              }
              // Push args
              for (const al of argLocals) {
                fcCallBody.push({ op: "local.get", index: al });
              }
              // Push typed funcref and call
              fcCallBody.push({ op: "local.get", index: funcrefLocal });
              fcCallBody.push({ op: "ref.cast", typeIdx: fc.funcTypeIdx });
              fcCallBody.push({ op: "call_ref", typeIdx: fc.funcTypeIdx });

              // Coerce return to expected type.
              //
              // The `if`-block declares `(result <expectedReturn>)`, so EVERY
              // arm must leave a value of that exact type. But only the arm
              // whose `funcTypeIdx` matches `retFn`'s runtime funcref actually
              // executes — the rest are synthesized type-validity padding that
              // never runs. So the coercion MUST be side-effect-free for those
              // dead arms: pulling a late host import (e.g. `__unbox_number`)
              // from a never-matching candidate shifts function indices mid-body
              // and desyncs an already-baked `ref.func` operand → the closure
              // ends up wrapping the wrong function (#2174 regression: a plain
              // `var fn = makeAdder(10); fn(32)` had its adder `ref.func`
              // rewritten to a freshly-imported `__typeof_boolean`, throwing at
              // runtime). The live arm always matches `expectedReturn` exactly
              // (so `valTypesMatch` is true and this block is skipped for it).
              const matchedDispatch = expectedReturn !== null && fc.returnType !== null;
              const numericKind = (t: ValType): boolean => t.kind === "i32" || t.kind === "f64" || t.kind === "i64";
              if (expectedReturn === null && fc.returnType !== null) {
                fcCallBody.push({ op: "drop" } as Instr);
              } else if (expectedReturn !== null && fc.returnType === null) {
                fcCallBody.push(...defaultValueInstrs(expectedReturn));
              } else if (
                matchedDispatch &&
                !valTypesMatch(fc.returnType!, expectedReturn!) &&
                numericKind(expectedReturn!) &&
                numericKind(fc.returnType!)
              ) {
                // (#1693) Numeric-primitive divergence between a real matching
                // candidate and the declared block type (e.g. expected i32,
                // candidate returns f64). `coerceType` between numeric kinds
                // emits ONLY pure ops (`f64.convert_i32_s` / `i32.trunc_sat_f64_s`
                // / …) — no late imports, no index shift — so it is safe even on
                // a dead arm. Surfaces at full-module scale in axios/lib/utils.js
                // where ~30 same-arity arrow predicates with diverging numeric
                // returns populate ctx.closureInfoByTypeIdx.
                const savedBody = fctx.body;
                fctx.body = fcCallBody;
                coerceType(ctx, fctx, fc.returnType!, expectedReturn!);
                fctx.body = savedBody;
              } else if (matchedDispatch && !valTypesMatch(fc.returnType!, expectedReturn!)) {
                // (#2174) Any remaining mismatch is externref/ref ↔ primitive on
                // a candidate that does NOT match the runtime funcref (the live
                // arm matched `expectedReturn` and skipped this block). Bridging
                // these via `coerceType` would pull `__box_number`/`__unbox_number`
                // — a late import that shifts indices and corrupts earlier
                // `ref.func`s. Since this arm never executes, drop its value and
                // push a type-valid default for the block result instead — no
                // import, no shift. (The async case from #2174 is handled by
                // widening `expectedReturn` to externref above, which makes the
                // live async/Promise arm `valTypesMatch` and pass through; the
                // dead f64 candidates land here and get a null-extern default.)
                fcCallBody.push({ op: "drop" } as Instr);
                fcCallBody.push(...defaultValueInstrs(expectedReturn!));
              }

              funcDispatch = [
                { op: "local.get", index: funcrefLocal },
                { op: "ref.test", typeIdx: fc.funcTypeIdx },
                {
                  op: "if",
                  blockType: retBlockType,
                  then: fcCallBody,
                  else: funcDispatch,
                } as Instr,
              ];
            }

            fctx.body.push(...funcDispatch);
          }

          // (#1712) Assemble the host-callable fallback split: the funcref
          // dispatch emitted above went into a detached buffer; wrap both arms
          // in an `if` on "cast failed but raw callee non-null".
          if (hostCallFallback && fallbackInstrs && dispatchOuterBody) {
            const dispatchInstrs = fctx.body;
            fctx.body = dispatchOuterBody;
            fctx.savedBodies.pop(); // fallbackInstrs
            fctx.savedBodies.pop(); // mainBuf (now fctx.body again)
            fctx.body.push({ op: "local.get", index: closureLocal });
            fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({ op: "local.get", index: rawCalleeLocal! });
            fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({ op: "i32.eqz" });
            fctx.body.push({ op: "i32.and" });
            fctx.body.push({
              op: "if",
              blockType:
                expectedReturn === null
                  ? ({ kind: "empty" } as const)
                  : ({ kind: "val", type: expectedReturn } as const),
              then: fallbackInstrs,
              else: dispatchInstrs,
            });
          }

          return expectedReturn ?? VOID_RESULT;
        }
      }

      // #1063 Part B: try inline dynamic-dispatch through closure-struct
      // candidates when the callee is a known variable of externref/any type
      // that may wrap a closure at runtime.
      const dyn = tryEmitInlineDynamicCall(ctx, fctx, expr, isKnownVariable);
      if (dyn !== null) return dyn;

      // Graceful fallback for unknown functions — compile arguments (for side effects)
      // then emit ref.null extern (undefined) as the return value.
      for (const arg of expr.arguments) {
        const argType = compileExpression(ctx, fctx, arg);
        if (argType) {
          fctx.body.push({ op: "drop" });
        }
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }

    // Check if this function is eligible for call-site inlining
    const inlineInfo = ctx.inlinableFunctions.get(funcName);
    if (inlineInfo && !expr.arguments.some((a: any) => ts.isSpreadElement(a))) {
      // Inline the function body: compile arguments into temp locals, then emit body
      const inlineOptInfo = ctx.funcOptionalParams.get(funcName);
      const argLocals: number[] = [];
      for (let i = 0; i < inlineInfo.paramCount; i++) {
        if (i < expr.arguments.length) {
          compileExpression(ctx, fctx, expr.arguments[i]!, inlineInfo.paramTypes[i]);
        } else {
          // #1658: a missing optional param must receive its default — either the
          // inlined constant (callee prologue is skipped for constant defaults) or
          // the sNaN sentinel that the inlined prologue checks for expression
          // defaults. pushDefaultValue alone emits 0/ref.null and silently drops
          // the default.
          const opt = inlineOptInfo?.find((o) => o.index === i);
          if (opt) {
            pushParamSentinel(fctx, inlineInfo.paramTypes[i]!, ctx, opt);
          } else {
            pushDefaultValue(fctx, inlineInfo.paramTypes[i]!, ctx);
          }
        }
        const tmpLocal = allocLocal(
          fctx,
          `__inline_${funcName}_p${i}_${fctx.locals.length}`,
          inlineInfo.paramTypes[i]!,
        );
        fctx.body.push({ op: "local.set", index: tmpLocal });
        argLocals.push(tmpLocal);
      }
      // Drop extra arguments (evaluate for side effects)
      for (let i = inlineInfo.paramCount; i < expr.arguments.length; i++) {
        const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
        if (extraType !== null) {
          fctx.body.push({ op: "drop" });
        }
      }
      // Emit the inlined body, remapping local.get indices to the temp locals.
      // Shallow-clone each instr so later remap passes (dead-elim, late-import
      // shift) do not mutate indices through shared references between the
      // original function body and the inlined copy (#1063).
      for (const instr of inlineInfo.body) {
        if (instr.op === "local.get") {
          const mapped = argLocals[(instr as any).index];
          if (mapped !== undefined) {
            fctx.body.push({ op: "local.get", index: mapped });
          } else {
            fctx.body.push({ ...instr });
          }
        } else {
          fctx.body.push({ ...instr });
        }
      }
      return inlineInfo.returnType ?? VOID_RESULT;
    }

    // Prepend captured values for nested functions with captures
    const nestedCaptures = ctx.nestedFuncCaptures.get(funcName);
    if (nestedCaptures) {
      // #1177: Get param types early so we can coerce captures to expected types.
      // Re-fetch funcIdx in case a prior compileExpression triggered a late-import
      // shift (which updated funcMap but not our local `funcIdx`).
      funcIdx = ctx.funcMap.get(funcName) ?? funcIdx;
      const captureParamTypes = getFuncParamTypes(ctx, funcIdx);
      for (let capIdx = 0; capIdx < nestedCaptures.length; capIdx++) {
        const cap = nestedCaptures[capIdx]!;
        // #1177: TDZ check for captured let/const/using variables — fires
        // BEFORE the cap-prepend so we throw ReferenceError before the callee
        // observes an uninitialized value. Apply to BOTH the mutable and
        // non-mutable branches: a callee with a mutable capture (ref cell)
        // can still be called while the outer let-decl is in TDZ if a
        // closure that captured the flag invokes the callee transitively.
        const capTdzIdx = fctx.tdzFlagLocals?.get(cap.name);
        if (capTdzIdx !== undefined) {
          const capTdzResult = analyzeTdzAccessByPos(ctx, cap.name, expr);
          if (capTdzResult === "check") {
            emitLocalTdzCheck(ctx, fctx, cap.name, capTdzIdx);
          } else if (capTdzResult === "throw") {
            emitStaticTdzThrow(ctx, fctx, cap.name);
          }
          // "skip" — call site is after declaration, no check needed
        }
        if (cap.mutable && cap.valType) {
          // Mutable capture: wrap in a ref cell so writes propagate back
          const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.valType);
          // Check if this local is already boxed (from a previous call to the same or another closure)
          //
          // #1259: detect double-wrap when `localMap[cap.name]` was
          // re-aimed at a boxed-cap local *deliberately* by a different
          // codegen site (compileArrowAsClosure, emitFuncRefAsClosure,
          // object-ops, etc.). All such sites use the `__boxed_<name>`
          // local-naming convention AND set `boxedCaptures[cap.name]`
          // in lockstep. The narrow guard here checks for both signals:
          //   1. the slot's type matches `cap.valType`'s ref cell type, AND
          //   2. the slot's name starts with `__boxed_`.
          // If both hold, we're confident this slot is a deliberately
          // boxed cap (not a coincidental same-typed local) and we can
          // pass it through without re-boxing. The narrower guard avoids
          // the regressions seen on the wider type-only guard (PR#166
          // CI: net -25, 33 wasm-change regressions).
          //
          // Without this check, none of the existing call sites would
          // hit the `localMap`-already-boxed-but-`boxedCaptures`-empty
          // path on main today (they pair the two writes). The guard
          // is defensive prep for #1177 Stage 1 — when Stage 1 re-aims
          // `localMap` to an outer-fctx boxed local whose `__boxed_` name
          // we can recognize, we'll treat it as already-boxed.
          const candidateLocalIdx = fctx.localMap.get(cap.name);
          let candidateIsBoxed = false;
          if (candidateLocalIdx !== undefined) {
            const candidateType = getLocalType(fctx, candidateLocalIdx);
            const isRefCellTyped =
              candidateType !== undefined &&
              (candidateType.kind === "ref" || candidateType.kind === "ref_null") &&
              (candidateType as { typeIdx: number }).typeIdx === refCellTypeIdx;
            // Also require the name signal — only deliberately-boxed locals
            // use the `__boxed_` convention.
            const localSlot =
              candidateLocalIdx >= fctx.params.length ? fctx.locals[candidateLocalIdx - fctx.params.length] : undefined;
            const hasBoxedName = localSlot?.name?.startsWith(`__boxed_`) ?? false;
            candidateIsBoxed = isRefCellTyped && hasBoxedName;
          }
          if (fctx.boxedCaptures?.has(cap.name) || candidateIsBoxed) {
            // Already a ref cell — pass the ref cell reference directly
            const currentLocalIdx = fctx.localMap.get(cap.name) ?? cap.outerLocalIdx;
            fctx.body.push({ op: "local.get", index: currentLocalIdx });
            // Backfill boxedCaptures only when we hit the new candidateIsBoxed
            // branch — preserves invariants for downstream helpers that key on
            // boxedCaptures membership.
            if (candidateIsBoxed && !fctx.boxedCaptures?.has(cap.name)) {
              if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
              fctx.boxedCaptures.set(cap.name, {
                refCellTypeIdx,
                valType: cap.valType,
              });
            }
          } else {
            // Create a ref cell, store the current value, keep ref on stack.
            // (Note: #1177 originally proposed `localMap.get(cap.name) ?? cap.outerLocalIdx`
            // but that caused 100+ test262 regressions where main's "wrong-slot"
            // behavior was load-bearing for tests that relied on a null deref
            // throwing inside an async fn body. Reverted; the canonical TDZ-
            // through-closure case is fixed via the call-site TDZ check below
            // and Stage 3 C.1 in compileArrowAsClosure.)
            fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
            fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
            // Also box the outer local so subsequent reads/writes go through the ref cell
            const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
              kind: "ref",
              typeIdx: refCellTypeIdx,
            });
            // Duplicate: need the ref cell for the call AND for the outer local
            fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
            // Re-register the original name to point to the boxed local
            fctx.localMap.set(cap.name, boxedLocalIdx);
            if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
            fctx.boxedCaptures.set(cap.name, {
              refCellTypeIdx,
              valType: cap.valType,
            });
          }
          // Coerce mutable capture (ref cell) to expected param type if they differ
          const expectedMutCapType = captureParamTypes?.[capIdx];
          if (expectedMutCapType) {
            const refCellType: ValType = { kind: "ref", typeIdx: refCellTypeIdx };
            if (!valTypesMatch(refCellType, expectedMutCapType)) {
              coerceType(ctx, fctx, refCellType, expectedMutCapType);
            }
          }
        } else {
          // (#1177: TDZ check moved above the mutable/non-mutable branch.
          // Stage 1 localMap-first lookup reverted — see comment in mutable
          // branch above.)
          fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
          // Coerce capture value to expected param type if they differ
          const expectedCapType = captureParamTypes?.[capIdx];
          if (expectedCapType) {
            const actualType = getLocalType(fctx, cap.outerLocalIdx);
            if (actualType && !valTypesMatch(actualType, expectedCapType)) {
              coerceType(ctx, fctx, actualType, expectedCapType);
            }
          }
        }
      }

      // #1205 Stage 3: After all value captures, push boxed TDZ flag refs.
      // Mirrors compileArrowAsClosure's construct-time logic at
      // closures.ts:2085-2118. Layout invariant: lifted-fn signature is
      // [valueCap_0, ..., valueCap_N-1, tdzFlagBox_0, ..., tdzFlagBox_K-1, ...userParams].
      const tdzFlaggedNested = nestedCaptures.filter((c) => c.hasTdzFlag);
      if (tdzFlaggedNested.length > 0) {
        const i32RefCellTypeIdx = getOrRegisterRefCellType(ctx, { kind: "i32" });
        for (const cap of tdzFlaggedNested) {
          const existing = fctx.boxedTdzFlags?.get(cap.name);
          if (existing) {
            // Already boxed by an enclosing closure construction or a prior
            // call-site cap-prepend — share the box reference.
            fctx.body.push({ op: "local.get", index: existing.localIdx });
          } else {
            // Fresh box: read the current i32 flag, struct.new an i32 ref cell,
            // tee into a new outer-fctx local, and re-aim
            // `fctx.tdzFlagLocals` + `fctx.boxedTdzFlags` so subsequent
            // emitLocalTdzInit / emitLocalTdzCheck in the outer scope route
            // through the same box.
            //
            // #1205 sourcing rules — the i32 flag must come from a location
            // we can verify is an i32 in the *current* fctx. Two cases:
            //
            //   1. Live `fctx.tdzFlagLocals.get(name)` returns an idx whose
            //      local type is i32 in the current fctx — use it directly.
            //      This is the common case (fn-decl hoisted in same fctx
            //      as the let-decl, no block shadowing in between).
            //
            //   2. Live lookup is missing or points to a non-i32 local.
            //      This covers two sub-cases that we treat the same way:
            //
            //      a. Block-scope shadow cleared the live entry. The
            //         stored `cap.outerTdzFlagIdx` still points to an i32
            //         local — but its RUNTIME VALUE is stale, because the
            //         inner let-decl's `emitLocalTdzInit` was a no-op
            //         (the live entry was deleted by `saveBlockScopedShadows`)
            //         so the flag was never set to 1 inside the block.
            //
            //      b. Cross-function transitive (fn A calls fn B and B
            //         captures a TDZ-flagged var that A does NOT capture).
            //         A's fctx has no source for B's flag. The stored idx
            //         points to a slot in B's hoist fctx, NOT in A's.
            //
            //      In both sub-cases, we cannot trust any runtime i32
            //      slot in the current fctx to give us the right flag
            //      value. Push `i32.const 1` (treat as initialized).
            //      This matches the pre-#1205 behavior, where the lifted
            //      body had no flag check at all — the call site's
            //      static TDZ analysis (calls.ts:4968-4977 above this
            //      block) is the authoritative pre-call check; if it
            //      didn't fire, the variable is past its TDZ.
            const liveFlagIdx = fctx.tdzFlagLocals?.get(cap.name);
            const liveType = liveFlagIdx !== undefined ? getLocalType(fctx, liveFlagIdx) : undefined;
            const liveOk = liveType?.kind === "i32";
            if (liveOk && liveFlagIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: liveFlagIdx });
              fctx.body.push({ op: "struct.new", typeIdx: i32RefCellTypeIdx });
            } else {
              fctx.body.push({ op: "i32.const", value: 1 });
              fctx.body.push({ op: "struct.new", typeIdx: i32RefCellTypeIdx });
            }
            const flagBoxLocal = allocLocal(fctx, `__tdz_box_${cap.name}`, {
              kind: "ref",
              typeIdx: i32RefCellTypeIdx,
            });
            fctx.body.push({ op: "local.tee", index: flagBoxLocal });
            // Only re-aim outer fctx's flag maps when we sourced from a
            // verified i32 in THIS fctx — otherwise we'd corrupt the maps
            // with a synthetic box that has no relationship to any actual
            // outer flag, which would in turn break later TDZ checks /
            // initializations in the outer scope.
            if (liveOk) {
              if (!fctx.boxedTdzFlags) fctx.boxedTdzFlags = new Map();
              fctx.boxedTdzFlags.set(cap.name, {
                refCellTypeIdx: i32RefCellTypeIdx,
                localIdx: flagBoxLocal,
              });
              if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
              fctx.tdzFlagLocals.set(cap.name, flagBoxLocal);
            }
          }
        }
      }
    }

    // #1177: Re-fetch funcIdx in case the cap-prepend loop above (or any
    // earlier compileExpression in this function) triggered a late-import
    // shift via emitLocalTdzCheck/emitStaticTdzThrow. #1205: also covers
    // late-import shifts triggered by the TDZ-flag prepend block (which
    // calls getOrRegisterRefCellType — typically pre-registered, but still).
    funcIdx = ctx.funcMap.get(funcName) ?? funcIdx;

    // Check for rest parameters on the callee
    const restInfo = ctx.funcRestParams.get(funcName);

    // Check if any argument uses spread syntax
    const hasSpreadArg = expr.arguments.some((a) => ts.isSpreadElement(a));
    const linearParamsForCall = getLinearU8ParamIndicesForCall(ctx, expr);
    const hasLinearParamsForCall = !!linearParamsForCall && linearParamsForCall.size > 0;

    if (hasLinearParamsForCall && hasSpreadArg) {
      reportError(ctx, expr, "Cannot spread arguments into a linear Uint8Array helper call (#1886)");
      const paramTypes = getFuncParamTypes(ctx, funcIdx);
      for (const arg of expr.arguments) {
        const argExpr = ts.isSpreadElement(arg) ? arg.expression : arg;
        const argType = compileExpression(ctx, fctx, argExpr);
        if (argType !== null) {
          fctx.body.push({ op: "drop" });
        }
      }
      if (paramTypes) {
        for (const paramType of paramTypes) {
          pushDefaultValue(fctx, paramType, ctx);
        }
      }
    } else if (restInfo && !hasSpreadArg && !hasLinearParamsForCall) {
      // Calling a rest-param function: pack trailing args into a GC array
      const paramTypes = getFuncParamTypes(ctx, funcIdx);
      // Compile non-rest arguments
      for (let i = 0; i < restInfo.restIndex; i++) {
        if (i < expr.arguments.length) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
        } else {
          pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" }, ctx);
        }
      }
      // Pack remaining arguments into a vec struct (array + length)
      const restArgCount = Math.max(0, expr.arguments.length - restInfo.restIndex);
      // Push length first (for struct.new order: length, data)
      fctx.body.push({ op: "i32.const", value: restArgCount });
      // Push elements, then array.new_fixed
      for (let i = restInfo.restIndex; i < expr.arguments.length; i++) {
        compileExpression(ctx, fctx, expr.arguments[i]!, restInfo.elemType);
      }
      fctx.body.push({
        op: "array.new_fixed",
        typeIdx: restInfo.arrayTypeIdx,
        length: restArgCount,
      });
      // Wrap in vec struct: { length, data }
      fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
    } else if (hasSpreadArg) {
      // Spread in function call: fn(...arr) — unpack array elements as positional args
      compileSpreadCallArgs(ctx, fctx, expr, funcIdx, restInfo);
    } else {
      // Normal call — compile provided arguments with type hints from function signature
      const paramTypes = getFuncParamTypes(ctx, funcIdx);
      // #1205: Each TDZ-flagged value capture also has a flag-box param
      // prepended to the lifted fn signature (see FNDECL-A2 in
      // statements/nested-declarations.ts). Account for those flag params
      // when computing user-visible arity — otherwise the padding loop
      // below pushes a phantom default value for each flag, producing an
      // arity-mismatch trap at the call site.
      const captureCount = nestedCaptures
        ? nestedCaptures.length + nestedCaptures.filter((c) => c.hasTdzFlag).length
        : 0;
      // User-visible param count excludes capture params (which are prepended internally)
      const paramCount =
        hasLinearParamsForCall && paramTypes
          ? sourceParamCountFromExpanded(paramTypes.length, linearParamsForCall, captureCount)
          : paramTypes
            ? paramTypes.length - captureCount
            : expr.arguments.length;
      const calleeReadsArgsDirect = ctx.funcUsesArguments.has(funcName);
      let pushedUserWasmArgCount = 0;
      for (let i = 0; i < Math.min(expr.arguments.length, paramCount); i++) {
        if (hasLinearParamsForCall && linearParamsForCall.has(i)) {
          const arg = expr.arguments[i]!;
          const buf = getLinearU8Buffer(ctx, fctx, arg);
          if (!buf) {
            reportError(
              ctx,
              arg,
              "Codegen error: linear Uint8Array helper argument is not backed by linear memory (#1886)",
            );
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "i32.const", value: 0 });
          } else {
            fctx.body.push({ op: "local.get", index: buf.ptrLocalIdx });
            fctx.body.push({ op: "local.get", index: buf.lenLocalIdx });
          }
          pushedUserWasmArgCount += 2;
          continue;
        }
        const wasmParamIndex =
          hasLinearParamsForCall && paramTypes
            ? wasmParamIndexForSourceParam(i, linearParamsForCall, captureCount)
            : i + captureCount;
        compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[wasmParamIndex]);
        pushedUserWasmArgCount++;
      }
      if (expr.arguments.length > paramCount) {
        if (calleeReadsArgsDirect) {
          emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], paramCount);
        } else {
          for (let i = paramCount; i < expr.arguments.length; i++) {
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null) {
              fctx.body.push({ op: "drop" });
            }
          }
        }
      }

      // Supply defaults for missing optional params
      const optInfo = ctx.funcOptionalParams.get(funcName);
      if (optInfo) {
        const numProvided = expr.arguments.length;
        for (const opt of optInfo) {
          if (opt.index >= numProvided) {
            pushParamSentinel(fctx, opt.type, ctx, opt);
          }
        }
      }

      // Pad any remaining missing arguments with defaults
      // (handles arity mismatch: calling f(a, b) with just f(1))
      if (paramTypes) {
        // Count how many args were actually pushed: provided args (capped at paramCount)
        // plus optional param defaults already pushed
        // plus capture params already pushed by nestedCaptures loop above
        const providedCount =
          (hasLinearParamsForCall ? pushedUserWasmArgCount : Math.min(expr.arguments.length, paramCount)) +
          captureCount;
        const optFilledCount = optInfo ? optInfo.filter((o) => o.index >= expr.arguments.length).length : 0;
        const totalPushed = providedCount + optFilledCount;
        for (let i = totalPushed; i < paramTypes.length; i++) {
          pushDefaultValue(fctx, paramTypes[i]!, ctx);
        }
      }
      // Set __argc before the call so the callee knows the actual arg count
      maybeSetArgcForKnownCall(ctx, fctx, funcName, expr.arguments.length, paramCount);
    }

    // Re-lookup funcIdx: argument compilation may trigger addUnionImports
    // which shifts defined-function indices, making the earlier lookup stale.
    const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx;
    fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

    // Determine return type from function signature
    const sig = ctx.checker.getResolvedSignature(expr);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
      // Safety check: if the Wasm function actually has void return (e.g. async
      // functions with Promise<void>), the TS type may be misleading
      if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
      // Use actual Wasm return type to avoid TS 'any' → externref mismatch
      return getWasmFuncReturnType(ctx, finalFuncIdx) ?? resolveWasmType(ctx, retType);
    }
    return getWasmFuncReturnType(ctx, finalFuncIdx) ?? { kind: "f64" };
  }

  // Handle IIFE: (function() { ... })() or (() => expr)() — inline the function body
  {
    // Unwrap parenthesized expression to find the function/arrow
    let callee: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(callee)) {
      callee = callee.expression;
    }
    if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) {
      // Generator function expressions (function*) must NOT be inlined as IIFEs
      // because their body contains `yield` which requires a generator context.
      // Let them fall through to the normal closure compilation path (#657).
      const isGeneratorIIFE = ts.isFunctionExpression(callee) && callee.asteriskToken !== undefined;
      if (isGeneratorIIFE) {
        // Generator function expressions can't be inlined (yield requires generator context).
        // Compile as closure, store in temp local, and invoke via call_ref.
        const closureType = compileArrowFunction(ctx, fctx, callee as ts.FunctionExpression);
        if (closureType && (closureType.kind === "ref" || closureType.kind === "ref_null")) {
          const typeIdx = (closureType as { typeIdx: number }).typeIdx;
          const closureInfo = ctx.closureInfoByTypeIdx.get(typeIdx);
          if (closureInfo) {
            // Store closure ref in a temp local
            const tmpName = `__gen_iife_${fctx.locals.length}`;
            const tmpLocal = allocLocal(fctx, tmpName, closureType);
            fctx.body.push({ op: "local.set", index: tmpLocal });
            // Register the temp local so compileClosureCall can find it
            fctx.localMap.set(tmpName, tmpLocal);
            return compileClosureCall(ctx, fctx, expr, tmpName, closureInfo);
          }
        }
        // If closure compilation failed, drop any value on stack and fall through to fallback
        if (closureType) {
          fctx.body.push({ op: "drop" });
        }
      } else {
        const params = callee.parameters;
        const args = expr.arguments;
        // Check if the IIFE body references `arguments` (only for function expressions, not arrows)
        const iifeNeedsArguments = ts.isFunctionExpression(callee) && callee.body && usesArguments(callee.body);
        // Support IIFEs with matching parameter/argument counts
        if (params.length <= args.length) {
          // Allocate locals for parameters and compile arguments
          const paramLocals: number[] = [];
          const allArgLocals: { idx: number; type: ValType }[] = [];
          for (let i = 0; i < params.length; i++) {
            const param = params[i]!;
            const paramName = ts.isIdentifier(param.name) ? param.name.text : `__iife_p${i}`;
            const argType = compileExpression(ctx, fctx, args[i]!);
            const localType = argType ?? { kind: "f64" as const };
            const idx = allocLocal(fctx, paramName, localType);
            fctx.body.push({ op: "local.set", index: idx });
            paramLocals.push(idx);
            if (iifeNeedsArguments) {
              allArgLocals.push({ idx, type: localType });
            }
          }
          // Extra arguments beyond declared params
          if (iifeNeedsArguments) {
            // Store extra args in locals for the arguments object
            for (let i = params.length; i < args.length; i++) {
              const t = compileExpression(ctx, fctx, args[i]!);
              const localType = t ?? { kind: "f64" as const };
              if (t === null) {
                // No value produced — push a default
                fctx.body.push({ op: "f64.const", value: 0 });
              }
              const idx = allocLocal(fctx, `__iife_extra_${i}`, localType as ValType);
              fctx.body.push({ op: "local.set", index: idx });
              allArgLocals.push({ idx, type: localType as ValType });
            }
          } else {
            // Drop extra arguments (evaluate for side effects)
            for (let i = params.length; i < args.length; i++) {
              const t = compileExpression(ctx, fctx, args[i]!);
              if (t) {
                fctx.body.push({ op: "drop" });
              }
            }
          }

          // Set up `arguments` vec for the IIFE if needed
          if (iifeNeedsArguments && allArgLocals.length > 0) {
            // Ensure __box_number is available for boxing numeric args
            const hasNumeric = allArgLocals.some((a) => a.type.kind === "f64" || a.type.kind === "i32");
            if (hasNumeric) {
              ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
              flushLateImportShifts(ctx, fctx);
            }

            const vti = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
            const ati = getArrTypeIdxFromVec(ctx, vti);
            const vecRef: ValType = { kind: "ref", typeIdx: vti };
            const argsLocal = allocLocal(fctx, "arguments", vecRef);
            const arrTmp = allocLocal(fctx, "__iife_args_arr", { kind: "ref", typeIdx: ati });

            for (const { idx, type } of allArgLocals) {
              fctx.body.push({ op: "local.get", index: idx });
              if (type.kind === "f64") {
                const boxIdx = ctx.funcMap.get("__box_number");
                if (boxIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else {
                  fctx.body.push({ op: "drop" });
                  fctx.body.push({ op: "ref.null.extern" });
                }
              } else if (type.kind === "i32") {
                fctx.body.push({ op: "f64.convert_i32_s" });
                const boxIdx = ctx.funcMap.get("__box_number");
                if (boxIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else {
                  fctx.body.push({ op: "drop" });
                  fctx.body.push({ op: "ref.null.extern" });
                }
              } else if (type.kind === "ref" || type.kind === "ref_null") {
                fctx.body.push({ op: "extern.convert_any" });
              }
              // externref: already correct
            }
            fctx.body.push({ op: "array.new_fixed", typeIdx: ati, length: allArgLocals.length });
            fctx.body.push({ op: "local.set", index: arrTmp });
            fctx.body.push({ op: "i32.const", value: allArgLocals.length });
            fctx.body.push({ op: "local.get", index: arrTmp });
            fctx.body.push({ op: "struct.new", typeIdx: vti });
            fctx.body.push({ op: "local.set", index: argsLocal });
          } else if (iifeNeedsArguments) {
            // No arguments at all — create empty arguments vec
            const vti = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
            const ati = getArrTypeIdxFromVec(ctx, vti);
            const vecRef: ValType = { kind: "ref", typeIdx: vti };
            const argsLocal = allocLocal(fctx, "arguments", vecRef);
            const arrTmp = allocLocal(fctx, "__iife_args_arr", { kind: "ref", typeIdx: ati });
            fctx.body.push({ op: "array.new_fixed", typeIdx: ati, length: 0 });
            fctx.body.push({ op: "local.set", index: arrTmp });
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "local.get", index: arrTmp });
            fctx.body.push({ op: "struct.new", typeIdx: vti });
            fctx.body.push({ op: "local.set", index: argsLocal });
          }

          // Compile body
          if (ts.isArrowFunction(callee) && !ts.isBlock(callee.body)) {
            // Concise body: expression — no return issue
            return compileExpression(ctx, fctx, callee.body);
          }

          // Block body (arrow or function expression) — need to handle return
          const bodyStmts = ts.isArrowFunction(callee) ? (callee.body as ts.Block).statements : callee.body.statements;
          if (bodyStmts.length === 0) {
            return VOID_RESULT;
          }

          // Determine return type from TS
          const iifeRetType = ctx.checker.getTypeAtLocation(expr);
          const iifeWasmRetType = isVoidType(iifeRetType) ? null : resolveWasmType(ctx, iifeRetType);

          if (iifeWasmRetType) {
            // Returning IIFE: allocate a result local, compile body into a block,
            // and replace `return` with `local.set + br` to exit the block
            const retLocal = allocLocal(fctx, `__iife_ret_${fctx.locals.length}`, iifeWasmRetType);
            const savedBody = fctx.body;
            fctx.savedBodies.push(savedBody);
            const blockBody: Instr[] = [];
            fctx.body = blockBody;

            // Save and override returnType so that return statements inside the
            // IIFE coerce to the IIFE's own return type, not the outer function's.
            // Without this, a boolean-returning IIFE inside an f64-returning
            // function would coerce i32→f64 before local.set into an i32 local.
            const savedReturnType = fctx.returnType;
            fctx.returnType = iifeWasmRetType;

            // Hoist let/const with TDZ flags so accesses before init throw (#790)
            hoistLetConstWithTdz(ctx, fctx, bodyStmts as unknown as ts.Statement[]);
            // Hoist function declarations so they're available before textual position
            hoistFunctionDeclarations(ctx, fctx, bodyStmts as unknown as ts.Statement[]);

            // Increase block depth so return→br targets the right level
            fctx.blockDepth++;
            for (const stmt of bodyStmts) {
              compileStatement(ctx, fctx, stmt);
            }
            fctx.blockDepth--;

            // Restore outer function's return type
            fctx.returnType = savedReturnType;
            fctx.savedBodies.pop();
            fctx.body = savedBody;

            // Post-process: replace `return` / `return_call` / `return_call_ref` ops
            // with `local.set retLocal + br <depth>`.  Tail-call optimization in
            // compileReturnStatement may have merged call+return into return_call;
            // inside an IIFE we must undo that since we need local.set + br instead.
            function patchReturns(instrs: Instr[], depth: number): void {
              for (let i = 0; i < instrs.length; i++) {
                const op = instrs[i]!.op;
                if (op === "return") {
                  // The instruction before `return` is the return value expression.
                  // Replace `return` with `local.set + br`
                  instrs[i] = { op: "local.set", index: retLocal } as Instr;
                  instrs.splice(i + 1, 0, { op: "br", depth } as Instr);
                  i++; // skip the inserted br
                } else if (op === "return_call" || op === "return_call_ref") {
                  // Undo tail-call: return_call funcIdx → call funcIdx + local.set + br
                  const instr = instrs[i] as any;
                  instr.op = op === "return_call" ? "call" : "call_ref";
                  instrs.splice(i + 1, 0, { op: "local.set", index: retLocal } as Instr, { op: "br", depth } as Instr);
                  i += 2; // skip inserted instructions
                }
                // Recurse into sub-blocks (if/then/else/block/loop)
                const instr = instrs[i] as any;
                if (instr.then) patchReturns(instr.then, depth + 1);
                if (instr.else) patchReturns(instr.else, depth + 1);
                if (instr.body && Array.isArray(instr.body)) patchReturns(instr.body, depth + 1);
              }
            }
            patchReturns(blockBody, 0);

            // Emit: block { <body> } local.get retLocal
            fctx.body.push({
              op: "block",
              blockType: { kind: "empty" },
              body: blockBody,
            } as Instr);
            fctx.body.push({ op: "local.get", index: retLocal });
            return iifeWasmRetType;
          } else {
            // Void IIFE — wrap the body in a block so that `return` inside
            // the IIFE exits ONLY the IIFE rather than the enclosing function
            // (#1348). Without this wrapper, e.g.
            //   (function () { for (var x of it) { return; } }());
            // would emit a Wasm `return` from the outer function, dropping
            // any `for-of`-followups (post-IIFE asserts) and breaking the
            // §14.7.5 IteratorClose-on-return semantics expected by callers.
            const savedBody = fctx.body;
            fctx.savedBodies.push(savedBody);
            const blockBody: Instr[] = [];
            fctx.body = blockBody;

            // Save and override returnType: void IIFE has no return value,
            // so any `return <expr>;` inside the body should drop the value
            // (we model this by setting returnType=null which causes
            // compileReturnStatement to drop the expression value).
            const savedReturnType = fctx.returnType;
            fctx.returnType = null;

            // Hoist let/const with TDZ flags so accesses before init throw (#790)
            hoistLetConstWithTdz(ctx, fctx, bodyStmts as unknown as ts.Statement[]);
            // Hoist function declarations so they're available before textual position
            hoistFunctionDeclarations(ctx, fctx, bodyStmts as unknown as ts.Statement[]);

            // Increase block depth so return→br targets the right level
            fctx.blockDepth++;
            for (const stmt of bodyStmts) {
              compileStatement(ctx, fctx, stmt);
            }
            fctx.blockDepth--;

            // Restore outer function's return type
            fctx.returnType = savedReturnType;
            fctx.savedBodies.pop();
            fctx.body = savedBody;

            // Post-process: replace `return` / `return_call` / `return_call_ref`
            // with `br <depth>`. Tail-call optimization in compileReturnStatement
            // may have merged call+return into return_call; inside an IIFE we
            // must undo that and lower it back to a plain call.
            function patchVoidReturns(instrs: Instr[], depth: number): void {
              for (let i = 0; i < instrs.length; i++) {
                const op = instrs[i]!.op;
                if (op === "return") {
                  // void IIFE: no value to capture — replace with br
                  instrs[i] = { op: "br", depth } as Instr;
                } else if (op === "return_call" || op === "return_call_ref") {
                  // Undo tail-call: rewrite as plain call + br
                  const instr = instrs[i] as any;
                  instr.op = op === "return_call" ? "call" : "call_ref";
                  instrs.splice(i + 1, 0, { op: "br", depth } as Instr);
                  i++; // skip inserted br
                }
                const instr = instrs[i] as any;
                if (instr.then) patchVoidReturns(instr.then, depth + 1);
                if (instr.else) patchVoidReturns(instr.else, depth + 1);
                if (instr.body && Array.isArray(instr.body)) patchVoidReturns(instr.body, depth + 1);
                if (instr.catchAll && Array.isArray(instr.catchAll)) patchVoidReturns(instr.catchAll, depth + 1);
                if (Array.isArray(instr.catches)) {
                  for (const c of instr.catches) {
                    if (Array.isArray(c.body)) patchVoidReturns(c.body, depth + 1);
                  }
                }
              }
            }
            patchVoidReturns(blockBody, 0);

            // Emit: block { <body> }
            fctx.body.push({
              op: "block",
              blockType: { kind: "empty" },
              body: blockBody,
            } as Instr);
            return VOID_RESULT;
          }
        }
      } // end else (non-generator IIFE)
    }
  }

  // Handle standalone super() calls (constructor chaining) — top-level super(...)
  // statements are handled inline by compileClassBodies, which short-circuits the
  // ExpressionStatement before it reaches this path. When `super(...)` appears
  // nested inside control flow (try/catch, if/loop) inside the user constructor,
  // the inline handler doesn't see it. To preserve §13.3.7.1 step 4 (ArgumentList­
  // Evaluation + ReturnIfAbrupt) we evaluate every argument left-to-right here
  // for side effects, dropping the resulting value. Parent-field assignment
  // remains best-effort: nested-super field forwarding is handled by the
  // inline path; this fallback ensures throws from arg expressions propagate
  // to the user's try/catch (#1551).
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    for (const arg of expr.arguments) {
      const inner = ts.isSpreadElement(arg) ? arg.expression : arg;
      const argResult = compileExpression(ctx, fctx, inner);
      if (argResult !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
    return null;
  }

  // Handle IIFE: (function(...) { ... })(...) — immediately invoked function expression
  {
    const iifeResult = compileIIFE(ctx, fctx, expr);
    if (iifeResult !== undefined) return iifeResult;
  }

  // Handle comma-operator indirect calls: (0, foo)() or (expr, fn)()
  // Unwrap parenthesized comma expression, evaluate left for side effects, call right.
  {
    let callee: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(callee)) {
      callee = callee.expression;
    }
    if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      // Evaluate left side for side effects and drop
      const leftType = compileExpression(ctx, fctx, callee.left);
      if (leftType) {
        fctx.body.push({ op: "drop" });
      }
      // Create a synthetic call with the right side as callee
      const syntheticCall = ts.factory.createCallExpression(
        callee.right as ts.Expression as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      // Preserve parent for type checker resolution
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Handle ElementAccessExpression calls: obj['method']() or obj[0]() or obj[constKey]()
  // Convert to equivalent property access method call when the index resolves to a static key.
  if (ts.isElementAccessExpression(expr.expression)) {
    const elemAccess = expr.expression;
    const argExpr = elemAccess.argumentExpression;
    // Resolve the key to a static string: string literals, numeric literals, const variables, etc.
    let resolvedMethodName: string | undefined;
    if (argExpr) {
      if (ts.isStringLiteral(argExpr)) {
        resolvedMethodName = argExpr.text;
      } else if (ts.isNumericLiteral(argExpr)) {
        resolvedMethodName = String(Number(argExpr.text));
      } else {
        resolvedMethodName = resolveComputedKeyExpression(ctx, argExpr);
      }
    }

    // Handle super['method']() calls — resolve to ParentClass_method with this as first arg
    if (elemAccess.expression.kind === ts.SyntaxKind.SuperKeyword && resolvedMethodName !== undefined) {
      return compileSuperElementMethodCall(ctx, fctx, expr, resolvedMethodName);
    }

    if (resolvedMethodName !== undefined) {
      const methodName = resolvedMethodName;
      const receiverType = ctx.checker.getTypeAtLocation(elemAccess.expression);

      // Iterator protocol dispatch (#1016b): obj[Symbol.iterator]() and
      // obj[Symbol.asyncIterator]() must drive the iterator protocol via the
      // host imports __iterator / __async_iterator. Without this, calls like
      // `array[Symbol.iterator]()` fall through to the null-pushing fallback
      // because no class method `__@@iterator` is registered for built-in JS
      // iterables (TypedArray, Map, Set, RegExpStringIterator, etc.).
      // The runtime __iterator handles all dispatch paths:
      //   - direct Symbol.iterator on JS objects
      //   - sidecar @@iterator on WasmGC structs
      //   - WasmGC closure via __call_fn_0
      //   - __call_@@iterator export for user-defined iterable classes
      //   - __vec_len/__vec_get fallback for vec structs (arrays)
      if (methodName === "@@iterator" || methodName === "@@asyncIterator") {
        const importName = methodName === "@@iterator" ? "__iterator" : "__async_iterator";
        const recvType = compileExpression(ctx, fctx, elemAccess.expression);
        if (recvType) {
          if (recvType.kind === "ref" || recvType.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          } else if (recvType.kind === "f64") {
            const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
            if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
          } else if (recvType.kind === "i32") {
            fctx.body.push({ op: "f64.convert_i32_s" });
            const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
            if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
          // externref / funcref / other: assume already iterable-shaped
        }
        // Iterator methods take no arguments; evaluate any extras for side effects only.
        for (const arg of expr.arguments) {
          const argType = compileExpression(ctx, fctx, arg);
          if (argType) fctx.body.push({ op: "drop" });
        }
        const iterIdx = ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (iterIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: iterIdx });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        return { kind: "externref" };
      }

      // (#1439) RegExp.prototype[@@replace/@@match/@@search/@@split/@@matchAll]
      // protocol dispatch. `regex[Symbol.replace](str, replaceValue)` is the
      // ECMAScript §22.2.5 mechanism that `String.prototype.replace` and
      // friends delegate to. The receiver is an externref (RegExp lives in
      // the host), so a direct call_ref on the property access would deref
      // a null pointer — there's no Wasm function bound to the symbol key
      // on a host object. Route to `__regex_symbol_call(regex, id, arg0, arg1)`
      // which performs `regex[Symbol.X](arg0[, arg1])` in JS land.
      {
        const REGEX_SYMBOL_METHODS: Record<string, number> = {
          "@@match": 7,
          "@@replace": 8,
          "@@search": 9,
          "@@split": 10,
          "@@matchAll": 15,
        };
        const protocolId = REGEX_SYMBOL_METHODS[methodName];
        if (protocolId !== undefined) {
          // Receiver is RegExp, or its static type is unresolvable (`any` /
          // `unknown`) so we cannot prove it is *not* a RegExp. The latter
          // covers `(re as any)[Symbol.split](str)`, a RegExp stored in an
          // `any`/parameter slot, and `RegExp.prototype[Symbol.split]`
          // accessed off a base that loses its type (#1331). In all these
          // cases the host helper `__regex_symbol_call` does a fully dynamic
          // `recv[Symbol.X](args)` lookup, so routing here is correct for any
          // object that implements the well-known symbol method — not just
          // RegExp. We must NOT catch receivers that resolve to a user-defined
          // wasm class (handled by the ClassName_method dispatch below) or the
          // `@@iterator`/`@@asyncIterator` cases (already handled above).
          const recvSym = receiverType.getSymbol()?.name;
          // (#1330) When a regex flows through an `any`/unresolved variable —
          // the common test262 shape `re[Symbol.search](s)` with `re: any` —
          // recvSym is undefined and the narrow `=== "RegExp"` guard rejects
          // it, so dispatch falls through to generic method lookup which can't
          // resolve the "@@search" string key → returns 0/undefined. Route
          // these through `__regex_symbol_call` too: the host import validates
          // the receiver at runtime (throws the correct TypeError if it isn't a
          // RegExp), so widening here is spec-safe. Stay narrow for receivers
          // that resolve to a *user* class/struct, which may define their own
          // @@match/@@replace/etc.
          const isRegExpRecv = recvSym === "RegExp" || recvSym === "RegExpConstructor";
          let resolvedClassName = receiverType.getSymbol()?.name;
          if (resolvedClassName && !ctx.classSet.has(resolvedClassName)) {
            resolvedClassName = ctx.classExprNameMap.get(resolvedClassName) ?? resolvedClassName;
          }
          const recvIsUserClass = !!resolvedClassName && ctx.classSet.has(resolvedClassName);
          const recvIsUnresolved = (receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
          if ((isRegExpRecv || recvIsUnresolved) && !recvIsUserClass) {
            if (ctx.standalone) {
              reportError(
                ctx,
                expr,
                `Codegen error: standalone RegExp literal-substring backend does not support ` +
                  `${methodName} symbol protocol calls (#682/#1474). Use RegExp.prototype.test ` +
                  `with a plain static pattern and no flags, or recompile without --target standalone.`,
              );
              return null;
            }

            // Push receiver as externref (already a RegExp host object)
            const recvType = compileExpression(ctx, fctx, elemAccess.expression);
            if (recvType) {
              if (recvType.kind === "ref" || recvType.kind === "ref_null") {
                fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
              } else if (recvType.kind === "f64") {
                const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
              } else if (recvType.kind === "i32") {
                fctx.body.push({ op: "f64.convert_i32_s" });
                const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
              }
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            // symbol ID
            fctx.body.push({ op: "i32.const", value: protocolId });
            // arg0 (the string operand) — coerce to externref
            if (expr.arguments.length > 0) {
              const a0 = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
              if (a0) {
                if (a0.kind === "ref" || a0.kind === "ref_null") {
                  fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
                } else if (a0.kind === "f64") {
                  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                  if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else if (a0.kind === "i32") {
                  fctx.body.push({ op: "f64.convert_i32_s" });
                  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                  if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
                }
              } else {
                fctx.body.push({ op: "ref.null.extern" });
              }
            } else {
              // Spec: ToString(undefined) → "undefined" — but at the host
              // boundary an `undefined` externref roundtrip is fine because
              // the host method does its own ToString coercion.
              fctx.body.push({ op: "ref.null.extern" });
            }
            // arg1 (replaceValue / limit) — coerce to externref, default null
            if (expr.arguments.length > 1) {
              const a1 = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
              if (a1) {
                if (a1.kind === "ref" || a1.kind === "ref_null") {
                  fctx.body.push({ op: "extern.convert_any" } as unknown as Instr);
                } else if (a1.kind === "f64") {
                  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                  if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else if (a1.kind === "i32") {
                  fctx.body.push({ op: "f64.convert_i32_s" });
                  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                  if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
                }
              } else {
                fctx.body.push({ op: "ref.null.extern" });
              }
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            // Drop any extra arguments (evaluate for side effects)
            for (let i = 2; i < expr.arguments.length; i++) {
              const extra = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extra !== null) fctx.body.push({ op: "drop" });
            }
            const callIdx = ensureLateImport(
              ctx,
              "__regex_symbol_call",
              [{ kind: "externref" }, { kind: "i32" }, { kind: "externref" }, { kind: "externref" }],
              [{ kind: "externref" }],
            );
            flushLateImportShifts(ctx, fctx);
            if (callIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: callIdx });
            } else {
              // Shouldn't happen, but be defensive
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "ref.null.extern" });
            }
            return { kind: "externref" };
          }
        }
      }

      // Try class instance method: ClassName_methodName
      let receiverClassName = receiverType.getSymbol()?.name;
      if (receiverClassName && !ctx.classSet.has(receiverClassName)) {
        receiverClassName = ctx.classExprNameMap.get(receiverClassName) ?? receiverClassName;
      }
      if (receiverClassName && ctx.classSet.has(receiverClassName)) {
        const fullName = `${receiverClassName}_${methodName}`;
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          // Push self (the receiver) as first argument
          compileExpression(ctx, fctx, elemAccess.expression);
          // Push remaining arguments with type hints
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const eaMethodParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
          for (let i = 0; i < expr.arguments.length; i++) {
            if (i < eaMethodParamCount) {
              compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
            } else {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
          // Pad missing arguments with defaults (skip self param at index 0)
          if (paramTypes) {
            for (let i = Math.min(expr.arguments.length, eaMethodParamCount) + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          fctx.body.push({ op: "call", funcIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
      }

      // Try struct method: structName_methodName
      const structTypeName = resolveStructName(ctx, receiverType);
      if (structTypeName) {
        const fullName = `${structTypeName}_${methodName}`;
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          const recvType = compileExpression(ctx, fctx, elemAccess.expression);
          // Check if receiver went through emitGuardedRefCast — null may mean
          // "wrong struct type" rather than genuinely null (#789)
          const eaReceiverWasCast = (fctx as any).__lastGuardedCastBackup !== undefined;
          // Null-guard: if receiver is ref_null, check for null before calling method
          if (recvType && recvType.kind === "ref_null") {
            const sig = ctx.checker.getResolvedSignature(expr);
            let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (!isEffectivelyVoidReturn(ctx, retType, fullName))
                callReturnType = getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType);
            }
            const tmp = allocLocal(fctx, `__ng_ea_recv_${fctx.locals.length}`, recvType);
            fctx.body.push({ op: "local.tee", index: tmp });
            fctx.body.push({ op: "ref.is_null" });

            const savedBody = pushBody(fctx);
            fctx.body.push({ op: "local.get", index: tmp });
            fctx.body.push({ op: "ref.as_non_null" } as Instr);
            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            const eaNgParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
            for (let i = 0; i < expr.arguments.length; i++) {
              if (i < eaNgParamCount) {
                compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
              } else {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
            if (paramTypes) {
              for (let i = Math.min(expr.arguments.length, eaNgParamCount) + 1; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!, ctx);
              }
            }
            fctx.body.push({ op: "call", funcIdx });
            const elseInstrs = fctx.body;
            fctx.body = savedBody;

            if (callReturnType === VOID_RESULT) {
              // If null after cast, skip (wrong type); if genuinely null, throw TypeError (#789)
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: eaReceiverWasCast ? ([] as Instr[]) : typeErrorThrowInstrs(ctx),
                else: elseInstrs,
              });
              return VOID_RESULT;
            } else {
              const resultType: ValType =
                callReturnType.kind === "ref"
                  ? {
                      kind: "ref_null",
                      typeIdx: (callReturnType as any).typeIdx,
                    }
                  : callReturnType;
              // If null after cast, default (wrong type); if genuinely null, throw TypeError (#789)
              fctx.body.push({
                op: "if",
                blockType: { kind: "val" as const, type: resultType },
                then: eaReceiverWasCast ? defaultValueInstrs(resultType) : typeErrorThrowInstrs(ctx),
                else: elseInstrs,
              });
              return resultType;
            }
          }
          // Non-nullable receiver
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const eaNnParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
          for (let i = 0; i < expr.arguments.length; i++) {
            if (i < eaNnParamCount) {
              compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
            } else {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
          if (paramTypes) {
            for (let i = Math.min(expr.arguments.length, eaNnParamCount) + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          fctx.body.push({ op: "call", funcIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType);
          }
          return VOID_RESULT;
        }
      }

      // Try static method: ClassName.staticMethod via element access
      if (ts.isIdentifier(elemAccess.expression) && ctx.classSet.has(elemAccess.expression.text)) {
        const clsName = elemAccess.expression.text;
        const fullName = `${clsName}_${methodName}`;
        if (ctx.staticMethodSet.has(fullName)) {
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined) {
            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            const eaStaticParamCount = paramTypes ? paramTypes.length : expr.arguments.length;
            for (let i = 0; i < expr.arguments.length; i++) {
              if (i < eaStaticParamCount) {
                compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
              } else {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
            if (paramTypes) {
              for (let i = expr.arguments.length; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!, ctx);
              }
            }
            fctx.body.push({ op: "call", funcIdx });

            const sig = ctx.checker.getResolvedSignature(expr);
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
              if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
              return getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType);
            }
            return VOID_RESULT;
          }
        }
      }

      // Try string method: string_methodName
      if (isStringType(receiverType)) {
        const importName = `string_${methodName}`;
        const funcIdx = ctx.funcMap.get(importName);
        if (funcIdx !== undefined) {
          compileExpression(ctx, fctx, elemAccess.expression);
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const args = expr.arguments;
          for (let ai = 0; ai < args.length; ai++) {
            const argResult = compileExpression(ctx, fctx, args[ai]!);
            const expectedType = paramTypes?.[ai + 1];
            if (argResult && expectedType && argResult.kind !== expectedType.kind) {
              coerceType(ctx, fctx, argResult, expectedType);
            }
          }
          if (paramTypes && args.length + 1 < paramTypes.length) {
            for (let pi = args.length + 1; pi < paramTypes.length; pi++) {
              const pt = paramTypes[pi]!;
              if (pt.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
              else if (pt.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
              else if (pt.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
            }
          }
          fctx.body.push({ op: "call", funcIdx });
          const returnsBool = methodName === "includes" || methodName === "startsWith" || methodName === "endsWith";
          return returnsBool
            ? { kind: "i32" }
            : methodName === "indexOf" || methodName === "lastIndexOf" || methodName === "search"
              ? { kind: "f64" }
              : { kind: "externref" };
        }
      }

      // Try number method: number.toString(), number.toFixed(), toPrecision(), toExponential()
      if (
        isNumberType(receiverType) &&
        (methodName === "toString" ||
          methodName === "toFixed" ||
          methodName === "toPrecision" ||
          methodName === "toExponential")
      ) {
        // RangeError validation for toString(radix) — radix must be integer 2-36
        if (methodName === "toString" && expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
          // Floor the radix (ToInteger semantics)
          fctx.body.push({ op: "f64.floor" });
          const radixLocal = allocLocal(fctx, `__radix_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: radixLocal });
          fctx.body.push({ op: "f64.const", value: 2 });
          fctx.body.push({ op: "f64.lt" });
          fctx.body.push({ op: "local.get", index: radixLocal });
          fctx.body.push({ op: "f64.const", value: 36 });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
          // Check radix is NaN (NaN != NaN)
          fctx.body.push({ op: "local.get", index: radixLocal });
          fctx.body.push({ op: "local.get", index: radixLocal });
          fctx.body.push({ op: "f64.ne" });
          fctx.body.push({ op: "i32.or" });
          {
            const rangeErrMsg = "RangeError: toString() radix must be between 2 and 36";
            addStringConstantGlobal(ctx, rangeErrMsg);
            const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
            const tagIdx = ensureExnTag(ctx);
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "global.get", index: strIdx } as Instr, { op: "throw", tagIdx } as Instr],
              else: [],
            });
          }
          // radix was consumed by the validation comparisons above (via local.tee),
          // no extra drop needed
        }
        const exprType = compileExpression(ctx, fctx, elemAccess.expression);
        if (exprType && exprType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        }
        if (methodName === "toFixed" && expr.arguments.length > 0) {
          // ToNumber funnel — Symbol args must throw TypeError (#1564).
          coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
          // RangeError: fractionDigits must be 0-100
          const digitsLocal = allocLocal(fctx, `__toFixed_digits_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: digitsLocal });
          fctx.body.push({ op: "f64.const", value: 0 });
          fctx.body.push({ op: "f64.lt" });
          fctx.body.push({ op: "local.get", index: digitsLocal });
          fctx.body.push({ op: "f64.const", value: 100 });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
          {
            const rangeErrMsg = "RangeError: toFixed() digits argument must be between 0 and 100";
            addStringConstantGlobal(ctx, rangeErrMsg);
            const strIdx = ctx.stringGlobalMap.get(rangeErrMsg)!;
            const tagIdx = ensureExnTag(ctx);
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "global.get", index: strIdx } as Instr, { op: "throw", tagIdx } as Instr],
              else: [],
            });
          }
          fctx.body.push({ op: "local.get", index: digitsLocal });
        } else if (methodName === "toFixed") {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        if (methodName === "toPrecision" && expr.arguments.length > 0) {
          // ToNumber funnel — Symbol args must throw TypeError (#1564).
          coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
          // (#49) See `number.toPrecision` site above — the precision
          // range check was moved into the runtime helper because per
          // spec §21.1.3.5 step 4, non-finite receivers must return
          // Number::toString(x) BEFORE the range check fires.
        } else if (methodName === "toPrecision") {
          // No argument → same as toString()
          const funcIdx = ctx.funcMap.get("number_toString");
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "externref" };
          }
        }
        if (methodName === "toExponential" && expr.arguments.length > 0) {
          // ToNumber funnel — Symbol args must throw TypeError (#1564).
          coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
          // (#49) See `number.toExponential` site above — the
          // fractionDigits range check was moved into the runtime
          // helper because per spec §21.1.3.3 step 3, non-finite
          // receivers must return Number::toString(x) BEFORE the
          // range check fires. Removing the codegen pre-check lets
          // `(NaN).toExponential(101)` return "NaN" as the spec
          // requires.
        } else if (methodName === "toExponential") {
          // No argument → pass NaN sentinel
          fctx.body.push({ op: "f64.const", value: NaN });
        }
        const funcName =
          methodName === "toFixed"
            ? "number_toFixed"
            : methodName === "toPrecision"
              ? "number_toPrecision"
              : methodName === "toExponential"
                ? "number_toExponential"
                : "number_toString";
        const funcIdx = ctx.funcMap.get(funcName);
        if (funcIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }

      // Try array method calls
      {
        const arrMethodResult = compileArrayMethodCall(ctx, fctx, elemAccess, expr, receiverType, methodName);
        if (arrMethodResult !== undefined) return arrMethodResult;
      }

      // ELEM ACCESS RESOLVED, NO METHOD MATCHED — try callable element type
      // (#1306). Covers `fns[0](args)` and `fns[ConstKey](args)` where
      // `fns` is an array (or other element-access-able value) of callables.
      {
        const cea = compileCallableElementAccessCall(ctx, fctx, expr, elemAccess);
        if (cea !== undefined) return cea;
      }

      // Fallback for resolved element access calls that didn't match any known method:
      // compile receiver, discard; compile each argument for side effects; return externref.
      {
        const recvType = compileExpression(ctx, fctx, elemAccess.expression);
        if (recvType) {
          fctx.body.push({ op: "drop" });
        }
        for (const arg of expr.arguments) {
          const argType = compileExpression(ctx, fctx, arg);
          if (argType) {
            fctx.body.push({ op: "drop" });
          }
        }
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
    }

    // ELEM ACCESS UNRESOLVED — try callable element type (#1306) before
    // falling through to the drop-everything path. Covers
    // `mws[idx](c, next)` where `idx` is a runtime variable.
    {
      const cea = compileCallableElementAccessCall(ctx, fctx, expr, elemAccess);
      if (cea !== undefined) return cea;
    }

    // Fallback for element access calls where the key couldn't be resolved statically:
    // compile receiver + index expression + arguments for side effects; return externref.
    {
      const recvType = compileExpression(ctx, fctx, elemAccess.expression);
      if (recvType) {
        fctx.body.push({ op: "drop" });
      }
      if (argExpr) {
        const keyType = compileExpression(ctx, fctx, argExpr);
        if (keyType) {
          fctx.body.push({ op: "drop" });
        }
      }
      for (const arg of expr.arguments) {
        const argType = compileExpression(ctx, fctx, arg);
        if (argType) {
          fctx.body.push({ op: "drop" });
        }
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
  }

  // Handle fn.bind(thisArg, ...partialArgs)(...remainingArgs) — immediate bind+call
  // Transform to fn(...partialArgs, ...remainingArgs), dropping thisArg.
  // (#1337) Also accept the equivalent Function.prototype.bind.call(fn, thisArg, ...) form
  // by reshaping bindCall to the method form before pattern-matching.
  if (ts.isCallExpression(expr.expression)) {
    let bindCall = expr.expression;
    if (
      ts.isPropertyAccessExpression(bindCall.expression) &&
      bindCall.expression.name.text === "call" &&
      ts.isPropertyAccessExpression(bindCall.expression.expression) &&
      bindCall.expression.expression.name.text === "bind" &&
      ts.isPropertyAccessExpression(bindCall.expression.expression.expression) &&
      bindCall.expression.expression.expression.name.text === "prototype" &&
      ts.isIdentifier(bindCall.expression.expression.expression.expression) &&
      bindCall.expression.expression.expression.expression.text === "Function" &&
      bindCall.arguments.length >= 1
    ) {
      const fnExpr = bindCall.arguments[0]!;
      const reshapedArgs = bindCall.arguments.slice(1);
      const reshapedProp = ts.factory.createPropertyAccessExpression(fnExpr as ts.LeftHandSideExpression, "bind");
      ts.setTextRange(reshapedProp, bindCall.expression);
      const reshapedInner = ts.factory.createCallExpression(reshapedProp, undefined, reshapedArgs);
      ts.setTextRange(reshapedInner, bindCall);
      (reshapedInner as any).parent = expr;
      bindCall = reshapedInner;
    }
    if (ts.isPropertyAccessExpression(bindCall.expression) && bindCall.expression.name.text === "bind") {
      const bindTarget = bindCall.expression.expression;

      // Case: identifier.bind(thisArg, ...partialArgs)(...args)
      if (ts.isIdentifier(bindTarget)) {
        const funcName = bindTarget.text;
        const closureInfo = ctx.closureMap.get(funcName);
        const funcIdx = ctx.funcMap.get(funcName);

        if (closureInfo || funcIdx !== undefined) {
          // Evaluate and drop thisArg (first bind argument) for side effects
          if (bindCall.arguments.length > 0) {
            const thisType = compileExpression(ctx, fctx, bindCall.arguments[0]!);
            if (thisType) {
              fctx.body.push({ op: "drop" });
            }
          }

          // Collect all effective arguments: partial args from bind + remaining args from outer call
          const partialArgs = bindCall.arguments.length > 1 ? Array.from(bindCall.arguments).slice(1) : [];
          const allArgs = [...partialArgs, ...Array.from(expr.arguments)];

          if (closureInfo) {
            const syntheticCall = ts.factory.createCallExpression(
              bindTarget,
              undefined,
              allArgs as unknown as readonly ts.Expression[],
            );
            (syntheticCall as any).parent = expr.parent;
            return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
          }

          // Regular function call
          const paramTypes = getFuncParamTypes(ctx, funcIdx!);
          for (let i = 0; i < allArgs.length; i++) {
            compileExpression(ctx, fctx, allArgs[i]!, paramTypes?.[i]);
          }

          // Supply defaults for missing optional params
          const optInfo = ctx.funcOptionalParams.get(funcName);
          if (optInfo) {
            for (const opt of optInfo) {
              if (opt.index >= allArgs.length) {
                pushParamSentinel(fctx, opt.type, ctx, opt);
              }
            }
          }

          // Pad remaining missing params
          if (paramTypes) {
            const optFilledCount = optInfo ? optInfo.filter((o) => o.index >= allArgs.length).length : 0;
            const totalPushed = allArgs.length + optFilledCount;
            for (let i = totalPushed; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }

          const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
          maybeSetArgcForKnownCall(
            ctx,
            fctx,
            funcName,
            allArgs.length,
            getFuncParamTypes(ctx, finalFuncIdx)?.length ?? allArgs.length,
          );
          fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalFuncIdx) ?? resolveWasmType(ctx, retType);
          }
          return getWasmFuncReturnType(ctx, finalFuncIdx) ?? { kind: "f64" };
        }
      }

      // Case: obj.method.bind(thisArg)(...args) — method call with different receiver
      if (ts.isPropertyAccessExpression(bindTarget)) {
        const methodName = bindTarget.name.text;
        const objExpr = bindTarget.expression;
        const objType = ctx.checker.getTypeAtLocation(objExpr);

        let className = objType.getSymbol()?.name;
        if (className && !ctx.classSet.has(className)) {
          className = ctx.classExprNameMap.get(className) ?? className;
        }
        if (!className || !ctx.classSet.has(className)) {
          className = resolveStructName(ctx, objType) ?? undefined;
        }

        if (className && (ctx.classSet.has(className) || ctx.funcMap.has(`${className}_${methodName}`))) {
          const fullName = `${className}_${methodName}`;
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined && bindCall.arguments.length > 0) {
            // First bind argument is the thisArg (receiver)
            compileExpression(ctx, fctx, bindCall.arguments[0]!);

            // Remaining bind args + outer call args
            const partialArgs = bindCall.arguments.length > 1 ? Array.from(bindCall.arguments).slice(1) : [];
            const allArgs = [...partialArgs, ...Array.from(expr.arguments)];

            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            // User-visible param count excludes self (param 0)
            const bindParamCount = paramTypes ? paramTypes.length - 1 : allArgs.length;
            for (let i = 0; i < allArgs.length; i++) {
              if (i < bindParamCount) {
                compileExpression(ctx, fctx, allArgs[i]!, paramTypes?.[i + 1]);
              } else {
                // Extra argument beyond method's parameter count — evaluate for
                // side effects (JS semantics) and discard the result
                const extraType = compileExpression(ctx, fctx, allArgs[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
            // Pad missing arguments with defaults (skip self at index 0)
            if (paramTypes) {
              for (let i = allArgs.length + 1; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!, ctx);
              }
            }

            const finalCallIdx = ctx.funcMap.get(fullName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalCallIdx });

            const sig = ctx.checker.getResolvedSignature(expr);
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
              if (wasmFuncReturnsVoid(ctx, finalCallIdx)) return VOID_RESULT;
              return getWasmFuncReturnType(ctx, finalCallIdx) ?? resolveWasmType(ctx, retType);
            }
            return VOID_RESULT;
          }
        }
      }
    }
  }

  // Handle CallExpression as callee: fn()(), makeAdder(10)(32), etc.
  // The inner call returns a closure struct (possibly coerced to externref),
  // and we need to call the returned closure with the outer arguments.
  if (ts.isCallExpression(expr.expression)) {
    // Get the TS type of the inner call result — should be a callable type
    const innerResultTsType = ctx.checker.getTypeAtLocation(expr.expression);
    let callSigs = innerResultTsType.getCallSignatures?.();
    if (!callSigs || callSigs.length === 0) {
      // (#1298) Strip nullable members for callees like `Map<K, Fn>.get(...)`
      // whose return type is `Fn | undefined`. Storage is externref either way.
      const nonNull = ctx.checker.getNonNullableType(innerResultTsType);
      callSigs = nonNull.getCallSignatures?.();
    }

    if (callSigs && callSigs.length > 0) {
      const sig = callSigs[0]!;

      // Find matching closure info by comparing param types and return type
      // against all registered closure types
      let matchedClosureInfo: ClosureInfo | undefined;
      let matchedStructTypeIdx: number | undefined;

      const sigParamCount = sig.parameters.length;
      const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
      const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
      const sigParamWasmTypes: ValType[] = [];
      for (let i = 0; i < sigParamCount; i++) {
        const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
        sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
      }

      for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
        if (info.paramTypes.length !== sigParamCount) continue;
        // Check return type match
        if (sigRetWasm === null && info.returnType !== null) continue;
        if (sigRetWasm !== null && info.returnType === null) continue;
        if (sigRetWasm !== null && info.returnType !== null && sigRetWasm.kind !== info.returnType.kind) continue;
        // Check param types match
        let paramsMatch = true;
        for (let i = 0; i < sigParamCount; i++) {
          if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
            paramsMatch = false;
            break;
          }
        }
        if (paramsMatch) {
          matchedClosureInfo = info;
          matchedStructTypeIdx = typeIdx;
          break;
        }
      }

      if (matchedClosureInfo && matchedStructTypeIdx !== undefined) {
        // Compile the inner call expression to get the closure on the stack
        const innerResultType = compileExpression(ctx, fctx, expr.expression);

        // Save closure ref to a local so we can extract both args and funcref
        let closureLocal: number;
        if (innerResultType?.kind === "externref") {
          // Need to convert externref back to the closure struct ref (guarded)
          const closureRefType: ValType = {
            kind: "ref_null",
            typeIdx: matchedStructTypeIdx,
          };
          closureLocal = allocLocal(fctx, `__call_ret_${fctx.locals.length}`, closureRefType);
          fctx.body.push({ op: "any.convert_extern" });
          emitGuardedRefCast(fctx, matchedStructTypeIdx);
          fctx.body.push({ op: "local.set", index: closureLocal });
        } else {
          const closureRefType: ValType = innerResultType ?? {
            kind: "ref",
            typeIdx: matchedStructTypeIdx,
          };
          closureLocal = allocLocal(fctx, `__call_ret_${fctx.locals.length}`, closureRefType);
          fctx.body.push({ op: "local.set", index: closureLocal });
        }

        // Push closure ref as first arg (self param) — null-check → TypeError (#728)
        fctx.body.push({ op: "local.get", index: closureLocal });
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });

        // Push call arguments (only up to declared param count)
        const crParamCnt = matchedClosureInfo.paramTypes.length;
        // biome-ignore lint/complexity/noUselessLoneBlockStatements: groups arg-emit + extras-pack as one logical unit
        {
          for (let i = 0; i < Math.min(expr.arguments.length, crParamCnt); i++) {
            compileExpression(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
          }
        }

        // Pad missing arguments with defaults
        for (let i = expr.arguments.length; i < crParamCnt; i++) {
          pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!, ctx);
        }

        // (#1511) For indirect calls we cannot know whether the lifted target
        // reads `arguments`; pack any overflow args into `__extras_argv` and
        // set `__argc` so a callee that DOES read `arguments` sees the full
        // call-site length. Overflow args are NOT pushed to the wasm stack —
        // they live in the global. Cleanup happens after call_ref.
        emitClosureCallArgcExtras(ctx, fctx, expr.arguments, crParamCnt);

        // Push the funcref from the closure struct (field 0) — null-check → TypeError (#728)
        fctx.body.push({ op: "local.get", index: closureLocal });
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });
        fctx.body.push({
          op: "struct.get",
          typeIdx: matchedStructTypeIdx,
          fieldIdx: 0,
        });
        // Guard funcref cast to avoid illegal cast (#778)
        emitGuardedFuncRefCast(fctx, matchedClosureInfo.funcTypeIdx);
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });

        // call_ref with the lifted function's type index
        fctx.body.push({
          op: "call_ref",
          typeIdx: matchedClosureInfo.funcTypeIdx,
        });

        // (#1511) Reset __argc / __extras_argv. A callee that doesn't read
        // `arguments` never consumed them and would otherwise leak stale
        // values into the next call.
        if (matchedClosureInfo.returnType === null) {
          emitResetArgcExtras(ctx, fctx);
        } else {
          const _retLocal = allocLocal(fctx, `__cr_ret_${fctx.locals.length}`, matchedClosureInfo.returnType);
          fctx.body.push({ op: "local.set", index: _retLocal });
          emitResetArgcExtras(ctx, fctx);
          fctx.body.push({ op: "local.get", index: _retLocal });
        }

        // Return VOID_RESULT for void closures so compileExpression doesn't
        // treat the null return as a compilation failure and roll back instructions
        return matchedClosureInfo.returnType ?? VOID_RESULT;
      }
    }
  }

  // Handle ConditionalExpression as callee (not wrapped in parens):
  // (cond ? fn1 : fn2)(args) — handled directly
  if (ts.isConditionalExpression(expr.expression)) {
    return compileConditionalCallee(ctx, fctx, expr, expr.expression);
  }

  // (#1298 fix #3) Generic fallback: ref.test-guarded closure dispatch.
  //
  // For callees whose TS type carries a call signature, eagerly resolve the
  // wrapper struct/funcref pair via getOrCreateFuncRefWrapperTypes so the
  // dispatch is order-independent. Then gate the actual cast + call_ref on a
  // RUNTIME `ref.test (ref $__fn_wrap_N)`:
  //   - then branch (ref.test == 1): the value really is a wasm closure of
  //     this signature shape — cast + dispatch.
  //   - else branch (ref.test == 0): host function ref, foreign externref,
  //     null, or wasm closure of a different shape — fall back to the
  //     graceful `ref.null.extern` semantics that the pre-rewrite scan-only
  //     fallback used at this site.
  //
  // This avoids the v1 (PR #223) regression cluster (340 null_derefs in
  // Temporal/* etc.): the v1 path committed unconditionally to the wasm
  // closure dispatch and the first `emitNullCheckThrow` after a failed cast
  // turned the graceful-null exit into a TypeError.
  //
  // Args are evaluated into locals BEFORE the ref.test so the else branch
  // doesn't have to re-evaluate them (preserves side-effect ordering).
  //
  // See plan/issues/sprints/50/1298-fn-typed-fields-call-drops.md
  // (`## Fix #3 — Safe reimplementation`) for the full design.
  {
    const calleeTsType = ctx.checker.getTypeAtLocation(expr.expression);
    let callSigs = calleeTsType.getCallSignatures?.();
    if (!callSigs || callSigs.length === 0) {
      // (#1298) Strip nullable members for `Fn | null | undefined` callees.
      const nonNull = ctx.checker.getNonNullableType(calleeTsType);
      callSigs = nonNull.getCallSignatures?.();
    }

    if (callSigs && callSigs.length > 0) {
      const sig = callSigs[0]!;

      const sigParamCount = sig.parameters.length;
      const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
      const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
      const sigParamWasmTypes: ValType[] = [];
      for (let i = 0; i < sigParamCount; i++) {
        const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
        sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
      }

      // (#1298 PR #231 fix) Look up an existing wrapper struct/funcref pair
      // for this signature WITHOUT registering a new one. The earlier draft
      // of fix #3 called `getOrCreateFuncRefWrapperTypes` here to get
      // order-independent dispatch, but registering a fresh wrapper struct
      // at this fallback site polluted `closureInfoByTypeIdx` with a struct
      // that wasn't actually used by any compiled closure. Downstream
      // funcref-candidate scans (e.g. the identifier-callable-param path's
      // multi-funcref dispatch at calls.ts:5106) then picked the unused
      // wrapper as a candidate, mismatching the closure that was actually
      // stored — `language/statements/function/S13_A18.js` reproduced this
      // as a null-deref inside a lifted closure body. Conservative fix:
      // only enter the dispatch path when a closure of this signature has
      // already been registered (the original scan-only behavior), and
      // gate THAT dispatch with ref.test. If no match, fall through to the
      // graceful tail at the end of compileCallExpression.
      let matchedClosureInfo: ClosureInfo | undefined;
      let matchedStructTypeIdx: number | undefined;
      for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
        if (info.paramTypes.length !== sigParamCount) continue;
        if (sigRetWasm === null && info.returnType !== null) continue;
        if (sigRetWasm !== null && info.returnType === null) continue;
        if (sigRetWasm !== null && info.returnType !== null && sigRetWasm.kind !== info.returnType.kind) continue;
        let paramsMatch = true;
        for (let i = 0; i < sigParamCount; i++) {
          if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
            paramsMatch = false;
            break;
          }
        }
        if (paramsMatch) {
          matchedClosureInfo = info;
          matchedStructTypeIdx = typeIdx;
          break;
        }
      }
      const wrapperTypes =
        matchedClosureInfo && matchedStructTypeIdx !== undefined
          ? {
              closureInfo: matchedClosureInfo,
              structTypeIdx: matchedStructTypeIdx,
              liftedFuncTypeIdx: matchedClosureInfo.funcTypeIdx,
            }
          : null;

      if (wrapperTypes) {
        const closureInfo = wrapperTypes.closureInfo;
        const structTypeIdx = wrapperTypes.structTypeIdx;
        const funcTypeIdx = closureInfo.funcTypeIdx;

        // 1. Compile the callee once. It must be a ref-shaped value (we can't
        //    `ref.test` an i32 / f64). For non-ref callees, drop value + args
        //    and emit graceful null directly.
        const innerResultType = compileExpression(ctx, fctx, expr.expression);

        const isRefShaped =
          innerResultType !== null &&
          (innerResultType.kind === "externref" ||
            innerResultType.kind === "ref" ||
            innerResultType.kind === "ref_null");

        if (!isRefShaped) {
          if (innerResultType !== null) {
            fctx.body.push({ op: "drop" });
          }
          for (const arg of expr.arguments) {
            const argType = compileExpression(ctx, fctx, arg);
            if (argType !== null) fctx.body.push({ op: "drop" });
          }
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }

        // 2. Save callee value to a local. Stash type matches the compiled
        //    callee shape so re-loading roundtrips losslessly.
        const calleeStashType: ValType = innerResultType.kind === "externref" ? { kind: "externref" } : innerResultType;
        const calleeLocal = allocLocal(fctx, `__cb_callee_${fctx.locals.length}`, calleeStashType);
        fctx.body.push({ op: "local.set", index: calleeLocal });

        // 3. Compile call args into locals so both branches can re-push them
        //    without re-evaluating side effects.
        const argLocals: Array<{ local: number; type: ValType }> = [];
        const ccParamCnt = closureInfo.paramTypes.length;
        for (let i = 0; i < Math.min(expr.arguments.length, ccParamCnt); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, closureInfo.paramTypes[i]);
          const argLocal = allocLocal(fctx, `__cb_carg_${fctx.locals.length}`, closureInfo.paramTypes[i]!);
          fctx.body.push({ op: "local.set", index: argLocal });
          argLocals.push({ local: argLocal, type: closureInfo.paramTypes[i]! });
        }
        // (#1511) Excess args: compile and save to externref locals so we can
        // pack them into __extras_argv inside the then branch without
        // re-running side effects.
        const extrasLocals: number[] = [];
        for (let i = ccParamCnt; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
          if (extraType === null) {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (extraType.kind === "f64") {
            const boxIdx = ctx.funcMap.get("__box_number");
            if (boxIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: boxIdx });
            } else {
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else if (extraType.kind === "i32") {
            fctx.body.push({ op: "f64.convert_i32_s" });
            const boxIdx = ctx.funcMap.get("__box_number");
            if (boxIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: boxIdx });
            } else {
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else if (extraType.kind === "ref" || extraType.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" } as Instr);
          }
          const extraLocal = allocLocal(fctx, `__cb_cextra_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: extraLocal });
          extrasLocals.push(extraLocal);
        }
        // Pad missing args. For non-nullable ref params widen to nullable so
        // `pushDefaultValue` emits a plain `ref.null` (no `ref.as_non_null`
        // trap). The lifted func sig accepts nullable refs, so the call_ref
        // type matches.
        for (let i = expr.arguments.length; i < ccParamCnt; i++) {
          const paramType = closureInfo.paramTypes[i]!;
          const padType: ValType =
            paramType.kind === "ref" ? { kind: "ref_null", typeIdx: paramType.typeIdx } : paramType;
          pushDefaultValue(fctx, padType, ctx);
          const argLocal = allocLocal(fctx, `__cb_cpad_${fctx.locals.length}`, padType);
          fctx.body.push({ op: "local.set", index: argLocal });
          argLocals.push({ local: argLocal, type: padType });
        }

        // 4. Emit the ref.test guard. Stack before the if: [i32].
        fctx.body.push({ op: "local.get", index: calleeLocal });
        if (innerResultType.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" });
        }
        fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });

        // 5. then branch — ref.test passed, do the dispatch.
        // (#1395 fix) Use pushBody/popBody so the saved body is tracked in
        // fctx.savedBodies. Without this, late-import index shifts via
        // `fixupModuleGlobalIndices` walking only `ctx.currentFunc.body` +
        // `savedBodies` would miss `global.get`/`global.set` instructions
        // that were emitted into the OUTER body before the swap. In
        // particular, `compileExpression(C.f)` at line 7436 above pushes
        // `global.get <staticPropIdx>` for a class static-field receiver
        // into the outer body; if a string-constant import then gets
        // added during dispatch compilation below (step 4b/5), the
        // shifter's threshold/delta would correctly bump the static-prop
        // map but skip the orphaned outer body, producing a stale index
        // that points at a sibling global (e.g. `__class_C` instead of
        // `__static_C_f`). Tests:
        // language/statements/class/elements/static-field-init-this-
        // inside-arrow-function.js (#1395 followup).
        const savedBody = pushBody(fctx);
        const thenInstrs = fctx.body;

        // Re-load callee + plain ref.cast (test already proved it succeeds).
        fctx.body.push({ op: "local.get", index: calleeLocal });
        if (innerResultType.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" });
        }
        fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx });
        const closureLocal = allocLocal(fctx, `__cb_closure_${fctx.locals.length}`, {
          kind: "ref",
          typeIdx: structTypeIdx,
        });
        fctx.body.push({ op: "local.set", index: closureLocal });

        // Push self (closure ref) + saved args.
        fctx.body.push({ op: "local.get", index: closureLocal });
        for (const al of argLocals) {
          fctx.body.push({ op: "local.get", index: al.local });
        }

        // (#1511) Set __extras_argv (from saved extras locals) and __argc so
        // the lifted callee can compute the correct arguments.length when it
        // reads `arguments`. Stack contributions are immediately consumed.
        if (extrasLocals.length > 0) {
          const { globalIdx: extrasGlobalIdx, vecTypeIdx: extrasVecTi } = ensureExtrasArgvGlobal(ctx);
          const extrasArrTi = getArrTypeIdxFromVec(ctx, extrasVecTi);
          for (const el of extrasLocals) {
            fctx.body.push({ op: "local.get", index: el });
          }
          fctx.body.push({ op: "array.new_fixed", typeIdx: extrasArrTi, length: extrasLocals.length } as Instr);
          const arrTmp = allocLocal(fctx, `__cb_extras_arr_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: extrasArrTi,
          });
          fctx.body.push({ op: "local.set", index: arrTmp });
          fctx.body.push({ op: "i32.const", value: extrasLocals.length });
          fctx.body.push({ op: "local.get", index: arrTmp });
          fctx.body.push({ op: "struct.new", typeIdx: extrasVecTi });
          fctx.body.push({ op: "global.set", index: extrasGlobalIdx } as Instr);
        }
        emitSetArgc(ctx, fctx, expr.arguments.length, ccParamCnt);

        // Push funcref from closure struct, guarded cast + null-check, call_ref.
        fctx.body.push({ op: "local.get", index: closureLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 0 });
        emitGuardedFuncRefCast(fctx, funcTypeIdx);
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: funcTypeIdx });
        fctx.body.push({ op: "call_ref", typeIdx: funcTypeIdx });

        // Coerce return value to externref so the if-block has a single
        // result type. For void closures, push ref.null.extern.
        if (closureInfo.returnType === null) {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (closureInfo.returnType.kind !== "externref") {
          coerceType(ctx, fctx, closureInfo.returnType, { kind: "externref" });
        }
        // (#1511) Reset argc/extras after the call. Return value (externref) is
        // on the stack at this point — save, reset, restore.
        {
          const _retL = allocLocal(fctx, `__cb_ret_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: _retL });
          emitResetArgcExtras(ctx, fctx);
          fctx.body.push({ op: "local.get", index: _retL });
        }

        // 6. else branch — graceful null.
        const elseInstrs: Instr[] = [{ op: "ref.null.extern" } as Instr];

        // 7. Restore body, emit the if/else.
        popBody(fctx, savedBody);
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: thenInstrs,
          else: elseInstrs,
        });

        return { kind: "externref" };
      }
    }
  }

  // Graceful fallback: compile the callee expression and all arguments for side effects,
  // then push ref.null.extern. This avoids hard compile errors for unrecognized call patterns
  // (e.g. chained calls, dynamic dispatch, uncommon AST shapes).
  {
    const calleeType = compileExpression(ctx, fctx, expr.expression);
    if (calleeType) {
      fctx.body.push({ op: "drop" });
    }
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
}

/**
 * Compile a call with a ConditionalExpression callee: (cond ? fn1 : fn2)(args)
 *
 * We compile the condition, then emit an if/else where each branch makes
 * the call with the respective callee.
 *
 * Cannot create synthetic CallExpression via ts.factory because it wraps
 * non-LeftHandSideExpression callees in ParenthesizedExpression, causing
 * infinite recursion with the paren-unwrapping handler above.
 */
function compileConditionalCallee(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  condExpr: ts.ConditionalExpression,
): InnerResult {
  // Compile condition
  const condType = compileExpression(ctx, fctx, condExpr.condition);
  if (!condType) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    ensureI32Condition(fctx, condType, ctx);
  }

  // Determine the expected return type of the call from the original expression
  const callSig = ctx.checker.getResolvedSignature(expr);
  let callRetType: ValType | null = null;
  if (callSig) {
    const retTsType = ctx.checker.getReturnTypeOfSignature(callSig);
    if (!isVoidType(retTsType)) {
      callRetType = resolveWasmType(ctx, retTsType);
    }
  }

  // Helper: compile a call branch by constructing the call inline
  // Uses the branch expression (whenTrue or whenFalse) as the callee.
  function compileBranchCall(branchExpr: ts.Expression): InnerResult {
    // If the branch is an identifier referencing a known function, call it directly
    if (ts.isIdentifier(branchExpr)) {
      const funcName = branchExpr.text;
      let closureInfo = ctx.closureMap.get(funcName);
      if (!closureInfo) {
        closureInfo = resolveClosureInfoFromLocal(ctx, fctx, funcName);
      }
      if (closureInfo) {
        // Use the original expr's arguments but with this identifier as callee
        // Create a minimal synthetic object that mimics a CallExpression
        // for compileClosureCall
        const syntheticCall = Object.create(expr);
        syntheticCall.expression = branchExpr;
        return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
      }
      const funcIdx = ctx.funcMap.get(funcName);
      if (funcIdx !== undefined) {
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const ccParamCount = paramTypes ? paramTypes.length : expr.arguments.length;
        for (let i = 0; i < expr.arguments.length; i++) {
          if (i < ccParamCount) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
          } else {
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null) {
              fctx.body.push({ op: "drop" });
            }
          }
        }
        // Pad missing arguments with defaults
        if (paramTypes) {
          for (let i = expr.arguments.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx;
        maybeSetArgcForKnownCall(ctx, fctx, funcName, expr.arguments.length, ccParamCount);
        fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
        if (callRetType) return callRetType;
        // Try to determine return type from the branch function's signature
        const branchType = ctx.checker.getTypeAtLocation(branchExpr);
        const branchSigs = branchType.getCallSignatures?.();
        if (branchSigs && branchSigs.length > 0) {
          const retType = ctx.checker.getReturnTypeOfSignature(branchSigs[0]!);
          if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
          if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
          return getWasmFuncReturnType(ctx, finalFuncIdx) ?? resolveWasmType(ctx, retType);
        }
        return callRetType ?? getWasmFuncReturnType(ctx, finalFuncIdx) ?? { kind: "f64" };
      }
    }

    // If the branch is itself a conditional, recurse
    if (ts.isConditionalExpression(branchExpr)) {
      return compileConditionalCallee(ctx, fctx, expr, branchExpr);
    }

    // If the branch is wrapped in parens, unwrap
    if (ts.isParenthesizedExpression(branchExpr)) {
      let inner: ts.Expression = branchExpr;
      while (ts.isParenthesizedExpression(inner)) {
        inner = inner.expression;
      }
      return compileBranchCall(inner);
    }

    // If the branch is a property access, try method call
    if (ts.isPropertyAccessExpression(branchExpr)) {
      // Create a synthetic call with the property access as callee
      // PropertyAccessExpression IS a LeftHandSideExpression so no infinite recursion
      const syntheticCall = ts.factory.createCallExpression(branchExpr, expr.typeArguments, expr.arguments);
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }

    // Fallback: compile expression value and try to use as closure call
    const calleeType = compileExpression(ctx, fctx, branchExpr);
    if (calleeType) {
      fctx.body.push({ op: "drop" });
    }
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
    }
    if (callRetType) {
      pushDefaultValue(fctx, callRetType, ctx);
      return callRetType;
    }
    fctx.body.push({ op: "f64.const", value: 0 });
    return { kind: "f64" };
  }

  // Compile then-branch call
  const savedBody = fctx.body;
  fctx.body = [];
  const thenType = compileBranchCall(condExpr.whenTrue);
  let thenInstrs = fctx.body;

  // Compile else-branch call
  fctx.body = [];
  const elseType = compileBranchCall(condExpr.whenFalse);
  let elseInstrs = fctx.body;

  fctx.body = savedBody;

  // Determine result type
  if (thenType === VOID_RESULT && elseType === VOID_RESULT) {
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenInstrs,
      else: elseInstrs,
    });
    return VOID_RESULT;
  }

  // Coerce branches to a common type
  const thenVal: ValType = thenType && thenType !== VOID_RESULT ? thenType : (callRetType ?? { kind: "f64" });
  const elseVal: ValType = elseType && elseType !== VOID_RESULT ? elseType : (callRetType ?? { kind: "f64" });
  let resultType: ValType = callRetType ?? thenVal;

  // If types don't match, coerce both to the result type
  if (thenVal.kind !== resultType.kind) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, thenVal, resultType);
    fctx.body = savedBody;
    thenInstrs = [...thenInstrs, ...coerceBody];
  }
  if (elseVal.kind !== resultType.kind) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, elseVal, resultType);
    fctx.body = savedBody;
    elseInstrs = [...elseInstrs, ...coerceBody];
  }

  // Handle void branches that need to produce a value
  if (thenType === VOID_RESULT || thenType === null) {
    thenInstrs = [...thenInstrs, ...defaultValueInstrs(resultType)];
  }
  if (elseType === VOID_RESULT || elseType === null) {
    elseInstrs = [...elseInstrs, ...defaultValueInstrs(resultType)];
  }

  // Widen ref to ref_null when a branch uses defaultValueInstrs (which produces ref.null)
  if (
    resultType.kind === "ref" &&
    (thenType === VOID_RESULT || thenType === null || elseType === VOID_RESULT || elseType === null)
  ) {
    resultType = { kind: "ref_null", typeIdx: (resultType as any).typeIdx };
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });
  return resultType;
}

/**
 * Compile a call where the callee is an arbitrary expression that is not a
 * LeftHandSideExpression (e.g. assignment: `(x = fn)()`, logical: `(a || fn)()`).
 *
 * We cannot use ts.factory.createCallExpression for these because it wraps
 * non-LeftHandSideExpression callees in ParenthesizedExpression, causing
 * infinite recursion with the paren-unwrapping handler.
 *
 * Strategy: compile the callee expression to get its value on the stack,
 * then try to use the result as a closure call (closure-matching by type),
 * or as a direct function call if the expression resolves to a known function.
 */
function compileExpressionCallee(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  calleeExpr: ts.Expression,
): InnerResult {
  // For assignment expressions, we can look at the RHS to identify the function
  // being called, while still compiling the full assignment for side effects.
  if (
    ts.isBinaryExpression(calleeExpr) &&
    calleeExpr.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    calleeExpr.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    calleeExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    // For simple assignment (x = fn)(), compile the assignment for side effects
    // then call the RHS function directly if it's identifiable.
    const rhs = calleeExpr.right;
    if (ts.isIdentifier(rhs)) {
      const funcIdx = ctx.funcMap.get(rhs.text);
      const closureInfo = ctx.closureMap.get(rhs.text);
      if (funcIdx !== undefined || closureInfo) {
        // Compile the full assignment for side effects (stores value in LHS)
        const assignResult = compileExpression(ctx, fctx, calleeExpr);
        if (assignResult) {
          fctx.body.push({ op: "drop" });
        }
        // Now make a direct call using the RHS identifier as callee
        const syntheticCall = ts.factory.createCallExpression(rhs, expr.typeArguments, expr.arguments);
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
      }
    }
  }

  // Generic path: compile the callee expression and try closure-matching
  const calleeTsType = ctx.checker.getTypeAtLocation(calleeExpr);
  const callSigs = calleeTsType.getCallSignatures?.();

  if (callSigs && callSigs.length > 0) {
    const sig = callSigs[0]!;

    // Look for a matching closure type
    const sigParamCount = sig.parameters.length;
    const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
    const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
    const sigParamWasmTypes: ValType[] = [];
    for (let i = 0; i < sigParamCount; i++) {
      const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
      sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
    }

    let matchedClosureInfo: ClosureInfo | undefined;
    let matchedStructTypeIdx: number | undefined;

    for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
      if (info.paramTypes.length !== sigParamCount) continue;
      if (sigRetWasm === null && info.returnType !== null) continue;
      if (sigRetWasm !== null && info.returnType === null) continue;
      if (sigRetWasm !== null && info.returnType !== null && sigRetWasm.kind !== info.returnType.kind) continue;
      let paramsMatch = true;
      for (let i = 0; i < sigParamCount; i++) {
        if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
          paramsMatch = false;
          break;
        }
      }
      if (paramsMatch) {
        matchedClosureInfo = info;
        matchedStructTypeIdx = typeIdx;
        break;
      }
    }

    if (matchedClosureInfo && matchedStructTypeIdx !== undefined) {
      // Compile the callee expression to get the closure on the stack
      const innerResultType = compileExpression(ctx, fctx, calleeExpr);

      // Save closure ref to a local
      let closureLocal: number;
      if (innerResultType?.kind === "externref") {
        const closureRefType: ValType = {
          kind: "ref_null",
          typeIdx: matchedStructTypeIdx,
        };
        closureLocal = allocLocal(fctx, `__expr_call_${fctx.locals.length}`, closureRefType);
        fctx.body.push({ op: "any.convert_extern" });
        emitGuardedRefCast(fctx, matchedStructTypeIdx);
        fctx.body.push({ op: "local.set", index: closureLocal });
      } else {
        const closureRefType: ValType = innerResultType ?? {
          kind: "ref",
          typeIdx: matchedStructTypeIdx,
        };
        closureLocal = allocLocal(fctx, `__expr_call_${fctx.locals.length}`, closureRefType);
        fctx.body.push({ op: "local.set", index: closureLocal });
      }

      // Push closure ref as first arg (self param) — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });

      // Push call arguments (only up to declared param count)
      const ecParamCnt = matchedClosureInfo.paramTypes.length;
      // biome-ignore lint/complexity/noUselessLoneBlockStatements: groups arg-emit + extras-pack as one logical unit
      {
        for (let i = 0; i < Math.min(expr.arguments.length, ecParamCnt); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
        }
      }

      // Pad missing arguments
      for (let i = expr.arguments.length; i < ecParamCnt; i++) {
        pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!, ctx);
      }

      // (#1511) Indirect call — propagate overflow args via __extras_argv so
      // a callee reading `arguments` gets the correct length.
      emitClosureCallArgcExtras(ctx, fctx, expr.arguments, ecParamCnt);

      // Push the funcref from closure struct and call_ref — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedStructTypeIdx });
      fctx.body.push({
        op: "struct.get",
        typeIdx: matchedStructTypeIdx,
        fieldIdx: 0,
      });
      // Guard funcref cast to avoid illegal cast (#778)
      emitGuardedFuncRefCast(fctx, matchedClosureInfo.funcTypeIdx);
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });
      fctx.body.push({
        op: "call_ref",
        typeIdx: matchedClosureInfo.funcTypeIdx,
      });

      // (#1511) Cleanup
      if (matchedClosureInfo.returnType === null) {
        emitResetArgcExtras(ctx, fctx);
      } else {
        const _retLocal = allocLocal(fctx, `__ec_ret_${fctx.locals.length}`, matchedClosureInfo.returnType);
        fctx.body.push({ op: "local.set", index: _retLocal });
        emitResetArgcExtras(ctx, fctx);
        fctx.body.push({ op: "local.get", index: _retLocal });
      }

      return matchedClosureInfo.returnType ?? VOID_RESULT;
    }
  }

  // Last resort: compile the callee for side effects and try to resolve
  // the call via the RHS of an assignment or the last operand
  if (ts.isBinaryExpression(calleeExpr)) {
    const assignResult = compileExpression(ctx, fctx, calleeExpr);
    if (assignResult) {
      fctx.body.push({ op: "drop" });
    }
    // Try calling the RHS (for assignment) or right operand (for logical)
    const rhs = calleeExpr.right;
    if (ts.isIdentifier(rhs) || ts.isPropertyAccessExpression(rhs)) {
      const syntheticCall = ts.factory.createCallExpression(
        rhs as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Graceful fallback for non-LHSE callee: compile callee and args for side effects,
  // return externref null. Avoids hard compile errors for uncommon callee shapes.
  {
    const calleeType = compileExpression(ctx, fctx, calleeExpr);
    if (calleeType) {
      fctx.body.push({ op: "drop" });
    }
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
}

/**
 * Compile an IIFE (Immediately Invoked Function Expression):
 *   (function(params) { body })(args)
 *
 * Strategy: compile the function expression as a named module-level function
 * with a unique synthetic name, then emit a direct call to it.
 * Captures from the enclosing scope are passed as extra leading parameters.
 *
 * Returns undefined if the expression is not an IIFE pattern.
 */
function compileIIFE(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): InnerResult | undefined {
  // Unwrap parenthesized expression to find the function expression
  let callee: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(callee)) {
    callee = callee.expression;
  }
  if (!ts.isFunctionExpression(callee) && !ts.isArrowFunction(callee)) {
    return undefined; // not an IIFE
  }
  // Generator function expressions (function*) cannot be inlined as IIFEs
  // because their body uses `yield` which requires a generator FunctionContext (#657).
  if (ts.isFunctionExpression(callee) && callee.asteriskToken !== undefined) {
    return undefined;
  }
  const funcExpr = callee as ts.FunctionExpression | ts.ArrowFunction;

  // Determine parameter types from the function's declared parameters
  const paramTypes: ValType[] = [];
  for (const p of funcExpr.parameters) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    paramTypes.push(resolveWasmType(ctx, paramType));
  }

  // Determine return type
  const sig = ctx.checker.getSignatureFromDeclaration(funcExpr);
  let returnType: ValType | null = null;
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) {
      returnType = resolveWasmType(ctx, retType);
    }
  }

  // Analyze captured variables from the enclosing scope
  const body = funcExpr.body;
  const referencedNames = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectReferencedIdentifiers(stmt, referencedNames);
    }
  } else {
    collectReferencedIdentifiers(body, referencedNames);
  }

  // Detect which captured variables are written inside the IIFE body
  const writtenInIIFE = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectWrittenIdentifiers(stmt, writtenInIIFE);
    }
  } else {
    collectWrittenIdentifiers(body, writtenInIIFE);
  }

  const ownParamNames = new Set(
    funcExpr.parameters.filter((p) => ts.isIdentifier(p.name)).map((p) => (p.name as ts.Identifier).text),
  );

  const captures: {
    name: string;
    type: ValType;
    localIdx: number;
    mutable: boolean;
  }[] = [];
  for (const name of referencedNames) {
    if (ownParamNames.has(name)) continue;
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    const type =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" });
    const isMutable = writtenInIIFE.has(name);
    captures.push({ name, type, localIdx, mutable: isMutable });
  }

  // Generate a unique name for the IIFE
  const iifeName = `__iife_${ctx.closureCounter++}`;
  const results: ValType[] = returnType ? [returnType] : [];

  // Build parameter types: for mutable captures use ref cells, others pass by value
  // Use ref_null for ref types to allow null default initialization (var hoisting)
  const captureParamTypes = captures.map((c) => {
    if (c.mutable) {
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, c.type);
      return { kind: "ref_null" as const, typeIdx: refCellTypeIdx };
    }
    // Widen ref to ref_null so hoisted vars initialized to null can be passed
    if (c.type.kind === "ref") {
      return {
        kind: "ref_null" as const,
        typeIdx: (c.type as { typeIdx: number }).typeIdx,
      };
    }
    return c.type;
  });
  const allParamTypes = [...captureParamTypes, ...paramTypes];
  const funcTypeIdx = addFuncType(ctx, allParamTypes, results, `${iifeName}_type`);

  const liftedFctx: FunctionContext = {
    name: iifeName,
    params: [
      ...captures.map((c, i) => ({
        name: c.name,
        type: captureParamTypes[i]!,
      })),
      ...funcExpr.parameters.map((p, i) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: paramTypes[i] ?? ({ kind: "f64" } as ValType),
      })),
    ],
    locals: [],
    localMap: new Map(),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }

  // For mutable captures, register them as boxed so read/write uses struct.get/set.
  // Also register non-mutable captures that are already boxed in the outer scope.
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    if (cap.mutable) {
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, {
        refCellTypeIdx,
        valType: cap.type,
      });
    } else {
      const outerBoxed = fctx.boxedCaptures?.get(cap.name);
      if (outerBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
        if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
        liftedFctx.boxedCaptures.set(cap.name, {
          refCellTypeIdx: outerBoxed.refCellTypeIdx,
          valType: outerBoxed.valType,
        });
      }
    }
  }

  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = liftedFctx;

  if (ts.isBlock(body)) {
    // Hoist var declarations and let/const with TDZ flags (#790)
    hoistVarDeclarations(ctx, liftedFctx, body.statements);
    hoistLetConstWithTdz(ctx, liftedFctx, body.statements);
    hoistFunctionDeclarations(ctx, liftedFctx, body.statements);
    for (const stmt of body.statements) {
      compileStatement(ctx, liftedFctx, stmt);
    }
  } else {
    // Concise arrow body — expression is the return value
    const exprType = compileExpression(ctx, liftedFctx, body);
    if (exprType === null && returnType) {
      // Push default return value
      if (returnType.kind === "f64") liftedFctx.body.push({ op: "f64.const", value: 0 });
      else if (returnType.kind === "i32") liftedFctx.body.push({ op: "i32.const", value: 0 });
      else if (returnType.kind === "externref") liftedFctx.body.push({ op: "ref.null.extern" });
    }
  }

  // Append default return if needed
  if (returnType) {
    const lastInstr = liftedFctx.body[liftedFctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      if (returnType.kind === "f64") liftedFctx.body.push({ op: "f64.const", value: 0 });
      else if (returnType.kind === "i32") liftedFctx.body.push({ op: "i32.const", value: 0 });
      else if (returnType.kind === "externref") liftedFctx.body.push({ op: "ref.null.extern" });
    }
  }

  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // Register the lifted function
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: iifeName,
    typeIdx: funcTypeIdx,
    locals: liftedFctx.locals,
    body: liftedFctx.body,
    exported: false,
  });
  ctx.funcMap.set(iifeName, funcIdx);

  // Emit the call: push captures (with ref cells for mutable ones), then arguments, then call
  for (const cap of captures) {
    if (cap.mutable) {
      // Wrap the current value in a ref cell for mutable capture
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
      // Check if the outer local is already boxed
      if (fctx.boxedCaptures?.has(cap.name)) {
        // Already a ref cell — pass directly
        fctx.body.push({ op: "local.get", index: cap.localIdx });
      } else {
        // Create a ref cell, store value, keep ref on stack
        fctx.body.push({ op: "local.get", index: cap.localIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        // Also box the outer local so subsequent reads/writes go through the ref cell
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
          kind: "ref",
          typeIdx: refCellTypeIdx,
        });
        fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
        // Re-register the original name to point to the boxed local
        fctx.localMap.set(cap.name, boxedLocalIdx);
        if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
        fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
      }
    } else {
      fctx.body.push({ op: "local.get", index: cap.localIdx });
    }
  }

  // Compile call arguments, matching to declared params; extras are evaluated and dropped
  // Flatten spread elements on array literals into individual expressions
  const flatIIFEArgs = flattenCallArgs(expr.arguments) ?? (expr.arguments as unknown as ts.Expression[]);
  const paramCount = paramTypes.length;
  for (let i = 0; i < flatIIFEArgs.length; i++) {
    const arg = flatIIFEArgs[i]!;
    // Skip any remaining spread elements that couldn't be flattened
    if (ts.isSpreadElement(arg)) continue;
    if (i < paramCount) {
      compileExpression(ctx, fctx, arg, paramTypes[i]);
    } else {
      // Extra argument — evaluate for side effects, drop result
      const extraType = compileExpression(ctx, fctx, arg);
      if (extraType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
  }

  // Supply defaults for missing params (use NaN sentinel for f64, #787)
  for (let i = flatIIFEArgs.length; i < paramCount; i++) {
    const pt = paramTypes[i] ?? { kind: "f64" as const };
    if (pt.kind === "f64") fctx.body.push({ op: "f64.const", value: NaN });
    else if (pt.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
    else if (pt.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
    else if (pt.kind === "ref" || pt.kind === "ref_null") fctx.body.push({ op: "ref.null", typeIdx: pt.typeIdx });
  }

  // Re-lookup in case addUnionImports shifted indices
  const finalFuncIdx = ctx.funcMap.get(iifeName) ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

  if (returnType) return returnType;
  return VOID_RESULT;
}

// ── New expressions ──────────────────────────────────────────────────

/** Resolve the enclosing class name from a FunctionContext.
 *  Uses enclosingClassName if set (e.g. closures), otherwise parses ClassName from "ClassName_methodName". */

/**
 * Compile a string expression argument and write it to WASI linear memory via bump allocator.
 * Pushes (ptr: i32, len: i32) onto the stack.
 *
 * For string literals, this is handled at the call site via wasiAllocStringData.
 * This function handles dynamic string values (variables, expressions) by
 * compiling a runtime copy from the WasmGC string to linear memory.
 *
 * Current limitation: only supports string literals assigned to variables at compile time.
 * For truly dynamic strings, we'd need a runtime string-to-memory encoder.
 * For now, emit unreachable for unsupported cases.
 */
function compileWasiStringArgToLinearMemory(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): void {
  // If it's an identifier referencing a const/let with a string literal initializer,
  // we can resolve it at compile time
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    if (sym?.valueDeclaration && ts.isVariableDeclaration(sym.valueDeclaration)) {
      const init = sym.valueDeclaration.initializer;
      if (init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) {
        const data = wasiAllocStringData(ctx, init.text);
        fctx.body.push({ op: "i32.const", value: data.offset } as Instr);
        fctx.body.push({ op: "i32.const", value: data.length } as Instr);
        return;
      }
    }
  }

  // Template literal with only a head (no substitutions)
  if (ts.isNoSubstitutionTemplateLiteral(expr)) {
    const data = wasiAllocStringData(ctx, expr.text);
    fctx.body.push({ op: "i32.const", value: data.offset } as Instr);
    fctx.body.push({ op: "i32.const", value: data.length } as Instr);
    return;
  }

  // Fallback: unsupported dynamic string — trap at runtime
  // TODO: implement runtime GC-string to linear-memory copy for dynamic strings
  fctx.body.push({ op: "unreachable" } as Instr);
}

export { compileCallExpression, compileIIFE, compileOptionalCallExpression };
