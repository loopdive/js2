// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2623 Slice B) Promise-subclass identity unification.
 *
 * A Wasm-compiled `class MyPromise extends Promise` is externref-backed
 * (#1366a/b): its instances are real host Promises (built via `__new_Promise`),
 * and it has **no** `__class_<Name>` class-object singleton global (skipped in
 * `class-bodies.ts` for builtin-parent classes — there is no `$ClassName`
 * WasmGC struct to anchor). Two distinct code paths previously materialized a
 * `class extends Promise` constructor:
 *
 *   1. The combinator capability path (`Promise.all.call(Sub, …)`) — routes the
 *      `thisArg` receiver through the `__promise_subclass_ctor` host import
 *      (`resolvePromiseSubclassThisArg`), which synthesizes and CACHES one real
 *      JS `class extends Promise {}` per class name. V8's NewPromiseCapability
 *      then builds the instance from THAT constructor, so the resulting
 *      promise's `.constructor` / `[[Prototype]]` point at the synthesized ctor.
 *
 *   2. The bare identifier read-as-value (`Sub` on the RHS of `=== Sub`,
 *      `instanceof Sub`, `Promise.try.call(Sub, …)`, etc.) — fell through to the
 *      `ref.null.extern` graceful-default in `identifiers.ts`, yielding `null`.
 *
 * Result: the constructor the user OBSERVES (path 2 → null/opaque) was a
 * DIFFERENT object than the one used to BUILD the subclassed promise (path 1 →
 * synthesized cached ctor), so `instance.constructor === Sub` and
 * `instance instanceof Sub` were always false (test262
 * `Promise/{all,race,allSettled,any}/ctx-ctor.js` assert #1/#2,
 * `Promise/try/{promise,ctx-ctor}.js`).
 *
 * The fix unifies the two paths onto the SAME cached `__promise_subclass_ctor`
 * singleton: the value-read now emits the same host-synthesized ctor the
 * capability path uses, so there is exactly one object per `class extends
 * Promise` name. Both helpers below share one detection + emission core so the
 * value position and the receiver position can never diverge again.
 */
import { ts } from "../../ts-api.js";
import type { Instr } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { addStringConstantGlobal } from "../index.js";
import { isStandalonePromiseActive } from "../async-scheduler.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { compileStringLiteral } from "../string-ops.js";
import { classMemberFuncKey } from "../class-member-keys.js"; // (#2637 B2.1) onhost-ctor funcMap key
import { emitFuncRefAsClosure } from "../closures.js"; // (#2637 B2.1) materialize $Class_new__onhost as a no-capture closure

/**
 * Returns the resolved class name if `name` (a user-visible identifier or
 * class-expression alias) denotes a `class … extends Promise` (transitively,
 * through a chain of user subclasses), else `undefined`.
 *
 * Walks the parent chain because `classBuiltinParentMap` only records the
 * *immediate* builtin parent: for `class B extends A` / `class A extends
 * Promise`, B maps to "A", not "Promise". `classParentMap` carries the
 * user-class edges, so we climb until we hit a builtin Promise parent.
 *
 * Recognition is target-independent. Whether a target may materialize the
 * legacy host constructor is a separate decision made by the emit helpers
 * below. Keeping those concerns separate is important: native-first dispatch
 * still needs to know that `P.resolve` names an inherited Promise static, even
 * though it must never synthesize `P` through `__promise_subclass_ctor`.
 */
export function resolvePromiseSubclassName(ctx: CodegenContext, name: string): string | undefined {
  const resolved = ctx.classExprNameMap.get(name) ?? name;
  let cursor: string | undefined = resolved;
  const seen = new Set<string>();
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    if (ctx.classBuiltinParentMap.get(cursor) === "Promise") return resolved;
    cursor = ctx.classParentMap.get(cursor);
  }
  return undefined;
}

/**
 * Emits an externref that is the cached `__promise_subclass_ctor` for the given
 * resolved class name (one synthesized `class extends Promise {}` per name).
 * `resolved` MUST be the name returned by {@link resolvePromiseSubclassName}
 * (i.e. already alias-resolved through `classExprNameMap`).
 *
 * Returns true on success (instruction(s) pushed), false if the import could
 * not be registered (caller should fall back to its default emission).
 */
export function emitPromiseSubclassCtor(ctx: CodegenContext, fctx: FunctionContext, resolved: string): boolean {
  // (#2637 B2.1) If this class declared a user constructor, register its
  // run-on-host body (`$<Class>_new__onhost`) with the runtime FIRST, so that
  // when V8's `NewPromiseCapability(C)` performs `new C(internalExecutor)` the
  // synthesized JS ctor (in `__promise_subclass_ctor`) finds and runs the body
  // on the capability promise. Emitting here — at the single chokepoint every
  // combinator / value-read path funnels through — guarantees the registration
  // executes before the `__promise_subclass_ctor` call below at runtime, with
  // no module-init plumbing. Idempotent (once per class per compile; the
  // runtime Map.set is idempotent too).
  emitRegisterPromiseSubclassCtor(ctx, fctx, resolved);

  const importName = "__promise_subclass_ctor";
  let funcIdx =
    ctx.funcMap.get(importName) ?? ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  funcIdx = ctx.funcMap.get(importName) ?? funcIdx;
  if (funcIdx === undefined) return false;
  // Push the class name (the synthesized subclass is cached per name). Use the
  // same host-string mechanism as extern method dispatch so it works in both
  // string backends.
  addStringConstantGlobal(ctx, resolved);
  const nameIdx = ctx.stringGlobalMap.get(resolved);
  // (#2515 S0) `>= 0`, not `!== undefined`: standalone/nativeStrings stores the
  // `-1` sentinel, which would bake `global.get -1` and fail binary emit. Fall
  // to the inline-materializing `compileStringLiteral` for the sentinel.
  if (nameIdx !== undefined && nameIdx >= 0) {
    fctx.body.push({ op: "global.get", index: nameIdx });
  } else {
    compileStringLiteral(ctx, fctx, resolved);
  }
  fctx.body.push({ op: "call", funcIdx });
  return true;
}

