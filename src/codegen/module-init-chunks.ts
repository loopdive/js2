// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Codegen side of module-initializer chunking.  The planner itself (which
 * complete source entries share one helper, and the dispatch-tree shape) is
 * `src/shared/module-init-chunk-plan.ts`, shared with the IR lowering.  The
 * declaration emitter gives every planned group a fresh `FunctionContext`,
 * retaining `__module_init` as the compile-time context name while
 * materializing the group as an unexported `[] -> []` helper.
 */
import { ts } from "../ts-api.js";
import type { FuncHandle, Instr, LocalDef } from "../ir/types.js";
import {
  MODULE_INIT_CHUNK_FUNCTION_PREFIX,
  planModuleInitChunkDispatch,
  reserveModuleInitChunkHelperName,
} from "../shared/module-init-chunk-plan.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";

/** Mint and push one private `[] -> []` helper; returns its stable handle. */
function pushModuleInitChunkHelper(
  ctx: CodegenContext,
  name: string,
  typeIdx: number,
  locals: LocalDef[],
  body: Instr[],
): FuncHandle {
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: reserveModuleInitChunkHelperName(ctx, name),
    typeIdx,
    locals,
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * Keep the public initializer a compact dispatcher even for a graph with so
 * many chunks that one direct call per chunk would itself become a large
 * Cranelift body. Every intermediate node stays private and `[] -> []`.
 */
function moduleInitChunkDispatchCalls(ctx: CodegenContext, handles: readonly FuncHandle[], typeIdx: number): Instr[] {
  const roots = planModuleInitChunkDispatch(handles, (members, level, ordinal) =>
    pushModuleInitChunkHelper(
      ctx,
      `${MODULE_INIT_CHUNK_FUNCTION_PREFIX}dispatch_${level}_${ordinal}`,
      typeIdx,
      [],
      members.map((funcIdx): Instr => ({ op: "call", funcIdx })),
    ),
  );
  return roots.map((funcIdx): Instr => ({ op: "call", funcIdx }));
}

/**
 * (#7106) The one seam between legacy chunk emission and an IR-claimed
 * initializer. The IR overlay replaces the initializer after legacy compiled
 * it, so the chunks legacy compiles meanwhile are held instead of emitted:
 * an installed IR initializer leaves them dead, while a demoted one needs them
 * as its bounded legacy body (`releaseModuleInitChunks`).
 */
export function holdModuleInitChunksForIr(ctx: CodegenContext): void {
  heldChunks.set(ctx, { chunks: [] });
}

interface HeldModuleInitChunks {
  readonly chunks: { readonly locals: LocalDef[]; readonly body: Instr[] }[];
  dispatch?: { readonly initBody: Instr[]; readonly placeholder: Instr; readonly typeIdx: number };
}

const heldChunks = new WeakMap<CodegenContext, HeldModuleInitChunks>();

/** Emit one compiled chunk as a private helper, or hold it for the IR outcome. */
export function emitModuleInitChunk(
  ctx: CodegenContext,
  ordinal: number,
  typeIdx: number,
  chunk: FunctionContext,
): FuncHandle | undefined {
  const held = heldChunks.get(ctx);
  if (!held) {
    return pushModuleInitChunkHelper(
      ctx,
      `${MODULE_INIT_CHUNK_FUNCTION_PREFIX}${ordinal}`,
      typeIdx,
      chunk.locals,
      chunk.body,
    );
  }
  // Held bodies stay visible to late index repairs until they are emitted or dropped.
  ctx.liveBodies.add(chunk.body);
  held.chunks.push({ locals: chunk.locals, body: chunk.body });
  return undefined;
}

/**
 * Call the emitted chunks from the initializer. A held set instead reserves
 * the dispatch's place with a `nop` that `releaseModuleInitChunks` replaces.
 */
export function dispatchModuleInitChunks(
  ctx: CodegenContext,
  initBody: Instr[],
  handles: readonly FuncHandle[],
  typeIdx: number,
): void {
  const held = heldChunks.get(ctx);
  if (!held) {
    initBody.push(...moduleInitChunkDispatchCalls(ctx, handles, typeIdx));
    return;
  }
  const placeholder: Instr = { op: "nop" };
  initBody.push(placeholder);
  held.dispatch = { initBody, placeholder, typeIdx };
}

/**
 * After the IR overlay: drop the held chunks when the IR replaced the legacy
 * initializer body, else emit them and their dispatch under the body it kept.
 */
export function releaseModuleInitChunks(ctx: CodegenContext): void {
  const held = heldChunks.get(ctx);
  if (!held) return;
  heldChunks.delete(ctx);
  for (const chunk of held.chunks) ctx.liveBodies.delete(chunk.body);
  const dispatch = held.dispatch;
  if (!dispatch || !ctx.mod.functions.some((func) => func.body === dispatch.initBody)) return;
  const handles = held.chunks.map((chunk, ordinal) =>
    pushModuleInitChunkHelper(
      ctx,
      `${MODULE_INIT_CHUNK_FUNCTION_PREFIX}${ordinal}`,
      dispatch.typeIdx,
      chunk.locals,
      chunk.body,
    ),
  );
  const calls = moduleInitChunkDispatchCalls(ctx, handles, dispatch.typeIdx);
  dispatch.initBody.splice(dispatch.initBody.indexOf(dispatch.placeholder), 1, ...calls);
}

export function isModuleInitChunkFunctionContext(fctx: FunctionContext): boolean {
  return fctx.moduleInitChunk === true;
}

/**
 * (#6877) Is a declaration compiled in a chunk nested inside a FUNCTION (an IIFE
 * the chunk inlines, react.development.js's whole body)? Such a binding is the
 * function's hoisted local, never a module global — the bare-name
 * `moduleGlobals` entry may be another module's top-level `var`
 * (react.production.js's `assign`), or this module's own outer `var`.
 */
export function chunkDeclarationIsFunctionLocal(stmt: ts.Node): boolean {
  for (let node = stmt.parent; node !== undefined && !ts.isSourceFile(node); node = node.parent) {
    if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)) return true;
  }
  return false;
}
