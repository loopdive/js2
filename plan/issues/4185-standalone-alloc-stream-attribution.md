---
id: 4185
title: "perf: attribute standalone acorn's 607k-allocation stream; kill the top elidable stream (dead $ObjVec pairs on dynamic closure .call)"
status: done
assignee: "ttraenkler/claude-fable-7"
sprint: 78
created: 2026-08-06
updated: 2026-08-18
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: performance
area: codegen
goal: performance
related: [4157, 3927, 3921, 4173, 4174, 3685, 743]
loc-budget-allow:
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/regexp-standalone.ts
func-budget-allow:
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
origin: "#4157 umbrella — GC/alloc bucket is 20.66% of parse self-time (largest); #3927's census counted 607,469 allocs/parse with only 32,468 attributed to __fnctor_Node"
---

# #4185 — attribute the standalone allocation stream, kill the top elidable one

## Problem

The GC bucket is the largest in the standalone acorn parse profile (20.66%
post-#4174), and the #3927 census counted **607,469 allocations per parse** of
which `__fnctor_Node` — the retained AST — is only 32,468 (5.3%). The other
~575k were unattributed. Nobody knew what the compiler was allocating.

## Mandate 1 deliverable — the attributed allocation table

Census machinery extended (`src/codegen/alloc-census.ts`, all env-gated,
byte-identical off): `JS2WASM_ALLOC_CENSUS_BY_FUNC=1` (per-function×type
counters), `JS2WASM_ALLOC_CENSUS_FOCUS=<substr,…>` (type filter),
`JS2WASM_ALLOC_CENSUS_CALLS=<substr,…>` (per-caller→callee call counters),
plus a stderr shape/size report per counted type.

> Implementation note (WHY, for the next census user): per-caller matching
> MUST resolve callees through `ctx.funcMap`, not by position in
> `ctx.mod.functions` + `numImportFuncs`. Bodies carry mint-time HANDLES that
> the emitter resolves through the layout seam at encode time;
> `ctx.numImportFuncs` is additionally stale after dead-import elimination
> (reads 4 on a 0-import standalone module). Positional matching found 0 of
> 261k measured calls; funcMap matching found all of them.

Measured on main @ 431ea77d5, standalone-dynamic lane, optimize 4 (counts
identical at optimize 0 — the census installs pre-wasm-opt), checksum 422×3
intact, **614,820 allocations/parse** (drift from #3927's 607,469 is
main-advance). Top 10 by count, with per-function and per-caller attribution:

| count/parse | share | type (shape, est. bytes) | attributed to |
| ---: | ---: | --- | --- |
| 283,370 | 46.1% | `$AnyValue` (5 fields, ~32 B, transient) | `__any_from_extern` 261,362 — **100.0% called by `__extern_strict_eq`** (the #4173 stream); `__any_from_extern_honest` 20,454 (typed-this closures 18.7k + `__ir_dyn_string_replace` 1.7k); `__any_box_f64` 1,554 |
| 57,973 | 9.4% | `$AnyString` header (3 fields, ~20 B) | `__str_substring` 30,449 (header-only view — no char copy), `__str_concat` 19,786, `__str_slice` 3,683, rest string runtime |
| 41,811 | 6.8% | `$ObjVecArr` (externref array, cap 8 → ~40 B) | ALL in `__objvec_new`; callers: `__closure_method_call` 20,849 + `__call_m_call_2` 20,680 |
| 41,811 | 6.8% | `$ObjVec` header (2 fields, ~16 B) | same — **two dead arg-vec pairs per dynamic closure `.call`** |
| 33,761 | 5.5% | `__anon_14` (i32 array) | `__regexp_test_carrier` 29,117 (per-`.test` captures scratch), typed-this closure 4,291 |
| 32,468 | 5.3% | `__fnctor_Node` (69 fields, 292 B, retained) | `__fnctor_Node_new` — the AST; demoted per #3927 §6 |
| 31,415 | 5.1% | `__vec_externref` header (~16 B) | closure_550 17,091, `__call_fn_method_1` 5,160, `__fnctor_Scope_new` 4,125, `__vec_push` growth 2,970 |
| 27,668 | 4.5% | `__str_data` (i16 array) | `__str_concat` 19,786 (real char copies), `__str_slice` 3,683, rest |
| 27,361 | 4.5% | `__arr_externref` (backing arrays) | same producers as the vec headers |
| 18,722 | 3.0% | `type_187` (2×i32+ref, ~20 B) | `__regex_run` — per-run engine state |

Tail: `$DestructuringErrors` 7,252 (acorn's own per-`parseMaybeAssign`
allocation — real program behavior), `$BoxedNumber` 3,862, `$ConsString`
3,726, `$Scope` 1,375+4,125 vecs, object-runtime `$PropEntry`/`$PropMap`
~1,900.

**Reading of the table:**

- The #1 stream (46%) is `__extern_strict_eq`'s operand boxing — **already
  killed by in-flight #4173** (`JS2WASM_FAST_STRICT_EQ`, default ON, branch
  `claude/issue-4173-boxed-strict-eq`). Not duplicated here.
- The #1 **post-#4173 elidable** stream is the `$ObjVec` pair: 83.6k heap
  objects (~2.3 MB) per parse, all dispatch plumbing for ~20.7k dynamic
  `fn.call(this, x)` invocations (acorn's `update.call(this, prevType)` in
  `updateContext`, per context-sensitive token), unpacked immediately by
  `__apply_closure` and dead. Two pairs per call: `__call_m_call_2` packs all
  args, `__closure_method_call`'s %Function.prototype.call% route re-packs
  args minus thisArg.
- `$AnyString` substring headers and `__str_data` concat copies are the string
  VALUES themselves (not plumbing); `__fnctor_Node` is the retained AST
  (#3927 demotion stands); the regexp streams (48k) are engine-internal
  scratch — priced below, not taken in this slice.

## Mandate 2/3 — the kill: closure-receiver fast `.call` arm

`src/codegen/closure-call-fast.ts` + a one-call hook in
`fillClosedMethodDispatch` (`closed-method-dispatch.ts`, +6 lines — hence the
loc/func-budget allowances: the fill was exactly at both caps, and the
arm-chain hook cannot live outside the arm-chain builder; the arm body itself
is in the new file). Outermost arm in `__call_m_call_<K>` (K ≥ 1):

1. receiver `ref.test` funcref-wrapper root (closures are
   representation-disjoint from every other arm's receiver);
2. own-prop `call` override guard via `__extern_get` + `__nullish_to_null` —
   the same §10.2 [[Get]] precedence check `__closure_method_call` route 1
   performs (an override falls through to the legacy chain and still wins);
3. under-application gate: declared `$arity ≤ K−1`, because
   `__call_fn_method_N` carries only closures with formals ≤ N and the
   missing-arg padding lives in `__apply_closure`'s #3592 widening (silent
   vacuous-undefined hazard otherwise — the 9th-dogfood-wall class);
4. then direct `__call_fn_method_(K−1)(thisArg, fn, a…)` with argc
   preset/reset — byte-for-byte the #3673 round-13 cached-direct-call idiom.

Zero allocations on the fast path (WAT-verified: no `objvec_new`; legacy chain
intact in the else-arm). Flag `JS2WASM_FAST_CLOSURE_CALL`, `=0` restores the
legacy-only dispatcher. Vararg `.call(...xs)`, `.apply`, arity-0 `.call()`,
non-closure receivers: unchanged legacy path.

## Results — 2026-08-06

### Census A/B (deterministic; the primary evidence)

Standalone-dynamic acorn, checksum 422×3 intact both sides:

| | flag OFF (legacy) | flag ON | delta |
| --- | ---: | ---: | ---: |
| total allocations/parse | 614,820 | **531,424** | **−83,396 (−13.6%)** |
| `$ObjVec` pairs/parse | 41,811 + 41,811 | 113 + 113 | **−99.7%** |
| every other stream | — | unchanged (e.g. `$AnyValue` 283,370 both sides) | isolation clean |

Binary 1,479,679 → 1,479,820 B (+141 B).

### Profile bucket A/B (300 parses each, order-reversed pairs)

| bucket | pair 1 ON→OFF | pair 2 OFF→ON (control) |
| --- | --- | --- |
| call-dispatch | 8.53 / 11.06 (**−2.5pp**) | 9.34 / 10.82 (**−1.5pp**) |
| gc-engine | 21.83 / 17.56 (contaminated — see below) | 17.10 / 17.82 (−0.7pp) |

`__extern_method_call`'s 1.89% self-time frame is GONE from both ON profiles
(the ladder truly dies). Call-dispatch −2.0pp mean, consistent in BOTH orders
— the trustworthy profile finding. **The pair-1 gc reading (21.83% ON) is a
§3927-§6-class contamination artifact**: mechanism-inconsistent (removing 83k
allocs cannot raise GC share 4pp), and the order-reversal control read
17.10 ON vs 17.82 OFF. Recorded because it would have flipped the verdict if
the control hadn't been run — the §6 lesson held again, in the other
direction.

### Wall A/B (back-to-back pairs, both orders; shared box, other lanes active)

| pair | order | ON wasmUs | OFF wasmUs | within-pair |
| --- | --- | ---: | ---: | ---: |
| 1 (under profiler) | ON→OFF | 161,386 | 163,019 | −1.0% |
| 2 (under profiler) | OFF→ON | 155,264 | 168,159 | −7.7% |
| 3 (plain) | ON→OFF | 164,346 | 176,672 | −7.0% |
| 4 (plain) | OFF→ON | 167,238 | 171,208 | −2.3% |

4/4 pairs favor ON, both orders represented; pooled mean 162,059 vs 169,765
(**−4.5%**). Each individual pair is below this box's ~10% resolvability bar
(§6); the claim rests on 4/4 order-balanced consistency + the deterministic
census + the both-orders call-dispatch drop, not on any single wall number.

### Flag decision

`JS2WASM_FAST_CLOSURE_CALL` ships **default ON**: allocation kill is
deterministic and isolated, the dispatch-ladder removal is profile-verified in
both orders, wall is 4/4 positive, and every guard that could change
semantics routes back to the byte-equivalent legacy chain (`=0` restores the
legacy-only dispatcher).

### Semantics findings

- Own-`call` override via **dynamic** member write is honored on both paths
  (1005 — the §10.2 guard works; pinned).
- Own-`call` override via **static** assignment (`real.call = …` at top
  level) is ignored by BOTH paths (answers 6; Node answers 1005) — a
  **pre-existing gap**, not an arm regression: the static assignment never
  reaches the closure side bag that `__extern_get` reads. Pinned as parity so
  a future side-bag fix updates both paths together.

### What was priced and NOT taken (for the next #4157 slice)

Post-#4173+#4185, the remaining allocation streams by count: `$AnyString`
substring/concat headers 58k (the string VALUES — not plumbing, not elidable),
`__regexp_test_carrier` captures scratch 29k + `__regex_run` state 18.7k
(engine-internal; a test-only scratch-captures reuse is plausible but touches
the regex engine — priced M, not taken here), `__vec_externref` closure arg
vecs ~25k spread across `__closure_550`/`__call_fn_method_1`/`Scope_new`
(spread wide, no single chokepoint), `__fnctor_Node` 32.5k retained (#3927
demotion stands), `$AnyValue` residual ~22k (honest-boxing via typed-this
reads — #3685/#743 territory).

### Gates (all by exit code, 0 unless noted)

tsc 0 · biome lint 0 · oracle-ratchet 0 · loc-budget 0 (granted:
closed-method-dispatch.ts +6) · func-budget 0 (granted:
`fillClosedMethodDispatch` +5 — the fill was exactly at cap; the arm body
lives in the new file) · dead-exports 0 · coercion-sites 0 · stack-balance 0
· check:ir-fallbacks 0 · prettier 0. Suites: issue-4185 7/7, #3673
closure-call/apply + #4096 21/21, #4155 Phase 0+2+provenance 25/25, #2660
fnctor 54/54. Dogfood canaries 2/3/4/5, `functionImports: []`, exactly the 3
pre-existing IR-FALLBACKs (typeIdx parity on parse/parseExpressionAt/
tokenizer).

## Acceptance criteria

- [x] Top-10 attribution table with counts × size × producer × caller (above)
- [x] Mechanism WAT-verified before measurement
- [x] Census A/B: `$ObjVec` allocations collapse (−99.7%, isolation clean)
- [x] Profile bucket + wall A/B with order-reversal controls (#3927 §6 rules)
- [x] Semantics pinned: this-binding, under/over-application, own-prop
      override (dynamic honored; static = pre-existing gap pinned as parity),
      flag-off parity
- [x] Dogfood canaries 2/3/4/5, `functionImports: []`, 3 pre-existing
      IR-FALLBACKs unchanged

## 2026-08-07 — the regexp scratch streams (second slice off this ledger)

Takes the two streams the section above priced and left ("engine-internal;
… priced M, not taken here"). **Shipped default ON, but the honest headline is
small: the runtime effect is ~0.4 pp of parse self-time, not the 18 % the
allocation-count number suggests.** Read the "count is the wrong denominator"
subsection before picking the next lever off this ledger — it is the part of
this run most likely to change what someone does next.

### Baseline first — the ledger has moved a lot

Re-censused on `origin/main` @ `fa3d1c07e`, standalone-dynamic acorn,
checksum 422×3 intact: **262,711 allocations per parse**, down from the
614,820 recorded above (#4173 + #4185 both landed). The two regexp streams are
therefore a much larger SHARE of what is left than the earlier table implied:

| count/parse | share of remainder | site (per-function census) |
| ---: | ---: | --- |
| 29,117 | 11.1 % | `__regexp_test_carrier` — per-`.test` capture-slot array |
| 18,722 |  7.1 % | `__regex_run` — one `$__ReFrame` per SPLIT (backtrack) push |
| **47,839** | **18.2 %** | combined |

Also worth recording, because it retires a line from the earlier table:
`__regex_run`'s per-push capture SNAPSHOT allocates **zero** times in the acorn
parse. Every pattern acorn puts through the VM has `nSlots <= 2`, so #3673
round 23's shared zero-length dummy already covers it. The 33.7 k `__anon_14`
i32 arrays were the `.test` scratch plus ~4.6 k from other closures, not
snapshots.

### The change

`src/codegen/regex-scratch-pool.ts` (new, self-contained), plus a 4-line edit
in `emitRegExpTestFromLocals` (`regexp-standalone.ts`, hence the
`loc-budget-allow` above: +2 net on a grandfathered god-file) and a `splitArm()`
body swap in `ensureRegexRun` (`native-regex.ts`, which SHRINKS — the
already-1,107-line function got smaller, so no func-budget grant was needed).

- **`.test` capture scratch** → a module-global pool, `JS2WASM_REGEXP_TEST_CAPS_POOL`.
  Checkout-null on acquire, check-in after the last read, take the pooled array
  only when `array.len >= nSlots` (so the pool converges upward to the largest
  slot count the program ever needs and then stops allocating).
- **Backtrack frames** → recycled in place, `JS2WASM_REGEXP_FRAME_REUSE`. A stack
  slot at or above `top` is dead by definition, and #3673 round 22's stack pool
  already carries the array across runs, so after warm-up every push finds a
  frame to overwrite.

Both `=0` restore the previous instruction sequence exactly (pinned by a
byte-identity assertion in the test).

**Why checkout-null rather than a plain shared global.** A shared global would
be correct only as long as nothing re-enters `.test` while the scratch is live —
true today, but true by AUDIT of the call graph, which is not a property that
survives the next feature. Checkout-null makes it safe by construction: a
re-entrant caller finds an empty pool and allocates fresh, and a trap between
checkout and check-in (the #2091 step-cap `RangeError`) just leaves the pool
empty. Same idiom, same reasoning, as round 22.

**Not pooled, deliberately.** `.exec`, `match`/`matchAll`/`replace`/`split` and
the `Symbol.*` protocol entries keep their per-call allocation: they publish
capture VALUES into a result object and some of them call user code while the
array is live. The one pooled entry point is the one whose result is a boolean.
`lastIndex` is untouched — it lives on the RegExp struct, and `__regex_search`
re-fills the slots it uses (`array.fill(caps, 0, -1, nSlots)`) before every
attempt, so a pooled array arrives indistinguishable from a fresh one.

### Results

**Census (primary, deterministic).** Standalone-dynamic acorn, checksum 422×3
intact both sides, counts identical at 1 and 3 iterations:

| | OFF | ON | delta |
| --- | ---: | ---: | ---: |
| total allocations/parse | 262,711 | **214,873** | **−47,838 (−18.2 %)** |
| `__anon_14` (regex i32 arrays) | 33,727 | 4,611 | −29,116 (−86 %) |
| `$__ReFrame` | 18,722 | **0** | −100 % |
| every other counter | — | byte-identical | isolation clean |

Binary 1,544,308 → 1,544,411 B (**+103 B**).

**Profile buckets (secondary), 300 parses per run, three order-balanced pairs:**

| pair | order | gc-engine ON | gc-engine OFF | Δ | regexp ON | regexp OFF | Δ |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | ON→OFF | 22.71 | 23.31 | −0.60 | 6.84 | 7.18 | −0.34 |
| 2 | OFF→ON | 23.10 | 23.49 | −0.39 | 6.90 | 7.26 | −0.36 |
| 3 | ON→OFF | 22.95 | 23.29 | −0.34 | 7.58 | 7.41 | **+0.17** |

gc-engine favours ON **3/3, both orders, mean −0.44 pp** — that is the
trustworthy finding. The `regexp` bucket is 2/3 and reverses in pair 3; it is
inside the noise and no claim is made on it.

**Wall: UNRESOLVABLE today, and stated as such.** Four order-balanced pairs
gave 3/4 for ON (−4.1 %, −3.1 %, −5.3 %, **+5.4 %**), pooled mean −1.9 % — far
under this box's ~10 % bar (#3927 §6). The direct evidence that the box could
not resolve it: the NODE median in the same eight runs, running identical code
throughout, ranged 13,141–19,807 µs — a **51 % spread**. The noise floor was
larger than any effect. No wall claim is made, and none is needed.

### Count is the wrong denominator — the finding that should steer the next slice

An 18.2 % cut in allocation COUNT bought ~0.4 pp of parse time. That is not a
disappointment, it is arithmetic, and the ledger above invites the mistake:

| stream | count/parse | ~bytes each | ~bytes/parse |
| --- | ---: | ---: | ---: |
| `__fnctor_Node` (retained AST) | 32,468 | 292 B | **9.5 MB** |
| `type_7` `$AnyString` headers | 54,623 | 20 B | 1.1 MB |
| `type_75` `$AnyValue` residual | 22,008 | 32 B | 0.70 MB |
| **`.test` caps (this slice)** | 29,117 | ~16 B | **0.47 MB** |
| **`$__ReFrame` (this slice)** | 18,722 | 20 B | **0.37 MB** |

The two streams taken here are the SMALLEST objects in the census. They are
18.2 % of allocation events and roughly **2–3 % of allocated bytes**. Whoever
picks the next lever off this ledger should rank by **count × instance size**,
not by count: on that ranking `__fnctor_Node` alone outweighs every remaining
elidable stream combined, and the `$AnyString`/`$AnyValue` boxing streams
(Workstream 1 / #743 / #4155 territory) outweigh anything left in the plumbing.

### Semantics finding — a PRE-EXISTING sticky `.test` bug, not from this change

While building the parity fixture: on the erased-receiver path
(`__regexp_test_carrier`), a **sticky (`/y`) `.test` does not anchor** — it
scans forward from `lastIndex` like a global regexp.

```js
const sticky = /ab/y;
sticky.lastIndex = 4;
carrierTest(sticky, "zzabzzab"); // Node: false, lastIndex → 0
                                 // standalone: true,  lastIndex → 8
```

Confirmed **pre-existing on `origin/main`** by re-running the probe against
pristine `HEAD` files (identical wrong answer), and identical with both new
flags off. The static expression path is unaffected. Not fixed here — out of
scope for an allocation slice, and fixing it inside a perf PR would make the
perf A/B unreadable. Flagged to the tech lead; the fixture in
`tests/issue-4185-regex-scratch-reuse.test.ts` deliberately exercises a sticky
HIT (which is correct) and avoids encoding the wrong answer as expected.

Separately, `tests/issue-2175-regexp-proto-readers.test.ts` has **3 failures on
pristine `origin/main`** (the `.flags` / `.source` / boolean-getter dispatch
tests). Also pre-existing, also verified by baseline swap before attributing.

### Flag decision

Both flags ship **default ON**. The mechanism is deterministic and provably
identity-free, the isolation is clean to the counter, the target bucket moves
the right way in 3/3 order-balanced profile pairs, and `=0` restores the prior
bytes. The effect is small and the wall cannot see it — that is stated first,
not buried, and it is the reason this section leads with the size of the win
rather than with the −18.2 %.

### Priced and NOT taken (updated)

- The `.test` **expression** fast path (`emitRegexSearchCall`) still allocates
  its caps per call — 4,611/parse, 1.8 %. Same pooling argument applies, but the
  emitter is shared with `.exec`, so it needs a method discriminator first.
  Small; not worth the shared-emitter risk on its own.
- `__regex_run`'s per-push capture snapshot: **zero in this corpus** (see
  above). Nothing to take.
- Everything else remaining is either a retained value (`__fnctor_Node`) or
  boxing (`$AnyString`, `$AnyValue`) — see the bytes table.

### Gates (all by exit code)

tsc 0 · biome lint 0 · prettier 0 · oracle-ratchet 0 · loc-budget 0 (granted:
`regexp-standalone.ts` +2) · func-budget 0 (`ensureRegexRun` shrank) ·
dead-exports 0 · coercion-sites 0 · stack-balance 0 · check:ir-fallbacks 0.
Suites: new issue-4185 scratch-reuse 3/3; 13 regexp/standalone-regexp files
405 passed / 17 skipped; equivalence shards 1, 4, 7 of 8 — no new regressions
(CI runs all eight). Dogfood: `acorn-harness` 7/7 fixtures equal, 0 divergent;
standalone canaries **2 / 3 / 4 / 5**, `functionImports: []`, exactly the 3
pre-existing IR-FALLBACKs (typeIdx parity on parse / parseExpressionAt /
tokenizer).
