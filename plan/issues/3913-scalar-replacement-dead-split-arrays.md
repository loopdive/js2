---
id: 3913
title: "perf: scalar replacement for dead split/array results — #747 escape analysis is inference-only, so `split(...).length` still materialises the whole array"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: medium
feasibility: hard
reasoning_effort: high
task_type: optimization
area: ir
language_feature: string-methods
goal: performance
sprint: Backlog
horizon: xl
es_edition: multi
related: [747, 1587, 3901]
---

# #3913 — scalar replacement for dead `split` results

## Status: open

Follow-up from #3901, filed as instructed rather than implemented inline.

## Problem

`#3901` made `String.prototype.split` call-free and exactly pre-sized. After
that fix `mixed/csv-parse` is **allocation-bound**, and the single largest
remaining cost is an array that is provably dead.

The benchmark's inner loop is:

```ts
const cols = lines[i].split(",");
sum = sum + cols.length;
```

`cols` never escapes: its only use is `.length`. Yet we materialise, per inner
split, one backing `(array (ref null $AnyString))`, one `$vec_nstr` struct and
one `$NativeString` slice view per piece — 5 allocations to compute an integer
that the counting pass of `__str_split` already has in a local before the
result array is even allocated.

## Measured prize (2026-07-31, 4-core box under concurrent agent load;
## quote the ratios, the absolutes are load-inflated)

| variant                                                        | gc-native |
| -------------------------------------------------------------- | --------- |
| `full` — the real `mixed/csv-parse`                             | 1.646 ms  |
| `outerOnly` — identical, but `sum + lines[i].length` (no inner split) | 0.556 ms  |
| `skeleton` — loop nest only, no split at all                    | 0.020 ms  |

**The inner splits are 1.090 ms — 66 % of `mixed/csv-parse`.** Eliding the dead
`cols` array (keeping only the counting scan) therefore addresses up to two
thirds of the benchmark's remaining runtime. That alone would take csv-parse
past the ≥1.8× target #3901 set and could not reach with split-side work.

Per csv-parse iteration the inner splits account for 50 of the 63 allocations
(10 lines × [1 backing array + 1 vec struct + 3 slice views]).

## Why #747 does not already do this

`#747` **is** marked `status: done`, but only Phase 1 landed, and Phase 1 is
deliberately inert. From `src/ir/analysis/escape.ts`:

> Like #1587 this pass is *inference*, default-OFF, and inert: it writes to the
> `AllocSiteRegistry` `escape` namespace … and NEVER mutates the IR. Removing it
> cannot change emitted Wasm. Scalar replacement / stack allocation itself is a
> follow-up that consumes this classification; Phase 1 only produces it.

So the classification `cols → local` may well be computed correctly; **there is
simply no consumer that acts on it.** That is the gap this issue covers.

Second, independent blocker: `split` is lowered by the legacy AST→Wasm path
(`src/codegen/string-ops.ts`, the `method === "split"` arm), not by the IR
pipeline, so its result is not an IR alloc site that `analyzeEscape` can see at
all. Either the split lowering has to move onto the IR path first, or the
consumer needs a targeted peephole.

## Scope

1. Build the **consumer** for `#747` Phase 1's `local` classification: scalar
   replacement of non-escaping aggregate allocations.
2. Decide the ordering against the front-end axis: does `split` need to move to
   the IR path (`plan/log/ir-adoption.md`) before this can fire, or is a
   narrower AST-level "result used only for `.length`" rewrite acceptable as a
   stepping stone? The narrow form is much cheaper — `__str_split`'s pass 1
   already computes the piece count and could be exposed as a
   `__str_count_pieces` helper returning `i32` with zero allocations — but it
   only fires on one shape.
3. Whatever the mechanism, it must not change observable semantics: `split`
   still has to throw/coerce identically, and the result must be materialised
   the moment anything other than `.length` observes it.

## Acceptance criteria

1. `mixed/csv-parse` gc-native improves by ≥1.6× beyond the #3901 baseline.
2. A test proves the array IS still materialised when the result escapes
   (returned, stored, indexed, passed to a call, captured).
3. No equivalence or test262 regressions in
   `built-ins/String/prototype/split`.

## Non-goals

- Full stack allocation of escaping objects (still #747's later phases).
- Slice-view string representation — already exists and is already used;
  #3901 confirmed `split` copies **zero** characters.
