// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrHostVoidCallbackLoweringPlan } from "../ir/ast-lowering-plans.js";
import { isBoundedPreparedNestedOrdinaryClass } from "../ir/class-accessor-safety.js";
import type { IrUnitId } from "../ir/identity.js";
import { ts } from "../ts-api.js";

/**
 * R3 may own nested executable syntax when the structural selector has already
 * admitted the enclosing terminal and every special host callback still
 * matches its exact TypedAST plan. Ordinary nested function declarations are
 * lowered into their inventoried source units under the terminal owner's
 * prepared transaction; generic closure literals and selector-certified
 * object methods are lowered into their inventoried source units under the
 * same transaction. Accessors and class static blocks remain outside this
 * checkpoint. The host-callback map key is
 * the authoritative AST identity; owner and ordinal checks keep that special
 * synthetic namespace complete, gap-free, and source ordered.
 */
export function containsUnplannedNestedExecutableSyntax(
  declaration: ts.FunctionLikeDeclaration,
  ownerUnitId: IrUnitId,
  ownerName: string,
  hostVoidCallbacks: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>,
): boolean {
  if (!declaration.body) return false;
  const ownerPlans = [...hostVoidCallbacks.entries()].filter(([, plan]) => plan.ownerUnitId === ownerUnitId);
  const seen = new Set<IrHostVoidCallbackLoweringPlan>();
  const ordinals = new Set<number>();
  let invalid = false;
  const visit = (node: ts.Node): void => {
    if (invalid) return;
    if (ts.isArrowFunction(node)) {
      const plan = hostVoidCallbacks.get(node);
      if (
        plan &&
        (plan.ownerUnitId !== ownerUnitId ||
          plan.ownerName !== ownerName ||
          node.parameters.length !== 0 ||
          plan.signature.params.length !== 0 ||
          plan.signature.returnType !== null ||
          !Number.isSafeInteger(plan.liftedOrdinal) ||
          plan.liftedOrdinal < 0 ||
          ordinals.has(plan.liftedOrdinal))
      ) {
        invalid = true;
        return;
      }
      if (plan) {
        seen.add(plan);
        ordinals.add(plan.liftedOrdinal);
      }
      ts.forEachChild(node.body, visit);
      return;
    }
    if (ts.isFunctionExpression(node)) {
      if (!node.body) {
        invalid = true;
        return;
      }
      ts.forEachChild(node.body, visit);
      return;
    }
    if (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent)) {
      if (!node.body) {
        invalid = true;
        return;
      }
      ts.forEachChild(node.body, visit);
      return;
    }
    if (ts.isFunctionDeclaration(node)) {
      if (!node.body) {
        invalid = true;
        return;
      }
      ts.forEachChild(node.body, visit);
      return;
    }
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && isBoundedPreparedNestedOrdinaryClass(node)) {
      return;
    }
    if (
      ts.isFunctionLike(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isClassStaticBlockDeclaration(node)
    ) {
      invalid = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(declaration.body, visit);
  if (invalid || seen.size !== ownerPlans.length) return true;
  for (const [, plan] of ownerPlans) {
    if (!seen.has(plan)) return true;
  }
  for (let ordinal = 0; ordinal < ownerPlans.length; ordinal++) {
    if (!ordinals.has(ordinal)) return true;
  }
  return false;
}
