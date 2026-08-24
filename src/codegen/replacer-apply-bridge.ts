// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4620) The OPAQUE-CALLABLE arm of §22.1.3.19 step 14 /
 * §22.2.6.11 step 14 — `Call(replaceValue, undefined, « … »)` when the
 * replacement value is a function the call site cannot resolve to an in-module
 * closure STRUCT.
 *
 * `regex-replace-fn.ts` (#4224) lowers a function replacer to a direct
 * `call_ref` on the closure struct it compiled. That requires the replacer
 * expression to compile to a `ref` with a registered `ClosureInfo`, which holds
 * for an inline function expression and for a function DECLARATION referenced
 * by name — and fails for every function VALUE that reaches the call site as an
 * opaque `externref`:
 *
 *     var g = function () { … };            "ab".replace("b", g)
 *     "ab".replace("b", (function () { … })())
 *
 * Before this module those shapes declined the function arm and then fell into
 * the naive native `__str_replace` arm in `string-ops.ts`, which compiles its
 * replacement operand straight into a `ref $AnyString` slot — so the closure
 * struct was `ref.cast` to a string and the module trapped with
 * `RuntimeError: illegal cast in __module_init` (test262
 * `language/function-code/10.4.3-1-102-s` / `-102gs`). A green compile and a
 * binary that cannot run: the wrong-answer shape #4224 set out to remove, still
 * reachable through the un-resolvable half of the same gate.
 *
 * The bridge used here is the one the standalone lane already owns for exactly
 * this question — "invoke this function value with N arguments and a receiver":
 * `__apply_closure(fn, recv, args)` (#1888), which reads the argument count off
 * the args carrier and dispatches to `__call_fn_method_N`. That dispatcher
 * installs `recv` in `__current_this` around the inner `call_ref`, so the
 * callee's own §10.4.3 `this` lowering keeps deciding the receiver.
 *
 * **The receiver is `ref.null.extern`, NOT the module's `undefined` singleton.**
 * §22.1.3.19 step 14 calls the replacer with `undefined`, and a sloppy callee
 * must then observe the GLOBAL OBJECT (§10.4.3) while a strict one observes
 * `undefined`. Only the callee knows which it is, and its lowering makes that
 * decision in its own `ref.is_null` fallback (`helpers/sloppy-this-global.ts`
 * — `thisReceiverIsGlobalObject`'s note is explicit that the non-null singleton
 * DEFEATS that fallback). Passing the singleton would hand a sloppy replacer
 * `undefined` where the spec says `globalThis`; passing null lets both arms
 * answer correctly. This matches the promise-handler call in
 * `async-scheduler.ts` (`__apply_closure(cb, undefined, [value])`).
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";

/** A staged opaque function value plus the bridge indices needed to call it. */
export interface OpaqueReplacer {
  /** externref local holding the replacer value. */
  valueLocal: number;
  applyIdx: number;
  vecNewIdx: number;
  vecPushIdx: number;
  /** externref local reused as the per-call argument carrier. */
  argsLocal: number;
}

/**
 * Stage a replacer value that compiled to something OTHER than a registered
 * closure struct, appending the `local.set` to `buffer` (which already holds
 * the value-producing instructions, per `stageReplacerClosure`'s off-body
 * contract).
 *
 * Returns `undefined` — decline, emit nothing further — when the value is not
 * reference-shaped (a number/string replacement is the sibling `ToString` arm's
 * business) or when the bridge is unavailable in this module. Declining is
 * safe: `buffer` is the caller's detached staging buffer, never `fctx.body`.
 */
export function stageOpaqueReplacer(
  ctx: CodegenContext,
  fctx: FunctionContext,
  compiled: ValType,
  buffer: Instr[],
): OpaqueReplacer | undefined {
  if (compiled.kind === "ref" || compiled.kind === "ref_null") {
    buffer.push({ op: "extern.convert_any" });
  } else if (compiled.kind !== "externref") {
    return undefined;
  }
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  if (newIdx === undefined || pushIdx === undefined || applyIdx === undefined) return undefined;
  const valueLocal = allocLocal(fctx, `__re_repl_any_${fctx.locals.length}`, { kind: "externref" });
  const argsLocal = allocLocal(fctx, `__re_repl_args_${fctx.locals.length}`, { kind: "externref" });
  buffer.push({ op: "local.set", index: valueLocal });
  return { valueLocal, applyIdx, vecNewIdx: newIdx, vecPushIdx: pushIdx, argsLocal };
}

/**
 * `Call(replaceValue, undefined, « argLocals »)` — leaves the result on the
 * stack as an `externref`, which the caller `ToString`s exactly as it does the
 * `call_ref` arm's result.
 *
 * A fresh args carrier is built per match: the replacer may retain it (an
 * `arguments`-style leak is observable), so reusing one carrier across matches
 * would alias the previous match's arguments.
 */
export function buildOpaqueReplacerCallInstrs(staged: OpaqueReplacer, argLocals: readonly number[]): Instr[] {
  const out: Instr[] = [
    { op: "call", funcIdx: staged.vecNewIdx },
    { op: "local.set", index: staged.argsLocal },
  ];
  for (const argLocal of argLocals) {
    out.push(
      { op: "local.get", index: staged.argsLocal },
      { op: "local.get", index: argLocal },
      { op: "call", funcIdx: staged.vecPushIdx },
    );
  }
  out.push(
    { op: "local.get", index: staged.valueLocal },
    // §22.1.3.19 step 14's `undefined` receiver — see the module header on why
    // this is a null externref rather than the `undefined` singleton.
    { op: "ref.null.extern" },
    { op: "local.get", index: staged.argsLocal },
    { op: "call", funcIdx: staged.applyIdx },
  );
  return out;
}
