// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5911 / #6440 — selected Promise realm integration controls.
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { buildImports } from "../src/runtime.js";
import { normalizeSandboxValue } from "../src/runtime/wasm-struct-host-semantics.js";

function realmWithoutTry(): Record<string, any> {
  const sandbox = Object.create(null) as Record<string, any>;
  const context = createContext(sandbox);
  sandbox.Promise = runInContext("Promise", context);
  sandbox.Promise.try = undefined;
  return sandbox;
}

describe("#6440 — Promise.try selected compatibility realm", () => {
  it("installs on injected deps.Promise without touching sandbox or ambient Promise", async () => {
    const sandbox = realmWithoutTry();
    const injected = realmWithoutTry().Promise;
    const before = Object.getOwnPropertyDescriptor(Promise, "try");
    buildImports([], { Promise: injected }, undefined, { globalSandbox: sandbox });
    expect(typeof injected.try).toBe("function");
    expect(sandbox.Promise.try).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(Promise, "try")).toEqual(before);
    const promise = injected.try((value: number) => value + 1, 6);
    expect(promise).toBeInstanceOf(injected);
    expect(await promise).toBe(7);
  });

  it("installs on the sandbox Promise while leaving ambient Promise unchanged", async () => {
    const sandbox = realmWithoutTry();
    const before = Object.getOwnPropertyDescriptor(Promise, "try");
    buildImports([], undefined, undefined, { globalSandbox: sandbox });
    expect(typeof sandbox.Promise.try).toBe("function");
    expect(Object.getOwnPropertyDescriptor(Promise, "try")).toEqual(before);
    const promise = sandbox.Promise.try(() => 11);
    expect(promise).toBeInstanceOf(sandbox.Promise);
    expect(await promise).toBe(11);
  });

  it("retains the snapshotted intrinsic after the live sandbox Promise binding changes", () => {
    const sandbox = realmWithoutTry();
    const intrinsic = sandbox.Promise;
    buildImports([], undefined, undefined, { globalSandbox: sandbox });
    const replacement = realmWithoutTry().Promise;
    sandbox.Promise = replacement;
    expect(normalizeSandboxValue({}, Promise, "constructor", sandbox, undefined, (value) => value)).toBe(intrinsic);
    expect(typeof intrinsic.try).toBe("function");
    expect(replacement.try).toBeUndefined();
    expect(sandbox.Promise).toBe(replacement);
  });

  it("does not install Promise.try when ambient compatibility is disabled", () => {
    const sandbox = realmWithoutTry();
    const injected = realmWithoutTry().Promise;
    const before = Object.getOwnPropertyDescriptor(Promise, "try");
    buildImports([], { Promise: injected }, undefined, { globalSandbox: sandbox, ambientCompatibility: false });
    expect(injected.try).toBeUndefined();
    expect(sandbox.Promise.try).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(Promise, "try")).toEqual(before);
  });
});
