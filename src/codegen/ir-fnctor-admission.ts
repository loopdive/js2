// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Source-qualified producer for the bounded #3521 fnctor admission seam.
 *
 * This module deliberately produces only the small propagation/selection
 * evidence object.  It does not allocate a Wasm type, plan a support
 * callable, or lower an AST node.  Those later stages must consume the same
 * source/unit identity and remain fail-closed when their ABI sidecar is not
 * populated.
 */

import { ts, forEachChild } from "../ts-api.js";
import type {
  IrFnctorAdmission,
  IrFnctorPropagationAdmissionResolver,
  IrFnctorSelectionAdmissionResolver,
  LatticeType,
} from "../ir/propagate.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import type { IrSourceId } from "../ir/identity.js";
import type { CodegenContext } from "./context/types.js";

function aliasedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return undefined;
  }
}

function symbolOwnsDeclaration(checker: ts.TypeChecker, node: ts.Identifier, declaration: ts.Node): boolean {
  const symbol = aliasedSymbol(checker, node);
  if (!symbol) return false;
  return (symbol.getDeclarations() ?? []).some((candidate) => candidate === declaration);
}

function isStringType(checker: ts.TypeChecker, node: ts.Node): boolean {
  const type = checker.getTypeAtLocation(node);
  return (type.flags & ts.TypeFlags.StringLike) !== 0;
}

function directInputAssignment(
  statement: ts.Statement,
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return false;
  const assignment = statement.expression;
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  if (!ts.isPropertyAccessExpression(assignment.left) || assignment.left.name.text !== "input") return false;
  if (assignment.left.expression.kind !== ts.SyntaxKind.ThisKeyword) return false;
  return ts.isIdentifier(assignment.right) && symbolOwnsDeclaration(checker, assignment.right, parameter);
}

/**
 * Prove the intentionally narrow constructor shape used by the first linked
 * parser slice.  Requiring the assignment to be a top-level statement and the
 * RHS to be the exact string parameter rejects aliases, conditional writes,
 * reassignment, helper calls, and hidden object-shape growth.
 */
function hasFixedInputConstructor(
  checker: ts.TypeChecker,
  declaration: ts.FunctionDeclaration | ts.FunctionExpression,
): boolean {
  if (!declaration.body || !ts.isBlock(declaration.body) || declaration.parameters.length !== 1) return false;
  const parameter = declaration.parameters[0];
  if (!ts.isIdentifier(parameter.name) || parameter.name.text !== "input" || !isStringType(checker, parameter)) {
    return false;
  }
  if (
    declaration.body.statements.length !== 1 ||
    !directInputAssignment(declaration.body.statements[0]!, checker, parameter)
  ) {
    return false;
  }

  // Keep this explicit walk as a defense against a future AST transform that
  // leaves a second `this.input` write below the statement-level proof.
  let assignments = 0;
  let foreignThisWrite = false;
  const visit = (node: ts.Node): void => {
    if (node !== declaration && ts.isFunctionLike(node)) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      if (node.left.name.text === "input") assignments++;
      else foreignThisWrite = true;
    }
    forEachChild(node, visit);
  };
  visit(declaration.body);
  return assignments === 1 && !foreignThisWrite;
}

/** Prove the admitted value stays inside source-local member receivers. */
function hasNoEscape(checker: ts.TypeChecker, site: ts.NewExpression): boolean {
  let value: ts.Expression = site;
  let parent = value.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent))
  ) {
    value = parent;
    parent = parent.parent;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === value) return true;
  if (ts.isElementAccessExpression(parent) && parent.expression === value) return true;
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== value || !ts.isIdentifier(parent.name)) return false;
  const binding = parent.name;
  const symbol = aliasedSymbol(checker, binding);
  if (!symbol) return false;
  let ownerFunction: ts.FunctionLikeDeclaration | undefined;
  for (let ancestor: ts.Node | undefined = parent.parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isFunctionLike(ancestor)) {
      ownerFunction = ancestor as ts.FunctionLikeDeclaration;
      break;
    }
  }
  let sawUse = false;
  let nestedFunctionUse = false;
  const sourceFile = site.getSourceFile();
  const visit = (node: ts.Node): void => {
    if (node !== sourceFile && ts.isFunctionLike(node) && node !== ownerFunction) {
      nestedFunctionUse = true;
      return;
    }
    if (ts.isIdentifier(node) && aliasedSymbol(checker, node) === symbol && node !== binding) {
      sawUse = true;
      const use = node.parent;
      if (
        !(ts.isPropertyAccessExpression(use) && use.expression === node) &&
        !(ts.isElementAccessExpression(use) && use.expression === node)
      ) {
        sawUse = false;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return sawUse && !nestedFunctionUse;
}

function resolveAdmission(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  identityContext: IrPlanningIdentityContext,
  site: ts.NewExpression,
): IrFnctorAdmission | undefined {
  const gate = ctx.fnctorEscapeGate;
  if (!gate || !ts.isIdentifier(site.expression) || !gate.approved.has(site)) return undefined;
  const sourceFile = site.getSourceFile();
  const sourceId = identityContext.sourceIdBySourceFile.get(sourceFile);
  if (sourceId === undefined) return undefined;
  const name = site.expression.text;
  if (!gate.approvedNames.has(name) || gate.provenance.refusedNames.includes(name)) return undefined;
  const declaration = gate.ctorDeclByName.get(name);
  if (!declaration || declaration.getSourceFile() !== sourceFile) return undefined;
  if (!symbolOwnsDeclaration(checker, site.expression, declaration)) return undefined;
  const constructorUnitId = identityContext.unitIdByDeclaration.get(declaration);
  if (!constructorUnitId) return undefined;
  const reservedTypeIdx = ctx.fnctorReservedTypeIdx.get(name);
  if (reservedTypeIdx === undefined || ctx.structMap.get(`__fnctor_${name}`) !== reservedTypeIdx) return undefined;
  if (!hasFixedInputConstructor(checker, declaration)) return undefined;
  if (!hasNoEscape(checker, site)) return undefined;

  return {
    kind: "fnctor-admission",
    sourceId,
    constructorUnitId,
    constructorDeclaration: declaration,
    constructorSite: site,
    shape: { kind: "fnctor-shape", fields: [{ name: "input", type: "string" }] },
    proof: {
      sameSource: true,
      approved: true,
      reserved: true,
      directConstructor: true,
      fixedUnconditionalInput: true,
      noAlias: true,
      noReassignment: true,
      noEscape: true,
      noCrossSourceCollision: true,
    },
  };
}

/** Build the checker/context-owned resolver used by selector and propagation. */
export function makeIrFnctorAdmissionResolver(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  identityContext: IrPlanningIdentityContext,
): IrFnctorSelectionAdmissionResolver {
  return (site) => resolveAdmission(ctx, checker, identityContext, site);
}

/** Adapt the same source-qualified proof to the propagation callback shape. */
export function makeIrFnctorPropagationAdmissionResolver(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  identityContext: IrPlanningIdentityContext,
): IrFnctorPropagationAdmissionResolver {
  return (site, sourceId, _scope: ReadonlyMap<string, LatticeType>) => {
    const admission = resolveAdmission(ctx, checker, identityContext, site);
    return admission?.sourceId === sourceId ? admission : undefined;
  };
}
