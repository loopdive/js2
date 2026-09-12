// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";
import { compile, type IrObservedOutcome } from "../src/index.js";

const previousIrFirst = process.env.JS2WASM_IR_FIRST;

afterEach(() => {
  if (previousIrFirst === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_FIRST");
  else process.env.JS2WASM_IR_FIRST = previousIrFirst;
});

function generatorOutcome(outcomes: readonly IrObservedOutcome[] | undefined): IrObservedOutcome {
  const outcome = outcomes?.find(({ unitKind, displayName }) => unitKind === "function" && displayName === "values");
  if (!outcome) throw new Error("missing prepared generator outcome");
  return outcome;
}

describe("#5199 prepared generator admission", () => {
  it("prepares an ordinary string-yield generator without an invalid __strlit_0 heap type", async () => {
    process.env.JS2WASM_IR_FIRST = "1";
    const result = await compile(
      `
        export function* values(): Generator<string> {
          yield "prepared";
          return "complete";
        }
      `,
      {
        fileName: "issue-5199-generator-prepared-admission.ts",
        experimentalIR: true,
        emitWat: true,
        nativeStrings: true,
        target: "gc",
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped).toContain("values");
    expect(generatorOutcome(result.irOutcomes)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(result.wat).toContain("__strlit_0");
    expect(() => new WebAssembly.Module(result.binary!)).not.toThrow();
  });
});
