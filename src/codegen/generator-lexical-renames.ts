// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6731) Block-scoped shadowing inside a Wasm-native generator
 * (`generators-native.ts`). Standalone/WASI only.
 *
 * WHY. The state machine FLATTENS every structurally lowered block (an `if`
 * branch, a loop body, a `case`) into the generator's single resume function,
 * and keys each frame spill — and the resume local it is loaded into — by the
 * binding's NAME. Two `let`s of one name in different blocks therefore shared
 * one slot. Minified code does this constantly: tailwindcss's candidate parser
 * declares `m` five times (a loop counter, two `indexOf` results, a
 * `charCodeAt`, a for-of pattern element) and `u`, `v`, `h`, `y` three or four
 * times each, at number / string / object types. The shared slot took the first
 * declaration's type, so the next `m >= 0` read an `externref` slot as `f64`
 * (invalid Wasm), or a string was unboxed to NaN (a silently wrong value).
 * A same-typed nested shadow was wrong too: the inner write clobbered the outer
 * binding's slot across the block's end.
 *
 * HOW. Lexically, before planning: every `let` / `const` binding that is NOT
 * at the generator body's top level and whose name is declared more than once
 * in the generator (params, `var`s, other lexical declarations — nested
 * functions excluded) gets its own spill name, `<name>$lex<k>`, valid over its
 * scope's source range (the enclosing block / case block / loop head). The
 * planner spills the variant instead of the name. At emission, every source
 * node is compiled with the variants whose range contains it swapped into the
 * resume function's `localMap` under the plain name, so the ordinary
 * identifier, declaration and assignment lowering resolves the right slot —
 * exactly what `saveBlockScopedShadows` does for a non-generator block, keyed by
 * position because the states are not emitted in lexical order.
 */
import { ts } from "../ts-api.js";
import type { FunctionContext } from "./context/types.js";
import { isFunctionLikeScope } from "./generators-native-ast-scan.js";

/** One renamed binding: `name` means `variant` for source positions in [start, end). */
export interface LexicalRename {
  name: string;
  variant: string;
  start: number;
  end: number;
}

export interface LexicalRenamePlan {
  /** The spill name of each renamed binding identifier. */
  variants: Map<ts.Identifier, string>;
  scopes: LexicalRename[];
}

interface BindingSite {
  id: ts.Identifier;
  /** The source range the binding is visible in; undefined = not renameable. */
  scope?: ts.Node;
}

function bindingIdentifiers(name: ts.BindingName, out: ts.Identifier[]): void {
  if (ts.isIdentifier(name)) out.push(name);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingIdentifiers(el.name, out);
}

/** The lexical scope a let/const declaration list binds in (undefined = function top level / not lexical). */
function lexicalScopeOf(list: ts.VariableDeclarationList, body: ts.Block): ts.Node | undefined {
  if ((list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) return undefined;
  const holder = list.parent;
  if (ts.isForStatement(holder) || ts.isForOfStatement(holder) || ts.isForInStatement(holder)) return holder;
  if (!ts.isVariableStatement(holder)) return undefined;
  const container = holder.parent;
  if (container === body) return undefined;
  if (ts.isCaseClause(container) || ts.isDefaultClause(container)) return container.parent;
  return ts.isBlock(container) ? container : undefined;
}

/**
 * Plan the variants for `fn`'s body. `taken(name)` answers whether a spill
 * name is already in use (a param, a body binding, a planner temporary).
 */
export function planLexicalRenames(
  fn: ts.FunctionLikeDeclaration,
  taken: (name: string) => boolean,
): LexicalRenamePlan {
  const plan: LexicalRenamePlan = { variants: new Map(), scopes: [] };
  const body = fn.body;
  if (!body || !ts.isBlock(body)) return plan;
  const sites = new Map<string, BindingSite[]>();
  const add = (id: ts.Identifier, scope?: ts.Node): void => {
    const list = sites.get(id.text) ?? [];
    list.push({ id, scope });
    sites.set(id.text, list);
  };
  for (const p of fn.parameters) {
    const ids: ts.Identifier[] = [];
    bindingIdentifiers(p.name, ids);
    for (const id of ids) add(id);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node)) {
      const scope = lexicalScopeOf(node, body);
      for (const d of node.declarations) {
        const ids: ts.Identifier[] = [];
        bindingIdentifiers(d.name, ids);
        for (const id of ids) add(id, scope);
      }
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      add(node.name);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      const ids: ts.Identifier[] = [];
      bindingIdentifiers(node.variableDeclaration.name, ids);
      for (const id of ids) add(id);
    }
    if (isFunctionLikeScope(node) || ts.isClassLike(node)) return;
    ts.forEachChild(node, (child) => {
      // A catch clause's own declaration was recorded above as a catch param.
      if (ts.isCatchClause(node) && child === node.variableDeclaration) return;
      visit(child);
    });
  };
  ts.forEachChild(body, visit);
  let ordinal = 0;
  for (const [name, list] of sites) {
    if (list.length < 2) continue;
    for (const site of list) {
      if (!site.scope) continue;
      let variant: string;
      do variant = `${name}$lex${ordinal++}`;
      while (taken(variant) || sites.has(variant));
      plan.variants.set(site.id, variant);
      plan.scopes.push({ name, variant, start: site.scope.pos, end: site.scope.end });
    }
  }
  return plan;
}

/** A real source position for `node` (a synthetic node borrows its first real descendant's). */
function sourcePos(node: ts.Node): number {
  if (node.pos >= 0) return node.pos;
  let found = -1;
  ts.forEachChild(node, (child) => {
    if (found < 0) found = sourcePos(child);
    return found >= 0 ? true : undefined;
  });
  return found;
}

const RESUME_RENAMES = new WeakMap<FunctionContext, readonly LexicalRename[]>();

/** Attach a plan's scopes to the resume function they are emitted into. */
export function setResumeLexicalRenames(fctx: FunctionContext, scopes: readonly LexicalRename[]): void {
  if (scopes.length) RESUME_RENAMES.set(fctx, scopes);
}

/**
 * Compile `node` (via `emit`) with every variant in scope at its position
 * bound under its plain name. The previous bindings are restored afterwards —
 * callers keep spill stores (which read `localMap` by spill name) outside.
 */
export function withLexicalRenames<T>(fctx: FunctionContext, node: ts.Node | undefined, emit: () => T): T {
  const scopes = RESUME_RENAMES.get(fctx);
  if (!scopes || !node) return emit();
  const pos = sourcePos(node);
  const innermost = new Map<string, LexicalRename>();
  for (const s of scopes) {
    if (pos < s.start || pos >= s.end) continue;
    const prev = innermost.get(s.name);
    if (!prev || s.start >= prev.start) innermost.set(s.name, s);
  }
  if (innermost.size === 0) return emit();
  const saved: [string, number | undefined, boolean][] = [];
  for (const [name, s] of innermost) {
    const idx = fctx.localMap.get(s.variant);
    if (idx === undefined) continue;
    saved.push([name, fctx.localMap.get(name), fctx.undefWidenedLocals?.has(name) ?? false]);
    fctx.localMap.set(name, idx);
    if (fctx.undefWidenedLocals?.has(s.variant)) fctx.undefWidenedLocals.add(name);
    else fctx.undefWidenedLocals?.delete(name);
  }
  try {
    return emit();
  } finally {
    for (const [name, idx, widened] of saved) {
      if (idx === undefined) fctx.localMap.delete(name);
      else fctx.localMap.set(name, idx);
      if (widened) fctx.undefWidenedLocals?.add(name);
      else fctx.undefWidenedLocals?.delete(name);
    }
  }
}
