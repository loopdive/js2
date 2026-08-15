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
  # (#4157 call-dispatch devirtualization, JS2WASM_CALL_DISPATCH_IC) +13 lines
  # of WIRING: one import plus one guarded pass invocation per compile
  # pipeline, immediately after inlineExternGetCallSites. The pass itself is a
  # new subsystem module (src/codegen/call-dispatch-ic.ts).
  - src/codegen/index.ts
  # (#4157 write-side member IC, JS2WASM_SET_MEMBER_IC) +12 lines in the
  # driver: one import plus one pass invocation per compile pipeline
  # (generateModule + generateMultiModule), immediately after
  # inlineExternGetCallSites. The pass itself is a new subsystem module
  # (src/codegen/member-set-inline-ic.ts); there is no smaller way to WIRE a
  # finalize pass than to call it from the finalize sequence.
  # (#4157 flat-str IC, JS2WASM_FLAT_STR_IC) +3 lines: one import plus a
  # one-line pass invocation per compile pipeline. Extraction, both site
  # rewrites and every correctness argument live in the new subsystem module
  # src/codegen/flat-str-ic.ts; there is no smaller way to wire a finalize
  # pass than to call it from the finalize sequence.
  # (#4157 unboxed boolean fusion) +3 lines of WIRING in the driver: one
  # import and two one-line finalize invocations of fuseBoxBooleanSinks.
  # The pass itself is a new subsystem module (src/codegen/box-boolean-fuse.ts).
  # (#4157 non-null guard elision) +43 / +11 lines of WIRING. The analysis and
  # both emission shapes live in a new subsystem module
  # (src/codegen/nonnull-proof.ts); what remains in these two files is
  # irreducible for this kind of change: an optional proof parameter on the two
  # exported guard emitters (`emitNullCheckThrow`, `emitNullGuardedStructGet`),
  # the receiver ValType threaded to their call sites, and — the bulk of it —
  # restructuring the fast path's `if (ref.is_null) throw else <read>` so the
  # else-arm can be emitted alone when the guard is dead. That restructure
  # cannot move to the module, because the read instructions it guards are built
  # from this file's presence-slot and struct-field state.
  - src/codegen/property-access.ts
  - src/codegen/property-access-dispatch.ts
  # (#4157 ToNumber fast paths, JS2WASM_FUSED_TONUMBER / JS2WASM_SMI_FASTPATH)
  # +5 lines: one import plus a 4-line early-out at the ONE standalone
  # externref->f64 coercion site. Both fast paths live in a new subsystem module
  # (src/codegen/tonumber-fast-paths.ts); this is the whole of their footprint
  # in the god-file, and there is no smaller way to route a coercion site to an
  # alternative lowering than to test for it where the site is.
  - src/codegen/type-coercion.ts
  # (#4157 lazy string flattening, JS2WASM_LAZY_STR_FLATTEN) wiring only: the
  # analysis and both emission shapes live in a new leaf module
  # (src/codegen/lazy-str-flatten.ts). What remains here is the guarded preamble
  # relocation in __str_equals and the key-flatten removal in __extern_get, both
  # of which must sit where the helper body is built.
  - src/codegen/object-runtime.ts
  - src/codegen/string-ops.ts
  # (#4157 caller-side flatten elision) +1 line: the import of
  # `redundantFlattenCall`. The four call sites it replaces are net-zero
  # (`{ op: "call", ... }` -> `...redundantFlattenCall(...)`, one line each) and
  # the whole rationale lives in the leaf module `lazy-str-flatten.ts`. One
  # import line is the irreducible cost of routing a site to a subsystem module,
  # which is the direction #3102 asks for.
  - src/codegen/binary-ops-typed-dispatch.ts
  # (#4157 A, JS2WASM_SET_MEMBER_F64) +8 lines: one import plus a two-line
  # "typed twin first" early-out at each of the TWO dynamic member-write sites
  # (`compilePropertyAssignmentExternSet`, `tryEmitPinnedStructMemberSet`). The
  # dispatcher, its reserve/fill and every correctness argument live in a new
  # leaf module (src/codegen/member-set-f64.ts). The site cost is irreducible:
  # the decision needs the value's ValType, which exists only where the value
  # has just been compiled onto the stack.
  - src/codegen/expressions/assignment.ts
  # (#4157 B, JS2WASM_RECEIVER_CSE) +4 lines: one import, a two-line cache-hit
  # early-out, and one line recording the resolved receiver. The cache, the
  # dominance argument and the relocation guard live in a new leaf module
  # (src/codegen/receiver-cse.ts); what stays here is the `this` lowering they
  # bracket, which cannot move.
  - src/codegen/expressions.ts
func-budget-allow:
  # Same +8 lines, seen per-function: the two finalize sequences.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  # (#4157 inline cache, entry 14) +5 lines: the arm's ~119 lines of emission
  # were EXTRACTED to `buildMemberGetInlineCacheArm` per this gate's own advice
  # (504 -> 390 of a 385 budget). What remains is the call plus its two-field
  # options object and the two spread sites that consume the result. Squeezing
  # the last 5 would mean inlining the options object back into a positional
  # argument list, which is worse code for a budget number.
  - src/codegen/member-get-dispatch.ts::fillMemberGetDispatch
  # (#4157 ToNumber fast paths) +4 lines in `coerceType`'s externref->f64 arm.
  # Splitting a 1,454-line function that is one long from/to type-pair ladder is
  # a real refactor with its own byte-identity risk, and it would not shrink THIS
  # change: the early-out has to sit in whichever function owns the pair.
  - src/codegen/type-coercion.ts::coerceType
  # (#4157 lazy string flattening) same wiring, seen per-function.
  - src/codegen/native-strings-basics.ts::emitStrCompareHelpers
  - src/codegen/object-runtime.ts::fillClosedStructExternGetArms
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
  # (#4157 B receiver CSE) +3 lines seen per-function. `compileExpressionInner` is
  # the AST-kind switch; a `this` operand is one of its cases and the CSE has to
  # bracket exactly that case's emission.
  - src/codegen/expressions.ts::compileExpressionInner
oracle-ratchet-allow:
  # (#4157 non-null guard elision, JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR) The
  # +5 net counted sites all feed the PRE-EXISTING main helper
  # `isProvablyNonNull(expr, checker?)` (property-access.ts:1074), whose
  # signature takes the raw `ts.TypeChecker` — the new code adds CALLERS of
  # that helper at the guard-elision sites, it does not introduce new raw type
  # queries. Routing through ctx.oracle would mean migrating the helper itself,
  # a separate refactor out of scope for a flags-off byte-identical PR.
  - src/codegen/property-access.ts
  - src/codegen/property-access-dispatch.ts
  # nonnull-proof.ts's single counted hit is a DOC COMMENT ("`isProvablyNonNull
  # (expr, ctx.checker)` — passed in to avoid an import cycle", line ~136) —
  # the module deliberately takes the proof callback injected and holds no
  # checker reference of its own.
  - src/codegen/nonnull-proof.ts
coercion-sites-allow:
  # (#4157 inline truthy IC, JS2WASM_INLINE_TRUTHY_IC) The pass's whole job is
  # to rewrite `call $__is_truthy` sites into a guarded speculation whose
  # slow arm is copied verbatim OUT of the emitted `__is_truthy` helper body —
  # it must name the helper to find its call sites and read its arms. It adds
  # no new coercion MATRIX; it relocates the engine's own emission.
  - src/codegen/is-truthy-inline-ic.ts
  # (#4157 fused ToNumber, JS2WASM_FUSED_TONUMBER) Replaces the exact pair
  # `__unbox_number(__to_primitive(x))` with one `__to_number` — it has to name
  # the two helpers it fuses to match and replace them. The fused helper is
  # emitted from the same engine vocabulary, not a fresh hand-rolled matrix.
  - src/codegen/tonumber-fast-paths.ts
  # (#4157 unboxed boolean fusion, JS2WASM_UNBOXED_BOOL_FUSE) Same shape as the
  # inline truthy IC above: the pass MATCHES `call $__is_truthy` sinks that
  # consume a `__box_boolean` merge and DELETES them, rewriting the merge tree
  # to `(result i32)`. Both references are pattern-matching only — one funcMap
  # lookup to find the sites, one skip guard so the helper bodies themselves are
  # never rewritten. It removes coercion calls; it adds no coercion matrix.
  - src/codegen/box-boolean-fuse.ts
  # (#4157 park-6 fix) The cross-hierarchy operand repair does NOT author any
  # coercion: it calls `callArgCoercionInstrs` — the SHARED engine helper in
  # stack-balance.ts — and the two `findFunc` lookups exist only to hand that
  # helper the `__box_number` / `__unbox_number` indices it takes as
  # parameters. The gate counts the literal helper names; here they are an
  # index lookup, not a hand-rolled ToNumber matrix. The pass repairs only
  # externref ⇄ concrete-GC-ref operands, whose hierarchies are disjoint.
  - src/codegen/cross-hierarchy-operands.ts
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

## 2026-08-12 (4) — second null on the same helper: instruction-shaving `__extern_get` is exhausted

A second, independent attempt at `__extern_get`, aimed at the **hit** path this
time (the previous one only ever reached the 12.76 % that miss).

Two of the ~40 instructions on the hit path are `ref.cast`s that exist **only**
to make an `anyref` cache field acceptable to `ref.eq` — nothing downstream
reads a field off either result. Replacing them with the abstract
`ref.cast_null (ref null eq)` is strictly safe in the direction that matters:
`ref.eq` is identity, so a value that is not the owner cannot compare equal, and
a mismatch that used to trap simply misses the cache and takes the slow path.
The build is **14 bytes smaller** and checksum 422 holds.

Order-reversed **ON → OFF → OFF → ON**:

| block | order | `__extern_get` self | dynamic-lookup |
| --- | --- | ---: | ---: |
| onA | 1 | 9.24 % | 20.96 % |
| offA | 2 | 9.23 % | 21.50 % |
| offB | 3 | 8.85 % | 20.52 % |
| onB | 4 | 9.75 % | 20.76 % |

Mean 9.50 % ON vs 9.04 % OFF — trending the *wrong* way, with the ON blocks
scattering 0.51 pp and the OFF blocks 0.38 pp. This run was noisier than the
morning's (whose ON blocks replicated to 0.11 pp), so the honest bound here is
about **±0.5 pp**: null. Reverted, for the same reason as the screen — no
measured benefit, and the concrete cast at least documents the invariant that
the cached owner really is a `$Object`.

### What two nulls in a row establish

The first attempt removed 14,770 instructions of provably-dead ladder from the
miss path. The second removed two RTT checks from the hit path. Neither moved
the bucket. Taken together they say the same thing:

**`__extern_get`'s 9 % is not made of instructions that can be removed from
inside it.** At 21.7 ns / ~45 cycles per call it is already tight; what is left
is call overhead, the pointer-chase through the props array, and branch
behaviour — none of which shrinks by editing the body. Micro-optimisation of
this helper is **exhausted at this box's ±0.3–0.5 pp resolution**, and future
lanes should not spend another A/B cycle on it.

That does **not** retire the bucket — it retires one approach to it. Dynamic
lookup is still ~25 ms/parse and the largest addressable line in the gap. The
lever is the one already named above: **remove the CALL**, via site- or
name-local inline caching, which is a structural change to how reads are emitted
rather than an edit to the helper. It remains unbuilt, and it is now the only
priced candidate in this issue above the measurement floor.

Both reverted experiments are described here in enough detail to rebuild without
rediscovering them; neither is in the tree.

## 2026-08-12 (5) — call dispatch (11.39 %) opened for the first time, and it has ONE root cause worth fixing

Nothing in this umbrella had ever looked inside the second-largest helper bucket.
Doing so found a single defect that explains three separate things, and it is a
**correctness** bug with a performance unlock behind it — not a speculative
optimisation.

### The bucket

| frame family | self % | what it is |
| --- | ---: | --- |
| `__call_fn_method_{0,1,7}` | 3.37 % | generic closure-call trampolines by arity |
| `__dc_Parser_<method>_<arity>[_g]` | **≈ 4.09 %** | #3683 S3 devirtualised direct-call trampolines |
| `__call_m_<name>_<arity>` | ≈ 1.6 % | method-call dispatchers |
| `__builtinfn_get_meta` | 0.54 % | builtin-fn metadata |
| `__named_this_call_*` | 0.54 % | named-`this` call bridge |

**Self time in a trampoline is pure overhead** — a trampoline exists to adapt a
call, so every cycle in it is a cycle not spent on the callee's work. The
`__dc_*` family alone is ~4 % of total runtime, spread across ~25 tiny functions.

### The root cause

`typed-this.ts`'s ABI note (the "why the RECEIVER parameter is `externref`, not
`(ref $__fnctor_F)`" block) documents exactly why that overhead exists. The
natural signature — receiver already in a typed register at every call site —
**cannot be used** because of a latent imprecision in `applyRefNullFixups`
(`src/codegen/fixups.ts`, the backward walk near the end): from a `call`, it
walks backwards mapping **one instruction per parameter**, special-casing only
`local.tee`, `struct.new`, `array.new_fixed` and nested `call`. Any argument
produced by a sequence it does not special-case desynchronises the walk and
lands a `ref.null.extern` rewrite on the wrong parameter.

So `__dc_*` pays, per the note, "one `extern.convert_any` per call site and one
`any.convert_extern; ref.cast` per trampoline" purely to keep its signature
outside the hazard. The note calls that cost "trivial against the bridge being
removed" — **which was right about the bridge and wrong about the cost**: the
profile now puts the family at ~4 %.

### The census defect is NOT diagnosed — an earlier draft of this entry got it wrong

A first pass at this write-up asserted that the broken `JS2WASM_ALLOC_CENSUS_CALLS`
recorded in entry (3) is the **same** walk. That claim does not survive checking
and is withdrawn:

- The walk's only mutation is `ref.null.extern` → `ref.null <typeIdx>`. It cannot
  produce the observed error, `call[1] expected type f64, found local.get of type
  i32` — that says an **i32 local** sits at a parameter expecting **f64**, which
  is an argument-position shift, not a retyped null.
- The census splice itself is stack-neutral by inspection: `incrementInstrs` is
  `global.get` / `i32.const 1` / `i32.add` / `global.set` (net 0), inserted
  immediately before the `call`, i.e. after every argument is already on the
  stack. That alone should not desynchronise anything.

So the census defect stands as an **undiagnosed** bug (entry 3), not as evidence
for this one. Recording the disproof because the wrong version is the more
attractive story — one root cause explaining two symptoms — and the next lane
should not inherit it.

The `__dc_*` finding below does **not** depend on it. That one rests on quoted
source, not inference: `typed-this.ts`'s ABI note states the constraint and names
the fixup itself.

### Why the fix is tractable

`fixups.ts` **already contains a real stack model**: `instrPopsPushes(instr, mod)`
(same file, ~line 842) returns exact `{pops, pushes}` for locals, struct/array
producers, `call` / `call_ref` / `call_indirect` and structured blocks, and
**returns `null` — refuse to model — for anything unrecognised**. The backward
walk simply does not use it. Rewriting the walk to accumulate stack effect via
`instrPopsPushes`, and to leave the fixup unapplied whenever it answers `null`,
replaces the "one instruction per argument" approximation with the operand-count
model the ABI note says is missing, and keeps the conservative behaviour on
anything it cannot model.

The note declined this on the grounds that a shared fixup "would need a real
operand-count model (and whose current approximations other lowerings may depend
on)". Half of that objection is now answered — the model exists. The other half
is real and is what makes this a change needing broad test coverage rather than a
quick edit: it must be validated against every lowering that reaches the fixup,
which this container cannot do (the full equivalence suite OOMs here).

**This is the recommended next slice, ahead of the inline-cache one named in
entry (2).** It is smaller, it is a correctness fix rather than an optimisation,
and the typed-receiver ABI it enables is worth a cast per call on ~4 % of
runtime. Its acceptance test is a `__dc_*` trampoline reserved with a
`(ref $__fnctor_F)` receiver that validates — the case the ABI note says fails
today with `call[1] expected type externref`.

## 2026-08-12 (6) — CORRECTION to entry (5): the fixup walk is not the blocker

Entry (5) above says the `__dc_*` trampolines are stuck on an `externref` ABI
because `applyRefNullFixups` "walks backwards mapping one instruction per
parameter", and prescribes rewriting that walk to use `instrPopsPushes`. **That
prescription is wrong, because the rewrite already exists.** Measured, not
argued.

`src/codegen/fixups.ts` gained an exact FORWARD stack model in **#4077** —
`locateCallArgProducers`, which threads `instrPopsPushes` through the
instruction list and records, per call, exactly which instruction produced each
argument. The hand-rolled backward walk entry (5) describes is only the
**fallback** for calls that model could not reach. The ABI note in
`typed-this.ts` was written for #3683 and predates it.

Instrumenting `locateCallArgProducers` over the standalone acorn build
(env-gated counters, reverted after measuring; checksum 422 held):

| | count |
| --- | ---: |
| calls modelled EXACTLY by the forward model | **48,670** |
| calls falling through to the legacy backward walk | **672** (1.36 %) |
| instruction lists abandoned before the end | 12,266 |

And the reason those lists abandon is not a modelling gap — it is **terminators**:

| break-on op | lists |
| --- | ---: |
| `return` | 5,812 |
| `throw` | 4,316 |
| `br` | 1,445 |
| `return_call` | 664 |
| `unreachable` | 16 |
| `rethrow` | 6 |
| `local.tee` / `local.set` | 6 |
| `br_table` | 1 |

Every op above except the six `local.tee`/`local.set` is a **terminator**, after
which the rest of that flat list is unreachable. Abandoning there is *correct*,
not a defect, and the calls counted as "lost" are overwhelmingly in dead code —
where Wasm validation is polymorphic anyway, so a mis-rewrite is inert.

**Consequences:**

1. **Do not "fix the walk".** It is exercised by 1.36 % of calls, nearly all
   unreachable. Rewriting it is work with no measurable payoff, and entry (5)
   should not be read as scoping that task.
2. **The `__dc_*` typed-receiver ABI may already be unblocked.** The note's own
   worked failure — acorn's
   `this.parseExprOp(this.parseMaybeUnary(null, false, false, forInit), …)`,
   where each `false` is two instructions — is exactly what the forward model
   handles exactly. The cheap experiment is therefore **not** a fixup rewrite: it
   is to reserve a `__dc_*` trampoline with `(ref $__fnctor_F)` as parameter 0,
   drop the `extern.convert_any` at the call site and the
   `any.convert_extern; ref.cast` in the body, and see whether it validates.
   That is a small, self-contained change with an immediate pass/fail answer.
3. The ~4 % self-time figure for the `__dc_*` family in entry (5) stands — that
   was measured from the profile and is unaffected. Only the *diagnosis of what
   blocks it* was wrong.

Recorded rather than silently amended: entry (5) is published in PR #4429, and a
prescription that sends the next lane to rewrite a 4,000-line-file hot path for
1.36 % of calls in dead code is exactly the kind of confident-but-wrong direction
this file exists to prevent.

## 2026-08-12 (7) — the typed-receiver ABI, priced before building: ~0.6 %, below the floor

Entry (6) established that the fixup hazard is gone and the typed-receiver
experiment is cheap. Reading the fill body prices it, and the answer is: **do not
build it.**

### Only UNGUARDED trampolines can take a typed receiver

`fillDirectCallTrampolines` emits, for an unguarded (`this`-receiver, sound by
construction) trampoline:

```
local.get 0 ; any.convert_extern ; ref.cast $F ; local.get 1..n ; <pads> ; call twin
```

The guarded (`_g`) form instead emits `local.get 0 ; any.convert_extern ;
ref.test $F ; if …then cast+call twin …else legacy`. That `ref.test` is the whole
point of the variant: the receiver's shape comes from a whole-program flow
verdict, and the guard turns an imprecision into a missed optimisation instead of
a trap. A typed `(ref $F)` parameter would force the **call site** to produce the
struct — i.e. to cast — which reintroduces exactly the trap the guard exists to
prevent. **`_g` cannot take a typed receiver at all**, and that is a soundness
fact, not a limitation to engineer around.

### The split, from the profile

| | self % |
| --- | ---: |
| unguarded `__dc_*` (typed receiver possible) | **≈ 1.29 %** |
| guarded `__dc_*_g` (must keep externref + `ref.test`) | ≈ 2.80 % |

The change removes `any.convert_extern; ref.cast` from the body and
`extern.convert_any` from the call site. For a low-arity unguarded trampoline
(`__dc_Parser_next_0` is 4 instructions total) that is about **half the body** —
a good ratio, but applied to 1.29 %, so **≈ 0.6 % of runtime**.

### Verdict

0.6 % sits at or below this box's demonstrated resolution (±0.3–0.5 pp; see the
two order-reversed nulls in entries (2) and (4)). Building it means a real
change to the hottest call path in the compiler, touching reserve, both call-site
paths and the fill's legacy-degradation arm, for a result this session has three
times shown it cannot measure at that scale.

**Priced out, not attempted.** If someone later makes unguarded trampolines a
much larger share — e.g. by widening the receiver-flow analysis so fewer sites
need `_g` — re-price it then; the arithmetic above is the template.

## 2026-08-12 (8) — strategic close: helper-level work on acorn is finished

Seven levers were priced in this session. Every one that could be measured
measured null, and every one that could not be measured priced below the floor:

| lever | verdict |
| --- | --- |
| ladder screen for plain-object receivers | measured NULL, ±0.3 pp |
| abstract-`eq` casts on the cache hit path | measured NULL, ±0.5 pp |
| smarter per-key cache (N-way / shape-keyed) | priced out — thrash is 3.77 % |
| rewrite the `applyRefNullFixups` walk | priced out — 1.36 % of calls, dead code |
| typed-receiver `__dc_*` ABI | priced out — ≈ 0.6 %, below floor |
| regex AOT specialization | ≈ 0.7 % of acorn (82 % of patterns are runtime-built) |
| site/name-local inline caching | **≈ 5 %, the only survivor above the floor** |

The allocation program did work — GC 23.1 % → 2.97 %, roughly 9 ms of the 100 ms
gap. But it is spent, and what replaced it at the top of the profile does not
yield to the same technique.

**The measured floor is the point.** The 2026-08-08 cross-runtime table already
said it: Node spends 92.9 % of its parse inside acorn's own code; this build
spends 37.1 % there. Removing **every** helper, GC and regexp millisecond leaves
42.5 ms vs 14.1 ms ≈ **3.0×**. The compiled scanner and parser are 3.1× and 3.5×
slower than the JIT'd equivalents, and that residue is register allocation,
inlining and inline-cache-class work on the emitted code — not helper elision.

So "on par with Node on acorn" is **not reachable by the programme this umbrella
has been running**, and no combination of the levers above closes it. The
remaining honest paths are (a) the ~5 % inline-cache slice, which is worth doing
on its own merits, and (b) a genuinely different programme aimed at the quality
of emitted code for hot compiled functions. (b) is where the 3× lives and nothing
in this issue currently targets it.

## 2026-08-12 (9) — outlining the cold path: net null, but it DECOMPOSES the helper

The entry-(8) survivor is "remove the CALL to `__extern_get`". The expensive way
is emitting a cache check into 1,812 call sites. This tried the cheap way first:
**outline the cold path** so the remaining function is small enough for
`wasm-opt`'s existing inliner to hoist at every site — no call-site emission at
all.

Implementation (reverted): after `unshiftExternGetProtoCacheArm`, split the body
at the cache arm — `__extern_get` keeps the arm and calls a new
`__extern_get_cold` holding everything else, same signature, same locals, plain
`call` so it does not depend on tail calls. Shape-guarded (refuses unless the
first four instructions are exactly the cache arm) and env-gated, so the A/B is a
pure flag flip with no file copies. Checksum 422 held.

Order-reversed **ON → OFF → OFF → ON**:

| block | `__extern_get` | `__extern_get_cold` | sum | dynamic-lookup |
| --- | ---: | ---: | ---: | ---: |
| onA | 6.24 % | 2.13 % | 8.37 % | 15.84 % |
| offA | 8.67 % | — | 8.67 % | 16.59 % |
| offB | 8.74 % | — | 8.74 % | 16.22 % |
| onB | 6.51 % | 2.27 % | 8.78 % | 16.39 % |

**`__extern_get` alone falls 8.71 % → 6.38 %, −2.33 pp, with both ON blocks
cleanly below both OFF blocks** — the first real separation this session
produced. But it is a relocation, not a saving: the 2.2 pp reappears in
`__extern_get_cold`, sum 8.58 % vs 8.71 %, **net −0.13 pp = noise**, and wall
clock trended ~3 % *worse* under ON in both blocks (below resolution, but the
sign is consistent).

**`wasm-opt` did not inline the prologue, and the reason is an error in my own
sizing.** I counted the cache arm as "four instructions" — that is four
*top-level* instructions, one of which is an `if` carrying the entire cache
check. The real prologue is ~45 instructions, far past any sane inlining budget
at 1,812 sites. Function-splitting cannot make this inlinable; only emitting at
the call site can.

### The part worth keeping: the helper now decomposes

The split is a measuring instrument even though it is not an optimisation, and
it answers a question no earlier entry could:

| half of `__extern_get` | self % | share |
| --- | ---: | ---: |
| cache-hit prologue | **6.38 %** | **73 %** |
| entire cold path — field ladder, own-property walk, proto walk | 2.20 % | 27 % |

This confirms entries (1)–(4) from a new direction and sharpens them. The 87.24 %
hit rate is not just most of the *calls*, it is **73 % of the helper's time**;
the 15,032-instruction ladder everyone's eye is drawn to is a quarter of it. It
also explains both earlier nulls exactly: entry (2) optimised the cold path
(27 %) and entry (4) shaved two instructions off a prologue that is ~45.

**Consequence for the named slice.** Call-site inline caching now looks *better*
than entry (2)'s ~5 % estimate, because the target is the 6.38 pp prologue, and
inlining removes both the call and — since the key is a compile-time constant at
a static-name site — the key `ref.test` + `ref.cast` + hash load that the shared
helper must do generically. That is the one thing in this file still worth a
budget window.

Fourth measured null of the session, and the most useful one.

## 2026-08-12 (10) — implementation spec for the surviving lever

Everything needed to build the call-site inline cache is now measured. This is
the spec, so the next window starts at code rather than at re-derivation.

### Target and expected value

The **cache-hit prologue of `__extern_get`, 6.38 % of runtime** (entry 9's
decomposition). Inlining it at a static-name read site removes:

