// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { verifyIrBackendLegality } from "../src/ir/backend/legality.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import { forEachInstrDeep, type IrFunction, type IrInstrIntrinsic } from "../src/ir/nodes.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-5125-ir-math-clz32");
const SOURCE = `export function clz32(value: number): number { return Math.clz32(value); }`;
const COMPOSITION_SOURCE = `
  export function add(value: number): number { return Math.clz32(value) + 1; }
  export function nested(value: number): number { return Math.abs(Math.clz32(value)); }
  export function reclz(value: number): number { return Math.clz32(Math.clz32(value)); }
  export function isZeroBits(value: number): boolean { return Math.clz32(value) === 32; }
`;

const EDGE_VALUES = [
  Number.NaN,
  Number.NEGATIVE_INFINITY,
  Number.POSITIVE_INFINITY,
  -0,
  0,
  -Number.MIN_VALUE,
  Number.MIN_VALUE,
  -3.9,
  3.9,
  -1,
  1,
  0x80,
  0x100,
  0x8000,
  0x1_0000,
  0x80_0000,
  0x100_0000,
  0x2000_0000,
  0x4000_0000,
  0x8000_0000,
  0xffff_ffff,
  2 ** 31,
  2 ** 32 - 1,
  2 ** 32,
  2 ** 32 + 1,
  -(2 ** 32) - 1,
  2 ** 63,
  2 ** 63 + 2048,
  2 ** 64,
  2 ** 64 + 4096,
  2 ** 65 + 8192,
  -(2 ** 64) - 4096,
  -1e20,
  1e20,
  -Number.MAX_VALUE,
  Number.MAX_VALUE,
] as const;

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
}

function outcomeFor(result: CompileResult, displayName: string): IrObservedOutcome {
  const outcome = result.irOutcomes?.find((candidate) => candidate.displayName === displayName);
  expect(outcome, `missing IR outcome for ${displayName}`).toBeDefined();
  if (!outcome) throw new Error(`missing IR outcome for ${displayName}`);
  return outcome;
}

