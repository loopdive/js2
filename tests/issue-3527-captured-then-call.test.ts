// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { emitBinary } from "../src/emit/binary.js";
import { buildThenableJobCall } from "../src/runtime/wasmgc/promise/thenable-job-call-body.js";
import type { PromiseThenableJobResources } from "../src/runtime/wasmgc/promise/resolution-bodies.js";

it("calls the captured method once with the original receiver and argument vector", () => {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const ext = { kind: "externref" } as const;
  const caps = tx.reserveType("caps", {
    kind: "struct",
    name: "Caps",
    fields: [{ name: "method", type: ext, mutable: false }],
  });
  const apply = tx.reserveFunctionImport("apply", "control", "apply", { params: [ext, ext, ext], results: [ext] });
  const create = tx.reserveFunction("create", "create", { params: [ext], results: [ext] });
  const call = tx.reserveFunction("call", "call", { params: [ext, ext, ext], results: [ext] });
  tx.freezeReservations();
  tx.fillFunction(create, {
    locals: [],
    body: [{ op: "local.get", index: 0 }, { op: "struct.new", typeIdx: caps.typeIndex }, { op: "extern.convert_any" }],
  });
  const resources = {
    invocationMode: "captured",
    capsTypeIdx: caps.typeIndex,
    capsFields: { callback: 0 },
    applyClosureIdx: apply.handle,
  } as PromiseThenableJobResources;
  tx.fillFunction(call, { locals: [], body: buildThenableJobCall(resources, 2) });
  tx.defineExport("create-export", "create", create);
  tx.defineExport("call-export", "call", call);
  tx.seal();
  const seen: unknown[][] = [],
    result = {};
  const control = {
    apply(...args: unknown[]) {
      seen.push(args);
      return result;
    },
  };
  const api = new WebAssembly.Instance(new WebAssembly.Module(emitBinary(module) as BufferSource), { control }).exports;
  const method = {},
    receiver = { then: "must not be read again" },
    args: unknown[] = [];
  const captured = (api.create as CallableFunction)(method);
  expect((api.call as CallableFunction)(captured, receiver, args)).toBe(result);
  expect(seen).toHaveLength(1);
  expect(seen[0]![0]).toBe(method);
  expect(seen[0]![1]).toBe(receiver);
  expect(seen[0]![2]).toBe(args);
});

it("requires the fallback Call binding only for the default invocation mode", () => {
  expect(() => buildThenableJobCall({} as PromiseThenableJobResources, 2)).toThrow(/default invocation requires/);
  expect(() => buildThenableJobCall({ invocationMode: "captured" } as PromiseThenableJobResources, 2)).toThrow(
    /shared Call binding/,
  );
  const accessor = Object.defineProperty({}, "invocationMode", {
    enumerable: true,
    get() {
      throw Error("evaluated");
    },
  });
  expect(() => buildThenableJobCall(accessor as PromiseThenableJobResources, 2)).toThrow(
    /explicit captured invocation/,
  );
});
