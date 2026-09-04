// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5269 H-1/H-2, R3-2) The ONE place that decides whether a value is an
 * "open `$Object` because of `[Symbol.toPrimitive]`", answered both from the
 * literal (the producer) and from the TYPE (every consumer).
 *
 * Why a value-level answer and not another caller: on the native-provider lane
 * a CLOSED WasmGC struct hides its `[Symbol.toPrimitive]` member from the
 * runtime ToPrimitive walker (#5102, `object-runtime.ts` looks the handler up
 * as `__box_symbol(3)` on a `$Object` and cannot see an `@@3` struct field), so
 * such a literal has to be built OPEN. That makes "open" a property of the
 * VALUE — and therefore of every binding, property slot, array element,
 * parameter and return the value flows through. Answering it only where the
 * initializer syntactically IS the literal left every indirection believing the
 * value was still a closed struct: the open object null-cast into it and the
 * value was destroyed (measured against merge-base d7f23a80bf on
 * `--target standalone`: `var v = w; String(v)` answered "null" where base
 * answered "P<string>", `v.x` answered NaN where base answered 41, an array
 * element lost its text entirely, and at module scope the store trapped
 * `dereferencing a null pointer`, killing the module).
 *
 * TypeScript already carries the fact for us: the literal's member symbol (and
 * the literal's own type symbol) propagate into every derived type, and a
 * structurally identical literal WITHOUT the member gets a different type
 * object — so the type-level question is both complete and narrow.
 */

import ts from "typescript";

/** Per-file cache for {@link toPrimitiveAssignmentTargets}. */
const TO_PRIMITIVE_ASSIGN_TARGET_CACHE = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/**
 * (#5269 H-2) The identifier names this module writes `[Symbol.toPrimitive]`
 * onto — `obj[Symbol.toPrimitive] = function () { … }`.
 *
 * The handler is installed by MUTATION, so no static type of the binding
 * records it and there is no expression-local fact to consult; the only sound
 * question is whether the module performs such a write at all. That is the same
 * shape (and the same rationale) as `moduleInstallsCallableHasInstance`
 * (#4484 A) in `native-ordinary-instanceof.ts`.
 *
 * Matching is by NAME, so a shadowing binding of the same name is included too.
 * That is deliberate: the cost of a false positive is one literal taking the
 * open-object path, while a false negative silently DROPS the write (a
 * symbol-keyed set on a closed struct has nowhere to land) and the runtime
 * ToPrimitive walker then falls through to `valueOf`/`toString`. Modules that
 * never mention `Symbol.toPrimitive` — effectively all of them — are untouched.
 */
function toPrimitiveAssignmentTargets(file: ts.SourceFile): ReadonlySet<string> {
  const cached = TO_PRIMITIVE_ASSIGN_TARGET_CACHE.get(file);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression)
    ) {
      const key = node.left.argumentExpression;
      if (
        ts.isPropertyAccessExpression(key) &&
        ts.isIdentifier(key.expression) &&
        key.expression.text === "Symbol" &&
        key.name.text === "toPrimitive"
      ) {
        names.add(node.left.expression.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  TO_PRIMITIVE_ASSIGN_TARGET_CACHE.set(file, names);
  return names;
}

/** True for a computed property name spelled exactly `[Symbol.toPrimitive]`. */
function isToPrimitiveComputedName(name: ts.PropertyName | undefined): boolean {
  if (name === undefined || !ts.isComputedPropertyName(name)) return false;
  const inner = name.expression;
  return (
    ts.isPropertyAccessExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === "Symbol" &&
    inner.name.text === "toPrimitive"
  );
}

/**
 * (#5269 H-1) True when the literal carries a `[Symbol.toPrimitive]` key —
 * property form or method form.
 *
 * `_hasRuntimeComputedKey` deliberately keeps well-known-symbol keys on the
 * CLOSED-struct path: `[Symbol.iterator]() {}` becomes an `@@1` struct field
 * that the iterator arm reads directly, and moving every well-known key to the
 * open object would give that up. `Symbol.toPrimitive` is the one id whose only
 * consumer is the RUNTIME ToPrimitive probe (#5102), which looks the method up
 * as `__box_symbol(3)` on `$Object`s and cannot see an `@@3` struct field at
 * all. Narrow to that one id on purpose; widening this would undo the `@@1`
 * layout.
 */
export function hasToPrimitiveComputedKey(expr: ts.ObjectLiteralExpression): boolean {
  return expr.properties.some(
    (p) => (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && isToPrimitiveComputedName(p.name),
  );
}

/**
 * (#5269 H-2) Is this literal the initializer of a binding the module later
 * writes `[Symbol.toPrimitive]` onto? Such a literal must be the OPEN object,
 * so the later `__extern_set` with a `__box_symbol(3)` key has somewhere to
 * land and the #5102 ToPrimitive probe can find it.
 */
export function isToPrimitiveAssignmentTargetInitializer(expr: ts.ObjectLiteralExpression): boolean {
  const decl = expr.parent;
  if (decl === undefined || !ts.isVariableDeclaration(decl)) return false;
  if (decl.initializer !== expr || !ts.isIdentifier(decl.name)) return false;
  const targets = toPrimitiveAssignmentTargets(expr.getSourceFile());
  return targets.size > 0 && targets.has(decl.name.text);
}

/**
 * The PRODUCER side: does this object literal have to be built as an open
 * `$Object` for `[Symbol.toPrimitive]` to be reachable? Callers gate on the
 * native-provider lane themselves — the JS-host lane builds these literals
 * closed (#5269 F2) and its own `_toPrimitive` already handles the struct.
 */
export function objectLiteralTakesToPrimitiveOpenPath(expr: ts.ObjectLiteralExpression): boolean {
  return hasToPrimitiveComputedKey(expr) || isToPrimitiveAssignmentTargetInitializer(expr);
}

/**
 * (#5269 R3-2) The CONSUMER side: is this the type of a value that
 * {@link objectLiteralTakesToPrimitiveOpenPath} routed to the open `$Object`?
 * Such a value must be carried as externref everywhere — a binding, a struct
 * field, an array element, a parameter, a return — or the open object null-
 * casts into a closed struct slot and the value is lost.
 *
 * Two questions, because the two producer arms leave different evidence:
 *  - H-1 (`{ [Symbol.toPrimitive](h) {…} }`) puts a member on the type, and
 *    TypeScript keeps that member symbol in every derived type.
 *  - H-2 (`var o = {…}; o[Symbol.toPrimitive] = f`) puts NOTHING on the type —
 *    the handler is installed by mutation — so the evidence is the type's own
 *    symbol, whose declaration is the literal we opened. Type IDENTITY carries
 *    that: `var v = o` gets the very same type object, while a structurally
 *    identical `{ x: 1 }` elsewhere in the module gets a different one, so the
 *    widening does not leak to unrelated shapes.
 */
export function typeTakesToPrimitiveOpenPath(tsType: ts.Type): boolean {
  for (const p of tsType.getProperties()) {
    const decls = p.getDeclarations?.() ?? p.declarations;
    if (decls === undefined) continue;
    for (const d of decls) {
      if (!ts.isMethodDeclaration(d) && !ts.isPropertyAssignment(d)) continue;
      if (d.parent == null || !ts.isObjectLiteralExpression(d.parent)) continue;
      if (isToPrimitiveComputedName(d.name)) return true;
    }
  }
  const ownDecls = tsType.getSymbol()?.getDeclarations();
  if (ownDecls === undefined) return false;
  return ownDecls.some((d) => ts.isObjectLiteralExpression(d) && objectLiteralTakesToPrimitiveOpenPath(d));
}
