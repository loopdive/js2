// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6978) Which lane parses a Date string: the JS host's `Date.parse`
 * (`env.__date_parse_host`) or the native ISO parser (`__date_parse`).
 *
 * The host-assisted lane has always delegated to the host (#2678): its strings
 * are `wasm:js-string` externrefs and host `Date.parse` accepts more formats
 * than the native parser (RFC 2822 offsets, for instance). The native regime
 * uses the native parser unless the `date` host accelerator is selected; then
 * a string argument is marshalled to a JS string through the native-string
 * bridge and parsed by the host.
 */
import { hasHostAccelerator } from "../../target-profile.js";
import type { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { coerceType, compileExpression } from "../shared.js";
import { hostStringBridgeUsable } from "../native-strings.js";
import { emitNativeStringToHostExternref } from "../string-ops.js";

/** The `date` accelerator under the native regime (needs the string bridge). */
function hostDateAccelerated(ctx: CodegenContext): boolean {
  return ctx.standalone && hasHostAccelerator(ctx.targetProfile, "date") && hostStringBridgeUsable(ctx);
}

/** Whether Date string parsing may use the host import in this module. */
export function hostDateParseLane(ctx: CodegenContext): boolean {
  return (!ctx.standalone && !ctx.wasi) || hostDateAccelerated(ctx);
}

/**
 * Compile a string-typed `arg` under the accelerated regime and leave a JS
 * string externref for `__date_parse_host`: the native string is marshalled
 * through the string bridge. A non-string compile result (unreachable for a
 * string-typed argument) is converted by the regime's own externref coercion.
 */
function emitHostDateParseArg(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  const argType = compileExpression(ctx, fctx, arg);
  if (argType !== null && (argType.kind === "ref" || argType.kind === "ref_null")) {
    if (emitNativeStringToHostExternref(ctx, fctx)) return;
  }
  if (argType === null) fctx.body.push({ op: "ref.null.extern" });
  else coerceType(ctx, fctx, argType, { kind: "externref" });
}

/**
 * Native regime + `date` accelerator: emit `__date_parse_host(args[0])` for a
 * string argument (extra arguments are evaluated and dropped) and return true.
 * Returns false, emitting nothing, whenever the native parser must be used.
 */
export function emitAcceleratedDateParse(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  stringTyped: boolean,
): boolean {
  const hostIdx = hostDateAccelerated(ctx) ? ctx.funcMap.get("__date_parse_host") : undefined;
  if (hostIdx === undefined || args.length === 0 || !stringTyped) return false;
  emitHostDateParseArg(ctx, fctx, args[0]!);
  for (let i = 1; i < args.length; i++) {
    if (compileExpression(ctx, fctx, args[i]!)) fctx.body.push({ op: "drop" });
  }
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__date_parse_host") ?? hostIdx });
  return true;
}
