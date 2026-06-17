---
id: 2188
title: "standalone: sibling Error subclasses share the parent $tag — instanceof can't distinguish them (per-user-class brand)"
status: ready
sprint: Backlog
created: 2026-06-17
updated: 2026-06-17
priority: low
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: errors, classes
goal: standalone-mode
related: [1536c, 1536, 1455, 2101]
origin: "2026-06-17 — precision residual found while closing #1536c (standalone user Error subclass)"
---

# #2188 — standalone Error-subclass instanceof precision

## Problem

`#1536c` made `class MyError extends Error {}` instantiate and resolve
`instanceof` natively in standalone (zero host imports). The instance is the
parent's `$Error_struct`, discriminated by the parent's `$tag`. That is exact
for a single subclass, but **two distinct `extends Error` siblings share the
same parent `$tag`**, so `instanceof` cannot tell them apart:

```ts
class A extends Error {}
class B extends Error {}
export function test(): number {
  return (new A("x")) instanceof B ? 1 : 0;  // standalone wasm: 1   node: 0
}
```

(`#1536c`'s acceptance — single subclass, `instanceof Self`/`instanceof Parent`
— is correct; this is the sibling-disambiguation residual.)

## Root cause

`emitWasiErrorConstructor`'s `$Error_struct` carries the **builtin** type tag
(`Error` / `TypeError` / …), not a per-user-class brand. The standalone
instanceof path (identifiers.ts, `userErrorParent`, #1536c) compares against the
parent's `collectErrorInstanceOfTags` set, which is identical for every direct
subclass of the same builtin error.

## Fix direction

Give externref-backed user Error subclasses a **per-class brand** on the
instance (or a `$ClassMeta`/`$parentTag` slot) so `instanceof Sub` checks the
brand chain, not only the builtin parent tag. This is the `$ClassMeta` /
`$parentTag` externref-backed-subclass discrimination work tracked under #2101;
#1536c deliberately used the coarser parent-tag check to ship the
single-subclass case host-free. Coordinate with #2101 and the host-mode
`__tag_user_class` chain (#1455) so JS-host and standalone agree.

## Acceptance criteria

- `class A extends Error {}; class B extends Error {}; (new A()) instanceof B`
  → `false` (standalone), `(new A()) instanceof A` → `true`,
  `(new A()) instanceof Error` → `true`.
- Multi-level user chains (`class C extends A {}`) resolve correctly.
- #1536c single-subclass tests stay green; JS-host mode unaffected.

## Notes

Split from #1536c (single-subclass standalone Error subclass — `done`). See
#1536c's `## Resolution` and #2101 for the brand machinery.
