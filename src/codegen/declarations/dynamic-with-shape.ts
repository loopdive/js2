// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4206) Representation pinning for `with` targets that lower on the Tier-2
 * DYNAMIC path under `--target standalone`.
 *
 * ## Why this exists
 *
 * `compileWithStatement` (with-scope.ts) has two tiers. Tier-1 proves a closed
 * shape and rewrites bare identifiers to direct `struct.get`/`struct.set`.
 * Everything Tier-1 declines falls to Tier-2, which resolves the Object
 * Environment Record at runtime through `__extern_has` (HasBinding),
 * `__extern_get`, `__extern_set` and `__delete_property`.
 *
 * In standalone there is no JS host, so `ensureLateImport` binds those four
 * names to the NATIVE `$Object` open-hash helpers (object-runtime.ts). Those
 * helpers walk `$Object` links — and **a WasmGC struct is not an `$Object`**.
 * The walk therefore terminates immediately and HasBinding answers 0 for EVERY
 * name in the body. Tier-2 degrades to a silent no-op: reads fall through to
 * the outer scope, and writes CASCADE PAST the object onto the outer/global
 * binding.
 *
 * Measured before this pin:
 *
 * ```js
 * this.p1 = 1;
 * var o = {p1: 'a', p3: 'c'};
 * var del;
 * with (o) { p1 = 'x1'; del = delete p3; }
 * // global p1 became 'x1'  (spec: stays 1)
 * // o.p1     stayed  'a'   (spec: becomes 'x1')
 * ```
 *
 * This is unsoundness rather than a coverage gap — Tier-2 is supposed to be the
 * semantic backstop for everything Tier-1 declines, and here it is structurally
 * blind. It is also silent in both directions: no refused import, no
 * diagnostic, and `imports: []` on the compiled module. That is why the
 * standalone host-import-leak cohort measures ZERO across this whole family
 * even though the dynamic `with` path is entirely non-functional there.
 *
 * Keeping the target variable as a `$Object` gives the native helpers a store
 * they can actually see, so HasBinding / Get / Set / Delete resolve against the
 * real own properties, and aliasing through `o.p` observes the same object.
 *
 * ## Why the trigger is a bare-identifier `delete`
 *
 * That is the exact syntactic condition under which `proveStructTypedWithTarget`
 * declines Tier-1 (the static struct scope cannot express DeleteBinding's
 * "absent name ⇒ false" or the outer-scope cascade), so it is precisely the set
 * of `with` statements that reach the blind Tier-2 path *and* can be recognised
 * without type information — this pre-pass runs before struct registration.
 *
 * Deliberately narrow. A `with` target that already proves Tier-1 keeps the
 * zero-overhead struct path; widening this to "any `with` target" would move
 * currently-correct Tier-1 files onto Tier-2 for no measured gain.
 *
 * Host lane is byte-inert: there `__extern_has` consults the `_wasmStructProps`
 * sidecar (runtime.ts), so a struct receiver is already visible and no demotion
 * is needed. The single caller is standalone-gated.
 */
import { ts } from "../../ts-api.js";

/** Function/class boundary test — mirrors `isFunctionOrClassBoundary` in with-scope.ts. */
function isFunctionOrClassBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

/**
 * True if `body` contains a `delete <Identifier>` on a BARE name — the Tier-1
 * disqualifier. Mirrors `bodyContainsIdentifierDelete` in with-scope.ts,
 * including its function/class boundary stop: a `delete` inside a nested
 * function is not this body's DeleteBinding.
 */
function bodyHasBareIdentifierDelete(body: ts.Statement): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (n !== body && isFunctionOrClassBoundary(n)) return;
    if (ts.isDeleteExpression(n)) {
      let operand: ts.Expression = n.expression;
      while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
      if (ts.isIdentifier(operand)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return found;
}

/**
 * (#4206, standalone-only caller) Add `varName` to `poisonSet` when it is the
 * target of a `with (varName)` whose body contains a bare-identifier `delete`.
 *
 * Matched (parentheses unwrapped, like the sibling collectors in
 * object-shape-widening.ts):
 * ```js
 * with (o) { delete p; }          // → poison `o`
 * with ((o)) { x = delete (p); }  // → poison `o`
 * ```
 * NOT matched — a MEMBER delete is not a with-binding delete and does not
 * disqualify Tier-1; `markStandaloneDeleteTargets` already owns that shape:
 * ```js
 * with (o) { delete o.p; }
 * ```
 * A nested function/class in the body is also not matched: that shape is a hard
 * `#1387` refusal before any lowering runs, so demoting the variable would
 * change representation for a module that never compiles.
 *
 * Name-based, matching the rest of the widening pre-pass — aliasing is the same
 * shared, documented limitation.
 */
export function markStandaloneDynamicWithTargets(node: ts.Node, varName: string, poisonSet: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (ts.isWithStatement(n)) {
      let target: ts.Expression = n.expression;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (ts.isIdentifier(target) && target.text === varName && bodyHasBareIdentifierDelete(n.statement)) {
        poisonSet.add(varName);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}
