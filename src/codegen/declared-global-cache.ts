// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Cache ambient host-global resolver calls in module globals (#4150).
 *
 * `collectDeclaredGlobals` imports an ambient value such as `document` as
 * `env.global_document: () -> externref`. The runtime resolves that value when
 * it builds the import object and the resulting closure is constant for the
 * lifetime of the instance. Calling the closure again therefore adds a host
 * boundary without observing new state; DOM loops paid that boundary once per
 * ambient-identifier read.
 *
 * Keep the public import ABI and lazily snapshot its result on first use. A
 * separate ready bit is required because both `null` and `undefined` are valid
 * externref results. The bit is written only after the import returns, so an
 * exception leaves the cache uninitialized and a later read retries exactly
 * as an uncached read would.
 *
 * This pass runs after all import globals have settled and before dead import
 * elimination. Rewriting the final Wasm instruction tree makes the behavior
 * identical for legacy- and IR-owned functions.
 */

import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { nextModuleGlobalIdx } from "./registry/imports.js";
import { walkChildren } from "./walk-instructions.js";

interface CacheSlot {
  readonly valueGlobalIdx: number;
  readonly readyGlobalIdx: number;
}

/** Every distinct instruction array in the module, including nested arms. */
function instructionArrays(bodies: readonly Instr[][]): Instr[][] {
  const arrays: Instr[][] = [];
  const seen = new WeakSet<Instr[]>();
  const pending = [...bodies];
  while (pending.length > 0) {
    const array = pending.pop()!;
    if (seen.has(array)) continue;
    seen.add(array);
    arrays.push(array);
    for (const instr of array) walkChildren(instr, (child) => pending.push(child));
  }
  return arrays;
}

/** Map live `declaredGlobals` entries to their exact env function imports. */
function declaredGlobalImports(ctx: CodegenContext): Map<number, string> {
  const importsByFuncIdx = new Map<number, (typeof ctx.mod.imports)[number]>();
  let funcIdx = 0;
  for (const entry of ctx.mod.imports) {
    if (entry.desc.kind !== "func") continue;
    importsByFuncIdx.set(funcIdx++, entry);
  }

  const globals = new Map<number, string>();
  for (const [name, info] of ctx.declaredGlobals) {
    const entry = importsByFuncIdx.get(info.funcIdx);
    if (entry?.module === "env" && entry.name === `global_${name}`) {
      globals.set(info.funcIdx, name);
    }
  }
  return globals;
}

/**
 * Replace each `call global_<name>` with a lazy module-global read.
 *
 * The original call remains in the cache-miss arm, which keeps the import live
 * through DCE and lets the ordinary function-index remapper update it.
 */
export function cacheDeclaredGlobalReads(ctx: CodegenContext): void {
  const targets = declaredGlobalImports(ctx);
  if (targets.size === 0) return;

  const slots = new Map<number, CacheSlot>();
  const slotFor = (funcIdx: number, name: string): CacheSlot => {
    const existing = slots.get(funcIdx);
    if (existing) return existing;
    const valueGlobalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__declared_global_${name}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    const readyGlobalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__declared_global_${name}_ready`,
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
    const slot = { valueGlobalIdx, readyGlobalIdx };
    slots.set(funcIdx, slot);
    return slot;
  };

  // Collect the complete original tree before rewriting so newly-created miss
  // arms cannot be revisited when instruction arrays are shared across bodies.
  const arrays = instructionArrays(ctx.mod.functions.map((fn) => fn.body));
  for (const array of arrays) {
    const rewritten: Instr[] = [];
    for (const instr of array) {
      if (instr.op !== "call" && instr.op !== "return_call") {
        rewritten.push(instr);
        continue;
      }
      const name = targets.get(instr.funcIdx);
      if (name === undefined) {
        rewritten.push(instr);
        continue;
      }
      const { valueGlobalIdx, readyGlobalIdx } = slotFor(instr.funcIdx, name);
      const wasTailCall = instr.op === "return_call";
      const resolverCall: Instr = { ...instr, op: "call" };
      rewritten.push(
        { op: "global.get", index: readyGlobalIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [{ op: "global.get", index: valueGlobalIdx }],
          else: [
            resolverCall,
            { op: "global.set", index: valueGlobalIdx },
            { op: "i32.const", value: 1 },
            { op: "global.set", index: readyGlobalIdx },
            { op: "global.get", index: valueGlobalIdx },
          ],
        },
      );
      if (wasTailCall) rewritten.push({ op: "return" });
    }
    array.splice(0, array.length, ...rewritten);
  }
}
