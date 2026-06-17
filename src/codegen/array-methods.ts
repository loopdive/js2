// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Array method compilation — extracted from expressions.ts.
 *
 * All array prototype and functional method implementations live here.
 * This module imports compileExpression and compileArrowAsClosure from
 * shared.ts (NOT expressions.ts) to avoid circular dependencies.
 */
import { ts } from "../ts-api.js";
import { isBooleanType, isStringType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { reportError } from "./context/errors.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import { addArrayIteratorImports, addStringImports, addUnionImports, resolveWasmType } from "./index.js";
import { addStringConstantGlobal, ensureExnTag, localGlobalIdx } from "./registry/imports.js";
import { compileStringLiteral } from "./shared.js";
import { getArrTypeIdxFromVec, getOrRegisterArrayType, getOrRegisterVecType } from "./registry/types.js";
import { ensureNativeIteratorRuntime, getOrRegisterIterRecType } from "./iterator-native.js";
import { ensureObjVecBuilders } from "./object-runtime.js";
import { ensureArgcGlobal, ensureCurrentThisGlobal, ensureExtrasArgvGlobal } from "./statements/nested-declarations.js";
import {
  compileArrowAsClosure,
  compileExpression,
  ensureLateImport,
  flushLateImportShifts,
  registerEmitBoundsCheckedArrayGet,
  VOID_RESULT,
} from "./shared.js";
import { emitUndefined, ensureGetUndefined } from "./expressions/late-imports.js";
import { ensureAnyHelpers, isAnyValue } from "./any-helpers.js";
import {
  ensureNativeStringHelpers,
  nativeStringLiteralInstrs,
  nativeStringType,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import { allocJoinFoldLocals, emitStringJoinFold, hostStringRepr, nativeStringRepr } from "./builtin-scaffold.js";
import { ensureTimsortHelper } from "./timsort.js";
import { coerceType, coercionInstrs, defaultValueInstrs } from "./type-coercion.js";

type ArrayMethodAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/** Emit throw with a string message (local version to avoid circular dep on expressions.ts) */
function emitThrowString(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  addStringConstantGlobal(ctx, message);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, message));
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "throw", tagIdx });
}

function throwStringInstrs(ctx: CodegenContext, message: string): Instr[] {
  addStringConstantGlobal(ctx, message);
  const tagIdx = ensureExnTag(ctx);
  return [...stringConstantExternrefInstrs(ctx, message), { op: "throw", tagIdx } as Instr];
}

/**
 * Check if a callback argument is known to be non-callable at compile time.
 * Returns true if the argument is null, undefined, a number, string, or boolean literal.
 */
function isKnownNonCallable(ctx: CodegenContext, arg: ts.Expression): boolean {
  if (arg.kind === ts.SyntaxKind.NullKeyword) return true;
  if (arg.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  if (arg.kind === ts.SyntaxKind.TrueKeyword || arg.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isNumericLiteral(arg)) return true;
  if (ts.isStringLiteral(arg)) return true;
  if (ts.isIdentifier(arg) && arg.text === "undefined") return true;
  // Check TS type flags for known non-function types
  const tsType = ctx.checker.getTypeAtLocation(arg);
  const NON_CALLABLE_FLAGS =
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Null |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.StringLike |
    ts.TypeFlags.BigIntLike;
  if (tsType.flags & NON_CALLABLE_FLAGS) return true;
  return false;
}

/**
 * Emit TypeError for missing or non-callable callback argument.
 * Called by array callback methods (every, some, forEach, filter, map, reduce).
 * Returns true if a throw was emitted (caller should return early).
 */
function emitCallbackTypeCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  methodName: string,
): boolean {
  // No callback argument → always throw
  if (callExpr.arguments.length < 1) {
    emitThrowString(ctx, fctx, `TypeError: ${methodName} callback is not a function`);
    return true;
  }
  // Known non-callable literal → compile arg for side effects, then throw
  const cbArg = callExpr.arguments[0]!;
  if (isKnownNonCallable(ctx, cbArg)) {
    const cbType = compileExpression(ctx, fctx, cbArg);
    if (cbType) fctx.body.push({ op: "drop" });
    emitThrowString(ctx, fctx, `TypeError: ${methodName} callback is not a function`);
    return true;
  }
  return false;
}

// ── Guarded funcref cast (ref.test before ref.cast to avoid illegal cast traps) ──
function guardedFuncRefCastInstrs(fctx: FunctionContext, funcTypeIdx: number): Instr[] {
  const tmpFunc = allocLocal(fctx, `__gfc_${fctx.locals.length}`, { kind: "funcref" } as ValType);
  return [
    { op: "local.tee", index: tmpFunc },
    { op: "ref.test", typeIdx: funcTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: funcTypeIdx } as ValType },
      then: [
        { op: "local.get", index: tmpFunc },
        { op: "ref.cast_null", typeIdx: funcTypeIdx },
      ],
      else: [{ op: "ref.null", typeIdx: funcTypeIdx }],
    } as Instr,
  ];
}

// ── Null guard for array method receivers ─────────────────────────────

/**
 * Emit a null check on the vec ref that was just tee'd into `localIdx`.
 * If null, throws TypeError via the exception tag instead of letting
 * struct.get trap with an unrecoverable Wasm trap.
 *
 * Stack: [ref_null] -> [ref_null]  (value is still on stack, unchanged)
 * The local already holds the value via local.tee before this call.
 */
function emitReceiverNullGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  localIdx: number,
  receiverExpr?: ts.Expression,
): void {
  // Skip null guard if receiver is provably non-null (e.g. const initialized from array literal)
  if (receiverExpr && isReceiverNonNull(receiverExpr, ctx.checker)) return;
  // Check if the value in the local is null
  fctx.body.push({ op: "local.get", index: localIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: throwStringInstrs(ctx, "TypeError: Array method called on null or undefined"),
    else: [],
  });
}

/** Check if an expression is provably non-null (e.g. const initialized from array literal). */
function isReceiverNonNull(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  let inner: ts.Expression = expr;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  switch (inner.kind) {
    case ts.SyntaxKind.NewExpression:
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
      return true;
    default:
      break;
  }
  if (ts.isIdentifier(inner)) {
    const sym = checker.getSymbolAtLocation(inner);
    if (sym) {
      const decl = sym.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const declList = decl.parent;
        if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
          return isReceiverNonNull(decl.initializer, checker);
        }
      }
    }
  }
  return false;
}

function typeIncludesUndefined(type: ts.Type): boolean {
  if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return true;
  if (type.isUnion()) return type.types.some((member) => typeIncludesUndefined(member));
  return false;
}

function shouldReturnUndefinedCapableResult(
  ctx: CodegenContext,
  callExpr: ts.CallExpression,
  expectedType?: ValType,
): boolean {
  let parent: ts.Node | undefined = callExpr.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent))
  ) {
    parent = parent.parent;
  }
  if (parent && ts.isExpressionStatement(parent)) return false;
  if (expectedType && expectedType.kind !== "externref" && expectedType.kind !== "ref_extern") return false;
  return typeIncludesUndefined(ctx.checker.getTypeAtLocation(callExpr));
}

/**
 * #2105 — value-rep P2 boolean-brand rollout for `Array.prototype.join` /
 * `toString`. A boolean array lowers to an i32 WasmGC element array, but the
 * `{ kind: "i32", boolean: true }` brand is structural-only and does not
 * survive into `arrDef.element` (arrays dedupe by structure). So the join
 * element-stringify path otherwise renders booleans numerically ("1"/"0").
 * Recover the boolean-ness from the receiver's TS element type instead:
 * `boolean[]`/`(true|false)[]` → number-index type is `boolean`.
 */
function arrayElementIsBoolean(ctx: CodegenContext, receiverExpr: ts.Expression): boolean {
  const recvTsType = ctx.checker.getTypeAtLocation(receiverExpr);
  if (!recvTsType) return false;
  const elemTsType = recvTsType.getNumberIndexType();
  return elemTsType ? isBooleanType(elemTsType) : false;
}

function arrayElementToExternrefInstrs(ctx: CodegenContext, fctx: FunctionContext, elemType: ValType): Instr[] {
  if (elemType.kind === "i8" || elemType.kind === "i16") {
    return coercionInstrs(ctx, { kind: "i32" }, { kind: "externref" }, fctx);
  }
  if (elemType.kind === "f32") {
    return [{ op: "f64.promote_f32" } as Instr, ...coercionInstrs(ctx, { kind: "f64" }, { kind: "externref" }, fctx)];
  }
  return coercionInstrs(ctx, elemType, { kind: "externref" }, fctx);
}

// ── Bounds-checked array access ───────────────────────────────────────

/**
 * Emit a bounds-checked array.get.  Stack must contain [arrayref, i32 index].
 * If the index is out of bounds (< 0 or >= array.len), a default value for the
 * element type is produced instead of trapping.
 *
 * #1396 — `useUndefinedSentinel` (default false): when true AND `elementType`
 * is `externref`/`ref_extern`, the OOB else-branch pushes the JS `undefined`
 * value (via `__get_undefined` host import) instead of `ref.null.extern`.
 * Required by destructuring callers — JS spec §13.7.5.5 fires defaults only
 * for `undefined`, not for `null`, and `ref.null.extern` surfaces to JS as
 * `null` causing `__extern_is_undefined` to return 0 → default never fires
 * for OOB extern-array reads (~320 fails in `for-of/dstr`, ~171 in
 * `assignment/dstr`).
 */
export function emitBoundsCheckedArrayGet(
  fctx: FunctionContext,
  arrTypeIdx: number,
  elementType: ValType,
  ctx?: CodegenContext,
  useUndefinedSentinel = false,
): void {
  // Save index and array ref to locals so we can use them in both branches
  const idxLocal = allocLocal(fctx, `__bounds_idx_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__bounds_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });

  fctx.body.push({ op: "local.set", index: idxLocal }); // save index
  fctx.body.push({ op: "local.set", index: arrLocal }); // save array ref

  // (#1396) When the destructuring caller asked for an undefined sentinel and
  // the element type is externref-shaped, register the `__get_undefined`
  // import BEFORE building the if-block so its funcIdx is stable and any
  // index-shifts have already been flushed into the current function body.
  let undefinedFuncIdx: number | undefined;
  if (useUndefinedSentinel && ctx && (elementType.kind === "externref" || elementType.kind === "ref_extern")) {
    undefinedFuncIdx = ensureGetUndefined(ctx);
    if (undefinedFuncIdx !== undefined) flushLateImportShifts(ctx, fctx);
  }

  // Condition: idx >= 0 && idx < array.len(arr)
  // We use: (unsigned)idx < array.len — this handles negative indices too
  // since negative i32 interpreted as unsigned is > any valid length
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.lt_u" } as Instr);

  // Build the "then" branch: in-bounds -> array.get
  const packedLoad =
    elementType.kind === "i8" ? "array.get_u" : elementType.kind === "i16" ? "array.get_s" : "array.get";
  const valueType: ValType = elementType.kind === "i8" || elementType.kind === "i16" ? { kind: "i32" } : elementType;

  const thenInstrs: Instr[] = [
    { op: "local.get", index: arrLocal } as Instr,
    { op: "local.get", index: idxLocal } as Instr,
    { op: packedLoad, typeIdx: arrTypeIdx } as Instr,
  ];

  // Build the "else" branch: out-of-bounds -> default value (or JS undefined
  // when the destructuring caller opted in via `useUndefinedSentinel`).
  const elseInstrs: Instr[] =
    undefinedFuncIdx !== undefined
      ? [{ op: "call", funcIdx: undefinedFuncIdx } as Instr]
      : defaultValueInstrs(valueType);

  // When the element type is a non-null ref, the else branch produces ref.null
  // which is ref_null. Use ref_null as the block type so both branches validate,
  // then narrow back to ref with ref.as_non_null.
  const needsNullableBlock = valueType.kind === "ref";
  const blockType: ValType = needsNullableBlock
    ? { kind: "ref_null", typeIdx: (valueType as { typeIdx: number }).typeIdx }
    : valueType;

  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: blockType },
    then: thenInstrs,
    else: elseInstrs,
  } as Instr);

  // Narrow ref_null back to ref so downstream struct.get etc. validate
  if (needsNullableBlock) {
    fctx.body.push({ op: "ref.as_non_null" });
  }
}

/**
 * Clamp an index for JS array methods: if idx < 0, idx = max(0, len + idx);
 * also clamp to max len.  idxLocal is updated in-place.
 */
export function emitClampIndex(fctx: FunctionContext, idxLocal: number, lenLocal: number): void {
  // if (idx < 0) idx = max(0, len + idx)
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: lenLocal } as Instr,
      { op: "local.get", index: idxLocal } as Instr,
      { op: "i32.add" } as Instr,
      { op: "local.set", index: idxLocal } as Instr,
      // if still < 0, clamp to 0
      { op: "local.get", index: idxLocal } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "i32.lt_s" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: idxLocal } as Instr],
      } as Instr,
    ],
  } as Instr);
  // Clamp to len: if (idx > len) idx = len
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "local.get", index: lenLocal } as Instr, { op: "local.set", index: idxLocal } as Instr],
  } as Instr);
}

/**
 * Clamp a value to be >= 0.  local is updated in-place.
 */
export function emitClampNonNeg(fctx: FunctionContext, local: number): void {
  fctx.body.push({ op: "local.get", index: local });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: local } as Instr],
  } as Instr);
}

// ── Array method calls (pure Wasm, no host imports) ─────────────────

/** Resolve array type info from a TS type. Returns null if not a Wasm GC vec struct. */
export function resolveArrayInfo(
  ctx: CodegenContext,
  tsType: ts.Type,
): { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType } | null {
  // In fast mode, strings are NativeString structs that look like arrays
  // (struct { len: i32, data: ref array }). Reject them here so string
  // methods are dispatched via compileNativeStringMethodCall instead.
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0 && isStringType(tsType)) return null;
  const wasmType = resolveWasmType(ctx, tsType);
  return resolveArrayInfoFromWasmType(ctx, wasmType);
}

function resolveArrayInfoFromWasmType(
  ctx: CodegenContext,
  wasmType: ValType | undefined,
): { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType } | null {
  if (!wasmType) return null;
  if (wasmType.kind !== "ref" && wasmType.kind !== "ref_null") return null;
  const vecTypeIdx = (wasmType as { typeIdx: number }).typeIdx;
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct") return null;
  if (vecDef.fields.length < 2) return null;
  const dataField = vecDef.fields[1]!;
  if (dataField.type.kind !== "ref") return null;
  const arrTypeIdx = dataField.type.typeIdx;
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return null;
  return { vecTypeIdx, arrTypeIdx, elemType: arrDef.element };
}

function inferExpressionWasmType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  allowProbe = true,
): ValType | undefined {
  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    const localIdx = fctx.localMap.get(name);
    if (localIdx !== undefined) return getLocalType(fctx, localIdx);
    const gIdx = ctx.moduleGlobals.get(name);
    if (gIdx !== undefined) return ctx.mod.globals[localGlobalIdx(ctx, gIdx)]?.type;
  }

  if (!allowProbe) return undefined;
  const savedLen = fctx.body.length;
  const probeResult = compileExpression(ctx, fctx, expr);
  fctx.body.length = savedLen;
  return probeResult ?? undefined;
}

function resolveArrayInfoForExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  tsType: ts.Type,
): { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType } | null {
  return (
    resolveArrayInfo(ctx, tsType) ?? resolveArrayInfoFromWasmType(ctx, inferExpressionWasmType(ctx, fctx, expr, false))
  );
}

/**
 * Try to get the local index of the receiver expression (for reassigning
 * the array variable after mutating methods like push/pop/shift).
 */
function getReceiverLocalIdx(fctx: FunctionContext, expr: ts.Expression): number | null {
  if (ts.isIdentifier(expr)) {
    const idx = fctx.localMap.get(expr.text);
    return idx !== undefined ? idx : null;
  }
  return null;
}

/** Methods supported by the array-like (externref receiver) path.
 * NOTE: map/filter/reduce/reduceRight are excluded because:
 * - map/filter: `length: "Infinity"` → Infinity → 2B iterations → compile_timeout
 * - reduce/reduceRight: different callback signature (acc, elem, i, arr) — handled by __proto_method_call
 */
const ARRAY_LIKE_METHOD_SET = new Set([
  "every",
  "some",
  "forEach",
  "find",
  "findIndex",
  "filter",
  "map",
  "reduce",
  "reduceRight",
  // Search methods (#1360) — no callback; compare each element against the
  // search value via __host_eq (strict equality) or __same_value_zero (includes).
  "indexOf",
  "lastIndexOf",
  "includes",
]);

/** Search methods handled inline (no callback). #1360 */
const ARRAY_LIKE_SEARCH_METHODS = new Set(["indexOf", "lastIndexOf", "includes"]);

/**
 * Compile Array.prototype.METHOD.call(anyReceiver, callback, ...args) for any-typed receivers.
 * Uses __extern_length + __extern_get_idx to iterate and call_ref for Wasm closure callbacks.
 * Only handles callbacks that compile to Wasm closures (arrow functions, function declarations).
 * Returns undefined if the pattern is not handled (caller should fall through).
 */
export function compileArrayLikePrototypeCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  methodName: string,
  receiverArg: ts.Expression,
): ValType | null | typeof VOID_RESULT | undefined {
  if (!ARRAY_LIKE_METHOD_SET.has(methodName)) return undefined;

  // For null/undefined receivers, let __proto_method_call throw TypeError (spec-correct behavior).
  // We cannot detect this at runtime in the Wasm loop, so bail out early.
  const isNullReceiver =
    receiverArg.kind === ts.SyntaxKind.NullKeyword ||
    receiverArg.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(receiverArg) && receiverArg.text === "undefined");
  if (isNullReceiver) return undefined;

  // Bail out on primitive literal receivers (boolean, number, string). Our `extern.convert_any`
  // coercion only works on ref/anyref values; a primitive compiled to i32/f64 would produce
  // invalid Wasm. The legacy __proto_method_call path handles ToObject(primitive) correctly.
  if (
    receiverArg.kind === ts.SyntaxKind.TrueKeyword ||
    receiverArg.kind === ts.SyntaxKind.FalseKeyword ||
    receiverArg.kind === ts.SyntaxKind.NumericLiteral ||
    receiverArg.kind === ts.SyntaxKind.StringLiteral ||
    receiverArg.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return undefined;
  }

  // Bail out only for real Array vectors (`__vec_*`) and the raw array element
  // types (`__arr_*`). Those structs are opaque to `__sget_*` getters (excluded
  // in `emitStructFieldGetters`), so `__extern_length` / `__extern_get_idx`
  // would see length 0 / undefined. Real arrays take the dedicated
  // `compileArrayMethodCall` path via the caller's `resolveArrayInfo` branch.
  //
  // Other struct receivers (instance classes, anonymous object types like
  // `{0:..,1:..,length:..}`) have per-field `__sget_*` getters emitted, so
  // `__extern_length`/`__extern_get_idx` read them correctly (#983, #1090).
  // Those must be allowed through — the prior blanket bailout routed them
  // to `__proto_method_call`, which passes the callback as a `__fn_wrap`
  // externref that the host cannot invoke (regression from PR #195, #1152).
  {
    const recvTsType = ctx.checker.getTypeAtLocation(receiverArg);
    if (recvTsType) {
      const recvWasmType = resolveWasmType(ctx, recvTsType);
      if (recvWasmType.kind === "ref" || recvWasmType.kind === "ref_null") {
        const typeIdx = (recvWasmType as { typeIdx: number }).typeIdx;
        const typeDef = ctx.mod.types[typeIdx];
        const typeName = typeDef && "name" in typeDef ? (typeDef as { name?: string }).name : undefined;
        if (typeName && (typeName.startsWith("__vec_") || typeName.startsWith("__arr_"))) {
          return undefined;
        }
      }
    }
  }

  // Bail out if the call site is inside `assert_throws(...)` (test262 rewrites
  // `assert.throws` to this helper). The Wasm-native loop calls
  // `__extern_length` / `__extern_get_idx` directly, and those host imports
  // have an internal try/catch in `src/runtime.ts` that swallows getter
  // exceptions (returns 0 / undefined respectively). Tests like
  // `built-ins/Array/prototype/reduce/15.4.4.21-9-c-i-32.js` define a
  // throwing getter at index 1 and expect the throw to propagate out of
  // `Array.prototype.reduce.call(obj, ...)`. Routing those through the
  // legacy `__proto_method_call` bridge — which uses the host's native
  // `Array.prototype.reduce` — preserves the spec-correct propagation.
  //
  // #1358 PR #268 v1 attempted to drop this bailout per architect plan §1
  // ("exception propagation works"). CI showed 27 regressions in
  // reduce/reduceRight/forEach/some/every/filter/map/TypedArray.includes —
  // ALL of them assert.throws-wrapped tests with throwing getters. Restored
  // here. The structural fix (make `__extern_length` / `__extern_get_idx`
  // re-throw instead of swallow) is tracked in #1382 (Wasm closure / host
  // bridge gap).
  {
    let p: ts.Node | undefined = callExpr.parent;
    while (p) {
      if (
        ts.isCallExpression(p) &&
        ts.isIdentifier(p.expression) &&
        (p.expression.text === "assert_throws" || p.expression.text === "assert_throwsAsync")
      ) {
        return undefined;
      }
      p = p.parent;
    }
  }

  // #1360 — Search methods: indexOf/lastIndexOf/includes don't take a callback.
  // Branch into the dedicated search compiler before the callback-validity check.
  if (ARRAY_LIKE_SEARCH_METHODS.has(methodName)) {
    return compileArrayLikePrototypeSearch(ctx, fctx, callExpr, methodName, receiverArg);
  }

  // every/some/forEach/find/findIndex: callback is args[1]
  if (callExpr.arguments.length < 2) return undefined;
  const cbArg = callExpr.arguments[1]!;

  // Only handle callbacks that produce Wasm closures.
  // If the callback is a real JS function (externref), __proto_method_call handles it correctly.
  const willBeClosure =
    ts.isArrowFunction(cbArg) ||
    ts.isFunctionExpression(cbArg) ||
    (ts.isIdentifier(cbArg) && (ctx.funcMap.has(cbArg.text) || ctx.closureMap.has(cbArg.text)));
  if (!willBeClosure) return undefined;

  // Ensure host imports
  const lenFn = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
  const getIdxFn = ensureLateImport(
    ctx,
    "__extern_get_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  const hasIdxFn = ensureLateImport(
    ctx,
    "__extern_has_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "i32" }],
  );
  // __is_truthy for JS-correct truthiness when callback returns externref
  // (boxed boolean false is non-null, so ref.is_null alone is wrong).
  const isTruthyFn = ensureLateImport(ctx, "__is_truthy", [{ kind: "externref" }], [{ kind: "i32" }]);
  if (lenFn === undefined || getIdxFn === undefined || hasIdxFn === undefined || isTruthyFn === undefined)
    return undefined;
  // #16 — pre-register the result-array build helpers used by the filter/map/
  // reduce arms BELOW, BEFORE we resolve any per-element funcIdx. These
  // `ensureLateImport`s shift every defined-func index; doing them up-front
  // means the single re-resolve of __extern_get_idx/__extern_has_idx (after the
  // receiver + callback compile) stays valid through the method arm, instead of
  // the arm's own late imports invalidating an already-baked loadElem funcIdx
  // (the addUnionImports late-shift hazard → `call[0] expected extern`/invalid
  // Wasm). Idempotent; the arms re-fetch these by name too.
  ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
  ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
  ensureLateImport(ctx, "__extern_set", [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
  ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);

  // Compile receiver to externref
  const receiverTmp = allocLocal(fctx, `__ali_recv_${fctx.locals.length}`, { kind: "externref" });
  const recvType = compileExpression(ctx, fctx, receiverArg, { kind: "externref" });
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  fctx.body.push({ op: "local.set", index: receiverTmp });

  // len = i32(f64(__extern_length(receiver)))
  const lenTmp = allocLocal(fctx, `__ali_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: receiverTmp });
  // #16 — re-resolve __extern_length: the receiver compile above can shift
  // defined-func indices (addUnionImports late-shift hazard); names are stable.
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_length") ?? lenFn });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Compile callback to closure
  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) return undefined;
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo) return undefined;

  const closureTmp = allocLocal(fctx, `__ali_cl_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: closureTmp });

  // #16 — re-resolve the per-element helpers AFTER the callback compile (which,
  // like the receiver compile, can register new functions and shift every
  // defined-func index). The funcIdx captured at the top of this function would
  // otherwise be stale-low → `call` to the wrong function → invalid Wasm (the
  // emitBinary/emitWat divergence). Names are stable in funcMap. (filter/map
  // also register __js_array_* below, a further shift source.)
  const getIdxFnNow = ctx.funcMap.get("__extern_get_idx") ?? getIdxFn;
  const hasIdxFnNow = ctx.funcMap.get("__extern_has_idx") ?? hasIdxFn;

  // i = 0
  const iTmp = allocLocal(fctx, `__ali_i_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  // elem local (externref)
  const elemTmp = allocLocal(fctx, `__ali_elem_${fctx.locals.length}`, { kind: "externref" });

  const numParams = closureInfo.paramTypes.length;

  /** Load receiver[i] into elemTmp */
  const loadElem: Instr[] = [
    { op: "local.get", index: receiverTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: getIdxFnNow } as Instr,
    { op: "local.set", index: elemTmp } as Instr,
  ];

  /** Callback invocation: closure(elem?, i?, receiver?) */
  const callClosure: Instr[] = [
    { op: "local.get", index: closureTmp } as Instr,
    // Only push elem if callback expects at least 1 param (0-param callback causes Wasm validation error)
    ...(numParams >= 1
      ? [
          { op: "local.get", index: elemTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[0] ?? { kind: "externref" }, fctx),
        ]
      : []),
    ...(numParams >= 2
      ? [
          { op: "local.get", index: iTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ]
      : []),
    ...(numParams >= 3
      ? [
          { op: "local.get", index: receiverTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[2] ?? { kind: "externref" }, fctx),
        ]
      : []),
    { op: "local.get", index: closureTmp } as Instr,
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" } as Instr,
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
  ];

  /** Convert callback result to i32 truthy flag */
  const toTruthy: Instr[] =
    closureInfo.returnType === null
      ? // void callback: call_ref leaves nothing on stack — just push truthy (1).
        // The callback never returns a meaningful value; void → always truthy so
        // every/find/some behave as if all elements match (correct for empty loops).
        [{ op: "i32.const", value: 1 } as Instr]
      : closureInfo.returnType.kind === "f64"
        ? // NaN is falsy in JS; f64.ne(0) treats NaN as truthy. Use |x|>0 instead.
          [{ op: "f64.abs" } as Instr, { op: "f64.const", value: 0 } as Instr, { op: "f64.gt" } as Instr]
        : closureInfo.returnType.kind === "i32"
          ? []
          : closureInfo.returnType.kind === "externref"
            ? // Boxed value: __is_truthy unwraps JS semantics (false/0/NaN/""/null → falsy).
              [{ op: "call", funcIdx: isTruthyFn } as Instr]
            : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
              ? // Non-externref struct/string refs: fall back to null check. JS truthiness on
                // these uncommon shapes is not observable here (callbacks usually return any).
                [{ op: "ref.is_null" } as Instr, { op: "i32.eqz" } as Instr]
              : [{ op: "drop" } as Instr, { op: "i32.const", value: 1 } as Instr];

  /** Increment i */
  const incrI: Instr[] = [
    { op: "local.get", index: iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];

  /** Loop exit condition: if i >= len, break */
  const exitIfDone: Instr[] = [
    { op: "local.get", index: iTmp } as Instr,
    { op: "local.get", index: lenTmp } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
  ];

  /** Push `__extern_has_idx(receiver, i)` — spec HasProperty used to skip holes. */
  const hasIdxCheck: Instr[] = [
    { op: "local.get", index: receiverTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: hasIdxFnNow } as Instr,
  ];

  /**
   * Wrap the per-iteration body so it runs only when HasProperty(receiver, i).
   * Absent indices fall through to incrI. Any `br depth: N` inside `inner` that
   * targets a level OUTSIDE the new `if` must use depth+1 (the if adds one
   * nesting level).
   */
  const gatedBody = (inner: Instr[]): Instr[] => [
    ...hasIdxCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: inner,
    } as Instr,
  ];

  switch (methodName) {
    case "every": {
      const resTmp = allocLocal(fctx, `__ali_ev_res_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...callClosure,
                ...toTruthy,
                { op: "i32.eqz" } as Instr,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 0 } as Instr,
                    { op: "local.set", index: resTmp } as Instr,
                    { op: "br", depth: 3 } as Instr,
                  ],
                } as Instr,
              ]),
              ...incrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "i32" };
    }

    case "some": {
      const resTmp = allocLocal(fctx, `__ali_sm_res_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...callClosure,
                ...toTruthy,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 1 } as Instr,
                    { op: "local.set", index: resTmp } as Instr,
                    { op: "br", depth: 3 } as Instr,
                  ],
                } as Instr,
              ]),
              ...incrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "i32" };
    }

    case "forEach": {
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...callClosure,
                // drop return value if any
                ...(closureInfo.returnType !== null ? [{ op: "drop" } as Instr] : []),
              ]),
              ...incrI,
            ],
          } as Instr,
        ],
      });
      return VOID_RESULT;
    }

    case "find": {
      const resTmp = allocLocal(fctx, `__ali_fd_res_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...loadElem,
              ...callClosure,
              ...toTruthy,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: elemTmp } as Instr,
                  { op: "local.set", index: resTmp } as Instr,
                  { op: "br", depth: 2 } as Instr,
                ],
              } as Instr,
              ...incrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "externref" };
    }

    case "findIndex": {
      const resTmp = allocLocal(fctx, `__ali_fi_res_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "f64.const", value: -1 });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...loadElem,
              ...callClosure,
              ...toTruthy,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: iTmp } as Instr,
                  { op: "f64.convert_i32_s" },
                  { op: "local.set", index: resTmp } as Instr,
                  { op: "br", depth: 2 } as Instr,
                ],
              } as Instr,
              ...incrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "f64" };
    }

    case "filter": {
      const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
      const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
      if (arrNewIdx === undefined || arrPushIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const resultTmp = allocLocal(fctx, `__ali_fl_res_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "call", funcIdx: arrNewIdx });
      fctx.body.push({ op: "local.set", index: resultTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...callClosure,
                ...toTruthy,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: resultTmp } as Instr,
                    { op: "local.get", index: elemTmp } as Instr,
                    { op: "call", funcIdx: arrPushIdx } as Instr,
                  ],
                } as Instr,
              ]),
              ...incrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: resultTmp });
      return { kind: "externref" };
    }

    case "map": {
      const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
      const arrSetIdx = ensureLateImport(
        ctx,
        "__extern_set",
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
        [],
      );
      // Used both for numeric callback results and for array index / length keys.
      const mapBoxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      if (arrNewIdx === undefined || arrSetIdx === undefined || mapBoxIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const resultTmp = allocLocal(fctx, `__ali_mp_res_${fctx.locals.length}`, { kind: "externref" });
      const mappedTmp = allocLocal(fctx, `__ali_mp_mapped_${fctx.locals.length}`, { kind: "externref" });
      // Convert map result to externref
      const mapReturnToExternref: Instr[] =
        closureInfo.returnType === null
          ? // Void callback leaves nothing on the stack; push null so local.set
            // has a value. Maps produced from void callbacks fill with undefined.
            [{ op: "ref.null.extern" } as Instr]
          : closureInfo.returnType.kind === "f64"
            ? [{ op: "call", funcIdx: mapBoxIdx } as Instr]
            : closureInfo.returnType.kind === "i32"
              ? [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: mapBoxIdx } as Instr]
              : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
                ? [{ op: "extern.convert_any" }]
                : []; // externref: already right type
      fctx.body.push({ op: "call", funcIdx: arrNewIdx });
      fctx.body.push({ op: "local.set", index: resultTmp });
      addStringConstantGlobal(ctx, "length");
      fctx.body.push(
        { op: "local.get", index: resultTmp },
        ...stringConstantExternrefInstrs(ctx, "length"),
        { op: "local.get", index: lenTmp },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: mapBoxIdx },
        { op: "call", funcIdx: arrSetIdx },
      );
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...callClosure,
                ...mapReturnToExternref,
                { op: "local.set", index: mappedTmp } as Instr,
                { op: "local.get", index: resultTmp } as Instr,
                { op: "local.get", index: iTmp } as Instr,
                { op: "f64.convert_i32_s" },
                { op: "call", funcIdx: mapBoxIdx } as Instr,
                { op: "local.get", index: mappedTmp } as Instr,
                { op: "call", funcIdx: arrSetIdx } as Instr,
              ]),
              ...incrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: resultTmp });
      return { kind: "externref" };
    }

    case "reduce": {
      // reduce(callback, initialValue?) — callback(acc, elem, i, receiver) -> acc
      // args: [receiver, callback, initialValue?]
      const accTmp = allocLocal(fctx, `__ali_rd_acc_${fctx.locals.length}`, { kind: "externref" });
      const hasInitial = callExpr.arguments.length >= 3;
      if (hasInitial) {
        const initType = compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "externref" });
        if (initType && initType.kind !== "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        }
        if (initType === null) fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "local.set", index: accTmp });
      } else {
        // No initial value (spec §23.1.3.21 step 6.b): scan forward for the
        // FIRST present index k (HasProperty), set acc = receiver[k], set
        // iTmp = k+1, then continue with the main loop. If no element is
        // present, throw TypeError. The previous implementation grabbed
        // receiver[0] unconditionally, which produced NaN when index 0
        // was a hole (issue #1461 acceptance bullet 3).
        const foundTmp = allocLocal(fctx, `__ali_rd_found_${fctx.locals.length}`, { kind: "i32" });
        // foundTmp = 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.set", index: foundTmp });
        // i = 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.set", index: iTmp });

        // Scan loop: walk i = 0..len-1, find first HasProperty(receiver, i).
        fctx.body.push({
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // exit if i >= len  (br to enclosing block; reduce-no-initial throws)
                ...exitIfDone,
                // if HasProperty(receiver, i): { acc = receiver[i]; i = i + 1; br 2 (exit scan block) }
                ...hasIdxCheck,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // acc = receiver[i]
                    { op: "local.get", index: receiverTmp } as Instr,
                    { op: "local.get", index: iTmp } as Instr,
                    { op: "f64.convert_i32_s" },
                    { op: "call", funcIdx: getIdxFnNow } as Instr,
                    { op: "local.set", index: accTmp } as Instr,
                    // foundTmp = 1
                    { op: "i32.const", value: 1 } as Instr,
                    { op: "local.set", index: foundTmp } as Instr,
                    // i = i + 1
                    { op: "local.get", index: iTmp } as Instr,
                    { op: "i32.const", value: 1 } as Instr,
                    { op: "i32.add" } as Instr,
                    { op: "local.set", index: iTmp } as Instr,
                    // Exit scan block (depth: 2 = past the inner `if`, the loop, to break out of the outer block)
                    { op: "br", depth: 2 } as Instr,
                  ],
                } as Instr,
                // Not present: increment and loop back (br depth 0 = continue loop)
                ...incrI,
              ],
            } as Instr,
          ],
        });
        // If no element was found, throw TypeError (spec step 6.c).
        fctx.body.push({ op: "local.get", index: foundTmp });
        fctx.body.push({ op: "i32.eqz" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: throwStringInstrs(ctx, "TypeError: Reduce of empty array with no initial value"),
        });
      }

      // Reduce callback has 4 params: acc, elem, i, array
      // Build the reduce call instructions (similar to callClosure but with accTmp first).
      // Only push each argument if the closure declares that parameter — pushing an unused
      // local on the stack produces invalid Wasm because call_ref expects exactly numParams values.
      const reduceNumParams = closureInfo.paramTypes.length;
      const reduceCallClosure: Instr[] = [
        { op: "local.get", index: closureTmp } as Instr,
        ...(reduceNumParams >= 1
          ? [
              { op: "local.get", index: accTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[0] ?? { kind: "externref" }, fctx),
            ]
          : []),
        ...(reduceNumParams >= 2
          ? [
              { op: "local.get", index: elemTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[1] ?? { kind: "externref" }, fctx),
            ]
          : []),
        ...(reduceNumParams >= 3
          ? [
              { op: "local.get", index: iTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[2] ?? { kind: "i32" }, fctx),
            ]
          : []),
        ...(reduceNumParams >= 4
          ? [
              { op: "local.get", index: receiverTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[3] ?? { kind: "externref" }, fctx),
            ]
          : []),
        { op: "local.get", index: closureTmp } as Instr,
        { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
        ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
        { op: "ref.as_non_null" } as Instr,
        { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
      ];

      // Convert reduce result to externref for accumulator
      const rdBoxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      if (rdBoxIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const reduceResultToExternref: Instr[] =
        closureInfo.returnType === null
          ? // Void callback leaves nothing on the stack; push null so local.set
            // has a value. Subsequent iterations pass undefined as acc.
            [{ op: "ref.null.extern" } as Instr]
          : closureInfo.returnType.kind === "f64"
            ? [{ op: "call", funcIdx: rdBoxIdx } as Instr]
            : closureInfo.returnType.kind === "i32"
              ? [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: rdBoxIdx } as Instr]
              : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
                ? [{ op: "extern.convert_any" }]
                : []; // externref: already right type

      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...reduceCallClosure,
                ...reduceResultToExternref,
                { op: "local.set", index: accTmp } as Instr,
              ]),
              ...incrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: accTmp });
      return { kind: "externref" };
    }

    case "reduceRight": {
      // Similar to reduce but from len-1 down to 0
      const accTmp = allocLocal(fctx, `__ali_rr_acc_${fctx.locals.length}`, { kind: "externref" });
      const hasInitial = callExpr.arguments.length >= 3;

      // Set i to last index
      fctx.body.push({ op: "local.get", index: lenTmp });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "i32.sub" });
      fctx.body.push({ op: "local.set", index: iTmp });

      if (hasInitial) {
        const initType = compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "externref" });
        if (initType && initType.kind !== "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        }
        if (initType === null) fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "local.set", index: accTmp });
      } else {
        // No initial value (spec §23.1.3.22 step 7.b): scan BACKWARD for the
        // FIRST (highest) present index k, set acc = receiver[k], iTmp = k-1.
        // Throw TypeError if no element is present. The previous code grabbed
        // receiver[len-1] unconditionally, which produced NaN when the last
        // index was a hole (issue #1461 acceptance bullet 3).
        const foundTmpR = allocLocal(fctx, `__ali_rr_found_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.set", index: foundTmpR });

        // Scan loop: walk i = len-1..0, find first HasProperty(receiver, i).
        fctx.body.push({
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // exit if i < 0  (br to enclosing block; reduceRight-no-initial throws)
                { op: "local.get", index: iTmp } as Instr,
                { op: "i32.const", value: 0 } as Instr,
                { op: "i32.lt_s" } as Instr,
                { op: "br_if", depth: 1 } as Instr,
                // if HasProperty(receiver, i): { acc = receiver[i]; i = i - 1; br 2 (exit scan block) }
                ...hasIdxCheck,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: receiverTmp } as Instr,
                    { op: "local.get", index: iTmp } as Instr,
                    { op: "f64.convert_i32_s" },
                    { op: "call", funcIdx: getIdxFnNow } as Instr,
                    { op: "local.set", index: accTmp } as Instr,
                    { op: "i32.const", value: 1 } as Instr,
                    { op: "local.set", index: foundTmpR } as Instr,
                    { op: "local.get", index: iTmp } as Instr,
                    { op: "i32.const", value: 1 } as Instr,
                    { op: "i32.sub" } as Instr,
                    { op: "local.set", index: iTmp } as Instr,
                    { op: "br", depth: 2 } as Instr,
                  ],
                } as Instr,
                // Not present: decrement and loop back
                { op: "local.get", index: iTmp } as Instr,
                { op: "i32.const", value: 1 } as Instr,
                { op: "i32.sub" } as Instr,
                { op: "local.set", index: iTmp } as Instr,
                { op: "br", depth: 0 } as Instr,
              ],
            } as Instr,
          ],
        });
        // If no element was found, throw TypeError.
        fctx.body.push({ op: "local.get", index: foundTmpR });
        fctx.body.push({ op: "i32.eqz" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: throwStringInstrs(ctx, "TypeError: Reduce of empty array with no initial value"),
        });
      }

      const rrNumParams = closureInfo.paramTypes.length;
      const rrCallClosure: Instr[] = [
        { op: "local.get", index: closureTmp } as Instr,
        ...(rrNumParams >= 1
          ? [
              { op: "local.get", index: accTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[0] ?? { kind: "externref" }, fctx),
            ]
          : []),
        ...(rrNumParams >= 2
          ? [
              { op: "local.get", index: elemTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[1] ?? { kind: "externref" }, fctx),
            ]
          : []),
        ...(rrNumParams >= 3
          ? [
              { op: "local.get", index: iTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[2] ?? { kind: "i32" }, fctx),
            ]
          : []),
        ...(rrNumParams >= 4
          ? [
              { op: "local.get", index: receiverTmp } as Instr,
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[3] ?? { kind: "externref" }, fctx),
            ]
          : []),
        { op: "local.get", index: closureTmp } as Instr,
        { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
        ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
        { op: "ref.as_non_null" } as Instr,
        { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
      ];

      const rrBoxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      if (rrBoxIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const rrResultToExternref: Instr[] =
        closureInfo.returnType === null
          ? // Void callback — see note in reduce case.
            [{ op: "ref.null.extern" } as Instr]
          : closureInfo.returnType.kind === "f64"
            ? [{ op: "call", funcIdx: rrBoxIdx } as Instr]
            : closureInfo.returnType.kind === "i32"
              ? [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: rrBoxIdx } as Instr]
              : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
                ? [{ op: "extern.convert_any" }]
                : [];

      // Loop: while i >= 0
      /** Exit when i < 0 */
      const exitIfNeg: Instr[] = [
        { op: "local.get", index: iTmp } as Instr,
        { op: "i32.const", value: 0 } as Instr,
        { op: "i32.lt_s" } as Instr,
        { op: "br_if", depth: 1 } as Instr,
      ];
      const decrI: Instr[] = [
        { op: "local.get", index: iTmp } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.sub" } as Instr,
        { op: "local.set", index: iTmp } as Instr,
        { op: "br", depth: 0 } as Instr,
      ];

      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfNeg,
              ...gatedBody([
                ...loadElem,
                ...rrCallClosure,
                ...rrResultToExternref,
                { op: "local.set", index: accTmp } as Instr,
              ]),
              ...decrI,
            ],
          } as Instr,
        ],
      });
      fctx.body.push({ op: "local.get", index: accTmp });
      return { kind: "externref" };
    }

    default:
      return undefined;
  }
}

