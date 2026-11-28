---
id: 7652
title: "A re-export of a Node builtin through another module (`export * as ev from 'events'`) synthesizes a namespace instead of binding the host module"
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

# #7652 — the #5330 builtin decline checks only the importing specifier

Found by the release review of [#7625](./7625-named-import-of-module-namespace-reads-null.md) (PR #7580).

```js
// node_modules/events/index.js (a package named like the builtin)
export function f() { return 7; }
// mid.js
export * as ev from 'events';
// main.js
import { ev } from './mid.js';
export function main() { return ev === null ? 0 : (typeof ev.EventEmitter === "function" ? 2 : 1); }
// node: 2 (the builtin events module); ours on b391ce84ad: 1 (a namespace synthesized from the package);
// ours on origin/main 4aa8ea4c46: 0 (null). No `__node_events` import in either build.
```

- Measured 2026-11-28 with `compileProject` (gc, `platform: "node"`, `allowJs`).
- The decline in `tryEmitCompiledModuleNamespaceObject` reads the specifier of the import that binds `ev`
  (`'./mid.js'`), not the `'events'` specifier further down the alias chain. The nested-namespace slot of
  `moduleSymbolNamespaceExports` has the same blind spot, already on main: `import * as m from './mid.js'; m.ev`
  answers 1 on both `b391ce84ad` and origin/main.
- Not fixed here: checking every specifier on the chain needs a walk of the checker's alias chain at both sites (raw
  checker calls), which is not a small, byte-neutral change. The fix is to serve such a binding from the host module,
  as `hostMemberOf` does for named members.
