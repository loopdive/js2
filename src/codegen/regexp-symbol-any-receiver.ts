// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B8) `r[Symbol.match](s)` (and `@@search` /
 * `@@replace` / `@@split`) whose receiver the checker cannot type, `--target
 * standalone`.
 *
 * ## The defect
 *
 * `tryCompileStandaloneRegExpSymbolCall` handles only receivers PROVEN to be a
 * RegExp (a `RegExp`-typed value or a backend-created binding). A receiver that
 * TypeScript types as `any` — every test262 row that writes `var r; r = /./g;`
 * and calls `r[Symbol.match]('')` inside a nested function — fell through to
 * the "does not support … symbol protocol calls" refusal. That refusal is then
 * absorbed by the statement's speculative-compile fallback, so the call site
 * compiles to NOTHING: `r[Symbol.match]('')` became `undefined` with no
 * diagnostic (measured on the base: the emitted body is `global.get
 * $__undefined; drop`). `@@match/g-match-empty-set-lastindex-err` expects a
 * TypeError from inside that call and saw no call at all.
 *
 * ## The lowering
 *
 * §13.3.6.1 EvaluateCall, run at RUNTIME:
 *
 * ```
 *   V := <receiver>                                   ; externref, once
 *   F := V is a `$NativeRegExp`
 *          ? RegExp.prototype[@@id]                   ; the reified method
 *          : __extern_get(V, @@id)                    ; ordinary [[Get]]
 *   args := «…arguments»                              ; AFTER the [[Get]]
 *   if (!IsCallable(F)) throw TypeError
 *   __apply_closure(F, V, args)
 * ```
 *
 * The `$NativeRegExp` arm does not go through `__extern_get` because that
 * runtime does not yet walk a RegExp carrier to `%RegExp.prototype%` (a
 * runtime-keyed `r.test` read on an `any` receiver answers `undefined`); the
 * reified method value is the identity-stable singleton every static spelling
 * already calls (B3's `emitRegExpSymbolProtocolApply`), so this is a route to
 * the ONE §22.2.6 body, not a second implementation. Known residual, shared
 * with `string-regexp-dynamic.ts`: an OWN `@@id` installed on a RegExp
 * instance is not consulted.
 *
 * ## Reach
 *
 * Only receivers whose oracle fact is `any` / `unknown` — exactly the set that
 * used to hit the refusal — so every call site that compiled before keeps its
 * bytes.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport } from "./expressions/late-imports.js";
import { buildThrowJsErrorInstrs, noJsHost } from "./js-errors.js";
import { getWellKnownSymbolId } from "./literals.js";
import { getBuiltinBrand } from "./native-proto.js";
import { resolveStandaloneProtoMemberValueClosure } from "./native-proto-value-read.js";
import { ensureObjVecBuilders, ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { compileExpression } from "./shared.js";
import { coerceType } from "./type-coercion.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** The four §22.2.6 methods whose generic body the reified closure carries. */
const ROUTED: ReadonlySet<string> = new Set(["match", "search", "replace", "split"]);

/**
 * Emit the runtime dispatch described in the module note, or return
 * `undefined` (nothing emitted) when the receiver is typed or a prerequisite is
 * missing — the caller then keeps its existing refusal.
 */
export function tryEmitAnyReceiverRegExpSymbolCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  regexExpr: ts.Expression,
  symbolMethod: string,
  /** Supplied by `regexp-standalone.ts` (which imports this leaf). */
  rx: { ensureGlue: () => boolean; regexpStruct: () => number },
): ValType | null | undefined {
  if (!noJsHost(ctx) || !ROUTED.has(symbolMethod)) return undefined;
  const fact = ctx.oracle.typeFactOf(regexExpr).kind;
  if (fact !== "any" && fact !== "unknown") return undefined;
  if (expr.arguments.some((a) => ts.isSpreadElement(a))) return undefined;
  const symbolId = getWellKnownSymbolId(symbolMethod);
  const brand = getBuiltinBrand(ctx, "RegExp");
  if (symbolId === undefined || brand === undefined || !rx.ensureGlue()) return undefined;
  const regexpStructIdx = rx.regexpStruct();
  const resolved = resolveStandaloneProtoMemberValueClosure(ctx, brand, "RegExp", `@@${symbolId}`);
  if (!resolved || resolved.kind !== "method") return undefined;

  // Register every native before any index is read (#2043 late-shift class);
  // indices are re-read BY NAME after the operands are compiled, which may
  // register more.
  ensureObjectRuntime(ctx);
  reserveApplyClosure(ctx);
  ensureObjVecBuilders(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__box_symbol", [I32], [EXTERNREF]);
  const idx = (name: string): number | undefined => ctx.funcMap.get(name);
  for (const name of ["__extern_get", "__box_symbol", "__typeof_function", "__objvec_new", "__objvec_push"]) {
    if (idx(name) === undefined) return undefined;
  }
  const vLocal = allocLocal(fctx, `__rsa_v_${fctx.locals.length}`, EXTERNREF);
  const fLocal = allocLocal(fctx, `__rsa_f_${fctx.locals.length}`, EXTERNREF);
  const argsLocal = allocLocal(fctx, `__rsa_args_${fctx.locals.length}`, EXTERNREF);

  const recvType = compileExpression(ctx, fctx, regexExpr, EXTERNREF);
  if (recvType === null) return null;
  if (recvType.kind !== "externref") coerceType(ctx, fctx, recvType, EXTERNREF);
  fctx.body.push({ op: "local.set", index: vLocal });

  // F — before the arguments (§13.3.6.1 step order).
  fctx.body.push(
    { op: "local.get", index: vLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: regexpStructIdx },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [...pushBuiltinFnSingletonValueInstrs(ctx, resolved.closure), { op: "extern.convert_any" }],
      else: [
        { op: "local.get", index: vLocal },
        { op: "i32.const", value: symbolId },
        { op: "call", funcIdx: idx("__box_symbol")! },
        { op: "call", funcIdx: idx("__extern_get")! },
      ],
    },
    { op: "local.set", index: fLocal },
  );

  fctx.body.push({ op: "call", funcIdx: idx("__objvec_new")! }, { op: "local.set", index: argsLocal });
  for (const arg of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    const argType = compileExpression(ctx, fctx, arg, EXTERNREF);
    if (argType === null) return null;
    if (argType.kind !== "externref") coerceType(ctx, fctx, argType, EXTERNREF);
    fctx.body.push({ op: "call", funcIdx: idx("__objvec_push")! });
  }

  // Built last: its own registration is flushed into the body emitted above.
  const typeError = buildThrowJsErrorInstrs(ctx, "TypeError", `Symbol.${symbolMethod} is not a function`, {
    flush: fctx,
  });
  fctx.body.push(
    { op: "local.get", index: fLocal },
    { op: "call", funcIdx: idx("__typeof_function")! },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: typeError, else: [] },
    { op: "local.get", index: fLocal },
    { op: "local.get", index: vLocal },
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: reserveApplyClosure(ctx) },
  );
  return EXTERNREF;
}
