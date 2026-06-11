---
id: 2071
title: "constructor returning a foreign plain object cannot override `this` — ctor Wasm return type is (ref $Struct), needs externref-based return ABI"
status: ready
sprint: Backlog
created: 2026-06-11
updated: 2026-06-11
priority: low
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: classes
goal: core-semantics
related: [2018, 2026]
origin: "2026-06-11 follow-up from #2018 fix (PR loopdive#1326): foreign-object override out of scope there"
---

# #2071 — `constructor() { return { x: 99 } as any; }` falls back to `this`

## Problem

Per §10.2.1.3, a constructor returning an object overrides `this` for the
`new` expression. After #2018 (PR loopdive#1326) the trap is gone and
same-class object overrides (`return this`, `return new SameClass()`)
work, but a *foreign* plain object (`return { x: 99 } as any`) is not
representable: the ctor's Wasm return type is `(ref $Struct)` and every
`new` site is hard-typed to it, so the fix falls back to returning `this`
(observable: `new A().x` → 1 instead of 99). Non-trapping but
spec-divergent.

## Root cause / constraint

Constructor return ABI. True foreign-object override requires the
constructor return type (and all `new` sites + downstream property access)
to accept an externref/any-carrier, or a dual-return scheme (struct ref +
optional override slot). Touches `compileNewExpression`
(src/codegen/expressions/new-super.ts), ctor signature emission, and the
return lowering added in #2018 (src/codegen/statements/control-flow.ts).

## Fix direction

Candidates (architect input useful, relates to #2026 first-class
constructor descriptors): (a) dual-slot return struct, (b) externref ctor
ABI with ref.cast at statically-typed `new` sites, (c) keep current ABI
and reject foreign override at compile time with a diagnostic instead of
silent `this`.

## Acceptance criteria

- `class A { x = 1; constructor() { return { x: 99 } as any; } } new A().x` → 99
  (or, if (c) is chosen, a loud compile-time diagnostic — documented decision)
- No regression in #2018's tests; `new` perf on the common path unchanged

## Dupe check

#2018 (PR #1326) explicitly documents this as out-of-scope follow-up;
#2026 (class-as-value) is the adjacent ABI family. No existing issue
covers ctor object-override representation.
