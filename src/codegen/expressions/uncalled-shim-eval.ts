// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts, forEachChild } from "../../ts-api.js";

/**
 * (#6651 W2b) Is `call` inside a function that can never run — the anonymous
 * function value of an object-literal property `N` whose name the file uses
 * only to define or copy that property (`N: function(){…}`, `N: x.N`)? The
 * test262 `$262.evalScript` shim (`return eval(sourceText)`) is that shape in
 * every `$262` row, and it is what made every binding proof fail there. Any
 * other mention of `N` — a call, a read, an element key — keeps the eval live.
 */
export function isUncalledPropertyShim(source: ts.SourceFile, call: ts.CallExpression): boolean {
  let fn: ts.Node = call.parent;
  while (!ts.isFunctionLike(fn)) {
    if (ts.isSourceFile(fn)) return false;
    fn = fn.parent;
  }
  const prop = ts.isFunctionExpression(fn) ? fn.parent : fn;
  const named = ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop);
  if (!named || (ts.isFunctionExpression(fn) && fn.name) || !ts.isIdentifier(prop.name)) return false;
  const name = prop.name.text;
  let live = false;
  const visit = (node: ts.Node): void => {
    if (live) return;
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent;
      const definesProperty =
        (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node;
      const copiesProperty =
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node &&
        ts.isPropertyAssignment(parent.parent) &&
        parent.parent.initializer === parent &&
        ts.isIdentifier(parent.parent.name) &&
        parent.parent.name.text === name;
      if (!definesProperty && !copiesProperty) live = true;
    } else if (ts.isStringLiteralLike(node) && node.text === name) {
      live = true;
    }
    if (!live) forEachChild(node, visit);
  };
  visit(source);
  return !live;
}
