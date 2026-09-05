// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { forEachInstrDeep, type IrFunction, type IrInstrIntrinsic } from "../src/ir/nodes.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-5132-ir-math-inverse-hyperbolic");
const METHODS = ["asinh", "acosh", "atanh"] as const;

function adjacent(value: number, direction: 1n | -1n): number {
  if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY) return value;
  if (value === 0) return direction === 1n ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  const step = value > 0 ? direction : -direction;
  view.setBigUint64(0, view.getBigUint64(0) + step);
  return view.getFloat64(0);
}

function nextUp(value: number): number {
  return adjacent(value, 1n);
}

function nextDown(value: number): number {
  return adjacent(value, -1n);
}

function intrinsicInstructions(fn: IrFunction): IrInstrIntrinsic[] {
  const instructions: IrInstrIntrinsic[] = [];
  for (const block of fn.blocks) {
    for (const root of block.instrs) {
      forEachInstrDeep(root, (instr) => {
        if (instr.kind === "intrinsic") instructions.push(instr);
      });
    }
  }
  return instructions;
}

function outcomeFor(result: CompileResult, displayName: string): IrObservedOutcome {
  const outcome = result.irOutcomes?.find((candidate) => candidate.displayName === displayName);
  expect(outcome, `missing IR outcome for ${displayName}`).toBeDefined();
  if (!outcome) throw new Error(`missing IR outcome for ${displayName}`);
  return outcome;
}

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
}

async function instantiate(result: CompileResult): Promise<Record<string, unknown>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, unknown>;
  (imports as { setExports?: (value: Record<string, unknown>) => void }).setExports?.(exports);
  return exports;
}

const exclusionCases = METHODS.flatMap(
  (method) =>
    [
      [
        `${method} with shadowed Math`,
        `export function f(x: number): number {
          const Math: number = x;
          // @ts-expect-error #5132 shadowed Math is intentionally not ambient.
          return Math.${method}(x);
        }`,
      ],
      [
        `aliased ${method}`,
        `const inverseHyperbolic = Math.${method};
        export function f(x: number): number { return inverseHyperbolic(x); }`,
      ],
      [`computed ${method}`, `export function f(x: number): number { return Math["${method}"](x); }`],
      [`optional invocation ${method}`, `export function f(x: number): number { return Math.${method}?.(x); }`],
      [`optional receiver ${method}`, `export function f(x: number): number { return Math?.${method}(x); }`],
      [
        `${method} wrong arity`,
        `export function f(x: number): number {
          // @ts-expect-error #5132 intentionally exercises extra arity.
          return Math.${method}(x, x);
        }`,
      ],
      [
        `${method} spread argument`,
        `export function f(x: number): number { return Math.${method}(...([x] as [number])); }`,
      ],
      [
        `${method} non-number argument`,
        `export function f(): number {
          const text: string = "1";
          return Math.${method}(text as never);
        }`,
      ],
    ] as const,
);

