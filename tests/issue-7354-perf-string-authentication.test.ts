// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 Perf — every string emit re-authenticated the whole native string plan (a full re-plan of the program).
// The retained reservation input is now authenticated once when it can no longer change (deeply frozen prepared
// data): its verdict is permanent. Input that can still change is re-authenticated at every use, as before. These
// tests pin both halves: a mutation between two emits is refused, and the predicate that decides "can no longer
// change" rejects every mutable shape. The physical layout audit runs at the ledger's seal (#7354 Perf4), so an
// alteration of module storage made between or during emits is reported there.
import { describe, expect, it, vi } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { reserveNativeStringLiteralTypes } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { freezePreparedIrRuntimeValue, freezePreparedIrValue, preparedIrReadonlyMap } from "../src/ir/program/data.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import {
  planNativeStringValuePhysical,
  reserveNativeStringValueResources,
  fillNativeStringValueResources,
  emitPreparedNativeStringLiteral,
  requireCompletedNativeStringValues,
  type NativeStringValueReservationInput,
} from "../src/backend/wasmgc/program/native-string-values.js";
import { isImmutablePreparedIrValue } from "../src/ir/program/settled-verdict.js";

// Test seam: a write to module storage from inside the emit's completion check.
const inject = vi.hoisted(() => ({ write: undefined as (() => void) | undefined }));
vi.mock("../src/backend/wasmgc/resources/native-string-literals.js", async (original) => {
  const actual = await original<typeof import("../src/backend/wasmgc/resources/native-string-literals.js")>();
  return {
    ...actual,
    requireCompletedNativeStringLiterals: (...args: Parameters<typeof actual.requireCompletedNativeStringLiterals>) => {
      const write = inject.write;
      inject.write = undefined;
      write?.();
      return actual.requireCompletedNativeStringLiterals(...args);
    },
  };
});

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
  const emitWith = (storage: typeof i.storage) =>
    emitPreparedNativeStringLiteral(tx, pack, owner, i.value, i.alloc, storage, i.materializer);
  return { input, emit, emitWith, tx, pack, module };
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

  it("reports a filled global altered after many emits of an authenticated plan at the seal", () => {
    const { emit, module, tx } = filled((demands, plan) => ({ demands, plan }));
    for (let count = 0; count < 5; count++) emit();
    const global = module.globals.find((row) => row.init.length > 0)!;
    global.init = [];
    expect(() => tx.seal()).toThrow(/altered completed global/);
  });

  it("reports a population changed after many emits of an authenticated plan at the seal", () => {
    const { emit, module, tx } = filled((demands, plan) => ({ demands, plan }));
    for (let count = 0; count < 5; count++) emit();
    module.globals.push({ ...module.globals[0]! });
    expect(() => tx.seal()).toThrow(/population/);
  });

  it("reports a write made during one completion check at the seal", () => {
    const { emit, tx, pack, module } = filled((demands, plan) => ({ demands, plan }));
    emit();
    const global = module.globals.find((row) => row.init.length > 0)!;
    inject.write = () => {
      global.init = [];
    };
    requireCompletedNativeStringValues(tx, pack);
    expect(inject.write).toBeUndefined();
    expect(() => tx.seal()).toThrow(/altered completed global/);
  });

  it("matches the whole literal tuple, not only its strings", () => {
    const { emit, emitWith } = filled((demands, plan) => ({ demands, plan }));
    emit();
    const storage = { binding: { kind: "support", id: "not-planned" } } as never;
    expect(() => emitWith(storage)).toThrow(/outside the closed projection plan/);
  });

  it("re-authenticates a settled plan after a shared prototype gains a field", () => {
    const { emit, input } = filled((demands, plan) => ({ demands, plan }));
    emit();
    expect(input.outputRequirements).toBeUndefined();
    const prototype = Object.prototype as { outputRequirements?: unknown };
    prototype.outputRequirements = { demands: input.demands };
    try {
      expect(emit).toThrow(/unexpected output requirements/);
    } finally {
      Reflect.deleteProperty(prototype, "outputRequirements");
    }
    expect(emit()).toEqual(emit());
  });

  it.each(["map", "set"] as const)("refuses a forged frozen %s over mutable storage", (kind) => {
    const genuine = kind === "map" ? preparedIrReadonlyMap([["unit", 1]]) : freezePreparedIrValue(new Set(["unit"]));
    const inner: Map<unknown, unknown> = new Map([["unit", 1]]);
    const forged = Object.setPrototypeOf(
      {
        get size() {
          return inner.size;
        },
        [Symbol.iterator]: () => (kind === "map" ? inner.entries() : inner.keys()),
      },
      Object.getPrototypeOf(genuine),
    );
    expect(isImmutablePreparedIrValue(Object.freeze(forged))).toBe(false);
    expect(isImmutablePreparedIrValue(genuine)).toBe(true);
    // A bare object on the borrowed prototype is not a collection (and is not iterated).
    expect(isImmutablePreparedIrValue(Object.freeze(Object.create(Object.getPrototypeOf(genuine))))).toBe(false);
    // A subclass carries the private brand but may override what iteration reads.
    const Base = Object.getPrototypeOf(genuine).constructor as new (entries: unknown[]) => object;
    const Sub = class extends Base {
      [Symbol.iterator]() {
        return kind === "map" ? inner.entries() : inner.keys();
      }
    };
    expect(isImmutablePreparedIrValue(new Sub(kind === "map" ? [["unit", 1]] : ["unit"]))).toBe(false);
    // The shared data vocabulary no longer takes the borrowed prototype for a collection either.
    expect(() => freezePreparedIrValue(forged)).toThrow(/unsupported mutable/);
    expect(() => freezePreparedIrRuntimeValue(forged)).toThrow(/mutable or executable context state/);
  });

  // The data vocabulary now brand-checks collections too, so the forged units are refused at planning already.
  it("refuses the reviewer's forged program units", () => {
    const demands = demandsOf(`export function run(): string { return "hello"; }`);
    const program = demands.program as unknown as Record<string, unknown>;
    const units = program.units as ReadonlyMap<unknown, unknown>;
    const inner = new Map(units);
    const forged = Object.setPrototypeOf(
      {
        get size() {
          return inner.size;
        },
        get: (key: unknown) => inner.get(key),
        has: (key: unknown) => inner.has(key),
        keys: () => inner.keys(),
        values: () => inner.values(),
        entries: () => inner.entries(),
        forEach: (callback: (value: unknown, key: unknown) => void) => inner.forEach(callback),
        [Symbol.iterator]: () => inner.entries(),
      },
      Object.getPrototypeOf(units),
    );
    const program2 = Object.freeze({ ...program, units: forged }) as never;
    expect(() => {
      const forgedDemands = collectNativeStringValueDemands(program2, demands.projection);
      const outcome = planNativeStringValuePhysical(forgedDemands, {
        representation: "native-string",
        utf8Storage: false,
      });
      if (outcome.kind !== "planned") throw new Error("expected a planned string value");
      const tx = new PhysicalModuleReservations(createEmptyModule());
      const types = reserveNativeStringLiteralTypes(tx, outcome.plan.key, false);
      const input = { demands: forgedDemands, plan: outcome.plan };
      const pack = reserveNativeStringValueResources(tx, input, types);
      tx.freezeReservations();
      fillNativeStringValueResources(tx, pack);
      const demand = forgedDemands.literals[outcome.plan.literalUses[0]!.demandIndex]!;
      if (demand.kind !== "string.const") throw new Error("expected a string literal demand");
      const owner = forgedDemands.buffers[forgedDemands.occurrences[demand.occurrence]!.bufferIndex]!.ownerUnitId;
      const i = demand.instruction;
      const emit = () => emitPreparedNativeStringLiteral(tx, pack, owner, i.value, i.alloc, i.storage, i.materializer);
      emit();
      emit();
      inner.set("bogus-unit", 1);
      emit();
    }).toThrow(/stale or mismatched demand census/);
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
