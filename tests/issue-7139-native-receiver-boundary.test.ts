// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { irUnitFuncRef, irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";
import {
  IR_CLOSURE_RECEIVER,
  IR_CLOSURE_UNDEFINED,
  irClosureMethodReference,
} from "../src/ir/core/closure-invocation-callables.js";
import { asValueId } from "../src/ir/core/nodes.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { planNativeSourceClosureRequirements } from "../src/ir/program/native-source-closure-requirements.js";
import { planNativeInvocationRequirements } from "../src/ir/program/native-invocation-requirements.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { replayProgram, replayOptions } from "./helpers/ir-whole-program-replay.js";
import { memberEntryPolicy } from "./helpers/prepared-member-entries.js";

const external = { kind: "val", val: { kind: "externref" } } as const;

/** Constructed generic receiver IR; separate from original member AST execution tests. */
function opaqueReceiverProgram() {
  const { packet } = sourcePacket({
    "./entry.ts": `export function run():number {
    const fn=function():number {return 7;}; return fn.call(null);
  } export function canonical():number {return 0;}`,
  });
  const registry = AllocSiteRegistry.fromSnapshot(packet.allocations);
  for (const row of packet.allocations.entries) if (row.state === "live") registry.retire(row.site.id);
  const original = packet.ir.functions.find((fn) => fn.closureSubtype)!;
  const signature = { params: [], returnType: external } as const;
  const closure = new IrFunctionBuilder(original, [external], false, registry);
  closure.addParam("self", { kind: "closure", signature });
  closure.openBlock();
  const receiver = closure.emitCall(irIntrinsicFuncRef(IR_CLOSURE_RECEIVER), [], external)!;
  closure.terminate({ kind: "return", values: [receiver] });
  const body = closure.finish({
    signature,
    captureFieldTypes: [],
    parameters: { kind: "fixed", count: 0, publicLength: 0 },
  });
  const runIdentity = packet.ir.functions.find((fn) => fn.name === "run")!;
  const run = new IrFunctionBuilder(runIdentity, [external], true, registry);
  const incoming = run.addParam("receiver", external);
  run.openBlock();
  const value = run.emitClosureNew(irUnitFuncRef(body), signature, [], []);
  const callee = run.emitCoerceToExternref(run.emitCallablePack(value, signature));
  const result = run.emitCall(irClosureMethodReference(0), [incoming, callee], external)!;
  run.terminate({ kind: "return", values: [result] });
  const canonical = new IrFunctionBuilder(
    packet.ir.functions.find((fn) => fn.name === "canonical")!,
    [external],
    true,
    registry,
  );
  canonical.openBlock();
  const undefinedValue = canonical.emitCall(irIntrinsicFuncRef(IR_CLOSURE_UNDEFINED), [], external)!;
  canonical.terminate({ kind: "return", values: [undefinedValue] });
  return requireProgram(
    prepareTypedIrProgram(
      {
        ...packet,
        ir: { ...packet.ir, functions: [run.finish(), body, canonical.finish()] },
        allocations: registry.snapshot(),
      },
      {
        ...typedOptions,
        policy: memberEntryPolicy,
        runtimePolicies: [memberEntryPolicy],
      },
    ),
  );
}

for (const decoded of [false, true])
  it(`preserves exact null, undefined, primitive, object and canonical undefined receivers, decoded=${decoded}`, async () => {
    const original = opaqueReceiverProgram();
    const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
    const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
    if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
    expect(outcome.run.emitted.module.imports).toEqual([]);
    const run = outcome.run.exports.run as (receiver: unknown) => unknown;
    const canonical = (outcome.run.exports.canonical as () => unknown)();
    expect(canonical).not.toBeNull();
    expect(canonical).not.toBeUndefined();
    const object = { marker: 73 },
      array = [19];
    for (const receiver of [null, undefined, 0, -0, NaN, 42, true, "receiver", object, array, canonical])
      expect(run(receiver)).toBe(receiver);
    expect(run(object)).toBe(object);
  });

