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
import type { TypeFact } from "../checker/oracle.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import { ensureSymbolCarrier } from "./symbol-native.js";
import { flushLateImportShifts } from "./shared.js";
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
    toString: (t: ValType | null, staticType: TypeFact, hint: "string") => ValType;
  },
): ValType | undefined {
  if ((funcName !== "escape" && funcName !== "unescape") || (!ctx.standalone && !ctx.wasi)) return undefined;
  const helperName = funcName === "escape" ? "__escape" : "__unescape";
  if (ctx.funcMap.get(helperName) === undefined) return undefined;

  const arg0 = expr.arguments[0];
  if (arg0 === undefined) {
    // (#4556) Zero-arg `escape()` is spec-valid — step 1 is ToString over a
    // MISSING argument, i.e. ToString(undefined) = "undefined". The old
    // `arguments.length >= 1` gate at the call site dropped this spelling to
    // the generic env-import path, which standalone has no import for, so it
    // answered "" (annexB/built-ins/{escape,unescape}/argument_types.js).
    const u = deps.compileStringLit("undefined", expr);
    if (u && u.kind !== "externref") coerceType(ctx, fctx, u, { kind: "externref" });
    flushLateImportShifts(ctx, fctx);
    const nativeIdx = ctx.funcMap.get(helperName);
    if (nativeIdx === undefined) return undefined;
    fctx.body.push({ op: "call", funcIdx: nativeIdx });
    return { kind: "externref" };
  }

  // A dynamic-any operand can carry a Symbol even when the checker cannot
  // prove it. Register the native carrier before any function index is baked.
  const symbolTypeIdx = ensureSymbolCarrier(ctx);
  const argFact = ctx.oracle.typeFactOf(arg0);
  const argType = deps.compileExpr(arg0);
  let argLocal: number | undefined;
  if (argType !== null) {
    argLocal = allocLocal(fctx, `__annexb_arg0_${fctx.locals.length}`, argType);
    fctx.body.push({ op: "local.set", index: argLocal });
  }
  flushLateImportShifts(ctx, fctx);

  // Annex B's native helpers ignore parameters after the first one, but
  // ArgumentListEvaluation does not. Evaluate each extra exactly once and
  // discard its value only after its expression has completed.
  for (const extra of expr.arguments.slice(1)) {
    const extraType = deps.compileExpr(extra);
    if (extraType !== null) fctx.body.push({ op: "drop" });
    flushLateImportShifts(ctx, fctx);
  }

  // `emitToString` deliberately declines a scalar number when its native
  // formatter has not been requested yet. Direct escape(65)/unescape(65) can
  // be the first numeric stringification in a module, so register that shared
  // formatter before the strict coercion.
  if (
    argType !== null &&
    (argType.kind === "f64" || argType.kind === "i64" || (argType.kind === "i32" && argType.boolean !== true)) &&
    !ctx.funcMap.has("number_toString")
  ) {
    emitNativeNumberFormat(ctx, new Set(["number_toString"]));
    flushLateImportShifts(ctx, fctx);
  }

  if (argLocal !== undefined && argType !== null) {
    const carrierLocal = allocLocal(fctx, `__annexb_carrier_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.get", index: argLocal });
    const carrierSource =
      argType.kind === "i32" && argFact.kind === "symbol" ? { ...argType, symbol: true as const } : argType;
    if (carrierSource.kind !== "externref" && carrierSource.kind !== "ref_extern") {
      coerceType(ctx, fctx, carrierSource, { kind: "externref" });
    }
    fctx.body.push({ op: "local.set", index: carrierLocal });

    const throwInstrs = buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert a Symbol value to a string", {
      flush: fctx,
    });
    fctx.body.push(
      { op: "local.get", index: carrierLocal },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: symbolTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: throwInstrs },
      { op: "local.get", index: argLocal },
    );
    const strType = deps.toString(argType, argFact, "string");
    if (strType.kind !== "externref") coerceType(ctx, fctx, strType, { kind: "externref" });
  } else {
    const strType = deps.compileStringLit("undefined", expr);
    if (strType && strType.kind !== "externref") coerceType(ctx, fctx, strType, { kind: "externref" });
  }

  // Guard/coercion registration can append helpers. Resolve the native index
  // only after all of those late-import shifts have been flushed.
  flushLateImportShifts(ctx, fctx);
  const nativeIdx = ctx.funcMap.get(helperName);
  if (nativeIdx === undefined) return undefined;
  fctx.body.push({ op: "call", funcIdx: nativeIdx });
  return { kind: "externref" };
}
