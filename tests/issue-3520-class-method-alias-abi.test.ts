// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { canonicalProgramAbiCallableTypeContract } from "../src/codegen/program-abi-signatures.js";
import { compile } from "../src/index.js";
import { irSupportFuncRef, irUnitCallableBindingId } from "../src/ir/callable-bindings.js";
import {
  buildIrUnitInventory,
  type IrClassId,
  type IrTerminalUnitRecord,
  type IrUnitInventory,
} from "../src/ir/identity.js";
import { buildImports } from "../src/runtime.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

function classId(inventory: IrUnitInventory, name: string): IrClassId {
  const record = inventory.classes.find((candidate) => candidate.displayName === name);
  if (!record) throw new Error(`missing ${name} class identity`);
  return record.id;
}

function instanceMethod(inventory: IrUnitInventory, ownerId: IrClassId, legacyName: string): IrTerminalUnitRecord {
  const matches = inventory.terminalUnits.filter(
    (candidate) =>
      candidate.kind === "class-instance-method" &&
      candidate.lexicalOwnerId === ownerId &&
      candidate.legacyMatchName === legacyName,
  );
  if (matches.length !== 1) {
    throw new Error(`expected one exact instance method ${ownerId} / ${legacyName}, found ${matches.length}`);
  }
  return matches[0]!;
}

function inheritedMethodAliasRef(
  inventory: IrUnitInventory,
  childClassId: IrClassId,
  methodName: string,
  physicalName: string,
  canonicalMethod: IrTerminalUnitRecord,
) {
  const derivedOrdinal = inventory.allUnits.findIndex((candidate) => candidate.id === canonicalMethod.id);
  if (derivedOrdinal < 0) throw new Error(`canonical method ${canonicalMethod.id} is absent from allUnits`);
  return irSupportFuncRef(childClassId, `class-method-adapter:instance:${methodName}`, physicalName, derivedOrdinal);
}

async function runtimeValue(source: string): Promise<unknown> {
  const compiled = await compile(source, { experimentalIR: true });
  expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(compiled.imports, ENV_STUB, compiled.stringPool);
  const { instance } = await WebAssembly.instantiate(compiled.binary, {
    env: imports.env,
    "wasm:js-string": imports["wasm:js-string"],
    string_constants: imports.string_constants,
    string_constants16: imports.string_constants16,
  });
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports.main as () => unknown)();
}

