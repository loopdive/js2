// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Which formal parameters can a caller leave out? A native scalar slot cannot
 * represent the value such a parameter then holds: the generic missing-argument
 * pad for an `f64`/`i32`/`i64` is zero, while JavaScript observes `undefined`.
 * Proven from the AST alone, so every site that derives a function
 * declaration's parameter ABI asks the same question and gets the same answer:
 * legacy's `lowerParamType` and its nested-declaration lane, the
 * callable-property dispatch, and the IR selector, which must ask legacy for
 * such a JSDoc slot instead of deriving `f64` from the tag
 * (`jsDocParamIsExternrefCandidate`). The closure lane, which has no local
 * call-site scan, shares only the JSDoc spelling ({@link jsDocMarksParamOptional}).
 */
import { ts } from "../ts-api.js";
import { calleeNameIndex, siteOmitsArgument } from "./callee-name-index.js";

/**
 * JavaScript's optional-parameter spellings (`x?: T`, `@param {T=} x`, and
 * `@param {T} [x]`) all admit a call that supplies no value. This is especially
 * important for JSDoc declarations imported across a module boundary, where
 * local call-site inference cannot see the caller.
 *
 * (#7448) A plain JSDoc type (`@param {number} x`) does not fix the arity
 * either: see {@link checkerTypeIgnoresOmission}.
 *
 * Initializers are deliberately excluded. Their existing parameter-default
 * sentinel path evaluates the initializer in the callee, so widening those
 * parameters would change a proven numeric default ABI for no semantic gain.
 */
export function parameterMayBeOmitted(param: ts.ParameterDeclaration): boolean {
  return (
    param.initializer === undefined &&
    (param.questionToken !== undefined || jsDocMarksParamOptional(param) || checkerTypeIgnoresOmission(param))
  );
}

/**
 * The two JSDoc spellings of "optional" are independent: `@param {T=} x` puts
 * the optionality in the TYPE, while `@param {T} [x]` puts it in the TAG and
 * leaves the type a plain `T`.
 */
export function jsDocMarksParamOptional(param: ts.ParameterDeclaration): boolean {
  const jsdocType = ts.getJSDocType(param);
  return (
    (jsdocType !== undefined && ts.isJSDocOptionalType(jsdocType)) ||
    ts.getJSDocParameterTags(param).some((tag) => tag.isBracketed === true)
  );
}

/**
 * (#7448) Is `param` typed by a plain JSDoc tag that a call in its own file
 * contradicts by omitting the argument? The checker accepts `h()` against
 * `@param {number} x` in a JavaScript file and keeps typing `x` as `number`,
 * while `x` is then `undefined`: `x + 1` must be `NaN`, not the `1` a zero pad
 * gives, and `x === undefined` must not fold to `false`. So the slot is
 * widened (through {@link parameterMayBeOmitted}) and a read must not
 * re-narrow it to the checker's type. A JSDoc-optional spelling is excluded:
 * its checker type already admits `undefined`. Functions only ever called with
 * every argument keep their scalar slot.
 */
export function checkerTypeIgnoresOmission(param: ts.ParameterDeclaration): boolean {
  return (
    param.initializer === undefined &&
    ts.getJSDocType(param) !== undefined &&
    !jsDocMarksParamOptional(param) &&
    omittedByLocalCall(param)
  );
}

/**
 * Does a direct call to `param`'s function, in its own file, omit `param`? A
 * rest parameter is never omitted (it is an empty array). `new F()` is not
 * counted: a constructed function's body is compiled by the fnctor path, which
 * does not read this slot. Calls are matched by callee NAME, not symbol (the
 * IR selector asks this too and is checker-free), so a same-named function
 * elsewhere in the file can widen this one. That costs a scalar slot, never a
 * wrong value.
 */
function omittedByLocalCall(param: ts.ParameterDeclaration): boolean {
  const owner = param.parent;
  if (param.dotDotDotToken !== undefined || !ts.isFunctionDeclaration(owner) || owner.name === undefined) return false;
  const index = owner.parameters.indexOf(param);
  const sites = calleeNameIndex(param.getSourceFile()).get(owner.name.text) ?? [];
  return sites.some((site) => ts.isCallExpression(site) && siteOmitsArgument(site, index));
}
