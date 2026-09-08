// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";
import { deriveNativePromiseResourcePlan } from "../src/ir/program/native-promise-resources.js";
import { planNativePromiseResources } from "../src/ir/program-physical-plan.js";
import { deriveNativeVectorResourcePlan } from "../src/ir/program/native-vector-resources.js";
import { reserveNativeVectorTypes } from "../src/backend/wasmgc/resources/native-vectors.js";
import {
  reserveNativePromiseResources,
  fillNativePromiseResources,
  type NativePromiseFillDependencies,
} from "../src/backend/wasmgc/resources/native-promises.js";

const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
const configuration = { hooks: "disabled", unhandledRejections: "disabled" } as const;
const backendOptions = {
  backend: "wasmgc",
  target: "standalone",
  sharedExceptionTag: false,
  utf8Storage: false,
  sourceMap: false,
  moduleName: "native-promise-resources",
} as const;
function prepare(gvnMode: "off" | "on" = "off", replay = false) {
  const text = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
  const source = prepareIrProgramSources({
    ...sourceInput({ "./entry.ts": text }),
    policy,
    promiseDelayProjection: "standalone-native",
    asyncFamilyProjection: "standalone-native",
  });
  if (source.kind !== "prepared") throw new Error(source.detail);
  const packet = captureTypedIrProgramInput(source);
  const input = replay ? decodeTypedPacket(encodeTypedPacket(packet)) : packet;
  const program = requireProgram(
    prepareTypedIrProgram(input, {
      ...typedOptions,
      policy,
      runtimePolicies: [policy],
      controls: { ...typedOptions.controls, gvnMode },
    }),
  );
  const requirements = {
    anchor: program.inventory.sources.find((row) => row.kind === "entry")!.id,
    functions: program.ir.functions,
    selectedFunctions: program.runtime[0]!.prepared.functions,
    derivedUnits: program.derivedUnits,
    abiEntries: program.abi.entries,
    policy,
    providers: program.runtime[0]!.prepared.manifest.providers,
    backend: policy.backend,
    target: policy.target,
  };
  return {
    program,
    requirements,
    plan: planNativePromiseResources(program, backendOptions, program.runtime[0]!, configuration),
    vectorPlan: deriveNativeVectorResourcePlan(requirements),
  };
}
let cached: ReturnType<typeof prepare> | undefined;
const actual = () => (cached ??= prepare());

/** Type-only kernel harness. No fabricated native value/classifier/function dependency. */
function reserve() {
  const { plan, vectorPlan } = actual();
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const tag = tx.reserveTag(
    "tag",
    { params: [{ kind: "externref" }], results: [] },
    { kind: "defined", name: "__exn" },
  );
  const vectors = reserveNativeVectorTypes(tx, vectorPlan);
  const fields = [
    { name: "func", type: { kind: "funcref" } as const, mutable: false },
    { name: "$arity", type: { kind: "i32" } as const, mutable: false },
    { name: "$bag", type: { kind: "externref" } as const, mutable: true },
  ];
  const closureRoot = tx.reserveType("kernel:closure-root", {
    kind: "struct",
    name: "kernel-root",
    superTypeIdx: -1,
    fields,
  });
  const settleMetadata = tx.reserveType("kernel:metadata", {
    kind: "struct",
    name: "kernel-metadata",
    superTypeIdx: closureRoot.typeIndex,
    fields: [
      ...fields,
      { name: "bfnstate", type: { kind: "i32" }, mutable: true },
      { name: "bfnid", type: { kind: "i32" }, mutable: false },
    ],
  });
  const dependencies = { vectors, exceptionTag: tag, closureRoot, settleMetadata };
  const pack = reserveNativePromiseResources(tx, plan, dependencies);
  return { module, tx, pack, dependencies, plan };
}

