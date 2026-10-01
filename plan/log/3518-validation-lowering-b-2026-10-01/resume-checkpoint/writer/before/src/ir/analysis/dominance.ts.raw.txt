// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4418 — dominance analysis over the IR block CFG, extracted into a shared,
// cached module.
//
// ## What this replaces, and what it deliberately does NOT claim
//
// The verifier has carried a private dominator computation since #1850
// (`computeDominators` in verify.ts): full dominator SETS via the classic
// iterative fixpoint — O(blocks²) space, Set-per-block, recomputed on every
// verification with no reuse and no tree shape. This module is the shared
// replacement: Cooper–Harvey–Kennedy iterative idoms on flat arrays, the
// dominator TREE, an O(1) `dominates()` via tree pre/post numbering, deduped
// predecessor lists, reverse postorder, and dominance frontiers.
//
// It does NOT claim to unblock GVN/LICM/SCCP. Under ADR-0018 (structured IR,
// #1925's decision) loops and ifs live in nested instruction buffers — the
// block graph the front-end emits is join-free and back-edge-free by
// `lower.ts`'s own contract, so on today's producer:
//
//   - every reachable non-entry block has exactly one predecessor,
//   - the dominator tree IS the CFG tree, and
//   - every dominance frontier is EMPTY.
//
// The tests assert that invariant rather than pretending otherwise. The
// general-graph correctness (joins, back-edges, unreachable blocks) is still
// implemented and tested against a naive reference — the algorithm must not
// silently rot if a future producer (or a revisit of ADR-0018) starts
// emitting joins.
//
// ## Conventions
//
//   - Precondition: `fn.blocks[i].id === i` (the contiguity invariant
//     verify.ts enforces). `computeDominance` throws on violation — callers
//     that tolerate malformed input (the verifier) must gate, as they already
//     gate their own dominance check.
//   - Entry block is `blocks[0]`. `idom[0] === 0` by convention.
//   - Unreachable blocks: `idom` is `-1`, they appear in no `rpo`/`preds`/
//     `frontier`, and `dominates(a, b)` is `false` whenever either side is
//     unreachable. Callers that need #1850's conservative "an unreachable
//     use-site never violates dominance" behaviour must special-case
//     reachability themselves (verify.ts does).
//   - `preds` lists are DEDUPED (a `br_if` with both arms on one target
//     contributes one edge) and contain reachable predecessors only — the
//     right shape for dominance and frontiers. The raw edge MULTISET over all
//     blocks, which `simplify-cfg` keys its single-predecessor merge on, is
//     the separate `rawPredecessorCounts` below; the two are different
//     queries and must not be conflated.

import type { IrBlock, IrFunction } from "../nodes.js";

/** Successor block ids of a block, derived from its terminator. */
export function blockSuccessors(block: IrBlock): readonly number[] {
  const t = block.terminator;
  switch (t.kind) {
    case "br":
      return [t.branch.target as number];
    case "br_if": {
      const a = t.ifTrue.target as number;
      const b = t.ifFalse.target as number;
      return a === b ? [a] : [a, b];
    }
    case "return":
    case "unreachable":
      return [];
  }
}

/**
 * Raw predecessor-edge counts over ALL blocks (reachable or not), counting a
 * both-arms `br_if` to one target as TWO edges — the multiset simplify-cfg's
 * "exactly one predecessor" merge rule is defined over. Not deduped, not
 * reachability-filtered; do not use for dominance.
 */
export function rawPredecessorCounts(fn: IrFunction): Int32Array {
  const n = fn.blocks.length;
  const count = new Int32Array(n);
  for (const block of fn.blocks) {
    const t = block.terminator;
    if (t.kind === "br") {
      const s = t.branch.target as number;
      if (s >= 0 && s < n) count[s]++;
    } else if (t.kind === "br_if") {
      const a = t.ifTrue.target as number;
      const b = t.ifFalse.target as number;
      if (a >= 0 && a < n) count[a]++;
      if (b >= 0 && b < n) count[b]++;
    }
  }
  return count;
}

export interface DominanceInfo {
  /** `reachable[b]` — is block b reachable from the entry block. */
  readonly reachable: readonly boolean[];
  /** Reverse postorder over the reachable blocks (starts with the entry). */
  readonly rpo: readonly number[];
  /** Immediate dominator per block id; `idom[0] === 0`; unreachable → -1. */
  readonly idom: readonly number[];
  /** Dominator-tree children per block id (entry's exclude itself). */
  readonly children: readonly (readonly number[])[];
  /** DEDUPED, reachable-only predecessor lists per block id. */
  readonly preds: readonly (readonly number[])[];
  /** Dominance frontier per block id (empty on ADR-0018 join-free graphs). */
  readonly frontier: readonly (readonly number[])[];
  /**
   * Does `a` dominate `b` (reflexively)? O(1) via dominator-tree pre/post
   * numbering. `false` whenever either block is unreachable — see the header
   * for the verifier's conservative special case.
   */
  dominates(a: number, b: number): boolean;
}