1. the **call** itself (~506 k per parse);
2. the key `ref.test $HashedString` + `ref.cast` — at a static-name site the key
   is a compile-time constant, so its type is known;
3. the hash load / `__obj_hash` fallback — likewise constant-folded;
4. the receiver re-classification (`ref.null; local.set; ref.test $Object;
   …; ref.is_null; i32.eqz`), which collapses to one `ref.test $Object`.

What remains inline is the actual validity check — owner `ref.eq`, props
`ref.eq`, flags test, value read — roughly **10 instructions against a call plus
~45**.

### Insertion point

`fillMemberGetDispatch` in `src/codegen/member-get-dispatch.ts`, as a **new
leading arm of `__get_member_<name>`**, ahead of every existing arm, falling
through unchanged on a miss. Two reasons this beats emitting at each of the 1,812
raw call sites: the dispatcher is **per NAME (~300)** rather than per site, so
size grows ~6× less; and the name is fixed inside it, which is what makes (2)
and (3) above constant-foldable.

**This requires widening dispatcher reservation.** Today `__get_member_<name>`
is only reserved when some closed struct carries the field — which is exactly why
acorn's hottest names (`locations`, `ranges`, `ecmaVersion`, `onToken`) have
none and emit a direct `__extern_get` call instead. Reserve one for any
static-name read, struct candidates or not.

### The sequence (all indices verified against current source)

```
;; key: `nativeStringLiteralInstrs(ctx, propName)` — resolves to a `global.get`
;; of the interned $HashedString (or a materializer call), NOT a fresh string.
;; That shared identity is what makes the existing per-key cache work at all.
local.get 0 ; any.convert_extern ; ref.test $Object
if
  local.get 0 ; any.convert_extern ; ref.cast $Object ; local.tee $o
  <key> ; struct.get $HashedString 4          ;; populated flag
  if
    <key> ; struct.get $HashedString 5        ;; cacheOwner (anyref)
    ref.cast_null (ref null eq) ; local.get $o ; ref.eq
    local.get $o ; struct.get $Object 1       ;; props
    <key> ; struct.get $HashedString 7        ;; cacheProps (anyref)
    ref.cast_null (ref null eq) ; ref.eq
    i32.and
    if
      <key> ; struct.get $HashedString 6      ;; cacheEntry
      ref.cast $PropEntry ; local.tee $e
      struct.get $PropEntry 2                 ;; flags
      i32.const (FLAG_TOMBSTONE | FLAG_ACCESSOR) ; i32.and ; i32.eqz
      if
        local.get $e ; struct.get $PropEntry 1 ; extern.convert_any ; return
      end
    end
  end
end
;; fall through to the existing arms
```

Field indices: `$HashedString` `{0 len, 1 off, 2 data, 3 hash, 4 cacheGen/
populated, 5 cacheOwner, 6 cacheEntry, 7 cacheProps}` (`registry/types.ts`);
`$Object` field 1 = props; `$PropEntry` field 1 = value, field 2 = flags.

**Population stays where it is** — inside `__extern_get`'s own data-property
branch. The inline arm is read-only, so a miss simply falls through and the
existing helper populates for next time. Nothing about cache lifetime changes.

### Traps, each already paid for once

- **Size the prologue by TOTAL instructions, not top-level ones.** Entry (9)
  failed because "four instructions" was four *top-level* ones, one an `if`
  carrying ~45. Budget the arm at its real depth before assuming anything about
  `wasm-opt`.
- **`ref.cast_null (ref null eq)`, not a concrete cast**, on the two `ref.eq`
  operands (typeIdx `-19`; `-19 /* eq */` is an established idiom in
  `vec-overlay.ts`). Sound because `ref.eq` is identity: a non-owner cannot
  compare equal, so a would-be trap becomes a cache miss. Entry (4) measured this
  as null *on its own* — it is bundled here because the arm is new code, not
  because it pays by itself.
- **Do not reorder against the existing arms.** Wrapping rather than reordering
  is what kept #4424's screen sound, and the same argument applies: a miss must
  reach the existing ladder in its current order.
- **Consumer-side narrowing (#1269) is the sharp edge.** #4217's `generator`
  defect came from a candidate-set vote that silently omitted a carrier. A new
  arm that answers some reads earlier must not change which reads the Phase-3
  narrowing sees, or the same class of bug returns — and it presents as one
  wrong field out of 64, not as a crash.

### Acceptance

- `npx tsx tests/dogfood/cold-tail-census.mjs` → `"checksum":422`.
- Per-field differential over all 64 ESTree names, **both** read paths — the
  #4217 lesson is that the defect is invisible to a computed read and uniform in
  a named one. `tests/dogfood/cold-tail-differential.mjs` is committed.
- Order-reversed ON/OFF/OFF/ON on `standalone-dynamic`. **Report the bucket, not
  just the frame** — entry (9) moved 2.33 pp between frames for a net 0.13 pp,
  and only the bucket total exposed that.
- Env-gate it, so the A/B is a flag flip rather than file copies.

Predicted movement: a **fall in `dynamic-lookup` as a whole**, since the hit path
stops being a call. If `__extern_get` drops but the bucket does not, the work was
relocated again, not removed.

## 2026-08-12 (11) — the load-bearing number, verified rather than inherited

Every "this cannot be closed by helper work" conclusion in entries (8)–(10)
rests on ONE inherited number: the 2026-08-08 cross-runtime table's **≈3.0×
floor**. That table's own text flags the weak spot — Node's measurement swung
**14.1 / 18.8 / 21.9 ms** across three runs, and the floor was computed from the
*fastest* of them. Twice this session a written claim turned out to be stale
(the `typed-this.ts` ABI note; my own entry 5), so this one was re-derived from
the raw samples of this session's own lane run rather than quoted.

Nine measured rounds, `standalone-dynamic`, checksum 422:

| | median | spread |
| --- | ---: | --- |
| wasm | **138.3 ms** | 115.7 – 145.8 ms |
| node | **19.9 ms** | 17.7 – 23.4 ms (**28 % of median**) |
| **ratio** | **6.96×** | |

**Two things this settles.**

1. **~7× is right.** 6.96× from this run's own medians, independent of the
   profiler-window arithmetic every earlier entry used. The standing figure was
   not an artifact.
2. **The floor holds, and slightly tighter than claimed.** Today's profile puts
   acorn's own compiled code (`compiled` 21.37 % + `scanner` 18.63 %) at
   **40.0 %** of self time. Deleting every other millisecond — helpers, GC,
   regexp, casts, string runtime, the lot — leaves 55.3 ms against Node's
   19.9 ms: **2.78×**. The inherited 3.0× was honest; the correction is
   downward and does not change the conclusion.

**And it re-derives the measurement floor from first principles.** Node's own
median varies by 28 % run to run and wasm's by 22 %. That is why §6 of #3927
rules wall-clock A/Bs under ~10 % unresolvable on this box, and why every
verdict in this file is bucket share with order-reversal controls rather than a
stopwatch. An A/B claiming a 5 % wall-clock win here would be reading noise
four times its own size.

So the programme's conclusion stands on a number that has now been checked, not
assumed: **parity with Node on acorn is unreachable by helper elision**, because
2.78× of it is the quality of the code emitted for acorn's own scanner and
parser — register allocation, inlining, inline caches — and nothing in this
umbrella targets that.

## 2026-08-12 (12) — the OTHER lane, measured for the first time: JS-host is 342×

Every number in this file is `standalone-dynamic`. The handoff calls that "the
only quotable lane", but the reason given only ever covered `standalone`
(compile-time-static, whose huge ratios are the parse being constant-folded).
**The `js-host` lane had never been measured**, and if acorn were materially
closer to Node there, every conclusion in entries (8)–(11) would be answering
about the wrong lane. So it was run.

| lane | wasm median | node median | ratio |
| --- | ---: | ---: | ---: |
| `standalone-dynamic` | 138.3 ms | 19.9 ms | **6.96×** |
| `js-host` | **5,357.2 ms** | 15.6 ms | **342.6×** |

Checksum 422 on both — the JS-host build is correct, just catastrophically slow.

**Two conclusions, one of them uncomfortable for the architecture doc.**

1. **`standalone-dynamic` is not merely the quotable lane, it is by far the best
   one.** The 6.96× figure is the honest best case, and every verdict in this
   file is about the right target. That question is now closed with a number.
2. **CLAUDE.md describes JS-host mode as using "host imports for
   performance/completeness."** On acorn that is inverted by a factor of **39×**:
   the same workload runs 138 ms pure-Wasm and 5,357 ms through host imports.
   Every dynamic property read that becomes a host call pays a wasm↔JS boundary
   crossing, and acorn does ~506 k of them per parse — the same population entry
   (1) identified. Pure WasmGC is not the fallback for this workload; it is the
   fast path, by a wide margin.

(2) deserves its own issue and is out of this umbrella's scope — the architecture
principle is written as a general rule and this is one workload, dominated by
exactly the operation the boundary punishes most. But "host imports for
performance" should not be read as established for anything read-heavy without
measuring it, and nobody had.

## 2026-08-12 (13) — the spec from §10 was BUILT. It is a regression. Here is why.

Entry (10) specced call-site inline caching as the one surviving lever. It was
implemented, validated (checksum 422, +26,491 B / +1.06 %) and measured
order-reversed. **It makes things worse**, consistently, in both blocks:

| block | `__extern_get` | **dynamic-lookup** | wall |
| --- | ---: | ---: | ---: |
| onA | 8.23 % | **19.45 %** | 53,046 ms |
| offA | 8.59 % | 16.14 % | 49,120 ms |
| offB | 8.58 % | 16.19 % | 48,268 ms |
| onB | 8.40 % | **19.88 %** | 50,217 ms |

`__extern_get` itself barely moves (−0.27 pp), the **bucket rises 3.50 pp**
(16.17 → 19.67) and wall clock is **~6 % worse** — far outside the noise that
made every earlier verdict a null. Reverted.

### The cause, which was foreseen and then overridden

Before building, this was written down: *"the names that have a dispatcher have
one because a closed struct carries the field, so their reads hit struct arms,
not the cache — the arm would almost never fire."* That objection was then
dropped on discovering `reserveMemberGetDispatch` is called **unconditionally**
for static-name reads (`property-access-dispatch.ts:3893`), not gated on struct
candidates.

Both facts are true, and together they are the defect. Because reservation is
unconditional, **every** static name gets a dispatcher — including the many whose
reads are answered by a struct arm a few instructions later. Prepending the cache
check to all of them makes those reads pay ~15 instructions of `ref.test` /
`struct.get` / `ref.eq` that cannot possibly hit, before reaching the arm that
was already answering them. The population that *would* hit is a minority of
dispatchers, and it did not pay for the tax on the rest.

Secondary effect, same direction: the arm inflates each dispatcher past the size
where `wasm-opt` was inlining the trivial ones, so reads that used to fold into a
direct call now pay a real one. That is the same sizing mistake as entry (9),
arriving from the other end.

### The refinement, and the honest caveat about it

The obvious fix is to emit the arm **only for dispatchers with no struct
candidates** — precisely acorn's `locations` / `ranges` / `ecmaVersion` /
`onToken`, which are read off the plain `options` object and have no closed
struct carrying them. That is a one-line gate on the existing candidate list.

It is **not** validated, and it should not be assumed to work: this entry exists
because the last confident prediction here was wrong by 3.5 pp in the wrong
direction. It also cannot recover more than the hit path is worth, and entry (9)
put that at 6.38 pp *including* work the check still has to do.

**Sixth measured attempt, and the first regression rather than a null.** The
value is that the surviving lever from entry (8) is no longer a hypothesis: it
has been built and it does not work as specced. Anyone picking it up starts from
a measured failure and a named refinement, not from §10's optimism.

## 2026-08-12 (14) — the gated inline cache: LANDED FLAG-OFF, measurement still owed

Entry (13)'s named refinement — emit the cache arm **only** for dispatchers no
closed struct carries — is implemented and committed **default-OFF**.

| flag | checksum | binary |
| --- | --- | ---: |
| `JS2WASM_MEMBER_GET_IC` unset / `0` | 422 | **2,490,829 — byte-identical to base** |
| `JS2WASM_MEMBER_GET_IC=1` | 422 | 2,492,413 (+1,584 B) |

The byte-identical off-state is the guarantee #4211 established for the hot/cold
split, and the +1,584 B on-state confirms the gate bites: the ungated ancestor
cost +26,491 B, so this touches roughly a fifteenth as many dispatchers.

**Why flag-OFF and not default-on: the A/B is contaminated and I am not quoting
it.** Two order-reversed runs were launched into the same output directory (one
backgrounded, one `nohup`-ed after an interruption appeared to kill the first).
The file timestamps give it away — `offB` at 01:52 predates `offA` at 01:55,
which is impossible for a single sequential run — and one OFF block came in at
59,944 ms against ~50,500 ms for its siblings, the signature of CPU contention
between two concurrent profile runs. The numbers trended the right way in all
three affected buckets, which is exactly why they must not be quoted: a
contaminated run that agrees with the hypothesis is the easiest kind of evidence
to accept by mistake.

**What is owed before this flips on:** one clean order-reversed ON/OFF/OFF/ON
with nothing else on the box, reporting `dynamic-lookup` **and** `cast-convert`
(the cache arm returns a boxed value, so any saving may land in either), plus
the per-field differential over all 64 ESTree names in **both** read paths per
the #4217 lesson.

**And a prior to hold while doing it.** The gate fixes entry (13)'s regression by
construction — it removes the arm from precisely the dispatchers that were being
taxed — but fixing a regression is not the same as producing a win. The eligible
population is small (+1,584 B is on the order of a dozen names), and if acorn's
hottest generic reads do not sit in it, the honest result is another null. This
is the eighth attempt in this file; five were nulls and one was a regression.

## 2026-08-12 (15) — codegen-level breakdown, both runtimes

Profile buckets say where time goes; this says what the compiler *emitted* to
make it go there. Disassembled the standalone acorn build (`wasm-dis`, names
preserved) and counted.

**Compiled acorn: 1,134 functions, 773,232 WAT lines, 35,403 calls — 99.2 % of
them into runtime helpers.** Compiled acorn code barely calls itself.

| | JS | our wasm | V8 |
| --- | ---: | ---: | ---: |
| `pp.next` | 10 lines | **981 WAT lines, 34 helper calls** | ~12 inline IC sites |
| `pp$2.finishNode` | 5 lines | 177 WAT lines, 6 calls | ~6 inline sites |

Static call sites by category:

| category | sites | share |
| --- | ---: | ---: |
| other runtime (`__new_TypeError` alone is 3,917) | 9,598 | 27.3 % |
| property read | 4,672 | 13.3 % |
| string runtime | 3,854 | 11.0 % |
| devirt trampolines | 3,820 | 10.9 % |
| unboxing | 3,146 | 9.0 % |
| boxing | 2,740 | 7.8 % |
| property write | 1,672 | 4.8 % |
| truthiness | 1,581 | 4.5 % |
| generic property read | 1,376 | 3.9 % |
| method dispatch | 1,270 | 3.6 % |
| coercion | 1,168 | 3.3 % |

### Cross-runtime, per parse

| phase | wasm | node | ratio |
| --- | ---: | ---: | ---: |
| acorn's own code | 55.3 ms | 14.9 ms | 3.7× |
| GC | 4.1 ms | 5.0 ms | **0.82×** |
| runtime helpers | **78.9 ms** | **0 ms** | — |
| total | 138.3 | 19.9 | 6.95× |

Gap 118.4 ms = helpers 78.9 (67 %) + code quality 40.4 (34 %) + GC −0.9 (−1 %).

**We now beat V8 on GC in absolute terms** (4.1 ms vs 5.0 ms). Node's profile is
74.76 % acorn's own functions and 25.24 % GC, with **no helper layer at all** —
which is the entire story. (Caveat: node's profile window was 9,081 ms against
300 × 19.9 = 5,970 ms of parse, so ~34 % is harness/profiler overhead and the
25.24 % GC share should be read as ±several points.)

### Two findings worth acting on

- **`__new_TypeError` at 3,917 static sites is the single largest emitted item.**
  V8 gets null-dereference TypeErrors free from the MMU — the load faults and a
  signal handler raises. We emit an explicit test plus constructor call at every
  member access. Pure spec-compliance tax, almost entirely cold, and it inflates
  every function past `wasm-opt`'s inlining budget. Eliding it where the receiver
  is provably non-null is a **code-size** lever, and code size is what blocks
  inlining.
- **Our code size is itself an optimisation barrier.** 682 WAT lines per function
  average means almost nothing qualifies for inlining. That is the mechanism
  behind entry (9)'s failure, and it means size reductions may buy speed
  indirectly in a way none of this file's measurements would attribute to them.

## 2026-08-13 (16) — GUIDANCE FROM THE BINARY: one defect feeds three of the four workstreams

The disassembly in entry (15) showed five helpers appearing at suspiciously
similar counts. Five helpers at one count means **one emission pattern**, not
five problems. Chasing it found the largest single actionable item in the file.

### The residual abstract-equality cascade — 686 inline copies

`src/codegen/binary-ops.ts` documents the shape in its own comment (~line 1083):
an equality whose operands are not both statically `number` emits, INLINE:

```
__extern_is_nullish ×2 → __extern_is_undefined ×2 → __typeof_number ×2 →
__unbox_number ×2 → __typeof_boolean ×2 → __unbox_boolean ×2 →
__typeof_bigint ×2 → __to_bigint ×2 → __str_flatten ×2 → __str_equals → ref.eq
```

The comment's own words: *"~35 instructions and TWO STRING COMPARISONS for
`tk[i] === 40`, on a tokenizer's hottest line."* #3688 fixed the case where the
checker proves both operands `number`. **686 sites still emit it**, measured from
the disassembly:

| co-emitted helper | sites |
| --- | ---: |
| `__unbox_boolean` | 745 |
| `__typeof_number` | 703 |
| `__typeof_boolean` | 695 |
| `__typeof_bigint` | 686 |
| `__to_bigint` | 686 |

`__to_bigint` at 686 sites in **acorn**, a parser that barely touches BigInt, is
the tell.

### It is the largest cause of the "string" bucket

**682 of the 686 cascade sites have `__str_flatten` co-located.** At two per
cascade that is **~1,364 of 2,497 `__str_flatten` sites — 55 %** — plus a large
share of the 2,644 `__str_equals`.

So `string-runtime` at 4.39 % of runtime is **not mostly string work**. It is an
equality lowering emitting two string comparisons at every site where it cannot
prove the operands aren't strings.

### And the fix already exists, unused

| helper | defined | called |
| --- | ---: | ---: |
| `__any_eq` | 1 | **1** |
| `__any_strict_eq` | 1 | **1** |
| `__extern_strict_eq` | 1 | 117 |

**The outlined cascade is already a function and is called exactly once**, while
686 sites emit it inline. Whatever the original reason, the effect today is
~686 × 35 ≈ **24,000 instructions** of duplicated code.

### Why this reprioritises the workstreams

| workstream | how the cascade changes it |
| --- | --- |
| **lazy strings** | 55 % of the target sites are cascade artifacts. Making `__str_flatten` cheaper treats a symptom; removing the cascade deletes 1,364 sites outright. Re-scope to the genuine string work and let this be handled once. |
| **boxing/unboxing** | The cascade *is* the redundant box→unbox pattern at scale: `__unbox_number` ×2 and `__unbox_boolean` ×2 per site, on operands it has just type-tested. |
| **inlining** | ~24,000 instructions is pure function-size inflation, and size is the binding constraint on `wasm-opt`'s inliner (the 11-vs-45-instruction cliff of entry 9). This is the cheapest large size cut available. |

**Two routes, and they are not equivalent.** (a) Route the 686 sites through the
existing `__any_eq` — a code-size win with a *new call* per site, so it may cost
time even as it shrinks the binary; entry (9) is the cautionary precedent for
exactly that trade. (b) Widen #3688's numeric-hint gate so more sites prove their
operands and skip the cascade entirely — strictly better where it applies,
because it removes the work rather than relocating it, but it only reaches sites
the checker (or `ctx.oracle`) can actually prove.

**(b) first, (a) for the residue.** And note #3688's own warning: narrowing the
comparison while leaving operands boxed is the partial-narrowing shape that
measured as a **2.7× pessimization** in #3673 round 36. The hint must propagate
down into the operand emitters, not just the comparison.

## 2026-08-13 (17) — helper body sizes, and the one bucket nobody is working

Sizes of the hot helpers, from the same disassembly (`optimize: 0`, names
preserved). Read these against the inlining cliff of entry (9): `wasm-opt`
inlined an 11-instruction helper at 1,255 sites and declined a ~45-instruction
one at 1,812.

| helper | wat lines | inner calls | static sites | runtime |
| --- | ---: | ---: | ---: | ---: |
| `__to_primitive` | **642** | **46** | 1,235 | 1.84 % |
| `__extern_strict_eq` | 264 | 4 | — | 2.65 % |
| `__is_truthy` | **126** | **0** | **1,655** | **3.93 %** |
| `__extern_is_nullish` | 53 | 0 | 424 | 0.34 % |
| `__unbox_boolean` | 31 | 0 | 745 | — |
| `__box_boolean` | 14 | 0 | 1,212 | — |

Three things fall out.

**`__to_primitive` at 642 lines and 46 inner calls confirms the fusion slice.**
It is the largest helper on this list by a factor of two and it is called at
1,235 sites, **1,092 of which immediately unbox the result to f64** (entry 15).
Materializing a boxed intermediate through a 642-line, 46-call helper and then
discarding it is the most expensive redundant round trip in the program.

**`dynamic-eq` is 6.93 % of runtime and has no owner.** `__is_truthy` (3.93 %)
plus `__extern_strict_eq` (2.65 %) is a bigger bucket than `string-runtime`
(4.39 %), and larger than the `regexp` bucket the whole AOT-matcher programme
targets. Four workstreams are live — boxing, property access, inlining, strings —
and none of them covers it.

**`__is_truthy` is the cleanest inline-fast-path candidate in the program.** It
is 126 lines with **zero inner calls**, so it is self-contained, and it sits at
1,655 sites and 3.93 % of runtime. It is far past the inlining cliff, so
`wasm-opt` will never hoist it — but it does not need to be hoisted whole. JS
truthiness is false only for `undefined`, `null`, `false`, `0`, `-0`, `NaN` and
`""`; the acorn-dominant operands are i31-packed integers and boxed booleans.
A site-inlined guard of roughly:

```
ref.test i31   -> if: i31.get_s ; i32.eqz ; i32.eqz          (covers 0 vs non-0)
ref.test $BoxedBoolean -> if: struct.get <flag>
else           -> call __is_truthy                            (unchanged)
```

is under ten instructions and leaves the helper as the terminal arm, so it is a
pure fast-path addition with no semantic surface — the shape that has worked
here, as opposed to the reordering and outlining shapes that measured null.

**Deliberately NOT started.** `__is_truthy` is emitted from several lowerings
including the binary-op path that the in-flight `inlining` workstream owns
(`binary-ops.ts` / `binary-ops-typed-dispatch.ts`, entry 16). Opening a fifth
concurrent edit into shared emission would risk a conflict worth more than the
delay. This is the next dispatch once one of the four lands.

## 2026-08-13 (18) — the inliner question is backwards: the IR knows more than `wasm-opt`

Everything in this file so far has asked *"how do we get under binaryen's size
threshold"* — entries (2), (4), (9), (13) and (14) are all variations on it, and
all measured null or worse. The premise deserves challenging.

Two facts, verified:

- **`src/optimize.ts` passes no inlining configuration at all** — only
  `setOptimizeLevel` and `--all-features`. Binaryen has been running default
  heuristics with zero guidance for the entire programme.
- **There is no IR-level inliner.** All inlining is delegated to a pass that sees
  a flat module with the type facts already erased.

### What the IR knows that a flat wasm module cannot express

1. **Which functions are adapters.** The `__dc_*` family is ~25 tiny functions
   carrying **~4 % of runtime in pure self-time**; a trampoline's whole body is
   overhead *by construction*. Binaryen sees ordinary functions and applies a
   size heuristic. The IR knows what they are.
2. **Types — and this is the load-bearing one.** Binaryen inlines *then*
   optimises, over generic code, against a size budget. The IR can inline *with*
   semantics: inline `__get_member_<name>` at a site whose receiver struct type
   is already known, and the `ref.test` folds to a constant, the fallback arm
   goes dead, and what remains is a `struct.get`. **The inlined result is smaller
   than the callee** — so the cliff that blocked every attempt above does not
   apply in the same way. `wasm-opt` cannot reach this: the facts are gone by the
   time it runs.
3. **Structural hotness.** Loop nesting depth is free in the IR and invisible to
   a size heuristic — a call in the tokenizer loop versus one on a throw path.
4. **Cold-by-construction callees.** The 3,917 `__new_TypeError` paths should
   never be inlined, and arguably should not count against a caller's budget at
   all.

### Why this reframes the whole programme

The recorded failures share a shape: each tried to shrink a *generic* helper
until a *generic* inliner would take it. Point 2 says that is the wrong axis.
Specialising at the inline site makes the code smaller **because** it is
inlined — the opposite of the trade every attempt above was making.

**Order of work** (dispatched to the in-flight inlining workstream):

1. **Cheap and decisive first:** find what this binaryen version actually exposes
   (inlining thresholds, always-inline, `--inline-functions-with-loops`) and pass
   it from `optimize.ts`. If a threshold bump alone inlines the hot helpers, that
   is a two-line change and must be measured before anything is built.
2. **Then IR-level inlining as the primary design**, not a fallback. Even a
   narrow cut — `__dc_*` trampolines only, or monomorphic-by-type helper calls
   where the inlined form constant-folds — tests the "specialise while inlining"
   claim, which is the part that would make it strictly better than a threshold
   bump.
3. **Keep the stacked-nulls slice as the control.** If IR inlining works, the
   residual-instruction-count question stops mattering; if it does not, that
   slice bounds the approach.

Credit where due: this reframing came from the project lead, not from the
measurements. The measurements had been circling the same premise for five
attempts without questioning it.

## 2026-08-13 (19) — decision: we own the inlining heuristics, `wasm-opt` is the fallback

Project-lead decision, following entry (18). Not "help binaryen decide better" —
**the inlining cost model moves into the IR, and `wasm-opt`'s inliner handles
only what we do not decide.**

### The cost model, and where its inputs come from

| input | why the IR has it and a flat module does not |
| --- | --- |
| **call-site frequency from loop nesting depth** | the standard AOT substitute for V8's runtime call counts (LLVM's `BlockFrequencyInfo` weights ~10× per loop level). A call in acorn's tokenizer `while` is structurally hotter than one on a throw path. |
| **specialisation delta** | the size of the inlined result *after* site facts fold — not the callee's size in isolation. |
| **adapter classification** | `__dc_*` trampolines are overhead by construction (~25 functions, ~4 % of runtime in pure self-time). No size heuristic should get a vote. |
| **cold-by-construction** | the 3,917 `__new_TypeError` paths inflate every enclosing function and thereby block *its* inlining. Outline or discount them; do not weigh them as body mass. |

