// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { INTRINSIC_DEFINITIONS } from "../src/ir/intrinsics.js";
import { forEachInstrDeep, irVal, type IrFunction, type IrInstrIntrinsic } from "../src/ir/nodes.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-5101-ir-math-atan");
const F64 = irVal({ kind: "f64" });

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

async function instantiateHost(result: CompileResult): Promise<Record<string, unknown>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, unknown>;
  (imports as { setExports?: (value: Record<string, unknown>) => void }).setExports?.(exports);
  return exports;
}

describe("#5101 exact ambient Math.atan IR ownership", () => {
  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("claims the exact one-number call on the %s target", async (_label, target) => {
    const result = await compile(`export function atan(value: number): number { return Math.atan(value); }`, {
      fileName: `issue-5101-${_label}.ts`,
      ...(target === undefined ? {} : { target }),
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
    });
    expectSuccess(result);

    expect(outcomeFor(result, "atan")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.irCompiledFuncs ?? []).toContain("atan");
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    const exports = await instantiateHost(result);
    const atan = exports.atan as (value: number) => number;
    expect(typeof atan).toBe("function");
    expect(Object.is(atan(0), 0)).toBe(true);

    if (target === "standalone") {
      const module = new WebAssembly.Module(result.binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      expect(result.imports).toEqual([]);
    } else {
      expect(result.imports.filter((descriptor) => descriptor.name === "Math_atan")).toEqual([]);
    }
    expect(result.wat).toContain("$Math_atan");
  });

  it("lowers to a provider-free semantic intrinsic before attaching the existing Math_atan provider", () => {
    const analysis = analyzeSource(`
      export function atan(value: number): number {
        return Math.atan(value);
      }
    `);
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
    if (!declaration) throw new Error("missing atan declaration");

    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: identities.next("atan").unitId,
      exported: true,
    }).main;
    const semantic = intrinsicInstructions(lowered);
    expect(semantic).toHaveLength(1);
    expect(semantic[0]).toMatchObject({
      id: "math.atan",
      version: INTRINSIC_DEFINITIONS["math.atan"].signature.version,
      resultType: F64,
    });
    expect(semantic[0]?.provider).toBeUndefined();

    const prepared = prepareIrRuntimeManifest({
      functions: [lowered],
      sourceFile: analysis.sourceFile.fileName,
      policy: { target: "standalone", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");

    expect(prepared.manifest.intrinsicUses).toHaveLength(1);
    expect(prepared.manifest.intrinsicUses[0]?.id).toBe("math.atan");
    expect(prepared.manifest.features).toEqual(["math.atan"]);
    expect(prepared.manifest.providers).toEqual([
      expect.objectContaining({
        id: "selfhost.math.atan",
        feature: "math.atan",
        implementation: { kind: "self-hosted", symbol: "Math_atan" },
      }),
    ]);
    expect(intrinsicInstructions(prepared.functions[0]!)[0]).toMatchObject({
      id: "math.atan",
      provider: {
        kind: "callable",
        target: { name: "Math_atan", binding: { kind: "intrinsic", symbol: "math.atan" } },
      },
    });
  });

  it("matches the direct path for finite values, NaN, infinities, and signed zero", async () => {
    const source = `export function atan(value: number): number { return Math.atan(value); }`;
    const [ir, direct] = await Promise.all([
      compile(source, { fileName: "issue-5101-ir.ts", experimentalIR: true, trackIrOutcomes: true }),
      compile(source, { fileName: "issue-5101-direct.ts", experimentalIR: false }),
    ]);
    expectSuccess(ir);
    expectSuccess(direct);
    expect(outcomeFor(ir, "atan")).toMatchObject({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false });

    const irAtan = (await instantiateHost(ir)).atan as (value: number) => number;
    const directAtan = (await instantiateHost(direct)).atan as (value: number) => number;
    expect(Number.isNaN(irAtan(Number.NaN))).toBe(true);
    expect(Number.isNaN(directAtan(Number.NaN))).toBe(true);
    for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(irAtan(value), `IR result for ${String(value)}`).toBe(directAtan(value));
    }
    for (const value of [0, -0]) {
      expect(Object.is(irAtan(value), directAtan(value)), `signed-zero parity for ${String(value)}`).toBe(true);
    }
    for (const value of [0.75, -0.75]) {
      expect(irAtan(value), `finite path parity for ${String(value)}`).toBe(directAtan(value));
    }
  });

  it.each([
    [
      "shadowed Math",
      `export function f(x: number): number {
      const Math: number = x;
      // @ts-expect-error #5101 shadowed Math is intentionally not ambient.
      return Math.atan(x);
    }`,
    ],
    [
      "aliased atan",
      `const atan = Math.atan;
      export function f(x: number): number { return atan(x); }`,
    ],
    [
      "wrong arity",
      `export function f(x: number): number {
      // @ts-expect-error #5101 intentionally exercises extra arity.
      return Math.atan(x, x);
    }`,
    ],
    [
      "spread argument",
      `export function f(x: number): number {
      return Math.atan(...([x] as [number]));
    }`,
    ],
    [
      "non-number argument",
      `export function f(x: number): number {
      const text: string = "1";
      return Math.atan(text as never);
    }`,
    ],
  ])("rejects %s before claim", async (_label, source) => {
    const result = await compile(source, {
      fileName: `issue-5101-${_label.replaceAll(" ", "-")}.ts`,
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
