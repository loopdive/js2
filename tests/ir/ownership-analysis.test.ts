// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1587 — intra-procedural ownership + access analysis.
//
// Covers the lattices (join / order / access union) and the seven IR fragments
// the acceptance criteria call out:
//   simple allocation, escape via return, escape via store-to-heap, escape via
//   opaque call, mutation via field store, conditional escape via branching,
//   loop-carried allocation.

import { describe, expect, it } from "vitest";

import {
  AccessSet,
  AllocSiteRegistry,
  IrFunctionBuilder,
  analyzeOwnership,
  findStackAllocCandidates,
  irVal,
  joinOwnership,
  ownershipLeq,
  type IrObjectShape,
  type IrType,
  type IrValueId,
} from "../../src/ir/index.js";
import { createTestIrFunctionIdentityFactory } from "../helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("ir/ownership-analysis");
const F64: IrType = irVal({ kind: "f64" });

const OBJ_SHAPE: IrObjectShape = { fields: [{ name: "x", type: F64 }] };
const OBJ_TYPE: IrType = { kind: "object", shape: OBJ_SHAPE };

/** Build a one-block function returning `values`, given a body emitter. */
function buildFn(
  emit: (b: IrFunctionBuilder) => IrValueId[],
  opts: { params?: number; resultTypes?: readonly IrType[] } = {},
) {
  const reg = new AllocSiteRegistry();
  const b = new IrFunctionBuilder(identities.next("f"), opts.resultTypes ?? [], false, reg);
  for (let i = 0; i < (opts.params ?? 0); i++) b.addParam(`p${i}`, OBJ_TYPE);
  b.openBlock();
  const ret = emit(b);
  b.terminate({ kind: "return", values: ret });
  return { fn: b.finish(), reg };
}

describe("#1587 — ownership / access lattices", () => {
  it("ownership join is the more-conservative of two states", () => {
    expect(joinOwnership("owned", "borrowed")).toBe("borrowed");
    expect(joinOwnership("borrowed", "shared")).toBe("shared");
    expect(joinOwnership("shared", "escaped")).toBe("escaped");
    expect(joinOwnership("owned", "owned")).toBe("owned");
    // commutative
    expect(joinOwnership("escaped", "owned")).toBe("escaped");
  });

  it("ownership order is owned ⊑ borrowed ⊑ shared ⊑ escaped", () => {
    expect(ownershipLeq("owned", "escaped")).toBe(true);
    expect(ownershipLeq("shared", "borrowed")).toBe(false);
    expect(ownershipLeq("borrowed", "borrowed")).toBe(true);
  });

  it("access set union is join; subset is the order", () => {
    const rw = AccessSet.of("read", "write");
    const r = AccessSet.of("read");
    expect(r.subsetOf(rw)).toBe(true);
    expect(rw.subsetOf(r)).toBe(false);
    expect(r.union(AccessSet.of("write")).equals(rw)).toBe(true);
    expect(AccessSet.empty().toArray()).toEqual([]);
    expect(AccessSet.full().has("escape")).toBe(true);
  });
});

