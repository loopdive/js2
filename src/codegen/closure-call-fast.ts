// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4185) Closure-receiver fast arm for the dynamic `.call` dispatchers.
 *
 * The standalone allocation census attributed the largest post-#4173 transient
 * stream to `__objvec_new`: 41.8k pairs (83.6k heap objects, ~2.3 MB) per
 * 226 KB acorn parse, split almost exactly in half between
 * `__call_m_call_2` and `__closure_method_call`. Both halves are the SAME
 * event: a dynamically-dispatched `fn.call(thisArg, a…)` — acorn's
 * `update.call(this, prevType)` in `updateContext`, once per
 * context-sensitive token — walks
 *
 *   __call_m_call_K(fn, thisArg, a…)          [$ObjVec #1: pack ALL args]
 *     → __extern_method_call(fn, "call", vec)
 *       → __closure_method_call(fn, "call", vec)
 *         → own-prop "call" miss → %Function.prototype.call% route
 *           [$ObjVec #2: re-pack args MINUS thisArg]
 *           → __apply_closure(fn, thisArg, vec2) → __call_fn_method_N ladder
 *
 * and both vectors are dead the moment `__apply_closure` unpacks them. The
 * consumer unwraps immediately; the boxes are pure dispatch plumbing.
 *
 * This arm decides the whole chain at the dispatcher, allocation-free: when
 * the receiver IS a WasmGC closure (funcref-wrapper root `ref.test`), has NO
 * own `call` property (`__extern_get` — the same §10.2 [[Get]] precedence
 * check `__closure_method_call` route 1 performs), and is not UNDER-applied
 * (declared formals ≤ provided args — the exact-arity ladder only carries
 * closures with `formals <= N`; under-application must keep the legacy path
 * whose #3592 widening pads the missing args), invoke
 * `__call_fn_method_(K-1)(thisArg, fn, a…)` directly, argc preset/reset
 * around it exactly like the #3673 round-13 cached-direct-call arm.
 *
 * Everything else — own-prop overrides, under-application, non-closure
 * receivers, ropes, `.apply`, the vararg dispatcher — falls through to the
 * legacy chain unchanged.
 *
 * Flag: `JS2WASM_FAST_CLOSURE_CALL=0` restores the legacy-only dispatcher.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureArgcGlobal } from "./statements/nested-declarations.js";
import { CLOSURE_ARITY_FIELD_IDX, getFuncRefWrapperRootTypeIdx } from "./closures/funcref-wrapper-types.js";

export function fastClosureCallEnabled(): boolean {
  return process.env.JS2WASM_FAST_CLOSURE_CALL !== "0";
}

/**
 * Wrap `current` (the already-built dispatcher arm chain for
 * `__call_m_call_<arity>`) in the closure fast arm. Returns `current`
 * unchanged — and appends no local — when the arm does not apply (flag off,
 * wrong method, arity 0, or a required helper is absent).
 *
 * When armed, appends ONE externref scratch (`__cc_m` — first the own-prop
 * probe result, then the call result) to `locals`, whose slot is
 * `arity + 1 + locals.length` at append time. This is safe against the
 * round-13 `mcPatchInstrs` deferred-slot pattern in the caller: that patch
 * computes ITS slot from `locals.length` after this append, so both are
 * distinct and final. The caller must not reorder `locals` afterwards.
 *
 * Only READS funcMap — every dependency (`__extern_get`, the interned "call"
 * literal, `__call_fn_method_*`) was registered at reserve time or earlier;
 * missing ones disable the arm rather than minting anything at finalize.
 */
export function wrapClosureCallFastArm(
  ctx: CodegenContext,
  methodName: string,
  arity: number,
  anyLocalIdx: number,
  current: Instr[],
  locals: { name: string; type: ValType }[],
): Instr[] {
  if (!fastClosureCallEnabled()) return current;
  if (methodName !== "call" || arity < 1) return current;
  const rootIdx = getFuncRefWrapperRootTypeIdx(ctx);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const nullishIdx = ctx.funcMap.get("__nullish_to_null");
  const callFnMethodIdx = ctx.funcMap.get(`__call_fn_method_${arity - 1}`);
  if (rootIdx === undefined || externGetIdx === undefined || callFnMethodIdx === undefined) return current;

  const scratchLocal = arity + 1 + locals.length;
  locals.push({ name: "__cc_m", type: { kind: "externref" } });
  const scratch = (op: "local.get" | "local.set" | "local.tee"): Instr => ({ op, index: scratchLocal });
  const argcGlobalIdx = ensureArgcGlobal(ctx);

  return [
    // receiver is a WasmGC closure?
    { op: "local.get", index: anyLocalIdx },
    { op: "ref.test", typeIdx: rootIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        // no own `call` property? (§10.2 precedence — an override must win)
        { op: "local.get", index: 0 },
        ...stringConstantExternrefInstrs(ctx, methodName),
        { op: "call", funcIdx: externGetIdx },
        ...(nullishIdx !== undefined ? ([{ op: "call", funcIdx: nullishIdx }] satisfies Instr[]) : []),
        scratch("local.tee"),
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            // not under-applied? (declared formals ≤ the K-1 provided args)
            { op: "local.get", index: anyLocalIdx },
            { op: "ref.cast", typeIdx: rootIdx },
            { op: "struct.get", typeIdx: rootIdx, fieldIdx: CLOSURE_ARITY_FIELD_IDX },
            { op: "i32.const", value: arity - 1 },
            { op: "i32.le_s" },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "i32.const", value: arity - 1 },
        { op: "global.set", index: argcGlobalIdx },
        { op: "local.get", index: 1 }, // thisArg — `.call`'s first argument
        { op: "local.get", index: 0 }, // the closure itself is the callee
        ...Array.from({ length: arity - 1 }, (_, a): Instr => ({ op: "local.get", index: 2 + a })),
        { op: "call", funcIdx: callFnMethodIdx },
        scratch("local.set"),
        { op: "i32.const", value: -1 },
        { op: "global.set", index: argcGlobalIdx },
        scratch("local.get"),
      ],
      else: current,
    },
  ];
}
