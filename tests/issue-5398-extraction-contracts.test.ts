// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import type { ts } from "../src/ts-api.js";
import "../src/codegen/expressions.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { createEmptyModule } from "../src/ir/types.js";
import { addGeneratorImports, addGeneratorCompletionImport } from "../src/codegen/registry/generator-imports.js";
import { addGeneratorImports as compatibilityRegistration } from "../src/codegen/registry/imports.js";
import { mintDefinedFunc, pushDefinedFunc, funcSignatureOf } from "../src/codegen/func-space.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import {
  createEagerGeneratorBuffer,
  appendEagerGeneratorValue,
  drainSynchronousGeneratorDelegation,
  EAGER_GENERATOR_LIMIT,
} from "../src/runtime/generator-buffer.js";

describe("#5398 extracted implementation contracts", () => {
  it("creates independent buffers and enforces the shared append cap", () => {
    const first = createEagerGeneratorBuffer();
    const second = createEagerGeneratorBuffer();
    appendEagerGeneratorValue(first, 1);
    expect(first).toEqual([1]);
    expect(second).toEqual([]);
    const full = new Array(EAGER_GENERATOR_LIMIT);
    expect(() => appendEagerGeneratorValue(full, 2)).toThrow(RangeError);
    expect(full.length).toBe(EAGER_GENERATOR_LIMIT);
  });
  it("reads a yielded value before the cap and never buffers terminal completion", () => {
    const order: string[] = [];
    const iterable = {
      [Symbol.iterator]: () => ({
        next: () => ({
          done: false,
          get value() {
            order.push("value");
            return 2;
          },
        }),
      }),
    };
    expect(() => drainSynchronousGeneratorDelegation(new Array(EAGER_GENERATOR_LIMIT), iterable)).toThrow(RangeError);
    expect(order).toEqual(["value"]);
    const terminal = { done: true };
    const buffer: unknown[] = [];
    expect(
      drainSynchronousGeneratorDelegation(buffer, {
        *[Symbol.iterator]() {
          yield 1;
          return terminal;
        },
      }),
    ).toBe(terminal);
    expect(buffer).toEqual([1]);
  });
  it("preserves import ordering, old void ABI, idempotence and late-only completion", () => {
    expect(compatibilityRegistration).toBe(addGeneratorImports);
    const ctx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker, {});
    const signature = addFuncType(ctx, [], [{ kind: "f64" }]);
    const existing = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, existing, {
      name: "existing",
      typeIdx: signature,
      locals: [],
      body: [{ op: "f64.const", value: 7 }],
      exported: false,
    });
    ctx.funcMap.set("existing", existing);
    addGeneratorImports(ctx);
    const names = ctx.mod.imports.map((entry) => entry.name);
    expect(names).toEqual([
      "__gen_create_buffer",
      "__gen_push_f64",
      "__gen_push_i32",
      "__gen_push_ref",
      "__gen_yield_star",
      "__gen_set_return",
      "__create_generator",
      "__create_async_generator",
      "__gen_next",
      "__gen_return",
      "__gen_throw",
      "__gen_result_value",
      "__gen_result_value_f64",
      "__gen_result_done",
      "__get_caught_exception",
    ]);
    expect(ctx.funcMap.has("__gen_yield_star_result")).toBe(false);
    const before = ctx.numImportFuncs;
    addGeneratorImports(ctx);
    expect(ctx.numImportFuncs).toBe(before);
    expect(funcSignatureOf(ctx, ctx.funcMap.get("__gen_yield_star")!)).toMatchObject({
      params: [{ kind: "externref" }, { kind: "externref" }],
      results: [],
    });
    addGeneratorCompletionImport(ctx);
    expect(ctx.numImportFuncs).toBe(before + 1);
    expect(funcSignatureOf(ctx, ctx.funcMap.get("__gen_yield_star_result")!)).toMatchObject({
      params: [{ kind: "externref" }, { kind: "externref" }],
      results: [{ kind: "externref" }],
    });
    expect(funcSignatureOf(ctx, ctx.funcMap.get("existing")!)).toMatchObject({
      params: [],
      results: [{ kind: "f64" }],
    });
    addGeneratorCompletionImport(ctx);
    expect(ctx.numImportFuncs).toBe(before + 1);
  });
  it.each(["standalone", "wasi"] as const)("keeps %s generator imports opt-in", (target) => {
    const ctx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker, { target });
    addGeneratorImports(ctx);
    expect(ctx.mod.imports).toEqual([]);
    addGeneratorImports(ctx, { allowNoJsHost: true });
    expect(ctx.funcMap.has("__gen_create_buffer")).toBe(true);
    expect(ctx.funcMap.has("__gen_yield_star_result")).toBe(false);
  });
});
