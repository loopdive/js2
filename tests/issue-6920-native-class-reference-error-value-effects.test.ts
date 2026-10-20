// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it } from "vitest";
import { assertPreparedIrData } from "../src/shared/contracts/prepared-ir-data.js";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import {
  collectNativeProgramClassRequirements,
  nativeProgramClassConstruction,
} from "../src/ir/program/native-program-resource-requirements.js";
import { forEachInstrDeep } from "../src/ir/core/nodes.js";
import { normalizeNativeClassValues } from "../src/ir/program/native-js-class-values.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { analyzeNativeJsClassValueDomains } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/producer.js";
import { replayNativeJsClassValueDomains } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent.js";
import { indexNativeJsClassValueDomainInput } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/input.js";
import type { NativeJsClassValueDomainInput as Input } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/contracts.js";
import {
  REFERENCE_ERROR_DECLARATION,
  REFERENCE_ERROR_SIGNATURE,
  REFERENCE_ERROR_RUNTIME_PROVIDERS,
  REFERENCE_ERROR_HOST_RECORD,
} from "../src/ir/core/reference-error-contract.js";
import { irCallableBindingKey } from "../src/ir/core/callable-bindings.js";
import * as facade from "../src/ir/runtime/reference-error-callable.js";
import {
  RUNTIME_HOST_CAPABILITY_RECORDS,
  resolveRuntimeHostCapabilityFuncRecord,
} from "../src/ir/runtime/host-capabilities.js";
import { copyIrPreparationData } from "../src/ir/analysis/alloc-registry.js";

