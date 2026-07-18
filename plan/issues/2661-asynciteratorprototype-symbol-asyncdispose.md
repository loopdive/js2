---
id: 2661
title: "AsyncIteratorPrototype[Symbol.asyncDispose] — explicit-resource-management disposal protocol (7 test262 fails)"
status: ready
sprint: Backlog
created: 2026-06-25
priority: low
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen, runtime
language_feature: async-iterators, explicit-resource-management
goal: spec-completeness
parent: 1344
related: [2029]
test262_bucket: built-ins/AsyncIteratorPrototype
---

# #2661 — `%AsyncIteratorPrototype%[Symbol.asyncDispose]` (split from #1344)

Split from **#1344** (2026-06-25, sd-2651). The #1344 re-ground found the
`built-ins/AsyncIteratorPrototype` fails (7 on current `main`) are **not** the
generator return/throw try/catch/finally residual that #1344 now tracks — they
are the **`Symbol.asyncDispose`** method on `%AsyncIteratorPrototype%`, an
**explicit-resource-management** feature (ES2026 `using`/`await using` disposal
protocol). Different layer, different feature → own issue.

## Failing rows (baseline jsonl, current `main`)

```
built-ins/AsyncIteratorPrototype/Symbol.asyncDispose/throw-return-getter.js
built-ins/AsyncIteratorPrototype/Symbol.asyncDispose/name.js
built-ins/AsyncIteratorPrototype/Symbol.asyncDispose/is-function.js
… (7 total under built-ins/AsyncIteratorPrototype/, all Symbol.asyncDispose/* +
   Symbol.asyncIterator/*)
```

## Scope

`%AsyncIteratorPrototype%[Symbol.asyncDispose]` (§27.1.3.1-ish in the
explicit-resource-management proposal): the well-known `@@asyncDispose` method
that closes the async iterator (`return()` it) and returns a promise. Tests check
it is a function, its `.name` is `[Symbol.asyncDispose]`, its `.length`, and that
it forwards to the iterator's `return`.

## Boundary with #2029 (cross-reference)

#2029 is the broader **disposal-protocol cluster** (`SuppressedError` /
`DisposableStack` / `using`). sd-2038 is touching #2029 as an **EMIT-CRASH**
bucket (a different layer — the codegen crash, not the per-method feature gap).
This issue (#2661) is the **`%AsyncIteratorPrototype%` well-known-method feature
gap** specifically — no direct collision, but the two share the
`Symbol.asyncDispose` / `Symbol.dispose` well-known-symbol plumbing, so coordinate
the symbol registration if both are in flight.

## Acceptance

- The 7 `built-ins/AsyncIteratorPrototype` rows pass (host + standalone).
- `%AsyncIteratorPrototype%[Symbol.asyncDispose]` is a function with the correct
  `name`/`length`/`@@asyncDispose` descriptor; calling it `return()`s the async
  iterator and resolves.

## Routing

Low priority (a narrow well-known-method feature, 7 rows). Pick up after the
#1344 generator state-machine slices and #2029's disposal cluster settle so the
shared well-known-symbol plumbing is stable.
