// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { promiseRealmRuntime } from "./helpers/native-promise-realm-execution.js";

it("resolves actual source async frames and source then methods through common native Get and Call", async () => {
  const api = await promiseRealmRuntime(false, true);
  const result = api.run(17.25);
  expect(api.state(result)).toBe(0);
  api.drain();
  expect(api.state(result)).toBe(1);
  expect(api.unbox(api.value(result))).toBe(17.25);

  const method = api.makeThen(42),
    object = api.ordinary(api.objectPrototype.value, 0);
  const then = api["key:then"].value;
  // Ordinary storage control takes a Promise bag; use an actual Promise with an own then override.
  const thenable = api.create(0),
    pending = api.create(0);
  api.property(thenable, then, method);
  api.resolve(pending, thenable);
  expect(api.state(pending)).toBe(0);
  api.property(thenable, then, api.makeThen(99));
  api.drain();
  expect(api.state(pending)).toBe(1);
  expect(api.unbox(api.value(pending))).toBe(42);

  const plain = api.create(0);
  api.resolve(plain, object);
  expect(api.state(plain)).toBe(1);
  expect(Object.is(api.value(plain), object)).toBe(true);
  const self = api.create(0);
  api.resolve(self, self);
  expect(api.state(self)).toBe(2);
}, 1800000);
