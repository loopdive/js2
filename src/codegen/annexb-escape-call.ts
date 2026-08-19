// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3064, relocated + fixed by #4556) Legacy `escape` (§B.2.1.1) / `unescape`
 * (§B.2.1.2) call lowering.
 *
 * Standalone / WASI route to the pure-Wasm `__escape` / `__unescape` helpers
 * (emitted in declarations.ts). ToString-coercion happens in codegen — the host
 * lane gets it from the JS builtins, but here there is no host, so we produce
 * the native string ref ourselves and hand it over as an externref. Host mode
 * has no `__escape` in funcMap, so the caller falls through to the generic
 * env-import path and its output stays byte-identical.
 */
import type { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { coerceType } from "./type-coercion.js";

/**
 * Compile `escape(x)` / `unescape(x)`, or return `undefined` to fall through.
 *
 * `compileExpr` / `compileStringLit` / `toString` are injected to avoid a
 * module cycle with the expression compiler.
 */
export function compileAnnexBEscapeCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  funcName: string,
  deps: {
    compileExpr: (e: ts.Expression) => ValType | null;
    compileStringLit: (text: string, node: ts.Node) => ValType | null;
    toString: (t: ValType | null, tsType: unknown, hint: "string") => ValType;
  },
): ValType | undefined {
  if (funcName !== "escape" && funcName !== "unescape") return undefined;
  const helperIdx = ctx.funcMap.get(funcName === "escape" ? "__escape" : "__unescape");
  if (helperIdx === undefined) return undefined;

  const arg0 = expr.arguments[0];
  if (arg0 === undefined) {
    // (#4556) Zero-arg `escape()` is spec-valid — step 1 is ToString over a
    // MISSING argument, i.e. ToString(undefined) = "undefined". The old
    // `arguments.length >= 1` gate at the call site dropped this spelling to
    // the generic env-import path, which standalone has no import for, so it
    // answered "" (annexB/built-ins/{escape,unescape}/argument_types.js).
    const u = deps.compileStringLit("undefined", expr);
    if (u && u.kind !== "externref") coerceType(ctx, fctx, u, { kind: "externref" });
    fctx.body.push({ op: "call", funcIdx: helperIdx });
    return { kind: "externref" };
  }

  const argTsType = ctx.checker.getTypeAtLocation(arg0);
  const argType = deps.compileExpr(arg0);
  const strType = deps.toString(argType, argTsType, "string");
  // `toString` returns a native `ref $AnyString` in native modes — the helper
  // wants an externref, so convert via `extern.convert_any`.
  if (strType.kind !== "externref") coerceType(ctx, fctx, strType, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: helperIdx });
  return { kind: "externref" };
}
