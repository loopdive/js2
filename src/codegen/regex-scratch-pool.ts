// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#4185 follow-up, for #4157) Reuse of the two ENGINE-INTERNAL scratch objects
 * the standalone RegExp path allocates per call.
 *
 * The 2026-08-07 allocation census of one standalone-dynamic acorn parse
 * (262,711 allocations total) attributes 47,839 of them — 18.2 % — to two
 * streams that hold no user-observable value at all:
 *
 *   | 29,117 | `__regexp_test_carrier` | the per-`.test` capture-slot array |
 *   | 18,722 | `__regex_run`           | one `$__ReFrame` per backtrack push |
 *
 * Both are pure scratch. `.test` returns a boolean and never reads a capture
 * beyond slot 1 (the match end, for the `g`/`y` `lastIndex` store), and a
 * backtrack frame is a three-field record the VM pops and discards. Neither can
 * be reached by user code: nothing between the allocation and its last use
 * calls out of the engine, so neither object's IDENTITY is observable and
 * reusing the storage cannot change a program's result.
 *
 * WHY A CHECKOUT-NULL POOL RATHER THAN A PLAIN SHARED GLOBAL
 * ---------------------------------------------------------
 * A single always-shared global would be correct only as long as the engine
 * never re-enters the `.test` helper while the scratch is live — true today,
 * but true by AUDIT of the call graph, and an audit is not a guarantee that
 * survives the next feature. The checkout-null idiom (#3673 round 22, already
 * used for `__regex_run`'s backtrack-stack array) makes reuse safe by
 * CONSTRUCTION: a caller takes the pooled object and immediately nulls the
 * slot, so any re-entrant caller — including one a future change introduces —
 * simply finds an empty pool and allocates fresh. A trap between checkout and
 * check-in (the #2091 step-cap `RangeError`) likewise just leaves the pool
 * empty; the next call allocates. There is no state in which two live users
 * share one array.
 *
 * WHAT IS DELIBERATELY *NOT* POOLED
 * ---------------------------------
 * `.exec`, `String.prototype.match`/`matchAll`/`replace`/`split`, and every
 * `Symbol.*` protocol entry point keep their per-call allocation. Those paths
 * publish capture VALUES into a result object, and some of them (replace with a
 * function argument) call user code while the capture array is still live —
 * which is exactly the re-entrancy the pool must not have to reason about. The
 * one pooled entry point is the one whose result is a boolean.
 *
 * `lastIndex` is untouched: it is read and written from the RegExp struct, not
 * from the scratch, and the `g`/`y` store still reads slot 1 of whichever array
 * the search filled. `__regex_search` re-initialises the slots it uses with
 * `array.fill(caps, 0, -1, nSlots)` before EVERY attempt, so a pooled array
 * arrives with the same contents a freshly defaulted one would have; a pooled
 * array that is LONGER than `nSlots` is equally fine, since every reader and
 * writer in the engine is bounded by the `nSlots` argument rather than by
 * `array.len`.
 */

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";

/** Module global holding the pooled `.test` capture-slot array (null = empty). */
const TEST_CAPS_POOL_GLOBAL = "__re_test_caps_pool";

/**
 * Reuse the `.test` capture-slot scratch across calls. `=0` restores the
 * per-call `array.new_default`.
 */
export function regexTestCapsPoolEnabled(): boolean {
  return process.env.JS2WASM_REGEXP_TEST_CAPS_POOL !== "0";
}

/**
 * Recycle the `$__ReFrame` already sitting in the backtrack stack slot instead
 * of allocating a fresh one per push. `=0` restores the per-push `struct.new`.
 */
export function regexFrameReuseEnabled(): boolean {
  return process.env.JS2WASM_REGEXP_FRAME_REUSE !== "0";
}

/** Index of a module global, creating it on first use. Idempotent by name. */
function ensureGlobal(ctx: CodegenContext, name: string, type: ValType, init: Instr[]): number {
  const existing = ctx.mod.globals.findIndex((g) => g.name === name);
  if (existing >= 0) return ctx.numImportGlobals + existing;
  const index = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({ name, type, mutable: true, init });
  return index;
}

/**
 * Emit the `.test` capture-scratch acquisition into `fctx.body`, leaving the
 * array in `capsLocal` (a non-null `ref array<i32>`).
 *
 * With the pool on: check the pooled array out (nulling the slot), and take it
 * only when it is long enough for this receiver's `nSlots` — otherwise allocate
 * a bigger one, which then becomes the pooled array at check-in. The pool
 * therefore converges to the largest slot count the program has ever needed and
 * stops allocating.
 */
export function emitTestCapsAcquire(
  ctx: CodegenContext,
  fctx: FunctionContext,
  nSlotsLocal: number,
  i32ArrTypeIdx: number,
): number {
  const capsLocal = allocLocal(fctx, `__re_tcaps_${fctx.locals.length}`, { kind: "ref", typeIdx: i32ArrTypeIdx });
  const fresh: Instr[] = [
    { op: "local.get", index: nSlotsLocal },
    { op: "array.new_default", typeIdx: i32ArrTypeIdx },
    { op: "local.set", index: capsLocal },
  ];
  if (!regexTestCapsPoolEnabled()) {
    fctx.body.push(...fresh);
    return capsLocal;
  }
  const poolIdx = ensureGlobal(ctx, TEST_CAPS_POOL_GLOBAL, { kind: "ref_null", typeIdx: i32ArrTypeIdx }, [
    { op: "ref.null", typeIdx: i32ArrTypeIdx },
  ]);
  const held = allocLocal(fctx, `__re_tpool_${fctx.locals.length}`, { kind: "ref_null", typeIdx: i32ArrTypeIdx });
  fctx.body.push(
    { op: "global.get", index: poolIdx },
    { op: "local.set", index: held },
    // Check out: an empty pool is what makes a re-entrant caller safe.
    { op: "ref.null", typeIdx: i32ArrTypeIdx },
    { op: "global.set", index: poolIdx },
    { op: "local.get", index: held },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 1 }],
      else: [
        { op: "local.get", index: held },
        { op: "ref.as_non_null" },
        { op: "array.len" },
        { op: "local.get", index: nSlotsLocal },
        { op: "i32.lt_s" },
      ],
    },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: fresh,
      else: [{ op: "local.get", index: held }, { op: "ref.as_non_null" }, { op: "local.set", index: capsLocal }],
    },
  );
  return capsLocal;
}

