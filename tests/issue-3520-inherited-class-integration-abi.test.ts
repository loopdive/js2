// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { compileDeclarations, collectDeclarations } from "../src/codegen/declarations.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { irSupportFuncRef, irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, type IrClassId, type IrUnitId, type IrUnitInventory } from "../src/ir/identity.js";
import { compileIrPathFunctions } from "../src/ir/integration.js";
import type { IrClassShape } from "../src/ir/nodes.js";
import { buildIrLegacyUnitProjection, buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import type { IrSelection } from "../src/ir/select.js";
import { createEmptyModule } from "../src/ir/types.js";

function classId(inventory: IrUnitInventory, name: string): IrClassId {
  const record = inventory.classes.find((candidate) => candidate.displayName === name);
  if (!record) throw new Error(`missing ${name} class identity`);
  return record.id;
}

function implicitConstructorUnitId(inventory: IrUnitInventory, ownerClassId: IrClassId): IrUnitId {
  const unit = inventory.allUnits.find(
    (candidate) => candidate.lexicalOwnerId === ownerClassId && candidate.kind === "class-implicit-constructor",
  );
  if (!unit) throw new Error(`missing implicit constructor identity for ${ownerClassId}`);
  return unit.id;
}

describe("#3520 production inherited class integration ABI", () => {
  it("resolves inherited callables and layouts after every physical name is unavailable", () => {
    const ast = analyzeSource(
      `
        class A {
          value(): number { return 42; }
          get score(): number { return 40; }
          set score(next: number) {}
          static scale(value: number): number { return value * 2; }
        }
        class B extends A {}
        class C extends B {}
        export function main(): number {
          const child = new C();
          child.score = 5;
          return child.value() + child.score + C.scale(3);
        }
      `,
      "exact-inherited-class-integration.ts",
    );
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const identityContext = buildIrPlanningIdentityContext(inventory);
    const aClassId = classId(inventory, "A");
    const bClassId = classId(inventory, "B");
    const cClassId = classId(inventory, "C");
    const aConstructorUnitId = implicitConstructorUnitId(inventory, aClassId);
    const bConstructorUnitId = implicitConstructorUnitId(inventory, bClassId);
    const cConstructorUnitId = implicitConstructorUnitId(inventory, cClassId);
    const canonicalMembers = [
      {
        kind: "class-instance-method",
        legacyName: "A_value",
        role: "class-method-adapter:instance:value",
        physicalName: "C_value",
      },
      {
        kind: "class-instance-getter",
        legacyName: "A_get_score",
        role: "class-member-adapter:getter:score",
        physicalName: "C_get_score",
      },
      {
        kind: "class-instance-setter",
        legacyName: "A_set_score",
        role: "class-member-adapter:setter:score",
        physicalName: "C_set_score",
      },
      {
        kind: "class-static-method",
        legacyName: "A_scale",
        role: "class-member-adapter:static:scale",
        physicalName: "C_scale",
      },
    ].map((expected) => {
      const unit = inventory.terminalUnits.find(
        (candidate) =>
          candidate.lexicalOwnerId === aClassId &&
          candidate.kind === expected.kind &&
          candidate.legacyMatchName === expected.legacyName,
      );
      if (!unit) throw new Error(`missing ${expected.legacyName}`);
      return { ...expected, unit };
    });
    const main = inventory.terminalUnits.find(
      (unit) => unit.kind === "top-level-function" && unit.displayName === "main",
    );
    expect(main).toBeDefined();

    const mod = createEmptyModule();
    const session = new ProgramAbiSession(inventory, mod);
    const ctx = createCodegenContext(mod, ast.checker, { experimentalIR: true }, session, identityContext);
    collectDeclarations(ctx, ast.sourceFile);
    compileDeclarations(ctx, ast.sourceFile);

    const exactAliases = canonicalMembers.map((canonical) => {
      const handle = ctx.programAbiClassCallables?.handleForUnit(canonical.unit.id);
      const derivedOrdinal = inventory.allUnits.findIndex((unit) => unit.id === canonical.unit.id);
      const ref = irSupportFuncRef(cClassId, canonical.role, canonical.physicalName, derivedOrdinal);
      const alias =
        ref.binding.kind === "support"
          ? ctx.programAbiClassCallables?.inheritedAlias(cClassId, canonical.unit.id)
          : undefined;
      expect(handle).toBeDefined();
      expect(alias).toEqual({
        canonicalUnitId: canonical.unit.id,
        handle,
      });
      return { ...canonical, handle, ref };
    });

    for (const [physicalName, handle] of ctx.funcMap) {
      if (exactAliases.some((alias) => alias.handle === handle)) {
        ctx.funcMap.delete(physicalName);
      }
    }
    for (const alias of exactAliases) {
      expect([...ctx.funcMap.values()]).not.toContain(alias.handle);
    }
    for (const className of ["A", "B", "C"]) {
      expect(ctx.structMap.delete(className)).toBe(true);
      expect(ctx.structFields.delete(className)).toBe(true);
    }

    const aShape: IrClassShape = {
      classId: aClassId,
      className: "A",
      fields: [],
      methods: [
        {
          name: "value",
          params: [],
          returnType: { kind: "val", val: { kind: "f64" } },
          memberKind: "method",
        },
        {
          name: "score",
          params: [],
          returnType: { kind: "val", val: { kind: "f64" } },
          memberKind: "getter",
        },
        {
          name: "score",
          params: [{ kind: "val", val: { kind: "f64" } }],
          returnType: null,
          memberKind: "setter",
        },
        {
          name: "scale",
          params: [{ kind: "val", val: { kind: "f64" } }],
          returnType: { kind: "val", val: { kind: "f64" } },
          memberKind: "static",
        },
      ],
      constructorParams: [],
      constructorTarget: irSupportFuncRef(aClassId, "class-constructor-new", "A_new"),
      constructorInitTarget: irUnitFuncRef({ unitId: aConstructorUnitId, name: "A_init" }),
    };
    const bShape: IrClassShape = {
      classId: bClassId,
      className: "B",
      fields: [],
      methods: [],
      constructorParams: [],
      parent: aShape,
      constructorTarget: irSupportFuncRef(bClassId, "class-constructor-new", "B_new"),
      constructorInitTarget: irUnitFuncRef({ unitId: bConstructorUnitId, name: "B_init" }),
    };
    const cShape: IrClassShape = {
      classId: cClassId,
      className: "C",
      fields: [],
      methods: [],
      constructorParams: [],
      parent: bShape,
      constructorTarget: irSupportFuncRef(cClassId, "class-constructor-new", "C_new"),
      constructorInitTarget: irUnitFuncRef({ unitId: cConstructorUnitId, name: "C_init" }),
    };
    const selection: IrSelection = { funcs: new Set(["main"]) };
    const ownerProjection = buildIrLegacyUnitProjection([{ unitId: main!.id, legacyName: "main" }]);
    const report = compileIrPathFunctions(
      ctx,
      ast.sourceFile,
      selection,
      undefined,
      new Map([
        ["A", aShape],
        ["B", bShape],
        ["C", cShape],
      ]),
      {
        identityContext,
        ownerProjection,
        ownerUnitIdByLegacyName: new Map([["main", main!.id]]),
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
      },
    );

    expect(report.errors).toEqual([]);
    expect(report.compiled).toEqual(["main"]);
    for (const alias of exactAliases) {
      expect(session.hasPlan(alias.ref.binding.bindingId)).toBe(true);
      expect(ctx.irUnitFuncMap.get(alias.unit.id)).toBeDefined();
    }
    expect(ctx.irUnitFuncMap.get(main!.id)).toBeDefined();
  });
});
