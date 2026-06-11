---
id: 2017
title: "assignment to a getter-only object-literal property traps 'illegal cast' instead of throwing strict-mode TypeError"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: objects
goal: core-semantics
related: [1092, 1932, 2024]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2017 — [[Set]] failure check missing on accessor-literal write path

## Problem

```ts
const o: any = { get x() { return 1; } };
o.x = 99;
// wasm: RuntimeError: illegal cast (uncatchable)
// node: TypeError: Cannot set property x ... which has only a getter
```

## Root cause

The accessor-literal path (`src/codegen/literals.ts:258+`) defines real
host accessors, but the compiled assignment path casts/writes without the
strict-mode [[Set]] failure check (§13.15.2 → §10.1.9). Same family as
#1092 (wrong error type, done) and the class-side #2024.

## Fix direction

When the static property model says get-only, emit a throw of TypeError
instead of the struct write.

## Acceptance criteria

- Repro throws catchable TypeError; getter+setter pairs unchanged

## Dupe check

#1092 done; #1932 is accessor double-get (different). New (borderline
low/wont-fix severity — filed for completeness).