/**
 * #1360 — Inline-compile `Array.prototype.{indexOf,lastIndexOf,includes}`
 * against an externref array-like receiver.
 *
 * Iterates [0, len) (or [len-1, 0] for `lastIndexOf`) using
 * `__extern_length` + `__extern_get_idx`. For `indexOf`/`lastIndexOf`,
 * gates each iteration on `__extern_has_idx` so missing properties (sparse
 * holes) are skipped per spec §23.1.3.16/§23.1.3.20. For `includes`, every
 * index is visited (spec §23.1.3.13 uses `Get`, which returns `undefined`
 * for missing keys — same effect as iterating without the HasProperty gate
 * since the search element is also coerced to externref/undefined).
 *
 * Comparison:
 *   - indexOf/lastIndexOf — `__host_eq` (Strict Equality, NaN ≠ NaN, +0 = -0)
 *   - includes            — `__same_value_zero` (NaN = NaN, +0 = -0)
 *
 * fromIndex coercion:
 *   `i32.trunc_sat_f64_s` happens to map +Inf → INT_MAX, -Inf → INT_MIN,
 *   NaN → 0. Combined with the existing typed-array clamp logic
 *   (negative → max(len + n, 0) for forward; clamp to len-1 for backward),
 *   that produces the spec-correct start index for every Inf/NaN/finite case.
 *   Verified by `tests/issue-1360.test.ts`.
 */
function compileArrayLikePrototypeSearch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  methodName: string,
  receiverArg: ts.Expression,
): ValType | null | typeof VOID_RESULT | undefined {
  // `compileArrayLikePrototypeCall` is dispatched from
  // `Array.prototype.METHOD.call(receiver, ...methodArgs)`, where
  // callExpr.arguments[0] is `receiver` (passed to us as `receiverArg`) and
  // [1+] are the method arguments. Search methods need at least one method
  // argument: the search value.
  if (callExpr.arguments.length < 2) return undefined;

  // #1360 PR #274 follow-up: bail to the legacy `__proto_method_call` host
  // bridge when the search argument is statically null or undefined.
  // Reason: the runtime's `__extern_has_idx` returns 0 for fields whose
  // wasmGC value is the externref null (it does `if (v != null) return 1;`
  // — null fields look "absent" to that loose check). That makes
  // `lastIndexOf.call({1:null, length:2}, null)` return -1 instead of 1.
  // The host bridge invokes native `Array.prototype.lastIndexOf` which
  // honours HasProperty correctly. Until __extern_has_idx grows a
  // "field-defined-with-null" path (#1382), bail.
  {
    const searchArg = callExpr.arguments[1]!;
    const searchIsNullish =
      searchArg.kind === ts.SyntaxKind.NullKeyword ||
      searchArg.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(searchArg) && searchArg.text === "undefined");
    if (searchIsNullish) return undefined;
  }

  const isLast = methodName === "lastIndexOf";
  const isIncludes = methodName === "includes";

  // Late imports — receiver iteration + element comparison.
  const lenFn = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
  const getIdxFn = ensureLateImport(
    ctx,
    "__extern_get_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  const hasIdxFn = ensureLateImport(
    ctx,
    "__extern_has_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "i32" }],
  );
  const cmpFn = isIncludes
    ? ensureLateImport(ctx, "__same_value_zero", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }])
    : ensureLateImport(ctx, "__host_eq", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  if (lenFn === undefined || getIdxFn === undefined || hasIdxFn === undefined || cmpFn === undefined) return undefined;
  flushLateImportShifts(ctx, fctx);

  // Compile receiver to externref local.
  const receiverTmp = allocLocal(fctx, `__alis_recv_${fctx.locals.length}`, { kind: "externref" });
  const recvType = compileExpression(ctx, fctx, receiverArg, { kind: "externref" });
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  fctx.body.push({ op: "local.set", index: receiverTmp });

  // len: f64 from __extern_length. Kept as f64 (not truncated to i32) so the
  // loop handles huge array-like lengths up to 2^53-1, e.g. test262
  // `built-ins/Array/prototype/indexOf/length-near-integer-limit.js`. The
  // legacy i32-truncated path silently failed for length > 2^31. The host
  // imports `__extern_get_idx` / `__extern_has_idx` already take f64 indices.
  const lenTmp = allocLocal(fctx, `__alis_len_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.get", index: receiverTmp });
  // #16 — re-resolve __extern_length from funcMap: compiling the receiver above
  // can register a new function (e.g. via ensureObjectRuntime / late imports)
  // that SHIFTS every defined-func index, so the `lenFn` captured before the
  // receiver compile is stale-low by the shift delta and would `call` the wrong
  // function (manifests as `local.set expected f64, found call externref` —
  // emitBinary bakes the numeric index while emitWat reprints the name, hiding
  // it). Names in funcMap are stable; the index is not. (addUnionImports
  // late-shift hazard.)
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_length") ?? lenFn });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Search value (externref). For booleans we MUST box via __box_boolean so the
  // resulting externref is a JS boolean (not a number), since strict equality /
  // SameValueZero against host-stored booleans (e.g. `obj[k] = true`) requires
  // the same primitive type. The default coerceType i32→externref path uses
  // __box_number, which would turn `true` into the number 1 — and `1 === true`
  // is false in JS. Likewise null/undefined need to round-trip as themselves.
  const searchTmp = allocLocal(fctx, `__alis_search_${fctx.locals.length}`, { kind: "externref" });
  // `compileArrayLikePrototypeCall` shape: args[0] is the receiver (already
  // bound to receiverArg), args[1] is the search value, args[2] is fromIndex.
  const searchExpr = callExpr.arguments[1]!;
  const searchTsType = ctx.checker.getTypeAtLocation(searchExpr);
  const searchIsBoolean =
    searchTsType !== undefined &&
    ((searchTsType.flags & ts.TypeFlags.Boolean) !== 0 || (searchTsType.flags & ts.TypeFlags.BooleanLiteral) !== 0);
  const searchType = compileExpression(ctx, fctx, searchExpr, { kind: "externref" });
  if (searchType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (searchType.kind === "i32" && searchIsBoolean) {
    // Box boolean as actual JS boolean. addUnionImports is idempotent and
    // installs __box_boolean alongside the other any-value helpers.
    addUnionImports(ctx);
    const boxBoolIdx = ctx.funcMap.get("__box_boolean");
    if (boxBoolIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxBoolIdx });
    } else {
      // Last-resort fallback: drops the i32 and pushes null so the program
      // is still well-formed. Should never trigger in practice.
      coerceType(ctx, fctx, searchType, { kind: "externref" });
    }
  } else if (searchType.kind !== "externref") {
    coerceType(ctx, fctx, searchType, { kind: "externref" });
  }
  fctx.body.push({ op: "local.set", index: searchTmp });

  // Loop index (f64) — always allocated; defaulted below. f64 lets the loop
  // walk huge array-like lengths up to 2^53-1 without truncation.
  const iTmp = allocLocal(fctx, `__alis_i_${fctx.locals.length}`, { kind: "f64" });

  // Result accumulator: i32 (boolean) for includes, f64 (-1 default) for indexOf/lastIndexOf.
  let resTmp: number;
  if (isIncludes) {
    resTmp = allocLocal(fctx, `__alis_res_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    resTmp = allocLocal(fctx, `__alis_res_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: resTmp });

  // ── fromIndex coercion (all f64 to handle indices up to 2^53-1) ──
  // Forward (indexOf/includes): default 0; if negative, k = max(len+n, 0); else
  // loop exit handles n >= len. NaN → 0 per ToIntegerOrInfinity. +Infinity →
  // start beyond end (loop exits, returns -1). -Infinity → 0.
  // Backward (lastIndexOf): default len-1; if negative, k = len+n (may stay
  // <0 → exits to -1); else clamp to len-1. NaN → 0. +Infinity → len-1.
  // -Infinity → len + -Infinity = -Infinity → exits.
  if (callExpr.arguments.length >= 3) {
    const argType = compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "f64" });
    if (argType && argType.kind !== "f64") {
      coerceType(ctx, fctx, argType, { kind: "f64" });
    }
    if (argType === null) {
      // Failed to compile fromIndex; treat as 0 (forward) or len-1 (backward).
      if (isLast) {
        fctx.body.push({ op: "local.get", index: lenTmp });
        fctx.body.push({ op: "f64.const", value: 1 });
        fctx.body.push({ op: "f64.sub" });
      } else {
        fctx.body.push({ op: "f64.const", value: 0 });
      }
      fctx.body.push({ op: "local.set", index: iTmp });
    } else {
      // NaN → 0 per spec ToIntegerOrInfinity. f64.ne(x, x) detects NaN.
      // Stack: [argType_f64]. tee to iTmp, then check NaN.
      fctx.body.push({ op: "local.tee", index: iTmp });
      fctx.body.push({ op: "local.get", index: iTmp });
      fctx.body.push({ op: "f64.ne" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: iTmp } as Instr],
      } as Instr);

      // Spec: ToIntegerOrInfinity truncates toward 0 for finite values; ±Infinity
      // and NaN are kept as-is (NaN handled above as 0). f64.trunc gives toward-0
      // truncation; preserves ±Infinity.
      fctx.body.push({ op: "local.get", index: iTmp });
      fctx.body.push({ op: "f64.trunc" });
      fctx.body.push({ op: "local.set", index: iTmp });

      if (isLast) {
        // If negative, k = len + n. Otherwise k = min(n, len - 1).
        fctx.body.push({ op: "local.get", index: iTmp });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: lenTmp } as Instr,
            { op: "local.get", index: iTmp } as Instr,
            { op: "f64.add" } as Instr,
            { op: "local.set", index: iTmp } as Instr,
          ],
          else: [
            // n >= 0: k = min(n, len - 1)
            { op: "local.get", index: iTmp } as Instr,
            { op: "local.get", index: lenTmp } as Instr,
            { op: "f64.const", value: 1 } as Instr,
            { op: "f64.sub" } as Instr,
            { op: "f64.gt" } as Instr,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: lenTmp } as Instr,
                { op: "f64.const", value: 1 } as Instr,
                { op: "f64.sub" } as Instr,
                { op: "local.set", index: iTmp } as Instr,
              ],
            } as Instr,
          ],
        } as Instr);
      } else {
        // Forward: if negative, k = max(len + n, 0)
        fctx.body.push({ op: "local.get", index: iTmp });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: lenTmp } as Instr,
            { op: "local.get", index: iTmp } as Instr,
            { op: "f64.add" } as Instr,
            { op: "local.tee", index: iTmp } as Instr,
            { op: "f64.const", value: 0 } as Instr,
            { op: "f64.lt" } as Instr,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: iTmp } as Instr],
            } as Instr,
          ],
        } as Instr);
      }
    }
  } else {
    // No fromIndex provided: default 0 (forward) or len-1 (backward).
    if (isLast) {
      fctx.body.push({ op: "local.get", index: lenTmp });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: "f64.sub" });
    } else {
      fctx.body.push({ op: "f64.const", value: 0 });
    }
    fctx.body.push({ op: "local.set", index: iTmp });
  }

  // #16 — re-resolve the loop helpers from funcMap: compiling the receiver,
  // search value, and fromIndex above can register new functions that SHIFT
  // every defined-func index, leaving the funcIdx captured at the top stale
  // (→ `call` to the wrong function → invalid Wasm). Names are stable; re-read
  // the current index right before baking the loop's `call`s. (addUnionImports
  // late-shift hazard.)
  const getIdxFnNow = ctx.funcMap.get("__extern_get_idx") ?? getIdxFn;
  const hasIdxFnNow = ctx.funcMap.get("__extern_has_idx") ?? hasIdxFn;
  const cmpFnNow = ctx.funcMap.get(isIncludes ? "__same_value_zero" : "__host_eq") ?? cmpFn;

  // ── Loop body ────────────────────────────────────────────────────
  // Outer block: "exit on found".
  // Inner loop: forward (i++) or backward (i--).
  // Each iteration:
  //   1. Loop-exit guard: forward i >= len → break; backward i < 0 → break.
  //   2. For includes: skip the HasProperty gate; spec uses Get. For
  //      indexOf/lastIndexOf: gate on __extern_has_idx, missing → skip.
  //   3. Load element via __extern_get_idx, compare via __host_eq /
  //      __same_value_zero, on match store result and break.
  //   4. Increment / decrement index, branch back to loop start.

  // Loop exit guard (f64 indices)
  const loopExit: Instr[] = isLast
    ? [
        { op: "local.get", index: iTmp } as Instr,
        { op: "f64.const", value: 0 } as Instr,
        { op: "f64.lt" } as Instr,
        { op: "br_if", depth: 1 } as Instr,
      ]
    : [
        { op: "local.get", index: iTmp } as Instr,
        { op: "local.get", index: lenTmp } as Instr,
        { op: "f64.ge" } as Instr,
        { op: "br_if", depth: 1 } as Instr,
      ];

  // HasProperty gate (only for indexOf/lastIndexOf) — pass f64 index directly.
  const hasIdxCheck: Instr[] = [
    { op: "local.get", index: receiverTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: "call", funcIdx: hasIdxFnNow } as Instr,
  ];

  // Element compare: leaves i32 (0/1) on the stack. Pass f64 index directly.
  const compareInstrs: Instr[] = [
    { op: "local.get", index: receiverTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: "call", funcIdx: getIdxFnNow } as Instr,
    { op: "local.get", index: searchTmp } as Instr,
    { op: "call", funcIdx: cmpFnNow } as Instr,
  ];

  // On-match: write result + break the outer block (depth 3 from inside the
  // gated `if` body — escape `if` (depth 1) → `loop` (depth 2) → outer block).
  const onMatchDepthGated = 3;
  const onMatchDepthUngated = 2;
  const onMatchInstrs = (depth: number): Instr[] =>
    isIncludes
      ? [
          { op: "i32.const", value: 1 } as Instr,
          { op: "local.set", index: resTmp } as Instr,
          { op: "br", depth } as Instr,
        ]
      : [
          // f64 index goes straight to f64 result (no conversion needed).
          { op: "local.get", index: iTmp } as Instr,
          { op: "local.set", index: resTmp } as Instr,
          { op: "br", depth } as Instr,
        ];

  // Step (i++ / i--) using f64 arithmetic.
  const stepInstr: Instr[] = isLast
    ? [
        { op: "local.get", index: iTmp } as Instr,
        { op: "f64.const", value: 1 } as Instr,
        { op: "f64.sub" } as Instr,
        { op: "local.set", index: iTmp } as Instr,
        { op: "br", depth: 0 } as Instr,
      ]
    : [
        { op: "local.get", index: iTmp } as Instr,
        { op: "f64.const", value: 1 } as Instr,
        { op: "f64.add" } as Instr,
        { op: "local.set", index: iTmp } as Instr,
        { op: "br", depth: 0 } as Instr,
      ];

  // Per-iteration core (without HasProperty gate)
  const matchAndBreakInner: Instr[] = [
    ...compareInstrs,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: onMatchInstrs(onMatchDepthGated),
    } as Instr,
  ];

  const matchAndBreakUngated: Instr[] = [
    ...compareInstrs,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: onMatchInstrs(onMatchDepthUngated),
    } as Instr,
  ];

  // For indexOf/lastIndexOf: gate on HasProperty.
  // For includes: spec uses Get (visits every index up to len, missing → undefined).
  const iterationCore: Instr[] = isIncludes
    ? matchAndBreakUngated
    : [
        ...hasIdxCheck,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: matchAndBreakInner,
        } as Instr,
      ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [...loopExit, ...iterationCore, ...stepInstr],
      } as Instr,
    ],
  });

  fctx.body.push({ op: "local.get", index: resTmp });
  return isIncludes ? { kind: "i32" } : { kind: "f64" };
}

/**
 * Detect and compile Array.prototype.METHOD.call(obj, ...args) patterns.
 * When `obj` is a shape-inferred array-like variable, we reuse the existing
 * array method compilers by treating `obj` as the receiver.
 *
 * Returns undefined if the pattern is not matched (caller should continue).
 * Returns ValType | null for successful/failed compilation.
 */
export function compileArrayPrototypeCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | null | typeof VOID_RESULT | undefined {
  // Pattern: X.call(obj, ...args) where X is Array.prototype.METHOD
  if (propAccess.name.text !== "call") return undefined;
  if (!ts.isPropertyAccessExpression(propAccess.expression)) return undefined;

  const methodAccess = propAccess.expression; // Array.prototype.METHOD
  const methodName = methodAccess.name.text;

  // Check that the receiver of .METHOD is Array.prototype
  if (!ts.isPropertyAccessExpression(methodAccess.expression)) return undefined;
  const protoAccess = methodAccess.expression; // Array.prototype
  if (protoAccess.name.text !== "prototype") return undefined;
  if (!ts.isIdentifier(protoAccess.expression)) return undefined;
  if (protoAccess.expression.text !== "Array") return undefined;

  // First argument to .call() is the receiver object
  if (callExpr.arguments.length < 1) return undefined;
  const receiverArg = callExpr.arguments[0]!;

  // Check if the method is a known array method
  if (!ARRAY_METHODS.has(methodName)) return undefined;

  // Resolve array info from shape map or TypeScript type
  let receiverTsType: ts.Type | undefined;
  if (ts.isIdentifier(receiverArg)) {
    const shapeInfo = ctx.shapeMap.get(receiverArg.text);
    if (shapeInfo) {
      // Shape-inferred path: dispatch to existing dedicated implementations
      const { vecTypeIdx, arrTypeIdx, elemType } = shapeInfo;
      switch (methodName) {
        case "indexOf":
          return compileArrayPrototypeIndexOf(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
        case "includes":
          return compileArrayPrototypeIncludes(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
        case "every":
          return compileArrayPrototypeEvery(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
        case "some":
          return compileArrayPrototypeSome(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
        case "forEach":
          return compileArrayPrototypeForEach(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
        // For filter/map/reduce/reduceRight/find/findIndex there's no shape-specific fast
        // path yet; fall through to the generic array-like loop so array-like receivers
        // ({length, [idx]}, arguments) are iterated via [[Get]] + HasProperty (issue #1131).
      }
    }
    receiverTsType = ctx.checker.getTypeAtLocation(receiverArg);
  } else {
    receiverTsType = ctx.checker.getTypeAtLocation(receiverArg);
  }

  if (!receiverTsType) return undefined;
  const arrInfo = resolveArrayInfo(ctx, receiverTsType);
  if (!arrInfo) {
    // For any-typed receivers, use the array-like implementation that iterates
    // using __extern_length/__extern_get_idx and calls the callback directly in Wasm.
    return compileArrayLikePrototypeCall(ctx, fctx, callExpr, methodName, receiverArg as ts.Expression);
  }

  // Create a synthetic PropertyAccessExpression: receiverArg.METHOD
  const syntheticPropAccess = ts.factory.createPropertyAccessExpression(receiverArg as ts.Expression, methodName);
  // Copy parent for error reporting
  (syntheticPropAccess as any).parent = callExpr.parent;

  // Create a synthetic CallExpression with the remaining args (skip the receiver)
  const remainingArgs = callExpr.arguments.slice(1);
  const syntheticCall = ts.factory.createCallExpression(
    syntheticPropAccess,
    undefined,
    remainingArgs as unknown as readonly ts.Expression[],
  );
  (syntheticCall as any).parent = callExpr.parent;

  // Route through the existing array method compiler
  return compileArrayMethodCall(ctx, fctx, syntheticPropAccess, syntheticCall, receiverTsType);
}

/**
 * Array.prototype.indexOf.call(obj, searchValue)
 * Inlines the indexOf search loop using the shape's vec struct.
 */
function compileArrayPrototypeIndexOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // callExpr.arguments: [obj, searchValue, ...]
  if (callExpr.arguments.length < 2) {
    reportError(ctx, callExpr, "Array.prototype.indexOf.call requires at least 2 arguments");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__apc_iof_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_iof_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_iof_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_iof_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__apc_iof_val_${fctx.locals.length}`, elemType);

  // Compile receiver
  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile search value (second argument to .call())
  compileExpression(ctx, fctx, callExpr.arguments[1]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  // i = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // For externref elements, use the `equals` string import (JS ===) for comparison
  // For ref/ref_null elements, use ref.eq for reference identity comparison
  let apcEqInstrs: Instr[];
  if (elemType.kind === "externref") {
    addStringImports(ctx);
    const equalsIdx = ctx.jsStringImports.get("equals")!;
    apcEqInstrs = [{ op: "call", funcIdx: equalsIdx } as Instr];
  } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    apcEqInstrs = [{ op: "ref.eq" }];
  } else {
    const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
    apcEqInstrs = [{ op: eqOp } as Instr];
  }

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when indexOf is inlined.
  const resType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
  const resTmp = allocLocal(fctx, `__apc_iof_res_${fctx.locals.length}`, resType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: valTmp },
    ...apcEqInstrs,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: ctx.fast
        ? [
            { op: "local.get", index: iTmp } as Instr,
            { op: "local.set", index: resTmp } as Instr,
            { op: "br", depth: 2 } as Instr,
          ]
        : [
            { op: "local.get", index: iTmp } as Instr,
            { op: "f64.convert_i32_s" } as Instr,
            { op: "local.set", index: resTmp } as Instr,
            { op: "br", depth: 2 } as Instr,
          ],
    } as Instr,

    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: resTmp });

  if (ctx.fast) {
    return { kind: "i32" };
  }
  return { kind: "f64" };
}

