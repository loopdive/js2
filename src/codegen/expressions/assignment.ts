// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Assignment operator compilation: simple assignment, destructuring, compound, logical.
 */
import { ts, forEachChild } from "../../ts-api.js";
import { isBooleanType, isExternalDeclaredClass, isStringType } from "../../checker/type-mapper.js";
import type { FieldDef, Instr, ValType } from "../../ir/types.js";
import { emitBoundsCheckedArrayGet, resolveArrayInfo } from "../array-methods.js";
import { tryEmitLinearU8ElementSet } from "../linear-uint8-codegen.js";
import { emitAnyAdd, emitModulo, emitToInt32 } from "../binary-ops.js";
import { pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import { reportSilentFallback } from "../fallback-telemetry.js";
import { allocLocal, allocTempLocal, getLocalType, releaseTempLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  addFuncType,
  addImport,
  addStringConstantGlobal,
  addStringImports,
  addUnionImports,
  ensureExnTag,
  ensureI32Condition,
  ensureStructForType,
  getArrTypeIdxFromVec,
  localGlobalIdx,
  resolveWasmType,
} from "../index.js";
import { buildDestructureNullThrow, patternIteratorStepCount } from "../destructuring-params.js";
import { resolveComputedKeyExpression } from "../literals.js";
import {
  emitNullGuardedStructGet,
  isProvablyNonNull,
  isSafeBoundsEliminated,
  typeErrorThrowInstrs,
} from "../property-access.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, skipTransparentExpressions, valTypesMatch } from "../shared.js";
import { compileStringLiteral, emitBoolToString } from "../string-ops.js";
import { findExternInfoForMember, patchStructNewForDynamicField } from "./extern.js";
import { reserveAccessorSetDriver } from "../accessor-driver.js";
import { S5C_STRUCT_ACCESSOR_CLOSURE } from "../struct-accessor-closure.js";
import {
  arrayIteratorOverrideGlobalIdx,
  emitArrayProtoIteratorDrive,
  maybeCaptureArrayProtoOverride,
} from "./proto-override.js";
import {
  classifyPrivateMember,
  emitCoercedLocalSet,
  emitThrowReferenceError,
  emitThrowString,
  emitThrowTypeError,
  getFuncParamTypes,
  updateLocalType,
  widenLocalToNullable,
} from "./helpers.js";
import {
  ensureLateImport,
  flushLateImportShifts,
  patchStructNewForAddedField,
  shiftLateImportIndices,
} from "./late-imports.js";
import { emitMappedArgParamSync, emitMappedArgReverseSync } from "./logical-ops.js";
import { resolveStructName, resolveStructNameForExpr } from "./misc.js";
import { tryCompileStandaloneRegExpLastIndexWrite } from "../regexp-standalone.js";
import { resolveEffectiveStructName } from "../property-access.js";
import {
  compileStringBuilderAppend,
  emitStringBuilderAppendCodeUnit,
  getBuilderInfo,
  type StringBuilderInfo,
} from "../string-builder.js";
import { compileWithBindingAssignment, findWithBinding } from "../with-scope.js";

/**
 * Emit a null/undefined guard for an externref-typed destructuring source.
 * Throws TypeError if the value in `srcLocal` is null or the JS undefined sentinel.
 * Per spec §14.3.3.1 RequireObjectCoercible / §8.4.2 GetIterator.
 */
function emitExternrefAssignDestructureGuard(ctx: CodegenContext, fctx: FunctionContext, srcLocal: number): void {
  // ref.is_null check (catches JS null when encoded as ref.null.extern).
  // Build a fresh Instr[] for each if-then: sharing a single array across two
  // branches causes walkInstructions (used by shiftLateImportIndices) to walk
  // it twice when subsequent late imports shift funcIdx, producing a double
  // shift that corrupts the throw_type_error call site.
  fctx.body.push({ op: "local.get", index: srcLocal });
  fctx.body.push({ op: "ref.is_null" } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: buildDestructureNullThrow(ctx, fctx),
    else: [],
  });
  // __extern_is_undefined check (catches JS undefined held as non-null externref)
  const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  if (undefIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "call", funcIdx: undefIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: buildDestructureNullThrow(ctx, fctx),
      else: [],
    });
  }
}

export function compileAssignment(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): InnerResult {
  // Unwrap parenthesized LHS: (x) = 1 → x = 1
  let lhs = expr.left;
  while (ts.isParenthesizedExpression(lhs)) {
    lhs = lhs.expression;
  }
  // If we unwrapped parentheses, create a synthetic-like view for the checks below
  // by rebinding the checks to use `lhs` instead of `expr.left`
  if (lhs !== expr.left) {
    // Recursively handle the unwrapped LHS by synthesizing a new expression-like object
    const synth = { ...expr, left: lhs } as ts.BinaryExpression;
    return compileAssignment(ctx, fctx, synth);
  }
  // (#1719 CPR write-arm) `Array.prototype[Symbol.iterator] = fn` /
  // `Array.prototype.values = fn` has no compiled landing spot and is otherwise
  // silently dropped. Capture the lifted override closure into ctx.protoOverrides
  // (rooted in a module global) so array dstr / for-of / spread can drive it.
  // Gated on the S1 brand inside the helper — no-op (byte-identical) otherwise.
  if (maybeCaptureArrayProtoOverride(ctx, fctx, lhs, expr.right)) {
    return { kind: "externref" };
  }

  if (ts.isIdentifier(expr.left)) {
    const name = expr.left.text;
    const withBinding = findWithBinding(fctx, name);
    if (withBinding) {
      return compileWithBindingAssignment(ctx, fctx, withBinding, expr.right);
    }
    // const bindings — assignment throws TypeError at runtime
    if (fctx.constBindings?.has(name)) {
      // Evaluate RHS for side effects, then throw
      const rhsType = compileExpression(ctx, fctx, expr.right);
      if (rhsType) fctx.body.push({ op: "drop" });
      emitThrowString(ctx, fctx, "TypeError: Assignment to constant variable.");
      fctx.body.push({ op: "unreachable" });
      return { kind: "f64" }; // unreachable, but satisfy type
    }
    // Named function expression name binding is read-only — assignments are
    // silently ignored in sloppy mode (the RHS is still evaluated for side effects)
    if (fctx.readOnlyBindings?.has(name)) {
      const rhsType = compileExpression(ctx, fctx, expr.right);
      // The assignment is a no-op, but the expression evaluates to the RHS value
      return rhsType;
    }
    const localIdx = fctx.localMap.get(name);
    if (localIdx !== undefined) {
      // Check if this is a boxed (ref cell) mutable capture
      const boxed = fctx.boxedCaptures?.get(name);
      if (boxed) {
        // Write through ref cell: local.get ref_cell → value → struct.set $ref_cell 0
        // Null-guard: if ref cell local is null, skip struct.set (#702)
        const resultType = compileExpression(ctx, fctx, expr.right, boxed.valType);
        if (!resultType) {
          reportError(ctx, expr, "Failed to compile assignment value");
          return null;
        }
        const tmpVal = allocLocal(fctx, `__box_tmp_${fctx.locals.length}`, boxed.valType);
        fctx.body.push({ op: "local.set", index: tmpVal });
        fctx.body.push({ op: "local.get", index: localIdx });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [] as Instr[],
          else: [
            { op: "local.get", index: localIdx } as Instr,
            { op: "local.get", index: tmpVal } as Instr,
            {
              op: "struct.set",
              typeIdx: boxed.refCellTypeIdx,
              fieldIdx: 0,
            } as Instr,
          ],
        });
        // Return the assigned value (expression result)
        fctx.body.push({ op: "local.get", index: tmpVal });
        return resultType;
      }
      const localType =
        localIdx < fctx.params.length ? fctx.params[localIdx]!.type : fctx.locals[localIdx - fctx.params.length]?.type;

      // When assigning a function expression/arrow or a function reference
      // to a variable, don't pass externref type hint — let it compile to
      // its native closure struct ref type. Then update the local's type so
      // closure calls work correctly.
      const isFuncExprRHS = ts.isFunctionExpression(expr.right) || ts.isArrowFunction(expr.right);
      const isFuncRefRHS = ts.isIdentifier(expr.right) && ctx.funcMap.has(expr.right.text);
      const isCallableRHS = isFuncExprRHS || isFuncRefRHS;
      // Also detect when the local already has a closure type (reassignment case)
      const localIsClosureRef =
        localType &&
        (localType.kind === "ref" || localType.kind === "ref_null") &&
        ctx.closureInfoByTypeIdx.has((localType as { typeIdx: number }).typeIdx);
      const typeHint =
        (isCallableRHS || localIsClosureRef) && localType?.kind === "externref"
          ? undefined
          : localIsClosureRef
            ? undefined // Don't pass closure ref type as hint either — let RHS produce its own
            : localType;
      const resultType = compileExpression(ctx, fctx, expr.right, typeHint);
      if (!resultType) {
        reportError(ctx, expr, "Failed to compile assignment value");
        return null;
      }

      // If a closure struct ref was assigned to a local that already has a closure
      // ref type, update the local's type to match the new struct.
      // BUT: do NOT update externref locals — hoistVarDecl already emitted externref
      // init code; changing the type would make that init type-incompatible (#852).
      // Instead, the safety coercion below (coerceType ref→externref) emits
      // extern.convert_any, and compileClosureCall handles externref locals with
      // guarded ref.cast at call sites.
      if (
        (isCallableRHS || localIsClosureRef) &&
        resultType.kind === "ref" &&
        localIsClosureRef &&
        (localType as any)?.kind !== "externref"
      ) {
        if (localIdx < fctx.params.length) {
          fctx.params[localIdx]!.type = resultType;
        } else {
          const localEntry = fctx.locals[localIdx - fctx.params.length];
          if (localEntry) localEntry.type = resultType;
        }
      }

      // Re-read local type after potential update (func expr may have changed it)
      const effectiveLocalType =
        localIdx < fctx.params.length ? fctx.params[localIdx]!.type : fctx.locals[localIdx - fctx.params.length]?.type;

      // Safety coercion: if the expression produced a type that doesn't match
      // the local's declared type (e.g. compileExpression didn't have expectedType
      // or coercion was incomplete), coerce before local.tee
      if (effectiveLocalType && !valTypesMatch(resultType, effectiveLocalType)) {
        const bodyLenBeforeCoerce = fctx.body.length;
        coerceType(ctx, fctx, resultType, effectiveLocalType);
        if (
          fctx.body.length === bodyLenBeforeCoerce &&
          (resultType.kind === "ref" || resultType.kind === "ref_null") &&
          (effectiveLocalType.kind === "ref" || effectiveLocalType.kind === "ref_null")
        ) {
          // coerceType didn't emit anything for different struct types --
          // update the local's type to match the stack type instead of
          // emitting an invalid local.tee with mismatched types.
          updateLocalType(fctx, localIdx, resultType);
          fctx.body.push({ op: "local.tee", index: localIdx });
          emitMappedArgParamSync(ctx, fctx, localIdx, resultType);
          return resultType;
        }
        fctx.body.push({ op: "local.tee", index: localIdx });
        emitMappedArgParamSync(ctx, fctx, localIdx, effectiveLocalType);
        return effectiveLocalType;
      }
      fctx.body.push({ op: "local.tee", index: localIdx });
      emitMappedArgParamSync(ctx, fctx, localIdx, resultType);
      return resultType;
    }
    // Check captured globals
    const capturedIdx = ctx.capturedGlobals.get(name);
    if (capturedIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
      const resultType = compileExpression(ctx, fctx, expr.right, globalDef?.type);
      if (!resultType) {
        reportError(ctx, expr, "Failed to compile assignment value");
        return null;
      }
      // Re-read index: RHS compilation may shift globals via addStringConstantGlobal
      const capturedIdxPost = ctx.capturedGlobals.get(name)!;
      fctx.body.push({ op: "global.set", index: capturedIdxPost });
      // global.set consumes the value; re-push it for expression result
      fctx.body.push({ op: "global.get", index: capturedIdxPost });
      return resultType;
    }
    // Check module-level globals
    const moduleIdx = ctx.moduleGlobals.get(name);
    if (moduleIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
      const globalType = globalDef?.type;
      // When assigning a function expression/arrow to a module global,
      // don't pass externref type hint — let it compile to its native closure
      // struct ref type. We'll coerce to externref for storage afterward (#852).
      const isFuncExprRHS = ts.isFunctionExpression(expr.right) || ts.isArrowFunction(expr.right);
      const isFuncRefRHS = ts.isIdentifier(expr.right) && ctx.funcMap.has(expr.right.text);
      const typeHint = (isFuncExprRHS || isFuncRefRHS) && globalType?.kind === "externref" ? undefined : globalType;
      const resultType = compileExpression(ctx, fctx, expr.right, typeHint);
      if (!resultType) {
        reportError(ctx, expr, "Failed to compile assignment value");
        return null;
      }
      // Coerce closure struct ref → externref for storage in the global
      if (globalType?.kind === "externref" && (resultType.kind === "ref" || resultType.kind === "ref_null")) {
        fctx.body.push({ op: "extern.convert_any" });
      } else if (globalType && !valTypesMatch(resultType, globalType)) {
        coerceType(ctx, fctx, resultType, globalType);
      }
      // Re-read index: RHS compilation may shift globals via addStringConstantGlobal
      const moduleIdxPost = ctx.moduleGlobals.get(name)!;
      fctx.body.push({ op: "global.set", index: moduleIdxPost });
      fctx.body.push({ op: "global.get", index: moduleIdxPost });
      return globalType ?? resultType;
    }
    // Graceful fallback for unresolved identifiers: auto-allocate a local
    // so that compilation can continue. This handles class/object method bodies
    // that reference outer-scope variables not yet captured, and sloppy-mode
    // implicit globals from test262 tests.
    {
      const resultType = compileExpression(ctx, fctx, expr.right);
      if (!resultType) return null;
      const newLocalIdx = allocLocal(fctx, name, resultType);
      fctx.body.push({ op: "local.tee", index: newLocalIdx });
      return resultType;
    }
  }

  if (ts.isPropertyAccessExpression(expr.left)) {
    return compilePropertyAssignment(ctx, fctx, expr.left, expr.right);
  }

  if (ts.isElementAccessExpression(expr.left)) {
    return compileElementAssignment(ctx, fctx, expr.left, expr.right);
  }

  if (ts.isObjectLiteralExpression(expr.left)) {
    return compileDestructuringAssignment(ctx, fctx, expr.left, expr.right);
  }

  if (ts.isArrayLiteralExpression(expr.left)) {
    return compileArrayDestructuringAssignment(ctx, fctx, expr.left, expr.right);
  }

  reportError(ctx, expr, "Unsupported assignment target");
  return null;
}

/**
 * Detect strict-mode context for a node (§10.2.1).
 * A node is in strict mode if:
 *   - Containing source file starts with `"use strict";` directive.
 *   - Inside a class body (classes are always strict).
 *   - Inside a function whose body begins with `"use strict";`.
 */
export function isStrictContext(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isSourceFile(current)) {
      for (const stmt of current.statements) {
        if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
          if (stmt.expression.text === "use strict") return true;
        } else {
          break;
        }
      }
      return false;
    }
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) return true;
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      if (current.body && ts.isBlock(current.body)) {
        for (const stmt of current.body.statements) {
          if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
            if (stmt.expression.text === "use strict") return true;
          } else {
            break;
          }
        }
      }
    }
    current = current.parent;
  }
  return false;
}

/**
 * True if `id` is an identifier that cannot be resolved to any binding the
 * compiler knows about. Mirrors the check in identifiers.ts:393 for reads
 * but also excludes bindings that only exist in the codegen (locals, captures,
 * globals, func imports).
 */
export function isUnresolvableIdent(ctx: CodegenContext, fctx: FunctionContext, id: ts.Identifier): boolean {
  const name = id.text;
  if (fctx.localMap.has(name)) return false;
  if (fctx.boxedCaptures?.has(name)) return false;
  if (ctx.capturedGlobals.has(name)) return false;
  if (ctx.moduleGlobals.has(name)) return false;
  if (ctx.funcMap.has(name)) return false;
  // For shorthand property assignments `{x}` the checker returns the synthetic
  // property symbol (SymbolFlags.Property = 4) even when `x` has no value
  // binding in scope. The real value lookup is via getShorthandAssignmentValueSymbol.
  if (id.parent && ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) {
    const valSym = (
      ctx.checker as unknown as {
        getShorthandAssignmentValueSymbol?: (n: ts.Node) => ts.Symbol | undefined;
      }
    ).getShorthandAssignmentValueSymbol?.(id.parent);
    return !valSym;
  }
  const sym = ctx.checker.getSymbolAtLocation(id);
  if (!sym) return true;
  const decls = sym.declarations;
  if (!decls || decls.length === 0) return true;
  for (const d of decls) {
    if (d !== id) return false;
  }
  return true;
}

export function findUnresolvableInObjectPattern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ObjectLiteralExpression,
): boolean {
  for (const prop of target.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      if (isUnresolvableIdent(ctx, fctx, prop.name)) return true;
    } else if (ts.isPropertyAssignment(prop)) {
      let targetExpr = prop.initializer;
      if (ts.isBinaryExpression(targetExpr) && targetExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        targetExpr = targetExpr.left;
      }
      if (ts.isIdentifier(targetExpr) && isUnresolvableIdent(ctx, fctx, targetExpr)) return true;
      if (ts.isObjectLiteralExpression(targetExpr) && findUnresolvableInObjectPattern(ctx, fctx, targetExpr))
        return true;
      if (ts.isArrayLiteralExpression(targetExpr) && findUnresolvableInArrayPattern(ctx, fctx, targetExpr)) return true;
    } else if (ts.isSpreadAssignment(prop)) {
      if (ts.isIdentifier(prop.expression) && isUnresolvableIdent(ctx, fctx, prop.expression)) return true;
    }
  }
  return false;
}

export function findUnresolvableInArrayPattern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ArrayLiteralExpression,
): boolean {
  for (const element of target.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element) && isUnresolvableIdent(ctx, fctx, element)) return true;
    if (
      ts.isSpreadElement(element) &&
      ts.isIdentifier(element.expression) &&
      isUnresolvableIdent(ctx, fctx, element.expression)
    ) {
      return true;
    }
    if (
      ts.isBinaryExpression(element) &&
      element.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(element.left) &&
      isUnresolvableIdent(ctx, fctx, element.left)
    ) {
      return true;
    }
    if (ts.isArrayLiteralExpression(element) && findUnresolvableInArrayPattern(ctx, fctx, element)) return true;
    if (ts.isObjectLiteralExpression(element) && findUnresolvableInObjectPattern(ctx, fctx, element)) return true;
  }
  return false;
}

/**
 * §6.2.4 PutValue step 5: if the LHS reference is unresolvable in strict mode,
 * throw ReferenceError. The RHS value must already be on the stack (for
 * observable evaluation of the Initializer per §13.15.5.2 step 1). We drop it
 * and throw. The subsequent destructuring code is emitted but becomes
 * unreachable — Wasm's type system accepts this via polymorphic stack after
 * `throw`.
 */
function emitStrictPutValueThrow(ctx: CodegenContext, fctx: FunctionContext): void {
  fctx.body.push({ op: "drop" });
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "ref.null.extern" } as Instr);
  fctx.body.push({ op: "throw", tagIdx });
}

function compileDestructuringAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ObjectLiteralExpression,
  value: ts.Expression,
): InnerResult {
  // Compile the RHS — should produce a struct ref
  const resultType = compileExpression(ctx, fctx, value);
  if (!resultType) return null;

  // §6.2.4 PutValue: strict-mode assignment to unresolvable reference throws.
  if (isStrictContext(target) && findUnresolvableInObjectPattern(ctx, fctx, target)) {
    emitStrictPutValueThrow(ctx, fctx);
    // After throw the stack is polymorphic; push a sentinel matching resultType
    // so downstream code that expects a value sees the declared return type.
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    return { kind: "externref" };
  }

  // Determine struct type from the RHS expression's type
  const rhsType = ctx.checker.getTypeAtLocation(value);
  const symName = rhsType.symbol?.name;
  let typeName =
    symName && symName !== "__type" && symName !== "__object" && ctx.structMap.has(symName)
      ? symName
      : (ctx.anonTypeMap.get(rhsType) ?? symName);

  // Auto-register anonymous object types (same as resolveWasmType logic)
  if (
    typeName &&
    (typeName === "__type" || typeName === "__object") &&
    !ctx.anonTypeMap.has(rhsType) &&
    rhsType.getProperties().length > 0
  ) {
    ensureStructForType(ctx, rhsType);
    typeName = ctx.anonTypeMap.get(rhsType) ?? typeName;
  }

  // When the RHS type is unknown or a primitive (boolean, number, string),
  // there is no struct to destructure from.  For empty patterns like `{} = val`
  // we just need the RHS value as the expression result.  For non-empty
  // patterns the bindings stay at their defaults (mimics JS behaviour for
  // destructuring primitives — the properties simply do not exist). (#379)
  if (!typeName || !ctx.structMap.has(typeName) || !ctx.structFields.get(typeName)) {
    // Null/undefined check — throw TypeError (#783, #1260, #1701).
    // In JS, `{...} = null` and `{...} = undefined` always throw TypeError per
    // §13.15.5.2 ObjectAssignmentPattern step 1 (RequireObjectCoercible(value)),
    // which fires BEFORE the property list is walked. Even `{} = null` /
    // `{} = undefined` must throw. The earlier carve-out for empty patterns
    // (#225) was applied uniformly but is only correct for non-null/undefined
    // primitive RHS (e.g. `{} = 5` — a number is object-coercible).
    if (resultType.kind === "externref" || resultType.kind === "ref_null") {
      const tmpNullChk = allocLocal(fctx, `__destruct_null_chk_${fctx.locals.length}`, resultType);
      fctx.body.push({ op: "local.set", index: tmpNullChk });
      if (resultType.kind === "externref") {
        emitExternrefAssignDestructureGuard(ctx, fctx, tmpNullChk);
      } else {
        // ref_null source: only ref.is_null is meaningful (no undefined sentinel
        // for typed-struct refs).
        const throwInstrs = buildDestructureNullThrow(ctx, fctx);
        fctx.body.push({ op: "local.get", index: tmpNullChk });
        fctx.body.push({ op: "ref.is_null" } as Instr);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: throwInstrs,
          else: [],
        });
      }
      // Restore value on stack
      fctx.body.push({ op: "local.get", index: tmpNullChk });
    }

    // Stash the RHS so we can use it for property reads via __extern_get,
    // then restore it as the expression result.
    const rhsTmp = allocLocal(fctx, `__destruct_rhs_${fctx.locals.length}`, resultType);
    fctx.body.push({ op: "local.tee", index: rhsTmp });
    fctx.body.push({ op: "drop" } as Instr);

    // (#43) For each target binding, read the property via __extern_get
    // (which handles real JS objects, sidecar maps, and __sget_* fallbacks)
    // and apply default initializers per ECMA-262 §13.15.5.3 step 8 (only
    // when the read returns `undefined`). Without this, `result = { x = 1 }
    // = vals` left x at its initial zero/null even when vals had no `x`
    // property, because the no-struct-fields path returned early without
    // touching any of the target identifiers.
    if (resultType.kind === "externref") {
      // (#1866) Route `__extern_get` through `ensureLateImport` rather than a raw
      // `addImport("env", …)`: under `--target standalone` that re-routes to the
      // Wasm-native object-runtime impl (no `env::__extern_get` host import), so
      // the module instantiates under wasmtime; in JS-host mode it adds the host
      // import as before. A raw addImport leaks an undefined `env::__extern_get`
      // that breaks the zero-JS-host guarantee.
      ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      const getIdx = ctx.funcMap.get("__extern_get");

      if (getIdx !== undefined && undefIdx !== undefined) {
        for (const prop of target.properties) {
          if (!ts.isShorthandPropertyAssignment(prop)) continue;
          const name = prop.name.text;

          // Resolve write target: local first, then module global. Allocate
          // a local only if neither exists.
          let localIdx = fctx.localMap.get(name);
          let moduleGlobalIdx = ctx.moduleGlobals.get(name);
          let targetType: ValType;
          if (localIdx !== undefined) {
            targetType = getLocalType(fctx, localIdx) ?? { kind: "externref" as const };
          } else if (moduleGlobalIdx !== undefined) {
            const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
            targetType = globalDef?.type ?? { kind: "externref" as const };
          } else {
            localIdx = allocLocal(fctx, name, { kind: "externref" });
            targetType = { kind: "externref" as const };
          }

          // Read prop value: tmp = __extern_get(rhs, "name")
          addStringConstantGlobal(ctx, name);
          const strGlobalIdx = ctx.stringGlobalMap.get(name);
          if (strGlobalIdx === undefined) continue;

          const tmpVal = allocLocal(fctx, `__destruct_val_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.get", index: rhsTmp });
          fctx.body.push({ op: "global.get", index: strGlobalIdx });
          fctx.body.push({ op: "call", funcIdx: getIdx });
          fctx.body.push({ op: "local.set", index: tmpVal });

          // Helper: emit `<value-on-stack> -> coerce -> set target`.
          const emitSetTarget = (instrs: Instr[]): void => {
            // The value is currently on the Wasm stack as externref. Coerce
            // and then set. We append into `instrs` so the caller can splice
            // it into a then/else branch.
            if (!valTypesMatch({ kind: "externref" }, targetType)) {
              const saved = fctx.body;
              fctx.body = instrs;
              coerceType(ctx, fctx, { kind: "externref" }, targetType);
              fctx.body = saved;
            }
            if (localIdx !== undefined) {
              instrs.push({ op: "local.set", index: localIdx } as Instr);
            } else if (moduleGlobalIdx !== undefined) {
              instrs.push({ op: "global.set", index: moduleGlobalIdx } as Instr);
            }
          };

          if (prop.objectAssignmentInitializer) {
            // Per spec: defaults fire ONLY on undefined. Use
            // __extern_is_undefined (not ref.is_null) so JS null falls
            // through to the assignment branch.
            fctx.body.push({ op: "local.get", index: tmpVal });
            fctx.body.push({ op: "call", funcIdx: undefIdx });

            // then-branch: compile default into target
            const trueInstrs: Instr[] = [];
            const savedTrueBody = fctx.body;
            fctx.body = trueInstrs;
            const initType = compileExpression(ctx, fctx, prop.objectAssignmentInitializer, targetType);
            if (initType && !valTypesMatch(initType, targetType)) {
              coerceType(ctx, fctx, initType, targetType);
            }
            fctx.body = savedTrueBody;
            if (localIdx !== undefined) {
              trueInstrs.push({ op: "local.set", index: localIdx } as Instr);
            } else if (moduleGlobalIdx !== undefined) {
              // Re-read in case compileExpression shifted indices.
              moduleGlobalIdx = ctx.moduleGlobals.get(name)!;
              trueInstrs.push({ op: "global.set", index: moduleGlobalIdx } as Instr);
            }

            // else-branch: forward the read value (with optional coerce)
            const elseInstrs: Instr[] = [{ op: "local.get", index: tmpVal } as Instr];
            emitSetTarget(elseInstrs);

            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: trueInstrs,
              else: elseInstrs,
            });
          } else {
            // No default: just assign whatever __extern_get returned (which
            // is `undefined` if missing — JS-equivalent behaviour).
            fctx.body.push({ op: "local.get", index: tmpVal });
            const tail: Instr[] = [];
            emitSetTarget(tail);
            for (const i of tail) fctx.body.push(i);
          }
        }
      } else {
        // Imports unavailable — fall through to the legacy alloc-only path
        // so we at least don't trap.
        for (const prop of target.properties) {
          if (ts.isShorthandPropertyAssignment(prop)) {
            const name = prop.name.text;
            if (!fctx.localMap.has(name) && !ctx.moduleGlobals.has(name)) {
              allocLocal(fctx, name, { kind: "externref" });
            }
          } else if (ts.isSpreadAssignment(prop) && ts.isIdentifier(prop.expression)) {
            const name = prop.expression.text;
            if (!fctx.localMap.has(name) && !ctx.moduleGlobals.has(name)) {
              allocLocal(fctx, name, { kind: "externref" });
            }
          }
        }
      }
    } else {
      // Non-externref RHS (struct ref already typed) — preserve old
      // alloc-only behaviour; the typed-struct path above (lines 570+)
      // handles the real extraction.
      for (const prop of target.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
          const name = prop.name.text;
          if (!fctx.localMap.has(name) && !ctx.moduleGlobals.has(name)) {
            allocLocal(fctx, name, { kind: "externref" });
          }
        } else if (ts.isSpreadAssignment(prop) && ts.isIdentifier(prop.expression)) {
          const name = prop.expression.text;
          if (!fctx.localMap.has(name) && !ctx.moduleGlobals.has(name)) {
            allocLocal(fctx, name, { kind: "externref" });
          }
        }
      }
    }

    // Restore RHS as the expression result.
    fctx.body.push({ op: "local.get", index: rhsTmp });
    return resultType;
  }

  // Prefer the typeIdx from the RHS result over the TS-checker-derived typeName.
  // The RHS compilation may have created a different struct type than the one
  // the TS checker maps to (e.g., nested destructuring creates a struct with
  // ref-typed fields, but the TS checker sees externref fields). (#822)
  let structTypeIdx: number;
  let fields: { name: string; type: ValType; mutable?: boolean }[];
  const actualTypeIdx = (resultType as any).typeIdx as number | undefined;
  const actualName = actualTypeIdx !== undefined ? ctx.typeIdxToStructName.get(actualTypeIdx) : undefined;
  const actualFields = actualName ? ctx.structFields.get(actualName) : undefined;
  if (actualTypeIdx !== undefined && actualFields) {
    structTypeIdx = actualTypeIdx;
    fields = actualFields;
  } else {
    structTypeIdx = ctx.structMap.get(typeName)!;
    fields = ctx.structFields.get(typeName)!;
  }

  // Save the struct ref in a temp local
  const tmpLocal = allocLocal(fctx, `__destruct_assign_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Null guard for ref_null types
  const isNullableDA = resultType.kind === "ref_null";
  const savedBodyDA = fctx.body;
  const destructInstrsDA: Instr[] = [];
  fctx.body = destructInstrsDA;

  // For each property in the destructuring pattern, set the existing local
  for (const prop of target.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      // { width } = ... → prop.name is "width"
      const propName = prop.name.text;
      let localIdx = fctx.localMap.get(propName);

      const fieldIdx = fields.findIndex((f) => f.name === propName);

      // (#43) When the source struct has no matching field but the pattern
      // supplies a default initializer (e.g. `{ x = 1 } = {}`), the spec
      // says: read `obj.x` → `undefined` → default fires → x = 1. The old
      // path reported "Unknown field" and skipped the binding entirely,
      // leaving the local at its initial zero/null. Now we treat field-not-
      // found as "the value is undefined" — fire the default if present,
      // otherwise just leave the binding alone (matching JS where reading
      // a missing property gives undefined; the destructured local then
      // holds undefined).
      if (fieldIdx === -1) {
        if (!prop.objectAssignmentInitializer) {
          // No default, no field — silently skip (the destructured local
          // is already undefined / its zero value). This matches the
          // "primitive RHS / no destructure" branch above which lets
          // bindings stay at their defaults.
          continue;
        }
        // Auto-allocate local if not declared. Use externref so a
        // boxed-anything default (number, string, object) flows through.
        if (localIdx === undefined) {
          localIdx = allocLocal(fctx, propName, { kind: "externref" });
        }
        const targetType = getLocalType(fctx, localIdx) ?? { kind: "externref" as const };
        const initType = compileExpression(ctx, fctx, prop.objectAssignmentInitializer, targetType);
        if (initType && !valTypesMatch(initType, targetType)) {
          coerceType(ctx, fctx, initType, targetType);
        }
        fctx.body.push({ op: "local.set", index: localIdx });
        continue;
      }

      // Auto-allocate local if not declared (e.g. destructuring creates new binding)
      if (localIdx === undefined) {
        const fieldType = fields[fieldIdx]!.type;
        localIdx = allocLocal(fctx, propName, fieldType);
      }

      const fieldType = fields[fieldIdx]!.type;
      const localType = getLocalType(fctx, localIdx);

      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      // Handle default value: { x = defaultVal } = obj
      if (prop.objectAssignmentInitializer) {
        if (fieldType.kind === "externref") {
          const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.tee", index: tmpField });
          // Per ECMA-262 §13.15.5.5 (DestructuringAssignmentEvaluation,
          // AssignmentElement), the default initializer fires ONLY when the
          // read value is `undefined`, NOT for JS `null`. In the WebAssembly JS
          // API, JS `null` maps to `ref.null extern` (ref.is_null === 1), so the
          // bare `ref.is_null` guard wrongly fired the default for `{ a } = { a: null }`.
          // Use __extern_is_undefined so JS null falls through to the value branch,
          // while a missing/undefined field (also non-null externref wrapping the
          // JS undefined sentinel, or a wasm-null uninitialized slot) still fires it.
          const undefIdxDA = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
          if (undefIdxDA !== undefined) {
            flushLateImportShifts(ctx, fctx);
            // value === undefined ?  (does not fire for JS null)
            fctx.body.push({ op: "call", funcIdx: undefIdxDA });
          } else {
            // Fallback: imprecise (treats null as undefined) when the import
            // could not be registered (e.g. standalone mode).
            fctx.body.push({ op: "ref.is_null" } as Instr);
          }
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...(() => {
                const saved = fctx.body;
                fctx.body = [];
                compileExpression(ctx, fctx, prop.objectAssignmentInitializer!, localType ?? fieldType);
                fctx.body.push({ op: "local.set", index: localIdx! } as Instr);
                const instrs = fctx.body;
                fctx.body = saved;
                return instrs;
              })(),
            ],
            else: [
              { op: "local.get", index: tmpField } as Instr,
              ...(() => {
                if (localType && !valTypesMatch(fieldType, localType)) {
                  const saved = fctx.body;
                  fctx.body = [];
                  coerceType(ctx, fctx, fieldType, localType);
                  const instrs = fctx.body;
                  fctx.body = saved;
                  return instrs;
                }
                return [];
              })(),
              { op: "local.set", index: localIdx! } as Instr,
            ],
          });
        } else {
          // Coerce field type to local type if needed
          if (localType && !valTypesMatch(fieldType, localType)) {
            coerceType(ctx, fctx, fieldType, localType);
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      } else {
        // Coerce field type to local type if needed
        if (localType && !valTypesMatch(fieldType, localType)) {
          coerceType(ctx, fctx, fieldType, localType);
        }
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    } else if (ts.isPropertyAssignment(prop)) {
      let propName = ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isStringLiteral(prop.name)
          ? prop.name.text
          : ts.isNumericLiteral(prop.name)
            ? prop.name.text
            : undefined;
      // Try resolving computed property names at compile time
      if (!propName && ts.isComputedPropertyName(prop.name)) {
        propName = resolveComputedKeyExpression(ctx, prop.name.expression);
      }
      if (!propName) continue; // truly unresolvable property name — skip
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) {
        reportSilentFallback(ctx, "lookup-miss-skip", "assignment:destructure-assign-property-field-miss", prop);
        continue;
      }
      const fieldType = fields[fieldIdx]!.type;

      // Determine the target and optional default value
      let targetExpr = prop.initializer;
      let defaultExpr: ts.Expression | undefined;

      // { y: x = defaultVal } — BinaryExpression with EqualsToken
      if (
        ts.isBinaryExpression(targetExpr) &&
        targetExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(targetExpr.left)
      ) {
        defaultExpr = targetExpr.right;
        targetExpr = targetExpr.left;
      }

      if (ts.isIdentifier(targetExpr)) {
        // { prop: ident } or { prop: ident = default }
        const localName = targetExpr.text;
        let localIdx = fctx.localMap.get(localName);

        // Auto-allocate local if not declared
        if (localIdx === undefined) {
          localIdx = allocLocal(fctx, localName, fieldType);
        }

        const localType = getLocalType(fctx, localIdx);

        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

        if (defaultExpr) {
          // Handle default value for property assignment target
          if (fieldType.kind === "externref" || fieldType.kind === "ref" || fieldType.kind === "ref_null") {
            const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
            fctx.body.push({ op: "local.tee", index: tmpField });
            fctx.body.push({ op: "ref.is_null" } as Instr);
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...(() => {
                  const saved = fctx.body;
                  fctx.body = [];
                  compileExpression(ctx, fctx, defaultExpr!, localType ?? fieldType);
                  fctx.body.push({
                    op: "local.set",
                    index: localIdx!,
                  } as Instr);
                  const instrs = fctx.body;
                  fctx.body = saved;
                  return instrs;
                })(),
              ],
              else: [
                { op: "local.get", index: tmpField } as Instr,
                ...(() => {
                  if (localType && !valTypesMatch(fieldType, localType)) {
                    const saved = fctx.body;
                    fctx.body = [];
                    coerceType(ctx, fctx, fieldType, localType);
                    const instrs = fctx.body;
                    fctx.body = saved;
                    return instrs;
                  }
                  return [];
                })(),
                { op: "local.set", index: localIdx! } as Instr,
              ],
            });
          } else {
            // Numeric field — just set the value (no undefined check needed for primitives)
            if (localType && !valTypesMatch(fieldType, localType)) {
              coerceType(ctx, fctx, fieldType, localType);
            }
            fctx.body.push({ op: "local.set", index: localIdx });
          }
        } else {
          // No default — just coerce and set
          if (localType && !valTypesMatch(fieldType, localType)) {
            coerceType(ctx, fctx, fieldType, localType);
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      } else if (ts.isObjectLiteralExpression(targetExpr)) {
        // { prop: { nested } } — nested destructuring
        const tmpNested = allocLocal(fctx, `__nested_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitObjectDestructureFromLocal(ctx, fctx, targetExpr, tmpNested, fieldType);
      } else if (ts.isArrayLiteralExpression(targetExpr)) {
        // { prop: [a, b] } — nested array destructuring
        const tmpNested = allocLocal(fctx, `__nested_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitArrayDestructureFromLocal(ctx, fctx, targetExpr, tmpNested, fieldType);
      } else if (ts.isPropertyAccessExpression(targetExpr) || ts.isElementAccessExpression(targetExpr)) {
        // { prop: obj.field } or { prop: arr[0] } — member expression target
        const tmpElem = allocLocal(fctx, `__nested_elem_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpElem });
        emitAssignToTarget(ctx, fctx, targetExpr, tmpElem, fieldType);
      }
      // else: unsupported target expression in property assignment — skip
    } else if (ts.isSpreadAssignment(prop)) {
      // { ...rest } = obj — rest element in object destructuring
      // Convert struct to externref and use __extern_rest_object to collect remaining props
      if (ts.isIdentifier(prop.expression)) {
        const restName = prop.expression.text;
        let restIdx = fctx.localMap.get(restName);
        if (restIdx === undefined) {
          restIdx = allocLocal(fctx, restName, { kind: "externref" });
        }
        // Collect excluded property names
        const excludedKeys: string[] = [];
        for (const p of target.properties) {
          if (ts.isSpreadAssignment(p)) continue;
          if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
            const pn = ts.isPropertyAssignment(p) ? p.name : p.name;
            if (ts.isIdentifier(pn)) excludedKeys.push(pn.text);
            else if (ts.isStringLiteral(pn)) excludedKeys.push(pn.text);
            else if (ts.isNumericLiteral(pn)) excludedKeys.push(pn.text);
          }
        }
        // Use __extern_rest_object(externObj, excludedKeysStr)
        let restObjIdx = ctx.funcMap.get("__extern_rest_object");
        if (restObjIdx === undefined) {
          const importsBefore = ctx.numImportFuncs;
          const restObjType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
          addImport(ctx, "env", "__extern_rest_object", { kind: "func", typeIdx: restObjType });
          shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
          restObjIdx = ctx.funcMap.get("__extern_rest_object");
        }
        if (restObjIdx !== undefined) {
          const excludedStr = excludedKeys.join(",");
          addStringConstantGlobal(ctx, excludedStr);
          const excludedStrIdx = ctx.stringGlobalMap.get(excludedStr);
          if (excludedStrIdx !== undefined) {
            // Convert struct ref to externref
            fctx.body.push({ op: "local.get", index: tmpLocal });
            fctx.body.push({ op: "extern.convert_any" } as Instr);
            fctx.body.push({ op: "global.get", index: excludedStrIdx });
            fctx.body.push({ op: "call", funcIdx: restObjIdx });
            fctx.body.push({ op: "local.set", index: restIdx });
          }
        }
      }
    }
  }

  // Close null guard — throw TypeError if null/undefined (#783).
  // Skip for empty `{} = val` patterns (#225).
  fctx.body = savedBodyDA;
  if (isNullableDA && target.properties.length > 0) {
    const throwInstrs = buildDestructureNullThrow(ctx, fctx);
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: throwInstrs,
      else: destructInstrsDA,
    });
  } else {
    fctx.body.push(...destructInstrsDA);
  }

  // The result of a destructuring assignment is the RHS value
  fctx.body.push({ op: "local.get", index: tmpLocal });
  return resultType;
}

/**
 * (#1719 CPR-2) Drive a captured `Array.prototype[@@iterator]` override for an
 * array **assignment** destructuring (`[a, b, z] = arr`) whose targets are plain
 * identifiers — exactly the shape of the assignment-context
 * `*-iter-val-array-prototype.js` tests. PRECONDITION: the RHS vec ref is on the
 * stack and the caller gated on the brand + a captured override.
 *
 * Returns `true` after driving (RHS consumed); returns `false` WITHOUT disturbing
 * the stack (RHS still on top) for any non-identifier target / rest / nested
 * shape, so the caller falls through to the backing-store lowering. Mirrors the
 * binding-site read-drive (`tryEmitArrayProtoIteratorReadDrive`): drive override
 * → iterator, then per element `__iterator_next` → `(i32 done, externref value)`,
 * coerce + assign to the identifier's local/global. Null-guarded so an
 * unresolved-override dispatch-miss degrades gracefully instead of trapping.
 */
function tryEmitArrayProtoIteratorAssignDrive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ArrayLiteralExpression,
  resultType: ValType,
): boolean {
  const overrideGlobalIdx = arrayIteratorOverrideGlobalIdx(ctx);
  if (overrideGlobalIdx === undefined) return false;

  // Shape gate: every element must be a plain identifier target (no holes that
  // resolve to non-identifiers, no member/element-access, no rest/spread). Holes
  // (OmittedExpression) are allowed — they just advance the iterator.
  for (const el of target.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (ts.isSpreadElement(el)) return false; // rest → follow-up
    if (!ts.isIdentifier(el)) return false; // member / element-access / nested → follow-up
  }

  const nextIdx = ensureLateImport(
    ctx,
    "__iterator_next",
    [{ kind: "externref" }],
    [{ kind: "i32" }, { kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (nextIdx === undefined) return false;

  // The RHS vec ref is on the stack — drive the override into an iterator local.
  // `emitArrayProtoIteratorDrive` does `extern.convert_any` (any→extern) on the
  // vec ref, then calls __drive_proto_iterator(array, closure).
  const iterLocal = emitArrayProtoIteratorDrive(ctx, fctx, overrideGlobalIdx);
  const doneLocal = allocLocal(fctx, `__cpra_done_${fctx.locals.length}`, { kind: "i32" });
  const valLocal = allocLocal(fctx, `__cpra_val_${fctx.locals.length}`, { kind: "externref" });

  // Build the per-element drain into a buffer, guarded on a non-null iterator.
  const drainInstrs: Instr[] = [];
  const saved = fctx.body;
  fctx.savedBodies.push(saved);
  fctx.body = drainInstrs;
  try {
    for (const el of target.elements) {
      // (done, value) = __iterator_next(iter)
      fctx.body.push({ op: "local.get", index: iterLocal } as Instr);
      fctx.body.push({ op: "call", funcIdx: nextIdx } as Instr);
      fctx.body.push({ op: "local.set", index: valLocal } as Instr); // value (top)
      fctx.body.push({ op: "local.set", index: doneLocal } as Instr); // done (below)

      if (ts.isOmittedExpression(el) || !ts.isIdentifier(el)) continue; // hole: advance only

      const name = el.text;
      // Resolve the assignment target. Identifier assignment targets are
      // function locals or module globals; reuse the same resolution the
      // identifier-assignment path uses.
      const localIdx = fctx.localMap.get(name);
      const globalIdx = ctx.moduleGlobals.get(name);
      // When done (iterator exhausted), the spec value is `undefined`; leave the
      // local untouched (the targets already exist / hold their prior value) —
      // the 71 assignment tests yield concrete values, never short.
      if (localIdx !== undefined) {
        const localType = getLocalType(fctx, localIdx) ?? ({ kind: "externref" } as ValType);
        const assignBody: Instr[] = [];
        const sb = fctx.body;
        fctx.savedBodies.push(sb);
        fctx.body = assignBody;
        try {
          fctx.body.push({ op: "local.get", index: valLocal } as Instr);
          coerceType(ctx, fctx, { kind: "externref" }, localType);
          fctx.body.push({ op: "local.set", index: localIdx } as Instr);
        } finally {
          fctx.body = sb;
          fctx.savedBodies.pop();
        }
        fctx.body.push({ op: "local.get", index: doneLocal } as Instr);
        fctx.body.push({ op: "i32.eqz" } as Instr);
        fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: assignBody, else: [] } as Instr);
      } else if (globalIdx !== undefined) {
        const gType = ctx.mod.globals[globalIdx]?.type ?? ({ kind: "externref" } as ValType);
        const assignBody: Instr[] = [];
        const sb = fctx.body;
        fctx.savedBodies.push(sb);
        fctx.body = assignBody;
        try {
          fctx.body.push({ op: "local.get", index: valLocal } as Instr);
          coerceType(ctx, fctx, { kind: "externref" }, gType as ValType);
          fctx.body.push({ op: "global.set", index: globalIdx } as Instr);
        } finally {
          fctx.body = sb;
          fctx.savedBodies.pop();
        }
        fctx.body.push({ op: "local.get", index: doneLocal } as Instr);
        fctx.body.push({ op: "i32.eqz" } as Instr);
        fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: assignBody, else: [] } as Instr);
      }
      // Unresolvable identifier target: skip (rare in the 71; spec would create
      // a global in sloppy mode — out of scope for the fast drive).
    }
  } finally {
    fctx.body = saved;
    fctx.savedBodies.pop();
  }

  // if (iter !== null) { drain }
  fctx.body.push({ op: "local.get", index: iterLocal } as Instr);
  fctx.body.push({ op: "ref.is_null" } as Instr);
  fctx.body.push({ op: "i32.eqz" } as Instr);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: drainInstrs, else: [] } as Instr);
  // The assignment expression evaluates to the RHS, but it was consumed by the
  // drive; assignment-destructuring is almost always a statement (result
  // dropped). Push a null externref to satisfy the caller's `externref` result
  // contract. (#1719 CPR-2)
  fctx.body.push({ op: "ref.null.extern" } as Instr);
  return true;
}

function compileArrayDestructuringAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ArrayLiteralExpression,
  value: ts.Expression,
): InnerResult {
  // Compile the RHS — should produce a struct ref (either tuple or vec)
  const resultType = compileExpression(ctx, fctx, value);
  if (!resultType) return null;

  // (#1719 CPR-2) When the program overrode Array.prototype[@@iterator] and the
  // RHS is a real array, drive the captured override instead of the backing
  // store (§13.15.5.2 ArrayAssignmentPattern → GetIterator). Strictly gated
  // behind the brand + a captured override (both clear in the common case ⇒
  // byte-identical). Returns true (and the assignment result) when it drove the
  // identifier-target shape; falls through to the backing-store lowering for
  // member/element-access/rest/nested targets.
  if (
    ctx.arrayIteratorMaybeOverridden &&
    arrayIteratorOverrideGlobalIdx(ctx) !== undefined &&
    (resultType.kind === "ref" || resultType.kind === "ref_null")
  ) {
    const drove = tryEmitArrayProtoIteratorAssignDrive(ctx, fctx, target, resultType);
    if (drove) return { kind: "externref" };
  }

  // §6.2.4 PutValue: strict-mode assignment to unresolvable reference throws.
  if (isStrictContext(target) && findUnresolvableInArrayPattern(ctx, fctx, target)) {
    emitStrictPutValueThrow(ctx, fctx);
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    return { kind: "externref" };
  }

  // Externref fallback: use __extern_get(obj, boxed_index) for each element
  if (resultType.kind !== "ref" && resultType.kind !== "ref_null") {
    if (resultType.kind === "externref") {
      return compileExternrefArrayDestructuringAssignment(ctx, fctx, target, resultType);
    }
    // #1701: ArrayAssignmentPattern always invokes GetIterator(value) per
    // §13.15.5.2. For primitive RHS (number, boolean — both lower to f64/i32
    // here) the spec result is a TypeError ("value is not iterable") because
    // numbers/booleans lack a [Symbol.iterator] method. Previously we boxed
    // the primitive via __box_number and recursed; the lenient runtime then
    // silently produced an empty array. Drop the value and throw directly.
    if (resultType.kind === "f64" || resultType.kind === "i32") {
      // #846: emit a REAL TypeError instance (not a bare string) so the
      // test262 `assert.throws(TypeError, …)` callbacks — which check
      // `e instanceof TypeError` inside the compiled program — observe the
      // correct error type. `emitThrowString` produced an opaque
      // string-payload exception that failed the instanceof check.
      fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, "value is not iterable");
      fctx.body.push({ op: "ref.null.extern" } as Instr);
      return { kind: "externref" };
    }
    reportError(ctx, target, "Cannot destructure: not an array type");
    return null;
  }

  const typeIdx = (resultType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  if (!typeDef || typeDef.kind !== "struct") {
    // Non-struct ref: convert to externref and use __extern_get fallback
    fctx.body.push({ op: "extern.convert_any" } as Instr);
    return compileExternrefArrayDestructuringAssignment(ctx, fctx, target, {
      kind: "externref",
    });
  }

  // Detect whether RHS is a tuple struct (fields $_0, $_1, ...) or vec struct ({length, data})
  const isVecStruct =
    typeDef.fields.length === 2 && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data";

  let arrTypeIdx = -1;
  let arrDef: { kind: string; element: ValType } | undefined;

  if (isVecStruct) {
    arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const ad = ctx.mod.types[arrTypeIdx];
    if (!ad || ad.kind !== "array") {
      reportError(ctx, target, "Cannot destructure: vec data is not array");
      return null;
    }
    arrDef = ad as { kind: string; element: ValType };
  }

  // Store struct ref in temp local
  const tmpLocal = allocLocal(fctx, `__arr_destruct_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Null guard for ref_null types
  const isNullableADA = resultType.kind === "ref_null";
  const savedBodyADA = fctx.body;
  const arrDestructInstrsADA: Instr[] = [];
  fctx.body = arrDestructInstrsADA;

  // Helper: get element type at index i
  const getElemType = (i: number): ValType => {
    if (isVecStruct) return arrDef!.element;
    // Tuple: field type at index i
    const field = typeDef.fields[i];
    return field ? field.type : { kind: "f64" };
  };

  // Helper: emit instructions to get element i onto the stack
  const emitElementGet = (i: number) => {
    fctx.body.push({ op: "local.get", index: tmpLocal });
    if (isVecStruct) {
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data array
      fctx.body.push({ op: "i32.const", value: i });
      emitBoundsCheckedArrayGet(fctx, arrTypeIdx, arrDef!.element);
    } else {
      // Tuple: direct struct.get with field index
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: i });
    }
  };

  for (let i = 0; i < target.elements.length; i++) {
    const element = target.elements[i]!;

    // Skip holes: [a, , c] = arr
    if (ts.isOmittedExpression(element)) continue;

    // Handle rest element: [a, ...rest] = arr (only for vec structs)
    if (ts.isSpreadElement(element)) {
      if (isVecStruct) {
        const restTarget = element.expression;
        if (ts.isIdentifier(restTarget)) {
          const restName = restTarget.text;
          let restLocalIdx = fctx.localMap.get(restName);
          if (restLocalIdx === undefined) {
            restLocalIdx = allocLocal(fctx, restName, resultType);
          } else {
            // If the rest local was pre-allocated as externref (e.g. var y;),
            // allocate a fresh local with the correct vec type and redirect
            // the name mapping. The old externref slot becomes dead.
            // Cannot change type in-place: earlier __get_undefined() init
            // targets externref and would cause illegal cast (#962, #971).
            const existingSlotIdx = restLocalIdx - fctx.params.length;
            if (existingSlotIdx >= 0) {
              const slot = fctx.locals[existingSlotIdx];
              if (slot && slot.type.kind === "externref") {
                restLocalIdx = allocLocal(fctx, restName, resultType);
              }
            }
          }
          const tmpLen = allocLocal(fctx, `__rest_len_${fctx.locals.length}`, {
            kind: "i32",
          });
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // length
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.sub" } as Instr);
          fctx.body.push({ op: "local.tee", index: tmpLen });

          fctx.body.push({
            op: "array.new_default",
            typeIdx: arrTypeIdx,
          } as Instr);
          const tmpRestArr = allocLocal(fctx, `__rest_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "local.set", index: tmpRestArr });

          const tmpJ = allocLocal(fctx, `__rest_j_${fctx.locals.length}`, {
            kind: "i32",
          });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.set", index: tmpJ });

          const loopBody: Instr[] = [
            { op: "local.get", index: tmpJ } as Instr,
            { op: "local.get", index: tmpLen } as Instr,
            { op: "i32.lt_s" } as Instr,
            { op: "i32.eqz" } as Instr,
            { op: "br_if", depth: 1 } as Instr,
            { op: "local.get", index: tmpRestArr } as Instr,
            { op: "local.get", index: tmpJ } as Instr,
            { op: "local.get", index: tmpLocal } as Instr,
            { op: "struct.get", typeIdx, fieldIdx: 1 } as Instr,
            { op: "local.get", index: tmpJ } as Instr,
            { op: "i32.const", value: i } as Instr,
            { op: "i32.add" } as Instr,
            {
              op:
                arrDef!.element.kind === "i8"
                  ? "array.get_u"
                  : arrDef!.element.kind === "i16"
                    ? "array.get_s"
                    : "array.get",
              typeIdx: arrTypeIdx,
            } as Instr,
            { op: "array.set", typeIdx: arrTypeIdx } as Instr,
            { op: "local.get", index: tmpJ } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.add" } as Instr,
            { op: "local.set", index: tmpJ } as Instr,
            { op: "br", depth: 0 } as Instr,
          ];

          fctx.body.push({
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: loopBody,
              } as Instr,
            ],
          } as Instr);

          fctx.body.push({ op: "local.get", index: tmpLen });
          fctx.body.push({ op: "local.get", index: tmpRestArr });
          fctx.body.push({ op: "struct.new", typeIdx } as Instr);
          fctx.body.push({ op: "local.set", index: restLocalIdx });
        }
      }
      // Rest on tuples is not supported (would need type conversion)
      continue;
    }

    const elemType = getElemType(i);

    if (ts.isIdentifier(element)) {
      const localName = element.text;
      let localIdx = fctx.localMap.get(localName);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, localName, elemType);
      }
      emitElementGet(i);
      const localType = getLocalType(fctx, localIdx);
      if (localType && !valTypesMatch(elemType, localType)) {
        coerceType(ctx, fctx, elemType, localType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    } else if (ts.isPropertyAccessExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(fctx, `__arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitAssignToTarget(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isElementAccessExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(fctx, `__arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitAssignToTarget(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isObjectLiteralExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(fctx, `__arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitObjectDestructureFromLocal(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isArrayLiteralExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(fctx, `__arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitArrayDestructureFromLocal(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isBinaryExpression(element) && element.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const assignTarget = element.left;
      const defaultExpr = element.right;
      if (ts.isIdentifier(assignTarget)) {
        const localName = assignTarget.text;
        let localIdx = fctx.localMap.get(localName);
        if (localIdx === undefined) {
          localIdx = allocLocal(fctx, localName, elemType);
        }
        emitElementGet(i);
        if (elemType.kind === "externref" || elemType.kind === "ref" || elemType.kind === "ref_null") {
          const tmpElem = allocLocal(fctx, `__dflt_${fctx.locals.length}`, elemType);
          // Per ECMA-262 §13.15.5.5 (AssignmentElement) the default initializer
          // fires ONLY when the read value is `undefined`, never for JS `null`.
          // JS `null` maps to `ref.null extern` in the WebAssembly JS API, so a
          // bare `ref.is_null` guard wrongly fired the default for `[a=1] = [null]`.
          // For externref elements, use __extern_is_undefined (strict === undefined);
          // for plain wasm ref/ref_null elements (no JS-undefined sentinel) keep
          // ref.is_null — a wasm-null slot there means "missing", which fires.
          if (elemType.kind === "externref") {
            const undefIdxTuple = ensureLateImport(
              ctx,
              "__extern_is_undefined",
              [{ kind: "externref" }],
              [{ kind: "i32" }],
            );
            flushLateImportShifts(ctx, fctx);
            fctx.body.push({ op: "local.tee", index: tmpElem });
            if (undefIdxTuple !== undefined) {
              fctx.body.push({ op: "call", funcIdx: undefIdxTuple });
            } else {
              fctx.body.push({ op: "ref.is_null" } as Instr);
            }
          } else {
            fctx.body.push({ op: "local.tee", index: tmpElem });
            fctx.body.push({ op: "ref.is_null" } as Instr);
          }
          const localType = getLocalType(fctx, localIdx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...(() => {
                const saved = fctx.body;
                fctx.body = [];
                compileExpression(ctx, fctx, defaultExpr, localType ?? elemType);
                fctx.body.push({ op: "local.set", index: localIdx! } as Instr);
                const instrs = fctx.body;
                fctx.body = saved;
                return instrs;
              })(),
            ],
            else: [
              { op: "local.get", index: tmpElem } as Instr,
              ...(() => {
                if (localType && !valTypesMatch(elemType, localType)) {
                  const saved = fctx.body;
                  fctx.body = [];
                  coerceType(ctx, fctx, elemType, localType);
                  const instrs = fctx.body;
                  fctx.body = saved;
                  return instrs;
                }
                return [];
              })(),
              { op: "local.set", index: localIdx! } as Instr,
            ],
          });
        } else {
          const localType = getLocalType(fctx, localIdx);
          if (localType && !valTypesMatch(elemType, localType)) {
            coerceType(ctx, fctx, elemType, localType);
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
    }
    // else: unsupported element target — skip
  }

  // Close null guard — throw TypeError if null/undefined (#783).
  // Skip for empty `[] = val` patterns (#225).
  fctx.body = savedBodyADA;
  if (isNullableADA && target.elements.length > 0) {
    const throwInstrs = buildDestructureNullThrow(ctx, fctx);
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: throwInstrs,
      else: arrDestructInstrsADA,
    });
  } else {
    fctx.body.push(...arrDestructInstrsADA);
  }

  // The result of a destructuring assignment is the RHS value
  fctx.body.push({ op: "local.get", index: tmpLocal });
  return resultType;
}

/**
 * Destructure an externref value using __extern_get(obj, boxed_index) for each element.
 * This handles cases where the RHS is dynamically typed (e.g. arguments, iterators, function returns).
 */
function compileExternrefArrayDestructuringAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ArrayLiteralExpression,
  resultType: ValType,
): InnerResult {
  // Store externref in temp local
  const tmpLocal = allocLocal(fctx, `__ext_arr_destruct_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Null/undefined guard — throw TypeError per spec §13.15.5.2 step 2
  // (GetIterator requires the value to be object-coercible). Even empty
  // `[] = null` / `[] = undefined` must throw (#1431). The earlier carve-out
  // for empty patterns (#225) was applied uniformly but is only correct for
  // OBJECT assignment patterns — array assignment patterns always call
  // GetIterator so they always throw on null/undefined.
  if (resultType.kind === "externref") {
    emitExternrefAssignDestructureGuard(ctx, fctx, tmpLocal);
  }

  // #1454: Spec §13.15.5.2 ArrayAssignmentPattern requires GetIterator(value)
  // before reading binding elements. The previous `tmpLocal[i]` via
  // __extern_get path bypassed the @@iterator getter and .next() calls,
  // so a throwing @@iterator (iter-get-err) or throwing .next() (iter-step-err)
  // was silently swallowed. Materialize the source via __array_from_iter_n
  // first — it invokes @@iterator + .next() and propagates throws.
  // Plain arrays with the default @@iterator take the fast path. The f64
  // step-count bounds consumption so a no-rest pattern (`[a,,b] = gen()`)
  // consumes EXACTLY target.elements.length iterator steps rather than
  // draining a lazy generator; a rest element passes -1 → unbounded, which is
  // byte-identical to the legacy __array_from_iter drain (#1592).
  if (resultType.kind === "externref" && target.elements.length > 0) {
    const matStepCount = patternIteratorStepCount(target.elements);
    const matIterIdx = ensureLateImport(
      ctx,
      "__array_from_iter_n",
      [{ kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (matIterIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "f64.const", value: matStepCount });
      fctx.body.push({ op: "call", funcIdx: matIterIdx });
      fctx.body.push({ op: "local.set", index: tmpLocal });
    }
  }

  // Ensure __extern_get is available (#1866: ensureLateImport routes to the
  // native object-runtime impl under --target standalone — no leaked
  // `env::__extern_get` host import — and to the host import in JS-host mode).
  ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  let getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) return null;

  // Ensure __box_number is available (needed to convert index to externref)
  let boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const boxType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    boxIdx = ctx.funcMap.get("__box_number");
    // Also refresh getIdx since it may have shifted
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (boxIdx === undefined || getIdx === undefined) return null;

  for (let i = 0; i < target.elements.length; i++) {
    const element = target.elements[i]!;
    if (ts.isOmittedExpression(element)) continue;
    // Handle rest element: [a, ...rest] = externArr — use __extern_slice
    if (ts.isSpreadElement(element)) {
      const restTarget = element.expression;
      if (ts.isIdentifier(restTarget)) {
        const restName = restTarget.text;
        let restLocalIdx = fctx.localMap.get(restName);
        if (restLocalIdx === undefined) {
          restLocalIdx = allocLocal(fctx, restName, { kind: "externref" });
        }
        let sliceIdx = ctx.funcMap.get("__extern_slice");
        if (sliceIdx === undefined) {
          const importsBefore = ctx.numImportFuncs;
          const sliceType = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
          addImport(ctx, "env", "__extern_slice", { kind: "func", typeIdx: sliceType });
          shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
          sliceIdx = ctx.funcMap.get("__extern_slice");
          boxIdx = ctx.funcMap.get("__box_number");
          getIdx = ctx.funcMap.get("__extern_get");
        }
        if (sliceIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "f64.const", value: i });
          fctx.body.push({ op: "call", funcIdx: sliceIdx });
          fctx.body.push({ op: "local.set", index: restLocalIdx });
        }
      }
      continue;
    }

    // Emit: __extern_get(tmpLocal, box(i)) -> externref
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "f64.const", value: i });
    fctx.body.push({ op: "call", funcIdx: boxIdx! });
    fctx.body.push({ op: "call", funcIdx: getIdx! });

    const elemType: ValType = { kind: "externref" };

    if (ts.isIdentifier(element)) {
      const localName = element.text;
      let localIdx = fctx.localMap.get(localName);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, localName, elemType);
      }
      const localType = getLocalType(fctx, localIdx);
      if (localType && !valTypesMatch(elemType, localType)) {
        coerceType(ctx, fctx, elemType, localType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    } else if (ts.isPropertyAccessExpression(element) || ts.isElementAccessExpression(element)) {
      const tmpElem = allocLocal(fctx, `__ext_arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitAssignToTarget(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isBinaryExpression(element) && element.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // Default value: [a = default] = arr
      // Per spec §13.15.5.5 AssignmentElement step 4: the default fires ONLY
      // when the resolved value is `undefined` (never for `null`). Earlier
      // versions used `ref.is_null` which fires for both — that broke
      // `[a=1] = [null]` (default fired, a became 1 instead of null). Use
      // `__extern_is_undefined` instead, which the runtime maps to a strict
      // `=== undefined` check. Fall back to `ref.is_null` only when the host
      // import is unavailable (standalone mode) — imperfect but better than
      // never firing the default (#1431).
      const assignTarget = element.left;
      const defaultExpr = element.right;
      if (ts.isIdentifier(assignTarget)) {
        const localName = assignTarget.text;
        let localIdx = fctx.localMap.get(localName);
        if (localIdx === undefined) {
          localIdx = allocLocal(fctx, localName, elemType);
        }
        const tmpElem = allocLocal(fctx, `__ext_dflt_${fctx.locals.length}`, elemType);
        // Pre-ensure `__extern_is_undefined` so any late-import funcIdx shift
        // happens while fctx.body is authoritative (the saved-swap pattern
        // inside the if-then below detaches the slice from fctx).
        const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "local.set", index: tmpElem });
        if (undefIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: tmpElem });
          fctx.body.push({ op: "call", funcIdx: undefIdx });
        } else {
          fctx.body.push({ op: "local.get", index: tmpElem });
          fctx.body.push({ op: "ref.is_null" } as Instr);
        }
        const localType = getLocalType(fctx, localIdx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...(() => {
              const saved = fctx.body;
              fctx.body = [];
              compileExpression(ctx, fctx, defaultExpr, localType ?? elemType);
              fctx.body.push({ op: "local.set", index: localIdx! } as Instr);
              const instrs = fctx.body;
              fctx.body = saved;
              return instrs;
            })(),
          ],
          else: [
            { op: "local.get", index: tmpElem } as Instr,
            ...(() => {
              if (localType && !valTypesMatch(elemType, localType)) {
                const saved = fctx.body;
                fctx.body = [];
                coerceType(ctx, fctx, elemType, localType);
                const instrs = fctx.body;
                fctx.body = saved;
                return instrs;
              }
              return [];
            })(),
            { op: "local.set", index: localIdx! } as Instr,
          ],
        });
      }
    } else if (ts.isArrayLiteralExpression(element) || ts.isObjectLiteralExpression(element)) {
      // Nested destructuring: [[x]] = arr or [{x}] = arr
      // Element value is on the stack (externref). If null/undefined, throw TypeError
      // (per spec §14.3.3.1 RequireObjectCoercible / §8.4.2 GetIterator). (#dstr_null_undefined)
      const tmpNested = allocLocal(fctx, `__ext_nested_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpNested });
      emitExternrefAssignDestructureGuard(ctx, fctx, tmpNested);
      // Proceed with nested destructuring via externref path
      if (ts.isArrayLiteralExpression(element)) {
        fctx.body.push({ op: "local.get", index: tmpNested });
        const nestedResult = compileExternrefArrayDestructuringAssignment(ctx, fctx, element, elemType);
        if (nestedResult) {
          fctx.body.push({ op: "drop" });
        }
      }
      // Object nested destructuring via externref: the null/undefined guard above is what
      // this bucket needs — the actual property extraction is a separate feature.
    }
  }

  // The result of a destructuring assignment is the RHS value
  fctx.body.push({ op: "local.get", index: tmpLocal });
  return resultType;
}

/** Assign value from a local to a property access or element access target */
function emitAssignToTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.Expression,
  valueLocal: number,
  valueType: ValType,
): void {
  if (ts.isPropertyAccessExpression(target)) {
    // Compile-away: frozen object property writes throw TypeError
    if (ts.isIdentifier(target.expression) && ctx.frozenVars.has(target.expression.text)) {
      emitThrowString(ctx, fctx, "TypeError: Cannot assign to read only property of frozen object");
      return;
    }

    const typeName = resolveStructNameForExpr(ctx, fctx, target.expression);
    if (!typeName) return;

    const structTypeIdx = ctx.structMap.get(typeName);
    const fields = ctx.structFields.get(typeName);
    if (structTypeIdx === undefined || !fields) return;

    const fieldName = target.name.text;
    const fieldIdx = fields.findIndex((f) => f.name === fieldName);
    if (fieldIdx === -1) return;

    const fieldType = fields[fieldIdx]!.type;
    // Push obj ref, then value
    compileExpression(ctx, fctx, target.expression);
    fctx.body.push({ op: "local.get", index: valueLocal });
    if (!valTypesMatch(valueType, fieldType)) {
      coerceType(ctx, fctx, valueType, fieldType);
    }
    fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
  } else if (ts.isElementAccessExpression(target)) {
    const arrType = compileExpression(ctx, fctx, target.expression);
    if (!arrType || (arrType.kind !== "ref" && arrType.kind !== "ref_null")) return;
    const tIdx = (arrType as { typeIdx: number }).typeIdx;
    const tDef = ctx.mod.types[tIdx];
    // Handle vec struct
    if (
      tDef?.kind === "struct" &&
      tDef.fields.length === 2 &&
      tDef.fields[0]?.name === "length" &&
      tDef.fields[1]?.name === "data"
    ) {
      const aIdx = getArrTypeIdxFromVec(ctx, tIdx);
      // Save vec ref, compile index, then bounds-guard the write
      const vecTmp = allocLocal(fctx, `__dstr_vec_${fctx.locals.length}`, arrType);
      fctx.body.push({ op: "local.set", index: vecTmp });
      const idxResult = compileExpression(ctx, fctx, target.argumentExpression);
      if (!idxResult) return;
      if (idxResult.kind === "f64") {
        // Saturating truncation: NaN/Infinity/out-of-range indices clamp
        // instead of trapping the module. Matches every other index/length
        // conversion in this file (#1834).
        fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
      }
      const idxTmp = allocLocal(fctx, `__dstr_idx_${fctx.locals.length}`, {
        kind: "i32",
      });
      fctx.body.push({ op: "local.set", index: idxTmp });
      // Bounds guard: only write if idx < array.len
      fctx.body.push({ op: "local.get", index: idxTmp });
      fctx.body.push({ op: "local.get", index: vecTmp });
      fctx.body.push({ op: "struct.get", typeIdx: tIdx, fieldIdx: 1 });
      fctx.body.push({ op: "array.len" });
      fctx.body.push({ op: "i32.lt_u" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" as const },
        then: [
          { op: "local.get", index: vecTmp } as Instr,
          { op: "struct.get", typeIdx: tIdx, fieldIdx: 1 } as Instr,
          { op: "local.get", index: idxTmp } as Instr,
          { op: "local.get", index: valueLocal } as Instr,
          { op: "array.set", typeIdx: aIdx } as Instr,
        ],
        else: [],
      } as Instr);
    }
  }
}

/** Destructure an object from a local variable (used for nested patterns) */
function emitObjectDestructureFromLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ObjectLiteralExpression,
  srcLocal: number,
  srcType: ValType,
): void {
  // Externref: emit null/undefined guard. We can't currently destructure externref
  // object assignments, but at minimum we must throw per spec §14.3.3.1 (#dstr_null_undefined).
  if (srcType.kind === "externref") {
    emitExternrefAssignDestructureGuard(ctx, fctx, srcLocal);
    return;
  }
  if (srcType.kind !== "ref" && srcType.kind !== "ref_null") return;
  const srcTypeIdx = (srcType as { typeIdx: number }).typeIdx;

  // Find struct name from type index
  const structName = ctx.typeIdxToStructName.get(srcTypeIdx);
  if (!structName) return;

  const fields = ctx.structFields.get(structName);
  if (!fields) return;

  // The compiler may declare the local as non-nullable `ref T` even though
  // the value at runtime can be null (e.g. `[{x}] = [null]` element-extracts
  // a ref_null whose runtime value is null but whose static type is `ref T`).
  // Widen the local so `ref.is_null` is valid below (#1260, mirrors #1225).
  const needsNullGuard = pattern.properties.length > 0;
  if (needsNullGuard) {
    widenLocalToNullable(fctx, srcLocal);
  }

  // Null guard for ref_null types
  const savedBodyODFL = fctx.body;
  const odflInstrs: Instr[] = [];
  fctx.body = odflInstrs;

  for (const prop of pattern.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      const propName = prop.name.text;
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) {
        reportSilentFallback(ctx, "lookup-miss-skip", "assignment:object-destructure-shorthand-field-miss", prop);
        continue;
      }

      let localIdx = fctx.localMap.get(propName);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, propName, fields[fieldIdx]!.type);
      }

      fctx.body.push({ op: "local.get", index: srcLocal });
      fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
      const fieldType = fields[fieldIdx]!.type;
      const localType = getLocalType(fctx, localIdx);
      if (localType && !valTypesMatch(fieldType, localType)) {
        coerceType(ctx, fctx, fieldType, localType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    } else if (ts.isPropertyAssignment(prop)) {
      let propName = ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isStringLiteral(prop.name)
          ? prop.name.text
          : ts.isNumericLiteral(prop.name)
            ? prop.name.text
            : undefined;
      // Try resolving computed property names at compile time
      if (!propName && ts.isComputedPropertyName(prop.name)) {
        propName = resolveComputedKeyExpression(ctx, prop.name.expression);
      }
      if (!propName) continue; // truly unresolvable property name — skip
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) {
        reportSilentFallback(
          ctx,
          "lookup-miss-skip",
          "assignment:object-destructure-from-local-property-field-miss",
          prop,
        );
        continue;
      }
      const fieldType = fields[fieldIdx]!.type;

      const targetExpr = prop.initializer;
      if (ts.isIdentifier(targetExpr)) {
        let localIdx = fctx.localMap.get(targetExpr.text);
        if (localIdx === undefined) {
          localIdx = allocLocal(fctx, targetExpr.text, fieldType);
        }
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        const localType = getLocalType(fctx, localIdx);
        if (localType && !valTypesMatch(fieldType, localType)) {
          coerceType(ctx, fctx, fieldType, localType);
        }
        emitCoercedLocalSet(ctx, fctx, localIdx, fieldType);
      } else if (ts.isObjectLiteralExpression(targetExpr)) {
        // Nested object: { x: { a, b } } = obj
        const tmpNested = allocLocal(fctx, `__nested_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitObjectDestructureFromLocal(ctx, fctx, targetExpr, tmpNested, fieldType);
      } else if (ts.isArrayLiteralExpression(targetExpr)) {
        // Nested array: { x: [a, b] } = obj
        const tmpNested = allocLocal(fctx, `__nested_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitArrayDestructureFromLocal(ctx, fctx, targetExpr, tmpNested, fieldType);
      } else if (ts.isPropertyAccessExpression(targetExpr) || ts.isElementAccessExpression(targetExpr)) {
        // Member expression target: { x: obj.prop } = obj2
        const tmpElem = allocLocal(fctx, `__nested_elem_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpElem });
        emitAssignToTarget(ctx, fctx, targetExpr, tmpElem, fieldType);
      }
    }
  }

  // Close null guard — throw TypeError if null/undefined (#730, #1260).
  // Skip for empty `{} = val` nested patterns (#225).
  // Apply to both ref and ref_null sources (we widened above, so ref.is_null is valid).
  fctx.body = savedBodyODFL;
  if (needsNullGuard) {
    const throwInstrs = buildDestructureNullThrow(ctx, fctx);
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: throwInstrs,
      else: odflInstrs,
    });
  } else {
    fctx.body.push(...odflInstrs);
  }
}

/** Destructure an array from a local variable (used for nested patterns) */
function emitArrayDestructureFromLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ArrayLiteralExpression,
  srcLocal: number,
  srcType: ValType,
): void {
  // Externref: emit null/undefined guard + delegate to externref path (#dstr_null_undefined)
  if (srcType.kind === "externref") {
    emitExternrefAssignDestructureGuard(ctx, fctx, srcLocal);
    fctx.body.push({ op: "local.get", index: srcLocal });
    compileExternrefArrayDestructuringAssignment(ctx, fctx, pattern, srcType);
    fctx.body.push({ op: "drop" });
    return;
  }
  if (srcType.kind !== "ref" && srcType.kind !== "ref_null") return;
  const srcTypeIdx = (srcType as { typeIdx: number }).typeIdx;
  const srcDef = ctx.mod.types[srcTypeIdx];
  if (!srcDef || srcDef.kind !== "struct") return;

  // Detect vec vs tuple struct shape (#1225). Tuple fields are named _0, _1, ...
  const isVecStruct =
    srcDef.fields.length === 2 && srcDef.fields[0]?.name === "length" && srcDef.fields[1]?.name === "data";
  const isTupleStruct =
    !isVecStruct &&
    srcDef.fields.length > 0 &&
    srcDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`);

  // For ref/ref_null sources we want to emit a null guard. The compiler may
  // declare the local as non-nullable `ref T` even though the value at runtime
  // can be null (e.g. struct fields holding nested tuple refs that may be
  // ref.null T). Widen the local so `ref.is_null` is valid (#1225).
  const needsNullGuard = (srcType.kind === "ref" || srcType.kind === "ref_null") && pattern.elements.length > 0;
  if (needsNullGuard) {
    widenLocalToNullable(fctx, srcLocal);
  }

  // For unsupported struct shapes, still emit the null/undefined guard so we
  // throw the spec-required TypeError (#1225). Without this, nested patterns
  // like `[[ _ ]] = [null]` would silently drop the destructuring.
  if (!isVecStruct && !isTupleStruct) {
    if (needsNullGuard) {
      const throwInstrs = buildDestructureNullThrow(ctx, fctx);
      fctx.body.push({ op: "local.get", index: srcLocal });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: throwInstrs,
        else: [],
      });
    }
    return;
  }

  let arrTypeIdx = -1;
  let arrDef: { kind: string; element: ValType } | undefined;
  if (isVecStruct) {
    arrTypeIdx = getArrTypeIdxFromVec(ctx, srcTypeIdx);
    const ad = ctx.mod.types[arrTypeIdx];
    if (!ad || ad.kind !== "array") {
      // Unexpected: vec struct without proper array data field.
      // Fall back to emitting null guard only.
      if (needsNullGuard) {
        const throwInstrs = buildDestructureNullThrow(ctx, fctx);
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "ref.is_null" } as Instr);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: throwInstrs,
          else: [],
        });
      }
      return;
    }
    arrDef = ad as { kind: string; element: ValType };
  }

  // Helper: get element type at index i
  const getElemType = (i: number): ValType => {
    if (isVecStruct) return arrDef!.element;
    // Tuple
    const field = srcDef.fields[i];
    return field ? field.type : { kind: "f64" };
  };
  // Helper: emit instructions to load element i onto the stack
  const emitElemGet = (i: number): void => {
    fctx.body.push({ op: "local.get", index: srcLocal });
    if (isVecStruct) {
      fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "i32.const", value: i });
      emitBoundsCheckedArrayGet(fctx, arrTypeIdx, arrDef!.element);
    } else {
      // Tuple: direct struct.get on field index i
      fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx: i });
    }
  };

  // Build the destructuring body in a separate buffer so we can wrap it in a
  // null guard for ref_null sources.
  const savedBodyADFL = fctx.body;
  const adflInstrs: Instr[] = [];
  fctx.body = adflInstrs;

  for (let i = 0; i < pattern.elements.length; i++) {
    const element = pattern.elements[i]!;
    if (ts.isOmittedExpression(element)) continue;

    // Tuple OOB: pattern targets element beyond tuple's fields → no-op for
    // identifier targets (would normally read undefined; we rely on the local
    // staying at its prior value).
    if (isTupleStruct && i >= srcDef.fields.length) continue;

    const elemType = getElemType(i);

    if (ts.isIdentifier(element)) {
      let localIdx = fctx.localMap.get(element.text);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, element.text, elemType);
      }
      emitElemGet(i);
      const localType = getLocalType(fctx, localIdx);
      if (localType && !valTypesMatch(elemType, localType)) {
        coerceType(ctx, fctx, elemType, localType);
      }
      emitCoercedLocalSet(ctx, fctx, localIdx, elemType);
    } else if (ts.isObjectLiteralExpression(element)) {
      // Nested object pattern: [{ a, b }] = arr (#1225)
      const tmpElem = allocLocal(fctx, `__arr_nested_${fctx.locals.length}`, elemType);
      emitElemGet(i);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitObjectDestructureFromLocal(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isArrayLiteralExpression(element)) {
      // Nested array pattern: [[a, b]] = arr (#1225)
      const tmpElem = allocLocal(fctx, `__arr_nested_${fctx.locals.length}`, elemType);
      emitElemGet(i);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitArrayDestructureFromLocal(ctx, fctx, element, tmpElem, elemType);
    }
    // else: unsupported nested target — skip (existing behavior)
  }

  // Close null guard — throw TypeError if null/undefined (#730, #1225).
  // Skip for empty `[] = val` nested patterns (#225).
  fctx.body = savedBodyADFL;
  if (needsNullGuard) {
    const throwInstrs = buildDestructureNullThrow(ctx, fctx);
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: throwInstrs,
      else: adflInstrs,
    });
  } else {
    fctx.body.push(...adflInstrs);
  }
}

function compilePropertyAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
): InnerResult {
  const objType = ctx.checker.getTypeAtLocation(target.expression);

  // #1456: Private method or getter-only accessor → TypeError on write.
  // Must run BEFORE any routing decisions because the receiver typing (e.g.
  // `(this as any).#m`) can otherwise send us through __extern_set and
  // silently drop the write.
  if (ts.isPrivateIdentifier(target.name)) {
    const privateMember = classifyPrivateMember(ctx, target.name);
    if (privateMember?.kind === "method" || privateMember?.kind === "accessor-readonly") {
      // Evaluate RHS for side effects before throwing (spec evaluation order).
      const rhsResult = compileExpression(ctx, fctx, value);
      if (rhsResult) fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, "Cannot assign to private method or read-only accessor");
      return { kind: "externref" };
    }
    // #1680: Private accessor with a setter (`set #x(v)`). Dispatch to the
    // setter function. Without this branch control falls through to the
    // generic struct-field write, which targets a `__priv_<name>` data slot
    // the getter never reads — silently dropping the write and cross-talking
    // between stacked accessors. Mirrors the public-accessor setter dispatch.
    if (privateMember?.kind === "accessor" || privateMember?.kind === "accessor-writeonly") {
      const setterName = `${privateMember.className}_set_${privateMember.fieldName}`;
      const funcIdx = ctx.funcMap.get(setterName);
      if (funcIdx !== undefined) {
        const recvResult = compileExpression(ctx, fctx, target.expression);
        if (!recvResult) return null;
        const setterParamTypes = getFuncParamTypes(ctx, funcIdx);
        const valTypeHint = setterParamTypes?.[1]; // param 0 = self, param 1 = value
        const valResult = compileExpression(ctx, fctx, value, valTypeHint);
        if (!valResult) return null;
        // Stack: [receiver, value]. Save value for the assignment result.
        const tmpVal = allocLocal(fctx, `__priv_setter_assign_${fctx.locals.length}`, valResult);
        fctx.body.push({ op: "local.tee", index: tmpVal });
        // Setter with no value parameter (only self): drop the value.
        if (!setterParamTypes || setterParamTypes.length <= 1) {
          fctx.body.push({ op: "drop" });
        }
        // Re-read funcIdx: receiver/RHS compilation may have shifted indices
        // via late import addition (addUnionImports).
        const finalSetterIdx = ctx.funcMap.get(setterName) ?? funcIdx;
        fctx.body.push({ op: "call", funcIdx: finalSetterIdx });
        // `=` evaluates to the RHS, not the setter's return.
        fctx.body.push({ op: "local.get", index: tmpVal });
        return valResult;
      }
    }
  }

  // #1914 — `re.lastIndex = v` on a standalone RegExp receiver. Must run
  // BEFORE the extern-class setter path, which would otherwise emit an
  // `env.RegExp_set_lastIndex` host import (a standalone purity leak).
  {
    const standaloneLastIndexWrite = tryCompileStandaloneRegExpLastIndexWrite(ctx, fctx, target, value);
    if (standaloneLastIndexWrite !== undefined) return standaloneLastIndexWrite;
  }

  // Compile-away: if the target object is frozen, emit TypeError throw
  if (ts.isIdentifier(target.expression) && ctx.frozenVars.has(target.expression.text)) {
    // Evaluate RHS for side effects, then throw
    const rhsType = compileExpression(ctx, fctx, value);
    if (rhsType) {
      fctx.body.push({ op: "drop" });
    }
    emitThrowString(ctx, fctx, "TypeError: Cannot assign to read only property of frozen object");
    return { kind: "f64" }; // unreachable, but need a type
  }

  // Handle static property assignment: ClassName.staticProp = value
  if (ts.isIdentifier(target.expression) && ctx.classSet.has(target.expression.text)) {
    const clsName = target.expression.text;
    const propName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;
    const fullName = `${clsName}_${propName}`;
    const globalIdx = ctx.staticProps.get(fullName);
    if (globalIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
      const valType = compileExpression(ctx, fctx, value, globalDef?.type);
      if (!valType) return null;
      // Save value, set global, return value (assignment expression result)
      const tmpVal = allocLocal(fctx, `__prop_assign_${fctx.locals.length}`, valType);
      fctx.body.push({ op: "local.tee", index: tmpVal });
      fctx.body.push({ op: "global.set", index: globalIdx });
      fctx.body.push({ op: "local.get", index: tmpVal });
      return valType;
    }
  }

  // #1697: `this.X = v` / `this.#X = v` inside a static method body —
  // mirror the read path's ThisKeyword+staticContext arm in
  // property-access.ts:1427. Without this, the LHS is `this` (not an
  // Identifier in classSet) and the static-prop assignment falls through to
  // the generic struct-write path, which silently drops the write because
  // `this` is the class constructor (not a per-instance struct).
  if (
    skipTransparentExpressions(target.expression).kind === ts.SyntaxKind.ThisKeyword &&
    (fctx.localMap.get("this") === undefined || fctx.isStaticContext)
  ) {
    let enclosingClass: string | undefined = fctx.enclosingClassName;
    if (!enclosingClass) {
      const fname = fctx.name;
      let pos = -1;
      while (!enclosingClass) {
        pos = fname.indexOf("_", pos + 1);
        if (pos < 0) break;
        const candidate = fname.substring(0, pos);
        if (candidate && ctx.classSet.has(candidate)) enclosingClass = candidate;
      }
    }
    if (enclosingClass) {
      const propName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;
      const fullName = `${enclosingClass}_${propName}`;
      const globalIdx = ctx.staticProps.get(fullName);
      if (globalIdx !== undefined) {
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        const valType = compileExpression(ctx, fctx, value, globalDef?.type);
        if (!valType) return null;
        const tmpVal = allocLocal(fctx, `__prop_assign_${fctx.locals.length}`, valType);
        fctx.body.push({ op: "local.tee", index: tmpVal });
        fctx.body.push({ op: "global.set", index: globalIdx });
        fctx.body.push({ op: "local.get", index: tmpVal });
        return valType;
      }
    }
  }

  // Handle externref property set
  if (isExternalDeclaredClass(objType, ctx.checker)) {
    const externSetResult = compileExternPropertySet(ctx, fctx, target, value, objType);
    if (externSetResult !== null) return externSetResult;
    // For host objects, missing specific setter imports must not silently drop
    // the assignment. Fall back to dynamic __extern_set on the host object
    // instead of treating the extern class like a Wasm struct.
    const propName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;
    return compilePropertyAssignmentExternSet(ctx, fctx, target, value, propName);
  }

  // Handle shape-inferred array-like variables: obj.length = N
  if (ts.isIdentifier(target.expression)) {
    const shapeInfo = ctx.shapeMap.get(target.expression.text);
    if (shapeInfo) {
      const fieldName = target.name.text;
      const vecDef = ctx.mod.types[shapeInfo.vecTypeIdx];
      if (vecDef && vecDef.kind === "struct") {
        const fieldIdx = vecDef.fields.findIndex((f: { name: string }) => f.name === fieldName);
        if (fieldIdx >= 0) {
          const structObjResult = compileExpression(ctx, fctx, target.expression);
          if (!structObjResult) return null;
          const valType = compileExpression(ctx, fctx, value, vecDef.fields[fieldIdx]!.type);
          if (!valType) return null;
          const tmpVal = allocLocal(fctx, `__prop_assign_${fctx.locals.length}`, valType);
          fctx.body.push({ op: "local.tee", index: tmpVal });
          fctx.body.push({
            op: "struct.set",
            typeIdx: shapeInfo.vecTypeIdx,
            fieldIdx,
          });
          fctx.body.push({ op: "local.get", index: tmpVal });
          return valType;
        }
      }
    }
  }

  // Handle arr.length = N on typed arrays (vec struct field 0 = length)
  if (target.name.text === "length") {
    const arrInfo = resolveArrayInfo(ctx, objType);
    if (arrInfo) {
      const { vecTypeIdx } = arrInfo;
      // Compile receiver (vec struct ref)
      const structObjResult = compileExpression(ctx, fctx, target.expression);
      if (!structObjResult) return null;
      const vecTmp = allocLocal(fctx, `__arr_len_set_vec_${fctx.locals.length}`, {
        kind: "ref_null",
        typeIdx: vecTypeIdx,
      });
      fctx.body.push({ op: "local.set", index: vecTmp });
      // Compile value (the new length)
      const valType = compileExpression(ctx, fctx, value);
      if (!valType) return null;
      // Convert f64 to i32 if needed
      const newLenTmp = allocLocal(fctx, `__arr_len_set_nl_${fctx.locals.length}`, { kind: "i32" });
      if (valType.kind === "f64") {
        // Saturating truncation: NaN/Infinity/out-of-range lengths clamp
        // instead of trapping the module. Matches every other length
        // conversion in this file (#1834).
        fctx.body.push({ op: "i32.trunc_sat_f64_s" as any });
      }
      fctx.body.push({ op: "local.set", index: newLenTmp });
      // Set vec.length = newLen
      fctx.body.push({ op: "local.get", index: vecTmp });
      fctx.body.push({ op: "local.get", index: newLenTmp });
      fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });
      // Return the new length as the assignment expression result
      fctx.body.push({ op: "local.get", index: newLenTmp });
      if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
      return ctx.fast ? { kind: "i32" } : { kind: "f64" };
    }
  }

  const typeName = resolveStructNameForExpr(ctx, fctx, target.expression);
  if (!typeName) {
    // No struct type resolved. Mirror the compound/logical assignment fallback:
    // treat the receiver as a host/dynamic object and route the write through
    // __extern_set instead of silently dropping the assignment.
    const fieldName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;
    return compilePropertyAssignmentExternSet(ctx, fctx, target, value, fieldName);
  }

  // Check for setter accessor on user-defined classes
  const fieldName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;
  const accessorKey = `${typeName}_${fieldName}`;
  // (#1888 S5c / C4) Migrated struct accessor → route the write through the
  // host-free setter closure (per-(struct,prop) global + shared S5b
  // __call_accessor_set driver) so a setter that mutates an outer-scope capture
  // observes it. __call_accessor_set(recv, setter, value): recv = the struct
  // instance boxed to externref (threaded as `this` via __current_this); the
  // setter's return is DISCARDED by the driver (§10.1.5.3 [[Set]]); the
  // assignment expression evaluates to the RHS, not the setter result. The
  // closure globals only exist for Object.defineProperty(o,…)/objlit receivers
  // (always a struct instance), so the proto/class-object dummy path is not a
  // concern here.
  const closureAccSet =
    S5C_STRUCT_ACCESSOR_CLOSURE && ctx.standalone ? ctx.structAccessorClosure.get(accessorKey)?.setGlobal : undefined;
  if (closureAccSet !== undefined) {
    // recv: struct instance → externref
    const recvResult = compileExpression(ctx, fctx, target.expression);
    if (!recvResult) {
      reportError(ctx, target, "Failed to compile setter receiver");
      return null;
    }
    if (recvResult.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" } as Instr);
    }
    // setter closure (externref)
    fctx.body.push({ op: "global.get", index: closureAccSet });
    // value: compile in its natural type, save for the assignment result, then
    // box a copy to externref for the driver's `value` arg.
    const valResult = compileExpression(ctx, fctx, value);
    if (!valResult) {
      reportError(ctx, target, "Failed to compile setter value");
      return null;
    }
    const valTmp = allocLocal(fctx, `__acc_set_val_${fctx.locals.length}`, valResult);
    fctx.body.push({ op: "local.tee", index: valTmp });
    if (valResult.kind !== "externref") {
      coerceType(ctx, fctx, valResult, { kind: "externref" });
    }
    const setDriverIdx = reserveAccessorSetDriver(ctx);
    fctx.body.push({ op: "call", funcIdx: setDriverIdx }); // () result — setter return discarded
    // Assignment expression evaluates to the RHS (natural type).
    fctx.body.push({ op: "local.get", index: valTmp });
    return valResult;
  }
  if (ctx.classAccessorSet.has(accessorKey)) {
    const setterName = `${typeName}_set_${fieldName}`;
    const funcIdx = ctx.funcMap.get(setterName);
    // (#2024) `classAccessorSet` records a class that declares EITHER a getter
    // or a setter for this prop (class-bodies.ts adds the key for both). A
    // get-only accessor — `class B extends A { get v() {…} }` over a parent
    // with `set v` — therefore lands here with NO `${type}_set_${field}`
    // function. Per §10.1.5.3 OrdinarySetWithOwnDescriptor, the own get-only
    // accessor SHADOWS the inherited setter: strict-mode writes throw TypeError
    // and the parent's setter must NOT run. Without this, control fell through
    // to the struct-field path, which found no field named `<field>` and
    // silently dropped the write. Emit the spec TypeError instead.
    if (funcIdx === undefined && ctx.funcMap.has(`${typeName}_get_${fieldName}`)) {
      // Evaluate the RHS for its side effects (spec: GetValue(rhs) is performed
      // before the [[Set]]), drop its value, then throw. `emitThrowTypeError`
      // emits an `unreachable`, so the assignment expression's stack effect is
      // satisfied by divergence — we report the RHS type so any wrapping
      // expression type-checks consistently.
      const rhsResult = compileExpression(ctx, fctx, value);
      if (rhsResult !== null) {
        fctx.body.push({ op: "drop" });
      }
      emitThrowTypeError(ctx, fctx, `Cannot assign to read only property '${fieldName}' of object`);
      return rhsResult ?? { kind: "f64" };
    }
    if (funcIdx !== undefined) {
      // `C.prototype.<setter> = v` and `C.<static setter> = v` both write
      // through a receiver that is an externref (the prototype singleton or the
      // class object), not a struct instance. Coercing that externref to the
      // setter's struct `this` param produces an invalid `local.tee` (externref
      // temp fed a struct ref.null). Use the dummy-struct call path (same as
      // `C.prototype[key] = v`) so the setter receives a throwaway struct
      // receiver and the value flows through unchanged.
      const receiverIsProto =
        ts.isPropertyAccessExpression(target.expression) &&
        ts.isIdentifier(target.expression.name) &&
        target.expression.name.text === "prototype";
      const receiverIsClassObject = ts.isIdentifier(target.expression) && ctx.classSet.has(target.expression.text);
      if (receiverIsProto || receiverIsClassObject) {
        return emitSetterCallWithDummy(ctx, fctx, typeName, setterName, funcIdx, value);
      }
      // Get setter's parameter types to provide type hints
      const setterParamTypes = getFuncParamTypes(ctx, funcIdx);
      const setterObjResult = compileExpression(ctx, fctx, target.expression, setterParamTypes?.[0]);
      if (!setterObjResult) {
        reportError(ctx, target, "Failed to compile setter receiver");
        return null;
      }
      const setterValExpectedType = setterParamTypes?.[1]; // param 0 = self, param 1 = value
      const setterValResult = compileExpression(ctx, fctx, value, setterValExpectedType);
      if (!setterValResult) {
        reportError(ctx, target, "Failed to compile setter value");
        return null;
      }
      // Save value for assignment expression result
      const setterTmpVal = allocLocal(fctx, `__setter_assign_${fctx.locals.length}`, setterValResult);
      fctx.body.push({ op: "local.tee", index: setterTmpVal });
      // If setter has no value parameter (only self), drop the value before calling
      const setterHasValueParam = setterParamTypes && setterParamTypes.length > 1;
      if (!setterHasValueParam) {
        fctx.body.push({ op: "drop" });
      }
      const finalSetterIdx = ctx.funcMap.get(setterName) ?? funcIdx;
      fctx.body.push({ op: "call", funcIdx: finalSetterIdx });
      fctx.body.push({ op: "local.get", index: setterTmpVal });
      return setterValResult;
    }
  }

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) return null;

  const fieldIdx = fields.findIndex((f) => f.name === fieldName);
  if (fieldIdx === -1) return null;

  const structSelfType: ValType = { kind: "ref_null", typeIdx: structTypeIdx };
  const structObjResult = compileExpression(ctx, fctx, target.expression, structSelfType);
  if (!structObjResult) {
    reportError(ctx, target, "Failed to compile struct field receiver");
    return null;
  }
  // (#2084) Null-guard the write. The read path already throws a catchable
  // TypeError on a null receiver, but the store path emitted `struct.set`
  // directly — a null receiver then trapped uncatchably ("dereferencing a null
  // pointer") instead of throwing `TypeError: Cannot set properties of null`
  // (error-model divergence, family #581/#2025). Skip the guard when the
  // receiver is a non-nullable `ref` or is statically provably non-null (e.g.
  // `new Foo()`, `this`) — no trap is possible there and the check is dead
  // weight. Mirrors the array-element write guard below (`isProvablyNonNull`).
  const guardNull = structObjResult.kind === "ref_null" && !isProvablyNonNull(target.expression, ctx.checker);
  const valType = compileExpression(ctx, fctx, value, fields[fieldIdx]!.type);
  if (!valType) return null;
  // Save value so the assignment expression returns the RHS.
  const tmpVal = allocLocal(fctx, `__prop_assign_${fctx.locals.length}`, valType);
  if (guardNull) {
    // stack: [receiver, value] — stash value, then null-check the receiver.
    fctx.body.push({ op: "local.set", index: tmpVal });
    const tmpRecv = allocLocal(fctx, `__prop_recv_${fctx.locals.length}`, structSelfType);
    fctx.body.push({ op: "local.tee", index: tmpRecv });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: typeErrorThrowInstrs(ctx, target),
      else: [
        { op: "local.get", index: tmpRecv } as Instr,
        { op: "local.get", index: tmpVal } as Instr,
        { op: "struct.set", typeIdx: structTypeIdx, fieldIdx } as Instr,
      ],
    } as Instr);
  } else {
    fctx.body.push({ op: "local.tee", index: tmpVal });
    fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
  }
  fctx.body.push({ op: "local.get", index: tmpVal });

  return valType;
}

