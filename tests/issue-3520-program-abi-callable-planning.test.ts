// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { generateModule } from "../src/codegen/index.js";
import {
  PROGRAM_ABI_CALLABLE_ROLE,
  planProgramAbiSupportCallable,
  planProgramAbiSupportCallableAlias,
  planProgramAbiUnitCallable,
} from "../src/codegen/program-abi-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import {
  irCallableBindingKey,
  irSupportFuncRef,
  irUnitCallableBindingId,
  irUnitFuncRef,
} from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, createDerivedIrUnitId } from "../src/ir/identity.js";
import { ProgramAbiInvariantError } from "../src/ir/program-abi.js";
import { createEmptyModule, type FuncTypeDef, type Import, type TypeDef, type WasmFunction } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

function source(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function wasmFunction(name: string, typeIdx: number): WasmFunction {
  return { name, typeIdx, locals: [], body: [], exported: false };
}

describe("#3520 production unit-callable Program ABI planning", () => {
  it("keeps same-labelled units distinct and resolves their exact locators after a late import and replacement", () => {
    const firstSource = source("/repo/a.ts", "export function same() {}");
    const secondSource = source("/repo/b.ts", "export function same() {}");
    const inventory = buildIrUnitInventory([secondSource, firstSource], { entrySource: firstSource });
    const units = inventory.allUnits.filter(
      (unit) => unit.kind === "top-level-function" && unit.displayName === "same",
    );
    expect(units).toHaveLength(2);

    const module = createEmptyModule();
    module.types.push({ kind: "struct", name: "$Payload", fields: [] });
    const signature: FuncTypeDef = {
      kind: "func",
      name: "$same",
      params: [
        { kind: "i32", boolean: true },
        { kind: "i32", symbol: true },
        { kind: "i64", bigint: true },
        { kind: "ref_null", typeIdx: 0 },
        { kind: "externref" },
      ],
      results: [{ kind: "ref", typeIdx: 0 }],
    };
    module.types.push(signature);
    const functions = [wasmFunction("same", 1), wasmFunction("same", 1)];
    module.functions.push(...functions);

    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const refs = units.map((unit) => irUnitFuncRef({ unitId: unit.id, name: "same" }));
    const ids = refs.map((ref, index) => planProgramAbiUnitCallable(ctx, { ref, signature, func: functions[index]! }));
    expect(ids).toEqual(units.map((unit) => irUnitCallableBindingId(unit.id)));
    expect(new Set(ids).size).toBe(2);

    const firstDraft = session.getDraft(ids[0]!)!;
    expect(firstDraft.intent).toEqual({
      kind: "callable",
      origin: "source",
      unitId: units[0]!.id,
      signature: {
        params: [
          '{"kind":"i32","boolean":true}',
          '{"kind":"i32","symbol":true}',
          '{"kind":"i64","bigint":true}',
          '{"kind":"ref_null","typeIdx":0}',
          '{"kind":"externref"}',
        ],
        results: ['{"kind":"ref","typeIdx":0}'],
      },
    });

    // A misleading compatibility label never redirects the structural binding
    // to the other same-labelled unit.
    const mismatchedName = irUnitFuncRef({ unitId: units[0]!.id, name: "wrong-slot-label" });
    expect(session.resolveCurrentIndex(ids[0]!, "function", irCallableBindingKey(mismatchedName.binding))).toBe(0);

    const lateImport: Import = {
      module: "env",
      name: "late",
      desc: { kind: "func", typeIdx: 1 },
    };
    module.imports.push(lateImport);
    expect(
      ids.map((id, index) => session.resolveCurrentIndex(id!, "function", irCallableBindingKey(refs[index]!.binding))),
    ).toEqual([1, 2]);

    const replacement = { ...functions[0]!, body: [{ op: "unreachable" } as const] };
    module.functions[0] = replacement;
    session.replaceDefinedFunctionLocator(ids[0]!, functions[0]!, replacement);

    const { abi } = session.publish(module);
    expect(ids.map((id) => abi.resolveFinalIndex(id!))).toEqual([
      { space: "function", index: 1 },
      { space: "function", index: 2 },
    ]);
    expect(
      abi
        .entries()
        .filter((entry) => entry.intent.kind === "callable")
        .map((entry) => entry.id),
    ).toEqual(ids);
  });

  it("leaves non-inventory derived units explicitly unplanned without inferring provenance", () => {
    const file = source("/repo/derived.ts", "export function owner() {}");
    const inventory = buildIrUnitInventory([file], { entrySource: file });
    const owner = inventory.allUnits.find((unit) => unit.kind === "top-level-function")!;
    const derivedUnitId = createDerivedIrUnitId({
      parentId: owner.id,
      role: "lifted-closure",
      ordinal: 0,
    });
    const module = createEmptyModule();
    const signature: FuncTypeDef = { kind: "func", params: [], results: [] };
    const derived = wasmFunction("owner__closure_0", 0);
    module.types.push(signature);
    module.functions.push(derived);
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);

    const id = irUnitCallableBindingId(derivedUnitId);
    expect(
      planProgramAbiUnitCallable(ctx, {
        ref: irUnitFuncRef({ unitId: derivedUnitId, name: derived.name }),
        signature,
        func: derived,
      }),
    ).toBeUndefined();
    expect(session.hasPlan(id)).toBe(false);
    expect(session.hasLocator(id)).toBe(false);

    const noSession = createCodegenContext(module, {} as ts.TypeChecker);
    expect(
      planProgramAbiUnitCallable(noSession, {
        ref: irUnitFuncRef({ unitId: owner.id, name: "owner" }),
        signature,
        func: derived,
      }),
    ).toBeUndefined();
  });

  it("plans explicitly registered lifted units with distinct deterministic suborders", () => {
    const file = source("/repo/lifted.ts", "export function owner() {}");
    const inventory = buildIrUnitInventory([file], { entrySource: file });
    const owner = inventory.allUnits.find((unit) => unit.kind === "top-level-function")!;
    const liftedUnitIds = [0, 1].map((ordinal) =>
      createDerivedIrUnitId({
        parentId: owner.id,
        role: "lifted-closure",
        ordinal,
      }),
    );
    const module = createEmptyModule();
    const signature: FuncTypeDef = { kind: "func", params: [], results: [] };
    const functions = [
      wasmFunction("owner", 0),
      wasmFunction("owner__closure_0", 0),
      wasmFunction("owner__closure_1", 0),
    ];
    module.types.push(signature);
    module.functions.push(...functions);

    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const records = liftedUnitIds.map((id, ordinal) => ({
      id,
      parentId: owner.id,
      sourceId: owner.sourceId,
      terminalOwnerId: owner.terminalOwnerId,
      role: "lifted-closure" as const,
      ordinal,
    }));
    // Queue and plan in reverse producer order. Publication order must still
    // follow the explicit lifted ordinals beneath the owner's body.
    session.registerDerivedUnit(records[1]!);
    session.registerDerivedUnit(records[0]!);

    const refs = [
      irUnitFuncRef({ unitId: owner.id, name: functions[0]!.name }),
      ...liftedUnitIds.map((unitId, index) => irUnitFuncRef({ unitId, name: functions[index + 1]!.name })),
    ];
    const ids = [irUnitCallableBindingId(owner.id), ...liftedUnitIds.map(irUnitCallableBindingId)];
    for (const index of [2, 1, 0]) {
      expect(
        planProgramAbiUnitCallable(ctx, {
          ref: refs[index]!,
          signature,
          func: functions[index]!,
        }),
      ).toBe(ids[index]);
    }

    expect(ids.map((id) => session.getDraft(id)!.structuralOrder.derivedOrdinal)).toEqual([0, 1, 2]);
    const { abi } = session.publish(module);
    expect(
      abi
        .entries()
        .filter((entry) => entry.intent.kind === "callable")
        .map((entry) => entry.id),
    ).toEqual(ids);
    expect(ids.map((id) => abi.resolveFinalIndex(id))).toEqual([
      { space: "function", index: 0 },
      { space: "function", index: 1 },
      { space: "function", index: 2 },
    ]);
  });

  it("publishes the replacement object installed by production IR lowering", () => {
    const ast = analyzeSource("export function selected(value: number): number { return value + 1; }");
    const result = generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.irCompiledFuncs).toContain("selected");
    expect(result.programAbi).toBeDefined();

    const callable = result
      .programAbi!.abi.entries()
      .find((entry) => entry.intent.kind === "callable" && entry.displayName === "selected");
    expect(callable).toBeDefined();
    const localIndex = result.module.functions.findIndex((func) => func.name === "selected");
    const importCount = result.module.imports.filter((entry) => entry.desc.kind === "func").length;
    expect(result.programAbi!.abi.resolveFinalIndex(callable!.id)).toEqual({
      space: "function",
      index: importCount + localIndex,
    });
  });
});

