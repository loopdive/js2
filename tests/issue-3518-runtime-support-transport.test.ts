// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareNumberFormatRuntimeSupport } from "../src/frontend/builtins/prepare-number-format.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import {
  assertIrRuntimeSupport,
  irNumberFormatDemandOwners,
  irRuntimeSupportFunctions,
} from "../src/ir/program/runtime-support.js";
import { numberFormatRadixSupportDeclarations } from "../src/ir/program/formatter-support.js";
import { preparedIrTypeKey, preparedIrDataKey } from "../src/ir/program-abi-contracts.js";
import { assertPreparedIrRuntimeSupportDependencies } from "../src/ir/prepared-component-dependencies.js";
import { irSupportTypeRef } from "../src/ir/core/type-references.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";

const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
const original = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
const request = () => ({
  ...sourceInput({ "./entry.ts": original }),
  policy,
  promiseDelayProjection: "standalone-native" as const,
  asyncFamilyProjection: "standalone-native" as const,
});
const options = { ...typedOptions, policy, runtimePolicies: [policy] };

function packet() {
  const source = prepareIrProgramSources(request());
  if (source.kind !== "prepared") throw new Error(source.detail);
  const support = prepareNumberFormatRuntimeSupport(source, policy);
  expect(support?.batches).toHaveLength(1);
  const input = captureTypedIrProgramInput(source, support);
  assertIrRuntimeSupport(input, input.runtimeSupport);
  return input;
}

