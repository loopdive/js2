// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6684) A function read as a VALUE must not resolve to ANOTHER module's
 * same-named top-level variable.
 *
 * `ctx.moduleGlobals` is keyed by the bare name across a linked graph. lodash-es
 * has both
 *
 * ```js
 * // mixin.js
 * function mixin(object, source, options) { … }
 * export default mixin;
 *
 * // lodash.default.js
 * import _mixin from './mixin.js';
 * var mixin = (function(func) { … }(_mixin));
 * ```
 *
 * `lodash.default.js`'s `var mixin` mints the `__mod_mixin` cell (#6669 made
 * a foreign function no longer suppress it). The identifier read in
 * `export default mixin` — which the checker resolves to mixin.js's own
 * FunctionDeclaration — then took the name-keyed module-global arm first and
 * read `__mod_mixin`, still null because lodash.default.js initialises after
 * mixin.js. `_mixin` was null, so `mixin(lodash, lodash)` at module init threw
 * `TypeError: Cannot access property on null or undefined at 88:12` (standalone
 * and JS-host alike).
 *
 * #6669 fixed the mirror case (a variable read that resolved to a foreign
 * function); this is the function-read-hits-foreign-variable direction.
 *
 * Deliberately narrow — the module global is skipped only when it provably
 * cannot back this binding:
 *  - the checker resolves the read to a top-level FunctionDeclaration with a
 *    body, compiled to its own source-function handle;
 *  - every declaration of the symbol is a FunctionDeclaration (no same-source
 *    `var f` merge whose cell the global could legitimately be);
 *  - the name is not a reassigned-function live binding (#2931), whose global
 *    IS this function's cell.
 * The read then falls through to the ordinary function-as-value arm.
 * Single-source programs never have a foreign cell, so they are unaffected.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { sourceFunctionHandleForDeclaration } from "../program-abi-source-callable-planning.js";

export function moduleGlobalIsForeignToFunctionRead(
  ctx: CodegenContext,
  id: ts.Identifier,
  resolvedValueDeclaration: ts.Declaration | undefined,
): boolean {
  if (resolvedValueDeclaration === undefined || !ts.isFunctionDeclaration(resolvedValueDeclaration)) return false;
  if (resolvedValueDeclaration.body === undefined || !ts.isSourceFile(resolvedValueDeclaration.parent)) return false;
  if (resolvedValueDeclaration.getSourceFile().isDeclarationFile) return false;
  if (ctx.liveFuncBindingGlobals?.has(id.text)) return false;
  if (sourceFunctionHandleForDeclaration(ctx, resolvedValueDeclaration) === undefined) return false;
  const declarations = ctx.oracle.declarationsOf(id);
  return declarations.length > 0 && declarations.every((declaration) => ts.isFunctionDeclaration(declaration));
}
