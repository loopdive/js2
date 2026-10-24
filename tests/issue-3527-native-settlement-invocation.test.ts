// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { sourceSubstrateBase } from "./helpers/native-invocation-substrate.js";
import { prepareGetterProgram } from "./helpers/native-getter-invocation-fixture.js";
import { planNativePromiseResources } from "../src/ir/program-native-async-resources.js";
import {
  bindPreparedNativePromiseInvocation,
  bindNativeSourceClosureUnits,
  nativeSourceClosureCallableBindings,
} from "../src/ir/program-native-invocation.js";
import {
  declareNativePromiseResources,
  reserveNativePromiseResources,
} from "../src/backend/wasmgc/resources/native-promises.js";
import { requireNativePromiseInvocation } from "../src/backend/wasmgc/resources/native-promise-invocation.js";
import {
  reserveNativeInvocationResources,
  nativeInvocationFunctions,
  fillNativeInvocationResources,
  requireCompletedNativeInvocation,
} from "../src/backend/wasmgc/resources/native-invocation.js";

import { fillNativeStringLiteralResources } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { fillNativeStringFlattenResources } from "../src/backend/wasmgc/resources/native-string-flatten.js";
import { fillNativeStringNumberResources } from "../src/backend/wasmgc/resources/native-string-number.js";
import { fillNativeValueResources } from "../src/backend/wasmgc/resources/native-values.js";
import { fillNativeInvocationSubstrateResources } from "../src/backend/wasmgc/resources/native-invocation-substrate.js";

