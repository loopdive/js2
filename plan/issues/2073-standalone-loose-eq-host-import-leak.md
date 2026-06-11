---
id: 2073
title: "standalone: mixed-primitive loose == emits env.__host_loose_eq into the binary — instantiation with zero imports fails"
status: done
sprint: 61
created: 2026-06-11
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: equality
goal: host-independence
related: [1990, 2049]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2073 — loose-eq fallback has no standalone gate or native path

## Problem

```ts
String("1" == 1)   // standalone binary imports env.__host_loose_eq
                   // → Import #0 "env" instantiation failure
```

Same for `"" == 0`. Violates the refuse-loudly invariant (#1888 family):
the compiler should either lower §7.2.13 IsLooselyEqual natively or refuse
at compile time — never emit a JS-host import under `--target standalone`.

## Root cause

`src/codegen/binary-ops.ts:851,885,1914` — the loose-eq fallback routes to
the `__host_loose_eq` JS-host import unconditionally.

## Fix direction

Native IsLooselyEqual for primitive tag pairs (string↔number, boolean,
null/undefined) in standalone mode; refuse loudly for object operands
until ToPrimitive (#1900) covers them.

## Acceptance criteria

- Repros return "true" standalone with zero env imports
- Host mode unchanged

## Dupe check

#1662 (done audit), #1990 (host-mode struct ToPrimitive), #1900/#1910
(object ToPrimitive — these are primitive operands). New.
