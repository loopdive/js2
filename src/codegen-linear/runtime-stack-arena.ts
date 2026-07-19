// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { LINEAR_STACK_ARENA_BYTES } from "../ir/analysis/linear-memory-plan.js";
import type { WasmModule } from "../ir/types.js";

/**
 * Add the function-scoped stack-region adapter used by
 * `analysis-stack-arena-v1`. One fixed backing block is lazily reserved from
 * the ordinary arena; nested functions save/restore the region pointer.
 */
export function addLinearStackArenaRuntime(mod: WasmModule): void {
  if (mod.functions.some((func) => func.name === "__linear_stack_mark")) return;

  const mallocIdx = findFuncIndex(mod, "__malloc");
  const baseGlobalIdx = mod.globals.length;
  mod.globals.push({
    name: "__linear_stack_base",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  const pointerGlobalIdx = mod.globals.length;
  mod.globals.push({
    name: "__linear_stack_ptr",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });

  const markTypeIdx = mod.types.length;
  mod.types.push({ kind: "func", name: "$type___linear_stack_mark", params: [], results: [{ kind: "i32" }] });
  mod.functions.push({
    name: "__linear_stack_mark",
    typeIdx: markTypeIdx,
    locals: [{ name: "__linear_stack_new_base", type: { kind: "i32" } }],
    body: [
      { op: "global.get", index: pointerGlobalIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: LINEAR_STACK_ARENA_BYTES },
          { op: "call", funcIdx: mallocIdx },
          { op: "local.tee", index: 0 },
          { op: "global.set", index: baseGlobalIdx },
          { op: "local.get", index: 0 },
          { op: "global.set", index: pointerGlobalIdx },
        ],
        else: [],
      },
      { op: "global.get", index: pointerGlobalIdx },
    ],
    exported: false,
  });

  const allocTypeIdx = mod.types.length;
  mod.types.push({
    kind: "func",
    name: "$type___linear_stack_alloc",
    params: [{ kind: "i32" }],
    results: [{ kind: "i32" }],
  });
  mod.functions.push({
    name: "__linear_stack_alloc",
    typeIdx: allocTypeIdx,
    locals: [
      { name: "__linear_stack_ret", type: { kind: "i32" } },
      { name: "__linear_stack_next", type: { kind: "i32" } },
    ],
    body: [
      { op: "global.get", index: pointerGlobalIdx },
      { op: "local.tee", index: 1 },
      { op: "local.get", index: 0 },
      { op: "i32.add" },
      { op: "i32.const", value: 7 },
      { op: "i32.add" },
      { op: "i32.const", value: -8 },
      { op: "i32.and" },
      { op: "local.tee", index: 2 },
      { op: "global.get", index: baseGlobalIdx },
      { op: "i32.const", value: LINEAR_STACK_ARENA_BYTES },
      { op: "i32.add" },
      { op: "i32.gt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: mallocIdx }, { op: "return" }],
        else: [],
      },
      { op: "local.get", index: 2 },
      { op: "global.set", index: pointerGlobalIdx },
      { op: "local.get", index: 1 },
    ],
    exported: false,
  });

  const restoreTypeIdx = mod.types.length;
  mod.types.push({
    kind: "func",
    name: "$type___linear_stack_restore",
    params: [{ kind: "i32" }],
    results: [],
  });
  mod.functions.push({
    name: "__linear_stack_restore",
    typeIdx: restoreTypeIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "global.set", index: pointerGlobalIdx },
    ],
    exported: false,
  });
}

function findFuncIndex(mod: WasmModule, name: string): number {
  const importedFunctions = mod.imports.filter((item) => item.desc.kind === "func").length;
  const localIndex = mod.functions.findIndex((func) => func.name === name);
  if (localIndex >= 0) return importedFunctions + localIndex;
  throw new Error(`Runtime function not found: ${name}`);
}
