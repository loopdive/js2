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

const identities = createTestIrFunctionIdentityFactory("issue-5106-ir-math-derived-log");
const METHODS = ["log10", "log1p"] as const;
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
      // @ts-expect-error #5106 shadowed Math is intentionally not ambient.
      return Math.${method}(x);
    }`,
      ],
      [
        `aliased ${method}`,
        `const derivedLog = Math.${method};
    export function f(x: number): number { return derivedLog(x); }`,
      ],
      [`computed ${method}`, `export function f(x: number): number { return Math["${method}"](x); }`],
      [`optional invocation ${method}`, `export function f(x: number): number { return Math.${method}?.(x); }`],
      [`optional receiver ${method}`, `export function f(x: number): number { return Math?.${method}(x); }`],
      [
        `${method} wrong arity`,
        `export function f(x: number): number {
      // @ts-expect-error #5106 intentionally exercises extra arity.
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

describe("#5106 exact ambient Math.log10/Math.log1p IR ownership", () => {
  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("claims both exact one-number calls on the %s target", async (_label, target) => {
    const result = await compile(
      `
        export function log10(value: number): number { return Math.log10(value); }
        export function log1p(value: number): number { return Math.log1p(value); }
      `,
      {
        fileName: `issue-5106-${_label}.ts`,
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
    expect(typeof exports.log10).toBe("function");
    expect(typeof exports.log1p).toBe("function");

    if (target === "standalone") {
      expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
      expect(result.imports).toEqual([]);
    } else {
      expect(result.imports.filter((descriptor) => descriptor.name.startsWith("Math_"))).toEqual([]);
    }
  });

  it("attaches both existing providers to one deduplicated Math_log dependency", () => {
    const analysis = analyzeSource(`
      export function derivedLog(value: number): number {
        return Math.log10(value) + Math.log1p(value);
      }
    `);
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
    if (!declaration) throw new Error("missing derivedLog declaration");

    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: identities.next("derivedLog").unitId,
      exported: true,
    }).main;
    const semantic = intrinsicInstructions(lowered);
    expect(semantic.map((instr) => instr.id).sort()).toEqual(["math.log10", "math.log1p"]);
    expect(semantic.every((instr) => instr.provider === undefined)).toBe(true);

    const prepared = prepareIrRuntimeManifest({
      functions: [lowered],
      sourceFile: analysis.sourceFile.fileName,
      policy: { target: "standalone", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");

    expect(prepared.manifest.intrinsicUses.map((use) => use.id).sort()).toEqual(["math.log10", "math.log1p"]);
    expect(prepared.manifest.features).toEqual(["math.log", "math.log10", "math.log1p"]);
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    const dependencies = Object.fromEntries(
      prepared.manifest.providers.map((provider) => [provider.feature, provider.dependencies]),
    );
    expect(dependencies).toMatchObject({
      "math.log": [],
      "math.log10": ["math.log"],
      "math.log1p": ["math.log"],
    });
    expect(new Set(prepared.manifest.providers.map((provider) => provider.id))).toEqual(
      new Set(["selfhost.math.log", "selfhost.math.log10", "selfhost.math.log1p"]),
    );

    for (const instr of intrinsicInstructions(prepared.functions[0]!)) {
      expect(instr.provider).toMatchObject({
        kind: "callable",
        target: { name: `Math_${instr.id.slice(5)}`, binding: { kind: "intrinsic", symbol: instr.id } },
      });
    }
  });

  it("is bit-identical to the direct path across boundaries and the log10 snap window", async () => {
    const source = `
      export function log10(value: number): number { return Math.log10(value); }
      export function log1p(value: number): number { return Math.log1p(value); }
    `;
    const [ir, direct] = await Promise.all([
      compile(source, { fileName: "issue-5106-ir.ts", experimentalIR: true, trackIrOutcomes: true }),
      compile(source, { fileName: "issue-5106-direct.ts", experimentalIR: false }),
    ]);
    expectSuccess(ir);
    expectSuccess(direct);

    const irExports = await instantiate(ir);
    const directExports = await instantiate(direct);
    const samples = {
      log10: [
        Number.NaN,
        Number.NEGATIVE_INFINITY,
        -1,
        -0,
        0,
        Number.MIN_VALUE,
        0.5,
        0.999999999999,
        1,
        2,
        10,
        Number.MAX_VALUE,
        Number.POSITIVE_INFINITY,
      ],
      log1p: [
        Number.NaN,
        Number.NEGATIVE_INFINITY,
        -2,
        -1.0000000000000002,
        -1,
        -0,
        0,
        -Number.MIN_VALUE,
        Number.MIN_VALUE,
        -0.5,
        -0.0001,
        -0.00009999999999999,
        0.00009999999999999,
        0.5,
        4.5,
        Number.MAX_VALUE,
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

    const irLog10 = irExports.log10 as (value: number) => number;
    // #3226 deliberately pins this source-faithful snap-to-integer behavior.
    // Native Math.log10 returns a small negative value; changing the inherited
    // approximation is separate from this ownership-only migration.
    expect(Object.is(irLog10(0.999999999999), -0)).toBe(true);
  });

  it("pins the established native-Math accuracy envelopes away from the log10 snap window", async () => {
    const result = await compile(
      `
        export function log10(value: number): number { return Math.log10(value); }
        export function log1p(value: number): number { return Math.log1p(value); }
      `,
      { fileName: "issue-5106-native-oracle.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expectSuccess(result);
    const exports = await instantiate(result);
    const log10 = exports.log10 as (value: number) => number;
    const log1p = exports.log1p as (value: number) => number;

    for (const value of [0.5, 0.75, 1.5, 2, 3, 123.456, 1e-15, 1e15]) {
      expect(Math.abs(log10(value) - Math.log10(value)), `log10 absolute error for ${value}`).toBeLessThanOrEqual(5e-9);
    }

    for (const value of [
      -0.00009999999999999,
      -1e-6,
      -Number.MIN_VALUE,
      0,
      Number.MIN_VALUE,
      1e-6,
      0.00009999999999999,
    ]) {
      const actual = log1p(value);
      const expected = Math.log1p(value);
      expect(Math.abs(actual - expected), `log1p Taylor absolute error for ${value}`).toBeLessThanOrEqual(3e-17);
      expect(ulpDistance(actual, expected), `log1p Taylor ULP distance for ${value}`).toBeLessThanOrEqual(2048n);
    }

    for (const value of [-0.875, -0.75, -0.5, -0.1, -0.01, 0.01, 0.1, 0.5, 1, 4.5, 1e6]) {
      expect(Math.abs(log1p(value) - Math.log1p(value)), `log1p absolute error for ${value}`).toBeLessThanOrEqual(
        1.25e-8,
      );
    }
  });

  it.each([
    ["log10", "JS2WASM_IR_MATH_LOG10", "log1p"],
    ["log1p", "JS2WASM_IR_MATH_LOG1P", "log10"],
  ] as const)("withdraws only %s through its narrow rollback", async (disabled, flag, retained) => {
    const previous = process.env[flag];
    process.env[flag] = "0";
    try {
      const result = await compile(
        `
          export function log10(value: number): number { return Math.log10(value); }
          export function log1p(value: number): number { return Math.log1p(value); }
        `,
        { fileName: `issue-5106-${disabled}-rollback.ts`, experimentalIR: true, trackIrOutcomes: true },
      );
      expectSuccess(result);
      expect(outcomeFor(result, disabled)).toMatchObject({
        kind: "unsupported",
        stage: "select",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(outcomeFor(result, retained)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      expect(result.irPostClaimErrors ?? []).toEqual([]);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, flag);
      else process.env[flag] = previous;
    }
  });

  it.each(exclusionCases)("rejects %s before claim", async (_label, source) => {
    const result = await compile(source, {
      fileName: `issue-5106-${_label.replaceAll(" ", "-")}.ts`,
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
