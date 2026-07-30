// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { generateModule } from "../src/codegen/index.js";
import { eliminateDeadLayoutAndPlanProgramAbi } from "../src/codegen/program-abi-finalization.js";
import {
  canonicalProgramAbiCallableTypeContract,
  canonicalProgramAbiValType,
} from "../src/codegen/program-abi-signatures.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import type { FuncTypeDef, WasmFunction } from "../src/ir/types.js";
import { createEmptyModule } from "../src/ir/types.js";
import { absoluteFuncIndex } from "../src/emit/resolve-layout.js";
import { ts } from "../src/ts-api.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

function fixture() {
  const sourceFile = ts.createSourceFile(
    "/repo/callable-exports.ts",
    "export function main() {}",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  const module = createEmptyModule();
  const typeIdx = module.types.push({ kind: "func", name: "$f", params: [], results: [] }) - 1;
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, {} as ts.TypeChecker, {}, session);
  return { ctx, module, session, typeIdx };
}

function definedFunction(name: string, typeIdx: number): WasmFunction {
  return { name, typeIdx, locals: [], body: [], exported: true };
}

describe("#3520 complete production callable and value-export population", () => {
  it("publishes every final function once and aliases every callable/global export", () => {
    const source = `
      export let state = 3;
      export function run(value: number): number {
        return state + value;
      }
      export { run as execute };
      export default run;
    `;
    const ast = analyzeSource(source, "callable-exports.ts");
    const result = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
      nativeStrings: true,
    });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const importedFunctions = result.module.imports.filter((value) => value.desc.kind === "func");
    const finalFunctions = [
      ...importedFunctions.map((value) => result.module.types[value.desc.kind === "func" ? value.desc.typeIdx : -1]),
      ...result.module.functions.map((value) => result.module.types[value.typeIdx]),
    ] as FuncTypeDef[];
    expect(finalFunctions.every((signature) => signature?.kind === "func")).toBe(true);

    const callableEntries = result
      .programAbi!.abi.entries()
      .filter(
        (entry) =>
          entry.slotPolicy === "required" && entry.slotSpace === "function" && entry.intent.kind === "callable",
      );
    expect(callableEntries).toHaveLength(finalFunctions.length);
    const callableIndices = callableEntries.map((entry) => {
      const finalIndex = result.programAbi!.abi.resolveFinalIndex(entry.id);
      if (!finalIndex || finalIndex.space !== "function") {
        throw new Error(`missing final function slot for ${entry.id}`);
      }
      const signature = finalFunctions[finalIndex.index]!;
      expect(entry.intent).toMatchObject({
        kind: "callable",
        signature: canonicalProgramAbiCallableTypeContract(signature),
      });
      return finalIndex.index;
    });
    expect([...callableIndices].sort((left, right) => left - right)).toEqual(finalFunctions.map((_, index) => index));

    const valueExports = result.module.exports.filter(
      (entry) => entry.desc.kind === "func" || entry.desc.kind === "global",
    );
    const exportEntries = result.programAbi!.abi.entries().filter((entry) => entry.intent.kind === "export");
    expect(exportEntries).toHaveLength(valueExports.length);
    for (const valueExport of valueExports) {
      const entry = exportEntries.find(
        (candidate) => candidate.intent.kind === "export" && candidate.intent.externalName === valueExport.name,
      );
      expect(entry).toBeDefined();
      const expectedSpace = valueExport.desc.kind === "func" ? "function" : "global";
      const expectedIndex =
        valueExport.desc.kind === "func"
          ? absoluteFuncIndex(result.module, valueExport.desc.index)
          : valueExport.desc.index;
      expect(result.programAbi!.abi.resolveFinalIndex(entry!.id)).toEqual({
        space: expectedSpace,
        index: expectedIndex,
      });
      expect(result.programAbi!.legacy.resolveFinalIndex("export", valueExport.name)).toEqual({
        space: expectedSpace,
        index: expectedIndex,
      });
    }

    const publicNames = new Set(exportEntries.map((entry) => entry.intent.externalName));
    for (const name of ["run", "execute", "default"]) expect(publicNames.has(name)).toBe(true);
    const callablePublicTargets = exportEntries
      .filter(
        (entry) =>
          entry.intent.kind === "export" &&
          (entry.intent.externalName === "run" ||
            entry.intent.externalName === "execute" ||
            entry.intent.externalName === "default"),
      )
      .map((entry) => (entry.intent.kind === "export" ? entry.intent.targetId : undefined));
    expect(new Set(callablePublicTargets).size).toBe(1);
  });

  it("keeps same-named defined functions distinct while their exports resolve exact targets", () => {
    const { ctx, module, session, typeIdx } = fixture();
    const first = definedFunction("same", typeIdx);
    const second = definedFunction("same", typeIdx);
    module.functions.push(first, second);
    module.globals.push({
      name: "state",
      type: { kind: "f64" },
      mutable: true,
      init: [{ op: "f64.const", value: 3 }],
    });
    module.exports.push(
      { name: "left", desc: { kind: "func", index: 0 } },
      { name: "right", desc: { kind: "func", index: 1 } },
      { name: "state", desc: { kind: "global", index: 0 } },
    );

    eliminateDeadLayoutAndPlanProgramAbi(ctx);
    ctx.indexSpaceFrozen = true;
    const publication = session.publish(module);
    const callableEntries = publication.abi
      .entries()
      .filter((entry) => entry.intent.kind === "callable" && entry.slotPolicy === "required");
    expect(callableEntries).toHaveLength(2);
    expect(new Set(callableEntries.map((entry) => entry.id)).size).toBe(2);
    expect(() => publication.legacy.resolveUniqueLegacyName("function", "same")).toThrow(
      /matches 2 canonical structural owners/,
    );
    expect(publication.legacy.resolveFinalIndex("export", "left")).toEqual({ space: "function", index: 0 });
    expect(publication.legacy.resolveFinalIndex("export", "right")).toEqual({ space: "function", index: 1 });
    expect(publication.legacy.resolveFinalIndex("export", "state")).toEqual({ space: "global", index: 0 });
    const stateExport = publication.abi
      .entries()
      .find((entry) => entry.intent.kind === "export" && entry.intent.externalName === "state");
    if (!stateExport || stateExport.intent.kind !== "export") throw new Error("missing state export");
    expect(publication.abi.get(stateExport.intent.targetId)?.intent).toMatchObject({
      kind: "global",
      valueType: canonicalProgramAbiValType({ kind: "f64" }),
      mutable: true,
    });
  });

  it("resolves a stable function export handle through final layout ownership", () => {
    const { ctx, module, session, typeIdx } = fixture();
    const func = definedFunction("stable", typeIdx);
    const handle = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, handle, func);
    module.exports.push({ name: "stable", desc: { kind: "func", index: handle } });

    eliminateDeadLayoutAndPlanProgramAbi(ctx);
    ctx.indexSpaceFrozen = true;
    const publication = session.publish(module);
    const exported = publication.abi
      .entries()
      .find((entry) => entry.intent.kind === "export" && entry.intent.externalName === "stable");
    if (!exported || exported.intent.kind !== "export") throw new Error("missing stable export");

    expect(module.exports[0]?.desc).toEqual({ kind: "func", index: handle });
    expect(publication.abi.resolveFinalIndex(exported.id)).toEqual({ space: "function", index: 0 });
    expect(publication.abi.canonicalId(exported.id)).toBe(session.locatorBindingId(func));
    expect(publication.legacy.resolveFinalIndex("export", "stable")).toEqual({ space: "function", index: 0 });
  });

  it("rejects duplicate external names across value and backend-layout exports", () => {
    const { ctx, module, typeIdx } = fixture();
    module.functions.push(definedFunction("run", typeIdx));
    module.exports.push(
      { name: "duplicate", desc: { kind: "func", index: 0 } },
      { name: "duplicate", desc: { kind: "memory", index: 0 } },
    );

    expect(() => eliminateDeadLayoutAndPlanProgramAbi(ctx)).toThrow(/share external name duplicate/);
  });

  it("rejects an export whose settled index has no allocator target", () => {
    const { ctx, module } = fixture();
    module.exports.push({ name: "missing", desc: { kind: "func", index: 99 } });

    expect(() => eliminateDeadLayoutAndPlanProgramAbi(ctx)).toThrow(/references missing func index 99/);
  });
});