describe("#3520 inherited instance-method Program ABI aliases", () => {
  it("publishes exact child aliases for transitive and overridden methods without allocating child slots", async () => {
    const source = `
      class A {
        m(value: number): number { return value + 10; }
        n(value: number): number { return value + 100; }
      }
      class B extends A {
        m(value: number): number { return value + 20; }
      }
      class C extends B {}

      function C_m(value: number): number { return value + 1000; }

      export function main(): number {
        const parent = new A();
        const child = new C();
        return (
          parent.m(1) * 1_000_000 +
          child.m(2) * 10_000 +
          child.n(3) * 10 +
          C_m(4)
        );
      }
    `;
    const ast = analyzeSource(source, "class-method-alias-collision.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const aClassId = classId(inventory, "A");
    const bClassId = classId(inventory, "B");
    const cClassId = classId(inventory, "C");
    const aMethodM = instanceMethod(inventory, aClassId, "A_m");
    const aMethodN = instanceMethod(inventory, aClassId, "A_n");
    const bMethodM = instanceMethod(inventory, bClassId, "B_m");
    const userCollision = inventory.terminalUnits.find(
      (candidate) => candidate.kind === "top-level-function" && candidate.displayName === "C_m",
    );
    if (!userCollision) throw new Error("missing exact user C_m function identity");

    const result = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.irCompiledFuncs).toEqual(expect.arrayContaining(["A_m", "A_n", "B_m", "C_m", "main"]));
    expect(result.irPostClaimErrors).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const publication = result.programAbi!;
    const entries = publication.abi.entries();
    const canonicalIds = {
      aM: irUnitCallableBindingId(aMethodM.id),
      aN: irUnitCallableBindingId(aMethodN.id),
      bM: irUnitCallableBindingId(bMethodM.id),
    };
    const aliasRefs = {
      // The top-level C_m forces the inherited child compatibility key to the
      // collision-free spelling. Identity remains class/method/ancestor based.
      m: inheritedMethodAliasRef(inventory, cClassId, "m", "__cm$C_m", bMethodM),
      n: inheritedMethodAliasRef(inventory, cClassId, "n", "C_n", aMethodN),
    };
    const aliases = {
      m: entries.find((entry) => entry.id === aliasRefs.m.binding.bindingId),
      n: entries.find((entry) => entry.id === aliasRefs.n.binding.bindingId),
    };

    expect(aliases.m).toMatchObject({
      id: aliasRefs.m.binding.bindingId,
      displayName: "__cm$C_m",
      slotPolicy: "alias",
      aliasOf: canonicalIds.bM,
      intent: {
        kind: "callable",
        origin: "support",
        classId: cClassId,
      },
    });
    expect(aliases.n).toMatchObject({
      id: aliasRefs.n.binding.bindingId,
      displayName: "C_n",
      slotPolicy: "alias",
      aliasOf: canonicalIds.aN,
      intent: {
        kind: "callable",
        origin: "support",
        classId: cClassId,
      },
    });
    if (
      !aliases.m ||
      aliases.m.slotPolicy !== "alias" ||
      aliases.m.intent.kind !== "callable" ||
      !aliases.n ||
      aliases.n.slotPolicy !== "alias" ||
      aliases.n.intent.kind !== "callable"
    ) {
      throw new Error("missing exact inherited instance-method alias entries");
    }

    // Two inherited names under C receive separate structural positions. C.m
    // targets B's override directly; C.n skips B and targets A's declaration.
    expect(aliases.m.order.sourceOrder).toBe(aliases.n.order.sourceOrder);
    expect(aliases.m.order.declarationOrder).not.toBe(aliases.n.order.declarationOrder);
    expect(aliases.m.aliasOf).toBe(canonicalIds.bM);
    expect(aliases.m.aliasOf).not.toBe(canonicalIds.aM);
    expect(aliases.n.aliasOf).toBe(canonicalIds.aN);

    const canonicalEntries = {
      m: entries.find((entry) => entry.id === canonicalIds.bM),
      n: entries.find((entry) => entry.id === canonicalIds.aN),
    };
    if (
      !canonicalEntries.m ||
      canonicalEntries.m.intent.kind !== "callable" ||
      !canonicalEntries.n ||
      canonicalEntries.n.intent.kind !== "callable"
    ) {
      throw new Error("missing canonical source-method ABI entries");
    }
    expect(aliases.m.intent.signature).toEqual(canonicalEntries.m.intent.signature);
    expect(aliases.n.intent.signature).toEqual(canonicalEntries.n.intent.signature);

    const aliasSlots = {
      m: publication.abi.resolveFinalIndex(aliases.m.id),
      n: publication.abi.resolveFinalIndex(aliases.n.id),
    };
    expect(aliasSlots.m).toEqual(publication.abi.resolveFinalIndex(canonicalIds.bM));
    expect(aliasSlots.n).toEqual(publication.abi.resolveFinalIndex(canonicalIds.aN));
    expect(aliases.m).not.toHaveProperty("slotSpace");
    expect(aliases.n).not.toHaveProperty("slotSpace");
    expect(result.module.functions.some((func) => func.name === "__cm$C_m")).toBe(false);
    expect(result.module.functions.some((func) => func.name === "C_n")).toBe(false);

    const importCount = result.module.imports.filter((candidate) => candidate.desc.kind === "func").length;
    for (const [alias, slot] of [
      [aliases.m, aliasSlots.m],
      [aliases.n, aliasSlots.n],
    ] as const) {
      if (!slot || slot.space !== "function") throw new Error(`missing final alias slot for ${alias.id}`);
      const func = result.module.functions[slot.index - importCount];
      const signature = func ? result.module.types[func.typeIdx] : undefined;
      if (!signature || signature.kind !== "func") {
        throw new Error(`missing final canonical function signature for ${alias.id}`);
      }
      const valueTypes = [...signature.params, ...signature.results];
      expect(valueTypes.some((type) => type.kind === "ref" || type.kind === "ref_null")).toBe(true);
      expect(valueTypes.some((type) => type.kind === "externref")).toBe(false);
      expect(canonicalProgramAbiCallableTypeContract(signature)).toEqual(alias.intent.signature);
    }

    const userEntry = entries.find((entry) => entry.id === irUnitCallableBindingId(userCollision.id));
    expect(userEntry).toMatchObject({
      id: irUnitCallableBindingId(userCollision.id),
      displayName: "C_m",
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "source",
        unitId: userCollision.id,
      },
    });
    const userSlot = publication.abi.resolveFinalIndex(userEntry!.id);
    expect(userSlot).not.toEqual(aliasSlots.m);
    expect(userSlot).not.toEqual(aliasSlots.n);

    expect(Number(await runtimeValue(source))).toBe(11_222_034);
  });
});
