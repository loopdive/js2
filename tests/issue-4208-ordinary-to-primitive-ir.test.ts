// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";

type CompileTarget = undefined | "standalone";

async function instantiate(result: CompileResult): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const imports = (result.importObject ?? {}) as WebAssembly.Imports & {
    setExports?: (exports: WebAssembly.Exports) => void;
    __setExports?: (exports: WebAssembly.Exports) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  imports.__setExports?.(instance.exports);
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

function probeOutcome(result: CompileResult): IrObservedOutcome | undefined {
  return result.irOutcomes?.find((outcome) => outcome.displayName === "probe");
}

describe("#4208 S3/S7 — OrdinaryToPrimitive object literals", () => {
  it.each<CompileTarget>([undefined, "standalone"])(
    "emits focused valueOf/toString coercion through IR (%s)",
    async (target) => {
      const result = await compile(
        `export function probe(): number {
          const valueObject = { valueOf: function (): number { return 1; } };
          const stringObject = { toString: function (): string { return "2"; } };
          return +valueObject + +stringObject;
        }`,
        {
          fileName: "issue-4208-ordinary-to-primitive-ir.ts",
          experimentalIR: true,
          trackIrOutcomes: true,
          ...(target ? { target } : {}),
        },
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(probeOutcome(result)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      if (target === "standalone") {
        expect(WebAssembly.Module.imports(await WebAssembly.compile(result.binary))).toEqual([]);
      }
      const exports = await instantiate(result);
      expect(exports.probe!()).toBe(3);
    },
  );

  it.each<CompileTarget>([undefined, "standalone"])(
    "keeps repeated ES5 var declarations on legacy while sharing one open object carrier (%s)",
    async (target) => {
      const result = await compile(
        `export function probe() {
          var object = { valueOf: function () { return 1; } };
          var a = +object;
          var object = { toString: function () { return 2; } };
          var b = -object;
          var object = {
            valueOf: function () { return 3; },
            toString: function () { return 30; }
          };
          var c = ~object;
          var object = { toString: function () { return 4; } };
          var d = object >>> 0;
          return a + b + c + d;
        }`,
        {
          fileName: "issue-4208-repeated-var.js",
          allowJs: true,
          skipSemanticDiagnostics: true,
          experimentalIR: true,
          trackIrOutcomes: true,
          ...(target ? { target } : {}),
        },
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(probeOutcome(result)).toMatchObject({
        kind: "unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      const exports = await instantiate(result);
      expect(exports.probe!()).toBe(-1);
    },
  );

  it.each<CompileTarget>([undefined, "standalone"])(
    "rejects mixed method/data objects before the IR claim (%s)",
    async (target) => {
      const result = await compile(
        `export function probe(): number {
          const object = {
            valueOf: function (): number { return 1; },
            data: 2
          };
          return +object;
        }`,
        {
          fileName: "issue-4208-mixed-object.ts",
          experimentalIR: true,
          trackIrOutcomes: true,
          ...(target ? { target } : {}),
        },
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(probeOutcome(result)).toMatchObject({
        kind: "unsupported",
        code: "body-shape-rejected",
        stage: "select",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      const exports = await instantiate(result);
      expect(exports.probe!()).toBe(1);
    },
  );
});