const options = {
  backend: "wasmgc",
  target: "standalone",
  utf8Storage: false,
  sharedExceptionTag: false,
  sourceMap: false,
  moduleName: "settlement",
} as const;
const configuration = { hooks: "disabled", unhandledRejections: "disabled" } as const;
function fixture(replay = false, borrowed = true) {
  const program = prepareGetterProgram(
    "export async function run(seed: number): Promise<number> { return await seed; }",
    replay,
  );
  const f = sourceSubstrateBase(program, borrowed, true);
  const exception = f.tx.reserveTag(
    "settlement:exception",
    { params: [{ kind: "externref" }], results: [] },
    { kind: "defined", name: "__exn" },
  );
  const plan = planNativePromiseResources(program, options, f.projection, configuration);
  const closures = f.sourceOwner.types.closures;
  const metadataId = f.source.promiseClosures!.metadataId;
  const metadata = closures.metadata.find((row) => row.id === metadataId)!.binding;
  const declaration = declareNativePromiseResources(plan, {
    argumentArrayKey: f.vectors.layouts.find((row) => row.element === "externref")!.array.key,
    closureRootKey: closures.root.key,
    settleMetadataKey: metadata.type.key,
  });
  const promise = reserveNativePromiseResources(
    f.tx,
    plan,
    { vectors: f.vectors, exceptionTag: exception, closures, settleMetadataRequestId: metadataId },
    declaration,
  );
  const association = bindPreparedNativePromiseInvocation(
    f.tx,
    f.sourceOwner,
    promise,
    declaration,
    options,
    configuration,
  );
  return { ...f, exception, plan, declaration, promise, association };
}
describe("actual Promise settlement callable association", () => {
  for (const replay of [false, true])
    for (const borrowed of [false, true])
      it(`selects Promise-only invocation and reserves the shared ArgumentVector entry, replay=${replay}, borrowed=${borrowed}`, () => {
        const f = fixture(replay, borrowed);
        expect(f.source.units).toEqual([]);
        expect(f.invocation.uses).toEqual([]);
        expect(f.invocation.gaps).toEqual([]);
        const before = f.module.functions.length;
        expect(() => reserveNativeInvocationResources(f.tx, f.invocation, f.dependencies)).toThrow(
          "exact producer association",
        );
        expect(f.module.functions).toHaveLength(before);
        const pack = reserveNativeInvocationResources(f.tx, f.invocation, {
          ...f.dependencies,
          promise: f.association,
        });
        const functions = nativeInvocationFunctions(f.tx, pack);
        expect(functions.filter((fn) => fn.object.name === "__apply_closure_arguments")).toHaveLength(1);
        const binding = requireNativePromiseInvocation(f.tx, f.association, f.sourceOwner.types);
        expect(binding.capture).toBe(f.promise.types.settleCapture);
        expect(binding.metadata.signature.liftedFuncTypeIndex).toBe(f.promise.functions.resolveClosure.object.typeIdx);
        expect(binding.metadata.signature.liftedFuncTypeIndex).toBe(f.promise.functions.rejectClosure.object.typeIdx);
        f.tx.freezeReservations();
        bindNativeSourceClosureUnits(f.tx, f.sourceOwner, new Map());
        const callables = nativeSourceClosureCallableBindings(f.tx, f.sourceOwner, f.invocation);
        fillNativeStringLiteralResources(f.tx, f.strings);
        fillNativeStringFlattenResources(f.tx, f.flatten);
        fillNativeStringNumberResources(f.tx, f.scanner);
        fillNativeValueResources(f.tx, f.values, f.valueDependencies);
        if (f.substrate) fillNativeInvocationSubstrateResources(f.tx, f.substrate);
        fillNativeInvocationResources(f.tx, pack, callables, f.exception);
        const entry = functions.find((fn) => fn.object.name === "__apply_closure_arguments")!;
        expect(() => f.tx.assertCompletedReservation(entry)).not.toThrow();
        expect(() => requireCompletedNativeInvocation(f.tx, pack)).toThrow("incomplete canonical Promise bodies");
        expect(() => requireNativePromiseInvocation(f.tx, f.association, f.sourceOwner.types, true)).toThrow(
          "incomplete canonical Promise bodies",
        );
        expect(f.module.imports).toEqual([]);
      });
  it("rejects an occupied runtime entry before reserving invocation resources", () => {
    const f = fixture();
    f.tx.reserveFunction(`${f.invocation.key}:apply-arguments`, "occupied", { params: [], results: [] });
    const before = [f.module.types.length, f.module.functions.length, f.module.globals.length];
    expect(() =>
      reserveNativeInvocationResources(f.tx, f.invocation, { ...f.dependencies, promise: f.association }),
    ).toThrow();
    expect([f.module.types.length, f.module.functions.length, f.module.globals.length]).toEqual(before);
  });
  it("rejects a different same-ledger exception tag before filling invocation bodies", () => {
    const f = fixture();
    const wrong = f.tx.reserveTag(
      "settlement:wrong-exception",
      { params: [{ kind: "externref" }], results: [] },
      { kind: "defined", name: "wrong" },
    );
    const pack = reserveNativeInvocationResources(f.tx, f.invocation, { ...f.dependencies, promise: f.association });
    f.tx.freezeReservations();
    bindNativeSourceClosureUnits(f.tx, f.sourceOwner, new Map());
    const callables = nativeSourceClosureCallableBindings(f.tx, f.sourceOwner, f.invocation);
    expect(() => fillNativeInvocationResources(f.tx, pack, callables, wrong)).toThrow("different exception tags");
    expect(() => f.tx.assertCompletedReservation(pack.undefinedValue)).toThrow();
  });
  it("rejects copied or foreign association, wrong plans and changed canonical function signatures", () => {
    const f = fixture(),
      other = fixture();
    expect(() => requireNativePromiseInvocation(f.tx, { ...f.association }, f.sourceOwner.types)).toThrow("copied");
    expect(() => requireNativePromiseInvocation(other.tx, f.association, other.sourceOwner.types)).toThrow("foreign");
    expect(() => requireNativePromiseInvocation(f.tx, f.association, other.sourceOwner.types)).toThrow("substituted");
    expect(() =>
      bindPreparedNativePromiseInvocation(f.tx, f.sourceOwner, { ...f.promise }, f.declaration, options, configuration),
    ).toThrow("foreign");
    expect(() =>
      bindPreparedNativePromiseInvocation(f.tx, f.sourceOwner, f.promise, { ...f.declaration }, options, configuration),
    ).toThrow("substituted");
    expect(() =>
      bindPreparedNativePromiseInvocation(f.tx, f.sourceOwner, f.promise, f.declaration, options, {
        ...configuration,
        hooks: "dispatch",
      }),
    ).toThrow("source requirements differ");
    f.promise.functions.resolveClosure.object.typeIdx = f.promise.functions.drain.object.typeIdx;
    expect(() => requireNativePromiseInvocation(f.tx, f.association, f.sourceOwner.types)).toThrow(
      "altered function descriptor",
    );
    expect(f.tx.state).toBe("failed");
  });
});
