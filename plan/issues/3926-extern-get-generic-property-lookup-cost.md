---
id: 3926
title: "perf: `__extern_get` generic property lookup is the largest non-parser function in the standalone parse and is unowned"
status: done
completed: 2026-08-06
assignee: ttraenkler/claude-fable
sprint: 78
created: 2026-07-31
updated: 2026-08-18
loc-budget-allow:
  - src/codegen/object-runtime.ts
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen, runtime
language_feature: objects
goal: performance
related: [4157, 3673, 3669, 3671, 3685, 3686, 3780, 3921]
origin: "#3780 round 4 — re-ranking the standalone acorn profile found __extern_get unowned: #3673 (which carried it as a slice) is done, and #3669/#3671 are about slot MONOMORPHISM, not lookup cost"
---

# #3926 — `__extern_get` generic property lookup cost has no live owner

## Why this issue exists

Across four independent profiles of the standalone acorn self-parse,
`__extern_get` is consistently **the largest single non-parser function**:

| profile | `__extern_get` self time | whose |
| --- | ---: | --- |
| `dev-acorn-throughput`, 30 parses of 226 KB | 8.03% (bucket 10.10%) | theirs |
| #3686's, 20,000 parses of 1.5 KB | 9.69% (bucket 12.6%) | theirs |
| #3780 round 4, 30 parses, this box | 4.46% (bucket 5.15%) | mine |

The spread across boxes is real and unexplained (see the caveat in #3921), but
no profile puts it below 4%, and two put it near 10%.

**It is nevertheless unowned.** The issue that carried it as a slice, #3673, is
`status: done`. #3669 is also `done`; #3671 is `ready` but scoped to *slot
monomorphism* — whether a slot seeded with a number/boolean corrupts on a later
write — which is a **correctness/representation** question, not the cost of the
lookup itself. Nothing currently tracks "the generic property read is
expensive".

## What is already known

- The helper is emitted, not imported, in standalone — this is **internal**
  cost, not bridge tax. (Do not conflate with #3780's JS-host lane, where
  `__extern_get` is one of 17.67 M host crossings per parse.)
- Its structure is a front-guard cascade → per-key prototype-lookup cache
  (#3673 round 9b) → closed-struct field ladder → `__obj_find` own-property
  walk → prototype-chain walk → accessor branch. The ladder is what the cache
  exists to skip.
- **#3780 round 4 already removed one cost from inside it**: the boolean arms
  of the closed-struct ladder allocated a fresh 16-byte carrier per read
  (742 static `struct.new` sites → 2 after interning). That was allocation, not
  lookup, and the lookup work is untouched.
- #3780 round 3 routed acorn's `this.options.<x>` reads *directly* to
  `__extern_get`, deliberately skipping a useless closed-struct candidate
  ladder at the call site (`JS2WASM_TYPED_OPEN_CARRIER_READS`, 4.59% faster).
  So some call sites now reach this helper **sooner** by design — which raises,
  not lowers, the value of making the helper itself cheap.

## Scope

- [ ] Profile *inside* `__extern_get` — which arm actually retires the time on
      the acorn parse: front guards, cache probe, ladder, `__obj_find`, or the
      proto walk. The whole-function 4–10% figure does not say.
- [ ] Establish the hit rate of the #3673 round-9b per-key prototype cache on
      this workload. A cache that mostly misses is pure added latency.
- [ ] Only then choose a lowering. Do NOT start from the assumption that the
      ladder is the problem — that is what the cache was already built to fix.

## Non-goals

- Slot monomorphism (#3671) — different question, different failure mode.
- The JS-host lane's import count (#3673's old framing) — that lane's cost is
  the crossing, not this helper's body.

## Acceptance criteria

- [x] An intra-function attribution for `__extern_get` on the standalone acorn
      parse, naming which arm costs what. (Partial, by construction + paired
      profile: the string-key SELECTION — length/c0 guard scan + in-bucket
      `__str_equals` probes — was ~1.6pp of the 7.9% self-time plus 0.4pp of
      out-of-line `__str_equals`; the remainder is the per-name receiver
      `ref.test` arms, tombstone/numeric/front guards, the flatten call
      (~3.0% out-of-line, unchanged), and the hash-table/proto walk. See
      Results below.)
- [ ] Cache hit rate reported for the same workload. (NOT measured — the
      #4157 post-campaign profile re-scoped this issue to the hash-dispatch
      lowering directly; the round-9b cache arm is untouched and still runs
      ahead of the new dispatch.)
- [x] Any lowering that lands is measured with a paired control on the
      standalone acorn parse, and reports binary-size cost alongside the win.
- [x] No standalone test262 regression. (Gated in the merge_group standalone
      floor/net guards; local: 60 fnctor tests, 52 object-equivalence tests,
      acorn dogfood 7/7 fixtures equal, standalone canaries 2/3/4/5 with
      imports [] and exactly the 3 pre-existing IR-FALLBACKs.)

## Results (2026-08-06, #3926 hash dispatch — branch `claude/issue-3926-extern-get-hash-dispatch`)

**What landed.** `fillClosedStructExternGetArms` (src/codegen/object-runtime.ts)
no longer selects the field-name probe by the #3673 length-bucket/first-char
ladder. It now:

1. flattens the key once (unchanged),
2. reads the compile-time-baked FNV-1a hash from `$HashedString` field 3 —
   one `struct.get` for every interned member-read key — falling back to one
   `__obj_hash` call for plain `$NativeString` keys (which memoizes the hash
   for next time),
3. masks the hash and dispatches through ONE `br_table` over a power-of-two
   bucket table at load factor ≤ 0.5 (nested-block tree; empty slots branch
   straight past every arm),
4. verifies inside the bucket with `__str_equals` exactly as before —
   equality remains the arbiter, the hash only prunes; misses fall through to
   the builtin-meta arm / `__obj_find` walk / proto chain unchanged.

WHY this shape: the receiver-typing campaign left ~4,500 dynamic sites that
must go through this helper, and the ladder scan (≈15 length compares + c0
compares per lookup) was pure selection overhead the baked hash already paid
for at compile time. Perfect hashing was considered and skipped — plain
mask+verify measured well and keeps collisions correct by construction.

**A/B, `benchmark:acorn:standalone-dynamic`, 3 interleaved pairs (file-copy):**

| pair | base ratio | new ratio |
| ---- | ---------- | --------- |
| 1    | 0.11338    | 0.11727   |
| 2    | 0.11423    | 0.12016   |
| 3    | 0.11450    | 0.11886   |

Base mean 0.11404 (σ≈0.0006), new mean 0.11876 (σ≈0.0015) → **+4.1%
throughput**, min-new > max-base (non-overlapping). The profile's ceiling was
~7.7% if the whole self-time vanished; ~4.1% is the realized share because
selection was only part of the self-time (see attribution above).

**`__extern_get` self-time** (named wasm profile, 30 parses, same box):
7.91% → 6.33% (−20% relative); `__str_equals` 0.83% → 0.45%. The #4157
"< 3%" target needs the remaining receiver-arm/flatten cost, not better key
selection.

**Binary size**: standalone acorn 868,088 → 870,089 B (**+2,001 B, +0.23%**);
bench artifact 1,473,605 → 1,475,604 B (+1,999 B) — the br_table + block tree
costs ~2 bytes/slot.

**Ship decision: ON, no flag.** Standalone-only code path, correctness suites
fully green, A/B clean and consistent, size cost trivial. Defensive
degradation to a linear probe ladder exists only for the (unreachable) case
of a missing `__obj_hash`/`$HashedString`.
