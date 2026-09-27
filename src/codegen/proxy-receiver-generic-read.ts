// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster F, slice F4) A receiver that PROVABLY evaluates to a Proxy
 * must not take a TARGET-shaped fast path.
 *
 * TypeScript types `new Proxy(t, h)` as `typeof t` — its lib signature is
 * `new <T extends object>(target: T, handler: ProxyHandler<T>): T`. So a proxy
 * over an array is statically `number[]` and a proxy over `new String("str")`
 * is statically `String`, and every arm of `compilePropertyAccess` /
 * `compileElementAccess` that keys off that static type lowers a read of the
 * TARGET's native representation against a `$Proxy` struct, which has none of
 * those fields.
 *
 * Measured on this slice's base (`86943b93`), standalone:
 *
 * | program                                  | base          | node |
 * | ---------------------------------------- | ------------- | ---- |
 * | `new Proxy([1,2,3],{}).length`           | `0`           | `3`  |
 * | `new Proxy([1,2,3],{})[0]`               | `NaN`         | `1`  |
 * | `new Proxy(new String("str"),{}).length` | **wasm trap** | `3`  |
 *
 * The third is the worst of them: "dereferencing a null pointer" kills the
 * whole module, not one assertion. All three are correct on the SAME tree
 * through the generic spelling — `p["length"]` answers 3 — because
 * `__extern_get` carries a `ref.test $Proxy` front-guard that enters the §10.5
 * dispatch. The runtime was never wrong; the dot and numeric-index spellings
 * simply never asked it.
 *
 * This is the F2/F3 defect shape — a static admission that follows the
 * SPELLING instead of the VALUE — and it is closed with the same predicate,
 * {@link tracesToProxyValue}, which F3 widened to accept an aliased or
 * foreign-realm `Proxy` constructor and which F4 widened again to accept a
 * helper's return value. Routing to `__extern_get` is conservative in the safe
 * direction: it is the ordinary property read for every non-proxy value too,
 * so a false positive would cost a fast path, never a wrong answer.
 *
 * Both helpers are gated on `ctx.standalone` by their callers' own check plus
 * the one here: on the host lane `__extern_get` is a JS import whose receiver
 * is the host's own proxy, which needs no compiler dispatch — and the gate is
 * what keeps every `gc` binary byte-identical across this slice.
 *
 * Kept OUT of `property-access.ts` so neither dispatcher crosses its function
 * budget; the call sites there are two lines each, which is the part that
 * genuinely cannot move (the decision has to be readable at the point the
 * target-shaped lowering is chosen).
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { coerceType, compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { tracesToProxyValue } from "./proxy-value-provenance.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

const EXTERNREF: ValType = { kind: "externref" };

/** `PA_DECLINE` — this receiver is not a provable proxy; keep the caller's lowering. */
export const PROXY_READ_DECLINE = Symbol("proxy-read-decline");

/**
 * `p.name` where `p` provably evaluates to a Proxy → `__extern_get(p, "name")`.
 * Returns {@link PROXY_READ_DECLINE} when the receiver is not a provable proxy,
 * `null` when the receiver failed to compile, else the result `ValType`.
 */
export function tryProxyReceiverPropertyRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | null | typeof PROXY_READ_DECLINE {
  if (!ctx.standalone || !tracesToProxyValue(ctx, expr.expression)) return PROXY_READ_DECLINE;
  const getIdx = ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  if (getIdx === undefined) return PROXY_READ_DECLINE;
  const recvType = compileExpression(ctx, fctx, expr.expression, EXTERNREF);
  if (!recvType) return null;
  if (recvType.kind !== "externref") coerceType(ctx, fctx, recvType, EXTERNREF);
  addStringConstantGlobal(ctx, propName);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
  fctx.body.push({ op: "call", funcIdx: getIdx });
  return EXTERNREF;
}

/**
 * The COMPUTED twin: `p[k]` → `__extern_get(p, ToPropertyKey-ish k)`.
 *
 * The key is boxed to externref by the ordinary coercion, which is what
 * `__extern_get`'s `$Proxy` front-guard forwards into §10.5's `[[Get]]`. The
 * string-literal spelling already reached this helper's callee and was already
 * right; this makes the numeric one agree (on base `new Proxy([1,2,3],{})[0]`
 * lowered to `array.get` on a `$Proxy` struct and answered NaN).
 */
export function tryProxyReceiverElementRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null | typeof PROXY_READ_DECLINE {
  if (!ctx.standalone || !tracesToProxyValue(ctx, expr.expression)) return PROXY_READ_DECLINE;
  const getIdx = ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  if (getIdx === undefined) return PROXY_READ_DECLINE;
  const recvType = compileExpression(ctx, fctx, expr.expression, EXTERNREF);
  if (!recvType) return null;
  if (recvType.kind !== "externref") coerceType(ctx, fctx, recvType, EXTERNREF);
  const keyType = compileExpression(ctx, fctx, expr.argumentExpression, EXTERNREF);
  if (!keyType) return null;
  if (keyType.kind !== "externref") coerceType(ctx, fctx, keyType, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: getIdx });
  return EXTERNREF;
}
