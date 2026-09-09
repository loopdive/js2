// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import { captureNativeFamilyRuntimeSupport } from "./helpers/native-family-runtime-support.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";
import { deriveNativePromiseResourcePlan } from "../src/ir/program/native-promise-resources.js";
import { planNativePromiseResources } from "../src/ir/program-physical-plan.js";
import { deriveNativeVectorResourcePlan } from "../src/ir/program/native-vector-resources.js";
import { reserveNativeVectorTypes } from "../src/backend/wasmgc/resources/native-vectors.js";
import {
  reserveNativeClosureResources,
  declareNativeClosureResources,
  reserveNativeClosureResourcesPrefix,
  resumeNativeClosureResources,
  type NativeClosureRequirements,
} from "../src/backend/wasmgc/resources/native-closures.js";
import {
  reserveNativePromiseResources,
  declareNativePromiseResources,
  nativePromiseReservationInventory,
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
  const packet = captureNativeFamilyRuntimeSupport(source, policy);
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
function closureRequests(): NativeClosureRequirements["requests"] {
  return [
    { kind: "signature", id: "settle", params: [{ kind: "externref" }], results: [], allocationMode: "ordinary" },
    { kind: "metadata", id: "settle-meta", signatureId: "settle", key: "promise:settle", name: "", length: 1 },
  ];
}
function prerequisites(requests = closureRequests(), settleMetadataRequestId = "settle-meta") {
  const { plan, vectorPlan } = actual();
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const tag = tx.reserveTag(
    "tag",
    { params: [{ kind: "externref" }], results: [] },
    { kind: "defined", name: "__exn" },
  );
  const vectors = reserveNativeVectorTypes(tx, vectorPlan);
  const closureRequirements: NativeClosureRequirements = {
    key: "kernel:closures",
    startingClosureCounter: 0,
    requests,
    referenceTypes: [],
  };
  const closures = reserveNativeClosureResources(tx, closureRequirements);
  const dependencies = { vectors, exceptionTag: tag, closures, settleMetadataRequestId };
  return { module, tx, dependencies, plan, closureRequirements };
}
function reserve(requests = closureRequests(), settleMetadataRequestId = "settle-meta") {
  const input = prerequisites(requests, settleMetadataRequestId);
  const declaration = declarationFor(input);
  const pack = reserveNativePromiseResources(input.tx, input.plan, input.dependencies, declaration);
  return { ...input, pack, declaration };
}
function declarationFor(input: ReturnType<typeof prerequisites>) {
  const metadata = input.dependencies.closures.metadata.find(
    (row) => row.id === input.dependencies.settleMetadataRequestId,
  );
  if (!metadata) throw new Error("test requires genuine settlement metadata");
  return declareNativePromiseResources(input.plan, {
    argumentArrayKey: input.dependencies.vectors.layouts.find((row) => row.element === "externref")!.array.key,
    closureRootKey: input.dependencies.closures.root.key,
    settleMetadataKey: metadata.binding.type.key,
  });
}

/** Preserve undefined, sparse arrays, maps and numeric values as well as every object identity. */
function unchangedModule(module: ReturnType<typeof createEmptyModule>) {
  const snapshot = structuredClone(module);
  const checks: (() => void)[] = [];
  const seen = new Set<object>();
  function retain(value: unknown) {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const member = Reflect.get(value, key);
      checks.push(() => expect(Reflect.get(value, key)).toBe(member));
      retain(member);
    }
    if (value instanceof Map) {
      const entries = [...value];
      checks.push(() => {
        const current = [...value];
        expect(current).toHaveLength(entries.length);
        entries.forEach(([key, member], i) => {
          expect(current[i]![0]).toBe(key);
          expect(current[i]![1]).toBe(member);
        });
      });
      entries.forEach(([key, member]) => {
        retain(key);
        retain(member);
      });
    }
  }
  retain(module);
  return () => {
    expect(module).toStrictEqual(snapshot);
    checks.forEach((check) => check());
  };
}

function futureReservationProbe(tx: PhysicalModuleReservations) {
  const type = tx.reserveType("join:future-type", { kind: "struct", name: "join-future", fields: [] });
  const fn = tx.reserveFunction("join:future-function", "join-future", { params: [], results: [] });
  return { typeIndex: type.typeIndex, handle: fn.handle, functionTypeIndex: fn.object.typeIdx };
}