### Why loop depth is admissible here when observed frequency was not

#3927 §7 had to abandon frequency-based field ranking: observed instance counts
are a property of the **corpus**, so a compiler cannot use them without becoming
input-specific, and six corpus-independent proxies were scored against ground
truth with none beating ~25 %.

**Loop nesting depth is not that.** It is derived from the source being compiled,
so it is a property of the **program** and stays valid for any input. This
distinction is load-bearing and should be stated wherever the heuristic appears —
a reviewer who knows #3927 will reach for that objection first, and it does not
apply.

### The case binaryen structurally cannot see

The other four inlining attempts in this file all asked "is the callee small
enough". The IR can ask a better question: **how big is the result after the
site's facts fold?** A monomorphic-by-type member-get inlines to a `struct.get` —
**smaller than the call it replaces**. Negative-cost inlining is invisible to a
generic size heuristic, and it is where the value is.

### The obligation this creates

If we inline in the IR and binaryen then re-inlines on its defaults, the two
compound into bloat and our specialised result gets duplicated at every site.
**"We own inlining" is only true if binaryen is not silently re-deciding
underneath us**, so constraining its inlining pass — while keeping the peephole
and DCE passes we do want — is part of the work, not an afterthought. Note
`src/optimize.ts` currently passes no inlining configuration at all, so today
binaryen's defaults are unconstrained.

Order: binaryen's own flags first (two lines, bounds the cheap path), then the IR
inliner narrow — adapters plus negative-cost specialisation sites — then the
stacked-nulls slice as the control.

### Correction to (19): the binaryen "double inlining" obligation was wrong

Entry (19) claims that if the IR inlines and `wasm-opt` then re-inlines, "the two
compound into bloat and our specialised result gets duplicated at every site",
and makes constraining binaryen's inliner part of the work. **Withdrawn.**

**Once a callee is inlined into a caller, the call at that site no longer
exists.** Binaryen cannot re-inline what is not there. There is no
double-inlining mechanism, and the entry asserted one without checking.

What is actually true is narrower, and none of it justifies disabling binaryen's
inliner up front:

- **Transitive size effects, both directions.** Inlining C into A grows A, which
  may push A above binaryen's threshold so A is no longer inlined onward. Real
  second-order effect — but our *specialising* inlines often make A **smaller**,
  which makes it **more** likely to be inlined onward. Watch it in the size
  distribution; do not pre-empt it.
- **Disagreement at declined sites.** Binaryen may inline something we
  deliberately left (a cold path). That is a difference of opinion, not
  compounding, and binaryen's inliner is well-tested.
- **Additive growth.** Two inliners inline more than one. Additive and
  measurable, not multiplicative.

So binaryen's inliner is a **cooperating pass**, not a competitor to be shut off.
The only obligation is empirical: report total binary size and the function-size
distribution, and revisit only if the numbers suggest the two are fighting.

Knowing what inlining flags this binaryen version exposes is still worth an hour
— a threshold bump is the cheap path and bounding it first is right — but as an
experiment, not a defensive measure.

Caught by the project lead, who asked the obvious question the entry had not:
how would it double-inline if the call is already gone.

## 2026-08-13 — the "inlining cliff" is a documented threshold with a SECOND clause, and the clause is what kills the cold-path outline

(Responds to the cold-path-outline entry and the codegen-breakdown entry, which
inferred a cliff "somewhere between 11 and 45 instructions" from two data points:
an 11-instruction helper inlined at 1,255 sites, a ~45-instruction one declined
at 1,812. Those entries are on sibling branches, not on this one.)

Binaryen 125 states the rule outright (`wasm-opt --help`), and the second clause
is the one nothing in this file had accounted for.

| knob | flag | default |
| --- | --- | ---: |
| always-inline max size | `-aimfs` | **2** |
| flexible-inline max size | `-fimfs` | **20** |
| one-caller-inline max size | `-ocimfs` | −1 (unlimited) |
| combined-binary-size cap | `-imcbs` | 409600 |
| inline functions with loops | `-ifwl` | off |
| partial-inlining ifs | `-pii` | 0 |

`-fimfs`'s own help text: flexible inlining applies to functions that are
**"lightweight (no loops or function calls)"**. So a multi-caller helper is
inlined only if it is ≤ 20 AND call-free AND loop-free.

**Consequence, and it is decisive for three recorded experiments.** Every helper
this umbrella wants inlined — `__extern_get`, `__str_flatten`, the `__dc_*`
trampolines — fails the *lightweight* clause, not the size clause. A trampoline
exists in order to make a call. **No amount of shrinking reaches any of them, and
the cold-path outline could never have worked**: the residual `__extern_get`
necessarily contains a `call $__extern_get_cold`, which disqualifies it at any
instruction count. That is a structural explanation for that null, independent of
the ~45-vs-20 sizing error it self-diagnosed.

### The flag matrix, measured (standalone acorn, `wasm-opt -O4`, names preserved)

Run directly on ONE emitted binary, so every row is the same codegen output with
different optimizer arguments. Baseline is today's shipped invocation.

| args | binary | Δ | `call $__extern_get` | `call $__box_number` |
| --- | ---: | ---: | ---: | ---: |
| `-O4` (shipped) | 1,085,558 B | — | 834 | 993 |
| `-O4 -fimfs=60` | 1,208,325 B | **+11.3 %** | **834** | **0** |
| `-O4 --partial-inlining-ifs=2` | 1,085,584 B | +26 B | 834 | 993 |
| `-O4` + `no-inline@__new_TypeError` | 1,054,682 B | −2.84 % | 834 | 993 |
| `-O4` + `no-inline@__new_*` | **1,052,620 B** | **−3.03 %** | 834 | 993 |

Three readings:

1. **Raising the budget reaches exactly the leaf helpers and nothing else.**
   `-fimfs=60` inlines `__box_number` at all 993 sites and moves `__extern_get`
   by zero, for +11.3 % binary. The `__box_number` provability entry already
   priced inlining that helper everywhere — indistinguishable from zero, sign
   flipped with run order. **The cheap path buys the one thing already measured
   worthless.**
2. **Binaryen's own partial inliner does not fire here.** `-pii` is binaryen's
   native version of the hand-built cold-path split; it moves 26 bytes.
3. **The default `-O4` INLINES the cold `__new_TypeError` constructor into all
   4,285 null-guard sites** (`call $__new_TypeError`: 4,285 → **0** after `-O4`).
   Marking it no-inline gives back 30,876 B / 18,079 WAT lines for free. A cold
   constructor duplicated 4,285 times is pure caller bloat, and caller bloat is
   the barrier this issue is trying to remove. **This is the only knob that
   shrinks.**

`--no-inline` has a trap worth recording: its pass-arg takes **one** pattern.
`no-inline@__new_*` works (wildcards are supported);
`no-inline@__new_TypeError,__new_Error` produces a **byte-identical** binary and
still exits 0 — a comma list is silently ignored. And `--no-inline` is a PASS, so
it must precede `-O<level>`; placed after, the marking happens once inlining has
already run.

Shipped as `JS2WASM_INLINE_HINTS` (`src/inline-hints.ts`, default OFF; `=1`
selects `cold`). Before this, `src/optimize.ts` passed **no** inlining
configuration at all.

### Function-size distribution, and the count that was the deliverable

`wasm-dis` of the same builds. "lightweight" = call-free and loop-free, i.e. the
population `-fimfs` can act on at all.

| | pre-`wasm-opt` | `-O4` | `-O4` + cold no-inline |
| --- | ---: | ---: | ---: |
| functions | 3,521 | 1,321 | 1,323 |
| WAT lines | 1,154,211 | 638,106 | **620,027** |
| mean lines/function | 328 | 483 | 469 |
| lightweight functions | 520 | 32 | 30 |
| **eligible at `fimfs=20`** | 38 | **1** | **2** |
| ≥ 1001 lines | 271 | 150 | 144 |

**Functions crossing under the threshold: ONE.** That is the honest answer to
"how many cross the cliff", and it does not depend on which lever is used: the
distribution's mass sits at 100–1000+ lines, three to thirty times the budget,
and no lever in this issue moves a function by more than tens of lines. The `-O4`
mean going UP (328 → 483) while the module halves is the mechanism stated
plainly — binaryen inlines the small functions away and grows what remains.


## 2026-08-13 — eliding provably-non-null TypeError guards is a 2-of-3,629 null, and WHY is the useful part

`__new_TypeError` at 3,917 static sites is the largest emitted item in the
program; the proposal was to elide the guard where the receiver is provably
non-null. Built behind `JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR` (default OFF,
`src/codegen/nonnull-proof.ts`), with a flag-independent census.

**Where the sites actually come from** (standalone acorn, 4,122 emissions; the
top four are 87 %):

| sites | emitter |
| ---: | --- |
| 1,685 | `property-access-dispatch.ts` — the `__nullchk_` guard before `__extern_get` |
| 1,378 | `emitNullGuardedStructGet`, via `property-access-exact-shapes.ts:153` |
| 525 | `tryKnownFnctorDynamicObjectCarrierGet` |
| 206 | `emitNullCheckThrow` from element access |

**Result: 2 of 3,629 candidate guards are provable. Binary −32 B, checksum 422.**

The proofs are statements about the **wasm value**, not the TypeScript type:
`nonnull-ref` (compiled `ValType` is a non-nullable `(ref $T)`, so
`extern.convert_any` cannot yield null), `boxed-number` (`__box_number` returns
`ref.i31`/`struct.new` on every path — restricted to no-JS-host mode, where it is
the in-module native), and `syntactic-producer` (`new X()`, literals, `const` of
those). Type-level nullability was **deliberately refused**: the corpus is JS
compiled with `skipSemanticDiagnostics` and no `strictNullChecks`, where "the
type excludes null" is not evidence about the value, and eliding a live guard
converts a catchable `TypeError` into an uncatchable trap.

**Why it is ~zero, and it is the same wall as everything else in this file.** At
the 1,685-site dispatch guard the compiled receiver is `externref` or `ref_null`
— **never** a non-nullable ref. Acorn's receivers bottom out at untyped
parameters, which is exactly the finding #4155/#743 recorded for the
representation levers. Decline breakdown: 2,658 identifiers, 758
property-accesses, 84 `this`.

### The one proof with real headroom, priced but NOT built

The census also prices a **dominance** proof this module does not implement —
"this receiver was already guarded earlier in the same function":

| | sites |
| --- | ---: |
| repeat guard of an identifier already guarded in this function | 1,864 |
| repeat guard of `this` | 60 |
| first guard of that binding | 869 |
| receiver not a simple binding | 836 |

**1,924 of 3,629 (53 %) are repeat guards** — an UPPER bound, since it ignores
control flow and reassignment. A sound implementation must scope guards to the
current straight-line body region (inherit into nested bodies, never propagate
out of one), and restrict to `this` plus identifiers never assigned anywhere in
the program (a captured `var` can be reassigned by a callee).

**It should not be built for size.** 1,924 guards × ~8 instructions ≈ 2 % of the
module, against a distribution whose mass is 100–1000+ lines per function — by
the entry above it moves the crossing count from 1 to about 1. The correctness
downside is turning a spec-required catchable `TypeError` into a trap. **The
cheaper way to remove the same bloat is `no-inline@__new_*`, which takes
30,876 B with zero semantic risk and no analysis at all** — it stops duplicating
the cold constructor instead of removing the guard.

### Gates

`tests/issue-4157-nonnull-typeerror-elision.test.ts` (ON changes the binary and
shrinks it; answers match JavaScript under both states; a genuinely null receiver
still throws under both) and `tests/issue-4157-inline-hints.test.ts` (OFF is
byte-identical argv; `--no-inline` lands in the pre-`-O` position; a comma list
is refused rather than forwarded into a silent no-op).

Flags unset: census **2,491,907 B / checksum 422**, byte-identical to this
branch's base. Flag ON: 2,491,875 B / checksum 422. `tests/dogfood/acorn.test.ts`
passes under both. The 14-file error-semantics equivalence batch is **13 failed /
77 passed under flag OFF, flag ON, and with `origin/main`'s blobs restored for
every edited file** — all pre-existing (`null-dereference-guards`,
`optional-direct-closure-call`, `tdz-reference-error`).

### Not built, and why

The IR-level inliner (adapters-always / negative-cost specialisation / loop-depth
frequency) is **not** in this branch. The entry above is the argument for
building it rather than against: the two knowledge advantages that survive
contact with binaryen's actual rule are **(a) adapters** — `__dc_*` trampolines
contain a call by construction, so the lightweight clause excludes them
permanently, at any budget — and **(b) negative-cost specialisation**, where a
monomorphic member-get folds to a `struct.get` smaller than the call it replaces,
the only shape that escapes a size budget entirely. The other two are weaker than
they look here: **loop-depth frequency** is a *speed* heuristic, and every
measurement in this file says the binding constraint is size; and **cold
callees** need no IR work at all — binaryen already exposes the exact control,
measured above at −3.03 %.

## 2026-08-13 — call-site inline caching, BUILT: the read becomes machine code, not a call

**LANDED flag-gated, DEFAULT OFF** (`JS2WASM_INLINE_PROP_IC`), in
`src/codegen/member-get-inline-ic.ts`, wired into both finalize sequences.
No wall-clock number is quoted and none was taken — the box was under concurrent
agent load throughout, and §6 of #3927 rules anything under ~10 % unresolvable
here even when it is quiet. What is reported is deterministic: sites,
instructions, bytes, and correctness.

> Ordering note: this lands on a base whose copy of this file ends at entry (5).
> The dispatcher-level attempts it responds to — "outlining the cold path", the
> "implementation spec for the surviving lever", "the spec from §10 was BUILT.
> It is a regression", and "the gated inline cache: LANDED FLAG-OFF" — are
> entries (9), (10), (13) and (14) in the parallel lane's copy. This entry is
> written to merge after them.

### What was built, and why it is a different lever from entries (13)/(14)

Entries (13)/(14) put a cache arm INSIDE `__get_member_<name>`. The read was
still a call. This removes the call: at every eligible
`call $__get_member_<name>` site the dispatcher's FIRST arm is copied inline and
the call becomes the `else`.

```
<receiver: anyref>              ;; the site's own extern.convert_any is DROPPED
local.tee  $__ic
ref.test   $S
if (result externref)
  local.get $__ic ; ref.cast $S ; struct.get $S <slot> ; <box>
else
  local.get $__ic ; extern.convert_any ; call $__get_member_<name>
end
```

