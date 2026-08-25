// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Variable declaration statement lowering.
 */
import { ts, forEachChild } from "../../ts-api.js";
import { isNullablePrimitiveType, isStringType, isVoidType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { reportError } from "../context/errors.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import { redeclarationWidenedLocalSlotType } from "../declarations/redeclared-var-widening.js";
import type { CodegenContext, FunctionContext, NullGuardFact, NullishExclusion } from "../context/types.js";
import { emitCoercedLocalSet, noJsHost } from "../expressions/helpers.js";
import { emitUndefined } from "../expressions/late-imports.js";
import {
  nativeGeneratorBindingType,
  needsTdzFlag,
  resolveWasmType,
  varBindingNeedsExternrefForUndefined,
} from "../index.js";
import { nativeTypeOfDeclaration } from "../native-type-annotations.js";
import { widenedVarKeyFromDecl } from "../widened-var-key.js";
import { concatCallYieldsDynamicCarrier } from "../array-concat-carrier.js"; // (#4655) concat result-slot carrier
import { emitShapeInferredVecInit } from "../shape-vec-literal-seed.js"; // (#4491) module-global array-carrier seed
import {
  arrayLiteralEscapeWidensToExternref,
  objectLiteralIsStandaloneAnyObjectCarrier,
  objectLiteralForcesHostPath,
  objectLiteralSpreadTakesHostPath,
  resolveComputedKeyExpression,
} from "../literals.js";
import { ensureObjectRuntime } from "../object-runtime.js"; // (#3037 CS1a) $Object type idx for any-object carrier
import { localGlobalIdx } from "../registry/imports.js";
import {
  getOrRegisterArrayType,
  getOrRegisterHoleyArrayType,
  getOrRegisterSubviewType,
  getOrRegisterTaViewType,
  getOrRegisterVecType,
} from "../registry/types.js";
import { coerceType, compileExpression, valTypesMatch } from "../shared.js";
import { resolveFnctorTypedBindingType } from "../fnctor-typed-bindings.js";
import { emitGuardedRefCast } from "../type-coercion.js";
import { emitLazyClassObjectGet } from "../expressions/extern.js";
import { compileArrayDestructuring, compileObjectDestructuring } from "./destructuring.js";
import { compileNestedClassDeclaration, emitPreparedAccessorComputedNameEffects } from "./nested-declarations.js";
import { emitLocalTdzInit, emitTdzInit } from "./tdz.js";
import { ensureNativeStringHelpers, flatStringType } from "../native-strings.js";
import { compileStringBuilderInit } from "../string-builder.js";
import { tryEmitLinearU8New } from "../linear-uint8-codegen.js";
import { tryCompileWithScopedVarDeclaration } from "../with-var-decl.js";
import {
  bindingHasMixedAssignmentCarrier,
  numericProofOverridesMixedCarrier,
} from "../analysis/mixed-assignment-carrier.js";
import { declarationReadsStructuralObjectFromRealmGlobal } from "../analysis/realm-global-structural-carrier.js";
import { staticConstStringValues } from "../analysis/static-string-values.js";
import { staticIntegerRange } from "../../ir/analysis/static-numeric-range.js";
import { tryEmitStaticI32Expression } from "../i32-static-range-expr.js";
import { tryCompileSingleUnitSplitLengthBinding } from "../derived-split-scalar.js";
import { tryCompileDerivedAsciiCaseBinding as tryAsciiCase } from "../derived-ascii-case.js";
import { detectNullGuardAlias } from "./null-guard-alias.js"; // (#4555) extraction
import { reusedVarSlotIndex } from "./var-slot-reuse.js"; // (#4555) §10.5 step 8

function symbolIsReadOnlyThroughLength(
  ctx: CodegenContext,
  symbol: ts.Symbol,
  declaration: ts.VariableDeclaration,
): boolean {
  let safe = true;
  let scope: ts.Node = declaration;
  while (scope.parent && !ts.isFunctionLike(scope.parent) && !ts.isSourceFile(scope.parent)) scope = scope.parent;
  scope = scope.parent ?? scope;
  const visit = (node: ts.Node): void => {
    if (!safe) return;
    if (ts.isIdentifier(node) && ctx.checker.getSymbolAtLocation(node) === symbol) {
      if (node === declaration.name) return;
      const property = node.parent;
      if (!ts.isPropertyAccessExpression(property) || property.expression !== node || property.name.text !== "length") {
        safe = false;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(scope);
  return safe;
}

function isCanonicalSplitElementIndex(
  ctx: CodegenContext,
  element: ts.ElementAccessExpression,
  arraySymbol: ts.Symbol,
): boolean {
  const index = element.argumentExpression;
  if (!index || !ts.isIdentifier(index)) return false;
  const indexSymbol = ctx.checker.getSymbolAtLocation(index);
  const declaration = indexSymbol?.valueDeclaration;
  if (!indexSymbol || !declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  const list = declaration.parent;
  const loop = ts.isVariableDeclarationList(list) && ts.isForStatement(list.parent) ? list.parent : undefined;
  if (!loop || loop.initializer !== list || !loop.condition || !loop.incrementor) return false;
  const start = staticIntegerRange(ctx, declaration.initializer);
  if (!start || start.min !== start.max || start.min < 0) return false;
  if (
    !ts.isBinaryExpression(loop.condition) ||
    loop.condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    !ts.isIdentifier(loop.condition.left) ||
    ctx.checker.getSymbolAtLocation(loop.condition.left) !== indexSymbol ||
    !ts.isPropertyAccessExpression(loop.condition.right) ||
    loop.condition.right.name.text !== "length" ||
    !ts.isIdentifier(loop.condition.right.expression) ||
    ctx.checker.getSymbolAtLocation(loop.condition.right.expression) !== arraySymbol
  ) {
    return false;
  }
  const increment = loop.incrementor;
  if (
    (ts.isPrefixUnaryExpression(increment) || ts.isPostfixUnaryExpression(increment)) &&
    increment.operator === ts.SyntaxKind.PlusPlusToken &&
    ts.isIdentifier(increment.operand) &&
    ctx.checker.getSymbolAtLocation(increment.operand) === indexSymbol
  ) {
    return true;
  }
  if (!ts.isBinaryExpression(increment) || !ts.isIdentifier(increment.left)) return false;
  if (ctx.checker.getSymbolAtLocation(increment.left) !== indexSymbol) return false;
  if (increment.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
    const step = staticIntegerRange(ctx, increment.right);
    return step?.min === 1 && step.max === 1;
  }
  if (increment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isBinaryExpression(increment.right)) {
    return false;
  }
  const rhs = increment.right;
  return (
    rhs.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    ts.isIdentifier(rhs.left) &&
    ctx.checker.getSymbolAtLocation(rhs.left) === indexSymbol &&
    staticIntegerRange(ctx, rhs.right)?.min === 1 &&
    staticIntegerRange(ctx, rhs.right)?.max === 1
  );
}

function isNestedLengthOnlySplitElement(
  ctx: CodegenContext,
  element: ts.ElementAccessExpression,
  arraySymbol: ts.Symbol,
): boolean {
  if (!isCanonicalSplitElementIndex(ctx, element, arraySymbol)) return false;
  const property = element.parent;
  if (!ts.isPropertyAccessExpression(property) || property.expression !== element || property.name.text !== "split") {
    return false;
  }
  const call = property.parent;
  if (
    !ts.isCallExpression(call) ||
    call.expression !== property ||
    call.arguments.length !== 1 ||
    !ts.isStringLiteralLike(call.arguments[0]!)
  ) {
    return false;
  }
  const values = staticConstStringValues(ctx, element);
  if (!values) return false;
  const separator = call.arguments[0]!.text;
  if (new Set(values.map((value) => value.split(separator).length)).size !== 1) return false;
  const declaration = call.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== call ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  ) {
    return false;
  }
  const symbol = ctx.checker.getSymbolAtLocation(declaration.name);
  return symbol !== undefined && symbolIsReadOnlyThroughLength(ctx, symbol, declaration);
}

function tryCompileUniformSplitLengthBinding(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.VariableStatement,
  decl: ts.VariableDeclaration,
): boolean {
  if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) return false;
  if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isCallExpression(decl.initializer)) return false;
  const call = decl.initializer;
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "split") return false;
  if (call.arguments.length !== 1 || !ts.isStringLiteralLike(call.arguments[0]!)) return false;

  const symbol = ctx.checker.getSymbolAtLocation(decl.name);
  if (!symbol) return false;
  let scalarReadsOnly = true;
  let hasNestedElementReads = false;
  const scope = (() => {
    let node: ts.Node = decl;
    while (node.parent && !ts.isFunctionLike(node.parent) && !ts.isSourceFile(node.parent)) node = node.parent;
    return node.parent ?? node;
  })();
  const visit = (node: ts.Node): void => {
    if (!scalarReadsOnly) return;
    if (ts.isIdentifier(node) && ctx.checker.getSymbolAtLocation(node) === symbol) {
      if (node === decl.name) return;
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "length") {
        // accepted
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        if (!isNestedLengthOnlySplitElement(ctx, parent, symbol)) {
          scalarReadsOnly = false;
          return;
        }
        hasNestedElementReads = true;
      } else {
        scalarReadsOnly = false;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(scope);
  if (!scalarReadsOnly) return false;

  const receiver = call.expression.expression;
  const values = staticConstStringValues(ctx, receiver);
  if (!values) return false;
  const separator = call.arguments[0]!.text;
  const lengths = new Set(values.map((value) => value.split(separator).length));
  if (lengths.size !== 1) return false;
  const length = lengths.values().next().value;
  if (length === undefined) return false;

  // A nested CSV-shaped descriptor retains the outer split call so the source
  // still performs one real string operation per document. Only its unobserved
  // result array and the inner length-only splits are scalar-replaced. A plain
  // length-only binding needs only the receiver evaluation and its null/OOB
  // trap; the literal separator itself has no side effects.
  const derivedElement =
    ts.isElementAccessExpression(receiver) && ts.isIdentifier(receiver.expression)
      ? (() => {
          const arraySymbol = ctx.checker.getSymbolAtLocation(receiver.expression);
          return arraySymbol && fctx.derivedStaticSplitArrays?.has(arraySymbol)
            ? { arraySymbol, safe: isCanonicalSplitElementIndex(ctx, receiver, arraySymbol) }
            : undefined;
        })()
      : undefined;
  if (derivedElement && !derivedElement.safe) return false;
  if (hasNestedElementReads) {
    const splitType = compileExpression(ctx, fctx, call);
    if (splitType) fctx.body.push({ op: "drop" });
  } else if (!derivedElement) {
    const receiverType = compileExpression(ctx, fctx, receiver);
    if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
      if (receiverType?.kind === "externref") {
        coerceType(ctx, fctx, receiverType, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
      }
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
      fctx.body.push({ op: "drop" });
    } else if (receiverType) {
      fctx.body.push({ op: "drop" });
    }
  }
  fctx.body.push({ op: "i32.const", value: length });
  const localIdx = allocLocal(fctx, `__split_length_${decl.name.text}_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: localIdx });
  (fctx.derivedStringArrayLengthLocals ??= new Map()).set(symbol, localIdx);
  if (hasNestedElementReads) {
    (fctx.derivedStaticSplitArrays ??= new Map()).set(symbol, { length });
  }
  emitTdzInit(ctx, fctx, decl.name.text);
  return true;
}

function tryCompileDerivedSubstringBinding(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.VariableStatement,
  decl: ts.VariableDeclaration,
): boolean {
  if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) {
    return false;
  }
  if (ctx.nativeStrings && (ctx.nativeStrTypeIdx < 0 || ctx.nativeStrDataTypeIdx < 0)) return false;
  if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isCallExpression(decl.initializer)) return false;
  const call = decl.initializer;
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "substring") return false;
  if (call.arguments.length !== 2) return false;

  let descriptorOnly = true;
  const scope = (() => {
    let node: ts.Node = decl;
    while (node.parent && !ts.isFunctionLike(node.parent) && !ts.isSourceFile(node.parent)) node = node.parent;
    return node.parent ?? node;
  })();
  const visit = (node: ts.Node): void => {
    if (!descriptorOnly) return;
    if (ts.isIdentifier(node) && ctx.oracle.valueDeclarationOf(node) === decl) {
      if (node === decl.name) return;
      const property = node.parent;
      if (!ts.isPropertyAccessExpression(property) || property.expression !== node) {
        descriptorOnly = false;
        return;
      }
      if (property.name.text === "length") {
        // accepted
      } else if (
        property.name.text !== "charCodeAt" ||
        !ts.isCallExpression(property.parent) ||
        property.parent.expression !== property
      ) {
        descriptorOnly = false;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(scope);
  if (!descriptorOnly) return false;

  const receiver = call.expression.expression;
  const receiverValues = staticConstStringValues(ctx, receiver);
  const startRange = staticIntegerRange(ctx, call.arguments[0]!);
  const endRange = staticIntegerRange(ctx, call.arguments[1]!);
  const shortestReceiver = receiverValues ? Math.min(...receiverValues.map((value) => value.length)) : -1;
  const orderedInBounds =
    startRange !== undefined &&
    endRange !== undefined &&
    shortestReceiver >= 0 &&
    startRange.min >= 0 &&
    endRange.min >= 0 &&
    startRange.max <= endRange.min &&
    endRange.max <= shortestReceiver;

  const compileIndex = (arg: ts.Expression, local: number): void => {
    if (!tryEmitStaticI32Expression(ctx, fctx, arg)) {
      const type = compileExpression(ctx, fctx, arg, { kind: "i32" });
      if (type && type.kind !== "i32") coerceType(ctx, fctx, type, { kind: "i32" });
    }
    fctx.body.push({ op: "local.set", index: local });
  };
  const startLocal = allocLocal(fctx, `__substring_start_${fctx.locals.length}`, { kind: "i32" });
  const endLocal = allocLocal(fctx, `__substring_end_${fctx.locals.length}`, { kind: "i32" });

  if (!ctx.nativeStrings) {
    // A host string is opaque to Wasm, but a non-escaping, range-proven
    // substring can still be represented as (receiver, offset, length). Its
    // charCodeAt consumers use the wasm:js-string builtin against the original
    // receiver at offset+index, avoiding substring allocation and length calls.
    if (!orderedInBounds) return false;
    const receiverLocal = allocLocal(fctx, `__substring_host_recv_${fctx.locals.length}`, { kind: "externref" });
    const receiverType = compileExpression(ctx, fctx, receiver, { kind: "externref" });
    if (receiverType && receiverType.kind !== "externref" && receiverType.kind !== "ref_extern") {
      coerceType(ctx, fctx, receiverType, { kind: "externref" });
    }
    fctx.body.push({ op: "local.set", index: receiverLocal });
    compileIndex(call.arguments[0]!, startLocal);
    compileIndex(call.arguments[1]!, endLocal);
    const lenLocal = allocLocal(fctx, `__substring_len_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.get", index: endLocal });
    fctx.body.push({ op: "local.get", index: startLocal });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "local.set", index: lenLocal });
    (fctx.derivedSubstringReads ??= new Map()).set(decl, {
      kind: "host",
      receiverLocal,
      offLocal: startLocal,
      lenLocal,
      minLen: endRange!.min - startRange!.max,
    });
    emitTdzInit(ctx, fctx, decl.name.text);
    return true;
  }

  ensureNativeStringHelpers(ctx);
  const flatLocal = allocLocal(fctx, `__substring_flat_${fctx.locals.length}`, flatStringType(ctx));
  const receiverType = compileExpression(ctx, fctx, receiver);
  if (receiverType?.kind === "externref") {
    coerceType(ctx, fctx, receiverType, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
  }
  if (receiverValues) {
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.nativeStrTypeIdx });
  } else {
    fctx.body.push({ op: "call", funcIdx: ctx.nativeStrHelpers.get("__str_flatten")! });
  }
  fctx.body.push({ op: "local.set", index: flatLocal });

  const sourceLenLocal = orderedInBounds
    ? undefined
    : allocLocal(fctx, `__substring_source_len_${fctx.locals.length}`, { kind: "i32" });
  if (sourceLenLocal !== undefined) {
    fctx.body.push({ op: "local.get", index: flatLocal });
    fctx.body.push({ op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "local.set", index: sourceLenLocal });
  }

  compileIndex(call.arguments[0]!, startLocal);
  compileIndex(call.arguments[1]!, endLocal);

  const clamp = (local: number): void => {
    const sourceLength = sourceLenLocal!;
    fctx.body.push({ op: "local.get", index: local });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: local },
      ],
    });
    fctx.body.push({ op: "local.get", index: local });
    fctx.body.push({ op: "local.get", index: sourceLength });
    fctx.body.push({ op: "i32.gt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: sourceLength },
        { op: "local.set", index: local },
      ],
    });
  };
  if (!orderedInBounds) {
    clamp(startLocal);
    clamp(endLocal);
    const swapLocal = allocLocal(fctx, `__substring_swap_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.get", index: startLocal });
    fctx.body.push({ op: "local.get", index: endLocal });
    fctx.body.push({ op: "i32.gt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: startLocal },
        { op: "local.set", index: swapLocal },
        { op: "local.get", index: endLocal },
        { op: "local.set", index: startLocal },
        { op: "local.get", index: swapLocal },
        { op: "local.set", index: endLocal },
      ],
    });
  }

  const dataLocal = allocLocal(fctx, `__substring_data_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ctx.nativeStrDataTypeIdx,
  });
  const offLocal = allocLocal(fctx, `__substring_off_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = allocLocal(fctx, `__substring_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 2 });
  fctx.body.push({ op: "local.set", index: dataLocal });
  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.get", index: startLocal });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: offLocal });
  fctx.body.push({ op: "local.get", index: endLocal });
  fctx.body.push({ op: "local.get", index: startLocal });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: lenLocal });
  const minLen = orderedInBounds ? endRange!.min - startRange!.max : 0;
  (fctx.derivedSubstringReads ??= new Map()).set(decl, {
    kind: "native",
    dataLocal,
    offLocal,
    lenLocal,
    minLen,
  });
  emitTdzInit(ctx, fctx, decl.name.text);
  return true;
}

