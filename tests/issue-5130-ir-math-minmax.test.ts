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
import { verifyIrFunction } from "../src/ir/verify.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-5130-ir-math-minmax");
const SOURCE = `
  export function min2(left: number, right: number): number { return Math.min(left, right); }
  export function max2(left: number, right: number): number { return Math.max(left, right); }
`;

const EDGE_PAIRS = [
  [3, 7],
  [-5, -2],
  [Number.NEGATIVE_INFINITY, 1],
  [Number.POSITIVE_INFINITY, -1],
  [Number.NaN, 1],
  [1, Number.NaN],
  [0, -0],
  [-0, 0],
  [-0, -0],
  [0, 0],
  [Number.MAX_VALUE, -Number.MAX_VALUE],
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

function lowerSource(method: "max" | "min"): IrFunction {
  const analysis = analyzeSource(
    `export function ${method}(left: number, right: number): number { return Math.${method}(left, right); }`,
  );
  const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
  if (!declaration) throw new Error(`missing ${method} declaration`);
  return lowerFunctionAstToIr(declaration, {
    ownerUnitId: identities.next(method).unitId,
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

function expectSameNumber(actual: number, expected: number): void {
  expect(Object.is(actual, expected), `expected ${String(expected)}, received ${String(actual)}`).toBe(true);
}

const exclusionCases = [
  ["zero arguments", "return Math.min();"],
  ["one argument", "return Math.min(x);"],
  ["three arguments", "return Math.min(x, y, x);"],
  ["computed access", 'return Math["min"](x, y);'],
  ["aliased method", "const min = Math.min; return min(x, y);"],
  ["optional invocation", "return Math.min?.(x, y);"],
  ["spread arguments", "return Math.min(...([x, y] as [number, number]));"],
  ["non-number argument", 'const text: string = "2"; return Math.min(text as never, y);'],
] as const;

describe("#5130 exact ambient binary Math.min/max IR ownership", () => {
  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("claims both exact calls on the %s target", async (label, target) => {
    const result = await compile(SOURCE, {
      fileName: `issue-5130-${label}.ts`,
      ...(target === undefined ? {} : { target }),
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
    });
    expectSuccess(result);
    for (const name of ["min2", "max2"]) {
      expect(outcomeFor(result, name)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
    }
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.wat).toContain("f64.min");
    expect(result.wat).toContain("f64.max");
    expect(result.wat).not.toContain("$Math_min");
    expect(result.wat).not.toContain("$Math_max");

    const exports = await instantiate(result);
    const min2 = exports.min2 as (left: number, right: number) => number;
    const max2 = exports.max2 as (left: number, right: number) => number;
    for (const [left, right] of EDGE_PAIRS) {
      expectSameNumber(min2(left, right), Math.min(left, right));
      expectSameNumber(max2(left, right), Math.max(left, right));
    }
    if (target === "standalone") {
      expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
      expect(result.imports).toEqual([]);
    } else {
      expect(result.imports.filter((descriptor) => descriptor.name.startsWith("Math_"))).toEqual([]);
    }
  });

  it("claims the same closed composites on production linear", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-5130-linear.ts",
      target: "linear",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expectSuccess(result);
    expect(getLastLinearIrReport()?.compiled).toEqual(expect.arrayContaining(["min2", "max2"]));
    expect(getLastLinearIrReport()?.rejected).toEqual([]);
    const exports = await instantiate(result);
    for (const [method, exportName] of [
      [Math.min, "min2"],
      [Math.max, "max2"],
    ] as const) {
      const fn = exports[exportName] as (left: number, right: number) => number;
      for (const [left, right] of EDGE_PAIRS) expectSameNumber(fn(left, right), method(left, right));
    }
  });

  it.each(["min", "max"] as const)(
    "attaches the dependency-free math.%s provider and emits identical WasmGC/linear bodies",
    (method) => {
      const lowered = lowerSource(method);
      const semantic = intrinsicInstructions(lowered);
      expect(semantic).toEqual([
        expect.objectContaining({
          id: `math.${method}`,
          args: [0, 1],
          resultType: { kind: "val", val: { kind: "f64" } },
        }),
      ]);
      expect(semantic[0]?.provider).toBeUndefined();
      expect(() => lowerIrFunctionToWasm(lowered, minimalResolver())).toThrowError(
        new RegExp(`semantic intrinsic math\\.${method} has no frozen provider`),
      );

      for (const backend of ["wasmgc", "linear"] as const) {
        const prepared = prepareIrRuntimeManifest({
          functions: [lowered],
          sourceFile: `issue-5130-${method}-provider.ts`,
          policy: { target: "standalone", backend },
        });
        if (!prepared) throw new Error("expected a non-empty runtime manifest");
        expect(prepared.manifest.features).toEqual([`math.${method}`]);
        expect(prepared.manifest.hostCapabilities).toEqual([]);
        expect(prepared.manifest.providers).toEqual([
          expect.objectContaining({
            id: `backend.math.${method}`,
            feature: `math.${method}`,
            dependencies: [],
            hostCapabilities: [],
            implementation: { kind: "backend-composite", operation: `math.${method}` },
          }),
        ]);
        expect(verifyIrBackendLegality(prepared.functions[0]!, backend)).toEqual([]);
        expect(verifyIrBackendLegality(prepared.functions[0]!, "bytecode")[0]?.message).toContain(
          `bytecode backend does not support semantic intrinsic 'math.${method}'`,
        );
        expect(verifyIrBackendLegality(prepared.functions[0]!, "porffor")[0]?.message).toContain(
          `porffor backend does not support semantic intrinsic 'math.${method}'`,
        );
      }

      const prepared = prepareIrRuntimeManifest({
        functions: [lowered],
        sourceFile: `issue-5130-${method}-stack.ts`,
        policy: { target: "standalone", backend: "wasmgc" },
      });
      if (!prepared) throw new Error("expected a non-empty runtime manifest");
      const wasmgc = lowerIrFunctionToWasm(prepared.functions[0]!, minimalResolver(), new WasmGcEmitter()).func;
      const linear = lowerIrFunctionToWasm(prepared.functions[0]!, minimalResolver(), new LinearEmitter()).func;
      expect(linear.body).toEqual(wasmgc.body);
      const body = JSON.stringify(wasmgc.body);
      expect(body.match(/"op":"f64.ne"/g)).toHaveLength(2);
      expect(body).toContain(`"op":"f64.${method}"`);
      expect(body).not.toContain('"op":"call"');
      expect(wasmgc.locals.map((local) => local.name)).toEqual(
        expect.arrayContaining(["$math_minmax_left", "$math_minmax_right"]),
      );
    },
  );

  it("evaluates both arguments once in source order before observing a left NaN", async () => {
    const source = `
      let trace: number = 0;
      function left(): number {
        trace = trace * 10 + 1;
        return 0 / 0;
      }
      function right(): number {
        trace = trace * 10 + 2;
        return 7;
      }
      export function order(): number {
        trace = 0;
        const result: number = Math.min(left(), right());
        return result !== result ? trace : -1;
      }
    `;
    const result = await compile(source, {
      fileName: "issue-5130-order.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expectSuccess(result);
    expect(outcomeFor(result, "order")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    const exports = await instantiate(result);
    expect((exports.order as () => number)()).toBe(12);
  });

  it("composes min and max without leaving typed IR", async () => {
    const source = `
      export function clamp(value: number, low: number, high: number): number {
        return Math.max(low, Math.min(value, high));
      }
      export function zeroSign(left: number, right: number): number {
        return 1 / Math.min(left, right) + 1 / Math.max(left, right);
      }
    `;
    const result = await compile(source, {
      fileName: "issue-5130-composition.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expectSuccess(result);
    for (const name of ["clamp", "zeroSign"]) {
      expect(outcomeFor(result, name)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
    }
    const exports = await instantiate(result);
    expect((exports.clamp as (value: number, low: number, high: number) => number)(9, 1, 5)).toBe(5);
    expect((exports.zeroSign as (left: number, right: number) => number)(0, -0)).toBeNaN();
  });

  it("matches direct codegen across NaN, infinity, and signed-zero edges", async () => {
    const [ir, direct] = await Promise.all([
      compile(SOURCE, { fileName: "issue-5130-ir-parity.ts", experimentalIR: true, trackIrOutcomes: true }),
      compile(SOURCE, { fileName: "issue-5130-direct-parity.ts", experimentalIR: false }),
    ]);
    expectSuccess(ir);
    expectSuccess(direct);
    const [irExports, directExports] = await Promise.all([instantiate(ir), instantiate(direct)]);
    for (const name of ["min2", "max2"]) {
      const irFn = irExports[name] as (left: number, right: number) => number;
      const directFn = directExports[name] as (left: number, right: number) => number;
      for (const [left, right] of EDGE_PAIRS) expectSameNumber(irFn(left, right), directFn(left, right));
    }
  });

  it("fails loudly on a malformed backend composite", () => {
    const lowered = lowerSource("min");
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

  it.each([
    ["min", "max"],
    ["max", "min"],
  ] as const)("rejects a math.%s intrinsic carrying the math.%s composite", (intrinsic, operation) => {
    const lowered = lowerSource(intrinsic);
    const malformed = {
      ...lowered,
      blocks: lowered.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((instr) =>
          instr.kind === "intrinsic"
            ? { ...instr, provider: { kind: "backend-composite", operation: `math.${operation}` } }
            : instr,
        ),
      })),
    } as unknown as IrFunction;
    expect(verifyIrFunction(malformed).map((error) => error.message)).toContain(
      `math.${intrinsic} backend composite provider must use math.${intrinsic}, got math.${operation}`,
    );
  });

  it.each([
    ["MIN", "min2", "max2"],
    ["MAX", "max2", "min2"],
  ] as const)("withdraws only Math.%s through its narrow rollback", async (suffix, withdrawn, retained) => {
    const flag = `JS2WASM_IR_MATH_${suffix}`;
    const previous = process.env[flag];
    process.env[flag] = "0";
    try {
      const result = await compile(SOURCE, {
        fileName: `issue-5130-${suffix.toLowerCase()}-rollback.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      expectSuccess(result);
      expect(outcomeFor(result, withdrawn)).toMatchObject({
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
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, flag);
      else process.env[flag] = previous;
    }
  });

  it.each(exclusionCases)("rejects %s before claim", async (label, body) => {
    const source = `export function f(x: number, y: number): number { ${body} }`;
    const result = await compile(source, {
      fileName: `issue-5130-${label.replaceAll(" ", "-")}.ts`,
      target: "standalone",
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
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });
});
