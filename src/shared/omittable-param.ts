// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Which formal parameters can a caller leave out? A native scalar slot cannot
 * represent the value such a parameter then holds: the generic missing-argument
 * pad for an `f64`/`i32`/`i64` is zero, while JavaScript observes `undefined`.
 * Proven from the AST alone, so every site that derives a function
 * declaration's parameter ABI asks the same question and gets the same answer:
 * legacy's `lowerParamType`, the closure-call wrapper signature, the
 * callable-property dispatch, and the IR selector, which must ask legacy for
 * such a JSDoc slot instead of deriving `f64` from the tag
 * (`jsDocParamIsExternrefCandidate`).
 */
import { ts } from "../ts-api.js";
import { calleeNameIndex, siteOmitsArgument } from "./callee-name-index.js";

/**
 * JavaScript's optional-parameter spellings (`x?: T`, `@param {T=} x`, and
 * `@param {T} [x]`) all admit a call that supplies no value. This is especially
 * important for JSDoc declarations imported across a module boundary, where
 * local call-site inference cannot see the caller.
 *
 * (#7448) A plain JSDoc type (`@param {number} x`) does not fix the arity: the
 * checker accepts `h()` in a JavaScript file and `x` is then `undefined`, so
 * `x + 1` must be `NaN`, not the `1` a zero pad gives. A direct call in the
 * declaring file that omits the argument therefore makes it omittable too.
 * Functions only ever called with every argument keep their scalar slot.
 *
 * Initializers are deliberately excluded. Their existing parameter-default
 * sentinel path evaluates the initializer in the callee, so widening those
 * parameters would change a proven numeric default ABI for no semantic gain.
 */
export function parameterMayBeOmitted(param: ts.ParameterDeclaration): boolean {
  const jsdocType = ts.getJSDocType(param);
  return (
    param.initializer === undefined &&
    (param.questionToken !== undefined ||
      (jsdocType !== undefined && (ts.isJSDocOptionalType(jsdocType) || omittedByLocalCall(param))) ||
      ts.getJSDocParameterTags(param).some((tag) => tag.isBracketed === true))
  );
}

/**
 * Does a direct call to `param`'s function, in its own file, omit `param`? A
 * rest parameter is never omitted (it is an empty array). `new F()` is not
 * counted: a constructed function's body is compiled by the fnctor path, which
 * does not read this slot.
 */
function omittedByLocalCall(param: ts.ParameterDeclaration): boolean {
  const owner = param.parent;
  if (param.dotDotDotToken !== undefined || !ts.isFunctionDeclaration(owner) || owner.name === undefined) return false;
  const index = owner.parameters.indexOf(param);
  const sites = calleeNameIndex(param.getSourceFile()).get(owner.name.text) ?? [];
  return sites.some((site) => ts.isCallExpression(site) && siteOmitsArgument(site, index));
}
