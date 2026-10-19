// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Boundary-only value views for user-authored ambient function capabilities. */
import { forEachChild, ts } from "../../ts-api.js";
import { jsValueBoundary, type CodegenContext } from "../context/types.js";
import { addImport } from "../registry/imports.js";
import { addFuncType } from "../registry/types.js";

/**
 * Whether the function is observed as a first-class value, not merely invoked
 * through its typed Wasm import. Checker identity excludes lexical shadows.
 */
function hasValueRead(ctx: CodegenContext, sourceFile: ts.SourceFile, declaration: ts.FunctionDeclaration): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node !== declaration.name && node.text === declaration.name?.text) {
      const parent = node.parent;
      const directCallee =
        ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) ||
        (ts.isTaggedTemplateExpression(parent) && parent.tag === node);
      const nonValueName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isTypeReferenceNode(parent) && parent.typeName === node) ||
        (ts.isTypeQueryNode(parent) && parent.exprName === node);
      if (
        !directCallee &&
        !nonValueName &&
        ctx.oracle.declarationsOf(node).some((candidate) => candidate === declaration)
      ) {
        found = true;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Register an ambient function's JS-owned identity only when it is read. */
export function registerAmbientFunctionValueThunk(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  declaration: ts.FunctionDeclaration,
): void {
  const name = declaration.name?.text;
  if (
    name === undefined ||
    sourceFile.isDeclarationFile ||
    !jsValueBoundary(ctx) ||
    !ctx.mod.declaredFunctionImports?.has(name) ||
    !hasValueRead(ctx, sourceFile, declaration)
  ) {
    return;
  }
  const importName = `global_${name}`;
  if (!ctx.funcMap.has(importName)) {
    const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
    addImport(ctx, "env", importName, { kind: "func", typeIdx });
  }
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx !== undefined) ctx.declaredGlobals.set(name, { type: { kind: "externref" }, funcIdx });
}
