// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachChild, ts } from "../ts-api.js";

/**
 * (#4416) Call sites bucketed by callee name, built ONCE per source file.
 *
 * `inferParamTypeFromCallSites` used to walk the entire source file looking for
 * calls to one function, and it is invoked once per (function, parameter). That
 * is O(functions x params x programSize) — measured quadratic:
 *
 *     units   calls   AST nodes visited
 *        32     128             184,448
 *       128     512           2,949,632
 *       512    2048          47,187,968     <- 4x input, 16x work
 *
 * 47 million node visits for a 61 KB input, and a CPU profile put this one
 * `visit` at **25.2% of a large compile** (with TypeScript's `forEachChild`
 * underneath it accounting for most of the rest). One walk per source file
 * turns it into O(programSize + functions x params).
 *
 * Keyed on the `SourceFile` object, so a new program (or a rewritten file, e.g.
 * cjs-rewrite) gets a fresh index automatically and nothing needs invalidating.
 * The index holds only nodes reachable from `forEachChild(sourceFile, ...)` —
 * exactly what the old walk saw — so coverage is unchanged, and buckets keep
 * document order so an order-dependent `agreed`/`conflict` accumulation
 * resolves identically.
 */
export type CalleeSite = ts.CallExpression | ts.NewExpression;
const callSiteIndexBySourceFile = new WeakMap<ts.SourceFile, Map<string, CalleeSite[]>>();

export function calleeNameIndex(sourceFile: ts.SourceFile): Map<string, CalleeSite[]> {
  const cached = callSiteIndexBySourceFile.get(sourceFile);
  if (cached) return cached;
  const index = new Map<string, CalleeSite[]>();
  const visit = (node: ts.Node): void => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const bucket = index.get(name);
      if (bucket) bucket.push(node as CalleeSite);
      else index.set(name, [node as CalleeSite]);
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  callSiteIndexBySourceFile.set(sourceFile, index);
  return index;
}

const identifierIndexBySourceFile = new WeakMap<ts.SourceFile, ReadonlyMap<string, readonly ts.Identifier[]>>();

/** Every identifier occurrence in the file, bucketed by name in document order, built once per source file. */
export function identifierIndex(sourceFile: ts.SourceFile): ReadonlyMap<string, readonly ts.Identifier[]> {
  const cached = identifierIndexBySourceFile.get(sourceFile);
  if (cached) return cached;
  const index = new Map<string, ts.Identifier[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const bucket = index.get(node.text);
      if (bucket) bucket.push(node);
      else index.set(node.text, [node]);
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  identifierIndexBySourceFile.set(sourceFile, index);
  return index;
}

/**
 * Does `site` supply no value for parameter `paramIndex`? `new F` without
 * parentheses has no argument list at all, so it supplies none.
 */
export function siteOmitsArgument(site: CalleeSite, paramIndex: number): boolean {
  return (site.arguments?.length ?? 0) <= paramIndex;
}