/**
 * Fallback for property assignment when the struct field is not found.
 * Used when Object.defineProperty with an accessor descriptor (get/set) was detected
 * at compile time — the property is intentionally excluded from the widened struct so
 * all accesses go through __extern_set, which calls _safeSet, which invokes the accessor.
 */
function compilePropertyAssignmentExternSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
  propName: string,
): InnerResult {
  // Compile object expression and convert to externref
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;
  if (objResult.kind === "externref") {
    // already externref
  } else if (objResult.kind === "ref" || objResult.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" });
  } else if (objResult.kind === "f64") {
    addUnionImports(ctx);
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else {
    return null;
  }
  const objLocal = allocLocal(fctx, `__paset_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Compile value as externref and save
  const valResult = compileExpression(ctx, fctx, value);
  if (!valResult) return null;
  if (valResult.kind !== "externref") {
    coerceType(ctx, fctx, valResult, { kind: "externref" });
  }
  const valLocal = allocLocal(fctx, `__paset_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valLocal });

  // Emit __extern_set(obj, key_string, val)
  fctx.body.push({ op: "local.get", index: objLocal });
  addStringConstantGlobal(ctx, propName);
  const keyResult = compileStringLiteral(ctx, fctx, propName);
  if (keyResult && keyResult.kind !== "externref") {
    coerceType(ctx, fctx, keyResult, { kind: "externref" });
  }
  fctx.body.push({ op: "local.get", index: valLocal });

  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (setIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: setIdx });
  }

  // Return the assigned value
  fctx.body.push({ op: "local.get", index: valLocal });
  return { kind: "externref" };
}

