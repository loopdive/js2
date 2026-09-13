// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { asValueId, type IrFunction, type IrInstr, type IrInstrCall } from "../src/ir/core/nodes.js";
import type { IrType } from "../src/ir/core/types.js";
import { irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";
import { createIrAsyncPlan, canonicalPromiseAbi, asAsyncStateId } from "../src/ir/analysis/async-plan.js";
import { ASYNC_RUNTIME_FEATURES } from "../src/ir/core/async-intents.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import {
  collectNativeAsyncCallableDemands,
  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,
} from "../src/ir/runtime/native-async-callables.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import type { TypedIrProgramInput } from "../src/ir/program/input-contracts.js";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";

const F64: IrType = { kind: "val", val: { kind: "f64" } };
const I32: IrType = { kind: "val", val: { kind: "i32" } };
const POLICY = { target: "standalone", backend: "wasmgc", stringConst: { storage: "native" } } as const;
const OPTIONS = { ...typedOptions, policy: POLICY, runtimePolicies: [POLICY] };
function clock(result: number, withSite = true): IrInstrCall {
  return {
    kind: "call",
    target: irIntrinsicFuncRef("async.clock.snapshot", "display-name-is-not-authority"),
    args: [],
    result: asValueId(result),
    resultType: F64,
    ...(withSite ? { site: { line: 12, column: 4 } } : {}),
  };
}
function constant(result: number, value: number): IrInstr {
  return { kind: "const", result: asValueId(result), resultType: F64, value: { kind: "f64", value } };
}
function branch(): IrInstr {
  return {
    kind: "if.stmt",
    cond: asValueId(0),
    then: [clock(1)],
    else: [constant(2, 17)],
    result: null,
    resultType: null,
  };
}
let packet: TypedIrProgramInput;
const programs = new Map<"blocks" | "states" | "derived", PreparedIrProgram>();
function fixture(kind: "blocks" | "states" | "derived"): TypedIrProgramInput {
  const owner = packet.ir.functions.find((fn) => fn.name === "main")!;
  const block = owner.blocks[0]!;
  let fn: IrFunction;
  if (kind === "states") {
    fn = {
      ...owner,
      params: [],
      resultTypes: [F64],
      funcKind: "async",
      blocks: [{ ...block, instrs: [constant(4, 0)], terminator: { kind: "return", values: [asValueId(4)] } }],
      valueCount: 5,
      asyncPlan: createIrAsyncPlan({
        schemaVersion: 1,
        ownerUnitId: owner.unitId,
        kind: "async-function",
        abi: canonicalPromiseAbi(F64),
        entry: asAsyncStateId(0),
        params: [],
        values: [I32, F64, F64, F64].map((type, value) => ({ value: asValueId(value), type })),
        spills: [],
        handlers: [],
        runtimeIntents: [...ASYNC_RUNTIME_FEATURES, "promise.number.bridge"],
        states: [
          {
            id: asAsyncStateId(0),
            body: [
              { kind: "const", result: asValueId(0), resultType: I32, value: { kind: "i32", value: 1 } },
              branch(),
              clock(3, false),
            ],
            terminator: { kind: "resolve", value: asValueId(3) },
          },
        ],
      }),
    };
  } else if (kind === "derived") {
    fn = {
      ...owner,
      funcKind: "async",
      params: [{ name: "promise", value: asValueId(0), type: { kind: "val", val: { kind: "externref" } } }],
      resultTypes: [F64],
      valueCount: 3,
      blocks: [
        {
          ...block,
          instrs: [{ kind: "await", operand: asValueId(0), result: asValueId(2), resultType: F64 }, clock(1)],
          terminator: { kind: "return", values: [asValueId(1)] },
        },
      ],
    };
  } else {
    fn = {
      ...owner,
      params: [{ name: "flag", value: asValueId(0), type: I32 }],
      resultTypes: [F64],
      valueCount: 4,
      blocks: [
        { ...block, instrs: [branch(), clock(3, false)], terminator: { kind: "return", values: [asValueId(3)] } },
      ],
    };
  }
  return { ...packet, ir: { functions: packet.ir.functions.map((original) => (original === owner ? fn : original)) } };
}

