// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ts } from "../src/ts-api.js";
import { analyzeSource } from "../src/checker/index.js";
import { generateModule, type GeneratedModule } from "../src/codegen/index.js";
import type { CodegenOptions } from "../src/codegen/context/types.js";
import { buildIrUnitInventory, type IrBindingId, type IrUnitId } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { irSupportFuncRef, irUnitCallableBindingId } from "../src/ir/callable-bindings.js";
import type { FuncTypeDef, WasmFunction } from "../src/ir/types.js";
import * as auditedFunctionBody from "../src/codegen/audited-function-body.js";
import * as auditedDeclarations from "../src/codegen/audited-declarations.js";
import * as environment from "../src/env.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { emitBinary } from "../src/emit/binary.js";
import { widenNonDefaultableTypes } from "../src/compiler/output.js";
// The maintained low-level codegen fixtures register these same delegates.
import "../src/codegen/expressions.js";

// Opposite source bodies: for [0,1,2], a real legacy === predicate keeps/maps
// three true values. Substituting the new !== RHS body instead yields zero.
const SOURCE = `
function subject(): number { return 0; }
function legacy(a, b) { return a === b; }
subject.equal = function (a, b) { return a !== b; };
export function install(): void { subject.equal = function (a, b) { return a !== b; }; }
export function filterResult(): number {
  const values: any[] = [0, 1, 2];
  return values.filter(legacy).length;
}
export function mapResult(): number {
  const values: any[] = [0, 1, 2];
  const mapped = values.map(legacy);
  return (mapped[0] === true ? 1 : 0) + (mapped[1] === true ? 1 : 0) + (mapped[2] === true ? 1 : 0);
}
export function exactFalse(): number { return subject.equal(1, 1) === false ? 1 : 0; }
export function exactTrue(): number { return subject.equal(1, 2) === true ? 1 : 0; }
export function primitiveType(): number { return typeof subject.equal(1, 2) === "boolean" ? 1 : 0; }
`;
const OPTIONS: CodegenOptions = {
  standalone: true,
  nativeStrings: true,
  semanticProviders: "native-first",
  experimentalIR: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
};
let generated: GeneratedModule;
let guest: Record<string, () => number>;
let legacyWrapper: { typeIdx: number; type: FuncTypeDef };
let rhsWrappers: Array<{ typeIdx: number; type: FuncTypeDef }>;
// These are observer counters initialized from this actual AST/inventory,
// never defaults for absent compiler telemetry.
let physicalUnitByName: Map<string, IrUnitId>;
let physicalDirectEntries: Map<IrUnitId, number>;

function requirePrepared(name: string): void {
  const unitId = physicalUnitByName.get(name);
  expect(unitId).toBeDefined();
  if (!unitId) throw new Error("prepared source unit has no physical observer counter");
  const row = generated.irOutcomes?.find((entry) => entry.unitId === unitId);
  expect(row, JSON.stringify(generated.irOutcomes)).toMatchObject({
    displayName: name,
    kind: "emitted",
    irBodyEmitted: true,
    legacyBodyEmitted: false,
    preparedComponentId: expect.any(String),
  });
  expect(row).not.toHaveProperty("r2Withdrawal");
  expect(physicalDirectEntries.has(unitId)).toBe(true);
  expect(physicalDirectEntries.get(unitId)).toBe(0);
}
function requireLegacy(name: string): void {
  const row = generated.irOutcomes?.find((entry) => entry.displayName === name);
  expect(row, JSON.stringify(generated.irOutcomes)).toBeDefined();
  expect(row?.legacyBodyEmitted).toBe(true);
  expect(row?.irBodyEmitted).not.toBe(true);
  const unitId = physicalUnitByName.get(name);
  expect(unitId).toBeDefined();
  if (!unitId) throw new Error("legacy reader has no exact source-unit counter");
  expect(physicalDirectEntries.get(unitId)).toBe(1);
}
// Read finalized canonical ABI indices, never guessed synthetic function names
// or logical WAT exports. A mismatch is a failed prerequisite, not normalized.
function actualFunctionType(id: IrBindingId): { typeIdx: number; type: FuncTypeDef; func: WasmFunction } {
  const final = generated.programAbi?.abi.resolveFinalIndex(id);
  if (!final || final.space !== "function") throw new Error("missing real callable binding");
  const importCount = generated.module.imports.filter((entry) => entry.desc.kind === "func").length;
  const fn = generated.module.functions[final.index - importCount];
  if (!fn) throw new Error("published callable has no allocated function");
  const type = generated.module.types[fn.typeIdx];
  if (!type || type.kind !== "func") throw new Error("allocated callable has no function type");
  return { typeIdx: fn.typeIdx, type, func: fn };
}

