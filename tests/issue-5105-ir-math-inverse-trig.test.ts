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

const identities = createTestIrFunctionIdentityFactory("issue-5105-ir-math-inverse-trig");
const METHODS = ["asin", "acos"] as const;
const U64_MASK = (1n << 64n) - 1n;
const U64_SIGN = 1n << 63n;

function orderedFloatBits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  return (bits & U64_SIGN) !== 0n ? ~bits & U64_MASK : bits | U64_SIGN;
}

function ulpDistance(left: number, right: number): bigint {
  const leftBits = orderedFloatBits(left);
  const rightBits = orderedFloatBits(right);
  return leftBits > rightBits ? leftBits - rightBits : rightBits - leftBits;
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
      // @ts-expect-error #5105 shadowed Math is intentionally not ambient.
      return Math.${method}(x);
    }`,
      ],
      [
        `aliased ${method}`,
        `const inverse = Math.${method};
    export function f(x: number): number { return inverse(x); }`,
      ],
      [
        `${method} wrong arity`,
        `export function f(x: number): number {
      // @ts-expect-error #5105 intentionally exercises extra arity.
      return Math.${method}(x, x);
    }`,
      ],
      [
        `${method} spread argument`,
        `export function f(x: number): number {
      return Math.${method}(...([x] as [number]));
    }`,
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

describe("#5105 exact ambient Math.asin/Math.acos IR ownership", () => {
  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("claims both exact one-number calls on the %s target", async (_label, target) => {
    const result = await compile(
      `
        export function asin(value: number): number { return Math.asin(value); }
        export function acos(value: number): number { return Math.acos(value); }
      `,
      {
        fileName: `issue-5105-${_label}.ts`,
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
    expect(result.wat).toContain("$Math_atan");
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    const exports = await instantiate(result);
    expect(typeof exports.asin).toBe("function");
    expect(typeof exports.acos).toBe("function");

    if (target === "standalone") {
      expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
      expect(result.imports).toEqual([]);
    } else {
      expect(result.imports.filter((descriptor) => descriptor.name.startsWith("Math_"))).toEqual([]);
    }
  });

  it("attaches both existing providers to one deduplicated Math_atan dependency", () => {
    const analysis = analyzeSource(`
      export function inverse(value: number): number {
        return Math.asin(value) + Math.acos(value);
      }
    `);
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
    if (!declaration) throw new Error("missing inverse declaration");

    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: identities.next("inverse").unitId,
      exported: true,
    }).main;
    const semantic = intrinsicInstructions(lowered);
    expect(semantic.map((instr) => instr.id).sort()).toEqual(["math.acos", "math.asin"]);
    expect(semantic.every((instr) => instr.provider === undefined)).toBe(true);

    const prepared = prepareIrRuntimeManifest({
      functions: [lowered],
      sourceFile: analysis.sourceFile.fileName,
      policy: { target: "standalone", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");

    expect(prepared.manifest.intrinsicUses.map((use) => use.id).sort()).toEqual(["math.acos", "math.asin"]);
    expect(prepared.manifest.features).toEqual(["math.acos", "math.asin", "math.atan"]);
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    const dependencies = Object.fromEntries(
      prepared.manifest.providers.map((provider) => [provider.feature, provider.dependencies]),
    );
    expect(dependencies).toMatchObject({
      "math.acos": ["math.atan"],
      "math.asin": ["math.atan"],
      "math.atan": [],
    });
    expect(new Set(prepared.manifest.providers.map((provider) => provider.id))).toEqual(
      new Set(["selfhost.math.acos", "selfhost.math.asin", "selfhost.math.atan"]),
    );

    for (const instr of intrinsicInstructions(prepared.functions[0]!)) {
      expect(instr.provider).toMatchObject({
        kind: "callable",
        target: { name: `Math_${instr.id.slice(5)}`, binding: { kind: "intrinsic", symbol: instr.id } },
      });
    }
  });

  it("matches the direct path across domain boundaries, NaN, infinities, and signed zero", async () => {
    const source = `
      export function asin(value: number): number { return Math.asin(value); }
      export function acos(value: number): number { return Math.acos(value); }
    `;
    const [ir, direct] = await Promise.all([
      compile(source, { fileName: "issue-5105-ir.ts", experimentalIR: true, trackIrOutcomes: true }),
      compile(source, { fileName: "issue-5105-direct.ts", experimentalIR: false }),
    ]);
    expectSuccess(ir);
    expectSuccess(direct);

    const irExports = await instantiate(ir);
    const directExports = await instantiate(direct);
    for (const method of METHODS) {
      expect(outcomeFor(ir, method)).toMatchObject({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false });
      const irFn = irExports[method] as (value: number) => number;
      const directFn = directExports[method] as (value: number) => number;
      for (const value of [-1, -0.5, -0, 0, 0.5, 1]) {
        expect(Object.is(irFn(value), directFn(value)), `${method} parity for ${String(value)}`).toBe(true);
      }
      for (const value of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
        expect(Number.isNaN(irFn(value)), `IR ${method} for ${String(value)}`).toBe(true);
        expect(Number.isNaN(directFn(value)), `direct ${method} for ${String(value)}`).toBe(true);
      }
    }
  });

  it("pins the established native-Math accuracy envelope near boundaries and in the interior", async () => {
    const result = await compile(
      `
        export function asin(value: number): number { return Math.asin(value); }
        export function acos(value: number): number { return Math.acos(value); }
      `,
      { fileName: "issue-5105-native-oracle.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expectSuccess(result);
    const exports = await instantiate(result);
    const samples = [
      -1, -0.9999999999999999, -0.999999, -0.99, -0.9, -0.5, -0.1, 0, 0.1, 0.5, 0.9, 0.99, 0.999999, 0.9999999999999999,
      1,
    ];
    const maxUlps = { asin: 4_000_000n, acos: 16_000_000n } as const;

    for (const method of METHODS) {
      const compiled = exports[method] as (value: number) => number;
      const native = Math[method];
      for (const value of samples) {
        const actual = compiled(value);
        const expected = native(value);
        expect(Math.abs(actual - expected), `${method} absolute error for ${value}`).toBeLessThanOrEqual(1e-9);
        expect(ulpDistance(actual, expected), `${method} ULP distance for ${value}`).toBeLessThanOrEqual(
          maxUlps[method],
        );
      }
    }
  });

  it.each(exclusionCases)("rejects %s before claim", async (_label, source) => {
    const result = await compile(source, {
      fileName: `issue-5105-${_label.replaceAll(" ", "-")}.ts`,
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