describe("native Promise resource requirements, not whole-family materialization", () => {
  it("rejects structural clones that lose the retained metadata field type identity", () => {
    const a = reserve();
    expect(nativePromiseReservationInventory(a.tx, a.pack, a.declaration)).toHaveLength(25);
    const capture = a.pack.types.settleCapture.object;
    if (capture.kind !== "struct") throw new Error("fixture capture struct");
    capture.fields[0]!.type = { ...capture.fields[0]!.type };
    expect(() => nativePromiseReservationInventory(a.tx, a.pack, a.declaration)).toThrow(
      "lost inherited metadata field/type identity",
    );
  });
  it("rejects stale original plan data after a genuine reservation", () => {
    const a = prerequisites(),
      mutable = structuredClone(a.plan);
    const declaration = declareNativePromiseResources(mutable, declarationFor(a).dependencies);
    const pack = reserveNativePromiseResources(a.tx, mutable, a.dependencies, declaration);
    expect(nativePromiseReservationInventory(a.tx, pack, declaration)).toHaveLength(25);
    Object.assign(mutable, { anchor: "changed" });
    expect(() => nativePromiseReservationInventory(a.tx, pack, declaration)).toThrow("stale Promise requirements");
  });
  it("declares the exact 25 resources and 26 operations before any ledger exists", () => {
    const declaration = declareNativePromiseResources(actual().plan, {
      argumentArrayKey: "external:argv",
      closureRootKey: "external:root",
      settleMetadataKey: "external:meta",
    });
    expect(declaration.declarations).toHaveLength(25);
    expect(declaration.reservationSteps).toHaveLength(26);
    expect(declaration.declarations.map((row) => row.role[1])).toEqual([
      "queue:function-array",
      "queue:head",
      "queue:tail",
      "queue:capacity",
      "queue:functions",
      "queue:captures",
      "queue:arguments",
      "queue:grow",
      "queue:enqueue",
      "queue:drain",
      "carrier",
      "callback",
      "captures",
      "fulfill",
      "reject",
      "identity-fulfill",
      "identity-reject",
      "resolve-value",
      "settle-capture",
      "resolve-closure",
      "reject-closure",
      "peel",
      "classifier",
      "lookup-then",
      "thenable-job",
    ]);
    expect(declaration.declarations.filter((row) => row.space === "type")).toHaveLength(5);
    expect(declaration.declarations.filter((row) => row.space === "global")).toHaveLength(6);
    expect(declaration.declarations.filter((row) => row.space === "function")).toHaveLength(14);
    expect(declaration.reservationSteps[1]).toMatchObject({
      kind: "intern-signature",
      key: declaration.callbackSignatureKey,
      name: "$__mt_func_type",
    });
  });
  it("reconciles explicit declarations with the live implicit path and retains metadata type identities", () => {
    const a = reserve(),
      b = prerequisites();
    reserveNativePromiseResources(b.tx, b.plan, b.dependencies);
    expect(a.module).toStrictEqual(b.module);
    const rows = nativePromiseReservationInventory(a.tx, a.pack, a.declaration);
    expect(rows.map((row) => row.key)).toEqual(a.declaration.declarations.map((row) => row.key));
    expect(rows).toHaveLength(25);
    expect(rows).not.toContain(a.pack.types.arguments);
    const capture = a.pack.types.settleCapture.object,
      meta = a.dependencies.closures.metadata[0]!.binding.type.object;
    if (capture.kind !== "struct" || meta.kind !== "struct") throw new Error("expected actual structs");
    expect(capture.fields).toHaveLength(6);
    meta.fields.forEach((field, index) => {
      expect(capture.fields[index]).not.toBe(field);
      expect(capture.fields[index]!.type).toBe(field.type);
    });
    a.tx.freezeReservations();
    expect(nativePromiseReservationInventory(a.tx, a.pack, a.declaration)).toEqual(rows);
    expect(() => nativePromiseReservationInventory(a.tx, { ...a.pack }, a.declaration)).toThrow();
    expect(() => nativePromiseReservationInventory(a.tx, a.pack, structuredClone(a.declaration))).toThrow();
    expect(() => fillNativePromiseResources(a.tx, a.pack, undefined!)).toThrow(
      "complete native dependencies are missing",
    );
  });
  it.each(["foreign", "copy"] as const)(
    "rejects %s borrowed-tag substitution without claiming reserve-phase provenance",
    (kind) => {
      const a = reserve();
      expect(nativePromiseReservationInventory(a.tx, a.pack, a.declaration)).toHaveLength(25);
      const replacement =
        kind === "foreign" ? prerequisites().dependencies.exceptionTag : { ...a.dependencies.exceptionTag };
      Object.assign(a.dependencies, { exceptionTag: replacement });
      expect(() => nativePromiseReservationInventory(a.tx, a.pack, a.declaration)).toThrow(
        "changed borrowed exception tag association",
      );
    },
  );
  it.each(["foreign", "copy"] as const)("authenticates an initially %s borrowed tag only after freeze", (kind) => {
    const positive = reserve();
    positive.tx.freezeReservations();
    expect(nativePromiseReservationInventory(positive.tx, positive.pack, positive.declaration)).toHaveLength(25);
    const a = prerequisites();
    Object.assign(a.dependencies, {
      exceptionTag: kind === "foreign" ? prerequisites().dependencies.exceptionTag : { ...a.dependencies.exceptionTag },
    });
    const declaration = declarationFor(a),
      pack = reserveNativePromiseResources(a.tx, a.plan, a.dependencies, declaration);
    // Current association is known here; tag provenance is NOT yet attested.
    expect(nativePromiseReservationInventory(a.tx, pack, declaration)).toHaveLength(25);
    a.tx.freezeReservations();
    expect(() => nativePromiseReservationInventory(a.tx, pack, declaration)).toThrow();
  });
  it.each(["type", "global", "function"] as const)("rejects a deleted %s declaration before allocating", (space) => {
    const positive = reserve();
    expect(nativePromiseReservationInventory(positive.tx, positive.pack, positive.declaration)).toHaveLength(25);
    const a = prerequisites(),
      declaration = structuredClone(declarationFor(a));
    const index = declaration.declarations.findIndex((row) => row.space === space);
    (declaration.declarations as unknown[]).splice(index, 1);
    const unchanged = unchangedModule(a.module);
    expect(() => reserveNativePromiseResources(a.tx, a.plan, a.dependencies, declaration)).toThrow(
      "substituted Promise declaration plan",
    );
    unchanged();
  });
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
  it("admits genuine settle prefix only for reserve/inventory and demands complete closures at fill", () => {
    const absent = undefined as unknown as NativePromiseFillDependencies;
    const control = reserve();
    expect(nativePromiseReservationInventory(control.tx, control.pack, control.declaration)).toHaveLength(
      control.declaration.declarations.length,
    );
    expect(() => fillNativePromiseResources(control.tx, control.pack, absent)).toThrow(
      "complete native dependencies are missing",
    );
    for (const freezeEarly of [false, true]) {
      const { plan, vectorPlan } = actual(),
        module = createEmptyModule(),
        tx = new PhysicalModuleReservations(module);
      const exceptionTag = tx.reserveTag(
        "tag",
        { params: [{ kind: "externref" }], results: [] },
        { kind: "defined", name: "__exn" },
      );
      const vectors = reserveNativeVectorTypes(tx, vectorPlan);
      const requests = [
        { kind: "signature", id: "settle", params: [{ kind: "externref" }], results: [], allocationMode: "ordinary" },
        { kind: "metadata", id: "settle-meta", signatureId: "settle", key: "promise:settle", name: "", length: 1 },
        { kind: "signature", id: "delay", params: [], results: [], allocationMode: "host-one-shot" },
      ] as const;
      const closurePlan = declareNativeClosureResources({
        key: "staged",
        startingClosureCounter: 0,
        requests,
        referenceTypeKeys: [],
      });
      const closures = reserveNativeClosureResourcesPrefix(
        tx,
        { key: "staged", startingClosureCounter: 0, requests, referenceTypes: [] },
        closurePlan,
        2,
      );
      const metadata = closures.metadata[0]!.binding;
      const declaration = declareNativePromiseResources(plan, {
        argumentArrayKey: vectors.layouts.find((row) => row.element === "externref")!.array.key,
        closureRootKey: closures.root.key,
        settleMetadataKey: metadata.type.key,
      });
      const pack = reserveNativePromiseResources(
        tx,
        plan,
        { vectors, exceptionTag, closures, settleMetadataRequestId: "settle-meta" },
        declaration,
      );
      expect(nativePromiseReservationInventory(tx, pack, declaration)).toHaveLength(declaration.declarations.length);
      if (freezeEarly) tx.freezeReservations();
      expect(() => fillNativePromiseResources(tx, pack, absent)).toThrow(
        freezeEarly ? "unfinished closure pack" : "incomplete closure reservation population",
      );
      if (!freezeEarly) {
        resumeNativeClosureResources(tx, closures, 3);
        expect(closures.metadata[0]!.binding).toBe(metadata);
        expect(nativePromiseReservationInventory(tx, pack, declaration)).toHaveLength(declaration.declarations.length);
        expect(() => fillNativePromiseResources(tx, pack, absent)).toThrow("complete native dependencies are missing");
      }
    }
  });
  it("joins genuine metadata while preserving an alternate first-signature root", () => {
    const a = reserve();
    expect(a.dependencies.closures.root).toBe(a.dependencies.closures.signatures[0]!.binding.type);
    const b = reserve([
      {
        kind: "signature",
        id: "numeric",
        params: [{ kind: "f64" }],
        results: [{ kind: "f64" }],
        allocationMode: "ordinary",
      },
      ...closureRequests(),
    ]);
    const { closures } = b.dependencies;
    const producer = closures.metadata[0]!.binding.type.object;
    const capture = b.pack.types.settleCapture.object;
    if (producer.kind !== "struct" || capture.kind !== "struct") throw new Error("expected genuine struct types");
    expect(producer.fields).toHaveLength(5);
    expect(capture.fields.slice(0, 5)).toStrictEqual(producer.fields);
    producer.fields.forEach((field, index) => {
      expect(capture.fields[index]).not.toBe(field);
      expect(capture.fields[index]!.type).toBe(field.type);
    });
    expect(closures.root).toBe(closures.signatures[0]!.binding.type);
    expect(closures.metadata[0]!.binding.signature.type).not.toBe(closures.root);
    expect(b.pack.types.settleCapture.object).toMatchObject({
      superTypeIdx: closures.metadata[0]!.binding.type.typeIndex,
      fields: [
        ...(closures.metadata[0]!.binding.type.object as { fields: unknown[] }).fields,
        { name: "cap_promise", type: { kind: "ref", typeIdx: b.pack.types.promise.typeIndex }, mutable: false },
      ],
    });
    expect(b.module.types[b.pack.functions.resolveClosure.object.typeIdx]).toMatchObject({
      params: [{ kind: "ref", typeIdx: closures.root.typeIndex }, { kind: "externref" }],
      results: [],
    });
  });
  it("accepts repeated metadata requests selecting the same cached binding and copies the request ID", () => {
    const a = reserve();
    expect(a.dependencies.closures.metadata).toHaveLength(1);
    const b = reserve(
      [
        ...closureRequests(),
        { kind: "metadata", id: "again", signatureId: "settle", key: "promise:settle", name: "", length: 1 },
      ],
      "again",
    );
    const rows = b.dependencies.closures.metadata;
    expect(rows[0]!.binding).toBe(rows[1]!.binding);
    b.dependencies.settleMetadataRequestId = "not-the-retained-id";
    b.tx.freezeReservations();
    expect(() => fillNativePromiseResources(b.tx, b.pack, undefined!)).toThrow(
      "complete native dependencies are missing",
    );
  });
  it("accepts undefined and lowered lazy arity without equating metadata snapshots", () => {
    const a = reserve();
    expect(a.dependencies.closures.metadata[0]!.binding.info.minimumArgumentCount).toBeUndefined();
    const requests = closureRequests().map((request) =>
      request.kind === "signature" ? { ...request, minimumArgumentCount: 1 } : request,
    );
    const b = reserve([
      ...requests,
      {
        kind: "signature",
        id: "later",
        params: [{ kind: "externref" }],
        results: [],
        allocationMode: "ordinary",
        minimumArgumentCount: 0,
      },
    ]);
    expect(b.dependencies.closures.signatures[0]!.binding.info.minimumArgumentCount).toBe(0);
    expect(b.dependencies.closures.metadata[0]!.binding.info.minimumArgumentCount).toBe(1);
  });
  for (const mutation of ["copied", "foreign", "stale", "missing-request", "wrong-request"] as const)
    it(`rejects ${mutation} closure selection before allocating any Promise resources`, () => {
      const positive = reserve();
      expect(Object.keys(positive.pack.functions)).toHaveLength(14);
      const requests: NativeClosureRequirements["requests"] = [
        ...closureRequests(),
        { kind: "metadata", id: "other", signatureId: "settle", key: "other", name: "other", length: 1 },
      ];
      const input = prerequisites(requests);
      const control = prerequisites(structuredClone(requests));
      const { tx, module, dependencies, plan, closureRequirements } = input;
      if (mutation === "copied") dependencies.closures = { ...dependencies.closures };
      if (mutation === "foreign") dependencies.closures = prerequisites().dependencies.closures;
      if (mutation === "stale") (closureRequirements as { startingClosureCounter: number }).startingClosureCounter++;
      if (mutation === "missing-request") dependencies.settleMetadataRequestId = "absent";
      if (mutation === "wrong-request") dependencies.settleMetadataRequestId = "other";
      const assertUnchanged = unchangedModule(module);
      const error =
        mutation === "copied" || mutation === "foreign"
          ? "foreign or copied closure pack"
          : mutation === "stale"
            ? "stale closure request sequence"
            : mutation === "missing-request"
              ? "missing or future closure request"
              : "invalid settle metadata";
      expect(() => reserveNativePromiseResources(tx, plan, dependencies)).toThrow(error);
      assertUnchanged();
      expect(tx.state).toBe("reserving");
      // A pristine twin exposes consumed allocator ordinals even if an implementation
      // restored the visible arrays before rejecting the bad dependency.
      expect(futureReservationProbe(tx)).toStrictEqual(futureReservationProbe(control.tx));
      expect(module.funcOrdinalToPosition).toStrictEqual(control.module.funcOrdinalToPosition);
    });
  it("reauthenticates the retained producer before the genuine missing-dependency fill frontier", () => {
    const input = reserve();
    input.tx.freezeReservations();
    expect(() => fillNativePromiseResources(input.tx, input.pack, undefined!)).toThrow(
      "complete native dependencies are missing",
    );
    const assertUnchanged = unchangedModule(input.module);
    (input.closureRequirements as { startingClosureCounter: number }).startingClosureCounter++;
    expect(() => fillNativePromiseResources(input.tx, input.pack, undefined!)).toThrow(
      "stale closure request sequence",
    );
    assertUnchanged();
    expect(input.tx.state).toBe("filling");
  });
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
    expect(module.functions.map((fn) => fn.name)).toEqual([
      "__microtask_grow",
      "__microtask_enqueue",
      "__drain_microtasks",
      "__promise_fulfill",
      "__promise_reject",
      "__then_identity_fulfill",
      "__then_identity_reject",
      "__promise_resolve_value",
      "__promise_resolve_cl",
      "__promise_reject_cl",
      "__promise_peel_value",
      "__promise_has_callable_then",
      "__promise_lookup_then",
      "__promise_thenable_job",
    ]);
    expect(new Set(Object.values(pack.functions).map((fn) => fn.object)).size).toBe(14);
    expect(pack.functions.lookupThen.object).toMatchObject({
      name: "__promise_lookup_then",
      body: [],
    });
    expect(module.types[pack.functions.lookupThen.object.typeIdx]).toMatchObject({
      kind: "func",
      params: [{ kind: "externref" }],
      results: [{ kind: "i32" }, { kind: "externref" }],
    });
    expect(pack.functions.classifier.object).toMatchObject({
      name: "__promise_has_callable_then",
      body: [],
    });
    expect(module.types[pack.functions.classifier.object.typeIdx]).toMatchObject({
      kind: "func",
      params: [{ kind: "externref" }],
      results: [{ kind: "i32" }],
    });
    expect(pack.functions.lookupThen.object).not.toBe(pack.functions.classifier.object);
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
