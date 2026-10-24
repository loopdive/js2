// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { emitBinary } from "../src/emit/binary.js";
import { buildMixedObjectScalarGetDefinition } from "../src/runtime/wasmgc/values/mixed-object-scalar-get-body.js";

// Explicit Get-status control only; production Get is exercised in the full-realm suite.
function runtime(status: number, value: unknown, abrupt = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const ext = { kind: "externref" } as const;
  const get = tx.reserveFunctionImport("get", "control", "get", {
    params: [ext, ext, ext],
    results: [{ kind: "i32" }, ext],
  });
  const scalar = tx.reserveFunction("scalar", "scalar", { params: [ext, ext, ext], results: [ext] });
  tx.freezeReservations();
  tx.fillFunction(scalar, buildMixedObjectScalarGetDefinition(get.handle));
  tx.defineExport("scalar-export", "scalar", scalar);
  tx.seal();
  const reads: unknown[][] = [];
  const api = new WebAssembly.Instance(new WebAssembly.Module(emitBinary(module) as BufferSource), {
    control: {
      get(...args: unknown[]) {
        reads.push(args);
        if (abrupt) throw value;
        return [status, value];
      },
    },
  }).exports;
  return { run: api.scalar as (target: unknown, key: unknown, receiver: unknown) => unknown, reads };
}
describe("mixed Get scalar boundary", () => {
  it.each([0, 1])("preserves the supplied language value and one original Get for status %i", (status) => {
    const value = {},
      target = {},
      key = {},
      receiver = {};
    const r = runtime(status, value);
    expect(r.run(target, key, receiver)).toBe(value);
    expect(r.reads).toEqual([[target, key, receiver]]);
  });
  it.each([-2, -1, 2, 3, 4, 2147483647])("keeps unsupported or corrupt status %i loud", (status) => {
    const r = runtime(status, null);
    expect(() => r.run({}, {}, {})).toThrow(WebAssembly.RuntimeError);
    expect(r.reads).toHaveLength(1);
  });
  it("propagates a getter's thrown identity", () => {
    const failure = {},
      r = runtime(0, failure, true);
    let thrown: unknown;
    try {
      r.run({}, {}, {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(r.reads).toHaveLength(1);
  });
});
