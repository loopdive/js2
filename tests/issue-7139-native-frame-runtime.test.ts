// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createNativePromiseShape } from "../src/runtime/wasmgc/promise/promise-layout.js";
import { emitBinary } from "../src/emit/binary.js";
import { nativePreparedFrameKernel } from "./helpers/native-prepared-frame-kernel.js";

async function kernel() {
  const h = nativePreparedFrameKernel();
  h.publish();
  const compiled = await WebAssembly.compile(Uint8Array.from(emitBinary(h.module)).buffer);
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(compiled, {});
  return exports as Record<string, CallableFunction>;
}

describe("native frame with the canonical Promise carrier and real scheduler", () => {
  it("constructs a pending Promise, queues a plain value and retains identity", async () => {
    const e = await kernel();
    const value = { id: 1 };
    const first = e.run!(value),
      second = e.run!(23);
    expect(first === second).toBe(false);
    expect(e.state!(first)).toBe(0);
    expect(e.handled!(first)).toBe(0);
    e.drain!();
    expect(e.state!(first)).toBe(1);
    expect(e.value!(first)).toBe(value);
    expect(e.value!(second)).toBe(23);
  });
  it("grows the scheduler queue and delivers every frame independently", async () => {
    const e = await kernel();
    const results = Array.from({ length: 12 }, (_, index) => e.run!(index));
    expect(new Set(results).size).toBe(12);
    expect(results.map((result) => e.state!(result))).toEqual(Array(12).fill(0));
    e.drain!();
    expect(results.map((result) => e.state!(result))).toEqual(Array(12).fill(1));
    expect(results.map((result) => e.value!(result))).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });
  it.each(["missing", "type", "immutable"])("rejects a %s Promise field before frame publication", (defect) => {
    const shape = createNativePromiseShape();
    if (defect === "missing") shape.fields.pop();
    else if (defect === "type") shape.fields[4]!.type = { kind: "externref" };
    else shape.fields[4]!.mutable = false;
    const h = nativePreparedFrameKernel(shape);
    const before = structuredClone(h.resources.entry.target.body);
    expect(() => h.publish()).toThrow("wrong native Promise layout");
    expect(h.resources.entry.target.body).toEqual(before);
  });
  it.each([false, true])("delivers settled native Promises asynchronously, rejected=%s", async (rejected) => {
    const e = await kernel();
    const input = e.pending!();
    const value = { reason: rejected };
    e[rejected ? "reject" : "fulfill"]!(input, value);
    const result = e.run!(input);
    expect(e.handled!(input)).toBe(1);
    expect(e.state!(result)).toBe(0);
    e.drain!();
    expect(e.state!(result)).toBe(rejected ? 2 : 1);
    expect(e.value!(result)).toBe(value);
  });
  it.each([false, true])("registers a reaction on pending native Promises, rejected=%s", async (rejected) => {
    const e = await kernel();
    const input = e.pending!();
    const result = e.run!(input);
    expect(e.handled!(input)).toBe(1);
    e.drain!();
    expect(e.state!(result)).toBe(0);
    e[rejected ? "reject" : "fulfill"]!(input, 42);
    expect(e.state!(result)).toBe(0);
    e.drain!();
    expect(e.state!(result)).toBe(rejected ? 2 : 1);
    expect(e.value!(result)).toBe(42);
  });
});