function tryCompileUniformIndexPresenceBinding(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.VariableStatement,
  decl: ts.VariableDeclaration,
): boolean {
  if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) return false;
  if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isCallExpression(decl.initializer)) return false;
  const call = decl.initializer;
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "indexOf") return false;
  if (call.arguments.length !== 1) return false;
  const receivers = staticConstStringValues(ctx, call.expression.expression);
  const searches = staticConstStringValues(ctx, call.arguments[0]!);
  if (!receivers || !searches || new Set(searches).size !== 1) return false;
  const search = searches[0]!;
  const presence = new Set(receivers.map((receiver) => receiver.indexOf(search) >= 0));
  if (presence.size !== 1) return false;

  const symbol = ctx.checker.getSymbolAtLocation(decl.name);
  if (!symbol) return false;
  let signOnly = true;
  let scope: ts.Node = decl;
  while (scope.parent && !ts.isFunctionLike(scope.parent) && !ts.isSourceFile(scope.parent)) scope = scope.parent;
  scope = scope.parent ?? scope;
  const visit = (node: ts.Node): void => {
    if (!signOnly) return;
    if (ts.isIdentifier(node) && ctx.checker.getSymbolAtLocation(node) === symbol) {
      if (node === decl.name) return;
      const comparison = node.parent;
      if (
        !ts.isBinaryExpression(comparison) ||
        comparison.left !== node ||
        comparison.operatorToken.kind !== ts.SyntaxKind.GreaterThanEqualsToken ||
        !ts.isNumericLiteral(comparison.right) ||
        Number(comparison.right.text) !== 0
      ) {
        signOnly = false;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(scope);
  if (!signOnly) return false;

  const receiverType = compileExpression(ctx, fctx, call.expression.expression);
  if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    if (receiverType?.kind === "externref") {
      coerceType(ctx, fctx, receiverType, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
    }
    fctx.body.push({ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "drop" });
  } else if (receiverType) {
    fctx.body.push({ op: "drop" });
  }
  const existing = fctx.localMap.get(decl.name.text);
  const localIdx = existing ?? allocLocal(fctx, decl.name.text, { kind: "f64" });
  const localType = getLocalType(fctx, localIdx) ?? { kind: "f64" as const };
  fctx.body.push({
    op: localType.kind === "i32" ? "i32.const" : "f64.const",
    value: presence.values().next().value ? 0 : -1,
  });
  fctx.body.push({ op: "local.set", index: localIdx });
  emitTdzInit(ctx, fctx, decl.name.text);
  return true;
}

export function inferArrayVecType(ctx: CodegenContext, decl: ts.VariableDeclaration): ValType | null {
  if (!ts.isIdentifier(decl.name)) return null;
  if (ctx.holeyArrayDeclarations.has(decl)) {
    return { kind: "ref_null", typeIdx: getOrRegisterHoleyArrayType(ctx) };
  }
  const varName = decl.name.text;

  // Walk up to the enclosing function body or source file
  let scope: ts.Node = decl;
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
  if (!scope) return null;

  let inferredElemType: ts.Type | null = null;
  let inferredElemWasm: ValType | null = null;
  let mixedElementCarrier = false;
  let sawDynamicElementWrite = false;

  // (#2806) A write whose value type is purely `undefined` / `void` / `null`
  // must NOT pin the array's element kind to a numeric (i32) vec. The canonical
  // source is acorn's `var elt = (void 0); elt = <nodeRef>; elts.push(elt)`:
  // the binding's DECLARED type is `undefined`, but the runtime value is an AST
  // node reference. Letting `undefined` resolve the element type to i32 lowers
  // `elts` to an i32 vec, so every pushed reference coerces to i32 `0` — silently
  // dropping the node refs (#2801, the compiled-acorn `arguments` bug). Skip such
  // writes exactly like `any` (let a later concrete write pin the kind; if none,
  // the caller falls through to `any[]` → externref). Genuine numeric pushes
  // (`number`/`boolean` literals) still pin f64/i32 and keep the fast path.
  const isUnpinnableWriteType = (t: ts.Type): boolean =>
    (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)) !== 0 &&
    (t.flags & ~(ts.TypeFlags.Any | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)) === 0;

  const recordWriteType = (value: ts.Expression): void => {
    const valueType = ctx.checker.getTypeAtLocation(value);
    if (isUnpinnableWriteType(valueType)) {
      sawDynamicElementWrite = true;
      return;
    }
    const wasmType = resolveWasmType(ctx, valueType);
    if (!inferredElemType || !inferredElemWasm) {
      inferredElemType = valueType;
      inferredElemWasm = wasmType;
      return;
    }
    const sameType =
      inferredElemWasm.kind === wasmType.kind &&
      (wasmType.kind !== "ref" && wasmType.kind !== "ref_null"
        ? true
        : (inferredElemWasm as { typeIdx: number }).typeIdx === wasmType.typeIdx);
    if (!sameType) mixedElementCarrier = true;
  };

  function visit(node: ts.Node) {
    // arr[i] = value
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === varName
    ) {
      const writeDecl = ctx.oracle.variableDeclarationOf(node.left.expression);
      if (writeDecl === decl) recordWriteType(node.right);
    }

    // arr.push(value)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "push" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === varName &&
      ctx.oracle.variableDeclarationOf(node.expression.expression) === decl &&
      node.arguments.length >= 1
    ) {
      for (const argument of node.arguments) recordWriteType(argument);
    }

    forEachChild(node, visit);
  }

  visit(scope);
  if (!inferredElemType && !sawDynamicElementWrite) return null;

  // Heterogeneous queue/scratch arrays must preserve every JS value. ReactDOM's
  // concurrentQueues stores [fiber, queue, update, lane] in one initially-empty
  // array; committing to the first ref shape coerced the update/lane writes and
  // later made `update.next = update` operate on boolean false.
  const elemWasm: ValType = mixedElementCarrier || sawDynamicElementWrite ? { kind: "externref" } : inferredElemWasm!;
  const elemKey =
    elemWasm.kind === "ref" || elemWasm.kind === "ref_null"
      ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}`
      : elemWasm.kind;
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemWasm);
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/** String methods that return a host array (externref) rather than a wasm GC array.
 *  Variables initialized from these calls use externref instead of the GC vec struct
 *  that resolveWasmType would produce for the TS return type (e.g. string[]). */
const HOST_ARRAY_STRING_METHODS = new Set(["split"]);

/**
 * A property-descriptor query returns an object-or-undefined carrier even when
 * the binding is explicitly `any`. Usage inference must not narrow that
 * binding to f64 merely because the eventual descriptor field is numeric: the
 * descriptor object itself has to survive the local slot first.
 */
function isPropertyDescriptorResultExpression(expr: ts.Expression | undefined): boolean {
  if (!expr) return false;
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) return false;
  const callee = current.expression;
  return (
    ts.isIdentifier(callee.expression) &&
    (callee.expression.text === "Object" || callee.expression.text === "Reflect") &&
    callee.name.text === "getOwnPropertyDescriptor"
  );
}

/**
 * (#684) Usage-based `any`-local override. Returns an unboxed `f64` ValType when
 * the (checker-layer) usage-inference pass proved every use of this
 * `any`/`unknown`-typed local binding is ToNumber-invariant — otherwise `null`,
 * leaving the caller's boxed-carrier resolution in place. Gated by
 * `ctx.useUsageInfer`. This is the SINGLE codegen entry point for the inference,
 * shared by all local-slot minting sites (var hoister, let/const pre-hoister,
 * `localTypeForDeclaration`) so every site agrees on the slot type.
 */
export function usageInferredLocalType(ctx: CodegenContext, decl: ts.VariableDeclaration | undefined): ValType | null {
  if (!decl || !ctx.useUsageInfer) return null;
  if (!ts.isIdentifier(decl.name)) return null;
  return ctx.usageInference.scalarForDecl(decl) === "number" ? { kind: "f64" } : null;
}

function localTypeForDeclaration(ctx: CodegenContext, type: ts.Type, decl?: ts.VariableDeclaration): ValType {
  // (#3673) Explicit native type annotation — `let x: i32` where
  // `type i32 = number`; the annotation node is the only surviving evidence.
  // It is a user assertion and outranks every inference below it.
  const nativeLocal = nativeTypeOfDeclaration(ctx.checker, decl);
  if (nativeLocal) return nativeLocal;
  if (decl && ctx.ordinaryToPrimitiveObjectDeclarations.has(decl)) return { kind: "externref" };
  // (#4121) A mixed-assignment demotion is "could not rule out"; a positive
  // unboxing proof is "ruled in", and outranks it. See
  // `numericProofOverridesMixedCarrier`.
  const usageF64 = usageInferredLocalType(ctx, decl);
  if (decl && bindingHasMixedAssignmentCarrier(ctx, decl)) {
    return numericProofOverridesMixedCarrier(usageF64) ?? { kind: "externref" };
  }
  if (isNullablePrimitiveType(type)) return { kind: "externref" };
  // (#2806) A `var x = (void 0)` binding needs an externref slot (the same one
  // `= undefined` gets), so a later reference assignment isn't coerced to numeric
  // `0`. Shared with the var-hoister so the hoisted slot and this declaration path
  // agree (a `var` reuses its hoisted slot). NARROW: void-EXPRESSION initializer
  // only — a bare `undefined`-typed binding (e.g. an optional-property read) must
  // stay numeric for the delete/undefined f64-sentinel machinery (#1112). See
  // `varBindingNeedsExternrefForUndefined`.
  if (varBindingNeedsExternrefForUndefined(decl, ctx)) return { kind: "externref" };
  return usageF64 ?? resolveWasmType(ctx, type);
}

/**
 * (#2864 F1b) Resolve the wasm ValType a body-local would receive **in the
 * native-generator resume function**, so the generator's spill field, its
 * resume-load local, and the state-struct init default can all be minted at the
 * local's actual type (object / string / typed-struct locals carried across a
 * `yield`), not the historical f64.
 *
 * The resume function compiles the generator body with a FRESH FunctionContext
 * whose analysis caches (`i32CoercedLocals`, `i32SpecializedArrays`,
 * `pendingStringBuilders`, …) are empty and whose locals never resolve to a
 * module global (the spill is always a local shadow). So the type the resume
 * var-declaration computes reduces to the **fctx-independent** subset of the
 * `compileVariableStatement` cascade: the ctx/AST externref-forcing overrides
 * plus `localTypeForDeclaration`. This helper replicates exactly that subset and
 * returns `null` for any form whose representation the up-front spill layout
 * cannot match (the caller then keeps the whole generator on the host path — a
 * conservative, non-regressing bail). Returning `null` for non-nullable `ref`
 * types is deliberate: the state-struct field needs a valid default value at
 * construction, and only `ref_null` refs have one (`ref.null`).
 */
export function resolveSpillLocalValType(ctx: CodegenContext, decl: ts.VariableDeclaration): ValType | null {
  if (!ts.isIdentifier(decl.name)) return null;
  const name = decl.name.text;
  if (ctx.ordinaryToPrimitiveObjectDeclarations.has(decl)) return { kind: "externref" };
  // Names the main-body analysis already routed to a host / externref slot
  // (accessor literal, host-spread literal, growable / out-of-shape object).
  if (ctx.externrefAccessorVars.has(name)) return { kind: "externref" };
  if (ctx.growableObjectLiteralVars.has(name)) return { kind: "externref" };
  // A var whose properties were widened (empty-obj + later prop writes) gets a
  // synthesized struct; mirror it if the struct is registered, else bail.
  // (#3364) keyed per-declaration, not by bare name.
  const widenedStructName = ctx.widenedVarStructMap.get(widenedVarKeyFromDecl(decl.name));
  if (widenedStructName !== undefined) {
    const idx = ctx.structMap.get(widenedStructName);
    return idx === undefined ? null : { kind: "ref_null", typeIdx: idx };
  }
  const init = decl.initializer;
  if (init) {
    if (ts.isObjectLiteralExpression(init)) {
      // (#802 Slice A) A proto-receiver literal is promoted to an open `$Object`
      // (externref, standalone-only) in compileObjectLiteral — the spill slot
      // must match.
      if (ctx.standalone && ctx.dynamicProtoLiteralNodes.has(init)) return { kind: "externref" };
      const forcesHostObject = init.properties.some(
        (p) =>
          ts.isGetAccessorDeclaration(p) ||
          ts.isSetAccessorDeclaration(p) ||
          (ts.isMethodDeclaration(p) && ts.isComputedPropertyName(p.name)) ||
          (ts.isPropertyAssignment(p) && p.name !== undefined && ts.isComputedPropertyName(p.name)),
      );
      if (forcesHostObject) return { kind: "externref" };
      // (#4616) Same lockstep as the main local-typing path: runtime computed
      // keys (incl. symbols), disposal methods, and empty-string keys route the
      // VALUE to the host plain-object path.
      if (objectLiteralForcesHostPath(ctx, init)) return { kind: "externref" };
      if (objectLiteralSpreadTakesHostPath(ctx, init)) return { kind: "externref" };
    }
    if (isProxyConstruction(init)) return { kind: "externref" };
    // Representations the var-decl path computes from a decl/receiver-driven
    // inference that diverges from resolveWasmType — defer to the host path.
    if (inferStandaloneRegExpMatchArrayType(ctx, init) !== null) return null;
    const unwrapped = stripInferenceWrapper(init);
    if (
      ts.isCallExpression(unwrapped) &&
      ts.isPropertyAccessExpression(unwrapped.expression) &&
      unwrapped.expression.name.text === "subarray"
    ) {
      return null;
    }
    if (isPromiseHostCall(ctx, init) || isBindCarrierCall(init) || isStringMethodReturningHostArray(ctx, init)) {
      return null;
    }
    // (#4655) A dynamic-carrier concat: the main path gives this binding an
    // externref slot, which this spill layout could match — but returning
    // `null` keeps the generator on the host path, and a conservative bail is
    // what every other divergent-representation arm above does.
    if (concatCallYieldsDynamicCarrier(ctx, init)) return null;
  }
  const varType = ctx.checker.getTypeAtLocation(decl);
  // Array<any> takes a decl-driven vec inference (inferArrayVecType) ≠ the
  // generic resolveWasmType vec — defer.
  if (varType.flags & ts.TypeFlags.Object) {
    const sym = (varType as ts.TypeReference).symbol ?? varType.symbol;
    if (sym?.name === "Array") {
      const typeArgs = ctx.checker.getTypeArguments(varType as ts.TypeReference);
      if (typeArgs?.[0] && typeArgs[0].flags & ts.TypeFlags.Any) return null;
    }
  }
  const t = localTypeForDeclaration(ctx, varType, decl);
  switch (t.kind) {
    case "f64":
    case "i32":
    case "i64":
    case "externref":
    case "ref_null":
      return t;
    // A non-nullable `ref` has no struct-construction default and a wasm local is
    // widened to nullable anyway, so carry it as `ref_null` — the same type the
    // resume var-declaration's slot settles on (the spill field, load local, and
    // init default then all agree; reads `struct.get` a nullable ref, which is
    // valid and traps-on-null exactly as the source semantics require).
    case "ref":
      return { kind: "ref_null", typeIdx: t.typeIdx };
    default:
      return null;
  }
}

function stripInferenceWrapper(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = (
      expr as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.SatisfiesExpression
        | ts.NonNullExpression
    ).expression;
  }
  return expr;
}

function isStaticRegExpExpression(ctx: CodegenContext, expr: ts.Expression): boolean {
  const unwrapped = stripInferenceWrapper(expr);
  if (unwrapped.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
  if (ts.isNewExpression(unwrapped) || (ts.isCallExpression(unwrapped) && !unwrapped.questionDotToken)) {
    const callee = stripInferenceWrapper(unwrapped.expression);
    return ts.isIdentifier(callee) && callee.text === "RegExp";
  }
  if (ts.isIdentifier(unwrapped)) {
    const sym = ctx.checker.getSymbolAtLocation(unwrapped);
    const decl = sym?.getDeclarations()?.find((d) => ts.isVariableDeclaration(d)) as ts.VariableDeclaration | undefined;
    return decl?.initializer !== undefined && isStaticRegExpExpression(ctx, decl.initializer);
  }
  return false;
}

function nativeStringVecType(ctx: CodegenContext): ValType | null {
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return null;
  const elemKey = `ref_${ctx.anyStrTypeIdx}`;
  const elemType: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
  getOrRegisterArrayType(ctx, elemKey, elemType);
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * (#2106 S1 / PR-2) Will this `var` declaration's slot be retyped from the
 * hoist-time externref to a concrete non-any ref during its declaration compile?
 *
 * TWO arms retype a hoisted externref slot to a concrete ref (the general #962
 * guard refuses every other externref → ref retype):
 *   1. the standalone-RegExp-match-array override below
 *     (`existingIsExternref && newIsRef`), and
 *   2. the #3037 CS1a any-object-carrier up-front retype (`var d: any = {k: v}`
 *     reuses the hoisted externref slot and retypes it to `(ref null $Object)`
 *     before the initializer compiles — `initIsAnyObjectCarrier`).
 *
 * Used by `hoistVarDecl` (index.ts): under the `undefinedSingleton` regime the
 * hoisted externref slot is initialized to the tag-1 `$undefined` singleton (a
 * NON-null `$AnyValue` ref). After the retype to `(ref null N)`, the
 * `local-set-coerce` stack-balance fixup would splice an UNGUARDED
 * `any.convert_extern; ref.cast_null N` on that non-null singleton → "illegal
 * cast" trap at the first instruction of the function (the dominant flip-ON
 * RegExp regression cluster; #3316 — the same trap on every
 * `var d: any = { … }` carrier, e.g. dynamic property descriptors). A
 * concrete-ref slot cannot represent the singleton anyway (it is not `any`), so
 * the hoist emits the flag-OFF `ref.null.extern` value instead — which casts
 * cleanly to `ref.null N`. Byte-inert flag-OFF.
 *
 * The carrier arm intentionally over-approximates the retype conditions: the
 * declaration-site retype additionally requires the slot not be
 * closure-captured (`boxedCaptures` / `capturedGlobals`), which is not reliably
 * known at hoist time. For a captured carrier the hoist then emits
 * `ref.null.extern` where the singleton would also have worked — degrading only
 * that var's pre-declaration undefined-observability to the flag-OFF behavior,
 * never trapping.
 */
export function hoistedVarRetypesToConcreteRef(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  if (inferStandaloneRegExpMatchArrayType(ctx, decl.initializer) !== null) return true;
  // (#3316) Mirror `initIsAnyObjectCarrier` (declaration compile, #3037 CS1a).
  if (
    decl.initializer !== undefined &&
    ts.isObjectLiteralExpression(decl.initializer) &&
    !ctx.ordinaryToPrimitiveObjectDeclarations.has(decl) &&
    !(ts.isIdentifier(decl.name) && ctx.growableObjectLiteralVars.has(decl.name.text)) &&
    objectLiteralIsStandaloneAnyObjectCarrier(ctx, decl.initializer)
  ) {
    return true;
  }
  return false;
}

function inferStandaloneRegExpMatchArrayType(
  ctx: CodegenContext,
  initializer: ts.Expression | undefined,
): ValType | null {
  if (!ctx.standalone || !initializer) return null;
  const unwrapped = stripInferenceWrapper(initializer);
  if (!ts.isCallExpression(unwrapped)) return null;
  if (!ts.isPropertyAccessExpression(unwrapped.expression)) return null;
  const method = unwrapped.expression.name.text;
  if (method === "exec") {
    return isStaticRegExpExpression(ctx, unwrapped.expression.expression) ? nativeStringVecType(ctx) : null;
  }
  if (method === "match" && unwrapped.arguments.length === 1) {
    return isStaticRegExpExpression(ctx, unwrapped.arguments[0]!) ? nativeStringVecType(ctx) : null;
  }
  return null;
}

/**
 * (#2357/#47) A `let s = <typedArray>.subarray(...)` binding in standalone/WASI
 * mode holds a `$__subview` that shares the parent's backing array (true aliasing).
 * Resolve the binding's local type to that subview here — at the real
 * variable-declaration site — so the local can hold the `struct.new $__subview` the
 * subarray lowering emits, and so element access on `s` picks the windowed lowering
 * at compile time. The receiver's element kind comes from its struct name
 * (`__vec_<elem>` for a plain typed array, `__subview_<elem>` for a nested
 * subarray). The subview type is reserved up-front (idx-stable), so this returns the
 * same index the lowering + inference use. `slice` is excluded — it returns an
 * independent copy (a plain vec), not a view.
 */
function inferSubarraySubviewType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  initializer: ts.Expression | undefined,
): ValType | null {
  if (!(ctx.standalone || ctx.wasi) || !initializer) return null;
  const unwrapped = stripInferenceWrapper(initializer);
  if (!ts.isCallExpression(unwrapped) || !ts.isPropertyAccessExpression(unwrapped.expression)) return null;
  if (unwrapped.expression.name.text !== "subarray") return null;
  const receiver = unwrapped.expression.expression;
  let receiverType: ValType | undefined;
  if (ts.isIdentifier(receiver)) {
    const localIdx = fctx.localMap.get(receiver.text);
    if (localIdx !== undefined) receiverType = getLocalType(fctx, localIdx);
  }
  receiverType ??= resolveWasmType(ctx, ctx.checker.getTypeAtLocation(receiver));
  if (receiverType.kind !== "ref" && receiverType.kind !== "ref_null") return null;
  const recvName = ctx.typeIdxToStructName.get(receiverType.typeIdx);
  const elemKind = recvName?.replace(/^__vec_/, "").replace(/^__subview_/, "");
  if (elemKind === undefined || elemKind === recvName) return null;
  return { kind: "ref_null", typeIdx: getOrRegisterSubviewType(ctx, elemKind) };
}

const TA_VIEW_CTOR_NAMES = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
]);

/**
 * (#3054 B1) A `const a = new <TA>(buffer)` binding in standalone/WASI mode holds
 * a shared-backing `$__ta_view` that refs the ArrayBuffer's vec (not a copy), so
 * sibling views / DataViews observe each other's writes. Resolve the binding's
 * local type to that view HERE — at the variable-declaration site — so the local
 * carries the `struct.new $__ta_view` the ctor emits, and element access on `a`
 * picks the byte-decoding view lowering at compile time (rather than the native
 * vec type `resolveWasmType(Uint8Array)` would return, which would route
 * `a[i]`/`a[i]=v` through the plain-vec path and drop the aliasing). This MUST
 * mirror the ctor's own gating (`emitTaViewConstruct` / `emitTaViewConstructWindowed`
 * in `new-super.ts`): a non-numeric buffer arg (ArrayBuffer/SharedArrayBuffer/
 * DataView), host-free lane. (#3054 B2) The multi-arg windowed form
 * `new TA(buf, byteOffset[, length])` also resolves to a `$__ta_view` (with the
 * byteOffset field populated), so 1..3 args are accepted here.
 */
export function inferTaViewType(ctx: CodegenContext, initializer: ts.Expression | undefined): ValType | null {
  if (!initializer) return null;
  const unwrapped = stripInferenceWrapper(initializer);
  if (!ts.isNewExpression(unwrapped) || !ts.isIdentifier(unwrapped.expression)) return null;
  const viewName = unwrapped.expression.text;
  if (!TA_VIEW_CTOR_NAMES.has(viewName)) return null;
  const args = unwrapped.arguments;
  // Buffer-backed view: single buffer arg (offset-0, B1) or windowed
  // `new TA(buf, byteOffset[, length])` (B2). A numeric first arg is the
  // count-ctor (native vec), not a view — leave it on the current path.
  if (!args || args.length < 1 || args.length > 3 || ts.isNumericLiteral(args[0]!)) return null;
  // (#1930) Query the type-oracle boundary, not the raw checker.
  const argSymName = ctx.oracle.builtinReceiverOf(args[0]!);
  // (#3097) JS-host lane: a buffer-arg TA construction routes through the host
  // construct bridge (`emitHostTaBufferConstruct`, new-super.ts) and yields a
  // REAL host TypedArray externref. The local must be externref so reads route
  // through the extern paths — coercing to the native vec type would ref.cast
  // trap. MUST stay in lock-step with `hostTaBufferArgSymName` (new-super.ts):
  // DataView buffer args are excluded there (array-like per §23.2.5.1) and
  // stay on the legacy path here too.
  if (!noJsHost(ctx)) {
    if (argSymName === "ArrayBuffer" || argSymName === "SharedArrayBuffer") return { kind: "externref" };
    return null;
  }
  if (argSymName !== "ArrayBuffer" && argSymName !== "SharedArrayBuffer" && argSymName !== "DataView") return null;
  return { kind: "ref_null", typeIdx: getOrRegisterTaViewType(ctx, viewName) };
}

/** Check if an expression is a string method call that returns a host array (externref). */
function isStringMethodReturningHostArray(ctx: CodegenContext, expr: ts.Expression): boolean {
  // With native strings, split returns a native string array, not externref
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) return false;
  if (!ts.isCallExpression(expr)) return false;
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  const method = expr.expression.name.text;
  if (!HOST_ARRAY_STRING_METHODS.has(method)) return false;
  const receiverType = ctx.checker.getTypeAtLocation(expr.expression.expression);
  return isStringType(receiverType);
}

/**
 * Check if an expression is a host Promise call whose result is a real JS Promise.
 * Only matches static Promise methods (resolve/reject/all/race/allSettled/any) and
 * new Promise(). DELIBERATELY OMITS instance methods (.then/.catch/.finally) to
 * prevent cascading type overrides through Promise chains on compiled async functions.
 */
function isPromiseHostCall(_ctx: CodegenContext, expr: ts.Expression): boolean {
  // new Promise(executor)
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Promise") {
    return true;
  }
  if (!ts.isCallExpression(expr)) return false;
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  const method = expr.expression.name.text;
  // Static methods: Promise.resolve/reject/all/race/allSettled/any
  if (
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Promise" &&
    (method === "resolve" ||
      method === "reject" ||
      method === "all" ||
      method === "race" ||
      method === "allSettled" ||
      method === "any")
  ) {
    return true;
  }
  return false;
}

/**
 * (#2615/#4397) Check if an initializer produces a Proxy carrier or the
 * ordinary `{ proxy, revoke }` revocable handle. Both are represented as
 * externrefs even though TypeScript gives them more specific structural types.
 *
 * A Proxy carries NO TypeScript-type brand — `ProxyConstructor` is typed to
 * return its TARGET type `T`, so the checker types `const p = new Proxy(t, h)`
 * as `T` (e.g. the object-literal struct of `t`). The `new Proxy` codegen
 * (new-super.ts) correctly returns `{ kind: "externref" }` (host) / the native
 * `$Proxy` externref (standalone) — but if the receiving local is slotted as
 * the target's WasmGC struct type, the externref is coerced into that struct
 * with `any.convert_extern` + `ref.test (ref <struct>)`, which FAILS for a
 * host/native Proxy (it is not that struct). The value becomes `ref.null`, and
 * the subsequent `p.attr` lowers to a direct `struct.get` on the null/struct
 * local → traps (empty-message Wasm trap). `"k" in p` works only because it
 * routes via `__extern_has`.
 *
 * The fix: force the local's storage ValType to `externref` for a `new Proxy`
 * initializer, so member reads/writes/has/delete lower through the dynamic
 * boundary helpers (`__extern_get` / `__extern_set` / `__extern_has`), which
 * are the only paths that run the Proxy MOP (the trap). Mirrors the
 * `isBindCarrierCall` / `isPromiseHostCall` slot-type overrides. Mode-agnostic:
 * both host and standalone emit a Proxy externref, so both need the override.
 */
function isProxyConstruction(expr: ts.Expression): boolean {
  if (ts.isNewExpression(expr)) {
    return ts.isIdentifier(expr.expression) && expr.expression.text === "Proxy";
  }
  return (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "revocable" &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Proxy"
  );
}

/**
 * Does this binding become the target of a native Proxy in its lexical scope?
 * A Proxy can mutate that target through a trap or an absent-trap forward, so
 * later reads through any source alias must not be frozen into a direct
 * closed-struct field load. Keep the binding on the dynamic object carrier
 * from construction time; the Proxy and the alias then share one object rather
 * than copying into a shadow representation.
 */
function bindingIsProxyTarget(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(decl.name)) return false;
  const scope = findEnclosingFunctionOrSource(decl);
  if (!scope) return false;

  const unwrap = (expr: ts.Expression): ts.Expression => {
    let current = expr;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    let target: ts.Expression | undefined;
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Proxy") {
      target = node.arguments?.[0];
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Proxy" &&
      node.expression.name.text === "revocable"
    ) {
      target = node.arguments[0];
    }
    if (target) {
      const candidate = unwrap(target);
      if (ts.isIdentifier(candidate) && ctx.oracle.valueDeclarationOf(candidate) === decl) {
        found = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(scope);
  return found;
}

/**
 * (#2615 narrowing) Does the Proxy-bound variable `name` ever ESCAPE into a
 * call/new as a by-value argument, or get used as a generic-method receiver
 * (`Array.prototype.X.call(p, …)` / `Object.getPrototypeOf(p)` /
 * `Object.prototype.toString.call(p)`) anywhere in the enclosing function?
 *
 * Why this matters: forcing the slot to `externref` (so member READS route
 * through `__extern_get` — the read-trap fix) breaks the regression cases where
 * the Proxy is handed to a host generic-method / global. For a struct-typed
 * slot those host paths received a wasm struct they could introspect (IsArray,
 * getPrototypeOf, the Array.prototype.* spec walk); the bare externref Proxy
 * goes through a different host path that loses Array-ness / prototype identity
 * (regressed `Object/prototype/toString/proxy-array`, `copyWithin/*-proxy-*`,
 * `getOwnPropertySymbols/proxy-invariant-*`, `getPrototypeOf/*-target-is-proxy`).
 *
 * So: only flip the slot to externref when the Proxy stays LOCAL and is used
 * purely in member position (`p.x` / `p[k]` / `delete p.x` / `k in p`). If it
 * escapes into a call argument, keep the struct typing — the keystone read-trap
 * fix still lands for the common direct-read case, and the escaping-into-host
 * paths keep working. A receiver of `p.method()` (member-then-call) is NOT an
 * escape; only `p` appearing as a CALL/NEW ARGUMENT (incl. `.call`/`.apply`
 * first arg) counts.
 */
