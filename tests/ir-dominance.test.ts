// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4418 — dominance analysis unit tests.
//
// Two layers:
//   1. Synthetic GENERAL graphs (joins, back-edges, self-loops, unreachable
//      blocks, both-arms br_if) with hand-computed idoms/frontiers, each also
//      cross-checked against the naive reachability-based reference. Today's
//      producer emits none of these shapes (ADR-0018 keeps loops/ifs in
//      nested buffers), but the analysis must be correct for any graph so it
//      cannot silently rot if a future producer emits joins.
//   2. The ADR-0018 invariant itself, asserted on a producer-shaped graph:
//      join-free ⇒ every reachable non-entry block has exactly one
//      predecessor, the dominator tree equals the CFG tree, and every
//      dominance frontier is empty.
import { describe, expect, it } from "vitest";
import {
  blockSuccessors,
  computeDominance,
  crossCheckDominance,
  dominanceOf,
  rawPredecessorCounts,
} from "../src/ir/analysis/dominance.js";
import type { IrBlock, IrFunction, IrTerminator } from "../src/ir/nodes.js";
import { asBlockId } from "../src/ir/nodes.js";

// -- tiny graph builder ------------------------------------------------------
// Only ids and terminators matter to dominance; everything else is empty.

function ret(): IrTerminator {
  return { kind: "return", values: [] };
}
function br(target: number): IrTerminator {
  return { kind: "br", branch: { target: asBlockId(target), args: [] } };
}
function brIf(ifTrue: number, ifFalse: number): IrTerminator {
  return {
    kind: "br_if",
    condition: 0 as never,
    ifTrue: { target: asBlockId(ifTrue), args: [] },
    ifFalse: { target: asBlockId(ifFalse), args: [] },
  };
}

function graph(name: string, terminators: IrTerminator[]): IrFunction {
  const blocks: IrBlock[] = terminators.map((terminator, i) => ({
    id: asBlockId(i),
    blockArgs: [],
    blockArgTypes: [],
    instrs: [],
    terminator,
  }));
  return {
    name,
    params: [],
    resultTypes: [],
    blocks,
    exported: false,
    valueCount: 0,
  } as unknown as IrFunction;
}

/** Assert fast === naive across every pair + the frontier definition. */
function agreesWithNaive(fn: IrFunction): void {
  const info = computeDominance(fn);
  expect(crossCheckDominance(fn, info)).toEqual([]);
}