beforeAll(() => {
  // Logical IR fixtures with genuine inventory/ABI/preparation/replay, not a frontend clock-admission claim.
  packet = sourcePacket({
    "./entry.ts": "export function main(): number { return 1; } export function untouched(): number { return 2; }",
  }).packet;
});

function requireProgramFor(kind: "blocks" | "states" | "derived"): PreparedIrProgram {
  const cached = programs.get(kind);
  if (cached) return cached;
  const program = requireProgram(prepareTypedIrProgram(fixture(kind), OPTIONS));
  programs.set(kind, program);
  return program;
}

function selectedOwner(program: PreparedIrProgram) {
  return program.runtime[0]!.prepared.functions.find((fn) => fn.name === "main")!;
}
function selectedBuffer(program: PreparedIrProgram, states: boolean): readonly IrInstr[] {
  const fn = selectedOwner(program);
  return states ? fn.asyncRuntime!.states[0]!.body : fn.blocks[0]!.instrs;
}
function changeBuffer(
  program: PreparedIrProgram,
  states: boolean,
  change: (body: readonly IrInstr[]) => readonly IrInstr[],
): PreparedIrProgram {
  const projection = program.runtime[0]!;
  const functions = projection.prepared.functions.map((fn) => {
    if (fn.name !== "main") return fn;
    return states
      ? {
          ...fn,
          asyncRuntime: {
            ...fn.asyncRuntime!,
            states: fn.asyncRuntime!.states.map((state, i) =>
              i === 0 ? { ...state, body: change(state.body) } : state,
            ),
          },
        }
      : { ...fn, blocks: fn.blocks.map((block, i) => (i === 0 ? { ...block, instrs: change(block.instrs) } : block)) };
  });
  return { ...program, runtime: [{ ...projection, prepared: { ...projection.prepared, functions } }] };
}
function rejected(program: PreparedIrProgram, independentClockWitness = false): void {
  if (independentClockWitness) expect(() => assertPreparedIrProgram(program)).toThrow(/clock projection /);
  else expect(() => assertPreparedIrProgram(program)).toThrow();
  expect(() => decodePreparedIrProgram(encodePreparedIrProgram(program))).toThrow();
}