/** Compute dominance for one function. Prefer {@link dominanceOf} (cached). */
export function computeDominance(fn: IrFunction): DominanceInfo {
  const n = fn.blocks.length;
  for (let i = 0; i < n; i++) {
    if ((fn.blocks[i].id as number) !== i) {
      throw new Error(`dominance: block ids not contiguous (blocks[${i}].id === ${fn.blocks[i].id})`);
    }
  }
  if (n === 0) {
    return {
      reachable: [],
      rpo: [],
      idom: [],
      children: [],
      preds: [],
      frontier: [],
      dominates: () => false,
    };
  }

  // --- reachability + postorder (iterative DFS from the entry) -------------
  const reachable: boolean[] = new Array(n).fill(false);
  const postorder: number[] = [];
  {
    // Frame: [blockId, nextSuccessorIndex]. Successors are recomputed per
    // visit — terminators are tiny and this keeps the walk allocation-light.
    const stack: Array<[number, number]> = [[0, 0]];
    reachable[0] = true;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const succs = blockSuccessors(fn.blocks[frame[0]]);
      if (frame[1] < succs.length) {
        const s = succs[frame[1]++];
        if (s >= 0 && s < n && !reachable[s]) {
          reachable[s] = true;
          stack.push([s, 0]);
        }
      } else {
        postorder.push(frame[0]);
        stack.pop();
      }
    }
  }
  const rpo = [...postorder].reverse();
  // Position of each block in RPO — the ordering CHK's intersect walks.
  const rpoNum = new Int32Array(n).fill(-1);
  for (let i = 0; i < rpo.length; i++) rpoNum[rpo[i]] = i;

  // --- deduped reachable-only predecessor lists ----------------------------
  const preds: number[][] = Array.from({ length: n }, () => []);
  for (const b of rpo) {
    for (const s of blockSuccessors(fn.blocks[b])) {
      if (s >= 0 && s < n && reachable[s] && !preds[s].includes(b)) preds[s].push(b);
    }
  }

  // --- Cooper–Harvey–Kennedy iterative idoms -------------------------------
  const idom = new Int32Array(n).fill(-1);
  idom[0] = 0;
  const intersect = (a: number, b: number): number => {
    let x = a;
    let y = b;
    while (x !== y) {
      while (rpoNum[x] > rpoNum[y]) x = idom[x];
      while (rpoNum[y] > rpoNum[x]) y = idom[y];
    }
    return x;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of rpo) {
      if (b === 0) continue;
      // First processed predecessor seeds the intersection; a back-edge
      // predecessor not yet processed this round (idom -1) is skipped and
      // participates on the next iteration — the standard CHK schedule.
      let newIdom = -1;
      for (const p of preds[b]) {
        if (idom[p] === -1) continue;
        newIdom = newIdom === -1 ? p : intersect(newIdom, p);
      }
      if (newIdom !== -1 && idom[b] !== newIdom) {
        idom[b] = newIdom;
        changed = true;
      }
    }
  }

  // --- dominator-tree children + pre/post numbering for O(1) dominates -----
  const children: number[][] = Array.from({ length: n }, () => []);
  for (const b of rpo) {
    if (b !== 0 && idom[b] !== -1) children[idom[b]].push(b);
  }
  const treeIn = new Int32Array(n).fill(-1);
  const treeOut = new Int32Array(n).fill(-1);
  {
    let clock = 0;
    const stack: Array<[number, number]> = [[0, 0]];
    treeIn[0] = clock++;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const kids = children[frame[0]];
      if (frame[1] < kids.length) {
        const c = kids[frame[1]++];
        treeIn[c] = clock++;
        stack.push([c, 0]);
      } else {
        treeOut[frame[0]] = clock++;
        stack.pop();
      }
    }
  }

  // --- dominance frontiers (Cytron via the CHK runner loop) ----------------
  // No `preds >= 2` gate: a single-pred block's pred IS its idom, so the
  // runner loop is a free no-op there — and the gate would silently skip the
  // one degenerate shape it mishandles, an edge INTO the entry block (legal
  // in the IR, never emitted by today's producer). For that shape the
  // `idom[0] === 0` convention stops the runner before recording the entry's
  // own reflexive membership (0 dominates its pred, 0 does not strictly
  // dominate 0 ⇒ 0 ∈ DF(0) by definition), so it is added explicitly. The
  // naive cross-check computes frontiers from the definition and agrees.
  const frontier: number[][] = Array.from({ length: n }, () => []);
  for (const b of rpo) {
    for (const p of preds[b]) {
      let runner = p;
      while (runner !== idom[b]) {
        if (!frontier[runner].includes(b)) frontier[runner].push(b);
        runner = idom[runner];
      }
    }
  }
  if (preds[0].length > 0) frontier[0].push(0);

  const dominates = (a: number, b: number): boolean => {
    if (a < 0 || b < 0 || a >= n || b >= n) return false;
    if (!reachable[a] || !reachable[b]) return false;
    return treeIn[a] <= treeIn[b] && treeOut[b] <= treeOut[a];
  };

  return {
    reachable,
    rpo,
    idom: Array.from(idom),
    children,
    preds,
    frontier,
    dominates,
  };
}

