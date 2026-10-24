// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { emitBinary } from "../src/emit/binary.js";
import { nativePreparedFrameKernel } from "./helpers/native-prepared-frame-kernel.js";
import { emitPreparedFrame } from "../src/runtime/wasmgc/async/prepared-async-frame-engine.js";
async function kernel(completion: "await" | "return") {
  const h = nativePreparedFrameKernel(undefined, undefined, completion);
  h.publish();
  const module = await WebAssembly.compile(Uint8Array.from(emitBinary(h.module)).buffer);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  return (await WebAssembly.instantiate(module, {})).exports as Record<string, CallableFunction>;
}
for (const completion of ["await", "return"] as const)
  describe(`native frame PromiseResolve at ${completion}`, () => {
    it("runs the actual then method as a job and assimilates its result", async () => {
      const e = await kernel(completion),
        value = { id: 42 },
        thenable = e.thenable!(value, 0),
        result = e.run!(thenable);
      expect(e.state!(result)).toBe(0);
      expect(e.thenCalls!()).toBe(0);
      e.drain!();
      expect(e.thenCalls!()).toBe(1);
      expect(e.state!(result)).toBe(1);
      expect(e.value!(result)).toBe(value);
    });
    it("orders adoption and frame continuation relative to an unrelated queued job", async () => {
      const e = await kernel(completion),
        result = e.run!(e.thenable!(42, 0));
      e.observe!(result);
      expect(e.observedState!()).toBe(-1);
      e.drain!();
      // The thenable job settles a return directly; await schedules its continuation
      // behind the observer that was already in the same native queue.
      expect(e.observedState!()).toBe(completion === "await" ? 0 : 1);
      expect(e.state!(result)).toBe(1);
      expect(e.value!(result)).toBe(42);
    });
    it.each([1, 3])("propagates rejection/abrupt then completion, mode=%s", async (mode) => {
      const e = await kernel(completion),
        reason = { mode },
        result = e.run!(e.thenable!(reason, mode));
      e.drain!();
      expect(e.thenCalls!()).toBe(1);
      expect(e.state!(result)).toBe(2);
      expect(e.value!(result)).toBe(reason);
    });
    it("rejects a throwing then getter with the exact reason", async () => {
      const e = await kernel(completion),
        reason = { getter: true },
        result = e.run!(e.poisoned!(reason));
      e.drain!();
      expect(e.thenCalls!()).toBe(0);
      expect(e.getterCalls!()).toBe(1);
      expect(e.state!(result)).toBe(2);
      expect(e.value!(result)).toBe(reason);
    });
    it.each([2, 4])("locks resolving pairs before pending adoption, mode=%s", async (mode) => {
      const e = await kernel(completion),
        pending = e.pending!(),
        result = e.run!(e.thenable!(pending, mode));
      e.drain!();
      expect(e.thenCalls!()).toBe(1);
      expect(e.state!(result)).toBe(0);
      e.fulfill!(pending, 42);
      e.drain!();
      expect(e.state!(result)).toBe(1);
      expect(e.value!(result)).toBe(42);
    });
    it("adopts nested thenables", async () => {
      const e = await kernel(completion),
        inner = e.thenable!(42, 0),
        result = e.run!(e.thenable!(inner, 0));
      e.drain!();
      expect(e.thenCalls!()).toBe(2);
      expect(e.state!(result)).toBe(1);
      expect(e.value!(result)).toBe(42);
    });
    it.each([false, true])("adopts a pending native Promise, rejected=%s", async (rejected) => {
      const e = await kernel(completion),
        pending = e.pending!(),
        result = e.run!(pending),
        value = { rejected };
      expect(e.state!(result)).toBe(0);
      e.drain!();
      expect(e.state!(result)).toBe(0);
      e[rejected ? "reject" : "fulfill"]!(pending, value);
      e.drain!();
      expect(e.state!(result)).toBe(rejected ? 2 : 1);
      expect(e.value!(result)).toBe(value);
    });
  });
it("rejects indirect self-resolution after adopting a pending return value", async () => {
  const e = await kernel("return"),
    pending = e.pending!(),
    result = e.run!(pending);
  e.fulfill!(pending, result);
  e.drain!();
  expect(e.state!(result)).toBe(2);
  expect(e.isTypeError!(e.value!(result))).toBe(1);
});
it("rejects missing resolution before frame publication", () => {
  const h = nativePreparedFrameKernel();
  const runtime = h.resources.runtime;
  if (runtime.kind !== "native") throw Error("native fixture required");
  const before = structuredClone(h.resources.entry.target.body);
  expect(() =>
    emitPreparedFrame(h.plan, { ...h.resources, runtime: { ...runtime, resolveValue: undefined } as never }),
  ).toThrow("requires PromiseResolve");
  expect(h.resources.entry.target.body).toEqual(before);
});

it("rejects missing Promise allocation before frame publication", () => {
  const h = nativePreparedFrameKernel();
  const runtime = h.resources.runtime;
  if (runtime.kind !== "native") throw Error("native fixture required");
  const before = structuredClone(h.resources.entry.target.body);
  expect(() =>
    emitPreparedFrame(h.plan, {
      ...h.resources,
      runtime: { ...runtime, create: undefined } as never,
    }),
  ).toThrow("requires Promise object allocation");
  expect(h.resources.entry.target.body).toEqual(before);
});