describe("real source-to-program formatter support transport", () => {
  it("keeps the actual support body separate from source and startup populations", () => {
    const input = packet();
    const support = input.runtimeSupport!;
    const batch = support.batches[0]!;
    expect(input.ir.functions).toHaveLength(5);
    expect(irNumberFormatDemandOwners(input.ir.functions)).toEqual(batch.demandOwners);
    expect(batch.demandOwners.length).toBeGreaterThan(0);
    expect(irRuntimeSupportFunctions(support)).toEqual([batch.implementation.body]);
    expect(input.ir.functions.some((fn) => fn.unitId === batch.implementation.body.unitId)).toBe(false);
    expect(input.derivedUnits.some((unit) => unit.id === batch.implementation.body.unitId)).toBe(false);
    expect(input.startup.some((plan) => plan.unitId === batch.implementation.body.unitId)).toBe(false);
    expect(batch.kernels.map((kernel) => kernel.role)).toEqual(["new", "get", "set", "fin", "trap"]);
    expect(batch.calls.length).toBeGreaterThan(0);
    expect(batch.literals.length).toBeGreaterThan(0);
    for (const literal of batch.literals) expect(input.allocations.entries[literal.alloc]?.state).toBe("live");
  });

  it("independently rejects deletion of the batch together with its claimed demand owners", () => {
    const input = packet();
    const { runtimeSupport: removed, ...missing } = input;
    expect(removed!.batches[0]!.demandOwners.length).toBeGreaterThan(0);
    expect(() => prepareTypedIrProgram(missing, options)).toThrow(/missing demanded formatter support/);
    expect(() =>
      prepareTypedIrProgram({ ...input, runtimeSupport: { schema: "ir-runtime-support-v1", batches: [] } }, options),
    ).toThrow();
  });

  it("rejects stale primary-owner receipts before recomputing transformed owners", () => {
    const input = packet();
    const support = input.runtimeSupport!;
    const changed = { ...support, batches: support.batches.map((batch) => ({ ...batch, demandOwners: [] })) };
    expect(() => prepareTypedIrProgram({ ...input, runtimeSupport: changed }, options)).toThrow(
      /stale primary demand owners/,
    );
  });

  it.each(["source", "kernel-order", "kernel-duplicate", "nullability", "storage-width", "literal-receipt"] as const)(
    "refuses altered support declarations after genuine source capture: %s",
    (mutation) => {
      const input = packet();
      const support = structuredClone(input.runtimeSupport!);
      const batch = support.batches[0]!;
      if (mutation === "source") Reflect.set(batch, "sourceId", batch.sourceId + ":foreign");
      if (mutation === "kernel-order") Reflect.set(batch, "kernels", [...batch.kernels].reverse());
      if (mutation === "kernel-duplicate")
        Reflect.set(batch, "kernels", [batch.kernels[0], batch.kernels[0], ...batch.kernels.slice(2)]);
      if (mutation === "nullability") Reflect.set(batch.scratch.type, "nullable", false);
      if (mutation === "storage-width") Reflect.set(batch.scratch.storage, "element", "i8");
      if (mutation === "literal-receipt") Reflect.set(batch, "literals", batch.literals.slice(1));
      expect(() => prepareTypedIrProgram({ ...input, runtimeSupport: support }, options)).toThrow();
    },
  );

  it("refuses a retired allocation still referenced by the real support body", () => {
    const input = packet();
    const id = input.runtimeSupport!.batches[0]!.literals[0]!.alloc;
    expect(input.allocations.entries[id]?.state).toBe("live");
    const allocations = {
      ...input.allocations,
      entries: input.allocations.entries.map((entry, index) => (index === id ? { state: "retired" as const } : entry)),
    };
    expect(() => assertIrRuntimeSupport({ ...input, allocations }, input.runtimeSupport)).toThrow(
      /support allocation is not live/,
    );
  });

  it.each(["off", "on"] as const)("carries real support through final preparation with GVN %s", (gvnMode) => {
    const input = packet();
    const program = requireProgram(
      prepareTypedIrProgram(input, {
        ...options,
        controls: { ...options.controls, gvnMode },
      }),
    );
    expect(program.ir.functions).toHaveLength(16);
    expect(program.runtimeSupport?.batches).toHaveLength(1);
    assertIrRuntimeSupport(program, program.runtimeSupport);
    expect(Object.isFrozen(program.runtimeSupport)).toBe(true);
    expect(Object.isFrozen(program.runtimeSupport!.batches[0]!.implementation.body)).toBe(true);
  });

  it("normalizes support identity without display-name dependence", () => {
    const input = packet();
    const type = numberFormatRadixSupportDeclarations(input.runtimeSupport!.batches[0]!.sourceId).scratch.type;
    const renamed = { ...type, ref: { ...type.ref, name: "diagnostic-only" } };
    expect(preparedIrTypeKey(renamed)).toBe(preparedIrTypeKey(type));
    expect(preparedIrDataKey({ nested: [renamed] })).toBe(preparedIrDataKey({ nested: [type] }));
    expect(preparedIrTypeKey({ ...type, nullable: false })).not.toBe(preparedIrTypeKey(type));
  });

  it("preserves absence for genuine no-demand source", () => {
    const program = requireProgram(
      prepareWholeIrProgram({
        ...sourceInput({ "./entry.ts": "export function main(): number { return 42; }" }),
        policy,
      }),
    );
    expect(Object.hasOwn(program, "runtimeSupport")).toBe(false);
    expect(irRuntimeSupportFunctions(program.runtimeSupport)).toEqual([]);
  });

  it.each(["missing-type", "missing-callable", "nested-reference", "physical-index"] as const)(
    "checks actual support dependency fields: %s",
    (mutation) => {
      const program = requireProgram(prepareTypedIrProgram(packet(), options));
      assertPreparedIrRuntimeSupportDependencies(program);
      const support = program.runtimeSupport!;
      const batch = support.batches[0]!;
      if (mutation === "missing-type" || mutation === "missing-callable") {
        const ref = mutation === "missing-type" ? batch.scratch.type.ref : batch.kernels[0].ref;
        if (ref.binding.kind !== "support") throw new Error("positive fixture lacks support binding");
        const id = ref.binding.bindingId;
        const entries = program.abi.entries.filter((entry) => entry.plan.id !== id);
        expect(entries).toHaveLength(program.abi.entries.length - 1);
        expect(() => assertPreparedIrRuntimeSupportDependencies({ ...program, abi: { entries } })).toThrow(
          /missing or duplicate symbolic dependency/,
        );
      } else {
        const foreign = irSupportTypeRef(batch.sourceId, "foreign", "foreign");
        const body = batch.implementation.body;
        const resultType =
          mutation === "nested-reference"
            ? { kind: "string" as const, carrierRef: foreign }
            : { kind: "string" as const, typeIdx: 0 };
        // Retain the original occurrence receipts: this assertion must inspect
        // the body/signature graph independently of those unchanged receipts.
        const changed = {
          ...batch,
          implementation: { ...batch.implementation, body: { ...body, resultTypes: [resultType] } },
        };
        expect(() =>
          assertPreparedIrRuntimeSupportDependencies({
            ...program,
            runtimeSupport: { ...support, batches: [changed] },
          }),
        ).toThrow(mutation === "nested-reference" ? /foreign symbolic dependency/ : /physical type index/);
      }
    },
  );
});
