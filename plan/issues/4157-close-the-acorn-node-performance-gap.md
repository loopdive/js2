---
id: 4157
title: "umbrella: close the acorn-vs-Node performance gap — representation first (bounded 2.7x), then JIT-class structural work"
status: ready
sprint: current
created: 2026-08-04
updated: 2026-08-12
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
  # (#4157 const-box hoist) +8 lines in the driver: one import and two
  # one-line pass invocations, one per compile pipeline. The pass itself is a
  # new subsystem module (src/codegen/const-box-hoist.ts); there is no smaller
  # way to WIRE a finalize pass than to call it from the finalize sequence.
  - src/codegen/index.ts
func-budget-allow:
  # Same +8 lines, seen per-function: the two finalize sequences.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
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

- [x] **#4155 Phase 2 — read side**: LANDED flag-gated
      (`JS2WASM_FNCTOR_TYPED_READS`, default OFF). 78 candidate sites on
      acorn, A/B a wash — see #4155 "Phase 2 implemented".
- [x] **#2660 S3b — binding retype** (the convergence lever this umbrella
      predicted): LANDED flag-gated (`JS2WASM_FNCTOR_TYPED_BINDINGS`, default
      OFF). 43 acorn bindings retyped, Phase-2 candidate sites 78 → 424
      (5.4x), all suites green — **and the `standaloneDynamic` A/B is STILL a
      wash** (ON 0.1167 vs OFF 0.1185 mean over 3 pairs, inside noise,
      divergent 0). The null result is now well-characterized: the converted
      sites are AST-node field writes whose VALUES stay boxed either way;
      removing the dispatch ladder does not move the profile. See #4155
      "2026-08-06 — #2660 S3b binding retype implemented". **Consequence for
      this program: the receiver-representation half of Workstream 1 is
      exhausted as a speed lever on this corpus; the remaining representation
      upside is VALUE typing (#743), and the remaining speed levers are
      Workstream 2 (#3926/#3927).**
- [ ] **#743 transitive fixpoint**: 43 of 96 slots are `unknown` because ctor
      args are themselves untyped values forwarded from untyped params.
      Single-hop is measured worthless; the fixpoint must propagate through
      the call graph to convergence. The IR middle-end already has
      `src/ir/propagate.ts` (#1131) — extend it rather than building anew.
- [ ] **#4155 Phase 0's three `it.fails` bugs** (return-position instance,
      array round-trip, method-added field): correctness holes in the same
      machinery; any read-side work must not paper over them.

### Workstream 2 — JIT-class structural work (the ~3.5x residue)

- [x] **#3926 — `__extern_get` lookup cost**: perfect-hash / `br_table` the
      key dispatch (today: 1,080 ifs, 463 `ref.test`, 303 `__str_equals`,
      zero `br_table`). Pays off on every read Workstream 1 does NOT convert.
      → LANDED 2026-08-06: baked-hash + `br_table` bucket dispatch, +4.1%
      `standaloneDynamic` (3 interleaved pairs, min-new > max-base), self-time
      7.91% → 6.33%, +2,001 B. The residual self-time is receiver `ref.test`
      arms + the per-lookup flatten, so the "< 3%" acceptance line below stays
      open. Details in #3926's Results section.
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
5. **#3927 per-shape fnctor splitting — demotion CONFIRMED with a measured
   coefficient (2026-08-06)**: the #3927 pad probe (`JS2WASM_FNCTOR_PAD_SLOTS`)
   measured d(wall)/d(ref-slot) ≈ 0.1 %/slot (+36 slots → GC bucket
   20.7 → 24.9 %, ≈ +3-4 % wall point estimate; quiet A/B blocks scatter
   −1…+24 %, ambient variance dominates — the profile share shift is the
   instrument). Best affordable removal (hot/cold tail split, −37 of 62 union ref
   slots) prices at ≈ −3-4 % wall — behind #3926 and the dynamic-eq item.
   Design + dispatcher-chokepoint enumeration recorded in #3927 Results §7.
   Cautionary note: an uncontrolled first A/B block read +29 % (3/3 pairs) and
   was pure concurrent-load contamination — order-reversal control caught it
   (#3927 Results §5-§6).

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

## 2026-08-07 — re-profile after the landed Workstream-2 slices

Same recipe as §Reproduction, same lane, same 300 iterations, on
`claude/issue-743-i32-producer` (main + PR #4202). **The three Workstream-2 items
this file called out have landed, and the profile has moved — but the share
they gave up went to GC, not to the floor.**

### Bucket shift, 2026-08-06 → 2026-08-07

| bucket | 08-06 | 08-07 | note |
| --- | ---: | ---: | --- |
| **gc-engine** | 18.5 % | **23.1 %** | **grew — now the largest single bucket** |
| scanner + compiled | — | 32.1 % | (08-06 did not split scanner out) |
| dynamic-lookup | 16.1 % | 13.5 % | #3926 hash dispatch landed |
| call-dispatch | — | 8.1 % | |
| regexp | 6.6 % | 7.3 % | grew in share |
| dynamic-eq | 7.1 % | 5.2 % | strict-eq tag-pair dispatch landed |
| cast-convert | 6.1 % | 4.6 % | |
| string-runtime | 5.6 % | 4.3 % | `charCodeAt`-on-rope guard landed |

Top frames: `(garbage collector)` 23.05, `__regex_search` 6.07,
`__extern_get` 5.92, `__is_truthy` 2.92, `pp.next` 2.66, `__str_flatten` 2.42,
`pp.getTokenFromCode` 2.37, `pp$5.parseSubscript` 2.29, `pp.fullCharCodeAt`
2.05, `__extern_strict_eq` 2.05, `__box_number` 1.99.

Lane ratio this run: **0.141** (≈ 7.1× slower than Node), from 0.122 —
directionally consistent with the three landed slices. Single unreplicated
measurement on a shared box, well inside §6's unresolvable band; quoted as
context, not as a result.

### What this changes about the program

**Every helper bucket the umbrella named has now shrunk, and the total did not
fall proportionally, because GC absorbed the difference.** Allocation volume is
now the binding constraint — which is what #3921 measured directly
(~43.6 MB per 226 KB source, only ~10 MB of it the returned AST).

Workstream 1's diagnosis ("GC + dynamic-eq + cast-convert ≈ 32 % is the boxed-
VALUES tax") stands, and the 08-07 figure is **32.9 %** — but the *route* it
prescribed has now priced out four times in a row on this corpus:

| lever | result |
| --- | --- |
| #4155 four receiver-side levers | null on wall |
| PR #4202 evaluator precision (3 rules) | **1 slot**, +27 B |
| PR #4205 ref/string consumer ABI | **1 candidate**, **0 bytes** |
| #3927 per-shape splitting | ≈ 0.1 %/slot, priced 3-4 % at highest risk |

The receiver-side program is not wrong, it is **exhausted for acorn**: acorn's
types bottom out at untyped exported-entrypoint parameters, so each lever
converts a handful of slots and the values stay boxed.

### Redirect: attack allocation directly, not via slot typing

#4185 already enumerated the remaining streams by count and **priced one it did
not take**:

| stream | count | status |
| --- | ---: | --- |
| `$AnyString` substring/concat headers | 58 k | string VALUES — not elidable |
| **`__regexp_test_carrier` capture scratch** | **29 k** | **priced M, NOT TAKEN** |
| **`__regex_run` state** | **18.7 k** | **priced M, NOT TAKEN** |
| `__fnctor_Node` | 32.5 k | the real AST — inherent |
| `__vec_externref` closure arg vecs | ~25 k | spread wide, no chokepoint |
| `$AnyValue` residual | ~22 k | honest boxing — #743 territory |

**The regex pair is the largest remaining ELIDABLE stream (47.7 k allocations
per parse) and it is unowned.** It is also the only candidate that hits two
grown buckets at once: it feeds GC (23.1 %) *and* it is the `regexp` bucket
(7.3 %, `__regex_search` the #2 frame overall), reached almost entirely via
`__regexp_test_carrier`/`__call_m_test_1` on tokenizer `.test` calls — a
narrow, enumerable call set, not a spread-wide helper.

It was deferred for scope ("touches the regex engine"), not for size. That
tradeoff should be re-taken now that it is the top elidable stream rather than
one of six.

**Recommended next slice: reuse the `.test`-path scratch** (captures array +
run state) instead of allocating per call, guarded so anything that can escape
or observe identity falls back to a fresh allocation. Pre-register the census
delta as the primary instrument (deterministic), with the GC bucket share as
the secondary — per §6, a wall A/B on this box cannot resolve the expected move
on its own.

**Second recommendation, from PR #4205:** measure a **second dogfood corpus**
before the next representation lever. Four levers have now priced out for
reasons specific to acorn's shape; a corpus with declared types would say
whether the representation program is exhausted generally or only here.

## 2026-08-08 — cross-runtime profile: wasm and Node bucketed side by side

Every prior profile in this file measured only the wasm side. This run profiles
**both runtimes with the same instrument** (`--profile-runtime wasm` and
`--profile-runtime node`, 300 iterations each, same runtime-suffixed 226 KB
corpus) and joins them phase by phase, so "where it loses to Node" is now a
per-bucket subtraction rather than an inference. Fresh 4-core Xeon 2.10 GHz
container, Node 22.22.2, main @ `41ad08c3`, binary 1,567,288 B, checksum green.

Per-parse from the profile windows (34,325 ms / 300 wasm; 4,234 ms / 300 node):
**wasm 114.4 ms vs node 14.1 ms → 8.1×**. Wasm agrees with its unprofiled lane
median (116.0 ms) to within 1.5 %; the node side is where the ratio moves —
this session's two lane runs gave node medians of 21.9 ms and 18.8 ms (lane
ratios 5.3× / 6.4×) against 14.1 ms under the profiler. The node baseline swing
is the known §6 band; the wasm number is stable across all four measurements.

### The side-by-side (ms per parse, self-time)

| phase | wasm | share | node | share | wasm/node |
| --- | ---: | ---: | ---: | ---: | ---: |
| scanner/tokenizer (compiled acorn) | 21.6 | 18.9 % | 7.1 | 50.0 % | **3.1×** |
| parser logic (compiled acorn) | 20.9 | 18.2 % | 5.9 | 41.9 % | **3.5×** |
| dynamic-lookup (`__extern_get` 6.9 pp + per-key members) | 18.0 | 15.7 % | — | — | — |
| gc-engine | 13.6 | 11.9 % | 0.9 | 6.4 % | 15× |
| call-dispatch (`__dc_*`, `__call_fn_method_*`) | 11.7 | 10.2 % | — | — | — |
| regexp engine (`__regex_search` 6.7 pp) | 9.2 | 8.1 % | ~0.1 | 0.9 % | (see caveat) |
| dynamic-eq (`__is_truthy` 3.3 + `__extern_strict_eq` 2.2) | 6.5 | 5.7 % | — | — | — |
| string-runtime (`__str_flatten` 2.8, `__str_equals` 1.2) | 5.9 | 5.1 % | — | — | — |
| cast-convert (`__box/__unbox/__to_primitive`) | 5.5 | 4.9 % | — | — | — |
| alloc-helpers | 1.3 | 1.2 % | — | — | — |
| **total** | **114.4** | | **14.1** | | **8.1×** |

Node's regexp row counts only acorn's own `regexp_*` validator frames; V8
attributes native `RegExp.test` ticks to the calling JS frame, so some node
regexp time hides inside its scanner rows. The 72× row-ratio is therefore an
overstatement — but the wasm regexp engine at 9.2 ms/parse still exceeds any
plausible node figure several times over.

### Gap attribution (100.3 ms of gap)

| component | ms | % of gap |
| --- | ---: | ---: |
| runtime helpers with **no node counterpart** (lookup + dispatch + eq + string + cast + alloc) | 49.2 | **49 %** |
| compiled parser slower than JIT'd parser | 14.9 | 15 % |
| compiled scanner slower than JIT'd scanner | 14.6 | 15 % |
| extra GC | 12.7 | 13 % |
| extra regexp | 9.1 | 9 % |

Reading: **Node spends 92.9 % of its parse inside acorn's own code; the wasm
build spends 37.1 % there.** The other 62.9 % is machinery — helper functions
(43.0 %), GC (11.9 %), and the wasm regex engine (8.1 %). Removing every
helper/GC/regexp millisecond would leave 42.5 ms vs 14.1 ms ≈ **3.0×** — the
measured floor of the "JIT-class residue" this umbrella estimated at ~3.5×.
Conversely the residue cannot be attacked below ~3× without making the
compiled scanner/parser code itself faster, which is register allocation /
inlining / IC-class work, not helper elision.

Scanner/parser rows are self-time only: helper time *caused by* the scanner
(e.g. `__str_flatten` re-entered from `skipSpace`, both still visible in this
profile at 2.8 pp) is charged to the helper buckets, so the 3.1×/3.5× rows are
lower bounds on the phases' end-to-end cost ratio.

Reproduction: §Reproduction above for the wasm side; the node side is the same
command with `--profile-runtime node --profile-output .tmp/acorn-node.cpuprofile`
(no closure map needed), bucketed with `profile-buckets.mjs <profile> /dev/null`.
Phase split for node frames: `read*/next/nextToken/skip*/finish{Token,Op}/
updateContext/curContext/getTokenFromCode/types$1.*` → scanner; `regexp_*` +
`readRegexp` → regexp; remainder → parser.

## Dupe check

#3780 stays open as the measurement/goal issue; this umbrella is its
execution program. #4155/#743/#3926/#3927 are the children and keep their own
acceptance criteria; this file only sequences them and pins the measurement
rules.

## 2026-08-07 — regexp scratch slice landed (record in #4185)

The `.test`-path capture scratch and the `__regex_run` backtrack frames — the
last two elidable allocation streams the #4185 ledger had priced and left — are
now reused instead of re-allocated (`JS2WASM_REGEXP_TEST_CAPS_POOL`,
`JS2WASM_REGEXP_FRAME_REUSE`, both default ON). Full measurement, flag
rationale and gates: **#4185, section "2026-08-07 — the regexp scratch streams"**.

Two results from that run that change what the NEXT slice should target:

1. **−47,838 allocations per parse (−18.2 % of the post-#4173/#4185 total of
   262,711) bought ~0.4 pp of parse self-time**, not ~18 %. gc-engine drops
   0.44 pp, 3/3 order-balanced profile pairs; wall was unresolvable (the
   same-code Node baseline swung 51 % across the eight runs on this box).
2. **Rank allocation streams by count × instance size, not by count.** The two
   streams taken were the smallest objects in the census (~16 B and 20 B):
   18.2 % of allocation EVENTS, roughly 2–3 % of allocated BYTES.
   `__fnctor_Node` alone (32,468 × 292 B ≈ 9.5 MB/parse) outweighs every
   remaining elidable plumbing stream combined, and the `$AnyString` /
   `$AnyValue` boxing streams outweigh what is left after that. That points the
   residual GC bucket squarely back at **Workstream 1** (value representation:
   #4155 / #743), not at further plumbing elision.

## 2026-08-07 — the `i31` lever is already spent, and the byte-ranked table

All numbers below re-measured on `origin/main` today (post-PR #4211),
standalone-dynamic acorn self-parse, checksum 422:

```
JS2WASM_ALLOC_CENSUS=1 npx tsx scripts/generate-npm-compat-report.mjs \
  --only acorn --no-write --perf-only --lane standalone-dynamic \
  --inspect-binary <out.wasm>
```

then instantiate, call `__module_init`, snapshot every `__alloc_count_*`
global, run `__npmCompatStandaloneBenchmark(1, 3780)`, and diff.
(`tests/issue-3921-alloc-census.test.ts` shows the idiom.) Adding
`JS2WASM_ALLOC_CENSUS_CALLS=<substr>` (#4185) adds per-(caller→callee) call
counters for matching callees — that is what §1 below rests on.

### 1. Packing small ints into `i31` is dead twice over

The plausible future lever — "JS numbers in dynamic fields heap-allocate a
boxed struct, so pack signed-31-bit integers into `i31ref` and skip the
allocation" — is closed on both ends.

**(a) It already exists.** `src/codegen/registry/imports.ts:1113-1160`
registers `__box_number` with an `i31` fast path (#3673): a value that
survives an `i32.trunc_sat_f64_s` round-trip *and* a `shl 1 / shr_s 1`
round-trip becomes `ref.i31` with no allocation; everything else falls through
to `struct.new`. The exclusion list is the reusable part, and the comment
carries the *why*:

> Excluded: `-0` (i31 cannot carry the sign — `1/x` and `Object.is` would lose
> it), NaN and infinities (fail the trunc round-trip), and values outside
> `[-2^30, 2^30-1]` (fail the shl/shr round-trip).

**(b) The remaining prize is 0.06 MB/parse.** The boxed-number struct is
`type_67` — `struct, 1 fields (1×f64), ~16 B/instance` — allocated **3,862
times per parse, 1.79 % of 215,286 allocations, ≈0.06 MB**, against a parse
allocating **12.34 MB** of struct bytes. Even eliminating it entirely is
0.5 % of struct bytes.

**(c) It resolves the `__box_number` puzzle.** The 08-07 profile above puts
`__box_number` at **1.99 %** self-time while it barely allocates. Measured
cause, via the call census:

| | per parse |
| --- | ---: |
| `__box_number` calls | **556,923** (70 call sites) |
| …that allocate (`type_67`) | 3,862 |
| …that take the `i31` path | **553,061 — 99.31 %** |

So it is called **2.6× more often than the parse allocates anything at all**,
and 99.31 % of those calls never touch the heap. Its 1.99 % is call overhead
plus the range test — **not** allocation. The lever that would move it is
inlining/call elimination at the top callers (one closure alone accounts for
163,778 calls), not anything in the allocator.

### 2. The byte-ranked table — and why count-ranking misleads

PR #4208's lesson generalised: **rank allocation streams by count × instance
size, not by count.** It removed 18.2 % of allocation *events* for ~0.4 pp of
runtime because the streams it took were the smallest objects in the census
(this is already recorded in the preceding section; the table is what was
missing).

Shapes come from the census build's own stderr dump, joined to the counts **by
export name** (see §3a):

| type | count/parse | size | bytes/parse | byte share |
| --- | ---: | ---: | ---: | ---: |
| `__fnctor_Node_18` — struct, 69 fields (62×externref, 3×ref_null, 2×f64, 2×i32) | 32,468 | 292 B | **9.48 MB** | **76.8 %** |
| `type_7` — struct, 3 fields (2×i32, 1×ref) | 54,818 | 20 B | 1.10 MB | 8.9 % |
| `type_75` — struct, 5 fields (2×i32, 1×f64, 1×eqref, 1×externref) | 22,008 | 32 B | 0.70 MB | 5.7 % |
| `__vec_externref_2` — struct, 2 fields (1×i32, 1×ref) | 31,414 | 16 B | 0.50 MB | 4.1 % |
| `type_235` — struct, 6 fields (5×f64, 1×externref) | 7,252 | 52 B | 0.38 MB | 3.1 % |
| `type_67` — boxed number, 1×f64 | 3,862 | 16 B | 0.06 MB | 0.5 % |
| `type_1` / `type_5` | 27,361 / 26,064 | arrays (4 B and 2 B per element) | payload-dependent | — |

The inversion is the point: by **count** the node struct is 15.1 % and ranks
*second*; by **bytes** it is three quarters of everything. Array types are
excluded from the byte total because the census records per-element size, not
length.

**Caveat — the struct-byte denominator does not currently agree with itself.**
This run measures **12.34 MB / node at 76.8 %**, over 215,286 allocations
baselined *after* `__module_init`. #3927 §1 records **12.23 MB / 77.5 %** in
its table but **12,827,613 B over 270,062 allocations** in the adjacent prose
— and 9,480,656 / 12,827,613 is 73.9 %, not 77.5 %. The count gap is most
likely the `__module_init` baseline (this reader excludes module-init
allocations; a whole-instance snapshot does not). The three figures cannot all
be right; resolving them belongs to #3927, which owns that measurement. What
is **not** in doubt and is safe to quote: the node struct is between three
quarters and 78 % of struct bytes, and this supersedes the older **43.6 MB**
figure, which came from `--trace-gc` and also counts array payload (both are
right about different quantities — quote the census when ranking struct-shape
levers).

Note the counts themselves are **unchanged** from the pre-#4211 measurement,
so the table is current on today's main.

### 3. Two instrument traps, each of which nearly produced a wrong conclusion

**(a) Type numbering: the census and `wasm-dis` do not share it.** Census
counters are named in the **compiler's** type numbering
(`__alloc_count_type_67`); `wasm-dis` shows **post-`wasm-opt`** indices, and
the optimizer renumbers types. Reading a struct's shape off a disassembly and
matching it to a census counter by index gives a wrong answer — doing exactly
that nearly recorded the AST node struct as 7 fields when it has **69**. The
only correct join key is the census build's own stderr shape dump, keyed by
export name. `src/codegen/alloc-census.ts:26-27` already states the reason
("`wasm-opt` renumbers types, so a `typeIdx`-keyed reader would go stale,
while export names survive"); this is its concrete failure mode.

**(b) Never pipe a command whose exit status — or whose output — you need.**
Already a repo rule, and it bit twice more today: a gate piped to `tail -3`
showed only trailing advisory text and hid its `FAILED` line, so a broken PR
shipped. The output half is the less-documented one: truncating with `tail -N`
*inside* the command loses the rest **permanently**, which is how a 30-file
test sample was rendered uninterpretable (see #3552, 2026-08-07).

## 2026-08-07 — `__box_number` provability: measured, DON'T BUILD

**Verdict: DON'T BUILD.** The compiler can already prove the value is an
in-range integer at **35.8 % of `__box_number` emission sites (883 / 2,466)**,
but those sites are cold: they carry only **13.6 % of the 556,923 calls per
parse**. And the whole helper — call, checks and all, at 100 % of calls — is
worth **≲2 % of parse wall time**, measured. So a proof-backed fast path on the
provable sites is worth **~0.2–0.4 % of parse time: below this benchmark's own
noise floor.**

Lane `standalone-dynamic`, acorn 226 KB self-parse, checksum 422 intact on every
build. Instrumentation was a temporary per-site extension of the #4185 call
census (`src/codegen/alloc-census.ts`), reverted; this section is the only
artifact. The instrument reproduced the established **556,923 calls/parse**
exactly, which is what validates it.

### The bucket table

| bucket | meaning | static sites | site % | dynamic calls | **call %** |
| --- | --- | --- | --- | --- | --- |
| **A1** — i32 source | `f64.convert_i32_s` immediately feeds the call (the `type-coercion.ts:414` round trip) | 182 | 7.4 % | 9,277 | **1.67 %** |
| **A2** — constant, i31-able | `f64.const` whose value is an integer in `[-2^30, 2^30-1]` | 689 | 27.9 % | 62,463 | **11.22 %** |
| **A3** — constant, not i31-able | `f64.const`; **every one is `Infinity`** | 12 | 0.5 % | 3,862 | **0.69 %** |
| **A total** | provable with **zero** dataflow — the producer instruction says it | **883** | **35.8 %** | **75,602** | **13.57 %** |
| **B** — provable via IR lattice | f64 source that `propagate.ts` / #4202's bitwise-producer rule prove i32/u32 | 13 | 0.5 % | **0** | **0.00 %** |
| **C** — not provable | everything else | 1,570 | 63.7 % | 481,321 | **86.43 %** |

Three things in that table are worth more than the totals:

- **The `:414` i32 round trip — the "clearest sub-population" — is confirmed but
  nearly worthless.** It is real (182 sites emit `f64.convert_i32_s` and the
  helper immediately truncates back) and it is **1.67 % of calls**. It looked
  like most of the answer; it is a fortieth of it.
- **Bucket B is empty, and not by accident.** The lattice's `i32`/`u32` atoms
  come only from *syntactic* bitwise/shift producers (`fnctor-i32-producers.ts`)
  — and any value a bitwise operator produced is already i32 at the emission
  point, i.e. already bucket A. There is no second population for B to hold. Its
  13 sites fired 0 times.
- **Every non-i31 box in the parse is the constant `Infinity`.** A3's 3,862 calls
  equal, exactly, the parse's 3,862 boxed-struct allocations — so all 553,061
  other calls provably took the i31 path. That is a separate, much cheaper
  finding: one hoisted module global would take this workload's `__box_number`
  allocation count to **zero**. (It is 3,862 allocations out of 262,711 — 1.5 %
  — so it is a tidiness win, not a perf one. Noted, not recommended.)
  → **Built anyway, in the general form, and it was cheap: see "constant boxes
  hoisted to module globals: LANDED" below.** The "not recommended" verdict was
  about *perf*, and it stands — no wall-clock claim is made. What changed the
  cost side is that the general form turned out to need no new machinery and to
  make the binary *smaller*.

### Top call sites by dynamic count

Caller names are from a `preserveDebugNames` build. The shape is the finding:
**this is not a distribution, it is a shortlist.** Nine sites carry 71 % of all
calls, and every one of them is an acorn *source position* or a *char code*.

| calls | share | bucket | producer | caller |
| --- | --- | --- | --- | --- |
| 163,778 | 29.41 % | C | `Parser.pos` field | `__closure_686__typed_this` |
| 41,890 | 7.52 % | C | `get end()` return | `__closure_346` |
| 41,890 | 7.52 % | C | `get start()` return | `__closure_346` |
| 41,889 | 7.52 % | C | `Parser.fullCharCodeAtPos()` return | `__closure_683__typed_this` |
| 32,468 | 5.83 % | C | `Parser.lastTokEnd` field | `__closure_598__typed_this` |
| 25,705 | 4.62 % | **A2** | integral `f64.const` | `__closure_684__typed_this` |
| 23,117 | 4.15 % | C | `Node.start` field | `__get_member_start_460` |
| 23,046 | 4.14 % | C | `get start()` return | `__closure_251` |
| 17,129 | 3.08 % | C | local: `NaN` ∪ `if` result | `__closure_708__typed_this` |
| 10,593 | 1.90 % | C | local: `NaN` ∪ `Parser.start` | `__closure_546__typed_this` |
| 8,838 | 1.59 % | C | `type75` field 2 | `__any_to_extern_318` |
| 8,781 | 1.58 % | C | local: `NaN` ∪ `Parser.start` | `__closure_542__typed_this` |
| 8,781 | 1.58 % | C | local: `NaN` ∪ `Parser.start` | `__closure_542__typed_this` |
| 8,781 | 1.58 % | **A2** | integral `f64.const` | `__closure_542__typed_this` |
| 7,702 | 1.38 % | **A1** | `f64.convert_i32_s` | `__call_m_push_1_529` |

Aggregated, the source-position and char-code producers (`Parser.pos`,
`.start`, `.end`, `.lastTokEnd`, `.awaitPos`, `.yieldPos`, `fullCharCodeAtPos`,
`Node.start/end`) are **399 sites and 390,967 calls — 70.2 %**. They are all
bucket C today. Reaching them needs a *new* whole-program analysis proving a
struct field / function return is always an integer in range — the lattice
carries per-field and per-return atoms (`inferPropertyAccessAtom`,
`entries.returnType`) but has no value-range domain to fill them from. That is
the only path to a majority of these calls, and the timing below is why it
should not be walked.

### The number that decides it

Bucket-count alone cannot decide this — 13.6 % of calls is neither obviously
worth it nor obviously not. So the helper's **total** cost was priced directly.

`__box_number`'s body was temporarily replaced by a round-trip-check-only
variant (11 instructions: keep `trunc`/`convert`/`f64.eq`, drop the shl/shr
31-bit check and the `-0` sign check). That is **correct on this workload** —
the census proved the only non-i31 value boxed is `Infinity`, which still fails
`f64.eq` and still boxes — and both builds return checksum 422. At 11
instructions `wasm-opt` **does** inline it: `ref.i31` goes from **1** occurrence
in the baseline `-O` binary to **1,255**. So the probe removes, at 100 % of
556,923 calls, both the call/return and 13 of the 24 body instructions —
roughly two-thirds of the entire machinery.

Interleaved A/B, 40 reps each, both orders, same box:

| order | baseline med | probe med | Δ med | Δ min |
| --- | --- | --- | --- | --- |
| base→probe | 108.8 ms | 111.9 ms | **−2.84 %** | +1.13 % |
| probe→base | 109.4 ms | 111.1 ms | **+1.53 %** | −0.43 % |

**The sign flips with ordering.** Removing two-thirds of the box machinery at
every single call is indistinguishable from zero, bounded at roughly ±2 %.

That is consistent with first-principles arithmetic rather than contradicting
it: ~30 instructions × 556,923 ≈ 16.7 M ops per parse, but they are
register-only integer ops behind a branch taken 99.31 % of the time — at ~4 IPC
on a 3 GHz core that is ≈1.4 ms, ≈1.3 % of a 110 ms parse. Both methods agree
the whole helper is worth 1–3 %.

**So: 13.57 % of calls × ≲2 % of parse ≈ 0.2–0.4 %.** For comparison, the
regexp-scratch slice above removed 18.2 % of all allocations and bought ~0.4 pp.
This is smaller than that, for more machinery.

### Instruction and code-size arithmetic (for the record)

Per call, fast path: baseline is `call` + ~24 body instructions + prologue ≈ 30.
A proof-backed lowering is:

| site kind | replacement | instrs | saved |
| --- | --- | --- | --- |
| A2 (constant, i31-able) | `i32.const N; ref.i31; extern.convert_any`, or one `global.get` | 3 (or 1) | ~27 |
| A1, range provable | `ref.i31; extern.convert_any` (and drop the `f64.convert_i32_s`) | 2 | ~28 |
| A1, range **not** provable | inline shl/shr check + branch, both arms | ~12 | ~18 |

≈2.1 M instructions per parse across bucket A.

**Code size is not the obstacle, which is the interesting part.** Two measured
data points on the same binary: inlining a **4**-instruction boxing sequence at
1,314 sites cost **+814 bytes (+0.05 %)**; inlining an **11**-instruction one at
1,255 sites cost **+22,847 bytes (+1.48 %)**. A 2–3 instruction proof-backed
replacement for `f64.const; call` or `f64.convert_i32_s; call` is therefore
**size-neutral to size-negative** — it replaces a 9-byte `f64.const` plus a
2-byte `call` with ~5 bytes.

So `wasm-opt`'s refusal to inline is defensible *for what it was asked* — the
full ~30-instruction helper at 1,325 sites is genuine growth — and the compiler
really would be overruling it with proof `wasm-opt` lacks, at no size cost. The
optimization is well-formed. It is simply not worth anything: the thing it
makes faster is already ≲2 % of the parse.

### What this rules out, and what it points at

- **Do not build** a provability-driven `__box_number` fast path. Not for
  bucket A (13.6 % of calls, ~0.3 % of parse), and emphatically not the
  whole-program field/return integrality analysis that bucket C's 70 %
  would require — that is a large analysis for ≲2 % ceiling.
- **`type-coercion.ts:414`'s i32→f64→i32 round trip is a real inefficiency and
  should stay unfixed on perf grounds.** If it is ever cleaned up, it should be
  as a clarity change, not sold as a speedup.
- The finding reinforces the section above: the boxing *call* is cheap because
  #3673's i31 path already avoids the allocation 99.31 % of the time. What
  remains expensive is what the census keeps pointing at — the objects that
  are actually allocated and their size (`__fnctor_Node` at 292 B), i.e.
  Workstream 1 (#4155 / #743), not the boxing plumbing.

## 2026-08-07 — constant boxes hoisted to module globals: LANDED

Follows directly from the `__box_number` provability section above, which
recorded as an aside that "one hoisted module global would take this workload's
`__box_number` allocation count to zero". Built as the **general** form — every
boxing site whose operand is a compile-time constant, not an `Infinity` special
case — in `src/codegen/const-box-hoist.ts`, wired into both finalize sequences
in `src/codegen/index.ts`. Lane `standalone-dynamic`, acorn 226 KB self-parse,
**checksum 422 on every build**.

`f64.const K; call $__box_number` becomes one `global.get` of a module global
that `__module_init` seeds once by calling the same helper. (`i32.const N;
f64.convert_i32_s; call` — the `type-coercion.ts:414` round trip on a constant —
is the same population and is rewritten the same way.)

### The result

| | before | after | Δ |
| --- | ---: | ---: | ---: |
| **boxed-number allocations** (`type_67`) per parse | 3,862 | **0** | **−3,862** |
| all allocations per parse | 215,286 | 211,424 | −3,862 |
| every other allocation stream (25 of them) | — | — | **byte-identical** |
| `__box_number` calls per parse | 556,923 | 490,598 | **−66,325 (−11.9 %)** |
| static emission sites rewritten | — | 697 → 49 globals | — |
| static `call __box_number` sites | 2,466 | 1,818 | −648 (+49 in the seed block) |
| binary, `--lane standalone-dynamic` | 1,544,411 B | 1,543,371 B | **−1,040 B (−0.07 %)** |
| binary, dogfood standalone acorn | 937,273 B | 936,139 B | −1,134 B |

The allocation delta is **exactly** the whole boxed-number stream and **exactly**
nothing else — which is the same statement the provability section made from the
other direction (every allocating box in this parse is the constant `Infinity`),
now confirmed by construction.

**Code size goes DOWN, which was not guaranteed.** 49 globals plus a 148-
instruction seed block cost less than the 697 `f64.const` (9 B) + `call` (2 B)
pairs they replace with a 2–3 B `global.get`. This is the same arithmetic the
provability section measured for inlining and reached the same sign.

It breaks even at roughly **three sites per distinct constant** (~21 B fixed per
constant, ~8 B saved per site); acorn averages 14. A toy module with one site
per constant grows by tens of bytes — measured, a 5-site js-host probe went
435 → 485 B. A "only hoist constants used ≥3 times" threshold would remove that
and is deliberately **not** applied: the site count is STATIC, and the
highest-value case in the measured workload is the opposite shape — 12 static
`Infinity` sites executing 3,862 times. Gating on static count would trade the
actual deliverable for bytes on modules too small for the bytes to matter.

**No wall-clock number is quoted, deliberately.** The section above priced the
*entire* helper at ≲2 % of parse, with a probe removing two-thirds of its body at
100 % of calls producing a result whose sign flipped with run order. 11.9 % of
that is far below what this box can resolve. What this change buys is the
deterministic allocation and call result above.

### Is the identity of a boxed number observable? (checked, not assumed)

Hoisting collapses two boxes of the same constant into ONE reference, so this is
the load-bearing question. Three findings, in increasing order of usefulness:

1. **For i31-able values shared identity is ALREADY the regime.** `ref.i31` is
   not a heap object — two `ref.i31` with the same payload are already
   `ref.eq`-equal. #3673 puts 99.31 % of this workload's boxing on that path, so
   the majority of boxed numbers have had shared identity since #3673 landed.
2. **Every consumer compares boxed numbers BY VALUE, and each was written that
   way because distinct boxes of equal values exist.** `__extern_strict_eq`
   (`any-helpers.ts`) takes `ref.eq` as a fast path but EXCLUDES the
   `$BoxedNumber` carrier from it (#3174) and falls through to `f64.eq`; the
   standalone `===` tag dispatch (`binary-ops-typed-dispatch.ts`, #1776) tries
   "both typeof number → unbox + f64 compare" BEFORE any identity arm;
   `__same_value_zero` (`map-runtime.ts`) takes identity ⇒ equal, which is what
   SameValueZero wants.
3. **The direction of the change is the safe one.** Sharing can only turn two
   distinct refs into one, i.e. flip an identity test from false to true — and
   for every constant except one that is the answer the spec already requires
   (`Infinity === Infinity` is true, `-0 === -0` is true). A consumer that
   trusted `ref.eq` gets *more* correct, not less.

**The one exception is `NaN`**, where `NaN === NaN` must be FALSE even for the
same reference — precisely the case #3174 exists for. Both `===` paths handle a
self-identical NaN box correctly today, so this is belt-and-braces, but NaN is
the single value where sharing is a semantic *risk* rather than a semantic
*improvement*, and the census found **no NaN at all** in the constant population
(bucket A3 was entirely `Infinity`). So the pass excludes NaN: it buys nothing
and its carve-out removes a whole risk class. `+0` and `-0` are keyed apart by
`Object.is`, so `-0` never collapses into `+0`.

### Why `__module_init` seeding rather than a constant global initializer

`ref.i31` / `struct.new` / `extern.convert_any` are all valid constant
instructions, so the boxes *could* be built in each global's own init
expression. That would require the pass to re-derive #3673's i31-ability rule
(integral, in `[-2^30, 2^30-1]`, not `-0`) — a **second encoding of a rule that
lives in `registerNative("__box_number", …)`**, and a silent miscompilation the
day the two drift. Seeding by CALLING the helper keeps exactly one boxing
implementation in the compiler. The cost is a three-instruction flag test per
`__module_init` entry.

### Gates

`tests/issue-4157-const-box-hoist.test.ts`. The mechanism half is the one worth
noting: the first draft of the fixture had no top-level state, so the module had
no `__module_init` to seed from, the pass correctly bailed, and ON/OFF produced
**byte-identical binaries** — a parity-only test would have passed while
measuring nothing. The test now asserts the binaries differ, and pins the
per-iteration slope of both censuses: a loop whose only boxing is of constants
drops from 4 `__box_number` calls per iteration to **0** while a control
function boxing non-constants is untouched, and the allocation stream falls by
exactly 3 (the three constants that are not i31-able — `42` is, and never
allocated). Answers are checked against native Node, not against the OFF build.

Dogfood: canaries 2/3/4/5, `functionImports: []`, exactly the 3 pre-existing
IR-FALLBACKs — all unchanged from the baseline measured on the same tree.

`JS2WASM_HOIST_CONST_BOXES=0` restores the pre-change emission byte-for-byte
(the pass returns before mutating anything);
`JS2WASM_HOIST_CONST_BOXES_DEBUG=1` prints the site/global counts and a
histogram of DECLINED sites keyed by producer shape — which is what answers
"is the residual population genuinely non-constant, or merely not adjacent?"
for anyone extending this.

## 2026-08-07 — session record, and where the next lane should start

Full write-up: **`plan/agent-context/session-2026-08-07-acorn-perf-handoff.md`**.
Read it before re-deriving anything below.

**Standing: ~7.1× slower than Node on `standalone-dynamic`, from ~8.1×.**

**The receiver-side type-inference route is exhausted for this corpus — five
levers, each priced with its number** (#4155 null · PR #4202 one slot of 96 ·
PR #4205 one candidate / 0 bytes · PR #4206 ≈0 movers · PR #4216 13.6 % of calls
× ≲2 % of parse). Two are *permanently* closed rather than under-built: `i31`
packing is already implemented and takes 99.31 % of the 556,923 `__box_number`
calls per parse, and the IR lattice structurally cannot supply a second
integrality population.

**The live work is allocation via struct layout**, and the two techniques
**overlap rather than compose** on `Node` — where a per-type layout is proved,
the cold tail has nothing left to move:

- PR #4217 — hot/cold split **default-ON**: −28.3 % of struct bytes, GC share
  −4.51 pp, ≈ −4.5 % wall. Its ranking is at the **static ceiling**: six
  corpus-independent proxies scored against ground truth, none beat ~25 % tail
  rate, because the predicted quantity (how often each node *kind* occurs) is a
  property of the corpus, not of the program being compiled.
- #4213 — per-type layouts, **analysis only**; emission not built. Marginal gain
  over #4217's new default is **−30.7 %**, with a **0 % residual rate** measured
  against ground truth.

**#3920 gated that emission slice** and is fixed in PR #4219 — three of five
reflective surfaces answered as if a compiled object had no properties whenever
its receiver arrived dynamically, so no differential could tell a correct layout
split from a broken one. Its transferable lesson is recorded in the handoff:
`Object.keys` was correct on builtins *precisely because* it was broken on user
classes, which makes #4071's revert structural and forces
predicate-before-arms ordering.

Also landed: **PR #4221** hoists constant number boxes to module globals —
boxed-number allocations **3,862 → 0**, `__box_number` calls **−11.9 %**, and the
binary **shrinks** 1,040 B. Justified on determinism and size, not wall clock;
#4216's DON'T-BUILD verdict was about *specializing the call for speed* and still
stands. `NaN` is excluded, because it is the one constant whose shared identity
is observable (`NaN === NaN` must stay false for the same reference).

**Still untouched by anything: dynamic property lookup 13.5 % + call dispatch
8.1 %.** Nothing in this umbrella currently targets either.

## 2026-08-08 — the second-corpus measurement RAN (pako): acorn's exhaustion does not generalize

The "measure a second dogfood corpus" recommendation is now answered — full
record in **#743, "2026-08-08 — second-corpus measurement"**. pako 2.1.0
(226 KB dist, function-ctors, numeric-heavy) censuses at **77.0 % typed vs
acorn's 58.3 %**, and its 25-slot untyped residue contains **zero** slots of
acorn's dominant "integer `this`-field-read argument" bucket. Its residue is
instead 68 % first-write-decides null seeds and 20 % ref-valued args — the two
levers acorn priced at ~0. Consequences for this umbrella: the receiver-typing
program is exhausted *for acorn specifically*; the `Parser.pos` field-fact XL
program serves acorn's number only and must be justified on that basis, not on
generality. pako becomes a runnable corpus once #4216 (i16 packed-local emit
bug, sole standalone blocker) lands; luxon/styled-components were measured
unusable (native-class syntax bypasses the fnctor machinery entirely / non-
self-contained bundle).

## 2026-08-12 — re-profile on current main: GC is spent, dynamic lookup is now the gap

First profile since the hot/cold split (#3927/#4217) and the constant-box hoist
went in by default. Same instrument as every prior table in this issue: acorn
self-parse, lane `standalone-dynamic`, 300 iterations, closure name map
attached, bucketed by self time.

| bucket | 2026-08-07 | **2026-08-12** |
| --- | ---: | ---: |
| gc-engine | 23.1 % | **2.97 %** |
| dynamic-lookup | 13.5 % | **21.15 %** |
| call-dispatch | 8.1 % | **11.39 %** |
| compiled + scanner (acorn's own code) | — | 40.00 % |
| dynamic-eq | — | 6.93 % |
| cast-convert | — | 6.07 % |
| string-runtime | — | 4.39 % |
| regexp | — | 4.04 % |
| alloc-helpers | — | 1.53 % |

**The allocation program is finished.** GC fell from the largest bucket to the
ninth. The two buckets this issue recorded as "untouched by anything" are now,
together, **32.5 %** — the largest addressable block left, and `__extern_get`
alone (9.22 %) is the single hottest frame in the profile, ahead of every
compiled acorn function and ahead of GC.

Note the earlier tables folded `scanner` into `compiled`; only the two bucket
columns marked with prior values are directly comparable.

### Where the dynamic reads come from

Every hot caller of `__extern_get` was read back to its acorn source, and they
are overwhelmingly one idiom — a flag read off the plain object `getOptions()`
returns:

| caller | self % | what it reads |
| --- | ---: | --- |
| `__fnctor_Node_new` | 1.26 | `parser.options.{locations,directSourceFile,ranges}` |
| `checkUnreserved` | 1.15 | `this.{inGenerator,inAsync}` — **prototype getters** |
| `__call_m_call_2` | 0.96 | method value |
| `finishNodeAt` | 0.82 | `this.options.{locations,ranges}` |
| `parseSubscripts` | 0.69 | `this.options.ecmaVersion` |
| `pp.next` | 0.68 | `this.options.onToken` |
| `readToken` | 0.56 | `this.options.ecmaVersion` |
| `nextToken` | 0.51 | `this.options.locations` |

`options` is built by `for (var opt in defaultOptions) options[opt] = …` — a
computed-key loop, so its key set is not syntactically visible and it stays an
open hash bag. It is written once at parse start, never mutated, and then read
on every node construction, every `finishNode` and every token.

### MEASURED NEGATIVE — the declared-field ladder is not the cost

The obvious first cut was tried and **does not pay**. Every arm of the
`fillClosedStructExternGetArms` ladder is guarded by `ref.test <closed struct>`
on the *receiver*, so a plain-`$Object` receiver can never satisfy one — yet it
still pays the full key dispatch first (`__str_flatten`, the hash read, the
`br_table`, a `__str_equals` per name in the bucket). A single `ref.test
$Object` up front skips all of it.

It was built, proved sound (no arm's receiver type is `$Object` or transitively
declared under it — `ref.test` is subtype-inclusive, so the check walks
`superTypeIdx` and any positive answer drops the screen rather than narrowing
it), and measured order-reversed **ON → OFF → OFF → ON**:

| block | order | `__extern_get` self | dynamic-lookup |
| --- | --- | ---: | ---: |
| onA | 1 (screen) | 9.09 % | 20.49 % |
| offA | 2 (base) | 8.85 % | 21.04 % |
| offB | 3 (base) | 9.17 % | 20.95 % |
| onB | 4 (screen) | 8.98 % | 20.81 % |

Mean 9.04 % ON vs 9.01 % OFF. The ON blocks replicate to 0.11 pp, so the null
is solid to about **±0.3 pp**. Wall clock also did not separate (and is below
this box's resolvability anyway — §6 of #3927).

**The guard was verified to fire, not merely to compile.** Poisoning the
screened branch — returning `undefined` immediately whenever the receiver is a
plain `$Object` — drops the parse from checksum 422 / 4,642 nodes to **0 / 0**.
So plain-object receivers really are a large share of the calls, and the null
is a statement about cost, not a broken instrument.

**Why it does not pay, in one number.** `__extern_get`'s final body is **15,032
instructions, and the ladder is 14,770 of them (98.3 %)** — but the *executed*
path through it is one `br_table` and one or two `__str_equals`. The ladder is
almost all of the function's SIZE and almost none of its TIME. The ~260
instructions outside it — the tombstone screen, receiver classification, the
own-property walk and the prototype walk — run on every call and are the 9 %.

The codegen change was therefore **reverted, not shipped**: a few instructions
of provably-dead-work elimination in the most load-bearing dynamic helper in the
compiler, for a benefit bounded at 0.3 pp, is the wrong trade. It is recorded
here in enough detail to rebuild if a future change makes the ladder hot.

### What this redirects to

The lever is **not a faster `__extern_get` — it is fewer calls to it.** Two
distinct populations, needing two different fixes:

1. **Plain objects with a stable shape.** `options` has a fixed key set for the
   whole parse; it is only "open" because the keys arrive through a computed
   write in a `for…in` over another static literal. Closing it (or caching the
   read at the site) turns millions of hash-bag walks into `struct.get`s. This
   is the same shape-set machinery as #3927's per-type layouts, applied to
   object literals rather than fnctors.
2. **Prototype accessors.** `this.inGenerator` / `this.inAsync` are
   `Object.defineProperties` getters and must run the accessor. `checkUnreserved`
   (1.15 %) and `currentVarScope` (1.21 %) are both this. Nothing here can be
   removed; it can only be made a direct call instead of a lookup-then-dispatch.

Call dispatch (11.39 %) is still untouched by anything in this umbrella.

## 2026-08-12 (2) — the per-key cache hit rate, and what it costs to redo the gap budget

Two follow-ups to the profile above. Both are first-time numbers.

### The `__extern_get` per-key cache is at 87 % — it is not the problem

`__extern_get` already carries a per-key inline cache (#3673 round 9b/21):
the `(owner, props-array, entry)` triple is memoized **on the interned key
string** (`$HashedString` fields 5/6/7), validated by `ref.eq` on the owner and
on the owner's props array, with tombstone/accessor flags re-checked. It was
never measured. It is now, by counter globals compiled into the census build
(reverted after measurement; harness in the reproduction note below):

| | per parse | % of calls |
| --- | ---: | ---: |
| `__extern_get` calls | **506,752** | 100 % |
| key is an interned `$HashedString` | 501,111 | 98.89 % |
| cache populated for that key | 461,159 | 91.00 % |
| owner + props both matched | 442,072 | 87.24 % |
| **served from cache** | **442,072** | **87.24 %** |
| populated but owner/props missed (thrash) | 19,087 | 3.77 % |

Checksum 422 on the instrumented build.

**Consequences, and they are the useful part:**

- **"Make the cache smarter" is priced out.** Thrash is 3.77 %. A wider
  (N-way, or shape-keyed rather than single-owner) cache is chasing at most
  that, and the monomorphic-per-key design is not the bottleneck it looked
  like from the source.
- **It explains the ladder-screen null recorded above, exactly.** The cache arm
  is unshifted LAST, so it runs BEFORE the declared-field ladder. The screen
  therefore only ever executed on the 12.76 % that missed — 64,680 calls, not
  506,752. A ladder skip on that population is worth ~0.05 %, which is precisely
  the ≤0.3 pp null that was measured. The two measurements agree; the earlier
  entry should be read with this one.
- **The cost is the HIT PATH, not the misses.** 11 ms of parse across 506,752
  calls is **21.7 ns per call** (~45 cycles at 2.1 GHz). The hit path is roughly
  40 instructions — a `ref.test`/cast on the key, a re-classification of the
  receiver, two `ref.cast`+`ref.eq` validity checks, then the entry read — plus
  the call itself. That is the budget any improvement has to come out of.

### Re-doing the gap attribution with GC collapsed

The 2026-08-08 cross-runtime table charged **12.7 ms/parse (13 % of the gap)** to
extra GC. GC is now 2.97 % of self time, so that line is down to roughly 3.5 ms:
**about 9 ms of the 100.3 ms gap has been closed by the allocation program**, and
the remaining gap is ~91 ms. Helper buckets with no Node counterpart now carry
close to **55 %** of it, with dynamic lookup alone (21.15 % ≈ 25 ms/parse) the
single largest addressable line — larger than the compiled scanner and the
compiled parser individually.

The 2026-08-08 conclusion is unchanged and now better supported: eliminating
every helper/GC/regexp millisecond leaves ~3× against Node, and the residue below
that is register allocation / inlining / IC-class work on the compiled code
itself, not helper elision.

### The named next slice, with its number

**Site- or name-local inline caching, to remove the CALL rather than speed the
helper.** Inside a per-name `__get_member_<name>` the key is a compile-time
constant, so the key `ref.test` + cast + hash are provably unnecessary, and the
receiver classification can be a single `ref.test $Object`. Serving 87 % of
506,752 calls from ~10 inline instructions instead of a call plus ~40 is worth on
the order of **5 % of total runtime** — above this box's ±0.3 pp measurement
floor, unlike everything else priced in this issue since #4208.

It is not free: it needs an entry-returning form of `__extern_get` (the value
alone cannot be cached — in-place value updates must stay visible, which is why
the existing cache stores the `$PropEntry`), plus per-name cache globals and
correct fallback for accessor, tombstone and non-`$Object` receivers. Note also
that the hot names in acorn (`locations`, `ranges`, `ecmaVersion`, `onToken`)
get **no** `__get_member_<name>` dispatcher today, precisely because no closed
struct carries them — so the slice must widen dispatcher reservation to
static-name reads with zero struct candidates, which is currently the condition
for emitting a direct `__extern_get` call.

**Reproduction (cache census).** Add counter globals at five points in
`unshiftExternGetProtoCacheArm` (arm entry, key-is-hashed, populated,
owner+props matched, value returned) using `newCounterGlobal`'s pattern from
`src/codegen/alloc-census.ts`, compile the standalone acorn self-parse driver at
`optimize: 0`, and read the exported globals after `__census_run()`. The
increments are stack-neutral, so they can be spliced mid-sequence.

## 2026-08-12 (3) — the lookup call volume is concentrated, and the call census is broken

Two findings from trying to size the inline-cache slice named above.

### Concentration: 15 functions carry 90 % of it

There are **1,812 static `__extern_get` / `__extern_get_idx` call sites** in the
standalone acorn build (reported by the #4185 call census at instrumentation
time, which succeeds even though the resulting module does not — see below).
But the profile's per-caller attribution shows the *dynamic* volume is nothing
like uniform across them: the top 15 callers carry **8.35 pp of `__extern_get`'s
9.22 pp, i.e. 90.6 %**, and the top 4 alone carry 4.19 pp.

This matters for the slice's design and for its main risk. Inlining ~20
instructions of cache check at all 1,812 sites would cost roughly +40 KB
(extrapolating the two measured inlining points recorded in the `__box_number`
entry above: 4 instructions × 1,314 sites = +814 B; 11 × 1,255 = +22,847 B).
Inlining at the sites inside the top ~15 callers gets ~90 % of the benefit for a
small fraction of the size. **The slice should be caller-targeted, not global** —
and because the ranking is a property of the corpus rather than of the program,
the *selection rule* has to be corpus-independent the way #3927's field ranking
had to be (see that issue's §7 for why observed-frequency ranking is not
admissible, and what it costs to give it up).

### DEFECT — `JS2WASM_ALLOC_CENSUS_CALLS` produces an invalid module

Running the call census against `__extern_get` instruments 1,812 sites and then
fails to instantiate:

```
[call-census] 2 callee(s) match [__extern_get]: __extern_get, __extern_get_idx
[call-census] instrumented 1812 static call site(s)
CompileError: Compiling function #106:"hasProp" failed:
  call[1] expected type f64, found local.get of type i32
```

The counter increment (`global.get` / `i32.const` / `i32.add` / `global.set`) is
stack-neutral, so a naive splice should validate; something about where it is
spliced relative to the argument sequence is not. The failure is at least loud —
it does not silently produce wrong counts — but it means **the second
attribution level (`WHO calls the helper, how often`) is unavailable for any
callee with this call shape**, and that is exactly the instrument the inline-cache
slice needs to verify its caller targeting. The per-type census
(`JS2WASM_ALLOC_CENSUS=1`) is unaffected and still trustworthy.

Not filed as its own issue: `claim-issue.mjs --allocate` reports the open-PR scan
DEGRADED in this container (no `gh`), and reserving an id against a degraded
universe is how #4215 was burned. It should get one when allocation is healthy.
