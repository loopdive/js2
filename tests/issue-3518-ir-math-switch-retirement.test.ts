// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import {
  forEachInstrDeep,
  mapNestedBuffers,
  type IrFunction,
  type IrInstr,
  type IrInstrIntrinsic,
} from "../src/ir/nodes.js";
import { IR_MATH_METHOD_TABLE, type IrMathMethodPlan } from "../src/ir/select.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3518-ir-math-switch-retirement");

type ProviderKind = "callable" | "backend-sequence" | "backend-composite";

type RetirementRow = {
  readonly method: string;
  readonly arity: 1 | 2;
  readonly provider: ProviderKind;
  readonly suite: number;
};

// This is deliberately independent of the production registry projection below.
// It is the complete 21-method retirement population, in its rollout order.
const EXPECTED_RETIRED_METHODS = [
  "atan",
  "tan",
  "asin",
  "acos",
  "log10",
  "log1p",
  "sinh",
  "cosh",
  "tanh",
  "cbrt",
  "expm1",
  "clz32",
  "imul",
  "min",
  "max",
  "asinh",
  "acosh",
  "atanh",
  "sign",
  "round",
  "fround",
] as const;

// Literal method/arity/provider ownership table. The suite field makes the
// fourteen focused origin suites part of the closed census rather than implied.
const RETIRED_MATH_METHODS = [
  { method: "atan", arity: 1, provider: "callable", suite: 5101 },
  { method: "tan", arity: 1, provider: "callable", suite: 5103 },
  { method: "asin", arity: 1, provider: "callable", suite: 5105 },
  { method: "acos", arity: 1, provider: "callable", suite: 5105 },
  { method: "log10", arity: 1, provider: "callable", suite: 5106 },
  { method: "log1p", arity: 1, provider: "callable", suite: 5106 },
  { method: "sinh", arity: 1, provider: "callable", suite: 5110 },
  { method: "cosh", arity: 1, provider: "callable", suite: 5110 },
  { method: "tanh", arity: 1, provider: "callable", suite: 5110 },
  { method: "cbrt", arity: 1, provider: "callable", suite: 5111 },
  { method: "expm1", arity: 1, provider: "callable", suite: 5114 },
  { method: "clz32", arity: 1, provider: "backend-composite", suite: 5125 },
  { method: "imul", arity: 2, provider: "backend-composite", suite: 5126 },
  { method: "min", arity: 2, provider: "backend-composite", suite: 5130 },
  { method: "max", arity: 2, provider: "backend-composite", suite: 5130 },
  { method: "asinh", arity: 1, provider: "callable", suite: 5132 },
  { method: "acosh", arity: 1, provider: "callable", suite: 5132 },
  { method: "atanh", arity: 1, provider: "callable", suite: 5132 },
  { method: "sign", arity: 1, provider: "callable", suite: 5133 },
  { method: "round", arity: 1, provider: "callable", suite: 5134 },
  { method: "fround", arity: 1, provider: "backend-sequence", suite: 5135 },
] as const satisfies readonly RetirementRow[];

const FOCUSED_SUITES = [5101, 5103, 5105, 5106, 5110, 5111, 5114, 5125, 5126, 5130, 5132, 5133, 5134, 5135];

function paramsFor(row: RetirementRow): string {
  return row.arity === 1 ? "value: number" : "left: number, right: number";
}

function argumentNamesFor(row: RetirementRow): readonly string[] {
  return row.arity === 1 ? ["value"] : ["left", "right"];
}

function argumentsFor(row: RetirementRow): string {
  return argumentNamesFor(row).join(", ");
}

function exactSource(row: RetirementRow, name: string): string {
  return `export function ${name}(${paramsFor(row)}): number { return Math.${row.method}(${argumentsFor(row)}); }`;
}

function shadowedSource(row: RetirementRow): string {
  const replacement =
    row.arity === 1
      ? `const Math = { ${row.method}: (value: number): number => value };`
      : `const Math = { ${row.method}: (left: number, right: number): number => left + right };`;
  return `
    export function shadow_${row.method}(${paramsFor(row)}): number {
      ${replacement}
      return Math.${row.method}(${argumentsFor(row)});
    }
  `;
}

function aliasedSource(row: RetirementRow): string {
  const alias = `bound_${row.method}`;
  return `
    const ${alias} = Math.${row.method};
    export function alias_${row.method}(${paramsFor(row)}): number {
      return ${alias}(${argumentsFor(row)});
    }
  `;
}

type ArityVariant = "too-few" | "too-many";