afterEach(() => yieldTurn());
let inputs: readonly Input[];
let actualProgram: ReturnType<typeof decodePreparedIrProgram>;
function actualInputs(): readonly Input[] {
  if (inputs) return inputs;
  const source = analyzeMultiSource(
    {
      "./entry.ts":
        "let count:number=0;function bump():number{count=count+1;return count;}class A{constructor(value:number){}}export function run():number{new A();new A(bump(),bump());return count;}",
    },
    "./entry.ts",
  );
  const policy = { backend: "wasmgc" as const, target: "wasi" as const };
  const prepared = prepareWholeIrProgram({
    sourceFiles: source.sourceFiles,
    entrySource: source.entryFile,
    checker: source.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
  const program = decodePreparedIrProgram(encodePreparedIrProgram(prepared.program));
  actualProgram = program;
  inputs = [
    normalizeNativeClassValues(program, program.ir, "original"),
    ...program.runtime.map((projection) =>
      normalizeNativeClassValues(program, { ...program.ir, functions: projection.prepared.functions }, "selected"),
    ),
  ].map((value) => {
    if (value.kind !== "normalized") throw Error(JSON.stringify(value));
    return value.input;
  });
  expect(inputs).toHaveLength(1 + program.runtime.length);
  for (const input of inputs) {
    let constructs = 0;
    for (const fn of input.module.functions)
      for (const block of fn.blocks)
        for (const root of block.instrs)
          forEachInstrDeep(root, (operation) => {
            if (operation.kind === "js.class.construct") constructs++;
          });
    expect(constructs).toBe(2);
    console.info(
      JSON.stringify({
        fixture: "genuine missing-extra WASI arguments",
        namespace: input.namespace,
        constructCount: constructs,
        projections: input.runtimeContext!.projections.map((view) => ({
          backend: view.backend,
          target: view.target,
          intrinsicUses: (view.manifest.intrinsicUses as readonly unknown[]).length,
          intrinsicProviderRows: view.providers.length,
        })),
      }),
    );
  }
  return inputs;
}
function nativeCalls(input: Input) {
  return [...indexNativeJsClassValueDomainInput(input).values()].flatMap((fn) => [...fn.nativeReferenceCalls]);
}
function mutate(input: Input, edit: (data: Record<string, any>) => void): Input {
  assertPreparedIrData(input);
  const copy = structuredClone(input) as unknown as Record<string, any>;
  expect(copy).toEqual(input);
  expect(Object.isExtensible(copy.runtimeContext)).toBe(true);
  for (const [index, fn] of input.module.functions.entries()) {
    const originalIndex = input.runtimeContext?.original.functions.indexOf(fn) ?? -1;
    if (originalIndex >= 0)
      expect(copy.module.functions[index]).toBe(copy.runtimeContext.original.functions[originalIndex]);
  }
  edit(copy);
  expect(copy).not.toEqual(input);
  return copy as unknown as Input;
}
it("has one canonical host record and identical facade/declaration/provider objects", () => {
  expect(facade.REFERENCE_ERROR_DECLARATION).toBe(REFERENCE_ERROR_DECLARATION);
  expect(facade.REFERENCE_ERROR_SIGNATURE).toBe(REFERENCE_ERROR_SIGNATURE);
  expect(facade.REFERENCE_ERROR_RUNTIME_PROVIDERS).toBe(REFERENCE_ERROR_RUNTIME_PROVIDERS);
  expect(resolveRuntimeHostCapabilityFuncRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "error.reference.construct")).toBe(
    REFERENCE_ERROR_HOST_RECORD,
  );
  expect(REFERENCE_ERROR_RUNTIME_PROVIDERS).toHaveLength(2);
  expect(REFERENCE_ERROR_SIGNATURE.params).toBe(REFERENCE_ERROR_DECLARATION.params);
  expect(REFERENCE_ERROR_RUNTIME_PROVIDERS.every((row) => row.signature === REFERENCE_ERROR_SIGNATURE)).toBe(true);
  expect(Object.getPrototypeOf(REFERENCE_ERROR_HOST_RECORD)).toBe(Object.prototype);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(REFERENCE_ERROR_HOST_RECORD))) {
    expect("value" in descriptor && descriptor.enumerable && !descriptor.writable && !descriptor.configurable).toBe(
      true,
    );
  }
});
it("closes genuine WASI missing/extra constructor and newTarget candidates in every selected view", () => {
  actualInputs();
  expect(actualProgram.runtime.length).toBeGreaterThan(0);
  for (const projection of actualProgram.runtime) {
    const requirements = collectNativeProgramClassRequirements(actualProgram, projection);
    if (!requirements) throw Error("missing genuine class requirements");
    const catalogue = nativeProgramClassConstruction(requirements, actualProgram, projection);
    expect(catalogue).toHaveLength(2);
    expect(
      catalogue.every((row) => row.gap === undefined && row.targets.length === 1 && row.newTargets.length === 1),
    ).toBe(true);
  }
});
it.each([0, 1])("reconstructs actual view %i null calls and preserves UNKNOWN/mayThrow/call census", (index) => {
  const input = actualInputs()[index]!,
    accepted = nativeCalls(input);
  expect(accepted.length).toBeGreaterThan(0);
  const result = analyzeNativeJsClassValueDomains(input);
  expect(replayNativeJsClassValueDomains(input, result)).toEqual([]);
  const coordinates = [...indexNativeJsClassValueDomainInput(input).values()].flatMap((fn) =>
    fn.occurrences.filter((row) => fn.nativeReferenceCalls.has(row.instr)).map((row) => row.location),
  );
  const rows = coordinates.map((coordinate) =>
    result.calls.find((row) => JSON.stringify(row.location) === JSON.stringify(coordinate)),
  );
  expect(rows).toHaveLength(accepted.length);
  expect(
    rows.every(
      (row) =>
        row?.kind === "direct" && row.targets.length === 0 && row.mayThrow && row.normalDomain.kind === "unknown",
    ),
  ).toBe(true);
  expect(
    result.calls
      .filter((row) => row.kind === "construct")
      .every((row) => row.targets.length === 1 && row.calleeDomain.kind === "known"),
  ).toBe(true);
});
it.each([
  [
    "absent",
    (data: Record<string, any>) => {
      Reflect.deleteProperty(data, "runtimeContext");
    },
  ],
  [
    "provider implementation",
    (data: Record<string, any>) => {
      data.runtimeContext.projections[0].manifest.providers.find(
        (row: any) => row.id === "native.error.reference.construct",
      ).implementation.symbol = "foreign";
    },
  ],
  [
    "policy",
    (data: Record<string, any>) => {
      data.runtimeContext.projections[0].target = "host";
    },
  ],
  [
    "ABI origin",
    (data: Record<string, any>) => {
      data.runtimeContext.abiEntries.find(
        (row: any) => row.plan.structuralReferenceKey === irCallableBindingKey(REFERENCE_ERROR_DECLARATION.ref.binding),
      ).plan.intent.origin = "source";
    },
  ],
] as const)("retains opaque transfer for %s context", (_name, edit) => {
  const input = mutate(actualInputs()[0]!, edit);
  expect(nativeCalls(input)).toHaveLength(0);
  const result = analyzeNativeJsClassValueDomains(input);
  expect(result.obligations.some((row) => row.reason === "opaque-effect")).toBe(true);
  expect(replayNativeJsClassValueDomains(input, result)).toEqual([]);
});
it("rejects a context getter before executing it", () => {
  let effects = 0;
  const input = { ...actualInputs()[0]! };
  Object.defineProperty(input, "runtimeContext", {
    get() {
      effects++;
      throw Error("getter");
    },
    enumerable: true,
  });
  expect(() => indexNativeJsClassValueDomainInput(input)).toThrow();
  expect(effects).toBe(0);
});
it("retains direct-call abrupt bookkeeping without relying on the following syntactic throw", () => {
  const input = mutate(actualInputs()[0]!, (data) => {
    const visited = new Set<object>();
    const remove = (value: unknown): void => {
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index--) {
          if (value[index]?.kind === "throw") value.splice(index, 1);
          else remove(value[index]);
        }
      } else for (const child of Object.values(value)) remove(child);
    };
    remove(data);
  });
  const accepted = nativeCalls(input);
  expect(accepted.length).toBeGreaterThan(0);
  const result = analyzeNativeJsClassValueDomains(input);
  expect(replayNativeJsClassValueDomains(input, result)).toEqual([]);
  const rows = result.calls.filter((row) => row.kind === "direct" && row.targets.length === 0);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.mayThrow).toBe(true);
    expect(result.functions.find((fn) => fn.unitId === row.location.unitId)!.mayThrow).toBe(true);
  }
  const target = rows[0]!.location.unitId;
  const forged = structuredClone(result) as unknown as { functions: { unitId: string; mayThrow: boolean }[] };
  const current = forged.functions.find((fn) => fn.unitId === target)!;
  expect(current.mayThrow).toBe(true);
  current.mayThrow = false;
  const problems = replayNativeJsClassValueDomains(input, forged as unknown as typeof result);
  expect(problems).toEqual([
    {
      reason: "equation",
      unitId: null,
      detail: `function summary ${target}.mayThrow current transfer/fixed-point equation`,
    },
  ]);
});
it.each([
  [
    "missing allUnits",
    (data: Record<string, any>) => {
      Reflect.deleteProperty(data.runtimeContext.inventory, "allUnits");
    },
  ],
  [
    "missing classes",
    (data: Record<string, any>) => {
      Reflect.deleteProperty(data.runtimeContext.inventory, "classes");
    },
  ],
  [
    "missing terminalUnits",
    (data: Record<string, any>) => {
      Reflect.deleteProperty(data.runtimeContext.inventory, "terminalUnits");
    },
  ],
  [
    "empty startup",
    (data: Record<string, any>) => {
      data.runtimeContext.startup = [];
    },
  ],
  [
    "duplicate source owner",
    (data: Record<string, any>) => {
      data.runtimeContext.inventory.sources.push(data.runtimeContext.inventory.sources[0]);
    },
  ],
  [
    "foreign class",
    (data: Record<string, any>) => {
      data.runtimeContext.inventory.classes.push({ ...data.runtimeContext.inventory.classes[0], id: "foreign-class" });
    },
  ],
  [
    "foreign derived owner",
    (data: Record<string, any>) => {
      data.runtimeContext.derivedUnits.push({
        id: data.units[0].unitId,
        sourceId: data.runtimeContext.inventory.sources[0].id,
      });
    },
  ],
  [
    "duplicate original body",
    (data: Record<string, any>) => {
      data.runtimeContext.original.functions.push({ ...data.runtimeContext.original.functions[0], valueCount: 999 });
    },
  ],
  [
    "duplicate selected body",
    (data: Record<string, any>) => {
      data.runtimeContext.projections[0].functions.push({
        ...data.runtimeContext.projections[0].functions[0],
        valueCount: 999,
      });
    },
  ],
  [
    "duplicate policy",
    (data: Record<string, any>) => {
      data.runtimeContext.projections.push(data.runtimeContext.projections[0]);
    },
  ],
  [
    "missing intrinsic plan",
    (data: Record<string, any>) => {
      data.runtimeContext.projections[0].manifest.intrinsicUses.push({ id: "math.abs", version: 1 });
    },
  ],
  [
    "fabricated ReferenceError intrinsic",
    (data: Record<string, any>) => {
      data.runtimeContext.projections[0].providers.push({ intrinsicId: "error.reference.construct", plan: {} });
    },
  ],
] as const)("independently rejects contradictory raw %s", (_name, edit) => {
  const input = mutate(actualInputs()[0]!, edit);
  expect(() => indexNativeJsClassValueDomainInput(input)).toThrow();
  expect(
    replayNativeJsClassValueDomains(input, analyzeNativeJsClassValueDomains(actualInputs()[0]!)).some(
      (problem) => problem.reason === "invalid-input",
    ),
  ).toBe(true);
});
it("does not coerce a DATA policy object through an inherited procedure", () => {
  const input = mutate(actualInputs()[0]!, (data) => {
    data.runtimeContext.projections[0].target = {};
  });
  let effects = 0;
  let calls: ReturnType<typeof nativeCalls> | undefined;
  let problems: ReturnType<typeof replayNativeJsClassValueDomains> | undefined;
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "toString")!;
  try {
    Object.defineProperty(Object.prototype, "toString", {
      ...original,
      value() {
        effects++;
        return "wasi";
      },
    });
    calls = nativeCalls(input);
    const result = analyzeNativeJsClassValueDomains(input);
    problems = replayNativeJsClassValueDomains(input, result);
  } finally {
    Object.defineProperty(Object.prototype, "toString", original);
  }
  expect(calls).toHaveLength(0);
  expect(problems).toEqual([]);
  expect(effects).toBe(0);
});