describe("native Promise resource requirements, not whole-family materialization", () => {
  it("rejects an unsealed program after accepting the genuine complete program", () => {
    const { program, plan } = actual();
    const projection = program.runtime[0]!;
    expect(planNativePromiseResources(program, backendOptions, projection, configuration)).toEqual(plan);
    const unsealed = { ...program, sealed: false } as unknown as typeof program;
    expect(() => planNativePromiseResources(unsealed, backendOptions, projection, configuration)).toThrow(
      "program is not a complete prepared program",
    );
  });
  it("rejects a detached projection after accepting its owning program", () => {
    const { program, plan } = actual();
    const projection = program.runtime[0]!;
    expect(planNativePromiseResources(program, backendOptions, projection, configuration)).toEqual(plan);
    expect(() => planNativePromiseResources(program, backendOptions, { ...projection }, configuration)).toThrow(
      "selected projection does not belong",
    );
  });
  it("rejects a mismatched backend after an accepted positive", () => {
    const { program, plan } = actual();
    const projection = program.runtime[0]!;
    expect(planNativePromiseResources(program, backendOptions, projection, configuration)).toEqual(plan);
    expect(() =>
      planNativePromiseResources(program, { ...backendOptions, backend: "linear" }, projection, configuration),
    ).toThrow("selected projection does not belong");
  });
  for (const mode of ["off", "on"] as const)
    for (const replay of [false, true])
      it(`retains all 16 owners and 33 calls, GVN=${mode}, decoded=${replay}`, () => {
        const { plan, program } = prepare(mode, replay);
        expect(plan.owners).toHaveLength(16);
        expect(plan.owners.flatMap((owner) => owner.calls)).toHaveLength(33);
        expect(plan.owners.map((owner) => owner.unitId)).toEqual(program.ir.functions.map((fn) => fn.unitId));
        expect(plan.dependencies).toContain("finalized-object-closure-inventory");
        expect(plan.dependencies).toContain("canonical-tag-1-undefined");
        expect(plan.dependencies).toContain("type-error-constructor");
        expect(plan.configuration).toEqual(configuration);
        for (const feature of [
          "promise.capability.create",
          "promise.react",
          "value.undefined",
          "promise.number.bridge",
        ])
          expect(plan.providers.some((provider) => provider.feature === feature)).toBe(true);
        expect(plan.selectedOwners.map((owner) => owner.unitId)).toEqual(plan.owners.map((owner) => owner.unitId));
        expect(plan.derivedUnits).toEqual(program.derivedUnits);
        expect(Object.isFrozen(plan)).toBe(true);
        expect(program.allocations.size).toBeGreaterThan(0);
      });
  it("rejects missing explicit configuration", () => {
    const { requirements } = actual();
    expect(() => deriveNativePromiseResourcePlan({ ...requirements, configuration: undefined! })).toThrow(
      "explicit runtime configuration",
    );
  });
  it("accepts the recreated selected plan but rejects a detached attachment plan", () => {
    const { requirements, plan } = actual();
    expect(deriveNativePromiseResourcePlan({ ...requirements, configuration })).toEqual(plan);
    const index = requirements.functions.findIndex((fn) => fn.asyncPlan !== undefined);
    expect(index).toBeGreaterThanOrEqual(0);
    const semantic = requirements.functions[index]!,
      selected = requirements.selectedFunctions[index]!;
    expect(selected.asyncPlan).not.toBe(semantic.asyncPlan);
    expect(selected.asyncPlan).toEqual(semantic.asyncPlan);
    expect(selected.asyncRuntime!.plan).toBe(selected.asyncPlan);
    const selectedFunctions = requirements.selectedFunctions.map((fn, i) =>
      i === index ? { ...fn, asyncRuntime: { ...fn.asyncRuntime!, plan: semantic.asyncPlan! } } : fn,
    );
    expect(() => deriveNativePromiseResourcePlan({ ...requirements, selectedFunctions, configuration })).toThrow(
      "does not retain its exact semantic plan owner",
    );
  });
  for (const mutation of [
    "wrong-semantic-plan",
    "missing-selected-plan",
    "foreign-attachment",
    "attachment-without-owner",
  ] as const)
    it(`rejects ${mutation} after genuine selected-attachment positive`, () => {
      const { requirements, plan } = actual();
      expect(deriveNativePromiseResourcePlan({ ...requirements, configuration })).toEqual(plan);
      const index = requirements.functions.findIndex((fn) => fn.asyncPlan !== undefined);
      const other = requirements.selectedFunctions.find((fn, i) => i !== index && fn.asyncRuntime !== undefined)!;
      expect(index).toBeGreaterThanOrEqual(0);
      expect(other.asyncRuntime).toBeDefined();
      const functions = requirements.functions.map((fn, i) => {
        if (i !== index) return fn;
        const semanticPlan = fn.asyncPlan!;
        if (mutation === "wrong-semantic-plan")
          return { ...fn, asyncPlan: { ...semanticPlan, entry: 999 as typeof semanticPlan.entry } };
        if (mutation === "attachment-without-owner") return { ...fn, asyncPlan: undefined };
        return fn;
      });
      const selectedFunctions = requirements.selectedFunctions.map((fn, i) => {
        if (i !== index) return fn;
        if (mutation === "missing-selected-plan") return { ...fn, asyncPlan: undefined };
        if (mutation === "foreign-attachment") return { ...fn, asyncRuntime: other.asyncRuntime };
        return fn;
      });
      const error =
        mutation === "foreign-attachment"
          ? "does not retain its exact semantic plan owner"
          : mutation === "attachment-without-owner"
            ? "selected async attachment has no semantic owner"
            : "selected semantic async plan differs";
      expect(() =>
        deriveNativePromiseResourcePlan({ ...requirements, functions, selectedFunctions, configuration }),
      ).toThrow(error);
    });
  for (const mutation of ["missing", "duplicate", "foreign"] as const)
    it(`rejects ${mutation} native resolve provider after positive control`, () => {
      const { requirements, plan } = actual();
      expect(deriveNativePromiseResourcePlan({ ...requirements, configuration })).toEqual(plan);
      const row = requirements.providers.find((provider) => provider.feature === "promise.resolve")!;
      const others = requirements.providers.filter((provider) => provider !== row);
      const providers =
        mutation === "missing"
          ? others
          : mutation === "duplicate"
            ? [...requirements.providers, row]
            : [...others, { ...row, id: "foreign.resolve" }];
      expect(() => deriveNativePromiseResourcePlan({ ...requirements, providers, configuration })).toThrow(
        "noncanonical promise.resolve provider",
      );
    });
});

