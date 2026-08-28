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

const identities = createTestIrFunctionIdentityFactory("issue-5114-ir-math-expm1");

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

const exclusionCases = [
  [
    "shadowed Math",
    `export function f(x: number): number {
      const Math: number = x;
      // @ts-expect-error #5114 shadowed Math is intentionally not ambient.
      return Math.expm1(x);
    }`,
  ],
  ["aliased expm1", `const minusOne = Math.expm1; export function f(x: number): number { return minusOne(x); }`],
  ["computed expm1", `export function f(x: number): number { return Math["expm1"](x); }`],
  ["optional invocation", `export function f(x: number): number { return Math.expm1?.(x); }`],
  ["optional receiver", `export function f(x: number): number { return Math?.expm1(x); }`],
  [
    "wrong arity",
    `export function f(x: number): number {
      // @ts-expect-error #5114 intentionally exercises extra arity.
      return Math.expm1(x, x);
    }`,
  ],
  ["spread argument", `export function f(x: number): number { return Math.expm1(...([x] as [number])); }`],
  [
    "non-number argument",
    `export function f(): number {
      const text: string = "1";
      return Math.expm1(text as never);
    }`,
  ],
] as const;

describe("#5114 exact ambient Math.expm1 IR ownership", () => {
  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("claims and executes the exact one-number call on the %s target", async (_label, target) => {
    const result = await compile(`export function expm1(value: number): number { return Math.expm1(value); }`, {
      fileName: `issue-5114-${_label}.ts`,
      ...(target === undefined ? {} : { target }),
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
    });
    expectSuccess(result);
    expect(outcomeFor(result, "expm1")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.irCompiledFuncs ?? []).toContain("expm1");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.wat).toContain("$Math_expm1");
    expect(result.wat).toContain("$Math_exp");

    const expm1 = (await instantiate(result)).expm1 as (value: number) => number;
    expect(Object.is(expm1(-0), -0)).toBe(true);
    expect(expm1(0)).toBe(0);
    expect(expm1(Number.NEGATIVE_INFINITY)).toBe(-1);
    expect(expm1(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(Math.abs(expm1(1e-7) - Math.expm1(1e-7))).toBeLessThanOrEqual(1e-22);
    if (target === "standalone") {
      expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
      expect(result.imports).toEqual([]);
    } else {
      expect(result.imports.filter((descriptor) => descriptor.name.startsWith("Math_"))).toEqual([]);
    }
  });

  it("attaches Math_expm1 and its sole deduplicated Math_exp dependency", () => {
    const analysis = analyzeSource(`export function expm1(value: number): number { return Math.expm1(value); }`);
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
    if (!declaration) throw new Error("missing expm1 declaration");

    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: identities.next("expm1").unitId,
      exported: true,
    }).main;
    const semantic = intrinsicInstructions(lowered);
    expect(semantic.map((instr) => instr.id)).toEqual(["math.expm1"]);
    expect(semantic[0]?.provider).toBeUndefined();

    const prepared = prepareIrRuntimeManifest({
      functions: [lowered],
      sourceFile: analysis.sourceFile.fileName,
      policy: { target: "standalone", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");

    expect(prepared.manifest.intrinsicUses.map((use) => use.id)).toEqual(["math.expm1"]);
    expect(prepared.manifest.features).toEqual(["math.exp", "math.expm1"]);
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    expect(prepared.manifest.providers).toEqual([
      expect.objectContaining({
        id: "selfhost.math.exp",
        feature: "math.exp",
        dependencies: [],
        implementation: { kind: "self-hosted", symbol: "Math_exp" },
      }),
      expect.objectContaining({
        id: "selfhost.math.expm1",
        feature: "math.expm1",
        dependencies: ["math.exp"],
        implementation: { kind: "self-hosted", symbol: "Math_expm1" },
      }),
    ]);
    expect(intrinsicInstructions(prepared.functions[0]!)[0]?.provider).toMatchObject({
      kind: "callable",
      target: { name: "Math_expm1", binding: { kind: "intrinsic", symbol: "math.expm1" } },
    });
  });

  it("is bit-identical to the direct path across the Taylor boundary and IEEE specials", async () => {
    const source = `export function expm1(value: number): number { return Math.expm1(value); }`;
    const [ir, direct] = await Promise.all([
      compile(source, { fileName: "issue-5114-ir.ts", experimentalIR: true, trackIrOutcomes: true }),
      compile(source, { fileName: "issue-5114-direct.ts", experimentalIR: false }),
    ]);
    expectSuccess(ir);
    expectSuccess(direct);
    expect(outcomeFor(ir, "expm1")).toMatchObject({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false });

    const irExpm1 = (await instantiate(ir)).expm1 as (value: number) => number;
    const directExpm1 = (await instantiate(direct)).expm1 as (value: number) => number;
    for (const value of [
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      -20,
      -2.5,
      -1,
      -1e-5,
      -9.999999999e-6,
      -1e-7,
      -Number.MIN_VALUE,
      -0,
      0,
      Number.MIN_VALUE,
      1e-7,
      9.999999999e-6,
      1e-5,
      0.1,
      1,
      2.5,
      20,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(Object.is(irExpm1(value), directExpm1(value)), `expm1 parity for ${String(value)}`).toBe(true);
    }
  });

  it("pins Taylor and general-branch native-Math accuracy on an IR-only body", async () => {
    const result = await compile(`export function expm1(value: number): number { return Math.expm1(value); }`, {
      fileName: "issue-5114-native-oracle.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expectSuccess(result);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(outcomeFor(result, "expm1")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    const expm1 = (await instantiate(result)).expm1 as (value: number) => number;

    for (const value of [-9.999999999e-6, -1e-7, -Number.MIN_VALUE, Number.MIN_VALUE, 1e-7, 9.999999999e-6]) {
      expect(Math.abs(expm1(value) - Math.expm1(value)), `Taylor absolute error for ${value}`).toBeLessThanOrEqual(
        1e-20,
      );
    }
    for (const value of [-20, -2.5, -1, -1e-5, 1e-5, 0.1, 1, 2.5, 20]) {
      const actual = expm1(value);
      const expected = Math.expm1(value);
      const relativeError = Math.abs(actual - expected) / Math.max(Math.abs(expected), Number.MIN_VALUE);
      expect(relativeError, `general relative error for ${value}`).toBeLessThanOrEqual(2e-8);
    }
  });

  it("withdraws only expm1 through its narrow rollback", async () => {
    const flag = "JS2WASM_IR_MATH_EXPM1";
    const previous = process.env[flag];
    process.env[flag] = "0";
    try {
      const result = await compile(`export function expm1(value: number): number { return Math.expm1(value); }`, {
        fileName: "issue-5114-rollback.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      expectSuccess(result);
      expect(outcomeFor(result, "expm1")).toMatchObject({
        kind: "unsupported",
        stage: "select",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(result.irPostClaimErrors ?? []).toEqual([]);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, flag);
      else process.env[flag] = previous;
    }
  });

  it.each(exclusionCases)("rejects %s before claim", async (_label, source) => {
    const result = await compile(source, {
      fileName: `issue-5114-${_label.replaceAll(" ", "-")}.ts`,
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
