// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1586 — allocation-site provenance through passes + invariant checker.
//
// Covers:
//   - The builder mints an AllocSiteId on a value-creating instr (string.const).
//   - verifyAllocProvenance passes on a well-formed function.
//   - DCE retires the id of a dropped allocation; the checker still passes
//     (no stale live reference) and the dropped site resolves to null.
//   - The checker FAILS on a deliberately-broken function: a live alloc instr
//     whose id was retired out from under it (pass-discipline drift).

import { describe, expect, it } from "vitest";

import {
  AllocSiteRegistry,
  IrFunctionBuilder,
  assertAllocProvenance,
  assertFinalAllocProvenance,
  asAllocSiteId,
  irVal,
  verifyAllocProvenance,
  type IrFunction,
  type IrType,
  type IrValueId,
} from "../../src/ir/index.js";
import { deadCode } from "../../src/ir/passes/dead-code.js";
import { createTestIrFunctionIdentityFactory } from "../helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("ir/alloc-provenance");
const F64: IrType = irVal({ kind: "f64" });

describe("#1586 — alloc provenance", () => {
  it("the builder mints an AllocSiteId on string.const and the checker passes", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [{ kind: "string" }], false, reg);
    b.openBlock();
    const s = b.emitStringConst("hi");
    b.terminate({ kind: "return", values: [s] });
    const fn = b.finish();

    const strInstr = fn.blocks[0]!.instrs.find((i) => i.kind === "string.const")!;
    expect(strInstr.alloc).toBeDefined();
    expect(reg.resolve(strInstr.alloc!)).not.toBeNull();
    expect(reg.resolve(strInstr.alloc!)!.kind).toBe("string");

    expect(verifyAllocProvenance(fn, reg)).toEqual([]);
  });

  it("DCE retires the id of a dropped (dead) allocation; checker stays clean", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [F64], false, reg);
    b.openBlock();
    // Dead string allocation — its result is never used.
    const dead = b.emitStringConst("dead");
    const live = b.emitConst({ kind: "f64", value: 1 }, F64);
    void dead;
    b.terminate({ kind: "return", values: [live] });
    const fn = b.finish();

    const deadInstr = fn.blocks[0]!.instrs.find((i) => i.kind === "string.const")!;
    const deadId = deadInstr.alloc!;
    expect(reg.resolve(deadId)).not.toBeNull();

    const after = deadCode(fn, reg);
    // The dead string.const is gone.
    expect(after.blocks[0]!.instrs.some((i) => i.kind === "string.const")).toBe(false);
    // Its id is retired.
    expect(reg.resolve(deadId)).toBeNull();
    // No surviving instr references a stale id.
    expect(verifyAllocProvenance(after, reg)).toEqual([]);
  });

  it("checker flags a live alloc instr whose id was retired (discipline drift)", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [{ kind: "string" }], false, reg);
    b.openBlock();
    const s = b.emitStringConst("hi");
    b.terminate({ kind: "return", values: [s] });
    const fn = b.finish();

    const strInstr = fn.blocks[0]!.instrs.find((i) => i.kind === "string.const")!;
    // Simulate a buggy pass that retired the id but left the live instr in place.
    reg.retire(strInstr.alloc!);

    const errors = verifyAllocProvenance(fn, reg);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/stale provenance|retired/);
  });

  it("the throwing producer preserves a stable typed invariant code", () => {
    const original = process.env.IR_VERIFY_ALLOC;
    process.env.IR_VERIFY_ALLOC = "1";
    try {
      const reg = new AllocSiteRegistry();
      const b = new IrFunctionBuilder(identities.next("f"), [{ kind: "string" }], false, reg);
      b.openBlock();
      const s = b.emitStringConst("hi");
      b.terminate({ kind: "return", values: [s] });
      const fn = b.finish();
      const strInstr = fn.blocks[0]!.instrs.find((instr) => instr.kind === "string.const")!;
      reg.retire(strInstr.alloc!);

      try {
        assertAllocProvenance(fn, reg);
        throw new Error("expected assertAllocProvenance to throw");
      } catch (error) {
        expect(error).toMatchObject({
          name: "IrInvariantError",
          kind: "invariant",
          code: "allocation-provenance-failure",
          stage: "verify",
        });
      }
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.env, "IR_VERIFY_ALLOC");
      else process.env.IR_VERIFY_ALLOC = original;
    }
  });

  it("keeps intermediate assertions optional while the final assertion is required", () => {
    const original = process.env.IR_VERIFY_ALLOC;
    Reflect.deleteProperty(process.env, "IR_VERIFY_ALLOC");
    try {
      const reg = new AllocSiteRegistry();
      const b = new IrFunctionBuilder(identities.next("f"), [{ kind: "string" }], false, reg);
      b.openBlock();
      const s = b.emitStringConst("final");
      b.terminate({ kind: "return", values: [s] });
      const fn = b.finish();
      const strInstr = fn.blocks[0]!.instrs.find((instr) => instr.kind === "string.const")!;
      reg.retire(strInstr.alloc!);

      expect(() => assertAllocProvenance(fn, reg)).not.toThrow();
      expect(() => assertFinalAllocProvenance(fn, reg)).toThrowError(
        expect.objectContaining({
          name: "IrInvariantError",
          code: "allocation-provenance-failure",
          stage: "verify",
        }),
      );
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.env, "IR_VERIFY_ALLOC");
      else process.env.IR_VERIFY_ALLOC = original;
    }
  });

  it("checker flags an allocation instr missing its id entirely", () => {
    const reg = new AllocSiteRegistry();
    // Build WITHOUT a registry so the string.const carries no alloc id.
    const b = new IrFunctionBuilder(identities.next("f"), [{ kind: "string" }]);
    b.openBlock();
    const s = b.emitStringConst("hi");
    b.terminate({ kind: "return", values: [s] });
    const fn: IrFunction = b.finish();

    const errors = verifyAllocProvenance(fn, reg);
    expect(errors.some((e) => /missing an AllocSiteId/.test(e.message))).toBe(true);
  });

  it("checker flags a dangling id (unknown to the registry)", () => {
    const reg = new AllocSiteRegistry();
    const b = new IrFunctionBuilder(identities.next("f"), [{ kind: "string" }], false, reg);
    b.openBlock();
    const s = b.emitStringConst("hi");
    b.terminate({ kind: "return", values: [s] });
    const fn = b.finish();

    // Forge an instr with an id that was never minted.
    const block = fn.blocks[0]!;
    const forged = block.instrs.map((i) => (i.kind === "string.const" ? { ...i, alloc: asAllocSiteId(424242) } : i));
    const broken: IrFunction = {
      ...fn,
      blocks: [{ ...block, instrs: forged }],
    };
    void s;

    const errors = verifyAllocProvenance(broken, reg);
    expect(errors.some((e) => /dangling/.test(e.message))).toBe(true);
  });
});
