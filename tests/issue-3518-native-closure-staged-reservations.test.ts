// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import type { ValType } from "../src/wasm/model/instructions.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  declareNativeClosureResources,
  reserveNativeClosureResources,
  reserveNativeClosureResourcesPrefix,
  resumeNativeClosureResources,
  requireNativeClosureReservationPrefix,
  requireNativeClosureReservations,
  nativeClosureReservationInventory,
  nativeClosureReservationStepEnd,
  type NativeClosureRequirements,
} from "../src/backend/wasmgc/resources/native-closures.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { captureNativeFamilyRuntimeSupport } from "./helpers/native-family-runtime-support.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";
import { planNativePromiseResources } from "../src/ir/program-physical-plan.js";
import { deriveNativeVectorResourcePlan } from "../src/ir/program/native-vector-resources.js";
import { reserveNativeVectorTypes } from "../src/backend/wasmgc/resources/native-vectors.js";
import {
  declareNativePromiseResources,
  reserveNativePromiseResources,
  nativePromiseReservationInventory,
} from "../src/backend/wasmgc/resources/native-promises.js";
import { instantiateNativeDeclaredSignature } from "../src/backend/wasmgc/resources/native-resource-declarations.js";
import type { NativeResourceRecipe } from "../src/runtime/wasmgc/values/native-resource-declaration-types.js";

function requests(cachedDelay = false): NativeClosureRequirements {
  return {
    key: "staged:closures",
    startingClosureCounter: 4,
    referenceTypes: [],
    requests: [
      ...(cachedDelay
        ? [
            {
              kind: "signature" as const,
              id: "earlier-zero",
              params: [],
              results: [],
              allocationMode: "support" as const,
            },
          ]
        : []),
      { kind: "signature", id: "settle", params: [{ kind: "externref" }], results: [], allocationMode: "ordinary" },
      { kind: "metadata", id: "settle-meta", signatureId: "settle", key: "promise:settle", name: "", length: 1 },
      { kind: "signature", id: "delay", params: [], results: [], allocationMode: "host-one-shot" },
    ],
  };
}
function declaration(input: NativeClosureRequirements) {
  // This fixture's complete population has only scalar parameters, never physical references.
  const scalar = (type: ValType) => {
    if (type.kind === "ref" || type.kind === "ref_null") throw new Error("fixture scalar required");
    return type;
  };
  return declareNativeClosureResources({
    key: input.key,
    startingClosureCounter: input.startingClosureCounter,
    requests: input.requests.map((request) =>
      request.kind === "metadata"
        ? request
        : { ...request, params: request.params.map(scalar), results: request.results.map(scalar) },
    ),
    referenceTypeKeys: [],
  });
}
function prefix(input = requests(), cut = input.requests.length - 1) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module),
    plan = declaration(input);
  const pack = reserveNativeClosureResourcesPrefix(tx, input, plan, cut);
  return { module, tx, input, plan, pack };
}
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
  moduleName: "staged-closure",
} as const;
function prepare(replay: boolean) {
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
    prepareTypedIrProgram(replay ? decodeTypedPacket(encodeTypedPacket(packet)) : packet, {
      ...typedOptions,
      policy,
      runtimePolicies: [policy],
    }),
  );
  const projection = program.runtime[0]!;
  const vectorPlan = deriveNativeVectorResourcePlan({
    anchor: program.inventory.sources.find((row) => row.kind === "entry")!.id,
    functions: program.ir.functions,
    abiEntries: program.abi.entries,
    policy,
    providers: projection.prepared.manifest.providers,
    backend: policy.backend,
    target: policy.target,
  });
  const promisePlan = planNativePromiseResources(program, options, projection, {
    hooks: "disabled",
    unhandledRejections: "disabled",
  });
  return { vectorPlan, promisePlan };
}
const prepared = new Map<boolean, ReturnType<typeof prepare>>();
function actual(replay: boolean) {
  let value = prepared.get(replay);
  if (!value) {
    value = prepare(replay);
    prepared.set(replay, value);
  }
  return value;
}