describe("#4418 dominance — synthetic general graphs", () => {
  it("straight line: 0 → 1 → 2", () => {
    const fn = graph("line", [br(1), br(2), ret()]);
    const d = computeDominance(fn);
    expect(d.idom).toEqual([0, 0, 1]);
    expect(d.frontier).toEqual([[], [], []]);
    expect(d.dominates(0, 2)).toBe(true);
    expect(d.dominates(2, 0)).toBe(false);
    expect(d.dominates(1, 1)).toBe(true); // reflexive
    agreesWithNaive(fn);
  });

  it("diamond: 0 → (1|2) → 3 — the join's idom is the fork", () => {
    const fn = graph("diamond", [brIf(1, 2), br(3), br(3), ret()]);
    const d = computeDominance(fn);
    expect(d.idom).toEqual([0, 0, 0, 0]); // neither arm dominates the join
    expect(d.frontier[1]).toEqual([3]);
    expect(d.frontier[2]).toEqual([3]);
    expect(d.frontier[3]).toEqual([]);
    expect(d.dominates(1, 3)).toBe(false);
    expect(d.dominates(0, 3)).toBe(true);
    agreesWithNaive(fn);
  });

  it("loop: 0 → 1(header) → (2(body) → 1 | 3(exit)) — back-edge", () => {
    const fn = graph("loop", [br(1), brIf(2, 3), br(1), ret()]);
    const d = computeDominance(fn);
    expect(d.idom).toEqual([0, 0, 1, 1]);
    // The header is in its own frontier (it is a join of entry + back-edge
    // it does not strictly dominate itself) and in the body's.
    expect(d.frontier[1]).toEqual([1]);
    expect(d.frontier[2]).toEqual([1]);
    expect(d.dominates(1, 2)).toBe(true);
    expect(d.dominates(2, 3)).toBe(false);
    agreesWithNaive(fn);
  });

  it("nested loops: outer header dominates inner, frontiers chain", () => {
    // 0 → 1(outer) → 2(inner) → (2 | 3) ; 3 → (1 | 4) ; 4 ret
    const fn = graph("nested", [br(1), br(2), brIf(2, 3), brIf(1, 4), ret()]);
    const d = computeDominance(fn);
    expect(d.idom).toEqual([0, 0, 1, 2, 3]);
    expect(d.frontier[2]).toEqual(expect.arrayContaining([2]));
    expect(d.frontier[3]).toEqual(expect.arrayContaining([1]));
    agreesWithNaive(fn);
  });

  it("unreachable block: excluded from everything, never dominates", () => {
    const fn = graph("unreach", [br(2), ret(), ret()]); // block 1 unreachable
    const d = computeDominance(fn);
    expect(d.reachable).toEqual([true, false, true]);
    expect(d.idom[1]).toBe(-1);
    expect(d.rpo).not.toContain(1);
    expect(d.dominates(0, 1)).toBe(false);
    expect(d.dominates(1, 2)).toBe(false);
    agreesWithNaive(fn);
  });

  it("br_if with both arms on one target contributes a single deduped edge", () => {
    const fn = graph("botharms", [brIf(1, 1), ret()]);
    const d = computeDominance(fn);
    expect(blockSuccessors(fn.blocks[0])).toEqual([1]);
    expect(d.preds[1]).toEqual([0]);
    expect(d.idom).toEqual([0, 0]);
    expect(d.frontier).toEqual([[], []]);
    // ...but the RAW count simplify-cfg merges on still sees two edges.
    expect(Array.from(rawPredecessorCounts(fn))).toEqual([0, 2]);
    agreesWithNaive(fn);
  });

  it("self-loop: 0 → 1 → (1 | 2)", () => {
    const fn = graph("selfloop", [br(1), brIf(1, 2), ret()]);
    const d = computeDominance(fn);
    expect(d.idom).toEqual([0, 0, 1]);
    expect(d.frontier[1]).toEqual([1]); // joins itself via its own back-edge
    agreesWithNaive(fn);
  });

  it("edge into the entry block: reflexive entry frontier (degenerate, legal)", () => {
    const fn = graph("entryloop", [brIf(1, 2), br(0), ret()]);
    const d = computeDominance(fn);
    expect(d.idom).toEqual([0, 0, 0]);
    // 0 dominates its predecessor 1 and does not strictly dominate itself,
    // so 0 ∈ DF(0) and DF(1) by definition.
    expect(d.frontier[0]).toEqual([0]);
    expect(d.frontier[1]).toEqual([0]);
    agreesWithNaive(fn);
  });

  it("irreducible-ish double entry into a cycle still converges", () => {
    // 0 → (1 | 2); 1 → 3; 2 → 4; 3 → 4; 4 → (3 | 5); 5 ret
    // {3,4} form a cycle entered at both 3 and 4 — the classic irreducible
    // shape. Neither 3 nor 4 dominates the other; both idoms land on 0.
    const fn = graph("irreducible", [brIf(1, 2), br(3), br(4), br(4), brIf(3, 5), ret()]);
    const d = computeDominance(fn);
    expect(d.idom).toEqual([0, 0, 0, 0, 0, 4]);
    agreesWithNaive(fn);
  });

  it("empty function and single-block function", () => {
    const empty = graph("empty", []);
    expect(computeDominance(empty).rpo).toEqual([]);
    const single = graph("single", [ret()]);
    const d = computeDominance(single);
    expect(d.idom).toEqual([0]);
    expect(d.dominates(0, 0)).toBe(true);
    agreesWithNaive(single);
  });

  it("throws on non-contiguous block ids (the verify.ts invariant)", () => {
    const fn = graph("badids", [br(1), ret()]);
    (fn.blocks[1] as { id: number }).id = 7;
    expect(() => computeDominance(fn)).toThrow(/contiguous/);
  });
});

describe("#4418 dominance — caching", () => {
  it("dominanceOf is identity-cached: same object → same info, new object → recomputed", () => {
    const fn = graph("cached", [br(1), ret()]);
    const a = dominanceOf(fn);
    expect(dominanceOf(fn)).toBe(a);
    const fn2 = graph("cached", [br(1), ret()]);
    expect(dominanceOf(fn2)).not.toBe(a);
  });
});

describe("#4418 dominance — the ADR-0018 producer invariant", () => {
  it("join-free tail-shaped graphs: dom tree === CFG tree, all frontiers empty", () => {
    // The exact shape lower.ts documents: entry br_if into two tail-shaped
    // arms, one of which nests another br_if. No joins anywhere.
    //   0 → (1 | 2); 1 ret; 2 → (3 | 4); 3 ret; 4 ret
    const fn = graph("adr0018", [brIf(1, 2), ret(), brIf(3, 4), ret(), ret()]);
    const d = computeDominance(fn);
    for (const b of d.rpo) {
      if (b === 0) continue;
      expect(d.preds[b], `block ${b} preds`).toHaveLength(1);
      expect(d.idom[b], `block ${b} idom`).toBe(d.preds[b][0]);
      expect(d.frontier[b], `block ${b} frontier`).toEqual([]);
    }
    expect(d.frontier[0]).toEqual([]);
    agreesWithNaive(fn);
  });
});