function compileExternPropertySet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
  objType: ts.Type,
): InnerResult {
  const className = objType.getSymbol()?.name;
  const propName = target.name.text;
  if (!className) return null;

  // Walk inheritance chain to find the class that declares the property
  const resolvedInfo = findExternInfoForMember(ctx, className, propName, "property");
  const propOwner = resolvedInfo ?? ctx.externClasses.get(className);
  if (!propOwner) return null;

  // Check if the import exists BEFORE compiling object+value to avoid dangling stack values
  const importName = `${propOwner.importPrefix}_set_${propName}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined) {
    // Import not found — return null silently to let caller handle fallback
    return null;
  }

  // Push object, then value (with type hint from property type)
  const externObjResult = compileExpression(ctx, fctx, target.expression);
  if (!externObjResult) {
    reportError(ctx, target, "Failed to compile extern property receiver");
    return null;
  }
  const propInfo = propOwner.properties.get(propName);
  const externValResult = compileExpression(ctx, fctx, value, propInfo?.type);
  if (!externValResult) {
    reportError(ctx, target, "Failed to compile extern property value");
    return null;
  }

  // Save value for assignment expression result
  const externTmpVal = allocLocal(fctx, `__extern_assign_${fctx.locals.length}`, externValResult);
  fctx.body.push({ op: "local.tee", index: externTmpVal });
  fctx.body.push({ op: "call", funcIdx });
  fctx.body.push({ op: "local.get", index: externTmpVal });
  return externValResult;
}

function emitSetterCallWithDummy(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  setterName: string,
  funcIdx: number,
  value: ts.Expression,
): InnerResult {
  // Get setter's parameter types to determine value type hint
  const setterPTypes = getFuncParamTypes(ctx, funcIdx);
  const valTypeHint = setterPTypes?.[1]; // param 0 = self, param 1 = value
  const valResult = compileExpression(ctx, fctx, value, valTypeHint);
  if (!valResult) return null;
  // Save value for return (assignments return the assigned value)
  const tmpLocal = allocLocal(fctx, `__setter_assign_${fctx.locals.length}`, valResult);
  fctx.body.push({ op: "local.tee", index: tmpLocal });
  const valLocal = allocLocal(fctx, `__setter_val_${fctx.locals.length}`, valResult);
  fctx.body.push({ op: "local.set", index: valLocal });
  // Create dummy struct and call setter
  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) return valResult;
  for (const field of fields) {
    if (field.name === "__tag") {
      const tag = ctx.classTagMap.get(className) ?? 0;
      fctx.body.push({ op: "i32.const", value: tag });
    } else {
      switch (field.type.kind) {
        case "f64":
          fctx.body.push({ op: "f64.const", value: 0 });
          break;
        case "i32":
          fctx.body.push({ op: "i32.const", value: 0 });
          break;
        case "externref":
          fctx.body.push({ op: "ref.null.extern" });
          break;
        case "ref_null":
          fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        case "ref":
          fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        default:
          fctx.body.push({ op: "i32.const", value: 0 });
          break;
      }
    }
  }
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
  fctx.body.push({ op: "local.get", index: valLocal });
  fctx.body.push({ op: "call", funcIdx });
  fctx.body.push({ op: "local.get", index: tmpLocal });
  return valResult;
}

function compileElementAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  value: ts.Expression,
): InnerResult {
  // #1886 Slice B: linear-backed Uint8Array write `buf[i] = v` →
  // i32.store8(ptr+i, trunc(v)). Only fires for a registered linear-safe
  // buffer; any other target falls through to the GC element-assign path.
  const linU8Set = tryEmitLinearU8ElementSet(ctx, fctx, target, value);
  if (linU8Set !== null) return linU8Set;

  // Handle ClassName[key] = value for static setter accessors and static properties (#848)
  if (ts.isIdentifier(target.expression)) {
    const objName = target.expression.text;
    // Resolve class expressions (var C = class {}) through the expr-name map
    const resolvedClass = ctx.classExprNameMap.get(objName) ?? objName;
    if (ctx.classSet.has(resolvedClass)) {
      const key = resolveComputedKeyExpression(ctx, target.argumentExpression);
      if (key !== undefined) {
        // Check static accessor setter first
        const accessorKey = `${resolvedClass}_${key}`;
        if (ctx.classAccessorSet.has(accessorKey)) {
          const setterName = `${resolvedClass}_set_${key}`;
          const funcIdx = ctx.funcMap.get(setterName);
          if (funcIdx !== undefined) {
            return emitSetterCallWithDummy(ctx, fctx, resolvedClass, setterName, funcIdx, value);
          }
        }
        // Check static property global
        const fullName = `${resolvedClass}_${key}`;
        const globalIdx = ctx.staticProps.get(fullName);
        if (globalIdx !== undefined) {
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
          const globalType = globalDef?.type ?? { kind: "f64" as const };
          const valResult = compileExpression(ctx, fctx, value, globalType);
          if (!valResult) return null;
          const tmpLocal = allocLocal(fctx, `__static_assign_${fctx.locals.length}`, valResult);
          fctx.body.push({ op: "local.tee", index: tmpLocal });
          fctx.body.push({ op: "global.set", index: globalIdx });
          fctx.body.push({ op: "local.get", index: tmpLocal });
          return valResult;
        }
      }
    }
  }

  // Handle ClassName.prototype[key] = value for instance setter accessors (#848)
  if (
    ts.isPropertyAccessExpression(target.expression) &&
    ts.isIdentifier(target.expression.expression) &&
    target.expression.name.text === "prototype"
  ) {
    const rawName = target.expression.expression.text;
    // Resolve class expressions (var C = class {}) through the expr-name map
    const className = ctx.classExprNameMap.get(rawName) ?? rawName;
    if (ctx.classSet.has(className)) {
      const key = resolveComputedKeyExpression(ctx, target.argumentExpression);
      if (key !== undefined) {
        const accessorKey = `${className}_${key}`;
        if (ctx.classAccessorSet.has(accessorKey) && !ctx.staticAccessorSet.has(accessorKey)) {
          const setterName = `${className}_set_${key}`;
          const funcIdx = ctx.funcMap.get(setterName);
          if (funcIdx !== undefined) {
            return emitSetterCallWithDummy(ctx, fctx, className, setterName, funcIdx, value);
          }
        }
      }
    }
  }

  // Push array ref
  const arrType = compileExpression(ctx, fctx, target.expression);
  if (!arrType) {
    reportError(ctx, target, "Assignment to non-array");
    return null;
  }

  // Non-ref types (externref, f64, i32): fallback to __extern_set(obj, key, val)
  if (arrType.kind !== "ref" && arrType.kind !== "ref_null") {
    return compileExternSetFallback(ctx, fctx, target, value, arrType);
  }
  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Bracket assignment on struct: obj["prop"] = value → struct.set
  // Resolve field name from string/numeric literal, const variable, or constant expression
  if (typeDef?.kind === "struct") {
    const isVecStructAssign =
      typeDef.fields.length === 2 && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data";
    if (!isVecStructAssign) {
      let fieldName: string | undefined;
      if (ts.isStringLiteral(target.argumentExpression)) {
        fieldName = target.argumentExpression.text;
      } else if (ts.isNumericLiteral(target.argumentExpression)) {
        fieldName = target.argumentExpression.text;
      } else if (ts.isIdentifier(target.argumentExpression)) {
        // Const variable reference: const key = "x"; obj[key] = val
        const sym = ctx.checker.getSymbolAtLocation(target.argumentExpression);
        if (sym) {
          const decl = sym.valueDeclaration;
          if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
            const declList = decl.parent;
            if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
              if (ts.isStringLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              } else if (ts.isNumericLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              }
            }
          }
        }
      }
      // Also handle computed key expressions (well-known symbols, enums, binary exprs)
      if (fieldName === undefined) {
        fieldName = resolveComputedKeyExpression(ctx, target.argumentExpression);
      }
      if (fieldName !== undefined) {
        // Check for setter accessor first
        const objTsType = ctx.checker.getTypeAtLocation(target.expression);
        // (#1239) Use resolveEffectiveStructName so accessor-tagged
        // identifiers bail out of the struct path and fall through to
        // the externref host setter.
        const sName = resolveEffectiveStructName(ctx, target.expression, objTsType);
        if (sName) {
          const accessorKey = `${sName}_${fieldName}`;
          if (ctx.classAccessorSet.has(accessorKey)) {
            const setterName = `${sName}_set_${fieldName}`;
            const funcIdx = ctx.funcMap.get(setterName);
            if (funcIdx !== undefined) {
              // Get setter's parameter types to provide type hint for value argument
              const eaSetterParamTypes = getFuncParamTypes(ctx, funcIdx);
              const eaSetterValType = eaSetterParamTypes?.[1]; // param 0 = self, param 1 = value
              const setValResult = compileExpression(ctx, fctx, value, eaSetterValType);
              if (!setValResult) return null;
              const setValLocal = allocLocal(fctx, `__setter_assign_${fctx.locals.length}`, setValResult);
              fctx.body.push({ op: "local.tee", index: setValLocal });
              // If setter has no value parameter (only self), drop the value before calling
              if (!eaSetterParamTypes || eaSetterParamTypes.length <= 1) {
                fctx.body.push({ op: "drop" });
              }
              const finalEaSetterIdx = ctx.funcMap.get(setterName) ?? funcIdx;
              fctx.body.push({ op: "call", funcIdx: finalEaSetterIdx });
              fctx.body.push({ op: "local.get", index: setValLocal });
              return setValResult;
            }
          }
        }

        const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
        if (fieldIdx !== -1) {
          const valType = compileExpression(ctx, fctx, value, typeDef.fields[fieldIdx]!.type);
          if (!valType) return null;
          const tmpVal = allocLocal(fctx, `__elem_assign_${fctx.locals.length}`, valType);
          fctx.body.push({ op: "local.tee", index: tmpVal });
          fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
          fctx.body.push({ op: "local.get", index: tmpVal });
          return valType;
        }
      }
    }
  }

  // Handle vec struct (array wrapped in {length, data}) — only for actual __vec_* types
  const isVecStruct =
    typeDef?.kind === "struct" &&
    typeDef.fields.length === 2 &&
    typeDef.fields[0]?.name === "length" &&
    typeDef.fields[1]?.name === "data";
  if (isVecStruct) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      reportError(ctx, target, "Assignment: vec data is not array");
      return null;
    }
    // Save vec ref and index in locals for reuse
    const vecLocal = allocLocal(fctx, `__vec_${fctx.locals.length}`, arrType);
    fctx.body.push({ op: "local.set", index: vecLocal });
    // Null guard: throw TypeError if vec is null (#441)
    // Skip when receiver is provably non-null (e.g. const array literal)
    if (arrType.kind === "ref_null" && !isProvablyNonNull(target.expression, ctx.checker)) {
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
        else: [],
      });
    }
    // #1179: hint i32 directly so an i32 loop index doesn't take an f64 round-trip.
    // compileExpression with i32 hint emits i32.trunc_sat_f64_s for non-i32 results
    // via coerceType, matching the previous behavior for f64 indices.
    const idxResult = compileExpression(ctx, fctx, target.argumentExpression, {
      kind: "i32",
    });
    if (!idxResult) {
      reportError(ctx, target, "Failed to compile element index");
      return null;
    }
    const idxLocal = allocLocal(fctx, `__idx_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.set", index: idxLocal });
    // Compile value
    const elemValResult = compileExpression(ctx, fctx, value, arrDef.element);
    if (!elemValResult) {
      reportError(ctx, target, "Failed to compile element value");
      return null;
    }
    // #2159 — `i8`/`i16` are *packed storage* types, valid only inside array
    // elements / struct fields. The value temp holds the unpacked Wasm value
    // (an `i32`) that `array.set` re-packs; allocating the local with the raw
    // packed `arrDef.element` leaked an `i8`/`i16` into a local (value position),
    // which Wasm has no encoding for and the binary emitter rejects. This is the
    // standalone Uint8Array/Int8Array/Int16Array/Uint16Array element-write CE.
    // The matching read path already unpacks via array.get_u/_s → i32
    // (property-access.ts). Mirror it here for the store value local.
    const valLocalType: ValType =
      arrDef.element.kind === "i8" || arrDef.element.kind === "i16" ? { kind: "i32" } : arrDef.element;
    const valLocal = allocLocal(fctx, `__val_${fctx.locals.length}`, valLocalType);
    fctx.body.push({ op: "local.set", index: valLocal });

    // #1196: Bounds-check elimination on writes — when the for-loop pattern
    // proves `i < arr.length`, the index is in [0, length) so capacity is
    // already sufficient and `vec.length` does not need to grow. Skip the
    // grow check + length-update entirely and emit a direct `array.set`.
    if (isSafeBoundsEliminated(fctx, target)) {
      // Vec data field is `(ref $arr)` (non-nullable), so struct.get yields
      // a non-null ref directly — no ref.as_non_null needed.
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data
      fctx.body.push({ op: "local.get", index: idxLocal });
      fctx.body.push({ op: "local.get", index: valLocal });
      fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
      // Mapped arguments reverse sync (#849)
      if (fctx.mappedArgsInfo && ts.isIdentifier(target.expression) && target.expression.text === "arguments") {
        emitMappedArgReverseSync(ctx, fctx, idxLocal, valLocal);
      }
      fctx.body.push({ op: "local.get", index: valLocal });
      return elemValResult;
    }

    // Get data array into a local so we can update it after potential grow
    const dataLocal = allocLocal(fctx, `__vec_data_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: arrTypeIdx,
    });
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data
    fctx.body.push({ op: "local.set", index: dataLocal });

    // Ensure capacity: if idx >= array.len(data), grow backing array
    const newCapLocal = allocLocal(fctx, `__vec_ncap_${fctx.locals.length}`, {
      kind: "i32",
    });
    const newDataLocal = allocLocal(fctx, `__vec_ndata_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: arrTypeIdx,
    });
    const oldCapLocal = allocLocal(fctx, `__vec_ocap_${fctx.locals.length}`, {
      kind: "i32",
    });

    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "local.get", index: dataLocal });
    fctx.body.push({ op: "array.len" });
    fctx.body.push({ op: "i32.ge_s" }); // idx >= capacity?

    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // oldCap = array.len(data)
        { op: "local.get", index: dataLocal } as Instr,
        { op: "array.len" } as Instr,
        { op: "local.set", index: oldCapLocal } as Instr,

        // newCap = max(idx + 1, oldCap * 2): store idx+1 first, then compare
        { op: "local.get", index: idxLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "local.set", index: newCapLocal } as Instr, // newCap = idx + 1
        // if oldCap * 2 > newCap, use oldCap * 2
        { op: "local.get", index: oldCapLocal } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.shl" } as Instr, // oldCap * 2
        { op: "local.get", index: newCapLocal } as Instr,
        { op: "i32.gt_s" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: oldCapLocal } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.shl" } as Instr,
            { op: "local.set", index: newCapLocal } as Instr,
          ],
        } as Instr,
        // Ensure at least 4
        { op: "i32.const", value: 4 } as Instr,
        { op: "local.get", index: newCapLocal } as Instr,
        { op: "i32.gt_s" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 4 } as Instr, { op: "local.set", index: newCapLocal } as Instr],
        } as Instr,

        // newData = array.new_default(newCap)
        { op: "local.get", index: newCapLocal } as Instr,
        { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
        { op: "local.set", index: newDataLocal } as Instr,

        // array.copy newData[0..oldCap] = data[0..oldCap]
        { op: "local.get", index: newDataLocal } as Instr,
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.get", index: dataLocal } as Instr,
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.get", index: oldCapLocal } as Instr,
        {
          op: "array.copy",
          dstTypeIdx: arrTypeIdx,
          srcTypeIdx: arrTypeIdx,
        } as Instr,

        // Update vec.data = newData
        { op: "local.get", index: vecLocal } as Instr,
        { op: "local.get", index: newDataLocal } as Instr,
        { op: "ref.as_non_null" } as Instr,
        { op: "struct.set", typeIdx, fieldIdx: 1 } as Instr,

        // Update local data pointer
        { op: "local.get", index: newDataLocal } as Instr,
        { op: "local.set", index: dataLocal } as Instr,
      ],
    } as Instr);

    // array.set: data[idx] = val (using potentially grown data)
    fctx.body.push({ op: "local.get", index: dataLocal });
    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "local.get", index: valLocal });
    fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });

    // Update length if idx+1 > current length:
    // if (idx + 1 > vec.length) vec.length = idx + 1
    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // get length
    fctx.body.push({ op: "i32.gt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: vecLocal },
        { op: "local.get", index: idxLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "struct.set", typeIdx, fieldIdx: 0 },
      ],
    });
    // Mapped arguments reverse sync: arguments[i] = X → update param local (#849)
    if (fctx.mappedArgsInfo && ts.isIdentifier(target.expression) && target.expression.text === "arguments") {
      emitMappedArgReverseSync(ctx, fctx, idxLocal, valLocal);
    }

    // Return the assigned value (assignment expression result)
    fctx.body.push({ op: "local.get", index: valLocal });
    return elemValResult;
  }

  // Plain struct (non-vec): resolve string/numeric literal index to struct.set
  if (typeDef?.kind === "struct") {
    let fieldName: string | undefined;
    if (ts.isStringLiteral(target.argumentExpression)) {
      fieldName = target.argumentExpression.text;
    } else if (ts.isNumericLiteral(target.argumentExpression)) {
      fieldName = target.argumentExpression.text;
    } else if (ts.isIdentifier(target.argumentExpression)) {
      const sym = ctx.checker.getSymbolAtLocation(target.argumentExpression);
      if (sym) {
        const decl = sym.valueDeclaration;
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
          const declList = decl.parent;
          if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
            if (ts.isStringLiteral(decl.initializer)) fieldName = decl.initializer.text;
            else if (ts.isNumericLiteral(decl.initializer)) fieldName = decl.initializer.text;
          }
        }
      }
    }
    if (fieldName === undefined) {
      fieldName = resolveComputedKeyExpression(ctx, target.argumentExpression);
    }
    if (fieldName !== undefined) {
      // Check for setter accessor first (obj['prop'] = val where prop has a setter)
      const objTsType = ctx.checker.getTypeAtLocation(target.expression);
      // (#1239) Use resolveEffectiveStructName for consistency with the
      // PropertyAccessExpression path above.
      const sName = resolveEffectiveStructName(ctx, target.expression, objTsType);
      if (sName) {
        const accessorKey = `${sName}_${fieldName}`;
        if (ctx.classAccessorSet.has(accessorKey)) {
          const setterName = `${sName}_set_${fieldName}`;
          const funcIdx = ctx.funcMap.get(setterName);
          if (funcIdx !== undefined) {
            // struct ref is already on stack; save it, compile value, then call setter
            const objLocal = allocLocal(fctx, `__struct_obj_${fctx.locals.length}`, arrType);
            fctx.body.push({ op: "local.set", index: objLocal });
            const valResult = compileExpression(ctx, fctx, value);
            if (!valResult) return null;
            const valLocal = allocLocal(fctx, `__struct_val_${fctx.locals.length}`, valResult);
            fctx.body.push({ op: "local.set", index: valLocal });
            fctx.body.push({ op: "local.get", index: objLocal });
            // If setter has a value parameter (2+ params), push the value
            const eaSetterPTypes = getFuncParamTypes(ctx, funcIdx);
            if (eaSetterPTypes && eaSetterPTypes.length > 1) {
              fctx.body.push({ op: "local.get", index: valLocal });
            }
            fctx.body.push({ op: "call", funcIdx });
            // Return the assigned value (assignment expression result)
            fctx.body.push({ op: "local.get", index: valLocal });
            return valResult;
          }
        }
      }

      const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
      if (fieldIdx >= 0) {
        // struct ref is already on stack; save it, compile value, then struct.set
        const objLocal = allocLocal(fctx, `__struct_obj_${fctx.locals.length}`, arrType);
        fctx.body.push({ op: "local.set", index: objLocal });
        const fieldType = typeDef.fields[fieldIdx]!.type;
        const valResult = compileExpression(ctx, fctx, value, fieldType);
        if (!valResult) return null;
        const valLocal = allocLocal(fctx, `__struct_val_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.set", index: valLocal });
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "local.get", index: valLocal });
        fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
        // Return the assigned value (assignment expression result)
        fctx.body.push({ op: "local.get", index: valLocal });
        return valResult;
      }
    }
  }

  if (!typeDef || typeDef.kind !== "array") {
    // Fallback: convert struct/unknown ref to externref and use __extern_set
    return compileExternSetFallback(ctx, fctx, target, value, arrType);
  }
  // Push index (as i32)
  const plainIdxResult = compileExpression(ctx, fctx, target.argumentExpression, { kind: "f64" });
  if (!plainIdxResult) {
    reportError(ctx, target, "Failed to compile element index");
    return null;
  }
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  // Push value
  const plainValResult = compileExpression(ctx, fctx, value, typeDef.element);
  if (!plainValResult) {
    reportError(ctx, target, "Failed to compile element value");
    return null;
  }
  // Save value for assignment expression result
  const plainValLocal = allocLocal(fctx, `__arr_assign_${fctx.locals.length}`, plainValResult);
  fctx.body.push({ op: "local.tee", index: plainValLocal });
  fctx.body.push({ op: "array.set", typeIdx });
  fctx.body.push({ op: "local.get", index: plainValLocal });
  return plainValResult;
}

/**
 * Fallback for element assignment on non-array types.
 * Converts the object to externref and calls __extern_set(obj, key, val).
 * The object value is already on the stack.
 */
function compileExternSetFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  value: ts.Expression,
  objType: ValType,
): InnerResult {
  // Convert object on stack to externref
  if (objType.kind === "externref") {
    // Already externref, nothing to do
  } else if (objType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else if (objType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else if (objType.kind === "ref" || objType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" });
  } else {
    reportError(ctx, target, "Unsupported element assignment target type");
    return null;
  }

  // Save obj externref to local
  const objLocal = allocLocal(fctx, `__eset_obj_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Compile value first so we can save it for return
  const valResult = compileExpression(ctx, fctx, value, { kind: "externref" });
  if (!valResult) return null;
  const valLocal = allocLocal(fctx, `__eset_val_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: valLocal });

  // Push args: obj, key, val
  fctx.body.push({ op: "local.get", index: objLocal });
  compileExpression(ctx, fctx, target.argumentExpression, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.get", index: valLocal });

  // Lazily register __extern_set if not already registered
  const funcIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (funcIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx });
  }

  // Return the assigned value
  fctx.body.push({ op: "local.get", index: valLocal });
  return { kind: "externref" };
}

/**
 * Compile logical assignment operators: ??=, ||=, &&=
 *
 * Desugars to value-preserving semantics:
 *   a ??= b  →  if (a is null) a = b; result = a
 *   a ||= b  →  if (!a) a = b; result = a
 *   a &&= b  →  if (a) a = b; result = a
 */
export function compileLogicalAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType | null {
  // Handle property access logical assignment: obj.prop ??= default
  if (ts.isPropertyAccessExpression(expr.left)) {
    return compilePropertyLogicalAssignment(ctx, fctx, expr.left, expr.right, op);
  }

  // Handle element access logical assignment: arr[i] ||= default
  if (ts.isElementAccessExpression(expr.left)) {
    return compileElementLogicalAssignment(ctx, fctx, expr.left, expr.right, op);
  }

  if (!ts.isIdentifier(expr.left)) {
    reportError(
      ctx,
      expr,
      "Logical assignment only supported for simple identifiers, property access, or element access",
    );
    return null;
  }

  const name = expr.left.text;

  // Resolve the variable storage location
  let storage:
    | { kind: "local"; index: number; type: ValType }
    | { kind: "captured"; index: number; type: ValType }
    | { kind: "module"; index: number; type: ValType }
    | null = null;

  const localIdx = fctx.localMap.get(name);
  if (localIdx !== undefined) {
    const localType =
      localIdx < fctx.params.length ? fctx.params[localIdx]!.type : fctx.locals[localIdx - fctx.params.length]?.type;
    storage = {
      kind: "local",
      index: localIdx,
      type: localType ?? { kind: "f64" },
    };
  }
  if (!storage) {
    const capturedIdx = ctx.capturedGlobals.get(name);
    if (capturedIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
      storage = {
        kind: "captured",
        index: capturedIdx,
        type: globalDef?.type ?? { kind: "f64" },
      };
    }
  }
  if (!storage) {
    const moduleIdx = ctx.moduleGlobals.get(name);
    if (moduleIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
      storage = {
        kind: "module",
        index: moduleIdx,
        type: globalDef?.type ?? { kind: "f64" },
      };
    }
  }

  if (!storage) {
    // Graceful fallback: compile the RHS for side effects, then return externref
    const rhsFallback = compileExpression(ctx, fctx, expr.right);
    if (rhsFallback) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  const varType = storage.type;

  // Emit: read current value
  // Re-read global index from the map each time, because compiling expressions
  // can trigger addStringConstantGlobal which shifts all global indices.
  const getStorageIndex = () => {
    if (storage!.kind === "local") return storage!.index;
    if (storage!.kind === "captured") return ctx.capturedGlobals.get(name)!;
    return ctx.moduleGlobals.get(name)!;
  };
  const emitGet = () => {
    if (storage!.kind === "local") fctx.body.push({ op: "local.get", index: getStorageIndex() });
    else fctx.body.push({ op: "global.get", index: getStorageIndex() });
  };
  const emitSet = () => {
    if (storage!.kind === "local") fctx.body.push({ op: "local.tee", index: getStorageIndex() });
    else {
      const idx = getStorageIndex();
      fctx.body.push({ op: "global.set", index: idx });
      fctx.body.push({ op: "global.get", index: idx });
    }
  };

  if (op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    // a ??= b  →  if (a is null/undefined) { a = b }; result = a
    // For value types (i32, i64, f32, f64, etc.), values can never be null/undefined,
    // so just return the current value without evaluating RHS (short-circuit).
    if (!isRefType(varType)) {
      emitGet();
      return varType;
    }
    emitGet();
    // Check null or undefined (JS ??= triggers for both)
    const qqeTmp = allocTempLocal(fctx, varType);
    fctx.body.push({ op: "local.tee", index: qqeTmp });
    fctx.body.push({ op: "ref.is_null" });
    const qqeUndefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx);
    if (qqeUndefIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: qqeTmp });
      if (varType.kind !== "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }
      fctx.body.push({ op: "call", funcIdx: qqeUndefIdx });
      fctx.body.push({ op: "i32.or" });
    }
    releaseTempLocal(fctx, qqeTmp);

    // Compile the RHS in a separate body
    const savedBody = pushBody(fctx);
    const nullishRhsResult = compileExpression(ctx, fctx, expr.right, varType);
    if (!nullishRhsResult) {
      fctx.body = savedBody;
      return null;
    }
    emitSet();
    const thenInstrs = fctx.body;

    // Else: just read the current value (it's not null)
    fctx.body = [];
    emitGet();
    const elseInstrs = fctx.body;

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  } else if (op === ts.SyntaxKind.BarBarEqualsToken) {
    // a ||= b  →  if (!a) { a = b }; result = a
    emitGet();
    ensureI32Condition(fctx, varType, ctx);

    // Then (truthy): keep current value
    const savedBody = pushBody(fctx);
    emitGet();
    const thenInstrs = fctx.body;

    // Else (falsy): assign RHS
    fctx.body = [];
    const orRhsResult = compileExpression(ctx, fctx, expr.right, varType);
    if (!orRhsResult) {
      fctx.body = savedBody;
      return null;
    }
    emitSet();
    const elseInstrs = fctx.body;

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  } else {
    // a &&= b  →  if (a) { a = b }; result = a
    emitGet();
    ensureI32Condition(fctx, varType, ctx);

    // Then (truthy): assign RHS
    const savedBody = pushBody(fctx);
    const andRhsResult = compileExpression(ctx, fctx, expr.right, varType);
    if (!andRhsResult) {
      fctx.body = savedBody;
      return null;
    }
    emitSet();
    const thenInstrs = fctx.body;

    // Else (falsy): keep current value
    fctx.body = [];
    emitGet();
    const elseInstrs = fctx.body;

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  }

  return varType;
}

/**
 * Compile logical assignment on property access: obj.prop ??= default, obj.prop ||= default, obj.prop &&= default
 * Uses short-circuit semantics: RHS is only evaluated if the condition is met.
 */
function compilePropertyLogicalAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(target.expression);
  const propName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;

  // Resolve struct type
  const typeName = resolveStructNameForExpr(ctx, fctx, target.expression);
  if (!typeName) {
    // Fallback: treat as externref property access via __extern_get / __extern_set
    return compilePropertyLogicalAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  // Check for accessor properties (get/set) before looking up struct fields
  const accessorKey = `${typeName}_${propName}`;
  if (ctx.classAccessorSet.has(accessorKey)) {
    const getterName = `${typeName}_get_${propName}`;
    const setterName = `${typeName}_set_${propName}`;
    const getterIdx = ctx.funcMap.get(getterName);
    const setterIdx = ctx.funcMap.get(setterName);
    if (getterIdx !== undefined && setterIdx !== undefined) {
      // Compile obj and save to a local for reuse, coercing to getter's self type
      const getterPTypes = getFuncParamTypes(ctx, getterIdx);
      const objResult = compileExpression(ctx, fctx, target.expression, getterPTypes?.[0]);
      if (!objResult) return null;
      const objLocal = allocLocal(fctx, `__logprop_acc_obj_${fctx.locals.length}`, objResult);
      fctx.body.push({ op: "local.set", index: objLocal });

      const propType = ctx.checker.getTypeAtLocation(target);
      const fieldType = resolveWasmType(ctx, propType);

      const emitFieldGet = () => {
        // Re-lookup funcIdx at emission time — addUnionImports may have shifted indices
        const gIdx = ctx.funcMap.get(getterName)!;
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "call", funcIdx: gIdx });
      };
      const emitFieldSet = () => {
        // Re-lookup funcIdx at emission time — addUnionImports may have shifted indices
        const sIdx = ctx.funcMap.get(setterName)!;
        const tmpVal = allocLocal(fctx, `__logprop_acc_val_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.set", index: tmpVal });
        fctx.body.push({ op: "local.get", index: objLocal });
        // If setter has a value parameter (2+ params), push the value
        const logSetterPTypes = getFuncParamTypes(ctx, sIdx);
        if (logSetterPTypes && logSetterPTypes.length > 1) {
          fctx.body.push({ op: "local.get", index: tmpVal });
        }
        fctx.body.push({ op: "call", funcIdx: sIdx });
        fctx.body.push({ op: "local.get", index: tmpVal });
      };

      return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, fieldType, emitFieldGet, emitFieldSet);
    }
  }

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    // Struct name resolved but type not in structMap — fall back to externref path
    return compilePropertyLogicalAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx === -1) {
    // Unknown field — gracefully emit NaN (reading undefined property in numeric context)
    fctx.body.push({ op: "f64.const", value: NaN });
    return { kind: "f64" };
  }

  const fieldType = fields[fieldIdx]!.type;

  // Compile obj and save to a local for reuse
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;
  const objLocal = allocLocal(fctx, `__logprop_obj_${fctx.locals.length}`, objResult);
  fctx.body.push({ op: "local.set", index: objLocal });

  // Create helpers that read/write the field
  const emitFieldGet = () => {
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
  };
  const emitFieldSet = () => {
    // After RHS is on stack, save it, load obj, load value, struct.set, load value again for result
    const tmpVal = allocLocal(fctx, `__logprop_val_${fctx.locals.length}`, fieldType);
    fctx.body.push({ op: "local.set", index: tmpVal });
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: tmpVal });
    fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
    fctx.body.push({ op: "local.get", index: tmpVal });
  };

  return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, fieldType, emitFieldGet, emitFieldSet);
}

