// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { canonicalProgramAbiCallableTypeContract } from "../src/codegen/program-abi-signatures.js";
import { irSupportFuncRef, irUnitCallableBindingId } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, type IrClassId, type IrUnitInventory, type IrUnitKind } from "../src/ir/identity.js";
import type { ProgramAbiPlanEntry } from "../src/ir/program-abi.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const CLASS_CALLABLE_KINDS = new Set<IrUnitKind>([
  "class-constructor",
  "class-implicit-constructor",
  "class-instance-method",
  "class-static-method",
  "class-instance-getter",
  "class-static-getter",
  "class-instance-setter",
  "class-static-setter",
]);

function exactClassId(inventory: IrUnitInventory, displayName: string): IrClassId {
  const matches = inventory.classes.filter((record) => record.displayName === displayName);
  if (matches.length !== 1) throw new Error(`expected one class ${displayName}, found ${matches.length}`);
  return matches[0]!.id;
}

function requiredCallable(entries: readonly ProgramAbiPlanEntry[], bindingId: string): ProgramAbiPlanEntry {
  const entry = entries.find((candidate) => candidate.id === bindingId);
  if (!entry) throw new Error(`missing callable ABI entry ${bindingId}`);
  expect(entry).toMatchObject({
    slotPolicy: "required",
    slotSpace: "function",
    intent: { kind: "callable" },
  });
  return entry;
}

describe("#3520 retained host-class callable Program ABI ownership", () => {
  it("owns externref class units and the Promise on-host constructor by exact structural identity", () => {
    const source = `
      class HostError extends Error {
        constructor(message: string) { super(message); }
        code(): number { return 7; }
      }

      class SubPromise extends Promise<number> {
        constructor(executor: any) { super(executor); }
        ping(): number { return 11; }
        static scale(value: number): number { return value * 2; }
      }

      function HostError_new(): number { return 101; }
      function HostError_code(): number { return 102; }
      function SubPromise_new(): number { return 201; }
      function SubPromise_ping(): number { return 202; }
      function SubPromise_scale(): number { return 203; }
      function SubPromise_new__onhost(): number { return 204; }

      export function useError(): number {
        const value = new HostError("x");
        return value.code();
      }

      export function usePromise(value: SubPromise): number {
        (Promise.all as any).call(SubPromise, [] as any);
        return value.ping() + SubPromise.scale(3);
      }

      export function collisionValues(): number {
        return (
          HostError_new() +
          HostError_code() +
          SubPromise_new() +
          SubPromise_ping() +
          SubPromise_scale() +
          SubPromise_new__onhost()
        );
      }
    `;
    const ast = analyzeSource(source, "host-class-callable-collision.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const hostErrorId = exactClassId(inventory, "HostError");
    const subPromiseId = exactClassId(inventory, "SubPromise");

    const result = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.irPostClaimErrors).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const entries = result.programAbi!.abi.entries();
    const classUnits = inventory.allUnits.filter(
      (unit) =>
        (unit.lexicalOwnerId === hostErrorId || unit.lexicalOwnerId === subPromiseId) &&
        CLASS_CALLABLE_KINDS.has(unit.kind),
    );
    expect(classUnits.map((unit) => unit.kind)).toEqual([
      "class-constructor",
      "class-instance-method",
      "class-constructor",
      "class-instance-method",
      "class-static-method",
    ]);

    const importCount = result.module.imports.filter((candidate) => candidate.desc.kind === "func").length;
    for (const unit of classUnits) {
      expect(result.irOutcomes?.find((outcome) => outcome.unitId === unit.id)).toMatchObject({
        legacyBodyEmitted: true,
        irBodyEmitted: false,
        kind: "unsupported",
      });
      const bindingId = irUnitCallableBindingId(unit.id);
      const entry = requiredCallable(entries, bindingId);
      expect(entry.intent).toMatchObject({
        kind: "callable",
        origin: "source",
        unitId: unit.id,
      });
      expect(entry.displayName).toBe(`__cm$${unit.legacyMatchName}`);
      const slot = result.programAbi!.abi.resolveFinalIndex(bindingId);
      if (!slot || slot.space !== "function") throw new Error(`missing function slot for ${bindingId}`);
      const func = result.module.functions[slot.index - importCount];
      const signature = func ? result.module.types[func.typeIdx] : undefined;
      if (!func || !signature || signature.kind !== "func") {
        throw new Error(`missing retained function for ${bindingId}`);
      }
      expect(func.name).toBe(entry.displayName);
      expect(entry.intent).toMatchObject({
        kind: "callable",
        signature: canonicalProgramAbiCallableTypeContract(signature),
      });
      expect(entries.filter((candidate) => candidate.displayName === func.name)).toHaveLength(1);
    }

    const onHostRef = irSupportFuncRef(
      subPromiseId,
      "promise-subclass-onhost-constructor",
      "__cm$SubPromise_new__onhost",
    );
    if (onHostRef.binding.kind !== "support") throw new Error("expected Promise on-host support reference");
    const onHostEntry = requiredCallable(entries, onHostRef.binding.bindingId);
    expect(onHostEntry).toMatchObject({
      displayName: "__cm$SubPromise_new__onhost",
      intent: {
        kind: "callable",
        origin: "support",
        classId: subPromiseId,
      },
    });
    const onHostSlot = result.programAbi!.abi.resolveFinalIndex(onHostEntry.id);
    if (!onHostSlot || onHostSlot.space !== "function") throw new Error("missing Promise on-host function slot");
    const onHostFunc = result.module.functions[onHostSlot.index - importCount];
    const onHostSignature = onHostFunc ? result.module.types[onHostFunc.typeIdx] : undefined;
    if (!onHostFunc || !onHostSignature || onHostSignature.kind !== "func") {
      throw new Error("missing retained Promise on-host function");
    }
    expect(onHostEntry.intent).toMatchObject({
      kind: "callable",
      signature: canonicalProgramAbiCallableTypeContract(onHostSignature),
    });
    expect(entries.filter((candidate) => candidate.displayName === onHostFunc.name)).toHaveLength(1);
  });
});
