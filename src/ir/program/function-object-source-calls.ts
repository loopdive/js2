// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 C) The function-object family of source calls: the `js.function.*` contracts (`function-object-callables.ts`).
 * A projection keeps its calls' target, site and region like every family's, and that is all they need:
 * `construct:N`'s arity is its target.
 */
import type { FunctionObjectRuntimeFeature } from "../runtime/contracts/manifest.js";
import { irFunctionObjectCallableDeclaration } from "../runtime/function-object-callables.js";
import type { SourceCallFamily } from "./native-source-calls.js";

export const FUNCTION_OBJECT_SOURCE_CALLS: SourceCallFamily<FunctionObjectRuntimeFeature> = Object.freeze({
  declaration: irFunctionObjectCallableDeclaration,
});