describe("#5132 exact ambient inverse-hyperbolic Math IR ownership", () => {
  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("claims and executes all three exact one-number calls on the %s target", async (_label, target) => {
    const result = await compile(
      `
        export function asinh(value: number): number { return Math.asinh(value); }
        export function acosh(value: number): number { return Math.acosh(value); }
        export function atanh(value: number): number { return Math.atanh(value); }
      `,
      {
        fileName: `issue-5132-${_label}.ts`,
        ...(target === undefined ? {} : { target }),
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
      },
    );
    expectSuccess(result);
    for (const method of METHODS) {
      expect(outcomeFor(result, method)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      expect(result.irCompiledFuncs ?? []).toContain(method);
      expect(result.wat).toContain(`$Math_${method}`);
    }
    expect(result.wat).toContain("$Math_log");
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    const exports = await instantiate(result);
    const asinh = exports.asinh as (value: number) => number;
    const acosh = exports.acosh as (value: number) => number;
    const atanh = exports.atanh as (value: number) => number;
    expect(Object.is(asinh(-0), -0)).toBe(true);
    expect(asinh(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
    expect(asinh(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(acosh(1)).toBe(0);
    expect(Number.isNaN(acosh(nextDown(1)))).toBe(true);
    expect(acosh(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(Object.is(atanh(-0), -0)).toBe(true);
    expect(atanh(-1)).toBe(Number.NEGATIVE_INFINITY);
    expect(atanh(1)).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(atanh(nextUp(1)))).toBe(true);
    if (target === "standalone") {
      expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
      expect(result.imports).toEqual([]);
    } else {
      expect(result.imports.filter((descriptor) => descriptor.name.startsWith("Math_"))).toEqual([]);
    }
  });

  it("attaches all three providers to one deduplicated Math_log dependency", () => {
    const analysis = analyzeSource(`
      export function inverseHyperbolic(value: number): number {
        return Math.asinh(value) + Math.acosh(value) + Math.atanh(value);
      }
    `);
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
    if (!declaration) throw new Error("missing inverseHyperbolic declaration");

    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: identities.next("inverseHyperbolic").unitId,
      exported: true,
    }).main;
    const semantic = intrinsicInstructions(lowered);
    expect(semantic.map((instr) => instr.id).sort()).toEqual(["math.acosh", "math.asinh", "math.atanh"]);
    expect(semantic.every((instr) => instr.provider === undefined)).toBe(true);

    const prepared = prepareIrRuntimeManifest({
      functions: [lowered],
      sourceFile: analysis.sourceFile.fileName,
      policy: { target: "standalone", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");

    expect(prepared.manifest.intrinsicUses.map((use) => use.id).sort()).toEqual([
      "math.acosh",
      "math.asinh",
      "math.atanh",
    ]);
    expect(prepared.manifest.features).toEqual(["math.acosh", "math.asinh", "math.atanh", "math.log"]);
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    const dependencies = Object.fromEntries(
      prepared.manifest.providers.map((provider) => [provider.feature, provider.dependencies]),
    );
    expect(dependencies).toEqual({
      "math.acosh": ["math.log"],
      "math.asinh": ["math.log"],
      "math.atanh": ["math.log"],
      "math.log": [],
    });
    expect(new Set(prepared.manifest.providers.map((provider) => provider.id))).toEqual(
      new Set(["selfhost.math.acosh", "selfhost.math.asinh", "selfhost.math.atanh", "selfhost.math.log"]),
    );
    expect(prepared.manifest.providerComponents.map((component) => component.features)).toEqual([
      ["math.log"],
      ["math.acosh"],
      ["math.asinh"],
      ["math.atanh"],
    ]);
    for (const instr of intrinsicInstructions(prepared.functions[0]!)) {
      expect(instr.provider).toMatchObject({
        kind: "callable",
        target: { name: `Math_${instr.id.slice(5)}`, binding: { kind: "intrinsic", symbol: instr.id } },
      });
    }
  });

  it("is bit-identical to the direct path across domains, cancellation, and inherited overflow edges", async () => {
    const source = `
      export function asinh(value: number): number { return Math.asinh(value); }
      export function acosh(value: number): number { return Math.acosh(value); }
      export function atanh(value: number): number { return Math.atanh(value); }
    `;
    const [ir, direct] = await Promise.all([
      compile(source, { fileName: "issue-5132-ir.ts", experimentalIR: true, trackIrOutcomes: true }),
      compile(source, { fileName: "issue-5132-direct.ts", experimentalIR: false }),
    ]);
    expectSuccess(ir);
    expectSuccess(direct);
    const irExports = await instantiate(ir);
    const directExports = await instantiate(direct);
    const squareOverflow = 1.3407807929942596e154;
    const samples = {
      asinh: [
        Number.NaN,
        Number.NEGATIVE_INFINITY,
        -Number.MAX_VALUE,
        -nextUp(squareOverflow),
        -squareOverflow,
        -nextDown(squareOverflow),
        -1e154,
        -1,
        -Number.MIN_VALUE,
        -0,
        0,
        Number.MIN_VALUE,
        1,
        1e154,
        nextDown(squareOverflow),
        squareOverflow,
        nextUp(squareOverflow),
        Number.MAX_VALUE,
        Number.POSITIVE_INFINITY,
      ],
      acosh: [
        Number.NaN,
        Number.NEGATIVE_INFINITY,
        -1,
        0,
        nextDown(1),
        1,
        nextUp(1),
        2,
        1e154,
        nextDown(squareOverflow),
        squareOverflow,
        nextUp(squareOverflow),
        Number.MAX_VALUE,
        Number.POSITIVE_INFINITY,
      ],
      atanh: [
        Number.NaN,
        Number.NEGATIVE_INFINITY,
        -2,
        -nextUp(1),
        -1,
        -nextDown(1),
        -0.5,
        -Number.MIN_VALUE,
        -0,
        0,
        Number.MIN_VALUE,
        0.5,
        nextDown(1),
        1,
        nextUp(1),
        2,
        Number.POSITIVE_INFINITY,
      ],
    } as const;

    for (const method of METHODS) {
      expect(outcomeFor(ir, method)).toMatchObject({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false });
      const irFn = irExports[method] as (value: number) => number;
      const directFn = directExports[method] as (value: number) => number;
      for (const value of samples[method]) {
        expect(Object.is(irFn(value), directFn(value)), `${method} parity for ${String(value)}`).toBe(true);
      }
    }

    const irAsinh = irExports.asinh as (value: number) => number;
    const irAcosh = irExports.acosh as (value: number) => number;
    const irAtanh = irExports.atanh as (value: number) => number;
    expect(Object.is(irAsinh(Number.MIN_VALUE), 0)).toBe(true);
    expect(Object.is(irAsinh(-Number.MIN_VALUE), -0)).toBe(true);
    expect(irAsinh(nextUp(squareOverflow))).toBe(Number.POSITIVE_INFINITY);
    expect(irAcosh(nextUp(squareOverflow))).toBe(Number.POSITIVE_INFINITY);
    expect(Object.is(irAtanh(-Number.MIN_VALUE), 0)).toBe(true);
  });

  it("pins established native-Math safe-range envelopes on IR-only bodies", async () => {
    const result = await compile(
      `
        export function asinh(value: number): number { return Math.asinh(value); }
        export function acosh(value: number): number { return Math.acosh(value); }
        export function atanh(value: number): number { return Math.atanh(value); }
      `,
      { fileName: "issue-5132-native-oracle.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expectSuccess(result);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    const exports = await instantiate(result);
    const relativeSamples = {
      asinh: [-20, -10, -3, -1, -0.5, -0.001, 0.001, 0.5, 1, 3, 10, 20],
      acosh: [1.001, 1.01, 1.1, 2, 3.5, 10, 20],
      atanh: [-0.99, -0.9, -0.5, -0.1, 0.1, 0.5, 0.9, 0.99],
    } as const;
    const relativeBounds = { asinh: 2e-12, acosh: 2e-12, atanh: 2e-8 } as const;

    for (const method of METHODS) {
      expect(outcomeFor(result, method)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      const compiled = exports[method] as (value: number) => number;
      const native = Math[method];
      for (const value of relativeSamples[method]) {
        const actual = compiled(value);
        const expected = native(value);
        const relativeError = Math.abs(actual - expected) / Math.max(Math.abs(expected), Number.MIN_VALUE);
        expect(relativeError, `${method} relative error for ${value}`).toBeLessThanOrEqual(relativeBounds[method]);
      }
    }

    const asinh = exports.asinh as (value: number) => number;
    const acosh = exports.acosh as (value: number) => number;
    const atanh = exports.atanh as (value: number) => number;
    for (const value of [-1e-12, -Number.MIN_VALUE, Number.MIN_VALUE, 1e-12]) {
      expect(Math.abs(asinh(value) - Math.asinh(value)), `asinh tiny absolute error for ${value}`).toBeLessThanOrEqual(
        2e-16,
      );
      expect(Math.abs(atanh(value) - Math.atanh(value)), `atanh tiny absolute error for ${value}`).toBeLessThanOrEqual(
        2e-16,
      );
    }
    for (const value of [nextUp(1), 1 + 1e-12, 1 + 1e-8]) {
      expect(Math.abs(acosh(value) - Math.acosh(value)), `acosh edge absolute error for ${value}`).toBeLessThanOrEqual(
        5e-13,
      );
    }
    for (const value of [-nextDown(1), nextDown(1)]) {
      expect(Math.abs(atanh(value) - Math.atanh(value)), `atanh edge absolute error for ${value}`).toBeLessThanOrEqual(
        1e-8,
      );
    }
  });

  it.each(exclusionCases)("rejects %s before claim", async (_label, source) => {
    const result = await compile(source, {
      fileName: `issue-5132-${_label.replaceAll(" ", "-")}.ts`,
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expectSuccess(result);
    expect(outcomeFor(result, "f")).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irCompiledFuncs ?? []).not.toContain("f");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect((result.irOutcomes ?? []).filter((outcome) => outcome.kind === "invariant")).toEqual([]);
  });
});
