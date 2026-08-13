/**
 * (#3980) Annex B B.3.3 — "the web-compat extension is NOT observed when
 * creating the var binding would produce an Early Error".
 *
 * B.3.3.1 / B.3.3.2 give a block-nested sloppy-mode `function F` a *var-scoped*
 * binding in the enclosing function/global scope — but ONLY when replacing that
 * `FunctionDeclaration` with `var F` would not produce an Early Error. When an
 * intervening **lexical** `F` exists (a `let`/`const`/`class` in an enclosing
 * block, a `for`/`for-in`/`for-of` head binding, or a *destructuring* catch
 * parameter — see B.3.5) the extension is skipped and **no binding for `F` is
 * created at all**. Reading `F` in the enclosing scope must then throw a
 * ReferenceError, and `typeof F` must be `"undefined"`.
 *
 * The compiler's `localMap` is FLAT per function: a `let F` declared inside a
 * nested block, a `for (let F …)` head, or a `catch ({ F })` pattern all
 * allocate a function-level slot, which a nested closure then happily captures
 * from anywhere in the function. That is why
 * `assert.throws(ReferenceError, function () { F; })` — the assertion used by
 * all 96 `annexB/language/{global,function}-code/*-skip-early-err-*` tests —
 * saw a live binding instead of a throw.
 *
 * `src/codegen/statements/nested-declarations.ts` already records a *per-
 * FunctionContext* cancellation (`fctx.annexBCancelled`, #2200 Phase 1), but
 * (a) it only recognises a `function` whose direct parent is a `Block`, missing
 * the `if`-clause and `switch` case/default positions, (b) it only recognises a
 * lexical shadow declared at the top level of an enclosing `Block`/case clause,
 * missing loop heads and catch patterns, and (c) being on the FunctionContext it
 * is invisible to *nested* function bodies, which is exactly where the failing
 * reads live.
 *
 * This module is the position-based, whole-SourceFile counterpart: it collects
 * every cancelled site once per source file and answers "is this identifier read
 * unbound?" for any read anywhere in the module, including inside nested
 * closures. It deliberately does NOT fire when the enclosing scope has its own
 * binding for the name (a parameter, a `var`, or a scope-top-level
 * `let`/`const`/`class`/`function`) — in those cases Annex B merely declines to
 * create a *new* binding and the existing one is still readable
 * (`*-skip-param`, `*-skip-early-err` without a suffix).
 */
import ts from "typescript";

export interface AnnexBCancelSite {
  /** The cancelled function-declaration name. */
  name: string;
  /** Enclosing var scope (function body / source file) — reads outside it are unrelated. */
  scopeStart: number;
  scopeEnd: number;
  /** The declaring block-ish range — reads INSIDE it still see the block-local function. */
  blockStart: number;
  blockEnd: number;
}

interface AnnexBFunctionScopeSite {
  name: string;
  scopeStart: number;
  scopeEnd: number;
  outerScopeStart: number;
}

/** Is `node` a var-scope boundary (function-like or the source file)? */
function isVarScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node)
  );
}

/** Collect the identifier names bound by a binding name (identifier or pattern). */
function collectBoundNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    collectBoundNames(el.name, out);
  }
}

