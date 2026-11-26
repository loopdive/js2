// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext } from "../context/types.js";

/**
 * The function index of a helper the caller's emission depends on. These call sites used to emit nothing (or a
 * null / zero stand-in) when the helper was absent and carry on, which is a silent wrong answer on the no-host
 * lanes; every reachable program registers the helper first, so absence is a compiler bug and fails the compile
 * (plan/log/missing-helper-silent-emit-audit-2026-11-19.md).
 */
export function requireHelper(ctx: CodegenContext, name: string): number {
  const funcIdx = ctx.funcMap.get(name);
  if (funcIdx === undefined)
    throw new Error(`internal: helper "${name}" is not registered where its emission needs it`);
  return funcIdx;
}
