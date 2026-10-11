---
id: 5407
title: "standalone: linking the compiled Temporal provider still costs 1.8× a row's compile time (+214 functions, WAT doubled) — 8 of 360 measured rows time out, and this is the one thing keeping the test262 standalone Temporal artifact opt-in"
status: in-progress
assignee: ttraenkler/temporal-new-size
sprint: current
priority: medium
horizon: l
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-12
loc-budget-allow:
  # 2026-09-24 (slice S-new, shared TA construct) — `dataview-native.ts` +~100:
  #   the new `emitTaDynCtorConstructFromLocals` wrapper + the lazily built
  #   `__ta_dyn_ctor_construct_a<k>` helper that replaces per-site inlining of
  #   the ~40 KB dynamic TypedArray construct. It must sit next to the construct
  #   body it outlines: two of the four callers are in this same file, so a new
  #   module would import from and be imported by `dataview-native.ts` (a cycle)
  #   for a wrapper of ~60 code lines. Most of the growth is the rationale doc.
  # 2026-09-24 — `closures.ts` +13: the up-front standalone fallback in
  #   `compileArrowAsCallback` (skip the dead `__cb_<id>` bridge compile). It is
  #   a guard at the top of the one function whose tail it short-circuits.
  - src/codegen/dataview-native.ts
  - src/codegen/closures.ts
func-budget-allow:
  # 2026-09-24 — RENAME, not growth: the pre-existing 630-line construct body
  #   `emitTaDynCtorConstructFromLocals` is now the private
  #   `emitTaDynCtorConstructInline` (the helper's body) so the exported name can
  #   become the thin call-site wrapper every caller already uses. The body is
  #   unchanged; the gate sees a "new" over-budget function only because the key
  #   is name-based. Splitting the construct is out of scope for a size fix.
  - src/codegen/dataview-native.ts::emitTaDynCtorConstructInline
  # 2026-09-24 — `compileArrowAsCallback` +2: one guard line (and its blank)
  #   calling the new `hostFreeCallbackBridgeMissing` predicate, which holds
  #   the logic and rationale outside the function. It must run before the
  #   body compile it skips, i.e. inside this function.
  - src/codegen/closures.ts::compileArrowAsCallback
---

## Problem

The standalone Temporal provider (#5383) works and is wired into every test262
lane, but the artifact is **opt-in** (`JS2WASM_TEST262_TEMPORAL_STANDALONE=1`,
the `standalone_temporal` workflow input) for exactly one reason: linking it
makes a row's compile too slow to be safe by default.

Measured in #5383 S2p (`.tmp/s2p-cost.mts`, median of 3, one process):

| row | route | S2p |
| --- | --- | --- |
| `PlainDate/prototype/day/basic.js` (10.6 KB assembled harness) | `compile` | 1647 ms |
| | linked | **2894 ms** (1.76×) |
| `intl402/…/PlainDate/from/era-japanese.js` (60 KB) | `compile` | 8244 ms |
| | `compileMulti` | 8729 ms |
| | linked | **15057 ms** (1.83×) |

The 60 KB row lands **exactly on the 15 s in-process compile limit**; the
sharded lane's fork kill is 30 s.

Two earlier suspects are closed and must not be re-investigated: linking itself
costs ~2 % (#5383 S2o), and the multi-source penalty is gone — on the 60 KB row
`compileMulti` is within **6 %** of `compile` after S2o's `typeof globalThis`
struct guard and S2p's outlined `globalThis` seed. **What remains is the
provider**: linked adds **214 functions** and doubles the WAT again (851 k →
1.85 M lines on the 60 KB row).

### The cost is already visible as failures, not just as slowness

#5383 S5 (2026-09-12), 3 × 120 rows, standalone lane, fresh
`JS2WASM_TEMPORAL_CACHE` per side:

| | PlainDate | Duration | ZonedDateTime |
| --- | --- | --- | --- |
| median row ms, unlinked | 1378 | 1372 | 1205 |
| median row ms, linked | 3126 | 3275 | 2886 |
| compile timeouts, unlinked | 0 | 0 | 0 |
| compile timeouts, linked | **2** | **3** | **3** |

8 of 360 rows (2.2 %) convert from an honest failure into a timeout. Across the
full ~4,600-row Temporal bucket that is the per-row timeout storm the pre-warm
doctrine exists to prevent, on a lane whose baseline was never measured linked.

## Implementation Plan (sketch)

The target that flips the artifact default-on is **≤1.3× linked-vs-unlinked**,
i.e. roughly another 2× off the provider's contribution. Ordered by expected
yield, each step measured before the next:

1. **Attribute the 214 functions.** They are not the polyfill's own bodies (the
   provider is a separate module); they are the boundary terminals plus whatever
   the consumer mints to talk to them. Count them by name prefix on the 10.6 KB
   row's WAT and say which mechanism owns each group before changing anything —
   S2o's premise failed precisely because the slice started from an assumed
   cause.
2. **Ask whether the terminals must be per-consumer.** If the same terminal set
   is minted for every consumer module, it belongs in the provider (emitted
   once) with the consumer importing it — the same "one copy, called" move that
   S2p made for the `globalThis` seed, at a different scale.
3. **Ask whether the WAT doubling is terminals at all.** 851 k → 1.85 M lines
   against +214 functions means the growth is per-BODY, not per-function. Find
   which bodies grow and why (S2o's method: compare the WAT line count of the
   same function name on both routes).
4. **Do not widen the #3418 dead-binding elision** as a shortcut. S2p recorded
   that the elision was *hiding* a per-site cost; a fix that depends on which
   entry point erased the evidence is not a fix.

**Acceptance:** linked-vs-unlinked ≤1.3× on both the 10.6 KB and 60 KB rows;
0 compile timeouts on the S5 three-family sample; byte A/B unchanged for
`--target gc` and for standalone modules that link nothing. Then, and only
then, flip `standalone_temporal` on by default in `test262-sharded.yml` and
re-measure the whole Temporal bucket.

## Slice: per-site dynamic-`new` cost (2026-09-24, ttraenkler/temporal-new-size)

The dominant linked cost was not the link: it was two **per-site** code copies
that the provider link merely switched on.

1. **The dynamic TypedArray construct was inlined at every dynamic `new`.** A
   standalone `new X(…)` whose target is known only at runtime ends in
   `emitDynamicNewFallback`'s no-match base (and the #4626 native-construct
   arm), which inlined `emitTaDynCtorConstructFromLocals` — every
   argument-shape arm, the iterator prelude, the per-kind encode loops, ~40 KB
   — once the module carried typed-array machinery (the linked provider always
   does). `new Temporal.PlainDate(…)` cost 39.7 KB per site.
   **Fix:** the construct is emitted once per clamped arity (it reads at most
   three arguments and only branches on how many) as
   `__ta_dyn_ctor_construct_a<k>(desc: anyref, arg0..k-1: externref) ->
   externref`, built lazily in a synthetic function context on first use; each
   site passes its locals to a `call`. The helper body is the same instruction
   sequence the site used to inline, over the same locals (the construct only
   reads them), so the outcome and the abrupt-completion order are unchanged.
   A site whose locals are not `anyref`/`externref` keeps the inline form.
