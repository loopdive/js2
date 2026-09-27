// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { setImmediate as yieldToReporter } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { captureNativeFamilyRuntimeSupport } from "./helpers/native-family-runtime-support.js";
import { sourceInput, typedOptions, requireProgram, sourcePacket } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";
import {
  collectNativePromiseSourceCensus,
  assertNativePromiseSourceCensusCurrent,
  nativePromiseUnshadowedFields,
  compareNativePromiseMethodCoverage,
  type PromiseLookupFacts,
} from "../src/ir/program/native-promise-inventory.js";
import {
  observeNativeStringValueProducer,
  validateNativePromiseLookupFacts,
  type CarrierRow,
  assertNativeStringValueProducerObservationCurrent,
} from "../src/backend/wasmgc/resources/native-promise-inventory.js";
import {
  planNativeStringValuePhysical,
  type NativeStringValueReservationInput,
} from "../src/backend/wasmgc/program/native-string-values.js";
import { deriveNativeValueResourcePlan } from "../src/ir/program/native-value-resources.js";
import { deriveNativeStringOutputRequirements } from "../src/ir/program/native-string-output-requirements.js";
import { planNativePromiseResources } from "../src/ir/program-native-async-resources.js";
import { asAllocSiteId } from "../src/ir/core/nodes.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { reserveNativeStringValueResources } from "../src/backend/wasmgc/program/native-string-values.js";
import { reserveNativeStringLiteralTypes } from "../src/backend/wasmgc/resources/native-string-literals.js";

const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
const options = {
  backend: "wasmgc",
  target: "standalone",
  sharedExceptionTag: false,
  utf8Storage: false,
  sourceMap: false,
  moduleName: "promise-inventory",
} as const;
afterEach(async () => {
  await yieldToReporter();
});
function prepare(gvnMode: "off" | "on" = "off", decoded = false) {
  const text = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
  const source = prepareIrProgramSources({
    ...sourceInput({ "./entry.ts": text }),
    policy,
    promiseDelayProjection: "standalone-native",
    asyncFamilyProjection: "standalone-native",
  });
  if (source.kind !== "prepared") throw new Error(source.detail);
  const packet = captureNativeFamilyRuntimeSupport(source, policy);
  const program = requireProgram(
    prepareTypedIrProgram(decoded ? decodeTypedPacket(encodeTypedPacket(packet)) : packet, {
      ...typedOptions,
      policy,
      runtimePolicies: [policy],
      controls: { ...typedOptions.controls, gvnMode },
    }),
  );
  const projection = program.runtime[0]!;
  const census = collectNativePromiseSourceCensus(program, projection, options);
  const native = planNativeStringValuePhysical(census.demands, {
    representation: "native-string",
    utf8Storage: false,
    stringConcatEmptyIdentity: true,
  });
  if (native.kind !== "planned") throw new Error(`actual family producer: ${native.kind}`);
  const outputRequirements = native.plan.output
    ? deriveNativeStringOutputRequirements(census.demands, native.plan.output.options)
    : undefined;
  if (outputRequirements && "kind" in outputRequirements) throw new Error(outputRequirements.detail);
  const input: NativeStringValueReservationInput = {
    demands: census.demands,
    plan: native.plan,
    ...(outputRequirements ? { outputRequirements } : {}),
    ...(native.plan.mode === "number-boundary"
      ? { valueRequirements: deriveNativeValueResourcePlan(program, projection, "native-string") }
      : {}),
  };
  return { program, projection, census, input };
}
let cached: ReturnType<typeof prepare> | undefined;
function actual() {
  return (cached ??= prepare());
}

