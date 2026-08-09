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
  type IrUnitKind,
} from "../src/ir/identity.js";
import type { IrClassMemberKind } from "../src/ir/nodes.js";
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

function classMember(
  inventory: IrUnitInventory,
  ownerId: IrClassId,
  kind: IrUnitKind,
  legacyName: string,
): IrTerminalUnitRecord {
  const matches = inventory.terminalUnits.filter(
    (candidate) =>
      candidate.kind === kind && candidate.lexicalOwnerId === ownerId && candidate.legacyMatchName === legacyName,
  );
  if (matches.length !== 1) {
    throw new Error(`expected one exact ${kind} ${ownerId} / ${legacyName}, found ${matches.length}`);
  }
  return matches[0]!;
}

function inheritedMemberAliasRef(
  inventory: IrUnitInventory,
  childClassId: IrClassId,
  memberKind: Exclude<IrClassMemberKind, "method">,
  memberName: string,
  physicalName: string,
  canonicalMember: IrTerminalUnitRecord,
) {
  const derivedOrdinal = inventory.allUnits.findIndex((candidate) => candidate.id === canonicalMember.id);
  if (derivedOrdinal < 0) throw new Error(`canonical member ${canonicalMember.id} is absent from allUnits`);
  return irSupportFuncRef(
    childClassId,
    `class-member-adapter:${memberKind}:${memberName}`,
    physicalName,
    derivedOrdinal,
  );
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

describe("#3520 inherited class-member Program ABI aliases", () => {
  it("owns getter, setter, and static aliases by semantic kind and exact ancestor source unit", async () => {
    const source = `
      class A {
        #value: number;
        constructor() { this.#value = 4; }
        get value(): number { return this.#value; }
        set value(next: number) { this.#value = next; }
        static scale(value: number): number { return value * 2; }
      }
      class B extends A {}
      class C extends B {}

      function C_get_value(): number { return 1000; }
      function C_set_value(value: number): number { return value + 2000; }
      function C_scale(value: number): number { return value + 3000; }

      export function main(): number {
        const child = new C();
        child.value = child.value + 5;
        return (
          child.value * 1_000_000 +
          C.scale(3) * 100_000 +
          C_get_value() * 100 +
          C_set_value(1) * 10 +
          C_scale(1)
        );
      }
    `;
    const ast = analyzeSource(source, "class-member-alias-collision.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const aClassId = classId(inventory, "A");
    const cClassId = classId(inventory, "C");
    const canonical = {
      getter: classMember(inventory, aClassId, "class-instance-getter", "A_get_value"),
      setter: classMember(inventory, aClassId, "class-instance-setter", "A_set_value"),
      static: classMember(inventory, aClassId, "class-static-method", "A_scale"),
    };

    const result = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toEqual(
      expect.arrayContaining(["A_get_value", "A_set_value", "C_get_value", "C_set_value", "C_scale", "main"]),
    );
    expect(result.irPostClaimErrors).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const publication = result.programAbi!;
    const entries = publication.abi.entries();
    const refs = {
      getter: inheritedMemberAliasRef(inventory, cClassId, "getter", "value", "__cm$C_get_value", canonical.getter),
      setter: inheritedMemberAliasRef(inventory, cClassId, "setter", "value", "__cm$C_set_value", canonical.setter),
      static: inheritedMemberAliasRef(inventory, cClassId, "static", "scale", "__cm$C_scale", canonical.static),
    };

    for (const kind of ["getter", "setter", "static"] as const) {
      const canonicalId = irUnitCallableBindingId(canonical[kind].id);
      const alias = entries.find((entry) => entry.id === refs[kind].binding.bindingId);
      const canonicalEntry = entries.find((entry) => entry.id === canonicalId);
      expect(alias).toMatchObject({
        id: refs[kind].binding.bindingId,
        displayName: refs[kind].name,
        slotPolicy: "alias",
        aliasOf: canonicalId,
        intent: {
          kind: "callable",
          origin: "support",
          classId: cClassId,
        },
      });
      if (
        !alias ||
        alias.slotPolicy !== "alias" ||
        alias.intent.kind !== "callable" ||
        !canonicalEntry ||
        canonicalEntry.intent.kind !== "callable"
      ) {
        throw new Error(`missing exact inherited ${kind} ABI alias`);
      }
      expect(alias.intent.signature).toEqual(canonicalEntry.intent.signature);
      expect(publication.abi.resolveFinalIndex(alias.id)).toEqual(publication.abi.resolveFinalIndex(canonicalId));
      expect(alias).not.toHaveProperty("slotSpace");

      const slot = publication.abi.resolveFinalIndex(alias.id);
      if (!slot || slot.space !== "function") throw new Error(`missing final ${kind} alias slot`);
      const importCount = result.module.imports.filter((candidate) => candidate.desc.kind === "func").length;
      const func = result.module.functions[slot.index - importCount];
      const signature = func ? result.module.types[func.typeIdx] : undefined;
      if (!signature || signature.kind !== "func") throw new Error(`missing final ${kind} function signature`);
      expect(canonicalProgramAbiCallableTypeContract(signature)).toEqual(alias.intent.signature);
      expect(result.module.functions.some((candidate) => candidate.name === refs[kind].name)).toBe(false);
    }

    expect(Number(await runtimeValue(source))).toBe(9_723_011);
  });
});
