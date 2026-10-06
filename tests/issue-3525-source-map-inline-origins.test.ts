// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// DATA pass witnesses: these annotated builder bodies do not prove frontend minting.
import { describe, expect, it } from "vitest";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { irVal, type IrFunction, type IrModule, type IrSiteId } from "../src/ir/nodes.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { inlineSmall } from "../src/ir/passes/inline-small.js";
import type { IrSourceMapPoint } from "../src/shared/contracts/ir-unit-inventory.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const F64 = irVal({ kind: "f64" });
const STRING = { kind: "string" } as const;
function freezeGraph(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
    if ("value" in descriptor) freezeGraph(descriptor.value, seen);
  Object.freeze(value);
}
function fixture(
  options: {
    chain?: boolean;
    generated?: boolean;
    allocation?: boolean;
    legacy?: boolean;
    noMap?: boolean;
    legacyCall?: boolean;
  } = {},
) {
  const identities = createTestIrFunctionIdentityFactory("3525-inline-source-map-DATA");
  const calleeId = identities.next("twice"),
    callerId = identities.next("run");
  const point = (donorUnitId: IrFunction["unitId"], start: number): IrSourceMapPoint => ({
    sourceId: identities.sourceId,
    donorUnitId,
    analyzed: { start, end: start + 4 },
    original: { start, end: start + 4 },
    mapping: "exact",
  });
  const primary = point(calleeId.unitId, 10),
    previous = point(identities.unit(2), 20);
  const callPoint = point(callerId.unitId, 30),
    outer = point(identities.unit(3), 40),
    outermost = point(identities.unit(4), 50);
  const sourceSite: IrSiteId = {
    line: 2,
    column: 3,
    origin: { kind: "source", point: primary, ...(options.chain ? { inlinedAt: [previous] } : {}) },
  };
  const generatedSite: IrSiteId = {
    origin: {
      kind: "generated",
      phase: "frontend",
      role: "binding-scaffold",
      ownerUnitId: calleeId.unitId,
      cause: primary,
    },
  };
  const callSite: IrSiteId = {
    line: 5,
    column: 7,
    origin: { kind: "source", point: callPoint, ...(options.chain ? { inlinedAt: [outer, outermost] } : {}) },
  };
  const registry = options.allocation ? new AllocSiteRegistry() : undefined;
  const type = options.allocation ? STRING : F64;
  const enriched = !options.legacy && !options.noMap;
  const calleeBuilder = new IrFunctionBuilder(calleeId, [type], false, registry, undefined, enriched);
  const parameter = options.allocation ? undefined : calleeBuilder.addParam("x", F64);
  calleeBuilder.openBlock();
  const emitCallee = () => {
    const value = options.allocation
      ? calleeBuilder.emitStringConst("body")
      : calleeBuilder.emitConst({ kind: "f64", value: 2 }, F64);
    const result = options.allocation ? value : calleeBuilder.emitBinary("f64.mul", parameter!, value, F64);
    calleeBuilder.terminate({ kind: "return", values: [result] });
  };
  if (enriched) calleeBuilder.withSourceSite(options.generated ? generatedSite : sourceSite, emitCallee);
  else emitCallee();
  let callee = calleeBuilder.finish();
  if (options.legacy)
    callee = {
      ...callee,
      blocks: callee.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((instr) => ({ ...instr, site: { line: 2, column: 3 } })),
      })),
    };
  const callerCapture = !options.legacyCall && enriched;
  const callerBuilder = new IrFunctionBuilder(callerId, [type], true, registry, undefined, callerCapture);
  const argument = options.allocation ? undefined : callerBuilder.addParam("n", F64);
  callerBuilder.openBlock();
  const emitCaller = () => {
    const result = callerBuilder.emitCall(irUnitFuncRef(callee), argument === undefined ? [] : [argument], type)!;
    callerBuilder.terminate({ kind: "return", values: [result] });
  };
  if (callerCapture) callerBuilder.withSourceSite(callSite, emitCaller);
  else emitCaller();
  let caller = callerBuilder.finish();
  if (options.legacy || options.legacyCall)
    caller = {
      ...caller,
      blocks: caller.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((instr) => ({ ...instr, site: { line: 5, column: 7 } })),
      })),
    };
  const module: IrModule = { functions: [callee, caller] };
  const before = structuredClone(module);
  freezeGraph(module);
  return { module, before, registry, callee, caller, primary, previous, callPoint, outer, outermost };
}
function run(witness: ReturnType<typeof fixture>) {
  const output = inlineSmall(witness.module, witness.registry);
  const caller = output.functions.find((fn) => fn.unitId === witness.caller.unitId)!;
  expect(output).not.toBe(witness.module);
  expect(caller.blocks[0].instrs.some((instr) => instr.kind === "call")).toBe(false);
  expect(verifyIrFunction(caller)).toEqual([]);
  expect(witness.module).toEqual(witness.before);
  expect(output.functions.find((fn) => fn.unitId === witness.callee.unitId)).toBe(witness.callee);
  console.info(
    "B3 inline DATA population",
    JSON.stringify({
      inputFunctions: witness.module.functions.length,
      outputFunctions: output.functions.length,
      copiedInstructions: caller.blocks[0].instrs.length,
      blocks: caller.blocks.length,
      registry: witness.registry?.snapshot().size ?? 0,
    }),
  );
  return caller;
}