// These tests establish raw-input guards, not source/engine or temporal-history authority.
function oracleRecord(value: unknown): Record<string, unknown> {
  expect(value !== null && typeof value === "object" && !Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>;
}
function oracleArray(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}
function oracleHealthy(input: Input) {
  expect(nativeCalls(input).length).toBeGreaterThan(0);
  const report = analyzeNativeJsClassValueDomains(input);
  expect(replayNativeJsClassValueDomains(input, report)).toEqual([]);
  return report;
}

it("does not execute a raw context getter through producer or independent replay", () => {
  const healthy = actualInputs()[0]!;
  const report = oracleHealthy(healthy);
  for (const entry of ["producer", "independent"] as const) {
    let effects = 0;
    const input = { ...healthy };
    Object.defineProperty(input, "runtimeContext", {
      enumerable: true,
      get() {
        effects++;
        throw Error("must not observe raw context getter");
      },
    });
    if (entry === "producer") expect(() => analyzeNativeJsClassValueDomains(input)).toThrow();
    else {
      const problems = replayNativeJsClassValueDomains(input, report);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.every((problem) => problem.reason === "invalid-input")).toBe(true);
    }
    expect(effects).toBe(0);
  }
});

it("rejects an object binding kind without inherited toString in either algorithm", () => {
  const healthy = actualInputs()[0]!;
  const report = oracleHealthy(healthy);
  const fixedKey = irCallableBindingKey(REFERENCE_ERROR_DECLARATION.ref.binding);
  const input = mutate(healthy, (data) => {
    const rows = oracleArray(data.runtimeContext.abiEntries).map(oracleRecord);
    const fixed = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => oracleRecord(row.plan).structuralReferenceKey === fixedKey);
    expect(fixed).toHaveLength(1);
    const own = fixed[0]!,
      contract = oracleRecord(own.row.contract);
    const ref = oracleRecord(contract.ref),
      binding = oracleRecord(ref.binding);
    expect(typeof binding.kind).toBe("string");
    rows[own.index] = { ...own.row, contract: { ...contract, ref: { ...ref, binding: { ...binding, kind: {} } } } };
    data.runtimeContext.abiEntries = rows;
  });
  expect(input.module).toEqual(healthy.module);
  expect(input.declarations).toEqual(healthy.declarations);
  expect(input.globals).toEqual(healthy.globals);
  let effects = 0;
  let caught: unknown;
  let producerEffects = -1;
  let problems: ReturnType<typeof replayNativeJsClassValueDomains> | undefined;
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "toString")!;
  try {
    Object.defineProperty(Object.prototype, "toString", {
      ...original,
      value() {
        effects++;
        return "runtime";
      },
    });
    try {
      analyzeNativeJsClassValueDomains(input);
    } catch (error) {
      caught = error;
    }
    producerEffects = effects;
    problems = replayNativeJsClassValueDomains(input, report);
  } finally {
    Object.defineProperty(Object.prototype, "toString", original);
  }
  expect(caught).toBeInstanceOf(TypeError);
  expect((caught as Error).message).toBe("malformed raw callable binding kind");
  expect(producerEffects).toBe(0);
  expect(problems!.length).toBeGreaterThan(0);
  expect(
    problems!.every(
      (problem) => problem.reason === "invalid-input" && problem.detail.includes("malformed raw callable binding kind"),
    ),
  ).toBe(true);
  expect(effects).toBe(0);
});

