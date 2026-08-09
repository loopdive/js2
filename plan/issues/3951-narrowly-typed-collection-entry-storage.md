---
id: 3951
title: "perf: numeric Map/Set keys all hashed to bucket 0 (O(n) lookups) — fixed; entry-storage boxing remains"
status: in-progress
sprint: Backlog
created: 2026-07-31
updated: 2026-07-31
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen, collections
language_feature: Map, Set
goal: standalone-mode
related: [1103, 2162, 2622, 3673, 3899, 3921, 3927, 3685]
# (#3102/#3400) +28 lines in an existing god-file: the murmur3 finalizer is ~20
# emitted instructions plus a 6-line pointer comment. The sequence is
# irreducible — a finalizer IS that many ops — and the long-form analysis was
# moved to this issue file, trimming the in-code comment from 24 lines to 6
# (+44 -> +28). Extracting a helper module for one inline instruction sequence
# inside `ensureMapHelpers` would not reduce the god-file meaningfully.
loc-budget-allow:
  - src/codegen/map-runtime.ts
func-budget-allow:
  - src/codegen/map-runtime.ts::ensureMapHelpers
---

# #3951 — Numeric-key hashing, and narrowly-typed collection entry storage

## READ FIRST — this issue was filed with the priority backwards

It was filed asserting that `anyref` entry boxing was the cost. **Measurement
says otherwise, by two orders of magnitude.** The dominant cost was a degenerate
hash that put every numeric key in bucket 0, making lookups O(n). Boxing is
real but costs 15–29%; the hash defect cost up to **96×** and grew without
bound with collection size.

Had this been implemented as filed, the boxing work would have been done first
and its benefit would have been invisible underneath an O(n) probe. The
measurement-first acceptance criterion below is what caught it — keep it.

### Part 1 — numeric-key hashing (FIXED, this issue)

`__hash_anyref`'s number arm folded the f64 bits with
`wrap(bits ^ (bits >>> 32)) & 0x3fffffff`. A small integer as an IEEE-754
double has an all-zero low mantissa — `3.0` = `0x4008000000000000`, `6.0` =
`0x4018000000000000` — so the fold lands entirely in the HIGH bits
(`0x00080000`, `0x00180000`, …) leaving the low bits zero. The bucket index is
`hash & (cap-1)` — exactly those low bits — so **every integer key hashed to
bucket 0**: a single chain of length n. Rehashing could not rescue it, because
doubling the bucket count still reads zeros. The string arm was unaffected
(FNV-1a has live low bits), which is what isolated the fault.

Measured on the standalone lane (`target: "wasi"`, median of 9 runs):

| entries | `Set.has` before | after | `Map.get` before | after |
| ------- | ---------------- | ----- | ---------------- | ----- |
| 8       | 61 ns            | 20 ns | 70 ns            | 22 ns |
| 32      | 201 ns           | 29 ns | 225 ns           | 30 ns |
| 128     | 784 ns           | 27 ns | 728 ns           | 35 ns |
| 512     | 2996 ns          | 32 ns | 3074 ns          | 32 ns |

Linear before (44× cost for a 64× size increase), flat after — i.e. genuinely
O(1), so the win grows without bound in collection size. Control: the same loop
with no collection ran at ~1 ns/op, and `Map<string,number>` was flat
throughout (134 → 215 ns/op over the same range).

**Fix:** a murmur3 finalizer after the fold, mixing high entropy down into the
low bits the mask actually selects. Bucket-only — equality is still decided by
`__same_value_zero` in the chain walk, and iteration order comes from the
insertion-ordered entries array, not bucket order.

**Test:** `tests/issue-3951-numeric-key-hash-distribution.test.ts` — 9 rungs
asserting SEMANTICS (round-trip across several rehashes, negative/fractional/
large keys, SameValueZero for `-0`/`+0` and `NaN`, insertion-order iteration,
tombstones, re-add after delete, Set dedup) plus the string arm as a control.
Timing is deliberately NOT asserted — distribution is a performance property
and timing rungs are flaky in CI; the numbers live in this issue.

### Scope note — this does NOT help acorn

Checked, not assumed: acorn 8.16's 6,295-line dist contains **zero**
`new Map(` / `new Set(` / `new WeakMap(` / `new WeakSet(` constructions. It uses
plain objects and regexes for lookup tables. The two hash paths are also
separate functions — `__hash_anyref` (Map/Set keys, fixed here) vs `__obj_hash`
(`$Object` property keys, string/symbol only, already FNV-1a with #3673's
`$HashedString` cache). Acorn's hot path is object property access and never
reaches the numeric arm. Its cost remains the `$AnyValue` boxing of #3921.

### Part 2 — entry-storage boxing (STILL OPEN, sequenced after Part 1)

The original body follows, with its priority claim now corrected by the above.

## Problem

The WasmGC-native collection runtime stores every key and value boxed:

```
$MapEntry: struct { key: anyref(mut); value: anyref(mut); next: i32(mut); hash: i32(mut) }
```

(`src/codegen/map-runtime.ts`, `ensureMapRuntimeTypes`.)

So a `Map<string, number>` — where both types are statically known at every
insertion site — allocates a box per value on the way in and goes through
generic hash/equality dispatch on every lookup. The type information exists at
the producer and is discarded at the container boundary.

