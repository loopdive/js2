// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Static `with` statement lowering (#1387).
 *
 * This slice implements the Tier-1, closed-shape path for object literals:
 * the `with` target is compiled once into a local, the literal's own key set
 * is treated as closed, and bare identifier references that statically satisfy
 * Object Environment Record HasBinding are rewritten to direct struct
 * get/set. Unproven targets keep the #1387 diagnostic gate.
 */
import { ts, forEachChild } from "../ts-api.js";
import type { FieldDef, ValType } from "../ir/types.js";
import { reportError } from "./context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureComputedPropertyFields, compileObjectLiteralForStruct } from "./literals.js";
import { ensureStructForType, resolveWasmType } from "./index.js";
import { resolveStructName } from "./property-access.js";
import { compileExpression, compileStatement, coerceType, valTypesMatch } from "./shared.js";

const OBJECT_PROTOTYPE_KEYS = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
]);

export interface WithBinding {
  scope: NonNullable<FunctionContext["withScopes"]>[number];
  field: FieldDef;
  fieldIdx: number;
}

type WithTargetIntegrity = "plain" | "sealed" | "frozen";

interface WithTargetProof {
  ok: true;
  expr: ts.ObjectLiteralExpression;
  keys: Set<string>;
  integrity: WithTargetIntegrity;
}

export function findWithBinding(fctx: FunctionContext, name: string): WithBinding | null {
  const scopes = fctx.withScopes;
  if (!scopes || scopes.length === 0) return null;

  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i]!;
    if (scope.blockedNames.has(name)) continue;
    const fieldIdx = scope.fields.findIndex((f) => f.name === name);
    if (fieldIdx >= 0) {
      return { scope, field: scope.fields[fieldIdx]!, fieldIdx };
    }
    if (OBJECT_PROTOTYPE_KEYS.has(name)) {
      return null;
    }
  }
  return null;
}

export function emitWithBindingGet(fctx: FunctionContext, binding: WithBinding): ValType {
  fctx.body.push({ op: "local.get", index: binding.scope.localIdx });
  fctx.body.push({ op: "struct.get", typeIdx: binding.scope.structTypeIdx, fieldIdx: binding.fieldIdx });
  return binding.field.type;
}

export function compileWithBindingAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  binding: WithBinding,
  rhs: ts.Expression,
): ValType | null {
  if (!binding.field.mutable) {
    reportError(
      ctx,
      rhs,
      `#1387: cannot assign through with binding "${binding.field.name}" because the field is immutable`,
    );
    return null;
  }

  const resultType = compileExpression(ctx, fctx, rhs, binding.field.type);
  if (!resultType) return null;
  if (!valTypesMatch(resultType, binding.field.type)) {
    coerceType(ctx, fctx, resultType, binding.field.type);
  }

  const tmp = allocTempLocal(fctx, binding.field.type);
  fctx.body.push({ op: "local.set", index: tmp });
  fctx.body.push({ op: "local.get", index: binding.scope.localIdx });
  fctx.body.push({ op: "local.get", index: tmp });
  fctx.body.push({ op: "struct.set", typeIdx: binding.scope.structTypeIdx, fieldIdx: binding.fieldIdx });
  fctx.body.push({ op: "local.get", index: tmp });
  releaseTempLocal(fctx, tmp);
  return binding.field.type;
}

export function compileWithStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.WithStatement): void {
  const proof = proveObjectLiteralWithTarget(fctx, stmt.expression);
  if (!proof.ok) {
    reportWithStatementDiagnostic(ctx, stmt, proof.reason);
    return;
  }
  if (containsNestedFunctionBoundary(stmt.statement)) {
    reportWithStatementDiagnostic(
      ctx,
      stmt,
      "body contains a nested function or class that could capture the object environment",
    );
    return;
  }

  const targetType = compileClosedObjectLiteralTarget(ctx, fctx, proof.expr);
  if (!targetType || (targetType.kind !== "ref" && targetType.kind !== "ref_null")) {
    if (targetType) fctx.body.push({ op: "drop" });
    reportWithStatementDiagnostic(ctx, stmt, "target did not lower to a WasmGC struct with a closed shape");
    return;
  }

  const structTypeIdx = targetType.typeIdx;
  const localIdx = allocLocal(fctx, `__with_scope_${fctx.locals.length}`, targetType);
  fctx.body.push({ op: "local.set", index: localIdx });

  const typeName = ctx.typeIdxToStructName.get(structTypeIdx);
  const fields = typeName ? ctx.structFields.get(typeName) : undefined;
  if (!fields) {
    reportWithStatementDiagnostic(ctx, stmt, "compiled target struct fields are unavailable");
    return;
  }

  const targetKeys = new Set(fields.map((f) => f.name));
  for (const key of proof.keys) {
    if (!targetKeys.has(key)) {
      reportWithStatementDiagnostic(ctx, stmt, `compiled target struct is missing literal key "${key}"`);
      return;
    }
  }

  const blockedNames = collectBodyDeclaredNames(stmt.statement);
  const referencedNames = collectBodyReferencedNames(stmt.statement);
  for (const name of referencedNames) {
    if (!blockedNames.has(name) && !proof.keys.has(name) && OBJECT_PROTOTYPE_KEYS.has(name)) {
      reportWithStatementDiagnostic(
        ctx,
        stmt,
        `body references inherited Object.prototype key "${name}", which this static slice cannot route as an own field`,
      );
      return;
    }
  }
  const scopeFields = proof.integrity === "frozen" ? fields.map((field) => ({ ...field, mutable: false })) : fields;
  const scope = { localIdx, structTypeIdx, fields: scopeFields, blockedNames };
  (fctx.withScopes ??= []).push(scope);
  try {
    compileStatement(ctx, fctx, stmt.statement);
  } finally {
    fctx.withScopes?.pop();
  }
}

function compileClosedObjectLiteralTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
): ValType | null {
  const tsType = ctx.checker.getTypeAtLocation(expr);
  let typeName = resolveStructName(ctx, tsType);
  if (!typeName) {
    ensureStructForType(ctx, tsType);
    typeName = resolveStructName(ctx, tsType);
  }
  if (!typeName) {
    typeName = registerClosedLiteralStruct(ctx, expr);
  }
  ensureComputedPropertyFields(ctx, fctx, expr, tsType);
  return compileObjectLiteralForStruct(ctx, fctx, expr, typeName);
}

function registerClosedLiteralStruct(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): string {
  const typeName = `__with_anon_${ctx.anonTypeCounter++}`;
  const fields: FieldDef[] = [];
  for (const prop of expr.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      fields.push({
        name: prop.name.text,
        type: resolveWasmType(ctx, ctx.checker.getTypeAtLocation(prop.name)),
        mutable: true,
      });
    } else if (ts.isPropertyAssignment(prop)) {
      const name = staticPropertyName(prop.name);
      if (name === undefined) continue;
      fields.push({
        name,
        type: resolveWasmType(ctx, ctx.checker.getTypeAtLocation(prop.initializer)),
        mutable: true,
      });
    }
  }
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: typeName, fields });
  ctx.structMap.set(typeName, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, typeName);
  ctx.structFields.set(typeName, fields);
  return typeName;
}

function reportWithStatementDiagnostic(ctx: CodegenContext, stmt: ts.WithStatement, reason: string): void {
  reportError(
    ctx,
    stmt,
    `#1387: with statement requires a proven closed object-literal shape before codegen; ${reason}. ECMA-262 14.11.2 creates an Object Environment Record, 9.1.1.2.1 checks HasProperty plus @@unscopables, and 7.3.11 includes inherited properties. Dynamic fallback is deferred to #1472.`,
  );
}

function proveObjectLiteralWithTarget(
  fctx: FunctionContext,
  expr: ts.Expression,
): WithTargetProof | { ok: false; reason: string } {
  if (!ts.isObjectLiteralExpression(expr)) {
    const builtinIntegrity = unwrapBuiltinObjectIntegrityCall(fctx, expr);
    if (builtinIntegrity) {
      const proof = proveObjectLiteralWithTarget(fctx, builtinIntegrity.expr);
      if (!proof.ok) return proof;
      return { ...proof, integrity: builtinIntegrity.integrity };
    }
    return { ok: false, reason: `target ${ts.SyntaxKind[expr.kind]} is not a closed object literal` };
  }

  const keys = new Set<string>();
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      return { ok: false, reason: "object literal contains a spread, so the complete key set is not local" };
    }
    if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
      return { ok: false, reason: "object literal contains accessors, which require dynamic property semantics" };
    }
    if (ts.isMethodDeclaration(prop)) {
      return { ok: false, reason: "object literal contains a method; method-value routing is deferred" };
    }
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) {
      return { ok: false, reason: "object literal property kind is not in the static slice" };
    }

    const name = ts.isShorthandPropertyAssignment(prop) ? prop.name.text : staticPropertyName(prop.name);
    if (name === undefined) {
      return { ok: false, reason: "object literal contains a dynamic computed property key" };
    }
    if (keys.has(name)) {
      return {
        ok: false,
        reason: `object literal contains duplicate key "${name}", which this static slice does not fold`,
      };
    }
    if (name === "@@unscopables") {
      return { ok: false, reason: "static @@unscopables filtering is deferred for this slice" };
    }
    if (name === "__proto__") {
      return { ok: false, reason: "object literal may alter the prototype through __proto__" };
    }
    keys.add(name);
  }
  return { ok: true, expr, keys, integrity: "plain" };
}

function unwrapBuiltinObjectIntegrityCall(
  fctx: FunctionContext,
  expr: ts.Expression,
): { expr: ts.Expression; integrity: Exclude<WithTargetIntegrity, "plain"> } | null {
  if (!ts.isCallExpression(expr) || expr.arguments.length !== 1) return null;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "Object") return null;
  if (fctx.localMap.has("Object")) return null;
  if (callee.name.text === "freeze") return { expr: expr.arguments[0]!, integrity: "frozen" };
  if (callee.name.text === "seal") return { expr: expr.arguments[0]!, integrity: "sealed" };
  return null;
}

function staticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) {
    const expr = name.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (ts.isNumericLiteral(expr)) return String(Number(expr.text));
    if (
      ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "Symbol" &&
      expr.name.text === "unscopables"
    ) {
      return "@@unscopables";
    }
  }
  return undefined;
}

function containsNestedFunctionBoundary(stmt: ts.Statement): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (node !== stmt && isFunctionOrClassBoundary(node)) {
      found = true;
      return;
    }
    forEachChild(node, walk);
  };
  walk(stmt);
  return found;
}

function collectBodyDeclaredNames(stmt: ts.Statement): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (node !== stmt && isFunctionOrClassBoundary(node)) return;
    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, names);
      return;
    }
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name) names.add(node.name.text);
      return;
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBindingNames(node.variableDeclaration.name, names);
    }
    forEachChild(node, walk);
  };
  walk(stmt);
  return names;
}

function collectBodyReferencedNames(stmt: ts.Statement): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (node !== stmt && isFunctionOrClassBoundary(node)) return;
    if (ts.isIdentifier(node) && isIdentifierReference(node)) {
      names.add(node.text);
    }
    forEachChild(node, walk);
  };
  walk(stmt);
  return names;
}

function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    collectBindingNames(element.name, out);
  }
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node) return false;
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) return false;
  if (ts.isBindingElement(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return false;
  return true;
}

function isFunctionOrClassBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}