let twoPolicyInputs: readonly Input[] | undefined;
function actualTwoGcPolicyInputs(): readonly Input[] {
  if (twoPolicyInputs) return twoPolicyInputs;
  const source = analyzeMultiSource(
    {
      "./entry.ts":
        "let count:number=0;function bump():number{count=count+1;return count;}class A{constructor(value:number){}}export function run():number{new A();new A(bump(),bump());return count;}",
    },
    "./entry.ts",
  );
  const policy = { backend: "wasmgc" as const, target: "wasi" as const };
  const prepared = prepareWholeIrProgram({
    sourceFiles: source.sourceFiles,
    entrySource: source.entryFile,
    checker: source.checker,
    policy,
    runtimePolicies: [{ backend: "wasmgc", target: "standalone" }, policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
  const program = decodePreparedIrProgram(encodePreparedIrProgram(prepared.program));
  expect(program.runtime).toHaveLength(2);
  expect(new Set(program.runtime.map((view) => `${view.backend}:${view.target}`))).toEqual(
    new Set(["wasmgc:standalone", "wasmgc:wasi"]),
  );
  twoPolicyInputs = [
    normalizeNativeClassValues(program, program.ir, "original"),
    ...program.runtime.map((view) =>
      normalizeNativeClassValues(program, { ...program.ir, functions: view.prepared.functions }, "selected"),
    ),
  ].map((value) => {
    if (value.kind !== "normalized") throw Error(JSON.stringify(value));
    return value.input;
  });
  expect(twoPolicyInputs).toHaveLength(3);
  for (const input of twoPolicyInputs) {
    expect(input.runtimeContext!.projections).toHaveLength(2);
    for (const view of input.runtimeContext!.projections) expect(view.functions.length).toBeGreaterThan(0);
    let constructs = 0;
    for (const fn of input.module.functions)
      for (const block of fn.blocks)
        for (const root of block.instrs)
          forEachInstrDeep(root, (operation) => {
            if (operation.kind === "js.class.construct") constructs++;
          });
    expect(constructs).toBe(2);
    oracleHealthy(input);
  }
  return twoPolicyInputs;
}

it.each([0, 1])("rejects source provenance drift only in the other actual GC projection %i", (queried) => {
  const healthy = actualTwoGcPolicyInputs()[1 + queried]!;
  const report = oracleHealthy(healthy);
  const other = 1 - queried;
  const input = mutate(healthy, (data) => {
    const views = oracleArray(data.runtimeContext.projections).map(oracleRecord);
    const functions = oracleArray(views[other]!.functions).map(oracleRecord);
    const bodyIndex = functions.findIndex((fn) => Object.hasOwn(fn, "sourceClassBody"));
    expect(bodyIndex).toBeGreaterThanOrEqual(0);
    const body = functions[bodyIndex]!,
      provenance = oracleRecord(body.sourceClassBody);
    expect(typeof provenance.classId).toBe("string");
    functions[bodyIndex] = { ...body, sourceClassBody: { ...provenance, classId: "foreign-class-test-only" } };
    views[other] = { ...views[other], functions };
    data.runtimeContext.projections = views;
  });
  expect(input.module).toEqual(healthy.module);
  expect(input.units).toEqual(healthy.units);
  expect(input.declarations).toEqual(healthy.declarations);
  expect(input.runtimeContext!.original).toEqual(healthy.runtimeContext!.original);
  expect(input.runtimeContext!.inventory).toEqual(healthy.runtimeContext!.inventory);
  expect(input.runtimeContext!.projections[queried]).toEqual(healthy.runtimeContext!.projections[queried]);
  expect(input.runtimeContext!.projections[other]).not.toEqual(healthy.runtimeContext!.projections[other]);
  expect(() => analyzeNativeJsClassValueDomains(input)).toThrow("raw class body provenance differs");
  const problems = replayNativeJsClassValueDomains(input, report);
  expect(problems.length).toBeGreaterThan(0);
  expect(
    problems.every(
      (problem) => problem.reason === "invalid-input" && problem.detail.includes("raw class body provenance differs"),
    ),
  ).toBe(true);
});

it.each(["callable", "global"] as const)("rejects duplicate raw %s ABI slots independently", (kind) => {
  const healthy = actualInputs()[0]!;
  const report = oracleHealthy(healthy);
  const fixedKey = irCallableBindingKey(REFERENCE_ERROR_DECLARATION.ref.binding);
  const input = mutate(healthy, (data) => {
    const rows = oracleArray(data.runtimeContext.abiEntries).map(oracleRecord);
    const startupIds = new Set(
      oracleArray(data.runtimeContext.startup).flatMap((plan) =>
        oracleArray(oracleRecord(plan).bindings).flatMap((binding) => {
          const own = oracleRecord(binding);
          return [own.globalBindingId, own.tdzBindingId];
        }),
      ),
    );
    const eligible = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        const plan = oracleRecord(row.plan),
          contract = oracleRecord(row.contract);
        return (
          plan.slotPolicy !== "alias" &&
          contract.kind === kind &&
          plan.structuralReferenceKey !== fixedKey &&
          (kind !== "global" || !startupIds.has(plan.id))
        );
      });
    expect(eligible.length).toBeGreaterThanOrEqual(2);
    const a = eligible[0]!,
      b = eligible[1]!;
    expect(oracleRecord(a.row.plan).id).not.toBe(oracleRecord(b.row.plan).id);
    const fixed = rows.filter((row) => oracleRecord(row.plan).structuralReferenceKey === fixedKey);
    expect(fixed).toHaveLength(1);
    const fixedBefore = copyIrPreparationData(fixed[0]);
    rows[b.index] = rows[a.index]!;
    data.runtimeContext.abiEntries = rows;
    expect(rows.filter((row) => oracleRecord(row.plan).structuralReferenceKey === fixedKey)).toEqual([fixedBefore]);
  });
  expect(input.module).toEqual(healthy.module);
  expect(input.declarations).toEqual(healthy.declarations);
  expect(input.globals).toEqual(healthy.globals);
  expect(input.runtimeContext!.startup).toEqual(healthy.runtimeContext!.startup);
  expect(input.runtimeContext!.abiEntries).toHaveLength(healthy.runtimeContext!.abiEntries.length);
  expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(/duplicate raw ABI plan identity/);
  const problems = replayNativeJsClassValueDomains(input, report);
  expect(problems.length).toBeGreaterThan(0);
  expect(
    problems.every(
      (problem) => problem.reason === "invalid-input" && problem.detail.includes("duplicate raw ABI plan identity"),
    ),
  ).toBe(true);
});

it.each([
  "class source span",
  "phantom terminal",
  "definition attachment",
  "startup initial world",
  "duplicate Error component",
] as const)("rejects exact raw %s contradiction in both derivations", (kind) => {
  const healthy = actualInputs()[0]!,
    report = oracleHealthy(healthy);
  const input = mutate(healthy, (data) => {
    const context = data.runtimeContext;
    if (kind === "class source span") {
      expect(typeof context.inventory.classes[0].declarationStart).toBe("number");
      const before = context.inventory.classes[0].declarationStart;
      context.inventory.classes[0].declarationStart++;
      expect(context.inventory.classes[0].declarationStart).toBe(before + 1);
    } else if (kind === "phantom terminal") {
      const before = context.inventory.allUnits.length;
      const phantom = { ...context.inventory.terminalUnits[0], id: "phantom-terminal-test-only" };
      context.inventory.allUnits.push(phantom);
      context.inventory.terminalUnits.push(phantom);
      expect(context.inventory.allUnits).toHaveLength(before + 1);
      expect(context.inventory.allUnits.some((row: any) => row.id === phantom.id)).toBe(true);
      expect(data.module.functions.some((row: any) => row.unitId === phantom.id)).toBe(false);
    } else if (kind === "definition attachment") {
      const rows = context.abiEntries.filter((row: any) => Object.hasOwn(row.contract, "nativeJsClassDefinition"));
      expect(rows).toHaveLength(1);
      rows[0].contract.nativeJsClassDefinition = { ...rows[0].contract.nativeJsClassDefinition, name: "foreign-name" };
      expect(rows[0].contract.nativeJsClassDefinition.name).toBe("foreign-name");
    } else if (kind === "startup initial world") {
      const before = structuredClone(context.startup);
      const ids = new Set(context.startup.flatMap((plan: any) => plan.bindings.map((row: any) => row.globalBindingId)));
      const globals = data.globals.filter(
        (row: any) => ids.has(row.ref.binding.bindingId) && row.initial.kind === "uninitialized",
      );
      expect(globals.length).toBeGreaterThan(0);
      const id = globals[0].ref.binding.bindingId;
      expect(context.abiEntries.some((row: any) => row.plan.id === id && row.contract.kind === "global")).toBe(true);
      expect(globals[0].initial).toEqual({ kind: "uninitialized" });
      globals[0].initial = { kind: "unknown" };
      expect(globals[0].initial).toEqual({ kind: "unknown" });
      expect(context.startup).toEqual(before);
    } else {
      const manifest = context.projections[0].manifest;
      const component = manifest.providerComponents.find((row: any) =>
        row.features.includes(REFERENCE_ERROR_DECLARATION.feature),
      );
      expect(component).toBeDefined();
      const before = manifest.providerComponents.length;
      manifest.providerComponents.push(structuredClone(component));
      expect(manifest.providerComponents).toHaveLength(before + 1);
    }
  });
  expect(input.module).toEqual(healthy.module);
  expect(input.definitions).toEqual(healthy.definitions);
  const detail =
    kind === "class source span"
      ? "raw class source ownership differs"
      : kind === "phantom terminal"
        ? "raw terminal/derived reverse body census differs"
        : kind === "definition attachment"
          ? "raw definition attachment differs"
          : kind === "startup initial world"
            ? "raw startup initial world differs"
            : "component reverse census";
  let error: unknown;
  try {
    analyzeNativeJsClassValueDomains(input);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TypeError);
  expect((error as Error).message).toContain(detail);
  const problems = replayNativeJsClassValueDomains(input, report);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.every((problem) => problem.reason === "invalid-input" && problem.detail.includes(detail))).toBe(true);
});

