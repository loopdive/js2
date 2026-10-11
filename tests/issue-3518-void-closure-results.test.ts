// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptedPhysicalSetupPlan } from "../src/ir/program-consumer.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayOptions, replayProgram } from "./helpers/ir-whole-program-replay.js";

function oracle(text: string): unknown {
  const exports: { run?: () => unknown } = {};
  runInNewContext(
    ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    { exports },
    { timeout: 1000 },
  );
  if (!exports.run) throw new Error("exact void-closure source lacks run");
  return exports.run();
}

function prepare(text: string) {
  return prepareWholeIrProgram({
    ...sourceInput({ "./entry.ts": text }),
    policy: {
      target: "standalone",
      backend: "wasmgc",
      numberBoundary: { box: "native", unbox: "native" },
    },
  });
}

beforeEach(() => vi.stubEnv("JS2WASM_IR_GVN", "0"));
afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

describe("void annotations do not erase actual JavaScript return values", () => {
  it.each([
    {
      label: "explicit void function",
      value: 7,
      source: `export function run(): number {
        const f = function (): void { return 7 as any; };
        return f.call(null) as unknown as number;
      }`,
    },
    {
      label: "explicit void arrow",
      value: 9,
      source: `export function run(): number {
        const f = (): void => { return 9 as any; };
        return f.call(null) as unknown as number;
      }`,
    },
    {
      label: "descriptor getter with void result",
      value: 7,
      source: `export function run(): number {
        const object = { get value(): void { return 7 as any; } };
        return object.value as unknown as number;
      }`,
    },
    {
      label: "void method within an ordinary descriptor literal",
      value: 9,
      source: `export function run(): number {
        const object = {
          get marker() { return 1; },
          value(): void { return 9 as any; }
        };
        return object.value() as unknown as number;
      }`,
    },
  ])("refuses $label until its actual returned value has a carrier", ({ source, value }) => {
    expect(oracle(source)).toBe(value);
    const result = prepare(source);
    expect(result.kind, JSON.stringify(result)).toBe("unsupported");
    if (result.kind === "prepared") throw new Error("value-bearing void closure was silently admitted");
    expect(result).toMatchObject({ kind: "unsupported", code: "body-shape-rejected", stage: "build" });
    expect(result.detail).toMatch(/void closure.*value-bearing return.*returned-value representation/);
    expect(result.sourceFile).toBe("entry.ts");
    expect(result.unitId).toBeTruthy();
    expect(result.location.line).toBeGreaterThan(0);
  });
});

describe("actual undefined results through native invocation", () => {
  const literals = [
    { label: "empty function", literal: "function (): void {}" },
    { label: "empty arrow", literal: "(): void => {}" },
    { label: "bare-return function", literal: "function (): void { return; }" },
    { label: "bare-return arrow", literal: "(): void => { return; }" },
    {
      label: "nested numeric return belongs to its own function",
      literal: "function (): void { const nested = function (): number { return 9; }; return; }",
    },
  ];
  for (const decoded of [false, true]) {
    it.each(literals)(`preserves $label, decoded=${decoded}`, async ({ literal }) => {
      // The second real closure observes Undefined through the native default
      // parameter protocol. Null, a boxed NaN or a numeric value cannot select
      // this default, and the numeric control below exercises that distinction.
      const text = `export function run(): number {
        const empty = ${literal};
        const observe = function (value: number = 73): number { return value; };
        return observe.call(null, empty.call(null));
      }`;
      expect(oracle(text)).toBe(73);
      const original = requireProgram(prepare(text));
      const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
      const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
      expect(outcome.kind).toBe("ran");
      if (outcome.kind !== "ran") throw new Error(JSON.stringify(outcome.failure));
      expect(outcome.run.emitted.module.imports).toEqual([]);
      expect(acceptedPhysicalSetupPlan(outcome.run.accepted).nativeInvocation?.methodArities).toEqual([0, 1]);
      const run = outcome.run.exports.run as () => number;
      expect(run()).toBe(oracle(text));
      expect(run()).toBe(73);
    });

    it(`does not replace a real numeric return with the default, decoded=${decoded}`, async () => {
      const text = `export function run(): number {
        const value = function (): number { return 9; };
        const observe = function (value: number = 73): number { return value; };
        return observe.call(null, value.call(null));
      }`;
      expect(oracle(text)).toBe(9);
      const original = requireProgram(prepare(text));
      const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
      const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
      expect(outcome.kind).toBe("ran");
      if (outcome.kind !== "ran") throw new Error(JSON.stringify(outcome.failure));
      expect(outcome.run.emitted.module.imports).toEqual([]);
      expect(acceptedPhysicalSetupPlan(outcome.run.accepted).nativeInvocation?.methodArities).toEqual([0, 1]);
      expect((outcome.run.exports.run as () => number)()).toBe(oracle(text));
    });
  }
});