/** Does a statement list bind `name` at its own top level via let/const/class? */
function listBindsLexically(stmts: readonly ts.Statement[], name: string): boolean {
  for (const s of stmts) {
    if (ts.isVariableStatement(s) && (s.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) {
      const names = new Set<string>();
      for (const d of s.declarationList.declarations) collectBoundNames(d.name, names);
      if (names.has(name)) return true;
    }
    if (ts.isClassDeclaration(s) && s.name?.text === name) return true;
  }
  return false;
}

/** Does a `for`/`for-in`/`for-of` head lexically bind `name`? */
function loopHeadBindsLexically(node: ts.Node, name: string): boolean {
  let init: ts.ForInitializer | ts.ForInitializer[] | undefined;
  if (ts.isForStatement(node)) init = node.initializer;
  else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) init = node.initializer;
  else return false;
  if (!init || Array.isArray(init) || !ts.isVariableDeclarationList(init)) return false;
  if ((init.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) return false;
  const names = new Set<string>();
  for (const d of init.declarations) collectBoundNames(d.name, names);
  return names.has(name);
}

/**
 * Does a `catch` clause bind `name` in a way that makes a same-named `var`
 * an Early Error? Per B.3.5 a *simple* `catch (F)` still permits `var F`, so
 * only a **destructuring** catch parameter cancels the Annex B extension.
 */
function catchParamCancels(node: ts.Node, name: string): boolean {
  if (!ts.isCatchClause(node)) return false;
  const decl = node.variableDeclaration;
  if (!decl || ts.isIdentifier(decl.name)) return false;
  const names = new Set<string>();
  collectBoundNames(decl.name, names);
  return names.has(name);
}

/**
 * Is `fd` in an Annex B statement position (a `function` that is NOT a direct
 * declaration of its enclosing var scope)? Returns the node whose range counts
 * as the "declaring block" — reads inside it still resolve to the block-local
 * function — or `null` when `fd` is a plain scope-level declaration.
 */
export function annexBDeclaringRange(fd: ts.FunctionDeclaration): ts.Node | null {
  const parent = fd.parent;
  if (!parent) return null;
  if (ts.isBlock(parent)) {
    // Only an ACTUAL function body is a scope-level declaration list. A user
    // BlockStatement directly under a SourceFile is still a block-nested
    // Annex-B position; treating SourceFile as the block's owner used to make
    // eval("{ function f() {} }") look like a plain script declaration.
    const owner = parent.parent;
    if (
      owner &&
      !ts.isSourceFile(owner) &&
      !ts.isModuleBlock(owner) &&
      isVarScopeBoundary(owner) &&
      (owner as ts.FunctionLikeDeclarationBase).body === parent
    ) {
      return null;
    }
    return parent;
  }
  // `switch (x) { case 1: function f() {} }` — the whole CaseBlock is one
  // lexical scope, so that is the range in which the block-local binding lives.
  if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) return parent.parent;
  // `if (x) function f() {}` / `if (x) …; else function f() {}` (B.3.4) — the
  // declaration is its own implicit block.
  if (ts.isIfStatement(parent) && (parent.thenStatement === fd || parent.elseStatement === fd)) return fd;
  return null;
}

/** The nearest enclosing var scope of `node`, or `null`. */
export function enclosingVarScope(node: ts.Node): ts.Node | null {
  let n: ts.Node | undefined = node.parent;
  while (n && !isVarScopeBoundary(n)) n = n.parent;
  return n ?? null;
}

/** The statement container of a var scope (a function body, or the file itself). */
function scopeStatements(scope: ts.Node): readonly ts.Statement[] {
  if (ts.isSourceFile(scope) || ts.isModuleBlock(scope)) return scope.statements;
  const body = (scope as ts.FunctionLikeDeclarationBase).body;
  if (body && ts.isBlock(body)) return body.statements;
  return [];
}

/**
 * Does the var scope `scope` already bind `name` in its OWN right — a parameter,
 * a `var` anywhere inside it, or a scope-top-level `let`/`const`/`class`/
 * `function`? When it does, Annex B simply declines to create an ADDITIONAL
 * binding; the existing one stays readable, so nothing is cancelled.
 */