**9 total instructions replacing 2** for a reference-typed slot (10 with an f64
box, 11 with an i32 widen + box), counted at FULL DEPTH — the `if` plus both of
its arms — because entry (9) failed by counting four TOP-LEVEL instructions when
one of them was an `if` carrying ~45. The **executed hit path is 6 instructions
and contains no conversion at all**: `local.tee`, `ref.test`, `if`, `local.get`,
`ref.cast`, `struct.get`. That is V8's `load map / compare / branch / load at
fixed offset`, with `ref.test` doing in one instruction what V8 needs a map load
plus a compare for.

Both conversions are gone because the pass inspects the instruction it is
patching in front of: the dominant read site emits `…; extern.convert_any; call
$disp` — it *had* the anyref and converted it only to satisfy the dispatcher's
externref ABI — so the pass **deletes the site's own conversion** and re-adds it
in the miss arm. Worth 2 instructions per site and ~5.5 KB on acorn.

### Why the #2674 hazard cannot recur, structurally

#2674 removed inline multi-struct dispatch because the site froze its candidate
set at that read's compile time; a struct registered later (`$__fnctor_Parser`
after `$__anon_5`) was excluded, reads fell to `__extern_get` → `undefined`
while writes hit the slot, and the expression parser never terminated. Two
independent properties block that here:

1. **No site-frozen set exists.** This is a FINALIZE pass. It calls
   `findAlternateStructsForField(ctx, propName, -1)` — literally the same call,
   at the same point in the pipeline, as `fillMemberGetDispatch` — and runs
   immediately after that fill, before every index-remapping pass
   (`brandCollidingShapeTypes`, dead-elim). The arm it copies and the copy
   therefore live in one type/funcIdx regime, and every later remap treats them
   identically.
2. **A wrong guess is a branch, never an answer.** The `then` arm is a literal
   copy of the dispatcher's arm for `candidates[0]`; the `else` arm is the
   unmodified call. The site's answer set is IDENTICAL to the dispatcher's —
   exactly the property the frozen chain lacked, whose set was a strict subset.
   Even a speculation that never hit would cost only the guard.

Only `candidates[0]` is ever speculated on, and that is what removes the need to
reason about subtyping or structural canonicalization at all: the dispatcher
tests arms in order, so any receiver satisfying the inline `ref.test $S0` would
have taken the dispatcher's first arm anyway. The fast path is not "a case the
dispatcher would also handle"; it is "the exact code the dispatcher would run".

Where copying an arm faithfully would need more than `struct.get` + box — a
`$shape` collision stamp, a packed presence bit, the #2979 generator-sentinel
f64, or any get-accessor candidate (which the dispatcher tries FIRST, so an
inline field read would shadow a getter) — the pass **declines** and the site
keeps today's plain call. There is no half-copy.

### Why it does not repeat entry (13)'s 3.50 pp regression

Entry (13) taxed every dispatcher, including the majority whose reads a struct
arm answers a few instructions later, because `reserveMemberGetDispatch` is
unconditional. This pass fires only where a struct arm IS the answer, and by
default only where the receiver shape is unambiguous. The 37 acorn dispatchers
with **no** struct candidates — `locations`, `ranges`, `ecmaVersion`, `onToken`,
the entire entry-(13)/(14) population — are declined and untouched. The two
levers do not overlap and can be measured independently.

### Why the #1269 narrowing vote cannot move

The Phase-3 vote is computed during EMISSION in `property-access-dispatch.ts`
from the field-kind finders. This pass runs after all emission is finished and
changes no finder, no reservation and no `resultWasm`. It cannot be observed by
the vote, because the vote has already happened. The per-field differential was
run anyway — a structural argument is a reason to expect a gate to pass, not a
substitute for running it.

### Numbers (standalone acorn self-parse, `optimize: 0`, checksum 422 throughout)

| build | bytes | Δ | sha256 | patched sites | functions |
| --- | ---: | ---: | --- | ---: | ---: |
| pass NOT WIRED (base) | 2,459,292 | — | `84f88c1c…b58de` | — | — |
| wired, `JS2WASM_INLINE_PROP_IC` unset | **2,459,292** | **0** | **`84f88c1c…b58de`** | 0 | 0 |
| `=1` (monomorphic only) | 2,497,399 | +38,107 (+1.55 %) | `9d6f2218…4e61e` | **1,497** | 329 |
| `=4` (ceiling raised) | 2,543,189 | +83,897 (+3.41 %) | `5c789a81…0f21d` | 3,347 | 621 |

**Byte-identical-when-off is proved by HASH, not by size**: the flag-off build
and a build with the pass not wired into the finalize sequence at all are the
same 2,459,292 bytes with the same sha256. The flag reads as a number —
unset/`0` disables; `=1` speculates only where exactly one struct carries the
name; `=N` raises the ceiling and still speculates on `candidates[0]`.

**≈25 B per patched site**, in line with the inlining arithmetic in the
`__box_number` entry. Code size is itself an optimisation barrier here (entry 15:
682 WAT lines per function on average already blocks `wasm-opt` inlining), so
+1.55 % is a real cost to weigh, not a footnote — and it is the argument for
shipping `=1` rather than a higher ceiling: `=4` more than doubles the sites for
speculation on names where, by construction, at least one other shape exists.

Declines at `=1`: 58 polymorphic, 37 no-struct-candidates (`locations`,
`ranges`, `ecmaVersion`, `onToken` — the entry-(13)/(14) population), 14
polymorphic on the typed-f64 twin. **Zero sites declined on producer shape**,
after `producesExternref` was widened to resolve IMPORTED callees
(`funcSignatureOf`, not `definedFuncAt` — `__extern_get` and friends are
imports) and to accept a value-producing `if` of externref type, which is what
this pass itself emits and is therefore what a chained `a.b.c` read presents.
Before that widening the same acorn build declined 14 sites at `=1` and 1,116 at
`=4`; the residual discipline is unchanged — the pass still refuses to
`local.tee` any value whose type it cannot prove, exactly as `instrPopsPushes`
refuses to model an unrecognised instruction.

### Correctness

- `cold-tail-census.mjs`: **checksum 422** at every setting, and an unchanged
  allocation census — 189,977 allocations, 5,759,436 struct bytes, all 26
  streams identical ON and OFF.
- **Per-field differential over all 64 ESTree names, BOTH read paths**
  (`PROBE_READ=computed` and `PROBE_READ=named`), ON vs OFF: **0 hash
  divergences, 0 presence divergences, 32,506 nodes, body 422** in both modes.
  This is the #4217 gate: that defect was invisible to a computed read and
  uniform in a named one, so a single-path differential reports all-clear.
- `tests/dogfood/acorn.test.ts`: 3 passed / 1 skipped, identical ON and OFF.
- Property / object / struct / member / proto / hasOwn / numeric-key equivalence
  batch, 49 files: **2 failed / 308 passed, THE SAME two either way** —
  `tests/equivalence/new-non-constructor.test.ts` ("not-a-constructor test262
  pattern compiles without stack underflow", "guard preamble with many exported
  functions does not double-remap"). Attributed by re-running that file against
  `origin/main`'s `src/codegen/index.ts` blob (file copy, never `git stash`):
  both fail there too. **Pre-existing, unrelated.**
- New fixture `tests/issue-4157-member-get-inline-ic.test.ts` (4/4): answers checked
  against **native Node**, plus a mechanism assertion (the pass's own site
  counter must be non-zero AND grow when the ceiling is raised — a gate that
  never bites is indistinguishable from an absent gate), plus the #2674
  read/write-agreement case (write a name onto a struct with no slot for it, so
  it lands in the sidecar, and read it back through the guard).

### Two pre-existing defects this fixture surfaced (NOT caused by this change)

Both reproduce on the base build, and are recorded because they cost real time to
rule out and will cost the next lane the same.

1. **Structurally identical class structs alias in `__get_member_<name>`.** With
   `class Mono { mv: number }` and `class Bare { other: number }` — same field
   arity, same kinds — a dynamic read of `.mv` on a `Bare` instance answers
   `Bare.other`, not `undefined`. WasmGC canonicalizes the two structs to one
   heap type, so the dispatcher's `ref.test $Mono` matches a `Bare`, and no
   `$shape` stamp guard is present on these candidates. Mechanism not diagnosed
   beyond that; the observable is certain. Giving every fixture class a distinct
   field arity makes it go away, which is why the committed fixture does.
2. **A monomorphic f64-narrowed read answers `NaN` on a MISS, not `undefined`.**
   #1269's Phase-3 narrowing collapses a single-f64-candidate read to f64, so a
   receiver that does not carry the name unboxes `undefined` to NaN. That is why
   the fixture splits its miss cases into a second entry point whose oracle is
   the base build rather than Node.

### What is owed, and the prior to hold while doing it

One clean order-reversed ON/OFF/OFF/ON on `standalone-dynamic` with nothing else
on the box, reporting **`dynamic-lookup` AND `cast-convert`** (the inlined arm
boxes, so a saving may land in either) and the bucket total, not just the
`__extern_get` frame — entry (9) moved 2.33 pp between frames for a net 0.13 pp
and only the bucket exposed it.

The prior: this is the ninth attempt recorded in this file, of which five were
nulls and one was a regression. What is different is that the target is the
6.38 pp cache-hit **prologue** entry (9) isolated, that the call itself goes away
rather than being relocated, and that the hit path is 6 instructions with no
conversion. What is the same is that this box cannot resolve small effects, and
that +1.53 % of binary is a real cost that has to be paid back.

## 2026-08-13 (20) — ToNumber fast paths: fused coercion and an i31 operand guard

Entry (15) counted **2,010 static sites where a helper boxes a value the call
site immediately unwraps**, the largest single pattern being
`__unbox_number(__to_primitive(x))` at 1,092. Both slices below are built,
**default OFF**, byte-identical when off (sha256-verified, not just size).

### Slice A — `JS2WASM_FUSED_TONUMBER`: 1,085 sites, **−6,314 B**

One fused `__to_number` replaces the pair at the single standalone
`externref → f64` coercion site. Three fast arms, each provably equal to the
pair **because all three early-out before `__to_primitive`'s `$Object` test**,
so no user code runs and nothing can throw or be reordered:

| value | fused arm |
| --- | --- |
| null extern | `f64.const 0` |
| `ref.i31` | `i31.get_s; f64.convert_i32_s` |
| `$BoxedNumber` | `struct.get 0` |

Excluded, falling through to the unchanged pair in unchanged order: `"string"`
and `"default"` hints, every observable ToPrimitive shape (`valueOf`/`toString`,
class instances, arrays, wrapper `[[PrimitiveValue]]`, the `$AnyValue`
`undefined` singleton), and **native strings** — decidable, but excluded on
purpose because composing it means a full `__str_to_number` scan and a second
place for §7.1.4.1 to drift.

**Size sign is site-count dependent**: −6,314 B on acorn's 1,085 sites but
**+21 B** on a small fixture, since it trades ~11 B/site against one fixed helper
— the same break-even shape as the const-box hoist.

### Slice B — `JS2WASM_SMI_FASTPATH`: 1,075 sites, **+24,358 B**

`ref.test i31` on the operand, then `i31.get_s; f64.convert_i32_s`, else the
unchanged slow chain. The **non-nullable** `ref.test` form is deliberate: a null
externref answers 0 and takes the slow arm, which returns 0 for null — the same
answer — so no extra null test is needed and the `then`-arm's cast cannot see
null.

**+24 KB cuts directly against entry (15)'s finding that code size is itself an
inlining barrier.** That is a real reason the A/B may come out negative, and it
is stated here rather than discovered later.

### The i32-arithmetic half is NOT built, and the proof that it needs no range guard

It is a binary-op-site transform (`binary-ops-typed-dispatch.ts:626-638`,
`:1560-1593`), which was off-limits to that workstream. The recommendation, with
the part worth keeping:

> When both `leftType` and `rightType` are `externref`, hoist both to locals and
> guard `ref.test i31` on both. The fast arm needs **no range guard on the
> result**: `a, b ∈ [-2^30, 2^30-1]` gives `a ± b ∈ [-2^31, 2^31-1]`, which fits
> i32 exactly, and `f64.convert_i32_s` is exact — so
> `f64.convert_i32_s(i32.add(a,b)) ≡ f64.add(f64(a), f64(b))`. `-0`, `NaN` and
> non-integers are excluded by the guard itself.

Order caution for whoever builds it: today the **right** operand is coerced
before the left; the slow arm must preserve that.

### Correctness

Census checksum 422 in all four flag states with allocation counts (189,977) and
struct bytes (5,759,436) identical — no allocation change, as expected. Acorn
dogfood 7 equal / 0 divergent. A 24-file coercion batch 160/160 and a 12-file
standalone numeric batch 91/91, in every state.

Two failures attributed, **both pre-existing**: a QuickJS-provider environmental
failure, and `var o: any = {valueOf: …}; var s: number = o - 1;` inside a
function body failing to compile (`local.set[0] expected (ref null 76), found
f64.const`) — **reproduced byte-for-byte on `origin/main` blobs at the same
offset**. A module-level binding of the same object compiles fine. Unfiled; worth
an issue.

## 2026-08-13 — lazy string flattening: two of the three named levers were already spent; the third is redundancy, and it is 403 sites

Lane record for the `string-runtime` bucket (4.39 % of runtime, `__str_flatten`
2.54 % at 2,497 static sites). Read alongside the disassembly entry that
attributes ~55 % of those sites to the residual abstract-equality cascade —
this entry deliberately does **not** touch `binary-ops.ts` /
`binary-ops-typed-dispatch.ts`, and quantifies what is left after that lane
lands.

Everything below is static/structural. **No timings were taken.**

### Two of the three scoped levers do not exist — they shipped years ago

- **"Make `__str_flatten` cheap when already flat."** It already is. The FIRST
  instruction of its body is `ref.test $NativeString` → `ref.cast` → return
  (`native-strings-core.ts`, `emitStrFlattenHelpers`). There is no work to add.
- **"Memoise the flattened form on the rope."** Already done, by #3673:
  `flattenConsBody` rewrites the cons **in place** to `(left = flat, right = "")`
  and the next flatten of that rope takes a two-field fast path instead of an
  O(len) re-copy.
- **`wrapBodyWithFlatten` goes further still** — it inlines the
  `ref.test $NativeString` at each helper's entry, so an already-flat param
  skips the *call itself*, not just the copy. Its own comment records why: the
  unconditional call "was 35 % of a standalone compiled-acorn parse".

So `__str_flatten` at 2.54 % is **not** ropes being copied. It is the call
being made where it did not need to be made at all.

### What IS forced: the caller-side flatten in front of a self-flattening callee

Disassembled the standalone acorn build (`wasm-dis`, `optimize: 0`) and
classified every `call $__str_flatten` by its real consumer (walking past
`ref.cast` / `ref.as_non_null` / `local.tee` / `*.convert_*`):

| consumer of the flattened value | sites | callee self-flattens? |
| --- | ---: | --- |
| `__str_equals` | 1,722 | **yes** (`wrapBodyWithFlatten(body, [0, 1])`) |
| `else` (if-arm result) | 200 | — |
| `local.set` | 192 | — (114 of them from `__extern_toString`) |
| `__str_charAt` | 186 | **yes** `[0]` |
| `__str_slice` | 148 | **yes** `[0]` |
| `struct.get` / `return_call` / `then` / misc | 38 | — |
| `__str_substr` · `__str_substring` · `__str_compare` | 9 | **yes** |
| **total** | **2,497** | **2,065 (82.7 %) redundant** |

`__str_equals`, `__str_charAt`, `__str_slice`, `__str_substring`,
`__str_substr`, `__str_compare`, `__str_indexOf`, `__str_split`,
`__str_replace`, `__str_replaceAll` and siblings all take `ref $AnyString` and
flatten their own params. A `call $__str_flatten` at the call site therefore
recomputes exactly what the callee's guard would have skipped.

**And it is worse than redundant.** `__str_equals` answers three questions that
need no flat buffer — `ref.eq` identity, the length compare, and the
`$HashedString` hash reject — but `wrapBodyWithFlatten` prepends the flatten to
the **top** of the function, ahead of all three. Pre-flattening at the call site
then guarantees the helper never sees a rope, so `bigRopeA === bigRopeB` with
differing lengths copies both ropes into fresh buffers to answer a question the
`$AnyString` length field answers in one `struct.get`.

### Landed, flag-gated: `JS2WASM_LAZY_STR_FLATTEN=1` (default OFF)

New leaf `src/codegen/lazy-str-flatten.ts` (explicit `=1` opt-in, NOT the
`derivation-flags.ts` unset-⇒-ON rule — the OFF position carries a
byte-identity guarantee and must not be enabled by a typo).

1. **`__str_equals` flattens lazily** (`native-strings-basics.ts`). The same
   guarded preamble `wrapBodyWithFlatten` would have prepended is *relocated*,
   byte-for-byte, to just before the character loop — the only consumer of
   `off`/`data`. The length compare reads `$AnyString` field 0 instead of
   `$NativeString` field 0.
   **Soundness:** field 0 is the JS-visible code-unit count on all three
   subtypes and immutable on all three — `$ConsString` keeps the total across
   the in-place memoization rewrite, and `$Utf8String` field 0 is the UTF-16
   length, not the byte length (`registry/types.ts`). `ref.eq` moved ahead of
   the flatten can only lose true-answers, never gain them (same object ⇒ same
   string), and every case it loses — e.g. two distinct `x + ""` conses whose
   memoized `left` is the same flat struct — falls through to the char compare
   and returns the identical verdict. The hash reject requires both sides to be
   `$HashedString`, which a rope never is, so ordering cannot change it.
2. **`__extern_get` no longer flattens its key** (`object-runtime.ts`,
   `stringKeyArms`), and the `__fkey_ladder` scratch local widens to
   `$AnyString`. Nothing downstream needed flat: `ref.test`/`ref.cast
   $HashedString` and the baked-hash `struct.get` accept `$AnyString`,
   `__obj_hash` is handed the ORIGINAL externref (`local.get 1`), and the
   bucket probes go through `__str_equals`. A rope key fails the
   `$HashedString` test and takes the `__obj_hash` arm — which is the arm it
   already took, because a freshly-flattened cons carries hash 0 (uncomputed).
   Note the **dynamic** count here is 64,680/parse, not 506,752: the round-21
   per-key cache arm is unshifted LAST, so it returns before this on the
   87.24 % that hit (see the per-key-cache entry above).
3. **Redundant caller-side flattens dropped** where the immediate callee
   self-flattens: `string-ops.ts` (`charAt`, `substring`, `slice`, `substr`,
   `replace`/`replaceAll` ×3 params, and `emitNullableStringEquals`) and
   `string-element-read.ts` (`__str_charAt`). Kept wherever the emitted code
   itself needs the flat type (`at`, `codePointAt` read `struct.get
   $NativeString` off the result) or the callee does not self-flatten
   (`__str_repeat`, `__str_padStart`/`padEnd`, `__str_isWellFormed`,
   `__str_toWellFormed`, `__str_to_extern`).

### Result (static; no timings)

| | flag OFF | flag ON |
| --- | ---: | ---: |
| `call $__str_flatten` sites, acorn | 2,497 | **2,094** (−403) |
| acorn binary, `optimize: 0` | 2,459,292 B | 2,456,866 B (−2,426) |
| `cold-tail-census` binary / checksum / allocations | 2,491,907 B / **422** / 189,977 | 2,489,481 B / **422** / 189,977 |

Consumer histogram after: `__str_charAt` 186 → **0**, `__str_slice` 148 → **0**,
`__str_substr` 4 → **0**, `__str_equals` 1,722 → 1,664. Allocation counts are
identical, i.e. the change moves no allocation — as expected, since it removes
calls rather than copies.

**Byte-identical when OFF**: the flag-OFF build `cmp`s byte-for-byte against a
build of the same tree taken before any edit, and the census reproduces
pristine-HEAD's 2,491,907 B exactly.

> The brief quoted **2,490,829 B** for the census baseline. Pristine
> `da371b2e8` measures **2,491,907 B / checksum 422**, verified by reverting all
> four touched files to `HEAD` via file copies (never `git stash`) and re-running.
> The 1,078-byte delta predates this work.

### The 1,664 remaining `__str_equals` feeders are the cascade's, and there is a one-line-each win in them for that lane

Every remaining site is emitted by `binary-ops-typed-dispatch.ts` — the
abstract-equality cascade (~line 959/962) and the mixed-externref strict-equality
arm (~line 261/264) — both outside this lane. **Reported, not built:** those four
`{ op: "call", funcIdx: flattenIdx }` entries can be deleted outright.
`__str_equals` takes `ref $AnyString` and flattens its own params, so the
operands are already type-correct without them. That single deletion:

- removes ~1,364 more static `__str_flatten` sites (the largest remaining block
  in the bucket), and
- is what makes lever (1) above actually reachable at the hottest equality in
  the program — today the cascade pre-flattens both operands, so the helper's
  identity/length/hash answers never get to skip the materialization.

It is **independent of, and much smaller than, removing the cascade itself**, and
it does not relocate work into a new call the way route (a) of the cascade entry
would. Worth taking even if the cascade work slips.

### Refused, and why

- **`String.prototype.at` / `codePointAt`** keep their caller-side flatten: the
  emitted code reads `struct.get $NativeString` off the result, so the flat type
  is load-bearing, not decorative.
- **`trim`/`trimStart`/`trimEnd` and `toLocale{Lower,Upper}Case`** keep theirs:
  the helper actually invoked is selected at emit time
  (`selectProvenAsciiCaseHelper`) or is not one of the `wrapBodyWithFlatten`
  set, so "the callee self-flattens" could not be established for every arm.
- **`__str_concat`'s eager flatten below the 64-char rope threshold** is left
  alone. It is the deliberate representation choice (a rope node for a 3-char
  string is worse than the copy), the same call V8 makes, and nothing in the
  measurement points at it.
- **Hoisting `ref.eq` out of `__str_equals` to the call sites** was not done:
  it would change which allocation identity is compared at 2,670 sites, and the
  in-helper ordering achieves the same thing with one copy of the logic.

### Gates

- `cold-tail-census`: checksum **422** both flag positions.
- `tests/dogfood/acorn.test.ts`: pass, flag ON.
- 33 string-adjacent `tests/equivalence/*` files: pass OFF **and** ON.
- 32 object / dynamic-lookup `tests/equivalence/*` files (extra net for the
  `__extern_get` key change): pass ON.
- Two chunks OOM-killed (exit 137) on the first attempt at
  `maxForks=2` with other agents live; re-run one file at a time they pass in
  **both** flag positions, so the kill is container memory, not the change.

## 2026-08-13 (21) — MEASURED: the stack removes 28.6 % of executed helper calls

The first non-null in this issue since #4217, and it is measured with a new
instrument that does not depend on the machine being quiet.

### Why a new instrument

Every verdict in this file rests on profile bucket share with order-reversed
blocks. Share is a RATIO, so it survives a uniformly slower box — but contention
is **not** uniform (it perturbs memory-bound code and GC timing more than
compute-bound code), and during this very run the same 300-iteration workload
took **36 s, 46 s, 50 s and 71 s**. "More robust than wall clock" was being
treated as "sound", and it is not.

`src/codegen/exec-census.ts` (`JS2WASM_EXEC_CENSUS=<substr>,…`) counts **executed
calls** instead. Exact, identical every run, immune to load. It reads
`__extern_get` at **506,752 calls/parse**, matching the independent per-key cache
census in entry (12) to the call — which is what validates it.

**Why the existing `JS2WASM_ALLOC_CENSUS_CALLS` is broken, now diagnosed** (entry
16 left this open and withdrew a wrong guess): it splices its increment **at each
call site**, landing inside the callee's argument sequence. `applyRefNullFixups`
walks backwards from a `call` mapping ~one instruction per parameter, so four
extra instructions desynchronise it and it retypes a `ref.null.extern` against
the wrong parameter. **Incrementing at FUNCTION ENTRY is not adjacent to any
call**, so no argument sequence is disturbed. That is the whole design
difference, and it is the fix for the older census too.

### The result — all five flags on, acorn self-parse, checksum 422 both sides

| helper | OFF | ON | Δ |
| --- | ---: | ---: | ---: |
| `__to_primitive` | 568,788 | **268** | **−100.0 %** |
| `__unbox_number` | 883,318 | 314,798 | −64.4 % |
| `__str_flatten` | 516,717 | 421,019 | −18.5 % |
| `__is_truthy` | 997,454 | 997,454 | 0 |
| `__extern_get` | 506,752 | 506,752 | 0 |
| `__box_number` | 489,166 | 489,166 | 0 |
| `__str_equals` | 254,976 | 254,976 | 0 |
| **total** | **4,312,736** | **3,079,998** | **−1,232,738 (−28.6 %)** |

Binary 2,459,686 → 2,452,499.

`__to_primitive` and `__unbox_number` fall by **exactly 568,520 each** — proof
they were a paired round trip, which entry (15) predicted statically and the
profile could only hint at.

### It cross-validates the profile rather than replacing it

The order-reversed profile of the same stack put `cast-convert` at **2.13 % ON vs
3.94 % / 3.96 % OFF (−1.83 pp)**, with the two OFF blocks agreeing to 0.02 pp,
and `string-runtime` at **3.10 % vs 3.56 % / 3.84 % (−0.60 pp)**. Since
`__to_primitive`'s 568,788 calls were 1.84 % of runtime, removing them predicts
almost exactly the observed cast-convert drop. **Two independent instruments,
one answer.** Use counts for the verdict and the profile for attribution.

### What it proves negatively, and exactly

- **`__extern_get` unchanged at 506,752.** The call-site inline cache patched
  1,497 sites and eliminated **zero** calls — it speculates ahead of
  `__get_member_<name>`, not `__extern_get`. That is the sixth null on this
  bucket and the first one that is exact rather than inferred.
- **`__box_number` unchanged.** The i31 slice guards an *operand*; it does not
  reduce boxing.
- **`__is_truthy` unchanged at 997,454 — the largest single number on the
  board**, and nothing in this session touched it. It is the unowned
  `dynamic-eq` bucket from entry (17), and it is now the clearest target in the
  program.

### Standing method change

**Counts are the verdict; the profile is for attribution.** A count answers "does
the emitted code do less work", which is what an optimisation actually claims.
Wall clock on this box is not evidence, and bucket share is evidence only when
the blocks replicate.

## 2026-08-13 (22) — CORRECTION: the inline property cache works; I measured the wrong helper

Entry (21) reported the call-site inline cache as eliminating **zero** calls and
recommended leaving it off. **That verdict is withdrawn — it was measured wrong,
twice.**

1. The stack run set `JS2WASM_MEMBER_GET_IC`, **a flag that does not exist**. The
   real name is `JS2WASM_INLINE_PROP_IC`. The cache was never enabled.
2. After fixing the name, I checked `__extern_get` — which the cache **does not
   target**. It speculates ahead of the per-name `__get_member_<name>`
   dispatchers, and those were not in the census target list at all.

Re-measured with `JS2WASM_EXEC_CENSUS` on the helper it actually targets, acorn
self-parse, `optimize: 0`, checksum 422 in every row:

| build | binary | `__get_member_*` executed | names | `__extern_get` |
| --- | ---: | ---: | ---: | ---: |
| OFF | 2,471,129 | 1,000,011 | 83 | 506,752 |
| `=1` (default ceiling) | +38,107 | 913,260 (**−86,751**, −8.7 %) | 72 | 506,752 |
| **`=4`** | +83,897 | **436,668 (−563,343, −56.3 %)** | 51 | 506,752 |

**At ceiling 4 the cache removes 563,343 executed dispatcher calls per parse** —
comparable to the fused-ToNumber slice's 568,520, which this file has already
accepted as the session's clearest win.

`__extern_get` really is unchanged at 506,752 in every configuration; that part
of entry (21) stands. It is simply not the helper this optimisation addresses.

### Two lessons, both about the instrument rather than the optimisation

- **A flag name is part of the measurement.** Nothing in the harness objects to
  an unrecognised environment variable, so an experiment that sets the wrong one
  silently measures the baseline against itself and reports a confident null.
  Assert the mechanism fired — the fire-probe technique of entry (2), or a
  site/patch counter — before believing any negative.
- **Measure the helper the change targets, not the one the bucket is named
  after.** `dynamic-lookup` contains both `__extern_get` and the
  `__get_member_*` family; the cache moves the second and not the first, and
  looking only at the bucket's largest frame hid a 56 % reduction.

### The default ceiling is wrong

`=1` costs 38 KB for 8.7 %; `=4` costs 84 KB for 56 %. Whatever ships, the
ceiling should be chosen on this curve rather than left at 1. Higher ceilings are
unmeasured.

## 2026-08-13 (22) — the specced i32-arithmetic site is DEAD; the reachable half is the box, and it removes 489,165 of 489,166 boxing calls

Entry (20) handed the i32-arithmetic half to whoever owned
`binary-ops-typed-dispatch.ts`. **That site cannot fire.** What replaces it is
`src/codegen/smi-box-fast-path.ts`, on the same `JS2WASM_SMI_FASTPATH` flag,
default OFF, byte-identical when off (sha256-verified).

### The null first, because it invalidates the spec, not just the estimate

Instrumented `compileTypedBinaryDispatch` with a per-`(op, leftKind, rightKind)`
tally over a whole standalone acorn self-compile. Every arithmetic and
relational dispatch — 1,617 of them — arrives **`L=f64 R=f64`**:

| op | sites | L/R |
| --- | ---: | --- |
| `>=` · `<` · `>` · `<=` | 979 | all `f64`/`f64` |
| `+` · `-` · `*` · `%` | 478 | all `f64`/`f64` |
| `&` · `|` · `<<` · `>>` | 160 | all `f64`/`f64` |
| **numeric ops with an externref operand** | **0** | — |

The externref pairs at that dispatch (`===` 61, `!==` 2, plus 700-odd mixed
`externref`/`ref`) are **equality**, which is not `isNumericOp` and never reaches
line 626.

The cause is structural, not incidental: `compileBinaryExpression` compiles both
operands with a **numeric hint**, so the `externref → f64` ToNumber is emitted
*inside* each operand's own compilation — at the `type-coercion.ts` site slice B
already patches — and the dispatch only ever sees f64. Ten hand-written operand
shapes (member read `o.x - o.y`, call result, element read, two `any` params,
`any` vs literal in both orders, `unknown` casts, `*`, `<`, `|`) reproduce it:
all `f64`/`f64`. So the transform was not merely low-yield, it had **no site**,
and building it would have shipped unexercised code.

### Where the boxes actually are (static, from `wasm-dis` of the acorn build)

1,798 `call $__box_number` sites, by the producer feeding them:

| producer | sites | | producer | sites |
| --- | ---: | --- | --- | ---: |
| `local.get` | 403 | | `if` | 90 |
| `call` | 327 | | `call_ref` | 74 |
| `struct.get` | 238 | | `f64.const` | 55 |
| **`f64.add`** | **173** | | **`f64.sub`** | **37** |
| **`f64.convert_i32_s`** | **138** | | `global.get` · `local.tee` · `block` · `array.get` | 263 |

Arithmetic feeds **210 of 1,798 (11.7 %)**, and only **70** of those have *both*
operands dynamic (`__unbox_number` on each side) — the shape the specced
transform was aimed at. That is the ceiling the binary-op route was ever going
to have, i32 operands or not.

### What was built

A finalize pass, not an emitter hook, because the boxing calls come from **two**
front ends — legacy `coerceType` and the IR lowering's `emitBox`
(`ir/integration.ts`) — and on this workload the IR is the one that matters:
hooking `coerceType` alone reached **2** sites in a probe module. One pass over
the finished bodies covers both, exactly as `const-box-hoist.ts` does. It runs
right after the const hoist (so a constant box is already a `global.get` and is
never re-expanded) and before dead elimination (so the `call $__box_number` kept
in each else-arm is index-remapped like every other call).

Two levels of the one flag, because the difference is purely a size lever:

- **`=1`** — rewrites only `f64.convert_i32_s; call $__box_number`, i.e. an i32
  that was widened solely to satisfy the helper's signature. **138 sites.** The
  emitted guard is *only* the 31-bit range test, because `__box_number`'s other
  two clauses are provably vacuous on an i32 source: `f64.convert_i32_s` is
  exact and `i32.trunc_sat_f64_s` inverts it for every i32, so the round-trip
  clause always holds; and `f64.convert_i32_s` yields `-0` for no input (`0`
  gives `+0`), so the sign-bit clause always holds too.
- **`=all`** — also rewrites the other 1,660 sites with `__box_number`'s own
  predicate, inlined verbatim, delegating to the untouched call when it fails.

Both failure arms call the unchanged helper, so the `$BoxedNumber` allocation
path is never duplicated and never re-derived.

### Measured — acorn self-parse, `optimize: 0`, checksum 422 everywhere

Executed calls (`JS2WASM_EXEC_CENSUS`, the entry (21) instrument):

| helper | OFF | `=1` before this change | **`=1`** | **`=all`** |
| --- | ---: | ---: | ---: | ---: |
| `__box_number` | 489,166 | 489,166 | **481,393** | **1** |
| `__unbox_number` | 883,318 | 321,807 | 321,807 | 321,807 |
| `__to_primitive` | 568,788 | 7,277 | 7,277 | 7,277 |
| `__is_truthy` | 997,454 | 997,454 | 997,454 | 997,454 |

Binary, `optimize: 0`, census off:

| position | bytes | Δ vs OFF | Δ vs operand half alone |
| --- | ---: | ---: | ---: |
| OFF | 2,459,292 | — | — |
| `=1`, before this change | 2,483,651 | +24,359 | — |
| `=1` | 2,486,950 | +27,658 | **+3,299** (138 sites, ~24 B each) |
| `=all` | 2,569,881 | +110,589 | **+86,230** (1,798 sites, ~48 B each) |

**`__box_number` at 1 is the headline and it is worth reading twice**: across an
entire acorn self-parse exactly ONE boxed number is not i31-able. Entry (20)'s
premise that the box was the thing to remove was right; the mechanism was in the
wrong place. Note also what did NOT move — `__unbox_number` is untouched,
because guarding the box does not remove an unbox, the mirror of entry (21)'s
finding that guarding an operand does not remove a box.

`cold-tail-census` allocations are **189,977** and struct bytes **5,759,436** in
both positions, identical: the change moves no allocation, as it must not — the
i31 arm was already what `__box_number` returned in these 489,165 cases, so this
removes the CALL, not an allocation. It is a call-count win, not a GC win, and
the profile should be expected to move by roughly what 489 k eliminated calls are
worth, no more.

### Correctness

- `cold-tail-census`: checksum **422** OFF and `=all`; allocations and struct
  bytes identical.
- `tests/dogfood/acorn.test.ts` with `DOGFOOD_ACORN=1` (the heavy compile →
  validate → AST-diff loop): pass OFF and `=all`.
- 28-file numeric/arith/coercion/equality/comparison equivalence batch:
  **188/188 in all three positions**, zero failures, so nothing to attribute.
- New `tests/issue-4157-smi-box-fast-path.test.ts` — 6 cases × 3 flag positions,
  pinning the values where a mis-copied predicate diverges: the ±2^30 i31 edges
  and their ±1 neighbours, `-0` (which round-trips through
  `i32.trunc_sat_f64_s` and must **not** become `ref.i31 0` — checked via
  `1/x === -Infinity` from inside Wasm), NaN self-inequality, both infinities,
  non-integers, `Object.is` across boxes, `typeof`, truthiness, and dynamic
  subtraction across the i31 edges.
- One failure, attributed and **not a defect**:
  `issue-4157-const-box-hoist.test.ts` "removes every constant boxing CALL"
  expects 4 executed boxing calls per iteration with hoisting off, and sees 3
  under `=all`. That test's own comment names the reason — "42 is i31-able and
  never allocated" — so the guard answers exactly that one constant inline. It
  asserts a flag-OFF baseline and passes with the flag unset, which is the
  default.

### Refused, and why

- **The specced binary-op transform.** No site (above). Making one would mean
  dropping the numeric hint for numeric ops, which moves ToNumber from
  "eval-left, ToNumber-left, eval-right, ToNumber-right" to "eval both, then
  ToNumber right, then left" — one non-conformant order for a different
  non-conformant order (§13.15.3 wants left-ToNumeric first), observable
  wherever an operand's `valueOf` runs user code. Not worth it for ≤70 sites.
- **`*`, `/`, `%`, `**` in i32.** `a * b` on two i31 operands overflows i32
  (2^30 × 2^30), and `/` and `%` are not closed over the integers at all. Only
  `+`, `-` and the comparisons carry the no-range-guard proof from entry (20),
  and none of them has a site.
- **Boolean- and symbol-branded i32.** They box through
  `__box_boolean`/`__box_symbol` and carry a TAG that `ref.i31` would erase
  (#2785/#2760). Only `__box_number` is matched.
- **JS-host mode.** `__box_number` is an `env::` import there and a boxed number
  is a JS number, not a WasmGC `ref.i31`. Gated on `nativeBoxNumberTypeIdx >= 0`,
  which is exactly the condition under which the i31-producing native was
  registered.
- **Constant boxes.** `const-box-hoist.ts` runs first and turns them into a
  `global.get` of a once-seeded global, which is strictly better than an inline
  `ref.i31`.

### The obvious next question, unbuilt

`=all` costs 86 KB to convert 481,392 calls; `=1` costs 3.3 KB for 7,773. Neither
was timed — entry (21)'s standing rule is that counts are the verdict and this
box cannot resolve wall clock. But entry (15) found code size is itself an
inlining barrier, so `=all`'s +3.5 % is a real counterweight that only an A/B on
a quiet machine can price.


## 2026-08-13 (23) — `__is_truthy` inlined at the call site: **−757,690 executed calls (−76 %)**, and the operand mix is NOT what entry (17) predicted

`__is_truthy` was the largest single executed-call figure in the programme —
**997,454 per acorn self-parse**, 3.93 % of runtime, the unowned `dynamic-eq`
bucket of entry (17) — and nothing had ever touched it. It is now inlined at the
call site behind `JS2WASM_INLINE_TRUTHY_IC`, **default OFF**.

**LANDED flag-gated** in `src/codegen/is-truthy-inline-ic.ts` (the rewrite) and
`src/codegen/is-truthy-ladder.ts` (the ladder extraction), invoked from both
finalize pipelines immediately after `inlineMemberGetCallSites`.

### The result — acorn self-parse, `optimize: 0`, checksum **422** in every row

| arm set | `__is_truthy` executed | Δ | removed | binary | Δ bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| OFF (base) | 997,454 | — | — | 2,459,473 | — |
| **`=1` (`anyval,boxbool`)** | **239,764** | **−757,690** | **76.0 %** | 2,541,262 | **+81,789** |
| `anyval,boxbool,str` | 228,523 | −768,931 | 77.1 % | 2,575,947 | +116,474 |
| `anyval,i31,boxbool,str` | 222,901 | −774,553 | 77.7 % | 2,607,346 | +147,873 |
| `all` (6 arms) | 222,901 | −774,553 | 77.7 % | 2,707,567 | +248,094 |

1,643 of the 1,655 static sites patched, in 504 functions; 12 declined on
producer shape. `__box_boolean` (333,363), `__unbox_boolean` (2) and
`__extern_strict_eq` (169,828) are **unchanged in every row** — this pass moves
one helper and claims nothing about the others.

On the acorn module without the census driver: `optimize: 0`
1,841,473 → 1,923,262 (**+81,789 B, +4.4 %**); `-O4` 1,053,313 → 1,091,567
(**+38,254 B, +3.6 %**) — `wasm-opt` recovers 53 % of the added bytes.

For scale, this is a **larger** reduction than either previously-accepted win
(the fused-ToNumber slice's −568,520 and the property cache's −563,343) and it
costs about the same bytes as the property cache at ceiling 4 (+83,897).

### The finding: entry (17) named the wrong operands

Each arm was measured alone. The six singleton deltas **sum to 774,553, exactly
the all-arms delta** — the arms are disjoint and the counts are additive, which
is itself the cross-check that the model is right.

| arm | hits/parse | share of all calls | +bytes @O0 |
| --- | ---: | ---: | ---: |
| `boxbool` — boxed boolean | **493,911** | **49.5 %** | +43,817 |
| `anyval` — `$AnyValue` (`undefined` singleton) | **263,779** | **26.4 %** | +48,746 |
| `str` — `$AnyString` (`""` vs non-empty) | 11,241 | 1.1 % | +45,460 |
| `i31` — small-int | 5,622 | 0.6 % | +42,174 |
| `boxnum` — heap-boxed f64 | **0** | — | +74,674 |
| `bigint` | **0** | — | +47,103 |

Entry (17) predicted "the acorn-dominant operands are i31-packed integers and
boxed booleans". Booleans yes — but **i31 integers are 0.6 %, and heap-boxed
numbers fire literally zero times.** ToBoolean on acorn almost never sees a
number at all; it sees a boxed boolean or the `undefined` singleton. `boxnum` is
also the most expensive arm to inline (+74,674 B, a 9-instruction tail with the
`-0`/NaN test), so the intuitive arm is the worst trade on the board. Default
is therefore `anyval,boxbool`: 76.0 % of the calls for 33 % of the all-arms
byte cost. `str` and `i31` stay selectable by name; both are poor marginal
trades here (+34,685 B for 1.1 pp, +31,399 B for 0.6 pp).

**The real upstream finding is in the boolean number.** 493,911 boxed booleans
reach ToBoolean per parse while only 333,363 are *created* — so acorn tests the
same boxed flags repeatedly (parser options, `node.static`, scope flags read out
of struct slots). Inlining the test is worth 49.5 % of this helper, but the
larger prize is not boxing them: that is the value-representation lane's
(`smi-arith` / #2860), not this pass's. Reported, not built — the three files
`binary-ops-typed-dispatch.ts`, `binary-ops.ts` and `tonumber-fast-paths.ts`
are owned elsewhere and were not touched.

### Why a wrong guess cannot be a wrong answer

Same safety shape as the property cache, with one addition it did not need.

1. **The arms are not written by this pass.** `extractTruthyLadder` reads the
   emitted `__is_truthy` body at finalize and copies each arm verbatim, re-homing
   only the helper's two scratch locals. Re-deriving the ladder would have created
   a second source of truth — the `$AnyValue` arm exists only under
   `undefinedSingletonActive`, the `$AnyString` arm only when a native-string type
   is registered, and #4173's `fastStrictEq` changes how the operand is
   internalized. Any shape the extractor does not recognise declines the **whole
   pass**; it cannot copy a stale arm.
2. **The terminal `else` is the unmodified call**, so the site's answer set is
   identical to the helper's rather than a subset of it.
3. **Skipping a ladder arm is proved sound, not assumed.** The helper answers
   with the FIRST arm that tests true, so inlining arm *k* while skipping arm
   *j < k* is only correct if no value satisfies both. `mayAlias` refuses unless
   the two heap types are provably unrelated — neither in the other's declared
   supertype chain, and differing in field count/kind/mutability or in whether a
   supertype is declared at all, which is what rules out wasm's structural
   canonicalization silently merging two declarations. This is the check the
   property cache never needed (it only ever speculated on `candidates[0]`).
4. **`ref.test` is the non-null form (`0x14`)**, so `null` fails every guard and
   reaches the helper's `ref.is_null → 0`. `-0`, `NaN`, `""` and the `$undefined`
   singleton are not special-cased anywhere: they are answered by the copied arm,
   which *is* the helper (`-0` is never i31-encoded, so it reaches
   `$box_number`'s `f64.ne 0`; `""` reaches `$AnyString`'s `len != 0`;
   `undefined` is a tag-1 `$AnyValue` answered by `tag > 1`).

### The mechanism is proved live, not assumed (entry 22's lesson, applied)

- **Patch-site counter**, printed unconditionally whenever the flag is on:
  `[truthy-ic] arms=anyval,boxbool patched-sites=1643 functions=504
  declined-producer-shape=12`.
- **Poison probe** (`JS2WASM_INLINE_TRUTHY_IC_POISON=1` appends `i32.eqz` to
  every fast arm): the workload no longer returns 422 — it **throws**
  (`WebAssembly.Exception`, exit 1), because acorn's control flow inverts. With
  the IC flag OFF, `POISON=1` reproduces the baseline byte-for-byte (checksum
  422, 997,454 calls, 2,459,473 bytes), so the poison touches nothing but the
  guard chain. A null on this pass is only believable after that probe changes
  the answer.
- **Byte-identity with the flag unset**: sha256 of the acorn binary is
  `f01a62f1…7ef9` at `optimize: 0` and `bedb858f…beb7fd` at `-O4`, **identical**
  to the same builds on the base commit (file-copy A/B, no `git stash`).

### What is left on this helper

239,764 calls survive at the default arm set — receivers that are neither a
boxed boolean nor an `$AnyValue`: objects, arrays, functions and strings, which
the ladder answers from its `-> truthy` default or the `$AnyString` arm. Getting
those would mean inlining the *default*, i.e. speculating "any other non-null
ref is truthy", which is a **negative** guard over the whole remaining type
space and is exactly the shape that has measured null or worse in this file
(entries 9, 13). Not attempted.

## 2026-08-13 (24) — MEASURED END TO END: 5.83× → 5.58×, and the ceiling of this approach

Same box, same workload, same session — a real ratio, not a cross-run inference.
Box verifiably idle (load 0.27), 300 iterations, order-reversed ON/OFF/OFF/ON.

| | ms / parse | vs Node |
| --- | ---: | ---: |
| Node (V8) | **17.59** | 1.00× |
| wasm, all flags OFF | 102.55 | **5.83×** |
| wasm, all 7 flags ON | **98.19** | **5.58×** |

| bucket | ON | OFF | Δ |
| --- | ---: | ---: | ---: |
| cast-convert | 1.32 % | 6.03 % | −4.71 pp |
| dynamic-eq | 3.19 % | 6.39 % | −3.20 pp |
| dynamic-lookup | 17.55 % | 19.72 % | −2.17 pp |
| string-runtime | 3.15 % | 4.11 % | −0.96 pp |
| call-dispatch | 10.23 % | 11.04 % | −0.81 pp |
| **wall** | **29,456 ms** | **30,765 ms** | **−4.3 %** |

ON replicates to 0.5 %, OFF to 1.5 %. `__is_truthy` is the #2 frame in both OFF
blocks (3.77 %, 3.62 %) and leaves the top frames entirely in both ON blocks.

### The conversion rate, and why it is the important number

**−59.1 % of executed helper calls bought −4.3 % of wall.** The buckets shed
**11.85 pp** of share while wall moved a third of that. The mechanism:
**inline caching RELOCATES work, it does not remove it.** A `ref.test` guard
replacing a call still executes the test — it saves the call overhead and gets
attributed to `compiled` rather than to a helper frame.

This reframes the metric this issue adopted in entry (21). Counts remain the
right *deterministic* instrument — they are exact and load-immune where wall
clock on this box is neither — but they measure **calls avoided, not work
avoided**, and here those differ by roughly 3×. Quote both, and never convert
one into the other by assertion.

### The ceiling of the helper-elimination program

With everything on, helper buckets are ~35.4 % of 98.19 ms ≈ **34.8 ms**. Node
spends ~93 % of its 17.59 ms inside acorn's own code. So **eliminating every
remaining helper millisecond leaves ≈ 63 ms vs 17.6 ms — about 3.6×.**

That independently reproduces the ~3× floor derived in the 2026-08-08
cross-runtime entry, from the opposite direction: that one subtracted Node's
buckets from ours, this one subtracts our own helper time from our total.

**Parity is not reachable on this axis.** What remains here is worth perhaps
another 1–2 %. The residual 3.6× is our compiled acorn code being that much
slower than V8's JIT output for the same source: register allocation, inlining
of acorn's *own* functions, and runtime type feedback an AOT compiler cannot
obtain. That is a different program, and entry (18)/(19)'s decision — that the
IR should own inlining, because `wasm-opt` will not inline anything containing a
loop or a call, which is every function in acorn — is where it starts.

## 2026-08-13 (25) — the IR inliner is BUILT and measured. It works, it is safe, and it does NOT hit the target entry (24) named

> Ordering note: this entry answers entries (18), (19), (21) and (24), which at
> the time of writing exist only in the shared checkout's working tree and not
> on `main`. It is appended at the file's end and should be re-ordered after
> those land. Branch: `worktree-agent-add66802ffbd50fc7`. Flag default OFF; no
> PR was opened.

`src/codegen/ir-inline.ts` — `JS2WASM_IR_INLINE`, default OFF, unset ⇒ binary
**byte-identical**, verified by sha256 (`c750c6e4…` for the acorn self-parse
binary, re-confirmed after every subsequent code change, and again in `report`
mode which analyses without mutating).

### The headline, in one line

**The inliner removes 1,083,156 executed calls per acorn self-parse (−96.7 % of
the `__dc_*` adapter layer) with the workload's checksum unchanged at 422 — but
only 357 of its 8,016 admitted sites target compiled USER code, which is the
population entry (24) said the remaining 3.6× lives in.**

### The cost model as built, and what each rule fired on

Attribution is emitted by the pass itself (`by-rule <rule>:<family>`), not
inferred:

| rule | admitted | adapter | helper | user | other |
| --- | ---: | ---: | ---: | ---: | ---: |
| 3 · adapters always | 3,820 | 3,820 | — | — | — |
| 1 · loop-leaf (freq. from loop depth) | 2,379 | — | 2,003 | 331 | 45 |
| 2 · specialisation delta | 1,175 | — | 1,169 | 5 | 1 |
| — · single-caller | 642 | — | 618 | 21 | 3 |
| **total** | **8,016** | 3,820 | 3,790 | **357** | 49 |

of 48,046 direct call sites in a 3,521-function / 571,446-instruction module.

Declines, also emitted: `no-rule` 35,189 · `cold-callee` 4,297 (rule 4, all
`__new_*Error`) · `self-recursive` 334 · `unsafe:return-call` 203 ·
`unsafe:try` 6 · `unsafe:multi-result` 1.

**Rule 1 (frequency from loop nesting depth)** is `10^depth`, propagated one
step across the call graph, with the body budget scaling as
`loopMax · max(1, log10(weight))`. Stated where it appears, because a reviewer
who knows **#3927 §7 will raise its objection first**: that section abandoned
frequency-based *field* ranking because observed instance counts are a property
of the **corpus**. Loop depth is read off the **source being compiled**, so it
is a property of the **program** and remains valid for every input that program
will ever see. The objection does not reach this.

**Rule 2 (specialisation delta) is the one result that behaved exactly as
entry (19) predicted, and it is the cheapest thing in this file**: 1,175 sites
inlined for **+119 instructions in total** — 0.1 instructions per site, at
`-O4` **+134 bytes on 1.69 MB (+0.008 %)**. That is inlining whose cost is
indistinguishable from zero because the site's constant arguments fold the
callee's branches away, which is precisely the case a size heuristic cannot
see. Whether it *buys* anything is unmeasured (see "what is not claimed").

### Proof the mechanism fired — three instruments, one number

A confident null from a mechanism that never fired closes a door that was never
opened, and this file records that failure twice in one session. So:

1. **Executed-call census** (`JS2WASM_EXEC_CENSUS=__dc_`, 545 adapters
   instrumented, 177 execute): **1,120,550 → 37,394**, Δ **−1,083,156**.
2. **Runtime site counter** (`JS2WASM_IR_INLINE=adapters,count`, a global
   incremented once per executed inlined body): **1,083,156**. Exact agreement
   with (1) — two independent instruments, one number.
3. **Poison probe** (`…,poison` replaces every inlined body with `unreachable`,
   which is stack-polymorphic and therefore type-checks against any result
   type — the numeric-perturbation variant covered *zero* adapters, since they
   all return references): 3,820 sites poisoned, and the workload's answer moves
   from **422** to `RuntimeError: unreachable`.

The 37,394 survivors are **not** declines: the verbose per-callee decline list
contains no `__dc_*` at all, so all 3,820 *direct* sites were taken. They are
adapters reached through `call_ref` (dominated by
`__dc_Parser_getTokenFromCode_1`, 25,705), which a direct-call inliner cannot
see.

### It is NOT overlapping with `wasm-opt` — measured statically, post-`-O4 -g`

| | `__dc_*` functions surviving | `call $__dc_*` sites surviving |
| --- | ---: | ---: |
| `-O4` alone | 243 | 1,682 |
| IR inliner + `-O4` | **8** | **43** |

`wasm-opt` on its own leaves 1,682 adapter call sites; the IR inliner takes that
to 43 — **97.4 % of what binaryen left**. Total functions after `-O4` fall
1,320 → 1,196. Confirmed against binaryen 125's own `--help`: `-fimfs`
(default 20) applies only to callees that are "lightweight (no loops or function
calls)", and `-ocimfs` **defaults to `-1`, i.e. binaryen already inlines every
single-caller function**. That last fact is why the `single-caller` rule is the
weakest of the four and should be considered spent — the brief predicted this
and it is confirmed (3,521 → 1,320 functions, 48,715 → 20,118 `Call` nodes at
`-O4` with the inliner off).

### Size, at both levels — every row checksum 422

| config | `optimize: 0` | Δ | `-O4` | Δ |
| --- | ---: | ---: | ---: | ---: |
| base | 2,487,935 | — | 1,686,601 | — |
| specialise only | 2,497,227 | +0.37 % | 1,686,735 | **+0.008 %** |
| adapters only | 2,652,963 | +6.63 % | 1,725,467 | +2.30 % |
| all rules (`on`) | 2,891,178 | +16.21 % | 1,758,507 | +4.26 % |

Function-size distribution (IR instructions per function):

| config | total | p50 | p90 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| base | 571,446 | 28 | 376 | 1,887 | 15,790 |
| specialise | 575,069 | 28 | 376 | 1,887 | 15,798 |
| single-caller | 593,781 | 44 | 384 | 1,887 | 15,937 |
| adapters | 637,256 | 33 | 428 | 2,251 | 15,790 |
| loop-leaf | 639,283 | 32 | 410 | 2,012 | 42,925 |
| all | 726,733 | 47 | 470 | 2,344 | 43,072 |

The `loop-leaf` max (42,925) is the one number that should worry anyone: a
single function nearly tripled. Entry (19)'s "watch the size distribution, do
not pre-empt" obligation is discharged, and it says `loop-leaf` needs a
per-function ceiling before it is used for anything.

### The finding that matters more than the win

**Executed `__closure_*` (compiled user code) calls: 1,296,951 OFF →
1,257,245 ON, −39,706 (−3.1 %).**

Only **1,242 of 48,046** direct call sites target user functions at all
(357 admitted, 885 declined). Acorn's own call volume does not travel over
direct `call` edges between `__closure_*` functions; it travels
`caller → __dc_* trampoline → closure`. So an inliner that removes the
trampoline removes a real frame — the ~4 % of pure self-time entry (18)
attributed to `__dc_*` — but it leaves the user→user call itself intact inside
the inlined trampoline body.

**This bounds the slice honestly.** Entry (24) put the residual at ~3.6× and
attributed it to "our compiled acorn code being slower than V8's JIT output …
inlining of acorn's *own* functions". This pass does not do that, and the
decline data says why: user callees are big (p90 = 376 instructions),
multi-caller, and non-leaf, so every size-budget rule refuses them for the same
structural reason `-fimfs` does. Inlining acorn's own functions needs a
different admission argument than any of the four rules here — the honest
candidates are partial inlining (hot prefix only) or specialisation on a
receiver *type*, not on a constant.

### What is NOT claimed

**No wall-clock number, deliberately** — timing is serialised on this box and
was out of scope for this run. Entry (24) is the reason that matters rather
than being an excuse: **−59.1 % of executed helper calls bought −4.3 % of
wall**, because inline caching relocates work instead of removing it. The same
discount applies here, and a −1.08 M call figure must **not** be converted into
a wall claim by assertion. The upper bound from entry (18)'s self-time
attribution is ~4 % of runtime for the whole `__dc_*` bucket; the plausible
realisation is a fraction of that, against **+2.30 % of `-O4` binary size**.
Somebody with an idle box should measure `JS2WASM_IR_INLINE=adapters` at `-O4`
order-reversed before this goes anywhere near a default.

### Correctness

- acorn self-parse checksum **422** for every configuration measured, at
  `optimize: 0` and `-O4`.
- `tests/dogfood/acorn.test.ts` with `DOGFOOD_ACORN=1` (the real
  compile→validate→AST-diff loop): passes flag OFF and flag ON.
- Equivalence: all 212 files under `tests/equivalence/`, batched 35 at a time
  (`--pool=forks --poolOptions.forks.maxForks=2` — the full suite OOMs here),
  run twice. **13 failing tests, and the failing set is byte-for-byte identical
  ON and OFF** — same tests, same per-file counts (`arguments-nested-and-loops`,
  `array-inline-return`, `delete-sentinel`, `logical-conditional-identity`,
  `misc-small-patterns`, `new-non-constructor`, `null-dereference-guards`,
  `optional-direct-closure-call`, `reflect-api`, `tdz-reference-error`,
  `yield-as-expression`). All pre-existing on `origin/main`; zero attributable
  to the inliner.
- `tests/issue-4157-ir-inline.test.ts` pins the constructs the rewrite can get
  wrong — closure captures, recursion, early `return` from a nested block,
  loop-carried `break`/`continue`, `this`-binding through a method call, and a
  constant-argument site sharing a callee with a non-constant one — by VALUE,
  ON and OFF, plus the unset-flag and `report`-mode byte-identity assertions.

### Two bugs found in my own pass, both worth recording

1. **A shallow `f.body` snapshot made the pass silently iterative** in
   `mod.functions` order: A inlined into B, then the already-inflated B into C.
   Not unsound, but order-dependent and unbudgetable — and it cost **243,492
   instructions where single-level costs 137,072**, i.e. 78 % of the growth was
   a transitive effect nobody asked for. The snapshot is now a deep clone.
2. **Folding a constant `if` down one structured level rewrites the meaning of
   every branch that escaped the arm** — `br 0` that meant "leave the if" comes
   to mean "leave the enclosing block". That is a silent miscompile, not a size
   regression. Guarded by `escapesRegion`. (It never fires on acorn: the
   binary is bit-identical with and without the guard. It is a net, not a
   behaviour change — which is exactly when this class of bug ships.)

Declined by construction, each because the wasm-level rewrite is not sound for
it: `return_call`/`return_call_ref` (a tail call returns from the *enclosing*
frame; rewriting to `call`+`br` is semantically right but converts a
constant-stack tail call into a growing one), `try`/`rethrow`, multi-result
callees (the wrapper block would need a `[] -> results` functype that may not
exist), and direct self-recursion.

## 2026-08-13 (26) — the four redundant caller-side flattens, deleted

The lazy-flatten slice reported, but did not build, that **1,664 of the remaining
`__str_equals` feeders are all emitted by `binary-ops-typed-dispatch.ts`** — the
equality cascade (~959/962) and the mixed-externref strict-equality arm
(~261/264) — and that the four `{ op: "call", funcIdx: flattenIdx }` entries
behind them can be deleted outright. Built now, under the existing
`JS2WASM_LAZY_STR_FLATTEN` flag via that slice's own `redundantFlattenCall`.

**The claim needed checking before acting, and nearly failed.** The report said
`__str_equals` "takes `ref $AnyString`", while `native-strings-basics.ts:437`
documents it as `__str_equals(a: ref $NativeString, b: ref $NativeString)`. If
the latter were the emitted signature, deleting the flattens would feed an
`$AnyString` to a `ref $NativeString` parameter — a validation failure.

It is not. `native-strings-shared.ts:69` defines
`strRef = { kind: "ref", typeIdx: anyStrTypeIdx }` with the comment *"used in
all helper function signatures (params and results)"*, and
`wrapBodyWithFlatten` gives each helper its own guarded preamble. The `:437`
comment is the **logical** contract, not the emitted one. The report was right;
the documentation is what disagrees.

### Result

| | OFF | lazy-flatten only | **+ this** |
| --- | ---: | ---: | ---: |
| `__str_flatten` | 516,717 | 421,019 | **252,367** |
| `__str_equals` | 254,976 | 254,976 | 254,976 |

**−168,652 further calls, −264,350 against baseline (−51.2 %)**, checksum 422,
and the binary is **smaller** (2,478,636 vs a 2,537,596 flags-off baseline).
Byte-identical with the flag unset.

`__str_equals` is unchanged, as expected — this removes flattens, not equality
calls. The gain is larger than the site count suggests because the preamble
`wrapBodyWithFlatten` installs sits **above** `__str_equals`'s `ref.eq`, length
and hash rejects: a pre-flattening caller guarantees the helper never reaches
the skips it exists to take. Removing the caller-side call restores them.

## 2026-08-13 (27) — `__extern_get` static-name IC: RESCUED, UNFINISHED, does not yet fire

**Status: incomplete. Do not read the presence of this code as a working
optimisation.** It is committed flag-gated OFF and byte-identical when unset so
that 479 lines of work survive; it currently patches **zero** sites.

The agent building it was killed by a session restart before committing or
reporting. Its files existed only as **untracked** files in an ephemeral
worktree — the same loss pattern recorded in the 2026-08-07 handoff, where two
branches had to be rescued the same way. Recovered, wired, and diagnosed here.

### What it is meant to do

`__extern_get` runs **506,752 times per parse** and has not moved by a single
call across seven attempts, while everything around it fell 66–100 %. Its
per-key cache already serves **87.24 %** of those calls, so the target is not a
better cache but **removing the call** at *static-name* sites, where the key is a
compile-time constant and the key `ref.test`/`ref.cast`/hash-load are provably
unnecessary. `extern-get-inline-ic.ts` copies the cache-hit arm out of the
emitted helper and splices it at the site, with the unmodified call as the miss
arm — the shape that worked three times (`member-get-inline-ic`,
`is-truthy-inline-ic`, `smi-box-fast-path`).

### Two defects found while rescuing it

1. **FIXED — helper lookup by index arithmetic.** It resolved the helper as
   `ctx.mod.functions[getIdx - ctx.numImportFuncs]`. `ctx.funcMap` holds
   **mint-time handles** (import-space at registration, before dead-import
   elimination), not final list positions, so this landed on an unrelated
   function and the pass took a **silent** early return — flag ON produced a
   byte-identical binary, which reads exactly like "the optimisation does
   nothing". This is the trap `alloc-census.ts` already records: *"recomputing
   final index from list position matched zero of 261k measured calls."*
   Replaced with the by-name lookup every other finalize fill uses.
2. **OPEN — the arm extractor refuses.** With the lookup fixed it reports
   `REFUSED: __extern_get body is not the cache-arm shape
   (prefix-not-key-load)`. Its own placement comment names the cause: the arm it
   copies must be the **first** thing in `__extern_get`, and later fills
   (`fillDynamicForinVecArms`, `fillObjVecReflectionHelpers`) unshift ahead of
   it. The pass is currently wired after `inlineUserFunctions`, which is the
   wrong point in the finalize order. **Fixing this is finding the slot where
   the cache arm is still the prefix** — read the placement contract in the
   file header first.

### Worth knowing before resuming

- The refusal is **loud and specific**, which is the design working — it declines
  rather than half-copying an arm it does not recognise. Contrast defect 1,
  which was silent and therefore far more dangerous.
- Before claiming any result, use the `JS2WASM_EXTERN_GET_IC_POISON=1` probe the
  agent already built: corrupt the fast arm and confirm the workload's answer
  moves off checksum 422. Two confident nulls in this issue were changes that had
  never been enabled.
- Expected value, stated honestly: even **total** elimination of `__extern_get`
  is worth ~8 % of runtime, and entry (28) measures call-removal converting to
  wall time at roughly **1:7**. This is a low-single-digit-percent lever against a
  ~6.7–7.7× gap. It is the largest remaining helper population, not a path to
  parity.

## 2026-08-13 (29) — MORE FLAGS IS SLOWER: the set needs selecting, not maximising

Asked to "just switch on ALL the flags and measure". The result inverts the
expectation and is the most actionable finding of the session.

| config | wasm ms | Δ vs OFF | binary @ `optimize: 0` |
| --- | ---: | ---: | ---: |
| tuned 8 flags | 93.67 | **−8.75 ms (−8.5 %)** | +134 KB |
| **all 10 at maximum** | 87.49 | **−1.65 ms (−1.9 %)** | **+970 KB (+39 %)** |

Both order-reversed ON/OFF/OFF/ON on an idle box. **At maximum settings the
effect (1.65 ms) is smaller than the ON blocks' own spread (4.13 ms) — it is not
resolvable.** The improvement is statistically indistinguishable from zero.

Deterministic counts kept improving in the same run: **−4,409,124 executed calls,
−69.6 %**, the best figure recorded here. So this is a clean, measured instance of
**call reduction and wall time diverging** — the binary grew 39 % and
instruction-cache cost consumed the gains.

### The two culprits

- **`JS2WASM_INLINE_TRUTHY_IC=all`** turns on six arms, but entry (23) measured
  `boxnum` and `bigint` firing **zero times** on acorn while costing +74 KB and
  +47 KB respectively. Maximising the flag enables arms already known never to
  fire. `=1` (the two-arm default: `boxbool` + `anyval`, 75.9 % of the available
  reduction) is the operating point.
- **`JS2WASM_FNCTOR_CTOR_PARAM_SLOTS=1`** is a **pre-existing flag unrelated to
  this work**, swept in by enumerating every `JS2WASM_*` in the touched files. It
  contaminates the comparison and should not have been in the ON set.

### What this confirms that was previously only asserted

Two caveats recorded earlier said size has a cost, without testing it. This
tests it:

- entry (22)'s `INLINE_PROP_IC` ceiling curve — 8.7 % of calls for +38 KB at
  ceiling 1 versus 66.1 % for +107 KB at ceiling 8;
- entry (25)'s `IR_INLINE` `loop-leaf` rule taking max function size
  15,790 → 43,072.

Both are the same phenomenon this measurement makes visible in wall time.

### The measured optimum

`INLINE_PROP_IC=8`, `INLINE_TRUTHY_IC=1` (**not** `all`), `IR_INLINE=on`,
`FUSED_TONUMBER=1`, `SMI_FASTPATH=all`, `LAZY_STR_FLATTEN=1`,
`ELIDE_PROVEN_NONNULL_TYPEERROR=1`, `INLINE_HINTS=1` — **−8.5 %**.

Anyone flipping defaults should start from that set and re-derive it per corpus,
because the optimum is a *selection*, not a maximum. And the per-flag numbers in
this file are all measured with the other flags OFF, so they do not compose
additively — the size costs do.

## 2026-08-13 (30) — fresh look at the flags-on binary: the "compiled residual" decomposes into three named defects

Dissected the emitted code for **one hot JS statement** — `this.lastTokEnd =
this.end` in `pp.next` — with the tuned flag set ON. V8's post-IC output for
this statement is two moves. Ours is ~100+ instructions, and the excess is not
JIT magic we lack; it is three specific code-quality defects, each quantified
against the whole binary:

| | defect | scale |
| --- | --- | ---: |
| **A** | **`this` is re-resolved per operand.** A ~15-instruction ladder — `global.get`, null test, undefined-singleton substitute, `ref.test`, sentinel `ref.eq` — emitted once per member operand, for a value that cannot change within the function. | **5,974 ladders** |
| **B** | **Typed reads, boxed writes.** The get side has 19 `__get_member_*__f64` twins; the set side has **zero**. Every numeric write goes f64 → i31-range check (~20 instr) → box → `__set_member_*(externref, externref)` → unbox → f64 slot. | 424 dispatchers, **344,602 calls/parse** |
| **C** | **No redundancy elimination between ICs.** Consecutive inlined ICs re-do `any.convert_extern` + `ref.test` on the same receiver; three consecutive `this.lastTokX = this.X` statements pay six type tests of a value whose type cannot change between them. | 6,723 `ref.test` of one struct type alone |

Also newly measured: the write/dispatch populations nothing has touched —
`__set_member_*` 344,602, `__call_m_*` 103,651, `__call_fn_method_*` 76,827,
`__named_this_call_*` 32,468 = **560,056 executed calls/parse**.

**Why this matters more than another helper slice:** these defects live in the
`compiled` bucket — the ~40 % that was being written off as "register
allocation, inlining and type feedback an AOT compiler cannot obtain".
`this.lastTokEnd = this.end` needs **no type feedback**: both sides are
statically fields of the same known struct. A, B and C are all fixable ahead of
time — receiver CSE (hoist `this` resolution to one local per function), a
`__set_member_<name>__f64` twin symmetric to the existing get twin, and reusing
the IC's cast result across adjacent same-receiver ICs.

## 2026-08-13 (31) — the `__extern_get` IC COMPLETED: −87.2 %, the seventh attempt finally moves it

The rescued pass is finished. One character was the whole runtime bug, and the
diagnosis route is worth keeping: `wasm-dis` on the invalid module showed a
phantom `local.set $scratch` / `drop` pair reconstructed around the patched site
— the signature of an extra value stranded on the stack. The site rewrite
emitted `local.tee` for the receiver capture (per its own header sketch), which
stores AND leaves the value on the stack under the block result. `local.set` is
the fix; the sketch carried the bug into the implementation.

### Results (flag `JS2WASM_EXTERN_GET_IC=1`, still default OFF)

| | value |
| --- | --- |
| sites patched | **964 of 975** static-key (11 declined on producer shape; 456 computed-key untouched) |
| `__extern_get` executed | **506,752 → 64,691 (−87.2 %)** — exactly the cache hit rate of entry (14) |
| `__obj_find` / `__obj_hash` | unchanged (miss-path work, as expected) |
| poison probe | flag+poison kills the workload; flag alone returns 422 — the fast path serves real hits |
| binary | +159,680 at `optimize: 0` (+6.3 %); **+105,386 (+6.2 %) at a completed `-O4`** |
| flag-off | byte-identical, 2,537,596 / 422 |

Correctness: dogfood acorn 4/4 with `DOGFOOD_ACORN=1`; the 64-name differential
**IDENTICAL ON vs OFF in BOTH read paths** (computed and named — hashes,
presence counts, node counts); property/object equivalence 308/310 with the same
2 `new-non-constructor` failures flag-off and on `origin/main` (pre-existing).

### Found underneath: `wasm-opt` times out SILENTLY and ships unoptimized output

The first `-O4` size reading was +961 KB (+57 %). False: `src/optimize.ts` runs
the `wasm-opt` CLI with `timeout: 60_000`, the IC'd module pushes `-O4` past
60 s, `execFileSync` throws, and the pipeline returns `{ binary, optimized:
false, warning: … }` — **and the perf lane never surfaces the warning**. Running
`wasm-opt -O4` manually on the same output: 2,647,615 → 1,792,005, i.e. the true
cost is +6.2 %.

Consequences:

- **Entry (29) is partly confounded.** The "all flags at maximum" wall-clock
  regression was attributed to instruction-cache pressure from +970 KB; some or
  all of those measured binaries may have been silent unoptimized fallbacks,
  which would produce the same signature. The tuned-vs-max comparison should be
  re-run with the timeout raised or the `optimized: false` warning asserted
  before the icache story is quoted again.
- **Any heavy-flag measurement is suspect until the lane prints the warning.**
  A 60 s cap on a 2.5 MB module at `-O4` is tight even without flags.
- The IC itself remains default OFF: +6.2 % size for the largest single call
  reduction of the programme (−442,061) is a defensible trade, but per entry
  (29) the wall verdict must be measured with a *completed* `-O4`, not assumed
  from counts.

## 2026-08-13 (32) — flag inventory: there is no dormant stash

Question asked: has anyone ever switched on ALL default-off flags? Answer: no —
and a full inventory says there is little to switch. Of 104 non-diagnostic
`JS2WASM_*` flags in `src/`, **51 are kill-switches for features already
default-ON** — the compiler ships with essentially its whole optimisation
surface enabled. The genuinely dormant opt-ins beyond this session's eight:

- **`JS2WASM_IR_ESCAPE` / `JS2WASM_IR_OWNERSHIP` / `JS2WASM_IR_I32_DOMAIN`** —
  measured together just now: **−727 bytes, checksum 422, zero movement on any
  hot helper count**. Analyses with (almost) no consumers, exactly the #743
  "derive always; consumers arrive later" story.
- `JS2WASM_TS7` — alternate TypeScript backend; compile-time, not runtime.
- `JS2WASM_FNCTOR_PAD_SLOTS` — adds padding; an experiment, not a win.
- `JS2WASM_FORCE_DYN_*`, `JS2WASM_NO_DYNPROTO`, `JS2WASM_DISABLE_STRING_PRESIZE`
  — pessimizer/test hooks.

So the flag frontier IS this session's tuned set; there is no forgotten
performance flag waiting. Combined with entry (29) (maximising the tuned set is
itself a regression, timeout confound pending), flag-flipping as a strategy is
exhausted.

## 2026-08-13 (33) — the `compiled` bucket, first two slices: defect B is a call-count win, defect A is a CODE-SIZE win, and B's real finding is why the naive CSE is wrong

First work against the `compiled` residual named in entry (30). Both slices are
behind flags, DEFAULT OFF; with the flags unset the standalone acorn binary is
sha256-identical to the pre-change build
(`d70f9e3a7099d4997fcc5ebb3f7a25fe502c752d3edfc0731b526ef6ea80879c`, 2,487,935 B,
checksum 422).

The instrument entry (21) introduced (`src/codegen/exec-census.ts`) is not on
`main`; the function-entry census was rebuilt here inside `alloc-census.ts`
(`JS2WASM_EXEC_CENSUS=<substr>,…`, one exported counter per matched DEFINED
function, incremented by a stack-neutral prologue). It reproduces entry (21)'s
numbers to the call — `__box_number` 489,166, `__unbox_number` 883,318 — and
entry (30)'s `__set_member_*` 344,601, which is what validates it.

### Slice A — `JS2WASM_SET_MEMBER_F64`, the write-side f64 twin

`__set_member_<name>__f64(recv: externref, v: f64)`, symmetric with #3673's get
twin: same reserve-then-fill discipline, same candidate list in the same order,
a direct `struct.set` (plus the #3780 presence bit) for an f64 slot, and the
generic dispatcher as the delegate for everything else — which is also how the
#3927 cold-tail / layout / resid arms and the sidecar terminal stay covered
without re-deriving them. `src/codegen/member-set-f64.ts`.

| | baseline | slice A | Δ |
| --- | ---: | ---: | ---: |
| `__box_number` | 489,166 | 401,521 | **−87,645 (−17.9 %)** |
| `__unbox_number` | 883,318 | 783,197 | **−100,121 (−11.3 %)** |
| `__set_member_*` (all) | 344,896 | 344,911 | +15 |
| binary @ `optimize: 0` | 2,487,935 | 2,491,828 | +3,893 (+0.16 %) |
| binary @ `-O4` | 1,686,619 | 1,688,025 | +1,406 (+0.08 %) |

414 write sites patched, 23 dispatchers, 35 direct f64 arms. **83,780 of the
executed writes moved to a twin and only 15 delegated** — so the direct arm is
what runs, not the fallback. `lastTokEnd` and `lastTokStart` (41,890 each)
convert 100 %; `potentialArrowAt` 3,725, `parenthesizedAssign` 3,519,
`trailingComma` 3,442, `awaitPos`/`yieldPos` 1,888 each follow.

Two things the numbers say that the plan did not predict:

- **`__unbox_number` falls by MORE than `__box_number`** (100,121 vs 87,645).
  The extra is the assignment's own RESULT: leaving it as f64 instead of a boxed
  externref also removes the consumer-side unbox. The twin count
  (≥103,961) is in turn LARGER than the box reduction, because a
  constant-valued numeric write (`this.awaitPos = 0`) was already box-free —
  the const-box hoist of entry (14) had taken it.
- **`this.end` does NOT convert, and cannot be made to by this slice.** Its
  32,468 executed writes live in `finishNode`-shaped code where the value is a
  PARAMETER typed `any`, so it is an externref at the write. The remaining
  write-side gap is a TYPING problem upstream of the write, not a dispatch
  problem at it.

### Slice B — `JS2WASM_RECEIVER_CSE`, hoisting the `this` ladder

Reuse a resolved `__current_this` within one straight-line instruction sequence
instead of re-running the ~15-instruction ladder per member operand.
`src/codegen/receiver-cse.ts`.

| | baseline | slice B | Δ |
| --- | ---: | ---: | ---: |
| binary @ `optimize: 0` | 2,487,935 | 2,404,901 | **−83,034 (−3.34 %)** |
| binary @ `-O4` | 1,686,619 | 1,645,876 | **−40,743 (−2.42 %)** |
| executed calls | — | — | **0** |

2,610 ladders emitted, **1,985 reused** — 43 % of the 4,595 `this` operands in
the standalone build. **This slice is invisible to the executed-call census by
construction**: the ladder is inline code, not a call, so `JS2WASM_EXEC_CENSUS`
reports zero change and the honest metric is code size. Anyone extending entry
(21)'s "counts are the verdict" rule to this class of change will measure
nothing and wrongly conclude it did nothing.

### The load-bearing finding: `fctx.body` is NOT append-only

The obvious cache key is the instruction ARRAY: a Wasm array is entered at the
top and flows down, so an earlier instruction dominates every later one in it,
and an emitter that builds branch arms by swapping `fctx.body` to a detached
array gets dominance for free with no analysis. **That reasoning is wrong on
this codebase, and the acorn self-parse proves it: with the naive rule the parse
throws.**

Bisecting the reuse count (`JS2WASM_RECEIVER_CSE_LIMIT`, `…_TRACE`) localises it
to exactly one reuse — the 1,412th, in `__closure_528` — whose trace reads
`gap=-5`: the recorded position is PAST the current end of the array. The array
had SHRUNK. About eight emitters relocate an already-emitted range out of
`fctx.body` with `fctx.body.splice(start)` (expressions.ts' async rejection
wrap, array-methods' guard arms, char-at-transfer's deferred position), which
moves a `local.tee` into a conditional arm where it no longer dominates what is
emitted next. The local's default is `ref.null.extern`, so the failure is a
silent wrong `this`, not a validation error.

The fix is to re-verify the precondition at every lookup: the `tee` instruction
OBJECT must still be at the index it was left at. A relocation then costs a
reuse (20 of 2,005 on acorn), never correctness. **Any future value-numbering /
CSE work in this emitter needs this guard or an equivalent — "same array" is not
"same basic block" here.**

A second hypothesis was tested and REJECTED on the way: that `__current_this`
was being clobbered between the two reads. Restricting reuse to pairs with no
intervening call at all (282 of 2,005) still failed, which rules the clobber out
and is what pointed at relocation.

### Correctness

Checksum 422 on every configuration (A, B, A+B, both flags off). Poison probes:
corrupting slice A's fast arm (`v + 7` into the slot) crashes the parse in
`getLineInfo`; replacing slice B's cached read with `ref.null.extern` throws —
both mechanisms demonstrably EXECUTE, they are not merely emitted. The 64-name
per-field differential is clean — 0 hash divergence, 0 presence divergence, 32,506
nodes — in **both** read paths (`computed`, `named`), at default K and `K=0`, for
A (4 points), B (4 points) and A+B (2 points). `DOGFOOD_ACORN=1
tests/dogfood/acorn.test.ts` passes with both flags on (110 sites patched, 2,101
reuses inside that lane). 31 property/object/numeric/assignment equivalence files
(192 tests) pass with both flags on.

Wider: the first half of `tests/equivalence/` (106 files, 824 tests) gives
**3 failed / 818 passed / 3 todo with both flags ON and the identical 3 failed /
818 passed with both flags OFF** — same three files
(`arguments-nested-and-loops`, `array-inline-return`, `delete-sentinel`), and
each also fails with every touched file restored to its `HEAD` blob, so all
three are **pre-existing on `origin/main`**. So is
`optional-direct-closure-call.test.ts` (2 tests), from the closure/method
batch. (Attributed by file copies; `git stash` is a single shared stack across
worktrees.) The SECOND half OOMs at `maxForks=2`, as this container's notes
predict — that half is not evidence either way.

Coverage caveat worth stating: the equivalence snippets exercise slice A (twins
reserved and filled) but reuse **zero** receivers for slice B — its ladders are
emitted, never shared, because single-statement snippets have no repeated `this`.
Slice B's correctness evidence is the acorn dogfood (2,101 reuses) and the eight
per-field differentials, not the equivalence suite.

### Composition, and what to do with these two

A and B compose: A+B is 2,408,806 @ `optimize: 0` and 1,647,274 @ `-O4`, i.e.
B's size win minus A's size cost, with A's call reductions intact and unchanged
by B. Per entry (29), a flag set is a SELECTION, not a maximum — B pays no size
and belongs in any set; A buys 187,766 fewer executed calls for +3.9 KB, which is
a far better ratio than the arms entry (29) found to be net-negative, but it has
not been wall-clocked and should not be defaults-flipped on a size argument
alone.

The three defects of entry (30) are now one measured, one measured, one open: A
(typed writes) is a call-count win capped by the upstream typing gap `this.end`
shows; B (receiver re-resolution) is a code-size win with a reusable structural
lesson; **C (no redundancy elimination between adjacent ICs) is untouched, and B's
relocation guard is the thing it will need first.**

## 2026-08-13 (34) — the definitive wall measurement: **−12.0 %**, tuned-11, completed `-O4`

The session's closing measurement, designed to answer entries (29) and (31) at
once: order-reversed ON/OFF/OFF/ON on the lane, with `optimize.ts`'s `wasm-opt`
timeout temporarily raised (file-copy A/B, restored after) so **no block could
silently ship an unoptimized fallback** — the confound entry (31) exposed.

ON = the tuned eight **plus** the three slices landed since:
`JS2WASM_SET_MEMBER_F64`, `JS2WASM_RECEIVER_CSE`, `JS2WASM_EXTERN_GET_IC=1`.

| block | wasm ms | node ms | ratio |
| --- | ---: | ---: | ---: |
| onA | 98.45 | 15.68 | 6.28× |
| offA | 104.59 | 13.72 | 7.62× |
| offB | 109.48 | 13.52 | 8.10× |
| onB | 90.02 | 12.77 | 7.05× |
| **ON mean** | **94.23** (spread 8.44) | | |
| **OFF mean** | **107.03** (spread 4.89) | | |

**−12.80 ms, −12.0 % — the largest wall improvement recorded in this issue**,
and the effect exceeds both within-group spreads. The ratio moves ~7.9× → ~6.6×,
quoted as ranges because the Node baseline still swings 12.8–15.7 ms between
blocks.

What changed since the −8.5 % of entry (28): the write-side f64 twin, the
receiver CSE (which *shrinks* the binary), the extern-get IC (−87.2 % of the
hottest helper's calls), and — likely material — a genuinely completed `-O4` on
every ON block. This also closes entry (29)'s question: with the timeout
confound removed and the never-firing truthiness arms left off, adding
well-chosen flags helps; the earlier "more is slower" was a mix of genuinely
harmful arm maximisation and silent unoptimized fallbacks.

Cumulative session arc on this lane, all order-reversed: ~7.7–8.1× → **~6.6–7.1×**.
Not parity; the remaining program is entry (30)'s defect C (cross-IC guard
reuse), partial inlining of user functions, and receiver-type specialisation.

## 2026-08-13 (35) — defect C BUILT: cross-IC guard reuse, −829 static type tests and 319,847 executed reuses, for −0.17 % size

Entry (30)'s third defect, behind `JS2WASM_IC_GUARD_REUSE`, DEFAULT OFF.
`src/codegen/ic-guard-reuse.ts`, consumed by `member-get-inline-ic.ts`.

### The design decision, and why option 2 was not available

The brief offered two shapes: a finalize-time window pass, or extending
emission-time receiver-CSE (entry 33) to also cache the post-`ref.cast` typed
value. **Option 2 is structurally impossible, not merely worse.** `ref.cast $S`
does not exist at emission time — the struct candidate set is only COMPLETE at
finalize, which is the entire #2674 argument for making the IC a finalize pass.
At emission a dynamic member read is a plain `call $__get_member_<name>` with no
type to cache. So option 1 was forced.

What made it safe is that entries (9)/(13)'s "re-derive dominance on linear
wasm" problem does not arise here: the pass rewrites ONE instruction array at a
time by strictly appending to a fresh `out`, and a wasm array is entered only at
the top, so an earlier instruction dominates every later one in it. That is
receiver-CSE's original (naive) argument — which failed there **only** because
`fctx.body` is spliced during EMISSION. After emission nothing splices. The
relocation probe is carried anyway, in receiver-CSE's exact form (`out[at-1]`
must still be the recorded `tee` OBJECT), where it does a second job: it is what
makes the pre-scan's prediction unfalsifiable, since a leader the pre-scan
predicted may still be declined at emission.

### Two things that were NOT obvious and are the difference between 0 and 829

- **Keying on the local index finds almost nothing (388 reuses).** The emitter
  copies the receiver into a fresh local per statement (`local.set $85
  (local.get $7)`, `$86`, …) and routes each site through its own
  `any.convert_extern ; local.tee $92 ; extern.convert_any` round trip, so six
  reads of one `this` present six different locals. Locals are therefore tracked
  by VERSIONED VALUE IDENTITY: a modelled copy propagates the source's id, any
  unmodelled write mints a fresh one — which also subsumes invalidation, because
  an id is never resurrected. Modelling only ONE conversion direction loses the
  chain at its first hop; both directions are needed (388 → 586).
- **Scope is dominance, not array identity** (586 → 829). A nested body is
  dominated by everything preceding its parent instruction, so a child array
  inherits a copy of the state; a parent never inherits from a child (a
  conditional arm's guard does not dominate what follows the `if`) and siblings
  never see each other. **Two re-entry shapes break that reading and are the one
  real trap here:** a `loop` back edge re-enters the body after later body
  instructions ran, and a `catch` body is entered from anywhere in the try
  body — in both, a receiver reassigned in between would be tested with the
  stale guard. Both are handled by clobbering the subtree's write set on the way
  in. `tests/issue-4157-ic-guard-reuse.test.ts` pins this: with the clobber
  removed the fixture answers WRONG against the native-Node oracle.

### Results (tuned-11 as the base, i.e. all of entry (34)'s ON set)

| | flag OFF | flag ON | Δ |
| --- | ---: | ---: | ---: |
| binary @ `optimize: 0` | 2,680,957 | 2,678,693 | −2,264 (−0.08 %) |
| binary @ completed `-O4` | 1,324,402 | 1,322,110 | −2,292 (−0.17 %) |
| static `ref.test` @ `optimize: 0` | 35,214 | 34,385 | **−829** |
| static `ref.cast` @ `optimize: 0` | 49,292 | 48,463 | **−829** |
| static `ref.test` @ `-O4` | 20,990 | 20,559 | −431 |
| static `ref.cast` @ `-O4` | 21,399 | 20,968 | −431 |
| **executed reuses / self-parse** | — | **319,847** | (identical at `-O4`) |

469 leaders, **829 reuses of 4,301 patched sites (19.3 %)**; 12 sites had an
unkeyable producer, 3,460 were simply the first read of that value in their
scope. `declined-relocated=0` — the probe never had to fire.

Two readings worth keeping:

- **`wasm-opt` already finds about half of it.** 829 static removals at
  `optimize: 0` become 431 at `-O4`, so binaryen's own redundancy elimination
  would have taken the rest. The 431 that survive are ones it does not find, and
  the executed count is unchanged by `-O4` (319,847 either way), so the sites do
  survive optimisation and do run.
- **Size is the wrong headline and the executed count is the right one.** Like
  slice B of entry (33) this removes inline instructions, not calls, so
  `JS2WASM_EXEC_CENSUS` is blind to it; the counter added here
  (`JS2WASM_IC_GUARD_REUSE_CENSUS=1`, one exported `i32`) is what converts a
  static claim into a dynamic one. 319,847 executed reuses each drop a
  `local.tee` + `ref.test`, and on the hit path a `ref.cast` as well — for scale,
  `__is_truthy` is 997,454 calls and `__extern_get` 506,752.

### Correctness

Flag unset ⇒ **sha256-identical**: `2a3aa6ad…` with no flags at all, `4a1cda96…`
on tuned-11 — the latter reproduced with `JS2WASM_IC_GUARD_REUSE_POISON=1` also
set, so the poison is provably inert flag-off. Flag ON: census checksum 422;
**poison ON kills the parse with `RuntimeError: dereferencing a null pointer`**,
so the reused cast is genuinely executed and not merely emitted. The 64-name
per-field differential is clean in BOTH read paths (`computed` and `named`): 0
hash divergence, 0 presence divergence, 32,506 nodes, body 422.
`DOGFOOD_ACORN=1 tests/dogfood/acorn.test.ts` 4/4 with the flag on (621 reuses in
that lane). 34 property/object/member/numeric/assignment equivalence files
(216 tests) all pass with the flag on — **zero failures, so nothing to
attribute**; but note those snippets reuse essentially nothing (single-statement
programs have no repeated receiver), so the acorn dogfood and the differentials
are the real evidence, exactly as entry (33) found for slice B.

Gates: loc/func budget, oracle-ratchet (+0), pushraw, coercion-sites,
stack-balance, any-box-sites, lint, prettier, `tsc` all clean. `check:godfiles`
fails on `object-runtime.ts` / `array-methods.ts` — pre-existing on this branch,
confirmed by restoring the touched file to its `HEAD` blob (file copies; `git
stash` is a single shared stack across worktrees).

### What is left of defect C

Only the member-get IC participates. The other two ICs guard different
predicates — `extern-get` on a key-global hash plus its own receiver
classification, `is-truthy` on OPERAND type — so there is no shared guard to
reuse between them; "cross-IC" here means between consecutive member-get caches,
which is where entry (30) counted the `ref.test`. The write side is untouched
and is the bigger remaining population: `__set_member_*` is 344,602 executed
calls that each re-test the receiver INSIDE the callee, and no inline cache
exists for it at all. That, not more reuse on the read side, is where the next
increment of this defect lives.

## 2026-08-13 (36) — PR #4455 parked on a PROVEN flake; and every park is currently blind

The follow-up PR took an `auto-park-bot:merge-group-failure` hold at 17:22Z,
**before** the defect-C commit and the defaults flip were on it. Shepherd
diagnosis, verified causally rather than statistically:

- The queued snapshot (head `fe20764`) differs from its content-current
  merge-base in exactly two places:
  `plan/issues/4403-function-body-valueof-object-arith-compile-failure.md` and 14 lines inside
  `optimizeWithSystemBinary` — code reachable only under `options.optimize`,
  which the test262 harness never sets (zero matches in `tests/test262*`). The
  compiler on the validated path is behaviourally identical to baseline.
- The failure is exactly **1 regression, net −1 (33,031→33,030), category
  "other", wasm-hash changed** — the same cross-run-nondeterminism class as the
  360–531 same-SHA canary flips the report itself documents, on a path outside
  the 932-entry quarantine manifest.
- The parked snapshot is also moot: it predates the content that will actually
  merge, so re-validating it as-is answers nothing.

**Plan (per the auto-park protocol's flake determination):** hold stays ON until
the defaults flip lands on the branch; then remove it ONCE so `auto-enqueue`
re-admits, and the merge group validates the real final content. No re-enqueue
loops.

### CI defect worth its own issue when allocation is healthy: parks are BLIND

The regressed test's **path is unrecoverable from the park**: `--quiet`
suppresses paths in the diff (`scripts/diff-test262.ts:1811`), and the
detail-report step that would name them **crashes** (`ENOENT open ''` — its
`$META_ARGS` from a prior step is empty in that step's environment). So every
auto-park currently tells the shepherd *that* something regressed but not
*what*, forcing exactly the artifact-archaeology this diagnosis needed. Fixing
the empty-`META_ARGS` hand-off (or dropping `--quiet` in the park path) makes
every future park self-describing.

## 2026-08-13 (37) — DEFAULTS FLIPPED: the tuned eleven ship ON, and the byte-identity guarantee inverts

Project-lead decision on entry (34)'s **−12.0 %**: the eleven flags below are
now the compiler's default. The token rule and the whole table live in
`src/perf-flags.ts`; every per-pass module delegates to it rather than
re-implementing a parse, for the reason `derivation-flags.ts` gives — three
copies of a parse drift, and a parse is what "unset ⇒ ON" turns a literal
comparison into.

| flag | default when unset | how OFF is spelled |
| --- | --- | --- |
| `JS2WASM_INLINE_PROP_IC` | `8` | `0` |
| `JS2WASM_INLINE_TRUTHY_IC` | `1` (`anyval,boxbool`) | `0` |
| `JS2WASM_IR_INLINE` | the `on` preset | `0` |
| `JS2WASM_FUSED_TONUMBER` | on | `0` |
| `JS2WASM_SMI_FASTPATH` | `all` | `0` |
| `JS2WASM_LAZY_STR_FLATTEN` | on | `0` |
| `JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR` | on | `0` |
| `JS2WASM_INLINE_HINTS` | `1` (the `cold` profile) | `0` |
| `JS2WASM_SET_MEMBER_F64` | on | `0` |
| `JS2WASM_RECEIVER_CSE` | on | `0` |
| `JS2WASM_EXTERN_GET_IC` | `1` (inline mode) | `0` |

Token rule: `0` / `off` / `false` / `no` / empty disable; **anything else takes
the tuned default**. That asymmetry is the point — a malformed value must never
land in a half-enabled state, and for a flag whose OFF position exists to be a
one-variable revert, "fails to disable" is the safe failure. The levelled flags
keep their explicit levels (`INLINE_PROP_IC=4`, `SMI_FASTPATH=1`,
`INLINE_TRUTHY_IC=all`, `EXTERN_GET_IC=census`, `IR_INLINE=adapters`); only a
value that selects *nothing recognisable* falls back.

### The revert is exact, and that is the load-bearing measurement

`=0` on all eleven, standalone acorn, `optimize: 0`:

| build | sha256 | bytes | checksum |
| --- | --- | ---: | ---: |
| pre-flip, everything unset | `d70f9e3a…80879c` | 2,487,935 | 422 |
| post-flip, everything `=0` | `d70f9e3a…80879c` | 2,487,935 | 422 |
| pre-flip, explicit tuned-11 | `62f67369…2e3a7d` | 3,297,245 | 422 |
| post-flip, everything unset | `62f67369…2e3a7d` | 3,297,245 | 422 |

Both directions are **sha256-identical**, not merely the same size. So the flip
moved the default and changed no emission: the legacy binary is still reachable
with one variable per flag, and the new default is exactly what entry (34)
measured rather than something adjacent to it.

Deterministic counts at the new default (`JS2WASM_EXEC_CENSUS`), identical to the
explicit tuned-11 on the same tree: `__extern_get` **64,691** (entry 31's
−87.2 %), `__is_truthy` **239,764** (entry 23), `__str_flatten` **252,367**
(entry 26), `__unbox_number` 214,677. The 64-name differential
(`cold-tail-differential.mjs`) is identical between new-default and explicit
tuned-11 in **both** read paths — every hash, every presence count, `nodes`
32,506, `body` 422 — with only `compileMs` differing.

**`__box_number` reads 1, not the ~401,521 of entry (33).** That figure is
`SET_MEMBER_F64` measured ALONE; it does not survive composition. Under the full
set `IR_INLINE` inlines `__box_number` into its callers, and `stripCensusPrefix`
deliberately removes the entry counter from every inlined copy — so an inlined
call is genuinely ABSENT from the count rather than double-counted. Reading 1 is
the census working, not the helper vanishing. Any future single-slice number in
this file is a single-slice number: entry (29) already recorded that these do
not compose additively, and this is the same warning seen from the counting side.

### What the flip broke, and what that says

Two classes, both structural rather than incidental:

1. **Every test pinning "unset ⇒ OFF" now pins the wrong contract.** Seven
   fixtures were rewritten to pin `=0 ⇒ legacy` and to assert positively that
   unset ENGAGES — the mechanism assertion has to move with the default, or the
   fixture silently becomes a test that the tuned build merely compiles.
   `tests/issue-4157-tonumber-fast-paths.test.ts` inverted hardest: its "junk
   must be OFF" case is now "junk must take the default", which reads backwards
   against its own pre-flip self and is exactly right.
2. **`tests/issue-4157-const-box-hoist.test.ts` had to pin `SMI_FASTPATH=0`.**
   Its unhoisted baseline counts 4 executed `__box_number` calls per iteration;
   at the new default the SMI guard answers the i31-able `42` inline and the
   baseline becomes 3. The fixture would have stayed GREEN and stopped meaning
   what it says — `CONSTANTS_PER_ITERATION` would have drifted from "the
   constants this pass removes" to "the constants some other pass had not
   already removed". This is the general hazard of flipping a default under a
   suite of count-based fixtures: the ones that break are the lucky ones.

### Stderr had to be re-calibrated, and one refusal was demoted

Five passes printed an unconditional "the mechanism fired" line when enabled.
That was right for an opt-in flag — #4157 twice recorded a confident null from a
mechanism that was never live — and is wrong for a default: it would put five to
eight lines on stderr for **every compile in the project**. They now print only
when the operator named the flag (or its `_DEBUG` channel).

One of them is not a summary and deserves the note: `[extern-get-ic] REFUSED:
… (prefix-not-key-load)`. `extern-get-cache-arm.ts` states plainly that a module
where `fillDynamicForinVecArms` / `fillObjVecReflectionHelpers` unshifted ahead
of the cache arm declines **by design** — and that class is common: it fires on
essentially every small fixture, while acorn patches 964 of 975 static-key
sites. Leaving it loud would have made a designed decline look like a defect on
most compiles in the suite. It is demoted to the same channel, and the loudness
is preserved for anyone who set the flag deliberately.

### Not verified here, by construction

This is the first time these eleven face the **test262 merge-group
re-validation**. Every measurement above is acorn plus the targeted fixtures;
there is no local test262 and the PR-level regression checks are designed
no-ops. If a flag breaks conformance beyond acorn, the merge queue's auto-park
is what will find it. Local green is not conformance-proven.

`optimize.ts` is deliberately untouched — its `wasm-opt` timeout fix (entry 31)
is a separate commit, and `JS2WASM_INLINE_HINTS` reaches it only through
`inlineHintArgs`, whose OFF position still produces byte-identical argv.

## 2026-08-13 (36) — the default flip's real cost: 37 SHAPE assertions across 14 files, and none of them a wrong answer

A default flip is measured by what it breaks. Swept `tests/` for every file that
compiles without setting these flags and asserts exact WAT, exact emitted-function
sets, absolute function indices, or opcode counts (174 + 61 files), then re-ran
every failing file with all eleven `=0` as the control. **The control is the
whole method**: this branch already carries pre-existing failures — 24 in
`tests/equivalence/`, 148 named tests in the WAT set, one OOM — and every one of
them reproduces identically with the flags off. Without the control, the flip
would have been blamed for all of them.

**Attributable to the flip: 37 tests in 14 files.** Every single one is a
*shape* assertion used as a proxy for a *different* feature, and the four
signatures are worth recording because they are what a default flip does to a
suite:

| signature | what actually happened |
| --- | --- |
| `expected '(func $f …)' to match /\bcall\b/` | the call was INLINED |
| `expected [] to deeply equal ['Base_init']` | the call EDGE was inlined away |
| `expected 53 to be 50`, `to contain 'call 66'` | an ABSOLUTE function index shifted |
| `to match /ref\.is_null[\s\S]*throw/` | the null guard was correctly ELIDED |

Not one is a wrong value. The equivalence suite — 214 files, value assertions,
run at the default — is clean against its own control.

**Attribution, by bisection**: `JS2WASM_IR_INLINE` accounts for 32 of 37 (it
removes call edges, and its rule-3 inlines `__dc_*` adapters unconditionally);
`JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR` for 3 (the `ref.is_null … throw`
marker); the ToNumber slices for 1 (`__unbox_number` is the marker for #3765's
kill switch, and the fused call replaces it); one #3744 failure is pre-existing.

### The fix is to PIN, not to relax — and pinning has a cost worth naming

`tests/helpers/pin-perf-flags.ts` sets the narrowest interfering flag for a file
and restores it after. The alternative — loosening each assertion — would leave
14 files green while proving nothing, which is the exact failure this issue
records twice (entries 22, 27: a confident null from a mechanism that never
fired). These assertions ARE the evidence: #3522's "prepared exactly once"
lists, #1761's "a non-provable length must NOT presize" soundness boundary,
#4150's "the slow path is still a call".

The cost is real and is stated at the helper: a pinned file no longer exercises
the shipped default. That is acceptable *only* because these are shape
assertions and the value-level coverage of the same features lives in
`tests/equivalence/`, which runs at the default and is clean. Pin the narrowest
set, never the whole table by reflex.

### Two inversions worth reading twice

- **#1761** asserts a soundness boundary by COUNTING the doubling grow call. The
  inliner takes the call, the count reads 0, and the assertion flips to
  "an unsound presize happened" — reporting a correctness failure that did not
  occur. A count-of-calls instrument is not a proxy for a code path once
  something is allowed to inline that call.
- **#4150** asserts the SLOW path is still a `call`. Inlined, `call` vanishes and
  the test reads "the fast path was taken" — the exact opposite of the truth.

Both are green-when-wrong and wrong-when-green respectively; both were caught
only because the OFF control existed.

### Environment note, controlled and not ours

The equivalence suite OOMs a vitest worker on this box at 4–6 GB. It OOMs
**identically with every flag `=0`**, at the same file count, and
`tests/equivalence/multi-file-compilation.test.ts` OOMs alone at 6 GB in both
states. Pre-existing; swept around it by running in 20-file chunks.

## 2026-08-13 (38) — first CI failure of the flip: the inliner DOUBLES a pre-existing fixup, and the gate counts the copy

PR #4455's `quality` check failed on the stack-balance fixup gate:
`default-value-lossy` 42→43 (+1) — while the same run banked `drop-excess`
2→0 and `call-arg-coerce` 7→1 (net −7 fixups; the gate is per-bucket, so the
+1 alone fails it).

Bisected in two steps with a focused probe (compile only
`benchmarks/helpers.ts`, count `default-value-lossy`): flag-by-flag isolates
`JS2WASM_IR_INLINE`; rule-by-rule isolates the **single-caller** rule; a new
caller→callee line under `verbose` (added in this commit) names the pair:
`__vec_get -> __cb_0`.

**Not new wrong codegen — a duplicated old one.** `__vec_get`'s own body
already carries one of the 42 baseline `default-value-lossy` fixups (the
`__vec_*` family is essentially the whole baseline: 6 per corpus file × 7
files). The single-caller rule copies that body into `__cb_0`'s wrapper
block, and the stack-balance pass — which runs after the inliner — repairs
the same missing-branch-value shape twice, with the identical
`ref.null.extern` default. Runtime value unchanged either way; the count
grows because the buggy shape now exists in two places.

Resolution: the gate's sanctioned `--update` (baseline 42→43, and the two
decreases banked). The true fix is upstream — emit `__vec_get`'s branch value
correctly so the fixup vanishes from BOTH sites (and takes ~all 42 baseline
entries with it, since the family repeats per file); that's its own issue,
not a 3-line patch on a queued defaults-flip PR. Worth knowing for the
future: **any inliner will multiply whatever masked emitter bugs live in the
bodies it copies — a fixup-count ratchet and an inliner are in structural
tension unless stack-balance runs first or the producer is fixed.**

## 2026-08-13 (39) — the remaining gap, decomposed from paired profiles: GC is exonerated, helpers are 2.2×, and 3.2× lives INSIDE the compiled functions

Paired 300-iteration V8 CPU profiles of the SAME workload — the tuned build
(defaults-on head) and native Node — make sample counts directly comparable:
**24,301 wasm samples vs 4,244 node = 5.7×** (wall measured 6.6×; sampling
skips some host glue).

In units of NODE'S TOTAL TIME (= 1.0), the wasm run spends:

| where | share of wasm run | × node-total |
| --- | ---: | ---: |
| compiled acorn code (incl. inlined IC/boxing sequences) | 55.7 % | **3.19** |
| runtime helpers (extern 8.6 %, dispatch 7.7 %, member get/set 6.7 %, object model 6.3 %, regex 3.6 %, string 2.8 %, boxing 1.9 %) | 37.9 % | **2.17** |
| GC | 5.3 % | **0.30** |

Two headlines:

1. **WasmGC's GC is exonerated: absolute GC cost is 1.29× node's** (1,291 vs
   1,001 samples — node spends 23.6 % of its much shorter run in GC, we spend
   5.3 % of ours). Allocation-rate work (fnctor arenas, presize) would buy
   almost nothing.
2. **Deleting ALL helper time leaves ~3.5×** — the independently-derived ~3×
   floor for helper-elimination approaches, now confirmed by direct
   measurement. The majority of the remaining gap is code QUALITY inside
   compiled function bodies, not calls out of them.

Per-function ratios (same acorn function, wasm/node self-samples; V8's
aggressive inlining concentrates its self-time, so treat as indicative —
the big ones are far outside attribution noise):

| function | node | wasm | ratio |
| --- | ---: | ---: | ---: |
| `pp.next` | 62 | 1,208 | **19.5×** |
| `pp$5.parseSubscript` | 124 | 1,226 | **9.9×** |
| `finishNodeAt` | 41 | 371 | **9.0×** |
| `pp$5.parseMaybeAssign` | 67 | 468 | 7.0× |
| `pp.skipSpace` | 99 | 611 | 6.2× |
| `pp.getTokenFromCode` | 153 | 787 | 5.1× |
| `pp.finishToken` | 43 | 217 | 5.0× |
| `pp$2.finishNode` | 162 | 161 | 1.0× |
| `stringToNumber` | 38 | 39 | 1.0× |

`pp.next` — the function entry (30) dissected — is STILL the worst compiled
function at 19.5×, after receiver CSE and the f64 set twins. The census names
why: the write side still CALLS. `__set_member_*` executes **344,617** times
per parse (89 distinct dispatchers; `lastTokStartLoc`/`lastTokEndLoc` are
externref writes with no typed twin possible), `__get_member_*` 339,151,
`__call_m_*` + `__call_fn_*` + `__named_this_call` 213,000 — the full
executed-helper census totals **4.84 M calls/parse** (checksum 422).

Other loud census rows with no owner yet: `__str_equals` 254,976 +
`__str_flatten` 252,367 (the flatten count survives LAZY_STR_FLATTEN — worth
finding the caller), `__box_boolean` 238,653 (comparison results boxed to be
immediately consumed), `__is_truthy` 239,764 residual, `__extern_strict_eq`
169,828, `__extern_get_idx` 95,565 (per-char `charCodeAt` traffic:
`fullCharCodeAt`/`fullCharCodeAtPos` run 163,778 times EACH).

Ranked next levers, by (share of wasm run) × (headroom implied by the ratio):

1. **Write-side member IC** (`__set_member_*` inline dispatch, symmetric to
   the read IC) — the standing #4157 lever; directly targets `pp.next` 19.5×
   and `finishNodeAt` 9.0×.
2. **Call-dispatch devirtualisation** (`__call_m_*`/`__call_fn_method_*`
   inline fast paths) — targets `parseSubscript` 9.9× / `parseMaybeAssign`
   7.0×, the two biggest compiled frames after `next`.
3. **Char-loop fast path**: `skipSpace`/`getTokenFromCode`/`fullCharCodeAt*`
   at 5–6× are a per-character `__extern_get_idx`+rope-flatten story —
   a native i16-array `charCodeAt` loop shape (or caching the flattened
   backing store) attacks `__str_flatten`'s 252 k and `__extern_get_idx`'s
   96 k in one move.
4. **Unboxed booleans**: `__box_boolean` 238 k producing values that
   `__is_truthy`-class consumers immediately unbox — a producer/consumer
   fusion inside compiled bodies, invisible to any helper-side IC.

`pp$2.finishNode` and `stringToNumber` at 1.0× prove the emitted code CAN
match V8 where the shape is already direct — the gap is concentrated, not
uniform.

Profiles: `.tmp/gap/{wasm,node}.cpuprofile`, census `.tmp/gap/census.json`,
method as entry (30) (closure-name map + bucket fold).
## 2026-08-14 — RECOVERY NOTE: entries 40-43 restored from session context after a container loss

The container holding the four-lever integration branch and entries 40-43 was
rebuilt before those commits were pushed. The entries below are restored from
the session's verified reports; the lever IMPLEMENTATIONS are being rebuilt on
fresh branches (`recover/lever-*`) from the same final designs. Numbers cited
are round-1 measurements on their stated bases and must be re-verified after
the rebuild (main has moved — notably a caller-side `__str_flatten` deletion,
`a0655cb6e`, landed independently and overlaps lever 3's target).

## 2026-08-13 (40) — WRITE-side member IC (`JS2WASM_SET_MEMBER_IC`, default OFF): −71.5 % of executed `__set_member_*` calls

New finalize pass `src/codegen/member-set-inline-ic.ts`: at call sites of
`__set_member_<prop>` / `__set_member_nonstrict_<prop>` (and `__f64` twins
under `SET_MEMBER_F64`), speculate on the dispatcher's FIRST candidate —
`ref.test → ref.cast → <coerce> → struct.set` inline, unmodified dispatcher
call as the else arm. The inline arm is EXTRACTED verbatim from the emitted
dispatcher body via a strict pattern (the extern-get-IC discipline);
`$shape`-stamped, presence-bit, ref-field brand-guarded, cold/layout/resid and
empty-candidate first arms decline wholesale. No producer-shape analysis: the
value sits on top of the receiver, both captured with typed `local.set`
scratch locals (never `tee`) — the dispatcher's own
`(externref, externref|f64)` signature guarantees operand types at every site.

Round-1 measured (exec census, family `__set_member`, checksum 422): 344,896 →
98,375 executed (**−71.5 %**), 74/424 dispatchers eligible, 890 sites patched;
all four 41,890-call `lastTok*` dispatchers plus `end` (32,468) and
`exprAllowed` (20,606) at ZERO residual. `__set_member_type` (32,468) declines
(first arm not the plain shape; declines body-shape=330/arm-shape=18/
arm-tail=1/polymorphic=1) — the next slice. Poison traps in
`__dc_Parser_next_0`; byte-identity off; composes with
INLINE_PROP_IC+EXTERN_GET_IC+SET_MEMBER_F64.

## 2026-08-13 (41) — call-dispatch devirtualization: `__call_m_*` −99.9 % executed calls (`JS2WASM_CALL_DISPATCH_IC`, default OFF)

New finalize pass `src/codegen/call-dispatch-ic.ts`: for every FILLED
fixed-arity `__call_m_<name>_<arity>` dispatcher whose body matches the exact
fill-emitted shape (`local.get 0; any.convert_extern; local.set __any;
<guard>; if(externref) then=HIT else=REST`), copy the guard chain and the
OUTERMOST arm verbatim to each call site — locals re-homed onto site-minted
twins, `return` converted to depth-tracked `br`; any escaping
branch/br_table/tail-call declines the dispatcher — with the unmodified
dispatcher call as the site's else arm. The outermost arm is the hot one by
the fill's own wrap order (regex `.test` brand #3507, closure `.call` fast arm
#4185, method-cache direct call #3673 r13, vec push/indexOf brands), so one
generic transform devirtualizes all 22+ families with no per-family logic.

Round-1 measured: `__call_m_*` 103,652 → **105** (−99.9 %; residual =
`return_call`-position sites, deliberately unmatched), armed-dispatchers=318,
patched-sites=1,572 across 808 functions, binary +5.9 % at optimize:0.
`__call_fn_method_*` (76,827) and `__named_this_call` (32,468) deliberately
out of scope. Poison: parse throws WebAssembly.Exception, no checksum.

## 2026-08-13 (42) — unboxed boolean fusion (`JS2WASM_UNBOXED_BOOL_FUSE`, default OFF): −118,595 executed `__is_truthy`, −23,084 `__box_boolean` on legacy defaults

New finalize pass `src/codegen/box-boolean-fuse.ts`: sink `__is_truthy` into
materialized logical-value `if`s, fusing `__box_boolean` producers to raw i32
(fused-sink=162 sites; leaves box-call=174, cond-reuse=206). On the FLIP tree
the `__is_truthy` cut disappears (INLINE_TRUTHY_IC already claimed those
sites) — residual value is the `__box_boolean` cut only (−5.4 % composed).
The dominant residual is CROSS-FUNCTION (declines prev-call=372, arm
tail-call=98, prev-local.tee=532, prev-local.get=433): closing it needs an
i32-returning callee twin (return-type unboxing ABI), not a bigger peephole
window.

## 2026-08-13 (43) — the shard slowdown DIAGNOSED and the fix package: parks 2-3 were the flip's compile-time tax meeting a heap ceiling

Under the tuned defaults, standalone test262 shards ran ~40 %+ slower
(baseline median 13.9 min; park 3: two completions at 18.2/21.6 min, twelve
killed at the 30-min timeout exactly; js-host medians identical 8.1 vs 8.2).
Local decomposition: **+12-15 % per-compile fixed cost** (flag bisection:
IR_INLINE dominant; instantiation/execution exonerated at ms), amplified by
the pool workers' **512 MiB heap ceiling** (tuned compiles ~60 MB hotter; V8
near its cap GC-thrashes superlinearly). Fix package (landed on the #4455
branch): ir-inline eager whole-module body clone → COPY-ON-WRITE
(`createOriginalBodyTracker`) + per-callee memoization of
calleeIsSafe/countInstrs/effectiveSize/hasCall (`CalleeFacts`) — byte-identity
sha `9c172186` proven before/after three times; CI shard `timeout-minutes`
25→40; `TEST262_WORKER_MAX_OLD_SPACE_SIZE` 512→1024.

Order-reversed local mini-shard A/B (385 tests, `language/statements/for/`,
identical verdicts 331/54 in all legs): off 192 s / on 246 s / off 193 s —
**+28.0 %**, projecting ~18 min/shard against the 40-min ceiling. Method note:
the flag bisection over-credited IR_INLINE (~55 ms) because the box's noise
band is ±20 ms; internal phase timers located the real split (callgraph 2.4 +
hotness 3.8 + rewrite 14 ms post-fix). Runner note: a fresh worktree needs
BOTH gitignored bundles (`pnpm run build:compiler-bundle` AND the
`src/runtime.ts` esbuild) or every pool worker dies at startup and all tests
"fail" as worker-less timeouts.

## 2026-08-14 (44) — the four levers' wall A/B: a NULL on this box, and why that was predictable

Order-reversed (ON/OFF/OFF/ON), completed `-O4` in every leg (the 600 s
wasm-opt timeout imported; ZERO unoptimized-fallback warnings), both arms on
the tuned-11 base so this measures the levers' MARGINAL wall value:

| leg | wasm ms | node ms |
| --- | ---: | ---: |
| ON a | 94.9 | 15.2 |
| OFF a | 97.8 | 13.4 |
| OFF b | 98.7 | 13.2 |
| ON b | 101.2 | 14.3 |

ON mean 98.1 vs OFF mean 98.2 — **≈ 0 %, below the box's noise floor** (ON
legs bracket the OFF legs; node's own reference drifts 13.2–15.2 ms). The
executed-call wins are real and proven (−46.3 % across the six families,
checksum 422, poison-proven per lever); the WALL effect is capped by entry
39's decomposition — post-flip these helper families hold ~10-15 % of the
wasm run, so even halving them lands under the ~10 % resolution floor
(#3927 §6). Verdict: flags stay DEFAULT OFF; certifying a wall win needs a
quieter environment or a CI perf lane. The levers remain valuable as (a)
proven call-elimination machinery for when the compiled-code-quality work
(receiver-type specialisation, return-type unboxing ABI) shrinks the
compiled bucket and re-exposes helper share, and (b) the site-IC pattern
library the next levers copy from.

## 2026-08-14 (45) — the call-dispatch IC went to ZERO matches under main, and why that is a shape-drift lesson

`tests/issue-4157-call-dispatch-ic.test.ts` failed 2/3 in #4491's `quality`
run — `armed=0`, `patchedSites=0` — while the flag-unset byte-identity test
still passed. The lever was not broken; **main moved the shape out from
under it**.

#4394 (`closed-method-dispatch.ts:1465`) now prepends a nullish-receiver
TypeError guard to every FILLED dispatcher body on the standalone/WASI lane:

```
local.get 0 ; [call $__nullish_to_null] ; ref.is_null ; if (empty) { throw }
```

`analyzeDispatcher` matched the fill prologue at **exactly `body[0..2]`**, so
with 3-4 guard instrs in front, every dispatcher declined with reason
`prologue` — a total, silent zeroing of the pass. Note the failure mode: the
OFF path stayed byte-identical and every other lever's test stayed green, so
only the ON-path count assertions caught it. **Exact-offset shape matching
against another pass's emission is a standing liability**; the count
assertions are what make it visible, and they earned their keep here.

Fix: `nullishGuardPrefixLength(body)` recognises that guard EXACTLY (the real
prologue's second instr is `any.convert_extern`, never `call`/`ref.is_null`,
so the shapes cannot be confused) and offsets the prologue and guard-region
slices by its length. An unrecognised prefix still declines as `prologue`
rather than being skipped blindly.

The guard is deliberately **not** copied to the call site: a nullish receiver
fails the copied arm's type test and falls through to the else arm — the
unmodified dispatcher call, guard included — so the TypeError is still
thrown, by the dispatcher, exactly as before. Verified: all 3 tests green
including the poison probe (the arm really executes); `tsc` clean.

## 2026-08-14 (46) — park 6 ROOT-CAUSED and FIXED: the receiver coercion two late repairs both mis-attribute, and the tuned set is what widened the window

PR #4455's merge-group run 31790623974 completed all 102 shards and the
standalone guard failed for real: **net −30 pass** (30,703 → 30,673, tolerance
−15), 36 regressions vs 6 improvements, **wasm_compile 33** + assertion_fail 3,
compile_error bucket 5,792 → 5,830. All 36 wasm-hash-changed (flip-attributable,
zero compile_timeout involvement) and all shared one bucket signature. js-host
passed its guards — standalone-only.

### Recovering the file list without the CI artifact

The per-file list lives only in an Azure-blob artifact this container's proxy
blocks, and the GitHub API is unreachable from here too. Recovered locally
instead: clone `loopdive/js2wasm-baselines`, take the 30,703 `pass` rows of
`test262-standalone-current.jsonl`, and for each re-assemble the ORIGINAL
harness exactly as the sharded runner does (`assembleOriginalHarness`), compile
with `{target:"standalone", allowJs, skipSemanticDiagnostics, deferTopLevelInit}`
and check `WebAssembly.validate`. A `wasm_compile` regression is a COMPILE-time
property — no eval engine, no instantiation, no quickjs provider needed, ~0.6 s
per test. Two random draws (4,641 tests) surfaced two hits; both were
`cpn-class-*`, and sweeping that family directly gave **32 of the 36**:
`language/{statements,expressions}/class/cpn-class-{decl,expr}-computed-property-name-from-*`
(additive-add/subtract, multiplicative-mult/div, exponetiation, condition-true/false,
null, identifier, math, string-literal, numeric/decimal/decimal-e/integer-e-notational,
integer-separators).

### Root cause — NOT a single culprit flag

Single-flag bisection was misleading in both directions: with all eleven ON,
turning any ONE off still failed; with all eleven OFF, turning `JS2WASM_IR_INLINE`
**or** `JS2WASM_SMI_FASTPATH` on *independently* reproduced it. That is because
neither is the defect. The defect is older and the two flags merely widen the
window it needs.

Standalone codegen emits a devirtualized method call as

    global.get $__mod_c   ;; the receiver `c`, a (ref null $C) GC struct
    call $C_2             ;; the devirtualized method — takes ZERO parameters
    …                     ;; whatever consumes $C_2's f64 result
    call $__call_m_sameValue_2 / local.set $x    ;; the operand's REAL consumer

so the receiver's consumer is several instructions away, and nothing emits its
`extern.convert_any`. Two late repairs are supposed to supply it, and both
attribute the value by position rather than by stack model:

- `fixCallArgTypesInBody` (stack-balance.ts) walks BACKWARD from the call and
  **stops at the first `if`/`block`/`loop`** ("Stop at control flow boundaries");
- `fixLocalSetCoercion` only ever inspects `body[i - 1]`.

`smi-box-fast-path.ts` replaces `call $__box_number` with a guard ending in
`if (result externref)`; `ir-inline.ts` replaces a call with `block (result …)`.
Either lands inside that window, the coercion is silently never inserted, and
V8 rejects the module with `call[0] expected type externref, found global.get of
type (ref null 74)` — or, one shape over, the `local.set[0]` twin. Verified by
instrumenting the pass chain: the `extern.convert_any` is absent BEFORE
`finalizeModuleValueCaches` in every build and appears only `after-stack-balance`
in the legacy one. It is standalone-only for the obvious reason: under a JS host
a class instance already IS an `externref`, so no coercion is ever due.

### Fix — model the stack instead of guessing the position

`src/codegen/call-arg-producers.ts` (new): the #4077 exact forward model moved
verbatim out of `fixups.ts` and generalised from `locateCallArgProducers` to
`locateOperandProducers` — the producer index of every value each instruction
POPS. It already models `if`/`block`/`loop` exactly, which is the whole point.
`src/codegen/cross-hierarchy-operands.ts` (new) consumes it and runs as its own
pipeline step immediately BEFORE `stackBalance(mod)`, so both legacy repairs see
the coercion already in place and queue nothing. It is a separate module rather
than more lines in `stack-balance.ts` because that file is a god-file sitting
exactly at its LOC budget (2,836) — `stack-balance.ts` only exports four helpers
it already had (`resolveFuncType`, `getFullParamTypes`, `inferInstrType`,
`callArgCoercionInstrs`) and does not grow by a line.

It repairs **only** `externref` ⇄ concrete-GC-ref, in either direction. Those
hierarchies are disjoint in Wasm, so such a pair can never validate under any
subtyping rule — the pass can only turn an invalid module valid, never perturb
a valid one. Everything else (numerics, struct-to-struct `ref.cast_null`,
`anyref` widening, which IS legal) is left to the two legacy repairs untouched.
Real fix, not a target gate: the −12 % standalone acorn win is kept whole.

### Verification

- 32/32 recovered `cpn-class-*` tests: INVALID_WASM → valid. Re-run twice.
- 4,000-test random A/B (same list, pre vs post): **zero new failures**, one
  fixed; 560 → 559 non-ok rows (the rest are negative tests, identical in both).
- Byte identity on the `=0`-everything path: standalone acorn 1,157,936 B
  unchanged with all four canaries (2/3/4/5); the 172,617-byte test262 harness
  module sha256 `e30ad07f…` unchanged. Both measured base-vs-new by file copy.
- Tuned-default acorn: success, canaries 2/3/4/5, no host imports.
- Equivalence gate shards 1–8: no new regressions, and **12 baseline failures
  now PASS** (8 on shard 2, 1 on shard 4, 1 on shard 6, 2 on shard 7) —
  `coercion/arithmetic-add` standalone / standalone-O string concatenation,
  `math-pow-test262-pattern`, `issue-1197`, `symbol-basic`. The same defect was
  already costing us tests before the flip. Baseline deliberately NOT ratcheted
  in this commit: this is a park fix, and the ratchet belongs in its own change.
- New regression test `tests/issue-4157-park6-cross-hierarchy-operand.test.ts`
  pins both consumer shapes (call operand, `local.set` operand).

Not accounted for: 1 `wasm_compile` + the 3 `assertion_fail` rows. The sweep
compiles only the PRIMARY harness variant and never executes, so it cannot see a
strict-rerun-only failure or a wrong-answer one; the merge-group re-run is the
authoritative check on those.

## 2026-08-14 (47) — WIP HANDOFF: the real phase order, and the premise that `ir-inline` runs BEFORE devirtualization is FALSE

Task was "build a SECOND inlining pass that runs AFTER devirtualization".
Establishing the phase order first — as the task asked — invalidated the
premise it was built on. Recording that before anything is built, because it
redirects the work.

### (a) The REAL phase order (`src/codegen/index.ts`, the finalize block)

Read off the source, not inferred. All line numbers at `d98ea58a8`:

| # | line | pass | default |
| --- | --- | --- | --- |
| 1 | 5230-5279 | every `__call_m_*` / `__get_member_*` / `__set_member_*` body **fill** | — |
| 2 | 5281-5283 | `inlineMemberGetCallSites` · `inlineIsTruthyCallSites` · `fuseBoxBooleanSinks` | ON · ON · OFF |
| 3 | 5328-5329 | `inlineExternGetCallSites` · `inlineFlatStrCallSites` | ON |
| 4 | 5336 | `inlineMemberSetCallSites` | OFF |
| 5 | **5342** | **`inlineCallDispatchSites`** — the `__call_m_*` **devirtualization** | **OFF** |
| 6 | 5575 | `eliminateDeadLayoutAndPlanProgramAbi` — authoritative funcIdx remap | — |
| 7 | 5578/5581 | `repairStructTypeMismatches` · `peepholeOptimize` | — |
| 8 | 5586-5587 | `installAllocCensus` · `installExecCensus` | OFF |
| 9 | **5588** | **`inlineUserFunctions` (`ir-inline.ts`)** | **ON** |
| 10 | 5596 | `finalizeFunctionPoisonPillCalls` | — |
| 11 | 5601 | `ctx.indexSpaceFrozen = true` | — |
| 12 | 5610-5611 | `repairCrossHierarchyOperands` · `stackBalance` | — |
| 13 | 5619 | `fixupExternConvertAny` → **then** emit → **then** `src/optimize.ts` (`wasm-opt`) | — |

**`ir-inline` is step 9. The devirtualization IC is step 5. `ir-inline`
already runs AFTER devirtualization** — by 246 lines and, more importantly,
across the dead-elim boundary, so every `call` it sees carries a final
funcIdx. It is also not an "IR pass" in the `src/ir/` front-end sense: it is a
wasm-level pass over `mod.functions`, four passes before `stackBalance`.

So a "second inlining pass that runs after devirtualization" would occupy
**the slot `ir-inline` already occupies**. The gap, if there is one, is in
`ir-inline`'s ADMISSION RULES, not in the phase order. That is a different
change with a different risk profile, and it should not be built as a second
pass on the strength of an ordering claim that does not hold.

### (c) `pp.fullCharCodeAt` is NOT declined on budget — it is ALREADY INLINED

The stated hypothesis was that `this.input.charCodeAt(...)` lowers to
string-runtime helper calls that inflate the body past the inliner's size
budget. Measured on a baseline compile (`JS2WASM_IR_INLINE=on,verbose`,
`JS2WASM_CLOSURE_NAME_MAP=1`, standalone, `optimize:3`, acorn 8.16.0,
1,398,937 B):

```
[ir-inline]   single-caller: __closure_355__typed_this -> __closure_355
```

Exactly one line, and it is an ACCEPT. `__closure_355` ← `pp.fullCharCodeAt`
(closure-name map). The `single-caller` rule requires `callerCount == 1 &&
!addressTaken && effSize <= 400`, so at ir-inline time the typed twin had
**exactly one direct caller in the whole module** — `__closure_355`, its own
generic wrapper — and its effective size was **within** the 400-instruction
budget. There is no size-budget decline to report.

That looked like a contradiction with the profile's "called 100 % DIRECTLY
from `__closure_686__typed_this`". **It is not — the profile is pointing at
the WRONG TWIN.** Disassembling a name-preserving `optimize:0` build
(`wasm-dis --all-features`) resolves it exactly:

```
$ grep -c '(call $__closure_355__typed_this' o0.wat   →  0
$ grep -c '(call $__closure_685__typed_this' o0.wat   →  31
```

`pp.fullCharCodeAt` @5479 is lifted TWICE — `__closure_355` and
`__closure_685` — as is `pp.fullCharCodeAtPos` @5486 (`__closure_356` /
`__closure_686`). `__closure_355__typed_this` has **zero** call sites: its one
caller was its own generic wrapper, `ir-inline` inlined it there, and the body
survives to emission only because **`ir-inline` runs AFTER dead-elim (step 9
vs step 6), so a function it strands is never reclaimed** — a small standing
size cost worth its own look. The LIVE function is
`__closure_685__typed_this`, and `__closure_686__typed_this` calls it, exactly
as the profile says.

**And the live twin lands squarely in the `no-rule` bucket.** It has 31 direct
call sites (`single-caller` needs 1) and it is NOT a leaf — its body calls
`__to_number` ×2, `__str_flatten` ×2, `__box_number` ×2, `__unbox_number`,
`__get_member_pos__f64` and `__call_m_fullCharCodeAt_1` (`loop-leaf` needs a
call-free body). Its folded-WAT body is ~721 lines, so a budget question is
live too, but the rules never get that far: **multi-caller AND non-leaf is
declined before any budget is consulted.**

So the task's instinct was right and its stated reason was wrong. The lever is
a rule admitting small hot multi-caller non-leaf callees — not a new pass, and
not a size budget on `charCodeAt` lowering. The ~721-line body does mean such
a rule needs the `effectiveSize` cold-subtraction to do real work on this
callee; that is unmeasured.

Baseline `ir-inline` apply stats, for reference:

```
mode=apply funcs=3549 sites=47540 inlined=8289 addedInstrs=141844
by-rule  adapter=3820 loop-leaf=2643 specialised=1174 single-caller=652
declines no-rule=34079 (helper 33071, user 817) cold-callee=4628
         self-recursive=334 unsafe:return-call=203 unsafe:try=6
```

`no-rule` is 72 % of declines and is dominated by small hot HELPERS
(`__str_equals` 2,679 sites, `__unbox_number` 1,807, `__is_truthy` 1,652,
`__box_number` 1,556) that are **multi-caller and non-leaf** — the one shape
no existing rule admits: `adapters` is name-gated, `single-caller` needs
`callerCount == 1`, `loop-leaf` needs a call-free body, `specialise` needs
constant args. That, not the phase order, is the real hole.

### (b) Binaryen vs newly-direct calls — NOT YET MEASURED

Deliberately unanswered. The `JS2WASM_CALL_DISPATCH_IC=1` × `-O4` A/B
disassembly comparison had not run when this session was handed off. Do not
read the absence as a null.

### Handoff state

Branch `impl-post-devirt-inline`. No compiler source changed — this entry is
the whole deliverable. Scratch driver (gitignored) at `.tmp/compile-acorn.mjs`:
compiles standalone acorn with `preserveDebugNames`, honours `ACORN_OPT`,
prints bytes + sha256.

**Nothing under `.tmp/` survives a container restart** — the `optimize:0`
name-preserving binary and its `.wat` are gone with the box. To rebuild the
evidence above from scratch (~110 s compile, ~60 s disassembly, ~28 MB of
WAT):

```bash
ACORN_OPT=0 JS2WASM_CLOSURE_NAME_MAP=1 NODE_OPTIONS=--max-old-space-size=6144 \
  node --import tsx .tmp/compile-acorn.mjs .tmp/o0.wasm 2> .tmp/o0.err
node_modules/.bin/wasm-dis --all-features .tmp/o0.wasm -o .tmp/o0.wat
grep -c '(call $__closure_685__typed_this' .tmp/o0.wat   # 31
grep -c '(call $__closure_355__typed_this' .tmp/o0.wat   # 0
```

Note `__closure_*` numbering is not stable across compiler revisions — read
the live pair off `[js2:closure-map]` in `.tmp/o0.err` rather than assuming
355/685.

Still NOT measured, in priority order: (1) whether `-O4` inlines the
newly-direct calls under `JS2WASM_CALL_DISPATCH_IC=1`; (2) the
`effectiveSize` of `__closure_685__typed_this` after cold-subtraction, which
decides whether a multi-caller/non-leaf rule could actually admit it; (3) any
wall A/B.

## 2026-08-15 (48) — the `hot` rule: closing the no-rule hole (entry 47's lever), flag-gated

Implemented the rule entry 47 identified. `JS2WASM_IR_INLINE=...,hot` (token
`hot`, ceiling `hotmax=N`, default 60) admits a callee when
`weight >= LOOP_WEIGHT && effSize <= hotMax * max(1, log10(weight))` — the
same hotness bar and weight-scaled budget as `loop-leaf`, with the two gates
that created the hole removed:

- **caller count does not gate** (`single` needs `callerCount == 1`; the top
  candidates have hundreds to thousands of callers),
- **leaf-ness does not gate** (`loop` needs a call-free body; nested calls in
  the copied body stay calls — ONE pass never chains — so non-leaf admission
  adds no new hazard class, only size, which `hotMax` × the shared growth cap
  bound).

Deliberately NOT in the `on` preset — measure first (the #4455 pattern:
flag-gated in, numbers to the lead, separate flip PR).

Verbose no-rule declines now carry per-callee facts in the aggregation key
(`<name> no-rule eff=<n> leaf=<0|1> callers=<n>`), so a single
`report,verbose` compile answers entry 47's open measurement (2) for every
candidate at once — including `__closure_685__typed_this`'s post-subtraction
effectiveSize.

Fresh baseline reproduction on current main (`1185f7af2`-era, opt=3):
`sites=47411 inlined=8270` · `no-rule=33984` (helper 32976, user 817) · top
candidates by site count: `__str_equals` 2672 · `__unbox_number` 1795 ·
`__is_truthy` 1652 · `__objvec_push` 1601 · `__box_number` 1553 ·
`__extern_get` 1435 (4.0 % of runtime per entry 46's profile) ·
`__box_boolean` 1424 · `__to_number` 1063.

Measurement protocol (next): (a) positive control — `JS2WASM_IR_INLINE=hot,poison`
must move the acorn checksum off 422 (proves hot-inlined bodies execute);
(b) correctness — `on,hot` checksum stays 422; (c) 4-leg order-reversed wall
A/B on standalone-dynamic, `wasmOptimized: true` verified per leg; (d) binary
size delta. Then a `hotmax` sweep if (c) is a win.

### Gates run (same day)

- **(a) PASSED**: `hot,poison` → `RuntimeError: unreachable` in the self-parse
  — hot-inlined bodies are on the executed path; the mechanism is live.
- **(b) PASSED**: `on,hot` → checksum **422**, suite **3,490 passed / 99.2 %**
  — identical to baseline.
- **Admissions** (`report,hot,verbose`): `hot=3577` (3,479 helper / 89 user /
  9 other); inlined 8,272 → 11,849; addedInstrs 141,961 → 322,022 (cap 400k).
  Per-callee: `__str_equals` 908 · `__unbox_number` 617 · `__str_flatten` 253
  · `__to_number` 209 · `__nullish_to_null` 171 · `__extern_toString` 165 ·
  `__to_bigint` 148 · `__extern_set_strict` 46. The leaf candidates
  (`__is_truthy`/`__objvec_push`/`__box_number`) get 0 — their hot sites were
  already loop-leaf-inlined; their remaining declines are cold sites, which is
  correct. `__closure_685__typed_this` (entry 47's live twin) gets 0 as a
  CALLEE (budget) but RECEIVES hot inlines (`__str_flatten`, `__to_number`).
- **(c) IN FLIGHT**, after two instrument traps burned the first attempts:
  1. **`JS2WASM_IR_INLINE=""` is an OFF-token** (`OFF_TOKENS` in
     perf-flags.ts includes `""`). A base leg env-set to the empty string
     measures the inliner fully OFF and credits the whole pass to the rule
     under test. Base legs must pass explicit `on`.
  2. **Self-contaminated box**: launching the A/B right after three stacked
     compile jobs left load at 3.4 — the two BASE legs disagreed by 20 %
     (48.3k vs 57.9k µs; the handoff's quality bar is ~6 % within-group), and
     one leg's harness died silently after compile (banner-only stdout, clean
     stderr, no JSON). Re-run is load-gated (< 1.5) with 6 alternating legs
     and per-leg exit/size checks + empty-output retry.
- **(d) MEASURED — the static picture, from the noisy round's artifacts**
  (both legs `wasmOptimized=true, wasmOptimizeLevel=4`, verified in
  `perfRows[0]`, base bytes deterministic across legs):

  | | base (`on`) | hot (`on,hot`) | delta |
  | --- | ---: | ---: | --- |
  | -O4 binary | 2,013,600 B | 2,319,564 B | **+15.2 %** |
  | pre-opt instrs | 902,125 | 1,092,517 | +21.1 % |
  | p50 / p99 func | 64 / 2,864 | 73 / 3,268 | +14 % both |
  | largest func | 43,040 | **75,702** | **+76 %** |

  The 75.7k max is one mega-caller absorbing dozens of copies — evidence the
  rule needs a **per-caller absorption cap**, not only a callee ceiling.

- **Early wall read (noisy box, min-estimator)**: the contention noise is
  ADDITIVE (per-leg samples are bimodal: a ~46k µs cluster + 60–80k
  outliers), so the per-leg MINIMUM is the robust location estimate — and the
  minimums are indistinguishable: hot 46k vs base 45k/47k. Provisional:
  **wall-neutral at +15 % size ⇒ not flippable as-is.** The load-gated 6-leg
  alternating re-run decides.
- **If neutral confirms, the iteration order**: (1) `hotmax` sweep DOWN —
  `__str_equals` alone is 908 sites × eff 95 ≈ half the added mass;
  `hotmax=40` excludes exactly it while keeping the ≤37-instr family
  (`__unbox_number`/`__to_number`/`__to_bigint`/`__extern_toString`/
  `__nullish_to_null`/`__extern_set_strict`); (2) per-caller absorption cap;
  (3) restrict to sites where the inlined body's box/unbox cancels against
  the caller (the fold wasm-opt can prove).
- **Not measured yet**: entry 47's open (1) — Binaryen ×
  `JS2WASM_CALL_DISPATCH_IC=1`.

### Follow-ups noted while here

- `__extern_get` effSize **16,553** at 1,435 declined sites (4.0 % of runtime
  per entry 46) — no inline budget can ever admit it; the dynamic-lookup
  bucket needs lookup devirtualization/specialisation (#4405 lane), not the
  inliner. The two levers are cleanly complementary.
- Entry 47's stranded-body observation stands: ir-inline runs after dead-elim,
  so a twin it fully inlines away survives to emission as dead mass.
## 2026-08-15 (49) — the flip's first RUNTIME regression: the loop-leaf rule inlined a loop, and the landing WASI `fib` lane went 1.50x V8 → 0.76x

Entry (37) flipped the tuned eleven ON and named the risk it could not cover:
"this is the first time these eleven face the test262 merge-group
re-validation". They passed it. What no gate covered is the landing benchmark
lane, and that is where the flip's first real regression landed — visible only
in a committed artifact three refreshes later.

### The number, and how it was isolated from machine noise

`benchmarks/results/wasm-host-wasmtime-hot-runtime.json` is refreshed by CI on
two runner classes, which the JS lane identifies unambiguously: class A reads
`js ≈ 16.8 ms` on `fib` warm, class B `js ≈ 18.68 ms`. Comparing only within
class B, so the CPU is held fixed:

| refresh (class B)  | fib warm | fib-recursive | array-sum | string-hash |
| ------------------ | -------- | ------------- | --------- | ----------- |
| 8695ae8 / d9cef66  | 12,442   | 7,565         | 926       | 238         |
| f2c52ab .. 412cda7 | 24,888   | 7,565         | 1,243     | 238         |

`fib` exactly 2.0x, `array-sum` 1.34x, the other two untouched — and the JS lane
moved 18,683 → 18,682 µs across the same boundary. A machine change cannot
produce that pattern; the two survivors are what named the rule. `fib-recursive`
is self-recursive (already declined) and `string-hash` is not a leaf. Both
regressing programs are a small **exported leaf that is one `for` loop**.

The `fib` COLD lane did not move (18.8 → 18.8 ms), and its module is
byte-identical across the boundary — the cold binary is 104 bytes on both
sides. Only the WARM module, which appends the timing driver, changed.

### Root cause

Rule 1's `loop-leaf`: `weight ≥ 10` (the site is in the driver's measurement
loop), `isLeaf` (fib's `run` calls nothing), `effSize ≈ 30 ≤ loopBudget 60`. So
`run` was inlined into `warm` at both of its sites. `JS2WASM_IR_INLINE=on,verbose`
prints it directly:

```
[ir-inline]   loop-leaf: run -> warm
[ir-inline]   loop-leaf: run -> warm
```

Cranelift then had to keep `n`, `__best` and `__t0` in stack slots — every one
of them is live across the driver's `performance.now()` calls, and xmm
registers are caller-saved. The inner loop's back edge picked up three
`movdqu` reloads it never had as its own function:

```
0x1ef: vxorpd %xmm0,%xmm0,%xmm0 ; vcvtsi2sdl %eax,%xmm0,%xmm0
       movdqu (%rsp),%xmm1                 ; n, reloaded per iteration
       vucomisd %xmm0,%xmm1 ; ja 0x2ed
0x2ed: movdqu 0x10(%rsp),%xmm0             ; __best, not even read here
       movdqu 0x20(%rsp),%xmm1             ; __t0,   not even read here
       addl $1,%eax ; leal (%rcx,%r12),%edx ; movq %rcx,%r12 ; movq %rdx,%rcx
       jmp 0x1ef
```

20,000,000 iterations of that is the whole 12.4 ms.

### Fix — rule 5 in `src/codegen/ir-inline.ts`

A callee that contains a `loop` is not a loop-leaf. The loop-leaf trade buys the
call sequence at a hot site; it needs the callee's per-call cost to be
comparable to the call, and a callee with its own loop covers its whole trip
count per call, so the overhead removed is a vanishing fraction of it — while
the register pressure it adds to the caller's inner loop is not. This is the
same line Binaryen draws with "lightweight (no loops or function calls)",
reached from the cost side rather than the safety side.

The near-miss gets its own decline bucket, `loop-in-callee`, rather than
disappearing into `no-rule`: it is the one decline whose cause is a cost-model
judgement, and a future retune needs to see what rule 5 costs.

### Verification

- Both warm modules are now **byte-identical to the pre-flip build**
  (`JS2WASM_IR_INLINE=0`) at the landing lane's own options
  (`target: wasi, nativeStrings, optimize: 3`): fib 449 B, array-sum 475 B.
  So the CI lane returns to 12,442 / 926 µs by construction, not by prediction.
- Local wasmtime 46.0.1 (the pinned version, `benchmarks/wasmtime-cold-host`),
  min of 5, pinned core: array-sum warm 1.79 → 1.49 ms.
  **`fib` ranks the OTHER WAY on this container** (24.2 ms inlined vs 30.4 ms
  not) — the spill cost is µarch-dependent, and this box is not the CI runner.
  That is why the regression test pins the inline DECISION, not a wall clock.
- Acorn standalone, `report` mode: 348 of 8,292 candidate sites become
  `loop-in-callee` (4.2 %); `adapter=3820`, `loop-leaf=2297`,
  `specialised=1174`, `single-caller=653` are all retained. The −12.0 % wall of
  entry (34) rests on the adapter/helper mass, which rule 5 does not touch.
- `tests/issue-4157-ir-inline.test.ts` 21/21; new
  `tests/issue-4157-ir-inline-loop-callee.test.ts` pins both directions —
  the fib shape unchanged by the loop rule, a loop-FREE two-site leaf still
  inlined by it (isolated against `adapters,single,specialise`, so the other
  three rules cannot mask the result).
- LOC budget, function budget, stack-balance fixup gate: OK.

### The gap this leaves

Nothing in CI would have caught this, and nothing does now: the landing
benchmark artifact is refreshed on merge to `main` and read by humans. A
per-program regression gate on `wasm-host-wasmtime-hot-runtime.json` — comparing
within a runner class, keyed on the JS lane as the machine fingerprint — is the
missing check. Filed as a follow-up rather than bundled here.
