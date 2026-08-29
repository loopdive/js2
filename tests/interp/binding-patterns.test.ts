// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { beforeAll, describe, expect, it } from "vitest";
import { executeIndirectEval } from "../../src/interp/index.js";
import { loadAcorn, parse } from "./harness.js";

beforeAll(async () => {
  await loadAcorn();
});

const parser = (source: string): unknown => parse(source);

describe("runtime-eval declaration binding patterns", () => {
  it("binds the Deno op-table shorthand used by runtime scripts", () => {
    const globalObject = Object.create(globalThis);
    globalObject.Deno = { core: { ops: { op_test: 42 } } };
    expect(executeIndirectEval(parser, "const { op_test } = Deno.core.ops; op_test;", globalObject)).toBe(42);
  });

  it("retains destructured ops and helper declarations across classic-script invocations", () => {
    const globalObject = Object.create(globalThis);
    globalObject.Deno = { core: { ops: { op_test: 42 } } };
    executeIndirectEval(
      parser,
      "const { op_test } = Deno.core.ops; function assert(value) { if (!value) throw new Error('assert'); }",
      globalObject,
    );
    expect(executeIndirectEval(parser, "assert(op_test === 42); op_test", globalObject)).toBe(42);
  });

  it("evaluates the initializer once and binds aliases, defaults, and nesting in order", () => {
    const globalObject = Object.create(globalThis);
    expect(
      executeIndirectEval(
        parser,
        `
          var reads = 0;
          var source = { first: 1, nested: { value: 41 } };
          const { first: one, missing = 1, nested: { value } } = (reads++, source);
          reads * (one + missing + value);
        `,
        globalObject,
      ),
    ).toBe(43);
  });

  it("supports computed keys and array elisions in declaration patterns", () => {
    const globalObject = Object.create(globalThis);
    expect(
      executeIndirectEval(
        parser,
        `
          var key = "answer";
          const { [key]: answer } = { answer: 40 };
          const [, tail = 2] = [0, undefined];
          answer + tail;
        `,
        globalObject,
      ),
    ).toBe(42);
  });

  it("forwards every argument across an external callable boundary", () => {
    const globalObject = Object.create(globalThis);
    globalObject.add4 = (a: number, b: number, c: number, d: number) => a + b + c + d;
    expect(executeIndirectEval(parser, "add4(1, 2, 3, 36)", globalObject)).toBe(42);
  });
});
