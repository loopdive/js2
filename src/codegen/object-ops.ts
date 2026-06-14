// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Object operations: Object.defineProperty, Object.keys/values/entries,
 * hasOwnProperty / propertyIsEnumerable.
 *
 * Extracted from expressions.ts (#688 step 6).
 */
import { ts } from "../ts-api.js";
import { isVoidType } from "../checker/type-mapper.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import {
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  compileArrowAsCallback,
  compileArrowAsClosure,
} from "./closures.js";
import { reportError } from "./context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowString, emitThrowTypeError } from "./expressions/helpers.js";
import { resolveStructName } from "./expressions/misc.js";
import { addUnionImports, cacheStringLiterals, getOrRegisterTupleType, resolveWasmType } from "./index.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterRefCellType, getOrRegisterVecType } from "./registry/types.js";
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression, compileStatement, ensureLateImport, flushLateImportShifts } from "./shared.js";
import {
  S5C_STRUCT_ACCESSOR_CLOSURE,
  buildAccessorClosure,
  ensureStructAccessorGlobal,
} from "./struct-accessor-closure.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { compileNativeStringLiteral, compileStringLiteral } from "./string-ops.js";
import { getVecInfo } from "./type-coercion.js";

// ── Compile-time ToBoolean coercion of descriptor flag initializers ──
/**
 * Try to constant-fold `ToBoolean(<expr>)` at compile time. Returns:
 *   - `true`/`false` if the expression has a statically-known truthiness
 *   - `undefined` if the value cannot be determined at compile time (caller
 *     must evaluate at runtime or fall back to the dynamic path).
 *
 * Per ES spec §6.2.5.6 step 5.b, every descriptor attribute (writable,
 * enumerable, configurable) is run through `ToBoolean` before being stored.
 * Previously the codegen only accepted the `true`/`false` keyword literals
 * and silently dropped the entire attribute when any other expression
 * appeared (so `{ configurable: -12345 }` resulted in `configurable: false`
 * — a silent spec violation triggering 1,000+ test262 failures).
 */
export function tryConstantFoldToBoolean(init: ts.Expression): boolean | undefined {
  // Strip parentheses
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  // Strip non-null/as assertions (TS-only no-ops)
  while (ts.isNonNullExpression(init) || ts.isAsExpression(init) || ts.isTypeAssertionExpression(init)) {
    init = init.expression;
  }

  if (init.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (init.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (init.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(init) && init.text === "undefined") return false;
  if (ts.isIdentifier(init) && init.text === "NaN") return false;
  if (ts.isIdentifier(init) && init.text === "Infinity") return true;
  if (ts.isNumericLiteral(init)) {
    const n = Number(init.text);
    return !!n && !Number.isNaN(n);
  }
  if (ts.isBigIntLiteral(init)) {
    // Strip trailing "n"
    const txt = init.text.replace(/n$/, "");
    return BigInt(txt) !== 0n;
  }
  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
    return init.text.length > 0;
  }
  if (ts.isTemplateExpression(init)) {
    // Non-empty template (has head text or spans) is always truthy as a string
    return init.head.text.length > 0 || init.templateSpans.length > 0;
  }
  // Object/array literals → truthy
  if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) return true;
  // Function/arrow → truthy
  if (ts.isFunctionExpression(init) || ts.isArrowFunction(init) || ts.isClassExpression(init)) return true;
  // Unary minus / plus on numeric literal: !!(-12345) = true; !!(+0) = false
  if (ts.isPrefixUnaryExpression(init)) {
    const inner = tryConstantFoldToBoolean(init.operand);
    if (init.operator === ts.SyntaxKind.MinusToken || init.operator === ts.SyntaxKind.PlusToken) {
      // -N, +N preserve truthiness for numeric literal operands
      if (ts.isNumericLiteral(init.operand)) {
        const n = Number(init.operand.text);
        return !!n && !Number.isNaN(n);
      }
    }
    if (init.operator === ts.SyntaxKind.ExclamationToken) {
      return inner !== undefined ? !inner : undefined;
    }
    if (init.operator === ts.SyntaxKind.TildeToken && ts.isNumericLiteral(init.operand)) {
      const n = Number(init.operand.text);
      const v = ~(n | 0);
      return v !== 0;
    }
  }
  // `void <expr>` always yields undefined
  if (ts.isVoidExpression(init)) return false;
  // Cannot determine statically — caller must handle the dynamic case
  return undefined;
}

/**
 * Check whether a descriptor argument is statically a non-object primitive
 * value (number/string/boolean/null/undefined). When true, ES §6.2.5.5 step 1
 * requires the runtime to throw a TypeError "Property description must be an
 * object". We detect this at compile time and emit the throw directly.
 */
function isStaticallyNonObjectDescArg(descArg: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(descArg)) descArg = descArg.expression;
  if (
    ts.isNumericLiteral(descArg) ||
    ts.isStringLiteral(descArg) ||
    ts.isNoSubstitutionTemplateLiteral(descArg) ||
    descArg.kind === ts.SyntaxKind.TrueKeyword ||
    descArg.kind === ts.SyntaxKind.FalseKeyword ||
    descArg.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(descArg) && descArg.text === "undefined") return true;
  if (ts.isPrefixUnaryExpression(descArg) && ts.isNumericLiteral(descArg.operand)) return true;
  return false;
}

const DESCRIPTOR_FIELD_NAMES = new Set(["value", "writable", "enumerable", "configurable", "get", "set"]);

function unwrapTransparentExpression(expr: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isParenthesizedExpression(expr) ||
    ts.isSatisfiesExpression(expr)
  ) {
    expr = (
      expr as
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.NonNullExpression
        | ts.ParenthesizedExpression
        | ts.SatisfiesExpression
    ).expression;
  }
  return expr;
}

function isUndefinedLikeExpression(expr: ts.Expression): boolean {
  const inner = unwrapTransparentExpression(expr);
  return (
    inner.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(inner) && inner.text === "undefined") ||
    ts.isVoidExpression(inner)
  );
}

function descriptorFieldName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return DESCRIPTOR_FIELD_NAMES.has(name.text) ? name.text : undefined;
  }
  return undefined;
}

function descriptorUndefinedFields(descArg: ts.Expression): string[] {
  const desc = unwrapTransparentExpression(descArg);
  if (!ts.isObjectLiteralExpression(desc)) return [];
  const fields: string[] = [];
  for (const prop of desc.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const field = descriptorFieldName(prop.name);
    if (field !== undefined && isUndefinedLikeExpression(prop.initializer)) fields.push(field);
  }
  return fields;
}

function descriptorInitializerForIdentifier(
  ctx: CodegenContext,
  descArg: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
  const unwrapped = unwrapTransparentExpression(descArg);
  if (!ts.isIdentifier(unwrapped)) return undefined;
  const sym = ctx.checker.getSymbolAtLocation(unwrapped);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  const init = unwrapTransparentExpression(decl.initializer);
  return ts.isObjectLiteralExpression(init) ? init : undefined;
}

function markRuntimeDefinedProperty(ctx: CodegenContext, objArg: ts.Expression, propArg: ts.Expression): void {
  if (!ts.isIdentifier(objArg)) return;
  const propName = ts.isStringLiteral(propArg) ? propArg.text : ts.isNumericLiteral(propArg) ? propArg.text : undefined;
  if (propName === undefined) return;
  ctx.sidecarDefinedPropertyKeys.add(`${objArg.text}:${propName}`);
}

function emitDescriptorUndefinedSidecars(
  ctx: CodegenContext,
  fctx: FunctionContext,
  descLocal: number,
  fields: readonly string[],
): void {
  if (fields.length === 0) return;
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (setIdx === undefined) return;
  for (const field of fields) {
    fctx.body.push({ op: "local.get", index: descLocal });
    addStringConstantGlobal(ctx, field);
    for (const instr of stringConstantExternrefInstrs(ctx, field)) fctx.body.push(instr);
    emitUndefined(ctx, fctx);
    fctx.body.push({ op: "call", funcIdx: setIdx });
  }
}

