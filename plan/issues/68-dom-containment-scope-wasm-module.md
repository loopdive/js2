---
id: 68
title: "Issue 68: DOM containment — scope wasm module access to a subtree"
status: ready
created: 2026-03-03
updated: 2026-08-31
priority: high
horizon: m
feasibility: medium
reasoning_effort: max
task_type: bugfix
area: runtime, host-interop
goal: compiler-architecture
sprint: current
related: [593]
---
# Issue 68: DOM containment — scope wasm module access to a subtree

Depends on: [#67](67-closed-import-objects-replace-proxy.md) — Closed import
objects

## Summary

Restrict a wasm module's DOM access to a specific container element or shadow
root. Since #67 gives us a closed import object where every DOM function is an
explicit closure, we can intercept them to enforce containment.

## Motivation

A wasm module that declares `extern class Element` with `querySelector`,
`appendChild`, etc. can currently operate on the entire document. For plugin
sandboxing, we want to say: "this module can only touch elements inside
this `<div>` (or this shadow root)."

## Design

### `buildImports()` gains a `container` option

```ts
buildImports(manifest, deps, {
  domRoot: document.getElementById("plugin-root"),
  // or: domRoot: shadowRoot
});
```

When `domRoot` is set, DOM-related imports are wrapped with containment checks.

### What changes per import type

**Constructors** — `Document_querySelector`, `Document_getElementById`:
- Redirect to `container.querySelector(...)` instead of `document.querySelector(...)`
- The module never sees `document` as an externref

**Element traversal** — `Element_get_parentElement`, `Node_get_parentNode`:
- If the result is the container itself or above it, return `null`
- The module can't walk above its root

**Element mutation** — `Element_appendChild`, `Element_remove`:
- Check `container.contains(self)` before allowing the operation
- Throw if the target element is outside the container

**Dangerous properties** — `Element_get_ownerDocument`, `Node_get_baseURI`:
- Block entirely (return `null` or throw) when containment is active

**Safe passthrough** — `Element_get_textContent`, `Element_set_style`:
- Still check `container.contains(self)` but otherwise pass through

### Shadow root mode

When `domRoot` is a `ShadowRoot`, containment is even stronger:
- The shadow boundary naturally prevents CSS leaking
- `querySelector` is already scoped to the shadow tree
- No additional checks needed for most operations

### What the compiler contributes

The import manifest from #67 lists every DOM method the module uses. The
containment wrapper only needs to handle methods actually in the manifest.
This also lets us **audit at compile time**: "this module uses
`document.cookie`" → reject before instantiation.

### Pre-instantiation policy check

```ts
function checkPolicy(manifest: ImportDescriptor[], policy: Policy): string[] {
  const violations: string[] = [];
  for (const imp of manifest) {
    if (imp.intent.type === "extern_class") {
      const key = `${imp.intent.className}.${imp.intent.member}`;
      if (policy.blocked.has(key)) violations.push(key);
    }
  }
  return violations;
}
```

This lets the host reject a module before instantiation if it requests
capabilities outside the policy (e.g., `Document.cookie`, `Window.fetch`).

## Tests

- Mount a container div, instantiate module with `domRoot` set
- Verify querySelector is scoped to container
- Verify parentElement traversal stops at container
- Verify mutations outside container throw
- Verify shadow root mode works
- Verify policy check rejects blocked imports

## Complexity

M — ~250 lines in runtime.ts + new containment module

## 2026-08-31 — reopened: the implemented containment contract is incomplete

The Sol Ultra whole-project audit re-ran `tests/dom-containment.test.ts` on
upstream `main`: **15/19 passed, 4/19 failed**. The failing cases are both
above-root traversal checks plus outside-receiver mutation and property-set
checks. That directly violates this issue's original test contract.

Three implementation defects explain the result:

1. `src/runtime.ts:17878-17883` uses current-realm `instanceof Node`
   exclusively whenever global `Node` exists. Cross-realm nodes therefore
   become "not node-like"; the structural `nodeType` fallback is never tried.
   The current Node-less test mocks also omit `nodeType`, so receiver checks do
   not run for them.
2. Method wrappers at lines 17941-17955 call `self[member]` instead of the
   already-resolved `fn`, discarding resolver behavior and creating a second,
   divergent dispatch policy.
3. Root-relative outward mutation is exempted by `self !== domRoot`. Methods
   such as `remove`, `before`, `after`, `replaceWith`, and `insertAdjacent*`
   can therefore act on the containment root itself and alter its ancestors or
   siblings. `getRootNode` is blocked only in the property-get branch, not when
   represented as a method.

The same 123-line implementation is duplicated in
`src/runtime-containment.ts` with zero importers. Fix the production copy and
remove the unused duplicate under #3103 so the policy cannot drift again.
This is a host API containment/correctness contract, not a security boundary.

### Reopened acceptance criteria

- [ ] The existing containment suite passes 19/19 with positive controls.
- [ ] Same-realm, cross-realm, and structural test nodes receive identical
      containment decisions.
- [ ] `parentElement`/`parentNode` cannot expose an ancestor above `domRoot`.
- [ ] Outside receivers cannot be read, written, or mutated.
- [ ] Inward operations on the root remain allowed, while root-relative
      outward operations cannot alter ancestors or siblings.
- [ ] Allowed methods delegate through the resolved import function.