// The same complete transparent observer serves both the prepared witness
// and an independently registered genuine direct-initializer positive.
function generateWithPhysicalEntryWitness(
  ast: ReturnType<typeof analyzeSource>,
  identity: ReturnType<typeof buildIrPlanningIdentityContext>,
  predicate?: ts.FunctionDeclaration,
) {
  let generated: GeneratedModule;
  const unitOf = (node: ts.Declaration): IrUnitId => {
    const unitId = identity.unitIdByDeclaration.get(node);
    if (!unitId) throw new Error("physical source declaration has no inventory unit");
    return unitId;
  };
  const physicalUnitByName = new Map<string, IrUnitId>();
  const physicalDirectEntries = new Map<IrUnitId, number>();
  const declarationByUnit = new Map<IrUnitId, ts.FunctionDeclaration>();
  for (const declaration of ast.sourceFile.statements) {
    if (!ts.isFunctionDeclaration(declaration) || !declaration.name || !declaration.body) continue;
    const unitId = unitOf(declaration);
    expect(identity.declarationByUnitId.get(unitId)).toBe(declaration);
    physicalUnitByName.set(declaration.name.text, unitId);
    physicalDirectEntries.set(unitId, 0);
    declarationByUnit.set(unitId, declaration);
  }
  const moduleInitUnit = identity.moduleInitUnitIdBySourceFile.get(ast.sourceFile);
  if (!moduleInitUnit) throw new Error("actual source module-init unit lost");
  expect(identity.unitByUnitId.get(moduleInitUnit)?.kind).toBe("module-init");
  physicalUnitByName.set("<module-init>", moduleInitUnit);
  physicalDirectEntries.set(moduleInitUnit, 0);
  const sourceId = identity.sourceIdBySourceFile.get(ast.sourceFile);
  expect(sourceId).toBeDefined();
  expect(identity.sourceFileBySourceId.get(sourceId!)).toBe(ast.sourceFile);

  // compileModuleInitBody is PRIVATE. Its unique readEnv marker immediately
  // follows its physical recordRoot, so observe that exact current source
  // site while the real declaration wrapper binds this SourceFile. No env
  // value, context, route label, compiler report or callback is changed.
  const originalBody = auditedFunctionBody.compileFunctionBody;
  const originalDeclarations = auditedDeclarations.compileDeclarations;
  const originalReadEnv = environment.readEnv;
  const directPredicateAllocators: WasmFunction[] = [];
  const predicateBindingId = predicate ? irUnitCallableBindingId(unitOf(predicate)) : undefined;
  let predicateSession: ProgramAbiSession | undefined;
  const acceptedPredicateReplacements: Array<{
    readonly session: ProgramAbiSession;
    readonly previous: WasmFunction;
    readonly replacement: WasmFunction;
  }> = [];
  const originalReplacement = ProgramAbiSession.prototype.replaceDefinedFunctionLocator;
  let replacementEntries = 0,
    replacementForwarded = 0,
    replacementReturned = 0,
    replacementThrows = 0;
  const activeSources: ts.SourceFile[] = [];
  const observerErrors: string[] = [];
  const restores: Array<() => void> = [];
  let bodyEntries = 0,
    bodyForwarded = 0;
  let declarationEntries = 0,
    declarationForwarded = 0,
    matchingSourceEntries = 0;
  let envEntries = 0,
    envForwarded = 0;
  const observe = (work: () => void): void => {
    try {
      work();
    } catch {
      observerErrors.push("physical observer failed");
    }
  };
  try {
    const replacementSpy = vi
      .spyOn(ProgramAbiSession.prototype, "replaceDefinedFunctionLocator")
      .mockImplementation(function (
        this: ProgramAbiSession,
        ...args: Parameters<typeof originalReplacement>
      ): ReturnType<typeof originalReplacement> {
        replacementEntries++;
        replacementForwarded++;
        let result: ReturnType<typeof originalReplacement>;
        try {
          result = Reflect.apply(originalReplacement, this, args);
        } catch (error) {
          replacementThrows++;
          throw error;
        }
        replacementReturned++;
        // Only a successful canonical locator transfer is evidence. The real
        // method has already checked old object/owner/type and unsealed scope.
        observe(() => {
          if (predicateBindingId !== undefined && args[0] === predicateBindingId) {
            acceptedPredicateReplacements.push({ session: this, previous: args[1], replacement: args[2] });
          }
        });
        return result;
      });
    restores.push(() => replacementSpy.mockRestore());
    const bodySpy = vi.spyOn(auditedFunctionBody, "compileFunctionBody").mockImplementation(function (
      this: unknown,
      ...args: Parameters<typeof originalBody>
    ): ReturnType<typeof originalBody> {
      bodyEntries++;
      observe(() => {
        const unitId = identity.unitIdByDeclaration.get(args[1]);
        if (unitId && declarationByUnit.get(unitId) === args[1]) {
          const count = physicalDirectEntries.get(unitId);
          if (count === undefined) observerErrors.push("source function counter missing");
          else physicalDirectEntries.set(unitId, count + 1);
        }
        if (args[1] === predicate) {
          directPredicateAllocators.push(args[2]);
          const session = args[0].programAbiSession;
          if (!session) observerErrors.push("predicate physical entry has no real ABI session");
          else if (predicateSession && predicateSession !== session)
            observerErrors.push("predicate ABI session changed");
          else predicateSession = session;
        }
      });
      bodyForwarded++;
      return Reflect.apply(originalBody, this, args);
    });
    restores.push(() => bodySpy.mockRestore());
    const declarationSpy = vi.spyOn(auditedDeclarations, "compileDeclarations").mockImplementation(function (
      this: unknown,
      ...args: Parameters<typeof originalDeclarations>
    ): ReturnType<typeof originalDeclarations> {
      declarationEntries++;
      observe(() => {
        activeSources.push(args[1]);
        if (args[1] === ast.sourceFile) matchingSourceEntries++;
      });
      declarationForwarded++;
      try {
        return Reflect.apply(originalDeclarations, this, args);
      } finally {
        observe(() => {
          if (activeSources.pop() !== args[1]) observerErrors.push("declaration source stack mismatch");
        });
      }
    });
    restores.push(() => declarationSpy.mockRestore());
    const envSpy = vi.spyOn(environment, "readEnv").mockImplementation(function (
      this: unknown,
      ...args: Parameters<typeof originalReadEnv>
    ): ReturnType<typeof originalReadEnv> {
      envEntries++;
      observe(() => {
        if (args[0] !== "JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY") return;
        if (activeSources[activeSources.length - 1] !== ast.sourceFile) {
          observerErrors.push("module-init physical marker outside exact source wrapper");
          return;
        }
        const count = physicalDirectEntries.get(moduleInitUnit);
        if (count === undefined) observerErrors.push("source module-init counter missing");
        else physicalDirectEntries.set(moduleInitUnit, count + 1);
      });
      envForwarded++;
      return Reflect.apply(originalReadEnv, this, args);
    });
    restores.push(() => envSpy.mockRestore());
    generated = generateModule(ast, OPTIONS);
  } finally {
    for (let index = restores.length - 1; index >= 0; index--) observe(restores[index]!);
  }
  // A failed generator or observer cannot make a zero claim.
  expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
  expect(observerErrors).toEqual([]);
  expect(activeSources).toEqual([]);
  expect(auditedFunctionBody.compileFunctionBody).toBe(originalBody);
  expect(auditedDeclarations.compileDeclarations).toBe(originalDeclarations);
  expect(environment.readEnv).toBe(originalReadEnv);
  expect(ProgramAbiSession.prototype.replaceDefinedFunctionLocator).toBe(originalReplacement);
  expect(replacementForwarded).toBe(replacementEntries);
  expect(replacementReturned + replacementThrows).toBe(replacementEntries);
  expect(replacementThrows).toBe(0);
  // The HOF witness requires genuine physical function-body entry. The
  // independent initializer positive may have its read() wholly prepared;
  // its own assertion below requires actual private initializer entry instead.
  if (predicate !== undefined) expect(bodyEntries).toBeGreaterThan(0);
  expect(bodyForwarded).toBe(bodyEntries);
  expect(declarationEntries).toBeGreaterThan(0);
  expect(matchingSourceEntries).toBeGreaterThan(0);
  expect(declarationForwarded).toBe(declarationEntries);
  expect(envEntries).toBeGreaterThan(0);
  expect(envForwarded).toBe(envEntries);
  return {
    generated,
    physicalUnitByName,
    physicalDirectEntries,
    directPredicateAllocators,
    predicateSession,
    acceptedPredicateReplacements,
  };
}

