// (#6872) Leaf helper for the closure capture planner (arrow-phases.ts).
import { ts, forEachChild } from "../../ts-api.js";

/** Every name a declaration INSIDE `closure` binds (any nesting depth). */
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
