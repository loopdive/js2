// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { generateModule } from "../src/codegen/index.js";
import {
  catalogProgramAbiCallableImports,
  planProgramAbiCallableImports,
} from "../src/codegen/program-abi-import-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { irCallableBindingKey, irIntrinsicFuncRef, irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { IR_STRING_COMPARE_FN } from "../src/ir/from-ast.js";
import { ProgramAbiInvariantError } from "../src/ir/program-abi.js";
import {
  createEmptyModule,
  type FuncTypeDef,
  type Import,
  type WasmFunction,
  type WasmModule,
} from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const F64_TO_F64: FuncTypeDef = {
  kind: "func",
  params: [{ kind: "f64" }],
  results: [{ kind: "f64" }],
};

function source(fileName = "/repo/entry.ts"): ts.SourceFile {
  return ts.createSourceFile(fileName, "export function main() {}", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function fixture(module: WasmModule) {
  const entryFile = source();
  const inventory = buildIrUnitInventory([entryFile], { entrySource: entryFile });
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
  ctx.numImportFuncs = module.imports.filter((value) => value.desc.kind === "func").length;
  const providers = ctx.programAbiCallableProviders;
  if (!providers) throw new Error("missing callable-provider registry");
  return { ctx, providers, session };
}

function functionImport(module: string, name: string, typeIdx: number): Import {
  return { module, name, desc: { kind: "func", typeIdx } };
}

function definedFunction(name: string, typeIdx: number): WasmFunction {
  return {
    name,
    typeIdx,
    locals: [],
    body: [{ op: "f64.const", value: 0 }],
    exported: false,
  };
}

function providerFixture(reverseObservation: boolean) {
  const module = createEmptyModule();
  module.types.push(F64_TO_F64);
  const runtimeImport = functionImport("env", "Math_sin", 0);
  const intrinsicFunction = definedFunction("__fmod", 0);
  module.imports.push(runtimeImport);
  module.functions.push(intrinsicFunction);
  const { ctx, providers, session } = fixture(module);
  const runtimeRef = irRuntimeFuncRef("Math_sin", "__misleading_runtime_label");
  const intrinsicRef = irIntrinsicFuncRef("__fmod", "__misleading_intrinsic_label");

  const observations = reverseObservation
    ? ([
        [intrinsicRef, 1],
        [runtimeRef, 0],
      ] as const)
    : ([
        [runtimeRef, 0],
        [intrinsicRef, 1],
      ] as const);
  for (const [ref, index] of observations) providers.observe(ref, index);

  // Shift every prior function index without touching either provider object.
  const lateImport = functionImport("late", "before-providers", 0);
  module.imports.unshift(lateImport);
  ctx.numImportFuncs++;
  expect(providers.resolveCurrentIndex(irRuntimeFuncRef("Math_sin", "another-label"))).toBe(1);
  expect(providers.resolveCurrentIndex(irIntrinsicFuncRef("__fmod", "another-label"))).toBe(2);

  planProgramAbiCallableImports(ctx);
  const providerIds = providers.planRetained();
  const publication = session.publish(module);
  return {
    intrinsicFunction,
    intrinsicRef,
    module,
    providerIds,
    publication,
    runtimeImport,
    runtimeRef,
    session,
  };
}

describe("#3520 runtime/intrinsic callable-provider Program ABI", () => {
  it("tracks exact provider objects through shifts and plans deterministic provider identities", () => {
    const forward = providerFixture(false);
    const reverse = providerFixture(true);
    const runtimeKey = irCallableBindingKey(forward.runtimeRef.binding);
    const intrinsicKey = irCallableBindingKey(forward.intrinsicRef.binding);

    expect([...forward.providerIds]).toEqual([...reverse.providerIds]);
    expect([...forward.providerIds.keys()]).toEqual([intrinsicKey, runtimeKey].sort());

    const runtimeId = forward.providerIds.get(runtimeKey)!;
    const intrinsicId = forward.providerIds.get(intrinsicKey)!;
    expect(runtimeId).not.toBe(intrinsicId);
    expect(forward.session.getDraft(runtimeId)).toMatchObject({
      structuralReferenceKey: runtimeKey,
      displayName: "Math_sin",
      slotPolicy: "alias",
      intent: {
        kind: "callable",
        origin: "runtime",
      },
    });
    expect(forward.session.getDraft(intrinsicId)).toMatchObject({
      structuralReferenceKey: intrinsicKey,
      displayName: "__fmod",
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "intrinsic",
      },
    });
    expect(forward.session.hasLocator(runtimeId)).toBe(false);
    expect(forward.session.hasLocator(intrinsicId, forward.intrinsicFunction)).toBe(true);
    expect(forward.publication.abi.resolveFinalIndex(runtimeId)).toEqual({ space: "function", index: 1 });
    expect(forward.publication.abi.resolveFinalIndex(intrinsicId)).toEqual({ space: "function", index: 2 });
    expect(forward.module.imports[1]).toBe(forward.runtimeImport);
    expect(forward.module.functions[0]).toBe(forward.intrinsicFunction);
  });

  it("makes one deterministic provider own a shared object and aliases every other semantic binding", () => {
    const module = createEmptyModule();
    module.types.push(F64_TO_F64);
    const shared = definedFunction("shared-provider", 0);
    module.functions.push(shared);
    const { providers, session } = fixture(module);
    const runtimeRef = irRuntimeFuncRef("runtime-shared");
    const intrinsicRef = irIntrinsicFuncRef("intrinsic-shared");

    providers.observe(runtimeRef, 0);
    providers.observe(intrinsicRef, 0);
    const ids = providers.planRetained();
    const runtimeId = ids.get(irCallableBindingKey(runtimeRef.binding))!;
    const intrinsicId = ids.get(irCallableBindingKey(intrinsicRef.binding))!;
    const publication = session.publish(module);

    expect(session.hasLocator(intrinsicId, shared)).toBe(true);
    expect(session.hasLocator(runtimeId)).toBe(false);
    expect(publication.abi.canonicalId(runtimeId)).toBe(intrinsicId);
    expect(publication.abi.resolveFinalIndex(runtimeId)).toEqual({ space: "function", index: 0 });
    expect(publication.abi.resolveFinalIndex(intrinsicId)).toEqual({ space: "function", index: 0 });
  });

  it("rejects one structural provider changing allocator ownership", () => {
    const module = createEmptyModule();
    module.types.push(F64_TO_F64);
    module.functions.push(definedFunction("first", 0), definedFunction("second", 0));
    const { providers } = fixture(module);
    const ref = irRuntimeFuncRef("provider", "first-label");
    providers.observe(ref, 0);

    expect(() => providers.observe(irRuntimeFuncRef("provider", "second-label"), 1)).toThrowError(
      expect.objectContaining<ProgramAbiInvariantError>({ code: "callable-provider-mismatch" }),
    );
  });

  it("discards a dead import observed only by an IR candidate that later withdrew", () => {
    const module = createEmptyModule();
    module.types.push(F64_TO_F64);
    module.imports.push(functionImport("env", "__candidate_only", 0));
    const { ctx, providers, session } = fixture(module);
    const ref = irRuntimeFuncRef("__candidate_only");
    providers.observe(ref, 0);

    // Mirror dead-import elimination after the candidate's body is withdrawn:
    // no final Wasm body refers to this import, so it is absent from the
    // retained callable population and must not become a required ABI entry.
    module.imports = [];
    ctx.numImportFuncs = 0;
    expect(planProgramAbiCallableImports(ctx).size).toBe(0);
    expect(providers.planRetained().size).toBe(0);
    expect(session.publish(module).abi.entries()).toEqual([]);
  });

  it("prepares a required defined provider without retaining a withdrawn candidate import", () => {
    const module = createEmptyModule();
    module.types.push(F64_TO_F64);
    module.imports.push(functionImport("env", "__candidate_only", 0));
    const fmod = definedFunction("__fmod", 0);
    module.functions.push(fmod);
    const { ctx, providers, session } = fixture(module);
    const deadRef = irRuntimeFuncRef("__candidate_only");
    const fmodRef = irIntrinsicFuncRef("__fmod");
    const deadKey = irCallableBindingKey(deadRef.binding);
    const fmodKey = irCallableBindingKey(fmodRef.binding);
    providers.observe(deadRef, 0);
    providers.observe(fmodRef, 1);

    expect(providers.canPlanPrepared(new Set([deadKey]))).toBe(false);
    expect(providers.canPlanPrepared(new Set([fmodKey]))).toBe(true);
    const prepared = providers.planPrepared(new Set([fmodKey]));
    expect([...prepared.keys()]).toEqual([fmodKey]);
    expect(session.hasLocator(prepared.get(fmodKey)!, fmod)).toBe(true);
    expect(() => providers.observe(irRuntimeFuncRef("__late_provider"), 1)).toThrowError(
      expect.objectContaining<ProgramAbiInvariantError>({ code: "planning-sealed" }),
    );

    module.imports = [];
    ctx.numImportFuncs = 0;
    expect(planProgramAbiCallableImports(ctx).size).toBe(0);
    expect([...providers.planRetained().keys()]).toEqual([fmodKey]);
    expect(session.publish(module).abi.resolveFinalIndex(prepared.get(fmodKey)!)).toEqual({
      space: "function",
      index: 0,
    });
  });

  it("aliases a prepared import-backed provider to its canonical import while discarding a dead sibling", () => {
    const module = createEmptyModule();
    module.types.push(F64_TO_F64);
    const deadImport = functionImport("env", "__candidate_only", 0);
    const targetImport = functionImport("env", "runtime_target", 0);
    module.imports.push(deadImport, targetImport);
    const { ctx, providers, session } = fixture(module);
    const deadRef = irRuntimeFuncRef("__candidate_only");
    const targetRef = irRuntimeFuncRef("runtime_target");
    const deadKey = irCallableBindingKey(deadRef.binding);
    const targetKey = irCallableBindingKey(targetRef.binding);
    providers.observe(deadRef, 0);
    providers.observe(targetRef, 1);

    catalogProgramAbiCallableImports(ctx);
    const providerImports = providers.importsForPreparedProviders(new Set([targetKey]));
    if (!providerImports || !ctx.programAbiCallableImports) throw new Error("missing prepared import population");
    ctx.programAbiCallableImports.planPrepared(providerImports);
    expect(providers.canPlanPrepared(new Set([targetKey]))).toBe(true);
    const providerId = providers.planPrepared(new Set([targetKey])).get(targetKey)!;
    const importId = session.locatorBindingId(targetImport)!;
    expect(session.getDraft(providerId)).toMatchObject({
      structuralReferenceKey: targetKey,
      slotPolicy: "alias",
      aliasOf: importId,
      intent: { kind: "callable", origin: "runtime" },
    });
    expect(session.getDraft(importId)).toMatchObject({
      slotPolicy: "required",
      intent: { kind: "callable", origin: "import" },
    });

    module.imports = [targetImport];
    ctx.numImportFuncs = 1;
    planProgramAbiCallableImports(ctx);
    expect([...providers.planRetained().keys()]).toEqual([targetKey]);
    expect(session.bindingIdsForStructuralReference(deadKey)).toEqual([]);
    const { abi } = session.publish(module);
    expect(abi.canonicalId(providerId)).toBe(importId);
    expect(abi.resolveFinalIndex(providerId)).toEqual({ space: "function", index: 0 });
  });

  it("publishes production Math and remainder providers without compatibility labels owning their slots", () => {
    const ast = analyzeSource(
      `
        export function main(a: number, b: number): number {
          return Math.sin(a) + (a % b);
        }
      `,
      "callable-provider-abi.ts",
    );
    const result = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.irCompiledFuncs).toContain("main");
    expect(result.irPostClaimErrors).toEqual([]);
    expect(result.programAbi).toBeDefined();

    for (const ref of [irRuntimeFuncRef("Math_sin"), irIntrinsicFuncRef("__fmod")]) {
      const key = irCallableBindingKey(ref.binding);
      const entries = result.programAbi!.abi.entries().filter((entry) => entry.structuralReferenceKey === key);
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry).toMatchObject({
        structuralReferenceKey: key,
        displayName: ref.binding.symbol,
        intent: {
          kind: "callable",
          origin: ref.binding.kind,
        },
      });
      const finalIndex = result.programAbi!.abi.resolveFinalIndex(entry.id);
      expect(finalIndex).toEqual(expect.objectContaining({ space: "function" }));
    }
  });

  it("binds one string-compare intrinsic to the mode-selected import or definition", () => {
    const sourceText = `
      export function main(left: string, right: string): boolean {
        return left < right;
      }
    `;
    const host = generateModule(analyzeSource(sourceText, "provider-host.ts"), {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const native = generateModule(analyzeSource(sourceText, "provider-native.ts"), {
      experimentalIR: true,
      nativeStrings: true,
      trackIrOutcomes: true,
    });
    for (const result of [host, native]) {
      const hardErrors = result.errors.filter((error) => error.severity !== "warning");
      expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
      expect(result.irCompiledFuncs).toContain("main");
      expect(result.irPostClaimErrors).toEqual([]);
    }

    const key = irCallableBindingKey(irIntrinsicFuncRef(IR_STRING_COMPARE_FN, "misleading-label").binding);
    const hostEntry = host.programAbi!.abi.entries().find((entry) => entry.structuralReferenceKey === key);
    const nativeEntry = native.programAbi!.abi.entries().find((entry) => entry.structuralReferenceKey === key);
    expect(hostEntry).toMatchObject({
      displayName: IR_STRING_COMPARE_FN,
      slotPolicy: "alias",
      intent: { kind: "callable", origin: "intrinsic" },
    });
    expect(nativeEntry).toMatchObject({
      displayName: IR_STRING_COMPARE_FN,
      slotPolicy: "required",
      slotSpace: "function",
      intent: { kind: "callable", origin: "intrinsic" },
    });

    const hostIndex = host.programAbi!.abi.resolveFinalIndex(hostEntry!.id);
    const nativeIndex = native.programAbi!.abi.resolveFinalIndex(nativeEntry!.id);
    expect(hostIndex).toEqual(expect.objectContaining({ space: "function" }));
    expect(nativeIndex).toEqual(expect.objectContaining({ space: "function" }));
    if (!hostIndex || hostIndex.space !== "function" || !nativeIndex || nativeIndex.space !== "function") {
      throw new Error("missing mode-selected string compare provider");
    }
    const hostImport = host.module.imports.filter((value) => value.desc.kind === "func")[hostIndex.index];
    const nativeImportCount = native.module.imports.filter((value) => value.desc.kind === "func").length;
    const nativeFunction = native.module.functions[nativeIndex.index - nativeImportCount];
    expect(hostImport).toMatchObject({ module: "env", name: "string_compare", desc: { kind: "func" } });
    expect(nativeFunction?.name).toBe("__str_compare");
  });
});
