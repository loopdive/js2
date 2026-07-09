---
id: 3108
title: "Decompose giant runtime-helper emitter functions (ensureObjectRuntime 6,960; ensureNativeStringHelpers 4,851; ensureAnyHelpers 1,815; ensureProxyRuntime 1,273)"
status: ready
sprint: Backlog
created: 2026-07-09
updated: 2026-07-09
priority: medium
horizon: l
feasibility: medium
model: opus
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
related: [3104, 3105, 3114]
---

# #3108 — Decompose the giant `ensure*` runtime-emitter functions

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured)

The standalone runtime is emitted by a handful of monolithic functions that
define dozens of Wasm helper functions each, in one linear body:

| Function                    | Size            | File                                 |
| --------------------------- | --------------- | ------------------------------------ |
| `ensureObjectRuntime`       | **6,960 lines** | `src/codegen/object-runtime.ts:176`  |
| `ensureNativeStringHelpers` | **4,851 lines** | `src/codegen/native-strings.ts:215`  |
| `ensureAnyHelpers`          | 1,815 lines     | `src/codegen/any-helpers.ts:846`     |
| `ensureProxyRuntime`        | 1,273 lines     | `src/codegen/object-runtime.ts:7270` |
| `ensureRegexRun`            | 1,098 lines     | `src/codegen/native-regex.ts:251`    |

`object-runtime.ts` (9,726 LOC, **+1,892 in the last 12 days**, 10%
duplicated lines) and `native-strings.ts` (7,880 LOC, 12% duplicated) are the
#4 and #7 largest files in src/. Inside these bodies, helper definitions are
closures over dozens of shared locals (`anyStrTypeIdx`, flag constants,
`emitHasOwn`-style local lambdas), so ADDING one helper means scrolling a 7k-
line function to find the right insertion point — and the insertion point
MATTERS because function-index assignment follows emission order.

## Fix — mechanical section extraction, order-preserving

Do NOT redesign the runtime. Split each monolith into per-concern emitter
functions that the original calls **in the exact same order**:

```
object-runtime.ts        (orchestrator: ensureObjectRuntime — dep preamble +
                          ordered calls + returns ObjectRuntimeTypes)
object-runtime/
  props-core.ts          — $Object struct, key classify/match, get/set/has/delete
  descriptors.ts         — defineProperty/getOwnPropertyDescriptor/flags
  integrity.ts           — freeze/seal/preventExtensions predicates + setters
  enumeration.ts         — keys/values/entries/for-in order
  wrappers.ts            — primitive-wrapper helpers
  proxy.ts               — ensureProxyRuntime (already a separate function)
```

(analogous split for `native-strings.ts`: core flatten/equals/compare,
concat/slice family, encode/decode, anyToString.)

Shared state between sections travels in ONE explicit context object built at
the top (`interface ObjectRuntimeEmit { anyStrTypeIdx; nativeStrTypeIdx;
propsTypeIdx; …; emitHasOwn(name): void }`) — this makes today's implicit
closure-capture graph visible and greppable.

## Safety story (byte-identity provable — this is the critical part)

Function indices in the emitted module depend on **definition order**. The
refactor must preserve the exact sequence of `ctx.mod.functions.push` /
`funcMap.set` calls. Protocol:

1. `prove-emit-identity.mjs` golden baseline (all targets — these emitters
   run mainly under `standalone`/`wasi`, which the matrix covers).
2. Extract ONE section into a function called at the same position; shared
   locals become fields of the emit-context object; commit.
3. `check` → IDENTICAL required. Because helper emission order is the exact
   bug surface here, any accidental reorder fails the hash immediately.
4. Repeat per section (~6 commits per monolith).

The corpus caveat: `website/playground/examples` (13 files) may not exercise
every helper; before starting, extend the proof corpus with
`--root tests/standalone-corpus` (a new directory of ~20 small .ts probes
that force object-runtime/string-helper emission — Object.keys/freeze/
defineProperty/Proxy/string concat+compare in standalone mode). The corpus
addition is part of this issue's slice 0.

## Estimated LOC delta

Net ≈ 0 (motion); dedup of the repeated guard/scaffold blocks inside
(object-runtime has 1,014 duplicated-window lines; proxy guard idiom alone is
×12 — coordinate with #3105 builders) ≈ **−500 to −900** follow-up. Files:
object-runtime.ts 9,726 → orchestrator ~600 + 6 modules ≤ 2,000 each.

## Acceptance criteria

1. `prove-emit-identity check` IDENTICAL per extraction commit (with extended corpus).
2. No single emitter function > 1,500 lines afterwards.
3. Emit-order documented: orchestrator body reads as an ordered call list.
4. No test262 regression (standalone shard especially).
