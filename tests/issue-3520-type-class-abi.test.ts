// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { canonicalProgramAbiTypeDef, canonicalProgramAbiValType } from "../src/codegen/program-abi-signatures.js";
import { irClassTypeRef } from "../src/ir/abi-bindings.js";
import { buildIrUnitInventory, type IrClassId, type IrUnitInventory } from "../src/ir/identity.js";
import type { StructTypeDef } from "../src/ir/types.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

function exactClassId(inventory: IrUnitInventory, name: string): IrClassId {
  const matches = inventory.classes.filter((candidate) => candidate.displayName === name);
  if (matches.length !== 1) {
    throw new Error(`expected one exact class ${name}, found ${matches.length}`);
  }
  return matches[0]!.id;
}

describe("#3520 production Program ABI type and class-layout planning", () => {
  it("publishes every retained type exactly once and binds class layouts by exact class ID", () => {
    const source = `
      class Base {
        value: number;
        constructor(value: number) { this.value = value; }
        read(): number { return this.value; }
      }
      class Child extends Base {
        label: string = "child";
        read(): number { return super.read() + this.label.length; }
      }
      export function main(): number { return new Child(7).read(); }
    `;
    const ast = analyzeSource(source, "type-class-abi.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const classIds = {
      base: exactClassId(inventory, "Base"),
      child: exactClassId(inventory, "Child"),
    };
    const result = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const publication = result.programAbi!;
    const typeEntries = publication.abi
      .entries()
      .filter(
        (entry) =>
          entry.slotPolicy === "required" &&
          entry.slotSpace === "type" &&
          (entry.intent.kind === "type" || entry.intent.kind === "class"),
      );
    expect(typeEntries).toHaveLength(result.module.types.length);

    const finalTypeIndices = typeEntries.map((entry) => {
      const finalIndex = publication.abi.resolveFinalIndex(entry.id);
      expect(finalIndex).toEqual(expect.objectContaining({ space: "type" }));
      if (!finalIndex || finalIndex.space !== "type") {
        throw new Error(`missing final type slot for ${entry.id}`);
      }
      const finalType = result.module.types[finalIndex.index];
      if (!finalType) throw new Error(`missing final type object ${finalIndex.index}`);
      const shapeKey =
        entry.intent.kind === "type"
          ? entry.intent.shapeKey
          : entry.intent.kind === "class"
            ? entry.intent.layoutKey
            : undefined;
      expect(shapeKey).toBe(canonicalProgramAbiTypeDef(finalType));
      return finalIndex.index;
    });
    expect([...finalTypeIndices].sort((left, right) => left - right)).toEqual(
      result.module.types.map((_, index) => index),
    );

    for (const [name, classId] of [
      ["Base", classIds.base],
      ["Child", classIds.child],
    ] as const) {
      const ref = irClassTypeRef(classId, name);
      const entry = publication.abi.get(ref.binding.bindingId);
      expect(entry).toMatchObject({
        id: ref.binding.bindingId,
        displayName: name,
        slotPolicy: "required",
        slotSpace: "type",
        intent: {
          kind: "class",
          classId,
        },
      });
      if (!entry || entry.intent.kind !== "class") {
        throw new Error(`missing exact class-layout ABI entry for ${name}`);
      }
      const finalIndex = publication.abi.resolveFinalIndex(entry.id);
      if (!finalIndex || finalIndex.space !== "type") {
        throw new Error(`missing exact class-layout slot for ${name}`);
      }
      const finalType = result.module.types[finalIndex.index];
      expect(finalType).toEqual(expect.objectContaining({ kind: "struct", name }));
      expect(entry.intent.layoutKey).toBe(canonicalProgramAbiTypeDef(finalType!));
    }

    const baseEntry = publication.abi.get(irClassTypeRef(classIds.base, "Base").binding.bindingId);
    const childEntry = publication.abi.get(irClassTypeRef(classIds.child, "Child").binding.bindingId);
    const baseIndex = baseEntry ? publication.abi.resolveFinalIndex(baseEntry.id)?.index : undefined;
    const childIndex = childEntry ? publication.abi.resolveFinalIndex(childEntry.id)?.index : undefined;
    expect(baseIndex).not.toBe(childIndex);
    const childType = childIndex === undefined ? undefined : result.module.types[childIndex];
    expect((childType as StructTypeDef | undefined)?.superTypeIdx).toBe(baseIndex);
  });

  it("excludes debug names but retains property offsets and branded value semantics in shape keys", () => {
    const base: StructTypeDef = {
      kind: "struct",
      name: "DebugA",
      fields: [
        {
          name: "flag",
          type: { kind: "i32", boolean: true },
          mutable: true,
          jsBoolean: true,
        },
      ],
      final: true,
    };
    const relabelled: StructTypeDef = {
      ...base,
      name: "DebugB",
      fields: base.fields.map((field) => ({ ...field, type: { ...field.type } })),
    };
    const differentField: StructTypeDef = {
      ...relabelled,
      fields: relabelled.fields.map((field) => ({ ...field, name: "other" })),
    };

    expect(canonicalProgramAbiTypeDef(base)).toBe(canonicalProgramAbiTypeDef(relabelled));
    expect(canonicalProgramAbiTypeDef(base)).not.toBe(canonicalProgramAbiTypeDef(differentField));
    const canonical = JSON.parse(canonicalProgramAbiTypeDef(base)) as {
      fields: Array<{ type: string; jsBoolean?: boolean }>;
    };
    expect(canonical.fields[0]).toEqual({
      type: canonicalProgramAbiValType({ kind: "i32", boolean: true }),
      name: "flag",
      mutable: true,
      jsBoolean: true,
    });
  });

  it("gives a multiply collected class expression one exact class owner and catalogs its legacy duplicate", () => {
    const source = `
      const C = class {
        value: number;
        constructor(value: number) { this.value = value; }
        read(): number { return this.value; }
      };
      export function main(): number { return new C(9).read(); }
    `;
    const ast = analyzeSource(source, "class-expression-type-abi.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    expect(inventory.classes).toHaveLength(1);
    const classId = inventory.classes[0]!.id;
    const result = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const publication = result.programAbi!;
    const classEntries = publication.abi
      .entries()
      .filter((entry) => entry.intent.kind === "class" && entry.intent.classId === classId);
    expect(classEntries).toHaveLength(1);
    expect(classEntries[0]).toMatchObject({
      slotPolicy: "required",
      slotSpace: "type",
      intent: {
        kind: "class",
        classId,
      },
    });
    const classIndex = publication.abi.resolveFinalIndex(classEntries[0]!.id);
    if (!classIndex || classIndex.space !== "type") {
      throw new Error("missing exact class-expression layout slot");
    }
    const canonicalLayout = result.module.types[classIndex.index];
    expect(canonicalLayout).toEqual(
      expect.objectContaining({
        kind: "struct",
        name: expect.stringMatching(/^__anonClass_/),
      }),
    );

    const legacyDuplicateIndices = result.module.types
      .map((type, index) => ({ type, index }))
      .filter(
        ({ type, index }) =>
          index !== classIndex.index &&
          type.kind === "struct" &&
          (type.name === "C" || type.name.startsWith("__anonClass_")),
      )
      .map(({ index }) => index);
    expect(legacyDuplicateIndices.length).toBeGreaterThan(0);
    for (const duplicateIndex of legacyDuplicateIndices) {
      const genericOwner = publication.abi.entries().find((entry) => {
        if (entry.intent.kind !== "type") return false;
        return publication.abi.resolveFinalIndex(entry.id)?.index === duplicateIndex;
      });
      expect(genericOwner).toMatchObject({
        slotPolicy: "required",
        slotSpace: "type",
        intent: { kind: "type" },
      });
    }
  });

  it("keeps an ambient class explicit as a slotless layout intention", () => {
    const source = `
      declare class HostValue {
        readonly value: number;
      }
      export function main(): number { return 1; }
    `;
    const ast = analyzeSource(source, "ambient-class-type-abi.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const classId = exactClassId(inventory, "HostValue");
    const result = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const entry = result.programAbi!.abi.get(irClassTypeRef(classId, "HostValue").binding.bindingId);
    expect(entry).toMatchObject({
      displayName: "HostValue",
      slotPolicy: "none",
      intent: {
        kind: "class",
        classId,
        layoutKey: "unallocated",
      },
    });
    expect(entry ? result.programAbi!.abi.resolveFinalIndex(entry.id) : undefined).toBeUndefined();
  });
});