async function instantiate(result: CompileResult): Promise<Record<string, unknown>> {
  const imports = result.importObject ?? buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, unknown>;
  (imports as { setExports?: (value: Record<string, unknown>) => void }).setExports?.(exports);
  return exports;
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

function lowerSource(): IrFunction {
  const analysis = analyzeSource(SOURCE);
  const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
  if (!declaration) throw new Error("missing clz32 declaration");
  return lowerFunctionAstToIr(declaration, {
    ownerUnitId: identities.next("clz32").unitId,
    exported: true,
  }).main;
}

function minimalResolver(): IrLowerResolver {
  let nextType = 0;
  return {
    resolveFunc: () => 0,
    resolveGlobal: () => {
      throw new Error("resolveGlobal not used in this test");
    },
    resolveType: () => {
      throw new Error("resolveType not used in this test");
    },
    internFuncType: () => nextType++,
  };
}

const exclusionCases = [
  [
    "shadowed Math",
    `export function f(x: number): number {
      const Math: number = x;
      // @ts-expect-error #5125 shadowed Math is intentionally not ambient.
      return Math.clz32(x);
    }`,
  ],
  ["aliased clz32", `const clz32 = Math.clz32; export function f(x: number): number { return clz32(x); }`],
  ["optional invocation", `export function f(x: number): number { return Math.clz32?.(x); }`],
  ["spread argument", `export function f(x: number): number { return Math.clz32(...([x] as [number])); }`],
  [
    "wrong arity",
    `export function f(x: number): number {
      // @ts-expect-error #5125 intentionally exercises extra arity.
      return Math.clz32(x, x);
    }`,
  ],
] as const;

describe("#5125 exact ambient Math.clz32 IR ownership", () => {
  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("claims the exact one-number call on the %s target", async (label, target) => {
    const result = await compile(SOURCE, {
      fileName: `issue-5125-${label}.ts`,
      ...(target === undefined ? {} : { target }),
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
    });
    expectSuccess(result);
    expect(outcomeFor(result, "clz32")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.irCompiledFuncs ?? []).toContain("clz32");
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    const wat = result.wat ?? "";
    expect(wat).toContain("i64.reinterpret_f64");
    expect(wat).toContain("i32.clz");
    expect(wat).toContain("f64.convert_i32_s");
    expect(wat).not.toContain("i64.trunc_sat_f64_s");
    expect(wat).not.toContain("$Math_clz32");
    const bodyStart = wat.indexOf("  (func $clz32");
    const bodyEnd = wat.indexOf("\n  (func $", bodyStart + 1);
    const clz32Wat = wat.slice(bodyStart, bodyEnd < 0 ? wat.length : bodyEnd);
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    expect(clz32Wat).not.toContain("call");
    expect(clz32Wat).not.toContain("$__toUint32");

    const clz32 = (await instantiate(result)).clz32 as (value: number) => number;
    for (const value of EDGE_VALUES) {
      expect(clz32(value), `${label} Math.clz32(${String(value)})`).toBe(Math.clz32(value));
    }
    if (target === "standalone") {
      expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
      expect(result.imports).toEqual([]);
    } else {
      expect(result.imports.filter((descriptor) => descriptor.name.startsWith("Math_"))).toEqual([]);
    }
  });

  it("claims the same closed composite on production linear", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-5125-linear.ts",
      target: "linear",
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
    });
    expectSuccess(result);
    expect(getLastLinearIrReport()?.compiled).toContain("clz32");
    expect(getLastLinearIrReport()?.rejected).toEqual([]);
    expect(result.wat).toContain("i64.reinterpret_f64");
    expect(result.wat).toContain("i32.clz");
    const clz32 = (await instantiate(result)).clz32 as (value: number) => number;
    for (const value of EDGE_VALUES) expect(clz32(value)).toBe(Math.clz32(value));
  });

  it("attaches one dependency-free host-free composite provider for both Wasm backends", () => {
    const lowered = lowerSource();
    const semantic = intrinsicInstructions(lowered);
    expect(semantic).toEqual([
      expect.objectContaining({
        id: "math.clz32",
        resultType: { kind: "val", val: { kind: "f64" } },
      }),
    ]);
    expect(semantic[0]?.provider).toBeUndefined();
    expect(() => lowerIrFunctionToWasm(lowered, minimalResolver())).toThrowError(
      /semantic intrinsic math\.clz32 has no frozen provider/,
    );

    for (const backend of ["wasmgc", "linear"] as const) {
      const prepared = prepareIrRuntimeManifest({
        functions: [lowered],
        sourceFile: "issue-5125-provider.ts",
        policy: { target: "standalone", backend },
      });
      if (!prepared) throw new Error("expected a non-empty runtime manifest");
      expect(prepared.manifest.features).toEqual(["math.clz32"]);
      expect(prepared.manifest.hostCapabilities).toEqual([]);
      expect(prepared.manifest.providers).toEqual([
        expect.objectContaining({
          id: "backend.math.clz32",
          feature: "math.clz32",
          dependencies: [],
          hostCapabilities: [],
          implementation: { kind: "backend-composite", operation: "math.clz32" },
        }),
      ]);
      expect(intrinsicInstructions(prepared.functions[0]!)[0]?.provider).toEqual({
        kind: "backend-composite",
        operation: "math.clz32",
      });
      expect(verifyIrBackendLegality(prepared.functions[0]!, backend)).toEqual([]);
      expect(verifyIrBackendLegality(prepared.functions[0]!, "bytecode")[0]?.message).toContain(
        "bytecode backend does not support semantic intrinsic 'math.clz32'",
      );
      expect(verifyIrBackendLegality(prepared.functions[0]!, "porffor")[0]?.message).toContain(
        "porffor backend does not support semantic intrinsic 'math.clz32'",
      );
    }
  });

  it("keeps the JavaScript Number boundary through arithmetic, nesting, and comparison", async () => {
    const result = await compile(COMPOSITION_SOURCE, {
      fileName: "issue-5125-composition.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expectSuccess(result);
    for (const name of ["add", "nested", "reclz", "isZeroBits"]) {
      expect(outcomeFor(result, name)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
    }
    const exports = await instantiate(result);
    const value = 0x100;
    expect((exports.add as (input: number) => number)(value)).toBe(Math.clz32(value) + 1);
    expect((exports.nested as (input: number) => number)(value)).toBe(Math.abs(Math.clz32(value)));
    expect((exports.reclz as (input: number) => number)(value)).toBe(Math.clz32(Math.clz32(value)));
    expect((exports.isZeroBits as (input: number) => number)(0)).toBe(1);
  });

  it("matches direct codegen for huge finite inputs", async () => {
    const [ir, direct] = await Promise.all([
      compile(SOURCE, { fileName: "issue-5125-ir-parity.ts", experimentalIR: true, trackIrOutcomes: true }),
      compile(SOURCE, { fileName: "issue-5125-direct-parity.ts", experimentalIR: false }),
    ]);
    expectSuccess(ir);
    expectSuccess(direct);
    const [irExports, directExports] = await Promise.all([instantiate(ir), instantiate(direct)]);
    const irClz32 = irExports.clz32 as (value: number) => number;
    const directClz32 = directExports.clz32 as (value: number) => number;
    for (const value of EDGE_VALUES) expect(irClz32(value)).toBe(directClz32(value));
  });

  it("fails loudly on a malformed backend composite", () => {
    const lowered = lowerSource();
    const malformed = {
      ...lowered,
      blocks: lowered.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((instr) =>
          instr.kind === "intrinsic"
            ? { ...instr, provider: { kind: "backend-composite", operation: "math.unknown" } }
            : instr,
        ),
      })),
    } as unknown as IrFunction;
    expect(() => lowerIrFunctionToWasm(malformed, minimalResolver())).toThrowError(/unsupported backend composite/);
  });

  it("withdraws only clz32 through its narrow rollback", async () => {
    const flag = "JS2WASM_IR_MATH_CLZ32";
    const previous = process.env[flag];
    process.env[flag] = "0";
    try {
      const result = await compile(SOURCE, {
        fileName: "issue-5125-rollback.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      expectSuccess(result);
      expect(outcomeFor(result, "clz32")).toMatchObject({
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
      fileName: `issue-5125-${label.replaceAll(" ", "-")}.ts`,
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
  });
});
