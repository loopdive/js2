// (#6872) Binding-identity leaf helpers for the closure capture planner
// (arrow-phases.ts).
import { ts, forEachChild } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/**
 * Every name a declaration INSIDE `closure` binds (any nesting depth).
 *
 * A closure-owned `let u` whose same-named OUTER binding is a block-scoped local
 * of an already-closed sibling block (`for (…) { let u = …; f = () => u }` then
 * `g = function () { let u = []; … }`) is no longer in `localMap`, but the
 * capture planner still resolved the name to that block's slot and boxed it —
 * the closure then read the sibling's cell (marked's `walkTokens`: `illegal
 * cast`). This set lets the collision check cover those names too.
 */
export function namesDeclaredInsideClosure(closure: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isBindingElement(node) ||
        ts.isParameter(node) ||
        ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      names.add(node.name.text);
    }
    forEachChild(node, visit);
  };
  forEachChild(closure, visit);
  return names;
}

/**
 * Does a write target `name`'s captured binding? A same-spelled write that the
 * checker binds to a DIFFERENT declaration (a sibling function's own `let u`)
 * does not; counting it boxed the capture into one cell that every loop
 * iteration's closure then shared. Unknown identity on either side stays a
 * write (the previous, conservative answer).
 *
 * A `var` declarator (#6992) is a write only when it re-declares the KNOWN
 * captured binding — never the binding's own declarator, and never when the
 * captured declaration is unknown: a nested function expression's implicit
 * `arguments` has none, and an outer `var arguments = undefined` counted as its
 * write boxed it (ES5 arguments-object/10.6-6-3,4: `illegal cast`).
 */
export function capturedBindingWriteTest(
  ctx: CodegenContext,
  name: string,
  capturedDeclaration: ts.Declaration | undefined,
): (target: ts.Identifier) => boolean {
  return (target) => {
    if (target.text !== name) return false;
    const declarator = ts.isVariableDeclaration(target.parent) || ts.isBindingElement(target.parent);
    if (declarator && (capturedDeclaration === undefined || target.parent === capturedDeclaration)) return false;
    if (capturedDeclaration === undefined) return true;
    const written = ctx.oracle.valueDeclarationOf(target);
    return written === undefined || written === capturedDeclaration;
  };
}