export function scopeBindsName(scope: ts.Node, name: string): boolean {
  if (!ts.isSourceFile(scope) && !ts.isModuleBlock(scope)) {
    const params = (scope as ts.FunctionLikeDeclarationBase).parameters;
    if (params) {
      for (const p of params) {
        const names = new Set<string>();
        collectBoundNames(p.name, names);
        if (names.has(name)) return true;
      }
    }
  }
  const stmts = scopeStatements(scope);
  if (listBindsLexically(stmts, name)) return true;
  for (const s of stmts) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === name) return true;
  }
  // A `var name` ANYWHERE in the scope (var declarations are function-scoped).
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== scope && isVarScopeBoundary(node)) return;
    if (ts.isVariableStatement(node) && (node.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
      const names = new Set<string>();
      for (const d of node.declarationList.declarations) collectBoundNames(d.name, names);
      if (names.has(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return found;
}

/**
 * Walk from the declaring container up to (but not including) `scope`, looking
 * for a lexical binder of `name` that would make a same-named `var` an Early
 * Error: a `let`/`const`/`class` at the top of an enclosing block or case
 * clause, a lexical loop head, or a destructuring catch parameter.
 */
export function hasInterveningLexicalBinder(from: ts.Node, name: string, scope: ts.Node): boolean {
  let node: ts.Node | undefined = from;
  let child: ts.Node | undefined;
  while (node && node !== scope) {
    if (ts.isBlock(node) && listBindsLexically(node.statements, name)) return true;
    if ((ts.isCaseClause(node) || ts.isDefaultClause(node)) && listBindsLexically(node.statements, name)) return true;
    // A loop head only binds inside the loop BODY, not in its own initializer.
    if (child && (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node))) {
      if ((node as ts.IterationStatement).statement === child && loopHeadBindsLexically(node, name)) return true;
    }
    if (child && ts.isCatchClause(node) && node.block === child && catchParamCancels(node, name)) return true;
    child = node;
    node = node.parent;
  }
  return false;
}

/**
 * (#2200, Annex B B.3.3) Decide whether a block-nested `function` declaration's
 * web-compat outer var-binding is *cancelled*. Returns the declaring `Block` (so
 * the caller can record its position range) when the function sits directly in a
 * `Block` AND an intervening lexical (`let`/`const`/class) binding for the same
 * name exists between that block and the enclosing function/global scope;
 * otherwise `null` (not block-nested, or eligible for the outer binding — left
 * to the unconditional hoist).
 *
 * Per §B.3.3.1 the outer binding is created only when replacing the function
 * with `var F` would not produce an early error. Strict-mode functions get no
 * Annex B outer binding at all, but a *cancelled* binding behaves the same
 * observable way (reading `F` outside the block throws), so strict mode is not
 * gated here.
 *
 * (#3980) This is the narrow, per-`FunctionContext` detector used by the hoist
 * pass; `collectAnnexBCancelSites` below is the whole-`SourceFile` superset that
 * also covers `if`-clause / `switch`-clause declaration positions, lexical loop
 * heads, destructuring `catch` parameters, and reads inside nested closures.
 */
export function annexBHoistCancels(fnDecl: ts.FunctionDeclaration): ts.Block | null {
  const name = fnDecl.name?.text;
  if (!name || !fnDecl.body) return null;
  const block = fnDecl.parent;
  // Must be directly inside a Block (not the function body itself, not a case
  // clause statement list, etc.). A direct function-body decl keeps its hoist.
  if (!ts.isBlock(block)) return null;
  const owner = block.parent;
  if (
    owner &&
    !ts.isSourceFile(owner) &&
    !ts.isModuleBlock(owner) &&
    isVarScopeBoundary(owner) &&
    (owner as ts.FunctionLikeDeclarationBase).body === block
  ) {
    return null; // block IS the fn body → direct decl
  }

  // (#3980) Annex B declining to create the web-compat var binding does NOT make
  // the name unbound when the enclosing var scope ALREADY binds it — a parameter
  // (`*-skip-param`), a `var f`, or a scope-top-level `let f` (`*-skip-early-err`
  // without a suffix). The pre-existing binding stays readable, so cancelling
  // here wrongly turned every read into a ReferenceError. This bail-out also
  // subsumes (and corrects) the former §B.3.3 param-exclusion branch, which used
  // to *cancel* on a same-named parameter.
  const scope = enclosingVarScope(fnDecl);
  if (scope && scopeBindsName(scope, name)) return null;

  // The block that holds the function may itself carry a sibling lexical shadow.
  if (listBindsLexically(block.statements, name)) return block;

  // Walk up from the holding block to the enclosing fn/global, checking each
  // intervening Block / case clause for a lexical binding.
  let node: ts.Node = block.parent;
  while (node && !isVarScopeBoundary(node)) {
    if (ts.isBlock(node) && listBindsLexically(node.statements, name)) return block;
    if ((ts.isCaseClause(node) || ts.isDefaultClause(node)) && listBindsLexically(node.statements, name)) return block;
    node = node.parent;
  }
  return null;
}

/**
 * (#4131) B.3.3.1 step 3 — the half of Annex B that is an *assignment*, not a
 * declaration.
 *
 * `collectAnnexBCancelSites` below answers "does this name read as UNBOUND?".
 * This answers the complementary question: when the enclosing var scope ALREADY
 * binds the name, B.3.3.1 step 3.f still requires that *evaluating* the
 * block-nested `function F` perform `fenvRec.SetMutableBinding(F, fobj, false)`
 * on that existing binding. The compiler modelled only the "create a new
 * web-compat binding" half (`annexBBlockNestedEligible` in
 * `statements/nested-declarations.ts`, which bails outright when the name
 * already has a local) — so `var f = 123` in the same scope never saw the
 * function object, and every `annexB/language/*-existing-var-update` test read
 * the var's own value instead.
 *
 * Restricted to FUNCTION var scopes on purpose. A script-scope `var` is a module
 * GLOBAL, not a local, and its representation is decided by a different path;
 * widening the local carrier for it produced `local.tee expected (ref null N),
 * found global.get of type f64` (measured on the 5 `global-code/if-*` files).
 * Global-scope B.3.3.1 step 3 is real and still unimplemented — see #4131.
 *
 * Deliberately shares `annexBDeclaringRange` with the cancellation collector, so
 * the Block / `if`-clause / `switch`-clause position set is defined exactly once.
 * The `if` and `switch` positions are why this could not simply be added to
 * `annexBBlockNestedEligible`, which only recognises a direct `Block` parent.
 */
export function annexBUpdatesExistingVarBinding(fd: ts.FunctionDeclaration): boolean {
  const name = fd.name?.text;
  if (!name || !fd.body) return false;
  if (annexBDeclaringRange(fd) === null) return false;
  const scope = enclosingVarScope(fd);
  if (!scope || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) return false;
  // A cancelled extension creates NO binding and updates none either (B.3.3.1
  // step 1.a.ii skips the whole step-3 replacement).
  if (hasInterveningLexicalBinder(fd.parent, name, scope)) return false;
  return scopeBindsName(scope, name);
}

const SCOPE_UPDATE_CACHE = new WeakMap<ts.Node, Set<string>>();

/**
 * (#4131) The names in `scope` that some Annex B statement-position `function`
 * declaration must write back to an ALREADY-EXISTING var binding. Memoized per
 * var scope; the result is almost always empty, so ordinary code pays one walk
 * per scope and no allocation beyond the shared empty set.
 */
export function annexBExistingVarUpdateNames(scope: ts.Node): ReadonlySet<string> {
  const cached = SCOPE_UPDATE_CACHE.get(scope);
  if (cached) return cached;
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    // Test the node BEFORE the boundary guard: a `FunctionDeclaration` IS a var
    // scope boundary, so guarding first would skip the very declarations this
    // walk is looking for (measured: the set came back empty for every case).
    if (ts.isFunctionDeclaration(node) && node.name && node.body && annexBUpdatesExistingVarBinding(node)) {
      names.add(node.name.text);
    }
    // Do not descend into a nested var scope — its own Annex B declarations
    // belong to ITS binding set, not this one.
    if (node !== scope && isVarScopeBoundary(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  SCOPE_UPDATE_CACHE.set(scope, names);
  return names;
}

const CACHE = new WeakMap<ts.SourceFile, AnnexBCancelSite[]>();
const FUNCTION_SCOPE_CACHE = new WeakMap<ts.SourceFile, AnnexBFunctionScopeSite[]>();

/** Shared empty result for callers with no SourceFile — never mutated. */
const NO_SITES: AnnexBCancelSite[] = [];

/**
 * Collect every Annex B B.3.3 site in `sf` whose web-compat var binding is
 * cancelled AND whose enclosing scope has no other binding for the name — i.e.
 * every name that must read as *unbound* outside its declaring block.
 * Memoized per SourceFile; the result is almost always empty.
 *
 * `sf` is OPTIONAL because the only caller derives it from
 * `identifier.getSourceFile()`, which returns `undefined` for a **synthesized**
 * identifier — one the compiler manufactured during a desugaring, with no
 * `parent` chain to walk up. Those are common (`with`, `eval`, receiver and
 * `this` rewrites, …) and they carry no source position, so no Annex B question
 * can be asked about them: answer "no sites" and, critically, do NOT touch the
 * `WeakMap`. `CACHE.set(undefined, …)` throws `TypeError: Invalid value used as
 * weak map key`, which `compileExpressionBody`'s speculative catch converts into
 * `Internal error compiling expression` — i.e. a **compile_error for the whole
 * file**. Un-guarded, this fired on 666 test262 files that have nothing to do
 * with Annex B (152 of them `pass` → `compile_error`); see #4091.
 */
export function collectAnnexBCancelSites(sf: ts.SourceFile | undefined): AnnexBCancelSite[] {
  if (!sf) return NO_SITES;
  const cached = CACHE.get(sf);
  if (cached) return cached;
  const sites: AnnexBCancelSite[] = [];
  // (scope,name) pairs for which SOME Annex B declaration in the same scope IS
  // eligible — that one creates the web-compat var binding, so a *sibling*
  // cancelled declaration of the same name does not leave the name unbound.
  // (`staging/sm/lexical-environment/block-scoped-functions-annex-b-notapplicable.js`.)
  const eligible = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const name = node.name.text;
      const range = annexBDeclaringRange(node);
      if (range) {
        const scope = enclosingVarScope(node);
        // `hasInterveningLexicalBinder` walks only the ancestor chain and is
        // almost always false, so it gates the subtree-walking `scopeBindsName`.
        if (scope) {
          if (!hasInterveningLexicalBinder(node.parent, name, scope)) {
            eligible.add(`${scope.getStart(sf)}:${name}`);
          } else if (!scopeBindsName(scope, name)) {
            sites.push({
              name,
              scopeStart: scope.getStart(sf),
              scopeEnd: scope.getEnd(),
              blockStart: range.getStart(sf),
              blockEnd: range.getEnd(),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  const kept = eligible.size === 0 ? sites : sites.filter((s) => !eligible.has(`${s.scopeStart}:${s.name}`));
  CACHE.set(sf, kept);
  return kept;
}

/**
 * Is `name` bound by some scope BETWEEN the read at `id` and the cancelled
 * site's var scope (which starts at `scopeStart`)? A nested closure with its own
 * parameter/`var`/`let` named `name`, or a read sitting inside a block that
 * lexically binds `name`, resolves normally and must not be cancelled.
 */
function boundByInterveningScope(id: ts.Identifier, name: string, scopeStart: number): boolean {
  const sf = id.getSourceFile();
  let node: ts.Node | undefined = id.parent;
  let child: ts.Node = id;
  while (node && node.getStart(sf) > scopeStart) {
    if (ts.isBlock(node) && listBindsLexically(node.statements, name)) return true;
    if ((ts.isCaseClause(node) || ts.isDefaultClause(node)) && listBindsLexically(node.statements, name)) return true;
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (loopHeadBindsLexically(node, name)) return true;
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const names = new Set<string>();
      collectBoundNames(node.variableDeclaration.name, names);
      if (names.has(name)) return true;
    }
    if (isVarScopeBoundary(node) && !ts.isSourceFile(node) && scopeBindsName(node, name)) return true;
    // A function declaration/expression's own name is in scope in its body.
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
      node.name?.text === name &&
      node.body === child
    ) {
      return true;
    }
    child = node;
    node = node.parent;
  }
  return false;
}

/**
 * Should a value read of `id` throw ReferenceError because Annex B declined to
 * create the web-compat var binding for that name? `sites` comes from
 * `collectAnnexBCancelSites`; an empty array short-circuits to `false`.
 */
export function annexBReadIsUnbound(sites: readonly AnnexBCancelSite[], id: ts.Identifier): boolean {
  if (sites.length === 0) return false;
  const name = id.text;
  const pos = id.getStart(id.getSourceFile());
  for (const s of sites) {
    if (s.name !== name) continue;
    if (pos < s.scopeStart || pos >= s.scopeEnd) continue;
    if (pos >= s.blockStart && pos < s.blockEnd) continue;
    if (boundByInterveningScope(id, name, s.scopeStart)) continue;
    return true;
  }
  return false;
}

/**
 * Annex B's synthetic var binding belongs to the function activation that
 * contains the statement-position declaration. TypeScript resolves some
 * `if (...) function f(){}` symbols beyond that function expression, so a
 * later source-level read can otherwise reuse the lifted `funcMap` entry as if
 * `f` were global. Record those function-local names and reject reads outside
 * their owning activation when the outer scope has no independent binding.
 */
export function annexBReadEscapesFunctionScope(id: ts.Identifier): boolean {
  const sf = id.getSourceFile();
  if (!sf) return false;
  let sites = FUNCTION_SCOPE_CACHE.get(sf);
  if (!sites) {
    sites = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body && annexBDeclaringRange(node) !== null) {
        const scope = enclosingVarScope(node);
        if (scope && !ts.isSourceFile(scope) && !ts.isModuleBlock(scope)) {
          const outerScope = enclosingVarScope(scope);
          if (outerScope && !scopeBindsName(outerScope, node.name.text)) {
            sites!.push({
              name: node.name.text,
              scopeStart: scope.getStart(sf),
              scopeEnd: scope.getEnd(),
              outerScopeStart: outerScope.getStart(sf),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    FUNCTION_SCOPE_CACHE.set(sf, sites);
  }

  if (sites.length === 0) return false;
  const pos = id.getStart(sf);
  for (const site of sites) {
    if (site.name !== id.text) continue;
    if (pos >= site.scopeStart && pos < site.scopeEnd) continue;
    if (boundByInterveningScope(id, id.text, site.outerScopeStart)) continue;
    return true;
  }
  return false;
}