describe("#1587 — analysis on IR fragments", () => {
  it("simple allocation that does not escape stays owned with no escape access", () => {
    // const o = {x: 1}; return 1  (o never used after construction)
    const { fn } = buildFn(
      (b) => {
        const one = b.emitConst({ kind: "f64", value: 1 }, F64);
        b.emitObjectNew(OBJ_SHAPE, [one]);
        return [one];
      },
      { resultTypes: [F64] },
    );
    const objInstr = fn.blocks[0]!.instrs.find((i) => i.kind === "object.new")!;
    const r = analyzeOwnership(fn);
    expect(r.ownershipOf(objInstr.result!)).toBe("owned");
    expect(r.accessOf(objInstr.result!).has("escape")).toBe(false);
    expect(r.isStackAllocatable(objInstr.result!)).toBe(true);
  });

  it("escape via return marks the allocation escaped", () => {
    // const o = {x: 1}; return o
    const { fn } = buildFn(
      (b) => {
        const one = b.emitConst({ kind: "f64", value: 1 }, F64);
        const o = b.emitObjectNew(OBJ_SHAPE, [one]);
        return [o];
      },
      { resultTypes: [OBJ_TYPE] },
    );
    const objInstr = fn.blocks[0]!.instrs.find((i) => i.kind === "object.new")!;
    const r = analyzeOwnership(fn);
    expect(r.ownershipOf(objInstr.result!)).toBe("escaped");
    expect(r.accessOf(objInstr.result!).has("escape")).toBe(true);
    expect(r.isStackAllocatable(objInstr.result!)).toBe(false);
  });

  it("escape via store-to-heap: a value stored into an object's field escapes", () => {
    // const outer = {x:0}; const inner = {x:1}; outer.x = inner; return outer
    const { fn } = buildFn(
      (b) => {
        const zero = b.emitConst({ kind: "f64", value: 0 }, F64);
        const outer = b.emitObjectNew(OBJ_SHAPE, [zero]);
        const one = b.emitConst({ kind: "f64", value: 1 }, F64);
        const inner = b.emitObjectNew(OBJ_SHAPE, [one]);
        b.emitObjectSet(outer, "x", inner);
        return [outer];
      },
      { resultTypes: [OBJ_TYPE] },
    );
    const objInstrs = fn.blocks[0]!.instrs.filter((i) => i.kind === "object.new");
    const outerV = objInstrs[0]!.result!;
    const innerV = objInstrs[1]!.result!;
    const r = analyzeOwnership(fn);
    // outer is written (write access) and returned (escaped).
    expect(r.accessOf(outerV).has("write")).toBe(true);
    expect(r.ownershipOf(outerV)).toBe("escaped");
    // inner escaped because it was stored into outer's field.
    expect(r.ownershipOf(innerV)).toBe("escaped");
    expect(r.accessOf(innerV).has("escape")).toBe(true);
  });

  it("escape via opaque call: an allocation passed to a call escapes with full intent", () => {
    // const o = {x:1}; sink(o)
    const { fn } = buildFn((b) => {
      const one = b.emitConst({ kind: "f64", value: 1 }, F64);
      const o = b.emitObjectNew(OBJ_SHAPE, [one]);
      b.emitCall({ kind: "func", name: "sink" }, [o], null);
      return [];
    });
    const objInstr = fn.blocks[0]!.instrs.find((i) => i.kind === "object.new")!;
    const r = analyzeOwnership(fn);
    expect(r.ownershipOf(objInstr.result!)).toBe("escaped");
    expect(r.accessOf(objInstr.result!).has("escape")).toBe(true);
  });

  it("mutation via field store: receiver gains write access", () => {
    // const o = {x:0}; o.x = 1  (o not returned — owned but written)
    const { fn } = buildFn((b) => {
      const zero = b.emitConst({ kind: "f64", value: 0 }, F64);
      const o = b.emitObjectNew(OBJ_SHAPE, [zero]);
      const one = b.emitConst({ kind: "f64", value: 1 }, F64);
      b.emitObjectSet(o, "x", one);
      return [];
    });
    const objInstr = fn.blocks[0]!.instrs.find((i) => i.kind === "object.new")!;
    const r = analyzeOwnership(fn);
    expect(r.accessOf(objInstr.result!).has("write")).toBe(true);
    // Written but never escaped → still owned, still stack-allocatable.
    expect(r.ownershipOf(objInstr.result!)).toBe("owned");
    expect(r.isStackAllocatable(objInstr.result!)).toBe(true);
  });

  it("conditional escape: an allocation escaping on one branch is escaped at the merge", () => {
    // entry: o = {x:1}; br_if c -> esc(o) / noesc
    // esc: sink(o); br exit
    // noesc: br exit
    // exit: return
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [], false, reg);
    const c = b.addParam("c", irVal({ kind: "i32" }));
    const esc = b.reserveBlockId();
    const noesc = b.reserveBlockId();
    const exit = b.reserveBlockId();

    b.openBlock();
    const one = b.emitConst({ kind: "f64", value: 1 }, F64);
    const o = b.emitObjectNew(OBJ_SHAPE, [one]);
    b.terminate({
      kind: "br_if",
      condition: c,
      ifTrue: { target: esc, args: [] },
      ifFalse: { target: noesc, args: [] },
    });

    b.openReservedBlock(esc);
    b.emitCall({ kind: "func", name: "sink" }, [o], null);
    b.terminate({ kind: "br", branch: { target: exit, args: [] } });

    b.openReservedBlock(noesc);
    b.terminate({ kind: "br", branch: { target: exit, args: [] } });

    b.openReservedBlock(exit);
    b.terminate({ kind: "return", values: [] });

    const fn = b.finish();
    const objInstr = fn.blocks.flatMap((bl) => bl.instrs).find((i) => i.kind === "object.new")!;
    const r = analyzeOwnership(fn);
    // Meet-over-paths: escapes on the `esc` branch ⇒ escaped overall.
    expect(r.ownershipOf(objInstr.result!)).toBe("escaped");
    expect(r.isStackAllocatable(objInstr.result!)).toBe(false);
  });

  it("loop-carried allocation that escapes via call inside the loop is escaped", () => {
    // entry: br loop
    // loop: o = {x:1}; sink(o); br_if c -> loop / exit
    // exit: return
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [], false, reg);
    const c = b.addParam("c", irVal({ kind: "i32" }));
    const loop = b.reserveBlockId();
    const exit = b.reserveBlockId();

    b.openBlock();
    b.terminate({ kind: "br", branch: { target: loop, args: [] } });

    b.openReservedBlock(loop);
    const one = b.emitConst({ kind: "f64", value: 1 }, F64);
    const o = b.emitObjectNew(OBJ_SHAPE, [one]);
    b.emitCall({ kind: "func", name: "sink" }, [o], null);
    b.terminate({
      kind: "br_if",
      condition: c,
      ifTrue: { target: loop, args: [] },
      ifFalse: { target: exit, args: [] },
    });

    b.openReservedBlock(exit);
    b.terminate({ kind: "return", values: [] });

    const fn = b.finish();
    const objInstr = fn.blocks.flatMap((bl) => bl.instrs).find((i) => i.kind === "object.new")!;
    const r = analyzeOwnership(fn);
    expect(r.ownershipOf(objInstr.result!)).toBe("escaped");
  });

  it("writes the ownership annotation to the registry namespace", () => {
    const { fn, reg } = buildFn(
      (b) => {
        const one = b.emitConst({ kind: "f64", value: 1 }, F64);
        const o = b.emitObjectNew(OBJ_SHAPE, [one]);
        return [o];
      },
      { resultTypes: [OBJ_TYPE] },
    );
    const objInstr = fn.blocks[0]!.instrs.find((i) => i.kind === "object.new")!;
    analyzeOwnership(fn, reg);
    const annot = reg.read<{ state: string; ops: string[] }>(objInstr.alloc!, "ownership");
    expect(annot).toBeDefined();
    expect(annot!.state).toBe("escaped");
    expect(annot!.ops).toContain("escape");
  });

  it("demonstration consumer: an owned non-escaped object is a stack-alloc candidate", () => {
    const { fn, reg } = buildFn((b) => {
      const zero = b.emitConst({ kind: "f64", value: 0 }, F64);
      const o = b.emitObjectNew(OBJ_SHAPE, [zero]);
      const one = b.emitConst({ kind: "f64", value: 1 }, F64);
      b.emitObjectSet(o, "x", one); // mutated but never escapes
      return [];
    });
    const objInstr = fn.blocks[0]!.instrs.find((i) => i.kind === "object.new")!;
    const candidates = findStackAllocCandidates(fn, reg);
    expect(candidates.map((c) => c.allocId)).toContain(objInstr.alloc! as unknown as number);
    expect(candidates[0]!.kind).toBe("object");
    // The marker is merged into the ownership annotation.
    const annot = reg.read<{ stackCandidate?: boolean }>(objInstr.alloc!, "ownership");
    expect(annot!.stackCandidate).toBe(true);
  });

  it("demonstration consumer: an escaped object is NOT a stack-alloc candidate", () => {
    const { fn, reg } = buildFn(
      (b) => {
        const one = b.emitConst({ kind: "f64", value: 1 }, F64);
        const o = b.emitObjectNew(OBJ_SHAPE, [one]);
        return [o]; // escapes via return
      },
      { resultTypes: [OBJ_TYPE] },
    );
    const candidates = findStackAllocCandidates(fn, reg);
    expect(candidates).toEqual([]);
  });

  it("a function parameter is seeded shared/read, never owned", () => {
    const { fn } = buildFn(
      (b) => {
        return [];
      },
      { params: 1 },
    );
    const p0 = fn.params[0]!.value;
    const r = analyzeOwnership(fn);
    expect(r.ownershipOf(p0)).toBe("shared");
    expect(r.accessOf(p0).has("read")).toBe(true);
    expect(r.isStackAllocatable(p0)).toBe(false);
  });
});