describe("reservation-only Promise pack controls; missing native dependencies remain a gap", () => {
  it("reuses the exact vector array and preserves queue order and lazy storage obligations", () => {
    const { module, pack, dependencies, tx } = reserve();
    expect(pack.types.arguments).toBe(dependencies.vectors.layouts.find((row) => row.element === "externref")!.array);
    expect(module.types.filter((type) => type.kind === "array" && type.name === "__arr_externref")).toHaveLength(1);
    expect(module.globals.map((global) => global.name)).toEqual([
      "__mt_head",
      "__mt_tail",
      "__mt_cap",
      "__mt_funcs",
      "__mt_caps",
      "__mt_args",
    ]);
    expect(module.functions.slice(0, 8).map((fn) => fn.name)).toEqual([
      "__microtask_grow",
      "__microtask_enqueue",
      "__drain_microtasks",
      "__promise_fulfill",
      "__promise_reject",
      "__then_identity_fulfill",
      "__then_identity_reject",
      "__promise_resolve_value",
    ]);
    expect(new Set(Object.values(pack.functions).map((fn) => fn.object)).size).toBe(13);
    expect(tx.state).toBe("reserving");
    tx.freezeReservations();
    expect(() => tx.seal()).toThrow("missing global fill");
  });
  it("preserves Promise, callback and continuation field order/mutability", () => {
    const { pack } = reserve();
    expect(pack.types.promise.object).toMatchObject({
      fields: [
        { name: "state", mutable: true },
        { name: "value", mutable: true },
        { name: "callbacks", mutable: true },
        { name: "$bag", mutable: true },
      ],
    });
    expect(pack.types.callback.object).toMatchObject({
      fields: [
        { name: "onFulfilledFn", mutable: false },
        { name: "onFulfilledCaps", mutable: false },
        { name: "onRejectedFn", mutable: false },
        { name: "onRejectedCaps", mutable: false },
        { name: "next", mutable: false },
      ],
    });
    expect(pack.types.captures.object).toMatchObject({
      fields: [
        { name: "callback", mutable: false },
        { name: "chained", mutable: false },
      ],
    });
    expect(pack.types.settleCapture.object).toMatchObject({
      fields: [
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        { name: "cap_promise", mutable: false },
      ],
    });
  });
  it("does not complete missing resolution/value/classifier bindings", () => {
    const { tx, pack, module } = reserve();
    tx.freezeReservations();
    expect(() => fillNativePromiseResources(tx, pack, undefined!)).toThrow("complete native dependencies are missing");
    expect(module.functions.every((fn) => fn.body.length === 0)).toBe(true);
    expect(() => tx.seal()).toThrow("missing global fill");
  });
  it("rejects wrapper substitution and another ledger", () => {
    const a = reserve(),
      b = reserve();
    expect(() => fillNativePromiseResources(a.tx, { ...a.pack }, undefined!)).toThrow("foreign Promise pack");
    expect(() => fillNativePromiseResources(b.tx, a.pack, undefined!)).toThrow("foreign Promise pack");
  });
  it("rejects changed complete-owner census before using builder flags", () => {
    const { tx, pack } = reserve();
    const missing = {
      inventory: { owners: [] },
      values: {},
      resolution: {},
    } as unknown as NativePromiseFillDependencies;
    expect(() => fillNativePromiseResources(tx, pack, missing)).toThrow("classification owner population differs");
  });
  it("rejects empty/null classifier flags as materialization evidence", () => {
    const { tx, pack, plan } = reserve();
    const absent = {
      inventory: {
        owners: plan.owners,
        selectedOwners: plan.selectedOwners,
        derivedUnits: plan.derivedUnits,
        finalized: true,
        carriers: [],
        anyValue: null,
        openObject: null,
      },
      values: {},
      resolution: {},
    } as unknown as NativePromiseFillDependencies;
    expect(() => fillNativePromiseResources(tx, pack, absent)).toThrow(
      "complete native classification materialization is missing",
    );
  });
  it("rejects duplicate pack reservation", () => {
    const { tx, plan, dependencies } = reserve();
    expect(() => reserveNativePromiseResources(tx, plan, dependencies)).toThrow("duplicate resource key");
  });
  it("rejects late reservation", () => {
    const { tx, plan, dependencies } = reserve();
    tx.freezeReservations();
    expect(() => reserveNativePromiseResources(tx, plan, dependencies)).toThrow("requires reserving");
  });
});
