---
horizon: m
id: 4028
title: "ESLint frontier: 'imported target MurmurHash3 has no exact structural unit identity'"
status: done
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-01
assignee: ttraenkler/claude
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: multi-module-compilation
goal: npm-library-support
sprint: 78
required_by: [1282, 1400, 2693]
es_edition: n/a
related: [1282, 3520, 3672, 4001, 4018, 4019]
---

# #4028 — imported target has no exact structural unit identity

## Problem

The second hard error now blocking ESLint `linter.js`, reachable only after
#4001, #4018 and #4019:

```text
Codegen error: imported target MurmurHash3 has no exact structural unit identity
```

`MurmurHash3` is a class imported across the resolved package graph. The
structural-ABI sidecar requires every imported call target to map to an exact
inventory unit, and this one does not resolve.

## Analysis

Same family as the inherited-alias defect recorded in #3672 and the class
callable planning work in #3520: the ABI sidecar's unit inventory does not cover
some shape reachable through a cross-package import edge. The specific question
is *why* the imported `MurmurHash3` produces no unit — candidates:

- the class is exported through a re-export chain the inventory does not follow,
- it is a CJS-interop shape whose canonical declaration is not the one the
  importer binds,
- the unit exists but under a different source id than the importer's edge.

## Acceptance criteria

- A reduced fixture reproduces the missing unit identity without ESLint.
- The root cause distinguishes "the inventory genuinely lacks a unit" from
  "the lookup used the wrong key" — #3672's inherited-alias defect was the
  latter, and mistaking one for the other produced a throw where an early
  return was correct.
- ESLint `linter.js` advances past this diagnostic.

## Root cause (2026-08-01) — the resolver admits targets the inventory cannot own

It is the **lookup key population**, not a missing unit: `MurmurHash3` is not
inventoried because it is **not a top-level function**.

`imurmurhash` uses the ordinary UMD/IIFE shape:

```js
(function(){
    var cache;
    function MurmurHash3(key, seed) { … }
    …
})();
```

`targetUnitIdByDeclaration` (`src/ir/imported-functions.ts`) is populated ONLY
from `sourceFile.statements` — top-level `FunctionDeclaration`s, the population
the unit inventory authors. But `targetForSymbol` accepts **any** bodied,
non-ambient `FunctionDeclaration` in the source set, with no top-level
requirement. So a nested declaration was admitted as a direct-call target that
the inventory can never own, and the failed lookup was reported as an invariant
violation that aborted the whole compile.

The asymmetry was already visible in the same file: `resolveTopLevelFunctionValue`
re-checks `sourceFile.statements.some(s => s === target.declaration)`, and
`resolveImportedFunction` did not.

Because the IIFE-wrapped module is one of the most common shapes in the npm
ecosystem, this would fire well beyond ESLint.

## Fix

`attachIdentity` returns `undefined` — "not direct-call evidence", the same
supported outcome every other guard in that resolver produces — when the target
declaration is not a top-level statement of its source file. The call then
lowers through the ordinary non-direct path.

A **top-level** declaration missing from the map is still a genuine
inventory↔AST desync and still hard-fails, so the invariant keeps its real
purpose.

## Verification gap — stated rather than papered over

**No dedicated regression test ships with this fix.** Two synthesized repros (a
`FunctionDeclaration` inside an IIFE and one inside a block, imported and called
across modules) compiled **clean on the unfixed base**, and compiling the real
`imurmurhash` package alone also succeeds on the unfixed base — the defect needs
the importer context and active identity planning that only the large graph
supplies. Shipping any of those would have been a vacuous test.

The real coverage is the ESLint frontier rung in
`tests/stress/eslint-tier1.test.ts`, which pins the graph's exact diagnostic and
goes red whenever the frontier moves. Evidence for this fix is that the ESLint
graph advanced past this diagnostic to #4033.

A cheap, fast reproducer is still wanted; it is the main follow-up here.
