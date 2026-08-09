// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compile, type CompileOptions, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

async function compileAndRun(
  source: string,
  lane: Lane,
): Promise<{
  result: CompileResult;
  exports: Record<string, CallableFunction>;
}> {
  const options: CompileOptions = {
    fileName: "issue-3776.ts",
    experimentalIR: true,
    trackFallbacks: true,
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" } : {}),
  };
  const result = await compile(source, options);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  const imports = lane === "standalone" ? {} : buildImports(result.imports ?? [], undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  if ("setExports" in imports && typeof imports.setExports === "function") {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return {
    result,
    exports: instance.exports as unknown as Record<string, CallableFunction>,
  };
}

describe("#3776 ES5 Object.isFrozen intrinsic objects", () => {
  for (const lane of ["host", "standalone"] as const) {
    it(`lowers the exact intrinsic decision through IR in ${lane}`, async () => {
      const { result, exports } = await compileAndRun(
        `
          export function intrinsic(): boolean {
            return Object.isFrozen(EvalError);
          }
          export function prototype(): boolean {
            return Object.isFrozen(Boolean.prototype);
          }
        `,
        lane,
      );

      expect(result.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["intrinsic", "prototype"]));
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(exports.intrinsic!()).toBe(0);
      expect(exports.prototype!()).toBe(0);
    });

    it(`refuses the fold after an integrity mutation in ${lane}`, async () => {
      const { result, exports } = await compileAndRun(
        `
          export function probe(): boolean {
            Object.freeze(Boolean);
            return Object.isFrozen(Boolean);
          }
        `,
        lane,
      );

      expect(result.irCompiledFuncs ?? []).not.toContain("probe");
      expect(exports.probe!()).toBe(1);
    });

    it(`keeps shadowed bindings on their observable path in ${lane}`, async () => {
      const target = await compileAndRun(
        `
          export function probe(): boolean {
            const Boolean = {};
            return Object.isFrozen(Boolean);
          }
        `,
        lane,
      );
      const receiver = await compileAndRun(
        `
          export function probe(): boolean {
            const Object = { isFrozen: (_value: unknown): boolean => true };
            return Object.isFrozen(Boolean);
          }
        `,
        lane,
      );

      expect(target.result.irCompiledFuncs ?? []).not.toContain("probe");
      expect(target.exports.probe!()).toBe(0);
      expect(receiver.result.irCompiledFuncs ?? []).not.toContain("probe");
      expect(receiver.exports.probe!()).toBe(1);
    });
  }

  const originalHarnessCases: ReadonlyArray<{ file: string; lane: Lane }> = [
    { file: "15.2.3.12-3-10.js", lane: "standalone" },
    { file: "15.2.3.12-3-11.js", lane: "standalone" },
    { file: "15.2.3.12-3-21.js", lane: "host" },
    { file: "15.2.3.12-3-26.js", lane: "host" },
  ];
  for (const { file, lane } of originalHarnessCases) {
    it(`passes the original ES5 Test262 harness for ${file} in ${lane}`, async () => {
      const result = await runTest262File(
        resolve("test262/test/built-ins/Object/isFrozen", file),
        "built-ins",
        60_000,
        lane === "standalone" ? "standalone" : undefined,
      );
      expect(result.status, result.reason ?? result.error).toBe("pass");
    });
  }
});