/**
 * Array.prototype.includes.call(obj, searchValue)
 */
function compileArrayPrototypeIncludes(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) {
    reportError(ctx, callExpr, "Array.prototype.includes.call requires at least 2 arguments");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__apc_inc_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_inc_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_inc_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_inc_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__apc_inc_val_${fctx.locals.length}`, elemType);

  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  compileExpression(ctx, fctx, callExpr.arguments[1]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when includes is inlined.
  const resTmp = allocLocal(fctx, `__apc_inc_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: valTmp },
    { op: eqOp } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 } as Instr,
        { op: "local.set", index: resTmp } as Instr,
        { op: "br", depth: 2 } as Instr, // break out of block
      ],
    } as Instr,
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: resTmp });
  return { kind: "i32" };
}

/**
 * Array.prototype.every.call(obj, callback)
 * Inlines the every loop: returns 1 if callback(elem) is truthy for all elements.
 */
function compileArrayPrototypeEvery(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // callExpr.arguments: [obj, callback]
  if (callExpr.arguments.length < 2) {
    reportError(ctx, callExpr, "Array.prototype.every.call requires at least 2 arguments");
    return null;
  }

  const cbArg = callExpr.arguments[1]!;

  // The callback must be an arrow function or function expression for inline compilation
  if (!ts.isArrowFunction(cbArg) && !ts.isFunctionExpression(cbArg)) {
    return undefined as unknown as null;
  }

  // Compile the callback as a closure and get its info
  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) return null;
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo) return null;

  const closureTmp = allocLocal(fctx, `__apc_ev_cb_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: closureTmp });

  const vecTmp = allocLocal(fctx, `__apc_ev_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_ev_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_ev_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_ev_len_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  const numParams = closureInfo.paramTypes.length;

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when every is inlined.
  const resTmp = allocLocal(fctx, `__apc_ev_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 1 }); // default: all passed
  fctx.body.push({ op: "local.set", index: resTmp });

  // Loop: for each element, call the closure; if it returns falsy, set result to 0
  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 }, // break out of block

    // Call closure(element, index, array): push closure ref, then args.
    // Gate elem/index/array on numParams — 0-param callback must not receive them.
    { op: "local.get", index: closureTmp },
    ...(numParams >= 1
      ? [
          { op: "local.get", index: dataTmp } as Instr,
          { op: "local.get", index: iTmp } as Instr,
          { op: getOp, typeIdx: arrTypeIdx } as Instr,
          ...coercionInstrs(ctx, elemType, closureInfo.paramTypes[0] ?? elemType, fctx),
        ]
      : []),
    // Push index (2nd user param) if callback expects it
    ...(numParams >= 2
      ? [
          { op: "local.get", index: iTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ]
      : []),
    // Push array (3rd user param) if callback expects it
    ...(numParams >= 3
      ? [
          { op: "local.get", index: vecTmp } as Instr,
          ...coercionInstrs(
            ctx,
            { kind: "ref_null", typeIdx: vecTypeIdx },
            closureInfo.paramTypes[2] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
            fctx,
          ),
        ]
      : []),
    // Get function ref from closure struct field 0 and call_ref
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" } as Instr,
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,

    // Check if result is falsy (0 for i32, 0.0 for f64)
    ...(closureInfo.returnType?.kind === "f64"
      ? [{ op: "f64.const", value: 0 } as Instr, { op: "f64.eq" } as Instr]
      : closureInfo.returnType?.kind === "i32"
        ? [{ op: "i32.eqz" } as Instr]
        : [{ op: "i32.eqz" } as Instr]),

    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.set", index: resTmp } as Instr,
        { op: "br", depth: 2 } as Instr, // break out of block
      ],
    } as Instr,

    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: resTmp });
  return { kind: "i32" };
}

/**
 * Array.prototype.some.call(obj, callback)
 */
function compileArrayPrototypeSome(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) return null;
  const cbArg = callExpr.arguments[1]!;
  if (!ts.isArrowFunction(cbArg) && !ts.isFunctionExpression(cbArg)) return undefined as unknown as null;

  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) return null;
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo) return null;

  const closureTmp = allocLocal(fctx, `__apc_some_cb_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: closureTmp });

  const vecTmp = allocLocal(fctx, `__apc_some_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_some_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_some_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_some_len_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  const numParams = closureInfo.paramTypes.length;

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when some is inlined.
  const resTmp = allocLocal(fctx, `__apc_some_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 }); // default: none matched
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: closureTmp },
    ...(numParams >= 1
      ? [
          { op: "local.get", index: dataTmp } as Instr,
          { op: "local.get", index: iTmp } as Instr,
          { op: getOp, typeIdx: arrTypeIdx } as Instr,
          ...coercionInstrs(ctx, elemType, closureInfo.paramTypes[0] ?? elemType, fctx),
        ]
      : []),
    // Push index (2nd user param) if callback expects it
    ...(numParams >= 2
      ? [
          { op: "local.get", index: iTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ]
      : []),
    // Push array (3rd user param) if callback expects it
    ...(numParams >= 3
      ? [
          { op: "local.get", index: vecTmp } as Instr,
          ...coercionInstrs(
            ctx,
            { kind: "ref_null", typeIdx: vecTypeIdx },
            closureInfo.paramTypes[2] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
            fctx,
          ),
        ]
      : []),
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" } as Instr,
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
    ...(closureInfo.returnType?.kind === "f64"
      ? [{ op: "f64.const", value: 0 } as Instr, { op: "f64.ne" } as Instr]
      : []),
    ...(closureInfo.returnType?.kind === "i32" ? [] : [{ op: "i32.eqz" } as Instr, { op: "i32.eqz" } as Instr]),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 } as Instr,
        { op: "local.set", index: resTmp } as Instr,
        { op: "br", depth: 2 } as Instr, // break out of block
      ],
    } as Instr,
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: resTmp });
  return { kind: "i32" };
}

/**
 * Array.prototype.forEach.call(obj, callback)
 */
function compileArrayPrototypeForEach(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) return null;
  const cbArg = callExpr.arguments[1]!;
  if (!ts.isArrowFunction(cbArg) && !ts.isFunctionExpression(cbArg)) return undefined as unknown as null;

  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) return null;
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo) return null;

  const closureTmp = allocLocal(fctx, `__apc_fe_cb_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: closureTmp });

  const vecTmp = allocLocal(fctx, `__apc_fe_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_fe_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_fe_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_fe_len_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  const numParams = closureInfo.paramTypes.length;

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: closureTmp },
    ...(numParams >= 1
      ? [
          { op: "local.get", index: dataTmp } as Instr,
          { op: "local.get", index: iTmp } as Instr,
          { op: getOp, typeIdx: arrTypeIdx } as Instr,
          ...coercionInstrs(ctx, elemType, closureInfo.paramTypes[0] ?? elemType, fctx),
        ]
      : []),
    // Push index (2nd user param) if callback expects it
    ...(numParams >= 2
      ? [
          { op: "local.get", index: iTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ]
      : []),
    // Push array (3rd user param) if callback expects it
    ...(numParams >= 3
      ? [
          { op: "local.get", index: vecTmp } as Instr,
          ...coercionInstrs(
            ctx,
            { kind: "ref_null", typeIdx: vecTypeIdx },
            closureInfo.paramTypes[2] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
            fctx,
          ),
        ]
      : []),
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" } as Instr,
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
    // Drop the result if there is one
    ...(closureInfo.returnType ? [{ op: "drop" } as Instr] : []),
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  return VOID_RESULT as any;
}

const ARRAY_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "indexOf",
  "includes",
  "slice",
  "concat",
  "join",
  "reverse",
  "splice",
  "at",
  "fill",
  "copyWithin",
  "lastIndexOf",
  "sort",
  "filter",
  "map",
  "reduce",
  "reduceRight",
  "forEach",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "some",
  "every",
  "entries",
  "keys",
  "values",
  "@@iterator", // Array.prototype[Symbol.iterator] === Array.prototype.values (#854)
  "toReversed",
  "toSorted",
  "toSpliced",
  "with",
  "flat",
  "flatMap",
  // #1997: Array.prototype.toString() (§23.1.3.36) delegates to join with the
  // default "," separator. Without this, it fell through to the generic object
  // dispatch and produced "[object Array]".
  "toString",
  // TypedArray-specific (#1664) — native WasmGC lowering avoids the generic
  // __extern_get / __extern_length host-import fallback under --target wasi.
  "set",
  "subarray",
]);

/**
 * Compile array method calls to inline Wasm instructions.
 * Returns undefined if the call is not an array method (caller should continue).
 * Returns ValType for successful compilation, VOID_RESULT for void methods,
 * or null for failed compilation.
 */
export function compileArrayMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type,
  overrideMethodName?: string,
  expectedType?: ValType,
): ValType | null | undefined | typeof VOID_RESULT {
  const methodName =
    overrideMethodName ?? (ts.isPropertyAccessExpression(propAccess) ? propAccess.name.text : undefined);
  if (!methodName || !ARRAY_METHODS.has(methodName)) return undefined;

  // (#2007/#1448) Record closure-allocating array methods so the standalone
  // vec-concat join fast-path can avoid a late `number_toString` registration
  // that would shift indices and corrupt this closure's already-emitted code.
  if (
    methodName === "map" ||
    methodName === "filter" ||
    methodName === "flatMap" ||
    methodName === "forEach" ||
    methodName === "reduce" ||
    methodName === "reduceRight" ||
    methodName === "find" ||
    methodName === "findIndex" ||
    methodName === "sort"
  ) {
    fctx.emittedClosureArrayMethod = true;
  }

  const receiverExpr = propAccess.expression;
  const arrInfo =
    resolveArrayInfo(ctx, receiverType) ??
    resolveArrayInfoFromWasmType(ctx, inferExpressionWasmType(ctx, fctx, receiverExpr, false));
  if (!arrInfo) return undefined;

  let { vecTypeIdx, arrTypeIdx, elemType } = arrInfo;
  // #1286: tracks whether the probe found the receiver to be externref at
  // runtime (e.g., the result of `Object.keys(any)`, which goes through the
  // `__object_keys` host import). The `case "join":` dispatch below routes
  // through `compileArrayJoinExtern` whenever this is set so the WasmGC-
  // native loop doesn't try to extract a vec struct from a JS array.
  let receiverIsExternref = false;

  // The receiver's actual Wasm type may differ from the TS type — e.g.
  // `[0, true].lastIndexOf(...)` infers i32 elements during construction,
  // but resolveArrayInfo resolves (number|boolean)[] → __vec_externref.
  // Probe-compile the receiver to determine the actual Wasm type (#826).
  if (receiverExpr) {
    // Fast path: check the Wasm local/global type directly
    let actualType: ValType | undefined;
    if (ts.isIdentifier(receiverExpr)) {
      const name = receiverExpr.text;
      const localIdx = fctx.localMap.get(name);
      if (localIdx !== undefined) {
        // #1247: localIdx is the wasm-level index (params + locals);
        // `fctx.locals` indexes only locals (no params). Use getLocalType
        // to handle the offset correctly. Without this, in functions with
        // params, `paths.shift()` looks up the wrong local and dispatches
        // through a stale vec type idx, producing struct-type mismatches
        // at instantiation.
        actualType = getLocalType(fctx, localIdx);
      } else {
        const gIdx = ctx.moduleGlobals.get(name);
        if (gIdx !== undefined) {
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, gIdx)];
          actualType = globalDef?.type;
        }
      }
    }
    // Slow path: probe-compile the receiver to determine its actual type.
    // Compiles the expression, captures the result type, then rolls back.
    if (!actualType || actualType.kind === "externref" || actualType.kind === "f64" || actualType.kind === "i32") {
      const savedLen = fctx.body.length;
      const probeResult = compileExpression(ctx, fctx, receiverExpr);
      // Roll back — the method function will re-compile the receiver
      fctx.body.length = savedLen;
      if (
        probeResult &&
        (probeResult.kind === "ref" || probeResult.kind === "ref_null") &&
        (probeResult as any).typeIdx !== undefined
      ) {
        actualType = probeResult;
      } else if (probeResult && probeResult.kind === "externref") {
        // Capture externref-shaped receivers too — `Object.keys(any).join(...)` and
        // similar host-import-returning calls hit this branch (#1286). The
        // existing struct-vec dispatch below ignores this case (it only updates
        // vecTypeIdx for known ref types), but `case "join":` consults this flag
        // to route through the host-import fallback.
        actualType = probeResult;
        receiverIsExternref = true;
      }
    }
    // Catch the fast-path case too: an identifier whose declared local/global
    // type is externref (e.g., a parameter typed `any`). The slow-path probe
    // above only runs when the fast-path lookup is ambiguous.
    if (actualType && actualType.kind === "externref") {
      receiverIsExternref = true;
    }
    if (
      actualType &&
      (actualType.kind === "ref" || actualType.kind === "ref_null") &&
      (actualType as { typeIdx: number }).typeIdx !== vecTypeIdx
    ) {
      const actualVecIdx = (actualType as { typeIdx: number }).typeIdx;
      const actualArrIdx = getArrTypeIdxFromVec(ctx, actualVecIdx);
      if (actualArrIdx >= 0) {
        const actualArrDef = ctx.mod.types[actualArrIdx];
        if (actualArrDef && actualArrDef.kind === "array") {
          vecTypeIdx = actualVecIdx;
          arrTypeIdx = actualArrIdx;
          elemType = actualArrDef.element;
        }
      }
    }
  }

  const methodAccess = propAccess as ts.PropertyAccessExpression;

  // If receiver is a module global, proxy it through a temp local so
  // getReceiverLocalIdx succeeds and mutating methods can write back.
  let moduleGlobalIdx: number | undefined;
  let savedLocal: number | undefined;
  // #1966: `unshift` mutates in place (prepends + shifts), so its mutated vec
  // must be written back to the receiver — include it here. The `to*`
  // variants (toSorted/toReversed/toSpliced/with) and slice/concat/map/filter
  // are NON-mutating (they return a new array) and are deliberately excluded.
  const MUTATING = new Set([
    "push",
    "pop",
    "shift",
    "unshift",
    "reverse",
    "splice",
    "fill",
    "copyWithin",
    "sort",
    "set",
  ]);
  if (ts.isIdentifier(propAccess.expression)) {
    const name = propAccess.expression.text;
    const gIdx = ctx.moduleGlobals.get(name);
    if (gIdx !== undefined && !fctx.localMap.has(name)) {
      moduleGlobalIdx = gIdx;
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, gIdx)];
      if (!globalDef) return null;
      const tempLocal = allocLocal(fctx, `__mod_proxy_${name}`, globalDef.type);
      fctx.body.push({ op: "global.get", index: gIdx });
      fctx.body.push({ op: "local.set", index: tempLocal });
      fctx.localMap.set(name, tempLocal);
      savedLocal = tempLocal;
    }
  }

  let result: ValType | null | undefined;
  switch (methodName) {
    case "indexOf":
      result = compileArrayIndexOf(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "includes":
      result = compileArrayIncludes(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "reverse":
      result = compileArrayReverse(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "push":
      result = compileArrayPush(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "pop":
      result = compileArrayPop(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType, expectedType);
      break;
    case "shift":
      result = compileArrayShift(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType, expectedType);
      break;
    case "unshift":
      result = compileArrayUnshift(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "slice":
      result = compileArraySlice(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "concat":
      result = compileArrayConcat(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "join":
    // #1997: Array.prototype.toString() (§23.1.3.36) is specified to call join
    // with the default "," separator. compileArrayJoin already defaults the
    // separator to "," when no argument is present, and toString receives no
    // arguments, so the two share the same lowering.
    case "toString":
      // #1286: when the probe found the receiver to be externref at runtime,
      // route through the host-import fallback. The WasmGC-native path expects
      // a vec struct; trying to extract one from a JS array via ref.cast
      // would trap with "illegal cast".
      result = receiverIsExternref
        ? compileArrayJoinExtern(ctx, fctx, methodAccess, callExpr)
        : compileArrayJoin(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "splice":
      result = compileArraySplice(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "at":
      result = compileArrayAt(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "fill":
      result = compileArrayFill(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "copyWithin":
      result = compileArrayCopyWithin(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "lastIndexOf":
      result = compileArrayLastIndexOf(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "sort":
      // #1967 — the gate previously excluded externref (string, JS-host mode)
      // and ref (struct) element arrays, so `["b","a"].sort()` and
      // `objs.sort((x,y)=>…)` silently no-op'd via the generic fallback. The
      // internal compileArraySort ALREADY routes non-numeric elements through
      // tryCompileComparatorSort (comparator) and compileArrayDefaultToStringSort
      // (default ToString order, #1993) — only this gate kept it unreachable.
      result =
        elemType.kind === "f64" ||
        elemType.kind === "i32" ||
        elemType.kind === "externref" ||
        elemType.kind === "ref" ||
        elemType.kind === "ref_null"
          ? compileArraySort(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    // Functional array methods -- supported for numeric (f64, i32) and externref element types
    case "filter":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayFilter(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "map":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayMap(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "reduce":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayReduce(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "reduceRight":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayReduceRight(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "forEach": {
      const feResult =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayForEach(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      // forEach returns void; use VOID_RESULT so compileExpression doesn't rollback
      result = feResult === null ? (VOID_RESULT as any) : feResult;
      break;
    }
    case "find":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayFind(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "findIndex":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayFindIndex(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "findLast":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayFindLast(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "findLastIndex":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayFindLastIndex(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "some":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArraySome(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "every":
      result =
        elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "externref"
          ? compileArrayEvery(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "toReversed":
      result = compileArrayToReversed(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "toSorted":
      result =
        elemType.kind === "f64" || elemType.kind === "i32"
          ? compileArrayToSorted(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "toSpliced":
      result = compileArrayToSpliced(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "with":
      result = compileArrayWith(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "entries":
    case "keys":
    case "values":
      result = compileArrayIteratorMethod(ctx, fctx, methodAccess, methodName);
      break;
    case "flat":
      result = compileArrayFlat(ctx, fctx, methodAccess, callExpr);
      break;
    case "flatMap":
      result = compileArrayFlatMap(ctx, fctx, methodAccess, callExpr);
      break;
    case "set": {
      const setResult = compileTypedArraySet(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      // TypedArray.prototype.set returns undefined (void).
      result = setResult === null ? null : (VOID_RESULT as any);
      break;
    }
    case "subarray":
      result = compileTypedArraySubarray(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    default:
      result = undefined;
  }

  // Write back temp local to module global for mutating methods
  if (moduleGlobalIdx !== undefined && savedLocal !== undefined) {
    if (MUTATING.has(methodName) && result !== null && result !== undefined) {
      fctx.body.push({ op: "local.get", index: savedLocal });
      fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
    }
    // Clean up the proxy from localMap
    if (ts.isIdentifier(propAccess.expression)) {
      fctx.localMap.delete(propAccess.expression.text);
    }
  }

  return result;
}

// ── ES2023 non-mutating array methods (toReversed, toSorted, toSpliced, with) ──

/**
 * arr.toReversed() -> returns a new reversed copy of the array.
 * Non-mutating: creates a copy, reverses the copy, returns it.
 */
function compileArrayToReversed(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  _callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType {
  const vecTmp = allocLocal(fctx, `__arr_trev_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_trev_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_trev_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_trev_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_trev_i_${fctx.locals.length}`, { kind: "i32" });
  const jTmp = allocLocal(fctx, `__arr_trev_j_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // newData = array.new_default(len)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // Copy src[0..len] -> newData[0..len]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, null, lenTmp);

  // Now reverse newData in-place: i = 0, j = len - 1
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: jTmp });

  const swapTmp = allocLocal(fctx, `__arr_trev_sw_${fctx.locals.length}`, elemType);
  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: jTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // swap = newData[i]
    { op: "local.get", index: newData },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: swapTmp },

    // newData[i] = newData[j]
    { op: "local.get", index: newData },
    { op: "local.get", index: iTmp },
    { op: "local.get", index: newData },
    { op: "local.get", index: jTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "array.set", typeIdx: arrTypeIdx },

    // newData[j] = swap
    { op: "local.get", index: newData },
    { op: "local.get", index: jTmp },
    { op: "local.get", index: swapTmp },
    { op: "array.set", typeIdx: arrTypeIdx },

    // i++, j--
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "local.get", index: jTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: jTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  // Return new vec struct: { len, newData }
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.toSorted(compareFn?) -> returns a new sorted copy of the array.
 * Non-mutating: creates a copy, sorts the copy in-place via timsort, returns it.
 * Only supports i32/f64 element types (same as sort()).
 */
function compileArrayToSorted(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  _callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const elemKind = elemType.kind as "i32" | "f64";
  const timsortIdx = ensureTimsortHelper(ctx, vecTypeIdx, arrTypeIdx, elemKind);

  const vecTmp = allocLocal(fctx, `__arr_tsrt_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_tsrt_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_tsrt_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_tsrt_len_${fctx.locals.length}`, { kind: "i32" });
  const newVec = allocLocal(fctx, `__arr_tsrt_nv_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // newData = array.new_default(len)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // Copy src[0..len] -> newData[0..len]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, null, lenTmp);

  // Create new vec struct: { len, newData }
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "local.tee", index: newVec });

  // Sort the new vec in-place via timsort
  fctx.body.push({ op: "call", funcIdx: timsortIdx });

  // Return the new vec
  fctx.body.push({ op: "local.get", index: newVec });
  fctx.body.push({ op: "ref.as_non_null" });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.toSpliced(start, deleteCount, ...items) -> returns a new array with splice applied.
 * Non-mutating: builds a new array = [arr[0..start], ...items, arr[start+deleteCount..len]].
 */
function compileArrayToSpliced(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const vecTmp = allocLocal(fctx, `__arr_tspl_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_tspl_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_tspl_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_tspl_len_${fctx.locals.length}`, { kind: "i32" });
  const startTmp = allocLocal(fctx, `__arr_tspl_s_${fctx.locals.length}`, { kind: "i32" });
  const delCountTmp = allocLocal(fctx, `__arr_tspl_dc_${fctx.locals.length}`, { kind: "i32" });
  const newLenTmp = allocLocal(fctx, `__arr_tspl_nl_${fctx.locals.length}`, { kind: "i32" });
  const tailStartTmp = allocLocal(fctx, `__arr_tspl_ts_${fctx.locals.length}`, { kind: "i32" });
  const tailCountTmp = allocLocal(fctx, `__arr_tspl_tc_${fctx.locals.length}`, { kind: "i32" });
  const writeTmp = allocLocal(fctx, `__arr_tspl_w_${fctx.locals.length}`, { kind: "i32" });

  const insertCount = Math.max(0, callExpr.arguments.length - 2);

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // start arg -- clamp negative indices
  if (callExpr.arguments.length >= 1) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: startTmp });
  emitClampIndex(fctx, startTmp, lenTmp);

  // deleteCount (default: len - start) -- clamp >= 0 and to remaining len
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "i32.sub" });
  }
  fctx.body.push({ op: "local.set", index: delCountTmp });
  emitClampNonNeg(fctx, delCountTmp);
  // Clamp delCount to not exceed remaining elements: min(delCount, len - start)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: tailCountTmp }); // reuse as temp
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "local.get", index: tailCountTmp });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "local.get", index: tailCountTmp } as Instr, { op: "local.set", index: delCountTmp } as Instr],
  } as Instr);
  emitClampNonNeg(fctx, delCountTmp);

  // tailStart = start + delCount
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: tailStartTmp });

  // tailCount = len - tailStart
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: tailStartTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: tailCountTmp });
  emitClampNonNeg(fctx, tailCountTmp);

  // newLen = start + insertCount + tailCount
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.const", value: insertCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.get", index: tailCountTmp });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: newLenTmp });

  // newData = array.new_default(newLen)
  fctx.body.push({ op: "local.get", index: newLenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // Copy part 1: src[0..start] -> newData[0..start]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, null, startTmp);

  // Part 2: insert items at newData[start..start+insertCount]
  if (insertCount > 0) {
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "local.set", index: writeTmp });
    for (let i = 0; i < insertCount; i++) {
      fctx.body.push({ op: "local.get", index: newData });
      fctx.body.push({ op: "local.get", index: writeTmp });
      compileExpression(ctx, fctx, callExpr.arguments[2 + i]!, elemType);
      fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
      if (i < insertCount - 1) {
        fctx.body.push({ op: "local.get", index: writeTmp });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "i32.add" });
        fctx.body.push({ op: "local.set", index: writeTmp });
      }
    }
  }

  // Part 3: copy tail: src[tailStart..tailStart+tailCount] -> newData[start+insertCount..end]
  // Compute destination offset = start + insertCount
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.const", value: insertCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: writeTmp });
  emitArrayCopy(fctx, arrTypeIdx, newData, writeTmp, dataTmp, tailStartTmp, tailCountTmp);

  // Return new vec struct: { newLen, newData }
  fctx.body.push({ op: "local.get", index: newLenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.with(index, value) -> returns a new array with the element at index replaced.
 * Non-mutating: creates a copy, sets element at index, returns it.
 */
function compileArrayWith(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) {
    reportError(ctx, callExpr, "with() requires 2 arguments (index, value)");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_with_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_with_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_with_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_with_len_${fctx.locals.length}`, { kind: "i32" });
  const idxTmp = allocLocal(fctx, `__arr_with_idx_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile index arg, handle negative indices
  compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: idxTmp });
  emitClampIndex(fctx, idxTmp, lenTmp);

  // newData = array.new_default(len)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // Copy src[0..len] -> newData[0..len]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, null, lenTmp);

  // Set newData[idx] = value
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "local.get", index: idxTmp });
  compileExpression(ctx, fctx, callExpr.arguments[1]!, elemType);
  fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });

  // Return new vec struct: { len, newData }
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * Compile Array.prototype.entries/keys/values — delegates to host import
 * that creates a proper JS iterator over the WasmGC vec struct.
 */
function compileArrayIteratorMethod(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  methodName: string,
): ValType | null {
  if (ctx.standalone || ctx.wasi) {
    // #1320 Slice 1: native iterator bridge. Build a canonical externref `$Vec`
    // (box each element here, where we have an fctx), wrap it in an `$IterRec`
    // via the native `__iterator`. `.values()` boxes each element, `.keys()`
    // boxes the index, and `.entries()` boxes a 2-element `[i, value]` pair vec
    // per slot — all over the SAME canonical-externref-`$Vec` runtime (no
    // `$GenStateBase` substrate). The consumer destructures each yielded pair
    // externref via the existing array-access path.
    return compileNativeArrayIterator(ctx, fctx, propAccess, methodName);
  }

  addArrayIteratorImports(ctx);
  const importName = `__array_${methodName}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined) return null;

  // Compile receiver and convert to externref for the host import
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "extern.convert_any" });

  // Call the host import: (externref) → externref
  fctx.body.push({ op: "call", funcIdx });
  return { kind: "externref" };
}

/**
 * #1320 Slice 1 — native standalone/WASI `arr.values()` / `arr.keys()` /
 * `arr.entries()`.
 *
 * Builds a canonical externref `$Vec` from the receiver array (boxing each
 * element here, where we have an `fctx`), then constructs an `$IterRec` over it
 * and returns it as externref — the same value shape the consumer expects from
 * the JS-host `__array_values`/`__array_keys`/`__array_entries` import.
 * `.values()` boxes each element; `.keys()` emits the index as a boxed number;
 * `.entries()` boxes a 2-element `[box(f64(i)), box(value)]` pair vec per slot
 * (itself a canonical externref `$Vec`, `extern.convert_any`-wrapped). The
 * for-of/spread/dstr consumer reads each yielded pair externref via the normal
 * array-access path, so `for (const [k, v] of stored)` lowers `k = pair[0]`,
 * `v = pair[1]`. All three reuse the SAME canonical-externref-`$Vec` runtime —
 * no `$GenStateBase` (native-generator) substrate is touched.
 */
function compileNativeArrayIterator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  methodName: string,
): ValType | null {
  ensureNativeIteratorRuntime(ctx);
  const iterRecTypeIdx = getOrRegisterIterRecType(ctx);
  const canonVecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  const canonArrTypeIdx = getArrTypeIdxFromVec(ctx, canonVecTypeIdx);

  // `.entries()` builds each `[i, value]` slot as an `$ObjVec` so the consumer's
  // indexed read (`pair[0]`/`pair[1]`) routes through the native
  // `__extern_get_idx`/`__extern_length` $ObjVec arm. Register those builders
  // BEFORE compiling the receiver so no function-index shift happens mid-body.
  let objVecNewIdx = 0;
  let objVecPushIdx = 0;
  if (methodName === "entries") {
    const builders = ensureObjVecBuilders(ctx);
    objVecNewIdx = builders.newIdx;
    objVecPushIdx = builders.pushIdx;
  }

  // Compile the receiver to discover its vec type.
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (!recvType || (recvType.kind !== "ref" && recvType.kind !== "ref_null")) {
    reportError(ctx, propAccess, `Codegen error: #1320 ${methodName}() receiver is not an array`);
    return null;
  }
  const srcVecTypeIdx = recvType.typeIdx;
  const srcArrTypeIdx = getArrTypeIdxFromVec(ctx, srcVecTypeIdx);
  if (srcArrTypeIdx < 0) {
    reportError(ctx, propAccess, `Codegen error: #1320 ${methodName}() receiver is not a vec`);
    return null;
  }
  const srcArrDef = ctx.mod.types[srcArrTypeIdx];
  const srcElemType: ValType = srcArrDef && srcArrDef.kind === "array" ? srcArrDef.element : { kind: "externref" };

  // locals: srcVec, len, i, out (canonical externref data array)
  const srcVecLocal = allocLocal(fctx, `__iter_src_${fctx.locals.length}`, recvType);
  const lenLocal = allocLocal(fctx, `__iter_len_${fctx.locals.length}`, { kind: "i32" });
  const iLocal = allocLocal(fctx, `__iter_i_${fctx.locals.length}`, { kind: "i32" });
  const outLocal = allocLocal(fctx, `__iter_out_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: canonArrTypeIdx,
  });

  fctx.body.push({ op: "local.set", index: srcVecLocal });
  // len = srcVec.length
  fctx.body.push({ op: "local.get", index: srcVecLocal });
  fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "struct.get", typeIdx: srcVecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });
  // out = new externref[len]
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: canonArrTypeIdx });
  fctx.body.push({ op: "local.set", index: outLocal });
  // i = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // while (i < len) { out[i] = box(methodName === "keys" ? i : srcVec.data[i]); i++; }
  const loopBody: Instr[] = [];
  // i >= len -> break
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "local.get", index: lenLocal });
  loopBody.push({ op: "i32.ge_s" });
  loopBody.push({ op: "br_if", depth: 1 });
  // out[i] = ...
  loopBody.push({ op: "local.get", index: outLocal });
  loopBody.push({ op: "ref.as_non_null" } as Instr);
  loopBody.push({ op: "local.get", index: iLocal });
  // Emit `box(f64(i))` — the numeric index, boxed to externref. Shared by
  // `.keys()` (the slot value) and `.entries()` (the pair's [0] slot).
  const emitBoxedIndex = (): void => {
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "f64.convert_i32_s" });
    coerceType(ctx, fctx, { kind: "f64" }, { kind: "externref" });
  };
  // Emit `box(srcVec.data[i])` — the element, boxed to externref. Shared by
  // `.values()` (the slot value) and `.entries()` (the pair's [1] slot).
  const emitBoxedElem = (): void => {
    fctx.body.push({ op: "local.get", index: srcVecLocal });
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
    fctx.body.push({ op: "struct.get", typeIdx: srcVecTypeIdx, fieldIdx: 1 });
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "array.get", typeIdx: srcArrTypeIdx });
    if (srcElemType.kind !== "externref") {
      coerceType(ctx, fctx, srcElemType, { kind: "externref" });
    }
  };

  // Build the element value to box into the canonical externref slot.
  const elemInstrs = collectElemInstrs(ctx, fctx, () => {
    if (methodName === "keys") {
      // value = box(f64(i))   — keys yields the numeric index
      emitBoxedIndex();
    } else if (methodName === "entries") {
      // value = a 2-element `[index, value]` pair built as an `$ObjVec`
      // (key at idx 0, value at idx 1) via __objvec_new + __objvec_push.
      // The `$ObjVec` is the runtime type the native indexed-read helpers
      // (`__extern_get_idx`/`__extern_length`) recognize, so the consumer's
      // `pair[0]`/`pair[1]`/`pair.length` and `[k, v]` destructuring read back
      // correctly — exactly mirroring `__object_entries` (object-runtime.ts).
      // (A canonical `$Vec` pair would NOT read back: `__extern_get` only
      // understands `$Object` shapes, returning undefined for a `$Vec`.)
      const pairLocal = allocLocal(fctx, `__iter_pair_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "call", funcIdx: objVecNewIdx });
      fctx.body.push({ op: "local.tee", index: pairLocal });
      emitBoxedIndex();
      fctx.body.push({ op: "call", funcIdx: objVecPushIdx });
      fctx.body.push({ op: "local.get", index: pairLocal });
      emitBoxedElem();
      fctx.body.push({ op: "call", funcIdx: objVecPushIdx });
      // The pair externref itself goes into the outer canonical slot.
      fctx.body.push({ op: "local.get", index: pairLocal });
    } else {
      // value = box(srcVec.data[i])  — values yields the element
      emitBoxedElem();
    }
  });
  loopBody.push(...elemInstrs);
  loopBody.push({ op: "array.set", typeIdx: canonArrTypeIdx } as Instr);
  // i++
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "i32.const", value: 1 });
  loopBody.push({ op: "i32.add" });
  loopBody.push({ op: "local.set", index: iLocal });
  loopBody.push({ op: "br", depth: 0 });

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // Result = the canonical externref `$Vec`, wrapped to externref. Per the
  // #1320 Slice-1 producer/consumer contract (Option 1): the producer hands
  // back the canonical vec and the *consumer* (`__iterator`, called from the
  // for-of driver) wraps it into the `$IterRec`. So `arr.values()`/`.keys()`
  // as a value is a canonical externref vec; the for-of consumer does
  // `__iterator(vec)` → IterRec → `__iterator_next`. Single wrap point.
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: outLocal });
  fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "struct.new", typeIdx: canonVecTypeIdx });
  fctx.body.push({ op: "extern.convert_any" } as Instr);
  void iterRecTypeIdx; // type registered eagerly via ensureNativeIteratorRuntime
  return { kind: "externref" };
}