2. **Host-callback arrows were compiled twice per init pass in standalone.**
   `assert.throws(E, () => …)` routes the arrow through
   `compileArrowAsCallback`, which compiled the whole body into an exported
   `__cb_<id>` bridge function and only THEN found there is no
   `__make_callback` bridge host-free and fell back to `compileArrowAsClosure`
   (#3235) — a second full compile, while the dead `__cb_<id>` stayed exported
   (so nothing could drop it). **Fix:** the same condition is checked before
   the body compile. With the module-init pass-1/pass-2 recompile (#3523 R4
   gap-1b: a population with calls AND closures keeps both passes) this was 4
   copies of every such arrow; it is now 2.

Measured on this tree, `.tmp/s76/variants2.mts`, one process, `nice`, fresh
provider cache per side, file-copy A/B of `closures.ts` + `dataview-native.ts`:

| row | lane | base | this slice |
| --- | --- | --- | --- |
| `PlainDate/limits.js` | unlinked | 6007 ms / 1,369,379 B | 5505 ms / 1,364,339 B |
| | linked | 16120 ms / 7,811,744 B | **8276 ms / 2,272,936 B** |
| `Duration/negative-infinity-throws-rangeerror.js` | unlinked | 5876 ms / 1,472,107 B | 5804 ms / 1,462,368 B |
| | linked | 13431 ms / 5,325,422 B | **8593 ms / 2,297,854 B** |
| `ZonedDateTime/prototype/timeZoneId/basic.js` | unlinked | 1524 ms / 362,232 B | 1207 ms / 362,232 B |
| | linked | 2519 ms / 920,687 B | 2707 ms / 920,687 B |
| provider artifact | — | 3,469,450 B | 3,159,197 B |

Per site (`.tmp/s76/arrow.mts`, harness `assert.js`+`sta.js`+
`temporalHelpers.js`, any-typed ctor): `new T.PD(…)` 39.7 → 0.7 KB,
`assert.throws(RangeError, () => new T.PD(…))` 139.4 → 1.4 KB.

Linked/unlinked is now ~1.5× on the two heavy rows (was 2.3–2.7×); the
remaining gap is not closed by this slice, so the acceptance bar above
(≤1.3×) is still open. Not done here, on purpose: pass 1's closures are still
emitted (dead) next to pass 2's — removing them is the #3523 two-pass design
question, not a size patch.

Validation run for this slice: `tests/issue-5407-shared-ta-dyn-ctor-construct.test.ts`
(fails 2/4 on base — the two shape assertions — and 4/4 green here; the
behaviour assertions pass on both); the 38 typed-array / DataView /
ArrayBuffer / #6607 test files (same 23 pre-existing failures on base and
here, identical list); equivalence gate (22 failing = the 22 known). **Not
yet run (wrap-up cut it short):** the standalone test262 slice
`built-ins/TypedArray{,Constructors}` (2,184 rows, list in `.tmp/ta-slice.txt`)
against `test262-standalone-current.jsonl`, and ~50 linked Temporal rows
incl. `.tmp/s74b/target8-rel.txt`. Next steps: run both, then re-measure the
S5 three-family sample to see whether the 8 linked timeouts are gone.

## Notes

- Predecessors inside #5383: S2o (the `typeof globalThis` struct — 2,766 → 929
  functions), S2p (the outlined `globalThis` seed — the multi-source penalty,
  −43 %), S3 (the opt-in decision and the fail-soft stamp gate).
- Artifacts: `.tmp/s2p-cost.mts`, `.tmp/{pd,du,zdt}-{base,link}.tsv`.
- This issue is the *only* remaining blocker to the artifact being default-on;
  correctness blockers are tracked separately (#5406, #5408).
