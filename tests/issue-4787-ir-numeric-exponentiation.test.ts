// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4787 — bounded IR retirement checkpoint for exact numeric exponentiation.
// The positive denominator is deliberately explicit: every listed function
// must be emitted by IR, with the semantic math.pow provider attached, while
// unsupported shapes remain typed pre-claim controls.

import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, compileMulti, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import {
  makeIrDeclaredPrimitiveExpressionClassifier,
  makeIrPrimitiveExpressionClassifier,
} from "../src/ir/module-bindings.js";
import { forEachInstrDeep, type IrFunction, type IrInstrIntrinsic } from "../src/ir/nodes.js";
import { IR_MATH_METHOD_TABLE, planIrCompilation } from "../src/ir/select.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const DIRECT_POISON = "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY";
const IR_FIRST = "JS2WASM_IR_FIRST";
const identities = createTestIrFunctionIdentityFactory("issue-4787-ir-numeric-exponentiation");

const ELIGIBLE_NAMES = ["pow", "nestedPow"] as const;
const ELIGIBLE_SOURCE = `
  export function pow(a: number, b: number): number { return a ** b; }
  export function nestedPow(a: number, b: number): number { return (a + 1) ** (b - 1); }
`;

function expectSuccess(result: CompileResult, label: string): void {
  expect(
    result.success,
    `${label} failed:\n${result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")}`,
  ).toBe(true);
}

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = result.irOutcomes?.find(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  if (!observed) throw new Error(`missing IR outcome for ${name}`);
  return observed;
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

function unavailableMathProviderResolver() {
  const resolver = ((_: ts.Identifier) => undefined) as unknown as Record<string, unknown>;
  return new Proxy(resolver, {
    get(target, property) {
      if (property === "supportsHostNumberToString") return false;
      if (property in target) return target[property];
      return () => undefined;
    },
  });
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

async function compileTracked(source: string, fileName: string, options: Parameters<typeof compile>[1] = {}) {
  return compile(source, {
    fileName,
    experimentalIR: true,
    trackIrOutcomes: true,
    ...options,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#4787 exact numeric exponentiation IR checkpoint", () => {
  it("has a non-vacuous exact denominator with zero post-claim errors", async () => {
    expect(ELIGIBLE_NAMES.length).toBeGreaterThan(0);
    const result = await compileTracked(ELIGIBLE_SOURCE, "issue-4787-eligible.ts");
    expectSuccess(result, "exact numeric exponentiation");
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    for (const name of ELIGIBLE_NAMES) {
      expect(outcome(result, name)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
    }
    expect(result.wat).toContain("$Math_pow");
  });

  it("lowers the exact BinaryExpression through semantic math.pow and freezes its callable provider", () => {
    const analysis = analyzeSource(`
      export function pow(a: number, b: number): number { return (a + 1) ** (b - 1); }
    `);
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
    if (!declaration) throw new Error("missing pow declaration");

    const lowered = lowerFunctionAstToIr(declaration, {
      ownerUnitId: identities.next("pow").unitId,
      exported: true,
      checker: analysis.checker,
    }).main;
    const semantic = intrinsicInstructions(lowered);

    expect(semantic).toHaveLength(1);
    expect(semantic[0]).toMatchObject({
      id: "math.pow",
      version: 1,
      resultType: { kind: "val", val: { kind: "f64" } },
    });
    expect(lowered.blocks.flatMap((block) => block.instrs).filter((instr) => instr.kind === "call")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: { name: expect.stringMatching(/^Math_/) } })]),
    );
    const instructions = lowered.blocks.flatMap((block) => block.instrs);
    const leftIndex = instructions.findIndex((instr) => instr.kind === "binary" && instr.op === "f64.add");
    const rightIndex = instructions.findIndex((instr) => instr.kind === "binary" && instr.op === "f64.sub");
    const powIndex = instructions.findIndex((instr) => instr.kind === "intrinsic" && instr.id === "math.pow");
    expect(leftIndex).toBeGreaterThanOrEqual(0);
    expect(rightIndex).toBeGreaterThan(leftIndex);
    expect(powIndex).toBeGreaterThan(rightIndex);

    const prepared = prepareIrRuntimeManifest({
      functions: [lowered],
      sourceFile: analysis.sourceFile.fileName,
      policy: { target: "host", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("expected math.pow runtime manifest");
    expect(prepared.manifest.intrinsicUses).toEqual([
      expect.objectContaining({
        id: "math.pow",
        argumentTypes: [
          { kind: "val", val: { kind: "f64" } },
          { kind: "val", val: { kind: "f64" } },
        ],
      }),
    ]);
    expect(intrinsicInstructions(prepared.functions[0]!)[0]).toMatchObject({
      id: "math.pow",
      provider: {
        kind: "callable",
        target: { binding: { kind: "intrinsic", symbol: "math.pow" }, name: "Math_pow" },
      },
    });
    expect(IR_MATH_METHOD_TABLE.pow.intrinsic).toBe("math.pow");
  });

  it("rejects a target without the symbolic math provider before claim", () => {
    const analysis = analyzeSource(`
      export function pow(a: number, b: number): number { return a ** b; }
    `);
    const selected = planIrCompilation(analysis.sourceFile, {
      experimentalIR: true,
      trackFallbacks: true,
      resolveModuleBinding: unavailableMathProviderResolver() as never,
      classifyPrimitiveExpression: makeIrPrimitiveExpressionClassifier(analysis.checker),
      classifyDeclaredPrimitiveExpression: makeIrDeclaredPrimitiveExpressionClassifier(analysis.checker),
      supportsSymbolicMathHelpers: false,
    });

    expect(selected.funcs).not.toContain("pow");
    expect(selected.fallbacks).toContainEqual(
      expect.objectContaining({ name: "pow", reason: "operand-coercion-unsupported" }),
    );
  });

  it("bypasses the direct body after claim, while the existing kill switch restores the control arm", async () => {
    vi.stubEnv(DIRECT_POISON, "pow,nestedPow");
    const prepared = await compileTracked(ELIGIBLE_SOURCE, "issue-4787-poisoned.ts");
    expectSuccess(prepared, "IR exact exponentiation with poisoned direct bodies");
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(ELIGIBLE_NAMES.map((name) => outcome(prepared, name))).toEqual([
      expect.objectContaining({ kind: "emitted", legacyBodyEmitted: false, irBodyEmitted: true }),
      expect.objectContaining({ kind: "emitted", legacyBodyEmitted: false, irBodyEmitted: true }),
    ]);

    vi.stubEnv(IR_FIRST, "0");
    const control = await compileTracked(ELIGIBLE_SOURCE, "issue-4787-kill-switch.ts");
    expect(control.success).toBe(false);
    const errors = control.errors.map((error) => error.message).join("\n");
    expect(errors).toContain("injected direct function-body poison: pow");
    expect(errors).toContain("injected direct function-body poison: nestedPow");
  });

  it("matches direct JavaScript Math.pow edge behavior", async () => {
    const [ir, direct] = await Promise.all([
      compileTracked(`export function pow(a: number, b: number): number { return a ** b; }`, "issue-4787-ir.ts"),
      compile(`export function pow(a: number, b: number): number { return a ** b; }`, {
        fileName: "issue-4787-direct.ts",
        experimentalIR: false,
      }),
    ]);
    expectSuccess(ir, "IR edge parity");
    expectSuccess(direct, "direct edge parity");
    const irPow = (await instantiate(ir)).pow as (a: number, b: number) => number;
    const directPow = (await instantiate(direct)).pow as (a: number, b: number) => number;
    for (const [base, exponent] of [
      [2, 10],
      [0, -1],
      [-0, 3],
      [-1, 0.5],
      [Infinity, 2],
      [NaN, 2],
    ] as const) {
      expect(Object.is(irPow(base, exponent), directPow(base, exponent))).toBe(true);
    }
  });

  it.each([
    [
      "type-alias return",
      `type N = number;
       function helper(): N { return 2; }
       export function p(a: number, b: number): number { return helper() ** b; }`,
    ],
    [
      "overload implementation returning any",
      `function helper(x: number): number;
       function helper(x: number): any { return x; }
       export function p(a: number, b: number): number { return helper(a) ** b; }`,
    ],
  ])("keeps a %s direct-call operand on the legacy path", async (label, source) => {
    const result = await compileTracked(source, `issue-4787-unprepared-${String(label)}.ts`);
    expectSuccess(result, `unprepared ${String(label)}`);
    expect(result.irPostClaimErrors ?? []).not.toContainEqual(expect.objectContaining({ func: "p", kind: "build" }));
    expect(outcome(result, "p")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });

    const direct = await compile(source, {
      fileName: `issue-4787-direct-${String(label)}.ts`,
      experimentalIR: false,
    });
    expectSuccess(direct, `direct ${String(label)}`);
  });

  it.each([
    ["bigint", `export function p(a: bigint, b: bigint): bigint { return a ** b; }`],
    ["any", `export function p(a: any, b: number): number { return a ** b; }`],
    ["unknown", `export function p(a: unknown, b: number): number { return (a as number) ** b; }`],
    ["union", `export function p(a: number | undefined, b: number): number { return a! ** b; }`],
    ["generic", `export function p<T extends number>(a: T, b: number): number { return a ** b; }`],
    ["boxed", `export function p(a: Number, b: number): number { return a.valueOf() ** b; }`],
    ["property shape", `export function p(a: { value: number }, b: number): number { return a.value ** b; }`],
    ["compound assignment", `export function p(a: number, b: number): number { a **= b; return a; }`],
    ["nested closure", `export function p(a: number, b: number): number { const f = () => a ** b; return f(); }`],
  ])("keeps the %s shape pre-claim", async (_label, source) => {
    const result = await compileTracked(source, `issue-4787-${String(_label)}.ts`);
    expectSuccess(result, `unsupported ${String(_label)}`);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(result, "p")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  });

  it("excludes module-init, class-member, and multi-source units before the exact claim", async () => {
    const moduleResult = await compileTracked(
      `const initial: number = 2 ** 3; export function p(): number { return initial; }`,
      "issue-4787-module-init.ts",
    );
    expectSuccess(moduleResult, "module-init exclusion");
    expect(moduleResult.irPostClaimErrors ?? []).toEqual([]);
    expect(moduleResult.irOutcomes?.find((candidate) => candidate.unitKind === "module-init")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });

    const classResult = await compileTracked(
      `export class Box { power(a: number, b: number): number { return a ** b; } }`,
      "issue-4787-class.ts",
    );
    expectSuccess(classResult, "class-member exclusion");
    expect(classResult.irPostClaimErrors ?? []).toEqual([]);
    expect(
      classResult.irOutcomes?.find(
        (candidate) => candidate.unitKind === "class-member" && candidate.displayName.endsWith("_power"),
      ),
    ).toMatchObject({ kind: "unsupported", legacyBodyEmitted: true, irBodyEmitted: false });

    const multiResult = await compileMulti(
      {
        "main.ts": `import { helper } from "./helper"; export function p(a: number, b: number): number { return a ** b + helper(); }`,
        "helper.ts": `export function helper(): number { return 0; }`,
      },
      "main.ts",
      { experimentalIR: true, trackIrOutcomes: true },
    );
    expectSuccess(multiResult, "multi-source exclusion");
    expect(multiResult.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(multiResult, "p")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  });
});