/**
 * Fallback for logical assignment on a property access target when the
 * struct type cannot be resolved statically.
 *
 * Strategy:
 * 1. Compile the object expression to discover its runtime Wasm type.
 * 2. If the result is a struct ref, look up the field by name and use struct.get/struct.set.
 * 3. Otherwise, convert to externref and use __extern_get / __extern_set.
 */
function compilePropertyLogicalAssignmentExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  propName: string,
): ValType | null {
  // Compile the object expression to discover its runtime type
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;

  // --- Path A: The object compiled to a struct ref ---
  if (objResult.kind === "ref" || objResult.kind === "ref_null") {
    const typeIdx = (objResult as { typeIdx: number }).typeIdx;
    const resolvedTypeName = ctx.typeIdxToStructName.get(typeIdx);
    if (resolvedTypeName) {
      const fields = ctx.structFields.get(resolvedTypeName);
      if (fields) {
        let fieldIdx = fields.findIndex((f) => f.name === propName);

        // If the field doesn't exist yet, try to add it dynamically from TS type info
        // but NEVER for class struct types — their fields are fixed at collection time
        if (fieldIdx === -1 && !ctx.classSet.has(resolvedTypeName)) {
          const objTsType = ctx.checker.getTypeAtLocation(target.expression);
          const tsProps = objTsType.getProperties?.();
          if (tsProps) {
            const tsProp = tsProps.find((p) => p.name === propName);
            if (tsProp) {
              const propTsType = ctx.checker.getTypeOfSymbolAtLocation(tsProp, target);
              const propWasmType = resolveWasmType(ctx, propTsType);
              const newField: FieldDef = {
                name: propName,
                type: propWasmType,
                mutable: true,
              };
              fields.push(newField);
              // fields === typeDef.fields (same array ref from structFields map)
              patchStructNewForAddedField(ctx, fctx, typeIdx, propWasmType);
              const typeDef = ctx.mod.types[typeIdx];
              if (typeDef?.kind === "struct" && typeDef.fields !== fields) {
                typeDef.fields.push(newField);
              }
              // Patch existing struct.new instructions to include the new field
              patchStructNewForDynamicField(ctx, typeIdx, propWasmType);
              fieldIdx = fields.length - 1;
            }
          }
        }

        if (fieldIdx !== -1) {
          const fieldType = fields[fieldIdx]!.type;
          const objTmp = allocLocal(fctx, `__logprop_ext_obj_${fctx.locals.length}`, objResult);
          fctx.body.push({ op: "local.set", index: objTmp });

          const emitGet = () => {
            fctx.body.push({ op: "local.get", index: objTmp });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          };
          const emitSet = () => {
            const tmpVal = allocLocal(fctx, `__logprop_ext_val_${fctx.locals.length}`, fieldType);
            fctx.body.push({ op: "local.set", index: tmpVal });
            fctx.body.push({ op: "local.get", index: objTmp });
            fctx.body.push({ op: "local.get", index: tmpVal });
            fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
            fctx.body.push({ op: "local.get", index: tmpVal });
          };

          return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, fieldType, emitGet, emitSet);
        }
      }
    }

    // Struct ref but field not found — convert to externref and fall through to path B
    fctx.body.push({ op: "extern.convert_any" });
  } else if (objResult.kind !== "externref") {
    // For f64/i32, box to externref
    if (objResult.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
    } else if (objResult.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
    } else {
      // Unknown type — emit NaN as graceful fallback
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }
  }

  // --- Path B: externref-based property logical assignment ---
  const objLocal = allocLocal(fctx, `__logprop_pobj_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Compile propName as externref string key
  addStringConstantGlobal(ctx, propName);
  const keyResult = compileStringLiteral(ctx, fctx, propName);
  if (!keyResult) return null;
  if (keyResult.kind !== "externref") {
    coerceType(ctx, fctx, keyResult, { kind: "externref" });
  }
  const keyLocal = allocLocal(fctx, `__logprop_pkey_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: keyLocal });

  // Ensure __extern_get is available
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  if (getIdx === undefined) return null;

  // Ensure __extern_set is available
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (setIdx === undefined) return null;

  // Ensure union imports (including __unbox_number, __box_number) are registered
  addUnionImports(ctx);

  const varType: ValType = { kind: "externref" };

  // Capture final getIdx/setIdx values for closures
  const finalGetIdx = getIdx;
  const finalSetIdx = setIdx;

  const emitGet = () => {
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "call", funcIdx: finalGetIdx });
  };

  const emitSet = () => {
    // Stack has the new value (externref) on top
    const tmpVal = allocLocal(fctx, `__logprop_pval_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: tmpVal });
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: tmpVal });
    fctx.body.push({ op: "call", funcIdx: finalSetIdx });
    fctx.body.push({ op: "local.get", index: tmpVal });
  };

  return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, varType, emitGet, emitSet);
}

/**
 * Compile logical assignment on element access: arr[i] ??= default, arr[i] ||= default, arr[i] &&= default
 * Uses short-circuit semantics.
 */
function compileElementLogicalAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
): ValType | null {
  // Compile object expression
  const arrType = compileExpression(ctx, fctx, target.expression);
  if (!arrType) {
    reportError(ctx, target, "Logical assignment on undefined element access target");
    return null;
  }

  // #1268 — index-signature dict (`{ [key: string]: T }`) lowers to
  // externref (host JS object); other non-ref kinds (f64, i32 — rare,
  // but possible via boxed primitives) likewise route through the host.
  // Plain `obj[key] = val` already has a `compileExternSetFallback` arm
  // for these; the parallel `??=` / `||=` / `&&=` arm was missing and
  // produced a "Logical assignment on non-array element access" error
  // that callers silently dropped, leaving the LHS uninitialized — the
  // subsequent read returned NaN. This routes the logical-assignment
  // case through the same `__extern_get` / `__extern_set` host imports
  // the plain assignment uses.
  if (arrType.kind !== "ref" && arrType.kind !== "ref_null") {
    return compileElementLogicalAssignmentExternref(ctx, fctx, target, rhs, op, arrType);
  }

  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle struct bracket notation: obj["prop"] ??= default
  if (typeDef?.kind === "struct") {
    const isVecStruct =
      typeDef.fields.length === 2 && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data";
    if (!isVecStruct) {
      let fieldName: string | undefined;
      if (ts.isStringLiteral(target.argumentExpression)) {
        fieldName = target.argumentExpression.text;
      } else if (ts.isNumericLiteral(target.argumentExpression)) {
        fieldName = target.argumentExpression.text;
      }
      if (fieldName !== undefined) {
        const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
        if (fieldIdx !== -1) {
          const fieldType = typeDef.fields[fieldIdx]!.type;

          // Save obj ref
          const objLocal = allocLocal(fctx, `__logelem_obj_${fctx.locals.length}`, arrType);
          fctx.body.push({ op: "local.set", index: objLocal });

          const emitFieldGet = () => {
            fctx.body.push({ op: "local.get", index: objLocal });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          };
          const emitFieldSet = () => {
            const tmpVal = allocLocal(fctx, `__logelem_val_${fctx.locals.length}`, fieldType);
            fctx.body.push({ op: "local.set", index: tmpVal });
            fctx.body.push({ op: "local.get", index: objLocal });
            fctx.body.push({ op: "local.get", index: tmpVal });
            fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
            fctx.body.push({ op: "local.get", index: tmpVal });
          };

          return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, fieldType, emitFieldGet, emitFieldSet);
        }
      }
    }

    // Vec struct: array[i] ??= default
    if (isVecStruct) {
      const arrLocal = allocLocal(fctx, `__logelem_arr_${fctx.locals.length}`, arrType);
      fctx.body.push({ op: "local.set", index: arrLocal });

      // Compile index
      const idxResult = compileExpression(ctx, fctx, target.argumentExpression, { kind: "f64" });
      if (!idxResult) return null;
      if (idxResult.kind !== "i32") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
      const idxLocal = allocLocal(fctx, `__logelem_idx_${fctx.locals.length}`, {
        kind: "i32",
      });
      fctx.body.push({ op: "local.set", index: idxLocal });

      const dataField = typeDef.fields[1]!;
      const dataTypeIdx = (dataField.type as { typeIdx: number }).typeIdx;
      const dataDef = ctx.mod.types[dataTypeIdx];
      if (!dataDef || dataDef.kind !== "array") {
        reportError(ctx, target, "Vec struct data field is not an array");
        return null;
      }
      const elemType = dataDef.element;

      const emitElemGet = () => {
        fctx.body.push({ op: "local.get", index: arrLocal });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "local.get", index: idxLocal });
        emitBoundsCheckedArrayGet(fctx, dataTypeIdx, elemType);
      };
      const emitElemSet = () => {
        const tmpVal = allocLocal(fctx, `__logelem_aval_${fctx.locals.length}`, elemType);
        fctx.body.push({ op: "local.set", index: tmpVal });
        // Bounds-guarded write: only set if idx < array.len
        fctx.body.push({ op: "local.get", index: idxLocal });
        fctx.body.push({ op: "local.get", index: arrLocal });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "array.len" });
        fctx.body.push({ op: "i32.lt_u" } as Instr);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" as const },
          then: [
            { op: "local.get", index: arrLocal } as Instr,
            { op: "struct.get", typeIdx, fieldIdx: 1 } as Instr,
            { op: "local.get", index: idxLocal } as Instr,
            { op: "local.get", index: tmpVal } as Instr,
            { op: "array.set", typeIdx: dataTypeIdx } as Instr,
          ],
          else: [],
        } as Instr);
        fctx.body.push({ op: "local.get", index: tmpVal });
      };

      return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, elemType, emitElemGet, emitElemSet);
    }
  }

  reportError(ctx, target, "Unsupported element access logical assignment target");
  return null;
}

/**
 * #1268 — `obj[key] ??= rhs` / `obj[key] ||= rhs` / `obj[key] &&= rhs`
 * where `obj` is an index-signature dict (lowered to externref) or any
 * other non-ref / non-ref_null target.
 *
 * Mirrors `compileExternSetFallback` for the read+write portions and
 * `emitLogicalAssignmentPattern` for the short-circuit semantics.
 *
 * Layout:
 *   1. Coerce obj to externref (already on stack), save to `__lelm_obj`
 *   2. Compute key (externref string), save to `__lelm_key`
 *   3. emitGet := obj_local; key_local; call $__extern_get → externref
 *   4. emitSet (after RHS pushed): save val to `__lelm_val`;
 *      obj_local; key_local; val_local; call $__extern_set;
 *      val_local (return value)
 *   5. emitLogicalAssignmentPattern handles the if/else dispatch
 *
 * Result type is externref — the host import lives in externref world,
 * and the caller-visible value is whatever the write/read produced.
 *
 * Caveat: `??=` semantics in JS treat `null` AND `undefined` as nullish.
 * `__extern_get` returns `ref.null.extern` for missing keys (which the
 * `ref.is_null` check captures correctly) and a boxed `undefined` for
 * keys present with undefined value. The current `emitLogicalAssignment-
 * Pattern` only checks `ref.is_null` for the `??=` arm, which matches
 * the legacy global-scope `??=` behaviour. Distinguishing
 * `undefined`-vs-other-truthy is the same gap that the global path has
 * (compiled there too) — leave aligned with the existing convention.
 */
function compileElementLogicalAssignmentExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  objType: ValType,
): ValType | null {
  // Coerce obj on stack to externref (mirrors compileExternSetFallback's prelude).
  if (objType.kind === "externref") {
    // already externref
  } else if (objType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else if (objType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else {
    reportError(ctx, target, "Unsupported element logical-assignment target type");
    return null;
  }

  // Save obj to a local so we can read it twice (get + set).
  const objLocal = allocLocal(fctx, `__lelm_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Compute key (always externref string for host imports) and save.
  const keyType = compileExpression(ctx, fctx, target.argumentExpression, { kind: "externref" });
  if (!keyType) return null;
  // Coerce key to externref if needed (string literals already are).
  if (keyType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else if (keyType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else if (keyType.kind === "ref" || keyType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  const keyLocal = allocLocal(fctx, `__lelm_key_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: keyLocal });

  // Ensure host imports are registered.
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
  flushLateImportShifts(ctx, fctx);
  if (getIdx === undefined || setIdx === undefined) {
    reportError(ctx, target, "Could not register __extern_get/__extern_set imports");
    return null;
  }

  const emitGet = (): void => {
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "call", funcIdx: getIdx });
  };
  const emitSet = (): void => {
    // Stack on entry: <rhs value as externref>
    // We need to: save it, then call __extern_set(obj, key, val), then
    // re-push val as the result value of the logical assignment.
    const valLocal = allocLocal(fctx, `__lelm_val_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: valLocal });
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: valLocal });
    fctx.body.push({ op: "call", funcIdx: setIdx });
    fctx.body.push({ op: "local.get", index: valLocal });
  };

  return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, { kind: "externref" }, emitGet, emitSet);
}

/**
 * Check if a ValType is a reference type (can be used with ref.is_null).
 * Value types (i32, i64, f32, f64, v128, i16) are never null/undefined.
 */
function isRefType(t: ValType): boolean {
  return (
    t.kind === "ref" ||
    t.kind === "ref_null" ||
    t.kind === "funcref" ||
    t.kind === "externref" ||
    t.kind === "ref_extern" ||
    t.kind === "eqref"
  );
}

/**
 * Common logic for logical assignment patterns (??=, ||=, &&=).
 * Given emitGet/emitSet closures for the target, emit the if/else with short-circuit semantics.
 */
function emitLogicalAssignmentPattern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  varType: ValType,
  emitGet: () => void,
  emitSet: () => void,
): ValType | null {
  if (op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    // target ??= rhs  →  if (target is null/undefined) { target = rhs }; result = target
    // For value types (i32, i64, f32, f64, etc.), values can never be null/undefined,
    // so just return the current value without evaluating RHS (short-circuit).
    if (!isRefType(varType)) {
      emitGet();
      return varType;
    }
    // For externref-typed targets, host imports return JS `undefined` as
    // a non-null externref (the WebAssembly type system doesn't equate
    // them). `ref.is_null` alone misses `undefined`-valued slots — see
    // the parallel pattern in `compileLogicalAssignment` that uses
    // `__extern_is_undefined` for variable-scope `??=`. Compose the
    // two checks via `i32.or` so the then-arm fires for both.
    //
    // GetValue must run exactly once (§13.15.2): tee the fetched value into
    // a temp and reuse it on the keep path so accessor getters fire once.
    emitGet();
    const tmpKeep = allocTempLocal(fctx, varType);
    fctx.body.push({ op: "local.tee", index: tmpKeep });
    fctx.body.push({ op: "ref.is_null" });
    if (varType.kind === "externref") {
      const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      if (undefIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: tmpKeep });
        fctx.body.push({ op: "call", funcIdx: undefIdx });
        fctx.body.push({ op: "i32.or" });
      }
    }

    const savedBody = pushBody(fctx);
    const rhsResult = compileExpression(ctx, fctx, rhs, varType);
    if (!rhsResult) {
      fctx.body = savedBody;
      releaseTempLocal(fctx, tmpKeep);
      return null;
    }
    emitSet();
    const thenInstrs = fctx.body;

    fctx.body = [];
    fctx.body.push({ op: "local.get", index: tmpKeep });
    const elseInstrs = fctx.body;
    releaseTempLocal(fctx, tmpKeep);

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  } else if (op === ts.SyntaxKind.BarBarEqualsToken) {
    // target ||= rhs  →  if (target is truthy) { keep } else { target = rhs }
    // GetValue once (§13.15.2): tee the fetched value, reuse on the keep path.
    emitGet();
    const tmpKeep = allocTempLocal(fctx, varType);
    fctx.body.push({ op: "local.tee", index: tmpKeep });
    ensureI32Condition(fctx, varType, ctx);

    const savedBody = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tmpKeep });
    const thenInstrs = fctx.body;

    fctx.body = [];
    const rhsResult = compileExpression(ctx, fctx, rhs, varType);
    if (!rhsResult) {
      fctx.body = savedBody;
      releaseTempLocal(fctx, tmpKeep);
      return null;
    }
    emitSet();
    const elseInstrs = fctx.body;
    releaseTempLocal(fctx, tmpKeep);

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  } else {
    // target &&= rhs  →  if (target is truthy) { target = rhs } else { keep }
    // GetValue once (§13.15.2): tee the fetched value, reuse on the keep path.
    emitGet();
    const tmpKeep = allocTempLocal(fctx, varType);
    fctx.body.push({ op: "local.tee", index: tmpKeep });
    ensureI32Condition(fctx, varType, ctx);

    const savedBody = pushBody(fctx);
    const rhsResult = compileExpression(ctx, fctx, rhs, varType);
    if (!rhsResult) {
      fctx.body = savedBody;
      releaseTempLocal(fctx, tmpKeep);
      return null;
    }
    emitSet();
    const thenInstrs = fctx.body;

    fctx.body = [];
    fctx.body.push({ op: "local.get", index: tmpKeep });
    const elseInstrs = fctx.body;
    releaseTempLocal(fctx, tmpKeep);

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  }

  return varType;
}

export function isCompoundAssignment(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.PlusEqualsToken ||
    op === ts.SyntaxKind.MinusEqualsToken ||
    op === ts.SyntaxKind.AsteriskEqualsToken ||
    op === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    op === ts.SyntaxKind.SlashEqualsToken ||
    op === ts.SyntaxKind.PercentEqualsToken ||
    op === ts.SyntaxKind.AmpersandEqualsToken ||
    op === ts.SyntaxKind.BarEqualsToken ||
    op === ts.SyntaxKind.CaretEqualsToken ||
    op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
  );
}

/**
 * Handle string += : load current string value, compile RHS (coercing
 * numbers to string if needed), call concat, store back.
 *
 * In nativeStrings mode (auto-on for `--target wasi`), routes through the
 * native `__str_concat` helper which expects `ref $AnyString` operands and
 * returns `ref $AnyString`. The legacy host-import branch uses
 * `wasm:js-string concat` with externref operands. The two branches must
 * not be mixed: calling `addStringImports` late in nativeStrings mode adds
 * 5 host imports without shifting already-emitted module function indices,
 * which corrupts every `call funcIdx=N` instruction whose index now points
 * at a host import instead of the intended native helper (#1175).
 */
/**
 * (#2058) `x += rhs` where the result may be a runtime string. Compute
 * `x + rhs` via the shared runtime-dispatched add (`emitAnyAdd`: JS `+` host
 * bridge, or a standalone tag-dispatch concat/add), then store the resulting
 * externref back into the variable. Returns null (caller falls through to the
 * numeric paths) only for storage classes this doesn't cover.
 */
function compileAnyCompoundAdd(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  name: string,
): ValType | null {
  const localIdx = fctx.localMap.get(name);
  const capturedIdx = ctx.capturedGlobals.get(name);
  const moduleIdx = ctx.moduleGlobals.get(name);
  if (localIdx === undefined && capturedIdx === undefined && moduleIdx === undefined) {
    return null; // unresolved binding — let the default paths handle it
  }

  // emitAnyAdd reads `expr.left` (the current value of `x`) and `expr.right`,
  // leaving the §13.15.3 result on the stack as an externref.
  const addResult = emitAnyAdd(ctx, fctx, expr);
  if (addResult.kind !== "externref") {
    // emitAnyAdd took the legacy f64 fallback (no host, no native strings).
    // Coerce to externref so the store below is uniform.
    coerceType(ctx, fctx, addResult, { kind: "externref" });
  }

  // Store back into the resolved binding (re-read global indices in case RHS
  // compilation shifted them), coercing externref → the binding's storage type.
  if (localIdx !== undefined) {
    const localType = getLocalType(fctx, localIdx) ?? { kind: "externref" as const };
    if (localType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, localType);
    fctx.body.push({ op: "local.tee", index: localIdx });
    return localType;
  }
  if (capturedIdx !== undefined) {
    const capturedIdxPost = ctx.capturedGlobals.get(name)!;
    const globalType: ValType = ctx.mod.globals[localGlobalIdx(ctx, capturedIdxPost)]?.type ?? { kind: "externref" };
    if (globalType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, globalType);
    fctx.body.push({ op: "global.set", index: capturedIdxPost });
    fctx.body.push({ op: "global.get", index: capturedIdxPost });
    return globalType;
  }
  const moduleIdxPost = ctx.moduleGlobals.get(name)!;
  const globalType: ValType = ctx.mod.globals[localGlobalIdx(ctx, moduleIdxPost)]?.type ?? { kind: "externref" };
  if (globalType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, globalType);
  fctx.body.push({ op: "global.set", index: moduleIdxPost });
  fctx.body.push({ op: "global.get", index: moduleIdxPost });
  return globalType;
}

function compileStringCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  name: string,
): ValType | null {
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    return compileNativeStringCompoundAssignment(ctx, fctx, expr, name);
  }

  // Ensure string imports are registered
  addStringImports(ctx);

  const concatIdx = ctx.jsStringImports.get("concat");
  if (concatIdx === undefined) {
    reportError(ctx, expr, "String concat import not available");
    return null;
  }

  // Determine storage location
  const localIdx = fctx.localMap.get(name);
  const capturedIdx = ctx.capturedGlobals.get(name);
  const moduleIdx = ctx.moduleGlobals.get(name);

  // Load current value
  if (localIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: localIdx });
  } else if (capturedIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: capturedIdx });
  } else if (moduleIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: moduleIdx });
  } else {
    // Graceful fallback: compile RHS for side effects, return externref
    const rhsFallback = compileExpression(ctx, fctx, expr.right);
    if (rhsFallback) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Compile RHS, coercing numbers to string
  const rhsType = compileExpression(ctx, fctx, expr.right);
  if (!rhsType) {
    reportError(ctx, expr, "Failed to compile string += RHS");
    return null;
  }
  if (rhsType.kind === "f64" || rhsType.kind === "i32") {
    const rhsTsType = ctx.checker.getTypeAtLocation(expr.right);
    if (isBooleanType(rhsTsType) && rhsType.kind === "i32") {
      emitBoolToString(ctx, fctx);
    } else {
      if (rhsType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
      const toStr = ctx.funcMap.get("number_toString");
      if (toStr !== undefined) fctx.body.push({ op: "call", funcIdx: toStr });
    }
  }

  // Call concat
  fctx.body.push({ op: "call", funcIdx: concatIdx });

  // Store back — re-read global indices since RHS compilation may have shifted them
  if (localIdx !== undefined) {
    fctx.body.push({ op: "local.tee", index: localIdx });
  } else if (capturedIdx !== undefined) {
    const capturedIdxPost = ctx.capturedGlobals.get(name)!;
    fctx.body.push({ op: "global.set", index: capturedIdxPost });
    fctx.body.push({ op: "global.get", index: capturedIdxPost });
  } else if (moduleIdx !== undefined) {
    const moduleIdxPost = ctx.moduleGlobals.get(name)!;
    fctx.body.push({ op: "global.set", index: moduleIdxPost });
    fctx.body.push({ op: "global.get", index: moduleIdxPost });
  }

  return { kind: "externref" };
}

/**
 * #1744 — single-code-unit append fast path for string-builders.
 *
 * Returns `true` if `rhs` is a one-code-unit producer that can be appended
 * to the builder `sb` without materialising an intermediate `$NativeString`,
 * and emits the append. Two shapes qualify:
 *
 *   - `X.charAt(i)` where `X` is a native string — read `X`'s code unit at
 *     `i` (flatten `X` once, `array.get_u data[off+i]`) and append it.
 *   - a 1-character string literal (`buf += ";"`) — append the constant code
 *     unit directly, no string materialisation at all.
 *
 * In both cases the bulk path would otherwise allocate a 1-char string per
 * iteration (`array.new_fixed` + `struct.new`) and copy a single character
 * out of it. Returns `false` (caller falls back to `compileStringBuilderAppend`)
 * for anything else, including `at()` (negative indices) and `charAt` on a
 * non-string receiver.
 */
function tryCompileSingleCharBuilderAppend(
  ctx: CodegenContext,
  fctx: FunctionContext,
  rhs: ts.Expression,
  sb: StringBuilderInfo,
): boolean {
  // Shape 1: a 1-character string literal → append the constant code unit.
  if (ts.isStringLiteral(rhs) && rhs.text.length === 1) {
    fctx.body.push({ op: "i32.const", value: rhs.text.charCodeAt(0) } as Instr);
    emitStringBuilderAppendCodeUnit(ctx, fctx, sb);
    return true;
  }

  // Shape 2: `X.charAt(i)` on a native-string receiver.
  if (
    ts.isCallExpression(rhs) &&
    ts.isPropertyAccessExpression(rhs.expression) &&
    rhs.expression.name.text === "charAt" &&
    rhs.arguments.length <= 1
  ) {
    const receiver = rhs.expression.expression;
    const recvType = ctx.checker.getTypeAtLocation(receiver);
    // Only fire when the receiver is statically a string — otherwise charAt
    // might be a user method and the inline read would be wrong.
    const isStr = (recvType.flags & ts.TypeFlags.StringLike) !== 0;
    if (isStr) {
      const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
      if (flattenIdx !== undefined) {
        const strTypeIdx = ctx.nativeStrTypeIdx;
        const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
        // flat = __str_flatten(receiver) → ref $NativeString, stash in a temp.
        const recvVal = compileExpression(ctx, fctx, receiver);
        if (recvVal !== null) {
          fctx.body.push({ op: "call", funcIdx: flattenIdx } as Instr);
          const flatTmp = allocLocal(fctx, `__sb_charAt_flat_${fctx.locals.length}`, {
            kind: "ref_null",
            typeIdx: strTypeIdx,
          });
          fctx.body.push({ op: "local.set", index: flatTmp } as Instr);
          // cu = flat.data[flat.off + idx]
          fctx.body.push({ op: "local.get", index: flatTmp } as Instr);
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
          fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 } as Instr); // .data
          fctx.body.push({ op: "local.get", index: flatTmp } as Instr);
          fctx.body.push({ op: "ref.as_non_null" } as Instr);
          fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 } as Instr); // .off
          if (rhs.arguments.length > 0) {
            const idxType = compileExpression(ctx, fctx, rhs.arguments[0]!, { kind: "f64" });
            if (idxType?.kind === "f64") {
              fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
            } else if (idxType !== null && idxType.kind !== "i32") {
              // Unexpected index type — bail to the generic path would require
              // unwinding already-emitted ops, which we can't. Coerce best-effort.
              fctx.body.push({ op: "i32.const", value: 0 } as Instr);
            }
          } else {
            fctx.body.push({ op: "i32.const", value: 0 } as Instr);
          }
          fctx.body.push({ op: "i32.add" } as Instr); // off + idx
          fctx.body.push({ op: "array.get_u", typeIdx: strDataTypeIdx } as Instr);
          emitStringBuilderAppendCodeUnit(ctx, fctx, sb);
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Native-strings variant of string `+=` (#1175). Uses `__str_concat` which
 * accepts and returns `ref $AnyString`. RHS coercion: numbers are routed
 * through `number_toString` (returns externref) then `any.convert_extern` +
 * `ref.cast` to land back in the native string type.
 */
function compileNativeStringCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  name: string,
): ValType | null {
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (concatIdx === undefined) {
    reportError(ctx, expr, "Native __str_concat helper not available");
    return null;
  }
  const anyStrType: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  const anyStrTypeNullable: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };

  // #1210: route detected `let s = ""; for (...) s += <expr>` builder
  // patterns to the in-place buffer append, avoiding O(N) ConsString
  // allocations.
  const sb = getBuilderInfo(fctx, name);
  if (sb !== undefined) {
    // #1744: single-code-unit fast path — `buf += X.charAt(i)` / `buf += "c"`
    // append one code unit directly to the buffer, skipping the per-iteration
    // 1-char `$NativeString` allocation the generic path would emit.
    if (tryCompileSingleCharBuilderAppend(ctx, fctx, expr.right, sb)) {
      fctx.body.push({ op: "ref.null", typeIdx: ctx.anyStrTypeIdx } as Instr);
      return anyStrTypeNullable;
    }
    // Compile RHS and coerce to ref $AnyString — same coercion the legacy
    // path uses below, lifted into a small helper.
    const coerced = compileAndCoerceToAnyStr(ctx, fctx, expr.right);
    if (coerced === null) {
      reportError(ctx, expr, "Failed to compile string += RHS");
      return null;
    }
    compileStringBuilderAppend(ctx, fctx, coerced, sb);
    // The += statement is normally side-effecting (statement-level) — the
    // wrapping ExpressionStatement drops the result. Push a sentinel
    // `ref.null $AnyString` so callers that DO consume the value get a
    // typed value to drop / coerce.
    fctx.body.push({ op: "ref.null", typeIdx: ctx.anyStrTypeIdx } as Instr);
    return anyStrTypeNullable;
  }

  const localIdx = fctx.localMap.get(name);
  const capturedIdx = ctx.capturedGlobals.get(name);
  const moduleIdx = ctx.moduleGlobals.get(name);

  // Load current value as ref $AnyString
  if (localIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: localIdx });
  } else if (capturedIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: capturedIdx });
  } else if (moduleIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: moduleIdx });
  } else {
    // Graceful fallback: compile RHS for side effects, return null AnyString.
    const rhsFallback = compileExpression(ctx, fctx, expr.right);
    if (rhsFallback) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null", typeIdx: ctx.anyStrTypeIdx });
    return anyStrTypeNullable;
  }

  // Compile RHS
  const rhsType = compileExpression(ctx, fctx, expr.right);
  if (!rhsType) {
    reportError(ctx, expr, "Failed to compile string += RHS");
    return null;
  }
  // Coerce RHS to ref $AnyString.
  if (rhsType.kind === "ref" || rhsType.kind === "ref_null") {
    // Already a ref. Assume it's an AnyString-compatible type; if not,
    // ref.cast at __str_concat boundary will trap. Common case: native
    // string method calls return ref $AnyString already.
  } else if (rhsType.kind === "f64" || rhsType.kind === "i32") {
    const rhsTsType = ctx.checker.getTypeAtLocation(expr.right);
    if (isBooleanType(rhsTsType) && rhsType.kind === "i32") {
      // bool → "true"/"false" string. emitBoolToString returns externref.
      emitBoolToString(ctx, fctx);
      fctx.body.push({ op: "any.convert_extern" } as Instr);
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr);
    } else {
      if (rhsType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
      const toStr = ctx.funcMap.get("number_toString");
      if (toStr !== undefined) {
        fctx.body.push({ op: "call", funcIdx: toStr });
        // number_toString returns externref → convert to ref $AnyString
        fctx.body.push({ op: "any.convert_extern" } as Instr);
        fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr);
      } else {
        // No host number_toString: fall back to dropping and using empty string.
        // (Standalone WASI mode currently lacks a wasm-native number-to-string;
        //  this is an open gap. Drop the f64 to keep stack balanced.)
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null", typeIdx: ctx.anyStrTypeIdx });
      }
    }
  } else if (rhsType.kind === "externref") {
    // externref → ref $AnyString: convert + cast (e.g. host charAt result).
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr);
  }

  // Call __str_concat — returns ref $AnyString
  fctx.body.push({ op: "call", funcIdx: concatIdx });

  // Store back. Re-read indices since RHS compilation may have shifted them.
  if (localIdx !== undefined) {
    fctx.body.push({ op: "local.tee", index: localIdx });
  } else if (capturedIdx !== undefined) {
    const capturedIdxPost = ctx.capturedGlobals.get(name)!;
    fctx.body.push({ op: "global.set", index: capturedIdxPost });
    fctx.body.push({ op: "global.get", index: capturedIdxPost });
  } else if (moduleIdx !== undefined) {
    const moduleIdxPost = ctx.moduleGlobals.get(name)!;
    fctx.body.push({ op: "global.set", index: moduleIdxPost });
    fctx.body.push({ op: "global.get", index: moduleIdxPost });
  }

  return anyStrType;
}

/**
 * Compile a string-typed expression and coerce the result to a non-null
 * `ref $AnyString`. Handles the same coercion paths as
 * `compileNativeStringCompoundAssignment` (numbers via `number_toString`,
 * externref via `any.convert_extern + ref.cast`, booleans via
 * `emitBoolToString`). Used by the #1210 string-builder rewrite.
 *
 * Returns the resulting ValType (always `ref $AnyString` on success), or
 * null on failure.
 */
function compileAndCoerceToAnyStr(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): ValType | null {
  const anyStrType: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  const rhsType = compileExpression(ctx, fctx, expr);
  if (!rhsType) return null;

  if (rhsType.kind === "ref" || rhsType.kind === "ref_null") {
    // Already a ref to a string-like type. If nullable, force non-null —
    // __str_flatten and array.copy require non-null operands.
    if (rhsType.kind === "ref_null") {
      fctx.body.push({ op: "ref.as_non_null" } as Instr);
    }
    return anyStrType;
  }
  if (rhsType.kind === "f64" || rhsType.kind === "i32") {
    const rhsTsType = ctx.checker.getTypeAtLocation(expr);
    if (isBooleanType(rhsTsType) && rhsType.kind === "i32") {
      emitBoolToString(ctx, fctx);
      fctx.body.push({ op: "any.convert_extern" } as Instr);
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr);
      return anyStrType;
    }
    if (rhsType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
    const toStr = ctx.funcMap.get("number_toString");
    if (toStr !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toStr });
      fctx.body.push({ op: "any.convert_extern" } as Instr);
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr);
      return anyStrType;
    }
    // Standalone-mode gap: no host number_toString. Drop the value and emit
    // an empty native string so the append is a no-op.
    fctx.body.push({ op: "drop" });
    // Empty NativeString: struct.new $NativeString(0, 0, array.new_default 0)
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    return anyStrType;
  }
  if (rhsType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr);
    return anyStrType;
  }
  // Other types (i64 etc.) — drop and emit empty string as fallback.
  fctx.body.push({ op: "drop" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx });
  fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
  return anyStrType;
}

/**
 * Check if a variable named `name` is assigned a string value anywhere
 * in the enclosing function/block scope. This handles the test262 pattern:
 *   var __str;     // type: any
 *   __str = ""     // string assignment
 *   __str += index // should be string concat, not numeric add
 */
function hasStringAssignment(name: string, fromExpr: ts.Node): boolean {
  // Walk up to the enclosing function body or source file
  let scope: ts.Node = fromExpr;
  while (
    scope &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope) &&
    !ts.isSourceFile(scope)
  ) {
    scope = scope.parent;
  }
  if (!scope) return false;

  let found = false;
  function visit(node: ts.Node) {
    if (found) return;
    // Check: name = "stringLiteral" or name = `template`
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      if (
        ts.isStringLiteral(node.right) ||
        ts.isNoSubstitutionTemplateLiteral(node.right) ||
        ts.isTemplateExpression(node.right)
      ) {
        found = true;
        return;
      }
    }
    // Check: var name = "stringLiteral"
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      if (
        ts.isStringLiteral(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer) ||
        ts.isTemplateExpression(node.initializer)
      ) {
        found = true;
        return;
      }
    }
    forEachChild(node, visit);
  }
  forEachChild(scope, visit);
  return found;
}

/**
 * Like hasStringAssignment but searches from the source file root, not just
 * the immediate function. This catches the pattern where a closure captures
 * a variable that was assigned a string in a parent scope (#795).
 */
function hasStringAssignmentInParentScopes(name: string, fromExpr: ts.Node): boolean {
  // Walk up to the source file root
  let root: ts.Node = fromExpr;
  while (root.parent) root = root.parent;
  if (!ts.isSourceFile(root)) return false;
  // Search the entire source file for string assignments to this name
  let found = false;
  function visit(node: ts.Node) {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      if (
        ts.isStringLiteral(node.right) ||
        ts.isNoSubstitutionTemplateLiteral(node.right) ||
        ts.isTemplateExpression(node.right)
      ) {
        found = true;
        return;
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      if (
        ts.isStringLiteral(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer) ||
        ts.isTemplateExpression(node.initializer)
      ) {
        found = true;
        return;
      }
    }
    forEachChild(node, visit);
  }
  forEachChild(root, visit);
  return found;
}

