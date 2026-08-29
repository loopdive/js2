---
id: 5176
title: "Proxy ownKeys trap's return value is ignored entirely — a trap returning ['x'] still yields length 0"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [3481]
---

# `ownKeys` trap results never reach the caller

Found during the #3481 `symbol[]` slice (PR #5198) and **proved symbol-unrelated
on base**: a Proxy whose `ownKeys` trap returns a plain string-key literal —

```js
const p = new Proxy({}, { ownKeys: t => ['x'] });
Object.getOwnPropertyNames(p).length   // 0, spec: 1
```

— also yields length `0`. The trap runs (or is never consulted — the dispatched
fix must establish which); its return value is discarded either way.

This is what still blocks the third `symbol[]` test262 row after PR #5198:
`built-ins/Proxy/ownKeys/call-parameters-object-getownpropertysymbols.js` now
loses its Symbol-coercion error and fails on
`SameValue(«undefined», «Symbol(a)»)` — the keys list comes back empty. The
measurement trail is in PR #5198's body ("The third `symbol[]` row does not
flip") and the #3481 issue file's updated cluster record.

First step: establish whether the MOP routing for `getOwnPropertyNames`/
`getOwnPropertySymbols`/`Reflect.ownKeys` ever consults the proxy handler at
all in each lane, or consults it and drops the result — the fix differs.

## Acceptance criteria

- The shape above answers `1` (and the trap-invocation route per lane is
  recorded, measured); the #3481 third row's failure moves past the empty-keys
  stage or flips to pass.
- Byte-identity for programs with no Proxy `ownKeys` usage (per-row sha256
  over a reachable cohort); pinned tests red on base; equivalence shards
  clean by name.
