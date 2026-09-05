import type { Instr, ValType } from "../../ir/types.js";
import { getLocalType } from "../context/locals.js";
import type { FunctionContext } from "../context/types.js";

/**
 * (#5303) Does a capture consumer want the ref cell's INNER VALUE rather than
 * the cell itself?
 *
 * A read-only capture has value-copy semantics, so the declaring frame's
 * `__boxed_<name>` cell — minted for some OTHER nested function that mutates
 * the same binding — is an implementation detail of that frame, not part of
 * this consumer's ABI. Both consumers (the direct-call capture prepend in
 * call-identifier.ts and the closure-reification prepend in
 * funcref-as-closure.ts) therefore unwrap it with a `struct.get`.
 *
 * Until now both asked the question by PROXY: "is the expected type a
 * non-reference (f64 / i32 / externref)?". That silently answered "no" for a
 * read-only capture whose value type is itself a GC reference — moment's
 * `isoDates`, a `(ref $vec-of-vec)` — so the cell was forwarded where the value
 * was wanted. On the direct-call side the mismatch was then "repaired" into a
 * guarded `ref.test`/`ref.cast` that can only ever produce null; on the closure
 * side it reached the callee as a raw cell and trapped (`illegal cast`).
 *
 * Ask directly instead: the consumer wants the value exactly when its expected
 * type IS the box's inner value type. A consumer that genuinely wants the cell
 * names `refCellTypeIdx`, which is never its own field's type index, so that
 * arm is unchanged.
 */
export function expectsBoxedCaptureValue(
  expected: ValType | undefined,
  boxed: { refCellTypeIdx: number; valType: ValType } | undefined,
): boolean {
  if (expected === undefined || boxed === undefined) return false;
  if (expected.kind !== "ref" && expected.kind !== "ref_null") return true;
  const inner = boxed.valType;
  if (inner.kind !== "ref" && inner.kind !== "ref_null") return false;
  return expected.typeIdx === inner.typeIdx;
}

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

/**
 * Record `boxLocalIdx` as this frame's canonical ref cell for the lifted capture
 * `name` — but ONLY when the cell was minted from the frozen capture slot
 * itself.
 *
 * That provenance test is the whole point. `localMap`/`boxedCaptures` are
 * name-keyed, so a `__boxed_<name>` cell in a lifted frame can equally well
 * belong to a same-named body binding that SHADOWS the hidden leading capture
 * param (React's `forceStoreRerender`: a local `root` beside a captured module
 * `root`). Forwarding that cell to a sibling would hand it the wrong binding —
 * which is exactly why the forwarding sites read the frozen slot in the first
 * place. Minted-from-the-frozen-slot is the one case where the cell provably IS
 * the capture's storage, so it is the one case recorded here.
 */
export function recordLiftedCaptureBox(
  fctx: FunctionContext,
  name: string,
  sourceSlot: number,
  boxLocalIdx: number,
): void {
  if (fctx.liftedCaptureSlots?.get(name) !== sourceSlot) return;
  (fctx.liftedCaptureBoxes ??= new Map()).set(name, boxLocalIdx);
}

/**
 * The frame's canonical cell for lifted capture `name`, when one was recorded
 * and still carries the expected cell type. Type-checked because the recorded
 * slot must satisfy the callee's ABI on its own; anything else falls back to the
 * frozen raw slot and the caller's existing behaviour.
 */
export function liftedCaptureBoxSlot(fctx: FunctionContext, name: string, refCellTypeIdx: number): number | undefined {
  const slot = fctx.liftedCaptureBoxes?.get(name);
  if (slot === undefined) return undefined;
  const type = getLocalType(fctx, slot);
  if (type === undefined || (type.kind !== "ref" && type.kind !== "ref_null")) return undefined;
  return type.typeIdx === refCellTypeIdx ? slot : undefined;
}

/** Freeze the leading capture-param slots before body locals can shadow their names. */
export function recordLiftedCaptureSlots(
  fctx: FunctionContext,
  names: Iterable<string>,
  options?: { leadingParamOffset: number },
): void {
  const captureNames = [...names];
  fctx.liftedCaptureNames = new Set(captureNames);
  if (options) {
    // Declaration/fnctor captures are a known contiguous parameter prefix.
    // Derive their slots from that ABI position rather than localMap: a
    // same-named user parameter is installed later and legitimately wins the
    // source binding, but must not overwrite this hidden forwarding slot.
    fctx.liftedCaptureSlots = new Map(captureNames.map((name, slot) => [name, options.leadingParamOffset + slot]));
    return;
  }
  // Arrow/callback captures are extracted into locals after self/user params;
  // retain their already-materialized localMap slots.
  fctx.liftedCaptureSlots = new Map(
    captureNames.flatMap((name) => {
      const slot = fctx.localMap.get(name);
      return slot === undefined ? [] : [[name, slot] as const];
    }),
  );
}
