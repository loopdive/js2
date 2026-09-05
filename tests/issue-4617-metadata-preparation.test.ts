// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import {
  fnMetaSlotOfMeta,
  materializePreparedFnMetaSlot,
  prepareFnMetaSlotOfMeta,
} from "../src/codegen/function-instance-meta.js";
import { nativeStringLiteralInstrs } from "../src/codegen/native-string-literals.js";
import { addHostStringConstantGlobal } from "../src/codegen/registry/imports.js";
import { type GlobalDef, createEmptyModule } from "../src/ir/types.js";

const META = { name: "prepared metadata", length: 2 };

function fixture(
  options: Parameters<typeof createCodegenContext>[2] = { standalone: true, strictNoHostImports: false },
) {
  const ast = analyzeSource("export const value = 0;", "/repo/issue-4617-metadata-preparation.ts");
  const module = createEmptyModule();
  const ctx = createCodegenContext(module, ast.checker, options);
  return { ctx, module };
}

function addLateHostStringGlobal(ctx: ReturnType<typeof fixture>["ctx"]): number {
  const importsBefore = ctx.mod.imports.length;
  const globalsBefore = ctx.numImportGlobals;
  const globalIdx = addHostStringConstantGlobal(ctx, "late host global");
  expect(globalIdx).toBe(globalsBefore);
  expect(ctx.mod.imports).toHaveLength(importsBefore + 1);
  expect(ctx.numImportGlobals).toBe(globalsBefore + 1);
  expect(ctx.mod.imports.at(-1)).toMatchObject({
    module: "string_constants",
    name: "late host global",
    desc: { kind: "global", type: { kind: "externref" } },
  });
  return globalIdx!;
}

describe("#4617 prepared function metadata slots", () => {
  it("prepares only its retained global and type before standalone materialization", () => {
    const { ctx, module } = fixture();
    const typesBefore = module.types.length;
    const globalsBefore = module.globals.length;
    const prepared = prepareFnMetaSlotOfMeta(ctx, META);

    expect(module.types).toHaveLength(typesBefore + 1);
    expect(module.globals).toHaveLength(globalsBefore + 1);
    expect(module.globals.at(-1)).toBe(prepared.global);
    expect(ctx.nativeStrLiteralGlobals).toEqual(new Map());

    const materialized = materializePreparedFnMetaSlot(ctx, prepared);
    const globalIdx = ctx.fnInstanceMetaGlobalByKey!.get(prepared.key);
    if (globalIdx === undefined) throw new Error("missing prepared metadata global");
    expect(globalIdx).toBe(ctx.numImportGlobals + module.globals.indexOf(prepared.global));
    expect(module.globals[globalIdx - ctx.numImportGlobals]).toBe(prepared.global);
    expect(materialized.field).toEqual(prepared.field);
    expect(materialized.meta).toEqual(META);
    expect(materialized.init[0]).toEqual({ op: "global.get", index: globalIdx });
    expect(materialized.init.at(-1)).toEqual({ op: "global.get", index: globalIdx });
    const initialize = materialized.init[2];
    if (!initialize || initialize.op !== "if") throw new Error("missing metadata initializer");
    const nameGlobalIdx = [...ctx.nativeStrLiteralGlobals.values()][0];
    if (nameGlobalIdx === undefined) throw new Error("missing metadata name literal");
    expect(initialize.then[0]).toEqual({ op: "global.get", index: nameGlobalIdx });
    expect(initialize.then.at(-1)).toEqual({ op: "global.set", index: globalIdx });
  });

  it("materializes prepared metadata against its retained slot after a real host global fixup", () => {
    const { ctx, module } = fixture({ standalone: false, nativeStrings: true, strictNoHostImports: false });
    const prepared = prepareFnMetaSlotOfMeta(ctx, META);
    const originalIdx = ctx.fnInstanceMetaGlobalByKey!.get(prepared.key);
    if (originalIdx === undefined) throw new Error("missing prepared metadata global");

    addLateHostStringGlobal(ctx);
    const shiftedIdx = ctx.fnInstanceMetaGlobalByKey!.get(prepared.key);
    expect(shiftedIdx).toBe(originalIdx + 1);
    expect(module.globals[shiftedIdx! - ctx.numImportGlobals]).toBe(prepared.global);
    const materialized = materializePreparedFnMetaSlot(ctx, prepared);
    expect(materialized.init[0]).toEqual({ op: "global.get", index: shiftedIdx });
    expect(materialized.init.at(-1)).toEqual({ op: "global.get", index: shiftedIdx });
  });

  it("keeps a materialized native name bound to its same global after a real host global fixup", () => {
    const { ctx, module } = fixture({ standalone: false, nativeStrings: true, strictNoHostImports: false });
    const prepared = prepareFnMetaSlotOfMeta(ctx, META);
    materializePreparedFnMetaSlot(ctx, prepared);
    const [nativeKey, nativeIdx] = [...ctx.nativeStrLiteralGlobals.entries()][0] ?? [];
    if (nativeKey === undefined || nativeIdx === undefined) throw new Error("missing native name literal");
    const nativeGlobal = module.globals[nativeIdx - ctx.numImportGlobals];

    addLateHostStringGlobal(ctx);
    const shiftedNativeIdx = ctx.nativeStrLiteralGlobals.get(nativeKey);
    expect(shiftedNativeIdx).toBe(nativeIdx + 1);
    expect(module.globals[shiftedNativeIdx! - ctx.numImportGlobals]).toBe(nativeGlobal);
    const globalsBeforeReuse = module.globals.length;
    expect(nativeStringLiteralInstrs(ctx, META.name)).toEqual([{ op: "global.get", index: shiftedNativeIdx }]);
    expect(module.globals).toHaveLength(globalsBeforeReuse);
  });

  it("rejects a structural clone that replaces its retained metadata global", () => {
    const { ctx, module } = fixture();
    const prepared = prepareFnMetaSlotOfMeta(ctx, META);
    const clone: GlobalDef = {
      ...prepared.global,
      type: { ...prepared.global.type },
      init: [...prepared.global.init],
    };
    module.globals[module.globals.indexOf(prepared.global)] = clone;

    expect(() => materializePreparedFnMetaSlot(ctx, prepared)).toThrow(/no longer current/);
  });

  it("keeps the immediate helper's type, global, and initializer sequence canonical", () => {
    const immediate = fixture();
    const split = fixture();
    const direct = fnMetaSlotOfMeta(immediate.ctx, META);
    const prepared = prepareFnMetaSlotOfMeta(split.ctx, META);
    const materialized = materializePreparedFnMetaSlot(split.ctx, prepared);

    expect(split.module.types).toEqual(immediate.module.types);
    expect(split.module.globals).toEqual(immediate.module.globals);
    expect(materialized).toEqual(direct);
  });
});
