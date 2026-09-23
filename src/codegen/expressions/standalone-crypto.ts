// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext, FunctionContext } from "../context/types.js";
import { emitThrowReferenceError } from "../js-errors.js";
import type { ValType } from "../../ir/types.js";

/**
 * Web Crypto on a host-free (`--target standalone`) module.
 *
 * `crypto` is a host-defined Web API, not an ECMAScript global, and a pure
 * standalone module has no secure randomness provider: it may not import one
 * (the no-host contract), and #4569 forbids substituting a pseudorandom source
 * for `getRandomValues` / `randomUUID`. So the standalone environment models
 * an engine without the global: evaluating `crypto.getRandomValues(buf)` or
 * `crypto.randomUUID()` throws the `ReferenceError` such an engine throws when
 * it resolves the `crypto` reference — before any argument is evaluated, and
 * before any byte could be returned.
 *
 * Previously both calls lowered to `env.__crypto_*` host imports even here,
 * which made every module that merely CONTAINED such a call (uuid's `rng`/`v4`)
 * un-instantiable host-free, whether or not the call ever ran.
 */
export function isHostFreeCryptoCall(ctx: CodegenContext, method: string): boolean {
  return ctx.targetProfile.environment === "none" && (method === "randomUUID" || method === "getRandomValues");
}

export function compileHostFreeCryptoCall(ctx: CodegenContext, fctx: FunctionContext): ValType {
  emitThrowReferenceError(ctx, fctx, "crypto is not defined (no secure randomness provider in a standalone module)");
  // Unreachable after the throw; satisfies the caller's externref contract.
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}