function arityDisplayName(row: RetirementRow, variant: ArityVariant): string {
  return `arity_${row.method}_${variant.replaceAll("-", "_")}`;
}

function wrongAritySource(row: RetirementRow, variant: ArityVariant): string {
  const args = argumentNamesFor(row);
  const supplied = variant === "too-few" ? args.slice(0, -1) : [...args, args[0]!];
  const typeErrorSuppression =
    row.method === "min" || row.method === "max" ? "" : "      // @ts-expect-error exact arity is intentional here.\n";
  return `
    export function ${arityDisplayName(row, variant)}(${paramsFor(row)}): number {
${typeErrorSuppression}      return Math.${row.method}(${supplied.join(", ")});
    }
  `;
}

const POSITIVE_SOURCE = RETIRED_MATH_METHODS.map((row) => exactSource(row, row.method)).join("\n");
const SHADOWED_SOURCE = RETIRED_MATH_METHODS.map(shadowedSource).join("\n");
const ALIASED_SOURCE = RETIRED_MATH_METHODS.map(aliasedSource).join("\n");
const ARITY_CASES = RETIRED_MATH_METHODS.flatMap((row) =>
  (["too-few", "too-many"] as const).map((variant) => ({ row, variant })),
);
const WRONG_ARITY_SOURCE = ARITY_CASES.map(({ row, variant }) => wrongAritySource(row, variant)).join("\n");

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

function expectPreclaimUnsupported(result: CompileResult, displayName: string): void {
  expect(outcomeFor(result, displayName)).toMatchObject({
    kind: "unsupported",
    stage: "select",
    legacyBodyEmitted: true,
    irBodyEmitted: false,
  });
  expect(result.irCompiledFuncs ?? []).not.toContain(displayName);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  expect((result.irOutcomes ?? []).filter((outcome) => outcome.kind === "invariant")).toEqual([]);
}

function assertProviderClass(row: RetirementRow, plan: IrMathMethodPlan): void {
  if (row.provider === "callable") {
    if ("op" in plan || "sequence" in plan || "composite" in plan) {
      throw new Error(`Math.${row.method} is not callable-backed in the production registry`);
    }
    return;
  }
  if (row.provider === "backend-sequence") {
    if (!("sequence" in plan) || plan.sequence !== "f64.fround") {
      throw new Error(`Math.${row.method} is not bound to the fround backend sequence`);
    }
    return;
  }
  if (!("composite" in plan) || plan.composite !== `math.${row.method}`) {
    throw new Error(`Math.${row.method} is not bound to its exact backend composite`);
  }
}

function assertClosedRetirementTable(rows: readonly RetirementRow[]): void {
  const expected = new Set<string>(EXPECTED_RETIRED_METHODS);
  if (expected.size !== 21) throw new Error("the independent retirement expectation must contain exactly 21 methods");
  if (rows.length !== expected.size) throw new Error(`expected exactly 21 retirement rows, got ${rows.length}`);

  const seen = new Set<string>();
  for (const row of rows) {
    if (!expected.has(row.method)) throw new Error(`foreign retirement row: ${row.method}`);
    if (seen.has(row.method)) throw new Error(`duplicate retirement row: ${row.method}`);
    seen.add(row.method);
  }
  for (const method of expected) {
    if (!seen.has(method)) throw new Error(`missing retirement row: ${method}`);
  }

  const projection = Object.entries(IR_MATH_METHOD_TABLE).filter(([method]) => expected.has(method));
  if (projection.length !== expected.size) {
    throw new Error(`production registry projected ${projection.length} retired methods, expected ${expected.size}`);
  }
  const projectedNames = new Set(projection.map(([method]) => method));
  for (const method of expected) {
    if (!projectedNames.has(method)) throw new Error(`production registry is missing Math.${method}`);
  }

  for (const row of rows) {
    const plan = IR_MATH_METHOD_TABLE[row.method];
    if (!plan) throw new Error(`missing production Math plan for ${row.method}`);
    if (plan.arity !== row.arity) {
      throw new Error(`Math.${row.method} has arity ${plan.arity}, expected ${row.arity}`);
    }
    if (plan.intrinsic !== `math.${row.method}`) {
      throw new Error(`Math.${row.method} maps to ${plan.intrinsic}, not its own semantic intrinsic`);
    }
    assertProviderClass(row, plan);
  }
}

