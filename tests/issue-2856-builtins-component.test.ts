// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2856 builtins component: exact Math helpers, bounded number formatting,
// literal String.replace, and numeric bitwise-not. Positive cases assert
// genuine IR emission; unsupported coercive/dynamic shapes reject pre-claim.

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { compile } from "../src/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import {
  makeIrAmbientBindingPredicate,
  makeIrDeclaredPrimitiveExpressionClassifier,
  makeIrPrimitiveExpressionClassifier,
} from "../src/ir/module-bindings.js";
import { buildTypeMap } from "../src/ir/propagate.js";
import { planIrCompilation } from "../src/ir/select.js";
import { buildImports } from "../src/runtime.js";

const JS_STRING = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  fromCharCode: (c: number) => String.fromCharCode(c),
  cast: (s: unknown) => String(s),
  test: (v: unknown) => (typeof v === "string" ? 1 : 0),
};

async function compileSource(source: string, extra: Record<string, unknown> = {}) {
  const result = await compile(source, {
    fileName: "issue-2856-builtins-component.ts",
    experimentalIR: true,
    trackFallbacks: true,
    ...extra,
  });
  expect(result.success, result.errors[0]?.message).toBe(true);
  expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
  return result;
}

async function instantiate(source: string, experimentalIR: boolean) {
  const result = await compile(source, {
    fileName: "issue-2856-builtins-runtime.ts",
    experimentalIR,
    trackFallbacks: true,
  });
  expect(result.success, result.errors[0]?.message).toBe(true);
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports: WebAssembly.Imports = { env: built.env, string_constants: built.string_constants };
  imports["wasm:js-string"] = JS_STRING as unknown as WebAssembly.ModuleImports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  built.setExports?.(instance.exports as Record<string, Function>);
  return {
    result,
    exports: instance.exports as Record<string, (...args: number[]) => number | string>,
  };
}

