// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeEach, afterEach, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { fullRealmFixture, joinFullRealm } from "./helpers/native-full-realm-call.js";
import {
  nativePromiseObjectBinding,
  reserveNativePromiseObjects,
  fillNativePromiseObjects,
} from "../src/backend/wasmgc/resources/native-promise-objects.js";
import { bindNativeMixedObjectPromises } from "../src/backend/wasmgc/resources/native-mixed-object-access.js";
import {
  promiseRealmRuntime as runtime,
  promiseRealmSource as source,
} from "./helpers/native-promise-realm-execution.js";
async function drain() {
  await setImmediate();
  await setImmediate();
}
beforeEach(drain);
afterEach(drain);

it("authenticates the shared Promise/realm producer before allocating slots", () => {
  const r = fullRealmFixture(false, source),
    { tx } = r;
  const pack = r.promiseObjects!;
  const before = r.f.module.functions.length;
  expect(() => nativePromiseObjectBinding(tx, { ...pack })).toThrow(/foreign or copied/);
  expect(() => reserveNativePromiseObjects(tx, "copied", { ...r.population.pack }, r.promise!.association)).toThrow(
    /foreign or copied/,
  );
  expect(() => reserveNativePromiseObjects(tx, "copied", r.population.pack, { ...r.promise!.association })).toThrow(
    /foreign|copied/,
  );
  expect(() => reserveNativePromiseObjects(tx, "duplicate", r.population.pack, r.promise!.association)).toThrow(
    /already has/,
  );
  expect(r.f.module.functions.length).toBe(before);
  expect(nativePromiseObjectBinding(tx, pack).promise).toBe(r.promise!.resources.types.promise);
  expect(() => bindNativeMixedObjectPromises(tx, r.access, { ...pack })).toThrow(/foreign or copied/);
  joinFullRealm(r);
  expect(() => bindNativeMixedObjectPromises(tx, r.access, pack)).toThrow(/duplicate/);
  expect(() => fillNativePromiseObjects(tx, pack)).toThrow(/invalid phase/);
}, 240000);

function expectAccess(actual: [number, unknown], value: unknown, detail: string) {
  expect(actual[0], detail + " status").toBe(1);
  expect(Object.is(actual[1], value), detail + " identity").toBe(true);
}
for (const displaced of [false, true])
  it(`creates real Promise property storage and inherits through common Get, displaced=${displaced}`, async () => {
    const api = await runtime(displaced);
    expect(api.realmState.value).toBe(0);
    const result = api.run(17.25);
    expect(api.state(result)).toBe(0);
    expectAccess(api.getPrototypeOf(result), api.prototype.value, "result prototype");
    expectAccess(api.get(result, api["key:then"].value, result), api.then.value, "result then");
    const adapter = api.awaitAdapter.value;
    expect(adapter).not.toBeNull();
    expect(adapter !== result, "separate await adapter").toBe(true);
    expect(api.handled(adapter)).toBe(1);
    expect(api.bag(adapter) !== api.bag(result), "separate await adapter storage").toBe(true);
    expectAccess(api.getPrototypeOf(adapter), api.prototype.value, "await adapter prototype");
    api.drain();
    expect(api.state(result)).toBe(1);
    expect(api.unbox(api.value(result))).toBe(17.25);
    const p = api.create(0),
      q = api.create(1),
      receiver = { actualReceiver: true };
    expect(api.realmState.value).toBe(2);
    expect(api.state(p)).toBe(0);
    expect(api.handled(p)).toBe(0);
    expect(api.handled(q)).toBe(1);
    expect(api.bag(p) !== api.bag(q), "fresh allocation storage").toBe(true);
    expectAccess(api.getPrototypeOf(p), api.prototype.value, "created Promise prototype");
    expectAccess(api.get(p, api["key:then"].value, receiver), api.then.value, "inherited then");
    expectAccess(
      api.get(p, api["key:constructor"].value, receiver),
      (api["constructor"] as WebAssembly.Global).value,
      "inherited constructor",
    );
    const key = api["key:missingPromiseProperty"].value;
    expect(api.get(p, key, receiver)[0]).toBe(0);
    api.property(p, key, api.undefined.value);
    expectAccess(api.get(p, key, receiver), api.undefined.value, "own undefined");
    api.getter(q, key, api.makeEmpty());
    expect(api.unbox(api.get(q, key, receiver)[1])).toBe(7);
    const parent = api.ordinary(api.prototype.value, 0);
    expect(api.setPrototypeOf(p, parent)).toBe(1);
    expectAccess(api.getPrototypeOf(p), parent, "changed prototype");
    expect(api.setPrototypeOf(parent, p)).toBe(0);
    api.nonExtensible(p);
    expect(api.setPrototypeOf(p, api.prototype.value)).toBe(0);
    const originalBag = api.bag(q);
    api.setBag(q, null);
    expect(api.getPrototypeOf(q)[0]).toBe(2);
    api.setBag(q, receiver);
    expect(api.getPrototypeOf(q)[0]).toBe(3);
    api.setBag(q, api.ordinary(api.prototype.value, 1));
    expect(api.getPrototypeOf(q)[0]).toBe(3);
    api.setBag(q, originalBag);
    api.realmState.value = 1;
    expect(api.getPrototypeOf(q)[0]).toBe(2);
    expect(() => api.create(0)).toThrow();
    api.realmState.value = 2;
    expectAccess(api.getPrototypeOf(q), api.prototype.value, "restored prototype");
  }, 900000);
