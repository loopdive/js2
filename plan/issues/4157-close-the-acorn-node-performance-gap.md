---
id: 4157
title: "umbrella: close the acorn-vs-Node performance gap — representation first (bounded 2.7x), then JIT-class structural work"
status: ready
sprint: current
created: 2026-08-04
updated: 2026-08-06
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: performance
area: codegen
goal: performance
assignee: "ttraenkler/claude-fable"
related: [3780, 4155, 743, 3926, 3927, 4074, 2860]
loc-budget-allow:
  - src/codegen/closures.ts
origin: "2026-08-04 — synthesis of the #3780/#4155 measurement campaign into a scheduled program"
---

# #4157 — umbrella: close the acorn-vs-Node performance gap

## Where the gap lives (measured, 2026-08-04)

Compiled acorn parses the runtime-suffixed 226 KB corpus at **ratio 0.092-0.124
vs native Node** (10.8x slower on CI hardware, 8.0x in a dev container — same
lane, hardware differs). Both numbers are from the `standaloneDynamic` lane;
the `static` lane's huge ratios are compile-time folding and must never be
quoted as runtime performance.

The gap decomposes into two unequal parts (#3780):

1. **~63% is representation overhead.** Boxed `externref` values everywhere:
   42,930 `ref.test`/`ref.cast`/`ref.is_null` + 24,288 conversions against
   22,003 calls; casts+conversions are 19.9% of instructions in the hottest
   functions while real field access is 4.1%; every boxed field read funnels
   through `__extern_get` (14,035 lines, linear scan, 5.6% self-time).
   **Eliminated perfectly this is worth ~2.7x — it cannot reach parity alone.**
2. **~3.5x is the compiled parser losing to the JIT** — inline caches,
   speculation, and tuned string internals that a static compile must earn
   structurally.

## What is already done (do not redo)

- **Typed instance slots are ON by default** (#4155 Phases 0-1, PRs
  #4113-#4116): acorn binary 943,140 → 866,627 B (−8.1%), `discarded` census
  bucket 4 → 1. **Measured A/B: zero runtime effect** (ratio 0.1243 on vs
  0.1221 off, inside noise) — expected, because the READ SIDE was never built.
  Typing the slot is the precondition for the fast read, not the fast read.
- **Prototype-alias recovery has NO headroom** — #2681 already recovers the
  receiver completely; alias and direct forms emit byte-identical twins
  (`struct.get`, no dispatcher). Verified at the instruction level in #4155.
- **Single-hop ctor-param inference is worth 2 slots for +90 bytes** (#4117,
  shipped default-off behind `JS2WASM_FNCTOR_CTOR_PARAM_TYPES`). The next
  attempt starts from the transitive fixpoint, not from call-site agreement.
- Alias-following, multi-site field seeding, and checker-shape synthesis are
  all measured dead ends — see #4155 §3-§4 and index.ts:7654 (#1712).

## The program, in dependency order

### Workstream 1 — finish the representation lever (bounded ~2.7x total)

- [ ] **#4155 Phase 2 — read side**: emit `struct.get`/`struct.set` for data
      fields on a struct-typed receiver; member CALLS stay dynamic (that
      default is where the #1712 attempt regressed). Insertion point pinned:
      `property-access.ts:656` re-boxes a `ref` receiver into the dispatcher.
      Precedent: #3753 S1c ("promoting the slot alone moved nothing because
      the READ never consulted it"). **This converts the −8.1% into speed or
      proves the slot lever dead — either result reshapes the program.**
- [ ] **#743 transitive fixpoint**: 43 of 96 slots are `unknown` because ctor
      args are themselves untyped values forwarded from untyped params.
      Single-hop is measured worthless; the fixpoint must propagate through
      the call graph to convergence. The IR middle-end already has
      `src/ir/propagate.ts` (#1131) — extend it rather than building anew.
- [ ] **#4155 Phase 0's three `it.fails` bugs** (return-position instance,
      array round-trip, method-added field): correctness holes in the same
      machinery; any read-side work must not paper over them.

### Workstream 2 — JIT-class structural work (the ~3.5x residue)

- [ ] **#3926 — `__extern_get` lookup cost**: perfect-hash / `br_table` the
      key dispatch (today: 1,080 ifs, 463 `ref.test`, 303 `__str_equals`,
      zero `br_table`). Pays off on every read Workstream 1 does NOT convert.
- [ ] **#3927 — per-shape fnctor splitting**: `Node` is a 292 B union struct
      for a 3-6 property object; #4074's declared-shape partition (acorn's
      own `.d.ts`, 83 interfaces) is the cheap partition signal. Bounded at
      ~19% of allocation.
- [ ] Scanner/string tuning on the tokenizer hot path — scoped by whatever
      the post-Workstream-1 profile says; do not pre-commit.

### Measurement discipline (how this umbrella stays honest)

- The only quotable lane is **`standaloneDynamic`** (`pnpm run
  benchmark:acorn:standalone-dynamic`).
- Every perf change lands with an **A/B on that lane** (env-flag or
  commit-pair), not a before/after across days — ambient drift between runs
  exceeded the entire effect size of #4116.
- Size deltas are reported as size, never implied as speed.

## Acceptance criteria

- [ ] Phase 2 lands and the `standaloneDynamic` A/B moves outside noise, OR
      the null result is recorded here with the profile that explains it.
- [ ] `unknown` census bucket < 20 (from 43) via the #743 fixpoint, measured
      by `JS2WASM_FNCTOR_FIELD_PROVENANCE=1` on acorn.
- [ ] `__extern_get` self-time < 3% (from 5.6%) on the #3780 profile corpus.
- [ ] Ratio vs Node ≤ 0.25 (≤4x slow) on `standaloneDynamic`, CI hardware —
      the realistic Workstream-1+2 target; parity is NOT promised by this
      umbrella and would require wins beyond both workstreams.
- [ ] The three #4155 Phase 0 `it.fails` tests are promoted to passing.

## 2026-08-06 — post-campaign profile (replaces the hypothesis with a self-time table)

All four receiver-side levers (#4116 slot typing, typed reads, binding retype
PR #4141, ctor-param seeds PR #4140) measured NULL on wall-clock; the recorded
hypothesis was "the converted sites' VALUES stay boxed, and the remaining
dynamic-lookup sites and/or scanner/string work dominate." This section is the
measured replacement for that hypothesis.

**Setup.** `origin/main` @ `b2a713e57`, Node 22.22.2, 4-core/16 GB container.
`standalone-dynamic` lane exactly as shipped (`--only acorn --perf-only --lane
standalone-dynamic`, optimize 4, checksum 422, zero imports, binary
**1,505,459 B** — down from the #3780-era 1.69 MB with #4116 now default-on).
Same-process lane medians: **wasm 144,186 µs/op vs node 17,861 µs/op, ratio
0.124 (8.1x)**. Profile: V8 inspector sampling over **300 parses, 48,429 ms
wall, 39,586 samples** (~1.2 ms/sample — coarser than #3780's 150 µs, but 6x
the sample count). All percentages below are of that 48.4 s (~161 ms/parse
under profiler, +12 % overhead over the unprofiled 144 ms median).
`__closure_N` frames are mapped to acorn source functions via the new
`JS2WASM_CLOSURE_NAME_MAP=1` diagnostic (src/codegen/closures.ts).

**Caveat**: `JS2WASM_FNCTOR_TYPED_BINDINGS` (#4141) is NOT on this base — the
flags-ON run below toggles only the two landed levers (`TYPED_READS`,
`CTOR_PARAM_TYPES`); the third env var was silently inert.

### Top-25 self-time (baseline, all flags off)

| # | self % | cum % | bucket | frame |
| --: | --: | --: | --- | --- |
| 1 | 18.49 | 18.5 | gc-engine | (garbage collector) |
| 2 | 7.69 | 26.2 | dynamic-lookup | `__extern_get` |
| 3 | 5.12 | 31.3 | regexp | `__regex_search` |
| 4 | 3.73 | 35.0 | string-runtime | `__str_flatten` |
| 5 | 3.72 | 38.7 | dynamic-eq | `__extern_strict_eq` |
| 6 | 3.10 | 41.8 | dynamic-eq | `__is_truthy` |
| 7 | 2.30 | 44.1 | cast-convert | `__box_number` |
| 8 | 1.94 | 46.1 | scanner | `getTokenFromCode` twin |
| 9 | 1.89 | 48.0 | parser | `parseSubscript` |
| 10 | 1.66 | 49.6 | scanner | `fullCharCodeAt` twin |
| 11 | 1.42 | 51.1 | scanner | `skipSpace` twin |
| 12 | 1.32 | 52.4 | scanner | `pp.next` |
| 13 | 1.31 | 53.7 | cast-convert | `__unbox_number` |
| 14 | 1.23 | 54.9 | call-dispatch | `__dc_Parser_nextToken_0_g` |
| 15 | 1.10 | 56.0 | alloc | `__fnctor_Node_new` |
| 16 | 1.10 | 57.1 | cast-convert | `__to_primitive` |
| 17 | 0.99 | 58.1 | parser | `currentVarScope` |
| 18 | 0.95 | 59.1 | string-runtime | `__str_equals` |
| 19 | 0.93 | 60.0 | call-dispatch | `__call_fn_method_7` |
| 20 | 0.91 | 60.9 | call-dispatch | `__extern_method_call` |
| 21 | 0.89 | 61.8 | parser | `parseMaybeAssign` |
| 22 | 0.87 | 62.7 | scanner | `readToken` twin |
| 23 | 0.85 | 63.5 | dynamic-lookup | `__obj_find` |
| 24 | 0.82 | 64.3 | call-dispatch | `__call_fn_method_0` |
| 25 | 0.80 | 65.1 | cast-convert | `__any_from_extern` |

### Buckets, and the A/B with the two landed receiver flags ON

| bucket | flags OFF | flags ON | #3780 (2026-08-01) |
| --- | --: | --: | --: |
| gc-engine | **18.5 %** | 17.0 % | 17.4 % |
| dynamic-lookup (`__extern_get` 7.7 + per-key `__get/set_member_*` 6.1 + `__obj_find/hash` 1.5) | **16.1 %** | 15.3 % | ~10.4 % (grouped w/ eq) |
| parser logic (compiled) | 15.4 % | 16.1 % | } 41.4 % ("compiled acorn", |
| scanner/tokenizer (compiled) | 13.2 % | 13.7 % | } grouping differs — see note) |
| call-dispatch (`__dc_*` 4.2, `__call_fn_method_*` 2.6, `__call_m_*` 1.3, `__extern_method_call` 0.9) | **10.0 %** | 10.5 % | 7.6 % |
| dynamic-eq (`__extern_strict_eq` 3.7, `__is_truthy` 3.1) | **7.1 %** | 6.9 % | 2.7 % visible (`strict_eq` frame) |
| regexp (`__regex_search` 5.1 + test dispatch) | 6.6 % | 6.7 % | 5.2 % |
| cast-convert (`__box/__unbox/__to_primitive/__any_*`) | 6.1 % | 6.1 % | 4.9 % |
| string-runtime (`__str_flatten` **3.7**, `__str_equals` 1.0) | **5.6 %** | 6.1 % | 1.7 % |
| alloc helpers (`__fnctor_Node_new` 1.1) | 1.3 % | 1.5 % | 3.9 % |
| lane total (same box, minutes apart) | 144.2 ms/op | 137.8 ms/op | (132.1 ms/op, other box-day) |

Grouping note: #3780's "compiled acorn 41.4 %" almost certainly folded the
per-key `__get/set_member_*` helpers (6.1 pp here) and `__dc_*` trampolines
(4.2 pp) into compiled code; per-frame comparisons are the robust ones:
`__extern_get` **5.6 → 7.7 %**, `__regex_search` 4.1 → 5.1 %,
`__extern_strict_eq` 2.7 → 3.7 %, `__fnctor_Node_new` **3.4 → 1.1 %** (the
round-4 allocation work + slot typing really did shrink Node construction).

**The flags-ON A/B confirms values-stay-boxed from the inside.** Lane 137.8 vs
144.2 ms/op (ratio 0.117 vs 0.124 — inside the campaign's noise band,
ratioStd ≈ 0.025); binary +570 B. The dispatch bucket does not even shrink
meaningfully: `__extern_get` 7.7 → 7.8 %, per-key member helpers 6.1 → 5.4 %
(−0.7 pp, the only visible movement), everything else flat. Typing the
receiver converts a sliver of per-key member traffic and nothing else on the
hot path.

### Who pays for the top helpers (nearest-caller attribution)

- `__extern_get` (7.69 %): `__extern_method_call` 1.30, `__fnctor_Node_new`
  1.06 (the ctor's `options.locations/ranges` reads — `Parser.options` is an
  open `$Object` by design, #4155), `checkUnreserved` 1.01 (its
  `this.options.ecmaVersion` reads), `finishNodeAt` 0.68, then the tokenizer
  (`next`/`readToken`/`readWord`/`finishToken` ≈ 1.6 combined). Spread wide —
  only an algorithmic fix to the helper itself (#3926) reaches all of them.
- `__str_flatten` (3.73 %): **`skipSpace` 1.19 + `fullCharCodeAt` 0.54** — the
  scanner's per-character path re-enters rope flattening on every
  `charCodeAt` of the (concat-built, hence rope-backed) input string. This is
  a single, narrow, previously uncatalogued lever.
- `__extern_strict_eq` (3.72 %): `parseSubscript` 1.38 (its `===` chain on
  boxed operands), then spread across `parseMaybe*`/`eat`/`isContextual`.
- `__regex_search` (5.12 %): 4.97 via `__regexp_test_carrier`/`__call_m_test_1`
  — tokenizer-adjacent `.test` calls, almost nothing else.

### Workstream 2, REORDERED (by measured bucket size)

1. **#3926 `__extern_get` perfect-hash / `br_table`** — still first, and its
   target GREW: dynamic-lookup is 16.1 % (extern_get self 7.7 % vs the 5.6 %
   baseline; acceptance criterion "< 3 %" now needs a −4.7 pp move). Pays on
   every read no representation lever converts, callers spread too wide for
   site fixes.
2. **NEW ISSUE NEEDED — dynamic strict-eq / truthiness lowering (7.1 %,
   nothing targets it)**: `__extern_strict_eq` 3.7 + `__is_truthy` 3.1. No
   current Workstream 2 issue touches boxed `===`/condition tests; top payer
   is `parseSubscript`'s token-comparison chain.
3. **NEW ISSUE NEEDED — `charCodeAt`-on-rope flatten guard (3.7 %, nothing
   targets it)**: `__str_flatten` re-entered per scanned character from
   `skipSpace`/`fullCharCodeAt`. The string bucket tripled vs #3780
   (1.7 → 5.6 %); this one function is two-thirds of it. Likely the cheapest
   slice on this list (cache the flat array ref / early-exit already-flat).
4. **Regexp `.test` residue (6.6 %)** — the "scanner/string tuning" line item,
   now scoped: it is `__regex_search` reached via the test carrier on
   tokenizer regexes. Rounds 1-2 already took the easy wins; treat as bounded.
5. **#3927 per-shape fnctor splitting — DEMOTED**: `__fnctor_Node_new` self
   fell 3.4 → 1.1 % (presence-bit packing + slot typing already banked much of
   it); remaining payoff routes through the GC bucket only, capped at ~19 % of
   allocation.

**What Workstream 2 cannot reach (and the profile says out loud):** GC 18.5 %
+ dynamic-eq 7.1 % + cast-convert 6.1 % ≈ **32 % is the boxed-VALUES tax** —
that is Workstream 1 (#4155 Phase 2 read side, #743 fixpoint) territory, and
it is exactly why four receiver-side levers measured null: typing the receiver
without unboxing the values converts neither the read results nor the
comparisons nor the allocations. The profile does not demote Workstream 1; it
confirms its target is the single largest cluster.

**Single next slice to dispatch: #3926.** Largest bucket any single PR can
address (16.1 % dynamic-lookup, one helper function), independent of every
in-flight representation lever, acceptance criterion already pinned in this
umbrella, and its payoff is unconditional — every future typing improvement
still leaves the fallback path on it.

### Reproduction

```bash
# profile (writes .cpuprofile + binary; stderr carries the closure map):
JS2WASM_CLOSURE_NAME_MAP=1 npx tsx scripts/generate-npm-compat-report.mjs \
  --only acorn --no-write --perf-only --lane standalone-dynamic \
  --preserve-debug-names --profile-runtime wasm \
  --profile-output .tmp/acorn.cpuprofile --profile-iterations 300 \
  2> .tmp/closure-map.log
# analyze:
node scripts/profile-buckets.mjs .tmp/acorn.cpuprofile .tmp/closure-map.log 25 \
  --detail --callers=__extern_get
```

## Dupe check

#3780 stays open as the measurement/goal issue; this umbrella is its
execution program. #4155/#743/#3926/#3927 are the children and keep their own
acceptance criteria; this file only sequences them and pins the measurement
rules.
