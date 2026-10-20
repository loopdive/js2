// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import {
  collectNativeStringValueDemands,
  type NativeStringValueBufferRoot,
} from "../src/ir/program/native-string-value-demands.js";
import {
  deriveNativeObjectAccessRequirements,
  assertNativeObjectAccessRequirementsCurrent,
} from "../src/ir/program/native-object-access-requirements.js";
import type { IrInstr } from "../src/ir/core/nodes.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { requireProgram, sourceInput } from "./helpers/typed-program-fixtures.js";

let original: PreparedIrProgram, encoded: string;
beforeAll(async () => {
  vi.stubEnv("JS2WASM_IR_GVN", "0");
  const source = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
  original = requireProgram(
    prepareWholeIrProgram({
      ...sourceInput({ "./entry.ts": source }),
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
  encoded = encodePreparedIrProgram(original);
  vi.unstubAllEnvs();
  await setImmediate();
}, 120000);
afterEach(async () => {
  vi.unstubAllEnvs();
  await setImmediate();
});

function mutable() {
  // Independent copies retain both genuine representations, not a deduplicated
  // census or a caller-authored permission to emit a modified prepared program.
  return structuredClone(original);
}
function definitionBuffer(program: PreparedIrProgram, kind: NativeStringValueBufferRoot["kind"]) {
  const demands = collectNativeStringValueDemands(program, program.runtime[0]!);
  const buffer = demands.buffers.find(
    (row) => row.view === "projection" && row.root.kind === kind && row.instructions.some((i) => i.result !== null),
  );
  if (!buffer) throw Error("missing genuine definition region " + kind);
  return { demands, buffer, instruction: buffer.instructions.find((i) => i.result !== null)! };
}

describe("actual async object-demand SSA representation ownership", () => {
  it.each([false, true])("retains both real async representations without ambiguous SSA, decoded=%s", (decoded) => {
    const program = decoded ? decodePreparedIrProgram(encoded) : original,
      projection = program.runtime[0]!,
      demands = collectNativeStringValueDemands(program, projection);
    expect(program.ir.functions).toHaveLength(16);
    const twins = demands.occurrences.filter((row) => {
      const region = demands.buffers[row.bufferIndex]!;
      return (
        region.view === "projection" &&
        region.root.kind === "async-plan" &&
        row.instruction.result !== null &&
        demands.occurrences.some((other) => {
          const runtime = demands.buffers[other.bufferIndex]!;
          return (
            runtime.view === "projection" &&
            runtime.root.kind === "async-runtime" &&
            runtime.ownerUnitId === region.ownerUnitId &&
            other.instruction.result === row.instruction.result
          );
        })
      );
    });
    expect(twins.length).toBeGreaterThan(0);
    const access = deriveNativeObjectAccessRequirements(program, projection);
    expect(access.demands.buffers).toHaveLength(demands.buffers.length);
    expect(access.demands.occurrences).toHaveLength(demands.occurrences.length);
    expect(access.uses).toEqual([]);
    expect(access.getters).toEqual([]);
    assertNativeObjectAccessRequirementsCurrent(access);
  });

  it.each(["block", "async-plan", "async-runtime"] as const)(
    "still refuses duplicate definitions in one actual %s representation",
    (kind) => {
      const program = mutable(),
        { buffer, instruction } = definitionBuffer(program, kind);
      (buffer.instructions as IrInstr[]).push(structuredClone(instruction));
      expect(() => deriveNativeObjectAccessRequirements(program, program.runtime[0]!)).toThrow(
        "ambiguous prepared SSA definition",
      );
    },
  );

  it.each(["async-plan", "async-runtime"] as const)("does not grant each %s state its own SSA namespace", (kind) => {
    const program = mutable(),
      { demands, buffer, instruction } = definitionBuffer(program, kind),
      sibling = demands.buffers.find(
        (other) =>
          other.view === "projection" &&
          other.ownerUnitId === buffer.ownerUnitId &&
          other.root.kind === kind &&
          other.root.index !== buffer.root.index,
      );
    if (!sibling) throw Error("missing genuine second state");
    (sibling.instructions as IrInstr[]).push(structuredClone(instruction));
    expect(() => deriveNativeObjectAccessRequirements(program, program.runtime[0]!)).toThrow(
      "ambiguous prepared SSA definition",
    );
  });

  it("rechecks all borrowed async regions after issuing descriptive demands", () => {
    const program = mutable(),
      access = deriveNativeObjectAccessRequirements(program, program.runtime[0]!),
      { buffer, instruction } = definitionBuffer(program, "async-runtime");
    assertNativeObjectAccessRequirementsCurrent(access);
    (buffer.instructions as IrInstr[]).push(structuredClone(instruction));
    expect(() => assertNativeObjectAccessRequirementsCurrent(access)).toThrow("borrowed source changed");
  });
});
