// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared utility for recursively walking Wasm instruction trees.
 *
 * Many passes need to visit every instruction in a body, recursing into
 * block/loop/if/try sub-bodies. This module provides a single implementation
 * so callers don't each duplicate the recursion logic.
 */
import type { Instr, WasmModule } from "../ir/types.js";

/**
 * Walk all instructions in `instrs`, calling `visitor` on each one.
 * Automatically descends into nested blocks: body, then, else, catches, catchAll.
 *
 * Implemented iteratively with an explicit frame stack so the JS call stack
 * depth is O(1) regardless of Wasm block nesting. This matters because the
 * walker runs synchronously inside already-deep codegen frames (via
 * flushLateImportShifts → shiftLateImportIndices), and recursive composition
 * with the compile stack tripped V8 stack limits under tight CI cgroup
 * budgets. Pre-order semantics preserved: visit(instr) fires before recursion
 * into its children, and siblings are visited in source order.
 */
export function walkInstructions(instrs: Instr[], visitor: (instr: Instr) => void): void {
  const stack: { arr: Instr[]; i: number }[] = [{ arr: instrs, i: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.i >= top.arr.length) {
      stack.pop();
      continue;
    }
    const instr = top.arr[top.i++]!;
    visitor(instr);
    const children: Instr[][] = [];
    walkChildren(instr, (c) => children.push(c));
    for (let j = children.length - 1; j >= 0; j--) {
      stack.push({ arr: children[j]!, i: 0 });
    }
  }
}

/** Struct types that have a concrete allocation site in the completed module. */
export function allocatedStructTypeIndices(mod: WasmModule): ReadonlySet<number> {
  const out = new Set<number>();
  for (const body of [...mod.functions.map((fn) => fn.body), ...mod.globals.map((global) => global.init)])
    walkInstructions(body, (instr) => {
      if (instr.op === "struct.new" && typeof instr.typeIdx === "number") out.add(instr.typeIdx);
    });
  return out;
}

/**
 * Invoke `fn` on every nested instruction array (body, then, else, catches, catchAll)
 * found on a single instruction. Does NOT recurse -- the caller is responsible for
 * driving recursion (e.g. by calling walkChildren again inside fn).
 */
export function walkChildren(instr: Instr, fn: (children: Instr[]) => void): void {
  const a = instr as any;
  if (a.body && Array.isArray(a.body)) fn(a.body);
  if (a.then && Array.isArray(a.then)) fn(a.then);
  if (a.else && Array.isArray(a.else)) fn(a.else);
  if (a.catches && Array.isArray(a.catches)) {
    for (const c of a.catches) {
      if (Array.isArray(c.body)) fn(c.body);
    }
  }
  if (a.catchAll && Array.isArray(a.catchAll)) fn(a.catchAll);
}
