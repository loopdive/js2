// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4264) Module-scope hoisting of a `var` DECLARED INSIDE a `with` body.
 *
 * ## The two things §10.2.11 requires that the module-global path did not give
 *
 * `with (o) { var v = 'x'; }` hoists `v` to the enclosing script's variable
 * environment. #4179 already routes the hoist itself (`walkModuleStmtForVars`
 * descends into a `WithStatement`), but two properties of the resulting binding
 * were wrong:
 *
 * 1. **Its initial value must be `undefined`, observably.** A module global is
 *    initialised by a *constant* expression, and the only constant externref is
 *    `ref.null.extern` — not the tag-1 `$undefined` singleton the standalone
 *    lane compares against. So a body that never reaches the declaration
 *    (`with (o) { throw v; var p4 = 'x4'; }`) left `p4` reading `null`, and
 *    `p4 === undefined` was false. Function-scoped `var`s never had this gap:
 *    the local hoister seeds `undefined` explicitly (#737). This module adds the
 *    same seed at `__module_init` entry.
 *
 * 2. **Its slot must be able to HOLD `undefined`.** The slot type is picked from
 *    the initializer (`var value = 'value'` ⇒ a native-string ref), and a
 *    string ref cannot represent `undefined` at all. That matters precisely
 *    because §14.11.2 consults the object environment FIRST: when the `with`
 *    target owns the name, the declaration's store goes to the OBJECT and the
 *    hoisted binding is never written — so the only value it can ever be read
 *    at is its initial one. Assertions #18/#19 of the whole `S12.10_A1.*`
 *    battery (`value === undefined` && `myObj.value === "value"`) are exactly
 *    this pair.
 *
 * ## Demand gating
 *
 * Both consumers ask this module only for a source file that contains a `with`
 * statement, and it returns an empty set for every other file, so a module
 * without `with` emits byte-identical globals and a byte-identical
 * `__module_init` prologue.
 */
import { ts } from "../../ts-api.js";

/** Per-file memo: the walk is asked once per module var declaration. */
const cache = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/**
 * Names of `var` bindings declared lexically inside a `with` body and hoisted
 * to this file's module scope.
 *
 * Nested functions are NOT descended into: a `var` inside a function belongs to
 * that function's variable environment and is handled by the local hoister,
 * which already seeds `undefined`.
 */
export function withBodyHoistedModuleVarNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const cached = cache.get(sourceFile);
  if (cached !== undefined) return cached;

  const names = new Set<string>();
  if (!sourceFile.isDeclarationFile) {
    const collectBindingNames = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) {
        names.add(name.text);
        return;
      }
      for (const element of name.elements) {
        if (ts.isOmittedExpression(element)) continue;
        collectBindingNames(element.name);
      }
    };
    /** Walk a `with` body collecting every `var` binding it declares. */
    const collectVars = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
      if (ts.isVariableDeclarationList(node)) {
        if ((node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
          for (const declaration of node.declarations) collectBindingNames(declaration.name);
        }
        return;
      }
      ts.forEachChild(node, collectVars);
    };
    /** Find `with` statements at module scope (not inside a function/class). */
    const findWith = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
      if (ts.isWithStatement(node)) {
        collectVars(node.statement);
        // A nested `with` inside this body is covered by the same walk.
      }
      ts.forEachChild(node, findWith);
    };
    ts.forEachChild(sourceFile, findWith);
  }

  cache.set(sourceFile, names);
  return names;
}