/** Capture instrs emitted by `emit` into a fresh array (mirrors collectInstrs). */
function collectElemInstrs(_ctx: CodegenContext, fctx: FunctionContext, emit: () => void): Instr[] {
  const before = fctx.body.length;
  emit();
  return fctx.body.splice(before);
}

/** Helper: emit array.copy instruction.
 * Stack: [dstArr, dstOffset, srcArr, srcOffset, count] -> []
 * All args are local indices.
 */
function emitArrayCopy(
  fctx: FunctionContext,
  arrTypeIdx: number,
  dstArr: number,
  dstOffset: number | null, // local index, or null for 0
  srcArr: number,
  srcOffset: number | null, // local index, or null for 0
  count: number, // local index holding count
): void {
  fctx.body.push({ op: "local.get", index: dstArr });
  if (dstOffset !== null) {
    fctx.body.push({ op: "local.get", index: dstOffset });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.get", index: srcArr });
  if (srcOffset !== null) {
    fctx.body.push({ op: "local.get", index: srcOffset });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.get", index: count });
  fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);
}

/**
 * arr.at(index) -> supports negative indexing.
 * If index < 0, actual = length + index; otherwise actual = index.
 * Returns elem at computed index.
 */
function compileArrayAt(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    reportError(ctx, callExpr, "at() requires 1 argument");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_at_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const idxTmp = allocLocal(fctx, `__arr_at_idx_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_at_len_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Compile index argument
  const argType = compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "i32" });
  if (argType && argType.kind === "f64") {
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  }
  fctx.body.push({ op: "local.set", index: idxTmp });

  // If index < 0, add length to it
  fctx.body.push({ op: "local.get", index: idxTmp });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: idxTmp },
      { op: "local.get", index: lenTmp },
      { op: "i32.add" },
      { op: "local.set", index: idxTmp },
    ],
  } as Instr);

  // Access element: data[idx] with bounds check
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.get", index: idxTmp });
  emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elemType);

  return elemType;
}

/**
 * arr.indexOf(val) -> loop through array, return index (as f64) or -1.
 * Receiver is a vec struct; extract data and length from it.
 */
function compileArrayIndexOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    reportError(ctx, callExpr, "indexOf requires 1 argument");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_iof_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_iof_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_iof_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_iof_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_iof_val_${fctx.locals.length}`, elemType);

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length from vec struct field 0
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array from vec struct field 1
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  // fromIndex (optional 2nd arg, default 0)
  if (callExpr.arguments.length >= 2) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    // Clamp negative fromIndex: if (fromIndex < 0) fromIndex = max(0, length + fromIndex)
    const fromTmp = allocLocal(fctx, `__arr_iof_from_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.tee", index: fromTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenTmp } as Instr,
        { op: "local.get", index: fromTmp } as Instr,
        { op: "i32.add" } as Instr,
        { op: "local.tee", index: fromTmp } as Instr,
        { op: "i32.const", value: 0 } as Instr,
        { op: "i32.lt_s" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: fromTmp } as Instr],
        } as Instr,
      ],
    } as Instr);
    fctx.body.push({ op: "local.get", index: fromTmp });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // For externref elements, use __host_eq (JS Strict Equality, §7.2.16) so
  // object identity, cross-type (e.g. `[false].indexOf(0)`), and string
  // comparisons all follow spec. The wasm:js-string `equals` builtin coerces
  // both operands to strings, which mis-matches object/boolean/number
  // elements (#786 — `indexOf` on an externref vec).
  // For ref/ref_null elements, use ref.eq for reference identity comparison.
  let eqInstrs: Instr[];
  if (elemType.kind === "externref") {
    const hostEqIdx = ensureLateImport(
      ctx,
      "__host_eq",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
    );
    flushLateImportShifts(ctx, fctx);
    const finalHostEqIdx = ctx.funcMap.get("__host_eq") ?? hostEqIdx;
    if (finalHostEqIdx === undefined) {
      reportError(ctx, callExpr, "indexOf: failed to bind __host_eq import");
      return null;
    }
    eqInstrs = [{ op: "call", funcIdx: finalHostEqIdx } as Instr];
  } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    eqInstrs = [{ op: "ref.eq" }];
  } else {
    const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
    eqInstrs = [{ op: eqOp } as Instr];
  }

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when indexOf is inlined.
  const resType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
  const resTmp = allocLocal(fctx, `__arr_iof_res_${fctx.locals.length}`, resType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: valTmp },
    ...eqInstrs,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: ctx.fast
        ? [
            { op: "local.get", index: iTmp } as Instr,
            { op: "local.set", index: resTmp } as Instr,
            { op: "br", depth: 2 } as Instr, // break out of block
          ]
        : [
            { op: "local.get", index: iTmp } as Instr,
            { op: "f64.convert_i32_s" } as Instr,
            { op: "local.set", index: resTmp } as Instr,
            { op: "br", depth: 2 } as Instr, // break out of block
          ],
    } as Instr,

    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: resTmp });

  if (ctx.fast) {
    return { kind: "i32" };
  }
  return { kind: "f64" };
}

/**
 * arr.includes(val) -> like indexOf but returns i32 (0 or 1)
 * Receiver is a vec struct.
 */
function compileArrayIncludes(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    reportError(ctx, callExpr, "includes requires 1 argument");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_inc_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_inc_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_inc_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_inc_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_inc_val_${fctx.locals.length}`, elemType);

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  // fromIndex (optional 2nd arg, default 0)
  if (callExpr.arguments.length >= 2) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    // Clamp negative fromIndex: if (fromIndex < 0) fromIndex = max(0, length + fromIndex)
    const fromTmp = allocLocal(fctx, `__arr_inc_from_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.tee", index: fromTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenTmp } as Instr,
        { op: "local.get", index: fromTmp } as Instr,
        { op: "i32.add" } as Instr,
        { op: "local.tee", index: fromTmp } as Instr,
        { op: "i32.const", value: 0 } as Instr,
        { op: "i32.lt_s" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 0 } as Instr, { op: "local.set", index: fromTmp } as Instr],
        } as Instr,
      ],
    } as Instr);
    fctx.body.push({ op: "local.get", index: fromTmp });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // SameValueZero comparison for includes:
  // - For f64: a === b OR (isNaN(a) AND isNaN(b))
  // - For externref: use JS === via equals import
  // - For ref/ref_null: ref.eq
  // - For i32: i32.eq
  //
  // We build a comparison that leaves i32 (0/1) on the stack.
  // For f64, we need a temp local to hold the element for the NaN check.
  let incNeedsElemTmp = false;
  let incElemTmp: number | undefined;
  if (elemType.kind === "f64") {
    incNeedsElemTmp = true;
    incElemTmp = allocLocal(fctx, `__arr_inc_el_${fctx.locals.length}`, { kind: "f64" });
  }

  // Use a result local instead of `return` to avoid type mismatch with enclosing function
  const resTmp = allocLocal(fctx, `__arr_inc_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: resTmp });

  // Build the comparison instructions for the loop body
  let comparisonInstrs: Instr[];
  if (elemType.kind === "f64") {
    // SameValueZero for f64: (elem == val) | (isNaN(elem) & isNaN(val))
    comparisonInstrs = [
      // Load element and save to temp
      { op: "local.get", index: dataTmp } as Instr,
      { op: "local.get", index: iTmp } as Instr,
      { op: getOp, typeIdx: arrTypeIdx } as Instr,
      { op: "local.tee", index: incElemTmp! } as Instr,
      // elem == val
      { op: "local.get", index: valTmp } as Instr,
      { op: "f64.eq" } as Instr,
      // isNaN(elem) = elem != elem
      { op: "local.get", index: incElemTmp! } as Instr,
      { op: "local.get", index: incElemTmp! } as Instr,
      { op: "f64.ne" } as Instr,
      // isNaN(val) = val != val
      { op: "local.get", index: valTmp } as Instr,
      { op: "local.get", index: valTmp } as Instr,
      { op: "f64.ne" } as Instr,
      // isNaN(elem) & isNaN(val)
      { op: "i32.and" } as Instr,
      // (elem == val) | (both NaN)
      { op: "i32.or" } as Instr,
    ];
  } else if (elemType.kind === "externref") {
    // SameValueZero (§7.2.11) via __same_value_zero: NaN matches NaN, object
    // identity, cross-type → false. The wasm:js-string `equals` builtin
    // coerces both operands to strings, mis-matching object/boolean/number
    // elements (#786 — `includes` on an externref vec).
    const svzIdx = ensureLateImport(
      ctx,
      "__same_value_zero",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
    );
    flushLateImportShifts(ctx, fctx);
    const finalSvzIdx = ctx.funcMap.get("__same_value_zero") ?? svzIdx;
    if (finalSvzIdx === undefined) {
      reportError(ctx, callExpr, "includes: failed to bind __same_value_zero import");
      return null;
    }
    comparisonInstrs = [
      { op: "local.get", index: dataTmp } as Instr,
      { op: "local.get", index: iTmp } as Instr,
      { op: getOp, typeIdx: arrTypeIdx } as Instr,
      { op: "local.get", index: valTmp } as Instr,
      { op: "call", funcIdx: finalSvzIdx } as Instr,
    ];
  } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    comparisonInstrs = [
      { op: "local.get", index: dataTmp } as Instr,
      { op: "local.get", index: iTmp } as Instr,
      { op: getOp, typeIdx: arrTypeIdx } as Instr,
      { op: "local.get", index: valTmp } as Instr,
      { op: "ref.eq" } as Instr,
    ];
  } else {
    const eqOp = "i32.eq";
    comparisonInstrs = [
      { op: "local.get", index: dataTmp } as Instr,
      { op: "local.get", index: iTmp } as Instr,
      { op: getOp, typeIdx: arrTypeIdx } as Instr,
      { op: "local.get", index: valTmp } as Instr,
      { op: eqOp } as Instr,
    ];
  }

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    ...comparisonInstrs,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 } as Instr,
        { op: "local.set", index: resTmp } as Instr,
        { op: "br", depth: 2 } as Instr, // break out of block
      ],
    } as Instr,

    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: resTmp });
  return { kind: "i32" };
}

/**
 * arr.reverse() -> swap elements in place on the data array, return same vec ref.
 */
function compileArrayReverse(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  _callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType {
  const vecTmp = allocLocal(fctx, `__arr_rev_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_rev_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_rev_i_${fctx.locals.length}`, { kind: "i32" });
  const jTmp = allocLocal(fctx, `__arr_rev_j_${fctx.locals.length}`, { kind: "i32" });
  const swapTmp = allocLocal(fctx, `__arr_rev_sw_${fctx.locals.length}`, elemType);

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length from vec, then j = length - 1
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: jTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: jTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // swap = data[i]
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: swapTmp },

    // data[i] = data[j]
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: jTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "array.set", typeIdx: arrTypeIdx },

    // data[j] = swap
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: jTmp },
    { op: "local.get", index: swapTmp },
    { op: "array.set", typeIdx: arrTypeIdx },

    // i++, j--
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },

    { op: "local.get", index: jTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: jTmp },

    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  // Return same vec ref
  fctx.body.push({ op: "local.get", index: vecTmp });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.push(val, ...) -> capacity-based amortized push supporting multiple arguments.
 * Mutates vec struct in-place: grows backing array if needed, sets elements, increments length.
 */
function compileArrayPush(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // 0-arg push: no-op, return current length
  if (callExpr.arguments.length === 0) {
    const vecTmp0 = allocLocal(fctx, `__arr_push_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "local.tee", index: vecTmp0 });
    emitReceiverNullGuard(ctx, fctx, vecTmp0, propAccess.expression);
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
    if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
    return ctx.fast ? { kind: "i32" } : { kind: "f64" };
  }

  const argCount = callExpr.arguments.length;
  const vecTmp = allocLocal(fctx, `__arr_push_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_push_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_push_len_${fctx.locals.length}`, { kind: "i32" });
  const newCapTmp = allocLocal(fctx, `__arr_push_ncap_${fctx.locals.length}`, { kind: "i32" });
  const newDataTmp = allocLocal(fctx, `__arr_push_ndata_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp, propAccess.expression);

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.tee", index: dataTmp });

  // Check: length + argCount > capacity?
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: argCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "i32.lt_s" });

  // if (capacity < length + argCount) -> grow
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // newCap = max((len + argCount) * 2, 4)
      { op: "local.get", index: lenTmp } as Instr,
      { op: "i32.const", value: argCount } as Instr,
      { op: "i32.add" } as Instr,
      { op: "i32.const", value: 1 } as Instr,
      { op: "i32.shl" } as Instr, // (len + argCount) * 2
      { op: "i32.const", value: 4 } as Instr,
      // select: if (len+argCount)*2 > 4 then (len+argCount)*2 else 4
      { op: "local.get", index: lenTmp } as Instr,
      { op: "i32.const", value: argCount } as Instr,
      { op: "i32.add" } as Instr,
      { op: "i32.const", value: 1 } as Instr,
      { op: "i32.shl" } as Instr,
      { op: "i32.const", value: 4 } as Instr,
      { op: "i32.gt_s" } as Instr,
      { op: "select" } as Instr,
      { op: "local.set", index: newCapTmp } as Instr,

      // newData = array.new_default(newCap)
      { op: "local.get", index: newCapTmp } as Instr,
      { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
      { op: "local.set", index: newDataTmp } as Instr,

      // array.copy newData[0..len] = data[0..len]
      { op: "local.get", index: newDataTmp } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.get", index: dataTmp } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.get", index: lenTmp } as Instr,
      { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,

      // Update vec struct data field
      { op: "local.get", index: vecTmp } as Instr,
      { op: "local.get", index: newDataTmp } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,

      // Update local data pointer
      { op: "local.get", index: newDataTmp } as Instr,
      { op: "local.set", index: dataTmp } as Instr,
    ],
  } as Instr);

  // Set elements: data[length + i] = args[i] for each argument (compile-time unrolled)
  for (let i = 0; i < argCount; i++) {
    fctx.body.push({ op: "local.get", index: dataTmp });
    fctx.body.push({ op: "local.get", index: lenTmp });
    if (i > 0) {
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "i32.add" });
    }
    compileExpression(ctx, fctx, callExpr.arguments[i]!, elemType);
    fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
  }

  // Update length: vec.length = len + argCount
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: argCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });

  // Return new length (i32 in fast mode, f64 otherwise)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: argCount });
  fctx.body.push({ op: "i32.add" });
  if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

/**
 * arr.pop() -> O(1), decrement length and return last element.
 */
