// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { compileDeclarations, collectDeclarations } from "../src/codegen/declarations.js";
import {
  programAbiDeclaredGlobals,
  programAbiModuleDeclarations,
} from "../src/codegen/program-abi-declared-globals.js";
import { planProgramAbiStringConstantImport } from "../src/codegen/program-abi-import-planning.js";
import { planProgramAbiGlobal, PROGRAM_ABI_GLOBAL_ROLE } from "../src/codegen/program-abi-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { irImportGlobalRef, irModuleGlobalRef, irSupportGlobalRef } from "../src/ir/abi-bindings.js";
import { irBindingKey, irModuleDeclarations } from "../src/ir/declared-types.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { compileIrPathFunctions } from "../src/ir/integration.js";
import {
  asBlockId,
  asValueId,
  irVal,
  type IrFunction,
  type IrGlobalRef,
  type IrInstr,
  type IrModule,
  type IrType,
} from "../src/ir/nodes.js";
import { buildIrLegacyUnitProjection, buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { ProgramAbiInvariantError, type ProgramAbiInvariantCode } from "../src/ir/program-abi.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { createEmptyModule, type GlobalDef, type Import } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

const I32 = irVal({ kind: "i32" });
const F64 = irVal({ kind: "f64" });

function realSessionFixture() {
  const sourceFile = ts.createSourceFile(
    "/repo/issue-4608.ts",
    "function owner() {}",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  const owner = inventory.terminalUnits.find((unit) => unit.displayName === "owner");
  if (!owner) throw new Error("missing owner unit");

  const wasmModule = createEmptyModule();
  const session = new ProgramAbiSession(inventory, wasmModule);
  const ctx = createCodegenContext(wasmModule, {} as ts.TypeChecker, {}, session);
  return { ctx, owner, session, wasmModule };
}

function irFunction(unitId: IrFunction["unitId"], instrs: IrInstr[], name = "writer"): IrFunction {
  return {
    unitId,
    name,
    params: [],
    resultTypes: [],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: { kind: "return", values: [] },
      },
    ],
    exported: false,
    valueCount: 8,
  };
}

function globalWriter(
  unitId: IrFunction["unitId"],
  ref: IrGlobalRef,
  options: { readonly carrier?: "i32" | "f64"; readonly nested?: boolean } = {},
): IrFunction {
  const carrier = options.carrier ?? "i32";
  const valueType: IrType = carrier === "i32" ? I32 : F64;
  const value: IrInstr =
    carrier === "i32"
      ? { kind: "const", value: { kind: "i32", value: 1 }, result: asValueId(0), resultType: valueType }
      : { kind: "const", value: { kind: "f64", value: 1 }, result: asValueId(0), resultType: valueType };
  const write: IrInstr = {
    kind: "global.set",
    target: ref,
    value: asValueId(0),
    result: null,
    resultType: null,
  };
  const instrs: IrInstr[] = [
    value,
    ...(options.nested
      ? [
          {
            kind: "if.stmt" as const,
            cond: asValueId(0),
            then: [write],
            else: [],
            result: null,
            resultType: null,
          },
        ]
      : [write]),
  ];
  return irFunction(unitId, instrs);
}

function planGlobal(
  fixture: ReturnType<typeof realSessionFixture>,
  ref: IrGlobalRef,
  global: GlobalDef,
  derivedOrdinal = 0,
): void {
  fixture.wasmModule.globals.push(global);
  planProgramAbiGlobal(fixture.ctx, {
    ref,
    anchor: { kind: "unit", unitId: fixture.owner.id },
    roleOrdinal: PROGRAM_ABI_GLOBAL_ROLE.moduleValue,
    derivedOrdinal,
    global,
  });
}

function messages(fn: IrFunction, module: IrModule): string[] {
  return verifyIrFunction(fn, undefined, irModuleDeclarations(module)).map((error) => error.message);
}

function withProductionDeclarations(
  fixture: ReturnType<typeof realSessionFixture>,
  functions: readonly IrFunction[],
): IrModule {
  return {
    functions,
    declaredGlobals: programAbiDeclaredGlobals(fixture.ctx, { functions }),
  };
}

