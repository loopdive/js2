// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { beforeAll, describe, expect, it } from "vitest";
import * as oldManifest from "../src/ir/runtime-program-manifest.js";
import * as manifest from "../src/ir/program/runtime-manifest.js";
import * as oldProjection from "../src/ir/program-runtime-validation.js";
import * as projection from "../src/ir/program/runtime-validation.js";
import { irProgramRuntimeDemands } from "../src/ir/program/runtime-demands.js";
import { preparedIrDraftAbiLookup } from "../src/ir/program/draft-abi-lookup.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { preparedIrProgramOwner } from "../src/ir/program/owner.js";
import { freezePreparedIrValue, preparedIrReadonlyMap } from "../src/ir/program/data.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { asValueId, type IrInstr } from "../src/ir/core/nodes.js";
import { irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { requireProgram, sourceInput, sourcePacket, typedOptions } from "./helpers/typed-program-fixtures.js";

const HOST = { backend: "wasmgc", target: "host" } as const;
let sqrt: PreparedIrProgram, asyncProgram: PreparedIrProgram, clockProgram: PreparedIrProgram;
beforeAll(() => {
  sqrt = requireProgram(
    prepareWholeIrProgram({
      ...sourceInput({ "./entry.ts": "export function main(value: number): number { return Math.sqrt(value); }" }),
      policy: HOST,
      runtimePolicies: [HOST, { backend: "linear", target: "host" }],
    }),
  );
  asyncProgram = requireProgram(
    prepareWholeIrProgram({
      ...sourceInput({
        "./entry.ts": "export async function main(value: number): Promise<number> { return await value; }",
      }),
      policy: HOST,
      runtimePolicies: [HOST],
    }),
  );
  const packet = sourcePacket({ "./entry.ts": "export function main(): number { return 1; }" }).packet;
  const fn = packet.ir.functions[0]!,
    block = fn.blocks[0]!;
  const f64 = { kind: "val", val: { kind: "f64" } } as const;
  const clock: IrInstr = {
    kind: "call",
    target: irIntrinsicFuncRef("async.clock.snapshot"),
    args: [],
    result: asValueId(0),
    resultType: f64,
    site: { line: 8, column: 3 },
  };
  clockProgram = requireProgram(
    prepareTypedIrProgram(
      {
        ...packet,
        ir: {
          functions: [
            {
              ...fn,
              params: [],
              resultTypes: [f64],
              valueCount: 1,
              blocks: [{ ...block, instrs: [clock], terminator: { kind: "return", values: [asValueId(0)] } }],
            },
          ],
        },
      },
      {
        ...typedOptions,
        policy: { ...typedOptions.policy, stringConst: { storage: "native" } },
        runtimePolicies: [{ ...typedOptions.policy, stringConst: { storage: "native" } }],
      },
    ),
  );
});
function request(program: PreparedIrProgram) {
  return {
    inventory: program.inventory,
    ir: program.ir,
    derivedUnits: program.derivedUnits,
    abi: preparedIrDraftAbiLookup(program.abi.entries),
    policy: program.runtime[0]!.prepared.manifest.policy,
    demands: new Map(program.ir.functions.map((fn) => [fn.unitId, irProgramRuntimeDemands(fn)])),
  };
}
function caught(action: () => unknown): PreparedIrProgramInvariantError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PreparedIrProgramInvariantError);
    return error as PreparedIrProgramInvariantError;
  }
  throw new Error("expected refusal");
}
function changeClock(change: (body: readonly IrInstr[]) => readonly IrInstr[]): PreparedIrProgram {
  const runtime = clockProgram.runtime[0]!;
  return {
    ...clockProgram,
    runtime: [
      {
        ...runtime,
        prepared: {
          ...runtime.prepared,
          functions: runtime.prepared.functions.map((fn) => ({
            ...fn,
            blocks: fn.blocks.map((block) => ({ ...block, instrs: change(block.instrs) })),
          })),
        },
      },
    ],
  };
}