describe("#7106 prepared RHS shared physical signature and real legacy HOF consumers", () => {
  beforeAll(async () => {
    const ast = analyzeSource(SOURCE, "issue-7106-rhs-hof-metadata.ts");
    const identity = buildIrPlanningIdentityContext(
      buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile }),
    );
    const legacy = ast.sourceFile.statements.find(
      (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "legacy",
    );
    if (!legacy) throw new Error("actual legacy declaration lost");
    const rhsNodes: ts.FunctionExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        ts.isFunctionExpression(node.right) &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === "equal"
      )
        rhsNodes.push(node.right);
      ts.forEachChild(node, visit);
    };
    visit(ast.sourceFile);
    expect(rhsNodes).toHaveLength(2);
    const unitOf = (node: ts.Declaration): IrUnitId => {
      const unitId = identity.unitIdByDeclaration.get(node);
      if (!unitId) throw new Error("actual source declaration has no inventory unit");
      return unitId;
    };
    const physical = generateWithPhysicalEntryWitness(ast, identity, legacy);
    generated = physical.generated;
    physicalUnitByName = physical.physicalUnitByName;
    physicalDirectEntries = physical.physicalDirectEntries;
    const directPredicateAllocators = physical.directPredicateAllocators;
    const legacyUnit = unitOf(legacy);
    const legacyRecord = identity.unitByUnitId.get(legacyUnit);
    expect(identity.declarationByUnitId.get(legacyUnit)).toBe(legacy);
    expect(legacyRecord).toBeDefined();
    expect(identity.sourceFileBySourceId.get(legacyRecord!.sourceId)).toBe(ast.sourceFile);
    expect(legacy.getSourceFile()).toBe(ast.sourceFile);
    expect(directPredicateAllocators).toHaveLength(1);
    // Later ordinary IR overlays may replace this exact physical allocator.
    // Every link must have been accepted by the SAME actual session for THIS
    // source-unit binding; no name/signature/index resemblance is authority.
    expect(physical.predicateSession).toBeDefined();
    let currentPredicateAllocator = directPredicateAllocators[0]!;
    for (const link of physical.acceptedPredicateReplacements) {
      expect(link.session).toBe(physical.predicateSession);
      expect(link.previous).toBe(currentPredicateAllocator);
      currentPredicateAllocator = link.replacement;
    }
    expect(actualFunctionType(irUnitCallableBindingId(legacyUnit)).func).toBe(currentPredicateAllocator);
    expect(generated.irOutcomes?.find((entry) => entry.unitId === legacyUnit)?.legacyBodyEmitted).toBe(true);
    requirePrepared("<module-init>");
    requirePrepared("install");
    requireLegacy("filterResult");
    requireLegacy("mapResult");
    legacyWrapper = actualFunctionType(
      irSupportFuncRef(unitOf(legacy), "function-value-trampoline", "diagnostic-only").binding.bindingId,
    );
    rhsWrappers = rhsNodes.map((rhs) => actualFunctionType(irUnitCallableBindingId(unitOf(rhs))));
    // Shared-signature evidence is a prerequisite: no guest observations are
    // credited if real callback specialization produced a different ABI.
    expect(legacyWrapper.type.params.map((type) => type.kind)).toEqual(["ref", "externref", "externref"]);
    expect(legacyWrapper.type.results).toEqual([{ kind: "i32", boolean: true }]);
    for (const rhs of rhsWrappers) {
      expect(rhs.typeIdx).toBe(legacyWrapper.typeIdx);
      expect(rhs.type).toBe(legacyWrapper.type);
    }
    // Preserve the genuine pre-output ABI above, then run the SAME normal
    // public compiler finalization on this module before binary emission.
    // Defaultability changes reference nullability, never allocation identity.
    const allocatorModule = generated.module;
    const outputBindings = [
      irUnitCallableBindingId(legacyUnit),
      irSupportFuncRef(legacyUnit, "function-value-trampoline", "diagnostic-only").binding.bindingId,
      ...rhsNodes.map((rhs) => irUnitCallableBindingId(unitOf(rhs))),
    ];
    const beforeOutput = outputBindings.map((id) => {
      const final = generated.programAbi!.abi.resolveFinalIndex(id);
      if (!final || final.space !== "function") throw new Error("pre-output callable lost its exact ABI slot");
      return { id, finalIndex: final.index, ...actualFunctionType(id) };
    });
    widenNonDefaultableTypes(generated.module);
    expect(generated.module).toBe(allocatorModule);
    for (const previous of beforeOutput) {
      const final = generated.programAbi!.abi.resolveFinalIndex(previous.id);
      expect(final).toMatchObject({ space: "function", index: previous.finalIndex });
      const current = actualFunctionType(previous.id);
      expect(current.func).toBe(previous.func);
      expect(current.typeIdx).toBe(previous.typeIdx);
      expect(current.type).toBe(previous.type);
    }
    expect(legacyWrapper.type.params.map((type) => type.kind)).toEqual(["ref_null", "externref", "externref"]);
    expect(legacyWrapper.type.results).toEqual([{ kind: "i32", boolean: true }]);
    for (const rhs of rhsWrappers) {
      expect(rhs.typeIdx).toBe(legacyWrapper.typeIdx);
      expect(rhs.type).toBe(legacyWrapper.type);
    }
    // Emit and instantiate this SAME finalized allocator module. No second
    // compilation, clone, injected ClosureInfo or cross-artifact source join.
    const binary = emitBinary(generated.module);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(binary))).toEqual([]);
    const { instance } = await WebAssembly.instantiate(binary, {});
    expect(typeof instance.exports.__module_init).toBe("function");
    (instance.exports.__module_init as () => void)();
    guest = instance.exports as Record<string, () => number>;
  }, 35_000);

  it("really allocates the same canonical two-externref/i32 wrapper function type", () => {
    expect(legacyWrapper.type.params.map((type) => type.kind)).toEqual(["ref_null", "externref", "externref"]);
    expect(legacyWrapper.type.results).toEqual([{ kind: "i32", boolean: true }]);
    for (const rhs of rhsWrappers) {
      expect(rhs.typeIdx).toBe(legacyWrapper.typeIdx);
      expect(rhs.type).toBe(legacyWrapper.type);
    }
  });
  it("keeps the real legacy filter predicate instead of the opposite prepared RHS body", () => {
    guest.install!();
    expect(guest.filterResult!()).toBe(3);
  });
  it("keeps primitive Boolean legacy map results instead of the opposite RHS body", () => {
    guest.install!();
    expect(guest.mapResult!()).toBe(3);
  });
  it("returns primitive false at the genuine prepared native member boundary", () => {
    requirePrepared("exactFalse");
    expect(guest.exactFalse!()).toBe(1);
  });
  it("returns primitive true at the genuine prepared native member boundary", () => {
    requirePrepared("exactTrue");
    expect(guest.exactTrue!()).toBe(1);
  });
  it("reports Boolean typeof at the genuine prepared native member boundary", () => {
    requirePrepared("primitiveType");
    expect(guest.primitiveType!()).toBe(1);
  });
});

