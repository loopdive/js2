// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Dead-code elimination for the middle-end IR — part of Phase 3a (#1167a).
//
// Two kinds of "dead":
//
//   1. Unreachable blocks — blocks never entered from the entry block via
//      the terminator graph. Constant-folded branches (CF rewriting
//      `br_if(const true, A, B)` → `br(A)`) leave B with no predecessors.
//      We drop every such block and renumber the remaining blocks so
//      `blocks[i].id === i` (verify.ts:41-45 invariant).
//   2. Dead values — SSA results produced by pure instructions that are
//      never referenced by any reachable instruction, terminator, or
//      side-effecting op. The spec lists `const`, `prim`, `unary`, `binary`
//      as removable; we extend to every provably-pure instruction kind
//      (`select`, `box`, `unbox`, `tag.test`, `global.get`).
//
// Side-effecting instructions (`raw.wasm`, `call`, `global.set`) are
// ALWAYS live, regardless of result use count, because their execution
// may mutate observable state. The issue spec is explicit: `raw.wasm`
// must be treated as always-live.
//
// Distinct from the backend `dead-elimination.ts` in `src/codegen/` which
// operates on Wasm imports / type definitions, not IR values.

import {
  asBlockId,
  collectUses,
  forEachNestedBuffer,
  mapNestedBuffers,
  type IrBlock,
  type IrBranch,
  type IrFunction,
  type IrInstr,
  type IrTerminator,
  type IrValueId,
} from "../nodes.js";
import type { AllocSiteRegistry } from "../alloc-registry.js";
import { retireAllocsIn } from "./alloc-discipline.js";
// #2134 slice 1 — the DCE side-effect facet moved (verbatim) into the unified
// effect model (`../effects.ts`, beside the scheduler's `effectsOf` table).
// Re-exported so existing importers keep working.
import { isSideEffecting } from "../effects.js";
export { isSideEffecting };

/**
 * Run dead-code elimination on an IR function. Returns the same reference
 * when no changes are made (so integration.ts can detect fixpoint via
 * reference equality).
 */
export function deadCode(fn: IrFunction, registry?: AllocSiteRegistry): IrFunction {
  // --- Phase 1: compute reachable blocks (BFS from entry). ---------------
  const reachable = computeReachable(fn);

  // --- Phase 2: compute live values within reachable blocks. -------------
  const live = computeLiveValues(fn, reachable);

  // (#1925) Does this instr or anything inside its nested buffers get removed?
  // The `live` set is already deep (#1922), so an interior instr's keep-status
  // is globally correct; we just have to look inside buffers to detect it.
  const removesAnything = (instr: IrInstr): boolean => {
    if (!shouldKeep(instr, live)) return true;
    let found = false;
    forEachNestedBuffer(instr, (buffer) => {
      for (const sub of buffer) if (removesAnything(sub)) found = true;
    });
    return found;
  };

  // --- Phase 3: detect whether we actually changed anything. -------------
  const willRemoveBlocks = reachable.size !== fn.blocks.length;
  let willRemoveInstrs = false;
  for (const id of reachable) {
    const block = fn.blocks[id]!;
    for (const instr of block.instrs) {
      if (removesAnything(instr)) {
        willRemoveInstrs = true;
        break;
      }
    }
    if (willRemoveInstrs) break;
  }
  if (!willRemoveBlocks && !willRemoveInstrs) return fn;

  // Rule 3 (retire): inform the registry of every allocation we are about to
  // delete — whole unreachable blocks, and dead instrs at top level OR inside
  // any nested buffer (#1925) — so downstream passes / the provenance checker
  // do not see stale ids.
  if (registry) {
    const retireDead = (instr: IrInstr): void => {
      if (!shouldKeep(instr, live)) {
        retireAllocsIn(instr, registry); // retires the instr + everything nested
        return;
      }
      forEachNestedBuffer(instr, (buffer) => {
        for (const sub of buffer) retireDead(sub);
      });
    };
    for (let id = 0; id < fn.blocks.length; id++) {
      const block = fn.blocks[id]!;
      const blockReachable = reachable.has(id);
      for (const instr of block.instrs) {
        if (!blockReachable) {
          retireAllocsIn(instr, registry);
        } else {
          retireDead(instr);
        }
      }
    }
  }

  // Recursively drop dead instrs inside a buffer, then recurse into the buffers
  // of the kept instrs. Returns the same array reference when nothing changed
  // (so mapNestedBuffers preserves instr identity and the fixpoint terminates).
  const filterBuffer = (buffer: readonly IrInstr[]): readonly IrInstr[] => {
    let changed = false;
    const kept: IrInstr[] = [];
    for (const instr of buffer) {
      if (!shouldKeep(instr, live)) {
        changed = true;
        continue;
      }
      const rebuilt = mapNestedBuffers(instr, filterBuffer);
      if (rebuilt !== instr) changed = true;
      kept.push(rebuilt);
    }
    return changed ? kept : buffer;
  };

  // --- Phase 4: rebuild blocks. ------------------------------------------
  // Sort reachable block IDs ascending, then remap old → new index.
  const sortedReachable = [...reachable].sort((a, b) => a - b);
  const oldToNew = new Map<number, number>();
  sortedReachable.forEach((old, idx) => oldToNew.set(old, idx));

  const newBlocks: IrBlock[] = sortedReachable.map((oldId) => {
    const block = fn.blocks[oldId]!;
    const newInstrs = filterBuffer(block.instrs);
    return {
      id: asBlockId(oldToNew.get(oldId)!),
      blockArgs: block.blockArgs,
      blockArgTypes: block.blockArgTypes,
      instrs: newInstrs,
      terminator: rewriteTerminatorTargets(block.terminator, oldToNew, fn.name),
    };
  });

  return {
    ...fn,
    blocks: newBlocks,
  };
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

function computeReachable(fn: IrFunction): Set<number> {
  const reachable = new Set<number>();
  const queue: number[] = [0];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (reachable.has(id)) continue;
    if (id < 0 || id >= fn.blocks.length) continue;
    reachable.add(id);
    const block = fn.blocks[id]!;
    for (const succ of successors(block.terminator)) queue.push(succ);
  }
  return reachable;
}

