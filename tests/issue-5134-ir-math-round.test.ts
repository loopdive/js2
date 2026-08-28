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

const identities = createTestIrFunctionIdentityFactory("issue-5134-ir-math-round");

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

const exclusionCases = [
  [
    "shadowed Math",
    `export function f(x: number): number {
      const Math: number = x;
      // @ts-expect-error #5134 shadowed Math is intentionally not ambient.
      return Math.round(x);
    }`,
  ],
  ["aliased round", `const round = Math.round; export function f(x: number): number { return round(x); }`],
  ["computed round", `export function f(x: number): number { return Math["round"](x); }`],
  ["optional invocation", `export function f(x: number): number { return Math.round?.(x); }`],
  ["optional receiver", `export function f(x: number): number { return Math?.round(x); }`],
  [
    "wrong arity",
    `export function f(x: number): number {
      // @ts-expect-error #5134 intentionally exercises extra arity.
      return Math.round(x, x);
    }`,
  ],
  ["spread argument", `export function f(x: number): number { return Math.round(...([x] as [number])); }`],
  [
    "non-number argument",
    `export function f(): number {
      const text: string = "1";
      return Math.round(text as never);
    }`,
  ],
] as const;

describe("#5134 exact ambient Math.round IR ownership", () => {
  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("claims the exact one-number call on the %s target", async (label, target) => {
    const result = await compile(`export function round(value: number): number { return Math.round(value); }`, {
      fileName: `issue-5134-${label}.ts`,
      ...(target === undefined ? {} : { target }),
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
    });
    expectSuccess(result);
    expect(outcomeFor(result, "round")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.irCompiledFuncs ?? []).toContain("round");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.wat).toContain("$Math_round");

    const round = (await instantiate(result)).round as (value: number) => number;
    expect(round(-1.5)).toBe(-1);
    expect(Object.is(round(-0.5), -0)).toBe(true);
    expect(Object.is(round(-Number.MIN_VALUE), -0)).toBe(true);
    expect(Object.is(round(-0), -0)).toBe(true);
    expect(round(0.5)).toBe(1);
    expect(round(1.5)).toBe(2);
    if (target === "standalone") {
      expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
      expect(result.imports).toEqual([]);
    } else {
      expect(result.imports.filter((descriptor) => descriptor.name.startsWith("Math_"))).toEqual([]);
    }
  });

  it("attaches one dependency-free host-free Math_round provider", () => {
    const analysis = analyzeSource(`export function round(value: number): number { return Math.round(value); }`);
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
    if (!declaration) throw new Error("missing round declaration");

    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: identities.next("round").unitId,
      exported: true,
    }).main;
    const semantic = intrinsicInstructions(lowered);
    expect(semantic.map((instr) => instr.id)).toEqual(["math.round"]);
    expect(semantic[0]?.args).toHaveLength(1);
    expect(semantic[0]?.provider).toBeUndefined();

    const prepared = prepareIrRuntimeManifest({
      functions: [lowered],
      sourceFile: analysis.sourceFile.fileName,
      policy: { target: "standalone", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");

    expect(prepared.manifest.intrinsicUses.map((use) => use.id)).toEqual(["math.round"]);
    expect(prepared.manifest.features).toEqual(["math.round"]);
    expect(prepared.manifest.hostCapabilities).toEqual([]);
    expect(prepared.manifest.providers).toEqual([
      expect.objectContaining({
        id: "selfhost.math.round",
        feature: "math.round",
        dependencies: [],
        implementation: { kind: "self-hosted", symbol: "Math_round" },
      }),
    ]);
    expect(intrinsicInstructions(prepared.functions[0]!)[0]?.provider).toMatchObject({
      kind: "callable",
      target: { name: "Math_round", binding: { kind: "intrinsic", symbol: "math.round" } },
    });
  });

  it("is raw-bit identical to direct codegen across NaNs, zeros, ties, subnormals, range edges, and infinities", async () => {
    const source = `export function round(value: number): number { return Math.round(value); }`;
    const [ir, direct] = await Promise.all([
      compile(source, { fileName: "issue-5134-ir.ts", experimentalIR: true, trackIrOutcomes: true }),
      compile(source, { fileName: "issue-5134-direct.ts", experimentalIR: false }),
    ]);
    expectSuccess(ir);
    expectSuccess(direct);
    expect(outcomeFor(ir, "round")).toMatchObject({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false });

    const irRound = (await instantiate(ir)).round as (value: number) => number;
    const directRound = (await instantiate(direct)).round as (value: number) => number;
    for (const value of [
      numberFromBits(0x7ff8_0000_0000_0001n),
      numberFromBits(0xfff8_0000_0000_0042n),
      Number.NEGATIVE_INFINITY,
      -Number.MAX_VALUE,
      -Number.MAX_SAFE_INTEGER,
      nextDown(-1.5),
      -1.5,
      nextUp(-1.5),
      nextDown(-0.5),
      -0.5,
      nextUp(-0.5),
      -Number.MIN_VALUE,
      -0,
      0,
      Number.MIN_VALUE,
      nextDown(0.5),
      0.5,
      nextUp(0.5),
      nextDown(1.5),
      1.5,
      nextUp(1.5),
      Number.MAX_SAFE_INTEGER,
      Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(numberBits(irRound(value)), `round parity for ${String(value)}`).toBe(numberBits(directRound(value)));
    }
  });

  it("leaves the established production-linear limitation outside IR ownership", async () => {
    const result = await compile(`export function round(value: number): number { return Math.round(value); }`, {
      fileName: "issue-5134-linear.ts",
      target: "linear",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain("Unsupported method call: .round()");
    expect(result.irOutcomes ?? []).toEqual([]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("withdraws only round through its narrow rollback", async () => {
    const flag = "JS2WASM_IR_MATH_ROUND";
    const previous = process.env[flag];
    process.env[flag] = "0";
    try {
      const result = await compile(`export function round(value: number): number { return Math.round(value); }`, {
        fileName: "issue-5134-rollback.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      expectSuccess(result);
      expect(outcomeFor(result, "round")).toMatchObject({
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

  it.each(exclusionCases)("rejects %s before claim", async (label, source) => {
    const result = await compile(source, {
      fileName: `issue-5134-${label.replaceAll(" ", "-")}.ts`,
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
