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

const identities = createTestIrFunctionIdentityFactory("issue-5111-ir-math-cbrt");

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
      // @ts-expect-error #5111 shadowed Math is intentionally not ambient.
      return Math.cbrt(x);
    }`,
  ],
  ["aliased cbrt", `const cubeRoot = Math.cbrt; export function f(x: number): number { return cubeRoot(x); }`],
  ["computed cbrt", `export function f(x: number): number { return Math["cbrt"](x); }`],
  ["optional invocation", `export function f(x: number): number { return Math.cbrt?.(x); }`],
  ["optional receiver", `export function f(x: number): number { return Math?.cbrt(x); }`],
  [
    "wrong arity",
    `export function f(x: number): number {
      // @ts-expect-error #5111 intentionally exercises extra arity.
      return Math.cbrt(x, x);
    }`,
  ],
  ["spread argument", `export function f(x: number): number { return Math.cbrt(...([x] as [number])); }`],
  [
    "non-number argument",
    `export function f(): number {
      const text: string = "1";
      return Math.cbrt(text as never);
    }`,
  ],
] as const;

describe("#5111 exact ambient Math.cbrt IR ownership", () => {
  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("claims the exact one-number call on the %s target", async (_label, target) => {
    const result = await compile(`export function cbrt(value: number): number { return Math.cbrt(value); }`, {
      fileName: `issue-5111-${_label}.ts`,
      ...(target === undefined ? {} : { target }),
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
    });
    expectSuccess(result);
    expect(outcomeFor(result, "cbrt")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.irCompiledFuncs ?? []).toContain("cbrt");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.wat).toContain("$Math_cbrt");

    const exports = await instantiate(result);
    expect(typeof exports.cbrt).toBe("function");
    const cbrt = exports.cbrt as (value: number) => number;
    expect(cbrt(27)).toBe(3);
    expect(cbrt(-8)).toBe(-2);
    expect(Object.is(cbrt(-0), -0)).toBe(true);
    expect(cbrt(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(cbrt(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
    if (target === "standalone") {
      expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
      expect(result.imports).toEqual([]);
    } else {
      expect(result.imports.filter((descriptor) => descriptor.name.startsWith("Math_"))).toEqual([]);
    }
  });

  it("attaches the dependency-free existing Math_cbrt provider", () => {
    const analysis = analyzeSource(`export function cbrt(value: number): number { return Math.cbrt(value); }`);
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
    if (!declaration) throw new Error("missing cbrt declaration");

    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: identities.next("cbrt").unitId,
      exported: true,
    }).main;
    const semantic = intrinsicInstructions(lowered);
    expect(semantic.map((instr) => instr.id)).toEqual(["math.cbrt"]);
    expect(semantic[0]?.provider).toBeUndefined();

    const prepared = prepareIrRuntimeManifest({
      functions: [lowered],
      sourceFile: analysis.sourceFile.fileName,
      policy: { target: "standalone", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");

    expect(prepared.manifest.intrinsicUses.map((use) => use.id)).toEqual(["math.cbrt"]);
    expect(prepared.manifest.features).toEqual(["math.cbrt"]);
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    expect(prepared.manifest.providers).toEqual([
      expect.objectContaining({
        id: "selfhost.math.cbrt",
        feature: "math.cbrt",
        dependencies: [],
        implementation: { kind: "self-hosted", symbol: "Math_cbrt" },
      }),
    ]);
    expect(intrinsicInstructions(prepared.functions[0]!)[0]?.provider).toMatchObject({
      kind: "callable",
      target: { name: "Math_cbrt", binding: { kind: "intrinsic", symbol: "math.cbrt" } },
    });
  });

  it("is bit-identical to the direct path across signs, subnormals, exact cubes, NaN, and infinities", async () => {
    const source = `export function cbrt(value: number): number { return Math.cbrt(value); }`;
    const [ir, direct] = await Promise.all([
      compile(source, { fileName: "issue-5111-ir.ts", experimentalIR: true, trackIrOutcomes: true }),
      compile(source, { fileName: "issue-5111-direct.ts", experimentalIR: false }),
    ]);
    expectSuccess(ir);
    expectSuccess(direct);
    expect(outcomeFor(ir, "cbrt")).toMatchObject({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false });

    const irCbrt = (await instantiate(ir)).cbrt as (value: number) => number;
    const directCbrt = (await instantiate(direct)).cbrt as (value: number) => number;
    for (const value of [
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      -Number.MAX_VALUE,
      -123.456,
      -27,
      -8,
      -1,
      -Number.MIN_VALUE,
      -0,
      0,
      Number.MIN_VALUE,
      1,
      8,
      27,
      123.456,
      Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(Object.is(irCbrt(value), directCbrt(value)), `cbrt parity for ${String(value)}`).toBe(true);
    }
  });

  it("pins the established native-Math accuracy envelope on an IR-only body", async () => {
    const result = await compile(`export function cbrt(value: number): number { return Math.cbrt(value); }`, {
      fileName: "issue-5111-native-oracle.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expectSuccess(result);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(outcomeFor(result, "cbrt")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    const cbrt = (await instantiate(result)).cbrt as (value: number) => number;

    // This ownership-only checkpoint preserves the established eight-step
    // Newton helper. Its range-edge accuracy is intentionally not disguised by
    // this moderate-value oracle; the direct-parity test above covers MIN/MAX
    // values and proves the migration itself is bit-identical there.
    for (const value of [-123.456, -27, -8, -2.5, -1, -0.125, 0.125, 1, 2.5, 8, 27, 123.456]) {
      const actual = cbrt(value);
      const expected = Math.cbrt(value);
      const relativeError = Math.abs(actual - expected) / Math.max(Math.abs(expected), Number.MIN_VALUE);
      expect(relativeError, `cbrt relative error for ${value}`).toBeLessThanOrEqual(1e-8);
    }
  });

  it("withdraws only cbrt through its narrow rollback", async () => {
    const flag = "JS2WASM_IR_MATH_CBRT";
    const previous = process.env[flag];
    process.env[flag] = "0";
    try {
      const result = await compile(`export function cbrt(value: number): number { return Math.cbrt(value); }`, {
        fileName: "issue-5111-rollback.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      expectSuccess(result);
      expect(outcomeFor(result, "cbrt")).toMatchObject({
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
      fileName: `issue-5111-${_label.replaceAll(" ", "-")}.ts`,
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
