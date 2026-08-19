// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4206) A function-local `var` whose pre-initialization value is OBSERVED
 * cannot live in a primitive-pinned slot.
 *
 * ## The defect
 *
 * §10.2.11 FunctionDeclarationInstantiation creates every `var` binding with
 * the value `undefined` at function entry, so a read that precedes the
 * declaration answers `undefined`:
 *
 * ```js
 * var f = function () {
 *   return value;          // spec: undefined
 *   var value = "value";
 * };
 * ```
 *
 * `hoistVarDecl` types the slot from the DECLARATION — here the initializer
 * makes it a native-string `(ref null $AnyString)` — and a reference slot has
 * no representation for `undefined` at all. Its wasm zero-init is `ref.null`,
 * which reads back as **`null`**, a different value. Measured before this
 * change, `--target standalone`:
 *
 * ```
 * r === undefined   false   (spec: true)
 * r === null        true    (spec: false)
 * ```
 *
 * The numeric case is the same defect with a different wrong answer: an `f64`
 * slot zero-inits to `0`, not `NaN`. #684 already seeds `NaN` — but only for a
 * slot the USAGE analysis narrowed to f64, not for one the initializer's own
 * type narrowed, so `var n = 5` read before its declaration still answered `0`.
 *
 * ## Why widening, and why this is the remedy the codebase already named
 *
 * #4489's `module-var-undefined-seed.ts` fixes the module-scope twin by seeding
 * the singleton into externref globals, and records this exact case as its
 * residual: "a slot the type inference narrowed to a primitive … cannot
 * physically hold the singleton and keeps its wasm zero-init … recorded as this
 * issue's residual". A seed is not available here for the same reason it was
 * not available there — the slot cannot hold the value — so the fix is the one
 * #4264 point 2 already uses for `with`-body vars: WIDEN the slot to externref,
 * where `emitUndefined` then seeds the real singleton through the existing
 * hoister path.
 *
 * ## Why the predicate is narrow
 *
 * It fires only when a reference to the SAME binding textually precedes the
 * declaration inside the same function body. A `var` whose pre-init value no
 * read can observe keeps its narrow slot, so the ordinary shape
 * (`var s = "a"; use(s);`) is byte-identical.
 *
 * Position, not reachability, is the test: `for (…) { use(x); var x = 1; }`
 * observes the initialized value on the second iteration, and a closure
 * declared before the declaration may only be CALLED after it. Both widen. That
 * is conservative in the safe direction — it costs a representation, never an
 * answer — and reachability is not decidable here.
 *
 * Binding identity comes from `oracle.variableDeclarationOf`, never from the
 * name, so a same-named binding in a sibling scope cannot widen this one
 * (CLAUDE.md's #3364 bare-name-keying failure mode).
 *
 * ## The one name-keyed fallback, and why it is admissible
 *
 * Inside a `with` body the checker resolves NOTHING — §14.11's Object
 * Environment Record can bind any name at runtime, so TypeScript gives every
 * identifier there `any` and no value declaration, and
 * `variableDeclarationOf` answers `undefined`. Without a fallback the whole
 * `S12.10_A1.{7,12}` family (a function expression declared inside a `with`)
 * would be invisible to this analysis while its `with`-free twin
 * (`S12.10_A1.11`) is not.
 *
 * The fallback is by name, and is bounded three ways that #3364's failure mode
 * was not: it applies only to an identifier that is genuinely inside a `with`
 * body, only against `var` declarations hoisted to THIS ONE function body (not
 * a module-wide table), and only when the oracle has already declined. That is
 * the same reasoning #4264 records for `withBodyAssignmentWidens`, applied at
 * function scope instead of module scope.
 */
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/** Per-(context, container) memo — one walk per function body, not per `var`. */
const analysisCache = new WeakMap<CodegenContext, WeakMap<ts.Node, ReadonlySet<ts.VariableDeclaration>>>();

/**
 * The nearest enclosing function-like BODY, or the source file. `var` bindings
 * hoist to exactly this scope, so it is also the region a pre-declaration read
 * can come from.
 */
function varScopeOf(node: ts.Node): ts.Node {
  for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
    if (ts.isSourceFile(p)) return p;
    if (ts.isFunctionLike(p)) return (p as ts.Node & { body?: ts.Node }).body ?? p;
  }
  return node.getSourceFile();
}

/** True when `node` sits inside the BODY of a `with` statement. */
function isInsideWithBody(node: ts.Node): boolean {
  let prev: ts.Node | undefined;
  for (let cur: ts.Node | undefined = node; cur; prev = cur, cur = cur.parent) {
    if (prev !== undefined && ts.isWithStatement(cur) && cur.statement === prev) return true;
  }
  return false;
}

