// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Deterministic source-level partitioning for large module initializers — the
 * one chunk planner legacy emission and the IR lowering share (#4376, #7106).
 *
 * A module initializer cannot safely be split by cutting its emitted Wasm
 * instruction array: a cut can bisect a structured control-flow instruction,
 * detach a `try_table` handler, or accidentally move a function-local carrier
 * across a new Wasm call boundary.  This planner therefore deals exclusively
 * in complete source-order entries; each planned group becomes one private
 * `[] -> []` function.
 *
 * The entry cap is the hard, deterministic bound.  The AST-node budget is a
 * second deterministic proxy for emitted instruction volume; a single large
 * entry deliberately remains whole because preserving its control-flow and
 * lexical lifetime is more important than an unsafe split.  The bound exists
 * for optimizing Wasm compilers (Cranelift), whose cost grows superlinearly
 * with one function's size.
 */
import { forEachChild, type ts } from "../ts-api.js";

/** Maximum number of complete top-level initialization entries in one helper. */
export const MODULE_INIT_CHUNK_MAX_ENTRIES = 16;

/** Conservative source-level proxy for generated instruction volume. */
export const MODULE_INIT_CHUNK_MAX_AST_NODES = 1024;

/**
 * Wasm name prefix of every chunk and intermediate dispatcher, legacy and IR
 * alike.  `src/optimize.ts` keeps Binaryen's full inliner off this prefix.
 */
export const MODULE_INIT_CHUNK_FUNCTION_PREFIX = "__module_init_chunk_";

/** Minimal shape shared by statement and declaration-static init entries. */
export interface ModuleInitChunkEntry {
  readonly node: ts.Node;
}

/** Immutable AST nodes can be replanned by IR admission and final emission. */
const sourceNodeWeights = new WeakMap<ts.Node, number>();

/** Count AST nodes iteratively so a pathological source tree cannot grow the JS stack. */
function sourceNodeWeight(root: ts.Node): number {
  const cached = sourceNodeWeights.get(root);
  if (cached !== undefined) return cached;
  let weight = 0;
  const pending: ts.Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    weight++;
    // `forEachChild` treats a non-undefined callback result as an early
    // traversal result. Array#push returns a number, so keep this callback
    // explicitly void or only the first child subtree is counted.
    forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  sourceNodeWeights.set(root, weight);
  return weight;
}

/**
 * Group source-order entries without ever splitting one entry.  The returned
 * groups retain the input order and are stable across runs for the same AST.
 */
export function planModuleInitChunks<T extends ModuleInitChunkEntry>(entries: readonly T[]): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let chunkWeight = 0;

  for (const entry of entries) {
    const entryWeight = sourceNodeWeight(entry.node);
    const startsNewChunk =
      chunk.length > 0 &&
      (chunk.length >= MODULE_INIT_CHUNK_MAX_ENTRIES || chunkWeight + entryWeight > MODULE_INIT_CHUNK_MAX_AST_NODES);
    if (startsNewChunk) {
      chunks.push(chunk);
      chunk = [];
      chunkWeight = 0;
    }
    chunk.push(entry);
    chunkWeight += entryWeight;
  }

  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/** Whether complete source entries need more than one private initializer body. */
export function moduleInitChunksRequired(entries: readonly ModuleInitChunkEntry[]): boolean {
  return planModuleInitChunks(entries).length > 1;
}

/**
 * Fold chunk callees into a dispatch tree whose every node calls at most
 * {@link MODULE_INIT_CHUNK_MAX_ENTRIES} functions, so the dispatcher itself
 * stays a bounded body however many chunks there are.  `group` materializes
 * one private intermediate dispatcher over `members` (`level` counts from the
 * leaves; `ordinal` runs across all levels) and returns its callee handle.
 * The result is the list the initializer itself calls, in source order.
 */
export function planModuleInitChunkDispatch<T>(
  leaves: readonly T[],
  group: (members: readonly T[], level: number, ordinal: number) => T,
): readonly T[] {
  let handles: readonly T[] = leaves;
  let level = 0;
  let ordinal = 0;
  while (handles.length > MODULE_INIT_CHUNK_MAX_ENTRIES) {
    const nextLevel: T[] = [];
    for (let start = 0; start < handles.length; start += MODULE_INIT_CHUNK_MAX_ENTRIES) {
      nextLevel.push(group(handles.slice(start, start + MODULE_INIT_CHUNK_MAX_ENTRIES), level, ordinal++));
    }
    handles = nextLevel;
    level++;
  }
  return handles;
}
