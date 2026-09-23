// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { nativeDelayCombinatorCensus } from "./helpers/native-delay-combinator-census.js";
import { afterEach, expect, it } from "vitest";
import * as publicPlanner from "../src/ir/program-physical-plan.js";
import * as directAsyncResources from "../src/ir/program-native-async-resources.js";

it("preserves the existing planner exports as direct async-resource function identities", () => {
  for (const name of [
    "planNativePromiseResources",
    "planPreparedNativeDelayCombinatorResources",
    "reservePreparedNativeDelayCombinatorResources",
    "preparedNativeDelayCombinatorReservationInventory",
  ] as const) {
    expect(publicPlanner[name]).toBe(directAsyncResources[name]);
  }
});

it("tracks relocated source admission as explicit mixed debt without clean activation", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/compiler-boundaries.json", import.meta.url), "utf8"));
  const path = "src/ir/program-native-async-resources.ts";
  const rows = policy.files.filter((row: { path: string }) => row.path === path);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
  });
  expect(rows[0].nextBoundary).toContain("program-validation.ts");
  expect(policy.layers.some((layer: { entries?: string[] }) => layer.entries?.includes(path))).toBe(false);
  expect(policy.activationHistory.some((row: { entries: string[] }) => row.entries.includes(path))).toBe(false);
});
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { captureNativeFamilyRuntimeSupport } from "./helpers/native-family-runtime-support.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";
import {
  planNativeVectorResources,
  planNativePromiseResources,
  planPreparedNativeDelayCombinatorResources,
  reservePreparedNativeDelayCombinatorResources,
  preparedNativeDelayCombinatorReservationInventory,
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
  reserveNativeDelayCombinatorResources,
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
  moduleName: "checked-delay",
} as const;
const disabled = { hooks: "disabled", unhandledRejections: "disabled" } as const;
const dispatched = { hooks: "dispatch", unhandledRejections: "disabled" } as const;
const selection = { settleMetadataRequestId: "settle-meta", delaySignatureRequestId: "delay" };
// Reviewed one-time capture; normal tests never regenerate expected compiler output.
const expectedCensus = JSON.parse(
  readFileSync(new URL("./fixtures/issue-3518-delay-combinator-census.json", import.meta.url), "utf8"),
);

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
});