/**
 * The initialized `var` declarations hoisted to `container`, by name — the
 * table behind the `with`-body fallback documented in this file's header.
 */
function initializedVarDeclsByName(container: ts.Node): Map<string, ts.VariableDeclaration> {
  const byName = new Map<string, ts.VariableDeclaration>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (node.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0 &&
      varScopeOf(node) === container &&
      !byName.has(node.name.text)
    ) {
      byName.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(container, visit);
  return byName;
}

/**
 * The declaration `id` reads, or `undefined`. Prefers the oracle; falls back to
 * the container's own by-name table only for an identifier inside a `with`
 * body, where the checker cannot answer at all.
 */
function readDeclarationOf(
  ctx: CodegenContext,
  id: ts.Identifier,
  container: ts.Node,
  byName: () => Map<string, ts.VariableDeclaration>,
): ts.VariableDeclaration | undefined {
  const resolved = ctx.oracle.variableDeclarationOf(id);
  if (resolved !== undefined) return varScopeOf(resolved) === container ? resolved : undefined;
  if (!isInsideWithBody(id)) return undefined;
  return byName().get(id.text);
}

/**
 * Every initialized `var` declaration in `container` that some identifier
 * references from a position BEFORE the declaration's own name.
 */
function collectPreInitReadVarDecls(ctx: CodegenContext, container: ts.Node): ReadonlySet<ts.VariableDeclaration> {
  const observed = new Set<ts.VariableDeclaration>();
  let cachedByName: Map<string, ts.VariableDeclaration> | undefined;
  const byName = (): Map<string, ts.VariableDeclaration> => (cachedByName ??= initializedVarDeclsByName(container));
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const decl = readDeclarationOf(ctx, node, container, byName);
      if (
        decl !== undefined &&
        decl.initializer !== undefined &&
        ts.isIdentifier(decl.name) &&
        decl.name !== node &&
        node.getStart() < decl.name.getStart()
      ) {
        observed.add(decl);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(container, visit);
  return observed;
}

/**
 * (#4206) Must this hoisted `var`'s slot be dynamic because a read can observe
 * its pre-initialization `undefined`?
 */
export function hoistedVarPreInitValueIsObserved(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  if (decl.initializer === undefined || !ts.isIdentifier(decl.name)) return false;
  // `var` only. A `let`/`const` read before its declaration is a TDZ
  // ReferenceError, not `undefined`, and is enforced by the `__tdz_<name>` flag.
  if ((decl.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) return false;
  let perContainer = analysisCache.get(ctx);
  if (perContainer === undefined) {
    perContainer = new WeakMap();
    analysisCache.set(ctx, perContainer);
  }
  const container = varScopeOf(decl);
  let observed = perContainer.get(container);
  if (observed === undefined) {
    observed = collectPreInitReadVarDecls(ctx, container);
    perContainer.set(container, observed);
  }
  return observed.has(decl);
}

/**
 * (#4206) Can this function RETURN the pre-initialization `undefined` of one of
 * its own widened `var` bindings?
 *
 * Widening the slot is not enough on its own. TypeScript infers the signature's
 * return type from the returned expression's DECLARED type — `return value;`
 * where `value` is `var value = "value"` infers `string` — so the closure ABI
 * narrows the value straight back to a native-string ref on the way out, and
 * `undefined` becomes `null` again at the call boundary. The representation has
 * to hold across the return, not just inside the body.
 *
 * The predicate is deliberately positional and strict: the `return` must
 * textually PRECEDE the declaration whose pre-init value it reads. A return
 * placed after the declaration is left alone, so the ordinary shape keeps its
 * precise ABI.
 */
export function widenClosureReturnForPreInitVar(
  ctx: CodegenContext,
  fn: ts.SignatureDeclaration & { body?: ts.Node },
  inferred: ValType,
): ValType {
  return inferred.kind !== "externref" && closureReturnsObservedPreInitVar(ctx, fn) ? { kind: "externref" } : inferred;
}

function closureReturnsObservedPreInitVar(
  ctx: CodegenContext,
  fn: ts.SignatureDeclaration & { body?: ts.Node },
): boolean {
  const body = fn.body;
  if (body === undefined || !ts.isBlock(body)) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionLike(node) && node !== fn) return; // a nested function has its own return
    if (ts.isReturnStatement(node) && node.expression !== undefined && ts.isIdentifier(node.expression)) {
      const decl = readDeclarationOf(ctx, node.expression, body, () => initializedVarDeclsByName(body));
      if (
        decl !== undefined &&
        ts.isIdentifier(decl.name) &&
        node.expression.getStart() < decl.name.getStart() &&
        hoistedVarPreInitValueIsObserved(ctx, decl)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}