function emitDefinePropertyDescRuntime(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objArg: ts.Expression,
  propArg: ts.Expression,
  descArg: ts.Expression,
  undefinedFields: readonly string[],
): ValType | null {
  markRuntimeDefinedProperty(ctx, objArg, propArg);

  const objType = compileExpression(ctx, fctx, objArg);
  if (!objType) return null;
  if (objType.kind === "ref" || objType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" } as Instr);
  } else if (objType.kind !== "externref") {
    coerceType(ctx, fctx, objType, { kind: "externref" });
  }

  const propType = compileExpression(ctx, fctx, propArg, { kind: "externref" });
  if (propType && propType.kind !== "externref") {
    coerceType(ctx, fctx, propType, { kind: "externref" });
  } else if (!propType) {
    fctx.body.push({ op: "ref.null.extern" });
  }

  const descType = compileExpression(ctx, fctx, descArg);
  if (descType) {
    if (descType.kind === "ref" || descType.kind === "ref_null") {
      fctx.body.push({ op: "extern.convert_any" } as Instr);
    } else if (descType.kind !== "externref") {
      coerceType(ctx, fctx, descType, { kind: "externref" });
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const descLocal = allocLocal(fctx, `__defprop_desc_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: descLocal });
  emitDescriptorUndefinedSidecars(ctx, fctx, descLocal, undefinedFields);
  fctx.body.push({ op: "local.get", index: descLocal });

  const dpDescIdx = ensureLateImport(
    ctx,
    "__defineProperty_desc",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (dpDescIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: dpDescIdx });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  return { kind: "externref" };
}

// ── #1130 PR-0: array-index-exotic length growth on defineProperty ───

/**
 * Parse a property key string as a canonical array index per the array
 * exotic-object rules (ES §10.4.2.1 / `CanonicalNumericIndexString` plus
 * `ToString(ToUint32(n)) === key`). Returns the index when the key is a
 * canonical array index in `[0, 2^32-2]`, else undefined. "length", "01",
 * "-1", "1.5", "4294967295" are NOT canonical array indices.
 */
function parseCanonicalArrayIndex(key: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
  const n = Number(key);
  // Array indices are < 2^32 - 1 (4294967295 is the max length, not an index).
  if (!Number.isInteger(n) || n < 0 || n >= 0xffffffff) return undefined;
  return n;
}

/**
 * A receiver expression is safe to re-compile for the length-growth side
 * effect only when evaluating it has no observable side effects. Identifiers
 * and `this` qualify; calls, indexing, and arbitrary member chains do not.
 */
function isSideEffectFreeReceiver(objArg: ts.Expression): boolean {
  return ts.isIdentifier(objArg) || objArg.kind === ts.SyntaxKind.ThisKeyword;
}

/**
 * #1130 PR-0: emit array-index-exotic `length` growth.
 *
 * `Object.defineProperty(arr, "n", desc)` on an array exotic object with
 * `n >= arr.length` sets `arr.length = n + 1` (ES §10.4.2.1 ArraySetLength
 * via `[[DefineOwnProperty]]`). Our WasmGC vec stores the logical length in
 * struct field 0; this emits a guarded bump on a freshly-compiled vec ref.
 *
 * Emits nothing (and returns) when `objArg` is not a side-effect-free vec
 * receiver or `propArg` is not a canonical array index. Leaves the operand
 * stack unchanged.
 */
function maybeEmitVecLengthGrowth(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objArg: ts.Expression,
  propArg: ts.Expression,
): void {
  if (!ts.isStringLiteral(propArg)) return;
  const idx = parseCanonicalArrayIndex(propArg.text);
  if (idx === undefined) return;
  if (!isSideEffectFreeReceiver(objArg)) return;

  const objTsType = ctx.checker.getTypeAtLocation(objArg);
  const wasmType = resolveWasmType(ctx, objTsType);
  if (wasmType.kind !== "ref" && wasmType.kind !== "ref_null") return;
  const vecTypeIdx = (wasmType as { typeIdx?: number }).typeIdx;
  if (vecTypeIdx === undefined) return;
  const vecInfo = getVecInfo(ctx, vecTypeIdx);
  if (vecInfo === null) return;
  const arrTypeIdx = vecInfo.arrTypeIdx;

  // Re-compile the receiver to a raw vec ref (safe: side-effect-free).
  const recvType = compileExpression(ctx, fctx, objArg);
  if (!recvType || (recvType.kind !== "ref" && recvType.kind !== "ref_null")) {
    // Unexpected: discard whatever landed on the stack to stay balanced.
    if (recvType) fctx.body.push({ op: "drop" });
    return;
  }
  const vecLocal = allocLocal(fctx, `__defprop_grow_${fctx.locals.length}`, recvType);
  fctx.body.push({ op: "local.set", index: vecLocal });

  // Only grow when idx >= vec.length. Inside the guard, grow the backing
  // `$data` array if its capacity is too small (so iteration/index reads
  // don't trap), then set vec.length = idx + 1. This mirrors the indexed
  // assignment grow path in expressions/assignment.ts so the vec stays
  // internally consistent (logical length never exceeds backing capacity).
  const dataLocal = allocLocal(fctx, `__defprop_grow_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  const oldCapLocal = allocLocal(fctx, `__defprop_grow_ocap_${fctx.locals.length}`, { kind: "i32" });
  const newDataLocal = allocLocal(fctx, `__defprop_grow_ndata_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });

  fctx.body.push({ op: "i32.const", value: idx });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "i32.ge_s" }); // idx >= vec.length?
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // data = vec.data
      { op: "local.get", index: vecLocal } as Instr,
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
      { op: "local.set", index: dataLocal } as Instr,

      // if (idx >= array.len(data)) grow backing array to idx + 1
      { op: "local.get", index: dataLocal } as Instr,
      { op: "array.len" } as Instr,
      { op: "local.tee", index: oldCapLocal } as Instr,
      { op: "i32.const", value: idx } as Instr,
      { op: "i32.le_s" } as Instr, // oldCap <= idx?
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // newData = array.new_default(idx + 1)
          { op: "i32.const", value: idx + 1 } as Instr,
          { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
          { op: "local.set", index: newDataLocal } as Instr,
          // array.copy newData[0..oldCap] = data[0..oldCap]
          { op: "local.get", index: newDataLocal } as Instr,
          { op: "i32.const", value: 0 } as Instr,
          { op: "local.get", index: dataLocal } as Instr,
          { op: "i32.const", value: 0 } as Instr,
          { op: "local.get", index: oldCapLocal } as Instr,
          { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,
          // vec.data = newData
          { op: "local.get", index: vecLocal } as Instr,
          { op: "local.get", index: newDataLocal } as Instr,
          { op: "ref.as_non_null" } as Instr,
          { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
        ],
      } as Instr,

      // vec.length = idx + 1
      { op: "local.get", index: vecLocal } as Instr,
      { op: "i32.const", value: idx + 1 } as Instr,
      { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
    ],
  });
}

// ── Compile-time primitive type check for Object methods ─────────────

/**
 * Check if the first argument to Object.defineProperty / defineProperties
 * is statically known to be a non-object type (undefined, null, boolean,
 * number, string).  If so, emit `throw TypeError` and return true.
 *
 * Per ES spec (19.1.2.4 step 1): "If Type(O) is not Object, throw a TypeError."
 */
function emitNonObjectArgGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argExpr: ts.Expression,
  methodName: string,
): boolean {
  const tsType = ctx.checker.getTypeAtLocation(argExpr);
  const flags = tsType.flags;

  // Check for primitive types that are definitely not objects
  const NON_OBJECT_FLAGS =
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Null |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.StringLike |
    ts.TypeFlags.BigIntLike;

  if (flags & NON_OBJECT_FLAGS) {
    // Compile the argument for side effects (it might have side effects)
    const argType = compileExpression(ctx, fctx, argExpr);
    if (argType) fctx.body.push({ op: "drop" });
    emitThrowString(ctx, fctx, `TypeError: ${methodName} called on non-object`);
    return true;
  }

  // Also check for literal expressions that are obviously non-object
  if (
    argExpr.kind === ts.SyntaxKind.UndefinedKeyword ||
    argExpr.kind === ts.SyntaxKind.NullKeyword ||
    argExpr.kind === ts.SyntaxKind.TrueKeyword ||
    argExpr.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isNumericLiteral(argExpr) ||
    (ts.isIdentifier(argExpr) && argExpr.text === "undefined")
  ) {
    emitThrowString(ctx, fctx, `TypeError: ${methodName} called on non-object`);
    return true;
  }

  return false;
}

// ── Null guard for object method arguments ────────────────────────────

/**
 * Emit a null check on the ref stored in `localIdx`.
 * If null, throws TypeError via the exception tag.
 */
function emitObjectArgNullGuard(ctx: CodegenContext, fctx: FunctionContext, localIdx: number): void {
  const message = "TypeError: Object method called on null or undefined";
  addStringConstantGlobal(ctx, message);
  const tagIdx = ensureExnTag(ctx);
  // Materialize the message via stringConstantExternrefInstrs so it works in
  // both backends: a host `string_constants` global, OR — under nativeStrings
  // (auto-on for --target standalone/wasi) — an inline-built `$NativeString`.
  // The previous `global.get` of `stringGlobalMap.get(message)` emitted index
  // -1 (the nativeStrings sentinel) → "Invalid global index: 4294967295" at
  // instantiate. This surfaced once #1629 S6 let Object.defineProperty reach
  // this guard under standalone instead of refusing at compile time.
  fctx.body.push({ op: "local.get", index: localIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [...stringConstantExternrefInstrs(ctx, message), { op: "throw", tagIdx } as Instr],
    else: [],
  });
}

// ── Object.defineProperty flag helpers ────────────────────────────────

/**
 * Property descriptor flag encoding for the __pf_ side-table:
 *   bit 0: writable
 *   bit 1: enumerable
 *   bit 2: configurable
 *   bit 3: "defined" marker (always 1 when a descriptor has been stored)
 *   bit 4: is accessor property (get/set vs data)
 */
export const PROP_FLAG_WRITABLE = 1 << 0; // 1
export const PROP_FLAG_ENUMERABLE = 1 << 1; // 2
export const PROP_FLAG_CONFIGURABLE = 1 << 2; // 4
export const PROP_FLAG_DEFINED = 1 << 3; // 8
export const PROP_FLAG_ACCESSOR = 1 << 4; // 16
const PROP_FLAGS_DEFAULT_DATA = PROP_FLAG_WRITABLE | PROP_FLAG_ENUMERABLE | PROP_FLAG_CONFIGURABLE | PROP_FLAG_DEFINED;

/**
 * Compute a compile-time flags integer from parsed descriptor booleans.
 * Unspecified flags default to false per the ES spec for Object.defineProperty.
 */
export function computeDescriptorFlags(
  writable: boolean | undefined,
  enumerable: boolean | undefined,
  configurable: boolean | undefined,
  isAccessor: boolean,
): number {
  let flags = PROP_FLAG_DEFINED; // always mark as defined
  if (writable) flags |= PROP_FLAG_WRITABLE;
  if (enumerable) flags |= PROP_FLAG_ENUMERABLE;
  if (configurable) flags |= PROP_FLAG_CONFIGURABLE;
  if (isAccessor) flags |= PROP_FLAG_ACCESSOR;
  return flags;
}

function applyDescriptorFlags(
  currentFlags: number | undefined,
  writable: boolean | undefined,
  enumerable: boolean | undefined,
  configurable: boolean | undefined,
  isAccessor: boolean,
  hasData: boolean,
): number {
  let flags = currentFlags ?? PROP_FLAG_DEFINED;
  flags |= PROP_FLAG_DEFINED;

  if (writable !== undefined) flags = writable ? flags | PROP_FLAG_WRITABLE : flags & ~PROP_FLAG_WRITABLE;
  if (enumerable !== undefined) flags = enumerable ? flags | PROP_FLAG_ENUMERABLE : flags & ~PROP_FLAG_ENUMERABLE;
  if (configurable !== undefined) {
    flags = configurable ? flags | PROP_FLAG_CONFIGURABLE : flags & ~PROP_FLAG_CONFIGURABLE;
  }

  if (isAccessor) {
    flags |= PROP_FLAG_ACCESSOR;
  } else if (hasData) {
    flags &= ~PROP_FLAG_ACCESSOR;
  }

  return flags;
}

/**
 * Emit code to check existing property flags and throw TypeError if the
 * Object.defineProperty operation violates the spec. Also stores the new flags.
 *
 * Uses __extern_get/set with "__pf_<propName>" keys to store flags as boxed numbers.
 * Uses "__ne" key to check non-extensibility.
 *
 * @param objLocal - local index holding the externref object
 * @param propName - compile-time property name
 * @param newFlags - the flags integer for the new descriptor
 * @param hasValue - whether the new descriptor specifies a value
 */
export function emitDefinePropertyFlagCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objLocal: number,
  propName: string,
  newFlags: number,
  hasValue: boolean,
): void {
  const flagKey = `__pf_${propName}`;
  const neKey = "__ne";

  // Ensure __extern_get, __extern_set, __unbox_number, __box_number are available
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);

  if (!getIdx || !setIdx || !unboxIdx || !boxIdx) return;

  // Register the flag key and non-extensible key as string constants
  addStringConstantGlobal(ctx, flagKey);
  addStringConstantGlobal(ctx, neKey);
  const flagKeyGlobal = ctx.stringGlobalMap.get(flagKey)!;
  const neKeyGlobal = ctx.stringGlobalMap.get(neKey)!;

  // Helper to build a TypeError throw instruction sequence
  const typeErrorMessage = "TypeError: Cannot redefine property";
  addStringConstantGlobal(ctx, typeErrorMessage);
  const errMsgGlobal = ctx.stringGlobalMap.get(typeErrorMessage)!;
  const tagIdx = ensureExnTag(ctx);
  const throwInstrs: Instr[] = [{ op: "global.get", index: errMsgGlobal } as Instr, { op: "throw", tagIdx } as Instr];

  const neErrMessage = "TypeError: Cannot define property, object is not extensible";
  addStringConstantGlobal(ctx, neErrMessage);
  const neErrMsgGlobal = ctx.stringGlobalMap.get(neErrMessage)!;
  const neThrowInstrs: Instr[] = [
    { op: "global.get", index: neErrMsgGlobal } as Instr,
    { op: "throw", tagIdx } as Instr,
  ];

  // Allocate locals for existing flags
  const existingFlagsLocal = allocLocal(fctx, `__pf_existing_${fctx.locals.length}`, { kind: "f64" });
  const existingI32Local = allocLocal(fctx, `__pf_ei32_${fctx.locals.length}`, { kind: "i32" });

  // Read existing flags: __extern_get(obj, "__pf_<propName>") -> externref, unbox to f64
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "global.get", index: flagKeyGlobal } as Instr);
  fctx.body.push({ op: "call", funcIdx: getIdx });
  fctx.body.push({ op: "call", funcIdx: unboxIdx }); // externref -> f64 (NaN if undefined)
  fctx.body.push({ op: "local.set", index: existingFlagsLocal });

  // Convert existing flags to i32 (NaN -> 0 via i32.trunc_sat_f64_s)
  fctx.body.push({ op: "local.get", index: existingFlagsLocal });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: existingI32Local });

  // Build non-configurable violation checks (only emitted when property is defined AND non-configurable)
  const isAccessor = !!(newFlags & PROP_FLAG_ACCESSOR);
  const nonConfigChecks: Instr[] = [];

  // Check: new descriptor sets configurable to true -> always TypeError
  if (newFlags & PROP_FLAG_CONFIGURABLE) {
    nonConfigChecks.push(...throwInstrs);
  }

  // Check: new descriptor changes enumerable (runtime check against existing)
  const newEnumerable = newFlags & PROP_FLAG_ENUMERABLE;
  nonConfigChecks.push(
    { op: "local.get", index: existingI32Local } as Instr,
    { op: "i32.const", value: PROP_FLAG_ENUMERABLE } as Instr,
    { op: "i32.and" } as Instr,
    { op: "i32.const", value: newEnumerable } as Instr,
    { op: "i32.ne" } as Instr,
    { op: "if", blockType: { kind: "empty" }, then: [...throwInstrs] },
  );

  // Check for data property restrictions
  if (!isAccessor) {
    const nonWritableChecks: Instr[] = [];
    if (newFlags & PROP_FLAG_WRITABLE || hasValue) {
      nonWritableChecks.push(...throwInstrs);
    }
    if (nonWritableChecks.length > 0) {
      // if (existing is data property)
      //   if (existing is non-writable)
      //     throw TypeError
      const isDataAndNonWritable: Instr[] = [
        { op: "local.get", index: existingI32Local } as Instr,
        { op: "i32.const", value: PROP_FLAG_WRITABLE } as Instr,
        { op: "i32.and" } as Instr,
        { op: "i32.eqz" } as Instr,
        { op: "if", blockType: { kind: "empty" }, then: nonWritableChecks },
      ];
      nonConfigChecks.push(
        { op: "local.get", index: existingI32Local } as Instr,
        { op: "i32.const", value: PROP_FLAG_ACCESSOR } as Instr,
        { op: "i32.and" } as Instr,
        { op: "i32.eqz" } as Instr,
        { op: "if", blockType: { kind: "empty" }, then: isDataAndNonWritable },
      );
    }
  }

  // Check: cannot change from data to accessor or vice versa on non-configurable
  if (isAccessor) {
    nonConfigChecks.push(
      { op: "local.get", index: existingI32Local } as Instr,
      { op: "i32.const", value: PROP_FLAG_ACCESSOR } as Instr,
      { op: "i32.and" } as Instr,
      { op: "i32.eqz" } as Instr,
      { op: "if", blockType: { kind: "empty" }, then: [...throwInstrs] },
    );
  } else if (hasValue || newFlags & PROP_FLAG_WRITABLE) {
    nonConfigChecks.push(
      { op: "local.get", index: existingI32Local } as Instr,
      { op: "i32.const", value: PROP_FLAG_ACCESSOR } as Instr,
      { op: "i32.and" } as Instr,
      { op: "if", blockType: { kind: "empty" }, then: [...throwInstrs] },
    );
  }

  // Build the outer block structure:
  // block $defprop_check
  //   br_if (not defined) → end of block
  //   br_if (configurable) → end of block
  //   <nonConfigChecks>
  // end
  const blockBody: Instr[] = [
    // Check if property is defined
    { op: "local.get", index: existingI32Local } as Instr,
    { op: "i32.const", value: PROP_FLAG_DEFINED } as Instr,
    { op: "i32.and" } as Instr,
    { op: "i32.eqz" } as Instr,
    { op: "br_if", depth: 0 } as Instr,
    // Check if configurable
    { op: "local.get", index: existingI32Local } as Instr,
    { op: "i32.const", value: PROP_FLAG_CONFIGURABLE } as Instr,
    { op: "i32.and" } as Instr,
    { op: "br_if", depth: 0 } as Instr,
    // Property is non-configurable — apply restrictions
    ...nonConfigChecks,
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: blockBody,
  });

  // Check: If property was NOT defined yet, check non-extensibility
  const neCheckBody: Instr[] = [
    { op: "local.get", index: objLocal } as Instr,
    { op: "global.get", index: neKeyGlobal } as Instr,
    { op: "call", funcIdx: getIdx } as Instr,
    { op: "call", funcIdx: unboxIdx } as Instr,
    { op: "i32.trunc_sat_f64_s" },
    { op: "if", blockType: { kind: "empty" }, then: [...neThrowInstrs] },
  ];

  fctx.body.push(
    { op: "local.get", index: existingI32Local },
    { op: "i32.const", value: PROP_FLAG_DEFINED },
    { op: "i32.and" },
    { op: "i32.eqz" },
  );
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: neCheckBody,
  });

  // Store the new flags: __extern_set(obj, "__pf_<propName>", box(newFlags))
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "global.get", index: flagKeyGlobal } as Instr);
  fctx.body.push({ op: "f64.const", value: newFlags });
  fctx.body.push({ op: "call", funcIdx: boxIdx });
  fctx.body.push({ op: "call", funcIdx: setIdx });
}

// ── Object.defineProperty ─────────────────────────────────────────────

/**
 * Compile Object.defineProperty(obj, prop, descriptor).
 *
 * If the descriptor is an object literal with a `value` property, we extract
 * the value and emit __extern_set(obj, prop, value).
 * If the descriptor has `get` and/or `set` properties, we compile them as
 * struct accessor methods (getter/setter functions).
 * Otherwise we compile all arguments for side effects and return the object unchanged.
 *
 * Returns obj (externref).
 */
export function compileObjectDefineProperty(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const objArg = expr.arguments[0]!;
  const propArg = expr.arguments[1]!;
  // Strip TS-only `as`/`!`/type-assertion wrappers so descriptor shape inspection
  // (object-literal detection, primitive-literal R5 check, etc.) sees the real node.
  let descArg = expr.arguments[2]!;
  while (
    ts.isAsExpression(descArg) ||
    ts.isNonNullExpression(descArg) ||
    ts.isTypeAssertionExpression(descArg) ||
    ts.isParenthesizedExpression(descArg)
  ) {
    descArg = (descArg as ts.AsExpression).expression;
  }

  // ES spec 19.1.2.4 step 1: throw TypeError if first arg is not an object
  if (emitNonObjectArgGuard(ctx, fctx, objArg, "Object.defineProperty")) {
    // After the throw, emit unreachable and return externref to satisfy callers
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }

  // (#1460 R5) ES spec §6.2.5.5 step 1: throw TypeError if descriptor is not an object.
  // Static check: numeric/string/boolean/null/undefined literal descriptors are spec
  // violations. The runtime helpers already check this for opaque cases, but the
  // compiler-time check produces a clean throw that the test262 suite expects.
  if (isStaticallyNonObjectDescArg(descArg)) {
    // Compile obj/prop for side effects then throw.
    const t1 = compileExpression(ctx, fctx, objArg);
    if (t1) fctx.body.push({ op: "drop" });
    const t2 = compileExpression(ctx, fctx, propArg);
    if (t2) fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, "TypeError: Property description must be an object");
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }

  // (#1130 PR-0) Array exotic objects grow `length` when a numeric-index
  // property at or beyond the current length is defined. Emit the guarded
  // bump before the descriptor is applied; no-op for non-array receivers.
  maybeEmitVecLengthGrowth(ctx, fctx, objArg, propArg);

  // Check if descriptor is an object literal with a `value`, `get`, or `set` property
  let valueExpr: ts.Expression | undefined;
  let getNode: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
  let setNode: ts.MethodDeclaration | ts.SetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
  // For `get: identifierRef` / `set: identifierRef` — not inline function nodes but expression refs
  let getExpr: ts.Expression | undefined;
  let setExpr: ts.Expression | undefined;
  if (ts.isObjectLiteralExpression(descArg)) {
    for (const prop of descArg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") {
        valueExpr = prop.initializer;
      }
      // get: function() { ... } or get: () => ...
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "get" &&
        (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer))
      ) {
        getNode = prop.initializer;
      }
      // get() { ... } (method shorthand)
      if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name) && prop.name.text === "get") {
        getNode = prop;
      }
      // set: function(v) { ... } or set: (v) => ...
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "set" &&
        (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer))
      ) {
        setNode = prop.initializer;
      }
      // set(v) { ... } (method shorthand)
      if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name) && prop.name.text === "set") {
        setNode = prop;
      }
      // get: someIdentifier (function reference, not inline)
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "get" &&
        !ts.isFunctionExpression(prop.initializer) &&
        !ts.isArrowFunction(prop.initializer)
      ) {
        const init = prop.initializer;
        // Only treat as accessor if it's not `undefined` or `null`
        if (
          !(ts.isIdentifier(init) && (init.text === "undefined" || init.text === "null")) &&
          !(init.kind === ts.SyntaxKind.NullKeyword)
        ) {
          getExpr = init;
        }
      }
      // set: someIdentifier (function reference, not inline)
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "set" &&
        !ts.isFunctionExpression(prop.initializer) &&
        !ts.isArrowFunction(prop.initializer)
      ) {
        const init = prop.initializer;
        if (
          !(ts.isIdentifier(init) && (init.text === "undefined" || init.text === "null")) &&
          !(init.kind === ts.SyntaxKind.NullKeyword)
        ) {
          setExpr = init;
        }
      }
    }
  }

  // ── Parse descriptor flags (configurable, writable, enumerable) ──────
  // Defaults per spec: all false when using Object.defineProperty.
  // (#1460 R1) Apply ToBoolean per ES §6.2.5.6 step 5.b — `tryConstantFoldToBoolean`
  // handles all statically-known shapes (`0`, `-12345`, `null`, `"foo"`, `{}`, etc.).
  // Track whether the property key was present in the descriptor (`*Specified`)
  // separately from its boolean value — an unspecified attribute is functionally
  // identical to `false` for `Object.defineProperty` per ES §6.2.5.6 step 7, but
  // we must NOT downgrade an attribute that was supplied dynamically to "absent".
  let descWritable: boolean | undefined;
  let descEnumerable: boolean | undefined;
  let descConfigurable: boolean | undefined;
  let writableDynamic = false;
  let enumerableDynamic = false;
  let configurableDynamic = false;
  if (ts.isObjectLiteralExpression(descArg)) {
    for (const prop of descArg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        const name = prop.name.text;
        if (name === "writable" || name === "enumerable" || name === "configurable") {
          const folded = tryConstantFoldToBoolean(prop.initializer);
          if (name === "writable") {
            descWritable = folded;
            if (folded === undefined) writableDynamic = true;
          } else if (name === "enumerable") {
            descEnumerable = folded;
            if (folded === undefined) enumerableDynamic = true;
          } else if (name === "configurable") {
            descConfigurable = folded;
            if (folded === undefined) configurableDynamic = true;
          }
        }
      }
    }
  }
  const _anyFlagDynamic = writableDynamic || enumerableDynamic || configurableDynamic;

  // (#1460 R4) ES spec §6.2.5.6 step 4 — if the descriptor mixes data attributes
  // (value / writable) with accessor attributes (get / set), throw TypeError.
  // Detect statically so the diagnostic doesn't depend on runtime descriptor
  // shape resolution.
  {
    const hasData = valueExpr !== undefined || descWritable !== undefined || writableDynamic;
    const hasAccessor =
      getNode !== undefined || setNode !== undefined || getExpr !== undefined || setExpr !== undefined;
    if (hasData && hasAccessor) {
      // Compile obj/prop for side effects then throw.
      const t1 = compileExpression(ctx, fctx, objArg);
      if (t1) fctx.body.push({ op: "drop" });
      const t2 = compileExpression(ctx, fctx, propArg);
      if (t2) fctx.body.push({ op: "drop" });
      emitThrowTypeError(
        ctx,
        fctx,
        "TypeError: Invalid property descriptor. Cannot both specify accessors and a value or writable attribute",
      );
      fctx.body.push({ op: "unreachable" });
      return { kind: "externref" };
    }
  }

  // Resolve the property name at compile time (string literal)
  let propName: string | undefined;
  if (ts.isStringLiteral(propArg)) {
    propName = propArg.text;
  }

  // (#1511) Mapped-arguments link-break. Per ECMA-262 §10.4.4.2
  // (ArgumentsExoticObject.[[DefineOwnProperty]]), defining a mapped index
  // with an accessor descriptor, or a data descriptor whose `writable` is
  // explicitly false, removes the param↔arguments mapping for that index:
  // subsequent parameter writes must stop reflecting into `arguments[i]` and
  // vice-versa. Setting only `configurable:false` (or `enumerable`) leaves the
  // map intact. We detect the statically-resolvable shape — `arguments` as the
  // receiver identifier (in a mapped-args function) with a literal index — and
  // sever the link in `mappedArgsInfo.unmappedIndices`; the mapped-sync
  // emitters read this set live, so codegen order makes the break apply only
  // to syncs emitted after this defineProperty call.
  if (
    fctx.mappedArgsInfo &&
    ts.isIdentifier(objArg) &&
    objArg.text === "arguments" &&
    ts.isObjectLiteralExpression(descArg)
  ) {
    const idxKey = propName ?? (ts.isNumericLiteral(propArg) ? propArg.text : undefined);
    const argIndex = idxKey !== undefined ? Number(idxKey) : NaN;
    if (Number.isInteger(argIndex) && argIndex >= 0 && argIndex < fctx.mappedArgsInfo.paramCount) {
      const isAccessor =
        getNode !== undefined || setNode !== undefined || getExpr !== undefined || setExpr !== undefined;
      const breaksLink = isAccessor || descWritable === false;
      if (breaksLink) {
        (fctx.mappedArgsInfo.unmappedIndices ??= new Set<number>()).add(argIndex);
      }
    }
  }

  // (#1629a) Dynamic-descriptor path: when the descriptor argument is not an
  // ObjectLiteralExpression (e.g. `var d = {value: 1}; defineProperty(o, k, d)`),
  // the inline-literal code below has nothing to extract — valueExpr / getNode /
  // descWritable are all undefined. The legacy fall-through to
  // emitExternDefinePropertyNoValue silently emits empty flags AND for typed
  // struct receivers skips the runtime call entirely, so the descriptor's
  // value / accessor / flag bits are dropped on the floor.
  //
  // Route to the runtime's __defineProperty_desc helper, which materializes
  // the descriptor via struct-aware getField (sidecar + __sget_<f> exports)
  // and applies it via native Object.defineProperty. The obj is coerced to
  // externref so the runtime sees a uniform entry point — this matches the
  // sibling Object.create path at calls.ts:3996+ (#1631).
  if (!ts.isObjectLiteralExpression(descArg)) {
    const init = descriptorInitializerForIdentifier(ctx, descArg);
    return emitDefinePropertyDescRuntime(
      ctx,
      fctx,
      objArg,
      propArg,
      descArg,
      init ? descriptorUndefinedFields(init) : [],
    );
  }

  // (#1629) Explicit-`undefined` descriptor fields (e.g. `{ value: undefined }`,
  // `{ get: undefined }`) need the runtime __defineProperty_desc path so the
  // field is recorded as PRESENT (not omitted) per ToPropertyDescriptor. That
  // path emits the `__defineProperty_desc` / `__extern_set` JS-host imports,
  // which are refused in `--target standalone` (#1472 Phase B) and would turn
  // every such inline literal into a compile_error. The standalone fast path
  // (struct.set + flag table) already compiles these correctly — origin/main
  // passed all of test/built-ins/Object/define*({value:undefined}) in
  // standalone via that path — so only take the host-runtime branch when a JS
  // host is available. JS-host mode keeps the precise presence-bit behavior.
  if (!ctx.standalone) {
    const explicitUndefinedFields = descriptorUndefinedFields(descArg);
    if (explicitUndefinedFields.length > 0) {
      return emitDefinePropertyDescRuntime(ctx, fctx, objArg, propArg, descArg, explicitUndefinedFields);
    }
  }

  // Check if obj is a struct type with the given field
  const objTsType = ctx.checker.getTypeAtLocation(objArg);
  let structName =
    resolveStructName(ctx, objTsType) ||
    (ts.isIdentifier(objArg) ? ctx.widenedVarStructMap.get(objArg.text) : undefined);

  // (#1629 S3) Whether the receiver is *statically* struct-typed — i.e. resolved
  // WITHOUT the `any`/externref rescue fallbacks 1-3 below. This is the same
  // strength of resolution the *read* site (`resolveStructNameForExpr` in
  // property-access.ts) has, so when it is set the compiled accessor fast path
  // (`${structName}_get_<prop>` + `classAccessorSet`) is reachable from reads and
  // must be kept. When it is unset (the `const o:any = {...}` case, resolved only
  // via the define-site-only fallbacks), reads route through `__extern_get` /
  // `_safeGet`, which the synthesized compiled getter can NOT serve — those must
  // instead mirror the accessor into the runtime sidecar (the working
  // `emitExternDefinePropertyNoValue` → `__defineProperty_accessor` path). Splitting
  // on this bit fixes the `const o:any` accessor-get bug without regressing the
  // statically struct-typed (class-instance) accessor path.
  const receiverIsStaticStruct = structName !== undefined;

  // Fallback 1: resolve struct name from the local variable's Wasm type.
  // This handles cases where the TS type is `any` but the local holds a struct ref.
  if (!structName && ts.isIdentifier(objArg)) {
    const localIdx = fctx.localMap.get(objArg.text);
    if (localIdx !== undefined) {
      const localType =
        localIdx < fctx.params.length ? fctx.params[localIdx]!.type : fctx.locals[localIdx - fctx.params.length]?.type;
      if (localType && (localType.kind === "ref" || localType.kind === "ref_null")) {
        structName = ctx.typeIdxToStructName.get(localType.typeIdx);
      }
    }
  }

  // Fallback 2: resolve struct name from the variable's declaration initializer.
  // For `const obj: any = { x: 0 }`, the TS type is `any` and the local is
  // externref, but the initializer is an object literal whose fields match a struct.
  if (!structName && ts.isIdentifier(objArg)) {
    const sym = ctx.checker.getSymbolAtLocation(objArg);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const initType = ctx.checker.getTypeAtLocation(decl.initializer);
      structName = resolveStructName(ctx, initType);
      // If resolveStructName failed (ts.Type identity mismatch), try to match
      // by struct field names against the object literal properties.
      if (!structName && ts.isObjectLiteralExpression(decl.initializer)) {
        const litProps = decl.initializer.properties
          .filter((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name))
          .map((p) => (p.name as ts.Identifier).text)
          .sort();
        if (litProps.length > 0) {
          for (const [sName, sFields] of ctx.structFields) {
            const fieldNames = sFields.map((f) => f.name).sort();
            if (fieldNames.length === litProps.length && fieldNames.every((n, i) => n === litProps[i])) {
              structName = sName;
              break;
            }
          }
        }
      }
    }
  }

  const structTypeIdx = structName ? ctx.structMap.get(structName) : undefined;
  const fields = structName ? ctx.structFields.get(structName) : undefined;
  const fieldIdx = fields && propName ? fields.findIndex((f) => f.name === propName) : -1;
  // (#1460 R1) When any flag has a *dynamic* (non-foldable) initializer, the
  // struct fast path can't encode it — fall back to externref. For statically-
  // folded flags we keep struct.set (preserves the value-storage side-effect)
  // and emit an additional side-effect `__defineProperty_value` call further
  // below so attribute flags are propagated to the runtime sidecar
  // (`_wasmPropDescs`) for later `Object.getOwnPropertyDescriptor` reads.
  const useStruct = !_anyFlagDynamic && structTypeIdx !== undefined && fields && fieldIdx >= 0 && valueExpr;
  const anyFlagSpecified =
    _anyFlagDynamic || descWritable !== undefined || descEnumerable !== undefined || descConfigurable !== undefined;

  // ── Getter/setter path ──────────────────────────────────────────────
  // Object.defineProperty(obj, "prop", { get() {...}, set(v) {...} })
  //
  // (#1629 S3) For a *statically struct-typed* receiver (a class instance / typed
  // object — `receiverIsStaticStruct`) this branch compiles the getter/setter into
  // a `${structName}_get_<prop>` Wasm function + `classAccessorSet` registration,
  // which the read site dispatches via `compilePropertyAccess`'s class-accessor
  // path. That read site resolves the same `structName`, so the compiled fast
  // path is reachable and stays — removing it regresses the #459 accessor suite.
  //
  // For a `const o:any = {...}` receiver, by contrast, `structName` was resolved
  // ONLY via the define-site rescue fallbacks 1-3 below, which the *read* site
  // (`resolveStructNameForExpr`) lacks. Such reads lower to `__extern_get` /
  // `_safeGet`, which the synthesized compiled getter can NOT serve — so the old
  // unconditional early-return left the getter in neither
  // `_wasmStructProps[obj]["__get_<prop>"]` nor `_wasmStructAccessors`, and
  // `o.p` / `o["p"]` / `o[k]` / host reads returned `undefined`. We now fall
  // those through (below) to `emitExternDefinePropertyNoValue`, which mirrors
  // get/set into the runtime `__defineProperty_accessor` import (closure-wrapped
  // via `_maybeWrapCallable` / the unconditional `__call_fn_<n>` bridge, validated
  // by `_validatePropertyDescriptor`, written to the canonical sidecar slot
  // `_safeGet` / S1 `_readOwnDescriptor` / GOPD all consult). One write reconciles
  // every reader — the symmetric mirror the data-value path already emits via
  // `__defineProperty_value`.
  if (
    receiverIsStaticStruct &&
    (getNode || setNode) &&
    !valueExpr &&
    structName &&
    structTypeIdx !== undefined &&
    propName
  ) {
    // Compile obj and save to local
    const objType = compileExpression(ctx, fctx, objArg);
    if (!objType) return null;
    const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, objType);
    fctx.body.push({ op: "local.set", index: objLocal });
    emitObjectArgNullGuard(ctx, fctx, objLocal);

    const accessorKey = `${structName}_${propName}`;
    ctx.classAccessorSet.add(accessorKey);

    // (#1888 S5c / C2) STORE arm — land dark behind `S5C_STRUCT_ACCESSOR_CLOSURE`.
    // The #1629-S3 bare `${struct}_get/set_${prop}` fns below have NO capture
    // environment, so a getter/setter that closes over outer scope reads those
    // captures as 0 (sd-1888 root cause). Under standalone, additionally lift
    // each accessor as a host-free CLOSURE (captures baked into `$self` by
    // `compileArrowAsClosure`, `this` via `__current_this`) and store it in the
    // per-(struct,prop) `(mut externref)` module global. C3 (read) / C4 (write)
    // gate dispatch on `ctx.structAccessorClosure.has(key)` to route through the
    // S5b `__call_accessor_get/set` drivers; until those land the bare-fn path
    // below still serves reads, so this arm is additive + side-effect-free when
    // the flag is off. The `as unknown as ts.FunctionExpression` cast mirrors the
    // proven S5b `emitAccessorFn` call sites (object-ops.ts ~1945) — accessor
    // nodes (MethodDeclaration / Get/SetAccessorDeclaration) structurally satisfy
    // the `.body` / `.parameters` / `.modifiers` reads `compileArrowAsClosure`
    // performs.
    if (S5C_STRUCT_ACCESSOR_CLOSURE && ctx.standalone) {
      if (getNode) {
        const getGlobalIdx = ensureStructAccessorGlobal(ctx, structName, propName, "get");
        if (buildAccessorClosure(ctx, fctx, getNode as unknown as ts.FunctionExpression)) {
          fctx.body.push({ op: "global.set", index: getGlobalIdx });
        } else {
          // Lift failed — leave the global null; the bare-fn read path below
          // still serves this accessor, so no behavior regression.
          fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "global.set", index: getGlobalIdx });
        }
      }
      if (setNode) {
        const setGlobalIdx = ensureStructAccessorGlobal(ctx, structName, propName, "set");
        if (buildAccessorClosure(ctx, fctx, setNode as unknown as ts.FunctionExpression)) {
          fctx.body.push({ op: "global.set", index: setGlobalIdx });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "global.set", index: setGlobalIdx });
        }
      }
    }

    // Helper to get body statements from a getter/setter node
    const getBodyStatements = (
      node:
        | ts.MethodDeclaration
        | ts.GetAccessorDeclaration
        | ts.SetAccessorDeclaration
        | ts.FunctionExpression
        | ts.ArrowFunction,
    ): ts.Statement[] => {
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        // Arrow with expression body: wrap as return statement
        return [];
      }
      const body = ts.isArrowFunction(node) ? (node.body as ts.Block) : node.body;
      return body ? [...body.statements] : [];
    };

    // Helper to get parameters from a node
    const getParams = (
      node: ts.MethodDeclaration | ts.SetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction,
    ): readonly ts.ParameterDeclaration[] => {
      return node.parameters;
    };

    // Compile getter
    if (getNode) {
      const getterName = `${structName}_get_${propName}`;
      if (!ctx.funcMap.has(getterName)) {
        // Use ref_null so callers with nullable locals don't need ref.as_non_null
        const getterParams: ValType[] = [{ kind: "ref_null", typeIdx: structTypeIdx }];

        // Determine return type from the getter function signature
        const sig = ctx.checker.getSignatureFromDeclaration(getNode);
        let getterResults: ValType[] = [];
        if (sig) {
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          if (!isVoidType(retType)) {
            getterResults = [resolveWasmType(ctx, retType)];
          }
        }

        const getterTypeIdx = addFuncType(ctx, getterParams, getterResults, `${getterName}_type`);
        const getterFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
        ctx.funcMap.set(getterName, getterFuncIdx);

        const getterFunc: WasmFunction = {
          name: getterName,
          typeIdx: getterTypeIdx,
          locals: [],
          body: [],
          exported: false,
        };
        ctx.mod.functions.push(getterFunc);

        // Compile getter body
        const getterFctx: FunctionContext = {
          name: getterName,
          params: [{ name: "this", type: { kind: "ref_null", typeIdx: structTypeIdx } }],
          locals: [],
          localMap: new Map(),
          returnType: getterResults.length > 0 ? getterResults[0]! : null,
          body: [],
          blockDepth: 0,
          breakStack: [],
          continueStack: [],
          labelMap: new Map(),
          savedBodies: [],
        };
        getterFctx.localMap.set("this", 0);

        const savedFunc = ctx.currentFunc;
        if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
        if (savedFunc) ctx.funcStack.push(savedFunc);
        ctx.currentFunc = getterFctx;

        if (ts.isArrowFunction(getNode) && !ts.isBlock(getNode.body)) {
          // Arrow with expression body: compile as return expression
          const retType = compileExpression(
            ctx,
            getterFctx,
            getNode.body as ts.Expression,
            getterFctx.returnType ?? undefined,
          );
          if (retType && getterFctx.returnType && retType.kind !== getterFctx.returnType.kind) {
            coerceType(ctx, getterFctx, retType, getterFctx.returnType);
          }
        } else {
          const stmts = getBodyStatements(getNode);
          for (const stmt of stmts) {
            compileStatement(ctx, getterFctx, stmt);
          }
        }

        // Ensure valid return for non-void getters
        if (getterFctx.returnType) {
          const lastInstr = getterFctx.body[getterFctx.body.length - 1];
          if (!lastInstr || lastInstr.op !== "return") {
            if (getterFctx.returnType.kind === "f64") {
              getterFctx.body.push({ op: "f64.const", value: 0 });
            } else if (getterFctx.returnType.kind === "i32") {
              getterFctx.body.push({ op: "i32.const", value: 0 });
            } else if (getterFctx.returnType.kind === "externref") {
              getterFctx.body.push({ op: "ref.null.extern" });
            } else if (getterFctx.returnType.kind === "ref" || getterFctx.returnType.kind === "ref_null") {
              getterFctx.body.push({ op: "ref.null", typeIdx: getterFctx.returnType.typeIdx });
            }
          }
        }
        cacheStringLiterals(ctx, getterFctx);
        getterFunc.locals = getterFctx.locals;
        getterFunc.body = getterFctx.body;
        if (savedFunc) ctx.funcStack.pop();
        if (savedFunc) ctx.parentBodiesStack.pop();
        ctx.currentFunc = savedFunc;
      }
    }

    // Compile setter
    if (setNode) {
      const setterName = `${structName}_set_${propName}`;
      if (!ctx.funcMap.has(setterName)) {
        // Use ref_null so callers with nullable locals don't need ref.as_non_null
        const setterParams: ValType[] = [{ kind: "ref_null", typeIdx: structTypeIdx }];
        const allNodeParams = getParams(setNode);
        // Filter out the TS `this` parameter (explicit this type annotation)
        const nodeParams = allNodeParams.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === "this"));
        for (const param of nodeParams) {
          const paramType = ctx.checker.getTypeAtLocation(param);
          setterParams.push(resolveWasmType(ctx, paramType));
        }

        const setterTypeIdx = addFuncType(ctx, setterParams, [], `${setterName}_type`);
        const setterFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
        ctx.funcMap.set(setterName, setterFuncIdx);

        const setterFunc: WasmFunction = {
          name: setterName,
          typeIdx: setterTypeIdx,
          locals: [],
          body: [],
          exported: false,
        };
        ctx.mod.functions.push(setterFunc);

        // Compile setter body
        const setterFctxParams: { name: string; type: ValType }[] = [
          { name: "this", type: { kind: "ref_null", typeIdx: structTypeIdx } },
        ];
        for (let pi = 0; pi < nodeParams.length; pi++) {
          const param = nodeParams[pi]!;
          const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
          const paramType = ctx.checker.getTypeAtLocation(param);
          setterFctxParams.push({ name: paramName, type: resolveWasmType(ctx, paramType) });
        }

        const setterFctx: FunctionContext = {
          name: setterName,
          params: setterFctxParams,
          locals: [],
          localMap: new Map(),
          returnType: null,
          body: [],
          blockDepth: 0,
          breakStack: [],
          continueStack: [],
          labelMap: new Map(),
          savedBodies: [],
        };
        for (let i = 0; i < setterFctxParams.length; i++) {
          setterFctx.localMap.set(setterFctxParams[i]!.name, i);
        }

        const savedFunc = ctx.currentFunc;
        if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
        if (savedFunc) ctx.funcStack.push(savedFunc);
        ctx.currentFunc = setterFctx;

        if (ts.isArrowFunction(setNode) && !ts.isBlock(setNode.body)) {
          // Arrow with expression body: compile for side effects
          const retType = compileExpression(ctx, setterFctx, setNode.body as ts.Expression);
          if (retType) setterFctx.body.push({ op: "drop" });
        } else {
          const stmts = getBodyStatements(setNode as ts.MethodDeclaration);
          for (const stmt of stmts) {
            compileStatement(ctx, setterFctx, stmt);
          }
        }

        cacheStringLiterals(ctx, setterFctx);
        setterFunc.locals = setterFctx.locals;
        setterFunc.body = setterFctx.body;
        if (savedFunc) ctx.funcStack.pop();
        if (savedFunc) ctx.parentBodiesStack.pop();
        ctx.currentFunc = savedFunc;
      }
    }

    // Return obj
    fctx.body.push({ op: "local.get", index: objLocal });
    return objType;
  }

  if (valueExpr && useStruct) {
    // Struct path: Object.defineProperty(obj, "prop", { value: v }) → struct.set

    // Compile obj and save to local
    let objType = compileExpression(ctx, fctx, objArg);
    if (!objType) return null;

    // If obj is externref but we know it's a struct (e.g. `const obj: any = { x: 0 }`),
    // cast from externref to the struct ref type via any.convert_extern + guarded ref.cast.
    if (objType.kind === "externref" && structTypeIdx !== undefined) {
      fctx.body.push({ op: "any.convert_extern" } as Instr);
      // Guard: ref.test before ref.cast to avoid illegal cast traps
      const tmpAny = allocTempLocal(fctx, { kind: "anyref" } as ValType);
      fctx.body.push({ op: "local.tee", index: tmpAny });
      fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "ref_null", typeIdx: structTypeIdx } as ValType },
        then: [{ op: "local.get", index: tmpAny } as Instr, { op: "ref.cast_null", typeIdx: structTypeIdx } as Instr],
        else: [{ op: "ref.null", typeIdx: structTypeIdx }],
      } as Instr);
      releaseTempLocal(fctx, tmpAny);
      objType = { kind: "ref_null", typeIdx: structTypeIdx };
    }

    const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, objType);
    fctx.body.push({ op: "local.set", index: objLocal });
    emitObjectArgNullGuard(ctx, fctx, objLocal);

    // ── Compile-time flag checking for struct path ──
    // Save existing flags BEFORE updating (needed for value comparison below)
    let priorExistingFlags: number | undefined;
    const isKnownExistingField = structTypeIdx !== undefined && fields && fieldIdx >= 0;
    let appliedStructFlags = applyDescriptorFlags(
      isKnownExistingField ? PROP_FLAGS_DEFAULT_DATA : undefined,
      descWritable,
      descEnumerable,
      descConfigurable,
      false,
      true,
    );
    if (propName) {
      const varName = ts.isIdentifier(objArg) ? objArg.text : undefined;
      if (varName) {
        const isAccessor = !!(getNode || setNode);
        const key = `${varName}:${propName}`;
        const trackedExistingFlags = ctx.definedPropertyFlags.get(key);
        const isDefinePropertyWidenedField = ctx.widenedDefinePropertyKeys.has(key);
        const currentFlags =
          trackedExistingFlags ??
          (isKnownExistingField && !isDefinePropertyWidenedField ? PROP_FLAGS_DEFAULT_DATA : undefined);
        const newFlags = applyDescriptorFlags(
          currentFlags,
          descWritable,
          descEnumerable,
          descConfigurable,
          isAccessor,
          descWritable !== undefined,
        );
        appliedStructFlags = newFlags;
        priorExistingFlags = currentFlags;

        // Check non-extensibility — but only for genuinely new properties.
        // If the property is a known struct field (fieldIdx >= 0), it already
        // exists on the object, so redefining it is not "adding a new property".
        if (ctx.nonExtensibleVars.has(varName) && currentFlags === undefined) {
          emitThrowString(ctx, fctx, "TypeError: Cannot define property, object is not extensible");
        }

        // Check existing flags
        const existingFlags = currentFlags;
        if (existingFlags !== undefined) {
          const isExistingConfigurable = !!(existingFlags & PROP_FLAG_CONFIGURABLE);
          if (!isExistingConfigurable) {
            // Non-configurable: check for violations
            if (newFlags & PROP_FLAG_CONFIGURABLE) {
              emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
            }
            const existingEnumerable = existingFlags & PROP_FLAG_ENUMERABLE;
            const newEnumerable = newFlags & PROP_FLAG_ENUMERABLE;
            if (existingEnumerable !== newEnumerable) {
              emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
            }
            // Data property writable checks
            if (!(existingFlags & PROP_FLAG_ACCESSOR) && !isAccessor) {
              if (!(existingFlags & PROP_FLAG_WRITABLE)) {
                if (newFlags & PROP_FLAG_WRITABLE) {
                  // Cannot change writable from false to true on non-configurable
                  emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
                }
              }
            }
            // Cannot change data<->accessor on non-configurable
            if (isAccessor && !(existingFlags & PROP_FLAG_ACCESSOR)) {
              emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
            }
            if (!isAccessor && existingFlags & PROP_FLAG_ACCESSOR) {
              emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
            }
          }
        }

        // Record the new flags
        ctx.definedPropertyFlags.set(key, newFlags);

        // Update shapePropFlags so getOwnPropertyDescriptor sees updated attributes
        if (structTypeIdx !== undefined && fields) {
          const userFieldsList = fields
            .map((f, idx) => ({ field: f, fieldIdx: idx }))
            .filter((e) => !e.field.name.startsWith("__"));
          const userIdx = userFieldsList.findIndex((e) => e.field.name === propName);
          if (userIdx >= 0) {
            const flagsArr = ctx.shapePropFlags.get(structTypeIdx);
            if (flagsArr && userIdx < flagsArr.length) {
              flagsArr[userIdx] = newFlags & 0x07; // Only store WEC bits
            }
          }
        }
      }
    }

    // Compile remaining descriptor properties for side effects (before value)
    for (const prop of (descArg as ts.ObjectLiteralExpression).properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") continue;
      if (ts.isPropertyAssignment(prop)) {
        const sideType = compileExpression(ctx, fctx, prop.initializer);
        if (sideType) fctx.body.push({ op: "drop" });
      }
    }

    // Check if this property is non-writable non-configurable (needs runtime value comparison)
    // Uses priorExistingFlags captured BEFORE the current call updated the map.
    // Also: if the object is frozen, ALL data properties are non-writable non-configurable,
    // even if they weren't explicitly set via defineProperty (i.e. original struct fields).
    const varName2 = ts.isIdentifier(objArg) ? objArg.text : undefined;
    const isFrozenProperty = varName2 !== undefined && ctx.frozenVars.has(varName2) && isKnownExistingField;
    const shouldStoreDescriptorDefaults =
      varName2 !== undefined &&
      propName !== undefined &&
      ctx.widenedDefinePropertyKeys.has(`${varName2}:${propName}`) &&
      priorExistingFlags === undefined;
    const needsValueCompare =
      isFrozenProperty ||
      (priorExistingFlags !== undefined &&
        !(priorExistingFlags & PROP_FLAG_CONFIGURABLE) &&
        !(priorExistingFlags & PROP_FLAG_WRITABLE) &&
        !(priorExistingFlags & PROP_FLAG_ACCESSOR));

    // Emit struct.set: push obj, then value, then struct.set
    const fieldType = fields![fieldIdx]!.type;

    if (needsValueCompare) {
      // Save old value for comparison
      const oldValLocal = allocLocal(fctx, `__defprop_oldval_${fctx.locals.length}`, fieldType);
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx!, fieldIdx });
      fctx.body.push({ op: "local.set", index: oldValLocal });

      // Compile new value into temp local
      const newValLocal = allocLocal(fctx, `__defprop_newval_${fctx.locals.length}`, fieldType);
      const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
      if (!valType) {
        fctx.body.push({ op: "local.get", index: objLocal });
        return objType;
      }
      if (valType.kind !== fieldType.kind) {
        coerceType(ctx, fctx, valType, fieldType);
      }
      fctx.body.push({ op: "local.set", index: newValLocal });

      // Compare old and new values. If different, throw TypeError.
      // Use SameValue semantics (for f64: need to handle NaN === NaN, +0 !== -0)
      const tagIdx = ensureExnTag(ctx);
      const errMsg = "TypeError: Cannot redefine property";
      addStringConstantGlobal(ctx, errMsg);
      const errMsgGlobal = ctx.stringGlobalMap.get(errMsg)!;

      if (fieldType.kind === "f64") {
        // f64 comparison using SameValue semantics (ECMA-262 §7.2.10):
        //   SameValue(x, y) = (x == y && copysign(1,x) == copysign(1,y)) || (x != x && y != y)
        // This correctly handles: SameValue(NaN, NaN) = true, SameValue(+0, -0) = false.
        //
        // f64.copysign(x, y) returns x with the sign of y. To extract the
        // SIGN of a value (without its magnitude) we need copysign(1, value).
        // In Wasm stack order, that's: push 1, then push value, then copysign
        // pops y=value first and x=1 second. The previous version had the
        // pushes reversed, computing copysign(value, 1) = abs(value), which
        // collapsed `+0` and `-0` to the same sign and silently allowed
        // `Object.defineProperty(obj, "x", { value: -0 })` on a frozen +0.
        const compareBody: Instr[] = [
          { op: "global.get", index: errMsgGlobal } as Instr,
          { op: "throw", tagIdx } as Instr,
        ];
        // Part 1: (old == new) && (copysign(1,old) == copysign(1,new))
        fctx.body.push({ op: "local.get", index: oldValLocal });
        fctx.body.push({ op: "local.get", index: newValLocal });
        fctx.body.push({ op: "f64.eq" });
        fctx.body.push({ op: "f64.const", value: 1.0 });
        fctx.body.push({ op: "local.get", index: oldValLocal });
        fctx.body.push({ op: "f64.copysign" });
        fctx.body.push({ op: "f64.const", value: 1.0 });
        fctx.body.push({ op: "local.get", index: newValLocal });
        fctx.body.push({ op: "f64.copysign" });
        fctx.body.push({ op: "f64.eq" });
        fctx.body.push({ op: "i32.and" });
        // Part 2: (old != old) && (new != new)  — both NaN
        fctx.body.push({ op: "local.get", index: oldValLocal });
        fctx.body.push({ op: "local.get", index: oldValLocal });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "local.get", index: newValLocal });
        fctx.body.push({ op: "local.get", index: newValLocal });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.and" });
        // SameValue = part1 || part2
        fctx.body.push({ op: "i32.or" });
        // If NOT SameValue → throw TypeError
        fctx.body.push({ op: "i32.eqz" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: compareBody,
        });
      } else if (fieldType.kind === "i32") {
        const compareBody: Instr[] = [
          { op: "global.get", index: errMsgGlobal } as Instr,
          { op: "throw", tagIdx } as Instr,
        ];
        fctx.body.push({ op: "local.get", index: oldValLocal });
        fctx.body.push({ op: "local.get", index: newValLocal });
        fctx.body.push({ op: "i32.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: compareBody,
        });
      }
      // For externref/ref types, skip value comparison (would need reference equality)

      // Do the struct.set with the new value
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "local.get", index: newValLocal });
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx!, fieldIdx });
    } else {
      fctx.body.push({ op: "local.get", index: objLocal });
      const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
      if (!valType) {
        // Drop the obj ref we just pushed
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "local.get", index: objLocal });
        return objType;
      }
      if (valType.kind !== fieldType.kind) {
        coerceType(ctx, fctx, valType, fieldType);
      }
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx!, fieldIdx });
    }

    // (#1460 R1) Register attribute flags in the runtime sidecar
    // (`_wasmPropDescs`) when any of writable/enumerable/configurable is
    // specified. We pass the raw struct obj through `extern.convert_any` so the
    // host import sees the same externref identity used by every other sidecar
    // lookup. Value bit (1<<7) is left unset so the host doesn't overwrite the
    // value we just struct.set above.
    if (anyFlagSpecified || shouldStoreDescriptorDefaults) {
      fctx.body.push({ op: "local.get", index: objLocal });
      if (objType.kind === "ref" || objType.kind === "ref_null") {
        fctx.body.push({ op: "extern.convert_any" } as Instr);
      } else if (objType.kind !== "externref") {
        coerceType(ctx, fctx, objType, { kind: "externref" });
      }
      // prop key
      const sePropType = compileExpression(ctx, fctx, propArg, { kind: "externref" });
      if (sePropType && sePropType.kind !== "externref") {
        coerceType(ctx, fctx, sePropType, { kind: "externref" });
      }
      // null value (hasValue=false ensures runtime won't overwrite struct.set)
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({
        op: "f64.const",
        value: (1 << 3) | (1 << 4) | (1 << 5) | (appliedStructFlags & 0x07),
      });
      const sideFuncIdx = ensureLateImport(
        ctx,
        "__defineProperty_value",
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (sideFuncIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: sideFuncIdx });
        fctx.body.push({ op: "drop" }); // discard returned obj
      }
    }

    // Return obj
    fctx.body.push({ op: "local.get", index: objLocal });
    return objType;
  } else if (valueExpr) {
    // Externref path: Object.defineProperty(obj, prop, { value: v }) → __defineProperty_value
    return emitExternDefinePropertyValue(
      ctx,
      fctx,
      objArg,
      propArg,
      descArg,
      valueExpr,
      descWritable,
      descEnumerable,
      descConfigurable,
    );
  } else {
    // No value property or descriptor is not an object literal:
    // For externref objects, delegate to __defineProperty_value with no-value flag
    return emitExternDefinePropertyNoValue(
      ctx,
      fctx,
      objArg,
      propArg,
      descArg,
      descWritable,
      descEnumerable,
      descConfigurable,
      getNode,
      setNode,
      getExpr,
      setExpr,
    );
  }
}

// ── __defineProperty_value runtime flag encoding ──────────────────────
//   bit 0: writable          bit 3: writable specified
//   bit 1: enumerable        bit 4: enumerable specified
//   bit 2: configurable      bit 5: configurable specified
//   bit 6: is accessor       bit 7: has value

function computeRuntimeFlags(
  descWritable: boolean | undefined,
  descEnumerable: boolean | undefined,
  descConfigurable: boolean | undefined,
  hasValue: boolean,
): number {
  let flags = 0;
  if (descWritable !== undefined) {
    flags |= 1 << 3; // writable specified
    if (descWritable) flags |= 1;
  }
  if (descEnumerable !== undefined) {
    flags |= 1 << 4; // enumerable specified
    if (descEnumerable) flags |= 1 << 1;
  }
  if (descConfigurable !== undefined) {
    flags |= 1 << 5; // configurable specified
    if (descConfigurable) flags |= 1 << 2;
  }
  if (hasValue) flags |= 1 << 7;
  return flags;
}

/**
 * Extract any dynamic-flag expressions (non-constant-foldable) from a descriptor
 * object literal. The compiler converts each to runtime `__to_boolean` calls so
 * that `Object.defineProperty(obj, k, { configurable: -12345 })` ToBoolean-coerces
 * per ES §6.2.5.6 step 5.b (#1460 R1).
 */
function extractDynamicFlagExprs(descArg: ts.Expression): {
  writableDyn?: ts.Expression;
  enumerableDyn?: ts.Expression;
  configurableDyn?: ts.Expression;
} {
  const out: {
    writableDyn?: ts.Expression;
    enumerableDyn?: ts.Expression;
    configurableDyn?: ts.Expression;
  } = {};
  if (!ts.isObjectLiteralExpression(descArg)) return out;
  for (const prop of descArg.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const folded = tryConstantFoldToBoolean(prop.initializer);
    if (folded !== undefined) continue;
    if (prop.name.text === "writable") out.writableDyn = prop.initializer;
    else if (prop.name.text === "enumerable") out.enumerableDyn = prop.initializer;
    else if (prop.name.text === "configurable") out.configurableDyn = prop.initializer;
  }
  return out;
}

/**
 * Emit code that pushes the runtime flag bitword as an f64 onto the stack.
 *
 * Static base: encode constant-foldable flags via `computeRuntimeFlags`.
 * Dynamic adds: for each non-constant-foldable flag, compile the expression as
 * externref, call `__to_boolean` (i32), shift to the value bit position, and
 * OR with the running accumulator. The "specified" bit for each dynamic flag
 * is included in the static base (the attribute IS supplied; only the bool
 * value is computed at runtime).
 *
 * Stack effect: pushes 1 value (f64).
 */
function emitRuntimeFlagsF64(
  ctx: CodegenContext,
  fctx: FunctionContext,
  descWritable: boolean | undefined,
  descEnumerable: boolean | undefined,
  descConfigurable: boolean | undefined,
  hasValue: boolean,
  writableDyn: ts.Expression | undefined,
  enumerableDyn: ts.Expression | undefined,
  configurableDyn: ts.Expression | undefined,
): void {
  const hasDynamic = writableDyn !== undefined || enumerableDyn !== undefined || configurableDyn !== undefined;
  if (!hasDynamic) {
    const flags = computeRuntimeFlags(descWritable, descEnumerable, descConfigurable, hasValue);
    fctx.body.push({ op: "f64.const", value: flags });
    return;
  }
  // Static base includes:
  //   - bit 7 (hasValue)
  //   - bit 3/4/5 (specified) for all dynamic flags
  //   - bit 3/4/5 (specified) + value bit for any statically-folded flags
  let staticBase = 0;
  if (hasValue) staticBase |= 1 << 7;
  if (descWritable !== undefined) {
    staticBase |= 1 << 3;
    if (descWritable) staticBase |= 1;
  } else if (writableDyn !== undefined) {
    staticBase |= 1 << 3;
  }
  if (descEnumerable !== undefined) {
    staticBase |= 1 << 4;
    if (descEnumerable) staticBase |= 1 << 1;
  } else if (enumerableDyn !== undefined) {
    staticBase |= 1 << 4;
  }
  if (descConfigurable !== undefined) {
    staticBase |= 1 << 5;
    if (descConfigurable) staticBase |= 1 << 2;
  } else if (configurableDyn !== undefined) {
    staticBase |= 1 << 5;
  }
  // Push static base as i32
  fctx.body.push({ op: "i32.const", value: staticBase });

  const toBoolIdx = ensureLateImport(ctx, "__to_boolean", [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);

  const emitDyn = (expr: ts.Expression, valueBitShift: number): void => {
    // Compile expr → externref
    const t = compileExpression(ctx, fctx, expr, { kind: "externref" });
    if (t && t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
    if (toBoolIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toBoolIdx });
    } else {
      // Defensive: __to_boolean import is built-in to the runtime, this should not happen.
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    if (valueBitShift > 0) {
      fctx.body.push({ op: "i32.const", value: valueBitShift });
      fctx.body.push({ op: "i32.shl" });
    }
    fctx.body.push({ op: "i32.or" });
  };
  if (writableDyn !== undefined) emitDyn(writableDyn, 0); // bit 0
  if (enumerableDyn !== undefined) emitDyn(enumerableDyn, 1); // bit 1
  if (configurableDyn !== undefined) emitDyn(configurableDyn, 2); // bit 2

  // Convert i32 → f64 for the f64-typed flags parameter
  fctx.body.push({ op: "f64.convert_i32_s" });
}

/**
 * #2042 PR-A — ToPropertyKey the `Object.defineProperty` key in standalone mode.
 *
 * The standalone `$Object` runtime is string-keyed: `__obj_insert` /
 * `__defineProperty_value` / `__defineProperty_accessor` all `ref.cast
 * $AnyString` the incoming key. The defineProperty call sites compile the key
 * with the `{ externref }` hint, which boxes a *number* literal
 * (`Object.defineProperty(o, 0, …)`) as a boxed-number externref rather than a
 * string — that boxed number then traps `illegal cast` in `__obj_insert`.
 *
 * `__extern_toString` (host import in JS mode, native runtime helper in
 * standalone) maps any externref through ToString — numeric keys become their
 * canonical decimal ("0", "1.5"), matching how `{0:x}` / `obj[0]=x` store the
 * key. It is idempotent on strings, so string keys pass through unchanged.
 *
 * Expects the key externref on top of the stack; leaves a $AnyString externref.
 * Gated on `ctx.standalone`: in host mode `__defineProperty_value` is a JS
 * import that ToPropertyKeys the key itself (and correctly preserves Symbol
 * keys, which a pre-emptive ToString would alias) — so host output stays
 * byte-identical. Symbol keys in standalone are out of scope for Part A; the
 * string-keyed runtime cannot represent them, and ToString-ing one would alias
 * `Symbol("x")` to `"Symbol(x)"` — but the `15.2.3.6-4-*` illegal-cast rows are
 * numeric, not symbol, so the bulk is fixed here.
 */
function emitStandaloneDefinePropertyKeyToString(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!ctx.standalone) return;
  const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  const finalIdx = ctx.funcMap.get("__extern_toString") ?? toStrIdx;
  if (finalIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalIdx });
}

/**
 * Emit __defineProperty_value(obj, prop, value, flags) for the externref value path.
 */
function emitExternDefinePropertyValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objArg: ts.Expression,
  propArg: ts.Expression,
  descArg: ts.Expression,
  valueExpr: ts.Expression,
  descWritable: boolean | undefined,
  descEnumerable: boolean | undefined,
  descConfigurable: boolean | undefined,
): ValType | null {
  markRuntimeDefinedProperty(ctx, objArg, propArg);

  // Compile obj WITHOUT externref hint to get the raw Wasm type.
  // For vec structs (e.g. string[], number[]) coerceType would call __make_iterable,
  // which creates a NEW JS array on every call — breaking sidecar property descriptor
  // storage (WeakMap keys on different objects each time). We emit extern.convert_any
  // directly to get a stable externref identity for the WasmGC struct (#856).
  const objType = compileExpression(ctx, fctx, objArg);
  if (!objType) return null;
  if (objType.kind === "ref" || objType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" } as Instr);
  } else if (objType.kind !== "externref") {
    coerceType(ctx, fctx, objType, { kind: "externref" });
  }
  const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // ES spec 19.1.2.4 step 1: throw TypeError if first arg is null/undefined (standalone mode)
  emitObjectArgNullGuard(ctx, fctx, objLocal);

  // Compile prop key as externref
  const propType = compileExpression(ctx, fctx, propArg, { kind: "externref" });
  if (!propType) {
    fctx.body.push({ op: "local.get", index: objLocal });
    return { kind: "externref" };
  }
  if (propType.kind !== "externref") {
    coerceType(ctx, fctx, propType, { kind: "externref" });
  }
  // #2042 PR-A: in standalone mode the `$Object` table is string-keyed and
  // `__obj_insert` does `ref.cast $AnyString` on the key. A non-string key —
  // `Object.defineProperty(o, 0, …)` boxes `0` as a number externref — traps
  // `illegal cast`. ToPropertyKey (ToString for everything but Symbols) it here
  // so the value handed to `__defineProperty_value` is always a $AnyString. In
  // host mode `__defineProperty_value` is a JS import that ToPropertyKeys
  // itself (and would mishandle a pre-stringified Symbol), so gate on standalone.
  emitStandaloneDefinePropertyKeyToString(ctx, fctx);
  const propLocal = allocLocal(fctx, `__defprop_key_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: propLocal });

  // Compile value as externref
  const valType = compileExpression(ctx, fctx, valueExpr, { kind: "externref" });
  if (!valType) {
    fctx.body.push({ op: "local.get", index: objLocal });
    return { kind: "externref" };
  }
  if (valType.kind !== "externref") {
    coerceType(ctx, fctx, valType, { kind: "externref" });
  }
  const valLocal = allocLocal(fctx, `__defprop_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valLocal });

  // Compile remaining descriptor properties for side effects
  if (ts.isObjectLiteralExpression(descArg)) {
    for (const prop of descArg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") continue;
      // Skip flag properties (writable, enumerable, configurable) — handled via flags param
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        (prop.name.text === "writable" || prop.name.text === "enumerable" || prop.name.text === "configurable")
      )
        continue;
      if (ts.isPropertyAssignment(prop)) {
        const sideType = compileExpression(ctx, fctx, prop.initializer);
        if (sideType) fctx.body.push({ op: "drop" });
      }
    }
  }

  // Compute runtime flags (#1460 R1: ToBoolean coercion on dynamic flag exprs)
  const { writableDyn, enumerableDyn, configurableDyn } = extractDynamicFlagExprs(descArg);

  // Push args: obj, key, val, flags and call __defineProperty_value
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: propLocal });
  fctx.body.push({ op: "local.get", index: valLocal });
  emitRuntimeFlagsF64(
    ctx,
    fctx,
    descWritable,
    descEnumerable,
    descConfigurable,
    true,
    writableDyn,
    enumerableDyn,
    configurableDyn,
  );

  const funcIdx = ensureLateImport(
    ctx,
    "__defineProperty_value",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (funcIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx });
  }

  // __defineProperty_value returns obj, so we're done
  return { kind: "externref" };
}

/**
 * Resolve an expression to its underlying function AST node for use with compileArrowAsCallback.
 * For `get: identifierRef` / `set: identifierRef`, looks up the TS symbol and returns the
 * function declaration or function expression at the declaration site.
 * Returns undefined if the expression does not resolve to a compilable function node.
 */
function resolveExprToFuncNode(
  ctx: CodegenContext,
  expr: ts.Expression,
): ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined {
  const sym = ctx.checker.getSymbolAtLocation(expr);
  if (!sym) return undefined;
  const decl = sym.valueDeclaration;
  if (!decl) return undefined;
  // Direct function declaration: function getFunc() { ... }
  if (ts.isFunctionDeclaration(decl)) return decl;
  // Variable: var setFunc = function(v) { ... } or var setFunc = (v) => ...
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = decl.initializer;
    if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return init;
  }
  return undefined;
}

/**
 * (#1888 S5b) Compile an accessor getter/setter function and leave an externref
 * on the stack to pass into `__defineProperty_accessor`. Returns `true` when a
 * value was pushed, `false` when the caller should push `ref.null.extern`.
 *
 * Dual-mode:
 *  - **standalone** (`ctx.standalone`): compile the function as a HOST-FREE
 *    closure (`compileArrowAsClosure`) and convert the closure-struct ref →
 *    externref. This is what makes the stored `$PropEntry.$get/$set` slot hold a
 *    real callable closure that the native accessor arms in `__extern_get`/
 *    `__extern_set` can dispatch through `__call_accessor_get/set` →
 *    `__call_fn_method_0/1` (which threads the receiver as `this` via
 *    `__current_this`, #1636-S1). The lifted closure body sets
 *    `readsCurrentThis: true`, so `this` inside the getter/setter resolves to the
 *    installed receiver per §6.2.5.5 / §10.1.5.3.
 *  - **JS-host / GC** (default): unchanged — `compileArrowAsCallback` with
 *    `needsThis: true` routes through the `__make_getter_callback` JS bridge.
 *    Gating strictly on `ctx.standalone` keeps the host/GC binary byte-identical.
 */
function emitAccessorFn(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fn: ts.FunctionExpression | ts.ArrowFunction,
): boolean {
  if (ctx.standalone) {
    const closureType = compileArrowAsClosure(ctx, fctx, fn);
    if (!closureType) return false;
    // compileArrowAsClosure leaves a closure-struct ref; __defineProperty_accessor
    // expects externref. Convert unless it is already externref.
    if (closureType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" } as Instr);
    }
    return true;
  }
  return !!compileArrowAsCallback(ctx, fctx, fn, { needsThis: true });
}

/**
 * Emit __defineProperty_value(obj, prop, null, flags) for descriptors without a value property.
 * For externref objects, this delegates to the JS host which can handle flag-only descriptors.
 * For struct-typed objects, this is a no-op (struct fields are always writable).
 */
function emitExternDefinePropertyNoValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objArg: ts.Expression,
  propArg: ts.Expression,
  descArg: ts.Expression,
  descWritable: boolean | undefined,
  descEnumerable: boolean | undefined,
  descConfigurable: boolean | undefined,
  getNode: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined,
  setNode: ts.MethodDeclaration | ts.SetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined,
  getExpr?: ts.Expression,
  setExpr?: ts.Expression,
): ValType | null {
  // Compile obj
  const objType = compileExpression(ctx, fctx, objArg);
  if (!objType) return null;
  const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.set", index: objLocal });

  // ES spec 19.1.2.4 step 1: throw TypeError if first arg is null/undefined (standalone mode)
  if (objType.kind === "externref" || objType.kind === "ref_null") {
    emitObjectArgNullGuard(ctx, fctx, objLocal);
  }

  // Compile prop and save as externref (needed for __defineProperty_value call)
  const propType = compileExpression(ctx, fctx, propArg, { kind: "externref" });
  let propLocal: number | undefined;
  if (propType) {
    if (propType.kind !== "externref") {
      coerceType(ctx, fctx, propType, { kind: "externref" });
    }
    // #2042 PR-A: symmetric with the value path — stringify the key in
    // standalone so the string-keyed `$Object` runtime (__obj_insert /
    // __defineProperty_accessor) never `ref.cast $AnyString`-traps on a
    // numeric/boxed key.
    emitStandaloneDefinePropertyKeyToString(ctx, fctx);
    propLocal = allocLocal(fctx, `__defprop_key_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: propLocal });
  }

  // For accessor descriptors (get/set), skip compiling descArg for side effects —
  // we'll compile getter/setter directly as JS-callable callbacks below.
  const isAccessorDesc = !!(getNode || setNode || getExpr || setExpr);
  if (!isAccessorDesc) {
    // Compile descriptor for side effects:
    // - non-accessor descriptors are applied through the flag-only runtime
    //   helper or compile-time flag table after descriptor evaluation.
    // - accessor descriptors compile their getter/setter operands directly in
    //   the accessor runtime branch below.
    const descType = compileExpression(ctx, fctx, descArg);
    if (descType) fctx.body.push({ op: "drop" });
  }

  // For externref objects (or non-struct GC types like arrays), call the runtime
  // helper. Accessor descriptors also need the runtime path even when the key is
  // a known struct field: the sidecar is the only store that compiled reads can
  // consult for `get: identifierRef` / `set: identifierRef` descriptors.
  const objTsType = ctx.checker.getTypeAtLocation(objArg);
  const _staticStructName = resolveStructName(ctx, objTsType);
  const _structName =
    _staticStructName || (ts.isIdentifier(objArg) ? ctx.widenedVarStructMap.get(objArg.text) : undefined);
  const _propName = ts.isStringLiteral(propArg) ? propArg.text : undefined;
  const _structTypeIdx = _structName ? ctx.structMap.get(_structName) : undefined;
  const _fields = _structName ? ctx.structFields.get(_structName) : undefined;
  const _fieldIdx = _fields && _propName ? _fields.findIndex((f) => f.name === _propName) : -1;
  const isKnownStructField =
    _staticStructName !== undefined && _structTypeIdx !== undefined && _fields !== undefined && _fieldIdx >= 0;
  if ((!isKnownStructField || isAccessorDesc) && propLocal !== undefined) {
    markRuntimeDefinedProperty(ctx, objArg, propArg);
    const propName = ts.isStringLiteral(propArg) ? propArg.text : undefined;

    // Compile-time tracking
    if (propName && ts.isObjectLiteralExpression(descArg)) {
      const isAccessor = isAccessorDesc;
      const varName = ts.isIdentifier(objArg) ? objArg.text : undefined;
      if (varName) {
        const key = `${varName}:${propName}`;
        const newFlags = applyDescriptorFlags(
          ctx.definedPropertyFlags.get(key),
          descWritable,
          descEnumerable,
          descConfigurable,
          isAccessor,
          descWritable !== undefined,
        );
        ctx.definedPropertyFlags.set(key, newFlags);
      }
    }

    if (isAccessorDesc) {
      // Pre-box shared mutable captures: variables referenced by BOTH getter and setter
      // where at least one writes to them. Without this, each callback gets its own
      // copy of the captured variable — a setter write would not be visible to the getter. (#929)
      if (getNode && setNode) {
        const getterRefs = new Set<string>();
        const setterRefs = new Set<string>();
        const getterWrites = new Set<string>();
        const setterWrites = new Set<string>();
        collectReferencedIdentifiers(getNode, getterRefs);
        collectReferencedIdentifiers(setNode, setterRefs);
        collectWrittenIdentifiers(getNode, getterWrites);
        collectWrittenIdentifiers(setNode, setterWrites);

        for (const varName of getterRefs) {
          if (!setterRefs.has(varName)) continue;
          if (!getterWrites.has(varName) && !setterWrites.has(varName)) continue;
          const localIdx = fctx.localMap.get(varName);
          if (localIdx === undefined) continue;
          if (fctx.boxedCaptures?.has(varName)) continue; // already boxed
          const type: ValType =
            localIdx < fctx.params.length
              ? fctx.params[localIdx]!.type
              : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" as const });
          const refCellTypeIdx = getOrRegisterRefCellType(ctx, type);
          fctx.body.push({ op: "local.get", index: localIdx });
          fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
          const refCellLocalIdx = allocLocal(fctx, `__shared_rc_${varName}`, {
            kind: "ref_null",
            typeIdx: refCellTypeIdx,
          });
          fctx.body.push({ op: "local.set", index: refCellLocalIdx });
          fctx.localMap.set(varName, refCellLocalIdx);
          if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
          fctx.boxedCaptures.set(varName, { refCellTypeIdx, valType: type });
        }
      }

      // Accessor path: compile getter/setter as JS-callable callbacks.
      // (#1460 R1) Resolve dynamic enumerable/configurable expressions for ToBoolean.
      const accDyn = extractDynamicFlagExprs(descArg);

      fctx.body.push({ op: "local.get", index: objLocal });
      if (objType.kind === "ref" || objType.kind === "ref_null") {
        fctx.body.push({ op: "extern.convert_any" } as Instr);
      } else if (objType.kind !== "externref") {
        coerceType(ctx, fctx, objType, { kind: "externref" });
      }
      fctx.body.push({ op: "local.get", index: propLocal });

      // Compile getter (host-free closure under standalone, else JS callback;
      // #1888 S5b emitAccessorFn). `this` is the object the property is accessed on.
      if (getNode) {
        // MethodDeclaration / GetAccessorDeclaration — cast for TS; runtime props are compatible
        if (!emitAccessorFn(ctx, fctx, getNode as unknown as ts.FunctionExpression))
          fctx.body.push({ op: "ref.null.extern" });
      } else if (getExpr) {
        // get: identifierRef — resolve to function declaration and compile
        const getFuncNode = resolveExprToFuncNode(ctx, getExpr);
        if (getFuncNode) {
          if (!emitAccessorFn(ctx, fctx, getFuncNode as unknown as ts.FunctionExpression))
            fctx.body.push({ op: "ref.null.extern" });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }

      // Compile setter (host-free closure under standalone, else JS callback;
      // #1888 S5b). `this` is the object the property is assigned on.
      if (setNode) {
        if (!emitAccessorFn(ctx, fctx, setNode as unknown as ts.FunctionExpression))
          fctx.body.push({ op: "ref.null.extern" });
      } else if (setExpr) {
        // set: identifierRef — resolve to function declaration and compile
        const setFuncNode = resolveExprToFuncNode(ctx, setExpr);
        if (setFuncNode) {
          if (!emitAccessorFn(ctx, fctx, setFuncNode as unknown as ts.FunctionExpression))
            fctx.body.push({ op: "ref.null.extern" });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }

      emitRuntimeFlagsF64(
        ctx,
        fctx,
        undefined,
        descEnumerable,
        descConfigurable,
        false,
        undefined,
        accDyn.enumerableDyn,
        accDyn.configurableDyn,
      );

      const accFuncIdx = ensureLateImport(
        ctx,
        "__defineProperty_accessor",
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (accFuncIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: accFuncIdx });
      }
      return { kind: "externref" };
    }

    // Non-accessor path: flag-only descriptor
    // (#1460 R1) Resolve dynamic flag exprs for runtime ToBoolean coercion.
    const flagOnlyDyn = extractDynamicFlagExprs(descArg);

    fctx.body.push({ op: "local.get", index: objLocal });
    // Use extern.convert_any directly (not coerceType) to avoid __make_iterable
    // for vec structs, which would create a new JS array with different identity (#856).
    if (objType.kind === "ref" || objType.kind === "ref_null") {
      fctx.body.push({ op: "extern.convert_any" } as Instr);
    } else if (objType.kind !== "externref") {
      coerceType(ctx, fctx, objType, { kind: "externref" });
    }
    fctx.body.push({ op: "local.get", index: propLocal });
    fctx.body.push({ op: "ref.null.extern" }); // null value
    emitRuntimeFlagsF64(
      ctx,
      fctx,
      descWritable,
      descEnumerable,
      descConfigurable,
      false,
      flagOnlyDyn.writableDyn,
      flagOnlyDyn.enumerableDyn,
      flagOnlyDyn.configurableDyn,
    );

    const funcIdx = ensureLateImport(
      ctx,
      "__defineProperty_value",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }
    return { kind: "externref" };
  }

  // For struct-typed objects, flag-only descriptors are a no-op at runtime
  // (struct fields don't support property attributes)
  const propName = ts.isStringLiteral(propArg) ? propArg.text : undefined;
  if (propName && ts.isObjectLiteralExpression(descArg)) {
    // #1629: treat identifier-reference accessors (get/set: fnRef) as accessor
    // descriptors too, not just inline get/set methods — `isAccessorDesc`
    // includes getExpr/setExpr. #1718's applyDescriptorFlags below preserves
    // omitted writable/enumerable/configurable on partial redefine.
    const isAccessor = isAccessorDesc;
    const varName = ts.isIdentifier(objArg) ? objArg.text : undefined;
    if (varName) {
      const key = `${varName}:${propName}`;
      const trackedExistingFlags = ctx.definedPropertyFlags.get(key);
      const isDefinePropertyWidenedField = ctx.widenedDefinePropertyKeys.has(key);
      const currentFlags =
        trackedExistingFlags ??
        (isKnownStructField && !isDefinePropertyWidenedField ? PROP_FLAGS_DEFAULT_DATA : undefined);
      const newFlags = applyDescriptorFlags(
        currentFlags,
        descWritable,
        descEnumerable,
        descConfigurable,
        isAccessor,
        descWritable !== undefined,
      );
      if (ctx.nonExtensibleVars.has(varName) && currentFlags === undefined) {
        emitThrowString(ctx, fctx, "TypeError: Cannot define property, object is not extensible");
      }
      const existingFlags = currentFlags;
      if (existingFlags !== undefined) {
        const isExistingConfigurable = !!(existingFlags & PROP_FLAG_CONFIGURABLE);
        if (!isExistingConfigurable) {
          if (newFlags & PROP_FLAG_CONFIGURABLE) {
            emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
          }
          if ((existingFlags & PROP_FLAG_ENUMERABLE) !== (newFlags & PROP_FLAG_ENUMERABLE)) {
            emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
          }
          // Data property writable checks (#856)
          if (!(existingFlags & PROP_FLAG_ACCESSOR) && !isAccessor) {
            if (!(existingFlags & PROP_FLAG_WRITABLE)) {
              if (newFlags & PROP_FLAG_WRITABLE) {
                // Cannot change writable from false to true on non-configurable
                emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
              }
            }
          }
          // Cannot change data<->accessor on non-configurable
          if (isAccessor && !(existingFlags & PROP_FLAG_ACCESSOR)) {
            emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
          }
          if (!isAccessor && existingFlags & PROP_FLAG_ACCESSOR) {
            emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
          }
        }
      }
      ctx.definedPropertyFlags.set(key, newFlags);
    }
  }

  fctx.body.push({ op: "local.get", index: objLocal });
  return objType;
}

// ── Object.defineProperties ───────────────────────────────────────────

/**
 * Compile Object.defineProperties(obj, descriptors).
 *
 * Static path: when descriptors is an object literal, iterate each property
 * and synthesize individual Object.defineProperty calls at compile time.
 *
 * Dynamic fallback: delegate to __defineProperties host import.
 */
export function compileObjectDefineProperties(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const objArg = expr.arguments[0]!;
  const descsArg = expr.arguments[1]!;

  // ES spec 19.1.2.3 step 1: throw TypeError if first arg is not an object
  if (emitNonObjectArgGuard(ctx, fctx, objArg, "Object.defineProperties")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }

  // Static path: descriptors is an object literal — expand to individual defineProperty calls.
  // Pre-check: if any inner descriptor is demonstrably malformed (primitive literal, or an
  // object literal mixing data and accessor fields, or non-function get/set), abort the
  // static path and fall through to the dynamic runtime so ToPropertyDescriptor (ECMA-262
  // 10.1) throws TypeError uniformly.
  const isStaticDescWellFormed = (descExpr: ts.Expression): boolean => {
    // Primitive literals (string, number, boolean, null) as the descriptor are
    // spec-violating — ToPropertyDescriptor throws TypeError. Delegate to the
    // dynamic runtime so the TypeError fires uniformly. `undefined` is also
    // spec-violating but we still let static expand handle it (callees know).
    if (
      ts.isStringLiteral(descExpr) ||
      ts.isNoSubstitutionTemplateLiteral(descExpr) ||
      ts.isNumericLiteral(descExpr) ||
      descExpr.kind === ts.SyntaxKind.TrueKeyword ||
      descExpr.kind === ts.SyntaxKind.FalseKeyword ||
      descExpr.kind === ts.SyntaxKind.NullKeyword
    ) {
      return false;
    }
    if (!ts.isObjectLiteralExpression(descExpr)) {
      // Identifier / call / property-access / etc — runtime-resolved but
      // legitimately may be a valid object (as in `{property: Math}` or
      // `{property: descObj}`). Expand statically; Object.defineProperty will
      // handle validation at runtime via its own path.
      return true;
    }
    let hasData = false;
    let hasAccessor = false;
    for (const dp of descExpr.properties) {
      if (ts.isMethodDeclaration(dp) && dp.name && ts.isIdentifier(dp.name)) {
        if (dp.name.text === "get" || dp.name.text === "set") hasAccessor = true;
        continue;
      }
      if (!ts.isPropertyAssignment(dp) || !ts.isIdentifier(dp.name)) continue;
      const k = dp.name.text;
      if (k === "value" || k === "writable") hasData = true;
      if (k === "get" || k === "set") {
        hasAccessor = true;
        const init = dp.initializer;
        const isFn = ts.isFunctionExpression(init) || ts.isArrowFunction(init);
        const isIdLike =
          ts.isIdentifier(init) || ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init);
        const isUndefOrNull =
          init.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(init) && init.text === "undefined");
        if (!isFn && !isIdLike && !isUndefOrNull) return false;
      }
    }
    if (hasData && hasAccessor) return false;
    return true;
  };
  if (ts.isObjectLiteralExpression(descsArg)) {
    let allWellFormed = true;
    for (const prop of descsArg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      if (!isStaticDescWellFormed(prop.initializer)) {
        allWellFormed = false;
        break;
      }
    }
    if (!allWellFormed) {
      // Fall through to dynamic runtime — __defineProperties validates and throws TypeError.
    } else {
      // Compile obj and save to local
      const objType = compileExpression(ctx, fctx, objArg);
      if (!objType) return null;
      const objLocal = allocLocal(fctx, `__defprops_obj_${fctx.locals.length}`, objType);
      fctx.body.push({ op: "local.set", index: objLocal });

      for (const prop of descsArg.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const propName = ts.isIdentifier(prop.name)
          ? prop.name.text
          : ts.isStringLiteral(prop.name)
            ? prop.name.text
            : undefined;
        if (propName === undefined) continue;

        // Synthesize: Object.defineProperty(obj, propName, descriptor)
        const syntheticPropAccess = ts.factory.createPropertyAccessExpression(
          ts.factory.createIdentifier("Object"),
          "defineProperty",
        );
        const syntheticCall = ts.factory.createCallExpression(syntheticPropAccess, undefined, [
          ts.factory.createIdentifier(`__defprops_obj_placeholder_${objLocal}`),
          ts.factory.createStringLiteral(propName),
          prop.initializer,
        ]);
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;

        // Instead of recursing through compileCallExpression (which would need
        // the synthetic identifier to resolve), directly call compileObjectDefineProperty
        // with the obj already on stack via local.get.

        // Build a mini call that reuses our saved obj local:
        // We need to compile the descriptor value per property.
        // The simplest approach: push obj local, then delegate to the externref
        // defineProperty path for each property.
        const descExpr = prop.initializer;

        // Parse the individual descriptor
        let valueExpr: ts.Expression | undefined;
        let descWritable: boolean | undefined;
        let descEnumerable: boolean | undefined;
        let descConfigurable: boolean | undefined;
        let dpGetNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
        let dpSetNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
        let dpGetExpr: ts.Expression | undefined;
        let dpSetExpr: ts.Expression | undefined;

        if (ts.isObjectLiteralExpression(descExpr)) {
          for (const dp of descExpr.properties) {
            if (ts.isPropertyAssignment(dp) && ts.isIdentifier(dp.name)) {
              if (dp.name.text === "value") valueExpr = dp.initializer;
              if (dp.name.text === "writable") {
                // (#1460 R1) Apply ToBoolean via compile-time fold; dynamic values
                // remain undefined here and are resolved at runtime in the externref
                // fallback below via emitRuntimeFlagsF64 + extractDynamicFlagExprs.
                descWritable = tryConstantFoldToBoolean(dp.initializer);
              }
              if (dp.name.text === "enumerable") {
                descEnumerable = tryConstantFoldToBoolean(dp.initializer);
              }
              if (dp.name.text === "configurable") {
                descConfigurable = tryConstantFoldToBoolean(dp.initializer);
              }
              // Accessor: get/set with inline function
              if (dp.name.text === "get") {
                if (ts.isFunctionExpression(dp.initializer) || ts.isArrowFunction(dp.initializer)) {
                  dpGetNode = dp.initializer;
                } else if (
                  !(
                    ts.isIdentifier(dp.initializer) &&
                    (dp.initializer.text === "undefined" || dp.initializer.text === "null")
                  ) &&
                  dp.initializer.kind !== ts.SyntaxKind.NullKeyword
                ) {
                  dpGetExpr = dp.initializer;
                }
              }
              if (dp.name.text === "set") {
                if (ts.isFunctionExpression(dp.initializer) || ts.isArrowFunction(dp.initializer)) {
                  dpSetNode = dp.initializer;
                } else if (
                  !(
                    ts.isIdentifier(dp.initializer) &&
                    (dp.initializer.text === "undefined" || dp.initializer.text === "null")
                  ) &&
                  dp.initializer.kind !== ts.SyntaxKind.NullKeyword
                ) {
                  dpSetExpr = dp.initializer;
                }
              }
            }
            if (ts.isMethodDeclaration(dp) && dp.name && ts.isIdentifier(dp.name)) {
              if (dp.name.text === "get") dpGetNode = dp;
              if (dp.name.text === "set") dpSetNode = dp;
            }
          }
        }

        // Try struct path: if obj is a known struct and propName matches a field
        const objTsType = ctx.checker.getTypeAtLocation(objArg);
        const structName =
          resolveStructName(ctx, objTsType) ||
          (ts.isIdentifier(objArg) ? ctx.widenedVarStructMap.get(objArg.text) : undefined);
        const structTypeIdx = structName ? ctx.structMap.get(structName) : undefined;
        const fields = structName ? ctx.structFields.get(structName) : undefined;
        const fieldIdx = fields && propName ? fields.findIndex((f) => f.name === propName) : -1;

        if (structTypeIdx !== undefined && fields && fieldIdx >= 0 && valueExpr) {
          // Struct path: emit struct.set directly
          const fieldType = fields[fieldIdx]!.type;

          // ── Compile-time flag checking for struct path (#856) ──
          let priorExistingFlags: number | undefined;
          let newFlagsForStructField = applyDescriptorFlags(
            PROP_FLAGS_DEFAULT_DATA,
            descWritable,
            descEnumerable,
            descConfigurable,
            false,
            valueExpr !== undefined || descWritable !== undefined,
          );
          if (ts.isIdentifier(objArg)) {
            const isAccessor = false;
            const key = `${objArg.text}:${propName}`;
            const trackedExistingFlags = ctx.definedPropertyFlags.get(key);
            const isDefinePropertyWidenedField = ctx.widenedDefinePropertyKeys.has(key);
            const currentFlags =
              trackedExistingFlags ?? (!isDefinePropertyWidenedField ? PROP_FLAGS_DEFAULT_DATA : undefined);
            const newFlags = applyDescriptorFlags(
              currentFlags,
              descWritable,
              descEnumerable,
              descConfigurable,
              isAccessor,
              valueExpr !== undefined || descWritable !== undefined,
            );
            newFlagsForStructField = newFlags;
            priorExistingFlags = currentFlags;

            const existingFlags = currentFlags;
            if (existingFlags !== undefined) {
              const isExistingConfigurable = !!(existingFlags & PROP_FLAG_CONFIGURABLE);
              if (!isExistingConfigurable) {
                // Non-configurable: check for violations
                if (newFlags & PROP_FLAG_CONFIGURABLE) {
                  emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
                }
                const existingEnumerable = existingFlags & PROP_FLAG_ENUMERABLE;
                const newEnumerable = newFlags & PROP_FLAG_ENUMERABLE;
                if (existingEnumerable !== newEnumerable) {
                  emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
                }
                // Data property writable checks
                if (!(existingFlags & PROP_FLAG_ACCESSOR) && !isAccessor) {
                  if (!(existingFlags & PROP_FLAG_WRITABLE)) {
                    if (newFlags & PROP_FLAG_WRITABLE) {
                      emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
                    }
                  }
                }
                // Cannot change data<->accessor on non-configurable
                if (isAccessor && !(existingFlags & PROP_FLAG_ACCESSOR)) {
                  emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
                }
                if (!isAccessor && existingFlags & PROP_FLAG_ACCESSOR) {
                  emitThrowString(ctx, fctx, "TypeError: Cannot redefine property");
                }
              }
            }
          }

          // Check if this property is non-writable non-configurable (needs runtime value comparison)
          const needsValueCompare =
            priorExistingFlags !== undefined &&
            !(priorExistingFlags & PROP_FLAG_CONFIGURABLE) &&
            !(priorExistingFlags & PROP_FLAG_WRITABLE) &&
            !(priorExistingFlags & PROP_FLAG_ACCESSOR);

          fctx.body.push({ op: "local.get", index: objLocal });

          // Cast if needed — guard with ref.test to avoid illegal cast traps (#778)
          let needsGuard = false;
          if (objType.kind === "externref") {
            fctx.body.push({ op: "any.convert_extern" } as Instr);
            needsGuard = true;
          } else if (
            (objType.kind === "ref_null" || objType.kind === "ref") &&
            "typeIdx" in objType &&
            objType.typeIdx !== structTypeIdx
          ) {
            needsGuard = true;
          }

          if (needsValueCompare) {
            // Non-writable non-configurable: compare old and new values
            if (needsGuard) {
              // Save as anyref for guarded access
              const defpTmp = allocLocal(fctx, `__defp_tmp_${fctx.locals.length}`, { kind: "anyref" });
              fctx.body.push({ op: "local.set", index: defpTmp } as Instr);

              // Save old value
              const oldValLocal = allocLocal(fctx, `__defps_oldval_${fctx.locals.length}`, fieldType);
              fctx.body.push({ op: "local.get", index: defpTmp } as Instr);
              fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx } as Instr);
              if (fieldType.kind === "f64") {
                fctx.body.push({
                  op: "if",
                  blockType: { kind: "val", type: { kind: "f64" } as ValType },
                  then: [
                    { op: "local.get", index: defpTmp } as Instr,
                    { op: "ref.cast", typeIdx: structTypeIdx } as Instr,
                    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx } as Instr,
                  ],
                  else: [{ op: "f64.const", value: 0 } as Instr],
                } as Instr);
              } else if (fieldType.kind === "i32") {
                fctx.body.push({
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } as ValType },
                  then: [
                    { op: "local.get", index: defpTmp } as Instr,
                    { op: "ref.cast", typeIdx: structTypeIdx } as Instr,
                    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx } as Instr,
                  ],
                  else: [{ op: "i32.const", value: 0 } as Instr],
                } as Instr);
              }
              fctx.body.push({ op: "local.set", index: oldValLocal } as Instr);

              // Compile new value
              const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
              if (valType) {
                const newValLocal = allocLocal(fctx, `__defps_newval_${fctx.locals.length}`, fieldType);
                if (valType.kind !== fieldType.kind) {
                  coerceType(ctx, fctx, valType, fieldType);
                }
                fctx.body.push({ op: "local.set", index: newValLocal } as Instr);

                // Compare values — throw if different
                const tagIdx = ensureExnTag(ctx);
                const errMsg = "TypeError: Cannot redefine property";
                addStringConstantGlobal(ctx, errMsg);
                const errMsgGlobal = ctx.stringGlobalMap.get(errMsg)!;
                if (fieldType.kind === "f64") {
                  fctx.body.push({ op: "local.get", index: oldValLocal });
                  fctx.body.push({ op: "local.get", index: newValLocal });
                  fctx.body.push({ op: "f64.ne" });
                  fctx.body.push({
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "global.get", index: errMsgGlobal } as Instr, { op: "throw", tagIdx } as Instr],
                  });
                } else if (fieldType.kind === "i32") {
                  fctx.body.push({ op: "local.get", index: oldValLocal });
                  fctx.body.push({ op: "local.get", index: newValLocal });
                  fctx.body.push({ op: "i32.ne" });
                  fctx.body.push({
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "global.get", index: errMsgGlobal } as Instr, { op: "throw", tagIdx } as Instr],
                  });
                }

                // Do the struct.set if values match
                fctx.body.push({ op: "local.get", index: defpTmp } as Instr);
                fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx } as Instr);
                fctx.body.push({
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: defpTmp } as Instr,
                    { op: "ref.cast", typeIdx: structTypeIdx } as Instr,
                    { op: "local.get", index: newValLocal } as Instr,
                    { op: "struct.set", typeIdx: structTypeIdx, fieldIdx } as Instr,
                  ],
                  else: [],
                } as Instr);
              }
            } else {
              // Non-guarded: direct struct access
              const oldValLocal = allocLocal(fctx, `__defps_oldval_${fctx.locals.length}`, fieldType);
              fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
              fctx.body.push({ op: "local.set", index: oldValLocal });

              const newValLocal = allocLocal(fctx, `__defps_newval_${fctx.locals.length}`, fieldType);
              const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
              if (valType) {
                if (valType.kind !== fieldType.kind) {
                  coerceType(ctx, fctx, valType, fieldType);
                }
                fctx.body.push({ op: "local.set", index: newValLocal });

                const tagIdx = ensureExnTag(ctx);
                const errMsg = "TypeError: Cannot redefine property";
                addStringConstantGlobal(ctx, errMsg);
                const errMsgGlobal = ctx.stringGlobalMap.get(errMsg)!;
                if (fieldType.kind === "f64") {
                  fctx.body.push({ op: "local.get", index: oldValLocal });
                  fctx.body.push({ op: "local.get", index: newValLocal });
                  fctx.body.push({ op: "f64.ne" });
                  fctx.body.push({
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "global.get", index: errMsgGlobal } as Instr, { op: "throw", tagIdx } as Instr],
                  });
                } else if (fieldType.kind === "i32") {
                  fctx.body.push({ op: "local.get", index: oldValLocal });
                  fctx.body.push({ op: "local.get", index: newValLocal });
                  fctx.body.push({ op: "i32.ne" });
                  fctx.body.push({
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "global.get", index: errMsgGlobal } as Instr, { op: "throw", tagIdx } as Instr],
                  });
                }

                // Do the struct.set
                fctx.body.push({ op: "local.get", index: objLocal });
                fctx.body.push({ op: "local.get", index: newValLocal });
                fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
              } else {
                fctx.body.push({ op: "drop" });
              }
            }
          } else if (needsGuard) {
            // Save obj as anyref, compile value, then guard the struct.set
            const defpTmp = allocLocal(fctx, `__defp_tmp_${fctx.locals.length}`, { kind: "anyref" });
            fctx.body.push({ op: "local.set", index: defpTmp } as Instr);

            // Compile the value expression first (outside the guard)
            const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
            if (valType) {
              const valLocal = allocLocal(fctx, `__defp_val_${fctx.locals.length}`, fieldType);
              if (valType.kind !== fieldType.kind) {
                coerceType(ctx, fctx, valType, fieldType);
              }
              fctx.body.push({ op: "local.set", index: valLocal } as Instr);

              // Now guard the struct.set with ref.test
              fctx.body.push({ op: "local.get", index: defpTmp } as Instr);
              fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx } as Instr);
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: defpTmp } as Instr,
                  { op: "ref.cast", typeIdx: structTypeIdx } as Instr,
                  { op: "local.get", index: valLocal } as Instr,
                  { op: "struct.set", typeIdx: structTypeIdx, fieldIdx } as Instr,
                ],
                else: [],
              } as Instr);
            }
          } else {
            const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
            if (valType) {
              if (valType.kind !== fieldType.kind) {
                coerceType(ctx, fctx, valType, fieldType);
              }
              fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
            } else {
              // No value produced — drop the obj ref
              fctx.body.push({ op: "drop" });
            }
          }

          // Update compile-time flags
          if (ts.isIdentifier(objArg)) {
            const key = `${objArg.text}:${propName}`;
            ctx.definedPropertyFlags.set(key, newFlagsForStructField);
          }

          // Update shapePropFlags
          const userFields = fields
            .map((f, idx) => ({ field: f, fieldIdx: idx }))
            .filter((e) => !e.field.name.startsWith("__"));
          const userFieldIdx = userFields.findIndex((e) => e.fieldIdx === fieldIdx);
          if (userFieldIdx >= 0) {
            const flagsArr = ctx.shapePropFlags.get(structTypeIdx);
            if (flagsArr && userFieldIdx < flagsArr.length) {
              flagsArr[userFieldIdx] = newFlagsForStructField & 0x07; // Only store WEC bits
            }
          }

          continue; // Next property
        }

        // Externref fallback
        const dpIsAccessor = !!(dpGetNode || dpSetNode || dpGetExpr || dpSetExpr);
        // Use extern.convert_any directly (not coerceType) to avoid __make_iterable
        // for vec structs, which would create a new JS array with different identity (#856/#1092).
        fctx.body.push({ op: "local.get", index: objLocal });
        if (objType.kind === "ref" || objType.kind === "ref_null") {
          fctx.body.push({ op: "extern.convert_any" } as Instr);
        } else if (objType.kind !== "externref") {
          coerceType(ctx, fctx, objType, { kind: "externref" });
        }
        const objExtLocal = allocLocal(fctx, `__defprops_ext_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: objExtLocal });

        if (dpIsAccessor) {
          // Accessor descriptor: emit __defineProperty_accessor
          // (#1460 R1) Extract dynamic flag exprs for runtime ToBoolean.
          const dpAccDyn = ts.isObjectLiteralExpression(descExpr)
            ? extractDynamicFlagExprs(descExpr)
            : ({} as ReturnType<typeof extractDynamicFlagExprs>);
          fctx.body.push({ op: "local.get", index: objExtLocal });
          compileExpression(ctx, fctx, ts.factory.createStringLiteral(propName), { kind: "externref" });

          // Compile getter (host-free closure under standalone, else JS callback; #1888 S5b)
          if (dpGetNode) {
            if (!emitAccessorFn(ctx, fctx, dpGetNode as unknown as ts.FunctionExpression))
              fctx.body.push({ op: "ref.null.extern" });
          } else if (dpGetExpr) {
            const gFuncNode = resolveExprToFuncNode(ctx, dpGetExpr);
            if (gFuncNode) {
              if (!emitAccessorFn(ctx, fctx, gFuncNode as unknown as ts.FunctionExpression))
                fctx.body.push({ op: "ref.null.extern" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }

          // Compile setter (host-free closure under standalone, else JS callback; #1888 S5b)
          if (dpSetNode) {
            if (!emitAccessorFn(ctx, fctx, dpSetNode as unknown as ts.FunctionExpression))
              fctx.body.push({ op: "ref.null.extern" });
          } else if (dpSetExpr) {
            const sFuncNode = resolveExprToFuncNode(ctx, dpSetExpr);
            if (sFuncNode) {
              if (!emitAccessorFn(ctx, fctx, sFuncNode as unknown as ts.FunctionExpression))
                fctx.body.push({ op: "ref.null.extern" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }

          emitRuntimeFlagsF64(
            ctx,
            fctx,
            undefined,
            descEnumerable,
            descConfigurable,
            false,
            undefined,
            dpAccDyn.enumerableDyn,
            dpAccDyn.configurableDyn,
          );
          const accIdx = ensureLateImport(
            ctx,
            "__defineProperty_accessor",
            [
              { kind: "externref" },
              { kind: "externref" },
              { kind: "externref" },
              { kind: "externref" },
              { kind: "f64" },
            ],
            [{ kind: "externref" }],
          );
          flushLateImportShifts(ctx, fctx);
          if (accIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: accIdx });
            fctx.body.push({ op: "drop" });
          }

          if (ts.isIdentifier(objArg)) {
            const isAccessor = true;
            const key = `${objArg.text}:${propName}`;
            const newFlags = applyDescriptorFlags(
              ctx.definedPropertyFlags.get(key),
              descWritable,
              descEnumerable,
              descConfigurable,
              isAccessor,
              false,
            );
            ctx.definedPropertyFlags.set(key, newFlags);
          }
        } else {
          // Value/flags descriptor: emit __defineProperty_value
          // Push prop name as string
          fctx.body.push({ op: "local.get", index: objExtLocal });
          compileExpression(ctx, fctx, ts.factory.createStringLiteral(propName), { kind: "externref" });

          // Compile value or push null
          if (valueExpr) {
            const vt = compileExpression(ctx, fctx, valueExpr, { kind: "externref" });
            if (vt && vt.kind !== "externref") {
              coerceType(ctx, fctx, vt, { kind: "externref" });
            } else if (!vt) {
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }

          // Runtime flags (#1460 R1: ToBoolean coercion on dynamic flag exprs)
          const dpValDyn = ts.isObjectLiteralExpression(descExpr)
            ? extractDynamicFlagExprs(descExpr)
            : ({} as ReturnType<typeof extractDynamicFlagExprs>);
          emitRuntimeFlagsF64(
            ctx,
            fctx,
            descWritable,
            descEnumerable,
            descConfigurable,
            !!valueExpr,
            dpValDyn.writableDyn,
            dpValDyn.enumerableDyn,
            dpValDyn.configurableDyn,
          );

          const funcIdx = ensureLateImport(
            ctx,
            "__defineProperty_value",
            [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
            [{ kind: "externref" }],
          );
          flushLateImportShifts(ctx, fctx);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            fctx.body.push({ op: "drop" }); // drop returned obj (we use our local)
          }

          // Update compile-time flags for externref path
          if (ts.isIdentifier(objArg)) {
            const isAccessor = false;
            const key = `${objArg.text}:${propName}`;
            const newFlags = applyDescriptorFlags(
              ctx.definedPropertyFlags.get(key),
              descWritable,
              descEnumerable,
              descConfigurable,
              isAccessor,
              valueExpr !== undefined || descWritable !== undefined,
            );
            ctx.definedPropertyFlags.set(key, newFlags);
          }
        }
      }

      // Return obj
      fctx.body.push({ op: "local.get", index: objLocal });
      return objType;
    }
  }

  // Dynamic fallback: delegate to __defineProperties host import
  const objType = compileExpression(ctx, fctx, objArg);
  if (!objType) return null;
  // Use extern.convert_any directly (not coerceType) to avoid __make_iterable
  // for vec structs, which would create a new JS array with different identity (#856/#1092).
  if (objType.kind === "ref" || objType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" } as Instr);
  } else if (objType.kind !== "externref") {
    coerceType(ctx, fctx, objType, { kind: "externref" });
  }
  const descsType = compileExpression(ctx, fctx, descsArg, { kind: "externref" });
  if (!descsType) {
    return { kind: "externref" };
  }
  if (descsType.kind !== "externref") {
    coerceType(ctx, fctx, descsType, { kind: "externref" });
  }

  const funcIdx = ensureLateImport(
    ctx,
    "__defineProperties",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (funcIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx });
  }
  return { kind: "externref" };
}

// ── Object.keys / Object.values ───────────────────────────────────────

/**
 * Compile Object.keys(obj) or Object.values(obj) by expanding struct fields
 * at compile time. Object.keys returns a string[] of field names,
 * Object.values returns an array of the field values.
 */
export function compileObjectKeysOrValues(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: string,
  expr: ts.CallExpression,
): ValType | null {
  const arg = expr.arguments[0]!;
  const argType = ctx.checker.getTypeAtLocation(arg);

  // Resolve struct name from the argument type
  const structName = resolveStructName(ctx, argType);
  if (!structName) {
    // Check if the type is an empty object literal (not any/unknown) — if so,
    // compile away to an empty array since there's nothing to enumerate.
    const isAnyOrUnknown = (argType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const tsProps = argType.getProperties?.();
    if (!isAnyOrUnknown && tsProps && tsProps.length === 0) {
      const argResult = compileExpression(ctx, fctx, arg);
      if (argResult) {
        fctx.body.push({ op: "drop" });
      }
      const elemKind = "externref";
      const vecTypeIdx = getOrRegisterVecType(ctx, elemKind);
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) return null;
      fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: 0 });
      const tmpData = allocLocal(fctx, `__obj_${method}_empty_data_${fctx.locals.length}`, {
        kind: "ref",
        typeIdx: arrTypeIdx,
      });
      fctx.body.push({ op: "local.set", index: tmpData });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.get", index: tmpData });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    // Non-struct argument (any, externref, etc.) — delegate to host import
    // which calls the real JS Object.keys/values/entries at runtime.
    // The host import uses __struct_field_names + __sget_* for WasmGC structs.
    // Returns externref (a JS array) which the coercion layer converts to a
    // WasmGC vec when stored in a typed variable (e.g., const keys = ...).
    const argResult = compileExpression(ctx, fctx, arg);
    if (!argResult) return null;
    // Coerce to externref if needed
    if (argResult.kind !== "externref") {
      coerceType(ctx, fctx, argResult, { kind: "externref" });
    }
    const importName = `__object_${method}`;
    const funcIdx = ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
    // Fallback: drop arg, push null externref
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    return { kind: "externref" };
  }

  const structTypeIdx = ctx.structMap.get(structName);
  const fields = ctx.structFields.get(structName);
  if (structTypeIdx === undefined || !fields) {
    reportError(ctx, expr, `Object.${method}(): unknown struct "${structName}"`);
    return null;
  }

  // Filter out internal fields like __tag
  const userFields = fields
    .map((f, idx) => ({ field: f, fieldIdx: idx }))
    .filter((e) => !e.field.name.startsWith("__"));

  // Per ES spec, keys/values/entries only include enumerable own properties.
  // definedPropertyFlags is keyed as "varName:propName" and updated at compile time
  // by Object.defineProperty calls. shapePropFlags is initialized with defaults after
  // compilation, so it won't reflect defineProperty updates during this pass.
  const argVarName = ts.isIdentifier(arg) ? arg.text : undefined;
  const enumUserFields = userFields.filter((e) => {
    if (argVarName) {
      const key = `${argVarName}:${e.field.name}`;
      const flags = ctx.definedPropertyFlags.get(key);
      if (flags !== undefined) {
        return !!(flags & PROP_FLAG_ENUMERABLE);
      }
    }
    return true; // no explicit descriptor = enumerable by default
  });

  if (method === "keys") {
    // Build a string[] array from the field names
    // Each field name is already registered as a string literal thunk
    const elemKind = "externref";
    const vecTypeIdx = getOrRegisterVecType(ctx, elemKind);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) {
      reportError(ctx, expr, `Object.keys(): cannot resolve array type for string[]`);
      return null;
    }

    // Push each enumerable field name string onto the stack
    for (const entry of enumUserFields) {
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        compileNativeStringLiteral(ctx, fctx, entry.field.name);
        // Object.keys returns externref strings, convert from native
        fctx.body.push({ op: "extern.convert_any" });
      } else {
        // compileStringLiteral handles late registration when the field name
        // was not collected in the first pass (e.g. dynamically-added own
        // properties). Without it, an unregistered name pushed nothing and
        // array.new_fixed below underflowed the stack (#786).
        compileStringLiteral(ctx, fctx, entry.field.name, expr);
      }
    }

    // Create the backing array with array.new_fixed
    const count = enumUserFields.length;
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: count });
    const tmpData = allocLocal(fctx, `__obj_keys_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: count });
    fctx.body.push({ op: "local.get", index: tmpData });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  if (method === "entries") {
    // Build [string, T][] by resolving the TS return type to get the correct
    // tuple struct and vec types that match what resolveWasmType produces.
    const argResult = compileExpression(ctx, fctx, arg);
    if (!argResult) return null;
    const objLocal = allocLocal(fctx, `__obj_entries_src_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: structTypeIdx,
    });
    fctx.body.push({ op: "local.set", index: objLocal });
    emitObjectArgNullGuard(ctx, fctx, objLocal);

    // Resolve the return type from the TS signature to get proper tuple/vec types
    const sig = ctx.checker.getResolvedSignature(expr);
    const retType = sig ? ctx.checker.getReturnTypeOfSignature(sig) : undefined;
    const resolvedRet = retType ? resolveWasmType(ctx, retType) : undefined;

    // The return type should be ref_null to a vec struct (Array<[string, T]>)
    // Extract the vec type index and from it the array type index and entry tuple type
    let outerVecTypeIdx: number;
    let outerArrTypeIdx: number;
    let entryTupleTypeIdx: number;

    if (resolvedRet && (resolvedRet.kind === "ref" || resolvedRet.kind === "ref_null") && "typeIdx" in resolvedRet) {
      outerVecTypeIdx = resolvedRet.typeIdx;
      outerArrTypeIdx = getArrTypeIdxFromVec(ctx, outerVecTypeIdx);
      // The array element type is a ref to the tuple struct
      // Get it from the vec's array type definition
      const arrTypeDef = ctx.mod.types[outerArrTypeIdx];
      if (
        arrTypeDef &&
        arrTypeDef.kind === "array" &&
        (arrTypeDef as any).element &&
        ((arrTypeDef as any).element.kind === "ref" || (arrTypeDef as any).element.kind === "ref_null")
      ) {
        entryTupleTypeIdx = (arrTypeDef as any).element.typeIdx;
      } else {
        // Fallback: create a tuple with [externref, externref]
        entryTupleTypeIdx = getOrRegisterTupleType(ctx, [{ kind: "externref" }, { kind: "externref" }]);
      }
    } else {
      // Fallback: create externref-based types
      entryTupleTypeIdx = getOrRegisterTupleType(ctx, [{ kind: "externref" }, { kind: "externref" }]);
      const entryElemKind = `ref_${entryTupleTypeIdx}`;
      outerVecTypeIdx = getOrRegisterVecType(ctx, entryElemKind, { kind: "ref", typeIdx: entryTupleTypeIdx });
      outerArrTypeIdx = getArrTypeIdxFromVec(ctx, outerVecTypeIdx);
    }

    if (outerArrTypeIdx < 0) {
      reportError(ctx, expr, `Object.entries(): cannot resolve outer array type`);
      return null;
    }

    // Get the tuple struct fields to know the value type
    const tupleTypeDef = ctx.mod.types[entryTupleTypeIdx];
    const tupleFields = tupleTypeDef && tupleTypeDef.kind === "struct" ? (tupleTypeDef as any).fields : undefined;
    // Field 0 is the key (string), field 1 is the value
    const valueFieldType: ValType | undefined = tupleFields?.[1]?.type;

    // Ensure union boxing imports are registered (needed for boxing primitives)
    addUnionImports(ctx);

    // For each enumerable field, create a tuple struct [key, value]
    for (const entry of enumUserFields) {
      // Push key string (field 0 of tuple)
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        compileNativeStringLiteral(ctx, fctx, entry.field.name);
        // If tuple expects externref for the key, convert
        if (tupleFields && tupleFields[0]?.type?.kind === "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        }
      } else {
        // Late-register unregistered field names so nothing underflows the
        // tuple/array construction below (#786).
        compileStringLiteral(ctx, fctx, entry.field.name, expr);
      }

      // Push value (field 1 of tuple)
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: entry.fieldIdx });

      // Coerce the struct field value to match the tuple's value field type
      const fieldKind = entry.field.type.kind;
      const targetKind = valueFieldType?.kind ?? "externref";

      if (targetKind === "externref") {
        // Box primitives to externref
        if (fieldKind === "f64") {
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
        } else if (fieldKind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
        } else if (fieldKind === "ref" || fieldKind === "ref_null") {
          fctx.body.push({ op: "extern.convert_any" });
        }
      }
      // If target is f64 and field is f64, no conversion needed
      // If target is i32 and field is i32, no conversion needed

      // Create tuple struct
      fctx.body.push({ op: "struct.new", typeIdx: entryTupleTypeIdx });
    }

    // Create outer array from the entry tuples on the stack
    const count = enumUserFields.length;
    fctx.body.push({ op: "array.new_fixed", typeIdx: outerArrTypeIdx, length: count });
    const outerData = allocLocal(fctx, `__obj_entries_data_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: outerArrTypeIdx,
    });
    fctx.body.push({ op: "local.set", index: outerData });
    fctx.body.push({ op: "i32.const", value: count });
    fctx.body.push({ op: "local.get", index: outerData });
    fctx.body.push({ op: "struct.new", typeIdx: outerVecTypeIdx });
    return { kind: "ref_null", typeIdx: outerVecTypeIdx };
  }

  // method === "values"
  // Compile the argument expression, store in a local, then struct.get each field
  const argResult = compileExpression(ctx, fctx, arg);
  if (!argResult) return null;
  const objLocal = allocLocal(fctx, `__obj_vals_src_${fctx.locals.length}`, { kind: "ref", typeIdx: structTypeIdx });
  fctx.body.push({ op: "local.set", index: objLocal });
  emitObjectArgNullGuard(ctx, fctx, objLocal);

  // Always use externref elements for Object.values() since the TS return type is any[]
  const elemKind = "externref";
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKind);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    reportError(ctx, expr, `Object.values(): cannot resolve array type for values[]`);
    return null;
  }

  // Ensure union boxing imports are registered (needed for boxing primitives)
  addUnionImports(ctx);

  // Push each enumerable field value onto the stack, boxing primitives to externref
  for (const entry of enumUserFields) {
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: entry.fieldIdx });
    // Box primitive values to externref
    if (entry.field.type.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      }
    } else if (entry.field.type.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      }
    } else if (entry.field.type.kind === "ref" || entry.field.type.kind === "ref_null") {
      // Convert GC ref types (nested structs, etc.) to externref
      fctx.body.push({ op: "extern.convert_any" });
    }
    // externref fields (strings, etc.) don't need boxing
  }

  // Create the backing array with array.new_fixed
  const count = enumUserFields.length;
  fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: count });
  const tmpData = allocLocal(fctx, `__obj_vals_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: tmpData });
  fctx.body.push({ op: "i32.const", value: count });
  fctx.body.push({ op: "local.get", index: tmpData });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * Compile obj.hasOwnProperty(key) / obj.propertyIsEnumerable(key).
 * For WasmGC structs all own fields are enumerable, so both methods behave
 * identically: return true iff `key` names an own field of the struct type.
 *
 * Static resolution (string literal arg): constant fold to i32.const 0/1.
 * Dynamic resolution: runtime string comparison against known field names.
 */
export function compilePropertyIntrospection(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  expr: ts.CallExpression,
): InnerResult {
  const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  const receiverWasm = resolveWasmType(ctx, receiverType);

  // For externref/any receivers (e.g. Object.create result), delegate to runtime
  // since we can't statically know their properties
  if (receiverWasm.kind === "externref") {
    const isHOP = propAccess.name.text === "hasOwnProperty";
    const importName = isHOP ? "__hasOwnProperty" : "__propertyIsEnumerable";
    const hopIdx = ensureLateImport(ctx, importName, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx);
    if (hopIdx !== undefined) {
      // Push receiver
      compileExpression(ctx, fctx, propAccess.expression);
      // Push key argument (or null if missing)
      if (expr.arguments[0]) {
        const argType = compileExpression(ctx, fctx, expr.arguments[0]);
        if (argType && argType.kind !== "externref") {
          coerceType(ctx, fctx, argType, { kind: "externref" });
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: hopIdx });
      return { kind: "i32", boolean: true };
    }
  }

  // Build a set of private member names (without '#') from the TS type.
  // Private fields (#x) are stored in the struct with the '#' stripped, but
  // should never be reported as own properties via hasOwnProperty("x").
  const privateNames = new Set<string>();
  for (const prop of receiverType.getProperties()) {
    if (prop.name.startsWith("#")) {
      privateNames.add(prop.name.slice(1));
    }
  }

  // Collect struct field names from the Wasm struct definition, excluding:
  // - Internal fields (e.g. __tag) that are compiler-generated
  // - Fields that correspond to private members (#-prefixed in TS source)
  let structFieldNames: string[] | null = null;
  if (receiverWasm.kind === "ref" || receiverWasm.kind === "ref_null") {
    const structDef = ctx.mod.types[(receiverWasm as { typeIdx: number }).typeIdx];
    if (structDef?.kind === "struct") {
      structFieldNames = structDef.fields
        .map((f) => f.name)
        .filter((n): n is string => n !== undefined && !n.startsWith("__") && !privateNames.has(n));
    }
  }

  // Detect if receiver is a prototype object (e.g. C.prototype) vs an instance
  // vs a class constructor.  Each has different "own" property semantics:
  //   - Prototype:   methods + accessors are own; instance fields are NOT
  //   - Instance:    instance fields are own; methods are NOT (they're on prototype)
  //   - Constructor: static members are own; instance members are NOT
  const isPrototypeReceiver =
    ts.isPropertyAccessExpression(propAccess.expression) && propAccess.expression.name.text === "prototype";

  // A constructor type (typeof C) has construct signatures; an instance does not.
  const isConstructorReceiver = !isPrototypeReceiver && receiverType.getConstructSignatures().length > 0;

  // For prototype/constructor receivers, the struct definition represents the
  // instance layout — its fields are NOT own properties of the prototype or
  // constructor object.  Clear structFieldNames so only tsProps drives the result.
  if (isPrototypeReceiver || isConstructorReceiver) {
    structFieldNames = null;
  }

  // Collect own properties from the TypeScript type system.
  // Filtering depends on what kind of object the receiver is.
  const tsProps = new Set<string>();
  const nonEnumerableTsProps = new Set<string>();
  for (const prop of receiverType.getProperties()) {
    // Skip private identifiers — they start with '#' and can't be matched by string keys
    if (prop.name.startsWith("#")) continue;

    const decls = prop.getDeclarations();
    const isMethod =
      decls && decls.length > 0 && decls.every((d) => ts.isMethodDeclaration(d) || ts.isMethodSignature(d));
    const isAccessor =
      decls && decls.length > 0 && decls.every((d) => ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d));

    if (isPrototypeReceiver) {
      // On C.prototype: only methods and accessors are own properties.
      // Instance data fields are NOT on the prototype (set in constructor).
      if (!isMethod && !isAccessor) continue;
      nonEnumerableTsProps.add(prop.name);
    } else if (isConstructorReceiver) {
      // On the constructor (typeof C): only static members are own.
      if (decls && decls.length > 0) {
        const hasStatic = decls.some((d) =>
          ts.canHaveModifiers(d)
            ? (ts.getModifiers(d as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)
            : false,
        );
        if (!hasStatic) continue;
      }
      if (isMethod || isAccessor) nonEnumerableTsProps.add(prop.name);
    } else {
      // On an instance: skip methods and accessors — they live on the prototype.
      if (isMethod || isAccessor) continue;
    }

    tsProps.add(prop.name);
  }

  // Add synthetic own properties for callable types (functions/constructors).
  // ES spec: all functions have own "length" and "name" properties.
  // Non-arrow functions also have "prototype" as an own property.
  const callSigs = receiverType.getCallSignatures();
  const constructSigs = receiverType.getConstructSignatures();
  if (callSigs.length > 0 || constructSigs.length > 0) {
    tsProps.add("length");
    tsProps.add("name");
    // Constructors and non-arrow functions have "prototype"
    if (constructSigs.length > 0) {
      tsProps.add("prototype");
    }
    // Check if receiver is a class — classes always have "prototype"
    const symbol = receiverType.getSymbol();
    if (symbol && symbol.flags & ts.SymbolFlags.Class) {
      tsProps.add("prototype");
    }
  }

  // Get the first argument (the property name to check)
  const arg = expr.arguments[0];
  if (!arg) {
    // No argument — hasOwnProperty() with no args returns false in JS
    // Compile receiver for side effects
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    if (recvType) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32", boolean: true };
  }

  // Try to resolve the key at compile time
  let staticKey: string | null = null;
  if (ts.isStringLiteral(arg)) {
    staticKey = arg.text;
  } else if (ts.isNumericLiteral(arg)) {
    staticKey = arg.text;
  } else {
    // Check if TS can resolve the type to a string literal
    const argTsType = ctx.checker.getTypeAtLocation(arg);
    if (argTsType.isStringLiteral()) {
      staticKey = argTsType.value;
    }
  }

  const isPropertyIsEnumerable = propAccess.name.text === "propertyIsEnumerable";

  if (staticKey !== null) {
    // Static resolution: check if the key is a known own property
    const hasInStruct = structFieldNames !== null && structFieldNames.includes(staticKey);
    const hasInTs = tsProps.has(staticKey);
    const has = hasInStruct || hasInTs;

    // (#1334) If `Object.defineProperty` has been called on this variable
    // for any property — or `delete` could have removed a struct field via
    // the runtime tombstone (any time the struct shape includes the queried
    // key) — the compile-time answer can disagree with the runtime state.
    // Route through the runtime helper so the tombstone (`__delete_property`
    // path) and any sidecar accessor entries are consulted.
    //
    // The signal we use is `ctx.definedPropertyFlags`: it's populated only
    // when `Object.defineProperty` is statically observed, so we only pay
    // the runtime call cost on objects that have actually been mutated.
    // Anonymous receivers (e.g. `({}).hasOwnProperty(...)`) skip this path.
    const recvVarName = ts.isIdentifier(propAccess.expression) ? propAccess.expression.text : undefined;
    let needsRuntime = false;
    if (recvVarName) {
      // Cheap pre-check: if any defineProperty entry exists for this var,
      // the runtime tombstone / descriptor map could differ from the static
      // shape answer. Bail to the runtime path.
      for (const k of ctx.definedPropertyFlags.keys()) {
        if (k.startsWith(`${recvVarName}:`)) {
          needsRuntime = true;
          break;
        }
      }
    }

    if (needsRuntime && (receiverWasm.kind === "ref" || receiverWasm.kind === "ref_null")) {
      // Coerce the struct receiver to externref and dispatch to the runtime
      // helper. Mirrors the externref branch above (line 2393).
      const importName = isPropertyIsEnumerable ? "__propertyIsEnumerable" : "__hasOwnProperty";
      const hopIdx = ensureLateImport(
        ctx,
        importName,
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (hopIdx !== undefined) {
        const recvType = compileExpression(ctx, fctx, propAccess.expression);
        if (recvType && (recvType.kind === "ref" || recvType.kind === "ref_null")) {
          fctx.body.push({ op: "extern.convert_any" } as Instr);
        } else if (recvType && recvType.kind !== "externref") {
          coerceType(ctx, fctx, recvType, { kind: "externref" });
        }
        const argType = compileExpression(ctx, fctx, arg);
        if (argType && argType.kind !== "externref") {
          coerceType(ctx, fctx, argType, { kind: "externref" });
        }
        fctx.body.push({ op: "call", funcIdx: hopIdx });
        return { kind: "i32", boolean: true };
      }
    }

    // For propertyIsEnumerable, also check definedPropertyFlags for updated enumerability.
    // definedPropertyFlags is keyed as "varName:propName" and is the authoritative source
    // for compile-time flag updates from Object.defineProperty calls.
    let result = has ? 1 : 0;
    if (isPropertyIsEnumerable && has) {
      if (recvVarName) {
        const key = `${recvVarName}:${staticKey}`;
        const flags = ctx.definedPropertyFlags.get(key);
        if (flags !== undefined) {
          result = flags & PROP_FLAG_ENUMERABLE ? 1 : 0;
        } else if (nonEnumerableTsProps.has(staticKey)) {
          result = 0;
        }
      } else if (nonEnumerableTsProps.has(staticKey)) {
        result = 0;
      }
    }

    // Compile receiver and argument for side effects, then drop
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    if (recvType) {
      fctx.body.push({ op: "drop" });
    }
    const argResultType = compileExpression(ctx, fctx, arg);
    if (argResultType) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: result });
    return { kind: "i32", boolean: true };
  }

  // Dynamic key: runtime string comparison against known field names
  const allFieldNames = new Set<string>();
  if (structFieldNames) {
    for (const f of structFieldNames) allFieldNames.add(f);
  }
  for (const p of tsProps) allFieldNames.add(p);

  const comparableFieldNames = isPropertyIsEnumerable
    ? new Set([...allFieldNames].filter((name) => !nonEnumerableTsProps.has(name)))
    : allFieldNames;

  if (comparableFieldNames.size > 0) {
    // Ensure all field name strings are registered as globals
    for (const fieldName of comparableFieldNames) {
      if (!ctx.stringGlobalMap.has(fieldName)) {
        addStringConstantGlobal(ctx, fieldName);
      }
    }

    // Compile receiver for side effects, drop it
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    if (recvType) {
      fctx.body.push({ op: "drop" });
    }

    // Compile the key argument
    const keyType = compileExpression(ctx, fctx, arg);
    if (keyType) {
      const equalsIdx = ctx.funcMap.get("__str_eq") ?? ctx.funcMap.get("string_equals");
      const jsStrEquals = ctx.mod.imports.findIndex((imp) => imp.module === "wasm:js-string" && imp.name === "equals");
      const eqFunc = jsStrEquals >= 0 ? jsStrEquals : equalsIdx;
      if (eqFunc !== undefined && eqFunc >= 0) {
        const keyLocal = allocLocal(fctx, `__hop_key_${fctx.locals.length}`, keyType);
        fctx.body.push({ op: "local.set", index: keyLocal });
        // Start with false (0)
        fctx.body.push({ op: "i32.const", value: 0 });
        for (const fieldName of comparableFieldNames) {
          const strGlobal = ctx.stringGlobalMap.get(fieldName);
          if (strGlobal !== undefined) {
            fctx.body.push({ op: "local.get", index: keyLocal });
            fctx.body.push({ op: "global.get", index: strGlobal });
            fctx.body.push({ op: "call", funcIdx: eqFunc });
            fctx.body.push({ op: "i32.or" });
          }
        }
        return { kind: "i32", boolean: true };
      }
    }
  }

  // Fallback: compile both sides for side effects, return false
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType) {
    fctx.body.push({ op: "drop" });
  }
  const argResultType = compileExpression(ctx, fctx, arg);
  if (argResultType) {
    fctx.body.push({ op: "drop" });
  }
  fctx.body.push({ op: "i32.const", value: 0 });
  return { kind: "i32", boolean: true };
}
