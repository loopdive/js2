// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { addImport, addStringConstantGlobal } from "../src/codegen/registry/imports.js";
import { irGlobalBindingKey, irImportGlobalRef } from "../src/ir/abi-bindings.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { type GlobalDef, createEmptyModule } from "../src/ir/types.js";
import { STRING_CONSTANTS16_NS } from "../src/string-surrogate.js";
import { ts } from "../src/ts-api.js";

function fixture(nativeStrings: boolean) {
  const sourceFile = ts.createSourceFile(
    "/repo/imported-globals.ts",
    "export function main() {}",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  const module = createEmptyModule();
  module.types.push({ kind: "func", name: "$void", params: [], results: [] });
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, {} as ts.TypeChecker, { nativeStrings }, session);
  const entrySource = inventory.sources.find((source) => source.kind === "entry");
  if (!entrySource) throw new Error("missing entry source");
  return { ctx, entrySource, module, session };
}

describe("#3520 production imported-global ABI planning", () => {
  it("retains an empty string import field in an injective structural key", () => {
    const { entrySource } = fixture(false);
    const empty = irImportGlobalRef(entrySource.id, "string_constants", "", "__str_0", 0);
    const nonEmpty = irImportGlobalRef(entrySource.id, "string_constants", "0:", "__str_1", 1);

    expect(empty.binding).toMatchObject({
      kind: "import",
      module: "string_constants",
      field: "",
    });
    expect(irGlobalBindingKey(empty.binding)).toContain("|0:");
    expect(irGlobalBindingKey(empty.binding)).not.toBe(irGlobalBindingKey(nonEmpty.binding));
  });

  it("binds deduplicated string constants to exact import objects after late/interleaved imports", () => {
    const { ctx, entrySource, module, session } = fixture(false);
    const earlyFunc = addImport(ctx, "env", "early", { kind: "func", typeIdx: 0 });
    expect(earlyFunc).toBe(module.imports[0]);

    addStringConstantGlobal(ctx, "");
    addStringConstantGlobal(ctx, "");
    addStringConstantGlobal(ctx, "plain");
    addStringConstantGlobal(ctx, "plain");

    const definedGlobal: GlobalDef = {
      name: "__state",
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    };
    module.globals.push(definedGlobal);
    ctx.moduleGlobals.set("state", 2);
    const lateFunc = addImport(ctx, "env", "late", { kind: "func", typeIdx: 0 });
    expect(lateFunc).toBe(module.imports[3]);

    const loneSurrogate = "\ud800";
    addStringConstantGlobal(ctx, loneSurrogate);
    const latestFunc = addImport(ctx, "env", "latest", { kind: "func", typeIdx: 0 });
    expect(latestFunc).toBe(module.imports[5]);

    expect(ctx.numImportFuncs).toBe(3);
    expect(ctx.numImportGlobals).toBe(3);
    expect(ctx.moduleGlobals.get("state")).toBe(3);
    expect(module.imports.map(({ module: namespace, name, desc }) => [namespace, name, desc.kind])).toEqual([
      ["env", "early", "func"],
      ["string_constants", "", "global"],
      ["string_constants", "plain", "global"],
      ["env", "late", "func"],
      [STRING_CONSTANTS16_NS, "d800", "global"],
      ["env", "latest", "func"],
    ]);

    const emptyRef = irImportGlobalRef(entrySource.id, "string_constants", "", "empty-label", 0);
    const plainRef = irImportGlobalRef(entrySource.id, "string_constants", "plain", "renamed-label", 1);
    const surrogateRef = irImportGlobalRef(entrySource.id, STRING_CONSTANTS16_NS, "d800", "other-label", 2);
    const emptyImport = module.imports[1]!;
    const plainImport = module.imports[2]!;
    const surrogateImport = module.imports[4]!;
    expect(session.getDraft(emptyRef.binding.bindingId)).toMatchObject({
      structuralOrder: {
        sourceId: entrySource.id,
        declarationOrdinal: 0,
        domainOrdinal: 1,
        roleOrdinal: 4,
        derivedOrdinal: 0,
      },
      structuralReferenceKey: irGlobalBindingKey(emptyRef.binding),
      displayName: "__str_0",
      intent: { kind: "global", origin: "import" },
    });
    expect(session.getDraft(plainRef.binding.bindingId)).toMatchObject({
      structuralOrder: {
        sourceId: entrySource.id,
        declarationOrdinal: 0,
        domainOrdinal: 1,
        roleOrdinal: 4,
        derivedOrdinal: 1,
      },
      structuralReferenceKey: irGlobalBindingKey(plainRef.binding),
      displayName: "__str_1",
      slotPolicy: "required",
      slotSpace: "global",
      intent: {
        kind: "global",
        origin: "import",
        valueType: '{"kind":"externref"}',
        mutable: false,
      },
    });
    expect(session.getDraft(surrogateRef.binding.bindingId)).toMatchObject({
      structuralOrder: {
        sourceId: entrySource.id,
        declarationOrdinal: 0,
        domainOrdinal: 1,
        roleOrdinal: 4,
        derivedOrdinal: 2,
      },
      structuralReferenceKey: irGlobalBindingKey(surrogateRef.binding),
      displayName: "__str_2",
      intent: { kind: "global", origin: "import" },
    });
    expect(session.hasLocator(emptyRef.binding.bindingId, emptyImport)).toBe(true);
    expect(session.hasLocator(plainRef.binding.bindingId, plainImport)).toBe(true);
    expect(session.hasLocator(surrogateRef.binding.bindingId, surrogateImport)).toBe(true);

    ctx.indexSpaceFrozen = true;
    const { abi } = session.publish(module);
    expect(abi.entries()).toHaveLength(3);
    expect(abi.resolveFinalIndex(emptyRef.binding.bindingId)).toEqual({ space: "global", index: 0 });
    expect(abi.resolveFinalIndex(plainRef.binding.bindingId)).toEqual({ space: "global", index: 1 });
    expect(abi.resolveFinalIndex(surrogateRef.binding.bindingId)).toEqual({ space: "global", index: 2 });
  });

  it("keeps nativeStrings on the sentinel path without an ABI import entry", () => {
    const { ctx, module, session } = fixture(true);
    addStringConstantGlobal(ctx, "plain");
    addStringConstantGlobal(ctx, "\ud800");
    addStringConstantGlobal(ctx, "plain");

    expect(module.imports).toEqual([]);
    expect(ctx.numImportGlobals).toBe(0);
    expect([...ctx.stringGlobalMap.entries()]).toEqual([
      ["plain", -1],
      ["\ud800", -1],
    ]);
    ctx.indexSpaceFrozen = true;
    expect(session.publish(module).abi.entries()).toEqual([]);
  });
});
