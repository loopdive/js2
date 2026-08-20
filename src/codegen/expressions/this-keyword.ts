// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The `ThisKeyword` lowering — extracted verbatim from `expressions.ts` (#4555).
 *
 * `this` resolution is a LADDER, and the order is the whole semantics: a
 * typed-this twin's receiver parameter, then a `this` in `localMap`, then a
 * static class context, then Script top-level code, then the host-installed
 * `__current_this` global, and only then §10.4.3's unbound answer. Each rung
 * carries the issue that put it there (#1395, #3365/#4190, #1636-S1/#1702,
 * #4203, #4157 B); the comments travel with the code.
 *
 * It lives here rather than in the `compileExpression` driver because it is a
 * self-contained subsystem — the driver's arm is now one delegating call.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { allocTempLocal, releaseTempLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { buildCurrentThisNonNullArm } from "../explicit-null-receiver.js"; // (#4203)
import {
  emitUnboundThis,
  thisBelongsToInlinedIifeBody,
  thisBelongsToTopLevelCode,
} from "../helpers/sloppy-this-global.js"; // (#4190, #4555)
import { emitCachedResolvedThis, recordResolvedThis } from "../receiver-cse.js"; // (#4157 B) receiver CSE
import { emitLazyClassObjectGet } from "./extern.js";
import { compileIdentifier } from "./identifiers.js";

export function compileThisKeyword(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Node): ValType | null {
  // (#4555) A non-arrow function expression spliced in by the inline-IIFE path
  // has no activation of its own, so every receiver rung below would hand it
  // the ENCLOSING function's `this`. It was invoked with no receiver, so
  // §10.4.3 applies: sloppy code binds the global object, strict binds
  // `undefined`. This must precede the binding rungs — inside a constructor
  // twin `localMap.get("this")` otherwise wins and yields the new instance.
  if (thisBelongsToInlinedIifeBody(fctx, expr)) {
    emitUnboundThis(ctx, fctx, expr);
    return { kind: "externref" };
  }
  // A typed-this twin receives its exact runtime receiver in param/local 0.
  // Reuse that value for bare/non-field `this` expressions too, rather than
  // round-tripping through the ambient `__current_this` global. This makes
  // the receiver parameter a complete representation of `this`, so direct
  // twin-to-twin calls do not need to install a dynamic receiver frame.
  if (
    process.env.JS2WASM_TWIN_RECEIVER_PARAM !== "0" &&
    fctx.typedThisLocalIdx !== undefined &&
    fctx.typedThisStructIdx !== undefined
  ) {
    fctx.body.push({ op: "local.get", index: fctx.typedThisLocalIdx });
    return { kind: "ref", typeIdx: fctx.typedThisStructIdx };
  }
  const selfIdx = fctx.localMap.get("this");
  if (selfIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: selfIdx });
    if (selfIdx < fctx.params.length) {
      return fctx.params[selfIdx]!.type;
    }
    const localDef = fctx.locals[selfIdx - fctx.params.length];
    return localDef?.type ?? { kind: "externref" };
  }
  // (#1395) Static-context fallback: in a static field initializer or
  // static method body (or in any closure spawned from one), `this`
  // refers to the class constructor object per ECMA-262 §15.7.1.1
  // step 5.b. We emit the lazy class-object singleton load — same
  // singleton used when the class identifier appears as a value, so
  // `C.f() === C` (when `static f = () => this`) holds. Note: the
  // lazy-load is invariant (a global), so no closure-capture wiring
  // is needed — the arrow's body re-emits the load and gets the
  // exact same externref each time.
  if (fctx.isStaticContext && fctx.enclosingClassName && ctx.classObjectGlobals?.has(fctx.enclosingClassName)) {
    if (emitLazyClassObjectGet(ctx, fctx, fctx.enclosingClassName)) {
      return { kind: "externref" };
    }
  }
  // (#3365) `__module_init` represents the source file's top-level code.
  // Script-goal top-level `this` is the global object even when the script
  // has a "use strict" directive; only Module goal has undefined top-level
  // `this`. The old generic no-binding fallback emitted undefined for both,
  // so `var global = this; global.Infinity = 42` threw a null-access payload
  // instead of the spec TypeError from writing the global's read-only prop.
  // (#4190) …but only for a `this` that lexically BELONGS to top-level code:
  // a top-level IIFE is inlined into `__module_init`, so its body's `this`
  // took this arm and became the global object even under `"use strict"`
  // (the `10.4.3-1-*gs` family). An inlined callee falls through instead.
  if (fctx.name === "__module_init" && !ctx.sourceIsModule && thisBelongsToTopLevelCode(expr)) {
    return compileIdentifier(ctx, fctx, ts.factory.createIdentifier("globalThis"));
  }
  // (#1636-S1) Host-dispatched-closure fallback: when no local `this`
  // binding exists and we're not in a static-class context, read the
  // host-supplied receiver from the `__current_this` module global —
  // but ONLY for closure bodies that can actually be dispatched through
  // `__call_fn_method_N` (`fctx.readsCurrentThis`). Those dispatchers
  // install the host receiver into `__current_this` before the inner
  // `call_ref`, so this is the only context in which the global holds a
  // meaningful value.
  //
  // The earlier (#1636-S1) version gated this on `ctx.currentThisGlobalIdx
  // >= 0` alone, but `ensureCurrentThisGlobal` is called eagerly for every
  // module that emits any closure, so that condition was true for the whole
  // module. Named function declarations / methods / constructors (compiled
  // via function-body.ts / class-bodies.ts, NOT through the closure-lift
  // path) are called directly via `call $f`, where `__current_this` is never
  // installed — they read its `ref.null.extern` initial value as `null`
  // instead of the spec-correct `undefined` (strict) / globalObject (sloppy).
  // That regressed 171 test262 cases (`function-code/10.4.3-1-*`,
  // `Array/prototype/*` callback `this`). Gating on `readsCurrentThis`
  // restricts the global read to exactly the lifted-closure / anonymous-
  // callback bodies that the host can dispatch, leaving direct-call `this`
  // to fall through to `undefined` as before.
  if (fctx.readsCurrentThis && ctx.currentThisGlobalIdx >= 0) {
    // (#1702) Null-guard the `__current_this` read. A lifted closure body can
    // be reached two ways:
    //   (a) host dispatch via `__call_fn_method_N` — installs a real receiver
    //       (a non-null externref) into `__current_this` before the call_ref;
    //   (b) a *direct* call (`f1()` where `f1` is a closure local / module
    //       global) — which never installs anything, so `__current_this` still
    //       holds its `ref.null.extern` initial value (or a leftover from an
    //       unrelated host dispatch that has since been restored to null).
    //
    // #1636-S1 / #895 narrowed this fallback to `readsCurrentThis` bodies, but
    // for the *direct-call* case the raw `global.get` surfaces JS `null`, not
    // the spec-correct `undefined`. That made strict free-function /
    // function-expression `this` observe `null` (`typeof this === "object"`,
    // `this === undefined` ⇒ false), regressing the residual
    // `language/function-code/10.4.3-1-*-s` + class-method strict-`this`
    // shapes (#873 follow-up).
    //
    // The receiver a host installs is always a non-null externref, so the
    // null/non-null distinction cleanly separates the two reach paths: when
    // the global is non-null use it (host dispatch), otherwise fall through to
    // `undefined` (direct call — `undefined` for strict, and the prior
    // pre-#1636-S1 fallback for sloppy free functions). This is additive to
    // #895's gating: it only changes the *value* the existing
    // `readsCurrentThis` branch yields when the global is null, never widening
    // which bodies read the global. The Array.prototype.{every,…} callbacks
    // and top-level strict `this` (#873/#895-fixed) are unaffected — those
    // either bind `this` via a local or do not set `readsCurrentThis`.
    // (#4157 B) the ladder below already ran in this sequence — reuse its slot.
    if (emitCachedResolvedThis(ctx, fctx, expr)) return { kind: "externref" };
    const thisTmp = allocTempLocal(fctx, { kind: "externref" });
    fctx.body.push({ op: "global.get", index: ctx.currentThisGlobalIdx });
    fctx.body.push({ op: "local.tee", index: thisTmp });
    fctx.body.push({ op: "ref.is_null" });
    // (#4203) A non-null global is normally just "the installed receiver" —
    // except for the marker meaning "the caller passed `null`", which a
    // strict callee must observe as `null`. See explicit-null-receiver.ts.
    const elseBody: Instr[] = buildCurrentThisNonNullArm(ctx, fctx, expr, thisTmp);
    const savedBody = fctx.body;
    const thenBody: Instr[] = [];
    fctx.body = thenBody;
    // (#4190) Null here means "direct call, no receiver installed" — ES5
    // §10.4.3 splits that on the callee's own strictness.
    emitUnboundThis(ctx, fctx, expr);
    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: thenBody,
      else: elseBody,
    });
    releaseTempLocal(fctx, thisTmp);
    recordResolvedThis(ctx, fctx, expr); // (#4157 B) cache for the rest of this sequence
    return { kind: "externref" };
  }
  // (#4190) Terminal fallback: no receiver binding of any kind. Sloppy code
  // binds the global object, strict binds `undefined` — both used to get
  // `undefined`, which is the whole `10.4.3-1-*` family.
  emitUnboundThis(ctx, fctx, expr);
  return { kind: "externref" };
}
