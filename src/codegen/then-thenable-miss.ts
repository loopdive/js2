// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4394) Standalone `.then` receiver-bridge MISS arm: user thenables and the
 * honest non-thenable TypeError.
 *
 * The #2980 receiver bridge routes any-typed `.then`/`.catch` calls through a
 * runtime `ref.test $Promise`: a native `$Promise` chains natively, everything
 * else takes the miss arm. Under standalone native-first that miss arm was a
 * bare `ref.null.extern` (the wasi zero-import shape applied to standalone),
 * which silently swallowed BOTH legitimate cases the test262 harness exercises:
 *
 *   - a USER THENABLE receiver (`{ then: function () {} }` in
 *     `asyncHelpers-throwsAsync-func-never-settles.js`) — `res.then(a, b)` is
 *     an ordinary method call that must invoke the receiver's own `then`;
 *   - a genuine NON-thenable (`asyncTest`'s `testFunc().then(...)` when
 *     testFunc returned a raw value) — must throw a catchable TypeError so
 *     `asyncTest`'s `catch (syncError) { $DONE(syncError); }` observes it
 *     (`asyncHelpers-asyncTest-return-not-thenable.js` asserts exactly that).
 *
 * This module builds the upgraded miss arm:
 *
 *   argvec = [__objvec_new(); push each compiled handler arg]   // JS eval order
 *   if (__promise_has_callable_then(recv))
 *        __call_m_then_vararg(recv, argvec)     // then.call(recv, ...args)
 *   else <missTypeError ? throw TypeError : ref.null.extern>
 *
 * All pieces are the module's own natives (the #3125 thenable substrate + the
 * #2151 vararg dispatcher) — no host import is introduced, so the #2961/#2903
 * host-free guarantees are unaffected. Returns false (caller keeps the legacy
 * `ref.null.extern`) when any piece is unavailable. wasi keeps its nullMiss
 * contract — callers only invoke this for standalone non-wasi.
 *
 * Leaf module by design: the emitters come through the `shared.js` late-bound
 * delegates, so no cycle back through calls.ts (which is size-frozen).
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { coerceType, compileExpression } from "./shared.js";
import { emitThrowTypeError } from "./js-errors.js";

/**
 * Emit the thenable-aware miss arm into `fctx.body` (the caller has already
 * pointed `fctx.body` at the miss-arm buffer and registered it live). The
 * receiver is in `recvLocal`. Leaves exactly one externref on the stack, like
 * the arm it replaces. `missTypeError` selects the non-thenable tail: the
 * §27.2.5.4 step-2 TypeError when the module provably cannot mint a host
 * promise (`standaloneThenMissArmCanBeNative`), else the legacy null result.
 */
export function tryEmitStandaloneThenThenableMissArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvLocal: number,
  args: readonly (ts.Expression | undefined)[],
  missTypeError: boolean,
): boolean {
  if (ctx.standalone !== true || ctx.wasi === true) return false;
  const hasThenIdx = ctx.funcMap.get("__promise_has_callable_then");
  const varargThenIdx = ctx.funcMap.get("__call_m_then_vararg");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  if (
    hasThenIdx === undefined ||
    varargThenIdx === undefined ||
    objVecNewIdx === undefined ||
    objVecPushIdx === undefined
  ) {
    return false;
  }

  // Build the args vector first — JS evaluates `recv.then(a, b)`'s arguments
  // before the callee's IsCallable check, so side effects order correctly.
  const vecLocal = allocLocal(fctx, `__thenmiss_vec_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: objVecNewIdx });
  fctx.body.push({ op: "local.set", index: vecLocal });
  for (const arg of args) {
    fctx.body.push({ op: "local.get", index: vecLocal });
    if (arg === undefined) {
      fctx.body.push({ op: "ref.null.extern" });
    } else {
      const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
      if (argType === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if ((argType as ValType).kind !== "externref") {
        coerceType(ctx, fctx, argType as ValType, { kind: "externref" });
      }
    }
    fctx.body.push({ op: "call", funcIdx: objVecPushIdx });
  }

  // Non-thenable tail, built in a swapped-in buffer so emitThrowTypeError's
  // registrations stay visible to the late-import shifter.
  const missTail: Instr[] = [];
  if (missTypeError) {
    const savedBody = fctx.body;
    fctx.savedBodies.push(savedBody);
    ctx.liveBodies.add(missTail);
    fctx.body = missTail;
    try {
      emitThrowTypeError(ctx, fctx, "Promise.prototype.then called on a non-Promise receiver");
    } finally {
      fctx.savedBodies.pop();
      fctx.body = savedBody;
      ctx.liveBodies.delete(missTail);
    }
  } else {
    missTail.push({ op: "ref.null.extern" });
  }

  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "call", funcIdx: hasThenIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [
      { op: "local.get", index: recvLocal },
      { op: "local.get", index: vecLocal },
      { op: "call", funcIdx: varargThenIdx },
    ],
    else: missTail,
  });
  return true;
}
