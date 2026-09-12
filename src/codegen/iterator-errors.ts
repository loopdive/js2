// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { stringConstantExternrefInstrs as throwMsgExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";

/** (#3388) The §7.4.1 GetIterator TypeError message for a non-iterable subject. */
const NOT_ITERABLE_MSG = "value is not iterable";

/**
 * (#3388) Eagerly register the native `TypeError` constructor + the
 * "not iterable" message string global (both idempotent) so `__iterator`'s
 * non-iterable tail can throw a catchable `TypeError` instead of trapping.
 * Standalone/wasi only (host mode keeps the legacy loud trap — its `__iterator`
 * is a JS host import that already throws). Call from `ensureNativeIteratorRuntime`
 * BEFORE `buildIteratorBody`, so `nonIterableThrowInstrs` (below) only READS
 * already-registered symbols at both the eager and finalize build sites.
 */
export function ensureNonIterableThrowDeps(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  emitWasiErrorConstructor(ctx, "TypeError", 1); // idempotent (funcMap.has guard)
  addStringConstantGlobal(ctx, NOT_ITERABLE_MSG); // idempotent (keyed by value)
}

/**
 * (#3388) FRESH throw-`TypeError` instrs for the §7.4.1 non-iterable tail, or
 * `undefined` to keep the legacy trap (host mode, or the ctor/global was not
 * pre-registered). Builds a new instr array each call (never share — the DCE
 * in-place remap double-applies to an aliased object, #2169b). Reads only
 * pre-registered symbols, so it is safe at BOTH the eager and finalize
 * `buildIteratorBody` sites.
 */
export function nonIterableThrowInstrs(ctx: CodegenContext): Instr[] | undefined {
  if (!(ctx.standalone || ctx.wasi)) return undefined;
  const ctorIdx = ctx.funcMap.get("__new_TypeError");
  if (ctorIdx === undefined) return undefined;
  const tagIdx = ensureExnTag(ctx);
  return [...throwMsgExternrefInstrs(ctx, NOT_ITERABLE_MSG), { op: "call", funcIdx: ctorIdx }, { op: "throw", tagIdx }];
}
