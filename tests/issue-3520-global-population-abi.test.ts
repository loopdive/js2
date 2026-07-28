// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { generateModule } from "../src/codegen/index.js";
import { planProgramAbiStringConstantImport } from "../src/codegen/program-abi-import-planning.js";
import { canonicalProgramAbiValType } from "../src/codegen/program-abi-signatures.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { addImport } from "../src/codegen/registry/imports.js";
import { irImportGlobalRef } from "../src/ir/abi-bindings.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { createEmptyModule } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

function fixture() {
  const sourceFile = ts.createSourceFile(
    "/repo/global-population.ts",
    "export function main() {}",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  const module = createEmptyModule();
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, {} as ts.TypeChecker, {}, session);
  return { ctx, inventory, module, session };
}

describe("#3520 complete production Program ABI global population", () => {
  it("publishes every final imported and defined global exactly once", () => {
    const source = `
      let state = 1;
      class Box {
        value: number = 2;
        read(): number { return this.value; }
      }
      export function main(): number {
        const property = "value";
        return state + new Box().read() + property.length;
      }
    `;
    const ast = analyzeSource(source, "global-population.ts");
    const result = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
      nativeStrings: false,
    });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const importedGlobals = result.module.imports.filter(
      (value): value is typeof value & { desc: Extract<typeof value.desc, { kind: "global" }> } =>
        value.desc.kind === "global",
    );
    const finalGlobals = [
      ...importedGlobals.map((value) => ({ type: value.desc.type, mutable: value.desc.mutable })),
      ...result.module.globals.map((value) => ({ type: value.type, mutable: value.mutable })),
    ];
    const globalEntries = result
      .programAbi!.abi.entries()
      .filter(
        (entry) => entry.slotPolicy === "required" && entry.slotSpace === "global" && entry.intent.kind === "global",
      );
    expect(globalEntries).toHaveLength(finalGlobals.length);

    const finalIndices = globalEntries.map((entry) => {
      const finalIndex = result.programAbi!.abi.resolveFinalIndex(entry.id);
      expect(finalIndex).toEqual(expect.objectContaining({ space: "global" }));
      if (!finalIndex || finalIndex.space !== "global") {
        throw new Error(`missing final global slot for ${entry.id}`);
      }
      const global = finalGlobals[finalIndex.index];
      if (!global) throw new Error(`missing final global object ${finalIndex.index}`);
      expect(entry.intent).toMatchObject({
        kind: "global",
        valueType: canonicalProgramAbiValType(global.type),
        mutable: global.mutable,
      });
      return finalIndex.index;
    });
    expect([...finalIndices].sort((left, right) => left - right)).toEqual(finalGlobals.map((_, index) => index));
    expect(
      globalEntries.filter((entry) => entry.intent.kind === "global" && entry.intent.origin === "import"),
    ).toHaveLength(importedGlobals.length);
    expect(globalEntries.some((entry) => entry.intent.kind === "global" && entry.intent.origin === "source")).toBe(
      true,
    );
    expect(globalEntries.some((entry) => entry.intent.kind === "global" && entry.intent.origin === "support")).toBe(
      true,
    );
  });

  it("keeps duplicate import spellings as distinct allocator-owned slots", () => {
    const { ctx, module, session } = fixture();
    const first = addImport(ctx, "host", "same", {
      kind: "global",
      type: { kind: "externref" },
      mutable: false,
    });
    const second = addImport(ctx, "host", "same", {
      kind: "global",
      type: { kind: "externref" },
      mutable: false,
    });
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);

    ctx.programAbiGlobals!.planRetained();
    ctx.indexSpaceFrozen = true;
    const publication = session.publish(module);
    const entries = publication.abi
      .entries()
      .filter((entry) => entry.intent.kind === "global" && entry.intent.origin === "import");
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    expect(
      entries
        .map((entry) => publication.abi.resolveFinalIndex(entry.id)?.index)
        .sort((left, right) => (left ?? -1) - (right ?? -1)),
    ).toEqual([0, 1]);
    expect(() => publication.legacy.resolveUniqueLegacyName("global", "same")).toThrow(
      /matches 2 canonical structural owners/,
    );
  });

  it("rejects one allocator object occupying two final global slots", () => {
    const { ctx, module } = fixture();
    const shared = {
      module: "host",
      name: "shared",
      desc: {
        kind: "global" as const,
        type: { kind: "externref" as const },
        mutable: false,
      },
    };
    module.imports.push(shared, shared);
    ctx.numImportGlobals = 2;

    expect(() => ctx.programAbiGlobals!.planRetained()).toThrow(/allocator object appears more than once/);
  });

  it("keeps a generic duplicate distinct from a semantically planned import at the same ordinal", () => {
    const { ctx, inventory, module, session } = fixture();
    const first = addImport(ctx, "string_constants", "same", {
      kind: "global",
      type: { kind: "externref" },
      mutable: false,
    });
    const semantic = addImport(ctx, "string_constants", "same", {
      kind: "global",
      type: { kind: "externref" },
      mutable: false,
    });
    expect(first).toBeDefined();
    expect(semantic).toBeDefined();
    planProgramAbiStringConstantImport(ctx, semantic!, 0);

    ctx.programAbiGlobals!.planRetained();
    ctx.indexSpaceFrozen = true;
    const publication = session.publish(module);
    const entries = publication.abi
      .entries()
      .filter((entry) => entry.intent.kind === "global" && entry.intent.origin === "import");
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    const entrySource = inventory.sources.find((source) => source.kind === "entry");
    if (!entrySource) throw new Error("missing entry source");
    const semanticRef = irImportGlobalRef(entrySource.id, "string_constants", "same", "__str_0", 0);
    expect(session.hasLocator(semanticRef.binding.bindingId, semantic!)).toBe(true);
    expect(publication.abi.resolveFinalIndex(semanticRef.binding.bindingId)).toEqual({ space: "global", index: 1 });
  });
});
