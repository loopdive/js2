---
id: 2079
title: "standalone: function* CEs with 'function index out of range' (late-import shift guard) — wasm-native generator lowering regressed; manual protocol leaks env import"
status: ready
sprint: 61
created: 2026-06-11
updated: 2026-06-11
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: host-independence
related: [2043, 2040]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2079 — generators unusable in standalone mode

## Problem

```ts
function* g(){ yield 1; yield 2; return 3; }
for (const v of g()) s += v;
// standalone: COMPILE-ERROR "function index out of range — undefined …
//   late-import index-shift class" at function 'g'
// node: works
```

The manual `it.next()` protocol variant instead emits an env import and
fails zero-import instantiation.

## Root cause

The late-import shift guard (#2043, done — refusing loudly as designed)
fires on the standalone generator lowering: the generator path still adds
late imports after the freeze point. Residual of #1665 (done, wasm-native
generators) — the native lowering doesn't fully cover standalone, so it
falls into the guarded legacy path.

## Fix direction

Make the #1665 native generator lowering the standalone path end-to-end
(no late host imports); the guard then never fires. Coordinate with #2040
(standalone generator destructuring runtime semantics).

## Acceptance criteria

- Repro compiles and returns "12"-equivalent standalone, zero env imports
- Manual next() protocol works; host mode unchanged

## Dupe check

#1665 (done — regressed/residual standalone), #2043 (guard correct),
#2040 (destructuring semantics, different). Filed as the concrete
standalone-generator residual.