describe("#3520 production support-callable Program ABI planning", () => {
  it("plans an exact class-owned AST-free constructor allocator with class-local order", () => {
    const file = source("/repo/class-support.ts", "class Local {} class Other {}");
    const inventory = buildIrUnitInventory([file], { entrySource: file });
    const localClass = inventory.classes.find((record) => record.displayName === "Local")!;
    const otherClass = inventory.classes.find((record) => record.displayName === "Other")!;
    const module = createEmptyModule();
    const signature: FuncTypeDef = {
      kind: "func",
      params: [{ kind: "externref" }],
      results: [{ kind: "externref" }],
    };
    module.types.push(signature);
    const allocator = wasmFunction("Local_new", 0);
    module.functions.push(allocator);

    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const ref = irSupportFuncRef(localClass.id, "class-constructor-new", allocator.name);
    expect(() =>
      planProgramAbiSupportCallable(ctx, {
        ref,
        anchor: { kind: "class", classId: otherClass.id },
        role: "class-constructor-new",
        roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.classConstructorNew,
        signature,
        func: allocator,
      }),
    ).toThrowError(TypeError);

    const id = planProgramAbiSupportCallable(ctx, {
      ref,
      anchor: { kind: "class", classId: localClass.id },
      role: "class-constructor-new",
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.classConstructorNew,
      signature,
      func: allocator,
    })!;
    const draft = session.getDraft(id)!;
    expect(draft).toMatchObject({
      structuralOrder: {
        sourceId: localClass.sourceId,
        domainOrdinal: 0,
        roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.classConstructorNew,
      },
      structuralReferenceKey: irCallableBindingKey(ref.binding),
      displayName: allocator.name,
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "support",
        classId: localClass.id,
        signature: {
          params: ['{"kind":"externref"}'],
          results: ['{"kind":"externref"}'],
        },
      },
    });
    expect(draft.intent).not.toHaveProperty("unitId");
    expect(() =>
      session.ensurePlan({
        ...draft,
        intent: { ...draft.intent, classId: otherClass.id },
      }),
    ).toThrowError(expect.objectContaining<ProgramAbiInvariantError>({ code: "session-draft-mismatch" }));
    expect(session.resolveCurrentIndex(id, "function", irCallableBindingKey(ref.binding))).toBe(0);

    const { abi } = session.publish(module);
    expect(abi.get(id)?.intent).toEqual({
      kind: "callable",
      origin: "support",
      classId: localClass.id,
      signature: {
        params: ['{"kind":"externref"}'],
        results: ['{"kind":"externref"}'],
      },
    });
    expect(abi.resolveFinalIndex(id)).toEqual({ space: "function", index: 0 });
  });

  it("resolves an exact unit-anchored trampoline after relabelling and a late import", () => {
    const file = source("/repo/support.ts", "export function target() {}");
    const inventory = buildIrUnitInventory([file], { entrySource: file });
    const targetUnit = inventory.allUnits.find((unit) => unit.kind === "top-level-function")!;
    const module = createEmptyModule();
    module.types.push({ kind: "struct", name: "$Payload", fields: [] });
    const signature: FuncTypeDef = {
      kind: "func",
      name: "$trampoline",
      params: [
        { kind: "ref_null", typeIdx: 0 },
        { kind: "i32", boolean: true },
      ],
      results: [{ kind: "ref", typeIdx: 0 }],
    };
    module.types.push(signature);
    const target = wasmFunction("target", 1);
    const trampoline = wasmFunction("__fn_tramp_target_cached", 1);
    module.functions.push(target, trampoline);

    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const ref = irSupportFuncRef(targetUnit.id, "function-value-trampoline", "misleading-compatibility-label");
    const id = planProgramAbiSupportCallable(ctx, {
      ref,
      anchor: { kind: "unit", unitId: targetUnit.id },
      role: "function-value-trampoline",
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.functionValueTrampoline,
      signature,
      func: trampoline,
    });
    expect(ref.binding.kind).toBe("support");
    expect(id).toBe(ref.binding.kind === "support" ? ref.binding.bindingId : undefined);
    expect(session.getDraft(id!)).toMatchObject({
      structuralOrder: {
        sourceId: targetUnit.sourceId,
        domainOrdinal: 0,
        roleOrdinal: 1,
      },
      structuralReferenceKey: irCallableBindingKey(ref.binding),
      displayName: trampoline.name,
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "support",
        unitId: targetUnit.id,
        signature: {
          params: ['{"kind":"ref_null","typeIdx":0}', '{"kind":"i32","boolean":true}'],
          results: ['{"kind":"ref","typeIdx":0}'],
        },
      },
    });
    expect(session.hasLocator(id!, trampoline)).toBe(true);

    const relabelled = irSupportFuncRef(targetUnit.id, "function-value-trampoline", "another-label");
    expect(irCallableBindingKey(relabelled.binding)).toBe(irCallableBindingKey(ref.binding));
    expect(session.resolveCurrentIndex(id!, "function", irCallableBindingKey(relabelled.binding))).toBe(1);

    const lateImport: Import = {
      module: "env",
      name: "late",
      desc: { kind: "func", typeIdx: 1 },
    };
    module.imports.push(lateImport);
    expect(session.resolveCurrentIndex(id!, "function", irCallableBindingKey(relabelled.binding))).toBe(2);

    const { abi } = session.publish(module);
    expect(abi.resolveFinalIndex(id!)).toEqual({ space: "function", index: 2 });
  });

  it("rejects non-support references and final locator signature mismatches", () => {
    const file = source("/repo/support-mismatch.ts", "export function target() {}");
    const inventory = buildIrUnitInventory([file], { entrySource: file });
    const targetUnit = inventory.allUnits.find((unit) => unit.kind === "top-level-function")!;
    const module = createEmptyModule();
    const plannedSignature: FuncTypeDef = {
      kind: "func",
      params: [{ kind: "i32", boolean: true }],
      results: [],
    };
    const locatorSignature: FuncTypeDef = {
      kind: "func",
      params: [{ kind: "f64" }],
      results: [],
    };
    module.types.push(plannedSignature, locatorSignature);
    const trampoline = wasmFunction("__fn_tramp_target_cached", 1);
    module.functions.push(trampoline);
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const plan = {
      anchor: { kind: "unit" as const, unitId: targetUnit.id },
      role: "function-value-trampoline",
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.functionValueTrampoline,
      signature: plannedSignature,
      func: trampoline,
    };

    expect(() =>
      planProgramAbiSupportCallable(ctx, {
        ...plan,
        ref: irUnitFuncRef({ unitId: targetUnit.id, name: trampoline.name }),
      }),
    ).toThrowError(TypeError);

    expect(() =>
      planProgramAbiSupportCallable(ctx, {
        ...plan,
        ref: irSupportFuncRef(targetUnit.id, "wrong-support-role", trampoline.name),
      }),
    ).toThrowError(TypeError);

    const ref = irSupportFuncRef(targetUnit.id, "function-value-trampoline", trampoline.name);
    planProgramAbiSupportCallable(ctx, { ...plan, ref });
    expect(() => session.publish(module)).toThrowError(
      expect.objectContaining<ProgramAbiInvariantError>({ code: "type-remap-mismatch" }),
    );
  });

  it("keeps one exact allocator function under a single support binding owner", () => {
    const file = source("/repo/support-owner.ts", "export function target() {}");
    const inventory = buildIrUnitInventory([file], { entrySource: file });
    const targetUnit = inventory.allUnits.find((unit) => unit.kind === "top-level-function")!;
    const module = createEmptyModule();
    const signature: FuncTypeDef = { kind: "func", params: [], results: [] };
    module.types.push(signature);
    const trampoline = wasmFunction("__shared_trampoline", 0);
    module.functions.push(trampoline);
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const plan = {
      anchor: { kind: "unit" as const, unitId: targetUnit.id },
      signature,
      func: trampoline,
    };

    planProgramAbiSupportCallable(ctx, {
      ...plan,
      ref: irSupportFuncRef(targetUnit.id, "function-value-trampoline", "first-label"),
      role: "function-value-trampoline",
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.functionValueTrampoline,
    });
    expect(() =>
      planProgramAbiSupportCallable(ctx, {
        ...plan,
        ref: irSupportFuncRef(targetUnit.id, "other-support-callable", "second-label"),
        role: "other-support-callable",
        roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.functionValueTrampoline + 1,
      }),
    ).toThrowError(expect.objectContaining<ProgramAbiInvariantError>({ code: "duplicate-slot-locator" }));
  });

  it("plans class-owned aliases in deterministic derived order and resolves the canonical locator", () => {
    const file = source(
      "/repo/class-method-alias.ts",
      `
        class Base {
          method(value: number): number {
            return value;
          }
        }
        class Child extends Base {}
      `,
    );
    const inventory = buildIrUnitInventory([file], { entrySource: file });
    const baseClass = inventory.classes.find((record) => record.displayName === "Base")!;
    const childClass = inventory.classes.find((record) => record.displayName === "Child")!;
    const baseMethod = inventory.allUnits.find(
      (unit) => unit.lexicalOwnerId === baseClass.id && unit.kind === "class-instance-method",
    )!;
    const module = createEmptyModule();
    const deadType: TypeDef = { kind: "struct", name: "$Dead", fields: [] };
    const payloadType: TypeDef = { kind: "struct", name: "$Payload", fields: [] };
    const signature: FuncTypeDef = {
      kind: "func",
      name: "$method",
      params: [{ kind: "ref_null", typeIdx: 1 }],
      results: [{ kind: "ref", typeIdx: 1 }],
    };
    const previousTypes = [deadType, payloadType, signature];
    module.types = previousTypes;
    const canonicalFunction = wasmFunction("Base_method", 2);
    module.functions.push(canonicalFunction);

    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const canonicalRef = irUnitFuncRef({ unitId: baseMethod.id, name: canonicalFunction.name });
    const canonicalId = planProgramAbiUnitCallable(ctx, {
      ref: canonicalRef,
      signature,
      func: canonicalFunction,
    })!;
    const role = "class-method-adapter:instance:method";
    const aliasRefs = [0, 1].map((derivedOrdinal) =>
      irSupportFuncRef(childClass.id, role, `Child_method_alias_${derivedOrdinal}`, derivedOrdinal),
    );
    const aliasIds = aliasRefs.map((ref) => {
      if (ref.binding.kind !== "support") throw new Error("expected support reference");
      return ref.binding.bindingId;
    });

    // Producer discovery order is deliberately reversed. Structural order is
    // owned by the explicit artifact ordinal, never Map insertion.
    for (const derivedOrdinal of [1, 0]) {
      expect(
        planProgramAbiSupportCallableAlias(ctx, {
          ref: aliasRefs[derivedOrdinal]!,
          anchor: { kind: "class", classId: childClass.id },
          role,
          roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.classMethodAdapter,
          derivedOrdinal,
          aliasOf: canonicalId,
          signature,
        }),
      ).toBe(aliasIds[derivedOrdinal]);
    }

    expect(aliasIds.map((id) => session.getDraft(id)!.structuralOrder.derivedOrdinal)).toEqual([0, 1]);
    expect(session.getDraft(aliasIds[0]!)).toMatchObject({
      structuralReferenceKey: irCallableBindingKey(aliasRefs[0]!.binding),
      displayName: aliasRefs[0]!.name,
      slotPolicy: "alias",
      aliasOf: canonicalId,
      intent: {
        kind: "callable",
        origin: "support",
        classId: childClass.id,
        signature: {
          params: ['{"kind":"ref_null","typeIdx":1}'],
          results: ['{"kind":"ref","typeIdx":1}'],
        },
      },
    });
    expect(session.getDraft(aliasIds[0]!)!.intent).not.toHaveProperty("unitId");
    expect(aliasIds.map((id) => session.hasLocator(id))).toEqual([false, false]);
    expect(() =>
      session.attachLocator(aliasIds[0]!, { kind: "defined-function", value: canonicalFunction }),
    ).toThrowError(expect.objectContaining<ProgramAbiInvariantError>({ code: "locator-not-required" }));

    const finalPayloadType: TypeDef = { kind: "struct", name: "$Payload", fields: [] };
    const finalSignature: FuncTypeDef = {
      kind: "func",
      name: "$method",
      params: [{ kind: "ref_null", typeIdx: 0 }],
      results: [{ kind: "ref", typeIdx: 0 }],
    };
    const retainedContextTypes = previousTypes.slice(3);
    const nextTypes = [finalPayloadType, finalSignature, ...retainedContextTypes];
    session.applyTypeLayoutRemap({
      previousTypes,
      nextTypes,
      targetsByOldIndex: [null, 0, 1, ...retainedContextTypes.map((_, index) => index + 2)],
    });
    module.types = nextTypes;
    canonicalFunction.typeIdx = 1;
    module.imports.push({
      module: "env",
      name: "late",
      desc: { kind: "func", typeIdx: 1 },
    });

    const relabelled = aliasRefs.map((_, derivedOrdinal) =>
      irSupportFuncRef(childClass.id, role, "untrusted-compatibility-label", derivedOrdinal),
    );
    expect(
      aliasIds.map((id, index) =>
        session.resolveCurrentIndex(id, "function", irCallableBindingKey(relabelled[index]!.binding)),
      ),
    ).toEqual([1, 1]);
    expect(() =>
      session.resolveCurrentIndex(aliasIds[0]!, "function", irCallableBindingKey(aliasRefs[1]!.binding)),
    ).toThrowError(expect.objectContaining<ProgramAbiInvariantError>({ code: "binding-reference-mismatch" }));

    const { abi } = session.publish(module);
    expect(
      abi
        .entries()
        .filter((entry) => aliasIds.includes(entry.id))
        .map((entry) => entry.id),
    ).toEqual(aliasIds);
    expect(aliasIds.map((id) => abi.resolveFinalIndex(id))).toEqual([
      { space: "function", index: 1 },
      { space: "function", index: 1 },
    ]);
    expect(
      aliasIds.map((id) => {
        const entry = abi.get(id)!;
        return entry.intent.kind === "callable" ? entry.intent.signature : undefined;
      }),
    ).toEqual([
      {
        params: ['{"kind":"ref_null","typeIdx":0}'],
        results: ['{"kind":"ref","typeIdx":0}'],
      },
      {
        params: ['{"kind":"ref_null","typeIdx":0}'],
        results: ['{"kind":"ref","typeIdx":0}'],
      },
    ]);
  });

  it("validates alias identity components and accepts explicit ordinals for required support callables", () => {
    const file = source("/repo/support-alias-validation.ts", "class Local {} class Other {}");
    const inventory = buildIrUnitInventory([file], { entrySource: file });
    const localClass = inventory.classes.find((record) => record.displayName === "Local")!;
    const otherClass = inventory.classes.find((record) => record.displayName === "Other")!;
    const module = createEmptyModule();
    const signature: FuncTypeDef = { kind: "func", params: [], results: [] };
    module.types.push(signature);
    const canonicalFunction = wasmFunction("Local_required_support", 0);
    module.functions.push(canonicalFunction);
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);

    const requiredRole = "class-method-adapter:required";
    const requiredRef = irSupportFuncRef(localClass.id, requiredRole, canonicalFunction.name, 7);
    const canonicalId = planProgramAbiSupportCallable(ctx, {
      ref: requiredRef,
      anchor: { kind: "class", classId: localClass.id },
      role: requiredRole,
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.classMethodAdapter,
      derivedOrdinal: 7,
      signature,
      func: canonicalFunction,
    })!;
    expect(session.getDraft(canonicalId)!.structuralOrder.derivedOrdinal).toBe(7);

    const aliasRole = "class-method-adapter:instance:method";
    const aliasRef = irSupportFuncRef(localClass.id, aliasRole, "Local_method_alias", 2);
    const aliasPlan = {
      ref: aliasRef,
      anchor: { kind: "class" as const, classId: localClass.id },
      role: aliasRole,
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.classMethodAdapter,
      derivedOrdinal: 2,
      aliasOf: canonicalId,
      signature,
    };
    expect(() =>
      planProgramAbiSupportCallableAlias(ctx, {
        ...aliasPlan,
        anchor: { kind: "class", classId: otherClass.id },
      }),
    ).toThrowError(TypeError);
    expect(() =>
      planProgramAbiSupportCallableAlias(ctx, {
        ...aliasPlan,
        role: "class-method-adapter:instance:other",
      }),
    ).toThrowError(TypeError);
    expect(() =>
      planProgramAbiSupportCallableAlias(ctx, {
        ...aliasPlan,
        derivedOrdinal: 3,
      }),
    ).toThrowError(TypeError);
    expect(() =>
      planProgramAbiSupportCallableAlias(ctx, {
        ...aliasPlan,
        ref: irUnitFuncRef({ unitId: inventory.allUnits[0]!.id, name: aliasRef.name }),
      }),
    ).toThrowError(TypeError);
  });
});