describe("explicit native clock projection and independent authentication", () => {
  it.each(["blocks", "states", "derived"] as const)(
    "validates and replays %s while preserving semantic clocks and slot:none",
    (kind) => {
      const program = requireProgramFor(kind);
      expect(() => assertPreparedIrProgram(program)).not.toThrow();
      const demands = collectNativeAsyncCallableDemands(program.ir.functions);
      const clocks = demands.flatMap((demand) =>
        demand.uses.filter((use) => use.feature === "async.native.clock-zero"),
      );
      expect(clocks.length).toBeGreaterThan(0);
      const entry = program.abi.entries.find(
        (entry) =>
          entry.contract.kind === "callable" &&
          entry.contract.ref.binding.kind === "intrinsic" &&
          entry.contract.ref.binding.symbol === "async.clock.snapshot",
      );
      expect(entry?.plan.slotPolicy).toBe("none");
      expect(Object.hasOwn(entry!.plan, "slotSpace")).toBe(false);
      const encoded = encodePreparedIrProgram(program);
      expect(encodePreparedIrProgram(decodePreparedIrProgram(encoded))).toBe(encoded);
      const decodedInput = decodeTypedPacket(encodeTypedPacket(fixture(kind)));
      expect(encodePreparedIrProgram(requireProgram(prepareTypedIrProgram(decodedInput, OPTIONS)))).toBe(encoded);
      if (kind === "derived") {
        const owners = new Set(program.derivedUnits.map((unit) => unit.id));
        expect(
          demands.some(
            (demand) =>
              owners.has(demand.unitId) && demand.uses.some((use) => use.feature === "async.native.clock-zero"),
          ),
        ).toBe(true);
      } else {
        const body = selectedBuffer(program, kind === "states");
        const last = body.at(-1)!;
        expect(last).toMatchObject({
          kind: "const",
          value: { kind: "f64", value: 0 },
          result: asValueId(3),
          resultType: F64,
        });
        expect(Object.hasOwn(last, "site")).toBe(false);
      }
    },
  );

  for (const states of [false, true]) {
    for (const mutation of [
      "surviving",
      "negative-zero",
      "nonzero",
      "nan",
      "result",
      "type",
      "site",
      "site-missing",
      "missing",
      "duplicate",
      "branch",
      "allocation",
    ] as const) {
      it(`rejects ${mutation} at exact ${states ? "state" : "block"} positions through validation and replay`, () => {
        const program = requireProgramFor(states ? "states" : "blocks");
        const bad = changeBuffer(program, states, (body) => {
          const index = body.findIndex((instr) => instr.kind === "if.stmt");
          expect(index).toBeGreaterThanOrEqual(0);
          const instr = body[index]!;
          if (instr.kind !== "if.stmt") throw new Error("missing branch control");
          const original = instr.then[0]!;
          expect(original.kind).toBe("const");
          let changed: IrInstr = original;
          if (mutation === "surviving") changed = clock(1);
          if (mutation === "negative-zero" || mutation === "nonzero" || mutation === "nan")
            changed = {
              ...original,
              kind: "const",
              value: { kind: "f64", value: mutation === "negative-zero" ? -0 : mutation === "nan" ? NaN : 1 },
            } as IrInstr;
          if (mutation === "result") changed = { ...original, result: asValueId(99) } as IrInstr;
          if (mutation === "type") changed = { ...original, resultType: I32 } as IrInstr;
          if (mutation === "site") changed = { ...original, site: { line: 12, column: 5 } };
          if (mutation === "site-missing") {
            const { site: _site, ...withoutSite } = original;
            changed = withoutSite as IrInstr;
          }
          if (mutation === "allocation") changed = { ...original, alloc: "foreign-allocation" } as unknown as IrInstr;
          const replacement =
            mutation === "branch"
              ? { ...instr, then: [], else: [...instr.then, ...instr.else] }
              : {
                  ...instr,
                  then: mutation === "missing" ? [] : mutation === "duplicate" ? [changed, changed] : [changed],
                };
          return body.map((value, i) => (i === index ? replacement : value));
        });
        rejected(bad, true);
        expect(() => assertPreparedIrProgram(program)).not.toThrow();
      });
    }
  }

  it("rejects owner movement and owner order changes", () => {
    const program = requireProgramFor("blocks"),
      projection = program.runtime[0]!;
    const functions = [...projection.prepared.functions];
    expect(functions).toHaveLength(2);
    rejected(
      {
        ...program,
        runtime: [{ ...projection, prepared: { ...projection.prepared, functions: [...functions].reverse() } }],
      },
      true,
    );
    const main = functions.findIndex((fn) => fn.name === "main"),
      other = 1 - main;
    const moved = functions.map((fn, i) => ({ ...fn, blocks: functions[i === main ? other : main]!.blocks }));
    rejected(
      { ...program, runtime: [{ ...projection, prepared: { ...projection.prepared, functions: moved } }] },
      true,
    );
  });

  it.each(["missing", "duplicate", "foreign", "implementation", "policy"] as const)(
    "rejects %s frozen clock authority in actual prepared replay",
    (mutation) => {
      const program = requireProgramFor("blocks"),
        projection = program.runtime[0]!,
        manifest = projection.prepared.manifest;
      const provider = manifest.providers.find((row) => row.feature === "async.native.clock-zero")!;
      let providers = [...manifest.providers];
      if (mutation === "missing") providers = providers.filter((row) => row !== provider);
      if (mutation === "duplicate") providers.push(provider);
      if (mutation === "foreign")
        providers = providers.map((row) => (row === provider ? { ...row, id: "foreign.clock" as typeof row.id } : row));
      if (mutation === "implementation")
        providers = providers.map((row) =>
          row === provider
            ? { ...row, implementation: { kind: "runtime-callable" as const, symbol: "foreign.clock" } }
            : row,
        );
      const policy = mutation === "policy" ? { ...manifest.policy, stringConst: undefined } : manifest.policy;
      rejected(
        {
          ...program,
          runtime: [
            { ...projection, prepared: { ...projection.prepared, manifest: { ...manifest, providers, policy } } },
          ],
        },
        true,
      );
    },
  );

  it("uses canonical frozen provider contents rather than requiring catalogue identity", () => {
    const program = requireProgramFor("blocks");
    const selected = program.runtime[0]!.prepared.manifest.providers.find(
      (provider) => provider.feature === "async.native.clock-zero",
    )!;
    const catalogue = NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS.find(
      (provider) => provider.feature === "async.native.clock-zero",
    )!;
    expect(selected).not.toBe(catalogue);
    expect(selected).toMatchObject({
      id: "native.async.clock-zero",
      implementation: { kind: "standalone-clock-zero" },
      dependencies: [],
      hostCapabilities: [],
    });
    expect(() => assertPreparedIrProgram(program)).not.toThrow();
  });

  it("retains full reproduction checks for unrelated non-clock data", () => {
    const program = requireProgramFor("blocks"),
      projection = program.runtime[0]!;
    const functions = projection.prepared.functions.map((fn) =>
      fn.name !== "untouched"
        ? fn
        : {
            ...fn,
            blocks: fn.blocks.map((block) => ({
              ...block,
              instrs: block.instrs.map((instr) =>
                instr.kind === "const" && instr.value.kind === "f64"
                  ? { ...instr, value: { kind: "f64" as const, value: 99 } }
                  : instr,
              ),
            })),
          },
    );
    const bad = { ...program, runtime: [{ ...projection, prepared: { ...projection.prepared, functions } }] };
    expect(() => assertPreparedIrProgram(bad)).toThrow("contradicts complete semantic/provider data");
    rejected(bad);
  });

  it("preserves copy-on-write identities, explicit site presence, and omitted-demand compatibility", () => {
    const input = fixture("blocks");
    const legacy = prepareIrRuntimeManifest({
      functions: input.ir.functions,
      sourceFile: "entry.ts",
      policy: POLICY,
      includeEmpty: true,
    });
    expect(legacy.functions[0]).toBe(input.ir.functions[0]);
    expect(legacy.manifest.providers.some((row) => row.feature === "async.native.clock-zero")).toBe(false);
    const selected = prepareIrRuntimeManifest({
      functions: input.ir.functions,
      sourceFile: "entry.ts",
      policy: POLICY,
      includeEmpty: true,
      builtinDemands: collectNativeAsyncCallableDemands(input.ir.functions),
    });
    const unchanged = input.ir.functions.findIndex((fn) => fn.name === "untouched");
    expect(selected.functions[unchanged]).toBe(input.ir.functions[unchanged]);
    const owner = input.ir.functions.findIndex((fn) => fn.name === "main");
    const before = input.ir.functions[owner]!.blocks[0]!.instrs[0]!,
      after = selected.functions[owner]!.blocks[0]!.instrs[0]!;
    if (before.kind !== "if.stmt" || after.kind !== "if.stmt") throw new Error("missing branch");
    expect(after.else).toBe(before.else);
    expect(after.then[0]!.site).toBe(before.then[0]!.site);
    expect(after.then[0]!.resultType).toBe(before.then[0]!.resultType);
  });

  it("rejects allocation-marked semantic clocks instead of dropping metadata", () => {
    const input = fixture("blocks");
    const functions = input.ir.functions.map((fn) =>
      fn.name !== "main"
        ? fn
        : {
            ...fn,
            blocks: fn.blocks.map((block) => ({
              ...block,
              instrs: block.instrs.map((instr) =>
                instr.kind === "call" ? ({ ...instr, alloc: "clock-allocation" } as unknown as IrInstr) : instr,
              ),
            })),
          },
    );
    expect(() =>
      prepareIrRuntimeManifest({
        functions,
        sourceFile: "entry.ts",
        policy: POLICY,
        includeEmpty: true,
        builtinDemands: collectNativeAsyncCallableDemands(functions),
      }),
    ).toThrow("allocation metadata");
    const program = requireProgramFor("blocks");
    rejected({ ...program, ir: { functions } });
  });
});
