// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { subscribePreparedIrProgram } from "../src/ir/program-observation.js";
import * as census from "../src/ir/program/native-promise-inventory.js";
import * as producers from "../src/backend/wasmgc/resources/native-promise-inventory.js";
import * as preflight from "../src/ir/program-native-async-resources.js";
import * as validation from "../src/ir/program-validation.js";
import { asAllocSiteId } from "../src/ir/core/nodes.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";

const options = { ...replayOptions("wasmgc", "standalone"), numberFormat: { integerBeforeScratch: true } };
function prepare(gvn: boolean) {
  vi.stubEnv("JS2WASM_IR_GVN", gvn ? "1" : "0");
  const source = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
  expect(createHash("sha256").update(source).digest("hex")).toBe(
    "6bc4fc96cc65881c9919a39b840afaf1001dfd3d0e05ef0cc141441a051f7915",
  );
  return requireProgram(
    prepareWholeIrProgram({
      ...sourceInput({ "./entry.ts": source }),
      policy: {
        backend: "wasmgc",
        target: "standalone",
        stringConst: { storage: "native" },
        stringConcat: { concat: "native" },
      },
      nativeStringValueProjection: "standalone-native",
      promiseDelayProjection: "standalone-native",
      asyncFamilyProjection: "standalone-native",
    }),
  );
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Flush completed synchronous compiler work before starting the next family.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

describe("native Promise inventory on ordinary consumer planning", () => {
  it("retains whole-program support and allocation authority after descriptive collection", () => {
    const program = prepare(false);
    const projection = program.runtime[0]!;
    const observed = vi.spyOn(producers, "observeNativeStringValueProducer");
    expect(preflight.planNativePromiseInventoryPreflight(program, options, projection, undefined, undefined).kind).toBe(
      "unavailable",
    );
    const { runtimeSupport: _support, ...withoutSupport } = program;
    expect(census.collectNativePromiseSourceCensus(withoutSupport, projection, options).required).toBe(true);
    expect(() =>
      preflight.planNativePromiseInventoryPreflight(withoutSupport, options, projection, undefined, undefined),
    ).toThrow();
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
    expect(preflight.planNativePromiseInventoryPreflight(changed, options, projection, undefined, undefined).kind).toBe(
      "unavailable",
    );
    allocations.metadata[allocations.metadata.length - 1] = { id, entries: [["encoding", undefined]] };
    expect(census.collectNativePromiseSourceCensus(changed, projection, options).required).toBe(true);
    expect(() =>
      preflight.planNativePromiseInventoryPreflight(changed, options, projection, undefined, undefined),
    ).toThrow(/stale encoding/);
    expect(observed).not.toHaveBeenCalled();
  });

  for (const required of [false, true])
    it(`authenticates direct preflight before returning: Promise demand=${required}`, () => {
      const program = required
        ? prepare(false)
        : requireProgram(
            prepareWholeIrProgram({
              ...sourceInput({ "./entry.ts": "export function run(): number { return 42; }" }),
              policy: { backend: "wasmgc", target: "standalone" },
            }),
          );
      const projection = program.runtime[0]!;
      const observed = vi.spyOn(producers, "observeNativeStringValueProducer");
      const authenticated = vi.spyOn(validation, "assertPreparedIrProgram");
      expect(
        preflight.planNativePromiseInventoryPreflight(program, options, projection, undefined, undefined).kind,
      ).toBe(required ? "unavailable" : "not-required");
      expect(authenticated).toHaveBeenCalledWith(program);
      const malformedAllocations = {
        ...program,
        allocations: { ...program.allocations, size: program.allocations.size + 1 },
      };
      expect(() =>
        preflight.planNativePromiseInventoryPreflight(malformedAllocations, options, projection, undefined, undefined),
      ).toThrow(/invalid allocation snapshot: denominator/);
      expect(program.abi.entries.length).toBeGreaterThan(0);
      const duplicateAbi = {
        ...program,
        abi: { ...program.abi, entries: [...program.abi.entries, program.abi.entries[0]!] },
      };
      expect(() =>
        preflight.planNativePromiseInventoryPreflight(duplicateAbi, options, projection, undefined, undefined),
      ).toThrow();
      expect(() =>
        preflight.planNativePromiseInventoryPreflight(program, options, { ...projection }, undefined, undefined),
      ).toThrow(/does not belong/);
      expect(observed).not.toHaveBeenCalled();
      const collect = vi.spyOn(census, "collectNativePromiseSourceCensus");
      for (const selectedOptions of [
        { ...options, backend: "linear" as const },
        { ...options, target: "host" as const },
      ]) {
        collect.mockClear();
        expect(() =>
          preflight.planNativePromiseInventoryPreflight(program, selectedOptions, projection, undefined, undefined),
        ).toThrow(/does not belong/);
        expect(collect).not.toHaveBeenCalled();
      }
      let input: Parameters<typeof preflight.planNativePromiseInventoryPreflight>[3];
      if (required) {
        const selected = projection.prepared.functions.find((fn) => fn.asyncPlan && fn.asyncRuntime);
        expect(selected).toBeDefined();
        const { asyncRuntime: _runtime, ...withoutRuntime } = selected!;
        const replacement = {
          ...projection,
          prepared: {
            ...projection.prepared,
            functions: projection.prepared.functions.map((fn) => (fn === selected ? withoutRuntime : fn)),
          },
        };
        const missingAttachment = {
          ...program,
          runtime: program.runtime.map((row) => (row === projection ? replacement : row)),
        };
        expect(() =>
          preflight.planNativePromiseInventoryPreflight(missingAttachment, options, replacement, undefined, undefined),
        ).toThrow();
        expect(acceptPreparedIrProgram(program, options).kind).toBe("unsupported");
        input = observed.mock.calls.at(-1)?.[1];
        expect(input).toBeDefined();
        observed.mockClear();
        expect(preflight.planNativePromiseInventoryPreflight(program, options, projection, input, undefined).kind).toBe(
          "unavailable",
        );
        expect(observed).toHaveBeenCalled();
        observed.mockClear();
      }
      // The live coordinator, not merely a consumer further up the stack, owns
      // whole-program authentication even when the descriptive census is valid.
      const marker = new Error("direct preflight authentication positive control");
      authenticated.mockImplementation(() => {
        throw marker;
      });
      expect(() =>
        preflight.planNativePromiseInventoryPreflight(program, options, projection, input, undefined),
      ).toThrow(marker);
      expect(observed).not.toHaveBeenCalled();
    });

  it("keeps synchronous re-export-only entries accepted without an entry-owned terminal", () => {
    const program = requireProgram(
      prepareWholeIrProgram({
        ...sourceInput({
          "./entry.ts": 'export { run } from "./lib";',
          "./lib.ts": "export function run(): number { return 42; }",
        }),
        policy: { backend: "wasmgc", target: "standalone" },
      }),
    );
    const observed = vi.spyOn(producers, "observeNativeStringValueProducer");
    expect(acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone")).kind).toBe("accepted");
    expect(observed).not.toHaveBeenCalled();
  });

  for (const gvn of [false, true])
    for (const decoded of [false, true])
      it(`accounts for the unchanged full family without accepting it: GVN=${gvn}, decoded=${decoded}`, () => {
        const original = prepare(gvn);
        const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
        const collect = vi.spyOn(census, "collectNativePromiseSourceCensus");
        const observe = vi.spyOn(producers, "observeNativeStringValueProducer");
        const plan = vi.spyOn(preflight, "planNativePromiseInventoryPreflight");
        const phases: string[] = [];
        const stop = subscribePreparedIrProgram((event) => {
          if (event.program === program) phases.push(event.phase);
        });
        try {
          const outcome = acceptPreparedIrProgram(program, options);
          expect(outcome.kind).toBe("unsupported");
          if (outcome.kind !== "unsupported") throw new Error("native async inventory is not execution proof");
          expect(program.inventory.allUnits).toHaveLength(7);
          expect(program.inventory.terminalUnits).toHaveLength(5);
          expect(program.runtime[0]!.prepared.functions).toHaveLength(16);
          expect(collect).toHaveBeenCalledWith(program, program.runtime[0], options);
          expect(observe).toHaveBeenCalled();
          const result = plan.mock.results.at(-1)?.value as preflight.NativePromiseInventoryPreflight;
          expect(result.kind).toBe("unavailable");
          if (result.kind !== "unavailable") throw new Error("missing full-family preflight");
          expect(result.source.demands.program).toBe(program);
          expect(result.source.demands.projection).toBe(program.runtime[0]);
          expect(result.source.demands.owners).toHaveLength(16);
          expect(
            result.source.demands.occurrences.filter(
              (row) =>
                result.source.demands.buffers[row.bufferIndex]!.view === "program" && row.instruction.kind === "call",
            ),
          ).toHaveLength(33);
          expect(result.observations).toHaveLength(1);
          expect(result.observations[0]!.declarations).toHaveLength(24);
          expect(result.observations[0]!.reservationSteps).toHaveLength(27);
          expect(result.observations[0]!.carriers).toHaveLength(6);
          expect(result.source.supportFunctions).toHaveLength(1);
          expect(result.source.supportBuffers).toHaveLength(31);
          expect(result.source.supportOccurrences).toHaveLength(157);
          expect(result.obligations.map((row) => row.code)).toEqual([
            "missing-runtime-configuration",
            "producer-declaration",
            "source-carrier-association",
            "dispatch-evidence",
            "construction-contract",
            "complete-composition",
          ]);
          for (const row of result.obligations)
            expect(outcome.detail).toContain(`native Promise inventory ${row.code}: ${row.detail}`);
          expect(phases).toEqual([]);
        } finally {
          stop();
        }
      });

  for (const owner of ["census", "producer"] as const)
    it(`propagates a ${owner} failure through actual acceptance`, () => {
      const program = prepare(false);
      const marker = new Error(`inventory ${owner} positive control`);
      if (owner === "census")
        vi.spyOn(census, "collectNativePromiseSourceCensus").mockImplementation(() => {
          throw marker;
        });
      else
        vi.spyOn(producers, "observeNativeStringValueProducer").mockImplementation(() => {
          throw marker;
        });
      expect(() => acceptPreparedIrProgram(program, options)).toThrow(marker);
    });
});