function sampleArguments(row: RetirementRow): readonly number[] {
  switch (row.method) {
    case "clz32":
      return [0x100];
    case "imul":
      return [0x7fff_ffff, -3];
    case "min":
    case "max":
      return [-3, 7];
    case "acosh":
      return [2];
    case "atanh":
      return [0.5];
    default:
      return [0.5];
  }
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

function preparedFunctionFor(row: RetirementRow): IrFunction {
  const analysis = analyzeSource(exactSource(row, `provider_${row.method}`));
  const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
  if (!declaration) throw new Error(`missing Math.${row.method} declaration`);
  const lowered = lowerFunctionAstToIr(declaration, {
    ownerUnitId: identities.next(`provider_${row.method}`).unitId,
    exported: true,
  }).main;
  const prepared = prepareIrRuntimeManifest({
    functions: [lowered],
    sourceFile: analysis.sourceFile.fileName,
    policy: { target: "host", backend: "wasmgc" },
  });
  if (!prepared) throw new Error(`missing prepared Math.${row.method} manifest`);
  const matching = intrinsicInstructions(prepared.functions[0]!).filter((instr) => instr.id === `math.${row.method}`);
  if (matching.length !== 1)
    throw new Error(`expected one prepared Math.${row.method} intrinsic, got ${matching.length}`);
  if (matching[0]!.provider?.kind !== row.provider) {
    throw new Error(`Math.${row.method} prepared as ${matching[0]!.provider?.kind}, expected ${row.provider}`);
  }
  return prepared.functions[0]!;
}

function rewritePreparedIntrinsic(
  fn: IrFunction,
  row: RetirementRow,
  rewrite: (instr: IrInstrIntrinsic) => IrInstrIntrinsic,
): IrFunction {
  let rewrittenCount = 0;
  const mapBuffer = (buffer: readonly IrInstr[]): readonly IrInstr[] => buffer.map(mapInstr);
  const mapInstr = (instr: IrInstr): IrInstr => {
    const nested = mapNestedBuffers(instr, mapBuffer);
    if (nested.kind !== "intrinsic" || nested.id !== `math.${row.method}`) return nested;
    rewrittenCount++;
    return rewrite(nested);
  };
  const rewritten: IrFunction = {
    ...fn,
    blocks: fn.blocks.map((block) => ({ ...block, instrs: mapBuffer(block.instrs) })),
  };
  if (rewrittenCount !== 1) {
    throw new Error(`rewrote ${rewrittenCount} nested Math.${row.method} providers instead of exactly one`);
  }
  return rewritten;
}

function minimalResolver(): IrLowerResolver {
  let nextType = 0;
  return {
    resolveFunc: () => 0,
    resolveGlobal: () => {
      throw new Error("resolveGlobal is not used by this provider mutation");
    },
    resolveType: () => {
      throw new Error("resolveType is not used by this provider mutation");
    },
    internFuncType: () => nextType++,
  };
}

const COMPOSITE_MUTATIONS: Readonly<Record<string, string>> = {
  clz32: "math.unknown",
  imul: "math.unknown",
  min: "math.max",
  max: "math.min",
};

describe("#3518 per-intrinsic Math rollback retirement", () => {
  it("joins the literal 21-row retirement table to the independently projected 33-row production registry", () => {
    expect(Object.keys(IR_MATH_METHOD_TABLE)).toHaveLength(33);
    expect(new Set(RETIRED_MATH_METHODS.map((row) => row.suite))).toEqual(new Set(FOCUSED_SUITES));
    assertClosedRetirementTable(RETIRED_MATH_METHODS);

    const expectedProjection = Object.keys(IR_MATH_METHOD_TABLE)
      .filter((method) => EXPECTED_RETIRED_METHODS.includes(method as (typeof EXPECTED_RETIRED_METHODS)[number]))
      .sort();
    expect(expectedProjection).toEqual([...EXPECTED_RETIRED_METHODS].sort());

    expect(() => assertClosedRetirementTable(RETIRED_MATH_METHODS.slice(1))).toThrow(/exactly 21 retirement rows/);
    const duplicate = [...RETIRED_MATH_METHODS.slice(0, -1), RETIRED_MATH_METHODS[0]!];
    expect(() => assertClosedRetirementTable(duplicate)).toThrow(/duplicate retirement row/);
    const foreign = [...RETIRED_MATH_METHODS];
    foreign[0] = { ...foreign[0]!, method: "synthetic" };
    expect(() => assertClosedRetirementTable(foreign)).toThrow(/foreign retirement row/);
  });

  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("emits every retirement-table method as an IR-only body on %s", async (label, target) => {
    const options = {
      fileName: `issue-3518-math-retirement-${label}.ts`,
      ...(target === undefined ? {} : { target }),
    };
    const [result, direct] = await Promise.all([
      compile(POSITIVE_SOURCE, { ...options, experimentalIR: true, trackIrOutcomes: true }),
      compile(POSITIVE_SOURCE, { ...options, experimentalIR: false }),
    ]);
    expectSuccess(result);
    expectSuccess(direct);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(WebAssembly.validate(direct.binary)).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    for (const row of RETIRED_MATH_METHODS) {
      expect(outcomeFor(result, row.method)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      expect(result.irCompiledFuncs ?? []).toContain(row.method);
    }

    const module = new WebAssembly.Module(result.binary);
    const directModule = new WebAssembly.Module(direct.binary);
    expect(WebAssembly.Module.imports(module)).toEqual(WebAssembly.Module.imports(directModule));
    expect(WebAssembly.Module.exports(module)).toEqual(WebAssembly.Module.exports(directModule));
    expect(result.imports).toEqual(direct.imports);
    if (target === "standalone") {
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      expect(result.imports).toEqual([]);
    } else {
      expect(result.imports.filter((descriptor) => descriptor.name.startsWith("Math_"))).toEqual([]);
    }

    const [exports, directExports] = await Promise.all([instantiate(result), instantiate(direct)]);
    for (const row of RETIRED_MATH_METHODS) {
      const compiled = exports[row.method] as (...args: number[]) => number;
      const directCompiled = directExports[row.method] as (...args: number[]) => number;
      const args = sampleArguments(row);
      expect(Object.is(compiled(...args), directCompiled(...args)), `Math.${row.method} direct runtime parity`).toBe(
        true,
      );
    }
  });

  it("keeps all 21 shadowed Math cells pre-claim and legacy-owned", async () => {
    const result = await compile(SHADOWED_SOURCE, {
      fileName: "issue-3518-math-shadowed.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expectSuccess(result);
    for (const row of RETIRED_MATH_METHODS) expectPreclaimUnsupported(result, `shadow_${row.method}`);
  });

  it("keeps all 21 extracted aliases pre-claim and legacy-owned", async () => {
    const result = await compile(ALIASED_SOURCE, {
      fileName: "issue-3518-math-aliased.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expectSuccess(result);
    for (const row of RETIRED_MATH_METHODS) expectPreclaimUnsupported(result, `alias_${row.method}`);
  });

  it("keeps all 42 exact-arity misses pre-claim and legacy-owned", async () => {
    const result = await compile(WRONG_ARITY_SOURCE, {
      fileName: "issue-3518-math-wrong-arity.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expectSuccess(result);
    for (const { row, variant } of ARITY_CASES) {
      expectPreclaimUnsupported(result, arityDisplayName(row, variant));
    }
  });

  it("rejects all 21 row-specific malformed provider mutations", () => {
    for (const row of RETIRED_MATH_METHODS) {
      const prepared = preparedFunctionFor(row);
      if (row.provider === "callable") {
        const malformed = rewritePreparedIntrinsic(prepared, row, (instr) => {
          if (instr.provider?.kind !== "callable") throw new Error(`missing callable provider for Math.${row.method}`);
          return {
            ...instr,
            provider: {
              kind: "callable",
              target: {
                ...instr.provider.target,
                binding: { kind: "intrinsic", symbol: "math.abs" },
              },
            },
          };
        });
        expect(
          verifyIrFunction(malformed).map((error) => error.message),
          row.method,
        ).toContain(`math.${row.method} callable provider must retain the semantic intrinsic binding`);
        continue;
      }

      if (row.provider === "backend-sequence") {
        const malformed = rewritePreparedIntrinsic(prepared, row, (instr) => ({
          ...instr,
          provider: { kind: "backend-sequence", sequence: "f64.unknown" },
        })) as unknown as IrFunction;
        expect(() => lowerIrFunctionToWasm(malformed, minimalResolver()), row.method).toThrowError(
          /unsupported backend sequence/,
        );
        continue;
      }

      const operation = COMPOSITE_MUTATIONS[row.method];
      if (!operation) throw new Error(`missing composite mutation for Math.${row.method}`);
      const malformed = rewritePreparedIntrinsic(prepared, row, (instr) => ({
        ...instr,
        provider: { kind: "backend-composite", operation },
      })) as unknown as IrFunction;
      expect(
        verifyIrFunction(malformed).map((error) => error.message),
        row.method,
      ).toContain(`math.${row.method} backend composite provider must use math.${row.method}, got ${operation}`);
    }
  });
});