describe("canonical whole-program runtime projection owners", () => {
  it("forwards manifest producer and projection validators by identity", () => {
    expect(oldManifest.prepareWholeProgramRuntimeManifest).toBe(manifest.prepareWholeProgramRuntimeManifest);
    expect(oldManifest.checkFunctionPopulation).toBe(manifest.checkFunctionPopulation);
    expect(oldManifest.locatedFailure).toBe(manifest.locatedFailure);
    expect(oldManifest.invariant).toBe(manifest.invariant);
    expect(oldProjection.assertPreparedIrRuntimeProjection).toBe(projection.assertPreparedIrRuntimeProjection);
    expect(oldProjection.assertPreparedIrSemanticRuntimeSeparation).toBe(
      projection.assertPreparedIrSemanticRuntimeSeparation,
    );
  });
  it("reconstructs genuine provider projections for both backends", () => {
    expect(sqrt.runtime).toHaveLength(2);
    for (const runtime of sqrt.runtime)
      expect(() => projection.assertPreparedIrRuntimeProjection(sqrt, runtime)).not.toThrow();
    const result = manifest.prepareWholeProgramRuntimeManifest(request(sqrt));
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(result.detail);
    expect(result.runtime).toEqual(sqrt.runtime[0]!.prepared);
    expect(Object.isFrozen(result.runtime)).toBe(true);
  });
  it("prepares an explicit empty manifest from genuine empty source inventory", () => {
    const source = sourcePacket({ "./entry.ts": "export {};" }).source;
    expect(source.ir.functions).toHaveLength(0);
    const result = manifest.prepareWholeProgramRuntimeManifest({ ...source, policy: HOST, demands: new Map() });
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(result.detail);
    expect(result.runtime.functions).toEqual([]);
    expect(result.runtime.providers.size).toBe(0);
  });
  it("locates an incomplete demand map at its real first requesting owner", () => {
    const input = request(sqrt),
      fn = sqrt.ir.functions[0]!;
    expect(manifest.prepareWholeProgramRuntimeManifest({ ...input, demands: new Map() })).toEqual({
      kind: "invariant",
      code: "verifier-failure",
      stage: "verify",
      detail: `runtime demand scan is missing for ${fn.name}`,
      ...preparedIrProgramOwner(sqrt, fn.unitId),
    });
  });
  it("checks physical attachment contamination before a missing demand scan", () => {
    const input = request(asyncProgram),
      semantic = asyncProgram.ir.functions.find((fn) => fn.asyncPlan)!;
    const physical = asyncProgram.runtime[0]!.prepared.functions.find((fn) => fn.unitId === semantic.unitId)!;
    expect(physical.asyncRuntime).toBeDefined();
    const contaminated = {
      ...input,
      ir: { functions: input.ir.functions.map((fn) => (fn === semantic ? physical : fn)) },
      demands: new Map(),
    };
    expect(manifest.prepareWholeProgramRuntimeManifest(contaminated)).toEqual({
      kind: "invariant",
      code: "verifier-failure",
      stage: "verify",
      detail: `semantic input ${semantic.name} already carries a physical async runtime projection`,
      ...preparedIrProgramOwner(asyncProgram, semantic.unitId),
    });
  });
  it("does not invent an owner for an absent demand-map artifact", () => {
    const other = sourcePacket({
      "./entry.ts": 'export { unrelated } from "./other";',
      "./other.ts": "export function unrelated(): number { return 1; }",
    }).source.ir.functions[0]!;
    expect(other.unitId).not.toBe(sqrt.ir.functions[0]!.unitId);
    const input = request(sqrt);
    const error = caught(() =>
      manifest.prepareWholeProgramRuntimeManifest({
        ...input,
        demands: new Map([...input.demands, [other.unitId, irProgramRuntimeDemands(other)]]),
      }),
    );
    expect(error.code).toBe("invalid-prepared-data");
    expect(error.message).toContain(`runtime producer cannot locate ${other.unitId}`);
    expect(error).not.toHaveProperty("location");
  });
  it("removes nonserializable causes while retaining the supplied diagnostic and real owner", () => {
    const fn = sqrt.ir.functions[0]!;
    const result = manifest.locatedFailure(request(sqrt), fn.unitId, {
      kind: "invariant",
      code: "verifier-failure",
      stage: "verify",
      detail: "located test",
      cause: new Error("private"),
    });
    expect(result).toEqual({
      kind: "invariant",
      code: "verifier-failure",
      stage: "verify",
      detail: "located test",
      ...preparedIrProgramOwner(sqrt, fn.unitId),
    });
    expect(result).not.toHaveProperty("cause");
    expect(Object.isFrozen(result)).toBe(true);
  });
  it("refuses physical intrinsic providers in semantic bodies", () => {
    const runtime = sqrt.runtime[0]!;
    const error = caught(() =>
      projection.assertPreparedIrSemanticRuntimeSeparation({ ir: { functions: runtime.prepared.functions } }),
    );
    expect(error.code).toBe("invalid-prepared-data");
    expect(error.message).toContain("physical intrinsic provider");
  });
  it("refuses a missing provider table even when physical instructions are intact", () => {
    const runtime = sqrt.runtime[0]!;
    const mutant = { ...runtime, prepared: { ...runtime.prepared, providers: preparedIrReadonlyMap([]) } };
    const error = caught(() => projection.assertPreparedIrRuntimeProjection(sqrt, mutant));
    expect(error.code).toBe("invalid-prepared-data");
    expect(error.message).toContain("providers");
  });
  it("authenticates async attachment identity after exact data reconstruction", () => {
    const runtime = asyncProgram.runtime[0]!;
    expect(() => projection.assertPreparedIrRuntimeProjection(asyncProgram, runtime)).not.toThrow();
    const copied = freezePreparedIrValue(runtime) as typeof runtime;
    expect(copied).toEqual(runtime);
    expect(() => projection.assertPreparedIrRuntimeProjection(asyncProgram, copied)).toThrowError(
      new Error("IR async runtime attachment for main does not retain its exact semantic plan owner"),
    );
  });
  it("checks clock value and original site independently", () => {
    expect(() => projection.assertPreparedIrRuntimeProjection(clockProgram, clockProgram.runtime[0]!)).not.toThrow();
    const negativeZero = changeClock((body) =>
      body.map((instr) =>
        instr.kind === "const" && instr.value.kind === "f64" ? { ...instr, value: { kind: "f64", value: -0 } } : instr,
      ),
    );
    const error = caught(() => projection.assertPreparedIrRuntimeProjection(negativeZero, negativeZero.runtime[0]!));
    expect(error.code).toBe("invalid-prepared-data");
    expect(error.message).toContain("clock projection");
    expect(error.message).toContain("positive-zero");
  });
  it("checks clock population before producer reconstruction when both are defective", () => {
    const changed = changeClock((body) => body.slice(1));
    const runtime = changed.runtime[0]!;
    const twoDefects = { ...runtime, prepared: { ...runtime.prepared, providers: preparedIrReadonlyMap([]) } };
    const error = caught(() => projection.assertPreparedIrRuntimeProjection(changed, twoDefects));
    expect(error.code).toBe("invalid-prepared-data");
    expect(error.message).toContain("clock projection");
    expect(error.message).toContain("instruction population differs");
    expect(error.message).not.toContain("cannot be reproduced");
  });
  it("checks a missing semantic async plan before a missing demand entry", () => {
    const input = request(asyncProgram),
      fn = asyncProgram.ir.functions.find((fn) => fn.asyncPlan)!;
    const changed = {
      ...input,
      ir: { functions: input.ir.functions.map((item) => (item === fn ? { ...fn, asyncPlan: undefined } : item)) },
      demands: new Map(),
    };
    expect(manifest.prepareWholeProgramRuntimeManifest(changed)).toEqual({
      kind: "invariant",
      code: "verifier-failure",
      stage: "verify",
      detail: `semantic async plan is missing for ${fn.name}`,
      ...preparedIrProgramOwner(asyncProgram, fn.unitId),
    });
  });
  it("rejects clock site drift before a contradictory reconstructed provider table", () => {
    const changed = changeClock((body) => body.map((instr) => ({ ...instr, site: { line: 99, column: 1 } })));
    const runtime = changed.runtime[0]!;
    const error = caught(() =>
      projection.assertPreparedIrRuntimeProjection(changed, {
        ...runtime,
        prepared: { ...runtime.prepared, providers: preparedIrReadonlyMap([]) },
      }),
    );
    expect(error.code).toBe("invalid-prepared-data");
    expect(error.message).toContain("positive-zero/result/type/site");
    expect(error.message).not.toContain("contradicts complete semantic/provider data");
  });
  it("rejects a missing canonical clock provider before producer reproduction", () => {
    const runtime = clockProgram.runtime[0]!;
    const changed = {
      ...runtime,
      prepared: {
        ...runtime.prepared,
        manifest: {
          ...runtime.prepared.manifest,
          providers: runtime.prepared.manifest.providers.filter(
            (provider) => provider.feature !== "async.native.clock-zero",
          ),
        },
      },
    };
    const error = caught(() => projection.assertPreparedIrRuntimeProjection(clockProgram, changed));
    expect(error.code).toBe("invalid-prepared-data");
    expect(error.message).toContain("missing or foreign canonical frozen clock provider");
  });
});
