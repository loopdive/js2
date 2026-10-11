// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../ir/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";

/** Produce the target-specific JavaScript `undefined` value used by apply padding. */
export function applyUndefinedInstrs(ctx: CodegenContext, getUndefinedIdx: number | undefined): Instr[] {
  return getUndefinedIdx !== undefined
    ? [{ op: "call", funcIdx: getUndefinedIdx }]
    : (undefinedExternInstrs(ctx)?.map((instr) => ({ ...instr })) ?? [{ op: "ref.null.extern" }]);
}

/** Compatibility path for the shared nullable apply carrier guard. */
export { guardNullableApplyArguments } from "../runtime/wasmgc/values/closure-apply-body.js";
