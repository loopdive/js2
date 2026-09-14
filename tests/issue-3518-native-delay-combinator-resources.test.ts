// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { setImmediate as yieldToReporter } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { captureNativeFamilyRuntimeSupport } from "./helpers/native-family-runtime-support.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";
// These checked wrappers are parent-owned prerequisites, not worker stubs.
import {
  planNativeVectorResources,
  planPreparedNativeDelayCombinatorResources,
  reservePreparedNativeDelayCombinatorResources,
} from "../src/ir/program-physical-plan.js";
import {
  declareNativeClosureResources,
  reserveNativeClosureResourcesPrefix,
  resumeNativeClosureResources,
  type NativeClosureRequirements,
} from "../src/backend/wasmgc/resources/native-closures.js";
import { reserveNativeVectorTypes } from "../src/backend/wasmgc/resources/native-vectors.js";
import {
  declareNativePromiseResources,
  reserveNativePromiseResources,
} from "../src/backend/wasmgc/resources/native-promises.js";
import {
  declareNativeDelayCombinatorResources,
  nativeDelayCombinatorReservationInventory,
} from "../src/backend/wasmgc/resources/native-delay-combinator.js";

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
  moduleName: "b3-reservations",
} as const;
const configuration = { hooks: "disabled", unhandledRejections: "disabled" } as const;
const selection = { settleMetadataRequestId: "settle-meta", delaySignatureRequestId: "delay" };
afterEach(async () => {
  vi.restoreAllMocks();
  await yieldToReporter();
});
function prepare(decoded: boolean) {
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
    }),
  );
  const projection = program.runtime[0]!;
  const requirements = planPreparedNativeDelayCombinatorResources(
    program,
    options,
    projection,
    configuration,
    selection,
  );
  if (!requirements) throw new Error("genuine full family must require B3");
  expect(requirements.delay).toBe(true);
  expect(requirements.all).toBe(true);
  expect(requirements.demands.owners.length).toBe(program.ir.functions.length);
  expect(requirements.uses.length).toBeGreaterThan(0);
  return { program, projection, requirements };
}
const cache = new Map<boolean, { value: ReturnType<typeof prepare> } | { error: unknown }>();
function actual(decoded = false) {
  let entry = cache.get(decoded);
  if (!entry) {
    try {
      entry = { value: prepare(decoded) };
    } catch (error) {
      entry = { error };
    }
    cache.set(decoded, entry);
  }
  if ("error" in entry) throw entry.error;
  return entry.value;
}
function setup(decoded = false, cachedZero = false, settleMinimum?: number) {
  const data = actual(decoded),
    module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const exceptionTag = tx.reserveTag(
    "exception",
    { params: [{ kind: "externref" }], results: [] },
    { kind: "defined", name: "__exn" },
  );
  const vectors = reserveNativeVectorTypes(tx, planNativeVectorResources(data.program, options, data.projection));
  const requests: NativeClosureRequirements["requests"] = [
    ...(cachedZero
      ? [
          {
            kind: "signature" as const,
            id: "earlier-zero",
            params: [],
            results: [],
            allocationMode: "ordinary" as const,
            minimumArgumentCount: 0,
          },
        ]
      : []),
    {
      kind: "signature",
      id: "settle",
      params: [{ kind: "externref" }],
      results: [],
      allocationMode: "ordinary",
      ...(settleMinimum === undefined ? {} : { minimumArgumentCount: settleMinimum }),
    },
    { kind: "metadata", id: "settle-meta", signatureId: "settle", key: "promise:settle", name: "", length: 1 },
    { kind: "signature", id: "delay", params: [], results: [], allocationMode: "host-one-shot" },
  ];
  const closurePlan = declareNativeClosureResources({
    key: "b3:closures",
    startingClosureCounter: 0,
    requests,
    referenceTypeKeys: [],
  });
  const order: string[] = [];
  const closures = reserveNativeClosureResourcesPrefix(
    tx,
    { key: "b3:closures", startingClosureCounter: 0, requests, referenceTypes: [] },
    closurePlan,
    requests.length - 1,
  );
  order.push("closure-prefix");
  const metadata = closures.metadata[0]!.binding,
    root = closures.root,
    info = metadata.info;
  const vector = vectors.layouts.find((row) => row.element === "externref")!;
  const promisePlan = declareNativePromiseResources(data.requirements.promiseRequirements, {
    argumentArrayKey: vector.array.key,
    closureRootKey: root.key,
    settleMetadataKey: metadata.type.key,
  });
  const promises = reserveNativePromiseResources(
    tx,
    data.requirements.promiseRequirements,
    { vectors, exceptionTag, closures, settleMetadataRequestId: "settle-meta" },
    promisePlan,
  );
  order.push("promise");
  resumeNativeClosureResources(tx, closures, requests.length);
  order.push("delay-suffix");
  expect(closures.root).toBe(root);
  expect(closures.metadata[0]!.binding).toBe(metadata);
  expect(metadata.info).toBe(info);
  if (cachedZero) {
    expect(closures.signatures.at(-1)!.binding).toBe(closures.signatures[0]!.binding);
    expect(closures.signatures.at(-1)!.binding.info.minimumArgumentCount).toBe(0);
  }
  const dependencies = { closures, closurePlan, promises, promisePlan, vectors };
  const plan = declareNativeDelayCombinatorResources(data.requirements, {
    closurePlan,
    promisePlan,
    vectorCarrierKey: vector.carrier.key,
    vectorArrayKey: vector.array.key,
  });
  const reserve = () =>
    reservePreparedNativeDelayCombinatorResources(
      data.program,
      options,
      data.projection,
      configuration,
      tx,
      data.requirements,
      dependencies,
      plan,
    );
  return { ...data, module, tx, dependencies, plan, reserve, order };
}
const roles = [
  "delay-capture",
  "delay-callback",
  "delay-provider",
  "all-state",
  "all-element",
  "subscribe",
  "all-fulfill",
  "race-fulfill",
  "reject",
  "all-provider",
];
describe("B3 genuine source reservation ownership, not filled runtime", () => {
  for (const decoded of [false, true])
    for (const cachedZero of [false, true])
      it(`reserves exact staged population decoded=${decoded} cache=${cachedZero}`, () => {
        const a = setup(decoded, cachedZero);
        expect(a.plan.declarations.map((row) => row.role)).toEqual(roles.map((role) => ["delay-combinator", role]));
        expect(a.plan.declarations.filter((row) => row.space === "type")).toHaveLength(3);
        expect(a.plan.declarations.filter((row) => row.space === "function")).toHaveLength(7);
        const steps = a.plan.reservationSteps.filter((step) => step.kind === "intern-signature");
        expect(steps).toHaveLength(4);
        expect(steps.map((step) => Object.hasOwn(step, "name"))).toEqual([true, false, false, false]);
        expect(steps[0]!.name).toBe("$__ir_promise_delay_native_type");
        const intern = vi.spyOn(a.tx, "internFunctionType");
        const pack = a.reserve();
        a.order.push("B3");
        expect(a.order).toEqual(["closure-prefix", "promise", "delay-suffix", "B3"]);
        expect(intern.mock.calls).toHaveLength(11);
        expect(intern.mock.calls.map((args) => args.length)).toEqual([2, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
        expect(intern.mock.calls[1]![2]).toBe("$__ir_promise_delay_native_type");
        const rows = nativeDelayCombinatorReservationInventory(a.tx, pack, a.plan);
        expect(rows.map((row) => row.key)).toEqual(roles.map((role) => a.requirements.key + ":" + role));
        expect(rows.filter((row) => row.kind === "function").every((row) => row.object.body.length === 0)).toBe(true);
        expect(pack.delay!.capture.object).toMatchObject({
          kind: "struct",
          superTypeIdx: a.dependencies.closures.signatures.at(-1)!.binding.type.typeIndex,
        });
        expect(pack.all!.state.object).toMatchObject({
          kind: "struct",
          fields: [
            { name: "resultPromise" },
            { name: "resultsArr" },
            { name: "length" },
            { name: "remaining", mutable: true },
          ],
        });
        expect(Object.hasOwn(pack.all!.state.object, "superTypeIdx")).toBe(false);
        expect(Object.hasOwn(pack.all!.element.object, "superTypeIdx")).toBe(false);
      });
  for (const minimum of [0, 1])
    it(`accepts genuine settle observation ${minimum} with cached zero minimum0`, () => {
      const a = setup(false, true, minimum),
        pack = a.reserve();
      expect(nativeDelayCombinatorReservationInventory(a.tx, pack, a.plan)).toHaveLength(10);
      expect(a.dependencies.closures.metadata[0]!.binding.metadata.length).toBe(1);
    });
  it("rejects a minimum beyond canonical zeroarg arity in the real closure producer", () => {
    expect(() =>
      declareNativeClosureResources({
        key: "invalid-minimum",
        startingClosureCounter: 0,
        referenceTypeKeys: [],
        requests: [
          {
            kind: "signature",
            id: "zero",
            params: [],
            results: [],
            allocationMode: "ordinary",
            minimumArgumentCount: 1,
          },
        ],
      }),
    ).toThrow();
  });
  for (const mutation of ["copied-pack", "foreign-pack", "copied-plan", "descriptor"] as const)
    it(`inventory rejects ${mutation} after genuine positive`, () => {
      const a = setup(),
        pack = a.reserve();
      expect(nativeDelayCombinatorReservationInventory(a.tx, pack, a.plan)).toHaveLength(10);
      if (mutation === "copied-pack")
        expect(() => nativeDelayCombinatorReservationInventory(a.tx, { ...pack }, a.plan)).toThrow();
      if (mutation === "foreign-pack") {
        const b = setup(),
          other = b.reserve();
        expect(() => nativeDelayCombinatorReservationInventory(a.tx, other, a.plan)).toThrow();
      }
      if (mutation === "copied-plan")
        expect(() => nativeDelayCombinatorReservationInventory(a.tx, pack, structuredClone(a.plan))).toThrow();
      if (mutation === "descriptor") {
        pack.delay!.capture.object.name = "mutated";
        expect(() => nativeDelayCombinatorReservationInventory(a.tx, pack, a.plan)).toThrow();
      }
    });
  for (const mutation of ["drop-race", "reorder-steps", "foreign-closures", "copied-promises", "wrong-array"] as const)
    it(`rejects ${mutation} before B3 allocation`, () => {
      const positive = setup();
      expect(nativeDelayCombinatorReservationInventory(positive.tx, positive.reserve(), positive.plan)).toHaveLength(
        10,
      );
      const a = setup(),
        twin = setup();
      let plan = a.plan;
      if (mutation === "drop-race")
        plan = { ...plan, declarations: plan.declarations.filter((row) => row.role[1] !== "race-fulfill") };
      if (mutation === "reorder-steps") plan = { ...plan, reservationSteps: [...plan.reservationSteps].reverse() };
      if (mutation === "foreign-closures") a.dependencies.closures = twin.dependencies.closures;
      if (mutation === "copied-promises") a.dependencies.promises = { ...a.dependencies.promises };
      if (mutation === "wrong-array") a.dependencies.vectors = twin.dependencies.vectors;
      const before = structuredClone(a.module);
      expect(() =>
        reservePreparedNativeDelayCombinatorResources(
          a.program,
          options,
          a.projection,
          configuration,
          a.tx,
          a.requirements,
          a.dependencies,
          plan,
        ),
      ).toThrow(mutation === "wrong-array" ? "substituted shared Promise array" : undefined);
      expect(a.tx.state).toBe("reserving");
      expect(a.module).toStrictEqual(before);
      const probe = (tx: PhysicalModuleReservations) => ({
        type: tx.reserveType("future-type", { kind: "struct", name: "future", fields: [] }).typeIndex,
        fn: tx.reserveFunction("future-function", "future", { params: [], results: [] }).handle,
      });
      expect(probe(a.tx)).toStrictEqual(probe(twin.tx));
    });
});