describe("B3 inline-small DATA origin transfer", () => {
  it("keeps callee primary coordinates and appends the actual source call point", () => {
    const witness = fixture();
    for (const instr of run(witness).blocks[0].instrs) {
      expect(instr.site).toEqual({
        line: 2,
        column: 3,
        origin: { kind: "source", point: witness.primary, inlinedAt: [witness.callPoint] },
      });
    }
  });
  it("retains previous frames before the actual call point and enclosing frames in exact order", () => {
    const witness = fixture({ chain: true });
    for (const instr of run(witness).blocks[0].instrs) {
      expect(instr.site?.origin).toEqual({
        kind: "source",
        point: witness.primary,
        inlinedAt: [witness.previous, witness.callPoint, witness.outer, witness.outermost],
      });
    }
  });
  it("remaps copied generated ownership while preserving its causal source point", () => {
    const witness = fixture({ generated: true });
    for (const instr of run(witness).blocks[0].instrs) {
      expect(instr.site).toEqual({
        origin: {
          kind: "generated",
          phase: "frontend",
          role: "binding-scaffold",
          ownerUnitId: witness.caller.unitId,
          cause: witness.primary,
        },
      });
    }
  });
  it("forks allocation origins jointly with copied instruction origins without altering the original row", () => {
    const witness = fixture({ allocation: true, chain: true });
    const original = witness.callee.blocks[0].instrs[0];
    expect(original.alloc).toBeDefined();
    const originalRow = structuredClone(witness.registry!.snapshot().entries[original.alloc!]);
    const copied = run(witness).blocks[0].instrs[0];
    expect(copied.alloc).toBeDefined();
    expect(copied.alloc).not.toBe(original.alloc);
    expect(copied.site?.origin).toEqual({
      kind: "source",
      point: witness.primary,
      inlinedAt: [witness.previous, witness.callPoint, witness.outer, witness.outermost],
    });
    const row = witness.registry!.snapshot().entries[copied.alloc!];
    expect(row.state).toBe("live");
    if (row.state !== "live") throw new Error("copied allocation was retired");
    expect(row.site.origin).toEqual(copied.site);
    expect(witness.registry!.snapshot().entries[original.alloc!]).toEqual(originalRow);
    expect(witness.registry!.snapshot().size).toBe(3);
  });
  it("keeps the unannotated no-map semantic body and omits new origin fields", () => {
    const witness = fixture({ noMap: true });
    const caller = run(witness);
    expect(caller.blocks[0].instrs.map((instr) => instr.kind)).toEqual(["const", "binary"]);
    for (const instr of caller.blocks[0].instrs) expect(Object.hasOwn(instr, "site")).toBe(false);
    expect(caller.blocks[0].terminator.site).toBeUndefined();
  });
  it("keeps legacy diagnostic coordinates without fabricating a source annotation", () => {
    const witness = fixture({ legacy: true });
    for (const instr of run(witness).blocks[0].instrs) expect(instr.site).toEqual({ line: 2, column: 3 });
  });
  it("does not manufacture inline frames from legacy call coordinates (mapping coverage remains a gap)", () => {
    const witness = fixture({ legacyCall: true });
    for (const instr of run(witness).blocks[0].instrs)
      expect(instr.site?.origin).toEqual({ kind: "source", point: witness.primary });
  });
});
