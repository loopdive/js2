// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4424 — structure-tree GVN: scoped value numbering over the ADR-0018 IR.
//
// ## The shape, and why it is safe
//
// Classical dominator-tree GVN walks the dominator tree with a stack of
// scoped hash tables. This IR has TWO nesting dimensions and the same walk
// covers both:
//
//   1. BLOCK level — the dominator tree from `dominanceOf` (#4418). On the
//      graphs today's producer emits this is just the CFG tree (join-free,
//      ADR-0018), but walking the dominator tree keeps the pass correct if a
//      future producer emits joins: an entry recorded in block A serves a
//      lookup in block B only when A dominates B.
//   2. BUFFER level — nested if/loop/try instruction buffers get one fresh
//      scope each, uniformly. That single rule encodes every structural
//      safety condition at once: an if-arm entry cannot serve the sibling arm
//      or the code after the join (the arm may not have executed); a
//      loop-body entry dies at the body's end (it rebinds per iteration —
//      within one iteration the def re-executes before any use it serves); a
//      try-body entry cannot leak past the try (partial execution on throw).
//      Entries from ENCLOSING scopes remain visible inside, which is sound:
//      an SSA value defined outside a loop is computed once, before it.
//
// ## Fail-safe by construction — the pass only RENAMES, never deletes
//
// When `(kind, operands, immediates)` matches a table entry, later USES are
// renamed to the earlier result id. The duplicate instruction itself is left
// in place; it becomes dead and the existing `deadCode` pass sweeps it on the
// same hygiene iteration. Three properties fall out:
//
//   - A use the renamer cannot rewrite keeps the duplicate live and the
//     program correct — a missed merge, never a miscompile.
//   - No value-creating instruction is ever deleted HERE, so the #1586
//     alloc-registry preserve/alias/retire rules are not engaged (and
//     alloc-carrying instrs are excluded from merging anyway — reusing an
//     allocation would change object identity).
//   - `rename` is chain-free: a value becomes a merge SOURCE only if its key
//     was already present, and it becomes a merge TARGET only if it was the
//     first of its key — the two are mutually exclusive, so single-step
//     lookup is exact.
//
// ## Admission
//
// An instruction is a candidate iff ALL of:
//   - it produces a result (`result !== null`),
//   - `effectsArePure(effectsOf(instr))` — the #2134 single source of truth
//     (this excludes heap reads/writes, calls, control effects, and every
//     slot toucher; a NEW instruction kind is a full barrier there until
//     classified, so it is inert here by default),
//   - it carries no `alloc` site (allocation identity must not merge — note
//     the scheduler classifies fresh allocations as pure, so this check is
//     load-bearing, not redundant),
//   - it has no nested buffers (structural instrs are not values to reuse).
//
// The key serializes the WHOLE instruction minus `result`/`site`/`alloc`
// (a replacer drops those and stringifies bigints). Over-keying (an
// irrelevant field splitting a class) costs a missed merge; under-keying (a
// missed immediate) would be a miscompile — so everything else is kept,
// `resultType` included.
//
// ## Gating
//
// The pass is invoked from `runHygienePasses` (integration.ts) behind
// `JS2WASM_IR_GVN` — default OFF, `1`/`true` on, `poison` the liveness
// control (see below). Measured first, flipped separately (the #4455
// pattern).
//
// Poison mode replaces each detected duplicate whose result is a plain
// numeric with `const 424242` (i32) / `424242.0` (f64) instead of recording
// the rename — uses then read garbage, so the acorn self-parse checksum MUST
// move off 422 if merges fire on the executed path. A confident null from a
// mechanism that never fired closes a door that was never opened (#4157,
// twice in one session).

import type { IrFunction } from "../nodes.js";
import { createGvnCounters, gvnCore, type GvnCounters, type GvnOptions } from "./gvn-core.js";
export type { GvnOptions } from "./gvn-core.js";

/**
 * The hygiene-pipeline entry: reads `JS2WASM_IR_GVN` itself so the pipeline
 * stays a one-liner (god-file discipline, #3102). Unset/off → the function is
 * returned untouched; `1`/`true` → GVN; `poison` → the liveness control.
 */
export function gvnFromEnv(fn: IrFunction): IrFunction {
  const mode = process.env.JS2WASM_IR_GVN;
  if (mode !== "1" && mode !== "true" && mode !== "poison") return fn;
  return gvn(fn, { poison: mode === "poison" });
}

const stats = { merged: 0, poisoned: 0, functions: 0 };
if (process.env.JS2WASM_IR_GVN_DEBUG === "1") {
  process.on("exit", () => {
    if (stats.merged > 0 || stats.poisoned > 0) {
      process.stderr.write(`[ir-gvn] functions=${stats.functions} merged=${stats.merged} poisoned=${stats.poisoned}\n`);
    }
  });
}

const recordedCounters = new WeakSet<GvnCounters>();

/** Publish one completed or partially failed transaction exactly once. */
export function recordLegacyGvnCountersOnce(counters: GvnCounters): void {
  if (recordedCounters.has(counters)) return;
  recordedCounters.add(counters);
  stats.functions += counters.functions;
  stats.merged += counters.merged;
  stats.poisoned += counters.poisoned;
}

/** Historical GVN entry, including accounting when the original error escapes. */
export function gvn(fn: IrFunction, opts: GvnOptions = {}): IrFunction {
  const counters = createGvnCounters();
  try {
    return gvnCore(fn, opts, counters);
  } finally {
    recordLegacyGvnCountersOnce(counters);
  }
}