it.each([
  [0, "frame"],
  [1, "frame"],
  [0, "nullable frame"],
  [1, "nullable frame"],
  [0, "unsafe alloc"],
  [1, "unsafe alloc"],
  [0, "flags"],
  [1, "flags"],
  [0, "unit reference"],
  [1, "unit reference"],
] as const)("rejects other GC view %i %s ownership drift before fixed-call proof", (queried, kind) => {
  const healthy = actualTwoGcPolicyInputs()[1 + queried]!,
    report = oracleHealthy(healthy),
    other = 1 - queried;
  const input = mutate(healthy, (data) => {
    const before = data.runtimeContext.projections[other];
    const isolated = structuredClone(before);
    expect(isolated).toEqual(before);
    data.runtimeContext.projections[other] = isolated;
    const functions = isolated.functions;
    const body = functions.find((fn: any) => Object.hasOwn(fn, "sourceClassBody"));
    expect(body).toBeDefined();
    if (kind === "flags") {
      expect(body.role).toBeUndefined();
      body.role = "lifted-closure";
      expect(body.role).toBe("lifted-closure");
    } else if (kind === "nullable frame" || kind === "unsafe alloc") {
      const frame = body.blocks[0].instrs[0];
      expect(frame.kind).toBe("js.class.frame.new");
      expect(frame.resultType.kind).toBe("support-ref");
      expect(frame.resultType.nullable).toBe(false);
      expect(Number.isSafeInteger(frame.alloc) && frame.alloc >= 0).toBe(true);
      if (kind === "nullable frame") {
        frame.resultType.nullable = true;
        expect(frame.resultType.nullable).toBe(true);
      } else {
        frame.alloc = Number.MAX_SAFE_INTEGER + 1;
        expect(Number.isSafeInteger(frame.alloc)).toBe(false);
      }
    } else if (kind === "frame") {
      const frame = body.blocks[0].instrs[0];
      expect(frame.kind).toBe("js.class.frame.new");
      expect(frame.resultType.kind).toBe("support-ref");
      frame.resultType = { kind: "val", val: { kind: "i32" } };
      expect(frame.resultType.kind).toBe("val");
    } else {
      const calls: any[] = [];
      for (const fn of functions)
        for (const block of fn.blocks)
          for (const root of block.instrs)
            forEachInstrDeep(root, (instruction) => {
              if (instruction.kind === "call" && instruction.target.binding.kind === "unit") calls.push(instruction);
            });
      expect(calls.length).toBeGreaterThan(0);
      const before = calls[0].target.binding.unitId;
      expect(functions.some((fn: any) => fn.unitId === before)).toBe(true);
      calls[0].target = {
        ...calls[0].target,
        binding: { ...calls[0].target.binding, unitId: "missing-unit-test-only" },
      };
      expect(calls[0].target.binding.unitId).not.toBe(before);
    }
  });
  expect(input.module).toEqual(healthy.module);
  expect(input.runtimeContext!.projections[queried]).toEqual(healthy.runtimeContext!.projections[queried]);
  expect(input.runtimeContext!.original).toEqual(healthy.runtimeContext!.original);
  const detail = kind === "unit reference" ? "raw unit reference has no body" : "raw class body provenance differs";
  expect(() => analyzeNativeJsClassValueDomains(input)).toThrow(detail);
  const problems = replayNativeJsClassValueDomains(input, report);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.every((problem) => problem.reason === "invalid-input" && problem.detail.includes(detail))).toBe(true);
});

