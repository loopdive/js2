// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — the shape of a destructuring binding pattern, decided once from the
// AST. Selection and lowering read the same answer, so a pattern the selector
// admits is a pattern the builder can lower.

import { ts } from "../ts-api.js";

/**
 * Slice 8a (#1169g): a flat pattern the typed readers lower as one
 * `object.get` / `vec.get` per leaf: identifier leaves, no defaults, no rest,
 * no nesting, no computed keys, and no leaf already in `scope`.
 *
 *   - `{ a, b: x }` — shorthand and renamed keys (identifier or string);
 *   - `[a, , c]`    — positional leaves, elisions allowed.
 */
export function isPhase1BindingPattern(p: ts.BindingPattern, scope: ReadonlySet<string>): boolean {
  if (p.elements.length === 0) return false;
  const localNames = new Set<string>();
  for (const elem of p.elements) {
    if (ts.isOmittedExpression(elem)) continue;
    if (elem.dotDotDotToken || elem.initializer || !ts.isIdentifier(elem.name)) return false;
    if (elem.propertyName && !ts.isIdentifier(elem.propertyName) && !ts.isStringLiteral(elem.propertyName)) {
      return false;
    }
    const name = elem.name.text;
    if (scope.has(name) || localNames.has(name)) return false;
    localNames.add(name);
  }
  return true;
}
