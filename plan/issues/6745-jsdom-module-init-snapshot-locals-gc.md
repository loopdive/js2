---
id: 6745
title: "perf: jsdom standalone compile stalls in the first module-init pass — snapshotLocals copies the whole localMap per speculative compile (GC-bound)"
status: ready
sprint: Backlog
created: 2026-09-29
updated: 2026-09-29
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: compiler
goal: npm-library-support
requested_by: ttraenkler/sendev-standalone
related: [6741, 6737, 1847, 1919]
files:
  - src/codegen/context/locals.ts
  - src/codegen/context/speculative.ts
---

# #6745 — jsdom: `snapshotLocals` makes the first module-init pass GC-bound

## Problem

With the quadratic module-init census check gone
([#6741](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6741-jsdom-standalone-quadratic-module-init-census)),
the jsdom `standalone-dynamic` lane still does not reach a verdict. The
compile gets through `analyze` (~20 s) and `codegen/collect-declarations`
(~28 s) and then sits in the FIRST body source's first module-init pass:

```
[js2:profile]   START codegen/bodies
[js2:profile]     START codegen/bodies/node_modules/.pnpm/tldts-core@7.4.10/node_modules/tldts-core/dist/es6/src/domain.js
[js2:profile]       START codegen/bodies/node_modules/.pnpm/tldts-core@7.4.10/node_modules/tldts-core/dist/es6/src/domain.js/module-init-pass1
```

Inspector CPU windows of that pass (2026-09-29, `compileProject` on the lane
driver, `optimize: 0`, branch of #6741):

| window | GC | `snapshotLocals` self | `compileDeclarations` incl. | `compileObjectLiteral` incl. | census check |
|---|---|---|---|---|---|
| 240 s | 125.0 s (52 %) | 50.9 s (21 %) | 115.3 s (48 %) | — | 0 % |
| 180 s | 108.6 s (60 %) | 15.2 s (8.5 %) | 71.7 s (40 %) | 33.2 s (18 %) | 0 % |

`snapshotSpeculative` → `snapshotLocals` copies `fctx.localMap.entries()`
(and the capture/TDZ maps) into fresh arrays on EVERY speculative compile —
`speculative.ts` documents it as "near-O(1) … locals are typically tiny".
In the flattened module-init function the local count is very large, so
each object-literal / expression probe allocates an O(locals) array: the
pass is quadratic in allocation and the process is GC-bound.

## Suggested fix

Make the locals snapshot O(changes), not O(locals): journal `localMap`
writes (set / re-point / delete) while a speculative scope is open and undo
the journal on rollback, or copy-on-write the map at the first mutation
inside the probe. `restoreLocals` must keep restoring the EXACT snapshot
state (re-pointed names included, #1847), and nested speculative scopes must
compose.

## Acceptance

- jsdom `--lane standalone-dynamic` gets past the first module-init pass and
  reaches a verdict (pass or a named codegen blocker); report the next
  blocker verbatim.
- Emitted binaries byte-identical on the dogfood-validation set.