/** Constructed nested native boundaries; source method entry is qualified separately. */
function nestedReceiverProgram(result: "normal" | "caught" | "restored") {
  const { packet } = sourcePacket({
    "./entry.ts": `export function run():number {
      const inner=function():number {return 7;};
      const outer=function():number {return inner.call(null);};
      return outer.call(null);
    }`,
  });
  const registry = AllocSiteRegistry.fromSnapshot(packet.allocations);
  for (const row of packet.allocations.entries) if (row.state === "live") registry.retire(row.site.id);
  const originals = packet.ir.functions.filter((fn) => fn.closureSubtype);
  expect(originals).toHaveLength(2);
  const signature = { params: [], returnType: external } as const;
  const meta = { signature, captureFieldTypes: [], parameters: { kind: "fixed", count: 0, publicLength: 0 } } as const;
  const inner = new IrFunctionBuilder(originals[0]!, [external], false, registry);
  inner.addParam("self", { kind: "closure", signature });
  inner.openBlock();
  const inside = inner.emitCall(irIntrinsicFuncRef(IR_CLOSURE_RECEIVER), [], external)!;
  if (result === "normal") inner.terminate({ kind: "return", values: [inside] });
  else {
    inner.emitThrow(inside);
    inner.terminate({ kind: "unreachable" });
  }
  const innerFn = inner.finish(meta);
  const outer = new IrFunctionBuilder(originals[1]!, [external], false, registry);
  const self = outer.addParam("self", { kind: "closure", signature });
  outer.openBlock();
  const incoming = outer.emitClosureCap(self, 0, external);
  const nested = outer.emitClosureNew(irUnitFuncRef(innerFn), signature, [], []);
  const callee = outer.emitCoerceToExternref(outer.emitCallablePack(nested, signature));
  const invoke = () => outer.emitCall(irClosureMethodReference(0), [incoming, callee], external)!;
  if (result === "normal") invoke();
  else {
    const payloadSlot = outer.declareSlot("caught", external.val);
    const body = outer.collectBodyInstrs(invoke);
    const handler = outer.collectBodyInstrs(() => {
      if (result === "caught") outer.emitEarlyReturn(outer.emitSlotRead(payloadSlot));
    });
    outer.emitTry({ body, catchClause: { payloadSlot, body: handler } });
  }
  const after = outer.emitCall(irIntrinsicFuncRef(IR_CLOSURE_RECEIVER), [], external)!;
  outer.terminate({ kind: "return", values: [after] });
  const outerFn = outer.finish({ ...meta, captureFieldTypes: [external] });
  const run = new IrFunctionBuilder(packet.ir.functions.find((fn) => fn.name === "run")!, [external], true, registry);
  const outside = run.addParam("outerReceiver", external);
  const nestedReceiver = run.addParam("innerReceiver", external);
  run.openBlock();
  const value = run.emitClosureNew(irUnitFuncRef(outerFn), signature, [external], [nestedReceiver]);
  const packed = run.emitCoerceToExternref(run.emitCallablePack(value, signature));
  const actual = run.emitCall(irClosureMethodReference(0), [outside, packed], external)!;
  run.terminate({ kind: "return", values: [actual] });
  return requireProgram(
    prepareTypedIrProgram(
      {
        ...packet,
        ir: { ...packet.ir, functions: [run.finish(), innerFn, outerFn] },
        allocations: registry.snapshot(),
      },
      { ...typedOptions, policy: memberEntryPolicy, runtimePolicies: [memberEntryPolicy] },
    ),
  );
}

for (const result of ["normal", "caught", "restored"] as const)
  it(`preserves nested native receiver state and exact thrown payload: ${result}`, async () => {
    const program = decodePreparedIrProgram(encodePreparedIrProgram(nestedReceiverProgram(result)));
    const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
    if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
    expect(outcome.run.emitted.module.imports).toEqual([]);
    const run = outcome.run.exports.run as (outer: unknown, inner: unknown) => unknown;
    const outside = { outer: true },
      inside = { inner: true };
    for (const [outer, inner] of [
      [outside, inside],
      [null, undefined],
      [undefined, null],
      [inside, outside],
    ])
      expect(run(outer, inner)).toBe(result === "caught" ? inner : outer);
  });

it("refuses an actual callback bypass even when the reader also has a valid call boundary", () => {
  const { packet } = sourcePacket({
    "./entry.ts": `export function run():number {
    const reader=function(x:number):number {return x+7;};
    const invoke=function(callback:(x:number)=>number):number {return callback(1);};
    return reader.call(null,2)+invoke.call(null,reader);
  }`,
  });
  const reader = packet.ir.functions.find((fn) => fn.closureSubtype?.signature.params[0]?.kind === "val")!;
  const call = {
    kind: "call" as const,
    target: irIntrinsicFuncRef(IR_CLOSURE_RECEIVER),
    args: [],
    result: asValueId(reader.valueCount),
    resultType: external,
  };
  const fn = {
    ...reader,
    valueCount: reader.valueCount + 1,
    blocks: [{ ...reader.blocks[0]!, instrs: [call, ...reader.blocks[0]!.instrs] }, ...reader.blocks.slice(1)],
  };
  const program = requireProgram(
    prepareTypedIrProgram(
      { ...packet, ir: { ...packet.ir, functions: packet.ir.functions.map((row) => (row === reader ? fn : row)) } },
      {
        ...typedOptions,
        policy: memberEntryPolicy,
        runtimePolicies: [memberEntryPolicy],
      },
    ),
  );
  const source = planNativeSourceClosureRequirements(program, program.runtime[0]!)!;
  const requirements = planNativeInvocationRequirements(source, { utf8Storage: false })!;
  expect(requirements.gaps.some((gap) => gap.detail.includes("escaping or uninstalled call route"))).toBe(true);
});
