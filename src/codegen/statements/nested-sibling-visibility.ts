// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Lift-time classification of the sibling nested functions a nested function
// declaration references (#5148 checkpoint, #6730 lexical scope).
//
// `ctx.funcMap` / `ctx.nestedFuncCaptures` are keyed by BARE name across
// frames. Minified bundles reuse short names everywhere: prettier's
// `makeIndentation` (`fr`) declares nested helpers `i`, `D`, `f`, `l`, `d`, `c`
// while `printDocToString` (`Ce`) has plain `let` variables with the SAME names.
// When Ce's nested `y()` read its own `f`/`d`/`c` variables, the sibling
// classification took the registry entries of fr's helpers as siblings and
// box-promoted their transitive captures (`a`, `o`, …) in Ce's frame — with
// fr's value types, so Ce's array `a` got an f64 ref cell and every
// `a.length` became invalid Wasm (#6730). A registry entry is a genuine sibling
// only when its declaration is in scope at the referencing declaration.

import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";

/**
 * `false` when `ownerDecl` is provably NOT lexically visible from `from`
 * (its enclosing container is not an ancestor of `from`). `true` when it is
 * visible, and also when visibility cannot be established from the AST
 * (a detached / synthesized node chain) — callers keep their prior behavior
 * in that case.
 */
function nestedDeclarationVisibleFrom(ownerDecl: ts.FunctionDeclaration, from: ts.Node): boolean {
  const container = ownerDecl.parent;
  if (!container) return true;
  let node: ts.Node | undefined = from.parent;
  let reachedSourceFile = false;
  while (node) {
    if (node === container) return true;
    if (ts.isSourceFile(node)) reachedSourceFile = true;
    node = node.parent;
  }
  return !reachedSourceFile;
}

/**
 * Split the registry functions `stmt`'s body references into
 * `referencedSiblingFns` (follow their transitive captures) and
 * `shadowedSiblingFnValues` (a frame local shadows a foreign registry entry:
 * value-promote the local instead).
 *
 * Two foreign-entry signals:
 *  - (#5148) a recorded capture is not sourceable from THIS frame (Deno's
 *    01_core destructures 00_infra's `__resolvePromise`);
 *  - (#6730) the entry's declaration is not lexically in scope at `stmt`. Then
 *    the name resolves to the lifted function's own capture (a param — nothing
 *    to promote) or to a frame local (value-promote), never to the entry.
 */
export function classifyReferencedSiblingFns(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.FunctionDeclaration,
  funcName: string,
  referencedNames: ReadonlySet<string>,
  captures: readonly { readonly name: string }[],
): { referencedSiblingFns: Set<string>; shadowedSiblingFnValues: Set<string> } {
  const referencedSiblingFns = new Set<string>();
  const shadowedSiblingFnValues = new Set<string>();
  for (const name of referencedNames) {
    if (name === funcName || !ctx.funcMap.has(name) || !ctx.nestedFuncCaptures.has(name)) continue;
    const ownerDecl = ctx.funcMapOwnerDecl.get(name);
    const outOfScope = ownerDecl !== undefined && !nestedDeclarationVisibleFrom(ownerDecl, stmt);
    if (outOfScope && (!fctx.localMap.has(name) || captures.some((c) => c.name === name))) continue;
    const capsForeign =
      fctx.localMap.has(name) &&
      (outOfScope ||
        ctx.nestedFuncCaptures.get(name)!.some((cap) => {
          if (fctx.localMap.has(cap.name)) return false;
          const def =
            cap.outerLocalIdx < fctx.params.length
              ? fctx.params[cap.outerLocalIdx]
              : fctx.locals[cap.outerLocalIdx - fctx.params.length];
          return def?.name !== cap.name;
        }));
    if (capsForeign) shadowedSiblingFnValues.add(name);
    else referencedSiblingFns.add(name);
  }
  return { referencedSiblingFns, shadowedSiblingFnValues };
}
