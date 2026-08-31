// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import { forEachInstrDeep, type IrFunction, type IrInstrIntrinsic } from "../src/ir/nodes.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-5135-ir-math-fround");
const SOURCE = `export function fround(value: number): number { return Math.fround(value); }`;

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
  const imports = result.importObject ?? buildImports(result.imports, undefined, result.stringPool);
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

function f32FromBits(bits: number): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, bits);
  return view.getFloat32(0);
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

function parityValues(): number[] {
  const minSubnormal = f32FromBits(0x0000_0001);
  const maxSubnormal = f32FromBits(0x007f_ffff);
  const minNormal = f32FromBits(0x0080_0000);
  const maxFinite = f32FromBits(0x7f7f_ffff);
  const zeroTie = 2 ** -150;
  const secondSubnormalTie = 3 * 2 ** -150;
  const normalBoundaryTie = minNormal - minSubnormal / 2;
  const evenDownTie = 1 + 2 ** -24;
  const evenUpTie = 1 + 3 * 2 ** -24;
  const overflowTie = maxFinite + 2 ** 103;
  const positive = [
    Number.MIN_VALUE,
    nextDown(zeroTie),
    zeroTie,
    nextUp(zeroTie),
    minSubnormal,
    nextDown(secondSubnormalTie),
    secondSubnormalTie,
    nextUp(secondSubnormalTie),
    maxSubnormal,
    nextDown(normalBoundaryTie),
    normalBoundaryTie,
    nextUp(normalBoundaryTie),
    minNormal,
    nextDown(evenDownTie),
    evenDownTie,
    nextUp(evenDownTie),
    nextDown(evenUpTie),
    evenUpTie,
    nextUp(evenUpTie),
    maxFinite,
    nextDown(overflowTie),
    overflowTie,
    nextUp(overflowTie),
    Number.MAX_VALUE,
    Number.POSITIVE_INFINITY,
  ];
  return [
    numberFromBits(0x7ff0_0000_0000_0001n),
    numberFromBits(0x7ff8_0000_0000_0042n),
    numberFromBits(0xfff0_0000_0000_0001n),
    numberFromBits(0xfff8_0000_0000_0042n),
    ...positive.flatMap((value) => [-value, value]),
    -0,
    0,
  ];
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
      // @ts-expect-error #5135 shadowed Math is intentionally not ambient.
      return Math.fround(x);
    }`,
  ],
  ["aliased fround", `const fround = Math.fround; export function f(x: number): number { return fround(x); }`],
  ["computed fround", `export function f(x: number): number { return Math["fround"](x); }`],
  ["optional invocation", `export function f(x: number): number { return Math.fround?.(x); }`],
  ["optional receiver", `export function f(x: number): number { return Math?.fround(x); }`],
  [
    "wrong arity",
    `export function f(x: number): number {
      // @ts-expect-error #5135 intentionally exercises extra arity.
      return Math.fround(x, x);
    }`,
  ],
  ["spread argument", `export function f(x: number): number { return Math.fround(...([x] as [number])); }`],
  [
    "non-number argument",
    `export function f(): number {
      const text: string = "1";
      return Math.fround(text as never);
    }`,
  ],
] as const;

describe("#5135 exact ambient Math.fround IR ownership", () => {
  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("claims the exact one-number call on the %s target", async (label, target) => {
    const result = await compile(SOURCE, {
      fileName: `issue-5135-${label}.ts`,
      ...(target === undefined ? {} : { target }),
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
    });
    expectSuccess(result);
    expect(outcomeFor(result, "fround")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.irCompiledFuncs ?? []).toContain("fround");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.wat).not.toContain("$Math_fround");
    const demote = result.wat?.indexOf("f32.demote_f64") ?? -1;
    const promote = result.wat?.indexOf("f64.promote_f32") ?? -1;
    expect(demote).toBeGreaterThanOrEqual(0);
    expect(promote).toBeGreaterThan(demote);

    const fround = (await instantiate(result)).fround as (value: number) => number;
    expect(fround(1 + 2 ** -24)).toBe(1);
    expect(fround(1 + 3 * 2 ** -24)).toBe(1 + 2 ** -22);
    expect(Object.is(fround(-(2 ** -150)), -0)).toBe(true);
    if (target === "standalone") {
      expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
      expect(result.imports).toEqual([]);
    } else {
      expect(result.imports.filter((descriptor) => descriptor.name.startsWith("Math_"))).toEqual([]);
    }
  });

  it("claims and executes the same closed sequence on production linear", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-5135-linear.ts",
      target: "linear",
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
    });
    expectSuccess(result);
    const report = getLastLinearIrReport();
    expect(report?.compiled).toContain("fround");
    expect(report?.rejected).toEqual([]);
    expect(result.wat).toContain("f32.demote_f64");
    expect(result.wat).toContain("f64.promote_f32");
    const fround = (await instantiate(result)).fround as (value: number) => number;
    expect(fround(1 + 2 ** -24)).toBe(1);
    expect(Object.is(fround(-0), -0)).toBe(true);
  });

  it("attaches one dependency-free host-free sequence provider for both Wasm backends", () => {
    const analysis = analyzeSource(SOURCE);
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
    if (!declaration) throw new Error("missing fround declaration");

    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: identities.next("fround").unitId,
      exported: true,
    }).main;
    const semantic = intrinsicInstructions(lowered);
    expect(semantic.map((instr) => instr.id)).toEqual(["math.fround"]);
    expect(semantic[0]?.args).toHaveLength(1);
    expect(semantic[0]?.provider).toBeUndefined();

    for (const backend of ["wasmgc", "linear"] as const) {
      const prepared = prepareIrRuntimeManifest({
        functions: [lowered],
        sourceFile: analysis.sourceFile.fileName,
        policy: { target: "standalone", backend },
      });
      if (!prepared) throw new Error("expected a non-empty runtime manifest");
      expect(prepared.manifest.intrinsicUses.map((use) => use.id)).toEqual(["math.fround"]);
      expect(prepared.manifest.features).toEqual(["math.fround"]);
      expect(prepared.manifest.hostCapabilities).toEqual([]);
      expect(prepared.manifest.providers).toEqual([
        expect.objectContaining({
          id: "backend.f64.fround",
          feature: "math.fround",
          dependencies: [],
          implementation: { kind: "backend-sequence", sequence: "f64.fround" },
        }),
      ]);
      expect(intrinsicInstructions(prepared.functions[0]!)[0]?.provider).toEqual({
        kind: "backend-sequence",
        sequence: "f64.fround",
      });
    }
  });

  it("is raw-bit identical to direct codegen on WasmGC and to the same oracle on linear", async () => {
    const [irGc, directGc, irLinear] = await Promise.all([
      compile(SOURCE, { fileName: "issue-5135-ir-gc.ts", experimentalIR: true, trackIrOutcomes: true }),
      compile(SOURCE, { fileName: "issue-5135-direct-gc.ts", experimentalIR: false }),
      compile(SOURCE, {
        fileName: "issue-5135-ir-linear-parity.ts",
        target: "linear",
        experimentalIR: true,
        trackIrOutcomes: true,
      }),
    ]);
    for (const result of [irGc, directGc, irLinear]) expectSuccess(result);
    expect(outcomeFor(irGc, "fround")).toMatchObject({ kind: "emitted", irBodyEmitted: true });

    const [irGcExports, directGcExports, irLinearExports] = await Promise.all([
      instantiate(irGc),
      instantiate(directGc),
      instantiate(irLinear),
    ]);
    const directOracle = directGcExports.fround;
    const pairs = [
      [irGcExports.fround, directOracle, "wasmgc"],
      [irLinearExports.fround, directOracle, "linear"],
    ] as const;
    for (const [irExport, directExport, backend] of pairs) {
      const irFround = irExport as (value: number) => number;
      const directFround = directExport as (value: number) => number;
      for (const value of parityValues()) {
        const label = `${backend} fround parity for 0x${numberBits(value).toString(16)}`;
        expect(numberBits(irFround(value)), label).toBe(numberBits(directFround(value)));
      }
    }
  });

  it("fails loudly on a malformed backend sequence", () => {
    const analysis = analyzeSource(SOURCE);
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
    if (!declaration) throw new Error("missing fround declaration");
    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: identities.next("malformed").unitId,
      exported: true,
    }).main;
    const malformed = {
      ...lowered,
      blocks: lowered.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((instr) =>
          instr.kind === "intrinsic"
            ? {
                ...instr,
                provider: { kind: "backend-sequence", sequence: "f64.unknown" },
              }
            : instr,
        ),
      })),
    } as unknown as IrFunction;
    expect(() => lowerIrFunctionToWasm(malformed, minimalResolver())).toThrowError(/unsupported backend sequence/);
  });

  it.each(exclusionCases)("rejects %s before claim", async (label, source) => {
    const result = await compile(source, {
      fileName: `issue-5135-${label.replaceAll(" ", "-")}.ts`,
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
