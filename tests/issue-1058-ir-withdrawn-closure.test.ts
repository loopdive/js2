// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it, vi } from "vitest";
import { compile } from "../src/index.js";

// Exercise the failed-owner transaction independently of a source compiler
// bug. Declared object order now converges correctly; intentionally report
// a different (valid) lowered function signature for this late owner only.
// Its body must never be committed, and its lifted artifacts must withdraw.
vi.mock("../src/ir/lower.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/lower.js")>();
  return {
    ...actual,
    lowerIrFunctionToWasm: (...args: Parameters<typeof actual.lowerIrFunctionToWasm>) => {
      const result = actual.lowerIrFunctionToWasm(...args);
      if (args[0].name === "make") {
        result.func.typeIdx = args[1].internFuncType({ kind: "func", params: [], results: [] });
      }
      return result;
    },
  };
});

it.each([false, true])(
  "keeps a valid module when a late IR owner with a named closure withdraws (IR=%s)",
  async (experimentalIR) => {
    const result = await compile(
      `
    function make(offset: number): { z: number; a: number } {
      function add(value: number): number { return offset + value; }
      return { z: add(1), a: 2 };
    }
    export function run(): number {
      const object = make(2);
      return object.z + object.a;
    }
  `,
      { target: "standalone", experimentalIR, trackIrOutcomes: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(
      (new WebAssembly.Instance(module, {}).exports.run as () => number)(),
      JSON.stringify(result.irOutcomes),
    ).toBe(5);
    if (experimentalIR) {
      for (const name of ["make", "run"]) {
        expect(
          result.irOutcomes?.find((row) => row.displayName === name),
          JSON.stringify(result.irOutcomes),
        ).toMatchObject({
          code: "abi-signature-parity",
          legacyBodyEmitted: true,
          irBodyEmitted: false,
        });
      }
    }
  },
);
