---
id: 7023
title: "standalone: an extensionless relative require that TypeScript resolves to a sibling .d.ts compiles the declaration face, not the package body"
status: ready
sprint: Backlog
created: 2026-10-16
updated: 2026-10-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: npm-compat, standalone, module-resolution
goal: standalone
requested_by: ttraenkler/wave14-three-stylelint-leaks
related: [6843, 6666, 1559, 4287]
---

# #7023 — relative `.d.ts` faces hide package bodies from the project graph

## Problem

`ModuleResolver.resolve` (`src/resolve.ts`) asks TypeScript to resolve every
edge. For an extensionless relative specifier, TypeScript prefers a sibling
declaration file over the JavaScript body: `require("./pattern")` resolves to
`pattern.d.ts`, not `pattern.js`. Two redirects already exist, for bare
packages (#1559) and for the explicit `./x.js` spelling (Moment), but there is
none for this one. The graph walker therefore compiles the `.d.ts` in place of
the body. This is common in tsc-built CommonJS packages: fast-glob,
`@nodelib/*`, postcss, source-map-js and cosmiconfig all hit it in
stylelint's graph.

Since #6843, standalone no longer turns those declarations into `env.*` host
imports. Each one is a warning, and a use of it throws. That keeps the module
host-free, but it does not make the code work: postcss's `Result`,
`Stringifier` and `PreviousMap` paths throw instead of running.

## Measured (2026-10-16, upstream/main `ee58c1aa26`)

A standalone-only redirect (relative edge from a `.js`/`.mjs`/`.cjs`
importer, resolved `X.d.ts` → existing sibling `X.js`) was implemented and
measured during #6843:

- **postcss alone**: 21 `env.*` extern-class leaks → 0, with the real
  `lib/*.js` bodies compiled. Its remaining blocker is a validation error,
  `LazyResult_async: extern.convert_any[0] expected type anyref, found call of type externref`,
  the same class as three's #7015.
- **stylelint**: the graph grew from 379 to 414 files. One of the added files
  is `typescript/lib/typescript.js` (9.1 MB). cosmiconfig `dist/loaders.js`
  lazily does `require('typescript')` for `.ts` config files, and the #6666
  nested-require hoist links that edge into the static graph; until now
  `loaders.d.ts` hid it. Codegen's `object-widening` phase ran for more than
  30 min, against 6.6 s on base. The compile did not finish in about 2 h.

## Implementation Plan

1. Re-land the standalone resolver redirect (the diff is quoted in #6843's
   "Rejected" section).
2. Before or with it, decide how a function-nested `require()` of a large
   optional dependency enters the standalone graph. cosmiconfig only loads
   `typescript` for `.ts` configs. Options:
   - leave a nested `require` unlinked when its package is not otherwise
     reachable, so that at runtime it throws `Cannot find module`;
   - add a size cap or a `standaloneExternalPackages` denylist.
3. Measure every npm-compat standalone lane before and after. The redirect
   enlarges graphs, and codegen time is already over the CI budget (#4287).