// The IR is functional — passes return NEW IrFunction objects (or the same
// object when they change nothing), so identity-keyed caching IS the
// invalidation discipline: a mutated function is a different key, an
// untouched one is a hit. No explicit invalidation hook exists to forget.
const cache = new WeakMap<IrFunction, DominanceInfo>();

/** Cached {@link computeDominance}, keyed on `IrFunction` object identity. */
export function dominanceOf(fn: IrFunction): DominanceInfo {
  let info = cache.get(fn);
  if (info === undefined) {
    info = computeDominance(fn);
    cache.set(fn, info);
  }
  return info;
}

// ---------------------------------------------------------------------------
// Naive reference (tests + optional debug cross-check) — O(V·(V+E)) per
// function. `a` dominates `b` iff removing `a` disconnects `b` from the
// entry (with the reflexive case and entry handled by the walk itself).
// ---------------------------------------------------------------------------

/** Reference dominance: dom[b] = set of blocks dominating b. Test-sized. */
export function computeDominanceNaive(fn: IrFunction): Array<Set<number>> {
  const n = fn.blocks.length;
  const reachableWithout = (removed: number): boolean[] => {
    const seen: boolean[] = new Array(n).fill(false);
    if (removed === 0) return seen; // entry removed — nothing reachable
    const stack = [0];
    seen[0] = true;
    while (stack.length > 0) {
      const b = stack.pop()!;
      for (const s of blockSuccessors(fn.blocks[b])) {
        if (s >= 0 && s < n && s !== removed && !seen[s]) {
          seen[s] = true;
          stack.push(s);
        }
      }
    }
    return seen;
  };
  const baseline = reachableWithout(-1);
  const dom: Array<Set<number>> = Array.from({ length: n }, () => new Set());
  for (let a = 0; a < n; a++) {
    const seen = reachableWithout(a);
    for (let b = 0; b < n; b++) {
      if (!baseline[b] || !baseline[a]) continue; // only reachable pairs
      if (b === a || !seen[b]) dom[b].add(a);
    }
  }
  return dom;
}

/**
 * Cross-check the fast analysis against the naive reference. Returns a list
 * of human-readable disagreements (empty = agree). Exercised by the unit
 * tests on synthetic general graphs and available to the verifier behind
 * `JS2WASM_IR_VERIFY_DOMINANCE_NAIVE=1` for corpus-wide auditing.
 */
export function crossCheckDominance(fn: IrFunction, info: DominanceInfo): string[] {
  const errors: string[] = [];
  const n = fn.blocks.length;
  const naive = computeDominanceNaive(fn);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      const fast = info.dominates(a, b);
      const ref = info.reachable[a] && info.reachable[b] ? naive[b].has(a) : false;
      if (fast !== ref) {
        errors.push(`dominates(${a}, ${b}): fast=${fast} naive=${ref} in ${fn.name}`);
      }
    }
  }
  // Frontier per definition: b ∈ DF(a) iff a dominates some predecessor of b
  // and a does not strictly dominate b.
  for (let a = 0; a < n; a++) {
    if (!info.reachable[a]) continue;
    const expected = new Set<number>();
    for (let b = 0; b < n; b++) {
      if (!info.reachable[b]) continue;
      const strictly = a !== b && info.dominates(a, b);
      if (strictly) continue;
      if (info.preds[b].some((p) => info.dominates(a, p))) expected.add(b);
    }
    const got = new Set(info.frontier[a]);
    for (const b of expected) if (!got.has(b)) errors.push(`frontier[${a}] missing ${b} in ${fn.name}`);
    for (const b of got) if (!expected.has(b)) errors.push(`frontier[${a}] extra ${b} in ${fn.name}`);
  }
  return errors;
}
