// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// host-intl-locale.ts (#6986) — the locale-sensitive builtin methods under the
// `intl` host accelerator.
//
// ECMA-402 defines `Number.prototype.toLocaleString`, the three
// `Date.prototype.toLocale*String` methods, `BigInt.prototype.toLocaleString`
// and `String.prototype.localeCompare` in terms of `Intl`. The native regime
// implements them without locale data (ECMA-262's implementation-defined
// fallback: `(1234.5).toLocaleString("de-DE")` is "1234.5"). When the `intl`
// accelerator is selected the caller has asked for the host's Intl, so these
// calls go to the host method too: `__intl_<method>(receiver, a, b, c)`. The
// runtime (`src/runtime/intl-host-accelerator.ts`) converts the receiver and
// arguments through the JS value boundary — a compiled Date as its host Date
// view, an options bag as its host view — and the result back.
//
// Statically typed receivers only (number, bigint, Date, string), at most three
// arguments, no spread, and only while the source never writes the method onto
// a prototype; everything else keeps the native lowering.

import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import { hasHostAccelerator } from "../../target-profile.js";
import { type CodegenContext, type FunctionContext, jsValueBoundary } from "../context/types.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { INTL_CLASS_NAMES, isGlobalIntl } from "./host-intl-classes.js";
import { hostStringBridgeUsable } from "../native-strings.js";
import { coerceType, compileExpression, ensureLateImport, flushLateImportShifts } from "../shared.js";

/** method → the receiver kinds (oracle fact kind, or builtin name) it is routed for. */
const LOCALE_METHODS: ReadonlyMap<string, readonly string[]> = new Map([
  ["toLocaleString", ["number", "bigint", "Date"]],
  ["toLocaleDateString", ["Date"]],
  ["toLocaleTimeString", ["Date"]],
  ["localeCompare", ["string"]],
]);

/** `Intl` namespace functions routed as `__intl_static_<fn>`. */
const INTL_NAMESPACE_FUNCTIONS = new Set(["getCanonicalLocales", "supportedValuesOf"]);

/** Import-name prefix of the routed methods (classified as the `intl` accelerator). */
const INTL_LOCALE_IMPORT_PREFIX = "__intl_";

const EXTERNREF: ValType = { kind: "externref" };

function receiverKind(ctx: CodegenContext, receiver: ts.Expression): string {
  const fact = ctx.oracle.typeFactOf(receiver);
  return fact.kind === "builtin" ? fact.name : fact.kind;
}

/** The `intl` accelerator on the regime's JS boundary (the only place these routes apply). */
function intlAccelerated(ctx: CodegenContext): boolean {
  return ctx.standalone && hasHostAccelerator(ctx.targetProfile, "intl") && hostStringBridgeUsable(ctx);
}

/**
 * `Intl.getCanonicalLocales(..)` / `Intl.supportedValuesOf(..)` /
 * `Intl.<Class>.supportedLocalesOf(..)` on the global `Intl`: the import-name
 * suffix (`static_<fn>` / `static_<Class>_<fn>`), or undefined.
 */
function intlStaticCallSuffix(ctx: CodegenContext, callee: ts.PropertyAccessExpression): string | undefined {
  const fn = callee.name.text;
  const target = callee.expression;
  if (ts.isIdentifier(target)) {
    return INTL_NAMESPACE_FUNCTIONS.has(fn) && target.text === "Intl" && isGlobalIntl(ctx, target)
      ? `static_${fn}`
      : undefined;
  }
  if (fn !== "supportedLocalesOf" || !ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.expression)) {
    return undefined;
  }
  const cls = target.name.text;
  return INTL_CLASS_NAMES.has(cls) && target.expression.text === "Intl" && isGlobalIntl(ctx, target.expression)
    ? `static_${cls}_${fn}`
    : undefined;
}

/**
 * Native regime + `intl` accelerator: emit `__intl_<method>(receiver, ...args)`
 * for a locale-sensitive builtin method call, or `__intl_static_*(...args)` for
 * an `Intl` namespace/static function, and return the result type. Returns
 * undefined, emitting nothing, when the native lowering applies.
 */
export function tryCompileIntlLocaleMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | undefined {
  if (!intlAccelerated(ctx)) return undefined;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return undefined;
  if (expr.arguments.length > 3 || expr.arguments.some(ts.isSpreadElement)) return undefined;
  const method = callee.name.text;
  const staticSuffix = intlStaticCallSuffix(ctx, callee);
  if (staticSuffix !== undefined) {
    return emitIntlHostCall(ctx, fctx, `${INTL_LOCALE_IMPORT_PREFIX}${staticSuffix}`, [...expr.arguments], 3);
  }
  const kinds = LOCALE_METHODS.get(method);
  if (kinds === undefined || ctx.protoNamedWrittenMembers.has(method)) return undefined;
  if (!kinds.includes(receiverKind(ctx, callee.expression))) return undefined;
  const name = `${INTL_LOCALE_IMPORT_PREFIX}${method}`;
  const result = emitIntlHostCall(ctx, fctx, name, [callee.expression, ...expr.arguments], 4);
  if (result === undefined || method !== "localeCompare") return result;
  coerceType(ctx, fctx, EXTERNREF, { kind: "f64" });
  return { kind: "f64" };
}

/** `call name(operands..., null padding)` with `arity` externref parameters and an externref result. */
function emitIntlHostCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  operands: readonly ts.Expression[],
  arity: number,
): ValType | undefined {
  if (ensureLateImport(ctx, name, new Array<ValType>(arity).fill(EXTERNREF), [EXTERNREF]) === undefined) {
    return undefined;
  }
  flushLateImportShifts(ctx, fctx);
  for (const operand of operands) {
    const type = compileExpression(ctx, fctx, operand);
    if (type === null) fctx.body.push({ op: "ref.null.extern" });
    else coerceType(ctx, fctx, type, EXTERNREF);
  }
  for (let i = operands.length; i < arity; i++) fctx.body.push({ op: "ref.null.extern" });
  // Re-read by name: compiling the operands may have added (and shifted) imports.
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(name)! });
  return EXTERNREF;
}

/**
 * `intl` accelerator: push the host's global `Intl` (`env.global_Intl`, a
 * declared-global import the runtime admits at the value boundary, so member
 * reads go through the boundary object MOP) for an unshadowed, ambient `Intl`
 * identifier. Returns false, emitting nothing, otherwise.
 */
export function emitHostIntlGlobal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  ambient: boolean,
): boolean {
  if (name !== "Intl" || !ambient || fctx.localMap.has(name) || !intlAccelerated(ctx)) return false;
  if (ensureLateImport(ctx, "global_Intl", [], [EXTERNREF]) === undefined) return false;
  flushLateImportShifts(ctx, fctx);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("global_Intl")! });
  return true;
}

/**
 * (#6986) The `intl` accelerator marshals Intl arguments and results through the
 * runtime's dynamic boundary, which reads the carrier exports
 * (`ensureDynamicBridge`: `__unbox_number`, `__box_number`, …) and copies host
 * arrays into the object runtime's exported native vector. Prepared once per
 * file that calls into the host Intl.
 */
export function prepareIntlAcceleratorBoundary(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  ensureDynamicBridge: (ctx: CodegenContext) => void,
): void {
  if (!ctx.nativeStrings || !jsValueBoundary(ctx) || !hasHostAccelerator(ctx.targetProfile, "intl")) return;
  if (!/\bIntl\b|\btoLocale\w*String\b|\blocaleCompare\b/.test(sourceFile.text)) return;
  ensureDynamicBridge(ctx);
  ensureObjectRuntime(ctx);
}
