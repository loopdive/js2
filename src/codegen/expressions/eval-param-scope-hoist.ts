// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6774 S7) A sloppy direct `eval("var x = …")` inside a PARAMETER INITIALIZER
// declares `x` in the function's parameter-scope environment (ES2015
// FunctionDeclarationInstantiation with parameter expressions: the formals, the
// eval'd vars and the body share one environment). The constant-string splice
// creates that binding in statement order, so a closure created by an EARLIER
// parameter initializer (`(_ = p = () => x, __ = eval("var x = 1")) => …`)
// already resolved `x` to the OUTER binding. Hoist every such name to a boxed
// frame local before the first initializer compiles; the splice then assigns
// the existing cell, and the earlier closure captures that cell.

import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { getOrRegisterRefCellType } from "../registry/types.js";
import { isStrictContext } from "../helpers/is-strict-function.js";
// Late-bound: a direct import of late-imports/eval-inline would close an import cycle (#6797).
import {
  emitUndefined,
  foldedEvalDeclarationNames,
  resolveConstantString,
} from "../registry/expression-helper-delegates.js";

function nearestFunction(node: ts.Node): ts.Node | undefined {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  return current;
}

function parameterEvalVarNames(owner: ts.SignatureDeclarationBase): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "eval" &&
      node.arguments.length > 0 &&
      nearestFunction(node) === owner
    ) {
      const src = resolveConstantString(node.arguments[0]!);
      if (src !== null) {
        const sf = ts.createSourceFile("__eval_param.js", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const diags = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
        if (!diags || diags.length === 0) for (const name of foldedEvalDeclarationNames(sf).varNames) names.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const param of owner.parameters) visit(param);
  return names;
}

/** True when a function created inside a parameter initializer reads `name`. */
function parameterClosureReads(owner: ts.SignatureDeclarationBase, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node, inClosure: boolean): void => {
    if (found) return;
    if (inClosure && ts.isIdentifier(node) && node.text === name) {
      found = true;
      return;
    }
    const nowInClosure = inClosure || ts.isFunctionLike(node);
    ts.forEachChild(node, (child) => visit(child, nowInClosure));
  };
  for (const param of owner.parameters) visit(param, false);
  return found;
}

/**
 * Pre-declare the parameter-scope eval vars of `owner` as boxed externref cells
 * initialised to `undefined`. Standalone, sloppy, and only for names a
 * parameter-initializer closure reads (the one shape the in-order splice gets
 * wrong); parameter-name collisions stay with the splice's SyntaxError.
 */
export function hoistParameterEvalVars(
  ctx: CodegenContext,
  fctx: FunctionContext,
  owner: ts.SignatureDeclarationBase,
): void {
  if (!ctx.standalone || isStrictContext(owner, ctx.inferModuleStrictArguments)) return;
  const paramNames = new Set<string>(["arguments"]);
  const addNames = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) paramNames.add(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) addNames(el.name);
  };
  for (const param of owner.parameters) addNames(param.name);
  for (const name of parameterEvalVarNames(owner)) {
    if (paramNames.has(name) || fctx.localMap.has(name) || !parameterClosureReads(owner, name)) continue;
    const valType = { kind: "externref" } as const;
    const refCellTypeIdx = getOrRegisterRefCellType(ctx, valType);
    const localIdx = allocLocal(fctx, name, { kind: "ref", typeIdx: refCellTypeIdx });
    emitUndefined(ctx, fctx);
    fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
    fctx.body.push({ op: "local.set", index: localIdx });
    (fctx.boxedCaptures ??= new Map()).set(name, { refCellTypeIdx, valType });
  }
}