function expectProgramAbiInvariant(run: () => unknown, code: ProgramAbiInvariantCode): void {
  try {
    run();
    throw new Error(`expected ProgramAbiInvariantError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProgramAbiInvariantError);
    expect((error as ProgramAbiInvariantError).code).toBe(code);
  }
}

describe("#4608 Program ABI declared-global production", () => {
  it("catches one coherent declaration-only mismatch from a real Program ABI session", () => {
    const fixture = realSessionFixture();
    const ref = irSupportGlobalRef(fixture.owner.id, "declared-global", "g");
    planGlobal(fixture, ref, {
      name: "g",
      type: { kind: "f64" },
      mutable: true,
      init: [{ op: "f64.const", value: 0 }],
    });
    const fn = globalWriter(fixture.owner.id, ref);

    expect(messages(fn, withProductionDeclarations(fixture, [fn]))).toContain(
      "global.set g carrier i32 contradicts the module-declared f64",
    );
  });

  it("accepts a matching allocator carrier and stays conservative without a session", () => {
    const fixture = realSessionFixture();
    const ref = irSupportGlobalRef(fixture.owner.id, "matching-global", "g");
    planGlobal(fixture, ref, {
      name: "g",
      type: { kind: "f64" },
      mutable: true,
      init: [{ op: "f64.const", value: 0 }],
    });
    const matching = globalWriter(fixture.owner.id, ref, { carrier: "f64" });
    expect(messages(matching, withProductionDeclarations(fixture, [matching]))).toEqual([]);

    const mismatching = globalWriter(fixture.owner.id, ref);
    expect(
      programAbiDeclaredGlobals(
        { mod: fixture.wasmModule, programAbiSession: undefined },
        { functions: [mismatching] },
      ),
    ).toBeUndefined();
    expect(messages(mismatching, { functions: [mismatching] })).toEqual([]);
  });

  it("preserves explicit declaration tables, which win over a projected entry", () => {
    const fixture = realSessionFixture();
    const ref = irSupportGlobalRef(fixture.owner.id, "explicit-global", "g");
    planGlobal(fixture, ref, {
      name: "g",
      type: { kind: "f64" },
      mutable: true,
      init: [{ op: "f64.const", value: 0 }],
    });
    const fn = globalWriter(fixture.owner.id, ref);
    const explicit = new Map([[irBindingKey(ref.binding)!, I32]]);

    expect(
      programAbiModuleDeclarations(
        { mod: fixture.wasmModule, programAbiSession: undefined },
        { functions: [fn], declaredGlobals: explicit },
      ).declaredGlobals,
    ).toBe(explicit);
    expect(
      programAbiModuleDeclarations(fixture.ctx, { functions: [fn], declaredGlobals: explicit }).declaredGlobals?.get(
        irBindingKey(ref.binding)!,
      ),
    ).toEqual(I32);
  });

  it("deep-scans nested instruction buffers", () => {
    const fixture = realSessionFixture();
    const ref = irSupportGlobalRef(fixture.owner.id, "nested-global", "nested");
    planGlobal(fixture, ref, {
      name: "nested",
      type: { kind: "f64" },
      mutable: true,
      init: [{ op: "f64.const", value: 0 }],
    });
    const fn = globalWriter(fixture.owner.id, ref, { nested: true });

    expect(messages(fn, withProductionDeclarations(fixture, [fn]))).toContain(
      "global.set nested carrier i32 contradicts the module-declared f64",
    );
  });

  it("fails closed on unknown identities and forged structural payloads", () => {
    const unknownFixture = realSessionFixture();
    const unknown = irSupportGlobalRef(unknownFixture.owner.id, "unknown-global", "unknown");
    const unknownFn = globalWriter(unknownFixture.owner.id, unknown);
    expectProgramAbiInvariant(
      () => programAbiDeclaredGlobals(unknownFixture.ctx, { functions: [unknownFn] }),
      "invalid-binding-reference",
    );

    const forgedFixture = realSessionFixture();
    const sourceRef = irModuleGlobalRef(forgedFixture.owner.sourceId, 0, "source");
    const global: GlobalDef = {
      name: "source",
      type: { kind: "f64" },
      mutable: true,
      init: [{ op: "f64.const", value: 0 }],
    };
    forgedFixture.wasmModule.globals.push(global);
    planProgramAbiGlobal(forgedFixture.ctx, {
      ref: sourceRef,
      anchor: { kind: "source", sourceId: forgedFixture.owner.sourceId },
      storageOwnerUnitId: forgedFixture.owner.id,
      roleOrdinal: PROGRAM_ABI_GLOBAL_ROLE.moduleValue,
      global,
    });
    const forged = {
      ...sourceRef,
      binding: { ...sourceRef.binding, capability: "dom" },
    } as unknown as IrGlobalRef;
    const forgedFn = globalWriter(forgedFixture.owner.id, forged);
    expectProgramAbiInvariant(
      () => programAbiDeclaredGlobals(forgedFixture.ctx, { functions: [forgedFn] }),
      "binding-reference-mismatch",
    );
  });

  it("keeps same-named globals distinct by exact ABI identity", () => {
    const fixture = realSessionFixture();
    const first = irSupportGlobalRef(fixture.owner.id, "same-name-first", "same");
    const second = irSupportGlobalRef(fixture.owner.id, "same-name-second", "same");
    planGlobal(
      fixture,
      first,
      { name: "same", type: { kind: "f64" }, mutable: false, init: [{ op: "f64.const", value: 0 }] },
      0,
    );
    planGlobal(
      fixture,
      second,
      { name: "same", type: { kind: "i32" }, mutable: false, init: [{ op: "i32.const", value: 0 }] },
      1,
    );
    const fn = irFunction(fixture.owner.id, [
      { kind: "global.get", target: first, result: asValueId(0), resultType: F64 },
      { kind: "global.get", target: second, result: asValueId(1), resultType: I32 },
    ]);
    const declarations = programAbiDeclaredGlobals(fixture.ctx, { functions: [fn] });

    expect(declarations?.size).toBe(2);
    expect(declarations?.get(irBindingKey(first.binding)!)).toEqual(F64);
    expect(declarations?.get(irBindingKey(second.binding)!)).toEqual(I32);
    expect(messages(fn, { functions: [fn], declaredGlobals: declarations })).toEqual([]);
  });

  it("resolves the exact nth imported-global allocator", () => {
    const fixture = realSessionFixture();
    const entrySource = fixture.session.inventory.sources.find((source) => source.kind === "entry");
    if (!entrySource) throw new Error("missing entry source");
    const first: Import = {
      module: "env",
      name: "same",
      desc: { kind: "global", type: { kind: "i32" }, mutable: false },
    };
    const second: Import = {
      module: "env",
      name: "same",
      desc: { kind: "global", type: { kind: "f64" }, mutable: false },
    };
    fixture.wasmModule.imports.push(first, second);
    planProgramAbiStringConstantImport(fixture.ctx, second, 1);
    const ref = irImportGlobalRef(entrySource.id, "env", "same", "same", 1);
    const fn = irFunction(fixture.owner.id, [
      { kind: "global.get", target: ref, result: asValueId(0), resultType: F64 },
    ]);

    expect(programAbiDeclaredGlobals(fixture.ctx, { functions: [fn] })?.get(irBindingKey(ref.binding)!)).toEqual(F64);
  });

  it("rejects conflicting duplicate declaration carriers", () => {
    const fixture = realSessionFixture();
    const ref = irSupportGlobalRef(fixture.owner.id, "conflicting-global", "conflict");
    fixture.wasmModule.globals.push(
      { name: "first", type: { kind: "f64" }, mutable: false, init: [{ op: "f64.const", value: 0 }] },
      { name: "second", type: { kind: "i32" }, mutable: false, init: [{ op: "i32.const", value: 0 }] },
    );
    let nextIndex = 0;
    const inconsistentSession = {
      assertModule: () => undefined,
      getDraft: () => ({ intent: { kind: "global", origin: "support" } }),
      resolveCurrentIndex: () => nextIndex++,
    } as unknown as ProgramAbiSession;
    const fn = irFunction(fixture.owner.id, [
      { kind: "global.get", target: ref, result: asValueId(0), resultType: F64 },
      { kind: "global.get", target: ref, result: asValueId(1), resultType: I32 },
    ]);

    expectProgramAbiInvariant(
      () =>
        programAbiDeclaredGlobals(
          { mod: fixture.wasmModule, programAbiSession: inconsistentSession },
          { functions: [fn] },
        ),
      "session-draft-mismatch",
    );
  });

  it("fails closed when a required global locator resolves outside the allocator", () => {
    const fixture = realSessionFixture();
    const ref = irSupportGlobalRef(fixture.owner.id, "eliminated-global", "eliminated");
    planGlobal(fixture, ref, {
      name: "eliminated",
      type: { kind: "f64" },
      mutable: false,
      init: [{ op: "f64.const", value: 0 }],
    });
    const exactSession = fixture.session.resolveCurrentIndex.bind(fixture.session);
    fixture.session.resolveCurrentIndex = (...args) => {
      exactSession(...args);
      return fixture.wasmModule.globals.length;
    };
    const fn = irFunction(fixture.owner.id, [
      { kind: "global.get", target: ref, result: asValueId(0), resultType: F64 },
    ]);

    expectProgramAbiInvariant(
      () => programAbiDeclaredGlobals(fixture.ctx, { functions: [fn] }),
      "eliminated-required-locator",
    );
  });

  it.each([
    [1, "post-inline"],
    [2, "post-mono"],
  ] as const)("rejects wrong lookup #%i at the %s declaration derivation", (wrongOn, phase) => {
    const ast = analyzeSource(
      `
        let state: number = 1;
        export function read(): number {
          return state;
        }
      `,
      `issue-4608-${phase}.ts`,
    );
    const declaration = ast.sourceFile.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "state");
    expect(declaration).toBeDefined();

    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const identityContext = buildIrPlanningIdentityContext(inventory);
    const owner = inventory.terminalUnits.find(
      (unit) => unit.kind === "top-level-function" && unit.displayName === "read",
    );
    expect(owner).toBeDefined();
    const wasmModule = createEmptyModule();
    const session = new ProgramAbiSession(inventory, wasmModule);
    const ctx = createCodegenContext(wasmModule, ast.checker, { experimentalIR: true }, session, identityContext);
    collectDeclarations(ctx, ast.sourceFile);
    compileDeclarations(ctx, ast.sourceFile);

    const observation = ctx.programAbiGlobals?.moduleBinding(declaration!);
    expect(observation?.value.name).toBe("__mod_state");
    const source = inventory.sources.find((candidate) => candidate.kind === "entry");
    const storageOwner = inventory.terminalUnits.find(
      (unit) => unit.kind === "module-init" && unit.sourceId === source?.id,
    );
    expect(source).toBeDefined();
    expect(storageOwner).toBeDefined();
    planProgramAbiGlobal(ctx, {
      ref: irModuleGlobalRef(source!.id, 0, observation!.value.name),
      anchor: { kind: "source", sourceId: source!.id },
      storageOwnerUnitId: storageOwner!.id,
      roleOrdinal: PROGRAM_ABI_GLOBAL_ROLE.moduleValue,
      derivedOrdinal: 0,
      global: observation!.value,
    });
    const valueBindingId = session.locatorBindingId(observation!.value);
    expect(valueBindingId).toBeDefined();
    const importedGlobalCount = wasmModule.imports.filter((entry) => entry.desc.kind === "global").length;
    wasmModule.globals.push({
      name: "__issue_4608_unplanned_i32",
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
    const wrongIndex = importedGlobalCount + wasmModule.globals.length - 1;
    const exactResolve = session.resolveCurrentIndex.bind(session);
    let valueResolutions = 0;
    session.resolveCurrentIndex = (...args) => {
      const exactIndex = exactResolve(...args);
      if (args[0] !== valueBindingId) return exactIndex;
      valueResolutions++;
      return valueResolutions === wrongOn ? wrongIndex : exactIndex;
    };

    const ownerProjection = buildIrLegacyUnitProjection([{ unitId: owner!.id, legacyName: "read" }]);
    const report = compileIrPathFunctions(ctx, ast.sourceFile, { funcs: new Set(["read"]) }, undefined, undefined, {
      identityContext,
      ownerProjection,
      ownerUnitIdByLegacyName: new Map([["read", owner!.id]]),
      signaturesByUnitId: new Map(),
      directCalls: new Map(),
      importedCalls: new Map(),
      topLevelFunctionValues: new Map(),
      hostVoidCallbacks: new Map(),
      promiseDelays: {
        constructions: new Map(),
        timers: new Map(),
        resolves: new Map(),
      },
    });

    expect(valueResolutions).toBe(wrongOn);
    expect(report.compiled).toEqual([]);
    expect(report.errors).toEqual([
      expect.objectContaining({
        func: "read",
        outcome: expect.objectContaining({
          kind: "invariant",
          stage: "verify",
          code: "verifier-failure",
          detail: `${phase} verify: global.get __mod_state carrier f64 contradicts the module-declared i32`,
        }),
      }),
    ]);
  });
});
