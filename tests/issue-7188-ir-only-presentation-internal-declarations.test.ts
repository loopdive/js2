// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7188 S1 — the strict prepared presentation refused every function whose
// slots are not number/Boolean, including non-exported helpers that never cross
// a host boundary. Such a helper is now captured as an `internal` declaration;
// exported declarations keep the primitive host contract.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const options: Test262CompileOptions = {
  wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
  target: "gc",
  backend: "wasmgc",
  sourceMap: false,
  optimize: false,
  emitWat: false,
};

function forbidDirectGenerators(): void {
  for (const spy of [
    vi.spyOn(gc, "generateModule"),
    vi.spyOn(gc, "generateMultiModule"),
    vi.spyOn(linear, "generateLinearModule"),
    vi.spyOn(linear, "generateLinearMultiModule"),
  ])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
}
afterEach(() => vi.restoreAllMocks());

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

describe("#7188 S1 internal declarations in the strict prepared presentation", () => {
  it("presents and runs an untyped non-exported helper behind a numeric export", async () => {
    forbidDirectGenerators();
    const result = await compile(
      "function id(x) { return x; }\nexport function main(): number { return id(3) + 1; }\n",
      { ...options, fileName: "entry.ts" },
    );
    expect(messages(result)).toEqual([]);
    expect(requiredPreparedEmission(result)).toBeDefined();
    const execution = instantiatePreparedArtifact(result);
    expect((execution.instance.exports.main as () => number)()).toBe(4);
  });

  it("keeps the primitive contract on an exported untyped function", async () => {
    const result = await compile("export function id(x) { return x; }\n", { ...options, fileName: "entry.ts" });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("complete synchronous numeric or Boolean function declarations are required");
  });

  it.each(["export { u };", "export { u as alias };", "export default u;"])(
    "refuses an export that targets an internal declaration: %s",
    async (exportClause) => {
      forbidDirectGenerators();
      const result = await compile(
        `function u() { return undefined; }\nexport function main(): number { u(); return 1; }\n${exportClause}\n`,
        { ...options, fileName: "entry.ts" },
      );
      expect(result.success).toBe(false);
      expect(messages(result)).toContain("source unit, export ABI and actual function-space export must join exactly");
      expect(requiredPreparedEmission(result)).toBeUndefined();
    },
  );

  it("leaves numeric-only programs on the host contract", async () => {
    forbidDirectGenerators();
    const result = await compile("export function add(a: number, b: number): number { return a + b; }\n", {
      ...options,
      fileName: "entry.ts",
    });
    expect(messages(result)).toEqual([]);
    const execution = instantiatePreparedArtifact(result);
    expect((execution.instance.exports.add as (a: number, b: number) => number)(20, 22)).toBe(42);
  });
});
