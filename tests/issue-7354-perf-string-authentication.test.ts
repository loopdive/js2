// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 Perf — every string emit re-authenticated the whole native string plan (a full re-plan of the program).
// The retained reservation input is now authenticated once when it can no longer change (deeply frozen prepared
// data): its verdict is permanent. Input that can still change is re-authenticated at every use, as before, and the
// physical layout audit runs at every use either way. These tests pin both halves: a mutation between two emits is
// refused, and the predicate that decides "can no longer change" rejects every mutable shape.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { reserveNativeStringLiteralTypes } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { freezePreparedIrValue, preparedIrReadonlyMap } from "../src/ir/program/data.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import {
  planNativeStringValuePhysical,
  reserveNativeStringValueResources,
  fillNativeStringValueResources,
  emitPreparedNativeStringLiteral,
  isImmutablePreparedIrValue,
  type NativeStringValueReservationInput,
} from "../src/backend/wasmgc/program/native-string-values.js";

const policy = {
  target: "standalone",
  backend: "wasmgc",
  stringConst: { storage: "native" },
  numberBoundary: { box: "unsupported", unbox: "native" },
} as const;

function demandsOf(source: string) {
  const prepared = prepareIrProgramSources({
    ...sourceInput({ "./entry.ts": source }),
    policy,
    nativeStringValueProjection: "standalone-native",
  });
  if (prepared.kind !== "prepared") throw new Error(prepared.detail);
  const program = requireProgram(
    prepareTypedIrProgram(captureTypedIrProgramInput(prepared), { ...typedOptions, policy, runtimePolicies: [policy] }),
  );
  return collectNativeStringValueDemands(program, program.runtime[0]!);
}

/** Reserve and fill from `input(demands, plan)`; return an emitter of the first planned literal. */
function filled(retain: (demands: ReturnType<typeof demandsOf>, plan: never) => NativeStringValueReservationInput) {
  const demands = demandsOf(`export function run(): string { return "hello"; }`);
  const outcome = planNativeStringValuePhysical(demands, { representation: "native-string", utf8Storage: false });
  if (outcome.kind !== "planned") throw new Error("expected a planned string value");
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const types = reserveNativeStringLiteralTypes(tx, outcome.plan.key, false);
  const input = retain(demands, outcome.plan as never);
  const pack = reserveNativeStringValueResources(tx, input, types);
  tx.freezeReservations();
  fillNativeStringValueResources(tx, pack);
  const demand = input.demands.literals[input.plan.literalUses[0]!.demandIndex]!;
  if (demand.kind !== "string.const") throw new Error("expected a string literal demand");
  const owner = input.demands.buffers[input.demands.occurrences[demand.occurrence]!.bufferIndex]!.ownerUnitId;
  const i = demand.instruction;
  const emit = () => emitPreparedNativeStringLiteral(tx, pack, owner, i.value, i.alloc, i.storage, i.materializer);
  return { input, emit, tx, module };
}

describe("#7354 Perf — one authentication per unchangeable plan state", () => {
  it("the Prepared producers hand over input that can no longer change", () => {
    const { input, emit } = filled((demands, plan) => ({ demands, plan }));
    // The retained input is a frozen copy of these fields.
    expect(isImmutablePreparedIrValue(Object.freeze({ ...input }))).toBe(true);
    expect(emit()).toEqual(emit());
    expect(() => {
      (input.demands.literals as unknown[]).length = 0;
    }).toThrow(TypeError);
    expect(() => {
      (input.plan.literalUses as unknown[]).length = 0;
    }).toThrow(TypeError);
  });

  it("still audits the physical layout at every emit of an authenticated plan", () => {
    const { emit, module } = filled((demands, plan) => ({ demands, plan }));
    emit();
    const global = module.globals.find((row) => row.init.length > 0)!;
    global.init = [];
    expect(emit).toThrow(/altered/);
  });

  it("refuses retained demands changed between two emits", () => {
    const { input, emit } = filled((demands, plan) => ({
      demands: { ...demands, literals: [...demands.literals] },
      plan,
    }));
    expect(isImmutablePreparedIrValue(input)).toBe(false);
    emit();
    (input.demands.literals as unknown[]).pop();
    expect(emit).toThrow(/changed retained string demands/);
  });

  it("refuses a retained plan changed between two emits", () => {
    const { input, emit } = filled((demands, plan) => ({ demands, plan: structuredClone(plan) }));
    expect(isImmutablePreparedIrValue(input)).toBe(false);
    emit();
    (input.plan.literalUses[0] as { cacheKey: string }).cacheKey = "altered";
    expect(emit).toThrow(/demand\/plan mismatch/);
  });

  it("refuses a plan changed after many emits, not only after the first", () => {
    const { input, emit } = filled((demands, plan) => ({ demands, plan: structuredClone(plan) }));
    for (let count = 0; count < 3; count++) emit();
    (input.plan.literalRequirements as { utf8Storage: boolean }).utf8Storage = true;
    expect(emit).toThrow(/native string values/);
  });
});

describe("#7354 Perf — isImmutablePreparedIrValue", () => {
  const frozen = <T extends object>(value: T) => Object.freeze(value);
  it.each([
    [
      "frozen prepared data",
      freezePreparedIrValue({ a: [1, { b: "c" }], m: new Map([["k", { v: 1 }]]), s: new Set([{ w: 2 }]) }),
      true,
    ],
    ["a frozen null-prototype record", frozen(Object.assign(Object.create(null), { a: 1 })), true],
    ["primitives", 1, true],
    ["a shared frozen node reached twice", frozen({ a: frozen([1]), b: undefined }), true],
    ["an unfrozen record", { a: 1 }, false],
    ["an unfrozen nested record", frozen({ a: { b: 1 } }), false],
    ["an unfrozen array", frozen({ a: [1] }), false],
    ["a frozen record holding a native Map", frozen({ a: frozen(new Map()) }), false],
    ["a frozen record holding a native Set", frozen({ a: frozen(new Set()) }), false],
    // Its entries are reachable only through Map.prototype, which no authentication applies to a plain object.
    ["a frozen Map with its prototype erased", frozen(Object.setPrototypeOf(new Map(), Object.prototype)), true],
    ["a frozen Map", frozen(new Map()), false],
    [
      "a frozen cycle",
      (() => {
        const node: { self?: unknown } = {};
        node.self = node;
        return frozen(node);
      })(),
      true,
    ],
    ["a frozen class instance", frozen(new (class Box {})()), false],
    ["a frozen array with a foreign prototype", frozen(Object.setPrototypeOf([1], Object.prototype)), false],
    ["an accessor", frozen(Object.defineProperty({}, "a", { get: () => 1, enumerable: true })), false],
    ["a function", frozen({ a: frozen(() => 1) }), false],
    ["a mutable value inside a frozen map", preparedIrReadonlyMap([["k", { v: 1 }]]), false],
    ["a mutable key of a frozen map", preparedIrReadonlyMap([[{ k: 1 }, 1]]), false],
  ] as const)("%s", (_, value, expected) => {
    expect(isImmutablePreparedIrValue(value)).toBe(expected);
  });
});
