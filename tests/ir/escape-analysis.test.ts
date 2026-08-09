// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #747 — escape analysis (built on #1587 ownership). Classifies each allocation
// as local / returned / stored / captured / opaque and marks the `local` ones
// as stack-allocatable. Covers each classification path + the registry
// write-back.

import { describe, expect, it } from "vitest";

import {
  AllocSiteRegistry,
  IrFunctionBuilder,
  analyzeEscape,
  irVal,
  type IrObjectShape,
  type IrType,
  type IrValueId,
} from "../../src/ir/index.js";
import { createTestIrFunctionIdentityFactory } from "../helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("ir/escape-analysis");
const F64: IrType = irVal({ kind: "f64" });
const OBJ_SHAPE: IrObjectShape = { fields: [{ name: "x", type: F64 }] };
const OBJ_TYPE: IrType = { kind: "object", shape: OBJ_SHAPE };

function buildFn(emit: (b: IrFunctionBuilder) => IrValueId[], opts: { resultTypes?: readonly IrType[] } = {}) {
  const reg = new AllocSiteRegistry();
  const b = new IrFunctionBuilder(identities.next("f"), opts.resultTypes ?? [], false, reg);
  b.openBlock();
  const ret = emit(b);
  b.terminate({ kind: "return", values: ret });
  return { fn: b.finish(), reg };
}

describe("#747 — escape analysis", () => {
  it("an object that never escapes is classified local + stack-allocatable", () => {
    const { fn } = buildFn((b) => {
      const zero = b.emitConst({ kind: "f64", value: 0 }, F64);
      const o = b.emitObjectNew(OBJ_SHAPE, [zero]);
      const one = b.emitConst({ kind: "f64", value: 1 }, F64);
      b.emitObjectSet(o, "x", one); // mutated, but never escapes
      return [];
    });
    const obj = fn.blocks[0]!.instrs.find((i) => i.kind === "object.new")!;
    const r = analyzeEscape(fn);
    const info = r.of(obj.result!)!;
    expect(info.classification).toBe("local");
    expect(info.stackAllocatable).toBe(true);
    expect(r.localAllocations()).toContain(obj.result!);
  });

  it("returned via the block terminator → returned", () => {
    const { fn } = buildFn(
      (b) => {
        const one = b.emitConst({ kind: "f64", value: 1 }, F64);
        const o = b.emitObjectNew(OBJ_SHAPE, [one]);
        return [o];
      },
      { resultTypes: [OBJ_TYPE] },
    );
    const obj = fn.blocks[0]!.instrs.find((i) => i.kind === "object.new")!;
    const r = analyzeEscape(fn);
    expect(r.classOf(obj.result!)).toBe("returned");
    expect(r.of(obj.result!)!.stackAllocatable).toBe(false);
  });

  it("stored into another object's field → stored", () => {
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
    const objs = fn.blocks[0]!.instrs.filter((i) => i.kind === "object.new");
    const inner = objs[1]!.result!;
    const r = analyzeEscape(fn);
    expect(r.classOf(inner)).toBe("stored");
  });

  it("passed to an opaque call → opaque", () => {
    const { fn } = buildFn((b) => {
      const one = b.emitConst({ kind: "f64", value: 1 }, F64);
      const o = b.emitObjectNew(OBJ_SHAPE, [one]);
      b.emitCall({ kind: "func", name: "sink" }, [o], null);
      return [];
    });
    const obj = fn.blocks[0]!.instrs.find((i) => i.kind === "object.new")!;
    const r = analyzeEscape(fn);
    expect(r.classOf(obj.result!)).toBe("opaque");
  });

  it("captured by a closure → captured", () => {
    const { fn } = buildFn((b) => {
      const one = b.emitConst({ kind: "f64", value: 1 }, F64);
      const o = b.emitObjectNew(OBJ_SHAPE, [one]);
      const sig = { params: [] as readonly IrType[], returnType: F64 };
      b.emitClosureNew({ kind: "func", name: "lifted" }, sig, [OBJ_TYPE], [o]);
      return [];
    });
    const obj = fn.blocks[0]!.instrs.find((i) => i.kind === "object.new")!;
    const r = analyzeEscape(fn);
    expect(r.classOf(obj.result!)).toBe("captured");
  });

  it("the strongest edge wins when an allocation both stores and returns", () => {
    // inner is stored into outer (stored) — outer itself is returned. inner's
    // own classification is `stored` (the field-store edge), not `returned`.
    const { fn } = buildFn(
      (b) => {
        const zero = b.emitConst({ kind: "f64", value: 0 }, F64);
        const outer = b.emitObjectNew(OBJ_SHAPE, [zero]);
        const one = b.emitConst({ kind: "f64", value: 1 }, F64);
        const inner = b.emitObjectNew(OBJ_SHAPE, [one]);
        b.emitObjectSet(outer, "x", inner);
        // also pass inner to an opaque call → opaque outranks stored
        b.emitCall({ kind: "func", name: "sink" }, [inner], null);
        return [outer];
      },
      { resultTypes: [OBJ_TYPE] },
    );
    const objs = fn.blocks[0]!.instrs.filter((i) => i.kind === "object.new");
    const inner = objs[1]!.result!;
    const r = analyzeEscape(fn);
    expect(r.classOf(inner)).toBe("opaque");
  });

  it("writes the classification to the registry escape namespace", () => {
    const { fn, reg } = buildFn(
      (b) => {
        const one = b.emitConst({ kind: "f64", value: 1 }, F64);
        const o = b.emitObjectNew(OBJ_SHAPE, [one]);
        return [o];
      },
      { resultTypes: [OBJ_TYPE] },
    );
    const obj = fn.blocks[0]!.instrs.find((i) => i.kind === "object.new")!;
    analyzeEscape(fn, reg);
    const annot = reg.read<{ classification: string; stackAllocatable: boolean }>(obj.alloc!, "escape");
    expect(annot).toBeDefined();
    expect(annot!.classification).toBe("returned");
    expect(annot!.stackAllocatable).toBe(false);
  });
});
