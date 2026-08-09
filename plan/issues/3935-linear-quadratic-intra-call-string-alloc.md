---
id: 3935
title: "linear backend: string/concat-short allocates ~1.5 GB of quadratic intermediates within ONE call — traps immediately, unfixable by between-call reclaim"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen-linear
language_feature: string-concat
goal: performance
sprint: current
horizon: l
es_edition: multi
related: [3908, 3924]
---

# #3935 — quadratic intra-call string allocation in the linear lane

## Status: open — distinct from #3924, confirmed by the same experiment

## Problem

`string/concat-short`'s linear lane traps with `memory access out of bounds` at
**call 0** — before any between-call arena growth can matter. It is the one
trap in #3908's inventory that **still fails with `allocator: "arena-reset"`**,
which is precisely what separates it from #3924.

The benchmark body:

```ts
let s = "";
for (let i = 0; i < 10000; i = i + 1) {
  s = s + "hello world!!!!";
}
```

Each iteration allocates a fresh buffer holding the entire accumulated string.
The total allocated is quadratic in the iteration count — roughly **1.5 GB**
within a single call, for a final string of ~150 KB.

## Why between-call reclaim cannot help

#3924's arena-reset rewinds between `run()` invocations. This exhausts memory
*inside* one invocation, so there is no reset point to reach. The two issues
share a symptom and nothing else; fixing #3924 will leave this one exactly as
red as it is now.

## The real options

1. **Intra-call reclaim** — the intermediates are provably dead the moment the
   next concatenation completes. Something that recognises a dead temporary in
   an accumulation loop would fix this and generalise.
2. **A rope or builder representation** for string concatenation, so the loop
   does not materialise the full string each iteration. This is what the
   WasmGC/native-strings lane already does — note #3901 found `__str_substring`
   is an O(1) slice view and `__str_replace` deliberately keeps a ConsString
   rope path above a 64-unit threshold. The linear lane has no equivalent.

Option 2 is the structural answer and matches what the other backend already
does; option 1 is more general but harder. Look at how the native-strings lane
represents `NativeString` (`{len, off, data}`) before designing something new —
the pattern may port.

## Scope

1. Confirm the ~1.5 GB figure and the call-0 trap independently.
2. Choose an approach with the reasoning recorded. Do not fix this by growing
   the arena — that trades a trap for a memory blow-up and would still fail on
   a larger input.
3. Check whether other string-building shapes hit the same wall (`+=` in a
   loop, `Array.join` over many pieces, template literals in a loop).

## Acceptance criteria

1. `string/concat-short` produces a correct linear-lane result across a full
   run.
2. Peak memory for the benchmark is proportional to the final string, not to
   the sum of intermediates.
3. The issue records which other string-building shapes were checked.

## Provenance

`issue-3908-linear-validation`'s 26-lane inventory. Isolated from #3924 by a
controlled experiment: 4 of the 5 traps pass under `arena-reset`, this one does
not.
