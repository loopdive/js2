// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import {
  encodePreparedIrProgram,
  decodePreparedIrProgram,
  reauthenticatePreparedIrProgram,
} from "../src/ir/program-codec.js";
import { assertIrRuntimeSupport, irRuntimeSupportOccurrences } from "../src/ir/program/runtime-support.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";

function actual() {
  const text = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
  return requireProgram(
    prepareWholeIrProgram({
      ...sourceInput({ "./entry.ts": text }),
      policy: {
        backend: "wasmgc",
        target: "standalone",
        stringConst: { storage: "native" },
        stringConcat: { concat: "native" },
      },
      promiseDelayProjection: "standalone-native",
      asyncFamilyProjection: "standalone-native",
    }),
  );
}

describe("formatter support in the actual prepared-program codec", () => {
  it("round-trips a nonempty built body and re-encodes exact canonical bytes", () => {
    const original = actual();
    expect(original.runtimeSupport?.batches).toHaveLength(1);
    const encoded = encodePreparedIrProgram(original);
    const decoded = decodePreparedIrProgram(encoded);
    expect(encodePreparedIrProgram(decoded)).toBe(encoded);
    expect(decoded.runtimeSupport).toEqual(original.runtimeSupport);
    assertIrRuntimeSupport(decoded, decoded.runtimeSupport);
    const batch = decoded.runtimeSupport!.batches[0]!;
    expect(irRuntimeSupportOccurrences(batch.implementation.body)).toEqual({
      calls: batch.calls,
      literals: batch.literals,
    });
    expect(batch.calls.length).toBeGreaterThan(0);
    expect(batch.literals.length).toBeGreaterThan(0);
    for (const literal of batch.literals) {
      expect(decoded.allocations.entries[literal.alloc]).toEqual(original.allocations.entries[literal.alloc]);
    }
  });

  it("refuses stripped support even when its own demand vector vanishes", () => {
    const original = actual();
    expect(original.runtimeSupport!.batches[0]!.demandOwners.length).toBeGreaterThan(0);
    const { runtimeSupport: _removed, ...stripped } = original;
    expect(() => reauthenticatePreparedIrProgram(stripped)).toThrow(/missing demanded formatter support/);
  });

  it("refuses changed literal occurrence receipts on real otherwise intact input", () => {
    const original = actual();
    const support = original.runtimeSupport!;
    const batch = support.batches[0]!;
    expect(batch.literals.length).toBeGreaterThan(0);
    const mutated = {
      ...original,
      runtimeSupport: {
        ...support,
        batches: [
          {
            ...batch,
            literals: batch.literals.map((literal, index) => (index === 0 ? { ...literal, value: "forged" } : literal)),
          },
        ],
      },
    };
    expect(() => reauthenticatePreparedIrProgram(mutated)).toThrow(/stale support literal occurrences/);
  });

  it("rejects own-property undefined rather than silently dropping it in reconstruction", () => {
    const original = actual();
    expect(() => reauthenticatePreparedIrProgram({ ...original, runtimeSupport: undefined })).toThrow();
  });

  it("rejects a canonical kernel used as a literal materializer", () => {
    const original = actual();
    // Positive first through the complete replay validator, not a fabricated ABI.
    expect(reauthenticatePreparedIrProgram(original).runtimeSupport?.batches).toHaveLength(1);
    const support = original.runtimeSupport!,
      batch = support.batches[0]!;
    const body = structuredClone(batch.implementation.body);
    const occurrence = batch.literals[0]!;
    expect(occurrence).toBeDefined();
    let instruction: unknown = body;
    for (const key of occurrence.path) instruction = (instruction as Record<string | number, unknown>)[key];
    expect(instruction).toMatchObject({ kind: "string.const", value: occurrence.value });
    // The reference is real and present in the ABI, but invalid for this field.
    Reflect.set(instruction as object, "materializer", batch.kernels[0].ref);
    const changed = {
      ...original,
      runtimeSupport: { ...support, batches: [{ ...batch, implementation: { ...batch.implementation, body } }] },
    };
    expect(() => assertPreparedIrProgram(changed)).toThrow(
      /support literals cannot carry physical storage or materializer attachments/,
    );
    expect(() => reauthenticatePreparedIrProgram(changed)).toThrow(
      /support literals cannot carry physical storage or materializer attachments/,
    );
  });
});