`$Map` also backs `Set` (`__map_new` yields the `$Map` a Set wraps, branded by
the trailing `kind` field, #3171), so the same cost applies to
`Set<number>`/`Set<string>`.

## Why this is filed as a consumer of the representation work, not a collections fix

**This is one instance of a larger measured problem, and should not be scoped as
a standalone collections optimisation.** #3921's per-type allocation census over
the real acorn self-parse found:

> **`$AnyValue` boxing is 48% of every allocation in the parse — 310,485 boxes,
> ~7.4 per token — and it appeared on no one's list.** The AST is **5%** of
> allocations by count.

and framed the cause in exactly the terms that apply here:

> the carrier a value takes when a statically-typed value flows somewhere its
> type is no longer known … Whatever fraction of those 310 K boxes is a value
> that was *provably* typed at the producer and re-widened for a generic
> consumer is pure loss, and it is a **representation question**.

`anyref` map entries are that pattern with the container as the widening
boundary. If a general "keep a provably-typed value unboxed across a generic
boundary" mechanism is built (#3927/#3685 territory), **collections should be a
consumer of it** rather than growing a bespoke parallel solution.

**Caveat on citing #3921:** its *byte* column is explicitly not reconciled
(29 MB estimated vs 43.6 MB measured) and must not be quoted as measurement.
The **counts** above are exact — each is a counter incremented at the
allocation site.

### Honest scoping note — acorn is NOT the motivating workload

The 48% figure is about `$AnyValue` in general **value flow**, not about
collections. acorn makes little use of `Map`/`Set` on its hot path, so this
issue should **not** be sold as an acorn win. It is the same disease in a
different container, and its own workload evidence is still owed (see below).

## What is NOT missing

Two corrections, so nobody re-litigates settled ground:

- **Type-aware hashing already exists.** #1103's design specified "compile a
  hash function for each key type (number → identity, string → FNV/djb2, object
  → identity/address)". What shipped hashes by **runtime type dispatch** —
  `__obj_hash` `ref.test`s `$HashedString`, and #3673 Round 9 added
  `$HashedString <: $NativeString` carrying a cached FNV-1a hash with a
  write-back fast path. So hashing is type-aware; it is not *compile-time
  specialised*. Turning the runtime dispatch into a per-call-site specialised
  hash is a **further, smaller slice**, not an unimplemented promise.
- **This is not a regression.** Nothing worked and broke. #1103 never specified
  unboxed entry storage; narrow typing is a new idea here, which makes it weaker
  as a standalone pitch and is a further reason to attach it to the
  representation work.

## Sketch

Specialise the entry struct when key/value wasm types are statically known and
monomorphic at every insertion site for a given collection allocation:

- `Map<string, number>` → `struct { key: ref $NativeString, value: f64, … }`
- `Set<number>` → an f64-keyed variant
- anything polymorphic, `any`-typed, or escaping to a generic consumer → today's
  `anyref` entry, unchanged.

Open design questions, none of which are answered here:

1. **Where does the specialisation decision live?** Per allocation site
   (escape/monomorphism analysis) or per static type? A `Map` that escapes into
   an `any`-typed consumer must degrade safely.
2. **How many variants?** A per-type-pair struct explosion is its own cost; a
   small closed set (f64 / `$NativeString` / anyref) is likely the tractable
   shape.
3. **Interaction with #2622.** The native subclass design declares
   `$MySub <: $Map` so every `__map_*` helper accepts it by subtyping. A
   specialised entry type changes `$Map`'s own field types, so the two must
   agree on whether specialisation is per-`$Map`-type (forcing subclass
   variants) or confined to the entry array.
4. **`__map_*` helper duplication.** The helpers take `ref $Map`; specialised
   entries imply either specialised helper variants or a generic helper that
   dispatches, which would give back much of the win.

## Measured boxing cost (Part 2's actual size, now that Part 1 is fixed)

Small integers ride in `i31ref` and do **not** heap-box; only non-integral
values do. Measured with the #3921 census on the standalone lane:

| case                                  | allocations/op | ns/op |
| ------------------------------------- | -------------- | ----- |
| `Map<string,number>` small-int values | 0.0038         | 76    |
| `Map<string,number>` float values     | **0.7538**     | 98    |
| `Set<number>` small-int members       | 0.0029         | 368   |
| `Set<number>` float members           | **0.5041**     | 425   |

So boxing is real (0.5–0.75 heap boxes per operation for non-i31 values) but
costs **+29% / +15%** in time — against the up-to-96× the hash defect cost.
That ratio is the whole argument for the sequencing, and it is why the
allocation-count column alone would have been misleading: allocations were ~1
per DISTINCT key (inherent to a hash map), not per operation.

## Acceptance criteria

- [x] A benchmark that is genuinely collection-hot (acorn is **not** — verified
      above) with a recorded before/after on both allocation count (via #3921's
      census) and wall-clock. Done for Part 1; the table above is Part 2's
      baseline.
- [ ] `Map<string, number>` / `Set<number>` allocate no per-entry box on the
      insertion path in the specialised case.
- [ ] Polymorphic / `any` / escaping collections still compile and behave
      identically — a degradation path, not a refusal.
- [ ] test262 pass counts unchanged on both lanes (this is a representation
      change, not a semantics change).
- [ ] Decision recorded on whether this is implemented as a consumer of the
      general `$AnyValue` representation work or independently, with the reason.

## References

- `src/codegen/map-runtime.ts` — `$MapEntry` / `$Map` layout, `MAP_LAYOUT`.
- #3921 — per-type WasmGC allocation census; the 48% `$AnyValue` finding.
- #1103 — original native Map/Set design (per-key-type hashing plan).
- #3673 — acorn self-parse perf; Round 9 `$HashedString` + `__obj_hash` cache.
- #3899 — boolean interning; one narrow case of the same widening crossing.
- #2622 — native builtin-collection subclass; shares the `$Map` type decision.
- #2620 — where this gap was first written down (architectural note).