describe("bounded source inventory, unchanged full async family", () => {
  it("joins separately collected census wrappers by borrowed sources, not wrapper identity", () => {
    const { program, projection, census, input } = actual();
    const second = collectNativePromiseSourceCensus(program, projection, options);
    expect(second).not.toBe(census);
    expect(second.demands).not.toBe(input.demands);
    expect(second.demands.owners[0]!.programFunction).toBe(input.demands.owners[0]!.programFunction);
    expect(observeNativeStringValueProducer(second, input).input).toBe(input);
    expect(() => observeNativeStringValueProducer({ ...second }, input)).toThrow(/uncollected/);
  });
  it("collects descriptive no-demand re-export-only entries without an anchor", () => {
    const program = requireProgram(
      prepareTypedIrProgram(
        sourcePacket({
          "./entry.ts": 'export { run } from "./lib";',
          "./lib.ts": "export function run(): number { return 42; }",
        }).packet,
        typedOptions,
      ),
    );
    const entry = program.inventory.sources.find((row) => row.kind === "entry")!;
    expect(program.inventory.terminalUnits.filter((row) => row.sourceId === entry.id)).toHaveLength(0);
    const census = collectNativePromiseSourceCensus(program, program.runtime[0]!, options);
    expect(census.required).toBe(false);
    expect(Object.hasOwn(census, "anchorUnitId")).toBe(false);
    assertNativePromiseSourceCensusCurrent(census);
  });
  it("freezes owned support locators and preserves current borrowed associations", () => {
    const { census } = actual();
    expect(census.supportBuffers).toHaveLength(31);
    expect(census.supportOccurrences).toHaveLength(157);
    for (const buffer of census.supportBuffers) {
      expect(Object.isFrozen(buffer.root)).toBe(true);
      expect(Object.isFrozen(buffer.path)).toBe(true);
      expect(buffer.path.every(Object.isFrozen)).toBe(true);
      expect(Reflect.set(buffer.root, "index", 999)).toBe(false);
      expect(() => Array.prototype.push.call(buffer.path, { instructionIndex: 999, childBufferIndex: 999 })).toThrow();
      expect(Reflect.set(buffer, "instructions", [...buffer.instructions])).toBe(false);
    }
    const occurrence = census.supportOccurrences[0]!;
    expect(Reflect.set(occurrence, "bufferIndex", 999)).toBe(false);
    expect(occurrence.instruction).toBe(
      census.supportBuffers[occurrence.bufferIndex]!.instructions[occurrence.instructionIndex],
    );
    assertNativePromiseSourceCensusCurrent(census);
  });
  it("matches the actual literals owner's value-requirement absence check", () => {
    const program = requireProgram(
      prepareWholeIrProgram({
        ...sourceInput({ "./entry.ts": 'export function run(): string { return "then"; }' }),
        policy,
        nativeStringValueProjection: "standalone-native",
      }),
    );
    const projection = program.runtime[0]!,
      census = collectNativePromiseSourceCensus(program, projection, options);
    const planned = planNativeStringValuePhysical(census.demands, {
      representation: "native-string",
      utf8Storage: false,
    });
    if (planned.kind !== "planned") throw new Error(`missing literal plan: ${planned.kind}`);
    expect(planned.plan.mode).toBe("literals");
    const input = { demands: census.demands, plan: planned.plan };
    expect(
      observeNativeStringValueProducer(collectNativePromiseSourceCensus(program, projection, options), input)
        .declarations.length,
    ).toBeGreaterThan(0);
    const reserve = (candidate: NativeStringValueReservationInput) => {
      const tx = new PhysicalModuleReservations(createEmptyModule());
      const types = reserveNativeStringLiteralTypes(tx, candidate.plan.literalRequirements.key, false);
      return reserveNativeStringValueResources(tx, candidate, types);
    };
    expect(reserve(input)).toBeDefined();
    const unexpected = {
      ...input,
      valueRequirements: deriveNativeValueResourcePlan(program, projection, "native-string"),
    };
    expect(() =>
      observeNativeStringValueProducer(collectNativePromiseSourceCensus(program, projection, options), unexpected),
    ).toThrow(/unexpected native value requirements/);
    expect(() => reserve(unexpected)).toThrow(/unexpected native value requirements/);
    expect(
      observeNativeStringValueProducer(collectNativePromiseSourceCensus(program, projection, options), {
        ...input,
        valueRequirements: undefined,
      }),
    ).toBeDefined();
  });
  for (const gvn of ["off", "on"] as const)
    for (const decoded of [false, true])
      it(`complete borrowed census GVN=${gvn}, decoded=${decoded}`, () => {
        const { program, projection, census, input } = prepare(gvn, decoded);
        expect(census.required).toBe(true);
        expect(census.demands.owners).toHaveLength(16);
        expect(program.inventory.allUnits).toHaveLength(7);
        expect(program.inventory.terminalUnits).toHaveLength(5);
        expect(census.allocations).toBe(program.allocations);
        expect(census.abiEntries).toBe(program.abi.entries);
        expect(census.supportFunctions).toHaveLength(1);
        expect(census.supportBuffers).toHaveLength(31);
        expect(census.supportOccurrences).toHaveLength(157);
        expect(census.demands.buffers).toHaveLength(80);
        expect(census.demands.occurrences).toHaveLength(216);
        expect(census.paths.some((row) => row.root.kind === "abi")).toBe(true);
        expect(census.paths.some((row) => row.path.includes("asyncRuntime"))).toBe(true);
        const promise = planNativePromiseResources(program, options, projection, {
          hooks: "disabled",
          unhandledRejections: "disabled",
        });
        expect(promise.owners.flatMap((row) => row.calls)).toHaveLength(33);
        const observation = observeNativeStringValueProducer(
          collectNativePromiseSourceCensus(program, projection, options),
          input,
        );
        expect(observation.declarations).toHaveLength(24);
        expect(observation.reservationSteps).toHaveLength(27);
        expect(observation.carriers).toHaveLength(6);
        expect(observation.input).toBe(input);
        expect(observation.declarations).toBe(input.plan.declarations);
        expect(observation.reservationSteps).toBe(input.plan.reservationSteps);
        expect(observation.carriers.length).toBeGreaterThan(0);
        expect(observation.carriers.some((row) => row.declaration.shape.kind === "array")).toBe(true);
        expect(observation.carriers.some((row) => row.declaration.shape.kind === "struct")).toBe(true);
        assertNativePromiseSourceCensusCurrent(census);
        assertNativeStringValueProducerObservationCurrent(observation);
      }, 120000);
  it("collects no-demand synchronous source", () => {
    const program = requireProgram(prepareTypedIrProgram(sourcePacket().packet, typedOptions));
    expect(collectNativePromiseSourceCensus(program, program.runtime[0]!, options).required).toBe(false);
  });
  it("does not treat synchronous native stdout as Promise demand", () => {
    const program = requireProgram(
      prepareWholeIrProgram({
        ...sourceInput({ "./entry.ts": 'export function run(): void { console.log("line"); }' }),
        policy,
        nativeStringValueProjection: "standalone-native",
        nativeStringOutputProjection: "standalone-native",
      }),
    );
    const projection = program.runtime[0]!;
    expect(projection.prepared.manifest.providers.some((row) => row.feature === "async.native.console-append")).toBe(
      true,
    );
    expect(collectNativePromiseSourceCensus(program, projection, options).required).toBe(false);
  });
  it("rejects detached projection and cloned census", () => {
    const { program, projection, census } = actual();
    expect(() => collectNativePromiseSourceCensus(program, { ...projection }, options)).toThrow();
    expect(() => assertNativePromiseSourceCensusCurrent({ ...census })).toThrow(/uncollected/);
  });
  it("preserves unused allocation provenance and detects changed present-undefined metadata", () => {
    const { program, projection } = actual();
    const id = asAllocSiteId(program.allocations.size);
    const allocations = {
      size: id + 3,
      entries: [
        ...program.allocations.entries,
        { state: "live" as const, site: { id, kind: "string" as const, type: { kind: "string" as const } } },
        { state: "aliased" as const, to: id },
        { state: "retired" as const },
      ],
      metadata: [...program.allocations.metadata, { id, entries: [] }],
    };
    const changed = { ...program, allocations };
    const census = collectNativePromiseSourceCensus(changed, projection, options);
    expect(census.allocations).toBe(allocations);
    expect(census.allocations.entries.slice(-3).map((row) => row.state)).toEqual(["live", "aliased", "retired"]);
    expect(census.allocations.metadata.at(-1)!.entries).toEqual([]);
    assertNativePromiseSourceCensusCurrent(census);
    allocations.metadata[allocations.metadata.length - 1] = { id, entries: [["encoding", undefined]] };
    expect(() => assertNativePromiseSourceCensusCurrent(census)).toThrow(/stale/);
    // Rejection of unverified analysis evidence is a parent preflight test.
    const fresh = collectNativePromiseSourceCensus(changed, projection, options);
    expect(fresh.allocations.metadata.at(-1)!.entries).toEqual([["encoding", undefined]]);
  });
  it("describes omitted support and rejects omitted selected runtime-state evidence", () => {
    const { program, projection, input } = actual();
    const { runtimeSupport: _support, ...withoutSupport } = program;
    // Required-support authentication belongs to the parent preflight.
    const descriptive = collectNativePromiseSourceCensus(withoutSupport, projection, options);
    expect(descriptive.supportFunctions).toHaveLength(0);
    expect(descriptive.required).toBe(true);
    expect(input.demands.buffers.some((row) => row.root.kind === "async-runtime")).toBe(true);
    const buffers = input.demands.buffers.filter((row) => row.root.kind !== "async-runtime");
    expect(() =>
      observeNativeStringValueProducer(collectNativePromiseSourceCensus(program, projection, options), {
        ...input,
        demands: { ...input.demands, buffers },
      }),
    ).toThrow(/census/);
  });
  it("checks current options and exact producer plan association after a genuine observation", () => {
    const { program, projection, input } = actual();
    const selectedOptions = { ...options, utf8Storage: false };
    const mutable = { ...input };
    const observed = observeNativeStringValueProducer(
      collectNativePromiseSourceCensus(program, projection, selectedOptions),
      mutable,
    );
    mutable.plan = { ...input.plan };
    expect(() => assertNativeStringValueProducerObservationCurrent(observed)).toThrow(/detached/);
    mutable.plan = input.plan;
    selectedOptions.utf8Storage = true;
    expect(() => assertNativeStringValueProducerObservationCurrent(observed)).toThrow(/stale/);
  });
  for (const change of ["omit", "reverse", "duplicate", "empty", "sparse"] as const)
    it(`rejects ${change} selected owners`, () => {
      const { program, projection } = actual();
      const functions = [...projection.prepared.functions];
      if (change === "omit") functions.pop();
      if (change === "reverse") functions.reverse();
      if (change === "duplicate") functions[1] = functions[0]!;
      if (change === "empty") functions.length = 0;
      if (change === "sparse") Reflect.deleteProperty(functions, 1);
      const selected = { ...projection, prepared: { ...projection.prepared, functions } };
      expect(() => collectNativePromiseSourceCensus({ ...program, runtime: [selected] }, selected, options)).toThrow();
    });
  for (const change of ["omit", "duplicate", "role", "descriptor", "reverse", "extra"] as const)
    it(`rejects ${change} real declarations`, () => {
      const { program, projection, input } = actual();
      const declarations = [...input.plan.declarations];
      if (change === "omit") declarations.pop();
      if (change === "duplicate") declarations.push(declarations[0]!);
      if (change === "extra") declarations.push({ ...declarations[0]!, key: "unowned" });
      if (change === "role") declarations[0] = { ...declarations[0]!, role: ["callable-root"] };
      if (change === "descriptor") declarations[0] = { ...declarations[0]!, key: "changed" };
      if (change === "reverse") declarations.reverse();
      expect(() =>
        observeNativeStringValueProducer(collectNativePromiseSourceCensus(program, projection, options), {
          ...input,
          plan: { ...input.plan, declarations },
        }),
      ).toThrow(/recipe/);
    });
  it("rejects substituted buffers, occurrences, options and foreign producer observations", () => {
    const { program, projection, input } = actual();
    const buffers = [...input.demands.buffers];
    buffers[0] = { ...buffers[0]!, instructions: [...buffers[0]!.instructions] };
    expect(() =>
      observeNativeStringValueProducer(collectNativePromiseSourceCensus(program, projection, options), {
        ...input,
        demands: { ...input.demands, buffers },
      }),
    ).toThrow(/detached/);
    const occurrences = [...input.demands.occurrences];
    occurrences[0] = { ...occurrences[0]!, instruction: { ...occurrences[0]!.instruction } };
    expect(() =>
      observeNativeStringValueProducer(collectNativePromiseSourceCensus(program, projection, options), {
        ...input,
        demands: { ...input.demands, occurrences },
      }),
    ).toThrow(/detached/);
    expect(() =>
      observeNativeStringValueProducer(
        collectNativePromiseSourceCensus(program, projection, { ...options, utf8Storage: true }),
        input,
      ),
    ).toThrow(/recipe/);
    const observation = observeNativeStringValueProducer(
      collectNativePromiseSourceCensus(program, projection, options),
      input,
    );
    expect(() => assertNativeStringValueProducerObservationCurrent({ ...observation })).toThrow(/unobserved/);
  });
});

