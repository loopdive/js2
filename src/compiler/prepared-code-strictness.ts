// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O3) The code strictness the compiler hands the Prepared source producer (`IrProgramSourceInput`): the
 * answer the ordinary pipeline's `irFunctionCodeStrictness` gives (ECMA-262 §11.2.2), so both pipelines lower a
 * unit under one rule. A source file stands for its script or module code, and (#7471) any other node for the code
 * that encloses it.
 */
import type { ts } from "../ts-api.js";
import { isStrictContext } from "../shared/is-strict-function.js";

/** `inferModuleStrictArguments` is the compile option: whether a top-level `import`/`export` makes code strict. */
export function preparedCodeStrictness(inferModuleStrictArguments: boolean | undefined): (node: ts.Node) => boolean {
  return (node) => isStrictContext(node, inferModuleStrictArguments);
}
