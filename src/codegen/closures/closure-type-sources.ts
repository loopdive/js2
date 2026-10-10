// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6913) Per-SOURCE closure facts versus SHARED closure struct types.
 *
 * A capture-free closure and the first-class value of a function declaration
 * both allocate the per-signature wrapper struct (`getOrCreateFuncRefWrapperTypes`
 * and its constructible subtype). `ctx.closureInfoByTypeIdx` is keyed by that
 * struct type, so its entry describes every value of the type — but two of its
 * fields are facts about ONE source body:
 *
 * - `needsCallSiteArity === false` — "the body never observes `arguments`, a
 *   rest parameter or a default", which lets the array HOFs skip the
 *   `__argc`/extras-argv plumbing;
 * - `inlineBody` — the body itself, which the array HOFs splice in place of the
 *   `call_ref`.
 *
 * Registering a function expression used to overwrite the entry with its own
 * facts. Any other value of the same type then inherited them: a module with
 * `assert._isSameValue = function (a, b) {…}` (every test262 harness) made
 * `[11].filter(callbackfn)` skip the extras for a declared `callbackfn` that
 * reads `arguments[2]`, and `[1, 2].map(d)` spliced in a DIFFERENT function's
 * body when a numeric function expression of the same signature came first.
 *
 * This module keeps, per struct type, the facts of every source known to
 * inhabit it. With one source the entry carries that source's facts exactly
 * (the historical behaviour, so single-source modules compile byte-for-byte as
 * before); with two or more the arity fact is the conservative merge and the
 * inline body is dropped. A source registered on a subtype is also a source of
 * each ancestor that has an entry, because a value of the subtype is stored
 * and read through the ancestor's type.
 *
 * Sites that compile a closure LITERAL as the callback know the exact value,
 * so they keep that literal's own facts via {@link callbackClosureInfo}.
 */
import { ts } from "../../ts-api.js";
import type { ClosureInfo, CodegenContext } from "../context/types.js";

/**
 * A source's `needsCallSiteArity`. `"neutral"` is a function declaration known
 * NOT to observe arity: it never makes the entry more permissive than it
 * already is (a declaration-only type keeps the conservative wrapper default),
 * but it does not force the arity plumbing either.
 */
type ArityFact = boolean | undefined | "neutral";

/** structTypeIdx → (source node → its `needsCallSiteArity` fact), per compilation. */
const sourcesByCtx = new WeakMap<CodegenContext, Map<number, Map<ts.Node, ArityFact>>>();
/** The exact info registered for a closure literal node. */
const exactInfoByNode = new WeakMap<ts.Node, ClosureInfo>();

function sourcesOf(ctx: CodegenContext, structTypeIdx: number): Map<ts.Node, ArityFact> {
  let byType = sourcesByCtx.get(ctx);
  if (!byType) sourcesByCtx.set(ctx, (byType = new Map()));
  let sources = byType.get(structTypeIdx);
  if (!sources) byType.set(structTypeIdx, (sources = new Map()));
  return sources;
}

/**
 * True wins (some value observes arity); false only when every source is known
 * not to and at least one registered closure claimed it; `current` (the
 * entry's own value) when only neutral declarations are known.
 */
function mergedArity(sources: Map<ts.Node, ArityFact>, current: boolean | undefined): boolean | undefined {
  let sawFalse = false;
  let sawUnknown = false;
  for (const fact of sources.values()) {
    if (fact === true) return true;
    if (fact === false) sawFalse = true;
    else if (fact === undefined) sawUnknown = true;
  }
  if (sawUnknown) return undefined;
  return sawFalse ? false : current;
}

function ancestorEntries(ctx: CodegenContext, structTypeIdx: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>([structTypeIdx]);
  let def = ctx.mod.types[structTypeIdx];
  while (def?.kind === "struct" && def.superTypeIdx !== undefined && def.superTypeIdx >= 0) {
    const superIdx = def.superTypeIdx;
    if (seen.has(superIdx)) break;
    seen.add(superIdx);
    if (ctx.closureInfoByTypeIdx.has(superIdx)) out.push(superIdx);
    def = ctx.mod.types[superIdx];
  }
  return out;
}

