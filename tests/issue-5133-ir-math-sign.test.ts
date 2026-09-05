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

const identities = createTestIrFunctionIdentityFactory("issue-5133-ir-math-sign");

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

function numberFromBits(bits: bigint): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

function numberBits(value: number): bigint {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  return view.getBigUint64(0);
}

const exclusionCases = [
  [
    "shadowed Math",
    `export function f(x: number): number {
      const Math: number = x;
      // @ts-expect-error #5133 shadowed Math is intentionally not ambient.
      return Math.sign(x);
    }`,
  ],
  ["aliased sign", `const sign = Math.sign; export function f(x: number): number { return sign(x); }`],
  ["computed sign", `export function f(x: number): number { return Math["sign"](x); }`],
  ["optional invocation", `export function f(x: number): number { return Math.sign?.(x); }`],
  ["optional receiver", `export function f(x: number): number { return Math?.sign(x); }`],
  [
    "wrong arity",
    `export function f(x: number): number {
      // @ts-expect-error #5133 intentionally exercises extra arity.
      return Math.sign(x, x);
    }`,
  ],
  ["spread argument", `export function f(x: number): number { return Math.sign(...([x] as [number])); }`],
  [
    "non-number argument",
    `export function f(): number {
      const text: string = "1";
      return Math.sign(text as never);
    }`,
  ],
] as const;

describe("#5133 exact ambient Math.sign IR ownership", () => {
  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("claims the exact one-number call on the %s target", async (label, target) => {
    const result = await compile(`export function sign(value: number): number { return Math.sign(value); }`, {
      fileName: `issue-5133-${label}.ts`,
      ...(target === undefined ? {} : { target }),
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
    });
    expectSuccess(result);
    expect(outcomeFor(result, "sign")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.irCompiledFuncs ?? []).toContain("sign");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    const wat = result.wat ?? "";
    const providerStart = wat.indexOf("  (func $Math_sign");
    const providerEnd = wat.indexOf("\n  (func $", providerStart + 1);
    const providerWat = wat.slice(providerStart, providerEnd < 0 ? wat.length : providerEnd);
    expect(providerStart).toBeGreaterThanOrEqual(0);
    expect(providerWat).toMatch(/f64\.const NaN\s+f64\.abs/);

    const sign = (await instantiate(result)).sign as (value: number) => number;
    expect(sign(-1)).toBe(-1);
    expect(Object.is(sign(-0), -0)).toBe(true);
    expect(Object.is(sign(0), 0)).toBe(true);
    expect(sign(1)).toBe(1);
    if (target === "standalone") {
      expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
      expect(result.imports).toEqual([]);
    } else {
      expect(result.imports.filter((descriptor) => descriptor.name.startsWith("Math_"))).toEqual([]);
    }
  });

  it("attaches one dependency-free host-free Math_sign provider", () => {
    const analysis = analyzeSource(`export function sign(value: number): number { return Math.sign(value); }`);
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
    if (!declaration) throw new Error("missing sign declaration");

    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: identities.next("sign").unitId,
      exported: true,
    }).main;
    const semantic = intrinsicInstructions(lowered);
    expect(semantic.map((instr) => instr.id)).toEqual(["math.sign"]);
    expect(semantic[0]?.args).toHaveLength(1);
    expect(semantic[0]?.provider).toBeUndefined();

    const prepared = prepareIrRuntimeManifest({
      functions: [lowered],
      sourceFile: analysis.sourceFile.fileName,
      policy: { target: "standalone", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");

    expect(prepared.manifest.intrinsicUses.map((use) => use.id)).toEqual(["math.sign"]);
    expect(prepared.manifest.features).toEqual(["math.sign"]);
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    expect(prepared.manifest.providers).toEqual([
      expect.objectContaining({
        id: "selfhost.math.sign",
        feature: "math.sign",
        dependencies: [],
        implementation: { kind: "self-hosted", symbol: "Math_sign" },
      }),
    ]);
    expect(intrinsicInstructions(prepared.functions[0]!)[0]?.provider).toMatchObject({
      kind: "callable",
      target: { name: "Math_sign", binding: { kind: "intrinsic", symbol: "math.sign" } },
    });
  });

  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("is bit-identical to direct codegen across NaNs and numeric classes on %s", async (label, target) => {
    const source = `export function sign(value: number): number { return Math.sign(value); }`;
    const [ir, direct] = await Promise.all([
      compile(source, {
        fileName: `issue-5133-ir-${label}.ts`,
        ...(target === undefined ? {} : { target }),
        experimentalIR: true,
        trackIrOutcomes: true,
      }),
      compile(source, {
        fileName: `issue-5133-direct-${label}.ts`,
        ...(target === undefined ? {} : { target }),
        experimentalIR: false,
      }),
    ]);
    expectSuccess(ir);
    expectSuccess(direct);
    expect(outcomeFor(ir, "sign")).toMatchObject({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false });

    const irSign = (await instantiate(ir)).sign as (value: number) => number;
    const directSign = (await instantiate(direct)).sign as (value: number) => number;
    for (const value of [
      numberFromBits(0x7ff8_0000_0000_0001n),
      numberFromBits(0xfff8_0000_0000_0042n),
      Number.NEGATIVE_INFINITY,
      -Number.MAX_VALUE,
      -1,
      -Number.MIN_VALUE,
      -0,
      0,
      Number.MIN_VALUE,
      1,
      Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
    ]) {
      const inputBits = numberBits(value);
      const irBits = numberBits(irSign(value));
      const directBits = numberBits(directSign(value));
      if (Number.isNaN(value)) {
        expect(irBits, `IR canonical NaN for input 0x${inputBits.toString(16)}`).toBe(0x7ff8_0000_0000_0000n);
        expect(directBits, `direct canonical NaN for input 0x${inputBits.toString(16)}`).toBe(0x7ff8_0000_0000_0000n);
      }
      expect(irBits, `sign parity for input 0x${inputBits.toString(16)}`).toBe(directBits);
    }
  });

  it("leaves the established production-linear limitation outside IR ownership", async () => {
    const result = await compile(`export function sign(value: number): number { return Math.sign(value); }`, {
      fileName: "issue-5133-linear.ts",
      target: "linear",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain("Unsupported method call: .sign()");
    expect(result.irOutcomes ?? []).toEqual([]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each(exclusionCases)("rejects %s before claim", async (label, source) => {
    const result = await compile(source, {
      fileName: `issue-5133-${label.replaceAll(" ", "-")}.ts`,
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
