// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1916 — resolve symbolic function references to concrete indices.
 *
 * Runs exactly once per module, at the top of each emitter (binary / WAT /
 * object), when the import list is final. Derives the authoritative
 * name→index layout from the module alone — func imports in declaration
 * order occupy `[0, numImportFuncs)`, defined functions follow at
 * `numImportFuncs + arrayPos` — and rewrites every object-valued
 * `funcIdx` (see `FuncRef` in types.ts) to its number, in place.
 *
 * Unknown names and duplicate names are hard errors: a mis-resolved ref is
 * exactly the silent-corruption class (#618/#1109/#1384/#1666/#1677) this
 * design retires, so resolution failures must be loud. Idempotent — a
 * module with no symbolic refs (or one already resolved) passes through
 * untouched.
 */
import type { Instr, WasmModule } from "./types.js";
import { isFuncRef } from "./types.js";

/** Build the final function-name → absolute-index layout for a module. */
export function buildFuncIndexLayout(mod: WasmModule): Map<string, number> {
  const layout = new Map<string, number>();
  const claim = (name: string, idx: number, what: string): void => {
    if (layout.has(name)) {
      throw new Error(
        `Codegen error: duplicate function name '${name}' (${what} at index ${idx} vs ` +
          `index ${layout.get(name)}) — symbolic function refs (#1916) require the ` +
          `funcMap name namespace to be unique.`,
      );
    }
    layout.set(name, idx);
  };
  let idx = 0;
  for (const imp of mod.imports) {
    if (imp.desc.kind === "func") {
      claim(imp.name, idx, "import");
      idx++;
    }
  }
  for (const fn of mod.functions) {
    claim(fn.name, idx, "defined function");
    idx++;
  }
  return layout;
}

/**
 * Rewrite all symbolic `funcIdx` refs in the module to concrete indices.
 * Walks function bodies and global initializers iteratively (same
 * stack-safety reasoning as walkInstructions, #1087).
 */
export function resolveFuncRefsInModule(mod: WasmModule): void {
  let layout: Map<string, number> | null = null; // built lazily — most modules have no refs yet

  const resolve = (instr: Instr): void => {
    const a = instr as { op: string; funcIdx?: unknown };
    if (
      (a.op === "call" || a.op === "return_call" || a.op === "ref.func") &&
      a.funcIdx !== undefined &&
      isFuncRef(a.funcIdx as never)
    ) {
      const ref = a.funcIdx as { name: string };
      if (layout === null) layout = buildFuncIndexLayout(mod);
      const idx = layout.get(ref.name);
      if (idx === undefined) {
        throw new Error(
          `Codegen error: unresolved function reference '${ref.name}' — the name is ` +
            `not an import or defined function in this module (#1916). The producing ` +
            `call site referenced a function that was never registered.`,
        );
      }
      a.funcIdx = idx;
    }
  };

  const work: Instr[][] = [];
  for (const fn of mod.functions) work.push(fn.body);
  for (const g of mod.globals) work.push(g.init);
  const seen = new Set<Instr[]>();
  while (work.length > 0) {
    const arr = work.pop()!;
    if (seen.has(arr)) continue;
    seen.add(arr);
    for (const instr of arr) {
      resolve(instr);
      const a = instr as unknown as {
        body?: Instr[];
        then?: Instr[];
        else?: Instr[];
        catches?: { body?: Instr[] }[];
        catchAll?: Instr[];
      };
      if (Array.isArray(a.body)) work.push(a.body);
      if (Array.isArray(a.then)) work.push(a.then);
      if (Array.isArray(a.else)) work.push(a.else);
      if (Array.isArray(a.catches)) {
        for (const c of a.catches) {
          if (Array.isArray(c.body)) work.push(c.body);
        }
      }
      if (Array.isArray(a.catchAll)) work.push(a.catchAll);
    }
  }
}
