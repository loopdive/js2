// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Compile-time constant substitution.
 *
 * Replaces dotted identifier paths (e.g. `process.env.NODE_ENV`) with literal
 * values in source text before TypeScript parsing. This enables dead-branch
 * elimination when combined with constant-folding in codegen.
 *
 * Also handles `typeof <identifier>` forms: `typeof process` can be replaced
 * with `"undefined"` to eliminate environment-detection branches.
 */
import { PositionMap, type SourceEdit } from "../position-map.js";

/**
 * Apply compile-time define substitutions to source text.
 *
 * @param source - Original TypeScript/JavaScript source
 * @param defines - Map of dotted paths to replacement literals.
 *   Example: `{ "process.env.NODE_ENV": '"production"' }`
 * @returns Source with substitutions applied
 */
export function applyDefineSubstitutions(source: string, defines: Record<string, string>): string {
  return applyDefineSubstitutionsWithMap(source, defines).source;
}

/**
 * #1928 — like {@link applyDefineSubstitutions} but also returns a `PositionMap`
 * from the substituted output back to the input. Define replacements
 * (`process.env.NODE_ENV` → `"production"`) change length, so positions after a
 * match on the same line shift; multi-line replacements shift lines below.
 * Tracking the exact match spans keeps diagnostics anchored to the user's
 * original positions.
 */
export function applyDefineSubstitutionsWithMap(
  source: string,
  defines: Record<string, string>,
): { source: string; positionMap: PositionMap } {
  if (!defines || Object.keys(defines).length === 0) {
    return { source, positionMap: PositionMap.identity() };
  }

  // Sort keys by length (longest first) to avoid partial matches.
  const keys = Object.keys(defines).sort((a, b) => b.length - a.length);

  // Each pass rewrites `current` and produces a per-pass PositionMap
  // (current-output → current-input); compose them so the final map runs
  // straight back to the original source.
  let current = source;
  let composed = PositionMap.identity();

  for (const key of keys) {
    const replacement = defines[key]!;
    const pattern = key.startsWith("typeof ")
      ? new RegExp(`(?<![.\\w$])typeof\\s+${escapeRegExp(key.slice(7))}(?![\\w$])`, "g")
      : new RegExp(`(?<![.\\w$])${escapeRegExp(key)}(?![\\w$])`, "g");

    const edits: SourceEdit[] = [];
    let out = "";
    let last = 0;
    for (const m of current.matchAll(pattern)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      out += current.slice(last, start) + replacement;
      edits.push({ origStart: start, origEnd: end, newLength: replacement.length });
      last = end;
    }
    if (edits.length === 0) continue; // no match this pass — map unchanged
    out += current.slice(last);
    current = out;
    // This pass maps current-output → its input; the prior `composed` maps that
    // input → original. compose() chains them.
    composed = new PositionMap(edits).compose(composed);
  }

  return { source: current, positionMap: composed };
}

/**
 * Build the default define map for a given production/development mode.
 * This is the convenience path — users can also pass explicit defines.
 */
export function buildDefaultDefines(mode: "production" | "development"): Record<string, string> {
  return {
    "process.env.NODE_ENV": JSON.stringify(mode),
    "typeof process": JSON.stringify("undefined"),
    "typeof window": JSON.stringify("undefined"),
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
