// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import {
  prepareNativeSourceClosureInput,
  beginNativeSourceClosureEmission,
} from "../src/ir/program-native-invocation.js";
import { planNativePromiseResources, planNativeVectorResources } from "../src/ir/program-physical-plan.js";
import { reserveNativeVectorTypes } from "../src/backend/wasmgc/resources/native-vectors.js";
import { requireNativeSourceClosureTypes } from "../src/backend/wasmgc/resources/native-source-closures.js";
import {
  reserveNativePromiseResources,
  declareNativePromiseResources,
  nativePromiseReservationInventory,
} from "../src/backend/wasmgc/resources/native-promises.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";

const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
const options = {
  ...policy,
  utf8Storage: false,
  sharedExceptionTag: false,
  sourceMap: false,
  moduleName: "promise-closures",
};
const configuration = { hooks: "disabled", unhandledRejections: "disabled" } as const;
const sync = `export function plain(n: number): number { const fn = (x: number): number => x + 1; return fn(n); }`;
function prepare(text: string, replay: boolean) {
  const program = requireProgram(prepareWholeIrProgram({ ...sourceInput({ "./entry.ts": text }), policy }));
  return replay ? decodePreparedIrProgram(encodePreparedIrProgram(program)) : program;
}

describe("one source/Promise closure reservation owner", () => {
  for (const mixed of [false, true])
    for (const awaitValue of [false, true])
      for (const replay of [false, true])
        it(`joins actual async demand to the same root, mixed=${mixed}, await=${awaitValue}, replay=${replay}`, () => {
          const program = prepare(
            `${mixed ? sync : ""} export async function run(seed: number): Promise<number> { return ${awaitValue ? "await " : ""}seed; }`,
            replay,
          );
          const projection = program.runtime[0]!;
          const requirements = prepareNativeSourceClosureInput(program, projection);
          expect(requirements?.promiseClosures).toBeDefined();
          if (!requirements?.promiseClosures) throw Error("missing actual Promise closure demand");
          expect(requirements.gaps).toEqual([]);
          expect(requirements.units).toHaveLength(mixed ? 1 : 0);
          expect(requirements.signatures).toHaveLength(mixed ? 1 : 0);
          expect(requirements.shapes).toHaveLength(mixed ? 1 : 0);
          const module = createEmptyModule();
          const tx = new PhysicalModuleReservations(module);
          const vectorPlan = planNativeVectorResources(program, options, projection);
          const vectors = reserveNativeVectorTypes(tx, vectorPlan);
          const source = beginNativeSourceClosureEmission(tx, requirements, { vectors, vectorPlan });
          expect(requireNativeSourceClosureTypes(tx, source.types, requirements)).toBe(source.types);
          const closures = source.types.closures;
          const metadata = closures.metadata.find((row) => row.id === requirements.promiseClosures!.metadataId)!;
          expect(metadata.binding.metadata).toMatchObject({ key: "promise:settle", name: "", length: 1 });
          expect(metadata.binding.signature.liftedSelfTypeIndex).toBe(closures.root.typeIndex);
          expect(closures.signatures).toHaveLength(mixed ? 2 : 1);
          expect(closures.root).toBe(closures.signatures[0]!.binding.type);
          const exceptionTag = tx.reserveTag(
            "exception",
            { params: [{ kind: "externref" }], results: [] },
            { kind: "defined", name: "__exn" },
          );
          const plan = planNativePromiseResources(program, options, projection, configuration);
          const declaration = declareNativePromiseResources(plan, {
            argumentArrayKey: vectors.layouts.find((row) => row.element === "externref")!.array.key,
            closureRootKey: closures.root.key,
            settleMetadataKey: metadata.binding.type.key,
          });
          const promise = reserveNativePromiseResources(
            tx,
            plan,
            {
              vectors,
              exceptionTag,
              closures,
              settleMetadataRequestId: requirements.promiseClosures.metadataId,
            },
            declaration,
          );
          expect(promise.types.settleCapture.object).toMatchObject({ superTypeIdx: metadata.binding.type.typeIndex });
          expect(promise.functions.resolveClosure.object.typeIdx).toBe(metadata.binding.signature.liftedFuncTypeIndex);
          expect(promise.functions.rejectClosure.object.typeIdx).toBe(metadata.binding.signature.liftedFuncTypeIndex);
          expect(nativePromiseReservationInventory(tx, promise, declaration)).toContain(promise.types.settleCapture);
          expect(() => beginNativeSourceClosureEmission(tx, { ...requirements }, { vectors, vectorPlan })).toThrow(
            "unissued or detached requirements",
          );
          const accepted = acceptPreparedIrProgram(program, options);
          expect(accepted.kind).toBe("unsupported");
          if (accepted.kind === "unsupported") expect(accepted.detail).toContain("native Promise inventory");
        });
  it("keeps synchronous closure requests and the no-closure absence unchanged", () => {
    const program = prepare(sync, false);
    const requirements = prepareNativeSourceClosureInput(program, program.runtime[0]!)!;
    expect(requirements.promiseClosures).toBeUndefined();
    expect(requirements.signatures).toHaveLength(1);
    const scalar = prepare("export function run(n: number): number { return n; }", false);
    expect(prepareNativeSourceClosureInput(scalar, scalar.runtime[0]!)).toBeUndefined();
  });
});