/** Return the `.test` capture scratch to the pool. No-op when pooling is off. */
export function emitTestCapsRelease(ctx: CodegenContext, fctx: FunctionContext, capsLocal: number): void {
  if (!regexTestCapsPoolEnabled()) return;
  const poolIdx = ctx.mod.globals.findIndex((g) => g.name === TEST_CAPS_POOL_GLOBAL);
  if (poolIdx < 0) return;
  fctx.body.push({ op: "local.get", index: capsLocal }, { op: "global.set", index: ctx.numImportGlobals + poolIdx });
}

/**
 * The `__regex_run` SPLIT push: store `{pc: b, sp, caps: snap}` at `stack[top]`
 * and bump `top`.
 *
 * With frame reuse on, a slot that already holds a frame from an earlier push
 * — of this run OR, thanks to the #3673 round 22 stack pool, of a previous one
 * — is written in place instead of being replaced. A frame at or above `top` is
 * dead by definition (it was popped, and the pop copies all three fields into
 * locals before anything can push again), and a frame is only ever stored back
 * at the index it was read from, so no two stack slots can alias. `array.copy`
 * on growth preserves index identity; the freshly grown tail is null and falls
 * to the allocating arm.
 */
export function frameStackPushInstrs(opts: {
  frameTypeIdx: number;
  frameArrTypeIdx: number;
  stackLocal: number;
  topLocal: number;
  frameLocal: number;
  pcValueLocal: number;
  spLocal: number;
  snapLocal: number;
}): Instr[] {
  const { frameTypeIdx, frameArrTypeIdx, stackLocal, topLocal, frameLocal } = opts;
  const { pcValueLocal, spLocal, snapLocal } = opts;
  const allocate: Instr[] = [
    { op: "local.get", index: pcValueLocal },
    { op: "local.get", index: spLocal },
    { op: "local.get", index: snapLocal },
    { op: "struct.new", typeIdx: frameTypeIdx },
    { op: "local.set", index: frameLocal },
    { op: "local.get", index: stackLocal },
    { op: "local.get", index: topLocal },
    { op: "local.get", index: frameLocal },
    { op: "array.set", typeIdx: frameArrTypeIdx },
  ];
  const bump: Instr[] = [
    { op: "local.get", index: topLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: topLocal },
  ];
  if (!regexFrameReuseEnabled()) return [...allocate, ...bump];
  return [
    { op: "local.get", index: stackLocal },
    { op: "local.get", index: topLocal },
    { op: "array.get", typeIdx: frameArrTypeIdx },
    { op: "local.tee", index: frameLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: allocate,
      else: [
        // Already in the slot at this index — rewrite the three fields.
        { op: "local.get", index: frameLocal },
        { op: "ref.as_non_null" },
        { op: "local.get", index: pcValueLocal },
        { op: "struct.set", typeIdx: frameTypeIdx, fieldIdx: 0 },
        { op: "local.get", index: frameLocal },
        { op: "ref.as_non_null" },
        { op: "local.get", index: spLocal },
        { op: "struct.set", typeIdx: frameTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: frameLocal },
        { op: "ref.as_non_null" },
        { op: "local.get", index: snapLocal },
        { op: "struct.set", typeIdx: frameTypeIdx, fieldIdx: 2 },
      ],
    },
    ...bump,
  ];
}
