// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Candidate-only binding observation. Never collected as a baseline skip or equality row.
import { describe, expect, it, vi } from "vitest";
import type { IrInstr } from "../src/ir/core/nodes.js";
import {
  allocationEvidenceRule,
  allocationEvidenceOperand,
  allocationEvidenceEffect,
} from "../src/ir/analysis/allocation-evidence/effect-rules.js";
import { AllocSiteRegistry, ALLOC_NAMESPACES } from "../src/ir/analysis/alloc-registry.js";
import { analyzeOwnership } from "../src/ir/analysis/ownership.js";
import { analyzeEscape } from "../src/ir/analysis/escape.js";
import { analyzeEncoding } from "../src/ir/analysis/encoding.js";
import { verifyAllocationEvidence } from "../src/ir/analysis/allocation-evidence/verify.js";
import { verifyIrFunction } from "../src/ir/runtime/verify.js";
import { assertFinalAllocProvenance } from "../src/ir/analysis/alloc-verification.js";
import { assertPreparedIrProgramAllocations } from "../src/ir/program/allocations.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irVal, irVec } from "../src/ir/core/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
const observer = vi.hoisted(() => ({
  route: "none",
  adapterCalls: 0,
  events: [] as { route: string; instruction: IrInstr; rule: ReturnType<typeof allocationEvidenceRule> }[],
  operands: [] as {
    route: string;
    instruction: IrInstr;
    role: Parameters<typeof allocationEvidenceOperand>[1];
    value: ReturnType<typeof allocationEvidenceOperand>;
  }[],
}));
vi.mock("../src/ir/analysis/allocation-evidence/effect-rules.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/allocation-evidence/effect-rules.js")>();
  return {
    ...actual,
    allocationEvidenceRule: (...args: Parameters<typeof actual.allocationEvidenceRule>) => {
      const rule = actual.allocationEvidenceRule(...args);
      observer.events.push({ route: observer.route, instruction: args[0], rule });
      return rule;
    },
    allocationEvidenceOperand: (...args: Parameters<typeof actual.allocationEvidenceOperand>) => {
      const value = actual.allocationEvidenceOperand(...args);
      observer.operands.push({ route: observer.route, instruction: args[0], role: args[1], value });
      return value;
    },
    allocationEvidenceEffect: (...args: Parameters<typeof actual.allocationEvidenceEffect>) => {
      observer.adapterCalls++;
      return actual.allocationEvidenceEffect(...args);
    },
  };
});
const F64 = irVal({ kind: "f64" }),
  I32 = irVal({ kind: "i32" }),
  VEC = irVec(F64, false);
const ids = createTestIrFunctionIdentityFactory("issue-6920-ae28-sharing");
const isVectorEffect = (i: IrInstr) => i.kind === "vec.get" || i.kind === "vec.len" || i.kind === "vec.set";
function frozen(rule: ReturnType<typeof allocationEvidenceRule>) {
  expect(Object.isFrozen(rule)).toBe(true);
  if (rule.kind !== "effects") return;
  expect(Object.isFrozen(rule.ownership)).toBe(true);
  expect(Object.isFrozen(rule.directEscape)).toBe(true);
  for (const event of rule.ownership) expect(Object.isFrozen(event)).toBe(true);
}

