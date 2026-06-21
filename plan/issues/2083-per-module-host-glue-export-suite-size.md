---
id: 2083
title: "per-module exported host-glue suite (__call_fn_*, __sget_*, __vec_*) dominates small-binary size and is unstrippable by wasm-opt"
status: ready
sprint: 64
created: 2026-06-11
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: performance
area: codegen
language_feature: compiler-internals
goal: performance
related: [1094, 1308]
origin: "2026-06-11 WAT quality review (fable agent): measured on main"
---

# #2083 — one closure triggers the full trampoline export suite

## Problem

A one-closure program (`const c = makeCounter(); c();`) emits 12 exported
helpers — `__call_fn_0/2/3/4`, `__call_fn_method_0..4`, `__is_closure`,
`__vec_len`, `__vec_get` — totaling 2,199 bytes after -O of which user
logic is ~300B; 137 ref.test/ref.cast survive -O, nearly all in
trampolines. `__vec_len`/`__vec_get` are exported even by an arith-only
program with no arrays. Per-shape `__sget_*/__sset_*/__struct_field_names`
add 7 more exports per object shape. Because they're EXPORTS, wasm-opt
cannot strip them.

## Root cause

`src/codegen/index.ts:1442-1494` — emitClosureCallExport{,1,2,3,4} +
emitClosureMethodCallExportN(0..4) fire when ANY closure of arity ≤ N
exists (one closure triggers the whole suite since lower-arity closures
accept dropped extra args); per-shape accessors at index.ts:1715-1872.

## Fix direction

Gate each export on an observed host-boundary escape (closure passed to a
host import / object crossing the boundary) instead of mere existence;
expected 5-10x smaller small modules. Related size lever: #1950
(upstream slug: default-on optimization pipeline).

## Acceptance criteria

- One-closure sample drops to <1KB post-O with no host-callback usage
- All host-interop tests still pass (exports appear when actually needed)

## Dupe check

#1094 (JS-side runtime), #1308 (introduced trampolines), #1888, upstream
#1950 — orthogonal; none gate exports on escape analysis. New.

## Disposition (PO true-up 2026-06-21, sprint-64, origin/main d0bf058bc) — CONFIRMED OPEN (perf, no functional repro)

Re-measured the one-closure repro (`makeCounter()` + `c()`) with `optimize: true`
on current main: the binary is 3,021 B and exports **17 trampoline helpers** —
`__vec_len`/`__vec_get`/`__vec_mut_supported`/`__vec_push`/`__vec_pop` (despite no
arrays in the program), `__call_fn_0..4`, `__call_fn_method_0..5`, `__is_closure`.
The full export suite still fires on existence, not on a host-boundary escape.
Premise confirmed.

**Stays `status: ready`. Perf/size optimization — no test262 pass-count movement.**
BACKLOG candidate for a conformance sprint; the value is small-binary size, not
conformance. De-prioritise out of the active sprint-64 dispatch queue. Escape
analysis is the right fix but it is `feasibility: medium` perf work, not a sprint-64
standalone-conformance priority. See #1927 disposition for the cluster.