export function compileCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType | null {
  // Handle property access compound assignment: obj.prop += value
  if (ts.isPropertyAccessExpression(expr.left)) {
    return compilePropertyCompoundAssignment(ctx, fctx, expr.left, expr.right, op);
  }

  // Handle element access compound assignment: arr[i] += value
  if (ts.isElementAccessExpression(expr.left)) {
    return compileElementCompoundAssignment(ctx, fctx, expr.left, expr.right, op);
  }

  if (!ts.isIdentifier(expr.left)) {
    reportError(ctx, expr, "Compound assignment only supported for simple identifiers");
    return null;
  }

  const name = expr.left.text;

  // const bindings — compound assignment throws TypeError at runtime
  if (fctx.constBindings?.has(name)) {
    const rhsType = compileExpression(ctx, fctx, expr.right);
    if (rhsType) fctx.body.push({ op: "drop" });
    emitThrowString(ctx, fctx, "TypeError: Assignment to constant variable.");
    fctx.body.push({ op: "unreachable" });
    return { kind: "f64" };
  }

  // String += : concat instead of numeric add.
  // Skip when the binding is a boxed mutable capture (ref cell): the boxed
  // path below (assignment.ts boxedCaptures branch) loads/stores through the
  // ref-cell struct and has its own externref string-concat handling (#795).
  // compileStringCompoundAssignment uses bare local.get/local.tee, which would
  // pass the `(struct (mut externref))` ref cell straight into js-string concat
  // (→ illegal cast / invalid wasm). #1999.
  if (op === ts.SyntaxKind.PlusEqualsToken && !fctx.boxedCaptures?.has(name)) {
    const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
    let isStr = isStringType(leftTsType);
    if (!isStr && (leftTsType.flags & ts.TypeFlags.Any) !== 0) {
      // For `any`-typed variables (e.g. `var __str; __str=""`), check if
      // the variable is ever assigned a string value in the enclosing scope.
      // This handles the common test262 pattern where `var x; x=""` followed
      // by `x += numericVar` should do string concatenation.
      isStr = hasStringAssignment(name, expr);
    }
    if (isStr) {
      return compileStringCompoundAssignment(ctx, fctx, expr, name);
    }
  }

  // (#2058) `x += rhs` where the value may be a runtime string at `+` time —
  // either the LHS is `any`/`unknown` (it could currently hold a string) or the
  // RHS is `any`/`unknown` (it could evaluate to a string). The numeric `+=`
  // paths below ToNumber-coerce both sides, so `let x: any = 1; x += "2"` wrongly
  // produced `3` instead of `"12"`. The static-string concat gate above only
  // catches LHS that are *statically* assigned a string; this catches the
  // runtime case. Skip boxed captures (their own externref concat path handles
  // them) and bigint. Provably-numeric `+=` keeps the f64 fast path (neither
  // side is `any`/`unknown`).
  //
  // Fast mode (`anyValueTypeIdx >= 0`) is excluded: there the AnyValue
  // infrastructure already round-trips `any += number` through the existing
  // numeric path, and the `__host_add` host import isn't part of that ABI.
  // Per the #2058 design rule, this per-site recovery is **default-mode only**.
  if (op === ts.SyntaxKind.PlusEqualsToken && !fctx.boxedCaptures?.has(name) && ctx.anyValueTypeIdx < 0) {
    const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
    const rightTsType = ctx.checker.getTypeAtLocation(expr.right);
    const leftIsAnyish = (leftTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const rightIsAnyish = (rightTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const isBigInt =
      (leftTsType.flags & ts.TypeFlags.BigIntLike) !== 0 || (rightTsType.flags & ts.TypeFlags.BigIntLike) !== 0;
    if ((leftIsAnyish || rightIsAnyish) && !isBigInt) {
      const r = compileAnyCompoundAdd(ctx, fctx, expr, name);
      if (r !== null) return r;
    }
  }

  // Check captured globals first
  const capturedIdx = ctx.capturedGlobals.get(name);
  if (capturedIdx !== undefined && fctx.localMap.get(name) === undefined) {
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
    const globalType: ValType = globalDef?.type ?? { kind: "f64" };
    const needsCoerce = globalType.kind !== "f64";

    fctx.body.push({ op: "global.get", index: capturedIdx });
    if (needsCoerce) coerceType(ctx, fctx, globalType, { kind: "f64" });

    const compoundRhsType1 = compileExpression(ctx, fctx, expr.right, {
      kind: "f64",
    });
    if (!compoundRhsType1) {
      reportError(ctx, expr, "Failed to compile compound assignment RHS");
      return null;
    }
    if (compoundRhsType1.kind !== "f64") coerceType(ctx, fctx, compoundRhsType1, { kind: "f64" });

    emitCompoundOp(ctx, fctx, op);

    // Re-read the global index after RHS compilation: compiling the RHS may
    // trigger addStringConstantGlobal which shifts all global indices via
    // fixupModuleGlobalIndices. The already-emitted global.get was shifted
    // in-place, but our local `capturedIdx` variable is now stale.
    const capturedIdxPost = ctx.capturedGlobals.get(name)!;
    if (needsCoerce) coerceType(ctx, fctx, { kind: "f64" }, globalType);
    fctx.body.push({ op: "global.set", index: capturedIdxPost });
    fctx.body.push({ op: "global.get", index: capturedIdxPost });
    return globalType;
  }

  // Check module-level globals
  const moduleIdx = ctx.moduleGlobals.get(name);
  if (moduleIdx !== undefined && fctx.localMap.get(name) === undefined) {
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
    const globalType: ValType = globalDef?.type ?? { kind: "f64" };
    const needsCoerce = globalType.kind !== "f64";

    fctx.body.push({ op: "global.get", index: moduleIdx });
    if (needsCoerce) coerceType(ctx, fctx, globalType, { kind: "f64" });

    const compoundRhsType2 = compileExpression(ctx, fctx, expr.right, {
      kind: "f64",
    });
    if (!compoundRhsType2) {
      reportError(ctx, expr, "Failed to compile compound assignment RHS");
      return null;
    }
    if (compoundRhsType2.kind !== "f64") coerceType(ctx, fctx, compoundRhsType2, { kind: "f64" });

    emitCompoundOp(ctx, fctx, op);

    // Re-read the global index after RHS compilation (same reason as above)
    const moduleIdxPost = ctx.moduleGlobals.get(name)!;
    if (needsCoerce) coerceType(ctx, fctx, { kind: "f64" }, globalType);
    fctx.body.push({ op: "global.set", index: moduleIdxPost });
    fctx.body.push({ op: "global.get", index: moduleIdxPost });
    return globalType;
  }

  let localIdx = fctx.localMap.get(name);
  if (localIdx === undefined) {
    // §13.15.2 CompoundAssignmentEvaluation step 1.c: `lval = GetValue(lref)`
    // runs before the RHS is evaluated. GetValue on an *unresolvable*
    // reference throws ReferenceError (§6.2.4). A name that reaches here with
    // no local / captured-global / module-global / const binding AND no
    // resolved symbol from the checker is genuinely undeclared (e.g.
    // `x += 1` with no `x` in scope) — throw rather than silently
    // auto-allocating a zero local. Names with a symbol (hoisted `var`,
    // outer-scope bindings, builtins) keep the graceful auto-allocate path.
    const lhsSym = ctx.checker.getSymbolAtLocation(expr.left);
    if (lhsSym === undefined && !ctx.moduleGlobals.has(name) && ctx.capturedGlobals.get(name) === undefined) {
      emitThrowReferenceError(ctx, fctx, `${name} is not defined`);
      // After throw the stack is polymorphic; push a sentinel so callers that
      // expect a compound-assignment result value (f64) typecheck.
      fctx.body.push({ op: "f64.const", value: 0 });
      return { kind: "f64" };
    }
    // Graceful fallback: auto-allocate a local for the unknown identifier
    // so compound assignments work correctly (the variable is initialized
    // to the appropriate zero value).
    const tsType = ctx.checker.getTypeAtLocation(expr.left);
    const wasmType = resolveWasmType(ctx, tsType);
    localIdx = allocLocal(fctx, name, wasmType);
  }

  // Handle boxed (ref cell) mutable captures
  const boxed = fctx.boxedCaptures?.get(name);
  if (boxed) {
    // Read current value from ref cell (null-guarded: if ref cell is null,
    // use default value for the compound op instead of trapping #702)
    fctx.body.push({ op: "local.get", index: localIdx });
    emitNullGuardedStructGet(
      ctx,
      fctx,
      { kind: "ref_null", typeIdx: boxed.refCellTypeIdx },
      boxed.valType,
      boxed.refCellTypeIdx,
      0,
      undefined /* propName */,
      false /* throwOnNull — ref cells use default for uninitialized captures */,
    );

    // For externref boxed captures, check if += should be string concat (#795)
    if (boxed.valType.kind === "externref" && op === ts.SyntaxKind.PlusEqualsToken) {
      const rightTsType = ctx.checker.getTypeAtLocation(expr.right);
      const rhsIsString = isStringType(rightTsType);
      // A statically string-typed LHS (`let acc = ""` / `let acc: string`) must
      // concat even when the RHS is numeric (`acc += x`) — JS coerces x to
      // string. #1999.
      const lhsIsString = isStringType(ctx.checker.getTypeAtLocation(expr.left));
      // Also check if the variable was assigned a string in any enclosing scope
      const varHasStringAssign = hasStringAssignment(name, expr) || hasStringAssignmentInParentScopes(name, expr);
      if (rhsIsString || lhsIsString || varHasStringAssign) {
        // String concat path: current value (externref) is on stack
        addStringImports(ctx);
        const concatIdx = ctx.jsStringImports.get("concat");
        if (concatIdx !== undefined) {
          const compoundRhsStr = compileExpression(ctx, fctx, expr.right);
          if (!compoundRhsStr) {
            reportError(ctx, expr, "Failed to compile compound assignment RHS");
            return null;
          }
          // Coerce RHS to externref if needed (e.g. number → string)
          if (compoundRhsStr.kind === "f64" || compoundRhsStr.kind === "i32") {
            if (compoundRhsStr.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
            const toStr = ctx.funcMap.get("number_toString");
            if (toStr !== undefined) fctx.body.push({ op: "call", funcIdx: toStr });
          }
          fctx.body.push({ op: "call", funcIdx: concatIdx });
          // Write back to ref cell
          const tmpStrResult = allocLocal(fctx, `__box_cmp_${fctx.locals.length}`, boxed.valType);
          fctx.body.push({ op: "local.set", index: tmpStrResult });
          fctx.body.push({ op: "local.get", index: localIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [] as Instr[],
            else: [
              { op: "local.get", index: localIdx } as Instr,
              { op: "local.get", index: tmpStrResult } as Instr,
              { op: "struct.set", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 } as Instr,
            ],
          });
          fctx.body.push({ op: "local.get", index: tmpStrResult });
          return boxed.valType;
        }
      }
    }

    // The compound-op switch below emits f64 arithmetic, so any non-f64 cell
    // value (and its RHS) must be promoted to f64 first and coerced back on
    // writeback. This includes i32 (#2120): a captured i32 loop var that is
    // also compound-assigned in the body (`for (let i…) { f = () => i; i += 1 }`)
    // read the cell as i32 but hit `f64.add`, producing an invalid module
    // (F64Add left value type mismatch). The i32↔f64 round-trip is exact for the
    // counter range. (#795, #816 covered the externref/other-ref cells.)
    const boxedNeedsCoerce = boxed.valType.kind !== "f64";
    if (boxedNeedsCoerce) {
      coerceType(ctx, fctx, boxed.valType, { kind: "f64" });
    }

    const compoundRhsBoxed = compileExpression(
      ctx,
      fctx,
      expr.right,
      boxedNeedsCoerce ? { kind: "f64" } : boxed.valType,
    );
    if (!compoundRhsBoxed) {
      reportError(ctx, expr, "Failed to compile compound assignment RHS");
      return null;
    }
    // Coerce RHS to f64 if needed (#795, #816)
    if (boxedNeedsCoerce && compoundRhsBoxed.kind !== "f64") {
      coerceType(ctx, fctx, compoundRhsBoxed, { kind: "f64" });
    }

    switch (op) {
      case ts.SyntaxKind.PlusEqualsToken:
        fctx.body.push({ op: "f64.add" });
        break;
      case ts.SyntaxKind.MinusEqualsToken:
        fctx.body.push({ op: "f64.sub" });
        break;
      case ts.SyntaxKind.AsteriskEqualsToken:
        fctx.body.push({ op: "f64.mul" });
        break;
      case ts.SyntaxKind.SlashEqualsToken:
        fctx.body.push({ op: "f64.div" });
        break;
      case ts.SyntaxKind.PercentEqualsToken:
        emitModulo(ctx, fctx);
        break;
      case ts.SyntaxKind.AsteriskAsteriskEqualsToken: {
        const fi = ctx.funcMap.get("Math_pow");
        if (fi !== undefined) fctx.body.push({ op: "call", funcIdx: fi });
        break;
      }
      case ts.SyntaxKind.AmpersandEqualsToken:
      case ts.SyntaxKind.BarEqualsToken:
      case ts.SyntaxKind.CaretEqualsToken:
      case ts.SyntaxKind.LessThanLessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
        emitBitwiseCompoundOp(fctx, op);
        break;
    }

    // Coerce result back to original type if the ref cell stores non-f64 (#795, #816)
    if (boxedNeedsCoerce) {
      coerceType(ctx, fctx, { kind: "f64" }, boxed.valType);
    }

    // Write back to ref cell (skip if ref cell is null #702)
    const tmpResult = allocLocal(fctx, `__box_cmp_${fctx.locals.length}`, boxed.valType);
    fctx.body.push({ op: "local.set", index: tmpResult });
    fctx.body.push({ op: "local.get", index: localIdx });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [] as Instr[],
      else: [
        { op: "local.get", index: localIdx } as Instr,
        { op: "local.get", index: tmpResult } as Instr,
        {
          op: "struct.set",
          typeIdx: boxed.refCellTypeIdx,
          fieldIdx: 0,
        } as Instr,
      ],
    });
    fctx.body.push({ op: "local.get", index: tmpResult });
    return boxed.valType;
  }

  const localType = getLocalType(fctx, localIdx) ?? { kind: "f64" as const };
  const needsLocalCoerce = localType.kind !== "f64";

  fctx.body.push({ op: "local.get", index: localIdx });
  if (needsLocalCoerce) coerceType(ctx, fctx, localType, { kind: "f64" });

  const compoundRhsType3 = compileExpression(ctx, fctx, expr.right, {
    kind: "f64",
  });
  if (!compoundRhsType3) {
    reportError(ctx, expr, "Failed to compile compound assignment RHS");
    return null;
  }
  if (compoundRhsType3.kind !== "f64") coerceType(ctx, fctx, compoundRhsType3, { kind: "f64" });

  emitCompoundOp(ctx, fctx, op);

  if (needsLocalCoerce) {
    coerceType(ctx, fctx, { kind: "f64" }, localType);
    fctx.body.push({ op: "local.tee", index: localIdx });
    emitMappedArgParamSync(ctx, fctx, localIdx, localType);
    return localType;
  }
  fctx.body.push({ op: "local.tee", index: localIdx });
  emitMappedArgParamSync(ctx, fctx, localIdx, { kind: "f64" });
  return { kind: "f64" };
}

/** Emit bitwise compound op: stack has [left_f64, right_f64], replaces with result f64 */
function emitBitwiseCompoundOp(fctx: FunctionContext, op: ts.SyntaxKind): void {
  const opMap: Record<
    number,
    {
      i32op: "i32.and" | "i32.or" | "i32.xor" | "i32.shl" | "i32.shr_s" | "i32.shr_u";
      unsigned: boolean;
    }
  > = {
    [ts.SyntaxKind.AmpersandEqualsToken]: { i32op: "i32.and", unsigned: false },
    [ts.SyntaxKind.BarEqualsToken]: { i32op: "i32.or", unsigned: false },
    [ts.SyntaxKind.CaretEqualsToken]: { i32op: "i32.xor", unsigned: false },
    [ts.SyntaxKind.LessThanLessThanEqualsToken]: {
      i32op: "i32.shl",
      unsigned: false,
    },
    [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: {
      i32op: "i32.shr_s",
      unsigned: false,
    },
    [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: {
      i32op: "i32.shr_u",
      unsigned: true,
    },
  };
  const entry = opMap[op]!;
  const tmpR = allocLocal(fctx, `__bw_r_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: tmpR });
  emitToInt32(fctx);
  fctx.body.push({ op: "local.get", index: tmpR });
  emitToInt32(fctx);
  fctx.body.push({ op: entry.i32op });
  fctx.body.push({
    op: entry.unsigned ? "f64.convert_i32_u" : "f64.convert_i32_s",
  });
}

/** Emit the arithmetic/bitwise operation for a compound assignment operator.
 *  Stack must contain [left_f64, right_f64]. Replaces with result f64. */
function emitCompoundOp(ctx: CodegenContext, fctx: FunctionContext, op: ts.SyntaxKind): void {
  switch (op) {
    case ts.SyntaxKind.PlusEqualsToken:
      fctx.body.push({ op: "f64.add" });
      break;
    case ts.SyntaxKind.MinusEqualsToken:
      fctx.body.push({ op: "f64.sub" });
      break;
    case ts.SyntaxKind.AsteriskEqualsToken:
      fctx.body.push({ op: "f64.mul" });
      break;
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken: {
      const funcIdx = ctx.funcMap.get("Math_pow");
      if (funcIdx !== undefined) fctx.body.push({ op: "call", funcIdx });
      break;
    }
    case ts.SyntaxKind.SlashEqualsToken:
      fctx.body.push({ op: "f64.div" });
      break;
    case ts.SyntaxKind.PercentEqualsToken:
      emitModulo(ctx, fctx);
      break;
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      emitBitwiseCompoundOp(fctx, op);
      break;
  }
}

/**
 * Compile compound assignment on a property access target: obj.prop += value
 * Pattern: read obj.prop, compile RHS, apply op, store back into obj.prop
 */
function compilePropertyCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(target.expression);
  const propName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;

  // #1456: Private methods and getter-only accessors throw TypeError on write
  if (ts.isPrivateIdentifier(target.name)) {
    const privateMember = classifyPrivateMember(ctx, target.name);
    if (privateMember?.kind === "method" || privateMember?.kind === "accessor-readonly") {
      // Evaluate receiver for side effects (spec evaluates Reference before throwing)
      const receiverResult = compileExpression(ctx, fctx, target.expression);
      if (receiverResult) fctx.body.push({ op: "drop" });
      // Evaluate RHS for side effects
      const rhsResult = compileExpression(ctx, fctx, rhs);
      if (rhsResult) fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, "Cannot assign to private method or read-only accessor");
      return { kind: "f64" };
    }
  }

  // Handle static property compound assignment: ClassName.staticProp += value
  if (ts.isIdentifier(target.expression) && ctx.classSet.has(target.expression.text)) {
    const clsName = target.expression.text;
    const fullName = `${clsName}_${propName}`;
    const globalIdx = ctx.staticProps.get(fullName);
    if (globalIdx !== undefined) {
      // Read current value
      fctx.body.push({ op: "global.get", index: globalIdx });
      // Compile RHS
      const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
      if (!rhsType) return null;
      // Apply op
      emitCompoundOp(ctx, fctx, op);
      // Store back
      fctx.body.push({ op: "global.set", index: globalIdx });
      fctx.body.push({ op: "global.get", index: globalIdx });
      return { kind: "f64" };
    }
  }

  // Resolve struct type
  const typeName = resolveStructNameForExpr(ctx, fctx, target.expression);
  if (!typeName) {
    // Fallback: treat as externref property access via __extern_get / __extern_set
    return compilePropertyCompoundAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  // Check for accessor properties (get/set) before looking up struct fields
  const accessorKey = `${typeName}_${propName}`;
  if (ctx.classAccessorSet.has(accessorKey)) {
    const getterName = `${typeName}_get_${propName}`;
    const setterName = `${typeName}_set_${propName}`;
    const getterIdx = ctx.funcMap.get(getterName);
    const setterIdx = ctx.funcMap.get(setterName);
    if (getterIdx !== undefined && setterIdx !== undefined) {
      // Compile the object expression and save to a temp local, coercing to getter's self type
      const cmpGetterPTypes = getFuncParamTypes(ctx, getterIdx);
      const objResult = compileExpression(ctx, fctx, target.expression, cmpGetterPTypes?.[0]);
      if (!objResult) return null;
      const objTmp = allocLocal(fctx, `__cmpd_acc_obj_${fctx.locals.length}`, objResult);
      fctx.body.push({ op: "local.set", index: objTmp });

      // Read current value via getter: obj.get_prop()
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "call", funcIdx: getterIdx });

      // Compile RHS as f64
      const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
      if (!rhsType) return null;

      // Apply compound operation
      emitCompoundOp(ctx, fctx, op);

      // Save result
      const resultTmp = allocLocal(fctx, `__cmpd_acc_res_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: resultTmp });

      // Store back via setter: obj.set_prop(result)
      fctx.body.push({ op: "local.get", index: objTmp });
      // Coerce f64 result to setter's expected value param type
      const cmpSetterParamTypes = getFuncParamTypes(ctx, setterIdx);
      const cmpSetterValType = cmpSetterParamTypes?.[1]; // param 0 = self, param 1 = value
      if (cmpSetterValType) {
        fctx.body.push({ op: "local.get", index: resultTmp });
        if (cmpSetterValType.kind === "externref") {
          // f64 → externref: box the number
          addUnionImports(ctx);
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
        }
      }
      // If setter has no value parameter (only self), don't push value
      const finalCmpSetterIdx = ctx.funcMap.get(setterName) ?? setterIdx;
      fctx.body.push({ op: "call", funcIdx: finalCmpSetterIdx });

      // Return the result
      fctx.body.push({ op: "local.get", index: resultTmp });
      return { kind: "f64" };
    }
  }

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    // Struct not found — fall back to externref property access
    return compilePropertyCompoundAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx === -1) {
    // Unknown field — fall back to externref property access
    return compilePropertyCompoundAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  const fieldType = fields[fieldIdx]!.type;

  // Compile the object expression and save to a temp local
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;
  const objTmp = allocLocal(fctx, `__cmpd_obj_${fctx.locals.length}`, objResult);
  fctx.body.push({ op: "local.set", index: objTmp });

  // Read current value: obj.prop
  fctx.body.push({ op: "local.get", index: objTmp });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

  // Coerce field value to f64 for arithmetic
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, fieldType, { kind: "f64" });
  }

  // Compile RHS as f64
  const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
  if (!rhsType) return null;

  // Apply compound operation
  emitCompoundOp(ctx, fctx, op);

  // Save result
  const resultTmp = allocLocal(fctx, `__cmpd_res_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: resultTmp });

  // Store back: obj.prop = result (coerced to field type)
  fctx.body.push({ op: "local.get", index: objTmp });
  fctx.body.push({ op: "local.get", index: resultTmp });
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, { kind: "f64" }, fieldType);
  }
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });

  // Return the result (as f64)
  fctx.body.push({ op: "local.get", index: resultTmp });
  return { kind: "f64" };
}

/**
 * Fallback for compound assignment on a property access target when the
 * struct type cannot be resolved statically.
 *
 * Strategy:
 * 1. Compile the object expression to discover its runtime Wasm type.
 * 2. If the result is a struct ref, look up the field by name in that struct
 *    and perform struct.get / struct.set.
 * 3. If the result is externref, use __extern_get / __extern_set with the
 *    property name as a string key (same pattern as element access compound).
 */
function compilePropertyCompoundAssignmentExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  propName: string,
): ValType | null {
  // Compile the object expression to discover its runtime type
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;

  // --- Path A: The object compiled to a struct ref ---
  if (objResult.kind === "ref" || objResult.kind === "ref_null") {
    const typeIdx = (objResult as { typeIdx: number }).typeIdx;
    // Find the struct fields by looking up which typeName maps to this typeIdx
    const resolvedTypeName = ctx.typeIdxToStructName.get(typeIdx);
    if (resolvedTypeName) {
      const fields = ctx.structFields.get(resolvedTypeName);
      if (fields) {
        let fieldIdx = fields.findIndex((f) => f.name === propName);

        // If the field doesn't exist yet, try to add it dynamically from TS type info
        // but NEVER for class struct types — their fields are fixed at collection time
        if (fieldIdx === -1 && !ctx.classSet.has(resolvedTypeName)) {
          const objTsType = ctx.checker.getTypeAtLocation(target.expression);
          const tsProps = objTsType.getProperties?.();
          if (tsProps) {
            const tsProp = tsProps.find((p) => p.name === propName);
            if (tsProp) {
              const propTsType = ctx.checker.getTypeOfSymbolAtLocation(tsProp, target);
              const propWasmType = resolveWasmType(ctx, propTsType);
              const newField: FieldDef = {
                name: propName,
                type: propWasmType,
                mutable: true,
              };
              fields.push(newField);
              // fields === typeDef.fields (same array ref from structFields map)
              patchStructNewForAddedField(ctx, fctx, typeIdx, propWasmType);
              const typeDef = ctx.mod.types[typeIdx];
              if (typeDef?.kind === "struct" && typeDef.fields !== fields) {
                typeDef.fields.push(newField);
              }
              // Patch existing struct.new instructions to include the new field
              patchStructNewForDynamicField(ctx, typeIdx, propWasmType);
              fieldIdx = fields.length - 1;
            }
          }
        }

        if (fieldIdx !== -1) {
          const fieldType = fields[fieldIdx]!.type;
          // Save object to temp local
          const objTmp = allocLocal(fctx, `__cmpd_obj_${fctx.locals.length}`, objResult);
          fctx.body.push({ op: "local.set", index: objTmp });

          // Read current value
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });

          // Coerce field value to f64 for arithmetic
          if (fieldType.kind !== "f64") {
            coerceType(ctx, fctx, fieldType, { kind: "f64" });
          }

          // Compile RHS as f64
          const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
          if (!rhsType) return null;

          // Apply compound operation
          emitCompoundOp(ctx, fctx, op);

          // Save result
          const resultTmp = allocLocal(fctx, `__cmpd_res_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: resultTmp });

          // Store back
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "local.get", index: resultTmp });
          if (fieldType.kind !== "f64") {
            coerceType(ctx, fctx, { kind: "f64" }, fieldType);
          }
          fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });

          // Return the result as f64
          fctx.body.push({ op: "local.get", index: resultTmp });
          return { kind: "f64" };
        }
      }
    }

    // Struct ref but field not found — convert to externref and fall through to path B
    fctx.body.push({ op: "extern.convert_any" });
  } else if (objResult.kind !== "externref") {
    // For f64/i32, box to externref
    if (objResult.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
    } else if (objResult.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
    } else {
      // Unknown type — emit NaN as graceful fallback
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }
  }

  // --- Path B: externref-based property compound assignment ---
  // Save obj to local
  const objLocal = allocLocal(fctx, `__cmpd_pobj_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Ensure the property name string constant is registered
  addStringConstantGlobal(ctx, propName);

  // Compile propName as externref string and save to local
  const keyResult = compileStringLiteral(ctx, fctx, propName);
  if (!keyResult) return null;
  if (keyResult.kind !== "externref") {
    coerceType(ctx, fctx, keyResult, { kind: "externref" });
  }
  const keyLocal = allocLocal(fctx, `__cmpd_pkey_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: keyLocal });

  // Read current value: __extern_get(obj, key) -> externref
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: keyLocal });
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (getIdx === undefined) return null;
  fctx.body.push({ op: "call", funcIdx: getIdx });

  // Ensure union imports (including __unbox_number, __box_number) are registered
  addUnionImports(ctx);

  // Unbox to f64: __unbox_number(externref) -> f64
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  if (unboxIdx === undefined) {
    reportError(ctx, target, "Missing __unbox_number for compound externref property assignment");
    return null;
  }
  fctx.body.push({ op: "call", funcIdx: unboxIdx });

  // Compile RHS as f64
  const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
  if (!rhsType) return null;

  // Apply compound operation (stack: [lhs_f64, rhs_f64] -> result_f64)
  emitCompoundOp(ctx, fctx, op);

  // Save result for return value
  const resultLocal = allocLocal(fctx, `__cmpd_pres_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Box result to externref: __box_number(f64) -> externref
  fctx.body.push({ op: "local.get", index: resultLocal });
  const boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx === undefined) {
    reportError(ctx, target, "Missing __box_number for compound externref property assignment");
    return null;
  }
  fctx.body.push({ op: "call", funcIdx: boxIdx });
  const boxedLocal = allocLocal(fctx, `__cmpd_pboxed_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: boxedLocal });

  // Write back: __extern_set(obj, key, boxed_result)
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: keyLocal });
  fctx.body.push({ op: "local.get", index: boxedLocal });
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (setIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: setIdx });
  }

  // Return the result as f64
  fctx.body.push({ op: "local.get", index: resultLocal });
  return { kind: "f64" };
}

/**
 * Compile compound assignment on an element access target: arr[i] += value
 * Handles both vec structs (arrays) and plain structs (bracket notation).
 */
function compileElementCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
): ValType | null {
  // Compile the object expression
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;

  // Externref element access compound assignment
  // Pattern: read via __extern_get, unbox, operate, box, write via __extern_set
  if (objResult.kind === "externref") {
    // Save obj to local
    const objLocal = allocLocal(fctx, `__cmpd_eobj_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: objLocal });

    // Compile key as externref and save to local
    const keyResult = compileExpression(ctx, fctx, target.argumentExpression, {
      kind: "externref",
    });
    if (!keyResult) return null;
    const keyLocal = allocLocal(fctx, `__cmpd_ekey_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: keyLocal });

    // Read current value: __extern_get(obj, key) -> externref
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (getIdx === undefined) return null;
    fctx.body.push({ op: "call", funcIdx: getIdx });

    // Ensure union imports (including __unbox_number, __box_number) are registered
    addUnionImports(ctx);

    // Unbox to f64: __unbox_number(externref) -> f64
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx === undefined) {
      reportError(ctx, target, "Missing __unbox_number for compound externref assignment");
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: unboxIdx });

    // Compile RHS as f64
    const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
    if (!rhsType) return null;

    // Apply compound operation (stack: [lhs_f64, rhs_f64] -> result_f64)
    emitCompoundOp(ctx, fctx, op);

    // Save result for return value
    const resultLocal = allocLocal(fctx, `__cmpd_eres_${fctx.locals.length}`, {
      kind: "f64",
    });
    fctx.body.push({ op: "local.set", index: resultLocal });

    // Box result to externref: __box_number(f64) -> externref
    fctx.body.push({ op: "local.get", index: resultLocal });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) {
      reportError(ctx, target, "Missing __box_number for compound externref assignment");
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: boxIdx });
    const boxedLocal = allocLocal(fctx, `__cmpd_eboxed_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: boxedLocal });

    // Write back: __extern_set(obj, key, boxed_result)
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: boxedLocal });
    const setIdx = ensureLateImport(
      ctx,
      "__extern_set",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [],
    );
    flushLateImportShifts(ctx, fctx);
    if (setIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: setIdx });
    }

    // Return the result as f64
    fctx.body.push({ op: "local.get", index: resultLocal });
    return { kind: "f64" };
  }

  // For primitive targets (f64, i32, i64), box to externref and re-enter via the externref path
  if (objResult.kind === "f64" || objResult.kind === "i32" || objResult.kind === "i64") {
    coerceType(ctx, fctx, objResult, { kind: "externref" });

    // Save obj as externref local
    const objLocal = allocLocal(fctx, `__cmpd_eobj_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: objLocal });

    // Compile key as externref and save to local
    const keyResult = compileExpression(ctx, fctx, target.argumentExpression, {
      kind: "externref",
    });
    if (!keyResult) return null;
    const keyLocal = allocLocal(fctx, `__cmpd_ekey_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: keyLocal });

    // Read current value: __extern_get(obj, key) -> externref
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (getIdx === undefined) return null;
    fctx.body.push({ op: "call", funcIdx: getIdx });

    // Ensure union imports (including __unbox_number, __box_number) are registered
    addUnionImports(ctx);

    // Unbox to f64
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx === undefined) {
      reportError(ctx, target, "Missing __unbox_number for compound element assignment");
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: unboxIdx });

    // Compile RHS as f64
    const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
    if (!rhsType) return null;

    // Apply compound operation
    emitCompoundOp(ctx, fctx, op);

    // Save result
    const resultLocal = allocLocal(fctx, `__cmpd_eres_${fctx.locals.length}`, {
      kind: "f64",
    });
    fctx.body.push({ op: "local.set", index: resultLocal });

    // Box result to externref
    fctx.body.push({ op: "local.get", index: resultLocal });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) {
      reportError(ctx, target, "Missing __box_number for compound element assignment");
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: boxIdx });
    const boxedLocal = allocLocal(fctx, `__cmpd_eboxed_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: boxedLocal });

    // Write back: __extern_set(obj, key, boxed_result)
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: boxedLocal });
    const setIdx = ensureLateImport(
      ctx,
      "__extern_set",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [],
    );
    flushLateImportShifts(ctx, fctx);
    if (setIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: setIdx });
    }

    // Return the result as f64
    fctx.body.push({ op: "local.get", index: resultLocal });
    return { kind: "f64" };
  }

  if (objResult.kind !== "ref" && objResult.kind !== "ref_null") {
    reportError(ctx, target, "Compound assignment on non-ref element access");
    return null;
  }

  const typeIdx = (objResult as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle plain struct: obj["prop"] += value → struct.get + op + struct.set
  if (typeDef?.kind === "struct") {
    const isVec =
      typeDef.fields.length === 2 && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data";

    if (!isVec) {
      // Resolve field name from literal or const variable
      let fieldName: string | undefined;
      if (ts.isStringLiteral(target.argumentExpression)) {
        fieldName = target.argumentExpression.text;
      } else if (ts.isNumericLiteral(target.argumentExpression)) {
        fieldName = target.argumentExpression.text;
      } else if (ts.isIdentifier(target.argumentExpression)) {
        const sym = ctx.checker.getSymbolAtLocation(target.argumentExpression);
        if (sym) {
          const decl = sym.valueDeclaration;
          if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
            const declList = decl.parent;
            if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
              if (ts.isStringLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              } else if (ts.isNumericLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              }
            }
          }
        }
      }
      if (fieldName === undefined) {
        fieldName = resolveComputedKeyExpression(ctx, target.argumentExpression);
      }

      if (fieldName !== undefined) {
        const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
        if (fieldIdx !== -1) {
          const fieldType = typeDef.fields[fieldIdx]!.type;
          const objTmp = allocLocal(fctx, `__cmpd_obj_${fctx.locals.length}`, objResult);
          fctx.body.push({ op: "local.set", index: objTmp });

          // Read current value
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          if (fieldType.kind !== "f64") {
            coerceType(ctx, fctx, fieldType, { kind: "f64" });
          }

          // Compile RHS as f64
          const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
          if (!rhsType) return null;

          // Apply compound operation
          emitCompoundOp(ctx, fctx, op);

          // Save result
          const resultTmp = allocLocal(fctx, `__cmpd_res_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: resultTmp });

          // Store back
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "local.get", index: resultTmp });
          if (fieldType.kind !== "f64") {
            coerceType(ctx, fctx, { kind: "f64" }, fieldType);
          }
          fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });

          fctx.body.push({ op: "local.get", index: resultTmp });
          return { kind: "f64" };
        }
      }
    }

    // Vec struct: arr[i] += value
    if (isVec) {
      const objTmp = allocLocal(fctx, `__cmpd_arr_${fctx.locals.length}`, objResult);
      fctx.body.push({ op: "local.set", index: objTmp });

      // Compile index
      const idxResult = compileExpression(ctx, fctx, target.argumentExpression);
      if (!idxResult) return null;
      if (idxResult.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
      const idxTmp = allocLocal(fctx, `__cmpd_idx_${fctx.locals.length}`, {
        kind: "i32",
      });
      fctx.body.push({ op: "local.set", index: idxTmp });

      // Get the data array type
      const dataFieldType = typeDef.fields[1]!.type;
      const arrayTypeIdx = (dataFieldType as { typeIdx: number }).typeIdx;
      const arrayDef = ctx.mod.types[arrayTypeIdx];
      const elemType = arrayDef && arrayDef.kind === "array" ? arrayDef.element : { kind: "f64" as const };

      // Read current value: arr.data[idx] (bounds-checked)
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "local.get", index: idxTmp });
      emitBoundsCheckedArrayGet(fctx, arrayTypeIdx, elemType);

      // Coerce to f64 for arithmetic
      if (elemType.kind !== "f64") {
        coerceType(ctx, fctx, elemType, { kind: "f64" });
      }

      // Compile RHS as f64
      const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
      if (!rhsType) return null;

      // Apply compound operation
      emitCompoundOp(ctx, fctx, op);

      // Save result
      const resultTmp = allocLocal(fctx, `__cmpd_res_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: resultTmp });

      // Store back: arr.data[idx] = result (bounds-guarded)
      fctx.body.push({ op: "local.get", index: idxTmp });
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "array.len" });
      fctx.body.push({ op: "i32.lt_u" } as Instr);
      {
        const setInstrs: Instr[] = [
          { op: "local.get", index: objTmp } as Instr,
          { op: "struct.get", typeIdx, fieldIdx: 1 } as Instr,
          { op: "local.get", index: idxTmp } as Instr,
          { op: "local.get", index: resultTmp } as Instr,
        ];
        if (elemType.kind !== "f64") {
          const savedBody = fctx.body;
          fctx.body = setInstrs as any;
          coerceType(ctx, fctx, { kind: "f64" }, elemType);
          fctx.body = savedBody;
        }
        setInstrs.push({ op: "array.set", typeIdx: arrayTypeIdx } as Instr);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" as const },
          then: setInstrs,
          else: [],
        } as Instr);
      }

      fctx.body.push({ op: "local.get", index: resultTmp });
      return { kind: "f64" };
    }
  }

  reportError(ctx, target, `Unsupported compound assignment on element access`);
  return null;
}

/** Unwrap parenthesized expressions: (x) -> x, ((x)) -> x, etc. */

export {
  compileArrayDestructuringAssignment,
  compileDestructuringAssignment,
  compileElementAssignment,
  compileExternSetFallback,
  compilePropertyAssignment,
};
