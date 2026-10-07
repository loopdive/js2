// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { irIntrinsicFuncRef, irRuntimeFuncRef, irUnitFuncRef } from "../src/ir/core/callable-bindings.js";
import { forEachInstrDeep } from "../src/ir/core/nodes.js";
import type { IrFuncRef } from "../src/ir/core/value-references.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { assertPreparedIrProgram } from "../src/ir/program/validation.js";
import {
  assertPreparedIrRuntimeCallableDeclaration,
  prepareIrProgramRuntimeCallables,
} from "../src/ir/program/runtime-abi.js";
import { irRuntimeCallableDeclaration } from "../src/ir/runtime/callable-declarations.js";
import {
  irNumberRemainderCallableDeclaration,
  NUMBER_REMAINDER_RUNTIME_PROVIDERS,
} from "../src/ir/runtime/number-remainder-callables.js";
import { RuntimeManifestBuilder, RuntimeManifestInvariantError } from "../src/ir/runtime/manifest.js";
import type { RuntimeProviderDefinition } from "../src/ir/runtime/contracts/manifest.js";
import type { IrUnitId } from "../src/shared/contracts/ir-identity.js";

const SYMBOLS = ["__fmod", "__fmod_early_magnitude"] as const;
const F64 = { kind: "val" as const, val: { kind: "f64" as const } };

function prepare(source: string, includeLinear = true) {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "wasmgc", target: "host" },
    runtimePolicies: includeLinear
      ? [
          { backend: "wasmgc", target: "host" },
          { backend: "linear", target: "host" },
        ]
      : [{ backend: "wasmgc", target: "host" }],
    deferTopLevelInit: false,
  });
  if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
  assertPreparedIrProgram(result.program);
  return result.program;
}

function isRemainder(ref: IrFuncRef): boolean {
  return irNumberRemainderCallableDeclaration(ref) !== undefined;
}

function freezeProvider(provider: RuntimeProviderDefinition) {
  const builder = new RuntimeManifestBuilder({ backend: "wasmgc", target: "host" }, { providers: [provider] });
  builder.requestFeature(provider.feature);
  return builder.freeze();
}