function proxyResultEscapesToCall(decl: ts.VariableDeclaration, name: string): boolean {
  const fn = findEnclosingFunctionOrSource(decl);
  if (!fn) return false;
  let escapes = false;
  const visit = (node: ts.Node): void => {
    if (escapes) return;
    if (ts.isIdentifier(node) && node.text === name) {
      const p = node.parent;
      // `f(…, p, …)` or `new C(…, p, …)` — p is a by-value argument.
      if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.some((a) => a === node)) {
        escapes = true;
        return;
      }
      // `<receiver>.call(p, …)` / `<receiver>.apply(p, …)` — p is the `this`
      // arg of a generic-method dispatch (Array.prototype.X.call(p), etc.).
      if (
        ts.isCallExpression(p) &&
        ts.isPropertyAccessExpression(p.expression) &&
        (p.expression.name.text === "call" || p.expression.name.text === "apply") &&
        p.arguments?.[0] === node
      ) {
        escapes = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(fn);
  return escapes;
}

function findEnclosingFunctionOrSource(node: ts.Node): ts.Node | undefined {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isSourceFile(n)
    ) {
      return n;
    }
    n = n.parent;
  }
  return undefined;
}

/**
 * (#1337/#4397) Check if an initializer is a `Function.prototype.bind` call.
 * Its result is an externref carrier rather than the target's closure struct:
 * a real JS bound-function exotic under the compatibility provider, or the
 * Wasm-owned `$__bound_fn` carrier under the native provider.
 *
 * Such a variable MUST get an `externref` local — `resolveWasmType` would
 * otherwise type it as the target function's closure-struct ref (TS infers the
 * bound result's type from the target's call signature), and the subsequent
 * `coerceType(externref → struct ref)` emits a `ref.cast` that traps on the JS
 * function, nulling the binding (the LHS-coerce blocker documented in #1337).
 * With an externref local the provider-specific call dispatcher can inspect
 * the value without an invalid target-closure cast.
 */
