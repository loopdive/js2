// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect } from "vitest";

/** Real shared Get and IsCallable; native getter controls observe receiver, count and abrupt identity. */
export function checkCommonPromiseLookup(api: Record<string, any>, then: unknown, text: unknown) {
  const undefinedValue = api.undefinedValue();
  const primitives = [
    undefinedValue,
    null,
    api.box(1),
    api.boxBoolean(0),
    api.boxBoolean(1),
    api.boxBigInt(7n),
    api.hasInstance(),
    text,
  ];
  api.state.value = 0;
  for (const primitive of primitives) {
    const [callable, captured] = api.lookupThen(primitive);
    expect(callable).toBe(0);
    expect(api.isUndefined(captured)).toBe(1);
  }
  api.state.value = 2;
  const parent = api.object(null),
    object = api.object(parent),
    method = api.makeEmpty();
  expect(api.lookupThen(object)).toEqual([0, undefinedValue]);
  api.property(parent, then, method, 7);
  const captured = api.lookupThen(object);
  expect(captured[0]).toBe(1);
  expect(Object.is(captured[1], method)).toBe(true);
  api.property(parent, then, api.box(3), 7);
  expect(captured[1]).toBe(method);
  expect(api.lookupThen(object)[0]).toBe(0);
  api.property(parent, then, api.native3.value, 8);
  api.getterMode.value = 1;
  api.trace.value = 0;
  const receiverResult = api.lookupThen(object);
  expect(receiverResult[0]).toBe(0);
  expect(Object.is(receiverResult[1], object)).toBe(true);
  expect(api.trace.value).toBe(3);
  expect(api.argc.value).toBe(0);
  api.property(parent, then, api.native2.value, 8);
  api.trace.value = 0;
  try {
    api.lookupThen(object);
    throw Error("missing then getter throw");
  } catch (error) {
    expect(error).toBeInstanceOf(WebAssembly.Exception);
    expect((error as WebAssembly.Exception).getArg(api.exception, 0)).toBe(object);
  }
  expect(api.trace.value).toBe(2);
  api.getterMode.value = 0;
  // Source property metadata and unknown object families remain explicit gaps.
  for (const unsupported of [method, api.foreignClone(method), {}])
    expect(() => api.lookupThen(unsupported)).toThrow(WebAssembly.RuntimeError);
}
