// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7010) Loud refusal of a generator that only the eager host buffer could
 * lower. The #6781 abrupt-resumption report that used to live here was the
 * JS-host lane's; the regime refuses the whole generator instead
 * ({@link refuseEagerGeneratorBuffer}).
 */
import { ts } from "../ts-api.js";
import { reportError } from "./context/errors.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

/**
 * (#7010) The eager host-buffer lowering has no host-free implementation: it
 * needs `__gen_create_buffer` / `__create_generator` /
 * `__create_async_generator`, which no standalone, WASI, or native-regime
 * (`semanticProviders: "native-first"`) build can satisfy. Every generator that
 * neither the native #680 state machine nor the async-generator drive claims
 * used to fall to that buffer anyway — a silent host dependency the module
 * could never instantiate without a JS shim. It is now a compile error at the
 * generator. Returns `true` when it refused; the caller's arm is then done,
 * with a `ref.null.extern` in place of the generator object (the same stack
 * effect as the buffer epilogue) so the function body stays well-typed.
 */
export function refuseEagerGeneratorBuffer(ctx: CodegenContext, fctx: FunctionContext, decl: ts.Node): boolean {
  const isAsync =
    ts.canHaveModifiers(decl) && ts.getModifiers(decl)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  reportError(
    ctx,
    decl,
    `generator-no-host-free-lowering: this ${isAsync ? "async " : ""}generator has no host-free lowering yet ` +
      `(#7010). Neither the native generator state machine (#680) nor the ${isAsync ? "async-generator drive" : "nested-yield planner"} ` +
      "accepts its body shape, and the eager host buffer (__gen_*) is not available on standalone, WASI or " +
      "native-regime builds. Compile for the JS host, or keep each yield/await in a top-level statement of the body",
  );
  fctx.body.push({ op: "ref.null.extern" });
  return true;
}