it("rejects missing native class census without borrowing a nominal ABI row", () => {
  const healthy = actualInputs()[0]!,
    report = oracleHealthy(healthy);
  const input = mutate(healthy, (data) => {
    expect(data.runtimeContext.inventory.classes).toHaveLength(1);
    expect(data.definitions).toHaveLength(1);
    data.runtimeContext.inventory.classes = [];
    expect(data.runtimeContext.inventory.classes).toHaveLength(0);
  });
  expect(input.module).toEqual(healthy.module);
  expect(input.definitions).toEqual(healthy.definitions);
  expect(input.runtimeContext!.abiEntries).toEqual(healthy.runtimeContext!.abiEntries);
  expect(() => analyzeNativeJsClassValueDomains(input)).toThrow("raw native class census differs");
  const problems = replayNativeJsClassValueDomains(input, report);
  expect(problems.length).toBeGreaterThan(0);
  expect(
    problems.every(
      (problem) => problem.reason === "invalid-input" && problem.detail.includes("raw native class census differs"),
    ),
  ).toBe(true);
});
it("rejects an omitted false terminal flag on a genuine original initializer", () => {
  const source = analyzeMultiSource(
    {
      "./entry.ts":
        "let count:number=0;class A{x:number=1;constructor(){}}export function run():number{new A();return count;}",
    },
    "./entry.ts",
  );
  const policy = { backend: "wasmgc" as const, target: "wasi" as const };
  const prepared = prepareWholeIrProgram({
    sourceFiles: source.sourceFiles,
    entrySource: source.entryFile,
    checker: source.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
  const program = decodePreparedIrProgram(encodePreparedIrProgram(prepared.program));
  const normalized = normalizeNativeClassValues(program, program.ir, "original");
  if (normalized.kind !== "normalized") throw Error(JSON.stringify(normalized));
  const healthy = normalized.input,
    report = oracleHealthy(healthy);
  const input = mutate(healthy, (data) => {
    const rows = data.runtimeContext.inventory.allUnits.filter(
      (row: any) => row.terminal === false && row.kind === "class-instance-field-initializer",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].terminal).toBe(false);
    expect(data.module.functions.some((fn: any) => fn.unitId === rows[0].id)).toBe(true);
    expect(Reflect.deleteProperty(rows[0], "terminal")).toBe(true);
    expect(Object.hasOwn(rows[0], "terminal")).toBe(false);
  });
  expect(input.module).toEqual(healthy.module);
  expect(input.runtimeContext!.inventory.terminalUnits).toEqual(healthy.runtimeContext!.inventory.terminalUnits);
  expect(() => analyzeNativeJsClassValueDomains(input)).toThrow("raw original terminal flag differs");
  const problems = replayNativeJsClassValueDomains(input, report);
  expect(problems.length).toBeGreaterThan(0);
  expect(
    problems.every(
      (problem) => problem.reason === "invalid-input" && problem.detail.includes("raw original terminal flag differs"),
    ),
  ).toBe(true);
});

// PROPOSAL ONLY: genuine preparation/replay regressions, not engine or temporal
// pre-call snapshot authority. Private roots Set/Map insertion order stays a
// separately reviewed static obligation; no fake ReplayModel is constructed.
import { nativeJsClassValueDataKey as worldOracleKey } from "../src/ir/analysis/allocation-evidence/js-class-value-domains/data.js";
type WorldOracleReport = ReturnType<typeof analyzeNativeJsClassValueDomains>;
type WorldOracleCell = WorldOracleReport["heap"][number];
type WorldOracleProblem = ReturnType<typeof replayNativeJsClassValueDomains>[number];

function worldOraclePrepare(text: string): readonly Input[] {
  const source = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const policy = { backend: "wasmgc" as const, target: "wasi" as const };
  const prepared = prepareWholeIrProgram({
    sourceFiles: source.sourceFiles,
    entrySource: source.entryFile,
    checker: source.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
  const encoded = encodePreparedIrProgram(prepared.program);
  const program = decodePreparedIrProgram(encoded);
  expect(encodePreparedIrProgram(program)).toBe(encoded);
  expect(program.runtime).toHaveLength(1);
  const values = [
    normalizeNativeClassValues(program, program.ir, "original"),
    ...program.runtime.map((view) =>
      normalizeNativeClassValues(program, { ...program.ir, functions: view.prepared.functions }, "selected"),
    ),
  ];
  const rows = values.map((value) => {
    if (value.kind !== "normalized") throw Error(JSON.stringify(value));
    return value.input;
  });
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.namespace)).toEqual(["original", "selected"]);
  return rows;
}
let worldOracleInputs: readonly Input[] | undefined;
function worldOracleActualInputs(): readonly Input[] {
  if (!worldOracleInputs) {
    // Real field and method produce actual value/prototype/environment cells.
    // Real count read retains canonical frontend TDZ factory membership floors.
    worldOracleInputs = worldOraclePrepare(
      "let count:number=0;class A{x:number=1;constructor(){}m():number{return this.x;}}export function run():number{new A();return count;}",
    );
    for (const input of worldOracleInputs) {
      const report = oracleHealthy(input);
      expect(input.definitions).toHaveLength(1);
      expect(report.globals.length).toBeGreaterThan(0);
      expect(report.heap.some((cell) => cell.key.kind === "literal")).toBe(true);
      expect(report.heap.some((cell) => cell.prototypeRoots.length > 0)).toBe(true);
      expect(
        report.heap.some(
          (cell) =>
            cell.key.kind === "internal" &&
            cell.key.value === "environment" &&
            cell.valueDomain.kind === "known" &&
            cell.valueDomain.roots.length > 0,
        ),
      ).toBe(true);
    }
  }
  return worldOracleInputs;
}
function worldOracleCellId(cell: WorldOracleCell): string {
  return `${worldOracleKey(cell.root)}:${worldOracleKey(cell.key)}`;
}
function worldOracleCellField(cell: WorldOracleCell, field: string): WorldOracleProblem {
  return {
    reason: "equation",
    unitId: null,
    detail: `heap cell ${worldOracleCellId(cell)}.${field} current transfer/fixed-point equation`,
  };
}
const worldOracleEdits: readonly [string, (report: WorldOracleReport) => readonly WorldOracleProblem[]][] = [
  [
    "global domain",
    (report) => {
      const row = report.globals.find((value) => value.domain.kind !== "unknown");
      expect(row).toBeDefined();
      Object.assign(row!, { domain: { kind: "unknown" } });
      return [
        {
          reason: "equation",
          unitId: null,
          detail: `global ${row!.bindingId}.domain current transfer/fixed-point equation`,
        },
      ];
    },
  ],
  [
    "global initialization",
    (report) => {
      const row = report.globals[0];
      expect(row).toBeDefined();
      const next = row!.initialization === "initialized" ? "uninitialized" : "initialized";
      expect(next).not.toBe(row!.initialization);
      Object.assign(row!, { initialization: next });
      return [
        {
          reason: "equation",
          unitId: null,
          detail: `global ${row!.bindingId}.initialization current transfer/fixed-point equation`,
        },
      ];
    },
  ],
  [
    "heap value",
    (report) => {
      const cell = report.heap.find((row) => row.valueDomain.kind !== "unknown");
      expect(cell).toBeDefined();
      const expected = worldOracleCellField(cell!, "valueDomain");
      Object.assign(cell!, { valueDomain: { kind: "unknown" } });
      return [expected];
    },
  ],
  [
    "heap presence",
    (report) => {
      const cell = report.heap.find((row) => row.presence === "present");
      expect(cell).toBeDefined();
      const expected = worldOracleCellField(cell!, "presence");
      Object.assign(cell!, { presence: "absent" });
      return [expected];
    },
  ],
  [
    "prototype edge",
    (report) => {
      const cell = report.heap.find((row) => row.prototypeRoots.length > 0);
      expect(cell).toBeDefined();
      const expected = worldOracleCellField(cell!, "prototypeRoots");
      Object.assign(cell!, { prototypeRoots: cell!.prototypeRoots.slice(1) });
      return [expected];
    },
  ],
  [
    "internal environment link",
    (report) => {
      const cell = report.heap.find(
        (row) =>
          row.key.kind === "internal" &&
          row.key.value === "environment" &&
          row.valueDomain.kind === "known" &&
          row.valueDomain.roots.length > 0,
      );
      expect(cell).toBeDefined();
      const expected = worldOracleCellField(cell!, "valueDomain");
      if (cell!.valueDomain.kind !== "known") throw Error("missing genuine rooted environment domain");
      Object.assign(cell!, { valueDomain: { ...cell!.valueDomain, roots: cell!.valueDomain.roots.slice(1) } });
      return [expected];
    },
  ],
  [
    "literal versus internal key kind",
    (report) => {
      const cell = report.heap.find(
        (row) =>
          row.key.kind === "literal" &&
          !report.heap.some(
            (other) =>
              worldOracleKey(other.root) === worldOracleKey(row.root) &&
              other.key.kind === "internal" &&
              row.key.kind === "literal" &&
              other.key.value === row.key.value,
          ),
      );
      expect(cell).toBeDefined();
      const before = worldOracleCellId(cell!);
      if (cell!.key.kind !== "literal") throw Error("missing genuine literal property cell");
      Object.assign(cell!, { key: { kind: "internal", value: cell!.key.value } });
      expect(worldOracleCellId(cell!)).not.toBe(before);
      return [
        { reason: "population", unitId: null, detail: `missing heap cell equation ${before}` },
        { reason: "population", unitId: null, detail: "foreign heap cell rows" },
      ];
    },
  ],
  [
    "actual aggregate root coordinate",
    (report) => {
      const cell = report.heap.find(
        (row) =>
          row.root.kind === "allocation" &&
          report.heap.some(
            (other) =>
              other.root.kind === "allocation" &&
              worldOracleKey(other.root) !== worldOracleKey(row.root) &&
              !report.heap.some(
                (collision) =>
                  worldOracleKey(collision.root) === worldOracleKey(other.root) &&
                  worldOracleKey(collision.key) === worldOracleKey(row.key),
              ),
          ),
      );
      expect(cell).toBeDefined();
      const alternative = report.heap.find(
        (other) =>
          other.root.kind === "allocation" &&
          worldOracleKey(other.root) !== worldOracleKey(cell!.root) &&
          !report.heap.some(
            (collision) =>
              worldOracleKey(collision.root) === worldOracleKey(other.root) &&
              worldOracleKey(collision.key) === worldOracleKey(cell!.key),
          ),
      );
      expect(alternative).toBeDefined();
      const before = worldOracleCellId(cell!);
      Object.assign(cell!, { root: alternative!.root });
      expect(worldOracleCellId(cell!)).not.toBe(before);
      return [
        { reason: "population", unitId: null, detail: `missing heap cell equation ${before}` },
        { reason: "population", unitId: null, detail: "foreign heap cell rows" },
      ];
    },
  ],
];
for (const [dimension, edit] of worldOracleEdits)
  it.each([0, 1])(`keeps ${dimension} public equations strict in actual namespace %i`, (index) => {
    const input = worldOracleActualInputs()[index]!;
    const report = oracleHealthy(input);
    const before = structuredClone(report);
    const forged = structuredClone(report);
    expect(forged).toEqual(report);
    const expected = edit(forged); // Setup/mutation must succeed outside the tested replay call.
    expect(forged).not.toEqual(report);
    const problems = replayNativeJsClassValueDomains(input, forged);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((problem) => problem.reason === "invalid-input" || problem.reason === "invalid-output")).toBe(
      false,
    );
    for (const problem of expected) expect(problems).toContainEqual(problem);
    expect(report).toEqual(before);
    expect(replayNativeJsClassValueDomains(input, report)).toEqual([]);
  });

it("replays order-only own DATA changes without confusing private Map/Set coverage", () => {
  const input = worldOracleActualInputs()[0]!;
  const report = oracleHealthy(input);
  const reordered = structuredClone(input);
  const seen = new WeakSet<object>();
  const reverseRecords = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const member of value) reverseRecords(member);
      return;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) {
      expect("value" in descriptor).toBe(true);
      reverseRecords(descriptor.value);
    }
    for (const key of Object.keys(descriptors)) expect(Reflect.deleteProperty(value, key)).toBe(true);
    for (const key of Object.keys(descriptors).reverse()) Object.defineProperty(value, key, descriptors[key]!);
  };
  reverseRecords(reordered);
  expect(reordered).toEqual(input);
  for (const [index, fn] of input.module.functions.entries()) {
    const original = input.runtimeContext!.original.functions.indexOf(fn);
    if (original >= 0)
      expect(reordered.module.functions[index]).toBe(reordered.runtimeContext!.original.functions[original]);
  }
  expect(analyzeNativeJsClassValueDomains(reordered)).toEqual(report);
  expect(replayNativeJsClassValueDomains(reordered, report)).toEqual([]);
});

