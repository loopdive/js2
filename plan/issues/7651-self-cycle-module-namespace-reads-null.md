---
id: 7651
title: "A module that re-exports its own namespace (`export * as ns from "./dep"` in dep) reads null"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7625]
---

# #7651 — a self-referencing module namespace reads null

Found by the release review of [#7625](./7625-named-import-of-module-namespace-reads-null.md) (PR #7580).

```ts
// dep.ts
export * as ns from "./dep";
export let g = 7;
// entry.ts
import { ns } from "./dep";
import * as d from "./dep";
export function main(): number { return ns.g * 10 + 3; } // node: 73; ours: compiles, main() throws (all 4 lanes)
// (ns !== null ? 10 : 0) + (ns === d ? 1 : 0)             // node: 11; ours: 1 (both sides null)
```

- Measured 2026-11-28 on `b391ce84ad`, gc/standalone × IR on/off. `import * as m from "./dep"; m.ns.g` throws in all
  4 lanes on both `b391ce84ad` and origin/main `4aa8ea4c46`.
- Likely cause: `moduleSymbolNamespaceExports` declines a module whose export list contains itself (the `visiting`
  cycle guard), so the whole namespace object declines and every route reads null. A self-reference needs the
  nested slot to point at the object being built, not a decline.
- Pinned in `tests/issue-7625-module-namespace-import-binding.test.ts` (the two `self-cycle` rows).
