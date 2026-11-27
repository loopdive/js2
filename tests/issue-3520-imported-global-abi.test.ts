// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { addImport, addStringConstantGlobal } from "../src/codegen/registry/imports.js";
import { irGlobalBindingKey, irImportGlobalRef } from "../src/ir/abi-bindings.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { type GlobalDef, createEmptyModule } from "../src/ir/types.js";
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
    // Only the entry source is needed; `nativeStrings: false` is a compile
    // error on the JS target since #6979, so build the context natively.
    const { entrySource } = fixture(true);
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

  // The host `string_constants` import path is reached only with
  // `nativeStrings: false`, which #6979 (S7) removed from the JS target: the
  // context now refuses it. The native counterpart follows.
  it("refuses the host string_constants lane (nativeStrings: false, removed by #6979)", () => {
    expect(() => fixture(false)).toThrow(
      "Compile option nativeStrings: false selected the host-assisted semantic profile, which #6979 removed",
    );
  });

  it("keeps native string constants out of the import space across late/interleaved imports", () => {
    const { ctx, module, session } = fixture(true);
    const earlyFunc = addImport(ctx, "env", "early", { kind: "func", typeIdx: 0 });
    addStringConstantGlobal(ctx, "");
    addStringConstantGlobal(ctx, "plain");
    const definedGlobal: GlobalDef = {
      name: "__state",
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    };
    module.globals.push(definedGlobal);
    ctx.moduleGlobals.set("state", 0);
    const lateFunc = addImport(ctx, "env", "late", { kind: "func", typeIdx: 0 });
    addStringConstantGlobal(ctx, "\ud800");

    expect(module.imports).toEqual([earlyFunc, lateFunc]);
    expect(ctx.numImportFuncs).toBe(2);
    expect(ctx.numImportGlobals).toBe(0);
    expect(ctx.moduleGlobals.get("state")).toBe(0);
    expect([...ctx.stringGlobalMap.values()]).toEqual([-1, -1, -1]);
    ctx.indexSpaceFrozen = true;
    expect(session.publish(module).abi.entries()).toEqual([]);
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