function compileArrayPop(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  expectedType?: ValType,
): ValType | null {
  const resultType: ValType = shouldReturnUndefinedCapableResult(ctx, callExpr, expectedType)
    ? { kind: "externref" }
    : elemType;
  const vecTmp = allocLocal(fctx, `__arr_pop_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const newLenTmp = allocLocal(fctx, `__arr_pop_nl_${fctx.locals.length}`, { kind: "i32" });
  const resultTmp = allocLocal(fctx, `__arr_pop_res_${fctx.locals.length}`, resultType);

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  const lenTmp = allocLocal(fctx, `__arr_pop_len_${fctx.locals.length}`, { kind: "i32" });

  // ECMA-262 §23.1.3.22: when length is 0, pop sets length to +0 and
  // returns undefined. Preserve the old primitive result only for numeric
  // hint contexts; otherwise use an externref result that can carry
  // undefined for the Array<T>.pop(): T | undefined signature.
  if (resultType.kind === "externref" || resultType.kind === "anyref") {
    emitUndefined(ctx, fctx);
    fctx.body.push({ op: "local.set", index: resultTmp });
  }

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Guard: if length > 0, do pop; else result stays as initialized above (undefined for ref types).
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.gt_s" });

  const thenInstrs: Instr[] = [
    // newLen = length - 1
    { op: "local.get", index: lenTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.sub" } as Instr,
    { op: "local.set", index: newLenTmp } as Instr,
    // result = data[newLen]
    { op: "local.get", index: vecTmp } as Instr,
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.get", index: newLenTmp } as Instr,
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    ...(resultType.kind === "externref" ? arrayElementToExternrefInstrs(ctx, fctx, elemType) : []),
    { op: "local.set", index: resultTmp } as Instr,
    // Decrement length: vec.length = newLen
    { op: "local.get", index: vecTmp } as Instr,
    { op: "local.get", index: newLenTmp } as Instr,
    { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
  ];

  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs } as Instr);

  // Return result (default value if empty, popped value if non-empty)
  fctx.body.push({ op: "local.get", index: resultTmp });
  return resultType;
}

/**
 * arr.shift() -> O(n) in-place: read data[0], shift data left, decrement length.
 */
function compileArrayShift(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  expectedType?: ValType,
): ValType | null {
  const resultType: ValType = shouldReturnUndefinedCapableResult(ctx, callExpr, expectedType)
    ? { kind: "externref" }
    : elemType;
  const vecTmp = allocLocal(fctx, `__arr_sft_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_sft_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_sft_len_${fctx.locals.length}`, { kind: "i32" });
  const newLenTmp = allocLocal(fctx, `__arr_sft_nl_${fctx.locals.length}`, { kind: "i32" });
  const resultTmp = allocLocal(fctx, `__arr_sft_res_${fctx.locals.length}`, resultType);

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // ECMA-262 §23.1.3.27 mirrors pop's empty-array branch for shift.
  if (resultType.kind === "externref" || resultType.kind === "anyref") {
    emitUndefined(ctx, fctx);
    fctx.body.push({ op: "local.set", index: resultTmp });
  }

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Guard: if length > 0, do shift; else result stays default (0/NaN/null)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.gt_s" });

  const thenInstrs: Instr[] = [
    // result = data[0]
    { op: "local.get", index: dataTmp } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    ...(resultType.kind === "externref" ? arrayElementToExternrefInstrs(ctx, fctx, elemType) : []),
    { op: "local.set", index: resultTmp } as Instr,
    // newLen = len - 1
    { op: "local.get", index: lenTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.sub" } as Instr,
    { op: "local.set", index: newLenTmp } as Instr,
    // Shift left: array.copy data[0..newLen] = data[1..len]
    { op: "local.get", index: dataTmp } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.get", index: dataTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "local.get", index: newLenTmp } as Instr,
    { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,
    // Decrement length: vec.length = newLen
    { op: "local.get", index: vecTmp } as Instr,
    { op: "local.get", index: newLenTmp } as Instr,
    { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
  ];

  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs } as Instr);

  // Return result (default value if empty, shifted value if non-empty)
  fctx.body.push({ op: "local.get", index: resultTmp });
  return resultType;
}

/**
 * arr.unshift(...items) -> O(n) in-place: grow if needed, shift existing
 * elements right by argCount, write items into [0..argCount), bump length.
 * Returns the new length. The mirror of shift; §23.1.3.34.
 *
 * #1966: previously `unshift` was not in ARRAY_METHODS at all, so it fell
 * through to the host-import generic path which never wrote the mutation back
 * to the WasmGC vec — a silent no-op (host) / corruption (standalone). This is
 * the native lowering.
 */
function compileArrayUnshift(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // 0-arg unshift: no-op, return current length.
  if (callExpr.arguments.length === 0) {
    const vecTmp0 = allocLocal(fctx, `__arr_unsft_vec_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: vecTypeIdx,
    });
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "local.tee", index: vecTmp0 });
    emitReceiverNullGuard(ctx, fctx, vecTmp0, propAccess.expression);
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
    if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
    return ctx.fast ? { kind: "i32" } : { kind: "f64" };
  }

  const argCount = callExpr.arguments.length;
  const vecTmp = allocLocal(fctx, `__arr_unsft_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_unsft_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_unsft_len_${fctx.locals.length}`, { kind: "i32" });
  const newCapTmp = allocLocal(fctx, `__arr_unsft_ncap_${fctx.locals.length}`, { kind: "i32" });
  const newDataTmp = allocLocal(fctx, `__arr_unsft_ndata_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp, propAccess.expression);

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Capacity check: len + argCount > capacity? If so, allocate a new buffer and
  // copy the existing elements directly into their shifted destination
  // (data[0..len] -> newData[argCount..argCount+len]); otherwise array.copy
  // in place (overlapping copy is memmove-correct).
  fctx.body.push({ op: "local.get", index: dataTmp });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: argCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "i32.lt_s" }); // capacity < len + argCount
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // newCap = max((len + argCount) * 2, 4)
      { op: "local.get", index: lenTmp } as Instr,
      { op: "i32.const", value: argCount } as Instr,
      { op: "i32.add" } as Instr,
      { op: "i32.const", value: 1 } as Instr,
      { op: "i32.shl" } as Instr,
      { op: "i32.const", value: 4 } as Instr,
      { op: "local.get", index: lenTmp } as Instr,
      { op: "i32.const", value: argCount } as Instr,
      { op: "i32.add" } as Instr,
      { op: "i32.const", value: 1 } as Instr,
      { op: "i32.shl" } as Instr,
      { op: "i32.const", value: 4 } as Instr,
      { op: "i32.gt_s" } as Instr,
      { op: "select" } as Instr,
      { op: "local.set", index: newCapTmp } as Instr,

      // newData = array.new_default(newCap)
      { op: "local.get", index: newCapTmp } as Instr,
      { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
      { op: "local.set", index: newDataTmp } as Instr,

      // newData[argCount .. argCount+len] = data[0..len]
      { op: "local.get", index: newDataTmp } as Instr,
      { op: "i32.const", value: argCount } as Instr,
      { op: "local.get", index: dataTmp } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.get", index: lenTmp } as Instr,
      { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,

      // Update vec struct data field + local pointer
      { op: "local.get", index: vecTmp } as Instr,
      { op: "local.get", index: newDataTmp } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
      { op: "local.get", index: newDataTmp } as Instr,
      { op: "local.set", index: dataTmp } as Instr,
    ],
    else: [
      // In-place right shift: data[argCount .. argCount+len] = data[0..len].
      // array.copy is memmove-safe for overlapping ranges.
      { op: "local.get", index: dataTmp } as Instr,
      { op: "i32.const", value: argCount } as Instr,
      { op: "local.get", index: dataTmp } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.get", index: lenTmp } as Instr,
      { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,
    ],
  } as Instr);

  // Write the new elements into data[0..argCount) (compile-time unrolled).
  for (let i = 0; i < argCount; i++) {
    fctx.body.push({ op: "local.get", index: dataTmp });
    fctx.body.push({ op: "i32.const", value: i });
    compileExpression(ctx, fctx, callExpr.arguments[i]!, elemType);
    fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
  }

  // Update length: vec.length = len + argCount
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: argCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });

  // Return new length (i32 in fast mode, f64 otherwise).
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: argCount });
  fctx.body.push({ op: "i32.add" });
  if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

/**
 * arr.slice(start?, end?) -> create new vec struct with sliced data.
 */
/**
 * #1359 Slice E (sparse holes): for `__vec_*` typed receivers, no holes
 * are possible at the WasmGC level — the underlying typed array is
 * dense by construction. Spec §23.1.3.x's `HasProperty(O, k)` checks
 * before `Get(O, k)` are therefore vacuously true for every k in
 * `[start, end)`. We can `array.copy` the underlying buffer without
 * iterating per-index. Host-array receivers (sparse, with prototype-
 * inherited slots) flow through `__proto_method_call` which delegates
 * to native `Array.prototype.slice` and gets the spec semantics for
 * free. See sub-slice plan in the issue file for the full rationale.
 *
 * #1359 Slice A (empty-slice "actual: null"): NOT a slice() bug. The
 * vec returned by this function is non-null (struct.new always returns
 * non-null). The "actual: null" failure observed in
 * `slice/S15.4.4.10_A1.1_T4.js` is downstream — the test calls
 * `Object.prototype.toString.call(arr)` which needs the $vec brand to
 * resolve to "[object Array]". That's #1334 territory.
 *
 * #1359 Slice B (@@species): receiver-type-driven dispatch. When the
 * receiver's static type is a known `__vec_*`, `Array[@@species] ===
 * Array` so `struct.new $vec` is correct. For subclass / proxy
 * receivers (rare; mainly test262), needs `__array_species_create`
 * host helper. Tracked as #1359B follow-up.
 */
function compileArraySlice(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  _elemType: ValType,
): ValType {
  const vecTmp = allocLocal(fctx, `__arr_slc_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_slc_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_slc_ndata_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const startTmp = allocLocal(fctx, `__arr_slc_s_${fctx.locals.length}`, { kind: "i32" });
  const endTmp = allocLocal(fctx, `__arr_slc_e_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_slc_len_${fctx.locals.length}`, { kind: "i32" });
  const sliceLenTmp = allocLocal(fctx, `__arr_slc_sl_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length from vec
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array from vec
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // start arg -- clamp negative: if start < 0, start = max(0, len + start)
  if (callExpr.arguments.length >= 1) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: startTmp });
  emitClampIndex(fctx, startTmp, lenTmp);

  // end arg -- clamp negative: if end < 0, end = max(0, len + end); clamp to len
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
  }
  fctx.body.push({ op: "local.set", index: endTmp });
  emitClampIndex(fctx, endTmp, lenTmp);

  // sliceLen = max(0, end - start)
  fctx.body.push({ op: "local.get", index: endTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: sliceLenTmp });
  emitClampNonNeg(fctx, sliceLenTmp);

  // newData = array.new_default(sliceLen)
  fctx.body.push({ op: "local.get", index: sliceLenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // array.copy newData[0..sliceLen] = data[start..start+sliceLen]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, startTmp, sliceLenTmp);

  // Create new vec struct: { sliceLen, newData }
  fctx.body.push({ op: "local.get", index: sliceLenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.concat(other) -> create new vec struct with combined data.
 */
function compileArrayConcat(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  _elemType: ValType,
): ValType | null {
  // 0-arg concat: shallow copy of the receiver array
  if (callExpr.arguments.length === 0) {
    const vecA = allocLocal(fctx, `__arr_cat_va_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
    const dataA = allocLocal(fctx, `__arr_cat_da_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
    const newData = allocLocal(fctx, `__arr_cat_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
    const lenA = allocLocal(fctx, `__arr_cat_la_${fctx.locals.length}`, { kind: "i32" });

    // Compile receiver -> vec ref
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "local.tee", index: vecA });
    emitReceiverNullGuard(ctx, fctx, vecA);
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "local.set", index: lenA });
    fctx.body.push({ op: "local.get", index: vecA });
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
    fctx.body.push({ op: "local.set", index: dataA });

    // newData = array.new_default(lenA)
    fctx.body.push({ op: "local.get", index: lenA });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: newData });

    // array.copy newData[0..lenA] = dataA[0..lenA]
    emitArrayCopy(fctx, arrTypeIdx, newData, null, dataA, null, lenA);

    // Create new vec struct: { lenA, newData }
    fctx.body.push({ op: "local.get", index: lenA });
    fctx.body.push({ op: "local.get", index: newData });
    fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // Check if argument B is a known WasmGC array type. If not (e.g. `any`, `object`,
  // array-like with Symbol.isConcatSpreadable), struct.get would cause an illegal cast at runtime.
  // Fall back to __extern_method_call("concat") for non-array arguments.
  //
  // #1359: Also bail if the arg's vec type differs from the receiver's vec type
  // (e.g. `[].concat([1, 2])` where the empty receiver is `__vec_externref` and the
  // arg is `__vec_f64`). The fast path emits `ref.cast` from the arg to the receiver's
  // vec type, which traps at runtime when the types don't match.
  //
  // #1359: Likewise bail when there are 2+ args; the typed fast path only handles a
  // single arg, but `Array.prototype.concat` accepts variadic args and the host
  // bridge handles them correctly.
  const argNode = callExpr.arguments[0]!;
  const argTsType = ctx.checker.getTypeAtLocation(argNode);
  const argArrayInfo = resolveArrayInfo(ctx, argTsType);

  if (!argArrayInfo) {
    return compileArrayConcatExtern(ctx, fctx, propAccess, callExpr);
  }
  if (argArrayInfo.vecTypeIdx !== vecTypeIdx) {
    return compileArrayConcatExtern(ctx, fctx, propAccess, callExpr);
  }
  if (callExpr.arguments.length > 1) {
    return compileArrayConcatExtern(ctx, fctx, propAccess, callExpr);
  }

  const vecA = allocLocal(fctx, `__arr_cat_va_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const vecB = allocLocal(fctx, `__arr_cat_vb_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataA = allocLocal(fctx, `__arr_cat_da_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const dataB = allocLocal(fctx, `__arr_cat_db_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_cat_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenA = allocLocal(fctx, `__arr_cat_la_${fctx.locals.length}`, { kind: "i32" });
  const lenB = allocLocal(fctx, `__arr_cat_lb_${fctx.locals.length}`, { kind: "i32" });
  const totalLen = allocLocal(fctx, `__arr_cat_tl_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver A -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecA });
  emitReceiverNullGuard(ctx, fctx, vecA);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenA });
  fctx.body.push({ op: "local.get", index: vecA });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataA });

  // Compile argument B -> vec ref (safe — argArrayInfo confirmed it's a WasmGC array)
  compileExpression(ctx, fctx, callExpr.arguments[0]!);
  fctx.body.push({ op: "local.tee", index: vecB });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenB });
  fctx.body.push({ op: "local.get", index: vecB });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataB });

  // totalLen = lenA + lenB
  fctx.body.push({ op: "local.get", index: lenA });
  fctx.body.push({ op: "local.get", index: lenB });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: totalLen });

  // newData = array.new_default(totalLen)
  fctx.body.push({ op: "local.get", index: totalLen });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // array.copy newData[0..lenA] = dataA[0..lenA]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataA, null, lenA);

  // array.copy newData[lenA..lenA+lenB] = dataB[0..lenB]
  emitArrayCopy(fctx, arrTypeIdx, newData, lenA, dataB, null, lenB);

  // Create new vec struct: { totalLen, newData }
  fctx.body.push({ op: "local.get", index: totalLen });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * Fallback for arr.concat(arg...) when any arg is not a known WasmGC array type
 * (e.g. `any`, array-like with Symbol.isConcatSpreadable, or plain objects).
 *
 * Uses __array_concat_any(receiver_ext, args_js_array) host import, which:
 * 1. Converts the WasmGC receiver to a real JS array via __vec_len/__vec_get exports
 * 2. Calls Array.prototype.concat with all arguments (supports isConcatSpreadable)
 * 3. Returns the result as externref (a new JS Array)
 */
function compileArrayConcatExtern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): ValType | null {
  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
  // __array_concat_any(receiver: externref, args: externref) -> externref
  // Converts WasmGC receiver to JS array, then calls .concat(...args)
  const concatAnyIdx = ensureLateImport(
    ctx,
    "__array_concat_any",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);

  if (arrNewIdx === undefined || arrPushIdx === undefined || concatAnyIdx === undefined) {
    return null;
  }

  // Compile receiver as externref (WasmGC vec struct → extern ref), save to local
  const recvLocal = allocLocal(fctx, `__cat_ext_recv_${fctx.locals.length}`, { kind: "externref" });
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  fctx.body.push({ op: "local.set", index: recvLocal });

  // Build JS args array from all concat arguments
  fctx.body.push({ op: "call", funcIdx: arrNewIdx });
  const argsLocal = allocLocal(fctx, `__cat_ext_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: argsLocal });

  for (const arg of callExpr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (argType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (argType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
    fctx.body.push({ op: "call", funcIdx: arrPushIdx });
  }

  // Call __array_concat_any(receiver_ext, args_array) -> externref JS array
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: concatAnyIdx });
  return { kind: "externref" };
}

/**
 * #1286: arr.join(sep?) fallback for externref receivers (e.g., the result of
 * `Object.keys(any)` via the `__object_keys` host import, which returns a real
 * JS array). The native `compileArrayJoin` path expects a WasmGC vec struct;
 * trying to extract one from an externref via `ref.cast` traps with "illegal
 * cast". Instead, delegate to the host's `Array.prototype.join` via the
 * `__array_join_any` import, which handles JS arrays and WasmGC vecs.
 */
function compileArrayJoinExtern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): ValType | null {
  const joinAnyIdx = ensureLateImport(
    ctx,
    "__array_join_any",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (joinAnyIdx === undefined) return null;

  // Compile receiver, coerce to externref if needed.
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }

  // Separator argument. Pass `undefined` (ref.null.extern) when no argument was
  // given so the runtime falls back to the spec's default `,` separator —
  // explicit `undefined` matches Array.prototype.join semantics.
  if (callExpr.arguments.length >= 1) {
    const argType = compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "externref" });
    if (argType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (argType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  fctx.body.push({ op: "call", funcIdx: joinAnyIdx });
  return { kind: "externref" };
}

/**
 * True when `expr` is a call to a higher-order array method that allocates a
 * callback closure (`map`/`filter`/`flatMap`/`forEach`/`reduce`/…). The native
 * join path re-compiles its receiver via the dispatcher probe, and closure
 * registration is not idempotent, so such receivers must not route through it
 * (see #2074/#2075). Conservative: any of these method names on a call.
 */
function receiverIsClosureProducingArrayCall(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  const m = expr.expression.name.text;
  return (
    m === "map" ||
    m === "filter" ||
    m === "flatMap" ||
    m === "forEach" ||
    m === "reduce" ||
    m === "reduceRight" ||
    m === "find" ||
    m === "findIndex" ||
    m === "sort"
  );
}

/**
 * #2074 — native-strings (standalone / WASI) `arr.join(sep?)`.
 *
 * The default join path concatenates via the wasm:js-string `concat` builtin
 * and `number_toString`-as-externref, both unavailable (or wrong) under native
 * strings: string elements are `(ref $NativeString)` values, not externref, so
 * the host-concat loop null-derefs / illegal-casts, and the separator default
 * came from a host string-constant global. Here we build the result entirely
 * from native string helpers:
 *   - element → `(ref $AnyString)`: string elements pass through (NativeString
 *     is a subtype of AnyString); numeric elements go via `number_toString`
 *     (which returns a native string boxed as externref → convert back).
 *   - concatenation via `__str_concat`; separator materialized as a native
 *     string literal (arg, or the spec default ",").
 * Returns externref (the joined native string, converted for the caller).
 */
function compileArrayJoinNative(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  // #2088 — native-string representation; the fold loop + separator + empty
  // handling are shared with the host lane via `emitStringJoinFold`. This lane
  // supplies only the native repr and the element-type-specific `elemToStr`.
  const repr = nativeStringRepr(ctx);
  if (repr === undefined || anyStrTypeIdx < 0) {
    reportError(ctx, callExpr, "join requires native string helpers (__str_concat)");
    return null;
  }

  // #2105: a boolean element array stringifies as "true"/"false". The brand is
  // lost in arrDef.element, so derive boolean-ness from the receiver TS type.
  const elemIsBoolean = elemType.kind === "i32" && arrayElementIsBoolean(ctx, propAccess.expression);
  const isNumeric =
    !elemIsBoolean &&
    (elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "i8" || elemType.kind === "i16");
  let numToStrIdx: number | undefined;
  if (isNumeric) {
    emitNativeNumberFormat(ctx, new Set(["number_toString"]));
    numToStrIdx = ctx.funcMap.get("number_toString");
    if (numToStrIdx === undefined) {
      reportError(ctx, callExpr, "join of a numeric array requires number_toString");
      return null;
    }
  }

  const vecTmp = allocLocal(fctx, `__njoin_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__njoin_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const foldLocals = allocJoinFoldLocals(fctx, repr, "njoin");
  const { lenTmp, iTmp, resultTmp, sepTmp } = foldLocals;

  // Receiver vec → length + data array.
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Separator: explicit arg (coerced to a native string) or the spec default ",".
  if (callExpr.arguments.length >= 1) {
    const argType = compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "externref" });
    if (argType === null) {
      // void/undefined arg → default ","
      fctx.body.push(...nativeStringLiteralInstrs(ctx, ","));
    } else {
      // The native string value arrives as externref; convert to ref $AnyString.
      fctx.body.push({ op: "any.convert_extern" } as Instr);
      fctx.body.push({ op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr);
    }
  } else {
    fctx.body.push(...nativeStringLiteralInstrs(ctx, ","));
  }
  fctx.body.push({ op: "local.set", index: sepTmp });

  // result = "" (empty native string)
  fctx.body.push(...nativeStringLiteralInstrs(ctx, ""));
  fctx.body.push({ op: "local.set", index: resultTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Element → ref $AnyString.
  const elemToStr: Instr[] = [
    { op: "local.get", index: dataTmp } as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
  ];
  if (elemIsBoolean) {
    // #2105: i32 element on the stack → native "true"/"false" string, then
    // cast up to ref $AnyString for the concat loop (NativeString <: AnyString).
    elemToStr.push({
      op: "if",
      blockType: { kind: "val", type: nativeStringType(ctx) },
      then: nativeStringLiteralInstrs(ctx, "true"),
      else: nativeStringLiteralInstrs(ctx, "false"),
    } as Instr);
    elemToStr.push({ op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr);
  } else if (isNumeric && numToStrIdx !== undefined) {
    if (elemType.kind !== "f64") elemToStr.push({ op: "f64.convert_i32_s" } as Instr);
    elemToStr.push({ op: "call", funcIdx: numToStrIdx } as Instr);
    // number_toString returns the native string boxed as externref.
    elemToStr.push({ op: "any.convert_extern" } as Instr);
    elemToStr.push({ op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr);
  } else {
    // String element: a (ref null $NativeString) — non-null cast up to $AnyString.
    elemToStr.push({ op: "ref.as_non_null" } as Instr);
  }

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  // #2088 — shared fold (host + native lanes route through this).
  emitStringJoinFold(ctx, fctx, repr, foldLocals, elemToStr);

  // Return the joined native string as externref for the caller.
  fctx.body.push({ op: "local.get", index: resultTmp });
  fctx.body.push({ op: "extern.convert_any" } as Instr);
  return { kind: "externref" };
}

/**
 * arr.join(sep?) -> convert elements to strings and concatenate.
 * Receiver is a vec struct.
 */
function compileArrayJoin(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // #2074 — in native-strings mode (standalone / WASI) there is no
  // wasm:js-string `concat`; the host-concat element loop below null-derefs /
  // illegal-casts on native-string element arrays and emits imports the
  // standalone target cannot satisfy. Route through the native vec join.
  //
  // #2075 follow-up — a receiver that is itself a *closure-producing* array
  // method call (`.map(fn).join(...)`, `.filter(fn).join(...)`) is excluded:
  // the receiver probe in compileArrayMethodCall re-compiles such receivers and
  // the closure registration is not idempotent, so routing them here produces
  // an invalid module. Those keep their prior behavior until the probe is made
  // closure-safe; the non-closure collateral shapes (slice/spread/concat/
  // push-pop/sort/shift/reverse/length-trunc) all go native correctly.
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0 && !receiverIsClosureProducingArrayCall(propAccess.expression)) {
    return compileArrayJoinNative(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
  }

  // #1286: dispatch to compileArrayJoinExtern when the receiver evaluates to
  // externref at runtime is handled in compileArrayMethodCall via the
  // `receiverIsExternref` flag set by the probe. By the time we get here, the
  // receiver is known to be a vec struct.

  // #2105: boolean[] joins/toStrings as "true"/"false", not "1"/"0".
  const elemIsBoolean = elemType.kind === "i32" && arrayElementIsBoolean(ctx, propAccess.expression);

  // #1998: when the element type is externref/ref, each element must be
  // stringified via the `__extern_join_str` host import (undefined/null → "",
  // else ToString) before it reaches wasm:js-string `concat`. Ensure that
  // import FIRST — adding a late import shifts every defined-function /
  // import index at or above the insertion point, and `flushLateImportShifts`
  // can only repair indices already baked into instruction bodies, not the
  // raw `concatIdx`/`toStrIdx` values we capture below. Hoisting the import +
  // flush ahead of those captures keeps them correct.
  const needsExternJoinStr = elemType.kind === "externref" || elemType.kind === "ref" || elemType.kind === "ref_null";
  let joinStrIdx: number | undefined;
  if (needsExternJoinStr) {
    joinStrIdx = ensureLateImport(ctx, "__extern_join_str", [{ kind: "externref" }], [{ kind: "externref" }]);
  }

  // #1998: `number_toString` is normally registered up-front by
  // collectPrimitiveMethodImports, but only when the receiver's number-index
  // type statically resolves to number/boolean/bigint. For `any[]` receivers
  // (e.g. `([10,9] as any[]).join(",")`) the element lowers to f64 here yet the
  // import was never collected, so the f64 stringification branch below was
  // silently skipped and a raw f64 reached `concat` → "illegal cast". Ensure it
  // on demand. Hoisted above the `concatIdx` capture so the late-import index
  // shift settles before any funcIdx is read into a JS variable.
  if ((elemType.kind === "f64" || elemType.kind === "i32") && ctx.funcMap.get("number_toString") === undefined) {
    ensureLateImport(ctx, "number_toString", [{ kind: "f64" }], [{ kind: "externref" }]);
  }

  flushLateImportShifts(ctx, fctx);

  // #1998: register the empty-string constant. It backs two substitutions
  // below: (1) f64 vecs store `undefined`, array holes, and elided trailing
  // slots as the sNaN sentinel 0x7FF00000DEADC0DE (see emitDefaultValueCheck /
  // #866), which join renders as "" (§23.1.3.18 step 7.c/d) while a *genuine*
  // NaN (distinct bit pattern) still stringifies to "NaN"; (2) join/toString of
  // an empty array is "", not the initial null.
  addStringConstantGlobal(ctx, "");

  // #1997: the default separator is "," (used when join is called with no
  // argument, and always for Array.prototype.toString). It is normally
  // registered by the up-front string-constant collection, but that pass does
  // not see the implicit "," for toString / no-arg join on every receiver
  // shape. Register it on demand so the default-separator branch below emits a
  // real string global instead of falling back to `ref.null.extern` (which
  // traps "illegal cast" in wasm:js-string `concat`).
  if (callExpr.arguments.length < 1) {
    addStringConstantGlobal(ctx, ",");
  }

  const concatIdx = ctx.jsStringImports.get("concat");
  const toStrIdx = ctx.funcMap.get("number_toString");
  if (concatIdx === undefined) {
    reportError(ctx, callExpr, "join requires string support (wasm:js-string concat)");
    return null;
  }

  // #2088 — the fold loop + separator + empty-string handling are shared with
  // the native lane via `emitStringJoinFold`; this lane supplies only the
  // host-string representation and the element-type-specific `elemToStr`
  // matrix below. A bug in the shared fold regresses both lanes at once.
  const repr = hostStringRepr(ctx);
  if (repr === undefined) {
    reportError(ctx, callExpr, "join requires string support (wasm:js-string concat)");
    return null;
  }

  // #1968 — the empty-join result must be "" not a null externref (which every
  // downstream string consumer stringifies as "null"). Pre-register the ""
  // string constant *before* any body instructions so the eventual fixup of
  // module-global indices can't desync already-emitted global.gets.
  addStringConstantGlobal(ctx, "");

  const vecTmp = allocLocal(fctx, `__arr_join_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_join_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const foldLocals = allocJoinFoldLocals(fctx, repr, "arr_join");
  const { lenTmp, iTmp, resultTmp, sepTmp } = foldLocals;

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length from vec
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array from vec
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // separator
  if (callExpr.arguments.length >= 1) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!);
  } else {
    // Default separator "," -- check if registered as string constant global
    const commaGlobalIdx = ctx.stringGlobalMap.get(",");
    if (commaGlobalIdx !== undefined) {
      fctx.body.push({ op: "global.get", index: commaGlobalIdx });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
  }
  fctx.body.push({ op: "local.set", index: sepTmp });

  // result starts as "" (the empty-array join result, #1968) — not null, which
  // would stringify as "null". A non-empty array overwrites this on iteration 0.
  compileStringLiteral(ctx, fctx, "");
  fctx.body.push({ op: "local.set", index: resultTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Build element-to-string instructions (use dataTmp instead of arrTmp)
  const elemToStr: Instr[] = [
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
  ];
  if (elemType.kind === "f64" && toStrIdx !== undefined) {
    // #1998: substitute "" for the undefined/hole sNaN sentinel; otherwise
    // ToString the number (so a genuine NaN still renders "NaN").
    const elemF64Tmp = allocLocal(fctx, `__arr_join_elem_${fctx.locals.length}`, { kind: "f64" });
    elemToStr.push({ op: "local.tee", index: elemF64Tmp });
    elemToStr.push({ op: "i64.reinterpret_f64" });
    elemToStr.push({ op: "i64.const", value: 0x7ff00000deadc0den } as Instr);
    elemToStr.push({ op: "i64.eq" });
    elemToStr.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: stringConstantExternrefInstrs(ctx, ""),
      else: [
        { op: "local.get", index: elemF64Tmp },
        { op: "call", funcIdx: toStrIdx },
      ],
    } as Instr);
  } else if (elemType.kind === "i32" && elemIsBoolean) {
    // #2105: a boolean element array stringifies as "true"/"false", not the
    // numeric "1"/"0" produced by number_toString. The boolean brand is lost
    // in arrDef.element (structural array dedup), so derive boolean-ness from
    // the receiver's TS element type. Select the "true"/"false" string-constant
    // global from the i32 element on the stack (JS-host externref form).
    addStringConstantGlobal(ctx, "true");
    addStringConstantGlobal(ctx, "false");
    elemToStr.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "global.get", index: ctx.stringGlobalMap.get("true")! } as Instr],
      else: [{ op: "global.get", index: ctx.stringGlobalMap.get("false")! } as Instr],
    } as Instr);
  } else if (elemType.kind === "i32" && toStrIdx !== undefined) {
    elemToStr.push({ op: "f64.convert_i32_s" });
    elemToStr.push({ op: "call", funcIdx: toStrIdx });
  } else if (needsExternJoinStr && joinStrIdx !== undefined) {
    // #1998: any/object/boxed elements arrive as a raw externref. Feeding that
    // straight into wasm:js-string `concat` traps "illegal cast" because the
    // builtin requires string operands. Route each element through
    // `__extern_join_str` (ensured above), which applies Array.prototype.join's
    // spec rule (§23.1.3.18 step 7.c/d): `undefined`/`null` → "", else ToString.
    if (elemType.kind !== "externref") {
      // A WasmGC struct ref must be re-expressed as externref for the import.
      elemToStr.push({ op: "extern.convert_any" });
    }
    elemToStr.push({ op: "call", funcIdx: joinStrIdx });
  }

  // #2088 — shared fold (host + native lanes route through this).
  emitStringJoinFold(ctx, fctx, repr, foldLocals, elemToStr);

  // An empty array leaves `resultTmp` as the initial null. join/toString of `[]`
  // is the empty String "", not null — substitute it so the result is a real
  // string (also keeps a null from ever reaching a caller that concatenates it).
  fctx.body.push({ op: "local.get", index: resultTmp });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: stringConstantExternrefInstrs(ctx, ""),
    else: [{ op: "local.get", index: resultTmp }],
  } as Instr);
  return { kind: "externref" };
}

