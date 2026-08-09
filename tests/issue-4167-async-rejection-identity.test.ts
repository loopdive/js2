// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { ASYNC_CALLBACK_EXCEPTION_POLICY, ASYNC_HOST_ADAPTERS } from "../src/ir/async-runtime-providers.js";
import { buildImports } from "../src/runtime.js";
import { normalizeModuleCallbackException } from "../src/runtime/native-function-source.js";

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
}

async function instantiateHost(source: string, deps?: Record<string, any>) {
  const result = await compile(source, {
    fileName: "issue-4167-host.ts",
    target: "gc",
    emitWat: true,
    trackIrOutcomes: true,
  });
  expectSuccess(result);
  const imports = buildImports(result.imports, deps, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setInstance?.(instance);
  return { instance, result };
}

describe("#4167 async rejection payload identity", () => {
  it("makes module-tag payload extraction an explicit IR async.callback.wrap contract", async () => {
    const callbackAdapter = ASYNC_HOST_ADAPTERS.find((adapter) => adapter.capability === "async.callback.wrap");
    expect(callbackAdapter).toMatchObject({
      field: "__make_callback",
      exceptionPolicy: ASYNC_CALLBACK_EXCEPTION_POLICY,
    });

    const { result } = await instantiateHost(`
      function delay(ms: number, value: number): Promise<number> {
        return new Promise<number>((resolve) => {
          setTimeout(() => resolve(value), ms);
        });
      }

      export async function fetchUser(id: number): Promise<number> {
        const value = await delay(0, id * 10);
        return value;
      }
    `);
    expect(result.irFirstSkipped ?? []).toContain("fetchUser");
    expect((result.irOutcomes ?? []).find((outcome) => outcome.displayName === "fetchUser")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.imports.find((entry) => entry.name === callbackAdapter?.field)?.intent).toEqual({
      type: "callback_maker",
    });
  });

  it.each([
    ["Error", () => new Error("boom")],
    ["plain object", () => ({ marker: 4167 })],
    ["primitive", () => "primitive-4167"],
  ])("preserves the exact %s thrown from a compiled Promise reaction", async (_label, makeReason) => {
    const { instance } = await instantiateHost(`
      export function rejectFromReaction(reason: any): Promise<any> {
        return Promise.resolve(0).then(function() { throw reason; });
      }
    `);
    const reason = makeReason();
    const rejectFromReaction = instance.exports.rejectFromReaction as (value: any) => Promise<any>;
    await expect(rejectFromReaction(reason)).rejects.toBe(reason);
  });

  it("preserves an own-tag payload thrown from a compiled getter reaction", async () => {
    const { instance } = await instantiateHost(`
      export function rejectFromGetter(reason: any): Promise<any> {
        const thenable: any = {};
        Object.defineProperty(thenable, "then", { get: function() { throw reason; } });
        return Promise.resolve(thenable);
      }
    `);
    const reason = { getter: 4167 };
    const rejectFromGetter = instance.exports.rejectFromGetter as (value: any) => Promise<any>;
    await expect(rejectFromGetter(reason)).rejects.toBe(reason);
  });

  it("does not unwrap a foreign WebAssembly.Exception or a runtime trap", async () => {
    const foreignTag = new WebAssembly.Tag({ parameters: [] });
    const foreign = new WebAssembly.Exception(foreignTag, []);
    const trap = new WebAssembly.RuntimeError("foreign runtime trap");
    let thrown: unknown = foreign;
    const { instance } = await instantiateHost(
      `
        declare function throwFromHost(): never;
        export function rejectForeign(): Promise<any> {
          return Promise.resolve(0).then(function() { throwFromHost(); });
        }
      `,
      {
        throwFromHost: () => {
          throw thrown;
        },
      },
    );
    const rejectForeign = instance.exports.rejectForeign as () => Promise<any>;
    await expect(rejectForeign()).rejects.toBe(foreign);
    thrown = trap;
    await expect(rejectForeign()).rejects.toBe(trap);
  });

  it("keeps standalone Promise rejection payload identity on the native scheduler", async () => {
    const result = await compile(
      `
        let identity = false;
        const reason: any = { marker: 4167 };
        Promise.resolve(0)
          .then(function() { throw reason; })
          .catch(function(caught) { identity = caught === reason; });
        export function identityOk(): boolean { return identity; }
      `,
      {
        fileName: "issue-4167-standalone.ts",
        target: "standalone",
        deferTopLevelInit: true,
      },
    );
    expectSuccess(result);
    expect(result.imports).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports.__module_init as () => void)();
    (instance.exports.__drain_microtasks as () => void)();
    expect((instance.exports.identityOk as () => number)()).toBe(1);
  });

  it("normalizes only the exception carrying the installed module tag", () => {
    const tag = new WebAssembly.Tag({ parameters: ["externref"] });
    const payload = new Error("identity");
    const own = new WebAssembly.Exception(tag, [payload]);
    const foreignTag = new WebAssembly.Tag({ parameters: ["externref"] });
    const foreign = new WebAssembly.Exception(foreignTag, [payload]);
    const trap = new WebAssembly.RuntimeError("trap");
    const callbackState = { getExports: () => ({ __exn_tag: tag as unknown as Function }) };

    expect(normalizeModuleCallbackException(own, callbackState, ASYNC_CALLBACK_EXCEPTION_POLICY)).toBe(payload);
    expect(normalizeModuleCallbackException(foreign, callbackState, ASYNC_CALLBACK_EXCEPTION_POLICY)).toBe(foreign);
    expect(normalizeModuleCallbackException(trap, callbackState, ASYNC_CALLBACK_EXCEPTION_POLICY)).toBe(trap);
  });
});
