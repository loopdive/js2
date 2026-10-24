// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { prepareNativeProgramStringInput } from "../src/backend/wasmgc/program/native-realm.js";
import {
  reserveNativeStringValueResources,
  fillNativeStringValueResources,
  requireCompletedNativeStringValues,
} from "../src/backend/wasmgc/program/native-string-values.js";
import { reserveNativeStringLiteralTypes } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { planNativeVectorResources } from "../src/ir/program-physical-plan.js";
import { reserveNativeVectorTypes } from "../src/backend/wasmgc/resources/native-vectors.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { emitBinary } from "../src/emit/binary.js";

const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
function prepare(source: string, replay: boolean) {
  const program = requireProgram(prepareWholeIrProgram({ ...sourceInput({ "./entry.ts": source }), policy }));
  return replay ? decodePreparedIrProgram(encodePreparedIrProgram(program)) : program;
}

describe("native Promise dependencies from actual async source", () => {
  for (const body of ["return seed;", "return await seed;"])
    for (const utf8Storage of [false, true])
      for (const replay of [false, true])
        it(`fills shared values for ${body} utf8=${utf8Storage} replay=${replay}`, () => {
          const program = prepare(`export async function run(seed: number): Promise<number> { ${body} }`, replay);
          const input = prepareNativeProgramStringInput(program, program.runtime[0]!, { utf8Storage });
          expect(input).toBeDefined();
          if (!input || "kind" in input) throw Error("missing real native value producer");
          expect(input.demands.literals).toHaveLength(0);
          expect(input.valueRequirements).toBeDefined();
          expect(input.plan.literalRequirements.literals.map((row) => row.value)).toEqual(
            expect.arrayContaining(["", "then", "Chaining cycle detected for promise", "TypeError"]),
          );
          const vectorPlan = planNativeVectorResources(
            program,
            {
              ...policy,
              utf8Storage,
              sharedExceptionTag: false,
              sourceMap: false,
              moduleName: "async-values",
            },
            program.runtime[0]!,
          );
          expect(vectorPlan.layouts).toEqual(["externref"]);
          expect(vectorPlan.helper).toBeUndefined();
          expect(vectorPlan.demands.flatMap((owner) => owner.uses)).toHaveLength(0);
          expect(vectorPlan.exceptionRequired).toBe(true);
          const module = createEmptyModule();
          const tx = new PhysicalModuleReservations(module);
          const vectors = reserveNativeVectorTypes(tx, vectorPlan);
          const array = vectors.layouts[0]!.array;
          const capacity = tx.reserveFunction("probe:array", "array", { params: [], results: [{ kind: "i32" }] });
          const types = reserveNativeStringLiteralTypes(tx, input.plan.key, utf8Storage);
          const pack = reserveNativeStringValueResources(tx, input, types);
          if (!pack.number) throw Error("missing shared values");
          const values = pack.number.values;
          const tag = tx.reserveFunction("probe:tag", "tag", { params: [], results: [{ kind: "i32" }] });
          const roundtrip = tx.reserveFunction("probe:number", "number", {
            params: [{ kind: "f64" }],
            results: [{ kind: "f64" }],
          });
          tx.freezeReservations();
          fillNativeStringValueResources(tx, pack);
          tx.fillFunction(tag, {
            locals: [],
            body: [
              { op: "global.get", index: tx.physicalIndex(values.globals.undefined) },
              { op: "struct.get", typeIdx: tx.physicalIndex(values.types.anyValue), fieldIdx: 0 },
            ],
          });
          tx.fillFunction(roundtrip, {
            locals: [],
            body: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: tx.physicalIndex(values.functions.boxNumber) },
              { op: "call", funcIdx: tx.physicalIndex(values.functions.unboxNumber) },
            ],
          });
          tx.fillFunction(capacity, {
            locals: [],
            body: [
              { op: "i32.const", value: 3 },
              { op: "array.new_default", typeIdx: tx.physicalIndex(array) },
              { op: "array.len" },
            ],
          });
          tx.defineExport("export:array", "array", capacity);
          tx.defineExport("export:tag", "tag", tag);
          tx.defineExport("export:number", "number", roundtrip);
          tx.seal();
          requireCompletedNativeStringValues(tx, pack);
          const compiled = new WebAssembly.Module(Uint8Array.from(emitBinary(module)).buffer);
          expect(WebAssembly.Module.imports(compiled)).toEqual([]);
          const exports = new WebAssembly.Instance(compiled).exports;
          expect((exports.tag as () => number)()).toBe(1);
          expect((exports.array as () => number)()).toBe(3);
          for (const value of [0, -0, 42.5, NaN, Infinity, -Infinity, 2 ** 40])
            expect((exports.number as (n: number) => number)(value)).toBe(value);
          const accepted = acceptPreparedIrProgram(program, {
            ...policy,
            utf8Storage,
            sharedExceptionTag: false,
            sourceMap: false,
            moduleName: "async-values",
          });
          expect(accepted.kind).toBe("unsupported");
          if (accepted.kind !== "unsupported") throw Error("incomplete Promise group must stay rejected");
          expect(accepted.detail).not.toContain("native string/value producer input is unavailable");
          expect(accepted.detail).toContain("complete native Promise inventory composition has not been issued");
        });
  it("keeps synchronous scalar owners free of Promise-only resources", () => {
    const program = prepare("export function run(seed: number): number { return seed; }", false);
    expect(prepareNativeProgramStringInput(program, program.runtime[0]!, { utf8Storage: false })).toBeUndefined();
    expect(
      planNativeVectorResources(
        program,
        {
          ...policy,
          utf8Storage: false,
          sharedExceptionTag: false,
          sourceMap: false,
          moduleName: "scalar",
        },
        program.runtime[0]!,
      ).layouts,
    ).toEqual([]);
  });
});
