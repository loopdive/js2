// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { compileDeclarations, collectDeclarations } from "../src/codegen/declarations.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { irSupportFuncRef, irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { compileIrPathFunctions } from "../src/ir/integration.js";
import type { IrClassShape } from "../src/ir/nodes.js";
import { buildIrLegacyUnitProjection, buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import type { IrSelection } from "../src/ir/select.js";
import { createEmptyModule } from "../src/ir/types.js";

describe("#3520 production class integration callable ABI", () => {
  it("resolves a class body by exact source unit after its physical name is unavailable", () => {
    const ast = analyzeSource(
      `
        class Empty {
          value(): number { return 42; }
        }
        export function main(): number {
          return new Empty().value();
        }
      `,
      "exact-class-integration.ts",
    );
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const identityContext = buildIrPlanningIdentityContext(inventory);
    const emptyClass = inventory.classes.find((candidate) => candidate.displayName === "Empty");
    const implicitConstructor = inventory.allUnits.find(
      (unit) => unit.lexicalOwnerId === emptyClass?.id && unit.kind === "class-implicit-constructor",
    );
    const main = inventory.terminalUnits.find(
      (unit) => unit.kind === "top-level-function" && unit.displayName === "main",
    );
    const valueMethod = inventory.terminalUnits.find(
      (unit) =>
        unit.lexicalOwnerId === emptyClass?.id &&
        unit.kind === "class-instance-method" &&
        unit.displayName === "Empty_value",
    );
    expect(emptyClass).toBeDefined();
    expect(implicitConstructor).toBeDefined();
    expect(main).toBeDefined();
    expect(valueMethod).toBeDefined();

    const mod = createEmptyModule();
    const session = new ProgramAbiSession(inventory, mod);
    const ctx = createCodegenContext(mod, ast.checker, { experimentalIR: true }, session, identityContext);
    collectDeclarations(ctx, ast.sourceFile);
    compileDeclarations(ctx, ast.sourceFile);

    const constructorHandle = ctx.programAbiClassCallables?.handleForUnit(implicitConstructor!.id);
    const methodHandle = ctx.programAbiClassCallables?.handleForUnit(valueMethod!.id);
    const constructorNewRef = irSupportFuncRef(emptyClass!.id, "class-constructor-new", "Empty_new");
    const constructorNewHandle =
      constructorNewRef.binding.kind === "support"
        ? ctx.programAbiClassCallables?.handleForSupport(constructorNewRef.binding.bindingId)
        : undefined;
    const constructorInitRef = irUnitFuncRef({ unitId: implicitConstructor!.id, name: "Empty_init" });
    expect(constructorHandle).toBeDefined();
    expect(methodHandle).toBeDefined();
    expect(constructorNewHandle).toBeDefined();
    expect(constructorHandle).toBe(ctx.funcMap.get("Empty_init"));
    expect(constructorNewHandle).toBe(ctx.funcMap.get("Empty_new"));
    for (const [physicalName, handle] of ctx.funcMap) {
      if (handle === constructorHandle || handle === methodHandle || handle === constructorNewHandle) {
        ctx.funcMap.delete(physicalName);
      }
    }
    expect([...ctx.funcMap.values()]).not.toContain(constructorHandle);
    expect([...ctx.funcMap.values()]).not.toContain(methodHandle);
    expect([...ctx.funcMap.values()]).not.toContain(constructorNewHandle);

    const emptyShape: IrClassShape = {
      classId: emptyClass!.id,
      className: "Empty",
      fields: [],
      methods: [
        {
          name: "value",
          params: [],
          returnType: { kind: "val", val: { kind: "f64" } },
          memberKind: "method",
        },
      ],
      constructorParams: [],
      constructorTarget: constructorNewRef,
      constructorInitTarget: constructorInitRef,
    };
    const selection: IrSelection = {
      funcs: new Set(["main"]),
      classMembers: new Set(["Empty_value"]),
    };
    const ownerProjection = buildIrLegacyUnitProjection([
      { unitId: main!.id, legacyName: "main" },
      { unitId: valueMethod!.id, legacyName: "Empty_value" },
    ]);
    const report = compileIrPathFunctions(ctx, ast.sourceFile, selection, undefined, new Map([["Empty", emptyShape]]), {
      identityContext,
      ownerProjection,
      ownerUnitIdByLegacyName: new Map([
        ["main", main!.id],
        ["Empty_value", valueMethod!.id],
      ]),
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

    expect(report.errors).toEqual([]);
    expect(report.compiled).toEqual(["main", "Empty_value"]);
    expect(ctx.irUnitFuncMap.get(implicitConstructor!.id)).toBeDefined();
    expect(ctx.irUnitFuncMap.get(valueMethod!.id)).toBeDefined();
    expect(ctx.irUnitFuncMap.get(main!.id)).toBeDefined();
    if (constructorNewRef.binding.kind !== "support") throw new Error("expected class-new support reference");
    expect(session.hasPlan(constructorNewRef.binding.bindingId)).toBe(true);
  });
});