describe("#2856 builtins component", () => {
  it("genuinely IR-compiles the playground builtins main", async () => {
    const source = await readFile("website/playground/examples/js/builtins.ts", "utf8");
    const result = await compileSource(source, { fileName: "website/playground/examples/js/builtins.ts" });
    expect(result.irCompiledFuncs ?? []).toContain("main");
  });

  it("matches legacy for direct and self-hosted Math methods", async () => {
    const source = `
      export function abs(): number { return Math.abs(-3.5); }
      export function sqrt(): number { return Math.sqrt(144); }
      export function floor(): number { return Math.floor(3.9); }
      export function ceil(): number { return Math.ceil(3.1); }
      export function trunc(): number { return Math.trunc(-3.9); }
      export function sin(): number { return Math.sin(0.75); }
      export function cos(): number { return Math.cos(0.75); }
      export function exp(): number { return Math.exp(1.25); }
      export function log(): number { return Math.log(3.5); }
      export function log2(): number { return Math.log2(32); }
      export function pow(): number { return Math.pow(2.5, 3); }
      export function atan2(): number { return Math.atan2(1, -1); }
    `;
    const [ir, legacy] = await Promise.all([instantiate(source, true), instantiate(source, false)]);
    for (const name of ["abs", "sqrt", "floor", "ceil", "trunc", "sin", "cos", "exp", "log", "log2", "pow", "atan2"]) {
      expect(ir.result.irCompiledFuncs ?? []).toContain(name);
      expect(ir.exports[name]!()).toBe(legacy.exports[name]!());
    }
  });

  it("matches legacy for ToInt32 bitwise-not edge values", async () => {
    const source = `
      export function zero(): number { return ~0; }
      export function minusOne(): number { return ~-1; }
      export function highBit(): number { return ~2147483648; }
      export function uintMax(): number { return ~4294967295; }
      export function uintWrap(): number { return ~4294967296; }
      export function belowIntMin(): number { return ~-2147483649; }
      export function fraction(): number { return ~1.9; }
      export function negativeZero(): number { return ~-0; }
      export function nan(): number { return ~(0 / 0); }
      export function positiveInfinity(): number { return ~(1 / 0); }
      export function negativeInfinity(): number { return ~(-1 / 0); }
    `;
    const [ir, legacy] = await Promise.all([instantiate(source, true), instantiate(source, false)]);
    for (const name of [
      "zero",
      "minusOne",
      "highBit",
      "uintMax",
      "uintWrap",
      "belowIntMin",
      "fraction",
      "negativeZero",
      "nan",
      "positiveInfinity",
      "negativeInfinity",
    ]) {
      expect(ir.result.irCompiledFuncs ?? []).toContain(name);
      expect(ir.exports[name]!()).toBe(legacy.exports[name]!());
    }
  });

  it("matches legacy for bounded literal toFixed and literal replace", async () => {
    const source = `
      export function fixedOne(): string { return Math.log2(1024).toFixed(1); }
      export function fixedSix(): string { return Math.atan2(1, 1).toFixed(6); }
      export function replaceLiteral(): string {
        const hello = "Hello, WebAssembly!";
        return hello.replace("Hello", "Hi");
      }
    `;
    const [ir, legacy] = await Promise.all([instantiate(source, true), instantiate(source, false)]);
    for (const name of ["fixedOne", "fixedSix", "replaceLiteral"]) {
      expect(ir.result.irCompiledFuncs ?? []).toContain(name);
      expect(ir.exports[name]!()).toBe(legacy.exports[name]!());
    }
  });

  it("rejects shadowed Math, wrong arities, and unsafe builtin arguments before claim", async () => {
    const shadowed = await compileSource(
      `
      const Math = { pow: (a: number, b: number): number => a + b };
      export function shadow(): number { return Math.pow(2, 3); }
      export function shadowParam(Math: any): number { return Math.pow(2, 3); }
    `,
      { skipSemanticDiagnostics: true },
    );
    expect(shadowed.irCompiledFuncs ?? []).not.toContain("shadow");
    expect(shadowed.irCompiledFuncs ?? []).not.toContain("shadowParam");

    const source = `
      export function wrongUnary(): number { return Math.sin(); }
      export function wrongBinary(): number { return Math.pow(2); }
      export function nonNumericMath(): number { return Math.sin(true); }
      export function dynamicFixed(digits: number): string { return (1.25).toFixed(digits); }
      export function outOfRangeFixed(): string { return (1.25).toFixed(101); }
      export function regexpReplace(): string { return "aba".replace(/a/g, "x"); }
      export function callbackReplace(): string { return "aba".replace("a", () => "x"); }
      export function numberReplace(): string { return (123).replace("1", "x"); }
      export function stringTilde(): number { return ~("1" as any); }
    `;
    const result = await compileSource(source, { skipSemanticDiagnostics: true });
    for (const name of [
      "wrongUnary",
      "wrongBinary",
      "nonNumericMath",
      "dynamicFixed",
      "outOfRangeFixed",
      "regexpReplace",
      "callbackReplace",
      "numberReplace",
      "stringTilde",
    ]) {
      expect(result.irCompiledFuncs ?? []).not.toContain(name);
    }
  });

  it("rejects a literal initialized with a non-string local representation before claim", async () => {
    const result = await compileSource(
      `
      export function annotatedNumberReplace(): string {
        const value: number = "aba";
        return value.replace("a", "x");
      }
      export function annotatedStringReplace(): string {
        const value: string = 123;
        return value.replace("1", "x");
      }
    `,
      { skipSemanticDiagnostics: true },
    );
    expect(result.irCompiledFuncs ?? []).not.toContain("annotatedNumberReplace");
    expect(result.irCompiledFuncs ?? []).not.toContain("annotatedStringReplace");
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
  });

  it("keeps class methods named like builtins on ordinary class dispatch", async () => {
    const source = `
      class Formatter {
        replace(value: number): number { return value + 1; }
        toFixed(value: number): number { return value * 2; }
      }
      export function classNamedMethods(): number {
        const formatter = new Formatter();
        return formatter.replace(4) + formatter.toFixed(3);
      }
    `;
    const [ir, legacy] = await Promise.all([instantiate(source, true), instantiate(source, false)]);
    expect(ir.result.irCompiledFuncs ?? []).toContain("classNamedMethods");
    expect(ir.exports.classNamedMethods!()).toBe(legacy.exports.classNamedMethods!());
    expect(ir.exports.classNamedMethods!()).toBe(11);
  });

  it("rejects invalid annotated numeric initializers before builtin claims", async () => {
    const source = `
      export function invalidFixed(): string {
        const value: number = "aba";
        return value.toFixed(1);
      }
      export function invalidMath(): number {
        const value: number = "aba";
        return Math.sin(value);
      }
      export function invalidTilde(): number {
        const value: number = "aba";
        return ~value;
      }
      export function inferredFixed(): string {
        const value = 1.25;
        return value.toFixed(1);
      }
      export function inferredMath(): number {
        const value = 0.5;
        return Math.sin(value);
      }
      export function inferredTilde(): number {
        const value = 1.9;
        return ~value;
      }
    `;
    const result = await compileSource(source, { skipSemanticDiagnostics: true });
    for (const name of ["invalidFixed", "invalidMath", "invalidTilde"]) {
      expect(result.irCompiledFuncs ?? []).not.toContain(name);
    }
    for (const name of ["inferredFixed", "inferredMath", "inferredTilde"]) {
      expect(result.irCompiledFuncs ?? []).toContain(name);
    }
  });

  it("rejects literal replace before claim when the linear planner has no method plan", async () => {
    const result = await compile(
      `
        export function linearReplace(value: string): string { return value.replace("a", "x"); }
        export function linearFixedParam(value: number): string { return value.toFixed(1); }
        export function linearFixedLocal(): string {
          const value = 1.25;
          return value.toFixed(1);
        }
        export function linearInvalidStringReplace(): string {
          const value: string = 123;
          return value.replace("1", "x");
        }
        export function linearMixedReplace(flag: boolean): string {
          const value: string | number = flag ? "aba" : 123;
          return value.replace("a", "x");
        }
        export function linearNullableReplace(flag: boolean): string {
          const value: string | null = flag ? "aba" : null;
          return value.replace("a", "x");
        }
      `,
      {
        fileName: "issue-2856-linear-builtins.ts",
        experimentalIR: true,
        trackFallbacks: true,
        target: "linear",
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.irPostClaimErrors ?? []).toStrictEqual([]);
    const report = getLastLinearIrReport();
    expect(report).toBeDefined();
    for (const name of [
      "linearReplace",
      "linearFixedParam",
      "linearFixedLocal",
      "linearInvalidStringReplace",
      "linearMixedReplace",
      "linearNullableReplace",
    ]) {
      expect(report?.compiled).not.toContain(name);
      const rejected = report?.rejected.filter((entry) => entry.func === name) ?? [];
      expect(rejected.some((entry) => entry.reason === "select:body-shape-rejected")).toBe(true);
      expect(rejected.some((entry) => entry.reason === "build")).toBe(false);
    }
  });

  it("keeps direct ambient Math ops on linear IR without admitting a shadow", async () => {
    const result = await compile(`export function absolute(value: number): number { return Math.abs(value); }`, {
      fileName: "issue-2856-linear-math.ts",
      experimentalIR: true,
      trackFallbacks: true,
      target: "linear",
    });
    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(getLastLinearIrReport()?.compiled).toContain("absolute");
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.absolute as (value: number) => number)(-3.5)).toBe(3.5);

    const shadowed = analyzeSource(`
      const Math = { abs: (value: number): number => value };
      export function shadowed(): number { return Math.abs(-3.5); }
    `);
    const shadowedSelection = planIrCompilation(
      shadowed.sourceFile,
      {
        experimentalIR: true,
        trackFallbacks: true,
        classifyPrimitiveExpression: makeIrPrimitiveExpressionClassifier(shadowed.checker),
        classifyDeclaredPrimitiveExpression: makeIrDeclaredPrimitiveExpressionClassifier(shadowed.checker),
        isAmbientBinding: makeIrAmbientBindingPredicate(shadowed.checker),
        supportsSymbolicMathHelpers: false,
      },
      buildTypeMap(shadowed.sourceFile, shadowed.checker),
    );
    expect(shadowedSelection.funcs).not.toContain("shadowed");
    expect(shadowedSelection.fallbacks).toContainEqual(
      expect.objectContaining({ name: "shadowed", reason: "body-shape-rejected" }),
    );

    await compile(`export function invalid(): number { const value: number = "oops"; return Math.abs(value); }`, {
      fileName: "issue-2856-linear-invalid-math.ts",
      experimentalIR: true,
      trackFallbacks: true,
      target: "linear",
      skipSemanticDiagnostics: true,
    });
    const invalidReport = getLastLinearIrReport();
    expect(invalidReport?.compiled).not.toContain("invalid");
    expect(invalidReport?.rejected.some((entry) => entry.func === "invalid" && entry.reason === "build")).toBe(false);
  });

  it("preserves typed-string replace fallback in host and native string modes", async () => {
    const source = `export function typedReplace(value: string): string { return value.replace("a", "x"); }`;
    for (const extra of [{}, { nativeStrings: true }]) {
      const result = await compileSource(source, extra);
      expect(result.irCompiledFuncs ?? []).not.toContain("typedReplace");
    }
  });

  it("keeps bounded toFixed out of unsupported representation modes", async () => {
    const source = `export function fixed(): string { return (1.25).toFixed(1); }`;
    for (const extra of [{ nativeStrings: true }, { fast: true }, { target: "standalone" }, { target: "wasi" }]) {
      const result = await compileSource(source, extra);
      expect(result.irCompiledFuncs ?? []).not.toContain("fixed");
    }

    const nativeReplace = await compileSource(
      `export function replacedLength(): number { return "aba".replace("a", "x").length; }`,
      { nativeStrings: true },
    );
    expect(nativeReplace.irCompiledFuncs ?? []).toContain("replacedLength");
  });
});
