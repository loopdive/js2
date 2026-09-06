// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5339) Rewrite the `return`s of an INLINED IIFE into branches to the IIFE's
 * own exit block.
 *
 * An inlined IIFE has no Wasm function of its own, so a Wasm `return` left in
 * its body returns from the ENCLOSING function. `compileTailDispatch` wraps the
 * inlined body in a `block` and calls this walker to redirect every `return` to
 * that block's label instead.
 *
 * ## Why this is a module and not two loops at the call site
 * It used to be two near-identical nested functions — one for a value-returning
 * IIFE, one for a void IIFE. They drifted: the void copy learned to walk a
 * legacy `try`'s `catches[].body` and `catchAll`, the value copy never did. A
 * `return` inside a catch clause therefore stayed a function-level `return`,
 * which is either a silent wrong value (when the IIFE's and the caller's return
 * types agree) or an invalid module (when they do not — hono's
 * `getColorEnabledAsync` produced "type error in return[0] (expected i32, got
 * externref)" and took its whole test file to 0/8). One walker parameterised by
 * `retLocal` cannot drift that way again.
 *
 * ## Label depths
 * `depth` is measured from the wrapper `block`: `depth === 0` at the body's top
 * level. Every structured instruction adds one label, so each nested arm
 * recurses at `depth + 1`. A legacy `try` has ONE label shared by its `do`
 * section, its tagged `catch` clauses and its `catch_all` — so all three arms
 * recurse at the same `depth + 1`.
 *
 * `try_table` needs no special case: `buildStandardTryTable` materialises its
 * handlers as nested `block`s, which the generic `body` recursion already
 * reaches, and a `TryTableCatch` carries a label depth rather than a body.
 */
import type { Instr } from "../../ir/types.js";

/** The structured arms this walker has to look inside. */
type StructuredArms = {
  op: string;
  then?: Instr[];
  else?: Instr[];
  body?: Instr[];
  catchAll?: Instr[];
  catches?: Array<{ body?: Instr[] }>;
};

/**
 * @param instrs   the inlined body, as emitted into the wrapper block
 * @param depth    label distance to the wrapper block from `instrs`' level
 * @param retLocal local to capture the returned value in, or `null` for a void
 *                 IIFE (whose `return <expr>` already dropped its value)
 */
export function patchInlinedIifeReturns(instrs: Instr[], depth: number, retLocal: number | null): void {
  for (let i = 0; i < instrs.length; i++) {
    const op = instrs[i]!.op;
    if (op === "return") {
      // The preceding instruction left the return value on the stack (or, for
      // a void IIFE, left nothing there).
      if (retLocal === null) {
        instrs[i] = { op: "br", depth };
      } else {
        instrs[i] = { op: "local.set", index: retLocal };
        instrs.splice(i + 1, 0, { op: "br", depth });
        i++; // skip the inserted br
      }
    } else if (op === "return_call" || op === "return_call_ref") {
      // Undo the tail call `compileReturnStatement` may have merged in: inside
      // an IIFE the result has to come back to this frame.
      const instr = instrs[i] as { op: string };
      instr.op = op === "return_call" ? "call" : "call_ref";
      const tail: Instr[] =
        retLocal === null
          ? [{ op: "br", depth }]
          : [
              { op: "local.set", index: retLocal },
              { op: "br", depth },
            ];
      instrs.splice(i + 1, 0, ...tail);
      i += tail.length; // skip the inserted instructions
    }
    const instr = instrs[i] as unknown as StructuredArms;
    if (instr.then) patchInlinedIifeReturns(instr.then, depth + 1, retLocal);
    if (instr.else) patchInlinedIifeReturns(instr.else, depth + 1, retLocal);
    if (Array.isArray(instr.body)) patchInlinedIifeReturns(instr.body, depth + 1, retLocal);
    if (Array.isArray(instr.catchAll)) patchInlinedIifeReturns(instr.catchAll, depth + 1, retLocal);
    if (Array.isArray(instr.catches)) {
      for (const clause of instr.catches) {
        if (Array.isArray(clause.body)) patchInlinedIifeReturns(clause.body, depth + 1, retLocal);
      }
    }
  }
}
