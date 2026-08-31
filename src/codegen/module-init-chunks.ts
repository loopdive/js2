// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Deterministic source-level partitioning for large module initializers.
 *
 * A module initializer cannot safely be split by cutting its emitted Wasm
 * instruction array: a cut can bisect a structured control-flow instruction,
 * detach a `try_table` handler, or accidentally move a function-local carrier
 * across a new Wasm call boundary.  This planner therefore deals exclusively
 * in complete source-order entries.  The declaration emitter gives every
 * planned group a fresh `FunctionContext`, retaining `__module_init` as the
 * compile-time context name while materializing the group as an unexported
 * `[] -> []` helper.
 *
 * The entry cap is the hard, deterministic bound.  The AST-node budget is a
 * second deterministic proxy for emitted instruction volume; a single large
 * entry deliberately remains whole because preserving its control-flow and
 * lexical lifetime is more important than an unsafe split.
 */
import { forEachChild, ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

/** Maximum number of complete top-level initialization entries in one helper. */
export const MODULE_INIT_CHUNK_MAX_ENTRIES = 16;

/** Conservative source-level proxy for generated instruction volume. */
export const MODULE_INIT_CHUNK_MAX_AST_NODES = 1024;

/** Private function-name prefix reserved for module-init chunk implementation. */
export const MODULE_INIT_CHUNK_FUNCTION_PREFIX = "__module_init_chunk_";

/** Reserve a WAT-visible private helper name without claiming user spellings. */
export function reserveModuleInitChunkHelperName(ctx: CodegenContext, preferred: string): string {
  let name = preferred;
  let duplicate = 0;
  while (
    ctx.moduleInitChunkHelperNames.has(name) ||
    ctx.funcMap.has(name) ||
    ctx.mod.functions.some((func) => func.name === name) ||
    ctx.mod.imports.some((entry) => entry.desc.kind === "func" && entry.name === name)
  ) {
    name = `${preferred}_${++duplicate}`;
  }
  ctx.moduleInitChunkHelperNames.add(name);
  return name;
}

export function isModuleInitChunkFunctionContext(fctx: FunctionContext): boolean {
  return fctx.moduleInitChunk === true;
}

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
