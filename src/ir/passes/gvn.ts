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

import type { IrBlock, IrFunction, IrInstr, IrTerminator, IrValueId } from "../nodes.js";
import { forEachNestedBuffer, mapNestedBuffers } from "../nodes.js";
import { dominanceOf } from "../analysis/dominance.js";
import { effectsArePure, effectsOf, type IrEffects } from "../effects.js";
import { renameInstrOperands } from "./inline-small.js";

export interface GvnOptions {
  readonly poison?: boolean;
}

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

/** Key an instruction for value numbering, or `null` when not keyable. */
function keyOf(instr: IrInstr): string | null {
  try {
    return JSON.stringify(instr, (k, v: unknown) => {
      if (k === "result" || k === "site" || k === "alloc") return undefined;
      if (typeof v === "bigint") return `bigint:${v.toString()}`;
      return v;
    });
  } catch {
    return null; // cyclic or otherwise unserializable — decline
  }
}

function hasNestedBuffers(instr: IrInstr): boolean {
  let found = false;
  forEachNestedBuffer(instr, () => {
    found = true;
  });
  return found;
}

function mapId(rename: ReadonlyMap<IrValueId, IrValueId>, id: IrValueId): IrValueId {
  return rename.get(id) ?? id;
}

function renameTerminator(t: IrTerminator, rename: ReadonlyMap<IrValueId, IrValueId>): IrTerminator {
  if (rename.size === 0) return t;
  switch (t.kind) {
    case "return": {
      const values = t.values.map((v) => mapId(rename, v));
      return values.every((v, i) => v === t.values[i]) ? t : { ...t, values };
    }
    case "br": {
      const args = t.branch.args.map((a) => mapId(rename, a));
      return args.every((a, i) => a === t.branch.args[i]) ? t : { ...t, branch: { ...t.branch, args } };
    }
    case "br_if": {
      const c = mapId(rename, t.condition);
      const tArgs = t.ifTrue.args.map((a) => mapId(rename, a));
      const fArgs = t.ifFalse.args.map((a) => mapId(rename, a));
      const same =
        c === t.condition &&
        tArgs.every((a, i) => a === t.ifTrue.args[i]) &&
        fArgs.every((a, i) => a === t.ifFalse.args[i]);
      return same
        ? t
        : {
            ...t,
            condition: c,
            ifTrue: { ...t.ifTrue, args: tArgs },
            ifFalse: { ...t.ifFalse, args: fArgs },
          };
    }
    case "unreachable":
      return t;
  }
}

/** The poison stand-in for a numeric duplicate, or null when not poisonable. */
function poisonInstr(instr: IrInstr): IrInstr | null {
  const rt = instr.resultType;
  if (instr.result === null || rt === null || rt === undefined) return null;
  if (typeof rt !== "object" || (rt as { kind?: string }).kind !== "val") return null;
  const val = (rt as { val?: { kind?: string } }).val;
  if (val?.kind === "i32") {
    return { kind: "const", result: instr.result, resultType: rt, value: { kind: "i32", value: 424242 } };
  }
  if (val?.kind === "f64") {
    return { kind: "const", result: instr.result, resultType: rt, value: { kind: "f64", value: 424242 } };
  }
  return null;
}

/**
 * Run GVN over one function. Returns the SAME reference when nothing changed
 * (the hygiene-pipeline convention), a rebuilt function otherwise.
 */
export function gvn(fn: IrFunction, opts: GvnOptions = {}): IrFunction {
  if (fn.blocks.length === 0) return fn;
  let dominance;
  try {
    dominance = dominanceOf(fn);
  } catch {
    return fn; // malformed block ids — the verifier owns reporting that
  }

  const fxCache = new Map<IrInstr, IrEffects>();
  const rename = new Map<IrValueId, IrValueId>();
  // Scope chain of value-number tables. Entries: key → canonical result id.
  const scopes: Array<Map<string, IrValueId>> = [];
  let changed = false;

  const lookup = (key: string): IrValueId | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const hit = scopes[i].get(key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  const processBuffer = (instrs: readonly IrInstr[]): readonly IrInstr[] => {
    const out: IrInstr[] = [];
    let bufferChanged = false;
    for (const original of instrs) {
      // Apply accumulated renames first (deep — nested buffers included).
      let instr = renameInstrOperands(original, rename);
      if (instr !== original) bufferChanged = true;

      if (hasNestedBuffers(instr)) {
        // Structural instr: not a candidate itself; recurse into each buffer
        // under a fresh scope (see the header for why one uniform rule
        // covers if-arms, loop bodies and try alike).
        const mapped = mapNestedBuffers(instr, (buffer) => {
          scopes.push(new Map());
          const res = processBuffer(buffer);
          scopes.pop();
          return res as IrInstr[];
        });
        if (mapped !== instr) {
          instr = mapped;
          bufferChanged = true;
        }
        out.push(instr);
        continue;
      }

      if (instr.result !== null && instr.alloc === undefined && effectsArePure(effectsOf(instr, fxCache))) {
        const key = keyOf(instr);
        if (key !== null) {
          const canonical = lookup(key);
          if (canonical !== undefined && canonical !== instr.result) {
            if (opts.poison) {
              const poisoned = poisonInstr(instr);
              if (poisoned !== null) {
                stats.poisoned++;
                out.push(poisoned);
                bufferChanged = true;
                continue;
              }
              // Not poisonable — leave untouched (poison mode must only make
              // the mechanism VISIBLE, never silently half-apply the merge).
              out.push(instr);
              continue;
            }
            stats.merged++;
            rename.set(instr.result, canonical);
            // The duplicate stays in place; its uses are renamed away and
            // deadCode sweeps it. Do NOT record it as canonical for its key.
            out.push(instr);
            bufferChanged = true;
            continue;
          }
          if (canonical === undefined) scopes[scopes.length - 1].set(key, instr.result);
        }
      }
      out.push(instr);
    }
    if (bufferChanged) changed = true;
    return bufferChanged ? out : instrs;
  };

  // Dominator-tree DFS with one scope per block. Iterative, mirroring the
  // tree walk in analysis/dominance.ts.
  const newInstrsByBlock: Array<readonly IrInstr[] | null> = new Array(fn.blocks.length).fill(null);
  const walk = (blockId: number): void => {
    scopes.push(new Map());
    newInstrsByBlock[blockId] = processBuffer(fn.blocks[blockId].instrs);
    for (const child of dominance.children[blockId]) walk(child);
    scopes.pop();
  };
  walk(0);
  stats.functions++;

  if (!changed && rename.size === 0) return fn;

  const blocks: IrBlock[] = fn.blocks.map((b, i) => {
    const instrs = newInstrsByBlock[i] ?? b.instrs;
    const terminator = renameTerminator(b.terminator, rename);
    if (instrs === b.instrs && terminator === b.terminator) return b;
    return { ...b, instrs: instrs as IrInstr[], terminator };
  });
  if (blocks.every((b, i) => b === fn.blocks[i])) return fn;
  return { ...fn, blocks };
}
