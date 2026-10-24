// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, vi } from "vitest";
import * as dynamicSupport from "../src/ir/prepared-dynamic-support.js";
import * as closureSupport from "../src/ir/prepared-closure-support.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/nodes.js";
import { irUnitCallableBindingId, irUnitFuncRef, irCallableBindingKey } from "../src/ir/callable-bindings.js";
import { definedFuncAt, funcSignatureOf } from "../src/codegen/func-space.js";
import { compile, type CompileResult } from "../src/index.js";

const OPTIONS = {
  target: "standalone",
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
} as const;

function requirePrepared(result: CompileResult, name: string): void {
  const row = result.irOutcomes?.find((entry) => entry.displayName === name);
  expect(row, JSON.stringify(result.irOutcomes)).toMatchObject({
    kind: "emitted",
    irBodyEmitted: true,
    legacyBodyEmitted: false,
    directBodyEmissions: 0,
    preparedComponentId: expect.any(String),
  });
  expect(row).not.toHaveProperty("r2Withdrawal");
}

const CASES = [
  {
    name: "prepares the reported arguments.length target with a member RHS",
    source: `
function subject(): number { return arguments.length; }
subject.equal = function (a, b) { return a === b; };
export function run(): number { return subject.equal(1, 1) ? 1 : 0; }
`,
  },
  {
    name: "executes the pure target's argc wrapper as well as its member call",
    source: `
function subject(): number { return arguments.length; }
subject.equal = function (a, b) { return a === b; };
export function run(): number { return subject.equal(subject(), 0) ? 1 : 0; }
`,
  },
] as const;

describe("#7106 function-object target arguments.length support", () => {
  it.each(CASES)("$name", async ({ source }) => {
    const result = await compile(source, OPTIONS);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    for (const name of ["subject", "run", "<module-init>"]) requirePrepared(result, name);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = new WebAssembly.Instance(module, {});
    const init = instance.exports.__module_init;
    expect(typeof init).toBe("function");
    (init as () => void)();
    expect(typeof instance.exports.run).toBe("function");
    expect((instance.exports.run as () => number)()).toBe(1);
  });
});

