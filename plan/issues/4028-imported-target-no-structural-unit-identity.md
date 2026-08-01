---
horizon: m
id: 4028
title: "ESLint frontier: 'imported target MurmurHash3 has no exact structural unit identity'"
status: ready
created: 2026-08-01
updated: 2026-08-01
assignee: unassigned
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: multi-module-compilation
goal: npm-library-support
sprint: current
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
