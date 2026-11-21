// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 Fa, F1b) Whether a script binding holds the value its declaration gives it for the whole program: the one
 * proof behind a static function value (Fa's `staticFunctionValue`) and a declaration's immutable value home.
 */
import type { ts } from "../ts-api.js";
import { bindingIsUniqueAndNeverWritten } from "./binding-writes.js";
import { globalObjectWriteRoutes } from "./intrinsic-prototype-writes.js";

/**
 * The declaration is the name's only binding site in its file and no identifier of that name is assigned, with no
 * `eval` or `with` (`bindingIsUniqueAndNeverWritten`). Any other write of a script binding is a write of a
 * global-object property, and the global object is reached only through `this`, a global-object name, a reflective
 * route or code the source does not spell (a builtin is strict, so it never substitutes it for an `undefined`
 * receiver). So no such code may run and no reflective route may be named (`x.constructor` reaches `Function`, also
 * under a computed key a string literal spells); the global object must not escape into a value (`Object.assign`,
 * `defineProperties` and the like write a binding through it without spelling a member write of its name); and no
 * member of the binding's name may be written on `this` or a global-object name. A member store of the same name on
 * another object (`assert.f = v`) writes no binding then.
 */
export function bindingHoldsItsDeclaration(name: ts.Identifier, declaration: ts.Declaration): boolean {
  const routes = globalObjectWriteRoutes(declaration.getSourceFile());
  return (
    bindingIsUniqueAndNeverWritten(name, declaration) &&
    !routes.dynamicCode &&
    !routes.reflective &&
    !routes.escapes &&
    !routes.writtenNames.has(name.text)
  );
}
