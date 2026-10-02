// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import * as legacy from "../src/codegen/promise-combinators.js";
import * as custom from "../src/codegen/promise-custom-combinator.js";

afterEach(() => vi.restoreAllMocks());

for (const customFirst of [false, true]) {
  it(`reuses the original capability runtime across real callers, customFirst=${customFirst}`, async () => {
    const records: { ctx: CodegenContext; route: string; cache: unknown }[] = [];
    const remember = (ctx: CodegenContext, route: string) => {
      const cache = (ctx as CodegenContext & { __promiseCustomCapability?: unknown }).__promiseCustomCapability;
      expect(cache).toBeDefined();
      records.push({ ctx, route, cache });
      expect(ctx.mod.functions.filter((fn) => fn.name === "__promise_custom_capability_executor")).toHaveLength(1);
      expect(
        ctx.mod.types.filter((type) => type.kind === "struct" && type.name === "$__promise_custom_capability"),
      ).toHaveLength(1);
    };
    const settle = legacy.emitStandalonePromiseCustomSettle;
    vi.spyOn(legacy, "emitStandalonePromiseCustomSettle").mockImplementation((...args) => {
      const result = settle(...args);
      if (result) remember(args[0], "legacy");
      return result;
    });
    const combinator = custom.tryEmitCustomCombinatorCall;
    vi.spyOn(custom, "tryEmitCustomCombinatorCall").mockImplementation((...args) => {
      const result = combinator(...args);
      if (result !== undefined) remember(args[0], "D1");
      return result;
    });
    const oldCall = "Promise.resolve.call(Capturing, 41);";
    const newCall = "Promise.all.call(Aggregating, [element]);";
    const result = await compile(
      `
export function test(): number {
  let scalar = 0;
  let aggregate = 0;
  let calls = 0;
  const Capturing = function(executor: any) {
    executor(function(v: any) { scalar = v; }, function() {});
  };
  const Aggregating = function(executor: any) {
    executor(function(v: any) { aggregate = v[0]; calls++; }, function() {});
  };
  Aggregating.resolve = function(v: any): any { return v; };
  const element: any = { then: function(ok: any) { ok(7); ok(99); } };
  ${customFirst ? newCall + oldCall : oldCall + newCall}
  return scalar * 100 + aggregate * 10 + calls;
}`,
      { fileName: "capability-order.ts", target: "standalone", nativeStrings: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.test as () => number)()).toBe(4171);
    expect(records.map((row) => row.route)).toEqual(customFirst ? ["D1", "legacy"] : ["legacy", "D1"]);
    expect(records[0].ctx).toBe(records[1].ctx);
    expect(records[0].cache).toBe(records[1].cache);
  });
}
