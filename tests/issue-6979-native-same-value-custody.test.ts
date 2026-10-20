// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { objectIsFixture, objectIsRuntime } from "./helpers/native-object-is-fixture.js";
import { fillDescriptorDependencies } from "./helpers/native-descriptor-fixture.js";
import {
  requireNativeObjectSameValueReservations,
  requireCompletedNativeObjectSameValue,
} from "../src/backend/wasmgc/resources/native-object-same-value.js";
import { fillNativeObjectDescriptorResources } from "../src/backend/wasmgc/resources/native-object-descriptors.js";
import { fillNativeObjectIsAlgorithm } from "../src/backend/wasmgc/resources/native-object-is.js";
import { fillNativeInvocationSubstrateResources } from "../src/backend/wasmgc/resources/native-invocation-substrate.js";
import { fillNativeBooleanBoxResources } from "../src/backend/wasmgc/resources/native-booleans.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  reachableFunctionPositions,
  stubUnreachableFunctions,
  stubsReachedAfterFinalize,
} from "../src/codegen/function-reachability-sweep.js";

describe("executed native SameValue dependency custody", () => {
  for (const decoded of [false, true])
    for (const result of [0, 1])
      for (const consumer of ["same-value", "descriptors", "object-is"] as const)
        it(`refuses a receipt-valid alternate algorithm decoded=${decoded} result=${result} consumer=${consumer}`, () => {
          const f = objectIsFixture(decoded, decoded, decoded ? "allocating" : "interned");
          const fill = f.tx.fillFunction.bind(f.tx);
          let changed = 0;
          f.tx.fillFunction = (token, definition) => {
            if (token === f.sameValue.sameValue) {
              changed++;
              fill(token, { locals: [], body: [{ op: "i32.const", value: result }] });
            } else fill(token, definition);
          };
          f.tx.freezeReservations();
          fillDescriptorDependencies(f);
          fillNativeInvocationSubstrateResources(f.tx, f.substrate);
          fillNativeBooleanBoxResources(f.tx, f.booleanBoxes);
          f.tx.defineExport("custody:same-value", "sameValue", f.sameValue.sameValue);
          f.tx.defineExport("custody:box-number", "boxNumber", f.values.functions.boxNumber);
          expect(changed).toBe(1);
          // The generic ledger truthfully receipts what was filled; that is not
          // independent semantic authority for Object.is or descriptor equality.
          expect(() => f.tx.assertCompletedReservation(f.sameValue.sameValue)).not.toThrow();
          expect(
            requireNativeObjectSameValueReservations(f.tx, f.sameValue, f.sameValueDependencies) === f.sameValue,
          ).toBe(true);

          // Execute the actual receipt-valid alternate body in a clone-only
          // observer, never fill missing production obligations or seal its owner.
          const live = reachableFunctionPositions(f.module);
          const names = f.module.functions.filter((_, i) => live[i]).map((fn) => fn.name);
          expect(names).toContain(f.sameValue.sameValue.object.name);
          expect(names).toContain(f.values.functions.boxNumber.object.name);
          expect(names.length).toBeGreaterThanOrEqual(2);
          const snapshot = structuredClone(f.module);
          expect(stubUnreachableFunctions(snapshot, live)).toBeGreaterThan(0);
          expect(stubsReachedAfterFinalize(snapshot)).toEqual([]);
          const bytes = emitBinary(snapshot);
          const wasm = new WebAssembly.Module(bytes as BufferSource);
          expect(WebAssembly.Module.imports(wasm)).toEqual([]);
          const api = new WebAssembly.Instance(wasm).exports as {
            sameValue: (a: unknown, b: unknown) => number;
            boxNumber: (n: number) => unknown;
          };
          const a = api.boxNumber(42),
            b = api.boxNumber(result === 0 ? 42 : 43);
          expect(api.sameValue(a, b)).toBe(result);
          expect(Number(Object.is(42, result === 0 ? 42 : 43))).not.toBe(result);

          // A canonical mismatch terminally fails its ledger. Give each real
          // consumer an independent fixture, not a second call on a poisoned tx.
          const consume =
            consumer === "same-value"
              ? () => requireCompletedNativeObjectSameValue(f.tx, f.sameValue, f.sameValueDependencies)
              : consumer === "descriptors"
                ? () => fillNativeObjectDescriptorResources(f.tx, f.pack, f.exception)
                : () => fillNativeObjectIsAlgorithm(f.tx, f.objectIs);
          expect(consume).toThrow(/noncanonical function definition/);
          expect(f.pack.defineData.object.body).toEqual([]);
          expect(f.objectIs.algorithm.object.body).toEqual([]);
          expect(f.tx.state).toBe("failed");
        });

  it("preserves real numeric and identity execution through the genuine Object.is consumer", () => {
    const r = objectIsRuntime(true, true, "allocating");
    expect(r.imports).toEqual([]);
    expect(r.test([r.ex.boxNumber!(NaN), r.ex.boxNumber!(NaN)])).toBe(1);
    expect(r.test([r.ex.boxNumber!(0), r.ex.boxNumber!(-0)])).toBe(0);
    expect(r.test([r.ex.boxNumber!(42), r.ex.boxNumber!(42)])).toBe(1);
    expect(r.test([r.ex.boxNumber!(42), r.ex.boxNumber!(43)])).toBe(0);
    const object = r.ex.createNull!();
    expect(r.test([object, object])).toBe(1);
    expect(r.test([object, r.ex.createNull!()])).toBe(0);
    expect(r.test([])).toBe(1);
    requireCompletedNativeObjectSameValue(r.f.tx, r.f.sameValue, r.f.sameValueDependencies);
  });
});