/**
 * (#2637 B2.1) Emit a `__register_promise_subclass_ctor(<name>, <closure>)`
 * call for `resolved`, where `<closure>` is a no-capture closure materializing
 * the pre-registered `$<resolved>_new__onhost` body (the run-on-host-`this`
 * constructor, B2.3). No-op when the class has no `__onhost` body — i.e. a
 * default-constructor subclass (no user ctor): the runtime's bare forwarder is
 * correct there and there is nothing to run (the #1977 identity-only row).
 *
 * Emitted at EVERY combinator / value-read site (not deduped per compile),
 * because whichever site executes first at runtime must perform the
 * registration before `__promise_subclass_ctor` synthesizes / uses `C`. The
 * runtime `Map.set` is idempotent, so repeated registrations are harmless; the
 * wrapper STRUCT type is shared per-signature via `getOrCreateFuncRefWrapperTypes`
 * so only a thin per-site trampoline duplicates.
 *
 * Late-import discipline: `ensureLateImport` for the registration import is
 * flushed BEFORE the closure's `ref.func`/`struct.new` are emitted, so the
 * trampoline funcidx baked by `emitFuncRefAsClosure` cannot be left stale by
 * the import shift (cf. project_standalone_hostimport_gate_index_shift).
 */
function emitRegisterPromiseSubclassCtor(ctx: CodegenContext, fctx: FunctionContext, resolved: string): void {
  const onHostKey = classMemberFuncKey(ctx, `${resolved}_new__onhost`);
  const onHostFuncIdx = ctx.funcMap.get(onHostKey);
  if (onHostFuncIdx === undefined) return; // default-ctor subclass — nothing to register

  const registerName = "__register_promise_subclass_ctor";
  ensureLateImport(ctx, registerName, [{ kind: "externref" }, { kind: "externref" }], []);
  flushLateImportShifts(ctx, fctx);
  const registerIdx = ctx.funcMap.get(registerName);
  if (registerIdx === undefined) return;

  // arg 0 — the class name (same host-string mechanism as the ctor call below).
  addStringConstantGlobal(ctx, resolved);
  const nameIdx = ctx.stringGlobalMap.get(resolved);
  if (nameIdx !== undefined && nameIdx >= 0) {
    fctx.body.push({ op: "global.get", index: nameIdx });
  } else {
    compileStringLiteral(ctx, fctx, resolved);
  }

  // arg 1 — a no-capture closure over `$<resolved>_new__onhost`. Re-resolve the
  // funcidx AFTER the flush above (it may have shifted). `emitFuncRefAsClosure`
  // pushes a `(ref $wrapperStruct)`; the import expects externref, so lift it
  // with `extern.convert_any`.
  const onHostIdxNow = ctx.funcMap.get(onHostKey) ?? onHostFuncIdx;
  const closureType = emitFuncRefAsClosure(ctx, fctx, onHostKey, onHostIdxNow);
  if (closureType === null) {
    // Could not materialize (defensive) — drop the name we already pushed and
    // bail so the stack stays balanced.
    fctx.body.push({ op: "drop" });
    return;
  }
  fctx.body.push({ op: "extern.convert_any" });

  // Re-resolve the register import idx as well (emitFuncRefAsClosure adds a
  // defined function but no import, so no shift — still, be defensive).
  const registerIdxNow = ctx.funcMap.get(registerName) ?? registerIdx;
  fctx.body.push({ op: "call", funcIdx: registerIdxNow });
}

/**
 * Convenience for the value-read position: if `name` denotes a `class extends
 * Promise`, emit the unified `__promise_subclass_ctor` externref and return
 * true; else return false (caller falls through to its normal handling).
 */
export function tryEmitPromiseSubclassValue(ctx: CodegenContext, fctx: FunctionContext, name: string): boolean {
  // The cached JavaScript constructor is compatibility semantics, not boundary
  // value adaptation. Native-first/host-free lanes recognize the class above
  // but may not materialize it through this host import.
  if (isStandalonePromiseActive(ctx)) return false;
  const resolved = resolvePromiseSubclassName(ctx, name);
  if (resolved === undefined) return false;
  return emitPromiseSubclassCtor(ctx, fctx, resolved);
}

/**
 * Receiver-position helper (combinator `thisArg`): same unification, but the
 * argument arrives as a `ts.Expression`. Only a bare identifier (or class-expr
 * alias) is eligible. Returns true if it emitted the unified ctor externref.
 */
export function tryEmitPromiseSubclassReceiver(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argExpr: ts.Expression,
): boolean {
  if (!ts.isIdentifier(argExpr)) return false;
  return tryEmitPromiseSubclassValue(ctx, fctx, argExpr.text);
}