describe("issue-6920 actual allocation rule sharing", () => {
  it("AR07 ownership escape encoding and leaf reach the actual static rule binding", () => {
    const reg = new AllocSiteRegistry(),
      b = new IrFunctionBuilder(ids.next("binding"), [F64], false, reg);
    b.openBlock();
    const value = b.emitConst({ kind: "f64", value: 1.5 }, F64),
      index = b.emitConst({ kind: "i32", value: 0 }, I32);
    const vector = b.emitVecNewFixed([value], F64, VEC),
      otherVector = b.emitVecNewFixed([value], F64, VEC);
    b.emitVecLen(vector);
    const cond = b.emitConst({ kind: "i32", value: 0 }, I32);
    let tv: typeof value | undefined, ev: typeof value | undefined;
    const then = b.collectBodyInstrs(() => {
      b.emitVecGet(vector, index, F64);
      b.emitVecSet(vector, index, value);
      tv = b.emitConst({ kind: "f64", value: 2 }, F64);
    });
    const otherwise = b.collectBodyInstrs(() => {
      b.emitVecLenI32(vector);
      ev = b.emitConst({ kind: "f64", value: NaN }, F64);
      b.emitVecSet(otherVector, index, ev);
    });
    if (tv === undefined || ev === undefined) throw Error("actual nested arms did not produce their carriers");
    const result = b.emitIfElse({ cond, then, thenValue: tv, else: otherwise, elseValue: ev, resultType: F64 });
    b.terminate({ kind: "return", values: [result] });
    const fn = b.finish(),
      module = { functions: [fn] };
    expect(verifyIrFunction(fn)).toEqual([]);
    assertFinalAllocProvenance(fn, reg);
    const operations = [
      ...fn.blocks[0]!.instrs.filter(isVectorEffect),
      ...then.filter(isVectorEffect),
      ...otherwise.filter(isVectorEffect),
    ];
    expect(operations.map((i) => i.kind)).toEqual(["vec.len", "vec.get", "vec.set", "vec.len", "vec.set"]);
    const stores = operations.filter((i) => i.kind === "vec.set");
    expect(stores).toHaveLength(2);
    const original = structuredClone(module);
    observer.route = "api";
    const readRule = allocationEvidenceRule(operations[0]!);
    const writeRule = allocationEvidenceRule(stores[0]!);
    const noOpRule = allocationEvidenceRule(fn.blocks[0]!.instrs[0]!);
    expect(readRule).toEqual({
      kind: "effects",
      ownership: [{ op: "read", operand: "vec" }],
      directEscape: [],
      encoding: "no-write",
    });
    expect(writeRule).toEqual({
      kind: "effects",
      ownership: [
        { op: "write", operand: "vec" },
        { op: "escape", operand: "newValue" },
      ],
      directEscape: [],
      encoding: "no-write",
    });
    expect(noOpRule).toEqual({ kind: "effects", ownership: [], directEscape: [], encoding: "no-write" });
    expect(allocationEvidenceRule(fn.blocks[0]!.instrs[2]!)).toBe(noOpRule);
    for (const rule of [readRule, writeRule, noOpRule]) frozen(rule);
    expect(allocationEvidenceRule(stores[1]!)).toBe(writeRule);
    expect(allocationEvidenceOperand(stores[0]!, "vec")).toBe(vector);
    expect(allocationEvidenceOperand(stores[0]!, "newValue")).toBe(value);
    expect(allocationEvidenceOperand(stores[1]!, "vec")).toBe(otherVector);
    expect(allocationEvidenceOperand(stores[1]!, "newValue")).toBe(ev);
    expect(() => allocationEvidenceOperand(fn.blocks[0]!.instrs[0]!, "vec")).toThrow(
      "allocation rule mismatch: vector operand",
    );
    // A separate genuine function supplies an unsupported opcode; it is never passed as finite-covered.
    const ub = new IrFunctionBuilder(ids.next("unsupported-rule"), [F64], false);
    ub.openBlock();
    const ux = ub.emitConst({ kind: "f64", value: 0 }, F64),
      ui = ub.emitConst({ kind: "i32", value: 0 }, I32);
    ub.emitBinary("i32.eq", ui, ui, I32);
    ub.terminate({ kind: "return", values: [ux] });
    const uf = ub.finish();
    expect(verifyIrFunction(uf)).toEqual([]);
    const unsupportedRule = allocationEvidenceRule(uf.blocks[0]!.instrs[2]!);
    expect(unsupportedRule).toEqual({ kind: "unsupported" });
    expect(allocationEvidenceRule(uf.blocks[0]!.instrs[2]!)).toBe(unsupportedRule);
    frozen(unsupportedRule);
    expect(new Set([readRule, writeRule, noOpRule, unsupportedRule]).size).toBe(4);
    // Prove this compatibility binding observer is live before requiring its absence in hot routes.
    observer.adapterCalls = 0;
    expect(allocationEvidenceEffect(stores[0]!)).toEqual({
      kind: "effects",
      ownership: [
        { value: vector, op: "write" },
        { value, op: "escape" },
      ],
      directEscape: [],
      encoding: "no-write",
    });
    expect(observer.adapterCalls).toBe(1);
    observer.adapterCalls = 0;
    observer.events.length = 0;
    observer.operands.length = 0;
    observer.route = "ownership";
    const ownership = analyzeOwnership(fn, reg);
    expect(ownership.ownershipOf(vector)).toBe("owned");
    expect(ownership.accessOf(vector).toArray()).toEqual(["read", "write"]);
    expect(ownership.accessOf(otherVector).toArray()).toEqual(["write"]);
    expect(observer.adapterCalls).toBe(0);
    observer.route = "escape";
    expect(analyzeEscape(fn, reg, ownership).of(vector)).toEqual({ classification: "local", stackAllocatable: true });
    expect(observer.adapterCalls).toBe(0);
    observer.route = "encoding";
    analyzeEncoding(fn, reg);
    expect(observer.adapterCalls).toBe(0);
    const snapshot = reg.captureSnapshot();
    expect(snapshot.metadata).toEqual([
      {
        id: 0,
        entries: [
          [ALLOC_NAMESPACES.ownership, { state: "owned", ops: ["read", "write"] }],
          [ALLOC_NAMESPACES.escape, { classification: "local", stackAllocatable: true }],
        ],
      },
      {
        id: 1,
        entries: [
          [ALLOC_NAMESPACES.ownership, { state: "owned", ops: ["write"] }],
          [ALLOC_NAMESPACES.escape, { classification: "local", stackAllocatable: true }],
        ],
      },
    ]);
    observer.route = "none";
    expect(() =>
      assertPreparedIrProgramAllocations({ ir: module, allocations: snapshot, runtimeSupport: undefined }),
    ).not.toThrow();
    const before = structuredClone({ module, snapshot });
    observer.route = "leaf";
    expect(verifyAllocationEvidence(module, snapshot)).toMatchObject({
      kind: "verified",
      namespaces: "ownership-and-escape",
    });
    expect(observer.adapterCalls).toBe(0);
    for (const route of ["ownership", "escape", "encoding", "leaf"]) {
      const events = observer.events.filter((e) => e.route === route && isVectorEffect(e.instruction));
      expect(events.map((e) => e.instruction)).toEqual(operations);
      for (const [index, event] of events.entries()) {
        expect(event.instruction).toBe(operations[index]);
        expect(event.rule).toBe(event.instruction.kind === "vec.set" ? writeRule : readRule);
        frozen(event.rule);
      }
      const operands = observer.operands.filter(
        (e) => e.route === route && stores.some((store) => store === e.instruction),
      );
      if (route === "ownership") {
        expect(operands.map((e) => [e.instruction, e.role, e.value])).toEqual([
          [stores[0], "vec", vector],
          [stores[0], "newValue", value],
          [stores[1], "vec", otherVector],
          [stores[1], "newValue", ev],
        ]);
        for (const event of operands) expect(stores.some((store) => store === event.instruction)).toBe(true);
      } else if (route === "leaf") {
        // The finite theorem ignores primitive escape events before resolving operands.
        expect(operands.map((e) => [e.instruction, e.role, e.value])).toEqual([
          [stores[0], "vec", vector],
          [stores[1], "vec", otherVector],
        ]);
        expect(operands[0]!.instruction).toBe(stores[0]);
        expect(operands[1]!.instruction).toBe(stores[1]);
      } else expect(operands).toEqual([]);
    }
    expect({ module, snapshot }).toEqual(before);
    expect(module).toEqual(original);
    observer.route = "none";
  });
});
