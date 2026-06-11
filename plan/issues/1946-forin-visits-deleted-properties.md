---
id: 1946
title: "for-in visits properties deleted during enumeration (eager key snapshot, no per-visit liveness check)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: for-in
goal: property-model
related: [1243]
origin: "2026-06-10 deep-audit sweep (control-flow agent): verified miscompile on main"
---

# #1946 — for-in ignores deletions made during the loop body

## Problem

[EnumerateObjectProperties (§14.7.5.10)](https://tc39.es/ecma262/#sec-enumerate-object-properties)
requires that a property deleted before being visited is not visited. The
compiler snapshots all keys eagerly and indexes through the snapshot with no
liveness re-check.

## Repro (verified on main)

```ts
export function forInDelete(): string {
  const obj: any = { a: 1, b: 2, c: 3 };
  let s = "";
  for (const k in obj) { s = s + k; if (k === "a") { delete obj.c; } }
  return s;
}
```

wasm: `"abc"` — node: `"ab"`.

## Root cause

`src/codegen/statements/loops.ts:4300-4319` (`compileForInStatement`) snapshots
all keys up front via the `__for_in_keys` host import (`src/runtime.ts:7657`
builds a complete key array eagerly), then indexes through the snapshot with no
per-visit check.

## Fix direction

Before binding each key, emit a has-property guard (`in`-style host or native
check against the live object) and `continue` when absent. The snapshot itself
is spec-permitted (own keys at start); only the per-visit existence check is
missing. Needs a standalone-mode equivalent for the native object path
(dual-mode policy).

## Acceptance criteria

- Repro matches Node (`"ab"`)
- Properties *added* during enumeration may or may not be visited (spec
  latitude) — but deleted ones never are
- No regression in plain for-in enumeration order tests

## Dupe check

Grepped `for-in` + `delete`, `snapshot`: #1243 (done — feature work for
enumerating compiled-object props, no deletion semantics). Not covered.
