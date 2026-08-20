import type { Instr } from "../../ir/types.js";
import type { FunctionContext } from "../context/types.js";

/**
 * (#4394) Push an EXISTING boxed-TDZ-flag ref (`fctx.boxedTdzFlags` entry),
 * null-guarded. The box local is teed by whichever capture-prepend site runs
 * first, and that site does NOT dominate its siblings: deepEqual.js's `format`
 * builds the `usage` box inside its first `return lazyResult…` branch, so
 * every other branch read the local while still null and the callee trapped on
 * the TDZ check (`struct.get` on a null `(ref null $i32cell)`). Re-init the
 * SAME local lazily — from the recorded raw i32 flag when the box was built
 * from one, else flag=1 ("treat as initialized", the pre-#1205 behaviour the
 * fresh-box arm already falls back to) — so all sites converge on one box.
 */
export function pushBoxedTdzFlagRef(
  fctx: FunctionContext,
  entry: { refCellTypeIdx: number; localIdx: number; srcFlagIdx?: number },
): void {
  const initFlag: Instr[] =
    entry.srcFlagIdx !== undefined ? [{ op: "local.get", index: entry.srcFlagIdx }] : [{ op: "i32.const", value: 1 }];
  fctx.body.push({ op: "local.get", index: entry.localIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      ...initFlag,
      { op: "struct.new", typeIdx: entry.refCellTypeIdx },
      { op: "local.set", index: entry.localIdx },
    ],
  });
  fctx.body.push({ op: "local.get", index: entry.localIdx });
}

/**
 * Which local a capture-argument prepend should read when it hands a lifted
 * function its leading capture values.
 *
 * `cap.outerLocalIdx` is a slot number in the frame that DECLARED the capture.
 * Emitted from that same frame it is exactly right, and it is what this
 * resolver returns. Emitted from a DIFFERENT frame it means nothing — a
 * cross-frame call (a sibling nested function, or a lifted arrow / function
 * expression calling one) addresses an unrelated local, or a slot that does
 * not exist at all.
 *
 * Two cases are sound cross-frame, and only these two:
 *
 *  1. The name is recorded as THIS lifted function's own leading capture
 *     parameter (`liftedCaptureNames`) — the value is right here, by
 *     construction of the lifted signature.
 *
 *  2. `cap.outerLocalIdx` is not a slot this frame has AT ALL, and this frame
 *     binds the capture's own name. The historical fallback cannot be what
 *     anything depends on in that case: it is `local index out of range` at
 *     emit, or a read of whatever unrelated local the index lands on.
 *
 * Anything else keeps `cap.outerLocalIdx`. That restraint is the point:
 * #1177's blanket "prefer localMap" lookup regressed 100+ test262 tests
 * because in-range wrong-slot behaviour turned out to be load-bearing, so an
 * index that IS in range is left exactly as it was.
 *
 * Reaches acorn's UMD bundle, which puts every top-level binding inside one
 * IIFE: `pp.method = function (...) { ... capturingSibling(...) ... }` is a
 * lifted function expression addressing the IIFE frame's slot 35 from a frame
 * with 35 locals.
 */
export function captureSourceSlot(fctx: FunctionContext, cap: { name: string; outerLocalIdx: number }): number {
  const capturedSlot = fctx.liftedCaptureSlots?.get(cap.name);
  if (capturedSlot !== undefined) return capturedSlot;
  const inFrameIdx = fctx.localMap.get(cap.name);
  if (fctx.asyncDriveReturn && inFrameIdx !== undefined) return inFrameIdx;
  if (fctx.liftedCaptureNames?.has(cap.name)) return inFrameIdx ?? cap.outerLocalIdx;

  // A let/const pre-hoist can record the capture before block-shadow setup
  // replaces that binding with its source-position local. Nested-function body
  // compilation may allocate many temporaries in between, leaving the recorded
  // index in range but now owned by an unrelated local. This is stronger
  // evidence than the broad localMap preference reverted in #1177: if the slot
  // no longer even names the captured binding, it cannot be the right source.
  // Prefer the current lexical binding in that provably-stale case. Deno's
  // `registerErrorClass` hits this with `errorConstructors` (recorded 485,
  // live 561); reading 485 produced an unrelated externref and an illegal cast.
  const recordedDef =
    cap.outerLocalIdx < fctx.params.length
      ? fctx.params[cap.outerLocalIdx]
      : fctx.locals[cap.outerLocalIdx - fctx.params.length];
  if (inFrameIdx !== undefined && recordedDef?.name !== cap.name) return inFrameIdx;

  const existsHere = cap.outerLocalIdx < fctx.params.length + fctx.locals.length;
  if (!existsHere && inFrameIdx !== undefined) return inFrameIdx;

  return cap.outerLocalIdx;
}

/** Freeze the leading capture-param slots before body locals can shadow their names. */
export function recordLiftedCaptureSlots(fctx: FunctionContext, names: Iterable<string>): void {
  const captureNames = [...names];
  fctx.liftedCaptureNames = new Set(captureNames);
  fctx.liftedCaptureSlots = new Map(
    captureNames.flatMap((name) => {
      const slot = fctx.localMap.get(name);
      return slot === undefined ? [] : [[name, slot] as const];
    }),
  );
}
