// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import * as canonical from "../src/wasm/model/instruction-walk.js";
import * as legacy from "../src/codegen/walk-instructions.js";
import type { Instr } from "../src/wasm/model/instructions.js";

describe("canonical instruction walker compatibility facade", () => {
  for (const name of ["walkInstructions", "walkInstructionDag", "walkChildren"] as const)
    it(`preserves compatibility export identity ${name}`, () => {
      expect(legacy[name]).toBe(canonical[name]);
    });
});
describe("canonical instruction traversal semantics", () => {
  it("invokes the visitor before discovering the possibly replaced child arrays", () => {
    for (const walk of [canonical.walkInstructions, canonical.walkInstructionDag]) {
      const root: Instr = { op: "block", blockType: { kind: "empty" }, body: [{ op: "nop" }] };
      const replacement: Instr[] = [{ op: "drop" }, { op: "return" }],
        seen: string[] = [];
      walk([root], (instr) => {
        seen.push(instr.op);
        if (instr === root) root.body = replacement;
      });
      expect(seen).toEqual(["block", "drop", "return"]);
      expect(root.body).toBe(replacement);
    }
  });
  it("propagates the exact thrown sentinel and stops visiting", () => {
    for (const walk of [canonical.walkInstructions, canonical.walkInstructionDag]) {
      const sentinel = Object.freeze({ sentinel: "visitor" }),
        seen: string[] = [];
      let caught: unknown;
      try {
        walk([{ op: "nop" }, { op: "drop" }], (instr) => {
          seen.push(instr.op);
          throw sentinel;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
      expect(seen).toEqual(["nop"]);
    }
  });
  it("honors a caller-shared visited set across distinct roots and repeated roots", () => {
    const shared: Instr[] = [{ op: "nop" }],
      first: Instr[] = [{ op: "block", blockType: { kind: "empty" }, body: shared }],
      second: Instr[] = [{ op: "loop", blockType: { kind: "empty" }, body: shared }];
    const visited = new WeakSet<Instr[]>(),
      seen: string[] = [];
    for (const root of [first, second, first, shared])
      canonical.walkInstructionDag(root, (instr) => seen.push(instr.op), visited);
    expect(seen).toEqual(["block", "nop", "loop"]);
    expect(visited.has(first) && visited.has(second) && visited.has(shared)).toBe(true);
  });
  it("preserves reverse-push marking when sibling child arrays share identity", () => {
    const shared: Instr[] = [{ op: "nop" }],
      middle: Instr[] = [{ op: "drop" }];
    const root: Instr[] = [
      {
        op: "try",
        blockType: { kind: "empty" },
        body: shared,
        catches: [{ tagIdx: 0, body: middle }],
        catchAll: shared,
      },
    ];
    const tree: string[] = [],
      dag: string[] = [];
    canonical.walkInstructions(root, (instr) => tree.push(instr.op));
    canonical.walkInstructionDag(root, (instr) => dag.push(instr.op));
    expect(tree).toEqual(["try", "nop", "drop", "nop"]);
    // The walker marks the rightmost shared array while pushing in reverse,
    // so the earlier occurrence is skipped before traversal begins.
    expect(dag).toEqual(["try", "drop", "nop"]);
  });
  it("preserves preorder, sibling order, catches and catchAll", () => {
    const root: Instr[] = [
      {
        op: "try",
        blockType: { kind: "empty" },
        body: [{ op: "if", blockType: { kind: "empty" }, then: [{ op: "nop" }], else: [{ op: "drop" }] }],
        catches: [{ tagIdx: 0, body: [{ op: "return" }] }],
        catchAll: [{ op: "unreachable" }],
      },
    ];
    const order: string[] = [];
    canonical.walkInstructions(root, (i) => order.push(i.op));
    expect(order).toEqual(["try", "if", "nop", "drop", "return", "unreachable"]);
  });
  it("distinguishes occurrence traversal from physical-array DAG traversal", () => {
    const shared: Instr[] = [{ op: "nop" }];
    const root: Instr[] = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
    const tree: string[] = [],
      dag: string[] = [];
    canonical.walkInstructions(root, (i) => tree.push(i.op));
    canonical.walkInstructionDag(root, (i) => dag.push(i.op));
    expect(tree).toEqual(["if", "nop", "nop"]);
    expect(dag).toEqual(["if", "nop"]);
  });
  it("retains allocation census across shared function/global roots", () => {
    const shared: Instr[] = [{ op: "struct.new", typeIdx: 7 }];
    const module = {
      functions: [{ body: shared }, { body: shared }],
      globals: [{ init: shared }, { init: [{ op: "struct.new", typeIdx: 9 }] }],
    } as Parameters<typeof legacy.allocatedStructTypeIndices>[0];
    expect([...legacy.allocatedStructTypeIndices(module)]).toEqual([7, 9]);
  });
});