function isBindCarrierCall(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  // Direct form: `<receiver>.bind(...)`.
  if (callee.name.text === "bind") return true;
  // Indirect form: `Function.prototype.bind.call(fn, ...)`.
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

export function compileVariableStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.VariableStatement): void {
  for (const decl of stmt.declarationList.declarations) {
    if (ts.isObjectBindingPattern(decl.name)) {
      compileObjectDestructuring(ctx, fctx, decl);
      continue;
    }

    if (ts.isArrayBindingPattern(decl.name)) {
      compileArrayDestructuring(ctx, fctx, decl);
      continue;
    }

    if (!ts.isIdentifier(decl.name)) {
      reportError(ctx, decl, "Destructuring not supported");
      continue;
    }

    const name = decl.name.text;

    // (#4231 RC-A) Inside a `with` body a `var` does NOT shadow the object
    // environment record: the declaration hoists to the function environment but
    // its initializer is an ordinary assignment resolved through the scope
    // chain, where §14.11.2's object environment is consulted first. When the
    // `with` target owns this name the store belongs to the OBJECT and the
    // hoisted local must stay `undefined`, so this hook takes the declaration
    // entirely. No-op outside a `with` (and for lexical declarations, which do
    // shadow).
    if (tryCompileWithScopedVarDeclaration(ctx, fctx, stmt, decl)) continue;

    // #1690b: a `var`/`let`/`const` declaration inside a function body always
    // introduces a function-local binding (ECMA-262 §10.2.10 for `var`;
    // block scoping for let/const), which shadows any module-level global of
    // the same name. The function-body hoister has already allocated that
    // local, so it is present in `localMap`. When it is, the declaration's
    // initializer must store into the LOCAL, never the module global —
    // otherwise the inner declaration aliases and corrupts the module binding.
    // (The module-init body compiles with an empty `localMap`, so this stays
    // false there and the module-global store path is preserved.)
    const hasLocalShadow = fctx.localMap.has(name);
    // A lexical declaration nested in a top-level block is still local to that
    // block. `moduleGlobals` is keyed only by name, so an outer Script-level
    // binding with the same name must not make this declaration take the
    // module-global fast path. `var` remains function/Script scoped.
    const declarationIsLexical =
      (stmt.declarationList.flags &
        (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) !==
      0;
    const bindsModuleGlobal = !declarationIsLexical || (stmt.parent !== undefined && ts.isSourceFile(stmt.parent));

    // Track const bindings for runtime enforcement (assignment throws TypeError)
    if (stmt.declarationList.flags & ts.NodeFlags.Const) {
      if (!fctx.constBindings) fctx.constBindings = new Set();
      fctx.constBindings.add(name);
      if (decl.initializer) {
        const alias = detectNullGuardAlias(ctx, decl.initializer);
        if (alias) {
          if (!fctx.nullGuardAliases) fctx.nullGuardAliases = new Map();
          fctx.nullGuardAliases.set(name, alias);
        }
      }
    }
    if (tryCompileUniformSplitLengthBinding(ctx, fctx, stmt, decl)) continue;
    if (tryCompileSingleUnitSplitLengthBinding(ctx, fctx, stmt, decl)) continue;
    if (tryAsciiCase(ctx, fctx, stmt, decl) || tryCompileDerivedSubstringBinding(ctx, fctx, stmt, decl)) continue;
    if (tryCompileUniformIndexPresenceBinding(ctx, fctx, stmt, decl)) continue;

    // #1210: string-builder rewrite for `let s = "";` followed by an
    // accumulating loop. Detected pre-pass populates `pendingStringBuilders`;
    // emit the buffer-init sequence here and skip the normal local
    // allocation (the binding name is intentionally NOT placed in
    // `localMap` — `compileIdentifier` and `compileNativeStringCompoundAssignment`
    // route through `fctx.stringBuilders` instead). The TDZ flag is also
    // not allocated, since the variable is always logically initialised
    // immediately after the buffer is created.
    if (fctx.pendingStringBuilders?.has(decl)) {
      // Native string helpers (incl. __str_buf_next_cap and __str_flatten)
      // must be available before any append site emits a call to them. The
      // detector only fires under nativeStrings; ensure here too in case the
      // function body uses no other native-string helpers.
      ensureNativeStringHelpers(ctx);
      // #1761: pass presize info (final-length proof) if the detector recorded
      // it for this declaration, so the buffer is allocated once at the proven
      // length and the append sites skip the per-append cap-check.
      const presize = fctx.stringBuilderPresize?.get(decl);
      compileStringBuilderInit(ctx, fctx, name, presize);
      // Mark as initialized for any TDZ flag captured by enclosing closures.
      // (compileStringBuilderInit didn't set localMap, so emitTdzInit only
      // touches the flag local if one was already allocated by the hoist
      // pre-pass.)
      emitTdzInit(ctx, fctx, name);
      continue;
    }

    // #1886 Slice B: linear-backed Uint8Array. When the analysis proved this
    // `new Uint8Array(...)` binding is a pure I/O buffer that never escapes the
    // GC heap, back it by linear memory (a (ptr,len) pair) instead of a GC vec.
    // Like the string-builder path above, the binding name is intentionally NOT
    // placed in `localMap` — element-access/.length/I/O reads route through
    // `fctx.linearU8Buffers` (see linear-uint8-codegen.ts). The TDZ flag, if the
    // hoist pre-pass allocated one, is marked initialised.
    if (
      decl.initializer &&
      ts.isNewExpression(decl.initializer) &&
      tryEmitLinearU8New(ctx, fctx, decl.name, decl.initializer)
    ) {
      emitTdzInit(ctx, fctx, name);
      continue;
    }

    // For arrow/function expression AND class-expression initializers, compile
    // the expression first to get the actual closure struct ref type
    // (resolveWasmType returns externref for function types, but closures need
    // ref $struct).
    //
    // (#3045) Class expressions (`const C = class { ... }`) MUST also flow
    // through here. The class BODY is lowered like a declaration, but the
    // BINDING must still hold the constructor-object VALUE — otherwise the
    // (pre-hoisted, instance-struct-typed) local `$C` is never stored, so
    // reading `C` as an rvalue (passing it to a function, `Reflect.has(C, k)`,
    // `Object.prototype.hasOwnProperty.call(C, k)`, …) reads an uninitialized
    // null local → `extern.convert_any` on null → a host `Reflect.has called on
    // non-object` / `Cannot convert undefined or null to object` trap. Compiling
    // the class expression here yields the constructor value (a closure struct →
    // externref, via emitClassCtorValue), and this branch re-types the
    // pre-hoisted slot to that closure type before storing — exactly as for
    // arrow/function-expression bindings. `new C()` is unaffected (it resolves
    // the class statically via classSet, not through the binding value).
    if (
      decl.initializer &&
      (ts.isArrowFunction(decl.initializer) ||
        ts.isFunctionExpression(decl.initializer) ||
        ts.isClassExpression(decl.initializer))
    ) {
      // (#3045 Bug 2) A class expression nested in a function had its BODY
      // deferred to this in-scope path (declarations.ts). Compile its
      // constructor/method bodies NOW, with the enclosing function scope
      // (`fctx`) live and its nested functions already registered — BEFORE
      // materializing the binding value below. `compileNestedClassDeclaration`
      // runs `promoteAccessorCapturesToGlobals` for each member (enclosing-local
      // reads/writes route through module globals) then `compileClassBodies`
      // (enclosing-function calls resolve to real direct calls). This is the
      // exact path a nested class DECLARATION takes. Run it FIRST so a module
      // global added by promotion shifts the enclosing body emitted before this
      // statement — the #779a index-shift guard registers `fctx` on the shift
      // stacks inside `compileClassBodies`, exactly as the declaration path
      // relies on; the binding materialization that follows reads the same
      // class singleton, unaffected by the ordering.
      if (ts.isClassExpression(decl.initializer)) {
        const deferredSynth = ctx.anonClassExprNames.get(decl.initializer);
        if (deferredSynth !== undefined && ctx.deferredClassBodies.has(deferredSynth)) {
          compileNestedClassDeclaration(ctx, fctx, decl.initializer, deferredSynth);
        } else {
          // Module-init class expressions were compiled eagerly, but their
          // computed names still execute here, at runtime, immediately before
          // the binding value is materialized. Deferred expressions already
          // emit through compileNestedClassDeclaration above.
          emitPreparedAccessorComputedNameEffects(ctx, fctx, decl.initializer);
        }
      }
      // (#3045 identity) Materialize a class-expression BINDING as the class's
      // canonical `__class_<Name>` singleton (identity-stable externref) rather
      // than the ctor-CLOSURE `compileClassExpression` emits. This is what makes
      // `const cls = class C {}` satisfy `new cls().m() === cls` and
      // `inst.constructor === cls`: the binding, the inner class name (`C` via
      // identifiers.ts), `instance.constructor`, and `C.staticProp` all resolve
      // to the ONE singleton. Scope is deliberately the BINDING ONLY — every
      // other class-expression-as-value context (a `new Proxy(class {}, {})`
      // target, a call argument, an inline `(class {}).f`) keeps
      // `compileClassExpression`'s callable ctor-closure, which the Proxy /
      // Function.prototype.toString host path needs (a struct singleton is not
      // callable → `proxy-class` broke when this was applied globally). Falls
      // back to `compileExpression` for a class with no singleton (externref-
      // backed builtin subclass) or an unresolved synthetic name.
      let actualType: ValType | null;
      const clsSynth = ts.isClassExpression(decl.initializer)
        ? ctx.anonClassExprNames.get(decl.initializer)
        : undefined;
      if (
        clsSynth !== undefined &&
        ctx.classObjectGlobals?.has(clsSynth) &&
        emitLazyClassObjectGet(ctx, fctx, clsSynth)
      ) {
        actualType = { kind: "externref" };
      } else {
        actualType = compileExpression(ctx, fctx, decl.initializer);
      }
      const closureType = actualType ?? { kind: "externref" as const };

      // If this is a module-level variable, also store in the module global
      // so other functions can access the closure via global.get.
      // #1690b: skip the module-global path when a function-local shadow
      // exists — the inner declaration must bind to the local, not the global.
      // (#3546) Additionally: only a genuinely TOP-LEVEL declaration binds the
      // module global. A `let`/`const` inside a top-level BLOCK is a
      // block-scoped SHADOW — `saveBlockScopedShadows` removed the outer
      // binding's localMap entry on block entry, so `hasLocalShadow` is false
      // here and the pre-fix code stored the block's closure into the OUTER
      // module binding (`{ let f = () => 7; }` clobbered module `f`). `var`
      // keeps the module store from any top-level block (§10.2.10 var
      // scoping); function bodies are unaffected (their hoister pre-allocates
      // the local, so `hasLocalShadow` gates them already).
      const modGlobalIdx = hasLocalShadow || !bindsModuleGlobal ? undefined : ctx.moduleGlobals.get(name);
      if (modGlobalIdx !== undefined) {
        // (#3534 step 2, option a) NEVER retro-narrow the pre-declared
        // `$__mod_<name>` global. It is declared `externref` before the closure
        // type is known; narrowing it here to the precise `(ref null N)`
        // retroactively invalidated every ALREADY-EMITTED `global.get` whose
        // consumer took the externref at face value (the #3533 class-field
        // `struct.set expected externref, found (ref null N)` invalid-Wasm
        // family). Keep the binding `externref` for its whole lifetime and BOX
        // ON STORE instead (`extern.convert_any`); readers get a stable
        // externref (identifiers.ts C1) and calls take `compileClosureCall`'s
        // existing externref arm (guarded cast to the lifted self carrier).
        // The LOCAL keeps the precise closure type — its reads use the
        // precise-ref call arm (no unbox round-trip inside this function).
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, modGlobalIdx)];
        const globalIsExternref = globalDef?.type.kind === "externref";
        if (globalDef && !globalIsExternref) {
          // Pre-declared as something other than externref (not the closure
          // pre-decl convention) — keep the legacy retype so init and type
          // agree. Closure globals never take this arm.
          const nullableType: ValType =
            closureType.kind === "ref"
              ? { kind: "ref_null", typeIdx: (closureType as { typeIdx: number }).typeIdx }
              : closureType;
          globalDef.type = nullableType;
          if (nullableType.kind === "ref_null") {
            globalDef.init = [{ op: "ref.null", typeIdx: (nullableType as { typeIdx: number }).typeIdx }];
          }
        }
        if (globalIsExternref) {
          // (#3546) The `__module_init` shadow local is EXTERNREF — the same
          // uniform representation as the global (#3534 option a): convert
          // ONCE, tee the boxed value into the local, store the same value to
          // the global. Top-level reads return externref (consumers coerce);
          // top-level calls take `compileClosureCall`'s guarded externref arm
          // (cold — module init runs once). Keeping the local PRECISE while
          // the binding is reassignable forced assignment.ts to RETYPE the
          // local on reassignment — the exact #3534 retro-invalidation
          // mechanism, one slot over. Record the shadow so a later top-level
          // reassignment (which resolves to this local via localMap) re-syncs
          // the module global (#3546 — pre-fix it updated only the shadow and
          // every cross-function call kept the FIRST closure).
          const localIdx = allocLocal(fctx, name, { kind: "externref" });
          if (closureType.kind === "ref" || closureType.kind === "ref_null") {
            // Box on store: precise closure struct → externref (A2).
            fctx.body.push({ op: "extern.convert_any" });
          }
          fctx.body.push({ op: "local.tee", index: localIdx });
          fctx.body.push({ op: "global.set", index: modGlobalIdx });
          (fctx.moduleBindingShadowLocals ??= new Map()).set(name, localIdx);
        } else {
          // Legacy non-externref pre-decl arm (closure globals never take
          // this): duplicate value on stack — one for the global, one for the
          // (precise) local.
          const localIdx = allocLocal(fctx, name, closureType);
          fctx.body.push({ op: "local.tee", index: localIdx });
          fctx.body.push({ op: "global.set", index: modGlobalIdx });
        }
        // Set TDZ flag to 1 (initialized)
        emitTdzInit(ctx, fctx, name);
      } else {
        // (#3534 construct site) Boxed-before-declared: an EARLIER
        // (forward-referencing) closure construction boxed this binding into a
        // ref cell and re-aimed `localMap[name]` at the `__boxed_<name>` CELL
        // local. Reusing that slot as the value slot below would (a) RETYPE
        // the cell local to the closure struct — retroactively invalidating
        // the already-emitted `struct.new <cell>; local.tee` (stack-balance
        // then "repairs" the tee with a statically-impossible `ref.cast_null`
        // → guaranteed `illegal cast` at runtime: the nativeFunctionMatcher
        // mutually-recursive `eat`/`test` trap) and (b) alias the raw value
        // over the cell, so captures never observe the initialization. Write
        // the closure value THROUGH the cell instead (the #3396/#1177
        // `boxedForInitStore` convention) and leave the slot's ref-cell type
        // untouched.
        const boxedClosureCell = fctx.boxedCaptures?.get(name);
        const boxedCellLocalIdx = boxedClosureCell !== undefined ? fctx.localMap.get(name) : undefined;
        if (boxedClosureCell !== undefined && boxedCellLocalIdx !== undefined) {
          if (!valTypesMatch(closureType, boxedClosureCell.valType)) {
            // Precise closure struct → externref cell field: extern.convert_any.
            coerceType(ctx, fctx, closureType, boxedClosureCell.valType);
          }
          const tmpVal = allocLocal(fctx, `__box_init_tmp_${fctx.locals.length}`, boxedClosureCell.valType);
          fctx.body.push({ op: "local.set", index: tmpVal });
          fctx.body.push({ op: "local.get", index: boxedCellLocalIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [],
            else: [
              { op: "local.get", index: boxedCellLocalIdx },
              { op: "local.get", index: tmpVal },
              { op: "struct.set", typeIdx: boxedClosureCell.refCellTypeIdx, fieldIdx: 0 },
            ],
          });
          // The binding is initialized now — flip the (possibly boxed) local
          // TDZ flag so captured forward references pass their checks.
          emitLocalTdzInit(fctx, name);
          continue;
        }
        // Reuse pre-hoisted slot if it exists.
        // Do NOT narrow externref → ref: the hoisting pass already emitted
        // __get_undefined() targeting externref; mutating the type causes
        // impossible ref.cast at runtime (#962). Coercion handles it.
        const priorIdx = fctx.localMap.get(name);
        const localIdx =
          priorIdx !== undefined && priorIdx >= fctx.params.length ? priorIdx : allocLocal(fctx, name, closureType);
        if (priorIdx !== undefined && priorIdx >= fctx.params.length) {
          const slot = fctx.locals[priorIdx - fctx.params.length];
          if (slot && slot.type.kind !== "externref") slot.type = closureType;
        }
        emitCoercedLocalSet(ctx, fctx, localIdx, closureType);
        emitLocalTdzInit(fctx, name);
      }
      continue;
    }

    // For object literal initializers with computed property names that TS
    // cannot resolve (resulting in 0 type properties), compile the expression
    // first to get the actual struct ref type. Similar to arrow function handling.
    if (
      decl.initializer &&
      ts.isObjectLiteralExpression(decl.initializer) &&
      decl.initializer.properties.some((p) => ts.isPropertyAssignment(p) && p.name && ts.isComputedPropertyName(p.name))
    ) {
      const varType2 = ctx.checker.getTypeAtLocation(decl);
      const tsProps = varType2.getProperties();
      // Only use this path when TS cannot resolve any properties
      // (i.e. all properties are computed and non-resolvable)
      const hasUnresolvedComputed = tsProps.length < decl.initializer.properties.length;
      if (hasUnresolvedComputed) {
        // Check if ALL computed keys can be resolved at compile time.
        // If so, skip this early-out and let ensureComputedPropertyFields + the
        // normal module-global path handle it properly.
        const allComputedResolvable = decl.initializer.properties.every((p) => {
          if (!ts.isPropertyAssignment(p) || !p.name || !ts.isComputedPropertyName(p.name)) return true;
          return resolveComputedKeyExpression(ctx, p.name.expression) !== undefined;
        });
        if (!allComputedResolvable) {
          const actualType = compileExpression(ctx, fctx, decl.initializer);
          const objType = actualType ?? { kind: "externref" as const };
          // Store to module global if available, otherwise local.
          // #1690b: a function-local shadow takes precedence over the global.
          const modGlobal = hasLocalShadow || !bindsModuleGlobal ? undefined : ctx.moduleGlobals.get(name);
          if (modGlobal !== undefined) {
            fctx.body.push({ op: "global.set", index: modGlobal });
            emitTdzInit(ctx, fctx, name);
          } else {
            // Reuse pre-hoisted slot if it exists.
            // Do NOT narrow externref → ref (#962).
            const priorIdx = fctx.localMap.get(name);
            const localIdx =
              priorIdx !== undefined && priorIdx >= fctx.params.length ? priorIdx : allocLocal(fctx, name, objType);
            if (priorIdx !== undefined && priorIdx >= fctx.params.length) {
              const slot = fctx.locals[priorIdx - fctx.params.length];
              if (slot && slot.type.kind !== "externref") slot.type = objType;
            }
            fctx.body.push({ op: "local.set", index: localIdx });
          }
          continue;
        }
        // All computed keys resolvable — fall through to normal path
      }
    }

    // Check if this is a module-level global (already registered).
    // #1690b: a function-local shadow (inner `var`/`let`/`const` of the same
    // name) must bind to the local, so suppress the module-global store here.
    const moduleGlobalIdx = hasLocalShadow || !bindsModuleGlobal ? undefined : ctx.moduleGlobals.get(name);
    if (moduleGlobalIdx !== undefined) {
      // Shape-inferred array-like: seed the vec carrier (#4491 — the seed
      // CARRIES a `[…]` initializer's elements now; it used to discard them).
      const shapeInfo = ctx.shapeMap.get(name);
      if (shapeInfo && decl.initializer) {
        emitShapeInferredVecInit(ctx, fctx, shapeInfo, decl.initializer);
        // Re-read the index: compiling the initializer may shift globals via
        // addStringConstantGlobal (same discipline as the generic arm below).
        fctx.body.push({ op: "global.set", index: ctx.moduleGlobals.get(name) ?? moduleGlobalIdx });
        // Set TDZ flag to 1 (initialized)
        emitTdzInit(ctx, fctx, name);
        continue;
      }
      // Module global: compile initializer and set global
      if (decl.initializer) {
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
        const wasmType = globalDef?.type ?? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(decl));
        compileExpression(ctx, fctx, decl.initializer, wasmType);
        // Re-read index: compileExpression may shift globals via addStringConstantGlobal
        const moduleGlobalIdxPost = ctx.moduleGlobals.get(name)!;
        fctx.body.push({ op: "global.set", index: moduleGlobalIdxPost });
      } else {
        // No initializer: `let x;` at module level — in JS, uninitialized
        // variables are `undefined`. For externref globals, emit __get_undefined()
        // so `x === undefined` works correctly (#737).
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
        if (globalDef?.type.kind === "externref") {
          emitUndefined(ctx, fctx);
          fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
        }
      }
      // Set TDZ flag to 1 (initialized) — even for `let x;` without initializer
      emitTdzInit(ctx, fctx, name);
      continue;
    }

    const varType = ctx.checker.getTypeAtLocation(decl);
    const declaredWasmType = resolveWasmType(ctx, varType);
    const realmStructuralCarrier =
      (declaredWasmType.kind === "ref" || declaredWasmType.kind === "ref_null") &&
      declarationReadsStructuralObjectFromRealmGlobal(ctx, fctx, decl);
    // #1120: If this local has been detected as i32-coerced (every write
    // is wrapped in `| 0` or another bitwise int32 coercion), force its
    // Wasm type to i32. This must be checked BEFORE inferred-array logic
    // because the candidate set is gathered ahead of time and only
    // contains numeric-typed names.
    const isI32CoercedLocal =
      fctx.i32CoercedLocals?.has(name) === true && (varType.flags & ts.TypeFlags.NumberLike) !== 0;
    let inferredVecType: ValType | null = null;
    if (varType.flags & ts.TypeFlags.Object) {
      const sym = (varType as ts.TypeReference).symbol ?? (varType as ts.Type).symbol;
      if (sym?.name === "Array") {
        const typeArgs = ctx.checker.getTypeArguments(varType as ts.TypeReference);
        const isInitiallyEmptyArray =
          decl.initializer !== undefined &&
          ts.isArrayLiteralExpression(decl.initializer) &&
          decl.initializer.elements.length === 0;
        if (isInitiallyEmptyArray || (typeArgs?.[0] && typeArgs[0].flags & ts.TypeFlags.Any)) {
          inferredVecType = inferArrayVecType(ctx, decl);
        }
      }
    }
    // Override type for string methods returning host arrays (e.g. split() returns
    // externref but TS types as string[] which resolveWasmType maps to GC vec struct)
    // Check if this variable has widened properties (empty obj with later prop assignments)
    // (#3364) keyed per-declaration, not by bare name.
    const widenedStructName = ts.isIdentifier(decl.name)
      ? ctx.widenedVarStructMap.get(widenedVarKeyFromDecl(decl.name))
      : undefined;
    const widenedTypeIdx = widenedStructName !== undefined ? ctx.structMap.get(widenedStructName) : undefined;
    // #1197: i32-specialized number[] arrays get __vec_i32 instead of __vec_f64.
    // The override is applied AFTER the standard type computation so it stacks
    // cleanly with widened/inferred paths above (the analysis pass restricts
    // candidates to bare `let arr: number[] = ...` so neither path applies).
    const isI32SpecializedArray =
      fctx.i32SpecializedArrays?.has(name) === true && (varType.flags & ts.TypeFlags.Object) !== 0;

    // (#1239) If the initializer is an object literal carrying get/set
    // accessor declarations, the variable holds a JS host object
    // (externref) — never the inferred wasmGC struct type. Tag the var
    // up-front so the local's wasm type and ctx.externrefAccessorVars
    // stay in sync; later reads/writes via resolveStructNameForExpr will
    // see the override.
    //
    // (#1433) Same routing for `[Symbol.dispose]` / `[Symbol.asyncDispose]`
    // computed methods — they reach the JS-host plain-object path so the
    // native runtime can find the disposer under the real Symbol property.
    // (#4616) Routes through the SAME predicate compileObjectLiteral's host
    // gate uses (objectLiteralForcesHostPath — accessors, disposal methods,
    // RUNTIME computed keys incl. symbols, empty-string keys) so the local's
    // representation and the literal's value representation stay in lockstep.
    // The previous inline check missed computed-key PropertyAssignments
    // (`{ a: 1, [symbolKey]: 3 }`): the value built as a host object while an
    // un-annotated local stayed struct-typed — the store null-cast and reads
    // answered NULL (jest Replaceable "Type null is not support").
    const initIsAccessorLiteral =
      decl.initializer !== undefined &&
      ts.isObjectLiteralExpression(decl.initializer) &&
      objectLiteralForcesHostPath(ctx, decl.initializer);
    // (#2804) A spread-containing object literal initializer that takes the host
    // plain-object path (no concrete contextual struct type — e.g.
    // `const b = { ...a, z: 3 }`) builds a host `$Object` (externref), NOT the
    // closed struct TypeScript INFERS for the variable. The local must therefore
    // be an externref so the value isn't ref.cast to that inferred struct (which
    // fails at runtime → `b.x` reads NaN/null), and reads route through
    // `__extern_get` — preserving the spread's runtime insertion-order keys +
    // values. Uses the SAME predicate as the literals.ts routing so the local
    // representation and the value representation stay in lockstep. An explicit
    // concrete-struct annotation pins a contextual type → predicate false →
    // struct path retained (#2714 control).
    const initIsHostSpreadLiteral =
      decl.initializer !== undefined &&
      ts.isObjectLiteralExpression(decl.initializer) &&
      objectLiteralSpreadTakesHostPath(ctx, decl.initializer);
    // (#2837) A non-empty object literal that the detection pre-pass marked
    // growable (later out-of-shape / nested write) is built as an externref
    // `$Object`; the local must be externref so reads/writes route through
    // `__extern_get`/`__extern_set` (via the same `externrefAccessorVars` hook the
    // member dispatch consults), matching the value representation.
    const initIsGrowableObjectLiteral =
      decl.initializer !== undefined &&
      ts.isObjectLiteralExpression(decl.initializer) &&
      ts.isIdentifier(decl.name) &&
      ctx.growableObjectLiteralVars.has(decl.name.text);
    const initIsOrdinaryToPrimitiveObjectLiteral = ctx.ordinaryToPrimitiveObjectDeclarations.has(decl);
    // (#802 Slice A) A proto-receiver object literal is built as an open `$Object`
    // (externref) in compileObjectLiteral so `Object.setPrototypeOf(o, p)` &
    // inherited reads work; the local must be externref so reads/writes route
    // through `__extern_get`/`__extern_set` (via the `externrefAccessorVars` hook)
    // and the store isn't ref.cast to the closed struct TS infers (which would
    // trap — the value is a `$Object`, not that struct).
    const initIsProtoReceiverLiteral =
      ctx.standalone &&
      decl.initializer !== undefined &&
      ts.isObjectLiteralExpression(decl.initializer) &&
      ctx.dynamicProtoLiteralNodes.has(decl.initializer);
    if (
      initIsAccessorLiteral ||
      initIsHostSpreadLiteral ||
      initIsGrowableObjectLiteral ||
      initIsOrdinaryToPrimitiveObjectLiteral ||
      initIsProtoReceiverLiteral
    ) {
      ctx.externrefAccessorVars.add(name);
    }

    const standaloneRegExpMatchArrayType = inferStandaloneRegExpMatchArrayType(ctx, decl.initializer);
    const subarraySubviewType = inferSubarraySubviewType(ctx, fctx, decl.initializer);
    // (#3054 B1) `new <TA>(buffer)` → shared-backing `$__ta_view` local type.
    const taViewType = inferTaViewType(ctx, decl.initializer);
    // (#2615/#4397) Proxy and Proxy.revocable initializers must use externref
    // slots so dynamic MOP/result-object reads do not become struct.get on the
    // checker-inferred target/revocable shapes.
    // NARROWED (#2615 regression fix): only when the Proxy variable stays local
    // and is member-accessed; if it escapes into a call/new argument or a
    // generic-method `.call`/`.apply` receiver, keep the struct typing so the
    // host generic-method / global paths (IsArray, getPrototypeOf, the
    // Array.prototype.* spec walk) still work on a wasm-struct receiver.
    const initIsProxy =
      decl.initializer !== undefined &&
      isProxyConstruction(decl.initializer) &&
      ts.isIdentifier(decl.name) &&
      !proxyResultEscapesToCall(decl, decl.name.text);
    const isProxyTargetBinding = bindingIsProxyTarget(ctx, decl);
    if (isProxyTargetBinding) ctx.externrefAccessorVars.add(name);
    const initIsPropertyDescriptorResult = isPropertyDescriptorResultExpression(decl.initializer);
    // (#3037 CS1a) A spread-free, data-only object literal produced into an
    // `any`/`unknown`/`object` context (standalone) is built as an open `$Object`
    // and normally lands in an externref local — where at `===` it boxes tag-5
    // and loses `ref.eq` identity (`const o: any = {z:1}; o === o` → 0). Slot the
    // local as a raw `ref $Object` instead: the store coerces the object externref
    // to the ref (`any.convert_extern` + guarded `ref.cast $Object`), `===` then
    // boxes it **tag-6** via `boxToAny`'s `ref` arm (`__any_box_ref`, identity in
    // `refval` → the tag-6 same-tag `ref.eq` arm answers identity), and dynamic
    // `any`-typed member reads coerce the ref back to externref (`extern.convert_
    // any`) for `__extern_get`. This is the same lockstep discipline
    // `objectLiteralSpreadTakesHostPath` uses for its externref locals, and does
    // NOT touch the `===` operand seam (−299) or the generic externref boxing arm
    // (−788). Excludes growable literals (out-of-shape writes need the externref
    // dictionary carrier); accessor/spread/computed-key literals are already
    // excluded by the predicate. `objectTypeIdx` is fetched via the idempotent
    // `ensureObjectRuntime` (the literal compile forces it anyway).
    const initIsAnyObjectCarrier =
      decl.initializer !== undefined &&
      ts.isObjectLiteralExpression(decl.initializer) &&
      !initIsOrdinaryToPrimitiveObjectLiteral &&
      !(ts.isIdentifier(decl.name) && ctx.growableObjectLiteralVars.has(decl.name.text)) &&
      // (#802 Slice A) A proto receiver keeps the externref carrier (below), not
      // the tag-6 `ref $Object` carrier — its reads/setPrototypeOf go through the
      // externref `__extern_*` path.
      !initIsProtoReceiverLiteral &&
      objectLiteralIsStandaloneAnyObjectCarrier(ctx, decl.initializer);
    const anyObjectCarrierTypeIdx = initIsAnyObjectCarrier ? ensureObjectRuntime(ctx).objectTypeIdx : -1;
    // A binding that crosses representation domains must keep the same boxed
    // carrier chosen by the var hoister. In particular, numeric-use analysis
    // may mark a bitmask initializer as i32 even when the binding is later
    // reused for an object payload. Letting that specialization outrank the
    // mixed-assignment proof re-narrows the already-hoisted externref slot at
    // the declaration site and destroys the later object value.
    const mixedAssignmentCarrier = bindingHasMixedAssignmentCarrier(ctx, decl);
    if (mixedAssignmentCarrier) {
      (fctx.mixedAssignmentCarrierVars ??= new Set()).add(name);
    }
    // (#4121) A positive unboxing proof outranks the demotion. Resolved HERE
    // rather than by falling through the cascade: the cascade's `isI32Coerced`
    // arm is exactly the specialization the comment above warns about, and the
    // proof licenses `f64`, never `i32`.
    const mixedCarrierProvenF64 = mixedAssignmentCarrier
      ? numericProofOverridesMixedCarrier(usageInferredLocalType(ctx, decl))
      : null;
    // (#4531) The initializer array literal widens its element carrier to
    // externref because its value escapes into an opaque call argument (see
    // arrayLiteralEscapeWidensToExternref). The SLOT must widen with it — a
    // checker-derived closed-struct vec slot would force a vec→vec converting
    // copy whose per-element ref.test nulls every open-representation element.
    const escapeWidenedVecType: ValType | undefined =
      decl.initializer !== undefined &&
      ts.isArrayLiteralExpression(decl.initializer) &&
      arrayLiteralEscapeWidensToExternref(ctx, decl.initializer)
        ? { kind: "ref_null", typeIdx: getOrRegisterVecType(ctx, "externref", { kind: "externref" }) }
        : undefined;
    const nativeGenBindingType = nativeGeneratorBindingType(ctx, decl.initializer);
    const wasmTypeBase: ValType =
      nativeGenBindingType ??
      // (#3123) A widened fnctor-subclass binding (pre-hoist recorded it in
      // `fnctorWidenedLocals` — reassigned with a foreign/host value) must
      // keep its externref slot even when the block-scoped shadow machinery
      // re-allocates here (the pre-hoisted slot reuse below is gated on
      // plain-fn capture and does not fire for uncaptured bindings).
      (mixedAssignmentCarrier
        ? (mixedCarrierProvenF64 ?? { kind: "externref" as const })
        : realmStructuralCarrier
          ? { kind: "externref" as const }
          : isProxyTargetBinding
            ? { kind: "externref" as const }
            : fctx.forInIdentifierVars?.has(name)
              ? { kind: "externref" as const }
              : fctx.fnctorWidenedLocals?.has(name)
                ? { kind: "externref" as const }
                : initIsAccessorLiteral ||
                    initIsHostSpreadLiteral ||
                    initIsGrowableObjectLiteral ||
                    initIsProtoReceiverLiteral
                  ? { kind: "externref" as const }
                  : initIsAnyObjectCarrier && anyObjectCarrierTypeIdx >= 0
                    ? { kind: "ref_null" as const, typeIdx: anyObjectCarrierTypeIdx }
                    : initIsPropertyDescriptorResult
                      ? { kind: "externref" as const }
                      : isI32CoercedLocal
                        ? { kind: "i32" }
                        : isI32SpecializedArray
                          ? { kind: "ref_null" as const, typeIdx: getOrRegisterVecType(ctx, "i32", { kind: "i32" }) }
                          : widenedTypeIdx !== undefined
                            ? { kind: "ref_null" as const, typeIdx: widenedTypeIdx }
                            : (escapeWidenedVecType ??
                              taViewType ??
                              subarraySubviewType ??
                              inferredVecType ??
                              standaloneRegExpMatchArrayType ??
                              // (#4655) `var arr = x.concat(y, z)` — the concat
                              // lowering yields a dynamic `$ObjVec` externref
                              // for these shapes while the checker types the
                              // binding `number[]` from the lib signature; the
                              // vec-typed slot ToNumber'd every non-numeric
                              // element to NaN. Same predicate the lowering's
                              // dispatcher asks (array-concat-carrier.ts), so
                              // slot and value cannot disagree.
                              (concatCallYieldsDynamicCarrier(ctx, decl.initializer)
                                ? { kind: "externref" as const }
                                : decl.initializer && isStringMethodReturningHostArray(ctx, decl.initializer)
                                  ? { kind: "externref" as const }
                                  : decl.initializer && isPromiseHostCall(ctx, decl.initializer)
                                    ? { kind: "externref" as const }
                                    : // (#2615/#4397) Proxy and revocable-handle results are
                                      // externref carriers in both provider profiles. A
                                      // checker-derived struct slot would cast them to null
                                      // before their MOP/result fields can be observed.
                                      initIsProxy
                                      ? { kind: "externref" as const }
                                      : // (#1337/#4397) In a JS environment, both the
                                        // compatibility exotic and native `$__bound_fn`
                                        // are externref carriers, never the target struct.
                                        decl.initializer &&
                                          !ctx.standalone &&
                                          !noJsHost(ctx) &&
                                          isBindCarrierCall(decl.initializer)
                                        ? { kind: "externref" as const }
                                        : localTypeForDeclaration(ctx, varType, decl))));
    // (#2660 S3b) A provably-monomorphic `new F(...)` binding of an approved
    // fnctor gets the reserved struct slot instead of externref. Same (cached)
    // verdict as the var hoister / let-const pre-hoister, so a reused
    // pre-hoisted slot and this cascade always agree. Applied only when the
    // cascade itself settled on externref — never overrides another inference.
    // (#4491 wave-5 T4) A module `var` REDECLARED with a differently-tagged
    // initializer had its global widened to externref; the module-init shadow
    // local is the same binding and must not be narrowed back by the checker's
    // (first-declaration) symbol type. See `redeclared-var-widening.ts`.
    const wasmType: ValType =
      redeclarationWidenedLocalSlotType(ctx, decl) ??
      (wasmTypeBase.kind === "externref" ? (resolveFnctorTypedBindingType(ctx, decl) ?? wasmTypeBase) : wasmTypeBase);

    // (#2814) Bug C: re-align a block-scoped let/const with its OWN pre-hoisted
    // slot. `saveBlockScopedShadows` removed this name's localMap (and TDZ-flag)
    // entry on block entry, so without this it re-allocates a FRESH slot — but a
    // hoisted FunctionDeclaration that captured this name recorded its capture
    // against the PRE-HOISTED slot (the hoisted-fn capture path has no name-scan
    // fallback). The fresh slot then desyncs from the capture's slot, which stays
    // uninitialised → the closure reads null. When the pre-pass recorded a slot
    // for THIS exact declaration (only happens when the name had no
    // outer/param/var shadow — genuine shadows are *skipped* by the pre-pass and
    // never recorded), re-register it so the declaration reuses it via the
    // isHoistedLetConst path below (value-slot == capture-slot). Fires only when
    // the name is currently absent from localMap (i.e. it WAS shadow-removed).
    //
    // (#2814 narrowing) Reuse the pre-hoisted slot ONLY when the name is captured
    // by at least one PLAIN (non-CPS) nested function declaration and by NO
    // CPS-lowered (`async` / generator) one. Rationale:
    //   • The Bug-C desync only manifests when a hoisted FunctionDeclaration
    //     CAPTURES the block-let (it pins the capture to the pre-hoist slot). For
    //     an UNcaptured block-let the reuse fixes nothing and only perturbs which
    //     raw slot it lands in — so we don't reuse it (keeps non-Bug-C functions
    //     byte-identical to baseline).
    //   • A CPS capturer (async / generator) spills captures into a continuation
    //     state struct; collapsing the duplicate slot perturbs that lowering. The
    //     full-test262 merge_group caught 43 regressions, ALL in
    //     `for-await-of/async-{func,gen}-decl-dstr-*`, where loop-state vars
    //     (`nextCount`/`iterCount`/`iterator`/…) are read inside a for-await-of
    //     continuation — captured BOTH mutably and immutably, so a mutability gate
    //     is insufficient; the *capturer* being async/generator is the signal. If
    //     ANY CPS function captures the name, skip the reuse (the mutable boxed
    //     cell, when present, already threads the value correctly).
    // Plain sync `function f` capturers — the Bug-C cluster and the recovered
    // for-of/for `iter-close` cases — keep the reuse. The async/generator cluster
    // recovery is deferred to the architect follow-up (#2818).
    const isLetConstDecl = !!(
      decl.parent.flags &
      (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)
    );
    if (isLetConstDecl && !fctx.localMap.has(name)) {
      const preHoisted = fctx.preHoistedLetConstSlots?.get(decl);
      let capturedByPlainFn = false;
      let cpsCaptured = false;
      for (const [capturerName, caps] of ctx.nestedFuncCaptures) {
        if (!caps.some((c) => c.name === name)) continue;
        if ((ctx.asyncFunctions?.has(capturerName) ?? false) || (ctx.generatorFunctions?.has(capturerName) ?? false)) {
          cpsCaptured = true;
          break;
        }
        capturedByPlainFn = true;
      }
      if (capturedByPlainFn && !cpsCaptured && preHoisted !== undefined && preHoisted.valueSlot >= fctx.params.length) {
        fctx.localMap.set(name, preHoisted.valueSlot);
        if (preHoisted.flagSlot !== undefined) {
          if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
          fctx.tdzFlagLocals.set(name, preHoisted.flagSlot);
        }
      }
    }

    // If this var/let/const was already pre-hoisted at function entry, reuse that slot.
    // For let/const: the pre-pass (hoistLetConstWithTdz) always pre-allocates a slot
    // regardless of whether a TDZ flag is also allocated, so we check only the localMap.
    const existingIdx = fctx.localMap.get(name);
    // (#1672) An object/class literal initializer whose method/accessor body
    // references THIS same variable (e.g. `var obj = { async *m() { ...obj... } }`)
    // triggers `promoteAccessorCapturesToGlobals` MID-evaluation: it copies the
    // pre-assignment local value into a fresh `__captured_<name>` global, then
    // deletes `name` from `localMap` so later reads resolve via that global.
    // The problem: the promotion copies the STALE value (whatever the local held
    // before this declaration), and the subsequent store writes only the LOCAL.
    // Every later read of `name` then sees the stale global, not the freshly
    // built object — so `obj.method` misses the method and dynamic dispatch
    // returns null. Record whether the name was already a captured global before
    // the initializer runs; if promotion adds it during the initializer, we
    // re-sync the global from the local after the store below.
    const wasCapturedGlobalBefore = ctx.capturedGlobals.has(name);
    // #1177: `using`/`await using` declarations are NOT `var` — they have
    // block-scoped lifetimes and TDZ semantics like let/const.
    const isVar = !(
      decl.parent.flags &
      (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)
    );
    const isHoistedLetConst = !isVar && existingIdx !== undefined && existingIdx >= fctx.params.length;
    const freshLocalForLetConst = !isVar && !isHoistedLetConst;
    let localIdx =
      reusedVarSlotIndex(fctx, decl, isVar, isHoistedLetConst, existingIdx) ?? allocLocal(fctx, name, wasmType);
    if (
      nativeGenBindingType &&
      isVar &&
      existingIdx !== undefined &&
      getLocalType(fctx, existingIdx)?.kind === "externref" &&
      !fctx.boxedCaptures?.has(name)
    )
      fctx.localMap.set(name, (localIdx = allocLocal(fctx, `__native_gen_${name}`, nativeGenBindingType)));

    // (#3037 CS1a) A let/const any-object-carrier reuses a slot the hoist pre-pass
    // pre-allocated as externref (from `resolveWasmType(any)`), so the `wasmType`
    // above (ref $Object) is bypassed. Retype the reused slot to the `$Object` ref
    // so the value boxes tag-6 at `===` (identity) while reads coerce back to
    // externref — the same fixup the initializer-driven ref upgrade (below) does,
    // applied up front for the carrier. Skip closure-captured slots (a boxed /
    // promoted-global capture threads the value through a cell/global of its own
    // type; leave those externref — safe via S3a, only under-fixes).
    if (
      initIsAnyObjectCarrier &&
      anyObjectCarrierTypeIdx >= 0 &&
      localIdx >= fctx.params.length &&
      !(fctx.boxedCaptures?.has(name) ?? false) &&
      !ctx.capturedGlobals.has(name)
    ) {
      const carrierSlot = fctx.locals[localIdx - fctx.params.length];
      if (carrierSlot && carrierSlot.type.kind === "externref") {
        carrierSlot.type = { kind: "ref_null", typeIdx: anyObjectCarrierTypeIdx };
      }
    }

    // #1607: A block-scoped let/const that did NOT reuse a pre-hoisted slot
    // (because `saveBlockScopedShadows` removed its hoisted localMap/TDZ entry
    // on block entry) gets a fresh local with no TDZ flag. A self-referential
    // initializer like `{ const x = x + 1; }` would then read the
    // zero/undefined-initialized fresh local instead of throwing a TDZ
    // ReferenceError. Re-allocate the TDZ flag here, BEFORE the initializer is
    // compiled, and zero-init it so the self-reference read fires the check.
    if (freshLocalForLetConst && needsTdzFlag(ctx, decl)) {
      if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
      if (!fctx.tdzFlagLocals.has(name)) {
        const tdzFlagIdx = allocLocal(fctx, `__tdz_${name}`, { kind: "i32" });
        fctx.tdzFlagLocals.set(name, tdzFlagIdx);
        // Wasm i32 locals zero-init to 0 (uninitialized) automatically — no
        // explicit store needed before the initializer runs.
      }
    }

    // If we reused a pre-hoisted slot but inference found a more precise type
    // (e.g. Array<any> hoisted as vec_externref, but inferred as vec_f64),
    // update the local's type so it matches what the initializer will produce.
    // IMPORTANT: Do NOT retroactively change the type when it would invalidate
    // already-emitted initialization code:
    // - ref/ref_null → primitive: earlier struct.new would become invalid
    // - externref → ref/ref_null: hoisted __get_undefined() can't be cast (#962)
    //
    // (#3396) SKIP the whole re-type when the variable is a boxed mutable
    // capture: a closure constructed BEFORE this declaration (forward/TDZ
    // reference — `var pf = function () { return x; }; let x = "o";`) re-aimed
    // `localMap[name]` at the `__boxed_<name>` REF-CELL local, so `existingIdx`
    // here is the CELL slot, not the value slot. Re-typing it to the declared
    // VALUE type made every already-emitted and later cell-typed use disagree
    // with the slot (`struct.set[0] expected (ref null <cell>), found local.get
    // of (ref null <value>)` — invalid Wasm, the #3396 closure-env family).
    // The box write below (`boxedForInitStore`) is already cell-aware; the
    // slot must keep its ref-cell type. Mirrors the explicit `boxedCaptures`
    // skips in the #3037 carrier and #3097 TA-view arms.
    if (
      (isVar || isHoistedLetConst) &&
      existingIdx !== undefined &&
      existingIdx >= fctx.params.length &&
      !(fctx.boxedCaptures?.has(name) ?? false)
    ) {
      const localSlot = fctx.locals[existingIdx - fctx.params.length];
      if (
        localSlot &&
        (wasmType.kind !== localSlot.type.kind || (wasmType as any).typeIdx !== (localSlot.type as any).typeIdx)
      ) {
        const existingIsRef = localSlot.type.kind === "ref" || localSlot.type.kind === "ref_null";
        const existingIsExternref = localSlot.type.kind === "externref";
        const newIsPrimitive =
          wasmType.kind === "f64" ||
          wasmType.kind === "i32" ||
          wasmType.kind === "i64" ||
          wasmType.kind === "externref";
        const newIsRef = wasmType.kind === "ref" || wasmType.kind === "ref_null";
        // (#820c) Accessor object literals always produce externref — the
        // local's hoisted ref-struct type would force a ref.cast that fails
        // on the JS host plain object, silently nulling the captured value
        // and trapping later closures (#820c, async-gen-yield-star-*). The
        // hoist pass emits no initialization for ref-typed locals, so
        // narrowing ref → externref here is safe (no struct.new to
        // invalidate, and externref locals default to ref.null.extern which
        // is the same "undefined" sentinel a hoisted externref would carry
        // before its first assignment).
        if (initIsAccessorLiteral && existingIsRef && wasmType.kind === "externref") {
          localSlot.type = wasmType;
        } else if (initIsProxy && existingIsRef && wasmType.kind === "externref") {
          // (#2615) A `const p = new Proxy(...)` was pre-hoisted as the target's
          // struct ref (the checker types Proxy as its target T). The hoist pass
          // emits no initialization for ref-typed locals, so narrowing ref →
          // externref here is safe — and required, otherwise the Proxy externref
          // is `ref.test`-coerced into the struct slot (fails → null → trap on
          // every read). Same rationale as the accessor-literal branch above.
          localSlot.type = wasmType;
        } else if (initIsGrowableObjectLiteral && existingIsRef && wasmType.kind === "externref") {
          // (#2837) A `var o = {c:1}` later written out-of-shape was pre-hoisted as
          // the inferred closed struct, but the literal is built as an externref
          // `$Object` (so the out-of-shape write lands). Narrow the hoisted ref slot
          // to externref — required, otherwise the $Object is `ref.test`-coerced into
          // the struct slot (fails → null → every read/write lost). Same rationale as
          // the accessor-literal / Proxy branches above (hoist pass emits no init for
          // ref-typed locals, so ref → externref is safe). The default re-type guard
          // below treats externref as "primitive" and would refuse this narrowing.
          localSlot.type = wasmType;
        } else if (standaloneRegExpMatchArrayType !== null && existingIsExternref && newIsRef) {
          localSlot.type = wasmType;
        } else if (
          taViewType?.kind === "externref" &&
          existingIsRef &&
          wasmType.kind === "externref" &&
          !(fctx.boxedCaptures?.has(name) ?? false) &&
          !ctx.capturedGlobals.has(name)
        ) {
          // (#3097) JS-host `new TA(buffer, ...)` — the value is a REAL host
          // TypedArray externref (built via the host construct bridge), but the
          // var was pre-hoisted as the native vec ref. Narrow the slot to
          // externref so reads route through the extern paths; the vec-slot
          // coercion would otherwise `ref.test`-fail and materialize a COPY
          // (length preserved, aliasing lost). Safe for the same reason as the
          // accessor-literal / Proxy arms: the hoist pass emits no init for
          // ref-typed locals. Captured slots keep the vec type (the capture
          // cell/global was typed at hoist time) and fall back to the
          // guarded-materialize copy.
          localSlot.type = wasmType;
        } else if (!(existingIsRef && newIsPrimitive) && !(existingIsExternref && newIsRef)) {
          localSlot.type = wasmType;
        }
      }
    }

    if (decl.initializer) {
      // Check if the variable has a callable type (function reference).
      // If so, compile without an externref hint to preserve the closure ref type.
      const callSigs = varType.getCallSignatures?.();
      const isCallable = callSigs && callSigs.length > 0 && wasmType.kind === "externref";
      let stackType: ValType = wasmType;
      if (isCallable) {
        // Compile without type hint to get the actual closure/ref type
        const actualType = compileExpression(ctx, fctx, decl.initializer);
        const closureType = actualType ?? { kind: "externref" as const };
        // If the result is a closure ref, update the local's type — but not
        // if the local was pre-hoisted as externref (illegal cast, #962).
        if (
          (closureType.kind === "ref" || closureType.kind === "ref_null") &&
          ctx.closureInfoByTypeIdx.has((closureType as { typeIdx: number }).typeIdx)
        ) {
          if (!fctx.boxedCaptures?.has(name) && localIdx >= fctx.params.length) {
            const localSlot = fctx.locals[localIdx - fctx.params.length];
            if (localSlot && localSlot.type.kind !== "externref") localSlot.type = closureType;
          }
          stackType = closureType;
        } else if (
          closureType.kind === "externref" &&
          !ctx.standalone &&
          !noJsHost(ctx) &&
          isBindCarrierCall(decl.initializer)
        ) {
          // (#1337/#4397) A `.bind(...)` result is a provider-owned externref
          // carrier. Keep it as externref so neither the native `$__bound_fn`
          // nor the compatibility JS exotic is cast to the target's wrapper.
          if (!fctx.boxedCaptures?.has(name) && localIdx >= fctx.params.length) {
            const localSlot = fctx.locals[localIdx - fctx.params.length];
            if (localSlot) localSlot.type = { kind: "externref" };
          }
          stackType = { kind: "externref" };
        } else if (closureType.kind === "externref" && callSigs!.length > 0) {
          // The initializer returned externref but the type is callable.
          // This happens when a function returns a closure coerced to externref.
          // Find the matching closure info by comparing the TS call signature
          // against registered closure types and unbox (any.convert_extern + ref.cast).
          const sig = callSigs![0]!;
          const sigParamCount = sig.parameters.length;
          const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
          const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
          const sigParamWasmTypes: ValType[] = [];
          for (let i = 0; i < sigParamCount; i++) {
            const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
            sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
          }

          let matchedClosureInfo:
            | { structTypeIdx: number; info: typeof ctx.closureInfoByTypeIdx extends Map<number, infer V> ? V : never }
            | undefined;
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
              matchedClosureInfo = { structTypeIdx: typeIdx, info };
              break;
            }
          }

          // (#3432) The match-and-recast below is only sound when the LOCAL SLOT
          // actually takes the narrowed closure type. When the slot is (or must
          // stay) externref — the #962 guard already refuses to narrow it — the
          // sequence was `any.convert_extern` + guarded cast to ONE
          // signature-matched closure struct + widen back to externref: a pure
          // round-trip whose else-arm NULLS the value. Signature wrapper structs
          // are distinct root-child siblings with creation-ORDER-dependent RTTs
          // (see reference #2873), and `closureInfoByTypeIdx` iteration picks an
          // arbitrary first match, so a perfectly good closure of a SIBLING
          // wrapper type read out of an array (`var f = factories[k]`) was
          // destroyed to null — testTypedArray.js's `argFactory.bind(...)`
          // then threw "bind called on non-callable" (~1.8k TypedArray tests).
          // Skip the destructive recast whenever the slot stays externref; the
          // externref-callee dispatch handles calls on it in both lanes.
          //
          // (#3432 follow-up — the +107 null_deref merge_group cluster) The
          // skip is NOT free: the recast also NORMALIZED the stored value to
          // "matched-closure-struct or null", and the #1941 gate
          // (`calleeMayBeHostCallable`) relies on that invariant to omit the
          // #1712 `__call_function` fallback arm at direct-call sites of
          // ordinary locals. With the value left as a raw externref, a
          // FOREIGN callable (a bridge-wrapped wasm closure read back off a
          // property — test262's `var format = compareArray.format;` — or a
          // bound/host function) reaches the closure-struct dispatch, where
          // the guarded root cast nulls and `struct.get` traps
          // "dereferencing a null pointer" (previously the recast nulled the
          // value at the DECL, so the call threw a catchable TypeError
          // instead). Record the decl so `calleeMayBeHostCallable` emits the
          // host-dispatch arm for calls of exactly these variables.
          const slotTypeForCast =
            localIdx < fctx.params.length
              ? fctx.params[localIdx]?.type
              : fctx.locals[localIdx - fctx.params.length]?.type;
          if (slotTypeForCast?.kind === "externref") {
            // Slot stays a raw externref here whether a signature MATCHED but
            // the #962 guard kept it externref (#3432) OR nothing matched
            // (#3460, the else-arm below) — either way the value can be a
            // foreign/bridge/null callable (`var f = obj.missingFn`). Record the
            // decl so `calleeMayBeHostCallable` emits the #1712 __call_function
            // arm; without it the closure-struct dispatch nulls the guarded cast
            // and `struct.get`-traps (uncatchable) where spec wants a catchable
            // TypeError. Arm emission is !standalone&&!wasi-gated → #1941 holds.
            (ctx.skippedClosureRecastDecls ??= new Set()).add(decl);
          }
          if (matchedClosureInfo && slotTypeForCast?.kind !== "externref") {
            // Convert externref back to closure struct ref (guarded to avoid illegal cast)
            fctx.body.push({ op: "any.convert_extern" });
            emitGuardedRefCast(fctx, matchedClosureInfo.structTypeIdx);
            const castType: ValType = { kind: "ref_null", typeIdx: matchedClosureInfo.structTypeIdx };
            if (!fctx.boxedCaptures?.has(name) && localIdx >= fctx.params.length) {
              const localSlot = fctx.locals[localIdx - fctx.params.length];
              // Do NOT narrow externref → ref (#962)
              if (localSlot && localSlot.type.kind !== "externref") localSlot.type = castType;
            }
            stackType = castType;
          } else {
            stackType = closureType;
          }
        } else {
          stackType = closureType;
        }
      } else {
        // #1197: while compiling the initializer for an i32-specialized number[]
        // local, set a transient flag so the array literal / Array() constructor
        // compiler emits an i32 backing array instead of f64.
        const ctxAny = ctx as unknown as { _i32ElemArrayOverride?: boolean };
        const prevElemOverride = ctxAny._i32ElemArrayOverride;
        if (isI32SpecializedArray) ctxAny._i32ElemArrayOverride = true;
        let resultType: ValType | null;
        // (#2692) If `name` is a closure-captured-mutable boxed BEFORE this
        // declaration runs — now the common case since #2692 materializes the
        // ref-cell box eagerly at function-top, but also the #1177 case of a
        // closure constructed before the decl — then `localIdx` points at the
        // ref-cell-ref local. The initializer's VALUE type, the type hint, and
        // the coercion target must all be the box's `valType` (the inner field
        // type), NOT the box ref type. The box write itself is done by the
        // `boxedForInit`/`boxedNoInit` `struct.set` paths below; using the box
        // ref type here would coerce the value f64/externref → ref-cell (garbage
        // `ref.null; ref.as_non_null` / illegal cast). Computed once, reused.
        const boxedForInit = fctx.boxedCaptures?.get(name);
        const initializerExpectedType = boxedForInit
          ? boxedForInit.valType
          : (getLocalType(fctx, localIdx) ?? wasmType);
        try {
          resultType = compileExpression(ctx, fctx, decl.initializer, initializerExpectedType);
        } finally {
          ctxAny._i32ElemArrayOverride = prevElemOverride;
        }
        stackType = resultType ?? wasmType;
        if (
          resultType &&
          wasmType.kind === "externref" &&
          (resultType.kind === "ref" || resultType.kind === "ref_null") &&
          !isVar &&
          !(fctx.tdzFlagLocals?.has(name) ?? false) &&
          localIdx >= fctx.params.length
        ) {
          const localSlot = fctx.locals[localIdx - fctx.params.length];
          if (localSlot?.type.kind === "externref") {
            localSlot.type =
              resultType.kind === "ref"
                ? { kind: "ref_null", typeIdx: (resultType as { typeIdx: number }).typeIdx }
                : resultType;
          }
        }
        // Coerce if the expression produced a type that doesn't match the local.
        // (#2692) When boxed, the target is the box's value type — the
        // `boxedForInit` struct.set path below writes the cell; coercing to the
        // box ref type here would corrupt the stack.
        const targetType = boxedForInit ? boxedForInit.valType : (getLocalType(fctx, localIdx) ?? wasmType);
        if (resultType && !valTypesMatch(resultType, targetType)) {
          const bodyLenBeforeCoerce = fctx.body.length;
          coerceType(ctx, fctx, resultType, targetType);
          // Only update stackType if coercion actually emitted instructions.
          // If coerceType was a no-op (e.g. unrelated struct types), keep
          // the original resultType so emitCoercedLocalSet can detect the
          // mismatch and update the local's declared type accordingly.
          if (fctx.body.length > bodyLenBeforeCoerce) {
            stackType = targetType; // after coercion, stack is targetType
          }
        }
      }
      // #1177/#2692: If the variable was boxed BEFORE this declaration ran
      // (a closure constructed earlier, OR #2692 eager function-top boxing),
      // `localIdx` already points to a `ref __ref_cell_T` local and a plain
      // `local.set` would be a type mismatch. Route the assignment through
      // `struct.set` on the ref cell so post-init mutations propagate to every
      // closure that captured the same cell. (The inner-scope `boxedForInit`
      // above made the initializer value/coerce box-aware; re-resolve here for
      // this outer scope.)
      const boxedForInitStore = fctx.boxedCaptures?.get(name);
      if (boxedForInitStore) {
        const boxedForInit = boxedForInitStore;
        // (#4368) The initializer itself may be what first captures `name`.
        // In that case closure construction boxes the binding mid-expression
        // and re-aims localMap[name] from the raw pre-hoisted value slot to the
        // new ref-cell slot. `localIdx` was resolved before compiling the
        // initializer, so using it here writes a struct value where the cell
        // reference belongs and produces invalid Wasm for shapes such as
        // `let n = { again: () => n }`. Resolve the live storage after the
        // initializer, exactly as the ordinary assignment path does (#3128).
        const boxedLocalIdx = fctx.localMap.get(name) ?? localIdx;
        // Coerce stack to value type if needed.
        if (!valTypesMatch(stackType, boxedForInit.valType)) {
          coerceType(ctx, fctx, stackType, boxedForInit.valType);
        }
        const tmpVal = allocLocal(fctx, `__box_init_tmp_${fctx.locals.length}`, boxedForInit.valType);
        fctx.body.push({ op: "local.set", index: tmpVal });
        fctx.body.push({ op: "local.get", index: boxedLocalIdx });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [],
          else: [
            { op: "local.get", index: boxedLocalIdx },
            { op: "local.get", index: tmpVal },
            {
              op: "struct.set",
              typeIdx: boxedForInit.refCellTypeIdx,
              fieldIdx: 0,
            },
          ],
        });
      } else {
        emitCoercedLocalSet(ctx, fctx, localIdx, stackType);
      }
    } else if (wasmType.kind === "externref") {
      // (#2705) A bare `var x;` redeclaration whose slot was already hoisted to
      // the function scope (and initialized to `undefined` at function entry by
      // `hoistVarDecl`) is a runtime NO-OP per ECMA-262 §14.3.2.1 — re-emitting
      // `__get_undefined` here would CLOBBER any value the variable already
      // holds. Concretely, `for (var x in obj) { var x; … }` writes the
      // enumerated key into x's slot, then the body's `var x;` redeclaration
      // would reset it to undefined. Only emit the undefined-init for a FRESH
      // slot (the genuine first declaration) or a let/const binding leaving the
      // TDZ; skip it for a var that reused a hoisted local.
      const isVarRedeclOfHoistedSlot =
        isVar && reusedVarSlotIndex(fctx, decl, isVar, isHoistedLetConst, existingIdx) !== undefined;
      if (!isVarRedeclOfHoistedSlot) {
        // No initializer: `let x;` / `var x;` — in JS, uninitialized variables
        // are `undefined`, not `null`. Emit __get_undefined() so that
        // `x === undefined` works correctly (#737).
        emitUndefined(ctx, fctx);
        // #1177: If a closure captured x BEFORE this declaration ran, `localIdx`
        // is now the boxed ref-cell ref local. Route the init through
        // `struct.set` on the ref cell so the closure observes the same value.
        // Without this, the post-fixup `local.set` becomes an `any.convert_extern;
        // ref.cast null (ref __ref_cell_T)` that traps at runtime ("illegal cast"),
        // because JS undefined is not a struct ref.
        const boxedNoInit = fctx.boxedCaptures?.get(name);
        if (boxedNoInit) {
          const tmpVal = allocLocal(fctx, `__box_init_tmp_${fctx.locals.length}`, boxedNoInit.valType);
          fctx.body.push({ op: "local.set", index: tmpVal });
          fctx.body.push({ op: "local.get", index: localIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [],
            else: [
              { op: "local.get", index: localIdx },
              { op: "local.get", index: tmpVal },
              { op: "struct.set", typeIdx: boxedNoInit.refCellTypeIdx, fieldIdx: 0 },
            ],
          });
        } else {
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
    }
    // Set local TDZ flag to 1 (initialized) if this is a hoisted let/const
    emitLocalTdzInit(fctx, name);

    // (#1672) If compiling this initializer promoted `name` to a captured
    // global (because a method/accessor body in the initializer referenced
    // `name` itself), the store above wrote only the local — but the promotion
    // seeded the global with the STALE pre-assignment value and every later
    // read of `name` now goes through the global. Re-sync the global from the
    // local so subsequent reads observe the freshly-initialized value. We only
    // do this for the promotion-during-this-init case (not pre-existing
    // captured globals, which the normal module-global store path handles).
    const capturedGlobalIdx = ctx.capturedGlobals.get(name);
    if (capturedGlobalIdx !== undefined && !wasCapturedGlobalBefore && localIdx >= fctx.params.length) {
      const localSlot = fctx.locals[localIdx - fctx.params.length];
      const globalSlot = ctx.mod.globals[localGlobalIdx(ctx, capturedGlobalIdx)];
      if (localSlot && globalSlot) {
        fctx.body.push({ op: "local.get", index: localIdx });
        // Coerce the local value to the global's declared type if they differ
        // (e.g. local is `(ref N)` while the captured global was widened to
        // `ref_null`/`externref`). Reuse the shared coercion helper.
        if (!valTypesMatch(localSlot.type, globalSlot.type)) {
          coerceType(ctx, fctx, localSlot.type, globalSlot.type);
        }
        fctx.body.push({ op: "global.set", index: capturedGlobalIdx });
      }
    }
  }
}