function successors(t: IrTerminator): readonly number[] {
  switch (t.kind) {
    case "br":
      return [t.branch.target as number];
    case "br_if":
      return [t.ifTrue.target as number, t.ifFalse.target as number];
    case "return":
    case "unreachable":
      return [];
  }
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

function computeLiveValues(fn: IrFunction, reachable: ReadonlySet<number>): Set<IrValueId> {
  const live = new Set<IrValueId>();

  // Seed: terminator uses + operands of side-effecting instructions.
  for (const id of reachable) {
    const block = fn.blocks[id]!;
    for (const v of collectTerminatorUses(block.terminator)) live.add(v);
    for (const instr of block.instrs) {
      if (isSideEffecting(instr)) {
        // Deep: a side-effecting control-flow instr (loop / try / for-of)
        // executes its nested buffers, so values referenced only inside
        // those buffers are live. (#1922 — the per-kind ad-hoc walkers used
        // to miss while.loop/for.loop buffers, silently demoting the most
        // ordinary loop shape off the IR path.)
        for (const u of collectUses(instr, { deep: true })) live.add(u);
      }
    }
  }

  // Propagate: if a live value is produced by an instr, its operands are
  // also live. Iterate to fixpoint over the reachable blocks.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of reachable) {
      const block = fn.blocks[id]!;
      for (const instr of block.instrs) {
        if (instr.result !== null && live.has(instr.result)) {
          // Deep: a live value-producing control-flow instr (e.g. an `if`
          // used by optional-chain) keeps the values referenced inside its
          // arm buffers live too.
          for (const u of collectUses(instr, { deep: true })) {
            if (!live.has(u)) {
              live.add(u);
              changed = true;
            }
          }
        }
      }
    }
  }

  return live;
}

function shouldKeep(i: IrInstr, live: ReadonlySet<IrValueId>): boolean {
  if (isSideEffecting(i)) return true;
  if (i.result === null) return true; // void-producing but not side-effecting — keep to be safe
  return live.has(i.result);
}

function collectTerminatorUses(t: IrTerminator): readonly IrValueId[] {
  switch (t.kind) {
    case "return":
      return t.values;
    case "br":
      return t.branch.args;
    case "br_if":
      return [t.condition, ...t.ifTrue.args, ...t.ifFalse.args];
    case "unreachable":
      return [];
  }
}

// ---------------------------------------------------------------------------
// Terminator rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite branch targets through the `oldToNew` map produced by block
 * renumbering. Throws if a terminator references a block that wasn't
 * reachable (which means CF+DCE dropped a successor that still has a live
 * branch pointing to it — a bug upstream).
 */
function rewriteTerminatorTargets(
  t: IrTerminator,
  oldToNew: ReadonlyMap<number, number>,
  funcName: string,
): IrTerminator {
  switch (t.kind) {
    case "return":
    case "unreachable":
      return t;
    case "br":
      return { kind: "br", branch: rewriteBranch(t.branch, oldToNew, funcName), site: t.site };
    case "br_if":
      return {
        kind: "br_if",
        condition: t.condition,
        ifTrue: rewriteBranch(t.ifTrue, oldToNew, funcName),
        ifFalse: rewriteBranch(t.ifFalse, oldToNew, funcName),
        site: t.site,
      };
  }
}

function rewriteBranch(br: IrBranch, oldToNew: ReadonlyMap<number, number>, funcName: string): IrBranch {
  const newTarget = oldToNew.get(br.target as number);
  if (newTarget === undefined) {
    throw new Error(`ir/passes/dead-code: branch to unreachable block ${br.target as number} in ${funcName}`);
  }
  return { target: asBlockId(newTarget), args: br.args };
}
