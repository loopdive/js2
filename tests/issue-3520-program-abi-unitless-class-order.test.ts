// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { buildIrUnitInventory, type IrClassId, type IrClassRecord, type IrUnitInventory } from "../src/ir/identity.js";
import { preprocessImports } from "../src/import-resolver.js";
import { createEmptyModule } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

function source(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function sessionFor(sourceFiles: readonly ts.SourceFile[], entrySource = sourceFiles[0]!) {
  const inventory = buildIrUnitInventory(sourceFiles, { entrySource });
  return {
    inventory,
    session: new ProgramAbiSession(inventory, createEmptyModule()),
  };
}

function classOrdinal(session: ProgramAbiSession, classId: IrClassId): number {
  return session.structuralOrder.forClass(classId, { domain: "class", roleOrdinal: 0 }).declarationOrdinal;
}

function classByName(inventory: IrUnitInventory, displayName: string): IrClassRecord {
  const record = inventory.classes.find((candidate) => candidate.displayName === displayName);
  if (!record) throw new Error(`missing class ${displayName}`);
  return record;
}

describe("#3520 Program ABI ordering for classes without executable units", () => {
  it("gives multiple ambient classes unique deterministic source-local anchors", () => {
    const ambient = source(
      "/repo/ambient.d.ts",
      `declare class First {} declare class Second {} declare class Third {}`,
    );
    const { inventory, session } = sessionFor([ambient]);

    expect(inventory.classes).toHaveLength(3);
    expect(inventory.allUnits).toHaveLength(0);
    expect(inventory.classes.map((record) => classOrdinal(session, record.id))).toEqual([1, 3, 5]);
  });

  it("keeps member-backed ordering and isolates mixed unitless class anchors", () => {
    const mixed = source(
      "/repo/mixed.ts",
      `
        declare class AmbientBefore { read(): number; }
        class Live { method() { return 1; } }
        declare class AmbientAfter {}
      `,
    );
    const { inventory, session } = sessionFor([mixed]);
    const sourceId = inventory.sources[0]!.id;
    const live = classByName(inventory, "Live");
    const ambient = [classByName(inventory, "AmbientBefore"), classByName(inventory, "AmbientAfter")];
    const unitOrdinals = inventory.allUnits.map(
      (unit) => session.structuralOrder.forUnit(unit.id, { domain: "callable", roleOrdinal: 0 }).declarationOrdinal,
    );
    const classOrdinals = inventory.classes.map((record) => classOrdinal(session, record.id));
    const liveMemberOrdinals = inventory.allUnits
      .filter((unit) => unit.lexicalOwnerId === live.id)
      .map(
        (unit) => session.structuralOrder.forUnit(unit.id, { domain: "callable", roleOrdinal: 0 }).declarationOrdinal,
      );

    expect(unitOrdinals).toEqual(inventory.allUnits.map((_, index) => (index + 1) * 2));
    expect(liveMemberOrdinals.length).toBeGreaterThan(0);
    expect(classOrdinal(session, live.id)).toBe(Math.min(...liveMemberOrdinals) - 1);
    expect(ambient.map((record) => classOrdinal(session, record.id))).toEqual(
      ambient.map((_, index) => Math.max(...unitOrdinals) + 1 + index * 2),
    );
    const everyAnchor = [
      session.structuralOrder.forSource(sourceId, { domain: "support", roleOrdinal: 0 }).declarationOrdinal,
      ...unitOrdinals,
      ...classOrdinals,
    ];
    expect(new Set(everyAnchor).size).toBe(everyAnchor.length);
  });

  it("is stable when disconnected source inputs are reversed", () => {
    const entry = source("/repo/entry.d.ts", `declare class EntryFirst {} declare class EntrySecond {}`);
    const dependency = source(
      "/repo/dependency.d.ts",
      `declare class DependencyFirst {} declare class DependencySecond {}`,
    );
    const rows = (inputs: readonly ts.SourceFile[]) => {
      const { inventory, session } = sessionFor(inputs, entry);
      return inventory.classes.map((record) => ({
        id: record.id,
        sourceId: record.sourceId,
        declarationStart: record.declarationStart,
        declarationOrdinal: classOrdinal(session, record.id),
      }));
    };

    const forward = rows([entry, dependency]);
    expect(forward.map((row) => row.declarationOrdinal)).toEqual([1, 3, 1, 3]);
    expect(forward).toEqual(rows([dependency, entry]));
  });

  it("orders transformed unitless import classes beside a member-backed nested class", () => {
    const text = `
      import { EventEmitter } from "node:events";
      import * as sdk from "sdk";
      let client: sdk.Client;
      if (true) { class Local { m() { return 1; } } }
      export function main() { return client ? new EventEmitter() : null; }
    `;
    const transformed = preprocessImports(text);
    const processed = source("/repo/ambient-imports.ts", transformed.source);
    const inventory = buildIrUnitInventory([processed], {
      entrySource: processed,
      compilerOriginAt: (_sourceFile, offset) => transformed.positionMap.compilerOriginAtOutputOffset(offset),
    });
    const session = new ProgramAbiSession(inventory, createEmptyModule());
    const generated = inventory.classes.filter((record) => record.syntheticRole !== undefined);
    const local = classByName(inventory, "Local");
    const moduleInit = inventory.allUnits.find((unit) => unit.kind === "module-init")!;
    const localMemberOrdinals = inventory.allUnits
      .filter((unit) => unit.lexicalOwnerId === local.id)
      .map(
        (unit) => session.structuralOrder.forUnit(unit.id, { domain: "callable", roleOrdinal: 0 }).declarationOrdinal,
      );
    const unitlessTailStart = inventory.allUnits.length * 2 + 1;

    expect(generated).toHaveLength(2);
    expect(generated.every((record) => record.lexicalOwnerId === moduleInit.id)).toBe(true);
    expect(generated.every((record) => inventory.allUnits.every((unit) => unit.lexicalOwnerId !== record.id))).toBe(
      true,
    );
    expect(generated.map((record) => classOrdinal(session, record.id))).toEqual([
      unitlessTailStart,
      unitlessTailStart + 2,
    ]);
    expect(classOrdinal(session, local.id)).toBe(Math.min(...localMemberOrdinals) - 1);
    expect(new Set(inventory.classes.map((record) => classOrdinal(session, record.id))).size).toBe(
      inventory.classes.length,
    );
  });

  it.each([
    [
      "#2961 extern constructor/method guard",
      `
        declare class Widget {
          constructor(n: number);
          render(): number;
        }
        export function test(): number { const w = new Widget(3); return w.render(); }
      `,
    ],
    [
      "#3565 extern index-signature guard",
      `
        declare class Coll { [i: number]: string; length: number; }
        export function first(c: Coll): string { return c[0]; }
      `,
    ],
  ])("accepts the exact ambient-class shape for %s", (_label, text) => {
    const fixture = source("/repo/guard.ts", text);
    const { inventory, session } = sessionFor([fixture]);
    const ambientClass = inventory.classes[0]!;

    expect(inventory.allUnits.some((unit) => unit.lexicalOwnerId === ambientClass.id)).toBe(false);
    expect(classOrdinal(session, ambientClass.id)).toBeGreaterThan(
      Math.max(
        0,
        ...inventory.allUnits.map(
          (unit) => session.structuralOrder.forUnit(unit.id, { domain: "callable", roleOrdinal: 0 }).declarationOrdinal,
        ),
      ),
    );
  });
});