describe("detached descriptive overlap controls; no executable inventory issuance", () => {
  const evidence = { kind: "recipe", producer: 0, declaration: 0 } as const;
  const carriers: CarrierRow[] = [
    {
      key: "object",
      declaration: {
        key: "object",
        space: "type",
        role: [],
        shape: {
          kind: "struct",
          name: "object",
          fields: [{ name: "then", type: { kind: "externref" }, mutable: true }],
        },
      },
      evidence: [evidence],
    },
  ];
  const facts: PromiseLookupFacts = {
    methods: [],
    accessors: [{ carrier: "object", getterGlobalKey: "getter", evidence }],
    fields: [{ carrier: "object", fieldIndex: 0, evidence }],
    callableRoots: [],
  };
  it("retains accessor/field overlap and does not infer callable roots from shapes", () => {
    validateNativePromiseLookupFacts(carriers, facts);
    expect(nativePromiseUnshadowedFields(facts)).toEqual(facts.fields);
    expect(facts.callableRoots).toHaveLength(0);
    expect(() =>
      validateNativePromiseLookupFacts(carriers, { ...facts, fields: [...facts.fields, ...facts.fields] }),
    ).toThrow(/duplicate/);
    expect(() => validateNativePromiseLookupFacts([...carriers, ...carriers], facts)).toThrow(/ownership/);
  });
  it("method shadowing preserves underlying field accounting", () => {
    const { program } = actual();
    const callable = program.abi.entries.find((row) => row.contract.kind === "callable")!.contract;
    if (callable.kind !== "callable") throw new Error("missing real callable reference");
    const overlap = { ...facts, methods: [{ carrier: "object", target: callable.ref, evidence }] };
    validateNativePromiseLookupFacts(carriers, overlap);
    compareNativePromiseMethodCoverage(overlap, [{ carrier: "object", target: callable.ref }]);
    expect(() => compareNativePromiseMethodCoverage(overlap, [])).toThrow(/coverage/);
    expect(nativePromiseUnshadowedFields(overlap)).toHaveLength(0);
    expect(overlap.fields).toHaveLength(1);
  });
});