for (const replay of [false, true])
  for (const cached of [false, true]) {
    it(`checks real source reservations before allocation, decoded=${replay}, cached=${cached}`, () => {
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
      const requirements = planPreparedNativeDelayCombinatorResources(
        program,
        options,
        projection,
        disabled,
        selection,
      );
      if (!requirements) throw new Error("genuine family must select delay and all");
      expect(nativeDelayCombinatorCensus(program, projection)).toStrictEqual(expectedCensus);
      const demands = requirements.demands;
      const coordinate = (buffer: (typeof demands.buffers)[number]) => {
        const owner = demands.owners.find((row) => row.unitId === buffer.ownerUnitId)!;
        return {
          view: buffer.view,
          ownerUnitId: buffer.ownerUnitId,
          ownerName: (buffer.view === "program" ? owner.programFunction : owner.projectedFunction).name,
          rootKind: buffer.root.kind,
          rootIndex: buffer.root.index,
          rootId: buffer.root.id,
          path: buffer.path.map((row) => ({ ...row })),
        };
      };
      const views = ["program", "projection"] as const;
      expect({
        owners: Object.fromEntries(
          views.map((view) => [
            view,
            demands.owners.map((row) => ({
              unitId: row.unitId,
              name: (view === "program" ? row.programFunction : row.projectedFunction).name,
            })),
          ]),
        ),
        buffers: views.flatMap((view) =>
          demands.buffers
            .filter((row) => row.view === view)
            .map((row) => ({ ...coordinate(row), instructionCount: row.instructions.length })),
        ),
        calls: views.flatMap((view) =>
          requirements.uses.flatMap((use) => {
            const occurrence = demands.occurrences[use.occurrence]!,
              buffer = demands.buffers[occurrence.bufferIndex]!;
            if (buffer.view !== view) return [];
            if (occurrence.instruction.kind !== "call") throw new Error("checked use must be a call");
            return [
              {
                ...coordinate(buffer),
                instructionIndex: occurrence.instructionIndex,
                kind: use.kind,
                binding: { ...occurrence.instruction.target.binding },
              },
            ];
          }),
        ),
      }).toStrictEqual(expectedCensus);
      expect(requirements.delay).toBe(true);
      expect(requirements.all).toBe(true);
      expect(requirements.demands.owners.length).toBe(program.ir.functions.length);
      expect(requirements.uses.length).toBeGreaterThan(0);
      expect(
        new Set(
          requirements.uses.map(
            (use) => requirements.demands.buffers[requirements.demands.occurrences[use.occurrence]!.bufferIndex]!.view,
          ),
        ),
      ).toEqual(new Set(["program", "projection"]));

      function setup() {
        const module = createEmptyModule(),
          tx = new PhysicalModuleReservations(module);
        const exceptionTag = tx.reserveTag(
          "tag",
          { params: [{ kind: "externref" }], results: [] },
          { kind: "defined", name: "__exn" },
        );
        const vectors = reserveNativeVectorTypes(tx, planNativeVectorResources(program, options, projection));
        const scalarRequests = [
          ...(cached
            ? [
                {
                  kind: "signature" as const,
                  id: "earlier-zero",
                  params: [],
                  results: [],
                  allocationMode: "support" as const,
                  minimumArgumentCount: 0,
                },
              ]
            : []),
          {
            kind: "signature" as const,
            id: "settle",
            params: [{ kind: "externref" as const }],
            results: [],
            allocationMode: "ordinary" as const,
            minimumArgumentCount: 1,
          },
          {
            kind: "metadata" as const,
            id: "settle-meta",
            signatureId: "settle",
            key: "promise:settle",
            name: "",
            length: 1,
          },
          {
            kind: "signature" as const,
            id: "delay",
            params: [],
            results: [],
            allocationMode: "host-one-shot" as const,
          },
        ];
        const input: NativeClosureRequirements = {
          key: "checked:closures",
          startingClosureCounter: 0,
          requests: scalarRequests,
          referenceTypes: [],
        };
        const closurePlan = declareNativeClosureResources({
          key: input.key,
          startingClosureCounter: 0,
          requests: scalarRequests,
          referenceTypeKeys: [],
        });
        const order: string[] = [];
        const closures = reserveNativeClosureResourcesPrefix(tx, input, closurePlan, input.requests.length - 1);
        order.push("closure-prefix");
        const root = closures.root,
          metadata = closures.metadata[0]!.binding,
          info = metadata.info;
        const promiseRequirements = planNativePromiseResources(program, options, projection, disabled);
        const vector = vectors.layouts.find((row) => row.element === "externref")!;
        const promisePlan = declareNativePromiseResources(promiseRequirements, {
          argumentArrayKey: vector.array.key,
          closureRootKey: root.key,
          settleMetadataKey: metadata.type.key,
        });
        const promises = reserveNativePromiseResources(
          tx,
          promiseRequirements,
          { vectors, closures, exceptionTag, settleMetadataRequestId: "settle-meta" },
          promisePlan,
        );
        order.push("promise");
        expect(resumeNativeClosureResources(tx, closures, input.requests.length)).toBe(closures);
        order.push("closure-suffix");
        expect(closures.root).toBe(root);
        expect(closures.metadata[0]!.binding).toBe(metadata);
        expect(metadata.info).toBe(info);
        if (cached)
          expect(closures.signatures.find((row) => row.id === "delay")!.binding).toBe(
            closures.signatures.find((row) => row.id === "earlier-zero")!.binding,
          );
        const dependencies = { closures, closurePlan, promises, promisePlan, vectors };
        const declaration = declareNativeDelayCombinatorResources(requirements!, {
          closurePlan,
          promisePlan,
          vectorCarrierKey: vector.carrier.key,
          vectorArrayKey: vector.array.key,
        });
        return { module, tx, dependencies, declaration, order };
      }
      const candidate = setup(),
        pristine = setup();
      // Establish the genuine successful reservation before testing rejection.
      const positive = reservePreparedNativeDelayCombinatorResources(
        program,
        options,
        projection,
        disabled,
        pristine.tx,
        requirements,
        pristine.dependencies,
        pristine.declaration,
      );
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
      expect(
        nativeDelayCombinatorReservationInventory(pristine.tx, positive, pristine.declaration).map((row) => row.key),
      ).toEqual(roles.map((role) => requirements.key + ":" + role));
      const different = planPreparedNativeDelayCombinatorResources(
        program,
        options,
        projection,
        dispatched,
        selection,
      )!;
      expect(different.promiseRequirements).not.toStrictEqual(requirements.promiseRequirements);
      expect(
        preparedNativeDelayCombinatorReservationInventory(
          program,
          options,
          projection,
          disabled,
          pristine.tx,
          requirements,
          pristine.dependencies,
          pristine.declaration,
          positive,
        ).map((row) => row.key),
      ).toEqual(roles.map((role) => requirements.key + ":" + role));
      const inventorySnapshot = structuredClone(pristine.module);
      expect(() =>
        preparedNativeDelayCombinatorReservationInventory(
          program,
          options,
          projection,
          dispatched,
          pristine.tx,
          different,
          pristine.dependencies,
          pristine.declaration,
          positive,
        ),
      ).toThrow("Promise source requirements differ from checked source plan");
      expect(pristine.module).toStrictEqual(inventorySnapshot);
      // Adversarial lower-level input is deliberately not accepted source evidence.
      const detached = setup();
      const detachedRequirements = {
        ...requirements,
        demands: { ...requirements.demands, program: { ...program } },
      };
      const detachedPack = reserveNativeDelayCombinatorResources(
        detached.tx,
        detachedRequirements,
        detached.dependencies,
        detached.declaration,
      );
      expect(nativeDelayCombinatorReservationInventory(detached.tx, detachedPack, detached.declaration)).toHaveLength(
        10,
      );
      const detachedSnapshot = structuredClone(detached.module);
      expect(() =>
        preparedNativeDelayCombinatorReservationInventory(
          program,
          options,
          projection,
          disabled,
          detached.tx,
          requirements,
          detached.dependencies,
          detached.declaration,
          detachedPack,
        ),
      ).toThrow("detached reservation source association");
      expect(detached.module).toStrictEqual(detachedSnapshot);
      // One detached borrowed reference per cell, preserving the genuine top-level source.
      const borrowed = setup();
      let borrowedDemands = requirements.demands;
      if (!replay && !cached)
        borrowedDemands = {
          ...borrowedDemands,
          owners: borrowedDemands.owners.map((row, index) =>
            index === 0 ? { ...row, programFunction: { ...row.programFunction } } : row,
          ),
        };
      else if (!replay && cached)
        borrowedDemands = {
          ...borrowedDemands,
          buffers: borrowedDemands.buffers.map((row, index) =>
            index === 0 ? { ...row, instructions: [...row.instructions] } : row,
          ),
        };
      else if (replay && !cached)
        borrowedDemands = { ...borrowedDemands, allocations: { ...borrowedDemands.allocations } };
      else {
        const selected = borrowedDemands.literals.findIndex(
          (row) => row.kind === "string.const" && row.allocation.metadataRow.present,
        );
        expect(selected).toBeGreaterThanOrEqual(0);
        borrowedDemands = {
          ...borrowedDemands,
          literals: borrowedDemands.literals.map((row, index) => {
            if (index !== selected || row.kind !== "string.const" || !row.allocation.metadataRow.present) return row;
            return {
              ...row,
              allocation: {
                ...row.allocation,
                metadataRow: { present: true as const, value: { ...row.allocation.metadataRow.value } },
              },
            };
          }),
        };
      }
      const borrowedRequirements = { ...requirements, demands: borrowedDemands };
      const borrowedPack = reserveNativeDelayCombinatorResources(
        borrowed.tx,
        borrowedRequirements,
        borrowed.dependencies,
        borrowed.declaration,
      );
      expect(nativeDelayCombinatorReservationInventory(borrowed.tx, borrowedPack, borrowed.declaration)).toHaveLength(
        10,
      );
      const borrowedSnapshot = structuredClone(borrowed.module);
      expect(() =>
        preparedNativeDelayCombinatorReservationInventory(
          program,
          options,
          projection,
          disabled,
          borrowed.tx,
          requirements,
          borrowed.dependencies,
          borrowed.declaration,
          borrowedPack,
        ),
      ).toThrow("detached borrowed census association");
      expect(borrowed.module).toStrictEqual(borrowedSnapshot);
      expect(borrowed.tx.state).toBe("reserving");
      expect(
        declareNativeDelayCombinatorResources(different, {
          closurePlan: candidate.dependencies.closurePlan,
          promisePlan: candidate.dependencies.promisePlan,
          vectorCarrierKey: candidate.declaration.dependencies.vectorCarrierKey,
          vectorArrayKey: candidate.declaration.dependencies.vectorArrayKey,
        }),
      ).toStrictEqual(candidate.declaration);
      const snapshot = structuredClone(candidate.module);
      expect(() =>
        reservePreparedNativeDelayCombinatorResources(
          program,
          options,
          projection,
          dispatched,
          candidate.tx,
          different,
          candidate.dependencies,
          candidate.declaration,
        ),
      ).toThrow("Promise source requirements differ from checked source plan");
      expect(candidate.module).toStrictEqual(snapshot);
      expect(candidate.tx.state).toBe("reserving");
      for (const value of [candidate]) {
        const pack = reservePreparedNativeDelayCombinatorResources(
          program,
          options,
          projection,
          disabled,
          value.tx,
          requirements,
          value.dependencies,
          value.declaration,
        );
        value.order.push("delay-combinator");
        expect(value.order).toEqual(["closure-prefix", "promise", "closure-suffix", "delay-combinator"]);
        const inventory = nativeDelayCombinatorReservationInventory(value.tx, pack, value.declaration);
        expect(inventory.filter((row) => row.kind === "type")).toHaveLength(3);
        expect(inventory.filter((row) => row.kind === "function")).toHaveLength(7);
        expect(inventory.map((row) => row.key)).toEqual(value.declaration.declarations.map((row) => row.key));
        expect(inventory.map((row) => row.key)).toEqual(roles.map((role) => requirements.key + ":" + role));
      }
      expect(candidate.module).toStrictEqual(pristine.module);
    }, 35000);
  }