// Genuine effectful initialization deliberately outside both existing early
// certificates: R4 explicitly excludes remainder compound assignments, and
// the member-only path cannot certify lexical storage or this scalar work.
// No environment key is manually read/called by this control.
it("observes the real private module-init entry marker on a direct initializer positive", () => {
  const ast = analyzeSource(
    `let value = 3;
value %= 2;
export function read(): number { return value; }`,
    "issue-7106-hof-direct-init-marker-positive.ts",
  );
  const identity = buildIrPlanningIdentityContext(
    buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile }),
  );
  const physical = generateWithPhysicalEntryWitness(ast, identity);
  const unitId = identity.moduleInitUnitIdBySourceFile.get(ast.sourceFile);
  expect(unitId).toBeDefined();
  if (!unitId) throw new Error("direct positive has no actual initializer unit");
  expect(physical.physicalUnitByName.get("<module-init>")).toBe(unitId);
  expect(physical.physicalDirectEntries.has(unitId)).toBe(true);
  expect(physical.physicalDirectEntries.get(unitId)).toBeGreaterThan(0);
  const row = physical.generated.irOutcomes?.find((entry) => entry.unitId === unitId);
  expect(row).toBeDefined();
  expect(row?.legacyBodyEmitted).toBe(true);
  expect(row).not.toHaveProperty("preparedComponentId");
});
