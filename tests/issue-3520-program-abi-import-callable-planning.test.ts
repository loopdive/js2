// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { createCodegenContext } from "../src/codegen/context/create-context.js";
import {
  catalogProgramAbiCallableImports,
  planProgramAbiCallableImports,
} from "../src/codegen/program-abi-import-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { irCallableBindingKey, irImportFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, createIrBindingId } from "../src/ir/identity.js";
import { ProgramAbiInvariantError } from "../src/ir/program-abi.js";
import { createEmptyModule, type FuncTypeDef, type Import, type TypeDef, type WasmModule } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

function source(fileName = "/repo/entry.ts"): ts.SourceFile {
  return ts.createSourceFile(fileName, "export function main() {}", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function fixture(module: WasmModule, entryFile = source()) {
  const inventory = buildIrUnitInventory([entryFile], { entrySource: entryFile });
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
  return { ctx, inventory, session };
}

function functionImport(module: string, name: string, typeIdx: number): Import {
  return { module, name, desc: { kind: "func", typeIdx } };
}

function structuralKey(module: string, field: string, adapterName = field): string {
  return irCallableBindingKey(irImportFuncRef(module, field, adapterName).binding);
}

function deterministicFixture(reverse: boolean) {
  const module = createEmptyModule();
  module.types.push({ kind: "struct", name: "$Payload", fields: [] });
  module.types.push({
    kind: "func",
    name: "$alpha",
    params: [
      { kind: "i32", boolean: true },
      { kind: "i32", symbol: true },
      { kind: "i64", bigint: true },
      { kind: "ref_null", typeIdx: 0 },
    ],
    results: [{ kind: "ref", typeIdx: 0 }],
  });
  module.types.push({
    kind: "func",
    name: "$zeta",
    params: [{ kind: "externref" }],
    results: [{ kind: "f64" }],
  });
  const alpha = functionImport("alpha", "same", 1);
  const zeta = functionImport("zeta", "same", 2);
  const ignoredGlobal: Import = {
    module: "state",
    name: "same",
    desc: { kind: "global", type: { kind: "i32" }, mutable: false },
  };
  module.imports.push(...(reverse ? [zeta, ignoredGlobal, alpha] : [alpha, ignoredGlobal, zeta]));
  const { ctx, session } = fixture(module);
  const catalog = planProgramAbiCallableImports(ctx);
  return { alpha, catalog, module, session, zeta };
}

describe("#3520 production imported-callable Program ABI planning", () => {
  it("sorts structural module/field keys into stable opaque IDs and keeps the catalog runtime-immutable", () => {
    const forward = deterministicFixture(false);
    const reverse = deterministicFixture(true);
    const alphaKey = structuralKey("alpha", "same", "misleading-alpha-label");
    const zetaKey = structuralKey("zeta", "same", "misleading-zeta-label");
    const sortedKeys = [alphaKey, zetaKey].sort();

    expect([...forward.catalog.keys()]).toEqual(sortedKeys);
    expect([...reverse.catalog.keys()]).toEqual(sortedKeys);
    expect([...forward.catalog]).toEqual([...reverse.catalog]);
    expect(forward.catalog.size).toBe(2);
    expect(new Set(forward.catalog.values()).size).toBe(2);
    expect(Object.isFrozen(forward.catalog)).toBe(true);
    expect(() =>
      (forward.catalog as unknown as Map<string, string>).set(structuralKey("other", "same"), "forged"),
    ).toThrow(TypeError);

    const alphaId = forward.catalog.get(alphaKey)!;
    const zetaId = forward.catalog.get(zetaKey)!;
    expect(alphaId).toMatch(/^ir-binding:v1:callable:/);
    expect(alphaId).not.toContain("alpha");
    expect(alphaId).not.toContain("same");
    expect(forward.session.getDraft(alphaId)).toMatchObject({
      structuralOrder: {
        sourceId: forward.session.inventory.sources[0]!.id,
        declarationOrdinal: 0,
        domainOrdinal: 0,
        roleOrdinal: 4,
        derivedOrdinal: sortedKeys.indexOf(alphaKey),
      },
      structuralReferenceKey: alphaKey,
      displayName: "same",
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "import",
        signature: {
          params: [
            '{"kind":"i32","boolean":true}',
            '{"kind":"i32","symbol":true}',
            '{"kind":"i64","bigint":true}',
            '{"kind":"ref_null","typeIdx":0}',
          ],
          results: ['{"kind":"ref","typeIdx":0}'],
        },
      },
    });
    expect(forward.session.getDraft(zetaId)).toMatchObject({
      structuralReferenceKey: zetaKey,
      structuralOrder: { derivedOrdinal: sortedKeys.indexOf(zetaKey) },
      intent: {
        kind: "callable",
        origin: "import",
        signature: {
          params: ['{"kind":"externref"}'],
          results: ['{"kind":"f64"}'],
        },
      },
    });
    expect(forward.session.hasLocator(alphaId, forward.alpha)).toBe(true);
    expect(forward.session.hasLocator(zetaId, forward.zeta)).toBe(true);

    const forwardAbi = forward.session.publish(forward.module).abi;
    const reverseAbi = reverse.session.publish(reverse.module).abi;
    expect(forwardAbi.resolveFinalIndex(alphaId)).toEqual({ space: "function", index: 0 });
    expect(forwardAbi.resolveFinalIndex(zetaId)).toEqual({ space: "function", index: 1 });
    expect(reverseAbi.resolveFinalIndex(alphaId)).toEqual({ space: "function", index: 1 });
    expect(reverseAbi.resolveFinalIndex(zetaId)).toEqual({ space: "function", index: 0 });
  });

  it("follows the exact import object through a late index shift and a complete type-layout remap", () => {
    const module = createEmptyModule();
    const dead: TypeDef = { kind: "struct", name: "$Dead", fields: [] };
    const payload: TypeDef = { kind: "struct", name: "$Payload", fields: [] };
    const signature: FuncTypeDef = {
      kind: "func",
      name: "$target",
      params: [{ kind: "ref_null", typeIdx: 1 }],
      results: [{ kind: "i32", boolean: true }],
    };
    module.types.push(dead, payload, signature);
    const target = functionImport("env", "target", 2);
    module.imports.push(target);
    const { ctx, session } = fixture(module);
    const catalog = planProgramAbiCallableImports(ctx);
    const key = structuralKey("env", "target", "relabeled-target");
    const bindingId = catalog.get(key)!;

    const late = functionImport("late", "before-target", 2);
    module.imports.unshift(late);
    expect(session.resolveCurrentIndex(bindingId, "function", key)).toBe(1);

    const remappedSignature: FuncTypeDef = {
      ...signature,
      params: [{ kind: "ref_null", typeIdx: 0 }],
    };
    const previousTypes = module.types;
    const nextTypes = previousTypes.slice(1);
    nextTypes[1] = remappedSignature;
    session.applyTypeLayoutRemap({
      previousTypes,
      nextTypes,
      targetsByOldIndex: previousTypes.map((_, index) => (index === 0 ? null : index - 1)),
    });
    module.types = nextTypes;
    target.desc = { kind: "func", typeIdx: 1 };
    late.desc = { kind: "func", typeIdx: 1 };

    expect(session.hasLocator(bindingId, target)).toBe(true);
    expect(session.hasLocator(bindingId, late)).toBe(false);
    const { abi } = session.publish(module);
    expect(abi.resolveFinalIndex(bindingId)).toEqual({ space: "function", index: 1 });
    expect(abi.get(bindingId)?.intent).toMatchObject({
      kind: "callable",
      origin: "import",
      signature: {
        params: ['{"kind":"ref_null","typeIdx":0}'],
        results: ['{"kind":"i32","boolean":true}'],
      },
    });
  });

  it("catalogs exact pre-DCE objects without planning imports that are later removed", () => {
    const module = createEmptyModule();
    module.types.push({ kind: "func", params: [], results: [] });
    const retained = functionImport("env", "retained", 0);
    const removed = functionImport("env", "removed", 0);
    module.imports.push(removed, retained);
    const { ctx, inventory, session } = fixture(module);
    const retainedKey = structuralKey("env", "retained", "relabeled-retained");
    const removedKey = structuralKey("env", "removed", "relabeled-removed");

    const preDce = catalogProgramAbiCallableImports(ctx);
    expect([...preDce.keys()]).toEqual([retainedKey, removedKey].sort());
    expect(preDce.get(retainedKey)).toBe(retained);
    expect(preDce.get(removedKey)).toBe(removed);
    expect(Object.isFrozen(preDce)).toBe(true);
    expect(() => (preDce as unknown as Map<string, Import>).set("forged", retained)).toThrow(TypeError);

    const entrySource = inventory.sources.find((candidate) => candidate.kind === "entry")!;
    for (const ordinal of [0, 1]) {
      expect(
        session.hasPlan(
          createIrBindingId({
            ownerId: entrySource.id,
            domain: "callable",
            role: "imported-function",
            ordinal,
          }),
        ),
      ).toBe(false);
    }

    // Simulate the exact post-DCE retained population. Final ABI planning must
    // not turn the removed pre-DCE resolver target into a required locator.
    module.imports = [retained];
    const retainedCatalog = planProgramAbiCallableImports(ctx);
    expect([...retainedCatalog.keys()]).toEqual([retainedKey]);
    expect(retainedCatalog.has(removedKey)).toBe(false);
    const retainedId = retainedCatalog.get(retainedKey)!;
    expect(session.hasLocator(retainedId, retained)).toBe(true);
    expect(session.hasLocator(retainedId, removed)).toBe(false);
    const { abi } = session.publish(module);
    expect(abi.entries().map((entry) => entry.id)).toEqual([retainedId]);
  });

  it("prepares one import from a stable pre-DCE denominator and gives later imports trailing identities", () => {
    const module = createEmptyModule();
    module.types.push({ kind: "func", params: [], results: [] });
    const dead = functionImport("env", "a-dead", 0);
    const required = functionImport("env", "required", 0);
    module.imports.push(dead, required);
    const { ctx, inventory, session } = fixture(module);
    const deadKey = structuralKey("env", "a-dead");
    const requiredKey = structuralKey("env", "required");
    const denominator = [...catalogProgramAbiCallableImports(ctx).keys()];
    const importRegistry = ctx.programAbiCallableImports;
    if (!importRegistry) throw new Error("missing callable-import registry");

    importRegistry.planPrepared(new Set([required]));
    const requiredId = session.locatorBindingId(required)!;
    expect(session.getDraft(requiredId)).toMatchObject({
      structuralReferenceKey: requiredKey,
      structuralOrder: { derivedOrdinal: denominator.indexOf(requiredKey) },
      intent: { kind: "callable", origin: "import" },
    });

    const late = functionImport("late", "after-seal", 0);
    const lateKey = structuralKey("late", "after-seal");
    module.imports = [late, required];
    const finalCatalog = planProgramAbiCallableImports(ctx);
    const lateId = finalCatalog.get(lateKey)!;
    expect(finalCatalog.get(requiredKey)).toBe(requiredId);
    expect(finalCatalog.has(deadKey)).toBe(false);
    expect(session.getDraft(lateId)?.structuralOrder.derivedOrdinal).toBe(denominator.length);

    const entrySource = inventory.sources.find((candidate) => candidate.kind === "entry")!;
    const deadId = createIrBindingId({
      ownerId: entrySource.id,
      domain: "callable",
      role: "imported-function",
      ordinal: denominator.indexOf(deadKey),
    });
    expect(session.hasPlan(deadId)).toBe(false);
    const { abi } = session.publish(module);
    expect(abi.resolveFinalIndex(lateId)).toEqual({ space: "function", index: 0 });
    expect(abi.resolveFinalIndex(requiredId)).toEqual({ space: "function", index: 1 });
  });

  it("gives allocator-distinct duplicate imports unique plans while preserving one structural resolver target", () => {
    const module = createEmptyModule();
    module.types.push({ kind: "func", params: [], results: [] });
    const first = functionImport("env", "duplicate", 0);
    const second = functionImport("env", "duplicate", 0);
    module.imports.push(first, second);
    const { ctx, session } = fixture(module);

    const baseKey = structuralKey("env", "duplicate", "relabeled-duplicate");
    const duplicateKey = `${baseKey}|allocator-duplicate|0`;
    const preDce = catalogProgramAbiCallableImports(ctx);
    expect(preDce.get(baseKey)).toBe(second);
    expect(preDce.get(duplicateKey)).toBe(first);

    const catalog = planProgramAbiCallableImports(ctx);
    const baseId = catalog.get(baseKey)!;
    const duplicateId = catalog.get(duplicateKey)!;
    expect(baseId).not.toBe(duplicateId);
    expect(session.hasLocator(baseId, second)).toBe(true);
    expect(session.hasLocator(duplicateId, first)).toBe(true);
    const { abi } = session.publish(module);
    expect(abi.resolveFinalIndex(baseId)).toEqual({ space: "function", index: 1 });
    expect(abi.resolveFinalIndex(duplicateId)).toEqual({ space: "function", index: 0 });
  });

  it.each([
    {
      label: "an out-of-range type index",
      types: [{ kind: "func", params: [], results: [] }] as TypeDef[],
      imported: functionImport("env", "bad", 9),
    },
    {
      label: "a non-function type",
      types: [{ kind: "struct", name: "$NotCallable", fields: [] }] as TypeDef[],
      imported: functionImport("env", "bad", 0),
    },
    {
      label: "a malformed reference-bearing signature",
      types: [
        {
          kind: "func",
          params: [{ kind: "ref", typeIdx: 7 }],
          results: [],
        } as FuncTypeDef,
      ],
      imported: functionImport("env", "bad", 0),
    },
  ])("rejects $label with a typed invariant", ({ imported, types }) => {
    const module = createEmptyModule();
    module.types.push(...types);
    module.imports.push(imported);
    const { ctx } = fixture(module);

    expect(() => planProgramAbiCallableImports(ctx)).toThrowError(
      expect.objectContaining<ProgramAbiInvariantError>({ code: "type-remap-mismatch" }),
    );
  });

  it("requires one canonical entry source and returns an immutable empty catalog without a session", () => {
    const module = createEmptyModule();
    module.types.push({ kind: "func", params: [], results: [] });
    module.imports.push(functionImport("env", "target", 0));
    const entryFile = source();
    const inventory = buildIrUnitInventory([entryFile]);
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    expect(() => planProgramAbiCallableImports(ctx)).toThrowError(
      expect.objectContaining<ProgramAbiInvariantError>({ code: "unknown-order-anchor" }),
    );

    const noSession = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker);
    const empty = planProgramAbiCallableImports(noSession);
    expect([...empty]).toEqual([]);
    expect(Object.isFrozen(empty)).toBe(true);
    expect(() => (empty as unknown as Map<string, string>).set("forged", "forged")).toThrow(TypeError);
  });
});