// These existing genuine source recipes make public mutation and abrupt/normal
// continuation material. They do not expose a private pre-call World snapshot.
for (const [label, text] of [
  [
    "normal shadow",
    "class C{static m(){return 1;}}export function mutate(){C.m=3;return 0;}export function run(){C.m();return 7;}",
  ],
  [
    "callable replacement",
    "class C{static m(){return 1;}}class D{static n(){return true;}}export function mutate(){C.m=D.n;return 0;}export function run(){return C.m()===true?1:0;}",
  ],
  [
    "abrupt shadow",
    "class C{static m(){return 1;}}function write(){C.m=3;throw 7;}export function mutate(){write();return 0;}export function run(){C.m();return 7;}",
  ],
] as const)
  it(`retains genuine ${label} history through public fixed-point replay`, () => {
    for (const input of worldOraclePrepare(text)) {
      const report = analyzeNativeJsClassValueDomains(input);
      expect(replayNativeJsClassValueDomains(input, report)).toEqual([]);
      const entry = input.exports.find((row) => row.externalName === "run");
      expect(entry).toBeDefined();
      const unit = input.units.find(
        (row) => worldOracleKey(row.target.binding) === worldOracleKey(entry!.target.binding),
      );
      expect(unit).toBeDefined();
      const calls = report.calls.filter((row) => row.location.unitId === unit!.unitId && row.kind === "invoke");
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      if (label === "normal shadow") {
        expect(call.calleeDomain).toMatchObject({
          kind: "known",
          families: expect.arrayContaining(["Number", "Function"]),
        });
        expect(call.mayThrow).toBe(true);
        expect(call.targets).toHaveLength(1);
      } else if (label === "callable replacement") {
        expect(call.targets).toHaveLength(2);
        expect(call.normalDomain).toMatchObject({
          kind: "known",
          families: expect.arrayContaining(["Number", "Boolean"]),
        });
      } else {
        expect(call.calleeDomain).toEqual({ kind: "unknown" });
        expect(call.obligations.some((row) => row.reason === "unknown-callee")).toBe(true);
        expect(report.projections.find((row) => row.externalName === "run")?.decision).toBe("unknown");
        const mutation = input.exports.find((row) => row.externalName === "mutate");
        expect(mutation).toBeDefined();
        const owner = input.units.find(
          (row) => worldOracleKey(row.target.binding) === worldOracleKey(mutation!.target.binding),
        );
        expect(owner).toBeDefined();
        expect(report.functions.find((row) => row.unitId === owner!.unitId)).toMatchObject({
          normalCompletion: false,
          mayThrow: true,
        });
      }
    }
  });

