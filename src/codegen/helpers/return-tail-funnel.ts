// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6983) Funnel a void function's repeated `i32.const c; global.set G; return`
// exits into one shared exit block per (G, c).
//
// The generic object-runtime dispatchers are assembled from hundreds of arms
// that each end in the same status write plus `return` — prettier's
// `__extern_set` carries 4,793 of them in one 138k-line function. Binaryen's
// `code-folding` pass merges identical terminating tails by comparing every
// tail with every other one, level by level: on that function it alone ran
// 590 s, so `wasm-opt -O4` (600 s limit) timed out on every prettier/lodash
// regime and standalone build. Branching to a shared exit block instead
// produces the folded shape directly, and code-folding's block-tail handling
// is linear in the branch count.
//
// Ordinary functions repeat a tail a handful of times at most, stay below the
// threshold, and are emitted byte-identically.

import type { Instr, WasmModule } from "../../ir/types.js";

/** Below this many copies a tail is left in place (code-folding copes). */
const FUNNEL_MIN_TAILS = 64;

interface ExitTail {
  value: number;
  global: number;
}

const tailKey = (value: number, global: number): string => `${global}:${value}`;

function tailAt(list: Instr[], i: number): ExitTail | undefined {
  const c = list[i];
  const set = list[i + 1];
  if (c?.op !== "i32.const" || set?.op !== "global.set" || list[i + 2]?.op !== "return") return undefined;
  return { value: c.value, global: set.index };
}

function nestedLists(instr: Instr): Instr[][] {
  switch (instr.op) {
    case "block":
    case "loop":
    case "try_table":
      return [instr.body];
    case "if":
      return instr.else ? [instr.then, instr.else] : [instr.then];
    case "try":
      return [instr.body, ...instr.catches.map((clause) => clause.body), ...(instr.catchAll ? [instr.catchAll] : [])];
    default:
      return [];
  }
}

function countTails(list: Instr[], counts: Map<string, ExitTail & { count: number }>): void {
  for (let i = 0; i < list.length; i++) {
    const tail = tailAt(list, i);
    if (tail) {
      const key = tailKey(tail.value, tail.global);
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { ...tail, count: 1 });
      i += 2;
      continue;
    }
    for (const nested of nestedLists(list[i]!)) countTails(nested, counts);
  }
}

function isVoidFunction(mod: WasmModule, typeIdx: number): boolean {
  const def = mod.types[typeIdx];
  const fn = def?.kind === "func" ? def : def?.kind === "sub" && def.type.kind === "func" ? def.type : undefined;
  return fn !== undefined && fn.results.length === 0;
}

/**
 * Copy `list` (a body at `depth` labels inside the original function body)
 * replacing funnelled tails with branches to their exit block and shifting
 * every branch that leaves the original body past the `added` exit blocks.
 * Control instructions are copied, never mutated: instruction arrays may be
 * shared between owners, and a shared array can sit at different depths.
 */
function rewrite(list: Instr[], depth: number, slots: Map<string, number>, added: number): Instr[] {
  const out: Instr[] = [];
  const shift = (target: number): number => (target >= depth ? target + added : target);
  for (let i = 0; i < list.length; i++) {
    const tail = tailAt(list, i);
    const slot = tail ? slots.get(tailKey(tail.value, tail.global)) : undefined;
    if (slot !== undefined) {
      out.push({ op: "br", depth: depth + slot });
      i += 2;
      continue;
    }
    const instr = list[i]!;
    const inner = depth + 1;
    switch (instr.op) {
      case "br":
      case "br_if":
      case "rethrow":
        out.push({ ...instr, depth: shift(instr.depth) });
        break;
      case "br_table":
        out.push({
          ...instr,
          targets: instr.targets.map(shift),
          defaultDepth: shift(instr.defaultDepth),
        });
        break;
      case "block":
      case "loop":
        out.push({ ...instr, body: rewrite(instr.body, inner, slots, added) });
        break;
      case "if":
        out.push({
          ...instr,
          then: rewrite(instr.then, inner, slots, added),
          ...(instr.else ? { else: rewrite(instr.else, inner, slots, added) } : {}),
        });
        break;
      case "try":
        out.push({
          ...instr,
          body: rewrite(instr.body, inner, slots, added),
          catches: instr.catches.map((clause) => ({
            ...clause,
            body: rewrite(clause.body, inner, slots, added),
          })),
          ...(instr.catchAll ? { catchAll: rewrite(instr.catchAll, inner, slots, added) } : {}),
        });
        break;
      case "try_table":
        // A try_table's catch depths resolve in the scope ENCLOSING it (#5139).
        out.push({
          ...instr,
          catches: instr.catches.map((clause) => ({
            ...clause,
            depth: shift(clause.depth),
          })),
          body: rewrite(instr.body, inner, slots, added),
        });
        break;
      default:
        out.push(instr);
    }
  }
  return out;
}

/**
 * Rewrite every void function whose body repeats an exit tail at least
 * {@link FUNNEL_MIN_TAILS} times. Returns the number of tails funnelled.
 * Must run after every pass that edits bodies by position (stack balance,
 * fixups, tail-call promotion): it adds blocks around the whole body.
 */
export function funnelRepeatedReturnTails(mod: WasmModule): number {
  let funnelled = 0;
  for (const func of mod.functions) {
    if (!isVoidFunction(mod, func.typeIdx)) continue;
    const counts = new Map<string, ExitTail & { count: number }>();
    countTails(func.body, counts);
    const exits = [...counts.values()]
      .filter((entry) => entry.count >= FUNNEL_MIN_TAILS)
      .sort((a, b) => b.count - a.count || a.global - b.global || a.value - b.value);
    if (exits.length === 0) continue;
    // Exit block `j` (0 = innermost) sits `j` labels outside the original body.
    const slots = new Map(exits.map((exit, j) => [tailKey(exit.value, exit.global), j]));
    let body: Instr[] = [...rewrite(func.body, 0, slots, exits.length), { op: "return" }];
    for (const exit of exits) {
      body = [
        { op: "block", blockType: { kind: "empty" }, body },
        { op: "i32.const", value: exit.value },
        { op: "global.set", index: exit.global },
        { op: "return" },
      ];
      funnelled += exit.count;
    }
    func.body = body;
  }
  return funnelled;
}