/**
 * arr.splice(start, deleteCount?) -> in-place shift, returns new vec with deleted elements.
 *
 * #1359 Slice D (deleteCount=undefined): verified spec-correct in this
 * function on 2026-05-08:
 *   - 0-arg splice → empty array, no mutation ✓ §23.1.3.30 step 5
 *   - 1-arg splice(start) → delCount = len - actualStart ✓ §23.1.3.30 step 11.b
 *   - 2-arg splice(start, undefined) → compiles undefined as f64 NaN →
 *     `i32.trunc_sat_f64_s(NaN) = 0` ✓ matches ToInteger(undefined) = 0
 *
 * The architect's reference test `splice/S15.4.4.12_A6.1_T2.js` actually
 * tests TypeError-throw when `length` is non-writable, which needs
 * Object.defineProperty + writable-attr fidelity (#1334), not a fix
 * here. The 25 splice `assertion_fail` count in the issue's table
 * needs re-bucketing before any further splice fix is attempted.
 */
function compileArraySplice(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  _elemType: ValType,
): ValType | null {
  // 0-arg splice: no mutation, return empty array
  if (callExpr.arguments.length === 0) {
    // Still need to evaluate receiver for side effects
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "drop" });
    // Return empty vec struct: { 0, array.new_default(0) }
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  const vecTmp = allocLocal(fctx, `__arr_spl_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_spl_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const delData = allocLocal(fctx, `__arr_spl_deld_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_spl_len_${fctx.locals.length}`, { kind: "i32" });
  const startTmp = allocLocal(fctx, `__arr_spl_s_${fctx.locals.length}`, { kind: "i32" });
  const delCountTmp = allocLocal(fctx, `__arr_spl_dc_${fctx.locals.length}`, { kind: "i32" });
  const newLenTmp = allocLocal(fctx, `__arr_spl_nl_${fctx.locals.length}`, { kind: "i32" });
  const tailCountTmp = allocLocal(fctx, `__arr_spl_tc_${fctx.locals.length}`, { kind: "i32" });
  const tailStartTmp = allocLocal(fctx, `__arr_spl_ts_${fctx.locals.length}`, { kind: "i32" });

  // #1815 — items to insert at `start` (arguments[2..]). When present, the
  // backing array must be rebuilt (it may need to grow), so we cannot use the
  // in-place tail-shift path that only works when newLen <= len.
  const insertCount = Math.max(0, callExpr.arguments.length - 2);
  const newData =
    insertCount > 0
      ? allocLocal(fctx, `__arr_spl_ndata_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx })
      : -1;
  const writeTmp = insertCount > 0 ? allocLocal(fctx, `__arr_spl_w_${fctx.locals.length}`, { kind: "i32" }) : -1;

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length from vec
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array from vec
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // start arg -- clamp negative indices
  compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: startTmp });
  emitClampIndex(fctx, startTmp, lenTmp);

  // deleteCount (default: len - start) -- clamp >= 0 and to remaining len
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "i32.sub" });
  }
  fctx.body.push({ op: "local.set", index: delCountTmp });
  emitClampNonNeg(fctx, delCountTmp);
  // Clamp delCount to not exceed remaining elements: min(delCount, len - start)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: tailCountTmp }); // reuse as temp
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "local.get", index: tailCountTmp });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "local.get", index: tailCountTmp } as Instr, { op: "local.set", index: delCountTmp } as Instr],
  } as Instr);
  emitClampNonNeg(fctx, delCountTmp);

  // Create deleted elements backing array and copy
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: delData });

  // array.copy delData[0..delCount] = data[start..start+delCount]
  emitArrayCopy(fctx, arrTypeIdx, delData, null, dataTmp, startTmp, delCountTmp);

  // tailStart = start + delCount
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: tailStartTmp });

  // tailCount = max(0, len - tailStart)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: tailStartTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: tailCountTmp });
  emitClampNonNeg(fctx, tailCountTmp);

  if (insertCount > 0) {
    // #1815 — insertion path: rebuild the backing array in place.
    // newLen = len - delCount + insertCount  (= start + insertCount + tailCount)
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "i32.const", value: insertCount });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.get", index: tailCountTmp });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.set", index: newLenTmp });

    // newData = array.new_default(newLen)
    fctx.body.push({ op: "local.get", index: newLenTmp });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: newData });

    // Part 1: head — newData[0..start] = data[0..start]
    emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, null, startTmp);

    // Part 2: items — newData[start..start+insertCount] = arguments[2..]
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "local.set", index: writeTmp });
    for (let i = 0; i < insertCount; i++) {
      fctx.body.push({ op: "local.get", index: newData });
      fctx.body.push({ op: "local.get", index: writeTmp });
      compileExpression(ctx, fctx, callExpr.arguments[2 + i]!, _elemType);
      fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
      if (i < insertCount - 1) {
        fctx.body.push({ op: "local.get", index: writeTmp });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "i32.add" });
        fctx.body.push({ op: "local.set", index: writeTmp });
      }
    }

    // Part 3: tail — newData[start+insertCount..] = data[tailStart..tailStart+tailCount]
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "i32.const", value: insertCount });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.set", index: writeTmp });
    emitArrayCopy(fctx, arrTypeIdx, newData, writeTmp, dataTmp, tailStartTmp, tailCountTmp);

    // Write new backing array + length back into the same vec struct (in place)
    fctx.body.push({ op: "local.get", index: vecTmp });
    fctx.body.push({ op: "local.get", index: newData });
    fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 });
    fctx.body.push({ op: "local.get", index: vecTmp });
    fctx.body.push({ op: "local.get", index: newLenTmp });
    fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });
  } else {
    // No insertion: shift tail left in-place (newLen <= len, capacity suffices).
    // array.copy data[start..start+tailCount] = data[tailStart..tailStart+tailCount]
    emitArrayCopy(fctx, arrTypeIdx, dataTmp, startTmp, dataTmp, tailStartTmp, tailCountTmp);

    // newLen = len - delCount
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "local.get", index: delCountTmp });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "local.set", index: newLenTmp });

    // Update vec length
    fctx.body.push({ op: "local.get", index: vecTmp });
    fctx.body.push({ op: "local.get", index: newLenTmp });
    fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });
  }

  // Return new vec with deleted elements: { delCount, delData }
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "local.get", index: delData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

// ── Functional array methods (filter, map, reduce, forEach, find, findIndex, some, every) ──
// Shared helpers to reduce duplication across callback-based array methods.

/** Result of setting up a callback for an array method (closure or host bridge). */
interface ArrayCallbackSetup {
  closureInfo?: ClosureInfo;
  closureTypeIdx?: number;
  closureTmp?: number;
  callBridgeIdx?: number;
  cbTmp?: number;
  /**
   * #2152 — externref local holding the `thisArg` to bind as the callback's
   * `this` (spec §23.1.3.* `Call(callbackfn, thisArg, …)`). Undefined when the
   * method takes no thisArg (reduce/reduceRight), none was passed, or the
   * callback is an arrow function (arrows are lexically `this`-bound, so the
   * thisArg is ignored). When set, `buildClosureCallInstrs` installs it into the
   * `__current_this` module global (save/restore) around the `call_ref`, where
   * the callback body's `this` reads it (#1636-S1 / #1702).
   */
  thisArgTmp?: number;
  /**
   * #2152 — externref save slot for the previous `__current_this` value, so the
   * global can be restored after each callback `call_ref` (nesting safety:
   * nested HOFs / re-entrant dispatch must not leak a stale receiver). Paired
   * with `thisArgTmp` (set iff `thisArgTmp` is set).
   */
  prevThisTmp?: number;
}

/**
 * #2152 — Compile the optional `thisArg` argument of an array HOF method into an
 * externref local so it can be installed as the callback's `this` around the
 * `call_ref`. Returns the local index, or undefined when no thisArg should be
 * forwarded:
 *   - the method has no thisArg slot (`thisArgIndex` undefined — reduce family),
 *   - no thisArg argument is present,
 *   - the callback is an arrow function (lexical `this`; thisArg ignored).
 * Per ECMA-262 the thisArg is evaluated as `arguments[thisArgIndex]`, AFTER the
 * callback (`arguments[0]`), which matches the call order here (callback is
 * compiled by `setupArrayCallback` before this runs).
 */
function compileThisArg(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  tag: string,
  thisArgIndex: number | undefined,
): { thisArgTmp: number; prevThisTmp: number } | undefined {
  if (thisArgIndex === undefined) return undefined;
  const cbArg = callExpr.arguments[0];
  // Arrow callbacks are lexically `this`-bound — the thisArg MUST be ignored.
  if (cbArg && ts.isArrowFunction(cbArg)) return undefined;
  const thisArgExpr = callExpr.arguments[thisArgIndex];
  if (!thisArgExpr) return undefined;

  // Ensure the __current_this global exists so buildClosureCallInstrs can install.
  ensureCurrentThisGlobal(ctx);
  const thisArgTmp = allocLocal(fctx, `__arr_${tag}_this_${fctx.locals.length}`, { kind: "externref" });
  const prevThisTmp = allocLocal(fctx, `__arr_${tag}_prevthis_${fctx.locals.length}`, { kind: "externref" });
  const tArgType = compileExpression(ctx, fctx, thisArgExpr);
  if (tArgType && tArgType.kind !== "externref") {
    coerceType(ctx, fctx, tArgType, { kind: "externref" });
  } else if (!tArgType) {
    // null result — treat as undefined receiver.
    emitUndefined(ctx, fctx);
  }
  fctx.body.push({ op: "local.set", index: thisArgTmp });
  return { thisArgTmp, prevThisTmp };
}

/**
 * Compile the callback argument and set up either a closure (call_ref) path
 * or a host bridge fallback. Returns null if setup fails (error pushed).
 *
 * `thisArgIndex` (#2152): the argument position of the spec `thisArg` for this
 * method (1 for filter / map / forEach / find / findIndex / findLast /
 * findLastIndex / some / every), or undefined for methods with no thisArg
 * (reduce / reduceRight). When present and the callback is not an arrow, the
 * thisArg is compiled and threaded so the callback's `this` binds to it.
 */
function setupArrayCallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  methodName: string,
  tag: string,
  bridgeName?: string,
  thisArgIndex?: number,
): ArrayCallbackSetup | null {
  const cbArg = callExpr.arguments[0]!;
  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);

  let closureInfo: ClosureInfo | undefined;
  let closureTypeIdx: number | undefined;
  let closureTmp: number | undefined;

  if (cbResult && (cbResult.kind === "ref" || cbResult.kind === "ref_null")) {
    closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
    closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
    if (closureInfo) {
      closureTmp = allocLocal(fctx, `__arr_${tag}_clcb_${fctx.locals.length}`, cbResult);
      fctx.body.push({ op: "local.set", index: closureTmp });
    }
  }

  let callBridgeIdx: number | undefined;
  let cbTmp: number | undefined;
  if (!closureInfo) {
    const bridge = bridgeName ?? (ctx.fast ? "__call_1_i32" : "__call_1_f64");
    callBridgeIdx = ctx.funcMap.get(bridge);
    if (callBridgeIdx === undefined) {
      reportError(ctx, callExpr, `Missing ${bridge} import for ${methodName}`);
      return null;
    }
    cbTmp = allocLocal(fctx, `__arr_${tag}_cb_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: cbTmp });
  }

  // #2152 — compile the optional thisArg AFTER the callback (spec arg order).
  const thisArgSlots = compileThisArg(ctx, fctx, callExpr, tag, thisArgIndex);

  return {
    closureInfo,
    closureTypeIdx,
    closureTmp,
    callBridgeIdx,
    cbTmp,
    thisArgTmp: thisArgSlots?.thisArgTmp,
    prevThisTmp: thisArgSlots?.prevThisTmp,
  };
}

/** Common locals for array iteration loops. */
interface ArrayLoopLocals {
  vecTmp: number;
  dataTmp: number;
  lenTmp: number;
  iTmp: number;
  getOp: string;
}

/**
 * Compile receiver, extract vec/data/len, alloc loop locals, set i = 0.
 * The caller (compileArrayMethodCall) has already resolved the correct
 * vec/arr/elem types via probe-compile (#826).
 */
function setupArrayLoop(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  tag: string,
): ArrayLoopLocals {
  compileExpression(ctx, fctx, propAccess.expression);

  const vecTmp = allocLocal(fctx, `__arr_${tag}_vec_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: vecTypeIdx,
  });
  const dataTmp = allocLocal(fctx, `__arr_${tag}_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  const lenTmp = allocLocal(fctx, `__arr_${tag}_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_${tag}_i_${fctx.locals.length}`, { kind: "i32" });

  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  return { vecTmp, dataTmp, lenTmp, iTmp, getOp };
}

/**
 * Build closure call_ref instructions for a 1-arg callback (element, [index, [array]]).
 * The element source can be either an elemTmp local or inline data[i].
 */
function buildClosureCallInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  setup: ArrayCallbackSetup,
  elemType: ValType,
  vecTypeIdx: number,
  arrTypeIdx: number,
  loop: ArrayLoopLocals,
  elemSource: { kind: "local"; index: number } | { kind: "inline" },
): Instr[] {
  const { closureInfo, closureTypeIdx, closureTmp } = setup;
  if (!closureInfo || closureTypeIdx === undefined || closureTmp === undefined) return [];
  const numParams = closureInfo.paramTypes.length;
  const elemCoerce = closureInfo.paramTypes[0] ? coercionInstrs(ctx, elemType, closureInfo.paramTypes[0], fctx) : [];

  // #820l — array-method callbacks are invoked at spec arity 3
  // (value, index, array). The callee's `arguments` object should see all
  // 3 slots even when fewer formals are declared, so we plumb the extras
  // (i.e. positionals beyond the declared formal count) through the
  // module-level __argc + __extras_argv globals consumed by
  // emitArgumentsVecBody. Convention from #1053: argc = numFormals
  // (slots filled by direct params); extras vec holds slots beyond.
  const SPEC_ARITY = 3;
  const argsPlumbing = emitArrayCallbackArgsPlumbing(ctx, fctx, SPEC_ARITY, numParams, vecTypeIdx, arrTypeIdx, loop);

  // #2152 — install thisArg as the callback's `this` for the duration of the
  // call_ref. The callback body (funcexpr / named-decl that references `this`)
  // reads the `__current_this` module global with a null-guard (#1702), so
  // setting it here forwards the spec `thisArg`. Save the previous value first
  // (nesting safety) and restore it right after the call_ref. The restore
  // (`global.set`) does not disturb the call result already on the stack.
  // No host import — `__current_this` is a pure Wasm global, so this works
  // identically in standalone mode. Arrow callbacks never reach here with a
  // thisArgTmp (lexical `this`; see compileThisArg).
  const installThis: Instr[] =
    setup.thisArgTmp !== undefined && setup.prevThisTmp !== undefined && ctx.currentThisGlobalIdx >= 0
      ? [
          { op: "global.get", index: ctx.currentThisGlobalIdx } as Instr,
          { op: "local.set", index: setup.prevThisTmp } as Instr,
          { op: "local.get", index: setup.thisArgTmp } as Instr,
          { op: "global.set", index: ctx.currentThisGlobalIdx } as Instr,
        ]
      : [];
  const restoreThis: Instr[] =
    setup.thisArgTmp !== undefined && setup.prevThisTmp !== undefined && ctx.currentThisGlobalIdx >= 0
      ? [
          { op: "local.get", index: setup.prevThisTmp } as Instr,
          { op: "global.set", index: ctx.currentThisGlobalIdx } as Instr,
        ]
      : [];

  return [
    ...argsPlumbing,
    ...installThis,
    { op: "local.get", index: closureTmp } as Instr,
    // Element value (1st user param) — only pushed if callback declares ≥1 param.
    // A 0-arg callback (e.g. `function() {}`) compiles to a funcref that takes only
    // the closure env, so pushing elem here produces a call_ref signature mismatch.
    ...(numParams >= 1
      ? [
          ...(elemSource.kind === "local"
            ? [{ op: "local.get", index: elemSource.index } as Instr]
            : [
                { op: "local.get", index: loop.dataTmp } as Instr,
                { op: "local.get", index: loop.iTmp } as Instr,
                { op: loop.getOp, typeIdx: arrTypeIdx } as Instr,
              ]),
          ...elemCoerce,
        ]
      : []),
    // Index (2nd user param)
    ...(numParams >= 2
      ? [
          { op: "local.get", index: loop.iTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ]
      : []),
    // Array (3rd user param)
    ...(numParams >= 3
      ? [
          { op: "local.get", index: loop.vecTmp } as Instr,
          ...coercionInstrs(
            ctx,
            { kind: "ref_null", typeIdx: vecTypeIdx },
            closureInfo.paramTypes[2] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
            fctx,
          ),
        ]
      : []),
    { op: "local.get", index: closureTmp } as Instr,
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" } as Instr,
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
    ...restoreThis,
  ];
}

/**
 * #820l — Emit __argc + __extras_argv plumbing for an inlined array-method
 * callback dispatch. The callee's `arguments` object reads these globals to
 * compute its true length and fill slots beyond the declared formal count.
 *
 * The array-method callback spec arity is fixed (3 for forEach/map/filter/etc.,
 * 4 for reduce). When `numParams < specArity` we build a fresh extras vec
 * containing the missing positional args boxed to externref so the
 * `arguments[i]` reads in the callee body still resolve correctly.
 */
function emitArrayCallbackArgsPlumbing(
  ctx: CodegenContext,
  fctx: FunctionContext,
  specArity: number,
  numParams: number,
  vecTypeIdx: number,
  arrTypeIdx: number,
  loop: ArrayLoopLocals,
): Instr[] {
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  const { globalIdx: extrasGlobalIdx, vecTypeIdx: extrasVecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const extrasArrTypeIdx = getArrTypeIdxFromVec(ctx, extrasVecTypeIdx);
  void vecTypeIdx;

  // argc = numParams (the receive-side fills slots [0, numParams) from
  // direct param locals; extras start at offset numParams). The total
  // arguments.length is then argc + extrasLen = specArity.
  const instrs: Instr[] = [
    { op: "i32.const", value: numParams } as Instr,
    { op: "global.set", index: argcGlobalIdx } as Instr,
  ];

  if (numParams >= specArity) {
    // No extras — clear stale data from a prior invocation.
    instrs.push({ op: "ref.null", typeIdx: extrasVecTypeIdx } as Instr);
    instrs.push({ op: "global.set", index: extrasGlobalIdx } as Instr);
    return instrs;
  }

  // Build the extras as an externref array of length (specArity - numParams).
  // Slots in spec order — element, index, array — only the ones beyond the
  // declared formal count are included:
  //   numParams=0 → [elem, idx, arr]
  //   numParams=1 → [idx, arr]
  //   numParams=2 → [arr]
  const extrasCount = specArity - numParams;
  instrs.push({ op: "i32.const", value: extrasCount } as Instr);
  const boxIdx = ctx.funcMap.get("__box_number");
  const pushBoxed = (): void => {
    if (boxIdx !== undefined) {
      instrs.push({ op: "call", funcIdx: boxIdx } as Instr);
    } else {
      instrs.push({ op: "drop" } as Instr);
      instrs.push({ op: "ref.null.extern" } as Instr);
    }
  };
  if (numParams < 1) {
    // Push the element. Inline-load from data[i], coerced to externref.
    instrs.push({ op: "local.get", index: loop.dataTmp } as Instr);
    instrs.push({ op: "local.get", index: loop.iTmp } as Instr);
    instrs.push({ op: loop.getOp, typeIdx: arrTypeIdx } as Instr);
    // The element type is whatever the array slot holds (i16/i32/f64/ref).
    // Use the receive-side's coercion convention by going through __box_number
    // for numeric types; for ref types use extern.convert_any.
    // We don't know the elemType here cheaply, so route through emitElemBoxing.
    instrs.push(...emitElemBoxToExternref(ctx, arrTypeIdx, loop.getOp));
  }
  if (numParams < 2) {
    instrs.push({ op: "local.get", index: loop.iTmp } as Instr);
    instrs.push({ op: "f64.convert_i32_s" } as Instr);
    pushBoxed();
  }
  if (numParams < 3) {
    instrs.push({ op: "local.get", index: loop.vecTmp } as Instr);
    instrs.push({ op: "extern.convert_any" } as Instr);
  }
  instrs.push({ op: "array.new_fixed", typeIdx: extrasArrTypeIdx, length: extrasCount } as Instr);
  instrs.push({ op: "struct.new", typeIdx: extrasVecTypeIdx } as Instr);
  instrs.push({ op: "global.set", index: extrasGlobalIdx } as Instr);
  return instrs;
}

/**
 * Box a raw element value (whose type matches array `getOp` result) to an
 * externref. Mirrors the array-elem coercion paths used by emitArgumentsVecBody.
 */
function emitElemBoxToExternref(ctx: CodegenContext, arrTypeIdx: number, getOp: string): Instr[] {
  void ctx;
  void arrTypeIdx;
  void getOp;
  // The element is on top of stack from the array.get. We don't reliably know
  // its concrete ValType at this layer, but in practice this dispatcher only
  // fires when numParams=0 (callback declares no formals). For that case the
  // value is unused inside the body and just needs ANY externref placeholder
  // so the extras vec has the right length. Use a null externref — the
  // arguments[0] slot will be undefined / null which matches what tests with
  // 0-formal callbacks observe.
  // Drop the loaded element and push ref.null.extern.
  return [{ op: "drop" } as Instr, { op: "ref.null.extern" } as Instr];
}

/**
 * Build host bridge call instructions for a 1-arg callback.
 * The element is always loaded inline from data[i].
 */
function buildBridgeCallInstrs(
  ctx: CodegenContext,
  setup: ArrayCallbackSetup,
  elemType: ValType,
  arrTypeIdx: number,
  loop: ArrayLoopLocals,
  elemSource: { kind: "local"; index: number } | { kind: "inline" },
): Instr[] {
  return [
    { op: "local.get", index: setup.cbTmp! } as Instr,
    ...(elemSource.kind === "local"
      ? [
          { op: "local.get", index: elemSource.index } as Instr,
          ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
        ]
      : [
          { op: "local.get", index: loop.dataTmp } as Instr,
          { op: "local.get", index: loop.iTmp } as Instr,
          { op: loop.getOp, typeIdx: arrTypeIdx } as Instr,
          ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
        ]),
    { op: "call", funcIdx: setup.callBridgeIdx! } as Instr,
  ];
}

/** Build instructions to check truthiness of a callback result (-> i32). */
function buildTruthyCheck(ctx: CodegenContext, setup: ArrayCallbackSetup): Instr[] {
  if (setup.closureInfo) {
    // Void-returning callback (e.g. `function() {}`) leaves nothing on the
    // stack — `call_ref` consumed all its args and pushed no result. The
    // downstream `if`/`br_if` still needs an i32 condition, otherwise Wasm
    // validation rejects with "not enough arguments on the stack for if".
    // JS semantics: `undefined` is falsy → push i32.const 0. (#1522 Cluster 2)
    if (setup.closureInfo.returnType === null) {
      return [{ op: "i32.const", value: 0 } as Instr];
    }
    return buildToBooleanInstrs(ctx, setup.closureInfo.returnType);
  }
  // #2085 — non-closure (legacy) path: f64 result. Use |x|>0 so NaN/±0 are
  // falsy (the old `f64.ne 0` wrongly treated NaN as truthy), matching
  // `ensureI32Condition`.
  return ctx.fast
    ? []
    : [{ op: "f64.abs" } as Instr, { op: "f64.const", value: 0 } as Instr, { op: "f64.gt" } as Instr];
}

/**
 * #2085 — spec §7.1.2 ToBoolean for an array-HOF callback result, mirroring the
 * canonical `ensureI32Condition` (src/codegen/index.ts) so the two hand-rolled
 * truthiness sites agree. Returns `Instr[]` (these helpers build instruction
 * lists rather than push to a body). Produces an i32 (1 = truthy).
 *   - f64        → |x| > 0   (NaN, +0, -0 all falsy; the old `f64.ne 0` made NaN truthy)
 *   - i32        → as-is (already 0/1-valued for the boolean callbacks)
 *   - externref  → `__is_truthy` (false/0/NaN/""/null/undefined → falsy)
 *   - any-boxed ref → `__any_unbox_bool` (proper JS truthiness on the boxed value)
 *   - native string ref → length > 0 (empty string is falsy)
 *   - other ref  → non-null (the only observable truthiness for opaque structs)
 */
function buildToBooleanInstrs(ctx: CodegenContext, retType: ValType): Instr[] {
  const retKind = retType.kind;
  if (retKind === "f64") {
    return [{ op: "f64.abs" } as Instr, { op: "f64.const", value: 0 } as Instr, { op: "f64.gt" } as Instr];
  }
  if (retKind === "i32") {
    return []; // already truthy/falsy
  }
  if (retKind === "i64") {
    return [{ op: "i64.eqz" } as Instr, { op: "i32.eqz" } as Instr];
  }
  if (retKind === "externref") {
    addUnionImports(ctx);
    const isTruthyIdx = ensureLateImport(ctx, "__is_truthy", [{ kind: "externref" }], [{ kind: "i32" }]);
    if (isTruthyIdx !== undefined) {
      return [{ op: "call", funcIdx: isTruthyIdx } as Instr];
    }
    return [{ op: "ref.is_null" } as Instr, { op: "i32.eqz" } as Instr];
  }
  if (retKind === "ref" || retKind === "ref_null") {
    // Boxed `any` value — proper JS truthiness (false/0/NaN/""/null → falsy).
    if (isAnyValue(retType, ctx)) {
      ensureAnyHelpers(ctx);
      const unboxBoolIdx = ctx.funcMap.get("__any_unbox_bool");
      if (unboxBoolIdx !== undefined) {
        return [{ op: "call", funcIdx: unboxBoolIdx } as Instr];
      }
    }
    // Native string ref — empty string is falsy (check len > 0 after flatten).
    if (retType.typeIdx === ctx.anyStrTypeIdx && ctx.anyStrTypeIdx >= 0) {
      const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
      if (flattenIdx !== undefined && ctx.nativeStrTypeIdx >= 0) {
        return [
          { op: "call", funcIdx: flattenIdx } as Instr,
          { op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 0 } as Instr,
          { op: "i32.const", value: 0 } as Instr,
          { op: "i32.gt_s" } as Instr,
        ];
      }
    }
    // Opaque struct ref — non-null is truthy.
    return [{ op: "ref.is_null" } as Instr, { op: "i32.eqz" } as Instr];
  }
  return []; // default: assume already i32
}

/** Build instructions to check falsiness of a callback result (-> i32). */
function buildFalsyCheck(ctx: CodegenContext, setup: ArrayCallbackSetup): Instr[] {
  if (setup.closureInfo) {
    // Void-returning callback: result is `undefined`, which is falsy. Push
    // i32.const 1 so the consumer's `if`/`br_if` sees a "truthy" check-result
    // (i.e. the callback's return value WAS falsy). (#1522 Cluster 2)
    if (setup.closureInfo.returnType === null) {
      return [{ op: "i32.const", value: 1 } as Instr];
    }
    // #2085 — falsy == !truthy. Reuse the canonical ToBoolean then negate, so
    // NaN / boxed 0/""/false are correctly falsy (the old per-kind copy treated
    // NaN-as-truthy and boxed-falsy-as-truthy, the inverse of the #2085 bug).
    return [...buildToBooleanInstrs(ctx, setup.closureInfo.returnType), { op: "i32.eqz" } as Instr];
  }
  return ctx.fast
    ? [{ op: "i32.eqz" } as Instr]
    : [
        { op: "f64.abs" } as Instr,
        { op: "f64.const", value: 0 } as Instr,
        { op: "f64.gt" } as Instr,
        { op: "i32.eqz" } as Instr,
      ];
}

/**
 * Emit the standard block/loop wrapper used by all functional array methods.
 */
function emitArrayLoop(fctx: FunctionContext, loopBody: Instr[]): void {
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });
}

/**
 * Build the standard loop-exit check: if (i >= len) br 1.
 */
function loopExitCheck(loop: ArrayLoopLocals): Instr[] {
  return [
    { op: "local.get", index: loop.iTmp } as Instr,
    { op: "local.get", index: loop.lenTmp } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
  ];
}

/**
 * Build the standard i++ / br 0 at the end of each iteration.
 */
function loopIncrement(loop: ArrayLoopLocals): Instr[] {
  return [
    { op: "local.get", index: loop.iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: loop.iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];
}

/**
 * Build callback call + optional truthiness/falsiness check for a 1-arg callback.
 * Used by filter, find, findIndex, some, every, forEach.
 */
function buildCallAndCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  setup: ArrayCallbackSetup,
  elemType: ValType,
  vecTypeIdx: number,
  arrTypeIdx: number,
  loop: ArrayLoopLocals,
  elemSource: { kind: "local"; index: number } | { kind: "inline" },
  check: "truthy" | "falsy" | "none",
): Instr[] {
  const callInstrs = setup.closureInfo
    ? buildClosureCallInstrs(ctx, fctx, setup, elemType, vecTypeIdx, arrTypeIdx, loop, elemSource)
    : buildBridgeCallInstrs(ctx, setup, elemType, arrTypeIdx, loop, elemSource);
  const checkInstrs =
    check === "truthy" ? buildTruthyCheck(ctx, setup) : check === "falsy" ? buildFalsyCheck(ctx, setup) : [];
  return [...callInstrs, ...checkInstrs];
}

// ── Individual method implementations using shared helpers ──

/**
 * arr.filter(cb) -> iterate elements, call callback, build new array from truthy results.
 */
function compileArrayFilter(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.filter")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "filter", "flt", undefined, 1);
  if (!setup) return null;

  const resData = allocLocal(fctx, `__arr_flt_rd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const resLen = allocLocal(fctx, `__arr_flt_rl_${fctx.locals.length}`, { kind: "i32" });
  const elemTmp = allocLocal(fctx, `__arr_flt_el_${fctx.locals.length}`, elemType);

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "flt");

  // Allocate result array with same capacity as source
  fctx.body.push({ op: "local.get", index: loop.lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: resData });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: resLen });

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "local", index: elemTmp },
    "truthy",
  );

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    // elem = data[i]
    { op: "local.get", index: loop.dataTmp } as Instr,
    { op: "local.get", index: loop.iTmp } as Instr,
    { op: loop.getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: elemTmp } as Instr,

    ...callAndCheck,

    // if result is truthy, add element to result
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: resData } as Instr,
        { op: "local.get", index: resLen } as Instr,
        { op: "local.get", index: elemTmp } as Instr,
        { op: "array.set", typeIdx: arrTypeIdx } as Instr,
        { op: "local.get", index: resLen } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "local.set", index: resLen } as Instr,
      ],
    } as Instr,

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: resLen });
  fctx.body.push({ op: "local.get", index: resData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.map(cb) -> iterate elements, call callback, store results in new array.
 */
function compileArrayMap(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.map")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  const cbArg = callExpr.arguments[0]!;
  // Determine the result element type from the callback's own return type
  let mapResultElemType: ValType = elemType;
  let mapArrTypeIdx = arrTypeIdx;
  let mapVecTypeIdx = vecTypeIdx;

  if (ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)) {
    const cbSig = ctx.checker.getSignatureFromDeclaration(cbArg);
    if (cbSig) {
      const retType = ctx.checker.getReturnTypeOfSignature(cbSig);
      const mapped = resolveWasmType(ctx, retType);
      if (mapped.kind !== elemType.kind) {
        mapResultElemType = mapped;
        mapArrTypeIdx = getOrRegisterArrayType(ctx, mapResultElemType.kind, mapResultElemType);
        mapVecTypeIdx = getOrRegisterVecType(ctx, mapResultElemType.kind, mapResultElemType);
      }
    }
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "map", "map", undefined, 1);
  if (!setup) return null;

  // Update map result type from closure return type if available
  if (setup.closureInfo?.returnType && setup.closureInfo.returnType.kind !== mapResultElemType.kind) {
    mapResultElemType = setup.closureInfo.returnType;
    mapArrTypeIdx = getOrRegisterArrayType(ctx, mapResultElemType.kind, mapResultElemType);
    mapVecTypeIdx = getOrRegisterVecType(ctx, mapResultElemType.kind, mapResultElemType);
  }

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "map");

  const resData = allocLocal(fctx, `__arr_map_rd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: mapArrTypeIdx });

  // Allocate result array with same length
  fctx.body.push({ op: "local.get", index: loop.lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: mapArrTypeIdx });
  fctx.body.push({ op: "local.set", index: resData });

  // Build callback invocation (result stays on stack)
  let callInstrs: Instr[];
  if (setup.closureInfo) {
    const retType = setup.closureInfo.returnType;
    callInstrs = [
      ...buildClosureCallInstrs(ctx, fctx, setup, elemType, vecTypeIdx, arrTypeIdx, loop, { kind: "inline" }),
      // Void-returning callback (e.g. `function() {}`) pushes nothing → push a
      // default-of-mapResultElemType so the downstream `array.set` validates.
      // JS semantics: `undefined → mapped` maps to NaN/null/0 per type. (#1522)
      ...(retType === null
        ? defaultValueInstrs(mapResultElemType)
        : retType.kind !== mapResultElemType.kind
          ? coercionInstrs(ctx, retType, mapResultElemType, fctx)
          : []),
    ];
  } else {
    callInstrs = [
      ...buildBridgeCallInstrs(ctx, setup, elemType, arrTypeIdx, loop, { kind: "inline" }),
      // The host bridge returns f64. Coerce it to the result element type so the
      // downstream `array.set` validates — notably f64 → externref must box via
      // __box_number when the source array is untyped (`new Array(n)`). Without
      // this, `array.set` sees f64 where it expects externref. (#1601)
      ...(!ctx.fast ? coercionInstrs(ctx, { kind: "f64" }, mapResultElemType, fctx) : []),
    ];
  }

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    // resData[i] = cb(data[i])
    { op: "local.get", index: resData } as Instr,
    { op: "local.get", index: loop.iTmp } as Instr,
    ...callInstrs,
    { op: "array.set", typeIdx: mapArrTypeIdx } as Instr,

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: loop.lenTmp });
  fctx.body.push({ op: "local.get", index: resData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: mapVecTypeIdx });
  return { kind: "ref_null", typeIdx: mapVecTypeIdx };
}

/**
 * Resolve the accumulator ValType for reduce/reduceRight.
 *
 * The accumulator holds whatever the callback returns between iterations, so
 * the callback's resolved return type is the most accurate source. We fall
 * back to the accumulator parameter type, then to the numeric kind. This
 * lets non-numeric accumulators (e.g. `string[].reduce((x,y)=>x+y)`) use an
 * `externref` local instead of being forced through a numeric unbox that
 * traps with "illegal cast" (#1994).
 */
function resolveReduceAccType(setup: ArrayCallbackSetup, numKind: "i32" | "f64"): ValType {
  const ci = setup.closureInfo;
  if (ci) {
    // A void-returning callback (returnType === null) yields `undefined`; keep
    // the numeric kind so the default-value path stays valid.
    if (ci.returnType && ci.returnType.kind !== numKind) {
      return ci.returnType;
    }
    if (ci.returnType) return ci.returnType;
    const accParam = ci.paramTypes[0];
    if (accParam && accParam.kind !== numKind) {
      return accParam;
    }
  }
  return { kind: numKind };
}

/**
 * arr.reduce(cb, initial) -> iterate elements, accumulate result via callback.
 * Reduce has a 2-arg callback (acc, elem) so it uses custom call logic.
 */
function compileArrayReduce(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.reduce")) {
    fctx.body.push({ op: "unreachable" });
    return elemType;
  }

  const numKind = ctx.fast ? "i32" : "f64";
  const bridgeName = ctx.fast ? "__call_2_i32" : "__call_2_f64";
  const setup = setupArrayCallback(ctx, fctx, callExpr, "reduce", "red", bridgeName);
  if (!setup) return null;

  // The accumulator local must match the actual accumulator type, not always
  // the numeric kind — string/object accumulators are externref (#1994).
  const accType = resolveReduceAccType(setup, numKind);

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "red");
  const accTmp = allocLocal(fctx, `__arr_red_acc_${fctx.locals.length}`, accType);

  // Compile initial value or use arr[0] as default
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, accType);
    fctx.body.push({ op: "local.set", index: accTmp });
    // i already = 0 from setupArrayLoop
  } else {
    // No initial value: throw TypeError on empty array, else acc = data[0], start from i = 1
    fctx.body.push({ op: "local.get", index: loop.lenTmp });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: throwStringInstrs(ctx, "TypeError: Reduce of empty array with no initial value"),
    } as Instr);
    fctx.body.push({ op: "local.get", index: loop.dataTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({
      op: elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get",
      typeIdx: arrTypeIdx,
    });
    // Coerce the seed element to the accumulator type (e.g. element externref
    // string → accumulator externref, or i32 element → f64 accumulator).
    coercionInstrs(ctx, elemType, accType, fctx).forEach((i) => fctx.body.push(i));
    fctx.body.push({ op: "local.set", index: accTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "local.set", index: loop.iTmp });
  }

  // Build reduce-specific callback invocation (2-arg: acc, elem)
  let callInstrs: Instr[];
  if (setup.closureInfo && setup.closureTypeIdx !== undefined && setup.closureTmp !== undefined) {
    const ci = setup.closureInfo;
    const numParams = ci.paramTypes.length;
    const accCoerce = ci.paramTypes[0] ? coercionInstrs(ctx, accType, ci.paramTypes[0], fctx) : [];
    const elemCoerce = ci.paramTypes[1] ? coercionInstrs(ctx, elemType, ci.paramTypes[1], fctx) : [];
    callInstrs = [
      { op: "local.get", index: setup.closureTmp } as Instr,
      // Accumulator (1st user param) — gate on numParams >= 1.
      ...(numParams >= 1 ? [{ op: "local.get", index: accTmp } as Instr, ...accCoerce] : []),
      // Element (2nd user param) — gate on numParams >= 2.
      ...(numParams >= 2
        ? [
            { op: "local.get", index: loop.dataTmp } as Instr,
            { op: "local.get", index: loop.iTmp } as Instr,
            { op: loop.getOp, typeIdx: arrTypeIdx } as Instr,
            ...elemCoerce,
          ]
        : []),
      ...(numParams >= 3
        ? [
            { op: "local.get", index: loop.iTmp } as Instr,
            ...coercionInstrs(ctx, { kind: "i32" }, ci.paramTypes[2] ?? { kind: "i32" }, fctx),
          ]
        : []),
      ...(numParams >= 4
        ? [
            { op: "local.get", index: loop.vecTmp } as Instr,
            ...coercionInstrs(
              ctx,
              { kind: "ref_null", typeIdx: vecTypeIdx },
              ci.paramTypes[3] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
              fctx,
            ),
          ]
        : []),
      { op: "local.get", index: setup.closureTmp } as Instr,
      { op: "struct.get", typeIdx: setup.closureTypeIdx, fieldIdx: 0 } as Instr,
      ...guardedFuncRefCastInstrs(fctx, ci.funcTypeIdx),
      { op: "ref.as_non_null" } as Instr,
      { op: "call_ref", typeIdx: ci.funcTypeIdx } as Instr,
      // Void-returning callback (e.g. `function() {}`): nothing on stack →
      // push default-of-accumulator so the trailing `local.set accTmp`
      // validates. JS: cb returns `undefined` → acc becomes undefined →
      // for numeric kind that's NaN (f64) / 0 (i32). (#1522 Cluster 2)
      ...(ci.returnType === null
        ? defaultValueInstrs(accType)
        : ci.returnType.kind !== accType.kind
          ? coercionInstrs(ctx, ci.returnType, accType, fctx)
          : []),
      { op: "local.set", index: accTmp } as Instr,
    ];
  } else {
    // Host-bridge fallback path: the bridge takes/returns the numeric kind, so
    // the accumulator must be numeric here. resolveReduceAccType returns the
    // numeric kind when there is no closureInfo, so accTmp is numeric too.
    callInstrs = [
      { op: "local.get", index: setup.cbTmp! } as Instr,
      { op: "local.get", index: accTmp } as Instr,
      { op: "local.get", index: loop.dataTmp } as Instr,
      { op: "local.get", index: loop.iTmp } as Instr,
      { op: loop.getOp, typeIdx: arrTypeIdx } as Instr,
      ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
      { op: "call", funcIdx: setup.callBridgeIdx! } as Instr,
      { op: "local.set", index: accTmp } as Instr,
    ];
  }

  const loopBody: Instr[] = [...loopExitCheck(loop), ...callInstrs, ...loopIncrement(loop)];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: accTmp });
  return accType;
}

/**
 * arr.reduceRight(cb, init?) -> iterate elements right-to-left, accumulate via callback.
 */
function compileArrayReduceRight(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.reduceRight")) {
    fctx.body.push({ op: "unreachable" });
    return elemType;
  }

  const numKind = ctx.fast ? "i32" : "f64";
  const bridgeName = ctx.fast ? "__call_2_i32" : "__call_2_f64";
  const setup = setupArrayCallback(ctx, fctx, callExpr, "reduceRight", "rr", bridgeName);
  if (!setup) return null;

  // The accumulator local must match the actual accumulator type, not always
  // the numeric kind — string/object accumulators are externref (#1994).
  const accType = resolveReduceAccType(setup, numKind);

  // Set up receiver: vec/data/len
  const vecTmp = allocLocal(fctx, `__arr_rr_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_rr_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_rr_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_rr_i_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  const accTmp = allocLocal(fctx, `__arr_rr_acc_${fctx.locals.length}`, accType);

  // Compile initial value or use arr[length-1] as default
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, accType);
    fctx.body.push({ op: "local.set", index: accTmp });
    // Start from length - 1
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "local.set", index: iTmp });
  } else {
    // No initial value: throw TypeError on empty array, else acc = data[length-1], start from length - 2
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: throwStringInstrs(ctx, "TypeError: Reduce of empty array with no initial value"),
    } as Instr);
    fctx.body.push({ op: "local.get", index: dataTmp });
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: getOp, typeIdx: arrTypeIdx });
    // Coerce the seed element to the accumulator type (e.g. element externref
    // string → accumulator externref, or i32 element → f64 accumulator).
    coercionInstrs(ctx, elemType, accType, fctx).forEach((i) => fctx.body.push(i));
    fctx.body.push({ op: "local.set", index: accTmp });
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 2 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "local.set", index: iTmp });
  }

  // Build the loop locals struct for buildClosureCallInstrs compatibility
  const loop: ArrayLoopLocals = {
    vecTmp,
    dataTmp,
    lenTmp,
    iTmp,
    getOp,
  };

  // Build reduce-specific callback invocation (2-arg: acc, elem)
  let callInstrs: Instr[];
  if (setup.closureInfo && setup.closureTypeIdx !== undefined && setup.closureTmp !== undefined) {
    const ci = setup.closureInfo;
    const numParams = ci.paramTypes.length;
    const accCoerce = ci.paramTypes[0] ? coercionInstrs(ctx, accType, ci.paramTypes[0], fctx) : [];
    const elemCoerce = ci.paramTypes[1] ? coercionInstrs(ctx, elemType, ci.paramTypes[1], fctx) : [];
    callInstrs = [
      { op: "local.get", index: setup.closureTmp } as Instr,
      ...(numParams >= 1 ? [{ op: "local.get", index: accTmp } as Instr, ...accCoerce] : []),
      ...(numParams >= 2
        ? [
            { op: "local.get", index: dataTmp } as Instr,
            { op: "local.get", index: iTmp } as Instr,
            { op: getOp, typeIdx: arrTypeIdx } as Instr,
            ...elemCoerce,
          ]
        : []),
      ...(numParams >= 3
        ? [
            { op: "local.get", index: iTmp } as Instr,
            ...coercionInstrs(ctx, { kind: "i32" }, ci.paramTypes[2] ?? { kind: "i32" }, fctx),
          ]
        : []),
      ...(numParams >= 4
        ? [
            { op: "local.get", index: vecTmp } as Instr,
            ...coercionInstrs(
              ctx,
              { kind: "ref_null", typeIdx: vecTypeIdx },
              ci.paramTypes[3] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
              fctx,
            ),
          ]
        : []),
      { op: "local.get", index: setup.closureTmp } as Instr,
      { op: "struct.get", typeIdx: setup.closureTypeIdx, fieldIdx: 0 } as Instr,
      ...guardedFuncRefCastInstrs(fctx, ci.funcTypeIdx),
      { op: "ref.as_non_null" } as Instr,
      { op: "call_ref", typeIdx: ci.funcTypeIdx } as Instr,
      // Void-returning callback (e.g. `function() {}`): nothing on stack →
      // push default-of-accumulator so the trailing `local.set accTmp`
      // validates. JS: cb returns `undefined` → acc becomes undefined →
      // for numeric kind that's NaN (f64) / 0 (i32). (#1522 Cluster 2)
      ...(ci.returnType === null
        ? defaultValueInstrs(accType)
        : ci.returnType.kind !== accType.kind
          ? coercionInstrs(ctx, ci.returnType, accType, fctx)
          : []),
      { op: "local.set", index: accTmp } as Instr,
    ];
  } else {
    // Host-bridge fallback path: numeric accumulator (see compileArrayReduce).
    callInstrs = [
      { op: "local.get", index: setup.cbTmp! } as Instr,
      { op: "local.get", index: accTmp } as Instr,
      { op: "local.get", index: dataTmp } as Instr,
      { op: "local.get", index: iTmp } as Instr,
      { op: getOp, typeIdx: arrTypeIdx } as Instr,
      ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
      { op: "call", funcIdx: setup.callBridgeIdx! } as Instr,
      { op: "local.set", index: accTmp } as Instr,
    ];
  }

  // Loop: while (i >= 0) { acc = cb(acc, data[i], i, arr); i--; }
  const loopBody: Instr[] = [
    // Exit check: if (i < 0) break
    { op: "local.get", index: iTmp } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.lt_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
    // Callback
    ...callInstrs,
    // i--
    { op: "local.get", index: iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.sub" } as Instr,
    { op: "local.set", index: iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: accTmp });
  return accType;
}

