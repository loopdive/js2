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

const identities = createTestIrFunctionIdentityFactory("issue-5110-ir-math-hyperbolic");
const METHODS = ["sinh", "cosh", "tanh"] as const;

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
      // @ts-expect-error #5110 shadowed Math is intentionally not ambient.
      return Math.${method}(x);
    }`,
      ],
      [
        `aliased ${method}`,
        `const hyperbolic = Math.${method};
    export function f(x: number): number { return hyperbolic(x); }`,
      ],
      [`computed ${method}`, `export function f(x: number): number { return Math["${method}"](x); }`],
      [`optional invocation ${method}`, `export function f(x: number): number { return Math.${method}?.(x); }`],
      [`optional receiver ${method}`, `export function f(x: number): number { return Math?.${method}(x); }`],
      [
        `${method} wrong arity`,
        `export function f(x: number): number {
      // @ts-expect-error #5110 intentionally exercises extra arity.
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

describe("#5110 exact ambient hyperbolic Math IR ownership", () => {
  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("claims all three exact one-number calls on the %s target", async (_label, target) => {
    const result = await compile(
      `
        export function sinh(value: number): number { return Math.sinh(value); }
        export function cosh(value: number): number { return Math.cosh(value); }
        export function tanh(value: number): number { return Math.tanh(value); }
      `,
      {
        fileName: `issue-5110-${_label}.ts`,
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
    expect(result.wat).toContain("$Math_exp");
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    const exports = await instantiate(result);
    for (const method of METHODS) expect(typeof exports[method]).toBe("function");

    if (target === "standalone") {
      expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
      expect(result.imports).toEqual([]);
    } else {
      expect(result.imports.filter((descriptor) => descriptor.name.startsWith("Math_"))).toEqual([]);
    }
  });

  it("attaches all three providers to one deduplicated Math_exp dependency", () => {
    const analysis = analyzeSource(`
      export function hyperbolic(value: number): number {
        return Math.sinh(value) + Math.cosh(value) + Math.tanh(value);
      }
    `);
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
    if (!declaration) throw new Error("missing hyperbolic declaration");

    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: identities.next("hyperbolic").unitId,
      exported: true,
    }).main;
    const semantic = intrinsicInstructions(lowered);
    expect(semantic.map((instr) => instr.id).sort()).toEqual(["math.cosh", "math.sinh", "math.tanh"]);
    expect(semantic.every((instr) => instr.provider === undefined)).toBe(true);

    const prepared = prepareIrRuntimeManifest({
      functions: [lowered],
      sourceFile: analysis.sourceFile.fileName,
      policy: { target: "standalone", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");

    expect(prepared.manifest.intrinsicUses.map((use) => use.id).sort()).toEqual([
      "math.cosh",
      "math.sinh",
      "math.tanh",
    ]);
    expect(prepared.manifest.features).toEqual(["math.cosh", "math.exp", "math.sinh", "math.tanh"]);
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    const dependencies = Object.fromEntries(
      prepared.manifest.providers.map((provider) => [provider.feature, provider.dependencies]),
    );
    expect(dependencies).toMatchObject({
      "math.cosh": ["math.exp"],
      "math.exp": [],
      "math.sinh": ["math.exp"],
      "math.tanh": ["math.exp"],
    });
    expect(new Set(prepared.manifest.providers.map((provider) => provider.id))).toEqual(
      new Set(["selfhost.math.cosh", "selfhost.math.exp", "selfhost.math.sinh", "selfhost.math.tanh"]),
    );

    for (const instr of intrinsicInstructions(prepared.functions[0]!)) {
      expect(instr.provider).toMatchObject({
        kind: "callable",
        target: { name: `Math_${instr.id.slice(5)}`, binding: { kind: "intrinsic", symbol: instr.id } },
      });
    }
  });

  it("is bit-identical to the direct path across cancellation, saturation, and overflow boundaries", async () => {
    const source = `
      export function sinh(value: number): number { return Math.sinh(value); }
      export function cosh(value: number): number { return Math.cosh(value); }
      export function tanh(value: number): number { return Math.tanh(value); }
    `;
    const [ir, direct] = await Promise.all([
      compile(source, { fileName: "issue-5110-ir.ts", experimentalIR: true, trackIrOutcomes: true }),
      compile(source, { fileName: "issue-5110-direct.ts", experimentalIR: false }),
    ]);
    expectSuccess(ir);
    expectSuccess(direct);

    const irExports = await instantiate(ir);
    const directExports = await instantiate(direct);
    const samples = [
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      -710,
      -20.0000001,
      -20,
      -1,
      -Number.MIN_VALUE,
      -0,
      0,
      Number.MIN_VALUE,
      1,
      20,
      20.0000001,
      710,
      Number.POSITIVE_INFINITY,
    ];

    for (const method of METHODS) {
      expect(outcomeFor(ir, method)).toMatchObject({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false });
      const irFn = irExports[method] as (value: number) => number;
      const directFn = directExports[method] as (value: number) => number;
      for (const value of samples) {
        expect(Object.is(irFn(value), directFn(value)), `${method} parity for ${String(value)}`).toBe(true);
      }
    }

    expect(Object.is((irExports.sinh as (value: number) => number)(-0), -0)).toBe(true);
    expect(Object.is((irExports.tanh as (value: number) => number)(-0), -0)).toBe(true);
    expect((irExports.cosh as (value: number) => number)(-0)).toBe(1);
  });

  it("pins the established native-Math relative-error envelopes in the finite interior", async () => {
    const result = await compile(
      `
        export function sinh(value: number): number { return Math.sinh(value); }
        export function cosh(value: number): number { return Math.cosh(value); }
        export function tanh(value: number): number { return Math.tanh(value); }
      `,
      { fileName: "issue-5110-native-oracle.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expectSuccess(result);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    const exports = await instantiate(result);
    const samples = [-20, -10, -3, -1, -0.5, 0.5, 1, 3, 10, 20];
    const maxRelativeError = { sinh: 2.5e-8, cosh: 1e-8, tanh: 2.5e-8 } as const;

    for (const method of METHODS) {
      expect(outcomeFor(result, method)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      const compiled = exports[method] as (value: number) => number;
      const native = Math[method];
      for (const value of samples) {
        const actual = compiled(value);
        const expected = native(value);
        const relativeError = Math.abs(actual - expected) / Math.max(Math.abs(expected), Number.MIN_VALUE);
        expect(relativeError, `${method} relative error for ${value}`).toBeLessThanOrEqual(maxRelativeError[method]);
      }
    }
  });

  it.each(exclusionCases)("rejects %s before claim", async (_label, source) => {
    const result = await compile(source, {
      fileName: `issue-5110-${_label.replaceAll(" ", "-")}.ts`,
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