/** Re-derive a multi-source entry: merged arity, no per-source inline body. */
function widenEntry(ctx: CodegenContext, structTypeIdx: number, sources: Map<ts.Node, ArityFact>): void {
  const entry = ctx.closureInfoByTypeIdx.get(structTypeIdx);
  if (!entry || sources.size < 2) return;
  const needsCallSiteArity = mergedArity(sources, entry.needsCallSiteArity);
  if (entry.needsCallSiteArity === needsCallSiteArity && entry.inlineBody === undefined) return;
  ctx.closureInfoByTypeIdx.set(structTypeIdx, { ...entry, needsCallSiteArity, inlineBody: undefined });
}

function noteOnAncestors(ctx: CodegenContext, structTypeIdx: number, source: ts.Node, fact: ArityFact): void {
  for (const ancestor of ancestorEntries(ctx, structTypeIdx)) {
    const sources = sourcesOf(ctx, ancestor);
    if (sources.has(source) && sources.get(source) === fact) continue;
    sources.set(source, fact);
    widenEntry(ctx, ancestor, sources);
  }
}

/**
 * Publish a source closure's `ClosureInfo` as the entry of its struct type.
 * Replaces `ctx.closureInfoByTypeIdx.set(structTypeIdx, exact)` at the
 * registration site.
 */
export function publishClosureSourceInfo(ctx: CodegenContext, node: ts.Node, exact: ClosureInfo): void {
  exactInfoByNode.set(node, exact);
  const sources = sourcesOf(ctx, exact.structTypeIdx);
  sources.set(node, exact.needsCallSiteArity);
  if (sources.size === 1) ctx.closureInfoByTypeIdx.set(exact.structTypeIdx, exact);
  else {
    ctx.closureInfoByTypeIdx.set(exact.structTypeIdx, {
      ...exact,
      needsCallSiteArity: mergedArity(sources, exact.needsCallSiteArity),
      inlineBody: undefined,
    });
  }
  noteOnAncestors(ctx, exact.structTypeIdx, node, exact.needsCallSiteArity);
}

/** Whether a function declaration's body observes the call-site arity protocol. */
function declarationObservesArity(decl: ts.Node | undefined): ArityFact {
  if (decl === undefined || !ts.isFunctionLike(decl)) return undefined;
  if (decl.parameters.some((p) => p.dotDotDotToken !== undefined || p.initializer !== undefined)) return true;
  const body = (decl as ts.FunctionLikeDeclaration).body;
  if (body === undefined) return undefined;
  return bodyUsesOwnArguments(body) ? true : "neutral";
}

function bodyUsesOwnArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") return true;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return false;
  }
  return ts.forEachChild(node, bodyUsesOwnArguments) ?? false;
}

/**
 * Record that the first-class value of function declaration `decl` is
 * allocated as `structTypeIdx`. With no other known source the entry is left
 * untouched (its default is already conservative); once the type is shared the
 * entry is widened so no other source's facts are applied to this function.
 */
export function noteFunctionValueInhabitant(
  ctx: CodegenContext,
  structTypeIdx: number,
  decl: ts.Node | undefined,
): void {
  if (decl === undefined || !ctx.closureInfoByTypeIdx.has(structTypeIdx)) return;
  const sources = sourcesOf(ctx, structTypeIdx);
  if (!sources.has(decl)) {
    sources.set(decl, declarationObservesArity(decl));
    widenEntry(ctx, structTypeIdx, sources);
  }
  noteOnAncestors(ctx, structTypeIdx, decl, sources.get(decl));
}

/**
 * The `ClosureInfo` for a callback expression compiled to `structTypeIdx`. A
 * closure literal IS the value at the site, so it keeps its own exact facts
 * even when its struct type is shared; anything else gets the type's entry.
 */
export function callbackClosureInfo(
  ctx: CodegenContext,
  callback: ts.Expression,
  structTypeIdx: number,
): ClosureInfo | undefined {
  if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
    const info = exactInfoByNode.get(callback);
    if (info !== undefined && info.structTypeIdx === structTypeIdx) return info;
  }
  return ctx.closureInfoByTypeIdx.get(structTypeIdx);
}
