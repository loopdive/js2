// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6979 S7-d) DOM platform capability: confine an `extern_class` binding to
 * the embedder-supplied `domRoot` subtree (`buildImports(..., { domRoot })`)
 * when no compiled DOM capability runtime owns the imports. Split out of
 * `src/runtime.ts`.
 */

import type { ImportIntent } from "../index.js";

/** Wrap an extern_class import function with DOM containment logic.
 *  Restricts DOM access to the subtree rooted at `domRoot`. */
export function wrapWithDomContainment(
  fn: Function,
  intent: ImportIntent & { type: "extern_class" },
  domRoot: Element | ShadowRoot,
): Function {
  const { className, action, member } = intent;

  // Traversal properties that could escape containment
  const traversalProps = new Set(["parentElement", "parentNode", "offsetParent"]);

  // Dangerous properties — block entirely (return null)
  const blockedProps = new Set(["ownerDocument", "baseURI", "getRootNode"]);

  // (#6792) Members that mutate the receiver's PARENT or siblings. On a contained
  // node that stays inside the fence; on domRoot itself it writes outside it, so
  // the root may use only its inward mutators (append, innerHTML, "beforeend", …).
  const outwardMethods = new Set(["remove", "after", "before", "replaceWith"]);
  const outwardSetters = new Set(["outerHTML", "outerText"]);
  const outwardPosition = /^(?:beforebegin|afterend)$/i; // insertAdjacent* position
  const rootViolation = (verb: string) =>
    new Error(`DOM containment violation: ${verb} "${member}" on the container root would mutate outside it`);

  // Helper: check if domRoot contains an element (duck-typed for mock objects)
  function isContained(el: any): boolean {
    if (el === domRoot) return true;
    if (typeof (domRoot as any).contains === "function") {
      return (domRoot as any).contains(el);
    }
    return true; // If domRoot doesn't support contains, pass through
  }

  // Helper: check if a value is a DOM node
  function isNodeLike(v: any): boolean {
    if (v == null || typeof v !== "object") return false;
    // Prefer instanceof Node when available (browser environment)
    if (typeof Node !== "undefined") return v instanceof Node;
    // Fallback: check for nodeType (a number), the most reliable DOM indicator
    return typeof v.nodeType === "number";
  }

  // For "new" action — constructor (e.g. new Document)
  if (action === "new" && className === "Document") {
    return () => domRoot;
  }

  // For get actions
  if (action === "get" && member) {
    if (blockedProps.has(member)) {
      return (_self: any) => null;
    }
    if (traversalProps.has(member)) {
      return (self: any) => {
        const result = self[member];
        if (result == null) return result;
        if (isNodeLike(result) && !isContained(result)) return null;
        return result;
      };
    }
    // Safe property — containment check on self
    return (self: any) => {
      if (self !== domRoot && isNodeLike(self) && !isContained(self)) {
        throw new Error(`DOM containment violation: accessing "${member}" on element outside container`);
      }
      return self[member];
    };
  }

  // For set actions
  if (action === "set" && member) {
    return (self: any, v: any) => {
      if (self === domRoot && outwardSetters.has(member)) throw rootViolation("setting");
      if (self !== domRoot && isNodeLike(self) && !isContained(self)) {
        throw new Error(`DOM containment violation: setting "${member}" on element outside container`);
      }
      self[member] = v;
    };
  }

  // For method actions
  if (action === "method" && member) {
    // Document query methods — redirect to domRoot
    if (
      (className === "Document" || className === "document") &&
      (member === "querySelector" ||
        member === "querySelectorAll" ||
        member === "getElementById" ||
        member === "getElementsByClassName" ||
        member === "getElementsByTagName")
    ) {
      return (_self: any, ...args: any[]) => (domRoot as any)[member](...args);
    }
    // createElement is safe — just creates a detached element
    if ((className === "Document" || className === "document") && member === "createElement") {
      return fn;
    }

    // Containment check on self; on the root itself, refuse the outward subset.
    const adjacent = member.startsWith("insertAdjacent");
    return (self: any, ...args: any[]) => {
      if (self === domRoot) {
        // Convert the position once so the value checked is the value the DOM sees.
        if (adjacent && args.length > 0) args[0] = `${args[0]}`;
        if (outwardMethods.has(member) || (adjacent && outwardPosition.test(args[0]))) throw rootViolation("calling");
      } else if (isNodeLike(self) && !isContained(self)) {
        throw new Error(`DOM containment violation: calling "${member}" on element outside container`);
      }
      return self[member](...args);
    };
  }

  // Default: return original
  return fn;
}
