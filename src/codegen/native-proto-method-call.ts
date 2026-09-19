// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4619 family D) `__extern_method_call`'s missing `$NativeProto` receiver arm
 * — `Boolean.prototype.toString()`, `Number.prototype.toString()`.
 *
 * ## The asymmetry this closes
 *
 * #4248 gave `__extern_get` a `$NativeProto` arm, so
 * `var NP = Number.prototype; NP.toString` reads the identity-stable singleton.
 * `__extern_method_call` never grew the twin: its dispatch is
 * `ref.test $Object` → resolve-and-apply, ELSE the vec / closure-prop arms
 * (vec-props.ts). A `$NativeProto` is neither a `$Object` nor a vec nor a
 * closure carrier, so it fell to the terminal miss and every direct
 * `<Builtin>.prototype.<member>()` call reported
 * `TypeError: called value is not a function` — measured on base `2937ca57a`
 * for `Boolean.prototype.toString()` (test262 `S15.6.4.2_A1_T1`, `_A1_T2`) and
 * `Number.prototype.toString()` (`S15.7.4.2_A1_T01`).
 *
 * Proof it is only the receiver GUARD that was missing, not the machinery:
 * minting the closure by hand (`var _f = Boolean.prototype.toString;` in the
 * same module) did NOT change the error, while the identical call on a wrapper
 * `$Object` receiver — same closure, same `__extern_get`, same
 * `__apply_closure` — went from that error to the member's own refusal message.
 *
 * ## Absent-not-wrong
 *
 * The arm claims the call ONLY when the member RESOLVES to a non-null value.
 * A `$NativeProto` receiver whose member is genuinely absent falls through to
 * exactly the arms it reaches today, so the terminal §13.3.6.2 step-5 TypeError
 * still fires for `Number.prototype.nosuch()` and nothing that works today can
 * be displaced. `this` is bound to the prototype object itself, which is what
 * §21.1.3.6/§20.3.3.2 read: `Boolean.prototype` IS a Boolean object whose
 * [[BooleanData]] is `false`, so `Boolean.prototype.toString()` is `"false"`.
 *
 * `$isClass` is deliberately NOT filtered here (unlike #4248's read arm, whose
 * per-brand ladder is meaningless for a user-class façade proto): this arm has
 * no per-brand table at all — it delegates the whole resolution to
 * `__extern_get`, which applies its own `$isClass` gate — so filtering here
 * would only remove a call that the read already declines.
 *
 * ## Why FINALIZE, and not inside `ensureObjectRuntime`
 *
 * The first cut spliced this into `__extern_method_call`'s `else` branch at
 * body-build time and was DEAD CODE, silently: `$NativeProto` registers lazily,
 * the first time a builtin prototype is materialized, which is strictly AFTER
 * the object runtime is built. A trace printed `protoTypeIdx=undefined` for
 * exactly the probe the arm was written for. Worth recording because the arm
 * still "worked" in one probe shape and the win would have been mis-attributed.
 *
 * Unshifting at finalize — the same place and the same shape as #4248's
 * `unshiftExternGetProtoMethodArm` — makes the type available AND keeps the
 * cost at zero for a module that never materializes a builtin prototype (no
 * `$NativeProto` type ⇒ no arm, no local, byte-identical module).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/**
 * Prepend the `$NativeProto`-receiver arm onto `__extern_method_call`.
 *
 * No-op outside standalone, when the module has no `$NativeProto` type, or when
 * either delegate native is absent — in each case nothing can reach the arm, so
 * emitting it would only add dead bytes.
 *
 * ABI of the host function: param 0 = receiver externref, 1 = key externref,
 * 2 = args `$ObjVec` (as externref).
 */
export function unshiftExternMethodCallProtoArm(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const protoTypeIdx = ctx.nativeProtoTypeIdx;
  if (protoTypeIdx === undefined) return;
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  if (externGetIdx === undefined || applyClosureIdx === undefined) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_method_call");
  if (!fn) return;

  const methodLocal = 3 + fn.locals.length;
  const newLocals: { name: string; type: ValType }[] = [{ name: "npmc", type: { kind: "externref" } }];
  const nullishToNullIdx = ctx.funcMap.get("__nullish_to_null");

  // A `block` + `br_if` ladder rather than nested `if`s: the arm must fall
  // THROUGH to the untouched body on every decline, and `br_if 0` out of the
  // block is the one shape that leaves the stack empty on the way out.
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: protoTypeIdx },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: externGetIdx },
    // (#2106 S1) the undefined singleton normalises to null, so the
    // "did it resolve?" test below is a single `ref.is_null`.
    ...(nullishToNullIdx === undefined ? [] : ([{ op: "call", funcIdx: nullishToNullIdx }] satisfies Instr[])),
    { op: "local.tee", index: methodLocal },
    { op: "ref.is_null" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: methodLocal },
    { op: "local.get", index: 0 }, // `this` = the prototype object
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: applyClosureIdx },
    { op: "return" },
  ];

  fn.locals.push(...newLocals);
  fn.body.unshift({ op: "block", blockType: { kind: "empty" }, body });
}
