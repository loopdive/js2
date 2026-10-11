// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { analyzeEncoding } from "../src/ir/analysis/encoding.js";
import type { IrFunction, IrType } from "../src/ir/nodes.js";
import { irUnitFuncRef } from "../src/ir/core/callable-bindings.js";
import { inlineSmall } from "../src/ir/passes/inline-small.js";
import { assertPreparedIrProgramAllocations } from "../src/ir/program-allocations.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("3518-inline-call-allocation");
const STRING: IrType = { kind: "string" };

function fixture(oversized = false) {
  const registry = new AllocSiteRegistry();
  const join = new IrFunctionBuilder(identities.next("join"), [STRING], false, registry);
  const a = join.addParam("a", STRING);
  const b = join.addParam("b", STRING);
  join.openBlock();
  let value = join.emitStringConcat(a, b);
  if (oversized) for (let i = 0; i < 12; i++) value = join.emitStringConcat(value, b);
  join.terminate({ kind: "return", values: [value] });
  const callee = join.finish();
  const run = new IrFunctionBuilder(identities.next("run"), [STRING], true, registry);
  run.openBlock();
  const first = run.emitStringConst("first");
  const second = run.emitStringConst(" line");
  const one = run.emitCall(irUnitFuncRef(callee), [first, second], STRING);
  const two = run.emitCall(irUnitFuncRef(callee), [first, second], STRING);
  if (one === null || two === null) throw new Error("string calls must return values");
  const combined = run.emitStringConcat(one, two);
  run.terminate({ kind: "return", values: [combined] });
  const caller = run.finish();
  const functions = [callee, caller];
  for (const fn of functions) analyzeEncoding(fn, registry);
  return { registry, functions, caller, callee };
}

function validate(functions: readonly IrFunction[], registry: AllocSiteRegistry) {
  assertPreparedIrProgramAllocations({ ir: { functions }, allocations: registry.snapshot() });
}

describe("inlined string call allocation provenance", () => {
  it("retires both removed call sites and reconstructs metadata for distinct callee forks", () => {
    const { registry, functions, caller, callee } = fixture();
    validate(functions, registry);
    const calls = caller.blocks[0]!.instrs.filter((instruction) => instruction.kind === "call");
    expect(calls.map((call) => call.alloc)).toEqual([3, 4]);
    for (const call of calls)
      expect(registry.snapshot().metadata.find((row) => row.id === call.alloc)?.entries).toContainEqual([
        "encoding",
        "wtf16",
      ]);
    const originalConcat = callee.blocks[0]!.instrs[0]!.alloc;
    const result = inlineSmall({ functions }, registry);
    const updated = result.functions.find((fn) => fn.unitId === caller.unitId)!;
    expect(updated.blocks[0]!.instrs.filter((instruction) => instruction.kind === "call")).toHaveLength(0);
    for (const call of calls) {
      expect(registry.resolve(call.alloc!)).toBeNull();
      expect(registry.snapshot().entries[call.alloc!]).toEqual({ state: "retired" });
      expect(registry.snapshot().metadata.some((row) => row.id === call.alloc)).toBe(false);
    }
    const forks = updated.blocks[0]!.instrs.filter((instruction) => instruction.kind === "string.concat").slice(0, 2);
    expect(forks).toHaveLength(2);
    expect(new Set(forks.map((instruction) => instruction.alloc)).size).toBe(2);
    for (const fork of forks) {
      expect(fork.alloc).not.toBe(originalConcat);
      expect(registry.resolve(fork.alloc!)).not.toBeNull();
    }
    expect(registry.resolve(originalConcat!)).not.toBeNull();
    for (const fn of result.functions) analyzeEncoding(fn, registry);
    validate(result.functions, registry);
    // Reintroducing the original stale evidence must still fail closed.
    const stale = registry.snapshot();
    const before = fixture();
    const removed = calls[0]!.alloc!;
    const corrupted = {
      ...stale,
      entries: stale.entries.map((entry, index) =>
        index === removed ? before.registry.snapshot().entries[removed]! : entry,
      ),
      metadata: [...stale.metadata, { id: removed, entries: [["encoding", "wtf16"] as const] }],
    };
    expect(() => assertPreparedIrProgramAllocations({ ir: result, allocations: corrupted })).toThrow(
      /stale encoding evidence/,
    );
  });

  it("retains live call provenance and existing metadata when inlining declines", () => {
    const { registry, functions, caller } = fixture(true);
    validate(functions, registry);
    const before = registry.snapshot();
    const result = inlineSmall({ functions }, registry);
    expect(result.functions.find((fn) => fn.unitId === caller.unitId)).toEqual(caller);
    expect(registry.snapshot()).toEqual(before);
    const calls = caller.blocks[0]!.instrs.filter((instruction) => instruction.kind === "call");
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(registry.resolve(call.alloc!)).not.toBeNull();
    validate(result.functions, registry);
  });
});
