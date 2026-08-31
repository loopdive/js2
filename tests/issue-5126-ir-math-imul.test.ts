// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { verifyIrBackendLegality } from "../src/ir/backend/legality.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import { forEachInstrDeep, type IrFunction, type IrInstrIntrinsic } from "../src/ir/nodes.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-5126-ir-math-imul");
const SOURCE = `export function imul(left: number, right: number): number { return Math.imul(left, right); }`;
const COMPOSITION_SOURCE = `
  export function add(left: number, right: number): number { return Math.imul(left, right) + 1; }
  export function nested(left: number, right: number): number { return Math.imul(Math.imul(left, right), 3); }
  export function clz(left: number, right: number): number { return Math.clz32(Math.imul(left, right)); }
  export function unsigned(left: number, right: number): number { return Math.imul(left, right) >>> 0; }
`;

const EDGE_PAIRS = [
  [Number.NaN, 1],
  [Number.NEGATIVE_INFINITY, 3],
  [Number.POSITIVE_INFINITY, -3],
  [-0, 7],
  [0, -7],
  [-3.9, 5.9],
  [3.9, -5.9],
  [-1, 2],
  [0xffff_ffff, 2],
  [0x8000_0000, 2],
  [0x7fff_ffff, 0x7fff_ffff],
  [0xffff_ffff, 0xffff_ffff],
  [2 ** 32 + 1, 2 ** 32 + 1],
  [-(2 ** 32) - 1, 3],
  [2 ** 63 + 2048, 3],
  [2 ** 64 + 4096, 5],
  [2 ** 65 + 8192, -7],
  [2 ** 80, 11],
  [-1e20, 13],
  [1e20, -13],
  [Number.MAX_VALUE, 17],
  [-Number.MAX_VALUE, -17],
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
  if (!declaration) throw new Error("missing imul declaration");
  return lowerFunctionAstToIr(declaration, {
    ownerUnitId: identities.next("imul").unitId,
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
    `export function f(x: number, y: number): number {
      const Math: number = x;
      // @ts-expect-error #5126 shadowed Math is intentionally not ambient.
      return Math.imul(x, y);
    }`,
  ],
  ["aliased imul", `const imul = Math.imul; export function f(x: number, y: number): number { return imul(x, y); }`],
  ["optional invocation", `export function f(x: number, y: number): number { return Math.imul?.(x, y); }`],
  [
    "spread arguments",
    `export function f(x: number, y: number): number { return Math.imul(...([x, y] as [number, number])); }`,
  ],
  [
    "wrong arity",
    `export function f(x: number, y: number): number {
      // @ts-expect-error #5126 intentionally exercises extra arity.
      return Math.imul(x, y, x);
    }`,
  ],
  [
    "non-number argument",
    `export function f(y: number): number {
      const text: string = "2";
      return Math.imul(text as never, y);
    }`,
  ],
] as const;

describe("#5126 exact ambient Math.imul IR ownership", () => {
  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("claims the exact two-number call on the %s target", async (label, target) => {
    const result = await compile(SOURCE, {
      fileName: `issue-5126-${label}.ts`,
      ...(target === undefined ? {} : { target }),
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
    });
    expectSuccess(result);
    expect(outcomeFor(result, "imul")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    const wat = result.wat ?? "";
    const bodyStart = wat.indexOf("  (func $imul");
    const bodyEnd = wat.indexOf("\n  (func $", bodyStart + 1);
    const imulWat = wat.slice(bodyStart, bodyEnd < 0 ? wat.length : bodyEnd);
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    expect(imulWat.match(/i64\.reinterpret_f64/g)).toHaveLength(2);
    expect(imulWat).toContain("i32.mul");
    expect(imulWat).toContain("f64.convert_i32_s");
    expect(imulWat).not.toContain("i64.trunc_sat_f64_s");
    expect(imulWat).not.toContain("call");
    expect(imulWat).not.toContain("$__toUint32");
    expect(wat).not.toContain("$Math_imul");

    const imul = (await instantiate(result)).imul as (left: number, right: number) => number;
    for (const [left, right] of EDGE_PAIRS) {
      const actual = imul(left, right);
      expect(actual, `${label} Math.imul(${String(left)}, ${String(right)})`).toBe(Math.imul(left, right));
      if (actual === 0) expect(Object.is(actual, -0)).toBe(false);
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
      fileName: "issue-5126-linear.ts",
      target: "linear",
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
    });
    expectSuccess(result);
    expect(getLastLinearIrReport()?.compiled).toContain("imul");
    expect(getLastLinearIrReport()?.rejected).toEqual([]);
    const imul = (await instantiate(result)).imul as (left: number, right: number) => number;
    for (const [left, right] of EDGE_PAIRS) expect(imul(left, right)).toBe(Math.imul(left, right));
  });

  it("attaches one dependency-free composite and emits the exact shared stack sequence", () => {
    const lowered = lowerSource();
    const semantic = intrinsicInstructions(lowered);
    expect(semantic).toEqual([
      expect.objectContaining({
        id: "math.imul",
        args: [expect.any(Number), expect.any(Number)],
        resultType: { kind: "val", val: { kind: "f64" } },
      }),
    ]);
    expect(semantic[0]?.args).toEqual([0, 1]);
    expect(semantic[0]?.provider).toBeUndefined();
    expect(() => lowerIrFunctionToWasm(lowered, minimalResolver())).toThrowError(
      /semantic intrinsic math\.imul has no frozen provider/,
    );

    for (const backend of ["wasmgc", "linear"] as const) {
      const prepared = prepareIrRuntimeManifest({
        functions: [lowered],
        sourceFile: "issue-5126-provider.ts",
        policy: { target: "standalone", backend },
      });
      if (!prepared) throw new Error("expected a non-empty runtime manifest");
      expect(prepared.manifest.features).toEqual(["math.imul"]);
      expect(prepared.manifest.hostCapabilities).toEqual([]);
      expect(prepared.manifest.providers).toEqual([
        expect.objectContaining({
          id: "backend.math.imul",
          feature: "math.imul",
          dependencies: [],
          hostCapabilities: [],
          implementation: { kind: "backend-composite", operation: "math.imul" },
        }),
      ]);
      expect(intrinsicInstructions(prepared.functions[0]!)[0]?.provider).toEqual({
        kind: "backend-composite",
        operation: "math.imul",
      });
      expect(verifyIrBackendLegality(prepared.functions[0]!, backend)).toEqual([]);
      expect(verifyIrBackendLegality(prepared.functions[0]!, "bytecode")[0]?.message).toContain(
        "bytecode backend does not support semantic intrinsic 'math.imul'",
      );
      expect(verifyIrBackendLegality(prepared.functions[0]!, "porffor")[0]?.message).toContain(
        "porffor backend does not support semantic intrinsic 'math.imul'",
      );
    }

    const prepared = prepareIrRuntimeManifest({
      functions: [lowered],
      sourceFile: "issue-5126-stack.ts",
      policy: { target: "standalone", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("expected a non-empty runtime manifest");
    const wasmgc = lowerIrFunctionToWasm(prepared.functions[0]!, minimalResolver(), new WasmGcEmitter()).func;
    const linear = lowerIrFunctionToWasm(prepared.functions[0]!, minimalResolver(), new LinearEmitter()).func;
    expect(linear.body).toEqual(wasmgc.body);
    const rhs = wasmgc.locals.findIndex((local) => local.name === "$js_bitwise_rhs_i32") + 2;
    expect(rhs).toBeGreaterThanOrEqual(2);
    const ops = wasmgc.body.map((instr) => instr.op);
    const reinterpret = ops.flatMap((op, index) => (op === "i64.reinterpret_f64" ? [index] : []));
    const rhsSet = wasmgc.body.findIndex((instr) => instr.op === "local.set" && instr.index === rhs);
    const rhsGet = wasmgc.body.findIndex((instr) => instr.op === "local.get" && instr.index === rhs);
    expect(reinterpret).toHaveLength(2);
    expect(reinterpret[0]).toBeLessThan(rhsSet);
    expect(rhsSet).toBeLessThan(reinterpret[1]!);
    expect(reinterpret[1]).toBeLessThan(rhsGet);
    expect(rhsGet).toBeLessThan(ops.indexOf("i32.mul"));
  });

  it("keeps signed Number composition exact", async () => {
    const result = await compile(COMPOSITION_SOURCE, {
      fileName: "issue-5126-composition.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expectSuccess(result);
    for (const name of ["add", "nested", "clz", "unsigned"]) {
      expect(outcomeFor(result, name)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
    }
    const exports = await instantiate(result);
    const left = 0xffff_ffff;
    const right = 2;
    const expected = Math.imul(left, right);
    expect((exports.add as (a: number, b: number) => number)(left, right)).toBe(expected + 1);
    expect((exports.nested as (a: number, b: number) => number)(left, right)).toBe(Math.imul(expected, 3));
    expect((exports.clz as (a: number, b: number) => number)(left, right)).toBe(Math.clz32(expected));
    expect((exports.unsigned as (a: number, b: number) => number)(left, right)).toBe(expected >>> 0);
  });

  it("matches direct codegen across exact coercion edges", async () => {
    const [ir, direct] = await Promise.all([
      compile(SOURCE, { fileName: "issue-5126-ir-parity.ts", experimentalIR: true, trackIrOutcomes: true }),
      compile(SOURCE, { fileName: "issue-5126-direct-parity.ts", experimentalIR: false }),
    ]);
    expectSuccess(ir);
    expectSuccess(direct);
    const [irExports, directExports] = await Promise.all([instantiate(ir), instantiate(direct)]);
    const irImul = irExports.imul as (left: number, right: number) => number;
    const directImul = directExports.imul as (left: number, right: number) => number;
    for (const [left, right] of EDGE_PAIRS) expect(irImul(left, right)).toBe(directImul(left, right));
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

  it.each(exclusionCases)("rejects %s before claim", async (label, source) => {
    const result = await compile(source, {
      fileName: `issue-5126-${label.replaceAll(" ", "-")}.ts`,
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
