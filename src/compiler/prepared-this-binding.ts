// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ts } from "../ts-api.js";
import { functionLikeReferencesOwnThis } from "../codegen/helpers/body-references-own-this.js";
import { isStrictContext } from "../codegen/helpers/is-strict-function.js";

/**
 * (#7354 C) OrdinaryCallBindThis on the Prepared path: the strictness a function binds its own `this` with, or
 * `undefined` when its body never reads it. The compiler supplies it so that the IR source producer asks no codegen
 * helper itself.
 */
export function preparedFunctionThisStrictness(declaration: ts.FunctionDeclaration): boolean | undefined {
  return functionLikeReferencesOwnThis(declaration) ? isStrictContext(declaration) : undefined;
}