describe("issue 3525 canonical numeric remainder callables", () => {
  it.each(SYMBOLS)("selects %s only through its exact intrinsic binding", (symbol) => {
    const declaration = irNumberRemainderCallableDeclaration(irIntrinsicFuncRef(symbol, "different-display-name"));
    expect(declaration).toBe(irRuntimeCallableDeclaration(irIntrinsicFuncRef(symbol)));
    expect(declaration?.params).toEqual([F64, F64]);
    expect(declaration?.results).toEqual([F64]);
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(irNumberRemainderCallableDeclaration(irRuntimeFuncRef(symbol))).toBeUndefined();
    expect(
      irNumberRemainderCallableDeclaration(irUnitFuncRef({ unitId: "foreign" as IrUnitId, name: symbol })),
    ).toBeUndefined();
    expect(irNumberRemainderCallableDeclaration(irIntrinsicFuncRef(`${symbol}_foreign`, symbol))).toBeUndefined();
    expect(() =>
      assertPreparedIrRuntimeCallableDeclaration({ ...declaration!, ref: irRuntimeFuncRef(symbol) }),
    ).toThrow(/canonical declaration/);
    expect(() => assertPreparedIrRuntimeCallableDeclaration({ ...declaration!, params: [F64] })).toThrow(
      /canonical declaration/,
    );
    expect(() => assertPreparedIrRuntimeCallableDeclaration({ ...declaration!, results: [] })).toThrow(
      /canonical declaration/,
    );
  });

  it("discovers nested counted-loop fallback calls and selects only their demanded providers", () => {
    const program = prepare(
      `export function accumulate(seed: number, limit: number): number {
    let total = seed;
    for (let i = 0; i < limit; i++) {
      if (i % 2 === 0) total = total + i;
      else total = total - i;
    }
    return total;
  }`,
    );
    const keys: string[] = [];
    for (const fn of program.ir.functions)
      for (const block of fn.blocks)
        for (const root of block.instrs)
          forEachInstrDeep(root, (instruction) => {
            if (instruction.kind === "call" && isRemainder(instruction.target)) keys.push(instruction.target.name);
          });
    expect(keys).toEqual(["__fmod"]);
    const entries = program.abi.entries.filter(
      (entry) => entry.contract.kind === "callable" && isRemainder(entry.contract.ref),
    );
    expect(entries).toHaveLength(1);
    for (const projection of program.runtime) {
      expect(
        projection.prepared.manifest.providers.filter((provider) => provider.feature.startsWith("js.number.remainder")),
      ).toEqual([NUMBER_REMAINDER_RUNTIME_PROVIDERS[0]]);
      expect(projection.prepared.manifest.hostCapabilities).toEqual([]);
    }
    expect(() =>
      assertPreparedIrProgram({
        ...program,
        abi: { entries: program.abi.entries.filter((entry) => !entries.includes(entry)) },
      }),
    ).toThrow();
    const broken = entries[0]!;
    if (broken.contract.kind !== "callable") throw new Error("missing actual remainder ABI");
    const contract = broken.contract;
    expect(() =>
      assertPreparedIrProgram({
        ...program,
        abi: {
          entries: program.abi.entries.map((entry) =>
            entry === broken ? { ...entry, contract: { ...contract, params: [F64] } } : entry,
          ),
        },
      }),
    ).toThrow(/canonical declaration|signature/);
    assertPreparedIrProgram(program);
  });

  it("refuses foreign bindings and wrong call arity in the actual semantic graph", () => {
    const program = prepare("export function calculate(a: number, b: number): number { return a % b; }");
    const changes = [
      { target: irRuntimeFuncRef("__fmod") },
      { target: irIntrinsicFuncRef("__fmod_early_magnitude") },
      { target: irIntrinsicFuncRef("__fmod_foreign", "__fmod") },
      { target: irUnitFuncRef({ unitId: "foreign" as IrUnitId, name: "__fmod" }) },
      { args: [] },
    ];
    for (const change of changes) {
      const functions = structuredClone(program.ir.functions);
      let changed = 0;
      for (const fn of functions)
        for (const block of fn.blocks)
          for (const root of block.instrs)
            forEachInstrDeep(root, (instruction) => {
              if (instruction.kind === "call" && isRemainder(instruction.target)) {
                Object.assign(instruction, change);
                changed++;
              }
            });
      expect(changed).toBe(1);
      expect(() => assertPreparedIrProgram({ ...program, ir: { ...program.ir, functions } })).toThrow();
    }
    assertPreparedIrProgram(program);
  });

  it("deduplicates both variants with deterministic canonical ABI order", () => {
    const source =
      "export function calculate(a: number, b: number): number { return a % b + a % 10000000000 + a % b; }";
    const program = prepare(source);
    const result = prepareIrProgramRuntimeCallables(program);
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
    expect(result.declarations.map((declaration) => declaration.ref.name)).toEqual([
      "__fmod_early_magnitude",
      "__fmod",
    ]);
    expect(prepareIrProgramRuntimeCallables(program)).toEqual(result);
    for (const projection of program.runtime)
      expect(
        projection.prepared.manifest.providers.filter((provider) => provider.feature.startsWith("js.number.remainder")),
      ).toEqual(NUMBER_REMAINDER_RUNTIME_PROVIDERS);
  });

  it("projects demand from a verified state buffer independently of source `%` admission", () => {
    const program = prepare(
      "export async function calculate(a: number): Promise<number> { const value = await (a + 1); return value + 2; }",
      false,
    );
    const functions = structuredClone(program.ir.functions);
    let changed = 0;
    for (const fn of functions)
      for (const state of fn.asyncPlan?.states ?? [])
        for (const root of state.body)
          forEachInstrDeep(root, (instruction) => {
            if (
              instruction.kind !== "call" ||
              instruction.target.binding.kind !== "unit" ||
              instruction.resultType?.kind !== "val" ||
              instruction.resultType.val.kind !== "f64" ||
              instruction.args.length !== 2
            )
              return;
            Object.assign(instruction, { target: irIntrinsicFuncRef("__fmod") });
            changed++;
          });
    expect(changed).toBeGreaterThan(0);
    const projected = prepareIrProgramRuntimeCallables({ ...program, ir: { ...program.ir, functions } });
    expect(projected.kind).toBe("prepared");
    if (projected.kind !== "prepared") throw new Error(JSON.stringify(projected));
    expect(projected.declarations.filter((entry) => isRemainder(entry.ref)).map((entry) => entry.ref.name)).toEqual([
      "__fmod",
    ]);
    assertPreparedIrProgram(program);
  });

  it("keeps scalar programs free of undemanded remainder providers", () => {
    const program = prepare("export function calculate(value: number): number { return value * 3 + 2; }");
    expect(
      program.abi.entries.some((entry) => entry.contract.kind === "callable" && isRemainder(entry.contract.ref)),
    ).toBe(false);
    for (const projection of program.runtime)
      expect(
        projection.prepared.manifest.providers.some((provider) => provider.feature.startsWith("js.number.remainder")),
      ).toBe(false);
  });

  it.each(NUMBER_REMAINDER_RUNTIME_PROVIDERS)("rejects substitutions for $id before provider selection", (provider) => {
    const other = NUMBER_REMAINDER_RUNTIME_PROVIDERS.find((entry) => entry.id !== provider.id)!;
    const mutations: readonly RuntimeProviderDefinition[] = [
      { ...provider, id: other.id },
      { ...provider, feature: other.feature },
      { ...provider, signature: { version: 1, params: [F64], result: F64 } },
      { ...provider, signature: { version: 1, params: [F64, F64], result: { kind: "val", val: { kind: "i32" } } } },
      { ...provider, signature: undefined },
      { ...provider, implementation: other.implementation },
      { ...provider, implementation: { kind: "runtime-callable", symbol: "__fmod_foreign" } },
      {
        ...provider,
        implementation: Object.assign(
          { kind: "runtime-callable" as const, symbol: "__fmod_foreign" },
          { toJSON: () => provider.implementation },
        ),
      },
      { ...provider, hostCapabilities: ["error.reference.construct"] },
      { ...provider, dependencies: [other.feature] },
      { ...provider, supportedTargets: ["host"] },
      { ...provider, supportedBackends: ["wasmgc"] },
    ];
    for (const mutation of mutations) {
      expect(() => freezeProvider(mutation)).toThrow(RuntimeManifestInvariantError);
      expect(() => freezeProvider(mutation)).toThrow(/number remainder callable provider .* mismatch/);
    }
    expect(freezeProvider(provider).providers).toEqual([provider]);
    const missing = new RuntimeManifestBuilder({ backend: "wasmgc", target: "host" }, { providers: [] });
    missing.requestFeature(provider.feature);
    expect(() => missing.freeze()).toThrow(RuntimeManifestInvariantError);
  });

  it("declares pure-Wasm policy support without host capabilities", () => {
    for (const backend of ["wasmgc", "linear"] as const)
      for (const target of ["host", "strict-no-host", "standalone", "wasi"] as const) {
        const builder = new RuntimeManifestBuilder({ backend, target });
        for (const provider of NUMBER_REMAINDER_RUNTIME_PROVIDERS) builder.requestFeature(provider.feature);
        const manifest = builder.freeze();
        expect(manifest.providers).toEqual(NUMBER_REMAINDER_RUNTIME_PROVIDERS);
        expect(manifest.hostCapabilities).toEqual([]);
        expect(manifest.backendRequirements).toEqual([]);
      }
  });
});