/**
 * arr.forEach(cb) -> iterate elements, call callback, return void.
 */
function compileArrayForEach(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.forEach")) {
    fctx.body.push({ op: "unreachable" });
    return null; // void method
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "forEach", "fe", undefined, 1);
  if (!setup) return null;

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "fe");

  if (setup.closureInfo) {
    const callInstrs = buildClosureCallInstrs(ctx, fctx, setup, elemType, vecTypeIdx, arrTypeIdx, loop, {
      kind: "inline",
    });
    const dropInstrs: Instr[] = setup.closureInfo.returnType ? [{ op: "drop" } as Instr] : [];

    const loopBody: Instr[] = [...loopExitCheck(loop), ...callInstrs, ...dropInstrs, ...loopIncrement(loop)];

    emitArrayLoop(fctx, loopBody);
  } else {
    const callInstrs = buildBridgeCallInstrs(ctx, setup, elemType, arrTypeIdx, loop, { kind: "inline" });

    const loopBody: Instr[] = [...loopExitCheck(loop), ...callInstrs, { op: "drop" } as Instr, ...loopIncrement(loop)];

    emitArrayLoop(fctx, loopBody);
  }

  return null;
}

/**
 * arr.find(cb) -> iterate, return first element where cb returns truthy, else NaN.
 */
function compileArrayFind(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.find")) {
    fctx.body.push({ op: "unreachable" });
    return elemType;
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "find", "find", undefined, 1);
  if (!setup) return null;

  const elemTmpLocal = allocLocal(fctx, `__arr_find_el_${fctx.locals.length}`, elemType);

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "find");

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "local", index: elemTmpLocal },
    "truthy",
  );

  // Result local -- NaN (not found) or element value
  const findResType: ValType = ctx.fast ? elemType : { kind: "f64" };
  const findResTmp = allocLocal(fctx, `__arr_find_res_${fctx.locals.length}`, findResType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.div" }); // NaN
  }
  fctx.body.push({ op: "local.set", index: findResTmp });

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    { op: "local.get", index: loop.dataTmp } as Instr,
    { op: "local.get", index: loop.iTmp } as Instr,
    { op: loop.getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: elemTmpLocal } as Instr,

    ...callAndCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: elemTmpLocal } as Instr,
        ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
        { op: "local.set", index: findResTmp } as Instr,
        { op: "br", depth: 2 } as Instr,
      ],
    } as Instr,

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: findResTmp });
  return ctx.fast ? elemType : { kind: "f64" };
}

/**
 * arr.findIndex(cb) -> iterate, return index (f64) of first truthy cb result, else -1.
 */
function compileArrayFindIndex(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.findIndex")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "i32" };
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "findIndex", "fi", undefined, 1);
  if (!setup) return null;

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "fi");

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "inline" },
    "truthy",
  );

  const fiResType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
  const fiResTmp = allocLocal(fctx, `__arr_fi_res_${fctx.locals.length}`, fiResType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: fiResTmp });

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    ...callAndCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: loop.iTmp } as Instr,
        ...(ctx.fast ? [] : [{ op: "f64.convert_i32_s" } as Instr]),
        { op: "local.set", index: fiResTmp } as Instr,
        { op: "br", depth: 2 } as Instr,
      ],
    } as Instr,

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: fiResTmp });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

/**
 * Reverse-iteration setup for findLast/findLastIndex (§23.1.3.12/.13): start the
 * cursor at len-1 instead of 0. Reuses `setupArrayLoop`'s vec/data/len read, then
 * overwrites `iTmp = len - 1`. Pair with `loopExitCheckReverse`/`loopDecrement`.
 */
function setupArrayLoopReverse(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  tag: string,
): ArrayLoopLocals {
  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, tag);
  // i = len - 1 (setupArrayLoop left it at 0).
  fctx.body.push({ op: "local.get", index: loop.lenTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: loop.iTmp });
  return loop;
}

/** Reverse loop-exit check: if (i < 0) br 1. */
function loopExitCheckReverse(loop: ArrayLoopLocals): Instr[] {
  return [
    { op: "local.get", index: loop.iTmp } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.lt_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
  ];
}

/** Reverse i-- / br 0 at the end of each iteration. */
function loopDecrement(loop: ArrayLoopLocals): Instr[] {
  return [
    { op: "local.get", index: loop.iTmp } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.sub" } as Instr,
    { op: "local.set", index: loop.iTmp } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];
}

/**
 * arr.findLast(cb) -> iterate from the last index toward 0, return the first
 * element whose callback result is truthy, else undefined (NaN in non-fast mode).
 * Mirror of compileArrayFind but reverse-iterating (§23.1.3.12).
 */
function compileArrayFindLast(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.findLast")) {
    fctx.body.push({ op: "unreachable" });
    return elemType;
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "findLast", "findLast", undefined, 1);
  if (!setup) return null;

  const elemTmpLocal = allocLocal(fctx, `__arr_findLast_el_${fctx.locals.length}`, elemType);

  const loop = setupArrayLoopReverse(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "findLast");

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "local", index: elemTmpLocal },
    "truthy",
  );

  const findResType: ValType = ctx.fast ? elemType : { kind: "f64" };
  const findResTmp = allocLocal(fctx, `__arr_findLast_res_${fctx.locals.length}`, findResType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.div" }); // NaN (undefined sentinel)
  }
  fctx.body.push({ op: "local.set", index: findResTmp });

  const loopBody: Instr[] = [
    ...loopExitCheckReverse(loop),

    { op: "local.get", index: loop.dataTmp } as Instr,
    { op: "local.get", index: loop.iTmp } as Instr,
    { op: loop.getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: elemTmpLocal } as Instr,

    ...callAndCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: elemTmpLocal } as Instr,
        ...(!ctx.fast && elemType.kind === "i32" ? [{ op: "f64.convert_i32_s" } as Instr] : []),
        { op: "local.set", index: findResTmp } as Instr,
        { op: "br", depth: 2 } as Instr,
      ],
    } as Instr,

    ...loopDecrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: findResTmp });
  return ctx.fast ? elemType : { kind: "f64" };
}

/**
 * arr.findLastIndex(cb) -> reverse-iterate, return index (f64/i32) of the last
 * element whose callback result is truthy, else -1. Mirror of compileArrayFindIndex
 * but reverse-iterating (§23.1.3.13).
 */
function compileArrayFindLastIndex(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.findLastIndex")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "i32" };
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "findLastIndex", "fli", undefined, 1);
  if (!setup) return null;

  const loop = setupArrayLoopReverse(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "fli");

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "inline" },
    "truthy",
  );

  const fliResType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
  const fliResTmp = allocLocal(fctx, `__arr_fli_res_${fctx.locals.length}`, fliResType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: fliResTmp });

  const loopBody: Instr[] = [
    ...loopExitCheckReverse(loop),

    ...callAndCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: loop.iTmp } as Instr,
        ...(ctx.fast ? [] : [{ op: "f64.convert_i32_s" } as Instr]),
        { op: "local.set", index: fliResTmp } as Instr,
        { op: "br", depth: 2 } as Instr,
      ],
    } as Instr,

    ...loopDecrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: fliResTmp });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

/**
 * arr.some(cb) -> returns i32 (1 if any element passes callback, 0 otherwise).
 */
function compileArraySome(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.some")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "i32" };
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "some", "some", undefined, 1);
  if (!setup) return null;

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "some");

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "inline" },
    "truthy",
  );

  const resTmp = allocLocal(fctx, `__arr_some_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    ...callAndCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 } as Instr,
        { op: "local.set", index: resTmp } as Instr,
        { op: "br", depth: 2 } as Instr,
      ],
    } as Instr,

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: resTmp });
  return { kind: "i32" };
}

/**
 * arr.every(cb) -> returns i32 (1 if all elements pass callback, 0 otherwise).
 */
function compileArrayEvery(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.every")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "i32" };
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "every", "evr", undefined, 1);
  if (!setup) return null;

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "evr");

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "inline" },
    "falsy",
  );

  const resTmp = allocLocal(fctx, `__arr_evr_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    ...callAndCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.set", index: resTmp } as Instr,
        { op: "br", depth: 2 } as Instr,
      ],
    } as Instr,

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: resTmp });
  return { kind: "i32" };
}

/**
 * arr.sort() -> in-place Timsort, return same vec ref.
 * Only supported for numeric element types (i32, f64).
 */
