// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { irNativeAsyncCallableDeclaration } from "../src/ir/runtime/native-async-callables.js";
import {
  deriveNativeNumberFormatRequirements,
  assertNativeNumberFormatRequirementsCurrent,
} from "../src/ir/program/native-number-format-requirements.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";

const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
function actual() {
  const source = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
  const program = requireProgram(
    prepareWholeIrProgram({
      ...sourceInput({ "./entry.ts": source }),
      policy,
      promiseDelayProjection: "standalone-native",
      asyncFamilyProjection: "standalone-native",
    }),
  );
  assertPreparedIrProgram(program);
  return program;
}

describe("complete prepared formatter demand joins", () => {
  it.each([false, true])(
    "borrows both primary views and separate support with fast path %s",
    (integerBeforeScratch) => {
      const program = actual(),
        projection = program.runtime[0]!;
      const input = { program, projection, integerBeforeScratch };
      const census = collectNativeStringValueDemands(program, projection);
      const expected = census.occurrences.filter(
        ({ instruction }) =>
          instruction.kind === "call" &&
          irNativeAsyncCallableDeclaration(instruction.target)?.feature === "async.native.number-to-string",
      );
      expect(program.ir.functions).toHaveLength(16);
      expect(expected).toHaveLength(8);
      const requirements = deriveNativeNumberFormatRequirements(input)!;
      // Four source calls survive in the two continuation owners, in both views.
      // These coordinates are fixed independently of the demand selector above.
      expect(
        requirements.calls.map((row) => ({
          owner: program.ir.functions.find((fn) => fn.unitId === row.ownerUnitId)?.name,
          view: row.view,
          root: row.root,
          path: row.path,
          instructionIndex: row.instructionIndex,
        })),
      ).toEqual(
        [1, 2].flatMap((state) =>
          ["program", "projection"].flatMap((view) =>
            [1, 4].map((instructionIndex) => ({
              owner: `main__ir_async_state_${state}`,
              view,
              root: { kind: "block", index: 0, id: 0 },
              path: [],
              instructionIndex,
            })),
          ),
        ),
      );
      expect(requirements.calls.map((row) => row.instruction)).toEqual(expected.map((row) => row.instruction));
      expect(new Set(requirements.calls.map((row) => row.view))).toEqual(new Set(["program", "projection"]));
      expect(requirements.batch).toBe(program.runtimeSupport!.batches[0]);
      expect(requirements.supportBuffers).toHaveLength(31);
      expect(requirements.literals).toHaveLength(requirements.batch.literals.length);
      expect(
        requirements.literals.map((row) => [row.bufferIndex, row.instructionIndex, row.instruction.value]),
      ).toEqual([
        [1, 0, "NaN"],
        [3, 0, "Infinity"],
        [5, 0, "-Infinity"],
        [9, 0, "0"],
      ]);
      for (const row of requirements.supportBuffers) {
        expect(row.ownerUnitId).toBe(requirements.batch.implementation.body.unitId);
        expect(census.buffers.some((ordinary) => ordinary.instructions === row.instructions)).toBe(false);
      }
      for (const row of requirements.literals) {
        expect(row.representation).toBe("inline-wtf16");
        expect(row.instruction).toBe(requirements.supportBuffers[row.bufferIndex]!.instructions[row.instructionIndex]);
        expect(row.allocation).toBe(row.instruction.alloc);
      }
      expect(() => assertNativeNumberFormatRequirementsCurrent(input, requirements)).not.toThrow();
      expect(collectNativeStringValueDemands(program, projection)).toEqual(census);
    },
  );

  it("derives independent valid joins after real codec replay", () => {
    const original = actual(),
      decoded = decodePreparedIrProgram(encodePreparedIrProgram(original));
    assertPreparedIrProgram(decoded);
    const oldInput = { program: original, projection: original.runtime[0]!, integerBeforeScratch: true };
    const input = { program: decoded, projection: decoded.runtime[0]!, integerBeforeScratch: true };
    const previous = deriveNativeNumberFormatRequirements(oldInput)!;
    const current = deriveNativeNumberFormatRequirements(input)!;
    expect(current.batch).not.toBe(previous.batch);
    expect(current.calls.length).toBe(previous.calls.length);
    expect(current.literals.length).toBe(previous.literals.length);
    expect(() => assertNativeNumberFormatRequirementsCurrent(input, current)).not.toThrow();
    expect(() => assertNativeNumberFormatRequirementsCurrent(input, previous)).toThrow(/foreign borrowed/);
  });

  it("rejects missing support independently of its receipt", () => {
    const original = actual();
    const input = { program: original, projection: original.runtime[0]!, integerBeforeScratch: false };
    expect(deriveNativeNumberFormatRequirements(input)!.calls.length).toBeGreaterThan(0);
    const { runtimeSupport: removed, ...program } = original;
    expect(removed!.batches.length).toBe(1);
    expect(() => deriveNativeNumberFormatRequirements({ ...input, program })).toThrow(
      /missing demanded formatter support/,
    );
  });

  it.each(["missing", "duplicate", "implementation", "policy"] as const)(
    "rejects a changed selected formatter %s",
    (change) => {
      const original = actual(),
        selected = original.runtime[0]!;
      expect(
        deriveNativeNumberFormatRequirements({ program: original, projection: selected, integerBeforeScratch: false })!
          .calls.length,
      ).toBeGreaterThan(0);
      const provider = selected.prepared.manifest.providers.find(
        (row) => row.feature === "async.native.number-to-string",
      )!;
      expect(provider).toBeDefined();
      const providers =
        change === "missing"
          ? selected.prepared.manifest.providers.filter((row) => row !== provider)
          : change === "duplicate"
            ? [...selected.prepared.manifest.providers, provider]
            : change === "implementation"
              ? selected.prepared.manifest.providers.map((row) =>
                  row === provider
                    ? { ...row, implementation: { kind: "runtime-callable" as const, symbol: "unrelated_formatter" } }
                    : row,
                )
              : selected.prepared.manifest.providers;
      const projection = {
        ...selected,
        prepared: {
          ...selected.prepared,
          manifest: {
            ...selected.prepared.manifest,
            providers,
            policy:
              change === "policy"
                ? { ...selected.prepared.manifest.policy, stringConst: undefined }
                : selected.prepared.manifest.policy,
          },
        },
      };
      // Deliberately contradictory data, never an authenticated or emitted program.
      const program = { ...original, runtime: [projection] };
      expect(() => deriveNativeNumberFormatRequirements({ program, projection, integerBeforeScratch: false })).toThrow(
        change === "policy"
          ? /requires explicit native string storage/
          : change === "implementation"
            ? /implementation mismatch/
            : /missing or duplicate formatter provider/,
      );
    },
  );

  it("rejects omitted resolved options and stale or detached occurrence evidence", () => {
    const program = actual();
    const input = { program, projection: program.runtime[0]!, integerBeforeScratch: false };
    const current = deriveNativeNumberFormatRequirements(input)!;
    expect(() => assertNativeNumberFormatRequirementsCurrent(input, current)).not.toThrow();
    const missing = { ...input };
    Reflect.deleteProperty(missing, "integerBeforeScratch");
    expect(() => deriveNativeNumberFormatRequirements(missing)).toThrow(/explicitly resolved/);
    expect(() =>
      assertNativeNumberFormatRequirementsCurrent({ ...input, integerBeforeScratch: true }, current),
    ).toThrow(/stale/);
    expect(() =>
      assertNativeNumberFormatRequirementsCurrent(input, { ...current, calls: current.calls.slice(1) }),
    ).toThrow(/stale calls/);
    const calls = current.calls.map((row) => ({ ...row, instruction: { ...row.instruction } }));
    expect(() => assertNativeNumberFormatRequirementsCurrent(input, { ...current, calls })).toThrow(
      /detached borrowed/,
    );
  });

  it("rejects changed support allocation and detached support evidence", () => {
    const program = actual();
    const input = { program, projection: program.runtime[0]!, integerBeforeScratch: false };
    const current = deriveNativeNumberFormatRequirements(input)!;
    expect(current.literals).toHaveLength(4);
    expect(() => assertNativeNumberFormatRequirementsCurrent(input, current)).not.toThrow();
    const retiredId = current.literals[0]!.canonicalAllocation;
    const retiredProgram = {
      ...program,
      allocations: {
        ...program.allocations,
        entries: program.allocations.entries.map((entry, index) =>
          index === retiredId ? { state: "retired" as const } : entry,
        ),
      },
    };
    expect(() => deriveNativeNumberFormatRequirements({ ...input, program: retiredProgram })).toThrow(
      /support allocation is not live/,
    );
    for (const field of ["allocation", "canonicalAllocation"] as const) {
      const literals = current.literals.map((row, index) => (index === 0 ? { ...row, [field]: row[field] + 1 } : row));
      expect(() => assertNativeNumberFormatRequirementsCurrent(input, { ...current, literals })).toThrow(
        /stale literals/,
      );
    }
    expect(() =>
      assertNativeNumberFormatRequirementsCurrent(input, {
        ...current,
        literals: current.literals.slice(1),
      }),
    ).toThrow(/stale literals/);
    const supportBuffers = current.supportBuffers.map((row) => ({
      ...row,
      instructions: [...row.instructions],
    }));
    expect(() => assertNativeNumberFormatRequirementsCurrent(input, { ...current, supportBuffers })).toThrow(
      /detached borrowed formatter evidence/,
    );
    const literals = current.literals.map((row) => ({
      ...row,
      instruction: { ...row.instruction },
    }));
    expect(() => assertNativeNumberFormatRequirementsCurrent(input, { ...current, literals })).toThrow(
      /detached borrowed formatter evidence/,
    );
  });

  it("retains canonical alias metadata and rejects detached metadata rows", () => {
    const original = actual();
    const initial = deriveNativeNumberFormatRequirements({
      program: original,
      projection: original.runtime[0]!,
      integerBeforeScratch: false,
    })!;
    const allocation = initial.literals[0]!.allocation;
    const registry = AllocSiteRegistry.fromSnapshot(original.allocations);
    const site = registry.resolve(allocation)!;
    const canonical = registry.fresh(site.kind, site.type, site.origin);
    registry.alias(allocation, canonical);
    const program = { ...original, allocations: registry.snapshot() };
    assertPreparedIrProgram(program);
    const input = { program, projection: program.runtime[0]!, integerBeforeScratch: false };
    const requirements = deriveNativeNumberFormatRequirements(input)!;
    const literal = requirements.literals[0]!;
    expect(literal.allocation).toBe(allocation);
    expect(literal.canonicalAllocation).toBe(canonical);
    expect(canonical).not.toBe(allocation);
    const metadata = program.allocations.metadata.find((row) => row.id === canonical)!;
    const originalMetadata = original.allocations.metadata.find((row) => row.id === allocation)!;
    expect(originalMetadata).toBeDefined();
    expect(originalMetadata.entries.length).toBeGreaterThan(0);
    expect(metadata.entries).toEqual(originalMetadata.entries);
    expect(literal.metadataRow.present).toBe(true);
    if (!literal.metadataRow.present) throw new Error("missing positive metadata row");
    expect(literal.metadataRow.value).toBe(metadata);
    expect(() => assertNativeNumberFormatRequirementsCurrent(input, requirements)).not.toThrow();
    const literals = requirements.literals.map((row, index) =>
      index === 0
        ? {
            ...row,
            metadataRow: { present: true as const, value: { ...metadata } },
          }
        : row,
    );
    expect(() => assertNativeNumberFormatRequirementsCurrent(input, { ...requirements, literals })).toThrow(
      /detached borrowed formatter evidence/,
    );
  });

  it("keeps genuine no-demand programs free of formatter requirements", () => {
    const program = requireProgram(
      prepareWholeIrProgram({
        ...sourceInput({ "./entry.ts": "export function main(): number { return 7; }" }),
        policy,
      }),
    );
    assertPreparedIrProgram(program);
    expect(program.runtimeSupport).toBeUndefined();
    expect(
      deriveNativeNumberFormatRequirements({ program, projection: program.runtime[0]!, integerBeforeScratch: false }),
    ).toBeUndefined();
  });

  it("retains an explicit physical formatter option without adding a no-demand default", () => {
    const program = requireProgram(
      prepareWholeIrProgram({
        ...sourceInput({ "./entry.ts": "export function main(): number { return 7; }" }),
        policy,
      }),
    );
    const options = {
      backend: "wasmgc",
      target: "standalone",
      sharedExceptionTag: false,
      utf8Storage: false,
      sourceMap: false,
      moduleName: "formatter-option-control",
    } as const;
    const original = acceptPreparedIrProgram(program, options);
    expect(original.kind).toBe("accepted");
    if (original.kind !== "accepted") throw new Error(original.detail);
    expect(Object.hasOwn(original.options, "numberFormat")).toBe(false);
    for (const integerBeforeScratch of [false, true]) {
      const numberFormat = { integerBeforeScratch };
      const accepted = acceptPreparedIrProgram(program, { ...options, numberFormat });
      expect(accepted.kind).toBe("accepted");
      if (accepted.kind !== "accepted") throw new Error(accepted.detail);
      expect(accepted.options.numberFormat).toEqual(numberFormat);
      expect(accepted.options.numberFormat).not.toBe(numberFormat);
      expect(Object.isFrozen(accepted.options.numberFormat)).toBe(true);
      Reflect.set(numberFormat, "unexpected", true);
      expect(() => acceptPreparedIrProgram(program, { ...options, numberFormat })).toThrow(/one resolved boolean/);
    }
  });
});
