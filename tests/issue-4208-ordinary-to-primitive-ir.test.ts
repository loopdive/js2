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
      expect(probeOutcome(result), JSON.stringify(probeOutcome(result), null, 2)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: true,
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
    "emits numeric binary OrdinaryToPrimitive operations through IR (%s)",
    async (target) => {
      const result = await compile(
        `export function probe(): number {
          const sum: number = { valueOf: function (): number { return 4; } } + 2;
          const less = { valueOf: function (): number { return 4; } } < 5;
          const equal = { valueOf: function (): number { return 4; } } == 4;
          return sum + (less ? 10 : 0) + (equal ? 100 : 0);
        }`,
        {
          fileName: "issue-4208-ordinary-to-primitive-binary-ir.ts",
          skipSemanticDiagnostics: true,
          experimentalIR: true,
          trackIrOutcomes: true,
          ...(target ? { target } : {}),
        },
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(probeOutcome(result), JSON.stringify(probeOutcome(result), null, 2)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: true,
        irBodyEmitted: true,
      });
      if (target === "standalone") {
        expect(WebAssembly.Module.imports(await WebAssembly.compile(result.binary))).toEqual([]);
      }
      const exports = await instantiate(result);
      expect(exports.probe!()).toBe(116);
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

  it.each<CompileTarget>(["standalone"])(
    "uses the default hint for repeated ES5 objects in addition and comparison (%s)",
    async (target) => {
      const result = await compile(
        `export function probe() {
          var object = { valueOf: function () { return 1; }, toString: function () { return 0; } };
          if (object + "" !== "1") return 1;
          var object = { valueOf: function () { return "-2"; }, toString: function () { return -2; } };
          if (object + 0 !== "-20") return 3;
          if (object < "-1") return 2;
          return 0;
        }`,
        {
          fileName: "issue-4208-repeated-var-binary.js",
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
      expect(exports.probe!()).toBe(0);
    },
  );

  it.each<CompileTarget>(["standalone"])(
    "coerces direct method-only literals for loose equality (%s)",
    async (target) => {
      const result = await compile(
        `export function probe() {
          if (!("+1" == { valueOf: function () { return 1; }, toString: function () { return {}; } })) return 1;
          if ("+1" != { valueOf: function () { return 1; }, toString: function () { return {}; } }) return 2;
          return 0;
        }`,
        {
          fileName: "issue-4208-inline-loose-equality.js",
          allowJs: true,
          skipSemanticDiagnostics: true,
          experimentalIR: true,
          trackIrOutcomes: true,
          ...(target ? { target } : {}),
        },
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const exports = await instantiate(result);
      expect(exports.probe!()).toBe(0);
    },
  );

  it.each<CompileTarget>([undefined, "standalone"])(
    "uses inherited object/function stringification in abstract operators (%s)",
    async (target) => {
      const result = await compile(
        `export function probe() {
        if (({} + function(){ return 1; }) !== ({}.toString() + function(){ return 1; }.toString())) return 1;
        if (({} < function(){ return 1; }) !== ({}.toString() < function(){ return 1; }.toString())) return 2;
        if ((function(){ return 1; } > {}) !== (function(){ return 1; }.toString() > {}.toString())) return 3;
        if (({} + {}) !== "[object Object][object Object]") return 4;
        if (({}.toString() + {}.toString()) !== "[object Object][object Object]") return 5;
        return 0;
      }`,
        {
          fileName: "issue-4208-object-function-binary.js",
          allowJs: true,
          skipSemanticDiagnostics: true,
          experimentalIR: true,
          trackIrOutcomes: true,
          ...(target ? { target } : {}),
        },
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      if (target === "standalone") {
        expect(WebAssembly.Module.imports(await WebAssembly.compile(result.binary))).toEqual([]);
      }
      const exports = await instantiate(result);
      expect(exports.probe!(), JSON.stringify(probeOutcome(result), null, 2)).toBe(0);
    },
  );

  it.each<CompileTarget>([undefined, "standalone"])(
    "uses valueOf before toString for native string concatenation (%s)",
    async (target) => {
      const result = await compile(
        `export function probe() {
          var object = {
            toNumber: function () { return 12345; },
            toString: function () { return 67890; },
            valueOf: function () { return "[object MyObj]"; }
          };
          return object + "" === "[object MyObj]" ? 1 : 0;
        }`,
        {
          fileName: "issue-4208-default-hint-concat.js",
          allowJs: true,
          skipSemanticDiagnostics: true,
          experimentalIR: true,
          trackIrOutcomes: true,
          ...(target ? { target } : {}),
        },
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const exports = await instantiate(result);
      expect(exports.probe!()).toBe(1);
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