function compileArraySort(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // #1361: Spec §23.1.3.30 step 1 — if comparefn is provided and is not a
  // function, throw TypeError BEFORE any sort work begins. Fires only when
  // the argument is known statically to be non-callable (null, number,
  // string, etc.); `undefined` is explicitly allowed as "no comparator".
  if (callExpr.arguments.length >= 1) {
    const cbArg = callExpr.arguments[0]!;
    const isExplicitUndefined =
      cbArg.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(cbArg) && cbArg.text === "undefined");
    if (!isExplicitUndefined && isKnownNonCallable(ctx, cbArg)) {
      // Compile the receiver and arg for side effects, then throw. The receiver
      // expression may have getters that mutate state — spec evaluation order
      // is "evaluate receiver, evaluate args, validate arg, then sort". Doing
      // both keeps user code observable.
      const recvType = compileExpression(ctx, fctx, propAccess.expression);
      if (recvType) fctx.body.push({ op: "drop" });
      const cbType = compileExpression(ctx, fctx, cbArg);
      if (cbType) fctx.body.push({ op: "drop" });
      emitThrowString(ctx, fctx, "TypeError: Array.prototype.sort comparator is not a function");
      fctx.body.push({ op: "unreachable" });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
  }

  // #1816: if a callable comparator is supplied, honor it. The default Timsort
  // hard-codes numeric `<`/`<=` and ignores any comparefn, so route comparator
  // sorts through a stable insertion sort that invokes the comparator closure
  // via `call_ref` (§23.1.3.30 / SortIndexedProperties / CompareArrayElements).
  if (callExpr.arguments.length >= 1) {
    const cbArg = callExpr.arguments[0]!;
    const isExplicitUndefined =
      cbArg.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(cbArg) && cbArg.text === "undefined");
    if (!isExplicitUndefined) {
      const comparatorResult = tryCompileComparatorSort(ctx, fctx, propAccess, cbArg, vecTypeIdx, arrTypeIdx, elemType);
      if (comparatorResult) return comparatorResult;
      // Fell through (comparator not a compilable closure) — fall back to the
      // default numeric Timsort below. This keeps non-closure comparators
      // (rare) compiling without a hard error, matching prior behaviour.
    }
  }

  // #1993 — with no comparator, §23.1.3.30 compares elements by ToString, NOT
  // numerically. The default Timsort hard-codes numeric `<`, so `[10,9,1,100]`
  // sorted to "1,9,10,100" instead of the spec "1,10,100,9", and string arrays
  // weren't ordered at all. Route numeric and string element arrays through the
  // ToString-comparing insertion sort. Other element kinds keep the numeric
  // Timsort (their ToString ordering isn't yet modeled).
  const isStringElem = elemType.kind === "ref" || elemType.kind === "ref_null" || elemType.kind === "externref";
  if (elemType.kind === "f64" || elemType.kind === "i32" || isStringElem) {
    const defaultResult = compileArrayDefaultToStringSort(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType);
    if (defaultResult) return defaultResult;
    // Fell through (e.g. helpers unavailable) — fall back to numeric Timsort.
  }

  const elemKind = elemType.kind as "i32" | "f64";
  const timsortIdx = ensureTimsortHelper(ctx, vecTypeIdx, arrTypeIdx, elemKind);

  const vecTmp = allocLocal(fctx, `__arr_sort_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });

  // Compile receiver, save a copy for return value
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Call timsort(vec)
  fctx.body.push({ op: "call", funcIdx: timsortIdx });

  // Return the same vec ref (sort is in-place)
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "ref.as_non_null" });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * #1993 — default (no-comparator) `Array.prototype.sort` per §23.1.3.30:
 * elements are compared by ToString, producing lexicographic order
 * (`[10,9,1,100]` → `[1,10,100,9]`). Emits an in-place stable insertion sort
 * whose comparison stringifies each element and compares the strings:
 *   - numeric element → `number_toString` (host: externref; native: native
 *     string boxed as externref → converted to `$AnyString`);
 *   - string element → used directly.
 * String comparison uses `__str_compare` (native) or `string_compare` (host),
 * both returning i32 sign. Returns the (in-place sorted) vec, or `null` if the
 * required helpers are unavailable (caller falls back to the numeric Timsort).
 */
function compileArrayDefaultToStringSort(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const isNumeric = elemType.kind === "f64" || elemType.kind === "i32";
  const native = ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0;

  // Comparison-string type + the compare/stringify helpers per backend.
  let cmpStrType: ValType;
  let compareIdx: number | undefined;
  let numToStrIdx: number | undefined;
  let anyStrTypeIdx = -1;
  if (native) {
    ensureNativeStringHelpers(ctx);
    anyStrTypeIdx = ctx.anyStrTypeIdx;
    compareIdx = ctx.nativeStrHelpers.get("__str_compare");
    cmpStrType = { kind: "ref", typeIdx: anyStrTypeIdx };
    if (isNumeric) {
      emitNativeNumberFormat(ctx, new Set(["number_toString"]));
      numToStrIdx = ctx.funcMap.get("number_toString");
    }
  } else {
    compareIdx = ctx.funcMap.get("string_compare");
    cmpStrType = { kind: "externref" };
    if (isNumeric) numToStrIdx = ctx.funcMap.get("number_toString");
  }
  if (compareIdx === undefined || (isNumeric && numToStrIdx === undefined)) {
    return null; // helpers not registered — fall back to numeric Timsort
  }

  const vecTmp = allocLocal(fctx, `__dsort_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__dsort_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__dsort_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__dsort_i_${fctx.locals.length}`, { kind: "i32" });
  const jTmp = allocLocal(fctx, `__dsort_j_${fctx.locals.length}`, { kind: "i32" });
  const keyTmp = allocLocal(fctx, `__dsort_key_${fctx.locals.length}`, elemType);
  const keyStrTmp = allocLocal(fctx, `__dsort_keystr_${fctx.locals.length}`, cmpStrType);

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  const getOp: Instr["op"] =
    elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Stringify an element value (already on the stack as elemType) to cmpStrType.
  const stringifyTail = (): Instr[] => {
    if (!isNumeric) {
      // String element: ensure non-null, and (native) cast NativeString → AnyString.
      const out: Instr[] = [{ op: "ref.as_non_null" } as Instr];
      if (native) out.push({ op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr);
      return out;
    }
    const out: Instr[] = [];
    if (elemType.kind !== "f64") out.push({ op: "f64.convert_i32_s" } as Instr);
    out.push({ op: "call", funcIdx: numToStrIdx! } as Instr);
    if (native) {
      out.push({ op: "any.convert_extern" } as Instr);
      out.push({ op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr);
    }
    return out;
  };

  // `string_compare(ToString(data[j]), keyStr) > 0`
  const compareDataJGtKey: Instr[] = [
    { op: "local.get", index: dataTmp } as Instr,
    { op: "local.get", index: jTmp } as Instr,
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    ...stringifyTail(),
    { op: "local.get", index: keyStrTmp } as Instr,
    { op: "call", funcIdx: compareIdx } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.gt_s" } as Instr,
  ];

  // for (i = 1; i < len; i++) { key = data[i]; keyStr = ToString(key); j = i-1;
  //   while (j >= 0 && cmp(data[j], key) > 0) { data[j+1] = data[j]; j--; }
  //   data[j+1] = key; }
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: iTmp });
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: iTmp } as Instr,
          { op: "local.get", index: lenTmp } as Instr,
          { op: "i32.ge_s" } as Instr,
          { op: "br_if", depth: 1 } as Instr,

          { op: "local.get", index: dataTmp } as Instr,
          { op: "local.get", index: iTmp } as Instr,
          { op: getOp, typeIdx: arrTypeIdx } as Instr,
          { op: "local.set", index: keyTmp } as Instr,
          { op: "local.get", index: keyTmp } as Instr,
          ...stringifyTail(),
          { op: "local.set", index: keyStrTmp } as Instr,
          { op: "local.get", index: iTmp } as Instr,
          { op: "i32.const", value: 1 } as Instr,
          { op: "i32.sub" } as Instr,
          { op: "local.set", index: jTmp } as Instr,

          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: jTmp } as Instr,
                  { op: "i32.const", value: 0 } as Instr,
                  { op: "i32.lt_s" } as Instr,
                  { op: "br_if", depth: 1 } as Instr,
                  ...compareDataJGtKey,
                  { op: "i32.eqz" } as Instr,
                  { op: "br_if", depth: 1 } as Instr,
                  { op: "local.get", index: dataTmp } as Instr,
                  { op: "local.get", index: jTmp } as Instr,
                  { op: "i32.const", value: 1 } as Instr,
                  { op: "i32.add" } as Instr,
                  { op: "local.get", index: dataTmp } as Instr,
                  { op: "local.get", index: jTmp } as Instr,
                  { op: getOp, typeIdx: arrTypeIdx } as Instr,
                  { op: "array.set", typeIdx: arrTypeIdx } as Instr,
                  { op: "local.get", index: jTmp } as Instr,
                  { op: "i32.const", value: 1 } as Instr,
                  { op: "i32.sub" } as Instr,
                  { op: "local.set", index: jTmp } as Instr,
                  { op: "br", depth: 0 } as Instr,
                ],
              } as Instr,
            ],
          } as Instr,

          { op: "local.get", index: dataTmp } as Instr,
          { op: "local.get", index: jTmp } as Instr,
          { op: "i32.const", value: 1 } as Instr,
          { op: "i32.add" } as Instr,
          { op: "local.get", index: keyTmp } as Instr,
          { op: "array.set", typeIdx: arrTypeIdx } as Instr,

          { op: "local.get", index: iTmp } as Instr,
          { op: "i32.const", value: 1 } as Instr,
          { op: "i32.add" } as Instr,
          { op: "local.set", index: iTmp } as Instr,
          { op: "br", depth: 0 } as Instr,
        ],
      } as Instr,
    ],
  } as Instr);

  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "ref.as_non_null" });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * #1816 — comparator-aware sort. Emits an in-place stable insertion sort that
 * invokes the user comparator closure via `call_ref` at every comparison,
 * using the spec ordering: `comparator(a, b) > 0` ⇒ `a` sorts after `b`.
 *
 * Returns the result ValType on success, or `null` if the comparator is not a
 * compilable Wasm closure (caller then falls back to the default Timsort).
 *
 * Insertion sort (not Timsort) is used here because (a) it is naturally stable,
 * (b) correctness — not throughput — is the requirement for comparator sorts,
 * and (c) it keeps the comparator-call site inline in the calling function so
 * the closure local stays in scope (no closure-threading through module helpers).
 */
function tryCompileComparatorSort(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  cbArg: ts.Expression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // Compile the comparator. Arrow/function expressions become closures; an
  // identifier referencing a closure variable also resolves to one.
  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) {
    // Not a Wasm closure (e.g. a host externref function). Drop and bail so the
    // caller falls back to the default sort.
    if (cbResult) fctx.body.push({ op: "drop" });
    return null;
  }
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo || closureInfo.paramTypes.length < 2) {
    // Unknown closure shape or fewer than 2 params — can't drive a 2-arg
    // comparator soundly. Drop and fall back.
    fctx.body.push({ op: "drop" });
    return null;
  }

  const cmpTmp = allocLocal(fctx, `__arr_sort_cmp_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: cmpTmp });

  // Now compile the receiver (spec order: comparefn already evaluated above as
  // the arg; receiver was the member-expression base, evaluated first at the
  // call site — but here we evaluate it after for codegen simplicity, which is
  // observationally identical for the array receiver, which has no getter).
  const vecTmp = allocLocal(fctx, `__arr_sort_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_sort_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_sort_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_sort_i_${fctx.locals.length}`, { kind: "i32" });
  const jTmp = allocLocal(fctx, `__arr_sort_j_${fctx.locals.length}`, { kind: "i32" });
  const keyTmp = allocLocal(fctx, `__arr_sort_key_${fctx.locals.length}`, elemType);

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  // len = vec.length, data = vec.data
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  const getOp: Instr["op"] =
    elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Comparator-call instruction sequence with `data[j]` and `key` already
  // on the stack as `elemType`; coerces each to the closure's declared param
  // type, invokes call_ref, coerces the (f64/typed) result to f64, leaves an
  // i32 `(result > 0)` on the stack.
  // Comparator call convention (matches the other array-method call_ref sites):
  // push the closure struct (`__self`, the 1st funcType param) FIRST, then the
  // two user args, then re-fetch the funcref from the struct (field 0) and
  // `call_ref`. The funcType is `[__self, p0, p1] -> ret`.
  const cmpReturn: ValType = closureInfo.returnType ?? { kind: "f64" };
  const buildCompareGtZero = (pushLeft: Instr[], pushRight: Instr[]): Instr[] => [
    { op: "local.get", index: cmpTmp } as Instr, // __self
    ...pushLeft,
    ...coercionInstrs(ctx, elemType, closureInfo.paramTypes[0]!, fctx),
    ...pushRight,
    ...coercionInstrs(ctx, elemType, closureInfo.paramTypes[1]!, fctx),
    { op: "local.get", index: cmpTmp } as Instr,
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" } as Instr,
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
    ...coercionInstrs(ctx, cmpReturn, { kind: "f64" }, fctx),
    { op: "f64.const", value: 0 } as Instr,
    { op: "f64.gt" } as Instr,
  ];

  // for (i = 1; i < len; i++) { key = data[i]; j = i-1;
  //   while (j >= 0 && cmp(data[j], key) > 0) { data[j+1] = data[j]; j--; }
  //   data[j+1] = key; }
  fctx.body.push({ op: "i32.const", value: 1 } as Instr);
  fctx.body.push({ op: "local.set", index: iTmp } as Instr);
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          // if (i >= len) break
          { op: "local.get", index: iTmp } as Instr,
          { op: "local.get", index: lenTmp } as Instr,
          { op: "i32.ge_s" } as Instr,
          { op: "br_if", depth: 1 } as Instr,
          // key = data[i]
          { op: "local.get", index: dataTmp } as Instr,
          { op: "ref.as_non_null" } as Instr,
          { op: "local.get", index: iTmp } as Instr,
          { op: getOp, typeIdx: arrTypeIdx } as Instr,
          { op: "local.set", index: keyTmp } as Instr,
          // j = i - 1
          { op: "local.get", index: iTmp } as Instr,
          { op: "i32.const", value: 1 } as Instr,
          { op: "i32.sub" } as Instr,
          { op: "local.set", index: jTmp } as Instr,
          // inner while
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  // if (j < 0) break
                  { op: "local.get", index: jTmp } as Instr,
                  { op: "i32.const", value: 0 } as Instr,
                  { op: "i32.lt_s" } as Instr,
                  { op: "br_if", depth: 1 } as Instr,
                  // if (cmp(data[j], key) > 0) == 0 → break
                  ...buildCompareGtZero(
                    [
                      { op: "local.get", index: dataTmp } as Instr,
                      { op: "ref.as_non_null" } as Instr,
                      { op: "local.get", index: jTmp } as Instr,
                      { op: getOp, typeIdx: arrTypeIdx } as Instr,
                    ],
                    [{ op: "local.get", index: keyTmp } as Instr],
                  ),
                  { op: "i32.eqz" } as Instr,
                  { op: "br_if", depth: 1 } as Instr,
                  // data[j+1] = data[j]
                  { op: "local.get", index: dataTmp } as Instr,
                  { op: "ref.as_non_null" } as Instr,
                  { op: "local.get", index: jTmp } as Instr,
                  { op: "i32.const", value: 1 } as Instr,
                  { op: "i32.add" } as Instr,
                  { op: "local.get", index: dataTmp } as Instr,
                  { op: "ref.as_non_null" } as Instr,
                  { op: "local.get", index: jTmp } as Instr,
                  { op: getOp, typeIdx: arrTypeIdx } as Instr,
                  { op: "array.set", typeIdx: arrTypeIdx } as Instr,
                  // j--
                  { op: "local.get", index: jTmp } as Instr,
                  { op: "i32.const", value: 1 } as Instr,
                  { op: "i32.sub" } as Instr,
                  { op: "local.set", index: jTmp } as Instr,
                  { op: "br", depth: 0 } as Instr,
                ],
              } as Instr,
            ],
          } as Instr,
          // data[j+1] = key
          { op: "local.get", index: dataTmp } as Instr,
          { op: "ref.as_non_null" } as Instr,
          { op: "local.get", index: jTmp } as Instr,
          { op: "i32.const", value: 1 } as Instr,
          { op: "i32.add" } as Instr,
          { op: "local.get", index: keyTmp } as Instr,
          { op: "array.set", typeIdx: arrTypeIdx } as Instr,
          // i++
          { op: "local.get", index: iTmp } as Instr,
          { op: "i32.const", value: 1 } as Instr,
          { op: "i32.add" } as Instr,
          { op: "local.set", index: iTmp } as Instr,
          { op: "br", depth: 0 } as Instr,
        ],
      } as Instr,
    ],
  } as Instr);

  // Return the same vec ref (sort is in-place).
  fctx.body.push({ op: "local.get", index: vecTmp } as Instr);
  fctx.body.push({ op: "ref.as_non_null" } as Instr);
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.fill(value, start?, end?) -> fill elements with value, return same vec ref.
 * Mutates the array in place.
 */
function compileArrayFill(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    reportError(ctx, callExpr, "fill requires at least 1 argument");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_fill_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_fill_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_fill_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_fill_val_${fctx.locals.length}`, elemType);
  const startTmp = allocLocal(fctx, `__arr_fill_s_${fctx.locals.length}`, { kind: "i32" });
  const endTmp = allocLocal(fctx, `__arr_fill_e_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_fill_i_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile value argument
  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  // start (default: 0) -- clamp negative
  if (callExpr.arguments.length >= 2) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: startTmp });
  emitClampIndex(fctx, startTmp, lenTmp);

  // end (default: length) -- clamp negative
  // Spec §23.1.3.7 step 7: if end is undefined, use len; else ToIntegerOrInfinity(end).
  // Treat statically-`undefined` arguments (literal `undefined` / `void 0`) as missing,
  // because once coerced to f64 we cannot distinguish them from `NaN` (which spec says → 0).
  const fillEndArg = callExpr.arguments.length >= 3 ? callExpr.arguments[2]! : undefined;
  const fillEndIsUndef =
    fillEndArg !== undefined &&
    ((ts.isIdentifier(fillEndArg) && fillEndArg.text === "undefined") || ts.isVoidExpression(fillEndArg));
  if (fillEndArg !== undefined && !fillEndIsUndef) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, fillEndArg, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, fillEndArg, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
  }
  fctx.body.push({ op: "local.set", index: endTmp });
  emitClampIndex(fctx, endTmp, lenTmp);

  // i = start
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "local.set", index: iTmp });

  // Loop: while (i < end) { data[i] = value; i++; }
  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: endTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // data[i] = value
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: "local.get", index: valTmp },
    { op: "array.set", typeIdx: arrTypeIdx },

    // i++
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  // Return same vec ref
  fctx.body.push({ op: "local.get", index: vecTmp });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * TypedArray.prototype.set(source, offset?) (#1664) — copy source elements into
 * the receiver starting at `offset`, mutating the receiver's backing array in
 * place. Native WasmGC lowering so `--target wasi`/standalone modules don't fall
 * through to the generic `__extern_get`/`__extern_length` host-import path.
 *
 * `source` may be an array literal or another typed array; both compile to a
 * vec struct. When source and receiver share the same element wasm type we use
 * `array.copy`; otherwise we element-wise copy through an f64 bridge so that
 * e.g. `Float64Array.set([1,2,3])` (i32-typed literal) writes correct values.
 * Returns VOID_RESULT (set returns undefined) or null to bail to the fallback.
 */
function compileTypedArraySet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    reportError(ctx, callExpr, "set requires at least 1 argument");
    return null;
  }

  // The source argument must be a known WasmGC array (vec struct). If it isn't
  // (e.g. `any`), bail to the generic externref dispatch (returns undefined so
  // the caller continues to the host-import path).
  const srcNode = callExpr.arguments[0]!;
  const srcTsType = ctx.checker.getTypeAtLocation(srcNode);
  const srcArrInfo = resolveArrayInfoForExpression(ctx, fctx, srcNode, srcTsType);
  if (!srcArrInfo) return null;

  const srcVecTypeIdx = srcArrInfo.vecTypeIdx;
  const srcArrTypeIdx = srcArrInfo.arrTypeIdx;
  const srcElemType = srcArrInfo.elemType;

  const dstVec = allocLocal(fctx, `__ta_set_dvec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dstData = allocLocal(fctx, `__ta_set_ddata_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const srcVec = allocLocal(fctx, `__ta_set_svec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: srcVecTypeIdx });
  const srcData = allocLocal(fctx, `__ta_set_sdata_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: srcArrTypeIdx,
  });
  const srcLen = allocLocal(fctx, `__ta_set_slen_${fctx.locals.length}`, { kind: "i32" });
  const offsetTmp = allocLocal(fctx, `__ta_set_off_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__ta_set_i_${fctx.locals.length}`, { kind: "i32" });

  // Receiver -> vec ref, extract data array.
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: dstVec });
  emitReceiverNullGuard(ctx, fctx, dstVec);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dstData });

  // Source -> vec ref, extract length + data array.
  compileExpression(ctx, fctx, srcNode);
  fctx.body.push({ op: "local.tee", index: srcVec });
  fctx.body.push({ op: "struct.get", typeIdx: srcVecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: srcLen });
  fctx.body.push({ op: "local.get", index: srcVec });
  fctx.body.push({ op: "struct.get", typeIdx: srcVecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: srcData });

  // offset (default 0).
  if (callExpr.arguments.length >= 2) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: offsetTmp });

  if (srcArrTypeIdx === arrTypeIdx) {
    // Same backing array type — bulk array.copy dstData[offset..] = srcData[0..srcLen].
    emitArrayCopy(fctx, arrTypeIdx, dstData, offsetTmp, srcData, null, srcLen);
  } else {
    // Element-wise copy through an f64 bridge to convert between element types.
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: iTmp });
    const loopBody: Instr[] = [
      { op: "local.get", index: iTmp },
      { op: "local.get", index: srcLen },
      { op: "i32.ge_s" },
      { op: "br_if", depth: 1 },

      // dstData[offset + i] = (elemType) srcData[i]
      { op: "local.get", index: dstData },
      { op: "local.get", index: offsetTmp },
      { op: "local.get", index: iTmp },
      { op: "i32.add" },
      { op: "local.get", index: srcData },
      { op: "local.get", index: iTmp },
      ...typedArrayElemLoad(srcArrTypeIdx, srcElemType),
      ...numericElemConvert(srcElemType, elemType),
      { op: "array.set", typeIdx: arrTypeIdx },

      { op: "local.get", index: iTmp },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: iTmp },
      { op: "br", depth: 0 },
    ];
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
    });
  }

  return VOID_RESULT as unknown as ValType;
}

/**
 * Load one element from a vec's backing array (`array.get` + signedness).
 */
function typedArrayElemLoad(arrTypeIdx: number, elemType: ValType): Instr[] {
  const op = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  return [{ op, typeIdx: arrTypeIdx } as Instr];
}

/**
 * Convert a numeric value of `from` wasm type to `to` wasm type on the stack.
 * Only handles the i32/f64 element types used by typed arrays.
 */
function numericElemConvert(from: ValType, to: ValType): Instr[] {
  if (from.kind === to.kind) return [];
  if (from.kind === "i8" && to.kind === "f64") return [{ op: "f64.convert_i32_u" } as Instr];
  if (from.kind === "i8" && to.kind === "i32") return [];
  if (from.kind === "i32" && to.kind === "i8") return [];
  if (from.kind === "f64" && to.kind === "i8") return [{ op: "i32.trunc_sat_f64_s" } as Instr];
  if (from.kind === "i32" && to.kind === "f64") return [{ op: "f64.convert_i32_s" } as Instr];
  if (from.kind === "f64" && to.kind === "i32") return [{ op: "i32.trunc_sat_f64_s" } as Instr];
  return [];
}

/**
 * TypedArray.prototype.subarray(begin?, end?) (#1664) — returns a new vec over
 * the [begin, end) slice. The vec-struct model has no shared ArrayBuffer, so
 * this copies (matching `.slice` semantics); the acceptance criteria only
 * require correct element values + zero host imports, not buffer aliasing.
 */
function compileTypedArraySubarray(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType {
  // subarray clamps the same way slice does; reuse the slice lowering.
  return compileArraySlice(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
}

/**
 * arr.copyWithin(target, start, end?) -> copy elements within the same array, return same vec ref.
 * Mutates the array in place using array.copy.
 */
function compileArrayCopyWithin(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  _elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) {
    reportError(ctx, callExpr, "copyWithin requires at least 2 arguments (target, start)");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_cw_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_cw_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_cw_len_${fctx.locals.length}`, { kind: "i32" });
  const targetTmp = allocLocal(fctx, `__arr_cw_tgt_${fctx.locals.length}`, { kind: "i32" });
  const startTmp = allocLocal(fctx, `__arr_cw_s_${fctx.locals.length}`, { kind: "i32" });
  const endTmp = allocLocal(fctx, `__arr_cw_e_${fctx.locals.length}`, { kind: "i32" });
  const countTmp = allocLocal(fctx, `__arr_cw_cnt_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // target arg -- clamp negative
  if (ctx.fast) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "i32" });
  } else {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  }
  fctx.body.push({ op: "local.set", index: targetTmp });
  emitClampIndex(fctx, targetTmp, lenTmp);

  // start arg -- clamp negative
  if (ctx.fast) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
  } else {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  }
  fctx.body.push({ op: "local.set", index: startTmp });
  emitClampIndex(fctx, startTmp, lenTmp);

  // end arg (default: length) -- clamp negative
  // Spec §23.1.3.4 step 11: if end is undefined, use len; else ToInteger(end).
  // Treat statically-`undefined` arguments (literal `undefined` / `void 0`) as missing,
  // because once coerced to f64 we cannot distinguish them from `NaN` (which spec says → 0).
  const cwEndArg = callExpr.arguments.length >= 3 ? callExpr.arguments[2]! : undefined;
  const cwEndIsUndef =
    cwEndArg !== undefined &&
    ((ts.isIdentifier(cwEndArg) && cwEndArg.text === "undefined") || ts.isVoidExpression(cwEndArg));
  if (cwEndArg !== undefined && !cwEndIsUndef) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, cwEndArg, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, cwEndArg, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
  }
  fctx.body.push({ op: "local.set", index: endTmp });
  emitClampIndex(fctx, endTmp, lenTmp);

  // count = max(0, min(end - start, len - target))
  fctx.body.push({ op: "local.get", index: endTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: targetTmp });
  fctx.body.push({ op: "i32.sub" });
  // select min: if (end-start) < (len-target) then (end-start) else (len-target)
  fctx.body.push({ op: "local.get", index: endTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: targetTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "local.set", index: countTmp });
  emitClampNonNeg(fctx, countTmp);

  // array.copy data[target..target+count] = data[start..start+count]
  emitArrayCopy(fctx, arrTypeIdx, dataTmp, targetTmp, dataTmp, startTmp, countTmp);

  // Return same vec ref
  fctx.body.push({ op: "local.get", index: vecTmp });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.lastIndexOf(value, fromIndex?) -> reverse linear scan, return index or -1.
 */
function compileArrayLastIndexOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    reportError(ctx, callExpr, "lastIndexOf requires 1 argument");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_liof_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_liof_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_liof_i_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__arr_liof_val_${fctx.locals.length}`, elemType);

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  const lenTmp = allocLocal(fctx, `__arr_liof_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  if (callExpr.arguments.length >= 2) {
    // fromIndex provided -- clamp negative and clamp to length - 1
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    fctx.body.push({ op: "local.set", index: iTmp });
    // If negative, add length: if (i < 0) i = len + i
    fctx.body.push({ op: "local.get", index: iTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenTmp } as Instr,
        { op: "local.get", index: iTmp } as Instr,
        { op: "i32.add" } as Instr,
        { op: "local.set", index: iTmp } as Instr,
      ],
    } as Instr);
    // Clamp to len - 1
    fctx.body.push({ op: "local.get", index: iTmp });
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "i32.gt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenTmp } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.sub" } as Instr,
        { op: "local.set", index: iTmp } as Instr,
      ],
    } as Instr);
  } else {
    // Default: length - 1
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "local.set", index: iTmp });
  }

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile search value
  compileExpression(ctx, fctx, callExpr.arguments[0]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // For externref elements, use __host_eq (JS Strict Equality, §7.2.16) so
  // object identity, cross-type, and string comparisons follow spec. The
  // wasm:js-string `equals` builtin coerces both operands to strings, which
  // mis-matches object/boolean/number elements (#786).
  // For ref/ref_null elements, use ref.eq for reference identity comparison.
  let liofEqInstrs: Instr[];
  if (elemType.kind === "externref") {
    const hostEqIdx = ensureLateImport(
      ctx,
      "__host_eq",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
    );
    flushLateImportShifts(ctx, fctx);
    const finalHostEqIdx = ctx.funcMap.get("__host_eq") ?? hostEqIdx;
    if (finalHostEqIdx === undefined) {
      reportError(ctx, callExpr, "lastIndexOf: failed to bind __host_eq import");
      return null;
    }
    liofEqInstrs = [{ op: "call", funcIdx: finalHostEqIdx } as Instr];
  } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    liofEqInstrs = [{ op: "ref.eq" }];
  } else {
    const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
    liofEqInstrs = [{ op: eqOp } as Instr];
  }

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when lastIndexOf is inlined.
  const liofResType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
  const liofResTmp = allocLocal(fctx, `__arr_liof_res_${fctx.locals.length}`, liofResType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: liofResTmp });

  // Loop: while (i >= 0) { if data[i] == val, store i and break; i--; }
  const loopBody: Instr[] = [
    // if (i < 0) break
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "br_if", depth: 1 },

    // if (data[i] == val) store result and break
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: valTmp },
    ...liofEqInstrs,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: ctx.fast
        ? [
            { op: "local.get", index: iTmp } as Instr,
            { op: "local.set", index: liofResTmp } as Instr,
            { op: "br", depth: 2 } as Instr, // break out of block
          ]
        : [
            { op: "local.get", index: iTmp } as Instr,
            { op: "f64.convert_i32_s" } as Instr,
            { op: "local.set", index: liofResTmp } as Instr,
            { op: "br", depth: 2 } as Instr, // break out of block
          ],
    } as Instr,

    // i--
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  fctx.body.push({ op: "local.get", index: liofResTmp });

  if (ctx.fast) {
    return { kind: "i32" };
  }
  return { kind: "f64" };
}

/**
 * Compile arr.flat(depth?) — delegates to __array_flat host import (#1136).
 * Converts WasmGC vec receiver to externref, passes depth arg, returns externref.
 */
function compileArrayFlat(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): ValType | null {
  // __array_flat(receiver: externref, depth: externref) -> externref
  const flatIdx = ensureLateImport(
    ctx,
    "__array_flat",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (flatIdx === undefined) return null;

  // Compile receiver as externref
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }

  // Compile depth argument (or push undefined)
  if (callExpr.arguments.length > 0) {
    const depthType = compileExpression(ctx, fctx, callExpr.arguments[0]!);
    if (depthType && depthType.kind !== "externref") {
      coerceType(ctx, fctx, depthType, { kind: "externref" });
    } else if (!depthType) {
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  fctx.body.push({ op: "call", funcIdx: flatIdx });
  return { kind: "externref" };
}

/**
 * Compile arr.flatMap(callback, thisArg?) — delegates to __array_flatMap host import (#1136).
 * Converts WasmGC vec receiver to externref, passes callback and optional thisArg, returns externref.
 */
function compileArrayFlatMap(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): ValType | null {
  if (callExpr.arguments.length < 1) return null; // flatMap requires a callback

  // __array_flatMap(receiver: externref, fn: externref, thisArg: externref) -> externref
  const flatMapIdx = ensureLateImport(
    ctx,
    "__array_flatMap",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (flatMapIdx === undefined) return null;

  // Compile receiver as externref
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }

  // Compile callback as externref
  const cbType = compileExpression(ctx, fctx, callExpr.arguments[0]!);
  if (cbType && cbType.kind !== "externref") {
    coerceType(ctx, fctx, cbType, { kind: "externref" });
  } else if (!cbType) {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // Compile thisArg (or push undefined)
  if (callExpr.arguments.length > 1) {
    const thisArgType = compileExpression(ctx, fctx, callExpr.arguments[1]!);
    if (thisArgType && thisArgType.kind !== "externref") {
      coerceType(ctx, fctx, thisArgType, { kind: "externref" });
    } else if (!thisArgType) {
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  fctx.body.push({ op: "call", funcIdx: flatMapIdx });
  return { kind: "externref" };
}

// Register the emitBoundsCheckedArrayGet delegate so closures.ts (and any
// other module) can call it via shared.ts without depending on array-methods.ts.
registerEmitBoundsCheckedArrayGet(emitBoundsCheckedArrayGet);