describe("one issued closure owner across genuine Promise reservations", () => {
  it.each([false, true])(
    "retains actual source/decoded=%s Promise interleaving for fresh and cached delay requests",
    (replay) => {
      const { vectorPlan, promisePlan } = actual(replay);
      for (const cached of [false, true])
        for (const timing of ["before-metadata", "after-metadata", "unrelated-first"] as const) {
          const module = createEmptyModule(),
            tx = new PhysicalModuleReservations(module);
          const exceptionTag = tx.reserveTag(
            "tag",
            { params: [{ kind: "externref" }], results: [] },
            { kind: "defined", name: "__exn" },
          );
          const vectors = reserveNativeVectorTypes(tx, vectorPlan);
          // Call-through spies observe the real ledger, including its implicit
          // unnamed function-signature interning. No reservation is substituted.
          const typeCalls = vi.spyOn(tx, "reserveType"),
            globalCalls = vi.spyOn(tx, "reserveGlobal"),
            functionCalls = vi.spyOn(tx, "reserveFunction"),
            internCalls = vi.spyOn(tx, "internFunctionType");
          const baseInput = requests(cached);
          const population = baseInput.requests.map((request) =>
            request.id === "settle" && timing === "before-metadata" ? { ...request, minimumArgumentCount: 1 } : request,
          );
          const input: NativeClosureRequirements = {
              ...baseInput,
              requests: [
                ...(timing === "unrelated-first"
                  ? [
                      {
                        kind: "signature" as const,
                        id: "unrelated",
                        params: [{ kind: "f64" as const }],
                        results: [],
                        allocationMode: "support" as const,
                        minimumArgumentCount: 1,
                      },
                    ]
                  : []),
                ...population.slice(0, -1),
                {
                  kind: "signature",
                  id: "observe-settle",
                  params: [{ kind: "externref" }],
                  results: [],
                  allocationMode: "ordinary",
                  minimumArgumentCount: 0,
                },
                population.at(-1)!,
              ],
            },
            plan = declaration(input),
            cut = input.requests.length - 2;
          const closures = reserveNativeClosureResourcesPrefix(tx, input, plan, cut);
          const root = closures.root,
            rows = closures.signatures,
            metadataRows = closures.metadata,
            registrations = closures.registrations;
          const metadata = closures.metadata[0]!.binding,
            info = metadata.info,
            signature = metadata.signature;
          expect(requireNativeClosureReservationPrefix(tx, closures, "settle-meta")).toBe(closures);
          expect(() => requireNativeClosureReservations(tx, closures)).toThrow(
            "incomplete closure reservation population",
          );
          const promiseDeclarations = declareNativePromiseResources(promisePlan, {
            argumentArrayKey: vectors.layouts.find((row) => row.element === "externref")!.array.key,
            closureRootKey: root.key,
            settleMetadataKey: metadata.type.key,
          });
          const promises = reserveNativePromiseResources(
            tx,
            promisePlan,
            { vectors, exceptionTag, closures, settleMetadataRequestId: "settle-meta" },
            promiseDeclarations,
          );
          expect(nativePromiseReservationInventory(tx, promises, promiseDeclarations).map((row) => row.key)).toEqual(
            promiseDeclarations.declarations.map((row) => row.key),
          );
          const beforeSuffix = module.types.length;
          expect(resumeNativeClosureResources(tx, closures, input.requests.length)).toBe(closures);
          expect(closures.root).toBe(root);
          expect(closures.signatures).toBe(rows);
          expect(closures.metadata).toBe(metadataRows);
          expect(closures.registrations).toBe(registrations);
          expect(closures.metadata[0]!.binding).toBe(metadata);
          expect(metadata.info).toBe(info);
          expect(metadata.signature).toBe(signature);
          const delay = closures.signatures.at(-1)!.binding;
          expect(delay.liftedSelfTypeIndex).toBe(root.typeIndex);
          if (cached) {
            expect(delay).toBe(closures.signatures.find((row) => row.id === "earlier-zero")!.binding);
            expect(module.types).toHaveLength(beforeSuffix);
          } else expect(delay.type.typeIndex).toBe(beforeSuffix);
          expect(delay.info.hostOneShotOnly).toBe(true);
          expect(info.minimumArgumentCount).toBe(
            timing === "before-metadata" ? 1 : timing === "after-metadata" ? 0 : undefined,
          );
          expect(signature.info.minimumArgumentCount).toBe(0);
          const otherOperations = timing === "unrelated-first" ? 2 : 0;
          expect(nativeClosureReservationStepEnd(plan, cut)).toBe((cached ? 5 : 3) + otherOperations);
          expect(nativeClosureReservationStepEnd(plan, input.requests.length)).toBe(5 + otherOperations);
          expect(nativeClosureReservationInventory(tx, closures, plan).map((row) => row.key)).toEqual(
            plan.declarations.map((row) => row.key),
          );
          expect(nativePromiseReservationInventory(tx, promises, promiseDeclarations)).toHaveLength(
            promiseDeclarations.declarations.length,
          );
          const tokenRows = [
            ...nativeClosureReservationInventory(tx, closures, plan),
            ...nativePromiseReservationInventory(tx, promises, promiseDeclarations),
          ];
          const tokens = new Map(tokenRows.flatMap((row) => (row.kind === "type" ? [[row.key, row] as const] : [])));
          for (const layout of vectors.layouts) tokens.set(layout.array.key, layout.array);
          const expectedSteps = (
            recipe: NativeResourceRecipe,
            from = 0,
            end = recipe.reservationSteps.length,
          ): unknown[][] =>
            recipe.reservationSteps.slice(from, end).flatMap((step): unknown[][] => {
              if (step.kind === "intern-signature") {
                const signature = instantiateNativeDeclaredSignature(tx, step.signature, tokens);
                return [["intern", signature.params, signature.results, step.name]];
              }
              const row = recipe.declarations.find((entry) => entry.key === step.resourceKey)!;
              if (row.space !== "function") return [[row.space, row.key]];
              const signature = instantiateNativeDeclaredSignature(tx, row.signature, tokens);
              return [
                ["function", row.key],
                ["intern", signature.params, signature.results],
              ];
            });
          const trace = [
            ...typeCalls.mock.calls.map((args, index) => ({
              order: typeCalls.mock.invocationCallOrder[index]!,
              value: ["type", args[0]],
            })),
            ...globalCalls.mock.calls.map((args, index) => ({
              order: globalCalls.mock.invocationCallOrder[index]!,
              value: ["global", args[0]],
            })),
            ...functionCalls.mock.calls.map((args, index) => ({
              order: functionCalls.mock.invocationCallOrder[index]!,
              value: ["function", args[0]],
            })),
            ...internCalls.mock.calls.map((args, index) => ({
              order: internCalls.mock.invocationCallOrder[index]!,
              value: ["intern", ...args],
            })),
          ]
            .sort((a, b) => a.order - b.order)
            .map((row) => row.value);
          const offset = nativeClosureReservationStepEnd(plan, cut);
          expect(trace).toStrictEqual([
            ...expectedSteps(plan, 0, offset),
            ...expectedSteps(promiseDeclarations),
            ...expectedSteps(plan, offset),
          ]);
          typeCalls.mockRestore();
          globalCalls.mockRestore();
          functionCalls.mockRestore();
          internCalls.mockRestore();
          if (promises.types.settleCapture.object.kind !== "struct" || metadata.type.object.kind !== "struct")
            throw new Error("genuine metadata/capture structs required");
          metadata.type.object.fields.forEach((field, index) => {
            expect(
              promises.types.settleCapture.object.kind === "struct" &&
                promises.types.settleCapture.object.fields[index]!.type,
            ).toBe(field.type);
          });
          for (const value of [
            closures,
            rows,
            metadataRows,
            registrations,
            metadata,
            signature,
            info,
            delay,
            delay.info,
          ])
            expect(Object.isFrozen(value)).toBe(true);
        }
    },
  );
  it("retains lazy minimum observation identities across the pause", () => {
    const base = requests();
    const input: NativeClosureRequirements = {
      ...base,
      requests: [
        ...base.requests.slice(0, 2),
        {
          kind: "signature",
          id: "observe",
          params: [{ kind: "externref" }],
          results: [],
          allocationMode: "ordinary",
          minimumArgumentCount: 0,
        },
      ],
    };
    const a = prefix(input, 2),
      info = a.pack.signatures[0]!.binding.info,
      meta = a.pack.metadata[0]!.binding.info;
    expect(info.minimumArgumentCount).toBeUndefined();
    expect(meta.minimumArgumentCount).toBeUndefined();
    expect(Object.isFrozen(info)).toBe(false);
    resumeNativeClosureResources(a.tx, a.pack, 3);
    expect(a.pack.signatures[0]!.binding.info).toBe(info);
    expect(a.pack.metadata[0]!.binding.info).toBe(meta);
    expect(info.minimumArgumentCount).toBe(0);
    expect(meta.minimumArgumentCount).toBe(0);
  });
  it.each([
    "copy",
    "foreign",
    "binding",
    "info",
    "rows",
    "registrations",
    "minimum",
    "allocation",
    "early-freeze",
  ] as const)("rejects changed prefix %s after a valid request proof", (kind) => {
    const a = prefix();
    expect(requireNativeClosureReservationPrefix(a.tx, a.pack, "settle-meta")).toBe(a.pack);
    let pack = a.pack,
      tx = a.tx;
    if (kind === "copy") pack = { ...pack };
    if (kind === "foreign") tx = prefix().tx;
    if (kind === "binding")
      Object.assign(pack.metadata[0]!.binding, { signature: { ...pack.metadata[0]!.binding.signature } });
    if (kind === "info") Object.assign(pack.signatures[0]!.binding, { info: { ...pack.signatures[0]!.binding.info } });
    if (kind === "rows") Reflect.deleteProperty(pack.metadata, "0");
    if (kind === "registrations") Array.prototype.reverse.call(pack.registrations);
    if (kind === "minimum") Object.assign(pack.signatures[0]!.binding.info, { minimumArgumentCount: 0 });
    if (kind === "allocation") Reflect.deleteProperty(pack.signatures[0]!.binding.info, "hostOneShotOnly");
    if (kind === "early-freeze") Object.freeze(pack);
    expect(() => resumeNativeClosureResources(tx, pack, a.input.requests.length)).toThrow();
  });
  it("keeps query failures independent and rejects missing suffix after premature ledger freeze", () => {
    const a = prefix();
    expect(requireNativeClosureReservationPrefix(a.tx, a.pack, "settle-meta")).toBe(a.pack);
    expect(() => requireNativeClosureReservationPrefix(a.tx, a.pack, "delay")).toThrow(
      "missing or future closure request",
    );
    const before = structuredClone(a.module);
    for (const cut of [0, 1, 2, 4, NaN, 1.5]) expect(() => resumeNativeClosureResources(a.tx, a.pack, cut)).toThrow();
    expect(a.module).toStrictEqual(before);
    expect(() => nativeClosureReservationInventory(a.tx, a.pack, a.plan)).toThrow("incomplete");
    a.tx.freezeReservations();
    expect(() => requireNativeClosureReservationPrefix(a.tx, a.pack, "settle-meta")).toThrow("unfinished");
    expect(() => resumeNativeClosureResources(a.tx, a.pack, 3)).toThrow("unfinished");
  });
  it("preserves an actual thrown reservation sentinel and refuses retry", () => {
    const a = prefix();
    expect(requireNativeClosureReservationPrefix(a.tx, a.pack, "settle-meta")).toBe(a.pack);
    const sentinel = new Error("actual reserve interruption");
    const spy = vi.spyOn(a.tx, "reserveType").mockImplementationOnce(() => {
      throw sentinel;
    });
    let thrown: unknown;
    try {
      resumeNativeClosureResources(a.tx, a.pack, 3);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(sentinel);
    spy.mockRestore();
    expect(() => resumeNativeClosureResources(a.tx, a.pack, 3)).toThrow("failed closure reservation owner");
  });
  it.each(["suffix", "counter", "metadata", "request-order", "plan"] as const)(
    "rejects stale %s before advancing either ordinal space",
    (kind) => {
      const input = requests();
      // Mutable caller-owned plan proves currentness, rather than relying on a
      // write to an already-frozen canonical declaration throwing first.
      const plan = structuredClone(declaration(input));
      const module = createEmptyModule(),
        tx = new PhysicalModuleReservations(module);
      const pack = reserveNativeClosureResourcesPrefix(tx, input, plan, 2);
      expect(requireNativeClosureReservationPrefix(tx, pack, "settle-meta")).toBe(pack);
      if (kind === "suffix") Object.assign(input.requests[2]!, { allocationMode: "ordinary" });
      if (kind === "counter") Object.assign(input, { startingClosureCounter: 5 });
      if (kind === "metadata") Object.assign(input.requests[1]!, { name: "changed" });
      if (kind === "request-order") Array.prototype.reverse.call(input.requests);
      if (kind === "plan") Object.assign(plan, { resultingClosureCounter: plan.resultingClosureCounter + 1 });
      const before = structuredClone(module);
      expect(() => resumeNativeClosureResources(tx, pack, 3)).toThrow(
        kind === "plan" ? "stale closure declaration plan" : "stale closure request sequence",
      );
      expect(module).toStrictEqual(before);
      const twin = prefix();
      const probe = (ledger: PhysicalModuleReservations) => [
        ledger.reserveType("probe", { kind: "struct", name: "probe", fields: [] }).typeIndex,
        ledger.reserveFunction("probe-fn", "probe-fn", { params: [], results: [] }).handle,
      ];
      expect(probe(tx)).toEqual(probe(twin.tx));
    },
  );
  it("preflights an invalid late signature before publishing or reserving a valid prefix", () => {
    const control = prefix();
    expect(requireNativeClosureReservationPrefix(control.tx, control.pack, "settle-meta")).toBe(control.pack);
    const input = requests(),
      plan = declaration(input);
    Object.assign(input.requests[2]!, { minimumArgumentCount: 1 });
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    expect(() => reserveNativeClosureResourcesPrefix(tx, input, plan, 2)).toThrow("invalid observed minimum arity");
    expect(module).toStrictEqual(createEmptyModule());
    const twin = new PhysicalModuleReservations(createEmptyModule());
    const probe = (ledger: PhysicalModuleReservations) => [
      ledger.reserveType("probe", { kind: "struct", name: "probe", fields: [] }).typeIndex,
      ledger.reserveFunction("fn", "fn", { params: [], results: [] }).handle,
    ];
    expect(probe(tx)).toEqual(probe(twin));
  });
});
