// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";

/**
 * (#1075/#7032) The CommonJS `module.exports` object, in either spelling the
 * #1075 export recogniser in `collectDeclarations` can meet. Since 58081ee2d9
 * the cjs-rewrite prepass replaces every literal `module.exports` in a CommonJS
 * script with its export cell `__cjs_default_export` (see src/cjs-rewrite.ts),
 * so `module.exports.foo = function () {}` reaches codegen as
 * `__cjs_default_export.foo = …` and, matched only literally, lost its Wasm
 * export.
 */
export function isCjsModuleExportsObject(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return e.text === "__cjs_default_export";
  return (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "module" &&
    e.name.text === "exports"
  );
}