import {
  known as constructPrivateKnown,
  roots as canonicalKnownRoots,
  BOTTOM as privateBottom,
} from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent-kernel.js";
import {
  copyPreparedIrDataObject as knownCopyOracle,
  preparedIrDataMismatch as knownDataMismatch,
} from "../src/shared/contracts/prepared-ir-data.js";
function knownFixture() {
  const candidates = oracleHealthy(actualInputs()[0]!).heap.map((cell) => cell.root);
  expect(candidates.length).toBeGreaterThan(0);
  const families = ["Object", "Number", "Object"] as const;
  const expected = knownCopyOracle({
    kind: "known",
    families: [...new Set(families)].sort(),
    roots: canonicalKnownRoots(candidates),
  });
  return { candidates, families, expected };
}
it("constructs private known DATA with exact old-copy fields, descriptors, aliases and mutability", () => {
  const { candidates, families, expected } = knownFixture(),
    actual = constructPrivateKnown(families, candidates);
  expect(actual.kind).toBe("known");
  if (actual.kind !== "known") throw Error("missing known result");
  expect(knownDataMismatch(actual, expected)).toBeUndefined();
  expect(Object.getPrototypeOf(actual)).toBe(Object.prototype);
  expect(Reflect.ownKeys(actual)).toEqual(["kind", "families", "roots"]);
  expect(Object.isExtensible(actual)).toBe(true);
  for (const key of Reflect.ownKeys(actual)) {
    const descriptor = Object.getOwnPropertyDescriptor(actual, key)!;
    expect(descriptor).toEqual({
      value: Reflect.get(actual, key),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  expect(actual.roots.every((root) => candidates.includes(root))).toBe(true);
  expect(actual.families).not.toBe(families);
  expect(actual.roots).not.toBe(candidates);
  expect(constructPrivateKnown([], candidates)).toBe(privateBottom);
  expect(Reflect.set(actual, "kind", "changed")).toBe(true);
  expect(knownDataMismatch(actual, expected)).toBeDefined();
});
it("defines private known fields without inherited setters or descriptor prototype accessors", () => {
  const { candidates, families, expected } = knownFixture();
  const keys = ["kind", "families", "roots", "value", "get", "set"] as const;
  const saved = keys.map((key) => {
    const old = Object.getOwnPropertyDescriptor(Object.prototype, key);
    return old && Object.assign(Object.create(null), old);
  });
  let reads = 0,
    writes = 0,
    actual: unknown;
  try {
    const hostileDescriptor = {
      __proto__: null,
      configurable: true,
      get() {
        reads++;
        return undefined;
      },
      set() {
        writes++;
      },
    };
    for (const key of keys) Object.defineProperty(Object.prototype, key, hostileDescriptor);
    actual = constructPrivateKnown(families, candidates);
  } finally {
    keys.forEach((key, index) => {
      const old = saved[index];
      if (old) Object.defineProperty(Object.prototype, key, old);
      else Reflect.deleteProperty(Object.prototype, key);
    });
  }
  expect(reads).toBe(0);
  expect(writes).toBe(0);
  expect(knownDataMismatch(actual, expected)).toBeUndefined();
});
it("uses captured property definition for private known construction after import", () => {
  const { candidates, families, expected } = knownFixture(),
    original = Reflect.defineProperty;
  let calls = 0,
    actual: unknown;
  try {
    Reflect.defineProperty = () => {
      calls++;
      throw Error("patched live property definition");
    };
    actual = constructPrivateKnown(families, candidates);
  } finally {
    Reflect.defineProperty = original;
  }
  expect(calls).toBe(0);
  expect(knownDataMismatch(actual, expected)).toBeUndefined();
});
it.each(["field", "child"] as const)("rechecks live private known %s DATA after fresh allocation", (kind) => {
  const { candidates, families } = knownFixture(),
    actual = constructPrivateKnown(families, candidates);
  assertPreparedIrData(actual);
  let reads = 0;
  const target = kind === "field" ? actual : actual.kind === "known" ? actual.families : undefined;
  expect(target).toBeDefined();
  Object.defineProperty(target!, "hostile", {
    enumerable: true,
    configurable: true,
    get() {
      reads++;
      return 7;
    },
  });
  expect(() => assertPreparedIrData(actual)).toThrow();
  expect(reads).toBe(0);
});

import {
  mergeCell as birthCell,
  mergeGlobal as birthGlobal,
  join as birthJoin,
} from "../src/ir/analysis/allocation-evidence/js-class-value-domains/independent-kernel.js";
type BirthCell = Parameters<typeof birthCell>[1];
type BirthGlobal = Parameters<typeof birthGlobal>[1];
function birthFixture() {
  const report = oracleHealthy(actualInputs()[0]!);
  expect(report.heap.length).toBeGreaterThan(0);
  expect(report.globals.length).toBeGreaterThan(0);
  return { cell: report.heap[0]!, global: report.globals[0]! };
}
function birthCellOracle(before: BirthCell, after: BirthCell) {
  return knownCopyOracle({
    ...after,
    presence: before.presence === after.presence ? after.presence : "maybe",
    valueDomain: birthJoin(before.valueDomain, after.valueDomain),
    prototypeRoots: canonicalKnownRoots([...before.prototypeRoots, ...after.prototypeRoots]),
  });
}
function birthGlobalOracle(before: BirthGlobal, after: BirthGlobal) {
  return knownCopyOracle({
    bindingId: after.bindingId,
    initialization: before.initialization === after.initialization ? after.initialization : "maybe",
    domain: birthJoin(before.domain, after.domain),
  });
}
it("preserves complete raw merged cell spread keys, descriptors, prototype and aliases", () => {
  const { cell } = birthFixture(),
    symbol = Symbol("extra"),
    hidden = Symbol("hidden"),
    shared = {};
  const after = Object.assign({ extra: shared, presence: cell.presence }, cell, { [symbol]: shared });
  Object.defineProperties(after, {
    "0": { value: shared, enumerable: true },
    hidden: { value: 1 },
    [hidden]: { value: 2 },
    ["__proto__"]: { value: shared, enumerable: true },
  });
  const expected = birthCellOracle(cell, after),
    actual = birthCell(cell, after);
  expect(Reflect.ownKeys(actual)).toEqual(Reflect.ownKeys(expected));
  expect(Object.getOwnPropertyDescriptors(actual)).toEqual(Object.getOwnPropertyDescriptors(expected));
  expect(Object.getPrototypeOf(actual)).toBe(Object.prototype);
  expect(Object.isExtensible(actual)).toBe(true);
  expect(Reflect.get(actual, "extra")).toBe(shared);
  expect(Reflect.get(actual, symbol)).toBe(shared);
  expect(actual.root).toBe(cell.root);
});
it.each(["normal", "spread-throw", "join-throw"] as const)(
  "retains raw merged cell Proxy/getter order and %s behavior",
  (mode) => {
    const { cell } = birthFixture(),
      token = Error("exact merge effect");
    const execute = (merge: typeof birthCellOracle | typeof birthCell) => {
      const events: string[] = [],
        before = { ...cell },
        after = { ...cell };
      Object.defineProperty(after, "extra", {
        enumerable: true,
        get() {
          events.push("extra:get");
          if (mode === "spread-throw") throw token;
          return 7;
        },
      });
      if (mode === "join-throw")
        Object.defineProperty(before, "valueDomain", {
          get() {
            events.push("before:throw");
            throw token;
          },
        });
      const wrap = (value: BirthCell, label: string) =>
        new Proxy(value, {
          ownKeys(target) {
            events.push(label + ":keys");
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, key) {
            events.push(label + ":desc:" + String(key));
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
          get(target, key) {
            events.push(label + ":get:" + String(key));
            return Reflect.get(target, key);
          },
        });
      let result: unknown, error: unknown;
      try {
        result = merge(wrap(before, "before"), wrap(after, "after"));
      } catch (caught) {
        error = caught;
      }
      return { result, error, events };
    };
    const old = execute(birthCellOracle),
      actual = execute(birthCell);
    expect(actual.events.length).toBeGreaterThan(0);
    expect(actual.events).toEqual(old.events);
    if (mode === "normal") {
      expect(actual.error).toBeUndefined();
      expect(actual.result).toEqual(old.result);
    } else expect(actual.error).toBe(token);
  },
);
it("retains undefined-before identity without reading raw cell or global properties", () => {
  const { cell, global } = birthFixture();
  let reads = 0;
  const handler = {
    get() {
      reads++;
      throw Error("identity branch read");
    },
    ownKeys() {
      reads++;
      throw Error("identity branch keys");
    },
  };
  const rawCell = new Proxy(cell, handler),
    rawGlobal = new Proxy(global, handler);
  expect(birthCell(undefined, rawCell)).toBe(rawCell);
  expect(birthGlobal(undefined, rawGlobal)).toBe(rawGlobal);
  expect(reads).toBe(0);
});
it("retains exact raw global read order without observing extra properties", () => {
  const { global } = birthFixture();
  const execute = (merge: typeof birthGlobalOracle | typeof birthGlobal) => {
    const events: string[] = [],
      after = { ...global };
    Object.defineProperty(after, "extra", {
      enumerable: true,
      get() {
        throw Error("excluded global extra");
      },
    });
    const wrap = (row: BirthGlobal, label: string) =>
      new Proxy(row, {
        get(target, key) {
          events.push(label + ":" + String(key));
          return Reflect.get(target, key);
        },
      });
    return { result: merge(wrap(global, "before"), wrap(after, "after")), events };
  };
  const old = execute(birthGlobalOracle),
    actual = execute(birthGlobal);
  expect(actual.events.length).toBeGreaterThan(0);
  expect(actual).toEqual(old);
  expect(Reflect.ownKeys(actual.result)).toEqual(["bindingId", "initialization", "domain"]);
});
it("keeps merged outputs safe from inherited descriptor poison and live intrinsic patches", () => {
  const { cell, global } = birthFixture(),
    expectedCell = birthCellOracle(cell, cell),
    expectedGlobal = birthGlobalOracle(global, global);
  const keys = [
    "presence",
    "valueDomain",
    "prototypeRoots",
    "bindingId",
    "initialization",
    "domain",
    "value",
    "get",
    "set",
  ];
  const saved = keys.map((key) => {
    const old = Object.getOwnPropertyDescriptor(Object.prototype, key);
    return old && Object.assign(Object.create(null), old);
  });
  const ownKeys = Reflect.ownKeys,
    defineProperty = Reflect.defineProperty;
  let effects = 0,
    actualCell: unknown,
    actualGlobal: unknown;
  try {
    const descriptor = {
      __proto__: null,
      configurable: true,
      get() {
        effects++;
        return undefined;
      },
      set() {
        effects++;
      },
    };
    keys.forEach((key) => Object.defineProperty(Object.prototype, key, descriptor));
    Reflect.ownKeys = () => {
      effects++;
      throw Error("live ownKeys");
    };
    Reflect.defineProperty = () => {
      effects++;
      throw Error("live defineProperty");
    };
    actualCell = birthCell(cell, cell);
    actualGlobal = birthGlobal(global, global);
  } finally {
    Reflect.ownKeys = ownKeys;
    Reflect.defineProperty = defineProperty;
    keys.forEach((key, index) => {
      const old = saved[index];
      if (old) Object.defineProperty(Object.prototype, key, old);
      else Reflect.deleteProperty(Object.prototype, key);
    });
  }
  expect(effects).toBe(0);
  expect(actualCell).toEqual(expectedCell);
  expect(actualGlobal).toEqual(expectedGlobal);
});
it("rechecks mutable merged output DATA rather than trusting its fresh allocation brand", () => {
  const { cell, global } = birthFixture(),
    actualCell = birthCell(cell, cell),
    actualGlobal = birthGlobal(global, global);
  assertPreparedIrData(actualCell);
  assertPreparedIrData(actualGlobal);
  expect(Reflect.set(actualGlobal, "initialization", "changed")).toBe(true);
  expect(knownDataMismatch(actualGlobal, global)).toBeDefined();
  let reads = 0;
  Object.defineProperty(actualCell, "extra", {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  expect(() => assertPreparedIrData(actualCell)).toThrow();
  expect(reads).toBe(0);
});
