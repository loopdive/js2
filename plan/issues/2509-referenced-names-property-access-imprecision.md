---
id: 2509
title: "referencedNames over-collects property-access names → spurious env.<name> ambient-global imports (e.g. obj.close)"
status: done
assignee: dev-builtins
completed: 2026-07-17
sprint: current
created: 2026-06-19
updated: 2026-07-17
priority: low
feasibility: medium
reasoning_effort: low
task_type: bug
area: codegen
language_feature: host-imports
goal: correctness
parent: 2520
depends_on: [2520]
# (#2509) The property-name skip guard + its rationale belong in
# collectReferencedGlobalNames, which is defined in extern-declarations.ts; a
# +10 LOC correctness fix in its own module warrants the allowance.
loc-budget-allow:
  - src/codegen/extern-declarations.ts
---

## Problem

Follow-up to #2520. The `referencedNames` gate used to decide which ambient
globals to register as host imports is collected by walking **every**
`ts.Identifier` in user source:

```ts
const collectRefs = (node: ts.Node): void => {
  if (ts.isIdentifier(node)) referencedNames.add(node.text);
  forEachChild(node, collectRefs);
};
```

This includes **property-access member names**. So `port.close()`,
`obj.open`, `x.toString()`, `e.stopPropagation` etc. add `close`, `open`,
`toString`, … to `referencedNames` even though the user never refers to the
global `close`/`open`/`toString` functions. When such a name collides with an
ambient `declare function` global, a spurious `env.<name>` host import is still
emitted.

This is the residual imprecision noted in #2520: the #2520 gate cuts the flood
from ~60 unconditional imports down to "only names appearing anywhere as an
identifier", but property names that happen to collide with global functions
(`close`, `open`, `stop`, `focus`, `blur`, `print`, `toString`, `postMessage`,
`addEventListener`, `fetch`, …) still slip through.

The same imprecision exists in `collectDeclaredGlobals`, which has historically
been tolerated — hence low priority.

## Fix sketch

Tighten `referencedNames` collection to count only identifiers that resolve to a
**global/bare** reference, not property-access member names. Options:

- Skip `ts.Identifier` nodes that are the `.name` of a `PropertyAccessExpression`
  (i.e. `node.parent` is a `PropertyAccessExpression` and `node === parent.name`).
  Also skip property names in object-literal keys / member declarations.
- Or use the checker: only add a name when `checker.getSymbolAtLocation(id)`
  resolves to the ambient global declaration (most precise; slightly costlier).

The property-access skip is cheap and removes the bulk of the false matches.

## Acceptance criteria

- A file whose only occurrence of a global-function name is a property access
  (e.g. `port.close()` with no global `close` usage) emits **no**
  `env.close` import.
- Genuine bare-identifier / call usage (`close()`, `fetch(...)`) still registers
  the import.
- Regression test covering the `obj.close()` vs `close()` distinction.

## Notes

Strictly an over-emission / noise refinement — no correctness regression in
emitted programs, just extra unused imports. Sequenced after #2520.