// Observe the normal pipeline, then replay only direct sidecar preparation
// with deliberately unavailable providers. The compiler always receives its
// original support map with its exact provider map restored.
it("binds the real argc instruction/provider and retains exact allocator ownership", async () => {
  const prepare = dynamicSupport.prepareDynamicInstructionSupportForUnits;
  const allocate = closureSupport.allocatePreparedDerivedCallableSlots;
  type Input = Parameters<typeof prepare>[0];
  const captureErrors: unknown[] = [];
  const proofs: Array<{
    ctx: Input["ctx"];
    owner: Input["entries"][number]["terminalOwnerUnitId"];
    instruction: IrInstr;
    exactInstructionKey: boolean;
    exactProvider: boolean;
    scalarSignature: boolean;
    hasLocalFunctionObjectCall: boolean;
  }> = [];
  const allocations: Array<{
    ctx: Parameters<typeof allocate>[0];
    slot: ReturnType<typeof allocate>[number];
    fn: ReturnType<typeof definedFuncAt>;
    exactMapObject: boolean;
  }> = [];
  const refusals: Array<{ kind: string; omittedWholeOwner: boolean; noAllocation: boolean; restored: boolean }> = [];
  let forwards = 0;
  let replayed = false;
  const allocatorSpy = vi.spyOn(closureSupport, "allocatePreparedDerivedCallableSlots").mockImplementation(function (
    this: unknown,
    ...args: Parameters<typeof allocate>
  ) {
    const slots = Reflect.apply(allocate, this, args) as ReturnType<typeof allocate>;
    try {
      for (const slot of slots) {
        const fn = definedFuncAt(args[0], slot.funcIdx);
        allocations.push({
          ctx: args[0],
          slot,
          fn,
          exactMapObject: fn !== undefined && args[0].irUnitFuncMap.get(slot.artifactUnitId) === fn,
        });
      }
    } catch (error) {
      captureErrors.push(error);
    }
    return slots;
  });
  const supportSpy = vi.spyOn(dynamicSupport, "prepareDynamicInstructionSupportForUnits").mockImplementation(function (
    this: unknown,
    input: Input,
  ) {
    forwards++;
    const normal = Reflect.apply(prepare, this, [input]) as ReturnType<typeof prepare>;
    try {
      for (const entry of input.entries) {
        const instructions: IrInstr[] = [];
        let hasLocalFunctionObjectCall = false;
        for (const block of entry.fn.blocks)
          for (const root of block.instrs)
            forEachInstrDeep(root, (instruction) => {
              if (instruction.kind === "dyn.arguments_length") instructions.push(instruction);
              if (
                instruction.kind === "call" &&
                instruction.target.binding.kind === "runtime" &&
                instruction.target.binding.symbol === "__ir_dyn_call_box"
              )
                hasLocalFunctionObjectCall = true;
            });
        if (instructions.length === 0) continue;
        const handle = input.ctx.funcMap.get("__ir_arguments_length");
        if (handle === undefined) throw new Error("real argc helper was not preregistered");
        const fn = definedFuncAt(input.ctx, handle);
        const signature = funcSignatureOf(input.ctx, handle);
        for (const instruction of instructions) {
          const evidence = normal.get(entry.terminalOwnerUnitId);
          const refs = evidence?.instructionCallables?.get(instruction);
          const ref = refs?.[0];
          if (!ref || refs.length !== 1) throw new Error("actual argc instruction has no exact helper reference");
          const resolved = input.ctx.programAbiCallableProviders?.resolveCurrentIndex(ref);
          proofs.push({
            ctx: input.ctx,
            owner: entry.terminalOwnerUnitId,
            instruction,
            exactInstructionKey: evidence!.instructionCallables!.has(instruction),
            exactProvider:
              ref.binding.kind === "runtime" &&
              ref.binding.symbol === "__ir_arguments_length" &&
              fn !== undefined &&
              resolved !== undefined &&
              definedFuncAt(input.ctx, resolved) === fn,
            scalarSignature:
              signature?.params.length === 1 &&
              signature.params[0]?.kind === "i32" &&
              signature.results.length === 1 &&
              signature.results[0]?.kind === "f64",
            hasLocalFunctionObjectCall,
          });
        }
        if (replayed) continue;
        replayed = true;
        const other = input.ctx.funcMap.get("__ir_dyn_call_box");
        const wrongSignature = other === undefined ? undefined : funcSignatureOf(input.ctx, other);
        if (
          other === undefined ||
          other === handle ||
          !wrongSignature ||
          (wrongSignature.params.length === 1 &&
            wrongSignature.params[0]?.kind === "i32" &&
            wrongSignature.results.length === 1 &&
            wrongSignature.results[0]?.kind === "f64")
        )
          throw new Error("real mismatched-signature provider control is unavailable");
        const entries = input.entries.filter(
          (candidate) => candidate.terminalOwnerUnitId === entry.terminalOwnerUnitId,
        );
        for (const kind of ["missing", "mismatched"] as const) {
          const map = [...input.ctx.funcMap];
          const keys = ["functions", "types", "imports", "globals", "funcOrdinalToPosition"] as const;
          const before = keys.map((key) => [...input.ctx.mod[key]]);
          let omittedWholeOwner = false;
          let noAllocation = false;
          try {
            if (kind === "missing") input.ctx.funcMap.delete("__ir_arguments_length");
            else input.ctx.funcMap.set("__ir_arguments_length", other);
            const rejected = prepare({ ...input, entries });
            omittedWholeOwner = !rejected.has(entry.terminalOwnerUnitId);
            noAllocation = keys.every(
              (key, index) =>
                before[index]!.length === input.ctx.mod[key].length &&
                before[index]!.every((value, ordinal) => value === input.ctx.mod[key][ordinal]),
            );
          } finally {
            input.ctx.funcMap.clear();
            for (const [name, value] of map) input.ctx.funcMap.set(name, value);
          }
          const restoredMap = [...input.ctx.funcMap];
          refusals.push({
            kind,
            omittedWholeOwner,
            noAllocation,
            restored:
              map.length === restoredMap.length &&
              map.every(
                ([name, value], index) => restoredMap[index]?.[0] === name && restoredMap[index]?.[1] === value,
              ),
          });
        }
      }
    } catch (error) {
      captureErrors.push(error);
    }
    return normal;
  });
  let result: CompileResult;
  try {
    result = await compile(`${CASES[1].source}\nexport function healthy(): number { return 7; }`, OPTIONS);
  } finally {
    supportSpy.mockRestore();
    allocatorSpy.mockRestore();
  }
  expect(captureErrors).toEqual([]);
  expect(forwards).toBeGreaterThan(0);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  for (const name of ["subject", "run", "<module-init>", "healthy"]) requirePrepared(result, name);
  const subject = result.irOutcomes!.find((row) => row.displayName === "subject")!;
  const healthy = result.irOutcomes!.find((row) => row.displayName === "healthy")!;
  expect(healthy.preparedComponentId).not.toBe(subject.preparedComponentId);
  expect(new Set(proofs.map((proof) => proof.owner))).toEqual(new Set([subject.unitId]));
  expect(proofs.length).toBeGreaterThan(0);
  for (const proof of proofs)
    expect(proof).toMatchObject({
      exactInstructionKey: true,
      exactProvider: true,
      scalarSignature: true,
      hasLocalFunctionObjectCall: false,
    });
  expect(refusals).toEqual([
    { kind: "missing", omittedWholeOwner: true, noAllocation: true, restored: true },
    { kind: "mismatched", omittedWholeOwner: true, noAllocation: true, restored: true },
  ]);
  expect(allocations.length).toBeGreaterThan(0);
  let sourceExpressionSlots = 0;
  for (const allocation of allocations) {
    expect(allocation.exactMapObject).toBe(true);
    const session = allocation.ctx.programAbiSession!;
    const unit = session.inventory.allUnits.find((candidate) => candidate.id === allocation.slot.artifactUnitId);
    if (unit?.kind === "function-expression") sourceExpressionSlots++;
    const binding = irUnitCallableBindingId(allocation.slot.artifactUnitId);
    expect(session.hasLocator(binding, allocation.fn)).toBe(true);
    expect(session.locatorObjectForBinding(binding)).toBe(allocation.fn);
    expect(allocation.ctx.irUnitFuncMap.get(allocation.slot.artifactUnitId)).toBe(allocation.fn);
    expect(allocation.ctx.mod.functions).toContain(allocation.fn);
  }
  expect(sourceExpressionSlots).toBeGreaterThan(0);
  const ctx = proofs[0]!.ctx;
  for (const row of [subject, healthy]) {
    const unit = ctx.programAbiSession!.inventory.allUnits.find((candidate) => candidate.id === row.unitId);
    expect(unit).toBeDefined();
    if (!unit) throw new Error("source outcome has no actual inventory unit");
    const fn = ctx.programAbiSourceCallables?.functionForUnit(unit.id);
    expect(fn).toBeDefined();
    const binding = irUnitCallableBindingId(unit.id);
    expect(ctx.programAbiSession!.hasLocator(binding, fn)).toBe(true);
    expect(ctx.programAbiSession!.locatorObjectForBinding(binding)).toBe(fn);
    const current = ctx.programAbiSession!.resolveCurrentIndex(
      binding,
      "function",
      irCallableBindingKey(irUnitFuncRef({ unitId: unit.id, name: row.displayName }).binding),
      ctx.mod,
    );
    expect(definedFuncAt(ctx, current)).toBe(fn);
  }
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  (instance.exports.__module_init as () => void)();
  expect((instance.exports.run as () => number)()).toBe(1);
  expect((instance.exports.healthy as () => number)()).toBe(7);
});
